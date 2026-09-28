# /// script
# dependencies = ["soundfile"]
# ///
"""pace-qc: enforce consistent narrator pacing on qwen3-rendered episodes.
Qwen3 samples prosody per segment; even at low temperature an occasional roll
lands far off-pace. This measures words-per-minute per narrator segment,
deletes takes outside ±BAND of the episode median, and re-runs tts-generate
(idempotent — only deleted WAVs re-render). Up to PASSES rounds; fails loudly
if outliers persist so a human looks at the stubborn segments.
Kokoro episodes: no-op (deterministic engine)."""
import json, os, statistics, subprocess, sys
from pathlib import Path

from lib import showconfig as sc

BAND = 0.15
PASSES = 3
MIN_WORDS = 15  # short lines read punchy by design; wpm is only meaningful on passages


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
    # an operator running it from somewhere else.
    root = sc.show_root(sys.argv)
    os.chdir(root)
    cfg = sc.load(root)
    # Which speaker key carries the narration, and at what rate the show's audio runs, are the
    # show's to say (audio.narratorSpeakerKey, audio.sampleRate).
    narrator = str(sc.value(cfg, "audio", "narratorSpeakerKey"))
    sr = int(sc.value(cfg, "audio", "sampleRate"))
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("pace-qc: episode id missing (usage: pace-qc.py <episode> [--show-root <path>])")
    base = f"Production/{ep}"
    doc = json.load(open(f"{base}/tts-script.json"))
    if doc.get("engine", "kokoro") != "qwen3":
        print("PACE_QC_SKIP (kokoro engine is deterministic)")
        return
    texts = {s["i"]: s for s in doc["segments"]}

    for rnd in range(1, PASSES + 1):
        man = json.load(open(f"{base}/audio/manifest.json"))
        rows = []
        for m in man["segments"]:
            s = texts[m["i"]]
            if s["speaker"] != narrator or s.get("cutoff") or s.get("delivery"):
                continue  # directed segments choose their pace deliberately
            w = len(s["text"].split())
            if w < MIN_WORDS or m["duration_s"] <= 1:
                continue
            rows.append((m["i"], w / m["duration_s"] * 60))
        med = statistics.median(r[1] for r in rows)
        outliers = [i for i, wpm in rows if abs(wpm - med) / med > BAND]
        print(f"round {rnd}: median {med:.0f} wpm, {len(outliers)} outliers beyond ±{int(BAND*100)}%")
        sc.progress(rnd, PASSES, "rounds")
        if not outliers:
            print(f"PACE_QC_OK ({len(rows)} {narrator} segments within band)")
            return
        for i in outliers:
            p = f"{base}/audio/segments/{i:04d}.wav"
            if os.path.exists(p):
                os.remove(p)
            # bump the pinned seed so the re-roll is a genuinely new take
            texts[i]["seed"] = int(texts[i].get("seed", i * 7919 + 13)) + 104729
        json.dump(doc, open(f"{base}/tts-script.json", "w"), indent=1)
        resynth(ep)
    # Survivors resist re-rolling (content-driven pace conviction) — clamp them
    # deterministically: gentle atempo toward the band edge (tempo only, pitch
    # untouched; ratios stay small). Proven on ep01 (2026-07-15).
    man = json.load(open(f"{base}/audio/manifest.json"))
    dur = {m["i"]: m["duration_s"] for m in man["segments"]}
    for i in outliers:
        w = len(texts[i]["text"].split())
        wpm = w / dur[i] * 60
        target = med * (0.88 if wpm < med else 1.10)
        ratio = max(0.75, min(1.3, target / wpm))
        p = f"{base}/audio/segments/{i:04d}.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", p,
                        "-af", f"atempo={ratio:.3f}", "-ar", str(sr), p + ".t.wav"], check=True)
        os.replace(p + ".t.wav", p)
        print(f"  clamped seg {i}: {wpm:.0f} wpm x{ratio:.2f}")
    # refresh manifest durations (tts-generate skips existing files but re-measures)
    resynth(ep)
    print(f"PACE_QC_OK ({len(outliers)} stubborn segments clamped)")

if __name__ == "__main__":
    try:
        main()
    except sc.ShowConfigError as err:
        sys.exit(f"pace-qc: {err}")
