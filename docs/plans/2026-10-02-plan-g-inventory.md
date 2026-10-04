# Plan G inventory — the new-show setup, measured

**Date:** 2026-10-02 · **Status:** measurement only. Nothing in either repository was changed to produce this document.
**Purpose:** the inventory Plan G ("the new-show setup") is written from. Plan G builds spec §9 — a setup phase that names a show, creates its repository in the house layout, points the engine at it, and produces its first bible by interview. This document measures what a show repository must contain for the episode pipeline to run, measures all 44 files of Dead Light's prompt set for show-specificity, measures the shape of a Ryan-ruled bible file, and measures what `gh` and the console already offer. **It proposes no design.**

**The two repositories this document cites.**

| Short form in a citation | Repository |
|---|---|
| `prompts/*`, `Canon/*`, `Episodes/*`, `Production/*`, `showrunner.json`, `README.md` (the show's), `.gitignore`, `docs/superpowers/*` | the show — `/Users/ryanperkowski/GitHub/DeadLight`, branch `main` at `6b157b8` |
| `engine/src/*.ts`, `scripts/*.py`, `console/server/*.ts`, `tools/src/*.ts`, `tools/show-data/*`, `docs/*`, `README.md` (the engine's) | the engine — `/Users/ryanperkowski/GitHub/Showrunner`, branch `plan-f`, content = `main` at `9347474` (Plans A–E merged) |

A bare `spec :NNN` is `docs/specs/2026-09-25-console-rewrite-design.md` in the engine repository.

**Counts, stated up front.**

| Quantity | Count |
|---|---|
| Files a show repository must contain for one episode to reach `COMPLETE` | **19 named files**, plus one voice WAV per speaking recurring character and one reference image per recurring subject — 14 top-level `Canon/*.md`, 2 reference indices, 1 outline template, `showrunner.json`, 1 per-episode `premise.md`; for Dead Light that is 19 + 9 WAVs + 21 images = **49** (§1.1, §1.6) |
| — of which the episode pipeline **declares** as a step input | **15** (`engine/src/pipelines/episode.ts:78-82`, `:172`, `:235`, `:250`, `:252`, `:275`), plus the per-episode `premise.md` (`:161`) and `locked-beats.md` (`:178`) |
| — of which a prompt instructs an agent to `Read` but no step declares | **8** (§1.2) |
| — of which a **Python script** opens directly and no step declares | **1** — `Canon/visual-audit-laws.md` (`scripts/nano-banana-generate.py:425`) |
| Bible directories the pipeline or prompts name | **5** — `Canon/characters/`, `species/`, `locations/`, `factions/`, `Episodes/_TEMPLATE/` |
| `_TEMPLATE` files that exist today | **5** — 4 entity templates + `Episodes/_TEMPLATE/outline.md` |
| Bible files with **no** template of any kind | **17** — every top-level `Canon/*.md`; 14 of the 17 are required for one episode (§1.1, §1.6) |
| `showrunner.json` keys **required** by both loaders | **8** (`scripts/lib/showconfig.py:53-62`; `engine/src/show-config.ts:91-109`) |
| `showrunner.json` keys the show actually supplies | **71** leaf values across **13** top-level groups (`showrunner.json`, 164 lines); **46** of the 71 sit in the four unvalidated groups |
| Files in `prompts/` | **51** — 42 `.md`, 8 `.schema.json`, 1 `index.json` |
| — the episode pipeline's set (51 minus the 7 season-desk prompts) | **44** |
| — of those, `.md` prompts the pipeline names by file | **34** = 18 from the 20 literal `promptFile`/`messageFile`/`schemaFile` sites (two of the twenty are schemas) + 8 `.reject.md` literals + `canon-review-outline.md` (`:178`) and `canon-review-script.md` (`:210`) + the 6 reviewers built from `` `${id}.md` `` at `:112` |
| Lines across those 34 prompts | **1,154** (1,362 across all 42 `.md`; 183 in the 7 desk prompts; 25 in `prompts/README.md`) |
| Of the 34: carry the literal show name | **27 files, 29 sites** |
| Of the 34: carry a character, ship or place name | **10 files, 27 sites** |
| Of the 34: carry an episode-history lesson (`epNN`, a ruling date) | **10 files, 21 sites** — **8 files, 19 sites** excluding the two canon reviewers' citation of the engine's own provenance rule |
| Of the 34: carry a production-tool name (Qwen3, Kokoro, Z-Image, Nano Banana, Gemini) | **4 files, 24 sites**, plus 2 whose **filename** is a vendor's |
| Of the 34: use `{{show.<path>}}` today | **0** |
| Classification of the 34 (§2.4) | **5** engine-generic as is · **16** parameterise · **11** generalise · **2** rewrite |
| Obligations the three deferred records assign to Plan G | **6** (table below), plus spec §9.5's **4** named open questions |
| Findings | **26** (§5) |

---

## The obligations the three deferred records assign to Plan G, collected

**Every `## Plan G` bullet in the three records that has one, with its address.** `2026-09-26-engine-core-deferred.md` and `2026-09-27-agent-runner-deferred.md` have no Plan G section; their last forward-looking section is Plan F.

| # | Obligation, in one line | Source |
|---|---|---|
| O-01 | **The id grammar is the engine's, not the show's.** `engine/src/ids.ts:12-13` hardcodes `/^s(\d{2})e(\d{2})$/` and `/^ep(\d{2})$/`, mirrored in `scripts/lib/showconfig.py:74-75`. Spec §7.3's "id scheme" is satisfied by `airMap` alone. **Whether a new show may choose a grammar is Plan G's question.** | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:43` |
| O-02 | **Three config-trust gaps matter only once a config is not author-trusted:** unknown top-level groups are silently dropped by the engine loader (`engine/src/show-config.ts:110-117`) while the Python scripts read the raw file; a relative `..` in `promptsDir` escapes the show root (`resolveShowPath`, `:132-134`); `seasonOf` trusts a map the engine loader has validated (`:124-130`). | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:44` |
| O-03 | **`video.compositionId` is in the config and nothing reads it yet**; the render's composition id is the literal `Episode` (`engine/src/pipelines/episode.ts:73` defaults it, `showrunner.json:139` sets it). | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:45` |
| O-04 | **The `## Cast` grammar and the `source` field are conventions a new show's `init` must teach its prompts.** `visual-direction-fix.md` and `publish-copy.md` are prompts every show needs. The seven season-desk prompts (`apply.md`, `arc-tracker.md`, `craft-critic.md`, `desk-editor.md`, `desk-gate.gate.md`, `desk-gate.reject.md`, `thread-auditor.md`) are referenced by no step of the episode pipeline: they are spec §0's deferred desk, not dead code. | `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:37` |
| O-05 | **A show registry over `--show` (one server, many shows) is Plan G's.** `ShowContext` already takes one root and nothing else assumes a single show (`console/server/show.ts:17-39`). | `docs/plans/2026-10-02-the-console-deferred.md:25` |
| O-06 | **The New-episode form is the first thing `init` teaches**; the `## Cast` grammar and the `source` field travel with the prompts. | `docs/plans/2026-10-02-the-console-deferred.md:26` |

**Adjacent, assigned to Plan G as a possibility rather than a duty.** `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:45`: "**Not built:** a command line (Ryan's ruling, 2026-09-29: `s02e01` waits for Plan E, possibly Plan G)". Plan E shipped the console's `--show` entry point (`console/server/main.ts:43-47`) and no general command line; spec §9.4 (`:232`) puts "a command-line `init`" in Plan G. See F-18.

**Spec §9.5's four open questions, verbatim** (`:234`): the exact question list per bible file; whether the interview may cite Dead Light's files as worked examples; whether the GitHub step uses `gh` or a token; the id scheme a new show starts with. Each is answered as a finding below — F-09, F-07, F-16, F-17.

---

## 1 · What a show repository must contain for the pipeline to run

**Conclusion: 19 named files and 5 directories, of which the engine declares 15 as step inputs — and a missing file is never an error at the engine layer.** `hashFile` returns `null` for `ENOENT` (`engine/src/hash.ts:5-14`) and `runScriptStep` hashes inputs and then runs the step regardless (`engine/src/runner.ts:420`, `:434`). No step in the episode pipeline checks that the bible exists; the **eleven** guards check the previous episode, the premise, hand edits twice, two verdicts, the references, the showrunner's images, the audit verdict, the NAS mount, and the canon tree's cleanliness (`engine/src/pipelines/episode.ts:142`, `:161`, `:175`, `:181`, `:207`, `:219`, `:241`, `:296`, `:308`, `:330`, `:368`). **A show repository with an empty `Canon/` runs the whole write phase and produces an outline from nothing.**

### 1.1 The canon spine — 9 files, declared, read by eleven steps

`engine/src/pipelines/episode.ts:78-82` builds `canonSpine` from eight fixed names plus the season file:

| File | First step that declares it | Also declared by | Size today |
|---|---|---|---|
| `Canon/world-overview.md` | `outline` (`:172`) | `canon-review-outline` (`:178`), `canon-review-script` (`:210`), `character-check` (`:214`) | 5,676 B / 45 lines |
| `Canon/technology.md` | `outline` (`:172`) | both canon reviewers, `draft` (`:198` — via the prompt, not the list), `environment-check` (`:216`), `propose` (`:376`) | 26,379 B / 116 lines |
| `Canon/timeline.md` | `outline` (`:172`) | both canon reviewers; **written** by `propose` (`:377`) | 2,288 B / 25 lines |
| `Canon/continuity-ledger.md` | `outline` (`:172`) | both canon reviewers; **written** by `propose` (`:377`) | 79,679 B / 241 lines |
| `Canon/series-arc.md` | `outline` (`:172`) | both canon reviewers | 7,879 B / 52 lines |
| `Canon/episode-formula.md` | `outline` (`:172`) | `flow-check` (`:213`), `structure-check` (`:215`) | 3,282 B / 54 lines |
| `Canon/story-craft.md` | `outline` (`:172`) | `draft` (`:198`), `structure-check` (`:215`) | 4,537 B / 75 lines |
| `Canon/style-guide.md` | `outline` (`:172`) | `draft` (`:198`), `revise` (`:224`), `tone-check` (`:212`), `flow-check` (`:213`), `character-check` (`:214`), `repetition-check` (`:217`) | 9,005 B / 110 lines |
| `Canon/season-<N>.md` | `outline` (`:172`), **only when the id resolves to a season** (`:81`, guarded by the `try` at `:76`) | both canon reviewers | `season-1.md` 36,577 B / 66 lines; `season-2.md` 35,528 B / 139 lines |

**`Canon/style-guide.md` is the most-read file in the bible: six of the thirty-four prompts' step declarations name it.** `Canon/season-<N>.md` is the one spine entry whose **absence is structural rather than a fault**: a production id (`epNN`) not in `airMap` makes `seasonOf` throw, the `catch` at `:76` sets `season = undefined`, and the spine is eight files rather than nine. A new show's first episode — `s01e01` — resolves to season 1 and therefore requires `Canon/season-1.md` to exist before the `outline` step's first hash.

### 1.2 The eight files and directories a prompt reads that no step declares

A step's declared inputs govern caching, not availability. These eight are named inside prompt bodies, so a missing one is an agent that cannot read a file — the `Read` tool fails, the agent continues, and the run produces a worse artifact with no event recording the gap:

| File | Prompt that instructs the read | Which step |
|---|---|---|
| `Canon/characters/**/*.md` (per-character sheets) | `character-check.md:10-13` ("Glob `Canon/characters/**/*.md`"), `outline.md:15`, `canon-review-*.md` | `character-check`, `outline`, both canon reviewers |
| `Canon/characters/The Mute/the-mute.md` | `outline.md:17`, `canon-review-outline.md:7`, `canon-review-script.md:10`, `:18` | `outline`, both canon reviewers |
| `Canon/species/`, `Canon/locations/`, `Canon/factions/` | `outline.md:15`, `environment-check.md:8` | `outline`, `environment-check` |
| `Canon/pipeline-artifacts.md` | `tts-script.md` (named in its read list; the `[SPEAKER]` convention is at `Canon/pipeline-artifacts.md:35`) | `tts-script` |
| `Episodes/<id>/locked-beats.md` — **the one row that is declared**, listed here because nothing creates it | `canon-review-outline.md:10` ("if it exists — BINDING"), `canon-review-script.md:28` | both canon reviewers; declared at `:178` and `:210`, so its absence hashes `null` rather than failing a read |
| `Episodes/ep01/outline.md` | `outline.md:21` ("your output must match its format and rigor") | `outline` |
| `Episodes/ep01/script.md`, `Episodes/ep*/script.md` | `draft.md:6`, `:18`, `:26`; `tone-check.md:3`; `repetition-check.md:8` | `draft`, `tone-check`, `repetition-check` |

**The last two rows are a show's own archive used as the register's definition, and a new show has no archive.** Counting the three entity directories separately, the row list names **eight** undeclared targets plus the one declared row. Four prompts name `Episodes/ep01/...` at six sites and two of those sites are a `Glob Episodes/ep*/script.md`. See F-05.

### 1.3 The one file a Python script opens and no step declares

`Canon/visual-audit-laws.md` (1,303 B / 21 lines) is read by `scripts/nano-banana-generate.py:425` through `visual.auditLaws` and inserted whole into the audit prompt (`:304-315`). The pipeline's `nano-banana-generate` step declares `inputs: [prompts, visualRefs]` and not this file (`engine/src/pipelines/episode.ts:288`). Its absence is a third failure shape: `scripts/nano-banana-generate.py:602` catches `FileNotFoundError` and exits with `nano-banana-generate: <message>`, which the runner records as `step_failed` with a named cause (`engine/src/runner.ts:436-438`). An **empty** file is refused separately, by name (`:313-314`).

**The file's content is the clearest statement in either repository of what a show owns and an engine must not.** The script's own docstring records the move: "They live in the show's canon rather than in this script because they are statements about THIS show's anatomy, scale and house style" (`scripts/nano-banana-generate.py:306-309`). Its 21 lines name Remo the Vesk's six limbs, Opha the Sethin's housecat scale and her translator muzzle-mask (`Canon/visual-audit-laws.md:5-10`) — a new show's file has nothing in common with it but the eight law headings.

### 1.4 The failure shapes, stated as a contract

| What is missing | What happens | Where |
|---|---|---|
| A file a step **declares** as an input | Hashed as `null`; the step runs; `step_started` records `inputHashes` with a `null` entry. On the next run the hash is still `null`, so `sameHashes` passes and the step is served from cache — **a bible file that was absent and then written does not invalidate a completed step unless some other declared input also changed** | `engine/src/hash.ts:10`; `engine/src/runner.ts:420`, `:424`, `:434` |
| A file a **prompt** names and no step declares | The agent's `Read` fails; the agent continues; the only record is an `agent_tool_call` event with the failed arguments | spec `:170` (the `agent_tool_call` kind); `engine/src/pipelines/episode.ts:172` (the declaration list that does not include it) |
| A file a **Python script** opens | `step_failed` with the script's own message, 1 is the exit code | `scripts/nano-banana-generate.py:599-603`; `engine/src/runner.ts:436-438` |
| `showrunner.json` itself, or a required key in it | Refused at startup by both loaders, naming the file and the dotted key | `engine/src/show-config.ts:55-63`; `scripts/lib/showconfig.py:92-114` |
| The show's `prompts/<file>.md` for a step | Not measured here — the agent executor's read is outside this document's scope | `tools/src/check-prompts.ts:63` is the only existing pre-flight, and it checks that each `.md` **renders**, not that each step's file **exists** |

**Row four — the config — is the only failure an operator learns about before a run starts.** See F-01.

### 1.5 What has a `_TEMPLATE` today and what does not

| Target | Template | Size | Verdict |
|---|---|---|---|
| `Canon/characters/<Name>/<name>.md` | `Canon/characters/_TEMPLATE.md` | 2,349 B / 54 lines | exists |
| `Canon/species/<name>.md` | `Canon/species/_TEMPLATE.md` | 652 B / 23 lines | exists |
| `Canon/locations/<Name>/...` | `Canon/locations/_TEMPLATE.md` | 762 B / 22 lines | exists |
| `Canon/factions/<name>.md` | `Canon/factions/_TEMPLATE.md` | 888 B / 30 lines | exists |
| `Episodes/<id>/outline.md` | `Episodes/_TEMPLATE/outline.md` | 970 B / 32 lines | **exists and is stale** — see below |
| All **14** top-level `Canon/*.md` | none | — | **no template of any kind** |
| `Canon/refs.json` | none | — | no template |
| `Production/voice-refs/refs.json` | none | — | no template |
| `Episodes/<id>/premise.md` | none | — | no template; written by hand or by the console's `POST /api/episodes` (`console/server/app.ts:269-287`) |
| `showrunner.json` | none in the show; `scripts/tests/fixtures/showrunner.json` is the engine's test fixture | — | no template |

**`Episodes/_TEMPLATE/outline.md` is a declared input of the `outline` step (`engine/src/pipelines/episode.ts:172`) and does not teach the format the `outline` prompt requires.** The template's sections are `## Premise`, `## Beat outline`, `## Script`, `## Image / slideshow prompts`, `## Publish package`, `## Post-episode canon updates` (`Episodes/_TEMPLATE/outline.md:7`, `:10`, `:13`, `:16`, `:22`, `:28`). The prompt requires `## Scene synopsis` first (`prompts/outline.md:31`), `## Cast` (`:68`), `## Arc beats` (`:65`), `## New canon proposed` (`:89`), `## Ending duties` (`:83-85`) and `### Beat <n>` headers — the last because the `draft` loop derives its progress by counting `/^### Beat \d+/` in the outline (`engine/src/pipelines/episode.ts:203`). **None of those six appears in the template.** The prompt papers over the gap by naming the archive instead: "Read `Episodes/ep01/outline.md` — your output must match its format and rigor… Also read `Episodes/_TEMPLATE/outline.md` for the base template" (`prompts/outline.md:21`, `:25`). See F-04.

### 1.6 The two reference indices, and what they point at

Both are the `NEEDS_REFS` probe's data, and neither has a template.

**`Canon/refs.json`** — 26,817 B, 26 top-level keys: 5 documentation keys (`_doc`, `_ruled`, `_source`, `_workflow`, `_shard_scale`, skipped by the `startsWith("_")` filter at `engine/src/needs.ts:70`) and **21 entries**. Every entry carries exactly four fields — `kind`, `ref`, `identity`, `locked` — and three also carry `baseline_prompt`, one `exemplar`, one `note`. The probe reads only `ref` and requires the file at it to exist (`engine/src/needs.ts:97-100`); all 21 `ref` paths are distinct and all 21 resolve on disk today; `kind` is constrained by `showrunner.json:108-112` to `human`, `creature`, `ship`. Declared as an input by `visual-direction` (`:275`), `visual-direction-fix` (`:281`), `image-generate` (`:287`), `nano-banana-generate` (`:288`), and staged by `assets-commit` (`:326`).

**`Production/voice-refs/refs.json`** — 6,966 B, 5 top-level keys (`engine`, `model`, `note`, `cast`, `notes_ear`); `cast` holds **9 entries**, each with `ref`, `ref_text`, `status`, `direction` and optionally `speed`, `temperature`, `registers`, `arc_note`, `fx`, `note`. The probe reads `status` and `ref`, and requires `status` to contain the literal `LOCKED` (`engine/src/needs.ts:109-112`); the show's nine statuses all read `LOCKED (...)`. Ten `.wav` files sit beside it (`Production/voice-refs/`), one per cast key. Declared as an input by `tts-script` (`:250`).

**`Canon/voice-registry.md`** (23,724 B / 290 lines) is declared twice — `tts-script` (`:250`) and `validate-manifest` (`:252`) — and `scripts/validate-manifest.py:74` resolves it through `audio.voiceRegistry`. Its own header states the division: "source of truth: `Production/voice-refs/refs.json`" (`Canon/voice-registry.md:13`), so the registry is prose about a JSON file the pipeline also reads directly.

### 1.7 The directories, and who creates them

| Directory | Created by | Must pre-exist? |
|---|---|---|
| `Canon/` | the author | **yes** — 14 files and 4 subdirectories are read from it |
| `Canon/characters/` | the author; also **written** by `registry-append.py:118` (the casting pile) and staged by `assets-commit` (`:326`) | yes |
| `Canon/species/`, `locations/`, `factions/` | the author | yes, if the outline cites them |
| `Canon/_candidates/` | `scripts/design-visual.py:62` (`visual.candidatesDir`) | no |
| `Episodes/_TEMPLATE/` | the author | yes — declared input at `:172` |
| `Episodes/<id>/` | the console's `POST /api/episodes` (`console/server/app.ts:279`, `mkdir recursive`) | no |
| `Production/<id>/` | the first run; "that directory is a run's to create" (`console/server/app.ts:268`) | no |
| `Production/<id>/runs/` | `EventLog` | no |
| `Production/voice-refs/` | the author, by ear (spec §9.3 at `:230`) | yes, once a recurring character speaks |
| `Production/<id>/guest-refs/` | the author, by ear (`engine/src/needs.ts:77`) | no |
| the NAS at `output.nasRoot` | mounted by hand; the `nas-mounted` guard fails otherwise (`:330-333`) | yes, before the assemble phase |

### 1.8 The `showrunner.json` keys a new show must supply

**Eight keys are required, and both loaders enforce the same eight.** `scripts/lib/showconfig.py:53-62` lists them as dotted paths and `:22-25` states the mirror rule; `engine/src/show-config.ts:91-109` is the reference implementation.

| Required key | Checked how | Dead Light's value |
|---|---|---|
| `showName` | non-empty string (`show-config.ts:92`) | `"Dead Light"` (`showrunner.json:2`) |
| `showSlug` | non-empty string (`:93`) | `"DeadLight"` (`:3`) |
| `promptsDir` | non-empty string (`:94`) | `"prompts"` (`:4`) |
| `models.medium` | non-empty string (`:96`) | `"claude-sonnet-5"` (`:10`) |
| `models.large` | non-empty string (`:97`) | `"claude-opus-4-8"` (`:11`) |
| `models.writer` | non-empty string (`:98`) | `"claude-fable-5"` (`:12`) |
| `airMap` | object; every key a production id, every value `[season, episode]` of positive integers (`:66-84`; `showconfig.py:119-145`) | ten `epNN` entries (`:14-55`) — **emptied by Plan F** (`docs/plans/2026-09-28-show-config-and-prompts-deferred.md:37`) |
| `output.nasRoot` | non-empty string (`:103`) | `"/Volumes/media/DeadLight"` (`:58`) |

**Optional, with the engine's default stated in code:**

| Key | Default | Where the default lives |
|---|---|---|
| `canonDir` | `"Canon"` | `engine/src/pipelines/episode.ts:60` |
| `episodesDir` | `"Episodes"` | `:61`; also `console/server/show.ts:85`, `engine/src/needs.ts:45` |
| `productionDir` | `"Production"` | `:62`; also `console/server/show.ts:84`, `engine/src/needs.ts:46` |
| `models.small` | none; omitted from the loaded config (`show-config.ts:99`) | no step uses `small` |
| `output.nasMount` | none | not read by the engine |
| `output.finalFilename` | none | read by `scripts/finalize-video.py` |
| `output.mixFilename` | `"{slug} S{season:02d}E{episode:02d}.wav"` | `engine/src/show-config.ts:149`; unmapped-id fallback `"episode.wav"` at `:152` |
| `output.videoFilename` | `"episode.mp4"` | `engine/src/pipelines/episode.ts:74` |
| `audio.voiceRefsDir` | `"Production/voice-refs"` | `:67`; `engine/src/needs.ts:47` |
| `audio.voiceRegistry` | `"<canonDir>/voice-registry.md"` | `:68` |
| `visual.refs` | `"<canonDir>/refs.json"` | `:69`; `engine/src/needs.ts:48` |
| `visual.style` | `"<canonDir>/visual-style.md"` | `:70` |
| `visual.castingPileDir` | `"<canonDir>/characters"` | `:71` |
| `publish.guide` | `"<canonDir>/publishing-guide.md"` | `:72` |
| `video.compositionId` | `"Episode"` | `:73` (O-03: nothing else reads the config key) |

**Four whole groups — `audio`, `visual`, `video`, `publish` — are typed `Record<string, unknown>` and validated only as objects** (`engine/src/show-config.ts:24-27`, `:114-117`). Every key inside them is read with `sc.value(...)` or `sc.path(...)` by a Python script and fails by dotted name at run time if absent (`scripts/lib/showconfig.py:177-202`). Dead Light supplies **46 leaf values** across those four groups out of 71 total (audio 18, visual 10, video 10, publish 8). The ones a script requires with **no default** include `audio.titleCardGapMaxSeconds`, `audio.sceneTransitionGapMaxSeconds`, `audio.authoredPauseRangeSeconds`, `audio.mainCast` (`scripts/validate-manifest.py:70-73`), `visual.auditLaws`, `visual.styleConstants`, `visual.collectivePopulatorBans` (`scripts/nano-banana-generate.py:423-427`), and `visual.candidatesDir` (`scripts/design-visual.py:62`). See F-02.

---

## 2 · The prompts, measured for show-specificity

### 2.1 The set

**51 files in `prompts/`; the episode pipeline's set is 44.** The seven excluded are the season-desk prompts `apply.md`, `arc-tracker.md`, `craft-critic.md`, `desk-editor.md`, `desk-gate.gate.md`, `desk-gate.reject.md`, `thread-auditor.md` — referenced by no step (O-04). The 44 are 34 `.md` prompts the pipeline names, 8 `.schema.json` files, `prompts/README.md` (skipped by the checker at `tools/src/check-prompts.ts:63`) and `prompts/index.json` (frozen, deletable at cutover — `prompts/README.md:9`, `docs/plans/2026-10-02-the-console-deferred.md:20`).

The 34 are named at 20 literal `promptFile`/`messageFile`/`schemaFile` sites in `engine/src/pipelines/episode.ts` (`:117`, `:130` ×2, `:170`, `:188`, `:191`, `:199`, `:225`, `:228`, `:234`, `:248`, `:254`, `:265`, `:273`, `:280`, `:291`, `:318`, `:351`, `:374`, `:381`), plus 8 `.reject.md` literals passed to `fixAgent` (`:192`, `:229`, `:255`, `:266`, `:292`, `:319`, `:352`, `:382`), plus `canon-review-outline.md` (`:178`) and `canon-review-script.md` (`:210`), plus the 6 reviewers whose prompt and schema names are built from the step id at `:112`.

### 2.2 The table

Columns are counts of **sites**, with the line numbers that matter. "Bible files read" is what the prompt body names, which is not always what the step declares.

| Prompt file | Lines | Show-name sites | Character / place sites | History sites | Tool-generic sites | Bible files the body names | Convention sites | Class |
|---|---|---|---|---|---|---|---|---|
| `outline.md` | 106 | 1 (`:1`) | 5 (`:17`, `:18`, `:74`, `:75`, `:76`) | 3 (`:21` ep01, `:27` 2026-08-23, `:60` ep01) | 0 | `world-overview`, `series-arc`, `episode-formula`, `story-craft`, `continuity-ledger`, `style-guide`, `timeline`, `characters/`, `species/`, `locations/`, `factions/`, `characters/The Mute/the-mute.md`, `technology` (`:8-18`) | `## Cast` grammar (`:68-79`) | generalise |
| `canon-review-outline.md` | 47 | 1 (`:1`) | 1 (`:7`) | 1 (`:23` — the engine's provenance rule) | 0 | `world-overview`, `technology`, `timeline`, `continuity-ledger`, `season-{{season}}`, `characters/The Mute/the-mute.md` (`:5-7`) | `## Cast` grammar (`:17-18`); provenance rule (`:23`) | generalise |
| `outline-revise.md` | 16 | 1 (`:1`) | 0 | 0 | 0 | — | locked beats (`:10`) | parameterise |
| `outline-gate.gate.md` | 11 | 0 | 0 | 0 | 0 | — | Scene-synopsis rule (`:6-8`) | engine-generic as is |
| `outline-gate.reject.md` | 19 | 1 (`:11`) | 0 | 2 (`:1` Ryan-ruled 2026-08-28, `:6` ep09 13,152 words) | 0 | `Canon/` (`:18`) | revise-in-place (`:1-5`) | generalise |
| `draft.md` | 79 | 1 (`:1`) | 0 | 3 (`:6`, `:18`, `:26` ep01 / `ep*`) | 0 | `style-guide`, `story-craft`, `technology` (`:5`, `:8`, `:43`) | `DRAFT_COMPLETE` sentinel (`:73-77`) | generalise |
| `canon-review-script.md` | 50 | 1 (`:1`) | 2 (`:10`, `:18`) | 1 (`:24` — the engine's provenance rule) | 0 | `technology`, `characters/The Mute/the-mute.md`, `timeline`, `continuity-ledger`, `world-overview` (`:10`) | provenance rule (`:24`) | generalise |
| `tone-check.md` | 29 | 1 (`:1`) | 0 | 1 (`:3` ep01) | 0 | `style-guide` (`:2`) | verdict string (`:29`) | generalise |
| `flow-check.md` | 35 | 1 (`:1`) | 1 (`:26` Remo, Cricket — an example) | 0 | 0 | `episode-formula`, `style-guide` (`:3`) | verdict string (`:35`) | parameterise |
| `character-check.md` | 42 | 1 (`:1`) | 3 (`:22`, `:25`, `:26`) | 0 | 0 | `characters/**`, `world-overview`, `style-guide` (`:10`, `:14`, `:18`) | `## Arc beats` (`:8-9`) | generalise |
| `structure-check.md` | 29 | 1 (`:1`) | 0 | 0 | 0 | `story-craft`, `episode-formula` (`:5-6`) | verdict string (`:28-29`) | parameterise |
| `environment-check.md` | 42 | 1 (`:1`) | 1 (`:21`) | 0 | 0 | `technology`, `locations/` (`:8`) | verdict string | generalise |
| `repetition-check.md` | 45 | 1 (`:1`) | 0 | 2 (`:8` `ep*` glob, `:36-37` ep03/ep04) | 0 | `style-guide` (`:4`) | verdict string (`:45`) | generalise |
| `revise.md` | 29 | 1 (`:1`) | 0 | 0 | 0 | `style-guide` | `REVISIONS_COMPLETE` sentinel | parameterise |
| `script-gate.gate.md` | 10 | 0 | 0 | 0 | 0 | — | the panel's seven result slots (`:2-9`) | engine-generic as is |
| `script-gate.reject.md` | 5 | 1 (`:1`) | 0 | 0 | 0 | `style-guide` (`:4`) — **and its "retention contract" section by name** (`:5`) | — | generalise |
| `publish-copy.md` | 14 | 1 (`:1`) | 0 | 0 | 0 | `publishing-guide` | — | parameterise |
| `tts-script.md` | 185 | 1 (`:1`) | 9 (`:43`, `:46`, `:47`, `:48`, `:64`, `:65`, `:144`, `:145`, `:147`) | 6 (`:63`, `:75`, `:84`, `:115`, `:153`, `:157`) | 13 (`:7`, `:11`, `:18`, `:21`, `:115`, `:129`, `:138`, `:151`, `:152`, `:155`, `:162`, `:164`, `:172`) | `voice-registry`, `pipeline-artifacts`, `Production/voice-refs/refs.json` (`:7-15`) | `[SPEAKER]` grammar (`:63-65`) | **rewrite** |
| `casting-gate.gate.md` | 7 | 0 | 0 | 0 | 0 | — | — | engine-generic as is |
| `casting-gate.reject.md` | 7 | 1 (`:1`) | 0 | 0 | 0 | `voice-registry` (`:6`) | — | parameterise |
| `audio-gate.gate.md` | 4 | 1 (`:2` — the **slug**, in a glob) | 0 | 0 | 0 | — | — | parameterise |
| `audio-gate.reject.md` | 10 | 1 (`:1`) | 0 | 0 | 0 | — | "the pipeline re-runs…" (`:7-9`) | parameterise |
| `visual-direction.md` | 107 | 3 (`:1`, `:88`, `:95` — `:88`/`:95` are the **ship**, not the title) | 3 (`:50`, `:84`, `:94`) | 1 (`:88` Ryan-ruled 2026-07-28; ep03) | 7 (`:3`, `:11`, `:24`, `:67`, `:69`, `:80`, `:107`) | `visual-style`, `refs.json` (`:6`, `:11`) | `source` field (`:99-104`); shot-id grammar (`:97`) | **rewrite** |
| `visual-direction-fix.md` | 12 | 1 (`:1`) | 0 | 0 | 0 | `refs.json`, `visual-style` | "the pipeline re-runs the check" (`:10`) | parameterise |
| `nano-banana-gate.gate.md` | 11 | 0 | 1 (`:8` — an example shot id) | 0 | filename | — | — | parameterise |
| `nano-banana-gate.reject.md` | 27 | 1 (`:1`) | 1 (`:5` — an example shot id) | 0 | filename | `refs.json` (`:23`) | "as its own step, before this gate reopens" (`:10`) | parameterise |
| `image-audit.md` | 51 | 1 (`:1`) | 0 | 0 | 3 (`:21`, `:24`, `:25`) | `visual-style` (`:6`) — **not** `visual-audit-laws` | `source` field (`:42`); "the pipeline regenerates" (`:43-44`) | generalise |
| `image-gate.gate.md` | 4 | 0 | 0 | 0 | 1 (`:4`) | — | — | parameterise |
| `image-gate.reject.md` | 12 | 1 (`:1`) | 0 | 0 | 0 | — | "the pipeline runs… as its own step" (`:5-6`) | parameterise |
| `final-gate.gate.md` | 9 | 0 | 0 | 0 | 0 | — | — | engine-generic as is |
| `final-gate.reject.md` | 17 | 1 (`:1`) | 0 | 0 | 0 | — | "the pipeline re-runs the timeline build, the render and the master" (`:10`) | parameterise |
| `propose.md` | 57 | 1 (`:1`) | 0 | 1 (`:42` ep10's pattern) | 0 | `continuity-ledger`, `timeline` (`:9`, `:14`, `:16`), every entity file (`:10-11`), the entity `_TEMPLATE`s (`:29`), `technology` change log (`:31`) | the ledger-row convention (`:37-42`) | parameterise |
| `canon-gate.gate.md` | 12 | 0 | 0 | 0 | 0 | — | the deviation ledger (`:8`) | engine-generic as is |
| `canon-gate.reject.md` | 14 | 1 (`:1`) | 0 | 0 | 0 | — | — | parameterise |

### 2.3 Totals

| Measure | Count | Notes |
|---|---|---|
| Prompts carrying the show's name | **27 of 34** | 29 sites. **26 of the 27 carry it in the prompt's first line, in the role declaration** — "You are the `<role>` for *Dead Light*". The exceptions are `outline-gate.reject.md:11` (the role line is eleventh, under the size-discipline preamble) and `audio-gate.gate.md:2`, which carries the **slug** inside a filename glob rather than the name in prose |
| Prompts **not** carrying the show's name | **7 of 34** | and all seven are gate messages: `outline-gate.gate`, `script-gate.gate`, `casting-gate.gate`, `nano-banana-gate.gate`, `image-gate.gate`, `final-gate.gate`, `canon-gate.gate`. The eighth gate message, `audio-gate.gate.md`, is the one that does |
| Prompts carrying a character, ship or place name | **10 of 34** | 27 sites. Concentrated: `tts-script.md` 9, `outline.md` 5, `character-check.md` 3, `visual-direction.md` 3 |
| Prompts carrying an episode-history lesson | **10 of 34**, 21 sites | **8 of 34, 19 sites** if the two canon reviewers' "showrunner-ruled 2026-09-25" (`canon-review-outline.md:23`, `canon-review-script.md:24`) is counted as the engine's provenance rule rather than a show lesson — it restates spec §2.2 (`:57`) |
| Prompts carrying a production-tool name | **4 of 34** in the body (24 sites: `tts-script` 13, `visual-direction` 7, `image-audit` 3, `image-gate.gate` 1), plus **2** whose filename is the vendor's | The vendor names are **also in the engine**: 13 sites in `engine/src/pipelines/episode.ts` (the `nano-banana-generate` and `nano-banana-gate` step ids and the script filename), 13 in `scripts/tts-generate.py`, 22 in `scripts/render-video.py`, 8 in `scripts/image-generate.py`. So tool-specific prompt content is **engine-generic, not show-specific** — see F-06 |
| Prompts that are engine-generic as is | **5 of 34** | `outline-gate.gate`, `script-gate.gate`, `casting-gate.gate`, `final-gate.gate`, `canon-gate.gate` — every one a gate message, 49 lines in total |
| Prompts using `{{show.<path>}}` | **0 of 34** | The variable exists and is documented (`prompts/README.md:7`), the renderer supports it, and `tools/src/check-prompts.ts:54` supplies `show` to it. Every one of the 29 show-name sites is a literal |

### 2.4 The classification, and the rule used

**Parameterise** means the prompt's content is show-generic craft or engine mechanics, and what changes for a second show is the name plus at most an illustrative example that states no law. **Generalise** means the prompt states one of the show's laws inline, and that law belongs in a bible file the prompt already reads by name. **Rewrite** means the prompt is a measured lesson from this show's production history top to bottom. **Engine-generic as is** means no show-specific content at all, not even the name.

| Class | Count | Files | Lines |
|---|---|---|---|
| engine-generic as is | **5** | `outline-gate.gate`, `script-gate.gate`, `casting-gate.gate`, `final-gate.gate`, `canon-gate.gate` | 49 |
| parameterise | **16** | `outline-revise`, `flow-check`, `structure-check`, `revise`, `publish-copy`, `casting-gate.reject`, `audio-gate.gate`, `audio-gate.reject`, `visual-direction-fix`, `nano-banana-gate.gate`, `nano-banana-gate.reject`, `image-gate.gate`, `image-gate.reject`, `final-gate.reject`, `propose`, `canon-gate.reject` | 298 |
| generalise | **11** | `outline`, `canon-review-outline`, `canon-review-script`, `outline-gate.reject`, `draft`, `tone-check`, `character-check`, `environment-check`, `repetition-check`, `script-gate.reject`, `image-audit` | 515 |
| rewrite | **2** | `tts-script` (185), `visual-direction` (107) | 292 |

**Twenty-one of the thirty-four — 347 of 1,154 lines — need nothing but a name substitution or nothing at all.** The eleven to generalise are 515 lines and are exactly the eleven that judge story and picture; the two to rewrite are 292 lines, 25% of the set, and both are the step that turns an approved artifact into a production specification.

**What "generalise" costs, measured on the three clearest cases.**

- `character-check.md:14-17` tells the auditor to read `Canon/world-overview.md` "The primary crew" for each member's stance, then restates the role dynamics inline at `:25-27` ("Sarn commands and is obeyed like a captain; Cricket needles from the walls; Trent overreaches; Sable steadies"). `Canon/world-overview.md:25` is `## The primary crew`. The inline restatement is redundant with a section the prompt already names.
- `environment-check.md:8` names `Canon/technology.md` for "gravity and comms rules", then states the vacuum discipline inline at `:20-30`, including "Opha uses her bespoke EVA shell — see characters/opha.md". `Canon/technology.md:95` is `## Noise & Silence Protocols`.
- `image-audit.md:6` reads `Canon/visual-style.md` (21,370 B) and restates six audit laws at `:8-14`, while the **Python** side of the same audit reads `Canon/visual-audit-laws.md` (1,303 B, 8 numbered laws) through `visual.auditLaws` (`scripts/nano-banana-generate.py:425`). **Two audits, two source files, one set of laws.** See F-12.

### 2.5 The conventions every show needs, with their addresses

Six conventions are written by prompts and read by machine or by the next prompt, so a new show's prompt set must carry all six or the pipeline breaks rather than a prompt reading oddly.

| Convention | Written where | Read where |
|---|---|---|
| **The `## Cast` grammar** — `- <Name> (<tags>)`, tags from `recurring`, `guest`, `speaks`, `location` | `prompts/outline.md:68-79`; checked by `prompts/canon-review-outline.md:17-18` | `parseCastSection` (`engine/src/needs.ts:15-27`), which routes on the three subject tags at `:88` and reports a malformed line rather than dropping it (`:81`); documented at `prompts/README.md:22` |
| **The `source` field** — `"pipeline"` (default) or `"showrunner"` | `prompts/visual-direction.md:99-104`; honoured by `prompts/image-audit.md:42` | `missingShowrunnerImages` (`engine/src/needs.ts:136`), the `showrunner-images` guard (`engine/src/pipelines/episode.ts:296-300`), and `scripts/nano-banana-generate.py:436-437`; documented at `prompts/README.md:23` |
| **The `::progress` line** — `::progress {"done":…,"total":…,"unit":…}` | `scripts/lib/showconfig.py:263-270` (the one writer; the prompts never emit it) | `engine/src/script-step.ts` parses stdout lines beginning `::progress`; spec §6.7 (`:180`). **No prompt teaches it, and no prompt needs to** |
| **The canon reviewer's provenance rule** — agents adhere to canon, the showrunner overrides it, the ledger records the overrides | `prompts/canon-review-outline.md:23`, `prompts/canon-review-script.md:24`, each with a `showrunner-ruled 2026-09-25` stamp | spec §2.2 (`:57`); the ledger rows reach `scripts/canon-ledger.py` through `ctx.results[reviewId].deviations` (`engine/src/pipelines/episode.ts:123`) |
| **The rejection prompts' "the pipeline re-runs" sentence** | 6 sites: `audio-gate.reject.md:8`, `final-gate.reject.md:10`, `image-gate.reject.md:5-6`, `nano-banana-gate.reject.md:10`, `visual-direction-fix.md:10`, `image-audit.md:43-44`; plus `prompts/visual-direction.md:107` and `tts-script.md:138` for the two no-run rules | The sentences exist because `rerunOnReject` re-runs those steps (`engine/src/pipelines/episode.ts:193`, `:230`, `:256`, `:267`, `:293`, `:320`, `:353`, `:383`). Nine of the ten replacements in `tools/show-data/deadlight-overrides.json` wrote them, replacing Archon-era `uv run .archon/scripts/...` instructions |
| **The loop sentinels** — `DRAFT_COMPLETE`, `REVISIONS_COMPLETE`, `OUTLINE_FIXED`, `IMAGES_CLEAN`/`IMAGES_FAILING`, `DRAFT PASSED`/`DRAFT FAILED` | `prompts/draft.md:73-77` (with the warning that the engine matches the exact string), `prompts/revise.md`, `prompts/outline-revise.md`, `prompts/image-audit.md:51`, the six reviewers' last lines | `until:` on the three loops (`engine/src/pipelines/episode.ts:187`, `:197`, `:224`) and the eight `.schema.json` files |

---

## 3 · How Dead Light's bible came to be

**Conclusion: the pattern spec §9.2 names already exists in two measurable forms, and they are different documents with different jobs.** The **spec** is the interview's transcript — a long argued document with rulings, dates and costs. The **bible file** is its product — a short declarative file of laws, each carrying the date and origin of the ruling that made it. Spec §9.2 (`:228`) says the interview "writes each file from the author's answers; the model supplies structure and the house format, never content", and that "this is the pattern that produced the two Season 2 specs and `Canon/season-2.md` by hand." Both halves are on disk.

### 3.1 The spec half — what a Ryan-ruled document looks like

`docs/superpowers/specs/2026-09-17-season-2-design.md` is 14,070 B. Its header carries four load-bearing lines: **Status** ("APPROVED in session by Ryan (rulings inline, marked **Ryan-ruled**)", `:3`), **Scope** with an explicit exclusion ("NOT an episode slate — the twenty rows come later, from this", `:4`), **Supersedes** (`:5`), and a ground-truth verification line naming the files and the date it was checked against (`:7`).

Its §0 is "The one rule this document lives under" (`:11`), and the rule is about deviation, not content: "**A plan is a forecast, not a contract**… when Season 2 deviates from this spec — and it will — the job is to **name what the deviation touches and what goes unpaid downstream, then proceed.** Never argue the change" (`:13`, `:15`). It names the mechanism that already works — "the **AS SHIPPED** pattern used on ep10 (`season-1.md` row 10, `sable.md:69`, `trent.md:66`, `sarn.md`)" (`:15`) — and closes with the rule every beat obeys: "**Every beat in this document therefore carries what it is load-bearing for**, so the cost of moving it can be stated in one line" (`:17`).

Its §1 is a three-row table of what carries forward (`:25-29`) with values `STANDS`, `STANDS — cannot be unmade`, `CLEARED — available, not binding`, followed by a "**Binding start position**" sentence enumerating seven facts with one citation (`continuity-ledger.md:33`) at `:31`. **Rulings are marked inline, in bold, with the date where the date matters:** `**Ryan-ruled.**` (`:37`, `:39`, `:45`), `**Ryan-ruled 2026-09-22**` (`Canon/season-2.md:31`).

The companion `docs/superpowers/specs/2026-09-18-season-2-mechanisms-design.md` is 39,379 B — 2.8× the first — and is cited by `Canon/season-2.md:8` as governing "the mechanisms beneath the shape". **Two specs, 53,449 B, produced one 35,528 B bible file.**

### 3.2 The bible half — `Canon/season-2.md`

139 lines, 35,528 B, six headings: `# Season 2 — The Slate`, `## Season laws`, `## The slate`, `## Load-bearing dependencies`, `## Open questions this slate does not decide`, `## Change log` (`:1`, `:24`, `:66`, `:91`, `:114`, `:128`).

Its head is a six-part blockquote (`:3-22`) and every part is a rule about the file rather than content: what the file is ("Author-facing season plan", `:3`); **Source of authority** — "This slate is produced by two specs and does not override either… Where this file and a spec disagree, the spec governs" (`:6-10`); **Arc position at season end** (`:12-14`); **Status legend** — "**RULED** means Ryan-approved and binding. **DRAFT** means a proposed skeleton" with the date each applies from (`:16-19`); **Working titles are working titles** (`:21-22`).

`## Season laws` holds six laws in 42 lines (`:26-65`). Each is one bold proposition followed by its reasoning, its scope, and its provenance: "**The crew never intentionally wakes a Vanished relic.** This holds for all twenty episodes… **Ryan-ruled.**" (`:26-29`); "**No relic is ever activated aboard a populated station, port, or settlement.**… The reason is recorded at `characters/The Mute/the-mute.md` under 'Writing discipline.' **Ryan-ruled.**" (`:30`); the third law carries its full address — "**Ryan-ruled 2026-09-22**; recorded at §3.2.2 of the 2026-09-18 mechanisms spec" (`:31`).

### 3.3 The target shape per file, measured

All **17** top-level `Canon/*.md`, with their level-2 headings as the interview's section list. **Eight of the seventeen are under 10 KB and are authorable; six are grown by production or by the deferred desk and start near-empty.**

| File | Bytes | Lines | Top-level headings | Authorable at setup? |
|---|---|---|---|---|
| `world-overview.md` | 5,676 | 45 | 11 — Logline · Premise · Tone & genre · The rules of the universe (load-bearing — do not contradict) · Structure · The primary crew · Recurring engine for stories · The central irony · What makes it distinctive · Locked · Open questions / to decide | **yes** — the clearest interview target; `Canon/README.md:9` says it changes "Rarely" |
| `style-guide.md` | 9,005 | 110 | 7 — Narration · The core technique · Hard staging constraint (BINDING, Ryan-ruled 2026-09-22) · The retention contract (BINDING — Ryan-ratified 2026-07-18 after the ep01 cold-open A/B) · Rules of voice · Cadence · Character voices | **yes**, but two of the seven sections are named in prompts (`script-gate.reject.md:5`, `tone-check.md:13`) and carry A/B-test provenance |
| `episode-formula.md` | 3,282 | 54 | 6 — Target · Beats · Per-episode variables · The default antagonist · Death rules (load-bearing dramaturgy — learned from ep99) · Serialized thread | **yes** |
| `story-craft.md` | 4,537 | 75 | 7 — The causality law (BUT/THEREFORE) · The circle · Scenes: enter late, leave early · Setup/payoff · Endings — the "so what?" test (the part ep99 failed) · Openings · What the structure auditor checks | **mostly engine-generic craft** — see F-11 |
| `series-arc.md` | 7,879 | 52 | 9 — The core of the arc · Origin · The locked truth (authors only — two layers) · Discovery escalation · The three theories · Pacing rule · The propulsive engine · Governing principle — withhold by default · Character hook | **yes** |
| `technology.md` | 26,379 | 116 | 9 — Governing principle · The tiers · Tier 0 Human tech · Tier 1 Vanished tech · Tier 0.5 Elder mortal races' tech · Tier 2 "The Silence's" tech · Travel anchors (episode math — do not contradict) · Noise & Silence Protocols · Change log | **partly** — 26 KB and a change log; the tiers are authorable, the accumulated laws are not |
| `timeline.md` | 2,288 | 25 | 3 — Eras · Fixed historical events · "Present day" baseline | **yes**; also **written** by `propose` (`engine/src/pipelines/episode.ts:377`) |
| `visual-style.md` | 21,370 | 311 | 16 — The look · Palette · Composition rules · EXPOSURE LAW (added 2026-07-18, first-viewer feedback) · Mandatory prompt scaffolding · QC: the vision audit is the gate · Prompt vocabulary — de-ambiguation (LAW, learned from ep99) · THE HARD LINE (LAW, Ryan-ruled 2026-07-25) · THE CASTING REGISTRY · SPECIES LAW (7 of 10 canon failures in the ep01 re-render) · NEGATION LAW · INTERIOR PREFIX · THE VISUAL BIBLE · Recurring visual motifs · Per-episode counts · Model note (2026-07-12) | **partly** — 8 of 16 headings carry a production lesson's date |
| `visual-audit-laws.md` | 1,303 | 21 | 0 — one `#` heading and 8 numbered laws | **yes** — 8 numbered laws; the smallest file in the bible and the one the generator cannot run without |
| `voice-registry.md` | 23,724 | 290 | 6 — Qwen3 cast (LOCKED 2026-07-15) · Locked · Auditioning · Guest characters · Mixing conventions (learned from the ep99 cold-open spike) · FX chain conventions | **no, not at setup** — spec §9.3 (`:230`) puts voices behind `NEEDS_REFS` |
| `publishing-guide.md` | 4,602 | 65 | 5 — Per-episode, generated · Standing choices + why · The one thing that needs a human/visual · Monetization guard (from the 2026 policy research) · Series structure | **yes** |
| `pipeline-artifacts.md` | 8,836 | 128 | 6 — Artifact catalog · Folder convention · Script dialogue attribution (ruled 2026-09-09, from ep10) · Storage policy · Per-episode `STATUS.md` · Launching the workflows | **engine documentation in the show's bible** — `STATUS.md` and the launch section retire with console v1 (`docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:30`); see F-14 |
| `continuity-ledger.md` | 79,679 | 241 | 4 — How to use · Open threads · Resolved · Episode log | **no** — written every episode by `propose` (`:377`); starts as four empty headings |
| `season-1.md` | 36,577 | 66 | 5 — Season laws · The slate · Consistency pass · Banked beyond-season seeds · Change log | **no** — the season-planning capability is deferred (spec `:34`) |
| `season-2.md` | 35,528 | 139 | 5 (§3.2) | **no** — same |
| `README.md` (`Canon/README.md`) | 4,765 | 56 | 6 — What lives where · The two-way rule · The two-lens rule · Episode ids in prose · Naming · Status vocabulary | **the house format itself** — no step reads it; see F-13 |
| `season-desk-report.md` | 27,292 | 86 | 4 | **no** — the deferred desk's output (spec `:35`) |

**The pattern every heading shares: a law carries the date and the origin of the ruling that made it.** `visual-style.md` has eight such stamps in sixteen headings; `episode-formula.md:33` reads "learned from ep99"; `story-craft.md:46` reads "the part ep99 failed"; `style-guide.md:23` reads "BINDING — Ryan-ratified 2026-07-18 after the ep01 cold-open A/B". **A new show's bible can carry no such stamp on day one, because it has no ep99 and no A/B.** See F-08.

---

## 4 · The repository-creation step

### 4.1 What `gh` offers, measured on this machine

`gh --version` → **`gh version 2.95.0 (2026-06-17)`**.

`gh auth status`, run read-only on 2026-10-02, exit 0:

```
github.com
  ✓ Logged in to github.com account MrMophandle (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

**The token is a `gho_` OAuth token held in the macOS keyring, and its `repo` scope is sufficient to create a repository.** The account is `MrMophandle`, which is the owner of both repositories under measurement (the show's merges are "Merge pull request #6 from MrMophandle/archive-markers").

`gh repo create --help` states the three shapes Plan G can use. The non-interactive one: "To create a remote repository non-interactively, supply the repository name and one of `--public`, `--private`, or `--internal`." The one that matches §9.1's "creates the repository locally and on GitHub": "To create a remote repository from an existing local repository, specify the source directory with `--source`. By default, the remote repository name will be the name of the source directory." And "Pass `--push` to push any local commits to the new repository." Relevant flags: `--source`, `--push`, `--private`, `--public`, `--description`, `--remote`, `--clone`, `--gitignore`, `--add-readme`, `--license`, `--disable-issues`, `--disable-wiki`.

**`gh repo create --source … --push --private` is one command, and it requires an initialized local repository with at least one commit.** So the order is: make the tree, `git init`, commit, then create the remote — which puts the whole bible interview before the GitHub step, or forces an empty first commit.

### 4.2 The house layout, as the show has it

Spec §9.1 (`:226`) names five: `Canon/`, `Episodes/`, `Production/`, `prompts/`, the show config at the root. The show's top level also holds `README.md` (5,162 B), `docs/`, `.gitignore` (856 B), `.claude/settings.json` (53 B), and — until Plan F — `console/`, `remotion/`, `.archon/`, `package.json`, a `Finalized` symlink to `/Volumes/media/DeadLight`, and `YouTube Upload Fields.png`. **There is no `CLAUDE.md` in the show repository.**

### 4.3 The `.gitignore`, read for what must be ignored from day one

`/Users/ryanperkowski/GitHub/DeadLight/.gitignore`, 38 lines. **Nine of the eighteen path rules are generated-artifact rules a new show needs on its first commit:**

| Rule | Line | Why |
|---|---|---|
| `Production/*/audio/` | `:3` | every synthesized WAV; ep10 alone is 613 segments |
| `Production/*/video/` | `:5` | the render and the master |
| `Production/*/images/*.png` | `:6` | the generated stills; **the shipped frame** |
| `Production/*/images/*.jpg` | `:34` | "pre-conversion JPEGs from Nano Banana" |
| `Production/*/images/.*.bak` | `:35` | re-roll backups |
| `Finalized/`, `Finalized` | `:12`, `:14` | the NAS symlink (two rules for one target) |
| `.DS_Store` | `:1` | macOS |
| `__pycache__/`, `*.pyc` | `:19`, `:20` | Python bytecode — **belongs to the engine after Plan F** |
| `console/node_modules/`, `console/dist/` | `:26`, `:27` | **leave with console v1** (`docs/plans/2026-10-02-the-console-deferred.md:19`) |

The remaining nine are one show's accumulated scratch: `.agent-logs/`, `Production/*/audio-spike/`, `remotion/node_modules/`, `remotion/public/`, `Production/tts-bakeoff/`, `Production/tts-casting/`, `Production/*/images-v1-dark/`, `Canon/visual-refs/_candidates/`, `Production/bakeoff/`, `Production/*/audio-v1-*/`, `.superpowers/`, `Production/*/notes/*.draft.md`, `.playwright-mcp/`. **`Canon/_candidates/` — the directory `scripts/design-visual.py:62` writes to today — is NOT ignored**; the rule at `:13` names the retired `Canon/visual-refs/_candidates/` path, so the show's 34 candidate PNGs are tracked. A new show's `.gitignore` must name `<visual.candidatesDir>` correctly or inherit the same leak. See F-20.

### 4.4 How the console is pointed at a show, measured

**One flag, resolved once at startup, and nothing downstream assumes a single show.** `console/server/main.ts:46`: `const showRoot = flag("show")`; absent, the server prints usage and exits 64 (`:47`). The usage line is `console --show <root> [--engine-root <path>] [--port 4410] [--host] [--operator <name>] [--worker <path to a worker entry>] [--concurrency 7]` (`:43`). `loadShowContext` resolves the root to absolute, loads the config, checks the worker entry exists, and defaults `operator` to `console:<username>` (`console/server/show.ts:71-88`).

`ShowContext`'s own comment states the constraint O-05 lifts: "The server holds one of these and never a second, because a console that could be pointed at two shows at once would have to say which one every route meant, and no route does" (`console/server/show.ts:9-11`). The startup banner prints the show's name: `console: ${ctx.show.showName} at http://...` (`console/server/main.ts:91`).

**The console already creates an episode, and that is the surface §9.4 would extend.** `POST /api/episodes` validates the id against the engine's grammar, requires a non-empty premise, `mkdir -p`s `Episodes/<id>/`, and writes `premise.md` with the `wx` flag so a second operator cannot silently overwrite (`console/server/app.ts:269-287`). Its comment states the scope deliberately: "Creates an episode: one directory with one premise in it, and nothing else. … No `Production/<id>/` is made here: that directory is a run's to create" (`:264-268`). O-06 calls this "the first thing `init` teaches".

### 4.5 The archive marker

`<episodesDir>/<id>/archive.json`, `{stage, note}`, read **only** when the episode has no run logs (`console/server/episodes.ts:105-111`, `:112-131`). A valid marker overrides the derived stage, sets `status: "archived"`, clears every `needs` flag, and carries its note (`:127-130`); an unreadable one leaves the derivation alone and reports itself in `logError` (`:123-126`). Ten exist in the show, one per Season 1 episode. `Episodes/ep01/archive.json`:

```json
{
  "stage": "COMPLETE",
  "note": "Season 1, made by console v1; final on the NAS 2026-07-18"
}
```

Ryan ruled the marker on 2026-10-02 after the Plan E branch review (`docs/plans/2026-10-02-the-console-deferred.md:19`). **A brand-new show has no archive and needs no marker on day one** — but an author migrating episodes made by other means does, and `init` is the only place that would know.

### 4.6 What Plan E's deferred record says about a registry

Verbatim, `docs/plans/2026-10-02-the-console-deferred.md:25`: "A show registry over `--show` (one server, many shows) is Plan G's; `ShowContext` already takes one root and nothing else assumes a single show." The claim is measurable and holds: every engine entry point takes `showRoot` as a parameter — `loadShowConfig(showRoot)` (`engine/src/show-config.ts:55`), `episodeNeeds(showRoot, …)` (`engine/src/needs.ts:143`), `missingRefs(showRoot, …)` (`:60`), `resolveShowPath(showRoot, p)` (`:132`) — and `RunContext` carries `showRoot` per run. Spec §7.3 (`:208`) states the requirement: "The engine operates on a show repository by path. One engine, many shows."

---

## 5 · Findings

| # | Finding | `file:line` | The question Plan G's author must answer |
|---|---|---|---|
| **F-01** | **Nothing checks that a show repository is complete, and a missing bible file is silent.** `hashFile` returns `null` on `ENOENT` and `runScriptStep` runs the step anyway; the eleven guards in the episode pipeline check the previous episode, the premise, hand edits twice, two verdicts, references, images, the audit verdict, the NAS and the canon tree — **none checks that `Canon/` has anything in it.** A new show whose `Canon/style-guide.md` is absent runs the whole write phase and reaches the outline gate with an outline written against nothing. Worse: the absent file hashes `null` twice, so `sameHashes` passes and **writing the file later does not invalidate the completed step.** | `engine/src/hash.ts:5-14`; `engine/src/runner.ts:420`, `:424`, `:434`; `engine/src/pipelines/episode.ts:142`, `:161`, `:175`, `:207`, `:241`, `:296`, `:330`, `:368` | Does `init` end with a completeness check, does the pipeline gain a `bible-ready` guard, or both? A guard is the only one of the two that holds after setup — an author who deletes `Canon/timeline.md` in month three gets the same silence. If it is a guard, what is its list: the 13 declared inputs, the 31 files §1 measures, or a list in `showrunner.json`? And does the cache rule need a fix of its own, so a `null`→hash transition always invalidates? |
| **F-02** | **Forty-six of the show's seventy-one config leaves live in four groups the loader validates only as objects, and at least eight of them are required with no default.** `audio`, `visual`, `video` and `publish` are `Record<string, unknown>` (`engine/src/show-config.ts:24-27`, `:114-117`); `sc.value` raises at run time by dotted name (`scripts/lib/showconfig.py:177-190`). A new show missing `visual.styleConstants` fails inside `nano-banana-generate` after `tts-generate` has already spent up to three hours. O-02 notes unknown top-level groups are dropped silently. | `engine/src/show-config.ts:24-27`, `:110-117`; `scripts/lib/showconfig.py:52-62`, `:177-202`; `scripts/validate-manifest.py:70-73`; `scripts/nano-banana-generate.py:423-427`; `scripts/design-visual.py:62`; `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:44` | Does `init` write a complete `showrunner.json` with every key the scripts read, or a minimal one with the eight required keys? A complete one needs a canonical list, and no such list exists in either repository — the keys are discoverable only by grepping `sc.value` and `sc.path` call sites. Is producing that list Plan G's first task, and does it become a schema the loader enforces? |
| **F-03** | **A new show's prompt set has only two possible sources, and the engine cannot hold the first.** Spec §6.1 (`:152`) puts prompts "in their own files under `prompts/` **in the show repository**… they belong to the show". The engine's own rule forbids a show's name in `engine/`, `scripts/`, `render/`, `tools/src/` or `console/` (`README.md:765`). So the engine may hold **generic templates** (no show named) but not copies of Dead Light's prompts. Measured: 27 of the 34 name the show, 10 name characters, and `prompts/README.md:4` states the division — "These prompts are the show's asset, not the engine's… the engine reads them by file name and never contains their text." | spec `:152`; `README.md:765-778`; `prompts/README.md:4`; §2.3 | Does `init` copy generic templates out of a new engine directory (say `templates/prompts/`), generate the 34 files from the interview, or copy Dead Light's and rewrite them? The third is the only one that preserves the 1,154 measured lines, and it is the one the engine may not host. If templates, where do the 515 generalise-class lines go — into the template, or into the bible file the template reads? |
| **F-04** | **`Episodes/_TEMPLATE/outline.md` is a declared step input that does not teach the format the prompt demands, and the prompt compensates by naming the show's own archive.** The template has six sections; the prompt requires `## Scene synopsis` first, `## Cast`, `## Arc beats`, `## New canon proposed`, `## Ending duties` and `### Beat <n>` headers — **none of the six is in the template.** The `draft` loop's progress is `count(script, /^## /) / count(outline, /^### Beat \d+/)`, so a new show whose outline template lacks `### Beat` headers reports a total of 0 for the whole draft. | `Episodes/_TEMPLATE/outline.md:7`, `:10`, `:13`, `:16`, `:22`, `:28`; `prompts/outline.md:21`, `:25`, `:31`, `:65`, `:68`, `:83-85`, `:89`; `engine/src/pipelines/episode.ts:172`, `:203` | Is the outline template part of the interview's output (so the author's format decisions land in it) or a fixed artifact `init` copies? It is the one `_TEMPLATE` the engine declares as an input, and the only one whose content a machine reads. And does Plan G fix the show's own stale template, or leave it to Plan F? |
| **F-05** | **Four prompts define the show's register by pointing at `Episodes/ep01`, and a new show has no ep01.** Six sites: `prompts/outline.md:21` ("your output must match its format and rigor"), `:60` ("Vary the per-episode variables… against ep01"), `prompts/draft.md:6` ("the canonical register"), `:18` (`Glob Episodes/ep*/script.md`), `:26` ("a title header matching `Episodes/ep01/script.md`'s header format"), `prompts/tone-check.md:3` ("the register made flesh"), `prompts/repetition-check.md:8` (`Glob Episodes/ep*/script.md`). The two globs also **break at Plan F's rename** to `s01eNN`. | `prompts/outline.md:21`, `:60`; `prompts/draft.md:6`, `:18`, `:26`; `prompts/tone-check.md:3`; `prompts/repetition-check.md:8`; spec `:140` (the rename) | What do those six sites say for episode one of a new show — nothing, the template, or a prose description the interview produced? "The register made flesh" is a real dependency: the style guide states rules and the pilot demonstrates them, and a first episode has no demonstration. Does the interview produce a **sample scene** as a bible artifact so `draft.md` and `tone-check.md` have something to point at? And are the two globs rewritten to the aired grammar by Plan F or by Plan G? |
| **F-06** | **The production tools are the engine's, not the show's, so tool-specific prompt content is not a show-specificity problem — it is a coupling problem that Plan G inherits whole.** The §7.4 rule forbids a **show's** name in the engine; it says nothing about a **vendor's**. Measured: 13 vendor-name sites in `engine/src/pipelines/episode.ts` (the `nano-banana-generate` and `nano-banana-gate` step ids, the script filename), 13 in `scripts/tts-generate.py`, 22 in `scripts/render-video.py`, 8 in `scripts/image-generate.py`, 14 in `scripts/nano-banana-generate.py`. Two prompt **filenames** are a vendor's. | `README.md:765`; `engine/src/pipelines/episode.ts:37`, `:288-293`, `:320`, `:336-342`; `prompts/tts-script.md:18`, `:151-172`; `prompts/visual-direction.md:3`, `:67`, `:80`; §2.3 | A second show gets Qwen3 cloning, a local Z-Image builder, Nano Banana and Remotion by construction. Is that stated as a Plan G scope boundary, or does Plan G's `init` ask the author anything about tools? The 24 tool sites in four prompts are then **engine-generic as is** and need no rewrite — which changes `tts-script.md`'s class from "rewrite" to "rewrite its 15 show sites, keep its 13 tool sites". |
| **F-07** | **Whether the interview may cite Dead Light's files is spec §9.5's open question, and the measurement says the register is the thing that would leak, not the facts.** Eight of the seventeen top-level `Canon/*.md` are under 10 KB and are structurally imitable; the leak risk is concentrated in the four whose content **is** a voice: `style-guide.md` (9,005 B; `:84` is "**The narrator never winks at the plot.**", restated as a yardstick at `prompts/tone-check.md:6-9`), `visual-style.md` (21,370 B), `story-craft.md` (4,537 B), `episode-formula.md` (3,282 B). §9.5 states the concern as "a friend's show should not inherit its register". But Ryan is the **first user** (§9, `:224`), and he already has the register. | spec `:234`, `:224`; §3.3; `Canon/style-guide.md:23`, `:84`; `prompts/tone-check.md:6-9`; `Canon/visual-style.md:26`, `:101` | Does the answer differ by user — Dead Light's files as examples for Ryan, headings-only for a friend — and if so, what in the code distinguishes the two? Or does the interview cite **an invented third show**, the way the engine's test fixtures already do (`tools/test/fixtures/workflows/harbor-write.yaml`; `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:49` discusses "The Harbor" as the invented name `slugName` is reasoned about with)? A third show is the only option that works for both users and is the only one that costs anything to write. |
| **F-08** | **Every law in Dead Light's bible carries the date and origin of the ruling that made it, and a new show's bible can carry no such stamp.** Eight of `visual-style.md`'s thirteen headings do (`:26` "added 2026-07-18, first-viewer feedback"; `:83` "learned from ep99"; `:101` "Ryan-ruled 2026-07-25"; `:196` "7 of 10 canon failures in the ep01 re-render"); `episode-formula.md:33` "learned from ep99"; `story-craft.md:46` "the part ep99 failed"; `style-guide.md:23` "Ryan-ratified 2026-07-18 after the ep01 cold-open A/B". The stamps are what make the file trustworthy out of order — and they are all retrospective. | `Canon/visual-style.md:26`, `:83`, `:101`, `:196`, `:224`; `Canon/episode-formula.md:33`; `Canon/story-craft.md:46`; `Canon/style-guide.md:12`, `:23`; `Canon/season-2.md:16-19`, `:31` | What does a day-one law carry instead — the interview's date and a `DRAFT`/`RULED` legend like `Canon/season-2.md:16-19`, or nothing until an episode teaches it something? `season-2.md`'s legend is the measured precedent: "**RULED** means Ryan-approved and binding. **DRAFT** means a proposed skeleton, pending an episode-by-episode walkthrough." Does `init` stamp every law it writes `DRAFT` and leave `RULED` to the gate? |
| **F-09** | **The question list per bible file has two candidate sources on disk and they disagree.** Source one: the file's **own headings** — 11 in `world-overview.md`, 7 in `style-guide.md`, 6 in `episode-formula.md`, 13 in `visual-style.md` (§3.3), which is the shape the author must fill. Source two: the **prompts that read the file**, which name sections rather than files — `script-gate.reject.md:5` needs style-guide's "retention contract"; `tone-check.md:2`, `:13` needs it and "Cadence"; `flow-check.md:3` needs "Written for the ear" and "Cadence"; `character-check.md:14` needs world-overview's "The primary crew"; `:18` needs style-guide's "Character voices"; `structure-check.md:5-6` needs story-craft's whole rubric and episode-formula's "Death rules"; `repetition-check.md:4` needs style-guide's "No descriptor tics". | §3.3; `prompts/script-gate.reject.md:5`; `prompts/tone-check.md:2`, `:13`; `prompts/flow-check.md:3`; `prompts/character-check.md:14`, `:18`; `prompts/structure-check.md:5-6`; `prompts/repetition-check.md:4`; spec `:234` | Which source governs? The headings produce a complete file; the prompts produce the **sections the pipeline will actually read by name**, which is a smaller and harder list — seven named sections across four files, and a prompt that names a section the author did not write gets a silent partial read (F-01's second failure shape). Is there a check that every section a prompt names exists in the bible file it names? |
| **F-10** | **Four bible files are written by the pipeline and cannot be interviewed: they must be scaffolded with their headings and nothing else.** `Canon/continuity-ledger.md` (79,679 B today) and `Canon/timeline.md` are **outputs** of the `propose` step; `Canon/season-<N>.md` is the deferred season-planning capability's; `Canon/season-desk-report.md` is the deferred desk's. `Canon/voice-registry.md` is a fifth, half-written case: its header names `Production/voice-refs/refs.json` as the source of truth, so the prose file documents a JSON file the pipeline reads directly. | `engine/src/pipelines/episode.ts:376-377`; spec `:34`, `:35`, `:230`; `Canon/voice-registry.md:13`; §3.3 | What does `init` write into `continuity-ledger.md` — the four headings `propose` will append under (`## How to use`, `## Open threads`, `## Resolved`, `## Episode log`), or an empty file? `propose.md` edits the file and does not create a structure; an empty file means the first episode's librarian invents the ledger's shape. Same question for `timeline.md`'s three headings and `season-1.md`'s five. |
| **F-11** | **`Canon/story-craft.md` is almost entirely engine-generic craft doctrine, and it is a show file the pipeline declares as an input.** Its seven headings are BUT/THEREFORE causality, the circle, enter-late-leave-early, setup/payoff, the five ending duties, openings, and a summary of what the structure auditor checks — none of which is specific to a salvage crew. `structure-check.md:5` calls it "your entire rubric". Two of its headings carry ep99 provenance (`:46`), which is the only show-specific content in it. | `Canon/story-craft.md:9`, `:17`, `:29`, `:38`, `:46`, `:67`, `:72`; `prompts/structure-check.md:5`; `engine/src/pipelines/episode.ts:80`, `:198`, `:215` | Does `init` supply `story-craft.md` as a **filled default** the author may edit, breaking the "the model supplies structure, never content" rule of §9.2 for one file — or does it interview an author about BUT/THEREFORE? The same question, weaker, applies to `episode-formula.md` and `publishing-guide.md` (whose "Monetization guard" is 2026 YouTube policy, not a show fact). Where is the line between house format and content? |
| **F-12** | **The image audit exists twice, over two different law files, and only one of them is a show file by design.** The agent audit reads `Canon/visual-style.md` (21,370 B) and restates six laws inline (`image-audit.md:6`, `:8-14`); the Python audit reads `Canon/visual-audit-laws.md` (1,303 B, 8 numbered laws) through `visual.auditLaws` and inserts it whole (`scripts/nano-banana-generate.py:425`, `:304-315`). The second file is the one whose docstring states the generalisation rule Plan G needs: "They live in the show's canon rather than in this script because they are statements about THIS show's anatomy, scale and house style". | `prompts/image-audit.md:6`, `:8-14`; `Canon/visual-audit-laws.md:1-21`; `scripts/nano-banana-generate.py:304-315`, `:425`; `engine/src/pipelines/episode.ts:131`, `:288` | Does `image-audit.md` move to reading `visual-audit-laws.md` — making one law file serve both audits and turning the prompt from generalise to parameterise — or do the two audits stay separate? The second file is also the measured template for every "generalise" move in §2.4: 21 lines, eight numbered laws, no prose. Is that the shape the other ten generalisations target? |
| **F-13** | **`Canon/README.md` is the house format written down, and no step reads it.** 56 lines, six headings, including the "what lives where" table that assigns each file a change frequency (`:7-20`), the two-way rule splitting static entities from dynamic plot state (`:22-25`), the naming rule "Copy `_TEMPLATE.md` from each folder to start a new entry" (`:51`), and the `epNN`-in-prose rule added from spec §5.3 (`:44-46`). It is the one file in the bible that documents the bible. | `Canon/README.md:7-20`, `:22-25`, `:44-46`, `:48-52`; §1 (no step declares it) | Is `Canon/README.md` an output of `init` (the house format, identical for every show, with the show's own file list filled in) or an interview target? It is the document a human reads to understand the store, and §9.2's whole premise is that "an author who does not know what `style-guide.md` must contain discovers the gap at the first episode". This file is where that knowledge lives today. |
| **F-14** | **`Canon/pipeline-artifacts.md` puts engine documentation inside the show's bible, and `tts-script.md` reads it.** 128 lines, 6 headings, of which `## Per-episode STATUS.md` (`:94`) and `## Launching the workflows (usage canon — from the Phase 0 smoke-test)` (`:111`) describe machinery that retires with console v1, and `## Script dialogue attribution (ruled 2026-09-09, from ep10)` (`:35`) is the `[SPEAKER]` convention `tts-script.md:63` also states. `scripts/check_layout.py:4` audits an episode's folders against it. | `Canon/pipeline-artifacts.md:5`, `:28`, `:35`, `:87`, `:94`, `:111`; `prompts/tts-script.md:63`; `scripts/check_layout.py:4`; `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:30` | Does a new show get a `pipeline-artifacts.md` at all? Its artifact catalog and folder convention are the engine's facts, not the show's, and they are identical for every show — which argues the file belongs in the engine's README and the show keeps only the dialogue-attribution convention. But `tts-script.md` reads it by name, so moving it is a prompt edit. |
| **F-15** | **Neither reference index has a template, and both are the `NEEDS_REFS` probe's only data.** `Canon/refs.json`: 21 entries, four mandatory fields each (`kind`, `ref`, `identity`, `locked`), five `_`-prefixed documentation keys the probe skips. `Production/voice-refs/refs.json`: five top-level keys, nine `cast` entries, `status` must contain the literal `LOCKED`. The probe reads only `ref` from the first and `status`+`ref` from the second; everything else is read by the generators and by `tts-script.md`. | `Canon/refs.json` (26,817 B, 26 keys); `Production/voice-refs/refs.json` (6,966 B); `engine/src/needs.ts:70`, `:75`, `:97-100`, `:109-112`; `showrunner.json:99`, `:94`, `:108-112` | Does `init` write both files with the `_doc` keys and an empty entry set, or leave them absent? Absent is the measured safe case: `missingRefs` treats an absent bible as `{}` (`needs.ts:68`) and an absent voice file as `{}` (`:73`), so the probe reports every cast member as missing — which is exactly `NEEDS_REFS` and exactly what spec §9.3 wants. But an absent file also means the author has no shape to fill. |
| **F-16** | **`gh` is authenticated on this machine with a `repo`-scoped keyring token, and `gh repo create --source … --push` requires a committed local repository first.** Measured: `gh version 2.95.0`, account `MrMophandle`, token `gho_…` in the keyring, scopes `gist, read:org, repo, workflow`. Spec §9.5 asks "whether the GitHub step uses `gh` or a token". | `gh auth status` (run 2026-10-02, exit 0); `gh repo create --help`; spec `:234`; §4.1 | `gh` is present and authorized, so for Ryan the answer is `gh` and the cost of the alternative is a token to store. But the flag order forces a sequencing decision: does `init` `git init` + commit the scaffold **before** the interview (so the remote exists early and each bible gate can be a commit) or **after** (one commit, one push, no half-finished show on GitHub)? And what does `init` do when `gh auth status` exits non-zero — stop, or finish locally and print the one command? |
| **F-17** | **The id scheme is not a show's to choose today: the grammar is two regexes in the engine, mirrored in Python, and `airMap` is the only per-show part.** `engine/src/ids.ts:12-13` and `scripts/lib/showconfig.py:74-75` hardcode `/^s(\d{2})e(\d{2})$/` and `/^ep(\d{2})$/`; `parseEpisodeId` is called at `episodePipeline`'s first line (`engine/src/pipelines/episode.ts:59`) and by the console's id check. Two digits each means a cap of 99 seasons and 99 episodes. O-01 names this Plan G's question; spec §9.5 asks "the id scheme a new show starts with". | `engine/src/ids.ts:12-13`, `:23`, `:29`; `scripts/lib/showconfig.py:74-75`, `:230-246`; `engine/src/pipelines/episode.ts:59`, `:81`; `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:43`; spec `:138`, `:140`, `:234` | The measured answer for a new show is: `s01e01` onward, `epNN` for tests, `airMap` empty — no decision needed, because a new show has no production-named archive to map. So is O-01's question ("whether a new show may choose a grammar") closed as **no** by Plan G, or does it stay open? If it stays open, the cost is two regexes, `seasonOf`, `formatAired`, `compareEpisodeIds`, and the Python mirror — and `init` would have to write a grammar into `showrunner.json` that both loaders read. |
| **F-18** | **`init` has three possible homes and the engine already has a workspace shaped for it.** `tools/` is a workspace with `bin` entries (`extract-prompts`, `check-prompts`), a `vitest` suite, and a dependency on `@showrunner/engine` (`tools/package.json`) — and it already holds **a show's own data** in `tools/show-data/` (`deadlight-check-context.json`, `deadlight-overrides.json`), which the engine's show-name grep explicitly excludes (`README.md:770`, `:780`). The console's server is the second home (O-05's registry, O-06's form). A new workspace is the third. Spec §9.4 (`:232`) says "The substance is a command-line `init`… and can exist before the console does". | `tools/package.json`; `tools/show-data/deadlight-check-context.json`; `README.md:770`, `:780-782`; `console/server/app.ts:269`; spec `:232`; `docs/plans/2026-10-02-the-console-deferred.md:25-26` | `tools/` is the measured fit — it is already the place a show's data is allowed to live inside the engine, and `check-prompts` is already the pre-flight a new show's prompt set would run. But `tools/src/` is inside the show-name grep's search paths while `tools/show-data/` is excluded, so **generic prompt templates could live in `tools/src/` and a worked example could not.** Does `init` go in `tools/`, and if so, where do its templates go? |
| **F-19** | **"Running an interview through the engine's gate shape" has one measured obstacle: every gate in the engine belongs to a pipeline keyed on an episode id.** `episodePipeline` calls `parseEpisodeId(episodeId)` before anything else (`:59`) and every path it builds is `<dir>/<episodeId>/...`; `EventLog`'s path is `Production/<id>/runs/<run-id>.jsonl` (spec `:160`); `deriveStage` maps gates to episode stages (`EPISODE_STAGE_MAP`, `:34-44`). A bible interview has no episode. The step kinds themselves fit: a gate takes a `messageFile` and an `onReject` agent (`engine/src/pipelines/episode.ts:191-193` is the shape), an agent step takes a prompt file, a model, a tool allowlist and `outputs` (`:170-172`), and a guard returns pass/fail with a message (`:161-167`). | `engine/src/pipelines/episode.ts:34-44`, `:59`, `:141`-`:385`; spec `:152`, `:160`; `engine/src/stages.ts` (the 21 stages) | Does the interview run as a **pipeline** — one agent+gate pair per bible file, 14 gates, logged to a run — and if so, what is its episode id and where does its log live? A `StageMap` for a bible has no `NEEDS_IDEA` and no `COMPLETE`. Or does `init` reuse only the **executors** (`agentExecutor`, the gate renderer) outside a pipeline, forgoing the event log, restart-by-replay and the console's Run view? The second is cheaper and gives up exactly the things Plan G's author is most likely to want on a 14-gate interview. |
| **F-20** | **The show's `.gitignore` does not ignore the candidates directory the engine writes to, and nine of its eighteen path rules are one show's scratch.** `scripts/design-visual.py:62` writes `<visual.candidatesDir>` = `Canon/_candidates/` (`showrunner.json:103`); `.gitignore:13` names the retired path `Canon/visual-refs/_candidates/`. The show tracks 34 candidate PNGs under `Canon/_candidates/` as a result (`git ls-files Canon/_candidates` returns 34). Nine rules a new show needs on commit one; nine are history (`Production/tts-bakeoff/`, `Production/*/audio-v1-*/`, `remotion/`, `console/`, `.superpowers/`, `.playwright-mcp/`, …). | `.gitignore:3`, `:5`, `:6`, `:12-14`, `:19-20`, `:26-27`, `:34-35`; `scripts/design-visual.py:62`; `showrunner.json:103`; `Canon/_candidates/` (34 PNGs) | Does `init` derive the `.gitignore` from the config's own directory keys — `productionDir`, `visual.candidatesDir`, `output` paths — so the two cannot drift? That is the only version that fixes this class of bug rather than copying it. And does Plan G fix the show's own rule, or leave it to Plan F? |
| **F-21** | **Spec §9.2 says "each file is a gate with the engine's existing gate shape", and the existing gate shape has an attempt cap and a fix agent per gate.** Each of the eight episode gates declares `maxAttempts` (10 for six of them, 5 for `audio-gate` and `image-gate`, 2 for `final-gate`) and an `onReject` fix agent with its own prompt file and tool allowlist (`:191-193`, `:228-230`, `:254-256`, `:265-267`, `:291-293`, `:318-320`, `:351-353`, `:381-383`). Fourteen bible gates would need fourteen `*.gate.md` messages and fourteen `*.reject.md` prompts — **28 new prompt files**, in a repository that does not exist yet when the interview starts. | spec `:228`; `engine/src/pipelines/episode.ts:191-193`, `:351-353`; §2.1 | Where do the interview's own 28 gate and rejection prompts live, given that the show repository is the interview's **output**? They cannot be the show's asset before the show exists. Does the interview's prompt set live in the engine (permitted, since it names no show) while the episode pipeline's lives in the show — two prompt homes, one engine? And is one `maxAttempts` enough for a bible file an author is still thinking about? |
| **F-22** | **`init` must teach the New-episode form, and the console's version of it validates the id against the engine and nothing else.** `POST /api/episodes` checks the id, requires a non-empty premise, and writes `Episodes/<id>/premise.md` with `wx`. The premise's **content** is unconstrained — but `prompts/outline.md:5` treats it as the whole request, and the two canon reviewers treat it as "The showrunner's words" ranked above canon (`canon-review-outline.md:26`, `canon-review-script.md:27`). O-06 calls the form "the first thing `init` teaches". | `console/server/app.ts:269-287`; `prompts/outline.md:5`; `prompts/canon-review-outline.md:26`; `prompts/canon-review-script.md:27`; spec `:13`; `docs/plans/2026-10-02-the-console-deferred.md:26` | What does `init` teach about a premise beyond "a paragraph" (spec `:13`: "an episode id and a paragraph: what happens, whose episode it is, what it must pay")? And does it teach `Episodes/<id>/locked-beats.md` too — the optional file both canon reviewers call **BINDING** when it exists (`canon-review-outline.md:10`) and that nothing creates? |
| **F-23** | **The engine's show-name check is a grep over Dead Light's own cast list, and it cannot see a second show's names.** `README.md:768` is the grep; `README.md:773-778` states the limitation in its own words: "**The word list is the first show's, and it is not the whole obligation.**… A show's character and place names beyond the list — a new show's, or a name this one adds later — are caught by review, not by this grep." Measured: the grep prints nothing today (exit 1). The only `deadlight` strings left in the engine outside `docs/` are in `README.md:768`, `:773` and `tools/show-data/` (9 sites total). | `README.md:765-790`; verified by running the grep, 2026-10-02 | If Plan G puts prompt templates in the engine, what checks that they are generic? The existing grep cannot: it knows Dead Light's eleven nouns and nothing else. Is the check instead structural — a template may contain `{{show.showName}}` and no capitalised proper noun outside a code span — and who runs it? Note the second half of the measurement: **not one of the 34 prompts uses `{{show.showName}}` today**, so the parameterised form has never been exercised against `renderPrompt`. |
| **F-24** | **Voice and visual references are the one part of setup the measurement says is already correct, and `init`'s only job there is to record the cast.** Spec §9.3 (`:230`): the interview "records who the recurring cast are; the `NEEDS_REFS` stage stops the first episode until the author casts each voice by ear". The probe already does exactly that: absent indices are read as `{}` (`needs.ts:68`, `:73`), every recurring subject without an entry is reported by name with the keys it tried (`:95`), a voice not containing `LOCKED` is reported (`:111`), and a speaking guest with no WAV is reported with the path it wants (`:117`). The guard turns the list into `NEEDS_REFS: <list>` (`episode.ts:244`). | spec `:230`, `:26`; `engine/src/needs.ts:60-121`; `engine/src/pipelines/episode.ts:241-245`; `scripts/design-voice.py`; `scripts/design-visual.py` | Where does "records who the recurring cast are" land — in `Canon/characters/` sheets from the templates, in `Canon/refs.json` entries with a `ref` pointing at a file that does not exist yet, or only in prose in `world-overview.md`'s "The primary crew"? The third is the only one that does not make `missingRefs` report a broken `ref` path, and the first is the only one the `outline` prompt can read. |
| **F-25** | **The console's "New show" surface needs three things from `init` that `init`'s command-line form does not have to produce.** `loadShowContext` needs an absolute `showRoot` and a `showrunner.json` that loads (`console/server/show.ts:71-78`); the server needs to be **restarted** to change shows, because `ShowContext` is resolved once at startup and `main.ts:46` reads `--show` from argv; and the banner prints `ctx.show.showName` (`main.ts:91`). O-05 says the registry is Plan G's and that "nothing else assumes a single show". | `console/server/show.ts:9-11`, `:71-88`; `console/server/main.ts:43`, `:46-47`, `:63-69`, `:91`; `docs/plans/2026-10-02-the-console-deferred.md:25`; spec `:232` | Does the "New show" surface create a repository and then tell the operator to restart the console with a new `--show`, or does Plan G build the registry first so the new show appears without a restart? The registry is the larger change — it touches `ShowContext`, `RunStore` (one watcher per show), the worker argv, and every route's notion of which show it means. And what is the registry's file: a list in `~/.showrunner/`, or a directory the server scans? |
| **F-26** | **Twenty-one of the thirty-four prompts need a name substitution or nothing, and the substitution is a single uniform edit.** Twenty-six of the 27 show-name sites are the prompt's **first line**, in the form "You are the `<role>` for *Dead Light*". The two exceptions are `outline-gate.reject.md:11` (role line eleventh) and `audio-gate.gate.md:2` (the slug inside a glob, which `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:32` already flags as wrong for an unmapped id). | §2.3; `prompts/*.md:1` (26 files); `prompts/outline-gate.reject.md:11`; `prompts/audio-gate.gate.md:2`; `prompts/README.md:7`; `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:32` | Is the role line a **convention worth stating** — "every prompt's first line declares the agent's role and the show, as `You are the <role> for {{show.showName}}`" — so a template set and a hand-written prompt agree? It is the cheapest finding in this document to act on and the one that makes the measured 21-of-34 figure real: without it, each of the 21 is a hand edit a new show's author gets wrong once. |

---

## Change log

- **2026-10-02 — created.** Measured against the show at `6b157b8` and the engine at `9347474`. §1 lists 19 named files and 5 directories with the step that needs each and the failure shapes a missing one produces; §2 measures all 34 prompts the episode pipeline names and classifies them 5/16/11/2; §3 measures the two Season 2 specs and `Canon/season-2.md` as the interview pattern and every top-level `Canon/*.md` as the target shape; §4 records `gh auth status` as run, the house layout, the `.gitignore`, and how the console is pointed at a show; §5 records 26 findings. **No design proposed. Nothing in either repository changed.**
