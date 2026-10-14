import {
  createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http,
  keccak256, type Address, type Hash, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

export const EVIDENCE_ANCHOR_ABI = [
  { type: 'function', name: 'anchor', stateMutability: 'nonpayable', inputs: [
    { name: 'evidenceHash', type: 'bytes32' }, { name: 'formatVersion', type: 'string' },
  ], outputs: [] },
  { type: 'event', name: 'EvidenceAnchored', anonymous: false, inputs: [
    { name: 'publisher', type: 'address', indexed: true },
    { name: 'evidenceHash', type: 'bytes32', indexed: true },
    { name: 'formatVersion', type: 'string', indexed: false },
  ] },
] as const;

export const AnchorTargetSchema = z.strictObject({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), rpcUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
  }), contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/), confirmations: z.number().int().min(1).max(1000).default(1),
  maxGasLimit: z.bigint().positive(), maxFeePerGasWei: z.bigint().positive(), maxTotalFeeWei: z.bigint().positive(),
});
export type AnchorTarget = z.input<typeof AnchorTargetSchema>;
export const EvidenceAnchorFormat = 'verdict-evidence-manifest-v1';

export function anchorCalldata(evidenceHash: Hash, formatVersion = EvidenceAnchorFormat): Hex {
  return encodeFunctionData({ abi: EVIDENCE_ANCHOR_ABI, functionName: 'anchor', args: [evidenceHash, formatVersion] });
}

/** Validate an actual receipt's network, destination, success status and matching contract event. */
export async function verifyAnchorReceipt(input: {
  target: AnchorTarget; txHash: Hash; evidenceHash: Hash; publisher?: Address;
}) {
  const target = AnchorTargetSchema.parse(input.target);
  const client = createPublicClient({ transport: http(target.rpcUrl, { timeout: 10_000 }) });
  const [chainId, receipt] = await Promise.all([
    client.getChainId(), client.getTransactionReceipt({ hash: input.txHash }),
  ]);
  if (chainId !== target.chainId) throw new Error('ANCHOR_CHAIN_MISMATCH');
  if (receipt.status !== 'success') throw new Error('ANCHOR_TRANSACTION_FAILED');
  if (receipt.to?.toLowerCase() !== target.contractAddress.toLowerCase()) throw new Error('ANCHOR_CONTRACT_MISMATCH');
  const account = privateKeyToAccount(target.privateKey as Hex);
  if (receipt.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('ANCHOR_PUBLISHER_MISMATCH');
  if (input.publisher && account.address.toLowerCase() !== input.publisher.toLowerCase()) throw new Error('ANCHOR_PUBLISHER_MISMATCH');
  const matching = receipt.logs.some(log => {
    if (log.address.toLowerCase() !== target.contractAddress.toLowerCase()) return false;
    try {
      const decoded = decodeEventLog({ abi: EVIDENCE_ANCHOR_ABI, eventName: 'EvidenceAnchored', topics: log.topics, data: log.data });
      return decoded.args.publisher.toLowerCase() === account.address.toLowerCase()
        && decoded.args.evidenceHash.toLowerCase() === input.evidenceHash.toLowerCase()
        && decoded.args.formatVersion === EvidenceAnchorFormat;
    } catch { return false; }
  });
  if (!matching) throw new Error('ANCHOR_EVENT_MISMATCH');
  const block = await client.getBlock({ blockHash: receipt.blockHash });
  const head = await client.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber + 1n);
  if (confirmations < target.confirmations) throw new Error('ANCHOR_CONFIRMATIONS_PENDING');
  return { chainId, publisher: account.address, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, confirmations, blockTimestamp: Number(block.timestamp) };
}

/** Sign locally; callers must durably store rawTransaction before broadcasting it. */
export async function signAnchorTransaction(input: { target: AnchorTarget; evidenceHash: Hash }) {
  const target = AnchorTargetSchema.parse(input.target);
  const account = privateKeyToAccount(target.privateKey as Hex);
  const publicClient = createPublicClient({ transport: http(target.rpcUrl, { timeout: 10_000 }) });
  const chainId = await publicClient.getChainId();
  if (chainId !== target.chainId) throw new Error('ANCHOR_CHAIN_MISMATCH');
  const client = createWalletClient({ account, transport: http(target.rpcUrl, { timeout: 10_000 }) });
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const gas = await publicClient.estimateGas({ account: account.address, to: target.contractAddress as Address, data: anchorCalldata(input.evidenceHash) });
  if (gas > target.maxGasLimit) throw new Error('ANCHOR_GAS_LIMIT_EXCEEDED');
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? await publicClient.getGasPrice();
  if ((fees.maxPriorityFeePerGas ?? 0n) > maxFeePerGas || maxFeePerGas > target.maxFeePerGasWei || gas * maxFeePerGas > target.maxTotalFeeWei) throw new Error('ANCHOR_FEE_LIMIT_EXCEEDED');
  const balance = await publicClient.getBalance({ address: account.address, blockTag: 'pending' });
  if (balance < gas * maxFeePerGas) throw new Error('ANCHOR_INSUFFICIENT_BALANCE');
  const rawTransaction = await client.signTransaction({
    account, chain: null, chainId: target.chainId, to: target.contractAddress as Address, data: anchorCalldata(input.evidenceHash), nonce, gas,
    ...(fees.maxFeePerGas && fees.maxPriorityFeePerGas
      ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
      : { gasPrice: maxFeePerGas }),
  });
  return { rawTransaction, txHash: keccak256(rawTransaction), publisher: account.address };
}

export async function broadcastExactTransaction(targetInput: AnchorTarget, rawTransaction: Hex): Promise<Hash> {
  const target = AnchorTargetSchema.parse(targetInput);
  const account = privateKeyToAccount(target.privateKey as Hex);
  const client = createWalletClient({ account, transport: http(target.rpcUrl, { timeout: 10_000 }) });
  return client.sendRawTransaction({ serializedTransaction: rawTransaction });
}
