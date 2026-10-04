# @openseek/sdk (JS)

Dependency-free browser client for the OpenSeek seek-preview registry.
Import directly — no build step, no dependencies.

```js
import { loadMovieTrack, paintPeek } from "@openseek/sdk";
```

See the repo README for the 10-line seek-bar integration and
`docs/wire.md` for the frozen v0 contract.

## Contribute (v0.2) — host capture loop

Bank one 320x180 JPEG per 10s grid slot, flush every 48 tiles, upload.
`flush()` stitches absolute 5x5 sheets via canvas (`OffscreenCanvas` preferred,
`<canvas>` fallback); outside a browser it emits deterministic placeholder
bytes (test-only — the registry's verify step refuses non-JPEG sheets).

```js
import { ContributeBatch, uploadContribution } from "@openseek/sdk";
const batch = new ContributeBatch(video.duration * 1000); // 10s grid, 320x180 tiles
const ids = { tmdb_id: 27205 }; // or imdb_id / show_* + season + episode
setInterval(() => { // grab at most 1 frame per 5s, skip when paused
  if (video.paused || video.seeking) return; // never jank playback
  grabCtx.drawImage(video, 0, 0, 320, 180); // grabCanvas is 320x180
  grabCanvas.toBlob((b) => batch.addTile(video.currentTime * 1000, b));
}, 5000);
const bundle = batch.isReadyToFlush() ? await batch.flush() : null; // 48 banked + 5-slot clean run
if (bundle) await uploadContribution(base, apiKey, ids, video.duration * 1000, title, "my-host", bundle);
```
