# /// script
# dependencies = []
# ///
"""check_layout: audit an episode's folders against Canon/pipeline-artifacts.md.
Non-destructive — reports issues only, never moves or deletes. Drives migration
and (later) serves as a workflow guard. Exit nonzero if any episode has issues.
Usage: check_layout.py [ep ...] [--show-root <path>]   (default: every episode directory)"""
import os, sys, glob

from lib import showconfig as sc

# narrative-source artifacts belong ONLY under Episodes/<ep>/ ; if they appear
# under Production/<ep>/ that's a misplacement.
SOURCE_ONLY = ("script.md", "outline.md", "locked-beats.md")

def audit(root, ep, episodes_dir="Episodes", production_dir="Production"):
    issues = []
    epdir = os.path.join(root, episodes_dir, ep)
    if not os.path.isdir(epdir):
        return [f"missing {episodes_dir}/{ep}/"]
    if not os.path.exists(os.path.join(epdir, "STATUS.md")):
        issues.append(f"{episodes_dir}/{ep}/STATUS.md missing")
    proddir = os.path.join(root, production_dir, ep)
    for name in SOURCE_ONLY:
        if os.path.exists(os.path.join(proddir, name)):
            issues.append(f"{name} misplaced under {production_dir}/{ep}/ "
                          f"(belongs in {episodes_dir}/{ep}/)")
    return issues

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    episodes_dir = str(sc.value(cfg, "episodesDir"))
    production_dir = str(sc.value(cfg, "productionDir"))
    args = sys.argv[1:]
    eps = args or sorted(os.path.basename(p)
                         for p in glob.glob(os.path.join(episodes_dir, "ep*"))
                         if os.path.isdir(p))
    total = 0
    for pos, ep in enumerate(eps, 1):
        sc.progress(pos, len(eps), "episodes")
        issues = audit(".", ep, episodes_dir, production_dir)
        if issues:
            for i in issues:
                print(f"  [{ep}] {i}"); total += 1
        else:
            print(f"  [{ep}] OK")
    print(f"CHECK_LAYOUT {'FAIL' if total else 'OK'} ({total} issue(s))")
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"check_layout: {err}")
