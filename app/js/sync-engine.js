// One sync pass between this device and the OneDrive app folder. Kept free of browser and Graph
// details so it can be tested with a pretend drive.
//
// OneDrive app folder layout (every file sealed with crypt.js):
//   key.json            salt + passphrase check (not secret)
//   notes/<id>.json     one note
//   images/<id>.bin     one pasted image (images never change, so each uploads once)
//
// drive: { list(folder) -> [{ name, etag, url? }], read(folder, name, entry?) -> Uint8Array | null,
//          write(folder, name, bytes, ifMatch?) -> { etag }  (throws err.status 412 on a stale ifMatch) }
// local: { allNotes(), getNote(id), putNote(note), getImage(id) -> Blob | null, putImage(id, blob) }
// state: { notes: { id: { etag, updated } }, images: { id: true } }  — what was last seen in OneDrive.
//
// Conflicts: per note, the most recent edit wins (by its `updated` time). Deleting is an edit too
// (a tombstone), so a deletion reaches other devices.

import { seal, unseal, sealJSON, unsealJSON } from "./crypt.js";

export const imagesOf = n => [...(n.html || "").matchAll(/data-img="([^"]+)"/g)].map(m => m[1]);
// The welcome note each device makes on first run stays local until it is edited.
const localOnly = n => n.welcome && n.updated === n.created;

export async function syncOnce({ drive, local, key, state, onProgress = () => {} }) {
  state.notes = state.notes || {}; state.images = state.images || {};
  const result = { pulled: [], pushed: 0, conflicts: 0 };

  const remote = new Map();
  for (const e of await drive.list("notes")) {
    const m = /^(.+)\.json$/.exec(e.name);
    if (m) remote.set(m[1], e);
  }

  // Pull: notes that changed in OneDrive since this device last looked.
  for (const [id, e] of remote) {
    const known = state.notes[id];
    if (known && known.etag === e.etag) continue;
    onProgress("Downloading notes");
    const bytes = await drive.read("notes", e.name, e);
    if (!bytes) continue;
    const r = await unsealJSON(key, bytes, "notes/" + e.name);
    if (!r || r.id !== id) continue;
    r.strokes = r.strokes || [];
    state.notes[id] = { etag: e.etag, updated: r.updated };
    const l = await local.getNote(id);   // read fresh: it may have been edited while this runs
    if (l && l.updated >= r.updated) continue;   // this device's copy is newer: it uploads below
    await pullImages(r);
    await local.putNote(r);
    result.pulled.push(id);
  }

  async function pullImages(n) {
    for (const imgId of imagesOf(n)) {
      if (await local.getImage(imgId)) { state.images[imgId] = true; continue; }
      const name = imgId + ".bin";
      const bytes = await drive.read("images", name);
      if (!bytes) continue;   // not uploaded (yet); the note shows a placeholder
      await local.putImage(imgId, new Blob([await unseal(key, bytes, "images/" + name)]));
      state.images[imgId] = true;
    }
  }

  // Push: notes edited here since they were last uploaded or downloaded.
  for (const l of await local.allNotes()) {
    const known = state.notes[l.id];
    if (localOnly(l) || (known && known.updated >= l.updated)) continue;
    onProgress("Uploading notes");
    for (const imgId of imagesOf(l)) {
      if (state.images[imgId]) continue;
      const blob = await local.getImage(imgId);
      if (!blob) continue;
      const name = imgId + ".bin";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await drive.write("images", name, await seal(key, bytes, "images/" + name, { compress: false }));
      state.images[imgId] = true;
    }
    const name = l.id + ".json";
    const ifMatch = known && remote.has(l.id) ? known.etag : null;
    try {
      const { etag } = await drive.write("notes", name, await sealJSON(key, l, "notes/" + name), ifMatch);
      state.notes[l.id] = { etag, updated: l.updated };
      result.pushed++;
    } catch (err) {
      if (err.status !== 412) throw err;
      result.conflicts++;   // another device saved it a moment ago; the next pass sorts it out
    }
  }
  return result;
}
