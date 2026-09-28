"""validate-manifest.py — the deterministic gate before synthesis, run as the engine runs it.

Each test spawns the real script with the temp show root as its working directory and one
positional argument, which is the whole convention: argv in, show config off disk, a one-line
result last.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "validate-manifest.py"

REGISTRY = """# Voice registry

## Qwen3 pronunciation & heteronym map

| Speaker | Script spelling | Respelling | Note |
|---|---|---|---|
| narrator | `buffet` | `buffay` | the wind sense, not the meal |
"""


def _cast_entry(show_root: Path, name: str, **extra) -> dict:
    ref = show_root / "Production/voice-refs" / f"{name}.wav"
    ref.parent.mkdir(parents=True, exist_ok=True)
    ref.write_bytes(b"")
    return {
        "ref": f"Production/voice-refs/{name}.wav",
        "ref_text": "A line this voice has already spoken.",
        "direction": "steady, unhurried",
        **extra,
    }


def _episode(show_root: Path, segments: list[dict], speakers: tuple[str, ...]) -> None:
    (show_root / "Canon").mkdir(parents=True, exist_ok=True)
    (show_root / "Canon/voice-registry.md").write_text(REGISTRY, encoding="utf-8")
    doc = {
        "engine": "qwen3",
        "cast": {name: _cast_entry(show_root, name) for name in speakers},
        "segments": segments,
    }
    out = show_root / "Production/ep01/tts-script.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc), encoding="utf-8")


def _run(show_root: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv],
        cwd=show_root, capture_output=True, text=True,
    )


def _lines(out: str) -> list[str]:
    return [line for line in out.splitlines() if line.strip()]


def _result(out: str) -> str:
    """The step's result: the last non-blank, non-progress stdout line."""
    return [line for line in _lines(out) if not line.startswith("::progress ")][-1]


GOOD = [
    {"i": 1, "speaker": "narrator", "text": "The lamp turned over the water and the night held still.", "gap_before": 0.3},
    {"i": 2, "speaker": "Maeve", "text": "You are late, keeper, and the tide will not wait for either of us.", "gap_before": 0.5},
]


def test_a_good_manifest_ends_with_its_summary_line(show_root: Path) -> None:
    _episode(show_root, GOOD, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result.startswith("MANIFEST_OK "), result
    assert "2 segments" in result and "2 cast" in result


def test_it_reports_progress_in_segments(show_root: Path) -> None:
    _episode(show_root, GOOD, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    progress = [line for line in _lines(done.stdout) if line.startswith("::progress ")]
    assert progress == [
        '::progress {"done": 1, "total": 2, "unit": "segments"}',
        '::progress {"done": 2, "total": 2, "unit": "segments"}',
    ]


def test_a_gap_over_the_shows_ceiling_fails_with_the_ceiling_named(show_root: Path) -> None:
    bad = [dict(GOOD[0]), dict(GOOD[1], gap_before=6.0)]
    _episode(show_root, bad, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    assert done.returncode != 0
    assert "scene-transition ceiling is 4.0s" in done.stdout, done.stdout
    assert "MANIFEST_INVALID" in done.stderr


def test_a_title_card_gets_the_shows_wider_ceiling(show_root: Path) -> None:
    wide = [dict(GOOD[0]), dict(GOOD[1], gap_before=7.0, title_card_before=True)]
    _episode(show_root, wide, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    assert _result(done.stdout).startswith("MANIFEST_OK ")


def test_a_pause_outside_the_authored_range_warns_without_failing(show_root: Path) -> None:
    odd = [dict(GOOD[0]), dict(GOOD[1], gap_before=3.8)]
    _episode(show_root, odd, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "authored pause 3.8s is outside the show's 0.2-3.5s range" in done.stdout
    assert _result(done.stdout).startswith("MANIFEST_OK ")


def test_the_main_cast_comes_from_show_config(show_root: Path) -> None:
    """A short first line from a main is silence; the same line from a guest is a warning."""
    segments = [
        dict(GOOD[0]),
        {"i": 2, "speaker": "Maeve", "text": "Not tonight.", "gap_before": 0.4},
        {"i": 3, "speaker": "Rourke", "text": "Not tonight.", "gap_before": 0.4},
    ]
    _episode(show_root, segments, ("narrator", "Maeve", "Rourke"))
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    warnings = [line for line in _lines(done.stdout) if line.startswith("WARN ")]
    assert any("'Rourke' FIRST line is <5 words" in w for w in warnings), warnings
    assert not any("Maeve" in w for w in warnings), warnings


def test_a_leaked_authoring_mark_fails(show_root: Path) -> None:
    leaked = [dict(GOOD[0], text="[BEAT] The lamp turned over the water."), dict(GOOD[1])]
    _episode(show_root, leaked, ("narrator", "Maeve"))
    done = _run(show_root, "ep01")
    assert done.returncode != 0
    assert "authoring mark leaked" in done.stdout


def test_show_root_can_be_given_from_elsewhere(show_root: Path, tmp_path: Path) -> None:
    _episode(show_root, GOOD, ("narrator", "Maeve"))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "ep01", "--show-root", str(show_root)],
        cwd=elsewhere, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert _result(done.stdout).startswith("MANIFEST_OK ")


def test_a_relative_show_root_resolves_before_the_chdir(show_root: Path) -> None:
    """The root is made absolute first, so ".." still means the show root after the chdir."""
    _episode(show_root, GOOD, ("narrator", "Maeve"))
    elsewhere = show_root / "elsewhere"
    elsewhere.mkdir()
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "ep01", "--show-root", ".."],
        cwd=elsewhere, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert _result(done.stdout).startswith("MANIFEST_OK ")


def test_the_equals_form_of_show_root_works_too(show_root: Path) -> None:
    _episode(show_root, GOOD, ("narrator", "Maeve"))
    elsewhere = show_root / "elsewhere"
    elsewhere.mkdir()
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "ep01", f"--show-root={show_root}"],
        cwd=elsewhere, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert _result(done.stdout).startswith("MANIFEST_OK ")


def test_a_show_root_that_does_not_exist_is_one_line_on_stderr(show_root: Path) -> None:
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "ep01", "--show-root", str(show_root / "no-such-show")],
        cwd=show_root, capture_output=True, text=True,
    )
    assert done.returncode == 1
    stderr = done.stderr.strip().splitlines()
    assert len(stderr) == 1, done.stderr
    assert stderr[0].startswith("validate-manifest: showrunner.json could not be read")


def test_a_missing_episode_id_is_refused(show_root: Path) -> None:
    done = _run(show_root)
    assert done.returncode != 0
    assert "episode id missing" in done.stderr


def test_a_show_root_without_a_config_names_the_file(tmp_path: Path) -> None:
    done = _run(tmp_path, "ep01")
    assert done.returncode != 0
    assert "showrunner.json" in done.stderr
