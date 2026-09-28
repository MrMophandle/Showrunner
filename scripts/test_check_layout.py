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
