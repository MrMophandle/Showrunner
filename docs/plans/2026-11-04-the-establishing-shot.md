# The Establishing Shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine makes one establishing shot per scene, every image is rendered by nano-banana, and the local image renderer with its populator loop and second image gate is removed.

**Architecture:** The Gemini client leaves `nano-banana-generate.py` for a shared library so the episode renderer and the face designer use one client; the renderer renders every pipeline shot, with or without reference images; a lint (`shot-list-check.py`) replaces the populator check and carries the face requirement the probe drops; the pipeline's image stage becomes lint → render → audit loop → sheet → one gate → guard; templates, scaffold, console and tests follow. The show side (Dead Light) and the s02e01 rerun are the controller's last task.

**Tech Stack:** Engine `@showrunner/engine` (TS strict, NodeNext, vitest 4); scripts (Python 3.11, `uv`, pytest; `google-genai`, `pillow`); tools (`@showrunner/tools`, check-prompts); console (Hono 4 + React 18, vitest + jsdom).

**Spec:** `docs/specs/2026-11-04-the-establishing-shot-design.md` (approved 2026-11-04). It argues from `docs/specs/2026-10-31-the-casting-stop-design.md` §1 (the cast index) and supersedes that spec's face requirement (§7 of the new spec).

**Branch:** `one-shot-per-scene`, stacked on `cast-index` (Showrunner PR #123). The PR for this plan targets `cast-index` until #123 merges, then `main`.

## Global Constraints

- **One establishing shot per scene.** `prompts.json` holds exactly one `type: "establishing"` shot per scene header of the script, id `s<n>-establishing`, `scene` equal to the header text after `## `; the engine never writes a `character` shot (spec §2.1–2.3).
- **Every image is rendered by nano-banana.** No code path renders an image locally; `scripts/image-generate.py`, `scripts/image-qc.py`, `scripts/populator-check.py` and `scripts/lib/populators.py` are deleted (spec §3.4).
- **The purge grep prints nothing at the end of Task 5:** `grep -rniE 'z-image|zimage|mflux|populator|image-generate\.py|nano-banana-gate|ambientPromptScaffold|collectivePopulatorBans|characterKinds|ambient' engine/src engine/test scripts/*.py scripts/lib scripts/tests tools/src tools/templates tools/show-data tools/test console/server console/src console/test --exclude=deadlight-overrides.json`. (`tools/show-data/deadlight-overrides.json` is the Archon port's data for `extract-prompts`, historical, left alone. `docs/` keeps its history.)
- **The show-name grep stays clean:** `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. Fixtures use Harbor Lights: Vale, the Warden, Pim, Maeve, Harbor.
- **The pipeline has 65 steps** after this plan (67 today: `image-generate` and `nano-banana-gate` go; `populator-check`/`populator-check-final` become `shot-list-check`/`shot-list-check-final`). Every test that pins the count moves to 65.
- **The lint's result contract** is the populator check's: `--report-only` prints the reasons and ends with one line `SHOTS_BAD <n> shots: <ids>` exiting 0; without the flag a bad list exits 2; a good list prints `SHOTS_OK <n> shots` as its last line.
- **`refs-ready` demands no face** (spec §7); it demands a LOCKED voice with its WAV for every `speaks` entry, as Plan L1 left it.
- **Suites green at every commit:** `npm run typecheck -w engine && npm test -w engine`; `cd scripts && uv run --group dev pytest -q`; `npm run build -w tools && npm test -w tools && node tools/dist/check-prompts.js --prompts tools/templates/prompts --context tools/show-data/deadlight-check-context.json`; `npm run build -w engine && npm run typecheck -w console && npm test -w console` (the console reads the built engine).
- Commit messages end with exactly one trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Prose follows `~/.claude/CLAUDE.md` (name the actor, complete sentences, anchored references).
- Never dispatch subagents from an implementer; the controller reviews.

---

### Task 1: The shared Gemini client, and a renderer that renders every pipeline shot

**Files:**
- Create: `scripts/lib/nanobanana.py`
- Modify: `scripts/nano-banana-generate.py`
- Delete: `scripts/image-generate.py`, `scripts/image-qc.py`, `scripts/populator-check.py`, `scripts/lib/populators.py`, `scripts/tests/test_populator_check.py`, `scripts/tests/test_populators.py`, `scripts/tests/test_image_qc.py`
- Test: `scripts/tests/test_nanobanana.py` (new), `scripts/tests/test_nano_banana_generate.py` (updated)

**Interfaces:**
- Produces `scripts/lib/nanobanana.py` with these names, moved verbatim from the renderer (behaviour unchanged, underscores dropped): `MODEL`, `MAX_IMAGES`, `KEY_SETUP`, `redact(text) -> str`, `client()`, `encode_refs(image_paths: list[str]) -> list[dict]`, `jpeg_to_png(data: bytes) -> bytes`, `is_client_error(exc) -> bool`, `refusal_diagnostic(interaction) -> str`, `write_atomic(out_path: str, data: bytes) -> None`, `api_call(prompt: str, image_parts: list[dict])`, `generate_image(prompt, image_paths, out_path, call_counter)`. One new constant: `CREDITS_LINE = "Google AI Studio credits are depleted (HTTP 402) — top up at https://ai.studio/projects, then resume the run"`, printed in a shot's status line when the API answers 402.
- The renderer keeps its public names `normalize_key`, `load_bible`, `assemble_refs`, `compose_prompt`, `load_audit_laws`, `audit_image`, `exit_code_for`, `run`, `main`; it imports the client as `from lib import nanobanana as nb` and calls `nb.generate_image`. Tests that monkeypatched `nbg._api_call`, `nbg._client` or `nbg._write_atomic` now patch `nanobanana.api_call` and friends on the library module.
- Consumed by Task 2 (`design-visual.py` imports `nanobanana.generate_image`).

- [ ] **Step 1: Write the failing tests for the library**

`scripts/tests/test_nanobanana.py`:

```python
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import nanobanana as nb


def test_the_library_exposes_the_client_names():
    for name in ("MODEL", "MAX_IMAGES", "KEY_SETUP", "CREDITS_LINE", "redact", "client", "encode_refs",
                 "jpeg_to_png", "is_client_error", "refusal_diagnostic", "write_atomic", "api_call",
                 "generate_image"):
        assert hasattr(nb, name), name


def test_redact_hides_the_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "sk-SECRET-123")
    assert "SECRET" not in nb.redact("failed with key sk-SECRET-123 in the url")


def test_generate_image_writes_png_and_counts(tmp_path, monkeypatch):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    monkeypatch.setattr(nb, "api_call", lambda prompt, parts: ("ok", png))
    out = tmp_path / "s01-establishing.png"
    counter = {"calls": 0}
    status = nb.generate_image("a quay at dawn", [], str(out), counter)
    assert status.startswith("OK")
    assert out.read_bytes() == png
    assert counter["calls"] == 1


def test_a_402_status_names_the_credits_remedy(tmp_path, monkeypatch):
    class Boom(Exception):
        code = 402
    def fail(prompt, parts):
        raise Boom("402 PAYMENT_REQUIRED")
    monkeypatch.setattr(nb, "api_call", fail)
    monkeypatch.setattr(nb, "is_client_error", lambda exc: True)
    status = nb.generate_image("a quay at dawn", [], str(tmp_path / "x.png"), {"calls": 0})
    assert nb.CREDITS_LINE in status
```

The exact `status` strings `generate_image` returns today (`OK …`, `FAILED …`) are kept; read `scripts/nano-banana-generate.py:267-303` before writing the library, and keep the test's expectations to what that code returns. If the 402 case today raises instead of returning a status, make it return `f"FAILED {CREDITS_LINE}"` after the retry policy the function already has for client errors (a 402 is a client error: no retry).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts && uv run --group dev pytest -q tests/test_nanobanana.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'lib.nanobanana'`.

- [ ] **Step 3: Create the library**

Move `scripts/nano-banana-generate.py:30-58` (constants, `KEY_SETUP`), `136-166` (`_redact`, `_client`, `_encode_refs`), `168-303` (`_jpeg_to_png`, `_is_client_error`, `_refusal_diagnostic`, `_write_atomic`, `_api_call`, `generate_image`) into `scripts/lib/nanobanana.py`, dropping the leading underscores on the moved names and updating the calls between them. Add `CREDITS_LINE` and the 402 branch. The module docstring says what it is: "The Gemini image client every image in the show goes through: the episode renderer (`nano-banana-generate.py`) and the face designer (`design-visual.py`). Moved here from the renderer on 2026-11-04 (spec 2026-11-04 §3.1) so there is one client, one retry policy and one remedy line for a depleted balance." Keep every comment that explains a workaround (the `image/jpeg` mime workaround, the atomic write, the redaction) with the code it explains.

- [ ] **Step 4: Rewrite the renderer's selection and drop the populator guard**

In `scripts/nano-banana-generate.py`:
- Replace the moved definitions with `from lib import nanobanana as nb` and call `nb.generate_image(...)`, `nb.KEY_SETUP`, `nb.MAX_IMAGES`.
- Delete `from lib import populators`, `check_no_collective_populators` (lines 382-403), the `bans` read (`sc.value(cfg, "visual", "collectivePopulatorBans")`) and the call in `run`.
- Selection (`run`, lines 435-440): `shots = [s for s in doc["shots"] if s.get("source", "pipeline") != "showrunner"]` and `by_hand = [... if s.get("source", "pipeline") == "showrunner"]`, any type. The `--only` validation message says "Valid shot ids".
- The prompt: `compose_prompt` already takes `identity_lines`; for a shot with no `refs`, `assemble_refs` returns no paths and no identities, so the prompt is the brief plus the style constants. Add one line to `compose_prompt`'s docstring saying so, and one assertion-free test (Step 5).
- The docstring at the top (lines 1-23): rewrite for "every pipeline shot of an episode, establishing shots from their brief alone and character shots conditioned on the reference and gallery of each ref".
- The 402 status: where `run` prints a shot's status, nothing changes; the library returns the remedy in the status.

- [ ] **Step 5: Update the renderer's tests**

In `scripts/tests/test_nano_banana_generate.py`: repoint every monkeypatch of a moved name to the library (`monkeypatch.setattr(nb, "api_call", ...)`, where `nb` is `from lib import nanobanana as nb`); delete the tests of `check_no_collective_populators` and the populator pre-flight (grep `populator` in the file); add:

```python
def test_run_renders_an_establishing_shot_from_its_brief_alone(tmp_path, monkeypatch, capsys):
    # an episode with one establishing shot and no refs: one call, prompt = brief + style constants, no images
    ...  # build the fixture the file's other run tests build (see test_run_states_and_partial), with
         # {"id": "s01-establishing", "scene": "COLD OPEN", "type": "establishing", "source": "pipeline", "brief": "the quay at dawn"}
    seen = {}
    def fake(prompt, parts):
        seen["prompt"], seen["parts"] = prompt, parts
        return ("ok", PNG)
    monkeypatch.setattr(nb, "api_call", fake)
    ...
    assert seen["parts"] == []
    assert seen["prompt"].startswith("the quay at dawn")
    assert "no text, no watermark" in seen["prompt"]      # the style constants of the fixture config
    assert "NANO_OK 1/1" in capsys.readouterr().out


def test_run_leaves_a_showrunner_made_establishing_shot_alone(tmp_path, monkeypatch, capsys):
    ...  # one establishing shot with source "showrunner": zero calls, the "left alone" line names it
```

- [ ] **Step 6: Delete the local renderer and its tests**

`git rm scripts/image-generate.py scripts/image-qc.py scripts/populator-check.py scripts/lib/populators.py scripts/tests/test_populator_check.py scripts/tests/test_populators.py scripts/tests/test_image_qc.py`. Then `grep -rniE 'populator|image-generate|image_qc|z-image|mflux' scripts/*.py scripts/lib scripts/tests` and remove every remaining mention (docstrings, comments, the `pyproject.toml` dependency comment block at lines 9-13 if it names a deleted script).

- [ ] **Step 7: Run the scripts suite**

Run: `cd scripts && uv run --group dev pytest -q`
Expected: all passing; the count is lower than 342 by the deleted tests and higher by the new ones.

- [ ] **Step 8: Commit**

```bash
git add -A scripts
git commit -m "scripts: one Gemini client in lib/nanobanana.py, and the renderer renders every pipeline shot — the local renderer and the populator guard are gone"
```

---

### Task 2: The lint, the sheet, and the face designer on nano-banana

**Files:**
- Create: `scripts/shot-list-check.py`, `scripts/tests/test_shot_list_check.py`, `scripts/tests/test_design_visual.py`
- Modify: `scripts/image-sheet.py`, `scripts/tests/test_image_sheet.py`, `scripts/design-visual.py`

**Interfaces:**
- Consumes `lib/nanobanana.generate_image` (Task 1), `lib/castindex.load`, `lib/showconfig` (`show_root`, `load`, `production_dir`, `episodes_dir` if it exists — else `sc.value(cfg, "episodesDir")`, `progress`).
- Produces `shot-list-check.py <episode> [--report-only] [--show-root <path>]` with the result contract in Global Constraints; `image-sheet.py` printing one list and `SHEET_OK <n> shots (<k> by hand, <m> missing)` last; `design-visual.py <key> --briefs <file> [--show-root <path>]`.
- The engine (Task 3) runs `shot-list-check.py` and reads its last line.

- [ ] **Step 1: Write the failing tests for the lint**

`scripts/tests/test_shot_list_check.py` (fixtures in the style of `test_populator_check.py`, which Task 1 deleted — read its git history with `git show cast-index:scripts/tests/test_populator_check.py` for the show-root fixture pattern):

```python
import json, os, subprocess, sys
from pathlib import Path
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "shot-list-check.py"
SCRIPT_TEXT = "## COLD OPEN\n\nVale woke.\n\n## SCENE TWO — THE QUAY\n\nThe quay.\n\n## SCENE THREE — THE LAMP ROOM\n\nThe lamp.\n"
INDEX = {"version": 1, "audio": {"engine": "qwen3"}, "cast": {
    "vale": {"name": "Vale", "kind": "human", "speaks": True, "debut": "s01e01",
             "face": {"ref": "Canon/characters/Vale/reference.png", "gallery": [], "locked": "test"}},
    "the-warden": {"name": "the Warden", "kind": "human", "speaks": True, "debut": "s01e01"},
    "gull-folk": {"name": "Gull-folk", "kind": "species", "speaks": False, "debut": "s01e01"},
}}


@pytest.fixture
def show(tmp_path: Path) -> Path:
    (tmp_path / "showrunner.json").write_text(json.dumps({
        "showName": "Harbor Lights", "canonDir": "Canon", "episodesDir": "Episodes", "productionDir": "Production",
        "cast": {"index": "Canon/cast.json"}, "visual": {"shotFrame": [1024, 576]}}))
    (tmp_path / "Canon/characters/Vale").mkdir(parents=True)
    (tmp_path / "Canon/characters/Vale/reference.png").write_bytes(b"png")
    (tmp_path / "Canon/cast.json").write_text(json.dumps(INDEX))
    (tmp_path / "Episodes/s01e02").mkdir(parents=True)
    (tmp_path / "Episodes/s01e02/script.md").write_text(SCRIPT_TEXT)
    (tmp_path / "Production/s01e02/images").mkdir(parents=True)
    return tmp_path


def shot(n: int, brief: str = "the quay at dawn, wet stone, one lamp lit", **extra) -> dict:
    scene = ["COLD OPEN", "SCENE TWO — THE QUAY", "SCENE THREE — THE LAMP ROOM"][n - 1]
    return {"id": f"s{n}-establishing", "scene": scene, "type": "establishing", "source": "pipeline",
            "brief": brief, "width": 1024, "height": 576, **extra}


def write(show: Path, shots: list[dict]) -> None:
    (show / "Production/s01e02/images/prompts.json").write_text(json.dumps({"episode": "s01e02", "shots": shots}))


def run(show: Path, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "s01e02", *flags, "--show-root", str(show)],
                          capture_output=True, text=True)


def test_a_good_list_is_ok_and_the_tag_is_last(show):
    write(show, [shot(1), shot(2), shot(3)])
    r = run(show)
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "SHOTS_OK 3 shots"


def test_a_missing_scene_is_bad(show):
    write(show, [shot(1), shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "SCENE TWO — THE QUAY: no establishing shot (expected s2-establishing)" in r.stderr


def test_two_shots_for_one_scene_and_a_scene_the_script_lacks_are_bad(show):
    write(show, [shot(1), shot(2), shot(2), {**shot(3), "id": "s4-establishing", "scene": "SCENE FOUR — NOWHERE"}])
    r = run(show)
    assert r.returncode == 2
    assert "s2-establishing: a second establishing shot for SCENE TWO — THE QUAY" in r.stderr
    assert "s4-establishing: the script has no scene SCENE FOUR — NOWHERE" in r.stderr


def test_a_cast_name_or_a_species_in_an_establishing_brief_is_bad(show):
    write(show, [shot(1, "Vale at the quay"), shot(2, "the warden's lamp room"), shot(3, "gull-folk on the roofs")])
    r = run(show)
    assert r.returncode == 2
    assert "s1-establishing: names Vale (cast key vale)" in r.stderr
    assert "s2-establishing: names the Warden (cast key the-warden)" in r.stderr
    assert "s3-establishing: names Gull-folk (species, cast key gull-folk)" in r.stderr


def test_the_leftover_local_keys_are_bad(show):
    write(show, [shot(1, prompt="x", seed=7), shot(2), shot(3)])
    r = run(show)
    assert "s1-establishing: has prompt, seed — the local renderer is gone; write a brief" in r.stderr


def test_a_character_shot_needs_refs_with_a_face_on_disk(show):
    extra = {"id": "s2-vale-at-the-rail", "scene": "SCENE TWO — THE QUAY", "type": "character", "source": "pipeline",
             "brief": "Vale at the rail", "refs": ["vale"], "width": 1024, "height": 576}
    write(show, [shot(1), shot(2), extra, shot(3)])
    assert run(show).returncode == 0
    extra["refs"] = ["the-warden"]
    write(show, [shot(1), shot(2), extra, shot(3)])
    r = run(show)
    assert r.returncode == 2
    assert "s2-vale-at-the-rail: ref the-warden has no reference image (cast the face, or set source to showrunner)" in r.stderr
    extra["refs"] = []
    write(show, [shot(1), shot(2), extra, shot(3)])
    assert "s2-vale-at-the-rail: a character shot with no refs" in run(show).stderr


def test_report_only_prints_the_tag_and_exits_zero(show):
    write(show, [shot(1), shot(3)])
    r = run(show, "--report-only")
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "SHOTS_BAD 1 shots: s2-establishing"


def test_progress_is_reported_per_shot(show):
    write(show, [shot(1), shot(2), shot(3)])
    out = run(show).stdout
    assert '::progress {"done": 3, "total": 3, "unit": "shots"}' in out
```

(Reason strings are the contract: the fix agent reads them. The `SHOTS_BAD` id list names the expected id for a missing scene, the offending shot otherwise, each id once.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts && uv run --group dev pytest -q tests/test_shot_list_check.py`
Expected: FAIL (the script does not exist).

- [ ] **Step 3: Write the lint**

`scripts/shot-list-check.py`:

```python
# /// script
# dependencies = []
# ///
"""shot-list-check: the law of the shot list (spec 2026-11-04 §2.5).

One establishing shot per scene header of the script, ids `s<n>-establishing` in header order,
`scene` equal to the header; an establishing brief names no character of the cast index, no
creature and no species; a character shot has refs, each a cast-index key with a reference image
on disk; no shot carries the local renderer's `prompt`/`seed` keys. It replaced populator-check.py
on 2026-11-04 and keeps its result contract: `--report-only` prints the reasons and ends with
`SHOTS_BAD <n> shots: <ids>` exiting 0 (the fix agent reads that line as the step's result);
without the flag a bad list exits 2; a good list ends with `SHOTS_OK <n> shots`.

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
    episodes = str(sc.value(cfg, "episodesDir"))
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
            print(f"SHOTS_BAD {len(ids)} shots: {', '.join(ids)}")
            return
        sys.exit(DIRTY)
    print(f"SHOTS_OK {len(shots)} shots")


if __name__ == "__main__":
    main()
```

If `sc.value(cfg, "episodesDir")` is not how `lib/showconfig.py` exposes the episodes directory, use the accessor it has (read the module); the config key is `episodesDir`, default `Episodes`. If `castindex.load` raises on an absent index, let it: the run already stopped at `bible-ready`.

- [ ] **Step 4: Run the lint's tests**

Run: `cd scripts && uv run --group dev pytest -q tests/test_shot_list_check.py`
Expected: PASS (9 tests).

- [ ] **Step 5: Rewrite the image sheet**

`scripts/image-sheet.py`: delete `scaffold_patterns` and `subject` (they stripped the local scaffolding out of local prompts) and the two lists `nano`/`local`. The sheet is one table in shot order:

```
# {ep} — Image Sheet

**{n} images** — one establishing shot per scene; {k} by hand (showrunner-made).

| shot | scene | state | brief |
|---|---|---|---|
| s01-establishing | COLD OPEN | rendered | the quay at dawn … |
| s04-vale-at-the-rail | SCENE FOUR — … | by hand — MISSING: drop `s04-vale-at-the-rail.png` into {images dir} | … |
```

`state` is `rendered` (PNG present, source pipeline), `missing` (source pipeline, no PNG: the renderer has not made it yet, or the audit deleted it), `by hand — in place`, `by hand — MISSING: drop …`. The last line is `SHEET_OK {n} shots ({k} by hand, {m} missing)`. Keep whatever the file prints about the casting directory and the style document (test `test_the_sheet_names_the_shows_casting_directory_and_style_document`) if that line still makes sense for a sheet of establishing shots; otherwise delete the line and the test together and say so in the report.

Update `scripts/tests/test_image_sheet.py`: delete the five scaffold tests (lines 27-49) and `test_the_sheet_splits_character_shots_from_engine_shots`; add `test_the_sheet_lists_every_shot_in_order_with_its_state` and `test_the_result_line_counts_by_hand_and_missing`; keep and adapt the showrunner-made tests to the new state wording.

- [ ] **Step 6: The face designer on nano-banana**

`scripts/design-visual.py`: usage `design-visual.py <key> --briefs <file> [--show-root <path>]`. Read the briefs file as a JSON list of strings (refuse with a one-line message if it is not); require the key in the index (as today); for each brief `i` (1-based) call `nb.generate_image(brief + "\n\n" + style_constants, [], f"{cand_dir}/{key}-{i}.png", counter)` where `style_constants = str(sc.value(cfg, "visual", "styleConstants"))`; skip a candidate whose PNG exists (idempotent) and say so; print `CANDIDATE <path>` per file, the api-call count, and the lock instruction the script prints today (lines 105-110). Delete `find_bin`, `render`, `QWEN_BINARY`, the seed derivation, the `all` mode and the docstring's Qwen paragraphs; the docstring says the designer renders one candidate per brief through the shared client (spec §3.3), and that `baseline_prompt` in the index is the brief author's starting point, not the prompt.

`scripts/tests/test_design_visual.py`:

```python
def test_one_candidate_per_brief_text_only(tmp_path, monkeypatch):
    # a show with cast key "vale"; briefs file ["a tall keeper", "a short keeper"]; nb.api_call patched to return PNG bytes
    # → vale-1.png and vale-2.png exist; two calls; each prompt starts with its brief and ends with the style constants; parts == []
def test_an_existing_candidate_is_kept(tmp_path, monkeypatch):
    # vale-1.png pre-exists → one call for vale-2 only; stdout says vale-1 kept
def test_a_briefs_file_that_is_not_a_list_is_refused(tmp_path):
    # exit code != 0, message names the file
```

Run the script in the tests through `subprocess` the way `test_shot_list_check.py` does, with `GEMINI_API_KEY` set to a dummy value and the library patched through a small `sitecustomize`-free route: import the script module via `importlib` and patch `nb.api_call` (see how `test_nano_banana_generate.py` imports the renderer module by path and copy that).

- [ ] **Step 7: Run the scripts suite**

Run: `cd scripts && uv run --group dev pytest -q`
Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git add -A scripts
git commit -m "scripts: shot-list-check.py is the law of the shot list; the sheet is one list; design-visual renders candidates through nano-banana from briefs"
```

---

### Task 3: The engine — the image stage, the probe, the config table

**Files:**
- Modify: `engine/src/pipelines/episode.ts` (the image stage, lines 356-414, and `EPISODE_STAGE_MAP` at line 44-50), `engine/src/needs.ts` (lines 70-140), `engine/src/show-config.ts` (the `visual.*` rows, lines ~108-116)
- Test: `engine/test/episode-pipeline.test.ts`, `engine/test/needs.test.ts`, `engine/test/show-config.test.ts` (if it names a removed key)

**Interfaces:**
- Consumes `scripts/shot-list-check.py` (Task 2) and `scripts/nano-banana-generate.py` (Task 1) by name.
- Produces the 65-step pipeline with these image-stage ids, in order: `visual-direction`, `shot-list-check`, `visual-direction-fix`, `shot-list-check-final`, `nano-banana-generate`, `image-audit-1`, `image-regenerate-1`, `image-audit-2`, `image-regenerate-2`, `image-audit-3`, `image-audit-verdict`, `image-sheet`, `image-gate`, `showrunner-images`, `image-sheet-final`. Gates in order: `outline-gate`, `script-gate`, `casting-gate`, `audio-gate`, `image-gate`, `final-gate`, `canon-gate`. The console (Task 5) pins both.

- [ ] **Step 1: Write the failing engine tests**

In `engine/test/episode-pipeline.test.ts`:
- line 38: `toHaveLength(65)`.
- line 80: the gates list without `nano-banana-gate`.
- line 98: the stage map without `nano-banana-gate`.
- the fake script results (line 218-220): replace `"populator-check": "POPULATORS_OK 3 briefs"` with `"shot-list-check": "SHOTS_OK 3 shots"`; keep `"nano-banana-generate": "NANO_OK 1/1"`; the fake at line 227-232 that split shots by type between two scripts becomes one branch for `nano-banana-generate.py` that writes a PNG for every shot whose `source` is not `showrunner`.
- the flow test (lines 370-392): the run parks at `image-gate` after one clean audit (no `nano-banana-gate` stop); rejecting `image-gate` runs `image-gate-fix` first and then resets from `nano-banana-generate` (the audit loop, the sheet and the gate re-run).
- the `image-gate-fix` fake (lines 276-285): it edits `brief`, not `prompt`/`seed`.
- add: `it("the image stage is lint, render, audit loop, sheet, one gate, guard", ...)` asserting the exact id order above as a slice of `p.steps.map(s => s.id)`, and that no step's argv names `image-generate.py` or `populator-check.py`.

In `engine/test/needs.test.ts`: the expectation at line 134-139 loses the `Ghost: reference image missing …` line (Ghost is now satisfied by his entry alone); add one assertion that an entry with no `face` at all and no `speaks` tag reports nothing. Keep every voice assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run typecheck -w engine && npm test -w engine`
Expected: FAIL on the length, the gates list and the id order.

- [ ] **Step 3: Rewrite the image stage**

In `engine/src/pipelines/episode.ts`, replace lines 362-412 (from `populator-check` through `image-sheet-final`) with:

```ts
    { kind: "script", id: "shot-list-check", dependsOn: ["visual-direction"], argv: py("shot-list-check.py", "--report-only"), inputs: [prompts, castIndex], timeoutMs: MIN },
    {
      kind: "agent", id: "visual-direction-fix", dependsOn: ["shot-list-check"], when: (ctx) => String(ctx.results["shot-list-check"] ?? "").startsWith("SHOTS_BAD"),
      promptFile: "visual-direction-fix.md", model: "medium", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "fresh", outputs: [prompts], timeoutMs: 15 * MIN,
    },
    {
      kind: "script", id: "shot-list-check-final", dependsOn: ["visual-direction-fix"], when: (ctx) => String(ctx.results["shot-list-check"] ?? "").startsWith("SHOTS_BAD"),
      argv: py("shot-list-check.py"), inputs: [prompts, castIndex], timeoutMs: MIN,
    },
    { kind: "script", id: "nano-banana-generate", dependsOn: ["shot-list-check-final"], argv: py("nano-banana-generate.py"), inputs: [prompts, castIndex], timeoutMs: 3 * HOUR },
    imageAudit(1, ["nano-banana-generate"]),
    { kind: "script", id: "image-regenerate-1", dependsOn: ["image-audit-1"], when: auditFailed(1), argv: py("nano-banana-generate.py"), inputs: [prompts, castIndex], timeoutMs: 3 * HOUR },
    imageAudit(2, ["image-regenerate-1"], auditFailed(1)),
    { kind: "script", id: "image-regenerate-2", dependsOn: ["image-audit-2"], when: auditFailed(2), argv: py("nano-banana-generate.py"), inputs: [prompts, castIndex], timeoutMs: 3 * HOUR },
    imageAudit(3, ["image-regenerate-2"], auditFailed(2)),
    {
      kind: "guard", id: "image-audit-verdict", dependsOn: ["image-audit-3"],
      check: (ctx) => { /* as today, with the message "images still failing after 3 audits: …" */ },
    },
    { kind: "script", id: "image-sheet", dependsOn: ["image-audit-verdict"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
    {
      kind: "gate", id: "image-gate", dependsOn: ["image-sheet"], messageFile: "image-gate.gate.md", maxAttempts: 5,
      onReject: fixAgent("image-gate-fix", "image-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [prompts]),
      rerunOnReject: ["nano-banana-generate"],
    },
    {
      kind: "guard", id: "showrunner-images", dependsOn: ["image-gate"],
      check: async (ctx) => { /* as today */ },
    },
    { kind: "script", id: "image-sheet-final", dependsOn: ["showrunner-images"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
```

Read the existing definitions of `visual-direction-fix` (its model, tools, timeout) and `showrunner-images` before writing; keep their values. Delete the `nano-banana-gate` entry and the `image-generate` entry. The step after `image-sheet-final` (`build-timeline` or whatever depends on `image-sheet-final` today) keeps its dependency. Remove `"nano-banana-gate": "DRAFT_IMAGES"` from `EPISODE_STAGE_MAP.gates`. Rewrite the comment block above the image stage so it describes this stage and cites the spec (`docs/specs/2026-11-04-the-establishing-shot-design.md §4`), and the comment at lines 405-409 (about `registry-append`) stays.

- [ ] **Step 4: Drop the face check from the probe**

In `engine/src/needs.ts`: delete lines 126-130 (the face lookup and its `missing.push`) and rewrite the function's doc comment (lines 70-95) so it says what the probe demands after 2026-11-04: an entry in the index for everybody on the page, and a LOCKED voice with its WAV for everybody tagged `speaks`; faces are the shot list's business (`scripts/shot-list-check.py`, spec 2026-11-04 §7), because the engine makes no character shot of its own. If `exists`/`resolveShowPath` are now used only by the voice check, they stay imported.

- [ ] **Step 5: The config table**

In `engine/src/show-config.ts`: delete the rows `visual.ambientPromptScaffold`, `visual.collectivePopulatorBans`, `visual.characterKinds`; reread the rows `visual.styleConstants`, `visual.shotFrame`, `visual.style`, `visual.auditLaws`, `visual.candidatesDir` and rewrite any `readBy` prose that names `image-generate.py`, `populator-check.py`, "ambient" or "local" so it names the readers that exist (`nano-banana-generate.py`, `shot-list-check.py`, `design-visual.py`, `image-sheet.py`) with the line cited verified against the file at HEAD. If `engine/test/show-config.test.ts` names a removed key, update it.

- [ ] **Step 6: Run the engine suite**

Run: `npm run typecheck -w engine && npm test -w engine`
Expected: all passing; 65 steps.

- [ ] **Step 7: Commit**

```bash
git add engine
git commit -m "engine: the image stage is lint, render, audit loop, sheet and one gate; refs-ready demands no face; the local renderer's config rows go"
```

---

### Task 4: Tools — the templates, the canon templates, the scaffold, the check data

**Files:**
- Modify: `tools/templates/prompts/visual-direction.md`, `visual-direction-fix.md`, `image-audit.md`, `image-gate.gate.md`, `image-gate.reject.md`, `tools/templates/prompts/README.md` (if it lists the deleted templates), `tools/templates/canon/visual-style.md`, `tools/templates/canon/visual-audit-laws.md`, `tools/src/init/config.ts` (lines 112-128), `tools/show-data/deadlight-check-context.json`, `tools/test/fixtures/harbor-check-context.json`, `tools/test/config.test.ts`
- Delete: `tools/templates/prompts/nano-banana-gate.gate.md`, `tools/templates/prompts/nano-banana-gate.reject.md`
- Test: `tools/test/templates.test.ts` (a render of every template; add an assertion that no template names a deleted step), `tools/test/config.test.ts`, `tools/test/init-exercise.test.ts`

**Interfaces:**
- Consumes the lint's result tag (`{{results.shot-list-check}}`), the verdict guard's summary (`{{results.image-audit-verdict}}`), the gate's rejection (`{{results.image-gate:rejection}}`).
- Produces the five templates below, verbatim.

- [ ] **Step 1: Write the failing tests**

In `tools/test/templates.test.ts` add:

```ts
it("no template names the retired image steps or the local renderer", async () => {
  const names = await readdir(TEMPLATES);
  expect(names).not.toContain("nano-banana-gate.gate.md");
  expect(names).not.toContain("nano-banana-gate.reject.md");
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const text = await readFile(join(TEMPLATES, name), "utf8");
    expect(text, name).not.toMatch(/populator|image-generate|Z-Image|ambient|nano-banana-gate/i);
  }
});
```

In `tools/test/config.test.ts`: where the scaffolded config's `visual` block is asserted, drop `characterKinds`, `ambientPromptScaffold`, `collectivePopulatorBans` and assert they are absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build -w tools && npm test -w tools`
Expected: FAIL on the template scan and the config assertions.

- [ ] **Step 3: The five templates**

`tools/templates/prompts/visual-direction.md`, whole file:

```
You are the visual director for *{{show.showName}}*. Build the episode's
shot list: one establishing shot per scene, and nothing else.

Read (LIVE — these are the law and they grow):
- `Canon/visual-style.md` — `## The look`, `## Palette`, `## Composition
  rules` and `## The establishing shot`. Every law those sections state
  applies to every brief you write.
- `Canon/cast.json` — the cast index. You read it for two things: the
  names you must NOT write (an establishing shot names no person of the
  cast — no entry of kind character, human, creature or species), and the
  place entries you MAY name (kind location or ship): when the place you
  name has a `face.ref`, put its key in the shot's `refs`, so the render
  conditions on the place's own reference.
- {{show.episodesDir}}/{{episodeId}}/script.md — its scene headers are
  your list.

Write {{show.productionDir}}/{{episodeId}}/images/prompts.json:
{
  "episode": "{{episodeId}}",
  "shots": [
    {"id": "s1-establishing", "scene": "COLD OPEN", "type": "establishing",
     "source": "pipeline", "brief": "<the place at this scene's hour and light>",
     "width": 1024, "height": 576},
    {"id": "s2-establishing", "scene": "SCENE TWO — <name>", "type": "establishing",
     "source": "pipeline", "brief": "...", "width": 1024, "height": 576}
  ]
}

Rules:
- ONE SHOT PER SCENE. The script's `## COLD OPEN` and `## SCENE <N> — <name>`
  headers, in order, are the list: the cold open is scene 1, SCENE TWO is
  2, and so on. Exactly one shot per header, id `s<n>-establishing`,
  `scene` equal to the header text after `## `. No other shots: the
  showrunner adds any shot beyond these himself, at the image gate.
- THE ESTABLISHING BRIEF sets the listener in the place. Say where it is,
  the hour and the light, the weather or the air, the scale cues (a
  gantry, a hull, a long table) and the one or two objects the scene
  turns on. Wide, not close. It names NO person of the cast (no entry of
  kind character, human, creature or species) and asks for NO legible
  text. Human figures, if the place needs them, are distant and faceless.
  It MAY name the place itself — a location or a ship of the index — and
  then lists that key in `refs` when the entry has a reference image.
  Positive description only: name what is in the frame, never what is
  not (the show's negation law). Do not write the style constants; the
  renderer appends them.
- 1024x576 unless a vertical moment truly demands otherwise. No `prompt`
  and no `seed`: the renderer is Nano Banana and takes the brief as
  written. `refs` on an establishing shot holds only place keys.
- `source` is "pipeline". Write "showrunner" only when the premise or the
  outline says the showrunner makes that scene's image himself; the
  renderer never touches a "showrunner" shot and the run waits for its PNG.

The pipeline runs shot-list-check.py after this step; it fails the list on
a missing or extra scene, a person of the cast named in a brief, a named
place with a reference that is not in `refs`, or a leftover
`prompt`/`seed` key. Do not run it yourself; write the list so it
passes. Summarize: the scene count and one line per shot (id — the place).
```

`visual-direction-fix.md`, whole file:

```
You are the visual director for *{{show.showName}}*. Fix the shot list at
{{show.productionDir}}/{{episodeId}}/images/prompts.json. The shot-list
check found:
{{results.shot-list-check}}
The law: one establishing shot per scene header of
{{show.episodesDir}}/{{episodeId}}/script.md, id `s<n>-establishing`,
`scene` equal to the header; an establishing brief names no person of
`Canon/cast.json` (kind character, human, creature or species) and lists
in `refs` every place it names that has a reference image; a character
shot's refs are cast-index keys with a reference image on disk; no
`prompt` or `seed` keys. For each reason the check names, repair that shot (add the
missing scene's shot, remove the extra, rewrite the brief around the
name, drop the key) and change nothing else. The pipeline re-runs the
check as its own step after your edits and stops the line if it still
fails.
Summarize each change in one line.
```

`image-audit.md`, whole file:

```
You are the image auditor for *{{show.showName}}*. LOOK at every still
with the Read tool (it renders images) and verify it belongs in the show.
This is one audit round of up to three; the pipeline re-renders every PNG
you delete and runs the next round on the result. Every re-render is a
paid Nano Banana call: delete a PNG only for a defect the laws name.

1. Read {{show.visual.auditLaws}}; its numbered laws are the audit. Read
   {{show.visual.style}} for the look, and
   {{show.productionDir}}/{{episodeId}}/images/prompts.json for the shot list.
2. Read EVERY PNG the shot list names in
   {{show.productionDir}}/{{episodeId}}/images/ — actually look.
3. Verdict each still against every numbered law, one at a time, plus
   generation defects (mangled hands, duplicated structures, garbled
   text, a matte border the frame should not have).
3a. AN ESTABLISHING SHOT that rendered a person of the cast, a creature,
   a species, or legible text is a DEFECT: rewrite its brief positively
   around the thing (a wider frame, the place without the figure), then
   delete the PNG. A place the shot names (a location or ship in its
   `refs`) must match that place's reference image; a drift is a defect
   the same way.
3b. WATERMARK: scan all four corners and edges for a VISIBLE mark — a
   "Gemini" sparkle/star icon, a "✦" mark, an "AI" badge, any logo or
   text stamp. The paid tier's watermark is invisible (fine, expected);
   only a visible mark is a defect: delete the PNG so it re-renders.
4. FIX RULES:
   - A FAIL: FIRST rewrite the shot's `brief` in prompts.json so the next
     render avoids the defect (save the file), THEN delete that PNG (Bash
     `rm`). The order matters: a round interrupted between the two leaves
     a brief already rewritten, and the next round must not rewrite it
     again.
   - A matte-border artifact: crop it (~top/bottom bands) and rescale — do
     NOT re-roll (it is a crop, not a bad generation).
   - A shot whose `source` is "showrunner": never edit, never delete; note
     a problem in `flagged` for the image gate.
5. Do not run any generator yourself; the pipeline re-renders the PNGs
   you deleted as its own step after this round.

Verdict: `pass` is true when every pipeline image on disk passes and you
deleted none this round. `fixed` lists the ids you rewrote and deleted;
`flagged` lists showrunner-made ids with the problem in a few words;
`summary` is one line per image: "id: pass / fixed-how / note". Set
`verdict` to "IMAGES_CLEAN" when pass is true, "IMAGES_FAILING" when false.
```

`image-gate.gate.md`, whole file:

```
Images for {{episodeId}}: one establishing shot per scene, in
{{show.productionDir}}/{{episodeId}}/images/ (the sheet is IMAGE-SHEET.md).
Auditor summary (last round): {{results.image-audit-verdict}}
Approve, or reject with notes that name shots or scenes:
- "s3-establishing: too bright, it is the night watch" — that shot is
  re-rendered with your note folded into its brief.
- "scene four: add Vale at the long table, refs vale" — a character shot
  is added to that scene and rendered from Vale's reference.
- "I'll make s7 myself" — that shot is marked yours; drop the PNG in under
  its id and the run waits for it.
```

`image-gate.reject.md`, whole file:

```
You are the image-fix operator for *{{show.showName}}*. On {{episodeId}},
the showrunner rejected images:
{{results.image-gate:rejection}}
Edit {{show.productionDir}}/{{episodeId}}/images/prompts.json and nothing else:
- A note naming a shot: fold the showrunner's words into that shot's
  `brief`, then delete its PNG (Bash `rm`). The pipeline renders it again
  as its own step; do not run a generator yourself.
- A note adding a shot to a scene: append a shot to that scene — id
  `s<n>-<kebab-slug>`, `scene` equal to the header, `type` "character"
  when it names anyone of the cast (then `refs` holds their
  `Canon/cast.json` keys, each with a `face.ref`; a name with no reference
  image becomes `source: "showrunner"` and you say so), `type`
  "establishing" otherwise, `source` "pipeline", a `brief`, 1024x576.
- A note saying he will make a shot himself: set that shot's `source` to
  "showrunner" and leave its PNG alone.
- A note removing a shot: delete its entry and its PNG; a scene's
  establishing shot is never removed.
Summarize what changed, one line per shot.
```

`git rm tools/templates/prompts/nano-banana-gate.gate.md tools/templates/prompts/nano-banana-gate.reject.md`. If `tools/templates/prompts/README.md` lists templates by name, drop the two and describe the five.

- [ ] **Step 4: The canon templates and the scaffold**

`tools/templates/canon/visual-style.md`: after `## Mandatory prompt scaffolding` add

```
## The establishing shot
<!-- Q: The engine makes one image per scene — a wide view that sets the listener in the place at that scene's hour and light, with no person of the cast (no character, creature or species) and no legible text in it; the place itself may be named and, when it has a reference image, the render matches it. What does an establishing shot of your world always carry (the materials, the weather, the scale of its structures), and what must it never show? -->
```

and under `## Per-episode counts` replace the question with: `<!-- Q: One establishing shot per scene is the engine's count; any shot beyond it is the showrunner's to add at the image gate. Is there a scene kind in your show that never gets one (a black-screen cold open, a title card)? Say so here. -->`. In `tools/templates/canon/visual-audit-laws.md` add a numbered law: "An establishing shot shows the place and no one of the cast: a person of the cast, a creature, a species or legible text in it is a defect, and a named place that does not match its reference image is a defect."

`tools/src/init/config.ts` lines 112-128: delete `characterKinds`, `ambientPromptScaffold` (and its comment), `collectivePopulatorBans`; keep `styleConstants` and its comment; `refs` was removed by Plan L1's follow-up if it is still there (check `git log -p -S'refs: "Canon/refs.json"' -- tools/src/init/config.ts`; if the key is present, leave it to that plan's deferred record and note it in your report).

`tools/show-data/deadlight-check-context.json` and `tools/test/fixtures/harbor-check-context.json`: delete the three `visual` keys; under `results` delete `populator-check` and `nano-banana-gate:rejection`, add `"shot-list-check": "SHOTS_BAD 1 shots: s4-establishing"`, set `"nano-banana-generate": "NANO_OK 12/12"`, keep `image-audit-verdict` and `image-gate:rejection`.

- [ ] **Step 5: Run the tools suite and the renders**

Run: `npm run build -w tools && npm test -w tools && node tools/dist/check-prompts.js --prompts tools/templates/prompts --context tools/show-data/deadlight-check-context.json`
Expected: all passing; "every prompt in tools/templates/prompts renders".

- [ ] **Step 6: Commit**

```bash
git add -A tools
git commit -m "tools: the visual-direction, fix, audit and image-gate templates for one establishing shot per scene; the nano-banana-gate templates and the local renderer's scaffold keys go"
```

---

### Task 5: The console

**Files:**
- Modify: `console/server/gates.ts` (lines 128-133), `console/src/components/ContactSheet.tsx` (the comment at line 8), `console/test/helpers.ts:37`, `console/test/fixtures/seed-show.mjs:40`, `console/test/gates.test.ts:90`, `console/test/episodes.test.ts:80-84`, `console/test/app.test.ts:54,447`, `console/test/runs.test.ts:96`
- Test: the files above.

**Interfaces:** Consumes the 65-step pipeline and the gate list from Task 3 (the console imports the built engine: run `npm run build -w engine` first).

- [ ] **Step 1: Write the failing tests**

`app.test.ts` and `runs.test.ts`: 67 → 65. `helpers.ts` and `seed-show.mjs`: the `GATES` lists without `nano-banana-gate`. `gates.test.ts:90`: the test that parks at `nano-banana-gate` parks at `image-gate` and asserts the listing is the images directory and the sheet (`IMAGE-SHEET.md`). `episodes.test.ts:80-84`: the fixture's open gate is `image-gate`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build -w engine && npm run typecheck -w console && npm test -w console`
Expected: FAIL on the counts and the gate names.

- [ ] **Step 3: The server and the comment**

`console/server/gates.ts`: delete the `case "nano-banana-gate":` block; the `case "image-gate":` lists the images directory and the sheet: `return [dir(ctx.key, episodeId, "images", \`${prod}/images\`, "images/"), file(ctx.key, episodeId, "markdown", \`${prod}/images/IMAGE-SHEET.md\`)];`. `ContactSheet.tsx:8`: the comment names only `image-gate`.

- [ ] **Step 4: Run the console suite**

Run: `npm run typecheck -w console && npm test -w console`
Expected: all passing.

- [ ] **Step 5: The purge grep and the show-name grep**

Run both greps from Global Constraints. Expected: nothing printed. Fix any hit in the four packages (prose and code alike) before committing.

- [ ] **Step 6: Commit**

```bash
git add console
git commit -m "console: the image gate lists the images and the sheet; the nano-banana gate is gone; the pipeline is 65 steps"
```

---

### Task 6: Docs — the deferred record and the spec's change log (controller-run after the whole-branch review)

**Files:**
- Create: `docs/plans/2026-11-04-the-establishing-shot-deferred.md`
- Modify: `docs/specs/2026-11-04-the-establishing-shot-design.md` (§12), `docs/specs/2026-10-31-the-casting-stop-design.md` (§7: the face requirement superseded, pointing at the new spec §7)

- [ ] **Step 1:** Write the deferred record: every ruling the ledger holds (`Ruling:` lines), every reviewer finding parked, and the items the spec names as not built (§11).
- [ ] **Step 2:** Add the change-log entries. Commit: `docs: the establishing-shot plan landed; the casting-stop spec's face requirement is superseded`.

---

### Task 7: The show side and the s02e01 rerun (controller-run, spec §10)

Not a subagent task. In `~/GitHub/DeadLight2`, after Ryan has merged Showrunner PR #123, DeadLight PR #11 and this plan's PR, and before the production rebuild:

- [ ] **Step 1:** `git checkout main && git pull`, then a branch `establishing-shot`.
- [ ] **Step 2:** `prompts/`: the five changed templates three-way merged onto the show's copies (base = the template at `cast-index`, ours = the show's copy, theirs = the template at this plan's HEAD), as Plan L1 Task 6 did; `git rm prompts/nano-banana-gate.gate.md prompts/nano-banana-gate.reject.md`; `check-prompts --prompts prompts --context tools/show-data/deadlight-check-context.json` renders every prompt.
- [ ] **Step 3:** `Canon/visual-style.md`: delete the sections `## QC: the vision audit is the gate, the histogram is not` (lines 47-82), `## THE HARD LINE — local GPU vs Nano Banana` (101-185), `## INTERIOR PREFIX` (242-259) and `## Model note` (303-end); rewrite `## Per-episode counts` (296) to "one establishing shot per scene; any shot beyond it is Ryan's to add at the image gate"; add `## The establishing shot` with the show's answer (the materials of its places: wet steel, sodium light, hull plate; the scale of a dock; no person of the cast, no creature, no species, no legible text; the place itself may be named and matches its reference). **Binding: the section is a `REQUIRED_SECTIONS` row from Task 4 on (`engine/src/bible.ts`), which `bible-check` and the console's Bible page report as missing; the `bible-ready` guard checks file presence and the cast index only and would not stop a run over it, so the show must carry the section before the rerun or the visual director writes its briefs against a heading that is not there.** `Canon/visual-audit-laws.md`: add the establishing-shot law. Keep every other law.
- [ ] **Step 4:** `showrunner.json`: delete `visual.characterKinds`, `visual.ambientPromptScaffold`, `visual.collectivePopulatorBans`.
- [ ] **Step 5:** `Production/s02e01/images/`: `mkdir _old-rule && git mv` every PNG and the old `prompts.json` and `IMAGE-SHEET.md` into it (these are untracked today; a plain `mv` then). The rerun writes a fresh `prompts.json`.
- [ ] **Step 6:** Commit, push, open the show PR; Ryan merges; `git checkout main && git pull`.
- [ ] **Step 7:** Rebuild production: `cd ~/GitHub/Showrunner-prod && git pull && npm ci && npm run build`; stop the 4410 server; start it again (`node dist/server/main.js` from `console/`, detached, log `~/showrunner-console.log`); the header shows the new engine version.
- [ ] **Step 8:** Ryan tops up Google AI Studio credits (his action; nothing else spends until this).
- [ ] **Step 9:** Reset run `20261014T183337Z-8r5w` from `visual-direction` (the Run page's "re-run from", or `POST /shows/<key>/episodes/s02e01/runs/<runId>/reset` with `{"stepIds":["visual-direction"]}`), resume. Expected: 12 establishing shots, `SHOTS_OK 12 shots`, `NANO_OK 12/12`, an audit round, the sheet, the image gate opens for Ryan.
