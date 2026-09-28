# /// script
# dependencies = []
# ///
"""finalize-video: collect a mastered episode into Finalized/ under its air name.

Production IDs (ep01, ep98) are NOT air order — this maps them to season/episode
and copies the mastered MP4 to `Finalized/DeadLight SxxEyy.mp4`, the naming Ryan
uses before moving finals to his NFS. Copies (not links) so the final is a frozen
snapshot that survives a re-render of the source.

SEASON_MAP is the legacy, explicit fallback (still authoritative for the episodes
listed in it, including overrides like ep98 -> S1E9). An episode NOT in the map
is resolved via season_slot(): it scans every Canon/season-N.md for a RULED row
whose DEFAULT production id (ep{air:02d}) equals the episode — i.e. an episode
that was never given an explicit override just airs where its own number says.
A single episode id therefore only ever needs SEASON_MAP when its production id
diverges from its air slot; ordinary ids resolve straight from the season doc.
If an id's default matches RULED rows in MORE THAN ONE season doc, season_slot()
refuses (exits, nothing written) and names every candidate rather than guess —
add an explicit SEASON_MAP entry to break the tie.

Only an episode with a resolved slot AND a mastered video is finalized. 'all'
mode still iterates SEASON_MAP only (see season_slot()'s docstring for why
season-doc-only ids are not swept in automatically).

Usage:
  ARGUMENTS="ep02" uv run .archon/scripts/finalize-video.py     # one episode
  ARGUMENTS="all"  uv run .archon/scripts/finalize-video.py     # every mapped+ready episode
"""
import glob, os, re, shutil, sys

# production id -> (season, episode). Air order, NOT production order.
SEASON_MAP = {
    "ep01": (1, 1),
    "ep02": (1, 2),
    "ep03": (1, 3),
    "ep04": (1, 4),
    "ep05": (1, 5),
    "ep09": (1, 9),   # "The Wick" — Ryan-ruled 2026-07-28: the STORY is canon and keeps E9,
                      # but it re-enters production as ep09 once re-run through the modern
                      # process. Episodes/ep98/script.md is its DRAFT SOURCE only.
    "ep10": (1, 10),  # "The Working Day, Part Two" — the S1 finale.
    # ep98: NON-CANON test-bed production (Kokoro-era audio, zero Nano-Banana character
    #   shots, 3 pre-hard-line ambients). Ruled 2026-07-28; supplanted by ep09. Not mapped.
    # ep99: RETIRED 2026-07-20 (proof-of-concept, no air slot). See Episodes/_retired/ep99/.
}

# Finals live on Ryan's NAS, NOT local disk (a finished episode is ~900 MB and local
# space is tight). The repo's `Finalized` symlink points here too, for browsing.
# Override with DEADLIGHT_FINAL_DEST if the mount path changes.
MOUNT = os.environ.get("DEADLIGHT_FINAL_MOUNT", "/Volumes/media")
DEST  = os.environ.get("DEADLIGHT_FINAL_DEST", "/Volumes/media/DeadLight")

def ensure_mounted():
    # Guard: never write finals to local disk by accident if the NAS is offline.
    if not (os.path.ismount(MOUNT) and os.path.isdir(DEST)):
        sys.exit(f"finalize-video: NAS not mounted at {MOUNT} (or {DEST} missing). "
                 f"Connect to the media share, then re-run. Nothing written.")

def find_video(ep):
    hits = sorted(glob.glob(f"Production/{ep}/video/episode*.mp4"))
    return hits[0] if hits else None

def _season_docs():
    """Canon/season-N.md paths as (N, path), sorted NUMERICALLY by N -- never
    by the glob's lexicographic path order, under which "season-10.md" would
    sort before "season-2.md" as plain strings."""
    docs = []
    for path in glob.glob("Canon/season-*.md"):
        m = re.search(r'season-(\d+)\.md$', os.path.basename(path))
        if m:
            docs.append((int(m.group(1)), path))
    return sorted(docs)

def season_slot(ep):
    """For an episode NOT in SEASON_MAP: find (season, air) by matching it
    against a RULED row's DEFAULT production id (ep{air:02d}) in any
    Canon/season-N.md. Only that default naming is matched — an episode with
    an explicit SEASON_MAP override (e.g. ep98, which airs at row 9 but is
    NOT ep09) is never matched here, by design: SEASON_MAP.get(ep) is always
    checked first in finalize(), so this function is only reached for ids
    with no override, and it must not invent one.

    A RULED row's default id is only guaranteed unique WITHIN one season
    doc, not necessarily across multiple season docs. This collects EVERY
    matching (season, air) across every season doc and REFUSES outright
    (sys.exit, same as ensure_mounted()'s hard stop) if more than one
    distinct match turns up, naming every candidate -- a wrong name silently
    written to the NAS is a far worse failure than a human resolving a
    collision in seconds by adding an explicit SEASON_MAP entry.

    Not used by 'all' mode: 'all' stays scoped to SEASON_MAP's explicit,
    hand-curated list; only a single explicit invocation (ARGUMENTS="ep07")
    goes through this resolution path."""
    candidates = []
    for season, path in _season_docs():
        try:
            text = open(path).read()
        except OSError:
            continue
        for row in re.finditer(r'^\|\s*(\d+)\s*\|\s*\*\*RULED\*\*\s*\|', text, re.M):
            air = int(row.group(1))
            if f"ep{air:02d}" == ep:
                candidates.append((season, air))
    if not candidates:
        return None
    if len(candidates) > 1:
        named = ", ".join(f"S{s:02d}E{a:02d} (Canon/season-{s}.md)" for s, a in candidates)
        sys.exit(f"finalize-video: {ep} matches RULED-row defaults in more than one "
                 f"season doc ({named}). Add an explicit SEASON_MAP entry for {ep} to "
                 f"resolve the collision, then re-run. Nothing written.")
    return candidates[0]

def finalize(ep):
    slot = SEASON_MAP.get(ep) or season_slot(ep)
    if not slot:
        print(f"  SKIP {ep}: no air slot in SEASON_MAP or any Canon/season-N.md")
        return False
    src = find_video(ep)
    if not src:
        print(f"  SKIP {ep}: no mastered video under Production/{ep}/video/")
        return False
    s, e = slot
    name = f"DeadLight S{s:02d}E{e:02d}.mp4"
    dst = os.path.join(DEST, name)
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        print(f"  up-to-date  {name}  (<- {ep})")
        return True
    shutil.copy2(src, dst)
    mb = os.path.getsize(dst) / 1e6
    print(f"  finalized   {name}  ({mb:.0f} MB, <- {ep})")
    return True

def main():
    arg = os.environ.get("ARGUMENTS", "").split()
    which = arg[0] if arg else ""
    if not which:
        sys.exit("finalize-video: ARGUMENTS needs an episode id or 'all'")
    ensure_mounted()
    eps = sorted(SEASON_MAP) if which == "all" else [which]
    n = sum(finalize(ep) for ep in eps)
    print(f"FINALIZE_OK {n} episode(s) in {DEST}/")

if __name__ == "__main__":
    main()
