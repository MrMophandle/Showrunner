"""build-timeline.py — the one file the renderer reads, written from show config.

The timeline is where F-12 lands: the title card's typography travels with its timing, so
render/ carries no show literal. These tests assert the fixture show's values reach the file,
not any particular show's.

The staging copy goes to a temp --render-root, never to the engine's own render/public: the
staging directory belongs to the engine, so a test that wrote there would dirty the repository.
"""

from __future__ import annotations

import json
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "build-timeline.py"
SR = 24000


def _wav(path: Path, seconds: float = 1.0) -> None:
    """One second of silence, written with the standard library so no codec is needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        fh.writeframes(b"\x00\x00" * int(SR * seconds))


def _png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fake")


@pytest.fixture
def episode(show_root: Path) -> Path:
    """ep01 — two segments (the first behind a title card), two shots, one scene."""
    base = show_root / "Production" / "ep01"
    (base / "audio").mkdir(parents=True)
    manifest = {"episode": "ep01", "sr": SR, "segments": [
        {"i": 1, "speaker": "narrator", "gap_before": 2.0, "duration_s": 3.0,
         "title_card_before": True},
        {"i": 2, "speaker": "narrator", "gap_before": 0.5, "duration_s": 2.0},
    ]}
    (base / "audio" / "manifest.json").write_text(json.dumps(manifest))
    (base / "tts-script.json").write_text(json.dumps({"segments": [
        {"i": 1, "speaker": "narrator", "text": "The lamp room was cold that morning."},
        {"i": 2, "speaker": "narrator", "text": "Nobody came up the stairs."},
    ]}))
    (base / "images").mkdir(parents=True)
    (base / "images" / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s01-lamp", "type": "ambient", "prompt": "lamp room glass, cold light"},
        {"id": "s01-stair", "type": "ambient", "prompt": "grey sea horizon, a stair"},
    ]}))
    for shot in ("s01-lamp", "s01-stair"):
        _png(base / "images" / f"{shot}.png")
    # audio-mix.py names the mix from output.mixFilename; ep01 is in the fixture airMap.
    _wav(base / "audio" / "HarborLights S01E01.wav")
    (show_root / "Episodes" / "ep01").mkdir(parents=True)
    (show_root / "Episodes" / "ep01" / "script.md").write_text(
        "# ep01\n\n## COLD OPEN — the lamp\n\nThe lamp room was cold that morning.\n")
    return show_root


def _run(root: Path, render_root: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "ep01", f"--render-root={render_root}", *extra],
        cwd=str(root), capture_output=True, text=True)


def _timeline(root: Path) -> dict:
    return json.loads((root / "Production/ep01/video/timeline.json").read_text())


def test_the_timeline_carries_the_fixtures_fps_and_two_shots(episode: Path,
                                                             tmp_path: Path) -> None:
    r = _run(episode, tmp_path / "public")
    assert r.returncode == 0, r.stderr
    tl = _timeline(episode)
    assert tl["fps"] == 30
    assert len(tl["shots"]) == 2


def test_the_title_card_carries_the_shows_typography(episode: Path, tmp_path: Path) -> None:
    """F-12: text, font and colours travel in the timeline beside the timing it already had."""
    _run(episode, tmp_path / "public")
    title = _timeline(episode)["title"]
    assert title["text"] == "HARBOR LIGHTS"
    assert title["fontFamily"] == "Georgia, 'Times New Roman', serif"
    assert title["colors"] == {"background": "#05070a", "type": "#d4d8b8",
                               "glow": "rgba(152, 160, 96, 0.25)", "stage": "#0f1004"}
    # Timing is still the episode's: a 2.0 s gap at the head, faded over video.titleCard.fadeSeconds.
    assert (title["from"], title["durationInFrames"], title["fadeFrames"]) == (0, 60, 60)


def test_the_frame_size_and_crossfade_come_from_config(episode: Path, tmp_path: Path) -> None:
    _run(episode, tmp_path / "public")
    tl = _timeline(episode)
    assert (tl["width"], tl["height"]) == (1024, 576)
    assert tl["crossfadeFrames"] == 30


def test_the_duration_pads_by_the_mixs_own_tail(episode: Path, tmp_path: Path) -> None:
    """audio.tailOutSeconds is the tail audio-mix.py appended; the video must match it exactly,
    or the picture and the mix stop at different moments."""
    _run(episode, tmp_path / "public")
    total_s = 2.0 + 3.0 + 0.5 + 2.0
    assert _timeline(episode)["durationInFrames"] == int(total_s * 30) + 30


def test_a_different_fps_is_honoured(episode: Path, tmp_path: Path) -> None:
    """A show may choose 24 fps (F-15), and every derived figure must follow it."""
    cfg = json.loads((episode / "showrunner.json").read_text())
    cfg["video"]["fps"] = 24
    (episode / "showrunner.json").write_text(json.dumps(cfg))
    _run(episode, tmp_path / "public")
    tl = _timeline(episode)
    assert tl["fps"] == 24
    assert tl["crossfadeFrames"] == 24
    assert tl["title"]["fadeFrames"] == 48


def test_the_assets_are_staged_under_the_render_root(episode: Path, tmp_path: Path) -> None:
    public = tmp_path / "public"
    _run(episode, public)
    assert (public / "ep01" / "audio.wav").exists()
    assert (public / "ep01" / "images" / "s01-lamp.png").exists()
    assert (public / "ep01" / "timeline.json").exists()


def test_the_render_root_never_resolves_under_the_show(episode: Path, tmp_path: Path) -> None:
    """The staging directory is the engine's, so a relative --render-root is made absolute
    BEFORE the chdir into the show root.

    The run happens from `elsewhere/`, a directory that is NOT the show root, and names its
    render root relatively. If the flag were resolved after the chdir, the assets would land
    under the show at <show>/public instead of at <elsewhere>/public.
    """
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "public").mkdir(parents=True)
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01",
                        f"--show-root={episode}", "--render-root", "public"],
                       cwd=str(elsewhere), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (elsewhere / "public" / "ep01" / "timeline.json").exists()
    assert not (episode / "public" / "ep01").exists()


def test_progress_reports_one_unit_per_staged_shot(episode: Path, tmp_path: Path) -> None:
    out = _run(episode, tmp_path / "public").stdout
    lines = [json.loads(l[len("::progress "):])
             for l in out.splitlines() if l.startswith("::progress")]
    assert lines == [{"done": 1, "total": 2, "unit": "shots"},
                     {"done": 2, "total": 2, "unit": "shots"}]


def test_the_result_line_is_last(episode: Path, tmp_path: Path) -> None:
    out = _run(episode, tmp_path / "public").stdout
    last = [l for l in out.strip().splitlines() if not l.startswith("::progress")][-1]
    assert last.startswith("TIMELINE_OK 2 shots")


def test_a_missing_config_key_fails_by_name_in_one_line(episode: Path, tmp_path: Path) -> None:
    cfg = json.loads((episode / "showrunner.json").read_text())
    del cfg["video"]["titleCard"]["text"]
    (episode / "showrunner.json").write_text(json.dumps(cfg))
    r = _run(episode, tmp_path / "public")
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert "video.titleCard.text is missing" in r.stderr
