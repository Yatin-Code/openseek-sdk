# Changelog

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
