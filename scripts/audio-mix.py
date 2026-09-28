# /// script
# dependencies = ["soundfile", "numpy"]
# ///
"""audio-mix: trimmed segments + manifest gaps -> single loudness-normalized episode WAV.
Registry mixing conventions #2 (designed gaps come from the manifest) and #3 (-14 LUFS)."""
import json, os, subprocess, sys, tempfile
import numpy as np
import soundfile as sf

# The mixed WAV is named by AIR order (not production id) so a pile of proofs sent
# to a second listener is distinguishable and matches the final video names. Kept
# in sync with build-timeline.py and finalize-video.py. Unmapped -> episode.wav.
AIR = {"ep01": (1, 1), "ep02": (1, 2), "ep03": (1, 3), "ep04": (1, 4), "ep05": (1, 5), "ep06": (1, 6), "ep07": (1, 7), "ep08": (1, 8), "ep09": (1, 9), "ep10": (1, 10)}  # ep98 (the dead non-canon test-bed) deliberately UNMAPPED — it held slot 9
#   until ep09 "The Wick" was written fresh; finalize-video.py has always had this right.
def mix_wav(ep: str) -> str:
    s, e = AIR.get(ep, (0, 0))
    return f"DeadLight S{s:02d}E{e:02d}.wav" if (s, e) != (0, 0) else "episode.wav"

def main() -> None:
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("audio-mix: episode id missing (first token of ARGUMENTS)")
    base = f"Production/{ep}/audio"
    with open(f"{base}/manifest.json") as f:
        man = json.load(f)
    sr = man["sr"]
    # Pass 1: per-speaker RMS, to gain-match voices to the narrator
    # (loudness jumps at speaker cuts hurt more than timbre jumps).
    import collections
    energy = collections.defaultdict(list)
    audio = {}
    for seg in man["segments"]:
        arr, file_sr = sf.read(f"{base}/segments/{seg['i']:04d}.wav")
        if file_sr != sr:
            sys.exit(f"audio-mix: segment {seg['i']} sample rate {file_sr} != {sr}")
        arr = np.asarray(arr, dtype=np.float64)
        audio[seg["i"]] = arr
        loud = arr[np.abs(arr) > 0.005]
        if len(loud):
            energy[seg["speaker"]].append(float(np.sqrt((loud ** 2).mean())))
    rms = {spk: float(np.mean(v)) for spk, v in energy.items() if v}
    target = rms.get("narrator") or float(np.median(list(rms.values())))
    gain = {spk: min(2.0, max(0.5, target / r)) for spk, r in rms.items()}
    for spk, g in sorted(gain.items()):
        print(f"  gain {spk}: {g:.2f}x")
    # Bed envelope: 1.0 everywhere except a title-card gap, where the hum
    # holds alone (~45% of the gap), fades out over 2s, then true silence
    # until speech resumes (bed ramps back over 1s). Registry convention:
    # "title_card_before": true on the first segment AFTER the card.
    pieces = []
    env_pieces = []
    for seg in man["segments"]:
        gap = float(seg.get("gap_before", 0.3))
        if gap > 0:
            z = np.zeros(int(sr * gap), dtype=np.float64)
            pieces.append(z)
            if seg.get("title_card_before"):
                env = np.zeros(len(z))
                hold = int(len(z) * 0.45)
                fade = min(int(sr * 2.0), max(1, len(z) - hold))
                env[:hold] = 1.0
                env[hold:hold + fade] = np.linspace(1.0, 0.0, fade)
                env_pieces.append(env)
                print(f"  title card: {gap:.1f}s hum-hold/fade gap before segment {seg['i']}")
            else:
                env_pieces.append(np.ones(len(z)))
        arr = audio[seg["i"]] * gain.get(seg["speaker"], 1.0)
        pieces.append(arr)
        env = np.ones(len(arr))
        if seg.get("title_card_before"):
            ramp = min(int(sr * 1.0), len(arr))
            env[:ramp] = np.linspace(0.0, 1.0, ramp)
        env_pieces.append(env)
    # Tail-out. The mix used to end on the last syllable, with no room to land.
    # The lead-IN is not here: it comes from segment 1's gap_before in the
    # tts-script, because build-timeline.py already accounts for gap_before and
    # so the video stays in sync for free. Nothing carries a tail, hence this.
    # 1.0s is not arbitrary -- build-timeline.py pads the video by exactly +FPS
    # ("+1s tail"), so a 1.0s tail-out matches the rendered duration exactly.
    # The bed envelope is 1.0 through it, so the room tone holds and fades with
    # the file instead of snapping off behind the last word.
    TAIL_OUT_S = 1.0
    pieces.append(np.zeros(int(sr * TAIL_OUT_S), dtype=np.float64))
    env_pieces.append(np.ones(int(sr * TAIL_OUT_S)))
    print(f"  tail-out: {TAIL_OUT_S:.1f}s of room tone after the last segment")

    mix = np.concatenate(pieces)
    bed_env = np.concatenate(env_pieces)
    # Optional room-tone bed: HUM_DB env (e.g. -42) enables a constant low
    # ship-hum that glues voice cuts into one acoustic space.
    hum_db = os.environ.get("HUM_DB")
    if hum_db:
        amp = 10 ** (float(hum_db) / 20)
        t = np.arange(len(mix)) / sr
        rng = np.random.default_rng(42)
        noise = rng.standard_normal(len(mix))
        # brown-ish noise + faint 55Hz engine fundamental
        noise = np.cumsum(noise); noise /= (np.abs(noise).max() + 1e-9)
        hum = amp * (0.7 * noise + 0.3 * np.sin(2 * np.pi * 55 * t))
        mix = mix + hum * bed_env
        print(f"  room tone: {hum_db} dB bed")
    with tempfile.TemporaryDirectory() as td:
        raw = f"{td}/raw.wav"
        sf.write(raw, mix, sr)
        # TWO-PASS loudnorm. Single-pass is a streaming approximation and undershot the
        # target by 1.8 dB on ep01 (-15.8 measured against I=-14), which matters because
        # YouTube normalises loud uploads DOWN but never quiet ones UP -- an undershoot
        # ships quiet next to everything around it. Pass 1 measures, pass 2 applies.
        TARGET = dict(I="-14", TP="-1.5", LRA="11")
        # Peak-tame FIRST. The mix has a ~14 dB crest factor (a few loud transients --
        # notably the rigger, boosted 2x -- against quiet narration), so the peaks hit the
        # true-peak ceiling and loudnorm cannot raise the average: it stalled at -15.6.
        # A gentle limiter catches only those transients, freeing headroom so the average
        # reaches target. LRA here is ~3 LU, so this costs no meaningful dynamics.
        limited = f"{td}/limited.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
             "-af", "alimiter=limit=0.5:attack=5:release=60:level=disabled",
             "-ar", "24000", limited],
            check=True,
        )
        raw = limited
        probe = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostdin", "-i", raw, "-af",
             f"loudnorm=I={TARGET['I']}:TP={TARGET['TP']}:LRA={TARGET['LRA']}:print_format=json",
             "-f", "null", "-"],
            capture_output=True, text=True, check=True,
        )
        blob = probe.stderr[probe.stderr.rfind("{"): probe.stderr.rfind("}") + 1]
        m = json.loads(blob)
        af = (f"loudnorm=I={TARGET['I']}:TP={TARGET['TP']}:LRA={TARGET['LRA']}"
              f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
              f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
              f":offset={m['target_offset']}:linear=true:print_format=summary")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
             "-af", af, "-ar", "24000", f"{base}/{mix_wav(ep)}"],
            check=True,
        )
        print(f"  loudness: measured {float(m['input_i']):.1f} LUFS -> normalised to {TARGET['I']} (two-pass)")
    print(f"MIX_OK {len(mix)/sr/60:.1f}m {len(man['segments'])} segments -> {base}/{mix_wav(ep)}")

main()
