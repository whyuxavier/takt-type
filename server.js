"use strict";
// Takt backend: zero dependencies, requires Node.js 18+.
// Serves index.html and GET /api/subtitles?v=VIDEO_ID
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";          // e.g. https://user.github.io (empty = same-origin only)
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const CLIENT_VERSION = process.env.YT_CLIENT_VERSION || "20.10.38";
const PREFERRED_LANG = process.env.PREFERRED_LANG || "uk";
const FETCH_TIMEOUT_MS = 10000;

const cache = new Map();   // videoId -> { at, data }
const hits = new Map();    // ip -> [timestamps]
const CACHE_TTL = 60 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now); hits.set(ip, list);
  return list.length > RATE_LIMIT_PER_MIN;
}

class SubError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }

async function ytFetch(url, opts = {}) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) { throw new SubError("service_unavailable", 502); }
}

// Unofficial route: the same caption-track list the YouTube mobile client uses.
// The official Data API captions.download requires OAuth of the video OWNER, so it cannot be used for arbitrary videos.
async function getTracks(videoId) {
  const res = await ytFetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `com.google.android.youtube/${CLIENT_VERSION} (Linux; U; Android 14) gzip` },
    body: JSON.stringify({ context: { client: { clientName: "ANDROID", clientVersion: CLIENT_VERSION, androidSdkVersion: 34, hl: "uk" } }, videoId })
  });
  if (res.status === 429) throw new SubError("rate_limited", 429);
  if (!res.ok) throw new SubError("service_unavailable", 502);
  let json; try { json = await res.json(); } catch (e) { throw new SubError("malformed", 502); }
  const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || !tracks.length) throw new SubError("no_subtitles", 404);
  return tracks;
}

function pickTrack(tracks) {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const asr = tracks.filter((t) => t.kind === "asr");
  const isPref = (t) => (t.languageCode || "").toLowerCase().startsWith(PREFERRED_LANG);
  return manual.find(isPref) || asr.find(isPref) || manual[0] || asr[0];
}

function parseJson3(json) {
  const cues = [];
  for (const ev of json?.events || []) {
    if (!Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
  }
  return cues;
}

async function loadSubtitles(videoId) {
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const track = pickTrack(await getTracks(videoId));
  if (!track || !track.baseUrl) throw new SubError("no_subtitles", 404);
  const u = new URL(track.baseUrl);
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) throw new SubError("malformed", 502);
  u.searchParams.set("fmt", "json3");
  const res = await ytFetch(u.toString());
  if (res.status === 429) throw new SubError("rate_limited", 429);
  if (!res.ok) throw new SubError("subtitles_unreachable", 502);
  let json; try { json = await res.json(); } catch (e) { throw new SubError("malformed", 502); }
  const cues = parseJson3(json);
  if (!cues.length) throw new SubError("malformed", 502);
  const data = { lang: track.languageCode || "", name: track.name?.simpleText || track.name?.runs?.[0]?.text || "", auto: track.kind === "asr", cues };
  cache.set(videoId, { at: Date.now(), data });
  return data;
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cors = ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Vary": "Origin" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }

  if (url.pathname === "/api/health") return send(res, 200, { ok: true }, cors);

  if (url.pathname === "/api/subtitles" && req.method === "GET") {
    const id = url.searchParams.get("v") || "";
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return send(res, 400, { error: "invalid_video_id" }, cors);
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: "rate_limited" }, cors);
    try { return send(res, 200, await loadSubtitles(id), cors); }
    catch (e) {
      console.error(new Date().toISOString(), "subtitles error", id, e.code || e.message);
      return send(res, e.status || 500, { error: e.code || "internal" }, cors);
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return fs.readFile(path.join(__dirname, "index.html"), (err, buf) => {
      if (err) { res.writeHead(500); return res.end("index.html not found"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(buf);
    });
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Takt: http://localhost:${PORT}`));
