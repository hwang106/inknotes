// End-to-end encryption for synced notes. Everything sent to OneDrive is sealed on the device with
// AES-256-GCM, using a key made from your sync passphrase (PBKDF2-SHA256, 600,000 rounds).
// Microsoft only ever stores ciphertext. The passphrase never leaves the device; the key is kept
// in this browser's storage as a non-exportable key.
//
// Sealed format: [1 byte flags][12-byte IV][ciphertext + tag]. Flag bit 1 = gzip before encrypting.
// Each file is bound to its name (as additional data), so files can't be swapped around unnoticed.

const te = new TextEncoder(), td = new TextDecoder();
const ITERATIONS = 600000;
const CHECK = "inknotes-key-check";

export const toB64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pipe(u8, stream) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function seal(key, bytes, name, { compress = true } = {}) {
  const data = compress ? await pipe(bytes, new CompressionStream("gzip")) : bytes;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(name) }, key, data));
  const out = new Uint8Array(13 + ct.length);
  out[0] = compress ? 1 : 0; out.set(iv, 1); out.set(ct, 13);
  return out;
}

export async function unseal(key, sealed, name) {
  const pt = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.subarray(1, 13), additionalData: te.encode(name) }, key, sealed.subarray(13)));
  return sealed[0] & 1 ? pipe(pt, new DecompressionStream("gzip")) : pt;
}

export const sealJSON = (key, obj, name) => seal(key, te.encode(JSON.stringify(obj)), name);
export const unsealJSON = async (key, sealed, name) => JSON.parse(td.decode(await unseal(key, sealed, name)));

// key.json in the OneDrive app folder: the salt plus a sealed check value, so a wrong passphrase
// is caught at once instead of showing up as unreadable notes.
export async function newKeyFile(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const check = await seal(key, te.encode(CHECK), "key.json", { compress: false });
  return { key, file: { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: toB64(salt), check: toB64(check) } };
}

export async function keyFromFile(passphrase, file) {
  const key = await deriveKey(passphrase, fromB64(file.salt), file.iterations || ITERATIONS);
  try {
    if (td.decode(await unseal(key, fromB64(file.check), "key.json")) === CHECK) return key;
  } catch (_) { /* wrong passphrase */ }
  return null;
}
