# The Console Rewrite — Design

**Date:** 2026-09-25 · **Status:** COMPLETE for the first build — every section Ryan-ruled; self-reviewed 2026-09-26; awaiting Ryan's read before the implementation plan
**Purpose:** The requirements for rewriting the console as a modular product: which steps exist, what each step's contract is, and what the operator sees. The current system is mapped in `2026-09-25-pipeline-process-map.md` (same directory); this document records what changes. Both documents were written in the DeadLight repository and moved here on 2026-09-26 per §7.4; their file:line citations into `.archon/`, `console/`, and `Canon/` refer to the DeadLight repository as it stood on 2026-09-25.
**Rule this document lives under:** each ruling records what it replaces in the current pipeline and what it costs, so the cost of reversing it can be read in one line.

---

## 0 · What it does (Ryan asked for this in one sentence, 2026-09-26)

**It takes an episode premise and a story bible, and makes a finished, publishable episode and a bible that has absorbed what the episode established — with the showrunner ruling at every gate.**

**The premise** is an episode id and a paragraph: what happens, whose episode it is, what it must pay. In the finished product the season desk drafts it and the showrunner rules on it; in the first build the showrunner writes it.

**The bible** is the canon store as it exists today: the world's rules, the style guide, the story-craft doctrine, the episode formula, every character, species, location, and faction sheet, the continuity ledger, the season plan, the locked voice references, and the locked visual references. It must exist before the first episode; the system does not invent a show.

**The episode** is everything from outline to upload kit: an approved outline and script; a cast manifest, per-segment synthesized audio, and a mixed master at −14 LUFS; a shot list, generated and audited stills, and an image sheet; a timeline, a rendered and mastered video, and a copy on the NAS; the upload kit — title, logline, description, captions; and a complete event log of how all of it was made.

**The absorbed bible** is the canon store with the episode's new facts written in and the showrunner's deliberate deviations recorded as such, so the next episode is written against what actually shipped.

**The showrunner rules at eight gates in the first build:** outline, script, casting, audio, character shots, all images, assembled video, and canon. A ninth — the idea — returns with the season desk.

**What it does not do, stated so the claim above is honest.**

- It does not invent the show. The bible comes first, by hand.
- It does not make a new character's face or voice. A recurring character with no reference sheet or locked voice stops the line at `NEEDS_REFS` until the showrunner makes the sheet and casts the voice by ear.
- It does not make the images the showrunner chooses to make himself. Those stop the line at `NEEDS_IMAGES` until he drops the files in.
- It does not publish. It produces the upload kit; the upload is his.
- It does not run unattended. Eight gates, all his; between gates it runs without him.
- It does not decide the season. The desk proposes, numbered; he rules by number.

**Scope of the first build (Ryan-ruled 2026-09-26): premise in, publishable episode out.** The first build takes a premise the showrunner supplies by hand and runs it to the upload kit and the canon update. Two capabilities the finished product will need are **deferred, not dropped**:

- **Season planning** — creating a new season outline. Today this is done by hand in conversation (the two Season 2 specs and `Canon/season-2.md` were made that way). Not built in the first pass.
- **Premise generation** — the Season Desk's job: the board, the three craft lenses, the desk report, numbered proposals, and the launch premise. Stage 0 of the process map is **not ported** in the first build. The premise is an input.

Consequences inside the first build: the `DRAFT_IDEA` state is reserved and unused, since nothing drafts an idea; an episode starts at `NEEDS_IDEA` and moves to `IDEA` when the showrunner supplies the premise. The end-of-episode canon update **stays in scope**, because ordering rule 1.3 makes it the precondition for the next episode — without it the second episode cannot be written, so a build that stopped at the upload kit could make exactly one episode.

**Why this is a product and not a script.** The engine and the deterministic steps know nothing about salvage crews or a creature that mutes relics. Everything that makes this *Dead Light* lives in the bible and in the prompt files. A second show is a second show repository — its own bible and its own `prompts/` — run by the same engine (§7.3).

---

## 1 · Ordering rules (Ryan-ruled 2026-09-25)

**1.1 Audio is finished, reviewed, and approved before any image work starts.** This is already the current behaviour (since 2026-08-31) and becomes a declared contract: the Vision module takes the approved mix as an input, so the ordering cannot be lost by editing a dependency list.

**1.2 Canon is updated at the end of an episode, after the publish kit.** This moves the current Stage 2a from "parallel with asset production, before the next episode" to the final step. The canon moment has two inputs — the episode's deviation ledger with Ryan's rulings on each item, and the librarian's list of new facts the episode establishes — and one gate.

**1.3 Episode N+1 does not start until episode N's canon update is committed.** Ryan accepted the serialization. The throughput cost is real on paper and does not matter in practice, because **Ryan schedules premieres on YouTube and works several episodes ahead of air date**; the pipeline's job is to sustain one finished episode per week, not to overlap episodes. The alternative considered — the next episode's reviewer reading the previous episode's pending ledger so writing could overlap production — is not needed and is not built.

---

## 2 · The canon reviewer (Ryan-ruled 2026-09-25)

**2.1 One agent, run twice per episode.** It reviews the outline against the canon store, and later the script against the canon store **and the approved outline** (an approved outline is approved canon for that episode). It reads only; it never edits.

**2.2 The rule is provenance: agents adhere to canon; Ryan overrides it; the ledger records the overrides.** Ryan-ruled 2026-09-25: *"I want it to adhere to canon if an agent is script writing, and log when I over-ride or change canon in some fashion."* For every discrepancy the reviewer finds, it determines who introduced it:

| Provenance | Treatment |
|---|---|
| **Agent-introduced** — present in agent output and traceable to no input of Ryan's | A defect. Routed to the existing auto-fix loop, exactly as today. Ryan never sees it unless the loop exhausts. |
| **Ryan-introduced** — traceable to his launch premise, his `locked-beats.md`, a gate rejection note, or a hand edit to the file | A deliberate deviation. **Logged to `Episodes/<id>/canon-ledger.md` and NOT fixed.** Presented at the gate as information, and consumed at the end-of-episode canon moment (§2.5). |

**2.3 How provenance is determined.** The reviewer has everything it needs on disk and in run state: the launch premise and `locked-beats.md` are Ryan's words; gate rejection notes are captured by the gate; a hand edit is any file whose current content hash differs from the hash the engine recorded when an agent step last wrote it (`step_completed` records the hash of every output, §6.5), so detection does not depend on git. A discrepancy that implements one of those is Ryan's. Everything else is the agent's.

**Tie-breaker, when provenance is unclear: adhere.** The reviewer treats it as an agent slip and the loop fixes it. If Ryan in fact wanted the deviation, he sees the fix at the gate and re-asserts it in a rejection note — at which point it is provably his and is logged rather than fixed on the next pass. Adhering by default costs one gate round in the rare ambiguous case and never silently rewrites canon on an agent's guess.

**2.4 What this replaces, and what it keeps.** The current `outline-canon-check` and `continuity-check` stay in function — agent slips are still caught cheaply and fixed automatically — but they become the agent-slip half of one reviewer that also keeps the ledger. What is new is the second half: today a Ryan override is indistinguishable from an agent slip and gets "fixed" back to canon by the revise loop, which is precisely how deliberate deviations were lost in Season 1 and had to be reconstructed as AS SHIPPED notes afterward. The ledger is the missing record.

**2.5 The end-of-episode canon moment consumes the ledger.** Accepted deviations become AS SHIPPED canon changes (the pattern used on ep10). Fixed items are moot. The librarian's new-facts proposal is presented alongside. One gate, one commit.

---

## 3 · The milestone vocabulary (Ryan-ruled 2026-09-25, with two additions he accepted)

**3.1 Three state kinds, not two.** The current pipeline stamps a milestone only on approval, so the board cannot show "in progress" or "waiting on Ryan." The rewrite uses three kinds per stage, and not every stage uses all three:

| Kind | Prefix | Meaning | What the board should show |
|---|---|---|---|
| **Needs** | `NEEDS_` | The pipeline is blocked on Ryan **producing** an input only he can make | "waiting on you to make …" — an afternoon of work |
| **Draft** | `DRAFT_` | The artifact exists and is **awaiting Ryan's approval** at a gate | "waiting on you to review …" — minutes |
| **Approved** | (bare) | Ryan approved; the stage is done | done |

**3.2 The vocabulary, in order.**

```
NEEDS_IDEA      DRAFT_IDEA      IDEA
                DRAFT_OUTLINE   OUTLINE
                DRAFT_SCRIPT    SCRIPT
NEEDS_REFS                      (no draft or approved form: it clears itself when every reference exists)
                DRAFT_CASTING   CASTING
                DRAFT_AUDIO     AUDIO
NEEDS_IMAGES    DRAFT_IMAGES    IMAGES
                DRAFT_ASSEMBLY  ASSEMBLY
                                PUBLISH_KIT
                DRAFT_CANON     CANON
                                COMPLETE
```

Ryan's original proposal was `DRAFTIDEA-IDEA-DRAFTOUTLINE-OUTLINE-DRAFTSCRIPT-SCRIPTED-DRAFTAUDIO-AUDIO-DRAFTIMAGE-IMAGED-DRAFTASSEMBLE-ASSEMBLED-PUBLISHKIT-CANONDRAFT-CANONUPDATED-COMPLETED`. Two regularizations, both accepted, and one addition proposed in §3.4: one grammatical form throughout (code compares these strings and the board sorts by them), and a **CASTING** pair, because the casting gate is a real human gate that stands between a five-minute manifest review and three hours of synthesis.

**3.3 `NEEDS_IMAGES` — the state Ryan asked for.** Ryan makes some character shots by hand. While he is doing that, the pipeline is not "awaiting review"; it is blocked on him producing input. `DRAFT_IMAGES` would misreport that as a review task.

The state is **derived from disk, never stamped by hand**: the shot list (`prompts.json`) marks each shot's source — `pipeline` or `showrunner` — and the stage is `NEEDS_IMAGES` while any `showrunner` shot lacks a PNG. The moment the last hand-made PNG lands, the stage advances to `DRAFT_IMAGES` on its own. A shot becomes `showrunner`-sourced two ways: the visual director tags it as one at shot-list time, or Ryan rejects a generated shot at the shot gate with "I'll make this one."

**3.4 The same kind generalizes.** `NEEDS_IDEA` is the state before Ryan writes or approves a premise. A third instance is worth building now because it has already bitten: `NEEDS_REFS` — a recurring character or location with no `refs.json` identity or reference sheet. The ep07 lesson (register before generation or every shot silently fails) and the Ilvaren sheets Ryan made by hand in September 2026 are both this state. It sits between SCRIPT and DRAFT_CASTING, and it is derived from disk: any `refs` key named in the shot list without a locked reference sheet.

**3.5 Where `beats` and `finalized` went.** The current `beats` milestone (a hand-written `locked-beats.md`) folds into IDEA. The current `finalized` (the NAS push) folds into PUBLISH_KIT, whose definition is "final MP4 on the NAS and the upload kit generated." The current pipeline's two never-stamped milestones, `canon` and `assembled`, are replaced by the CANON and ASSEMBLY pairs.

---

## 4 · The engine (Ryan-ruled 2026-09-25)

**4.1 Archon is replaced entirely.** Ryan: *"I want to ditch Archon completely."* The rewrite owns its own runtime; no step is an Archon node and no operation shells to the `archon` CLI.

**4.2 What this buys.** The two gaps in the process map that were engine behaviour close by construction: a skipped dependency becomes distinguishable from a failed one, so a guard can close a gate; and a step's cached success is keyed on its inputs, so a changed input invalidates it and nobody checks mtimes by hand. The milestone state machine (§3) becomes the engine's own model rather than a convention stamped on top. Detached execution stops being an operator discipline and becomes the only path, because runs are server-side jobs rather than CLI processes someone must remember to `nohup`.

**4.3 What this costs, measured.** The five workflows are 2,167 lines of YAML across roughly 64 nodes. The expensive asset in them — the prompts, which carry every Ryan-ruled lesson from ten episodes — ports nearly verbatim; a prompt is a string in either runtime. What must be re-implemented is the node vocabulary those prompts hang on: a bash step; an agent step with a model alias, a tool allowlist, a fresh-or-shared context, and an optional JSON output schema; a loop that runs until a sentinel or an iteration cap; a human gate with a captured response, an on-reject agent, and an attempt cap; a `when` condition; fan-out and fan-in over dependency lists; per-step timeouts; and reference to earlier steps' outputs. That vocabulary is small and fully enumerated by the map. The runtime that has shipped ten episodes is given up, so the first Season 2 episode is also the new engine's first production run.

**4.4 What the engine is NOT allowed to lose.** Every fence the current console holds (process map §7): argv arrays, never shell strings; ids validated before they reach a process; seasons discovered from the filesystem; the board as one derivation; no direct canon or script edits outside a gate.

**4.5 Agent steps run on the Claude Agent SDK (Ryan-ruled 2026-09-25).** Every agent step in the current pipeline is already a Claude Code session with a tool allowlist, a model alias, and a fresh-or-shared context; the console's *discuss* feature already shells `claude -p`. The Agent SDK is that harness as a library, so it is the least-change replacement: prompts port as strings, `allowed_tools` lists map to the SDK's per-query allowlist, `context: fresh` becomes one query per iteration. The alternatives considered and not taken: owning the tool layer on the Claude API tool runner (more code to own for no gain in this pipeline), and Managed Agents (the repo, the local GPU, the NAS, and the render all live on Ryan's Mac, so a remote sandbox would split one system into two).

**4.6 The rewrite therefore has three layers.**

| Layer | Language | Contains | Calls a model? |
|---|---|---|---|
| **Orchestrator** | TypeScript (the console is already Hono + Vite; the Agent SDK ships a TypeScript package) | The step DAG, the gates, the NEEDS/DRAFT/approved state machine, a server-side job queue, the event stream, the board derivation | No |
| **Agent steps** | TypeScript, via the Agent SDK | One query per step; per-step allowlist, model, and context policy; the prompts carried over from the YAML | Yes |
| **Deterministic steps** | Python, unchanged in content | The existing `.archon/scripts/*.py` — synthesis, the three QC passes, the mix, timeline, master, finalize, publish kit, registry — relocated to the engine repository (§7.4) and invoked as argv arrays exactly as today | No |

The Python scripts are the largest tested investment in the repo; their content does not change, and show-specific constants inside them are extracted to show data (§7.4).

**4.7 Two things to verify against the Agent SDK's documentation before implementation, not from memory:** that a query can return a JSON verdict validated against a schema (the review panel's contract depends on it), and the exact form of per-query tool allowlists and model selection.

## 5 · Production ids (Ryan-ruled 2026-09-25)

**5.1 Two id shapes, with exact meanings.** `sXXeYY` is an **aired slot** — season and episode, zero-padded, and the id carries its own resolution, so no map is needed. `epNN` is a **production id that never aired.** After the rename below, only two directories carry the second shape: `ep98` (the non-canon test-bed) and `ep99` (the retired proof-of-concept), both of which were used to flesh out console v1.0 and never had an air slot. No legacy table exists; the orchestrator resolves an id by parsing it, and an `epNN` id has no season and no slot by definition.

**5.2 Season 1 is renamed, not grandfathered.** `Episodes/ep01`–`ep10` and `Production/ep01`–`ep10` become `s01e01`–`s01e10`. Measured scope (2026-09-25): 20 directories, 52 canon and documentation files carrying path references (`ep03/script.md:120` → `s01e03/script.md:120`), and 22 committed manifests with an `"episode"` field. Every substitution is mechanical and the completion check is a grep for stale `ep0N/` paths returning zero. The NAS finals already carry the season-slot form (`DeadLight S01E01.mp4`, produced by `audio-mix.py:17` since the pilot) and do not change.

**Why rename rather than keep two shapes.** The orchestrator has to order episodes — the repetition reviewer reads the two highest-numbered episodes below the current one, and the desk globs every script. With one shape, ordering is a sort. With two, it is a special case that lives forever.

**5.3 Bare prose mentions are not swept.** Roughly 600 prose mentions of `ep03`-style ids exist in canon and documentation alongside ~1,500 air-slot mentions (`E9`, `Ep. 9`, `S1E9`). They are not machine-substituted, because prose is the one place a blind substitution can change meaning. Instead `Canon/README.md` gains one rule: **`epNN` in prose always means Season 1, episode NN; new writing uses `SxEy` in prose and a production id only inside a file path.** Ryan's concern — that a reader could not tell where a detail was first introduced when references mix `ep03` and `s02e05` — is answered by that rule plus the rename, and the measurement showed the mix already exists today between `ep09` and `Ep. 9`.

**5.4 When.** Not before the new orchestrator exists. Renaming today breaks the current console and every current script before their replacements are built, and Season 1's archive would be unreadable by the only tools that can read it. The rename is the orchestrator's **first shipped task**: teach the engine `sXXeYY`, move Season 1 in one commit, then delete every `epNN`-shaped code path.

## 6 · The core model, and observability (Ryan-ruled 2026-09-26)

Ryan accepted the core model below on 2026-09-26 and added one requirement that reshapes it: **observability is baked in, not added.** He must be able to see on a dashboard exactly where a run is — not "producing assets" but which step, how far through it, and how long since it last did anything — and every action must be logged so a Claude troubleshooting agent can step through what happened. Archon could name the stage it was in and never the position inside it, and the ep09 and ep10 failures (a loop returning in three seconds per iteration having done nothing) were invisible until a human read a partial script.

**6.1 A step is a typed TypeScript object, not YAML.** Each step is one of the five kinds from the process map: a **guard** (a function returning pass or fail with a message), a **script** (a Python script path plus argv, with the files it reads and writes declared), an **agent** (a prompt file, a model, a tool allowlist, a context policy, and an optional JSON schema for its verdict), a **gate** (a message template and the agent to run on rejection), or a **loop** (any step, a sentinel, and an iteration cap). Prompts live in their own files under `prompts/` **in the show repository**, one per step, so they remain the asset, belong to the show, and are edited without touching engine code.

**6.2 A pipeline is a list of steps with declared dependencies.** Stage state — `NEEDS_`, `DRAFT_`, or approved — is derived from which steps have completed and which gate is open, never stamped by hand.

**6.3 Success is keyed on declared inputs.** A script step declares the files it reads; its cached result is invalidated when any of them changes. Declaring inputs is mandatory because this is the fix for `prior_success` never invalidating.

**6.4 Skipped and failed are different outcomes**, and a gate cannot open past a failed dependency.

**6.5 The event log is the source of truth. Everything else is derived from it.** Each run has one append-only JSONL file, `Production/<id>/runs/<run-id>.jsonl`, in the show repository — a run is part of the episode's record and lives with it. Every event carries a timestamp, the run id, the step id, a kind, and a payload. The kinds:

| Kind | Payload |
|---|---|
| `run_started` / `run_finished` | pipeline name, episode id, trigger (who launched it, from where) |
| `step_started` / `step_completed` / `step_failed` / `step_skipped` | step id and kind; on completion the outputs written and the input hashes; on failure stderr and exit code; on skip the reason |
| `step_cached` | the step was not re-run because its declared inputs were unchanged — recorded, so a stale-looking result is explainable |
| `step_progress` | `done`, `total`, a unit (segments, shots, frames, scenes, iterations), and an optional message |
| `script_line` | one line of a script's stdout or stderr, as it happened |
| `agent_query` | the prompt file, model, allowlist, and context policy the agent step was run with |
| `agent_tool_call` | every tool the agent invoked, with its arguments — the file it read, the file it wrote, the command it ran |
| `agent_result` | the verdict JSON if the step has a schema, or the final text |
| `loop_iteration` | iteration number, cap, whether the sentinel fired, and the count of tool calls made in that iteration |
| `gate_opened` / `gate_answered` | the message shown verbatim; the response verbatim, who answered, and how long the gate stood open |
| `input_changed` | a declared input changed after a step consumed it — the mtime check nobody has to do by hand |

**The run-state file is a projection of this log**, rebuilt from it on restart. **The dashboard is a projection of this log.** The troubleshooting agent reads this log directly.

**6.6 Where a run is, at three altitudes.** The dashboard computes the current position as the last `step_started` with no terminal event, and shows it as **stage → step → progress**: the stage from §3, the step id, and the step's latest `step_progress` with done/total, elapsed, and a rate-based estimate. Alongside it, always: **the time since the last event of any kind.** A step that has emitted nothing for fourteen minutes is visibly stalled, which is the state Archon could never show.

**6.7 Progress is a contract each step honours.** A script reports progress by printing one structured line per unit of work — `::progress {"done":47,"total":212,"unit":"segments"}` — which the orchestrator parses and everything else forwards as `script_line`. This is a one-line addition inside each script's main loop: per segment in `tts-generate.py`, per shot in `nano-banana-generate.py` and `image-generate.py`, per round in the three QC passes; Remotion's own frame counter is parsed as-is. An agent step's progress is **derived from disk where possible rather than self-reported** — the draft loop's position is the count of scene headers in `script.md` against the beat count in `outline.md`, read after each iteration — because a derived number cannot be wrong about what was actually written. A loop reports the iteration count and the tool-call count per iteration; **an iteration with zero tool calls is flagged on the dashboard the moment it happens**, which is exactly the ep09/ep10 failure surfaced in real time instead of at the gate.

**6.8 What the troubleshooting agent gets.** A "what happened" action on the console assembles, for one run: the event log, the pipeline definition it ran against, the prompt files as they were at the time (recorded by content hash in `agent_query`), and the files the run wrote — and hands that to an agent as its whole context. Every `agent_tool_call` and every `script_line` is in the log, so the agent can answer "what did step X actually do" without re-running anything.

**6.9 Restart.** The orchestrator restarts by replaying each run's log. A run with an open gate resumes waiting at that gate. A run mid-step re-executes that step, which is safe because every step is idempotent and every script already skips outputs that exist; the re-execution is itself logged as a new `step_started` following the orphaned one, so the interruption is visible in the history rather than erased. Detachment is therefore structural: there is no terminal process to detach from.

## 7 · The first build (Ryan-ruled 2026-09-26)

**7.1 The review panel.** The six non-canon reviewers — tone, flow, character, structure, environment, repetition — are kept exactly as they are, because they already share the shape that makes them modules: `medium`, fresh context, read-only tools, JSON `{pass, verdict, issues[]}`. The canon reviewer (§2) replaces `continuity-check` and `outline-canon-check`, so the panel is still seven wide, with one member keeping a ledger. **The grammar checker is not built in the first pass.** It is the first thing added afterward, and adding it is one prompt file plus one entry in the panel's list — which is the proof that the seam works.

**7.2 The console.** Four surfaces and no more:

| Surface | Shows | Does |
|---|---|---|
| **Board** | every episode's stage and state, with `NEEDS_` and `DRAFT_` visibly distinct | the one derivation, over the show repository's run logs and milestone state |
| **Run view** | stage → step → progress, time since last event, the live event log | §6.6 |
| **Gate view** | the gate message, the artifact it refers to (outline, script, mix, shot sheet, video, canon diff) | approve, or reject with notes |
| **"What happened"** | one run's log, pipeline definition, prompt files by hash, and outputs | assembles that context and hands it to an agent (§6.8) |

Deferred from the current console: the season map, the desk state, discuss, notes, and the standalone shot re-roll, ambient pass, and casting-pile buttons. Re-roll and ambient pass survive in the first build **as gate rejections**, which is the path they already take inside the workflows.

**7.3 Two repositories (Ryan-ruled 2026-09-26).** *"Deadlight should be the story bits only, not the console code."*

| Repository | Holds | Is |
|---|---|---|
| **`DeadLight`** (this one) | `Canon/`, `Episodes/`, `Production/`, `prompts/`, a show config file at the root, the story specs under `docs/` | **the show** — data the engine operates on |
| **the engine repository** (name: Ryan's to choose) | `engine/` (orchestrator, step definitions, the agent runner), `scripts/` (the Python deterministic steps), `render/` (the Remotion project), `console/` (the client), `docs/` (the process map and this spec, moved on creation) | **the product** — knows nothing about any one show |

The engine operates on a show repository by path. One engine, many shows. The show config file at the show repository's root names what the engine needs to find: the prompts directory, the output destinations including the NAS path, and the id scheme. Its exact contents are decided in the implementation plan.

**7.4 What moves, in which direction.**

Out of `DeadLight`, into the engine repository: `console/`, `.archon/scripts/` (becoming `scripts/`), `remotion/` (becoming `render/`), the root `package.json`, and the two rewrite documents (`2026-09-25-pipeline-process-map.md`, this file). `.archon/workflows/` is not moved; it is the source the prompts are extracted from and is deleted at cutover.

Into `DeadLight`, from the engine's inputs: `prompts/` (every agent prompt extracted from the five YAML files, one file per step) and the show-specific constants currently hardcoded in scripts — the `LOGLINE` dictionary in `publish-kit.py` becomes per-episode publish data in the show repository; the title-card and room-tone conventions in `audio-mix.py` become show config. The Remotion project's show-specific assets (the title card) become show assets referenced by config; identifying every such constant is an implementation-plan task, with the rule that **a script in the engine repository may not contain the name of a show**.

Stays in `DeadLight`: `Canon/`, `Episodes/`, `Production/` (including the run logs), the Season 2 story specs, `README.md`.

**7.5 Cutover sequence.** The engine repository is created first and built against `DeadLight` as its show, while `DeadLight` keeps console v1 and `.archon/` working on the Season 1 archive. Cutover is one ordered sequence: the engine reads `sXXeYY` (§5.4); Season 1 is renamed in one commit; `console/`, `.archon/`, `remotion/`, and the root `package.json` are deleted from `DeadLight`; the first Season 2 episode runs on the new engine. Until cutover, nothing in `DeadLight` is removed.

---

## 8 · Change log

- **2026-09-25 — created** from the first rewrite conversation. Rulings §1–§5 recorded; §6 lists what remains.
- **2026-09-26 — core model accepted; observability ruled in.** §6 records the step model, the event log as source of truth, progress as a per-step contract, and restart by replay.
- **2026-09-26 — scoped, completed, self-reviewed.** §0 gains the first-build scope (desk deferred, canon update kept). §7 records the panel, the console's four surfaces, the two-repository split Ryan ruled, what moves in which direction, and the cutover sequence. Self-review fixes: `NEEDS_REFS` added to the §3.2 table (it was described in §3.4 and missing from the vocabulary); "nine gates" corrected to eight for the first build, since the idea is supplied by hand; §2.3 hand-edit detection changed from a git diff to the content hashes the event log already records; §4.6 and §6 updated so the scripts' relocation and the prompts' home in the show repository are stated where they are first mentioned. No open items remain for the first build.
