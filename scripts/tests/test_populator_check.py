"""populator-check.py — the pre-flight guard run as a step of its own.

Two prompts.json fixtures carry it: one whose character briefs are clean, one whose are not.
The distinction the test pins hardest is the exit code — 2 for a dirty brief, 1 for a broken
config — because the pipeline reads them differently and the operator fixes different files.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "populator-check.py"


def _episode(show_root: Path, episode_id: str, shots: list[dict]) -> None:
    base = show_root / "Production" / episode_id / "images"
    base.mkdir(parents=True, exist_ok=True)
    (base / "prompts.json").write_text(json.dumps({"shots": shots}))


def _run(show_root: Path, episode_id: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), episode_id],
                          cwd=str(show_root), capture_output=True, text=True)


CLEAN = [
    {"id": "s1-maeve", "type": "character",
     "brief": "MAEVE alone at the lamp, no other figures in the frame."},
    {"id": "s2-table", "type": "character",
     "brief": "Three people at the table: MAEVE, the harbourmaster, and the boy."},
    {"id": "s3-sea", "type": "ambient", "brief": "grey sea horizon, a crowd of gulls"},
]

DIRTY = [
    {"id": "s1-maeve", "type": "character", "brief": "MAEVE and the crew at the winch."},
    {"id": "s2-quay", "type": "character", "brief": "A crowd on the quay, waiting."},
    {"id": "s3-clean", "type": "character", "brief": "MAEVE alone."},
]


def test_a_clean_episode_prints_the_result_line_and_exits_zero(show_root: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    r = _run(show_root, "ep01")
    assert r.returncode == 0, r.stderr
    # Two character shots; the ambient shot is not a character brief and is not counted.
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_OK 2 briefs"


def test_an_ambient_brief_is_never_judged(show_root: Path) -> None:
    """The ambient shot in CLEAN says "a crowd of gulls" — a banned phrase in a brief the law
    does not govern. Only type:"character" briefs invent uncredited people."""
    _episode(show_root, "ep01", CLEAN)
    assert _run(show_root, "ep01").returncode == 0


def test_a_dirty_episode_exits_two_and_names_every_offending_shot(show_root: Path) -> None:
    _episode(show_root, "ep01", DIRTY)
    r = _run(show_root, "ep01")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "s1-maeve: matched the crew" in r.stderr
    assert "s2-quay: matched A crowd" in r.stderr
    assert "s3-clean" not in r.stderr
    assert "POPULATORS_OK" not in r.stdout


def test_a_dirty_episode_names_the_shows_style_document(show_root: Path) -> None:
    _episode(show_root, "ep01", DIRTY)
    r = _run(show_root, "ep01")
    assert "Canon/visual-style.md" in r.stderr


def test_progress_reports_one_unit_per_brief(show_root: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    lines = [l for l in _run(show_root, "ep01").stdout.splitlines() if l.startswith("::progress")]
    assert [json.loads(l[len("::progress "):]) for l in lines] == [
        {"done": 1, "total": 2, "unit": "briefs"},
        {"done": 2, "total": 2, "unit": "briefs"},
    ]


def test_a_broken_config_exits_one_not_two(show_root: Path) -> None:
    """Exit 2 means "the briefs are wrong"; a config fault must not borrow that code."""
    _episode(show_root, "ep01", CLEAN)
    cfg = json.loads((show_root / "showrunner.json").read_text())
    del cfg["visual"]["collectivePopulatorBans"]
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    r = _run(show_root, "ep01")
    assert r.returncode == 1
    assert "visual.collectivePopulatorBans is missing" in r.stderr
    assert len(r.stderr.strip().splitlines()) == 1


def test_a_missing_prompts_file_is_one_line_on_stderr(show_root: Path) -> None:
    r = _run(show_root, "ep07")
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("populator-check: ")


def test_the_show_root_flag_works_from_elsewhere(show_root: Path, tmp_path: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01", f"--show-root={show_root}"],
                       cwd=str(elsewhere), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_OK 2 briefs"
