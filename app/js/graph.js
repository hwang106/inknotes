// The OneDrive app folder (Apps/InkNotes) through Microsoft Graph, shaped as the `drive` that
// sync-engine.js expects.
import { accessToken, timeout } from "./auth.js";
import { GRAPH } from "./config.js";

const ROOT = GRAPH + "/me/drive/special/approot";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const path = (folder, name) => (folder ? folder + "/" + name : name).split("/").map(encodeURIComponent).join("/");

function failure(res, what) {
  const e = new Error(`${what} failed (${res.status})`);
  e.status = res.status;
  return e;
}

async function call(url, opts = {}, attempt = 0) {
  const token = await accessToken({ fresh: attempt > 0 && opts._expired });
  // Phones can leave a request hanging (weak signal, app sent to the background): give up and let sync retry.
  const res = await fetch(url, { signal: timeout(opts.method === "PUT" ? 60e3 : 30e3), ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
  if (res.status === 401 && attempt === 0) return call(url, { ...opts, _expired: true }, 1);
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await sleep(Math.min(30, Number(res.headers.get("Retry-After")) || 5) * 1000);
    return call(url, opts, attempt + 1);
  }
  return res;
}

// The folder's files from OneDrive's change feed: the first call lists everything, later calls
// fetch only what changed since. `cache` ({ link, items: { id: { name, etag } } }) is kept in the
// sync state between passes. Returns null if the feed isn't available, so the caller lists instead.
async function listByDelta(folder, cache) {
  let url = cache.link || `${ROOT}:/${path("", folder)}:/delta`, fresh = !cache.link;
  const items = fresh ? {} : { ...cache.items }, urls = {};
  for (;;) {
    const res = await call(url);
    if (res.status === 404 && fresh) { cache.link = null; cache.items = {}; return []; }   // folder not made yet
    if ((res.status === 410 || res.status === 404) && !fresh) {   // OneDrive wants a full re-list, or the folder was removed
      url = `${ROOT}:/${path("", folder)}:/delta`; fresh = true;
      for (const k of Object.keys(items)) delete items[k];
      continue;
    }
    if (!res.ok) return null;
    const j = await res.json();
    for (const i of j.value) {
      if (i.deleted) {
        if (i.id === cache.folderId) for (const k of Object.keys(items)) delete items[k];   // the whole folder went
        delete items[i.id]; continue;
      }
      if (i.folder && i.name === folder) cache.folderId = i.id;
      if (!i.file) continue;
      items[i.id] = { name: i.name, etag: i.eTag };
      if (i["@microsoft.graph.downloadUrl"]) urls[i.id] = i["@microsoft.graph.downloadUrl"];
    }
    if (j["@odata.nextLink"]) { url = j["@odata.nextLink"]; continue; }
    if (!j["@odata.deltaLink"]) return null;
    cache.link = j["@odata.deltaLink"]; cache.items = items;
    // Download links expire, so only links from this response are passed on.
    return Object.entries(items).map(([id, e]) => ({ name: e.name, etag: e.etag, url: urls[id] }));
  }
}

export const graphDrive = {
  // cache: optional object kept between passes; when given, only changes are fetched.
  async list(folder, cache) {
    if (cache && !cache.off) {
      const out = await listByDelta(folder, cache);
      if (out) return out;
      cache.off = true; cache.link = null; cache.items = {};   // feed not supported here: list in full from now on
    }
    const out = [];
    let url = `${ROOT}:/${path("", folder)}:/children?$top=200`;
    while (url) {
      const res = await call(url);
      if (res.status === 404) return out;
      if (!res.ok) throw failure(res, "Reading OneDrive");
      const j = await res.json();
      for (const i of j.value) if (i.file) out.push({ name: i.name, etag: i.eTag, url: i["@microsoft.graph.downloadUrl"] });
      url = j["@odata.nextLink"];
    }
    return out;
  },
  async read(folder, name, entry) {
    let url = entry && entry.url;
    if (!url) {
      const res = await call(`${ROOT}:/${path(folder, name)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw failure(res, "Reading OneDrive");
      url = (await res.json())["@microsoft.graph.downloadUrl"];
    }
    const res = await fetch(url, { signal: timeout(60e3) });   // short-lived pre-signed link: no token needed
    if (res.status === 404) return null;
    if (!res.ok) throw failure(res, "Downloading from OneDrive");
    return new Uint8Array(await res.arrayBuffer());
  },
  async write(folder, name, bytes, ifMatch) {
    const headers = { "Content-Type": "application/octet-stream" };
    if (ifMatch) headers["If-Match"] = ifMatch;
    const res = await call(`${ROOT}:/${path(folder, name)}:/content`, { method: "PUT", headers, body: bytes });
    if (!res.ok) throw failure(res, "Uploading to OneDrive");
    return { etag: (await res.json()).eTag };
  },
  async remove(p) {
    const res = await call(`${ROOT}:/${path("", p)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw failure(res, "Deleting from OneDrive");
  },
};
