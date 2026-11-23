// On-device storage (IndexedDB). Falls back to memory if the browser blocks storage, so the
// app still works for the session.
//
// notes:  { id, color, html, text, strokes: [{ c, w, g, pts }], created, updated, deleted }
//         `html` holds typed text and <img data-img="id"> placeholders; `text` is a plain copy
//         for search and previews. Deleted notes stay as tombstones (deleted: true) so a later
//         OneDrive sync can pass deletions to other devices.
// images: { id, blob } — pasted images, stored apart from the note so notes stay small.
// meta:   small values for OneDrive sync (the encryption key, what was last synced).

const DB_NAME = "inknotes", DB_VERSION = 3;
let dbPromise = null;
let memory = null;
const hooks = { onBlocked() {}, onUnblocked() {}, onVersionChange() {} };   // { notes: Map, images: Map, meta: Map } when IndexedDB is unavailable

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version of the app (in another window) needs to upgrade storage: step aside.
      db.onversionchange = () => { db.close(); dbPromise = null; hooks.onVersionChange(); };
      hooks.onUnblocked();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => hooks.onBlocked();   // an older window still has storage open; waits for it
  }).catch(err => {
    console.warn("InkNotes: on-device storage unavailable; notes last only this session.", err);
    memory = { notes: new Map(), images: new Map(), meta: new Map() };
    return null;
  });
  return dbPromise;
}

function run(storeName, mode, fn, memFn) {
  return open().then(db => {
    if (!db) return memFn(memory[storeName]);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}

const clone = o => JSON.parse(JSON.stringify(o));

export const store = {
  allNotes: () => run("notes", "readonly", s => s.getAll(), m => [...m.values()].map(clone)),
  getNote: id => run("notes", "readonly", s => s.get(id), m => (m.has(id) ? clone(m.get(id)) : undefined)),
  putNote: note => {
    const copy = clone(note);
    return run("notes", "readwrite", s => s.put(copy), m => { m.set(copy.id, copy); });
  },
  putImage: (id, blob) => run("images", "readwrite", s => s.put({ id, blob }), m => { m.set(id, { id, blob }); }),
  getImage: id => run("images", "readonly", s => s.get(id), m => m.get(id)).then(r => (r ? r.blob : null)),
  getMeta: k => run("meta", "readonly", s => s.get(k), m => m.get(k)),
  setMeta: (k, v) => run("meta", "readwrite", s => s.put(v, k), m => { m.set(k, v); }),
  deleteMeta: k => run("meta", "readwrite", s => s.delete(k), m => { m.delete(k); }),
  hooks,
  get persistent() { return !memory; },
};
