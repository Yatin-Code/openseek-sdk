// test_contribute.mjs — contribution-half checks (v0.2): VTT shape, cell math,
// determinism, verdict parser, multipart bytes, uploadContribution wiring.
// Zero deps. Run: node test_contribute.mjs
import assert from "node:assert/strict";
import {
  CAPTURE_INTERVAL_MS,
  CONTRIBUTE_BUNDLE_TILES,
  tileBoxForTimestamp,
  slotStartFor,
  formatCaptureTimestamp,
  longestContiguousSlotRun,
  buildCaptureVtt,
  parseContributeResponse,
  buildContributeMeta,
  buildContributeMultipartBody,
  ContributeBatch,
  uploadContribution,
} from "./src/index.js";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL ${name}: ${err.message}`);
      process.exitCode = 1;
    });
}

// Deterministic synthetic tile bytes (content is opaque to batching/VTT;
// the browser canvas path decodes real JPEGs at runtime, node uses the
// deterministic fallback so logic stays testable without a DOM).
const tile = (i) => new Uint8Array([0xff, 0xd8, 0xff, i & 0xff, 0x00, 0x10, i >> 8 & 0xff, 0x42]);
const grid = (n, step = CAPTURE_INTERVAL_MS, start = 0) =>
  Array.from({ length: n }, (_, i) => start + i * step);

const seq = [];
seq.push(() => check("cell math: slot 0/24/25/30", () => {
  assert.deepEqual(tileBoxForTimestamp(0), { sheetFileName: "sheet-c-0.jpg", x: 0, y: 0, w: 320, h: 180 });
  assert.deepEqual(tileBoxForTimestamp(24 * 10000), { sheetFileName: "sheet-c-0.jpg", x: 1280, y: 720, w: 320, h: 180 });
  assert.deepEqual(tileBoxForTimestamp(25 * 10000), { sheetFileName: "sheet-c-1.jpg", x: 0, y: 0, w: 320, h: 180 });
  assert.deepEqual(tileBoxForTimestamp(30 * 10000), { sheetFileName: "sheet-c-1.jpg", x: 0, y: 180, w: 320, h: 180 });
  assert.equal(slotStartFor(19999), 10000);
}));

seq.push(() => check("timestamps: zero-pad + past-1h 01: prefix", () => {
  assert.equal(formatCaptureTimestamp(0), "00:00:00.000");
  assert.equal(formatCaptureTimestamp(61000), "00:01:01.000");
  assert.equal(formatCaptureTimestamp(3661001), "01:01:01.001");
}));

seq.push(() => check("VTT: header, time-order, clamp, #xywh payloads", () => {
  const vtt = buildCaptureVtt([20000, 0, 10000], 25000);
  const lines = vtt.split("\n");
  assert.equal(lines[0], "WEBVTT");
  const cues = [...vtt.matchAll(/(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)\n(\S+)/g)];
  assert.equal(cues.length, 3);
  assert.equal(cues[0][1], "00:00:00.000");
  assert.equal(cues[2][1], "00:00:20.000");
  assert.equal(cues[2][2], "00:00:25.000"); // end clamped to durationMs
  assert.equal(cues[0][3], "sheet-c-0.jpg#xywh=0,0,320,180");
  assert.equal(cues[1][3], "sheet-c-0.jpg#xywh=320,0,320,180");
  // out-of-range slots are dropped
  assert.equal([...buildCaptureVtt([0, 99999999], 60000).matchAll(/#xywh/g)].length, 1);
}));

seq.push(() => check("longest run: order-insensitive, negatives ignored", () => {
  assert.deepEqual(longestContiguousSlotRun([60000, -5, 20000, 0, 10000, 50000]), [0, 10000, 20000]);
  assert.deepEqual(longestContiguousSlotRun([]), []);
}));

seq.push(() => check("readiness: 48 contiguous ready; 47 or fragmented not", () => {
  const full = new ContributeBatch(3600000);
  grid(CONTRIBUTE_BUNDLE_TILES).forEach((ts, i) => assert.equal(full.addTile(ts, tile(i)), true));
  assert.equal(full.isReadyToFlush(), true);
  assert.equal(full.addTile(-1, tile(0)), false);
  assert.equal(full.addTile(999999, new Uint8Array(0)), false);
  const short = new ContributeBatch(3600000);
  grid(47).forEach((ts, i) => short.addTile(ts, tile(i)));
  assert.equal(short.isReadyToFlush(), false);
  const sparse = new ContributeBatch(3600000);
  grid(48, 30000).forEach((ts, i) => sparse.addTile(ts, tile(i))); // 30s steps: no adjacency on the 10s grid
  assert.equal(sparse.longestRun().length, 1);
  assert.equal(sparse.isReadyToFlush(), false);
}));

seq.push(() => check("flush: 48 tiles -> 48 cues, 2 sheets, consumes bank", async () => {
  const batch = new ContributeBatch(3600000);
  grid(48).forEach((ts, i) => batch.addTile(ts, tile(i)));
  const out = await batch.flush();
  assert.equal(out.timestamps.length, 48);
  assert.equal([...out.vttText.matchAll(/#xywh/g)].length, 48);
  assert.deepEqual(out.sheets.map((s) => s.fileName), ["sheet-c-0.jpg", "sheet-c-1.jpg"]);
  for (const s of out.sheets) assert.ok(s.jpeg.length > 0);
  assert.equal(batch.size, 0);
  assert.equal(await batch.flush(), null); // below floor after consume
}));

seq.push(() => check("flush: longest run only, remainder stays banked", async () => {
  const batch = new ContributeBatch(3600000);
  [...grid(6), ...grid(5, CAPTURE_INTERVAL_MS, 100000)].forEach((ts) => batch.addTile(ts, tile(1)));
  const out = await batch.flush();
  assert.deepEqual(out.timestamps, grid(6));
  assert.deepEqual(batch.pendingTimestamps(), grid(5, CAPTURE_INTERVAL_MS, 100000));
}));

seq.push(() => check("determinism: same tiles -> identical VTT + sheet bytes", async () => {
  const make = async () => {
    const b = new ContributeBatch(3600000);
    grid(48).forEach((ts, i) => b.addTile(ts, tile(i)));
    return b.flush();
  };
  const a = await make();
  const c = await make();
  assert.equal(a.vttText, c.vttText);
  assert.deepEqual(a.sheets.map((s) => s.fileName), c.sheets.map((s) => s.fileName));
  for (let i = 0; i < a.sheets.length; i++) assert.deepEqual(a.sheets[i].jpeg, c.sheets[i].jpeg);
}));

seq.push(() => check("verdict parser: promoted / merged / refused / error shapes", () => {
  let v = parseContributeResponse(JSON.stringify({ state: "promoted", status: "complete", covered_until_ms: 480000, contribution_id: 7 }), 200);
  assert.equal(v.promoted, true);
  assert.equal(v.refused, false);
  assert.equal(v.versionStatus, "complete");
  assert.equal(v.coveredUntilMs, 480000);
  assert.equal(v.contributionId, 7);
  v = parseContributeResponse(JSON.stringify({ state: "Promoted", merged: true, added_slots: 48, kept_slots: 12, status: "pending", covered_until_ms: 480000 }), 200);
  assert.equal(v.promoted && v.merged, true);
  assert.equal(v.addedSlots, 48);
  assert.equal(v.keptSlots, 12);
  v = parseContributeResponse(JSON.stringify({ state: "rejected", duplicate: true, reason: "duplicate" }), 200);
  assert.equal(v.refused, true);
  assert.equal(v.promoted, false);
  assert.equal(v.reason, "duplicate");
  v = parseContributeResponse(JSON.stringify({ state: "rejected", verify_reason: "bad_interval:7" }), 200);
  assert.equal(v.refused, true);
  assert.equal(v.reason, "bad_interval:7");
  v = parseContributeResponse(JSON.stringify({ state: "rejected", conflict: "tile_size_mismatch" }), 200);
  assert.equal(v.reason, "tile_size_mismatch");
  v = parseContributeResponse(JSON.stringify({ error: "X-API-Key required" }), 401);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "X-API-Key required");
  v = parseContributeResponse("not json", 200);
  assert.equal(v.reason, "unparsable_body");
  v = parseContributeResponse(JSON.stringify({}), 500);
  assert.equal(v.reason, "http_500");
}));

seq.push(() => check("meta + multipart: names, boundary, byte-determinism", () => {
  const meta = JSON.parse(buildContributeMeta({ tmdb_id: 27205 }, 7140000, "Example Film", "my-host"));
  assert.deepEqual(meta, { media_type: "movie", tmdb_id: 27205, title: "Example Film", duration_ms: 7140000, interval_ms: 10000, uploader: "my-host" });
  const ep = JSON.parse(buildContributeMeta({ show_tmdb_id: 1, season: 2, episode: 3 }, 1000, "", ""));
  assert.equal(ep.media_type, "episode");
  assert.equal(ep.title, "Unknown");
  const sheets = [{ fileName: "sheet-c-0.jpg", jpeg: tile(9) }];
  const b1 = buildContributeMultipartBody('{"a":1}', "WEBVTT\n", sheets, "FIXED");
  const b2 = buildContributeMultipartBody('{"a":1}', "WEBVTT\n", sheets, "FIXED");
  assert.deepEqual(b1, b2);
  const text = new TextDecoder().decode(b1);
  assert.ok(text.includes('name="meta"; filename="metadata.json"'));
  assert.ok(text.includes('name="vtt"; filename="thumbnails-capture.vtt"'));
  assert.ok(text.includes('name="sheet"; filename="sheet-c-0.jpg"'));
  assert.ok(text.endsWith("--FIXED--\r\n"));
}));

seq.push(() => check("uploadContribution: request shape + verdict wiring", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, text: async () => JSON.stringify({ state: "promoted", merged: true, added_slots: 48, status: "pending", covered_until_ms: 480000 }) };
  };
  const batch = new ContributeBatch(3600000);
  grid(48).forEach((ts, i) => batch.addTile(ts, tile(i)));
  const bundle = await batch.flush();
  const v = await uploadContribution("https://tiles.example.com/", "key123", { tmdb_id: 5 }, 3600000, "T", "my-host", bundle, { fetchFn, boundary: "FIXED" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://tiles.example.com/v1/contribute");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["X-API-Key"], "key123");
  assert.equal(calls[0].opts.headers["Content-Type"], "multipart/form-data; boundary=FIXED");
  assert.ok(calls[0].opts.body instanceof Uint8Array);
  assert.equal(v.promoted && v.merged && v.addedSlots === 48, true);
  // empty bundle never hits fetch
  let fetched = false;
  const v2 = await uploadContribution("https://x", "k", { tmdb_id: 5 }, 1000, "T", "u", { vttText: "", sheets: [] }, { fetchFn: async () => { fetched = true; throw new Error("must not fetch"); } });
  assert.equal(v2.ok, false);
  assert.equal(v2.reason, "empty_payload");
  assert.equal(fetched, false);
  // transport throw -> ok:false verdict, never throws
  const v3 = await uploadContribution("https://x", "k", { tmdb_id: 5 }, 1000, "T", "u", { vttText: "WEBVTT\n", sheets: [{ fileName: "s.jpg", jpeg: tile(1) }] }, { fetchFn: async () => { throw new Error("down"); } });
  assert.equal(v3.ok, false);
  assert.ok(v3.reason.startsWith("error:"));
}));

for (const run of seq) await run();
console.log(`\n${passed} checks passed${process.exitCode ? " (WITH FAILURES)" : ""}`);
