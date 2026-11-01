"""The three migration scripts: cast-index-build.py, cast-audit.py, cast-prune.py (spec
2026-10-31 §4, plan L1 Task 4).

Every test here is hermetic: a temp show root carrying the invented show's showrunner.json, a
small visual bible, a small voice registry, two character sheets and a handful of PNG-shaped
files. No model, no network, no show repository.

The audit's --retired tree gets a stronger guarantee than hermeticity: test_audit_retired_scan_
writes_nothing_under_the_retired_tree snapshots every path under it with its size and its
st_mtime_ns and asserts the snapshot is identical after the run, because the retired repository is
read-only and cast-audit.py may not create so much as a temp file in it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

BUILD = "cast-index-build.py"
AUDIT = "cast-audit.py"
PRUNE = "cast-prune.py"

PNG = b"\x89PNG\r\n\x1a\n"


def run(script: str, root: Path, *args: str) -> subprocess.CompletedProcess:
    """One migration script, run as the operator runs it: the show root as the working directory."""
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / script), *args],
        cwd=root, capture_output=True, text=True,
    )


def row(out: str, key: str) -> str:
    """The one table row whose first column is `key`. Asserts there is exactly one."""
    rows = [line for line in out.splitlines() if line.split() and line.split()[0] == key]
    assert len(rows) == 1, f"expected one row for {key!r}, got {rows!r}"
    return rows[0]


def section(out: str, header: str) -> list[str]:
    """The indented lines under a section header, up to the next blank line."""
    lines = out.splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith(header))
    body: list[str] = []
    for line in lines[at + 1:]:
        if line.strip() == "":
            break
        body.append(line.strip())
    return body


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG)


def bare_show(tmp_path: Path, name: str = "show") -> Path:
    """A show root holding nothing but the invented show's showrunner.json."""
    root = tmp_path / name
    root.mkdir(parents=True)
    shutil.copy(FIXTURES_DIR / "showrunner.json", root / "showrunner.json")
    return root


# ── the fixture show: the two legacy registries in the shape the instance has them ──────────────

# The visual bible is a flat map keyed by slug with _-prefixed meta keys. The Warden's reference
# carries an arbitrary filename, which is the shape the real folders are in.
BIBLE = {
    "_doc": "the visual bible: one entry per subject we have a reference for",
    "_ruled": "2026-10-20",
    "vale": {
        "kind": "human",
        "ref": "Canon/characters/Vale/reference.png",
        "identity": "Vale, ~60, weathered practical woman in oilskins",
        "locked": "reference sheet, 2026-07-20",
        "baseline_prompt": "character reference sheet, head-on, 45 degrees, profile",
    },
    "warden": {
        "kind": "character",
        "ref": "Canon/characters/Warden/Warden Reference.png",
        "identity": "the Warden, keeper of the light, never seen below the stair",
        "locked": "reference sheet, 2026-07-21",
    },
    "harbor": {
        "kind": "location",
        "ref": "Canon/locations/harbor.png",
        "identity": "the harbor at dusk, low tide",
        "locked": "painted plate, 2026-07-22",
    },
    "ghost": {
        "kind": "creature",
        "ref": "Canon/characters/Ghost/missing.png",
        "identity": "the ghost light over the water",
        "locked": "never",
    },
}

# The voice registry's cast keys are display names, and "the Warden" slugs to the bible's own
# `warden` key, which is the merge the build has to make.
VOICES = {
    "engine": "qwen3",
    "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
    "note": "clone from the locked reference; never re-design a locked voice",
    "notes_ear": "listen on speakers before locking anything",
    "cast": {
        "Vale": {
            "ref": "Production/voice-refs/vale.wav",
            "ref_text": "Light's lit. Go on up.",
            "status": "LOCKED (speed 1.12)",
            "direction": "weathered, unhurried, close",
            "fx": None,
            "speed": 1.12,
        },
        "the Warden": {
            "ref": "Production/voice-refs/warden.wav",
            "ref_text": "You will not pass the stair.",
            "status": "CANDIDATE",
            "direction": "flat, airless",
            "fx": "reverb",
        },
    },
}


def fixture_show(tmp_path: Path, name: str = "show") -> Path:
    """The show the build tests merge: four bible subjects, two voices, two sheets, three PNGs.

    Ghost's bible reference names a file that is NOT written, which is the "kept and reported"
    case; Harbor's reference lives outside the character folders, which is why the prune ignores it.
    """
    root = bare_show(tmp_path, name)
    write(root / "Canon" / "refs.json", json.dumps(BIBLE, indent=2))
    write(root / "Production" / "voice-refs" / "refs.json", json.dumps(VOICES, indent=2))
    write(root / "Canon" / "characters" / "Vale" / "vale.md", "# Vale\n\nKeeps the lamp.\n")
    write(root / "Canon" / "characters" / "Warden" / "warden.md", "# the Warden\n\nKeeps the stair.\n")
    png(root / "Canon" / "characters" / "Vale" / "reference.png")
    png(root / "Canon" / "characters" / "Warden" / "Warden Reference.png")
    png(root / "Canon" / "locations" / "harbor.png")
    return root


# ── cast-index-build.py ─────────────────────────────────────────────────────────────────────────

def test_build_without_write_creates_nothing_and_lists_every_key(tmp_path):
    root = fixture_show(tmp_path)
    r = run(BUILD, root)
    assert r.returncode == 0, r.stderr
    assert not (root / "Canon" / "cast.json").exists()
    for key in ("vale", "warden", "harbor", "ghost"):
        assert row(r.stdout, key)
    assert "4 entries, 0 conflicts" in r.stdout
    assert "Canon/characters/Ghost/missing.png" in r.stdout
    assert "--write" in r.stdout


def test_build_with_write_merges_the_two_registries_and_the_sheets(tmp_path):
    root = fixture_show(tmp_path)
    r = run(BUILD, root, "--write")
    assert r.returncode == 0, r.stderr
    doc = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))

    assert doc["version"] == 1
    assert doc["audio"]["engine"] == "qwen3"
    assert doc["audio"]["model"] == VOICES["model"]
    assert doc["audio"]["note"] == VOICES["note"]
    # F12: the registry's top level is carried whole, minus `cast`. `notes_ear` is a real key of
    # the instance's registry and was dropped by a build that copied three fields by name; the
    # index is the one record now, so a note the registry held and the index did not would be lost
    # when the registry is retired.
    assert doc["audio"]["notes_ear"] == VOICES["notes_ear"]
    assert "cast" not in doc["audio"]
    cast = doc["cast"]
    assert set(cast) == {"vale", "warden", "harbor", "ghost"}
    assert all(entry["debut"] == "s01e01" for entry in cast.values())

    vale = cast["vale"]
    assert vale["name"] == "Vale"
    assert vale["kind"] == "human"
    assert vale["speaks"] is True
    assert vale["sheet"] == "Canon/characters/Vale/vale.md"
    assert vale["identity"] == BIBLE["vale"]["identity"]
    assert vale["baseline_prompt"] == BIBLE["vale"]["baseline_prompt"]
    assert vale["face"] == {
        "ref": "Canon/characters/Vale/reference.png",
        "gallery": [],
        "locked": "reference sheet, 2026-07-20",
    }
    assert vale["voice"]["status"] == "LOCKED (speed 1.12)"
    assert vale["voice"]["ref"] == "Production/voice-refs/vale.wav"
    assert vale["voice"]["ref_text"] == "Light's lit. Go on up."
    assert vale["voice"]["direction"] == "weathered, unhurried, close"
    assert vale["voice"]["fx"] is None
    assert vale["voice"]["speed"] == 1.12

    warden = cast["warden"]
    assert warden["name"] == "the Warden"
    assert warden["kind"] == "character"
    assert warden["speaks"] is True
    assert warden["sheet"] == "Canon/characters/Warden/warden.md"
    assert warden["face"]["ref"] == "Canon/characters/Warden/Warden Reference.png"
    assert warden["voice"]["status"] == "CANDIDATE"
    assert warden["voice"]["fx"] == "reverb"

    harbor = cast["harbor"]
    assert harbor["name"] == "Harbor"
    assert harbor["kind"] == "location"
    assert harbor["speaks"] is False
    assert "voice" not in harbor
    assert "sheet" not in harbor
    assert harbor["face"]["ref"] == "Canon/locations/harbor.png"

    ghost = cast["ghost"]
    assert ghost["name"] == "Ghost"
    assert ghost["kind"] == "creature"
    assert ghost["face"]["ref"] == "Canon/characters/Ghost/missing.png"
    assert "voice" not in ghost


def test_build_refuses_to_write_when_two_sources_name_different_paths(tmp_path):
    """The conflict the migration is built to catch: the voice registry and the index already on
    disk name different WAVs for one key. The table still prints, nothing is written, exit is 2."""
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    before = (root / "Canon" / "cast.json").read_bytes()
    drifted = json.loads(json.dumps(VOICES))
    drifted["cast"]["Vale"]["ref"] = "Production/voice-refs/vale-2.wav"
    write(root / "Production" / "voice-refs" / "refs.json", json.dumps(drifted, indent=2))

    r = run(BUILD, root, "--write")
    assert r.returncode == 2, r.stdout
    assert (root / "Canon" / "cast.json").read_bytes() == before
    assert "CONFLICT vale voice.ref" in r.stdout
    assert "Production/voice-refs/vale.wav" in r.stdout
    assert "Production/voice-refs/vale-2.wav" in r.stdout
    assert "4 entries, 1 conflict" in r.stdout
    assert row(r.stdout, "harbor")          # the table prints anyway


def test_build_preserves_a_debut_the_index_already_carries(tmp_path):
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    index = root / "Canon" / "cast.json"
    doc = json.loads(index.read_text(encoding="utf-8"))
    doc["cast"]["warden"]["debut"] = "s01e07"
    index.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    r = run(BUILD, root, "--write")
    assert r.returncode == 0, r.stdout
    again = json.loads(index.read_text(encoding="utf-8"))
    assert again["cast"]["warden"]["debut"] == "s01e07"
    assert again["cast"]["vale"]["debut"] == "s01e01"


def test_build_keeps_a_hand_edited_kind_and_identity_and_fills_only_what_is_absent(tmp_path):
    """F4: `kind`, `identity` and `baseline_prompt` are an author's fields once the index holds
    them. The visual bible seeds them on the first build and fills a gap on any later one, and a
    disagreement is reported rather than resolved in the bible's favour -- the casting stop writes
    an identity and a baseline prompt into the index (spec 2026-10-31 §2.2), and a second build
    that overwrote them from a registry the migration is retiring would undo a casting."""
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    index = root / "Canon" / "cast.json"
    doc = json.loads(index.read_text(encoding="utf-8"))
    doc["cast"]["warden"]["kind"] = "creature"
    doc["cast"]["warden"]["identity"] = "hand-written: a shape on the stair, never a face"
    # A gap the bible can fill: vale's baseline prompt is deleted from the index.
    del doc["cast"]["vale"]["baseline_prompt"]
    index.write_text(json.dumps(doc, indent=2), encoding="utf-8")

    r = run(BUILD, root, "--write")
    assert r.returncode == 0, r.stdout
    cast = json.loads(index.read_text(encoding="utf-8"))["cast"]
    assert cast["warden"]["kind"] == "creature"
    assert cast["warden"]["identity"] == "hand-written: a shape on the stair, never a face"
    assert "kept from the index: warden.kind" in r.stdout
    assert "kept from the index: warden.identity" in r.stdout
    # Filled, because the index carried none: the bible is still a source, just not an authority.
    assert cast["vale"]["baseline_prompt"] == BIBLE["vale"]["baseline_prompt"]
    # And silent where the two agree: vale's identity came from this bible in the first place.
    assert "kept from the index: vale.identity" not in r.stdout


def test_build_names_audio_even_with_no_registry_and_warns_that_the_tts_script_will_refuse(tmp_path):
    """F11: the TTS prompt copies the manifest's `engine` from the index's `audio.engine`, so an
    index without one stops the manifest. The build says so at the moment it writes, and writes
    `audio` as an empty object rather than omitting the key, so the field an author has to fill is
    visible in the file rather than inferred from its absence."""
    root = bare_show(tmp_path, "no-registry")
    write(root / "Canon" / "refs.json", json.dumps({
        "harbor": {"kind": "location", "ref": "Canon/locations/harbor.png", "identity": "the harbor"}}, indent=2))
    png(root / "Canon" / "locations" / "harbor.png")

    r = run(BUILD, root, "--write")
    assert r.returncode == 0, r.stderr
    assert "no audio.engine found — the TTS script will refuse until it is set" in r.stdout
    doc = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))
    assert doc["audio"] == {}
    # The dry run says it too: the dry run is where the merge is reviewed.
    assert "no audio.engine found" in run(BUILD, root).stdout


def test_build_keys_a_the_prefixed_bible_entry_as_the_bible_keyed_it(tmp_path):
    """The bible used `the-warden`, so the sheet folder `The Warden` merges onto `the-warden` --
    the key the engine accepts as the alternative on read -- and not onto a second entry."""
    root = bare_show(tmp_path, "the-form")
    write(root / "Canon" / "refs.json", json.dumps({
        "the-warden": {"kind": "character", "ref": "Canon/characters/The Warden/reference.png",
                       "identity": "the Warden", "locked": "sheet, 2026-07-21"}}, indent=2))
    write(root / "Canon" / "characters" / "The Warden" / "the-warden.md", "# the Warden\n")
    png(root / "Canon" / "characters" / "The Warden" / "reference.png")

    assert run(BUILD, root, "--write").returncode == 0
    cast = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))["cast"]
    assert set(cast) == {"the-warden"}
    assert cast["the-warden"]["sheet"] == "Canon/characters/The Warden/the-warden.md"
    # This fixture carries no voice registry, so the folder's own spelling is the display name.
    assert cast["the-warden"]["name"] == "The Warden"


def test_build_keys_a_the_named_sheet_folder_under_the_plain_slug_when_the_bible_did(tmp_path):
    """The same folder, the other way round: the bible used `warden`, so the folder `The Warden`
    merges onto `warden` rather than making a second entry under `the-warden`."""
    root = bare_show(tmp_path, "plain-form")
    write(root / "Canon" / "refs.json", json.dumps({
        "warden": {"kind": "character", "ref": "Canon/characters/The Warden/reference.png",
                   "identity": "the Warden", "locked": "sheet, 2026-07-21"}}, indent=2))
    write(root / "Canon" / "characters" / "The Warden" / "the-warden.md", "# the Warden\n")
    png(root / "Canon" / "characters" / "The Warden" / "reference.png")

    assert run(BUILD, root, "--write").returncode == 0
    cast = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))["cast"]
    assert set(cast) == {"warden"}
    assert cast["warden"]["sheet"] == "Canon/characters/The Warden/the-warden.md"


def test_build_files_the_narrator_as_a_voice_with_no_face_and_no_sheet(tmp_path):
    """The narrator is a voice and nothing else: kind "voice", speaks true, no `face` key at all,
    which is also the case that proves the build runs with no visual bible on disk."""
    root = bare_show(tmp_path, "voice-only")
    write(root / "Production" / "voice-refs" / "refs.json", json.dumps({
        "engine": "qwen3", "model": "m", "note": "n",
        "cast": {"narrator": {"ref": "Production/voice-refs/narrator.wav", "ref_text": "The light.",
                              "status": "LOCKED", "direction": "measured", "fx": None}}}, indent=2))

    r = run(BUILD, root, "--write")
    assert r.returncode == 0, r.stderr
    cast = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))["cast"]
    assert set(cast) == {"narrator"}
    assert cast["narrator"]["name"] == "narrator"
    assert cast["narrator"]["kind"] == "voice"
    assert cast["narrator"]["speaks"] is True
    assert "face" not in cast["narrator"]
    assert "sheet" not in cast["narrator"]


def test_build_refuses_an_empty_merge_rather_than_writing_an_empty_index(tmp_path):
    """Nothing to merge is the symptom of a wrong --show-root, not a show with no cast."""
    root = bare_show(tmp_path, "empty")
    r = run(BUILD, root, "--write")
    assert r.returncode == 1
    assert not (root / "Canon" / "cast.json").exists()
    assert "nothing to merge" in r.stdout + r.stderr


def test_build_takes_show_root_from_the_flag(tmp_path):
    root = fixture_show(tmp_path)
    r = run(BUILD, tmp_path, "--write", "--show-root", str(root))
    assert r.returncode == 0, r.stderr
    assert (root / "Canon" / "cast.json").exists()
    assert not (tmp_path / "Canon").exists()


# ── cast-audit.py ───────────────────────────────────────────────────────────────────────────────

def test_audit_names_every_gap_in_the_built_index(tmp_path):
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0

    r = run(AUDIT, root)
    assert r.returncode == 0, r.stderr
    ghost, harbor, vale, warden = (row(r.stdout, k) for k in ("ghost", "harbor", "vale", "warden"))
    assert "face missing" in ghost and "voice none" in ghost and "sheet none" in ghost
    assert "face ok" in harbor and "voice none" in harbor and "sheet none" in harbor
    assert "face ok" in vale and "voice locked" in vale and "sheet ok" in vale
    assert "face ok" in warden and "voice not-locked" in warden and "sheet ok" in warden
    assert "gallery 0" in vale


def test_audit_calls_a_null_voice_silent_and_a_missing_face_none(tmp_path):
    root = bare_show(tmp_path, "shapes")
    write(root / "Canon" / "cast.json", json.dumps({"version": 1, "cast": {
        "warden": {"name": "the Warden", "kind": "character", "speaks": False, "silent": True,
                   "voice": None, "face": {"ref": "Canon/characters/Warden/reference.png",
                                           "gallery": ["Canon/characters/Warden/gallery/01.png"]}},
        "pim": {"name": "Dock Hand Pim", "kind": "human", "speaks": True,
                "baseline_prompt": "sheet"}}}, indent=2))
    png(root / "Canon" / "characters" / "Warden" / "reference.png")
    png(root / "Canon" / "characters" / "Warden" / "gallery" / "01.png")

    r = run(AUDIT, root)
    assert r.returncode == 0, r.stderr
    assert "voice silent" in row(r.stdout, "warden")
    assert "gallery 1" in row(r.stdout, "warden")
    assert "face none" in row(r.stdout, "pim")


def retired_tree(tmp_path: Path) -> Path:
    """A retired repository's shape: per-episode guest take directories and TTS manifests."""
    retired = tmp_path / "retired"
    guests = retired / "Production" / "ep03" / "guest-refs"
    for take in ("pim-1.wav", "pim-2.wav", "maeve-1-FX.wav"):
        (guests / take).parent.mkdir(parents=True, exist_ok=True)
        (guests / take).write_bytes(b"RIFF")
    write(retired / "Production" / "ep03" / "tts-script.json", json.dumps({
        "engine": "qwen3",
        "cast": {
            "Vale": {"ref": "Production/voice-refs/vale.wav", "ref_text": "Light's lit.",
                     "direction": "weathered"},
            "the Warden": {"guest": True, "ref": "Production/ep03/guest-refs/warden-1.wav",
                           "ref_text": "You will not pass.", "direction": "flat"},
            "Pim": {"guest": True, "ref": "Production/ep03/guest-refs/pim-1.wav",
                    "ref_text": "Haul it in before the tide turns.", "direction": "young, hurried"},
        }}, indent=2))
    return retired


def snapshot(tree: Path) -> dict[str, tuple[int, int]]:
    return {str(p.relative_to(tree)): (p.stat().st_size, p.stat().st_mtime_ns)
            for p in sorted(tree.rglob("*"))}


def test_audit_lists_the_retired_repositorys_guests_that_the_index_lacks(tmp_path):
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    retired = retired_tree(tmp_path)

    r = run(AUDIT, root, "--retired", str(retired))
    assert r.returncode == 0, r.stderr
    gaps = section(r.stdout, "guests in the retired repository with no entry in")
    assert len(gaps) == 1, gaps                       # the Warden is in the index; Vale is no guest
    assert "Pim" in gaps[0]
    assert "ep03" in gaps[0] and "s01e03" in gaps[0]
    assert "Production/ep03/guest-refs/pim-1.wav" in gaps[0]
    assert "Haul it in before the tide turns." in gaps[0]
    assert "maeve-1-FX.wav" in r.stdout               # a take no manifest casts


def test_audit_retired_scan_writes_nothing_under_the_retired_tree(tmp_path):
    """--retired is read-only: no write, no temp file, nothing created, ever."""
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    retired = retired_tree(tmp_path)
    before = snapshot(retired)

    r = run(AUDIT, root, "--retired", str(retired))
    assert r.returncode == 0, r.stderr
    assert snapshot(retired) == before


def test_audit_calls_a_take_cast_when_a_manifest_ref_names_it_whatever_the_slug(tmp_path):
    """F3: a take is cast when a manifest cast entry's `ref` names the file. The slug of the
    display name is only the fallback, for an entry that records no `ref` at all.

    The case that forces it is a display name carrying a title: "Dock Hand Pim" slugs to
    `dock-hand-pim` while her takes on disk are `pim-1.wav`, so the slug comparison called the
    very file the manifest cast her from "a WAV no manifest casts" -- and the promotion list that
    is read off this output would have offered a hand a take that was already the one in use.
    """
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    retired = tmp_path / "titled"
    guests = retired / "Production" / "ep04" / "guest-refs"
    guests.mkdir(parents=True)
    for take in ("pim-1.wav", "pim-2.wav", "nobody-1.wav", "maeve-1.wav"):
        (guests / take).write_bytes(b"RIFF")
    write(retired / "Production" / "ep04" / "tts-script.json", json.dumps({
        "engine": "qwen3",
        "cast": {
            # Cast by ref, and her slug matches none of her takes.
            "Dock Hand Pim": {"guest": True, "ref": "Production/ep04/guest-refs/pim-1.wav",
                              "ref_text": "Haul it in.", "direction": "young, hurried"},
            # No ref recorded at all: the slug fallback is all there is, and it finds maeve-1.wav.
            "Maeve": {"guest": True, "ref_text": "Tide's turning.", "direction": "dry"},
        }}, indent=2))

    r = run(AUDIT, root, "--retired", str(retired))
    assert r.returncode == 0, r.stderr
    orphans = "\n".join(section(r.stdout, "guest WAVs no retired manifest casts"))
    assert "pim-1.wav" not in orphans, orphans      # the manifest's ref names it: it was cast
    assert "pim-2.wav" in orphans, orphans          # a second take of hers that nothing cast
    assert "nobody-1.wav" in orphans, orphans       # a WAV no manifest names in any way
    assert "maeve-1.wav" not in orphans, orphans    # the fallback, for an entry with no ref


def test_audit_skips_the_retired_repositorys_exercise_episodes_and_says_so(tmp_path):
    """ep98 and ep99 are the engine's exercise fixtures and not episodes of the show. Their
    guest-refs hold takes nobody cast and their manifests cast names nobody wrote, so scanning
    them puts invented characters on a promotion list a hand reads."""
    root = fixture_show(tmp_path)
    assert run(BUILD, root, "--write").returncode == 0
    retired = retired_tree(tmp_path)
    for ep in ("ep98", "ep99"):
        guests = retired / "Production" / ep / "guest-refs"
        guests.mkdir(parents=True, exist_ok=True)
        (guests / "exercise-1.wav").write_bytes(b"RIFF")
        write(retired / "Production" / ep / "tts-script.json", json.dumps({
            "cast": {"Exercise": {"guest": True, "ref": f"Production/{ep}/guest-refs/exercise-1.wav",
                                  "ref_text": "x", "direction": "y"}}}, indent=2))

    r = run(AUDIT, root, "--retired", str(retired))
    assert r.returncode == 0, r.stderr
    assert "skipped ep98, ep99 (the engine's exercise fixtures, not episodes)" in r.stdout
    assert "Exercise" not in r.stdout
    assert "exercise-1.wav" not in r.stdout
    assert "scanned 1 episode manifest" in r.stdout   # ep03's, and no other


def test_audit_says_what_to_run_when_there_is_no_index(tmp_path):
    root = bare_show(tmp_path, "unbuilt")
    r = run(AUDIT, root)
    assert r.returncode != 0
    assert "cast-index-build.py --write" in r.stdout + r.stderr


# ── cast-prune.py ───────────────────────────────────────────────────────────────────────────────

VALE_GALLERY = ["Canon/characters/Vale/gallery/01.png", "Canon/characters/Vale/gallery/02.png"]

# The five images that are neither the reference nor a gallery entry: three at the folder's top
# level (one with an arbitrary name), two nested, because the prune looks recursively.
VALE_EXCESS = ["extra-1.png", "extra-2.png", "Vale Candidate.png", "shots/ep01-02.png",
               "gallery/03.png"]


def prune_show(tmp_path: Path, gallery: list[str] | None = None,
               excess: list[str] | None = None) -> Path:
    """A show whose index is written by hand: one character folder to prune, one location left
    alone (its reference is outside the character folders), one folder with no index entry."""
    root = bare_show(tmp_path, "prune")
    gallery = VALE_GALLERY if gallery is None else gallery
    excess = VALE_EXCESS if excess is None else excess
    write(root / "Canon" / "cast.json", json.dumps({"version": 1, "cast": {
        "vale": {"name": "Vale", "kind": "human", "speaks": True, "debut": "s01e01",
                 "sheet": "Canon/characters/Vale/vale.md",
                 "face": {"ref": "Canon/characters/Vale/reference.png", "gallery": gallery}},
        "harbor": {"name": "Harbor", "kind": "location", "speaks": False,
                   "face": {"ref": "Canon/locations/harbor.png", "gallery": []}}}}, indent=2))
    write(root / "Canon" / "characters" / "Vale" / "vale.md", "# Vale\n")
    png(root / "Canon" / "characters" / "Vale" / "reference.png")
    for rel in gallery:
        png(root / rel)
    for rel in excess:
        png(root / "Canon" / "characters" / "Vale" / rel)
    png(root / "Canon" / "locations" / "harbor.png")
    write(root / "Canon" / "characters" / "Maeve" / "maeve.md", "# Maeve\n")
    png(root / "Canon" / "characters" / "Maeve" / "reference.png")
    png(root / "Canon" / "characters" / "Maeve" / "extra.png")
    return root


def moves(out: str) -> list[str]:
    return [line.strip() for line in out.splitlines() if line.strip().startswith("move ")]


def archived(archive: Path) -> list[str]:
    """Every file in one character's archive, as archive-relative posix paths and sorted, because
    the archive mirrors the character folder's own layout (F18) and a set of basenames could not
    tell `gallery/03.png` from a `03.png` moved up to the top level."""
    return sorted(str(p.relative_to(archive)).replace("\\", "/")
                  for p in archive.rglob("*") if p.is_file())


def test_prune_dry_run_prints_the_moves_and_moves_nothing(tmp_path):
    root = prune_show(tmp_path)
    before = (root / "Canon" / "cast.json").read_bytes()

    r = run(PRUNE, root)
    assert r.returncode == 0, r.stderr
    assert len(moves(r.stdout)) == 5, r.stdout
    assert "--apply" in r.stdout
    assert not (root / "Production" / "_archive").exists()
    for rel in VALE_EXCESS:
        assert (root / "Canon" / "characters" / "Vale" / rel).exists()
    assert (root / "Canon" / "cast.json").read_bytes() == before


def test_prune_apply_moves_the_excess_out_of_canon_and_is_idempotent(tmp_path):
    root = prune_show(tmp_path)
    r = run(PRUNE, root, "--apply")
    assert r.returncode == 0, r.stderr

    # The archive mirrors the folder: an image keeps the path it had inside the character folder,
    # so `gallery/03.png` is recognisable in the archive as the gallery image it was and not as a
    # file called `03.png` beside four others (F18).
    archive = root / "Production" / "_archive" / "characters" / "Vale"
    assert archived(archive) == [
        "Vale Candidate.png", "extra-1.png", "extra-2.png", "gallery/03.png", "shots/ep01-02.png"]
    vale = root / "Canon" / "characters" / "Vale"
    assert sorted(str(p.relative_to(vale)) for p in vale.rglob("*") if p.is_file()) == [
        "gallery/01.png", "gallery/02.png", "reference.png", "vale.md"]

    again = run(PRUNE, root, "--apply")
    assert again.returncode == 0, again.stderr
    assert moves(again.stdout) == []
    assert "nothing to move" in again.stdout
    assert archived(archive) == [
        "Vale Candidate.png", "extra-1.png", "extra-2.png", "gallery/03.png", "shots/ep01-02.png"]


def test_prune_trims_an_index_gallery_of_four_to_three(tmp_path):
    gallery = [f"Canon/characters/Vale/gallery/0{n}.png" for n in (1, 2, 3, 4)]
    root = prune_show(tmp_path, gallery=gallery, excess=["extra-1.png"])

    r = run(PRUNE, root, "--apply")
    assert r.returncode == 0, r.stderr
    vale = root / "Canon" / "characters" / "Vale"
    assert sorted(str(p.relative_to(vale)) for p in vale.rglob("*") if p.is_file()) == [
        "gallery/01.png", "gallery/02.png", "gallery/03.png", "reference.png", "vale.md"]
    archive = root / "Production" / "_archive" / "characters" / "Vale"
    assert archived(archive) == ["extra-1.png", "gallery/04.png"]
    cast = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))["cast"]
    assert cast["vale"]["face"]["gallery"] == gallery[:3]


def test_prune_lists_a_folder_with_no_index_entry_and_leaves_it_alone(tmp_path):
    root = prune_show(tmp_path)
    r = run(PRUNE, root, "--apply")
    assert r.returncode == 0, r.stderr
    listed = section(r.stdout, "folders with no entry in")
    assert len(listed) == 1 and "Canon/characters/Maeve" in listed[0]
    maeve = root / "Canon" / "characters" / "Maeve"
    assert sorted(p.name for p in maeve.iterdir()) == ["extra.png", "maeve.md", "reference.png"]


def test_prune_keep_names_the_gallery_that_survives(tmp_path):
    root = prune_show(tmp_path)
    r = run(PRUNE, root, "--apply", "--keep", "vale=extra-1.png,shots/ep01-02.png")
    assert r.returncode == 0, r.stderr
    vale = root / "Canon" / "characters" / "Vale"
    assert sorted(str(p.relative_to(vale)) for p in vale.rglob("*") if p.is_file()) == [
        "extra-1.png", "reference.png", "shots/ep01-02.png", "vale.md"]
    cast = json.loads((root / "Canon" / "cast.json").read_text(encoding="utf-8"))["cast"]
    assert cast["vale"]["face"]["gallery"] == [
        "Canon/characters/Vale/extra-1.png", "Canon/characters/Vale/shots/ep01-02.png"]


def test_prune_refuses_a_keep_of_more_than_three_and_a_keep_it_cannot_find(tmp_path):
    """A refusal exits 1, the way every script in this directory refuses; exit 2 is reserved for
    cast-index-build.py's one meaning, "two sources disagree about a path"."""
    root = prune_show(tmp_path)
    four = run(PRUNE, root, "--apply", "--keep",
               "vale=extra-1.png,extra-2.png,gallery/01.png,gallery/02.png")
    assert four.returncode == 1
    assert "three" in four.stdout + four.stderr
    unknown = run(PRUNE, root, "--apply", "--keep", "vale=nope.png")
    assert unknown.returncode == 1
    assert "nope.png" in unknown.stdout + unknown.stderr
    nobody = run(PRUNE, root, "--apply", "--keep", "nobody=extra-1.png")
    assert nobody.returncode == 1
    assert "nobody" in nobody.stdout + nobody.stderr
    assert not (root / "Production" / "_archive").exists()


def test_prune_suffixes_a_name_collision_in_the_archive(tmp_path):
    """A collision is suffixed in the directory the file lands in, which under F18 is the mirror of
    the folder it came from: the archive already holds `extra-1.png` at its top level, so the one
    moved there becomes `extra-1-2.png`, and `gallery/03.png` collides with nothing."""
    root = prune_show(tmp_path)
    png(root / "Production" / "_archive" / "characters" / "Vale" / "extra-1.png")

    r = run(PRUNE, root, "--apply")
    assert r.returncode == 0, r.stderr
    archive = root / "Production" / "_archive" / "characters" / "Vale"
    assert archived(archive) == [
        "Vale Candidate.png", "extra-1-2.png", "extra-1.png", "extra-2.png", "gallery/03.png",
        "shots/ep01-02.png"]
