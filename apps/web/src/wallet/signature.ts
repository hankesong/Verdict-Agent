export function signaturePad(canvas: HTMLCanvasElement, changed: (ready: boolean) => void) {
  const context = canvas.getContext("2d")!;
  let down = false, pointer = -1, length = 0, points = 0, width = 0, height = 0;
  let last = { x: 0, y: 0 };
  const clear = () => { down = false; length = 0; points = 0; context.clearRect(0, 0, canvas.width, canvas.height); changed(false); };
  const observer = new ResizeObserver(() => {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height || (width === box.width && height === box.height)) return;
    width = box.width; height = box.height;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineWidth = 2; context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "#263b32";
    clear();
  });
  observer.observe(canvas);
  const position = (event: PointerEvent) => { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  canvas.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault(); down = true; pointer = event.pointerId; last = position(event); canvas.setPointerCapture(pointer);
  };
  canvas.onpointermove = event => {
    if (!down || event.pointerId !== pointer) return;
    const next = position(event), distance = Math.hypot(next.x - last.x, next.y - last.y);
    if (distance > 0) { context.beginPath(); context.moveTo(last.x, last.y); context.lineTo(next.x, next.y); context.stroke(); length += distance; points++; last = next; }
  };
  canvas.onpointerup = event => { if (event.pointerId === pointer) { down = false; changed(length >= 35 && points >= 4); } };
  canvas.onpointercancel = () => clear();
  return { clear, destroy: () => { observer.disconnect(); clear(); } };
}
