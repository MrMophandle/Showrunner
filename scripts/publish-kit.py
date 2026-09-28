# /// script
# dependencies = []
# ///
"""publish-kit: per-episode YouTube upload sheet, generated from data we already have.

Writes Production/<ep>/publish/:
  - upload.md    : ONE self-contained sheet — every upload-page field with the Dead
                   Light answer, in page order, description (with chapters) inline.
                   Work top to bottom while uploading.
  - captions.srt : exact captions from the audio manifest (spells the invented words
                   right; auto-captions won't). Upload this in the Subtitles section.

Standing choices and the reasoning behind them live in Canon/publishing-guide.md.
Set CHANNEL below once and every episode fills in.
"""
import json, os, re, sys

# ── set these once ────────────────────────────────────────────────────────────
CHANNEL = {
    "name": "[YOUR NAME]",          # the written/directed-by credit
    "playlist_url": "https://www.youtube.com/playlist?list=PLciZ4PlFk16g",
}
AIR = {"ep01": (1, 1), "ep02": (1, 2), "ep03": (1, 3), "ep04": (1, 4), "ep05": (1, 5), "ep06": (1, 6), "ep07": (1, 7), "ep08": (1, 8), "ep09": (1, 9), "ep10": (1, 10)}  # ep98 (the dead non-canon test-bed) deliberately UNMAPPED — it held slot 9
#   until ep09 "The Wick" was written fresh; finalize-video.py has always had this right.
LOGLINE = {
 "ep01": "A salvage crew works the ruins of a vanished civilization. The dark has never once cared whether they get home.",
 "ep02": "A wreck is a number before it's a place. Two crews, one claim, and a margin that won't hold.",
 "ep03": "A crew comes home short a man. One of them carries his kit the long way — by hand — to whoever's left to take it.",
 "ep04": "A dead ship deep in a well, falling slow — worth a season's margin for exactly one pass. The arithmetic says where to stop. The job keeps asking for one more deck.",
 "ep05": """A clean claim, for once: an ore-tug adrift two years, honest paper, her crew long since walked off alive. Every instrument on the board agrees there is nothing out there. The only thing aboard that says otherwise is Opha — and she can't say what, or why. So the captain does the arithmetic on a feeling, orders the ship dark, and the crew works an entire shift in silence — for a danger with no name, no reading, and no proof it was ever there.

Almost no proof.""",
 "ep06": """A transport adrift off the lanes, lit end to end, holding her station on a dead man's autopilot. Full holds, no distress call, no damage anywhere — and every soul aboard dead where they sat. A meal half eaten. A hand of cards still fanned. No wounds, no decompression, no fear, and not one of them stood up.

The crew that boards her spends the day proving it was equipment. It wasn't equipment.""",
 "ep07": """A charted nowhere two days off the lanes, a room of frightened spacers dressed for a funeral, and a man selling the only thing a scared galaxy wants to buy: safety. Surrender your salvage as tribute, he says, and the ones who are coming back will pass your hull by.

The Dead Light is only the hired transport. Nobody aboard bought a word of it — and before the night is out, they can prove it was a lie. Being right turns out to cost more than anyone counted.""",
 "ep08": """A distress beacon so weak it barely reads, out where the border goes quiet. On the other end: an Iss-kar troop transport, drives dead, rations gone, carrying civilians off a settlement that officially does not exist — and a captain whose own people will not answer him, because answering would mean admitting he is there.

The Dead Light's crew are the last thing an Iss-kar would ever ask for help. They go anyway. What the survivors tell them, days later over supper, is the reason a whole species stopped making noise.""",
 "ep09": """An ordinary job. A cloud of dead ships drifted together by their own gravity, one good hull down near the middle of it, and a haul that has to come out by skiff or not at all. The captain will not ask anyone to fly that, so he goes himself, and takes the pilot with him — and hands the ship to the crewmate who has never in her life given an order out loud.

Nothing is hunting them. Nothing is out there. The dark does not need a monster to take something from you and never give it back.""",
 "ep10": """A salvage crew comes home from an ordinary week with a crushed arm, a bill that eats the profit, and one frame of camera footage nobody can explain: a hooded figure standing in their own passage, holding something small up to the lens. Their own records show no one came aboard, and no one left.

This is that same working day, told a second time, from the only vantage that can account for it. You will see everything the crew could not. They never will.""",
}
TAGS = "hard science fiction, sci-fi audio drama, space horror, narrated sci fi, cosmic horror, salvage crew, deep space"

def ts(sec, comma=True):
    h = int(sec // 3600); m = int((sec % 3600) // 60); s = int(sec % 60); ms = int((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}" if comma else (f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}")

def _norm(x): return re.sub(r"[^a-z0-9 ]", "", x.lower())

def ep_title(ep):
    m = re.search(r'"([^"]+)"', open(f"Episodes/{ep}/script.md").read().splitlines()[0])
    return m.group(1) if m else ""

def scene_chapters(ep, txt, segs, starts):
    """[(stamp, label)] by matching each ## header to its segment start time."""
    paras = [p.strip() for p in open(f"Episodes/{ep}/script.md").read().split("\n\n") if p.strip()]
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
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep: sys.exit("publish-kit: episode id missing")
    man = json.load(open(f"Production/{ep}/audio/manifest.json"))
    doc = json.load(open(f"Production/{ep}/tts-script.json"))
    txt = {s["i"]: s["text"] for s in doc["segments"]}
    s, e = AIR.get(ep, (0, 0)); slug = f"S{s:02d}E{e:02d}"
    out = f"Production/{ep}/publish"; os.makedirs(out, exist_ok=True)
    title_str = ep_title(ep)
    # pilot is named the same as the show; don't repeat it
    title_line = f"Dead Light — {slug}" if title_str.lower() in ("dead light", "") else f"Dead Light — {slug}: {title_str}"

    t = 0.0; starts = {}
    for m in man["segments"]:
        t += m.get("gap_before", 0) or 0; starts[m["i"]] = t; t += m["duration_s"]
    total = t

    # captions.srt
    srt = [f"{n}\n{ts(starts[m['i']])} --> {ts(starts[m['i']] + m['duration_s'])}\n{txt[m['i']].strip()}\n"
           for n, m in enumerate(man["segments"], 1)]
    open(f"{out}/captions.srt", "w").write("\n".join(srt))

    chapters = scene_chapters(ep, txt, doc["segments"], starts)
    chap_block = "\n".join(f"{stamp} {label}" for stamp, label in chapters)
    description = f"""{title_line}

{LOGLINE.get(ep) or f'[WRITE THE TEASER — {ep} has no LOGLINE entry in publish-kit.py. 3-5 sentences, sell the dread, spoil nothing. The description is the episode summary/teaser slot (Ryan-ruled 2026-08-02); do not upload with this placeholder.]'}

New episodes weekly. Self-contained stories in a shared universe; one long, quiet thread underneath. Best watched in order.

CHAPTERS
{chap_block}

—
An honest-to-goodness human dreamed up this world and rules every frame of it. AI helps with the writing, the narration, and the art. The story doesn't come from a machine.

Season 1 playlist: {CHANNEL['playlist_url']}"""

    sheet = f"""# {title_line} — YouTube upload sheet
Work top to bottom; this follows the upload page. Reasoning for the standing
choices is in Canon/publishing-guide.md. Runtime {ts(total, comma=False)}.

## Title  (required)
{title_line}

## Description  (paste the whole block below)
```
{description}
```

## Thumbnail
Make one (frame + "DEAD LIGHT" title treatment). Not derivable from data.

## Playlist
Dead Light Season 1

## Audience — made for kids?
No, it's not made for kids.

## AI use
No.  (Fully fictional — no real people/places/events; the fantastical carve-out.
Selecting Yes is also fine and costs nothing — see the guide.)

## Category
Film & Animation

## Video language & captions
Language: English.
Then in the Subtitles section, upload:  {out}/captions.srt

## Tags
{TAGS}

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
- Video:    Production/{ep}/video/{title_line}.mp4   (once rendered)  OR the master under Production/{ep}/video/
- Captions: {out}/captions.srt
"""
    open(f"{out}/upload.md", "w").write(sheet)
    # drop the old split files so the single sheet is the source of truth
    for stale in ("description.txt", "chapters.txt"):
        p = f"{out}/{stale}"
        if os.path.exists(p): os.remove(p)

    filled = CHANNEL["name"] != "[YOUR NAME]" and CHANNEL["playlist_url"] != "[PLAYLIST URL]"
    print(f"PUBLISH_KIT {slug} -> {out}/upload.md  (+ captions.srt, {len(man['segments'])} cues, {ts(total, comma=False)})")
    print(f"  {len(chapters)} chapters" + ("" if filled else "  |  NOTE: set CHANNEL name + playlist_url once, then all episodes fill in"))

main()
