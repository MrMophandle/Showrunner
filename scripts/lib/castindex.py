"""The show's cast index, Canon/cast.json: the one record of who has a sheet, a face and a voice
(spec 2026-10-31 §1.2). Every script that used to open Canon/refs.json or the voice registry's
cast map reads this instead; nothing lists the characters directory.

The engine's twin is engine/src/cast.ts, and the two must agree about three things or one side
will look for a character the other has filed: the index's path (index_path / castIndexPath), the
key a display name slugs to (slug_name / slugName), and the three lookups a name is resolved
through (key_of / castKey: the slug, `the-<slug>`, then an entry whose own `name` slugs to the
slug). tests/test_castindex.py pins the cases the port depends on, including the one that fixes
the article rule's order (the_warden -> the-warden) and the titled display name the third lookup
exists for; nothing on the engine side tests the same list, so a change to slugName must be
mirrored here by hand.
"""
from __future__ import annotations
import json
import os
import re


class CastIndexMissing(FileNotFoundError):
    """No index at the configured path. A FileNotFoundError subclass because every caller's
    `__main__` guard already catches that and prints it with the script's name in front, so the
    remedy this carries reaches the operator as `<script>: no cast index at … — run …`."""


def slug_name(name: str) -> str:
    """The port of engine/src/cast.ts's slugName (needs.ts re-exports it under its old name):
    lowercase, a leading "the" dropped, runs of anything but [a-z0-9] to one hyphen, hyphens
    trimmed.

    The order of the middle two rules is load-bearing and is pinned by a test. The article is
    dropped BEFORE the collapse and its character class is `^the[ -]`, so "the Warden" and
    "the-warden" both key as `warden` while "the_warden" keys as `the-warden` — the underscore is
    not a separator the rule recognises, and the article survives. Collapsing first would turn that
    underscore into a hyphen, the rule would match, and the same name would key differently on the
    two sides of the port.
    """
    s = name.strip().lower()
    s = re.sub(r"^the[ -]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def index_path(cfg: dict) -> str:
    """The index's path, show-relative: `cast.index` where the config names one, and
    `<canonDir>/cast.json` otherwise. Every message naming a path names the value this returned,
    so the file an author is sent to edit is the file the script read."""
    configured = (cfg.get("cast") or {}).get("index")
    if isinstance(configured, str) and configured:
        return configured
    return os.path.join(cfg.get("canonDir") or "Canon", "cast.json")


def load(cfg: dict, root: str) -> dict:
    """The parsed index. Absent and unreadable are different facts with different remedies, which
    is why they are different exceptions: absent means the show has not been migrated and there is
    exactly one thing to do, while present-and-not-an-index means somebody has to look at the
    file and an "I built you one" would invite an overwrite of it."""
    rel = index_path(cfg)
    p = rel if os.path.isabs(rel) else os.path.join(root, rel)
    if not os.path.exists(p):
        raise CastIndexMissing(f"no cast index at {rel} — run scripts/cast-index-build.py --write")
    with open(p, encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or not isinstance(doc.get("cast"), dict):
        raise ValueError(f"{rel}: expected an object with a \"cast\" map")
    return doc


def key_of(index: dict, name: str) -> str | None:
    """The key one cast name is filed under, in three steps: the name's slug, then `the-<slug>`,
    then the entry whose own `name` field slugs to the same thing.

    The third step is what a display name carrying a title needs. An entry's key is whatever it
    was filed under -- the migration writes `pim` -- while the script and the outline name the
    character the way the audience hears it, "Dock Hand Pim", and neither `dock-hand-pim` nor
    `the-dock-hand-pim` is a key. Without the scan a fully cast character reads as unregistered to
    every caller here while the engine's `castKey` (engine/src/cast.ts) finds her, which is the
    one thing the two sides of this port may not do: disagree about who is cast.

    The key is returned rather than only the entry because every message a script writes about a
    gap names it, and an author sent to Canon/cast.json has to be pointed at the line that is
    there. `entry` below is this function plus the lookup, so the two cannot find different
    entries for one name."""
    slug = slug_name(name)
    cast = index["cast"]
    if slug in cast:
        return slug
    if f"the-{slug}" in cast:
        return f"the-{slug}"
    for key, e in cast.items():
        if isinstance(e, dict) and isinstance(e.get("name"), str) and slug_name(e["name"]) == slug:
            return key
    return None


def entry(index: dict, name: str) -> dict | None:
    """One cast entry by display name, through `key_of`'s three lookups."""
    key = key_of(index, name)
    return None if key is None else index["cast"][key]


def _abs(root: str, rel: str) -> str:
    return rel if os.path.isabs(rel) else os.path.join(root, rel)


def faces(index: dict, root: str) -> dict:
    """{key: {"ref", "identity", "gallery", "kind", "name"}} for every entry whose reference image
    exists — the shape image-generate and nano-banana-generate condition on.

    Two filters live here rather than in the callers. An entry whose `ref` names a file that is
    not on disk is left out altogether, so a half-cast subject reads to a generator exactly as an
    uncast one does and falls back instead of failing on a missing path. A gallery is filtered to
    files that exist and then capped at three (spec §1.2a): the index is a record an author edits,
    so an entry can outlive the image it names, and the cap is the index's to apply so that no
    caller can widen it and no caller has to list a directory to find stills.
    """
    out = {}
    for key, e in index["cast"].items():
        ref = (e.get("face") or {}).get("ref")
        if not isinstance(ref, str) or not os.path.exists(_abs(root, ref)):
            continue
        gallery = [_abs(root, g) for g in (e.get("face") or {}).get("gallery", []) if os.path.exists(_abs(root, g))]
        out[key] = {"ref": _abs(root, ref), "identity": e.get("identity", ""), "gallery": gallery[:3],
                    "kind": e.get("kind", ""), "name": e.get("name", key)}
    return out


def unlocked(index: dict) -> list[str]:
    """Keys with a baseline prompt and no reference yet: what design-visual.py designs.

    Not the complement of `faces`. An entry whose `ref` names a file that has gone missing is in
    neither set — `faces` wants the file, this wants the field — because a lost reference is a
    thing to restore from git, not a reason to re-roll candidates over the top of the key.
    """
    return [k for k, e in index["cast"].items()
            if isinstance(e.get("baseline_prompt"), str) and not (e.get("face") or {}).get("ref")]
