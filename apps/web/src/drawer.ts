import { onApiLog, port, primary, request, type ApiLogEntry } from "./api";
import { escape as e, short, errorText } from "./view";

// Engineering drawer: shows the page's real API traffic and the original evidence JSON located by pointer.
// It only displays; nothing here verifies, hashes or changes evidence.
export function mountDrawer(root: HTMLElement) {
  root.innerHTML = `<div class="drawer-head"><div><span class="eyebrow">ENGINEERING VIEW</span><h2>工程抽屉</h2></div><button type="button" class="icon-btn" data-drawer-close aria-label="关闭工程抽屉">×</button></div>
<section class="drawer-sec"><div class="drawer-sec-head"><h3>接口流水</h3><button type="button" class="btn-text" data-drawer-clear>清空</button></div><ol class="api-log" id="api-log"><li class="api-empty">尚无请求。页面发出的每个请求都会出现在这里。</li></ol></section>
<section class="drawer-sec"><div class="drawer-sec-head"><h3>证据原文</h3><span class="mono-muted" id="doc-title">未载入</span></div><p class="drawer-hint" id="doc-hint">点击任一检查项下的证据位置（JSON Pointer），这里定位到原始证据包中的对应字段。</p><pre class="json" id="doc-view"></pre></section>`;
  const log = root.querySelector<HTMLElement>("#api-log")!;
  const rows = new Map<number, HTMLLIElement>();
  let docId: string | null = null;
  const status = (x: ApiLogEntry) =>
    x.status === null
      ? x.error
        ? `<span class="st bad">ERR</span>`
        : `<span class="st">…</span>`
      : `<span class="st ${x.status < 300 ? "ok" : x.status < 500 ? "warn" : "bad"}">${x.status}</span>`;
  const preview = (value: unknown) => {
    if (value === undefined) return "";
    const text = JSON.stringify(value, null, 2) ?? "";
    return e(text.length > 4000 ? text.slice(0, 4000) + "\n… (已截断)" : text);
  };
  onApiLog((x) => {
    log.querySelector(".api-empty")?.remove();
    let li = rows.get(x.id);
    if (!li) {
      li = document.createElement("li");
      rows.set(x.id, li);
      log.prepend(li);
      while (log.children.length > 200) {
        const last = log.lastElementChild as HTMLLIElement;
        for (const [k, v] of rows) if (v === last) rows.delete(k);
        last.remove();
      }
    }
    const t = new Date(x.at).toLocaleTimeString("zh-CN", { hour12: false });
    li.innerHTML = `<details><summary>${status(x)}<span class="m">${x.method}</span><span class="p">${e(port(x.base))}${e(x.path)}</span><span class="ms">${x.ms === null ? "" : Math.round(x.ms) + " ms"}</span></summary><div class="api-detail"><div class="mono-muted">${t} · ${e(x.base)}</div>${x.body !== undefined ? `<h4>请求体</h4><pre>${preview(x.body)}</pre>` : ""}${x.response !== undefined ? `<h4>响应</h4><pre>${preview(x.response)}</pre>` : ""}${x.error ? `<h4>错误</h4><pre>${e(x.error)}</pre>` : ""}</div></details>`;
  });
  root.querySelector("[data-drawer-clear]")!.addEventListener("click", () => {
    rows.clear();
    log.innerHTML = '<li class="api-empty">已清空。</li>';
  });
  const esc = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
  function render(value: unknown, ptr: string, depth: number): string {
    const pad = "  ".repeat(depth);
    const wrap = (inner: string) => `<span class="j" data-ptr="${e(ptr)}">${inner}</span>`;
    if (Array.isArray(value))
      return wrap(
        value.length
          ? `[\n${value.map((v, i) => `${pad}  ${render(v, `${ptr}/${i}`, depth + 1)}`).join(",\n")}\n${pad}]`
          : "[]",
      );
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      return wrap(
        entries.length
          ? `{\n${entries
              .map(
                ([k, v]) =>
                  `${pad}  <span class="jk">${e(JSON.stringify(k))}</span>: ${render(v, `${ptr}/${esc(k)}`, depth + 1)}`,
              )
              .join(",\n")}\n${pad}}`
          : "{}",
      );
    }
    const cls = typeof value === "string" ? "js" : typeof value === "number" ? "jn" : "jb";
    return wrap(`<span class="${cls}">${e(JSON.stringify(value))}</span>`);
  }
  const view = root.querySelector<HTMLElement>("#doc-view")!;
  function showDocument(id: string, title: string, value: unknown) {
    docId = id;
    root.querySelector("#doc-title")!.textContent = title;
    view.innerHTML = render(value, "", 0);
  }
  function highlight(pointer: string) {
    const ptr = pointer.replace(/^#/, "");
    view.querySelectorAll(".hl").forEach((x) => x.classList.remove("hl"));
    const target = [...view.querySelectorAll<HTMLElement>(".j")].find((x) => x.dataset.ptr === ptr);
    const hint = root.querySelector<HTMLElement>("#doc-hint")!;
    if (!target) {
      hint.textContent = `证据包中没有找到 ${pointer}。引用以服务端返回为准，页面不补造位置。`;
      return;
    }
    hint.textContent = `已定位 ${pointer}`;
    target.classList.add("hl");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  async function focusPointer(pointer: string, evidenceId?: string) {
    open();
    try {
      if (evidenceId && evidenceId !== docId) {
        root.querySelector("#doc-hint")!.textContent = "正在读取原始证据包…";
        const bundle = await request(primary, `/api/evidence/${encodeURIComponent(evidenceId)}/bundle`);
        showDocument(evidenceId, `bundle ${short(evidenceId)}`, bundle);
      }
      highlight(pointer);
    } catch (error) {
      root.querySelector("#doc-hint")!.textContent = `无法读取证据：${errorText(error)}`;
    }
  }
  const wide = () => matchMedia("(min-width: 1360px)").matches;
  // On narrow screens the drawer overlays the stage, so it always starts closed there.
  let opened = (() => {
    if (!wide()) return false;
    try {
      return localStorage.getItem("verdict-drawer") !== "closed";
    } catch {
      return true;
    }
  })();
  function apply() {
    document.body.classList.toggle("drawer-open", opened);
    root.setAttribute("aria-hidden", String(!opened));
    try {
      localStorage.setItem("verdict-drawer", opened ? "open" : "closed");
    } catch {}
  }
  function open() {
    opened = true;
    apply();
  }
  function toggle() {
    opened = !opened;
    apply();
  }
  root.querySelector("[data-drawer-close]")!.addEventListener("click", () => {
    opened = false;
    apply();
  });
  apply();
  return { open, toggle, showDocument, focusPointer, highlight };
}
export type Drawer = ReturnType<typeof mountDrawer>;
