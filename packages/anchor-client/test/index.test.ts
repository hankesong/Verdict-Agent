import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorCalldata, AnchorTargetSchema, EvidenceAnchorFormat } from '../src/index.js';

test('encodes only the versioned EvidenceManifest digest', () => {
  const calldata = anchorCalldata(`0x${'11'.repeat(32)}`);
  assert.equal(calldata.slice(0, 10), '0x1a8512ea');
  assert.ok(calldata.includes(Buffer.from(EvidenceAnchorFormat).toString('hex')));
});

test('anchor targets reject credential-bearing, query and non-loopback HTTP RPC URLs', () => {
  const base = { chainId: 677, contractAddress: `0x${'11'.repeat(20)}`, privateKey: `0x${'22'.repeat(32)}`, maxGasLimit: 150000n, maxFeePerGasWei: 1000000000n, maxTotalFeeWei: 150000000000000n };
  for (const rpcUrl of ['https://user:pass@example.org', 'https://example.org/?key=secret', 'http://example.org', 'file:///tmp/rpc'])
    assert.equal(AnchorTargetSchema.safeParse({ ...base, rpcUrl }).success, false, rpcUrl);
  assert.equal(AnchorTargetSchema.safeParse({ ...base, rpcUrl: 'http://127.0.0.1:8545' }).success, true);
});
