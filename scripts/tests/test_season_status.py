"""season-status.py — the deterministic board, reading the one airMap every script shares.

F-14: the air map used to be regex-parsed out of finalize-video.py's source, so the board and the
finalizer could disagree about which rows existed. Both now read showrunner.json.

F-10: a status cell carrying its own ruling history still parses as RULED — the regression that
once dropped a finale from every board.

Most of this file is the show repository's own `test_season_status.py` (commit `edb9c1e`), ported
to the `cfg`-first signatures. The three cases that could not come across tested the mechanisms
this task deleted — the air-map regex over another script's source, that script's literal map,
and the NAS environment override — and their coverage is re-expressed here against `airMap` and
`output.nasRoot` instead.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import SCRIPTS_DIR, load_script

SCRIPT = SCRIPTS_DIR / "season-status.py"

SEASON_DOC = """# Season 1
| # | Status | Entry |
|---|--------|-------|
| 1 | **RULED** | Pilot rewrite, beats LOCKED at `Episodes/ep01/locked-beats.md` |
| 2 | **RULED** | **"Margin"** — pure standalone; proves the baseline week. |
| 9 | **RULED** | **"Slack Water"** (produced as ep98) airs here. |
"""

SEASON2_DOC = """# Season 2
| # | Status | Entry |
|---|--------|-------|
| 1 | **RULED** | **"Origin"** — the one that starts it over. |
"""


def _write_cfg(show_root: Path, *, air_map: dict, nas: Path) -> dict:
    """Point the fixture config's airMap and NAS at this test's temp directories."""
    cfg = json.loads((show_root / "showrunner.json").read_text())
    cfg["airMap"] = air_map
    cfg["output"]["nasRoot"] = str(nas)
    (show_root / "showrunner.json").write_text(json.dumps(cfg))
    return cfg


def _mk_repo(show_root: Path, with_nas: bool = True):
    """The season-1 fixture: ep98 ruled but unstarted, ep02 in progress, ep01 final on the NAS.

    The air map is `showrunner.json`'s, not a dict parsed out of another script's source — the
    whole point of F-14 — and the NAS directory is `output.nasRoot`.
    """
    (show_root / "Canon").mkdir(exist_ok=True)
    (show_root / "Canon/season-1.md").write_text(SEASON_DOC)
    nas = show_root / "NAS"
    cfg = _write_cfg(show_root,
                     air_map={"ep01": [1, 1], "ep02": [1, 2], "ep98": [1, 9]},
                     nas=nas)
    # ep02: script + audio + images stamped, images 2/2 on disk
    (show_root / "Episodes/ep02").mkdir(parents=True)
    (show_root / "Episodes/ep02/STATUS.md").write_text(
        "# STATUS — ep02\n- 2026-07-15 script: c\n- 2026-07-16 audio: a\n"
        "- 2026-07-16 images: i\n")
    img = show_root / "Production/ep02/images"
    img.mkdir(parents=True)
    (img / "prompts.json").write_text(json.dumps({"shots": [{"id": "s1-a"}, {"id": "s2-b"}]}))
    (img / "s1-a.png").write_bytes(b"x")
    (img / "s2-b.png").write_bytes(b"x")
    # ep01: finalized + on NAS
    (show_root / "Episodes/ep01").mkdir(parents=True)
    (show_root / "Episodes/ep01/STATUS.md").write_text(
        "# STATUS — ep01\n- 2026-07-01 finalized: pushed to NAS\n")
    if with_nas:
        nas.mkdir()
        (nas / "HarborLights S01E01.mp4").write_bytes(b"mp4")
    return cfg, str(show_root), str(nas)


def _mk_repo_s2(show_root: Path, with_nas: bool = True, finalized: bool = False,
                nas_filename: str = "HarborLights S02E01.mp4"):
    (show_root / "Canon").mkdir(exist_ok=True)
    (show_root / "Canon/season-2.md").write_text(SEASON2_DOC)
    nas = show_root / "NAS"
    cfg = _write_cfg(show_root, air_map={"ep01": [1, 1], "ep20": [2, 1]}, nas=nas)
    if finalized:
        (show_root / "Episodes/ep20").mkdir(parents=True)
        (show_root / "Episodes/ep20/STATUS.md").write_text(
            "# STATUS — ep20\n- 2026-08-01 finalized: pushed to NAS\n")
    if with_nas:
        nas.mkdir()
        if finalized:
            (nas / nas_filename).write_bytes(b"mp4")
    return cfg, str(show_root), str(nas)


def _run(root, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args],
                          cwd=str(root), capture_output=True, text=True, timeout=30)


# ── the parsers ───────────────────────────────────────────────────────────────────────────────

def test_parse_season_table_titles_and_pilot_fallback() -> None:
    ss = load_script("season-status.py")
    rows = ss.parse_season_table(SEASON_DOC)
    assert [r["air"] for r in rows] == [1, 2, 9]
    assert rows[0]["title"] == "(pilot)"          # no quoted title on the pilot row
    assert rows[1]["title"] == "Margin"
    assert rows[2]["title"] == "Slack Water"


def test_the_strict_grammar_would_have_dropped_the_row() -> None:
    """F-10. A status cell may carry its OWN ruling history and still count as ruled; pinning
    this to exactly `**RULED**` dropped a finale from every board with no error raised."""
    ss = load_script("season-status.py")
    doc = """# Season 1
| Ep | Status | Job |
|---|---|---|
| 9 | **RULED** | **"The Working Day, Part One"** — ordinary danger |
| 10 | **RULED — REWRITTEN 2026-08-27** | **"The Working Day, Part Two"** — the finale |
"""
    rows = ss.parse_season_table(doc)
    assert [r["air"] for r in rows] == [9, 10]
    assert rows[1]["title"] == "The Working Day, Part Two"


def test_losing_the_bold_markers_still_parses_to_nothing() -> None:
    """Format drift must be visible as an empty board, not absorbed silently."""
    ss = load_script("season-status.py")
    drifted = """# Season 1
| # | Status | Entry |
|---|--------|-------|
| 1 | RULED | Pilot rewrite |
| 2 | RULED | "Margin" — pure standalone |
"""
    assert ss.parse_season_table(drifted) == []


def test_episode_milestones_parses_status_lines() -> None:
    ss = load_script("season-status.py")
    txt = ("# STATUS — ep02\n"
           "- 2026-07-15 script: committed abc123\n"
           "- 2026-07-16 audio: mix approved (-14 LUFS)\n")
    assert ss.episode_milestones(txt) == {"script", "audio"}


def test_the_air_map_is_inverted_per_season_from_config() -> None:
    """Replaces the deleted `test_parse_air_map_inversion_and_default`: same property, read from
    showrunner.json's airMap instead of regex-parsed out of finalize-video.py's source (F-14)."""
    ss = load_script("season-status.py")
    cfg = {"airMap": {"ep01": [1, 1], "ep02": [1, 2], "ep98": [1, 9], "ep20": [2, 1]}}
    m = ss.air_map_for_season(cfg, 1)
    assert m[9] == "ep98"                          # explicit mapping wins
    assert m[1] == "ep01" and m[2] == "ep02"
    assert 1 not in ss.air_map_for_season(cfg, 2) or ss.air_map_for_season(cfg, 2)[1] == "ep20"
    # air slots absent from the map default at lookup time
    assert ss.prod_id_for(5, m) == "ep05"


def test_the_air_map_respects_the_season_parameter() -> None:
    """Replaces the deleted `test_parse_air_map_respects_season_param`."""
    ss = load_script("season-status.py")
    cfg = {"airMap": {"ep01": [1, 1], "ep20": [2, 1]}}
    m = ss.air_map_for_season(cfg, 2)
    assert m == {1: "ep20"}                        # only the season-2 entry
    assert ss.prod_id_for(1, m) == "ep20"


def test_a_malformed_airmap_entry_is_skipped_rather_than_fatal() -> None:
    """The board is read-only and reports problems; it must not refuse to draw."""
    ss = load_script("season-status.py")
    cfg = {"airMap": {"ep01": [1, 1], "ep02": "not-a-slot", "ep03": [2, 3]}}
    assert ss.air_map_for_season(cfg, 1) == {1: "ep01"}


# ── board() over the season-1 fixture ─────────────────────────────────────────────────────────

def test_board_states_unstarted_final_and_progress(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert ok and problems == []
    assert "ruled/unstarted" in md and "ep98" in md      # E9 row present, unstarted
    assert "FINAL on NAS" in md                          # ep01
    assert "assemble-episode" in md                      # ep02 next action (audio+images done)
    assert "2/2" in md                                   # image count


def test_episode_dir_holding_only_a_launch_premise_is_still_unstarted(show_root: Path) -> None:
    """The season desk WRITES Episodes/<ep>/launch-premise.md as its final act, before a word of
    the episode exists. Treating "the directory is here" as "drafting has started" flipped every
    desk-prepped episode to `started (no milestones)` and offered a resume of a session that was
    never begun."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    ep_dir = os.path.join(root, "Episodes/ep98")
    os.makedirs(ep_dir, exist_ok=True)
    open(os.path.join(ep_dir, "launch-premise.md"), "w").write("# ep98 premise\n")
    data = ss.board_json(cfg, root=root, nas_dest=nas)
    row = [e for e in data["episodes"] if e["prod"] == "ep98"][0]
    assert row["label"] == "ruled/unstarted"
    assert row["next"] == "write-episode"


def test_episode_dir_with_real_drafting_is_started(show_root: Path) -> None:
    """The guard on the fix above: an outline IS drafting evidence, even with no STATUS.md yet."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    ep_dir = os.path.join(root, "Episodes/ep98")
    os.makedirs(ep_dir, exist_ok=True)
    open(os.path.join(ep_dir, "launch-premise.md"), "w").write("# premise\n")
    open(os.path.join(ep_dir, "outline.md"), "w").write("# outline\n")
    data = ss.board_json(cfg, root=root, nas_dest=nas)
    row = [e for e in data["episodes"] if e["prod"] == "ep98"][0]
    assert row["label"] == "started (no milestones)"


def test_board_finalized_but_missing_on_nas_is_partial(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    os.remove(os.path.join(nas, "HarborLights S01E01.mp4"))
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert not ok and any("missing on NAS" in p for p in problems)


def test_board_unmounted_nas_is_partial_not_crash(show_root: Path) -> None:
    """The NAS needs remounting by hand after every reboot, so this path is walked often."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root, with_nas=False)
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert not ok and any("NAS" in p for p in problems)
    assert "unknown (NAS unmounted)" in md


def test_board_malformed_prompts_json_degrades_gracefully(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    (show_root / "Production/ep02/images/prompts.json").write_text("{not json")
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert not ok and any("prompts.json unreadable" in p for p in problems)
    assert "?" in md                     # image column shows ?
    assert "FINAL on NAS" in md          # other rows unaffected


def test_board_prompts_shot_missing_id_degrades_gracefully(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    img = show_root / "Production/ep02/images"
    (img / "prompts.json").write_text(json.dumps(
        {"shots": [{"id": "s1-a"}, {"name": "bad_shot"}]}))
    (img / "s1-a.png").write_bytes(b"x")
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert not ok and any("prompts.json unreadable" in p for p in problems)
    assert "?" in md
    assert "FINAL on NAS" in md


def test_board_missing_season_doc_returns_empty_board(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    os.remove(os.path.join(root, "Canon/season-1.md"))
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert not ok and any("Canon/season-1.md unreadable" in p for p in problems)
    assert md == ""                       # board is empty, with no header at all


def test_board_no_ruled_rows_parsed_flags_problem(show_root: Path) -> None:
    """Table format drift (asterisks lost) must not report SEASON_STATUS_OK on an empty board."""
    ss = load_script("season-status.py")
    (show_root / "Canon").mkdir(exist_ok=True)
    (show_root / "Canon/season-1.md").write_text(
        "# Season 1\n| # | Status | Entry |\n|---|--------|-------|\n"
        "| 1 | RULED | Pilot rewrite (asterisks lost) |\n")
    nas = show_root / "NAS"
    nas.mkdir()
    cfg = _write_cfg(show_root, air_map={"ep01": [1, 1]}, nas=nas)
    md, ok, problems = ss.board(cfg, root=str(show_root), nas_dest=str(nas))
    assert ok is False
    assert any("no RULED rows parsed — board is empty" in p for p in problems)


def test_an_unmapped_row_falls_back_to_its_default_production_id(show_root: Path) -> None:
    """Replaces the deleted `test_board_missing_finalize_video_uses_default_ids`: with no airMap
    entry for air 9, the E9 row shows the default ep09 rather than an override."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    cfg["airMap"] = {}
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert "| E9 | ep09 |" in md


def test_the_air_map_comes_from_config_not_from_another_scripts_source(show_root: Path) -> None:
    """F-14. An airMap entry placing a differently-numbered production id at row 1 must change
    the board, which proves the board reads showrunner.json."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    cfg["airMap"] = {"ep42": [1, 1]}
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas)
    assert "| E1 | ep42 |" in md


# ── main()'s trailer strings, which the workflow consumes verbatim ────────────────────────────

def test_main_prints_ok_trailer_on_clean_fixture(show_root: Path) -> None:
    _mk_repo(show_root)
    result = _run(show_root)
    assert result.returncode == 0
    assert "SEASON_STATUS_OK" in result.stdout


def test_main_prints_partial_trailer_with_count_on_one_problem_fixture(show_root: Path) -> None:
    _, root, nas = _mk_repo(show_root)
    os.remove(os.path.join(nas, "HarborLights S01E01.mp4"))
    result = _run(show_root)
    assert result.returncode == 0
    assert "SEASON_STATUS_PARTIAL: 1 problem(s)" in result.stdout


def test_a_lenient_ruled_row_is_listed(show_root: Path) -> None:
    """The brief's own assertion, end to end through the script."""
    (show_root / "Canon").mkdir(exist_ok=True)
    (show_root / "Canon/season-1.md").write_text(
        "| Air | Status | Title |\n|---|---|---|\n"
        '| 1 | **RULED — REWRITTEN 2026-08-27** | **"Slack Water"** — the pilot. |\n')
    nas = show_root / "NAS"
    nas.mkdir()
    _write_cfg(show_root, air_map={"ep01": [1, 1]}, nas=nas)
    ep = show_root / "Episodes" / "ep01"
    ep.mkdir(parents=True)
    (ep / "STATUS.md").write_text("# STATUS — ep01\n\n- 2026-09-01 script: script.md\n")
    r = _run(show_root)
    assert r.returncode == 0, r.stderr
    assert "| E1 | ep01 | Slack Water |" in r.stdout
    assert "| script |" in r.stdout and "produce-assets" in r.stdout


def test_a_missing_season_document_is_reported_not_raised(show_root: Path) -> None:
    r = _run(show_root, "s3")
    assert r.returncode == 0
    assert "SEASON_STATUS_PARTIAL" in r.stdout
    assert "season-3.md unreadable" in r.stdout


# ── board_json() and --json, the console's structured board ───────────────────────────────────

def test_board_json_shape(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root, with_nas=True)
    data = ss.board_json(cfg, root=root, nas_dest=nas)
    assert data["ok"] is True
    assert data["problems"] == []
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep02"]["state"] == "images"           # last milestone present
    assert eps["ep02"]["label"] == "images"
    assert eps["ep02"]["images"] == {"have": 2, "total": 2}
    assert eps["ep02"]["next"] == "assemble-episode"
    assert set(eps["ep02"]["milestones"]) == {"script", "audio", "images"}
    assert eps["ep02"]["milestones"] == sorted(eps["ep02"]["milestones"])
    assert eps["ep01"]["state"] == "final-on-nas"
    assert eps["ep01"]["label"] == "FINAL on NAS"
    assert eps["ep01"]["images"] is None               # no Production/ep01/images in the fixture
    assert eps["ep01"]["next"] == "—"
    assert eps["ep98"]["state"] == "ruled-unstarted"   # no Episodes/ep98 dir in the fixture
    assert eps["ep98"]["images"] is None


def test_board_json_enum_for_special_states(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, _ = _mk_repo(show_root, with_nas=False)
    (show_root / "Episodes/ep02/STATUS.md").write_text(
        "# STATUS — ep02\n- 2026-07-20 finalized: pushed\n")
    data = ss.board_json(cfg, root=root, nas_dest=str(show_root / "no-such-nas"))
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep02"]["state"] == "unknown-nas-unmounted"
    assert eps["ep02"]["label"] == "unknown (NAS unmounted)"
    assert any("NAS unmounted" in p for p in data["problems"])


def test_board_json_missing_season_doc_yields_empty_episode_list(show_root: Path) -> None:
    """board() returns "" here via the board_rows() None sentinel; board_json() must degrade that
    to an empty episodes list rather than propagate None into the JSON payload."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    os.remove(os.path.join(root, "Canon/season-1.md"))
    data = ss.board_json(cfg, root=root, nas_dest=nas)
    assert data["ok"] is False
    assert data["episodes"] == []
    assert any("Canon/season-1.md unreadable" in p for p in data["problems"])


def test_cli_json_flag_prints_json(show_root: Path) -> None:
    _mk_repo(show_root, with_nas=True)
    out = _run(show_root, "--json")
    data = json.loads(out.stdout)          # the WHOLE stdout is the JSON
    assert "episodes" in data and "problems" in data


def test_board_and_board_json_agree_on_markdown_equivalent_fixture(show_root: Path) -> None:
    """board()'s rendered label/images/next text must match what board_json() reports for the
    same row, so the two renderers can never silently drift apart."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo(show_root)
    md, md_ok, md_problems = ss.board(cfg, root=root, nas_dest=nas)
    data = ss.board_json(cfg, root=root, nas_dest=nas)
    assert md_ok == data["ok"]
    assert md_problems == data["problems"]
    for ep in data["episodes"]:
        assert f"| E{ep['air']} | {ep['prod']} | {ep['title']} | {ep['label']} |" in md


# ── season selection: a season exists iff its document exists ─────────────────────────────────

def test_board_season_param_reads_season_n_doc_not_season_1(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo_s2(show_root)
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas, season=2)
    assert "Origin" in md and "ep20" in md
    assert ok and problems == []


def test_board_season_param_uses_season_n_in_nas_filename(show_root: Path) -> None:
    """ep20 is stamped finalized and the NAS file is named for SEASON 2 (S02E01), not S01E01."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo_s2(show_root, finalized=True,
                                 nas_filename="HarborLights S02E01.mp4")
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas, season=2)
    assert ok and problems == []
    assert "FINAL on NAS" in md


def test_board_season_param_wrong_nas_name_is_missing_not_found(show_root: Path) -> None:
    """The same fixture with a season-1-style name proves the lookup is season-sensitive rather
    than accidentally season-agnostic."""
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo_s2(show_root, finalized=True,
                                 nas_filename="HarborLights S01E01.mp4")
    md, ok, problems = ss.board(cfg, root=root, nas_dest=nas, season=2)
    assert not ok
    assert any("missing on NAS" in p for p in problems)


def test_board_json_season_param(show_root: Path) -> None:
    ss = load_script("season-status.py")
    cfg, root, nas = _mk_repo_s2(show_root)
    data = ss.board_json(cfg, root=root, nas_dest=nas, season=2)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep20"]["title"] == "Origin"
    assert eps["ep20"]["air"] == 1


def test_main_cli_season_arg_reads_season_n_doc(show_root: Path) -> None:
    _mk_repo_s2(show_root)
    result = _run(show_root, "s2")
    assert result.returncode == 0
    assert "Origin" in result.stdout and "ep20" in result.stdout
    assert "SEASON_STATUS_OK" in result.stdout


def test_main_cli_season_arg_with_json_flag(show_root: Path) -> None:
    _mk_repo_s2(show_root)
    data = json.loads(_run(show_root, "s2", "--json").stdout)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep20"]["title"] == "Origin"


def test_main_cli_defaults_to_season_1_when_no_sN_arg(show_root: Path) -> None:
    """A bare --json (no "sN" token) must still mean season 1: the default has to survive
    alongside the flag-parsing loop."""
    _mk_repo(show_root)
    data = json.loads(_run(show_root, "--json").stdout)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert "ep01" in eps and "ep98" in eps        # the season-1 fixture's rows
