"""design-visual.py — one candidate face per brief, through the shared Gemini client.

The subprocess to a model on Ryan's own machine and the per-subject seed were deleted on
2026-11-04 (spec 2026-11-04 §3.3): a candidate is one nano-banana call, text only, and the
variation between candidates is that each one has its own hand-written brief.

The seam is `nb.api_call`, patched on lib/nanobanana.py exactly as tests/test_nano_banana_generate.py
patches it — the library's `generate_image` calls it as a module global, so a patch there reaches
the designer without the designer knowing. That requires the script in this process, so main() is
called in-process with a built argv; the one test that asserts a real exit code
(test_a_briefs_file_that_is_not_a_list_is_refused) runs the script through subprocess instead,
which needs no patch because the refusal happens before any call.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import FIXTURES_DIR, SCRIPTS_DIR, load_script
from lib import nanobanana as nb

SCRIPT = SCRIPTS_DIR / "design-visual.py"
dv = load_script("design-visual.py")      # safe: the script guards main()

FIXTURE_CFG = json.loads((FIXTURES_DIR / "showrunner.json").read_text())
STYLE = FIXTURE_CFG["visual"]["styleConstants"]
CAND_DIR = FIXTURE_CFG["visual"]["candidatesDir"]
BRIEFS = ["a tall keeper, weathered, grey at the temples", "a short keeper, broad, clean-shaven"]


@pytest.fixture
def show(show_root: Path) -> Path:
    """The fixture show with one cast key, `vale`, and a two-brief file beside it."""
    (show_root / "Canon").mkdir(exist_ok=True)
    (show_root / "Canon/cast.json").write_text(json.dumps({"version": 1, "cast": {
        "vale": {"name": "Vale", "kind": "human", "speaks": True,
                 "baseline_prompt": "a keeper of the harbor light"},
    }}))
    (show_root / "briefs.json").write_text(json.dumps(BRIEFS))
    return show_root


def _run(show: Path, monkeypatch, *args: str) -> None:
    """Call main() in this process with the show root as the working directory."""
    monkeypatch.chdir(show)
    monkeypatch.setattr(sys, "argv", ["design-visual.py", *args])
    dv.main()


def _spy(monkeypatch) -> list[tuple[str, list]]:
    """Patch the one network call; -> the (prompt, image_parts) of each billed call."""
    seen: list[tuple[str, list]] = []

    def api_call(prompt, image_parts):
        seen.append((prompt, image_parts))
        return ("ok", b"PNGBYTES")

    monkeypatch.setattr(nb, "api_call", api_call)
    return seen


def test_one_candidate_per_brief_text_only(show: Path, monkeypatch, capsys) -> None:
    seen = _spy(monkeypatch)
    _run(show, monkeypatch, "vale", "--briefs", "briefs.json")
    out = capsys.readouterr().out
    for i, brief in enumerate(BRIEFS, 1):
        png = show / CAND_DIR / f"vale-{i}.png"
        assert png.read_bytes() == b"PNGBYTES"
        assert f"CANDIDATE {png}" in out
    assert len(seen) == 2                                  # one call per brief, no re-rolls
    for (prompt, parts), brief in zip(seen, BRIEFS):
        assert prompt == f"{brief}\n\n{STYLE}"             # the brief, then the show's look
        assert parts == []                                 # text only: a face conditions on nothing


def test_the_lock_instruction_names_the_casting_pile_and_the_index(show: Path, monkeypatch, capsys) -> None:
    """Picking is by eye and locking is by hand, so the two acts are printed every run."""
    _spy(monkeypatch)
    _run(show, monkeypatch, "vale", "--briefs", "briefs.json")
    out = capsys.readouterr().out
    assert f"cp {show / CAND_DIR}/<key>-<n>.png {FIXTURE_CFG['visual']['castingPileDir']}/<Name>/reference.png" in out
    assert "then set cast.<key>.face.ref to that path in Canon/cast.json" in out


def test_an_existing_candidate_is_kept(show: Path, monkeypatch, capsys) -> None:
    """A paid step is idempotent by the file on disk: a re-run bills only what is missing."""
    (show / CAND_DIR).mkdir(parents=True)
    kept = show / CAND_DIR / "vale-1.png"
    kept.write_bytes(b"ALREADY")
    seen = _spy(monkeypatch)
    _run(show, monkeypatch, "vale", "--briefs", "briefs.json")
    out = capsys.readouterr().out
    assert kept.read_bytes() == b"ALREADY"                 # untouched
    assert f"KEPT {kept}" in out
    assert len(seen) == 1 and seen[0][0] == f"{BRIEFS[1]}\n\n{STYLE}"
    assert "1 API call(s) billed." in out


def test_a_refusal_is_reported_and_the_run_exits_nonzero(show: Path, monkeypatch, capsys) -> None:
    monkeypatch.setattr(nb, "api_call", lambda prompt, parts: ("refused", None))
    with pytest.raises(SystemExit) as exc:
        _run(show, monkeypatch, "vale", "--briefs", "briefs.json")
    assert "2 of 2 candidates did not render" in str(exc.value)
    assert "FAILED" in capsys.readouterr().out


def test_an_unknown_subject_key_is_refused_before_any_call(show: Path, monkeypatch) -> None:
    seen = _spy(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        _run(show, monkeypatch, "pim", "--briefs", "briefs.json")
    assert "unknown subject 'pim'" in str(exc.value)
    assert seen == []


def _subprocess(show: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args, "--show-root", str(show)],
                          capture_output=True, text=True)


def test_a_briefs_file_that_is_not_a_list_is_refused(tmp_path: Path) -> None:
    shutil.copy(FIXTURES_DIR / "showrunner.json", tmp_path / "showrunner.json")
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/cast.json").write_text(json.dumps({"version": 1, "cast": {"vale": {"name": "Vale"}}}))
    (tmp_path / "briefs.json").write_text(json.dumps({"tall": "a tall keeper"}))
    r = _subprocess(tmp_path, "vale", "--briefs", "briefs.json")
    assert r.returncode != 0
    assert "briefs.json must hold a JSON list of non-empty brief strings" in r.stderr
