"""master-video.py — the rendered MP4 normalised BESIDE its input, never over it (F-09).

The filter-string assembly is pure and always tested. The end-to-end pass shells ffmpeg over a
one-second synthetic MP4 and skips when ffmpeg is not on PATH.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script, needs_ffmpeg

SCRIPT = SCRIPTS_DIR / "master-video.py"


def test_the_measure_pass_filter_asks_for_json() -> None:
    mod = load_script("master-video.py")
    af = mod.loudnorm_filter({"I": "-14", "TP": "-1.5", "LRA": "11"})
    assert af == "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json"


def test_the_apply_pass_filter_carries_every_measured_value() -> None:
    mod = load_script("master-video.py")
    measured = {"input_i": "-19.1", "input_tp": "-3.0", "input_lra": "4.2",
                "input_thresh": "-29.3", "target_offset": "0.4"}
    af = mod.loudnorm_filter({"I": "-14", "TP": "-1.5", "LRA": "11"}, measured)
    for fragment in ("I=-14", "measured_I=-19.1", "measured_TP=-3.0", "measured_LRA=4.2",
                     "measured_thresh=-29.3", "offset=0.4", "linear=true"):
        assert fragment in af
    assert "print_format=json" not in af


def test_a_different_loudness_target_is_honoured() -> None:
    """audio.loudness is show config (F-15): a show that masters to -16 gets -16."""
    mod = load_script("master-video.py")
    af = mod.loudnorm_filter({"I": "-16", "TP": "-1.0", "LRA": "9"})
    assert af.startswith("loudnorm=I=-16:TP=-1.0:LRA=9")


@pytest.fixture
def episode(show_root: Path) -> Path:
    (show_root / "Production" / "ep01" / "video").mkdir(parents=True)
    return show_root


def _silent_mp4(path: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=c=black:s=160x90:d=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
        check=True, capture_output=True)


@needs_ffmpeg
def test_the_mastered_file_appears_beside_an_untouched_input(episode: Path) -> None:
    src = episode / "Production/ep01/video/episode.mp4"
    _silent_mp4(src)
    before = src.read_bytes()
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    dst = episode / "Production/ep01/video/episode-mastered.mp4"
    assert dst.exists()
    # The whole point of F-09: a re-run must measure the render, not its own output.
    assert src.read_bytes() == before
    assert r.stdout.strip().splitlines()[-1] == (
        "MASTER_OK Production/ep01/video/episode-mastered.mp4")


@needs_ffmpeg
def test_a_second_run_is_idempotent(episode: Path) -> None:
    src = episode / "Production/ep01/video/episode.mp4"
    _silent_mp4(src)
    for _ in range(2):
        assert subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                              cwd=str(episode), capture_output=True).returncode == 0
    assert src.exists()


def test_a_missing_render_is_one_line_on_stderr(episode: Path) -> None:
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                       cwd=str(episode), capture_output=True, text=True)
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert "Production/ep01/video/episode.mp4 not found" in r.stderr
