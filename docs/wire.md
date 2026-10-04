# OpenSeek wire protocol — frozen v0 contract

Base: the registry origin, e.g. `https://tiles.example.com`.
All paths below are relative to it. CORS: `*` on GETs.

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
| `covered_until_ms` | source-time end of served coverage; legacy rows omit it (= fully covered) |
| id echo | whichever ids the title row holds (`tmdb_id`, `imdb_id`, `show_*`, `season`, `episode`) |

Coverage rule (client-side): after the scale correction, positions past
`covered_until_ms` MUST return null (hide the thumbnail) instead of the last
cue — otherwise a partial VTT shows a stale tail tile. Both bundled SDKs do
this by default (`thumbnailFor` bound).

### Errors

| code | body | meaning |
|---|---|---|
| 400 | `{"error":"duration_ms required"}` | missing `duration_ms` |
| 400 | `{"error":"tmdb_id\|imdb_id\|show_* required"}` | no usable id |
| 404 | `{"error":"not indexed"}` | unknown title, or no version within ±240s — silent miss, hide preview |
| 404 | `{"error":"version not found"}` | pinned `version` does not exist |

## VTT + sheets

- `GET vtt_url` → `WEBVTT`, cues `start --> end` + payload
  `sheet-0.jpg#xywh=x,y,w,h` (`text/vtt`, 300s cache). Cue *i* starts at
  seconds `i × interval`.
- Cue payload URLs are sheet-relative: resolve against the VTT URL's directory.
- Sheets: `image/jpeg`, immutable (1-year cache). Tile size is uniform per
  version; interval ∈ {5, 10, 30}s.
- Timestamps are `HH:MM:SS.mmm` (zero-padded hours — past the 1h mark cues
  start with `01:`; don't count cues with `grep -c '^00'`). `MM:SS.mmm`
  is tolerated on parse.

## Auth — permissive mode

Lookups and static serving are **open, no key**. `X-API-Key` is required ONLY
on the `/v1/jobs*` worker routes (missing/invalid → 401). Quota usage is
counted per key but never enforced (over-quota still 200, never 429) — the
server flips one flag to enforce. SDKs accept an optional apiKey and send it
as `X-API-Key` where set; browser POSTs cross-port rely on the server's
`OPTIONS` preflight handler.

## Companion routes (not part of the SDK surface)

`GET /v1/titles` (version list), `GET /v1/status`, `POST /v1/contribute`
(multipart intake → quarantine → verify → promote/merge), `POST /v1/register`
(population-time upsert). See the registry source for shapes.
