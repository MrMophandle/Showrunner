"""shot-sheet.py — where each still lands in the episode, at the renderer's own clock.

The property the script's own docstring claims is that its timings ARE build-timeline.py's, so
the strongest test is to run both over one fixture and compare. That also exercises main() end
to end, which is what caught an `sc` shadowing bug that made the script raise before it read a
single argument.
"""

from __future__ import annotations

import json
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR

SHOT_SHEET = SCRIPTS_DIR / "shot-sheet.py"
BUILD_TIMELINE = SCRIPTS_DIR / "build-timeline.py"
SR = 24000


@pytest.fixture
def episode(show_root: Path) -> Path:
    base = show_root / "Production" / "ep01"
    (base / "audio").mkdir(parents=True)
    (base / "audio" / "manifest.json").write_text(json.dumps({"episode": "ep01", "sr": SR,
        "segments": [
            {"i": 1, "gap_before": 2.0, "duration_s": 6.0},
            {"i": 2, "gap_before": 0.5, "duration_s": 4.0},
        ]}))
    (base / "tts-script.json").write_text(json.dumps({"segments": [
        {"i": 1, "speaker": "narrator", "text": "The lamp room was cold that morning."},
        {"i": 2, "speaker": "narrator", "text": "Nobody came up the stairs."},
    ]}))
    (base / "images").mkdir(parents=True)
    (base / "images" / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s01-lamp", "type": "ambient", "prompt": "lamp room glass, a cracked lens"},
        {"id": "s01-stair", "type": "character", "refs": ["Maeve"],
         "brief": "MAEVE on the stair."},
    ]}))
    for shot in ("s01-lamp", "s01-stair"):
        (base / "images" / f"{shot}.png").write_bytes(b"png")
    with wave.open(str(base / "audio" / "HarborLights S01E01.wav"), "wb") as fh:
        fh.setnchannels(1); fh.setsampwidth(2); fh.setframerate(SR)
        fh.writeframes(b"\x00\x00" * SR)
    (show_root / "Episodes" / "ep01").mkdir(parents=True)
    (show_root / "Episodes" / "ep01" / "script.md").write_text(
        "# ep01\n\n## COLD OPEN — the lamp\n\nThe lamp room was cold that morning.\n")
    return show_root


def _sheet(episode: Path) -> str:
    r = subprocess.run([sys.executable, str(SHOT_SHEET), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return (episode / "Production/ep01/images/SHOT-SHEET.md").read_text()


def test_the_sheet_places_every_still(episode: Path) -> None:
    sheet = _sheet(episode)
    assert "### `s01-lamp`" in sheet and "### `s01-stair`" in sheet
    assert "**2 stills**" in sheet


def test_the_result_line_carries_the_shows_clock(episode: Path) -> None:
    r = subprocess.run([sys.executable, str(SHOT_SHEET), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    last = r.stdout.strip().splitlines()[-1]
    assert last.startswith("SHOT_SHEET ep01:")
    assert "30 fps, 1.0s crossfade" in last


def test_a_different_fps_reaches_the_result_line(episode: Path) -> None:
    cfg = json.loads((episode / "showrunner.json").read_text())
    cfg["video"]["fps"] = 24
    cfg["video"]["crossfadeSeconds"] = 0.5
    (episode / "showrunner.json").write_text(json.dumps(cfg))
    r = subprocess.run([sys.executable, str(SHOT_SHEET), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert "24 fps, 0.5s crossfade" in r.stdout.strip().splitlines()[-1]


def test_its_placements_match_build_timelines(episode: Path, tmp_path: Path) -> None:
    """The property the docstring claims: the times printed here are the times the render uses."""
    sheet = _sheet(episode)
    r = subprocess.run([sys.executable, str(BUILD_TIMELINE), "ep01",
                        f"--render-root={tmp_path / 'public'}"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    timeline = json.loads((episode / "Production/ep01/video/timeline.json").read_text())
    fps = timeline["fps"]

    # The sheet prints m:ss; the timeline counts frames. Compare each shot's start.
    import re
    starts = {m.group(1): m.group(2) for m in
              re.finditer(r"### `([^`]+)`\n\n\*\*On screen (\d+:\d\d) – ", sheet)}
    for shot in timeline["shots"]:
        seconds = shot["from"] / fps
        expected = f"{int(seconds) // 60}:{int(seconds) % 60:02d}"
        assert starts[shot["id"]] == expected, (shot["id"], starts[shot["id"]], expected)


def test_a_missing_input_is_named_rather_than_traced(episode: Path) -> None:
    (episode / "Production/ep01/audio/manifest.json").unlink()
    r = subprocess.run([sys.executable, str(SHOT_SHEET), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert "missing Production/ep01/audio/manifest.json" in r.stderr
