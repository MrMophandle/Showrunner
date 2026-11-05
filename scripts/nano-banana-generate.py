# /// script
# dependencies = ["google-genai", "pillow"]
# ///
"""nano-banana-generate: every pipeline shot of an episode, via the Gemini API (Nano Banana Pro).

For each shot in Production/<ep>/images/prompts.json whose `source` is "pipeline" and whose PNG is
missing: compose the prompt, render it through lib/nanobanana.py at 2K 16:9, vision-audit via
Claude headless, retry with corrective notes (<=3 attempts). An `establishing` shot carries no refs
unless they name a place, and then that place's reference and gallery condition the render as a
character's do; an establishing shot with no refs is rendered from its brief alone — the brief plus
the show's style constants, with no reference images attached (spec 2026-11-04 §2.2, §3.2, as
amended on 2026-11-04). A `character` shot is rendered conditioned on the reference and the
gallery (at most three) named by each of its refs' entries in the cast index. A shot whose PNG
exists is skipped — a hand-made shot always wins (delete a PNG or use --only to re-roll). A shot
whose `source` is `showrunner` is never generated; the showrunner drops it in.

Everything that makes a frame THIS show's frame comes from the show's config and canon, never from
this file: the cast index (Canon/cast.json), the photographic look (visual.styleConstants) and the
audit laws (the file at visual.auditLaws). The Gemini client itself — the key check, the call, the
retry policy, the atomic write — is lib/nanobanana.py, shared with design-visual.py since
2026-11-04 (spec 2026-11-04 §3.1).

Usage:
  nano-banana-generate.py <episode> [--only id,id] [--notes "text"] [--no-audit]
                                    [--show-root <path>]
"""
import json, os, re, subprocess, sys

from lib import castindex
from lib import nanobanana as nb
from lib import showconfig as sc

MAX_ATTEMPTS = 3                       # audit-failure retries per shot
# How many stills a subject contributes is not a constant here any more: the cast index names a
# subject's gallery and lib/castindex.py caps it at three (spec 2026-10-31 §1.2a). Nothing in this
# script lists a character folder, so nothing here decides which stills are the newest. The cap on
# reference images per call (nb.MAX_IMAGES) belongs to the client, not to this script.

# The show's photographic look is visual.styleConstants in showrunner.json, appended to every
# brief by compose_prompt. One standing warning for whoever edits that key: do NOT put
# "Cinematic 16:9 frame" in it. The aspect ratio is set properly via the API's
# response_format.aspect_ratio, and saying "cinematic frame" in the prompt made the model PAINT
# letterbox bars into the picture as a style choice (ep04 pilot: 24px top / 189px bottom baked
# in). A full-bleed sentence is what belongs there instead.


def normalize_key(ref: str) -> str:
    """A ref string to its bible key: 'Mara' -> 'mara'; 'relic (style-token...)' -> 'relic'."""
    return re.split(r"[\s(]", ref.strip(), 1)[0].lower()


def load_bible(cfg: dict, root: str) -> dict:
    """Who has a locked face, from the show's cast index: {key: {"ref", "identity", "gallery",
    "kind", "name"}} for every entry whose reference image is on disk, with each gallery filtered
    to files that exist and capped at three. It stays a named function, rather than the one
    castindex call it now wraps, because it is the seam the tests replace."""
    return castindex.faces(castindex.load(cfg, root), root)


def assemble_refs(shot: dict, bible: dict, max_images: int = nb.MAX_IMAGES):
    """-> (image_paths, identity_lines, missing_keys). Sheets first; stills
    dropped (never sheets) to respect max_images. Dedupes by normalized key.

    A shot with no `refs` returns three empty lists, which is what makes its render a text-only
    call. An `establishing` shot carries no refs unless they name a place, and then the place's
    reference and gallery condition the render exactly as a character's do — the cast index's
    `faces` is kind-agnostic, so a `location` or `ship` entry with a `face.ref` on disk resolves
    here like any other (spec 2026-11-04 §2.2 and §3.2, as amended on 2026-11-04)."""
    seen_keys = set()
    sheets, stills, identities, missing, dropped_sheets = [], [], [], [], []

    for raw in shot.get("refs", []):
        key = normalize_key(raw)
        if key in seen_keys:  # Skip duplicate keys
            continue
        seen_keys.add(key)

        entry = bible.get(key)
        if not entry or not os.path.exists(entry.get("ref", "")):
            missing.append(key)
            continue
        sheets.append((key, entry["ref"]))
        identities.append(f"{key.upper()} (must match the attached reference "
                          f"images): {entry['identity']}")
        # The subject's stills are the ones its cast-index entry names, already filtered to files
        # on disk and capped at three by lib/castindex.py. The folder they sit in is never listed.
        stills.extend(entry.get("gallery", []))

    # Extract sheet paths and dedupe stills BY BASENAME, not full path.
    # Two entries' galleries may still name one file: a group still of both
    # subjects is one photograph, and the cast index is edited by hand, so it
    # can reach this loop twice — at the same path, or at two paths that end in
    # the same basename. Deduping by path alone lets both copies survive,
    # burning reference-image slots on one photo and displacing a genuinely
    # distinct still of another subject — worse conditioning for the same $
    # cost. Keep the first occurrence, preserve order.
    sheet_paths = [path for _, path in sheets]
    stills_deduped = []
    seen_stills = set()
    for still in stills:
        base = os.path.basename(still)
        if base not in seen_stills:
            stills_deduped.append(still)
            seen_stills.add(base)

    # Handle cap: if sheets exceed max_images, drop excess sheets and warn
    if len(sheet_paths) > max_images:
        dropped_keys = [key for key, _ in sheets[max_images:]]
        dropped_sheets = sheet_paths[max_images:]
        sheet_paths = sheet_paths[:max_images]
        identities = identities[:max_images]
        print(f"WARNING: shot {shot.get('id')} exceeded {max_images}-image cap; "
              f"dropped reference sheets for: {', '.join(dropped_keys)}")
        return sheet_paths, identities, missing

    # Normal case: sheets fit, cap stills to remaining space
    room = max(0, max_images - len(sheet_paths))
    return sheet_paths + stills_deduped[:room], identities, missing


def compose_prompt(shot: dict, identity_lines: list[str], style_constants: str,
                   notes: str = "") -> str:
    """The brief the model is given: who is in frame, what happens, and the show's look.

    `identity_lines` is empty for a shot with no refs, so such a shot's prompt is its brief
    followed by the show's style constants and nothing else. An `establishing` shot carries no refs
    unless they name a place, and then the place's identity line is prepended and its reference
    image attached, so the place's own look conditions the render (spec 2026-11-04 §2.2 and §3.2,
    as amended on 2026-11-04)."""
    parts = list(identity_lines) + [shot["brief"], style_constants]
    if notes:
        parts.append(f"PREVIOUS ATTEMPT REJECTED: {notes}. Fix exactly this.")
    return "\n\n".join(parts)


def load_audit_laws(path: str) -> str:
    """The show's audit laws, read verbatim from the file at visual.auditLaws.

    They live in the show's canon rather than in this script because they are statements about
    THIS show's anatomy, scale and house style -- how many limbs a given species has, how big a
    given relic reads. The file is read once per run and inserted into the audit prompt whole.
    """
    with open(path, encoding="utf-8") as fh:
        laws = fh.read().strip()
    if not laws:
        raise sc.ShowConfigError(f"the audit laws file at {path} is empty")
    return laws


def _audit_call(prompt: str) -> str:
    r = subprocess.run(
        ["claude", "-p", prompt, "--allowedTools", "Read"],
        capture_output=True, text=True, timeout=300)
    if not r.stdout.strip() and r.stderr.strip():
        # A structurally broken `claude` invocation (bad auth, crashed CLI,
        # not on PATH under the login shell Archon runs in) prints nothing to
        # stdout. Without this, that's indistinguishable from a model that
        # just replied in prose — both fail-closed as "unparseable", and the
        # real cause (an auth/config problem, not an image problem) never
        # surfaces while 3 PAID generations burn per shot regardless. Surface
        # the real error instead of discarding it.
        return f"CLAUDE STDERR: {r.stderr.strip()}"
    return r.stdout


def audit_image(shot, png_path, audit_laws: str, show_name: str):
    prompt = (f"You are the image auditor for the series {show_name}. "
              f"Read (view) the image at {png_path} .\n"
              f"It was generated for this brief:\n---\n{shot['brief']}\n---\n"
              f"Named cast: {', '.join(shot.get('refs', [])) or 'none'}\n\n"
              f"{audit_laws}\n\n"
              f"Reply with ONLY this JSON on the last line, nothing after it: "
              f'{{"pass": true|false, "notes": "<one concrete sentence if fail>"}}')
    try:
        out = _audit_call(prompt)
    except subprocess.TimeoutExpired:
        return (False, "audit timed out after 300s — treating as fail")
    except FileNotFoundError:
        return (False, "claude binary not found — treating as fail")

    m = re.findall(r'\{[^{}]*"pass"[^{}]*\}', out)
    if not m:
        # Fold the raw output into the note (not just the static label) so a
        # structurally broken `claude` invocation's real error — now routed
        # through _audit_call's stderr capture above — reaches the operator
        # via the attempt-N REJECTED print in run(), instead of vanishing.
        detail = out.strip()
        return (False, "audit output unparseable — treating as fail"
                       + (f": {detail[:300]}" if detail else " (no output at all)"))

    # Parse all matches and check for disagreement
    verdicts = []
    for match in m:
        try:
            v = json.loads(match)
            verdicts.append(v)
        except (json.JSONDecodeError, TypeError):
            pass

    if not verdicts:
        return (False, "audit output unparseable — treating as fail")

    # Check if multiple verdicts disagree on the boolean
    if len(verdicts) > 1:
        passes = [bool(v.get("pass")) for v in verdicts]
        if len(set(passes)) > 1:  # verdicts disagree
            return (False, "audit verdicts disagree — treating as fail")

    # All verdicts agree; use the last one (brief's specification)
    v = verdicts[-1]
    return (bool(v.get("pass")), str(v.get("notes", "")))


def exit_code_for(tag: str) -> int:
    """The process exit code for a run's NANO_* tag.

    NANO_PARTIAL exits 0, not 1. The tag is this step's RESULT, and a partial render is a result
    and not a failure. The step after this one is the vision audit (`image-audit-1`), which judges
    the PNGs on disk; after the audit loop and the sheet, `image-gate` shows the sheet and the
    rendered batch to the showrunner, who decides whether the batch is good enough (spec
    2026-11-04 §4). Both read the files rather than this tag, and a non-zero exit would fail the
    step before either of them ran. This is the rule the bash node that preceded the engine
    enforced with `grep -qE 'NANO_(OK|PARTIAL)'` over the captured output — a run that printed no
    tag at all is the only failure.
    """
    return 0 if tag in ("NANO_OK", "NANO_PARTIAL") else 1


def run(ep, cfg, root, only=None, notes="", no_audit=False):
    """Generate every missing pipeline shot for one episode, of any type. `cfg` is the show's
    config and `root` its absolute directory, from which every show path in the config is
    resolved."""
    # Everything the SHOW decides about a frame, read once: how its photography reads and which
    # laws the audit applies. Who is in the cast is the index's to say, read through load_bible
    # below.
    style_constants = str(sc.value(cfg, "visual", "styleConstants"))
    audit_laws = load_audit_laws(sc.path(cfg, "visual", "auditLaws", root=root))
    show_name = str(sc.value(cfg, "showName"))
    prod = sc.production_dir(cfg)

    base = f"{prod}/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    bible = load_bible(cfg, root)
    # Every shot the pipeline owns is rendered here, whatever its type: an establishing shot from
    # its brief alone, a character shot conditioned on its refs (spec 2026-11-04 §3.2). What takes
    # a shot out of the set is `source`, not `type` — a shot whose `source` is "showrunner" is the
    # showrunner's to make by hand, so no API call is spent on it, no audit judges it, and it takes
    # no result row. The engine's `showrunner-images` guard is what holds the line until its PNG is
    # on disk.
    shots = [s for s in doc["shots"] if s.get("source", "pipeline") != "showrunner"]
    by_hand = [str(s.get("id", "?")) for s in doc["shots"]
               if s.get("source", "pipeline") == "showrunner"]
    if by_hand:
        # Say it. Silence reads as loss: a run that generates two of five shots and says nothing
        # about the other three looks like a run that dropped them.
        print(f"  {len(by_hand)} showrunner-made shot(s) left alone: {', '.join(by_hand)}")

    if only:
        valid_ids = {s["id"] for s in shots}
        unknown = [oid for oid in only if oid not in valid_ids]
        if unknown:                                   # validate BEFORE touching anything
            sys.exit(f"unknown --only id(s): {', '.join(unknown)}. "
                     f"Valid shot ids: {', '.join(sorted(valid_ids)) or '(none)'}")
        shots = [s for s in shots if s["id"] in only]

    # --only re-roll: back a pre-existing PNG up (never delete it outright) so
    # a hand-made image can be restored if generation doesn't fully succeed.
    backups = {}
    if only:
        # Refuse to clobber a pre-existing .bak: it may be the TRUE original
        # left behind by an earlier --only run that was killed hard enough to
        # skip even the finally sweep (kill -9, power loss, OOM). Only a human
        # can tell which of the two files is real, so validate every
        # requested shot BEFORE moving anything — same ordering rule as the
        # unknown-id check above, so a conflict aborts cleanly with nothing
        # half-moved.
        conflicts = [(s["id"], f"{base}/.{s['id']}.png.bak") for s in shots
                     if os.path.exists(f"{base}/.{s['id']}.png.bak")]
        if conflicts:
            listing = "; ".join(f"{sid} -> {bak}" for sid, bak in conflicts)
            sys.exit(
                "refusing to run --only: found pre-existing backup file(s) "
                f"not made by this run — {listing}. A previous --only run "
                "may have been interrupted before it could restore the "
                "original. Inspect each .bak by hand, then either restore it "
                "over the current PNG or delete it, before re-running.")
        for s in shots:
            p = f"{base}/{s['id']}.png"
            if os.path.exists(p):
                bak = f"{base}/.{s['id']}.png.bak"
                os.replace(p, bak)
                backups[s["id"]] = bak

    counter, results = {"calls": 0}, {}
    rc = 1
    try:
        for pos, s in enumerate(shots, 1):
            sid = s["id"]
            # One unit of work per shot, reported before the work rather than after, because a
            # single shot can run three attempts and several minutes.
            sc.progress(pos, len(shots), "shots")
            out = f"{base}/{sid}.png"
            if os.path.exists(out):
                results[sid] = "SKIPPED-exists"
            else:
                imgs, identities, missing = assemble_refs(s, bible)
                if missing:
                    results[sid] = f"SKIPPED-no-ref ({','.join(missing)})"
                else:
                    state, fb = "FAILED-AUDIT", notes
                    for attempt in range(1, MAX_ATTEMPTS + 1):
                        ret = nb.generate_image(
                            compose_prompt(s, identities, style_constants, fb),
                            imgs, out, counter)
                        if ret == "refused":
                            state = "REFUSED"; break
                        if ret.startswith("error:"):
                            state = f"ERROR ({ret})"; break   # transport dead, not a content refusal
                        if no_audit:
                            state = f"OK attempt-{attempt} (unaudited)"; break
                        ok, audit_notes = audit_image(s, out, audit_laws, show_name)
                        if ok:
                            state = f"OK attempt-{attempt}"; break
                        # Print the rejection AS IT HAPPENS — previously this
                        # was silent, so an operator watching a run burn all
                        # 3 attempts (and the cost cap, across many shots) had
                        # no idea which canon law was failing, or that the
                        # "unparseable" verdicts were really an auth/config
                        # problem in the `claude` binary rather than the image.
                        print(f"    attempt-{attempt} REJECTED: {audit_notes}")
                        # merge, don't clobber: the operator's --notes must survive every retry
                        fb = f"{notes}. {audit_notes}" if notes else audit_notes
                        if attempt < MAX_ATTEMPTS and os.path.exists(out):
                            os.remove(out)             # keep only the LAST candidate
                    results[sid] = state

                # resolve this shot's --only backup now, while we know its outcome
                if sid in backups:
                    bak = backups.pop(sid)
                    if results[sid].startswith("OK"):
                        os.remove(bak)                 # regeneration succeeded: drop the backup
                        # Say so. The restore path below has always announced
                        # itself, so silence here read as "did it take?" to the
                        # showrunner watching the console's streamed log — the
                        # one place the kept-vs-restored outcome actually gets
                        # decided. Symmetry is the whole point.
                        results[sid] += " (new image kept)"
                    else:
                        os.replace(bak, out)           # preserve the human's work over any candidate
                        results[sid] += " (original restored)"
    finally:
        # any backup still outstanding here means the run stopped before that
        # shot was resolved (e.g. the cost-cap SystemExit) — restore it so a
        # hand-made image is never left missing.
        for sid, bak in list(backups.items()):
            os.replace(bak, f"{base}/{sid}.png")
            backups.pop(sid, None)

        for sid, st in results.items():
            print(f"  {sid}  {st}")
        print(f"  api calls: {counter['calls']}  (~${counter['calls'] * 0.134:.2f})")

        ok_n = sum(1 for v in results.values() if v.startswith("OK"))
        active = [k for k, v in results.items() if v != "SKIPPED-exists"]
        if not active:
            tag = "NANO_OK"                           # nothing to do = success
            print(tag)
        else:
            tag = "NANO_OK" if ok_n == len(active) else "NANO_PARTIAL"
            print(f"{tag} {ok_n}/{len(active)}")
        rc = exit_code_for(tag)

    return rc


def main():
    usage = ("usage: nano-banana-generate.py <episode> [--only id,id] [--notes t] "
             "[--no-audit] [--show-root <path>]")
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else. The root is absolute before load(), so a
    # relative --show-root means one directory to the config and to every path after the chdir.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    args = sys.argv[1:]
    if not args:
        sys.exit(usage)
    ep, only, notes, no_audit = args[0], None, "", False
    i = 1
    while i < len(args):
        if args[i] == "--only":
            if i + 1 >= len(args):
                sys.exit(usage)
            only = args[i + 1].split(","); i += 2
        elif args[i] == "--notes":
            if i + 1 >= len(args):
                sys.exit(usage)
            notes = args[i + 1]; i += 2
        elif args[i] == "--no-audit":
            no_audit = True; i += 1
        else:
            sys.exit(f"unknown flag {args[i]}")
    sys.exit(run(ep, cfg, root, only, notes, no_audit))


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"nano-banana-generate: {err}")
