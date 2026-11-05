"""shot-list-check.py — the law of the shot list (spec 2026-11-04 §2.5).

It took over on 2026-11-04 from the guard spec 2026-11-04 §2.5 says it replaces, and keeps that
guard's result contract, so these tests pin the contract as well as the rules: `--report-only`
prints the reasons and ends with one `SHOTS_BAD` line exiting 0, a bad list without the flag
exits 2, and a good list ends with `SHOTS_OK <n> shots`. The engine reads the last stdout line as
the step's result, and the image stage's fix agent reads nothing else, which is why the
`SHOTS_BAD` line carries the reasons too.

The show root is built on `tests/fixtures/showrunner.json` (the conftest `show_root` fixture) rather
than on a config written here, because `lib/showconfig.py:54-63` requires showSlug, promptsDir,
models.medium/large/writer, airMap and output.nasRoot of every config it loads; a hand-written
minimal config fails in `sc.load` before any rule of this lint is reached.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "shot-list-check.py"
SCRIPT_TEXT = "## COLD OPEN\n\nVale woke.\n\n## SCENE TWO — THE QUAY\n\nThe quay.\n\n## SCENE THREE — THE LAMP ROOM\n\nThe lamp.\n"
INDEX = {"version": 1, "audio": {"engine": "qwen3"}, "cast": {
    "vale": {"name": "Vale", "kind": "human", "speaks": True, "debut": "s01e01",
             "face": {"ref": "Canon/characters/Vale/reference.png", "gallery": [], "locked": "test"}},
    "the-warden": {"name": "the Warden", "kind": "human", "speaks": True, "debut": "s01e01"},
    "gull-folk": {"name": "Gull-folk", "kind": "species", "speaks": False, "debut": "s01e01"},
}}


@pytest.fixture
def show(show_root: Path) -> Path:
    """The fixture show plus one episode: a three-scene script and an empty images directory."""
    (show_root / "Canon/characters/Vale").mkdir(parents=True)
    (show_root / "Canon/characters/Vale/reference.png").write_bytes(b"png")
    (show_root / "Canon/cast.json").write_text(json.dumps(INDEX))
    (show_root / "Episodes/s01e02").mkdir(parents=True)
    (show_root / "Episodes/s01e02/script.md").write_text(SCRIPT_TEXT)
    (show_root / "Production/s01e02/images").mkdir(parents=True)
    return show_root


def shot(n: int, brief: str = "the quay at dawn, wet stone, one lamp lit", **extra) -> dict:
    scene = ["COLD OPEN", "SCENE TWO — THE QUAY", "SCENE THREE — THE LAMP ROOM"][n - 1]
    return {"id": f"s{n}-establishing", "scene": scene, "type": "establishing", "source": "pipeline",
            "brief": brief, "width": 1024, "height": 576, **extra}


def write(show: Path, shots: list[dict]) -> None:
    (show / "Production/s01e02/images/prompts.json").write_text(json.dumps({"episode": "s01e02", "shots": shots}))


def run(show: Path, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "s01e02", *flags, "--show-root", str(show)],
                          capture_output=True, text=True)


def test_a_good_list_is_ok_and_the_tag_is_last(show):
    write(show, [shot(1), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "SHOTS_OK 3 shots"


def test_a_missing_scene_is_bad(show):
    write(show, [shot(1), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "SCENE TWO — THE QUAY: no establishing shot (expected s2-establishing)" in r.stderr


def test_two_shots_for_one_scene_and_a_scene_the_script_lacks_are_bad(show):
    write(show, [shot(1), shot(2), shot(2), {**shot(3), "id": "s4-establishing", "scene": "SCENE FOUR — NOWHERE"}])
    r = run(show)
    assert r.returncode == 2
    assert "s2-establishing: a second establishing shot for SCENE TWO — THE QUAY" in r.stderr
    assert "s4-establishing: the script has no scene SCENE FOUR — NOWHERE" in r.stderr


def test_a_cast_name_or_a_species_in_an_establishing_brief_is_bad(show):
    write(show, [shot(1, "Vale at the quay"), shot(2, "the warden's lamp room"), shot(3, "gull-folk on the roofs")])
    r = run(show)
    assert r.returncode == 2
    assert "s1-establishing: names Vale (cast key vale)" in r.stderr
    assert "s2-establishing: names the Warden (cast key the-warden)" in r.stderr
    assert "s3-establishing: names Gull-folk (species, cast key gull-folk)" in r.stderr


def test_the_leftover_local_keys_are_bad(show):
    write(show, [shot(1, prompt="x", seed=7), shot(2), shot(3)])
    r = run(show)
    assert "s1-establishing: has prompt, seed — the local renderer is gone; write a brief" in r.stderr


def test_a_character_shot_needs_refs_with_a_face_on_disk(show):
    extra = {"id": "s2-vale-at-the-rail", "scene": "SCENE TWO — THE QUAY", "type": "character", "source": "pipeline",
             "brief": "Vale at the rail", "refs": ["vale"], "width": 1024, "height": 576}
    write(show, [shot(1), shot(2), extra, shot(3)])
    assert run(show).returncode == 0
    extra["refs"] = ["the-warden"]
    write(show, [shot(1), shot(2), extra, shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "s2-vale-at-the-rail: ref the-warden has no reference image (cast the face, or set source to showrunner)" in r.stderr
    extra["refs"] = []
    write(show, [shot(1), shot(2), extra, shot(3)])
    assert "s2-vale-at-the-rail: a character shot with no refs" in run(show).stderr


def test_report_only_prints_the_tag_and_exits_zero(show):
    write(show, [shot(1), shot(3)])
    r = run(show, "--report-only")
    assert r.returncode == 0
    last = r.stdout.strip().splitlines()[-1]
    assert last.startswith("SHOTS_BAD 1 shots: s2-establishing")
    assert "SCENE TWO — THE QUAY: no establishing shot (expected s2-establishing)" in last


def test_the_bad_tag_carries_every_reason_after_the_ids(show):
    """The fix agent reads only the step's result, which is the last stdout line, so the ids are
    followed by ` — ` and every reason joined by `; ` (the controller's ruling of 2026-11-04)."""
    write(show, [shot(1, "Vale at the quay"), shot(3)])
    last = run(show, "--report-only").stdout.strip().splitlines()[-1]
    assert last == ("SHOTS_BAD 2 shots: s1-establishing, s2-establishing — "
                    "s1-establishing: names Vale (cast key vale); "
                    "SCENE TWO — THE QUAY: no establishing shot (expected s2-establishing)")


def test_progress_is_reported_per_shot(show):
    write(show, [shot(1), shot(2), shot(3)])
    out = run(show).stdout
    assert '::progress {"done": 3, "total": 3, "unit": "shots"}' in out
