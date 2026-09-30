import json, os, subprocess, sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "git-commit.py"

def make_show(tmp_path: Path) -> Path:
    root = tmp_path / "show"
    root.mkdir()
    (root / "showrunner.json").write_text(json.dumps({
        "showName": "Harbor Light", "showSlug": "HarborLight", "promptsDir": "prompts",
        "models": {"medium": "m", "large": "l", "writer": "w"}, "airMap": {}, "output": {"nasRoot": "/nas"}}))
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True)
    return root

def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=root, capture_output=True, text=True)

def test_commits_listed_paths_that_exist_and_reports_the_sha(tmp_path):
    root = make_show(tmp_path)
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "outline.md").write_text("o\n")
    r = run(root, "s02e01", "--message", "s02e01: outline + script (write phase)", "--", "Episodes/s02e01", "Production/s02e01/runs")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")
    log = subprocess.run(["git", "log", "-1", "--format=%s"], cwd=root, capture_output=True, text=True).stdout.strip()
    assert log == "s02e01: outline + script (write phase)"
    assert subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True).stdout == ""

def test_skips_when_nothing_is_staged(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--message", "m", "--", "Episodes/s02e01")
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "COMMIT_SKIPPED nothing staged"

def test_refuses_a_missing_message_or_paths(tmp_path):
    root = make_show(tmp_path)
    assert run(root, "s02e01", "--", "x").returncode != 0
    assert run(root, "s02e01", "--message", "m").returncode != 0


# ── beyond the brief: the two pipeline situations the script exists to survive ────────────────

def test_a_second_run_of_one_commit_step_does_not_commit_twice(tmp_path):
    """A commit step declares no `inputs`, so `runScriptStep` never serves it from cache
    (`engine/src/runner.ts`): a resumed run after a crash between `git commit` and the log write
    spawns this script again with the same message and the same paths. The second run must find
    the index equal to HEAD and skip."""
    root = make_show(tmp_path)
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "outline.md").write_text("o\n")
    first = run(root, "s02e01", "--message", "s02e01: outline + script (write phase)", "--", "Episodes/s02e01")
    assert first.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")
    second = run(root, "s02e01", "--message", "s02e01: outline + script (write phase)", "--", "Episodes/s02e01")
    assert second.returncode == 0, second.stderr
    assert second.stdout.strip().splitlines()[-1] == "COMMIT_SKIPPED nothing staged"
    count = subprocess.run(["git", "rev-list", "--count", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
    assert count == "2", "the init commit plus one — not two commits for one step"

def test_a_listed_path_that_does_not_exist_is_passed_over_not_refused(tmp_path):
    """`canon-commit` lists `Episodes/<ep>/canon-ledger.md`, which an episode with no deliberate
    deviations never has. Staging a never-tracked missing pathspec makes git exit 128; the step
    must still commit the paths that do exist."""
    root = make_show(tmp_path)
    (root / "Canon").mkdir()
    (root / "Canon" / "timeline.md").write_text("t\n")
    r = run(root, "s02e01", "--message", "canon: absorb s02e01 (canon phase)",
            "--", "Canon", "Episodes/s02e01/canon-ledger.md")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")
    files = subprocess.run(["git", "show", "--name-only", "--format=", "HEAD"], cwd=root, capture_output=True, text=True).stdout
    assert "Canon/timeline.md" in files

def test_a_deletion_under_a_listed_path_is_staged_too(tmp_path):
    """`git add -A -- <path>`, not `git add <path>`: a file the pipeline removed under a listed
    directory has to leave the tree in the same commit, or the next step's `git status` is dirty."""
    root = make_show(tmp_path)
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "outline.md").write_text("o\n")
    run(root, "s02e01", "--message", "first", "--", "Episodes/s02e01")
    os.remove(root / "Episodes" / "s02e01" / "outline.md")
    r = run(root, "s02e01", "--message", "second", "--", "Episodes/s02e01")
    assert r.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")
    assert subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True).stdout == ""

def test_an_ignored_path_is_skipped_and_the_real_one_is_still_committed(tmp_path):
    """`assemble-commit` used to list `Production/<ep>/video/timeline.json`, which the first
    show's .gitignore covers with `Production/*/video/`. `git add -A -- <ignored path>` exits 1
    and would fail the step after the render, the master and the final gate. The step must stage
    what it can and say what it passed over."""
    root = make_show(tmp_path)
    (root / ".gitignore").write_text("Production/*/video/\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "ignore rules"], cwd=root, check=True)
    (root / "Production" / "s02e01" / "video").mkdir(parents=True)
    (root / "Production" / "s02e01" / "video" / "timeline.json").write_text("{}\n")
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "STATUS.md").write_text("status\n")
    r = run(root, "s02e01", "--message", "s02e01: assembled + finalized (assemble phase)",
            "--", "Production/s02e01/video/timeline.json", "Episodes/s02e01/STATUS.md")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.strip().splitlines()
    assert "skip Production/s02e01/video/timeline.json (ignored)" in lines
    assert lines[-1].startswith("COMMIT_OK ")
    files = subprocess.run(["git", "show", "--name-only", "--format=", "HEAD"], cwd=root, capture_output=True, text=True).stdout
    assert "Episodes/s02e01/STATUS.md" in files
    assert "timeline.json" not in files

def test_every_listed_path_ignored_degrades_to_nothing_staged(tmp_path):
    """The other half of the same rule: a commit step whose whole path list meets the show's
    ignore rules reports COMMIT_SKIPPED and exits 0, rather than stopping the run."""
    root = make_show(tmp_path)
    (root / ".gitignore").write_text("Production/*/video/\n")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "ignore rules"], cwd=root, check=True)
    (root / "Production" / "s02e01" / "video").mkdir(parents=True)
    (root / "Production" / "s02e01" / "video" / "timeline.json").write_text("{}\n")
    r = run(root, "s02e01", "--message", "m", "--", "Production/s02e01/video/timeline.json")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "COMMIT_SKIPPED nothing staged"

def test_the_show_root_flag_works_from_elsewhere(tmp_path):
    root = make_show(tmp_path)
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "outline.md").write_text("o\n")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "s02e01", "--show-root", str(root),
                        "--message", "m", "--", "Episodes/s02e01"],
                       cwd=elsewhere, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")

def test_a_broken_show_config_fails_by_name_on_one_line(tmp_path):
    root = tmp_path / "show"
    root.mkdir()
    (root / "showrunner.json").write_text("{}")
    r = run(root, "s02e01", "--message", "m", "--", "Episodes/s02e01")
    assert r.returncode != 0
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("git-commit: ")
