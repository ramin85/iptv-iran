/**
 * Persian Live TV — Stremio-protocol addon (works with Nuvio)
 * Source: https://iptv-org.github.io/iptv/languages/fas.m3u
 *
 * Zero dependencies. Requires Node 18+ (built-in fetch).
 *   node server.js            -> http://localhost:7000/manifest.json
 *
 * Env vars:
 *   PORT          (default 7000)
 *   PLAYLIST_URL  (default: the iptv-org Persian playlist)
 *   REFRESH_MIN   (default 360) minutes between playlist refreshes
 *   CHECK_STREAMS (default "0") set to "1" to hide channels whose URL fails a HEAD/GET probe (slower)
 */
const http = require("http");

const PORT = Number(process.env.PORT || 7000);
const PLAYLIST_URL =
  process.env.PLAYLIST_URL || "https://iptv-org.github.io/iptv/languages/fas.m3u";
const REFRESH_MS = Number(process.env.REFRESH_MIN || 360) * 60 * 1000;
const CHECK_STREAMS = process.env.CHECK_STREAMS === "1";
const PAGE_SIZE = 100;
const ID_PREFIX = "persiantv_";
const CATALOG_ID = "persiantv-live";

// ---------------------------------------------------------------- M3U parsing
function parseAttrs(str) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = m[2];
  return attrs;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",", line.indexOf('"') === -1 ? 0 : line.lastIndexOf('"'));
      const head = comma === -1 ? line : line.slice(0, comma);
      const title = comma === -1 ? "" : line.slice(comma + 1).trim();
      cur = { attrs: parseAttrs(head), title, headers: {} };
    } else if (line.startsWith("#EXTVLCOPT:") && cur) {
      const [k, ...v] = line.slice(11).split("=");
      const val = v.join("=");
      if (k === "http-referrer" || k === "http-referer") cur.headers["Referer"] = val;
      else if (k === "http-user-agent") cur.headers["User-Agent"] = val;
      else if (k === "http-origin") cur.headers["Origin"] = val;
    } else if (line.startsWith("#EXTHTTP:") && cur) {
      try {
        Object.assign(cur.headers, JSON.parse(line.slice(9)));
      } catch (_) {}
    } else if (!line.startsWith("#") && cur) {
      cur.url = line;
      entries.push(cur);
      cur = null;
    }
  }
  return entries;
}

// "Channel Name (720p) [Geo-blocked]" -> { name, quality, flags }
function splitTitle(title) {
  let name = title;
  let quality = "";
  const flags = [];
  const q = name.match(/\((\d{3,4}[pi])\)/i);
  if (q) {
    quality = q[1];
    name = name.replace(q[0], "");
  }
  name = name.replace(/\[([^\]]+)\]/g, (_, f) => {
    flags.push(f);
    return "";
  });
  return { name: name.replace(/\s+/g, " ").trim(), quality, flags };
}

function slug(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildChannels(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!/^https?:\/\//i.test(e.url || "")) continue;
    const { name, quality, flags } = splitTitle(e.title || e.attrs["tvg-name"] || "");
    if (!name) continue;
    const tvgId = (e.attrs["tvg-id"] || "").trim();
    const key = slug(tvgId || name) || slug(e.url);
    let ch = map.get(key);
    if (!ch) {
      ch = {
        id: ID_PREFIX + key,
        name,
        logo: e.attrs["tvg-logo"] || "",
        genres: [],
        language: e.attrs["tvg-language"] || "Persian",
        country: e.attrs["tvg-country"] || "",
        streams: [],
      };
      map.set(key, ch);
    }
    if (!ch.logo && e.attrs["tvg-logo"]) ch.logo = e.attrs["tvg-logo"];
    for (const g of (e.attrs["group-title"] || "").split(";")) {
      const gt = g.trim();
      if (gt && !ch.genres.includes(gt)) ch.genres.push(gt);
    }
    if (!ch.streams.some((s) => s.url === e.url)) {
      ch.streams.push({ url: e.url, quality, flags, headers: e.headers });
    }
  }
  const list = [...map.values()];
  for (const ch of list) {
    if (!ch.genres.length) ch.genres.push("Undefined");
    ch.streams.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// -------------------------------------------------------------------- Cache
let channels = [];
let byId = new Map();
let genres = [];
let lastLoad = 0;
let loading = null;

async function probe(url, headers) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { headers, signal: ctl.signal });
    clearTimeout(t);
    try { await r.body?.cancel(); } catch (_) {}
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function loadPlaylist() {
  const res = await fetch(PLAYLIST_URL, { headers: { "User-Agent": "persian-tv-addon/1.0" } });
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const text = await res.text();
  let list = buildChannels(parseM3U(text));

  if (CHECK_STREAMS) {
    const keep = [];
    const queue = [...list];
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (queue.length) {
          const ch = queue.shift();
          const ok = [];
          for (const s of ch.streams) if (await probe(s.url, s.headers)) ok.push(s);
          if (ok.length) keep.push({ ...ch, streams: ok });
        }
      })
    );
    list = keep.sort((a, b) => a.name.localeCompare(b.name));
  }

  channels = list;
  byId = new Map(list.map((c) => [c.id, c]));
  genres = [...new Set(list.flatMap((c) => c.genres))].sort();
  lastLoad = Date.now();
  console.log(`[playlist] ${list.length} channels, ${genres.length} categories`);
}

async function ensureFresh() {
  const stale = Date.now() - lastLoad > REFRESH_MS;
  if (channels.length && !stale) return;
  if (!loading) {
    loading = loadPlaylist()
      .catch((e) => console.error("[playlist] load failed:", e.message))
      .finally(() => (loading = null));
  }
  // Serve stale data immediately if we have it; otherwise wait.
  if (!channels.length) await loading;
}

// ----------------------------------------------------------------- Protocol
function manifest() {
  return {
    id: "community.persian.livetv",
    version: "1.0.0",
    name: "Persian Live TV",
    description: "Live Persian (Farsi) TV channels from the iptv-org community playlist.",
    logo: "https://iptv-org.github.io/iptv/favicon.ico",
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: [ID_PREFIX],
    catalogs: [
      {
        type: "tv",
        id: CATALOG_ID,
        name: "Persian Live TV",
        extra: [
          { name: "genre", options: genres, isRequired: false },
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false },
        ],
      },
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

function toMetaPreview(c) {
  return {
    id: c.id,
    type: "tv",
    name: c.name,
    poster: c.logo || undefined,
    posterShape: "square",
    logo: c.logo || undefined,
    background: c.logo || undefined,
    genres: c.genres,
  };
}

function toMeta(c) {
  return {
    ...toMetaPreview(c),
    description: `Live TV — ${c.name}\nCategories: ${c.genres.join(", ")}\nStreams available: ${c.streams.length}`,
    language: c.language,
    country: c.country || undefined,
    releaseInfo: "LIVE",
  };
}

function toStreams(c) {
  return c.streams.map((s, i) => {
    const hints = { notWebReady: true };
    if (Object.keys(s.headers).length) {
      hints.proxyHeaders = { request: s.headers };
    }
    const tag = [s.quality, ...s.flags].filter(Boolean).join(" · ");
    return {
      url: s.url,
      name: "Persian TV",
      title: tag ? `${c.name} — ${tag}` : `${c.name}${c.streams.length > 1 ? ` (#${i + 1})` : ""}`,
      behaviorHints: hints,
    };
  });
}

function parseExtra(seg) {
  const extra = {};
  if (!seg) return extra;
  for (const part of seg.split("&")) {
    const i = part.indexOf("=");
    if (i > 0) extra[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return extra;
}

function route(pathname) {
  const p = pathname.replace(/\.json$/, "");
  const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "manifest") return { kind: "manifest" };
  if (parts[0] === "catalog" && parts.length >= 3) {
    return { kind: "catalog", type: parts[1], id: parts[2], extra: parseExtra(parts[3]) };
  }
  if (parts[0] === "meta" && parts.length >= 3) return { kind: "meta", type: parts[1], id: parts.slice(2).join("/") };
  if (parts[0] === "stream" && parts.length >= 3) return { kind: "stream", type: parts[1], id: parts.slice(2).join("/") };
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { ...CORS, "Content-Type": type, ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function landingPage(host, proto) {
  const base = `${proto}://${host}`;
  const manifestUrl = `${base}/manifest.json`;
  const stremio = `stremio://${host}/manifest.json`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Persian Live TV Addon</title>
<style>body{font-family:system-ui;background:#111;color:#eee;max-width:560px;margin:10vh auto;padding:0 20px}
code{background:#222;padding:8px 10px;border-radius:6px;display:block;word-break:break-all;margin:8px 0}
a.b{display:inline-block;background:#7c5cff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;margin-top:8px}</style>
<h1>📺 Persian Live TV</h1>
<p>${channels.length} channels · ${genres.length} categories · refreshed ${new Date(lastLoad).toISOString()}</p>
<p>In <b>Nuvio</b>: Settings → Addons → paste this URL:</p>
<code>${manifestUrl}</code>
<a class="b" href="${stremio}">Open in Stremio</a>`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") return send(res, 200, { ok: true, channels: channels.length });

  try {
    await ensureFresh();
  } catch (e) {
    console.error(e);
  }

  if (url.pathname === "/") {
    const proto = req.headers["x-forwarded-proto"] || "http";
    return send(res, 200, landingPage(req.headers.host, proto), "text/html; charset=utf-8");
  }

  const r = route(url.pathname);
  if (!r) return send(res, 404, { error: "Not found" });

  if (r.kind === "manifest") return send(res, 200, manifest());

  if (r.kind === "catalog") {
    if (r.type !== "tv" || r.id !== CATALOG_ID) return send(res, 200, { metas: [] });
    // Stremio also allows extras as query string
    const extra = { ...Object.fromEntries(url.searchParams), ...r.extra };
    let list = channels;
    if (extra.genre) list = list.filter((c) => c.genres.includes(extra.genre));
    if (extra.search) {
      const q = extra.search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    const skip = Math.max(0, parseInt(extra.skip || "0", 10) || 0);
    return send(res, 200, { metas: list.slice(skip, skip + PAGE_SIZE).map(toMetaPreview) }, undefined, {
      "Cache-Control": "max-age=300",
    });
  }

  const ch = byId.get(r.id);
  if (r.kind === "meta") {
    return send(res, 200, ch ? { meta: toMeta(ch) } : { meta: null });
  }
  if (r.kind === "stream") {
    return send(res, 200, { streams: ch ? toStreams(ch) : [] }, undefined, { "Cache-Control": "max-age=60" });
  }
});

if (require.main === module) {
  ensureFresh().finally(() =>
    server.listen(PORT, () => console.log(`Addon running: http://localhost:${PORT}/manifest.json`))
  );
}

module.exports = { parseM3U, buildChannels, splitTitle, toMetaPreview, toMeta, toStreams, ID_PREFIX, CATALOG_ID };
