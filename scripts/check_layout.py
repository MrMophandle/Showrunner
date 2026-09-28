# /// script
# dependencies = []
# ///
"""check_layout: audit an episode's folders against Canon/pipeline-artifacts.md.
Non-destructive — reports issues only, never moves or deletes. Drives migration
and (later) serves as a workflow guard. Exit nonzero if any episode has issues.
Usage: uv run .archon/scripts/check_layout.py [ep ...]   (default: all Episodes/ep*)"""
import os, sys, glob

# narrative-source artifacts belong ONLY under Episodes/<ep>/ ; if they appear
# under Production/<ep>/ that's a misplacement.
SOURCE_ONLY = ("script.md", "outline.md", "locked-beats.md")

def audit(root, ep):
    issues = []
    epdir = os.path.join(root, "Episodes", ep)
    if not os.path.isdir(epdir):
        return [f"missing Episodes/{ep}/"]
    if not os.path.exists(os.path.join(epdir, "STATUS.md")):
        issues.append(f"Episodes/{ep}/STATUS.md missing")
    proddir = os.path.join(root, "Production", ep)
    for name in SOURCE_ONLY:
        if os.path.exists(os.path.join(proddir, name)):
            issues.append(f"{name} misplaced under Production/{ep}/ (belongs in Episodes/{ep}/)")
    return issues

def main():
    # argv WINS when present: Archon exports ARGUMENTS=<ep> for the whole run, so a node
    # that also passes CLI args (e.g. `status.py "$EP" finalized "..."`) would otherwise have
    # them silently discarded and see only the episode id. (Caught by the ep04 assemble smoke
    # test, 2026-07-28 — every stamp node in every workflow was failing this way.)
    argv = sys.argv[1:]
    args = argv if argv else os.environ.get("ARGUMENTS", "").split()
    eps = args or sorted(os.path.basename(p) for p in glob.glob("Episodes/ep*")
                         if os.path.isdir(p))
    total = 0
    for ep in eps:
        issues = audit(".", ep)
        if issues:
            for i in issues:
                print(f"  [{ep}] {i}"); total += 1
        else:
            print(f"  [{ep}] OK")
    print(f"CHECK_LAYOUT {'FAIL' if total else 'OK'} ({total} issue(s))")
    sys.exit(1 if total else 0)

if __name__ == "__main__":
    main()
