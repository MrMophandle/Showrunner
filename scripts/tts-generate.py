# /// script
# dependencies = ["kokoro-onnx", "soundfile", "numpy", "mlx-audio"]
# ///
"""tts-generate: tts-script.json -> per-segment WAVs + manifest.
Two engines, selected by the manifest's top-level "engine" field:
  - "qwen3" (the show's engine, ruled 2026-07-15): every cast entry carries a
    locked reference WAV + its transcript ("ref", "ref_text") plus a per-character
    base acting direction ("direction"); segments may override with "delivery".
    Synthesis = in-context cloning from the reference + the direction instruct.
  - absent or "kokoro": legacy path (ep98/ep99 manifests), voice+speed presets.
Implements Canon/voice-registry.md mixing convention #1 (trim) at synth time.
Idempotent: skips segments whose output file already exists (delete to re-render)."""
import json, os, subprocess, sys, tempfile
import numpy as np
import soundfile as sf

SR = 24000
KOKORO_MODELS = os.path.expanduser("~/Models/kokoro")
QWEN3_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"

def trim(a: np.ndarray) -> np.ndarray:
    idx = np.where(np.abs(a) > 0.01)[0]  # ~-40 dBFS
    if not len(idx):
        return a
    pad = int(SR * 0.03)
    return a[max(0, idx[0] - pad):min(len(a), idx[-1] + pad)]

def make_synth(engine: str, cast: dict):
    """Returns synth(text, cast_entry, delivery) -> np.ndarray at SR."""
    if engine == "qwen3":
        from mlx_audio.tts.utils import load_model
        model = load_model(QWEN3_MODEL)
        # fail fast on missing references before burning any synth time
        for spk, c in cast.items():
            if not c.get("ref") or not c.get("ref_text"):
                sys.exit(f"tts-generate: qwen3 cast entry '{spk}' missing ref/ref_text")
            if not os.path.exists(c["ref"]):
                sys.exit(f"tts-generate: reference WAV not found: {c['ref']}")

        import mlx.core as mx

        def synth(text: str, c: dict, delivery: str | None, seed: int = 0) -> np.ndarray:
            instruct = delivery or c.get("direction")
            kwargs = {"speed": c["speed"]} if c.get("speed") else {}
            # per-character sampling temperature: low = consistent prosody/pace
            # (narration backbone), default 0.9 = expressive variance (dialogue)
            if c.get("temperature") is not None:
                kwargs["temperature"] = c["temperature"]
            # pinned per-segment seed = reproducible takes (same manifest ->
            # identical audio); pace-qc re-rolls by bumping the segment's seed,
            # mirroring the image pipeline's seed convention
            mx.random.seed(seed)
            res = list(model.generate(text=text, ref_audio=c["ref"], ref_text=c["ref_text"],
                                      instruct=instruct, lang_code="english", **kwargs))
            return np.concatenate([np.asarray(r.audio, dtype=np.float64) for r in res])
        return synth
    # legacy kokoro
    from kokoro_onnx import Kokoro
    kokoro = Kokoro(f"{KOKORO_MODELS}/kokoro-v1.0.onnx", f"{KOKORO_MODELS}/voices-v1.0.bin")

    def synth(text: str, c: dict, delivery: str | None, seed: int = 0) -> np.ndarray:
        samples, _ = kokoro.create(text, voice=c["voice"], speed=c["speed"], lang="en-us")
        return np.asarray(samples, dtype=np.float64)
    return synth

def main() -> None:
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("tts-generate: episode id missing (first token of ARGUMENTS)")
    base = f"Production/{ep}"
    with open(f"{base}/tts-script.json") as f:
        doc = json.load(f)
    cast, segs = doc["cast"], doc["segments"]
    engine = doc.get("engine", "kokoro")
    outdir = f"{base}/audio/segments"
    os.makedirs(outdir, exist_ok=True)

    synth = make_synth(engine, cast)
    print(f"engine: {engine}")
    manifest = []
    for seg in segs:
        i, spk = seg["i"], seg["speaker"]
        if spk not in cast:
            sys.exit(f"tts-generate: segment {i} speaker '{spk}' not in cast")
        c = cast[spk]
        out = f"{outdir}/{i:04d}.wav"
        if not os.path.exists(out):
            # Interruption support: for cutoff segments, synthesize the fuller
            # sentence (tts_text_full) so prosody stays mid-flight, then slice
            # the audio where the visible text ends. A dash-terminated text
            # rendered alone gets a false end-of-sentence cadence.
            synth_text = seg["text"]
            cutoff = bool(seg.get("cutoff")) and seg.get("tts_text_full")
            if cutoff:
                synth_text = seg["tts_text_full"]
            arr = synth(synth_text, c, seg.get("delivery"), seed=int(seg.get("seed", i * 7919 + 13)))
            if cutoff:
                visible = seg["text"].rstrip('—-–" ').strip()
                ratio = min(0.97, (len(visible) / max(1, len(synth_text))) * 1.05)
                n = max(int(SR * 0.2), int(len(arr) * ratio))
                arr = arr[:n]
                fade = min(int(SR * 0.02), len(arr))
                arr[-fade:] = arr[-fade:] * np.linspace(1.0, 0.0, fade)
            fx = seg.get("fx_override") or c.get("fx")
            if fx:
                with tempfile.TemporaryDirectory() as td:
                    sf.write(f"{td}/a.wav", arr, SR)
                    subprocess.run(
                        ["ffmpeg", "-y", "-loglevel", "error", "-i", f"{td}/a.wav", "-af", fx, f"{td}/b.wav"],
                        check=True,
                    )
                    arr, _ = sf.read(f"{td}/b.wav")
                    arr = np.asarray(arr, dtype=np.float64)
            arr = trim(arr)
            sf.write(out, arr, SR)
        dur = sf.info(out).duration
        manifest.append({"i": i, "speaker": spk, "duration_s": round(dur, 3),
                         "gap_before": seg.get("gap_before", 0.3),
                         **({"title_card_before": True} if seg.get("title_card_before") else {})})
        print(f"[{i}/{len(segs)}] {spk} {dur:.1f}s")

    with open(f"{base}/audio/manifest.json", "w") as f:
        json.dump({"episode": ep, "sr": SR, "segments": manifest}, f, indent=1)
    total = sum(m["duration_s"] + m["gap_before"] for m in manifest)
    print(f"DONE {len(manifest)} segments, ~{total/60:.1f} min of audio")

main()
