import json, os, sys
from conftest import load_script

def _load():
    return load_script("registry-append.py")

ra = _load()

# visual.characterKinds in the fixture show's config: which kinds of subject get a casting pile.
KINDS = ["human", "creature", "ship"]

def _setup(tmp_path):
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    maeve = tmp_path / "Canon/characters/Maeve"; maeve.mkdir(parents=True)
    sheet = maeve / "Maeve Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-t", "type": "character", "refs": ["Maeve", "relic (x)"]},
        {"id": "s2-guest", "type": "character", "refs": ["newguy"]},
        {"id": "s3-missing-png", "type": "character", "refs": ["maeve"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-t.png").write_bytes(b"one")
    (img / "s2-guest.png").write_bytes(b"two")
    bible = {"maeve": {"kind": "human", "ref": str(sheet), "identity": "t"},
             "relic": {"kind": "prop", "ref": str(sheet), "identity": "r"}}
    return img, bible

def test_append_copies_only_characters_not_props(tmp_path, monkeypatch):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"), KINDS)
    names = [os.path.basename(p) for p in copied]
    assert "ep99-s1-t.png" in names                 # maeve: copied
    assert all("relic" not in p.lower() for p in copied)  # prop: skipped
    dest = tmp_path / "Canon/characters/Maeve/ep99-s1-t.png"
    assert dest.read_bytes() == b"one"

def test_append_ship_kind_copied_but_location_kind_still_skipped(tmp_path, monkeypatch):
    """The Harbor Lights is identity-cast: a kind:"ship" bible entry now gets
    its approved shot copied into her pile, just like a human/creature cast
    member. This must widen CHARACTER_KINDS by exactly one kind, not into an
    allow-all — a kind:"location" entry (e.g. Harbor Quay) must still be
    skipped."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    ship_dir = tmp_path / "Canon/locations/Harbor Lights"; ship_dir.mkdir(parents=True)
    ship_sheet = ship_dir / "Harbor Lights Reference.png"; ship_sheet.write_bytes(b"s")
    loc_dir = tmp_path / "Canon/locations/Harbor Quay Station"; loc_dir.mkdir(parents=True)
    loc_sheet = loc_dir / "Harbor Quay Reference.png"; loc_sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-ship", "type": "character", "refs": ["harbor-lights"]},
        {"id": "s2-loc", "type": "character", "refs": ["harbor-quay"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-ship.png").write_bytes(b"ship-still")
    (img / "s2-loc.png").write_bytes(b"loc-still")
    bible = {"harbor-lights": {"kind": "ship", "ref": str(ship_sheet), "identity": "the Harbor Lights"},
             "harbor-quay": {"kind": "location", "ref": str(loc_sheet), "identity": "Harbor Quay Station"}}
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"), KINDS)
    names = [os.path.basename(p) for p in copied]
    assert "ep99-s1-ship.png" in names                # ship: copied into her pile
    assert (ship_dir / "ep99-s1-ship.png").read_bytes() == b"ship-still"
    assert "ep99-s2-loc.png" not in names             # location: still skipped
    assert not (loc_dir / "ep99-s2-loc.png").exists()

def test_append_unknown_guest_gets_folder_and_warning(tmp_path, monkeypatch, capsys):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    ra.append("ep99", str(img / "prompts.json"), bible,
              str(tmp_path / "Canon/characters"), KINDS)
    assert (tmp_path / "Canon/characters/Newguy/ep99-s2-guest.png").exists()
    assert "no refs.json entry" in capsys.readouterr().out

def test_append_idempotent_and_skips_missing_png(tmp_path, monkeypatch):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    root = str(tmp_path / "Canon/characters")
    first = ra.append("ep99", str(img / "prompts.json"), bible, root, KINDS)
    second = ra.append("ep99", str(img / "prompts.json"), bible, root, KINDS)
    assert second == []                              # nothing re-copied
    assert not any("s3-missing-png" in p for p in first)

def test_append_unknown_key_matches_existing_folder_by_normalization(tmp_path, monkeypatch, capsys):
    """When an unknown key (no bible entry) normalizes to an existing folder,
    use the existing folder instead of creating a new one with punctuation drift."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    # Existing folder is "The Keeper" (space), key will be "the-keeper" (hyphen)
    existing = tmp_path / "Canon/characters/The Keeper"; existing.mkdir(parents=True)
    sheet = existing / "The Keeper Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-keeper", "type": "character", "refs": ["the-keeper"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-keeper.png").write_bytes(b"one")
    bible = {}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root, KINDS)
    # Image should land in existing folder
    assert (existing / "ep99-s1-keeper.png").read_bytes() == b"one"
    # No new "The-Keeper" folder should be created
    assert not (tmp_path / "Canon/characters/The-Keeper").exists()
    # Should print a note about matching
    assert "matched existing folder" in capsys.readouterr().out

def test_append_unknown_key_with_no_match_creates_title_case(tmp_path, monkeypatch, capsys):
    """When an unknown key has no matching existing folder, create key.title()
    and print the no refs.json entry warning."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    maeve = tmp_path / "Canon/characters/Maeve"; maeve.mkdir(parents=True)
    sheet = maeve / "Maeve Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-guest", "type": "character", "refs": ["genuinelynewguy"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-guest.png").write_bytes(b"one")
    bible = {"maeve": {"kind": "human", "ref": str(sheet), "identity": "t"}}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root, KINDS)
    # Should create Genuinelynewguy folder
    new_folder = tmp_path / "Canon/characters/Genuinelynewguy"
    assert new_folder.exists()
    assert (new_folder / "ep99-s1-guest.png").read_bytes() == b"one"
    # Should print the no refs.json entry warning
    assert "no refs.json entry" in capsys.readouterr().out

def test_append_multiple_matching_folders_skips_and_warns(tmp_path, monkeypatch, capsys):
    """When multiple existing folders normalize to the same key (fragmented state),
    skip that ref and warn with candidate names; do not deepen the split."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    # Create two folders that normalize to the same key (both become "thekeeper")
    folder1 = tmp_path / "Canon/characters/The Keeper"; folder1.mkdir(parents=True)
    folder2 = tmp_path / "Canon/characters/TheKeeper"; folder2.mkdir(parents=True)
    prompts = {"shots": [
        {"id": "s1-keeper", "type": "character", "refs": ["the-keeper"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-keeper.png").write_bytes(b"one")
    bible = {}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root, KINDS)
    # Nothing should be copied
    assert copied == []
    # No new folder created
    assert not (tmp_path / "Canon/characters/The-Keeper").exists()
    # Should warn about multiple matches
    output = capsys.readouterr().out
    assert "matches multiple folders" in output
    assert "The Keeper" in output or "TheKeeper" in output  # candidate names mentioned

def test_append_existing_dst_identical_bytes_skips_silently(tmp_path, monkeypatch, capsys):
    """I4 regression: a pile copy whose bytes already match the source is
    already correctly filed — skip it silently, exactly as before."""
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    dst = tmp_path / "Canon/characters/Maeve/ep99-s1-t.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b"one")                           # identical to src (s1-t.png)
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"), KINDS)
    assert not any("s1-t" in p for p in copied), "identical bytes must not be re-copied"
    assert dst.read_bytes() == b"one"
    assert "UPDATED" not in capsys.readouterr().out

def test_append_existing_dst_differing_bytes_replaces_and_prints_message(tmp_path, monkeypatch, capsys):
    """I4 regression: when the shot was re-rolled with --only and re-approved,
    the source bytes now differ from what's in the pile. The stale/rejected
    copy must be replaced (never silently kept), and the operator must see
    which pile file was updated for which shot."""
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    dst = tmp_path / "Canon/characters/Maeve/ep99-s1-t.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b"stale-rejected-version")         # differs from src (b"one")
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"), KINDS)
    assert any("ep99-s1-t.png" in p for p in copied), "re-rolled shot must be re-filed"
    assert dst.read_bytes() == b"one", "stale differing copy must be replaced with the new bytes"
    out = capsys.readouterr().out
    assert "UPDATED" in out and "s1-t" in out

def _stub_main_env(tmp_path, monkeypatch):
    """Bare filesystem main() needs: a readable (empty) Canon/refs.json and a
    stubbed append() so we can observe which ep it was called with, without
    touching prompts.json plumbing."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon/refs.json").write_text("{}")
    seen = {}
    def fake_append(ep, prompts_path, bible, characters_root="Canon/characters"):
        seen["ep"] = ep
        return []
    monkeypatch.setattr(ra, "append", fake_append)
    return seen




# --- end to end, through the real script and the show's config -----------------------------

def test_the_script_appends_one_still_from_a_temp_show_root(show_root):
    """The whole path: argv in, visual.refs and visual.castingPileDir out of showrunner.json,
    one still filed into its subject's pile."""
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    canon = show_root / "Canon"
    pile = canon / "characters" / "Maeve"
    pile.mkdir(parents=True)
    sheet = pile / "Maeve Reference.png"
    sheet.write_bytes(b"sheet")
    (canon / "refs.json").write_text(json.dumps({
        "_doc": "the reference index",
        "maeve": {"kind": "human", "ref": "Canon/characters/Maeve/Maeve Reference.png",
                  "identity": "the keeper"},
    }))
    img = show_root / "Production" / "ep01" / "images"
    img.mkdir(parents=True)
    (img / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s1-maeve", "type": "character", "refs": ["Maeve"]}]}))
    (img / "s1-maeve.png").write_bytes(b"still")

    r = subprocess.run([sys.executable, str(SCRIPTS_DIR / "registry-append.py"), "ep01"],
                       cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (pile / "ep01-s1-maeve.png").read_bytes() == b"still"
    assert r.stdout.strip().splitlines()[-1] == "REGISTRY_OK 1 still(s) appended"


def test_a_kind_the_show_does_not_cast_is_rejected(show_root):
    """visual.characterKinds is the show's taxonomy of what gets a pile. A kind outside it —
    a prop, a location — has a reference entry but no casting pile, and is skipped."""
    import subprocess, sys
    from conftest import SCRIPTS_DIR

    canon = show_root / "Canon"
    pile = canon / "characters" / "Maeve"
    pile.mkdir(parents=True)
    (pile / "Maeve Reference.png").write_bytes(b"sheet")
    (canon / "refs.json").write_text(json.dumps({
        "maeve": {"kind": "human", "ref": "Canon/characters/Maeve/Maeve Reference.png",
                  "identity": "the keeper"},
        "lamp": {"kind": "prop", "ref": "Canon/characters/Maeve/Maeve Reference.png",
                 "identity": "the lamp"},
    }))
    img = show_root / "Production" / "ep01" / "images"
    img.mkdir(parents=True)
    (img / "prompts.json").write_text(json.dumps({"shots": [
        {"id": "s1-lamp", "type": "character", "refs": ["lamp"]}]}))
    (img / "s1-lamp.png").write_bytes(b"still")

    r = subprocess.run([sys.executable, str(SCRIPTS_DIR / "registry-append.py"), "ep01"],
                       cwd=str(show_root), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "REGISTRY_OK 0 still(s) appended"
    assert not (pile / "ep01-s1-lamp.png").exists()
