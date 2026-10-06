# openseek-sdk

Public client SDK for the [OpenSeek](https://github.com/Yatin-Code/openpeek) seek-preview registry:
scrub thumbnails (sprite sheets + `#xywh` WebVTT) keyed by title id + duration. Lookup once,
resolve any playback position to a tile, blit it under the scrubber.

- `packages/js/` — dependency-free browser client (`fetch` + canvas `drawImage`), v0.1.0, no deps.
- `packages/kotlin/` — pure-JVM core (`HttpURLConnection`, in-memory sheet LRU,
  `javax.imageio`/`java.awt` crop), v0.1.0, no deps.
- `docs/wire.md` — frozen v0 wire contract (lookup params, response fields,
  coverage rule, auth/permissive mode, error shapes).

Both packages implement the same pure logic, extracted from the working
NuvioMobile player code (`SeekPreviewModels.kt`: query building, VTT parse,
floor lookup with coverage bound) and decoupled from all app code — no player
state, no settings, no app HTTP helpers. They **supersede** the `sdk/js/peek.js`
and `sdk/kotlin/Peek.kt` embryos in the main repo, which hit the local-origin
`/sprites` path, dropped the `#xywh` box from parsed cues, and had no
`covered_until_ms` bound (stale tail tile past partial coverage).

Coverage rule (both SDKs): a partial (`pending`) version serves only up to
`covered_until_ms` — `thumbnailFor` returns null past it instead of the last cue.

## Quickstart — Kotlin (ExoPlayer scrub listener + popup ImageView)

```kotlin
val client = OpenSeekClient("https://tiles.example.com")
val track = client.loadMovieTrack(tmdbId = 27205, durationMs = player.duration)
timeBar.setOnScrubListener(object : DefaultTimeBar.OnScrubListener {
  override fun onScrubMove(bar: DefaultTimeBar, pos: Long) {
    track?.thumbnailFor(pos)?.let { cue ->           // floor + coverage bound
      popupImage.setImageBitmap(client.cropTile(client.sheetBytes(cue.imageUrl), cue))
      popup.show(bar, pos)                            // position popup over scrubber
    } ?: popup.dismiss()                              // 404 / past coverage: hide
  }
  override fun onScrubStart(bar: DefaultTimeBar, pos: Long) = Unit
  override fun onScrubStop(bar: DefaultTimeBar, pos: Long, c: Boolean) = popup.dismiss()
})
```

Notes: run `loadMovieTrack`/`sheetBytes` off the main thread (they do network
I/O and throw on transport errors — catch and treat as a silent miss).
**Android crop swap:** `cropTile` uses `ImageIO` (JVM/desktop); on Android replace
its body with `BitmapFactory.decodeByteArray` + `Bitmap.createBitmap(...)` —
marked in the source. No API key needed for lookups.

## Quickstart — JS (HTML5 video seek bar + canvas crop)

```js
import { loadMovieTrack, paintPeek } from "@openseek/sdk";
const track = await loadMovieTrack("https://tiles.example.com",
  { tmdb_id: 27205, duration_ms: video.duration * 1000 });
seekbar.addEventListener("input", async () => {       // scrub position 0..1000
  const pos = seekbar.value / 1000 * video.duration * 1000;
  (await paintPeek(canvas, track, pos)) ? popup.show() : popup.hide();
});                                                  // null track / past coverage: hide
video.addEventListener("seeked", () => popup.hide());
```

`paintPeek` crops via `drawImage` into your `<canvas>` (sized to the tile) and
returns `false` when there is no preview. `loadTrack` returns `null` on 404
(unknown title). No dependencies, no build step — import the file directly.

## Self-tests

```sh
python3 tests/test_parse_lookup.py   # parse + floor/coverage math model (both SDKs)
node --check packages/js/src/index.js  # JS syntax (node present in dev env)
```

The Kotlin core has no `kotlinc` in this environment, so it is covered by the
same Python model test (identical algorithm, ported line-for-line) plus a
brace-balance/import review recorded in `tests/KOTLIN_REVIEW.md`.
No Maven/npm publish yet (see release workflow TODO).

## License

MIT — see [LICENSE](LICENSE). Never commit API keys or registry secrets;
test fixtures use the public placeholder base `https://tiles.example.com`.
