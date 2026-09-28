# /// script
# dependencies = []
# ///
"""canon-diff: what did this episode change in the show's canon?

The canon gate used to run `git diff Canon/` in a shell node and hand the whole patch to an agent
through its stdout. This writes the patch to a file the prompt is told to read, and prints a
one-line summary as its result, so the gate message can say how much changed without the patch
itself travelling through a prompt variable.

Writes Production/<episode>/canon-diff.patch (empty when nothing changed) and prints NO_CHANGES or
CHANGED <files> files, <lines> lines. Exit 0 either way: an empty diff is an answer, not a fault.

Usage: canon-diff.py <episode> [--show-root <path>]
"""
import os
import re
import subprocess
import sys

from lib import showconfig as sc

_FILE_HEADER = re.compile(r"^diff --git ", re.M)
# A patch's body lines begin with + or -, but so do its file headers (+++ b/..., --- a/...). Count
# the body only, or every changed file would add two phantom lines to the total.
_BODY_CHANGE = re.compile(r"^(?:\+(?!\+\+ )|-(?!-- ))", re.M)


def summarize(patch: str) -> tuple[int, int]:
    """-> (files changed, body lines added or removed) for a unified diff."""
    return len(_FILE_HEADER.findall(patch)), len(_BODY_CHANGE.findall(patch))


def git_diff(canon_dir: str, root: str) -> str:
    """`git diff -- <canon dir>` in the show root, as an argv list.

    An argv list, never a shell string: spec §4.4, and a canon directory carrying a space would
    otherwise become two arguments. The `--` is git's own separator between revisions and
    pathspecs -- without it, a branch or tag sharing the directory's name makes `git diff Canon`
    ambiguous, and git either refuses or diffs the revision instead of the directory.
    """
    proc = subprocess.run(["git", "diff", "--", canon_dir],
                          cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        raise RuntimeError(f"git diff failed (exit {proc.returncode}): "
                           f"{detail[-1] if detail else 'no output'}")
    return proc.stdout


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("canon-diff: episode id missing "
                 "(usage: canon-diff.py <episode> [--show-root <path>])")
    canon_dir = str(sc.value(cfg, "canonDir"))

    patch = git_diff(canon_dir, root)
    out_dir = f"Production/{ep}"
    os.makedirs(out_dir, exist_ok=True)
    out_path = f"{out_dir}/canon-diff.patch"
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(patch)

    files, lines = summarize(patch)
    print(f"  patch: {out_path}")
    # The last line is this step's RESULT: the gate message after it reads it verbatim, and the
    # prompt is told to open the patch file for the detail.
    print("NO_CHANGES" if not patch.strip() else f"CHANGED {files} files, {lines} lines")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError, RuntimeError) as err:
        sys.exit(f"canon-diff: {err}")
