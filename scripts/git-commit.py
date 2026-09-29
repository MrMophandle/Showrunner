# /// script
# dependencies = []
# ///
"""git-commit: stage the listed paths and commit them with the given message, if anything is staged.
The pipeline's four commit steps used to be shell nodes — `git add` then `git commit` with a
message assembled in bash. This is that pair as one argv program the engine can spawn: each
listed path that exists is staged (additions, modifications and deletions under it), and a commit
is made only when the index differs from HEAD, so a step that re-runs after a crash commits
nothing twice. The message arrives verbatim; the engine already substituted the episode id.
Prints COMMIT_OK <short sha> or COMMIT_SKIPPED nothing staged; exit 0 either way. A git failure
exits non-zero with git's own stderr.
Usage: git-commit.py <episode> --message <text> [--show-root <path>] -- <path>..."""
import os, subprocess, sys
from lib import showconfig as sc


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def parse(argv: list[str]) -> tuple[str, str, list[str]]:
    if len(argv) < 2:
        sys.exit("git-commit: episode id missing (usage: git-commit.py <episode> --message <text> -- <path>...)")
    ep = argv[1]
    message = None
    if "--message" in argv:
        i = argv.index("--message")
        if i + 1 < len(argv):
            message = argv[i + 1]
    if not message:
        sys.exit("git-commit: --message <text> is required")
    if "--" not in argv:
        sys.exit("git-commit: list the paths to stage after --")
    paths = argv[argv.index("--") + 1:]
    if not paths:
        sys.exit("git-commit: list at least one path after --")
    return ep, message, paths


def main() -> None:
    root = os.path.abspath(sc.show_root(sys.argv))
    sc.load(root)
    os.chdir(root)
    _ep, message, paths = parse(sys.argv)
    for p in paths:
        if os.path.exists(p):
            r = git("add", "-A", "--", p)
            if r.returncode != 0:
                sys.exit(f"git-commit: git add {p}: {r.stderr.strip()}")
    if git("diff", "--cached", "--quiet").returncode == 0:
        print("COMMIT_SKIPPED nothing staged")
        return
    r = git("commit", "-q", "-m", message)
    if r.returncode != 0:
        sys.exit(f"git-commit: git commit: {r.stderr.strip()}")
    sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"COMMIT_OK {sha}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"git-commit: {err}")
