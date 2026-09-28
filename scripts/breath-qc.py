# /// script
# dependencies = ["soundfile", "numpy"]
# ///
"""breath-qc: break up breathless narrator passages the WRITING cannot fix.

Background. A first listener heard the narrator "speeding up" in ep01. Measurement
showed the real defect was not speed at all: a 18.6s stretch with no pause in it.
Segment-average metrics (words-per-minute, syllables-per-second) are blind to this,
because a segment can average perfectly while containing a sprint.

The primary fix is WRITING -- shorter sentences give the model sentence boundaries
to breathe at, and the retention contract (Canon/style-guide.md) cut the episode's
worst run from 18.6s to 6.6s with no audio processing at all. Prefer that always.

This tool exists for the residue:
  * PROTECTED passages (hand-written prose we are forbidden to rewrite), and
  * segments where the writing is fine but the model simply refused to pause.

It does NOT time-stretch and does NOT touch pitch. It finds pauses the model
ALREADY placed but clipped too short, and lengthens them -- so the breath lands on
a boundary the model itself chose. Idempotent: re-running finds nothing to do.
"""
import json, os, subprocess, sys
from pathlib import Path

import numpy as np
import soundfile as sf

from lib import showconfig as sc

MAX_RUN = 8.0        # longest acceptable unbroken speech stretch (median is ~5s)
BREATH = 0.20        # a gap at/above this already reads as a breath
TARGET = 0.42        # what we lengthen a chosen pause to
MIN_CANDIDATE = 0.06 # ignore anything shorter: that is co-articulation, not a boundary

def frames(x, sr):
    fl = int(sr * 0.02); n = len(x) // fl
    rms = np.sqrt((x[:n*fl].reshape(n, fl)**2).mean(axis=1) + 1e-12)
    return rms > max(np.percentile(rms, 95) * 0.05, 1e-4), fl

def gaps(voiced):
    """interior silence runs as (start_frame, length_frames)"""
    idx = np.flatnonzero(voiced)
    if len(idx) < 2: return []
    out, run = [], 0
    for k in range(idx[0], idx[-1] + 1):
        if not voiced[k]: run += 1
        elif run: out.append((k - run, run)); run = 0
    return out

def longest_run(marks, dur):
    best, at = 0.0, 0.0
    for a, b in zip(marks, marks[1:]):
        if b - a > best: best, at = b - a, a
    return best, at

def fix(path):
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1: x = x.mean(axis=1)
    dur = len(x) / sr
    inserted = 0.0
    for _ in range(6):                       # bounded; each pass breaks one sprint
        voiced, fl = frames(x, sr)
        g = gaps(voiced)
        marks = [0.0] + [s*0.02 for s, l in g if l*0.02 >= BREATH] + [len(x)/sr]
        run, at = longest_run(marks, len(x)/sr)
        if run <= MAX_RUN: break
        # candidate boundaries strictly inside the offending run
        cands = [(s*0.02, l*0.02) for s, l in g
                 if MIN_CANDIDATE <= l*0.02 < BREATH and at < s*0.02 < at + run]
        if not cands: break
        # prefer the candidate nearest the middle of the run (splits it most evenly)
        mid = at + run/2
        pos, cur = min(cands, key=lambda c: abs(c[0] + c[1]/2 - mid))
        add = TARGET - cur
        if add <= 0: break
        k = int((pos + cur/2) * sr)
        x = np.concatenate([x[:k], np.zeros(int(add*sr), dtype=np.float32), x[k:]])
        inserted += add
    if inserted > 0:
        sf.write(path, x, sr)
    return inserted, dur


def resynth(ep: str) -> None:
    """Re-render this episode's missing takes: run tts-generate.py as a child of THIS process.

    Three properties matter, and all three are the point (plan ruling F-11):
      * the child is this interpreter and the script beside this file -- not `uv run` and not a
        show-relative path, because the engine runs a step with the SHOW root as the working
        directory, where this repository's scripts are not;
      * its stdout is NOT redirected, so its ::progress lines and its per-segment prints reach the
        engine's log instead of being swallowed;
      * it is NOT given a new session, so it stays in the process group the engine spawned and
        kills on shutdown or timeout.
    The episode id travels as argv: no environment variable carries it any more.
    """
    subprocess.run([sys.executable, str(Path(__file__).with_name("tts-generate.py")), ep],
                   check=True)


def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    # Which speaker key carries the narration is the show's to say (audio.narratorSpeakerKey).
    narrator = str(sc.value(cfg, "audio", "narratorSpeakerKey"))
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("breath-qc: episode id missing (usage: breath-qc.py <episode> [--show-root <path>])")
    base = f"Production/{ep}"
    doc = json.load(open(f"{base}/tts-script.json"))
    if doc.get("engine", "kokoro") != "qwen3":
        print("BREATH_QC_SKIP (kokoro)"); return
    narr = {s["i"] for s in doc["segments"] if s["speaker"] == narrator}

    touched = total = 0
    for pos, i in enumerate(sorted(narr), 1):
        p = f"{base}/audio/segments/{i:04d}.wav"
        sc.progress(pos, len(narr), "segments")
        if not os.path.exists(p): continue
        got, dur = fix(p)
        if got > 0:
            touched += 1; total += got
            print(f"  seg {i:4d}: +{got:.2f}s of breath (segment was {dur:.1f}s)")
    if touched:
        # Inserting breath makes every touched WAV longer than the duration the
        # manifest recorded at synth time. audio-mix reads the WAVs directly and
        # never notices -- but build-timeline.py, shot-sheet.py and publish-kit.py
        # all place their cues by accumulating manifest duration_s, so a stale
        # manifest walks every later scene cut, subtitle and YouTube chapter
        # EARLY by the total inserted (ep05 1.66s, ep07 1.62s, ep08 1.38s all
        # shipped that way before this was found -- 2026-09-01).
        # Same contract pace-qc keeps: whatever mutates a WAV re-measures.
        # tts-generate skips existing files, so this only rewrites the manifest.
        resynth(ep)
        print(f"BREATH_QC_OK ({touched} segments given breath, {total:.1f}s inserted; "
              f"manifest durations refreshed)")
    else:
        print(f"BREATH_QC_OK (no {narrator} segment exceeds {MAX_RUN:.0f}s unbroken)")

if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"breath-qc: {err}")
