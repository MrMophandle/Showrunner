"""season-status.py — the deterministic board, reading the one airMap every script shares.

F-14: the air map used to be regex-parsed out of finalize-video.py's source, so the board and the
finalizer could disagree about which rows existed. Both now read showrunner.json.

F-10: a status cell carrying its own ruling history still parses as RULED. That is the assertion
the brief names, and the one that once dropped a finale from every board.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "season-status.py"


@pytest.fixture
def board_root(show_root: Path) -> Path:
    """A show with one ruled season-1 row whose status cell carries a rewrite note."""
    canon = show_root / "Canon"
    canon.mkdir(exist_ok=True)
    (canon / "season-1.md").write_text(
        "| Air | Status | Title |\n|---|---|---|\n"
        '| 1 | **RULED — REWRITTEN 2026-08-27** | **"Slack Water"** — the pilot. |\n')
    ep = show_root / "Episodes" / "ep01"
    ep.mkdir(parents=True)
    (ep / "STATUS.md").write_text("# STATUS — ep01\n\n- 2026-09-01 script: script.md\n")
    return show_root


def _run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          cwd=str(root), capture_output=True, text=True)


def test_a_lenient_ruled_row_is_listed(board_root: Path) -> None:
    r = _run(board_root)
    assert r.returncode == 0, r.stderr
    assert "| E1 | ep01 | Slack Water |" in r.stdout


def test_the_rows_milestone_becomes_its_state(board_root: Path) -> None:
    out = _run(board_root).stdout
    assert "| script |" in out
    assert "produce-assets" in out


def test_the_json_board_carries_the_same_row(board_root: Path) -> None:
    doc = json.loads(_run(board_root, "--json").stdout)
    assert [e["prod"] for e in doc["episodes"]] == ["ep01"]
    assert doc["episodes"][0]["title"] == "Slack Water"


def test_the_air_map_comes_from_config_not_from_another_scripts_source(
        board_root: Path) -> None:
    """F-14. An airMap entry that places a differently-numbered production id at row 1 must
    change the board, which proves the board is reading showrunner.json."""
    cfg = json.loads((board_root / "showrunner.json").read_text())
    cfg["airMap"] = {"ep42": [1, 1]}
    (board_root / "showrunner.json").write_text(json.dumps(cfg))
    assert "| E1 | ep42 |" in _run(board_root).stdout


def test_an_unmapped_row_falls_back_to_its_default_production_id(board_root: Path) -> None:
    cfg = json.loads((board_root / "showrunner.json").read_text())
    cfg["airMap"] = {}
    (board_root / "showrunner.json").write_text(json.dumps(cfg))
    assert "| E1 | ep01 |" in _run(board_root).stdout


def test_an_absent_nas_is_unknown_rather_than_a_failure(board_root: Path) -> None:
    """The NAS needs remounting by hand after every reboot, so this path is walked often."""
    (board_root / "Episodes/ep01/STATUS.md").write_text(
        "# STATUS — ep01\n\n- 2026-09-01 finalized: to the NAS\n")
    r = _run(board_root)
    assert r.returncode == 0
    assert "unknown (NAS unmounted)" in r.stdout
    assert "SEASON_STATUS_PARTIAL" in r.stdout


def test_a_final_on_the_nas_is_found_under_the_configured_name(board_root: Path,
                                                               tmp_path: Path) -> None:
    nas = tmp_path / "nas"
    nas.mkdir()
    (nas / "HarborLights S01E01.mp4").write_bytes(b"mp4")
    cfg = json.loads((board_root / "showrunner.json").read_text())
    cfg["output"]["nasRoot"] = str(nas)
    (board_root / "showrunner.json").write_text(json.dumps(cfg))
    (board_root / "Episodes/ep01/STATUS.md").write_text(
        "# STATUS — ep01\n\n- 2026-09-01 finalized: to the NAS\n")
    out = _run(board_root).stdout
    assert "FINAL on NAS" in out
    assert "SEASON_STATUS_OK" in out


def test_a_missing_season_document_is_reported_not_raised(show_root: Path) -> None:
    r = _run(show_root, "s3")
    assert r.returncode == 0
    assert "SEASON_STATUS_PARTIAL" in r.stdout
    assert "season-3.md unreadable" in r.stdout


def test_the_strict_grammar_would_have_dropped_the_row() -> None:
    """The regression F-10 records, pinned directly on the parser."""
    mod = load_script("season-status.py")
    rows = mod.parse_season_table(
        '| 1 | **RULED — REWRITTEN 2026-08-27** | **"Slack Water"** |\n')
    assert rows == [{"air": 1, "title": "Slack Water"}]


def test_losing_the_bold_markers_still_parses_to_nothing() -> None:
    """Format drift must be visible as an empty board, not absorbed silently."""
    mod = load_script("season-status.py")
    assert mod.parse_season_table('| 1 | RULED | "Slack Water" |\n') == []


def test_a_malformed_airmap_entry_is_skipped_rather_than_fatal() -> None:
    """The board is read-only and reports problems; it must not refuse to draw."""
    mod = load_script("season-status.py")
    cfg = {"airMap": {"ep01": [1, 1], "ep02": "not-a-slot", "ep03": [2, 3]}}
    assert mod.air_map_for_season(cfg, 1) == {1: "ep01"}
