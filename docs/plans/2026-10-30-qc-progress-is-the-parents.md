# QC Progress Is the Parent's Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A QC step's progress is its own rounds, never the child renderer's segment count, so the Board's progress figure stops jumping (117/455 → 44/455 → 98/455) while pace-qc re-rolls.

**Architecture:** The three QC scripts (`pace-qc.py`, `truncation-qc.py`, `breath-qc.py`) re-run `tts-generate.py` as a child whose stdout is inherited, so the child's `::progress n/455 segments` lines — restarting at 1 every round and counting segments it skips — are recorded by the engine as the parent step's progress. Plan ruling F-11 (`scripts/breath-qc.py`'s `resynth` comment) wanted the child's lines visible, the child killable with the parent, and the episode id on argv; all three survive. The change: the parent reads the child's stdout line by line, forwards every line except `::progress` ones, and reports its own rounds with a message naming the re-roll count. `tts-generate.py` is unchanged: its own full-render progress (one unit per segment, skipped included) stays as its comment explains.

**Tech Stack:** Python 3.11, pytest (`cd scripts && uv run --group dev pytest -q`, or as `scripts/pyproject.toml` and the existing tests are run in this repository — read `scripts/tests/conftest.py`).

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` §6.7 (progress as a per-step contract: a step reports its own unit of work). Ryan, 2026-10-30: "The progress seems to have random progress numbers on it… I find that information not interesting/misleading."

## Global Constraints

- **No show's name in `scripts/`:** `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' scripts/ --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache` must print nothing.
- **F-11 holds:** the child is `sys.executable` running the `tts-generate.py` beside the parent, with the episode id on argv, no new session, and every non-progress line of its stdout reaches the engine's log in order and without waiting for the child to exit.
- **`tts-generate.py` is not modified.**
- **The scripts' suite green at the commit**, and `scripts/tests/test_qc_spawn.py`'s four shape assertions still hold (updated to the new spawn call).
- **Commits end with exactly one trailer:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The parent forwards the child's lines and owns its progress

**Files:**
- Create: `scripts/lib/child.py`
- Modify: `scripts/pace-qc.py`, `scripts/truncation-qc.py`, `scripts/breath-qc.py` (their `resynth`, and the round progress message)
- Modify: `scripts/tests/test_qc_spawn.py` (records `Popen`, not `run`)
- Test: `scripts/tests/test_child_forwarding.py`

**Interfaces:**
- Produces: `lib/child.py`'s `run_forwarding(argv: list[str]) -> None`: spawns `argv` with `subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1)`, iterates `proc.stdout` line by line, prints every line that does not start with `::progress ` (with `flush=True`), waits, and raises `subprocess.CalledProcessError(returncode, argv)` on a non-zero exit. Exported for the three parents.
- Consumes: `lib.showconfig.progress(done, total, unit, message=None)`.

- [x] **Step 1: The failing tests.** Create `scripts/tests/test_child_forwarding.py`:

```python
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
```

Update `scripts/tests/test_qc_spawn.py` so its fixture records the forwarder's `subprocess.Popen` instead of each script's `subprocess.run`: monkeypatch `child.subprocess.Popen` (import `lib.child`) with a recorder returning a `FakeProc([])`, call `module.resynth("ep01")`, and keep the four assertions on `args[0]` (the argv list) and `kwargs` as they are — read the file; the kwargs assertions about `start_new_session` and stdout must now say `stdout=subprocess.PIPE` is passed and `start_new_session` is not.

- [x] **Step 2: Run them to fail.** From `scripts/`: `uv run --group dev pytest -q tests/test_child_forwarding.py tests/test_qc_spawn.py` — expected: `lib.child` does not exist; the spawn fixture records nothing.

- [x] **Step 3: The forwarder.** Create `scripts/lib/child.py`:

```python
"""Run a child script and forward its stdout, minus its progress lines.

The three QC steps re-run tts-generate.py as a child (plan ruling F-11: this interpreter, the
script beside the parent, the episode id on argv, no new session, so the engine's kill reaches
it). F-11 also wanted the child's lines visible in the engine's log; with the child's stdout
inherited they were, and so were its `::progress` lines -- which the engine records as the
PARENT step's progress. A re-roll round re-runs the renderer over every segment, printing
1..N from 1 again while skipping the rendered ones, so the Board's figure for pace-qc read
117/455, then 44/455, then 98/455 (Ryan, 2026-10-30). The parent's progress is its rounds;
the child's lines are forwarded here one by one, as they arrive, except the progress ones.
"""
from __future__ import annotations

import subprocess

PROGRESS_PREFIX = "::progress "


def run_forwarding(argv: list[str]) -> None:
    """Spawn `argv`, print each stdout line that is not a `::progress` line as it arrives, and raise
    CalledProcessError on a non-zero exit. stderr is inherited, as before."""
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True, bufsize=1)
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith(PROGRESS_PREFIX):
            continue
        print(line, end="", flush=True)
    code = proc.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, argv)
```

- [x] **Step 4: The parents.** In each of `pace-qc.py`, `truncation-qc.py`, `breath-qc.py`: `from lib.child import run_forwarding`; `resynth` becomes `run_forwarding([sys.executable, str(Path(__file__).with_name("tts-generate.py")), ep])`, keeping its docstring and adding one sentence: the child's progress lines are dropped by the forwarder because the parent's progress is its rounds. In `pace-qc.py` and `truncation-qc.py`, the round progress before a re-roll carries the count: `sc.progress(rnd, PASSES, "rounds", message=f"round {rnd}: {len(outliers)} segments re-rolled")` (use each script's own variable for the re-rolled set; `breath-qc` has no rounds and keeps its per-segment progress, which is its own work). Drop the now-unused `import subprocess` from any parent that no longer calls it directly (`breath-qc.py` may still use it elsewhere — check).

- [x] **Step 5: Run the suite.** From `scripts/`: `uv run --group dev pytest -q` — expected: all green, including `test_qc_progress.py` (a clean pass still spawns nothing: its `no_spawn` fixture patches whichever call it patched before — update it to patch `run_forwarding` on the module if it patched `subprocess.run`). Then the show-name grep.

- [x] **Step 6: Commit.**

```bash
git add scripts/lib/child.py scripts/pace-qc.py scripts/truncation-qc.py scripts/breath-qc.py scripts/tests/test_child_forwarding.py scripts/tests/test_qc_spawn.py scripts/tests/test_qc_progress.py
git commit -m "scripts: a QC step's progress is its own rounds; the child renderer's lines are forwarded without its progress

The three QC steps re-run tts-generate as a child with its stdout inherited, so the child's
::progress lines were recorded as the parent's progress: pace-qc's figure on the Board read
117/455, then 44/455, then 98/455 as each re-roll round re-counted every segment from 1. The
child's stdout now goes through lib/child.run_forwarding, which prints every line as it arrives
except the progress ones; the parents report their rounds, with the re-roll count in the message.
F-11 holds: same interpreter, the script beside the parent, the episode id on argv, no new session.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
