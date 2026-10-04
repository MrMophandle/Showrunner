# /// script
# dependencies = []
# ///
"""build-timeline: audio manifest + shot list + script scene boundaries -> video timeline.
Also stages assets into the render project's public/<ep>/ (Remotion serves only from public/).
Scene starts are found by matching each scene's opening words to a manifest segment;
shots within a scene are distributed evenly across the scene's time span.

The timeline is the ONE thing the renderer reads. Everything the show decides about how an
episode looks on screen travels in it: the frame rate (video.fps), the frame size
(visual.shotFrame), the crossfade (video.crossfadeSeconds), the tail the mix leaves at the end
(audio.tailOutSeconds), and the title card's own typography (video.titleCard -- its text, font,
colours and fade). The render project therefore carries no show literal of its own; it draws what
the timeline says.

Usage: build-timeline.py <episode> [--show-root <path>] [--render-root <path>]

--render-root names the render project's public/ directory. It defaults to the render project
beside this scripts directory, NOT to anything under the show root: the staging directory belongs
to the engine, and a relative path would otherwise resolve under the show after the chdir.
"""
import json, os, re, shutil, sys

from lib import showconfig as sc

RENDER_ROOT_FLAG = "--render-root"


def render_root(argv: list[str]) -> str:
    """Take --render-root out of argv and return its path; else the engine's own render/public.

    Both spellings are accepted, as for --show-root, and the flag (with its value, in the
    two-token form) is REMOVED in place so the caller's positional arguments keep their places.
    """
    for at, token in enumerate(argv):
        if token == RENDER_ROOT_FLAG:
            if at + 1 >= len(argv):
                raise sc.ShowConfigError(f"{RENDER_ROOT_FLAG} needs a path")
            value = argv[at + 1]
            del argv[at:at + 2]
            return value
        if token.startswith(RENDER_ROOT_FLAG + "="):
            value = token[len(RENDER_ROOT_FLAG) + 1:]
            if value == "":
                raise sc.ShowConfigError(f"{RENDER_ROOT_FLAG} needs a path")
            del argv[at]
            return value
    # The render project sits beside this scripts directory in the engine repository.
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "render", "public")


def mix_wav(cfg: dict, ep: str) -> str:
    """The mixed WAV's name, as audio-mix.py wrote it: air-named, or episode.wav when unmapped."""
    try:
        season, episode = sc.season_of(cfg, ep)
    except sc.UnmappedEpisodeId:
        # ONLY a well-formed production id the airMap does not place falls back, exactly as
        # audio-mix.py does; every other fault is a config fault and must reach the operator.
        return "episode.wav"
    return sc.format_filename(str(sc.value(cfg, "output", "mixFilename")),
                              slug=str(sc.value(cfg, "showSlug")),
                              season=season, episode=episode, episode_id=ep)


def title_card(cfg: dict, start_s: float, gap_s: float, fps: int) -> dict:
    """The title card as the renderer reads it: when it plays, and how it is set.

    Timing is the episode's (the manifest's title-card gap); typography is the show's
    (video.titleCard). Both travel in one object so the render project holds no show literal.
    """
    card = sc.value(cfg, "video", "titleCard")
    if not isinstance(card, dict):
        raise sc.ShowConfigError("showrunner.json: video.titleCard must be an object")
    return {
        "from": int(start_s * fps),
        "durationInFrames": int(gap_s * fps),
        "fadeFrames": int(float(sc.value(cfg, "video", "titleCard", "fadeSeconds")) * fps),
        "text": str(sc.value(cfg, "video", "titleCard", "text")),
        "fontFamily": str(sc.value(cfg, "video", "titleCard", "fontFamily")),
        "colors": sc.value(cfg, "video", "titleCard", "colors"),
    }


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else. Both roots are absolute BEFORE the chdir,
    # because the render root is an engine path and must not follow the show.
    pub_root = os.path.abspath(render_root(sys.argv))
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("build-timeline: episode id missing "
                 "(usage: build-timeline.py <episode> [--show-root <path>] [--render-root <path>])")

    # Everything the show decides about the picture and its clock.
    fps = int(sc.value(cfg, "video", "fps"))
    crossfade_s = float(sc.value(cfg, "video", "crossfadeSeconds"))
    tail_out_s = float(sc.value(cfg, "audio", "tailOutSeconds"))
    frame = list(sc.value(cfg, "visual", "shotFrame"))
    prod = sc.production_dir(cfg)

    base = f"{prod}/{ep}"
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
            title = title_card(cfg, t, m["gap_before"], fps)
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
    for pos, scene in enumerate(scene_indices):
        s0 = starts[pos] if pos < len(starts) else total_s * pos / len(scene_indices)
        s1 = starts[pos + 1] if pos + 1 < len(starts) else total_s
        group = by_scene[scene]
        span = max(1.0, s1 - s0)
        each = span / len(group)
        for j, shot in enumerate(group):
            frm = int((s0 + j * each) * fps)
            dur = int(each * fps) + int(crossfade_s * fps)  # overlap for crossfade
            shots_out.append({"src": f"{ep}/images/{shot['id']}.png", "from": frm, "durationInFrames": dur, "id": shot["id"]})
    # last shot holds to the end
    shots_out[-1]["durationInFrames"] = int(total_s * fps) - shots_out[-1]["from"]

    timeline = {
        "fps": fps, "width": int(frame[0]), "height": int(frame[1]),
        "audio": f"{ep}/audio.wav",
        # The video runs past the last syllable by exactly the tail audio-mix.py appended
        # (audio.tailOutSeconds), so the rendered duration and the mixed WAV end together.
        "durationInFrames": int(total_s * fps) + int(tail_out_s * fps),
        "crossfadeFrames": int(crossfade_s * fps),
        "shots": shots_out,
    }
    if title:
        timeline["title"] = title
        print(f"title card at frame {title['from']} for {title['durationInFrames']} frames "
              f"({title['text']!r})")
    os.makedirs(f"{base}/video", exist_ok=True)
    json.dump(timeline, open(f"{base}/video/timeline.json", "w"), indent=1)

    # stage assets into the render project's public/<ep>/
    pub = os.path.join(pub_root, ep)
    os.makedirs(os.path.join(pub, "images"), exist_ok=True)
    shutil.copyfile(f"{base}/audio/{mix_wav(cfg, ep)}", os.path.join(pub, "audio.wav"))
    shots = prompts["shots"]
    for pos, shot in enumerate(shots, 1):
        # The only part of this script with real wall-clock: hundreds of megabytes of stills.
        sc.progress(pos, len(shots), "shots")
        shutil.copyfile(f"{base}/images/{shot['id']}.png",
                        os.path.join(pub, "images", f"{shot['id']}.png"))
    shutil.copyfile(f"{base}/video/timeline.json", os.path.join(pub, "timeline.json"))
    print(f"TIMELINE_OK {len(shots_out)} shots over {total_s/60:.1f}m "
          f"({timeline['durationInFrames']} frames) -> {pub}/")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"build-timeline: {err}")
