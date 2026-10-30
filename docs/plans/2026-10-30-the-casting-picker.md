# The Casting Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The casting gate is a choice, not a listening test: for each guest, the candidate takes are radio buttons with the manifest's current take preselected, and Approve carries the picks into the TTS manifest before the gate is answered, so the render that follows uses what the showrunner chose.

**Architecture:** The server derives a `casting` block for the gate view from the episode's `tts-script.json` (the guest cast entries, their slug, their current reference) and accepts `picks` on the gate answer, validating each against the guest-refs directory and writing the manifest atomically before `answerGate`. The client groups the takes by guest, draws radios, and sends the picks with Approve. The engine is unchanged: `tts-generate` reads the manifest it is given, and its recorded input hashes show the change.

**Tech Stack:** Hono 4, React 18, vitest 4 (node for the server, jsdom for `test/client/*.test.tsx`), TypeScript strict / NodeNext.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` §7 (the gate is one of the console's four surfaces; the artifact the decision is about comes first). Ryan's ruling of 2026-10-30: "it was more 'listening to the choices' and less 'pick a choice' kinda page" — build the picker. Ryan's approve note of the same day ("approved, hallet2 and veleth2") was read by nothing, and the render ran with the wrong takes; that is the defect this plan closes.

## Global Constraints

- **No show's name in `console/`**; fixtures use Harbor Lights (Vale, the Warden, Pim, Maeve, Harbor). `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=public` must print nothing.
- **The engine is not modified.**
- **Every path the server touches goes through `resolveArtifactPath`** (`console/server/artifacts.ts`); the manifest is written with `writeAtomically` from the same file.
- **A read-only show's POST is refused by the existing middleware (403)**; handlers do not re-check.
- **The gate is answered only after the manifest write succeeded**; a refused or failed pick leaves the manifest unchanged and the gate open.
- **Typecheck and tests green at every commit:** `npm run typecheck -w console`, `npm test -w console`.
- **Commits end with exactly one trailer:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The casting block on the gate view, and picks on the answer

**Files:**
- Modify: `console/shared/types.ts` (`GateView.casting`, `CastingGuest`)
- Modify: `console/server/gates.ts` (`castingOf`, wired into `gateView`)
- Modify: `console/server/app.ts` (the gate answer POST at ~line 802: `picks`)
- Modify: `console/server/artifacts.ts` (export `applyCastingPicks`)
- Test: `console/test/gates.test.ts` (the casting block), `console/test/casting-picks.test.ts` (the answer)

**Interfaces:**
- Consumes: `gateView(ctx, store, episodeId, runId)`; `resolveArtifactPath(ctx, episodeId, showRelative)`; `writeAtomically(abs, text)`; `answerGate(log, runId, stepId, {approved, notes, by, expectedAttempt})`; `readLock`; `checkIds`, `readJsonBody`, `logOf`, `spawnWorker` in `app.ts`; the manifest's shape `{ cast: { [name]: { ref: string; guest?: boolean; … } }, segments: […] }`.
- Produces: `CastingGuest = { name: string; slug: string; current: string }` and `GateView.casting?: { dir: string; guests: CastingGuest[] }` (present only on `casting-gate`, `dir` show-relative, e.g. `Production/s02e01/guest-refs`); the gate answer body accepts `picks?: Record<string, string>` (guest name → show-relative WAV path) and answers 400 `{error}` for a bad pick; `applyCastingPicks(ctx, episodeId, picks): Promise<{ ok: true; applied: Record<string,string> } | { ok: false; error: string }>`.

- [x] **Step 1: Types.** In `console/shared/types.ts`, beside `GateView`:

```ts
/** One guest at the casting gate: the manifest's cast key (`name`), the slug the takes are named
 *  by (`veleth-1.wav` → `veleth`; the TTS script prompt's convention, the name lowercased with
 *  hyphens), and the reference the manifest currently casts them from (show-relative). */
export interface CastingGuest { name: string; slug: string; current: string }
```

and in `GateView`, after `round?`:

```ts
  /** On `casting-gate` only: the guests the takes are for, so the page can draw a choice per
   *  guest and Approve can carry it (Ryan, 2026-10-30). `dir` is the guest-refs directory,
   *  show-relative, which every pick must lie inside. Absent at every other gate, and absent when
   *  the manifest cannot be read, in which case the page lists the takes as before. */
  casting?: { dir: string; guests: CastingGuest[] };
```

- [x] **Step 2: The failing tests.** In `console/test/gates.test.ts`, inside the existing describe, add:

```ts
  it("at the casting gate, names each guest with the take the manifest casts them from", async () => {
    const casting = await parkedAt("casting-gate");
    await writeIn(casting.root, "Production/s02e01/tts-script.json", JSON.stringify({
      episode: "s02e01", engine: "qwen3",
      cast: {
        narrator: { ref: "Production/voice-refs/narrator.wav", ref_text: "x" },
        Vale: { ref: "Production/voice-refs/vale.wav", ref_text: "x" },
        "Dockmaster Hale": { ref: "Production/s02e01/guest-refs/dockmaster-hale-1.wav", ref_text: "x", guest: true },
        Pim: { ref: "Production/s02e01/guest-refs/pim-2.wav", ref_text: "x", guest: true },
      },
      segments: [],
    }));
    const view = (await gateView(casting.ctx, casting.store, "s02e01", "r1"))!;
    expect(view.casting).toEqual({
      dir: "Production/s02e01/guest-refs",
      guests: [
        { name: "Dockmaster Hale", slug: "dockmaster-hale", current: "Production/s02e01/guest-refs/dockmaster-hale-1.wav" },
        { name: "Pim", slug: "pim", current: "Production/s02e01/guest-refs/pim-2.wav" },
      ],
    });
    casting.store.close();
  });

  it("carries no casting block at another gate, or when the manifest is missing", async () => {
    const script = await parkedAt("script-gate");
    expect((await gateView(script.ctx, script.store, "s02e01", "r1"))!.casting).toBeUndefined();
    script.store.close();
    const casting = await parkedAt("casting-gate");
    expect((await gateView(casting.ctx, casting.store, "s02e01", "r1"))!.casting).toBeUndefined();
    casting.store.close();
  });
```

Create `console/test/casting-picks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appWith, makeShow, seedRun, writeIn, type SeedEvent } from "./helpers.js";

const GATE = "/api/shows/show/episodes/s02e01/runs/r1/gate";
const MANIFEST = "Production/s02e01/tts-script.json";
const REFS = "Production/s02e01/guest-refs";

async function parkedAtCasting() {
  const { root, app, ctx, store } = await appWith(await makeShow());
  await seedRun(root, "s02e01", "r1", [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
    { stepId: "casting-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve casting-gate." } },
  ] as SeedEvent[]);
  await writeIn(root, MANIFEST, JSON.stringify({
    episode: "s02e01", engine: "qwen3",
    cast: {
      narrator: { ref: "Production/voice-refs/narrator.wav", ref_text: "x" },
      Pim: { ref: `${REFS}/pim-1.wav`, ref_text: "x", guest: true },
      Maeve: { ref: `${REFS}/maeve-1.wav`, ref_text: "x", guest: true },
    },
    segments: [],
  }));
  for (const f of ["pim-1.wav", "pim-2.wav", "maeve-1.wav", "pim.txt"]) await writeIn(root, `${REFS}/${f}`, "RIFF");
  return { root, app, ctx, store };
}

const answer = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
  app.request(GATE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function manifest(root: string): Promise<{ cast: Record<string, { ref: string }> }> {
  return JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as { cast: Record<string, { ref: string }> };
}

describe("picks on the casting gate's answer", () => {
  it("writes each pick into the manifest before answering the gate", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(200);
    const m = await manifest(root);
    expect(m.cast["Pim"]?.ref).toBe(`${REFS}/pim-2.wav`);
    expect(m.cast["Maeve"]?.ref).toBe(`${REFS}/maeve-1.wav`);
    expect(m.cast["narrator"]?.ref).toBe("Production/voice-refs/narrator.wav");
    const { events } = await store.get("s02e01", "r1");
    expect(events.some((e) => e.kind === "gate_answered")).toBe(true);
    store.close();
  });

  it("refuses a pick for a name that is not a guest, and leaves the manifest and the gate alone", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { narrator: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not a guest");
    expect((await manifest(root)).cast["narrator"]?.ref).toBe("Production/voice-refs/narrator.wav");
    expect((await store.get("s02e01", "r1")).events.some((e) => e.kind === "gate_answered")).toBe(false);
    store.close();
  });

  it("refuses a pick outside the guest-refs directory, a non-audio file, and a file that does not exist", async () => {
    const { app, store } = await parkedAtCasting();
    for (const bad of ["Production/voice-refs/narrator.wav", `${REFS}/pim.txt`, `${REFS}/pim-9.wav`, "Canon/world-overview.md"]) {
      const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: bad } });
      expect(res.status, bad).toBe(400);
    }
    store.close();
  });

  it("refuses picks at any gate but the casting gate", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "script-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve script-gate." } },
    ] as SeedEvent[]);
    const res = await answer(app, { stepId: "script-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("casting-gate");
    store.close();
  });

  it("answers without picks exactly as before", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: false, notes: "none of these", expectedAttempt: 1 });
    expect(res.status).toBe(200);
    expect((await manifest(root)).cast["Pim"]?.ref).toBe(`${REFS}/pim-1.wav`);
    store.close();
  });
});
```

Read `console/test/helpers.ts` for `appWith`'s exact return names and for whether `seedRun`'s events need `ts`; adapt names, keep the assertions. The worker these tests spawn on an answer is the fixture's fake worker (`FAKE_WORKER` in helpers), as in `app.test.ts`'s gate tests — read how those tests handle the spawn and do the same.

- [x] **Step 3: Run them to fail.** `npm test -w console -- test/gates.test.ts test/casting-picks.test.ts` — expected: the casting block is undefined; the picks are silently ignored (200 with the manifest unchanged) or 400 from a type error.

- [x] **Step 4: The casting block.** In `console/server/gates.ts` add, and call from `gateView` when `gate.stepId === "casting-gate"` (spread `...(casting !== undefined ? { casting } : {})` into the returned object):

```ts
/** The guest slug the takes are named by: the cast name lowercased, runs of anything but letters
 *  and digits as one hyphen — the TTS script prompt's own rule ("Dockmaster Hale" → dockmaster-hale). */
export function guestSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The casting gate's guests from the episode's manifest, or undefined when there is no manifest to
 *  read or it has no guests — the page then lists the takes without a choice, as it did before. */
export async function castingOf(ctx: ShowContext, episodeId: string): Promise<GateView["casting"]> {
  const manifestRel = `${ctx.productionDir}/${episodeId}/tts-script.json`;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path.join(ctx.showRoot, manifestRel), "utf8")); } catch { return undefined; }
  const cast = (parsed as { cast?: unknown })?.cast;
  if (typeof cast !== "object" || cast === null) return undefined;
  const guests: CastingGuest[] = [];
  for (const [name, entry] of Object.entries(cast as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { ref?: unknown; guest?: unknown };
    if (e.guest !== true || typeof e.ref !== "string") continue;
    guests.push({ name, slug: guestSlug(name), current: e.ref });
  }
  if (guests.length === 0) return undefined;
  return { dir: `${ctx.productionDir}/${episodeId}/guest-refs`, guests };
}
```

(`readFile` from `node:fs/promises`; `CastingGuest` from `../shared/types.js`.)

- [x] **Step 5: Applying picks.** In `console/server/artifacts.ts` add:

```ts
/** Writes the casting gate's picks into the manifest: `cast[<guest>].ref = <take>`. Every pick is
 *  checked before anything is written — the name must be a guest in the manifest, the take must
 *  lie inside the episode's guest-refs directory, be audio, and exist — so a bad pick refuses the
 *  whole answer and the manifest on disk is untouched. The write is atomic (`writeAtomically`), so
 *  tts-generate never reads a half-written manifest. The engine sees the change as an input-hash
 *  change on tts-generate; nothing else records it. */
export async function applyCastingPicks(
  ctx: ShowContext, episodeId: string, picks: Record<string, string>,
): Promise<{ ok: true; applied: Record<string, string> } | { ok: false; error: string }> {
  const manifestRel = `${ctx.productionDir}/${episodeId}/tts-script.json`;
  const manifestAbs = path.join(ctx.showRoot, manifestRel);
  let parsed: { cast?: Record<string, { ref?: unknown; guest?: unknown }> };
  try { parsed = JSON.parse(await readFile(manifestAbs, "utf8")) as typeof parsed; } catch (err) {
    return { ok: false, error: `${manifestRel} could not be read: ${(err as Error).message}` };
  }
  const cast = parsed.cast ?? {};
  const refsPrefix = `${ctx.productionDir}/${episodeId}/guest-refs/`;
  const applied: Record<string, string> = {};
  for (const [name, take] of Object.entries(picks)) {
    const entry = cast[name];
    if (entry === undefined || entry.guest !== true) return { ok: false, error: `${JSON.stringify(name)} is not a guest in ${manifestRel}` };
    if (typeof take !== "string" || !take.startsWith(refsPrefix)) return { ok: false, error: `the take for ${name} must be a file under ${refsPrefix}` };
    if (!/\.(wav|mp3|flac|m4a|ogg|aac)$/i.test(take)) return { ok: false, error: `the take for ${name} is not an audio file: ${take}` };
    const fenced = resolveArtifactPath(ctx, episodeId, take);
    if (!fenced.ok) return { ok: false, error: fenced.error };
    if ((await hashFile(fenced.abs)) === null) return { ok: false, error: `the take for ${name} does not exist: ${take}` };
    applied[name] = take;
  }
  for (const [name, take] of Object.entries(applied)) (cast[name] as { ref: string }).ref = take;
  await writeAtomically(manifestAbs, JSON.stringify(parsed, null, 1) + "\n");
  return { ok: true, applied };
}
```

(`hashFile` from `@showrunner/engine`, already imported in `app.ts`; import it here too.) Note the manifest is rewritten with `JSON.stringify(parsed, null, 1)`, the same one-space indent `tts-generate.py` writes its own json with — check `scripts/tts-generate.py`'s `json.dump(..., indent=1)` and match it, so a pick does not reformat the file.

- [x] **Step 6: The route.** In `console/server/app.ts`'s gate answer handler (~line 802), after the body validation and before the lock check, add:

```ts
    const picks = body["picks"];
    if (picks !== undefined) {
      if (typeof picks !== "object" || picks === null || Array.isArray(picks)) return c.json({ error: "picks must be an object of guest name to take path" }, 400);
      const view = await gateView(ctx, c.get("store"), id, run);
      if (view === undefined || view.stepId !== "casting-gate") return c.json({ error: "picks are accepted only at casting-gate" }, 400);
      if (stepId !== "casting-gate") return c.json({ error: "picks are accepted only at casting-gate" }, 400);
    }
```

and after the lock check and **before** `answerGate`:

```ts
    if (picks !== undefined && Object.keys(picks as object).length > 0) {
      const applied = await applyCastingPicks(ctx, id, picks as Record<string, string>);
      if (!applied.ok) return c.json({ error: applied.error }, 400);
    }
```

The doc comment on the handler gains a sentence: picks are written before the answer, so a refused pick leaves the gate open.

- [x] **Step 7: Run the tests.** `npm test -w console -- test/gates.test.ts test/casting-picks.test.ts`, then `npm test -w console && npm run typecheck -w console`.

- [x] **Step 8: Commit.**

```bash
git add console/shared/types.ts console/server/gates.ts console/server/artifacts.ts console/server/app.ts console/test/gates.test.ts console/test/casting-picks.test.ts
git commit -m "console: the casting gate names its guests, and the answer carries the picks into the manifest

The gate view at casting-gate carries each guest with the take the manifest casts them from,
and the gate answer accepts picks (guest name to take path). Every pick is checked — a guest,
inside guest-refs, audio, present — before the manifest is rewritten atomically, and the gate
is answered only after that write, so a bad pick leaves both untouched. Ryan's approve note
naming the takes he wanted was read by nothing (2026-10-30); this is the path that reads it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The choice on the page

**Files:**
- Modify: `console/src/pages/Gate.tsx` (`AudioArtifact` takes `casting` and reports picks; Approve sends them)
- Modify: `console/src/console.css` (`.cast-guest`, `.cast-take`)
- Test: `console/test/client/gate-page.test.tsx`

**Interfaces:**
- Consumes: Task 1's `GateView.casting` and the answer body's `picks`; `AUDIO_FILE`, `transcriptFor` in `Gate.tsx`.
- Produces: at the casting gate, one fieldset per guest with a radio per take; `picks` state keyed by guest name; Approve posts `picks` with the answer; Reject does not.

- [x] **Step 1: The failing test.** In `console/test/client/gate-page.test.tsx`, add a casting fixture and two tests (use the file's `mount(view, console_)` helper and `stubFetch` pattern; extend `stubFetch` to answer the guest-refs listing url and `/gate` POST):

```tsx
  it("at the casting gate, offers each guest's takes as a choice with the manifest's take preselected", async () => {
    stubFetch(castingView());
    mount(castingView());
    const veleth = await screen.findByRole("group", { name: /Pim/ });
    const radios = within(veleth).getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["Production/s02e01/guest-refs/pim-1.wav", "Production/s02e01/guest-refs/pim-2.wav"]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
  });

  it("sends the picks with Approve, and not with Reject", async () => {
    const fetchMock = stubFetch(castingView());
    mount(castingView());
    const group = await screen.findByRole("group", { name: /Pim/ });
    fireEvent.click(within(group).getByLabelText("pim-2.wav"));
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((postCall[1] as RequestInit).body))).toMatchObject({ approved: true, picks: { Pim: "Production/s02e01/guest-refs/pim-2.wav" } });
  });
```

where `castingView()` is a `GateView` with `stepId: "casting-gate"`, `artifacts: [{ kind: "audio", label: "guest-refs/", path: "Production/s02e01/guest-refs", url: REFS_URL, listUrl: REFS_URL }]`, and `casting: { dir: "Production/s02e01/guest-refs", guests: [{ name: "Pim", slug: "pim", current: "Production/s02e01/guest-refs/pim-1.wav" }] }`; the listing stub answers `{ entries: [{ name: "pim-1.wav", size: 1, isDir: false }, { name: "pim-2.wav", size: 1, isDir: false }, { name: "pim.txt", size: 1, isDir: false }] }` and the `.txt` url answers its text. `within` comes from `@testing-library/react`. The Reject half: click Reject instead and assert the POST body has no `picks` key.

- [x] **Step 2: Run it to fail.** `npm test -w console -- test/client/gate-page.test.tsx`.

- [x] **Step 3: The page.** In `Gate.tsx`:
  - `Gate()` gains `const [picks, setPicks] = useState<Record<string, string>>({});` and seeds it when the view arrives: `useEffect(() => { const c = gate.data?.casting; if (c) setPicks(Object.fromEntries(c.guests.map((g) => [g.name, g.current]))); }, [gate.data?.casting]);`
  - `answer(approved)` posts `{ stepId, approved, notes, expectedAttempt, ...(approved && view.casting ? { picks } : {}) }`.
  - `AudioArtifact` takes `casting?: GateView["casting"]`, `picks`, `onPick(name, take)`. When `casting` is present, group the takes: for each guest, the takes whose `transcriptFor(name)` stem equals `${guest.slug}.txt` (i.e. `transcriptFor(take.name) === `${guest.slug}.txt``); render:

```tsx
<fieldset className="cast-guest" key={guest.name}>
  <legend>{guest.name}</legend>
  {takes.map((entry) => {
    const take = `${artifact.path}/${entry.name}`;
    const id = `pick-${guest.slug}-${entry.name}`;
    return (
      <div className="cast-take" key={entry.name}>
        <label htmlFor={id}><input id={id} type="radio" name={`pick-${guest.slug}`} value={take} checked={picks[guest.name] === take} onChange={() => onPick(guest.name, take)} /> {entry.name}</label>
        <AudioSeek src={`${artifact.url}/${encodeURIComponent(entry.name)}`} label={entry.name} />
        {transcripts.has(txt) && <Transcript url={…} />}
      </div>
    );
  })}
</fieldset>
```

    Takes matching no guest render as before, after the fieldsets. The preselected take is matched by path equality with `guest.current`; if `current` names a file not in the listing, no radio is checked and a `quiet` line under the legend says `the manifest casts ${basename(current)}, which is not in this directory`.
  - Beside Approve, when `view.casting` is present: `<p className="quiet">Approve casts {guests.map((g) => `${g.name} from ${basename(picks[g.name] ?? g.current)}`).join(", ")}.</p>`.
  - `GateArtifact.path` exists (Task 1 of the gate editor); `artifact.path` for the directory is `Production/s02e01/guest-refs`.
  - CSS: `.cast-guest { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.9rem; margin: 0.6rem 0; } .cast-guest > legend { font-weight: 600; padding: 0 0.3rem; } .cast-take { margin: 0.3rem 0; } .cast-take label { display: inline-flex; align-items: center; gap: 0.4rem; min-height: var(--tap); }`.

- [x] **Step 4: Run the tests.** `npm test -w console -- test/client/gate-page.test.tsx`, then `npm test -w console && npm run typecheck -w console`.

- [x] **Step 5: The spec's change log** (`docs/specs/2026-09-25-console-rewrite-design.md` §8):

```markdown
- **2026-10-30 — the casting picker.** The casting gate is a choice: each guest's takes are radio buttons with the manifest's take preselected, and Approve carries the picks into `tts-script.json` (checked, atomic, before the gate is answered). An approve note naming takes had been read by nothing. Engine unchanged.
```

- [x] **Step 6: Commit.**

```bash
git add console/src/pages/Gate.tsx console/src/console.css console/test/client/gate-page.test.tsx docs/specs/2026-09-25-console-rewrite-design.md
git commit -m "console: the casting gate is a choice — a radio per take, per guest, and Approve carries the picks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
