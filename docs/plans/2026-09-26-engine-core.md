# Engine Core Implementation Plan (Plan A of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestrator's core — typed steps, a dependency-ordered runner, an append-only JSONL event log as the source of truth, state derived from the log, script execution as argv arrays with structured progress, human gates that pause and resume, sentinel loops, input-hash caching, and resume-by-replay — in a new engine repository, with no model calls and no dependence on any show.

**Architecture:** A TypeScript package `engine/` in a new repository. Every step is a typed object of one of five kinds (guard, script, agent, gate, loop). The runner executes a pipeline in dependency order, writes every transition to one JSONL file per run, and rebuilds all state from that file on restart. Script and agent executors are injected interfaces, so this plan tests the runner with fakes; the real agent executor is Plan B and the real scripts are Plan C.

**Tech Stack:** Node ≥ 22, TypeScript 5 (strict, ESM, `NodeNext`), vitest 2, npm workspaces. No runtime dependencies in `engine/`. Python 3 is present on the machine and is used only by one test fixture.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` in this repository. The current pipeline it replaces is mapped in `docs/specs/2026-09-25-pipeline-process-map.md`. The plan argues from §4 (engine), §5 (ids), §6 (core model and observability), and §7.3–7.5 (repositories).

**This is plan A of six.** B (agent runner), C (show config and prompt extraction), D (the Dead Light pipeline), E (console), and F (cutover) follow. Each is its own document.

## Global Constraints

- **The engine repository is `Showrunner`, at `~/GitHub/Showrunner`** (Ryan, 2026-09-26; remote `MrMophandle/Showrunner`, branch `main`). Every path in this plan is relative to it. The repository already exists with an emptied history from a prior attempt (last commits: "Clear out original attempt", "Clean out"); nothing from that attempt is reused.
- **"A script in the engine repository may not contain the name of a show."** (spec §7.4) Nothing in `engine/` mentions Dead Light, its characters, or its files.
- **"argv arrays, never shell strings; ids validated before they reach a process"** (spec §4.4). No `exec`, no `shell: true`, no string interpolation into a command.
- **Ids:** `sXXeYY` is an aired slot; `epNN` is a production id that never aired (spec §5.1). Both zero-padded to two digits.
- **The event log is the source of truth. Everything else is derived from it.** (spec §6.5) The log lives at `Production/<episodeId>/runs/<runId>.jsonl` under the show root.
- **Event kinds, exactly:** `run_started`, `run_finished`, `step_started`, `step_completed`, `step_failed`, `step_skipped`, `step_cached`, `step_progress`, `script_line`, `agent_query`, `agent_tool_call`, `agent_result`, `loop_iteration`, `gate_opened`, `gate_answered`, `input_changed` (spec §6.5).
- **Skipped and failed are different outcomes, and a gate cannot open past a failed dependency.** (spec §6.4)
- **A loop that exhausts its iterations without its sentinel has failed** (spec §6.7 — the ep09/ep10 lesson).
- **Progress contract:** a script prints `::progress {"done":N,"total":M,"unit":"..."}` lines; everything else is forwarded as `script_line` (spec §6.7).
- **Milestone vocabulary, exactly** (spec §3.2): `NEEDS_IDEA DRAFT_IDEA IDEA DRAFT_OUTLINE OUTLINE DRAFT_SCRIPT SCRIPT NEEDS_REFS DRAFT_CASTING CASTING DRAFT_AUDIO AUDIO NEEDS_IMAGES DRAFT_IMAGES IMAGES DRAFT_ASSEMBLY ASSEMBLY PUBLISH_KIT DRAFT_CANON CANON COMPLETE`.
- **Every commit ends with these two trailer lines, in ONE final paragraph** (git treats only the last paragraph as the trailer block; two separate `-m` flags split them and break co-author attribution):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9`
- Tests run with `cd ~/GitHub/Showrunner/engine && npx vitest run` (or one file: `npx vitest run test/<name>.test.ts`). Typecheck with `npm run typecheck` from `engine/` — it runs `tsc --noEmit` over `src/` AND `tsc -p tsconfig.test.json` over `test/` and `vitest.config.ts` (added after Task 1's review found the base config never reached the tests).
- Imports between engine source files use the `.js` extension (`NodeNext` resolution) even though the files are `.ts`.

---

## File Structure

```
~/GitHub/Showrunner/
  package.json                 npm workspaces root; scripts: test, typecheck
  .gitignore
  README.md
  engine/
    package.json               name "@showrunner/engine", type module, no deps
    tsconfig.json              strict, NodeNext, ES2022, outDir dist (src only)
    tsconfig.test.json         extends it; rootDir .; noEmit; includes src, test, vitest.config.ts
    vitest.config.ts
    src/
      ids.ts                   parse/validate/compare episode ids
      steps.ts                 the five step kinds, Pipeline, RunContext, executor interfaces
      pipeline.ts              dependency order and cycle detection
      events.ts                Event type, EventKind, EventLog (append, read)
      hash.ts                  sha256 of files; hashFiles()
      state.ts                 deriveRunState(events): per-step status, open gate, position, lastEventAt
      runner.ts                run(): executes a pipeline against a log; resume is the same call
      script-step.ts           spawn argv, stream lines, parse ::progress
      stages.ts                the milestone vocabulary and deriveStage()
      index.ts                 public exports
    test/
      fixtures/
        progress.py            prints ::progress lines and exits 0
        fail.py                prints to stderr and exits 3
      ids.test.ts
      pipeline.test.ts
      events.test.ts
      hash.test.ts
      state.test.ts
      runner.test.ts
      script-step.test.ts
      gate.test.ts
      loop.test.ts
      stages.test.ts
```

Each source file has one responsibility. `runner.ts` is the only file that composes the others.

---

### Task 1: Repository and package bootstrap

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`
- Create: `engine/package.json`, `engine/tsconfig.json`, `engine/tsconfig.test.json`, `engine/vitest.config.ts`
- Create: `engine/src/index.ts`
- Test: `engine/test/smoke.test.ts`

**Interfaces:**
- Produces: a workspace where `npx vitest run` and `npm run typecheck` both succeed from `engine/`.

- [ ] **Step 1: Confirm the repository and untrack the stray file**

The repository already exists. Confirm it is on `main` with the expected remote, and remove the `.DS_Store` the prior attempt committed (it is modified in the working tree, so it is tracked).

```bash
cd ~/GitHub/Showrunner
git branch --show-current            # expected: main
git remote get-url origin            # expected: https://github.com/MrMophandle/Showrunner.git
git rm --cached -q .DS_Store 2>/dev/null || true
```

- [ ] **Step 2: Write the root files**

`package.json`:
```json
{
  "name": "showrunner",
  "private": true,
  "workspaces": ["engine"],
  "scripts": {
    "test": "npm test -w engine",
    "typecheck": "npm run typecheck -w engine"
  },
  "engines": { "node": ">=22" }
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
```

`README.md`:
```markdown
# Showrunner

The orchestrator that takes an episode premise and a story bible and makes a
finished, publishable episode. This repository is the product; a show is a
separate repository the engine operates on by path.

Design: see `docs/` (the pipeline process map and the rewrite design, moved
here from the first show at cutover).

## Develop

    npm install
    npm test
    npm run typecheck
```

- [ ] **Step 3: Write the engine package files**

`engine/package.json`:
```json
{
  "name": "@showrunner/engine",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.test.json",
    "build": "tsc"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

`engine/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`engine/tsconfig.test.json` (the base config includes only `src/`; this one typechecks the tests and the vitest config without emitting):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "declaration": false
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`engine/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
```

`engine/src/index.ts`:
```ts
export const ENGINE_VERSION = "0.0.1";
```

- [ ] **Step 4: Write the smoke test**

`engine/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../src/index.js";

describe("engine package", () => {
  it("loads", () => {
    expect(ENGINE_VERSION).toBe("0.0.1");
  });
});
```

- [ ] **Step 5: Install and run**

```bash
cd ~/GitHub/Showrunner && npm install
cd engine && npx vitest run && npm run typecheck
```
Expected: 1 test passed; `typecheck` prints only the two `tsc` command echoes and exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner
git add -A
git commit -m "engine: bootstrap workspace, TypeScript, vitest; untrack .DS_Store" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
git push -u origin main
```

---

### Task 2: Episode ids

**Files:**
- Create: `engine/src/ids.ts`
- Test: `engine/test/ids.test.ts`

**Interfaces:**
- Produces:
  - `type EpisodeId = { kind: "aired"; season: number; episode: number; raw: string } | { kind: "production"; number: number; raw: string }`
  - `parseEpisodeId(raw: string): EpisodeId` — throws `InvalidEpisodeId` on any other shape
  - `isEpisodeId(raw: string): boolean`
  - `formatAired(season: number, episode: number): string` → `"s02e01"`
  - `compareEpisodeIds(a: EpisodeId, b: EpisodeId): number` — aired before production; aired by (season, episode); production by number
  - `class InvalidEpisodeId extends Error`

- [ ] **Step 1: Write the failing test**

`engine/test/ids.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  parseEpisodeId, isEpisodeId, formatAired, compareEpisodeIds, InvalidEpisodeId,
} from "../src/ids.js";

describe("parseEpisodeId", () => {
  it("parses an aired slot", () => {
    expect(parseEpisodeId("s02e01")).toEqual({ kind: "aired", season: 2, episode: 1, raw: "s02e01" });
  });
  it("parses a production id", () => {
    expect(parseEpisodeId("ep98")).toEqual({ kind: "production", number: 98, raw: "ep98" });
  });
  it("rejects every other shape", () => {
    for (const bad of ["s2e1", "S02E01", "ep1", "ep001", "s02e01/", "../s02e01", "", "s02e01 x"]) {
      expect(() => parseEpisodeId(bad), bad).toThrow(InvalidEpisodeId);
    }
  });
});

describe("isEpisodeId", () => {
  it("is true only for the two shapes", () => {
    expect(isEpisodeId("s10e20")).toBe(true);
    expect(isEpisodeId("ep99")).toBe(true);
    expect(isEpisodeId("ep9")).toBe(false);
  });
});

describe("formatAired", () => {
  it("zero-pads", () => {
    expect(formatAired(2, 1)).toBe("s02e01");
    expect(formatAired(10, 20)).toBe("s10e20");
  });
  it("rejects out-of-range", () => {
    expect(() => formatAired(0, 1)).toThrow(InvalidEpisodeId);
    expect(() => formatAired(1, 100)).toThrow(InvalidEpisodeId);
  });
});

describe("compareEpisodeIds", () => {
  it("orders aired by season then episode, then production ids last by number", () => {
    const ids = ["ep99", "s02e01", "s01e10", "ep98", "s01e02"].map(parseEpisodeId);
    const sorted = [...ids].sort(compareEpisodeIds).map((i) => i.raw);
    expect(sorted).toEqual(["s01e02", "s01e10", "s02e01", "ep98", "ep99"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/ids.test.ts`
Expected: FAIL — cannot find module `../src/ids.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/ids.ts`:
```ts
export class InvalidEpisodeId extends Error {
  constructor(raw: string, reason: string) {
    super(`invalid episode id ${JSON.stringify(raw)}: ${reason}`);
    this.name = "InvalidEpisodeId";
  }
}

export type EpisodeId =
  | { kind: "aired"; season: number; episode: number; raw: string }
  | { kind: "production"; number: number; raw: string };

const AIRED = /^s(\d{2})e(\d{2})$/;
const PRODUCTION = /^ep(\d{2})$/;

export function parseEpisodeId(raw: string): EpisodeId {
  const a = AIRED.exec(raw);
  if (a) {
    const season = Number(a[1]);
    const episode = Number(a[2]);
    if (season === 0 || episode === 0) throw new InvalidEpisodeId(raw, "season and episode start at 1");
    return { kind: "aired", season, episode, raw };
  }
  const p = PRODUCTION.exec(raw);
  if (p) return { kind: "production", number: Number(p[1]), raw };
  throw new InvalidEpisodeId(raw, "expected sXXeYY (aired) or epNN (production)");
}

export function isEpisodeId(raw: string): boolean {
  try {
    parseEpisodeId(raw);
    return true;
  } catch {
    return false;
  }
}

export function formatAired(season: number, episode: number): string {
  if (!Number.isInteger(season) || season < 1 || season > 99) throw new InvalidEpisodeId(String(season), "season must be 1..99");
  if (!Number.isInteger(episode) || episode < 1 || episode > 99) throw new InvalidEpisodeId(String(episode), "episode must be 1..99");
  return `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
}

export function compareEpisodeIds(a: EpisodeId, b: EpisodeId): number {
  if (a.kind !== b.kind) return a.kind === "aired" ? -1 : 1;
  if (a.kind === "aired" && b.kind === "aired") {
    return a.season - b.season || a.episode - b.episode;
  }
  if (a.kind === "production" && b.kind === "production") return a.number - b.number;
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/ids.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/ids.ts engine/test/ids.test.ts
git commit -m "engine: episode ids — aired sXXeYY and production epNN" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 3: Step types and pipeline ordering

**Files:**
- Create: `engine/src/steps.ts`, `engine/src/pipeline.ts`
- Test: `engine/test/pipeline.test.ts`

**Interfaces:**
- Produces (in `steps.ts`):
  - `type StepId = string`
  - `interface RunContext { runId: string; episodeId: string; showRoot: string; results: Record<StepId, unknown> }`
  - `type GuardResult = { pass: true; message?: string } | { pass: false; message: string }`
  - `interface GuardStep { kind: "guard"; id; dependsOn?; inputs?; outputs?; check(ctx): GuardResult | Promise<GuardResult> }`
  - `interface ScriptStep { kind: "script"; id; dependsOn?; inputs?; outputs?; argv(ctx): string[]; env?(ctx): Record<string,string>; cwd?: string; timeoutMs?: number }`
  - `interface AgentStep { kind: "agent"; id; dependsOn?; inputs?; outputs?; promptFile: string; model: string; allowedTools: string[]; context: "fresh" | "shared"; schema?: object }`
  - `interface GateStep { kind: "gate"; id; dependsOn?; message(ctx): string; onReject?: AgentStep; maxAttempts?: number }`
  - `interface LoopStep { kind: "loop"; id; dependsOn?; body: AgentStep; until: string; maxIterations: number }`
  - `type Step = GuardStep | ScriptStep | AgentStep | GateStep | LoopStep`
  - `interface Pipeline { name: string; steps: Step[] }`
  - `type Emit = (kind: EventKind, payload: Record<string, unknown>) => Promise<void>` (EventKind from Task 4; declared here as a string union re-exported there)
  - `type ScriptOutcome = { ok: true } | { ok: false; error: string }`
  - `type AgentOutcome = { ok: true; text: string; verdict?: unknown; toolCalls: number } | { ok: false; error: string }`
  - `interface Executors { script(step: ScriptStep, ctx: RunContext, emit: Emit): Promise<ScriptOutcome>; agent(step: AgentStep, ctx: RunContext, emit: Emit): Promise<AgentOutcome> }`
- Produces (in `pipeline.ts`):
  - `orderSteps(p: Pipeline): Step[]` — dependency order, stable; throws `PipelineError` on a missing dependency, a duplicate id, or a cycle
  - `class PipelineError extends Error`

- [ ] **Step 1: Write the failing test**

`engine/test/pipeline.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { orderSteps, PipelineError } from "../src/pipeline.js";
import type { Pipeline, GuardStep } from "../src/steps.js";

const g = (id: string, dependsOn: string[] = []): GuardStep => ({
  kind: "guard", id, dependsOn, check: () => ({ pass: true }),
});

describe("orderSteps", () => {
  it("returns steps in dependency order, keeping declaration order among ready steps", () => {
    const p: Pipeline = { name: "t", steps: [g("c", ["a", "b"]), g("a"), g("b", ["a"])] };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
  it("prefers declaration order when several steps are ready", () => {
    const p: Pipeline = { name: "t", steps: [g("z"), g("a"), g("m", ["z", "a"])] };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["z", "a", "m"]);
  });
  it("throws on a missing dependency", () => {
    const p: Pipeline = { name: "t", steps: [g("a", ["nope"])] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/nope/);
  });
  it("throws on a duplicate id", () => {
    const p: Pipeline = { name: "t", steps: [g("a"), g("a")] };
    expect(() => orderSteps(p)).toThrow(/duplicate/);
  });
  it("throws on a cycle", () => {
    const p: Pipeline = { name: "t", steps: [g("a", ["b"]), g("b", ["a"])] };
    expect(() => orderSteps(p)).toThrow(/cycle/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pipeline.test.ts`
Expected: FAIL — cannot find module `../src/pipeline.js`.

- [ ] **Step 3: Write the types**

`engine/src/steps.ts`:
```ts
export type StepId = string;

export type EventKind =
  | "run_started" | "run_finished"
  | "step_started" | "step_completed" | "step_failed" | "step_skipped" | "step_cached"
  | "step_progress" | "script_line"
  | "agent_query" | "agent_tool_call" | "agent_result"
  | "loop_iteration"
  | "gate_opened" | "gate_answered"
  | "input_changed";

export type Emit = (kind: EventKind, payload: Record<string, unknown>) => Promise<void>;

export interface RunContext {
  runId: string;
  episodeId: string;
  /** Absolute path to the show repository the engine is operating on. */
  showRoot: string;
  /** Results of completed steps, by id: a guard's message, a gate's answer, an agent's verdict. */
  results: Record<StepId, unknown>;
}

interface StepBase {
  id: StepId;
  dependsOn?: StepId[];
  /** Files (relative to showRoot) this step reads. Hashed; a change invalidates a cached success. */
  inputs?: string[];
  /** Files (relative to showRoot) this step writes. Hashed on completion and recorded. */
  outputs?: string[];
}

export type GuardResult = { pass: true; message?: string } | { pass: false; message: string };

export interface GuardStep extends StepBase {
  kind: "guard";
  check: (ctx: RunContext) => GuardResult | Promise<GuardResult>;
}

export interface ScriptStep extends StepBase {
  kind: "script";
  /** argv[0] is the executable. Never a shell string. */
  argv: (ctx: RunContext) => string[];
  env?: (ctx: RunContext) => Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface AgentStep extends StepBase {
  kind: "agent";
  /** Path of the prompt file, relative to the show's prompts directory. */
  promptFile: string;
  model: string;
  allowedTools: string[];
  context: "fresh" | "shared";
  /** JSON schema the agent's verdict must satisfy, when the step produces one. */
  schema?: object;
}

export interface GateStep extends StepBase {
  kind: "gate";
  message: (ctx: RunContext) => string;
  onReject?: AgentStep;
  maxAttempts?: number;
}

export interface LoopStep extends StepBase {
  kind: "loop";
  body: AgentStep;
  /** The exact string whose presence in the body's final text ends the loop. */
  until: string;
  maxIterations: number;
}

export type Step = GuardStep | ScriptStep | AgentStep | GateStep | LoopStep;

export interface Pipeline {
  name: string;
  steps: Step[];
}

export type ScriptOutcome = { ok: true } | { ok: false; error: string };

export type AgentOutcome =
  | { ok: true; text: string; verdict?: unknown; toolCalls: number }
  | { ok: false; error: string };

/** The two step kinds that do real work are injected, so the runner is testable with fakes. */
export interface Executors {
  script: (step: ScriptStep, ctx: RunContext, emit: Emit) => Promise<ScriptOutcome>;
  agent: (step: AgentStep, ctx: RunContext, emit: Emit) => Promise<AgentOutcome>;
}
```

- [ ] **Step 4: Write the ordering**

`engine/src/pipeline.ts`:
```ts
import type { Pipeline, Step, StepId } from "./steps.js";

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/** Kahn's algorithm, preferring declaration order among steps that are ready. */
export function orderSteps(p: Pipeline): Step[] {
  const byId = new Map<StepId, Step>();
  for (const s of p.steps) {
    if (byId.has(s.id)) throw new PipelineError(`duplicate step id ${JSON.stringify(s.id)} in pipeline ${p.name}`);
    byId.set(s.id, s);
  }
  for (const s of p.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!byId.has(d)) throw new PipelineError(`step ${JSON.stringify(s.id)} depends on unknown step ${JSON.stringify(d)}`);
    }
  }
  const remaining = new Map<StepId, Set<StepId>>();
  for (const s of p.steps) remaining.set(s.id, new Set(s.dependsOn ?? []));
  const out: Step[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const s of p.steps) {
      const deps = remaining.get(s.id);
      if (!deps || deps.size > 0) continue;
      out.push(s);
      remaining.delete(s.id);
      for (const other of remaining.values()) other.delete(s.id);
      progressed = true;
      break;
    }
    if (!progressed) {
      throw new PipelineError(`cycle among steps: ${[...remaining.keys()].join(", ")}`);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/pipeline.test.ts && npm run typecheck`
Expected: PASS, 5 tests; `typecheck` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/steps.ts engine/src/pipeline.ts engine/test/pipeline.test.ts
git commit -m "engine: the five step kinds, executor interfaces, dependency ordering" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 4: The event log

**Files:**
- Create: `engine/src/events.ts`
- Test: `engine/test/events.test.ts`

**Interfaces:**
- Consumes: `EventKind` from `steps.ts`.
- Produces:
  - `interface Event { ts: string; runId: string; stepId?: string; kind: EventKind; payload: Record<string, unknown> }`
  - `class EventLog { constructor(path: string); append(e: Omit<Event, "ts">): Promise<Event>; read(): Promise<Event[]>; static logPath(showRoot: string, episodeId: string, runId: string): string }`
  - `append` creates parent directories, writes one JSON line, and never rewrites earlier lines.
  - `read` returns `[]` for a missing file and throws on a malformed line (a corrupt log must not silently become a shorter one).

- [ ] **Step 1: Write the failing test**

`engine/test/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog } from "../src/events.js";

describe("EventLog", () => {
  it("appends one JSON line per event and reads them back in order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const log = new EventLog(path.join(dir, "nested", "r1.jsonl"));
    const a = await log.append({ runId: "r1", kind: "run_started", payload: { pipeline: "p" } });
    const b = await log.append({ runId: "r1", stepId: "s1", kind: "step_started", payload: { kind: "guard" } });
    expect(typeof a.ts).toBe("string");
    const text = await readFile(log.path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    const events = await log.read();
    expect(events.map((e) => e.kind)).toEqual(["run_started", "step_started"]);
    expect(events[1]?.stepId).toBe("s1");
    expect(events[0]?.ts).toBe(a.ts);
    expect(events[1]?.ts).toBe(b.ts);
  });

  it("reads an absent log as empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const log = new EventLog(path.join(dir, "none.jsonl"));
    expect(await log.read()).toEqual([]);
  });

  it("throws on a malformed line rather than dropping it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const p = path.join(dir, "bad.jsonl");
    await writeFile(p, '{"ts":"t","runId":"r","kind":"run_started","payload":{}}\nnot json\n');
    await expect(new EventLog(p).read()).rejects.toThrow(/line 2/);
  });

  it("computes the canonical log path under the show root", () => {
    expect(EventLog.logPath("/show", "s02e01", "run-7")).toBe(path.join("/show", "Production", "s02e01", "runs", "run-7.jsonl"));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/events.test.ts`
Expected: FAIL — cannot find module `../src/events.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/events.ts`:
```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EventKind } from "./steps.js";

export type { EventKind };

export interface Event {
  ts: string;
  runId: string;
  stepId?: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export class EventLog {
  constructor(readonly path: string) {}

  static logPath(showRoot: string, episodeId: string, runId: string): string {
    return path.join(showRoot, "Production", episodeId, "runs", `${runId}.jsonl`);
  }

  async append(e: Omit<Event, "ts">): Promise<Event> {
    const full: Event = { ts: new Date().toISOString(), ...e };
    await mkdir(path.dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async read(): Promise<Event[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Event[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Event);
      } catch {
        throw new Error(`event log ${this.path}: malformed JSON at line ${i + 1}`);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/events.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/events.ts engine/test/events.test.ts
git commit -m "engine: append-only JSONL event log" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 5: File hashing

**Files:**
- Create: `engine/src/hash.ts`
- Test: `engine/test/hash.test.ts`

**Interfaces:**
- Produces:
  - `hashFile(absPath: string): Promise<string | null>` — sha256 hex of the file's bytes; `null` if the file does not exist (streamed, constant memory — outputs include multi-gigabyte media)
  - `hashFiles(showRoot: string, relPaths: string[]): Promise<Record<string, string | null>>` — keyed by the relative path, in the order given
  - `sameHashes(a: Record<string, string | null>, b: Record<string, string | null>): boolean` — same keys, same values

- [ ] **Step 1: Write the failing test**

`engine/test/hash.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile, hashFiles, sameHashes } from "../src/hash.js";

describe("hashing", () => {
  it("hashes a file and returns null for a missing one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    await writeFile(path.join(dir, "a.txt"), "hello");
    const h = await hashFile(path.join(dir, "a.txt"));
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await hashFile(path.join(dir, "missing"))).toBeNull();
  });

  it("hashes many relative paths under a root and compares maps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    await writeFile(path.join(dir, "a.txt"), "hello");
    const before = await hashFiles(dir, ["a.txt", "b.txt"]);
    expect(Object.keys(before)).toEqual(["a.txt", "b.txt"]);
    expect(before["b.txt"]).toBeNull();
    await writeFile(path.join(dir, "a.txt"), "changed");
    const after = await hashFiles(dir, ["a.txt", "b.txt"]);
    expect(sameHashes(before, after)).toBe(false);
    expect(sameHashes(before, { ...before })).toBe(true);
    expect(sameHashes(before, { "a.txt": before["a.txt"] ?? null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/hash.test.ts`
Expected: FAIL — cannot find module `../src/hash.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/hash.ts`:
```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

/** Streams the file through sha256 in constant memory — declared outputs include
 *  full-episode WAV mixes and mastered MP4s, and `readFile` refuses files over 2 GiB. */
export async function hashFile(absPath: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return hash.digest("hex");
}

export async function hashFiles(showRoot: string, relPaths: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const rel of relPaths) {
    out[rel] = await hashFile(path.join(showRoot, rel));
  }
  return out;
}

export function sameHashes(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k === undefined || k !== kb[i]) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/hash.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/hash.ts engine/test/hash.test.ts
git commit -m "engine: sha256 file hashing for declared inputs and outputs" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 6: State derived from the log

**Files:**
- Create: `engine/src/state.ts`
- Test: `engine/test/state.test.ts`

**Interfaces:**
- Consumes: `Event` from `events.ts`.
- Produces:
  - `type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting"`
  - `interface GateState { stepId: string; attempt: number; message: string; openedAt: string }`
  - `interface Position { stepId: string; startedAt: string; progress?: { done: number; total: number; unit: string; message?: string } }`
  - `interface RunState { runId: string; finished: boolean; status?: "completed" | "failed"; steps: Record<string, StepStatus>; results: Record<string, unknown>; openGate?: GateState; position?: Position; lastEventAt?: string; gateAttempts: Record<string, number> }`
  - `deriveRunState(events: Event[]): RunState` — pure; the last event wins; a `gate_opened` with no later `gate_answered` for the same step is the open gate and makes that step `waiting`; a `gate_answered` with `approved: true` completes the step and stores the answer in `results`; `step_completed` stores `payload.result` in `results` when present.

- [ ] **Step 1: Write the failing test**

`engine/test/state.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveRunState } from "../src/state.js";
import type { Event } from "../src/events.js";

const ev = (kind: Event["kind"], stepId: string | undefined, payload: Record<string, unknown>, ts: string): Event =>
  stepId === undefined ? { ts, runId: "r", kind, payload } : { ts, runId: "r", stepId, kind, payload };

describe("deriveRunState", () => {
  it("is empty for no events", () => {
    const s = deriveRunState([]);
    expect(s.finished).toBe(false);
    expect(s.steps).toEqual({});
    expect(s.openGate).toBeUndefined();
  });

  it("tracks step outcomes, results, and the current position with progress", () => {
    const s = deriveRunState([
      ev("run_started", undefined, { pipeline: "p" }, "t0"),
      ev("step_started", "a", { kind: "guard" }, "t1"),
      ev("step_completed", "a", { result: "ok" }, "t2"),
      ev("step_started", "b", { kind: "script" }, "t3"),
      ev("step_progress", "b", { done: 3, total: 10, unit: "segments" }, "t4"),
    ]);
    expect(s.steps).toEqual({ a: "completed", b: "running" });
    expect(s.results).toEqual({ a: "ok" });
    expect(s.position).toEqual({ stepId: "b", startedAt: "t3", progress: { done: 3, total: 10, unit: "segments" } });
    expect(s.lastEventAt).toBe("t4");
    expect(s.finished).toBe(false);
  });

  it("distinguishes failed from skipped and marks the run finished", () => {
    const s = deriveRunState([
      ev("step_started", "a", {}, "t1"),
      ev("step_failed", "a", { error: "boom" }, "t2"),
      ev("step_skipped", "b", { reason: "dependency failed: a" }, "t3"),
      ev("run_finished", undefined, { status: "failed" }, "t4"),
    ]);
    expect(s.steps).toEqual({ a: "failed", b: "skipped" });
    expect(s.finished).toBe(true);
    expect(s.status).toBe("failed");
    expect(s.position).toBeUndefined();
  });

  it("exposes an open gate, then clears it and records the answer", () => {
    const opened = [
      ev("gate_opened", "g", { attempt: 1, message: "Look at this" }, "t1"),
    ];
    let s = deriveRunState(opened);
    expect(s.steps).toEqual({ g: "waiting" });
    expect(s.openGate).toEqual({ stepId: "g", attempt: 1, message: "Look at this", openedAt: "t1" });
    expect(s.gateAttempts).toEqual({ g: 1 });

    s = deriveRunState([...opened, ev("gate_answered", "g", { approved: true, notes: "fine" }, "t2")]);
    expect(s.openGate).toBeUndefined();
    expect(s.steps).toEqual({ g: "completed" });
    expect(s.results).toEqual({ g: { approved: true, notes: "fine" } });

    s = deriveRunState([...opened, ev("gate_answered", "g", { approved: false, notes: "redo" }, "t2")]);
    expect(s.openGate).toBeUndefined();
    expect(s.steps).toEqual({ g: "running" });
    expect(s.results).toEqual({});

    s = deriveRunState([
      ...opened,
      ev("gate_answered", "g", { approved: false, notes: "redo" }, "t2"),
      ev("gate_opened", "g", { attempt: 2, message: "Look again" }, "t3"),
    ]);
    expect(s.openGate?.attempt).toBe(2);
    expect(s.gateAttempts).toEqual({ g: 2 });
    expect(s.steps).toEqual({ g: "waiting" });
  });

  it("treats a cached step as completed", () => {
    const s = deriveRunState([ev("step_cached", "a", { result: 5 }, "t1")]);
    expect(s.steps).toEqual({ a: "completed" });
    expect(s.results).toEqual({ a: 5 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — cannot find module `../src/state.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/state.ts`:
```ts
import type { Event } from "./events.js";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting";

export interface GateState { stepId: string; attempt: number; message: string; openedAt: string }

export interface Progress { done: number; total: number; unit: string; message?: string }

export interface Position { stepId: string; startedAt: string; progress?: Progress }

export interface RunState {
  runId: string;
  finished: boolean;
  status?: "completed" | "failed";
  steps: Record<string, StepStatus>;
  results: Record<string, unknown>;
  openGate?: GateState;
  position?: Position;
  lastEventAt?: string;
  gateAttempts: Record<string, number>;
}

export function deriveRunState(events: Event[]): RunState {
  const s: RunState = { runId: events[0]?.runId ?? "", finished: false, steps: {}, results: {}, gateAttempts: {} };
  for (const e of events) {
    s.lastEventAt = e.ts;
    const id = e.stepId;
    switch (e.kind) {
      case "run_started":
        break;
      case "run_finished":
        s.finished = true;
        s.status = e.payload["status"] === "completed" ? "completed" : "failed";
        delete s.position;
        break;
      case "step_started":
        if (id) { s.steps[id] = "running"; s.position = { stepId: id, startedAt: e.ts }; }
        break;
      case "step_progress":
        if (id && s.position?.stepId === id) {
          const p = e.payload;
          const progress: Progress = { done: Number(p["done"]), total: Number(p["total"]), unit: String(p["unit"] ?? "") };
          if (typeof p["message"] === "string") progress.message = p["message"];
          s.position = { ...s.position, progress };
        }
        break;
      case "step_completed":
      case "step_cached":
        if (id) {
          s.steps[id] = "completed";
          if ("result" in e.payload) s.results[id] = e.payload["result"];
          if (s.position?.stepId === id) delete s.position;
        }
        break;
      case "step_failed":
        if (id) { s.steps[id] = "failed"; if (s.position?.stepId === id) delete s.position; }
        break;
      case "step_skipped":
        if (id) { s.steps[id] = "skipped"; if (s.position?.stepId === id) delete s.position; }
        break;
      case "gate_opened":
        if (id) {
          const attempt = Number(e.payload["attempt"] ?? 1);
          s.steps[id] = "waiting";
          s.gateAttempts[id] = attempt;
          s.openGate = { stepId: id, attempt, message: String(e.payload["message"] ?? ""), openedAt: e.ts };
          if (s.position?.stepId === id) delete s.position;
        }
        break;
      case "gate_answered":
        if (id) {
          if (s.openGate?.stepId === id) delete s.openGate;
          if (e.payload["approved"] === true) {
            s.steps[id] = "completed";
            s.results[id] = e.payload;
          } else {
            // A rejected gate leaves the step "running" with no open gate and no position.
            // The runner treats "running with no position" as mid-step and re-executes the
            // step, which for a gate runs the fix agent and reopens it (next attempt).
            s.steps[id] = "running";
          }
        }
        break;
      default:
        break;
    }
  }
  return s;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/state.test.ts && npm run typecheck`
Expected: PASS, 5 tests; `typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/state.ts engine/test/state.test.ts
git commit -m "engine: run state derived from the event log" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 7: The runner — guards, skipped versus failed, injected executors, caching

**Files:**
- Create: `engine/src/runner.ts`
- Test: `engine/test/runner.test.ts`

**Interfaces:**
- Consumes: `orderSteps`, `EventLog`, `deriveRunState`, `hashFiles`, `sameHashes`, all step types, `Executors`.
- Produces:
  - `interface RunOptions { pipeline: Pipeline; ctx: Omit<RunContext, "results">; log: EventLog; executors: Executors }`
  - `type RunResult = { status: "completed" } | { status: "failed"; stepId: string; error: string } | { status: "waiting"; gate: GateState }`
  - `run(opts: RunOptions): Promise<RunResult>` — reads the log first, so calling it on an existing log resumes; emits `run_started` only when the log is empty; returns as soon as a gate opens; emits `run_finished` on completion or failure.
  - Gate and loop behaviour are added in Tasks 9 and 10; this task makes `run` handle guard, script, and agent steps, skip dependents of failed or skipped steps with distinct reasons, and cache script steps whose declared inputs and outputs are unchanged.

- [ ] **Step 1: Write the failing test**

`engine/test/runner.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, GuardStep, ScriptStep, AgentStep } from "../src/steps.js";

async function show(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "show-"));
}

const okExecutors = (calls: string[]): Executors => ({
  script: async (step) => { calls.push(`script:${step.id}`); return { ok: true }; },
  agent: async (step) => { calls.push(`agent:${step.id}`); return { ok: true, text: "done", toolCalls: 1 }; },
});

describe("run", () => {
  it("runs guard, script, and agent steps in order and finishes", async () => {
    const root = await show();
    const calls: string[] = [];
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: true, message: "ok" }) };
    const s: ScriptStep = { kind: "script", id: "s", dependsOn: ["g"], argv: () => ["true"] };
    const a: AgentStep = { kind: "agent", id: "a", dependsOn: ["s"], promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" };
    const p: Pipeline = { name: "p", steps: [a, s, g] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors(calls) });
    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["script:s", "agent:a"]);
    const kinds = (await log.read()).map((e) => `${e.kind}:${e.stepId ?? "-"}`);
    expect(kinds).toEqual([
      "run_started:-",
      "step_started:g", "step_completed:g",
      "step_started:s", "step_completed:s",
      "step_started:a", "step_completed:a",
      "run_finished:-",
    ]);
  });

  it("fails on a failing guard and skips dependents with distinct reasons", async () => {
    const root = await show();
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: false, message: "no script.md" }) };
    const s: ScriptStep = { kind: "script", id: "s", dependsOn: ["g"], argv: () => ["true"] };
    const t: ScriptStep = { kind: "script", id: "t", dependsOn: ["s"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [g, s, t] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
    expect(res).toEqual({ status: "failed", stepId: "g", error: "no script.md" });
    const events = await log.read();
    const skipped = events.filter((e) => e.kind === "step_skipped");
    expect(skipped.map((e) => [e.stepId, e.payload["reason"]])).toEqual([
      ["s", "dependency failed: g"],
      ["t", "dependency skipped: s"],
    ]);
    expect(events.at(-1)?.kind).toBe("run_finished");
    expect(events.at(-1)?.payload["status"]).toBe("failed");
    expect(await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) }))
      .toEqual({ status: "failed", stepId: "g", error: "no script.md" });
  });

  it("records a failing script and the agent outcome text as a result", async () => {
    const root = await show();
    const execs: Executors = {
      script: async () => ({ ok: false, error: "exit 3" }),
      agent: async () => ({ ok: true, text: "hello", verdict: { pass: true }, toolCalls: 2 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", argv: () => ["false"] };
    const a: AgentStep = { kind: "agent", id: "a", promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: { name: "p", steps: [a, s] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: execs });
    expect(res).toEqual({ status: "failed", stepId: "s", error: "exit 3" });
    const events = await log.read();
    const done = events.find((e) => e.kind === "step_completed" && e.stepId === "a");
    expect(done?.payload["result"]).toEqual({ pass: true });
  });

  it("caches a script step whose declared inputs and outputs are unchanged, and re-runs it when an input changes", async () => {
    const root = await show();
    await writeFile(path.join(root, "in.txt"), "v1");
    let runs = 0;
    const execs: Executors = {
      script: async (_step, ctx) => { runs++; await writeFile(path.join(ctx.showRoot, "out.txt"), `out-${runs}`); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", inputs: ["in.txt"], outputs: ["out.txt"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [s] };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };

    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    expect(await run({ pipeline: p, ctx, log: log1, executors: execs })).toEqual({ status: "completed" });
    expect(runs).toBe(1);

    // A second run of the same log: everything is already completed; nothing re-executes.
    expect(await run({ pipeline: p, ctx, log: log1, executors: execs })).toEqual({ status: "completed" });
    expect(runs).toBe(1);

    // A new run id, same inputs and outputs on disk: the step is served from the prior log's hashes.
    const log2 = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    expect(await run({ pipeline: p, ctx: { ...ctx, runId: "r2" }, log: log2, executors: execs, priorLogs: [log1] })).toEqual({ status: "completed" });
    expect(runs).toBe(1);
    expect((await log2.read()).some((e) => e.kind === "step_cached" && e.stepId === "s")).toBe(true);

    // Change the input: the step re-runs, and input_changed is recorded.
    await writeFile(path.join(root, "in.txt"), "v2");
    const log3 = new EventLog(EventLog.logPath(root, "s02e01", "r3"));
    expect(await run({ pipeline: p, ctx: { ...ctx, runId: "r3" }, log: log3, executors: execs, priorLogs: [log1, log2] })).toEqual({ status: "completed" });
    expect(runs).toBe(2);
    const ev3 = await log3.read();
    expect(ev3.some((e) => e.kind === "input_changed" && e.stepId === "s")).toBe(true);
    expect(ev3.some((e) => e.kind === "step_completed" && e.stepId === "s")).toBe(true);
  });

  it("re-runs a script step that declares outputs but no inputs, and never caches it", async () => {
    const root = await show();
    let runs = 0;
    const execs: Executors = {
      script: async (_step, ctx) => { runs++; await writeFile(path.join(ctx.showRoot, "out.txt"), "same"); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", outputs: ["out.txt"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [s] };
    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: log1, executors: execs });
    const log2 = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    await run({ pipeline: p, ctx: { runId: "r2", episodeId: "s02e01", showRoot: root }, log: log2, executors: execs, priorLogs: [log1] });
    expect(runs).toBe(2);
    expect((await log2.read()).some((e) => e.kind === "step_cached")).toBe(false);
  });

  it("re-executes a step whose log shows it running with no terminal event", async () => {
    const root = await show();
    const calls: string[] = [];
    const g: GuardStep = { kind: "guard", id: "g", check: () => { calls.push("g"); return { pass: true }; } };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await log.append({ runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } });
    await log.append({ runId: "r1", stepId: "g", kind: "step_started", payload: { kind: "guard" } });
    const res = await run({ pipeline: { name: "p", steps: [g] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["g"]);
    const starts = (await log.read()).filter((e) => e.kind === "step_started" && e.stepId === "g");
    expect(starts).toHaveLength(2);
  });
});
```

Note the test introduces `priorLogs?: EventLog[]` on `RunOptions`: the logs of earlier runs of the same episode, consulted for cached hashes. Add it to the interface.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — cannot find module `../src/runner.js`.

- [ ] **Step 3: Write the runner**

`engine/src/runner.ts`:
```ts
import type { EventLog, Event } from "./events.js";
import { orderSteps } from "./pipeline.js";
import { deriveRunState, type GateState, type RunState } from "./state.js";
import { hashFiles, sameHashes } from "./hash.js";
import type {
  AgentStep, Emit, Executors, GateStep, LoopStep, Pipeline, RunContext, ScriptStep, Step, StepId,
} from "./steps.js";

export interface RunOptions {
  pipeline: Pipeline;
  ctx: Omit<RunContext, "results">;
  log: EventLog;
  executors: Executors;
  /** Logs of earlier runs of the same episode, consulted for cached step hashes. */
  priorLogs?: EventLog[];
}

export type RunResult =
  | { status: "completed" }
  | { status: "failed"; stepId: StepId; error: string }
  | { status: "waiting"; gate: GateState };

type Hashes = Record<string, string | null>;

interface CachedCompletion { inputHashes: Hashes; outputHashes: Hashes; result?: unknown }

/** The most recent step_completed for a step across a set of logs, newest log last. */
function lastCompletion(stepId: StepId, logs: Event[][]): CachedCompletion | undefined {
  for (let i = logs.length - 1; i >= 0; i--) {
    const events = logs[i] ?? [];
    for (let j = events.length - 1; j >= 0; j--) {
      const e = events[j];
      if (!e || e.stepId !== stepId) continue;
      if (e.kind === "step_completed" || e.kind === "step_cached") {
        const inputHashes = e.payload["inputHashes"];
        const outputHashes = e.payload["outputHashes"];
        if (inputHashes && outputHashes) {
          const c: CachedCompletion = { inputHashes: inputHashes as Hashes, outputHashes: outputHashes as Hashes };
          if ("result" in e.payload) c.result = e.payload["result"];
          return c;
        }
      }
    }
  }
  return undefined;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const { pipeline, log, executors } = opts;
  const ordered = orderSteps(pipeline);
  const priorEvents: Event[][] = [];
  for (const pl of opts.priorLogs ?? []) priorEvents.push(await pl.read());
  const ownEvents = await log.read();

  if (ownEvents.length === 0) {
    await log.append({ runId: opts.ctx.runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: opts.ctx.episodeId } });
  }

  const state: RunState = deriveRunState(await log.read());
  if (state.finished) {
    if (state.status === "completed") return { status: "completed" };
    const failedId = Object.entries(state.steps).find(([, v]) => v === "failed")?.[0] ?? "";
    let error = "failed in an earlier attempt";
    for (let i = ownEvents.length - 1; i >= 0; i--) {
      const e = ownEvents[i];
      if (e && e.kind === "step_failed" && e.stepId === failedId && typeof e.payload["error"] === "string") {
        error = e.payload["error"];
        break;
      }
    }
    return { status: "failed", stepId: failedId, error };
  }
  if (state.openGate) return { status: "waiting", gate: state.openGate };

  const ctx: RunContext = { ...opts.ctx, results: { ...state.results } };
  const emitFor = (stepId: StepId | undefined): Emit => async (kind, payload) => {
    await log.append(stepId === undefined
      ? { runId: ctx.runId, kind, payload }
      : { runId: ctx.runId, stepId, kind, payload });
  };

  for (const step of ordered) {
    const status = state.steps[step.id] ?? "pending";
    if (status === "completed") continue;
    if (status === "failed") return finish({ status: "failed", stepId: step.id, error: "failed in an earlier attempt" });
    if (status === "skipped") continue;

    // Dependency check: failed and skipped are distinct reasons.
    let skipReason: string | undefined;
    for (const d of step.dependsOn ?? []) {
      const ds = state.steps[d] ?? "pending";
      if (ds === "failed") { skipReason = `dependency failed: ${d}`; break; }
      if (ds === "skipped") { skipReason = `dependency skipped: ${d}`; break; }
    }
    if (skipReason) {
      await emitFor(step.id)("step_skipped", { reason: skipReason });
      state.steps[step.id] = "skipped";
      continue;
    }

    const outcome = await runStep(step, ctx, emitFor, executors, log, [...priorEvents, await log.read()]);
    if (outcome.kind === "completed") {
      state.steps[step.id] = "completed";
      if (outcome.result !== undefined) ctx.results[step.id] = outcome.result;
      continue;
    }
    if (outcome.kind === "waiting") return { status: "waiting", gate: outcome.gate };
    // failed
    state.steps[step.id] = "failed";
    // Skip everything downstream so the log is complete, then finish.
    const failedId = step.id;
    for (const later of ordered) {
      if (later === step || state.steps[later.id]) continue;
      const deps = later.dependsOn ?? [];
      const viaFailed = deps.find((d) => state.steps[d] === "failed");
      const viaSkipped = deps.find((d) => state.steps[d] === "skipped");
      if (viaFailed || viaSkipped) {
        const reason = viaFailed ? `dependency failed: ${viaFailed}` : `dependency skipped: ${viaSkipped}`;
        await emitFor(later.id)("step_skipped", { reason });
        state.steps[later.id] = "skipped";
      }
    }
    return finish({ status: "failed", stepId: failedId, error: outcome.error });
  }
  return finish({ status: "completed" });

  async function finish(r: RunResult): Promise<RunResult> {
    await emitFor(undefined)("run_finished", { status: r.status === "completed" ? "completed" : "failed" });
    return r;
  }
}

type StepOutcome =
  | { kind: "completed"; result?: unknown }
  | { kind: "failed"; error: string }
  | { kind: "waiting"; gate: GateState };

async function runStep(
  step: Step, ctx: RunContext, emitFor: (id: StepId | undefined) => Emit,
  executors: Executors, log: EventLog, allLogs: Event[][],
): Promise<StepOutcome> {
  const emit = emitFor(step.id);
  switch (step.kind) {
    case "guard": {
      await emit("step_started", { kind: "guard" });
      const r = await step.check(ctx);
      if (r.pass) {
        await emit("step_completed", { result: r.message ?? null });
        return { kind: "completed", result: r.message ?? null };
      }
      await emit("step_failed", { error: r.message });
      return { kind: "failed", error: r.message };
    }
    case "script":
      return runScriptStep(step, ctx, emit, executors, allLogs);
    case "agent":
      return runAgentStep(step, ctx, emit, executors);
    case "gate":
      return runGateStep(step, ctx, emit, executors, log);
    case "loop":
      return runLoopStep(step, ctx, emit, executors);
  }
}

async function runScriptStep(
  step: ScriptStep, ctx: RunContext, emit: Emit, executors: Executors, allLogs: Event[][],
): Promise<StepOutcome> {
  const inputs = step.inputs ?? [];
  const outputs = step.outputs ?? [];
  const inputHashes = await hashFiles(ctx.showRoot, inputs);
  const prior = lastCompletion(step.id, allLogs);
  if (prior && inputs.length > 0) {
    const outputHashesNow = await hashFiles(ctx.showRoot, outputs);
    if (sameHashes(prior.inputHashes, inputHashes) && sameHashes(prior.outputHashes, outputHashesNow)) {
      const payload: Record<string, unknown> = { inputHashes, outputHashes: outputHashesNow };
      if (prior.result !== undefined) payload["result"] = prior.result;
      await emit("step_cached", payload);
      return { kind: "completed", ...(prior.result !== undefined ? { result: prior.result } : {}) };
    }
    if (!sameHashes(prior.inputHashes, inputHashes)) {
      await emit("input_changed", { before: prior.inputHashes, after: inputHashes });
    }
  }
  await emit("step_started", { kind: "script", argv: step.argv(ctx), inputHashes });
  const r = await executors.script(step, ctx, emit);
  if (!r.ok) {
    await emit("step_failed", { error: r.error });
    return { kind: "failed", error: r.error };
  }
  const outputHashes = await hashFiles(ctx.showRoot, outputs);
  await emit("step_completed", { inputHashes, outputHashes });
  return { kind: "completed" };
}

async function runAgentStep(step: AgentStep, ctx: RunContext, emit: Emit, executors: Executors): Promise<StepOutcome> {
  const inputHashes = await hashFiles(ctx.showRoot, step.inputs ?? []);
  await emit("step_started", { kind: "agent", inputHashes });
  const r = await executors.agent(step, ctx, emit);
  if (!r.ok) {
    await emit("step_failed", { error: r.error });
    return { kind: "failed", error: r.error };
  }
  const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
  const result = r.verdict !== undefined ? r.verdict : r.text;
  await emit("step_completed", { inputHashes, outputHashes, result, toolCalls: r.toolCalls });
  return { kind: "completed", result };
}

// Gate and loop are completed in Tasks 9 and 10. Until then they are explicit failures,
// so a pipeline using them cannot silently pass.
async function runGateStep(step: GateStep, _ctx: RunContext, emit: Emit, _executors: Executors, _log: EventLog): Promise<StepOutcome> {
  await emit("step_failed", { error: `gate step ${step.id}: not implemented` });
  return { kind: "failed", error: `gate step ${step.id}: not implemented` };
}

async function runLoopStep(step: LoopStep, _ctx: RunContext, emit: Emit, _executors: Executors): Promise<StepOutcome> {
  await emit("step_failed", { error: `loop step ${step.id}: not implemented` });
  return { kind: "failed", error: `loop step ${step.id}: not implemented` };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/runner.test.ts && npm run typecheck`
Expected: PASS, 6 tests; `typecheck` exits 0. (The unused `_ctx`/`_executors`/`_log` parameters are named with a leading underscore so `tsc` does not complain; they are used in Tasks 9 and 10.)

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/runner.ts engine/test/runner.test.ts
git commit -m "engine: the runner — ordered execution, skipped vs failed, injected executors, input-hash caching" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 8: The script executor — argv, streamed lines, `::progress`

**Files:**
- Create: `engine/src/script-step.ts`
- Create: `engine/test/fixtures/progress.py`, `engine/test/fixtures/fail.py`
- Test: `engine/test/script-step.test.ts`

**Interfaces:**
- Consumes: `ScriptStep`, `RunContext`, `Emit`, `ScriptOutcome` from `steps.ts`.
- Produces:
  - `parseProgressLine(line: string): { done: number; total: number; unit: string; message?: string } | null` — recognizes `::progress {json}`; returns `null` for any other line or malformed JSON
  - `scriptExecutor: Executors["script"]` — spawns `argv[0]` with `argv.slice(1)` (never a shell), `cwd` = `step.cwd ?? ctx.showRoot`, env = process env merged with `step.env?.(ctx)`; forwards every stdout/stderr line as `script_line` (`{stream, line}`) except progress lines, which become `step_progress`; resolves `{ok:true}` on exit 0, `{ok:false, error:"exit <code>: <last stderr line>"}` on a non-zero code and `"signal <sig>: <last stderr line>"` on a signal; kills the child's whole process group and fails with `"timeout after <ms>ms"` when `step.timeoutMs` elapses; events are emitted strictly in order behind one chained promise, and a rejected `emit` fails the step with `"log write failed: <message>"` instead of hanging. The child is spawned detached, and the pipes are drained for at most 2 s after exit so a grandchild holding them cannot block the outcome.

- [ ] **Step 1: Write the fixtures**

`engine/test/fixtures/progress.py`:
```python
import json, sys
total = int(sys.argv[1]) if len(sys.argv) > 1 else 3
print("starting")
for i in range(1, total + 1):
    print("::progress " + json.dumps({"done": i, "total": total, "unit": "segments"}), flush=True)
print("done", file=sys.stderr)
```

`engine/test/fixtures/fail.py`:
```python
import sys
print("about to fail")
print("the reason", file=sys.stderr)
sys.exit(3)
```

- [ ] **Step 2: Write the failing test**

`engine/test/script-step.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgressLine, scriptExecutor } from "../src/script-step.js";
import type { ScriptStep, RunContext, EventKind } from "../src/steps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);
const ctx: RunContext = { runId: "r", episodeId: "s02e01", showRoot: here, results: {} };

function collector() {
  const events: { kind: EventKind; payload: Record<string, unknown> }[] = [];
  const emit = async (kind: EventKind, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  return { events, emit };
}

describe("parseProgressLine", () => {
  it("parses a progress line and ignores everything else", () => {
    expect(parseProgressLine('::progress {"done":2,"total":5,"unit":"shots"}')).toEqual({ done: 2, total: 5, unit: "shots" });
    expect(parseProgressLine('::progress {"done":2,"total":5,"unit":"shots","message":"s02-x"}')).toEqual({ done: 2, total: 5, unit: "shots", message: "s02-x" });
    expect(parseProgressLine("hello")).toBeNull();
    expect(parseProgressLine("::progress not json")).toBeNull();
  });
});

describe("scriptExecutor", () => {
  it("streams lines, turns progress lines into step_progress, and succeeds on exit 0", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("progress.py"), "3"] };
    const { events, emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true });
    const progress = events.filter((e) => e.kind === "step_progress").map((e) => e.payload["done"]);
    expect(progress).toEqual([1, 2, 3]);
    const lines = events.filter((e) => e.kind === "script_line").map((e) => [e.payload["stream"], e.payload["line"]]);
    expect(lines).toContainEqual(["stdout", "starting"]);
    expect(lines).toContainEqual(["stderr", "done"]);
    expect(lines.some(([, l]) => String(l).startsWith("::progress"))).toBe(false);
  });

  it("fails with the exit code and the last stderr line", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("fail.py")] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "exit 3: the reason" });
  });

  it("fails on timeout", async () => {
    const step: ScriptStep = { kind: "script", id: "s", timeoutMs: 200, argv: () => ["python3", "-c", "import time; time.sleep(5)"] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "timeout after 200ms" });
  });

  it("never goes through a shell", async () => {
    // If argv were joined into a shell string, the semicolon would run `echo pwned`; as argv it is a literal filename.
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "import sys; print(sys.argv[1])", "a; echo pwned"] };
    const { events, emit } = collector();
    await scriptExecutor(step, ctx, emit);
    const out = events.filter((e) => e.kind === "script_line").map((e) => e.payload["line"]);
    expect(out).toEqual(["a; echo pwned"]);
  });

  it("preserves script_line order even when the log write is slow and jittery", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "for i in range(300): print(i)"] };
    const events: { kind: EventKind; payload: Record<string, unknown> }[] = [];
    const emit = async (kind: EventKind, payload: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      events.push({ kind, payload });
    };
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true });
    const lines = events.filter((e) => e.kind === "script_line").map((e) => Number(e.payload["line"]));
    expect(lines).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("fails the step, and never hangs or leaks a rejection, when the log write rejects", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("progress.py"), "3"] };
    let n = 0;
    const emit = async () => { if (++n === 2) throw new Error("disk full"); };
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "log write failed: disk full" });
  });

  it("times out even when a grandchild holds the stdio pipes open", async () => {
    const step: ScriptStep = {
      kind: "script", id: "s", timeoutMs: 300,
      argv: () => ["python3", "-c", "import subprocess, time; subprocess.Popen(['sleep', '30']); time.sleep(30)"],
    };
    const { emit } = collector();
    const started = Date.now();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "timeout after 300ms" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/script-step.test.ts`
Expected: FAIL — cannot find module `../src/script-step.js`.

- [ ] **Step 4: Write the implementation**

`engine/src/script-step.ts`:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Emit, EventKind, Executors, RunContext, ScriptOutcome, ScriptStep } from "./steps.js";

const PROGRESS_PREFIX = "::progress ";

export interface ProgressLine { done: number; total: number; unit: string; message?: string }

export function parseProgressLine(line: string): ProgressLine | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const v = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Record<string, unknown>;
    if (typeof v["done"] !== "number" || typeof v["total"] !== "number") return null;
    const out: ProgressLine = { done: v["done"], total: v["total"], unit: typeof v["unit"] === "string" ? v["unit"] : "" };
    if (typeof v["message"] === "string") out.message = v["message"];
    return out;
  } catch {
    return null;
  }
}

/** How long to wait, after the child exits, for its stdio pipes to drain before giving up on
 *  them — a grandchild that inherited the pipes can hold them open after the child is gone. */
const DRAIN_GRACE_MS = 2000;

export const scriptExecutor: Executors["script"] = (step: ScriptStep, ctx: RunContext, emit: Emit) => {
  const argv = step.argv(ctx);
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ ok: false, error: "empty argv" });
  const env = { ...process.env, ...(step.env ? step.env(ctx) : {}) };
  // detached: the child leads its own process group, so a timeout can kill the whole group,
  // grandchildren included, rather than only the direct child.
  const child = spawn(cmd, args, { cwd: step.cwd ?? ctx.showRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  let lastStderr = "";
  let emitError: unknown;
  // Every event is queued behind the previous one: order is preserved, and a rejected write is
  // caught the moment it happens instead of surfacing as an unhandled rejection.
  let tail: Promise<void> = Promise.resolve();
  const queue = (kind: EventKind, payload: Record<string, unknown>) => {
    tail = tail.then(() => emit(kind, payload)).catch((e: unknown) => { emitError ??= e; });
  };
  const wire = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      const p = name === "stdout" ? parseProgressLine(line) : null;
      if (p) {
        queue("step_progress", { ...p });
      } else {
        if (name === "stderr" && line.trim() !== "") lastStderr = line;
        queue("script_line", { stream: name, line });
      }
    });
    return new Promise<void>((resolve) => rl.on("close", () => resolve()));
  };
  const outDone = wire(child.stdout, "stdout");
  const errDone = wire(child.stderr, "stderr");

  const killGroup = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  return new Promise<ScriptOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timer = step.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; killGroup(); }, step.timeoutMs)
      : undefined;
    const settle = async (outcome: ScriptOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Drain what the pipes still hold, but never wait forever on a grandchild holding them open.
      const grace = new Promise<void>((r) => { const t = setTimeout(r, DRAIN_GRACE_MS); t.unref(); });
      await Promise.race([Promise.all([outDone, errDone]), grace]);
      await tail;
      if (emitError !== undefined && outcome.ok) {
        const msg = emitError instanceof Error ? emitError.message : String(emitError);
        resolve({ ok: false, error: `log write failed: ${msg}` });
        return;
      }
      resolve(outcome);
    };
    child.on("error", (err) => { void settle({ ok: false, error: `spawn failed: ${err.message}` }); });
    child.on("exit", (code, signal) => {
      if (timedOut) { void settle({ ok: false, error: `timeout after ${step.timeoutMs}ms` }); return; }
      if (code === 0) { void settle({ ok: true }); return; }
      const shown = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
      void settle({ ok: false, error: `${shown}: ${lastStderr}` });
    });
  });
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/script-step.test.ts && npm run typecheck`
Expected: PASS, 8 tests; `typecheck` exits 0.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/script-step.ts engine/test/script-step.test.ts engine/test/fixtures
git commit -m "engine: script executor — argv only, streamed lines, ::progress contract, timeout" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 9: Gates — pause, answer, reject-and-fix, resume by replay

**Files:**
- Modify: `engine/src/runner.ts` (replace `runGateStep`; add `answerGate`)
- Test: `engine/test/gate.test.ts`

**Interfaces:**
- Produces:
  - `answerGate(log: EventLog, runId: string, stepId: string, answer: { approved: boolean; notes?: string; by?: string }): Promise<void>` — appends `gate_answered` with the answer and `waitedMs` (time since the matching `gate_opened`); throws if that gate is not the open one.
  - Gate semantics in `run`: on reaching a gate with no open attempt, emit `gate_opened {attempt, message}` and return `{status:"waiting", gate}`. On a later `run` call: an approved answer completes the gate with the answer as its result; a rejected answer runs `step.onReject` (if any) via the agent executor with the rejection notes available as `ctx.results[step.id + ":rejection"]`, then opens attempt `n+1`; when `n+1 > (step.maxAttempts ?? 10)` the gate fails with `"rejected <n> times"`.

- [ ] **Step 1: Write the failing test**

`engine/test/gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, answerGate } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, GateStep, GuardStep, AgentStep } from "../src/steps.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const fixCalls: string[] = [];
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step, ctx) => { fixCalls.push(`${step.id}:${String(ctx.results[`g:rejection`] ?? "")}`); return { ok: true, text: "fixed", toolCalls: 1 }; },
  };
  const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh" };
  const before: GuardStep = { kind: "guard", id: "before", check: () => ({ pass: true }) };
  const g: GateStep = { kind: "gate", id: "g", dependsOn: ["before"], message: (ctx) => `Approve ${ctx.episodeId}?`, onReject: fix, maxAttempts: 2 };
  const after: GuardStep = { kind: "guard", id: "after", dependsOn: ["g"], check: () => ({ pass: true }) };
  const pipeline: Pipeline = { name: "p", steps: [before, g, after] };
  const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
  const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
  return { pipeline, log, ctx, executors, fixCalls };
}

describe("gates", () => {
  it("opens the gate and stops; resumes past it on approval", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    const r1 = await run({ pipeline, ctx, log, executors });
    expect(r1.status).toBe("waiting");
    if (r1.status !== "waiting") return;
    expect(r1.gate).toMatchObject({ stepId: "g", attempt: 1, message: "Approve s02e01?" });

    // Calling run again without an answer stays waiting and appends nothing new.
    const n = (await log.read()).length;
    expect(await run({ pipeline, ctx, log, executors })).toMatchObject({ status: "waiting" });
    expect((await log.read()).length).toBe(n);

    await answerGate(log, "r1", "g", { approved: true, notes: "looks right", by: "showrunner" });
    const r2 = await run({ pipeline, ctx, log, executors });
    expect(r2).toEqual({ status: "completed" });
    const events = await log.read();
    const answered = events.find((e) => e.kind === "gate_answered");
    expect(answered?.payload).toMatchObject({ approved: true, notes: "looks right", by: "showrunner" });
    expect(typeof answered?.payload["waitedMs"]).toBe("number");
    expect(events.some((e) => e.kind === "step_completed" && e.stepId === "after")).toBe(true);
  });

  it("on rejection runs the fix agent with the notes, then reopens the gate as attempt 2", async () => {
    const { pipeline, log, ctx, executors, fixCalls } = await setup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "scene two is flat" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(fixCalls).toEqual(["fix:scene two is flat"]);
  });

  it("fails the gate when rejections exceed maxAttempts", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "no" });
    await run({ pipeline, ctx, log, executors }); // attempt 2 opens
    await answerGate(log, "r1", "g", { approved: false, notes: "still no" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toEqual({ status: "failed", stepId: "g", error: "rejected 2 times" });
    const events = await log.read();
    expect(events.some((e) => e.kind === "step_skipped" && e.stepId === "after")).toBe(true);
  });

  it("refuses to answer a gate that is not open", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await expect(answerGate(log, "r1", "after", { approved: true })).rejects.toThrow(/not open/);
  });

  it("resumes at the open gate after a restart, from the log alone", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    // A "restart": a fresh EventLog object over the same file, nothing in memory.
    const fresh = new EventLog(log.path);
    const r = await run({ pipeline, ctx, log: fresh, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 1 } });
    await answerGate(fresh, "r1", "g", { approved: true });
    expect(await run({ pipeline, ctx, log: fresh, executors })).toEqual({ status: "completed" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/gate.test.ts`
Expected: FAIL — `answerGate` is not exported / gate step "not implemented".

- [ ] **Step 3: Implement gates in `runner.ts`**

Add the export after `RunResult`:
```ts
export async function answerGate(
  log: EventLog, runId: string, stepId: StepId,
  answer: { approved: boolean; notes?: string; by?: string },
): Promise<void> {
  const state = deriveRunState(await log.read());
  if (!state.openGate || state.openGate.stepId !== stepId) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not open on run ${runId}`);
  }
  const waitedMs = Date.now() - new Date(state.openGate.openedAt).getTime();
  const payload: Record<string, unknown> = { approved: answer.approved, waitedMs, attempt: state.openGate.attempt };
  if (answer.notes !== undefined) payload["notes"] = answer.notes;
  if (answer.by !== undefined) payload["by"] = answer.by;
  await log.append({ runId, stepId, kind: "gate_answered", payload });
}
```

Replace the placeholder `runGateStep` with:
```ts
async function runGateStep(step: GateStep, ctx: RunContext, emit: Emit, executors: Executors, log: EventLog): Promise<StepOutcome> {
  const events = await log.read();
  const state = deriveRunState(events);
  const attempts = state.gateAttempts[step.id] ?? 0;
  const maxAttempts = step.maxAttempts ?? 10;

  // Find the latest answer for this gate, if any, and whether an attempt is already open.
  let lastAnswer: Event | undefined;
  let lastOpened: Event | undefined;
  for (const e of events) {
    if (e.stepId !== step.id) continue;
    if (e.kind === "gate_opened") lastOpened = e;
    if (e.kind === "gate_answered") lastAnswer = e;
  }
  const answeredCurrent = lastAnswer && lastOpened && lastAnswer.ts >= lastOpened.ts;

  if (lastOpened && !answeredCurrent) {
    return { kind: "waiting", gate: state.openGate ?? { stepId: step.id, attempt: attempts, message: String(lastOpened.payload["message"] ?? ""), openedAt: lastOpened.ts } };
  }

  if (lastAnswer && answeredCurrent) {
    if (lastAnswer.payload["approved"] === true) {
      // deriveRunState already marks it completed; the runner loop skips completed steps, so this
      // branch is reached only when the answer arrived between state derivation and execution.
      return { kind: "completed", result: lastAnswer.payload };
    }
    // Rejected: run the fix agent (if any), then decide whether another attempt is allowed.
    if (attempts >= maxAttempts) {
      const error = `rejected ${attempts} times`;
      await emit("step_failed", { error });
      return { kind: "failed", error };
    }
    if (step.onReject) {
      const notes = lastAnswer.payload["notes"];
      const fixCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.id}:rejection`]: notes ?? "" } };
      const fixEmit: Emit = async (kind, payload) => { await log.append({ runId: ctx.runId, stepId: step.onReject!.id, kind, payload }); };
      await fixEmit("step_started", { kind: "agent", rejectionOf: step.id, attempt: attempts });
      const r = await executors.agent(step.onReject, fixCtx, fixEmit);
      if (!r.ok) {
        await fixEmit("step_failed", { error: r.error });
        await emit("step_failed", { error: `fix agent failed: ${r.error}` });
        return { kind: "failed", error: `fix agent failed: ${r.error}` };
      }
      await fixEmit("step_completed", { result: r.verdict ?? r.text, toolCalls: r.toolCalls });
    }
  }

  const attempt = attempts + 1;
  const message = step.message(ctx);
  await emit("gate_opened", { attempt, message });
  return { kind: "waiting", gate: { stepId: step.id, attempt, message, openedAt: new Date().toISOString() } };
}
```

Then, in `run`, the early return `if (state.openGate) return { status: "waiting", gate: state.openGate };` already handles "run called again without an answer" — keep it. And the loop's `status === "failed"` check is what makes the exceeded-attempts case skip `after` and finish: no change needed there because `runStep` returns `failed` and the existing downstream-skip code runs.

One adjustment in `run`: a gate that was rejected leaves `state.steps[g] === "running"` (from `deriveRunState`), which the loop treats as "not completed, not failed, not skipped" and executes — correct. Nothing else changes.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/gate.test.ts test/runner.test.ts && npm run typecheck`
Expected: PASS, 11 tests across the two files; `typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/runner.ts engine/test/gate.test.ts
git commit -m "engine: gates — open, answer, reject-and-fix with attempt cap, resume by replay" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 10: Loops — sentinel, iteration cap, zero-tool-call visibility

**Files:**
- Modify: `engine/src/runner.ts` (replace `runLoopStep`)
- Test: `engine/test/loop.test.ts`

**Interfaces:**
- Loop semantics: run `step.body` via the agent executor up to `step.maxIterations` times, each with a fresh `ctx.results` snapshot plus `[body.id + ":iteration"] = n`. After each, emit `loop_iteration {iteration, max, sentinel: boolean, toolCalls}`. Stop with `completed` (result = the final text) the first time the body's text contains `step.until`. **If the cap is reached without the sentinel, the step fails** with `"exhausted <max> iterations without sentinel <until>"`.

- [ ] **Step 1: Write the failing test**

`engine/test/loop.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, LoopStep, AgentStep } from "../src/steps.js";

const body: AgentStep = { kind: "agent", id: "draft", promptFile: "draft.md", model: "m", allowedTools: ["Read", "Write"], context: "fresh" };

async function runLoop(texts: string[], toolCalls: number[], maxIterations: number) {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  let i = 0;
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async () => { const n = i++; return { ok: true, text: texts[n] ?? "", toolCalls: toolCalls[n] ?? 0 }; },
  };
  const loop: LoopStep = { kind: "loop", id: "draft-loop", body, until: "DRAFT_COMPLETE", maxIterations };
  const pipeline: Pipeline = { name: "p", steps: [loop] };
  const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
  const result = await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });
  return { result, events: await log.read() };
}

describe("loops", () => {
  it("iterates until the sentinel appears and records each iteration", async () => {
    const { result, events } = await runLoop(["scene one", "scene two", "all done DRAFT_COMPLETE"], [4, 5, 2], 15);
    expect(result).toEqual({ status: "completed" });
    const iters = events.filter((e) => e.kind === "loop_iteration").map((e) => e.payload);
    expect(iters).toEqual([
      { iteration: 1, max: 15, sentinel: false, toolCalls: 4 },
      { iteration: 2, max: 15, sentinel: false, toolCalls: 5 },
      { iteration: 3, max: 15, sentinel: true, toolCalls: 2 },
    ]);
    expect(events.filter((e) => e.kind === "step_completed" && e.stepId === "draft-loop")).toHaveLength(1);
  });

  it("fails when the cap is reached without the sentinel, and shows the dead iterations", async () => {
    const { result, events } = await runLoop(["scene one", "", ""], [3, 0, 0], 3);
    expect(result).toEqual({ status: "failed", stepId: "draft-loop", error: "exhausted 3 iterations without sentinel DRAFT_COMPLETE" });
    const dead = events.filter((e) => e.kind === "loop_iteration" && e.payload["toolCalls"] === 0);
    expect(dead).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL — loop step "not implemented".

- [ ] **Step 3: Implement loops in `runner.ts`**

Replace the placeholder `runLoopStep` with:
```ts
async function runLoopStep(step: LoopStep, ctx: RunContext, emit: Emit, executors: Executors): Promise<StepOutcome> {
  await emit("step_started", { kind: "loop", body: step.body.id, until: step.until, max: step.maxIterations });
  for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
    const iterCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.body.id}:iteration`]: iteration } };
    const r = await executors.agent(step.body, iterCtx, emit);
    if (!r.ok) {
      await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel: false, toolCalls: 0, error: r.error });
      await emit("step_failed", { error: `iteration ${iteration}: ${r.error}` });
      return { kind: "failed", error: `iteration ${iteration}: ${r.error}` };
    }
    const sentinel = r.text.includes(step.until);
    await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel, toolCalls: r.toolCalls });
    if (sentinel) {
      await emit("step_completed", { result: r.text, iterations: iteration });
      return { kind: "completed", result: r.text };
    }
  }
  const error = `exhausted ${step.maxIterations} iterations without sentinel ${step.until}`;
  await emit("step_failed", { error });
  return { kind: "failed", error };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: every test file passes (smoke, ids, pipeline, events, hash, state, runner, script-step, gate, loop); `typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/runner.ts engine/test/loop.test.ts
git commit -m "engine: loops — sentinel, iteration cap, exhaustion is failure, tool-call counts per iteration" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
```

---

### Task 11: The milestone vocabulary and stage derivation

**Files:**
- Create: `engine/src/stages.ts`
- Test: `engine/test/stages.test.ts`

**Interfaces:**
- Produces:
  - `const STAGES = ["NEEDS_IDEA","DRAFT_IDEA","IDEA","DRAFT_OUTLINE","OUTLINE","DRAFT_SCRIPT","SCRIPT","NEEDS_REFS","DRAFT_CASTING","CASTING","DRAFT_AUDIO","AUDIO","NEEDS_IMAGES","DRAFT_IMAGES","IMAGES","DRAFT_ASSEMBLY","ASSEMBLY","PUBLISH_KIT","DRAFT_CANON","CANON","COMPLETE"] as const`
  - `type Stage = typeof STAGES[number]`
  - `interface StageMap { gates: Record<string, Stage>; approved: Record<string, Stage>; final: Stage }` — for a pipeline: which gate step opens which `DRAFT_` stage, which step's completion reaches which approved stage, and the stage reached when the run completes
  - `interface Needs { refsMissing: boolean; imagesMissing: boolean; ideaMissing: boolean }` — computed by probes supplied in Plan D
  - `deriveStage(state: RunState, map: StageMap, needs: Needs): Stage` — `needs` wins when its stage has not yet been passed; otherwise the open gate's `DRAFT_` stage; otherwise the highest approved stage reached; `COMPLETE`/`map.final` when the run finished successfully
  - `stageIndex(s: Stage): number` and `compareStages(a, b)`

- [ ] **Step 1: Write the failing test**

`engine/test/stages.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { STAGES, deriveStage, stageIndex, compareStages, type StageMap } from "../src/stages.js";
import type { RunState } from "../src/state.js";

const map: StageMap = {
  gates: { "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO", "image-gate": "DRAFT_IMAGES" },
  approved: { "outline-gate": "OUTLINE", "script-gate": "SCRIPT", "casting-gate": "CASTING", "audio-gate": "AUDIO", "image-gate": "IMAGES" },
  final: "COMPLETE",
};
const none = { refsMissing: false, imagesMissing: false, ideaMissing: false };
const base = (over: Partial<RunState>): RunState => ({ runId: "r", finished: false, steps: {}, results: {}, gateAttempts: {}, ...over });

describe("stages", () => {
  it("has the exact vocabulary in order", () => {
    expect(STAGES).toEqual([
      "NEEDS_IDEA","DRAFT_IDEA","IDEA","DRAFT_OUTLINE","OUTLINE","DRAFT_SCRIPT","SCRIPT","NEEDS_REFS","DRAFT_CASTING","CASTING",
      "DRAFT_AUDIO","AUDIO","NEEDS_IMAGES","DRAFT_IMAGES","IMAGES","DRAFT_ASSEMBLY","ASSEMBLY","PUBLISH_KIT","DRAFT_CANON","CANON","COMPLETE",
    ]);
    expect(stageIndex("IDEA")).toBe(2);
    expect(compareStages("SCRIPT", "OUTLINE")).toBeGreaterThan(0);
  });

  it("reports NEEDS_IDEA before anything exists", () => {
    expect(deriveStage(base({}), map, { ...none, ideaMissing: true })).toBe("NEEDS_IDEA");
    expect(deriveStage(base({}), map, none)).toBe("IDEA");
  });

  it("reports the open gate's draft stage", () => {
    const s = base({ steps: { "outline-gate": "waiting" }, openGate: { stepId: "outline-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(s, map, none)).toBe("DRAFT_OUTLINE");
  });

  it("reports the highest approved stage reached while working toward the next", () => {
    const s = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "tts-generate": "running" } });
    expect(deriveStage(s, map, none)).toBe("SCRIPT");
  });

  it("lets a NEEDS_ stage interrupt at the right point and not after it is passed", () => {
    const afterScript = base({ steps: { "outline-gate": "completed", "script-gate": "completed" } });
    expect(deriveStage(afterScript, map, { ...none, refsMissing: true })).toBe("NEEDS_REFS");
    const afterCasting = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed" } });
    expect(deriveStage(afterCasting, map, { ...none, refsMissing: true })).toBe("CASTING");
    const afterAudio = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed" } });
    expect(deriveStage(afterAudio, map, { ...none, imagesMissing: true })).toBe("NEEDS_IMAGES");
    const imagesGateOpen = base({ steps: { "audio-gate": "completed", "image-gate": "waiting" }, openGate: { stepId: "image-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(imagesGateOpen, map, { ...none, imagesMissing: true })).toBe("NEEDS_IMAGES");
    expect(deriveStage(imagesGateOpen, map, none)).toBe("DRAFT_IMAGES");
  });

  it("reports the final stage when the run completed", () => {
    expect(deriveStage(base({ finished: true, status: "completed" }), map, none)).toBe("COMPLETE");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/stages.test.ts`
Expected: FAIL — cannot find module `../src/stages.js`.

- [ ] **Step 3: Write the implementation**

`engine/src/stages.ts`:
```ts
import type { RunState } from "./state.js";

export const STAGES = [
  "NEEDS_IDEA", "DRAFT_IDEA", "IDEA",
  "DRAFT_OUTLINE", "OUTLINE",
  "DRAFT_SCRIPT", "SCRIPT",
  "NEEDS_REFS",
  "DRAFT_CASTING", "CASTING",
  "DRAFT_AUDIO", "AUDIO",
  "NEEDS_IMAGES", "DRAFT_IMAGES", "IMAGES",
  "DRAFT_ASSEMBLY", "ASSEMBLY",
  "PUBLISH_KIT",
  "DRAFT_CANON", "CANON",
  "COMPLETE",
] as const;

export type Stage = (typeof STAGES)[number];

export function stageIndex(s: Stage): number {
  return STAGES.indexOf(s);
}

export function compareStages(a: Stage, b: Stage): number {
  return stageIndex(a) - stageIndex(b);
}

export interface StageMap {
  /** gate step id → the DRAFT_ stage that gate opens */
  gates: Record<string, Stage>;
  /** step id → the approved stage reached when that step completes */
  approved: Record<string, Stage>;
  /** the stage reached when the run finishes successfully */
  final: Stage;
}

export interface Needs {
  ideaMissing: boolean;
  refsMissing: boolean;
  imagesMissing: boolean;
}

const NEEDS_RULES: { flag: keyof Needs; stage: Stage; passedAt: Stage }[] = [
  { flag: "ideaMissing", stage: "NEEDS_IDEA", passedAt: "OUTLINE" },
  { flag: "refsMissing", stage: "NEEDS_REFS", passedAt: "CASTING" },
  { flag: "imagesMissing", stage: "NEEDS_IMAGES", passedAt: "IMAGES" },
];

export function deriveStage(state: RunState, map: StageMap, needs: Needs): Stage {
  if (state.finished && state.status === "completed") return map.final;

  let highest: Stage = "IDEA";
  for (const [stepId, status] of Object.entries(state.steps)) {
    const stage = map.approved[stepId];
    if (stage && status === "completed" && compareStages(stage, highest) > 0) highest = stage;
  }

  // A NEEDS_ stage interrupts only until the first approved stage strictly after it is reached.
  for (const rule of NEEDS_RULES) {
    if (needs[rule.flag] && compareStages(highest, rule.passedAt) < 0) return rule.stage;
  }

  if (state.openGate) {
    const draft = map.gates[state.openGate.stepId];
    if (draft) return draft;
  }
  return highest;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/stages.test.ts && npm run typecheck`
Expected: PASS, 6 tests; `typecheck` exits 0.

- [ ] **Step 5: Export the public surface and commit**

Replace `engine/src/index.ts` with:
```ts
export const ENGINE_VERSION = "0.0.1";
export * from "./ids.js";
export * from "./steps.js";
export * from "./pipeline.js";
export * from "./events.js";
export * from "./hash.js";
export * from "./state.js";
export * from "./runner.js";
export * from "./script-step.js";
export * from "./stages.js";
```

Run: `npx vitest run && npm run typecheck`
Expected: all tests pass; `typecheck` exits 0.

```bash
cd ~/GitHub/Showrunner && git add engine/src/stages.ts engine/src/index.ts engine/test/stages.test.ts
git commit -m "engine: milestone vocabulary and stage derivation with NEEDS_ interruption" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
git push
```

---

### Task 12: End-to-end — a fake pipeline through gate, script, and loop, with restart

**Files:**
- Test: `engine/test/e2e.test.ts`

**Interfaces:**
- Consumes everything above. Produces no new code; this task proves the pieces compose and that a restart mid-run resumes from the log alone.

- [ ] **Step 1: Write the test**

`engine/test/e2e.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, answerGate, EventLog, deriveRunState, deriveStage, scriptExecutor } from "../src/index.js";
import type { Executors, Pipeline, StageMap } from "../src/index.js";

describe("end to end", () => {
  it("premise → guard → loop → gate → script → done, surviving a restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "premise.md"), "An ordinary week.");
    let scenes = 0;
    const executors: Executors = {
      script: scriptExecutor,
      agent: async (step, ctx) => {
        if (step.id === "draft") {
          scenes++;
          await writeFile(path.join(ctx.showRoot, "script.md"), `## SCENE ${scenes}\n`.repeat(scenes));
          return { ok: true, text: scenes >= 2 ? "DRAFT_COMPLETE" : "wrote a scene", toolCalls: 3 };
        }
        return { ok: true, text: "fixed", toolCalls: 1 };
      },
    };
    const pipeline: Pipeline = {
      name: "write",
      steps: [
        { kind: "guard", id: "setup", inputs: ["premise.md"], check: async (ctx) => (await readFile(path.join(ctx.showRoot, "premise.md"), "utf8")).length > 0 ? { pass: true } : { pass: false, message: "no premise" } },
        { kind: "loop", id: "draft-loop", dependsOn: ["setup"], until: "DRAFT_COMPLETE", maxIterations: 5,
          body: { kind: "agent", id: "draft", promptFile: "draft.md", model: "writer", allowedTools: ["Read", "Write"], context: "fresh" } },
        { kind: "gate", id: "script-gate", dependsOn: ["draft-loop"], message: () => "Read the script", maxAttempts: 3 },
        { kind: "script", id: "stamp", dependsOn: ["script-gate"], inputs: ["script.md"], outputs: ["stamp.txt"],
          argv: (ctx) => ["python3", "-c", "import sys; open(sys.argv[1],'w').write('ok'); print('::progress {\"done\":1,\"total\":1,\"unit\":\"stamps\"}')", path.join(ctx.showRoot, "stamp.txt")] },
      ],
    };
    const map: StageMap = { gates: { "script-gate": "DRAFT_SCRIPT" }, approved: { "script-gate": "SCRIPT" }, final: "COMPLETE" };
    const needs = { ideaMissing: false, refsMissing: false, imagesMissing: false };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const logPath = EventLog.logPath(root, "s02e01", "r1");

    const r1 = await run({ pipeline, ctx, log: new EventLog(logPath), executors });
    expect(r1).toMatchObject({ status: "waiting", gate: { stepId: "script-gate" } });
    expect(scenes).toBe(2);
    let state = deriveRunState(await new EventLog(logPath).read());
    expect(deriveStage(state, map, needs)).toBe("DRAFT_SCRIPT");
    expect(state.steps).toMatchObject({ setup: "completed", "draft-loop": "completed", "script-gate": "waiting" });

    // Restart: a brand-new process would do exactly this — a new EventLog over the same file.
    await answerGate(new EventLog(logPath), "r1", "script-gate", { approved: true, by: "showrunner" });
    const r2 = await run({ pipeline, ctx, log: new EventLog(logPath), executors });
    expect(r2).toEqual({ status: "completed" });
    expect(await readFile(path.join(root, "stamp.txt"), "utf8")).toBe("ok");
    state = deriveRunState(await new EventLog(logPath).read());
    expect(deriveStage(state, map, needs)).toBe("COMPLETE");

    const kinds = (await new EventLog(logPath).read()).map((e) => e.kind);
    expect(kinds.filter((k) => k === "loop_iteration")).toHaveLength(2);
    expect(kinds).toContain("step_progress");
    expect(kinds.at(-1)).toBe("run_finished");
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/e2e.test.ts`
Expected: PASS. If it fails, the failure is in composition, not in a unit — read the event log the test wrote (its path is printed by adding `console.log(logPath)` temporarily) to see which transition is missing.

- [ ] **Step 3: Run everything and commit**

Run: `cd ~/GitHub/Showrunner && npm test && npm run typecheck`
Expected: all pass.

```bash
cd ~/GitHub/Showrunner && git add engine/test/e2e.test.ts
git commit -m "engine: end-to-end — guard, loop, gate, script, restart from the log" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9'
git push
```

---

## What this plan deliberately leaves to the next plans

- **The real agent executor** (Plan B). Every agent step here runs through a fake `Executors.agent`. Plan B implements it on the Claude Agent SDK after a verification spike against the SDK's documentation (spec §4.7), emitting `agent_query`, `agent_tool_call`, and `agent_result` events, counting tool calls per query, and validating verdicts against `AgentStep.schema`.
- **Show config and the `prompts/` directory** (Plan C). `AgentStep.promptFile` is a relative path; nothing here reads it. Plan C defines the show config file, extracts every prompt from the five YAML files, relocates the Python scripts into this repository as `scripts/`, adds the `::progress` line to each, and pulls show-specific constants out.
- **The Dead Light pipeline and the `Needs` probes** (Plan D). `deriveStage` takes `Needs` as an argument; Plan D supplies the probes that compute `refsMissing` from the shot list against the reference sheets and `imagesMissing` from `showrunner`-sourced shots lacking a PNG (spec §3.3–3.4), and defines the typed steps for write → assets → assemble → canon.
- **The console** (Plan E) reads the same log files this plan writes.
- **Cutover** (Plan F) renames Season 1 and deletes `console/`, `.archon/`, and `remotion/` from the show repository.
