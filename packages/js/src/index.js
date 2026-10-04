// OpenSeek JS SDK — dependency-free browser client (v0.1.0).
// Lookup once (registry /v1/sprites), resolve any positionMs to a sheet crop,
// blit the tile to a canvas. No API key needed for lookups.
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
 * `fetchFn` defaults to global fetch (inject a mock in tests).
 */
export async function loadTrack(registryUrl, { fetchFn = fetch } = {}) {
  const res = await fetchFn(registryUrl);
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

/** Convenience: build the movie URL and look it up. */
export function loadMovieTrack(base, params, opts) {
  return loadTrack(movieUrl(base, params), opts);
}

/** Convenience: build the episode URL and look it up. */
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

// -- contribute (v0.2): capture batching + registry upload -------------------
//
// Contributor half, mirroring NuvioMobile SeekPreviewCapture.kt /
// SeekPreviewUpload.kt (same constants, same 5x5 cell math, same multipart
// field names, same verdict fields). Playback code above is untouched.
//
// Host flow: bank one 320x180 JPEG per 10s grid slot in ContributeBatch,
// flush every >=48 banked tiles into a positional VTT + 5x5 sheets, POST the
// bundle with uploadContribution. Zero deps (fetch + Canvas only).

/** Capture one thumbnail every 10s, matching the registry/spritegen interval. */
export const CAPTURE_INTERVAL_MS = 10_000;

export const CAPTURE_TILE_WIDTH = 320;
export const CAPTURE_TILE_HEIGHT = 180;

/** Sheets are 5x5 grids (1600x900), same shape as spritegen output. */
export const CAPTURE_SHEET_COLS = 5;
export const CAPTURE_SHEET_ROWS = 5;
export const CAPTURE_TILES_PER_SHEET = CAPTURE_SHEET_COLS * CAPTURE_SHEET_ROWS; // 25

/** Flush a contribution every 48 banked tiles (48 slots on the 10s grid). */
export const CONTRIBUTE_BUNDLE_TILES = 48;

/** Below this many contiguous tiles an upload is not worth the bytes. */
export const CONTRIBUTE_MIN_TILES = 5;

export const CONTRIBUTE_PATH = "/v1/contribute";
export const CONTRIBUTE_VTT_NAME = "thumbnails-capture.vtt";
export const CONTRIBUTE_DEFAULT_UPLOADER = "openseek-js";

/** Sheet file name for an absolute sheet index (never per-bundle). */
export function sheetCaptureFileName(sheetIndex) {
  return `sheet-c-${sheetIndex}.jpg`;
}

/**
 * Deterministic sheet cell for timestampMs: slot = ts/interval,
 * sheet = slot/25, cell = slot%25. The VTT writer and the sheet stitcher
 * both use this, so cues always point at the right cell.
 */
export function tileBoxForTimestamp(timestampMs, intervalMs = CAPTURE_INTERVAL_MS) {
  const safe = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
  const slot = Math.trunc(Math.max(0, timestampMs) / safe);
  const sheetIndex = Math.trunc(slot / CAPTURE_TILES_PER_SHEET);
  const pos = slot % CAPTURE_TILES_PER_SHEET;
  return {
    sheetFileName: sheetCaptureFileName(sheetIndex),
    x: (pos % CAPTURE_SHEET_COLS) * CAPTURE_TILE_WIDTH,
    y: Math.trunc(pos / CAPTURE_SHEET_COLS) * CAPTURE_TILE_HEIGHT,
    w: CAPTURE_TILE_WIDTH,
    h: CAPTURE_TILE_HEIGHT,
  };
}

/** Start of the grid slot holding timeMs (never negative). */
export function slotStartFor(timeMs, intervalMs = CAPTURE_INTERVAL_MS) {
  const safe = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
  return Math.trunc(Math.max(0, timeMs) / safe) * safe;
}

/** Zero-padded HH:MM:SS.mmm, matching what spritegen writes (and parses). */
export function formatCaptureTimestamp(timeMs) {
  const total = Math.max(0, Math.trunc(timeMs));
  const hours = Math.trunc(total / 3_600_000);
  const minutes = Math.trunc((total % 3_600_000) / 60_000);
  const seconds = Math.trunc((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * Longest run of grid-adjacent slots, ascending. A bundle must be a
 * contiguous slot run: the registry infers the grid from the MEDIAN cue-start
 * step and rejects anything outside {5,10,30}s, so a holey bundle is refused
 * outright. Order-insensitive input; negatives ignored.
 */
export function longestContiguousSlotRun(timestampsMs, intervalMs = CAPTURE_INTERVAL_MS) {
  const safe = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
  const slots = [...new Set(
    (Array.isArray(timestampsMs) ? timestampsMs : [...timestampsMs])
      .filter((t) => Number.isFinite(t) && t >= 0),
  )].sort((a, b) => a - b);
  if (slots.length === 0) return [];
  let best = [];
  let run = [];
  let previous = -Infinity;
  for (const ts of slots) {
    if (run.length > 0 && ts !== previous + safe) {
      if (run.length > best.length) best = run;
      run = [];
    }
    run.push(ts);
    previous = ts;
  }
  if (run.length > best.length) best = run;
  return best;
}

/**
 * Positional VTT for captured tiles: cue per slot, start/end derived from the
 * slot timestamp (end clamped to durationMs), payload
 * `sheet-c-N.jpg#xywh=x,y,w,h` — the same wire format the registry serves, so
 * it ingests without conversion. Input order does not matter; output is
 * time-ordered.
 */
export function buildCaptureVtt(capturedTimestampsMs, durationMs, intervalMs = CAPTURE_INTERVAL_MS) {
  const safe = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
  const slots = [...new Set(capturedTimestampsMs)]
    .filter((t) => Number.isFinite(t) && t >= 0 && (durationMs <= 0 || t < durationMs))
    .sort((a, b) => a - b);
  let out = "WEBVTT\n";
  for (const ts of slots) {
    const end = durationMs > 0 ? Math.min(ts + safe, durationMs) : ts + safe;
    const box = tileBoxForTimestamp(ts, safe);
    out += `\n${formatCaptureTimestamp(ts)} --> ${formatCaptureTimestamp(end)}\n` +
      `${box.sheetFileName}#xywh=${box.x},${box.y},${box.w},${box.h}\n`;
  }
  return out;
}

function contributeNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/**
 * Parse the registry's inline verify+promote response; tolerant of any shape.
 * Returns {ok, httpStatus, state, versionStatus, coveredUntilMs,
 * contributionId, merged, addedSlots, keptSlots, duplicate, reason} plus the
 * derived {promoted, accepted, refused}. Verification failures report
 * `verify_reason`, a refused merge `reason`/`conflict`, a non-2xx body usually
 * just {"error": ...}.
 */
export function parseContributeResponse(body, httpStatus) {
  const ok = httpStatus >= 200 && httpStatus <= 299;
  const blank = (reason) => ({
    ok, httpStatus,
    state: null, versionStatus: null, coveredUntilMs: null, contributionId: null,
    merged: false, addedSlots: null, keptSlots: null, duplicate: false,
    reason, promoted: false, accepted: false, refused: false,
  });
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return blank("unparsable_body");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return blank("unparsable_body");
  const pick = (...vs) => {
    for (const v of vs) if (v !== undefined && v !== null) return v;
    return undefined;
  };
  const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const cleanLower = (v) => {
    const s = cleanStr(v);
    return s ? s.toLowerCase() : null;
  };
  const state = cleanLower(obj.state);
  const versionStatus = cleanLower(pick(obj.status, obj.version_status, obj.versionStatus));
  const coveredUntilMs = contributeNum(pick(obj.covered_until_ms, obj.coveredUntilMs));
  const contributionId = contributeNum(pick(obj.contribution_id, obj.contributionId));
  const merged = obj.merged === true;
  const addedSlots = contributeNum(pick(obj.added_slots, obj.addedSlots));
  const keptSlots = contributeNum(pick(obj.kept_slots, obj.keptSlots));
  const duplicate = obj.duplicate === true;
  const reason = cleanStr(pick(obj.reason, obj.verify_reason, obj.verifyReason, obj.conflict, obj.error))
    ?? (ok ? null : `http_${httpStatus}`);
  const promoted = ok && state === "promoted";
  const refused = ok && (state === "rejected" || duplicate);
  const accepted = ok && state !== "rejected";
  return {
    ok, httpStatus, state, versionStatus, coveredUntilMs, contributionId,
    merged, addedSlots, keptSlots, duplicate, reason,
    promoted, accepted, refused,
  };
}

/**
 * Contribution metadata block: {media_type, title, duration_ms, interval_ms,
 * uploader} plus whichever ids were passed (tmdb_id/imdb_id for movies,
 * show_tmdb_id/show_imdb_id + season + episode for episodes). Returns the
 * JSON string for the multipart `meta` part.
 */
export function buildContributeMeta(ids, durationMs, title, uploader = CONTRIBUTE_DEFAULT_UPLOADER) {
  const meta = {};
  const episode = ids.show_tmdb_id != null || ids.show_imdb_id != null;
  meta.media_type = episode ? "episode" : "movie";
  for (const k of ["tmdb_id", "imdb_id", "show_tmdb_id", "show_imdb_id", "season", "episode"]) {
    if (ids[k] != null) meta[k] = ids[k];
  }
  meta.title = title && String(title).trim() ? String(title) : "Unknown";
  meta.duration_ms = durationMs;
  meta.interval_ms = CAPTURE_INTERVAL_MS;
  meta.uploader = uploader && String(uploader).trim() ? String(uploader) : CONTRIBUTE_DEFAULT_UPLOADER;
  return JSON.stringify(meta);
}

export function newContributeBoundary() {
  let rand = "";
  for (let i = 0; i < 16; i++) rand += "0123456789abcdef"[Math.trunc(Math.random() * 16)];
  return `openseek-batch-${Date.now().toString(16)}-${rand}`;
}

/**
 * Pure multipart body builder (byte-exact, CRLF): meta (metadata.json),
 * vtt (thumbnails-capture.vtt), then one `sheet` part per sheet. Returns
 * Uint8Array ready as a fetch body.
 */
export function buildContributeMultipartBody(metaJson, vttText, sheets, boundary) {
  const enc = new TextEncoder();
  const chunks = [];
  const pushText = (s) => chunks.push(enc.encode(s));
  const pushBytes = (u8) => chunks.push(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
  pushText(`--${boundary}\r\nContent-Disposition: form-data; name="meta"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n`);
  pushText(String(metaJson));
  pushText("\r\n");
  pushText(`--${boundary}\r\nContent-Disposition: form-data; name="vtt"; filename="${CONTRIBUTE_VTT_NAME}"\r\nContent-Type: text/vtt\r\n\r\n`);
  pushText(String(vttText));
  pushText("\r\n");
  for (const sheet of sheets) {
    pushText(`--${boundary}\r\nContent-Disposition: form-data; name="sheet"; filename="${sheet.fileName}"\r\nContent-Type: image/jpeg\r\n\r\n`);
    pushBytes(sheet.jpeg);
    pushText("\r\n");
  }
  pushText(`--${boundary}--\r\n`);
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function makeSheetCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  throw new Error("no canvas available");
}

async function decodeTileImage(bytes) {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  if (typeof createImageBitmap !== "undefined") return createImageBitmap(blob);
  if (typeof Image !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new Error("no image decoder available");
}

async function encodeSheetJpeg(canvas) {
  if (typeof canvas.convertToBlob === "function") {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("jpeg encode failed"))), "image/jpeg", 0.8));
    return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("no jpeg encoder available");
}

function fallbackSheetBytes(sheetIndex, entries) {
  // No canvas in this runtime (node tests): deterministic placeholder so the
  // batching/VTT logic stays testable without a DOM. NOT a real JPEG —
  // production uploads must run flush() in a browser (OffscreenCanvas/canvas
  // path above); the registry's verify step refuses non-JPEG sheets.
  const head = new TextEncoder().encode(`OPENSEEK-SHEET-FALLBACK/${sheetIndex}/${entries.length}\n`);
  let size = head.length;
  for (const [, b] of entries) size += b.length;
  const out = new Uint8Array(size);
  out.set(head, 0);
  let pos = head.length;
  for (const [, b] of entries) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}

async function stitchSheet(sheetIndex, entries, intervalMs) {
  const W = CAPTURE_SHEET_COLS * CAPTURE_TILE_WIDTH;
  const H = CAPTURE_SHEET_ROWS * CAPTURE_TILE_HEIGHT;
  let canvas = null;
  try {
    canvas = makeSheetCanvas(W, H);
  } catch {
    canvas = null;
  }
  if (!canvas) return fallbackSheetBytes(sheetIndex, entries);
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallbackSheetBytes(sheetIndex, entries);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  for (const [ts, bytes] of entries) {
    const box = tileBoxForTimestamp(ts, intervalMs);
    try {
      const bmp = await decodeTileImage(bytes);
      try {
        ctx.drawImage(bmp, box.x, box.y, box.w, box.h);
      } finally {
        if (bmp && typeof bmp.close === "function") {
          try {
            bmp.close();
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* skip one unreadable tile; never punch a hole into the sheet */
    }
  }
  try {
    return await encodeSheetJpeg(canvas);
  } catch {
    return fallbackSheetBytes(sheetIndex, entries);
  }
}

/**
 * Stitch tiles into 5x5 sheets using tileBoxForTimestamp cell math (must
 * match buildCaptureVtt). One {fileName, jpeg} per sheet, sheets in index
 * order, entries within a sheet in time order. Absolute sheet numbering, so
 * two bundles of the same title reuse file names.
 */
export async function composeSheets(tiles, intervalMs = CAPTURE_INTERVAL_MS) {
  const safe = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
  const bySheet = new Map();
  for (const [ts, bytes] of tiles) {
    const slot = Math.trunc(Math.max(0, ts) / safe);
    const idx = Math.trunc(slot / CAPTURE_TILES_PER_SHEET);
    if (!bySheet.has(idx)) bySheet.set(idx, []);
    bySheet.get(idx).push([ts, bytes]);
  }
  const out = [];
  for (const idx of [...bySheet.keys()].sort((a, b) => a - b)) {
    const entries = bySheet.get(idx).sort((a, b) => a[0] - b[0]);
    const jpeg = await stitchSheet(idx, entries, safe);
    if (jpeg && jpeg.length > 0) out.push({ fileName: sheetCaptureFileName(idx), jpeg });
  }
  return out;
}

/**
 * Banked capture batch for one title. addTile() during playback; when
 * isReadyToFlush() (>=48 banked AND longest grid-contiguous run >=5) holds,
 * flush() composes the longest clean run into {timestamps, vttText, sheets}
 * and drops exactly those slots from the bank — the rest stays for the next
 * bundle. Accepts Uint8Array bytes or Blob (resolved at flush time).
 */
export class ContributeBatch {
  constructor(durationMs, { intervalMs = CAPTURE_INTERVAL_MS } = {}) {
    this.durationMs = durationMs;
    this.intervalMs = intervalMs > 0 ? intervalMs : CAPTURE_INTERVAL_MS;
    this.banked = new Map(); // timestampMs -> Uint8Array | Blob
  }

  get size() {
    return this.banked.size;
  }

  addTile(timestampMs, jpegBytes) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return false;
    if (jpegBytes == null) return false;
    if (jpegBytes instanceof Uint8Array) {
      if (jpegBytes.length === 0) return false;
      this.banked.set(Math.trunc(timestampMs), jpegBytes.slice());
    } else if (typeof Blob !== "undefined" && jpegBytes instanceof Blob) {
      if (jpegBytes.size === 0) return false;
      this.banked.set(Math.trunc(timestampMs), jpegBytes);
    } else {
      return false;
    }
    return true;
  }

  /** Banked timestamps, ascending. */
  pendingTimestamps() {
    return [...this.banked.keys()].sort((a, b) => a - b);
  }

  /** Longest grid-contiguous run over banked slots (readiness gate). */
  longestRun() {
    return longestContiguousSlotRun(this.pendingTimestamps(), this.intervalMs);
  }

  isReadyToFlush() {
    return this.banked.size >= CONTRIBUTE_BUNDLE_TILES &&
      this.longestRun().length >= CONTRIBUTE_MIN_TILES;
  }

  /**
   * Compose the longest READABLE run (Blobs resolved, empties dropped so a
   * vanished tile cannot punch a hole into the bundle) into a positional VTT
   * + stitched sheets. Returns null below the CONTRIBUTE_MIN_TILES floor.
   */
  async flush() {
    const readable = new Map();
    for (const [ts, raw] of this.banked) {
      try {
        const bytes = typeof Blob !== "undefined" && raw instanceof Blob
          ? new Uint8Array(await raw.arrayBuffer())
          : raw;
        if (bytes && bytes.length > 0) readable.set(ts, bytes);
      } catch {
        /* unreadable: stays banked, never punches a hole */
      }
    }
    const run = longestContiguousSlotRun([...readable.keys()], this.intervalMs);
    if (run.length < CONTRIBUTE_MIN_TILES) return null;
    const bundleTiles = new Map(run.map((ts) => [ts, readable.get(ts)]));
    const vttText = buildCaptureVtt(run, this.durationMs, this.intervalMs);
    const sheets = await composeSheets(bundleTiles, this.intervalMs);
    if (sheets.length === 0) return null;
    for (const ts of run) this.banked.delete(ts);
    return { timestamps: run, vttText, sheets };
  }
}

/**
 * Upload one flushed bundle: POST {baseUrl}/v1/contribute (multipart:
 * meta + vtt + sheets) and return the registry's verdict
 * {promoted, merged, addedSlots, keptSlots, versionStatus, coveredUntilMs,
 * duplicate, refused, reason} (plus ok/state/httpStatus/contributionId/
 * accepted for parity with the Kotlin twin). Never throws on transport or
 * shape errors — those come back as ok:false verdicts. `fetchFn` injectable
 * for tests; `boundary` overridable for byte-exact tests.
 */
export async function uploadContribution(baseUrl, apiKey, ids, durationMs, title, uploader, bundle, { fetchFn = fetch, boundary } = {}) {
  const fail = (reason) => ({
    ok: false, httpStatus: 0, state: null, versionStatus: null,
    coveredUntilMs: null, contributionId: null, merged: false,
    addedSlots: null, keptSlots: null, duplicate: false, reason,
    promoted: false, accepted: false, refused: false,
  });
  try {
    const vttText = bundle?.vttText;
    const sheets = bundle?.sheets;
    if (!(durationMs > 0) || typeof vttText !== "string" || !vttText.trim() ||
        !Array.isArray(sheets) || sheets.length === 0) {
      return fail("empty_payload");
    }
    if (!ids || (ids.tmdb_id == null && ids.imdb_id == null &&
        ids.show_tmdb_id == null && ids.show_imdb_id == null)) {
      return fail("missing_ids");
    }
    const metaJson = buildContributeMeta(ids, durationMs, title, uploader);
    const b = boundary || newContributeBoundary();
    const body = buildContributeMultipartBody(metaJson, vttText, sheets, b);
    if (body.length > 64 * 1024 * 1024) return fail("payload_too_large");
    const headers = { Accept: "application/json", "Content-Type": `multipart/form-data; boundary=${b}` };
    if (apiKey && String(apiKey).trim()) headers["X-API-Key"] = String(apiKey);
    const res = await fetchFn(`${String(baseUrl).replace(/\/$/, "")}${CONTRIBUTE_PATH}`, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    return parseContributeResponse(text, res.status);
  } catch (err) {
    return fail(`error:${err?.message || err}`);
  }
}
