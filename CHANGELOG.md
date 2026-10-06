# Changelog

## Unreleased — contract-truth pass (no behaviour change)

- `docs/wire.md`: the "permissive mode" section was wrong — the registry keys
  `GET /v1/sprites` and every intake route. Replaced with the keyed/open table,
  the real 401 bodies, quota-counted-never-enforced, no rate limiter, key never
  bypasses verification.
- `docs/wire.md`: added the omitted `GET /v1/contributions/<id>` (keyed) and
  `POST /v1/requests` (keyed); corrected "cue *i* starts at `i × interval`"
  (only true for a complete bundle — a `pending` version can start late);
  corrected the `covered_until_ms` "legacy rows omit it" note (the server
  substitutes `source_duration_ms`, the field is always present); added the
  CDN-base rule for `vtt_url` and sheet resolution; added key-storage
  (`sha256` + `key_prefix`, revoke by prefix); stated that npm/Maven are
  prepared but not published; disambiguated `sdk/js/peek.js` +
  `sdk/kotlin/Peek.kt` from the packages under `packages/`.
- `packages/js`: `loadTrack` sent no key at all, so it 401'd against the live
  registry. Added an optional per-call `apiKey`, sent as `X-API-Key` when
  non-blank and omitted when null/undefined/empty/whitespace. Lookup only —
  the VTT usually lives on the CDN. Zero deps, v0 semantics and return shapes
  unchanged.
- `packages/js/test_lookup.mjs` (new): stubs `fetch` and asserts the header is
  present when a key is set and absent when blank, plus the parse/floor/coverage
  round trip and the late-first-cue case.
- `packages/kotlin`: `apiKey` stays nullable (no breaking API change), but the
  KDoc no longer claims lookups are open, and a 401 now throws a message naming
  the key instead of a bare `IllegalStateException` status code.

## 0.1.0 — initial public SDK

- Pure-logic extraction from NuvioMobile `SeekPreviewModels.kt`, decoupled from
  all app code (no player state, settings, or app HTTP helpers).
- `packages/js`: registry `/v1/sprites` lookup, WebVTT parse (full
  `#xywh` cue boxes, sheet-relative URL resolution), floor `thumbnailFor`
  with `covered_until_ms` bound, sheet LRU + canvas `drawImage` crop,
  `paintPeek` helper. Zero deps.
- `packages/kotlin`: same in pure JVM (`HttpURLConnection`, sheet LRU,
  `javax.imageio`/`java.awt` crop with documented Android swap). Zero deps.
- `docs/wire.md`: frozen v0 contract.
- Supersedes the `sdk/` embryos (`peek.js`, `Peek.kt`): correct registry path,
  full cue boxes, coverage bound (no stale tail tile on partial versions).
