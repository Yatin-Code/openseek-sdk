// OpenSeekClient.kt — pure-JVM core of the OpenSeek seek-preview SDK (v0.1.0).
//
// Zero third-party deps: java.net.HttpURLConnection for fetch,
// javax.imageio / java.awt for tile crop (desktop/JVM-correct).
// Android callers: swap the crop line for BitmapFactory + Bitmap.createBitmap
// (see README "Android crop swap"); everything else is identical.
//
// Pure logic extracted from NuvioMobile SeekPreviewModels.kt (query building,
// VTT parse, floor lookup with coverage bound) and supersedes sdk/kotlin/Peek.kt,
// which lacked the covered_until_ms bound and any fetch/cache/crop.
package openseek

import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.imageio.ImageIO

/** One VTT cue: time range start + tile box inside a sprite sheet. */
data class Cue(
    val startMs: Long,
    val imageUrl: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int
)

/**
 * A served registry version. `status` is "pending" (partial, servable only up
 * to [coveredUntilMs]) or "complete". Null [coveredUntilMs] = older registry
 * that reported no coverage -> treated as unbounded (pre-coverage behavior).
 */
data class Track(
    val vttUrl: String,
    val sourceDurationMs: Long,
    val scale: Double = 1.0,
    val cues: List<Cue> = emptyList(),
    val status: String = "complete",
    val coveredUntilMs: Long? = null
) {
    /** True when there is nothing left to stripe for this title. */
    val coversWholeSource: Boolean
        get() {
            val covered = coveredUntilMs ?: return status != "pending"
            return covered >= sourceDurationMs
        }

    /** [coveredUntilMs] mapped onto the local playback timeline. */
    fun coveredUntilOnLocalTimeline(): Long? {
        val covered = coveredUntilMs ?: return null
        return if (scale > 0.0) (covered * scale).toLong() else covered
    }
}

/**
 * Floor semantics: last cue at or before [positionMs], corrected by the
 * registry scale (scale = local duration / source duration). Null = no
 * preview, hide the thumbnail.
 *
 * [coveredUntilMs] defaults to the track's own coverage end (compared in
 * source time, after the scale correction), so a partial `pending` version
 * stays silent past its last cue instead of showing a stale tail tile.
 * Pass null to lift the bound.
 */
fun Track.thumbnailFor(positionMs: Long, coveredUntilMs: Long? = this.coveredUntilMs): Cue? {
    val pos = if (scale > 0.0) (positionMs / scale).toLong() else positionMs
    if (coveredUntilMs != null && pos > coveredUntilMs) return null
    var hit: Cue? = null
    for (c in cues) {
        if (c.startMs <= pos) hit = c else break
    }
    return hit
}

/** Parses "HH:MM:SS.mmm" (always zero-padded hours past the 1h mark); tolerates "MM:SS.mmm". */
fun parseVttTimestamp(raw: String): Long? {
    val parts = raw.trim().split(':')
    if (parts.size !in 2..3) return null
    return try {
        val secParts = parts.last().split('.')
        val seconds = secParts[0].toLong()
        val millis = secParts.getOrNull(1)?.padEnd(3, '0')?.take(3)?.toLong() ?: 0L
        val minutes = parts[parts.size - 2].toLong()
        val hours = if (parts.size == 3) parts[0].toLong() else 0L
        if (minutes !in 0..59 || seconds !in 0..59 || millis !in 0..999) return null
        ((hours * 3600L + minutes * 60L + seconds) * 1000L) + millis
    } catch (_: Exception) {
        null
    }
}

private fun parseCuePayload(payload: String, vttBase: String): Triple<String, IntArray, Boolean> {
    val hash = payload.indexOf("#xywh=")
    if (hash < 0) return Triple(payload, IntArray(0), false)
    val rawUrl = payload.substring(0, hash).trim()
    val url = if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) rawUrl
        else "$vttBase/$rawUrl"
    val box = payload.substring(hash + "#xywh=".length).split(',')
        .mapNotNull { it.trim().toIntOrNull() }.toIntArray()
    return Triple(url, box, box.size == 4)
}

/**
 * Parses registry WebVTT text into time-ordered cues. Cues without a valid
 * `#xywh` payload are skipped (silent miss for that slot). Sheet-relative
 * payloads resolve against the VTT URL's directory.
 */
fun parseVtt(vttText: String, vttUrl: String): List<Cue> {
    val vttBase = vttUrl.substringBeforeLast('/').trimEnd('/')
    val cues = ArrayList<Cue>()
    var pendingStartMs: Long? = null
    for (rawLine in vttText.lineSequence()) {
        val line = rawLine.trim()
        if (line.isEmpty()) {
            pendingStartMs = null
            continue
        }
        if ("-->" in line) {
            pendingStartMs = parseVttTimestamp(line.substringBefore("-->"))
            continue
        }
        if (line.startsWith("WEBVTT") || line.startsWith("NOTE")) continue
        val startMs = pendingStartMs ?: continue
        pendingStartMs = null
        val (url, box, valid) = parseCuePayload(line, vttBase)
        if (!valid) continue
        cues.add(Cue(startMs = startMs, imageUrl = url, x = box[0], y = box[1], w = box[2], h = box[3]))
    }
    cues.sortBy { it.startMs }
    return cues
}

/**
 * Registry client. [base] is the registry origin, e.g. "https://tiles.example.com".
 * [apiKey], when set, is sent as X-API-Key (only the /v1/jobs routes require it;
 * lookups stay open — see docs/wire.md "permissive mode").
 */
class OpenSeekClient(val base: String, val apiKey: String? = null) {

    fun movieUrl(tmdbId: Int? = null, imdbId: String? = null, durationMs: Long): String {
        require(tmdbId != null || imdbId != null) { "movie query needs tmdb_id or imdb_id" }
        val b = StringBuilder(base.trimEnd('/')).append("/v1/sprites?")
        if (tmdbId != null) b.append("tmdb_id=").append(tmdbId)
        else b.append("imdb_id=").append(enc(imdbId!!))
        return b.append("&duration_ms=").append(durationMs).toString()
    }

    fun episodeUrl(
        showTmdbId: Int? = null,
        showImdbId: String? = null,
        season: Int,
        episode: Int,
        durationMs: Long
    ): String {
        require(showTmdbId != null || showImdbId != null) { "episode query needs show_tmdb_id or show_imdb_id" }
        val b = StringBuilder(base.trimEnd('/')).append("/v1/sprites?")
        if (showTmdbId != null) b.append("show_tmdb_id=").append(showTmdbId)
        else b.append("show_imdb_id=").append(enc(showImdbId!!))
        return b.append("&season=").append(season)
            .append("&episode=").append(episode)
            .append("&duration_ms=").append(durationMs).toString()
    }

    /**
     * Full lookup: GET /v1/sprites -> parse envelope -> GET vtt_url -> [Track].
     * Returns null on 404 (unknown title) — the caller hides the preview.
     * Throws on transport errors; callers doing scrub-driven fetch should
     * catch and treat as a silent miss.
     */
    fun loadTrack(registryUrl: String): Track? {
        val (code, body) = get(registryUrl)
        if (code == 404) return null
        check(code in 200..299) { "lookup failed: HTTP $code" }
        val vttUrl = stringField(body, "vtt_url") ?: error("lookup response missing vtt_url")
        val sourceDuration = longField(body, "source_duration_ms") ?: 0L
        val scale = doubleField(body, "scale") ?: 1.0
        val status = stringField(body, "status") ?: "complete"
        val covered = longField(body, "covered_until_ms")
        val (vcode, vtt) = get(vttUrl)
        check(vcode in 200..299) { "VTT fetch failed: HTTP $vcode" }
        return Track(
            vttUrl = vttUrl,
            sourceDurationMs = sourceDuration,
            scale = if (scale > 0.0) scale else 1.0,
            cues = parseVtt(vtt, vttUrl),
            status = status,
            coveredUntilMs = covered
        )
    }

    fun loadMovieTrack(tmdbId: Int? = null, imdbId: String? = null, durationMs: Long): Track? =
        loadTrack(movieUrl(tmdbId, imdbId, durationMs))

    fun loadEpisodeTrack(
        showTmdbId: Int? = null,
        showImdbId: String? = null,
        season: Int,
        episode: Int,
        durationMs: Long
    ): Track? = loadTrack(episodeUrl(showTmdbId, showImdbId, season, episode, durationMs))

    // -- sheets: download + in-memory LRU ----------------------------------

    private val sheetCache = object : LinkedHashMap<String, ByteArray>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: Map.Entry<String, ByteArray>): Boolean = size > 32
    }

    /** Raw JPEG bytes for a sheet URL (cached, max 32 entries). */
    @Synchronized
    fun sheetBytes(sheetUrl: String): ByteArray {
        sheetCache[sheetUrl]?.let { return it }
        val (code, _) = getBytes(sheetUrl)
        check(code in 200..299) { "sheet fetch failed: HTTP $code" }
        lastBytes?.let { sheetCache[sheetUrl] = it }
        return lastBytes ?: error("empty sheet body")
    }

    /**
     * Crop a tile out of downloaded sheet bytes (JVM/desktop via ImageIO).
     * ANDROID SWAP: replace this body with
     *   val bmp = BitmapFactory.decodeByteArray(sheet, 0, sheet.size)
     *   Bitmap.createBitmap(bmp, cue.x, cue.y, cue.w, cue.h)
     * and change the return type to android.graphics.Bitmap.
     */
    fun cropTile(sheet: ByteArray, cue: Cue): BufferedImage {
        val img = ImageIO.read(ByteArrayInputStream(sheet))
            ?: error("sheet did not decode as an image")
        return img.getSubimage(cue.x, cue.y, cue.w, cue.h)
    }

    // -- minimal HTTP + JSON (envelope fields only; no parser dep) ----------

    private var lastBytes: ByteArray? = null

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 25000
        c.setRequestProperty("Accept", "*/*")
        if (apiKey != null) c.setRequestProperty("X-API-Key", apiKey)
        return c
    }

    private fun get(url: String): Pair<Int, String> {
        val (code, raw) = getBytes(url)
        return code to (raw?.toString(Charsets.UTF_8) ?: "")
    }

    private fun getBytes(url: String): Pair<Int, ByteArray?> {
        val c = open(url)
        return try {
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val bytes = stream?.readBytes()
            lastBytes = bytes
            code to bytes
        } finally {
            c.disconnect()
        }
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    private fun stringField(json: String, name: String): String? =
        Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(json)?.groupValues?.get(1)

    private fun longField(json: String, name: String): Long? =
        Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toLongOrNull()

    private fun doubleField(json: String, name: String): Double? =
        Regex("\"$name\"\\s*:\\s*(-?[\\d.]+)").find(json)?.groupValues?.get(1)?.toDoubleOrNull()
}
