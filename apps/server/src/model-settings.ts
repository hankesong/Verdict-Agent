import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ModelSettingsSchema, ModelProfileSchema, UpdateModelSettingsSchema, ModelAPIKeySchema, type ModelRole } from '@verdict/protocol';
import { AgentConfigSchema, type ServerConfig } from './config.js';
import { ApiError } from './store.js';

const StoredProfile = z.strictObject({ config: AgentConfigSchema, apiKey: ModelAPIKeySchema });
const StoredSettings = z.strictObject({
  version: z.literal(1), revision: z.string().uuid(),
  agent: StoredProfile.optional(), guard: StoredProfile.optional(),
});
type Stored = z.infer<typeof StoredSettings>;

// Private instance settings, never part of evidence, telemetry or public metadata.
export class ModelSettings {
  private readonly path: string;
  private readonly keyPrefix = 'VERDICT_MODEL_SETTINGS_' + randomUUID().replaceAll('-', '').toUpperCase();
  private state: Stored = { version: 1, revision: randomUUID() };

  constructor(private configs: ServerConfig[]) {
    this.path = resolve(configs[0].dataDir, 'model-settings.json');
    if (existsSync(this.path)) {
      try {
        this.state = StoredSettings.parse(JSON.parse(readFileSync(this.path, 'utf8')));
        chmodSync(this.path, 0o600);
        for (const role of ['agent', 'guard'] as const) if (this.state[role]) this.apply(role, this.state[role]!);
      } catch {
        this.close();
        throw new Error('MODEL_SETTINGS_FILE_INVALID');
      }
    }
  }

  private apply(role: ModelRole, saved: z.infer<typeof StoredProfile>) {
    const apiKeyEnv = this.keyPrefix + '_' + role.toUpperCase();
    process.env[apiKeyEnv] = saved.apiKey;
    for (const config of this.configs) config[role] = { ...saved.config, apiKeyEnv };
  }

  read() {
    const profile = (role: ModelRole) => {
      const current = this.configs[0][role];
      return current ? { ...ModelProfileSchema.parse({
        baseURL: current.baseURL, modelId: current.modelId, compatibility: current.compatibility,
        requestTimeoutMs: current.requestTimeoutMs, outputTokens: role === 'guard' ? Math.min(current.outputTokens, 1024) : current.outputTokens,
      }), hasApiKey: !!process.env[current.apiKeyEnv], source: current.source } : null;
    };
    return ModelSettingsSchema.parse({ schemaVersion: 'model-settings-v1', revision: this.state.revision, agent: profile('agent'), guard: profile('guard') });
  }

  update(role: ModelRole, raw: unknown, busy: boolean) {
    const input = UpdateModelSettingsSchema.parse(raw);
    if (input.revision !== this.state.revision) throw new ApiError(409, 'MODEL_SETTINGS_CHANGED');
    if (busy) throw new ApiError(409, 'MODEL_SETTINGS_BUSY');
    if (role === 'guard' && input.profile.outputTokens > 1024) throw new ApiError(400, 'MODEL_REVIEWER_OUTPUT_LIMIT');
    const current = this.configs[0][role];
    if (!input.apiKey && current && input.profile.baseURL !== current.baseURL) throw new ApiError(400, 'MODEL_KEY_REQUIRED_FOR_NEW_ENDPOINT');
    const apiKey = input.apiKey ?? (current && process.env[current.apiKeyEnv]);
    if (!apiKey) throw new ApiError(400, 'MODEL_API_KEY_REQUIRED');
    const config = AgentConfigSchema.parse({
      ...current, ...input.profile, apiKeyEnv: this.keyPrefix + '_' + role.toUpperCase(),
      source: current?.baseURL === input.profile.baseURL ? current.source : 'LIVE',
      pricePerMillion: current?.baseURL === input.profile.baseURL && current.modelId === input.profile.modelId ? current.pricePerMillion : undefined,
      firstEventTimeoutMs: Math.min(current?.firstEventTimeoutMs ?? 60000, input.profile.requestTimeoutMs),
      streamIdleTimeoutMs: Math.min(current?.streamIdleTimeoutMs ?? 15000, input.profile.requestTimeoutMs),
    });
    const saved = StoredProfile.parse({ config, apiKey });
    const next = StoredSettings.parse({ ...this.state, revision: randomUUID(), [role]: saved });
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(next) + '\n');
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.path);
    } catch {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* The failed write may not have created a file. */ }
      throw new ApiError(500, 'MODEL_SETTINGS_SAVE_FAILED');
    }
    this.state = next;
    this.apply(role, saved);
    return this.read();
  }

  close() {
    for (const role of ['AGENT', 'GUARD']) delete process.env[this.keyPrefix + '_' + role];
  }
}
