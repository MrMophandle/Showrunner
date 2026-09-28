import os
import check_layout as cl

def test_flags_missing_status(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    issues = cl.audit(root, "ep05")
    assert any("STATUS.md missing" in i for i in issues)

def test_ok_when_status_present(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    open(f"{root}/Episodes/ep05/STATUS.md", "w").write("# STATUS — ep05\n")
    assert cl.audit(root, "ep05") == []

def test_flags_script_misplaced_under_production(tmp_path):
    root = str(tmp_path)
    os.makedirs(f"{root}/Episodes/ep05")
    open(f"{root}/Episodes/ep05/STATUS.md", "w").write("x")
    os.makedirs(f"{root}/Production/ep05")
    open(f"{root}/Production/ep05/script.md", "w").write("x")
    assert any("misplaced" in i for i in cl.audit(root, "ep05"))

def test_missing_episode_dir(tmp_path):
    assert cl.audit(str(tmp_path), "ep99") == ["missing Episodes/ep99/"]

# --- end to end, through argv and the show's config ----------------------------------------

def test_the_script_audits_every_episode_from_config_paths(show_root):
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    (show_root / "Episodes" / "ep01").mkdir(parents=True)
    (show_root / "Episodes" / "ep01" / "STATUS.md").write_text("# STATUS — ep01\n")
    (show_root / "Episodes" / "ep02").mkdir(parents=True)     # no STATUS.md
    r = subprocess.run([sys.executable, str(SCRIPTS_DIR / "check_layout.py")],
                       cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 1
    assert "[ep01] OK" in r.stdout
    assert "[ep02] Episodes/ep02/STATUS.md missing" in r.stdout
    assert r.stdout.strip().splitlines()[-1] == "CHECK_LAYOUT FAIL (1 issue(s))"


def test_a_named_episode_on_argv_narrows_the_audit(show_root):
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    (show_root / "Episodes" / "ep01").mkdir(parents=True)
    (show_root / "Episodes" / "ep01" / "STATUS.md").write_text("x")
    (show_root / "Episodes" / "ep02").mkdir(parents=True)
    r = subprocess.run([sys.executable, str(SCRIPTS_DIR / "check_layout.py"), "ep01"],
                       cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 0
    assert "ep02" not in r.stdout
    assert r.stdout.strip().splitlines()[-1] == "CHECK_LAYOUT OK (0 issue(s))"
