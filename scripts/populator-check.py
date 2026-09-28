# /// script
# dependencies = []
# ///
"""populator-check: does any character brief in this episode invent uncredited people?

The same mechanical law `nano-banana-generate.py` enforces before it spends, run on its own as a
step of the pipeline ahead of the image branch. Three consecutive episodes were halted by that
guard after the visual direction was already written; catching it here means the brief is fixed
while the writer is still holding it, not after the image step refuses.

Reads Production/<episode>/images/prompts.json and applies the show's banned-phrase list
(visual.collectivePopulatorBans) to every type:"character" brief.

Exit 0 and `POPULATORS_OK <n> briefs` when every brief is clean. Exit 2, with one line per
offending shot on stderr, when any brief is not -- a code of its own, so the pipeline can tell a
dirty brief (fix the writing) from a broken config (exit 1, fix the show).

Usage: populator-check.py <episode> [--show-root <path>]
"""
import json
import os
import sys

from lib import populators
from lib import showconfig as sc

DIRTY = 2


def check(shots, phrases, on_judged=None):
    """-> (character shots, [(shot id, matched phrases)] for those whose briefs break the law).

    `on_judged` is called with (position, total) as each brief is judged, so the caller can report
    progress AS the work happens rather than after all of it.
    """
    character_shots = [s for s in shots if s.get("type") == "character"]
    found = []
    for pos, shot in enumerate(character_shots, 1):
        hits = populators.find_collective_populators(str(shot.get("brief", "")), phrases)
        if hits:
            found.append((str(shot.get("id", "?")), hits))
        if on_judged is not None:
            on_judged(pos, len(character_shots))
    return character_shots, found


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("populator-check: episode id missing "
                 "(usage: populator-check.py <episode> [--show-root <path>])")
    phrases = list(sc.value(cfg, "visual", "collectivePopulatorBans"))
    style_path = str(sc.value(cfg, "visual", "style"))

    prompts_path = f"Production/{ep}/images/prompts.json"
    with open(prompts_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    shots, found = check(doc.get("shots", []), phrases,
                         on_judged=lambda done, total: sc.progress(done, total, "briefs"))

    if found:
        print(f"COLLECTIVE POPULATOR(S) in {len(found)} character brief(s) of {prompts_path} "
              f"({style_path}, \"No collective populators\"):", file=sys.stderr)
        for line in populators.report_lines(found):
            print(line, file=sys.stderr)
        print("Every person in frame must be named and present in refs — name them or cap the "
              "headcount, then re-run.", file=sys.stderr)
        sys.exit(DIRTY)

    # The last line is this step's RESULT: the gate message after it reads it verbatim.
    print(f"POPULATORS_OK {len(shots)} briefs")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"populator-check: {err}")
