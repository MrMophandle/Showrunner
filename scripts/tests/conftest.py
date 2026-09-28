"""Shared test scaffolding for the engine's Python steps.

Every test here is hermetic: a small input under a temp show root, no model, no GPU, no network.
The one exception is marked with `needs_ffmpeg`, which skips when ffmpeg is not on PATH.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

# The scripts run with the show root as their working directory and import `lib` off their own
# directory (sys.path[0]); under pytest the working directory is elsewhere, so put it on the path.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def load_script(filename: str):
    """Import one step script by filename, without running its main().

    The step scripts are named with hyphens ("pace-qc.py"), which is not an importable module name,
    and each ends with an `if __name__ == "__main__"` guard so importing one runs no work.
    """
    path = SCRIPTS_DIR / filename
    name = path.stem.replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def show_root(tmp_path: Path) -> Path:
    """A temp show root holding the invented show's showrunner.json."""
    shutil.copy(FIXTURES_DIR / "showrunner.json", tmp_path / "showrunner.json")
    return tmp_path


needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg is not on PATH"
)
