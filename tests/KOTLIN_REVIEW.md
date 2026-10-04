# Kotlin core review (no `kotlinc` in this environment)

`OpenSeekClient.kt` is pure-JVM Kotlin with zero third-party deps. It could not
be compiled here (no kotlinc/java toolchain), so it is covered two ways:

1. **Algorithmic**: `tests/test_parse_lookup.py` ports `parseVttTimestamp`,
   `parseVtt`, and `Track.thumbnailFor` line-for-line to Python and asserts the
   floor + coverage-bound behavior on a shared fixture (17 checks, all passing).
2. **Static review** (this file, verified 2026-10-04 by reading the source):
   - brace balance: balanced (checked with `python3 -c` counter — see test log).
   - imports: `java.awt.image.BufferedImage`, `java.io.*`, `java.net.*`,
     `javax.imageio.ImageIO` — all JDK stdlib, no external artifact.
   - no `android.*`, no `androidx.*`, no coroutines/okhttp/retrofit imports —
     pure JVM as claimed; the single Android touchpoint is the documented
     `cropTile` swap comment.
   - public surface: `Cue`, `Track` (+`thumbnailFor`, `coversWholeSource`,
     `coveredUntilOnLocalTimeline`), `parseVttTimestamp`, `parseVtt`,
     `OpenSeekClient` (`movieUrl`/`episodeUrl`, `loadTrack`/`loadMovieTrack`/
     `loadEpisodeTrack`, `sheetBytes` LRU-32, `cropTile`). Regex JSON readers
     only touch the lookup envelope fields (`vtt_url`, `source_duration_ms`,
     `scale`, `status`, `covered_until_ms`) — no general JSON parsing claimed.
   - `scale <= 0` guard matches the JS `track.scale > 0 ? … : 1` fallback.

First environment with a JDK should run:
`kotlinc packages/kotlin/src/main/kotlin/openseek/OpenSeekClient.kt -d /tmp/opencode/o.jar`
(or the Gradle module, when added) and promote this note to a compile gate.

## Contribute half review (no `kotlinc` in this environment)

`OpenSeekContribute.kt` (v0.2 track, playback code untouched) is covered two ways:

1. **Algorithmic**: `tests/test_contribute_model.py` ports `tileBoxForTimestamp`,
   `formatContributeTimestamp`, `longestContiguousSlotRun`,
   `buildContributeVtt`, the `ContributeBatch` gate, and
   `parseUploadResponse` (+ derived `promoted`/`refused`/`accepted`)
   line-for-line to Python and asserts them on shared fixtures (38 checks,
   all passing — VTT byte assertions, stitch determinism with identical
   bytes on repeat, verdict cases promoted/merged/duplicate/small/
   timeout-shape plus error/unparsable fallbacks).
2. **Static review** (verified 2026-10-04 by reading the source):
   - brace balance: 73/73, parens 371/371 (checked with `python3 -c` counter).
   - imports: `java.awt.*`, `java.io.*`, `java.net.*`, `javax.imageio.*`
     (incl. `javax.imageio.stream.MemoryCacheImageOutputStream`),
     `kotlin.random.Random` — all JDK/stdlib, no external artifact.
   - no `android.*`, no `androidx.*`, no coroutines/okhttp/retrofit/
     kotlinx-serialization imports — pure JVM as claimed; the Android
     touchpoints are documented (`cropTile` swap, platform sheet composer).
   - multipart field/file names match the registry intake (`meta`/
     `metadata.json`, `vtt`/`thumbnails-capture.vtt`, `sheet`/`sheet-c-N.jpg`)
     and the reference client; `tileBoxForTimestamp` cell math and the VTT
     writer are verbatim ports of `SeekPreviewCapture.kt`.
   - one fix applied during review: `writer.output.flush()` does not exist
     (platform `Any!`) — replaced with a typed
     `MemoryCacheImageOutputStream` reference; bytes are pushed through by
     the writer's end-of-image flushBefore, so no flush call is needed.

First environment with a JDK should compile both `openseek/*.kt` files and
run a `main()`-based check (fixture tiles -> VTT bytes, stitch determinism,
verdict cases) as the compile gate for this half.
