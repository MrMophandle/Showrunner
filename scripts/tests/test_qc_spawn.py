"""The three QC steps re-run synthesis as a visible, killable child (plan ruling F-11).

No synthesis happens here: subprocess.run is replaced with a recorder, so the assertions are about
the shape of the spawn and nothing else.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

QC_SCRIPTS = ["truncation-qc.py", "pace-qc.py", "breath-qc.py"]


@pytest.fixture(params=QC_SCRIPTS)
def spawned(request, monkeypatch):
    """Call one QC script's resynth() with subprocess.run recorded, and return the call."""
    module = load_script(request.param)
    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: calls.append((a, k)))
    module.resynth("ep01")
    assert len(calls) == 1, f"{request.param}: resynth must spawn exactly one child"
    args, kwargs = calls[0]
    return request.param, args[0], kwargs


def test_the_child_is_this_interpreter(spawned) -> None:
    name, argv, _ = spawned
    assert argv[0] == sys.executable, f"{name}: the child must be this interpreter, not `uv`"


def test_the_child_is_the_script_beside_this_one(spawned) -> None:
    name, argv, _ = spawned
    child = Path(argv[1])
    assert child.is_absolute(), f"{name}: a show-relative path breaks under cwd = show root"
    assert child.name == "tts-generate.py"
    assert child.parent == SCRIPTS_DIR
    assert child.exists()


def test_the_episode_id_travels_as_argv(spawned) -> None:
    name, argv, _ = spawned
    assert argv[2] == "ep01", f"{name}: the episode id is argv, not an environment variable"
    assert len(argv) == 3


def test_stdout_is_not_redirected(spawned) -> None:
    name, _, kwargs = spawned
    assert kwargs.get("stdout") is None, (
        f"{name}: redirecting stdout swallows the child's ::progress lines"
    )


def test_the_child_stays_in_this_process_group(spawned) -> None:
    name, _, kwargs = spawned
    assert not kwargs.get("start_new_session"), (
        f"{name}: a new session escapes the process group the engine kills"
    )


def test_a_failed_child_fails_the_step(spawned) -> None:
    name, _, kwargs = spawned
    assert kwargs.get("check") is True, f"{name}: a failed re-synthesis must fail the step"


def test_no_environment_is_handed_to_the_child(spawned) -> None:
    name, _, kwargs = spawned
    assert "env" not in kwargs, f"{name}: the child inherits the engine's environment unchanged"
