"""publish-kit.py — the upload sheet, with the teaser read from the episode's own publish.json.

The LOGLINE dictionary is gone (inventory §4.1: ten multi-paragraph teasers, the single largest
block of show data living in a script). Its replacement is a per-episode file, and a missing one
is an error naming that file rather than a placeholder paragraph that ships.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "publish-kit.py"

LOGLINE = ("A lamp keeper counts the nights. The sea has never once cared whether "
           "the light is lit.")


@pytest.fixture
def episode(show_root: Path) -> Path:
    base = show_root / "Production" / "ep01"
    (base / "audio").mkdir(parents=True)
    (base / "audio" / "manifest.json").write_text(json.dumps({"segments": [
        {"i": 1, "gap_before": 0.0, "duration_s": 3.0},
        {"i": 2, "gap_before": 0.5, "duration_s": 2.0},
    ]}))
    (base / "tts-script.json").write_text(json.dumps({"segments": [
        {"i": 1, "speaker": "narrator", "text": "The lamp room was cold that morning."},
        {"i": 2, "speaker": "narrator", "text": "Nobody came up the stairs."},
    ]}))
    ep_dir = show_root / "Episodes" / "ep01"
    ep_dir.mkdir(parents=True)
    (ep_dir / "script.md").write_text(
        '# ep01 — "Slack Water"\n\n## COLD OPEN — the lamp\n\n'
        '"The lamp room was cold that morning."\n\n'
        '## SCENE TWO — the stair\n\n"Nobody came up the stairs."\n')
    (ep_dir / "publish.json").write_text(json.dumps({"logline": LOGLINE}))
    return show_root


def _run(root: Path, episode_id: str = "ep01") -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), episode_id],
                          cwd=str(root), capture_output=True, text=True)


def _sheet(root: Path) -> str:
    return (root / "Production/ep01/publish/upload.md").read_text()


def test_the_title_carries_the_shows_name_and_air_slug(episode: Path) -> None:
    r = _run(episode)
    assert r.returncode == 0, r.stderr
    assert "Harbor Lights — S01E01: Slack Water" in _sheet(episode)


def test_the_description_carries_the_episodes_logline(episode: Path) -> None:
    _run(episode)
    assert LOGLINE in _sheet(episode)


def test_the_standing_copy_comes_from_config(episode: Path) -> None:
    _run(episode)
    sheet = _sheet(episode)
    assert "New episodes weekly. Self-contained stories on one stretch of coast." in sheet
    assert "A human dreamed up this world and rules every frame of it." in sheet
    assert "Harbor Lights Season 1" in sheet
    assert "audio drama, coastal fiction, lighthouse, narrated fiction" in sheet


def test_a_missing_publish_json_is_a_clear_error_naming_the_file(episode: Path) -> None:
    (episode / "Episodes/ep01/publish.json").unlink()
    r = _run(episode)
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert "Episodes/ep01/publish.json" in r.stderr
    assert "logline" in r.stderr
    # Nothing is written when the teaser is missing: the old placeholder shipped ten times.
    assert not (episode / "Production/ep01/publish/upload.md").exists()


def test_a_publish_json_without_a_logline_is_the_same_error(episode: Path) -> None:
    (episode / "Episodes/ep01/publish.json").write_text(json.dumps({"notes": "later"}))
    r = _run(episode)
    assert r.returncode == 1
    assert "logline" in r.stderr


def test_the_placeholder_reminder_still_prints(episode: Path) -> None:
    """F-17: the credit name is carried into config as the placeholder it has always been."""
    out = _run(episode).stdout
    assert "NOTE: set publish.channelName" in out


def test_the_reminder_goes_away_once_the_name_is_set(episode: Path) -> None:
    cfg = json.loads((episode / "showrunner.json").read_text())
    cfg["publish"]["channelName"] = "A Real Name"
    (episode / "showrunner.json").write_text(json.dumps(cfg))
    out = _run(episode).stdout
    assert "NOTE: set publish.channelName" not in out


def test_the_result_line_is_last(episode: Path) -> None:
    """The reminder used to come after the summary, so a gate reading the last line got the
    reminder instead of the result."""
    last = _run(episode).stdout.strip().splitlines()[-1]
    assert last.startswith("PUBLISH_KIT S01E01 -> Production/ep01/publish/upload.md")


def test_captions_are_numbered_from_one_and_timed_from_the_manifest(episode: Path) -> None:
    _run(episode)
    srt = (episode / "Production/ep01/publish/captions.srt").read_text()
    assert srt.startswith("1\n00:00:00,000 --> 00:00:03,000\n")
    assert "\n2\n00:00:03,500 --> 00:00:05,500\n" in srt


def test_chapters_accumulate_gap_and_duration(episode: Path) -> None:
    _run(episode)
    sheet = _sheet(episode)
    assert "0:00 the lamp" in sheet
    assert "0:03 the stair" in sheet
