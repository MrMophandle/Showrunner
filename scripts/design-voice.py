# /// script
# dependencies = ["mlx-audio", "soundfile", "numpy"]
# ///
"""design-voice: invent candidate voices from a prose description (Qwen3 VoiceDesign).
Voice design is NON-deterministic — each candidate is a fresh roll; the WAV you keep
IS the voice (lock it as a reference and clone from it thereafter).

Usage:
  uv run .archon/scripts/design-voice.py --instruct "A warm gruff older male voice..." \
      --text "The line this voice will speak" --out Production/ep01/guest-refs/rourke \
      [--candidates 2]
Writes <out>-1.wav, <out>-2.wav, ... (loudness-normalized) and prints the paths."""
import argparse, os, subprocess
import numpy as np
import soundfile as sf

SR = 24000
MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instruct", required=True)
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True, help="output path prefix (no extension)")
    ap.add_argument("--candidates", type=int, default=2)
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    from mlx_audio.tts.utils import load_model
    model = load_model(MODEL)
    for n in range(1, a.candidates + 1):
        res = list(model.generate_voice_design(text=a.text, instruct=a.instruct, language="english"))
        audio = np.concatenate([np.asarray(r.audio, dtype=np.float32) for r in res])
        path = f"{a.out}-{n}.wav"
        sf.write(path, audio, SR)
        tmp = path[:-4] + ".n.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path,
                        "-af", "loudnorm=I=-16:TP=-1.5", "-ar", str(SR), tmp], check=True)
        os.replace(tmp, path)
        print(f"DESIGNED {path}")

main()
