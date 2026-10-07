import { escape as e, type Tone } from "./view";
import { reducedMotion } from "./state";

// A horizontal route of stops. The parcel and stamps only ever show states the caller passes in.
export type Stop = { id: string; label: string; code: string };
const parcel = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5z" class="pc-box"/><path d="M3 6.5 10 10l7-3.5M10 10v7" class="pc-tape"/></svg>`;

export function createTrack(root: HTMLElement, stops: Stop[]) {
  root.innerHTML = `<div class="track"><div class="track-inner"><div class="track-line"></div><ol class="track-stops">${stops
    .map(
      (s) =>
        `<li class="stop" data-stop="${e(s.id)}"><span class="stop-dot"></span><span class="stop-label">${e(s.label)}</span><code class="stop-code">${e(s.code)}</code><span class="stop-chips"></span></li>`,
    )
    .join("")}</ol><span class="track-parcel" data-tone="acc">${parcel}</span><span class="track-stamp" hidden></span></div></div>`;
  const inner = root.querySelector<HTMLElement>(".track-inner")!;
  const box = root.querySelector<HTMLElement>(".track-parcel")!;
  const stampEl = root.querySelector<HTMLElement>(".track-stamp")!;
  let at = stops[0].id;
  const stopEl = (id: string) => root.querySelector<HTMLElement>(`[data-stop="${CSS.escape(id)}"]`);
  const center = (id: string) => {
    const dot = stopEl(id)?.querySelector<HTMLElement>(".stop-dot");
    if (!dot) return 0;
    return dot.getBoundingClientRect().left - inner.getBoundingClientRect().left + dot.offsetWidth / 2;
  };
  const place = () => {
    box.style.transform = `translateX(${center(at) - 11}px)`;
  };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, reducedMotion() ? 0 : ms));
  const observer = new ResizeObserver(place);
  observer.observe(inner);
  return {
    reset() {
      at = stops[0].id;
      stampEl.hidden = true;
      box.dataset.tone = "acc";
      box.style.opacity = "1";
      for (const li of root.querySelectorAll<HTMLElement>(".stop")) {
        li.removeAttribute("data-tone");
        li.querySelector(".stop-chips")!.innerHTML = "";
        const def = stops.find((s) => s.id === li.dataset.stop)!;
        li.querySelector(".stop-label")!.textContent = def.label;
      }
      box.classList.add("instant");
      place();
      requestAnimationFrame(() => box.classList.remove("instant"));
    },
    async move(id: string) {
      stampEl.hidden = true;
      if (id === at) return;
      at = id;
      place();
      await wait(520);
    },
    tone(id: string, t: Tone | null, label?: string) {
      const li = stopEl(id);
      if (!li) return;
      if (t) li.dataset.tone = t;
      else li.removeAttribute("data-tone");
      if (label) li.querySelector(".stop-label")!.textContent = label;
    },
    parcel(t: Tone) {
      box.dataset.tone = t;
    },
    fade() {
      box.style.opacity = "0.4";
    },
    chip(id: string, html: string) {
      stopEl(id)?.querySelector(".stop-chips")?.insertAdjacentHTML("beforeend", html);
    },
    async stamp(text: string, t: Tone, id: string) {
      stampEl.textContent = text;
      stampEl.dataset.tone = t;
      stampEl.hidden = false;
      const x = center(id);
      const width = inner.clientWidth;
      stampEl.style.left = `${Math.min(Math.max(x, 90), width - 90)}px`;
      stampEl.classList.remove("hit");
      void stampEl.offsetWidth;
      stampEl.classList.add("hit");
      await wait(620);
    },
    destroy() {
      observer.disconnect();
    },
  };
}
export type Track = ReturnType<typeof createTrack>;
