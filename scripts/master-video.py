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
Two-pass loudnorm, same target as audio-mix.py: I=-14, TP=-1.5, LRA=11 -- YouTube
normalises loud uploads DOWN but never quiet ones UP, so undershooting ships quiet.
"""
import json, os, shutil, subprocess, sys, tempfile

TARGET = dict(I="-14", TP="-1.5", LRA="11")

def measure(path):
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", path, "-af",
         f"loudnorm=I={TARGET['I']}:TP={TARGET['TP']}:LRA={TARGET['LRA']}:print_format=json",
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
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep: sys.exit("master-video: episode id missing (first token of ARGUMENTS)")
    src = f"Production/{ep}/video/episode.mp4"
    if not os.path.exists(src): sys.exit(f"master-video: {src} not found")

    before = integrated(src)
    print(f"rendered MP4: {before[0]} LUFS, true peak {before[1]} dBFS")

    m = measure(src)
    af = (f"loudnorm=I={TARGET['I']}:TP={TARGET['TP']}:LRA={TARGET['LRA']}"
          f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
          f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
          f":offset={m['target_offset']}:linear=true")
    with tempfile.TemporaryDirectory() as td:
        out = f"{td}/mastered.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", src,
             "-c:v", "copy",                       # video untouched
             "-af", af, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-movflags", "+faststart",            # web playback starts immediately
             out], check=True)
        shutil.move(out, src)

    after = integrated(src)
    print(f"mastered MP4: {after[0]} LUFS, true peak {after[1]} dBFS")
    print(f"MASTER_OK {src}")

main()
