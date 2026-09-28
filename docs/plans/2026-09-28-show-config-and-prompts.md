# Show Config and Prompt Extraction Implementation Plan (Plan C of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything that makes the pipeline *Dead Light* out of the engine's way and into show data — every agent prompt as a file under the show's `prompts/`, every show-specific constant into a show config file or per-episode data — and move the deterministic Python scripts and the Remotion project into the engine repository, so that "a script in the engine repository may not contain the name of a show" holds and a second show is a second show repository.

**Architecture:** Two repositories change. The engine repository (`~/GitHub/Showrunner`) gains `engine/src/show-config.ts` (the loader for the show's `showrunner.json`), two template variables (`{{season}}`, `{{show.<key>}}`), a script result (the last stdout line), a `tools/` workspace with the deterministic prompt extractor and a prompt checker, `scripts/` (the Python steps, argv-only, reading `showrunner.json` through one shared helper, printing `::progress` lines), and `render/` (the Remotion project with the title card read from the timeline). The show repository (`~/GitHub/DeadLight`) gains `showrunner.json`, `prompts/` (thirty prompts, nine rejection prompts, nine gate messages, eight schemas, one index), ten `Episodes/<id>/publish.json` files, and `Canon/visual-audit-laws.md`. Nothing in the show repository is deleted; `.archon/` stays until Plan F's cutover.

**Tech Stack:** TypeScript 5 (strict, ESM, `NodeNext`), vitest 2, Node ≥ 22 for the engine and tools (`tools/` adds the `yaml` package as its one dependency); Python 3 with `uv` and pytest for `scripts/`; Remotion as already vendored in `remotion/`.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` §6.1 (prompts live in files under `prompts/` in the show repository), §6.7 (the progress contract), §7.3 (two repositories; the show config names the prompts directory, the output destinations including the NAS path, and the id scheme; its exact contents are decided here), §7.4 (what moves in which direction; the LOGLINE dictionary becomes per-episode publish data; title-card and room-tone conventions become show config; **a script in the engine repository may not contain the name of a show**). **The inventory this plan is written from:** `docs/plans/2026-09-28-plan-c-inventory.md` — every prompt (§1), variable (§2), script (§4), Remotion constant (§5), console constant (§6), proposed config key (§7), test feasibility (§8) and finding (§9), each with `file:line`. Implementers read the inventory sections their task names; the plan gives the exact values that must be typed and the rulings on the inventory's seventeen findings.

**This is plan C of six.** A (engine core) and B (agent runner) are merged to `main`. D (the Dead Light pipeline), E (console), and F (cutover) follow.

## Rulings on the inventory's findings (made 2026-09-28; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| F-01 `$ARGUMENTS` (the premise) | The premise is a file the showrunner writes: `Episodes/<id>/premise.md`. No variable carries it; the outline prompt tells the agent to read that file. Plan D's `NEEDS_IDEA` rule derives from the file's existence. |
| F-02 five prompts read a script's stdout | `ScriptOutcome` gains `result?: string`: the script's last non-empty, non-progress stdout line, stored as the step's result and emitted on `step_completed`. The four in-scope scripts print a one-line summary last (`validate-manifest.py`, `audio-mix.py`, `nano-banana-generate.py`, `master-video.py`). The `season-status.py` board belongs to Stage 0, which spec §0 defers. |
| F-03 three bash decisions read by prompts | They become `GuardStep`s whose `check` always returns a message (`"yes"` or `"no"`) — Plan D writes them. The canon `diff` becomes a script step (`canon-diff.py`) that writes `Production/<id>/canon-diff.patch` and prints a one-line summary as its result; the prompt tells the agent to read the patch file. |
| F-04 `$desk-gate.output` | Stage 0; deferred with the desk. Recorded for the desk's plan. |
| F-05 `verdict` not `required` | `verdict` is added to `required` on all eight reviewer schemas at extraction. |
| F-06 `$setup.output.` followed by a sentence period | The extractor's rule: `.output.` followed by whitespace or end of line is a sentence period, not a field access. Deterministic; no site list. Every extracted prompt is still diffed against its source in review. |
| F-07 `Canon/season-1.md` literal in twelve places | The renderer gains `{{season}}` (the numeric season, unpadded, from an aired id, or from `airMap` for a production id); prompts write `Canon/season-{{season}}.md`. The Stage 0 prompts are extracted with the rewrite but are not wired until the desk returns. |
| F-08 argv precedence | Every script is argv-only. The `ARGUMENTS` environment variable is gone. The four operator tools convert too, for one convention. |
| F-09 `master-video.py` not idempotent | It writes `episode-mastered.mp4` beside its input and never moves over it; `finalize-video.py` prefers the mastered file. |
| F-10 two RULED regexes | The lenient grammar (`**RULED` followed by anything up to `**`) is the one; `finalize-video.py` adopts it. The grammar is not config: Plan F retires the season-table parse when ids become `sXXeYY`. |
| F-11 QC scripts spawn synthesis as a blind grandchild | The child keeps the parent's stdout (no `DEVNULL`) and the parent's process group (no new session), so its `::progress` lines reach the log and the engine's group kill covers it. The pipeline-loop redesign is Plan D's option, not this plan's. |
| F-12 the title card is typography | The card's text, font and colours travel in `timeline.json` under `title`, written by `build-timeline.py` from show config; `Episode.tsx` renders from the timeline and carries no show literal. |
| F-13 the NAS path in four places | Show config carries `output.nasMount` and `output.nasRoot`; `finalize-video.py` and `season-status.py` read them; Plan D's assemble `setup` guard reads them; the console's copy is Plan F's to delete. |
| F-14 / F-15 the air map and duplicated constants | `airMap` is one show-config key read by every script that needs it, until Plan F's rename makes the id the slot. `video.fps`, `video.crossfadeSeconds`, `audio.loudness` are show config (a show may choose 24 fps). The milestone list and the id regex are engine constants and stay out of config. |
| F-16 Python embedded in a prompt | `populator-check.py` is a new script wrapping `find_collective_populators`; the `visual-direction` prompt loses the embedded program; Plan D adds the script step between `visual-direction` and the image branch. |
| F-17 `[YOUR NAME]` | Carried into `publish.channelName` as the placeholder; Ryan is asked for the credit name and sets the key when he answers. |

## Global Constraints

- **Two repositories, two branches.** Engine work is on branch `plan-c` in `~/GitHub/Showrunner` (remote `MrMophandle/Showrunner`). Show-data work is on branch `plan-c-show-data` in `~/GitHub/DeadLight`, cut from `console-operating-layer` (the show's working branch; its `main` is stale). Neither branch is merged or pushed to `main` by this plan.
- **"A script in the engine repository may not contain the name of a show"** (spec §7.4). After this plan, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren' engine/ scripts/ render/ tools/ --exclude-dir=show-data --exclude-dir=node_modules --exclude-dir=dist` prints nothing (whole-word matching, so `removed` and `disable` do not count; `tools/show-data/` is the one excluded directory, as Task 3 explains). The show's name stays in prompts, which are show data.
- **"argv arrays, never shell strings"** (spec §4.4). Every `subprocess` call in `scripts/` is an argv list; every script takes argv, never an `ARGUMENTS` environment variable.
- **Scripts run with the show root as the working directory** (the engine sets `cwd: ctx.showRoot`) and read `./showrunner.json`; `--show-root <path>` overrides for operator use. Paths inside `showrunner.json` are relative to the show root unless they begin with `/`.
- **The progress contract** (spec §6.7): a script prints `::progress {"done":N,"total":M,"unit":"..."}` once per unit of work in its main loop; everything else it prints is forwarded as `script_line`; its last non-progress stdout line is its result.
- **Nothing in the show repository is deleted.** `.archon/workflows/`, `.archon/scripts/`, `remotion/`, and `console/` stay until Plan F.
- **Every extracted prompt is reviewed against its source.** The task reviewer for Task 3 diffs each `prompts/*.md` against the YAML block it came from, allowing only the variable rewrites this plan names.
- **Every commit ends with these two trailer lines, in ONE final paragraph** (use `git commit -F -` with a heredoc), in both repositories:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9`
- Engine tests: `cd ~/GitHub/Showrunner/engine && npx vitest run` and `npm run typecheck`. Tools tests: `cd ~/GitHub/Showrunner/tools && npx vitest run` and `npm run typecheck`. Script tests: `cd ~/GitHub/Showrunner/scripts && uv run pytest`. All three must be clean before every commit that touches them. The engine suite at the start of this plan is 139 passed and 2 skipped across 19 files.
- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` are on in `engine/` and `tools/`; no `any`; `.js` on intra-package imports.

---

## File Structure

```
~/GitHub/Showrunner/
  package.json                     workspaces gain "tools"; scripts test/typecheck run both
  engine/src/
    show-config.ts                 NEW: ShowConfig, loadShowConfig(showRoot), ShowConfigError, seasonOf(episodeId, airMap)
    prompt-template.ts             MODIFY: renderPrompt(template, ctx, extra?) — {{season}}, {{show.<path>}}
    agent-step.ts                  MODIFY: AgentExecutorOptions.show?; promptsDir/models default from it; passes season+show to the renderer
    steps.ts                       MODIFY: ScriptOutcome gains result?: string
    script-step.ts                 MODIFY: records the last non-progress stdout line; settles { ok: true, result }
    runner.ts                      MODIFY: runScriptStep stores and emits the result (nine lines)
    index.ts                       MODIFY: export show-config.js
  engine/test/
    show-config.test.ts            NEW
    prompt-template.test.ts        MODIFY: {{season}}, {{show.*}}
    agent-step.test.ts             MODIFY: show option wiring
    script-step.test.ts            MODIFY: result line
    runner.test.ts                 MODIFY: script result reaches ctx.results and step_completed
    fixtures/prints-result.py      NEW
  tools/
    package.json                   NEW: "@showrunner/tools", deps: yaml; bin: extract-prompts, check-prompts
    tsconfig.json, tsconfig.test.json, vitest.config.ts
    src/extract-prompts.ts         NEW: the extractor (library + CLI)
    src/check-prompts.ts           NEW: renders every prompt against a sample context
    src/rewrite.ts                 NEW: the variable rewrite rules (pure)
    test/rewrite.test.ts, test/extract-prompts.test.ts, test/check-prompts.test.ts
    test/fixtures/workflows/*.yaml (invented show), test/fixtures/overrides.json
  scripts/
    pyproject.toml                 NEW: the union of the scripts' inline dependencies + pytest
    lib/showconfig.py              NEW: load(), require(), format_filename(), season_of()
    *.py                           MOVED from DeadLight/.archon/scripts (21 files), then modified
    populator-check.py, canon-diff.py   NEW
    tests/                         NEW: pytest, hermetic
  render/                          MOVED from DeadLight/remotion; Episode.tsx reads the title card from timeline.json
  README.md                        MODIFY: show config, scripts contract, tools
  docs/plans/2026-09-28-show-config-and-prompts-deferred.md   NEW (Task 7)

~/GitHub/DeadLight/ (branch plan-c-show-data)
  showrunner.json                  NEW
  prompts/                         NEW: <node>.md ×30, <gate>.reject.md ×9, <gate>.gate.md ×9, <node>.schema.json ×8, index.json
  Episodes/ep01..ep10/publish.json NEW ×10
  Canon/visual-audit-laws.md       NEW (moved verbatim from nano-banana-generate.py:295–313)
  README.md                        MODIFY: what showrunner.json and prompts/ are
```

---

### Task 1: Show config, two template variables, and the script result (engine)

**Files:**
- Create: `engine/src/show-config.ts`, `engine/test/show-config.test.ts`, `engine/test/fixtures/prints-result.py`
- Modify: `engine/src/prompt-template.ts`, `engine/src/agent-step.ts`, `engine/src/steps.ts`, `engine/src/script-step.ts`, `engine/src/runner.ts`, `engine/src/index.ts`
- Test: `engine/test/prompt-template.test.ts`, `engine/test/agent-step.test.ts`, `engine/test/script-step.test.ts`, `engine/test/runner.test.ts`

**Interfaces:**
- Consumes: `parseEpisodeId` (`ids.ts`), `renderPrompt`, `createAgentExecutor`, `ScriptOutcome`, `runScriptStep`.
- Produces:

```ts
// show-config.ts
export class ShowConfigError extends Error { override readonly name = "ShowConfigError"; }
export interface ShowConfig {
  showName: string;
  showSlug: string;
  promptsDir: string;                       // relative to the show root unless absolute
  canonDir?: string; episodesDir?: string; productionDir?: string;
  models: { medium: string; large: string; writer: string; small?: string };
  airMap: Record<string, [number, number]>; // production id → [season, episode]
  output: { nasMount?: string; nasRoot: string; finalFilename?: string; mixFilename?: string; videoFilename?: string };
  audio?: Record<string, unknown>; visual?: Record<string, unknown>; video?: Record<string, unknown>; publish?: Record<string, unknown>;
}
export const SHOW_CONFIG_FILE = "showrunner.json";
export async function loadShowConfig(showRoot: string): Promise<ShowConfig>;   // throws ShowConfigError naming the first missing/mistyped required key
export function seasonOf(episodeId: string, airMap: Record<string, [number, number]>): number; // aired → season; production → airMap[raw][0]; else throws ShowConfigError
export function resolveShowPath(showRoot: string, p: string): string;           // absolute p as-is, else path.join(showRoot, p)

// prompt-template.ts
export interface RenderExtra { season?: number; show?: Record<string, unknown> }
export function renderPrompt(template: string, ctx: TemplateContext, extra?: RenderExtra): string;
//   {{season}} → String(extra.season)  (TemplateError "season is not available" when absent)
//   {{show.<path>}} → dotted path into extra.show, same value rules as results (string as-is; number/boolean String(); object/array JSON; null/undefined/missing → TemplateError)

// agent-step.ts
export interface AgentExecutorOptions { query: QueryFn; promptsDir?: string; models?: Record<string, string>; show?: ShowConfig }
//   promptsDir default: show ? resolveShowPath(ctx.showRoot, show.promptsDir) : <showRoot>/prompts
//   models default: show?.models (as Record<string,string>)
//   render extra: { season: seasonOf(ctx.episodeId, show.airMap) when show is given and the id resolves; show }
//   agent_query payload gains showConfig: Boolean(show)

// steps.ts
export type ScriptOutcome = { ok: true; result?: string } | { ok: false; error: string };
```

- [ ] **Step 1: Write the failing tests**

`engine/test/show-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadShowConfig, seasonOf, resolveShowPath, ShowConfigError, SHOW_CONFIG_FILE } from "../src/show-config.js";

const good = {
  showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts",
  models: { medium: "m-mid", large: "m-large", writer: "m-writer" },
  airMap: { ep01: [1, 1], ep02: [1, 2] },
  output: { nasRoot: "/Volumes/media/HarborLights" },
};
async function root(cfg: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "show-"));
  await writeFile(path.join(dir, SHOW_CONFIG_FILE), JSON.stringify(cfg));
  return dir;
}

describe("loadShowConfig", () => {
  it("loads a minimal valid config", async () => {
    const cfg = await loadShowConfig(await root(good));
    expect(cfg.showName).toBe("Harbor Lights");
    expect(cfg.models.writer).toBe("m-writer");
    expect(cfg.airMap["ep02"]).toEqual([1, 2]);
  });
  it("names the missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "show-"));
    await expect(loadShowConfig(dir)).rejects.toThrow(/showrunner\.json/);
  });
  it("names the first missing required key", async () => {
    const { models, ...rest } = good; void models;
    await expect(loadShowConfig(await root(rest))).rejects.toThrow(ShowConfigError);
    await expect(loadShowConfig(await root(rest))).rejects.toThrow(/models/);
    await expect(loadShowConfig(await root({ ...good, models: { medium: "m" } }))).rejects.toThrow(/models\.large/);
  });
  it("rejects a malformed airMap entry", async () => {
    await expect(loadShowConfig(await root({ ...good, airMap: { ep01: [1] } }))).rejects.toThrow(/airMap\.ep01/);
  });
  it("rejects invalid JSON with the file named", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(dir, SHOW_CONFIG_FILE), "{ not json");
    await expect(loadShowConfig(dir)).rejects.toThrow(/showrunner\.json/);
  });
});

describe("seasonOf", () => {
  it("reads the season off an aired id", () => { expect(seasonOf("s02e01", {})).toBe(2); });
  it("looks a production id up in the air map", () => { expect(seasonOf("ep02", good.airMap)).toBe(1); });
  it("fails for an unmapped production id", () => { expect(() => seasonOf("ep99", good.airMap)).toThrow(ShowConfigError); });
});

describe("resolveShowPath", () => {
  it("joins relative paths and keeps absolute ones", () => {
    expect(resolveShowPath("/show", "prompts")).toBe(path.join("/show", "prompts"));
    expect(resolveShowPath("/show", "/elsewhere/prompts")).toBe("/elsewhere/prompts");
  });
});
```

Add to `engine/test/prompt-template.test.ts`:

```ts
describe("renderPrompt: season and show", () => {
  const show = { showName: "Harbor Lights", video: { fps: 24, titleCard: { text: "HARBOR LIGHTS" } }, audio: { mainCast: ["a", "b"] } };
  it("renders {{season}} and {{show.<path>}}", () => {
    expect(renderPrompt("S{{season}} of {{show.showName}} at {{ show.video.fps }} fps: {{show.video.titleCard.text}}", ctx, { season: 2, show })).toBe("S2 of Harbor Lights at 24 fps: HARBOR LIGHTS");
    expect(renderPrompt("{{show.audio.mainCast}}", ctx, { show })).toBe(JSON.stringify(["a", "b"], null, 2));
  });
  it("throws when season or show is not available, naming the variable", () => {
    expect(() => renderPrompt("{{season}}", ctx)).toThrow(/\{\{season\}\}/);
    expect(() => renderPrompt("{{show.showName}}", ctx)).toThrow(/\{\{show\.showName\}\}/);
    expect(() => renderPrompt("{{show.nope}}", ctx, { show })).toThrow(/nope/);
    expect(() => renderPrompt("{{show}}", ctx, { show })).toThrow(TemplateError);
  });
});
```

Add to `engine/test/agent-step.test.ts` (options describe):

```ts
  it("takes promptsDir and models from the show config, and renders {{season}} and {{show.*}}", async () => {
    const f = fake([init, success()]);
    const showRoot = await mkdtemp(path.join(tmpdir(), "show-"));
    await mkdir(path.join(showRoot, "p"));
    await writeFile(path.join(showRoot, "p", "s.md"), "Season {{season}} of {{show.showName}} for {{episodeId}}");
    const show = { showName: "Harbor Lights", showSlug: "HL", promptsDir: "p", models: { medium: "cfg-mid", large: "l", writer: "w" }, airMap: { ep07: [1, 7] as [number, number] }, output: { nasRoot: "/n" } };
    const ex = createAgentExecutor({ query: f.query, show });
    const rec = recorder();
    await ex(step({ promptFile: "s.md" }), { ...ctx(), showRoot, episodeId: "ep07" }, rec.emit);
    expect(f.calls[0]!.prompt).toBe("Season 1 of Harbor Lights for ep07");
    expect(f.calls[0]!.options.model).toBe("cfg-mid");
    expect(rec.events[0]!.payload["showConfig"]).toBe(true);
  });
  it("explicit promptsDir and models override the show config", async () => {
    const f = fake([init, success()]);
    const show = { showName: "H", showSlug: "H", promptsDir: "/nowhere", models: { medium: "cfg-mid", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/n" } };
    await createAgentExecutor({ query: f.query, show, promptsDir, models: { medium: "explicit" } })(step(), ctx(), recorder().emit);
    expect(f.calls[0]!.options.model).toBe("explicit");
  });
  it("a production id absent from the air map only fails when the prompt uses {{season}}", async () => {
    const f = fake([init, success()]);
    const show = { showName: "H", showSlug: "H", promptsDir, models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/n" } };
    const r = await createAgentExecutor({ query: f.query, show })(step({ promptFile: "plain.md" }), { ...ctx(), episodeId: "ep99" }, recorder().emit);
    expect(r.ok).toBe(true);
  });
```

`engine/test/fixtures/prints-result.py`:

```python
import sys
print("::progress {\"done\":1,\"total\":2,\"unit\":\"things\"}")
print("working on it")
print("::progress {\"done\":2,\"total\":2,\"unit\":\"things\"}")
print("MIX_OK 12.3s -14.0 LUFS", flush=True)
sys.exit(0)
```

Add to `engine/test/script-step.test.ts`:

```ts
  it("returns the last non-progress stdout line as the result", async () => {
    const r = await scriptExecutor(step(["python3", fixture("prints-result.py")]), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, result: "MIX_OK 12.3s -14.0 LUFS" });
  });
  it("returns no result key when the script printed only progress lines", async () => {
    // fixtures/progress.py prints "starting" first, so it has a result; this case uses an inline program.
    const r = await scriptExecutor(step(["python3", "-c", "print('::progress {\"done\":1,\"total\":1,\"unit\":\"x\"}')"]), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true });
  });
  it("reads the result after the pipes drain, so a burst before the summary cannot lose it", async () => {
    // 20,000 unflushed lines, then the summary, then an immediate exit. Node emits 'exit' when the process
    // ends, not when its stdio has been read; the outcome is therefore built after the drain.
    const r = await scriptExecutor(step(["python3", "-c", "import sys,os\nfor i in range(20000): sys.stdout.write(f'line {i}\\n')\nsys.stdout.flush(); print('SUMMARY_OK', flush=True); os._exit(0)"]), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, result: "SUMMARY_OK" });
  });
```

(Use the file's existing helpers for `step`, `ctx`, `fixture`, `recorder`; match their names. Three existing assertions in this file gain a `result` value — `"starting"`, `"299"`, `"one line"` — because those scripts print lines; the drain-grace `escapee.py` case's result becomes the escaped grandchild's last line (`/^late \d+$/`), which is the documented consequence of reading the result after the drain.)

Add to `engine/test/runner.test.ts`:

```ts
  it("a script step's result reaches ctx.results and step_completed", async () => {
    const executors = { script: async () => ({ ok: true as const, result: "MASTER_OK" }), agent: async () => { throw new Error("unused"); } };
    let seen: unknown;
    const a: ScriptStep = { kind: "script", id: "master", argv: () => ["x"] };
    const g: GuardStep = { kind: "guard", id: "after", dependsOn: ["master"], check: (c) => { seen = c.results["master"]; return { pass: true }; } };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const r = await run({ pipeline: { name: "p", steps: [a, g] }, executors, log, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root } });
    expect(r).toEqual({ status: "completed" });
    expect(seen).toBe("MASTER_OK");
    const done = (await log.read()).find((e) => e.kind === "step_completed" && e.stepId === "master");
    expect(done?.payload["result"]).toBe("MASTER_OK");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/show-config.test.ts test/prompt-template.test.ts test/agent-step.test.ts test/script-step.test.ts test/runner.test.ts`
Expected: `show-config` cannot resolve its module; the new template, executor, script-step and runner cases fail; three existing script-step cases fail because their scripts now have a result (`"starting"`, `"299"`, `"one line"`) — those assertions are updated in Step 5; every other existing case passes.

- [ ] **Step 3: Write `show-config.ts`**

```ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseEpisodeId } from "./ids.js";

export class ShowConfigError extends Error { override readonly name = "ShowConfigError"; }

export const SHOW_CONFIG_FILE = "showrunner.json";

/** The show repository's root config. The engine reads promptsDir, models and airMap; the Python
 *  scripts read the rest through scripts/lib/showconfig.py against the same file. Paths are
 *  relative to the show root unless absolute. */
export interface ShowConfig {
  showName: string;
  showSlug: string;
  promptsDir: string;
  canonDir?: string;
  episodesDir?: string;
  productionDir?: string;
  models: { medium: string; large: string; writer: string; small?: string };
  /** Production id → [season, episode], for ids that aired under a production name. Plan F's
   *  rename to sXXeYY empties it. */
  airMap: Record<string, [number, number]>;
  output: { nasMount?: string; nasRoot: string; finalFilename?: string; mixFilename?: string; videoFilename?: string };
  audio?: Record<string, unknown>;
  visual?: Record<string, unknown>;
  video?: Record<string, unknown>;
  publish?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

function str(obj: Record<string, unknown>, key: string, at: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be a non-empty string`);
  return v;
}
function optStr(obj: Record<string, unknown>, key: string, at: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be a string`);
  return v;
}
function rec(obj: Record<string, unknown>, key: string, at: string): Record<string, unknown> {
  const v = obj[key];
  if (!isRecord(v)) throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be an object`);
  return v;
}
function optRec(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${key} must be an object`);
  return v;
}

export async function loadShowConfig(showRoot: string): Promise<ShowConfig> {
  const file = path.join(showRoot, SHOW_CONFIG_FILE);
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (err) { throw new ShowConfigError(`${SHOW_CONFIG_FILE} could not be read at ${file}: ${(err as Error).message}`, { cause: err }); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new ShowConfigError(`${SHOW_CONFIG_FILE} at ${file} is not valid JSON: ${(err as Error).message}`, { cause: err }); }
  if (!isRecord(parsed)) throw new ShowConfigError(`${SHOW_CONFIG_FILE} must be a JSON object`);

  const models = rec(parsed, "models", "");
  const airRaw = rec(parsed, "airMap", "");
  const airMap: Record<string, [number, number]> = {};
  for (const [id, v] of Object.entries(airRaw)) {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && n > 0)) {
      throw new ShowConfigError(`${SHOW_CONFIG_FILE}: airMap.${id} must be [season, episode] with positive integers`);
    }
    airMap[id] = [v[0] as number, v[1] as number];
  }
  const output = rec(parsed, "output", "");
  const cfg: ShowConfig = {
    showName: str(parsed, "showName", ""),
    showSlug: str(parsed, "showSlug", ""),
    promptsDir: str(parsed, "promptsDir", ""),
    models: {
      medium: str(models, "medium", "models."),
      large: str(models, "large", "models."),
      writer: str(models, "writer", "models."),
      ...(optStr(models, "small", "models.") !== undefined ? { small: optStr(models, "small", "models.") as string } : {}),
    },
    airMap,
    output: {
      nasRoot: str(output, "nasRoot", "output."),
      ...(optStr(output, "nasMount", "output.") !== undefined ? { nasMount: optStr(output, "nasMount", "output.") as string } : {}),
      ...(optStr(output, "finalFilename", "output.") !== undefined ? { finalFilename: optStr(output, "finalFilename", "output.") as string } : {}),
      ...(optStr(output, "mixFilename", "output.") !== undefined ? { mixFilename: optStr(output, "mixFilename", "output.") as string } : {}),
      ...(optStr(output, "videoFilename", "output.") !== undefined ? { videoFilename: optStr(output, "videoFilename", "output.") as string } : {}),
    },
  };
  for (const key of ["canonDir", "episodesDir", "productionDir"] as const) {
    const v = optStr(parsed, key, "");
    if (v !== undefined) cfg[key] = v;
  }
  for (const key of ["audio", "visual", "video", "publish"] as const) {
    const v = optRec(parsed, key);
    if (v !== undefined) cfg[key] = v;
  }
  return cfg;
}

/** The numeric season of an episode: read off an aired id, or looked up in the air map for a
 *  production id. Throws ShowConfigError when neither applies, so a prompt's {{season}} is never
 *  rendered from a guess. */
export function seasonOf(episodeId: string, airMap: Record<string, [number, number]>): number {
  const id = parseEpisodeId(episodeId);
  if (id.kind === "aired") return id.season;
  const mapped = airMap[id.raw];
  if (!mapped) throw new ShowConfigError(`no season for production id ${id.raw}: it is not in airMap`);
  return mapped[0];
}

export function resolveShowPath(showRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(showRoot, p);
}
```

Note the two `as string` narrowings after an `!== undefined` check; if `tsc` accepts a cleaner form (a local `const small = optStr(...)`), prefer it — the shape, not the spelling, is mandated.

- [ ] **Step 4: Extend the renderer**

In `engine/src/prompt-template.ts`: add `export interface RenderExtra { season?: number; show?: Record<string, unknown> }`; change the signature to `renderPrompt(template: string, ctx: TemplateContext, extra: RenderExtra = {}): string`; inside the replacer, before the `results` branch:

```ts
    if (expr === "season") {
      if (extra.season === undefined) return fail("season is not available");
      return String(extra.season);
    }
    if (expr === "show" || expr.startsWith("show.")) {
      if (expr === "show") return fail("show needs a key path");
      if (extra.show === undefined) return fail("show config is not available");
      const segments = expr.slice("show.".length).split(".");
      if (segments.some((s) => s === "")) return fail("malformed path");
      let value: unknown = extra.show;
      for (const seg of segments) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${JSON.stringify(seg)} is not a key of a non-object`);
        if (!Object.prototype.hasOwnProperty.call(value, seg)) return fail(`no key ${JSON.stringify(seg)}`);
        value = (value as Record<string, unknown>)[seg];
      }
      return renderValue(value, fail);
    }
```

and factor the value rendering (string / number / boolean / JSON / null / non-serializable) into one `renderValue(value, fail)` helper used by both the `results` branch and the `show` branch, so the rules cannot drift. Update the doc comment and the README's template table (Task 7 also touches it; do the table row here).

- [ ] **Step 5: Wire the executor, the script result, and the runner**

`engine/src/agent-step.ts`: import `ShowConfig`, `resolveShowPath`, `seasonOf`, `ShowConfigError`; add `show?: ShowConfig` to `AgentExecutorOptions` with the doc comment "the show's config; supplies promptsDir and models when the explicit options are absent, and the {{season}}/{{show.*}} variables"; compute `promptsDir` as `opts.promptsDir ?? (opts.show ? resolveShowPath(ctx.showRoot, opts.show.promptsDir) : path.join(ctx.showRoot, "prompts"))`; `models` as `opts.models ?? opts.show?.models`; `extra` as `{ ...(season !== undefined ? { season } : {}), ...(opts.show ? { show: opts.show as unknown as Record<string, unknown> } : {}) }` where `season` is `seasonOf(ctx.episodeId, opts.show.airMap)` inside a `try` that leaves it undefined on `ShowConfigError` (a prompt that does not use `{{season}}` must not fail for an unmapped test id); pass `extra` to `renderPrompt`; add `showConfig: Boolean(opts.show)` to the `agent_query` payload.

`engine/src/steps.ts`: `export type ScriptOutcome = { ok: true; result?: string } | { ok: false; error: string };` with the comment "result: the script's last non-empty stdout line that was not a progress line — the one-line summary a later step may read as `{{results.<id>}}`".

`engine/src/script-step.ts`: keep `let lastStdout = ""`; in the stdout line handler, for a line that is not a progress line and is not blank, set `lastStdout = line`. **The outcome is built after the drain**, not in the `exit` handler: `settle` takes an `Ending` (`{ kind: "exit"; code; signal }` or `{ kind: "spawnFailed"; message }`) and an `outcomeOf(ending)` runs once the readline closes or the grace has completed, so both `lastStdout` and `lastStderr` reflect every line that arrived. Exit 0 → `{ ok: true, ...(lastStdout !== "" ? { result: lastStdout } : {}) }`; every failure message string stays byte-identical to Plan A's. (Node emits `exit` when the process ends, not when its stdio has been read — the pre-existing `lastStderr` snapshot had the same hazard; a probe on this machine lost the race 31 times in 40 with stdout piped alone, and 0 in 40 in the executor's detached shape, so the test is a guard on the invariant, not a reproduction.)

`engine/src/runner.ts`, in `runScriptStep`: after the executor returns ok, `await emit("step_completed", { inputHashes, outputHashes, ...(r.result !== undefined ? { result: r.result } : {}) }); return { kind: "completed", ...(r.result !== undefined ? { result: r.result } : {}) };`. The cache path already carries `prior.result`; confirm `lastCompletion` reads `result` off `step_completed` (it does for guards) so a cached script serves its result too. `runner.ts` is otherwise untouched.

`engine/src/index.ts`: add `export * from "./show-config.js";`.

- [ ] **Step 6: Run everything**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: the suite grows by 9 (show-config) + 2 (template) + 3 (executor) + 3 (script-step) + 1 (runner) = 18 → `157 passed | 2 skipped` across 20 files; typecheck silent.

- [ ] **Step 7: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine README.md && git commit -F - <<'MSG'
engine: show config loader, {{season}} and {{show.*}}, and a script's result line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 2: The prompt extractor and the prompt checker (tools)

**Files:**
- Create: `tools/package.json`, `tools/tsconfig.json`, `tools/tsconfig.test.json`, `tools/vitest.config.ts`, `tools/src/rewrite.ts`, `tools/src/extract-prompts.ts`, `tools/src/check-prompts.ts`
- Create: `tools/test/rewrite.test.ts`, `tools/test/extract-prompts.test.ts`, `tools/test/check-prompts.test.ts`, `tools/test/fixtures/workflows/harbor-write.yaml`, `tools/test/fixtures/overrides.json`
- Modify: `package.json` (root): `"workspaces": ["engine", "tools"]`, `"test": "npm test -w engine && npm test -w tools"`, `"typecheck": "npm run typecheck -w engine && npm run typecheck -w tools"`

**Interfaces:**
- Consumes: the Archon workflow YAML shape (inventory §1: nodes with `id`, `depends_on`, `model`, `context`/`fresh_context`, `allowed_tools`, `output_format`, `timeout`, `idle_timeout`, `when`, `prompt`, `loop: { prompt, until, max_iterations }`, `approval: { message, on_reject: { prompt, max_attempts } }`); `renderPrompt`, `TemplateError`, `ShowConfig` from `@showrunner/engine` (a workspace dependency; the engine is built with `npm run build -w engine` before tools resolve it, or tools import from `../engine/src/*.ts` through a `paths` mapping — pick the workspace-dependency form and add `"build": "tsc"` to the root scripts so `dist/` exists).
- Produces:

```ts
// rewrite.ts (pure)
export interface RewriteContext { nodeId: string; gateId?: string /* for on_reject prompts */ }
export interface Override { nodeId?: string; pattern: string; replacement: string }   // literal pattern, applied before the rules; nodeId "*" or absent applies to every prompt in every workflow
export function rewriteVariables(text: string, ctx: RewriteContext, overrides: Override[]): { text: string; unmapped: string[] };   // applies the overrides whose nodeId is ctx.nodeId or "*"
//   rules, in order:
//   1. overrides (literal, longest first);
//   2. /\$setup\.output\.(?=\s|$)/g            → "{{episodeId}}."       (F-06: a sentence period)
//   3. /\$setup\.output\b/g                     → "{{episodeId}}"
//   4. /\$EP_ID\b/g and /\$EP\b/g               → "{{episodeId}}"
//   5. /\$REJECTION_REASON\b/g                  → "{{results.<gateId>:rejection}}" (unmapped if ctx.gateId is absent)
//   6. /\$([a-z][a-z0-9-]*)\.output\.([a-zA-Z_][\w]*)\b/g → "{{results.$1.$2}}"
//   7. /\$([a-z][a-z0-9-]*)\.output\b/g         → "{{results.$1}}"
//   8. any remaining /\$[A-Za-z_][\w.-]*/ that is not a POSIX parameter form (`${...}`) is reported in `unmapped` (the text is returned with it untouched)

// extract-prompts.ts
export interface ExtractOptions { workflowsDir: string; outDir: string; overridesFile?: string; schemaRequiredAdd?: Record<string, string[]> /* nodeId → fields */ }
export interface PromptIndexEntry { file: string; kind: "agent" | "loop" | "reject" | "gate"; workflow: string; nodeId: string; gateId?: string; line: [number, number]; model?: string; context?: "fresh" | "shared"; allowedTools?: string[]; timeoutMs?: number; idleTimeoutMs?: number; until?: string; maxIterations?: number; maxAttempts?: number; dependsOn?: string[]; when?: string; schema?: string /* file */ }
export async function extractPrompts(opts: ExtractOptions): Promise<{ index: PromptIndexEntry[]; unmapped: Array<{ file: string; nodeId: string; form: string }> }>;
//   writes <outDir>/<nodeId>.md (agent, loop body), <outDir>/<gateId>.reject.md, <outDir>/<gateId>.gate.md, <outDir>/<nodeId>.schema.json, <outDir>/index.json
//   context: recorded only where the YAML declares it — `context: fresh` or `fresh_context: true` → "fresh", `fresh_context: false` → "shared", nothing declared → absent (Plan D chooses the default; the index does not invent one). timeout (ms) → timeoutMs; idle_timeout → idleTimeoutMs. model: a node with no `model` inherits the workflow's top-level `model`; a leading "@" is stripped ("@writer" → "writer"), so the index names the show config's models keys. index.json carries one row per written file, schemas included (a schema row carries its node's kind), sorted so a node's .md row precedes its schema row. Text is written verbatim after rewriting; trailing whitespace preserved as in the YAML block scalar.
//   exits non-zero (CLI) when unmapped is non-empty, listing every form with its file and node

// check-prompts.ts
export interface CheckOptions { promptsDir: string; context: { episodeId: string; runId: string; showRoot: string; results: Record<string, unknown>; season?: number; show?: Record<string, unknown> } }
export async function checkPrompts(opts: CheckOptions): Promise<Array<{ file: string; error: string }>>;   // every .md rendered; errors collected; CLI exits non-zero if any
```

CLI entry points (`tools/package.json` `bin`): `extract-prompts --workflows <dir> --out <dir> [--overrides <file>] [--schema-required-add <nodeId>=<field>,...]` and `check-prompts --prompts <dir> --context <json-file>`.

- [ ] **Step 1: Write the fixture workflow** (an invented show; no real name)

`tools/test/fixtures/workflows/harbor-write.yaml`:

```yaml
name: harbor-write
nodes:
  - id: setup
    type: bash
    command: echo "$ARGUMENTS" | cut -d' ' -f1
  - id: outline
    depends_on: [setup]
    model: "@writer"
    allowed_tools: [Read, Write, Glob, Grep]
    timeout: 30000
    prompt: |
      You are the architect for *Harbor Lights*. The episode is $setup.output.
      The full request is: $ARGUMENTS
      Read Canon/season-1.md and Episodes/$setup.output/premise.md. Write the outline for $setup.output.
  - id: outline-check
    depends_on: [outline]
    model: medium
    context: fresh
    allowed_tools: [Read, Glob, Grep]
    output_format:
      type: object
      properties:
        pass: { type: boolean }
        verdict: { type: string, enum: [OUTLINE PASSED, OUTLINE FAILED] }
        issues: { type: array, items: { type: string } }
      required: [pass, issues]
    prompt: |
      Audit Episodes/$setup.output/outline.md against the season file.
  - id: outline-gate
    depends_on: [outline-check]
    approval:
      message: |
        Outline ready: Episodes/$setup.output/outline.md
        Canon pre-check: $outline-check.output.verdict
      capture_response: true
      on_reject:
        prompt: |
          Revise the outline for $setup.output per: $REJECTION_REASON
        max_attempts: 3
  - id: draft
    depends_on: [outline-gate]
    model: "@writer"
    idle_timeout: 900000
    loop:
      prompt: |
        Write one scene of $setup.output. Verdict so far: $outline-check.output
      fresh_context: true
      until: DRAFT_COMPLETE
      max_iterations: 15
```

`tools/test/fixtures/overrides.json`:

```json
[
  { "nodeId": "outline", "pattern": "The full request is: $ARGUMENTS", "replacement": "The premise is in Episodes/{{episodeId}}/premise.md; read it first." },
  { "nodeId": "outline", "pattern": "Canon/season-1.md", "replacement": "Canon/season-{{season}}.md" }
]
```

(Overrides are per node: `{ nodeId, pattern, replacement }`; the extractor passes a node's overrides to `rewriteVariables`.)

- [ ] **Step 2: Write the failing tests**

`tools/test/rewrite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rewriteVariables } from "../src/rewrite.js";

describe("rewriteVariables", () => {
  it("rewrites the episode id forms, including the sentence-period case", () => {
    const r = rewriteVariables("Episode $setup.output. Then $setup.output/x and $EP_ID and $EP.", { nodeId: "n" }, []);
    expect(r.text).toBe("Episode {{episodeId}}. Then {{episodeId}}/x and {{episodeId}} and {{episodeId}}.");
    expect(r.unmapped).toEqual([]);
  });
  it("rewrites step results and fields", () => {
    expect(rewriteVariables("$tone-check.output and $outline-canon-check.output.verdict", { nodeId: "n" }, []).text)
      .toBe("{{results.tone-check}} and {{results.outline-canon-check.verdict}}");
  });
  it("rewrites the rejection reason with the enclosing gate id", () => {
    expect(rewriteVariables("per: $REJECTION_REASON", { nodeId: "fix", gateId: "outline-gate" }, []).text).toBe("per: {{results.outline-gate:rejection}}");
    expect(rewriteVariables("per: $REJECTION_REASON", { nodeId: "fix" }, []).unmapped).toEqual(["$REJECTION_REASON"]);
  });
  it("applies overrides first and reports what is left", () => {
    const r = rewriteVariables("The full request is: $ARGUMENTS and $season-status.output", { nodeId: "outline" }, [{ pattern: "The full request is: $ARGUMENTS", replacement: "Read the premise." }]);
    expect(r.text).toBe("Read the premise. and {{results.season-status}}");
    expect(r.unmapped).toEqual([]);
    expect(rewriteVariables("$ARGUMENTS", { nodeId: "n" }, []).unmapped).toEqual(["$ARGUMENTS"]);
  });
  it("a wildcard override applies regardless of node", () => {
    expect(rewriteVariables("see Canon/season-1.md", { nodeId: "any" }, [{ nodeId: "*", pattern: "Canon/season-1.md", replacement: "Canon/season-{{season}}.md" }]).text).toBe("see Canon/season-{{season}}.md");
    expect(rewriteVariables("see Canon/season-1.md", { nodeId: "any" }, [{ nodeId: "other", pattern: "Canon/season-1.md", replacement: "X" }]).text).toBe("see Canon/season-1.md");
  });
  it("leaves POSIX parameter expansions and dollar amounts alone", () => {
    expect(rewriteVariables("${SID#s} costs $5 and ${N}", { nodeId: "n" }, [])).toEqual({ text: "${SID#s} costs $5 and ${N}", unmapped: [] });
  });
});
```

`tools/test/extract-prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractPrompts } from "../src/extract-prompts.js";

const workflowsDir = path.resolve(import.meta.dirname, "fixtures/workflows");
const overridesFile = path.resolve(import.meta.dirname, "fixtures/overrides.json");

describe("extractPrompts", () => {
  it("writes one file per prompt, reject prompt, gate message and schema, and an index", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const r = await extractPrompts({ workflowsDir, outDir, overridesFile, schemaRequiredAdd: { "outline-check": ["verdict"] } });
    expect(r.unmapped).toEqual([]);
    const files = r.index.map((e) => e.file).sort();
    expect(files).toEqual(["draft.md", "outline-check.md", "outline-check.schema.json", "outline-gate.gate.md", "outline-gate.reject.md", "outline.md"].sort());
    const outline = await readFile(path.join(outDir, "outline.md"), "utf8");
    expect(outline).toContain("The episode is {{episodeId}}.");
    expect(outline).toContain("The premise is in Episodes/{{episodeId}}/premise.md");
    expect(outline).toContain("Canon/season-{{season}}.md");
    expect(outline).not.toContain("$");
    const reject = await readFile(path.join(outDir, "outline-gate.reject.md"), "utf8");
    expect(reject).toContain("{{results.outline-gate:rejection}}");
    const gate = await readFile(path.join(outDir, "outline-gate.gate.md"), "utf8");
    expect(gate).toContain("{{results.outline-check.verdict}}");
    const schema = JSON.parse(await readFile(path.join(outDir, "outline-check.schema.json"), "utf8"));
    expect(schema.required).toEqual(["pass", "issues", "verdict"]);
    const index = JSON.parse(await readFile(path.join(outDir, "index.json"), "utf8"));
    const draft = index.find((e: { nodeId: string }) => e.nodeId === "draft");
    expect(draft).toMatchObject({ kind: "loop", model: "writer", context: "fresh", until: "DRAFT_COMPLETE", maxIterations: 15, idleTimeoutMs: 900000, dependsOn: ["outline-gate"] });
    const check = index.find((e: { nodeId: string }) => e.nodeId === "outline-check");
    expect(check).toMatchObject({ kind: "agent", model: "medium", context: "fresh", allowedTools: ["Read", "Glob", "Grep"], schema: "outline-check.schema.json" });
    const rej = index.find((e: { file: string }) => e.file === "outline-gate.reject.md");
    expect(rej).toMatchObject({ kind: "reject", gateId: "outline-gate", maxAttempts: 3 });
  });
  it("reports unmapped forms with their node when no override covers them", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const r = await extractPrompts({ workflowsDir, outDir });
    expect(r.unmapped).toEqual([{ file: "harbor-write.yaml", nodeId: "outline", form: "$ARGUMENTS" }]);
  });
});
```

`tools/test/check-prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkPrompts } from "../src/check-prompts.js";

describe("checkPrompts", () => {
  it("renders every prompt and reports the ones with holes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "good.md"), "{{episodeId}} {{results.x}} {{season}} {{show.showName}}");
    await writeFile(path.join(dir, "bad.md"), "{{results.missing}}");
    await writeFile(path.join(dir, "gate.gate.md"), "ok {{episodeId}}");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: { x: "1" }, season: 2, show: { showName: "H" } } });
    expect(errors).toEqual([{ file: "bad.md", error: expect.stringContaining("{{results.missing}}") }]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/tools && npm install && npx vitest run`
Expected: three files fail to resolve their modules.

- [ ] **Step 4: Write the tools workspace**

`tools/package.json`:

```json
{
  "name": "@showrunner/tools",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "extract-prompts": "./dist/extract-prompts.js", "check-prompts": "./dist/check-prompts.js" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit && tsc -p tsconfig.test.json", "build": "tsc" },
  "dependencies": { "@showrunner/engine": "*", "yaml": "^2.6.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```

`tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`: copies of `engine/`'s three files with `rootDir`/`include` adjusted. Root `package.json`: workspaces `["engine", "tools"]`, `test`/`typecheck` run both, `"build": "npm run build -w engine && npm run build -w tools"`. The engine must be built (`dist/`) for tools to resolve `@showrunner/engine` at test time; add `engine/dist` to `.gitignore` if it is not already.

`tools/src/rewrite.ts` — implement the eight rules exactly as the interface lists them, in that order, with overrides applied by longest pattern first using `split/join` (literal, not regex). The unmapped scan is `/\$(?!\{)[A-Za-z_][\w.-]*/g` on the text after the rules, excluding matches that are followed by a digit only (a dollar amount has no letter, so `$5` never matches the class anyway).

`tools/src/extract-prompts.ts` — parse each `*.yaml` in `workflowsDir` with `yaml`'s `parseDocument` so line numbers are available (`node.range` → line via a prefix count); walk `nodes`; for each node with `prompt` (agent), `loop.prompt` (loop body), `approval.on_reject.prompt` (reject, `gateId` = the node id), `approval.message` (gate); rewrite; write files; build the index; write `<outDir>/index.json` sorted by workflow then node. `schemaRequiredAdd` appends fields to a schema's `required` when absent. The CLI (`main()` under `if (import.meta.url === pathToFileURL(process.argv[1]).href)`) prints the index summary and every unmapped form, exiting 1 when any remain.

`tools/src/check-prompts.ts` — read every `*.md` in `promptsDir`; `renderPrompt(text, ctx, { season, show })` from `@showrunner/engine`; collect `{ file, error }` on throw; the CLI reads the context JSON, prints one line per error, exits 1 when any.

- [ ] **Step 5: Run the tools tests and typecheck, then the root scripts**

Run: `cd ~/GetHub/Showrunner && npm run build -w engine && npm test && npm run typecheck`
Expected: engine `159 passed | 2 skipped` (157 + the two Task 1 review items folded into this task: the spawn-failure path pinned, air-map keys validated as production ids); tools 3 files, 9 tests passing; both typechecks silent. (The `GetHub` above is a typo in this plan; the path is `~/GitHub/Showrunner`.)

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add package.json package-lock.json .gitignore tools && git commit -F - <<'MSG'
tools: extract-prompts and check-prompts — deterministic extraction, variable rewrite, and a render check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 3: The show data — `showrunner.json`, `prompts/`, per-episode publish data (show repository)

**Files (in `~/GitHub/DeadLight`, branch `plan-c-show-data` cut from `console-operating-layer`):**
- Create: `showrunner.json`, `prompts/` (written by the extractor, then hand-finished), `Episodes/ep01..ep10/publish.json`, `Canon/visual-audit-laws.md`, `prompts/README.md`
- Create (in `~/GitHub/Showrunner`, branch `plan-c`): `tools/show-data/deadlight-overrides.json`, `tools/show-data/deadlight-check-context.json` — the exact inputs the extraction was run with, so it is reproducible; these two files are the only place in the engine repository allowed to carry the show's name, because they are show data that happens to be versioned beside the tool that consumes it (Global Constraints grep excludes `tools/show-data/`).

**Interfaces:**
- Consumes: `extract-prompts` and `check-prompts` from Task 2; `loadShowConfig` from Task 1; the inventory §1 (prompt line ranges), §2 (variables), §3.2 (the season literal sites), §3.3 (script constants), §7 (config values with `file:line`).
- Produces: the show config file every script and the engine read from here on; the prompt files Plan D's pipeline names; `prompts/index.json`, which Plan D reads to build the `AgentStep`s; `Episodes/<id>/publish.json`, which `publish-kit.py` reads in Task 5.

- [ ] **Step 1: Cut the branch**

```bash
cd ~/GitHub/DeadLight && git checkout console-operating-layer && git checkout -b plan-c-show-data
```

- [ ] **Step 2: Write `showrunner.json`**

Every value below is the value the inventory §7 found, with its source. Long prose values marked "verbatim from" are copied exactly from the cited lines (the implementer opens the file). Paths are relative to the show root.

```json
{
  "showName": "Dead Light",
  "showSlug": "DeadLight",
  "promptsDir": "prompts",
  "canonDir": "Canon",
  "episodesDir": "Episodes",
  "productionDir": "Production",
  "models": {
    "small": "claude-haiku-4-5",
    "medium": "claude-sonnet-5",
    "large": "claude-opus-4-8",
    "writer": "claude-fable-5"
  },
  "airMap": {
    "ep01": [1, 1], "ep02": [1, 2], "ep03": [1, 3], "ep04": [1, 4], "ep05": [1, 5],
    "ep06": [1, 6], "ep07": [1, 7], "ep08": [1, 8], "ep09": [1, 9], "ep10": [1, 10]
  },
  "output": {
    "nasMount": "/Volumes/media",
    "nasRoot": "/Volumes/media/DeadLight",
    "finalFilename": "{slug} S{season:02d}E{episode:02d}.mp4",
    "mixFilename": "{slug} S{season:02d}E{episode:02d}.wav",
    "videoFilename": "episode.mp4"
  },
  "audio": {
    "sampleRate": 24000,
    "loudness": { "i": -14, "tp": -1.5, "lra": 11 },
    "voiceDesignLoudnessI": -16,
    "roomToneDb": -42,
    "roomToneFundamentalHz": 55,
    "tailOutSeconds": 1.0,
    "titleCardGapSeconds": 7.0,
    "titleCardGapMaxSeconds": 8.5,
    "sceneTransitionGapSeconds": 3.5,
    "sceneTransitionGapMaxSeconds": 4.0,
    "authoredPauseRangeSeconds": [0.2, 3.5],
    "narratorSpeakerKey": "narrator",
    "mainCast": ["narrator", "Sarn", "Sable", "Trent", "Opha", "Cricket", "Remo"],
    "voiceRefsDir": "Production/voice-refs",
    "guestRefsDir": "Production/{episodeId}/guest-refs",
    "voiceRegistry": "Canon/voice-registry.md"
  },
  "visual": {
    "refs": "Canon/refs.json",
    "style": "Canon/visual-style.md",
    "auditLaws": "Canon/visual-audit-laws.md",
    "castingPileDir": "Canon/characters",
    "candidatesDir": "Canon/_candidates",
    "shotFrame": [1024, 576],
    "characterKinds": ["human", "creature", "ship"],
    "ambientPromptScaffold": ["<verbatim from image-sheet.py:16–17, one string per element>"],
    "styleConstants": "<verbatim from nano-banana-generate.py:37–41>",
    "collectivePopulatorBans": ["<verbatim from nano-banana-generate.py:383–400, one phrase per element>"]
  },
  "video": {
    "fps": 30,
    "crossfadeSeconds": 1.0,
    "compositionId": "Episode",
    "titleCard": {
      "text": "DEAD LIGHT",
      "fontFamily": "Georgia, 'Times New Roman', serif",
      "colors": { "background": "#000504", "type": "#b8d4d0", "glow": "rgba(96, 160, 152, 0.25)", "stage": "#04100f" },
      "fadeSeconds": 2.0
    }
  },
  "publish": {
    "channelName": "[YOUR NAME]",
    "playlistUrl": "https://www.youtube.com/playlist?list=PLciZ4PlFk16g",
    "playlistName": "Dead Light Season 1",
    "tags": "<verbatim from publish-kit.py:49>",
    "category": "Film & Animation",
    "standingCopy": { "weekly": "<verbatim from publish-kit.py:107>", "aiDisclosure": "<verbatim from publish-kit.py:113>" },
    "guide": "Canon/publishing-guide.md"
  }
}
```

Verify it loads: from `~/GitHub/Showrunner/engine`, `node -e "import('./dist/index.js').then(m => m.loadShowConfig('/Users/ryanperkowski/GitHub/DeadLight')).then(c => console.log(c.showName, Object.keys(c.airMap).length))"` prints `Dead Light 10` (build the engine first).

- [ ] **Step 3: Write the overrides file**

`~/GitHub/Showrunner/tools/show-data/deadlight-overrides.json` — one entry per site the rules cannot rewrite (inventory §2 and §9). The `pattern` strings are copied exactly from the YAML; where a block spans lines, the pattern contains `\n`:

| nodeId | pattern (from) | replacement |
|---|---|---|
| `outline` (write-episode:48–50) | the three lines from `The full request is: $ARGUMENTS` through the sentence explaining that the first token is the episode id | `The premise for this episode is in Episodes/{{episodeId}}/premise.md. Read it first; it is the request.` |
| `*` | `Canon/season-1.md` | `Canon/season-{{season}}.md` (twelve sites, inventory §3.2) |
| `canon-gate` (canon-update:115, the gate's message) | `$diff.output` | `{{results.diff}} — the full diff is in Production/{{episodeId}}/canon-diff.patch; read that file, not this summary.` |
| `visual-direction` (produce-assets:437–460) | the lead-in "After writing prompts.json, run the project's own guard…", the embedded `uv run python -c "..."` program, its explanatory paragraph, and the closing bullet asking for "the guard's violation count (must be 0)" — through the end of the prompt body | `The pipeline runs the collective-populator check (populator-check.py) after this step and stops the line if a brief describes a crowd without naming its members. Do not run Python yourself; write briefs that name every populator.` |

Every other `$` form is handled by the rules (`$setup.output` and its period case, `$EP`, `$EP_ID`, `$REJECTION_REASON`, the eleven `$<agent>.output` forms, the five script-stdout forms, the three guard forms, `$desk-gate.output`). The extractor must report **zero** unmapped forms; if it reports one, the override table above is missing a site and the implementer adds it and records it in the report.

- [ ] **Step 4: Run the extractor**

```bash
cd ~/GitHub/Showrunner && npm run build && node tools/dist/extract-prompts.js \
  --workflows /Users/ryanperkowski/GitHub/DeadLight/.archon/workflows \
  --out /Users/ryanperkowski/GitHub/DeadLight/prompts \
  --overrides tools/show-data/deadlight-overrides.json \
  --schema-required-add outline-canon-check=verdict,continuity-check=verdict,tone-check=verdict,flow-check=verdict,character-check=verdict,environment-check=verdict,structure-check=verdict,repetition-check=verdict
```

Expected: 30 prompt files, 9 `*.reject.md`, 9 `*.gate.md`, 8 `*.schema.json`, `index.json`; `unmapped: 0`, `unused: 0`, no collision. On a re-run into the now non-empty directory add `--force` (the extractor refuses otherwise; on macOS a stray `.DS_Store` also counts as an entry — delete it rather than forcing past it). The override patterns are matched on word boundaries, so a pattern must begin and end at a word edge or at whitespace; the four planned patterns do. Use the node ids as they appear in the YAML. The extractor refuses to run when two writes would target one file (a node id shared by two workflows, or a node with both `prompt` and `loop.prompt`), naming the file and both sources; the five real workflows collide nowhere (`setup` is a bash node in each and is not extracted; the agent ids are listed in inventory §1). It also refuses a non-empty output directory unless `--force`, and reports any override or `--schema-required-add` entry that matched nothing — a typo'd node id or a truncated pattern is an error, not a silent no-op.

- [ ] **Step 5: Hand-finish and check**

Read every extracted file once against its source block. The only differences allowed are the variable rewrites and the four overrides. Then write `deadlight-check-context.json` with a sample context whose `results` carries every key any prompt references (the union of `results.<key>` across `prompts/*.md`, each with a plausible sample value: reviewer keys as `{ "pass": true, "verdict": "DRAFT PASSED", "issues": [] }`, gate rejection keys as a sentence, script keys as a one-line summary, `diff` as `NO_CHANGES`), `season: 2`, and `show` as the parsed `showrunner.json`. Run:

```bash
node tools/dist/check-prompts.js --prompts /Users/ryanperkowski/GitHub/DeadLight/prompts --context tools/show-data/deadlight-check-context.json
```

Expected: no errors. A `TemplateError` here is a hole the extraction left; fix the override, re-extract, re-check. `check-prompts` skips `README.md` (the one non-prompt file the directory holds, whose examples carry literal braces); run the check again after Step 6 writes it, on the final state.

- [ ] **Step 6: Per-episode publish data and the audit laws**

For each of `ep01`…`ep10`, write `Episodes/<id>/publish.json`: `{ "logline": "<that episode's entry in publish-kit.py:25–48, verbatim>" }`. Write `Canon/visual-audit-laws.md` with the eight numbered laws from `nano-banana-generate.py:295–313`, verbatim, under a one-line heading. Write `prompts/README.md` (ten lines): what the directory is, that the files are the show's asset and are edited here, the naming scheme (`<step>.md`, `<gate>.reject.md`, `<gate>.gate.md`, `<step>.schema.json`), the template variables, and that `index.json` is regenerated by the extractor only until Plan F deletes `.archon/`, after which it is hand-maintained.

- [ ] **Step 7: Commit in both repositories**

DeadLight (`plan-c-show-data`): `git add showrunner.json prompts Episodes/*/publish.json Canon/visual-audit-laws.md && git commit -F -` with subject `show data: showrunner.json, prompts/ extracted from the five workflows, per-episode publish data, the visual audit laws` and both trailers. Showrunner (`plan-c`): `git add tools/show-data && git commit -F -` with subject `tools: the inputs the Dead Light extraction was run with` and both trailers. Do not push either.

---

### Task 4: The scripts, part one — the shared helper and the audio branch (engine repository)

**Files:**
- Create: `scripts/pyproject.toml`, `scripts/lib/__init__.py`, `scripts/lib/showconfig.py`, `scripts/tests/conftest.py`, `scripts/tests/test_showconfig.py`, `scripts/tests/test_validate_manifest.py`, `scripts/tests/test_audio_mix.py`, `scripts/tests/test_qc_spawn.py`, `scripts/tests/fixtures/showrunner.json` (an invented show)
- Copy (verbatim, first commit): every `.py` file in `~/GitHub/DeadLight/.archon/scripts/` into `~/GitHub/Showrunner/scripts/` (29 files: the 21 step scripts and the show's 8 `test_*.py` files, which travel with them; `[tool.pytest.ini_options] testpaths = ["tests"]` keeps `uv run pytest` on Task 4's hermetic suite, and the copied `test_truncation_qc.py` is run by hand once after the edit)
- Modify (second commit): `scripts/tts-generate.py`, `scripts/validate-manifest.py`, `scripts/truncation-qc.py`, `scripts/pace-qc.py`, `scripts/breath-qc.py`, `scripts/audio-mix.py`, `scripts/design-voice.py`

**Interfaces:**
- Consumes: inventory §4.1 (per-script rows with the `file:line` of every constant), §4.2 (every shell-out), §8.1 (test feasibility per script); `showrunner.json` from Task 3.
- Produces (`scripts/lib/showconfig.py`):

```python
SHOW_CONFIG_FILE = "showrunner.json"
class ShowConfigError(Exception): ...
def load(show_root: str | None = None) -> dict:          # show_root: the --show-root argv value, else os.getcwd(); reads <root>/showrunner.json; raises ShowConfigError naming the file or the first missing required key (same required set as the engine: showName, showSlug, promptsDir, models.medium/large/writer, airMap, output.nasRoot)
def show_root(argv: list[str]) -> str:                    # parses an optional "--show-root <path>" out of argv (removing it), else os.getcwd()
def path(cfg: dict, *keys: str, root: str) -> str:        # cfg["a"]["b"] joined to root unless absolute; raises ShowConfigError naming the key path when absent
def format_filename(pattern: str, *, slug: str, season: int, episode: int, episode_id: str = "") -> str   # str.format with those names
def season_of(cfg: dict, episode_id: str) -> tuple[int, int]   # (season, episode): from sXXeYY, or airMap[episode_id]; raises ShowConfigError when neither
def progress(done: int, total: int, unit: str, message: str | None = None) -> None   # prints the ::progress line, flush=True
def value(cfg: dict, *keys: str) -> object                # cfg walked through keys; raises ShowConfigError naming the dotted path when absent — every non-path config read goes through it
```

**The convention every script follows after this task:** `import sys; from lib import showconfig as sc; root = sc.show_root(sys.argv); cfg = sc.load(root); os.chdir(root)` (so `--show-root` relocates the show and the script's relative paths follow); positional arguments as before, `--show-root` optional; no `ARGUMENTS`; every `subprocess` call an argv list; `sc.progress(...)` once per unit in the main loop; the last stdout line a one-line summary when a later step reads it; a `ShowConfigError` is caught in the `__main__` block and exits with one line; every script has an `if __name__ == "__main__": main()` guard so tests can import it.

- [ ] **Step 1: Copy the scripts verbatim and commit**

```bash
mkdir -p ~/GitHub/Showrunner/scripts && cp ~/GitHub/DeadLight/.archon/scripts/*.py ~/GitHub/Showrunner/scripts/ && cd ~/GitHub/Showrunner && git add scripts && git commit -F - <<'MSG'
scripts: the deterministic steps, copied verbatim from the show repository (modified in the next commits)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

The verbatim commit exists so every later change is a reviewable diff against the shipped scripts.

- [ ] **Step 2: `pyproject.toml`, the helper, and its tests**

`scripts/pyproject.toml`: project `showrunner-scripts`, Python `>=3.11`, dependencies = the union of every script's inline `# /// script` dependency block (read each header; list them once), plus `pytest` under `[dependency-groups] dev`. Tests run with `cd scripts && uv run pytest`. Write `lib/showconfig.py` per the interface. `tests/fixtures/showrunner.json` is an invented show ("Harbor Lights", slug `HarborLights`, two `airMap` entries, a 2-name `mainCast`) with every key Task 3's file has. `tests/test_showconfig.py`: loads the fixture through `load(root)`; a missing file names `showrunner.json`; a missing `models.writer` names it; `show_root` strips `--show-root` and leaves other args; `format_filename("{slug} S{season:02d}E{episode:02d}.wav", slug="HL", season=1, episode=3)` is `HL S01E03.wav`; `season_of` reads `s02e01` and `ep02` and fails on `ep99`; `progress` prints the exact JSON line (capture stdout).

- [ ] **Step 3: The audio branch, script by script** (inventory §4.1 gives the line numbers; the changes are)

- `tts-generate.py`: argv-only (`<episode>` positional); `audio.sampleRate` from config; `sc.progress(i, n, "segments")` after each segment in the main loop (skipped segments count as done); no other behaviour change. Hermetic test: not possible (needs the model); the test asserts the argv parsing and that `--show-root` is honoured by running the script with `--help`-style dry mode if it has one, else no test and the report says so.
- `validate-manifest.py`: argv-only; the gap ceilings (`titleCardGapMaxSeconds`, `sceneTransitionGapMaxSeconds`), the authored-pause range, `mainCast` and `voiceRegistry` (through `sc.path`) from config; its last stdout line is the one-line summary the gate message reads (`{{results.validate-manifest}}`). Test: a tiny manifest with one bad gap fails with the ceiling named; a good one prints a summary line last.
- `truncation-qc.py`, `pace-qc.py`, `breath-qc.py`: argv-only; the `tts-generate.py` child is spawned as `[sys.executable, str(Path(__file__).with_name("tts-generate.py")), ...]` (not `uv run` with a show-relative path) with **no** `stdout=DEVNULL` and **no** `start_new_session`, so its progress lines flow through and it stays in the parent's process group (F-11); `sc.progress(round, max_rounds, "rounds")` per pass; loudness/narrator key from config. Test (`test_qc_spawn.py`): monkeypatch `subprocess.run` and assert the argv list's shape and that `stdout` is not redirected and `start_new_session` is absent.
- `audio-mix.py`: argv-only; `airMap`, `mixFilename`, `showSlug`, `loudness`, `roomToneDb` (replaces the `HUM_DB` env var), `roomToneFundamentalHz`, `tailOutSeconds`, `sampleRate`, `narratorSpeakerKey` from config; `sc.progress` per segment placed; the last line printed is `MIX_OK <duration>s <lufs> LUFS <path>` (the gate reads it). Test: two 0.5 s synthetic WAVs mixed if `ffmpeg` is on `PATH` (`pytest.importorskip`-style skip otherwise) — assert the output filename follows the pattern and the last line starts with `MIX_OK`.
- `design-voice.py`: argv-only; `audio.voiceDesignLoudnessI` and `sampleRate` from config. No hermetic test (needs the model).
- Grep gate for this commit: `grep -niwE 'dead ?light|deadlight|DEADLIGHT_|sarn|sable|opha|cricket|remo|trent|ilvaren' scripts/lib scripts/tts-generate.py scripts/validate-manifest.py scripts/truncation-qc.py scripts/pace-qc.py scripts/breath-qc.py scripts/audio-mix.py scripts/design-voice.py` prints nothing (`image-qc.py` is Task 5's, so it is named out of this gate). `breath-qc.py`'s progress line is per segment (its round bound lives inside `fix()`), not per round.

- [ ] **Step 4: Run and commit**

Run: `cd ~/GitHub/Showrunner/scripts && uv run pytest -q` — expected: 54 passed with ffmpeg on PATH (18 showconfig, 21 qc-spawn, 10 validate-manifest, 5 audio-mix), 51 passed and 3 skipped without it. Commit: `scripts: showconfig helper; the audio branch argv-only, config-driven, progress-reporting` with both trailers.

---

### Task 5: The scripts, part two — vision, assembly, status, and the two new scripts (engine repository)

**Files:**
- Create: `scripts/populator-check.py`, `scripts/canon-diff.py`, `scripts/tests/test_populator_check.py`, `scripts/tests/test_canon_diff.py`, `scripts/tests/test_build_timeline.py`, `scripts/tests/test_finalize_video.py`, `scripts/tests/test_publish_kit.py`, `scripts/tests/test_registry_append.py`
- Modify: `scripts/image-generate.py`, `scripts/nano-banana-generate.py`, `scripts/image-sheet.py`, `scripts/registry-append.py`, `scripts/build-timeline.py`, `scripts/shot-sheet.py`, `scripts/master-video.py`, `scripts/finalize-video.py`, `scripts/publish-kit.py`, `scripts/status.py`, `scripts/season-status.py`, `scripts/check_layout.py`, `scripts/design-visual.py`, `scripts/image-qc.py`

**Interfaces:** consumes the helper from Task 4 and inventory §4.1/§5/§8.1; produces the scripts Plan D's pipeline invokes, with these result lines: `nano-banana-generate.py` → `NANO_OK <n>/<n>` or `NANO_PARTIAL <k>/<n>`; `master-video.py` → `MASTER_OK <path>`; `canon-diff.py` → `NO_CHANGES` or `CHANGED <files> files, <lines> lines`; `populator-check.py` → `POPULATORS_OK` or exits 2 with the offending briefs listed on stderr.

- [ ] **Step 1: Script by script**

- `image-generate.py`: argv-only; `visual.refs`, `visual.shotFrame` from config; `sc.progress` per shot. No hermetic test (GPU).
- `nano-banana-generate.py`: argv-only; `visual.refs`, `visual.style`, `visual.styleConstants`, `visual.collectivePopulatorBans` from config; the eight audit laws are read from the file at `visual.auditLaws` and inserted into the audit prompt where the literal block was (`:295–313` becomes a file read); `sc.progress` per shot; last line `NANO_OK`/`NANO_PARTIAL` as today. `find_collective_populators` is moved into `scripts/lib/populators.py` and imported by both this script and `populator-check.py`. Hermetic test: `lib/populators.py` against three briefs (a crowd without names → flagged; named populators → clean; a capping idiom → flagged) using the fixture config's ban list.
- `populator-check.py` (new): `<episode>` positional; reads `Production/<episode>/images/prompts.json`; runs `find_collective_populators` on every character brief; prints `POPULATORS_OK` or exits 2 listing each offending shot id and phrase on stderr. Test: two `prompts.json` fixtures.
- `image-sheet.py`: argv-only; `visual.ambientPromptScaffold` from config.
- `registry-append.py`: argv-only; `visual.characterKinds`, `visual.castingPileDir`, `visual.refs` from config. Test: appends one entry to a fixture `refs.json` in a temp show root and rejects an unknown kind.
- `build-timeline.py`: argv-only; `video.fps`, `video.crossfadeSeconds`, `video.titleCard` (text, fontFamily, colors, fadeSeconds), `output.mixFilename`, `airMap`, `showSlug`, `audio.tailOutSeconds`, `visual.shotFrame` from config; the `title` object it already writes into `timeline.json` gains `text`, `fontFamily`, `colors` (F-12), and the file gains a top-level `fps`. Test: a temp show root with a 1 s WAV (written with the `wave` module) and two PNG names produces a `timeline.json` whose `fps` is the fixture's, whose `title.text` is the fixture's, and whose shot count is two.
- `shot-sheet.py`: `video.fps`, `video.crossfadeSeconds` from config.
- `master-video.py`: argv-only; `audio.loudness` from config; writes `Production/<ep>/video/episode-mastered.mp4` and never replaces its input (F-09); last line `MASTER_OK <path>`. Test: only if `ffmpeg` is present — a 1 s silent MP4 in, the mastered file appears beside it, the input's bytes unchanged.
- `finalize-video.py`: argv-only; `airMap`, `output.nasMount`, `output.nasRoot`, `output.finalFilename`, `showSlug`, the lenient RULED grammar (F-10) from config/constants; prefers `episode-mastered.mp4` when present; the `DEADLIGHT_FINAL_MOUNT`/`DEADLIGHT_FINAL_DEST` env vars are removed. Test: with a temp "NAS" directory passed through the fixture config, an `ep02` with a mastered file is copied to `<nasRoot>/<finalFilename>` and the local file is untouched; an unmapped production id fails naming `airMap`.
- `publish-kit.py`: argv-only; `publish.*` and `showName`/`showSlug`/`airMap` from config; the `LOGLINE` dictionary is deleted and the logline is read from `Episodes/<ep>/publish.json` (missing → a clear error naming the file). Test: a fixture episode with `publish.json` produces a kit whose title carries the fixture's show name and whose description contains the logline; the placeholder reminder still prints when `channelName` is `[YOUR NAME]`.
- `status.py`, `season-status.py`: argv-only; every path (`episodesDir`, `productionDir`, `seasonFilePattern` as `Canon/season-{season}.md`, `output.nasRoot`, `output.finalFilename`), `airMap` (replacing the regex read of `finalize-video.py`'s source, F-14), and `showSlug` from config; otherwise unchanged — both are retired by Plan F. Test: `season-status.py` against a fixture season file with one lenient-RULED row lists that row.
- `check_layout.py`, `design-visual.py`, `image-qc.py`: argv-only and config paths only.
- `canon-diff.py` (new): `<episode>` positional; runs `["git", "diff", "--", cfg["canonDir"]]` in the show root (argv list), writes the output to `Production/<episode>/canon-diff.patch`, prints `NO_CHANGES` when empty else `CHANGED <n> files, <m> lines`. Test: a temp git repo with one changed canon file.
- The grep gate, whole tree: `grep -rniE 'dead[ -]?light|DEADLIGHT_|sarn|sable|opha|cricket|remo\b|trent|ilvaren' scripts/ --include='*.py'` prints nothing; `grep -rn 'shell=True\|os.system' scripts/ --include='*.py'` prints nothing; `grep -rn 'ARGUMENTS' scripts/ --include='*.py'` prints nothing.

- [ ] **Step 2: Run and commit**

Run: `cd ~/GitHub/Showrunner/scripts && uv run pytest -q` — all pass, ffmpeg-dependent tests skipped where absent. Commit: `scripts: vision, assembly and status branches config-driven; populator-check and canon-diff; no show name remains` with both trailers.

---

### Task 6: The render project (engine repository)

**Files:**
- Copy (verbatim, first commit): `~/GitHub/DeadLight/remotion/` → `~/GitHub/Showrunner/render/` (excluding `node_modules/`, `out/`, and `public/` contents — `public/` is the per-episode staging directory `build-timeline.py` fills; keep it as an empty directory with a `.gitkeep`)
- Modify (second commit): `render/src/Episode.tsx`, `render/src/Root.tsx`, `render/package.json` (name `@showrunner/render`), `render/README.md`
- Test: `render/src/timeline.test.ts` (vitest, in the render package) — the timeline parser only; no render

**Interfaces:**
- Consumes: `timeline.json` as `build-timeline.py` writes it after Task 5: top-level `fps`, `durationInFrames`, `shots[]`, `title: { from, durationInFrames, fadeFrames, text, fontFamily, colors: { background, type, glow, stage } }`, `audio` (inventory §5.1 for today's shape).
- Produces: a composition whose fps and duration come from `calculateMetadata` reading the timeline, and whose title card renders from `timeline.title`; `render/` contains no show literal.

- [ ] **Step 1: Copy and commit verbatim** (same pattern as Task 4 step 1; subject `render: the Remotion project, copied verbatim from the show repository`).

- [ ] **Step 2: Title card from the timeline; fps from the timeline**

`render/src/timeline.ts` (new): `export interface Timeline { fps: number; durationInFrames: number; title: { from: number; durationInFrames: number; fadeFrames: number; text: string; fontFamily: string; colors: { background: string; type: string; glow: string; stage: string } }; shots: unknown[]; audio: unknown }` and `export function parseTimeline(json: unknown): Timeline` that validates the fields it names and throws naming the first missing one. `Episode.tsx:37–70`: the `DEAD LIGHT` string, the font stack, and the four colours (inventory §5.1) are replaced by `title.text`, `title.fontFamily`, `title.colors.*` from the parsed timeline prop. `Root.tsx`: `fps` and `durationInFrames` come from `calculateMetadata` over the loaded timeline instead of the literal `30`; the composition id stays `Episode` (it is `video.compositionId` in config, read by the assemble pipeline in Plan D, not by the render).

`render/src/timeline.test.ts`: a minimal valid timeline parses; a missing `title.text` throws naming it; `fps: 24` is honoured.

- [ ] **Step 3: Verify**

Run: `cd ~/GitHub/Showrunner/render && npm install && npx vitest run && npx tsc --noEmit` — expected: 3 tests pass, typecheck silent. A full `npx remotion render` is NOT run in this task (it takes minutes and needs an episode); Plan D's first real assemble run is where the render is exercised. Grep gate: `grep -rniE 'dead[ -]?light' render/src render/README.md` prints nothing.

- [ ] **Step 4: Commit** — `render: title card and fps from the timeline; no show literal remains` with both trailers.

---

### Task 7: Documentation and the deferred record (both repositories)

**Files:**
- Modify: `~/GitHub/Showrunner/README.md` — new sections **"The show config"** (every key group with one sentence each, the required set, and that paths are relative to the show root), **"Scripts"** (the convention: argv-only, cwd = show root, `--show-root`, `showrunner.json` through `lib/showconfig.py`, the progress line, the result line, idempotency by output-exists, `uv run pytest`), **"Tools"** (`extract-prompts`, `check-prompts`, and that `tools/show-data/` is the one place in the engine repository that carries a show's name), and the template table gains `{{season}}` and `{{show.<path>}}` if Task 1 did not already add them.
- Modify: `~/GitHub/DeadLight/README.md` — a section on `showrunner.json` (what it is, that the engine and every script read it, and that `[YOUR NAME]` in `publish.channelName` is unfilled) and on `prompts/` (pointing at `prompts/README.md`).
- Create: `~/GitHub/Showrunner/docs/plans/2026-09-28-show-config-and-prompts-deferred.md` — in the shape of the Plan A and Plan B records: what Plan C leaves to D, E and F (below), what the reviews parked, and every ruling made during execution.

**What this plan deliberately leaves to the next plans (seed the deferred document with these):**
- **Plan D** builds the pipelines from `prompts/index.json`: each index entry becomes an `AgentStep` (model alias, `allowedTools`, `context`, `timeoutMs`/`idleTimeoutMs`, `schema` from the `.schema.json`), each `.reject.md` a gate's `onReject`, each `.gate.md` a gate's `message` template; the three bash decisions become guards that always set a message; `canon-diff.py` and `populator-check.py` become script steps; the assemble `setup` guard reads `output.nasMount`/`nasRoot`; the premise is `Episodes/<id>/premise.md` and `NEEDS_IDEA` derives from it; the QC re-synthesis stays inside the scripts unless Plan D chooses the pipeline-loop redesign (F-11); loop bodies carry no schema.
- **Plan E** deletes nothing yet but reads the same config; the console's own copies of the air map, the NAS path and the id regex (inventory §6) are what Plan F removes.
- **Plan F** deletes `.archon/`, `console/`, `remotion/`, and the root `package.json` from the show repository, renames Season 1 to `sXXeYY`, empties `airMap`, and retires `status.py`/`season-status.py` and the RULED-row grammar; any SDK or Python dependency bump re-runs the hermetic suites.
- **Stage 0 (the season desk)** is not wired: its six prompts are extracted and its `$desk-gate.output` rewrite renders the gate answer as JSON; the desk's plan decides the `<gate>:answer` key (F-04).
- **Ryan's credit name** (F-17) is set in `publish.channelName` when he gives it.

- [ ] **Step 1: Write the three documents; Step 2: commit each repository** (`docs: show config, scripts and tools sections; Plan C's deferred record` in Showrunner; `docs: showrunner.json and prompts/ in the README` in DeadLight), both trailers, no push.

---

## What this plan does not do

It does not wire any prompt into a pipeline (Plan D), does not touch the console (Plan E), does not delete anything from the show repository (Plan F), and does not run a synthesis, an image generation, or a render — every test is hermetic or skipped when its tool is absent. The first real run of the relocated scripts is Plan D's first episode.
