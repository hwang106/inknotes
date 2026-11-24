// Checks the Windows Sticky Notes converter. Run: node test/sticky.test.mjs
import assert from "node:assert/strict";
import { textToNote, decodeStroke, inkToStrokes, toInkNote, ticksToMs, paperOf } from "../tools/sticky-notes/convert.mjs";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };
const B = "\\";

// Builds stroke bytes in the Sticky Notes layout, to check decoding against known points.
function encodeStroke(pts, step = [0.04, 0.04, 1 / 4096]) {
  const head = new DataView(new ArrayBuffer(24));
  [pts[0][0], pts[0][1], pts[0][2], ...step].forEach((v, i) => head.setFloat32(i * 4, v, false));
  const bytes = [...new Uint8Array(head.buffer)];
  const varint = v => { do { let b = v & 127; v = Math.floor(v / 128); if (v) b |= 128; bytes.push(b); } while (v); };
  const zig = v => (v < 0 ? -2 * v - 1 : 2 * v);
  varint(pts.length * 2);
  let prev = pts[0];
  pts.forEach((q, i) => {
    const d = i === 0 ? [0, 0, 0] : [0, 1, 2].map(k => Math.round((q[k] - prev[k]) / step[k]));
    d.forEach(x => varint(zig(x))); if (i) prev = [0, 1, 2].map(k => prev[k] + d[k] * step[k]);
  });
  return new Uint8Array(bytes);
}

test("paragraph ids are removed and lines become divs", () => {
  const r = textToNote(`${B}id=aaa Groceries\n${B}id=localId_bbb \n${B}id=ccc Eggs & <milk>`);
  assert.equal(r.html, "<div>Groceries</div><div><br></div><div>Eggs &amp; &lt;milk&gt;</div>");
  assert.equal(r.text, "Groceries\n\nEggs & <milk>");
});

test("strikethrough, bold and bullets carry over", () => {
  const r = textToNote(`${B}id=a${B}strike 1) Yansen${B}strike0 \n${B}id=b${B}l GC sync\n${B}id=c${B}b Big${B}b0  deal`);
  assert.equal(r.html, "<div><s>1) Yansen</s></div><ul><li>GC sync</li></ul><div><b>Big</b> deal</div>");
  assert.equal(r.text, "1) Yansen\nGC sync\nBig deal");
});

test("an escaped backslash stays as text", () => {
  assert.equal(textToNote(`${B}id=a C:${B}${B}Users`).text, `C:${B}Users`);
});

test("ink decodes to the points it was made from", () => {
  const pts = [[30, 80, 0.2], [30.4, 81.2, 0.25], [29.96, 83, 0.3], [31, 85.04, 0.1]];
  const got = decodeStroke(encodeStroke(pts));
  assert.equal(got.length, 4);
  got.forEach((q, i) => q.forEach((v, k) => assert.ok(Math.abs(v - pts[i][k]) < 0.02, `point ${i}`)));
  assert.equal(decodeStroke(new Uint8Array([1, 2, 3])), null);
});

test("ink scales to InkNotes' 1000-unit page", () => {
  const { strokes, bad } = inkToStrokes([
    { data: encodeStroke([[36, 10, 0.5], [72, 10, 0.5]]) },
    { data: new Uint8Array(30) },   // unknown layout: skipped, counted
  ]);
  assert.equal(bad, 1);
  assert.equal(strokes.length, 1);
  assert.deepEqual(strokes[0].pts.map(q => q[0]), [100, 200]);   // 360 DIPs wide -> x 2.78
  assert.ok(strokes[0].w > 5 && strokes[0].w < 7);
});

test("whole note: ids, colour, times, images first, empty notes dropped", () => {
  const t = 638901245384619090n;
  const r = toInkNote({ Id: "g1", Text: `${B}id=a Hi`, Theme: "Pink", CreatedAt: t, UpdatedAt: t, DeletedAt: null }, [], [{ id: "sticky-m1" }]);
  assert.equal(r.note.id, "sticky-g1");
  assert.equal(r.note.color, "pink");
  assert.equal(r.note.html, '<div><img data-img="sticky-m1"></div><div>Hi</div>');
  assert.equal(new Date(r.note.updated).getUTCFullYear(), 2025);
  assert.equal(toInkNote({ Id: "g2", Text: `${B}id=a `, Theme: "Yellow", CreatedAt: t, UpdatedAt: t, DeletedAt: null }, [], []), null);
  assert.equal(toInkNote({ Id: "g3", Text: "x", Theme: "Yellow", CreatedAt: t, UpdatedAt: t, DeletedAt: t }, [], []), null);
  assert.equal(paperOf("Charcoal"), "gray");
  assert.equal(ticksToMs(621355968000000000n), 0);
});

console.log(`\n${passed} tests passed`);
