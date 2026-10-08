# /// script
# dependencies = []
# ///
"""publish-kit: per-episode YouTube upload sheet, generated from data we already have.

Writes Production/<ep>/publish/:
  - upload.md    : ONE self-contained sheet — every upload-page field with this
                   show's answer, in page order, description (with chapters)
                   inline. Work top to bottom while uploading.
  - captions.srt : exact captions from the audio manifest (spells the invented words
                   right; auto-captions won't). Upload this in the Subtitles section.

Every standing answer is the show's (the publish.* block of showrunner.json) and every
per-episode answer is the episode's: the teaser comes from Episodes/<ep>/publish.json,
which the showrunner writes, not from a dictionary in this file.

Usage: publish-kit.py <episode> [--show-root <path>]
"""
import json, os, re, sys

from lib import showconfig as sc


def load_logline(path: str) -> str:
    """The episode's teaser, from its own publish.json.

    A missing file is an error naming it rather than a placeholder paragraph in the description:
    ten episodes shipped with the old placeholder because nothing stopped the upload sheet from
    being written without one.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except OSError as err:
        raise sc.ShowConfigError(
            f"{path} could not be read ({err}) — it carries this episode's logline "
            f"(3-5 sentences, sell the dread, spoil nothing). Write it, then re-run.") from err
    except ValueError as err:
        raise sc.ShowConfigError(f"{path} is not valid JSON: {err}") from err
    logline = doc.get("logline") if isinstance(doc, dict) else None
    if not isinstance(logline, str) or not logline.strip():
        raise sc.ShowConfigError(
            f"{path} is missing its \"logline\" — the description's teaser slot. "
            f"Write it, then re-run.")
    return logline.strip()


def ts(sec, comma=True):
    h = int(sec // 3600); m = int((sec % 3600) // 60); s = int(sec % 60); ms = int((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}" if comma else (f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}")

def _norm(x): return re.sub(r"[^a-z0-9 ]", "", x.lower())

def ep_title(script_path):
    """The episode's own title, from the quoted name on its script's first line."""
    m = re.search(r'"([^"]+)"', open(script_path).read().splitlines()[0])
    return m.group(1) if m else ""

def scene_chapters(script_path, txt, segs, starts):
    """[(stamp, label)] by matching each ## header to its segment start time."""
    paras = [p.strip() for p in open(script_path).read().split("\n\n") if p.strip()]
    titles, probes, expect = [], [], False
    for p in paras:
        if p.startswith("## "): titles.append(p[3:].strip()); expect = True; continue
        if p.startswith("#"): continue
        if expect:
            m = re.match(r'\s*"([^"]+)"', p)
            probes.append(_norm(m.group(1) if m else p)[:40]); expect = False
    out = []
    for i, (title, probe) in enumerate(zip(titles, probes)):
        seg = next((s["i"] for s in segs if _norm(txt[s["i"]]).startswith(probe[:30])), None)
        sec = starts.get(seg, 0.0)
        label = re.sub(r"^(COLD OPEN|SCENE [\w']+)\s*[—-]\s*", "", title).strip() or title
        out.append(("0:00" if i == 0 else ts(sec, comma=False), label))
    return out

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("publish-kit: episode id missing "
                 "(usage: publish-kit.py <episode> [--show-root <path>])")

    # Everything standing about how this show publishes.
    show_name = str(sc.value(cfg, "showName"))
    channel_name = str(sc.value(cfg, "publish", "channelName"))
    playlist_url = str(sc.value(cfg, "publish", "playlistUrl"))
    playlist_name = str(sc.value(cfg, "publish", "playlistName"))
    tags = str(sc.value(cfg, "publish", "tags"))
    category = str(sc.value(cfg, "publish", "category"))
    weekly_copy = str(sc.value(cfg, "publish", "standingCopy", "weekly"))
    ai_disclosure = str(sc.value(cfg, "publish", "standingCopy", "aiDisclosure"))
    guide = str(sc.value(cfg, "publish", "guide"))
    episodes_dir = str(sc.value(cfg, "episodesDir"))
    prod = sc.production_dir(cfg)

    script_path = f"{episodes_dir}/{ep}/script.md"
    logline = load_logline(f"{episodes_dir}/{ep}/publish.json")

    man = json.load(open(f"{prod}/{ep}/audio/manifest.json"))
    doc = json.load(open(f"{prod}/{ep}/tts-script.json"))
    txt = {s["i"]: s["text"] for s in doc["segments"]}
    season, episode = sc.season_of(cfg, ep)
    slug = f"S{season:02d}E{episode:02d}"
    out = f"{prod}/{ep}/publish"; os.makedirs(out, exist_ok=True)
    title_str = ep_title(script_path)
    # the pilot is often named the same as the show; don't repeat it
    title_line = (f"{show_name} — {slug}"
                  if title_str.lower() in (show_name.lower(), "")
                  else f"{show_name} — {slug}: {title_str}")

    t = 0.0; starts = {}
    for m in man["segments"]:
        t += m.get("gap_before", 0) or 0; starts[m["i"]] = t; t += m["duration_s"]
    total = t

    # captions.srt
    srt = [f"{n}\n{ts(starts[m['i']])} --> {ts(starts[m['i']] + m['duration_s'])}\n{txt[m['i']].strip()}\n"
           for n, m in enumerate(man["segments"], 1)]
    open(f"{out}/captions.srt", "w").write("\n".join(srt))

    chapters = scene_chapters(script_path, txt, doc["segments"], starts)
    chap_block = "\n".join(f"{stamp} {label}" for stamp, label in chapters)
    description = f"""{title_line}

{logline}

{weekly_copy}

CHAPTERS
{chap_block}

—
{ai_disclosure}

{playlist_name} playlist: {playlist_url}"""

    sheet = f"""# {title_line} — YouTube upload sheet
Work top to bottom; this follows the upload page. Reasoning for the standing
choices is in {guide}. Runtime {ts(total, comma=False)}.

## Title  (required)
{title_line}

## Description  (paste the whole block below)
```
{description}
```

## Thumbnail
Make one (frame + the show's title treatment). Not derivable from data.

## Playlist
{playlist_name}

## Audience — made for kids?
No, it's not made for kids.

## AI use
No.  (Fully fictional — no real people/places/events; the fantastical carve-out.
Selecting Yes is also fine and costs nothing — see the guide.)

## Category
{category}

## Video language & captions
Language: English.
Then in the Subtitles section, upload:  {out}/captions.srt

## Tags
{tags}

## Toggles / settings
- Paid promotion: OFF (no sponsor)
- Automatic concepts (experiment): OFF (our terms are invented; it mis-defines them)
- Featured places: OFF (no real places)
- Automatic chapters: irrelevant — the description's chapters (0:00 start) win
- Allow embedding: ON
- Publish to subscriptions feed & notify: ON
- Shorts remixing: Don't allow  (protects the narrative; your call vs. reach)
- License: Standard YouTube License
- Comments: On / Basic moderation / Anyone / Sort by Top
- Recording date & location: leave blank (fiction)

## Files
- Video:    {prod}/{ep}/video/{title_line}.mp4   (once rendered)  OR the master under {prod}/{ep}/video/
- Captions: {out}/captions.srt
"""
    open(f"{out}/upload.md", "w").write(sheet)
    # drop the old split files so the single sheet is the source of truth
    for stale in ("description.txt", "chapters.txt"):
        p = f"{out}/{stale}"
        if os.path.exists(p): os.remove(p)

    # F-17: the credit name is carried in config as the placeholder it has always been, and the
    # reminder still fires until somebody sets publish.channelName.
    # H-20: and the reminder says what is true of the name. `playlist_url` is written into the
    # sheet above; `channel_name` is read at the top of this function and reaches nothing but the
    # test below, so "then all episodes fill in" was a promise this script keeps for one of the two
    # keys and not the other. The name is written nowhere until the key is filled.
    filled = channel_name != "[YOUR NAME]" and playlist_url != "[PLAYLIST URL]"
    print(f"  {len(chapters)} chapters" + ("" if filled else "  |  NOTE: set publish.channelName + publish.playlistUrl in showrunner.json once; the name is written nowhere until the key is filled"))
    # The last line is this step's RESULT: the gate message after it reads it verbatim, so the
    # reminder above it stays an ordinary script_line rather than displacing the result.
    print(f"PUBLISH_KIT {slug} -> {out}/upload.md  (+ captions.srt, {len(man['segments'])} cues, {ts(total, comma=False)})")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"publish-kit: {err}")
