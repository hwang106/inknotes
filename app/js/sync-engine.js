// One sync pass between this device and the OneDrive app folder. Kept free of browser and Graph
// details so it can be tested with a pretend drive. Used by InkNotes (folder "notes", with images)
// and InkTasks (folder "todo", lists and tasks).
//
// OneDrive app folder layout (every file sealed with crypt.js):
//   key.json            salt + passphrase check (not secret)
//   notes/<id>.json     one note
//   images/<id>.bin     one pasted image (images never change, so each uploads once)
//   todo/<id>.json      one task list or task
//
// drive: { list(folder) -> [{ name, etag, url? }], read(folder, name, entry?) -> Uint8Array | null,
//          write(folder, name, bytes, ifMatch?) -> { etag }  (throws err.status 412 on a stale ifMatch) }
// local: { all(), get(id), put(record), getImage?(id) -> Blob | null, putImage?(id, blob) }
// state: { notes: { id: { etag, updated } }, images: { id: true } }  — what was last seen in OneDrive.
//        (`notes` holds every record of the folder, whatever kind it is.)
//
// Records are { id, updated, deleted?, ... }. Conflicts: per record, the most recent edit wins (by
// `updated`). Deleting is an edit too (a tombstone), so a deletion reaches other devices.

import { seal, unseal, sealJSON, unsealJSON } from "./crypt.js";

export const imagesOf = n => [...(n.html || "").matchAll(/data-img="([^"]+)"/g)].map(m => m[1]);
// Starter records each device makes (welcome note, default task list) stay local until edited.
const localOnly = n => n.welcome && n.updated === n.created;

export async function syncOnce({ drive, local, key, state, folder = "notes", images = true, onProgress = () => {} }) {
  state.notes = state.notes || {}; state.images = state.images || {};
  const result = { pulled: [], pushed: 0, conflicts: 0 };

  const remote = new Map();
  for (const e of await drive.list(folder)) {
    const m = /^(.+)\.json$/.exec(e.name);
    if (m) remote.set(m[1], e);
  }

  // Pull: records that changed in OneDrive since this device last looked.
  for (const [id, e] of remote) {
    const known = state.notes[id];
    if (known && known.etag === e.etag) continue;
    onProgress("Downloading");
    const bytes = await drive.read(folder, e.name, e);
    if (!bytes) continue;
    const r = await unsealJSON(key, bytes, folder + "/" + e.name);
    if (!r || r.id !== id) continue;
    state.notes[id] = { etag: e.etag, updated: r.updated };
    const l = await local.get(id);   // read fresh: it may have been edited while this runs
    if (l && l.updated >= r.updated) continue;   // this device's copy is newer: it uploads below
    if (images) await pullImages(r);
    await local.put(r);
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

  // Push: records edited here since they were last uploaded or downloaded.
  for (const l of await local.all()) {
    const known = state.notes[l.id];
    if (localOnly(l) || (known && known.updated >= l.updated)) continue;
    onProgress("Uploading");
    if (images) for (const imgId of imagesOf(l)) {
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
      const { etag } = await drive.write(folder, name, await sealJSON(key, l, folder + "/" + name), ifMatch);
      state.notes[l.id] = { etag, updated: l.updated };
      result.pushed++;
    } catch (err) {
      if (err.status !== 412) throw err;
      result.conflicts++;   // another device saved it a moment ago; the next pass sorts it out
    }
  }
  return result;
}
