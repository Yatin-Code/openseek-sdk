// OpenSeek JS SDK — dependency-free browser client (v0.1.0).
// Lookup once (registry /v1/sprites), resolve any positionMs to a sheet crop,
// blit the tile to a canvas. The registry keys every lookup: pass `apiKey` and
// it is sent as X-API-Key (see docs/wire.md, "Auth").
//
// Pure logic mirrors the Kotlin core (query building, VTT parse, floor lookup
// with coverage bound). Supersedes sdk/js/peek.js, which hit the local-origin
// /sprites path, dropped the #xywh box from parsed cues, and had no
// covered_until_ms bound (stale tail tile past partial coverage).

const DEFAULT_BASE = "https://tiles.example.com";

/** Build a movie lookup URL: {tmdb_id?, imdb_id?, duration_ms}. */
export function movieUrl(base = DEFAULT_BASE, { tmdb_id, imdb_id, duration_ms }) {
  if (tmdb_id == null && imdb_id == null) throw new Error("movie query needs tmdb_id or imdb_id");
  const q = new URLSearchParams();
  if (tmdb_id != null) q.set("tmdb_id", String(tmdb_id));
  else q.set("imdb_id", String(imdb_id));
  q.set("duration_ms", String(duration_ms));
  return `${base.replace(/\/$/, "")}/v1/sprites?${q}`;
}

/** Build an episode lookup URL: {show_tmdb_id?, show_imdb_id?, season, episode, duration_ms}. */
export function episodeUrl(base = DEFAULT_BASE, { show_tmdb_id, show_imdb_id, season, episode, duration_ms }) {
  if (show_tmdb_id == null && show_imdb_id == null) throw new Error("episode query needs show_tmdb_id or show_imdb_id");
  const q = new URLSearchParams();
  if (show_tmdb_id != null) q.set("show_tmdb_id", String(show_tmdb_id));
  else q.set("show_imdb_id", String(show_imdb_id));
  q.set("season", String(season));
  q.set("episode", String(episode));
  q.set("duration_ms", String(duration_ms));
  return `${base.replace(/\/$/, "")}/v1/sprites?${q}`;
}

/** Parse "HH:MM:SS.mmm" (zero-padded hours past the 1h mark); tolerates "MM:SS.mmm". Null when invalid. */
export function parseVttTimestamp(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secParts = parts[parts.length - 1].split(".");
  const seconds = Number(secParts[0]);
  const millis = secParts.length > 1 ? Number(secParts[1].padEnd(3, "0").slice(0, 3)) : 0;
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || millis < 0 || millis > 999) return null;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
}

function parseCuePayload(payload, vttBase) {
  const hash = payload.indexOf("#xywh=");
  if (hash < 0) return null;
  const rawUrl = payload.slice(0, hash).trim();
  const imageUrl = /^https?:\/\//.test(rawUrl) ? rawUrl : `${vttBase}/${rawUrl}`;
  const box = payload.slice(hash + "#xywh=".length).split(",").map((s) => Number(s.trim()));
  if (box.length !== 4 || !box.every((n) => Number.isInteger(n) && n >= 0)) return null;
  const [x, y, w, h] = box;
  return { imageUrl, x, y, w, h };
}

/**
 * Parse registry WebVTT text into time-ordered cues
 * [{startMs, imageUrl, x, y, w, h}]. Cues without a valid #xywh payload are
 * skipped (silent miss for that slot). Sheet-relative payloads resolve against
 * the VTT URL's directory.
 */
export function parseVtt(text, vttUrl) {
  const vttBase = vttUrl.slice(0, vttUrl.lastIndexOf("/")).replace(/\/$/, "");
  const cues = [];
  let pendingStartMs = null;
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (line === "") { pendingStartMs = null; continue; }
    if (line.includes("-->")) { pendingStartMs = parseVttTimestamp(line.split("-->")[0]); continue; }
    if (line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue;
    if (pendingStartMs == null) continue;
    const startMs = pendingStartMs;
    pendingStartMs = null;
    const cue = parseCuePayload(line, vttBase);
    if (!cue) continue;
    cues.push({ startMs, ...cue });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}

/**
 * Floor semantics: last cue at or before positionMs, corrected by the registry
 * scale (scale = local duration / source duration). Null = no preview, hide it.
 *
 * A partial (`pending`) version stays silent past its coverage end instead of
 * showing a stale tail tile: pass coveredUntilMs (registry `covered_until_ms`,
 * source time), or leave the default, which reads it off the track. Pass null
 * to lift the bound.
 */
export function thumbnailFor(track, positionMs, coveredUntilMs = track.covered_until_ms ?? track.coveredUntilMs ?? null) {
  const scale = track.scale > 0 ? track.scale : 1;
  const pos = Math.trunc(positionMs / scale);
  if (coveredUntilMs != null && pos > coveredUntilMs) return null;
  let hit = null;
  for (const c of track.cues) {
    if (c.startMs <= pos) hit = c;
    else break;
  }
  return hit;
}

/**
 * Full lookup: GET /v1/sprites -> parse envelope -> GET vtt_url -> track.
 * Returns null on 404 (unknown title) — the caller hides the preview.
 *
 * `apiKey` is required by the live registry and sent as X-API-Key when
 * non-blank; blank/null/undefined omits the header (which 401s against a
 * keyed registry — the thrown message says "HTTP 401"). It goes on the
 * lookup only, never on the VTT fetch: that URL usually points at the CDN.
 * `fetchFn` defaults to global fetch (inject a mock in tests).
 */
export async function loadTrack(registryUrl, { fetchFn = fetch, apiKey } = {}) {
  const key = apiKey == null ? "" : String(apiKey).trim();
  const res = await fetchFn(registryUrl, key ? { headers: { "X-API-Key": key } } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookup failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body.vtt_url) throw new Error("lookup response missing vtt_url");
  const vttRes = await fetchFn(body.vtt_url);
  if (!vttRes.ok) throw new Error(`VTT fetch failed: HTTP ${vttRes.status}`);
  const vttText = await vttRes.text();
  return {
    ...body,
    vttUrl: body.vtt_url,
    sourceDurationMs: body.source_duration_ms ?? 0,
    coveredUntilMs: body.covered_until_ms ?? null,
    cues: parseVtt(vttText, body.vtt_url),
  };
}

/** Convenience: build the movie URL and look it up. `opts` carries {apiKey}. */
export function loadMovieTrack(base, params, opts) {
  return loadTrack(movieUrl(base, params), opts);
}

/** Convenience: build the episode URL and look it up. `opts` carries {apiKey}. */
export function loadEpisodeTrack(base, params, opts) {
  return loadTrack(episodeUrl(base, params), opts);
}

// -- sheets: download + in-memory LRU (max 32) -------------------------------

const sheetCache = new Map(); // url -> HTMLImageElement (insertion order = LRU)

function sheetImage(url) {
  const hit = sheetCache.get(url);
  if (hit) {
    sheetCache.delete(url);
    sheetCache.set(url, hit);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      sheetCache.set(url, img);
      while (sheetCache.size > 32) sheetCache.delete(sheetCache.keys().next().value);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Crop a cue's tile onto `canvas` via drawImage. Returns the canvas. */
export async function cropToCanvas(canvas, cue, { fetchFn } = {}) {
  void fetchFn;
  const img = await sheetImage(cue.imageUrl);
  canvas.width = cue.w;
  canvas.height = cue.h;
  canvas.getContext("2d").drawImage(img, cue.x, cue.y, cue.w, cue.h, 0, 0, cue.w, cue.h);
  return canvas;
}

/** Blit the tile for positionMs into `canvas`; returns false when no preview. */
export async function paintPeek(canvas, track, positionMs, opts) {
  const cue = thumbnailFor(track, positionMs, opts?.coveredUntilMs);
  if (!cue) return false;
  await cropToCanvas(canvas, cue, opts);
  return true;
}
