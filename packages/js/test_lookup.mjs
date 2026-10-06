// test_lookup.mjs — lookup-path checks for the v0 wire contract: the
// X-API-Key header the registry gates on, and the parse/floor/coverage round
// trip. Zero deps. Run: node test_lookup.mjs
import assert from "node:assert/strict";
import {
  loadTrack, loadMovieTrack, parseVtt, parseVttTimestamp, thumbnailFor,
} from "./src/index.js";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { passed++; console.log(`PASS ${name}`); })
    .catch((err) => { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; });
}

const REG = "https://tiles.example.com";
const VTT = `WEBVTT

00:00:00.000 --> 00:00:10.000
sheet-0.jpg#xywh=0,0,320,180

00:00:10.000 --> 00:00:20.000
this cue has no box and must be skipped

00:00:20.000 --> 00:00:30.000
sheet-0.jpg#xywh=320,0,320,180
`;

const ENVELOPE = {
  media_type: "movie",
  vtt_url: `${REG}/s/t3-v1/thumbnails.vtt`,
  version: 1,
  source_duration_ms: 30000,
  scale: 1.0,
  status: "complete",
  covered_until_ms: 30000,
  tmdb_id: 27205,
};

// fetch stub: records every (url, init) so the header assertion can inspect
// exactly what went out. `vttHost` lets a CDN-hosted VTT be exercised.
function stubFetch({ envelope = ENVELOPE, vtt = VTT, vttUrl = envelope.vtt_url,
                     lookupStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || null });
    if (url === vttUrl) {
      return { ok: true, status: 200, text: async () => vtt };
    }
    if (lookupStatus !== 200) {
      return { ok: false, status: lookupStatus, json: async () => ({ error: "boom" }) };
    }
    return { ok: true, status: 200, json: async () => envelope };
  };
  return { fetchFn, calls };
}

const headerOn = (call, name) => (call.headers || {})[name];
const seq = [];

seq.push(() => check("apiKey set -> X-API-Key sent on the lookup", async () => {
  const { fetchFn, calls } = stubFetch();
  await loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`,
    { fetchFn, apiKey: "secret-key" });
  assert.equal(calls[0].url.includes("/v1/sprites"), true);
  assert.equal(headerOn(calls[0], "X-API-Key"), "secret-key");
}));

seq.push(() => check("no apiKey -> no X-API-Key header at all", async () => {
  const { fetchFn, calls } = stubFetch();
  await loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`, { fetchFn });
  assert.equal(calls[0].headers, null);
}));

seq.push(() => check("blank apiKey (undefined/null/''/'   ') -> no header", async () => {
  for (const apiKey of [undefined, null, "", "   ", "\t\n"]) {
    const { fetchFn, calls } = stubFetch();
    await loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`,
      { fetchFn, apiKey });
    assert.equal(calls[0].headers, null, `sent a header for ${JSON.stringify(apiKey)}`);
  }
}));

seq.push(() => check("key trimmed before it goes out", async () => {
  const { fetchFn, calls } = stubFetch();
  await loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`,
    { fetchFn, apiKey: "  secret-key  " });
  assert.equal(headerOn(calls[0], "X-API-Key"), "secret-key");
}));

seq.push(() => check("VTT fetch carries no key (it is usually a CDN URL)", async () => {
  const cdn = "https://cdn.example.net/b/t3-v1/thumbnails.vtt";
  const { fetchFn, calls } = stubFetch({
    envelope: { ...ENVELOPE, vtt_url: cdn }, vttUrl: cdn,
  });
  const track = await loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`,
    { fetchFn, apiKey: "secret-key" });
  assert.equal(calls[0].url.includes("/v1/sprites"), true);
  assert.equal(calls[1].url, cdn);
  assert.equal(headerOn(calls[1], "X-API-Key"), undefined);
  // sheet names resolve against the VTT's own location, never the registry base
  assert.equal(track.cues[0].imageUrl, "https://cdn.example.net/b/t3-v1/sheet-0.jpg");
}));

seq.push(() => check("401 surfaces as a throw, 404 as null", async () => {
  const bad = stubFetch({ lookupStatus: 401 });
  await assert.rejects(
    () => loadTrack(`${REG}/v1/sprites?tmdb_id=27205&duration_ms=30000`,
      { fetchFn: bad.fetchFn }),
    /lookup failed: HTTP 401/);
  const miss = stubFetch({ lookupStatus: 404 });
  const track = await loadTrack(`${REG}/v1/sprites?tmdb_id=1&duration_ms=30000`,
    { fetchFn: miss.fetchFn });
  assert.equal(track, null);
}));

seq.push(() => check("loadMovieTrack threads apiKey through", async () => {
  const { fetchFn, calls } = stubFetch();
  await loadMovieTrack(REG, { tmdb_id: 27205, duration_ms: 30000 },
    { fetchFn, apiKey: "secret-key" });
  assert.equal(calls[0].url.includes("tmdb_id=27205"), true);
  assert.equal(calls[0].url.includes("duration_ms=30000"), true);
  assert.equal(headerOn(calls[0], "X-API-Key"), "secret-key");
}));

seq.push(() => check("VTT parse: boxless cue skipped, sheets resolved, order kept", async () => {
  const cues = parseVtt(VTT, `${REG}/s/t3-v1/thumbnails.vtt`);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((c) => c.startMs), [0, 20000]);
  assert.equal(cues[0].imageUrl, `${REG}/s/t3-v1/sheet-0.jpg`);
  assert.deepEqual([cues[1].x, cues[1].y, cues[1].w, cues[1].h], [320, 0, 320, 180]);
}));

seq.push(() => check("timestamps: zero-padded 01: past 1h, MM:SS tolerated", () => {
  assert.equal(parseVttTimestamp("01:00:10.000"), 3610000);
  assert.equal(parseVttTimestamp("05:30.500"), 330500);
  assert.equal(parseVttTimestamp("99:99.000"), null);
  assert.equal(parseVttTimestamp("nope"), null);
}));

seq.push(() => check("floor: last cue <= pos, null before the first cue", () => {
  const track = { cues: parseVtt(VTT, `${REG}/s/t3-v1/thumbnails.vtt`), scale: 1,
    covered_until_ms: null };
  assert.equal(thumbnailFor(track, 5000).startMs, 0);
  assert.equal(thumbnailFor(track, 15000).startMs, 0);   // gap maps back to cue 0
  assert.equal(thumbnailFor(track, 20000).startMs, 20000);
  assert.equal(thumbnailFor(track, -1), null);
}));

seq.push(() => check("pending: bound kills the stale tail past coverage", () => {
  const track = { cues: parseVtt(VTT, `${REG}/s/t3-v1/thumbnails.vtt`), scale: 1,
    covered_until_ms: 25000, status: "pending" };
  assert.equal(thumbnailFor(track, 20000).startMs, 20000);
  assert.equal(thumbnailFor(track, 30000), null);
  assert.equal(thumbnailFor(track, 20000, null).startMs, 20000);  // bound lifted
}));

seq.push(() => check("partial bundle starting late: floor on cue start, not slot", () => {
  // A `pending` version whose first cue is 00:01:00.000 (slot 6 on a 10s
  // grid). Cue i is NOT at i*interval, so a slot-derived lookup would answer
  // 60s at pos 5s; the cue-start floor must answer null.
  const cues = parseVtt(`WEBVTT

00:01:00.000 --> 00:01:10.000
sheet-0.jpg#xywh=0,0,320,180

00:01:10.000 --> 00:01:20.000
sheet-0.jpg#xywh=320,0,320,180

00:01:20.000 --> 00:01:30.000
sheet-0.jpg#xywh=640,0,320,180

00:01:30.000 --> 00:01:40.000
sheet-0.jpg#xywh=0,180,320,180
`, `${REG}/s/t9-v1/thumbnails.vtt`);
  const track = { cues, scale: 1, covered_until_ms: 150000, status: "pending" };
  assert.deepEqual(cues.map((c) => c.startMs), [60000, 70000, 80000, 90000]);
  assert.equal(thumbnailFor(track, 5000), null);     // before first cue: no preview
  assert.equal(thumbnailFor(track, 60000).startMs, 60000);
  assert.equal(thumbnailFor(track, 75000).startMs, 70000);
  assert.equal(thumbnailFor(track, 150001), null);   // past coverage
}));

for (const step of seq) await step();
if (process.exitCode) console.error(`${seq.length - passed}/${seq.length} checks passed`);
else console.log(`all ${passed} checks passed`);
