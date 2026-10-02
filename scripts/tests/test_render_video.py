"""render-video.py — Remotion's own frame counter, as the pipeline's ::progress lines.

The fixture is a real child process, not a mocked one: a Python stub named `npx`, made executable
on a PATH the test prepends. What is under test is the spawn — the argv Remotion receives, the
working directory it runs in, the REMOTION_EPISODE it reads — together with the parse of what
comes back, and none of those three can be proved against a mock of `subprocess`.

The stub prints the exact format measured against Remotion 4.0.487 under a pipe on 2026-10-02 and
recorded in `render-video.py`'s own docstring: `Rendered <done>/<total>`, with an ETA appended
from the second report on, newline-separated, no carriage returns.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from string import Template

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "render-video.py"

EPISODE = "ep98"
COMPOSITION = "Episode"

# The stub records how it was called BEFORE it plays anything back, so a test can prove the child
# ran in the render directory under REMOTION_EPISODE even in the test where the child then fails.
_STUB = Template('''#!/usr/bin/env python3
"""Stands in for npx on PATH: records its own call, then plays a canned Remotion render."""
import json, os, sys

ARGS = sys.argv[1:]
with open($record, "w", encoding="utf-8") as fh:
    json.dump({"cwd": os.path.realpath(os.getcwd()),
               "episode": os.environ.get("REMOTION_EPISODE"),
               "argv": ARGS}, fh)

$body
''')

# Remotion's CLI positional order, which the stub has to honour to find the file it must write:
# remotion render <composition> <out> --log=<level>, so ARGS[3] is the output path.
_SUCCESS = '''OUT = ARGS[3]
open(OUT, "w", encoding="utf-8").close()
sys.stdout.write("Bundling 100%\\n")
sys.stdout.write("Rendered 10/30, time remaining: 1m 0s\\n")
sys.stdout.write("Rendered 20/30, time remaining: 30s\\n")
sys.stdout.write("Rendered 30/30\\n")
sys.exit(0)
'''

# The same three reports as a TTY would separate them: one line redrawn in place, \\r only. The
# measurement found no \\r under a pipe, but an operator running this by hand gets the bar.
_SUCCESS_CR = '''OUT = ARGS[3]
open(OUT, "w", encoding="utf-8").close()
sys.stdout.write("Rendered 10/30\\rRendered 20/30\\rRendered 30/30\\r")
sys.exit(0)
'''

_FAILS = '''sys.stderr.write("Error: Cannot find module 'remotion'\\n")
sys.stderr.write("A delayRender() was called but not cleared after 30000ms\\n")
sys.exit(3)
'''


def _stub(bin_dir: Path, record: Path, body: str) -> None:
    """Write `<bin_dir>/npx` as an executable Python program.

    The shebang is the load-bearing line: `execvp` on a text file with no interpreter line fails
    with "Exec format error", and `#!/bin/sh` would be the shell the spawn contract forbids.
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    npx = bin_dir / "npx"
    npx.write_text(_STUB.substitute(record=repr(str(record)), body=body), encoding="utf-8")
    npx.chmod(npx.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class Rig:
    """One staged render: the show root, the render directory, the stub's record, the out path."""

    def __init__(self, show_root: Path, tmp_path: Path) -> None:
        self.show_root = show_root
        self.render_dir = tmp_path / "engine" / "render"
        self.render_dir.mkdir(parents=True)
        self.bin_dir = tmp_path / "bin"
        self.record = tmp_path / "npx-call.json"
        self.out = show_root / "Production" / EPISODE / "video" / "episode.mp4"
        self.out.parent.mkdir(parents=True)

    def stub(self, body: str) -> None:
        _stub(self.bin_dir, self.record, body)

    def run(self, *extra: str) -> subprocess.CompletedProcess:
        """Run the script with the stub first on PATH, from the show root as the engine does."""
        env = dict(os.environ, PATH=f"{self.bin_dir}{os.pathsep}{os.environ['PATH']}")
        return subprocess.run(
            [sys.executable, str(SCRIPT), EPISODE,
             "--render-dir", str(self.render_dir),
             "--composition", COMPOSITION,
             "--out", str(self.out), *extra],
            cwd=str(self.show_root), capture_output=True, text=True, env=env)

    def called(self) -> dict:
        return json.loads(self.record.read_text(encoding="utf-8"))


@pytest.fixture
def rig(show_root: Path, tmp_path: Path) -> Rig:
    return Rig(show_root, tmp_path)


def _progress(stdout: str) -> list[dict]:
    return [json.loads(l[len("::progress "):])
            for l in stdout.splitlines() if l.startswith("::progress ")]


# ── the parse ────────────────────────────────────────────────────────────────────────────────────

def test_three_reports_become_three_progress_lines(rig: Rig) -> None:
    """--progress-interval 0 turns the throttle off, so every report Remotion makes is reported."""
    rig.stub(_SUCCESS)
    r = rig.run("--progress-interval", "0")
    assert r.returncode == 0, r.stderr
    assert _progress(r.stdout) == [
        {"done": 10, "total": 30, "unit": "frames"},
        {"done": 20, "total": 30, "unit": "frames"},
        {"done": 30, "total": 30, "unit": "frames"},
    ]


def test_reports_separated_by_carriage_returns_are_each_parsed(rig: Rig) -> None:
    """A TTY redraws one line with \\r and no newline; splitting on \\n alone would see one line."""
    rig.stub(_SUCCESS_CR)
    r = rig.run("--progress-interval", "0")
    assert r.returncode == 0, r.stderr
    assert [p["done"] for p in _progress(r.stdout)] == [10, 20, 30]


def test_a_non_progress_line_is_forwarded_unchanged(rig: Rig) -> None:
    """`Bundling 100%` is the webpack bundle's percentage, not the render's: an ordinary line."""
    rig.stub(_SUCCESS)
    r = rig.run("--progress-interval", "0")
    assert "Bundling 100%" in r.stdout.splitlines()


def test_the_last_stdout_line_is_the_render_ok_sentinel(rig: Rig) -> None:
    """The executor records the last non-progress stdout line as the step's result."""
    rig.stub(_SUCCESS)
    r = rig.run("--progress-interval", "0")
    assert r.stdout.strip().splitlines()[-1] == f"RENDER_OK {rig.out}"


# ── the spawn ────────────────────────────────────────────────────────────────────────────────────

def test_the_child_runs_in_the_render_directory(rig: Rig) -> None:
    """Remotion resolves its project, its config and public/ from its own working directory, and
    this script's own working directory is the show root — so the two cannot be the same."""
    rig.stub(_SUCCESS)
    rig.run("--progress-interval", "0")
    assert rig.called()["cwd"] == os.path.realpath(str(rig.render_dir))


def test_the_child_sees_remotion_episode(rig: Rig) -> None:
    """render/README.md: an unset REMOTION_EPISODE throws rather than guessing an episode."""
    rig.stub(_SUCCESS)
    rig.run("--progress-interval", "0")
    assert rig.called()["episode"] == EPISODE


def test_the_child_argv_is_remotions_own_order_with_an_absolute_out(rig: Rig) -> None:
    """The out path reaches Remotion absolute: Remotion runs with cwd = the render directory,
    where a show-relative path would resolve inside the engine checkout."""
    rig.stub(_SUCCESS)
    rig.run("--progress-interval", "0")
    assert rig.called()["argv"] == [
        "remotion", "render", COMPOSITION, str(rig.out), "--log=info"]
    assert rig.out.is_file()


# ── the failure ──────────────────────────────────────────────────────────────────────────────────

def test_a_child_exiting_three_exits_three(rig: Rig) -> None:
    """Remotion's exit code is this step's exit code: a render that died four hours in must not
    be reported as the exit 1 a usage error gets."""
    rig.stub(_FAILS)
    r = rig.run("--progress-interval", "0")
    assert r.returncode == 3


def test_a_failure_is_one_line_carrying_remotions_last(rig: Rig) -> None:
    rig.stub(_FAILS)
    r = rig.run("--progress-interval", "0")
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("render-video: ")
    assert "A delayRender() was called but not cleared after 30000ms" in r.stderr


def test_a_failed_render_prints_no_sentinel(rig: Rig) -> None:
    rig.stub(_FAILS)
    r = rig.run("--progress-interval", "0")
    assert "RENDER_OK" not in r.stdout


# ── the flags ────────────────────────────────────────────────────────────────────────────────────

def test_a_missing_render_dir_is_one_line(rig: Rig) -> None:
    rig.stub(_SUCCESS)
    env = dict(os.environ, PATH=f"{rig.bin_dir}{os.pathsep}{os.environ['PATH']}")
    r = subprocess.run([sys.executable, str(SCRIPT), EPISODE,
                        "--composition", COMPOSITION, "--out", str(rig.out)],
                       cwd=str(rig.show_root), capture_output=True, text=True, env=env)
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("render-video: --render-dir")


def test_a_missing_episode_id_is_one_line(rig: Rig) -> None:
    rig.stub(_SUCCESS)
    env = dict(os.environ, PATH=f"{rig.bin_dir}{os.pathsep}{os.environ['PATH']}")
    r = subprocess.run([sys.executable, str(SCRIPT),
                        "--render-dir", str(rig.render_dir),
                        "--composition", COMPOSITION, "--out", str(rig.out)],
                       cwd=str(rig.show_root), capture_output=True, text=True, env=env)
    assert r.returncode == 1
    assert r.stderr.startswith("render-video: episode id missing")


def test_a_relative_out_is_resolved_against_the_show_root(rig: Rig) -> None:
    """A relative --out means show-relative, because the show root is this script's cwd."""
    rig.stub(_SUCCESS)
    env = dict(os.environ, PATH=f"{rig.bin_dir}{os.pathsep}{os.environ['PATH']}")
    rel = f"Production/{EPISODE}/video/episode.mp4"
    r = subprocess.run([sys.executable, str(SCRIPT), EPISODE,
                        "--render-dir", str(rig.render_dir),
                        "--composition", COMPOSITION, "--out", rel,
                        "--progress-interval", "0"],
                       cwd=str(rig.show_root), capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    assert os.path.realpath(rig.called()["argv"][3]) == os.path.realpath(str(rig.out))


# ── the throttle, against a fake clock ───────────────────────────────────────────────────────────

def test_the_measured_lines_parse_and_the_bundler_does_not() -> None:
    """The three forms the measurement found, and the one percentage that must not be mistaken
    for frames."""
    mod = load_script("render-video.py")
    assert list(mod.relay(["Rendered 0/63280\n"], 0.0)) == [("progress", (0, 63280))]
    assert list(mod.relay(["Rendered 1/63280, time remaining: 3h 33m 2s\n"], 0.0)) == [
        ("progress", (1, 63280))]
    assert list(mod.relay(["Bundling 6%\n"], 0.0)) == [("line", "Bundling 6%")]
    assert list(mod.relay(["[renderMedia()] Rendering frames 0-63279\n"], 0.0)) == [
        ("line", "[renderMedia()] Rendering frames 0-63279")]


def test_the_first_report_is_emitted_at_once_and_the_last_is_flushed() -> None:
    """One report per frame at 63,280 frames would be 63,280 step_progress events, so reports are
    throttled — but the FIRST proves the render is alive and the LAST must match the file."""
    mod = load_script("render-video.py")
    ticks = iter([0.0, 0.1, 0.2, 1.5, 1.6])
    chunks = [f"Rendered {n}/5\n" for n in (1, 2, 3, 4, 5)]
    assert list(mod.relay(chunks, 1.0, clock=lambda: next(ticks))) == [
        ("progress", (1, 5)),   # the first, at once
        ("progress", (4, 5)),   # the first report a full second after it
        ("progress", (5, 5)),   # flushed at end of stream: its count was never emitted
    ]


def test_a_final_report_already_emitted_is_not_repeated() -> None:
    mod = load_script("render-video.py")
    ticks = iter([0.0, 2.0])
    assert list(mod.relay(["Rendered 1/5\n", "Rendered 2/5\n"], 1.0,
                          clock=lambda: next(ticks))) == [
        ("progress", (1, 5)), ("progress", (2, 5))]


def test_progress_and_lines_keep_their_order() -> None:
    mod = load_script("render-video.py")
    ticks = iter([0.0])
    assert list(mod.relay(["Composition          Episode\nRendered 0/9\nStarting download [0]\n"],
                          1.0, clock=lambda: next(ticks))) == [
        ("line", "Composition          Episode"),
        ("progress", (0, 9)),
        ("line", "Starting download [0]"),
    ]
