// Turns Windows Sticky Notes rows (from plum.sqlite) into InkNotes notes.
// Pure functions, so test/sticky.test.mjs can check them without a real database.
//
// What Sticky Notes stores, as worked out from a real database (FormatVersion 1 ink):
// - Note.Text: one line per paragraph, each starting "\id=<id>", then RTF-like control words
//   (\b \i \ul \strike, each turned off by a trailing 0, and \l for a bulleted line).
// - Stroke.Data: six big-endian floats (start x, start y, start pressure, x step, y step,
//   pressure step), then a LEB128 varint 2n, then n points as three zigzag varints each:
//   the change in x, y and pressure, in those steps. Positions are in the note's DIPs.
// - Times are .NET ticks (100 ns since year 1).

const TICKS_AT_1970 = 621355968000000000n;
export const ticksToMs = t => (t == null ? null : Number((BigInt(t) - TICKS_AT_1970) / 10000n));

const PAPER = { Yellow: "yellow", Green: "green", Pink: "pink", Blue: "blue", Purple: "purple", Gray: "gray", Charcoal: "gray" };
export const paperOf = theme => PAPER[theme] || "yellow";

// ---------- text ----------
const esc = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const BS = "\\";

export function parseLine(raw) {
  let s = raw.replace(/\r$/, "");
  const id = /^\\id=[^\\ ]* ?/.exec(s);
  if (id) s = s.slice(id[0].length);
  const fmt = { b: false, i: false, u: false, s: false };
  const runs = []; let bullet = false, text = "";
  const flush = () => { if (text) { runs.push({ text, ...fmt }); text = ""; } };
  for (let k = 0; k < s.length;) {
    if (s[k] !== BS) { text += s[k++]; continue; }
    if (s[k + 1] === BS || s[k + 1] === "{" || s[k + 1] === "}") { text += s[k + 1]; k += 2; continue; }
    const m = /^\\([a-z]+)(-?\d+)? ?/.exec(s.slice(k));
    if (!m) { text += s[k++]; continue; }
    k += m[0].length;
    const on = m[2] !== "0", word = m[1];
    const key = { b: "b", i: "i", ul: "u", strike: "s" }[word];
    if (key) { if (fmt[key] !== on) { flush(); fmt[key] = on; } }
    else if (word === "l") bullet = true;
    // anything else (unknown control words) is dropped
  }
  flush();
  // a trailing space before a closing word is the word's delimiter in practice; trim line ends
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");
  return { runs: runs.filter(r => r.text), bullet };
}

function runHtml(r) {
  let h = esc(r.text);
  if (r.s) h = `<s>${h}</s>`;
  if (r.u) h = `<u>${h}</u>`;
  if (r.i) h = `<i>${h}</i>`;
  if (r.b) h = `<b>${h}</b>`;
  return h;
}

export function textToNote(raw) {
  const lines = (raw || "").split("\n").map(parseLine);
  while (lines.length && !lines[lines.length - 1].runs.length && !lines[lines.length - 1].bullet) lines.pop();
  let html = "", inList = false;
  for (const l of lines) {
    const inner = l.runs.map(runHtml).join("") || "<br>";
    if (l.bullet) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inner}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    html += `<div>${inner}</div>`;
  }
  if (inList) html += "</ul>";
  const text = lines.map(l => l.runs.map(r => r.text).join("")).join("\n").trim();
  return { html, text };
}

// ---------- ink ----------
function varints(b, off) {
  const out = []; let v = 0, shift = 0;
  for (let i = off; i < b.length; i++) {
    v += (b[i] & 127) * 2 ** shift; shift += 7;
    if (!(b[i] & 128)) { out.push(v); v = 0; shift = 0; }
  }
  return out;
}
const unzig = v => (v % 2 ? -(v + 1) / 2 : v / 2);

// Returns [[x, y, pressure]...] in DIPs, or null if the bytes aren't in the known layout.
export function decodeStroke(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.length < 25) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f = [0, 4, 8, 12, 16, 20].map(o => dv.getFloat32(o, false));
  if (!f.every(Number.isFinite)) return null;
  const v = varints(b, 24), n = v[0] / 2;
  if (!Number.isInteger(n) || n < 1 || v.length !== 1 + 3 * n) return null;
  const pts = []; let x = f[0], y = f[1], p = f[2];
  for (let i = 0; i < n; i++) {
    x += unzig(v[1 + 3 * i]) * f[3]; y += unzig(v[2 + 3 * i]) * f[4]; p += unzig(v[3 + 3 * i]) * f[5];
    pts.push([x, y, p]);
  }
  return pts;
}

// Sticky Notes ink sits in a window a few hundred DIPs wide; InkNotes pages are 1000 units wide.
export const STICKY_WIDTH = 360, PEN_DIP = 2.2, INK = "#1b1b1f";

// strokes: [{ data, ox, oy, angle, rx, ry }] in drawing order
export function inkToStrokes(strokes) {
  const decoded = [];
  let bad = 0;
  for (const s of strokes) {
    const pts = decodeStroke(s.data);
    if (!pts) { bad++; continue; }
    const a = (s.angle || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a), rx = s.rx || 0, ry = s.ry || 0;
    decoded.push(pts.map(([x, y, p]) => {
      if (a) { const dx = x - rx, dy = y - ry; x = rx + dx * cos - dy * sin; y = ry + dx * sin + dy * cos; }
      return [x + (s.ox || 0), y + (s.oy || 0), p];
    }));
  }
  let maxX = 0;
  for (const pts of decoded) for (const q of pts) maxX = Math.max(maxX, q[0]);
  const k = 1000 / Math.max(STICKY_WIDTH, maxX + 16);
  const out = decoded.map(pts => ({
    c: INK, w: +(PEN_DIP * k).toFixed(3), g: 1,
    pts: pts.map(([x, y, p], i) => [+(x * k).toFixed(1), +(y * k).toFixed(1), +Math.max(0, Math.min(1, p)).toFixed(3), i * 8]),
  }));
  return { strokes: out, bad };
}

// ---------- whole notes ----------
// note: { Id, Text, Theme, CreatedAt, UpdatedAt, DeletedAt }; ink as for inkToStrokes; images: [{ id }]
export function toInkNote(note, ink, images) {
  if (note.DeletedAt != null) return null;
  const { html: textHtml, text } = textToNote(note.Text);
  const { strokes, bad } = inkToStrokes(ink);
  const imgHtml = images.map(m => `<div><img data-img="${m.id}"></div>`).join("");
  if (!text && !strokes.length && !images.length) return null;
  const updated = ticksToMs(note.UpdatedAt) || ticksToMs(note.CreatedAt) || Date.now();
  return {
    note: {
      id: "sticky-" + note.Id, color: paperOf(note.Theme), html: imgHtml + (text ? textHtml : ""), text, strokes,
      created: ticksToMs(note.CreatedAt) || updated, updated, deleted: false,
    },
    badStrokes: bad,
  };
}
