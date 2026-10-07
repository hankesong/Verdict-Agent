import { z } from 'zod';

export const ModelRoleSchema = z.enum(['agent', 'guard']);
export const ModelEndpointSchema = z.string().trim().url().max(2048).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
});
export const ModelProfileSchema = z.strictObject({
  baseURL: ModelEndpointSchema,
  modelId: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/),
  compatibility: z.enum(['openai', 'glm']),
  requestTimeoutMs: z.number().int().min(1).max(120000),
  outputTokens: z.number().int().min(64).max(8192),
});
export const ModelAPIKeySchema = z.string().trim().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/);
export const UpdateModelSettingsSchema = z.strictObject({
  revision: z.string().uuid(),
  profile: ModelProfileSchema,
  // Omission keeps the current key, only when the endpoint stays exactly the same.
  apiKey: ModelAPIKeySchema.optional(),
});
export const ModelSettingsProfileSchema = ModelProfileSchema.extend({
  hasApiKey: z.boolean(),
  source: z.enum(['LIVE', 'TEST_TRANSPORT']),
});
export const ModelSettingsSchema = z.strictObject({
  schemaVersion: z.literal('model-settings-v1'),
  revision: z.string().uuid(),
  agent: ModelSettingsProfileSchema.nullable(),
  guard: ModelSettingsProfileSchema.nullable(),
});
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type ModelSettingsProfile = z.infer<typeof ModelSettingsProfileSchema>;
