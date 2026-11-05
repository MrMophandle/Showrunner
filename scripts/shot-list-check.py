# /// script
# dependencies = []
# ///
"""shot-list-check: the law of the shot list (spec 2026-11-04 §2.5).

One establishing shot per scene header of the script, ids `s<n>-establishing` in header order,
`scene` equal to the header; an establishing brief names no character of the cast index, no
creature and no species; a character shot has refs, each a cast-index key with a reference image
on disk; no shot carries the deleted renderer's `prompt`/`seed` keys.

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


def check(script: str, shots: list[dict], index: dict, root: str, on_judged=None) -> list[tuple[str, str]]:
    """-> [(shot id, reason)], empty when the list obeys every rule."""
    headers = scene_headers(script)
    bad: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    establishing_by_scene: dict[str, list[dict]] = {}
    for pos, s in enumerate(shots, 1):
        sid = str(s.get("id", "?"))
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
            establishing_by_scene.setdefault(scene, []).append(s)
            if "refs" in s:
                bad.append((sid, f"{sid}: an establishing shot carries no refs"))
            for name, key, kind in names_in(str(s.get("brief", "")), index):
                what = f"names {name} (species, cast key {key})" if kind == "species" else f"names {name} (cast key {key})"
                bad.append((sid, f"{sid}: {what}"))
        else:
            refs = s.get("refs")
            if not isinstance(refs, list) or not refs:
                bad.append((sid, f"{sid}: a character shot with no refs"))
            else:
                for ref in refs:
                    entry = index["cast"].get(str(ref))
                    face = (entry or {}).get("face") or {}
                    ref_path = face.get("ref") if isinstance(face, dict) else None
                    if entry is None:
                        bad.append((sid, f"{sid}: ref {ref} is not a cast-index key"))
                    elif not isinstance(ref_path, str) or not os.path.exists(os.path.join(root, ref_path)):
                        bad.append((sid, f"{sid}: ref {ref} has no reference image (cast the face, or set source to showrunner)"))
        if on_judged is not None:
            on_judged(pos, len(shots))
    for n, header in enumerate(headers, 1):
        expected = f"s{n}-establishing"
        got = establishing_by_scene.get(header, [])
        if not got:
            bad.append((expected, f"{header}: no establishing shot (expected {expected})"))
            continue
        first, *rest = got
        if str(first.get("id")) != expected:
            bad.append((str(first.get("id")), f"{first.get('id')}: the establishing shot of {header} is {expected}"))
        for extra in rest:
            bad.append((str(extra.get("id")), f"{extra.get('id')}: a second establishing shot for {header}"))
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
