"""lib/castindex: the Python side of Canon/cast.json (spec 2026-10-31 §1.2)."""
from __future__ import annotations
import json
import pytest
from lib import castindex


@pytest.mark.parametrize("name,slug", [
    ("Vale", "vale"), ("the Warden", "warden"), ("The Warden", "warden"), ("Dock Hand Pim", "dock-hand-pim"),
    ("  Maeve  ", "maeve"), ("Harbor's Edge", "harbor-s-edge"), ("the-warden", "warden"),
    # The one case that pins the ORDER of the two rules rather than either rule alone. The engine's
    # slugName drops a leading "the" BEFORE collapsing runs of punctuation to hyphens, and its
    # character class is `^the[ -]`, so an underscore after the article is not a separator the rule
    # recognises and the article survives: "the_warden" -> "the-warden", not "warden". Collapsing
    # first would turn the underscore into a hyphen, the rule would then match, and the slug would
    # come out "warden" — a different key for the same name on the two sides of the port. The seven
    # cases above pass under either order; this is the one that does not.
    ("the_warden", "the-warden"),
])
def test_slug_name_matches_the_engine(name, slug):
    assert castindex.slug_name(name) == slug


def _show(tmp_path, index):
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon" / "cast.json").write_text(json.dumps(index), encoding="utf-8")
    return {"canonDir": "Canon"}


INDEX = {"version": 1, "cast": {
    # vale's gallery names one file that is written to disk below and one that is not: the index is
    # a record an author edits, so an entry can outlive the image it names, and a path handed to a
    # generator has to be a file.
    "vale": {"name": "Vale", "kind": "human", "speaks": True, "identity": "Vale", "face": {"ref": "Canon/characters/Vale/reference.png", "gallery": ["Canon/characters/Vale/gallery/01.png", "Canon/characters/Vale/gallery/gone.png"]}},
    "the-warden": {"name": "the Warden", "kind": "character", "speaks": False, "silent": True, "face": {"ref": "Canon/characters/Warden/reference.png", "gallery": []}},
    # Keyed `pim` and named "Dock Hand Pim": the key is what the migration filed her under and the
    # name is what the script calls her, which is the pair the third lookup exists for.
    "pim": {"name": "Dock Hand Pim", "kind": "human", "speaks": True, "baseline_prompt": "sheet", "face": {}},
}}


def test_load_entry_faces_and_unlocked(tmp_path):
    cfg = _show(tmp_path, INDEX)
    for rel in ("Canon/characters/Vale/reference.png", "Canon/characters/Warden/reference.png",
                "Canon/characters/Vale/gallery/01.png"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True); (tmp_path / rel).write_bytes(b"png")
    index = castindex.load(cfg, str(tmp_path))
    assert castindex.entry(index, "Warden")["name"] == "the Warden"
    assert castindex.entry(index, "Nobody") is None
    faces = castindex.faces(index, str(tmp_path))
    assert set(faces) == {"vale", "the-warden"}
    assert faces["vale"]["ref"].endswith("Canon/characters/Vale/reference.png")
    # One entry of vale's two-file gallery is on disk; the other is dropped rather than handed to a
    # generator as a path that does not resolve.
    assert faces["vale"]["gallery"] == [str(tmp_path / "Canon/characters/Vale/gallery/01.png")]
    assert castindex.unlocked(index) == ["pim"]


def test_entry_and_key_of_find_an_entry_by_its_own_name(tmp_path):
    """The third lookup (R-01, and F17 of the 2026-10-31 whole-branch review): the slug, then
    `the-<slug>`, then the entry whose own `name` slugs to the slug.

    An entry's key is whatever it was filed under -- the migration writes `pim` -- while the
    outline and the script name the character the way the audience hears it, "Dock Hand Pim".
    Neither `dock-hand-pim` nor `the-dock-hand-pim` is a key, so without the scan a fully cast
    character reads as unregistered to every Python caller while the engine's `castKey`
    (engine/src/cast.ts) finds her: the two sides of the port would disagree about who is cast.
    """
    cfg = _show(tmp_path, INDEX)
    index = castindex.load(cfg, str(tmp_path))
    assert castindex.key_of(index, "Dock Hand Pim") == "pim"
    assert castindex.entry(index, "Dock Hand Pim")["baseline_prompt"] == "sheet"
    # The first two lookups still answer first, and an unknown name is still unknown.
    assert castindex.key_of(index, "Vale") == "vale"
    assert castindex.key_of(index, "Warden") == "the-warden"
    assert castindex.key_of(index, "Nobody") is None
    assert castindex.entry(index, "Nobody") is None


def test_faces_caps_a_gallery_at_three(tmp_path):
    """Spec 2026-10-31 §1.2a: the generator conditions on the reference plus at most three gallery
    stills, and the cap is the index module's to apply so no caller can widen it by accident."""
    index = {"version": 1, "cast": {"maeve": {"name": "Maeve", "kind": "human", "speaks": True,
             "face": {"ref": "Canon/characters/Maeve/reference.png",
                      "gallery": [f"Canon/characters/Maeve/gallery/{i:02d}.png" for i in range(1, 6)]}}}}
    cfg = _show(tmp_path, index)
    (tmp_path / "Canon/characters/Maeve/gallery").mkdir(parents=True)
    (tmp_path / "Canon/characters/Maeve/reference.png").write_bytes(b"png")
    for i in range(1, 6):
        (tmp_path / f"Canon/characters/Maeve/gallery/{i:02d}.png").write_bytes(b"png")
    gallery = castindex.faces(castindex.load(cfg, str(tmp_path)), str(tmp_path))["maeve"]["gallery"]
    assert [p.split("/")[-1] for p in gallery] == ["01.png", "02.png", "03.png"]


def test_missing_index_names_the_remedy(tmp_path):
    (tmp_path / "Canon").mkdir()
    with pytest.raises(castindex.CastIndexMissing) as err:
        castindex.load({"canonDir": "Canon"}, str(tmp_path))
    assert "cast-index-build.py --write" in str(err.value)
