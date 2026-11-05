"""image-sheet.py — the shot list at a glance, as one table in shot order.

Until 2026-11-04 the sheet split the shots by who rendered them and stripped the show's standing
prompt phrases (a config key spec 2026-11-04 §5 deletes) out of the prompts of the renderer that
ran on Ryan's machine. Both are gone with that renderer (spec 2026-11-04 §3.2): every image comes
from nano-banana, every shot carries a
`brief`, and the one distinction left on a row is its `state` — rendered, missing, by hand and in
place, or by hand and still waiting on the showrunner (spec 2026-11-04 §4's sheet row).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "image-sheet.py"


@pytest.fixture
def episode(show_root: Path) -> Path:
    """Four shots, one of each state: rendered, missing, by hand and in place, by hand and waiting."""
    base = show_root / "Production" / "ep01" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"episode": "ep01", "shots": [
        {"id": "s1-establishing", "scene": "COLD OPEN", "type": "establishing",
         "source": "pipeline", "brief": "the lamp room at first light, a cracked lens"},
        {"id": "s2-establishing", "scene": "SCENE TWO — THE QUAY", "type": "establishing",
         "source": "pipeline", "brief": "the quay under grey sea horizon, a rope coiled"},
        {"id": "s3-maeve", "scene": "SCENE TWO — THE QUAY", "type": "character",
         "source": "showrunner", "refs": ["maeve"], "brief": "Maeve at the rail."},
        {"id": "s4-pell", "scene": "SCENE THREE — THE STAIR", "type": "character",
         "source": "showrunner", "refs": ["pell"], "brief": "Pell on the stair."},
    ]}))
    (base / "s1-establishing.png").write_bytes(b"png")
    (base / "s3-maeve.png").write_bytes(b"png")
    return show_root


def _sheet(root: Path, ep: str = "ep01") -> str:
    r = subprocess.run([sys.executable, str(SCRIPT), ep],
                       cwd=str(root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return (root / f"Production/{ep}/images/IMAGE-SHEET.md").read_text()


def _rows(sheet: str) -> list[str]:
    """The table's shot rows: everything after the header separator, header row excluded."""
    lines = sheet.splitlines()
    at = lines.index("|---|---|---|---|")
    return [l for l in lines[at + 1:] if l.startswith("|")]


def test_the_sheet_lists_every_shot_in_order_with_its_state(episode: Path) -> None:
    assert _rows(_sheet(episode)) == [
        "| s1-establishing | COLD OPEN | rendered | the lamp room at first light, a cracked lens |",
        "| s2-establishing | SCENE TWO — THE QUAY | missing | the quay under grey sea horizon, a rope coiled |",
        "| s3-maeve | SCENE TWO — THE QUAY | by hand — in place | Maeve at the rail. |",
        "| s4-pell | SCENE THREE — THE STAIR | by hand — MISSING: drop `s4-pell.png` "
        "into Production/ep01/images | Pell on the stair. |",
    ]


def test_the_sheet_counts_the_images_and_the_handmade_ones_at_the_top(episode: Path) -> None:
    assert "**4 images** — one establishing shot per scene; 2 by hand (showrunner-made)." in _sheet(episode)


def test_the_result_line_counts_by_hand_and_missing(episode: Path) -> None:
    out = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                         cwd=str(episode), capture_output=True, text=True).stdout
    assert out.strip().splitlines()[-1] == "SHEET_OK 4 shots (2 by hand, 2 missing)"


def test_the_result_line_is_last_and_the_path_is_printed_above_it(episode: Path) -> None:
    """The engine reads the last stdout line as the step's result; the operator still needs the
    path, so it is printed on the line before rather than folded into the result."""
    lines = subprocess.run([sys.executable, str(SCRIPT), "ep01"], cwd=str(episode),
                           capture_output=True, text=True).stdout.strip().splitlines()
    assert lines[-1].startswith("SHEET_OK ")
    assert lines[-2] == "sheet: Production/ep01/images/IMAGE-SHEET.md"


# ── source: "showrunner" — the sheet says who a shot is waiting on ───────────────────────────

def test_a_showrunner_made_shot_still_waiting_names_the_file_and_the_directory(episode: Path) -> None:
    """Nothing renders a `source: "showrunner"` shot, so its missing PNG is work waiting on a
    person rather than a render that failed. The sheet is where the showrunner reads that, and the
    cell carries the two facts he needs: the exact filename, and where to drop it."""
    row = [l for l in _sheet(episode).splitlines() if l.startswith("| s4-pell ")][0]
    assert "by hand — MISSING: drop `s4-pell.png` into Production/ep01/images" in row


def test_a_showrunner_made_shot_is_marked_once_it_is_in_place(episode: Path) -> None:
    row = [l for l in _sheet(episode).splitlines() if l.startswith("| s3-maeve ")][0]
    assert "| by hand — in place |" in row


def test_a_pipeline_shot_is_never_marked_by_hand(episode: Path) -> None:
    rows = [l for l in _sheet(episode).splitlines() if l.startswith("| s1-") or l.startswith("| s2-")]
    assert all("by hand" not in row for row in rows)


def test_a_shot_with_no_source_field_is_rendered_or_missing(show_root: Path) -> None:
    """`source` is optional and defaults to pipeline, as it does for the renderer and the lint."""
    base = show_root / "Production" / "ep02" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"episode": "ep02", "shots": [
        {"id": "s1-establishing", "scene": "COLD OPEN", "type": "establishing",
         "brief": "the harbor at dusk"},
    ]}))
    row = [l for l in _sheet(show_root, "ep02").splitlines() if l.startswith("| s1-")][0]
    assert "| missing |" in row and "by hand" not in row


def test_a_brief_longer_than_the_column_is_cut_short(show_root: Path) -> None:
    base = show_root / "Production" / "ep02" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"episode": "ep02", "shots": [
        {"id": "s1-establishing", "scene": "COLD OPEN", "type": "establishing",
         "brief": "the quay " + "wet stone and rope " * 20},
    ]}))
    row = [l for l in _sheet(show_root, "ep02").splitlines() if l.startswith("| s1-")][0]
    assert row.endswith(" … |")
    assert len(row) < 200
