# The New-Show Setup Implementation Plan (Plan G)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build spec §9 — a command-line `init` that names a show and its repository, creates the repository locally and on GitHub in the house layout, writes a complete `showrunner.json`, copies a generic prompt set into it, and produces the show's first bible through an interview that writes the author's own words into each bible file behind the engine's gate shape — so that a second show can reach its first `NEEDS_REFS` stop without any file of Dead Light's inside it, and so that Ryan can set up a fresh Dead Light instance by importing his existing bible file by file.

**Architecture:** Four pieces, all in the engine repository. **The templates** (`tools/templates/`) are the generic prompt set derived from Dead Light's thirty-four pipeline prompts — the show's name becomes `{{show.showName}}`, every law a prompt stated inline moves into the bible file the prompt already reads, and the two production-specification prompts keep their tool content and lose their show content — plus one template per bible file whose headings are the interview's question list. **The engine** gains three small things: per-step template variables (`{{vars.<name>}}`) so the interview's fourteen gates share three prompt files; a `bible.ts` that names the bible's files and the sections the prompts read by name, with a `bible-ready` guard at the head of the episode pipeline; and `bibleFilePipeline`, a one-file pipeline — an agent that writes the file from the author's answers, and a gate with a fix agent — run once per bible file. **The interview driver** (`tools/src/init/interview.ts`) asks the template's questions in the terminal, writes the answers to disk, runs that file's pipeline through the real agent executor, and answers the gate from the terminal with four choices: approve, reject with notes, "I will write this one myself" (the template is written), and "import this file" (a path is copied). **`init`** (`tools/src/init/`) is the command that does the rest: refuses a non-empty directory, writes the layout, builds the config, copies the prompts, derives `.gitignore` from the config's own directory keys, commits the scaffold, runs the interview file by file (one commit per approved file), creates the GitHub repository with `gh` at the end, and prints what to do next. The event log is the interview's record: every answer, rejection and approval is in `Production/setup/<file>/runs/`.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext) in the `tools/` workspace, vitest 2; the engine as a workspace dependency; `gh` 2.95 for the GitHub step; `git` for the commits. No new Python. No console changes.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §0 ("it does not invent the show"; the bible must exist before the first episode), §6.1 (prompts live in the show repository), §7.3 (two repositories; one engine, many shows), §7.4 (no show's name in the engine), §9 (the new-show setup: §9.1 the repository, §9.2 the interview, §9.3 voices and references, §9.4 where it lives, §9.5 the open questions). **The inventory this plan is written from:** `docs/plans/2026-10-02-plan-g-inventory.md` — what a show repository must contain (§1), the thirty-four prompts measured and classified (§2), how Dead Light's bible came to be and the target shape per file (§3), the repository-creation step (§4), and 26 findings (§5). **The obligations this plan pays:** O-01, O-02 (in part), O-04, O-06 from the inventory's first section; O-03 and O-05 are recorded as not Plan G's (below).

**This is plan G, written before Plan F.** Ryan ruled on 2026-10-02 that Plan G runs before Plan F so that console v1 keeps working beside the new console while he transitions. Ryan ruled on 2026-10-02 that a new show's prompt set comes from **generic templates shipped in the engine** (the inventory's F-03, option A), not from copies of Dead Light's prompts. Ryan ruled on 2026-10-03 that Plan G is **the command line only**: the show registry and the console's "New show" surface (O-05, the inventory's F-25) are **Plan H**. Ryan said on 2026-10-02 that when Plan G is ready he will have a fresh Dead Light instance set up with it, so the interview's **import** answer is a first-class part of this plan, and Task 10 prepares Dead Light's bible for that import.

## Rulings on the inventory's findings (made 2026-10-03; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| F-01 nothing checks the bible exists; a missing bible file is silent | **A `bible-ready` guard at the head of the episode pipeline** (Task 3), between `previous-episode` and `premise`: every bible file the pipeline itself declares as an input must exist and be non-empty, listed by name in the failure message. The sections prompts read by name are checked by `bible-check` (Task 8), which `init` runs last and the show's README tells the author to run after editing. The guard does not check sections, so the engine's walk-test fixtures need only the files. **The inventory's second claim — that writing an absent file later never invalidates a completed step — is wrong:** `sameHashes` (`engine/src/hash.ts:24-32`) compares values, and `null` differs from a hash. No cache change is made. |
| F-02 forty-six config leaves the loader validates only as objects | **`SHOW_CONFIG_KEYS`** (Task 2): one list in `engine/src/show-config.ts` of every dotted key the engine or a script reads — required or optional, with the default where one exists and who reads it — and a test that greps every `sc.value(cfg, …)`/`sc.path(cfg, …)` site in `scripts/` and refuses a key the list does not carry. `init` builds a config that carries every key (`buildShowConfig`, Task 8). The loader's `Record<string, unknown>` groups stay as they are: enforcing the list at load time is a Plan F hygiene item, recorded. |
| F-03 where a new show's prompt set comes from | **Generic templates in `tools/templates/prompts/`** (Ryan's ruling, option A), one per Dead Light prompt the episode pipeline names, derived by the class the inventory measured: the 5 engine-generic and 16 parameterise prompts change only their show-name sites (Task 4); the 11 generalise prompts lose their inline laws to the bible template's questions (Tasks 5 and 6); the 2 rewrite prompts keep their tool sites and lose their show sites (Task 6). The 515 generalise-class lines become **questions in the canon templates**, not text in the prompt templates: the law's content is the author's answer. |
| F-04 the outline template teaches the wrong format | **`tools/templates/episodes/_TEMPLATE/outline.md` teaches the format the `outline` prompt and the `draft` loop require** (Task 5): `## Scene synopsis`, `## Arc beats`, `## Cast`, `### Beat <n>`, `## Ending duties`, `## New canon proposed`. It is a fixed artifact `init` copies, not an interview target. Dead Light's own stale template is Plan F's. |
| F-05 four prompts define the register by pointing at `Episodes/ep01` | **The style guide gains a `## Register sample` section** — the interview asks the author for 150–300 words in the voice they want, a passage rather than rules — and the templates say: "Read the most recently approved script under `Episodes/*/script.md` if one exists; when none exists, the `## Register sample` section of `Canon/style-guide.md` is the register's only demonstration." The globs become `Episodes/*/script.md` (grammar-free, so Plan F's rename does not break them). Task 10 adds the section to Dead Light's style guide. |
| F-06 the production tools are the engine's | **Stated as a scope boundary:** a new show gets Qwen3 cloning, the local image builder, Nano Banana and Remotion by construction; `init` asks nothing about tools, and the 24 tool sites in four prompts are engine-generic and stay as they are. `tts-script.md`'s class is "rewrite its show sites, keep its tool sites". |
| F-07 may the interview cite Dead Light's files | **No.** Every example in a template is from the invented show the fixtures already use — "Harbor Lights" (slug `HarborLights`; cast Vale, the Warden, Pim, Maeve; location Harbor) — and the show-name grep over `tools/` enforces it. Ryan's own instance gets Dead Light's files through the import answer, which reads them from the path he gives and nowhere else. |
| F-08 every law carries a retrospective stamp | **Every law the interview writes is stamped `DRAFT (interview <date>)`**, and every interviewed file's header carries the legend from `Canon/season-2.md:16-19`: `RULED` means approved and binding; `DRAFT` means proposed, pending an episode. Approval at the gate does not promote `DRAFT` to `RULED`; an episode or the author's hand does. |
| F-09 the question list has two sources | **The template's headings are the question list; the sections the prompts read by name are `REQUIRED_SECTIONS`** (Task 3), a subset the templates must carry and `bible-check` verifies. Each `## Heading` in a canon template is followed by an HTML comment `<!-- Q: … -->` holding its question; the interview asks exactly those, in order. Section names match Dead Light's headings wherever Dead Light's heading is generic, so an imported Dead Light file passes `bible-check` with the few renames Task 10 lists. |
| F-10 four files the pipeline writes cannot be interviewed | **Scaffolded with their headings** (Task 5): `continuity-ledger.md` with `## How to use`, `## Open threads`, `## Resolved`, `## Episode log` and a how-to-use paragraph stating that `propose` appends under them; `voice-registry.md` with its header naming `Production/voice-refs/refs.json` as the source of truth. `timeline.md` and `season-1.md` **are** interviewed — the world's history and the first season's laws are the author's to state — and are also written by the pipeline later. |
| F-11 `story-craft.md` is engine-generic craft doctrine | **Supplied as a filled default** the author may keep, edit or replace at its gate (the "default" mode of Task 7), breaking spec §9.2's "never content" rule for exactly three files, each of which states the engine's facts or the house's craft rather than the show's: `story-craft.md`, `pipeline-artifacts.md` (its artifact catalog, folder convention and dialogue-attribution convention; not `STATUS.md`, not the launch section), and `Canon/README.md` (the house format). |
| F-12 the image audit exists twice over two law files | **The `image-audit.md` template reads `visual-audit-laws.md`** (the file `visual.auditLaws` names) for its laws and `visual-style.md` for the look, and restates nothing — one law file serves both audits, and the prompt's class becomes parameterise. Dead Light's own prompt is untouched. |
| F-13 `Canon/README.md` is the house format and no step reads it | **A filled default** (F-11): the "what lives where" table with the generic file list, the two-way rule, the naming rule, the status vocabulary, and a generic ids-in-prose rule ("write `SxEy` in prose; a production id appears only inside a path"). The two-lens rule and the `epNN` rule are Dead Light's and are not in the template. |
| F-14 `pipeline-artifacts.md` is engine documentation in the bible | **Kept, as a filled default, reduced to the show-facing part** (F-11). `tts-script.md`'s template reads its `## Script dialogue attribution` section by name, so the file stays in the bible; moving it into the engine's README is recorded for later. |
| F-15 neither reference index has a template | **Both are written with their `_doc` keys and an empty entry set** (Task 5): `Canon/refs.json` as `{"_doc": …, "_workflow": …}` and `Production/voice-refs/refs.json` as `{"engine": …, "note": …, "cast": {}}`. `missingRefs` then reports every recurring subject by name, which is `NEEDS_REFS` and is what spec §9.3 wants, and the author has a shape to fill. |
| F-16 `gh` or a token; the flag order | **`gh`.** `init` runs `gh auth status` first; when it exits 0 the last step is `gh repo create <slug> --source <path> --push --private` (or `--public`); when it does not, `init` finishes locally and prints that one command. **The scaffold is committed before the interview** — `git init`, one commit — so every approved bible file is its own commit and an interrupted interview is on disk; **the remote is created after** the interview, so no half-finished show reaches GitHub. |
| F-17 the id scheme | **Closed as "no": a new show starts at `s01e01`, `airMap` is `{}`, and `epNN` is for exercises.** O-01's question — whether a show may choose a grammar — is answered no by this plan and recorded; the grammar stays the engine's two regexes. |
| F-18 where `init` lives | **`tools/`** — `tools/src/init/` with a `showrunner-init` bin entry, templates at `tools/templates/`. The show-name grep already searches `tools/` and excludes only `tools/show-data/`, so the templates are inside the paths the grep guards, which is the point. |
| F-19 every engine gate belongs to a pipeline keyed on an episode id | **One pipeline per bible file, run with the reserved id `setup`**: `bibleFilePipeline` (Task 7) is one or two steps, logged at `<productionDir>/setup/<file-key>/runs/<runId>.jsonl`, with `RunContext.episodeId = "setup"`. `listEpisodeIds` filters by the id grammar, so `setup` never appears as an episode in the console; the log is tracked in git (nothing under `Production/setup/` is ignored) and is the interview's record. The executors are the real ones (`createAgentExecutor` with `promptsDir` pointed at `tools/templates/interview/`), so the agent's queries, tool calls and the author's answers are all in the log, and a crashed `init` resumes by replay. |
| F-20 `.gitignore` does not ignore the candidates directory | **`init` derives `.gitignore` from the config's own directory keys** (Task 5's `gitignoreFor(config)`): `<productionDir>/*/audio/`, `<productionDir>/*/video/`, `<productionDir>/*/images/*.png`, `*.jpg`, `.*.bak`, `<visual.candidatesDir>/`, `Finalized`, `Finalized/`, `.DS_Store`, `.superpowers/`. Dead Light's own rule is Plan F's. |
| F-21 fourteen gates would need twenty-eight prompt files | **Per-step `vars`** (Task 1): `AgentStep.vars` and `GateStep.vars`, rendered as `{{vars.<name>}}`, so the interview has three prompt files — `write.md`, `gate.md`, `revise.md` — in `tools/templates/interview/`, in the engine, which may hold them because they name no show. `maxAttempts: 10`, as the episode gates have. |
| F-22 `init` must teach the New-episode form | **The show's `README.md` is written from a template** (Task 5) with a "Your first episode" section: the premise's three sentences (what happens, whose episode it is, what it must pay), the optional `locked-beats.md`, the console command, the `NEEDS_REFS` stop and the two casting scripts, the `## Cast` grammar and the `source` field. `init` prints the same section when it finishes. |
| F-23 the show-name grep cannot see a second show's names | **Three checks on the templates** (Task 4's harness): the README grep (which already covers `tools/`); a vitest that renders every prompt template against the Harbor Lights context and refuses a leftover hole; and a structural scan that refuses a production id (`ep\d\d`), a 2026 date, or the words "Ryan" and "ruled" anywhere in `tools/templates/` — the three forms every history stamp in the measured prompts took. |
| F-24 where "records who the recurring cast are" lands | **In character sheets.** The world-overview interview ends with one structured question — the recurring cast, one per line as `Name — one line` — and `init` writes `Canon/characters/<Name>/<name>.md` from the entity template for each, sets `audio.mainCast` to `["narrator", …names]`, and names them under `## The primary cast`. `refs.json` stays empty, so `missingRefs` reports each by name rather than by a broken path. |
| F-25 the console's "New show" surface | **Plan H** (Ryan's ruling, 2026-10-03), together with the registry (O-05). Recorded in the deferred record with what `init` already produces for it: an absolute root and a config that loads. |
| F-26 the role line is a convention worth stating | **Stated in the prompts README template and enforced by the harness:** every prompt's first line (gate messages excepted) is `You are the <role> for *{{show.showName}}*.` |

## Global Constraints

- **One repository, one branch, plus one show-repository task.** All engine work is on branch `plan-g` in `~/GitHub/Showrunner` (cut from `main` at 9347474; the inventory is its first commit, 1ebf306). Task 10 alone works in `~/GitHub/DeadLight`, on a branch `plan-g-bible` cut from `main` at 6b157b8, and opens its own pull request. Nothing is merged or pushed to either `main` by this plan.
- **No show's name in the engine** (spec §7.4, `README.md:765`), and the templates are inside the guarded paths: after every task, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. The word list is extended for this plan's templates work: `vesk|sethin|elyth|iss-kar|drayman` are also refused. Test fixtures and template examples use the invented show **"Harbor Lights"** (slug `HarborLights`, cast Vale, the Warden, Pim, Maeve, location Harbor).
- **Templates carry no history.** No `ep\d\d`, no `2026-`, no "Ryan", no "ruled" anywhere under `tools/templates/` (Task 4's scan). A law a template needs an author to state is a question, never an answer.
- **The fences of spec §4.4 hold for `init`:** every `spawn` is `spawn(cmd, args)` with an argv array; `init` writes only inside the directory it was given (and the GitHub remote it was asked for); every path it builds from an answer is resolved and checked to lie under the show root; the file-key of a bible file is one of `BIBLE_FILES`, never free text.
- **The event log is the interview's record.** The driver never writes a gate answer by hand; it calls `answerGate` and `resumeRun` like the console does.
- **Never a directory as a declared path; `exactOptionalPropertyTypes` respected; every exported symbol carries a doc comment that says why.**
- **Every commit ends with this trailer line in its final paragraph** (use `git commit -F -` with a heredoc): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Engine tests: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`. Tools tests: `cd ~/GitHub/Showrunner/tools && npx vitest run && npm run typecheck`. Console tests (Task 1 touches a type the console imports): `cd ~/GitHub/Showrunner/console && npx vitest run && npm run typecheck`. Scripts: `cd ~/GitHub/Showrunner/scripts && uv run pytest -q`. All must be clean before every commit that touches them. Do not predict test counts; report the numbers the runs print.

---

## File Structure

```
~/GitHub/Showrunner/
  engine/src/
    steps.ts                         MODIFY (Task 1): AgentStep.vars, GateStep.vars; GateMessageRenderer gains a third parameter
    prompt-template.ts               MODIFY (Task 1): RenderExtra.vars; {{vars.<name>}}
    agent-step.ts                    MODIFY (Task 1): the executor and the gate renderer pass step.vars
    runner.ts                        MODIFY (Task 1): renderGateMessage(step.messageFile, ctx, step.vars)
    pipeline.ts                      MODIFY (Task 1): describePipeline carries vars
    show-config.ts                   MODIFY (Task 2): SHOW_CONFIG_KEYS, ShowConfigKey
    bible.ts                         NEW (Task 3): BIBLE_FILES, REQUIRED_SECTIONS, headingMatches, missingBibleFiles, missingSections
    pipelines/episode.ts             MODIFY (Task 3): the bible-ready guard
    pipelines/bible.ts               NEW (Task 7): bibleFilePipeline, bibleLogDir, SETUP_ID
    index.ts                         MODIFY: export bible, pipelines/bible
  engine/test/                       prompt-template (vars), agent-step (vars), runner (renderer arity), show-config (keys + the scripts grep), bible, episode-pipeline (the guard; fixtures gain the files), pipelines/bible
  tools/
    package.json                     MODIFY: bin "showrunner-init"; "bible-check"
    templates/
      prompts/                       NEW (Tasks 4, 6): 34 .md + 8 .schema.json + README.md
      canon/                         NEW (Task 5): one template per bible file (13 gated + 2 scaffolds), with <!-- Q: --> questions
      canon/characters/_TEMPLATE.md, species/_TEMPLATE.md, locations/_TEMPLATE.md, factions/_TEMPLATE.md   NEW (Task 5)
      episodes/_TEMPLATE/outline.md  NEW (Task 5)
      refs/canon-refs.json, voice-refs.json   NEW (Task 5)
      show/README.md                 NEW (Task 5): the show's README, with "Your first episode"
      interview/write.md, gate.md, revise.md   NEW (Task 7)
    src/
      check-prompts.ts               MODIFY (Task 1): the context file may carry vars
      init/paths.ts                  NEW (Task 4): templatesDir()
      init/config.ts                 NEW (Task 8): buildShowConfig
      init/scaffold.ts               NEW (Task 5): gitignoreFor, writeScaffold, the canon-template parser (headings + questions)
      init/interview.ts              NEW (Task 7): InitIO, runInterview (one file), the gate loop
      init/git.ts                    NEW (Task 8): gitInit, gitCommit, ghAuthOk, ghRepoCreate — argv arrays, injectable spawn
      init/init.ts                   NEW (Task 8): runInit(opts, io, deps)
      init/main.ts                   NEW (Task 8): the CLI
      bible-check.ts                 NEW (Task 8): the CLI over missingBibleFiles + missingSections
    test/
      templates.test.ts              NEW (Task 4): the harness — render, role line, history scan, cross-references
      fixtures/harbor-check-context.json   NEW (Task 4)
      scaffold.test.ts, interview.test.ts, config.test.ts, git.test.ts, init.test.ts (the end-to-end exercise), bible-check.test.ts
  README.md                          MODIFY (Task 9): "Starting a show" section; the templates in the show-name rule
  docs/plans/2026-10-03-the-new-show-setup-deferred.md   NEW (by the controller, at the end)

~/GitHub/DeadLight/  (Task 10, branch plan-g-bible)
  Canon/world-overview.md, style-guide.md, technology.md, episode-formula.md, visual-style.md   MODIFY: the sections the templates read by name
  prompts/character-check.md         MODIFY: the one line that names a renamed heading
```

---

## Task 1: Per-step template variables — `{{vars.<name>}}`

**Files:**
- Modify: `engine/src/steps.ts` (`AgentStep`, `GateStep`, `GateMessageRenderer`)
- Modify: `engine/src/prompt-template.ts` (`RenderExtra`, `renderPrompt`)
- Modify: `engine/src/agent-step.ts` (`renderExtraFor`, `createGateMessageRenderer`, the executor's two `renderPrompt` calls)
- Modify: `engine/src/runner.ts` (the one `renderGateMessage(...)` call site)
- Modify: `engine/src/pipeline.ts` (`describePipeline` carries `vars` so `pipelineHash` changes when they do)
- Modify: `tools/src/check-prompts.ts` (the context file may carry `vars`)
- Test: `engine/test/prompt-template.test.ts`, `engine/test/agent-step.test.ts`, `engine/test/runner.test.ts`, `tools/test/check-prompts.test.ts`

**Interfaces:**
- Consumes: `renderPrompt(template, ctx, extra)` as it is; `GateMessageRenderer = (file, ctx) => Promise<string>` as it is.
- Produces: `AgentStep.vars?: Record<string, string>`, `GateStep.vars?: Record<string, string>` (and so `NestedAgentStep.vars`); `RenderExtra.vars?: Record<string, string>`; `GateMessageRenderer = (file: string, ctx: RunContext, vars?: Record<string, string>) => Promise<string>`; `{{vars.<name>}}` in any prompt, failing when the step declares no such name. Task 7's pipeline and prompts depend on all of it.

- [ ] **Step 1: Write the failing tests**

In `engine/test/prompt-template.test.ts` add:

```ts
describe("{{vars.<name>}}", () => {
  const ctx = { episodeId: "setup", runId: "r1", showRoot: "/show", results: {} };
  it("renders a declared var", () => {
    expect(renderPrompt("file: {{vars.file}}", ctx, { vars: { file: "Canon/style-guide.md" } })).toBe("file: Canon/style-guide.md");
  });
  it("fails on an undeclared var, naming it", () => {
    expect(() => renderPrompt("{{vars.nope}}", ctx, { vars: { file: "x" } })).toThrow(/\{\{vars\.nope\}\}: no var "nope"/);
  });
  it("fails when the step declares no vars at all", () => {
    expect(() => renderPrompt("{{vars.file}}", ctx, {})).toThrow(/vars are not available/);
  });
  it("fails on a bare {{vars}}", () => {
    expect(() => renderPrompt("{{vars}}", ctx, { vars: {} })).toThrow(/vars needs a name/);
  });
});
```

In `engine/test/agent-step.test.ts` add a test that builds an executor with a fake `query` capturing the prompt, runs an `AgentStep` whose `promptFile` contains `{{vars.file}}` and whose `vars` is `{ file: "Canon/x.md" }`, and asserts the captured prompt contains `Canon/x.md`; and a second test that `createGateMessageRenderer(opts)("gate.md", ctx, { file: "Canon/x.md" })` renders the var.

In `engine/test/runner.test.ts` add a test that a gate with `messageFile` and `vars: { file: "Canon/x.md" }` opens with a message the renderer built from those vars: pass `renderGateMessage: async (file, ctx, vars) => \`${file}:${vars?.file}\`` and assert `result.gate.message === "gate.md:Canon/x.md"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/prompt-template.test.ts test/agent-step.test.ts test/runner.test.ts`
Expected: FAIL — `{{vars.file}}: unknown variable`, and the type errors on `vars`.

- [ ] **Step 3: Implement**

`engine/src/steps.ts` — on `AgentStep`, after `maxBudgetUsd`:

```ts
  /** Values a prompt may render as `{{vars.<name>}}`. They belong to the step, not the run: a
   *  pipeline that runs one prompt file for several targets (the bible interview, which writes
   *  fourteen files with one `write.md`) names the target here rather than in fourteen prompt
   *  files. A prompt that names a var the step does not declare fails to render, like any other
   *  hole. Recorded in `describePipeline`, so a changed var changes the pipeline hash. */
  vars?: Record<string, string>;
```

On `GateStep`, after `maxAttempts`, the same field with the comment "Rendered into `messageFile` as `{{vars.<name>}}` by the gate renderer; see AgentStep.vars." Change `GateMessageRenderer`:

```ts
export type GateMessageRenderer = (file: string, ctx: RunContext, vars?: Record<string, string>) => Promise<string>;
```

`engine/src/prompt-template.ts` — `RenderExtra` gains `vars?: Record<string, string>;` with the comment "The step's own `vars` (steps.ts); `{{vars.<name>}}` fails when the step declared none, or none by that name." In `renderPrompt`, before the `results` branch:

```ts
    if (expr === "vars" || expr.startsWith("vars.")) {
      if (expr === "vars") return fail("vars needs a name");
      if (extra.vars === undefined) return fail("vars are not available");
      const name = expr.slice("vars.".length);
      if (name === "" || name.includes(".")) return fail("malformed var name");
      if (!Object.prototype.hasOwnProperty.call(extra.vars, name)) return fail(`no var ${JSON.stringify(name)}`);
      return extra.vars[name] as string;
    }
```

`engine/src/agent-step.ts` — `renderExtraFor(opts, ctx, vars?: Record<string, string>)` spreads `...(vars !== undefined ? { vars } : {})` into its result; the executor's two `renderPrompt` calls pass `step.vars`; `createGateMessageRenderer` becomes `async (file, ctx, vars) => renderPrompt(loaded.text, ctx, renderExtraFor(opts, ctx, vars))`.

`engine/src/runner.ts` — at the gate's render call, pass `step.vars` as the third argument.

`engine/src/pipeline.ts` — in `describePipeline`, each described agent and gate step carries `vars` when present (sorted keys, so the hash is stable).

`tools/src/check-prompts.ts` — the context file's optional `vars` object (string values) is passed through as `extra.vars`; the README's usage line gains it.

- [ ] **Step 4: Run every suite**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck && cd ../console && npx vitest run && npm run typecheck && cd ../tools && npx vitest run && npm run typecheck`
Expected: PASS. The console's tests pass their own renderer fakes, which take two arguments; a two-argument function is assignable to the three-argument type.

- [ ] **Step 5: Commit**

```bash
git add engine/src/steps.ts engine/src/prompt-template.ts engine/src/agent-step.ts engine/src/runner.ts engine/src/pipeline.ts engine/test tools/src/check-prompts.ts tools/test
git commit -F - <<'EOF'
engine: per-step template variables — {{vars.<name>}}

An agent step or a gate may declare `vars`, rendered into its prompt or
message as {{vars.<name>}}. A var the step did not declare is a hole, like
any other. The gate renderer takes the gate's vars as a third argument.
describePipeline records vars, so the pipeline hash changes with them.
check-prompts accepts `vars` in its context file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 2: `SHOW_CONFIG_KEYS` — every key a show config carries, and a test the scripts cannot drift from

**Files:**
- Modify: `engine/src/show-config.ts`
- Test: `engine/test/show-config.test.ts`

**Interfaces:**
- Produces: `export interface ShowConfigKey { path: string; requiredBy: "engine" | "scripts" | "both" | "none"; default?: unknown; readBy: string }` and `export const SHOW_CONFIG_KEYS: readonly ShowConfigKey[]`. Task 8's `buildShowConfig` and its coverage test consume the list.

- [ ] **Step 1: Write the failing tests**

```ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { SHOW_CONFIG_KEYS } from "../src/show-config.js";

const SCRIPTS = path.resolve(__dirname, "../../scripts");

describe("SHOW_CONFIG_KEYS", () => {
  it("carries the eight required keys as requiredBy engine or both", () => {
    const required = ["showName", "showSlug", "promptsDir", "models.medium", "models.large", "models.writer", "airMap", "output.nasRoot"];
    for (const p of required) {
      const k = SHOW_CONFIG_KEYS.find((k) => k.path === p);
      expect(k, p).toBeDefined();
      expect(["engine", "both"]).toContain(k!.requiredBy);
    }
  });
  it("names every key a script reads through sc.value or sc.path", async () => {
    // The scripts read their config through exactly two accessors (scripts/lib/showconfig.py).
    // Every `sc.value(cfg, "a", "b")` / `sc.path(cfg, "a", "b", root=…)` site names a dotted key;
    // this test refuses a site whose key the list does not carry, so a new script setting cannot
    // be added without a row here — and `init` builds its config from these rows.
    const files = (await readdir(SCRIPTS)).filter((f) => f.endsWith(".py")).map((f) => path.join(SCRIPTS, f));
    files.push(path.join(SCRIPTS, "lib", "showconfig.py"));
    const site = /sc\.(?:value|path)\(\s*cfg\s*,\s*((?:"[^"]+"\s*,?\s*)+)/g;
    const seen = new Set<string>();
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const m of text.matchAll(site)) {
        const dotted = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]).join(".");
        seen.add(dotted);
      }
    }
    expect(seen.size).toBeGreaterThan(40);
    const known = new Set(SHOW_CONFIG_KEYS.map((k) => k.path));
    const missing = [...seen].filter((k) => !known.has(k)).sort();
    expect(missing).toEqual([]);
  });
  it("has no duplicate paths", () => {
    const paths = SHOW_CONFIG_KEYS.map((k) => k.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/show-config.test.ts`
Expected: FAIL — `SHOW_CONFIG_KEYS` is not exported.

- [ ] **Step 3: Implement the list**

In `engine/src/show-config.ts`, after `ShowConfig`:

```ts
/** One key of `showrunner.json`, as a dotted path, with who requires it and the default where one
 *  exists. `requiredBy: "both"` is one of the eight keys both loaders refuse to run without;
 *  `"engine"` and `"scripts"` name a reader that fails by name when the key is absent and no default
 *  applies; `"none"` is a key with a default on every reader. `readBy` names the readers in prose
 *  (a file name, or "engine"), so an author who sees the key in a config can find what it feeds.
 *  `init` writes every key here, and the test beside this file greps every `sc.value`/`sc.path`
 *  site in scripts/ to refuse a key the list does not carry. */
export interface ShowConfigKey { path: string; requiredBy: "engine" | "scripts" | "both" | "none"; default?: unknown; readBy: string }
```

Then `SHOW_CONFIG_KEYS` with **one row per dotted path below**. The implementer fills `requiredBy`, `default` and `readBy` by reading each call site: a `default=` argument at every site of a key means `requiredBy: "none"` with that default; an engine default (the inventory's §1.8 table) is recorded as `default`; a key some site reads with no default is `requiredBy: "scripts"` (or `"both"` for the eight). The paths, measured on 2026-10-03 (`grep -rhoE 'sc\.(value|path)\(\s*cfg,\s*("[^"]+",?\s*)+' scripts/*.py scripts/lib/*.py`), plus the engine's own:

```
showName, showSlug, promptsDir, canonDir, episodesDir, productionDir,
models.small, models.medium, models.large, models.writer,
airMap,
output.nasMount, output.nasRoot, output.finalFilename, output.mixFilename, output.videoFilename,
audio.sampleRate, audio.loudness.i, audio.loudness.tp, audio.loudness.lra, audio.voiceDesignLoudnessI,
audio.roomToneDb, audio.roomToneFundamentalHz, audio.tailOutSeconds, audio.titleCardGapSeconds,
audio.titleCardGapMaxSeconds, audio.sceneTransitionGapSeconds, audio.sceneTransitionGapMaxSeconds,
audio.authoredPauseRangeSeconds, audio.narratorSpeakerKey, audio.mainCast, audio.voiceRefsDir,
audio.guestRefsDir, audio.voiceRegistry,
visual.refs, visual.style, visual.auditLaws, visual.castingPileDir, visual.candidatesDir,
visual.shotFrame, visual.characterKinds, visual.ambientPromptScaffold, visual.styleConstants,
visual.collectivePopulatorBans,
video.fps, video.crossfadeSeconds, video.compositionId,
video.titleCard, video.titleCard.text, video.titleCard.fontFamily, video.titleCard.colors, video.titleCard.fadeSeconds,
publish.channelName, publish.playlistUrl, publish.playlistName, publish.tags, publish.category,
publish.standingCopy.weekly, publish.standingCopy.aiDisclosure, publish.guide
```

`video.compositionId` is `requiredBy: "none"`, `default: "Episode"`, `readBy: "nothing yet (O-03)"`. `audio.titleCardGapSeconds`, `audio.sceneTransitionGapSeconds` and `audio.guestRefsDir` are read by the engine or by a script through a path other than `sc.value` — the implementer finds each reader (`grep -rn "guestRefsDir\|titleCardGapSeconds" scripts/ engine/src/`) and records it; a key no reader names is `requiredBy: "none"` with `readBy: "nothing yet"`.

- [ ] **Step 4: Run and typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/show-config.test.ts && npm run typecheck`
Expected: PASS; the grep test's `seen.size` is printed in the report (around 50).

- [ ] **Step 5: Commit**

```bash
git add engine/src/show-config.ts engine/test/show-config.test.ts
git commit -F - <<'EOF'
engine: SHOW_CONFIG_KEYS — every key a show config carries, with who requires it

One list of the dotted keys the engine and the scripts read, with the
default where one exists and the reader in prose. A test greps every
sc.value/sc.path site in scripts/ and refuses a key the list does not
carry, so the list cannot drift from the scripts; init builds a new
show's config from it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 3: `bible.ts` — the bible's files, the sections prompts read by name, and the `bible-ready` guard

**Files:**
- Create: `engine/src/bible.ts`
- Modify: `engine/src/pipelines/episode.ts` (the guard, between `previous-episode` and `premise`)
- Modify: `engine/src/index.ts` (`export * from "./bible.js"`)
- Test: `engine/test/bible.test.ts`, `engine/test/episode-pipeline.test.ts` (the guard; the fixtures at lines 166, 274 and 298 gain the files the guard requires)

**Interfaces:**
- Produces:
  ```ts
  export type BibleMode = "interview" | "default" | "scaffold";
  export interface BibleFile { key: string; file: string; mode: BibleMode; purpose: string }
  export const BIBLE_FILES: readonly BibleFile[];
  export interface RequiredSection { file: string; heading: string; readBy: string }
  export const REQUIRED_SECTIONS: readonly RequiredSection[];
  export function headingMatches(line: string, heading: string): boolean;
  export function missingBibleFiles(showRoot: string, show: ShowConfig): Promise<string[]>;
  export function missingSections(showRoot: string, show: ShowConfig): Promise<{ file: string; heading: string; readBy: string }[]>;
  ```
  Tasks 5, 7 and 8 consume `BIBLE_FILES` and `REQUIRED_SECTIONS`; Task 4's harness checks the canon templates against `REQUIRED_SECTIONS`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BIBLE_FILES, REQUIRED_SECTIONS, headingMatches, missingBibleFiles, missingSections } from "../src/bible.js";

const show = { showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" }, visual: { style: "Canon/visual-style.md", auditLaws: "Canon/visual-audit-laws.md" }, audio: { voiceRegistry: "Canon/voice-registry.md" }, publish: { guide: "Canon/publishing-guide.md" } } as const;

describe("headingMatches", () => {
  it("matches by prefix after normalising case, '&' and punctuation", () => {
    expect(headingMatches("## The rules of the universe (load-bearing — do not contradict)", "The rules of the universe")).toBe(true);
    expect(headingMatches("## Tone & genre", "Tone and genre")).toBe(true);
    expect(headingMatches('## "Present day" baseline', "Present-day baseline")).toBe(true);
    expect(headingMatches("## Endings — the \"so what?\" test", "Endings")).toBe(true);
  });
  it("needs a level-2 heading", () => {
    expect(headingMatches("### Cadence", "Cadence")).toBe(false);
    expect(headingMatches("Cadence", "Cadence")).toBe(false);
  });
  it("does not match a different heading that shares a word", () => {
    expect(headingMatches("## Cast", "Casting")).toBe(false);
  });
});

describe("BIBLE_FILES and REQUIRED_SECTIONS", () => {
  it("every required section names a bible file", () => {
    const files = new Set(BIBLE_FILES.map((b) => b.file));
    for (const s of REQUIRED_SECTIONS) expect(files.has(s.file) || s.file === "Canon/season-{season}.md", s.file).toBe(true);
  });
  it("keys are unique and are safe path segments", () => {
    const keys = BIBLE_FILES.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("missingBibleFiles / missingSections", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "bible-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("reports every absent and every empty file by path, sorted", async () => {
    await mkdir(path.join(root, "Canon"), { recursive: true });
    await writeFile(path.join(root, "Canon/style-guide.md"), "");
    const missing = await missingBibleFiles(root, show);
    expect(missing).toContain("Canon/style-guide.md (empty)");
    expect(missing).toContain("Canon/world-overview.md");
    expect(missing).toEqual([...missing].sort());
  });
  it("reports a file whose required section is absent, naming the reader", async () => {
    await mkdir(path.join(root, "Canon"), { recursive: true });
    await writeFile(path.join(root, "Canon/style-guide.md"), "# Style\n\n## Narration\ntext\n");
    const missing = await missingSections(root, show);
    const cadence = missing.find((m) => m.file === "Canon/style-guide.md" && m.heading === "Cadence");
    expect(cadence).toBeDefined();
    expect(cadence!.readBy).toMatch(/flow-check/);
  });
  it("is silent about an absent file (that is missingBibleFiles' report)", async () => {
    const missing = await missingSections(root, show);
    expect(missing.filter((m) => m.file === "Canon/world-overview.md")).toEqual([]);
  });
});
```

And in `engine/test/episode-pipeline.test.ts`, a test that an episode pipeline run against a show root whose `Canon/style-guide.md` is absent fails at `bible-ready` with an error matching `/^BIBLE_INCOMPLETE: .*Canon\/style-guide\.md/`, and that the three existing fixtures (lines 166, 274, 298) still reach the steps they assert on once they write every file the guard requires.

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/bible.test.ts test/episode-pipeline.test.ts`
Expected: FAIL — module not found; then the guard not present.

- [ ] **Step 3: Implement `engine/src/bible.ts`**

```ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ShowConfig } from "./show-config.js";

/** How `init` produces a bible file. "interview": an agent writes it from the author's answers and
 *  a gate shows it. "default": the template is a complete file the author keeps, edits or replaces
 *  at its gate — the three files that state the house's craft or the engine's facts rather than
 *  the show's. "scaffold": written with its headings and no gate, because the pipeline fills it. */
export type BibleMode = "interview" | "default" | "scaffold";

export interface BibleFile {
  /** A path-safe key: the template's basename, the log directory's name, the step's var. */
  key: string;
  /** The file, relative to the show root. The season file is named by the season the author starts. */
  file: string;
  mode: BibleMode;
  /** One sentence the interview shows before asking: what the file is for. */
  purpose: string;
}

/** The bible, in interview order — the order an author can think in: the world, then the arc,
 *  then the shape of an episode, then the voice, then the world's rules and history, then the
 *  first season, then the picture, then publishing, then the two house documents. The
 *  continuity ledger and the voice registry are scaffolds: `propose` writes the first and the
 *  NEEDS_REFS stop fills the second. Every `file` here is one the episode pipeline declares or a
 *  prompt reads by name (inventory §1), so `missingBibleFiles` is the pipeline's own list. */
export const BIBLE_FILES: readonly BibleFile[] = [
  { key: "world-overview", file: "Canon/world-overview.md", mode: "interview", purpose: "The premise, the tone, the rules of the world, and who the recurring cast are." },
  { key: "series-arc", file: "Canon/series-arc.md", mode: "interview", purpose: "The long thread under the episodes: what is true, who learns it, and how slowly." },
  { key: "episode-formula", file: "Canon/episode-formula.md", mode: "interview", purpose: "The shape every episode shares: length, beats, what varies, who can die." },
  { key: "story-craft", file: "Canon/story-craft.md", mode: "default", purpose: "The craft rules the structure auditor holds every script to. A house default you may keep or replace." },
  { key: "style-guide", file: "Canon/style-guide.md", mode: "interview", purpose: "The narration's voice: how it sounds, what it never does, and a sample of it." },
  { key: "technology", file: "Canon/technology.md", mode: "interview", purpose: "What is possible in this world and what is not: tools, travel, communication, the environment's rules." },
  { key: "timeline", file: "Canon/timeline.md", mode: "interview", purpose: "The world's history: its eras, the fixed events, and when the present day is." },
  { key: "season-1", file: "Canon/season-1.md", mode: "interview", purpose: "The first season's laws and, if you have it, its slate." },
  { key: "visual-style", file: "Canon/visual-style.md", mode: "interview", purpose: "The look of every frame: palette, composition, the scaffolding every image prompt carries." },
  { key: "visual-audit-laws", file: "Canon/visual-audit-laws.md", mode: "interview", purpose: "The numbered laws the image audit rejects a frame for breaking." },
  { key: "publishing-guide", file: "Canon/publishing-guide.md", mode: "interview", purpose: "How an episode is published: the standing copy, the choices made once, the series structure." },
  { key: "pipeline-artifacts", file: "Canon/pipeline-artifacts.md", mode: "default", purpose: "What the pipeline writes where, and the dialogue-attribution convention the audio step reads. The engine's facts." },
  { key: "readme", file: "Canon/README.md", mode: "default", purpose: "The index of the bible and the rules for writing to it. The house format." },
  { key: "continuity-ledger", file: "Canon/continuity-ledger.md", mode: "scaffold", purpose: "What happened, episode by episode. The pipeline writes it." },
  { key: "voice-registry", file: "Canon/voice-registry.md", mode: "scaffold", purpose: "Prose about the voices; the source of truth is Production/voice-refs/refs.json." },
];

export interface RequiredSection { file: string; heading: string; readBy: string }

/** The level-2 headings a prompt template reads by name (inventory F-09). A file that lacks one
 *  gives that prompt a silent partial read, so `bible-check` refuses it and the canon templates
 *  carry every one. Names match the first show's headings wherever that heading was generic, so
 *  an imported file passes with few renames. `Canon/season-{season}.md` stands for the season
 *  file of the episode being made. */
export const REQUIRED_SECTIONS: readonly RequiredSection[] = [
  { file: "Canon/world-overview.md", heading: "Logline", readBy: "outline.md" },
  { file: "Canon/world-overview.md", heading: "Premise", readBy: "outline.md" },
  { file: "Canon/world-overview.md", heading: "Tone and genre", readBy: "outline.md, tone-check.md" },
  { file: "Canon/world-overview.md", heading: "The rules of the universe", readBy: "outline.md, canon-review-outline.md, canon-review-script.md" },
  { file: "Canon/world-overview.md", heading: "The primary cast", readBy: "character-check.md" },
  { file: "Canon/world-overview.md", heading: "Recurring engine for stories", readBy: "outline.md" },
  { file: "Canon/style-guide.md", heading: "Narration", readBy: "draft.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "The retention contract", readBy: "script-gate.reject.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "Rules of voice", readBy: "draft.md, repetition-check.md" },
  { file: "Canon/style-guide.md", heading: "Cadence", readBy: "flow-check.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "Character voices", readBy: "character-check.md" },
  { file: "Canon/style-guide.md", heading: "Register sample", readBy: "draft.md, tone-check.md (when no script exists yet)" },
  { file: "Canon/episode-formula.md", heading: "Target", readBy: "outline.md, outline-gate.reject.md" },
  { file: "Canon/episode-formula.md", heading: "Beats", readBy: "outline.md, flow-check.md" },
  { file: "Canon/episode-formula.md", heading: "Death rules", readBy: "structure-check.md" },
  { file: "Canon/story-craft.md", heading: "The causality law", readBy: "structure-check.md" },
  { file: "Canon/story-craft.md", heading: "Endings", readBy: "structure-check.md, outline.md" },
  { file: "Canon/technology.md", heading: "Governing principle", readBy: "environment-check.md" },
  { file: "Canon/technology.md", heading: "Environment rules", readBy: "environment-check.md" },
  { file: "Canon/timeline.md", heading: "Eras", readBy: "canon-review-outline.md" },
  { file: "Canon/timeline.md", heading: "Present-day baseline", readBy: "canon-review-outline.md" },
  { file: "Canon/season-{season}.md", heading: "Season laws", readBy: "outline.md, canon-review-outline.md" },
  { file: "Canon/visual-style.md", heading: "The look", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Palette", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Composition rules", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Mandatory prompt scaffolding", readBy: "visual-direction.md" },
  { file: "Canon/publishing-guide.md", heading: "Standing choices", readBy: "publish-copy.md" },
  { file: "Canon/publishing-guide.md", heading: "Series structure", readBy: "publish-copy.md" },
  { file: "Canon/continuity-ledger.md", heading: "Open threads", readBy: "propose.md" },
  { file: "Canon/continuity-ledger.md", heading: "Episode log", readBy: "propose.md" },
  { file: "Canon/pipeline-artifacts.md", heading: "Script dialogue attribution", readBy: "tts-script.md" },
];

const normalise = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** True when `line` is a level-2 heading whose normalised text begins with the normalised
 *  `heading`: case, `&`/"and", quotes, dashes and parentheticals do not count, so
 *  "## The rules of the universe (load-bearing — do not contradict)" carries "The rules of the
 *  universe". A prefix match on whole words: "## Cast" does not carry "Casting". */
export function headingMatches(line: string, heading: string): boolean {
  const m = /^##\s+(.+?)\s*$/.exec(line);
  if (!m) return false;
  const have = normalise(m[1]!);
  const want = normalise(heading);
  return have === want || have.startsWith(want + " ");
}

/** The files the episode pipeline reads from the bible: `BIBLE_FILES` plus the four the config
 *  names (`visual.style`, `visual.auditLaws`, `audio.voiceRegistry`, `publish.guide`) and the
 *  outline template. Each must exist and be non-empty. Returned sorted, `<path>` for an absent
 *  file and `<path> (empty)` for an empty one. The season file is the season of the first
 *  episode — `init` writes season-1 and a later season's file is the author's. */
export async function missingBibleFiles(showRoot: string, show: ShowConfig): Promise<string[]> {
  const canon = show.canonDir ?? "Canon";
  const episodes = show.episodesDir ?? "Episodes";
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
  const files = new Set<string>([
    ...BIBLE_FILES.map((b) => b.file.replace(/^Canon\//, `${canon}/`)),
    str(show.visual?.["style"], `${canon}/visual-style.md`),
    str(show.visual?.["auditLaws"], `${canon}/visual-audit-laws.md`),
    str(show.audio?.["voiceRegistry"], `${canon}/voice-registry.md`),
    str(show.publish?.["guide"], `${canon}/publishing-guide.md`),
    `${episodes}/_TEMPLATE/outline.md`,
  ]);
  const out: string[] = [];
  for (const rel of files) {
    let text: string | undefined;
    try { text = await readFile(path.join(showRoot, rel), "utf8"); } catch { text = undefined; }
    if (text === undefined) out.push(rel);
    else if (text.trim() === "") out.push(`${rel} (empty)`);
  }
  return out.sort();
}

/** Every required section absent from a file that exists. An absent file is not reported here. */
export async function missingSections(showRoot: string, show: ShowConfig, season = 1): Promise<RequiredSection[]> {
  const canon = show.canonDir ?? "Canon";
  const out: RequiredSection[] = [];
  const byFile = new Map<string, RequiredSection[]>();
  for (const s of REQUIRED_SECTIONS) {
    const file = s.file.replace("{season}", String(season)).replace(/^Canon\//, `${canon}/`);
    const list = byFile.get(file) ?? [];
    list.push({ ...s, file });
    byFile.set(file, list);
  }
  for (const [file, sections] of byFile) {
    let text: string;
    try { text = await readFile(path.join(showRoot, file), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (const s of sections) if (!lines.some((l) => headingMatches(l, s.heading))) out.push(s);
  }
  return out;
}
```

- [ ] **Step 4: The guard in `engine/src/pipelines/episode.ts`**

After the `previous-episode` guard and before `premise`; `premise` gains `dependsOn: ["bible-ready"]`:

```ts
    {
      kind: "guard", id: "bible-ready", dependsOn: ["previous-episode"],
      // Inventory F-01: nothing else checks that the bible exists, and a declared input that is
      // absent hashes null and the step runs against nothing. The list is the pipeline's own —
      // every bible file a step below declares — so an author who deletes one in month three gets
      // this message rather than an outline written against nothing. Sections prompts read by
      // name are bible-check's (tools/), not this guard's.
      check: async (ctx) => {
        const missing = await missingBibleFiles(ctx.showRoot, show);
        if (missing.length > 0) return { pass: false, message: `BIBLE_INCOMPLETE: ${missing.join(", ")}` };
        return { pass: true, message: "bible complete" };
      },
    },
```

Add `bible-ready` to `EPISODE_STAGE_MAP` with the stage `previous-episode` maps to (so `validateStageMap` stays satisfied), and update the three fixtures in `engine/test/episode-pipeline.test.ts` to write every file `missingBibleFiles` requires (`visual-audit-laws`, `pipeline-artifacts`, `README`, `season-1` where the id is in season 1, `Episodes/_TEMPLATE/outline.md`) with one non-empty line each. Check `engine/test/ep98-exercise.test.ts` — it runs against the real show, whose bible is complete; the exercise's `airMap` maps `ep98` to no season, so `season-1.md` is not in that run's list (the spine's season file is the same conditional). The `EPISODE_STAGE_MAP` test and `describePipeline` snapshot, if any, gain the step.

- [ ] **Step 5: Run every engine test and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/bible.ts engine/src/index.ts engine/src/pipelines/episode.ts engine/test/bible.test.ts engine/test/episode-pipeline.test.ts
git commit -F - <<'EOF'
engine: the bible's files and sections, and a bible-ready guard

bible.ts names every file the episode pipeline reads from the bible, in
interview order, with how init produces each (interview, default,
scaffold), and the level-2 headings the prompt templates read by name.
The episode pipeline gains a bible-ready guard after previous-episode:
an absent or empty bible file fails the run by name instead of hashing
null and running the write phase against nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 4: The prompt templates, part one — the twenty-one that change only their name, the schemas, the README, and the harness

**Files:**
- Create: `tools/templates/prompts/` — the 5 engine-generic and 16 parameterise prompts listed below, the 8 `.schema.json` files, and `README.md`
- Create: `tools/src/init/paths.ts` (`templatesDir()`)
- Create: `tools/test/fixtures/harbor-check-context.json`
- Test: `tools/test/templates.test.ts` (the harness — it runs against every template that exists, so Tasks 5 and 6 extend what it covers without changing it)

**Interfaces:**
- Consumes: Dead Light's prompts at `~/GitHub/DeadLight/prompts/` (read-only; pinned at `6b157b8`); the inventory's §2.2 table for each file's show-name sites; `REQUIRED_SECTIONS` (Task 3).
- Produces: `templatesDir(): string` (absolute path of `tools/templates`, resolved from `import.meta.url` as `../../templates` — the same depth from `src/init/` and from `dist/init/`); the harness's rules, which Tasks 5 and 6 must satisfy.

**The twenty-one files** (inventory §2.4): `outline-gate.gate.md`, `script-gate.gate.md`, `casting-gate.gate.md`, `final-gate.gate.md`, `canon-gate.gate.md` (engine-generic: copied verbatim); `outline-revise.md`, `flow-check.md`, `structure-check.md`, `revise.md`, `publish-copy.md`, `casting-gate.reject.md`, `audio-gate.gate.md`, `audio-gate.reject.md`, `visual-direction-fix.md`, `nano-banana-gate.gate.md`, `nano-banana-gate.reject.md`, `image-gate.gate.md`, `image-gate.reject.md`, `final-gate.reject.md`, `propose.md`, `canon-gate.reject.md` (parameterise). The eight schemas are copied verbatim (they name no show; the harness checks).

**The rules for a parameterise file:**
1. The role line becomes `You are the <role> for *{{show.showName}}*.` — the role is whatever Dead Light's line says, unchanged. `outline-gate.reject.md`'s role line is its eleventh (Task 6; it is a generalise file).
2. `audio-gate.gate.md:2`'s glob `Production/{{episodeId}}/audio/DeadLight *.wav` becomes `{{show.productionDir}}/{{episodeId}}/audio/*.wav` — the directory, not the slug.
3. An illustrative example that names a character, ship or shot id (`flow-check.md:26`, `nano-banana-gate.gate.md:8`, `nano-banana-gate.reject.md:5`) is rewritten with Harbor Lights' names (Vale, the Warden, Pim; shot ids keep their grammar).
4. `propose.md:42`'s "ep10's pattern" becomes a description of the pattern with no episode named.
5. Every path a prompt names uses the config's directory keys where the engine renders them (`{{show.canonDir}}`, `{{show.episodesDir}}`, `{{show.productionDir}}`) **only where Dead Light's prompt already renders a variable on that line**; a literal `Canon/` in a `Read` instruction stays literal — the pipeline declares those paths with the same literals today, and a half-parameterised set is worse than a consistent one. Recorded for the deferred record.
6. Nothing else changes. The diff between Dead Light's file and the template, with the show name substituted back, is the sites above and nothing more; the implementer's report lists the diff per file.

- [ ] **Step 1: Write the harness, `tools/test/templates.test.ts`**

```ts
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { renderPrompt, TemplateError, REQUIRED_SECTIONS, BIBLE_FILES, headingMatches } from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";

const PROMPTS = path.join(templatesDir(), "prompts");
const CANON = path.join(templatesDir(), "canon");
const INTERVIEW = path.join(templatesDir(), "interview");

async function mdFiles(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".md") && n !== "README.md").sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}

describe("prompt templates render against the invented show", () => {
  it("every prompt renders with no hole, given the Harbor Lights context", async () => {
    const context = JSON.parse(await readFile(path.join(__dirname, "fixtures/harbor-check-context.json"), "utf8"));
    const ctx = { episodeId: context.episodeId, runId: context.runId, showRoot: context.showRoot, results: context.results };
    const failures: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      const isReject = name.endsWith(".reject.md");
      const results = isReject ? { ...context.results, [`${name.replace(/\.reject\.md$/, "")}:rejection`]: "notes" } : context.results;
      try { renderPrompt(text, { ...ctx, results }, { season: context.season, show: context.show }); }
      catch (err) { failures.push(`${name}: ${err instanceof TemplateError ? err.message : String(err)}`); }
    }
    expect(failures).toEqual([]);
  });
  it("every prompt that is not a gate message opens with the role line", async () => {
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      if (name.endsWith(".gate.md")) continue;
      const first = (await readFile(path.join(PROMPTS, name), "utf8")).split("\n")[0] ?? "";
      if (!/^You are the .+ for \*\{\{show\.showName\}\}\*\./.test(first)) bad.push(`${name}: ${first}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("templates carry no history and no show", () => {
  it("no production id, no 2026 date, no 'Ryan', no 'ruled' anywhere under tools/templates", async () => {
    const hits: string[] = [];
    for (const f of await walk(templatesDir())) {
      const text = await readFile(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\bep\d\d\b/.test(line) || /\b2026-/.test(line) || /\bRyan\b/.test(line) || /\bruled\b/i.test(line)) hits.push(`${path.relative(templatesDir(), f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("the canon templates carry every required section, and the prompts read nothing else by name", () => {
  it("each REQUIRED_SECTIONS row has its heading in the canon template for that file", async () => {
    const missing: string[] = [];
    for (const s of REQUIRED_SECTIONS) {
      const key = s.file === "Canon/season-{season}.md" ? "season-1" : BIBLE_FILES.find((b) => b.file === s.file)?.key;
      if (!key) { missing.push(`${s.file}: no BIBLE_FILES entry`); continue; }
      let text: string;
      try { text = await readFile(path.join(CANON, `${key}.md`), "utf8"); } catch { continue; } // Task 5 adds the files
      if (!text.split("\n").some((l) => headingMatches(l, s.heading))) missing.push(`${key}.md lacks ## ${s.heading}`);
    }
    expect(missing).toEqual([]);
  });
  it("every `Canon/<file>` a prompt template names is a bible file or an entity directory", async () => {
    const known = new Set(BIBLE_FILES.map((b) => b.file));
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      for (const m of text.matchAll(/`Canon\/([^`\s]+)`/g)) {
        const rel = `Canon/${m[1]}`;
        if (known.has(rel) || /^Canon\/(characters|species|locations|factions)\//.test(rel) || rel === "Canon/refs.json" || /^Canon\/season-\{\{season\}\}\.md$/.test(rel)) continue;
        bad.push(`${name}: ${rel}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the interview prompts render with vars", () => {
  it("write.md, gate.md and revise.md render given the vars the pipeline passes", async () => {
    const vars = { file: "Canon/style-guide.md", key: "style-guide", purpose: "p", answersPath: "Production/setup/style-guide/answers.md", templatePath: "/engine/tools/templates/canon/style-guide.md", date: "2026-01-01".replace("2026", "2030") };
    const ctx = { episodeId: "setup", runId: "r", showRoot: "/show", results: { "gate:rejection": "notes" } };
    for (const name of await mdFiles(INTERVIEW)) {
      const text = await readFile(path.join(INTERVIEW, name), "utf8");
      expect(() => renderPrompt(text, ctx, { vars, show: { showName: "Harbor Lights" } }), name).not.toThrow();
    }
  });
});
```

The Harbor Lights context file mirrors `tools/show-data/deadlight-check-context.json`'s shape with `scripts/tests/fixtures/showrunner.json` as its `show`, `episodeId: "s01e01"`, `season: 1`, and a `results` object carrying every step id a prompt renders (`{{results.<id>}}`), with Harbor Lights values; the implementer builds the `results` list by grepping the templates for `{{results.` and reading the show's context file for each key's shape.

- [ ] **Step 2: Run to verify the harness fails for want of templates**

Run: `cd ~/GitHub/Showrunner/tools && npx vitest run test/templates.test.ts`
Expected: FAIL — `templatesDir` does not exist.

- [ ] **Step 3: `tools/src/init/paths.ts`, the twenty-one templates, the schemas, the README**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The engine's template root, `tools/templates/`, resolved from this file's own location so the
 *  path is right from `src/init/` under vitest and from `dist/init/` under the built CLI — both
 *  two directories below the workspace root. */
export function templatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}
```

Write the twenty-one `.md` files and the eight `.schema.json` files by the rules above. `tools/templates/prompts/README.md` is Dead Light's `prompts/README.md` reduced to what a new show needs: paragraphs 1–6 (what the directory is, whose asset it is, the naming scheme, the basename-is-the-step-id rule, the template variables **with `{{vars.<name>}}` added**, the every-variable-must-resolve rule) with the show's name replaced by "the show"; the `index.json` paragraphs and the Plan C/D history removed; the two machine-read conventions (`## Cast`, `source`) kept verbatim; the `check-prompts` usage kept; and **a new paragraph stating the role-line convention** (F-26): "Every prompt's first line, gate messages excepted, declares the agent's role and the show: `You are the <role> for *{{show.showName}}*.` A hand-written prompt follows the same line so the set reads as one."

- [ ] **Step 4: Run the harness and the show-name grep**

Run: `cd ~/GitHub/Showrunner/tools && npx vitest run && npm run typecheck && cd .. && grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo|vesk|sethin|elyth|iss-kar|drayman' tools/templates/ ; echo "grep exit $?"`
Expected: PASS; the grep prints nothing and exits 1. The canon-section test passes vacuously until Task 5 (the `continue` on a missing template file).

- [ ] **Step 5: Commit**

```bash
git add tools/templates/prompts tools/src/init/paths.ts tools/test/templates.test.ts tools/test/fixtures/harbor-check-context.json
git commit -F - <<'EOF'
tools: prompt templates, part one — the twenty-one that change only their name

The five engine-generic gate messages, the sixteen prompts whose only
show-specific content is the show's name, the eight schemas and the
prompts README, as generic templates under tools/templates/prompts/.
The role line is a stated convention. A harness renders every template
against the invented show, refuses a leftover hole, and refuses a
production id, a date, or a ruling anywhere under tools/templates/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 5: The bible templates — one per bible file, with its questions — and every scaffold

**Files:**
- Create: `tools/templates/canon/<key>.md` for every `BIBLE_FILES` entry (15 files), `tools/templates/canon/{characters,species,locations,factions}/_TEMPLATE.md`, `tools/templates/episodes/_TEMPLATE/outline.md`, `tools/templates/refs/canon-refs.json`, `tools/templates/refs/voice-refs.json`, `tools/templates/show/README.md`
- Create: `tools/src/init/scaffold.ts`
- Test: `tools/test/scaffold.test.ts`; the harness (Task 4) now covers the canon templates

**Interfaces:**
- Consumes: `BIBLE_FILES`, `REQUIRED_SECTIONS` (Task 3); the inventory's §3.3 table of each Dead Light file's headings; Dead Light's four entity templates, `Episodes/_TEMPLATE/outline.md`, `Canon/README.md`, `Canon/pipeline-artifacts.md`, `Canon/story-craft.md` (read-only).
- Produces:
  ```ts
  export interface Question { heading: string; question: string }
  export function parseCanonTemplate(text: string): { header: string; questions: Question[] };
  export function templateWithoutQuestions(text: string): string;           // the "I will write it myself" artifact
  export function gitignoreFor(config: ShowConfig): string;
  export function writeScaffold(root: string, config: ShowConfig, cast: { name: string; line: string }[]): Promise<string[]>;  // returns the relative paths written
  export function slugOf(name: string): string;                            // "The Warden" → "the-warden"
  ```

**The canon template format.** Each interviewed or default file is a Markdown file whose level-2 headings are the file's sections and whose questions sit in an HTML comment immediately after the heading:

```markdown
# Style guide

> **Status legend.** RULED means approved and binding. DRAFT means proposed at the interview, pending an episode.

## Narration
<!-- Q: Who is telling this story, from where, and in what tense? Describe the narrator's stance in two or three sentences — for Harbor Lights: a lighthouse keeper's log, past tense, that never explains what the keeper did not understand at the time. -->

## The retention contract
<!-- Q: What must the first minute do to keep a viewer? State it as a rule the script gate can refuse a script for breaking. -->
```

`parseCanonTemplate` returns the text before the first `## ` as `header` and one `Question` per heading that has a `<!-- Q: … -->` comment; a heading without one is a section the interview does not ask about (the writer fills it with `_Not yet decided._`). `templateWithoutQuestions` strips the comments and is what "I will write this one myself" writes. **Every `REQUIRED_SECTIONS` heading for the file must be a heading in its template** (the harness checks). The headings per file:

| Template | Headings (in order; `*` = required section) |
|---|---|
| `world-overview.md` | Logline\* · Premise\* · Tone and genre\* · The rules of the universe\* · Structure · The primary cast\* · Recurring engine for stories\* · What makes it distinctive · Open questions |
| `series-arc.md` | The core of the arc · The locked truth (authors only) · Discovery escalation · Pacing rule · Governing principle |
| `episode-formula.md` | Target\* · Beats\* · Per-episode variables · Death rules\* · Serialized thread |
| `story-craft.md` (default) | Dead Light's seven headings, with the content as a filled default: The causality law\* · The circle · Scenes: enter late, leave early · Setup and payoff · Endings\* · Openings · What the structure auditor checks — the two ep99 provenance stamps removed |
| `style-guide.md` | Narration\* · The core technique · Hard staging constraint · The retention contract\* · Rules of voice\* · Cadence\* · Character voices\* · Register sample\* (Q: "Write or paste 150–300 words in the voice you want. A passage, not rules. It is the register's only demonstration until your first script exists.") |
| `technology.md` | Governing principle\* · The tiers · Travel and distance · Communication · Environment rules\* (Q: "What does the environment do to a body and a voice here — what carries sound, what light exists, what a person cannot survive? These are the rules the environment auditor holds every scene to.") · Change log |
| `timeline.md` | Eras\* · Fixed historical events · Present-day baseline\* |
| `season-1.md` | Season laws\* · The slate · Open questions this slate does not decide · Change log — the header carries the RULED/DRAFT legend verbatim from the ruling above |
| `visual-style.md` | The look\* · Palette\* · Composition rules\* · Exposure law · Mandatory prompt scaffolding\* · Prompt vocabulary · The casting registry · Negation law · Recurring visual motifs · Per-episode counts |
| `visual-audit-laws.md` | one `#` heading, then `<!-- Q: List the numbered laws the image audit rejects a frame for breaking — anatomy, scale, species, props, framing. One law per line, numbered. The generator inserts this file whole into the audit prompt. -->` and no `##` headings |
| `publishing-guide.md` | Per-episode, generated · Standing choices\* · The one thing that needs a human · Series structure\* |
| `pipeline-artifacts.md` (default) | Artifact catalog · Folder convention · Script dialogue attribution\* · Storage policy — from Dead Light's file with `## Per-episode STATUS.md` and `## Launching the workflows` removed, the ep10 stamp removed, and the show's name replaced by "the show" |
| `readme.md` (default; written to `Canon/README.md`) | What lives where (the table, generic) · The two-way rule · Episode ids in prose (generic) · Naming · Status vocabulary |
| `continuity-ledger.md` (scaffold) | How to use (one paragraph: the pipeline's `propose` step appends under the headings below after every episode; the author edits what it wrote at the canon gate) · Open threads\* · Resolved · Episode log\* |
| `voice-registry.md` (scaffold) | a header stating that `Production/voice-refs/refs.json` is the source of truth and this file is prose about it; `## Locked` · `## Auditioning` · `## Guest characters` empty |

Every question is written for an author who has never seen a bible, in one or two sentences, with at most one Harbor Lights example. The questions are the interview; write them as the implementer would want to be asked.

**The other scaffolds.** The four entity `_TEMPLATE.md` files are Dead Light's with the one show-naming example (`characters/_TEMPLATE.md:34-35`) rewritten with Harbor Lights' names. `episodes/_TEMPLATE/outline.md` is:

```markdown
# <Episode id> — "<Working title>"

## Scene synopsis
<!-- One paragraph: what happens, in order, in the narrator's register. The outline gate reads this first. -->

## Arc beats
<!-- The series-arc beats this episode pays, each with what it is load-bearing for. -->

## Cast
<!-- One line per character and location, as `- <Name> (<tags>)`, tags from: recurring, guest, speaks, location. The pipeline reads this section by machine: a recurring or guest subject without a reference image, and a speaking character without a voice, stop the run at NEEDS_REFS. -->
- Vale (recurring, speaks)
- Harbor (location)

### Beat 1 — <title>
<!-- One beat per `### Beat <n>` heading. The draft loop measures its progress by counting these. -->

### Beat 2 — <title>

## Ending duties
<!-- What the ending must pay: the "so what", the cost, the serialized thread's next inch. -->

## New canon proposed
<!-- Facts this episode would add to the bible, one per line, for the canon reviewer. -->
```

`refs/canon-refs.json` is `{"_doc": "<one paragraph: one entry per recurring subject; kind is human, creature or ship; ref is the reference image's path under Canon/; identity is the one-line description every prompt carries; locked is true once the image is final>", "_workflow": "<one sentence: scripts/design-visual.py writes candidates under visual.candidatesDir; copy the chosen one to the ref path and add the entry>"}` and `refs/voice-refs.json` is `{"engine": "qwen3", "note": "<one sentence: one entry per speaking recurring character; status must contain LOCKED; scripts/design-voice.py auditions>", "cast": {}}`. `show/README.md` is the show's README with `{{show.showName}}` and `{{show.showSlug}}` as its only variables (rendered by `init`, once, with `renderPrompt`): what the repository is; the layout in one table; **"Your first episode"** (write `Episodes/s01e01/premise.md` — three sentences: what happens, whose episode it is, what it must pay; `Episodes/s01e01/locked-beats.md` is optional and binding; start the console with `node console/dist/server/main.js --show <this directory> --engine-root <engine>` and press Launch; the run stops at `NEEDS_REFS` until every speaking recurring character has a locked voice in `Production/voice-refs/refs.json` and every recurring subject a reference in `Canon/refs.json` — `scripts/design-voice.py` and `scripts/design-visual.py` are how); the `## Cast` grammar and the `source` field, verbatim from the prompts README; and "After editing the bible, run `bible-check --show <this directory>`."

`gitignoreFor(config)` returns, one per line: `.DS_Store`, `<productionDir>/*/audio/`, `<productionDir>/*/video/`, `<productionDir>/*/images/*.png`, `<productionDir>/*/images/*.jpg`, `<productionDir>/*/images/.*.bak`, `<visual.candidatesDir>/`, `Finalized`, `Finalized/`, `.superpowers/` — each directory key read from the config (`productionDir` default `Production`; `visual.candidatesDir` default `Canon/_candidates`).

`writeScaffold(root, config, cast)` writes: the five directories (`Canon/`, `Canon/characters/`, `Canon/species/`, `Canon/locations/`, `Canon/factions/`, `Episodes/_TEMPLATE/`, `Production/voice-refs/`, `prompts/`), the four entity templates, the outline template, the two reference indices, the two scaffold bible files (ledger, voice registry) from their templates stripped of questions, `.gitignore`, `README.md` (rendered), the prompts (every file under `tools/templates/prompts/`), one `Canon/characters/<Name>/<slug>.md` per cast entry from the entity template with the name on its `#` line and the one-liner under its first heading. It never writes a file that exists (`wx`), and returns the relative paths it wrote, sorted.

- [ ] **Step 1: Write the failing tests** (`tools/test/scaffold.test.ts`): `parseCanonTemplate` on a three-heading sample returns the header and two questions (the heading without a comment is skipped); `templateWithoutQuestions` strips every `<!-- Q: … -->` and nothing else; `gitignoreFor` with `productionDir: "Out"` and `visual.candidatesDir: "Canon/_cands"` returns lines containing `Out/*/audio/` and `Canon/_cands/`; `slugOf("The Warden")` is `the-warden`; `writeScaffold` into a temp dir with the fixture config and cast `[{name: "Vale", line: "The keeper."}]` writes `Canon/characters/Vale/vale.md` containing `# Vale` and `The keeper.`, writes `prompts/outline.md`, `README.md` containing `Harbor Lights`, `.gitignore`, `Canon/refs.json` parseable with a `_doc` key, and refuses to overwrite (a second call rejects with `EEXIST`).

- [ ] **Step 2: Run to verify failure.** Run: `cd ~/GitHub/Showrunner/tools && npx vitest run test/scaffold.test.ts`. Expected: FAIL — module not found.

- [ ] **Step 3: Write the templates and `scaffold.ts`.** Every template per the tables above; `scaffold.ts` per the interfaces. `writeScaffold` renders `show/README.md` with `renderPrompt(text, { episodeId: "setup", runId: "init", showRoot: root, results: {} }, { show: config })`.

- [ ] **Step 4: Run the tools suite, the harness, and the grep.** Run: `cd ~/GitHub/Showrunner/tools && npx vitest run && npm run typecheck && cd .. && grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo|vesk|sethin|elyth|iss-kar|drayman' tools/templates/ ; echo "grep exit $?"`. Expected: PASS; the harness's canon-section test now checks every file; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add tools/templates/canon tools/templates/episodes tools/templates/refs tools/templates/show tools/src/init/scaffold.ts tools/test/scaffold.test.ts
git commit -F - <<'EOF'
tools: the bible templates and every scaffold a new show starts with

One template per bible file, its level-2 headings the file's sections
and an HTML comment after each heading the question the interview asks.
Every section a prompt template reads by name is a heading here. The
three house documents are filled defaults. The ledger and the voice
registry are scaffolds. The outline template teaches the format the
outline prompt and the draft loop require. .gitignore is derived from
the config's own directory keys. The show README teaches the first
episode.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 6: The prompt templates, part two — the eleven that generalise and the two that are rewritten

**Files:**
- Create: `tools/templates/prompts/` — `outline.md`, `canon-review-outline.md`, `canon-review-script.md`, `outline-gate.reject.md`, `draft.md`, `tone-check.md`, `character-check.md`, `environment-check.md`, `repetition-check.md`, `script-gate.reject.md`, `image-audit.md` (generalise); `tts-script.md`, `visual-direction.md` (rewrite)
- Test: the harness (Task 4) covers them; the implementer's report carries the per-file diff summary

**Interfaces:**
- Consumes: Dead Light's thirteen prompts (read-only); the inventory's §2.2 rows for each (the sites by line); `REQUIRED_SECTIONS` (the section names the templates read); the canon templates (Task 5) whose questions now carry the laws.

**The rule for a generalise file:** the role line (F-26); every inline law is replaced by an instruction to apply the named section of the named bible file — the section is one in `REQUIRED_SECTIONS` — and the law's text is gone from the prompt; every history site (an episode number, a date, a ruling) is gone; every character or place name in an example becomes Harbor Lights'; the conventions stay verbatim (`## Cast` grammar in `outline.md:68-79`, the provenance rule in both canon reviewers rewritten without its date stamp as "agents adhere to canon; the showrunner overrides it; the ledger records the override", the sentinels, the verdict strings, the `source` field, the "pipeline re-runs" sentences). The register sites (F-05) become the sentence in the ruling. Specifically:

| File | What changes |
|---|---|
| `outline.md` | `:17-18` (the Mute's file) → "Read every sheet under `Canon/characters/`"; `:21`, `:25` → the outline template is the format, `Episodes/*/outline.md` the most recent approved one is the rigor when one exists; `:27` (the 2026-08-23 ruling) → the rule without its stamp; `:60` (vary against ep01) → vary against `Canon/episode-formula.md`'s `## Per-episode variables`; `:74-76` (Dead Light cast examples) → Harbor Lights |
| `canon-review-outline.md`, `canon-review-script.md` | `:7` / `:10`, `:18` (the Mute's file) → every character sheet; `:23` / `:24` the provenance rule without its stamp; `season-{{season}}` kept |
| `outline-gate.reject.md` | `:1-5` the size-discipline preamble → "apply `Canon/episode-formula.md`'s `## Target`"; `:6` (ep09's word count) removed; `:11` the role line moves to line 1 |
| `draft.md` | `:6`, `:18`, `:26` (the ep01 register, the `ep*` glob, ep01's header format) → the F-05 sentence; the title header format is stated in the prompt ("`# <Episode id> — "<Title>"`") |
| `tone-check.md` | `:3` (ep01 as the register made flesh) → the F-05 sentence; `:6-9` (the narrator-never-winks yardstick) → "apply `## Narration` and `## Rules of voice`" |
| `character-check.md` | `:22`, `:25-27` (the crew's dynamics) → "the stances in `## The primary cast` of `Canon/world-overview.md` and the voices in `## Character voices` of `Canon/style-guide.md`" |
| `environment-check.md` | `:20-30` (the vacuum discipline, Opha's EVA shell) → "apply `## Environment rules` of `Canon/technology.md`"; `:21` the example → Harbor Lights |
| `repetition-check.md` | `:8` the glob → `Episodes/*/script.md`; `:36-37` (ep03/ep04) → the rule stated without episodes |
| `script-gate.reject.md` | `:5` reads `## The retention contract` by name (already does); the role line |
| `image-audit.md` | `:6-14` (six laws restated) → "Read `{{show.visual.auditLaws}}`; its numbered laws are the audit. Read `{{show.visual.style}}` for the look." (F-12) |
| `tts-script.md` (rewrite) | the 9 character sites (`:43-48`, `:64-65`, `:144-147`) → the convention stated once with Harbor Lights' names; the 6 history sites (`:63`, `:75`, `:84`, `:115`, `:153`, `:157`) → the rule each teaches, stated without its episode; the 13 tool sites stay; it reads `Canon/pipeline-artifacts.md`'s `## Script dialogue attribution` by name |
| `visual-direction.md` (rewrite) | `:88`, `:95` (the ship) and `:50`, `:84`, `:94` (characters) → Harbor Lights; `:88`'s ruling → the rule; the `source` field and the shot-id grammar (`:97-104`) verbatim; the 7 tool sites stay |

- [ ] **Step 1: Write the thirteen templates** by the table.
- [ ] **Step 2: Run the harness and the grep.** Run: `cd ~/GitHub/Showrunner/tools && npx vitest run && cd .. && grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo|vesk|sethin|elyth|iss-kar|drayman' tools/templates/ ; echo "grep exit $?"`. Expected: PASS; 34 `.md` prompts render; the grep prints nothing. The report lists, per file, the sites changed and the section each law moved to.
- [ ] **Step 3: Commit**

```bash
git add tools/templates/prompts
git commit -F - <<'EOF'
tools: prompt templates, part two — eleven generalised, two rewritten

The eleven prompts that stated one of the first show's laws inline now
apply a named section of the bible file they already read; the law's
text is the author's answer to that section's question. The two
production-specification prompts keep their tool content and lose their
show content. The register is the most recent approved script when one
exists, and the style guide's Register sample before that.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 7: The interview — `bibleFilePipeline`, its three prompts, and the terminal driver

**Files:**
- Create: `engine/src/pipelines/bible.ts`; modify `engine/src/index.ts`
- Create: `tools/templates/interview/write.md`, `gate.md`, `revise.md`
- Create: `tools/src/init/interview.ts`
- Test: `engine/test/pipelines/bible.test.ts`, `tools/test/interview.test.ts`

**Interfaces:**
- Consumes: `vars` (Task 1); `BIBLE_FILES` (Task 3); `parseCanonTemplate`, `templateWithoutQuestions` (Task 5); `run`, `answerGate`, `resumeRun`, `EventLog`, `mintRunId`, `listRuns`, `deriveRunState`, `createAgentExecutor`, `createGateMessageRenderer`, `sdkQuery`, `scriptExecutor` (engine).
- Produces:
  ```ts
  // engine/src/pipelines/bible.ts
  export const SETUP_ID = "setup";
  export function bibleLogDir(showRoot: string, key: string, productionDir?: string): string;   // <root>/<productionDir>/setup/<key>/runs
  export function answersPath(key: string, productionDir?: string): string;                    // <productionDir>/setup/<key>/answers.md (relative)
  export interface BibleFilePipelineOptions { entry: BibleFile; vars: Record<string, string>; productionDir?: string }
  export function bibleFilePipeline(opts: BibleFilePipelineOptions): Pipeline;
  // tools/src/init/interview.ts
  export interface InitIO {
    say(text: string): void;
    ask(question: string, opts?: { multiline?: boolean }): Promise<string>;
    choose<T extends string>(question: string, choices: readonly { key: T; label: string }[]): Promise<T>;
  }
  export type GateChoice = "approve" | "reject" | "myself" | "import";
  export interface InterviewDeps { executors: Executors; renderGateMessage: GateMessageRenderer; now?: () => Date; operator: string }
  export interface InterviewResult { key: string; outcome: "approved" | "written-by-author" | "imported"; runId: string; commits: string[] }
  export function interviewFile(showRoot: string, entry: BibleFile, io: InitIO, deps: InterviewDeps): Promise<InterviewResult>;
  export function isApproved(showRoot: string, entry: BibleFile, productionDir?: string): Promise<boolean>;  // the latest run finished completed
  ```

**The pipeline** (`engine/src/pipelines/bible.ts`):

```ts
import path from "node:path";
import type { BibleFile } from "../bible.js";
import type { NestedAgentStep, Pipeline, Step } from "../steps.js";

const MIN = 60_000;
/** The reserved id the interview runs under. It never matches the episode-id grammar, so
 *  `listEpisodeIds` never lists it and the console never shows it as an episode (Plan H may). */
export const SETUP_ID = "setup";

/** `<productionDir>/setup/<key>/runs` — one log directory per bible file, beside the answers. */
export function bibleLogDir(showRoot: string, key: string, productionDir = "Production"): string {
  return path.join(showRoot, productionDir, SETUP_ID, key, "runs");
}
export function answersPath(key: string, productionDir = "Production"): string {
  return `${productionDir}/${SETUP_ID}/${key}/answers.md`;
}

/** One bible file's pipeline: for an interviewed file, `write` (an agent that turns the author's
 *  answers into the file in the house format) then `gate`; for a default file, `gate` alone over
 *  the template `init` already wrote. The gate's fix agent revises the file against the notes
 *  and the gate reopens; `rerunOnReject` is empty because the fix agent is the whole repair.
 *  `vars` carries the file, its key, its purpose, the answers path, the template path and the
 *  date, so the three prompt files under tools/templates/interview/ serve every file. */
export function bibleFilePipeline(opts: BibleFilePipelineOptions): Pipeline {
  const { entry, vars } = opts;
  const answers = answersPath(entry.key, opts.productionDir);
  const revise: NestedAgentStep = {
    kind: "agent", id: "revise", promptFile: "revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write"],
    context: "fresh", inputs: [entry.file], outputs: [entry.file], timeoutMs: 20 * MIN, vars,
  };
  const steps: Step[] = [];
  if (entry.mode === "interview") {
    steps.push({
      kind: "agent", id: "write", promptFile: "write.md", model: "writer", allowedTools: ["Read", "Write"],
      context: "fresh", inputs: [answers], outputs: [entry.file], timeoutMs: 20 * MIN, vars,
    });
  }
  steps.push({
    kind: "gate", id: "gate", ...(entry.mode === "interview" ? { dependsOn: ["write"] } : {}), messageFile: "gate.md",
    maxAttempts: 10, onReject: revise, rerunOnReject: [], vars,
  });
  return { name: `bible-${entry.key}`, steps };
}
```

**The three prompts.** `write.md`: "You are the bible writer for *{{show.showName}}*. Read `{{vars.answersPath}}` — the author's answers, under the question each answers — and the template at `{{vars.templatePath}}`. Write `{{vars.file}}` in the template's format: its header, then every one of its level-2 headings in order. **The content under each heading is the author's words from the answers, tidied for grammar and nothing more.** You supply structure and the house format; you never supply content. A heading whose question the author left blank gets the single line `_Not yet decided._`. Every rule or law you write ends with `— DRAFT (interview {{vars.date}})`. Do not invent a fact, a name, a number or a date the author did not give. Purpose of this file: {{vars.purpose}}". `gate.md`: "**{{vars.file}}** is ready to review — {{vars.purpose}}. Approve it, reject it with notes for the writer, say you will write it yourself (the empty template is written), or import a file you already have." `revise.md`: "You are the bible writer for *{{show.showName}}*. The author rejected `{{vars.file}}` with these notes:\n\n{{results.gate:rejection}}\n\nRevise the file in place to satisfy the notes, keeping every word of theirs you can and adding none of your own. Keep the format and the headings. Keep the DRAFT stamps."

**The driver** (`tools/src/init/interview.ts`), `interviewFile`:
1. `io.say(purpose)`; for an interviewed entry, parse the canon template, ask each question (`multiline: true`), and write `answers.md` as `## <heading>\n<!-- Q: question -->\n<answer or (blank)>\n` per question (the file is the agent's input and the record). For `world-overview` only, ask one more question after the headings — the cast, one per line as `Name — one line` — parse it, and return it on the result (`cast?: {name, line}[]`) for `init` to write the sheets and `audio.mainCast`. For a default entry, write the template without questions to the file first (`wx`; skip if it exists from a previous attempt).
2. Build `vars`: `{ file, key, purpose, answersPath, templatePath: <absolute path of the canon template>, date: now().toISOString().slice(0,10) }`; `pipeline = bibleFilePipeline({ entry, vars, productionDir })`; `runId = mintRunId()`; `log = new EventLog(path.join(bibleLogDir(...), runId + ".jsonl"))`; `priorLogs` = earlier logs in that directory ascending (`listRuns`-style, by name).
3. `result = await run({ pipeline, ctx: { runId, episodeId: SETUP_ID, showRoot, trigger: deps.operator }, log, executors: deps.executors, priorLogs, renderGateMessage: deps.renderGateMessage })`.
4. While `result.status === "waiting"`: `io.say(result.gate.message)`; print the file's content; `choice = io.choose(…)` over the four choices. `approve` → `answerGate(log, runId, "gate", { approved: true, by, expectedAttempt: result.gate.attempt })`. `reject` → `notes = io.ask("Notes for the writer")`, `answerGate(…{ approved: false, notes, by, expectedAttempt })`. `myself` → write `templateWithoutQuestions(template)` over the file, then approve with `notes: "the author writes this file"`. `import` → `p = io.ask("Path of the file to import")`, resolve it, refuse a path under the show root's `Production/`, copy its bytes over the file, approve with `notes: "imported from <p>"`. Then `await resumeRun(log, runId, by)`; `result = await run({...same...})`. (`run()` returns at once when the gate's answer is already in the log and nothing follows it.)
5. `result.status === "failed"` → throw `Error(\`${entry.key}: ${result.stepId} failed: ${result.error}\`)`. `completed` → return the outcome (`approved` | `written-by-author` | `imported`, from the last choice).
6. `isApproved(showRoot, entry)`: the lexically last `*.jsonl` under `bibleLogDir` derives to `finished && status === "completed"`.

The driver does not commit; `init` commits after each file (Task 8), so the driver is testable without git.

- [ ] **Step 1: Write the failing tests.** `engine/test/pipelines/bible.test.ts`: an interview entry yields two steps `write` → `gate` with `gate.dependsOn === ["write"]`, both carrying `vars`; a default entry yields one gate step with no `dependsOn`; `bibleLogDir("/s", "style-guide")` is `/s/Production/setup/style-guide/runs`; `describePipeline` of each is stable (`pipelineHash` equal across two builds with the same vars, different with different vars). `tools/test/interview.test.ts` with a scripted `InitIO` (answers from an array; choices from an array) and a fake agent executor that writes `# T\n\n## H\nanswer\n` to the file: approve on first gate → `outcome: "approved"`, the log has `run_started`, `step_started`(write), `gate_opened`, `gate_answered`, `run_finished`, and `answers.md` holds the question and the answer; reject then approve → two `gate_opened`, the fix agent ran (`step_started` for `revise`), attempt 2 approved; `myself` → the file equals `templateWithoutQuestions(template)` and the answer's notes say so; `import` of a temp file → the file's bytes equal the import's, and an import path under `<root>/Production` is refused; a default entry → no `write` step, the file exists before the gate; `isApproved` false before and true after.

- [ ] **Step 2: Run to verify failure.** Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/pipelines/bible.test.ts; cd ../tools && npx vitest run test/interview.test.ts`. Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** the pipeline, the three prompts, the driver.

- [ ] **Step 4: Run every suite and the harness.** Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck && cd ../tools && npx vitest run && npm run typecheck`. Expected: PASS; the harness's interview-prompt test renders all three.

- [ ] **Step 5: Commit**

```bash
git add engine/src/pipelines/bible.ts engine/src/index.ts engine/test/pipelines/bible.test.ts tools/templates/interview tools/src/init/interview.ts tools/test/interview.test.ts
git commit -F - <<'EOF'
engine, tools: the bible interview — one pipeline per file, a gate per file

bibleFilePipeline is one bible file's pipeline: an agent that writes the
file from the author's answers in the house format, and a gate with a
fix agent, run under the reserved id "setup" and logged beside the
answers under Production/setup/<key>/runs. The terminal driver asks the
template's questions, runs the pipeline through the real executors, and
answers the gate with approve, reject with notes, "I will write it
myself" or "import this file". The event log is the interview's record.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 8: `init` — the command, the config, git and GitHub, resume and import; and `bible-check`

**Files:**
- Create: `tools/src/init/config.ts`, `tools/src/init/git.ts`, `tools/src/init/init.ts`, `tools/src/init/main.ts`, `tools/src/bible-check.ts`
- Modify: `tools/package.json` (`bin`: `"showrunner-init": "./dist/init/main.js"`, `"bible-check": "./dist/bible-check.js"`)
- Test: `tools/test/config.test.ts`, `tools/test/git.test.ts`, `tools/test/init.test.ts` (the exercise is Task 9's; this task's test covers the pieces), `tools/test/bible-check.test.ts`

**Interfaces:**
- Consumes: `SHOW_CONFIG_KEYS`, `loadShowConfig`, `BIBLE_FILES`, `missingBibleFiles`, `missingSections` (engine); `writeScaffold`, `gitignoreFor`, `slugOf` (Task 5); `interviewFile`, `isApproved`, `InitIO` (Task 7).
- Produces:
  ```ts
  // config.ts
  export interface ShowIdentity { showName: string; showSlug: string; nasRoot: string }
  export function buildShowConfig(id: ShowIdentity, cast: string[]): Record<string, unknown>;  // every SHOW_CONFIG_KEYS path present; airMap {}
  // git.ts — every call spawn(cmd, args); `spawn` injectable for tests
  export interface GitDeps { spawn?: typeof import("node:child_process").spawn }
  export function gitInit(root: string, deps?: GitDeps): Promise<void>;
  export function gitCommit(root: string, message: string, paths: string[], deps?: GitDeps): Promise<string>;  // the commit sha
  export function ghAuthOk(deps?: GitDeps): Promise<boolean>;
  export function ghRepoCreate(root: string, slug: string, visibility: "private" | "public", deps?: GitDeps): Promise<string>;  // the repo URL from gh's output
  // init.ts
  export interface InitOptions { name: string; slug?: string; path: string; nasRoot?: string; github: "private" | "public" | "none"; engineRoot: string; importFrom?: string; resume?: boolean }
  export interface InitDeps { executors?: Executors; renderGateMessage?: GateMessageRenderer; git?: GitDeps; now?: () => Date; operator?: string }
  export interface InitReport { root: string; files: InterviewResult[]; commits: string[]; remote?: string; nextSteps: string }
  export function runInit(opts: InitOptions, io: InitIO, deps?: InitDeps): Promise<InitReport>;
  ```

**`buildShowConfig`** returns the fixture config's shape with the identity filled: `showName`, `showSlug`, `promptsDir: "prompts"`, `canonDir: "Canon"`, `episodesDir: "Episodes"`, `productionDir: "Production"`, the four models as the fixture has them, `airMap: {}`, `output` with `nasRoot`, `nasMount` = its parent directory, the three filename patterns, `audio` with every key (the fixture's numeric values; `mainCast: ["narrator", ...cast]`), `visual` with every key (`styleConstants: "no text, no watermark, no signature."`, `ambientPromptScaffold: []`, `collectivePopulatorBans` = the fixture's three), `video` with every key (`titleCard.text` = the name upper-cased), `publish` with every key (`channelName: "[YOUR NAME]"`, `playlistUrl: ""`, `playlistName: "<name> Season 1"`, `tags: ""`, `category: "Film & Animation"`, the two standing-copy strings as the fixture has them with the show's name substituted, `guide: "Canon/publishing-guide.md"`). A test asserts every `SHOW_CONFIG_KEYS` path resolves to a defined value in the built object (walk the dotted path), that `loadShowConfig` accepts it after writing, and that no string value contains a Dead Light noun.

**`runInit`**:
1. Validate: `name` non-empty; `slug` = given or `name` with non-alphanumerics removed (`Harbor Lights` → `HarborLights`), matching `/^[A-Za-z][A-Za-z0-9]*$/`; `path` resolved; refuse a path that exists and is not an empty directory **unless `resume`**; `nasRoot` default `/Volumes/media/<slug>`; `importFrom` resolved, must be a directory with a `Canon/` inside.
2. Fresh start (not `resume`): `mkdir -p`; write `showrunner.json` from `buildShowConfig(id, [])` (the cast is added after the first interview file); `writeScaffold(root, config, [])`; `gitInit`; `gitCommit(root, "init: <name> — the house layout, the prompts, the scaffolds", ["."])`.
3. Resume: `loadShowConfig(root)`; skip every entry `isApproved` says is done; continue from the first that is not.
4. For each `BIBLE_FILES` entry with mode `interview` or `default`, in order: if `importFrom` is set and `<importFrom>/<entry.file>` exists, `io.say` that an import is available and make `import` the default choice with that path pre-filled (the `InitIO.choose` call receives the choices with `import` first); `r = await interviewFile(...)`; after `world-overview`, if `r.cast` is set: write the cast sheets (`writeScaffold`'s cast part, exposed as `writeCastSheets(root, config, cast)`), rewrite `showrunner.json` with `audio.mainCast`; `gitCommit(root, "canon: <entry.file> — <outcome>", [entry.file, answers, logDir, ...sheets])`.
5. `bible-check`: `missingBibleFiles` + `missingSections(root, config, 1)`; if either is non-empty, `io.say` the list and continue (an author who chose "myself" has files to write — the check is a report, not a refusal).
6. GitHub: if `github !== "none"`: `ghAuthOk()` → `ghRepoCreate(root, slug, github)` → `remote`; else `io.say` the command to run later: `gh repo create <slug> --source <root> --push --<visibility>`.
7. `nextSteps` = the "Your first episode" section of the written `README.md` (read back from disk); `io.say(nextSteps)`; return the report.

**`main.ts`** parses `--name`, `--slug`, `--path`, `--nas-root`, `--github private|public|none`, `--engine-root` (default: two directories above `tools/`), `--import <dir>`, `--resume`; anything missing among `name` and `path` is asked for through the terminal `InitIO` (readline; `multiline` answers end with a line containing only `.`); builds the real deps (`createAgentExecutor({ query: sdkQuery, promptsDir: <templatesDir>/interview, show: config })`, `createGateMessageRenderer` with the same options, `scriptExecutor`); exits 0 on a report, 1 on a thrown error with the message on stderr, 64 on a usage error.

**`bible-check.ts`**: `--show <root>` (and `--season N`, default 1); prints each missing file and each missing section with its reader; exits 0 when clean, 1 otherwise.

- [ ] **Step 1: Write the failing tests.** `config.test.ts` as above. `git.test.ts` with an injected `spawn` recording argv: `gitInit` spawns `["git", "init", "-q"]` with `cwd: root`; `gitCommit` spawns `git add -- <paths>` then `git commit -q -F -` with the message on stdin and the trailer line appended; `ghAuthOk` returns false when `gh auth status` exits 1; `ghRepoCreate` spawns `["gh", "repo", "create", "HarborLights", "--source", root, "--push", "--private"]` and returns the URL line. `bible-check.test.ts`: a temp show with one file missing prints it and exits 1; a complete one exits 0. `init.test.ts`: `runInit` with `github: "none"`, scripted io, a fake executor, and real git in a temp dir: the layout exists, `showrunner.json` loads, every gated file exists, `git log --oneline` has 1 + 13 commits, the report's `files` has 13 entries; a second `runInit` on the same path without `resume` throws naming the directory; with `resume: true` after deleting the last commit's file and its log it re-runs only that file.

- [ ] **Step 2: Run to verify failure.** Run: `cd ~/GitHub/Showrunner/tools && npx vitest run test/config.test.ts test/git.test.ts test/init.test.ts test/bible-check.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Build with `npm run build -w tools` so the bin entries exist.

- [ ] **Step 4: Run the suite, the typecheck, the grep.** Run: `cd ~/GitHub/Showrunner/tools && npx vitest run && npm run typecheck && cd .. && grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public; echo "grep exit $?"`. Expected: PASS; exit 1.

- [ ] **Step 5: Commit**

```bash
git add tools/src/init tools/src/bible-check.ts tools/package.json tools/test
git commit -F - <<'EOF'
tools: init — a show named, laid out, configured, interviewed, committed, and on GitHub

showrunner-init refuses a non-empty directory, writes the house layout,
builds a config carrying every key the engine and the scripts read,
copies the prompt templates, derives .gitignore from the config, commits
the scaffold, interviews the bible one file at a time with one commit
per approved file (resumable; a file may be imported from an existing
show by path), runs bible-check, and creates the GitHub repository with
gh at the end — or prints the command when gh is not signed in.
bible-check reports missing bible files and missing sections by reader.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 9: The exercise — a whole show from `init` to its first `NEEDS_IDEA`, one real interview file, and the documentation

**Files:**
- Test: `tools/test/init-exercise.test.ts`
- Modify: `README.md` (a "Starting a show" section; the show-name rule names `tools/templates/`; the Tools section names `showrunner-init` and `bible-check`)

- [ ] **Step 1: The exercise test.** With `runInit` (scripted io answering every question with one Harbor Lights sentence, approving every gate, `github: "none"`, a fake agent executor that writes each heading with its answer) into a temp directory: (a) `loadShowConfig` accepts the result; (b) `node tools/dist/check-prompts.js --prompts <root>/prompts --context <a context built from the new config>` exits 0; (c) `bible-check --show <root>` exits 0; (d) `episodePipeline({ show, episodeId: "s01e01", engineRoot })` builds, and `run()` with a fake executor passes `previous-episode` and `bible-ready` and fails at `premise` with `NEEDS_IDEA`; (e) after writing `Episodes/s01e01/premise.md`, the run reaches `outline` (the fake executor records it). The test's temp directory is removed in `afterEach`.

- [ ] **Step 2: One real interview file.** The implementer runs the built CLI once against the real SDK: `node tools/dist/init/main.js --name "Harbor Lights" --path <scratch dir> --github none`, answers `world-overview`'s questions with two or three Harbor Lights sentences each, approves at the gate, and stops with Ctrl-C at the second file. The report records the log's `agent_query` and `agent_tool_call` counts, the written file's first thirty lines, and the elapsed time; the scratch directory is deleted. (This is the one agent call this plan spends; it is what tells us the writer honours "the author's words and nothing more".)

- [ ] **Step 3: The README.** A "Starting a show" section after "The console": what `init` does in one paragraph, the command line, the interview's four answers, the import path for an existing show, where the record lives (`Production/setup/`), `bible-check`, and that the registry and the console's surface are Plan H. The show-name rule's sentence lists `tools/templates/` as inside the guarded paths and states the three template checks.

- [ ] **Step 4: Run everything.** Engine, tools, console suites and typechecks; scripts pytest; the grep. Expected: all PASS, grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add tools/test/init-exercise.test.ts README.md
git commit -F - <<'EOF'
tools: the init exercise, one real interview file, and the README

An exercise test runs init end to end for the invented show with a fake
writer, then builds the episode pipeline over the result and reaches
NEEDS_IDEA, then the outline step. README gains "Starting a show".

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 10: Dead Light's bible, prepared for import — the laws that lived only in prompts, the sections the templates read by name

**Repository:** `~/GitHub/DeadLight`, branch `plan-g-bible` cut from `main` at 6b157b8. This task opens its own pull request against DeadLight's `main`. It changes no prompt except the one line below, so Dead Light's current pipeline keeps working.

**Files:**
- Modify: `Canon/world-overview.md`, `Canon/style-guide.md`, `Canon/technology.md`, `Canon/episode-formula.md`, `Canon/visual-style.md`, `Canon/timeline.md`, `Canon/publishing-guide.md`, `Canon/continuity-ledger.md`, `Canon/pipeline-artifacts.md` — only where a required section is absent or a law must move
- Modify: `prompts/character-check.md:14` (the one line that names "The primary crew")

- [ ] **Step 1: Measure.** Run `node ~/GitHub/Showrunner/tools/dist/bible-check.js --show ~/GitHub/DeadLight --season 2` and record its output. Then, for each generalise and rewrite prompt in the inventory's §2.2 table, read the law stated inline and the bible section the template now names (Task 6's table), and decide: already present (cite the line), or missing.

- [ ] **Step 2: Edit.** For each missing section: `## The primary crew` → `## The primary cast` in `world-overview.md` (and `prompts/character-check.md:14` to match); add `## Register sample` to `style-guide.md` holding the cold open of `Episodes/ep01/script.md` (the passage Ryan approved as the register), with a one-line lead-in; add `## Environment rules` to `technology.md` holding the vacuum discipline from `prompts/environment-check.md:20-30`, stamped `(moved from prompts/environment-check.md at Plan G, 2026-10-03)`, pointing at `## Noise & Silence Protocols`; add `## Standing choices`/`## Series structure` only if `bible-check` says `publishing-guide.md` lacks them (its headings are "Standing choices + why" and "Series structure", which match). For each law that lives only in a prompt (Step 1's "missing" rows — expected: `outline-gate.reject.md:1-6`'s size discipline into `episode-formula.md` `## Target`; `repetition-check.md:36-37`'s rule into `style-guide.md` `## Rules of voice`; `visual-direction.md:88`'s ruling into `visual-style.md`; `tts-script.md`'s casting lessons into `voice-registry.md` where absent), append it under the section with the same stamp form. Do not remove anything from a prompt.

- [ ] **Step 3: Verify.** `bible-check --show ~/GitHub/DeadLight --season 2` exits 0. `cd ~/GitHub/Showrunner && node tools/dist/check-prompts.js --prompts ~/GitHub/DeadLight/prompts --context tools/show-data/deadlight-check-context.json` exits 0 (the one prompt edit renders). The Season 2 canon walk in `engine/test/ep98-exercise.test.ts` is not run (it needs the NAS); the Plan D exercise's inputs are unchanged by this task except `Canon/` content, which it hashes.

- [ ] **Step 4: Commit and open the pull request** on DeadLight (`gh pr create --base main --head plan-g-bible`), body ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`:

```bash
git add Canon prompts/character-check.md
git commit -F - <<'EOF'
canon: the sections the engine's templates read by name, and the laws that lived only in prompts

Prepares the bible for import by a fresh instance made with
showrunner-init: The primary crew becomes The primary cast; the style
guide gains a Register sample (ep01's cold open); technology.md gains
Environment rules (the vacuum discipline, moved from
environment-check.md); each law a prompt stated inline and the bible did
not is appended to the section the template now reads, stamped with
where it came from. No prompt loses a line.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## After the tasks: the deferred record, and what this plan does not do

The controller writes `docs/plans/2026-10-03-the-new-show-setup-deferred.md` after the whole-branch review, in the shape of the Plan E record: status, what Plan G established, a Plan H section, a Plan F section, the first-real-use items, and every ruling with its cost if wrong. Items already known to belong there:

- **Plan H (Ryan's ruling, 2026-10-03):** the show registry over `--show` (one server, many shows; O-05) and the console's "New show" surface over `init` (F-25); the interview's runs under `Production/setup/` shown in the console.
- **Plan F:** Dead Light's stale `Episodes/_TEMPLATE/outline.md` and `.gitignore` candidates rule (F-04, F-20); the two `Episodes/ep*/script.md` globs in Dead Light's own prompts (F-05); enforcing `SHOW_CONFIG_KEYS` at load time and refusing unknown top-level groups (F-02, O-02); whether the cutover is an in-place rename or "init a fresh Dead Light instance and import" — Ryan said on 2026-10-02 he will have his instance set up with `init`, so Plan F's inventory on `plan-f` measures a path that may go unused.
- **Closed by this plan:** O-01 (a show may not choose an id grammar); O-03 stays open (`video.compositionId` unread).
- **Not built:** moving `pipeline-artifacts.md`'s engine facts into the engine's README (F-14); parameterising literal `Canon/` paths in prompts with `{{show.canonDir}}` (Task 4's rule 5); an interview for the entity files beyond the cast sheets; a `season-N.md` for a season after the first; packaging `init` for another machine (spec §9.4's "later plan").
- **First real use:** the writer's fidelity to "the author's words and nothing more" over fourteen files (Task 9 measures one); whether ten attempts is the right cap for a bible gate; the terminal's multiline answer ergonomics; `gh repo create` against an account with an existing repository of that name.

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §9.1 (name, repository, local and GitHub, house layout, the engine connected by path) → Task 8 (`runInit`, `git.ts`), Task 5 (the layout and scaffolds); §9.2 (the interview writes the author's words; each file a gate with the engine's gate shape; approve/reject/"I will write it myself") → Task 7 (`bibleFilePipeline`, the three prompts, the driver's four answers — the fourth, import, is Ryan's addition); §9.3 (voices and references cannot be produced; the cast is recorded; `NEEDS_REFS` stops the first episode) → F-24's ruling, Task 5's empty indices, Task 9's exercise; §9.4 (a command-line `init` in the engine; the console's surface later) → Task 8 and the Plan H ruling; §9.5's four questions → F-09, F-07, F-16, F-17 rulings; §0's "the bible must exist before the first episode" → Task 3's guard; §7.4 → the Global Constraints and Task 4's harness; O-04 (the conventions travel with the prompts) → Tasks 4–6 keep them verbatim and Task 5's README teaches them; O-06 (the New-episode form is the first thing `init` teaches) → Task 5's README and Task 8's `nextSteps`.
2. **Placeholder scan.** Tasks 4–6 give rules, per-file site lists and the harness rather than thirty-four verbatim templates; the harness is the acceptance and the implementer's report carries the per-file diff. Task 2's `requiredBy`/`default` columns are measured by the implementer against named call sites, with the test as the check. Nothing says "TBD".
3. **Type consistency.** `BibleFile`, `BIBLE_FILES`, `REQUIRED_SECTIONS`, `headingMatches`, `missingBibleFiles`, `missingSections` (Task 3) are used by Tasks 4, 5, 7, 8; `vars` (Task 1) by Task 7's pipeline and prompts and Task 4's harness; `parseCanonTemplate`, `templateWithoutQuestions`, `writeScaffold`, `gitignoreFor`, `slugOf` (Task 5) by Tasks 7 and 8; `bibleFilePipeline`, `bibleLogDir`, `answersPath`, `SETUP_ID`, `interviewFile`, `isApproved`, `InitIO`, `InterviewResult` (Task 7) by Task 8; `SHOW_CONFIG_KEYS` (Task 2) by Task 8's `buildShowConfig` test; `templatesDir` (Task 4) by Tasks 5, 7, 8.

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-03-the-new-show-setup.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. Task 10 runs in the show repository on its own branch and opens its own pull request; Ryan merges both.
