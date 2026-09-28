"""audio-mix.py — the episode mix, named from show config and ending in its result line.

The two mixing tests shell out to ffmpeg (the limiter pass and the two loudnorm passes), so they
skip when ffmpeg is not on PATH. Everything they mix is half a second of synthetic tone.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from conftest import SCRIPTS_DIR, load_script, needs_ffmpeg

SCRIPT = SCRIPTS_DIR / "audio-mix.py"
SR = 24000


def _naming(show_root: Path):
    """The audio-mix module and a loaded fixture config, for the pure naming assertions."""
    from lib import showconfig as sc

    return load_script("audio-mix.py"), sc.load(str(show_root))


def _episode(show_root: Path, episode_id: str) -> Path:
    """Two half-second segments and the manifest that places them."""
    base = show_root / "Production" / episode_id / "audio"
    (base / "segments").mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SR * 0.5)) / SR
    for i, hz in ((1, 220.0), (2, 330.0)):
        sf.write(str(base / "segments" / f"{i:04d}.wav"), 0.2 * np.sin(2 * np.pi * hz * t), SR)
    manifest = {
        "episode": episode_id,
        "sr": SR,
        "segments": [
            {"i": 1, "speaker": "narrator", "duration_s": 0.5, "gap_before": 0.3},
            {"i": 2, "speaker": "Maeve", "duration_s": 0.5, "gap_before": 0.5},
        ],
    }
    (base / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return base


def _run(show_root: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *argv], cwd=show_root, capture_output=True, text=True
    )


def _lines(out: str) -> list[str]:
    return [line for line in out.splitlines() if line.strip()]


def _result(out: str) -> str:
    return [line for line in _lines(out) if not line.startswith("::progress ")][-1]


@needs_ffmpeg
def test_the_mix_is_named_from_the_shows_pattern_and_air_slot(show_root: Path) -> None:
    base = _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    # airMap places ep01 at season 1, episode 1; output.mixFilename does the naming.
    assert (base / "HarborLights S01E01.wav").exists(), sorted(p.name for p in base.iterdir())


@needs_ffmpeg
def test_the_last_line_is_the_result_the_gate_reads(show_root: Path) -> None:
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result.startswith("MIX_OK "), result
    duration, lufs, unit, path = result[len("MIX_OK "):].split(" ", 3)
    assert duration.endswith("s") and float(duration[:-1]) > 1.0
    assert unit == "LUFS"
    # The figure is what the mix MEASURED after normalisation, not the target read back: a real
    # loudness lands somewhere below 0 and above -30, and the (target) marker says when the
    # summary could not be parsed.
    assert -30.0 < float(lufs) < 0.0, result
    assert "(target)" not in result, result
    assert path.endswith("HarborLights S01E01.wav")


@needs_ffmpeg
def test_it_reports_progress_in_segments(show_root: Path) -> None:
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    progress = [line for line in _lines(done.stdout) if line.startswith("::progress ")]
    assert progress == [
        '::progress {"done": 1, "total": 2, "unit": "segments"}',
        '::progress {"done": 2, "total": 2, "unit": "segments"}',
    ]


def test_an_episode_the_air_map_does_not_place_is_named_episode_wav(show_root: Path) -> None:
    """No ffmpeg needed: the naming rule is a pure function of the show config."""
    mix, cfg = _naming(show_root)
    assert mix.mix_wav(cfg, "ep01") == "HarborLights S01E01.wav"
    assert mix.mix_wav(cfg, "s02e03") == "HarborLights S02E03.wav"
    assert mix.mix_wav(cfg, "ep98") == "episode.wav"


def test_a_config_fault_is_never_named_over_as_episode_wav(show_root: Path) -> None:
    """Only an unmapped id falls back; a broken config must reach the operator."""
    from lib import showconfig as sc

    mix, cfg = _naming(show_root)

    broken_slot = json.loads(json.dumps(cfg))
    broken_slot["airMap"]["ep03"] = [1]
    with pytest.raises(sc.ShowConfigError):
        mix.mix_wav(broken_slot, "ep03")

    no_pattern = json.loads(json.dumps(cfg))
    del no_pattern["output"]["mixFilename"]
    with pytest.raises(sc.ShowConfigError):
        mix.mix_wav(no_pattern, "ep01")

    no_map = json.loads(json.dumps(cfg))
    del no_map["airMap"]
    with pytest.raises(sc.ShowConfigError):
        mix.mix_wav(no_map, "ep01")


def test_a_missing_episode_id_is_refused(show_root: Path) -> None:
    done = _run(show_root)
    assert done.returncode != 0
    assert "episode id missing" in done.stderr


def test_a_malformed_id_is_never_named_over_as_episode_wav(show_root: Path) -> None:
    """Only a WELL-FORMED production id the airMap does not place falls back. "EP01" matches
    neither grammar, so it is an argv mistake and must reach the operator."""
    from lib import showconfig as sc

    mix, cfg = _naming(show_root)
    for bad in ("EP01", "ep1", "episode-1"):
        with pytest.raises(sc.ShowConfigError):
            mix.mix_wav(cfg, bad)


def test_the_result_line_marks_an_unparsed_measurement_as_the_target(
        show_root: Path, monkeypatch, capsys) -> None:
    """When ffmpeg's summary cannot be parsed the line must SAY so with a (target) marker,
    rather than pass the configured target off as something the mix achieved.

    main() runs in-process with a stubbed ffmpeg: the measure pass returns a JSON blob, and the
    apply pass returns stderr WITHOUT an "Output Integrated:" line, which is the condition the
    fallback exists for. No ffmpeg is needed to exercise a formatting decision.
    """
    import shutil as _shutil

    mix = load_script("audio-mix.py")
    _episode(show_root, "ep01")

    measured = ('{"input_i":"-19.1","input_tp":"-3.0","input_lra":"4.2",'
                '"input_thresh":"-29.3","target_offset":"0.4"}')

    def fake_run(argv, **kwargs):
        out_path = argv[-1]
        if "print_format=json" in " ".join(argv):
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr=measured)
        if out_path != "-":
            # Both the limiter and the apply pass write a real file; copy the input forward.
            src = argv[argv.index("-i") + 1]
            _shutil.copyfile(src, out_path)
        # Deliberately no "Output Integrated:" line — the summary is unparseable.
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="size=  N/A time=00:00:02")

    monkeypatch.setattr(mix.subprocess, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["audio-mix.py", "ep01"])
    monkeypatch.chdir(show_root)
    mix.main()

    last = [l for l in capsys.readouterr().out.strip().splitlines()
            if not l.startswith("::progress")][-1]
    assert last.startswith("MIX_OK ")
    assert last.endswith(" (target)")
    assert "-14.0 LUFS" in last


def test_a_parsed_measurement_carries_no_target_marker(
        show_root: Path, monkeypatch, capsys) -> None:
    """The other side: when the summary IS parseable, the figure is the mix's own and the
    marker must be absent, or the marker would mean nothing."""
    import shutil as _shutil

    mix = load_script("audio-mix.py")
    _episode(show_root, "ep01")

    measured = ('{"input_i":"-19.1","input_tp":"-3.0","input_lra":"4.2",'
                '"input_thresh":"-29.3","target_offset":"0.4"}')

    def fake_run(argv, **kwargs):
        out_path = argv[-1]
        if "print_format=json" in " ".join(argv):
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr=measured)
        if out_path != "-":
            _shutil.copyfile(argv[argv.index("-i") + 1], out_path)
        return subprocess.CompletedProcess(
            argv, 0, stdout="", stderr="[Parsed_loudnorm_0 @ 0x1]\nOutput Integrated:  -13.8 LUFS")

    monkeypatch.setattr(mix.subprocess, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["audio-mix.py", "ep01"])
    monkeypatch.chdir(show_root)
    mix.main()

    last = [l for l in capsys.readouterr().out.strip().splitlines()
            if not l.startswith("::progress")][-1]
    assert "-13.8 LUFS" in last
    assert "(target)" not in last


def test_an_ffmpeg_failure_on_the_apply_pass_reports_its_stderr_tail(
        show_root: Path, monkeypatch, capsys) -> None:
    """The apply pass is the one that writes the episode. When ffmpeg refuses it, the last lines
    of its stderr are the reason; without them the operator sees only an exit code."""
    import shutil as _shutil

    mix = load_script("audio-mix.py")
    _episode(show_root, "ep01")

    measured = ('{"input_i":"-19.1","input_tp":"-3.0","input_lra":"4.2",'
                '"input_thresh":"-29.3","target_offset":"0.4"}')
    tail = "\n".join(f"line {n}" for n in range(1, 21)) + "\nNo such file or directory"

    def fake_run(argv, **kwargs):
        joined = " ".join(argv)
        if "print_format=json" in joined:
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr=measured)
        if "alimiter" in joined:
            _shutil.copyfile(argv[argv.index("-i") + 1], argv[-1])
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        raise subprocess.CalledProcessError(1, argv, output="", stderr=tail)

    monkeypatch.setattr(mix.subprocess, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["audio-mix.py", "ep01"])
    monkeypatch.chdir(show_root)
    with pytest.raises(SystemExit) as err:
        mix.main()

    captured = capsys.readouterr()
    assert "audio-mix: ffmpeg failed to write" in str(err.value)
    reported = [l for l in captured.err.splitlines() if l.startswith("  ffmpeg: ")]
    # The last ~10 lines only: a full ffmpeg log would bury the reason it was printed for.
    assert len(reported) == 10
    assert reported[-1] == "  ffmpeg: No such file or directory"
    assert "  ffmpeg: line 1" not in reported


def test_room_tone_requires_its_own_fundamental(show_root: Path) -> None:
    """A show that asks for a bed without saying what it is pitched at must fail by NAME,
    not hum at 0 Hz."""
    import json as _json

    cfg = _json.loads((show_root / "showrunner.json").read_text())
    del cfg["audio"]["roomToneFundamentalHz"]
    (show_root / "showrunner.json").write_text(_json.dumps(cfg))
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert done.returncode == 1
    assert "audio.roomToneFundamentalHz is missing" in done.stderr
    assert len(done.stderr.strip().splitlines()) == 1


def test_a_show_that_mixes_dry_needs_no_fundamental(show_root: Path) -> None:
    """roomToneDb is optional; only setting it makes the fundamental required."""
    import json as _json

    cfg = _json.loads((show_root / "showrunner.json").read_text())
    del cfg["audio"]["roomToneDb"]
    del cfg["audio"]["roomToneFundamentalHz"]
    (show_root / "showrunner.json").write_text(_json.dumps(cfg))
    _episode(show_root, "ep01")
    done = _run(show_root, "ep01")
    assert "roomToneFundamentalHz" not in done.stderr
