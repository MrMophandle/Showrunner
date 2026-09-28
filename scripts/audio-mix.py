# /// script
# dependencies = ["soundfile", "numpy"]
# ///
"""audio-mix: trimmed segments + manifest gaps -> single loudness-normalized episode WAV.
Registry mixing conventions #2 (designed gaps come from the manifest) and #3 (-14 LUFS)."""
import json, os, re, subprocess, sys, tempfile
import numpy as np
import soundfile as sf

from lib import showconfig as sc

UNMAPPED_MIX = "episode.wav"

def mix_wav(cfg: dict, ep: str) -> str:
    """The mixed WAV's name, from the show's output.mixFilename pattern.

    Named by AIR slot (not production id) so a pile of proofs sent to a second listener is
    distinguishable and matches the final video names. An id the show's airMap does not place --
    a non-canon test bed, an episode written before its slot was settled -- is named episode.wav.
    """
    try:
        season, episode = sc.season_of(cfg, ep)
    except sc.UnmappedEpisodeId:
        # ONLY an id the airMap does not place falls back. A malformed airMap entry, a missing
        # pattern or a bad id is a config fault and must reach the operator, not be named over.
        return UNMAPPED_MIX
    return sc.format_filename(str(sc.value(cfg, "output", "mixFilename")),
                              slug=str(sc.value(cfg, "showSlug")),
                              season=season, episode=episode, episode_id=ep)

def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("audio-mix: episode id missing (usage: audio-mix.py <episode> [--show-root <path>])")
    # Everything the show decides: how its room tone sounds, how long the tail runs, what it is
    # mastered to, and at what rate it is written.
    out_sr = str(int(sc.value(cfg, "audio", "sampleRate")))
    tail_out_s = float(sc.value(cfg, "audio", "tailOutSeconds"))
    room_tone_db = sc.value(cfg, "audio", "roomToneDb", default=None)
    # A show that asks for a room-tone bed must say what it is pitched at: no silent default.
    room_tone_hz = (float(sc.value(cfg, "audio", "roomToneFundamentalHz"))
                    if room_tone_db is not None else 0.0)
    narrator = str(sc.value(cfg, "audio", "narratorSpeakerKey"))
    TARGET = dict(I=str(sc.value(cfg, "audio", "loudness", "i")),
                  TP=str(sc.value(cfg, "audio", "loudness", "tp")),
                  LRA=str(sc.value(cfg, "audio", "loudness", "lra")))
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
    # Voices are matched to the show's narration level (audio.narratorSpeakerKey); an episode
    # without that speaker is matched to its own median instead.
    target = rms.get(narrator) or float(np.median(list(rms.values())))
    gain = {spk: min(2.0, max(0.5, target / r)) for spk, r in rms.items()}
    for spk, g in sorted(gain.items()):
        print(f"  gain {spk}: {g:.2f}x")
    # Bed envelope: 1.0 everywhere except a title-card gap, where the hum
    # holds alone (~45% of the gap), fades out over 2s, then true silence
    # until speech resumes (bed ramps back over 1s). Registry convention:
    # "title_card_before": true on the first segment AFTER the card.
    pieces = []
    env_pieces = []
    for pos, seg in enumerate(man["segments"], 1):
        sc.progress(pos, len(man["segments"]), "segments")
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
    # The show sets the length (audio.tailOutSeconds); build-timeline.py pads the video to match.
    pieces.append(np.zeros(int(sr * tail_out_s), dtype=np.float64))
    env_pieces.append(np.ones(int(sr * tail_out_s)))
    print(f"  tail-out: {tail_out_s:.1f}s of room tone after the last segment")

    mix = np.concatenate(pieces)
    bed_env = np.concatenate(env_pieces)
    # Optional room-tone bed: the show's audio.roomToneDb (e.g. -42) enables a constant low
    # hum that glues voice cuts into one acoustic space, pitched at its own
    # audio.roomToneFundamentalHz. A show without the key mixes dry.
    if room_tone_db is not None:
        amp = 10 ** (float(room_tone_db) / 20)
        t = np.arange(len(mix)) / sr
        rng = np.random.default_rng(42)
        noise = rng.standard_normal(len(mix))
        # brown-ish noise + the show's faint engine fundamental
        noise = np.cumsum(noise); noise /= (np.abs(noise).max() + 1e-9)
        hum = amp * (0.7 * noise + 0.3 * np.sin(2 * np.pi * room_tone_hz * t))
        mix = mix + hum * bed_env
        print(f"  room tone: {room_tone_db} dB bed at {room_tone_hz:.0f} Hz")
    with tempfile.TemporaryDirectory() as td:
        raw = f"{td}/raw.wav"
        sf.write(raw, mix, sr)
        # TWO-PASS loudnorm. Single-pass is a streaming approximation and undershot the
        # target by 1.8 dB on ep01 (-15.8 measured against I=-14), which matters because
        # YouTube normalises loud uploads DOWN but never quiet ones UP -- an undershoot
        # ships quiet next to everything around it. Pass 1 measures, pass 2 applies.
        # Peak-tame FIRST. The mix has a ~14 dB crest factor (a few loud transients --
        # notably the rigger, boosted 2x -- against quiet narration), so the peaks hit the
        # true-peak ceiling and loudnorm cannot raise the average: it stalled at -15.6.
        # A gentle limiter catches only those transients, freeing headroom so the average
        # reaches target. LRA here is ~3 LU, so this costs no meaningful dynamics.
        limited = f"{td}/limited.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
             "-af", "alimiter=limit=0.5:attack=5:release=60:level=disabled",
             "-ar", out_sr, limited],
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
        out_path = f"{base}/{mix_wav(cfg, ep)}"
        # `print_format=summary` on the apply pass makes ffmpeg report what it ACHIEVED, at info
        # level on stderr -- which is the number the result line must carry. Measuring the input
        # again (pass 1) would only repeat what the file was before this pass corrected it.
        applied = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "info", "-nostdin", "-i", raw,
             "-af", af, "-ar", out_sr, out_path],
            capture_output=True, text=True, check=True,
        )
        achieved = re.search(r"Output Integrated:\s*(-?[\d.]+)\s*LUFS", applied.stderr)
        print(f"  loudness: measured {float(m['input_i']):.1f} LUFS -> normalised to {TARGET['I']} (two-pass)")
    # The last line is this step's RESULT: the gate message after it reads it verbatim, so it is
    # one line, and it carries the three facts a listener is about to check. The LUFS figure is
    # what the mix MEASURED after normalisation; when ffmpeg's summary cannot be parsed the line
    # says so with a (target) marker rather than passing the target off as a measurement.
    lufs = float(achieved.group(1)) if achieved else float(TARGET["I"])
    marker = "" if achieved else " (target)"
    print(f"MIX_OK {len(mix)/sr:.1f}s {lufs:.1f} LUFS {out_path}{marker}")

if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"audio-mix: {err}")
