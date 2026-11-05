"""shot-list-check.py — the law of the shot list (spec 2026-11-04 §2.5).

It took over on 2026-11-04 from the guard spec 2026-11-04 §2.5 says it replaces, and keeps that
guard's result contract, so these tests pin the contract as well as the rules: `--report-only`
prints the reasons and ends with one `SHOTS_BAD` line exiting 0, a bad list without the flag
exits 2, and a good list ends with `SHOTS_OK <n> shots`. The engine reads the last stdout line as
the step's result, and the image stage's fix agent reads nothing else, which is why the
`SHOTS_BAD` line carries the reasons too.

Rule 2 was amended on 2026-11-04 after this task's review (spec 2026-11-04 §2.5 rule 2): an
establishing brief may not name a person — an entry of kind `character`, `human`, `creature` or
`species` — but it may name a place, and a place that has a reference image must also appear in the
shot's `refs` so the render conditions on that image.

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
    # Two places, which an establishing brief MAY name (spec 2026-11-04 §2.5 rule 2, as amended
    # after this task's review). Harbor has a reference image, so naming it obliges the shot to
    # carry its key in `refs`; Lantern has none, so naming it obliges nothing.
    "harbor": {"name": "Harbor", "kind": "location", "speaks": False, "debut": "s01e01",
               "face": {"ref": "Canon/locations/Harbor/reference.png", "gallery": [], "locked": "test"}},
    "lantern": {"name": "Lantern", "kind": "ship", "speaks": False, "debut": "s01e01"},
}}


@pytest.fixture
def show(show_root: Path) -> Path:
    """The fixture show plus one episode: a three-scene script and an empty images directory."""
    (show_root / "Canon/characters/Vale").mkdir(parents=True)
    (show_root / "Canon/characters/Vale/reference.png").write_bytes(b"png")
    (show_root / "Canon/locations/Harbor").mkdir(parents=True)
    (show_root / "Canon/locations/Harbor/reference.png").write_bytes(b"png")
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


# ── rule 2 as amended 2026-11-04: a person is forbidden, a place is allowed and goes in refs ──

def test_a_place_the_brief_names_is_ok_when_its_key_is_in_refs(show):
    """An establishing shot of the harbor has to be allowed to say Harbor (spec §2.3)."""
    write(show, [shot(1, "Harbor at night, wet stone, one lamp lit", refs=["harbor"]), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "SHOTS_OK 3 shots"


def test_a_place_with_a_reference_image_must_be_in_refs(show):
    """Harbor has a reference image, so the render must condition on it rather than invent a harbor."""
    write(show, [shot(1, "Harbor at night, wet stone, one lamp lit"), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert ("s1-establishing: names Harbor (location, cast key harbor) — "
            "add it to refs so the render conditions on its reference") in r.stderr


def test_a_place_with_no_reference_image_is_not_a_reason(show):
    """Lantern is in the index with no face, so there is nothing to condition on and nothing to fix."""
    write(show, [shot(1, "the Lantern at her mooring, dawn"), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 0, r.stderr


def test_a_person_ref_on_an_establishing_shot_is_bad(show):
    write(show, [shot(1, refs=["vale"]), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "s1-establishing: ref vale is a human — a person never appears in an establishing shot" in r.stderr


def test_a_place_ref_with_no_reference_image_is_bad(show):
    """A ref names an image to condition on, so a place whose face is uncast cannot be one."""
    write(show, [shot(1, refs=["lantern"]), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert ("s1-establishing: ref lantern has no reference image "
            "(cast the face, or set source to showrunner)") in r.stderr


def test_an_unknown_ref_on_an_establishing_shot_is_bad(show):
    write(show, [shot(1, refs=["nowhere"]), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "s1-establishing: ref nowhere is not a cast-index key" in r.stderr


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
