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
