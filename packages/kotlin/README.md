# openseek-kotlin (JVM core)

Pure-JVM client for the OpenSeek seek-preview registry. Zero third-party deps
(stdlib + `javax.imageio`/`java.awt` only).

Single file: `src/main/kotlin/openseek/OpenSeekClient.kt`.

**Android callers:** everything works as-is except `cropTile` — swap its body
for `BitmapFactory.decodeByteArray` + `Bitmap.createBitmap(...)` (marked in
the source). See the repo README for the 10-line ExoPlayer integration and
`docs/wire.md` for the frozen v0 contract.
