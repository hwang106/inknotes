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
// drive: { list(folder, cache?) -> [{ name, etag, url? }], read(folder, name, entry?) -> Uint8Array | null,
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
// Files move a few at a time: much faster than one by one (a first sync can be hundreds of files),
// and gentle enough on OneDrive's rate limits.
const AT_ONCE = 6;
async function eachAtOnce(items, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
}

// imagesOf(record): ids of the images a record shows (InkBoard boards list theirs differently).
export async function syncOnce({ drive, local, key, state, folder = "notes", images = true, check = null, onProgress = () => {}, imagesOf: imgs = imagesOf }) {
  state.notes = state.notes || {}; state.images = state.images || {};
  const result = { pulled: [], pushed: 0, conflicts: 0 };

  const remote = new Map();
  state.listing = state.listing || {};   // lets the drive fetch only what changed since last time
  // check (optional): runs alongside the listing and may throw to stop the pass before any upload.
  const [listing] = await Promise.all([drive.list(folder, state.listing), check ? check() : null]);
  for (const e of listing) {
    const m = /^(.+)\.json$/.exec(e.name);
    if (m) remote.set(m[1], e);
  }

  // Push: records edited here since they were last uploaded or downloaded. Run twice: first for
  // edits that can't clash with OneDrive (so a big download never holds up what was just changed
  // here), then, after pulling, for the rest.
  const clashed = new Set();
  async function push(safeOnly) {
    const toPush = (await local.all()).filter(l => {
      if (localOnly(l) || clashed.has(l.id)) return false;
      const known = state.notes[l.id], e = remote.get(l.id);
      if (known && known.updated >= l.updated) return false;
      if (!safeOnly) return true;
      return e ? !!known && known.etag === e.etag : !known;   // unchanged in OneDrive, or new
    });
    let pushed = 0;
    await eachAtOnce(toPush, async l => {
      const known = state.notes[l.id];
      onProgress(toPush.length > 1 ? `Uploading ${++pushed} of ${toPush.length}` : "Uploading");
      if (images) for (const imgId of imgs(l)) {
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
        if (remote.has(l.id)) remote.set(l.id, { ...remote.get(l.id), etag });   // don't download our own upload
        result.pushed++;
      } catch (err) {
        if (err.status !== 412) throw err;
        clashed.add(l.id);
        result.conflicts++;   // another device saved it a moment ago; the next pass sorts it out
      }
    });
  }

  await push(true);

  // Pull: records that changed in OneDrive since this device last looked.
  const toPull = [...remote].filter(([id, e]) => !(state.notes[id] && state.notes[id].etag === e.etag));
  let pulled = 0;
  await eachAtOnce(toPull, async ([id, e]) => {
    const bytes = await drive.read(folder, e.name, e);
    onProgress(toPull.length > 1 ? `Downloading ${++pulled} of ${toPull.length}` : "Downloading");
    if (!bytes) return;
    const r = await unsealJSON(key, bytes, folder + "/" + e.name);
    if (!r || r.id !== id) return;
    const l = await local.get(id);   // read fresh: it may have been edited while this runs
    if (!(l && l.updated >= r.updated)) {   // otherwise this device's copy is newer: it uploads below
      if (images) await pullImages(r);
      await local.put(r);
      result.pulled.push(id);
    }
    state.notes[id] = { etag: e.etag, updated: r.updated };
  });

  async function pullImages(n) {
    for (const imgId of imgs(n)) {
      if (await local.getImage(imgId)) { state.images[imgId] = true; continue; }
      const name = imgId + ".bin";
      const bytes = await drive.read("images", name);
      if (!bytes) continue;   // not uploaded (yet); the note shows a placeholder
      await local.putImage(imgId, new Blob([await unseal(key, bytes, "images/" + name)]));
      state.images[imgId] = true;
    }
  }

  await push(false);
  return result;
}
