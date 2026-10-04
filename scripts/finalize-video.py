# /// script
# dependencies = []
# ///
"""finalize-video: resolve an episode's air slot and copy its mastered MP4 to the NAS.

Production ids (ep01, ep98) are NOT air order. The slot is resolved in two steps, and the second
must survive because the first is hand-maintained:

1. The show's airMap (showrunner.json) is authoritative for every id it lists, including an id
   whose production number deliberately differs from its air slot.
2. An id the map does not list falls back to season_slot(), which scans the show's season
   documents for a RULED row whose DEFAULT production id (ep{air:02d}) equals the episode -- i.e.
   an episode that was never given an explicit override just airs where its own number says. An
   episode ruled into a season document before anyone edited airMap still finalizes.

If an id's default matches RULED rows in MORE THAN ONE season document, season_slot() refuses
(exits, nothing written) and names every candidate rather than guess -- add an airMap entry to
break the tie.

Only an episode with a resolved slot AND a mastered video is finalized; episode-mastered.mp4 is
preferred over the raw render when both are present. Copies (not links), so the final is a frozen
snapshot that survives a re-render of the source, and never to local disk -- a finished episode is
~900 MB, and the mount guard below refuses rather than filling the working drive.

Usage: finalize-video.py <episode> [--show-root <path>]
"""
import glob, os, re, shutil, sys

from lib import showconfig as sc

MASTERED_FILENAME = "episode-mastered.mp4"

# The season table's row grammar. The status cell may carry its OWN ruling history and still
# count as ruled -- "**RULED — REWRITTEN 2026-08-27**" is one, and pinning this to exactly
# "**RULED**" silently dropped an episode from every board with no error raised anywhere. The
# bold markers stay REQUIRED: losing them is real format drift and must parse to nothing.
# Not config: Plan F retires this parse entirely when ids carry their own season.
RULED_ROW = re.compile(r'^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^|]*\*\*\s*\|', re.M)


def ensure_mounted(mount: str, dest: str) -> None:
    # Guard: never write finals to local disk by accident if the NAS is offline.
    if not (os.path.ismount(mount) and os.path.isdir(dest)):
        sys.exit(f"finalize-video: NAS not mounted at {mount} (or {dest} missing). "
                 f"Connect to the media share, then re-run. Nothing written.")


def find_video(ep: str, video_filename: str, *, prod: str):
    """The file to finalize: the mastered MP4 when master-video.py has written one, else the
    raw render. Explicit rather than a glob's sort order, because which of the two ships is a
    decision (F-09), not an alphabetical accident.

    `prod` is the show's production directory (sc.production_dir), passed in rather than read
    here because this function takes no config and the caller already holds one."""
    mastered = f"{prod}/{ep}/video/{MASTERED_FILENAME}"
    if os.path.exists(mastered):
        return mastered
    raw = f"{prod}/{ep}/video/{video_filename}"
    return raw if os.path.exists(raw) else None


def _season_docs(canon_dir: str):
    """season-N.md paths as (N, path), sorted NUMERICALLY by N -- never by the glob's
    lexicographic path order, under which "season-10.md" would sort before "season-2.md"."""
    docs = []
    for path in glob.glob(os.path.join(canon_dir, "season-*.md")):
        m = re.search(r'season-(\d+)\.md$', os.path.basename(path))
        if m:
            docs.append((int(m.group(1)), path))
    return sorted(docs)


def season_slot(ep: str, canon_dir: str):
    """For an episode NOT in the show's airMap: find (season, air) by matching it against a
    RULED row's DEFAULT production id (ep{air:02d}) in any season document.

    Only that default naming is matched. An episode with an explicit airMap entry (one that airs
    at a row its own number does not name) is never matched here, by design: the map is always
    consulted first in finalize(), so this function is only reached for ids with no entry, and it
    must not invent one.

    A RULED row's default id is only guaranteed unique WITHIN one season document, not across
    several. This collects EVERY matching (season, air) and REFUSES outright if more than one
    distinct match turns up, naming every candidate -- a wrong name silently written to the NAS is
    a far worse failure than a human resolving a collision in seconds with an airMap entry.
    """
    candidates = []
    for season, path in _season_docs(canon_dir):
        try:
            text = open(path, encoding="utf-8").read()
        except OSError:
            continue
        for row in RULED_ROW.finditer(text):
            air = int(row.group(1))
            if f"ep{air:02d}" == ep:
                candidates.append((season, air))
    if not candidates:
        return None
    # Dedupe before counting: two RULED rows that name the SAME (season, air) are one slot, not
    # an ambiguity, so repeating a row inside a document is a formatting untidiness rather than a
    # refusal. Only genuinely DIFFERENT slots are a collision a human must resolve.
    distinct = sorted(set(candidates))
    if len(distinct) > 1:
        named = ", ".join(f"S{s:02d}E{a:02d} (season-{s}.md)" for s, a in distinct)
        sys.exit(f"finalize-video: {ep} matches RULED-row defaults in more than one "
                 f"season document ({named}). Add an airMap entry for {ep} to resolve the "
                 f"collision, then re-run. Nothing written.")
    return distinct[0]


def resolve_slot(cfg: dict, ep: str, canon_dir: str):
    """The airMap first, the season documents second. -> (season, episode) or None.

    The fallback is what lets an episode ruled into a season document but not yet registered in
    airMap still finalize; registering an air slot takes several hand edits and nothing
    cross-checks them.
    """
    try:
        return sc.season_of(cfg, ep)
    except sc.UnmappedEpisodeId:
        # ONLY a well-formed production id the map does not place reaches the season documents.
        # A malformed id, or a malformed airMap entry, is a fault and must reach the operator.
        return season_slot(ep, canon_dir)


def finalize(cfg: dict, ep: str, *, dest: str, canon_dir: str, video_filename: str) -> bool:
    prod = sc.production_dir(cfg)
    slot = resolve_slot(cfg, ep, canon_dir)
    if not slot:
        # Under the engine this script finalizes ONE episode, so "nothing resolved" is a failure
        # of that step, not a row skipped in a sweep. The old sweep printed SKIP and still ended
        # on FINALIZE_OK, which read as success to anything parsing the result line.
        sys.exit(f"finalize-video: {ep} has no air slot — it is not in airMap, and no RULED row "
                 f"in any season document under {canon_dir}/ defaults to it. Add an airMap entry "
                 f"for {ep}, then re-run. Nothing written.")
    src = find_video(ep, video_filename, prod=prod)
    if not src:
        sys.exit(f"finalize-video: no video to finalize for {ep} — expected "
                 f"{prod}/{ep}/video/{MASTERED_FILENAME} or "
                 f"{prod}/{ep}/video/{video_filename}. Nothing written.")
    season, episode = slot
    name = sc.format_filename(str(sc.value(cfg, "output", "finalFilename")),
                              slug=str(sc.value(cfg, "showSlug")),
                              season=season, episode=episode, episode_id=ep)
    dst = os.path.join(dest, name)
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        print(f"  up-to-date  {name}  (<- {src})")
        return True
    shutil.copy2(src, dst)
    mb = os.path.getsize(dst) / 1e6
    print(f"  finalized   {name}  ({mb:.0f} MB, <- {src})")
    return True


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    # One episode per invocation. The old 'all' mode swept the hand-curated map and never reached
    # the season-document fallback; the engine runs one episode per step, so explicit ids are the
    # whole interface.
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("finalize-video: episode id missing "
                 "(usage: finalize-video.py <episode> [--show-root <path>])")
    mount = sc.path(cfg, "output", "nasMount", root=root)
    dest = sc.path(cfg, "output", "nasRoot", root=root)
    canon_dir = str(sc.value(cfg, "canonDir"))
    video_filename = str(sc.value(cfg, "output", "videoFilename"))

    ensure_mounted(mount, dest)
    n = int(finalize(cfg, ep, dest=dest, canon_dir=canon_dir, video_filename=video_filename))
    # One unit, reported once the copy has actually happened. A 0-of-1 line before the work only
    # restates that the step started, which the engine already knows.
    sc.progress(1, 1, "episodes")
    print(f"FINALIZE_OK {n} episode(s) in {dest}/")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"finalize-video: {err}")
