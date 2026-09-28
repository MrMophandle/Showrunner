import importlib.util, json, os, subprocess, sys

def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "season_status", os.path.join(here, "season-status.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # safe: script guards main()
    return mod

ss = _load()

SEASON_DOC = """# Season 1
| # | Status | Entry |
|---|--------|-------|
| 1 | **RULED** | Pilot rewrite, beats LOCKED at `Episodes/ep01/locked-beats.md` |
| 2 | **RULED** | **"Margin"** — pure standalone, zero Mute; proves the baseline week. |
| 9 | **RULED** | **"The Wick"** (produced as ep98) airs here. Simple non-Mute crisis. |
"""

FINALIZE_TEXT = '''
SEASON_MAP = {
    "ep01": (1, 1),
    "ep02": (1, 2),
    "ep98": (1, 9),   # airs as S1E9
}
'''

def test_parse_season_table_titles_and_pilot_fallback():
    rows = ss.parse_season_table(SEASON_DOC)
    assert [r["air"] for r in rows] == [1, 2, 9]
    assert rows[0]["title"] == "(pilot)"          # no quoted title on the pilot row
    assert rows[1]["title"] == "Margin"
    assert rows[2]["title"] == "The Wick"

def test_parse_season_table_accepts_a_ruled_cell_carrying_its_own_history():
    # season-1.md's E10 row states its ruling history inside the status cell:
    # `**RULED — REWRITTEN 2026-08-27**`. Pinning that cell to EXACTLY
    # `**RULED**` dropped the finale from every board with no error anywhere —
    # the console's season strip, the season desk's board table, and --json
    # alike all showed nine episodes and no E10.
    doc = """# Season 1
| Ep | Status | Job |
|---|---|---|
| 9 | **RULED** | **"The Working Day, Part One"** — ordinary danger |
| 10 | **RULED — REWRITTEN 2026-08-27** | **"The Working Day, Part Two"** — the finale |
"""
    rows = ss.parse_season_table(doc)
    assert [r["air"] for r in rows] == [9, 10]
    assert rows[1]["title"] == "The Working Day, Part Two"

def test_parse_air_map_inversion_and_default():
    m = ss.parse_air_map(FINALIZE_TEXT)
    assert m[9] == "ep98"                          # explicit mapping wins
    assert m[1] == "ep01" and m[2] == "ep02"
    # air slots absent from the map default at lookup time:
    assert ss.prod_id_for(5, m) == "ep05"

def test_episode_milestones_parses_status_lines():
    txt = ("# STATUS — ep02\n"
           "- 2026-07-15 script: committed abc123\n"
           "- 2026-07-16 audio: mix approved (-14 LUFS)\n")
    assert ss.episode_milestones(txt) == {"script", "audio"}

def _mk_repo(tmp_path, with_nas=True):
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(SEASON_DOC)
    (tmp_path / ".archon/scripts").mkdir(parents=True)
    (tmp_path / ".archon/scripts/finalize-video.py").write_text(FINALIZE_TEXT)
    # ep02: script+audio+images stamped, images 2/2 on disk
    (tmp_path / "Episodes/ep02").mkdir(parents=True)
    (tmp_path / "Episodes/ep02/STATUS.md").write_text(
        "# STATUS — ep02\n- 2026-07-15 script: c\n- 2026-07-16 audio: a\n- 2026-07-16 images: i\n")
    img = tmp_path / "Production/ep02/images"; img.mkdir(parents=True)
    img.joinpath("prompts.json").write_text(json.dumps(
        {"shots": [{"id": "s1-a"}, {"id": "s2-b"}]}))
    img.joinpath("s1-a.png").write_bytes(b"x"); img.joinpath("s2-b.png").write_bytes(b"x")
    # ep01: finalized + on NAS
    (tmp_path / "Episodes/ep01").mkdir(parents=True)
    (tmp_path / "Episodes/ep01/STATUS.md").write_text(
        "# STATUS — ep01\n- 2026-07-01 finalized: pushed to NAS\n")
    nas = tmp_path / "NAS"
    if with_nas:
        nas.mkdir()
        (nas / "DeadLight S01E01.mp4").write_bytes(b"mp4")
    return str(tmp_path), str(nas)

def test_board_states_unstarted_final_and_progress(tmp_path):
    root, nas = _mk_repo(tmp_path)
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert ok and problems == []
    assert "ruled/unstarted" in md and "ep98" in md      # E9 row present, unstarted
    assert "FINAL on NAS" in md                           # ep01
    assert "assemble-episode" in md                       # ep02 next action (audio+images done)
    assert "2/2" in md                                    # image count

def test_episode_dir_holding_only_a_launch_premise_is_still_unstarted(tmp_path):
    # The season desk WRITES Episodes/<ep>/launch-premise.md as its final act,
    # before a word of the episode exists. Treating "the directory is here" as
    # "drafting has started" flipped every desk-prepped episode to
    # `started (no milestones)` and offered `write-episode (resume)` — a
    # resume of a drafting session that was never begun.
    root, nas = _mk_repo(tmp_path)
    ep_dir = os.path.join(root, "Episodes/ep98")   # air 9 in this fixture
    os.makedirs(ep_dir, exist_ok=True)
    open(os.path.join(ep_dir, "launch-premise.md"), "w").write("# ep98 premise\n")
    data = ss.board_json(root=root, nas_dest=nas)
    row = [e for e in data["episodes"] if e["prod"] == "ep98"][0]
    assert row["label"] == "ruled/unstarted"
    assert row["next"] == "write-episode"

def test_episode_dir_with_real_drafting_is_started(tmp_path):
    # The guard on the fix above: an outline IS drafting evidence, even with
    # no STATUS.md yet.
    root, nas = _mk_repo(tmp_path)
    ep_dir = os.path.join(root, "Episodes/ep98")
    os.makedirs(ep_dir, exist_ok=True)
    open(os.path.join(ep_dir, "launch-premise.md"), "w").write("# premise\n")
    open(os.path.join(ep_dir, "outline.md"), "w").write("# outline\n")
    data = ss.board_json(root=root, nas_dest=nas)
    row = [e for e in data["episodes"] if e["prod"] == "ep98"][0]
    assert row["label"] == "started (no milestones)"

def test_board_finalized_but_missing_on_nas_is_partial(tmp_path):
    root, nas = _mk_repo(tmp_path)
    os.remove(os.path.join(nas, "DeadLight S01E01.mp4"))
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("missing on NAS" in p for p in problems)

def test_board_unmounted_nas_is_partial_not_crash(tmp_path):
    root, nas = _mk_repo(tmp_path, with_nas=False)
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("NAS" in p for p in problems)
    assert "unknown (NAS unmounted)" in md

def test_board_malformed_prompts_json_degrades_gracefully(tmp_path):
    root, nas = _mk_repo(tmp_path)
    # Overwrite prompts.json with invalid JSON
    img = tmp_path / "Production/ep02/images"
    img.joinpath("prompts.json").write_text("{not json")
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("prompts.json unreadable" in p for p in problems)
    assert "?" in md  # image column shows ?
    assert "FINAL on NAS" in md  # other rows unaffected

def test_board_prompts_shot_missing_id_degrades_gracefully(tmp_path):
    root, nas = _mk_repo(tmp_path)
    # Write a shot object without 'id' field
    img = tmp_path / "Production/ep02/images"
    img.joinpath("prompts.json").write_text(json.dumps(
        {"shots": [{"id": "s1-a"}, {"name": "bad_shot"}]}))
    img.joinpath("s1-a.png").write_bytes(b"x")
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("prompts.json unreadable" in p for p in problems)
    assert "?" in md  # image column shows ?
    assert "FINAL on NAS" in md

def test_board_missing_season_doc_returns_empty_board(tmp_path):
    root, nas = _mk_repo(tmp_path)
    os.remove(os.path.join(root, "Canon/season-1.md"))
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("Canon/season-1.md unreadable" in p for p in problems)
    assert md == ""  # board is empty

def test_board_missing_finalize_video_uses_default_ids(tmp_path):
    root, nas = _mk_repo(tmp_path)
    os.remove(os.path.join(root, ".archon/scripts/finalize-video.py"))
    md, ok, problems = ss.board(root=root, nas_dest=nas)
    assert not ok and any("finalize-video.py unreadable" in p for p in problems)
    assert "| E9 | ep09 |" in md  # E9 row shows default ep09, not ep98

def test_board_season_table_with_no_ruled_rows_is_empty_and_partial():
    # Table format drift (asterisks lost) -> parse_season_table returns [] ->
    # board() must NOT report SEASON_STATUS_OK on an empty board.
    drifted_doc = """# Season 1
| # | Status | Entry |
|---|--------|-------|
| 1 | RULED | Pilot rewrite |
| 2 | RULED | "Margin" — pure standalone |
"""
    rows = ss.parse_season_table(drifted_doc)
    assert rows == []

def test_board_no_ruled_rows_parsed_flags_problem(tmp_path):
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "# Season 1\n| # | Status | Entry |\n|---|--------|-------|\n"
        "| 1 | RULED | Pilot rewrite (asterisks lost) |\n")
    (tmp_path / ".archon/scripts").mkdir(parents=True)
    (tmp_path / ".archon/scripts/finalize-video.py").write_text(FINALIZE_TEXT)
    nas = tmp_path / "NAS"; nas.mkdir()
    md, ok, problems = ss.board(root=str(tmp_path), nas_dest=str(nas))
    assert ok is False
    assert any("no RULED rows parsed — board is empty" in p for p in problems)

# ── main() interface tests — lock the exact trailer strings the workflow
#    consumes, so renaming either string is caught even though board() itself
#    is never called by the workflow. ─────────────────────────────────────
SCRIPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "season-status.py")

def _run_main(root, nas):
    env = dict(os.environ)
    env["DEADLIGHT_FINAL_DEST"] = nas
    return subprocess.run(
        [sys.executable, SCRIPT_PATH],
        cwd=root, env=env, capture_output=True, text=True, timeout=30)

def test_main_prints_ok_trailer_on_clean_fixture(tmp_path):
    root, nas = _mk_repo(tmp_path)  # ok, problems == [] per test_board_states_...
    result = _run_main(root, nas)
    assert result.returncode == 0
    assert "SEASON_STATUS_OK" in result.stdout

def test_main_prints_partial_trailer_with_count_on_one_problem_fixture(tmp_path):
    root, nas = _mk_repo(tmp_path)
    os.remove(os.path.join(nas, "DeadLight S01E01.mp4"))  # finalized-but-missing-on-NAS
    result = _run_main(root, nas)
    assert result.returncode == 0
    assert "SEASON_STATUS_PARTIAL: 1 problem(s)" in result.stdout


# ── board_json() / --json — structured board output for the console truth
#    layer (Task 1 of the console-operating-layer plan). ────────────────────
#
# NOTE on fixture adaptation: the task brief's sketch test asserted
# eps["ep01"]["state"] == "ruled-unstarted" with the comment "no Episodes/ep01
# dir in fixture". That's false against the *actual* _mk_repo helper in this
# file — it explicitly creates "Episodes/ep01" with a finalized STATUS.md
# ("# ep01: finalized + on NAS"), and with_nas=True also stages the matching
# NAS file. So under the real fixture, ep01 resolves to the FINAL-on-NAS
# branch, not ruled/unstarted. The "no episode dir yet" case in this fixture
# is actually ep98 (air 9, prod_id_for(9, air_map) == "ep98" per
# FINALIZE_TEXT's SEASON_MAP) — matching the existing markdown test
# test_board_states_unstarted_final_and_progress, which already asserts
# "ruled/unstarted" and "ep98" appear together. Per the task instructions
# ("adapt the test to the real helper... and say so in your report"), the
# assertions below target ep01 (FINAL on NAS) and ep98 (ruled-unstarted)
# instead of the brief's ep01/ruled-unstarted pairing.
def test_board_json_shape(tmp_path):
    root, nas = _mk_repo(tmp_path, with_nas=True)
    data = ss.board_json(root=root, nas_dest=nas)
    # The clean fixture (same one test_board_states_... asserts `ok and
    # problems == []` for) must report exactly that through --json too — the
    # console's board reads `ok`/`problems` straight off this payload and
    # renders every problem as a gold badge. `in (True, False)` was the old
    # assertion here and could not fail.
    assert data["ok"] is True
    assert data["problems"] == []
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep02"]["state"] == "images"          # last milestone present
    assert eps["ep02"]["label"] == "images"
    assert eps["ep02"]["images"] == {"have": 2, "total": 2}
    assert eps["ep02"]["next"] == "assemble-episode"
    assert set(eps["ep02"]["milestones"]) == {"script", "audio", "images"}
    assert eps["ep02"]["milestones"] == sorted(eps["ep02"]["milestones"])  # sorted list
    assert eps["ep01"]["state"] == "final-on-nas"     # fixture stamps ep01 finalized + on NAS
    assert eps["ep01"]["label"] == "FINAL on NAS"
    assert eps["ep01"]["images"] is None              # no Production/ep01/images in fixture
    assert eps["ep01"]["next"] == "—"
    assert eps["ep98"]["state"] == "ruled-unstarted"  # no Episodes/ep98 dir in fixture
    assert eps["ep98"]["images"] is None

def test_board_json_enum_for_special_states(tmp_path):
    root, _ = _mk_repo(tmp_path, with_nas=False)   # NAS dir absent
    # stamp ep02 finalized so the NAS-dependent branch runs
    (tmp_path / "Episodes/ep02/STATUS.md").write_text(
        "# STATUS — ep02\n- 2026-07-20 finalized: pushed\n")
    data = ss.board_json(root=root, nas_dest=str(tmp_path / "no-such-nas"))
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep02"]["state"] == "unknown-nas-unmounted"
    assert eps["ep02"]["label"] == "unknown (NAS unmounted)"
    assert any("NAS unmounted" in p for p in data["problems"])

def test_board_json_missing_season_doc_yields_empty_episode_list(tmp_path):
    # Mirrors test_board_missing_season_doc_returns_empty_board: board()
    # returns "" (no header at all) in this case via the board_rows() None
    # sentinel; board_json() must degrade that to an empty episodes list
    # rather than propagate None into the JSON payload.
    root, nas = _mk_repo(tmp_path)
    os.remove(os.path.join(root, "Canon/season-1.md"))
    data = ss.board_json(root=root, nas_dest=nas)
    assert data["ok"] is False
    assert data["episodes"] == []
    assert any("Canon/season-1.md unreadable" in p for p in data["problems"])

def test_cli_json_flag_prints_json(tmp_path):
    root, nas = _mk_repo(tmp_path, with_nas=True)
    here = os.path.dirname(os.path.abspath(__file__))
    out = subprocess.run(
        [sys.executable, os.path.join(here, "season-status.py"), "--json"],
        cwd=root, capture_output=True, text=True,
        env={**os.environ, "DEADLIGHT_FINAL_DEST": nas})
    data = json.loads(out.stdout)          # the WHOLE stdout is the JSON
    assert "episodes" in data and "problems" in data

def test_board_and_board_json_agree_on_markdown_equivalent_fixture(tmp_path):
    # Cross-check: board()'s rendered label/images/next text must match what
    # board_json() reports for the same row, so the two renderers can never
    # silently drift apart.
    root, nas = _mk_repo(tmp_path)
    md, md_ok, md_problems = ss.board(root=root, nas_dest=nas)
    data = ss.board_json(root=root, nas_dest=nas)
    assert md_ok == data["ok"]
    assert md_problems == data["problems"]
    for ep in data["episodes"]:
        assert f"| E{ep['air']} | {ep['prod']} | {ep['title']} | {ep['label']} |" in md


# ── Season parameterization (Task 17) — a season exists iff Canon/season-N.md
#    exists; season-status.py must read whichever N is asked for, not just
#    season 1. Season 1 stays the default so every existing call site above
#    (which never passes `season=`) is untouched. ───────────────────────────
SEASON2_DOC = """# Season 2
| # | Status | Entry |
|---|--------|-------|
| 1 | **RULED** | **"Origin"** — the Sethin/Opha episode. |
"""

FINALIZE_TEXT_S2 = '''
SEASON_MAP = {
    "ep01": (1, 1),
    "ep20": (2, 1),
}
'''

def _mk_repo_s2(tmp_path, with_nas=True, finalized=False, nas_filename="DeadLight S02E01.mp4"):
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-2.md").write_text(SEASON2_DOC)
    (tmp_path / ".archon/scripts").mkdir(parents=True)
    (tmp_path / ".archon/scripts/finalize-video.py").write_text(FINALIZE_TEXT_S2)
    nas = tmp_path / "NAS"
    if finalized:
        (tmp_path / "Episodes/ep20").mkdir(parents=True)
        (tmp_path / "Episodes/ep20/STATUS.md").write_text(
            "# STATUS — ep20\n- 2026-08-01 finalized: pushed to NAS\n")
    if with_nas:
        nas.mkdir()
        if finalized:
            (nas / nas_filename).write_bytes(b"mp4")
    return str(tmp_path), str(nas)

def test_parse_air_map_respects_season_param():
    m = ss.parse_air_map(FINALIZE_TEXT_S2, season=2)
    assert m == {1: "ep20"}                 # only the season-2 entry
    assert ss.prod_id_for(1, m) == "ep20"

def test_board_season_param_reads_season_n_doc_not_season_1(tmp_path):
    root, nas = _mk_repo_s2(tmp_path)
    md, ok, problems = ss.board(root=root, nas_dest=nas, season=2)
    assert "Origin" in md and "ep20" in md
    assert ok and problems == []

def test_board_season_param_uses_season_n_in_nas_filename(tmp_path):
    # ep20 stamped finalized; the NAS file is named for SEASON 2 (S02E01), not
    # S01E01 — this is the guard against finalize-video's CAUTION leaking into
    # season-status's own NAS lookup.
    root, nas = _mk_repo_s2(tmp_path, finalized=True, nas_filename="DeadLight S02E01.mp4")
    md, ok, problems = ss.board(root=root, nas_dest=nas, season=2)
    assert ok and problems == []
    assert "FINAL on NAS" in md

def test_board_season_param_wrong_nas_name_is_missing_not_found(tmp_path):
    # Same fixture, but the NAS file uses the SEASON-1-style name — proves the
    # lookup is season-sensitive rather than accidentally season-agnostic.
    root, nas = _mk_repo_s2(tmp_path, finalized=True, nas_filename="DeadLight S01E01.mp4")
    md, ok, problems = ss.board(root=root, nas_dest=nas, season=2)
    assert not ok
    assert any("missing on NAS" in p for p in problems)

def test_board_json_season_param(tmp_path):
    root, nas = _mk_repo_s2(tmp_path)
    data = ss.board_json(root=root, nas_dest=nas, season=2)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep20"]["title"] == "Origin"
    assert eps["ep20"]["air"] == 1

def test_main_cli_season_arg_reads_season_n_doc(tmp_path):
    root, nas = _mk_repo_s2(tmp_path)
    result = subprocess.run(
        [sys.executable, SCRIPT_PATH, "s2"],
        cwd=root, env={**os.environ, "DEADLIGHT_FINAL_DEST": nas},
        capture_output=True, text=True, timeout=30)
    assert result.returncode == 0
    assert "Origin" in result.stdout and "ep20" in result.stdout
    assert "SEASON_STATUS_OK" in result.stdout

def test_main_cli_season_arg_with_json_flag(tmp_path):
    root, nas = _mk_repo_s2(tmp_path)
    result = subprocess.run(
        [sys.executable, SCRIPT_PATH, "s2", "--json"],
        cwd=root, env={**os.environ, "DEADLIGHT_FINAL_DEST": nas},
        capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert eps["ep20"]["title"] == "Origin"

def test_main_cli_defaults_to_season_1_when_no_sN_arg(tmp_path):
    # A bare --json (no "sN" token) must still mean season 1 -- the default
    # must survive alongside the new flag-parsing loop.
    root, nas = _mk_repo(tmp_path)
    result = subprocess.run(
        [sys.executable, SCRIPT_PATH, "--json"],
        cwd=root, env={**os.environ, "DEADLIGHT_FINAL_DEST": nas},
        capture_output=True, text=True, timeout=30)
    data = json.loads(result.stdout)
    eps = {e["prod"]: e for e in data["episodes"]}
    assert "ep01" in eps and "ep98" in eps       # season-1 fixture's rows
