import os
import status

def test_stamp_creates_header_and_line(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    p = status.stamp(root, "ep05", "beats", "locked-beats.md", "2026-07-23")
    body = open(p).read()
    assert body.startswith("# STATUS — ep05")
    assert "- 2026-07-23 beats: locked-beats.md" in body

def test_stamp_updates_in_place_not_duplicate(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    status.stamp(root, "ep05", "beats", "locked-beats.md", "2026-07-23")
    status.stamp(root, "ep05", "beats", "revised beats", "2026-07-24")
    body = open(f"{root}/Episodes/ep05/STATUS.md").read()
    assert body.count(" beats:") == 1
    assert "- 2026-07-24 beats: revised beats" in body

def test_second_milestone_appends(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    status.stamp(root, "ep05", "beats", "x", "2026-07-23")
    status.stamp(root, "ep05", "script", "sha abc123", "2026-07-24")
    body = open(f"{root}/Episodes/ep05/STATUS.md").read()
    assert " beats:" in body and "script: sha abc123" in body
    assert body.count(" beats:") == 1


def test_cli_args_win_over_arguments_env(tmp_path, monkeypatch):
    """Archon exports ARGUMENTS=<ep> for the whole run, so a stamp node that also passes
    CLI args must NOT have them discarded. Regression: every stamp node in every workflow
    failed with a usage error because ARGUMENTS won (caught by the ep04 assemble smoke
    test, 2026-07-28)."""
    import subprocess, sys, os
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep09")
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, ARGUMENTS="ep09")          # the collision condition
    r = subprocess.run(
        [sys.executable, os.path.join(here, "status.py"), "ep09", "finalized", "pushed to NAS"],
        capture_output=True, text=True, cwd=root, env=env)
    assert r.returncode == 0, f"stamp node still fails with ARGUMENTS set: {r.stdout}{r.stderr}"
    body = open(f"{root}/Episodes/ep09/STATUS.md").read()
    assert "finalized: pushed to NAS" in body
