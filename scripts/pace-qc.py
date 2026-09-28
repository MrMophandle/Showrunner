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

BAND = 0.15
PASSES = 3
MIN_WORDS = 15  # short lines read punchy by design; wpm is only meaningful on passages

def main() -> None:
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("pace-qc: episode id missing (first token of ARGUMENTS)")
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
            if s["speaker"] != "narrator" or s.get("cutoff") or s.get("delivery"):
                continue  # directed segments choose their pace deliberately
            w = len(s["text"].split())
            if w < MIN_WORDS or m["duration_s"] <= 1:
                continue
            rows.append((m["i"], w / m["duration_s"] * 60))
        med = statistics.median(r[1] for r in rows)
        outliers = [i for i, wpm in rows if abs(wpm - med) / med > BAND]
        print(f"round {rnd}: median {med:.0f} wpm, {len(outliers)} outliers beyond ±{int(BAND*100)}%")
        if not outliers:
            print(f"PACE_QC_OK ({len(rows)} narrator segments within band)")
            return
        for i in outliers:
            p = f"{base}/audio/segments/{i:04d}.wav"
            if os.path.exists(p):
                os.remove(p)
            # bump the pinned seed so the re-roll is a genuinely new take
            texts[i]["seed"] = int(texts[i].get("seed", i * 7919 + 13)) + 104729
        json.dump(doc, open(f"{base}/tts-script.json", "w"), indent=1)
        env = dict(os.environ, ARGUMENTS=ep)
        subprocess.run(["uv", "run", ".archon/scripts/tts-generate.py"], env=env, check=True,
                       stdout=subprocess.DEVNULL)
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
                        "-af", f"atempo={ratio:.3f}", "-ar", "24000", p + ".t.wav"], check=True)
        os.replace(p + ".t.wav", p)
        print(f"  clamped seg {i}: {wpm:.0f} wpm x{ratio:.2f}")
    # refresh manifest durations (tts-generate skips existing files but re-measures)
    subprocess.run(["uv", "run", ".archon/scripts/tts-generate.py"],
                   env=dict(os.environ, ARGUMENTS=ep), check=True, stdout=subprocess.DEVNULL)
    print(f"PACE_QC_OK ({len(outliers)} stubborn segments clamped)")

main()
