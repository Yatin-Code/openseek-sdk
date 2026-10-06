# OpenSeek wire protocol — frozen v0 contract

Base: the registry origin, e.g. `https://tiles.example.com`.
All paths below are relative to it. CORS: `*` on GETs.

## Packages — published work is not live yet

npm `@openseek/sdk` and Maven `tv.openseek:openseek-sdk-jvm` are **prepared but
NOT published**: no account, no tag, no artifact. The version is still
`0.2.0-unreleased`, so `npm i @openseek/sdk` does not resolve and the Maven
coordinates are in no repository. Until they land, import the file straight
from this repo (`packages/js/src/index.js` — zero build step, zero deps) or
copy `packages/kotlin/src/main/kotlin/openseek/OpenSeekClient.kt`; the
checklist is `docs/PUBLISHING.md`.

"Both SDKs" in this document always means those two packages under
`packages/`. It does **not** mean `sdk/js/peek.js` + `sdk/kotlin/Peek.kt` in
the main openpeek repo: those are unkeyed embryos that predate the key
requirement, hit the local-origin `/sprites` path, drop the `#xywh` box from
parsed cues and carry no coverage bound.

## Lookup

```
GET /v1/sprites?tmdb_id|imdb_id|show_tmdb_id|show_imdb_id[&season&episode]&duration_ms[&version=N]
```

| param | required | notes |
|---|---|---|
| `tmdb_id` / `imdb_id` | one of the four | movies: exactly one |
| `show_tmdb_id` / `show_imdb_id` | one of the four | episodes: exactly one, plus `season` + `episode` |
| `season`, `episode` | for episodes | integers |
| `duration_ms` | always | local playback duration; picks the nearest stored version |
| `version` | never | pins an exact `version_no` instead of nearest-match |

Version selection: nearest stored version within **±240s** of `duration_ms`.
Same title ±15s contributions merge server-side; clients never see this.

### Success (200, `Cache-Control: public, max-age=300`)

```json
{
  "media_type": "movie",
  "title": "Example Film",
  "vtt_url": "https://tiles.example.com/s/t3-v1/thumbnails.vtt",
  "version": 1,
  "source_duration_ms": 7140000,
  "scale": 1.0014,
  "status": "complete",
  "covered_until_ms": 7140000,
  "tmdb_id": 27205
}
```

| field | meaning |
|---|---|
| `vtt_url` | absolute URL of the WebVTT (fetch it next) |
| `version` | served `version_no` |
| `source_duration_ms` | duration the stored version was captured from |
| `scale` | `want / source` — divide local positions by it before cue lookup |
| `status` | `"complete"` (whole title) or `"pending"` (partial stripe) |
| `covered_until_ms` | source-time end of served coverage. Always present: the server substitutes `source_duration_ms` when the row's value is NULL, so "field absent = fully covered" is not a state you will ever observe |
| id echo | whichever ids the title row holds (`tmdb_id`, `imdb_id`, `show_*`, `season`, `episode`) |

Coverage rule (client-side): after the scale correction, positions past
`covered_until_ms` MUST return null (hide the thumbnail) instead of the last
cue — otherwise a partial VTT shows a stale tail tile. Both packages under
`packages/` do this by default (`thumbnailFor` bound).

### Errors

| code | body | meaning |
|---|---|---|
| 401 | `{"error":"api key required (X-API-Key)"}` | no `X-API-Key` header — see Auth |
| 401 | `{"error":"invalid api key"}` | unknown/revoked key — see Auth |
| 400 | `{"error":"duration_ms required"}` | missing `duration_ms` |
| 400 | `{"error":"tmdb_id\|imdb_id\|show_* required"}` | no usable id |
| 404 | `{"error":"not indexed"}` | unknown title, or no version within ±240s — silent miss, hide preview |
| 404 | `{"error":"version not found"}` | pinned `version` does not exist |

## VTT + sheets

- `GET vtt_url` → `WEBVTT`, cues `start --> end` + payload
  `sheet-0.jpg#xywh=x,y,w,h` (`text/vtt`, 300s cache).
- Cues are in time order and their `start` is the only authority. Take the
  **last cue whose start is ≤ the scrub position**; a position before the first
  cue has no preview either. Do NOT assume cue *i* starts at seconds
  `i × interval` — that identity only holds for a COMPLETE bundle. A partial
  (`pending`) version can start later: the live Moana version's first cue is
  `00:01:00.000` (slot 6 on the 10s grid) with `covered_until_ms` 150000.
- Cue payload URLs are sheet-relative: resolve against the VTT URL's own
  directory. Never concatenate the registry base onto a sheet name (see CDN
  base below).
- Sheets: `image/jpeg`, immutable (1-year cache). Tile size is uniform per
  version; interval ∈ {5, 10, 30}s. Grid geometry is an implementation detail
  and differs per producer (spritegen stores 10×10 sheets, client uploads pack
  5×5): read the per-cue `x/y/w/h` and never derive a tile position from an
  assumed grid.
- Timestamps are `HH:MM:SS.mmm` (zero-padded hours — past the 1h mark cues
  start with `01:`; don't count cues with `grep -c '^00'`). `MM:SS.mmm`
  is tolerated on parse.

### CDN base

`vtt_url` is advertised against a CDN base when the registry is started with
`--cdn-base` (or `$OPENSEEK_CDN_BASE`) — in production that base is blob
storage, so the VTT and its sheets are **not** behind the registry origin. Fetch
`vtt_url` exactly as returned and resolve sheet names relative to that VTT's
own location. `/s/**` stays available and serves the local store for
self-hosted setups with no CDN configured.

## Auth — keyed by default, no permissive mode

The key gate is the first statement on a keyed route. `GET /v1/sprites` runs it
before `duration_ms` or any id is parsed, so an unauthed caller gets 401, never
the 400s above. Missing key → `401 {"error":"api key required (X-API-Key)"}`;
unknown key → `401 {"error":"invalid api key"}`.

Keyed (need `X-API-Key`):

- `GET /v1/sprites`
- `POST /v1/contribute` (multipart intake)
- `POST /v1/register`
- `GET /v1/contributions/<id>` — keyed *before* the id is parsed, so an
  unauthed caller cannot probe which contribution ids exist
- `POST /v1/contributions`, `POST /v1/verify`, `POST /v1/promote`, and the
  `/v1/contributions/<id>/verify|promote` forms
- internal worker routes only: `POST /v1/jobs/lease` and
  `POST /v1/jobs/<id>/ack` / `fail` (see below)

There is **no public job or request intake**. `POST /v1/requests` and
`POST /v1/jobs` are gone. The
only public write is `POST /v1/contribute`, where a client uploads previews it
captured itself and the registry never fetches anything. Those two paths now
answer `404 {"error":"public intake is closed - POST previews you captured
with POST /v1/contribute"}` — unauthed too, so the 404 never reads as "get a
key and retry".

Open (no key):

- `GET /v1/status`, `GET /v1/titles`, `GET /v1/catalog`
- `GET /v1/keys/validate` — open route that *checks* the presented key: known →
  `200 {"valid":true,"name":…}`, anything else → `401 {"valid":false}`. Quota-free
  by design, so it is safe for a settings dialog to call.
- `GET /v1/requests` — the backlog read stays open, but with intake closed it
  answers empty unless the operator's own tooling wrote a row
- `/s/**` static, `/healthz`

A key never bypasses verification — promotion still refuses an unverified
contribution. Quota is counted per key per UTC day but never enforced (over-quota
still 200, never 429); one server flag enables the 429. There is no rate
limiter.

### How the packages send it

`packages/js` takes `apiKey` per call — `loadTrack(url, { apiKey })`, and
`loadMovieTrack`/`loadEpisodeTrack` pass it through as a third `opts` argument.
It sets `X-API-Key` on the lookup when the value is non-blank and omits the
header entirely when it is null/undefined/empty/whitespace, so a misconfigured
key never ships as `X-API-Key: `. The header goes on the lookup only, not on the
VTT fetch: that URL usually points at the CDN, where the key is both unnecessary
and a cross-origin preflight liability. With no key configured, the live
registry answers 401 and `loadTrack` throws `lookup failed: HTTP 401`.

`packages/kotlin` takes it on the constructor — `OpenSeekClient(base, apiKey)` —
and stamps `X-API-Key` on every request when non-null. `apiKey` stays nullable
(source compatibility for a published constructor), but the hosted registry
requires one: a default-constructed client 401s, and `loadTrack` turns that into
an `IllegalStateException` naming the missing key rather than a bare status code.
Browser POSTs cross-port rely on the server's `OPTIONS` preflight handler, which
allows `X-API-Key`.

### Key storage

Keys live as `sha256(key)` in `keys.key_hash` plus a 6-character
`keys.key_prefix`. A minted key is displayed once and cannot be re-displayed;
the plaintext `keys.key` column is legacy-only (readable, never written) and
still backs the bootstrap key. **Revoke by `key_prefix`** — there is no
plaintext row left to match, so `DELETE FROM keys WHERE key = '<the key>'`
silently matches nothing on any minted row.

## Companion routes (not part of the SDK surface)

`GET /v1/titles` (version list), `GET /v1/status`, `GET /v1/catalog`
(browsable index, `?limit` capped at 1000), `POST /v1/contribute`
(multipart intake → quarantine → verify → promote/merge), `POST /v1/register`
(population-time upsert), and `GET /v1/contributions/<id>` (intake state for
one contribution). Their key requirements are in the Auth table above. See the
registry source for shapes.

### Internal worker routes (not part of the public contract)

`POST /v1/jobs/lease`, `POST /v1/jobs/<id>/ack` and `POST /v1/jobs/<id>/fail`
are keyed like everything else, but they are for the operator's own workers and
are not part of the public API: nothing hands a stranger a job, and no SDK calls
them. The `jobs` table behind them is still real — the operator's producer
inserts rows into it directly, on the registry host, because the database is
not reachable from anywhere else.
