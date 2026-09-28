# /// script
# dependencies = []
# ///
"""image-generate: prompts.json -> local stills.

TWO paths, chosen per shot (the tiered "hero routing" ruled 2026-07-19):
  * AMBIENT (default): Z-Image-Turbo, seeded, ~2.4 min/img. Establishing wides,
    backgrounds, one-off subjects, suited figures at distance.
  * HERO: a shot tagged "hero": ["<subject-key>", ...] is conditioned on the
    locked baseline reference(s) for those subjects (the Visual Bible,
    Canon/characters/) via Qwen-Image-Edit (Apache-2.0, commercial-safe;
    ~11 min/img, 38 GB peak). This carries a recurring character's/ship's IDENTITY
    across shots instead of re-rolling a fresh look each time.

A hero shot whose baseline is NOT yet locked falls back to the ambient path with a
warning, so the pipeline works before the bible is complete.

Idempotent: skips shots whose PNG already exists (delete a PNG to re-roll it)."""
import json, os, shutil, subprocess, sys

Z_BINARY   = "mflux-generate-z-image-turbo"    # ambient workhorse
EDIT_BINARY = "mflux-generate-qwen-edit"       # hero / identity tool (Apache 2.0)
BIBLE = "Canon/refs.json"

def find_bin(name: str) -> str:
    for cand in (shutil.which(name),
                 os.path.expanduser(f"~/.local/bin/{name}"),
                 os.path.expanduser(f"~/.bun/bin/{name}")):
        if cand and os.path.exists(cand):
            return cand
    sys.exit(f"image-generate: {name} not found on PATH")

def load_bible() -> dict:
    if not os.path.exists(BIBLE):
        return {}
    d = json.load(open(BIBLE))
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
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("image-generate: episode id missing (first token of ARGUMENTS)")
    base = f"Production/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    shots = doc["shots"]
    bible = load_bible()

    z_bin = find_bin(Z_BINARY)
    edit_bin = None                      # resolve lazily; only if a hero shot needs it
    done = hero = 0

    for shot in shots:
        out = f"{base}/{shot['id']}.png"
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
        w, h = str(shot.get("width", 1024)), str(shot.get("height", 576))

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

main()
