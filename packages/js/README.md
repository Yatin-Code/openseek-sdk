# @openseek/sdk (JS)

Dependency-free browser client for the OpenSeek seek-preview registry.
Import the file directly — no build step, no dependencies.

```js
import { loadMovieTrack, paintPeek } from "@openseek/sdk";   // NOT on npm yet
```

Publishing is **prepared but not live**: version is `0.2.0-unreleased`, so
`npm i @openseek/sdk` does not resolve. Until the tag lands, copy/import
`src/index.js` from this repo.

Every lookup is keyed. Pass the key in `opts`:

```js
const track = await loadMovieTrack("https://tiles.example.com",
  { tmdb_id: 27205, duration_ms: 7123456 }, { apiKey: MY_KEY });
```

With no `apiKey` the header is omitted and the registry answers 401.

See the repo README for the 10-line seek-bar integration and
`docs/wire.md` for the frozen v0 contract.

Publishing: `package.json` carries the npm `publishConfig` (`@openseek/sdk`
is a provisional name — may need renaming, see `docs/PUBLISHING.md`);
version stays `0.2.0-unreleased` until tag time.
