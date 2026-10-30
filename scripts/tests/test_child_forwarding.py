"""A QC parent forwards its child's lines and drops the child's progress (Ryan, 2026-10-30: the
Board's figure jumped 117/455 -> 44/455 -> 98/455 while pace-qc re-rolled, because the child
renderer's ::progress lines were recorded as the parent's)."""

from __future__ import annotations

import subprocess
import sys

import pytest
from conftest import load_script

QC_SCRIPTS = ["truncation-qc.py", "pace-qc.py", "breath-qc.py"]


class FakeProc:
    def __init__(self, lines: list[str], code: int = 0) -> None:
        self.stdout = iter(lines)
        self.returncode = code
    def wait(self) -> int:
        return self.returncode


def test_run_forwarding_prints_every_line_but_progress(monkeypatch, capsys) -> None:
    from lib import child
    lines = ["engine: qwen3\n", "::progress {\"done\": 1, \"total\": 455, \"unit\": \"segments\"}\n",
             "[1/455] narrator 3.2s\n", "::progress {\"done\": 2, \"total\": 455, \"unit\": \"segments\"}\n", "DONE 455 segments\n"]
    monkeypatch.setattr(child.subprocess, "Popen", lambda *a, **k: FakeProc(lines))
    child.run_forwarding([sys.executable, "x.py", "ep01"])
    out = capsys.readouterr().out
    assert "engine: qwen3" in out and "[1/455] narrator 3.2s" in out and "DONE 455 segments" in out
    assert "::progress" not in out


def test_run_forwarding_raises_on_a_failing_child(monkeypatch) -> None:
    from lib import child
    monkeypatch.setattr(child.subprocess, "Popen", lambda *a, **k: FakeProc(["boom\n"], code=3))
    with pytest.raises(subprocess.CalledProcessError):
        child.run_forwarding([sys.executable, "x.py", "ep01"])


@pytest.mark.parametrize("name", QC_SCRIPTS)
def test_a_parent_resynth_goes_through_the_forwarder(name, monkeypatch) -> None:
    module = load_script(name)
    calls: list[list[str]] = []
    monkeypatch.setattr(module, "run_forwarding", lambda argv: calls.append(argv))
    module.resynth("ep01")
    assert len(calls) == 1, f"{name}: resynth must spawn exactly one child"
    assert calls[0][0] == sys.executable and calls[0][-1] == "ep01"
