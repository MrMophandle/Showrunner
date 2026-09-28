# /// script
# dependencies = []
# ///
"""status: idempotently stamp a milestone line into Episodes/<ep>/STATUS.md.
Milestones update in place (one line each), never duplicate — so STATUS.md is the
durable 'where is this episode' record the workflow writes at each gate/milestone.
Usage: status.py <ep> <milestone> [detail...] [--show-root <path>]"""
import os, re, sys, datetime

from lib import showconfig as sc

# The milestone vocabulary is an ENGINE constant, not show config: the pipeline's own stages are
# what these name, and a show does not get to invent a tenth one (inventory F-15).
MILESTONES = ["beats", "outline", "script", "canon", "casting",
              "audio", "images", "assembled", "finalized"]

def stamp(root, ep, milestone, detail, today, episodes_dir="Episodes"):
    path = os.path.join(root, episodes_dir, ep, "STATUS.md")
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
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    episodes_dir = str(sc.value(cfg, "episodesDir"))
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(f"status: usage: status.py <ep> <milestone> [detail] [--show-root <path>]; "
                 f"milestones={MILESTONES}")
    ep, milestone, detail = args[0], args[1], " ".join(args[2:])
    if milestone not in MILESTONES:
        sys.exit(f"status: unknown milestone {milestone!r}; one of {MILESTONES}")
    p = stamp(".", ep, milestone, detail, datetime.date.today().isoformat(), episodes_dir)
    print(f"STATUS {ep}: {milestone} -> {detail!r} -> {p}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"status: {err}")
