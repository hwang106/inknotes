// The OneDrive sync panel (sign in, passphrase, status), shared by InkNotes and InkTasks.
// Builds its own <dialog>; the app supplies the cloud button, a toast function and its styles
// (.sheet, .input, .btn, .field, .label, .hint, .form-error, .sync-btn).

const COPY = app => ({
  signedOut: {
    text: `Keep ${app} the same on your Surface and your phone. An encrypted copy is kept in your OneDrive, in Apps/InkNotes.`,
    hint: "Use your personal Microsoft account. The app can only see its own folder, nothing else in your OneDrive. InkNotes and InkTasks share one sign-in.",
    primary: "Sign in with Microsoft",
  },
  needsNewPassphrase: {
    text: "Choose a sync passphrase. Everything is encrypted with it before it leaves this device, so only your devices can read it. Microsoft can't.",
    hint: "At least 8 characters. You'll type it once on each device (InkNotes and InkTasks share it). If you forget it, what's on your devices is safe, but you'd need to start sync over.",
    primary: "Turn on sync", pass: 2, alt: "Sign out",
  },
  needsPassphrase: {
    text: "Type the sync passphrase you chose before (on another device, or in InkNotes or InkTasks).",
    hint: "", primary: "Unlock", pass: 1, alt: "Forgot it? Start over",
  },
  reauth: { text: "Your Microsoft sign-in has expired.", hint: "Sign in again to keep syncing.", primary: "Sign in again", alt: "Sign out" },
});

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " at " + time;
}
export function syncStatusLine(st) {
  if (st.state === "syncing") return (st.detail || "Syncing") + "…";
  if (st.state === "offline") return "Offline. Changes will sync when you're back online.";
  if (st.state === "error") return "Sync hit a problem: " + st.message;
  if (st.state === "signedOut") return "OneDrive sync is off.";
  return st.last ? "Last synced " + fmtTime(st.last) + "." : "Not synced yet.";
}

const html = `
  <form class="sheet-body" method="dialog">
    <h2>OneDrive sync</h2>
    <p data-r="text"></p>
    <div class="field" data-r="passFields" hidden>
      <label class="label" data-r="pass1Label">Sync passphrase</label>
      <input class="input" type="password" data-r="pass1" minlength="8">
      <div class="field" data-r="pass2Wrap">
        <label class="label" data-r="pass2Label">Type it again</label>
        <input class="input" type="password" data-r="pass2" autocomplete="new-password">
      </div>
    </div>
    <p class="hint" data-r="hint"></p>
    <p class="form-error" data-r="error" role="alert" hidden></p>
    <div class="sheet-actions">
      <button class="btn link" data-r="alt" type="button" hidden></button>
      <span class="spacer"></span>
      <button class="btn" data-r="close" type="button">Close</button>
      <button class="btn primary" data-r="primary" type="submit"></button>
    </div>
  </form>`;

// sync: from createSync(); button: the cloud button; appName: "your notes" / "your tasks";
// isMain(): whether to open the panel on its own when a passphrase is needed;
// beforeSignIn(): save work before leaving for Microsoft's page.
export function mountSyncUI({ sync, button, appName, toast, isMain = () => true, beforeSignIn = async () => {} }) {
  const copy = COPY(appName);
  const dlg = document.createElement("dialog");
  dlg.className = "sheet"; dlg.innerHTML = html;
  dlg.setAttribute("aria-label", "OneDrive sync");
  document.body.append(dlg);
  const r = Object.fromEntries([...dlg.querySelectorAll("[data-r]")].map(e => [e.dataset.r, e]));
  const uid = "s" + Math.random().toString(36).slice(2, 8);
  r.pass1.id = uid + "1"; r.pass1Label.htmlFor = r.pass1.id;
  r.pass2.id = uid + "2"; r.pass2Label.htmlFor = r.pass2.id;
  const form = dlg.querySelector("form");
  let prompted = false, altArmed = 0, busy = false, passFor = "";

  const showError = msg => { r.error.textContent = msg; r.error.hidden = !msg; };
  const resetAlt = () => { clearTimeout(altArmed); altArmed = 0; r.alt.classList.remove("armed"); };

  function fill(st) {
    const c = copy[st.state];
    const acct = sync.account();
    const who = acct ? (acct.name && acct.user ? `${acct.name} (${acct.user})` : acct.name || acct.user) : "";
    r.text.textContent = c ? c.text : `Syncing with ${who ? "the OneDrive of " + who : "your OneDrive"}.`;
    r.hint.textContent = c ? c.hint : syncStatusLine(st);
    r.hint.hidden = !r.hint.textContent;
    if (!busy) r.primary.textContent = c ? c.primary : "Sync now";
    r.primary.disabled = busy || st.state === "syncing";
    const alt = c ? c.alt : "Sign out";
    r.alt.hidden = !alt;
    if (!altArmed) r.alt.textContent = alt || "";
    r.passFields.hidden = !(c && c.pass);
    r.pass2Wrap.hidden = !(c && c.pass === 2);
    if (c && c.pass && passFor !== st.state) {   // fresh fields whenever the question changes
      passFor = st.state;
      r.pass1.value = r.pass2.value = "";
      r.pass1.autocomplete = c.pass === 2 ? "new-password" : "current-password";
      setTimeout(() => r.pass1.focus(), 0);
    }
    if (!(c && c.pass)) passFor = "";
  }
  function open() {
    showError(""); resetAlt(); passFor = "";
    fill(sync.status);
    if (!dlg.open) dlg.showModal();
  }
  function render(st = sync.status) {
    button.hidden = st.state === "unconfigured";
    button.dataset.state = st.state;
    button.title = "OneDrive sync: " + syncStatusLine(st);
    button.setAttribute("aria-label", button.title);
    if ((st.state === "needsPassphrase" || st.state === "needsNewPassphrase") && !prompted && isMain() && !dlg.open) {
      prompted = true; open();
    }
    if (dlg.open) fill(st);
  }

  button.addEventListener("click", open);
  r.close.onclick = () => dlg.close();
  dlg.addEventListener("close", resetAlt);
  form.addEventListener("submit", async e => {
    e.preventDefault();
    showError("");
    const st = sync.status.state;
    if (st === "signedOut" || st === "reauth") { await beforeSignIn(); sync.signIn(); return; }
    if (st === "needsPassphrase" || st === "needsNewPassphrase") {
      const p = r.pass1.value;
      if (st === "needsNewPassphrase") {
        if (p.length < 8) return showError("Use at least 8 characters.");
        if (p !== r.pass2.value) return showError("The two passphrases don't match.");
      }
      busy = true; r.primary.disabled = true; r.primary.textContent = "Working…";
      try {
        const err = await sync.usePassphrase(p);
        if (err) { showError(err); return; }
        r.pass1.value = r.pass2.value = "";
        dlg.close();
        toast(st === "needsNewPassphrase" ? "Sync is on. Uploading, encrypted." : "Unlocked. Syncing now.");
      } catch (err) {
        showError(navigator.onLine ? "Couldn't reach OneDrive: " + err.message : "You're offline. Try again when you're connected.");
      } finally {
        busy = false;
        if (dlg.open) fill(sync.status);
      }
      return;
    }
    sync.now();
  });
  r.alt.onclick = async () => {
    if (sync.status.state === "needsPassphrase") {
      if (!altArmed) {
        r.alt.classList.add("armed");
        r.alt.textContent = "Select again to remove the encrypted copies in OneDrive (what's on this device stays)";
        altArmed = setTimeout(() => { resetAlt(); fill(sync.status); }, 5000);
        return;
      }
      resetAlt();
      try { await sync.startOver(); } catch (err) { showError("Couldn't reach OneDrive: " + err.message); }
      return;
    }
    await sync.signOut();
    dlg.close();
    toast("Signed out of OneDrive. Everything stays on this device.");
  };

  render();
  return { render, open };
}
