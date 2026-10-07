import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { walletHarness, body, account } from './wallet-graph-harness.js';
import { randomUUID } from 'node:crypto';
import { ModelSettingsSchema } from '@verdict/protocol';

const draft = (current: any, patch: any = {}) => ({
  baseURL: current.baseURL, modelId: current.modelId, compatibility: current.compatibility,
  requestTimeoutMs: current.requestTimeoutMs, outputTokens: current.outputTokens, ...patch,
});
async function settings(f: Awaited<ReturnType<typeof walletHarness>>) {
  return ModelSettingsSchema.parse((await f.rawApi('/api/settings/models')).data);
}

test('model profiles persist, keys stay private and the wallet uses the selected reviewer after restart', async () => {
  const f = await walletHarness();
  const secret = 'TEST_MODEL_SETTINGS_PRIVATE_KEY';
  try {
    const before = await settings(f);
    const profile = draft(before.guard, { modelId: 'settings-reviewer' });
    const response = await f.rawApi('/api/settings/models/guard', { revision: before.revision, profile, apiKey: secret });
    assert.equal(response.code, 200);
    assert.ok(!JSON.stringify(response.data).includes(secret));
    assert.equal(response.data.guard.hasApiKey, true);
    assert.equal(f.h.app.agents.info().guardModelId, 'settings-reviewer');
    assert.equal(f.h.app.wallet.info().configured, true);
    const file = resolve(f.h.config.dataDir, 'model-settings.json');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(readFileSync(file, 'utf8').includes(secret));
    const oldEnv = f.h.config.guard!.apiKeyEnv;
    await f.h.restart();
    assert.equal(process.env[oldEnv], undefined);
    assert.equal((await settings(f)).guard!.modelId, 'settings-reviewer');
    const session = (await f.rawApi('/api/wallet/sessions', {account, chainId:'0x3c8', providerId:'reconnected-test-wallet'})).data;
    const created = await f.rawApi('/api/wallet/reviews', {...body(), walletSessionId:session.sessionId, walletSessionRevision:session.revision});
    assert.equal(created.code, 202);
    const r = await f.settle(created.data.reviewId);
    assert.equal(r.status, 'ALLOWED');
    assert.equal(r.reviewer.modelId, 'settings-reviewer');
    assert.ok(!JSON.stringify(await f.graph(r.reviewId)).includes(secret));
    assert.ok(!JSON.stringify(f.h.app.engine.store.db.prepare('SELECT body FROM wallet_reviews').all()).includes(secret));
  } finally { await f.close(); }
});

test('settings reject stale writes, missing new-endpoint keys, unsafe URLs and disallowed origins', async () => {
  const f = await walletHarness();
  try {
    const s = await settings(f), profile = draft(s.agent);
    const tooLarge = await f.rawApi('/api/settings/models/guard', { revision: s.revision, profile: draft(s.guard, { outputTokens: 1025 }) });
    assert.equal(tooLarge.data.error, 'MODEL_REVIEWER_OUTPUT_LIMIT');
    assert.equal((await settings(f)).revision, s.revision);
    for (const baseURL of ['http://example.com/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=SECRET', 'https://example.com/v1#secret']) {
      const res = await f.rawApi('/api/settings/models/agent', { revision: s.revision, profile: { ...profile, baseURL }, apiKey: 'TEST_KEY' });
      assert.equal(res.code, 400);
    }
    const changed = await f.rawApi('/api/settings/models/agent', { revision: s.revision, profile: { ...profile, baseURL: 'https://example.com/v1' } });
    assert.equal(changed.data.error, 'MODEL_KEY_REQUIRED_FOR_NEW_ENDPOINT');
    assert.equal((await settings(f)).revision, s.revision);
    const rejected = await fetch(f.h.base + '/api/settings/models/agent', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: s.revision, profile }) });
    assert.equal(rejected.status, 403);
    const updated = await f.rawApi('/api/settings/models/agent', { revision: s.revision, profile: { ...profile, modelId: 'updated-actor' } });
    assert.equal(updated.code, 200);
    assert.equal((await f.rawApi('/api/settings/models/guard', { revision: s.revision, profile: draft(s.guard) })).data.error, 'MODEL_SETTINGS_CHANGED');
    assert.equal((await settings(f)).guard!.modelId, s.guard!.modelId);
  } finally { await f.close(); }
});

test('live reviews and unconsumed permits prevent model changes; cancelled reviews allow updates', async () => {
  const f = await walletHarness();
  try {
    const s = await settings(f), input = { revision: s.revision, profile: draft(s.guard, { modelId: 'replacement-reviewer' }) };
    const r = await f.create();
    assert.equal(r.status, 'ALLOWED');
    assert.equal((await f.rawApi('/api/settings/models/guard', input)).data.error, 'MODEL_SETTINGS_BUSY');
    await f.api(`/api/wallet/reviews/${r.reviewId}/cancel`, {});
    const result = await f.rawApi('/api/settings/models/guard', input);
    assert.equal(result.code, 200);
    const next = await f.create();
    assert.equal(next.reviewer.modelId, 'replacement-reviewer');
    await f.api(`/api/wallet/reviews/${next.reviewId}/cancel`, {});
    f.rpcState.delayMethod = 'eth_chainId'; f.rpcState.delayMs = 120;
    const pending = f.create();
    for(let i=0;i<100&&!f.h.app.wallet.modelSettingsBusy;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.h.app.wallet.modelSettingsBusy, true);
    const latest = await settings(f);
    assert.equal((await f.rawApi('/api/settings/models/agent', { revision: latest.revision, profile: draft(latest.agent) })).data.error, 'MODEL_SETTINGS_BUSY');
    await pending;
  } finally { await f.close(); }
});

test('failed persistence leaves the runtime model and revision unchanged; defense mode does not expose settings', async () => {
  const f = await walletHarness();
  try {
    const s = await settings(f), path = resolve(f.h.config.dataDir, 'model-settings.json');
    mkdirSync(path);
    const result = await f.rawApi('/api/settings/models/agent', { revision: s.revision, profile: draft(s.agent, { modelId: 'must-not-apply' }) });
    assert.equal(result.data.error, 'MODEL_SETTINGS_SAVE_FAILED');
    assert.equal((await settings(f)).revision, s.revision);
    assert.equal(f.h.app.agents.info().modelId, s.agent!.modelId);
    rmSync(path, { recursive: true });
    process.env.VERDICT_SETTINGS_TEST_OWNER = randomUUID();
    f.h.config.defense = { maxProposalsPerTask: 100, principals: [{ id: 'owner', tenantId: 'settings-test', role: 'OWNER', accounts: [], tokenEnv: 'VERDICT_SETTINGS_TEST_OWNER', disabled: false }] };
    await f.h.restart();
    assert.equal((await f.rawApi('/api/settings/models')).code, 403);
  } finally { delete process.env.VERDICT_SETTINGS_TEST_OWNER; await f.close(); }
});
