# /// script
# dependencies = []
# ///
"""design-visual: generate baseline candidate images for a visual-bible subject.

The image parallel to design-voice.py. Given a subject key from the show's cast
index (Canon/cast.json), render N candidates from its `baseline_prompt` (a
clean, legible character-sheet style — NOT the low-key episode look, because a
reference must be readable; hero edits re-light it into scene later). The
showrunner picks the one that IS the character by eye; the kept PNG is committed
as that subject's `ref`, and every future hero shot conditions on it.

Uses **Qwen-Image** (mflux-generate-qwen, Apache-2.0) for candidates, NOT the fast
Z-Image-Turbo. A baseline is a one-time hero asset that must follow STRUCTURAL
directives (an overbuilt tug with grabber arms; a six-armed segmented carapace) —
Z-Image-Turbo is a distilled no-guidance model that ignores structure and count
(it drew a smooth pod for "tug with grabber arms", two arms for "six arms"). Qwen
has real CFG guidance and follows them. Slower (~several min/img), fine for a
handful of one-time baselines. Episode ambient shots keep Z-Image-Turbo for speed.

Usage:
  design-visual.py <subject-key> [count] [--show-root <path>]   # default 3 candidates
  design-visual.py all [count] [--show-root <path>]             # every unlocked subject

Writes <visual.candidatesDir>/<key>-1.png .. -N.png and prints the paths.
Locking is manual and has two halves: copy the chosen candidate into
<visual.castingPileDir>, then set that subject's face.ref in the cast index to
the path you copied it to."""
import os, shutil, subprocess, sys

from lib import castindex
from lib import showconfig as sc

QWEN_BINARY = "mflux-generate-qwen"     # high-adherence baseline model (Apache-2.0)

def find_bin(name):
    for c in (shutil.which(name), os.path.expanduser(f"~/.local/bin/{name}"),
              os.path.expanduser(f"~/.bun/bin/{name}")):
        if c and os.path.exists(c):
            return c
    sys.exit(f"design-visual: {name} not found on PATH")

def render(qbin, prompt, seed, out, frame):
    # Qwen-Image with real guidance so structural directives (grabber arms, six
    # arms) actually land; 8-bit to keep the 20B model in memory.
    subprocess.run([qbin, "--quantize", "8", "--steps", "30", "--guidance", "3.5",
                    "--prompt", prompt, "--seed", str(seed),
                    "--width", str(frame[0]), "--height", str(frame[1]), "--output", out],
                   check=True, capture_output=True, text=True)

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    arg = sys.argv[1:]
    if not arg:
        sys.exit("design-visual: subject key missing "
                 "(usage: design-visual.py <subject-key|all> [count] [--show-root <path>])")
    key = arg[0]
    n = int(arg[1]) if len(arg) > 1 and arg[1].isdigit() else 3

    cand_dir = sc.path(cfg, "visual", "candidatesDir", root=root)
    casting_dir = str(sc.value(cfg, "visual", "castingPileDir"))
    frame = list(sc.value(cfg, "visual", "shotFrame"))

    # The cast index is the worklist: `all` designs every subject carrying a baseline prompt and no
    # reference yet (castindex.unlocked), which is the set the index calls undesigned rather than a
    # set inferred from what is on disk.
    index = castindex.load(cfg, root)
    cast = index["cast"]
    subjects = castindex.unlocked(index) if key == "all" else [key]
    if key != "all" and key not in cast:
        sys.exit(f"design-visual: unknown subject {key!r}. Known: {sorted(cast)}")
    # The index holds every cast member — locations, species and motifs among them — and only a
    # subject with a baseline prompt can be rendered. Refuse by name rather than raising a KeyError
    # three lines down, because a key that is in the index but undesignable is a likely typo.
    if key != "all" and not isinstance(cast[key].get("baseline_prompt"), str):
        sys.exit(f"design-visual: {key!r} has no baseline_prompt in {castindex.index_path(cfg)} — "
                 f"write one there first (it is the brief these candidates are rendered from)")

    os.makedirs(cand_dir, exist_ok=True)
    qbin = find_bin(QWEN_BINARY)
    done, total = 0, len(subjects) * n
    for subj in subjects:
        spec = cast[subj]
        prompt = spec["baseline_prompt"]
        print(f"=== {subj} ({spec.get('kind', '?')}) — {n} candidates ===")
        # deterministic per-subject base seed (Python's hash() is per-process
        # randomized, so derive a stable value from the characters instead)
        base_seed = sum(ord(c) * (idx + 1) for idx, c in enumerate(subj)) % 90000 + 1000
        for i in range(1, n + 1):
            out = os.path.join(cand_dir, f"{subj}-{i}.png")
            if os.path.exists(out):
                os.remove(out)          # mflux-generate-qwen appends _2 if the file exists
            render(qbin, prompt, base_seed + i * 137, out, frame)
            done += 1
            sc.progress(done, total, "candidates")
            print(f"  CANDIDATE {out}")
    # Locking is two acts, and the second is the one the engine reads: the file goes into the
    # casting pile, and the entry's face.ref in the cast index is set to that path. A PNG copied
    # into place and left out of the index is a face no generator will ever condition on.
    print(f"\nPick by eye, then lock:  cp {cand_dir}/<key>-<n>.png "
          f"{casting_dir}/<key>.png")
    print(f"then set cast.<key>.face.ref to that path in {castindex.index_path(cfg)}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"design-visual: {err}")
