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


# --- the engine-skip path: a skipped pass is a FINISHED pass ---------------------------------

def _kokoro_script(show_root: Path, segments: list[dict]) -> None:
    """A tts-script from the legacy deterministic engine, which every QC pass declines to run."""
    out = show_root / "Production/ep01/tts-script.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"engine": "kokoro", "cast": {}, "segments": segments}),
                   encoding="utf-8")


@pytest.mark.parametrize("script,result", [
    ("truncation-qc.py", "TRUNCATION_QC_SKIP"),
    ("pace-qc.py", "PACE_QC_SKIP"),
])
def test_a_skipped_round_pass_reports_its_bar_full(script, result, show_root: Path,
                                                   monkeypatch, capsys, restore_cwd) -> None:
    """Without this a console shows the step finishing at 0 of N for ever."""
    mod = load_script(script)
    _kokoro_script(show_root, [{"i": 1, "speaker": "narrator", "text": "one"}])
    monkeypatch.setattr(mod.sys, "argv", [script, "ep01", "--show-root", str(show_root)])
    mod.main()

    out = capsys.readouterr().out
    progress = _progress(out)
    assert progress, "the skip path emitted no progress line at all"
    assert progress[-1] == {"done": mod.PASSES, "total": mod.PASSES, "unit": "rounds"}
    # The result line stays last: a progress line is not a result.
    assert [l for l in out.strip().splitlines()
            if not l.startswith("::progress")][-1].startswith(result)


def test_a_skipped_breath_pass_reports_its_bar_full(show_root: Path, monkeypatch, capsys,
                                                    restore_cwd) -> None:
    """breath-qc counts segments, not rounds, so its total is the narrator segment count —
    counted ABOVE the skip so the total is real even when the work is none."""
    mod = load_script("breath-qc.py")
    _kokoro_script(show_root, [
        {"i": 1, "speaker": "narrator", "text": "one"},
        {"i": 2, "speaker": "narrator", "text": "two"},
        {"i": 3, "speaker": "Maeve", "text": "three"},
    ])
    monkeypatch.setattr(mod.sys, "argv",
                        ["breath-qc.py", "ep01", "--show-root", str(show_root)])
    mod.main()

    out = capsys.readouterr().out
    assert _progress(out)[-1] == {"done": 2, "total": 2, "unit": "segments"}
    assert [l for l in out.strip().splitlines()
            if not l.startswith("::progress")][-1].startswith("BREATH_QC_SKIP")
