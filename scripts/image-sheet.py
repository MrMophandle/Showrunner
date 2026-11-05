# /// script
# dependencies = []
# ///
"""image-sheet: prompts.json -> a human-readable IMAGE-SHEET.md for the episode.

The showrunner's shot list at a glance, as one table in shot order: every image, the scene it
establishes, whether it is in place yet, and the brief it was made from (spec 2026-11-04 §4's
sheet row). Standard artifact per episode, written before the image gate and again after it.

One list rather than two. Until 2026-11-04 the sheet split the shots by who rendered them; every
image in the show now comes from nano-banana (spec 2026-11-04 §3.2), so the only distinction left
is the one a person has to act on, and it is each shot's `state`:

  rendered                     a pipeline shot whose PNG is on disk
  missing                      a pipeline shot with no PNG: the renderer has not made it yet, or
                               an audit deleted it to force a re-roll
  by hand — in place           a `source: "showrunner"` shot whose PNG is on disk
  by hand — MISSING: drop …    a `source: "showrunner"` shot still waiting on the showrunner;
                               nothing renders it, and the guard after the image gate waits

Usage: image-sheet.py <episode> [--show-root <path>]
Writes Production/<ep>/images/IMAGE-SHEET.md.
"""
import json, os, sys

from lib import showconfig as sc

BRIEF_WIDTH = 110            # the table stays readable; prompts.json holds the full brief


def by_hand(shot):
    """True for a shot the showrunner makes himself (`source: "showrunner"`).

    Nothing renders such a shot, so its absent PNG is work waiting on a person rather than a
    render that failed. The sheet is the only place that distinction is read, and it is said in
    the shot's own `state` cell rather than in a legend at the top.
    """
    return shot.get("source") == "showrunner"


def state(shot, present, images_dir):
    """The shot's `state` cell: what is on disk, and for a missing one, whose move it is."""
    sid = shot.get("id", "?")
    if by_hand(shot):
        return "by hand — in place" if present else f"by hand — MISSING: drop `{sid}.png` into {images_dir}"
    return "rendered" if present else "missing"


def cell(brief):
    """One brief as a table cell: whitespace collapsed, pipes escaped, long briefs cut short."""
    s = " ".join(str(brief or "").split()).replace("|", "\\|")
    if not s:
        return "*(no brief)*"
    return s if len(s) <= BRIEF_WIDTH else s[:BRIEF_WIDTH].rstrip() + " …"


def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("image-sheet: episode id missing "
                 "(usage: image-sheet.py <episode> [--show-root <path>])")
    prod = sc.production_dir(cfg)
    base = f"{prod}/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    shots = doc["shots"]
    def present(sid): return os.path.exists(f"{base}/{sid}.png")

    n_hand = sum(1 for s in shots if by_hand(s))
    n_missing = sum(1 for s in shots if not present(s.get("id", "")))

    L = []
    L.append(f"# {ep} — Image Sheet")
    L.append("")
    L.append(f"**{len(shots)} images** — one establishing shot per scene; "
             f"{n_hand} by hand (showrunner-made).")
    L.append("")
    L.append("| shot | scene | state | brief |")
    L.append("|---|---|---|---|")
    for s in shots:
        sid = s.get("id", "?")
        L.append(f"| {sid} | {s.get('scene', '')} | "
                 f"{state(s, present(sid), base)} | {cell(s.get('brief'))} |")
    L.append("")

    out = f"{base}/IMAGE-SHEET.md"
    open(out, "w").write("\n".join(L) + "\n")
    print(f"sheet: {out}")
    print(f"SHEET_OK {len(shots)} shots ({n_hand} by hand, {n_missing} missing)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"image-sheet: {err}")
