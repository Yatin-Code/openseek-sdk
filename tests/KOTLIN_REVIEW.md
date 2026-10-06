# Kotlin core review (no `kotlinc` in this environment)

`OpenSeekClient.kt` is pure-JVM Kotlin with zero third-party deps. It could not
be compiled here (no kotlinc/java toolchain), so it is covered two ways:

1. **Algorithmic**: `tests/test_parse_lookup.py` ports `parseVttTimestamp`,
   `parseVtt`, and `Track.thumbnailFor` line-for-line to Python and asserts the
   floor + coverage-bound behavior on a shared fixture (17 checks, all passing).
2. **Static review** (this file, verified 2026-10-04 by reading the source,
   re-checked 2026-10-05 after the 401-message change):
   - brace balance: balanced (string/comment-aware `python3` counter: depth 0,
     final state `code`).
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
   - auth: `apiKey` is still `String? = null` (no breaking API change); it is
     stamped as `X-API-Key` whenever non-null, which includes a blank string.
     A 401 is folded into a message naming the key by the new private
     `fail(code, body, what)` helper instead of a bare `check(...)` status.

The 401 path is **not** covered by the Python model (it is HTTP plumbing, not
parse math). `packages/js/test_lookup.mjs` covers the JS equivalent of the same
gate — header present when set, absent when blank — and runs on the VPS.

First environment with a JDK should run:
`kotlinc packages/kotlin/src/main/kotlin/openseek/OpenSeekClient.kt -d /tmp/opencode/o.jar`
(or the Gradle module, when added) and promote this note to a compile gate.
