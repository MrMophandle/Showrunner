"""lib/populators.py — the collective-populator grammar, against the fixture show's ban list.

Three briefs carry the whole law, and they are the three the guard exists to tell apart:
a crowd nobody named is a violation, a headcount that names its cast is not, and the capping
idiom ("no other figures in the frame") is not — it NEGATES extras rather than inventing them,
which is the strongest statement of the very rule this guard enforces.
"""

from __future__ import annotations

import json
from pathlib import Path

from lib import populators


def _bans(show_root: Path) -> list[str]:
    """The fixture show's visual.collectivePopulatorBans, read the way a script reads it."""
    cfg = json.loads((show_root / "showrunner.json").read_text())
    return cfg["visual"]["collectivePopulatorBans"]


def test_a_crowd_nobody_named_is_flagged(show_root: Path) -> None:
    brief = "MAEVE at the rail, a crowd of dockhands behind her in the sodium light."
    hits = populators.find_collective_populators(brief, _bans(show_root))
    assert hits == ["a crowd"], hits


def test_a_named_headcount_is_clean(show_root: Path) -> None:
    brief = ("At a scarred table sit three people: MAEVE, the harbourmaster, and the boy "
             "who found the light.")
    assert populators.find_collective_populators(brief, _bans(show_root)) == []


def test_the_capping_idiom_is_clean(show_root: Path) -> None:
    """The house-style cap is the rule stated, not broken: it must not be flagged.

    `_NO_ESCAPE` exists for exactly this sentence. A brief that says "no other background
    figures" is telling the model to draw nobody extra, which is what the law asks for.
    """
    brief = "MAEVE alone on the pier — no other background figures anywhere in the frame."
    assert populators.find_collective_populators(brief, _bans(show_root)) == []


def test_the_ban_list_is_the_shows_not_the_engines(show_root: Path) -> None:
    """A phrase this show does not ban passes; the same phrase banned elsewhere would not."""
    brief = "MAEVE watching the onlookers gather."
    assert populators.find_collective_populators(brief, _bans(show_root)) == []
    assert populators.find_collective_populators(brief, ["onlookers"]) == ["onlookers"]


def test_a_bare_noun_without_a_headcount_is_flagged(show_root: Path) -> None:
    """"people" and "figures" are generic English, so the grammar judges them, not the config."""
    brief = "MAEVE at the rail; people move behind her."
    assert populators.find_collective_populators(brief, _bans(show_root)) == ["people"]


def test_matches_are_returned_verbatim_in_their_original_case(show_root: Path) -> None:
    brief = "A Crowd presses against the gate."
    assert populators.find_collective_populators(brief, _bans(show_root)) == ["A Crowd"]


def test_violations_reports_only_the_dirty_shots(show_root: Path) -> None:
    shots = [
        {"id": "s1-clean", "brief": "MAEVE alone, no other figures in frame."},
        {"id": "s2-dirty", "brief": "MAEVE and the crew at the winch."},
        {"id": "s3-dirty", "brief": "A crowd on the quay."},
    ]
    found = populators.violations(shots, _bans(show_root))
    assert [sid for sid, _ in found] == ["s2-dirty", "s3-dirty"]
    assert populators.report_lines(found) == [
        "  s2-dirty: matched the crew",
        "  s3-dirty: matched A crowd",
    ]
