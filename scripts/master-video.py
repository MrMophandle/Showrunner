# /// script
# dependencies = []
# ///
"""master-video: normalise the RENDERED MP4's audio to broadcast target.

Why this exists (learned on ep01, 2026-07-18):
The mix WAV was correctly mastered to -14.5 LUFS / -1.4 dBTP, and the rendered MP4
still came out at -15.8 LUFS / -4.4 dBTP. Remotion's audio encode attenuates. The
tell: two renders from sources 1.3 dB apart both landed at exactly -4.4 dBFS peak,
so the output level is being set downstream of our mix regardless of what we feed it.

Conclusion: normalise the FINAL ARTIFACT, not an intermediate. This runs after
`remotion render` and is the last step before upload.

Video is stream-copied (no re-encode, no quality loss, fast); only audio is touched.
Two-pass loudnorm, to the show's own target (audio.loudness, the same one audio-mix.py
mixes to) -- YouTube normalises loud uploads DOWN but never quiet ones UP, so
undershooting ships quiet.

Writes episode-mastered.mp4 BESIDE its input and never over it, so a re-run measures the
rendered file rather than an already-normalised one, and a hand-check can compare the two.
finalize-video.py prefers the mastered file when it is there.

Usage: master-video.py <episode> [--show-root <path>]
"""
import json, os, shutil, subprocess, sys, tempfile

from lib import showconfig as sc

MASTERED_FILENAME = "episode-mastered.mp4"

def loudnorm_filter(target, measured=None):
    """The loudnorm filter string: the show's target alone, or the two-pass applied form."""
    af = f"loudnorm=I={target['I']}:TP={target['TP']}:LRA={target['LRA']}"
    if measured is None:
        return af + ":print_format=json"
    return (af + f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}:linear=true")

def measure(path, target):
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", path, "-af",
         loudnorm_filter(target),
         "-f", "null", "-"], capture_output=True, text=True, check=True)
    blob = p.stderr[p.stderr.rfind("{"): p.stderr.rfind("}") + 1]
    return json.loads(blob)

def integrated(path):
    p = subprocess.run(["ffmpeg", "-nostdin", "-i", path, "-af", "ebur128=peak=true",
                        "-f", "null", "-"], capture_output=True, text=True)
    i = tp = None
    for line in p.stderr.splitlines():
        s = line.strip()
        if s.startswith("I:"):    i = s.split()[1]
        if s.startswith("Peak:"): tp = s.split()[1]
    return i, tp

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("master-video: episode id missing "
                 "(usage: master-video.py <episode> [--show-root <path>])")
    # The show sets the broadcast target and names the file its renderer writes.
    target = dict(I=str(sc.value(cfg, "audio", "loudness", "i")),
                  TP=str(sc.value(cfg, "audio", "loudness", "tp")),
                  LRA=str(sc.value(cfg, "audio", "loudness", "lra")))
    prod = sc.production_dir(cfg)
    video_dir = f"{prod}/{ep}/video"
    src = f"{video_dir}/{sc.value(cfg, 'output', 'videoFilename')}"
    if not os.path.exists(src): sys.exit(f"master-video: {src} not found")
    dst = f"{video_dir}/{MASTERED_FILENAME}"

    before = integrated(src)
    print(f"rendered MP4: {before[0]} LUFS, true peak {before[1]} dBFS")

    sc.progress(1, 3, "passes")
    m = measure(src, target)
    sc.progress(2, 3, "passes")
    af = loudnorm_filter(target, m)
    with tempfile.TemporaryDirectory() as td:
        out = f"{td}/mastered.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-c:v", "copy",                       # video untouched
             "-af", af, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-movflags", "+faststart",            # web playback starts immediately
             out], check=True)
        # Beside the input, NEVER over it (F-09). Moving the mastered file onto its own source
        # made a re-run normalise an already-normalised MP4 a second time, which the engine's
        # restart design (every step idempotent) cannot tolerate.
        shutil.move(out, dst)
    sc.progress(3, 3, "passes")

    after = integrated(dst)
    print(f"mastered MP4: {after[0]} LUFS, true peak {after[1]} dBFS")
    # The last line is this step's RESULT: the gate message after it reads it verbatim.
    print(f"MASTER_OK {dst}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"master-video: {err}")
