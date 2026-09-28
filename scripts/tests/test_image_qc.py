"""image-qc.py — the advisory exposure screen, converted to argv and config paths.

The script's own docstring says it is not the real gate, and these tests keep that shape: a
synthetic all-black frame is catastrophic, a mid-grey frame is not, and neither verdict is about
composition or canon.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "image-qc.py"


def _frame(path: Path, level: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.full((32, 32, 3), level, dtype=np.uint8)).save(path)


def _run(root: Path, episode_id: str = "ep01") -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), episode_id],
                          cwd=str(root), capture_output=True, text=True)


def test_a_mid_grey_frame_passes(show_root: Path) -> None:
    _frame(show_root / "Production/ep01/images/s1.png", 128)
    r = _run(show_root)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "IMAGE_QC_OK 1 frames (no catastrophic frames)"


def test_an_all_black_frame_is_catastrophic(show_root: Path) -> None:
    _frame(show_root / "Production/ep01/images/s1.png", 0)
    r = _run(show_root)
    assert r.returncode != 0
    assert "IMAGE_QC_FAIL 1/1" in r.stderr
    assert "CATASTROPHIC" in r.stdout


def test_progress_reports_one_unit_per_frame(show_root: Path) -> None:
    for n in (1, 2, 3):
        _frame(show_root / f"Production/ep01/images/s{n}.png", 128)
    lines = [json.loads(l[len("::progress "):])
             for l in _run(show_root).stdout.splitlines() if l.startswith("::progress")]
    assert lines == [{"done": n, "total": 3, "unit": "frames"} for n in (1, 2, 3)]


def test_an_episode_with_no_images_is_one_line_on_stderr(show_root: Path) -> None:
    r = _run(show_root)
    assert r.returncode != 0
    assert len(r.stderr.strip().splitlines()) == 1
    assert "no images under Production/ep01/images/" in r.stderr


def test_the_show_root_flag_works_from_elsewhere(show_root: Path, tmp_path: Path) -> None:
    _frame(show_root / "Production/ep01/images/s1.png", 128)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01", "--show-root", str(show_root)],
                       cwd=str(elsewhere), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_a_missing_show_config_fails_by_naming_the_file(tmp_path: Path) -> None:
    """image-qc reads no config key, but it loads the config anyway so that a wrong --show-root
    fails the same way it does in every sibling script."""
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01"],
                       cwd=str(tmp_path), capture_output=True, text=True)
    assert r.returncode == 1
    assert "showrunner.json could not be read" in r.stderr
