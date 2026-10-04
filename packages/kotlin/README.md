# openseek-kotlin (JVM core)

Pure-JVM client for the OpenSeek seek-preview registry. Zero third-party deps
(stdlib + `javax.imageio`/`java.awt` only).

Two files: `src/main/kotlin/openseek/OpenSeekClient.kt` (lookup + scrub
thumbnails) and `OpenSeekContribute.kt` (contribution half: bank grabbed
tiles, flush positional VTT + 5x5 sheets, POST `/v1/contribute`, fold the
inline verify+promote answer into an `UploadVerdict`).

**Android callers:** everything works as-is except `cropTile` (swap its body
for `BitmapFactory.decodeByteArray` + `Bitmap.createBitmap(...)`, marked in
the source) and `stitchSheets` (keep the platform `Bitmap`/`Canvas`
composer — only `addTile`, `tileBoxForTimestamp`, `buildContributeVtt` and
`parseUploadResponse` are shared verbatim). See the repo README for the
10-line ExoPlayer integration and `docs/wire.md` for the frozen v0 contract.

## Contribute host loop (10 lines)

```kotlin
val batch = ContributeBatch()                                            // 1 bank tiles this session
grabJpeg(playheadMs)?.let { batch.addTile(slotStartFor(playheadMs), it) } // 2 grab, grid-aligned
if (batch.isReadyToFlush) {                                              // 3 48 banked + 5-run
  val bundle = batch.flush(player.duration)                              // 4 VTT + 5x5 sheets
  val verdict = uploadContribution("https://tiles.example.com", apiKey,  // 5 POST one bundle
    ContributeIds(tmdbId = 27205), player.duration, "Example Film", "my-app", bundle)
  if (verdict.promoted) track = client.loadMovieTrack(27205, player.duration) // 6 self-unlock
  else if (verdict.refused) stopContributing(verdict.reason)              // 7 duplicate/conflict: stop
} // 8 transport miss (timeout/error:*): silent, re-grab those slots next pass
  // 9 flushed slots leave the bank; the rest stays pending for the next bundle
  // 10 re-read the registry after each bundle; the merge makes retries idempotent
```

Notes: run `uploadContribution` off the main thread (network I/O, 180s read
timeout); it never throws — transport errors come back as a not-ok verdict
(`timeout` / `error:<msg>`) so the loop treats them as a silent miss.
`flush()` takes the longest grid-contiguous run (the registry infers the
interval from the median cue step and refuses holey bundles); at end of
playback flush any run >= 5 even below the 48-tile gate. A `refused` verdict
(`duplicate`, `interval_mismatch`, `tile_size_mismatch`) is terminal for
those slots — never re-send. Self-test: `python3 tests/test_contribute_model.py`.
