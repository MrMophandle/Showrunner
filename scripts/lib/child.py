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
