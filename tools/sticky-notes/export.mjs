// Reads Windows Sticky Notes on this PC and writes a file InkNotes can import
// (open /inknotes/import.html and choose the file).
// Run: node tools/sticky-notes/export.mjs [output.json]
// It works on a copy of the database, so Sticky Notes can stay open and nothing in it changes.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { toInkNote } from "./convert.mjs";

const SRC = join(process.env.LOCALAPPDATA || "", "Packages", "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe", "LocalState");
const out = resolve(process.argv[2] || "sticky-notes.inknotes-import.json");
if (!existsSync(join(SRC, "plum.sqlite"))) { console.error("Sticky Notes database not found at", SRC); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "sticky-"));
for (const f of ["plum.sqlite", "plum.sqlite-wal", "plum.sqlite-shm"]) if (existsSync(join(SRC, f))) copyFileSync(join(SRC, f), join(tmp, f));
const db = new DatabaseSync(join(tmp, "plum.sqlite"));
const all = sql => { const p = db.prepare(sql); p.setReadBigInts(true); return p.all(); };

const strokesByNote = new Map(), metaByStroke = new Map(), mediaByNote = new Map();
for (const m of all("select * from StrokeMetadata where DeletedAt is null")) metaByStroke.set(m.StrokeId, m);
for (const s of all("select rowid r, * from Stroke where DeletedAt is null order by CreatedAt, r")) {
  const m = metaByStroke.get(s.Id) || {};
  const list = strokesByNote.get(s.ParentId) || [];
  list.push({ data: s.Data, ox: m.OffsetX, oy: m.OffsetY, angle: m.OffsetAngle, rx: m.RotationPointX, ry: m.RotationPointY });
  strokesByNote.set(s.ParentId, list);
}
const images = [], missing = [];
for (const m of all("select * from Media where DeletedAt is null")) {
  const file = join(SRC, "media", String(m.LocalFileRelativePath || "").replace(/^ms-appdata:\/\/\/local\/media\//, ""));
  if (!existsSync(file)) { missing.push(file); continue; }
  const id = "sticky-" + m.Id;
  images.push({ id, type: m.MimeType || "image/png", data: readFileSync(file).toString("base64") });
  const list = mediaByNote.get(m.ParentId) || [];
  list.push({ id });
  mediaByNote.set(m.ParentId, list);
}

const notes = []; let skipped = 0, badStrokes = 0;
for (const n of all("select * from Note")) {
  const ink = (strokesByNote.get(n.Id) || []).map(s => ({ ...s, ox: Number(s.ox || 0), oy: Number(s.oy || 0), angle: Number(s.angle || 0), rx: Number(s.rx || 0), ry: Number(s.ry || 0) }));
  const r = toInkNote(n, ink, mediaByNote.get(n.Id) || []);
  if (!r) { skipped++; continue; }
  notes.push(r.note); badStrokes += r.badStrokes;
}
db.close(); rmSync(tmp, { recursive: true, force: true });

const used = new Set(notes.flatMap(n => [...n.html.matchAll(/data-img="([^"]+)"/g)].map(m => m[1])));
const payload = { kind: "inknotes-import", source: "Windows Sticky Notes", version: 1, notes, images: images.filter(i => used.has(i.id)) };
writeFileSync(out, JSON.stringify(payload));
const inked = notes.filter(n => n.strokes.length).length;
console.log(`${notes.length} notes (${inked} handwritten, ${payload.images.length} images); ${skipped} empty or deleted notes left out.`);
if (badStrokes) console.log(`${badStrokes} ink strokes were in an unknown format and were left out.`);
if (missing.length) console.log(`${missing.length} image files were missing.`);
console.log("Wrote", out);
