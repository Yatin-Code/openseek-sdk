#!/usr/bin/env python3
"""Self-test: reference model of the SDK parse + floor/coverage math.

Ports packages/js/src/index.js and packages/kotlin/.../OpenSeekClient.kt
line-for-line into Python and asserts identical behavior on a shared fixture,
including the load-bearing edge cases:
  - HH:MM:SS.mmm with zero-padded hours past the 1h mark
  - sheet-relative payload resolution against the VTT directory
  - cues without #xywh are skipped (silent miss for that slot)
  - floor lookup (last cue <= pos, scale-corrected)
  - covered_until_ms bound kills the stale tail tile on pending versions
  - null coverage = unbounded (pre-coverage behavior)
  - scale<=0 falls back to 1.0

Run: python3 tests/test_parse_lookup.py (stdlib only, exit 0 = pass).
"""
import re
import sys


def parse_ts(raw):
    parts = str(raw).strip().split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        sec = parts[-1].split(".")
        seconds = int(sec[0])
        millis = int((sec[1] + "000")[:3]) if len(sec) > 1 else 0
        minutes = int(parts[-2])
        hours = int(parts[0]) if len(parts) == 3 else 0
    except ValueError:
        return None
    if not (0 <= minutes <= 59 and 0 <= seconds <= 59 and 0 <= millis <= 999):
        return None
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis


def parse_vtt(text, vtt_url):
    base = vtt_url.rsplit("/", 1)[0].rstrip("/")
    cues = []
    pending = None
    for raw in str(text).split("\n"):
        line = raw.strip()
        if line == "":
            pending = None
            continue
        if "-->" in line:
            pending = parse_ts(line.split("-->")[0])
            continue
        if line.startswith("WEBVTT") or line.startswith("NOTE"):
            continue
        if pending is None:
            continue
        start, pending = pending, None
        h = line.find("#xywh=")
        if h < 0:
            continue
        raw_url, box_s = line[:h].strip(), line[h + len("#xywh="):]
        try:
            box = [int(x.strip()) for x in box_s.split(",")]
        except ValueError:
            continue
        if len(box) != 4 or any(b < 0 for b in box):
            continue
        url = raw_url if re.match(r"https?://", raw_url) else base + "/" + raw_url
        cues.append({"startMs": start, "imageUrl": url, "x": box[0], "y": box[1],
                     "w": box[2], "h": box[3]})
    cues.sort(key=lambda c: c["startMs"])
    return cues


def thumbnail_for(track, pos_ms, covered=...):
    if covered is ...:
        covered = track.get("covered_until_ms", track.get("coveredUntilMs"))
    scale = track.get("scale", 1.0) or 1.0
    scale = scale if scale > 0 else 1.0
    pos = int(pos_ms // scale)
    if covered is not None and pos > covered:
        return None
    hit = None
    for c in track["cues"]:
        if c["startMs"] <= pos:
            hit = c
        else:
            break
    return hit


VTT = """WEBVTT

00:00:00.000 --> 00:00:10.000
sheet-0.jpg#xywh=0,0,320,180

00:00:10.000 --> 00:00:20.000
this cue has no box and must be skipped

00:00:20.000 --> 00:00:30.000
sheet-0.jpg#xywh=320,0,320,180

01:00:10.000 --> 01:00:20.000
sheet-5.jpg#xywh=0,180,320,180
"""
VTT_URL = "https://tiles.example.com/s/t3-v1/thumbnails.vtt"

fails = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


cues = parse_vtt(VTT, VTT_URL)
check("cue count (boxless skipped)", len(cues) == 3)
check("cue order kept", [c["startMs"] for c in cues] == [0, 20000, 3610000])
check("1h+ timestamp parses", cues[2]["startMs"] == 3610000)
check("relative sheet resolves vs VTT dir",
      cues[0]["imageUrl"] == "https://tiles.example.com/s/t3-v1/sheet-0.jpg")
check("xywh box parsed", (cues[1]["x"], cues[1]["y"], cues[1]["w"], cues[1]["h"]) == (320, 0, 320, 180))
check("bad timestamp rejected", parse_ts("99:99.000") is None and parse_ts("nope") is None)
check("MM:SS tolerated", parse_ts("05:30.500") == 330500)

full = {"cues": cues, "scale": 1.0, "covered_until_ms": None, "status": "complete"}
check("floor: pos inside cue0", thumbnail_for(full, 5000)["startMs"] == 0)
check("floor: gap maps to cue0 (not skipped slot)", thumbnail_for(full, 15000)["startMs"] == 0)
check("floor: exact cue start", thumbnail_for(full, 20000)["startMs"] == 20000)
check("floor: before first cue is null", thumbnail_for(full, -1) is None)

pend = {"cues": cues, "scale": 1.0, "covered_until_ms": 25000, "status": "pending"}
check("pending: inside coverage hits", thumbnail_for(pend, 20000)["startMs"] == 20000)
check("pending: past coverage is null (no stale tail)",
      thumbnail_for(pend, 30000) is None and thumbnail_for(pend, 3610000) is None)
check("pending: bound lifted with null", thumbnail_for(pend, 3610000, None)["startMs"] == 3610000)

scaled = {"cues": cues, "scale": 2.0, "covered_until_ms": None}
check("scale: local/2 -> source (40000 local = cue 20000)",
      thumbnail_for(scaled, 40000)["startMs"] == 20000)
scaled_pend = {"cues": cues, "scale": 2.0, "covered_until_ms": 25000}
check("scale: coverage compared in source time (60000 local = 30000 src > 25000 -> null)",
      thumbnail_for(scaled_pend, 60000) is None)
zero_scale = {"cues": cues, "scale": 0, "covered_until_ms": None}
check("scale<=0 falls back to 1.0", thumbnail_for(zero_scale, 20000)["startMs"] == 20000)

if fails:
    print("%d FAILURES" % len(fails))
    sys.exit(1)
print("all %d checks passed" % (17))
