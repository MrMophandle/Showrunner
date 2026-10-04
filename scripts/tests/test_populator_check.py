"""populator-check.py — the pre-flight guard run as a step of its own.

Two prompts.json fixtures carry it: one whose character briefs are clean, one whose are not.
The distinction the test pins hardest is the exit code — 2 for a dirty brief, 1 for a broken
config — because the pipeline reads them differently and the operator fixes different files.

The third mode is `--report-only`, which the pipeline's first populator-check runs: the verdict
leaves on stdout and the exit code stays 0, so the engine records it as the step's result and the
run can route a dirty brief to a fix agent instead of stopping on it.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from conftest import SCRIPTS_DIR

SCRIPT = SCRIPTS_DIR / "populator-check.py"


def _episode(show_root: Path, episode_id: str, shots: list[dict]) -> None:
    base = show_root / "Production" / episode_id / "images"
    base.mkdir(parents=True, exist_ok=True)
    (base / "prompts.json").write_text(json.dumps({"shots": shots}))


def _run(show_root: Path, episode_id: str, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), episode_id, *flags],
                          cwd=str(show_root), capture_output=True, text=True)


CLEAN = [
    {"id": "s1-maeve", "type": "character",
     "brief": "MAEVE alone at the lamp, no other figures in the frame."},
    {"id": "s2-table", "type": "character",
     "brief": "Three people at the table: MAEVE, the harbourmaster, and the boy."},
    {"id": "s3-sea", "type": "ambient", "brief": "grey sea horizon, a crowd of gulls"},
]

DIRTY = [
    {"id": "s1-maeve", "type": "character", "brief": "MAEVE and the crew at the winch."},
    {"id": "s2-quay", "type": "character", "brief": "A crowd on the quay, waiting."},
    {"id": "s3-clean", "type": "character", "brief": "MAEVE alone."},
]

# One offending brief among several, so the report-only line's count and its id list are both
# pinned to something a two-offender fixture could not distinguish.
ONE_DIRTY = [
    {"id": "s04-lamp", "type": "character", "brief": "MAEVE alone at the lamp."},
    {"id": "s05-crowd", "type": "character", "brief": "A crowd on the quay, waiting."},
]


def test_a_clean_episode_prints_the_result_line_and_exits_zero(show_root: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    r = _run(show_root, "ep01")
    assert r.returncode == 0, r.stderr
    # Two character shots; the ambient shot is not a character brief and is not counted.
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_OK 2 briefs"


def test_an_ambient_brief_is_never_judged(show_root: Path) -> None:
    """The ambient shot in CLEAN says "a crowd of gulls" — a banned phrase in a brief the law
    does not govern. Only type:"character" briefs invent uncredited people."""
    _episode(show_root, "ep01", CLEAN)
    assert _run(show_root, "ep01").returncode == 0


def test_a_dirty_episode_exits_two_and_names_every_offending_shot(show_root: Path) -> None:
    _episode(show_root, "ep01", DIRTY)
    r = _run(show_root, "ep01")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "s1-maeve: matched the crew" in r.stderr
    assert "s2-quay: matched A crowd" in r.stderr
    assert "s3-clean" not in r.stderr
    assert "POPULATORS_OK" not in r.stdout


def test_a_dirty_episode_names_the_shows_style_document(show_root: Path) -> None:
    _episode(show_root, "ep01", DIRTY)
    r = _run(show_root, "ep01")
    assert "Canon/visual-style.md" in r.stderr


def test_a_renamed_production_directory_is_honoured(show_root: Path) -> None:
    """The input is read from `productionDir`, not from a hardcoded "Production".

    One script standing in for the eighteen that build a path on sc.production_dir: every other
    test here leaves the fixture's `"productionDir": "Production"` in place, so only this one would
    notice a step that went back to the literal. The refusal names the configured directory too,
    because the operator has to open the file the step actually read.
    """
    cfg = json.loads((show_root / "showrunner.json").read_text())
    cfg["productionDir"] = "Work"
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    base = show_root / "Work" / "ep01" / "images"
    base.mkdir(parents=True)
    (base / "prompts.json").write_text(json.dumps({"shots": DIRTY}))

    r = _run(show_root, "ep01")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "Work/ep01/images/prompts.json" in r.stderr
    assert "Production/ep01" not in r.stderr


def test_progress_reports_one_unit_per_brief(show_root: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    lines = [l for l in _run(show_root, "ep01").stdout.splitlines() if l.startswith("::progress")]
    assert [json.loads(l[len("::progress "):]) for l in lines] == [
        {"done": 1, "total": 2, "unit": "briefs"},
        {"done": 2, "total": 2, "unit": "briefs"},
    ]


def test_a_broken_config_exits_one_not_two(show_root: Path) -> None:
    """Exit 2 means "the briefs are wrong"; a config fault must not borrow that code."""
    _episode(show_root, "ep01", CLEAN)
    cfg = json.loads((show_root / "showrunner.json").read_text())
    del cfg["visual"]["collectivePopulatorBans"]
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    r = _run(show_root, "ep01")
    assert r.returncode == 1
    assert "visual.collectivePopulatorBans is missing" in r.stderr
    assert len(r.stderr.strip().splitlines()) == 1


def test_a_missing_prompts_file_is_one_line_on_stderr(show_root: Path) -> None:
    r = _run(show_root, "ep07")
    assert r.returncode == 1
    assert len(r.stderr.strip().splitlines()) == 1
    assert r.stderr.startswith("populator-check: ")


def test_the_show_root_flag_works_from_elsewhere(show_root: Path, tmp_path: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "ep01", f"--show-root={show_root}"],
                       cwd=str(elsewhere), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_OK 2 briefs"


def test_progress_is_emitted_as_each_brief_is_judged(show_root: Path) -> None:
    """The line goes inside the loop, not after it: a run that refuses on brief 40 of 50 should
    have reported 39 units first, not none."""
    from conftest import load_script

    mod = load_script("populator-check.py")
    seen: list[tuple[int, int]] = []
    shots = [{"id": f"s{n}", "type": "character", "brief": "MAEVE alone."} for n in range(1, 4)]
    _, found = mod.check(shots, ["the crew"], on_judged=lambda d, t: seen.append((d, t)))
    assert found == []
    assert seen == [(1, 3), (2, 3), (3, 3)]


def test_a_dirty_brief_still_reports_the_units_judged_before_it(show_root: Path) -> None:
    _episode(show_root, "ep01", DIRTY)
    out = _run(show_root, "ep01").stdout
    lines = [json.loads(l[len("::progress "):])
             for l in out.splitlines() if l.startswith("::progress")]
    # All three briefs are judged before the refusal is printed.
    assert lines == [{"done": n, "total": 3, "unit": "briefs"} for n in (1, 2, 3)]


# ── --report-only: the verdict as a result line the pipeline can branch on ────────────────────

def test_report_only_names_the_dirty_briefs_on_stdout_and_exits_zero(show_root: Path) -> None:
    """The pipeline's `populator-check` step runs `--report-only` so the verdict reaches the
    engine as the step's RESULT (`engine/src/script-step.ts` records the last stdout line only on
    a clean exit). `visual-direction-fix` and `populator-check-final` both branch on it with
    `String(ctx.results["populator-check"]).startsWith("POPULATORS_BAD")`; an exit 2 would fail
    the step instead, and the fix agent would never be reached."""
    _episode(show_root, "ep01", ONE_DIRTY)
    r = _run(show_root, "ep01", "--report-only")
    assert r.returncode == 0, r.stderr
    assert re.match(r"^POPULATORS_BAD 1 briefs: s05-crowd$", r.stdout.strip().splitlines()[-1])


def test_report_only_still_puts_the_per_brief_detail_on_stderr(show_root: Path) -> None:
    """stdout carries the machine-readable verdict; the operator's detail is unchanged."""
    _episode(show_root, "ep01", ONE_DIRTY)
    r = _run(show_root, "ep01", "--report-only")
    assert "s05-crowd: matched A crowd" in r.stderr
    assert "s04-lamp" not in r.stderr


def test_report_only_on_a_clean_episode_is_the_ordinary_ok_line(show_root: Path) -> None:
    _episode(show_root, "ep01", CLEAN)
    r = _run(show_root, "ep01", "--report-only")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_OK 2 briefs"


def test_without_the_flag_a_dirty_episode_still_exits_two(show_root: Path) -> None:
    """`populator-check-final` runs the plain mode after the fix agent: there the dirty brief is
    a hard stop before the image branch spends money, exactly as before the flag existed."""
    _episode(show_root, "ep01", ONE_DIRTY)
    r = _run(show_root, "ep01")
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    assert "POPULATORS_BAD" not in r.stdout


def test_the_flag_is_removed_before_the_episode_id_is_read(show_root: Path, tmp_path: Path) -> None:
    """The episode id is positional (`sys.argv[1]`), so a flag left in argv ahead of it becomes
    the id. `sc.show_root` strips its own flag in place for this reason; `--report-only` follows
    the same rule, and an operator's argument order does not change which episode is checked."""
    _episode(show_root, "ep01", ONE_DIRTY)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "--report-only", "ep01",
                        "--show-root", str(show_root)],
                       cwd=str(elsewhere), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "POPULATORS_BAD 1 briefs: s05-crowd"
