# /// script
# dependencies = []
# ///
"""build-timeline: audio manifest + shot list + script scene boundaries -> video timeline.
Also stages assets into remotion/public/<ep>/ (Remotion serves only from public/).
Scene starts are found by matching each scene's opening words to a manifest segment;
shots within a scene are distributed evenly across the scene's time span."""
import json, os, re, shutil, sys

FPS = 30
CROSSFADE_S = 1.0

def main() -> None:
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("build-timeline: episode id missing (first token of ARGUMENTS)")
    base = f"Production/{ep}"
    man = json.load(open(f"{base}/audio/manifest.json"))
    tts = json.load(open(f"{base}/tts-script.json"))
    prompts = json.load(open(f"{base}/images/prompts.json"))
    script = open(f"Episodes/{ep}/script.md").read()

    # cumulative start time per segment i (+ title-card window if flagged)
    seg_start = {}
    title = None
    t = 0.0
    for m in man["segments"]:
        if m.get("title_card_before"):
            title = {"from": int(t * FPS), "durationInFrames": int(m["gap_before"] * FPS),
                     "fadeFrames": int(2.0 * FPS)}
        t += m["gap_before"]
        seg_start[m["i"]] = t
        t += m["duration_s"]
    total_s = t
    texts = {s["i"]: s["text"] for s in tts["segments"]}

    # scene boundaries: first ~8 words after each ## header, matched into segment texts
    def norm(x: str) -> str:
        return re.sub(r"[^a-z0-9 ]", "", x.lower())

    scene_starts = []  # (scene_index, start_s)
    headers = list(re.finditer(r"^## +(.+)$", script, re.M))
    for idx, h in enumerate(headers):
        body = script[h.end():headers[idx + 1].start() if idx + 1 < len(headers) else len(script)]
        words = norm(" ".join(body.split()[:8]))
        if not words:
            continue
        found = None
        for i in sorted(texts):
            if norm(texts[i]).startswith(words[:40]) or words[:40] in norm(texts[i]):
                found = seg_start.get(i)
                break
        scene_starts.append((idx, found))
    # fill unmatched scenes by proportional spacing between known neighbors
    known = [(i, s) for i, s in scene_starts if s is not None]
    if not known:
        sys.exit("build-timeline: no scene boundaries matched")
    starts = []
    for idx, s in scene_starts:
        if s is None:
            prev = max((k for k in known if k[0] < idx), key=lambda k: k[0], default=(0, 0.0))
            nxt = min((k for k in known if k[0] > idx), key=lambda k: k[0], default=(len(scene_starts), total_s))
            frac = (idx - prev[0]) / max(1, nxt[0] - prev[0])
            s = prev[1] + frac * (nxt[1] - prev[1])
        starts.append(s)
    starts[0] = 0.0  # first scene owns the opening

    # group shots by scene index parsed from id (sNN-...)
    by_scene = {}
    for shot in prompts["shots"]:
        m = re.match(r"s(\d+)", shot["id"])
        by_scene.setdefault(int(m.group(1)) if m else 0, []).append(shot)

    shots_out = []
    scene_indices = sorted(by_scene)
    for pos, sc in enumerate(scene_indices):
        s0 = starts[pos] if pos < len(starts) else total_s * pos / len(scene_indices)
        s1 = starts[pos + 1] if pos + 1 < len(starts) else total_s
        group = by_scene[sc]
        span = max(1.0, s1 - s0)
        each = span / len(group)
        for j, shot in enumerate(group):
            frm = int((s0 + j * each) * FPS)
            dur = int(each * FPS) + int(CROSSFADE_S * FPS)  # overlap for crossfade
            shots_out.append({"src": f"{ep}/images/{shot['id']}.png", "from": frm, "durationInFrames": dur, "id": shot["id"]})
    # last shot holds to the end
    shots_out[-1]["durationInFrames"] = int(total_s * FPS) - shots_out[-1]["from"]

    timeline = {
        "fps": FPS, "width": 1024, "height": 576,
        "audio": f"{ep}/audio.wav",
        "durationInFrames": int(total_s * FPS) + FPS,  # +1s tail
        "crossfadeFrames": int(CROSSFADE_S * FPS),
        "shots": shots_out,
    }
    if title:
        timeline["title"] = title
        print(f"title card at frame {title['from']} for {title['durationInFrames']} frames")
    os.makedirs(f"{base}/video", exist_ok=True)
    json.dump(timeline, open(f"{base}/video/timeline.json", "w"), indent=1)

    # stage assets into remotion/public/<ep>/
    pub = f"remotion/public/{ep}"
    os.makedirs(f"{pub}/images", exist_ok=True)
    # the mixed WAV is air-named by audio-mix.py (kept in sync here)
    _AIR = {"ep01": (1, 1), "ep02": (1, 2), "ep03": (1, 3), "ep04": (1, 4), "ep05": (1, 5), "ep06": (1, 6), "ep07": (1, 7), "ep08": (1, 8), "ep09": (1, 9), "ep10": (1, 10)}  # ep98 (the dead non-canon test-bed) deliberately UNMAPPED — it held slot 9
#   until ep09 "The Wick" was written fresh; finalize-video.py has always had this right.
    _s, _e = _AIR.get(ep, (0, 0))
    _mix = f"DeadLight S{_s:02d}E{_e:02d}.wav" if (_s, _e) != (0, 0) else "episode.wav"
    shutil.copyfile(f"{base}/audio/{_mix}", f"{pub}/audio.wav")
    for shot in prompts["shots"]:
        shutil.copyfile(f"{base}/images/{shot['id']}.png", f"{pub}/images/{shot['id']}.png")
    shutil.copyfile(f"{base}/video/timeline.json", f"{pub}/timeline.json")
    print(f"TIMELINE_OK {len(shots_out)} shots over {total_s/60:.1f}m ({timeline['durationInFrames']} frames) -> {pub}/")

main()
