// Sign-in with a personal Microsoft account (OAuth 2.0 authorization code + PKCE, no server).
// Asks for Files.ReadWrite.AppFolder: the apps can see their own folder in OneDrive
// (Apps/InkNotes) and nothing else. InkTasks' one-time import adds Tasks.Read just for that run.
//
// Shared by InkNotes and InkTasks (same website, so one sign-in serves both).
//
// Microsoft limits single-page apps to sign-ins that last 24 hours. When that runs out, the app
// does a quick silent round-trip to Microsoft on start-up (no password needed while you're still
// signed in to Microsoft in this browser); only if that fails does it ask you to sign in again.

import { CLIENT_ID, AUTHORITY } from "./config.js";

const AUTH = AUTHORITY;
export const BASE_SCOPES = "openid profile offline_access Files.ReadWrite.AppFolder";
const TOKENS = "inknotes-auth";
const PKCE = "inknotes-pkce";

const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomText = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");

function load() { try { return JSON.parse(localStorage.getItem(TOKENS)) || null; } catch (_) { return null; } }
function save(v) { try { v ? localStorage.setItem(TOKENS, JSON.stringify(v)) : localStorage.removeItem(TOKENS); } catch (_) {} }
// A token refresh takes a second or two. If another window holds the lock much longer it was
// probably frozen in the background (phones do this), so take the lock from it.
const withLock = (name, fn) => {
  if (!navigator.locks) return fn();
  if (!AbortSignal.timeout) return navigator.locks.request(name, fn);
  return navigator.locks.request(name, { signal: AbortSignal.timeout(20e3) }, fn)
    .catch(err => { if (err.name === "TimeoutError" || err.name === "AbortError") return navigator.locks.request(name, { steal: true }, fn); throw err; });
};
export const timeout = ms => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

export function account() {
  const a = load();
  return a && a.rt ? { name: a.name || "", user: a.user || "" } : null;
}

// purpose: a short tag handed back by handleRedirect (e.g. "import"); extraScopes: added for this sign-in only.
export async function signIn({ silent = false, extraScopes = "", purpose = "" } = {}) {
  const verifier = randomText(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomText(16);
  const scope = (BASE_SCOPES + " " + extraScopes).trim();
  localStorage.setItem(PKCE, JSON.stringify({ verifier, state, silent, purpose, scope, back: location.search, at: Date.now() }));
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", response_mode: "query", redirect_uri: redirectUri(),
    scope, state, code_challenge: challenge, code_challenge_method: "S256",
  });
  const a = load();
  p.set("prompt", silent ? "none" : "select_account");
  if (a && a.user) p.set("login_hint", a.user);
  location.assign(`${AUTH}/authorize?${p}`);
}

// Call once at start-up. Returns null when this page load isn't a return from Microsoft's sign-in.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has("state") || !(q.has("code") || q.has("error"))) return null;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PKCE)); } catch (_) {}
  localStorage.removeItem(PKCE);
  history.replaceState(null, "", redirectUri() + ((saved && saved.back) || ""));   // drop the code from the address bar
  const info = { silent: !!(saved && saved.silent), purpose: (saved && saved.purpose) || "" };
  if (!saved || saved.state !== q.get("state") || Date.now() - saved.at > 15 * 60e3) return { ...info, error: "stale" };
  if (q.has("error")) return { ...info, error: q.get("error"), description: q.get("error_description") || "" };
  try {
    await withLock("inknotes-token", () => token({
      grant_type: "authorization_code", code: q.get("code"), redirect_uri: redirectUri(),
      code_verifier: saved.verifier, scope: saved.scope || BASE_SCOPES,
    }));
    return { ...info, ok: true };
  } catch (err) {
    return { ...info, error: err.code || "token", description: err.message };
  }
}

async function token(params) {
  const res = await fetch(`${AUTH}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: BASE_SCOPES, ...params }),
    signal: timeout(30e3),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error_description || j.error || `Sign-in failed (${res.status})`); e.code = j.error; throw e; }
  const prev = load() || {};
  let { name, user } = prev;
  if (j.id_token) {
    try {
      const part = j.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))));
      name = claims.name || name; user = claims.preferred_username || claims.email || user;
    } catch (_) {}
  }
  save({ rt: j.refresh_token || prev.rt, at: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000, name, user });
  return j.access_token;
}

export async function accessToken({ fresh = false } = {}) {
  let a = load();
  if (!a || !a.rt) { const e = new Error("Not signed in"); e.signedOut = true; throw e; }
  if (!fresh && a.at && Date.now() < a.exp) return a.at;
  // One refresh at a time across every InkNotes / InkTasks window; a window that waited
  // picks up the token the other one just got.
  return withLock("inknotes-token", async () => {
    const seen = a.at;
    a = load();
    if (!a || !a.rt) { const e = new Error("Not signed in"); e.signedOut = true; throw e; }
    if (a.at && Date.now() < a.exp && (!fresh || a.at !== seen)) return a.at;
    try {
      return await token({ grant_type: "refresh_token", refresh_token: a.rt });
    } catch (err) {
      if (err.code) { const e = new Error("Microsoft sign-in has expired"); e.reauth = true; throw e; }
      throw err;   // offline or similar: try again later
    }
  });
}

export function signOut() { save(null); }
