"""finalize-video.py — the air slot, the mastered file, and the copy to the NAS.

The "NAS" is a temp directory named by the fixture config's output.nasRoot. `os.path.ismount` is
the one thing a temp directory cannot satisfy, so it is monkeypatched in the child through a tiny
wrapper script; everything else — the copy, the naming, the mtime skip — is real file I/O.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "finalize-video.py"


@pytest.fixture
def nas(show_root: Path) -> Path:
    """A temp directory standing in for the mount, wired into the fixture config."""
    mount = show_root / "mnt"
    root = mount / "HarborLights"
    root.mkdir(parents=True)
    cfg = json.loads((show_root / "showrunner.json").read_text())
    cfg["output"]["nasMount"] = str(mount)
    cfg["output"]["nasRoot"] = str(root)
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    return root


@pytest.fixture
def runner(show_root: Path, tmp_path: Path) -> Path:
    """A wrapper that makes the temp mount look mounted, then runs the real script.

    `os.path.ismount` is the guard that keeps an 800 MB final off local disk, so it must stay in
    the script; a temp directory is simply not a mount point, and only the child can say
    otherwise.
    """
    wrapper = tmp_path / "run_finalize.py"
    wrapper.write_text(textwrap.dedent(f"""
        import os, runpy, sys
        real = os.path.ismount
        mount = {str(show_root / "mnt")!r}
        os.path.ismount = lambda p: os.path.abspath(p) == mount or real(p)
        sys.path.insert(0, {str(SCRIPTS_DIR)!r})
        sys.argv = ["finalize-video.py"] + sys.argv[1:]
        runpy.run_path({str(SCRIPT)!r}, run_name="__main__")
    """))
    return wrapper


def _video(show_root: Path, episode_id: str, name: str, data: bytes) -> Path:
    path = show_root / "Production" / episode_id / "video" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _season_doc(show_root: Path, season: int, body: str) -> None:
    canon = show_root / "Canon"
    canon.mkdir(exist_ok=True)
    (canon / f"season-{season}.md").write_text(body)


def _run(runner: Path, show_root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(runner), *args],
                          cwd=str(show_root), capture_output=True, text=True)


def test_a_mapped_episode_is_copied_under_its_air_name(show_root: Path, nas: Path,
                                                       runner: Path) -> None:
    src = _video(show_root, "ep02", "episode-mastered.mp4", b"mastered-bytes")
    r = _run(runner, show_root, "ep02")
    assert r.returncode == 0, r.stderr
    dst = nas / "HarborLights S01E02.mp4"
    assert dst.read_bytes() == b"mastered-bytes"
    # The local file is a source, never a thing this script moves.
    assert src.read_bytes() == b"mastered-bytes"
    assert r.stdout.strip().splitlines()[-1] == f"FINALIZE_OK 1 episode(s) in {nas}/"


def test_the_mastered_file_wins_over_the_raw_render(show_root: Path, nas: Path,
                                                    runner: Path) -> None:
    """F-09: master-video.py writes beside its input, so both files exist and the choice between
    them is a decision, not the alphabetical accident a glob's sort order made of it."""
    _video(show_root, "ep02", "episode.mp4", b"raw-bytes")
    _video(show_root, "ep02", "episode-mastered.mp4", b"mastered-bytes")
    assert _run(runner, show_root, "ep02").returncode == 0
    assert (nas / "HarborLights S01E02.mp4").read_bytes() == b"mastered-bytes"


def test_the_raw_render_is_used_when_nothing_was_mastered(show_root: Path, nas: Path,
                                                          runner: Path) -> None:
    _video(show_root, "ep02", "episode.mp4", b"raw-bytes")
    assert _run(runner, show_root, "ep02").returncode == 0
    assert (nas / "HarborLights S01E02.mp4").read_bytes() == b"raw-bytes"


def test_an_up_to_date_destination_is_not_recopied(show_root: Path, nas: Path,
                                                   runner: Path) -> None:
    src = _video(show_root, "ep02", "episode-mastered.mp4", b"mastered-bytes")
    dst = nas / "HarborLights S01E02.mp4"
    dst.write_bytes(b"already-there")
    os.utime(dst, (time.time() + 10, time.time() + 10))
    r = _run(runner, show_root, "ep02")
    assert r.returncode == 0
    assert dst.read_bytes() == b"already-there"
    assert "up-to-date" in r.stdout


def test_an_unmapped_id_falls_back_to_the_season_document(show_root: Path, nas: Path,
                                                          runner: Path) -> None:
    """The fixture airMap holds ep01 and ep02 only. ep03 is ruled into the season document at
    row 3, and its default production id (ep03) is what the row names — so it finalizes.

    This fallback is what lets an episode ruled into a season before anyone edited airMap still
    ship; registering an air slot takes several hand edits and nothing cross-checks them.
    """
    _season_doc(show_root, 1, '| 3 | **RULED** | **"Slack Water"** — the third. |\n')
    _video(show_root, "ep03", "episode-mastered.mp4", b"third")
    r = _run(runner, show_root, "ep03")
    assert r.returncode == 0, r.stderr
    assert (nas / "HarborLights S01E03.mp4").read_bytes() == b"third"


def test_the_lenient_ruled_grammar_is_the_one(show_root: Path, nas: Path, runner: Path) -> None:
    """F-10: a status cell carrying its own ruling history still counts as ruled. Pinning this
    to exactly `**RULED**` once dropped a finale from every board with no error raised."""
    _season_doc(show_root, 1,
                '| 3 | **RULED — REWRITTEN 2026-08-27** | **"Slack Water"** |\n')
    _video(show_root, "ep03", "episode-mastered.mp4", b"third")
    assert _run(runner, show_root, "ep03").returncode == 0
    assert (nas / "HarborLights S01E03.mp4").exists()


def test_an_unmapped_id_with_no_ruled_row_fails_naming_airmap(show_root: Path, nas: Path,
                                                              runner: Path) -> None:
    _video(show_root, "ep07", "episode-mastered.mp4", b"seventh")
    r = _run(runner, show_root, "ep07")
    assert r.returncode == 1
    assert "airMap" in r.stderr
    assert list(nas.iterdir()) == []


def test_a_collision_across_season_documents_writes_nothing(show_root: Path, nas: Path,
                                                            runner: Path) -> None:
    _season_doc(show_root, 1, '| 3 | **RULED** | **"One"** |\n')
    _season_doc(show_root, 2, '| 3 | **RULED** | **"Other"** |\n')
    _video(show_root, "ep03", "episode-mastered.mp4", b"third")
    r = _run(runner, show_root, "ep03")
    assert r.returncode == 1
    assert "more than one" in r.stderr
    assert list(nas.iterdir()) == []


def test_an_unmounted_nas_writes_nothing(show_root: Path, nas: Path) -> None:
    """Without the wrapper the temp directory is not a mount point, which is the real guard."""
    _video(show_root, "ep02", "episode-mastered.mp4", b"mastered-bytes")
    r = subprocess.run([sys.executable, str(SCRIPT), "ep02"],
                       cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 1
    assert "NAS not mounted" in r.stderr
    assert list(nas.iterdir()) == []


def test_a_missing_video_fails_rather_than_reporting_success(show_root: Path, nas: Path,
                                                             runner: Path) -> None:
    """The old sweep printed SKIP and still ended on FINALIZE_OK, which read as success to
    anything parsing the result line. One episode per step means one verdict."""
    r = _run(runner, show_root, "ep02")
    assert r.returncode == 1
    assert "no video to finalize" in r.stderr
    assert "FINALIZE_OK" not in r.stdout


def test_a_malformed_id_is_refused_before_any_season_scan(show_root: Path, nas: Path,
                                                          runner: Path) -> None:
    """`EP01` matches neither grammar, so it is an argv mistake, not an unplaced episode."""
    r = _run(runner, show_root, "EP01")
    assert r.returncode == 1
    assert "expected sXXeYY (aired) or epNN (production)" in r.stderr


def test_there_is_no_all_mode(show_root: Path, nas: Path, runner: Path) -> None:
    """The engine runs one episode per step; `all` was the sweep's interface and is gone."""
    _video(show_root, "ep02", "episode-mastered.mp4", b"mastered-bytes")
    r = _run(runner, show_root, "all")
    assert r.returncode == 1
    assert list(nas.iterdir()) == []


def test_season_docs_sort_numerically_not_lexicographically(show_root: Path,
                                                            monkeypatch) -> None:
    """season-10.md must not sort before season-2.md, which plain string order would do.

    monkeypatch.chdir, not os.chdir: this test runs the helper in-process, and a working
    directory left behind would follow every test after it in the session.
    """
    mod = load_script("finalize-video.py")
    for n in (1, 2, 10):
        _season_doc(show_root, n, "")
    monkeypatch.chdir(show_root)
    assert [n for n, _ in mod._season_docs("Canon")] == [1, 2, 10]
