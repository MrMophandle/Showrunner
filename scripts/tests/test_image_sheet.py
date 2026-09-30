"""image-sheet.py — the shot list at a glance, with the show's prompt scaffolding stripped.

Every ambient prompt a show writes opens with one of a few standing phrases and closes with a
standing exposure clause. Those phrases were a pair of regexes in the script (inventory §4.1:
"this show's prompt house style baked into a regex"); they are now visual.ambientPromptScaffold.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "image-sheet.py"


def _subject(scaffold, prompt: str) -> str:
    mod = load_script("image-sheet.py")
    pre, post = mod.scaffold_patterns(scaffold)
    return mod.subject(prompt, pre, post)


def test_the_opening_scaffold_is_stripped() -> None:
    scaffold = ["lamp room glass, ", "grey sea horizon, ", "low-key but clearly exposed"]
    assert _subject(scaffold, "lamp room glass, a cracked lens") == "A cracked lens"


def test_the_closing_clause_is_stripped() -> None:
    scaffold = ["lamp room glass, ", "low-key but clearly exposed"]
    got = _subject(scaffold, "lamp room glass, a cracked lens, low-key but clearly exposed, grain")
    assert got == "A cracked lens"


def test_a_prompt_with_no_scaffolding_survives_whole() -> None:
    scaffold = ["lamp room glass, ", "low-key but clearly exposed"]
    assert _subject(scaffold, "a rope coiled on the quay") == "A rope coiled on the quay"


def test_a_single_entry_list_is_a_suffix_rule_only() -> None:
    """A show whose scaffold names only a closing clause still gets that clause stripped."""
    assert _subject(["low-key but clearly exposed"],
                    "a rope coiled, low-key but clearly exposed") == "A rope coiled"


def test_an_empty_scaffold_strips_nothing() -> None:
    assert _subject([], "lamp room glass, a cracked lens") == "Lamp room glass, a cracked lens"


@pytest.fixture
def episode(show_root: Path) -> Path:
    base = show_root / "Production" / "ep01" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s1-lamp", "type": "ambient", "prompt": "lamp room glass, a cracked lens"},
        {"id": "s2-maeve", "type": "character", "refs": ["Maeve"], "scene": "COLD OPEN",
         "brief": "MAEVE at the rail."},
    ]}))
    (base / "s1-lamp.png").write_bytes(b"png")
    return show_root


def test_the_sheet_splits_character_shots_from_engine_shots(episode: Path) -> None:
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    sheet = (episode / "Production/ep01/images/IMAGE-SHEET.md").read_text()
    assert "**1 by you** (Nano Banana), **1 by the engine**" in sheet
    assert "| ✅ | `s1-lamp.png` | A cracked lens |" in sheet
    assert "s2-maeve.png" in sheet


def test_the_sheet_names_the_shows_casting_directory_and_style_document(episode: Path) -> None:
    subprocess.run([sys.executable, str(SCRIPT), "ep01"], cwd=str(episode), capture_output=True)
    sheet = (episode / "Production/ep01/images/IMAGE-SHEET.md").read_text()
    assert "`Canon/characters/`" in sheet
    assert "Rule (visual-style.md)" in sheet


def test_the_result_line_is_last(episode: Path) -> None:
    out = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                         cwd=str(episode), capture_output=True, text=True).stdout
    assert out.strip().splitlines()[-1].startswith("IMAGE_SHEET ep01:")


# ── source: "showrunner" — the sheet says who a shot is waiting on ───────────────────────────

@pytest.fixture
def handmade_episode(show_root: Path) -> Path:
    """One character shot the showrunner makes by hand, one already in place, one ambient."""
    base = show_root / "Production" / "ep02" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s1-maeve", "type": "character", "refs": ["Maeve"], "scene": "COLD OPEN",
         "brief": "MAEVE at the rail.", "source": "showrunner"},
        {"id": "s2-pell", "type": "character", "refs": ["Pell"], "scene": "SCENE TWO",
         "brief": "PELL on the stair.", "source": "showrunner"},
        {"id": "s3-lamp", "type": "ambient", "prompt": "lamp room glass, a cracked lens",
         "source": "showrunner"},
        {"id": "s4-quay", "type": "ambient", "prompt": "grey sea horizon, a rope coiled"},
    ]}))
    (base / "s2-pell.png").write_bytes(b"png")
    return show_root


def _sheet(root: Path) -> str:
    r = subprocess.run([sys.executable, str(SCRIPT), "ep02"],
                       cwd=str(root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return (root / "Production/ep02/images/IMAGE-SHEET.md").read_text()


def test_a_showrunner_made_shot_is_marked_in_the_to_make_list(handmade_episode: Path) -> None:
    """The generators skip a `source: "showrunner"` shot, so a missing PNG is work waiting on a
    person rather than a render that failed. The sheet is where the showrunner reads that."""
    line = [l for l in _sheet(handmade_episode).splitlines() if l.startswith("refs: **Maeve**")][0]
    assert "made by hand by the showrunner" in line


def test_a_showrunner_made_shot_is_marked_once_it_is_in_place(handmade_episode: Path) -> None:
    line = [l for l in _sheet(handmade_episode).splitlines() if "s2-pell.png" in l and l.startswith("- ")][0]
    assert "made by hand by the showrunner" in line


def test_a_showrunner_made_engine_shot_is_marked_in_the_table(handmade_episode: Path) -> None:
    """An ambient shot can be the showrunner's too; the engine-shots table is the other list."""
    line = [l for l in _sheet(handmade_episode).splitlines() if "`s3-lamp.png`" in l][0]
    assert "made by hand by the showrunner" in line


def test_a_shot_with_no_source_field_is_not_marked(handmade_episode: Path) -> None:
    line = [l for l in _sheet(handmade_episode).splitlines() if "`s4-quay.png`" in l][0]
    assert "made by hand by the showrunner" not in line
