import importlib.util, json, os, sys

def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "registry_append", os.path.join(here, "registry-append.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

ra = _load()

def _setup(tmp_path):
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    trent = tmp_path / "Canon/characters/Trent"; trent.mkdir(parents=True)
    sheet = trent / "Trent Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-t", "type": "character", "refs": ["Trent", "relic (x)"]},
        {"id": "s2-guest", "type": "character", "refs": ["newguy"]},
        {"id": "s3-missing-png", "type": "character", "refs": ["trent"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-t.png").write_bytes(b"one")
    (img / "s2-guest.png").write_bytes(b"two")
    bible = {"trent": {"kind": "human", "ref": str(sheet), "identity": "t"},
             "relic": {"kind": "prop", "ref": str(sheet), "identity": "r"}}
    return img, bible

def test_append_copies_only_characters_not_props(tmp_path, monkeypatch):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"))
    names = [os.path.basename(p) for p in copied]
    assert "ep99-s1-t.png" in names                 # trent: copied
    assert all("relic" not in p.lower() for p in copied)  # prop: skipped
    dest = tmp_path / "Canon/characters/Trent/ep99-s1-t.png"
    assert dest.read_bytes() == b"one"

def test_append_ship_kind_copied_but_location_kind_still_skipped(tmp_path, monkeypatch):
    """The Dead Light is identity-cast (Ryan-ruled 2026-07-28): a kind:"ship"
    bible entry now gets its approved shot copied into her pile, just like a
    human/creature cast member. This must widen CHARACTER_KINDS by exactly
    one kind, not into an allow-all — a kind:"location" entry (e.g. Coalvane)
    must still be skipped."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    ship_dir = tmp_path / "Canon/locations/Dead Light"; ship_dir.mkdir(parents=True)
    ship_sheet = ship_dir / "Dead Light Reference.png"; ship_sheet.write_bytes(b"s")
    loc_dir = tmp_path / "Canon/locations/Coalvane Station"; loc_dir.mkdir(parents=True)
    loc_sheet = loc_dir / "Coalvane Reference.png"; loc_sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-ship", "type": "character", "refs": ["dead-light"]},
        {"id": "s2-loc", "type": "character", "refs": ["coalvane"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-ship.png").write_bytes(b"ship-still")
    (img / "s2-loc.png").write_bytes(b"loc-still")
    bible = {"dead-light": {"kind": "ship", "ref": str(ship_sheet), "identity": "the Dead Light"},
             "coalvane": {"kind": "location", "ref": str(loc_sheet), "identity": "Coalvane Station"}}
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"))
    names = [os.path.basename(p) for p in copied]
    assert "ep99-s1-ship.png" in names                # ship: copied into her pile
    assert (ship_dir / "ep99-s1-ship.png").read_bytes() == b"ship-still"
    assert "ep99-s2-loc.png" not in names             # location: still skipped
    assert not (loc_dir / "ep99-s2-loc.png").exists()

def test_append_unknown_guest_gets_folder_and_warning(tmp_path, monkeypatch, capsys):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    ra.append("ep99", str(img / "prompts.json"), bible,
              str(tmp_path / "Canon/characters"))
    assert (tmp_path / "Canon/characters/Newguy/ep99-s2-guest.png").exists()
    assert "no refs.json entry" in capsys.readouterr().out

def test_append_idempotent_and_skips_missing_png(tmp_path, monkeypatch):
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    root = str(tmp_path / "Canon/characters")
    first = ra.append("ep99", str(img / "prompts.json"), bible, root)
    second = ra.append("ep99", str(img / "prompts.json"), bible, root)
    assert second == []                              # nothing re-copied
    assert not any("s3-missing-png" in p for p in first)

def test_append_unknown_key_matches_existing_folder_by_normalization(tmp_path, monkeypatch, capsys):
    """When an unknown key (no bible entry) normalizes to an existing folder,
    use the existing folder instead of creating a new one with punctuation drift."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    # Existing folder is "The Mute" (space), key will be "the-mute" (hyphen)
    existing = tmp_path / "Canon/characters/The Mute"; existing.mkdir(parents=True)
    sheet = existing / "The Mute Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-mute", "type": "character", "refs": ["the-mute"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-mute.png").write_bytes(b"one")
    bible = {}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root)
    # Image should land in existing folder
    assert (existing / "ep99-s1-mute.png").read_bytes() == b"one"
    # No new "The-Mute" folder should be created
    assert not (tmp_path / "Canon/characters/The-Mute").exists()
    # Should print a note about matching
    assert "matched existing folder" in capsys.readouterr().out

def test_append_unknown_key_with_no_match_creates_title_case(tmp_path, monkeypatch, capsys):
    """When an unknown key has no matching existing folder, create key.title()
    and print the no refs.json entry warning."""
    img = tmp_path / "Production/ep99/images"; img.mkdir(parents=True)
    trent = tmp_path / "Canon/characters/Trent"; trent.mkdir(parents=True)
    sheet = trent / "Trent Reference.png"; sheet.write_bytes(b"s")
    prompts = {"shots": [
        {"id": "s1-guest", "type": "character", "refs": ["genuinelynewguy"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-guest.png").write_bytes(b"one")
    bible = {"trent": {"kind": "human", "ref": str(sheet), "identity": "t"}}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root)
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
    # Create two folders that normalize to the same key (both become "themute")
    folder1 = tmp_path / "Canon/characters/The Mute"; folder1.mkdir(parents=True)
    folder2 = tmp_path / "Canon/characters/TheMute"; folder2.mkdir(parents=True)
    prompts = {"shots": [
        {"id": "s1-mute", "type": "character", "refs": ["the-mute"]}]}
    (img / "prompts.json").write_text(json.dumps(prompts))
    (img / "s1-mute.png").write_bytes(b"one")
    bible = {}
    root = str(tmp_path / "Canon/characters")
    copied = ra.append("ep99", str(img / "prompts.json"), bible, root)
    # Nothing should be copied
    assert copied == []
    # No new folder created
    assert not (tmp_path / "Canon/characters/The-Mute").exists()
    # Should warn about multiple matches
    output = capsys.readouterr().out
    assert "matches multiple folders" in output
    assert "The Mute" in output or "TheMute" in output  # candidate names mentioned

def test_append_existing_dst_identical_bytes_skips_silently(tmp_path, monkeypatch, capsys):
    """I4 regression: a pile copy whose bytes already match the source is
    already correctly filed — skip it silently, exactly as before."""
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    dst = tmp_path / "Canon/characters/Trent/ep99-s1-t.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b"one")                           # identical to src (s1-t.png)
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"))
    assert not any("s1-t" in p for p in copied), "identical bytes must not be re-copied"
    assert dst.read_bytes() == b"one"
    assert "UPDATED" not in capsys.readouterr().out

def test_append_existing_dst_differing_bytes_replaces_and_prints_message(tmp_path, monkeypatch, capsys):
    """I4 regression: when the shot was re-rolled with --only and re-approved,
    the source bytes now differ from what's in the pile. The stale/rejected
    copy must be replaced (never silently kept), and the operator must see
    which pile file was updated for which shot."""
    img, bible = _setup(tmp_path); monkeypatch.chdir(tmp_path)
    dst = tmp_path / "Canon/characters/Trent/ep99-s1-t.png"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(b"stale-rejected-version")         # differs from src (b"one")
    copied = ra.append("ep99", str(img / "prompts.json"), bible,
                       str(tmp_path / "Canon/characters"))
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

def test_main_prefers_argv_over_arguments_env(tmp_path, monkeypatch):
    """I1 regression: ARGUMENTS stays exported in a shell across invocations.
    ARGUMENTS=ep04 lingering plus `registry-append.py ep05` on argv must file
    ep05's shots, not silently fall back to the stale ep04 — identical
    precedence to nano-banana-generate's main() (commit 9f29802)."""
    seen = _stub_main_env(tmp_path, monkeypatch)
    monkeypatch.setenv("ARGUMENTS", "ep04")
    monkeypatch.setattr(sys, "argv", ["registry-append.py", "ep05"])
    ra.main()
    assert seen["ep"] == "ep05", "argv was dropped in favor of stale ARGUMENTS"

def test_main_falls_back_to_arguments_env_when_argv_empty(tmp_path, monkeypatch):
    """I1, other side: the Archon bash node passes $ARGUMENTS and no argv.
    That invocation style must keep working."""
    seen = _stub_main_env(tmp_path, monkeypatch)
    monkeypatch.setenv("ARGUMENTS", "ep04")
    monkeypatch.setattr(sys, "argv", ["registry-append.py"])
    ra.main()
    assert seen["ep"] == "ep04"
