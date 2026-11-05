# /// script
# dependencies = ["google-genai", "pillow"]
# ///
"""design-visual: render candidate faces for a cast subject, one per brief.

The image parallel to design-voice.py. Given a subject key from the show's cast index
(Canon/cast.json) and a file of briefs, this renders one candidate per brief through the shared
Gemini client in lib/nanobanana.py (spec 2026-11-04 §3.3) — the same client, retry policy and
cost cap every episode image goes through. The showrunner picks the one that IS the character by
eye; the kept PNG is committed as that subject's `ref`, and every future hero shot conditions on
it.

One call per brief, text only: a candidate conditions on no reference image, because a face is
what these calls are for. The briefs are the variation — distinct descriptions written by hand,
not one description re-rolled (Ryan's ruling of 2026-11-01). Until 2026-11-04 a candidate came
from a model on Ryan's own machine, one prompt re-seeded N times; that path, the seed derivation
and the `all` mode are deleted (spec 2026-11-04 §3.3).

`baseline_prompt` in the cast index is the brief author's starting point, not the prompt: nothing
here reads it. What this script renders is the briefs file, so that the candidates differ by
description rather than by seed.

Usage: design-visual.py <subject-key> --briefs <file> [--show-root <path>]

The briefs file is a JSON list of strings. A candidate whose PNG is already on disk is kept and
no call is billed for it, so a re-run after a partial failure costs only what is missing.

Writes <visual.candidatesDir>/<key>-1.png .. -N.png and prints the paths. Locking is manual and
has two halves: copy the chosen candidate into <visual.castingPileDir>, then set that subject's
face.ref in the cast index to the path you copied it to.
"""
import json, os, sys

from lib import castindex
from lib import nanobanana as nb
from lib import showconfig as sc

BRIEFS_FLAG = "--briefs"


def read_briefs(path):
    """-> [brief, ...] from a JSON list of strings; refuses by naming the file otherwise.

    One line, not a traceback: this file is hand-written by whoever is designing the face, and the
    two mistakes it invites (a JSON object of named briefs, a single string) are both answered by
    the same correction.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except ValueError as err:
        sys.exit(f"design-visual: {path} is not valid JSON: {err}")
    if not isinstance(doc, list) or not doc or not all(isinstance(b, str) and b.strip() for b in doc):
        sys.exit(f"design-visual: {path} must hold a JSON list of non-empty brief strings "
                 f"(one candidate is rendered per brief)")
    return [b.strip() for b in doc]


def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    arg = sys.argv[1:]
    briefs_file = ""
    if BRIEFS_FLAG in arg:
        at = arg.index(BRIEFS_FLAG)
        if at + 1 >= len(arg):
            sys.exit(f"design-visual: {BRIEFS_FLAG} needs a path")
        briefs_file = arg[at + 1]
        del arg[at:at + 2]
    if not arg or not briefs_file:
        sys.exit("design-visual: subject key or briefs file missing "
                 "(usage: design-visual.py <subject-key> --briefs <file> [--show-root <path>])")
    key = arg[0]
    briefs = read_briefs(briefs_file)

    cand_dir = sc.path(cfg, "visual", "candidatesDir", root=root)
    casting_dir = str(sc.value(cfg, "visual", "castingPileDir"))
    # The style constants are the show's standing look, appended to every brief by the renderer
    # rather than written into each one (spec 2026-11-04 §2.3), and a candidate is rendered the
    # same way so that it is a reference in the show's own register.
    style_constants = str(sc.value(cfg, "visual", "styleConstants"))

    # The cast index says who exists. A key that is not in it is a typo, and refusing by name
    # beats billing a call for a subject the show has never heard of.
    index = castindex.load(cfg, root)
    cast = index["cast"]
    if key not in cast:
        sys.exit(f"design-visual: unknown subject {key!r}. Known: {sorted(cast)}")

    os.makedirs(cand_dir, exist_ok=True)
    counter = {"calls": 0}
    failed = []
    print(f"=== {key} ({cast[key].get('kind', '?')}) — {len(briefs)} briefs ===")
    for i, brief in enumerate(briefs, 1):
        out = os.path.join(cand_dir, f"{key}-{i}.png")
        if os.path.exists(out):
            # Idempotent by the file on disk, as every other paid step in this pipeline is: a
            # re-run after a refusal or a depleted balance must not re-bill what is already made.
            print(f"  KEPT {out} (already on disk — no call billed)")
            sc.progress(i, len(briefs), "candidates")
            continue
        status = nb.generate_image(brief + "\n\n" + style_constants, [], out, counter)
        if status == "ok":
            print(f"  CANDIDATE {out}")
        else:
            failed.append((out, status))
            print(f"  FAILED {out} — {status}")
        sc.progress(i, len(briefs), "candidates")
    print(f"\n{counter['calls']} API call(s) billed.")

    # Locking is two acts, and the second is the one the engine reads: the file goes into the
    # character's own folder as its reference, and the entry's face.ref in the cast index is set to
    # that path. A PNG copied into place and left out of the index is a face no generator will ever
    # condition on. The destination is the shape spec 2026-10-31 §1.2b rules for a character
    # folder -- the sheet, one `reference.png`, and at most three gallery images -- so the path
    # printed here is the path the prune leaves alone and the audit expects to find.
    print("Pick by eye, then lock (spec §1.2b: one reference.png per character folder):")
    print(f"  cp {cand_dir}/<key>-<n>.png {casting_dir}/<Name>/reference.png")
    print(f"then set cast.<key>.face.ref to that path in {castindex.index_path(cfg)}")
    if failed:
        sys.exit(f"design-visual: {len(failed)} of {len(briefs)} candidates did not render "
                 f"(re-run to retry only what is missing)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"design-visual: {err}")
