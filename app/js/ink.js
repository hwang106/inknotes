// InkNotes pen engine.
// Tuned on a Galaxy S25 Ultra (S Pen) and a Surface (MPP pen); see ink-test.html for the
// test bench these rules came from.
//
// Points are [x, y, pressure, ms-since-stroke-start] in note units: the page is W units wide,
// so ink scales with the note on any screen.

export const W = 1000;
export const INKS = ["#1b1b1f", "#2b59c3", "#c0392b", "#1e8a4c", "#7b3fb8"];
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

// Rejoining strokes split by very light pressure (MPP pens dip below the contact threshold).
// Off on Android: S Pen touchdowns start light, so joining only merged separate marks.
const JOIN_MS = 120, LIGHT_P = 0.15, LIGHT_WINDOW_MS = 40;
const MIN_JOIN_LEN_PX = 15, MIN_JOIN_MS = 80, JOIN_MAX_TURN_COS = 0.64;
const JOIN_STEP_PX = 10, JOIN_PATH_PX = 24;
const PALM_MS = 600;   // touch is ignored this long after any pen activity

const clamp01 = v => Math.max(0, Math.min(1, v));
export const gammaOf = curve => Math.pow(2, (curve - 50) / 30);
export const smoothPx = v => 3 * v / 100;   // Smooth slider 0–100 → radius 0–3 screen px

// Narrow width range (40–100% of size) keeps handwriting even, like a fine pen.
export function widthOf(s, p, minW = 0) {
  return Math.max(s.w * (0.4 + 0.6 * Math.pow(clamp01(p), s.g)), minW);
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
function seg(ctx, s, i, minW) {
  const P = s.pts, a = i === 1 ? P[0] : mid(P[i - 2], P[i - 1]), b = mid(P[i - 1], P[i]), c = P[i - 1];
  ctx.strokeStyle = s.c; ctx.lineWidth = widthOf(s, c[2], minW);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
}
function tail(ctx, s, minW) {
  const P = s.pts, n = P.length;
  if (n === 1) {
    ctx.fillStyle = s.c; ctx.beginPath();
    ctx.arc(P[0][0], P[0][1], widthOf(s, P[0][2], minW) / 2, 0, Math.PI * 2); ctx.fill(); return;
  }
  const a = mid(P[n - 2], P[n - 1]);
  ctx.strokeStyle = s.c; ctx.lineWidth = widthOf(s, P[n - 1][2], minW);
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(P[n - 1][0], P[n - 1][1]); ctx.stroke();
}
export function drawStroke(ctx, s, minW = 0) {
  for (let i = 1; i < s.pts.length; i++) seg(ctx, s, i, minW);
  tail(ctx, s, minW);
}

// Fine smoothing on lift: Gaussian average along the line. ~1.5–2 px removes MPP jitter
// while letter curves keep their shape. Ends stay where the pen touched.
export function smoothStroke(P, sigma) {
  const n = P.length; if (n < 3 || sigma <= 0) return P;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = s[n - 1];
  return P.map((p, i) => {
    if (i === 0 || i === n - 1) return p;
    const sg = Math.min(sigma, s[i] / 2, (total - s[i]) / 2);
    if (sg < 1e-3) return p;
    let wx = 0, wy = 0, ws = 0;
    for (let j = i; j >= 0 && s[i] - s[j] <= 3 * sg; j--) {
      const w = Math.exp(-((s[i] - s[j]) ** 2) / (2 * sg * sg)); wx += w * P[j][0]; wy += w * P[j][1]; ws += w;
    }
    for (let j = i + 1; j < n && s[j] - s[i] <= 3 * sg; j++) {
      const w = Math.exp(-((s[j] - s[i]) ** 2) / (2 * sg * sg)); wx += w * P[j][0]; wy += w * P[j][1]; ws += w;
    }
    return [wx / ws, wy / ws, p[2], p[3]];
  });
}

export function inkBottom(strokes) {
  let y = 0;
  for (const s of strokes) for (const q of s.pts) if (q[1] + s.w > y) y = q[1] + s.w;
  return y;
}

const isEraseButton = e => e.pointerType === "pen" && ((e.buttons & 2) || (e.buttons & 32));

// Handles pen/finger/mouse input on a note page and draws into a transparent canvas laid over
// the text and images, so ink can mark up both. The note colour is painted by a separate
// canvas underneath (see app.js): the low-latency canvas mode that showed transparent areas as
// black on Windows is not used here. `settings()` returns
// { color, size, curve, smooth, touchInk, eraser }.
export class InkSurface {
  constructor({ page, scroller, canvas, settings, onCommit, onInkStart }) {
    Object.assign(this, { page, scroller, canvas, settings, onCommit, onInkStart });
    this.ctx = canvas.getContext("2d");
    this.strokes = []; this.history = [];
    this.scale = 1; this.dpr = 1;
    this.active = null; this.activeId = null; this.activeType = null; this.erasing = false;
    this.lastPenAt = -1e9; this.lastInkAt = -1e9; this.pEma = 0; this.t0 = 0;
    this.lastEnd = null; this.hoverTrail = []; this.touchScroll = null;
    page.addEventListener("pointerdown", e => this.down(e));
    page.addEventListener("pointermove", e => this.move(e));
    page.addEventListener("pointerup", e => this.up(e));
    page.addEventListener("pointercancel", e => this.up(e));
    page.addEventListener("contextmenu", e => { if (this.activeId !== null || e.pointerType === "pen") e.preventDefault(); });
  }

  setStrokes(strokes) {
    this.strokes = strokes; this.history = [];
    this.active = null; this.activeId = null; this.erasing = false; this.lastEnd = null;
    this.redraw();
  }
  inkedRecently(ms = 500) { return performance.now() - this.lastInkAt < ms; }
  get busy() { return this.activeId !== null; }

  minW() { return 0.9 * this.dpr / this.scale; }
  resize() {
    const r = this.page.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * this.dpr)), h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.scale = (r.width / W) * this.dpr;
    this.redraw();
  }
  redraw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const m = this.minW();
    for (const s of this.strokes) drawStroke(ctx, s, m);
    if (this.active) for (let i = 1; i < this.active.pts.length; i++) seg(ctx, this.active, i, m);
  }

  pxPerUnit() { return this.page.getBoundingClientRect().width / W; }
  toLogical(e) {
    const r = this.page.getBoundingClientRect(), k = W / r.width;
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
  }
  pressureOf(e) {
    if (e.pointerType === "mouse") return 0.5;
    if (e.pressure === 0 && e.buttons) return 0.5;
    return e.pressure;
  }

  // ---------- pointer handling ----------
  down(e) {
    const t = e.pointerType, set = this.settings();
    if (t === "pen") {
      this.lastPenAt = e.timeStamp;
      // A palm that landed just before the pen: throw its stroke away.
      if (this.active && this.activeType !== "pen") { this.active = null; this.activeId = null; this.redraw(); }
    }
    if (t === "touch") {
      // Palms and fingers never act while the pen is writing or was just used.
      if (this.activeType === "pen" && this.activeId !== null) return;
      if (e.timeStamp - this.lastPenAt < PALM_MS) { e.preventDefault(); return; }
    }
    const wantsInk = t === "pen" || (set.touchInk && (t === "touch" || (t === "mouse" && e.button === 0)));
    if (!wantsInk) {
      // The page blocks native panning (so the pen can write), so fingers scroll it here.
      if (t === "touch" && !this.touchScroll) this.touchScroll = { id: e.pointerId, y0: e.clientY, top0: this.scroller.scrollTop };
      return;
    }
    e.preventDefault();   // keeps the text box from taking focus or selecting text
    if (this.activeId !== null || this.erasing) return;
    try { this.page.setPointerCapture(e.pointerId); } catch (_) {}
    this.activeId = e.pointerId; this.activeType = t;
    this.lastInkAt = performance.now();
    if (this.onInkStart) this.onInkStart();
    const [x, y] = this.toLogical(e), p = this.pressureOf(e);
    if (set.eraser || isEraseButton(e)) { this.erasing = true; this.lastEnd = null; this.eraseAt(x, y); return; }
    if (this.resume(e, x, y, p)) return;
    this.t0 = e.timeStamp; this.pEma = p;
    // Width is chosen in screen pixels but stored in note units.
    const wUnits = +(set.size / this.pxPerUnit()).toFixed(3);
    this.active = { c: set.color, w: wUnits, g: +gammaOf(set.curve).toFixed(3), pts: [[x, y, p, 0]] };
  }

  move(e) {
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (e.pointerType === "pen") this.lastPenAt = e.timeStamp;
    if (this.touchScroll && e.pointerId === this.touchScroll.id) {
      this.scroller.scrollTop = this.touchScroll.top0 - (e.clientY - this.touchScroll.y0);
      return;
    }
    if (this.activeId !== null && e.pointerId !== this.activeId) return;   // ignore palms and other fingers
    if (!this.active && !this.erasing) {
      if (this.lastEnd && e.pointerType === "pen" && !e.buttons) {
        for (const ev of evs) {
          if (ev.timeStamp - this.lastEnd.t > JOIN_MS) break;
          const [hx, hy] = this.toLogical(ev); this.hoverTrail.push([hx, hy, ev.timeStamp]);
        }
      }
      return;
    }
    this.lastInkAt = performance.now();
    for (const ev of evs) {
      const [x, y] = this.toLogical(ev);
      if (this.erasing) { this.eraseAt(x, y); continue; }
      this.addPoint(x, y, this.pressureOf(ev), ev.timeStamp);
    }
  }

  up(e) {
    if (this.touchScroll && e.pointerId === this.touchScroll.id) { this.touchScroll = null; return; }
    if (this.activeId !== null && e.pointerId !== this.activeId) return;   // a palm lifting doesn't end the pen's stroke
    if (e.pointerType === "pen") this.lastPenAt = e.timeStamp;
    if (this.activeId === null) return;
    this.activeId = null;
    this.lastInkAt = performance.now();
    if (this.erasing) { this.erasing = false; return; }
    if (!this.active) return;
    const a = this.active, m = this.minW();
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    tail(this.ctx, a, m);
    // How light was the ending, and was this a real line? (decides rejoining)
    const R = a.pts, tEnd = R[R.length - 1][3];
    let endP = 0, lenPx = 0;
    for (let i = R.length - 1; i >= 0 && R[i][3] >= tEnd - LIGHT_WINDOW_MS; i--) endP = Math.max(endP, R[i][2]);
    for (let i = 1; i < R.length; i++) lenPx += Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]);
    lenPx *= this.pxPerUnit();
    const set = this.settings();
    if (set.smooth > 0) a.pts = smoothStroke(a.pts, smoothPx(set.smooth) / this.pxPerUnit());
    a.pts = a.pts.map(q => [+q[0].toFixed(1), +q[1].toFixed(1), +q[2].toFixed(3), q[3]]);
    this.strokes.push(a); this.history.push({ t: "add", s: a });
    this.active = null;
    if (set.smooth > 0) this.redraw();
    const isLine = lenPx >= MIN_JOIN_LEN_PX && tEnd >= MIN_JOIN_MS;
    this.lastEnd = !IS_ANDROID && isLine && e.pointerType === "pen" && endP <= LIGHT_P
      ? { s: a, t: e.timeStamp, t0: this.t0 } : null;
    this.hoverTrail = [];
    this.onCommit();
  }

  addPoint(x, y, p, ts) {
    this.pEma += 0.35 * (p - this.pEma);   // smooth pressure so width doesn't jump
    const P = this.active.pts, q = P[P.length - 1];
    if ((x - q[0]) ** 2 + (y - q[1]) ** 2 < 0.25) return;
    P.push([x, y, this.pEma, Math.round(ts - this.t0)]);
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.ctx.lineCap = "round"; this.ctx.lineJoin = "round";
    seg(this.ctx, this.active, P.length - 1, this.minW());
  }

  // Continue the previous stroke if this touchdown is really a light-pressure dropout.
  resume(e, x, y, p) {
    const L = this.lastEnd; this.lastEnd = null;
    if (!L || e.pointerType !== "pen" || L.s !== this.strokes[this.strokes.length - 1]) return false;
    if (e.timeStamp - L.t > JOIN_MS || p > LIGHT_P) return false;
    const q = L.s.pts[L.s.pts.length - 1], ppu = this.pxPerUnit();
    const chain = [[q[0], q[1]], ...this.hoverTrail, [x, y]];
    let len = 0;
    for (let i = 1; i < chain.length; i++) {
      const d = Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]) * ppu;
      if (d > JOIN_STEP_PX) return false;
      len += d;
    }
    if (len > JOIN_PATH_PX) return false;
    if (Math.hypot(x - q[0], y - q[1]) * ppu > 3) {
      const P = L.s.pts; let j = P.length - 1;
      while (j > 0 && Math.hypot(q[0] - P[j][0], q[1] - P[j][1]) * ppu < 10) j--;
      const ex = q[0] - P[j][0], ey = q[1] - P[j][1], bx = x - q[0], by = y - q[1];
      if ((ex * bx + ey * by) / ((Math.hypot(ex, ey) * Math.hypot(bx, by)) || 1) < JOIN_MAX_TURN_COS) return false;
    }
    this.strokes.pop();
    const h = this.history[this.history.length - 1];
    if (h && h.t === "add" && h.s === L.s) this.history.pop();
    this.active = L.s; this.t0 = L.t0; this.pEma = p;
    this.redraw();
    for (const [hx, hy, ht] of this.hoverTrail) this.addPoint(hx, hy, 0, ht);
    this.addPoint(x, y, p, e.timeStamp);
    this.hoverTrail = [];
    return true;
  }

  eraseAt(x, y) {
    const r = 10 / this.pxPerUnit(), removed = [];
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i], rr = (r + s.w / 2) ** 2;
      if (s.pts.some(q => (q[0] - x) ** 2 + (q[1] - y) ** 2 < rr)) { removed.push({ s, i }); this.strokes.splice(i, 1); }
    }
    if (removed.length) { this.history.push({ t: "erase", removed }); this.redraw(); this.onCommit(); }
  }

  undo() {
    const h = this.history.pop(); if (!h) return false;
    if (h.t === "add") { const i = this.strokes.lastIndexOf(h.s); if (i >= 0) this.strokes.splice(i, 1); }
    else if (h.t === "erase") { for (const { s, i } of h.removed.slice().reverse()) this.strokes.splice(i, 0, s); }
    this.lastEnd = null;
    this.redraw(); this.onCommit();
    return true;
  }
}
