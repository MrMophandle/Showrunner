# /// script
# dependencies = []
# ///
"""design-visual: generate baseline candidate images for a Visual Bible subject.

The image parallel to design-voice.py. Given a subject key from
Canon/refs.json, render N candidates from its `baseline_prompt` (a
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
  ARGUMENTS="remo" uv run .archon/scripts/design-visual.py            # 3 candidates for one subject
  ARGUMENTS="remo 4" uv run .archon/scripts/design-visual.py          # 4 candidates
  ARGUMENTS="all" uv run .archon/scripts/design-visual.py             # 3 each for every unlocked subject

Writes Canon/_candidates/<key>-1.png .. -N.png and prints the paths.
Locking is manual: copy the chosen candidate to Canon/characters/<key>.png."""
import json, os, shutil, subprocess, sys

QWEN_BINARY = "mflux-generate-qwen"     # high-adherence baseline model (Apache-2.0)
BIBLE = "Canon/refs.json"
CAND_DIR = "Canon/_candidates"

def find_bin(name):
    for c in (shutil.which(name), os.path.expanduser(f"~/.local/bin/{name}"),
              os.path.expanduser(f"~/.bun/bin/{name}")):
        if c and os.path.exists(c):
            return c
    sys.exit(f"design-visual: {name} not found on PATH")

def render(qbin, prompt, seed, out):
    # Qwen-Image with real guidance so structural directives (grabber arms, six
    # arms) actually land; 8-bit to keep the 20B model in memory.
    subprocess.run([qbin, "--quantize", "8", "--steps", "30", "--guidance", "3.5",
                    "--prompt", prompt, "--seed", str(seed),
                    "--width", "1024", "--height", "576", "--output", out],
                   check=True, capture_output=True, text=True)

def main():
    arg = os.environ.get("ARGUMENTS", "").split()
    if not arg:
        sys.exit("design-visual: ARGUMENTS needs a subject key (or 'all'), optional count")
    key = arg[0]
    n = int(arg[1]) if len(arg) > 1 and arg[1].isdigit() else 3

    bible = json.load(open(BIBLE))
    subjects = ([k for k in bible if not k.startswith("_")
                 and not (bible[k].get("ref") and os.path.exists(bible[k]["ref"]))]
                if key == "all" else [key])
    if key != "all" and key not in bible:
        sys.exit(f"design-visual: unknown subject {key!r}. Known: "
                 f"{[k for k in bible if not k.startswith('_')]}")

    os.makedirs(CAND_DIR, exist_ok=True)
    qbin = find_bin(QWEN_BINARY)
    for subj in subjects:
        spec = bible[subj]
        prompt = spec["baseline_prompt"]
        print(f"=== {subj} ({spec['kind']}) — {n} candidates ===")
        # deterministic per-subject base seed (Python's hash() is per-process
        # randomized, so derive a stable value from the characters instead)
        base_seed = sum(ord(c) * (idx + 1) for idx, c in enumerate(subj)) % 90000 + 1000
        for i in range(1, n + 1):
            out = f"{CAND_DIR}/{subj}-{i}.png"
            if os.path.exists(out):
                os.remove(out)          # mflux-generate-qwen appends _2 if the file exists
            render(qbin, prompt, base_seed + i * 137, out)
            print(f"  CANDIDATE {out}")
    print("\nPick by eye, then lock:  cp Canon/_candidates/<key>-<n>.png "
          "Canon/characters/<key>.png")

main()
