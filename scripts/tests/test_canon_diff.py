"""canon-diff.py — what an episode changed in the show's canon, as a patch file and a result line.

The fixture is a real git repository under a temp show root, because the thing under test is the
argv `git diff` invocation and its `--` separator, not a mock of one.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "canon-diff.py"


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True,
                          check=True)


@pytest.fixture
def repo(show_root: Path) -> Path:
    """A committed show repository whose Canon/ holds one tracked file."""
    canon = show_root / "Canon"
    canon.mkdir(exist_ok=True)
    (canon / "season-1.md").write_text("| 1 | **RULED** | **\"The Lamp\"** |\n")
    (show_root / "Episodes").mkdir(exist_ok=True)
    (show_root / "Episodes" / "notes.md").write_text("not canon\n")
    _git(show_root, "init", "-q")
    _git(show_root, "config", "user.email", "test@example.com")
    _git(show_root, "config", "user.name", "Test")
    _git(show_root, "add", "-A")
    _git(show_root, "commit", "-qm", "base")
    return show_root


def _run(root: Path, episode_id: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), episode_id],
                          cwd=str(root), capture_output=True, text=True)


def test_an_unchanged_canon_prints_no_changes_and_writes_an_empty_patch(repo: Path) -> None:
    r = _run(repo, "ep01")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "NO_CHANGES"
    assert (repo / "Production/ep01/canon-diff.patch").read_text() == ""


def test_a_changed_canon_file_is_counted(repo: Path) -> None:
    (repo / "Canon" / "season-1.md").write_text(
        "| 1 | **RULED** | **\"The Lamp\"** |\n| 2 | **RULED** | **\"Slack Water\"** |\n")
    r = _run(repo, "ep01")
    assert r.returncode == 0, r.stderr
    # One file; one line added and none removed.
    assert r.stdout.strip().splitlines()[-1] == "CHANGED 1 files, 1 lines"
    patch = (repo / "Production/ep01/canon-diff.patch").read_text()
    assert "Slack Water" in patch and patch.startswith("diff --git ")


def test_a_change_outside_the_canon_directory_is_not_counted(repo: Path) -> None:
    """The pathspec is the show's canonDir, so an edit anywhere else is invisible here."""
    (repo / "Episodes" / "notes.md").write_text("edited\n")
    r = _run(repo, "ep01")
    assert r.stdout.strip().splitlines()[-1] == "NO_CHANGES"


def test_the_patch_is_written_where_the_prompt_is_told_to_read_it(repo: Path) -> None:
    (repo / "Canon" / "season-1.md").write_text("replaced\n")
    _run(repo, "ep04")
    assert (repo / "Production/ep04/canon-diff.patch").exists()


def test_summarize_counts_files_and_body_lines_only() -> None:
    """The +++/--- file headers are not body lines; counting them would add two per file."""
    mod = load_script("canon-diff.py")
    patch = (
        "diff --git a/Canon/a.md b/Canon/a.md\n"
        "--- a/Canon/a.md\n+++ b/Canon/a.md\n@@ -1 +1,2 @@\n one\n+two\n"
        "diff --git a/Canon/b.md b/Canon/b.md\n"
        "--- a/Canon/b.md\n+++ b/Canon/b.md\n@@ -1,2 +1 @@\n one\n-gone\n"
    )
    assert mod.summarize(patch) == (2, 2)


def test_the_git_command_is_an_argv_list_with_a_pathspec_separator(monkeypatch) -> None:
    """A shell string would break on a canon directory with a space, and without `--` a branch
    sharing the directory's name makes `git diff Canon` ambiguous.

    `subprocess` is one module object shared by the whole test process, so the recorder goes in
    through monkeypatch and comes back out at the end of this test; assigning it outright would
    leave every later test in the session running against the fake.
    """
    mod = load_script("canon-diff.py")
    seen: dict[str, object] = {}

    def fake_run(argv, **kwargs):
        seen["argv"] = argv
        seen["kwargs"] = kwargs
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    mod.git_diff("Canon", "/show")
    assert seen["argv"] == ["git", "diff", "--", "Canon"]
    assert "shell" not in seen["kwargs"]


def test_outside_a_git_repository_the_failure_is_one_line(show_root: Path) -> None:
    r = _run(show_root, "ep01")
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("canon-diff: git diff failed")
