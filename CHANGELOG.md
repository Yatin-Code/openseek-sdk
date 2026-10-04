# Changelog

## Unreleased — contribution half (v0.2 track, playback untouched)

- `packages/kotlin`: new `OpenSeekContribute.kt` (zero deps, pure JVM).
  `ContributeBatch` banks grabbed tiles, `isReadyToFlush` gates on >=48
  banked AND a grid-contiguous run >=5, `flush()` emits the longest run as a
  positional time-ordered VTT + deterministic 5x5 sheets (fixed JPEG quality,
  absolute slot numbering matching `SeekPreviewCapture.tileBoxForTimestamp`).
  `uploadContribution` POSTs `/v1/contribute` (multipart `meta`/`vtt`/`sheet`,
  same contract as the reference client) and folds the inline
  verify+promote answer into `UploadVerdict` (`promoted`/`merged`/
  `addedSlots`/`keptSlots`/`versionStatus`/`coveredUntilMs`/`duplicate`/
  `refused`/`reason`; tolerant parsing incl. `verify_reason`/`conflict`/
  `error`; never throws — `timeout` / `error:<msg>` on transport failure).
- Self-test: `tests/test_contribute_model.py` (38 checks, all passing —
  no JDK in this env, so a line-for-line Python model cross-check like the
  playback half; static brace/import review recorded in
  `tests/KOTLIN_REVIEW.md`).
- `packages/kotlin/README`: 10-line contribute host-loop snippet.

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
