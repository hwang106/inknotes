// One-time import of notes from a file (made by tools/sticky-notes/export.mjs).
// Notes keep ids derived from their source, so a second run skips what's already here,
// including notes deleted since (their tombstones stay, so they don't come back).
import { store } from "./store.js";

const $ = id => document.getElementById(id);
const channel = "BroadcastChannel" in window ? new BroadcastChannel("inknotes") : null;
let payload = null, fresh = [];

function fromB64(s, type) {
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

$("pick").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  $("status").textContent = ""; $("status").className = "";
  try {
    payload = JSON.parse(await file.text());
    if (payload.kind !== "inknotes-import" || !Array.isArray(payload.notes)) throw new Error("not an import file");
  } catch (_) {
    payload = null; $("facts").hidden = true; $("go").hidden = true;
    $("status").textContent = "That file isn't an InkNotes import file."; $("status").className = "err";
    return;
  }
  const have = await Promise.all(payload.notes.map(n => store.getNote(n.id)));
  fresh = payload.notes.filter((_, i) => !have[i]);
  const inked = fresh.filter(n => n.strokes && n.strokes.length).length;
  const imgs = fresh.reduce((k, n) => k + (n.html.match(/data-img=/g) || []).length, 0);
  $("facts").innerHTML = "";
  for (const line of [
    `From <b>${payload.source || "another app"}</b>`,
    `<b>${plural(fresh.length, "new note")}</b>: ${inked} handwritten, ${plural(imgs, "image")}`,
    payload.notes.length - fresh.length ? `${plural(payload.notes.length - fresh.length, "note")} already imported (skipped)` : "",
  ].filter(Boolean)) { const li = document.createElement("li"); li.innerHTML = line; $("facts").append(li); }
  $("facts").hidden = false;
  $("go").hidden = !fresh.length;
  $("go").textContent = `Import ${plural(fresh.length, "note")}`;
  if (!fresh.length) $("status").textContent = "Nothing new to import.";
});

$("go").addEventListener("click", async () => {
  $("go").disabled = true; $("pickLabel").hidden = true;
  const bar = $("bar"); bar.hidden = false; bar.max = fresh.length; bar.value = 0;
  const images = new Map((payload.images || []).map(i => [i.id, i]));
  try {
    for (const n of fresh) {
      for (const m of n.html.matchAll(/data-img="([^"]+)"/g)) {
        const img = images.get(m[1]);
        if (img) await store.putImage(img.id, fromB64(img.data, img.type));
      }
      await store.putNote({ ...n, strokes: n.strokes || [] });
      if (channel) channel.postMessage({ type: "changed", id: n.id, from: "import" });
      bar.value++;
    }
  } catch (err) {
    $("status").textContent = `Stopped after ${bar.value} notes: ${err.message}. Choose the file again to finish; imported notes are skipped.`;
    $("status").className = "err"; $("pickLabel").hidden = false; return;
  }
  $("go").hidden = true; $("open").hidden = false;
  $("status").textContent = `Imported ${plural(fresh.length, "note")}. If you're signed in to OneDrive, they upload on the next sync.`;
});
