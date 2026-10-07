# The Console Side of Setup Implementation Plan (Plan H)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine's console many shows and a way to start one. A **registry** lets one server hold every show on the machine, each at its own URL, with the retired first repository listed read-only beside the live instance. A **New-show surface** runs Plan G's setup from the browser: a form names the show, the scaffold is written and registered at once, each bible file's questions are a form whose answers land on disk the moment they are saved, each file's writing runs in a detached setup worker exactly as an episode step does, and each gate is answered in the console with the four answers the terminal offers. A **Bible view** shows every show's fifteen bible files and their state, whether the interview ran in the terminal or in the browser. Two Plan F deferrals close: the run view no longer invents a pending pipeline for a run that does not exist, and the references guard refuses an outline with no readable `## Cast` section. The client gets its first render test.

**Architecture:** The registry is a file outside every repository, `~/.showrunner/shows.json`, keyed by an operator-chosen name (the directory's basename by default) because the only identity fields a show config carries — `showName`, `showSlug` — are identical for the two shows on this machine, and so is their NAS root. The server builds one `ShowContext` and one `RunStore` per registered show at startup and resolves the show from the URL (`/api/shows/:show/…`, `/shows/:show/…`) through one middleware, so the twenty-two signatures that take `ctx: ShowContext` keep their shape; the SSE channel's messages carry the show key. The server still owns no run: the interview's writing step runs in a **second worker entry**, `console/worker/setup.ts`, built on the same lock and heartbeat as the episode worker, with its prompts directory pointed at the engine's interview templates; the author's answers are written to `Production/setup/<key>/answers.md` by the server as a one-shot write like `premise.md`; the gate is answered through the engine's `answerGate` plus a fresh worker, as an episode gate is. The Bible view is **its own route family** (`/api/shows/:show/bible…`) with a small projection of its own, because the reserved id `setup` is refused by twenty-seven episode-shaped sites and the artifact fence excludes `Canon/` by design; the one new fence admits exactly the fifteen files `BIBLE_FILES` names. The pieces of `runInit` the browser needs — the scaffold, the per-file commit and cast step, the finish — become exported phases of `@showrunner/tools`, and the terminal `init` is recomposed from them unchanged.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), Hono 4, React 18, React Router 7 (stays — v8 requires React 19), Vite 6, vitest 4; `jsdom` and `@testing-library/react` for the first render test; the engine and tools as workspace dependencies. Python only for one two-word message.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §4.2 and §4.4 (detached execution; the fences), §6.5–§6.9 (the log as source of truth; restart by replay), §7.2–§7.3 (the four surfaces and what is deferred; the console in the engine repository), §9.2–§9.4 (the interview; "Plan E's console puts a New-show surface over it"). **The inventory this plan is written from:** `docs/plans/2026-10-07-plan-h-inventory.md` — the console's 72 single-show sites and 18 routes (§1), the registry measured against both configs (§2), `runInit` and `InitIO` measured (§3), the interview's runs (§4), the two deferrals (§5), the smaller items (§6), and 21 findings (§7). **The obligations this plan pays:** Plan E's O-05 and Plan G's F-25 (the registry and the surface), Plan F's two deferrals, and the Plan H sections of the three records.

**Rulings that shaped this plan.** Ryan ruled on 2026-10-07 ("B") that Plan H builds the **full surface** — the interview in the browser — not only a viewer. The router stays at 7 (H-11: v8 is a React major). The retired repository is a registry entry **read-only** (H-02, H-03: one launch there would write over the instance's finals on the NAS).

## Rulings on the inventory's findings (made 2026-10-07; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| H-01 the registry's shape | **A registry file, `~/.showrunner/shows.json`** (`--registry <path>` overrides), because it is the only option the New-show surface can append to and the only one that carries a chosen key. `--show <root>` keeps working as a one-show registry whose key is the root's basename, writing nothing. |
| H-02 `showSlug` cannot key a show | **The key is the operator's** — the directory basename by default, overridable in the form and the file — and the URL carries it: `/shows/<key>/…`. The NAS collision is answered by `readOnly`: a read-only entry refuses every POST. |
| H-03 the retired repository as a second show | **Registered read-only** in the live check; its `ep98`/`ep99` rows read `NEEDS_IDEA · no runs` with no launch button (read-only hides the button entirely). The seven desk prompts render; nothing changes there. |
| H-04 where the interview runs | **A detached setup worker per file** (`console/worker/setup.ts`); the server writes the answers file and the commits, as it writes `premise.md`, and spawns the worker. An interview never runs in the server process. Two tabs cannot collide: the lock beside the bible log refuses a second worker. |
| H-05 what the surface shows while waiting | The setup run's events streamed over SSE (`{type: "setup", show, key, runId, offset}`), a step rail of the file's one or two steps, and the gate when it opens: the message and the whole file, as the terminal shows them; the four answers as buttons. |
| H-06 resume in the browser | **No new persistence.** The Bible view reads `answers.md` (prefilling the form), the latest log (the state) and the file; closing a tab loses nothing; a second visit continues. |
| H-07 `setup` reaches nothing; the fence | **Its own route family** (`/api/shows/:show/bible…`) and its own projection; the twenty-seven episode-shaped sites are untouched. One new fence: `GET …/bible/:key/file` serves exactly `<canonDir>/<BIBLE_FILES[key].file>` and nothing else. |
| H-08 the archived run view | **404 for a run id with no log file**, worded as the log route already words it; the launch route creates the log before spawning, so the launch window is not affected. |
| H-09 `refs-ready` passes vacuously | **It refuses**: `missingRefs` reports "the outline has no readable `## Cast` section" for both shapes (absent, or present with nothing parseable), and the guard turns that into `NEEDS_REFS`. The one test that locked the pass changes; the ep98 exercise is seeded past the guard; the Season 1 archives are never run. |
| H-10 the first render test | `jsdom` + `@testing-library/react`, `include` gains `test/**/*.test.tsx`, `environment` per file; `ProgressBar.tsx` first, then the Bible page's pure projection. |
| H-11 the router | **Stays at 7.18.4.** Recorded: v8 removes `react-router-dom` and requires React 19. |
| H-12 the SSE channel | `run` and `episodes` gain `show`; `hello` carries `shows: [{key, name, readOnly}]`; the client validates the new field and filters by the show it is viewing. |
| H-13 `--setup` mode or a second entry | **A second entry**, with the lock, heartbeat and signal handling extracted into `console/worker/lock.ts` and shared. |
| H-14 a bad config takes the Board down | **The Board gathers rows per show with per-show failure** (a show whose rows throw becomes one error row naming the reason), `createApp` gains an `onError` that answers JSON, and `loadShowConfig` validates `audio.guestRefsDir` when present (a non-empty string carrying `{episodeId}`), so the refusal lands at load. |
| H-15 `gateArtifacts` returns `[]` for a bible gate | The Bible view's gate shows the file itself (its one artifact) through its own route; `gateArtifacts` is not touched. |
| H-16 drift | **A recorded baseline:** `init` writes `prompts/.templates-baseline.json` (the sha256 of each prompt template as copied) and `check-prompts --baseline` reports which files differ from the engine's current templates and which from the baseline (a show's own edits). The bible has no baseline (every file differs by design). Last, cut-able. |
| H-17 the Board titles | Left as the files' own first lines. |
| H-18 the `init` IO on a TTY | Recorded; the browser path is the one this plan tests. |
| H-19 `tts-script.md:141` | The template renders `{{show.audio.guestRefsDir}}` instead of the literal; the instance's copy is the show's and is recorded, not edited. |
| H-20 `publish-kit.py`'s reminder | The two words corrected: the reminder says the name is not written anywhere until the key is filled. |
| H-21 not taken | The season map, the desk, discuss, notes, the standalone buttons: refused in writing, as spec §7.2 lists them. |

## Global Constraints

- **One repository, one branch.** All work is on branch `plan-h` in `~/GitHub/Showrunner` (cut from `main` at 12e2eaa; the inventory is abb9b6e). The live instance `~/GitHub/DeadLight2` and the retired repository `~/GitHub/DeadLight` are read during the live check (Task 9) and **never written by this plan** — the retired repository's `git status --porcelain` prints its two untracked lines before and after, and console v1 on port 4400 is not stopped. The live check's own writes go to a scratch show under the session scratchpad and to the registry file, which Task 9 restores afterwards.
- **No show's name in the engine** (spec §7.4): after every task, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. Fixtures use "Harbor Lights" (slug `HarborLights`; Vale, the Warden, Pim, Maeve; Harbor). The registry file and the live-check report may name shows; they are outside the grep's paths.
- **The server owns no run** (spec §4.2; Plan E): every step runs in a detached worker; the server's writes outside the run log are `premise.md`, the registry file, a new show's scaffold and its commits, and `Production/setup/<key>/answers.md` — each named in the console README.
- **The fences of spec §4.4:** argv arrays only; every show key, episode id, bible key and run id validated before it reaches a path or a process (a show key is `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`; a bible key is one of `BIBLE_FILES`); a new show's `path` is resolved and refused when it is inside the engine root or inside any registered root; the bible file route serves only the file `BIBLE_FILES` names for the key; a read-only show refuses every POST with 403.
- **`exactOptionalPropertyTypes` respected; every exported symbol carries a doc comment that says why; never a directory as a declared path.**
- **Every commit ends with this trailer line in its final paragraph** (use `git commit -F -` with a heredoc): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Gates: `cd engine && npx vitest run && npm run typecheck`; `npm run build -w engine && npm run build -w tools` from the root; `cd tools && npx vitest run && npm run typecheck`; `cd console && npx vitest run && npm run typecheck && npm run build`; `cd scripts && uv run pytest -q`; `npm audit --json` total 0. All clean before every commit that touches them; report the numbers printed, never a prediction.

---

## File Structure

```
~/GitHub/Showrunner/
  engine/src/needs.ts                    MODIFY (Task 1): missingRefs reports an unreadable ## Cast
  engine/src/show-config.ts              MODIFY (Task 1): audio.guestRefsDir validated at load; SHOW_CONFIG_KEYS row
  engine/src/pipelines/episode.ts        (unchanged: the guard already turns a non-empty list into NEEDS_REFS)
  engine/test/needs.test.ts, show-config.test.ts, episode-pipeline.test.ts   MODIFY (Task 1)
  README.md                              MODIFY (Tasks 1, 8): the refs contract; "Shows and the registry"; "The Bible view"; "Starting a show from the console"
  tools/package.json                     MODIFY (Task 2): "main"/"exports" → dist/index.js
  tools/src/index.ts                     NEW (Task 2): the library surface
  tools/src/init/init.ts                 MODIFY (Task 2): runInit = initScaffold + per-file loop + initFinish; afterFileApproved
  tools/src/init/interview.ts            MODIFY (Task 2): buildVars, writeAnswers, readAnswers, questionsFor exported
  tools/src/check-prompts.ts, tools/src/init/scaffold.ts   MODIFY (Task 8): the baseline
  console/package.json                   MODIFY: @showrunner/tools dependency; jsdom, @testing-library/react (Task 7)
  console/server/registry.ts             NEW (Task 3): the registry file, --show single mode, keys, readOnly
  console/server/show.ts                 MODIFY (Task 3): loadShowContext per entry; ShowContext gains key, readOnly
  console/server/main.ts                 MODIFY (Task 3): --registry; one RunStore per show; the shows map
  console/server/app.ts                  MODIFY (Tasks 3, 5, 7): /api/shows, the :show prefix + middleware, onError, the bible routes, the 404
  console/server/runs.ts                 MODIFY (Tasks 3, 5): show-keyed SSE; setup logs tailed; SetupRunView
  console/server/episodes.ts             MODIFY (Task 3): per-show failure row
  console/server/bible.ts                NEW (Task 5): the Bible projection, the answers write, the file fence, spawnSetupWorker
  console/worker/lock.ts                 NEW (Task 5): the lock, heartbeat and signals, extracted from main.ts
  console/worker/main.ts                 MODIFY (Task 5): uses lock.ts
  console/worker/setup.ts                NEW (Task 5): the setup worker entry
  console/shared/types.ts                MODIFY (Tasks 3, 5): ShowInfo list, SseMessage show + setup, BibleRow, BibleFileView, SetupRunView
  console/src/api.ts                     MODIFY (Tasks 4, 6): show-prefixed calls; parseMessage; the bible calls
  console/src/App.tsx, main.tsx           MODIFY (Tasks 4, 6): /shows/:show/… routes; / = Shows; /shows/new; /shows/:show/bible
  console/src/pages/Shows.tsx            NEW (Task 4)
  console/src/pages/{Board,Run,Gate,WhatHappened}.tsx, projections.ts, useDocTitle.ts   MODIFY (Task 4): the show in links and titles
  console/src/pages/NewShow.tsx, Bible.tsx   NEW (Task 6)
  console/vitest.config.ts               MODIFY (Task 7): include .test.tsx; jsdom per file
  console/test/registry.test.ts, bible.test.ts, setup-worker.test.ts, app.test.ts (updated paths), client/ProgressBar.test.tsx, client/bible-projection.test.tsx
  console/test/fixtures/fake-setup-worker.mjs   NEW (Task 5)
  scripts/publish-kit.py                 MODIFY (Task 8): two words
  tools/templates/prompts/tts-script.md  MODIFY (Task 8): the guest-refs key rendered
  docs/plans/2026-10-07-the-console-side-of-setup-deferred.md   NEW (by the controller, at the end)
```

---

## Task 1: Engine — the references guard refuses an outline with no readable `## Cast`, and `audio.guestRefsDir` is validated at load

**Files:** modify `engine/src/needs.ts`, `engine/src/show-config.ts`, `README.md` (the `missingRefs` contract paragraph); tests `engine/test/needs.test.ts`, `engine/test/show-config.test.ts`, `engine/test/episode-pipeline.test.ts`.

**Interfaces:** `missingRefs(showRoot, episodeId, show): Promise<string[]>` — unchanged signature; a new first-position message `the outline has no readable ## Cast section (write one line per subject as "- <Name> (<tags>)")` when the section is absent or holds nothing parseable. `loadShowConfig` throws `ShowConfigError` naming `audio.guestRefsDir` when the key is present and is not a non-empty string containing `{episodeId}`; the `needs.ts` runtime refusals stay as a second line of defence.

- [ ] **Step 1: Failing tests.** In `needs.test.ts`: the test "is empty without a cast section" becomes "names the missing cast section" asserting the message above as the only entry; a second test with `## Cast` present and only prose lines asserts the same message; the guard test in `episode-pipeline.test.ts` (if any asserts `all references present` on a cast-less outline) is updated — the walk fixture already carries `## Cast` and stays green. In `show-config.test.ts`: a config with `audio.guestRefsDir: "Production/guest-refs"` is refused at load naming the key; `""` is refused; absent loads; `"Production/{episodeId}/guest-refs"` loads.
- [ ] **Step 2: Implement.** `needs.ts:110`'s early return becomes the message; the doc comment at `:97-104` and `README.md:426-427` say the probe refuses, and why ("the canon reviewer flags it; a guard must refuse it, or synthesis runs with an unchecked cast"). `show-config.ts`: inside `loadShowConfig`, after the `audio` group is read, validate `guestRefsDir` when present; `SHOW_CONFIG_KEYS`'s row gains "validated at load".
- [ ] **Step 3: Gates;** commit `engine: the references guard refuses an outline with no readable cast; guestRefsDir is validated at load`.

---

## Task 2: Tools — `init` becomes a library the console can call in phases

**Files:** create `tools/src/index.ts`; modify `tools/package.json` (`"main": "./dist/index.js"`, `"exports": {".": "./dist/index.js"}`), `tools/src/init/init.ts`, `tools/src/init/interview.ts`; tests `tools/test/init.test.ts` (the CLI's behaviour unchanged — the existing tests prove it), `tools/test/init-phases.test.ts` (new).

**Interfaces (produced, consumed by Tasks 5 and 6):**
```ts
// tools/src/index.ts re-exports:
export { initScaffold, afterFileApproved, initFinish, runInit, slugFrom } from "./init/init.js";
export type { InitOptions, InitDeps, InitReport, ScaffoldResult, FinishResult } from "./init/init.js";
export { interviewFile, isApproved, questionsFor, readAnswers, writeAnswers, buildVars, latestSetupLog, interviewPromptsDir, GATE_CHOICES } from "./init/interview.js";
export type { InitIO, InterviewResult, GateChoice, Question } from "./init/interview.js";
export { templatesDir } from "./init/paths.js";
export { parseCanonTemplate, templateWithoutQuestions, writeCastSheets } from "./init/scaffold.js";
// init.ts
export interface ScaffoldResult { root: string; config: Record<string, unknown>; commits: string[] }
export function initScaffold(opts: InitOptions, io: InitIO, deps?: InitDeps): Promise<ScaffoldResult>;   // validate, mkdir, config, scaffold, git init, the scaffold commit, scaffold-mode imports
export function afterFileApproved(root: string, entry: BibleFile, result: InterviewResult, deps?: InitDeps): Promise<string[]>;  // the cast sheets + mainCast after world-overview; the per-file commit; returns the shas
export interface FinishResult { stalled: string[]; remote?: string; nextSteps: string; bibleCheck: { missingFiles: string[]; missingSections: {file: string; heading: string}[] } }
export function initFinish(root: string, opts: Pick<InitOptions, "github" | "engineRoot">, io: InitIO, deps?: InitDeps): Promise<FinishResult>;  // bible-check report, gh or the printed command, nextSteps
// interview.ts
export interface Question { heading: string; question: string }
export function questionsFor(entry: BibleFile): Promise<Question[]>;           // from the canon template
export function readAnswers(showRoot: string, entry: BibleFile, productionDir?: string): Promise<Record<string, string>>;   // prior answers by heading, {} when none
export function writeAnswers(showRoot: string, entry: BibleFile, answers: Record<string, string>, productionDir?: string): Promise<string>;  // the whole file rewritten; returns the relative path
export function buildVars(showRoot: string, entry: BibleFile, now: Date, productionDir?: string): Record<string, string>;   // the six vars
export function latestSetupLog(showRoot: string, entry: BibleFile, productionDir?: string): Promise<string | undefined>;   // absolute path of the lexically last log, or undefined
export function interviewPromptsDir(): string;
```
`runInit` is recomposed: `initScaffold` → for each gated entry `interviewFile` (unchanged: it still asks through `InitIO` for the terminal) then `afterFileApproved` → `initFinish`; the existing `init.test.ts` and `init-exercise.test.ts` must pass unchanged (that is the proof the recomposition is faithful). `interviewFile`'s question loop now calls `writeAnswers` per answer and `buildVars`.

- [ ] **Step 1: Failing tests** (`init-phases.test.ts`): `initScaffold` into a temp dir yields a repo with one commit and the layout; `questionsFor(world-overview)` returns nine questions; `writeAnswers` then `readAnswers` round-trips; `buildVars` has the six keys; `afterFileApproved` for `world-overview` with a `cast` writes the sheets, rewrites `mainCast`, and commits; `initFinish` with `github: "none"` returns `nextSteps` and a clean `bibleCheck` after every file is approved by a scripted `interviewFile` with a fake executor.
- [ ] **Step 2: Implement; the CLI's own suite stays green** (`npx vitest run` in tools must report the same test names passing plus the new file).
- [ ] **Step 3: Gates;** commit `tools: init is a library of phases the console can call; the terminal init is recomposed from them`.

---

## Task 3: Console server — the registry, one context and one store per show, show-keyed routes and SSE

**Files:** create `console/server/registry.ts`; modify `console/server/show.ts`, `main.ts`, `app.ts`, `runs.ts`, `episodes.ts`, `console/shared/types.ts`; tests `console/test/registry.test.ts` (new), `console/test/app.test.ts`, `runs.test.ts`, `episodes.test.ts` (paths gain the show segment; the fixtures register one show).

**Interfaces:**
```ts
// registry.ts
export interface RegistryEntry { root: string; readOnly?: boolean }
export interface Registry { shows: Record<string, RegistryEntry> }
export const SHOW_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function defaultRegistryPath(): string;                 // ~/.showrunner/shows.json
export async function readRegistry(file: string): Promise<Registry>;   // {} when absent; refuses a malformed file by name
export async function writeRegistry(file: string, reg: Registry): Promise<void>;   // tmp + rename
export async function registerShow(file: string, key: string, entry: RegistryEntry): Promise<void>;   // refuses a duplicate key or a root already registered under another key
export function singleShowRegistry(root: string): Registry;    // --show mode: key = path.basename(root)
// show.ts
export interface ShowContext { key: string; readOnly: boolean; /* …the eight existing fields… */ }
export async function loadShows(reg: Registry, opts): Promise<Map<string, ShowContext>>;   // every entry; a root that fails to load is reported by key and skipped, not fatal
// shared/types.ts
export interface ShowInfo { key: string; readOnly: boolean; /* …existing seven fields… */ }
export type SseMessage =
  | { type: "run"; show: string; episodeId: string; runId: string; offset: number }
  | { type: "episodes"; show: string }
  | { type: "setup"; show: string; key: string; runId: string; offset: number }        // used by Task 5
  | { type: "hello"; operator: string; shows: { key: string; showName: string; readOnly: boolean }[] };
export interface EpisodeRow { /* …existing…; */ error?: string }   // a show whose rows could not be read yields one row {id: "", error}
```
Routes: `GET /api/shows` (the list with each show's `ShowInfo`); every existing `/api/episodes…` route moves under `/api/shows/:show/`; a middleware resolves `:show` to its context (`404 {error: "no such show"}` otherwise) and refuses every POST on a read-only show with `403 {error: "<key> is read-only"}`; `GET /api/events` stays global and carries `show` on every message; `createApp` gains `app.onError` answering `500 {error}` as JSON. `main.ts`: `--registry <file>` (default `defaultRegistryPath()`) or `--show <root>` (single mode); the startup line prints every show's key and name; `RunStore` is one per show (`Map<key, RunStore>`), `watch()` started for each. The Board route gathers rows per show and never throws for one bad show (H-14).

- [ ] **Step 1: Failing tests** — `registry.test.ts` (read/write/register/refusals/single mode); `app.test.ts` rewritten to the prefixed paths over a temp registry with two shows (the second read-only): `/api/shows` lists both; a POST to the read-only show is 403; an unknown show is 404; the SSE `hello` carries both; a `run` message carries `show`; a show whose config is broken yields one error row and the other show's rows intact.
- [ ] **Step 2: Implement.** The 22 `ctx: ShowContext` signatures keep their shape; the callers pass the resolved context. `RunStore`'s `#publish` includes `show`.
- [ ] **Step 3: Gates;** commit `console: a registry of shows — one context and one store per show, every route under its show, the channel keyed by show`.

---

## Task 4: Console client — the shows list, show-prefixed routes, and the show in every link and title

**Files:** create `console/src/pages/Shows.tsx`; modify `console/src/api.ts`, `App.tsx`, `main.tsx`, `pages/{Board,Run,Gate,WhatHappened}.tsx`, `projections.ts`, `useDocTitle.ts`, `components/ActionBar.tsx`; tests `console/test/client/*.test.ts` (the pure projections gain the show key).

- [ ] **Step 1:** `api.ts`: every call takes the show key first and prefixes `/api/shows/<key>`; `parseMessage` validates `show` on `run`/`episodes`/`setup` and the `shows` list on `hello`; a `useShows()` hook. Routes: `/` → Shows (a list of cards: key, name, read-only badge, a link to the Board; a "New show" link to `/shows/new` — the page lands in Task 6); `/shows/:show` → Board; `/shows/:show/episodes/:id/runs/:run`, `…/gate`, `…/what-happened`; `*` → the no-such-page line. The chrome's link reads `<showName> · <key>`; `titleFor` carries the show; read-only shows render no Launch, no gate buttons and no New-episode form, with one line saying why.
- [ ] **Step 2:** Verification by the seeded-show walkthrough (`console/test/fixtures/seed-show.mjs` through the registry) with screenshots in the report, as Plan E's Task 6 did; the pure projection tests updated.
- [ ] **Step 3: Gates;** commit `console: the client knows which show it is looking at`.

---

## Task 5: The setup worker, the Bible projection and routes

**Files:** create `console/worker/lock.ts`, `console/worker/setup.ts`, `console/server/bible.ts`, `console/test/fixtures/fake-setup-worker.mjs`; modify `console/worker/main.ts` (uses `lock.ts`), `console/server/app.ts` (the bible routes), `console/server/runs.ts` (tail `Production/setup/<key>/runs/` per show; `SetupRunView`), `console/shared/types.ts`, `console/package.json` (`@showrunner/tools`); tests `console/test/setup-worker.test.ts`, `console/test/bible.test.ts`.

**Interfaces:**
```ts
// shared/types.ts
export type BibleState = "pending" | "answering" | "running" | "gate" | "approved" | "imported" | "written-by-author" | "stalled" | "failed";
export interface BibleRow { key: string; file: string; mode: "interview" | "default" | "scaffold"; purpose: string; state: BibleState; runId?: string; attempt?: number; questions: number; answered: number }
export interface BibleFileView extends BibleRow { questionsList: { heading: string; question: string; answer: string }[]; gateMessage?: string; content?: string; run?: SetupRunView; prior: boolean }
export interface SetupRunView { runId: string; status: "none" | "running" | "waiting" | "failed" | "completed" | "crashed"; steps: { id: string; status: string; startedAt?: string }[]; gate?: { attempt: number; message: string }; error?: string; offset: number }
// server/bible.ts
export function bibleRows(ctx: ShowContext): Promise<BibleRow[]>;
export function bibleFile(ctx: ShowContext, key: string, store: RunStore): Promise<BibleFileView>;
export function bibleFilePath(ctx: ShowContext, key: string): string;        // the one fence: <canonDir>/<BIBLE_FILES[key].file>
export function saveAnswers(ctx: ShowContext, key: string, answers: Record<string,string>): Promise<string>;   // tools.writeAnswers
export function startBibleRun(ctx: ShowContext, key: string, deps): Promise<{runId: string}>;   // creates the log wx, spawns the setup worker; refuses while the latest run is unfinished
export function answerBibleGate(ctx: ShowContext, key: string, runId: string, answer: {choice: GateChoice; notes?: string; importPath?: string; expectedAttempt: number; by: string}, deps): Promise<void>;   // approve/reject → answerGate + worker; myself/import → the file written then approve; after approval → tools.afterFileApproved
// worker/setup.ts: argv --show <root> --key <bibleKey> --run <id> --engine-root <path> --operator <name>; lock at <bibleLogDir>/<runId>.lock; bibleFilePipeline with buildVars; executors with promptsDir = interviewPromptsDir(); exit codes as the episode worker
```
Routes (all under `/api/shows/:show/`, read-only shows refuse the POSTs): `GET bible` (rows), `GET bible/:key` (the view), `GET bible/:key/file` (the file, text), `POST bible/:key/answers` (body `{answers}`; writes; 200), `POST bible/:key/runs` (start: for an interview file the answers must exist; for a default file the template is written first if absent), `POST bible/:key/runs/:run/gate` (the four answers), `POST bible/finish` (Task 2's `initFinish` with `github` from the body; the registry entry's `readOnly` stays false). The per-show `RunStore` tails the fifteen setup log directories (created lazily) and publishes `setup` messages; `SetupRunView` is a projection over `bibleFilePipeline`'s describe (one or two steps), not the episode's.

- [ ] **Step 1: Failing tests** — `setup-worker.test.ts`: the entry runs `bibleFilePipeline` through fake executors (a `--fake-executor` switch like the episode worker's test seam, or `deps` injection through `runSetupOnce(opts, deps)` exported from the entry), takes the lock, writes the log, exits 0 at the gate; a second start while the lock is live is refused. `bible.test.ts` over a temp show: rows for all fifteen with `pending`; `saveAnswers` writes `answers.md` and the view prefills; `startBibleRun` spawns the fake worker (`fake-setup-worker.mjs` writes a `gate_opened` and exits), the view shows `gate` with the message; `answerBibleGate` approve → `gate_answered` in the log and `afterFileApproved`'s commit exists; `myself` writes the template; `import` of a temp file copies it; the file route serves exactly the bible file and 404s for any other path (`../`, `Canon/refs.json`, a sibling).
- [ ] **Step 2: Implement;** `lock.ts` extracted first with the episode worker's tests still green.
- [ ] **Step 3: Gates;** commit `console: a setup worker and a Bible route family — the interview's writing step runs detached, its gate is answered through the engine`.

---

## Task 6: Console client — the New-show form and the Bible page

**Files:** create `console/src/pages/NewShow.tsx`, `console/src/pages/Bible.tsx`, `console/src/components/{QuestionForm,BibleRail,GatePanel}.tsx`; modify `App.tsx` (`/shows/new`, `/shows/:show/bible`, `/shows/:show/bible/:key`), `api.ts`, the Board's chrome (a "Bible" link per show).

- [ ] **Step 1: The New-show page** (`/shows/new`): the form fields are `InitOptions`' eight (name, slug prefilled by `slugFrom`, path, nasRoot prefilled `/Volumes/media/<slug>`, github private/public/none, importFrom, the registry key prefilled with the path's basename); submit → `POST /api/shows` (Task 5 adds the route: `initScaffold` + `registerShow`; refuses a path inside the engine root or a registered root; 409 on a duplicate key) → redirect to `/shows/<key>/bible`.
- [ ] **Step 2: The Bible page** (`/shows/:show/bible`): the fifteen rows as a rail with state chips; a row opens `/shows/:show/bible/:key`: for an interview file in `pending`/`answering`, the `QuestionForm` (one textarea per question, prefilled from prior answers; "Save answers" posts them; "Write it" starts the run); for `running`, the setup run's step rail streaming over SSE with the elapsed time and the words "the writer is working; a file takes minutes, not seconds"; for `gate`, the `GatePanel`: the gate message, the file rendered as Markdown with a raw toggle, and four buttons — Approve, Reject with notes (a textarea), I will write it myself, Import (a path field) — each calling the gate route with `expectedAttempt`; for `approved`/`imported`/`written-by-author`, the file read-only with its note; `stalled`/`failed` with the reason and a "start again" button. When every gated file is approved, a "Finish" panel: a bible-check report, the GitHub choice, the next-steps text from `initFinish`.
- [ ] **Step 3:** Pure projections (`bibleState` from a row's log and answers; the form's dirty state) in `console/src/projections.ts` with tests in `console/test/client/`. The walkthrough: a scratch show created through the form with a fake writer (the server test seam from Task 5), two files answered and approved, screenshots in the report.
- [ ] **Step 4: Gates;** commit `console: a show is started and its bible interviewed from the browser`.

---

## Task 7: The archived run view, and the first render test

**Files:** modify `console/server/app.ts` (the run route: 404 when the log file does not exist, worded `no log for run <run> of <id>`), `console/vitest.config.ts`, `console/package.json` (`jsdom`, `@testing-library/react`, `@testing-library/jest-dom` as devDependencies); create `console/test/client/ProgressBar.test.tsx`, `console/test/client/bible-page.test.tsx`.

- [ ] **Step 1:** The 404: a test in `app.test.ts` — `GET /api/shows/<key>/episodes/s01e01/runs/anything` on an archived episode is 404 with the message; the launch window test (launch creates the log, then the view is 200 with every step pending) still passes.
- [ ] **Step 2:** The render infrastructure: `include` gains `test/**/*.test.tsx`; each `.tsx` test declares `// @vitest-environment jsdom`; `ProgressBar.test.tsx` renders a `StepRow` with progress and asserts the label and the bar width; `bible-page.test.tsx` renders the `GatePanel` with a gate message and asserts the four buttons and that Approve is disabled until the file has loaded.
- [ ] **Step 3: Gates;** commit `console: a run that has no log is a 404, and the client has its first render tests`.

---

## Task 8: The smaller items, the README, and the drift baseline (the baseline is cut-able)

**Files:** modify `scripts/publish-kit.py:202` (the reminder: "`publish.channelName` is `[YOUR NAME]`; the name is written nowhere until the key is filled"), `tools/templates/prompts/tts-script.md:141` (`{{show.audio.guestRefsDir}}`), `README.md` (three sections: "Shows and the registry" — the file, `--registry`, `--show` single mode, read-only entries, the keys; "The Bible view"; "Starting a show from the console" — what the server writes and why that is within Plan E's rule); the drift baseline: `tools/src/init/scaffold.ts` writes `prompts/.templates-baseline.json` (`{ "<file>": "<sha256>" }` for every prompt copied), `tools/src/check-prompts.ts` gains `--baseline` (reports, per prompt: unchanged / show-edited / template-moved / both), the harness unaffected; tests.

- [ ] **Step 1:** The two text edits and their tests (pytest's `test_publish_kit.py` asserts the new wording; the templates harness renders `tts-script.md` with the Harbor context's `audio.guestRefsDir`).
- [ ] **Step 2:** The README sections.
- [ ] **Step 3 (cut-able):** The baseline and `--baseline`; a test over a temp show created by `initScaffold`.
- [ ] **Step 4: Gates;** commit `docs, tools, scripts: the console's shows and bible documented; a prompt baseline records what init copied`.

---

## Task 9: The live check — two shows on one server, the instance's Bible view, and one real file through the browser path

**Files:** none in the repository beyond the report; the registry file is restored afterwards.

- [ ] **Step 1:** Register the live instance (`~/GitHub/DeadLight2`, key `DeadLight`) and the retired repository (`~/GitHub/DeadLight`, key `DeadLight-v1`, `readOnly: true`) in a scratch registry under the scratchpad; start the console on port 4410 with `--registry <that file>`; fetch `/api/shows`, both Boards (the instance's ten archived rows; the retired repository's twelve with `ep98`/`ep99` as the inventory measured and no launch button), the instance's `/api/shows/DeadLight/bible` (thirteen `imported`, two scaffolds), one file view with its content; a POST to the read-only show is 403. Record every response trimmed.
- [ ] **Step 2:** The browser path for real: through the New-show form, create a scratch show "Harbor Lights" under the scratchpad (`github: "none"`), answer `world-overview`'s nine questions in the form with the same Harbor Lights answers Plan G's Task 9 used (its report quotes them), start the run, watch the setup run stream, and at the gate approve; then "I will write it myself" on `series-arc`. This is one real writer call (about $2.24). Record the setup log's event sequence, the elapsed time (the number Plan G's record lacks), and the file's first thirty lines against the answers (nothing invented). Stop the console; delete the scratch show; restore the registry file to what it was (absent, if it was absent).
- [ ] **Step 3:** The retired repository's `git status --porcelain` before and after (two lines); port 4400 untouched; the report.

---

## After the tasks: the whole-branch review, the deferred record, and the pull request

- The whole-branch reviewer (Opus) reads `12e2eaa..HEAD` and drives the console once more against the scratch registry.
- The controller writes `docs/plans/2026-10-07-the-console-side-of-setup-deferred.md`: status; what Plan H established; the next plan (the season desk is the one capability still deferred from spec §0; packaging `init` and the console for another machine; React 19 and react-router 8); the first real browser interview; every ruling with its cost if wrong.
- **Pull request:** Showrunner `plan-h` → `main`. Nothing in the show repositories changes.

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §9.4's New-show surface → Tasks 5–6 over Task 2's phases; §4.2 (the server owns no run) → the setup worker (Task 5) and the Global Constraints' list of the server's writes; §4.4's fences → the show key regex, the bible key set, the one file fence, the read-only 403, the path refusal; §6.5–6.9 → the setup log is the record and `SetupRunView` is a projection over it; §7.2's deferred list → H-21 refused in writing; O-05/F-25 → Tasks 3–4; Plan F's two deferrals → Tasks 1 and 7.
2. **Placeholder scan.** The client tasks give pages, routes, content and the pure projections' tests rather than JSX; Task 9 is the acceptance. Nothing says "TBD".
3. **Type consistency.** `ShowContext.key`/`readOnly` (Task 3) used by Tasks 4–6; `SseMessage`'s `show` and `setup` (Task 3, 5) parsed by Tasks 4, 6; `BibleRow`/`BibleFileView`/`SetupRunView` (Task 5) rendered by Task 6 and tested by Task 7; the tools phases (Task 2) called by Task 5's `answerBibleGate` and the New-show route; `GATE_CHOICES` shared.

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-07-the-console-side-of-setup.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. Tasks 1 and 2 are independent of each other but Task 2's tools suite needs Task 1's engine build; run them in order. Task 8's baseline is cut if the budget tightens.
