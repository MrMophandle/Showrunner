# /// script
# dependencies = ["google-genai", "pillow"]
# ///
"""nano-banana-generate: character shots via the Gemini API (Nano Banana Pro).

For each type:"character" shot in Production/<ep>/images/prompts.json missing
its PNG: condition on the subject's locked reference sheet + the 2 newest
approved pile stills (the show's visual.castingPileDir), generate at 2K 16:9,
vision-audit via Claude headless, retry with corrective notes (<=3 attempts). A
shot whose PNG exists is skipped — a hand-made shot always wins (delete a PNG or
use --only to re-roll). A shot whose `source` is `showrunner` is never generated;
the showrunner drops it in.

Everything that makes a frame THIS show's frame comes from the show's config and
canon, never from this file: the reference index (visual.refs), the photographic
look (visual.styleConstants), the audit laws (the file at visual.auditLaws), the
style authority cited in a refusal (visual.style), and the banned collective
phrases (visual.collectivePopulatorBans, read by lib/populators.py).

Usage:
  nano-banana-generate.py <episode> [--only id,id] [--notes "text"] [--no-audit]
                                    [--show-root <path>]
"""
import base64, json, os, re, subprocess, sys, tempfile, time

from lib import populators
from lib import showconfig as sc

MODEL = "gemini-3-pro-image"          # Nano Banana Pro (verified live docs, Task 2)
ASPECT_RATIO = "16:9"                  # response_format: cinematic frame
IMAGE_SIZE = "2K"                      # response_format: uppercase K per docs
# The docs list image/png as valid, but the live validator rejects it with a
# hard 400 naming image/jpeg as the ONLY supported value (ep04 pilot,
# 2026-07-27). The API is ground truth. We request JPEG and transcode to PNG on
# the way out — see _jpeg_to_png. Do not "fix" this back to image/png.
OUTPUT_MIME = "image/jpeg"
MAX_ATTEMPTS = 3                       # audit-failure retries per shot
MAX_CALLS = 60                         # hard cost cap per run (~$8)
STILLS_PER_SUBJECT = 2                 # newest pile stills fed per character
MAX_IMAGES = 8                         # total reference images per API call

# The show's photographic look is visual.styleConstants in showrunner.json, appended to every
# brief by compose_prompt. One standing warning for whoever edits that key: do NOT put
# "Cinematic 16:9 frame" in it. The aspect ratio is set properly via the API's
# response_format.aspect_ratio, and saying "cinematic frame" in the prompt made the model PAINT
# letterbox bars into the picture as a style choice (ep04 pilot: 24px top / 189px bottom baked
# in). A full-bleed sentence is what belongs there instead.

KEY_SETUP = """GEMINI_API_KEY is not set. One-time setup (5 min):
  1. https://aistudio.google.com/apikey -> Create API key (enable billing on the
     project: paid tier = no visible watermark + real rate limits).
  2. Add to ~/.zshenv:  export GEMINI_API_KEY="<key>"
  3. Open a new terminal (or `source ~/.zshenv`) and re-run."""


def normalize_key(ref: str) -> str:
    """A ref string to its bible key: 'Mara' -> 'mara'; 'relic (style-token...)' -> 'relic'."""
    return re.split(r"[\s(]", ref.strip(), 1)[0].lower()


def load_bible(path: str) -> dict:
    """The show's reference index (visual.refs), minus its own metadata keys."""
    d = json.load(open(path))
    return {k: v for k, v in d.items() if not k.startswith("_")}


def _pile_stills(sheet_path: str) -> list[str]:
    """Newest-first approved stills from the character's folder (sheet excluded)."""
    folder = os.path.dirname(sheet_path)
    pngs = [os.path.join(folder, f) for f in os.listdir(folder)
            if f.endswith(".png") and os.path.join(folder, f) != sheet_path]
    return sorted(pngs, key=os.path.getmtime, reverse=True)[:STILLS_PER_SUBJECT]


def assemble_refs(shot: dict, bible: dict, max_images: int = MAX_IMAGES):
    """-> (image_paths, identity_lines, missing_keys). Sheets first; stills
    dropped (never sheets) to respect max_images. Dedupes by normalized key."""
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
        stills.extend(_pile_stills(entry["ref"]))

    # Extract sheet paths and dedupe stills BY BASENAME, not full path.
    # registry-append fans one group shot out into every ref'd character's
    # folder, so the identical still lives at N different paths (one per
    # subject). Deduping by path lets all N copies survive here, burning
    # reference-image slots on N copies of one photo and displacing a
    # genuinely distinct still of another subject — worse conditioning for
    # the same $ cost. Keep the first occurrence, preserve order.
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
    """The brief the model is given: who is in frame, what happens, and the show's look."""
    parts = list(identity_lines) + [shot["brief"], style_constants]
    if notes:
        parts.append(f"PREVIOUS ATTEMPT REJECTED: {notes}. Fix exactly this.")
    return "\n\n".join(parts)


def _redact(text) -> str:
    """Strip the API key out of anything we return, print or log.

    Some Google transports carry the key as a ?key= query param, so an
    exception's str() can embed it — and these strings get printed by the
    orchestrator. Never let one reach a log."""
    s = str(text)
    key = os.environ.get("GEMINI_API_KEY")
    return s.replace(key, "<redacted>") if key else s


def _client():
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit(KEY_SETUP)
    from google import genai
    return genai.Client()                        # reads GEMINI_API_KEY


def _encode_refs(image_paths: list[str]) -> list[dict]:
    """Read + b64-encode the reference images. Local I/O only — NO network.

    Kept out of _api_call so a local failure (a ref deleted between assembly
    and generation) can't burn a call against the cost cap."""
    parts = []
    for p in image_paths:
        with open(p, "rb") as f:
            parts.append({"type": "image",
                          "data": base64.b64encode(f.read()).decode(),
                          "mime_type": "image/png"})
    return parts


def _jpeg_to_png(data: bytes) -> bytes:
    """Transcode the API's JPEG output to PNG bytes.

    The model will only emit image/jpeg, but the entire pipeline addresses a
    shot as <shot-id>.png — prompts.json ids, image-audit, registry-append,
    build-timeline, the Remotion render, IMAGE-SHEET.md. Converting at this one
    boundary keeps every consumer unchanged. No extra quality loss: the server
    already did the only lossy step."""
    from io import BytesIO
    from PIL import Image
    buf = BytesIO()
    Image.open(BytesIO(data)).convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


# Deterministic failures: the request itself is wrong, so every retry produces
# the identical 4xx while still billing a call against MAX_CALLS.
CLIENT_ERROR_TOKENS = ("invalid_request", "invalid_argument", "permission_denied",
                       "unauthenticated", "not_found", "api key not valid")


def _is_client_error(exc) -> bool:
    """True for a deterministic 4xx (malformed request / auth / not found).

    Retrying one can never succeed: the ep04 pilot burned 3 of 60 budgeted
    calls re-sending the same rejected payload. 5xx and raw network faults are
    NOT client errors — those keep their exponential-backoff retries."""
    for attr in ("status_code", "code", "status"):
        v = getattr(exc, attr, None)
        if isinstance(v, int) and 400 <= v < 500:
            return True
    v = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(v, int) and 400 <= v < 500:
        return True
    s = str(exc).lower()
    if re.search(r"error code: 4\d\d\b", s):
        return True
    return any(tok in s for tok in CLIENT_ERROR_TOKENS)


def _refusal_diagnostic(interaction) -> str:
    """One line describing an output-less response, so the first live run can
    confirm the real safety-block shape (the docs never showed one). Shape
    only — type + attribute names, never the payload."""
    attrs = ", ".join(sorted(a for a in dir(interaction)
                             if not a.startswith("_")))
    return _redact(f"REFUSED (no output_image): response type="
                   f"{type(interaction).__name__} attrs=[{attrs}]")


def _write_atomic(out_path: str, data: bytes) -> None:
    """Write via temp file + os.replace so out_path only ever exists complete.

    The pipeline skips any shot whose PNG exists; a half-written file would be
    silently treated as finished and could ship in an episode."""
    folder = os.path.dirname(os.path.abspath(out_path))
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".nbg-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)                     # mkstemp makes 0600; os.replace
                                                 # keeps it. Every other image in
                                                 # the folder is 0644 — match it.
        os.replace(tmp, out_path)                # atomic within a filesystem
    except Exception:
        try:
            os.unlink(tmp)                       # never leave a stray temp
        except OSError:
            pass
        raise


def _api_call(prompt: str, image_parts: list[dict]):
    """One Gemini call. -> ('ok', png_bytes) | ('refused', None).

    Requests JPEG (the only mime_type this model accepts) and returns PNG bytes
    so callers — and the files on disk — stay PNG throughout.

    Takes ALREADY-ENCODED image parts (see _encode_refs) so this function is
    purely network. Raises on transport errors (caller retries). EXACT call
    shape per the Interactions API documented at
    https://ai.google.dev/gemini-api/docs/image-generation (verified Task 2,
    Step 1) — adjust here only.
    """
    client = _client()
    content = [{"type": "text", "text": prompt}] + list(image_parts)
    interaction = client.interactions.create(
        model=MODEL,
        input=content,
        response_format={"type": "image", "mime_type": OUTPUT_MIME,
                         "aspect_ratio": ASPECT_RATIO, "image_size": IMAGE_SIZE},
    )
    img = getattr(interaction, "output_image", None)
    if img is None or not getattr(img, "data", None):
        print(_refusal_diagnostic(interaction))  # safety decline / empty output
        return ("refused", None)
    return ("ok", _jpeg_to_png(base64.b64decode(img.data)))


def generate_image(prompt, image_paths, out_path, call_counter):
    """-> 'ok' | 'refused' | 'error:<msg>'. Writes out_path only on 'ok'."""
    if call_counter["calls"] >= MAX_CALLS:
        sys.exit(f"COST CAP: {MAX_CALLS} API calls reached — aborting. "
                 f"Re-run to continue (idempotent).")
    try:
        image_parts = _encode_refs(image_paths)   # local: must not bill a call
    except Exception as e:
        return f"error:{_redact(e)}"

    last = None
    for attempt in range(3):                      # transport retries
        try:
            call_counter["calls"] += 1            # an API call is now happening
            status, data = _api_call(prompt, image_parts)
        except SystemExit:
            raise
        except Exception as e:                    # network/5xx/etc
            last = e
            if _is_client_error(e):               # 4xx: identical every time
                return f"error:{_redact(e)}"      # fail fast, bill exactly one
            time.sleep(2 ** attempt)
            continue
        if status == "refused":
            return "refused"
        # The paid call already succeeded — that's billed no matter what
        # happens next. A LOCAL write failure (full/read-only volume) can't
        # possibly turn out differently on retry, so it must not re-enter this
        # loop and bill two more calls for the same zero output.
        try:
            _write_atomic(out_path, data)
        except Exception as e:
            return f"error:{_redact(e)}"
        return "ok"
    return f"error:{_redact(last)}"


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


def check_no_collective_populators(shots: list[dict], phrases, style_path: str) -> None:
    """Pre-flight law enforcement (showrunner-ruled after one shot's extras incident):
    a brief with a collective populator ("the crew", "a few figures", ...)
    makes the model invent uncredited extras — wrong headcount, and once a
    real-world flag patch on an invented figure. This must run BEFORE the
    .bak backup step and before any API call: nothing generated, nothing
    backed up, nothing spent, on ANY violation in the in-scope shot list.

    The banned phrases are the show's (visual.collectivePopulatorBans) and the
    authority named in the refusal is the show's style document (visual.style);
    the grammar that reads them lives in lib/populators.py."""
    found = populators.violations(shots, phrases)
    if not found:
        return
    sys.exit(
        "COLLECTIVE POPULATOR(S) in character brief(s) — refusing to spend "
        f"({style_path}, visual.collectivePopulatorBans):\n"
        + "\n".join(populators.report_lines(found)) + "\n"
        "Every person in frame must be named and present in refs — "
        "name them or cap the headcount, then re-run."
    )


def exit_code_for(tag: str) -> int:
    """The process exit code for a run's NANO_* tag.

    NANO_PARTIAL exits 0, not 1. The tag is this step's RESULT, and the nano-banana gate after it
    shows the partial batch to the showrunner, who decides whether it is good enough; a non-zero
    exit would fail the step first and the gate would never open to ask. This is the rule the
    bash node that preceded the engine enforced with `grep -qE 'NANO_(OK|PARTIAL)'` over the
    captured output — a run that printed no tag at all is the only failure.
    """
    return 0 if tag in ("NANO_OK", "NANO_PARTIAL") else 1


def run(ep, cfg, root, only=None, notes="", no_audit=False):
    """Generate every missing character shot for one episode. `cfg` is the show's config and
    `root` its absolute directory, from which every show path in the config is resolved."""
    # Everything the SHOW decides about a frame, read once: where its reference index lives, how
    # its photography reads, which laws the audit applies, which document a refusal cites, and
    # which collective phrases are banned in a brief.
    bible_path = sc.path(cfg, "visual", "refs", root=root)
    style_constants = str(sc.value(cfg, "visual", "styleConstants"))
    audit_laws = load_audit_laws(sc.path(cfg, "visual", "auditLaws", root=root))
    style_path = str(sc.value(cfg, "visual", "style"))
    bans = list(sc.value(cfg, "visual", "collectivePopulatorBans"))
    show_name = str(sc.value(cfg, "showName"))
    prod = sc.production_dir(cfg)

    base = f"{prod}/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    bible = load_bible(bible_path)
    # A character shot whose `source` is "showrunner" is the showrunner's to make by hand, so it
    # never enters `shots`: no API call is spent on it, no audit judges it, and it takes no result
    # row. The engine's `showrunner-images` guard is what holds the line until its PNG is on disk.
    shots = [s for s in doc["shots"] if s.get("type") == "character"
             and s.get("source", "pipeline") != "showrunner"]
    by_hand = [str(s.get("id", "?")) for s in doc["shots"]
               if s.get("type") == "character" and s.get("source", "pipeline") == "showrunner"]
    if by_hand:
        # Say it. Silence reads as loss: a run that generates two of five character shots and
        # says nothing about the other three looks like a run that dropped them.
        print(f"  {len(by_hand)} showrunner-made shot(s) left alone: {', '.join(by_hand)}")

    if only:
        valid_ids = {s["id"] for s in shots}
        unknown = [oid for oid in only if oid not in valid_ids]
        if unknown:                                   # validate BEFORE touching anything
            sys.exit(f"unknown --only id(s): {', '.join(unknown)}. "
                     f"Valid character-shot ids: {', '.join(sorted(valid_ids)) or '(none)'}")
        shots = [s for s in shots if s["id"] in only]

    # Mechanical pre-flight: fail the whole run before any money is spent if
    # ANY in-scope shot's brief has a collective populator. Must run before
    # the .bak backup step and before any API call (showrunner ruling, after a brief that
    # said "the crew" put an uncredited figure in a paid frame).
    check_no_collective_populators(shots, bans, style_path)

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
                        ret = generate_image(
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
