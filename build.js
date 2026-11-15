/**
 * Static build: generates a Stremio/Nuvio addon as plain JSON files in ./dist
 * so it can be hosted free on GitHub Pages (no server needed).
 *
 *   node build.js            -> dist/manifest.json, dist/catalog/..., dist/meta/..., dist/stream/...
 *
 * Env: PLAYLIST_URL (default: iptv-org Persian playlist)
 */
const fs = require("fs");
const path = require("path");
const {
  parseM3U, buildChannels, toMetaPreview, toMeta, toStreams, ID_PREFIX, CATALOG_ID,
} = require("./server.js");

const PLAYLIST_URL =
  process.env.PLAYLIST_URL || "https://iptv-org.github.io/iptv/languages/fas.m3u";
const OUT = path.join(__dirname, "dist");

function write(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
}

(async () => {
  const res = await fetch(PLAYLIST_URL, { headers: { "User-Agent": "persian-tv-addon/1.0" } });
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const channels = buildChannels(parseM3U(await res.text()));
  if (!channels.length) throw new Error("Playlist parsed to 0 channels — aborting build");

  // Slashes in genre names would break static file paths
  for (const c of channels) c.genres = c.genres.map((g) => g.replace(/[\/\\]/g, "-"));
  const genres = [...new Set(channels.flatMap((c) => c.genres))].sort();

  fs.rmSync(OUT, { recursive: true, force: true });

  write("manifest.json", {
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
        extra: [{ name: "genre", options: genres, isRequired: false }],
      },
    ],
  });

  write(`catalog/tv/${CATALOG_ID}.json`, { metas: channels.map(toMetaPreview) });
  for (const g of genres) {
    write(`catalog/tv/${CATALOG_ID}/genre=${g}.json`, {
      metas: channels.filter((c) => c.genres.includes(g)).map(toMetaPreview),
    });
  }
  for (const c of channels) {
    write(`meta/tv/${c.id}.json`, { meta: toMeta(c) });
    write(`stream/tv/${c.id}.json`, { streams: toStreams(c) });
  }

  write(
    "index.html",
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Persian Live TV Addon</title>
<body style="font-family:system-ui;background:#111;color:#eee;max-width:560px;margin:10vh auto;padding:0 20px">
<h1>📺 Persian Live TV</h1><p>${channels.length} channels · built ${new Date().toISOString()}</p>
<p>In Nuvio: Settings → Addons → paste:</p>
<code id="u" style="background:#222;padding:8px;display:block;word-break:break-all"></code>
<script>document.getElementById("u").textContent=new URL("manifest.json",location.href).href</script>`
  );
  write(".nojekyll", "");
  console.log(`Built ${channels.length} channels, ${genres.length} genres -> ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
