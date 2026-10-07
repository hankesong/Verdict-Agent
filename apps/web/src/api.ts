import { z } from "zod";
import {
  API_VERSION,
  CapabilitiesSchema,
  CandidateSchema,
  EvidenceManifestSchema,
  ArtifactIntegritySchema,
  PublicationSchema,
  ReplaySnapshotSchema,
  VerificationContextSchema,
} from "@verdict/protocol";

export const primary = (
  import.meta.env.VITE_PRIMARY_API || "http://127.0.0.1:3001"
).replace(/\/$/, "");
export const secondary = (
  import.meta.env.VITE_SECONDARY_API || "http://127.0.0.1:3002"
).replace(/\/$/, "");
const Context = VerificationContextSchema.pick({
  contextId: true,
  ruleVersion: true,
  policy: true,
  trustedBlock: true,
});
export const MetaSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  instanceId: z.string(),
  contexts: z.array(Context).min(1),
  capabilities: z.array(CapabilitiesSchema.extend({ serviceId: z.string() })),
});
export type Meta = z.infer<typeof MetaSchema>;
export const CandidatesSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  candidates: z.array(CandidateSchema),
});
export const IndexSchema = z.object({
  evidence: z.array(
    z.object({
      evidenceId: z.string(),
      contextId: z.string(),
      createdAt: z.string(),
      publication: PublicationSchema,
    }),
  ),
});
export type EvidenceIndex = z.infer<typeof IndexSchema>["evidence"];
export const DetailSchema = z.object({
  evidenceId: z.string(),
  manifest: EvidenceManifestSchema,
  artifactIntegrity: ArtifactIntegritySchema,
  contextId: z.string(),
  publication: PublicationSchema,
});
export type EvidenceDetail = z.infer<typeof DetailSchema>;
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "",
  ) {
    super(message);
  }
}

// Read-only request log for the engineering drawer. It records what the page sent and received; it never alters calls.
export interface ApiLogEntry {
  id: number;
  at: number;
  method: string;
  base: string;
  path: string;
  status: number | null;
  ms: number | null;
  body?: unknown;
  response?: unknown;
  error?: string;
}
const listeners = new Set<(entry: ApiLogEntry) => void>();
let sequence = 0;
export const onApiLog = (fn: (entry: ApiLogEntry) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (entry: ApiLogEntry) => {
  for (const fn of listeners) fn(entry);
};
export async function request(
  base: string,
  path: string,
  body?: unknown,
  timeoutMs = 20000,
): Promise<unknown> {
  const entry: ApiLogEntry = {
    id: ++sequence,
    at: Date.now(),
    method: body === undefined ? "GET" : "POST",
    base,
    path,
    status: null,
    ms: null,
    body,
  };
  emit(entry);
  const started = performance.now();
  try {
    const res = await fetch(base + path, {
      method: entry.method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    entry.status = res.status;
    entry.ms = performance.now() - started;
    entry.response = data;
    emit(entry);
    if (!res.ok) {
      const code = typeof data.error === "string" ? data.error : "";
      throw new ApiError(
        res.status,
        `HTTP ${res.status} · ${code || "请求失败"}`,
        code,
      );
    }
    return data;
  } catch (error) {
    if (entry.status === null) {
      entry.ms = performance.now() - started;
      entry.error = error instanceof Error ? error.message : String(error);
      emit(entry);
    }
    throw error;
  }
}
export async function replay(
  base: string,
  evidenceId: string,
  contextId: string,
) {
  const { replayId } = z
    .object({ replayId: z.string() })
    .parse(await request(base, "/api/replays", { evidenceId, contextId }));
  for (let i = 0; i < 100; i++) {
    const result = ReplaySnapshotSchema.parse(
      await request(base, `/api/replays/${encodeURIComponent(replayId)}`),
    );
    if (result.status === "COMPLETED" || result.status === "ERROR")
      return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("复验仍在处理，请稍后重试查询。");
}
export type ReplaySnapshot = Awaited<ReturnType<typeof replay>>;
export async function download(
  base: string,
  id: string,
  kind: "bundle" | "manifest",
) {
  const res = await fetch(
    `${base}/api/evidence/${encodeURIComponent(id)}/${kind}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) throw new Error(`下载失败 · HTTP ${res.status}`);
  // Preserve original response bytes, never reconstruct evidence from the displayed report.
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}.${kind}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function saveJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const port = (base: string) => {
  try {
    return ":" + (new URL(base).port || "80");
  } catch {
    return base;
  }
};
