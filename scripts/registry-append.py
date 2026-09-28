# /// script
# dependencies = []
# ///
"""registry-append: copy an episode's APPROVED character shots into each
character's canon pile (Canon/characters/<Name>/<ep>-<shot-id>.png) — the
casting registry grows itself; the generator conditions on the newest stills.

Run AFTER the image gate (only approved shots on disk). Idempotent.
Usage: ARGUMENTS=ep04 uv run .archon/scripts/registry-append.py"""
import json, os, re, shutil, sys

CHARACTER_KINDS = {"human", "creature", "ship"}


def normalize_key(ref: str) -> str:
    return re.split(r"[\s(]", ref.strip(), 1)[0].lower()


def normalize_folder_name(name: str) -> str:
    """Normalize a folder name for matching against keys: case-insensitive,
    strip hyphens, underscores, spaces, and apostrophes."""
    return re.sub(r"[-_\s']", "", name.lower())


def find_matching_folder(key: str, characters_root: str) -> tuple:
    """Find existing folders in characters_root that match the normalized key.
    Returns (folder_path, count) where count is 0 (no match), 1 (exact match),
    or >1 (multiple matches / fragmented state)."""
    if not os.path.isdir(characters_root):
        return None, 0

    normalized_key = normalize_folder_name(key)
    matches = []
    for entry in os.listdir(characters_root):
        folder_path = os.path.join(characters_root, entry)
        if os.path.isdir(folder_path):
            if normalize_folder_name(entry) == normalized_key:
                matches.append(folder_path)

    if len(matches) == 1:
        return matches[0], 1
    elif len(matches) > 1:
        return matches, len(matches)
    else:
        return None, 0


def append(ep, prompts_path, bible, characters_root="Canon/characters"):
    doc = json.load(open(prompts_path))
    ep_dir = os.path.dirname(prompts_path)
    copied = []
    for s in doc["shots"]:
        if s.get("type") != "character":
            continue
        src = os.path.join(ep_dir, f"{s['id']}.png")
        if not os.path.exists(src):
            continue
        for raw in s.get("refs", []):
            key = normalize_key(raw)
            entry = bible.get(key)
            if entry:
                if entry.get("kind") not in CHARACTER_KINDS:
                    continue                          # props/locations/other non-cast kinds
                folder = os.path.dirname(entry["ref"])
            else:
                # Try to find an existing folder matching this key
                existing, count = find_matching_folder(key, characters_root)
                if count == 1:
                    folder = existing
                    print(f"  NOTE: '{key}' matched existing folder {os.path.basename(folder)}")
                elif count > 1:
                    # Multiple matches: fragmented state, skip to avoid deepening split
                    folder_names = [os.path.basename(p) for p in existing]
                    print(f"  WARNING: '{key}' matches multiple folders {folder_names} "
                          f"— skipped to avoid deepening fragmentation; resolve manually")
                    continue
                else:
                    # No match: create new folder
                    folder = os.path.join(characters_root, key.title())
                    print(f"  WARNING: '{key}' has no refs.json entry — created "
                          f"{folder}; add a proper sheet + entry when casting is final")
            os.makedirs(folder, exist_ok=True)
            dst = os.path.join(folder, f"{ep}-{s['id']}.png")
            if os.path.exists(dst):
                with open(src, "rb") as fa, open(dst, "rb") as fb:
                    if fa.read() == fb.read():
                        continue                      # identical: already filed
                # Different bytes under the same ep-shot name means the shot
                # was re-rolled (--only) and re-approved after the pile copy
                # was made. Keeping the old bytes would silently condition
                # every future generation on a REJECTED frame — never do
                # that; replace it and say so.
                print(f"  UPDATED: {dst} replaced — shot '{s['id']}' was "
                      f"re-rolled and the pile held a stale/rejected version")
            shutil.copy2(src, dst)
            copied.append(dst)
    return copied


def main():
    # argv WINS over $ARGUMENTS — identical precedence to nano-banana-generate's
    # main() (commit 9f29802). ARGUMENTS stays exported in a shell across
    # invocations, so a human passing argv (e.g. `registry-append.py ep05`)
    # must not have it silently overridden by a stale ARGUMENTS=ep04.
    argv = sys.argv[1:]
    args = argv if argv else os.environ.get("ARGUMENTS", "").split()
    if not args:
        sys.exit("usage: registry-append <ep>")
    ep = args[0]
    bible = {k: v for k, v in
             json.load(open("Canon/refs.json")).items() if not k.startswith("_")}
    copied = append(ep, f"Production/{ep}/images/prompts.json", bible)
    for p in copied:
        print(f"  + {p}")
    print(f"REGISTRY_OK {len(copied)} still(s) appended")


if __name__ == "__main__":
    main()
