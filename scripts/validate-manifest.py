# /// script
# dependencies = []
# ///
"""validate-manifest: the deterministic gate between the tts-script agent and
synthesis. Catches mechanical errors AND a skipped heteronym pass before we
spend an hour of GPU on a bad manifest.

History: ep02's first build was hand-driven and skipped heteronym normalization
entirely, shipping "Read me the tier" as past-tense "red". Nothing caught it but
a human ear. This script is that missing net.

Exit non-zero on hard failures; print WARN lines for things a human should eyeball
at the casting gate (heteronyms are WARN, not FAIL, because tense classification
is genuinely ambiguous and we would rather flag than block)."""
import json, os, re, sys

from lib import showconfig as sc

def load_qwen3_heteronyms(registry_path):
    """Parse the registry's Qwen3 map. Returns [(script_spelling, note)]."""
    reg = open(registry_path).read()
    m = re.search(r"Qwen3 pronunciation & heteronym map(.+?)(?:\n## |\Z)", reg, re.S)
    rows = []
    if m:
        for line in m.group(1).splitlines():
            c = [x.strip() for x in line.split("|")]
            if len(c) >= 5 and c[1] and "Speaker" not in c[1] and set(c[1]) != {"-"}:
                # column 2 is the script spelling(s), possibly "`read`/`reads`"
                for tok in re.findall(r"`([^`]+)`", c[2]):
                    rows.append(tok.lower())
    return rows

# "reads" (with the s) is ALWAYS present-verb or plural-noun — the past tense is
# "read", never "reads" — so every "reads" is unconditionally /riːdz/ = "reeds".
# Only bare "read" is genuinely ambiguous (past /rɛd/ vs present /riːd/); flag the
# high-confidence present/imperative/noun cases. High precision so WARN is trusted.
READS_ANY  = re.compile(r"\breads\b", re.I)                        # always wrong if not "reeds"
IMPERATIVE = re.compile(r"(^|[.!?\"]\s+)\"?Read\b", re.M)          # sentence-initial "Read ..."
NOUN_READ  = re.compile(r"\b(a|an|the|short|long|quick|first|close)\s+read\b", re.I)
PRESENT_TO = re.compile(r"\bto\s+read\b", re.I)
READOUT    = re.compile(r"\breadouts?\b", re.I)                    # COMPOUND (REED-out); always wrong
# read-COMPOUNDS that Qwen3 gets right and must NOT be flagged (REED-/-ED sounds, or unrelated words)
_READ_SAFE = re.compile(r"\b(reading|reader|readers|readable|already|bread|dread|spread|spreading|thread|threads|ready|treadle?|treads?|breading|dreadful)\b", re.I)

def suspicious_read(text):
    hits = []
    if READS_ANY.search(text):  hits.append("'reads' (always present/noun -> reeds)")
    if IMPERATIVE.search(text): hits.append("imperative 'Read'")
    if NOUN_READ.search(text):  hits.append("noun 'read'")
    if PRESENT_TO.search(text):  hits.append("'to read'")
    if READOUT.search(text):    hits.append("'readout' compound (-> reedout)")
    # backstop: any OTHER unrespelled 'read'-substring word not on the safe list
    for m in re.finditer(r"\b\w*read\w*\b", text):
        w = m.group(0).lower()
        if w in ("read", "readout", "readouts"): continue          # handled above / by tense rules
        if _READ_SAFE.match(w): continue
        hits.append(f"unreviewed read-compound {w!r}")
    return hits

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else. Everything below is show-relative from there.
    root = sc.show_root(sys.argv)
    os.chdir(root)
    cfg = sc.load(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("validate-manifest: episode id missing (usage: validate-manifest.py <episode> [--show-root <path>])")
    # Every ceiling and every name below is the SHOW's, not this script's.
    tc_max = float(sc.value(cfg, "audio", "titleCardGapMaxSeconds"))
    scene_max = float(sc.value(cfg, "audio", "sceneTransitionGapMaxSeconds"))
    pause_min, pause_max = (float(x) for x in sc.value(cfg, "audio", "authoredPauseRangeSeconds"))
    mains = set(sc.value(cfg, "audio", "mainCast"))
    registry_path = sc.path(cfg, "audio", "voiceRegistry", root=root)
    doc = json.load(open(f"Production/{ep}/tts-script.json"))
    cast, segs = doc["cast"], doc["segments"]
    fails, warns = [], []

    if not segs: sys.exit("no segments")
    # The pipeline keys WAV filenames ({i:04d}.wav) and default seeds (i*7919+13)
    # off "i", so what it needs is UNIQUE, STRICTLY-INCREASING i — not contiguity.
    # (A finished episode can have an intentional gap: ep01 dropped seg 98 when the
    # title-card narration was cut, and renumbering would orphan its rendered WAVs.)
    prev = 0
    for pos, s in enumerate(segs, 1):
        i = s["i"]
        if i <= prev: fails.append(f"i not strictly increasing at position {pos} (i={i}, prev={prev})")
        prev = i
        if s["speaker"] not in cast:          fails.append(f"uncast speaker {s['speaker']!r} at i={i}")
        if not s["text"].strip():             fails.append(f"empty text at i={i}")
        # Authoring marks must never survive into spoken text. The script carries
        # [SPEAKER] attribution tags and [BEAT]/[PAUSE n] pause marks; both are
        # instructions to the manifest stage, and a leaked one is READ ALOUD --
        # the listener hears the bracket and the speaker name spoken. ep10 came
        # through clean only because the agent inferred the convention before the
        # prompt taught it, which is luck, not a guarantee. This is the check that
        # makes it one.
        if re.search(r"\[(?:[A-Z][A-Z0-9 _-]*|BEAT|PAUSE\b[^\]]*)\]", s["text"]):
            fails.append(f"authoring mark leaked into spoken text at i={i}: {s['text'][:60]!r}")
        # The title-card ceiling and the scene-transition ceiling are the show's
        # (audio.titleCardGapMaxSeconds, audio.sceneTransitionGapMaxSeconds); the second carries
        # headroom over the show's designed scene-transition pause.
        maxg = tc_max if s.get("title_card_before") else scene_max
        gap = float(s.get("gap_before", 0))
        if not (0 <= gap <= maxg):
            kind = "title-card" if s.get("title_card_before") else "scene-transition"
            fails.append(f"weird gap {s.get('gap_before')} at i={i} ({kind} ceiling is {maxg}s)")
        elif gap > 0 and not s.get("title_card_before") and not (pause_min <= gap <= pause_max):
            # Inside the ceiling but outside the show's authored-pause range
            # (audio.authoredPauseRangeSeconds): legal, and worth a human glance.
            warns.append(f"seg {i}: authored pause {gap}s is outside the show's "
                         f"{pause_min}-{pause_max}s range")
        sc.progress(pos, len(segs), "segments")
    # a fresh build SHOULD be contiguous; a gap is a soft smell worth a glance
    if segs[-1]["i"] != len(segs):
        warns.append(f"i is non-contiguous ({len(segs)} segments, last i={segs[-1]['i']}) — "
                     f"expected for a hand-edited episode, suspicious for a fresh build")
    tc = [s["i"] for s in segs if s.get("title_card_before")]
    if len(tc) > 1: fails.append(f"multiple title cards: {tc}")

    engine = doc.get("engine", "kokoro")
    if engine == "qwen3":
        for spk, c in cast.items():
            for k in ("ref", "ref_text", "direction"):
                if not c.get(k): fails.append(f"cast {spk!r} missing {k!r}")
            if c.get("ref") and not os.path.exists(c["ref"]):
                fails.append(f"cast {spk!r} ref not found: {c['ref']}")

        # --- heteronym pass check (the ep02 net) ---
        mapped = load_qwen3_heteronyms(registry_path)
        read_mapped = any("read" in t for t in mapped)
        reed_count = sum(len(re.findall(r"\breeds?\b", s["text"], re.I)) for s in segs)
        # sense-conditional entries are handled by dedicated logic (read/reads/readout
        # via suspicious_read; separate's verb sense is legitimate) — skip them in the
        # GENERAL net so it doesn't blanket-flag legitimate uses. Every OTHER mapped
        # script-spelling is unconditional: if the raw form survives in synth text it
        # was NOT respelled. This is what makes the map self-enforcing (buffet, names,
        # and any future addition are caught without new code).
        GENERAL_SKIP = {"read", "reads", "readout", "readouts", "separate"}
        general = [w for w in mapped if w.lower() not in GENERAL_SKIP and len(w) >= 3]
        for s in segs:
            for h in suspicious_read(s["text"]):
                warns.append(f"seg {s['i']} [{s['speaker']}]: likely un-respelled {h} — "
                             f"'{s['text'][:60]}'")
            for w in general:
                if re.search(rf"\b{re.escape(w)}\b", s["text"], re.I):
                    warns.append(f"seg {s['i']} [{s['speaker']}]: un-respelled heteronym "
                                 f"{w!r} (registry map) — '{s['text'][:60]}'")
        if read_mapped and reed_count == 0 and any(
                re.search(r"\bread", s["text"], re.I) for s in segs):
            warns.append("NO 'reed' respellings present but 'read' appears and the map "
                         "requires present/noun read->reed — did the heteronym pass run?")

        # --- runway smell test: a GUEST's first line needs 5+ words to calibrate an
        # unfamiliar voice. The show's locked mains (audio.mainCast) recur weekly and need no
        # runway, so skip them -- flagging a regular's two-word greeting every episode is noise. ---
        seen = set()
        for s in segs:
            sp = s["speaker"]
            if sp in mains or sp in seen: continue
            seen.add(sp)
            is_guest = cast.get(sp, {}).get("guest") or sp not in mains
            if is_guest and len(s["text"].split()) < 5 and not s.get("cutoff"):
                warns.append(f"seg {s['i']}: guest {sp!r} FIRST line is <5 words "
                             f"('{s['text']}') — runway rule; confirm attribution/order")

        nd = sum(1 for s in segs if s.get("delivery"))
        words = sum(len(s["text"].split()) for s in segs)
        summary = (f"qwen3: {len(segs)} segments, {len(cast)} cast, {nd} directed, "
                   f"~{words} words, {reed_count} heteronym respellings")
    else:
        summary = f"kokoro (legacy): {len(segs)} segments"

    for w in warns: print(f"WARN  {w}")
    if fails:
        for f in fails: print(f"FAIL  {f}")
        sys.exit(f"MANIFEST_INVALID: {len(fails)} hard failures, {len(warns)} warnings")
    print(f"MANIFEST_OK {summary}"
          + (f"  ({len(warns)} warnings to eyeball)" if warns else ""))

if __name__ == "__main__":
    try:
        main()
    except sc.ShowConfigError as err:
        sys.exit(f"validate-manifest: {err}")
