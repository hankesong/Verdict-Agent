import { z } from 'zod';
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, toHex } from 'viem';
import { WalletAddressSchema, WalletQuantitySchema, WalletHashSchema, type WalletReview, type PreparedWalletTransaction } from '@verdict/protocol';
import type { ServerConfig } from './config.js';
import type { WalletRpc } from './wallet-observation.js';

export class WalletCheckFailure extends Error {
  constructor(readonly reason: string, readonly uncertain = false) { super(reason); }
}
export type WalletNetwork = NonNullable<ServerConfig['wallet']>['networks'][number];
const bytes = z.string().regex(/^0x(?:[0-9a-f]{2})*$/);
const word = z.string().regex(/^0x[0-9a-f]{64}$/);
const zero = '0x' + '0'.repeat(64);
const uint = (value: unknown) => BigInt(word.parse(value));
const storageSlot = (name: string) => toHex(BigInt(keccak256(toHex(name))) - 1n, {size: 32});
export const proxySlots = ['eip1967.proxy.implementation', 'eip1967.proxy.admin', 'eip1967.proxy.beacon'].map(storageSlot);

export function contractPolicy(r: Pick<WalletReview,'transaction'|'intent'>, n: WalletNetwork) {
  const i = r.intent, t = r.transaction;
  if (i.operation !== 'contract_call') throw new WalletCheckFailure('CONTRACT_INTENT_REQUIRED');
  if (BigInt(t.value) !== 0n) throw new WalletCheckFailure('TOKEN_CALL_WITH_NATIVE_VALUE');
  if (t.data.slice(0, 10) !== i.functionSelector) throw new WalletCheckFailure('INTENT_CALL_MISMATCH');
  const a = i.contractAction;
  const functionName = a.kind === 'erc20_transfer' ? 'transfer' : 'approve';
  const target = a.kind === 'erc20_transfer' ? a.recipient : a.spender;
  if (target === '0x' + '0'.repeat(40)) throw new WalletCheckFailure('ZERO_RECIPIENT');
  try {
    const decoded = decodeFunctionData({abi: erc20Abi, data: t.data as `0x${string}`});
    const encoded = encodeFunctionData({abi: erc20Abi, functionName, args: [target as `0x${string}`, BigInt(a.amount)]});
    // Exact re-encoding rejects trailing bytes and non-canonical ABI words as well as changed intent.
    if (decoded.functionName !== functionName || t.data !== encoded) throw new Error();
  } catch { throw new WalletCheckFailure('INTENT_CALL_MISMATCH'); }
  const token = n.tokens.find(token => token.address === t.to);
  if (!token) throw new WalletCheckFailure('TOKEN_NOT_CONFIGURED', true);
  if (a.kind === 'erc20_transfer') {
    if (BigInt(a.amount) > BigInt(token.maxTransferAmount)) throw new WalletCheckFailure('TOKEN_TRANSFER_LIMIT');
    if (a.recipient === t.from) throw new WalletCheckFailure('TOKEN_SELF_TRANSFER_NOT_SUPPORTED', true);
  } else {
    if (BigInt(a.amount) === 2n ** 256n - 1n) throw new WalletCheckFailure('UNLIMITED_APPROVAL', true);
    if (BigInt(a.amount) > BigInt(token.maxApprovalAmount)) throw new WalletCheckFailure('TOKEN_APPROVAL_LIMIT');
    if (!token.approvedSpenders.includes(a.spender)) throw new WalletCheckFailure('SPENDER_NOT_CONFIGURED', true);
  }
  return token;
}

export async function inspectContract(r: Pick<WalletReview,'transaction'|'intent'>, n: WalletNetwork, ask: WalletRpc, block: string, code: unknown) {
  const token = contractPolicy(r, n);
  const runtime = bytes.parse(code);
  if (runtime === '0x') throw new WalletCheckFailure('TARGET_NOT_CONTRACT', true);
  if (keccak256(runtime as `0x${string}`) !== token.codeHash) throw new WalletCheckFailure('TOKEN_CODE_CHANGED', true);
  const slots = await Promise.all(proxySlots.map(slot => ask('eth_getStorageAt', [r.transaction.to, slot, block])));
  if (slots.some(value => word.parse(value) !== zero) || /^0x363d3d373d3d3d363d73/.test(runtime)) {
    throw new WalletCheckFailure('PROXY_OR_UPGRADE_AUTHORITY_NOT_SUPPORTED', true);
  }
  return {codeHash: token.codeHash, proxySlots: 'EMPTY', coverage: 'Configured code hash; EIP-1967 slots and EIP-1167 prefix only. Not proof of absence of all proxy patterns.'};
}

const traceSchema: z.ZodType<{type: string; from: string; to?: string; value?: string; error?: string; calls?: unknown[]}> = z.object({
  type: z.string(), from: WalletAddressSchema, to: WalletAddressSchema.optional(), value: WalletQuantitySchema.optional(),
  error: z.string().optional(), calls: z.array(z.unknown()).max(64).optional(),
});
const callResult = z.object({
  status: z.enum(['0x0', '0x1']), returnData: bytes, gasUsed: WalletQuantitySchema,
  error: z.unknown().optional(),
  logs: z.array(z.object({address: WalletAddressSchema, topics: z.array(WalletHashSchema).max(4), data: bytes})).max(32),
});

// Sequential calls run against ephemeral state. No eth_send* method, private key or user-supplied RPC target.
export async function simulateContract(r: WalletReview, prepared: PreparedWalletTransaction, ask: WalletRpc, block: string) {
  if (r.intent.operation !== 'contract_call') throw new WalletCheckFailure('CONTRACT_INTENT_REQUIRED');
  const a = r.intent.contractAction, t = r.transaction;
  const target = a.kind === 'erc20_transfer' ? a.recipient : a.spender;
  const balanceOf = (owner: string) => encodeFunctionData({abi: erc20Abi, functionName: 'balanceOf', args: [owner as `0x${string}`]});
  const allowance = encodeFunctionData({abi: erc20Abi, functionName: 'allowance', args: [t.from as `0x${string}`, target as `0x${string}`]});
  const read = (data: string) => ({from: t.from, to: t.to, data, gas: '0x186a0', value: '0x0'});
  const probes = a.kind === 'erc20_transfer' ? [read(balanceOf(t.from)), read(balanceOf(target))] : [read(allowance)];
  const before = await Promise.all(probes.map(call => ask('eth_call', [call, block])));
  before.forEach(uint);
  if (a.kind === 'erc20_transfer' && uint(before[0]) < BigInt(a.amount)) throw new WalletCheckFailure('TOKEN_BALANCE_INSUFFICIENT');
  if (a.kind === 'erc20_approve' && uint(before[0]) !== 0n && BigInt(a.amount) !== 0n) throw new WalletCheckFailure('APPROVAL_RESET_REQUIRED', true);
  const {chainId: _chainId, ...call} = prepared;
  // Trace the exact call to reject delegation, creation, self-destruct and unexamined side calls.
  const trace = traceSchema.parse(await ask('debug_traceCall', [call, block, {tracer: 'callTracer', timeout: '3s'}]));
  if (trace.type !== 'CALL' || trace.from !== t.from || trace.to !== t.to || trace.error || (trace.calls?.length ?? 0) !== 0 || BigInt(trace.value ?? '0x0') !== 0n) {
    throw new WalletCheckFailure('UNEXAMINED_INTERNAL_CALL', true);
  }
  // Probe calls must not consume the sender nonce or fees used by the actual simulation call.
  // The independent before reads above do not mutate the ephemeral simulation.
  const result = z.array(z.object({calls: z.array(callResult)})).length(1).parse(await ask('eth_simulateV1', [{
    blockStateCalls: [{calls: [call, ...probes]}], validation: false, traceTransfers: true,
  }, block]));
  const calls = result[0].calls;
  if (calls.length !== probes.length + 1 || calls.some(c => c.status !== '0x1' || c.error !== undefined)) throw new WalletCheckFailure('CONTRACT_SIMULATION_FAILED', true);
  if (calls[0].returnData !== '0x' + '0'.repeat(63) + '1') throw new WalletCheckFailure('TOKEN_RETURN_NOT_TRUE', true);
  if (BigInt(calls[0].gasUsed) > BigInt(prepared.gas)) throw new WalletCheckFailure('SIMULATION_GAS_MISMATCH', true);
  // Extra or foreign events (including native value movement) are not silently accepted.
  const event = keccak256(toHex(a.kind === 'erc20_transfer' ? 'Transfer(address,address,uint256)' : 'Approval(address,address,uint256)'));
  const addressTopic = (address: string) => '0x' + '0'.repeat(24) + address.slice(2);
  const logs = calls[0].logs;
  if (logs.length !== 1 || logs[0].address !== t.to || logs[0].topics.join(',') !== [event, addressTopic(t.from), addressTopic(target)].join(',') || uint(logs[0].data) !== BigInt(a.amount) || calls.slice(1).some(c => c.logs.length)) {
    throw new WalletCheckFailure('UNEXPECTED_TOKEN_EFFECT', true);
  }
  const after = calls.slice(1).map(c => uint(c.returnData));
  if (a.kind === 'erc20_transfer') {
    if (uint(before[0]) - after[0] !== BigInt(a.amount) || after[1] - uint(before[1]) !== BigInt(a.amount)) throw new WalletCheckFailure('TOKEN_DELTA_MISMATCH', true);
  } else if (after[0] !== BigInt(a.amount)) throw new WalletCheckFailure('ALLOWANCE_MISMATCH', true);
  return {
    method: 'eth_simulateV1 + debug_traceCall', operation: a.kind, target, amount: a.amount,
    before: before.map(v => uint(v).toString()).join(','), after: after.map(String).join(','),
    coverage: a.kind === 'erc20_transfer' ? 'Exact sender/recipient token balance delta and one Transfer event; no internal calls. Other storage and future execution are not guaranteed.' : 'Exact owner/spender allowance and one Approval event; no internal calls. Future spender behavior is not audited.',
  };
}
