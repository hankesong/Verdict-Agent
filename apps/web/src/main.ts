import "./style.css";
import { primary, secondary, port } from "./api";
import { escape as e } from "./view";
import { mountDrawer, type Drawer } from "./drawer";
import { connect, onConnection, state, reducedMotion, type Station } from "./state";

type StationDef = {
  id: string;
  no: string;
  name: string;
  code: string;
  title: string;
  intro: string;
  load: () => Promise<{ mount(root: HTMLElement, drawer: Drawer): Station }>;
};
const STATIONS: StationDef[] = [
  { id: "register", no: "01", name: "任务登记", code: "Station 01 · Task spec", title: "先写清要求，再派送。", intro: "账户、区块、字段、证据策略与预算在提交时固定；同一 requestId 只登记一次。", load: () => import("./stations/register") },
  { id: "track", no: "02", name: "交付追踪", code: "Station 02 · Delivery tracking", title: "每一次交付，都留下轨迹。", intro: "按真实运行快照回放：派送、verify_delivery 核验、拒收替换、原子采用、证据封存与第二实例复验。", load: () => import("./stations/track") },
  { id: "evidence", no: "03", name: "证据封存", code: "Station 03 · Evidence manifest", title: "摘要即标识，字节不可改。", intro: "JCS 规范化后取 Keccak-256 作为 evidenceHash；每项检查都能指回原始证据中的字段。", load: () => import("./stations/evidence") },
  { id: "replay", no: "04", name: "独立复验", code: "Station 04 · Independent replay", title: "结论可以分享，证据需要重算。", intro: "第二实例用自己的数据库与信任配置重算；篡改过的副本在导入时就被拒绝。", load: () => import("./stations/replay") },
  { id: "services", no: "05", name: "候选与观测", code: "Station 05 · Candidates & observations", title: "排序只决定先验谁。", intro: "声明能力、实测观测与排序理由分开展示；RPC 观测只记录可用性，不判定数据正确性。", load: () => import("./stations/services") },
  { id: "agent", no: "06", name: "Agent 执行", code: "Station 06 · PI agent", title: "模型提议，规则裁决。", intro: "PI 接收自然语言任务并调用业务工具；绑定后的条件不可变，验收结论只来自确定性核验。", load: () => import("./stations/agent") },
  { id: "activity", no: "07", name: "动作轨迹", code: "Station 07 · Action graph", title: "每一步，都看得见。", intro: "动作提议、外审、实际执行与验收沿同一条轨迹展开；节点只投影已记录的事件，不推测因果。", load: () => import("./stations/activity") },
  { id: "guard", no: "08", name: "外审与报告", code: "Station 08 · Guard & reports", title: "每一次放行与拦截，都有原因。", intro: "硬规则拦截与外审模型拦截分开标注；签名安全报告导入时重新验签并独立复验。", load: () => import("./stations/guard") },
  { id: "wallet", no: "09", name: "钱包审查", code: "Station 09 · Pre-signing review", title: "签名前，先看清交易。", intro: "确定性边界检查与 RPC 预执行在前，独立审查在后；服务器不持私钥、不广播交易。", load: () => import("./stations/wallet") },
];
const parcel = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z" class="pc-box"/><path d="M3 6.5 10 10l7-3.5M10 10v7" class="pc-tape"/></svg>`;

document.querySelector("#app")!.innerHTML = `<header class="topbar">
<a class="brand" href="#track"><img src="/verdict.svg" alt="" width="28" height="28"><span class="brand-name">Verdict</span><span class="brand-sub">Agent 服务验收与证据审计</span></a>
<div class="instances"><span class="inst" id="inst-primary"><i class="dot"></i><span class="inst-text">连接中…</span></span><span class="inst" id="inst-secondary"><i class="dot"></i><span class="inst-text">连接中…</span></span><span class="ctx" id="ctx-chip"></span></div>
<div class="top-actions"><button type="button" class="btn-quiet" id="reconnect" aria-label="重新连接后端">↻ 重新连接</button><button type="button" class="btn-quiet" id="drawer-toggle" aria-label="工程抽屉">工程抽屉 <kbd>\`</kbd></button></div>
</header>
<nav class="rail" aria-label="站点路线"><div class="rail-track" id="rail-track"><ol>${STATIONS.map((s) => `<li><button type="button" data-station="${s.id}" aria-label="${e(s.name)}"><span class="rail-dot"></span><span class="rail-no">${s.no}</span><span class="rail-name">${e(s.name)}</span></button></li>`).join("")}</ol><span class="rail-parcel" id="rail-parcel">${parcel}</span></div></nav>
<div class="legend"><span class="legend-label">来源</span><span class="badge green">实时观测<span class="code">LIVE</span></span><span class="badge neutral">冻结样本<span class="code">FROZEN</span></span><span class="badge amber">故障注入<span class="code">FAULT_INJECTION</span></span><span class="badge neutral">测试传输<span class="code">TEST_TRANSPORT</span></span><span class="legend-note">verdict、归属、文件完整性、运行状态与发布状态分开展示</span></div>
<div class="body"><main class="stage"><div id="notice" class="notice" role="alert" hidden></div><header class="station-head" id="station-head"><span class="eyebrow" id="station-code"></span><h1 id="station-title"></h1><p id="station-intro"></p></header>${STATIONS.map((s) => `<section id="station-${s.id}" class="station" hidden></section>`).join("")}</main>
<aside class="drawer" id="drawer" aria-label="工程抽屉"></aside></div>
<footer class="foot"><span>Verdict · 证据先于结论</span><span>链上存证未接入，发布状态如实显示 not_requested</span></footer>`;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const drawer = mountDrawer($("#drawer"));
const mounted = new Map<string, Promise<Station>>();
let activeStation = "";

function notice(text = "") {
  $("#notice").hidden = !text;
  $("#notice").textContent = text;
}
function renderConnection() {
  const chip = (id: string, base: string, meta: typeof state.meta, error: string | null, role: string) => {
    const el = $(id);
    el.dataset.state = meta ? "up" : error ? "down" : "wait";
    el.querySelector(".inst-text")!.innerHTML = meta
      ? `<span class="inst-role">${role}</span><b>${e(meta.instanceId)}</b> 已连接 <span class="mono-muted">${e(port(base))}</span>`
      : `<span class="inst-role">${role}</span><b>${e(port(base))}</b> ${error ? "未连接" : "连接中…"}`;
  };
  chip("#inst-primary", primary, state.meta, state.primaryError, "主实例");
  chip("#inst-secondary", secondary, state.secondaryMeta, state.secondaryError, "复验实例");
  const c = state.meta?.contexts[0];
  $("#ctx-chip").textContent = c ? `${c.contextId} · ${c.ruleVersion} · schema 1.0.0` : "";
  notice(
    state.meta
      ? ""
      : `无法连接 ${primary}。请先在仓库运行 npm run dev:init 和 npm run dev:start，再点击右上角重新连接。${state.primaryError ?? ""}`,
  );
}
onConnection(renderConnection);

// The parcel on the route slides to the active station; it is navigation, not a status signal.
function moveParcel() {
  const button = document.querySelector<HTMLElement>(`[data-station="${activeStation}"]`);
  const dot = button?.querySelector<HTMLElement>(".rail-dot");
  if (!button || !dot) return;
  const track = $("#rail-track");
  const x = dot.getBoundingClientRect().left - track.getBoundingClientRect().left + track.scrollLeft + dot.offsetWidth / 2;
  $("#rail-parcel").style.transform = `translateX(${x - 11}px)`;
  if (reducedMotion()) return;
  button.scrollIntoView({ block: "nearest", inline: "nearest" });
}
async function show(route: string) {
  const [name, query = ""] = route.split("?");
  const def = STATIONS.find((s) => s.id === name) ?? STATIONS[1];
  if (def.id !== name) {
    location.hash = def.id;
    return;
  }
  activeStation = def.id;
  for (const b of document.querySelectorAll<HTMLElement>("[data-station]")) {
    const active = b.dataset.station === def.id;
    b.classList.toggle("active", active);
    b.setAttribute("aria-current", active ? "page" : "false");
  }
  moveParcel();
  for (const s of STATIONS) $(`#station-${s.id}`).hidden = s.id !== def.id;
  $("#station-code").textContent = def.code;
  $("#station-title").textContent = def.title;
  $("#station-intro").textContent = def.intro;
  document.title = `Verdict — ${def.name}`;
  let loading = mounted.get(def.id);
  if (!loading) {
    const root = $(`#station-${def.id}`);
    loading = def.load().then((m) => m.mount(root, drawer));
    mounted.set(def.id, loading);
    loading.catch(() => {
      mounted.delete(def.id);
      root.textContent = `${def.name}加载失败，请刷新重试。`;
    });
  }
  (await loading).route(new URLSearchParams(query));
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-station],[data-go],[data-pointer]");
  if (!target) return;
  if (target.dataset.station) location.hash = target.dataset.station;
  else if (target.dataset.go) location.hash = target.dataset.go;
  else if (target.dataset.pointer) void drawer.focusPointer(target.dataset.pointer, target.dataset.evidence);
});
document.addEventListener("keydown", (event) => {
  const el = event.target as HTMLElement;
  if (event.ctrlKey || event.metaKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)
    return;
  if (event.key === "`") drawer.toggle();
  const n = Number(event.key);
  if (n >= 1 && n <= STATIONS.length) location.hash = STATIONS[n - 1].id;
});
$("#drawer-toggle").addEventListener("click", () => drawer.toggle());
$("#reconnect").addEventListener("click", async () => {
  await connect();
  for (const p of mounted.values()) void p.then((s) => s.reconnect?.());
});
window.addEventListener("resize", moveParcel);
window.addEventListener("hashchange", () => void show(location.hash.slice(1)));
void show(location.hash.slice(1) || "track");
void connect();
