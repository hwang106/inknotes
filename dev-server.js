// Tiny local web server for developing InkNotes and InkTasks, laid out like GitHub Pages:
//   http://localhost:5173/inknotes/  -> ./app            (also at / for older bookmarks)
//   http://localhost:5173/inktasks/  -> ../InkTasks/app
//   http://localhost:5173/inkboard/  -> ../InkBoard/app
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
const MOUNTS = [["/inknotes/", ROOT], ["/inktasks/", path.join(__dirname, "..", "InkTasks", "app")], ["/inkboard/", path.join(__dirname, "..", "InkBoard", "app")], ["/", ROOT]];

const FAKE = !!process.env.FAKE_MS || process.argv.includes("--fake-ms");
const PORT_ARG = process.argv.find(a => /^--port=\d+$/.test(a));
const PORT = Number(PORT_ARG ? PORT_ARG.slice(7) : process.env.PORT) || 5173;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp",
};

// ---------- pretend Microsoft ----------
const files = new Map();   // "notes/x.json" -> { bytes, etag }
const removed = [];   // { id, ver } for the delta feed
let verN = 0, deltaCalls = 0, childrenCalls = 0;
let etagN = 0, tokenN = 0, expireNext = false, silentFails = false, tasksGranted = false;
// Pretend Microsoft To Do, for testing InkTasks' import.
const TODO = [
  { id: "L1=", displayName: "Tasks", wellknownListName: "defaultList", tasks: [
    { id: "T1/a=", title: "Renew library card", status: "notStarted", importance: "high", body: { content: "Bring ID", contentType: "text" },
      dueDateTime: { dateTime: "2026-12-01T00:00:00.0000000", timeZone: "UTC" }, createdDateTime: "2026-11-01T10:00:00Z", lastModifiedDateTime: "2026-11-02T10:00:00Z" },
    { id: "T2/b=", title: "Water plants", status: "notStarted", importance: "normal", body: { content: "", contentType: "text" },
      recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "thursday"] } },
      dueDateTime: { dateTime: "2026-11-24T00:00:00.0000000", timeZone: "UTC" }, isReminderOn: true,
      reminderDateTime: { dateTime: "2026-11-24T14:00:00.0000000", timeZone: "UTC" }, createdDateTime: "2026-10-01T10:00:00Z", lastModifiedDateTime: "2026-11-20T10:00:00Z" },
  ] },
  { id: "L2=", displayName: "Groceries", wellknownListName: "none", tasks: [
    { id: "T3/c=", title: "Weekly shop", status: "notStarted", importance: "normal", body: { content: "<p>Check the <b>coupons</b></p>", contentType: "html" },
      checklistItems: [{ displayName: "Milk", isChecked: true }, { displayName: "Eggs", isChecked: false }],
      createdDateTime: "2026-11-10T10:00:00Z", lastModifiedDateTime: "2026-11-21T10:00:00Z" },
    { id: "T4/d=", title: "Buy coffee", status: "completed", importance: "normal", body: { content: "", contentType: "text" },
      completedDateTime: { dateTime: "2026-11-15T00:00:00.0000000", timeZone: "UTC" }, createdDateTime: "2026-11-09T10:00:00Z", lastModifiedDateTime: "2026-11-15T10:00:00Z" },
  ] },
  { id: "L3=", displayName: "Flagged email", wellknownListName: "flaggedEmails", tasks: [{ id: "T5=", title: "Re: budget", status: "notStarted" }] },
];
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
    if (form.get("grant_type") === "authorization_code") { expireNext = false; silentFails = false; tasksGranted = /Tasks\.Read/.test(form.get("scope") || ""); }
    if (form.get("grant_type") === "refresh_token" && expireNext) { return json(res, 400, { error: "invalid_grant", error_description: "AADSTS700084: refresh token expired" }), true; }
    if (!form.get("client_id")) return json(res, 400, { error: "invalid_request" }), true;
    const id = b64url({ alg: "none" }) + "." + b64url({ name: "Test User", preferred_username: "test.user@example.com" }) + ".sig";
    return json(res, 200, { access_token: "fake-at-" + (++tokenN), refresh_token: "fake-rt-" + tokenN, expires_in: 3600, id_token: id }), true;
  }
  if (p === "/__fake/calls") return json(res, 200, { delta: deltaCalls, children: childrenCalls }), true;
  if (p === "/__fake/state") {
    return json(res, 200, [...files].map(([k, f]) => ({ path: k, size: f.bytes.length, etag: f.etag, text: k === "key.json" ? f.bytes.toString() : undefined }))), true;
  }
  if (p === "/__fake/expire" && req.method === "POST") { expireNext = true; silentFails = url.searchParams.has("silentFails"); return json(res, 200, { ok: true }), true; }
  if (p.startsWith("/__fake/dl/")) {
    const f = files.get(decodeURIComponent(p.slice("/__fake/dl/".length)));
    if (!f) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(f.bytes); return true;
  }
  const T = "/__fake/graph/v1.0/me/todo/lists";
  if (p.startsWith(T)) {
    if (!/^Bearer fake-at-/.test(req.headers.authorization || "")) return json(res, 401, { error: { code: "InvalidAuthenticationToken" } }), true;
    if (!tasksGranted) return json(res, 403, { error: { code: "Forbidden", message: "Missing Tasks.Read" } }), true;
    const rest = decodeURIComponent(p.slice(T.length));
    if (!rest) return json(res, 200, { value: TODO.map(({ tasks, ...l }) => l) }), true;
    const m = /^\/([^/]+)\/tasks$/.exec(rest);
    const list = m && TODO.find(l => l.id === m[1]);
    if (!list) return json(res, 404, { error: { code: "itemNotFound" } }), true;
    // two pages, to exercise paging
    const page = Number(url.searchParams.get("page") || 0), items = list.tasks.slice(page, page + 1);
    const out = { value: items };
    if (page + 1 < list.tasks.length) out["@odata.nextLink"] = `${url.origin}${T}/${encodeURIComponent(list.id)}/tasks?page=${page + 1}`;
    return json(res, 200, out), true;
  }
  const G = "/__fake/graph/v1.0/me/drive/special/approot";
  if (p.startsWith(G)) {
    if (!/^Bearer fake-at-/.test(req.headers.authorization || "")) return json(res, 401, { error: { code: "InvalidAuthenticationToken" } }), true;
    if (p === G && req.method === "GET") return json(res, 200, { id: "fake-approot", name: "InkNotes", parentReference: { driveId: "fake-drive", driveType: "personal" } }), true;
    const m = /^:\/(.+?)(:\/(children|content|delta))?$/.exec(decodeURIComponent(p.slice(G.length)));
    if (!m) return json(res, 400, { error: { code: "invalidRequest" } }), true;
    const item = m[1], action = m[3];
    const meta = k => ({ name: k.split("/").pop(), eTag: files.get(k).etag, file: {}, "@microsoft.graph.downloadUrl": `${url.origin}/__fake/dl/${encodeURIComponent(k)}` });
    if (action === "delta" && req.method === "GET") {
      // Like OneDrive personal: everything under the folder changed since the token, plus removals.
      deltaCalls++;
      const since = Number(url.searchParams.get("token") || 0);
      const kids = [...files.keys()].filter(k => k.startsWith(item + "/"));
      if (!kids.length && !since) return json(res, 404, { error: { code: "itemNotFound" } }), true;
      const value = [{ id: item, name: item, folder: {} }, ...kids.filter(k => files.get(k).ver > since).map(k => ({ id: k, ...meta(k) })),
        ...removed.filter(r => r.ver > since && r.id.startsWith(item + "/")).map(r => ({ id: r.id, deleted: {} }))];
      return json(res, 200, { value, "@odata.deltaLink": `${url.origin}${G}:/${item}:/delta?token=${verN}` }), true;
    }
    if (action === "children" && req.method === "GET") {
      childrenCalls++;
      const kids = [...files.keys()].filter(k => k.startsWith(item + "/") && !k.slice(item.length + 1).includes("/"));
      if (!kids.length) return json(res, 404, { error: { code: "itemNotFound" } }), true;
      return json(res, 200, { value: kids.map(meta) }), true;
    }
    if (action === "content" && req.method === "PUT") {
      const f = files.get(item), want = req.headers["if-match"];
      if (want && (!f || f.etag !== want)) return json(res, 412, { error: { code: "resourceModified" } }), true;
      files.set(item, { bytes: await readBody(req), etag: `"{fake-${++etagN}},1"`, ver: ++verN });
      return json(res, f ? 200 : 201, meta(item)), true;
    }
    if (!action && req.method === "GET") return files.has(item) ? json(res, 200, meta(item)) : json(res, 404, { error: { code: "itemNotFound" } }), true;
    if (!action && req.method === "DELETE") {
      for (const k of [...files.keys()]) if (k === item || k.startsWith(item + "/")) { files.delete(k); removed.push({ id: k, ver: ++verN }); }
      res.writeHead(204); res.end(); return true;
    }
    return json(res, 405, {}), true;
  }
  if (p === "/inktasks/js/config.js") {
    // Point InkTasks at the reminder service from InkTasks/worker/dev.mjs, if it has been run.
    let vapid = "";
    try { vapid = JSON.parse(fs.readFileSync(path.join(__dirname, "../InkTasks/worker/.dev/vapid.json"), "utf8")).publicKey; } catch (_) { /* not run yet */ }
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(`export const REMINDER_SERVICE = "${vapid ? "http://localhost:8787" : ""}";
export const VAPID_PUBLIC = "${vapid}";
`);
    return true;
  }
  if (p === "/js/config.js" || p === "/inknotes/js/config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(`export const CLIENT_ID = "fake-client";\nexport const AUTHORITY = "${url.origin}/__fake/oauth";\nexport const GRAPH = "${url.origin}/__fake/graph/v1.0";\n`);
    return true;
  }
  return false;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (FAKE && await fake(req, res, url)) return;
  const fullPath = decodeURIComponent(url.pathname);
  if (fullPath === "/inknotes" || fullPath === "/inktasks" || fullPath === "/inkboard") { res.writeHead(301, { Location: fullPath + "/" }); res.end(); return; }
  const [mount, base] = MOUNTS.find(([m]) => fullPath.startsWith(m));
  const urlPath = "/" + fullPath.slice(mount.length);
  let file = path.normalize(path.join(base, urlPath));
  if (!file.startsWith(base)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (urlPath.endsWith("/")) file = path.join(file, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`InkNotes dev server${FAKE ? " (pretend Microsoft)" : ""}: http://localhost:${PORT}/`));
