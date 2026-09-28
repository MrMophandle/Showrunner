# Plan C inventory — what is in the show repository, measured

**Status: this document is an inventory, not a plan.** It was produced on 2026-09-28 by reading
`/Users/ryanperkowski/GitHub/DeadLight` (the show) and `/Users/ryanperkowski/GitHub/Showrunner`
(the engine). Nothing was changed in either repository. Plan C's author reads this document and
writes the plan from it.

**The counts, stated first.** The five Archon workflow files hold **30 agent prompts** and
**9 human-gate messages**. Those 39 blocks reference **27 distinct `$`-variable forms** in
**117 occurrences**; `{{...}}` appears nowhere in the show repository today. `.archon/scripts/`
holds **21 Python scripts**, of which **17 are invoked by a workflow** and **4 are operator tools
no workflow calls**. The proposed show config has **67 keys in nine groups**. Section 9 records
**17 findings**.

**How to read the tables.** Every row names its own file and line. No row depends on the row
above it. A line number written `deadlight-write-episode.yaml:168` is relative to
`/Users/ryanperkowski/GitHub/DeadLight/.archon/workflows/`; a line number written
`audio-mix.py:13` is relative to `/Users/ryanperkowski/GitHub/DeadLight/.archon/scripts/`.
Everything else carries a path from the show root or the engine root, stated in full.

---

## 1 · Every agent node in the five workflows

**There are 30 agent prompts.** They divide into 17 standalone agent nodes, 4 loop bodies, and
9 gate `on_reject` prompts. The 9 gate `approval.message` blocks are listed separately at the end
of this section, because a gate message becomes `GateStep.message` in the engine
(`/Users/ryanperkowski/GitHub/Showrunner/engine/src/steps.ts:100`) and not a file under
`prompts/` — but a gate message carries variables and so is Plan C's work all the same.

Column notes that apply to every row: **"context"** records the YAML's `context: fresh` or a loop's
`fresh_context`, mapping to `AgentStep.context` (`engine/src/steps.ts:75`). **"tools"** records
`allowed_tools`; a blank cell means the YAML declares none and Archon supplied its default, which
Plan C must decide explicitly because the engine requires `allowedTools`
(`engine/src/steps.ts:70`). **"prompt lines"** is the body of the block, excluding the
`prompt: |` line itself.

### 1.1 `deadlight-write-episode.yaml` — 14 agent prompts

| Node id | depends_on | model | context | allowed_tools | output_format `required` | timeout / idle_timeout | when | loop / gate | prompt lines |
|---|---|---|---|---|---|---|---|---|---|
| `outline` (node at :39) | `[setup]` | `"@writer"` | none declared | `[Read, Write, Glob, Grep]` | none | none | none | neither | 44–139 |
| `outline-canon-check` (:142) | `[outline]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; properties `pass` boolean, `verdict` string enum `[OUTLINE PASSED, OUTLINE FAILED]`, `issues` array of string (:147–159) | none | none | neither | 161–180 |
| `outline-revise` (:189) | `[outline-fix-gate]` | `"@writer"` | `fresh_context: false` (:210) | none declared | none | `idle_timeout: 900000` | `"$outline-fix-gate.output == 'no'"` (:191) | loop, `until: OUTLINE_FIXED`, `max_iterations: 2` (:208–209) | 196–207 |
| `outline-gate` `on_reject` (gate at :213, `on_reject` at :228) | gate `depends_on [outline-revise]`, `trigger_rule: all_done` (:215) | none declared; inherits the workflow's `model: "@writer"` (:12) | none declared | none declared | none | none | none | gate reject, `max_attempts: 10` (:256) | 230–248 |
| `draft` (:266) | `[stamp-outline]` | `"@writer"` | `fresh_context: true` (:364) | none declared | none | `idle_timeout: 900000` | none | loop, `until: DRAFT_COMPLETE`, `max_iterations: 15` (:352–353) | 272–351 |
| `continuity-check` (:412) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:417–429) | none | none | neither | 431–451 |
| `tone-check` (:453) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:458–470) | none | none | neither | 472–500 |
| `flow-check` (:502) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:507–519) | none | none | neither | 521–555 |
| `character-check` (:557) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:562–574) | none | none | neither | 576–617 |
| `structure-check` (:619) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:624–636) | none | none | neither | 638–666 |
| `environment-check` (:668) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:673–685) | none | none | neither | 687–728 |
| `repetition-check` (:730) | `[draft-complete-check]` | `medium` | `fresh` | `[Read, Glob, Grep]` | `[pass, issues]`; `verdict` enum `[DRAFT PASSED, DRAFT FAILED]` (:735–747) | none | none | neither | 749–793 |
| `revise` (:814) | `[review-gate]` | `"@writer"` | `fresh_context: false` (:849) | none declared | none | `idle_timeout: 900000` | `"$review-gate.output == 'no'"` (:816) | loop, `until: REVISIONS_COMPLETE`, `max_iterations: 3` (:847–848) | 821–846 |
| `script-gate` `on_reject` (gate at :856, `on_reject` at :872) | gate `depends_on [revise]`, `trigger_rule: all_done` (:858) | none declared; inherits `"@writer"` | none declared | none declared | none | none | none | gate reject, `max_attempts: 10` (:886) | 874–878 |

### 1.2 `deadlight-produce-assets.yaml` — 7 agent prompts

| Node id | depends_on | model | context | allowed_tools | output_format | timeout / idle_timeout | when | loop / gate | prompt lines |
|---|---|---|---|---|---|---|---|---|---|
| `tts-script` (:37) | `[setup]` | `large` | none declared | `[Read, Write, Glob, Grep, Bash]` | none | `idle_timeout: 1800000` | none | neither | 43–224 |
| `casting-gate` `on_reject` (gate at :240, `on_reject` at :252) | gate `depends_on [validate-manifest]` | none declared; inherits the workflow's `model: medium` (:14) | none declared | none declared | none | none | none | gate reject, `max_attempts: 10` (:268) | 254–260 |
| `visual-direction` (:322) | `[audio-gate]` (:332) | `medium` | `fresh` (:334) | `[Read, Write, Glob, Grep]` | none | none | none | neither | 337–460 |
| `nano-banana-gate` `on_reject` (gate at :503, `on_reject` at :519) | gate `depends_on [nano-banana-generate, image-generate]` (:504) | none declared; inherits `medium` | none declared | none declared | none | none | none | gate reject, `max_attempts: 10` (:549) | 521–541 |
| `image-audit` (:552) | `[nano-banana-gate]` | `medium` | `fresh_context: false` (:604) | none declared | none | `idle_timeout: 1800000` | none | loop, `until: IMAGES_CLEAN`, `max_iterations: 3` (:602–603) | 558–601 |
| `audio-gate` `on_reject` (gate at :607, `on_reject` at :616) | gate `depends_on [audio-mix]` | none declared; inherits `medium` | none declared | none declared | none | none | none | gate reject, `max_attempts: 5` (:631) | 618–630 |
| `image-gate` `on_reject` (gate at :641, `on_reject` at :650) | gate `depends_on [image-audit]` | none declared; inherits `medium` | none declared | none declared | none | none | none | gate reject, `max_attempts: 5` (:660) | 652–659 |

### 1.3 `deadlight-canon-update.yaml` — 2 agent prompts

| Node id | depends_on | model | context | allowed_tools | output_format | timeout / idle_timeout | when | loop / gate | prompt lines |
|---|---|---|---|---|---|---|---|---|---|
| `propose` (:41) | `[setup]` | `medium` | none declared | `[Read, Edit, Write, Glob, Grep]` | none | none | none | neither | 46–89 |
| `canon-gate` `on_reject` (gate at :105, `on_reject` at :119) | gate `depends_on [diff]`, gate `when: "$diff.output != 'NO_CHANGES'"` (:107) | none declared; inherits the workflow's `model: medium` (:13) | none declared | none declared | none | none | the gate carries the `when`, not the prompt | gate reject, `max_attempts: 10` (:138) | 121–130 |

### 1.4 `deadlight-season-review.yaml` — 6 agent prompts

| Node id | depends_on | model | context | allowed_tools | output_format | timeout / idle_timeout | when | loop / gate | prompt lines |
|---|---|---|---|---|---|---|---|---|---|
| `thread-auditor` (:44) | `[season-status]` | `medium` | none declared | `[Read, Glob, Grep]` | none | `idle_timeout: 900000` | none | neither | 50–69 |
| `arc-tracker` (:71) | `[season-status]` | `medium` | none declared | `[Read, Glob, Grep]` | none | `idle_timeout: 900000` | none | neither | 77–97 |
| `craft-critic` (:99) | `[season-status]` | `medium` | none declared | `[Read, Glob, Grep]` | none | `idle_timeout: 900000` | none | neither | 105–127 |
| `desk-editor` (:130) | `[thread-auditor, arc-tracker, craft-critic]` | `"@writer"` | none declared | `[Read, Glob, Grep, Write]` | none | `idle_timeout: 1800000` | none | neither | 136–206 |
| `desk-gate` `on_reject` (gate at :209, `on_reject` at :222) | gate `depends_on [desk-editor]` | none declared; inherits the workflow's `model: medium` (:15) | none declared | none declared | none | none | none | gate reject, `max_attempts: 10` (:249) | 224–241 |
| `apply` (:252) | `[desk-gate]` | `large` | none declared | `[Read, Edit, Glob, Grep]` | none | `idle_timeout: 900000` | none | neither | 258–279 |

### 1.5 `deadlight-assemble-episode.yaml` — 1 agent prompt

| Node id | depends_on | model | context | allowed_tools | output_format | timeout / idle_timeout | when | loop / gate | prompt lines |
|---|---|---|---|---|---|---|---|---|---|
| `final-gate` `on_reject` (gate at :63, `on_reject` at :73) | gate `depends_on [master]` | none declared; inherits the workflow's `model: medium` (:11) | none declared | none declared | none | none | none | gate reject, `max_attempts: 2` (:86) | 75–85 |

`deadlight-assemble-episode.yaml` has no standalone agent node at all: every other node in that
file is a bash node.

### 1.6 The nine gate `approval.message` blocks

Each of these becomes `GateStep.message` (`engine/src/steps.ts:100`), a function of `RunContext`
rather than a file under `prompts/`. Each carries variables and so appears again in section 2.

| Workflow file | Gate id | `capture_response` | `max_attempts` | message lines |
|---|---|---|---|---|
| `deadlight-write-episode.yaml` | `outline-gate` (:213) | `true` (:227) | 10 | 218–226 |
| `deadlight-write-episode.yaml` | `script-gate` (:856) | `true` (:871) | 10 | 861–870 |
| `deadlight-produce-assets.yaml` | `casting-gate` (:240) | `true` (:251) | 10 | 244–250 |
| `deadlight-produce-assets.yaml` | `nano-banana-gate` (:503) | `true` (:518) | 10 | 507–517 |
| `deadlight-produce-assets.yaml` | `audio-gate` (:607) | `true` (:615) | 5 | 611–614 |
| `deadlight-produce-assets.yaml` | `image-gate` (:641) | `true` (:649) | 5 | 645–648 |
| `deadlight-canon-update.yaml` | `canon-gate` (:105) | `true` (:118) | 10 | 110–117 |
| `deadlight-season-review.yaml` | `desk-gate` (:209) | `true` (:221) | 10 | 213–220 |
| `deadlight-assemble-episode.yaml` | `final-gate` (:63) | `true` (:72) | 2 | 67–71 |

---

## 2 · Every variable form used inside a prompt or a gate message

**Counts are over prompt bodies and gate-message bodies only, never over bash node bodies.**
A bash node's `$EP`, `$EP_ID`, `$OUT`, `$RC`, `$SID`, `$MSG`, `$WORDS`, `$ALL_PASS` and the like are
shell locals; those bash nodes become `ScriptStep`s or `GuardStep`s and their shell text is
rewritten as argv, not as a template. The counts below total **117 occurrences of 27 distinct
forms**, of which 26 forms appear in prompt or message text and one (`$outline-fix-gate.output`)
appears only in a `when` expression.

Three notational points. First, `$setup.output.` with a trailing period (4 occurrences) is
`$setup.output` followed by an English sentence period, not a field access — Archon's `$a.b.c`
syntax cannot distinguish the two, which is finding F-06. Second, no `{{` or `}}` appears anywhere
in `.archon/workflows/*.yaml`, so there is no pre-existing brace collision to rewrite around.
Third, `${SID#s}`, `${N}`, `${WORDS:-0}` and `${HUM_DB:--42}` are POSIX shell parameter expansions
inside bash nodes (`deadlight-season-review.yaml:27–32`, `deadlight-write-episode.yaml:401`,
`deadlight-produce-assets.yaml:318`) and are not prompt variables.

| Archon form | Occurrences in prompts + gate messages | What it holds today | Proposed `{{...}}` rewrite | Plan C finding? |
|---|---|---|---|---|
| `$setup.output` | 76 (72 plain + 4 followed by a sentence period) | The episode id, printed by each workflow's `setup` bash node (e.g. `deadlight-write-episode.yaml:35`) | `{{episodeId}}` | No |
| `$REJECTION_REASON` | 9 | The showrunner's rejection notes, injected by Archon into an `on_reject` prompt | `{{results.<gate-id>:rejection}}` — nine distinct gate ids, one per site | No |
| `$continuity-check.output` | 2 (`deadlight-write-episode.yaml:826`, `:863`) | The reviewer's JSON verdict object | `{{results.continuity-check}}` | No |
| `$tone-check.output` | 2 (`:827`, `:864`) | The reviewer's JSON verdict object | `{{results.tone-check}}` | No |
| `$flow-check.output` | 2 (`:828`, `:865`) | The reviewer's JSON verdict object | `{{results.flow-check}}` | No |
| `$character-check.output` | 2 (`:829`, `:866`) | The reviewer's JSON verdict object | `{{results.character-check}}` | No |
| `$environment-check.output` | 2 (`:830`, `:867`) | The reviewer's JSON verdict object | `{{results.environment-check}}` | No |
| `$structure-check.output` | 2 (`:831`, `:868`) | The reviewer's JSON verdict object | `{{results.structure-check}}` | No |
| `$repetition-check.output` | 2 (`:832`, `:869`) | The reviewer's JSON verdict object | `{{results.repetition-check}}` | No |
| `$outline-canon-check.output` | 1 (`deadlight-write-episode.yaml:200`) | The auditor's JSON verdict object | `{{results.outline-canon-check}}` | No |
| `$outline-canon-check.output.verdict` | 1 (`deadlight-write-episode.yaml:219`) | The string `OUTLINE PASSED` or `OUTLINE FAILED` | `{{results.outline-canon-check.verdict}}` | **Yes — F-05**: `verdict` is not in the schema's `required` list (`:159`), so the SDK may legally omit it and the render then throws `TemplateError` |
| `$propose.output` | 1 (`deadlight-canon-update.yaml:112`) | The canon librarian agent's final prose text | `{{results.propose}}` | No |
| `$desk-editor.output` | 1 (`deadlight-season-review.yaml:216`) | The desk editor agent's final prose text (the whole desk report) | `{{results.desk-editor}}` | No |
| `$thread-auditor.output` | 1 (`deadlight-season-review.yaml:154`) | A lens agent's final prose text | `{{results.thread-auditor}}` | No |
| `$arc-tracker.output` | 1 (`deadlight-season-review.yaml:155`) | A lens agent's final prose text | `{{results.arc-tracker}}` | No |
| `$craft-critic.output` | 1 (`deadlight-season-review.yaml:156`) | A lens agent's final prose text | `{{results.craft-critic}}` | No |
| `$image-audit.output` | 1 (`deadlight-produce-assets.yaml:646`) | The image-audit **loop**'s final text | `{{results.image-audit}}` | No — `runLoopStep` stores the body's final text as the loop's result (`engine/src/runner.ts:379`) |
| `$ARGUMENTS` | 1 (`deadlight-write-episode.yaml:48`) | The **entire launch message**: the episode id plus the free-text premise | No engine variable exists. Plan D's `setup` step must write the premise into a result; the rewrite is then `{{results.setup.premise}}` or a dedicated key | **Yes — F-01** |
| `$season-status.output` | 1 (`deadlight-season-review.yaml:141`) | The **stdout of a bash node** running `season-status.py` (`:40`) | No engine variable exists: `runScriptStep` returns `{ kind: "completed" }` with no result (`engine/src/runner.ts:268`), so `ctx.results["season-status"]` is never set | **Yes — F-02** |
| `$validate-manifest.output` | 1 (`deadlight-produce-assets.yaml:244`) | Bash-node stdout of `validate-manifest.py` | Same as `$season-status.output` — no script result exists | **Yes — F-02** |
| `$master.output` | 1 (`deadlight-assemble-episode.yaml:68`) | Bash-node stdout of `master-video.py` | Same — no script result exists | **Yes — F-02** |
| `$audio-mix.output` | 1 (`deadlight-produce-assets.yaml:612`) | Bash-node stdout of `audio-mix.py` | Same — no script result exists | **Yes — F-02** |
| `$nano-banana-generate.output` | 1 (`deadlight-produce-assets.yaml:509`) | Bash-node stdout of `nano-banana-generate.py`, including its `NANO_OK`/`NANO_PARTIAL` trailer | Same — no script result exists | **Yes — F-02** |
| `$diff.output` | 1 (`deadlight-canon-update.yaml:115`) | Bash-node stdout: `NO_CHANGES` or a truncated `git diff -- Canon/` | Model the node as a `GuardStep` whose `message` is the diff, then `{{results.diff}}` | **Yes — F-03**: a guard that passes with no message stores `null` (`engine/src/runner.ts:225`), and `renderPrompt` refuses a `null` value (`engine/src/prompt-template.ts:69`) |
| `$review-gate.output` | 1 (`deadlight-write-episode.yaml:862`) | Bash-node stdout: the literal `yes` or `no` | Model as a `GuardStep` message, then `{{results.review-gate}}` | **Yes — F-03** |
| `$desk-gate.output` | 1 (`deadlight-season-review.yaml:262`) | The **showrunner's approval response**, captured because `capture_response: true` (`:221`) — the sentence naming which proposal numbers to enact | The engine stores a gate's answer as the whole `gate_answered` payload (`engine/src/runner.ts:313`, `engine/src/state.ts:96`), so the rewrite is `{{results.desk-gate.notes}}`, not `{{results.desk-gate}}` | **Yes — F-04** |
| `$outline-fix-gate.output` | 0 in prompts (1 in the `when` expression at `deadlight-write-episode.yaml:191`) | Bash-node stdout: `yes` or `no` | Becomes a `when` predicate function reading `ctx.results["outline-fix-gate"]`, not a template variable | **Yes — F-03** |

**The forms that are already unambiguous** are `$setup.output` (an episode id), `$REJECTION_REASON`
(a gate's rejection notes), and the eleven `$<agent-node>.output` / `$<agent-node>.output.<field>`
forms (earlier agent steps' results). **The eight forms that are not** are `$ARGUMENTS`, the five
script-stdout forms, and the three bash-guard forms — those are findings F-01 through F-04.

---

## 3 · The show's name and Dead Light-specific references inside prompts

**The rule Plan C works to: a prompt is show data, so the show's name stays in it; a script in
the engine repository may not contain the name of a show** (spec §7.4,
`/Users/ryanperkowski/GitHub/Showrunner/docs/specs/2026-09-25-console-rewrite-design.md`). Prompts
therefore move **verbatim**, with only the variable rewriting of section 2 applied. The counts
below exist so Plan C can assert afterwards that nothing was lost in the move, not because any of
them must change.

### 3.1 Occurrences of "Dead Light" per prompt (these stay)

| Workflow file | Prompt | "Dead Light" occurrences |
|---|---|---|
| `deadlight-write-episode.yaml` | `outline` (44–139) | 1 |
| `deadlight-write-episode.yaml` | `outline-canon-check` (161–180) | 1 |
| `deadlight-write-episode.yaml` | `outline-revise` (196–207) | 1 |
| `deadlight-write-episode.yaml` | `outline-gate` `on_reject` (230–248) | 1 |
| `deadlight-write-episode.yaml` | `draft` (272–351) | 1 |
| `deadlight-write-episode.yaml` | `continuity-check` (431–451) | 1 |
| `deadlight-write-episode.yaml` | `tone-check` (472–500) | 1 |
| `deadlight-write-episode.yaml` | `flow-check` (521–555) | 1 |
| `deadlight-write-episode.yaml` | `character-check` (576–617) | 1 |
| `deadlight-write-episode.yaml` | `structure-check` (638–666) | 1 |
| `deadlight-write-episode.yaml` | `environment-check` (687–728) | 1 |
| `deadlight-write-episode.yaml` | `repetition-check` (749–793) | 1 |
| `deadlight-write-episode.yaml` | `revise` (821–846) | 1 |
| `deadlight-write-episode.yaml` | `script-gate` `on_reject` (874–878) | 1 |
| `deadlight-produce-assets.yaml` | `tts-script` (43–224) | 1 |
| `deadlight-produce-assets.yaml` | `casting-gate` `on_reject` (254–260) | 1 |
| `deadlight-produce-assets.yaml` | `visual-direction` (337–460) | 3 (one is the ship's name, `THE DEAD LIGHT`, at :424) |
| `deadlight-produce-assets.yaml` | `nano-banana-gate` `on_reject` (521–541) | 1 |
| `deadlight-produce-assets.yaml` | `image-audit` (558–601) | 1 |
| `deadlight-produce-assets.yaml` | `audio-gate` `on_reject` (618–630) | 1 |
| `deadlight-produce-assets.yaml` | `image-gate` `on_reject` (652–659) | 1 |
| `deadlight-canon-update.yaml` | `propose` (46–89) | 1 |
| `deadlight-canon-update.yaml` | `canon-gate` `on_reject` (121–130) | 1 |
| `deadlight-season-review.yaml` | `thread-auditor` (50–69) | 1 (wrapped across lines 50–51, so a single-line grep misses it) |
| `deadlight-season-review.yaml` | `arc-tracker` (77–97) | 1 |
| `deadlight-season-review.yaml` | `craft-critic` (105–127) | 1 |
| `deadlight-season-review.yaml` | `desk-editor` (136–206) | 1 |
| `deadlight-season-review.yaml` | `desk-gate` `on_reject` (224–241) | 0 (the prompt says "the Season Desk editor", not the show's name) |
| `deadlight-season-review.yaml` | `apply` (258–279) | 0 |
| `deadlight-assemble-episode.yaml` | `final-gate` `on_reject` (75–85) | 1 |

Twenty-seven of the thirty prompts name the show exactly once; `visual-direction` names it three
times; the `desk-gate` rejection prompt and the `apply` prompt do not name it at all. The total is
31 mentions. Note that a naive `grep "Dead Light"` undercounts, because the YAML's 72-column
wrapping splits the name across a line break in `deadlight-season-review.yaml:50–51` — the
extraction must match across newlines or it will silently miss occurrences.

Prompts also name characters (Opha, Remo, Sarn, Sable,
Trent, Cricket), canon file paths (`Canon/style-guide.md`, `Canon/season-1.md`,
`Canon/voice-registry.md`, `Canon/visual-style.md`, `Canon/refs.json`) and exemplar episodes
(`Episodes/ep01/script.md`, `Episodes/ep01/outline.md`). **All of that stays in the prompt.**

### 3.2 The one prompt-level season literal that is not merely show data

`deadlight-write-episode.yaml:168` reads `Canon/season-1.md if this episode has a RULED slate
entry`. That line hardcodes Season 1 inside an otherwise season-agnostic prompt, and is item 6 of
the process map's §9 audit
(`/Users/ryanperkowski/GitHub/Showrunner/docs/specs/2026-09-25-pipeline-process-map.md:474`).
`deadlight-season-review.yaml` does the same eleven times over — `Canon/season-1.md` appears in
the three lens prompts (:55, :83, :111), the desk editor's prompt (:158, :175, :182, :201), the
`desk-gate` rejection prompt (:234), the `apply` prompt (:274), and the commit bash node (:284,
:289) — which is why that workflow's `setup` node refuses any season but `s1` outright, naming
that exact reason (`deadlight-season-review.yaml:31–33`). Plan C must
decide whether the season file name becomes a template variable or a show-config-derived string
the prompt receives; section 7 proposes the config key, section 9 records the question as F-07.

### 3.3 Show-specific references inside a **script** (these must move)

Section 4's per-script rows list every one. The summary: **12 of the 21 scripts contain a
show-specific constant**, and `publish-kit.py`, `audio-mix.py`, `build-timeline.py`,
`finalize-video.py`, `season-status.py`, `nano-banana-generate.py`, `validate-manifest.py`,
`image-sheet.py`, `registry-append.py`, `image-generate.py`, `design-visual.py` and `status.py`
each name either the show, a character, a canon path, or a NAS path in source.

---

## 4 · Every Python script in `.archon/scripts/`

**Twenty-one scripts.** Seventeen are invoked from a workflow bash node; four
(`check_layout.py`, `design-visual.py`, `image-qc.py`, `shot-sheet.py`) are operator tools no
workflow calls. Test files (`test_*.py`) are not counted as scripts.

**Argv today is almost never argv.** Fifteen of the twenty-one read the episode id from the
`ARGUMENTS` environment variable rather than from `sys.argv`, because an Archon bash node exports
`ARGUMENTS` for the whole run. Five read `sys.argv` first and fall back to `ARGUMENTS`
(`status.py:36–37`, `check_layout.py:32–33`, `registry-append.py:105–106`,
`nano-banana-generate.py:598–599`, `season-status.py:235–236`); `validate-manifest.py:59–60` and
`image-sheet.py:25` do the same in one expression; `design-voice.py` alone uses `argparse`. The
engine's `ScriptStep.argv` is a real argv array (`engine/src/steps.ts:51`), and `ScriptStep.env`
exists (`:53`), so Plan C can either keep `ARGUMENTS` as an env var or convert every script to
argv. That decision is finding F-08.

**Every shell-out in every script is an argv list. There is no `os.system` and no `shell=True`
anywhere in `.archon/scripts/`.** This was checked across all 21 files; the complete list of
shell-out sites appears in section 4.2.

### 4.1 Per-script inventory

Each row's **"::progress belongs"** column names the exact loop the line goes inside, per spec
§6.7 (`/Users/ryanperkowski/GitHub/Showrunner/docs/specs/2026-09-25-console-rewrite-design.md`).

---

**`tts-generate.py`** — synthesizes one WAV per manifest segment and writes the audio manifest.

- **Invoked by:** `deadlight-produce-assets.yaml:282` (`ARGUMENTS="$EP" uv run .archon/scripts/tts-generate.py`), and re-invoked as a subprocess by `truncation-qc.py:144`, `pace-qc.py:53` and `:71`, and `breath-qc.py:107`.
- **Argv:** none. Reads `ARGUMENTS` (`:67`).
- **Reads:** `Production/<ep>/tts-script.json` (`:71`); each cast entry's `ref` WAV, whose path comes from the manifest (`:37`), which points into `Production/voice-refs/` or `Production/<ep>/guest-refs/`.
- **Writes:** `Production/<ep>/audio/segments/<i:04d>.wav` (`:86`), `Production/<ep>/audio/manifest.json` (`:122`).
- **Show-specific constants:** none. This script is already show-agnostic.
- **Hardcoded model / engine settings:** `SR = 24000` (`:17`), `KOKORO_MODELS = "~/Models/kokoro"` (`:18`), `QWEN3_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"` (`:19`), the default per-segment seed formula `i * 7919 + 13` (`:96`), `lang_code="english"` (`:54`), Kokoro's `lang="en-us"` (`:62`).
- **Main loop:** `for seg in segs:` (`:81`). **`::progress` belongs immediately after the `print(f"[{i}/{len(segs)}] ...")` at `:120`**, as `{"done": position, "total": len(segs), "unit": "segments"}`. The existing `[i/len]` print is per-segment already, so the addition is one line.
- **Idempotent:** yes — `if not os.path.exists(out)` at `:87`, and the docstring states it at `:12`.

---

**`truncation-qc.py`** — detects takes the TTS engine cut off mid-word and re-rolls them.

- **Invoked by:** `deadlight-produce-assets.yaml:293`.
- **Argv:** none. Reads `ARGUMENTS` (`:124`).
- **Reads:** `Production/<ep>/tts-script.json` (`:128`), every `Production/<ep>/audio/segments/<i:04d>.wav` (`:100`).
- **Writes:** `Production/<ep>/tts-script.json` (rewritten with bumped seeds, `:143`); deletes offending segment WAVs (`:120`).
- **Show-specific constants:** none.
- **Hardcoded engine settings:** `THRESHOLD = 0.6`, `TAIL_S = 0.06`, `SPEECH_FLOOR = 0.005`, `PAD_FLOOR = 0.01`, `MIN_PAD_MS = 5.0`, `PASSES = 2`, `RESEED = 104729` (`:46–52`); the `qwen3`-only guard at `:129`.
- **Main loop:** `for rnd in range(1, PASSES + 1)` (`:133`), with an inner scan `for s in doc["segments"]` inside `find_truncated` (`:95`). **`::progress` belongs in the round loop at `:135`**, as `{"done": rnd, "total": PASSES, "unit": "rounds"}`, and optionally a second line in `find_truncated` counting segments scanned.
- **Idempotent:** yes — a second run re-measures and finds nothing to do.

---

**`pace-qc.py`** — re-rolls or time-clamps narrator segments whose words-per-minute is an outlier.

- **Invoked by:** `deadlight-produce-assets.yaml:300`.
- **Argv:** none. Reads `ARGUMENTS` (`:18`).
- **Reads:** `Production/<ep>/tts-script.json` (`:22`), `Production/<ep>/audio/manifest.json` (`:29`, `:58`).
- **Writes:** `Production/<ep>/tts-script.json` (`:51`); deletes outlier WAVs (`:48`); overwrites outlier WAVs via `atempo` (`:66–68`).
- **Show-specific constants:** the literal speaker name `"narrator"` at `:33` — the script assumes a speaker key by that exact name exists.
- **Hardcoded engine settings:** `BAND = 0.15`, `PASSES = 3`, `MIN_WORDS = 15` (`:13–15`), the reseed constant `104729` (`:50`), the clamp targets `0.88` / `1.10` and ratio bounds `0.75`–`1.3` (`:63–64`), `-ar 24000` (`:67`), the `qwen3`-only guard at `:23`.
- **Main loop:** `for rnd in range(1, PASSES + 1)` (`:28`). **`::progress` belongs at `:41`**, beside the existing round print, as `{"done": rnd, "total": PASSES, "unit": "rounds"}`.
- **Idempotent:** partly. The re-roll path is idempotent. The **clamp path at `:66–68` is not**: it rewrites a segment WAV in place with `atempo`, so a crash between the clamp and the manifest refresh at `:71` leaves durations stale, and a re-run over an already-clamped file could clamp again.

---

**`breath-qc.py`** — lengthens model-placed pauses inside narrator runs longer than 8 seconds.

- **Invoked by:** `deadlight-produce-assets.yaml:309`.
- **Argv:** none. Reads `ARGUMENTS` (`:81`).
- **Reads:** `Production/<ep>/tts-script.json` (`:84`), every narrator `Production/<ep>/audio/segments/<i:04d>.wav` (`:91`).
- **Writes:** those same WAVs, in place (`:77`); triggers a manifest refresh by re-running `tts-generate.py` (`:107`).
- **Show-specific constants:** the literal speaker name `"narrator"` at `:87`.
- **Hardcoded engine settings:** `MAX_RUN = 8.0`, `BREATH = 0.20`, `TARGET = 0.42`, `MIN_CANDIDATE = 0.06` (`:27–30`), the six-pass bound at `:58`, the 20 ms frame size at `:33`, the `qwen3`-only guard at `:85`.
- **Main loop:** `for i in sorted(narr)` (`:90`). **`::progress` belongs at `:93`**, as `{"done": position, "total": len(narr), "unit": "segments"}`.
- **Idempotent:** the docstring claims it at `:21`, and the detector genuinely finds nothing on a second pass. But it **mutates WAVs in place** and refreshes the manifest only at the end (`:107`), so a crash mid-run leaves lengthened WAVs with stale manifest durations — the exact failure the comment at `:98–104` says shipped in ep05, ep07 and ep08.

---

**`audio-mix.py`** — concatenates trimmed segments with designed gaps into one loudness-normalized episode WAV.

- **Invoked by:** `deadlight-produce-assets.yaml:318`, with `HUM_DB="${HUM_DB:--42}"` in front of it.
- **Argv:** none. Reads `ARGUMENTS` (`:20`) and the `HUM_DB` env var (`:91`).
- **Reads:** `Production/<ep>/audio/manifest.json` (`:24`), every `Production/<ep>/audio/segments/<i:04d>.wav` (`:33`).
- **Writes:** `Production/<ep>/audio/DeadLight S<ss>E<ee>.wav`, or `episode.wav` when the id is unmapped (`:137`, naming at `:15–17`).
- **Show-specific constants:** **the `AIR` dictionary at `:13`** — ten literal `epNN -> (season, episode)` pairs, Season 1 only; **the output filename template `f"DeadLight S{s:02d}E{e:02d}.wav"` at `:17`**, which embeds the show's name; the room-tone bed's 55 Hz engine fundamental (`:99`) and its fixed RNG seed 42 (`:95`), which are the show's title-card and room-tone conventions spec §7.4 names explicitly.
- **Hardcoded engine settings:** `TARGET = dict(I="-14", TP="-1.5", LRA="11")` (`:109`), the limiter `alimiter=limit=0.5:attack=5:release=60` (`:118`), `-ar 24000` (`:119`, `:137`), `TAIL_OUT_S = 1.0` (`:82`), the title-card envelope's 45 % hold and 2 s fade (`:59–62`) and 1 s ramp-back (`:71`).
- **Main loop:** two passes over `man["segments"]` (`:32` for per-speaker RMS, `:52` for assembly). **`::progress` belongs in the assembly loop at `:52`**, as `{"done": position, "total": len(man["segments"]), "unit": "segments"}`. The two `ffmpeg` calls (`:116`, `:135`) are single long operations with no natural sub-progress.
- **Idempotent:** yes in the sense that matters — it overwrites its single output deterministically from unchanged inputs. It does not skip when the output exists.

---

**`validate-manifest.py`** — the deterministic gate between the `tts-script` agent and synthesis.

- **Invoked by:** `deadlight-produce-assets.yaml:236`.
- **Argv:** `sys.argv[1]` if present, else `ARGUMENTS` (`:59–60`).
- **Reads:** `Production/<ep>/tts-script.json` (`:63`), **`Canon/voice-registry.md`** (`:19`), each cast entry's `ref` WAV for existence (`:102`).
- **Writes:** nothing. Read-only; exits non-zero on a hard failure (`:154`).
- **Show-specific constants:** **`MAINS = {"narrator", "Sarn", "Sable", "Trent", "Opha", "Cricket", "Remo"}` at `:133`** — seven character names in source; the canon path `Canon/voice-registry.md` at `:19`; the heteronym regexes at `:35–41` (`read`/`reads`/`readout`/`separate`/`buffet`) which encode this show's ear findings; the gap ceilings `8.5` for a title card and `4.0` otherwise (`:87`); the authoring-mark grammar `[SPEAKER]`, `[BEAT]`, `[PAUSE n]` at `:85`.
- **Hardcoded engine settings:** the `qwen3` branch at `:98`; the default-seed formula referenced in the comment at `:68`.
- **Main loop:** `for pos, s in enumerate(segs, 1)` (`:73`) and a second pass at `:117`. **`::progress` belongs at `:73`** as `{"done": pos, "total": len(segs), "unit": "segments"}`, though this script runs in seconds and progress is optional by the §6.7 test of "long-running".
- **Idempotent:** yes — read-only.

---

**`image-generate.py`** — renders every ambient shot locally on the GPU.

- **Invoked by:** `deadlight-produce-assets.yaml:471`, and again from two `on_reject` prompts (`:596`, `:656`).
- **Argv:** none. Reads `ARGUMENTS` (`:56`).
- **Reads:** `Production/<ep>/images/prompts.json` (`:60`), **`Canon/refs.json`** (`BIBLE`, `:23`, loaded at `:34`), each locked subject's `ref` PNG.
- **Writes:** `Production/<ep>/images/<shot-id>.png` (`:69`).
- **Show-specific constants:** **`BIBLE = "Canon/refs.json"` at `:23`** — a canon path in source.
- **Hardcoded model / engine settings:** `Z_BINARY = "mflux-generate-z-image-turbo"` (`:21`), `EDIT_BINARY = "mflux-generate-qwen-edit"` (`:22`), `--quantize 8` (`:91`), the default frame size `1024x576` (`:83`), and the binary search path `~/.local/bin` / `~/.bun/bin` (`:27–28`).
- **Main loop:** `for shot in shots` (`:68`). **`::progress` belongs at `:112`**, beside the existing `[{done}/{len(shots)}]` print, as `{"done": done, "total": len(shots), "unit": "shots"}`.
- **Idempotent:** yes — `if os.path.exists(out)` at `:77`, character shots skipped at `:70`.

---

**`nano-banana-generate.py`** — renders every character shot through the Gemini API and vision-audits each frame.

- **Invoked by:** `deadlight-produce-assets.yaml:485` (bare), `:490` (its sheet refresh), and from the `nano-banana-gate` `on_reject` prompt with flags (`:530`).
- **Argv:** `sys.argv[1:]` wins over `ARGUMENTS` (`:598–599`). Accepted form: `<ep> [--only id,id] [--notes text] [--no-audit]` (`:593`, parsed `:604–616`).
- **Reads:** `Production/<ep>/images/prompts.json` (`:469`), **`Canon/refs.json`** (`:55`), each subject's reference sheet and the two newest stills under that sheet's folder (`:60–65`).
- **Writes:** `Production/<ep>/images/<shot-id>.png` (`:520`); `.<shot-id>.png.bak` backups during an `--only` run (`:511`).
- **Show-specific constants:** **`AUDIT_LAWS` at `:295–313`**, which names Remo the Vesk's six limbs, Opha the Sethin's grub scale and translator muzzle-mask, and the shard's canon scale; **`STYLE_CONSTANTS` at `:37–41`**, the show's photographic look; **`_ALWAYS_FAIL_PHRASES` at `:396–400`** and `_COUNT_WORD` / `_NO_ESCAPE` at `:383–387`, the collective-populator law from `Canon/visual-style.md`; the audit prompt's literal `"the sci-fi series Dead Light"` at `:333`; the default bible path `Canon/refs.json` at `:55`.
- **Hardcoded model / engine settings:** `MODEL = "gemini-3-pro-image"` (`:20`), `ASPECT_RATIO = "16:9"` (`:21`), `IMAGE_SIZE = "2K"` (`:22`), `OUTPUT_MIME = "image/jpeg"` (`:27`), `MAX_ATTEMPTS = 3` (`:28`), `MAX_CALLS = 60` (`:29`), `STILLS_PER_SUBJECT = 2` (`:30`), `MAX_IMAGES = 8` (`:31`), the per-call cost estimate `$0.134` (`:577`), the `GEMINI_API_KEY` env var (`:134`, `:139`), and **the audit's own model invocation `["claude", "-p", prompt, "--allowedTools", "Read"]` at `:318` with a 300-second timeout at `:319`**.
- **Main loop:** `for s in shots` (`:518`), with an inner `for attempt in range(1, MAX_ATTEMPTS + 1)` (`:529`). **`::progress` belongs at the top of the shot loop**, as `{"done": index, "total": len(shots), "unit": "shots"}`, with the per-attempt print at `:546` left as an ordinary `script_line`.
- **Idempotent:** yes — `if os.path.exists(out)` at `:521`, the `.bak` protection at `:498–513`, the cost cap's "re-run to continue (idempotent)" message at `:262`, and a `finally` block that restores any outstanding backup at `:571`.

---

**`image-sheet.py`** — regenerates the episode's human-readable shot sheet.

- **Invoked by:** `deadlight-produce-assets.yaml:490` and `:671`.
- **Argv:** `ARGUMENTS` first, `sys.argv[1]` as fallback (`:25`) — note this is the **opposite** precedence from `registry-append.py:105` and `nano-banana-generate.py:598`, which is finding F-08.
- **Reads:** `Production/<ep>/images/prompts.json` (`:29`); probes for each `Production/<ep>/images/<id>.png` (`:31`).
- **Writes:** `Production/<ep>/images/IMAGE-SHEET.md` (`:90`).
- **Show-specific constants:** **the `_PREFIX` regex at `:16`**, which strips the literal ambient-prompt scaffolding `"ducting overhead, "`, `"deep teal-black starfield, "`, `"starfield, "`; **the `_SUFFIX` regex at `:17`**, which strips `"low-key but clearly exposed..."` — both are this show's prompt house style baked into a regex. The sheet body also names `Canon/characters/` (`:56`) and cites `visual-style.md` (`:44`).
- **Hardcoded engine settings:** the names "Nano Banana" (`:42`) and "Z-Image" (`:42`, `:79`).
- **Main loop:** two short list comprehensions (`:33–34`) and two render loops (`:61`, `:85`). This script runs in milliseconds; **no `::progress` line is warranted.**
- **Idempotent:** yes — it rewrites one file deterministically from disk state.

---

**`registry-append.py`** — copies approved character stills into each subject's canon pile.

- **Invoked by:** `deadlight-produce-assets.yaml:669`.
- **Argv:** `sys.argv[1:]` wins over `ARGUMENTS` (`:105–106`). Form: `<ep>`.
- **Reads:** `Production/<ep>/images/prompts.json` (`:112`), **`Canon/refs.json`** (`:111`), each approved `Production/<ep>/images/<id>.png` (`:55`).
- **Writes:** `Canon/characters/<Name>/<ep>-<shot-id>.png` (`:83`); creates a folder when a key has no entry (`:79`).
- **Show-specific constants:** **`characters_root="Canon/characters"` as a default parameter at `:48`**; the hardcoded `Canon/refs.json` at `:111`; **`CHARACTER_KINDS = {"human", "creature", "ship"}` at `:12`**, this show's taxonomy of what counts as a castable subject.
- **Hardcoded engine settings:** none.
- **Main loop:** `for s in doc["shots"]` (`:52`). **`::progress` belongs at `:52`** as `{"done": position, "total": len(doc["shots"]), "unit": "shots"}`, though the script is fast enough that §6.7's test is marginal.
- **Idempotent:** yes — it byte-compares an existing destination and skips an identical file (`:84–87`), and deliberately replaces a differing one with a printed `UPDATED` note (`:93`).

---

**`build-timeline.py`** — turns the audio manifest, shot list and script scene boundaries into a Remotion timeline, and stages assets into `remotion/public/`.

- **Invoked by:** `deadlight-assemble-episode.yaml:45`, and again from the `final-gate` `on_reject` prompt (`:80`).
- **Argv:** none. Reads `ARGUMENTS` (`:14`).
- **Reads:** `Production/<ep>/audio/manifest.json` (`:18`), `Production/<ep>/tts-script.json` (`:19`), `Production/<ep>/images/prompts.json` (`:20`), `Episodes/<ep>/script.md` (`:21`), `Production/<ep>/audio/<mix name>.wav` (`:110`), every `Production/<ep>/images/<id>.png` (`:112`).
- **Writes:** `Production/<ep>/video/timeline.json` (`:100`), `remotion/public/<ep>/audio.wav` (`:110`), `remotion/public/<ep>/images/<id>.png` (`:112`), `remotion/public/<ep>/timeline.json` (`:113`).
- **Show-specific constants:** **the `_AIR` dictionary at `:106`** — a verbatim second copy of `audio-mix.py:13`, with the same trailing comment; **the mix filename template `f"DeadLight S{_s:02d}E{_e:02d}.wav"` at `:109`**; **the hardcoded staging root `remotion/public/<ep>` at `:103`**, which is the engine repository's `render/` directory after the move.
- **Hardcoded engine settings:** `FPS = 30` (`:10`), `CROSSFADE_S = 1.0` (`:11`), the frame size `1024x576` written into the timeline (`:90`), the `+1s tail` padding (`:92`), the title-card fade of `2.0 * FPS` frames (`:30`), the eight-word scene-header probe (`:45`) and its 40-character prefix comparison (`:50`).
- **Main loop:** three passes — segments (`:27`), scene headers (`:43`), shots (`:82`) — plus the staging copy loop at `:111`. **`::progress` belongs at the staging copy loop `:111`**, as `{"done": position, "total": len(prompts["shots"]), "unit": "shots"}`, because that loop copies hundreds of megabytes and is the only part with real wall-clock.
- **Idempotent:** yes — it recomputes and overwrites deterministically.

---

**`master-video.py`** — normalizes the rendered MP4's audio to the broadcast target.

- **Invoked by:** `deadlight-assemble-episode.yaml:59`, and again from the `final-gate` `on_reject` prompt (`:82`).
- **Argv:** none. Reads `ARGUMENTS` (`:42`).
- **Reads:** `Production/<ep>/video/episode.mp4` (`:44`).
- **Writes:** `Production/<ep>/video/episode.mp4` — **the same path, replaced in place** (`:63`).
- **Show-specific constants:** none.
- **Hardcoded engine settings:** `TARGET = dict(I="-14", TP="-1.5", LRA="11")` (`:21`), `-c:a aac -b:a 192k -ar 48000` (`:60`), `-movflags +faststart` (`:61`), `-c:v copy` (`:59`), and the literal source filename `episode.mp4` (`:44`).
- **Main loop:** none — three sequential `ffmpeg` invocations (`:24`, `:32`, `:57`). **`::progress` has no natural home here**; the honest options are a three-step `{"done": n, "total": 3, "unit": "passes"}` or nothing.
- **Idempotent:** **no.** `shutil.move(out, src)` at `:63` replaces the input with the normalized output, so a second run measures an already-normalized file and normalizes it again. This contradicts the restart assumption in spec §6.9 ("every step is idempotent and every script already skips outputs that exist") and is finding F-09.

---

**`finalize-video.py`** — resolves an episode's air slot and copies the mastered MP4 to the NAS.

- **Invoked by:** `deadlight-assemble-episode.yaml:92`.
- **Argv:** none. Reads `ARGUMENTS` (`:135`); accepts an episode id or the literal `all` (`:140`).
- **Reads:** `Production/<ep>/video/episode*.mp4` (`:61`), every `Canon/season-*.md` (`:69`), and it stats the NAS mount (`:56`).
- **Writes:** `<DEST>/DeadLight S<ss>E<ee>.mp4` — by default `/Volumes/media/DeadLight/...` (`:125`, `:129`). **It never writes locally**, by design (`:48–50`).
- **Show-specific constants:** **`SEASON_MAP` at `:33–46`** — seven literal `epNN -> (season, air)` pairs plus three comment entries recording the ep98/ep99 rulings; **`MOUNT = "/Volumes/media"` and `DEST = "/Volumes/media/DeadLight"` at `:51–52`**, each overridable by `DEADLIGHT_FINAL_MOUNT` / `DEADLIGHT_FINAL_DEST`; **the output filename template `f"DeadLight S{s:02d}E{e:02d}.mp4"` at `:124`**; the default production-id scheme `ep{air:02d}` at `:103`; the season file glob `Canon/season-*.md` at `:69`; the RULED-row regex at `:101`.
- **Air-slot resolution, precisely** (`:115`): `SEASON_MAP.get(ep)` first; failing that, `season_slot(ep)` scans every `Canon/season-N.md` for a row matching `^\|\s*(\d+)\s*\|\s*\*\*RULED\*\*\s*\|` (`:101`) whose **default** production id `ep{air:02d}` equals the episode id (`:103`). More than one match across season docs is a hard refusal naming every candidate (`:107–111`). Note the regex here requires **exactly** `**RULED**`, while `season-status.py:34` and `console/server/repo.ts:44` both accept `**RULED<anything>**` — finding F-10.
- **NAS path resolution, precisely:** `ensure_mounted()` at `:54–58` requires both `os.path.ismount(MOUNT)` and `os.path.isdir(DEST)`, and exits with nothing written otherwise. The destination is `os.path.join(DEST, name)` at `:125`.
- **Main loop:** `for ep in eps` inside `sum(...)` at `:141`. **`::progress` belongs there**, as `{"done": n, "total": len(eps), "unit": "episodes"}`. The 800 MB `shutil.copy2` at `:129` has no byte-level progress today.
- **Idempotent:** yes — `:126` skips when the destination exists and is at least as new as the source.

---

**`publish-kit.py`** — writes the per-episode YouTube upload sheet and caption file.

- **Invoked by:** `deadlight-assemble-episode.yaml:106`.
- **Argv:** none. Reads `ARGUMENTS` (`:80`).
- **Reads:** `Production/<ep>/audio/manifest.json` (`:82`), `Production/<ep>/tts-script.json` (`:83`), `Episodes/<ep>/script.md` (`:58`, `:63`).
- **Writes:** `Production/<ep>/publish/upload.md` (`:168`), `Production/<ep>/publish/captions.srt` (`:99`); deletes two stale files (`:170–172`).
- **Show-specific constants:** **`CHANNEL` at `:19–22`** (the credit name, still the placeholder `[YOUR NAME]`, and the playlist URL); **`AIR` at `:23`** — a third verbatim copy of `audio-mix.py:13`; **`LOGLINE` at `:25–48`** — ten multi-paragraph per-episode teasers, the single largest block of show data living in a script; **`TAGS` at `:49`**; the title template `f"Dead Light — {slug}"` at `:89`; the pilot special case at `:88–89`; the standing description copy at `:107` and the AI-disclosure paragraph at `:113`; the playlist name `Dead Light Season 1` at `:133`; the category `Film & Animation` at `:143`; the reference to `Canon/publishing-guide.md` at `:13` and `:118`.
- **Hardcoded engine settings:** none.
- **Main loop:** the caption comprehension at `:97` and the chapter loop at `:72`. This script runs in milliseconds; **no `::progress` line is warranted.**
- **Idempotent:** yes — deterministic rewrite of two files.

---

**`status.py`** — stamps one milestone line into an episode's `STATUS.md`.

- **Invoked by:** six bash nodes — `deadlight-write-episode.yaml:262` and `:892`, `deadlight-produce-assets.yaml:274`, `:637` and `:672`, `deadlight-assemble-episode.yaml:99`.
- **Argv:** `sys.argv[1:]` wins over `ARGUMENTS` (`:36–37`). Form: `<ep> <milestone> [detail...]`.
- **Reads:** `Episodes/<ep>/STATUS.md` if it exists (`:16`).
- **Writes:** `Episodes/<ep>/STATUS.md` (`:28`).
- **Show-specific constants:** **`MILESTONES` at `:11–12`** — the nine-name vocabulary `beats, outline, script, canon, casting, audio, images, assembled, finalized`. Spec §3 calls this "the milestone vocabulary", and the process map §9 item 7 records that two of the nine (`canon`, `assembled`) are declared but never stamped by any workflow.
- **Hardcoded engine settings:** none.
- **Main loop:** the in-place line scan at `:21`. **No `::progress` line is warranted.**
- **Idempotent:** yes, explicitly — a milestone line is updated in place, never duplicated (`:21–26`).

---

**`season-status.py`** — the Season Desk's deterministic board.

- **Invoked by:** `deadlight-season-review.yaml:40` (bare, no argument), and by the console's board surface.
- **Argv:** `sys.argv[1:]` wins over `ARGUMENTS` (`:235–236`). Recognized tokens: an `sN` season selector and `--json` (`:237–238`).
- **Reads:** `Canon/season-<N>.md` (`:136`), **`.archon/scripts/finalize-video.py` as text** (`:144`), `Episodes/<prod>/STATUS.md` (`:175`), `Production/<prod>/images/prompts.json` (`:61`), each `Production/<prod>/images/<id>.png` (`:73`), and the NAS directory (`:149`, `:177`).
- **Writes:** nothing. Read-only, exit 0 either way (`:10`).
- **Show-specific constants:** **`MILESTONES` at `:18–19`** — a second copy of `status.py:11–12`; **`DRAFTING_MARKERS = ("STATUS.md", "outline.md", "script.md")` at `:88`**; **the NAS default `/Volumes/media/DeadLight` at `:130`**; **the NAS filename template `f"DeadLight S{season:02d}E{air:02d}.mp4"` at `:177`**; the default production-id scheme `ep{air:02d}` at `:53`; the season file name `Canon/season-{season}.md` at `:132`; `STATE_ENUM`'s five human strings at `:105–109`; `_next_action`'s workflow names at `:96–102`.
- **Hardcoded engine settings:** none.
- **Main loop:** `for row in season_rows` (`:157`). **`::progress` belongs there** only if the board ever grows slow; today it is sub-second and no line is warranted.
- **Idempotent:** yes — read-only.

---

**`design-voice.py`** — invents candidate guest voices from a prose description.

- **Invoked by:** the `tts-script` prompt instructs the agent to run it via Bash (`deadlight-produce-assets.yaml:176–178`). No bash node calls it.
- **Argv:** `argparse` — `--instruct`, `--text`, `--out`, `--candidates` (`:21–25`). The only script in the directory with a real CLI.
- **Reads:** nothing on disk.
- **Writes:** `<out>-1.wav` … `<out>-N.wav` (`:33`), which the prompt directs to `Production/<ep>/guest-refs/<name>` (`deadlight-produce-assets.yaml:178`).
- **Show-specific constants:** none.
- **Hardcoded model / engine settings:** `SR = 24000` (`:17`), `MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"` (`:18`), `language="english"` (`:31`), the normalization target `loudnorm=I=-16:TP=-1.5` (`:37`) — note this is **-16**, deliberately different from the -14 used by `audio-mix.py:109` and `master-video.py:21`.
- **Main loop:** `for n in range(1, a.candidates + 1)` (`:30`). **`::progress` belongs at `:39`**, as `{"done": n, "total": a.candidates, "unit": "candidates"}`.
- **Idempotent:** **no** — every run generates fresh non-deterministic candidates and overwrites the previous ones. The docstring states the non-determinism at `:5–6`.

---

**`check_layout.py`** — audits episode folders against `Canon/pipeline-artifacts.md`. **No workflow invokes it.**

- **Argv:** `sys.argv[1:]` wins over `ARGUMENTS` (`:32–33`); default is every `Episodes/ep*` directory (`:34`).
- **Reads:** `Episodes/<ep>/STATUS.md` (`:19`), probes `Production/<ep>/{script,outline,locked-beats}.md` (`:22–24`).
- **Writes:** nothing.
- **Show-specific constants:** **`SOURCE_ONLY = ("script.md", "outline.md", "locked-beats.md")` at `:12`**; the `Episodes/ep*` glob at `:34`, which encodes the `epNN` id scheme.
- **Main loop:** `for ep in eps` (`:37`). No `::progress` warranted.
- **Idempotent:** yes — read-only.

---

**`design-visual.py`** — generates baseline candidate images for a visual-bible subject. **No workflow invokes it.**

- **Argv:** none. Reads `ARGUMENTS` (`:50`): a subject key or `all`, plus an optional count.
- **Reads:** **`Canon/refs.json`** (`:31`, loaded `:56`).
- **Writes:** `Canon/_candidates/<key>-<n>.png` (`:74`).
- **Show-specific constants:** **`BIBLE = "Canon/refs.json"` at `:31`**, **`CAND_DIR = "Canon/_candidates"` at `:32`**, and the lock instruction naming `Canon/characters/<key>.png` at `:79–80`.
- **Hardcoded model / engine settings:** `QWEN_BINARY = "mflux-generate-qwen"` (`:30`), `--quantize 8 --steps 30 --guidance 3.5` (`:44`), `1024x576` (`:46`), the deterministic per-subject seed derivation at `:72` and its `+ i * 137` stride at `:77`.
- **Main loop:** `for subj in subjects` (`:66`) with inner `for i in range(1, n + 1)` (`:73`). **`::progress` belongs at `:78`**, as `{"done": index, "total": len(subjects) * n, "unit": "candidates"}`.
- **Idempotent:** **no** — it deletes an existing candidate before regenerating (`:75–76`), and the generator is non-deterministic across model versions.

---

**`image-qc.py`** — an advisory exposure screen over an episode's PNGs. **No workflow invokes it**, and its own docstring says it is not the real gate (`:6–7`).

- **Argv:** none. Reads `ARGUMENTS` (`:46`).
- **Reads:** every `Production/<ep>/images/*.png` (`:49`).
- **Writes:** nothing.
- **Show-specific constants:** the calibration story in the docstring names the show's cast (`:20–21`), but the code itself has none.
- **Hardcoded engine settings:** `MEAN_MIN = 10.0`, `MID_MIN = 1.0`, `ADVISE_MID = 5.0` (`:33–35`), the luma bucket boundaries at `:41–43`.
- **Main loop:** the comprehension at `:53`. **`::progress` belongs there** if it is ever put back in a pipeline.
- **Idempotent:** yes — read-only.

---

**`shot-sheet.py`** — a showrunner's reading of when each still lands in the episode. **No workflow invokes it.**

- **Argv:** none. Reads `ARGUMENTS` (`:34`).
- **Reads:** `Production/<ep>/audio/manifest.json`, `Production/<ep>/tts-script.json`, `Production/<ep>/images/prompts.json`, `Episodes/<ep>/script.md` — all four asserted present at `:38–41`.
- **Writes:** `Production/<ep>/images/SHOT-SHEET.md` (`:14`).
- **Show-specific constants:** none in code; it duplicates `build-timeline.py`'s placement maths deliberately (`:9–12`).
- **Hardcoded engine settings:** `FPS = 30` (`:20`), `CROSSFADE_S = 1.0` (`:21`) — a fourth and fifth copy of the same two numbers.
- **Main loop:** the scene/shot walk mirroring `build-timeline.py`. No `::progress` warranted; it is sub-second.
- **Idempotent:** yes — deterministic rewrite of one file.

---

### 4.2 Every shell-out, and its form

**All twelve sites pass an argv list. None uses a shell string, `shell=True`, or `os.system`.**

| Site | Command | Form |
|---|---|---|
| `tts-generate.py:108` | `ffmpeg` (apply an fx chain to one segment) | argv list |
| `truncation-qc.py:144` | `["uv", "run", ".archon/scripts/tts-generate.py"]` with `env=dict(os.environ, ARGUMENTS=ep)` | argv list |
| `pace-qc.py:53` | `["uv", "run", ".archon/scripts/tts-generate.py"]` | argv list |
| `pace-qc.py:66` | `ffmpeg` (`atempo` clamp) | argv list |
| `pace-qc.py:71` | `["uv", "run", ".archon/scripts/tts-generate.py"]` (manifest refresh) | argv list |
| `breath-qc.py:107` | `["uv", "run", ".archon/scripts/tts-generate.py"]` (manifest refresh) | argv list |
| `audio-mix.py:116` | `ffmpeg` (`alimiter` peak tame) | argv list |
| `audio-mix.py:123` | `ffmpeg` (`loudnorm` measure pass) | argv list |
| `audio-mix.py:135` | `ffmpeg` (`loudnorm` apply pass) | argv list |
| `master-video.py:24` | `ffmpeg` (`loudnorm` measure) | argv list |
| `master-video.py:32` | `ffmpeg` (`ebur128` report) | argv list |
| `master-video.py:57` | `ffmpeg` (apply, stream-copy video) | argv list |
| `image-generate.py:110` | `mflux-generate-z-image-turbo` or `mflux-generate-qwen-edit` | argv list |
| `design-visual.py:44` | `mflux-generate-qwen` | argv list |
| `design-voice.py:36` | `ffmpeg` (`loudnorm=I=-16`) | argv list |
| `nano-banana-generate.py:317` | `["claude", "-p", prompt, "--allowedTools", "Read"]` | argv list |

**Four scripts re-invoke `tts-generate.py` as a child process** (`truncation-qc.py:144`,
`pace-qc.py:53`, `pace-qc.py:71`, `breath-qc.py:107`). Under the engine, each of those is a
`ScriptStep` spawning another `ScriptStep`'s script outside the engine's knowledge: the child's
stdout is swallowed by `stdout=subprocess.DEVNULL` in all four cases, its process group is not in
`liveProcessGroups()`, and its `::progress` lines would never reach the log. That is finding F-11.

---

## 5 · The Remotion project

The Remotion project lives at `/Users/ryanperkowski/GitHub/DeadLight/remotion/` and becomes
`render/` in the engine repository (spec §7.4). It is three source files plus a `public/`
directory holding staged per-episode assets for twelve production ids (`ep01`–`ep10`, `ep98`,
`ep99`).

### 5.1 Show-specific assets and constants

| Item | Value | Location | Kind |
|---|---|---|---|
| Title card text | the literal string `DEAD LIGHT` | `remotion/src/Episode.tsx:66` | **show data — must be re-homed** |
| Title card font | `Georgia, 'Times New Roman', serif` | `remotion/src/Episode.tsx:58` | show style |
| Title card size / tracking | `fontSize: 64`, `letterSpacing: "0.45em"`, `textIndent: "0.45em"`, `fontWeight: 400` | `remotion/src/Episode.tsx:59–62` | show style |
| Title card colours | background `#000504`, type `#b8d4d0`, glow `rgba(96, 160, 152, 0.25)` | `remotion/src/Episode.tsx:49`, `:57`, `:63` | show style |
| Letterbox / stage colour | `#04100f` | `remotion/src/Episode.tsx:106`, `:124`, `:127` | show style |
| Title card fade-in | 6 frames, via `interpolate(frame, [0, 6, d - fadeFrames, d], [0, 1, 1, 0])` | `remotion/src/Episode.tsx:40–45` | show convention |
| Composition id | `"Episode"` | `remotion/src/Root.tsx:22`; the render command names it at `deadlight-assemble-episode.yaml:52` and `:81` | engine setting |
| Default fps | `30` | `remotion/src/Root.tsx:25`; overridden per-episode by `calculateMetadata` from `timeline.json` (`:12`) | engine setting |
| Default dimensions | `1024 × 576` | `remotion/src/Root.tsx:26–27`; overridden per-episode from `timeline.json` (`:13–14`) | engine setting |
| Default duration | `1000` frames, replaced from `timeline.json` (`:11`) | `remotion/src/Root.tsx:24` | engine setting |
| Episode selector | `process.env.REMOTION_EPISODE ?? "ep99"` | `remotion/src/Root.tsx:4` | **id-scheme default — `ep99` is a Dead Light production id** |
| Timeline source | `staticFile(\`${EP}/timeline.json\`)` | `remotion/src/Root.tsx:8` | contract with `build-timeline.py:113` |
| Ken Burns motion | `ZOOM_PER_S = 0.0035`, `PAN_PER_S = 1.4`, zoom cap `1.35x` (expressed as `1.02 + 0.33`), pan cap `90px` | `remotion/src/Episode.tsx:84–93` | show style |
| Remotion version | `4.0.487` across `@remotion/cli`, `@remotion/media`, `remotion` | `remotion/package.json:10–14` | engine dependency |
| React version | `19.2.7` | `remotion/package.json:12–13` | engine dependency |

**The only true show *asset* is the title card, and it is not a file — it is typography in
`Episode.tsx`.** Spec §7.4 anticipated "the Remotion project's show-specific assets (the title
card) become show assets referenced by config". Because the card is rendered from a string plus a
font stack plus three colours rather than loaded from an image, "referenced by config" means
passing text, font, size, tracking and colours through — either as `defaultProps` on the
composition or as fields the show config writes into `timeline.json`. `build-timeline.py:96–97`
already writes a `title` object into the timeline, so the timeline is the natural carrier. Finding
F-12 records the choice.

### 5.2 How `finalize-video.py` resolves the air slot and the NAS path

**Air slot**, at `finalize-video.py:115`: `slot = SEASON_MAP.get(ep) or season_slot(ep)`.

1. `SEASON_MAP` (`:33–46`) is consulted first and is authoritative for the seven ids it lists
   (`ep01`–`ep05`, `ep09`, `ep10`). Its comments record that `ep98` is deliberately unmapped and
   `ep99` is retired.
2. When the id is absent from `SEASON_MAP`, `season_slot(ep)` (`:75–112`) globs `Canon/season-*.md`
   via `_season_docs()` (`:64–73`, sorted numerically so `season-10.md` cannot sort before
   `season-2.md`), then for each doc matches every row against
   `^\|\s*(\d+)\s*\|\s*\*\*RULED\*\*\s*\|` (`:101`) and accepts the row whose **default** id
   `ep{air:02d}` equals the episode id (`:103`).
3. Zero matches returns `None`, and `finalize()` prints `SKIP <ep>: no air slot` and returns False
   (`:117–118`). More than one distinct match is a hard `sys.exit` naming every candidate
   (`:107–111`).
4. `all` mode iterates `SEASON_MAP` only and never reaches `season_slot()` (`:140`, and the
   docstring at `:92–94` says why).

**NAS path**, at `finalize-video.py:51–52` and `:125`:

1. `MOUNT = os.environ.get("DEADLIGHT_FINAL_MOUNT", "/Volumes/media")` and
   `DEST = os.environ.get("DEADLIGHT_FINAL_DEST", "/Volumes/media/DeadLight")`.
2. `ensure_mounted()` (`:54–58`) requires **both** `os.path.ismount(MOUNT)` **and**
   `os.path.isdir(DEST)`, and exits with nothing written otherwise. This runs before any copy
   (`:139`).
3. The destination file is `os.path.join(DEST, f"DeadLight S{s:02d}E{e:02d}.mp4")` (`:124–125`).
4. The copy is skipped when the destination exists and its mtime is at least the source's
   (`:126–128`); otherwise `shutil.copy2` (`:129`).

The workflow also checks the NAS independently, before the four-hour render, at
`deadlight-assemble-episode.yaml:34` — a literal `[ ! -d "/Volumes/media/DeadLight" ]` test with
no environment override, so the two checks can disagree if `DEADLIGHT_FINAL_DEST` is set. That is
finding F-13.

---

## 6 · The console's own show constants

**Purpose of this list: Plan F deletes `console/` from the show repository (spec §7.4). Anything
in this list that is a show fact, not a console implementation detail, must be re-homed into show
config first.** Every path below is relative to
`/Users/ryanperkowski/GitHub/DeadLight/console/`.

**The console has no `AIR` dictionary and no `LOGLINE` dictionary of its own.** It obtains the
air map by reading `finalize-video.py` as text and regex-parsing `SEASON_MAP` out of the Python
source — see `repo.ts:110` below. That is finding F-14.

| file:line | Constant | What it is | Re-home as |
|---|---|---|---|
| `server/repo.ts:44` | `SEASON_ROW_RE = /^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^\|]*\*\*\s*\|(.*)$/gm` | The season-table RULED-row parser, deliberately mirroring `season-status.py:34` | Show config: the season-table row grammar, or a single shared parser |
| `server/repo.ts:45` | `QUOTED_TITLE_RE = /\*\*"([^"]+)"\*\*/` | The episode-title cell grammar | Show config: same |
| `server/repo.ts:46` | `SEASON_MAP_ENTRY_RE = /"(ep\d+)":\s*\((\d+),\s*(\d+)\)/g` | A regex that parses Python source | Delete once the air map is data (section 7's `airMap` key) |
| `server/repo.ts:47` | `EPISODE_DIR_RE = /^ep\d+$/` | The production-id scheme | Show config: `idScheme` |
| `server/repo.ts:60` | `air === 1 ? "(pilot)" : "(untitled)"` | The untitled-episode fallback labels | Show config, or engine default |
| **`server/repo.ts:72`** | **`if (season === 1) out.set(air, prod);`** | **The hardcoded season literal — process map §9 item 3; every non-Season-1 `SEASON_MAP` entry is discarded** | **Delete: the air map becomes per-season show data** |
| `server/repo.ts:78` | `` `ep${String(air).padStart(2, "0")}` `` | The default production id for an unmapped air slot | Show config: `idScheme` |
| `server/repo.ts:110` | `path.join(root, ".archon/scripts/finalize-video.py")` | **The console reads a Python script as its data source** | Delete: read the air map from show config |
| `server/repo.ts:141` | `MILESTONE_LINE_RE = /^- (\d{4}-\d{2}-\d{2}) (\w+): (.*)$/gm` | The `STATUS.md` line grammar written by `status.py:19` | Show config, or an engine-owned status format |
| `server/repo.ts:237` | Comment naming `DeadLight S01E01.wav`, `episode.mp4`, `episode01.mp4` | The three real media-naming conventions the console must tolerate | Show config: `mixFilename`, `videoFilename` |
| `server/readiness.ts:58` | `const NAS_PATH = "/Volumes/media/DeadLight";` | The NAS root, with no environment override | Show config: `nasRoot` |
| `server/readiness.ts:99` | `/^DeadLight .*\.wav$/` | The mixed-WAV filename pattern | Show config: `mixFilename` |
| `server/readiness.ts:113` | `execFileSync("git", ["diff", "--quiet", "--", "Canon/"], ...)` | The canon directory name | Show config: `canonDir` |
| `server/readiness.ts:133`, `:152`, `:177` | `` `Episodes/${prod}/script.md` `` | The episodes directory and script filename | Show config: `episodesDir` |
| `server/readiness.ts:157` | `` `Production/${prod}/tts-script.json` `` | The production directory and manifest filename | Show config: `productionDir` |
| `server/readiness.ts:170`, `:187`, `:228`, `:237` | Blocked-reason sentences quoting each workflow's own error text verbatim | Show data — they mirror `deadlight-*.yaml` setup nodes | Delete: the engine's guards produce these messages |
| `server/readiness.ts:205` | `` `Production/${prod}/video/episode.mp4` `` | The rendered-video filename | Show config: `videoFilename` |
| `server/actions.ts:41–45` | The five literal workflow names `deadlight-write-episode`, `deadlight-produce-assets`, `deadlight-assemble-episode`, `deadlight-canon-update`, `deadlight-season-review` | The workflow allowlist | Delete: Plan D's pipeline ids replace them |
| `server/actions.ts:59` | `["uv", "run", ".archon/scripts/nano-banana-generate.py", ep, "--only", ...]` | A script path in argv | Show config: `scriptsDir`, or engine-owned |
| `server/actions.ts:72` | `["uv", "run", ".archon/scripts/image-generate.py"]` | A script path in argv | Same |
| `server/actions.ts:93` | `["uv", "run", ".archon/scripts/registry-append.py", ep]` | A script path in argv | Same |
| `server/actions.ts:121` | `if (workflow !== "deadlight-write-episode") return true;` | A workflow-name literal gating the premise check | Delete with the allowlist |
| `server/discuss.ts:23` | `PROD_RE = /^ep\d+$/` | The production-id scheme, used as an argv allowlist | Show config: `idScheme` |
| `server/discuss.ts:184–190` | `` `Canon/${filename}` `` excerpt reader | The canon directory name | Show config: `canonDir` |
| `server/discuss.ts:204–227` | `Canon/continuity-ledger.md` "## Open threads" parser | A specific canon file and its section heading | Show config: `continuityLedger` |
| **`server/discuss.ts:585–600`** | **`EDITOR_PREAMBLE`** — a 16-line agent system prompt naming `"Dead Light"` at `:586` | **An agent prompt living in console TypeScript** | **Move to `prompts/` like every other prompt** |
| `server/seasons.ts:15` | `SEASON_ID_RE = /^s(\d+)$/` | The season-id scheme | Show config: `seasonIdScheme` |
| `server/seasons.ts:17` | `SEASON_FILE_RE = /^season-(\d+)\.md$/` | The season file naming | Show config: `seasonFilePattern` |
| `server/seasons.ts:76` | `sN -> Canon/season-N.md` resolution | The season file path | Show config: same |
| `server/sse.ts:107` | `EPISODES_MD_RE = /^Episodes\/ep\d+\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/` | The production-id scheme inside a watch filter | Show config: `idScheme` |
| `server/gates.ts:107` | `DOC_PATH_RE = /\bEpisodes\/(ep\d+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/gi` | The production-id scheme inside a gate-document extractor | Show config: `idScheme` |
| `server/manifest.ts:17` | `PROD_RE = /^ep\d+$/` | The production-id scheme | Show config: `idScheme` |
| `server/manifest.ts:260–261`, `:341–345`, `:363` | `Production/voice-refs/` (company regulars) and `Production/<ep>/guest-refs/` (one-offs) | The voice-reference layout | Show config: `voiceRefsDir`, `guestRefsDir` |
| `server/deskzone.ts:6–7` | `Canon/season-desk-report.md` and `Production/*/notes/desk-inbox.md` | Two specific show document paths | Show config, or delete with the desk surface |
| `server/deskzone.ts:84` | `PROD_RE = /^ep\d+$/` | The production-id scheme | Show config: `idScheme` |
| `server/index.ts:71` | `const repoRoot = path.resolve(import.meta.dirname, "../..");` | **The show root is derived from the console's own location on disk** — the console can only ever operate on the repository it is checked into | **Delete: the engine takes `showRoot` by path (spec §7.3)** |
| `server/index.ts:81` | `PROD_RE = /^ep\d+$/` | The production-id scheme | Show config: `idScheme` |
| `server/archon.ts:205–207` | `` `${workflowName}.yaml` `` then `` `deadlight-${workflowName}.yaml` `` under `.archon/workflows` | A show-name prefix used as a filename fallback | Delete with `.archon/` |
| `server/archon.ts:139` | `` `deadlight-archon-${randomUUID()}.out` `` | A temp-file name carrying the show's name | Delete with `.archon/` |
| `shared/writeRefusal.ts:25` | `` `Episodes/${prod}/script.md already exists — refusing to overwrite.` `` | A verbatim copy of `deadlight-write-episode.yaml:31`'s sentence | Delete: the engine's `setup` guard owns the message |
| `src/useDocTitle.ts:29` | `workflow.replace(/^deadlight-/, "")` | A show-name prefix stripped from a workflow id | Delete with the allowlist |
| `src/useDocTitle.ts:47`, `:50`, `:56`, `:59` | The literal `"Dead Light"` in four browser-tab title strings | The show's display name | Show config: `showName` |
| `src/components/LaunchCard.tsx:274` | `EP_ID_RE = /^ep\d+$/` | The production-id scheme | Show config: `idScheme` |
| `src/pages/GateRoom.tsx:27` | `EP_ID_RE = /\bep\d+\b/gi` | The production-id scheme | Show config: `idScheme` |

**Nine distinct places encode the `epNN` production-id scheme** (`repo.ts:47`, `discuss.ts:23`,
`sse.ts:107`, `gates.ts:107`, `manifest.ts:17`, `deskzone.ts:84`, `index.ts:81`,
`LaunchCard.tsx:274`, `GateRoom.tsx:27`), plus `repo.ts:46` and `repo.ts:78`. Every one becomes one
show-config key.

---

## 7 · The show config file, proposed

**This is a proposal of keys, not a ruling.** Each row names a key, its type, its value today, and
the file and line that value lives at today. The file's name, format and nesting are Plan C's to
decide; spec §7.3 says only that it sits "at the show repository's root" and "names what the engine
needs to find: the prompts directory, the output destinations including the NAS path, and the id
scheme". **Thirty-four keys.**

### 7.1 Layout

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `showName` | string | `Dead Light` | `console/src/useDocTitle.ts:47`; 28 of 30 prompts; `publish-kit.py:89` |
| `showSlug` | string | `DeadLight` (no space — the filename form) | `audio-mix.py:17`, `finalize-video.py:124`, `season-status.py:177` |
| `promptsDir` | path | does not exist yet; `<showRoot>/prompts` is the engine's default | `/Users/ryanperkowski/GitHub/Showrunner/README.md:100` |
| `canonDir` | path | `Canon` | `console/server/readiness.ts:113`; every workflow prompt |
| `episodesDir` | path | `Episodes` | `status.py:15`, `console/server/readiness.ts:133` |
| `productionDir` | path | `Production` | `tts-generate.py:70`, `audio-mix.py:23`, `build-timeline.py:17` |
| `scriptsDir` | path | `.archon/scripts` (moves to the engine repository's `scripts/`) | every workflow bash node, e.g. `deadlight-produce-assets.yaml:282` |
| `renderPublicDir` | path | `remotion/public` (becomes the engine's `render/public`) | `build-timeline.py:103` |

### 7.2 Models

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `models.small` | model id | `claude-haiku-4-5` | `.archon/config.yaml:18–20` |
| `models.medium` | model id | `claude-sonnet-5` | `.archon/config.yaml:21–23` |
| `models.large` | model id | `claude-opus-4-8` | `.archon/config.yaml:24–26` |
| `models.@writer` | model id | `claude-fable-5` | `.archon/config.yaml:29–32` |
| `models.default` | model id | `claude-sonnet-5` (the `assistants.claude` default) | `.archon/config.yaml:13–15` |

The engine's `createAgentExecutor` takes a `models` alias map and passes any unlisted name to the
SDK unchanged (`/Users/ryanperkowski/GitHub/Showrunner/README.md:100–101`). **The alias `@writer`
contains a character Archon required and the engine does not**; Plan C decides whether the key
keeps the `@` or becomes `writer`. Note that `small` is referenced by no node in any of the five
workflows — it is defined and unused.

### 7.3 Identity and seasons

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `idScheme.legacy` | regex | `^ep[0-9]{2,}$` (the four workflow setup guards) / `^ep\d+$` (the console's nine copies) | `deadlight-write-episode.yaml:26`, `deadlight-produce-assets.yaml:24`, `deadlight-canon-update.yaml:25`, `deadlight-assemble-episode.yaml:22`; `console/server/repo.ts:47` |
| `idScheme.default` | template | `ep{air:02d}` | `finalize-video.py:103`, `season-status.py:53`, `console/server/repo.ts:78` |
| `idScheme.current` | template | `sXXeYY` — **proposed by spec §5.4, not yet in any file** | `/Users/ryanperkowski/GitHub/Showrunner/docs/specs/2026-09-25-pipeline-process-map.md:485` |
| `seasonIdScheme` | regex | `^s(\d+)$` | `console/server/seasons.ts:15`; `deadlight-season-review.yaml:24` |
| `seasonFilePattern` | template | `Canon/season-{N}.md` | `finalize-video.py:69`, `season-status.py:132`, `console/server/seasons.ts:17` |
| `seasonRowPattern` | regex | `^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^\|]*\*\*\s*\|` | `season-status.py:34`, `console/server/repo.ts:44` — **and a stricter variant requiring exactly `**RULED**` at `finalize-video.py:101`** |
| `airMap` | map of production id to (season, air) | ten entries `ep01`–`ep10` all in season 1, with `ep98` and `ep99` deliberately absent | `finalize-video.py:33–46`; copied verbatim to `audio-mix.py:13`, `build-timeline.py:106`, `publish-kit.py:23` |

### 7.4 Milestones and status

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `milestones` | ordered list | `beats, outline, script, canon, casting, audio, images, assembled, finalized` | `status.py:11–12`, duplicated at `season-status.py:18–19` |
| `statusFile` | filename | `STATUS.md` under `Episodes/<ep>/` | `status.py:15` |
| `statusLineFormat` | template | `- <ISO date> <milestone>: <detail>` | `status.py:19`; parsed at `season-status.py:57` and `console/server/repo.ts:141` |
| `draftingMarkers` | list | `STATUS.md`, `outline.md`, `script.md` | `season-status.py:88` |

### 7.5 Output destinations

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `nasMount` | absolute path | `/Volumes/media` (env override `DEADLIGHT_FINAL_MOUNT`) | `finalize-video.py:51` |
| `nasRoot` | absolute path | `/Volumes/media/DeadLight` (env override `DEADLIGHT_FINAL_DEST`) | `finalize-video.py:52`; hardcoded without override at `console/server/readiness.ts:58` and `deadlight-assemble-episode.yaml:34`; defaulted again at `season-status.py:130` |
| `finalFilename` | template | `DeadLight S{s:02d}E{e:02d}.mp4` | `finalize-video.py:124`; probed at `season-status.py:177` |
| `mixFilename` | template | `DeadLight S{s:02d}E{e:02d}.wav`, falling back to `episode.wav` when unmapped | `audio-mix.py:17`; duplicated at `build-timeline.py:109`; matched at `console/server/readiness.ts:99` |
| `videoFilename` | filename | `episode.mp4` under `Production/<ep>/video/` | `master-video.py:44`; globbed as `episode*.mp4` at `finalize-video.py:61` |

### 7.6 Audio conventions

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `audio.sampleRate` | integer | `24000` | `tts-generate.py:17`, `design-voice.py:17`, `audio-mix.py:119` |
| `audio.loudnessTarget` | object | `I=-14, TP=-1.5, LRA=11` | `audio-mix.py:109`, `master-video.py:21` — **but `design-voice.py:37` uses `I=-16`** |
| `audio.roomToneDb` | number | `-42`, passed as the `HUM_DB` env var | `deadlight-produce-assets.yaml:318`; consumed at `audio-mix.py:91` |
| `audio.roomToneFundamentalHz` | number | `55` | `audio-mix.py:99` |
| `audio.tailOutSeconds` | number | `1.0` | `audio-mix.py:82`; must match `build-timeline.py:92`'s `+FPS` pad |
| `audio.titleCardGapSeconds` | number | `7.0`, with a validator ceiling of `8.5` | `deadlight-produce-assets.yaml:163`; `validate-manifest.py:87` |
| `audio.sceneTransitionGapSeconds` | number | `3.5`, with a validator ceiling of `4.0` | `deadlight-produce-assets.yaml:161`; `validate-manifest.py:87` |
| `audio.authoredPauseRange` | range | `0.2`–`3.5` seconds | `deadlight-produce-assets.yaml:126–133` |
| `audio.narratorSpeakerKey` | string | `narrator` | `pace-qc.py:33`, `breath-qc.py:87`, `audio-mix.py:42` |
| `audio.mainCast` | list | `narrator, Sarn, Sable, Trent, Opha, Cricket, Remo` | `validate-manifest.py:133` |
| `voiceRefsDir` | path | `Production/voice-refs` (holds `refs.json` plus ten locked WAVs) | `deadlight-produce-assets.yaml:49`; `console/server/manifest.ts:260` |
| `guestRefsDir` | path template | `Production/<ep>/guest-refs` | `deadlight-produce-assets.yaml:178`; `console/server/manifest.ts:341–345` |
| `voiceRegistry` | path | `Canon/voice-registry.md` | `validate-manifest.py:19`; `deadlight-produce-assets.yaml:50` |

### 7.7 Visual conventions

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `visualRefs` | path | `Canon/refs.json` | `image-generate.py:23`, `nano-banana-generate.py:55`, `design-visual.py:31`, `registry-append.py:111` |
| `visualStyle` | path | `Canon/visual-style.md` | `deadlight-produce-assets.yaml:342`; cited by `nano-banana-generate.py:295` and `image-sheet.py:44` |
| `castingPileDir` | path | `Canon/characters` | `registry-append.py:48` |
| `candidatesDir` | path | `Canon/_candidates` | `design-visual.py:32` |
| `shotFrameSize` | object | `1024 × 576` | `image-generate.py:83`, `design-visual.py:46`, `build-timeline.py:90`, `deadlight-produce-assets.yaml:357` |
| `characterKinds` | set | `human, creature, ship` | `registry-append.py:12` |
| `ambientPromptScaffold` | list of strings | `ducting overhead, `, `deep teal-black starfield, `, `starfield, `, and the suffix `low-key but clearly exposed...` | `image-sheet.py:16–17` |
| `styleConstants` | string | the full photographic-look sentence | `nano-banana-generate.py:37–41` |
| `collectivePopulatorBans` | list | 13 banned phrases plus the count-word and capping-idiom grammars | `nano-banana-generate.py:383–400` |
| `auditLaws` | prose block | the eight numbered canon laws naming Remo, Opha and shard scale | `nano-banana-generate.py:295–313` |

### 7.8 Video and title card

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `video.fps` | integer | `30` | `build-timeline.py:10`, `shot-sheet.py:20`, `remotion/src/Root.tsx:25` |
| `video.crossfadeSeconds` | number | `1.0` | `build-timeline.py:11`, `shot-sheet.py:21` |
| `video.compositionId` | string | `Episode` | `remotion/src/Root.tsx:22`; `deadlight-assemble-episode.yaml:52` |
| `titleCard.text` | string | `DEAD LIGHT` | `remotion/src/Episode.tsx:66` |
| `titleCard.fontFamily` | string | `Georgia, 'Times New Roman', serif` | `remotion/src/Episode.tsx:58` |
| `titleCard.colors` | object | background `#000504`, type `#b8d4d0`, glow `rgba(96, 160, 152, 0.25)`, stage `#04100f` | `remotion/src/Episode.tsx:49`, `:57`, `:63`, `:106` |
| `titleCard.fadeSeconds` | number | `2.0` | `build-timeline.py:30` |

### 7.9 Publishing

| Key | Type | Value today | Source today (file:line) |
|---|---|---|---|
| `publish.channelName` | string | `[YOUR NAME]` — **still the unfilled placeholder** | `publish-kit.py:20` |
| `publish.playlistUrl` | URL | `https://www.youtube.com/playlist?list=PLciZ4PlFk16g` | `publish-kit.py:21` |
| `publish.playlistName` | string | `Dead Light Season 1` | `publish-kit.py:133` |
| `publish.tags` | string | the seven-tag list | `publish-kit.py:49` |
| `publish.category` | string | `Film & Animation` | `publish-kit.py:143` |
| `publish.standingCopy` | prose | the "New episodes weekly" line and the AI-disclosure paragraph | `publish-kit.py:107`, `:113` |
| `publish.guide` | path | `Canon/publishing-guide.md` | `publish-kit.py:13`, `:118` |
| **`loglines`** | **per-episode data, not config** | ten multi-paragraph teasers | **`publish-kit.py:25–48` — spec §7.4 rules these become "per-episode publish data in the show repository"** |

**Counting the keys**: 8 layout + 5 models + 7 identity/seasons + 4 milestones + 5 destinations +
13 audio + 10 visual + 7 video/title + 8 publishing = **67 named keys across nine groups**.

**Twenty-nine of the 67 are what the engine or a script strictly needs to run at all**: the eight
layout keys, the five model keys, the seven identity-and-season keys, the four milestone keys, and
the five output-destination keys. The remaining 38 are conventions — six of which spec §7.4 names
by hand (room tone, title card, mix filename, voice refs, visual refs, season file naming) and the
rest of which Plan C must sort into config, per-episode show data, or prompt text. Section 9's
F-15 records that sorting as an open question.

---

## 8 · Test fixtures Plan C will need

**The test that matters for a script is hermetic: a small input on disk, no model, no GPU, no
network.** The engine's own suite already holds this line — 139 hermetic tests and two env-gated
live ones (`/Users/ryanperkowski/GitHub/Showrunner/docs/plans/2026-09-27-agent-runner-deferred.md`
status paragraph) — and the show repository already has seven test files
(`test_check_layout.py`, `test_finalize_video.py`, `test_nano_banana_generate.py`,
`test_registry_append.py`, `test_season_review_workflow.py`, `test_season_status.py`,
`test_status.py`, `test_truncation_qc.py`) that move with the scripts.

### 8.1 Per-script hermetic-test feasibility

| Script | Fast hermetic test possible? | What it asserts |
|---|---|---|
| `status.py` | Yes; a test exists (`test_status.py`) | A milestone updates in place rather than duplicating; an unknown milestone exits non-zero (`status.py:41`) |
| `season-status.py` | Yes; a test exists (`test_season_status.py`) | A `**RULED — REWRITTEN**` row still parses (`:34`); an absent NAS yields `unknown (NAS unmounted)` rather than a failure (`:179`); `SEASON_STATUS_PARTIAL` lists every problem |
| `finalize-video.py` | Yes; a test exists (`test_finalize_video.py`) | A `SEASON_MAP` hit wins over a season-doc scan (`:115`); two matching season docs exit without writing (`:107`); an unmounted NAS writes nothing (`:56`) |
| `registry-append.py` | Yes; a test exists (`test_registry_append.py`) | An identical destination is skipped (`:84`); a differing one is replaced with an `UPDATED` line (`:93`); two matching folders are skipped with a warning (`:72`) |
| `check_layout.py` | Yes; a test exists (`test_check_layout.py`) | A misplaced `script.md` under `Production/` is reported (`:22`) |
| `truncation-qc.py` | Yes; a test exists (`test_truncation_qc.py`) | A synthetic hot-ending WAV is flagged and a clean-decay WAV is not (`:104`); the reroll bumps the seed (`:117`). **The re-run of `tts-generate.py` at `:144` must be injectable** — today it is a bare `subprocess.run` |
| `nano-banana-generate.py` | Yes; a large test exists (`test_nano_banana_generate.py`) | The populator guard rejects before any call (`:485`); the `.bak` conflict refusal (`:500`); `assemble_refs` dedupes stills by basename (`:100`). The API call and the `claude` audit must both stay injectable |
| `validate-manifest.py` | **Yes — highest value, no test today** | A leaked `[BEAT]` or `[SABLE]` mark fails (`:85`); an out-of-range `gap_before` fails (`:88`); two title cards fail (`:95`); a non-strictly-increasing `i` fails (`:75`); an unmapped heteronym warns but does not fail (`:123`) |
| `build-timeline.py` | **Yes — no test today** | Scene boundaries match from a three-scene script and a five-segment manifest; an unmatched scene is filled by proportional spacing (`:63`); the last shot holds to the end (`:87`); the timeline's `durationInFrames` is `total_s * FPS + FPS` (`:92`). The staging copy at `:110–113` needs a temp `remotion/public` root, which today is a hardcoded relative path |
| `publish-kit.py` | **Yes — no test today** | Chapter timestamps accumulate `gap_before + duration_s` (`:93`); a missing `LOGLINE` entry emits the placeholder rather than an empty description (`:105`); SRT cue numbering starts at 1 (`:98`) |
| `audio-mix.py` | Partly — needs `soundfile`, `numpy` and `ffmpeg` on the test machine | With `ffmpeg` available: a three-segment fixture at 24 kHz produces a file whose length is the sum of gaps, durations and the 1.0 s tail (`:82`); `title_card_before` produces the hum-hold envelope (`:57–63`); an unmapped id names the output `episode.wav` (`:17`). The two `ffmpeg` passes make it slower than hermetic, so split the envelope maths into a pure function and test that |
| `pace-qc.py` | Partly — the detector is pure and testable; the `tts-generate.py` re-invocation and `ffmpeg` clamp are not | Pure part: the median and `±BAND` outlier selection over a synthetic rows list (`:39–40`); `MIN_WORDS` and `cutoff`/`delivery` exclusions (`:33–36`) |
| `breath-qc.py` | Yes for the `fix()` function, given `soundfile` and `numpy` | A synthetic 12-second single-run WAV gains inserted silence at the mid-run candidate (`:70–74`); a 5-second WAV gains nothing (`:63`); a second call inserts nothing more |
| `image-sheet.py` | **Yes — no test today** | `subject()` strips the three prefixes and the suffix (`:16–22`); present/absent PNGs produce the right tick marks (`:86`); the nano/local split is by `type == "character"` (`:33–34`) |
| `master-video.py` | No, not hermetically — every path shells `ffmpeg` over a real MP4 | The one testable assertion is the `loudnorm` filter string assembled at `:51–54`; extract it as a pure function |
| `tts-generate.py` | Partly — `make_synth` must be injectable | With a fake synth: the skip-if-exists path (`:87`); the cutoff slice ratio (`:99–103`); the manifest's `duration_s`, `gap_before` and `title_card_before` fields (`:117–119`). The `mlx_audio` import at `:31` currently happens inside `make_synth`, which already makes injection possible |
| `image-generate.py` | Partly — the argv assembly is pure, the `mflux` call is not | The ambient-versus-hero argv shape (`:91–107`); the character-shot skip (`:70`); the missing-baseline fallback warning (`:100`) |
| `design-voice.py` | No — every run calls a model | Nothing worth asserting hermetically beyond argument parsing |
| `design-visual.py` | Partly — the seed derivation at `:72` is pure and deterministic | `base_seed` is stable across processes; `all` selects only unlocked subjects (`:57–58`) |
| `image-qc.py` | Yes, given `pillow` and `numpy` | A synthetic all-black PNG is `broken`; a synthetic mid-grey PNG is not (`:54`) |
| `shot-sheet.py` | **Yes — no test today** | Its timings equal `build-timeline.py`'s for the same fixture, which is the property its docstring claims at `:9–12` |

**Seven scripts have no test today and can have a fast hermetic one**: `validate-manifest.py`,
`build-timeline.py`, `publish-kit.py`, `image-sheet.py`, `shot-sheet.py`, plus the pure cores of
`pace-qc.py` and `breath-qc.py`.

**One cross-cutting fixture pays for itself across nine of them.** A single miniature episode —
three scenes, five segments, four shots, one title card, one character shot, one ambient shot —
under a temp show root satisfies `validate-manifest.py`, `build-timeline.py`, `publish-kit.py`,
`image-sheet.py`, `shot-sheet.py`, `registry-append.py`, `season-status.py`, `check_layout.py` and
the `tts-generate.py` manifest assertions. Build it once.

### 8.2 Prompt checks

Two checks, both cheap, both runnable in CI with no model:

1. **Every extracted prompt renders against a sample context with no `TemplateError`.** For each
   of the 30 files under `prompts/`, call `renderPrompt`
   (`/Users/ryanperkowski/GitHub/Showrunner/engine/src/prompt-template.ts:44`) with a fixture
   context supplying `episodeId`, `runId`, `showRoot` and a `results` record holding one entry per
   `{{results.<key>}}` the prompt names. The check catches four classes of defect the engine
   otherwise surfaces only at run time: an unknown variable name, a `results` key with no entry, a
   path through a non-object, and a `null` value. It also catches a stray `{{` or `}}` left behind
   by the extraction, because the leftover-brace guard runs on the rendered string
   (`prompt-template.ts:79`).
2. **Every `{{results.<key>}}` names a step id that exists in the pipeline Plan D defines.**
   Walk each prompt for `{{results.([^.}]+)`, strip a `:rejection` or `:iteration` suffix, and
   assert the remainder is a step id in `pipeline.steps` — or, for a `:rejection` key, a
   `GateStep` id, and for an `:iteration` key, a `LoopStep.body` id. This is the prompt-side twin
   of the `StageMap` key validation Plan A's record already assigns to Plan D
   (`/Users/ryanperkowski/GitHub/Showrunner/docs/plans/2026-09-26-engine-core-deferred.md`, Plan D
   section). Plan C can write the check; it only passes once Plan D's pipeline exists, so the
   check ships red and Plan D turns it green.

A third check is worth considering and is cheap: **assert that no prompt file contains a `$`
followed by a letter**, which would mean an Archon variable survived the rewrite. Two false
positives exist and must be allowlisted — `deadlight-produce-assets.yaml:625–629` embeds literal
`ARGUMENTS="..."` shell lines inside the `audio-gate` rejection prompt, and `:596` does the same
inside the `image-audit` loop prompt.

---

## 9 · Findings

Each finding names the file and line, states what is ambiguous or surprising, and ends with the
question Plan C's author must answer.

**F-01 — `$ARGUMENTS` carries the premise and has no engine equivalent.**
`deadlight-write-episode.yaml:48` reads `The full request is: $ARGUMENTS`, and the next two lines
tell the model that the first token is the episode id and the rest is the premise. Archon injected
the whole launch message. The engine's `RunContext` has `episodeId`, `runId`, `showRoot` and
`results` and nothing else (`/Users/ryanperkowski/GitHub/Showrunner/engine/src/steps.ts:16–27`).
Plan B's record already assigns the rewrite to "a Plan D result key the setup step writes"
(`/Users/ryanperkowski/GitHub/Showrunner/docs/plans/2026-09-27-agent-runner-deferred.md`, Plan C
section). **Question: does the premise reach the run as a field on `RunContext`, or as the result
of a `setup` step that Plan D writes, and if the latter, what writes it — a guard whose `message`
is the premise, or a script?**

**F-02 — Five prompts interpolate a script's stdout, and the engine stores no script result.**
`runScriptStep` returns `{ kind: "completed" }` with no `result`
(`/Users/ryanperkowski/GitHub/Showrunner/engine/src/runner.ts:268`), so
`ctx.results["<script-id>"]` is never set and `{{results.season-status}}` throws. The five sites
are `deadlight-season-review.yaml:141` (`season-status.py`'s whole board, reproduced verbatim into
the desk editor's prompt), `deadlight-produce-assets.yaml:244` (`validate-manifest.py`'s summary
line), `:612` (`audio-mix.py`'s `MIX_OK` line), `:509` (`nano-banana-generate.py`'s per-shot
results and `NANO_OK`/`NANO_PARTIAL` trailer), and `deadlight-assemble-episode.yaml:68`
(`master-video.py`'s `MASTER_OK` line). The `season-status.py` case is the load-bearing one: the
desk editor's prompt says "THE BOARD (deterministic — reproduce verbatim, never edit)" at
`deadlight-season-review.yaml:140`, so the board is not decoration. **Question: does `ScriptOutcome`
gain a `result` field carrying a script's last stdout line or its whole stdout, or does each of
these five scripts start writing a file the next step reads — and if a file, who declares it as
that step's `outputs`?**

**F-03 — Three bash "gate" nodes are guards whose value a prompt reads, and a guard's `null`
message is unrenderable.** `deadlight-write-episode.yaml:182` (`outline-fix-gate`, printing `yes`
or `no`), `:796` (`review-gate`, same), and `deadlight-canon-update.yaml:92` (`diff`, printing
`NO_CHANGES` or a truncated diff) are all pure decisions computed from earlier results. As
`GuardStep`s their value survives — `runStep` stores `r.message ?? null`
(`/Users/ryanperkowski/GitHub/Showrunner/engine/src/runner.ts:225`) — but a guard that passes
without a message stores `null`, and `renderPrompt` refuses a `null` value
(`/Users/ryanperkowski/GitHub/Showrunner/engine/src/prompt-template.ts:69`). **Question: are these
three modelled as guards that always set a message, or as `when` predicates with no stored value,
and in the `diff` case — where the message is a whole `git diff` — is a guard message the right
carrier for kilobytes of text that the log will hold forever?**

**F-04 — `$desk-gate.output` is an approval response, not a rejection, and the engine stores a gate
answer as an object.** `deadlight-season-review.yaml:262` feeds the showrunner's gate response
verbatim into the `apply` agent, which parses it for approved proposal numbers (`:266–272`). The
engine stores a gate's answer as the whole `gate_answered` payload —
`{ approved, waitedMs, attempt, notes?, by? }` (`engine/src/runner.ts:42–45`, `:313`;
`engine/src/state.ts:96`) — so `{{results.desk-gate}}` would render that object as JSON and
`{{results.desk-gate.notes}}` renders the sentence the `apply` agent needs. `notes` is
conditionally spread (`runner.ts:43`), so an approval with no notes has no `notes` key at all and
the render throws. **Question: does the `apply` prompt read `{{results.desk-gate.notes}}` and Plan D
guarantee `notes` is always present on an approval, or does the engine grow a documented
`{{results.<gate-id>:answer}}` key to sit beside `:rejection`?**

**F-05 — `outline-canon-check`'s `verdict` field is read by a gate message but is not `required`.**
`deadlight-write-episode.yaml:219` renders `Canon pre-check: $outline-canon-check.output.verdict`,
and the schema's `required` list at `:159` is `[pass, issues]` — `verdict` is described at `:151–154`
but not required. The SDK validates against the schema and re-prompts on mismatch
(`/Users/ryanperkowski/GitHub/Showrunner/README.md:135`), so a verdict omitting `verdict` is valid
and the gate message then throws `TemplateError`. The same shape repeats on all seven reviewers
(`:429`, `:470`, `:519`, `:574`, `:636`, `:685`, `:747`), though only `outline-canon-check`'s
`verdict` is read by a template. **Question: is `verdict` added to `required` on all eight schemas,
or is the gate message rewritten to render `{{results.outline-canon-check.pass}}` instead?**

**F-06 — Archon's `$a.b.c` syntax cannot tell a field access from a sentence period, and four
prompts rely on that ambiguity.** `deadlight-assemble-episode.yaml:75`,
`deadlight-canon-update.yaml:110`, `deadlight-produce-assets.yaml:618` and `:652` each write
`$setup.output.` where the final period ends an English sentence. Under `{{episodeId}}.` the
ambiguity disappears entirely. This is not a defect to fix so much as a reason the extraction must
be done by reading, not by regex substitution: a naive rewrite of `\$(\w+)\.output((\.\w+)*)` would
consume the sentence period. **Question: is the extraction hand-checked prompt by prompt, or does
the extraction script get an explicit list of the four sites?**

**F-07 — `Canon/season-1.md` is named literally in twelve places across two workflows, and
`deadlight-season-review.yaml` refuses any other season because of it.** The literal appears once
in `deadlight-write-episode.yaml:168` (the outline canon pre-check's rubric) and eleven times in
`deadlight-season-review.yaml` — at :55, :83, :111, :158, :175, :182, :201, :234, :274, :284 and
:289, spanning the three lens prompts, the desk editor, the `desk-gate` rejection prompt, the
`apply` prompt and the commit bash node. The season-review `setup` node exits with a paragraph
explaining exactly this at `:31–33`. Meanwhile `Canon/season-2.md` already exists on disk and,
as of 2026-09-25, carries three `**RULED**` rows. **Question: does a prompt
receive the season file path as a rendered variable — which requires a `{{...}}` form the engine
does not have, since `season` is neither an episode id nor a step result — or does show config
supply it to the step's context another way?**

**F-08 — Argv precedence is inconsistent across the scripts, and two read `ARGUMENTS` first.**
`status.py:36`, `check_layout.py:32`, `registry-append.py:105`, `nano-banana-generate.py:598` and
`season-status.py:235` all put `sys.argv` first and say why in comments citing real incidents.
`image-sheet.py:25` and every `ARGUMENTS`-only script put the environment first.
`validate-manifest.py:59` puts `sys.argv[1]` first. The engine's `ScriptStep.argv` is a real argv
array (`engine/src/steps.ts:51`) and `ScriptStep.env` exists (`:53`), so the inconsistency can be
removed entirely. **Question: does Plan C convert every script to argv-only, keep `ARGUMENTS` as
the engine-set env var, or support both — and if argv-only, do the four unreferenced operator
tools convert too?**

**F-09 — `master-video.py` is not idempotent, and the restart design assumes it is.** Spec §6.9
states "a run mid-step re-executes that step, which is safe because every step is idempotent and
every script already skips outputs that exist"
(`/Users/ryanperkowski/GitHub/Showrunner/docs/specs/2026-09-25-console-rewrite-design.md`), and
Plan A's record repeats the assumption. `master-video.py:63` moves its normalized output over its
own input, so a re-run normalizes an already-normalized MP4 a second time. `pace-qc.py:66–68` and
`breath-qc.py:77` both mutate WAVs in place with the same exposure, though both re-measure
afterwards. **Question: does `master-video.py` write `episode-mastered.mp4` beside its input and
have `finalize-video.py` prefer it, or does it stamp a marker it checks on entry?**

**F-10 — Three parsers read the same season table with two different RULED regexes.**
`season-status.py:34` and `console/server/repo.ts:44` both accept `**RULED<anything>**`, and both
carry a comment explaining that pinning to exactly `**RULED**` silently dropped ep10 from every
board. `finalize-video.py:101` still requires exactly `**RULED**`. Because
`season-status.py:144` reads `finalize-video.py` as its air-map source, the board and the finalizer
can disagree about which rows exist. **Question: is the row grammar one show-config value all three
read, or is the parse moved into the engine with the grammar as config?**

**F-11 — Four scripts spawn `tts-generate.py` as a child and discard its stdout.**
`truncation-qc.py:144`, `pace-qc.py:53`, `pace-qc.py:71` and `breath-qc.py:107` each run
`["uv", "run", ".archon/scripts/tts-generate.py"]` with `stdout=subprocess.DEVNULL`. Under the
engine, the grandchild is invisible: its `::progress` lines never reach the log, its process group
is not in `liveProcessGroups()` (`engine/src/script-step.ts`, per Plan A's record), and the parent
step's timeout kills the parent's group, which may or may not include it. The re-synthesis these
four trigger is the longest single operation in the audio branch. **Question: do the three QC
passes stop spawning synthesis and instead return a "re-synthesis needed" signal that Plan D's
pipeline turns into another run of the `tts-generate` step — which would make the QC loop a loop in
the pipeline rather than inside a script — or does the engine accept blind grandchildren here?**

**F-12 — The title card is typography in a TSX file, not an asset.** Spec §7.4 says "the Remotion
project's show-specific assets (the title card) become show assets referenced by config", but
`remotion/src/Episode.tsx:37–70` renders the card from the string `DEAD LIGHT`, a font stack, a
size, a tracking value and three colours. There is no image to reference. `build-timeline.py:96–97`
already writes a `title` object into `timeline.json` carrying `from`, `durationInFrames` and
`fadeFrames`. **Question: do the card's text, font and colours travel in `timeline.json` alongside
the timing it already carries, or as `defaultProps` on the composition read from show config at
render time?**

**F-13 — The NAS path is asserted in four places with three different mechanisms.**
`finalize-video.py:51–52` reads `DEADLIGHT_FINAL_MOUNT` and `DEADLIGHT_FINAL_DEST` with defaults;
`season-status.py:130` reads `DEADLIGHT_FINAL_DEST` with the same default;
`console/server/readiness.ts:58` hardcodes `/Volumes/media/DeadLight` with no override; and
`deadlight-assemble-episode.yaml:34` hardcodes the same literal in a shell `[ ! -d ... ]` test with
no override. The workflow's check runs before the render so a finalize cannot fail after four
hours — a deliberate design the process map §6 records — but it cannot see an override the
finalizer would honour. Ops memory also records that the NAS needs remounting by hand after every
reboot, so this check fires often. **Question: does the `assemble` pipeline's `setup` guard read
`nasRoot` from show config, and does show config carry the mount point separately from the
destination directory, as `finalize-video.py` does today?**

**F-14 — The console and the season board both read a Python script as a data file.**
`console/server/repo.ts:110` reads `.archon/scripts/finalize-video.py` and regex-parses
`SEASON_MAP` out of the source with `/"(ep\d+)":\s*\((\d+),\s*(\d+)\)/g` (`:46`);
`season-status.py:144` does the identical thing with `re.finditer(r'"(ep\d+)":\s*\((\d+),\s*(\d+)\)'...)`
(`:45`). Both degrade silently when the file is unreadable. Because spec §7.4 moves
`.archon/scripts/` into the engine repository, both readers break at cutover: the air map would
live in the engine, describing one show's episodes. **Question: does `airMap` become a show-config
key that `finalize-video.py`, `season-status.py` and the board all read — which is the answer
section 7.3 proposes — and is the same key what section 9's F-15 dissolves the three `AIR`
duplicates into?**

**F-15 — The same air map exists in four places and the same two video constants in five.** The air
map: `finalize-video.py:33–46` (the source of truth, with three comment entries the others lack),
`audio-mix.py:13`, `build-timeline.py:106`, `publish-kit.py:23` — the latter three are
byte-identical one-line dictionaries carrying the same trailing comment about ep98. `FPS = 30` and
`CROSSFADE_S = 1.0`: `build-timeline.py:10–11`, `shot-sheet.py:20–21`, and `remotion/src/Root.tsx:25`
(fps only). The milestone list: `status.py:11–12` and `season-status.py:18–19`. The loudness target:
`audio-mix.py:109` and `master-video.py:21` agree at -14, while `design-voice.py:37` uses -16. The
production-id regex: nine places in the console plus four workflow setup nodes. **Question: which of
these duplications does Plan C actually collapse into show config, and which does it leave alone
because the value is an engine constant rather than a show fact — specifically, is `FPS` a show
choice or an engine default?**

**F-16 — `deadlight-produce-assets.yaml:440–451` embeds a Python program inside an agent prompt
that imports a pipeline script by file path.** The `visual-direction` prompt instructs the agent to
run `uv run python -c "..."` which loads `.archon/scripts/nano-banana-generate.py` via
`importlib.util.spec_from_file_location`, catches its `SystemExit`, and calls
`find_collective_populators` on every character brief. The prompt says why at `:453–456`: three
consecutive episodes were halted by the guard this pre-flight anticipates. After the move, that
path is in the engine repository, not the show repository, and the prompt — which is show data —
would name an engine path. **Question: does the populator guard become a `ScriptStep` between
`visual-direction` and the image branch, which is what the check actually is, or does the prompt
keep calling into engine code by path?**

**F-17 — `publish-kit.py`'s `CHANNEL["name"]` is still the placeholder `[YOUR NAME]`, and the
script knows it.** `publish-kit.py:20` holds `"[YOUR NAME]"`, and `:174` computes a `filled` flag
that prints a reminder at `:176` when the placeholder survives. Ten episodes have shipped with it
unfilled. It is a one-word config value nobody has set. **Question: does Plan C carry the
placeholder into show config as-is, or is this the moment to ask Ryan for the credit name?**

---

## Change log

- **2026-09-28 — created.** Inventory taken against `DeadLight` at branch `console-operating-layer`
  (HEAD `424e4e2`) and `Showrunner` at `docs/plans/2026-09-27-agent-runner-deferred.md` as of
  2026-09-28. No file in either repository was modified.
