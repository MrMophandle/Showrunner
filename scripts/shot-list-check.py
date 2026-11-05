# /// script
# dependencies = []
# ///
"""shot-list-check: the law of the shot list (spec 2026-11-04 §2.5).

For every scene header of the script, the shot `s<n>-establishing` exists, is of type
`establishing` and names that header (rule 1). A further shot in a scene, of either type, is
allowed under any other id: Ryan adds shots to a scene and the lint does not refuse them (spec
2026-11-04 §2.1 and §2.5 rule 1, as amended on 2026-11-04 after the whole-branch review). A
character shot has refs, each a cast-index key, and each key's entry has a reference image on disk
unless the shot's `source` is `showrunner` — a shot Ryan makes by hand is never face-checked (rule
3, amended the same day). No shot carries the deleted renderer's `prompt`/`seed` keys.

An establishing brief names no PERSON of the cast index — no entry of kind `character`, `human`,
`creature` or `species` — and it MAY name the place it establishes, because an establishing shot
of a harbor has to be allowed to say "Harbor" (spec 2026-11-04 §2.5 rule 2, as amended on
2026-11-04 after this script's review). A place the brief names that has a reference image on disk must also be in
the shot's `refs`, so the render conditions on that place's own look rather than inventing one;
`refs` on an establishing shot may hold nothing but such places.

It took over on 2026-11-04 from the guard spec 2026-11-04 §2.5 says it replaces, and keeps that
guard's result contract: `--report-only` prints the reasons and ends with
`SHOTS_BAD <n> shots: <ids> — <reasons>` exiting 0 (the fix agent reads that line as the step's
result and reads nothing else, which is why the reasons ride on it as well as on stderr); without
the flag a bad list exits 2; a good list ends with `SHOTS_OK <n> shots`.

Usage: shot-list-check.py <episode> [--report-only] [--show-root <path>]
"""
import json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import castindex
from lib import showconfig as sc

DIRTY = 2
HEADER = re.compile(r"^## +(.+?)\s*$", re.M)
LOCAL_KEYS = ("prompt", "seed")
# The kinds an establishing brief may not name, and that an establishing `refs` may not hold; every
# other kind is a place (spec 2026-11-04 §2.5 rule 2, as amended on 2026-11-04).
PERSON_KINDS = ("character", "human", "creature", "species")


def scene_headers(script: str) -> list[str]:
    """The scene headers in order: the cold open is scene 1."""
    return [m.group(1) for m in HEADER.finditer(script)]


def _word_pattern(name: str) -> re.Pattern:
    bare = re.sub(r"^the\s+", "", name.strip(), flags=re.I)
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(bare) + r"(?![A-Za-z0-9])", re.I)


def names_in(brief: str, index: dict) -> list[tuple[str, str, str]]:
    """-> [(display name, key, kind)] for every cast entry the brief names, whole word, `the` stripped."""
    hits = []
    for key, entry in index["cast"].items():
        name = str(entry.get("name") or key)
        if _word_pattern(name).search(brief) or _word_pattern(key.replace("-", " ")).search(brief):
            hits.append((name, key, str(entry.get("kind", ""))))
    return hits


def _face_on_disk(entry: dict | None, root: str) -> bool:
    """True when the entry names a `face.ref` and that file is on disk — the one thing a ref is for.

    An entry can outlive the image it names, so the file is checked and not just the field; both
    the establishing branch and the character branch ask this question, and they must agree.
    """
    face = (entry or {}).get("face") or {}
    ref_path = face.get("ref") if isinstance(face, dict) else None
    return isinstance(ref_path, str) and os.path.exists(os.path.join(root, ref_path))


def check(script: str, shots: list[dict], index: dict, root: str, on_judged=None) -> list[tuple[str, str]]:
    """-> [(shot id, reason)], empty when the list obeys every rule."""
    headers = scene_headers(script)
    bad: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    for pos, s in enumerate(shots, 1):
        sid = str(s.get("id", "?"))
        # Rule 3 as amended 2026-11-04 (spec 2026-11-04 §2.5): a shot whose `source` is
        # `showrunner` is Ryan's to make by hand, and nothing in the pipeline renders it — the
        # renderer skips it by source (nano-banana-generate.py) and the sheet waits for its PNG.
        # Its refs are still checked for being cast-index keys, because the sheet and a later
        # reader resolve them, but a `face.ref` on disk is a demand only a render can have, so
        # asking for one here printed a remedy ("set source to showrunner") that could not be
        # followed.
        by_hand = s.get("source") == "showrunner"
        if sid in seen_ids:
            bad.append((sid, f"{sid}: duplicate id"))
        seen_ids.add(sid)
        present = [k for k in LOCAL_KEYS if k in s]
        if present:
            bad.append((sid, f"{sid}: has {', '.join(present)} — the local renderer is gone; write a brief"))
        if s.get("type") not in ("establishing", "character"):
            bad.append((sid, f"{sid}: type {s.get('type')!r} is not establishing or character"))
        if s.get("source", "pipeline") not in ("pipeline", "showrunner"):
            bad.append((sid, f"{sid}: source {s.get('source')!r} is not pipeline or showrunner"))
        if not isinstance(s.get("brief"), str) or not s["brief"].strip():
            bad.append((sid, f"{sid}: no brief"))
        scene = str(s.get("scene", ""))
        if scene not in headers:
            bad.append((sid, f"{sid}: the script has no scene {scene}"))
        if s.get("type") == "establishing":
            ref_keys = [str(r) for r in s.get("refs", [])] if isinstance(s.get("refs"), list) else []
            for name, key, kind in names_in(str(s.get("brief", "")), index):
                if kind in PERSON_KINDS:
                    what = f"names {name} (species, cast key {key})" if kind == "species" else f"names {name} (cast key {key})"
                    bad.append((sid, f"{sid}: {what}"))
                elif _face_on_disk(index["cast"].get(key), root) and key not in ref_keys:
                    # A place with a reference image is a place the show has already decided the
                    # look of; naming it without the ref asks the model to invent a second one.
                    bad.append((sid, f"{sid}: names {name} ({kind}, cast key {key}) — "
                                     f"add it to refs so the render conditions on its reference"))
            for ref in ref_keys:
                entry = index["cast"].get(ref)
                kind = str((entry or {}).get("kind", ""))
                if entry is None:
                    bad.append((sid, f"{sid}: ref {ref} is not a cast-index key"))
                elif kind in PERSON_KINDS:
                    bad.append((sid, f"{sid}: ref {ref} is a {kind} — a person never appears in an establishing shot"))
                elif not by_hand and not _face_on_disk(entry, root):
                    bad.append((sid, f"{sid}: ref {ref} has no reference image (cast the face, or set source to showrunner)"))
        else:
            refs = s.get("refs")
            if not isinstance(refs, list) or not refs:
                bad.append((sid, f"{sid}: a character shot with no refs"))
            else:
                for ref in refs:
                    entry = index["cast"].get(str(ref))
                    if entry is None:
                        bad.append((sid, f"{sid}: ref {ref} is not a cast-index key"))
                    elif not by_hand and not _face_on_disk(entry, root):
                        bad.append((sid, f"{sid}: ref {ref} has no reference image (cast the face, or set source to showrunner)"))
        if on_judged is not None:
            on_judged(pos, len(shots))
    # Rule 1 (spec 2026-11-04 §2.5, as amended on 2026-11-04 after the whole-branch review): the
    # engine owes each header one shot, under the id `s<n>-establishing`, of type `establishing`,
    # naming that header. Shots under other ids are Ryan's additions (§2.1, §2.4) and are judged
    # only by the rules above — a second `establishing` shot in a scene is legal, and the lint has
    # no reason for it.
    by_id: dict[str, dict] = {}
    for s in shots:
        by_id.setdefault(str(s.get("id", "?")), s)
    for n, header in enumerate(headers, 1):
        expected = f"s{n}-establishing"
        engine_shot = by_id.get(expected)
        if engine_shot is None or str(engine_shot.get("scene", "")) != header:
            # Either no shot carries the engine's id for this header, or the shot that carries it
            # names another scene; either way this header has no establishing shot of its own.
            bad.append((expected, f"{header}: no establishing shot (expected {expected})"))
        elif engine_shot.get("type") != "establishing":
            bad.append((expected, f"{expected}: the engine's shot of {header} must be type establishing"))
    return bad


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    report_only = "--report-only" in sys.argv
    if report_only:
        sys.argv.remove("--report-only")
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("shot-list-check: episode id missing (usage: shot-list-check.py <episode> [--report-only] [--show-root <path>])")
    prod = sc.production_dir(cfg)
    # `episodesDir` is optional and defaults to "Episodes", the default engine/src/show-config.ts
    # records for the key; canon-ledger.py:66 reads it the same way.
    episodes = str(sc.value(cfg, "episodesDir", default="Episodes"))
    prompts_path = f"{prod}/{ep}/images/prompts.json"
    with open(prompts_path, encoding="utf-8") as fh:
        doc = json.load(fh)
    with open(f"{episodes}/{ep}/script.md", encoding="utf-8") as fh:
        script = fh.read()
    index = castindex.load(cfg, root)
    shots = doc.get("shots", [])
    bad = check(script, shots, index, root, on_judged=lambda done, total: sc.progress(done, total, "shots"))
    if bad:
        ids = []
        for sid, _ in bad:
            if sid not in ids:
                ids.append(sid)
        print(f"SHOT LIST BROKEN in {prompts_path}: {len(bad)} reason(s)", file=sys.stderr)
        for _, reason in bad:
            print("  " + reason, file=sys.stderr)
        if report_only:
            # The ids AND the reasons, because the step's result is the one line the fix agent
            # reads: the ids tell it which shots to repair, the reasons tell it what to repair.
            print(f"SHOTS_BAD {len(ids)} shots: {', '.join(ids)} — "
                  + "; ".join(reason for _, reason in bad))
            return
        sys.exit(DIRTY)
    print(f"SHOTS_OK {len(shots)} shots")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"shot-list-check: {err}")
