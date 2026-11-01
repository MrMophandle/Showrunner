# /// script
# dependencies = []
# ///
"""cast-prune: bring every character folder to the shape the spec names, by MOVING the excess.

Spec 2026-10-31 §1.2b and §4.4. A character folder holds the sheet, one reference image and at most
three gallery images. Nothing else belongs there, and nothing is deleted here: the excess is moved
to <productionDir>/_archive/characters/<Name>/, where a hand deletes it later if it wants to.

READS:
  <cast.index>                              the cast index, for each entry's face.ref and gallery
  <visual.castingPileDir>/<Name>/           every image in the folder that holds that face

WRITES, and only with --apply:
  <productionDir>/_archive/characters/<Name>/<file>   every moved image (directories created, a
                                                      name collision suffixed -2, then -3)
  <cast.index>                              only the `face.gallery` lists it had to trim

What stays, per entry: the file its `face.ref` names; the first three of its `gallery` entries that
are on disk, in the order the index lists them, or exactly the files named by --keep for that key.
What moves: every other image file in the folder, found recursively. The sheet markdown and any
non-image file stay and are reported. A folder with no index entry is listed and left alone --
nothing is pruned on the strength of a filename. A folder whose face.ref is not on disk is left
alone too: a lost reference is a thing to restore from git, not a reason to empty the folder.

An index gallery trimmed to three is rewritten in the index as part of the same --apply, because
the cap is the index's (it is what scripts/lib/castindex.py's faces() enforces on read) and an
index naming an archived file would send a generator looking for a file that is no longer there.

Usage:
  cast-prune.py [--apply] [--keep <key>=<file>,<file>…] [--show-root <path>]

--keep names the gallery that survives for one key, as paths inside that character's folder
("--keep vale=gallery/02.png,portrait.png"); at most three, each of which must be a file in the
folder. Repeat the flag for more keys. Without it the index's own gallery decides."""

import argparse
import json
import os
import shutil
import sys

from lib import castindex
from lib import showconfig as sc

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".heic", ".avif"}


def rel_path(path):
    return os.path.normpath(path).replace(os.sep, "/")


def folder_files(folder_abs):
    """Every file in a character folder, as folder-relative posix paths. Hidden files skipped."""
    out = []
    for here, dirs, names in os.walk(folder_abs):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            out.append(rel_path(os.path.relpath(os.path.join(here, name), folder_abs)))
    return sorted(out)


def free_name(directory, basename, taken):
    """A destination that collides with nothing: <stem>.ext, then <stem>-2.ext, <stem>-3.ext…

    `taken` carries the destinations this run has already planned, so two images with the same
    basename in different subdirectories do not plan themselves onto one path."""
    stem, ext = os.path.splitext(basename)
    candidate, n = basename, 1
    while os.path.exists(os.path.join(directory, candidate)) or \
            f"{directory}/{candidate}" in taken:
        n += 1
        candidate = f"{stem}-{n}{ext}"
    taken.add(f"{directory}/{candidate}")
    return candidate


def parse_keep(values):
    """--keep key=a.png,b.png → {key: [a.png, b.png]}. Refuses a spelling it cannot read."""
    keeps = {}
    for raw in values or []:
        if "=" not in raw:
            sys.exit(f"cast-prune: --keep {raw!r} is not <key>=<file>,<file>…")
        key, listed = raw.split("=", 1)
        files = [f.strip() for f in listed.split(",") if f.strip()]
        if not key.strip() or not files:
            sys.exit(f"cast-prune: --keep {raw!r} is not <key>=<file>,<file>…")
        keeps.setdefault(key.strip(), []).extend(files)
    return keeps


def main():
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ap = argparse.ArgumentParser(
        prog="cast-prune.py",
        description="Move every image a character folder should not hold into the production "
                    "archive, leaving the sheet, the reference and at most three gallery images.")
    ap.add_argument("--apply", action="store_true",
                    help="move the files (without it the plan is printed and nothing is moved)")
    ap.add_argument("--keep", action="append", metavar="KEY=FILE,FILE",
                    help="the gallery that survives for one key, as paths inside its folder "
                         "(at most three); repeatable")
    args = ap.parse_args()

    casting_rel = rel_path(str(sc.value(cfg, "visual", "castingPileDir",
                                        default="Canon/characters")))
    archive_rel = f"{sc.production_dir(cfg)}/_archive/characters"
    index_rel = castindex.index_path(cfg)
    index = castindex.load(cfg, root)
    cast = index["cast"]
    keeps = parse_keep(args.keep)

    # One plan per character folder that holds an index entry's face. The folder comes from the
    # face.ref's own path, not from the entry's display name, because the folder on disk is the
    # thing being pruned and its name may not spell the name the index shows.
    plans, outside, lost = [], [], []
    for key, entry in cast.items():
        if not isinstance(entry, dict):
            continue
        face = entry.get("face") if isinstance(entry.get("face"), dict) else {}
        ref = face.get("ref")
        if not isinstance(ref, str) or not ref:
            continue
        ref = rel_path(ref)
        prefix = casting_rel + "/"
        if os.path.isabs(ref) or not ref.startswith(prefix):
            outside.append(f"{key} → {ref}")
            continue
        inside = ref[len(prefix):]
        if "/" not in inside:
            outside.append(f"{key} → {ref}")
            continue
        folder_name = inside.split("/")[0]
        folder_rel = f"{casting_rel}/{folder_name}"
        folder_abs = os.path.join(root, folder_rel)
        if not os.path.isdir(folder_abs):
            lost.append(f"{key} → {folder_rel} (folder not on disk)")
            continue
        if not os.path.exists(os.path.join(root, ref)):
            lost.append(f"{key} → {ref} (face.ref not on disk; folder left alone)")
            continue
        plans.append({"key": key, "name": str(entry.get("name", key)), "folder": folder_name,
                      "folder_rel": folder_rel, "folder_abs": folder_abs,
                      "ref_in_folder": ref[len(folder_rel) + 1:], "entry": entry,
                      "gallery": [rel_path(g) for g in face.get("gallery", [])
                                  if isinstance(g, str) and g]})

    by_key = {plan["key"]: plan for plan in plans}
    for key in keeps:
        if key not in by_key:
            sys.exit(f"cast-prune: --keep {key}=… names no index entry with a face under "
                     f"{casting_rel} (known: {', '.join(sorted(by_key)) or 'none'})")
        if len(keeps[key]) > 3:
            sys.exit(f"cast-prune: --keep {key}=… names {len(keeps[key])} files; a gallery holds "
                     f"at most three ({index_rel} caps it, spec 2026-10-31 §1.2b)")

    print(f"{index_rel}: {len(cast)} entries; {len(plans)} character "
          f"{'folder' if len(plans) == 1 else 'folders'} to prune under {casting_rel}")
    for line in outside:
        print(f"face outside {casting_rel} (not this script's business): {line}")
    for line in lost:
        print(f"left alone: {line}")

    kept_total, moves, rewrites = 0, [], []
    taken = set()
    for done, plan in enumerate(plans, start=1):
        files = folder_files(plan["folder_abs"])
        images = [f for f in files if os.path.splitext(f)[1].lower() in IMAGE_EXTS]
        others = [f for f in files if f not in images and not f.lower().endswith(".md")]
        dest_dir = f"{archive_rel}/{plan['folder']}"

        keep_rows = [(plan["ref_in_folder"], "face.ref")]
        if plan["key"] in keeps:
            resolved = []
            for named in keeps[plan["key"]]:
                want = rel_path(named)
                if want in files:
                    resolved.append(want)
                    continue
                matches = [f for f in files if os.path.basename(f) == os.path.basename(want)]
                if len(matches) == 1:
                    resolved.append(matches[0])
                    continue
                sys.exit(f"cast-prune: --keep {plan['key']}={named!r} is not a file in "
                         f"{plan['folder_rel']}"
                         + (f" ({len(matches)} files share that name)" if matches else ""))
            gallery_new = [f"{plan['folder_rel']}/{f}" for f in resolved
                           if f != plan["ref_in_folder"]]
            for at, f in enumerate(resolved, start=1):
                if f != plan["ref_in_folder"]:
                    keep_rows.append((f, f"--keep {at}"))
        else:
            present = [g for g in plan["gallery"]
                       if os.path.exists(g if os.path.isabs(g) else os.path.join(root, g))]
            gallery_new = present[:3]
            for at, g in enumerate(gallery_new, start=1):
                prefix = plan["folder_rel"] + "/"
                keep_rows.append((g[len(prefix):] if g.startswith(prefix) else g, f"gallery {at}"))
            for g in plan["gallery"]:
                if g not in present:
                    print(f"gallery image listed in {index_rel} and not on disk, dropped from "
                          f"the entry: {plan['key']} → {g}")
                elif g not in gallery_new and not g.startswith(plan["folder_rel"] + "/"):
                    print(f"gallery image over the cap of three and outside the folder, dropped "
                          f"from the entry: {plan['key']} → {g}")

        keep_set = {f for f, _why in keep_rows}
        plan_moves = [f for f in images if f not in keep_set]
        kept_total += len(keep_set)

        # One aligned block per folder: verb, the file as the folder holds it, and why.
        rows = [("keep", f, why) for f, why in keep_rows]
        for f in plan_moves:
            target = free_name(os.path.join(root, dest_dir), os.path.basename(f), taken)
            rows.append(("move", f, f"→ {dest_dir}/{target}"))
            moves.append((os.path.join(plan["folder_abs"], f),
                          os.path.join(root, dest_dir, target),
                          f"{plan['folder_rel']}/{f} → {dest_dir}/{target}"))
        rows += [("stay", f, "not an image, left where it is") for f in others]
        width = max(len(f) for _verb, f, _why in rows)
        print()
        print(f"{plan['name']} (key {plan['key']}) — {plan['folder_rel']}")
        for verb, f, why in rows:
            print(f"  {verb}  {f.ljust(width)}  {why}")
        if plan["gallery"] != gallery_new:
            rewrites.append((plan, gallery_new))
        sc.progress(done, len(plans), "characters")

    folders_seen = {plan["folder_rel"] for plan in plans}
    casting_abs = os.path.join(root, casting_rel)
    unknown = []
    if os.path.isdir(casting_abs):
        for name in sorted(os.listdir(casting_abs)):
            folder_rel = f"{casting_rel}/{name}"
            if not os.path.isdir(os.path.join(casting_abs, name)) or folder_rel in folders_seen:
                continue
            if name.startswith(".") or name.startswith("_"):
                continue
            images = [f for f in folder_files(os.path.join(casting_abs, name))
                      if os.path.splitext(f)[1].lower() in IMAGE_EXTS]
            unknown.append(f"{folder_rel} — {len(images)} "
                           f"{'image' if len(images) == 1 else 'images'}")
    print()
    if unknown:
        print(f"folders with no entry in {index_rel} (left alone):")
        for line in unknown:
            print(f"  {line}")
        print()

    print(f"plan: {kept_total} images kept, {len(moves)} to move, {len(rewrites)} index "
          f"{'gallery' if len(rewrites) == 1 else 'galleries'} to rewrite")
    if not args.apply:
        print(f"dry run: nothing moved, {index_rel} untouched — re-run with --apply")
        return
    if not moves and not rewrites:
        print("nothing to move: every character folder already holds the sheet, one reference "
              "and at most three gallery images")
        return

    for source, target, shown in moves:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(source, target)
        print(f"MOVED {shown}")        # source → destination, the record of the move
    print(f"MOVED {len(moves)} images out of {casting_rel} into {archive_rel} "
          f"(nothing deleted; delete them by hand when you are ready)")
    if rewrites:
        target = index_rel if os.path.isabs(index_rel) else os.path.join(root, index_rel)
        with open(target, encoding="utf-8") as fh:
            doc = json.load(fh)
        for plan, gallery_new in rewrites:
            doc["cast"][plan["key"]].setdefault("face", {})["gallery"] = gallery_new
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"WROTE {index_rel} — {len(rewrites)} "
              f"{'gallery' if len(rewrites) == 1 else 'galleries'} rewritten")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"cast-prune: {err}")
