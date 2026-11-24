// OneDrive sync: when to sync, sign-in state, the sync passphrase, and status for the UI.
// createSync() is used by InkNotes (notes) and InkTasks (tasks). Both apps share the sign-in,
// the passphrase key and key.json; each keeps its own folder and its own record of what it synced.
// Every open window can sync; a browser lock makes sure only one pass per folder runs at a time.

import { CLIENT_ID } from "./config.js";
import * as auth from "./auth.js";
import { graphDrive as drive } from "./graph.js";
import { store } from "./store.js";
import { syncOnce } from "./sync-engine.js";
import { newKeyFile, keyFromFile } from "./crypt.js";

const SILENT_TRIED = "inknotes-silent-signin";
const STALE_MS = 30e3;   // no heartbeat for this long: the window holding the sync lock is frozen
const KEY_FILE = "key.json";
const td = new TextDecoder(), te = new TextEncoder();

async function readKeyFile() {
  const bytes = await drive.read("", KEY_FILE);
  return bytes ? JSON.parse(td.decode(bytes)) : null;
}
async function forgetKey() { await store.deleteMeta("key"); await store.deleteMeta("keySalt"); }

// folder: OneDrive folder; local: { all, get, put, getImage?, putImage? }; stateKey: where this app
// keeps what it last synced; images: also sync pasted images.
export function createSync({ folder, local, stateKey, images = false }) {
  // state: unconfigured | signedOut | needsPassphrase | needsNewPassphrase | syncing | ok | offline | reauth | error
  let status = { state: CLIENT_ID ? "signedOut" : "unconfigured" };
  let hooks = { onStatus() {}, onPulled() {}, onRedirect() {} };
  let running = false, again = false, soonTimer = 0, timer = 0, mayRedirect = false, started = false;

  function set(state, extra = {}) {
    status = { ...status, ...extra, state };
    if (state !== "error") delete status.message;
    hooks.onStatus(status);
  }
  // One pass per folder at a time, across windows and both apps. The pass holding the lock
  // stamps a heartbeat every few seconds; a phone can freeze a background window mid-pass with the
  // lock still held, so when the heartbeat stops, the waiting window takes the lock over.
  const LOCK = "inknotes-sync-" + folder, BEAT = "syncBeat:" + folder;
  async function holding(fn) {
    const beat = () => store.setMeta(BEAT, Date.now()).catch(() => {});
    await beat();
    const iv = setInterval(beat, 5e3);
    try { return await fn(); } finally { clearInterval(iv); }
  }
  async function withLock(fn) {
    if (!navigator.locks) return fn();
    const waitStart = Date.now();
    for (;;) {
      const got = await navigator.locks.request(LOCK, { ifAvailable: true }, lock => (lock ? holding(fn).then(v => ({ v })) : null));
      if (got) return got.v;
      const last = (await store.getMeta(BEAT)) || 0;
      if (Date.now() - waitStart > 6e3 && Date.now() - last > STALE_MS) {
        return navigator.locks.request(LOCK, { steal: true }, () => holding(fn));
      }
      set("syncing", { detail: "Waiting for another window" });
      await new Promise(r => setTimeout(r, 2e3));
    }
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
        const key = await store.getMeta("key");
        const salt = await store.getMeta("keySalt");
        if (!key) { set((await readKeyFile()) ? "needsPassphrase" : "needsNewPassphrase"); return; }
        // key.json changes only when the passphrase is reset on another device. It's checked
        // alongside the folder listing (so it costs no extra wait), before anything uploads.
        const check = async () => {
          const keyFile = await readKeyFile();
          if (!keyFile || keyFile.salt !== salt) throw Object.assign(new Error("Passphrase changed"), { keyChanged: true, keyFile });
        };
        let state = await store.getMeta(stateKey);
        if (!state || state.salt !== salt) state = { salt, notes: {}, images: {} };   // new passphrase: start fresh
        try {
          const res = await syncOnce({ drive, local, key, state, folder, images, check, onProgress: d => set("syncing", { detail: d }) });
          if (res.pulled.length) hooks.onPulled(res.pulled);
          if (res.conflicts) again = true;
        } catch (err) {
          if (!err.keyChanged) throw err;
          await forgetKey();   // the passphrase was reset from another device
          set(err.keyFile ? "needsPassphrase" : "needsNewPassphrase");
          return;
        } finally {
          await store.setMeta(stateKey, state);   // keep progress even if a later step failed
        }
        const last = Date.now();
        await store.setMeta(stateKey + ":last", last);
        set("ok", { last });
      });
    } catch (err) {
      if (err.reauth) {
        if (mayRedirect && !sessionStorage.getItem(SILENT_TRIED)) {
          sessionStorage.setItem(SILENT_TRIED, "1");
          set("syncing", { detail: "Reconnecting to Microsoft" });
          await hooks.onRedirect();
          auth.signIn({ silent: true });
          return;
        }
        set("reauth");
      } else if (err.signedOut) set("signedOut");
      else if (err instanceof TypeError || err.name === "TimeoutError" || err.name === "AbortError" || !navigator.onLine) {
        set("offline");
        if (navigator.onLine) schedule(10e3);   // OneDrive dropped or stopped answering: try again soon
      }
      else { console.warn("Sync:", err); set("error", { message: err.message || String(err) }); }
    } finally {
      running = false; mayRedirect = false;
      if (again) { again = false; schedule(1500); }
    }
  }

  function schedule(ms) { clearTimeout(soonTimer); soonTimer = setTimeout(run, ms); }

  return {
    get configured() { return !!CLIENT_ID; },
    get status() { return status; },
    account: () => auth.account(),

    // allowRedirect: this is the app's main window opening, so a quick silent trip to Microsoft is fine.
    // Returns what handleRedirect found (e.g. { ok, purpose }) so the app can finish an import etc.
    async start({ onStatus, onPulled, onRedirect, allowRedirect = false }) {
      hooks = { onStatus, onPulled, onRedirect: onRedirect || (() => {}) };
      if (!CLIENT_ID) { set("unconfigured"); return null; }
      const back = await auth.handleRedirect();
      if (back && back.error) {
        if (back.silent) set("reauth");
        else if (back.error !== "access_denied") set("error", { message: "Microsoft sign-in didn't finish: " + (back.description || back.error) });
      }
      if (back && back.ok) sessionStorage.removeItem(SILENT_TRIED);
      const last = await store.getMeta(stateKey + ":last");
      if (last) status.last = last;
      if (!started) {
        started = true;
        addEventListener("online", () => schedule(500));
        addEventListener("offline", () => set("offline"));
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(500); });
        timer = setInterval(() => { if (document.visibilityState === "visible" && auth.account()) run(); }, 30e3);
      }
      if (!auth.account()) { if (!back || !back.error) set("signedOut"); return back; }
      mayRedirect = allowRedirect && !back;
      run();
      return back;
    },

    soon() { if (auth.account()) schedule(1000); },   // after a local save
    now() { schedule(0); },
    signIn(opts) { return auth.signIn(opts); },

    async signOut() {
      auth.signOut(); await forgetKey();
      await store.deleteMeta(stateKey); await store.deleteMeta(stateKey + ":last");
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
      await store.setMeta("key", key); await store.setMeta("keySalt", salt);
      run();
      return "";
    },

    // Forgot the passphrase: removes the encrypted copies in OneDrive (data on devices stays),
    // so a new passphrase can be set. Other devices and the other app will ask for the new one.
    async startOver() {
      for (const p of ["notes", "images", "todo", KEY_FILE]) await drive.remove(p);
      await forgetKey();
      set("needsNewPassphrase");
    },
  };
}
