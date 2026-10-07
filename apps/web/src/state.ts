import { MetaSchema, primary, secondary, request, type Meta } from "./api";

export interface Station {
  route(params: URLSearchParams): void;
  reconnect?(): void;
}
export const state = {
  meta: null as Meta | null,
  secondaryMeta: null as Meta | null,
  primaryError: null as string | null,
  secondaryError: null as string | null,
  // Runs started from this page session; only these trigger an automatic second-instance replay.
  freshRuns: new Set<string>(),
  duplicates: new Map<string, boolean>(),
};
const listeners = new Set<() => void>();
export const onConnection = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export async function connect() {
  const [one, two] = await Promise.allSettled([
    request(primary, "/api/meta").then((x) => MetaSchema.parse(x)),
    request(secondary, "/api/meta").then((x) => MetaSchema.parse(x)),
  ]);
  state.meta = one.status === "fulfilled" ? one.value : null;
  state.primaryError =
    one.status === "rejected"
      ? one.reason instanceof Error
        ? one.reason.message
        : "连接失败"
      : null;
  state.secondaryMeta = two.status === "fulfilled" ? two.value : null;
  state.secondaryError =
    two.status === "rejected"
      ? two.reason instanceof Error
        ? two.reason.message
        : "连接失败"
      : null;
  for (const fn of listeners) fn();
}
export async function ensureMeta(): Promise<Meta> {
  if (!state.meta) await connect();
  if (!state.meta)
    throw new Error(
      `无法连接 ${primary}。请先启动后端（npm run dev:init、npm run dev:start），再点击重新连接。`,
    );
  return state.meta;
}
export function go(station: string, params?: Record<string, string>) {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  location.hash = station + query;
}
export const sleep = (ms: number) =>
  new Promise((r) =>
    setTimeout(r, reducedMotion() ? Math.min(ms, 40) : ms),
  );
export const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
