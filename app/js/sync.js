// OneDrive sync: when to sync, sign-in state, the sync passphrase, and status for the UI.
// Every open InkNotes window can sync; a browser lock makes sure only one pass runs at a time.

import { CLIENT_ID } from "./config.js";
import * as auth from "./auth.js";
import { graphDrive as drive } from "./graph.js";
import { store } from "./store.js";
import { syncOnce } from "./sync-engine.js";
import { newKeyFile, keyFromFile } from "./crypt.js";

const SILENT_TRIED = "inknotes-silent-signin";
const KEY_FILE = "key.json";
const td = new TextDecoder(), te = new TextEncoder();

// state: unconfigured | signedOut | needsPassphrase | needsNewPassphrase | syncing | ok | offline | reauth | error
let status = { state: CLIENT_ID ? "signedOut" : "unconfigured" };
let hooks = { onStatus() {}, onPulled() {} };
let running = false, again = false, soonTimer = 0, timer = 0, mayRedirect = false;

function set(state, extra = {}) {
  status = { ...status, ...extra, state };
  if (state !== "error") delete status.message;
  hooks.onStatus(status);
}
const withLock = fn => (navigator.locks ? navigator.locks.request("inknotes-sync", fn) : fn());

async function readKeyFile() {
  const bytes = await drive.read("", KEY_FILE);
  return bytes ? JSON.parse(td.decode(bytes)) : null;
}

async function forgetKey() {
  await store.deleteMeta("key"); await store.deleteMeta("keySalt"); await store.deleteMeta("syncState");
}

async function run() {
  if (!CLIENT_ID) return set("unconfigured");
  if (!auth.account()) return set("signedOut");
  if (!navigator.onLine) return set("offline");
  if (running) { again = true; return; }
  running = true;
  set("syncing", { detail: "Syncing" });
  try {
    await withLock(async () => {
      const keyFile = await readKeyFile();
      let key = await store.getMeta("key");
      if (key && (!keyFile || keyFile.salt !== (await store.getMeta("keySalt")))) {
        await forgetKey(); key = null;   // the passphrase was reset from another device
      }
      if (!key) { set(keyFile ? "needsPassphrase" : "needsNewPassphrase"); return; }
      const state = (await store.getMeta("syncState")) || { notes: {}, images: {} };
      try {
        const res = await syncOnce({ drive, local: store, key, state, onProgress: d => set("syncing", { detail: d }) });
        if (res.pulled.length) hooks.onPulled(res.pulled);
        if (res.conflicts) again = true;
      } finally {
        await store.setMeta("syncState", state);   // keep progress even if a later step failed
      }
      const last = Date.now();
      await store.setMeta("lastSync", last);
      set("ok", { last });
    });
  } catch (err) {
    if (err.reauth) {
      if (mayRedirect && !sessionStorage.getItem(SILENT_TRIED)) {
        sessionStorage.setItem(SILENT_TRIED, "1");
        set("syncing", { detail: "Reconnecting to Microsoft" });
        auth.signIn({ silent: true });
        return;
      }
      set("reauth");
    } else if (err.signedOut) set("signedOut");
    else if (err instanceof TypeError || !navigator.onLine) set("offline");
    else { console.warn("InkNotes sync:", err); set("error", { message: err.message || String(err) }); }
  } finally {
    running = false; mayRedirect = false;
    if (again) { again = false; schedule(1500); }
  }
}

function schedule(ms) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(run, ms);
}

export const sync = {
  get configured() { return !!CLIENT_ID; },
  get status() { return status; },
  account: () => auth.account(),

  // allowRedirect: this is the main window opening, so a quick silent trip to Microsoft is fine.
  async start({ onStatus, onPulled, allowRedirect = false }) {
    hooks = { onStatus, onPulled };
    if (!CLIENT_ID) return set("unconfigured");
    const back = await auth.handleRedirect();
    if (back && back.error) {
      if (back.silent) set("reauth");
      else if (back.error !== "access_denied") set("error", { message: "Microsoft sign-in didn't finish: " + (back.description || back.error) });
    }
    if (back && back.ok) sessionStorage.removeItem(SILENT_TRIED);
    const last = await store.getMeta("lastSync");
    if (last) status.last = last;
    if (!auth.account()) { if (!back || !back.error) set("signedOut"); return; }
    mayRedirect = allowRedirect && !back;
    run();
    addEventListener("online", () => schedule(500));
    addEventListener("offline", () => set("offline"));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(500); });
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") run(); }, 90e3);
  },

  soon() { if (auth.account()) schedule(4000); },   // after a local save
  now() { schedule(0); },
  signIn() { auth.signIn(); },

  async signOut() {
    auth.signOut(); await forgetKey(); await store.deleteMeta("lastSync");
    delete status.last; set("signedOut");
  },

  // First device: creates the passphrase. Other devices: unlocks with it. Returns an error message or "".
  async usePassphrase(pass) {
    const keyFile = await readKeyFile();
    let key, salt;
    if (keyFile) {
      key = await keyFromFile(pass, keyFile);
      if (!key) return "That passphrase doesn't match the one set on your other device.";
      salt = keyFile.salt;
    } else {
      const made = await newKeyFile(pass);
      await drive.write("", KEY_FILE, te.encode(JSON.stringify(made.file)));
      key = made.key; salt = made.file.salt;
    }
    await store.setMeta("key", key); await store.setMeta("keySalt", salt); await store.deleteMeta("syncState");
    run();
    return "";
  },

  // Forgot the passphrase: removes the encrypted copies in OneDrive (notes on devices stay),
  // so a new passphrase can be set. Other devices will ask for the new one.
  async startOver() {
    await drive.remove("notes"); await drive.remove("images"); await drive.remove(KEY_FILE);
    await forgetKey();
    set("needsNewPassphrase");
  },
};
