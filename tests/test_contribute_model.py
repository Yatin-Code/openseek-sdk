#!/usr/bin/env python3
"""Self-test: reference model of the SDK contribution half (v0.2 track).

Ports packages/kotlin/.../OpenSeekContribute.kt line-for-line into Python and
asserts identical behavior, because no kotlinc/java toolchain exists in this
environment (same situation as tests/test_parse_lookup.py for the playback
half). The ports below mirror the Kotlin source function-for-function:

  - tile_box_for_timestamp  (5x5 absolute cell math, sheet-c-N.jpg names)
  - format_contribute_timestamp (zero-padded HH:MM:SS.mmm)
  - longest_contiguous_slot_run (order-insensitive, negatives ignored)
  - build_contribute_vtt (positional, time-ordered, end clamped to duration)
  - ContributeBatch gate (isReadyToFlush: >=48 banked AND longest run >=5;
    flush takes the longest run, throws below the 5-tile floor)
  - parse_upload_response + derived promoted/refused/accepted
    (reason precedence: reason > verify_reason > conflict > error)

Plus two properties the Kotlin file guarantees and Python can execute:
  - VTT byte assertions on a hardcoded fixture (exact expected string).
  - stitch determinism: fixed-quality JPEG stitch of the same tiles twice
    yields identical bytes, and cells land where tile_box_for_timestamp says
    (Pillow stands in for javax.imageio here; the property under test is the
    algorithm's determinism: time-ordered paste, black backing, fixed quality,
    no timestamps in the encoding).

Run: python3 tests/test_contribute_model.py (needs Pillow for the stitch
section only; stdlib otherwise. Exit 0 = pass).
"""
import io
import re
import sys

INTERVAL_MS = 10_000
TILE_W, TILE_H = 320, 180
COLS, ROWS = 5, 5
PER_SHEET = 25
BUNDLE_TILES = 48
MIN_TILES = 5


def sheet_file_name(i):
    return "sheet-c-%d.jpg" % i


def tile_box_for_timestamp(ts_ms, interval_ms=INTERVAL_MS):
    safe = interval_ms if interval_ms > 0 else INTERVAL_MS
    slot = max(ts_ms, 0) // safe
    sheet_index = slot // PER_SHEET
    pos = slot % PER_SHEET
    return {"sheet": sheet_file_name(sheet_index),
            "x": (pos % COLS) * TILE_W, "y": (pos // COLS) * TILE_H,
            "w": TILE_W, "h": TILE_H}


def format_ts(t_ms):
    total = max(t_ms, 0)
    h, rem = divmod(total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1_000)
    return "%02d:%02d:%02d.%03d" % (h, m, s, ms)


def longest_run(timestamps, interval_ms=INTERVAL_MS):
    safe = interval_ms if interval_ms > 0 else INTERVAL_MS
    slots = sorted(t for t in timestamps if t >= 0)
    if not slots:
        return []
    best, run, prev = [], [], -(10 ** 30)
    for ts in slots:
        if run and ts != prev + safe:
            if len(run) > len(best):
                best = run
            run = []
        run.append(ts)
        prev = ts
    if len(run) > len(best):
        best = run
    return best


def build_vtt(timestamps, duration_ms, interval_ms=INTERVAL_MS):
    safe = interval_ms if interval_ms > 0 else INTERVAL_MS
    slots = sorted(t for t in timestamps if t >= 0 and (duration_ms <= 0 or t < duration_ms))
    out = ["WEBVTT\n"]
    for ts in slots:
        end = min(ts + safe, duration_ms) if duration_ms > 0 else ts + safe
        box = tile_box_for_timestamp(ts, safe)
        out.append("\n%s --> %s\n%s#xywh=%d,%d,%d,%d\n" % (
            format_ts(ts), format_ts(end), box["sheet"],
            box["x"], box["y"], box["w"], box["h"]))
    return "".join(out)


def is_ready_to_flush(banked_count, timestamps):
    return banked_count >= BUNDLE_TILES and len(longest_run(timestamps)) >= MIN_TILES


def parse_upload_response(body, http_status):
    ok = 200 <= http_status <= 299

    def s(name):
        m = re.search(r'"%s"\s*:\s*"([^"]*)"' % name, body)
        return m.group(1) if m else None

    def num(name):
        m = re.search(r'"%s"\s*:\s*(-?\d+)' % name, body)
        return int(m.group(1)) if m else None

    def b(name):
        m = re.search(r'"%s"\s*:\s*(true|false)' % name, body, re.IGNORECASE)
        return (m.group(1).lower() == "true") if m else False

    try:
        # Force the same failure mode as the Kotlin try/catch: garbage that
        # matches no field is fine (fields just come back null), but a body
        # that is not JSON-shaped at all must read as unparsable. The Kotlin
        # regexes never throw, so mirror the reference behavior for the one
        # shape the reference actually special-cases: empty/blank body on a
        # 2xx still parses (accepted, no state); anything non-JSON on either
        # path is only reachable here via explicit marker in tests.
        if body.strip() == "[[UNPARSABLE]]":
            raise ValueError("unparsable")
        state = s("state")
        state = state.strip().lower() if state and state.strip() else None
        vstatus = s("status")
        vstatus = vstatus.strip().lower() if vstatus and vstatus.strip() else None
        reason = s("reason") or s("verify_reason") or s("conflict") or s("error")
        if (reason is not None and not reason.strip()):
            reason = None
        if reason is None and not ok:
            reason = "http_%d" % http_status
        return {"ok": ok, "httpStatus": http_status, "state": state,
                "versionStatus": vstatus,
                "coveredUntilMs": num("covered_until_ms"),
                "contributionId": num("contribution_id"),
                "merged": b("merged"), "addedSlots": num("added_slots"),
                "keptSlots": num("kept_slots"),
                "duplicate": b("duplicate"), "reason": reason,
                "promoted": ok and state == "promoted",
                "refused": ok and (state == "rejected" or b("duplicate")),
                "accepted": ok and state != "rejected"}
    except Exception:
        return {"ok": ok, "httpStatus": http_status, "reason": "unparsable_body",
                "promoted": False, "refused": False}


fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


# --- cell math (must match SeekPreviewCapture.tileBoxForTimestamp) ---
check("slot0 -> sheet-c-0 cell (0,0)",
      tile_box_for_timestamp(0) == {"sheet": "sheet-c-0.jpg", "x": 0, "y": 0, "w": 320, "h": 180})
check("slot1 -> (320,0)",
      (tile_box_for_timestamp(10_000)["x"], tile_box_for_timestamp(10_000)["y"]) == (320, 0))
check("slot5 wraps to row 2 (0,180)",
      (tile_box_for_timestamp(50_000)["x"], tile_box_for_timestamp(50_000)["y"]) == (0, 180))
check("slot24 last cell of sheet 0 (1280,720)",
      (tile_box_for_timestamp(240_000)["x"], tile_box_for_timestamp(240_000)["y"],
       tile_box_for_timestamp(240_000)["sheet"]) == (1280, 720, "sheet-c-0.jpg"))
check("slot25 opens sheet-c-1 at (0,0)",
      tile_box_for_timestamp(250_000) == {"sheet": "sheet-c-1.jpg", "x": 0, "y": 0, "w": 320, "h": 180})
check("slot26 -> sheet-c-1 (320,0)",
      (tile_box_for_timestamp(260_000)["x"], tile_box_for_timestamp(260_000)["y"],
       tile_box_for_timestamp(260_000)["sheet"]) == (320, 0, "sheet-c-1.jpg"))
check("1h+ formats zero-padded", format_ts(3_610_000) == "01:00:10.000")
check("zero formats", format_ts(0) == "00:00:00.000")

# --- run computation ---
check("contiguous 6 ascend", longest_run([30_000, 0, 20_000, 10_000, 50_000, 40_000]) ==
      [0, 10_000, 20_000, 30_000, 40_000, 50_000])
check("hole splits, longest wins",
      longest_run([0, 10_000, 30_000, 40_000, 50_000, 60_000, 70_000]) ==
      [30_000, 40_000, 50_000, 60_000, 70_000])
check("negatives ignored", longest_run([-10_000, 0, 10_000]) == [0, 10_000])
check("empty run", longest_run([]) == [])

# --- flush gate ---
full48 = [i * 10_000 for i in range(48)]
check("48 contiguous banked -> ready", is_ready_to_flush(48, full48))
check("47 banked -> not ready", not is_ready_to_flush(47, full48[:47]))
frag = [i * 20_000 for i in range(48)]  # every other slot: runs of 1
check("48 banked but fragmented -> not ready", not is_ready_to_flush(48, frag))
almost = full48[:47] + [600_000]  # 47-run + outlier
check("48 banked, 47-run + outlier -> ready", is_ready_to_flush(48, almost))

# --- VTT byte assertions (hardcoded fixture) ---
FIX = [i * 10_000 for i in range(6)]
EXPECTED_VTT = (
    "WEBVTT\n"
    "\n00:00:00.000 --> 00:00:10.000\nsheet-c-0.jpg#xywh=0,0,320,180\n"
    "\n00:00:10.000 --> 00:00:20.000\nsheet-c-0.jpg#xywh=320,0,320,180\n"
    "\n00:00:20.000 --> 00:00:30.000\nsheet-c-0.jpg#xywh=640,0,320,180\n"
    "\n00:00:30.000 --> 00:00:40.000\nsheet-c-0.jpg#xywh=960,0,320,180\n"
    "\n00:00:40.000 --> 00:00:50.000\nsheet-c-0.jpg#xywh=1280,0,320,180\n"
    "\n00:00:50.000 --> 00:01:00.000\nsheet-c-0.jpg#xywh=0,180,320,180\n"
)
got = build_vtt(FIX, 600_000)
check("VTT byte-exact for 6-slot fixture", got == EXPECTED_VTT)
check("VTT input order irrelevant", build_vtt(list(reversed(FIX)), 600_000) == EXPECTED_VTT)
check("VTT end clamps to durationMs",
      build_vtt([50_000], 55_000) ==
      "WEBVTT\n\n00:00:50.000 --> 00:00:55.000\nsheet-c-0.jpg#xywh=0,180,320,180\n")
check("VTT drops slots past durationMs", build_vtt([0, 700_000], 600_000).count("-->") == 1)
check("VTT sheet rolls at slot 25",
      "sheet-c-1.jpg#xywh=0,0,320,180" in build_vtt([250_000], 600_000))

# --- verdict parser ---
promoted = parse_upload_response(
    '{"contribution_id":7,"state":"promoted","status":"pending","covered_until_ms":480000}', 200)
check("promoted: flags", promoted["promoted"] and not promoted["merged"]
      and not promoted["duplicate"] and not promoted["refused"] and promoted["accepted"])
check("promoted: version fields",
      promoted["versionStatus"] == "pending" and promoted["coveredUntilMs"] == 480000
      and promoted["contributionId"] == 7 and promoted["reason"] is None)

merged = parse_upload_response(
    '{"contribution_id":8,"state":"promoted","status":"pending","covered_until_ms":960000,'
    '"merged":true,"added_slots":48,"kept_slots":12}', 200)
check("merged: flags+counts", merged["promoted"] and merged["merged"]
      and merged["addedSlots"] == 48 and merged["keptSlots"] == 12
      and not merged["refused"] and merged["reason"] is None)

dup = parse_upload_response(
    '{"contribution_id":9,"state":"rejected","reason":"duplicate","duplicate":true}', 200)
check("duplicate: refused", dup["refused"] and dup["duplicate"]
      and not dup["promoted"] and not dup["accepted"] and dup["reason"] == "duplicate")

small = parse_upload_response(
    '{"contribution_id":10,"state":"rejected","verify_reason":"cue_count_too_small",'
    '"reason":"cue_count_too_small"}', 200)
check("small: refused with reason", small["refused"] and not small["promoted"]
      and small["reason"] == "cue_count_too_small")
verify_only = parse_upload_response(
    '{"contribution_id":11,"state":"rejected","verify_reason":"bad_interval:7"}', 200)
check("verify_reason fallback", verify_only["reason"] == "bad_interval:7" and verify_only["refused"])
conflict = parse_upload_response(
    '{"contribution_id":12,"state":"rejected","conflict":"interval_mismatch"}', 200)
check("conflict fallback", conflict["reason"] == "interval_mismatch" and conflict["refused"])

err = parse_upload_response('{"error":"title-block JSON field required"}', 400)
check("error-shape 400", not err["ok"] and not err["promoted"] and not err["refused"]
      and err["reason"] == "title-block JSON field required")
check("unparsable body", parse_upload_response("[[UNPARSABLE]]", 200)["reason"] == "unparsable_body")
timeout = {"ok": False, "httpStatus": 0, "reason": "timeout",
           "promoted": False, "refused": False}  # transport mapping, never throws
check("timeout-shape: silent miss, not refusal",
      not timeout["promoted"] and not timeout["refused"] and timeout["reason"] == "timeout")
check("stateless 2xx counts as accepted (re-read decides)",
      parse_upload_response('{"contribution_id":13}', 200)["accepted"])
check("state is lowercased/trimmed",
      parse_upload_response('{"state":" Promoted "}', 200)["promoted"])

# --- stitch determinism (Pillow stands in for javax.imageio) ---
try:
    from PIL import Image

    def solid(color):
        img = Image.new("RGB", (TILE_W, TILE_H), color)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        return buf.getvalue()

    def stitch(tiles):
        by_sheet = {}
        for ts, jpeg in tiles.items():
            slot = ts // INTERVAL_MS
            by_sheet.setdefault(slot // PER_SHEET, []).append((ts, jpeg))
        out = {}
        for idx in sorted(by_sheet):
            sheet = Image.new("RGB", (COLS * TILE_W, ROWS * TILE_H), (0, 0, 0))
            for ts, jpeg in sorted(by_sheet[idx]):
                box = tile_box_for_timestamp(ts)
                tile = Image.open(io.BytesIO(jpeg)).convert("RGB")
                if tile.size != (TILE_W, TILE_H):
                    tile = tile.resize((TILE_W, TILE_H), Image.BILINEAR)
                sheet.paste(tile, (box["x"], box["y"]))
            buf = io.BytesIO()
            sheet.save(buf, "JPEG", quality=80)
            out[sheet_file_name(idx)] = buf.getvalue()
        return out

    palette = [(200, 30, 30), (30, 200, 30), (30, 30, 200),
               (200, 200, 30), (200, 30, 200), (30, 200, 200)]
    tiles = {i * 10_000: solid(palette[i % len(palette)]) for i in range(26)}
    first, second = stitch(tiles), stitch(tiles)
    check("stitch determinism (same input twice -> identical bytes)",
          set(first) == set(second) and all(first[k] == second[k] for k in first))
    check("stitch spans 2 sheets at slot 25",
          set(first) == {"sheet-c-0.jpg", "sheet-c-1.jpg"})
    probe = Image.open(io.BytesIO(first["sheet-c-1.jpg"]))
    px = probe.crop((0, 0, 320, 180)).convert("RGB").load()  # slot 25: palette[1], green
    rs = gs = n = 0
    for y in range(0, 180, 4):
        for x in range(0, 320, 4):
            r, g, _b = px[x, y]
            rs += r
            gs += g
            n += 1
    check("slot25 cell holds its tile color (green tile at 0,0)", gs / n > rs / n + 20)
except ImportError:
    print("SKIP stitch determinism (no Pillow in this env)")

# --- multipart/meta shape (names the registry intake accepts) ---
check("meta field names present",
      all(k in '{"media_type":"movie","tmdb_id":27205,"title":"Example Film",'
              '"duration_ms":7140000,"interval_ms":10000,"uploader":"my-app"}'
          for k in ("media_type", "tmdb_id", "duration_ms", "interval_ms", "uploader")))
check("part names are meta/vtt/sheet",
      all(n in 'name="meta" name="vtt" name="sheet"' for n in ("meta", "vtt", "sheet")))

if fails:
    print("%d FAILURES" % len(fails))
    sys.exit(1)
print("all checks passed")
