import importlib.util, os, sys

import pytest

def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "finalize_video", os.path.join(here, "finalize-video.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # safe: script guards main() behind __main__
    return mod

fv = _load()

def _mk_video(tmp_path, ep):
    vid_dir = tmp_path / f"Production/{ep}/video"
    vid_dir.mkdir(parents=True)
    f = vid_dir / "episode-v1.mp4"
    f.write_bytes(b"video-bytes")
    return f


# ── season_slot(): derive (season, air) for eps NOT in SEASON_MAP, from
#    Canon/season-N.md's RULED rows. Only matches an ep against the row's
#    DEFAULT production id (ep{air:02d}) -- an ep with an explicit SEASON_MAP
#    override (like ep98, which airs at row 9 but is production id ep98,
#    NOT ep09) must never be matched here. ────────────────────────────────
def test_season_slot_none_when_no_season_doc(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert fv.season_slot("ep07") is None

def test_season_slot_derives_from_ruled_row_default_id(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        "| 7 | **RULED** | some job |\n")
    assert fv.season_slot("ep07") == (1, 7)

def test_season_slot_ignores_unruled_rows(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        "| 7 | DRAFT | some job |\n")
    assert fv.season_slot("ep07") is None

def test_season_slot_does_not_match_explicit_override_ep_id(tmp_path, monkeypatch):
    """The Wick airs at row 9 but is produced as ep98 -- an explicit SEASON_MAP
    override, not the row's default id (ep09). season_slot() must not invent a
    match for ep98 here; only ep09 (the row's own default) matches."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 9 | **RULED** | **"The Wick"** (produced as ep98) airs here |\n')
    assert fv.season_slot("ep98") is None
    assert fv.season_slot("ep09") == (1, 9)

def test_season_slot_ignores_non_numeric_season_files(tmp_path, monkeypatch):
    """Canon/season-desk-report.md matches the glob 'season-*.md' but is not a
    season doc -- must never be scanned as one."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-desk-report.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        "| 7 | **RULED** | some job |\n")
    assert fv.season_slot("ep07") is None


# ── Cross-season id-collision guard (task-17 review finding) -- a RULED
#    row's default id is only unique WITHIN one season doc; two season docs
#    can rule a row that defaults to the same id. season_slot() must refuse
#    outright rather than silently pick one, since a wrong pick here writes
#    a permanently-misnamed file to the NAS. ────────────────────────────────
def test_season_slot_refuses_on_cross_season_collision_naming_both_candidates(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 5 | **RULED** | **"Season 1 job"** |\n')
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 5 | **RULED** | **"Season 2 job"** |\n')
    with pytest.raises(SystemExit) as exc_info:
        fv.season_slot("ep05")
    msg = str(exc_info.value)
    assert "ep05" in msg
    assert "S01E05" in msg and "S02E05" in msg
    assert "Nothing written" in msg

def test_season_slot_numeric_sort_not_lexicographic_in_collision_message(tmp_path, monkeypatch):
    """season-10.md must NOT sort before season-2.md (a plain string sort
    would put "season-10.md" first). The collision message must name the
    candidates in NUMERIC season order: S02 before S10."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-10.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 3 | **RULED** | **"Season 10 job"** |\n')
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 3 | **RULED** | **"Season 2 job"** |\n')
    with pytest.raises(SystemExit) as exc_info:
        fv.season_slot("ep03")
    msg = str(exc_info.value)
    s2_pos = msg.find("S02E03")
    s10_pos = msg.find("S10E03")
    assert s2_pos != -1 and s10_pos != -1
    assert s2_pos < s10_pos, f"expected S02E03 named before S10E03, got: {msg}"

def test_season_slot_single_unambiguous_match_still_resolves(tmp_path, monkeypatch):
    """Regression: a second, non-colliding season doc present alongside the
    matching one must not trip the collision guard -- only an ACTUAL shared
    default id across docs should refuse."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 5 | **RULED** | **"Season 1 job"** |\n')
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 9 | **RULED** | **"Season 2 job, different air"** |\n')
    assert fv.season_slot("ep05") == (1, 5)
    assert fv.season_slot("ep09") == (2, 9)

def test_finalize_refuses_and_writes_nothing_on_collision(tmp_path, monkeypatch):
    """End-to-end: finalize() must propagate the refusal (via season_slot's
    sys.exit) rather than write a guessed file to DEST. Uses ep07 (NOT in
    SEASON_MAP) so the call actually reaches season_slot() instead of
    resolving via the map first."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(fv, "DEST", str(tmp_path / "NAS"))
    (tmp_path / "NAS").mkdir()
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-1.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 7 | **RULED** | **"Season 1 job"** |\n')
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 7 | **RULED** | **"Season 2 job"** |\n')
    _mk_video(tmp_path, "ep07")
    with pytest.raises(SystemExit):
        fv.finalize("ep07")
    assert list((tmp_path / "NAS").iterdir()) == []


# ── finalize(): SEASON_MAP still wins when an ep is in it; season doc is the
#    fallback for eps that are not. ──────────────────────────────────────
def test_finalize_still_uses_season_map_for_mapped_ep(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(fv, "DEST", str(tmp_path / "NAS"))
    (tmp_path / "NAS").mkdir()
    _mk_video(tmp_path, "ep01")
    assert fv.finalize("ep01") is True
    assert (tmp_path / "NAS/DeadLight S01E01.mp4").exists()

def test_finalize_derives_unmapped_ep_slot_from_season_2_doc(tmp_path, monkeypatch):
    """The s2 fixture: ep20 is NOT in SEASON_MAP, but Canon/season-2.md rules
    row 20 -- its default production id is exactly ep20 -- so finalize() must
    derive (2, 20) from the doc and write the season-2-named file."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(fv, "DEST", str(tmp_path / "NAS"))
    (tmp_path / "NAS").mkdir()
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 20 | **RULED** | **"Origin"** |\n')
    _mk_video(tmp_path, "ep20")
    assert fv.finalize("ep20") is True
    assert (tmp_path / "NAS/DeadLight S02E20.mp4").exists()

def test_finalize_skips_ep_with_no_slot_in_map_or_doc(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(fv, "DEST", str(tmp_path / "NAS"))
    (tmp_path / "NAS").mkdir()
    _mk_video(tmp_path, "ep98")           # ep98: never mapped, no season-N.md present
    assert fv.finalize("ep98") is False
    assert "no air slot" in capsys.readouterr().out

def test_finalize_all_mode_unaffected_still_uses_season_map_only(tmp_path, monkeypatch):
    """'all' iterates SEASON_MAP as before -- season-doc-only eps are reachable
    by name (ARGUMENTS=ep20) but do not get swept into 'all' automatically.
    This is a deliberate scope limit (see task-17 report): season doc default
    ids are not guaranteed globally unique across seasons, so only an
    explicit single-ep invocation resolves via the doc."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(fv, "DEST", str(tmp_path / "NAS"))
    (tmp_path / "NAS").mkdir()
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/season-2.md").write_text(
        "| # | Status | Entry |\n|---|---|---|\n"
        '| 20 | **RULED** | **"Origin"** |\n')
    _mk_video(tmp_path, "ep20")
    for ep in fv.SEASON_MAP:
        _mk_video(tmp_path, ep)
    n = sum(fv.finalize(ep) for ep in sorted(fv.SEASON_MAP))
    assert n == len(fv.SEASON_MAP)
    assert not (tmp_path / "NAS/DeadLight S02E20.mp4").exists()
