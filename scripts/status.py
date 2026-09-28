# /// script
# dependencies = []
# ///
"""status: idempotently stamp a milestone line into Episodes/<ep>/STATUS.md.
Milestones update in place (one line each), never duplicate — so STATUS.md is the
durable 'where is this episode' record the workflow writes at each gate/milestone.
Usage: uv run .archon/scripts/status.py <ep> <milestone> [detail...]
   or  ARGUMENTS="<ep> <milestone> detail" uv run .archon/scripts/status.py"""
import os, re, sys, datetime

MILESTONES = ["beats", "outline", "script", "canon", "casting",
              "audio", "images", "assembled", "finalized"]

def stamp(root, ep, milestone, detail, today):
    path = os.path.join(root, "Episodes", ep, "STATUS.md")
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    if not lines or not lines[0].startswith("# STATUS"):
        lines = [f"# STATUS — {ep}", ""] + lines
    newline = f"- {today} {milestone}: {detail}".rstrip()
    pat = re.compile(rf"^- \S+ {re.escape(milestone)}:")
    for i, l in enumerate(lines):
        if pat.match(l):
            lines[i] = newline
            break
    else:
        lines.append(newline)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write("\n".join(lines).rstrip() + "\n")
    return path

def main():
    # argv WINS when present: Archon exports ARGUMENTS=<ep> for the whole run, so a node
    # that also passes CLI args (e.g. `status.py "$EP" finalized "..."`) would otherwise have
    # them silently discarded and see only the episode id. (Caught by the ep04 assemble smoke
    # test, 2026-07-28 — every stamp node in every workflow was failing this way.)
    argv = sys.argv[1:]
    args = argv if argv else os.environ.get("ARGUMENTS", "").split()
    if len(args) < 2:
        sys.exit(f"status: usage: <ep> <milestone> [detail]; milestones={MILESTONES}")
    ep, milestone, detail = args[0], args[1], " ".join(args[2:])
    if milestone not in MILESTONES:
        sys.exit(f"status: unknown milestone {milestone!r}; one of {MILESTONES}")
    p = stamp(".", ep, milestone, detail, datetime.date.today().isoformat())
    print(f"STATUS {ep}: {milestone} -> {detail!r} -> {p}")

if __name__ == "__main__":
    main()
