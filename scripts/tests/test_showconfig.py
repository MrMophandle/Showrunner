"""lib/showconfig.py — the one way a step script reads its show."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from lib import showconfig as sc


def test_load_reads_the_fixture_show(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert cfg["showName"] == "Harbor Lights"
    assert cfg["showSlug"] == "HarborLights"
    assert cfg["audio"]["sampleRate"] == 24000
    assert cfg["audio"]["mainCast"] == ["narrator", "Maeve"]
    assert cfg["output"]["mixFilename"] == "{slug} S{season:02d}E{episode:02d}.wav"


def test_load_defaults_to_the_working_directory(show_root: Path, monkeypatch) -> None:
    monkeypatch.chdir(show_root)
    assert sc.load()["showSlug"] == "HarborLights"


def test_a_missing_file_names_showrunner_json(tmp_path: Path) -> None:
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(tmp_path))
    assert "showrunner.json" in str(err.value)


def test_invalid_json_names_showrunner_json(tmp_path: Path) -> None:
    (tmp_path / "showrunner.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(tmp_path))
    assert "showrunner.json" in str(err.value)


def test_a_missing_required_key_is_named(show_root: Path) -> None:
    cfg = json.loads((show_root / "showrunner.json").read_text(encoding="utf-8"))
    del cfg["models"]["writer"]
    (show_root / "showrunner.json").write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(show_root))
    assert "models.writer" in str(err.value)


def _write(show_root, cfg) -> None:
    (show_root / "showrunner.json").write_text(json.dumps(cfg), encoding="utf-8")


def _config(show_root):
    return json.loads((show_root / "showrunner.json").read_text(encoding="utf-8"))


# The four probes below are the whole-branch review's against the engine loader (one of them is also in `engine/test/show-config.test.ts`), run against the same real-config
# -style fixture every other suite here loads. Each one is a config the engine's loader refuses;
# before this parity work each was accepted by load() and refused by the engine, which is the one
# disagreement about showrunner.json the pipeline cannot survive.


def test_an_aired_id_is_refused_as_an_air_map_key(show_root: Path) -> None:
    """airMap answers "which season did this production id air in".

    An aired id already carries its season, so a mapping for one could only ever be a second and
    silently disagreeing answer; the engine refuses it and so does this loader.
    """
    cfg = _config(show_root)
    cfg["airMap"]["s01e05"] = [1, 5]
    _write(show_root, cfg)
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(show_root))
    assert "airMap.s01e05" in str(err.value)
    assert "production id" in str(err.value)


def test_an_air_map_slot_with_a_zero_is_refused(show_root: Path) -> None:
    """Seasons and episodes start at 1, so [0, 1] is a typo, not a slot."""
    cfg = _config(show_root)
    cfg["airMap"]["ep01"] = [0, 1]
    _write(show_root, cfg)
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(show_root))
    assert "airMap.ep01" in str(err.value)
    assert "positive integers" in str(err.value)


def test_an_empty_required_string_is_refused(show_root: Path) -> None:
    cfg = _config(show_root)
    cfg["showName"] = ""
    _write(show_root, cfg)
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(show_root))
    assert "showName must be a non-empty string" in str(err.value)


def test_a_required_string_that_is_not_a_string_is_refused(show_root: Path) -> None:
    cfg = _config(show_root)
    cfg["models"]["writer"] = 7
    _write(show_root, cfg)
    with pytest.raises(sc.ShowConfigError) as err:
        sc.load(str(show_root))
    assert "models.writer must be a non-empty string" in str(err.value)


def test_show_root_strips_the_flag_and_leaves_other_args() -> None:
    argv = ["validate-manifest.py", "ep01", "--show-root", "/tmp/show", "--verbose"]
    assert sc.show_root(argv) == "/tmp/show"
    assert argv == ["validate-manifest.py", "ep01", "--verbose"]


def test_show_root_without_the_flag_is_the_working_directory(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    argv = ["audio-mix.py", "ep01"]
    assert os.path.realpath(sc.show_root(argv)) == os.path.realpath(str(tmp_path))
    assert argv == ["audio-mix.py", "ep01"]


def test_show_root_accepts_the_equals_form() -> None:
    argv = ["validate-manifest.py", "ep01", "--show-root=/tmp/show", "--verbose"]
    assert sc.show_root(argv) == "/tmp/show"
    assert argv == ["validate-manifest.py", "ep01", "--verbose"]


def test_show_root_accepts_a_relative_path_as_typed() -> None:
    argv = ["audio-mix.py", "ep01", "--show-root", "../show"]
    assert sc.show_root(argv) == "../show"


def test_show_root_without_a_path_is_an_error() -> None:
    with pytest.raises(sc.ShowConfigError):
        sc.show_root(["pace-qc.py", "ep01", "--show-root"])


def test_show_root_with_an_empty_equals_value_is_an_error() -> None:
    with pytest.raises(sc.ShowConfigError):
        sc.show_root(["pace-qc.py", "ep01", "--show-root="])


def test_path_joins_a_relative_value_to_the_root(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert sc.path(cfg, "audio", "voiceRegistry", root=str(show_root)) == str(
        show_root / "Canon/voice-registry.md"
    )


def test_path_leaves_an_absolute_value_alone(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert sc.path(cfg, "output", "nasRoot", root=str(show_root)) == "/Volumes/media/HarborLights"


def test_path_names_a_missing_key(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    with pytest.raises(sc.ShowConfigError) as err:
        sc.path(cfg, "audio", "nope", root=str(show_root))
    assert "audio.nope" in str(err.value)


def test_format_filename() -> None:
    assert (
        sc.format_filename("{slug} S{season:02d}E{episode:02d}.wav", slug="HL", season=1, episode=3)
        == "HL S01E03.wav"
    )


def test_format_filename_renders_the_fixture_pattern(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert (
        sc.format_filename(cfg["output"]["mixFilename"], slug=cfg["showSlug"], season=1, episode=3)
        == "HarborLights S01E03.wav"
    )


def test_season_of_reads_an_aired_id(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert sc.season_of(cfg, "s02e01") == (2, 1)


def test_season_of_reads_a_production_id_from_the_air_map(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    assert sc.season_of(cfg, "ep02") == (1, 2)


def test_season_of_fails_on_an_unmapped_id(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    with pytest.raises(sc.UnmappedEpisodeId) as err:
        sc.season_of(cfg, "ep99")
    assert "ep99" in str(err.value)
    assert isinstance(err.value, sc.ShowConfigError)


@pytest.mark.parametrize("bad_id", ["EP01", "ep1", "ep001", "episode-4", "S01E01", "s1e1", ""])
def test_an_id_matching_neither_grammar_is_a_plain_error(show_root: Path, bad_id: str) -> None:
    """The two faults want different handling, so they are different exceptions.

    "ep11 is not placed yet" is a normal state an episode passes through, and a caller may
    absorb it. "EP01 is not an episode id" is a mistake in the argv the operator typed, and no
    caller may name an output file over it. The grammar mirrors engine/src/ids.ts.
    """
    cfg = sc.load(str(show_root))
    with pytest.raises(sc.ShowConfigError) as err:
        sc.season_of(cfg, bad_id)
    assert not isinstance(err.value, sc.UnmappedEpisodeId)


def test_a_well_formed_but_unplaced_id_is_the_absorbable_one(show_root: Path) -> None:
    """ep98 is spelled correctly and simply has no slot; that is UnmappedEpisodeId."""
    cfg = sc.load(str(show_root))
    with pytest.raises(sc.UnmappedEpisodeId):
        sc.season_of(cfg, "ep98")


def test_production_number_zero_is_refused(show_root: Path) -> None:
    cfg = sc.load(str(show_root))
    with pytest.raises(sc.ShowConfigError) as err:
        sc.season_of(cfg, "ep00")
    assert not isinstance(err.value, sc.UnmappedEpisodeId)
    assert "production numbers start at 1" in str(err.value)


def test_a_malformed_air_map_entry_is_not_an_unmapped_id(show_root: Path) -> None:
    """A broken slot is a config fault a caller must not absorb as "no slot"."""
    cfg = sc.load(str(show_root))
    cfg["airMap"]["ep03"] = [1]
    with pytest.raises(sc.ShowConfigError) as err:
        sc.season_of(cfg, "ep03")
    assert not isinstance(err.value, sc.UnmappedEpisodeId)
    assert "airMap.ep03" in str(err.value)


def test_progress_prints_the_contract_line(capsys) -> None:
    sc.progress(3, 12, "segments")
    assert capsys.readouterr().out == '::progress {"done": 3, "total": 12, "unit": "segments"}\n'


def test_progress_carries_an_optional_message(capsys) -> None:
    sc.progress(1, 2, "rounds", "round 1")
    assert (
        capsys.readouterr().out
        == '::progress {"done": 1, "total": 2, "unit": "rounds", "message": "round 1"}\n'
    )
