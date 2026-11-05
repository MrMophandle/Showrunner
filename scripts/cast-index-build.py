# /// script
# dependencies = []
# ///
"""cast-index-build: build the cast index from the two legacy registries and the character sheets.

Spec 2026-10-31 §4.1. One migration, run by hand, reviewed before it writes.

READS (every source is optional; an absent one is reported and skipped):
  <visual.refs>                  the visual bible -- a flat map keyed by slug whose "_"-prefixed
                                 keys are meta, each entry carrying kind / ref / identity / locked
                                 and sometimes baseline_prompt
  <audio.voiceRefsDir>/refs.json the voice registry -- a `cast` map keyed by DISPLAY NAME, not by
                                 slug, under a top level whose every other key (engine, model,
                                 note, any note the show added) becomes the index's `audio`
  <visual.castingPileDir>/<Name>/<name>.md   one sheet per character folder
  <cast.index>                   the index a previous run wrote, read as a fourth source so that a
                                 second run is a no-op and a hand-written debut survives it

WRITES <cast.index> (Canon/cast.json by default), and only with --write. Nothing else is written,
nothing is deleted, and the two legacy registries are not modified: retiring them is a later,
separate step taken once the index has been verified against them.

Usage:
  cast-index-build.py [--write] [--show-root <path>]

It REFUSES TO WRITE when two sources name different paths for one field of one key -- the
path-bearing fields are `sheet`, `face.ref` and `voice.ref`. It prints the merge table anyway, one
CONFLICT line per disagreement naming both sources and both paths, and exits 2. Refusal rather than
a silent last-source-wins because the registries have drifted across a whole season: a wrongly
chosen path shows up as a generator conditioning on the wrong face or a voice cloned from the wrong
take, episodes later, while a refusal costs one read of a short list.

`debut` is s01e01 for every merged entry unless the entry already carries one. A visual entry whose
`ref` is missing on disk is kept with its `face.ref` and reported, because the remedy is to restore
the file, not to drop the face.

An index already on disk OWNS its `kind`, `identity` and `baseline_prompt`: the visual bible fills
one only where the index has none, and a disagreement prints `kept from the index: <key>.<field>`
rather than being resolved. `audio` is written even when it is empty, and a missing `audio.engine`
is warned about by name, because the TTS script refuses to write a manifest without it."""

import argparse
import copy
import json
import os
import sys

from lib import castindex
from lib import showconfig as sc

# The fields of an entry, in the order they are written, so the index reads the same way for every
# character and a hand edit lands where the eye expects it.
FIELD_ORDER = ("name", "kind", "speaks", "silent", "debut", "sheet", "identity",
               "baseline_prompt", "status", "locked", "face", "voice")
FACE_ORDER = ("ref", "gallery", "locked")
VOICE_ORDER = ("ref", "ref_text", "direction", "fx", "speed", "status", "note")


def plural(n, word, many=None):
    """"1 conflict" and "2 conflicts": the counts in this table are read cold."""
    return f"{n} {word if n == 1 else (many or word + 's')}"


def read_json(rel, root):
    """One source file, or None when it is not there. Absent is normal; unparseable is not."""
    path = rel if os.path.isabs(rel) else os.path.join(root, rel)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except ValueError as err:
            sys.exit(f"cast-index-build: {rel} is not valid JSON: {err}")


def rel_path(path):
    """A source path as it will be written: normalised, forward slashes, no leading "./"."""
    return os.path.normpath(path).replace(os.sep, "/")


def deslug(key):
    """A display name for a key no source gave a name to: "harbor" -> "Harbor", "the-warden" ->
    "the Warden". A fallback the merge table shows for review, not a naming authority."""
    words = [w for w in key.split("-") if w]
    if not words:
        return key
    if words[0] == "the" and len(words) > 1:
        return "the " + " ".join(w.capitalize() for w in words[1:])
    return " ".join(w.capitalize() for w in words)


def discover_sheets(casting_rel, root):
    """{base slug: (folder name, sheet path)} plus the folders that hold no matching sheet.

    One folder, one sheet: the first *.md whose own name slugs to the folder's slug, so "The
    Warden/the-warden.md" is a sheet and "The Warden/notes.md" is not. Folders beginning with "_"
    or "." are skipped -- an archive or a candidates directory is not a character."""
    sheets, sheetless, folders = {}, [], []
    casting_abs = casting_rel if os.path.isabs(casting_rel) else os.path.join(root, casting_rel)
    if not os.path.isdir(casting_abs):
        return sheets, sheetless, folders
    for name in sorted(os.listdir(casting_abs)):
        folder = os.path.join(casting_abs, name)
        if not os.path.isdir(folder) or name.startswith("_") or name.startswith("."):
            continue
        folders.append(name)
        want = castindex.slug_name(name)
        found = next((f for f in sorted(os.listdir(folder))
                      if f.endswith(".md") and castindex.slug_name(f[:-3]) == want), None)
        if found is None:
            sheetless.append(name)
            continue
        sheets[want] = (name, f"{casting_rel}/{name}/{found}")
    return sheets, sheetless, folders


def table(rows, headers):
    """A fixed-width table whose first column is the key, so a row is findable by it."""
    widths = [max(len(str(r[i])) for r in [headers, *rows]) for i in range(len(headers))]
    out = ["  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(headers)).rstrip()]
    for r in rows:
        out.append("  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(r)).rstrip())
    return out


def ordered(entry, order):
    out = {k: entry[k] for k in order if k in entry}
    for k, v in entry.items():
        if k not in out:
            out[k] = v
    return out


def main():
    # The engine never runs this; --show-root <path> is for the operator running it from anywhere.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ap = argparse.ArgumentParser(
        prog="cast-index-build.py",
        description="Build the cast index from the visual bible, the voice registry and the sheets.")
    ap.add_argument("--write", action="store_true",
                    help="write the index (without it the merge is printed and nothing is written)")
    args = ap.parse_args()

    bible_rel = rel_path(str(sc.value(cfg, "visual", "refs", default="Canon/refs.json")))
    voice_dir = str(sc.value(cfg, "audio", "voiceRefsDir", default="Production/voice-refs"))
    voices_rel = f"{rel_path(voice_dir)}/refs.json"
    casting_rel = rel_path(str(sc.value(cfg, "visual", "castingPileDir", default="Canon/characters")))
    index_rel = rel_path(castindex.index_path(cfg))

    bible = read_json(bible_rel, root)
    voices = read_json(voices_rel, root)
    existing = read_json(index_rel, root)
    sheets, sheetless, folders = discover_sheets(casting_rel, root)

    bible_entries = {k: v for k, v in (bible or {}).items()
                     if isinstance(v, dict) and not k.startswith("_")}
    voice_cast = {k: v for k, v in ((voices or {}).get("cast") or {}).items()
                  if isinstance(v, dict)}
    existing_cast = {k: v for k, v in ((existing or {}).get("cast") or {}).items()
                     if isinstance(v, dict)}

    print(f"read {bible_rel}: {len(bible_entries)} subjects"
          if bible is not None else f"read {bible_rel}: absent, skipped")
    if voices is None:
        print(f"read {voices_rel}: absent, skipped")
    else:
        print(f"read {voices_rel}: {len(voice_cast)} voices "
              f"(engine {voices.get('engine', '?')})")
    print(f"read {casting_rel}: {len(sheets)} sheets in {len(folders)} folders")
    if existing is not None:
        print(f"read {index_rel}: {len(existing_cast)} entries already filed")
    for name in sheetless:
        print(f"no sheet in {casting_rel}/{name} "
              f"(a sheet is the *.md whose name slugs to the folder's)")

    # The alternative key the engine accepts on read. A subject the bible filed as `the-<slug>`
    # keeps that key and the sheet folder `The <Name>` merges onto it; a subject the bible filed as
    # `<slug>` keeps that, and the same folder merges onto it. Either way one entry, not two.
    the_keys = {k for k in list(bible_entries) + list(existing_cast) if k.startswith("the-")}

    def key_for(text):
        base = castindex.slug_name(text)
        return f"the-{base}" if f"the-{base}" in the_keys else base

    merged, provenance, conflicts, kept = {}, {}, [], []
    voice_names, sheet_names = {}, {}

    def set_path(key, field, path, source):
        """Register a path-bearing field, or record the conflict and keep the first source's."""
        value = rel_path(path)
        held = provenance.get((key, field))
        if held is None:
            provenance[(key, field)] = (source, value)
            return value
        if held[1] != value:
            conflicts.append(f"CONFLICT {key} {field}: {held[0]} says {held[1]}; "
                             f"{source} says {value}")
        return held[1]

    # Source 1: the index a previous run wrote. First, so that every hand-written field survives
    # and a re-run that changes nothing writes the same file back.
    for key, entry in sorted(existing_cast.items()):
        out = merged.setdefault(key, {})
        out.update(copy.deepcopy(entry))
        if isinstance(out.get("sheet"), str) and out["sheet"]:
            out["sheet"] = set_path(key, "sheet", out["sheet"], index_rel)
        face = out.get("face")
        if isinstance(face, dict) and isinstance(face.get("ref"), str) and face["ref"]:
            face["ref"] = set_path(key, "face.ref", face["ref"], index_rel)
        voice = out.get("voice")
        if isinstance(voice, dict) and isinstance(voice.get("ref"), str) and voice["ref"]:
            voice["ref"] = set_path(key, "voice.ref", voice["ref"], index_rel)

    # Source 2: the visual bible -- the kind, the identity, the baseline prompt and the face.
    #
    # The first three are the INDEX's once the index holds them: the bible seeds them on the first
    # build and fills a gap on any later one, and it never overwrites. They are an author's fields
    # -- the casting stop writes an identity and a baseline prompt into the index for a character
    # it is designing (spec 2026-10-31 §2.2), and a hand corrects a kind the first build inferred
    # -- so a second build that took the registry's word for them would undo a casting, silently,
    # months after the registry stopped being the record. A disagreement is printed rather than
    # resolved, because the remedy differs by case (fix the bible, or let it go stale) and this
    # script does not get to choose. `face.ref` is not in this list: it is path-bearing, so a
    # disagreement there is a CONFLICT and nothing is written at all.
    for literal, entry in sorted(bible_entries.items()):
        key = key_for(literal)
        out = merged.setdefault(key, {})
        for field in ("kind", "identity", "baseline_prompt"):
            value = entry.get(field)
            if not (isinstance(value, str) and value):
                continue
            held = out.get(field)
            if isinstance(held, str) and held:
                if held != value:
                    kept.append(f"{key}.{field}")
                continue
            out[field] = value
        if isinstance(entry.get("ref"), str) and entry["ref"]:
            out.setdefault("face", {})["ref"] = set_path(key, "face.ref", entry["ref"], bible_rel)
        if isinstance(entry.get("locked"), str) and entry["locked"]:
            out.setdefault("face", {})["locked"] = entry["locked"]

    # Source 3: the voice registry -- the whole voice block, and the display name it is keyed by.
    for display, entry in sorted(voice_cast.items()):
        key = key_for(display)
        out = merged.setdefault(key, {})
        base = out["voice"] if isinstance(out.get("voice"), dict) else {}
        voice = {**base, **copy.deepcopy(entry)}
        if isinstance(voice.get("ref"), str) and voice["ref"]:
            voice["ref"] = set_path(key, "voice.ref", voice["ref"], voices_rel)
        out["voice"] = ordered(voice, VOICE_ORDER)
        out["speaks"] = True
        voice_names[key] = display

    # Source 4: the sheets.
    for base, (folder, path) in sorted(sheets.items()):
        key = key_for(base)
        out = merged.setdefault(key, {})
        out["sheet"] = set_path(key, "sheet", path, casting_rel)
        sheet_names[key] = folder

    if not merged:
        sys.exit(f"cast-index-build: nothing to merge — no subjects in {bible_rel}, no voices in "
                 f"{voices_rel}, no sheets under {casting_rel} (is --show-root right?)")

    # Finish each entry: a display name, a kind, speaks, a debut, and a normalised face.
    inferred, missing_face = [], []
    rows = []
    keys = sorted(merged)
    for done, key in enumerate(keys, start=1):
        out = merged[key]
        name = next((n for n in (out.get("name"), voice_names.get(key), sheet_names.get(key))
                     if isinstance(n, str) and n), deslug(key))
        out["name"] = name
        face = out.get("face") if isinstance(out.get("face"), dict) else None
        ref = face.get("ref") if face else None
        has_sheet = isinstance(out.get("sheet"), str) and bool(out["sheet"])
        if not (isinstance(out.get("kind"), str) and out["kind"]):
            # No bible entry said what this is. A voice with neither a face nor a sheet is a voice
            # (the narrator); anything else is a character until a hand says otherwise.
            out["kind"] = "voice" if (ref is None and not has_sheet) else "character"
            inferred.append(f"{key} → {out['kind']}")
        out["speaks"] = True if isinstance(out.get("voice"), dict) else bool(out.get("speaks"))
        if not (isinstance(out.get("debut"), str) and out["debut"]):
            out["debut"] = "s01e01"
        if face is not None:
            gallery = [rel_path(g) for g in face.get("gallery", []) if isinstance(g, str) and g]
            face["gallery"] = gallery
            out["face"] = ordered(face, FACE_ORDER)

        if ref is None:
            face_cell = "none"
        elif os.path.exists(ref if os.path.isabs(ref) else os.path.join(root, ref)):
            face_cell = "ok"
        else:
            face_cell = "missing"
            missing_face.append(f"{key} → {ref}")
        voice = out.get("voice", "absent")
        if isinstance(voice, dict):
            voice_cell = str(voice.get("status", "no status"))
        elif voice is None:
            voice_cell = "silent"
        else:
            voice_cell = "none"
        rows.append([key, name, out["kind"], "yes" if has_sheet else "no", face_cell,
                     voice_cell, out["debut"]])
        sc.progress(done, len(keys), "characters")

    print()
    for line in table(rows, ["key", "name", "kind", "sheet", "face", "voice", "debut"]):
        print(line)
    print()
    for line in conflicts:
        print(line)
    print(f"{plural(len(merged), 'entry', 'entries')}, "
          f"{plural(len(conflicts), 'conflict')}")
    for line in missing_face:
        print(f"reference image missing on disk (face.ref kept): {line}")
    for line in inferred:
        print(f"kind inferred, no visual-bible entry: {line}")
    for line in kept:
        print(f"kept from the index: {line}")

    # F11/F12: `audio` is the voice registry's top level, minus its `cast` map, over whatever the
    # index already held. Every key is carried and not three by name, because the registry is being
    # retired and a note it holds that the index does not would go with it (`notes_ear` is one on
    # the first instance). An absent `engine` is called out by name: the TTS prompt copies it into
    # the manifest's `engine` field and refuses to write a manifest without it, so this is the one
    # field whose absence stops a later step rather than merely reading thin.
    audio = {}
    if isinstance((existing or {}).get("audio"), dict):
        audio.update(copy.deepcopy(existing["audio"]))
    for field, value in sorted((voices or {}).items()):
        if field != "cast":
            audio[field] = copy.deepcopy(value)
    if not (isinstance(audio.get("engine"), str) and audio["engine"]):
        print("no audio.engine found — the TTS script will refuse until it is set")

    if conflicts:
        print(f"nothing written: two sources disagree about a path. Fix the source that is wrong "
              f"and re-run; {index_rel} is untouched.")
        sys.exit(2)
    if not args.write:
        print(f"dry run: nothing written — re-run with --write to write {index_rel}")
        return

    doc = {"version": 1, "audio": audio}
    # Sorted by key: the index is read and edited by hand, and a stable order keeps a re-run's
    # diff to the facts that changed.
    doc["cast"] = {key: ordered(merged[key], FIELD_ORDER) for key in keys}
    target = index_rel if os.path.isabs(index_rel) else os.path.join(root, index_rel)
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"WROTE {index_rel} — {len(keys)} entries")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"cast-index-build: {err}")
