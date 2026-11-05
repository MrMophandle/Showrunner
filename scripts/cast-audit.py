# /// script
# dependencies = []
# ///
"""cast-audit: report what the cast index holds and what the retired repository still knows.

Spec 2026-10-31 §4.2. A reader, start to finish: it writes NOTHING, anywhere, ever.

READS:
  <cast.index>        the cast index (Canon/cast.json by default) and, for each entry, whether the
                      files it names are on disk
  <retired>/Production/ep*/guest-refs/*.wav     with --retired: the retired repository's guest takes
  <retired>/Production/ep*/tts-script.json      with --retired: the manifests that cast them
                      ep98 and ep99 are skipped: they are the engine's exercise fixtures and not
                      episodes of the show, and the skip is printed in one line

--retired IS READ-ONLY. The path is opened only for reading, no directory is created under it, no
temporary file is written into it, and nothing in it is renamed, touched or removed. That is a
binding constraint, not an intention: the retired repository is the show's first ten episodes and
the only copy of some of these takes. tests/test_cast_migration.py asserts it by snapshotting every
path under the fixture's retired tree with its size and mtime and comparing the snapshot afterwards.

Prints one row per index entry -- key, name, kind, face (ok | missing | none), voice (locked |
not-locked | silent | none), gallery count, sheet (ok | missing | none) -- then the gaps, then,
with --retired, every guest the retired repository cast who has no entry in the index, with the
episode (its retired id and its new one), the WAV and the reference line that was recorded for it.
That list is what a later hand promotes from: this script does not promote anything.

A retired WAV counts as CAST when some manifest cast entry's `ref` names that file -- the ref is
the path synthesis read, so it is a record and not an inference. The slug of the display name is
only the fallback, for a cast entry that recorded no `ref`: a name carrying a title ("Dock Hand
Pim", takes `pim-1.wav`) slugs to nothing any of its own takes are called.

Exit 0 whatever the gaps are. A gap is a fact to act on, not a failure of the audit.

Usage:
  cast-audit.py [--retired <path>] [--show-root <path>]"""

import argparse
import glob
import json
import os
import re
import sys

from lib import castindex
from lib import showconfig as sc

# A retired episode directory is epNN and the retired repository is season one, so epNN is s01eNN.
RETIRED_EPISODE = re.compile(r"^ep(\d{2})$")
# ep98 and ep99 are the engine's exercise fixtures and not episodes of the show: their guest-refs
# hold takes nobody cast and their manifests cast names nobody wrote. Scanning them would put
# invented characters on a promotion list a hand reads, so they are skipped and the skip is printed.
EXERCISE_EPISODES = ("ep98", "ep99")
# A take is <slug>-<n>.wav, sometimes with an -FX suffix on the end.
TAKE_SUFFIX = re.compile(r"(?:-fx)?(?:-\d+)?$", re.IGNORECASE)


def plural(n, word, many=None):
    """"1 voice locked" and "2 voices locked": these lines are read cold and counted by eye."""
    return f"{n} {word if n == 1 else (many or word + 's')}"


def table(rows, headers):
    widths = [max(len(str(r[i])) for r in [headers, *rows]) for i in range(len(headers))]
    out = ["  ".join(str(c).ljust(widths[i]) for i, c in enumerate(headers)).rstrip()]
    for r in rows:
        out.append("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)).rstrip())
    return out


def exists(root, rel):
    return os.path.exists(rel if os.path.isabs(rel) else os.path.join(root, rel))


def take_slug(filename):
    """The subject a take belongs to: "pim-1.wav" and "pim-2-FX.wav" are both "pim"."""
    stem = os.path.splitext(filename)[0]
    for _ in range(2):                       # -FX then -<n>, in either order
        stem = TAKE_SUFFIX.sub("", stem, count=1)
    return castindex.slug_name(stem)


def new_id(episode_dir):
    """The retired repository's epNN as the new scheme's s01eNN, so the two ids are both in print
    and a reader does not have to do the arithmetic on a season boundary."""
    match = RETIRED_EPISODE.match(episode_dir)
    return f"s01e{match.group(1)}" if match else episode_dir


def norm_rel(path):
    """One path as it is compared: forward slashes, normalised, no leading "./". A manifest writes
    show-relative posix paths by hand and this script builds them with os.path.relpath, so the two
    are made to agree here rather than at four call sites."""
    return os.path.normpath(str(path).replace("\\", "/")).replace(os.sep, "/")


def read_json(path):
    """A retired file, read-only. A manifest that does not parse is reported, not fixed."""
    with open(path, encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except ValueError as err:
            print(f"unreadable manifest {path}: {err}")
            return None


def audit_retired(retired, index, index_rel):
    """Everything the retired repository knows that the index does not. Writes nothing."""
    print()
    print(f"retired repository (read-only; nothing here is written): {retired}")
    skipped = []
    takes = {}                               # (episode dir, slug) -> [relative wav paths]
    for wav in sorted(glob.glob(os.path.join(retired, "Production", "ep*", "guest-refs", "*.wav"))):
        episode = os.path.basename(os.path.dirname(os.path.dirname(wav)))
        if episode in EXERCISE_EPISODES:
            continue
        rel = norm_rel(os.path.relpath(wav, retired))
        takes.setdefault((episode, take_slug(os.path.basename(wav))), []).append(rel)

    manifests = []
    for manifest in sorted(glob.glob(os.path.join(retired, "Production", "ep*", "tts-script.json"))):
        if os.path.basename(os.path.dirname(manifest)) in EXERCISE_EPISODES:
            skipped.append(os.path.basename(os.path.dirname(manifest)))
            continue
        manifests.append(manifest)
    for ep in EXERCISE_EPISODES:                 # a fixture with takes and no manifest counts too
        if ep not in skipped and os.path.isdir(os.path.join(retired, "Production", ep)):
            skipped.append(ep)
    if skipped:
        print(f"skipped {', '.join(sorted(set(skipped)))} "
              f"(the engine's exercise fixtures, not episodes)")

    # Which takes a manifest cast, and how the question is answered. The `ref` is the path
    # synthesis actually read, so a file it names IS the cast take whatever it is called; the slug
    # of the display name is a guess from a filename and breaks on any name the takes are not
    # literally spelled after -- "Dock Hand Pim" slugs to `dock-hand-pim` and her takes are
    # `pim-1.wav`, so the slug rule called the very file the manifest cast her from an uncast
    # candidate. The slug therefore stays only as the fallback, for a cast entry that recorded no
    # `ref` at all, where there is nothing better to compare.
    guests, cast_refs, slug_cast = [], set(), set()
    for manifest in manifests:
        episode = os.path.basename(os.path.dirname(manifest))
        doc = read_json(manifest)
        cast = (doc or {}).get("cast")
        if not isinstance(cast, dict):
            continue
        for display, entry in cast.items():
            if not isinstance(entry, dict):
                continue
            ref = entry.get("ref")
            if isinstance(ref, str) and ref:
                cast_refs.add(norm_rel(ref))
            else:
                slug_cast.add((episode, castindex.slug_name(display)))
            if entry.get("guest") is True:
                guests.append((episode, display, entry))
    print(f"scanned {plural(len(manifests), 'episode manifest')}: "
          f"{plural(sum(len(v) for v in takes.values()), 'guest WAV')}, "
          f"{plural(len(guests), 'guest cast entry', 'guest cast entries')}")

    rows = []
    for episode, display, entry in sorted(guests, key=lambda g: (g[0], g[1].lower())):
        if castindex.key_of(index, display) is not None:
            continue                         # already filed centrally: not a gap
        slug = castindex.slug_name(display)
        found = takes.get((episode, slug), [])
        ref = norm_rel(entry["ref"]) if isinstance(entry.get("ref"), str) and entry["ref"] else ""
        wav = ref if ref else (found[0] if found else "(no ref recorded)")
        if ref and not os.path.exists(os.path.join(retired, ref)):
            wav = f"{ref} (not on disk)"
        others = [f for f in found if f != ref]
        if others:
            wav = f"{wav} (+{len(others)} other {'take' if len(others) == 1 else 'takes'})"
        rows.append([display, f"{episode} → {new_id(episode)}", wav,
                     f'"{entry.get("ref_text", "")}"', str(entry.get("direction", ""))])
    print()
    if rows:
        print(f"guests in the retired repository with no entry in {index_rel}:")
        for line in table(rows, ["name", "episode", "wav", "ref_text", "direction"])[1:]:
            print(f"  {line}")
    else:
        print(f"no guest in the retired repository is missing from {index_rel}")

    orphans = []
    for (episode, slug), files in sorted(takes.items()):
        loose = [rel for rel in files if rel not in cast_refs]
        if not loose:
            continue                         # every take here is named by a manifest's ref
        if (episode, slug) in slug_cast:
            continue                         # the fallback: a cast entry with no ref, by slug
        if castindex.key_of(index, slug) is not None:
            continue                         # already filed centrally: not a gap
        orphans.append((episode, slug, loose))
    print()
    if orphans:
        print("guest WAVs no retired manifest casts (candidate takes, nothing to promote yet):")
        for episode, _slug, files in orphans:
            for rel in files:
                print(f"  {episode} → {new_id(episode)}  {rel}")
    else:
        print("every guest WAV in the retired repository is named by a manifest")


def main():
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ap = argparse.ArgumentParser(
        prog="cast-audit.py",
        description="Report the cast index's faces, voices, galleries and sheets, and the guests "
                    "a retired repository still holds. Reads only; writes nothing.")
    ap.add_argument("--retired", metavar="PATH",
                    help="a retired show repository to scan for guests (READ-ONLY)")
    args = ap.parse_args()

    index_rel = castindex.index_path(cfg)
    index = castindex.load(cfg, root)
    cast = index["cast"]
    print(f"{index_rel}: {len(cast)} entries")

    rows, gallery_gaps = [], []
    faces = {"ok": 0, "missing": 0, "none": 0}
    voices = {"locked": 0, "not-locked": 0, "silent": 0, "none": 0}
    sheets = 0
    keys = list(cast)
    for done, key in enumerate(keys, start=1):
        entry = cast[key] if isinstance(cast[key], dict) else {}
        face = entry.get("face") if isinstance(entry.get("face"), dict) else {}
        ref = face.get("ref")
        if not isinstance(ref, str) or not ref:
            face_state = "none"
        elif exists(root, ref):
            face_state = "ok"
        else:
            face_state = "missing"
        faces[face_state] += 1

        voice = entry.get("voice", "absent")
        if isinstance(voice, dict):
            status = voice.get("status")
            voice_state = "locked" if isinstance(status, str) and "LOCKED" in status \
                else "not-locked"
        elif voice is None:
            voice_state = "silent"
        else:
            voice_state = "none"
        voices[voice_state] += 1

        gallery = [g for g in face.get("gallery", []) if isinstance(g, str) and g]
        present = [g for g in gallery if exists(root, g)]
        for g in gallery:
            if g not in present:
                gallery_gaps.append(f"{key} → {g}")

        sheet = entry.get("sheet")
        if not isinstance(sheet, str) or not sheet:
            sheet_state = "none"
        elif exists(root, sheet):
            sheet_state = "ok"
            sheets += 1
        else:
            sheet_state = "missing"

        rows.append([key, str(entry.get("name", key)), str(entry.get("kind", "?")),
                     f"face {face_state}", f"voice {voice_state}", f"gallery {len(present)}",
                     f"sheet {sheet_state}"])
        sc.progress(done, len(keys), "characters")

    print()
    if rows:
        for line in table(rows, ["key", "name", "kind", "face", "voice", "gallery", "sheet"])[1:]:
            print(line)
        print()
    print(f"{plural(len(cast), 'entry', 'entries')}: "
          f"{plural(faces['ok'], 'face')} on disk, {faces['missing']} missing, "
          f"{faces['none']} with no face; "
          f"{plural(voices['locked'], 'voice')} locked, {voices['not-locked']} not locked, "
          f"{voices['silent']} silent, {voices['none']} with no voice; "
          f"{plural(sheets, 'sheet')}")
    for line in gallery_gaps:
        print(f"gallery image listed in {index_rel} and not on disk: {line}")

    if args.retired:
        retired = os.path.abspath(os.path.expanduser(args.retired))
        if not os.path.isdir(retired):
            sys.exit(f"cast-audit: --retired {args.retired} is not a directory")
        audit_retired(retired, index, index_rel)


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"cast-audit: {err}")
