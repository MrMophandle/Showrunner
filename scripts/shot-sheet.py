# /// script
# dependencies = []
# ///
"""shot-sheet: a showrunner's reading of the episode's imagery — WHEN each still
appears, WHAT is being said over it, and the exact description it was made from.

The gate's IMAGE-SHEET.md answers "which shots exist". This answers the question
that actually comes up while reviewing them: *where does this land in the
episode?* Timings are not estimates — this replicates build-timeline.py's own
placement maths (scene boundaries matched from the script, shots distributed
evenly across their scene's span), so the times printed here are the times the
render will use.

Writes Production/<ep>/images/SHOT-SHEET.md

Usage:  shot-sheet.py <episode> [--show-root <path>]
"""
import json, os, re, sys

from lib import showconfig as sc


def norm(x: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", x.lower())


def ts(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("shot-sheet: episode id missing "
                 "(usage: shot-sheet.py <episode> [--show-root <path>])")
    # Read for the same reason build-timeline.py reads them: this sheet replicates that script's
    # placement maths, and the two must agree on the show's clock or the times printed here are
    # not the times the render will use.
    fps = int(sc.value(cfg, "video", "fps"))
    crossfade_s = float(sc.value(cfg, "video", "crossfadeSeconds"))
    base = f"Production/{ep}"
    for need in (f"{base}/audio/manifest.json", f"{base}/tts-script.json",
                 f"{base}/images/prompts.json", f"Episodes/{ep}/script.md"):
        if not os.path.exists(need):
            sys.exit(f"shot-sheet: missing {need}")

    man = json.load(open(f"{base}/audio/manifest.json"))
    tts = json.load(open(f"{base}/tts-script.json"))
    prompts = json.load(open(f"{base}/images/prompts.json"))
    script = open(f"Episodes/{ep}/script.md").read()

    # --- segment clock (identical to build-timeline.py) ---------------------
    seg_start, t = {}, 0.0
    for m in man["segments"]:
        t += m.get("gap_before", 0) or 0
        seg_start[m["i"]] = t
        t += m["duration_s"]
    total_s = t
    texts = {s["i"]: s["text"] for s in tts["segments"]}
    speakers = {s["i"]: s.get("speaker", "") for s in tts["segments"]}

    # --- scene boundaries (identical to build-timeline.py) ------------------
    scene_starts = []
    headers = list(re.finditer(r"^## +(.+)$", script, re.M))
    titles = [h.group(1).strip() for h in headers]
    for idx, h in enumerate(headers):
        body = script[h.end():headers[idx + 1].start() if idx + 1 < len(headers) else len(script)]
        words = norm(" ".join(body.split()[:8]))
        found = None
        if words:
            for i in sorted(texts):
                if norm(texts[i]).startswith(words[:40]) or words[:40] in norm(texts[i]):
                    found = seg_start.get(i)
                    break
        scene_starts.append((idx, found))
    known = [(i, s) for i, s in scene_starts if s is not None]
    if not known:
        sys.exit("shot-sheet: no scene boundaries matched")
    starts = []
    for idx, s in scene_starts:
        if s is None:
            prev = max((k for k in known if k[0] < idx), key=lambda k: k[0], default=(0, 0.0))
            nxt = min((k for k in known if k[0] > idx), key=lambda k: k[0], default=(len(scene_starts), total_s))
            frac = (idx - prev[0]) / max(1, nxt[0] - prev[0])
            s = prev[1] + frac * (nxt[1] - prev[1])
        starts.append(s)
    starts[0] = 0.0

    # --- place every shot (identical to build-timeline.py) ------------------
    by_scene = {}
    for shot in prompts["shots"]:
        m = re.match(r"s(\d+)", shot["id"])
        by_scene.setdefault(int(m.group(1)) if m else 0, []).append(shot)

    placed = []
    scene_indices = sorted(by_scene)
    # `scene`, not `sc`: `sc` is the show-config module every script imports, and shadowing it
    # here made main() raise UnboundLocalError before it read a single argument.
    for pos, scene in enumerate(scene_indices):
        s0 = starts[pos] if pos < len(starts) else total_s * pos / len(scene_indices)
        s1 = starts[pos + 1] if pos + 1 < len(starts) else total_s
        group = by_scene[scene]
        span = max(1.0, s1 - s0)
        each = span / len(group)
        scene_title = titles[pos] if pos < len(titles) else f"scene {scene}"
        for j, shot in enumerate(group):
            a = s0 + j * each
            b = a + each
            placed.append({"shot": shot, "start": a, "end": b, "scene": scene_title})
    if placed:
        placed[-1]["end"] = total_s

    # --- what is being said while each shot is up --------------------------
    def spoken_during(a: float, b: float, limit: int = 2):
        out = []
        for i in sorted(texts):
            st = seg_start.get(i)
            if st is None or st < a or st >= b:
                continue
            txt = " ".join(texts[i].split())
            if len(txt) > 170:
                txt = txt[:167].rstrip() + "…"
            out.append((speakers.get(i, "?"), txt))
            if len(out) >= limit:
                break
        return out

    # --- write ------------------------------------------------------------
    L = []
    A = L.append
    n_ch = sum(1 for p in placed if p["shot"].get("type") == "character")
    A(f"# {ep} — shot sheet (placement + descriptions)")
    A("")
    A(f"**{len(placed)} stills** across {len(scene_indices)} scenes · runtime {ts(total_s)} · "
      f"{n_ch} character shots (Nano Banana) · {len(placed) - n_ch} ambient (local engine)")
    A("")
    A("Times are computed the same way the renderer computes them: scene starts are matched")
    A("from the script's own opening words, then a scene's stills are spread evenly across it.")
    A("A shot on screen for a long stretch is a scene with few stills, not a deliberate hold.")
    A("")
    A("**To replace an image by hand:** save your file at the path shown under each shot.")
    A("An existing file is never overwritten or re-audited — a hand-made shot always wins.")
    A("")
    A("---")
    A("")

    last_scene = None
    for p in placed:
        s = p["shot"]
        if p["scene"] != last_scene:
            A(f"## {p['scene']}")
            A("")
            last_scene = p["scene"]
        png = f"Production/{ep}/images/{s['id']}.png"
        have = "on disk" if os.path.exists(png) else "**MISSING**"
        kind = "character (Nano Banana)" if s.get("type") == "character" else "ambient (local engine)"
        A(f"### `{s['id']}`")
        A("")
        A(f"**On screen {ts(p['start'])} – {ts(p['end'])}**  ({p['end'] - p['start']:.0f}s) · {kind} · {have}  ")
        if s.get("refs"):
            A(f"**Characters/refs:** {', '.join(s['refs'])}  ")
        A(f"**File:** `{png}`")
        A("")
        heard = spoken_during(p["start"], p["end"])
        if heard:
            A("**What plays over it:**")
            A("")
            for spk, txt in heard:
                A(f"> **{spk}:** {txt}")
                A("")
        A("**Description it was made from:**")
        A("")
        A("```text")
        A(" ".join((s.get("brief") or s.get("prompt") or "(none)").split()))
        A("```")
        A("")

    out = f"{base}/images/SHOT-SHEET.md"
    open(out, "w").write("\n".join(L))
    print(f"SHOT_SHEET {ep}: {out}  ({len(placed)} stills, runtime {ts(total_s)}, "
          f"{fps} fps, {crossfade_s:.1f}s crossfade)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"shot-sheet: {err}")
