// Tests the sync pass and encryption with two pretend devices and a pretend OneDrive.
// Run: node test/sync.test.mjs
import assert from "node:assert/strict";
import { syncOnce } from "../app/js/sync-engine.js";
import { newKeyFile, keyFromFile, sealJSON, unsealJSON } from "../app/js/crypt.js";

function fakeDrive() {
  const files = new Map();   // "folder/name" -> { bytes, etag }
  let n = 0;
  const drive = {
    files, writes: 0, beforeWrite: null,
    async list(folder) {
      return [...files].filter(([p]) => p.startsWith(folder + "/")).map(([p, f]) => ({ name: p.slice(folder.length + 1), etag: f.etag }));
    },
    async read(folder, name) { const f = files.get(folder + "/" + name); return f ? f.bytes.slice() : null; },
    async write(folder, name, bytes, ifMatch) {
      if (drive.beforeWrite) { const h = drive.beforeWrite; drive.beforeWrite = null; await h(); }
      const p = folder + "/" + name, f = files.get(p);
      if (ifMatch && (!f || f.etag !== ifMatch)) { const e = new Error("Precondition failed"); e.status = 412; throw e; }
      const etag = `"e${++n}"`; files.set(p, { bytes: bytes.slice(), etag }); drive.writes++;
      return { etag };
    },
  };
  return drive;
}
function fakeDevice() {
  const notes = new Map(), images = new Map();
  const c = o => structuredClone(o);
  return {
    notes, images, state: { notes: {}, images: {} },
    allNotes: async () => [...notes.values()].map(c),
    getNote: async id => (notes.has(id) ? c(notes.get(id)) : undefined),
    putNote: async n => { notes.set(n.id, c(n)); },
    getImage: async id => images.get(id) || null,
    putImage: async (id, blob) => { images.set(id, blob); },
    get all() { return this.allNotes; }, get get() { return this.getNote; }, get put() { return this.putNote; },
  };
}
const note = (id, text, t, extra = {}) => ({ id, color: "yellow", html: `<div>${text}</div>`, text, strokes: [{ c: "#000", w: 2, g: 1, pts: [[1, 2, .5, 0], [3, 4, .6, 8]] }], created: t, updated: t, deleted: false, ...extra });

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok -", name); }

const { key, file } = await newKeyFile("correct horse battery");
const run = (dev, drive) => syncOnce({ drive, local: dev, key, state: dev.state });

await test("passphrase check", async () => {
  assert.ok(await keyFromFile("correct horse battery", file));
  assert.equal(await keyFromFile("wrong", file), null);
});

await test("ciphertext is bound to its file name and can't be read without the key", async () => {
  const sealed = await sealJSON(key, { secret: "milk" }, "notes/a.json");
  assert.ok(!Buffer.from(sealed).toString("latin1").includes("milk"));
  assert.deepEqual(await unsealJSON(key, sealed, "notes/a.json"), { secret: "milk" });
  await assert.rejects(unsealJSON(key, sealed, "notes/b.json"));
  const other = (await newKeyFile("correct horse battery")).key;   // same passphrase, new salt
  await assert.rejects(unsealJSON(other, sealed, "notes/a.json"));
});

const drive = fakeDrive();
const A = fakeDevice(), B = fakeDevice();

await test("notes and images go from device A to device B", async () => {
  const img = new Blob([new Uint8Array([1, 2, 3, 4, 250])]);
  A.images.set("img1", img);
  await A.putNote(note("n1", "Groceries", 100, { html: '<div>Groceries</div><img data-img="img1">' }));
  await A.putNote(note("n2", "Ideas", 110));
  await A.putNote(note("w1", "Welcome", 50, { welcome: true }));
  const ra = await run(A, drive);
  assert.equal(ra.pushed, 2, "welcome note stays local");
  assert.ok(drive.files.has("images/img1.bin"));
  const rb = await run(B, drive);
  assert.deepEqual(rb.pulled.sort(), ["n1", "n2"]);
  assert.deepEqual(B.notes.get("n1"), A.notes.get("n1"));
  assert.deepEqual([...new Uint8Array(await B.images.get("img1").arrayBuffer())], [1, 2, 3, 4, 250]);
});

await test("a second pass with no changes does nothing", async () => {
  const w = drive.writes;
  const r1 = await run(A, drive), r2 = await run(B, drive);
  assert.equal(r1.pushed + r2.pushed + r1.pulled.length + r2.pulled.length, 0);
  assert.equal(drive.writes, w);
});

await test("an edit on B reaches A", async () => {
  await B.putNote({ ...B.notes.get("n1"), text: "Groceries + eggs", updated: 200 });
  await run(B, drive); const r = await run(A, drive);
  assert.deepEqual(r.pulled, ["n1"]); assert.equal(A.notes.get("n1").text, "Groceries + eggs");
});

await test("both edit the same note: the later edit wins on both", async () => {
  await A.putNote({ ...A.notes.get("n2"), text: "Ideas (A)", updated: 300 });
  await B.putNote({ ...B.notes.get("n2"), text: "Ideas (B, later)", updated: 310 });
  await run(A, drive); await run(B, drive); await run(A, drive);
  assert.equal(A.notes.get("n2").text, "Ideas (B, later)");
  assert.equal(B.notes.get("n2").text, "Ideas (B, later)");
  // and the other way round: the earlier edit syncs last but still loses
  await A.putNote({ ...A.notes.get("n2"), text: "Ideas (A, later)", updated: 410 });
  await B.putNote({ ...B.notes.get("n2"), text: "Ideas (B)", updated: 400 });
  await run(A, drive); await run(B, drive); await run(A, drive);
  assert.equal(A.notes.get("n2").text, "Ideas (A, later)");
  assert.equal(B.notes.get("n2").text, "Ideas (A, later)");
});

await test("a deletion reaches the other device", async () => {
  await A.putNote({ ...A.notes.get("n1"), deleted: true, updated: 500 });
  await run(A, drive); await run(B, drive);
  assert.equal(B.notes.get("n1").deleted, true);
});

await test("another device saving mid-upload is caught, then resolved next pass", async () => {
  await A.putNote({ ...A.notes.get("n2"), text: "A edit", updated: 600 });
  drive.beforeWrite = async () => {   // B uploads a newer edit between A's listing and A's upload
    await B.putNote({ ...B.notes.get("n2"), text: "B edit", updated: 610 }); await run(B, drive);
  };
  const r = await run(A, drive);
  assert.equal(r.conflicts, 1);
  await run(A, drive);
  assert.equal(A.notes.get("n2").text, "B edit");
});

await test("a new device with its own notes merges instead of replacing", async () => {
  const C = fakeDevice();
  await C.putNote(note("c1", "From C", 700));
  await run(C, drive);
  assert.deepEqual([...C.notes.keys()].sort(), ["c1", "n1", "n2"]);
  await run(A, drive); assert.ok(A.notes.has("c1"));
});

await test("the drive only ever holds ciphertext", async () => {
  for (const [, f] of drive.files) {
    const s = Buffer.from(f.bytes).toString("latin1");
    assert.ok(!/Groceries|Ideas|From C|yellow|strokes/.test(s));
  }
});

await test("tasks sync in their own folder, alongside notes", async () => {
  const T1 = fakeDevice(), T2 = fakeDevice();
  const runT = dev => syncOnce({ drive, local: dev, key, state: dev.state, folder: "todo", images: false });
  await T1.putNote({ id: "inbox", kind: "list", name: "Tasks", created: 0, updated: 0, welcome: true });
  await T1.putNote({ id: "t1", kind: "task", listId: "inbox", title: "Buy milk", done: false, created: 5, updated: 5 });
  const r = await runT(T1);
  assert.equal(r.pushed, 1, "default list stays local");
  assert.ok(drive.files.has("todo/t1.json"));
  await runT(T2);
  assert.equal(T2.notes.get("t1").title, "Buy milk");
  await T2.putNote({ ...T2.notes.get("t1"), done: true, updated: 9 });
  await runT(T2); await runT(T1);
  assert.equal(T1.notes.get("t1").done, true);
  assert.ok(![...T1.notes.keys()].some(id => id.startsWith("n")), "notes don't leak into tasks");
});

console.log(`\n${passed} tests passed`);
