# /// script
# dependencies = ["soundfile", "numpy"]
# ///
"""truncation-qc: catch takes where the engine stopped generating mid-word.

Background. ep09 seg 43 -- "Mass finds mass, given time, and the dead had
nothing but time." -- shipped to the audio gate with the final word chopped.
Qwen3 simply ended the generation early. Nothing in the QC chain saw it:
pace-qc measures words-per-minute and losing 0.34s off an 8.8s segment moves
that only ~4%, nowhere near its +/-15% band; breath-qc only looks at interior
pauses. It reached the showrunner's ear (2026-09-01) because he happened to be
listening for a respelling in the same stretch.

The tell is the shape of the ENDING, not the length, and it takes TWO measures.

1. Tail energy. A take that finished ends in its own release; a cut-off take is
   still at full speaking volume on its last sample. Measure the final TAIL_S
   against the segment's own speech level.

2. The trim pad. Energy alone is not enough -- short punchy lines ("Mm.",
   "Fly well,") clear any useful energy threshold while ending perfectly well.
   What separates them is tts-generate's trim(), which keeps
   [first>0.01 - 30ms, last>0.01 + 30ms]: a take that FINISHED has quiet
   material after its last loud sample, so trim leaves a sub-0.01 pad on the
   end. A take the engine cut off has nothing after it and ends hot, pad zero.

Calibrated against every qwen3 segment on disk -- 4227 of them across ep01-ep09.
Energy alone (>0.6) flags 10, of which 8 end in a clean decay and are fine. The
pad alone (<5ms) flags 248, far too many. Together they flag 2, both in ep08,
both confirmed by re-rolling the same text: seg 329 came back 25% LONGER
(1.402s -> 1.758s), seg 355 came back ending in a 30ms pad instead of none.
ep09 seg 43 -- the defect that started this -- scored 0.78 with a 0.0ms pad and
is caught by the same rule.

Fix is the same shape as pace-qc's: bump the pinned seed so the re-roll is a
genuinely new take, delete the WAV, re-run tts-generate. Bounded at PASSES
rounds, then fails loudly so a human looks at the stubborn segment rather than
a chopped word shipping quietly.

Kokoro episodes: no-op (deterministic engine, and this is a sampling failure).
"""
import json, os, subprocess, sys
from pathlib import Path

import numpy as np
import soundfile as sf

from lib import showconfig as sc

THRESHOLD = 0.6   # final-tail RMS / speech RMS above which a take reads as cut off
TAIL_S = 0.06     # how much of the ending to measure
SPEECH_FLOOR = 0.005  # |sample| above this counts as speech (audio-mix's convention)
PAD_FLOOR = 0.01  # trim()'s own floor -- must stay in step with tts-generate.trim
MIN_PAD_MS = 5.0  # less trailing pad than this means trim found nothing to pad with
PASSES = 2        # re-roll rounds before giving up and failing loudly
RESEED = 104729   # pace-qc's re-roll constant -- one house convention for "new take"


def tail_ratio(x: np.ndarray, sr: int) -> float:
    """How loud the last TAIL_S is relative to this segment's own speech.

    ~0.0 = ended in its release (normal). ~1.0 = still at full voice when the
    file stopped (cut off). Returns 0.0 for a segment with no speech in it.
    """
    if x.ndim > 1:
        x = x.mean(axis=1)
    speech = x[np.abs(x) > SPEECH_FLOOR]
    if not len(speech):
        return 0.0
    ref = float(np.sqrt((speech.astype(np.float64) ** 2).mean()))
    tail = x[-int(sr * TAIL_S):].astype(np.float64)
    if ref <= 0 or not len(tail):
        return 0.0
    return float(np.sqrt((tail ** 2).mean()) / ref)


def trailing_pad_ms(x: np.ndarray, sr: int) -> float:
    """Milliseconds of sub-PAD_FLOOR audio after the last loud sample.

    trim() leaves ~30ms here for any take that ended on its own. ~0 means the
    file's last sample IS its last loud sample -- there was nothing to pad with,
    because the generation stopped there.
    """
    if x.ndim > 1:
        x = x.mean(axis=1)
    idx = np.flatnonzero(np.abs(x) > PAD_FLOOR)
    if not len(idx):
        return float("inf")
    return (len(x) - 1 - idx[-1]) / sr * 1000.0


def find_truncated(base: str, doc: dict) -> list:
    """Segment indices whose take ends mid-word. Skips deliberate interruptions.

    Both conditions must hold -- see the module docstring for why either alone
    is useless: still at full voice AND with no pad trim could leave.
    """
    out = []
    for s in doc["segments"]:
        # cutoff segments are SUPPOSED to stop mid-word: tts-generate synthesizes
        # the fuller sentence and slices it, so their ending is a designed cut.
        if s.get("cutoff"):
            continue
        p = f"{base}/audio/segments/{s['i']:04d}.wav"
        if not os.path.exists(p):
            continue
        x, sr = sf.read(p, dtype="float32")
        if tail_ratio(x, sr) > THRESHOLD and trailing_pad_ms(x, sr) < MIN_PAD_MS:
            out.append(s["i"])
    return out


def reroll(base: str, doc: dict, indices: list) -> None:
    """Bump each segment's pinned seed and delete its take so it re-renders.

    The seed bump is what makes this work: seeds are pinned for reproducibility,
    so deleting the WAV alone would regenerate the byte-identical bad take.
    """
    segs = {s["i"]: s for s in doc["segments"]}
    for i in indices:
        segs[i]["seed"] = int(segs[i].get("seed", i * 7919 + 13)) + RESEED
        p = f"{base}/audio/segments/{i:04d}.wav"
        if os.path.exists(p):
            os.remove(p)


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


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else. This step reads no show-config KEY of its own --
    # every threshold above is an engine setting -- but it still loads the config, so a wrong
    # --show-root fails here by naming showrunner.json instead of failing three lines later.
    root = os.path.abspath(sc.show_root(sys.argv))
    sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("truncation-qc: episode id missing (usage: truncation-qc.py <episode> [--show-root <path>])")
    base = f"Production/{ep}"
    doc = json.load(open(f"{base}/tts-script.json"))
    if doc.get("engine", "kokoro") != "qwen3":
        print("TRUNCATION_QC_SKIP (kokoro engine is deterministic)")
        return

    for rnd in range(1, PASSES + 1):
        bad = find_truncated(base, doc)
        print(f"round {rnd}: {len(bad)} segment(s) ending hot (>{THRESHOLD:.2f} of speech level) with no trim pad")
        sc.progress(rnd, PASSES, "rounds")
        if not bad:
            # The rounds are over, however few it took: report the bar full before the result line
            # so a console never shows this step finishing at 1 of 2.
            sc.progress(PASSES, PASSES, "rounds")
            print(f"TRUNCATION_QC_OK ({len(doc['segments'])} segments end in their own release)")
            return
        texts = {s["i"]: s for s in doc["segments"]}
        for i in bad:
            print(f"  seg {i:4d}: cut off -- ...{texts[i]['text'][-48:]!r}")
        reroll(base, doc, bad)
        json.dump(doc, open(f"{base}/tts-script.json", "w"), indent=1)
        resynth(ep)

    # Survivors are not a sampling fluke -- fail loudly rather than ship a
    # chopped word, and name the segments so a human can look at them.
    still = find_truncated(base, doc)
    if still:
        sys.exit(f"TRUNCATION_QC_FAIL: {len(still)} segment(s) still cut off after "
                 f"{PASSES} re-rolls: {still}. Listen to these and either reword the "
                 f"line or set an explicit seed by hand.")
    print(f"TRUNCATION_QC_OK (cleared after {PASSES} re-roll rounds)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"truncation-qc: {err}")
