// The OneDrive app folder (Apps/InkNotes) through Microsoft Graph, shaped as the `drive` that
// sync-engine.js expects.
import { accessToken } from "./auth.js";
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
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
  if (res.status === 401 && attempt === 0) return call(url, { ...opts, _expired: true }, 1);
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await sleep(Math.min(30, Number(res.headers.get("Retry-After")) || 5) * 1000);
    return call(url, opts, attempt + 1);
  }
  return res;
}

export const graphDrive = {
  async list(folder) {
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
    const res = await fetch(url);   // short-lived pre-signed link: no token needed
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
