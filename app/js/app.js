import { InkSurface, INKS, W, drawStroke, IS_ANDROID, inkBottom, smoothPx } from "./ink.js";
import { store } from "./store.js";
import { createSync } from "./sync.js";
import { mountSyncUI } from "./sync-ui.js";

// Every element with an id, captured once. (The note view can move into a floating
// always-on-top window, where document.getElementById would no longer find it.)
const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(e => [e.id, e]));
const { app, noteView, editorPane, page, scroller, body, cards } = el;

const PAPERS = ["yellow", "green", "pink", "blue", "purple", "gray"];
const INK_NAMES = ["Black", "Blue", "Red", "Green", "Purple"];
const SETTINGS_KEY = "inknotes-settings-v1";
const WINDOW_SIZE_KEY = "inknotes-window-size";
const PIP_SIZE_KEY = "inknotes-ontop-size";

const params = new URLSearchParams(location.search);
const windowNoteId = params.get("note");           // set when this window shows a single note
app.dataset.mode = windowNoteId ? "note" : "main";

const IS_MOBILE = IS_ANDROID || /iPhone|iPad|iPod/.test(navigator.userAgent);
const CAN_POPOUT = !IS_MOBILE && !windowNoteId;
const CAN_PIN = !IS_MOBILE && "documentPictureInPicture" in window;
el.popout.hidden = !CAN_POPOUT;
el.pin.hidden = !CAN_PIN;

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const windowId = uid();
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (_) { return {}; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} }

// Pen settings are per device (the Surface and the S25 Ultra want different smoothing).
const settings = {
  color: INKS[0], size: 2.5, curve: 50, smooth: IS_ANDROID ? 0 : 60, touchInk: false, penText: false,
  ...readJSON(SETTINGS_KEY), eraser: false,
};
const saveSettings = () => { const { eraser, ...keep } = settings; writeJSON(SETTINGS_KEY, keep); };

const notes = new Map();
let current = null, query = "";
const imageUrls = new Map();
const channel = "BroadcastChannel" in window ? new BroadcastChannel("inknotes") : null;

const surface = new InkSurface({
  page, scroller, canvas: el.ink, settings: () => settings,
  onCommit: () => { if (current) { changed(current); layoutSoon(); } },
  onInkStart: () => { if (body.ownerDocument.activeElement === body) body.blur(); },   // hide the keyboard while writing
});

// ---------- helpers ----------
const paperColor = name => getComputedStyle(document.documentElement).getPropertyValue("--paper-" + name).trim() || "#fff1a8";
function titleOf(n) {
  const line = (n.text || "").split("\n").map(s => s.trim()).find(Boolean);
  if (line) return line;
  if (n.strokes.length) return "Handwritten note";
  if ((n.html || "").includes("<img")) return "Image note";
  return "Empty note";
}
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
const escapeText = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---------- saving ----------
const saveTimers = new Map();
function changed(n) {
  n.updated = Date.now();
  clearTimeout(saveTimers.get(n.id));
  saveTimers.set(n.id, setTimeout(() => persist(n), 300));
  listSoon();
}
async function persist(n) {
  clearTimeout(saveTimers.get(n.id)); saveTimers.delete(n.id);
  try {
    await store.putNote(n);
    if (channel) channel.postMessage({ type: "changed", id: n.id, from: windowId });
    sync.soon();
  } catch (err) {
    toast("Couldn't save this note on the device. Check that the browser allows site storage.");
  }
}
function flushSaves() {
  const pending = [...saveTimers.keys()].map(id => notes.get(id)).filter(Boolean);
  return Promise.all(pending.map(persist));
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSaves(); });
addEventListener("pagehide", () => { flushSaves(); });

// ---------- note body: typed text + images ----------
const ALLOWED = new Set(["DIV", "P", "BR", "B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "IMG", "SPAN"]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "TEMPLATE", "SVG", "MATH"]);
function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1 || DROP.has(child.tagName.toUpperCase())) { child.remove(); continue; }
    cleanNode(child);
    if (!ALLOWED.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
    for (const a of [...child.attributes]) if (!(child.tagName === "IMG" && a.name === "data-img")) child.removeAttribute(a.name);
    if (child.tagName === "IMG" && !child.getAttribute("data-img")) child.remove();
  }
}
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";
  cleanNode(root);
  return root.innerHTML;
}
function serializeBody() {
  const c = body.cloneNode(true);
  c.querySelectorAll("img").forEach(i => { i.removeAttribute("src"); i.removeAttribute("class"); i.removeAttribute("alt"); });
  return sanitize(c.innerHTML);
}
function renderBody(n) {
  body.innerHTML = sanitize(n.html != null ? n.html : escapeText(n.text || ""));
  hydrateImages();
}
async function hydrateImages() {
  for (const img of body.querySelectorAll("img[data-img]")) {
    if (img.getAttribute("src")) continue;
    const id = img.dataset.img;
    let url = imageUrls.get(id);
    if (!url) {
      img.classList.add("loading");
      const blob = await store.getImage(id);
      if (!blob) { img.alt = "Image not found on this device"; continue; }
      url = URL.createObjectURL(blob); imageUrls.set(id, url);
    }
    img.addEventListener("load", () => { img.classList.remove("loading"); layoutSoon(); }, { once: true });
    img.src = url;
  }
}
function placeCaretEnd() {
  const doc = body.ownerDocument;
  body.focus();
  const r = doc.createRange(); r.selectNodeContents(body); r.collapse(false);
  const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function ensureCaretInBody() {
  const s = body.ownerDocument.getSelection();
  if (!s || !s.rangeCount || !body.contains(s.anchorNode)) placeCaretEnd(); else body.focus();
}
async function shrinkImage(file, max = 1600) {
  if (!("createImageBitmap" in window)) return file;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 1.5e6) { if (bmp.close) bmp.close(); return file; }
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise(res => c.toBlob(res, "image/webp", 0.9));
  return blob || file;
}
async function insertImages(files) {
  if (!current) return;
  const doc = body.ownerDocument;
  ensureCaretInBody();
  for (const f of files) {
    try {
      const blob = await shrinkImage(f);
      const id = uid();
      await store.putImage(id, blob);
      const url = URL.createObjectURL(blob); imageUrls.set(id, url);
      doc.execCommand("insertHTML", false, `<img data-img="${id}" src="${url}" alt="">`);
    } catch (err) {
      toast("Couldn't add that image. Try a PNG or JPEG.");
    }
  }
  body.querySelectorAll("img").forEach(i => { if (!i.complete) i.addEventListener("load", layoutSoon, { once: true }); });
  layoutSoon();
}

body.addEventListener("input", () => {
  if (!current) return;
  if (!body.innerText.trim() && !body.querySelector("img")) body.innerHTML = "";   // brings the placeholder back
  current.html = serializeBody();
  current.text = body.innerText.replace(/\n{3,}/g, "\n\n").trim();
  changed(current);
  layoutSoon();
});
body.addEventListener("paste", e => {
  const dt = e.clipboardData; if (!dt) return;
  const files = [...dt.files].filter(f => f.type.startsWith("image/"));
  e.preventDefault();
  if (files.length) { insertImages(files); return; }
  const text = dt.getData("text/plain");
  if (text) body.ownerDocument.execCommand("insertText", false, text);   // plain text only: no stray formatting
});
body.addEventListener("dragover", e => {
  if ([...(e.dataTransfer && e.dataTransfer.items || [])].some(i => i.kind === "file")) e.preventDefault();
});
body.addEventListener("drop", e => {
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  const doc = body.ownerDocument;
  const r = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(e.clientX, e.clientY) : null;
  if (r && body.contains(r.startContainer)) { const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); }
  insertImages(files);
});
el.addImage.onclick = () => el.imageFile.click();
el.imageFile.onchange = () => {
  const files = [...el.imageFile.files]; el.imageFile.value = "";
  if (files.length) insertImages(files);
};

// ---------- make a task in InkTasks ----------
// Selected text becomes the task (first line the title, further lines its steps); with nothing
// selected, the note itself does. InkTasks lives on the same website, so this writes straight
// into its storage, works offline, and InkTasks shows it at once.
el.makeTask.addEventListener("pointerdown", e => e.preventDefault());   // keep the text selection
el.makeTask.onclick = async () => {
  if (!current) return;
  const doc = body.ownerDocument, sel = doc.getSelection();
  const picked = sel && sel.rangeCount && !sel.isCollapsed && body.contains(sel.anchorNode) ? sel.toString() : "";
  const lines = picked.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const noteTitle = titleOf(current);
  const generic = ["Handwritten note", "Image note", "Empty note"].includes(noteTitle);
  const title = (lines[0] || (generic ? "Follow up on note" : noteTitle)).slice(0, 255);
  await flushSaves();
  try {
    const tasksDb = await import("/inktasks/js/db.js");
    const t = tasksDb.newTask({
      title, noteId: current.id, noteTitle,
      steps: lines.slice(1).map(l => ({ id: uid(), title: l.slice(0, 255), done: false })),
    });
    await tasksDb.db.put(t);
    tasksDb.announce([t.id], "inknotes");
    syncTasksSoon(tasksDb.db);
    toast(`Added “${title}” to InkTasks.`, "Open", () => window.open(`/inktasks/?task=${encodeURIComponent(t.id)}`, "inktasks"));
  } catch (err) {
    console.warn(err);
    toast("Couldn't reach InkTasks. Open InkTasks once while online, then try again.");
  }
};
let taskSync = null;
function syncTasksSoon(tasksDb) {
  if (!sync.configured || !sync.account()) return;
  if (taskSync) { taskSync.soon(); return; }
  taskSync = createSync({ folder: "todo", stateKey: "syncState:todo", local: tasksDb });
  taskSync.start({ onStatus() {}, onPulled(ids) { import("/inktasks/js/db.js").then(m => m.announce(ids, "inknotes")); } });
}

// ---------- layout: the page grows with text, images and ink ----------
let layoutQueued = false;
function layoutSoon() {
  if (layoutQueued) return;
  layoutQueued = true;
  (body.ownerDocument.defaultView || window).requestAnimationFrame(() => { layoutQueued = false; layout(); });
}
function layout() {
  if (!current || noteView.hidden || surface.busy) return;   // never resize the canvas mid-stroke
  const minH = scroller.clientHeight;
  body.style.minHeight = "0";
  const textH = body.scrollHeight;
  body.style.minHeight = "";
  const inkH = inkBottom(current.strokes) * page.clientWidth / W;
  page.style.height = Math.ceil(Math.max(minH, textH, inkH + minH * 0.5)) + "px";
  surface.resize();
}
new ResizeObserver(() => layoutSoon()).observe(scroller);

// ---------- pen stays ink (not handwriting-to-text) ----------
// Windows (Edge's handwriting to text) and Samsung (S Pen to text) turn pen writing on a text box
// into typed text, and the whole note is a text box. While the pen hovers over the note, the ink
// layer takes the pen instead, so the system never sees a text box under it.
function penShield(on) { page.classList.toggle("pen-near", on && !settings.penText); }
const PEN_EVENTS = ["pointerover", "pointerenter", "pointermove", "pointerdown"];
let penAt = -1e9;
const palmTime = e => e.timeStamp - penAt < 1000;   // a touch this soon after the pen is a palm
for (const type of PEN_EVENTS) page.addEventListener(type, e => {
  if (e.pointerType === "pen") { penAt = e.timeStamp; penShield(true); }
  else if (e.pointerType === "mouse" || (type === "pointerdown" && !palmTime(e))) penShield(false);
}, true);
page.addEventListener("pointerleave", e => { if (e.pointerType === "pen" && !surface.busy) penShield(false); });
page.addEventListener("pointerup", e => { if (e.pointerType === "pen" && !page.matches(":hover")) penShield(false); });
// A finger or mouse tap that lands on the ink layer just after the pen: put the text cursor there.
el.ink.addEventListener("click", e => {
  if (e.pointerType === "pen" || settings.touchInk || (e.pointerType === "touch" && palmTime(e))) return;
  penShield(false);
  const doc = body.ownerDocument;
  const r = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(e.clientX, e.clientY) : null;
  body.focus();
  if (r && body.contains(r.startContainer)) { const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); }
  else placeCaretEnd();
});

function paintPaper() {
  if (!current) return;
  noteView.style.setProperty("--paper", `var(--paper-${current.color})`);
  const ctx = el.paper.getContext("2d");
  ctx.fillStyle = paperColor(current.color); ctx.fillRect(0, 0, 1, 1);
  el.papers.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.paper === current.color)));
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paintPaper(); renderList(); });

// ---------- notes list ----------
const visibleNotes = () => [...notes.values()].filter(n => !n.deleted).sort((a, b) => b.updated - a.updated);
let listTimer = 0;
function listSoon() { clearTimeout(listTimer); listTimer = setTimeout(renderList, 150); }
function renderList() {
  if (app.dataset.mode !== "main") return;
  const q = query.trim().toLowerCase();
  const list = visibleNotes().filter(n => !q || (n.text || "").toLowerCase().includes(q));
  if (!list.length) {
    const p = document.createElement("p"); p.className = "empty";
    p.textContent = q ? "No notes match that search." : "No notes yet. Select New note to start one.";
    cards.replaceChildren(p); return;
  }
  const els = list.map(cardFor);
  cards.replaceChildren(...els);
  els.forEach((c, i) => drawThumb(c, list[i]));
}
function cardFor(n) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "card"; b.dataset.id = n.id;
  b.style.setProperty("--paper", `var(--paper-${n.color})`);
  b.setAttribute("aria-current", String(!!current && current.id === n.id));
  const t = document.createElement("span"); t.className = "title"; t.textContent = titleOf(n); b.append(t);
  const rest = (n.text || "").split("\n").map(s => s.trim()).filter(Boolean).slice(1).join(" ");
  if (rest) { const s = document.createElement("span"); s.className = "snippet"; s.textContent = rest; b.append(s); }
  if (n.strokes.length) { const c = document.createElement("canvas"); c.className = "thumb"; c.setAttribute("aria-hidden", "true"); b.append(c); }
  const tm = document.createElement("span"); tm.className = "time"; tm.textContent = fmtTime(n.updated); b.append(tm);
  b.onclick = () => openNote(n.id);
  return b;
}
function drawThumb(card, n) {
  const c = card.querySelector("canvas.thumb"); if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of n.strokes) for (const q of s.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const pad = 4 * dpr;
  const k = Math.min((c.width - 2 * pad) / Math.max(1, x1 - x0), (c.height - 2 * pad) / Math.max(1, y1 - y0), (w / W) * dpr * 2.5);
  const ctx = c.getContext("2d");
  ctx.setTransform(k, 0, 0, k, pad - x0 * k, pad - y0 * k);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const s of n.strokes) drawStroke(ctx, s, 0.8 * dpr / k);
}
function markCards() {
  cards.querySelectorAll(".card").forEach(c => c.setAttribute("aria-current", String(!!current && c.dataset.id === current.id)));
}

// ---------- opening, creating, deleting ----------
function openNote(id, { focus = false } = {}) {
  const n = notes.get(id);
  if (!n || n.deleted) return;
  current = n;
  app.dataset.view = "editor";
  el.emptyMsg.hidden = true;
  noteView.hidden = false;
  paintPaper();
  renderBody(n);
  surface.setStrokes(n.strokes);
  scroller.scrollTop = 0;
  layout();
  markCards();
  if (app.dataset.mode === "note") document.title = titleOf(n) + " – InkNotes";
  if (pip) pip.document.title = titleOf(n);
  if (focus && !IS_MOBILE) placeCaretEnd();
}
function showEmpty(message) {
  current = null;
  noteView.hidden = true;
  el.emptyMsg.hidden = false;
  el.emptyMsg.querySelector("p").textContent = message || "No note open. Select a note or start a new one.";
  app.dataset.view = "list";
}
function createNote() {
  const now = Date.now();
  const n = { id: uid(), color: "yellow", html: "", text: "", strokes: [], created: now, updated: now, deleted: false };
  notes.set(n.id, n);
  return n;
}
function openWindow(id) {
  const s = { w: 380, h: 440, ...readJSON(WINDOW_SIZE_KEY) };
  const url = new URL(location.href);
  url.search = "?note=" + encodeURIComponent(id); url.hash = "";
  const win = window.open(url.href, "inknote-" + id, `popup,width=${s.w},height=${s.h}`);
  if (!win) toast("The browser blocked the new window. Allow pop-ups for InkNotes, then try again.");
}

el.newNote.onclick = async () => {
  const n = createNote(); await persist(n);
  query = ""; el.search.value = "";
  renderList(); openNote(n.id, { focus: true });
};
el.newFromWindow.onclick = async () => { const n = createNote(); await persist(n); openWindow(n.id); };
el.popout.onclick = async () => { if (!current) return; await flushSaves(); openWindow(current.id); };
el.back.onclick = () => { flushSaves(); app.dataset.view = "list"; renderList(); };
el.search.addEventListener("input", () => { query = el.search.value; renderList(); });

let deleteArmed = 0;
function resetDelete() {
  clearTimeout(deleteArmed); deleteArmed = 0;
  el.deleteNote.textContent = "Delete note"; el.deleteNote.classList.remove("armed");
}
el.deleteNote.onclick = () => {
  if (!deleteArmed) {
    el.deleteNote.textContent = "Select again to delete"; el.deleteNote.classList.add("armed");
    deleteArmed = setTimeout(resetDelete, 3000); return;
  }
  resetDelete(); deleteCurrent();
};
async function deleteCurrent() {
  if (!current) return;
  const n = current;
  n.deleted = true; changed(n);
  el.menu.open = false;
  if (pip) pip.close();
  if (app.dataset.mode === "note") { await flushSaves(); window.close(); showEmpty("This note was deleted."); return; }
  const next = visibleNotes()[0];
  if (next && matchMedia("(min-width: 761px)").matches) openNote(next.id); else showEmpty();
  renderList();
  toast("Note deleted.", "Undo", () => { n.deleted = false; changed(n); renderList(); openNote(n.id); });
}

// ---------- other windows ----------
const editingHere = () => surface.busy || (body.ownerDocument.activeElement === body && body.ownerDocument.hasFocus());
if (channel) channel.onmessage = ({ data }) => {
  if (data && data.from !== windowId && data.type === "changed") applyExternal(data.id);
};
// A note changed outside this window: in another window, or downloaded by OneDrive sync.
async function applyExternal(id) {
  const n = await store.getNote(id);
  if (!n) return;
  n.strokes = n.strokes || [];
  const mine = notes.get(n.id);
  if (mine && (mine.updated >= n.updated || saveTimers.has(n.id))) return;
  if (current && current.id === n.id) {
    if (editingHere()) return;   // keep what's being written here; it saves next
    notes.set(n.id, n);
    if (n.deleted) {
      if (app.dataset.mode === "note") { window.close(); showEmpty("This note was deleted."); }
      else { const next = visibleNotes()[0]; if (next && matchMedia("(min-width: 761px)").matches) openNote(next.id); else showEmpty(); }
    } else {
      const top = scroller.scrollTop;
      current = n; paintPaper(); renderBody(n); surface.setStrokes(n.strokes); layout();
      scroller.scrollTop = top;
      if (app.dataset.mode === "note") document.title = titleOf(n) + " – InkNotes";
    }
  } else {
    notes.set(n.id, n);
  }
  listSoon();
}

let sizeTimer = 0;
if (windowNoteId) addEventListener("resize", () => {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => writeJSON(WINDOW_SIZE_KEY, { w: outerWidth, h: outerHeight }), 400);
});

// ---------- keep on top (Document Picture-in-Picture, Edge/Chrome on Windows) ----------
let pip = null;
async function togglePin() {
  if (pip) { pip.close(); return; }
  if (!current) return;
  const s = { w: 360, h: 420, ...readJSON(PIP_SIZE_KEY) };
  try {
    pip = await documentPictureInPicture.requestWindow({ width: s.w, height: s.h });
  } catch (err) {
    toast("Couldn't keep the note on top. " + (err && err.message ? err.message : ""));
    return;
  }
  const pdoc = pip.document;
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) pdoc.head.append(node.cloneNode(true));
  if (document.documentElement.dataset.theme) pdoc.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pdoc.title = titleOf(current);
  pdoc.body.className = "pip";
  pdoc.body.append(noteView);
  pdoc.addEventListener("keydown", onKey);
  pdoc.addEventListener("pointerdown", closeMenuOutside);
  el.pinnedMsg.hidden = false;
  el.pin.setAttribute("aria-pressed", "true"); el.pin.title = "Stop keeping on top";
  const ro = new pip.ResizeObserver(() => layoutSoon()); ro.observe(scroller);
  let t = 0;
  pip.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (pip) writeJSON(PIP_SIZE_KEY, { w: pip.innerWidth, h: pip.innerHeight }); }, 400);
  });
  pip.addEventListener("pagehide", () => {
    ro.disconnect();
    editorPane.prepend(noteView);
    el.pinnedMsg.hidden = true;
    el.pin.setAttribute("aria-pressed", "false"); el.pin.title = "Keep on top of other windows";
    pip = null;
    layoutSoon();
  });
  layoutSoon();
}
el.pin.onclick = togglePin;
el.unpin.onclick = () => { if (pip) pip.close(); };

// ---------- tools ----------
INKS.forEach((c, i) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "swatch"; b.style.background = c; b.dataset.color = c;
  b.setAttribute("aria-label", INK_NAMES[i] + " ink"); b.title = INK_NAMES[i] + " ink";
  b.onclick = () => { settings.color = c; settings.eraser = false; saveSettings(); syncTools(); };
  el.inks.append(b);
});
PAPERS.forEach(name => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "swatch sq"; b.style.background = `var(--paper-${name})`; b.dataset.paper = name;
  b.setAttribute("aria-label", name[0].toUpperCase() + name.slice(1) + " note");
  b.onclick = () => { if (!current) return; current.color = name; changed(current); paintPaper(); };
  el.papers.append(b);
});
function syncTools() {
  el.inks.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-pressed", String(!settings.eraser && b.dataset.color === settings.color)));
  el.eraser.setAttribute("aria-pressed", String(settings.eraser));
  el.touchInk.setAttribute("aria-pressed", String(settings.touchInk));
  el.size.value = settings.size; el.sizeVal.textContent = settings.size + " px";
  el.smooth.value = settings.smooth; el.smoothVal.textContent = settings.smooth ? smoothPx(settings.smooth).toFixed(1) + " px" : "off";
  el.curve.value = settings.curve; el.curveVal.textContent = settings.curve < 40 ? "soft" : settings.curve > 60 ? "firm" : "even";
  el.penMode.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.mode === "text") === settings.penText)));
  el.penModeHint.textContent = settings.penText
    ? (IS_ANDROID ? "S Pen to text turns writing into typed text. Ink still works outside the text." : "Windows handwriting turns writing into typed text.")
      + " Switch back to Ink to draw."
    : "The pen always draws ink. Type with the keyboard, or switch to Text to have your handwriting typed.";
}
el.eraser.onclick = () => { settings.eraser = !settings.eraser; syncTools(); };
el.undo.onclick = () => surface.undo();
el.touchInk.onclick = () => {
  settings.touchInk = !settings.touchInk; saveSettings(); syncTools();
  toast(settings.touchInk ? "Finger and mouse now draw. Turn this off to type and scroll with them." : "Only the pen draws now.");
};
el.penMode.onclick = e => {
  const b = e.target.closest("button[data-mode]"); if (!b) return;
  settings.penText = b.dataset.mode === "text"; saveSettings(); syncTools();
  if (settings.penText) penShield(false);
};
el.size.oninput = () => { settings.size = +el.size.value; saveSettings(); syncTools(); };
el.smooth.oninput = () => { settings.smooth = +el.smooth.value; saveSettings(); syncTools(); };
el.curve.oninput = () => { settings.curve = +el.curve.value; saveSettings(); syncTools(); };

function closeMenuOutside(e) { if (el.menu.open && !el.menu.contains(e.target)) el.menu.open = false; }
document.addEventListener("pointerdown", closeMenuOutside);
function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    if (e.target === body || body.contains(e.target)) return;   // text undo stays with the text box
    e.preventDefault(); surface.undo();
  }
  if (e.key === "Escape") el.menu.open = false;
}
document.addEventListener("keydown", onKey);

let toastTimer = 0;
function toast(msg, action, fn) {
  el.toastText.textContent = msg;
  el.toastAction.hidden = !action;
  if (action) { el.toastAction.textContent = action; el.toastAction.onclick = () => { el.toast.hidden = true; fn(); }; }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
}

// ---------- start ----------
const WELCOME_HTML =
  "<div><b>Welcome to InkNotes</b></div>" +
  "<div>Write on this note with your pen, or tap here and type.</div>" +
  "<div>Paste or drop an image to add it.</div>" +
  "<div>On Windows, the buttons at the top right open a note in its own window or keep it on top of other apps.</div>" +
  "<div>Notes save on this device as you go.</div>";
const WELCOME_TEXT = "Welcome to InkNotes\nWrite on this note with your pen, or tap here and type.\nPaste or drop an image to add it.\n" +
  "On Windows, the buttons at the top right open a note in its own window or keep it on top of other apps.\nNotes save on this device as you go.";

const BLOCKED_MSG = "InkNotes was updated. Close or reload any other InkNotes windows to finish.";
store.hooks.onBlocked = () => {
  el.storageNote.hidden = false; el.storageNote.textContent = BLOCKED_MSG;
  toast(BLOCKED_MSG); clearTimeout(toastTimer);
};
store.hooks.onUnblocked = () => {
  if (el.storageNote.textContent === BLOCKED_MSG) el.storageNote.hidden = true;
  if (el.toastText.textContent === BLOCKED_MSG) el.toast.hidden = true;
};
store.hooks.onVersionChange = () => {
  toast("InkNotes was updated in another window. Reload this one to keep saving.", "Reload", () => location.reload());
  clearTimeout(toastTimer);   // keep this message up
};

async function init() {
  syncTools();
  let all = [];
  try { all = await store.allNotes(); } catch (err) { console.warn(err); }
  for (const n of all) { n.strokes = n.strokes || []; notes.set(n.id, n); }
  if (!store.persistent) {
    el.storageNote.hidden = false;
    el.storageNote.textContent = "This browser is blocking site storage, so notes will be lost when it closes.";
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  startSync();
  if (windowNoteId) {
    const n = notes.get(windowNoteId);
    if (n && !n.deleted) openNote(n.id, { focus: !n.text && !n.strokes.length });
    else showEmpty("This note was deleted or isn't on this device.");
    return;
  }
  if (!all.length) {
    const n = createNote();
    n.html = WELCOME_HTML; n.text = WELCOME_TEXT; n.welcome = true;   // not synced unless edited
    await persist(n);
  }
  renderList();
  const first = visibleNotes()[0];
  if (!first) showEmpty();
  else if (matchMedia("(min-width: 761px)").matches) openNote(first.id);
  else app.dataset.view = "list";
}
// ---------- OneDrive sync ----------
const sync = createSync({
  folder: "notes", stateKey: "syncState", images: true,
  local: { all: store.allNotes, get: store.getNote, put: store.putNote, getImage: store.getImage, putImage: store.putImage },
});
const syncUI = mountSyncUI({
  sync, button: el.syncBtn, appName: "your notes", toast,
  isMain: () => app.dataset.mode === "main", beforeSignIn: flushSaves,
});
function startSync() {
  if (!sync.configured) return;
  sync.start({
    allowRedirect: app.dataset.mode === "main",
    onStatus: syncUI.render,
    onRedirect: flushSaves,
    onPulled: ids => ids.forEach(id => {
      applyExternal(id);
      if (channel) channel.postMessage({ type: "changed", id, from: windowId });
    }),
  });
}

init();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline support unavailable:", err));
}
