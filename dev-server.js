// Tiny local web server for developing InkNotes: serves ./app on http://localhost:5173.
// Run: node dev-server.js
//
// FAKE_MS=1 node dev-server.js  adds a pretend Microsoft sign-in and OneDrive app folder (kept in
// memory), so sync can be tested end to end without a real account. Open the app on
// http://localhost:5173 and http://127.0.0.1:5173 to get two "devices" with separate storage.
// GET /__fake/state shows what the pretend OneDrive holds; POST /__fake/expire makes token refreshes fail until the
// next sign-in (as when Microsoft's 24-hour sign-in limit runs out).
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "app");

const FAKE = !!process.env.FAKE_MS || process.argv.includes("--fake-ms");
const PORT_ARG = process.argv.find(a => /^--port=\d+$/.test(a));
const PORT = Number(PORT_ARG ? PORT_ARG.slice(7) : process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp",
};

// ---------- pretend Microsoft ----------
const files = new Map();   // "notes/x.json" -> { bytes, etag }
let etagN = 0, tokenN = 0, expireNext = false, silentFails = false;
const b64url = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const json = (res, code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

async function fake(req, res, url) {
  const p = url.pathname;
  if (p === "/__fake/oauth/authorize") {
    const q = url.searchParams, back = new URL(q.get("redirect_uri"));
    if (q.get("prompt") === "none" && silentFails) { back.searchParams.set("error", "login_required"); back.searchParams.set("state", q.get("state")); }
    else { back.searchParams.set("code", "fake-code"); back.searchParams.set("state", q.get("state")); }
    res.writeHead(302, { Location: back.href }); res.end(); return true;
  }
  if (p === "/__fake/oauth/token") {
    const form = new URLSearchParams((await readBody(req)).toString());
    if (form.get("grant_type") === "authorization_code") { expireNext = false; silentFails = false; }
    if (form.get("grant_type") === "refresh_token" && expireNext) { return json(res, 400, { error: "invalid_grant", error_description: "AADSTS700084: refresh token expired" }), true; }
    if (!form.get("client_id")) return json(res, 400, { error: "invalid_request" }), true;
    const id = b64url({ alg: "none" }) + "." + b64url({ name: "Test User", preferred_username: "test.user@example.com" }) + ".sig";
    return json(res, 200, { access_token: "fake-at-" + (++tokenN), refresh_token: "fake-rt-" + tokenN, expires_in: 3600, id_token: id }), true;
  }
  if (p === "/__fake/state") {
    return json(res, 200, [...files].map(([k, f]) => ({ path: k, size: f.bytes.length, etag: f.etag, text: k === "key.json" ? f.bytes.toString() : undefined }))), true;
  }
  if (p === "/__fake/expire" && req.method === "POST") { expireNext = true; silentFails = url.searchParams.has("silentFails"); return json(res, 200, { ok: true }), true; }
  if (p.startsWith("/__fake/dl/")) {
    const f = files.get(decodeURIComponent(p.slice("/__fake/dl/".length)));
    if (!f) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(f.bytes); return true;
  }
  const G = "/__fake/graph/v1.0/me/drive/special/approot";
  if (p.startsWith(G)) {
    if (!/^Bearer fake-at-/.test(req.headers.authorization || "")) return json(res, 401, { error: { code: "InvalidAuthenticationToken" } }), true;
    const m = /^:\/(.+?)(:\/(children|content))?$/.exec(decodeURIComponent(p.slice(G.length)));
    if (!m) return json(res, 400, { error: { code: "invalidRequest" } }), true;
    const item = m[1], action = m[3];
    const meta = k => ({ name: k.split("/").pop(), eTag: files.get(k).etag, file: {}, "@microsoft.graph.downloadUrl": `${url.origin}/__fake/dl/${encodeURIComponent(k)}` });
    if (action === "children" && req.method === "GET") {
      const kids = [...files.keys()].filter(k => k.startsWith(item + "/") && !k.slice(item.length + 1).includes("/"));
      if (!kids.length) return json(res, 404, { error: { code: "itemNotFound" } }), true;
      return json(res, 200, { value: kids.map(meta) }), true;
    }
    if (action === "content" && req.method === "PUT") {
      const f = files.get(item), want = req.headers["if-match"];
      if (want && (!f || f.etag !== want)) return json(res, 412, { error: { code: "resourceModified" } }), true;
      files.set(item, { bytes: await readBody(req), etag: `"{fake-${++etagN}},1"` });
      return json(res, f ? 200 : 201, meta(item)), true;
    }
    if (!action && req.method === "GET") return files.has(item) ? json(res, 200, meta(item)) : json(res, 404, { error: { code: "itemNotFound" } }), true;
    if (!action && req.method === "DELETE") {
      for (const k of [...files.keys()]) if (k === item || k.startsWith(item + "/")) files.delete(k);
      res.writeHead(204); res.end(); return true;
    }
    return json(res, 405, {}), true;
  }
  if (p === "/js/config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(`export const CLIENT_ID = "fake-client";\nexport const AUTHORITY = "${url.origin}/__fake/oauth";\nexport const GRAPH = "${url.origin}/__fake/graph/v1.0";\n`);
    return true;
  }
  return false;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (FAKE && await fake(req, res, url)) return;
  const urlPath = decodeURIComponent(url.pathname);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (urlPath.endsWith("/")) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`InkNotes dev server${FAKE ? " (pretend Microsoft)" : ""}: http://localhost:${PORT}/`));
