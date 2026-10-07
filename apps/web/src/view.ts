import type { CheckResult, VerificationResult } from "@verdict/protocol";

export type Tone = "ok" | "bad" | "warn" | "ne" | "acc";
export const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const short = (value: string) =>
  value.length > 25 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
export const clip = (value: string, n: number) =>
  value.length > n ? value.slice(0, n - 1) + "…" : value;
export const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const labels: Record<string, string> = {
  PASS: "通过",
  FAIL: "不通过",
  UNVERIFIABLE: "无法核实",
  VERIFIED: "已验证",
  UNSIGNED: "未签名",
  INVALID: "无效",
  UNRESOLVED: "未确定",
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCEEDED: "已采用",
  STOPPED: "已停止",
  ERROR: "异常",
  COMPLETED: "已完成",
  INTERRUPTED: "已中断",
  UNKNOWN: "未知",
  NOT_APPLICABLE: "不适用",
  NOT_COVERED: "未覆盖",
  MISMATCH: "不一致",
  UNAVAILABLE: "不可获取",
  NOT_CHECKED: "尚未检查",
  CONTEXT_DIFFERENT: "上下文不同",
  MATCH: "一致",
  NOT_COMPARABLE: "无法比较",
  FROZEN: "冻结样本",
  FAULT_INJECTION: "故障注入",
  LIVE: "实时观测",
  UI_MOCK: "界面样本",
  TEST_TRANSPORT: "测试传输",
  not_requested: "未请求发布",
  pending: "发布处理中",
  confirmed: "已确认发布",
  failed: "发布失败",
  SUPPORTED: "支持",
  UNSUPPORTED: "不支持",
  RATE_LIMITED: "限流",
  TIMEOUT: "超时",
  OK: "已响应",
  ALLOW: "放行",
  BLOCK: "拦截",
  UNCERTAIN: "无法判断",
};
export const label = (value: string) => labels[value] ?? value;
export function toneOf(value: string): Tone {
  if (
    ["PASS", "SUCCEEDED", "VERIFIED", "MATCH", "SUPPORTED", "OK", "ALLOW", "REPRODUCED"].includes(value)
  )
    return "ok";
  if (["FAIL", "ERROR", "MISMATCH", "INVALID", "failed", "BLOCK"].includes(value))
    return "bad";
  if (
    [
      "UNVERIFIABLE",
      "UNKNOWN",
      "UNRESOLVED",
      "TIMEOUT",
      "RATE_LIMITED",
      "FAULT_INJECTION",
      "STOPPED",
      "UNCERTAIN",
      "INTERRUPTED",
      "CONTEXT_DIFFERENT",
    ].includes(value)
  )
    return "warn";
  return "ne";
}
const toneClass: Record<Tone, string> = {
  ok: "green",
  bad: "red",
  warn: "amber",
  ne: "neutral",
  acc: "accent",
};
export function badge(value: string) {
  return `<span class="badge ${toneClass[toneOf(value)]}">${escape(label(value))}<span class="code">${escape(value)}</span></span>`;
}
export const pill = (text: string, tone: Tone = "ne") =>
  `<span class="badge ${toneClass[tone]}">${escape(text)}</span>`;
export const verdictTone = (v: string): Tone =>
  v === "PASS" ? "ok" : v === "FAIL" ? "bad" : "warn";

const checkNames: Record<string, string> = {
  schema: "输入格式",
  rule: "规则版本",
  network: "网络",
  policy: "验收策略",
  "request-binding": "请求绑定",
  "request-validity": "请求有效期",
  "delivery-validity": "交付有效期",
  "request-replay": "请求消费",
  delivery: "交付状态",
  signature: "服务签名",
  "delivery-chain": "交付网络",
  "response-chain": "响应网络",
  "delivery-block": "交付区块",
  "response-block": "响应区块",
  account: "账户地址",
  baseline: "可信基准",
  header: "区块头",
  "account-proof": "账户证明",
  "field-balance": "余额",
  "field-nonce": "交易计数",
  "field-codeHash": "代码摘要",
  "field-storageRoot": "存储根",
};
export const checkName = (id: string) => checkNames[id] ?? id;
const scopeNames: Record<string, string> = {
  admission: "准入 admission",
  attribution: "归属 attribution",
  data: "数据 data",
};
// evidenceRefs are JSON pointers into the evidence bundle; the drawer resolves them against the original bytes.
export function checks(rows: CheckResult[], evidenceId?: string | null) {
  const groups = ["admission", "attribution", "data"]
    .map((scope) => [scope, rows.filter((r) => r.scope === scope)] as const)
    .filter(([, list]) => list.length);
  return `<div class="checks">${groups
    .map(
      ([scope, list]) =>
        `<div class="check-group">${escape(scopeNames[scope])}</div>${list
          .map(
            (c) =>
              `<details class="check" data-status="${escape(c.status)}"><summary><span class="check-name">${escape(checkName(c.checkId))}</span><code>${escape(c.checkId)}</code>${badge(c.status)}</summary><dl><dt>要求</dt><dd>${escape(c.requirement)}</dd><dt>实际</dt><dd>${escape(c.actual)}</dd>${c.reasonCode ? `<dt>原因码</dt><dd><code>${escape(c.reasonCode)}</code></dd>` : ""}<dt>证据位置</dt><dd>${
                c.evidenceRefs.length
                  ? c.evidenceRefs
                      .map(
                        (ref) =>
                          `<button type="button" class="pointer" data-pointer="${escape(ref)}"${evidenceId ? ` data-evidence="${escape(evidenceId)}"` : ""}>${escape(ref)}</button>`,
                      )
                      .join("")
                  : "无材料引用"
              }</dd></dl></details>`,
          )
          .join("")}`,
    )
    .join("")}</div>`;
}
export function resultSummary(result: VerificationResult) {
  return `<div class="dims"><div><span>本次验收 verdict</span>${badge(result.verdict)}</div><div><span>数据 dataVerdict</span>${badge(result.dataVerdict)}</div><div><span>归属 attribution</span>${badge(result.attributionStatus)}</div></div>`;
}
export const empty = (title: string, description: string) =>
  `<div class="empty"><h3>${escape(title)}</h3><p>${escape(description)}</p></div>`;
export const working = (text: string) =>
  `<div class="working"><span class="spinner"></span>${escape(text)}</div>`;
// Draws the hash bytes as bars; it is a picture of the value the server returned, never a recomputation.
export function barcode(hash: string, tone: Tone = "ne") {
  const hex = hash.replace(/^0x/, "");
  return `<div class="barcode" data-tone="${tone}" aria-hidden="true">${[...hex]
    .map((c, i) => {
      const v = parseInt(c, 16) || 0;
      return `<span style="width:${1 + (v % 3)}px;margin-right:${1 + (v >> 3)}px;--i:${i}"></span>`;
    })
    .join("")}</div>`;
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";
