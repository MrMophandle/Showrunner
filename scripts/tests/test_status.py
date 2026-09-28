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


# --- end to end, through argv and the show's config ----------------------------------------

def test_the_script_stamps_from_argv_alone(show_root):
    """The whole interface: <ep> <milestone> [detail] on argv, episodesDir from config."""
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    (show_root / "Episodes" / "ep05").mkdir(parents=True)
    r = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "status.py"), "ep05", "finalized", "to the NAS"],
        cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    body = (show_root / "Episodes/ep05/STATUS.md").read_text()
    assert "finalized: to the NAS" in body
    assert r.stdout.strip().splitlines()[-1].startswith("STATUS ep05: finalized")


def test_an_unknown_milestone_exits_non_zero(show_root):
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    (show_root / "Episodes" / "ep05").mkdir(parents=True)
    r = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "status.py"), "ep05", "invented", "x"],
        cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode != 0
    assert "unknown milestone" in r.stderr


def test_the_episodes_directory_comes_from_config(show_root):
    """episodesDir is the show's layout, not a literal in the script."""
    import json, subprocess, sys
    from conftest import SCRIPTS_DIR

    cfg = json.loads((show_root / "showrunner.json").read_text())
    cfg["episodesDir"] = "Shows"
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    (show_root / "Shows" / "ep05").mkdir(parents=True)
    r = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "status.py"), "ep05", "beats", "locked"],
        cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (show_root / "Shows/ep05/STATUS.md").exists()
    assert not (show_root / "Episodes").exists()
