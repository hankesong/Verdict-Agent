import { z } from "zod";
import {
  AgentDraftSchema,
  CreateRunSchema,
  RunSnapshotSchema,
  EvidenceBundleSchema,
  type CreateRun,
  type RunSnapshot,
} from "@verdict/protocol";
import { ApiError, primary, secondary, request, replay, port, CandidatesSchema, DetailSchema, MetaSchema, type EvidenceDetail, type ReplaySnapshot } from "./api";
import { escape as e, short, badge, pill, checks, barcode, verdictTone, errorText, type Tone } from "./view";
import { state, ensureMeta, onConnection, sleep, type Station } from "./state";
import { createTrack, type Stop } from "./track";

const STOPS: Stop[] = [
  { id: "register", label: "登记", code: "POST /api/runs" },
  { id: "rank", label: "排序", code: "candidates" },
  { id: "deliver", label: "交付", code: "signed-http" },
  { id: "verify", label: "核验", code: "verify_delivery" },
  { id: "adopt", label: "采用", code: "accepted" },
  { id: "seal", label: "封存", code: "keccak256-jcs" },
  { id: "replay", label: "复验", code: port(secondary) },
];
interface Ev {
  time: string;
  title: string;
  tone: Tone;
  pill: string;
  mono: string;
  lines: string[];
  checks?: string;
}
interface Frame {
  key: string;
  move?: string;
  parcel?: Tone;
  stop?: [string, Tone | null, string?];
  chip?: [string, string];
  stamp?: [string, Tone, string];
  after?: Tone;
  status?: string;
  caption?: string;
  skip?: string[];
  fade?: boolean;
  ev?: Ev;
  result?: () => string;
  replayLine?: string;
}
const Created = z.object({ runId: z.string(), duplicate: z.boolean() });
const AgentMeta = z.object({ configured: z.boolean(), modelId: z.string().nullable(), modelSource: z.string().nullable() });
const relTo = (createdAt: string) => {
  const t0 = Date.parse(createdAt);
  return (iso: string | null) => (iso ? `T+${Math.max(0, (Date.parse(iso) - t0) / 1000).toFixed(2)}s` : "—");
};

export function mountReceive(root: HTMLElement): Station {
  root.innerHTML = `<div class="flow">
<div class="notice" data-rc-notice role="alert" hidden></div>
<section class="waybill" id="rc-compose" aria-labelledby="rc-title">
<header class="wb-head"><span class="eyebrow">Waybill · 收件</span><h1 id="rc-title">账户状态验收</h1><p class="lead">声明要核验的账户、区块与字段。交付不合格就换下一家，全部不合格就停止，不采用任何数据。</p></header>
<form class="wb-ask" id="rc-ask"><input id="rc-ask-input" aria-label="一句话填单" placeholder="一句话填单：例如“核验 0x… 在区块 0x… 的余额与 nonce”" disabled><button class="btn-quiet" type="submit" id="rc-ask-go" disabled>填单</button></form>
<div class="wb-note" id="rc-ask-note" hidden></div>
<form id="rc-form" novalidate><fieldset id="rc-fields" disabled>
<label class="wb-row"><span>account</span><input id="rc-account" class="mono" spellcheck="false" required pattern="0x[0-9a-f]{40}" placeholder="0x…"></label>
<label class="wb-row"><span>blockHash</span><input id="rc-block" class="mono" spellcheck="false" required pattern="0x[0-9a-f]{64}" placeholder="0x…"></label>
<div class="wb-row"><span>fields</span><div class="chips">${["balance", "nonce", "codeHash", "storageRoot"].map((f) => `<label class="chip"><input type="checkbox" name="rc-field" value="${f}" ${f === "storageRoot" ? "" : "checked"}>${f}</label>`).join("")}</div></div>
<details class="wb-more"><summary>contextId、candidateIds 与 budget</summary>
<label class="wb-row"><span>contextId</span><select id="rc-context"></select></label>
<div class="wb-row"><span>policy</span><code id="rc-policy">—</code></div>
<div class="wb-row"><span>candidateIds</span><div class="chips" id="rc-candidates"></div></div>
<label class="wb-row"><span>useHistorical&shy;Evidence</span><span class="switch"><input id="rc-history" type="checkbox" checked><small>适用的已复验反证只影响顺序，每份新交付仍须核验</small></span></label>
<div class="wb-row"><span>budget</span><div class="budget"><label>maxAttempts<input id="rc-attempts" type="number" min="1" max="100" value="3" required></label><label>timeoutMs<input id="rc-timeout" type="number" min="1" max="600000" value="15000" required></label><label>maxCostWei<input id="rc-cost" class="mono" inputmode="numeric" pattern="(0|[1-9][0-9]*)" value="0" required></label></div></div>
</details>
<div class="wb-actions"><button class="btn" type="submit" id="rc-submit">发起验收 →</button></div>
</fieldset><div class="wb-actions" id="rc-retry-row" hidden><button class="btn-secondary" type="button" id="rc-retry">重试同一请求</button><span class="hint">上次提交未收到响应；重试使用相同 requestId，不会重复登记。</span></div></form>
</section>
<section class="transit" id="rc-transit" hidden>
<div class="label-strip"><span class="eyebrow">Waybill</span><code id="rc-runid" title=""></code><span class="mono-muted" id="rc-scope"></span><span id="rc-status"></span><button class="btn-text" type="button" data-rc-new>重新填单</button></div>
<div class="card track-card"><div id="rc-track"></div><p class="track-caption" id="rc-caption" aria-live="polite"></p>
<div class="recover" id="rc-recover" hidden><button class="btn-secondary" type="button" data-rc-resume hidden>继续查询同一运行</button><button class="btn-secondary" type="button" data-rc-second hidden>在第二实例复验</button></div></div>
<div id="rc-result"></div>
<details class="events"><summary>全部事件 <span class="mono-muted" id="rc-count"></span></summary><ol class="tl" id="rc-tl"></ol></details>
</section></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const track = createTrack($("#rc-track"), STOPS);
  const key = "verdict-receive:" + primary;
  let gen = 0,
    busy = false,
    ready = false,
    playing = false,
    asking = false,
    current: string | null = null,
    interrupted: string | null = null,
    pendingReplay: { detail: EvidenceDetail; createdAt: string } | null = null,
    pending: CreateRun | null = null,
    agentMeta: z.infer<typeof AgentMeta> | null = null;
  let queue: Frame[] = [];
  const seen = new Set<string>();
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    pending = saved.pending ? CreateRunSchema.parse(saved.pending) : null;
  } catch {
    /* Invalid local UI state cannot become an API request. */
  }
  const persist = () => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ pending }));
    } catch {}
  };
  function notice(text = "") {
    $("[data-rc-notice]").hidden = !text;
    $("[data-rc-notice]").textContent = text;
  }
  function setBusy(v: boolean) {
    busy = v;
    $("#rc-fields").toggleAttribute("disabled", !ready || busy || !!pending);
    $("#rc-retry-row").hidden = !pending || busy;
    $("#rc-submit").textContent = v ? "正在登记…" : "发起验收 →";
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-rc-new],[data-rc-resume],[data-rc-second]")) b.disabled = v;
    const askable = ready && !!agentMeta?.configured && !busy && !asking;
    $<HTMLInputElement>("#rc-ask-input").disabled = !askable;
    $<HTMLButtonElement>("#rc-ask-go").disabled = !askable;
  }
  function recoverButtons() {
    $("[data-rc-resume]").hidden = !interrupted;
    $("[data-rc-second]").hidden = !pendingReplay;
    $("#rc-recover").hidden = !interrupted && !pendingReplay;
  }
  function showCompose() {
    gen++;
    current = null;
    interrupted = null;
    pendingReplay = null;
    $("#rc-compose").hidden = false;
    $("#rc-transit").hidden = true;
    notice();
    if (location.hash !== "#receive") history.replaceState(null, "", "#receive");
  }
  function input(): CreateRun {
    const form = $<HTMLFormElement>("#rc-form");
    if (!form.reportValidity()) throw new Error("请填写有效的验收条件。");
    const meta = state.meta!;
    const context = meta.contexts.find((c) => c.contextId === $<HTMLSelectElement>("#rc-context").value)!;
    const ids = [...root.querySelectorAll<HTMLInputElement>('[name="rc-candidate"]:checked')].map((c) => c.value);
    if (!ids.length) throw new Error("至少保留一个 candidateId。");
    const now = Math.floor(Date.now() / 1000);
    return CreateRunSchema.parse({
      contextId: context.contextId,
      candidateIds: ids,
      useHistoricalEvidence: $<HTMLInputElement>("#rc-history").checked,
      task: {
        schemaVersion: "1.0.0",
        requestId: crypto.randomUUID(),
        dataChainId: context.trustedBlock?.dataChainId ?? "1",
        account: $<HTMLInputElement>("#rc-account").value.trim(),
        blockHash: $<HTMLInputElement>("#rc-block").value.trim(),
        fields: [...root.querySelectorAll<HTMLInputElement>('[name="rc-field"]:checked')].map((f) => f.value),
        evidencePolicyId: context.policy.id,
        validity: { notBefore: String(now - 5), expiresAt: String(now + 900) },
        budget: {
          maxAttempts: Number($<HTMLInputElement>("#rc-attempts").value),
          timeoutMs: Number($<HTMLInputElement>("#rc-timeout").value),
          maxCostWei: $<HTMLInputElement>("#rc-cost").value.trim(),
        },
      },
    });
  }
  function applyContext() {
    const meta = state.meta!;
    const c = meta.contexts.find((x) => x.contextId === $<HTMLSelectElement>("#rc-context").value);
    $<HTMLInputElement>("#rc-block").value = c?.trustedBlock?.blockHash ?? "";
    $("#rc-policy").textContent = c ? `${c.policy.id} · requireSignature ${c.policy.requireSignature} · ${c.ruleVersion}` : "—";
    if (!$<HTMLInputElement>("#rc-account").value) $<HTMLInputElement>("#rc-account").value = meta.capabilities.flatMap((x) => x.accounts ?? [])[0] ?? "";
  }
  async function load() {
    try {
      const meta = await ensureMeta();
      $("#rc-context").innerHTML = meta.contexts.map((c) => `<option value="${e(c.contextId)}">${e(c.contextId)}</option>`).join("");
      applyContext();
      const services = CandidatesSchema.parse(await request(primary, "/api/services")).candidates.filter((c) => c.transport === "signed-http");
      $("#rc-candidates").innerHTML = services
        .map((c) => `<label class="chip"><input type="checkbox" name="rc-candidate" value="${e(c.serviceId)}" checked>${e(c.serviceId)}<small>${e(c.source)}</small></label>`)
        .join("");
      try {
        agentMeta = AgentMeta.parse(await request(primary, "/api/agent/meta"));
      } catch {
        agentMeta = null;
      }
      $<HTMLInputElement>("#rc-ask-input").placeholder = agentMeta?.configured
        ? "一句话填单：例如“核验 0x… 在区块 0x… 的余额与 nonce”"
        : "一句话填单未配置：需要服务端模型";
      ready = true;
      setBusy(false);
    } catch (error) {
      ready = false;
      setBusy(false);
      notice(errorText(error));
    }
  }
  // The model only fills the waybill; nothing is sent until the caller submits it.
  async function ask(prompt: string) {
    if (asking || !prompt) return;
    asking = true;
    setBusy(busy);
    const box = $("#rc-ask-note");
    box.hidden = false;
    box.className = "wb-note";
    box.textContent = "正在由模型理解并填单…";
    try {
      let draft = AgentDraftSchema.parse(await request(primary, "/api/agent/drafts", { clientRequestId: crypto.randomUUID(), prompt }));
      const deadline = Date.now() + 90000;
      while (draft.status === "GENERATING" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        draft = AgentDraftSchema.parse(await request(primary, `/api/agent/drafts/${encodeURIComponent(draft.draftId)}`));
      }
      const p = draft.proposal;
      if (!p) throw new Error(draft.error ? `模型未能填单：${draft.error}` : `模型未能填单（${draft.status}）`);
      const filled: string[] = [];
      const set = (sel: string, v: string | null) => {
        if (!v) return;
        $<HTMLInputElement>(sel).value = v;
        filled.push(sel);
      };
      if (p.contextId && state.meta?.contexts.some((c) => c.contextId === p.contextId)) {
        $<HTMLSelectElement>("#rc-context").value = p.contextId;
        applyContext();
      }
      set("#rc-account", p.account);
      set("#rc-block", p.blockHash);
      for (const c of root.querySelectorAll<HTMLInputElement>('[name="rc-field"]')) c.checked = p.fields.includes(c.value as never);
      for (const c of root.querySelectorAll<HTMLInputElement>('[name="rc-candidate"]')) c.checked = p.candidateIds.includes(c.value);
      $<HTMLInputElement>("#rc-history").checked = p.useHistoricalEvidence;
      $<HTMLInputElement>("#rc-attempts").value = String(p.budget.maxAttempts);
      $<HTMLInputElement>("#rc-timeout").value = String(p.budget.timeoutMs);
      $<HTMLInputElement>("#rc-cost").value = p.budget.maxCostWei;
      for (const sel of filled) {
        const el = $(sel);
        el.classList.remove("filled");
        void el.offsetWidth;
        el.classList.add("filled");
      }
      box.innerHTML = `<b>由 ${e(agentMeta?.modelId ?? "模型")}（${e(agentMeta?.modelSource ?? "—")}）填写，提交前请核对。</b>${p.missing.length ? `<span class="wb-missing">仍缺少：${p.missing.map(e).join("；")}</span>` : ""}${p.explanation ? `<span>${e(p.explanation)}</span>` : ""}`;
    } catch (error) {
      box.className = "wb-note bad";
      box.textContent = errorText(error);
    } finally {
      asking = false;
      setBusy(busy);
    }
  }

  // ---- transit ----
  function addEv(v: Ev) {
    const tl = $("#rc-tl");
    tl.querySelector(".tl-item.latest")?.classList.remove("latest");
    tl.insertAdjacentHTML(
      "afterbegin",
      `<li class="tl-item latest"><span class="tl-time">${e(v.time)}</span><span class="tl-rail"><i class="tl-dot" data-tone="${v.tone}"></i></span><div class="tl-body"><div class="tl-head"><b>${e(v.title)}</b>${v.pill}</div><code class="tl-mono">${e(v.mono)}</code>${v.lines
        .filter(Boolean)
        .map((l) => `<p>${e(l)}</p>`)
        .join("")}${v.checks ?? ""}</div></li>`,
    );
    $("#rc-count").textContent = String(tl.children.length);
  }
  async function apply(f: Frame, g: number) {
    if (f.parcel) track.parcel(f.parcel);
    if (f.move) {
      await track.move(f.move);
      if (g !== gen) return;
    }
    if (f.stop) track.tone(...f.stop);
    if (f.chip) track.chip(...f.chip);
    if (f.caption) $("#rc-caption").textContent = f.caption;
    if (f.stamp) {
      await track.stamp(...f.stamp);
      if (g !== gen) return;
    }
    if (f.after) track.parcel(f.after);
    for (const id of f.skip ?? []) track.tone(id, "ne", "—");
    if (f.status) $("#rc-status").innerHTML = f.status;
    if (f.ev) addEv(f.ev);
    if (f.fade) track.fade();
    if (f.result) $("#rc-result").innerHTML = f.result();
    if (f.replayLine) {
      const line = root.querySelector("#rc-replay-line");
      if (line) line.innerHTML = f.replayLine;
    }
    if (!f.result && !f.ev) return;
    await sleep(f.stamp ? 260 : 120);
  }
  async function play(g: number) {
    playing = true;
    while (queue.length && g === gen) await apply(queue.shift()!, g);
    if (g === gen) playing = false;
  }
  function enqueue(frames: Frame[]) {
    for (const f of frames)
      if (!seen.has(f.key)) {
        seen.add(f.key);
        queue.push(f);
      }
    if (!playing) void play(gen);
  }
  function startTransit(runId: string) {
    gen++;
    queue = [];
    seen.clear();
    playing = false;
    interrupted = null;
    pendingReplay = null;
    current = runId;
    recoverButtons();
    track.reset();
    $("#rc-compose").hidden = true;
    $("#rc-transit").hidden = false;
    $("#rc-tl").innerHTML = "";
    $("#rc-count").textContent = "";
    $("#rc-result").innerHTML = "";
    $("#rc-caption").textContent = "正在读取运行快照…";
    $("#rc-status").innerHTML = badge("QUEUED");
    $("#rc-runid").textContent = short(runId);
    $("#rc-runid").title = runId;
    notice();
  }
  function frames(s: RunSnapshot): Frame[] {
    const rel = relTo(s.createdAt);
    const cands = s.candidates.filter((c) => c.transport === "signed-http");
    const b = s.task.budget;
    const dup = state.duplicates.get(s.runId);
    const out: Frame[] = [
      {
        key: "reg",
        stop: ["register", "ok"],
        status: badge("RUNNING"),
        caption: `已登记 · requestId ${short(s.task.requestId)}${dup === undefined ? "" : ` · duplicate:${dup}`}`,
        ev: {
          time: "T+0.00s",
          title: "登记",
          tone: "ok",
          pill: pill(dup === undefined ? "已登记" : `202 · duplicate:${dup}`),
          mono: "POST /api/runs → engine.createRun",
          lines: [`requestId ${s.task.requestId}`, `budget maxAttempts ${b.maxAttempts} · timeoutMs ${b.timeoutMs} · maxCostWei ${b.maxCostWei}`, `useHistoricalEvidence ${s.useHistoricalEvidence}`],
        },
      },
    ];
    if (cands.length)
      out.push({
        key: "rank",
        move: "rank",
        stop: ["rank", "ok"],
        caption: `排序 · ${cands.map((c) => c.serviceId).join(" → ")}`,
        ev: {
          time: rel(s.startedAt),
          title: "排序",
          tone: "ok",
          pill: pill(`${cands.length} candidates`),
          mono: "engine.candidates · rankingReasons",
          lines: [`顺序 ${cands.map((c) => c.serviceId).join(" → ")}`, ...(cands[0]?.rankingReasons.slice(0, 2) ?? [])],
        },
      });
    s.attempts.forEach((a, i) => {
      out.push({ key: `go:${a.attemptId}`, move: "deliver", parcel: "acc", stop: ["deliver", "acc"], caption: `attempt ${i + 1} · ${a.serviceId} · 交付中` });
      if (a.status === "RUNNING") return;
      const v = a.verification;
      const adopted = !!s.accepted && a.evidenceId === s.accepted.evidenceId;
      const t: Tone = v ? verdictTone(v.verdict) : "warn";
      const code = v ? (v.verdict === "PASS" ? v.attributionStatus : (v.reasonCodes[0] ?? v.dataVerdict)) : (a.runtimeReason ?? a.observationStatus);
      const head = v ? v.verdict : a.status === "INTERRUPTED" ? "INTERRUPTED" : a.observationStatus;
      out.push({
        key: `vf:${a.attemptId}`,
        move: v ? "verify" : undefined,
        chip: ["deliver", `<span class="att" data-tone="${t}"><b>#${i + 1}</b> ${e(a.serviceId)}</span>`],
        stop: [v ? "verify" : "deliver", t],
        stamp: [`${head} · ${code}`, t, v ? "verify" : "deliver"],
        after: t,
        caption: `attempt ${i + 1} · ${a.serviceId} · ${head} · ${code}${adopted ? "" : " · 拒收"}`,
        ev: {
          time: rel(a.endedAt),
          title: `attempt ${i + 1} · ${a.serviceId}`,
          tone: t,
          pill: badge(head),
          mono: `signed-http → core.verify_delivery · ${Math.round(a.latencyMs)} ms · ${a.source}`,
          lines: v
            ? [`dataVerdict ${v.dataVerdict} · attribution ${v.attributionStatus}`, v.reasonCodes.length ? `reasonCodes ${v.reasonCodes.join(", ")}` : "", a.evidenceId ? `evidence ${short(a.evidenceId)}` : ""]
            : [a.runtimeReason ? `runtimeReason ${a.runtimeReason}` : "", "未获得可核验的交付，不推断数据正确性"],
          checks: v ? `<details class="tl-more"><summary>${v.checks.length} 项核验依据</summary>${checks(v.checks, a.evidenceId)}</details>${a.evidenceId ? `<button type="button" class="btn-text" data-sheet="${e(a.evidenceId)}">打开证据</button>` : ""}` : undefined,
        },
      });
      if (!adopted && (i < s.attempts.length - 1 || s.status === "STOPPED" || s.status === "ERROR"))
        out.push({ key: `rt:${a.attemptId}`, move: "deliver", stop: ["verify", null] });
    });
    if (s.status === "SUCCEEDED" && s.accepted) {
      const acc = s.accepted;
      out.push({
        key: "adopt",
        move: "adopt",
        stop: ["adopt", "ok", "采用"],
        status: badge("SUCCEEDED"),
        caption: `采用 ${acc.serviceId} 的交付`,
        ev: { time: rel(s.finishedAt), title: "原子采用", tone: "ok", pill: badge("SUCCEEDED"), mono: "RunSnapshot.accepted", lines: [`serviceId ${acc.serviceId}`, `evidenceId ${acc.evidenceId}`, `spentWei ${s.spentWei}`] },
        result: () =>
          `<section class="card result" data-tone="ok"><div class="result-head"><div><span class="eyebrow">Accepted</span><h2>已采用</h2></div>${badge("SUCCEEDED")}</div><dl class="kv"><div><dt>serviceId</dt><dd>${e(acc.serviceId)}</dd></div>${Object.entries(acc.values)
            .map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`)
            .join("")}<div><dt>blockHash</dt><dd>${e(acc.blockHash)}</dd></div></dl><div class="result-code">${barcode(acc.evidenceId)}<code>${e(acc.evidenceId)}</code></div><p class="hint" id="rc-replay-line">正在封存证据…</p><div class="actions"><button class="btn" type="button" data-sheet="${e(acc.evidenceId)}">查看证据</button><button class="btn-text" type="button" data-rc-new>重新填单</button></div></section>`,
      });
    } else if (s.status === "STOPPED" || s.status === "ERROR") {
      out.push({
        key: "stop",
        move: "adopt",
        stop: ["adopt", "bad", "停止"],
        stamp: [`${s.status} · ${s.stopReason ?? "—"}`, "bad", "adopt"],
        after: "bad",
        skip: ["seal", "replay"],
        fade: true,
        status: badge(s.status),
        caption: `已停止 · ${s.stopReason ?? "—"} · 不采用任何数据`,
        ev: { time: rel(s.finishedAt), title: s.status === "ERROR" ? "流程异常" : "停止", tone: "bad", pill: badge(s.status), mono: "RunSnapshot.stopReason", lines: [`stopReason ${s.stopReason ?? "—"}`, `attempts ${s.attempts.length} · spentWei ${s.spentWei}`] },
        result: () =>
          `<section class="card result" data-tone="bad"><div class="result-head"><div><span class="eyebrow">Stopped</span><h2>已停止，不采用任何数据</h2></div>${badge(s.status)}</div><p class="result-reason"><code>${e(s.stopReason ?? "—")}</code></p><p class="hint">accepted = null。调用方应停止依赖本次查询；每份已核验交付的证据仍可复验。</p><ol class="attempt-list">${s.attempts
            .map(
              (a, i) =>
                `<li><span class="mono-muted">#${i + 1}</span><code>${e(a.serviceId)}</code>${a.verification ? badge(a.verification.verdict) : badge(a.observationStatus)}<code class="mono-muted">${e(a.verification?.reasonCodes[0] ?? a.runtimeReason ?? "")}</code>${a.evidenceId ? `<button type="button" class="btn-text" data-sheet="${e(a.evidenceId)}">证据</button>` : ""}</li>`,
            )
            .join("")}</ol><div class="actions"><button class="btn" type="button" data-rc-new>重新填单</button></div></section>`,
      });
    }
    return out;
  }
  function sealFrame(d: EvidenceDetail, when: string): Frame {
    return {
      key: `seal:${d.evidenceId}`,
      move: "seal",
      stop: ["seal", "ok"],
      parcel: "ok",
      caption: `证据封存 · evidenceHash ${short(d.manifest.evidenceHash)}`,
      replayLine: `证据已封存 · ${e(d.manifest.hashAlgorithm)} · 发布 ${e(d.publication.status)}`,
      ev: { time: when, title: "证据封存", tone: "ok", pill: badge(d.artifactIntegrity), mono: `GET /api/evidence/:id · ${d.manifest.hashAlgorithm}`, lines: [`evidenceHash ${d.manifest.evidenceHash}`, `publication ${d.publication.status} · adapter ${d.publication.adapter}`] },
    };
  }
  function replayFrame(r: ReplaySnapshot, instanceId: string, rel: (iso: string | null) => string): Frame {
    const res = r.result;
    const c = r.reportConsistent;
    const t: Tone = c === true ? "ok" : c === false ? "bad" : "warn";
    const text = c === true ? "REPORT CONSISTENT" : c === false ? "REPORT MISMATCH" : (res?.comparison ?? r.status);
    return {
      key: `rep:${r.replayId}`,
      move: "replay",
      stop: ["replay", t],
      stamp: [text, t, "replay"],
      fade: true,
      caption: `第二实例 ${instanceId} 重算 · reportConsistent ${String(c)} · ${res?.comparison ?? r.status}`,
      replayLine: `第二实例 <code>${e(instanceId)}</code> 重算：reportConsistent <b>${e(String(c))}</b> · ${e(res?.comparison ?? r.status)} · 发布 not_requested`,
      ev: {
        time: rel(r.finishedAt ?? r.createdAt),
        title: "第二实例复验",
        tone: t,
        pill: `${pill(`reportConsistent ${String(c)}`, t)}${badge(res?.comparison ?? r.status)}`,
        mono: `${port(secondary)} · /api/evidence/import → /api/replays`,
        lines: [`instanceId ${instanceId}`, res ? `artifactIntegrity ${res.artifactIntegrity} · comparison ${res.comparison}` : "", res?.recomputedResult ? `recomputed ${res.recomputedResult.verdict} · ${res.recomputedResult.attributionStatus}` : "", r.error ?? ""],
      },
    };
  }
  async function secondReplay(detail: EvidenceDetail, createdAt: string, g: number) {
    const rel = relTo(createdAt);
    try {
      const other = MetaSchema.parse(await request(secondary, "/api/meta"));
      if (other.instanceId === state.meta?.instanceId) throw new Error("第二实例地址指向当前实例，不能标为独立复验。");
      if (!other.contexts.some((c) => c.contextId === detail.contextId)) throw new Error(`第二实例没有配置 contextId ${detail.contextId}。`);
      const bundle = EvidenceBundleSchema.parse(await request(primary, `/api/evidence/${encodeURIComponent(detail.evidenceId)}/bundle`));
      await request(secondary, "/api/evidence/import", { bundle, manifest: detail.manifest, contextId: detail.contextId });
      const r = await replay(secondary, detail.evidenceId, detail.contextId);
      if (g !== gen) return;
      enqueue([replayFrame(r, other.instanceId, rel)]);
    } catch (error) {
      if (g !== gen) return;
      enqueue([
        {
          key: "rep:unavailable",
          move: "replay",
          stop: ["replay", "warn"],
          stamp: ["REPLAY UNAVAILABLE", "warn", "replay"],
          fade: true,
          caption: `第二实例复验未完成：${errorText(error)}`,
          replayLine: `第二实例复验未完成：${e(errorText(error))}`,
          ev: { time: "—", title: "第二实例复验未完成", tone: "warn", pill: badge("UNAVAILABLE"), mono: port(secondary), lines: [errorText(error)] },
        },
      ]);
    }
  }
  async function afterRun(s: RunSnapshot, g: number) {
    if (!s.accepted) return;
    const id = s.accepted.evidenceId;
    const detail = DetailSchema.parse(await request(primary, `/api/evidence/${encodeURIComponent(id)}`));
    if (g !== gen) return;
    enqueue([sealFrame(detail, relTo(s.createdAt)(s.attempts.find((a) => a.evidenceId === id)?.endedAt ?? null))]);
    if (state.freshRuns.has(s.runId)) return secondReplay(detail, s.createdAt, g);
    // Runs opened by link or refresh do not write to the second instance until asked.
    pendingReplay = { detail, createdAt: s.createdAt };
    recoverButtons();
    enqueue([{ key: "rep:manual", caption: "通过链接打开的运行不会自动写入第二实例；需要时点击「在第二实例复验」。", replayLine: "第二实例复验尚未发起。" }]);
  }
  async function follow(runId: string, g: number) {
    for (;;) {
      let s: RunSnapshot;
      try {
        s = RunSnapshotSchema.parse(await request(primary, `/api/runs/${encodeURIComponent(runId)}`));
      } catch (error) {
        if (g !== gen) return;
        interrupted = runId;
        recoverButtons();
        notice(`查询中断，运行可能仍在后端执行。点击「继续查询同一运行」恢复，不会新建任务。${errorText(error)}`);
        return;
      }
      if (g !== gen) return;
      $("#rc-scope").textContent = `${short(s.task.account)} @ ${short(s.task.blockHash)} · ${s.task.fields.join(" · ")}`;
      enqueue(frames(s));
      if (["SUCCEEDED", "STOPPED", "ERROR"].includes(s.status)) return afterRun(s, g);
      await sleep(300);
    }
  }
  async function submit() {
    if (busy) return;
    try {
      pending ??= input();
      persist();
      setBusy(true);
      const res = Created.parse(await request(primary, "/api/runs", pending));
      pending = null;
      persist();
      state.freshRuns.add(res.runId);
      state.duplicates.set(res.runId, res.duplicate);
      startTransit(res.runId);
      history.replaceState(null, "", `#receive?run=${res.runId}`);
      const g = gen;
      await follow(res.runId, g);
    } catch (error) {
      if (error instanceof ApiError && [400, 404, 409, 415, 422].includes(error.status)) {
        pending = null;
        persist();
      }
      notice(pending ? `提交未确认。为避免重复调用，请使用「重试同一请求」。${errorText(error)}` : errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function open(runId: string) {
    if (busy || runId === current) return;
    startTransit(runId);
    const g = gen;
    setBusy(true);
    try {
      await ensureMeta();
      await follow(runId, g);
    } catch (error) {
      if (g === gen) notice(`无法读取运行 ${runId}：${errorText(error)}`);
    } finally {
      if (g === gen) setBusy(false);
    }
  }
  async function resume() {
    if (busy || !interrupted) return;
    const runId = interrupted;
    interrupted = null;
    recoverButtons();
    notice();
    const g = gen;
    setBusy(true);
    try {
      await follow(runId, g);
    } finally {
      if (g === gen) setBusy(false);
    }
  }
  async function manualReplay() {
    if (busy || !pendingReplay) return;
    const { detail, createdAt } = pendingReplay;
    pendingReplay = null;
    recoverButtons();
    const g = gen;
    setBusy(true);
    try {
      await secondReplay(detail, createdAt, g);
    } finally {
      if (g === gen) setBusy(false);
    }
  }
  root.addEventListener("click", (event) => {
    const b = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || busy) return;
    if (b.hasAttribute("data-rc-new")) showCompose();
    if (b.hasAttribute("data-rc-resume")) void resume();
    if (b.hasAttribute("data-rc-second")) void manualReplay();
    if (b.id === "rc-retry") void submit();
  });
  $("#rc-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  $("#rc-ask").addEventListener("submit", (event) => {
    event.preventDefault();
    void ask($<HTMLInputElement>("#rc-ask-input").value.trim());
  });
  $("#rc-context").addEventListener("change", applyContext);
  onConnection(() => {
    if (!state.meta) {
      ready = false;
      setBusy(busy);
    } else if (!ready) void load();
  });
  void load();
  return {
    route(params) {
      const run = params.get("run");
      if (run && /^[A-Za-z0-9_.:-]{1,160}$/.test(run)) void open(run);
    },
    reconnect() {
      void resume();
    },
  };
}
