"""A QC pass that finds nothing still reports its bar full.

Both scripts can return from inside their round loop on round 1. Without a terminal progress line
a console would show the step finishing at 1 of 2 (or 1 of 3) for ever, so each emits done == total
before its result line. Nothing is spawned on this path, and the recorder asserts it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from conftest import load_script


@pytest.fixture
def restore_cwd():
    """The scripts chdir into the show root; put the test process back where it was."""
    was = os.getcwd()
    yield
    os.chdir(was)


@pytest.fixture
def no_spawn(monkeypatch):
    """Fail loudly if a clean pass re-runs synthesis."""
    def _forbidden(*args, **kwargs):
        raise AssertionError(f"a clean pass must not spawn anything: {args!r}")
    return _forbidden


def _tts_script(show_root: Path, segments: list[dict]) -> None:
    out = show_root / "Production/ep01/tts-script.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"engine": "qwen3", "cast": {}, "segments": segments}), encoding="utf-8")


def _progress(out: str) -> list[dict]:
    return [
        json.loads(line[len("::progress "):])
        for line in out.splitlines()
        if line.startswith("::progress ")
    ]


def _result(out: str) -> str:
    return [line for line in out.splitlines() if line.strip() and not line.startswith("::progress ")][-1]


def test_a_clean_pace_pass_ends_at_the_last_round(
    show_root: Path, monkeypatch, capsys, restore_cwd, no_spawn
) -> None:
    line = " ".join(["word"] * 20)
    _tts_script(show_root, [{"i": i, "speaker": "narrator", "text": line} for i in (1, 2, 3)])
    manifest = {"episode": "ep01", "sr": 24000, "segments": [
        {"i": i, "speaker": "narrator", "duration_s": 6.0, "gap_before": 0.3} for i in (1, 2, 3)
    ]}
    audio = show_root / "Production/ep01/audio"
    audio.mkdir(parents=True, exist_ok=True)
    (audio / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    pace = load_script("pace-qc.py")
    monkeypatch.setattr(pace.subprocess, "run", no_spawn)
    monkeypatch.setattr(pace.sys, "argv", ["pace-qc.py", "ep01", "--show-root", str(show_root)])
    pace.main()

    out = capsys.readouterr().out
    assert _progress(out)[-1] == {"done": pace.PASSES, "total": pace.PASSES, "unit": "rounds"}
    assert _result(out).startswith("PACE_QC_OK ")


def test_a_clean_truncation_pass_ends_at_the_last_round(
    show_root: Path, monkeypatch, capsys, restore_cwd, no_spawn
) -> None:
    # No segment WAVs on disk: nothing to measure, so round 1 is clean and the script returns.
    _tts_script(show_root, [{"i": i, "speaker": "narrator", "text": "A line."} for i in (1, 2)])

    truncation = load_script("truncation-qc.py")
    monkeypatch.setattr(truncation.subprocess, "run", no_spawn)
    monkeypatch.setattr(
        truncation.sys, "argv", ["truncation-qc.py", "ep01", "--show-root", str(show_root)]
    )
    truncation.main()

    out = capsys.readouterr().out
    assert _progress(out)[-1] == {
        "done": truncation.PASSES, "total": truncation.PASSES, "unit": "rounds"
    }
    assert _result(out).startswith("TRUNCATION_QC_OK ")
