# /// script
# dependencies = []
# ///
"""season-status: the Season Desk's deterministic board.

Derives every fact mechanically — the ruled episode list from the show's season document,
the air->production mapping from the show's airMap, per-episode progress from each episode's
STATUS.md and rendered stills, finals from the NAS. No model involvement: facts must be
unhallucinatable. Read-only; prints markdown + a SEASON_STATUS_OK / SEASON_STATUS_PARTIAL
trailer (exit 0 either way).

The air map used to be regex-parsed out of finalize-video.py's source, so the board and the
finalizer could disagree about which rows existed (inventory F-14). Both now read the one
airMap key in showrunner.json.

Usage: season-status.py [sN] [--json] [--show-root <path>]
       sN selects the season (default s1 -> <canonDir>/season-1.md); a season
       exists iff that file exists."""
import json, os, re, sys

from lib import showconfig as sc

MILESTONES = ["beats", "outline", "script", "canon", "casting", "audio",
              "images", "assembled", "finalized"]


def parse_season_table(text):
    """Rows like `| 5 | **RULED** | **"A Title"** — ...` -> [{'air':5,'title':'A Title'}].
    The pilot row has no quoted title -> '(pilot)'.

    The status cell may carry its OWN ruling history and still count as ruled
    — `**RULED — REWRITTEN 2026-08-27**` is E10's, and pinning this to exactly
    `**RULED**` silently dropped the finale from every board (console season
    strip, season-desk board table, --json) with no error raised anywhere. The
    bold markers stay REQUIRED: losing them is real format drift and must
    still parse to nothing, which `board()` reports as a problem rather than
    an empty-but-OK board."""
    rows = []
    for m in re.finditer(r'^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^|]*\*\*\s*\|(.*)$', text, re.M):
        air, rest = int(m.group(1)), m.group(2)
        t = re.search(r'\*\*"([^"]+)"\*\*', rest)
        rows.append({"air": air,
                     "title": t.group(1) if t else ("(pilot)" if air == 1 else "(untitled)")})
    return rows


def air_map_for_season(cfg, season=1):
    """The show's airMap, inverted for one season: {air slot: production id}.

    Reads the one airMap key every script shares, rather than regex-parsing another script's
    source for a dict literal (inventory F-14). A malformed entry is skipped rather than fatal:
    this board is read-only and reports problems instead of refusing to draw.
    """
    out = {}
    entries = cfg.get("airMap")
    if not isinstance(entries, dict):
        return out
    for prod, slot in entries.items():
        if isinstance(slot, (list, tuple)) and len(slot) == 2:
            try:
                s, ep = int(slot[0]), int(slot[1])
            except (TypeError, ValueError):
                continue
            if s == season:
                out[ep] = prod
    return out


def prod_id_for(air, air_map):
    return air_map.get(air, f"ep{air:02d}")


def episode_milestones(status_text):
    return set(re.findall(r'^- \d{4}-\d{2}-\d{2} (\w+):', status_text, re.M))


def _image_counts(root, prod, production_dir="Production"):
    p = os.path.join(root, production_dir, prod, "images", "prompts.json")
    if not os.path.exists(p):
        return None
    try:
        data = json.load(open(p))
        shots = data.get("shots", [])
        have = 0
        bad = False
        for s in shots:
            if not isinstance(s, dict) or "id" not in s:
                bad = True
                continue
            if os.path.exists(os.path.join(root, production_dir, prod, "images",
                                           f"{s['id']}.png")):
                have += 1
        if bad:
            return "bad"
        return (have, len(shots))
    except (json.JSONDecodeError, OSError, KeyError, TypeError):
        return "bad"


# Files that constitute evidence an episode has actually been DRAFTED. The
# directory's mere existence is not: the season desk writes
# Episodes/<ep>/launch-premise.md as its final act, a full write-episode run
# BEFORE the episode exists, so a premise-only directory is still unstarted.
# Reading it as started offered `write-episode (resume)` for a drafting
# session that was never begun.
DRAFTING_MARKERS = ("STATUS.md", "outline.md", "script.md")


def _episode_started(ep_dir):
    return any(os.path.exists(os.path.join(ep_dir, f)) for f in DRAFTING_MARKERS)


def _next_action(ms):
    if "finalized" in ms:
        return "—"
    if "audio" in ms and "images" in ms:
        return "assemble-episode"
    if "script" in ms:
        return "produce-assets"
    return "write-episode (resume)"


STATE_ENUM = {"ruled/unstarted": "ruled-unstarted",
              "started (no milestones)": "started",
              "FINAL on NAS": "final-on-nas",
              "finalized (missing on NAS!)": "finalized-missing-nas",
              "unknown (NAS unmounted)": "unknown-nas-unmounted"}


def board_rows(cfg, root=".", nas_dest=None, season=1):
    """The row-building core shared by board() and board_json().

    Returns (rows, ok, problems). Each row is:
      {'air','prod','title','label','state','images','next','milestones'}
    'label' is the exact human string the markdown table has always printed
    (e.g. 'FINAL on NAS', 'ruled/unstarted', or a plain milestone name like
    'script'). 'state' is STATE_ENUM.get(label, label) — plain milestone
    labels ARE already their own stable enum values. 'images' is
    None / 'bad' / {'have': h, 'total': t}. 'milestones' is a sorted list.

    `season` selects <canonDir>/season-{season}.md and the NAS filename's SxxEyy
    (default 1).

    Returns rows=None when the season document itself is unreadable — board()
    renders that as a wholly empty "" (no header); board_json() treats None as
    an empty episode list.
    """
    canon_dir = str(sc.value(cfg, "canonDir"))
    episodes_dir = str(sc.value(cfg, "episodesDir"))
    production_dir = str(sc.value(cfg, "productionDir"))
    nas = nas_dest or str(sc.value(cfg, "output", "nasRoot"))
    problems = []
    season_doc_path = os.path.join(canon_dir, f"season-{season}.md")

    try:
        season_doc = open(os.path.join(root, season_doc_path)).read()
    except (FileNotFoundError, OSError):
        problems.append(f"{season_doc_path} unreadable — cannot build board")
        return None, False, problems

    air_map = air_map_for_season(cfg, season)
    nas_up = os.path.isdir(nas)
    if not nas_up:
        problems.append("NAS unmounted — final states unknown")
    season_rows = parse_season_table(season_doc)
    if not season_rows:
        problems.append(f"{season_doc_path}: no RULED rows parsed — board is empty")

    rows = []
    for row in season_rows:
        air, title = row["air"], row["title"]
        prod = prod_id_for(air, air_map)
        ep_dir = os.path.join(root, episodes_dir, prod)
        imgs = _image_counts(root, prod, production_dir)
        if imgs == "bad":
            images_field = "bad"
            problems.append(f"{prod}: prompts.json unreadable")
        elif imgs:
            images_field = {"have": imgs[0], "total": imgs[1]}
        else:
            images_field = None

        ms = set()
        if not os.path.isdir(ep_dir) or not _episode_started(ep_dir):
            state, nxt = "ruled/unstarted", "write-episode"
        else:
            sp = os.path.join(ep_dir, "STATUS.md")
            ms = episode_milestones(open(sp).read()) if os.path.exists(sp) else set()
            if "finalized" in ms:
                nas_file = os.path.join(nas, sc.format_filename(
                    str(sc.value(cfg, "output", "finalFilename")),
                    slug=str(sc.value(cfg, "showSlug")),
                    season=season, episode=air, episode_id=prod))
                if not nas_up:
                    state = "unknown (NAS unmounted)"
                elif os.path.exists(nas_file):
                    state = "FINAL on NAS"
                else:
                    state = "finalized (missing on NAS!)"
                    problems.append(f"{prod}: stamped finalized but missing on NAS")
            else:
                done = [m for m in MILESTONES if m in ms]
                state = done[-1] if done else "started (no milestones)"
            nxt = _next_action(ms)

        rows.append({
            "air": air, "prod": prod, "title": title,
            "label": state, "state": STATE_ENUM.get(state, state),
            "images": images_field, "next": nxt,
            "milestones": sorted(ms),
        })

    return rows, not problems, problems


def board(cfg, root=".", nas_dest=None, season=1):
    rows, ok, problems = board_rows(cfg, root, nas_dest, season)
    if rows is None:
        return "", ok, problems
    lines = ["| Air | Prod | Title | State | Images | Next action |",
             "|-----|------|-------|-------|--------|-------------|"]
    for r in rows:
        imgs = r["images"]
        if imgs == "bad":
            img_s = "?"
        elif imgs:
            img_s = f"{imgs['have']}/{imgs['total']}"
        else:
            img_s = "—"
        lines.append(f"| E{r['air']} | {r['prod']} | {r['title']} | {r['label']} | {img_s} | {r['next']} |")
    return "\n".join(lines), ok, problems


def board_json(cfg, root=".", nas_dest=None, season=1):
    rows, ok, problems = board_rows(cfg, root, nas_dest, season)
    return {"episodes": rows or [], "ok": ok, "problems": problems}


def season_from_tokens(tokens):
    """First token matching `s<digits>` wins (e.g. 's2' -> 2); default 1."""
    for t in tokens:
        m = re.match(r'^s(\d+)$', t)
        if m:
            return int(m.group(1))
    return 1


def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    # Recognized tokens: an `sN` season selector (default s1) and --json.
    tokens = sys.argv[1:]
    season = season_from_tokens(tokens)
    if "--json" in tokens:
        # --json: stdout is the WHOLE JSON object, nothing else.
        print(json.dumps(board_json(cfg, season=season)))
        return
    md, ok, problems = board(cfg, season=season)
    print(md)
    if ok:
        print("SEASON_STATUS_OK")
    else:
        print(f"SEASON_STATUS_PARTIAL: {len(problems)} problem(s)")
        for p in problems:
            print(f"  - {p}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"season-status: {err}")
