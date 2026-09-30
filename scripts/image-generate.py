# /// script
# dependencies = []
# ///
"""image-generate: prompts.json -> local stills.

TWO paths, chosen per shot (the tiered "hero routing" ruled 2026-07-19):
  * AMBIENT (default): Z-Image-Turbo, seeded, ~2.4 min/img. Establishing wides,
    backgrounds, one-off subjects, suited figures at distance.
  * HERO: a shot tagged "hero": ["<subject-key>", ...] is conditioned on the
    locked baseline reference(s) for those subjects (the show's visual.refs
    index) via Qwen-Image-Edit (Apache-2.0, commercial-safe;
    ~11 min/img, 38 GB peak). This carries a recurring character's/ship's IDENTITY
    across shots instead of re-rolling a fresh look each time.

A hero shot whose baseline is NOT yet locked falls back to the ambient path with a
warning, so the pipeline works before the bible is complete.

Idempotent: skips shots whose PNG already exists (delete a PNG to re-roll it).

A shot whose `source` is `showrunner` is never generated; the showrunner drops it in, and the
line says `[MISSING — drop the file here]` until he has.

Usage: image-generate.py <episode> [--show-root <path>]"""
import json, os, shutil, subprocess, sys

from lib import showconfig as sc

Z_BINARY   = "mflux-generate-z-image-turbo"    # ambient workhorse
EDIT_BINARY = "mflux-generate-qwen-edit"       # hero / identity tool (Apache 2.0)

def find_bin(name: str) -> str:
    for cand in (shutil.which(name),
                 os.path.expanduser(f"~/.local/bin/{name}"),
                 os.path.expanduser(f"~/.bun/bin/{name}")):
        if cand and os.path.exists(cand):
            return cand
    sys.exit(f"image-generate: {name} not found on PATH")

def load_bible(path: str) -> dict:
    """The show's reference index (visual.refs); an absent file means nothing is locked yet."""
    if not os.path.exists(path):
        return {}
    d = json.load(open(path))
    # skip metadata keys (_doc, _ruled); only subjects whose ref exists are "locked"
    return {k: v for k, v in d.items()
            if not k.startswith("_") and isinstance(v, dict)
            and v.get("ref") and os.path.exists(v["ref"])}

def hero_refs(shot, bible):
    """Return (ref_paths, missing_keys) for a shot's hero subjects."""
    keys = shot.get("hero") or []
    if isinstance(keys, str):
        keys = [keys]
    refs, missing = [], []
    for k in keys:
        if k in bible:
            refs.append(bible[k]["ref"])
        else:
            missing.append(k)
    return refs, missing

def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("image-generate: episode id missing "
                 "(usage: image-generate.py <episode> [--show-root <path>])")
    # The show says where its reference index lives and what shape a frame is; a shot may still
    # override the frame per image.
    frame = list(sc.value(cfg, "visual", "shotFrame"))
    base = f"Production/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    shots = doc["shots"]
    bible = load_bible(sc.path(cfg, "visual", "refs", root=root))

    z_bin = find_bin(Z_BINARY)
    edit_bin = None                      # resolve lazily; only if a hero shot needs it
    done = hero = 0

    for pos, shot in enumerate(shots, 1):
        sc.progress(pos, len(shots), "shots")
        out = f"{base}/{shot['id']}.png"
        if shot.get("source", "pipeline") == "showrunner":
            # The showrunner makes this one by hand, whatever its type. Checked BEFORE the
            # character/ambient branch, because a showrunner-made ambient shot would otherwise
            # fall through to the GPU.
            done += 1
            print(f"skip {shot['id']} (showrunner-made)"
                  + ("" if os.path.exists(out) else "  [MISSING — drop the file here]"))
            continue
        if shot.get("type") == "character":
            # generated in Nano Banana by the showrunner (faces); skip locally.
            # expects the returned PNG dropped in as {id}.png; warn if still missing.
            done += 1
            print(f"skip {shot['id']} (character shot — provide from Nano Banana)"
                  + ("" if os.path.exists(out) else "  [MISSING — drop the file here]"))
            continue
        if os.path.exists(out):
            done += 1
            print(f"skip {shot['id']} (exists)")
            continue

        refs, missing = hero_refs(shot, bible)
        w, h = str(shot.get("width", frame[0])), str(shot.get("height", frame[1]))

        if refs:
            if missing:
                print(f"  note {shot['id']}: hero baselines not locked yet: {missing} "
                      f"(conditioning on {len(refs)} that are)")
            if edit_bin is None:
                edit_bin = find_bin(EDIT_BINARY)
            cmd = [edit_bin, "--quantize", "8",
                   "--image-paths", *refs,
                   "--prompt", shot["prompt"],
                   "--seed", str(shot["seed"]),
                   "--width", w, "--height", h,
                   "--output", out]
            tag = f"HERO<-{','.join(shot.get('hero') if isinstance(shot.get('hero'), list) else [shot.get('hero')])}"
            hero += 1
        else:
            if shot.get("hero"):
                print(f"  WARN {shot['id']}: hero subjects {shot['hero']} have no locked "
                      f"baseline — falling back to ambient Z-Image")
            cmd = [z_bin,
                   "--prompt", shot["prompt"],
                   "--seed", str(shot["seed"]),
                   "--width", w, "--height", h,
                   "--output", out]
            tag = "ambient"

        subprocess.run(cmd, check=True, capture_output=True, text=True)
        done += 1
        print(f"[{done}/{len(shots)}] {shot['id']} ({tag})")

    print(f"IMG_OK {done} shots -> {base}/  ({hero} hero via Qwen-Edit, {done - hero} ambient)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"image-generate: {err}")
