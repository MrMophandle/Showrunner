"""The three QC steps re-run synthesis as a visible, killable child (plan ruling F-11).

No synthesis happens here: the forwarder's subprocess.Popen is replaced with a recorder, so the
assertions are about the shape of the spawn and nothing else. The spawn moved into
`lib/child.run_forwarding` on 2026-10-30, so the recorder goes on `lib.child.subprocess.Popen`
rather than on each script's own `subprocess.run`.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script
from lib import child
from test_child_forwarding import FakeProc

QC_SCRIPTS = ["truncation-qc.py", "pace-qc.py", "breath-qc.py"]


@pytest.fixture(params=QC_SCRIPTS)
def spawned(request, monkeypatch):
    """Call one QC script's resynth() with the forwarder's subprocess.Popen recorded, and return
    the call. The recorder hands back a child that printed nothing and exited 0."""
    module = load_script(request.param)
    calls: list[tuple[tuple, dict]] = []

    def record(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProc([])

    monkeypatch.setattr(child.subprocess, "Popen", record)
    module.resynth("ep01")
    assert len(calls) == 1, f"{request.param}: resynth must spawn exactly one child"
    args, kwargs = calls[0]
    return request.param, args[0], kwargs


def test_the_child_is_this_interpreter(spawned) -> None:
    name, argv, _ = spawned
    assert argv[0] == sys.executable, f"{name}: the child must be this interpreter, not `uv`"


def test_the_child_is_the_script_beside_this_one(spawned) -> None:
    name, argv, _ = spawned
    child_path = Path(argv[1])
    assert child_path.is_absolute(), f"{name}: a show-relative path breaks under cwd = show root"
    assert child_path.name == "tts-generate.py"
    assert child_path.parent == SCRIPTS_DIR
    assert child_path.exists()


def test_the_episode_id_travels_as_argv(spawned) -> None:
    name, argv, _ = spawned
    assert argv[2] == "ep01", f"{name}: the episode id is argv, not an environment variable"
    assert len(argv) == 3


def test_stdout_is_piped_to_the_forwarder(spawned) -> None:
    name, _, kwargs = spawned
    assert kwargs.get("stdout") is subprocess.PIPE, (
        f"{name}: the forwarder reads the child's stdout, so it must be a pipe -- an inherited "
        f"stdout hands the child's ::progress lines to the engine as the PARENT's progress"
    )


def test_the_child_stays_in_this_process_group(spawned) -> None:
    name, _, kwargs = spawned
    assert not kwargs.get("start_new_session"), (
        f"{name}: a new session escapes the process group the engine kills"
    )


def test_no_environment_is_handed_to_the_child(spawned) -> None:
    name, _, kwargs = spawned
    assert "env" not in kwargs, f"{name}: the child inherits the engine's environment unchanged"


@pytest.mark.parametrize("name", QC_SCRIPTS)
def test_a_failed_child_fails_the_step(name, monkeypatch) -> None:
    """`check=True` was subprocess.run's; the forwarder raises CalledProcessError itself."""
    module = load_script(name)
    monkeypatch.setattr(child.subprocess, "Popen", lambda *a, **k: FakeProc([], code=1))
    with pytest.raises(subprocess.CalledProcessError):
        module.resynth("ep01")
