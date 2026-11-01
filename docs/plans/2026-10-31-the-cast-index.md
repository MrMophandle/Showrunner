# The Cast Index Implementation Plan (Plan L1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One master file, `Canon/cast.json`, is the show's only record of who has a sheet, a face and a voice; every engine probe, script and prompt reads it instead of the two registries; no agent lists the characters directory; a character folder holds a sheet, one reference image and at most three gallery images; and the existing show is migrated onto it.

**Architecture:** An engine module (`engine/src/cast.ts`) and a scripts module (`scripts/lib/castindex.py`) each load and query the index; `needs.ts`'s reference probe, the pipeline's step inputs, four scripts and eight prompt templates are repointed; the `registry-append` step that grew the character folders is removed; three migration scripts build the index from the two registries, audit the gaps against the retired repository, and prune the folders by moving excess images out of `Canon/`. The casting stop itself (steps, gate, console page) is Plan L2, written against this plan's real interfaces.

**Tech Stack:** TypeScript strict / NodeNext / ESM, vitest 4 (engine); Python 3.11, pytest (`cd scripts && uv run --group dev pytest -q`); the prompt templates under `tools/templates/prompts/` checked by `tools/dist/check-prompts.js`.

**Spec:** `docs/specs/2026-10-31-the-casting-stop-design.md` §1 (the database: 1.2 the index, 1.2a the ingestion rule, 1.2b the folder), §4 (the migration). The casting stop (§2, §3) is Plan L2.

## Global Constraints

- **No show's name** in `engine/`, `scripts/`, `tools/`, `console/`: `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. Fixtures are Harbor Lights (Vale, the Warden, Pim, Maeve, Harbor).
- **The retired repository `~/GitHub/DeadLight` is never written.** The audit reads it with `--retired <path>` and nothing else touches it.
- **The index is the one record.** No new reader of `Production/voice-refs/refs.json` or `Canon/refs.json` is added; every existing one is removed in this plan.
- **Nothing is deleted by the migration.** The prune moves files; the legacy registries are removed from the instance only in Task 6, after the index is verified against them.
- **Keys are the engine's `slugName`** (`engine/src/needs.ts:57`): lowercased, a leading "the " dropped, runs of non-alphanumerics to one hyphen. The Python port must be identical and tested identical on the same cases.
- **Typecheck and tests green at every commit:** `npm run typecheck -w engine && npm test -w engine`; `cd scripts && uv run --group dev pytest -q`; `npm run typecheck -w console && npm test -w console` where the console is touched; `check-prompts` for the templates.
- **Commits end with exactly one trailer:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Deployment order (binding, for the controller):** the engine PR is not rebuilt into production until the instance carries `Canon/cast.json` (Task 6). A production engine that reads the index against an instance that lacks it stops every run at `refs-ready` with the one-line remedy below, which is correct and is also an outage.

## The index

`Canon/cast.json` (the path is `cast.index` in `showrunner.json`, defaulted):

```json
{
  "version": 1,
  "audio": { "engine": "qwen3", "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16", "note": "..." },
  "cast": {
    "vale": {
      "name": "Vale", "kind": "human", "speaks": true, "debut": "s01e01",
      "sheet": "Canon/characters/Vale/vale.md",
      "identity": "Vale, ~60, weathered practical woman ...",
      "baseline_prompt": "character reference sheet ...",
      "face": { "ref": "Canon/characters/Vale/reference.png", "gallery": ["Canon/characters/Vale/gallery/01.png"], "locked": "Nano Banana reference sheet, 2026-07-20" },
      "voice": { "ref": "Production/voice-refs/vale.wav", "ref_text": "...", "direction": "...", "fx": null, "speed": 1.12, "status": "LOCKED", "note": "..." }
    },
    "the-warden": { "name": "the Warden", "kind": "character", "speaks": false, "silent": true, "face": { "ref": "...", "gallery": [] }, "voice": null },
    "harbor": { "name": "Harbor", "kind": "location", "speaks": false, "face": { "ref": "Canon/locations/harbor.png", "gallery": [] } },
    "elyth": { "name": "Elyth", "kind": "species", "speaks": false, "identity": "..." }
  }
}
```

Rules: `cast` keys are `slugName(name)`; `the-<slug>` is accepted on read as an alternative key. `kind` is free text today (`human`, `creature`, `character`, `ship`, `location`, `species`, `motif`, `style`); `visual.characterKinds` says which kinds are characters. `speaks` is a boolean; `silent: true` marks a seen-but-silent character so "no voice" is a fact. `voice` is absent (never cast), `null` (silent by design) or an object; `face` is absent or an object whose `ref` may be absent while candidates are being designed (`baseline_prompt` present). `audio.engine` and `audio.model` move here from the voice registry's top level, which the TTS prompt copies into the manifest.

---

### Task 1: The engine reads the index

**Files:**
- Create: `engine/src/cast.ts`
- Modify: `engine/src/needs.ts` (`missingRefs`, `dirs`), `engine/src/pipelines/episode.ts` (inputs; the `registry-append` step), `engine/src/show-config.ts` (the paths table), `engine/src/index.ts` (export)
- Test: `engine/test/cast.test.ts`, `engine/test/needs.test.ts`, `engine/test/pipeline.test.ts` or whichever test asserts the step list (grep `registry-append` under `engine/test`)

**Interfaces:**
- Produces: `castIndexPath(show): string` (`show.cast?.index ?? "<canonDir>/cast.json"`); `loadCastIndex(showRoot, show): Promise<CastIndex | undefined>` (undefined when the file is absent; throws `CastIndexError` when present but unreadable); `castEntry(index, name): CastEntry | undefined` (by `slugName`, then `the-<slug>`); `voiceReady(entry): boolean` (a voice object with `status` including `LOCKED`); types `CastIndex`, `CastEntry`, `CastFace`, `CastVoice`. `missingRefs` reports `no cast index at <path> — run scripts/cast-index-build.py --write` as its one line when the index is absent.
- Consumes: `slugName`, `resolveShowPath`, `parseCastSection` (unchanged).

- [x] **Step 1: Write the failing tests.** Create `engine/test/cast.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { castEntry, castIndexPath, loadCastIndex, voiceReady, CastIndexError } from "../src/cast.js";
import type { ShowConfig } from "../src/show-config.js";

const SHOW = {
  showName: "S", showSlug: "Show", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" },
} as unknown as ShowConfig;

const INDEX = {
  version: 1, audio: { engine: "qwen3" },
  cast: {
    vale: { name: "Vale", kind: "human", speaks: true, debut: "s01e01", face: { ref: "Canon/characters/Vale/reference.png", gallery: [] }, voice: { ref: "Production/voice-refs/vale.wav", ref_text: "x", direction: "d", status: "LOCKED (speed 1.1)" } },
    "the-warden": { name: "the Warden", kind: "character", speaks: false, silent: true, face: { ref: "Canon/characters/Warden/reference.png", gallery: [] }, voice: null },
    pim: { name: "Dock Hand Pim", kind: "human", speaks: true, debut: "s02e01", voice: { ref: "Production/voice-refs/pim.wav", ref_text: "x", direction: "d", status: "CANDIDATE" } },
  },
};

async function showWithIndex(text: string | null) {
  const root = await mkdtemp(path.join(tmpdir(), "cast-"));
  await mkdir(path.join(root, "Canon"), { recursive: true });
  if (text !== null) await writeFile(path.join(root, "Canon", "cast.json"), text);
  return root;
}

describe("the cast index", () => {
  it("defaults its path under the canon directory and honours cast.index", () => {
    expect(castIndexPath(SHOW)).toBe("Canon/cast.json");
    expect(castIndexPath({ ...SHOW, canonDir: "Bible" } as ShowConfig)).toBe("Bible/cast.json");
    expect(castIndexPath({ ...SHOW, cast: { index: "Canon/people.json" } } as unknown as ShowConfig)).toBe("Canon/people.json");
  });

  it("is undefined when absent, an error when unreadable, and the parsed index otherwise", async () => {
    expect(await loadCastIndex(await showWithIndex(null), SHOW)).toBeUndefined();
    await expect(loadCastIndex(await showWithIndex("not json"), SHOW)).rejects.toBeInstanceOf(CastIndexError);
    await expect(loadCastIndex(await showWithIndex(JSON.stringify({ version: 1 })), SHOW)).rejects.toBeInstanceOf(CastIndexError);
    const index = await loadCastIndex(await showWithIndex(JSON.stringify(INDEX)), SHOW);
    expect(Object.keys(index!.cast)).toEqual(["vale", "the-warden", "pim"]);
  });

  it("finds an entry by the slug of a cast name, with the the- alternative", () => {
    const index = INDEX as never;
    expect(castEntry(index, "Vale")?.name).toBe("Vale");
    expect(castEntry(index, "the Warden")?.name).toBe("the Warden");
    expect(castEntry(index, "Warden")?.name).toBe("the Warden");
    expect(castEntry(index, "Dock Hand Pim")?.debut).toBe("s02e01");
    expect(castEntry(index, "Nobody")).toBeUndefined();
  });

  it("calls a voice ready only when it is an object whose status says LOCKED", () => {
    const index = INDEX as never;
    expect(voiceReady(castEntry(index, "Vale")!)).toBe(true);
    expect(voiceReady(castEntry(index, "Pim")!)).toBe(false);
    expect(voiceReady(castEntry(index, "the Warden")!)).toBe(false);
  });
});
```

Then rewrite `engine/test/needs.test.ts`'s `show1()` fixture to write `Canon/cast.json` instead of the two registries (same characters, same files on disk: Vale with a face and a LOCKED voice, the Warden with a face and `status: "CANDIDATE"`, Harbor a location, Ghost whose face ref is missing, no voice refs file, no visual refs file), and rewrite the expected messages of the `missingRefs` cases to the new wording:

```
Ghost: reference image missing at Canon/characters/Ghost/missing.png (Canon/cast.json key ghost)
the Warden: voice is not LOCKED in Canon/cast.json (key the-warden)
Nobody: no entry in Canon/cast.json (tried nobody, the-nobody)
Dock Hand Pim: no voice in Canon/cast.json (key pim)
```

and add one case: a show with no `Canon/cast.json` reports exactly `["no cast index at Canon/cast.json — run scripts/cast-index-build.py --write"]`. The guest-directory case (`no guest voice at …/guest-refs/…`) is deleted: a speaking guest is looked up in the index like everybody else.

- [x] **Step 2: Run to fail.** `npm test -w engine -- test/cast.test.ts test/needs.test.ts`.

- [x] **Step 3: The module.** Create `engine/src/cast.ts`:

```ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import { slugName } from "./needs.js";
import type { ShowConfig } from "./show-config.js";

/** The show's one record of who has a sheet, a face and a voice: `Canon/cast.json` (spec
 *  2026-10-31 §1.2). Keys are `slugName(name)`; `the-<slug>` is accepted on read. */
export interface CastVoice { ref: string; ref_text: string; direction: string; fx?: string | null; speed?: number; status: string; note?: string }
export interface CastFace { ref?: string; gallery?: string[]; locked?: string }
export interface CastEntry {
  name: string; kind: string; speaks: boolean; silent?: boolean; debut?: string; sheet?: string;
  identity?: string; baseline_prompt?: string; face?: CastFace; voice?: CastVoice | null; status?: string;
}
export interface CastIndex { version: number; audio?: { engine?: string; model?: string; note?: string }; cast: Record<string, CastEntry> }

export class CastIndexError extends Error {}

export function castIndexPath(show: ShowConfig): string {
  const configured = (show as { cast?: { index?: unknown } }).cast?.index;
  if (typeof configured === "string" && configured !== "") return configured;
  return path.posix.join(show.canonDir ?? "Canon", "cast.json");
}

/** Undefined when the file is absent — the probe turns that into its one-line remedy — and an
 *  error, never a guess, when it is present and not an index. */
export async function loadCastIndex(showRoot: string, show: ShowConfig): Promise<CastIndex | undefined> {
  const rel = castIndexPath(show);
  let text: string;
  try { text = await readFile(path.join(showRoot, rel), "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { throw new CastIndexError(`${rel}: not JSON (${(err as Error).message})`); }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { cast?: unknown }).cast !== "object" || (parsed as { cast?: unknown }).cast === null) {
    throw new CastIndexError(`${rel}: expected an object with a "cast" map`);
  }
  return parsed as CastIndex;
}

export function castEntry(index: CastIndex, name: string): CastEntry | undefined {
  const slug = slugName(name);
  return index.cast[slug] ?? index.cast[`the-${slug}`];
}

export function castKey(index: CastIndex, name: string): string | undefined {
  const slug = slugName(name);
  if (index.cast[slug] !== undefined) return slug;
  if (index.cast[`the-${slug}`] !== undefined) return `the-${slug}`;
  return undefined;
}

export function voiceReady(entry: CastEntry): boolean {
  const v = entry.voice;
  return typeof v === "object" && v !== null && typeof v.status === "string" && v.status.includes("LOCKED");
}
```

Export it from `engine/src/index.ts` (`export * from "./cast.js";`). If importing `needs.js` from `cast.js` while `needs.js` imports `cast.js` makes a cycle, move `slugName` into `cast.ts` and re-export it from `needs.ts` so its public name is unchanged.

- [x] **Step 4: The probe.** In `engine/src/needs.ts`, `missingRefs` becomes:

```ts
export async function missingRefs(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const outlinePath = path.join(showRoot, d.episodes, episodeId, "outline.md");
  if (!(await exists(outlinePath))) return [];
  const { entries: cast, malformed } = parseCastSection(await readFile(outlinePath, "utf8"));
  if (cast.length === 0 && malformed.length === 0) {
    return ['the outline has no readable ## Cast section (write one line per subject as "- <Name> (<tags>)")'];
  }
  const indexRel = castIndexPath(show);
  const index = await loadCastIndex(showRoot, show);
  if (index === undefined) return [`no cast index at ${indexRel} — run scripts/cast-index-build.py --write`];

  const missing: string[] = [];
  for (const line of malformed) missing.push(`${line}: not in the \`- <Name> (<tags>)\` grammar`);
  for (const entry of cast) {
    const slug = slugName(entry.name);
    const tags = new Set(entry.tags);
    const speaks = tags.has("speaks");
    if (!tags.has("recurring") && !tags.has("guest") && !tags.has("location")) {
      missing.push(`${entry.name}: tags name none of recurring, guest, location (got ${entry.tags.join(", ")})`);
      continue;
    }
    const key = castKey(index, entry.name);
    const found = key === undefined ? undefined : index.cast[key];
    if (found === undefined) { missing.push(`${entry.name}: no entry in ${indexRel} (tried ${slug}, the-${slug})`); continue; }
    // A face: every subject on the page has one — a character, a location, a ship.
    const faceRef = found.face?.ref;
    if (typeof faceRef !== "string" || !(await exists(resolveShowPath(showRoot, faceRef)))) {
      missing.push(`${entry.name}: reference image missing at ${typeof faceRef === "string" ? faceRef : "(no ref)"} (${indexRel} key ${key})`);
    }
    // A voice: every speaking subject has one, LOCKED, with its WAV on disk.
    if (speaks) {
      const v = found.voice;
      if (v === undefined || v === null) missing.push(`${entry.name}: no voice in ${indexRel} (key ${key})`);
      else if (!voiceReady(found)) missing.push(`${entry.name}: voice is not LOCKED in ${indexRel} (key ${key})`);
      else if (typeof v.ref !== "string" || !(await exists(resolveShowPath(showRoot, v.ref)))) missing.push(`${entry.name}: voice WAV missing at ${typeof v.ref === "string" ? v.ref : "(no ref)"} (${indexRel} key ${key})`);
    }
  }
  return missing;
}
```

Remove `guestRefsDir`, `stripTrailingSlash` and the `voiceRefs`/`visualRefs` fields of `dirs()` from `needs.ts` if nothing else in the file uses them (keep `checkGuestRefsDir` in `show-config.ts` untouched; its retirement is Task 6's config change plus a later cleanup). Keep the doc comment honest: rewrite the paragraph above `missingRefs` to say every subject is looked up in the index, speaking or not, recurring or guest.

- [x] **Step 5: The pipeline.** In `engine/src/pipelines/episode.ts`: add `const castIndex = str((show as { cast?: Record<string, unknown> }).cast?.["index"], `${canonDir}/cast.json`);`; replace `${voiceRefsDir}/refs.json` in `tts-script`'s inputs and every `visualRefs` in inputs (`visual-direction`, `visual-direction-fix`, `image-generate`, `nano-banana-generate`, `nano-banana-gate-fix`, the canon-update step at ~line 390) with `castIndex`; delete the `registry-append` step and make `image-sheet-final` depend on `image-gate`; remove the now-unused `visualRefs` constant (keep `voiceRefsDir`, `castingPileDir`, `voiceRegistry`). In `engine/src/show-config.ts`'s paths table add `{ path: "cast.index", requiredBy: "none", default: "Canon/cast.json", readBy: "engine/src/cast.ts (castIndexPath), engine/src/needs.ts, engine/src/pipelines/episode.ts; scripts/lib/castindex.py" }` and rewrite the `visual.refs` row's `readBy` to `"retired by Plan L1 (2026-10-31): the index replaced it; read by nothing"` or delete the row if the loader does not require a row per key — read the file header to decide, and keep the loader's behaviour for an instance whose config still carries `visual.refs` (ignored, not refused). Update the test that asserts the step list.

- [x] **Step 6: Run the gates.** `npm test -w engine && npm run typecheck -w engine`; `npm run typecheck -w console && npm test -w console` (the console imports the engine; nothing should change). The show-name grep.

- [x] **Step 7: Commit.**

```bash
git add engine/src/cast.ts engine/src/needs.ts engine/src/pipelines/episode.ts engine/src/show-config.ts engine/src/index.ts engine/test/cast.test.ts engine/test/needs.test.ts
git commit -m "engine: the cast index is the one record of faces and voices; the probe and the pipeline read it

Canon/cast.json replaces the visual bible and the voice registry's cast map as the thing the
refs-ready probe looks up: every subject on the page needs a face, every speaking one a LOCKED
voice with its WAV on disk, recurring or guest alike, and a show without the index stops with
the one line that says how to build it. The pipeline's steps take the index as their input, and
the registry-append step that copied every approved still into the character folders is gone
(spec 2026-10-31 §1.2b: a folder holds a sheet, one reference and at most three gallery images).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The scripts read the index

**Files:**
- Create: `scripts/lib/castindex.py`
- Modify: `scripts/design-visual.py`, `scripts/image-generate.py`, `scripts/nano-banana-generate.py`; Delete: `scripts/registry-append.py`, `scripts/tests/test_registry_append.py`
- Test: `scripts/tests/test_castindex.py`; update `scripts/tests/test_nano_banana_generate.py` (its bible fixture becomes an index)

**Interfaces:**
- Produces: `castindex.slug_name(name)` (the Python twin of `slugName`); `castindex.load(cfg, root)` → the parsed index dict (`FileNotFoundError` → a `CastIndexMissing` error naming the remedy); `castindex.index_path(cfg)`; `castindex.entry(index, name)`; `castindex.faces(index, root)` → `{key: {"ref": <abs or rel path>, "identity": ..., "gallery": [...], "kind": ...}}` for entries whose `face.ref` exists on disk (the shape `image-generate.py`'s `load_bible` and `nano-banana-generate.py`'s `load_bible` returned, so their callers change minimally); `castindex.unlocked(index)` → keys with a `baseline_prompt` and no `face.ref` (what `design-visual.py all` designs).

- [x] **Step 1: The failing tests.** Create `scripts/tests/test_castindex.py`:

```python
"""lib/castindex: the Python side of Canon/cast.json (spec 2026-10-31 §1.2)."""
from __future__ import annotations
import json
import pytest
from lib import castindex


@pytest.mark.parametrize("name,slug", [
    ("Vale", "vale"), ("the Warden", "warden"), ("The Warden", "warden"), ("Dock Hand Pim", "dock-hand-pim"),
    ("  Maeve  ", "maeve"), ("Harbor's Edge", "harbor-s-edge"), ("the-warden", "warden"),
])
def test_slug_name_matches_the_engine(name, slug):
    assert castindex.slug_name(name) == slug


def _show(tmp_path, index):
    (tmp_path / "Canon").mkdir()
    (tmp_path / "Canon" / "cast.json").write_text(json.dumps(index), encoding="utf-8")
    return {"canonDir": "Canon"}


INDEX = {"version": 1, "cast": {
    "vale": {"name": "Vale", "kind": "human", "speaks": True, "identity": "Vale", "face": {"ref": "Canon/characters/Vale/reference.png", "gallery": ["Canon/characters/Vale/gallery/01.png"]}},
    "the-warden": {"name": "the Warden", "kind": "character", "speaks": False, "silent": True, "face": {"ref": "Canon/characters/Warden/reference.png", "gallery": []}},
    "pim": {"name": "Pim", "kind": "human", "speaks": True, "baseline_prompt": "sheet", "face": {}},
}}


def test_load_entry_faces_and_unlocked(tmp_path):
    cfg = _show(tmp_path, INDEX)
    for rel in ("Canon/characters/Vale/reference.png", "Canon/characters/Warden/reference.png"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True); (tmp_path / rel).write_bytes(b"png")
    index = castindex.load(cfg, str(tmp_path))
    assert castindex.entry(index, "Warden")["name"] == "the Warden"
    assert castindex.entry(index, "Nobody") is None
    faces = castindex.faces(index, str(tmp_path))
    assert set(faces) == {"vale", "the-warden"}
    assert faces["vale"]["ref"].endswith("Canon/characters/Vale/reference.png")
    assert faces["vale"]["gallery"] == [str(tmp_path / "Canon/characters/Vale/gallery/01.png")]
    assert castindex.unlocked(index) == ["pim"]


def test_missing_index_names_the_remedy(tmp_path):
    (tmp_path / "Canon").mkdir()
    with pytest.raises(castindex.CastIndexMissing) as err:
        castindex.load({"canonDir": "Canon"}, str(tmp_path))
    assert "cast-index-build.py --write" in str(err.value)
```

- [x] **Step 2: Run to fail**, then create `scripts/lib/castindex.py`:

```python
"""The show's cast index, Canon/cast.json: the one record of who has a sheet, a face and a voice
(spec 2026-10-31 §1.2). Every script that used to open Canon/refs.json or the voice registry's
cast map reads this instead; nothing lists the characters directory."""
from __future__ import annotations
import json
import os
import re


class CastIndexMissing(FileNotFoundError):
    pass


def slug_name(name: str) -> str:
    """Identical to engine/src/needs.ts's slugName: lowercase, a leading "the" dropped, runs of
    anything but [a-z0-9] to one hyphen, hyphens trimmed."""
    s = name.strip().lower()
    s = re.sub(r"^the[ -]", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def index_path(cfg: dict) -> str:
    configured = (cfg.get("cast") or {}).get("index")
    if isinstance(configured, str) and configured:
        return configured
    return os.path.join(cfg.get("canonDir") or "Canon", "cast.json")


def load(cfg: dict, root: str) -> dict:
    rel = index_path(cfg)
    p = rel if os.path.isabs(rel) else os.path.join(root, rel)
    if not os.path.exists(p):
        raise CastIndexMissing(f"no cast index at {rel} — run scripts/cast-index-build.py --write")
    with open(p, encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or not isinstance(doc.get("cast"), dict):
        raise ValueError(f"{rel}: expected an object with a \"cast\" map")
    return doc


def entry(index: dict, name: str) -> dict | None:
    slug = slug_name(name)
    cast = index["cast"]
    return cast.get(slug) or cast.get(f"the-{slug}")


def key_of(index: dict, name: str) -> str | None:
    slug = slug_name(name)
    cast = index["cast"]
    if slug in cast: return slug
    if f"the-{slug}" in cast: return f"the-{slug}"
    return None


def _abs(root: str, rel: str) -> str:
    return rel if os.path.isabs(rel) else os.path.join(root, rel)


def faces(index: dict, root: str) -> dict:
    """{key: {"ref", "identity", "gallery", "kind", "name"}} for every entry whose reference
    image exists — the shape image-generate and nano-banana-generate condition on."""
    out = {}
    for key, e in index["cast"].items():
        ref = (e.get("face") or {}).get("ref")
        if not isinstance(ref, str) or not os.path.exists(_abs(root, ref)):
            continue
        gallery = [_abs(root, g) for g in (e.get("face") or {}).get("gallery", []) if os.path.exists(_abs(root, g))]
        out[key] = {"ref": _abs(root, ref), "identity": e.get("identity", ""), "gallery": gallery[:3],
                    "kind": e.get("kind", ""), "name": e.get("name", key)}
    return out


def unlocked(index: dict) -> list[str]:
    """Keys with a baseline prompt and no reference yet: what design-visual.py designs."""
    return [k for k, e in index["cast"].items()
            if isinstance(e.get("baseline_prompt"), str) and not (e.get("face") or {}).get("ref")]
```

- [x] **Step 3: Repoint the three scripts.**
  - `design-visual.py`: `bible = castindex.load(cfg, root)`; `subjects = castindex.unlocked(bible) if key == "all" else [key]`; the unknown-key refusal lists `bible["cast"]` keys; the `baseline_prompt` comes from `bible["cast"][key]["baseline_prompt"]`. Drop the `visual.refs` read.
  - `image-generate.py`: `load_bible(path)` becomes `castindex.faces(castindex.load(cfg, root), root)`; `hero_refs` unchanged (it reads `bible[k]["ref"]`).
  - `nano-banana-generate.py`: `load_bible` likewise; `_pile_stills(sheet_path)` is replaced by the entry's `gallery` list (at most three, already filtered to files on disk) — the folder is never listed; the comment block about `registry-append` fanning stills out is deleted, and `assemble_refs` dedupes by basename as before. The script's docstring sentence "the generator conditions on the newest stills" becomes "conditions on the reference and the gallery (at most three)".
  - Delete `scripts/registry-append.py` and `scripts/tests/test_registry_append.py`; remove the `visual.characterKinds` row from the config table only if nothing else reads it (`grep -rn characterKinds scripts/ engine/`).

- [x] **Step 4: The nano-banana test fixture.** In `scripts/tests/test_nano_banana_generate.py`, every place that builds a refs.json bible for `load_bible`/`assemble_refs` builds the faces map `castindex.faces` returns instead (`{"maeve": {"ref": <abs>, "identity": "...", "gallery": [], "kind": "human", "name": "Maeve"}}`); read the file and keep every assertion's intent.

- [x] **Step 5: Run the gates.** `cd scripts && uv run --group dev pytest -q`; the show-name grep.

- [x] **Step 6: Commit.**

```bash
git add scripts/lib/castindex.py scripts/design-visual.py scripts/image-generate.py scripts/nano-banana-generate.py scripts/tests/test_castindex.py scripts/tests/test_nano_banana_generate.py
git rm -q scripts/registry-append.py scripts/tests/test_registry_append.py
git commit -m "scripts: the image steps read the cast index; the generator conditions on the reference and a capped gallery; registry-append is gone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The prompts read the index and nothing else

**Files:**
- Modify: `tools/templates/prompts/tts-script.md`, `visual-direction.md`, `visual-direction-fix.md`, `nano-banana-gate.reject.md`, `outline.md`, `draft.md`, `character-check.md`, `canon-review-outline.md`, `canon-review-script.md`
- Test: `check-prompts` renders every template with `tools/show-data/deadlight-check-context.json`; the tools suite.

- [x] **Step 1: `tts-script.md`.** "Read first" item 1 becomes: `Canon/cast.json — the cast index. For every speaker in the script, take the cast entry's voice block (ref, ref_text, direction, fx, speed) verbatim; the manifest's "engine" and "model" are the index's audio.engine and audio.model. Never invent or alter a voice.` The manifest shape's `"guest": true` keeps its place, set when the entry's `debut` is this episode. The whole `## Casting rules` guest procedure (design description, "the voice itself was designed by the showrunner", `{{show.audio.guestRefsDir}}`, `<guest-slug>.txt`, "Do not run design-voice.py") is replaced by: `Every speaking character in the outline's ## Cast has a LOCKED voice in Canon/cast.json; the refs-ready guard upstream stops the run otherwise. A speaker you cannot find in the index is a defect to report in your summary, never a voice to design here.` Keep the fx and register rules.
- [x] **Step 2: `visual-direction.md`, `visual-direction-fix.md`, `nano-banana-gate.reject.md`.** `Canon/refs.json` → `Canon/cast.json` everywhere; "the Nano-Banana bible (recurring characters/structures/locations with locked reference sheets)" → "the cast index: every character, structure and location with a reference, its identity text and its gallery"; the reject prompt's "correct that subject's identity text in Canon/refs.json" → "in Canon/cast.json".
- [x] **Step 3: The ingestion rule (spec §1.2a).** `outline.md:21` becomes: `- Canon/cast.json, the cast index, and then ONLY the sheets (each entry's \`sheet\`) of the characters the premise names or the slate's entry needs. Never list Canon/characters/.` `character-check.md:10-12` becomes: `2. Canon/cast.json, then the \`sheet\` of EVERY named character in the script, read from the index — never Glob Canon/characters/. For a guest with no sheet, check the outline's description of them instead.` `canon-review-outline.md:7-8` and `canon-review-script.md:11,19`: "every character sheet under Canon/characters/" → "the sheets of the characters in this outline/script, found through Canon/cast.json"; `canon-review-script.md:16-17`'s `Glob Canon/**/*.md and read what's relevant` → `read the species, location and faction files the script names (Canon/species/, Canon/locations/, Canon/factions/) — Glob those three directories only`. `draft.md`'s step 7 ("Read the canon files that scene depends on (characters, locations, species, technology — as cited in the outline)") gains ", the characters through their \`sheet\` paths in Canon/cast.json".
- [x] **Step 4: Check.** `node tools/dist/check-prompts.js --prompts tools/templates/prompts --context tools/show-data/deadlight-check-context.json` after `npm run build -w tools`; `npm test -w tools`; the show-name grep over `tools/`.
- [x] **Step 5: Commit.**

```bash
git add tools/templates/prompts/
git commit -m "prompts: the cast index is read first and the sheets in play after it; nothing lists the characters directory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The migration scripts

**Files:**
- Create: `scripts/cast-index-build.py`, `scripts/cast-audit.py`, `scripts/cast-prune.py`
- Test: `scripts/tests/test_cast_migration.py`

**Interfaces:**
- `cast-index-build.py [--write] [--show-root <path>]`: reads `visual.refs` (default `Canon/refs.json`) if present, `<audio.voiceRefsDir>/refs.json` if present, and the sheets under `<visual.castingPileDir>/<Name>/<name>.md`; merges by slug into the index shape above; prints the merge as a table (key, name, kind, sheet?, face?, voice?, debut) and every conflict (two sources naming different paths for one key); exits 2 on a conflict; writes `Canon/cast.json` only with `--write` and only when there is no conflict; `debut` is `s01e01` for every merged entry unless an entry carries a `debut` already. The voice registry's top-level `engine`/`model`/`note` go to `audio`. A visual entry whose `ref` is missing on disk is kept with `face.ref` and reported.
- `cast-audit.py [--retired <path>] [--show-root <path>]`: prints every index entry's name / kind / face (ok | missing | none) / voice (locked | not-locked | silent | none) / gallery count / sheet (ok | none); with `--retired`, also scans `<retired>/Production/ep*/guest-refs/*.wav` and each episode's `tts-script.json` cast entries marked `guest`, and prints the guests not in the index with the episode, the WAV and the `ref_text`. Read-only everywhere. Exit 0.
- `cast-prune.py [--apply] [--keep <key>=<file>,<file>…] [--show-root <path>]`: for every index entry with a `face.ref` under `<castingPileDir>/<Name>/`, lists every image file in that folder (recursively, excluding the sheet markdown) and decides: the `face.ref` stays; the `gallery` entries stay (at most three — any beyond three are moved); every other image is moved to `<productionDir>/_archive/characters/<Name>/` (directories created, name collisions suffixed `-2`); prints the plan; moves only with `--apply`. A folder with no index entry is listed and left alone.

- [x] **Step 1: The failing tests** (`scripts/tests/test_cast_migration.py`), hermetic on temp show roots built by a `_show(tmp_path)` helper that writes a small `Canon/refs.json` (Vale human with ref, the Warden character with ref, Harbor location, Ghost with a missing ref), a `Production/voice-refs/refs.json` (`engine`, cast Vale LOCKED, Warden CANDIDATE), sheets `Canon/characters/Vale/vale.md` and `Canon/characters/Warden/warden.md`, and the reference PNGs:
  - build: without `--write` the index file is not created and stdout lists four keys; with `--write` the index has `vale` (face.ref, voice LOCKED, sheet, debut s01e01), `warden` (merged from `the-warden`, voice not locked), `harbor` (location, no voice), `ghost` (face.ref kept, reported missing); `audio.engine == "qwen3"`.
  - build conflict: a second fixture where `Canon/refs.json` and a sheet disagree on nothing but the voice registry names a `ref` for Vale that differs from an existing index's — exit 2, nothing written.
  - audit: on the built index prints `ghost … face missing`, `harbor … voice none`, `warden … voice not-locked`; with `--retired` pointing at a temp dir shaped `Production/ep03/guest-refs/pim-1.wav` + `Production/ep03/tts-script.json` whose cast has `Pim` with `guest: true` and a `ref_text`, prints `Pim ep03 … ref_text`.
  - prune: a Vale folder with `reference.png` (the face.ref), `gallery/01.png`, `gallery/02.png`, and five other PNGs: dry run moves nothing and prints five moves; `--apply` moves the five to `Production/_archive/characters/Vale/`, keeps the three, and a second `--apply` moves nothing; a fourth gallery image (`gallery/04.png` listed in the index) is moved and the index's `gallery` is trimmed to three.
- [x] **Step 2: Run to fail**, then write the three scripts (each with the usual `--show-root` handling through `lib.showconfig`, `sc.progress` per character, and a docstring saying what it reads and writes). `cast-index-build.py`'s sheet discovery: for each directory under `castingPileDir`, the first `*.md` whose name slug-matches the directory name; the `name` is the directory name; the key is `slug_name(name)`; a visual key `the-<slug>` and a sheet directory `The <Name>` merge to `the-<slug>` only if the visual entry used that key, else `<slug>`.
- [x] **Step 3: Run the gates**, commit:

```bash
git add scripts/cast-index-build.py scripts/cast-audit.py scripts/cast-prune.py scripts/tests/test_cast_migration.py
git commit -m "scripts: build the cast index from the two registries, audit it against the retired repository, and prune the character folders by moving

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Docs

- [x] Tick every box in this plan, write `docs/plans/2026-10-31-the-cast-index-deferred.md` (the rulings made during execution, read from the ledger; deferred: `checkGuestRefsDir` and `audio.guestRefsDir` still accepted by the loader until L2 retires them; `audio.mainCast` still read by `validate-manifest.py`; the Cast page is L2; the init scaffold does not yet write a `cast.json` for a new show — `tools/src/init` is untouched here and a new show gets its index from `cast-index-build.py` until L2 adds the scaffold), append to the spec's §7 change log: `- **<date> — Plan L1 landed.** The index, the readers, the ingestion rule, the migration scripts.` Commit:

```bash
git add docs/plans/2026-10-31-the-cast-index.md docs/plans/2026-10-31-the-cast-index-deferred.md docs/specs/2026-10-31-the-casting-stop-design.md
git commit -m "docs: the cast-index plan, its deferred record, and the spec's change log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The show's migration (controller-run, Ryan approves the prune)

Not a subagent task: the controller runs it in `~/GitHub/DeadLight2` after Tasks 1–5 are reviewed and the engine PR is open, and before the engine is rebuilt into production (the deployment-order constraint).

- [ ] **Step 1: Build.** `uv run --project ~/GitHub/Showrunner/scripts python ~/GitHub/Showrunner/scripts/cast-index-build.py` (dry), read the table, resolve any conflict by hand, then `--write`. Add `"cast": { "index": "Canon/cast.json" }` to `showrunner.json` (explicit, though it is the default).
- [ ] **Step 2: The current episode's guests.** Add `veleth` and `hallet` voice blocks from `Production/s02e01/guest-refs/` (the picked takes `veleth-2.wav`, `hallet-2.wav`, moved to `Production/voice-refs/`, `ref_text` from the sidecar `.txt`, `direction` from the manifest), `debut: "s02e01"`; `hallet`'s face is already filed; `veleth` has none (he is drawn from the species sheet; a face for him is L2's first real run).
- [ ] **Step 3: Audit.** `cast-audit.py --retired ~/GitHub/DeadLight` — read-only on the retired repository — and show Ryan the table.
- [ ] **Step 4: Promote.** For each Season 1 guest who has a face (Ansa ep03, Mardo ep04, Marle and Wella ep07, Vrask ep08): copy the WAV the retired manifest names into `Production/voice-refs/<slug>.wav`, add the voice block with that manifest's `ref_text` and `direction`, `debut` = that episode's new id (`s01e03`, `s01e04`, `s01e07`, `s01e08`), `status: "LOCKED"`. The other twenty-one Season 1 guests are listed in the deferred record, not promoted.
- [ ] **Step 5: Prune.** `cast-prune.py` (dry run) → show Ryan the plan per folder (what stays as the reference, which three gallery images, how many move) → `--apply` only on his word.
- [ ] **Step 6: Prompts.** Copy the nine changed templates from `tools/templates/prompts/` over the instance's `prompts/` (the instance has no prompt baseline; a diff of each is shown first), run `check-prompts` against the instance.
- [ ] **Step 7: Retire.** After `cast-audit.py` reports no gap the legacy files could fill, `git rm Canon/refs.json Production/voice-refs/refs.json`, remove `visual.refs`, `audio.guestRefsDir`, `audio.mainCast` from `showrunner.json` only if the loader and `validate-manifest.py` no longer read them (check Task 1/2's results; `audio.mainCast` stays), commit on a branch, open the show-side PR; after Ryan merges both PRs, rebuild production.
