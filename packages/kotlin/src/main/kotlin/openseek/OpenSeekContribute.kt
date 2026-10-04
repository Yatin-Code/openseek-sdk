// OpenSeekContribute.kt — contributor half of the OpenSeek seek-preview SDK (v0.2 track).
//
// Builds uploadable bundles during playback (bank JPEG tiles -> flush a
// positional VTT + 5x5 sheets -> POST /v1/contribute) and folds the
// registry's inline verify+promote answer into an UploadVerdict.
//
// Zero third-party deps: java.net.HttpURLConnection for POST,
// javax.imageio / java.awt for sheet stitching (desktop/JVM-correct).
// Android callers: keep the NuvioMobile platform stitcher
// (Bitmap/Canvas-based composeSheets) — only ContributeBatch.addTile,
// tileBoxForTimestamp, buildContributeVtt and parseUploadResponse are shared
// verbatim; everything else here is identical logic.
//
// Pure-logic ports from NuvioMobile SeekPreviewCapture.kt (cell math,
// interval logic, VTT writer, run computation) and SeekPreviewUpload.kt
// (multipart contract, tolerant verdict parsing). Playback code
// (OpenSeekClient.kt) is untouched.
//
// Registry merge rule this targets: same title +/-15s contributions MERGE by
// slot (first-writer-wins); only full-overlap (`duplicate`),
// `interval_mismatch` and `tile_size_mismatch` refuse a bundle.
package openseek

import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import javax.imageio.stream.MemoryCacheImageOutputStream
import kotlin.random.Random

/** Capture one thumbnail every 10s, matching the registry/spritegen interval. */
const val CONTRIBUTE_INTERVAL_MS = 10_000L

const val CONTRIBUTE_TILE_WIDTH = 320
const val CONTRIBUTE_TILE_HEIGHT = 180

/** Sheets are 5x5 grids (1600x900), same shape as spritegen output. */
const val CONTRIBUTE_SHEET_COLS = 5
const val CONTRIBUTE_SHEET_ROWS = 5
const val CONTRIBUTE_TILES_PER_SHEET = CONTRIBUTE_SHEET_COLS * CONTRIBUTE_SHEET_ROWS

/**
 * Bundle size: flush a contribution every 48 banked tiles. 48 slots on the
 * 10s grid = 8 minutes of coverage per upload, which the registry serves as a
 * `pending` version while the rest of the title is still being striped.
 */
const val CONTRIBUTE_BUNDLE_TILES = 48

/** Below this many tiles in the longest grid-contiguous run an upload is refused; keep capturing. */
const val CONTRIBUTE_MIN_TILES = 5

/** Registry path for contributor uploads (multipart intake, verify+promote inline). */
const val CONTRIBUTE_PATH = "/v1/contribute"

/** VTT file name inside the contribute payload. */
const val CONTRIBUTE_VTT_NAME = "thumbnails-capture.vtt"

/** Refuse to build absurd payloads client-side (registry caps at 50MB). */
const val CONTRIBUTE_MAX_BODY_BYTES = 64 * 1024 * 1024

/** Tiles over 1MB are skipped, mirroring the platform capture guard. */
const val CONTRIBUTE_MAX_TILE_BYTES = 1024 * 1024

/** Sheet JPEG quality: fixed so the same tiles always stitch to identical bytes. */
const val CONTRIBUTE_SHEET_JPEG_QUALITY = 0.80f

/** Whole flush POST is bounded; a hung socket must not stall capture. */
const val CONTRIBUTE_FLUSH_READ_TIMEOUT_MS = 180_000

fun contributeSheetFileName(sheetIndex: Int): String = "sheet-c-$sheetIndex.jpg"

/** Deterministic sheet cell for [timestampMs] (absolute slot numbering, never per-bundle). */
data class ContributeTileBox(
    val sheetFileName: String,
    val x: Int,
    val y: Int,
    val w: Int,
    val h: Int
)

/**
 * Deterministic sheet cell for [timestampMs]: slot index = timestamp/interval,
 * sheet = slot / 25, cell = slot % 25. The VTT writer and the sheet stitcher
 * both use this, so cues always point at the right cell. Sheet numbering is
 * ABSOLUTE (from the whole-title grid), so two bundles of the same title reuse
 * the same file names and a re-uploaded range simply overwrites them.
 */
fun tileBoxForTimestamp(
    timestampMs: Long,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): ContributeTileBox {
    val safeInterval = if (intervalMs > 0L) intervalMs else CONTRIBUTE_INTERVAL_MS
    val slot = (maxOf(timestampMs, 0L) / safeInterval).toInt()
    val sheetIndex = slot / CONTRIBUTE_TILES_PER_SHEET
    val pos = slot % CONTRIBUTE_TILES_PER_SHEET
    return ContributeTileBox(
        sheetFileName = contributeSheetFileName(sheetIndex),
        x = (pos % CONTRIBUTE_SHEET_COLS) * CONTRIBUTE_TILE_WIDTH,
        y = (pos / CONTRIBUTE_SHEET_COLS) * CONTRIBUTE_TILE_HEIGHT,
        w = CONTRIBUTE_TILE_WIDTH,
        h = CONTRIBUTE_TILE_HEIGHT
    )
}

/** Start of the grid slot holding [timeMs] (never negative). */
fun slotStartFor(timeMs: Long, intervalMs: Long = CONTRIBUTE_INTERVAL_MS): Long {
    val safeInterval = if (intervalMs > 0L) intervalMs else CONTRIBUTE_INTERVAL_MS
    return (maxOf(timeMs, 0L) / safeInterval) * safeInterval
}

/** Zero-padded HH:MM:SS.mmm, matching what spritegen writes (and parses). */
fun formatContributeTimestamp(timeMs: Long): String {
    val total = maxOf(timeMs, 0L)
    val hours = total / 3_600_000L
    val minutes = (total % 3_600_000L) / 60_000L
    val seconds = (total % 60_000L) / 1_000L
    val millis = total % 1_000L
    return buildString {
        if (hours < 10L) append('0')
        append(hours).append(':')
        if (minutes < 10L) append('0')
        append(minutes).append(':')
        if (seconds < 10L) append('0')
        append(seconds).append('.')
        if (millis < 100L) append('0')
        if (millis < 10L) append('0')
        append(millis)
    }
}

/**
 * Longest run of grid-adjacent slots in [timestampsMs], ascending.
 *
 * A bundle must be a contiguous slot run: the registry infers the grid from
 * the MEDIAN cue-start step and rejects anything outside {5,10,30}s
 * (`bad_interval`), so a holey bundle can be refused outright.
 * Order-insensitive input; negative timestamps are ignored.
 */
fun longestContiguousSlotRun(
    timestampsMs: Collection<Long>,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): List<Long> {
    val safeInterval = if (intervalMs > 0L) intervalMs else CONTRIBUTE_INTERVAL_MS
    val slots = timestampsMs.filter { it >= 0L }.toSortedSet()
    if (slots.isEmpty()) return emptyList()
    var best: List<Long> = emptyList()
    var run = ArrayList<Long>()
    var previous = Long.MIN_VALUE
    for (ts in slots) {
        if (run.isNotEmpty() && ts != previous + safeInterval) {
            if (run.size > best.size) best = run
            run = ArrayList()
        }
        run.add(ts)
        previous = ts
    }
    if (run.size > best.size) best = run
    return best
}

/**
 * Positional VTT for captured tiles: cue per slot, start/end derived from the
 * slot timestamp (end clamped to [durationMs]), payload
 * `sheet-c-N.jpg#xywh=x,y,w,h` — the same wire format the registry serves, so
 * the server ingests it without conversion. Input order does not matter;
 * output is time-ordered.
 */
fun buildContributeVtt(
    timestampsMs: Collection<Long>,
    durationMs: Long,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): String {
    val safeInterval = if (intervalMs > 0L) intervalMs else CONTRIBUTE_INTERVAL_MS
    val slots = timestampsMs.filter { it >= 0L && (durationMs <= 0L || it < durationMs) }.toSortedSet()
    return buildString {
        append("WEBVTT\n")
        for (ts in slots) {
            val end = if (durationMs > 0L) minOf(ts + safeInterval, durationMs) else ts + safeInterval
            val box = tileBoxForTimestamp(ts, safeInterval)
            append('\n')
            append(formatContributeTimestamp(ts))
            append(" --> ")
            append(formatContributeTimestamp(end))
            append('\n')
            append(box.sheetFileName)
            append("#xywh=")
            append(box.x).append(',').append(box.y).append(',').append(box.w).append(',').append(box.h)
            append('\n')
        }
    }
}

/** One finished sheet ready to be attached to the contribute multipart body. */
data class SheetFile(val fileName: String, val jpeg: ByteArray)

/**
 * Stitches banked tiles into 5x5 sheets (1600x900, black background),
 * grouping by ABSOLUTE sheet index so file names match [tileBoxForTimestamp].
 * Tiles are drawn in time order; empty/oversize/undecodable tiles are
 * skipped (they stay holes the next bundle can fill). JPEG quality is fixed,
 * so the same tiles always stitch to identical bytes.
 */
fun stitchSheets(
    tiles: Map<Long, ByteArray>,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): List<SheetFile> {
    if (tiles.isEmpty()) return emptyList()
    val safeInterval = if (intervalMs > 0L) intervalMs else CONTRIBUTE_INTERVAL_MS
    val bySheet = tiles.entries.groupBy { (it.key / safeInterval).toInt() / CONTRIBUTE_TILES_PER_SHEET }
    val out = ArrayList<SheetFile>(bySheet.size)
    for (sheetIndex in bySheet.keys.sorted()) {
        val sheet = BufferedImage(
            CONTRIBUTE_SHEET_COLS * CONTRIBUTE_TILE_WIDTH,
            CONTRIBUTE_SHEET_ROWS * CONTRIBUTE_TILE_HEIGHT,
            BufferedImage.TYPE_INT_RGB
        )
        val g = sheet.createGraphics()
        try {
            g.color = java.awt.Color.BLACK
            g.fillRect(0, 0, sheet.width, sheet.height)
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
            for ((timestampMs, bytes) in bySheet.getValue(sheetIndex).sortedBy { it.key }) {
                if (bytes.isEmpty() || bytes.size > CONTRIBUTE_MAX_TILE_BYTES) continue
                val box = tileBoxForTimestamp(timestampMs, safeInterval)
                val decoded = try {
                    ImageIO.read(ByteArrayInputStream(bytes)) ?: continue
                } catch (_: Exception) {
                    continue
                }
                val fitted = if (decoded.width != box.w || decoded.height != box.h) {
                    val scaled = BufferedImage(box.w, box.h, BufferedImage.TYPE_INT_RGB)
                    val gg = scaled.createGraphics()
                    try {
                        gg.setRenderingHint(
                            RenderingHints.KEY_INTERPOLATION,
                            RenderingHints.VALUE_INTERPOLATION_BILINEAR
                        )
                        gg.drawImage(decoded, 0, 0, box.w, box.h, null)
                    } finally {
                        gg.dispose()
                    }
                    scaled
                } else {
                    decoded
                }
                g.drawImage(fitted, box.x, box.y, null)
            }
        } finally {
            g.dispose()
        }
        val encoded = encodeSheetJpeg(sheet) ?: continue
        if (encoded.isNotEmpty()) out.add(SheetFile(contributeSheetFileName(sheetIndex), encoded))
    }
    return out
}

private fun encodeSheetJpeg(sheet: BufferedImage): ByteArray? {
    return try {
        val writers = ImageIO.getImageWritersByFormatName("jpeg")
        if (!writers.hasNext()) return null
        val writer = writers.next()
        try {
            val params = writer.defaultWriteParam
            if (params.canWriteCompressed()) {
                params.compressionMode = ImageWriteParam.MODE_EXPLICIT
                params.compressionQuality = CONTRIBUTE_SHEET_JPEG_QUALITY
            }
            val buf = ByteArrayOutputStream(256 * 1024)
            val ios = MemoryCacheImageOutputStream(buf)
            writer.output = ios
            // The writer pushes all bytes through to buf before write()
            // returns (flushBefore at end of image), so no flush call needed.
            writer.write(null, IIOImage(sheet, null, null), params)
            return buf.toByteArray()
        } finally {
            writer.dispose()
        }
    } catch (_: Exception) {
        null
    }
}

/** One flushed bundle: the contiguous run's timestamps, its VTT, and its sheets. */
data class ContributeBundle(
    val timestamps: List<Long>,
    val vttText: String,
    val sheets: List<SheetFile>
)

/**
 * In-memory tile bank for one title. The host loop grabs frames during
 * playback ([addTile]), and once [isReadyToFlush] a [flush] composes the
 * longest grid-contiguous run into an uploadable [ContributeBundle].
 * Flushed slots leave the bank (like the reference's `attempted` set, they
 * are never re-sent); the rest stays pending for the next bundle.
 */
class ContributeBatch(val intervalMs: Long = CONTRIBUTE_INTERVAL_MS) {
    private val bank = java.util.TreeMap<Long, ByteArray>()

    /**
     * Banks one grabbed tile. The host should pass grid-aligned timestamps
     * ([slotStartFor]). Returns false (tile dropped) for negative
     * timestamps, empty JPEGs, or files over 1MB — mirroring the platform
     * capture guard, so a bad grab can never punch a hole into a bundle.
     */
    fun addTile(timestampMs: Long, jpeg: ByteArray): Boolean {
        if (timestampMs < 0L || jpeg.isEmpty() || jpeg.size > CONTRIBUTE_MAX_TILE_BYTES) return false
        bank[timestampMs] = jpeg
        return true
    }

    val bankedCount: Int get() = bank.size

    /** Banked timestamps in time order. */
    fun pendingTimestamps(): List<Long> = ArrayList(bank.keys)

    /** Longest grid-contiguous run currently banked, ascending. */
    fun longestRun(): List<Long> = longestContiguousSlotRun(bank.keys, intervalMs)

    /**
     * Mid-session flush gate: at least [CONTRIBUTE_BUNDLE_TILES] banked AND a
     * grid-contiguous run of [CONTRIBUTE_MIN_TILES]. (At end of playback the
     * host may [flush] any run >= [CONTRIBUTE_MIN_TILES], like the reference's
     * final-bundle path.)
     */
    val isReadyToFlush: Boolean
        get() = bank.size >= CONTRIBUTE_BUNDLE_TILES &&
            longestContiguousSlotRun(bank.keys, intervalMs).size >= CONTRIBUTE_MIN_TILES

    /**
     * Composes the longest grid-contiguous run into a [ContributeBundle] and
     * drops those slots from the bank. Requires a run of at least
     * [CONTRIBUTE_MIN_TILES] (the registry rejects `cue_count_too_small`
     * below 5 cues) — throws [IllegalStateException] otherwise.
     *
     * Flushed slots leave the bank whether the POST lands or not (like the
     * reference's `attempted` set, they are never re-sent); on a transport
     * miss the plan simply re-grabs those slots on a later pass.
     */
    fun flush(durationMs: Long): ContributeBundle {
        val run = longestContiguousSlotRun(bank.keys, intervalMs)
        require(run.size >= CONTRIBUTE_MIN_TILES) {
            "longest banked run is ${run.size}, need $CONTRIBUTE_MIN_TILES"
        }
        val tiles = LinkedHashMap<Long, ByteArray>(run.size)
        for (ts in run) {
            val jpeg = bank.remove(ts) ?: continue
            if (jpeg.isNotEmpty()) tiles[ts] = jpeg
        }
        val vtt = buildContributeVtt(tiles.keys, durationMs, intervalMs)
        val sheets = stitchSheets(tiles, intervalMs)
        check(sheets.isNotEmpty()) { "composeSheets returned nothing" }
        return ContributeBundle(timestamps = ArrayList(tiles.keys), vttText = vtt, sheets = sheets)
    }
}

/** Title ids for a contribution (movies: tmdb/imdb; episodes: show ids + season + episode). */
data class ContributeIds(
    val tmdbId: Int? = null,
    val imdbId: String? = null,
    val showTmdbId: Int? = null,
    val showImdbId: String? = null,
    val season: Int? = null,
    val episode: Int? = null
)

/**
 * Outcome of one bundle POST. `/v1/contribute` runs verify + promote inline,
 * so [state] is the FINAL state: `promoted` = these cues are servable now (a
 * new version, or merged by slot into the same-duration one — existing tiles
 * win, so cached bytes never change), `rejected` = refused with nothing to
 * gain (`duplicate`: full overlap; or unmergeable: `interval_mismatch`,
 * `tile_size_mismatch`, `merge_failed:*`), `quarantine`/`verified` = stored,
 * not yet servable.
 *
 * [versionStatus]/[coveredUntilMs] describe the resulting version;
 * [merged]/[addedSlots]/[keptSlots] are set when a merge happened.
 */
data class UploadVerdict(
    val ok: Boolean,
    val httpStatus: Int = 0,
    val state: String? = null,
    val versionStatus: String? = null,
    val coveredUntilMs: Long? = null,
    val contributionId: Long? = null,
    val merged: Boolean = false,
    val addedSlots: Int? = null,
    val keptSlots: Int? = null,
    val duplicate: Boolean = false,
    val reason: String? = null
) {
    /**
     * The POST landed (2xx) and the registry did not refuse it. A body with
     * no `state` at all still counts: the post-upload registry re-read, not
     * the response shape, decides how far coverage actually moved.
     */
    val accepted: Boolean get() = ok && state != "rejected"

    /** These cues are servable now. */
    val promoted: Boolean get() = ok && state == "promoted"

    /**
     * The registry gave up on these slots for good (nothing new to add, or a
     * conflict). Re-sending the same bundle cannot change the answer, so the
     * session stops instead of retrying on every backoff window.
     */
    val refused: Boolean get() = ok && (state == "rejected" || duplicate)
}

/** Parses the registry's inline verify+promote response; tolerant of any shape. */
fun parseUploadResponse(body: String, httpStatus: Int): UploadVerdict {
    val ok = httpStatus in 200..299
    return try {
        UploadVerdict(
            ok = ok,
            httpStatus = httpStatus,
            state = verdictString(body, "state")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() },
            versionStatus = verdictString(body, "status")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() },
            coveredUntilMs = verdictLong(body, "covered_until_ms"),
            contributionId = verdictLong(body, "contribution_id"),
            merged = verdictBool(body, "merged"),
            addedSlots = verdictInt(body, "added_slots"),
            keptSlots = verdictInt(body, "kept_slots"),
            duplicate = verdictBool(body, "duplicate"),
            // Verification failures report `verify_reason`, a refused merge
            // `reason` or `conflict`; a non-2xx body is usually just {"error": ...}.
            reason = verdictString(body, "reason")?.takeIf { it.isNotBlank() }
                ?: verdictString(body, "verify_reason")?.takeIf { it.isNotBlank() }
                ?: verdictString(body, "conflict")?.takeIf { it.isNotBlank() }
                ?: verdictString(body, "error")?.takeIf { it.isNotBlank() }
                ?: if (ok) null else "http_$httpStatus"
        )
    } catch (_: Exception) {
        UploadVerdict(ok = ok, httpStatus = httpStatus, reason = "unparsable_body")
    }
}

private fun verdictString(json: String, name: String): String? =
    Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(json)?.groupValues?.get(1)

private fun verdictLong(json: String, name: String): Long? =
    Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toLongOrNull()

private fun verdictInt(json: String, name: String): Int? =
    Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toIntOrNull()

private fun verdictBool(json: String, name: String): Boolean {
    val raw = Regex("\"$name\"\\s*:\\s*(true|false)").find(json)?.groupValues?.get(1)
    return raw.equals("true", ignoreCase = true)
}

private fun jsonEscape(s: String): String = buildString {
    for (c in s) {
        when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
        }
    }
}

/**
 * Contribution metadata block (`meta` part, `metadata.json`): media type from
 * the ids (show ids -> episode, else movie), title, durations, uploader.
 * Only set ids are sent; the registry matches titles by them.
 */
fun buildContributeMetaJson(
    ids: ContributeIds,
    title: String,
    durationMs: Long,
    uploader: String,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): String = buildString {
    append('{')
    val episode = ids.showTmdbId != null || ids.showImdbId != null
    append("\"media_type\":\"").append(if (episode) "episode" else "movie").append('"')
    if (!episode && ids.tmdbId != null) append(",\"tmdb_id\":").append(ids.tmdbId)
    if (!episode && ids.imdbId != null) append(",\"imdb_id\":\"").append(jsonEscape(ids.imdbId)).append('"')
    if (episode && ids.showTmdbId != null) append(",\"show_tmdb_id\":").append(ids.showTmdbId)
    if (episode && ids.showImdbId != null) append(",\"show_imdb_id\":\"").append(jsonEscape(ids.showImdbId)).append('"')
    if (episode && ids.season != null) append(",\"season\":").append(ids.season)
    if (episode && ids.episode != null) append(",\"episode\":").append(ids.episode)
    append(",\"title\":\"").append(jsonEscape(if (title.isBlank()) "Unknown" else title)).append('"')
    append(",\"duration_ms\":").append(durationMs)
    append(",\"interval_ms\":").append(intervalMs)
    append(",\"uploader\":\"").append(jsonEscape(if (uploader.isBlank()) "anonymous" else uploader)).append('"')
    append('}')
}

fun newContributeBoundary(): String = buildString {
    append("openseek-")
    append(kotlin.math.abs(Random.nextLong()).toString(radix = 16))
    append('-')
    repeat(8) { append("0123456789abcdef"[Random.nextInt(16)]) }
}

/**
 * Pure multipart body builder (byte-exact, CRLF): `meta` (metadata.json),
 * `vtt` ([CONTRIBUTE_VTT_NAME]), then one `sheet` part per sheet — the exact
 * field/file names the registry intake accepts.
 */
fun buildContributeMultipartBody(
    metaJson: String,
    vttText: String,
    sheets: List<SheetFile>,
    boundary: String
): ByteArray {
    val chunks = ArrayList<ByteArray>(6 + sheets.size * 3)
    fun partHeader(name: String, fileName: String, contentType: String) {
        chunks.add(
            "--$boundary\r\nContent-Disposition: form-data; name=\"$name\"; filename=\"$fileName\"\r\nContent-Type: $contentType\r\n\r\n"
                .toByteArray(Charsets.UTF_8)
        )
    }
    partHeader("meta", "metadata.json", "application/json")
    chunks.add(metaJson.toByteArray(Charsets.UTF_8))
    chunks.add("\r\n".toByteArray(Charsets.UTF_8))
    partHeader("vtt", CONTRIBUTE_VTT_NAME, "text/vtt")
    chunks.add(vttText.toByteArray(Charsets.UTF_8))
    chunks.add("\r\n".toByteArray(Charsets.UTF_8))
    for (sheet in sheets) {
        partHeader("sheet", sheet.fileName, "image/jpeg")
        chunks.add(sheet.jpeg)
        chunks.add("\r\n".toByteArray(Charsets.UTF_8))
    }
    chunks.add("--$boundary--\r\n".toByteArray(Charsets.UTF_8))
    var size = 0
    for (chunk in chunks) size += chunk.size
    val out = ByteArray(size)
    var pos = 0
    for (chunk in chunks) {
        chunk.copyInto(out, pos)
        pos += chunk.size
    }
    return out
}

/**
 * Uploads one flushed bundle: POST {base}/v1/contribute (multipart) and
 * folds the inline verify+promote answer into an [UploadVerdict]. Never
 * throws: transport errors return a not-ok verdict (`timeout` on socket
 * timeout, `error:<msg>` otherwise) so the host loop treats them as a
 * silent miss and keeps capturing.
 */
fun uploadContribution(
    baseUrl: String,
    apiKey: String?,
    ids: ContributeIds,
    durationMs: Long,
    title: String,
    uploader: String,
    bundle: ContributeBundle,
    intervalMs: Long = CONTRIBUTE_INTERVAL_MS
): UploadVerdict {
    if (bundle.sheets.isEmpty() || bundle.vttText.isBlank() || durationMs <= 0L) {
        return UploadVerdict(ok = false, reason = "empty_payload")
    }
    val metaJson = buildContributeMetaJson(ids, title, durationMs, uploader, intervalMs)
    val boundary = newContributeBoundary()
    val body = buildContributeMultipartBody(metaJson, bundle.vttText, bundle.sheets, boundary)
    if (body.size > CONTRIBUTE_MAX_BODY_BYTES) {
        return UploadVerdict(ok = false, reason = "payload_too_large")
    }
    return try {
        val url = baseUrl.trimEnd('/') + CONTRIBUTE_PATH
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 8000
            conn.readTimeout = CONTRIBUTE_FLUSH_READ_TIMEOUT_MS
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            if (apiKey != null) conn.setRequestProperty("X-API-Key", apiKey)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val resp = stream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
            parseUploadResponse(resp, code)
        } finally {
            conn.disconnect()
        }
    } catch (timeout: java.net.SocketTimeoutException) {
        UploadVerdict(ok = false, reason = "timeout")
    } catch (e: Exception) {
        UploadVerdict(ok = false, reason = "error:${e.message}")
    }
}
