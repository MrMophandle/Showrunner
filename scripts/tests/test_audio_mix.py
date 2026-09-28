"""audio-mix.py — the episode mix, named from show config and ending in its result line.

The two mixing tests shell out to ffmpeg (the limiter pass and the two loudnorm passes), so they
skip when ffmpeg is not on PATH. Everything they mix is half a second of synthetic tone.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from conftest import SCRIPTS_DIR, needs_ffmpeg

SCRIPT = SCRIPTS_DIR / "audio-mix.py"
SR = 24000


def _episode(show_root: Path, episode_id: str) -> Path:
    """Two half-second segments and the manifest that places them."""
    base = show_root / "Production" / episode_id / "audio"
    (base / "segments").mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SR * 0.5)) / SR
    for i, hz in ((1, 220.0), (2, 330.0)):
        sf.write(str(base / "segments" / f"{i:04d}.wav"), 0.2 * np.sin(2 * np.pi * hz * t), SR)
    manifest = {
        "episode": episode_id,
        "sr": SR,
        "segments": [
            {"i": 1, "speaker": "narrator", "duration_s": 0.5, "gap_before": 0.3},
            {"i": 2, "speaker": "Maeve", "duration_s": 0.5, "gap_before": 0.5},
        ],
    }
    (base / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


def _run(show_root: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv], cwd=show_root, capture_output=True, text=True
    )


def _lines(out: str) -> list[str]:
    return [line for line in out.splitlines() if line.strip()]


def _result(out: str) -> str:
    return [line for line in _lines(out) if not line.startswith("::progress ")][-1]


@needs_ffmpeg
def test_the_mix_is_named_from_the_shows_pattern_and_air_slot(show_root: Path) -> None:
    base = _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    # airMap places ep01 at season 1, episode 1; output.mixFilename does the naming.
    assert (base / "HarborLights S01E01.wav").exists(), sorted(p.name for p in base.iterdir())


@needs_ffmpeg
def test_the_last_line_is_the_result_the_gate_reads(show_root: Path) -> None:
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result.startswith("MIX_OK "), result
    duration, lufs, unit, path = result[len("MIX_OK "):].split(" ", 3)
    assert duration.endswith("s") and float(duration[:-1]) > 1.0
    assert (float(lufs), unit) == (-14.0, "LUFS")
    assert path.endswith("HarborLights S01E01.wav")


@needs_ffmpeg
def test_it_reports_progress_in_segments(show_root: Path) -> None:
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    progress = [line for line in _lines(done.stdout) if line.startswith("::progress ")]
    assert progress == [
        '::progress {"done": 1, "total": 2, "unit": "segments"}',
        '::progress {"done": 2, "total": 2, "unit": "segments"}',
    ]


def test_an_episode_the_air_map_does_not_place_is_named_episode_wav(show_root: Path) -> None:
    """No ffmpeg needed: the naming rule is a pure function of the show config."""
    sys.path.insert(0, str(SCRIPTS_DIR))
    from conftest import load_script

    from lib import showconfig as sc

    mix = load_script("audio-mix.py")
    cfg = sc.load(str(show_root))
    assert mix.mix_wav(cfg, "ep01") == "HarborLights S01E01.wav"
    assert mix.mix_wav(cfg, "s02e03") == "HarborLights S02E03.wav"
    assert mix.mix_wav(cfg, "ep98") == "episode.wav"


def test_a_missing_episode_id_is_refused(show_root: Path) -> None:
    done = _run(show_root)
    assert done.returncode != 0
    assert "episode id missing" in done.stderr
