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
