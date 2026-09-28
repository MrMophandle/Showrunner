# Plan C (show config and prompt extraction) — deferred items and rulings

**Status:** Plan C is built on two branches: `plan-c` in the engine repository (branched from `main` at `315941f` on 2026-09-28; `git log 315941f..plan-c` is the commit list) and `plan-c-show-data` in the show repository (branched from `console-operating-layer` at `4509380`). The final tree passes the engine suite (160 tests, 2 env-gated live tests skipped), the tools suite (20), the render suite (3) and the scripts suite (298), with every typecheck silent and the show-name constraint grep empty. The whole-branch review returned "ready to merge with fixes" for both branches; one fix wave addressed every Important and the Minors it marked fix-before-merge.

This document is the durable record of what the review process deferred to later plans and of every ruling the controller made during execution. The plan file (`docs/plans/2026-09-28-show-config-and-prompts.md`) describes what was built and rules on the inventory's seventeen findings; the inventory (`docs/plans/2026-09-28-plan-c-inventory.md`) records what was found. Each later plan's author reads their section here, together with the Plan A and Plan B records (`docs/plans/2026-09-26-engine-core-deferred.md`, `docs/plans/2026-09-27-agent-runner-deferred.md`).

## What Plan C established that later plans build on

- **`showrunner.json` at the show root** is read by the engine (`promptsDir`, `models`, `airMap`) and by every script (the rest) through one Python helper, `scripts/lib/showconfig.py`, which mirrors `engine/src/show-config.ts`'s required keys and `airMap` rules. Paths are relative to the show root unless absolute.
- **Prompts are files** under `<showRoot>/prompts/`: thirty step prompts, nine rejection prompts, nine gate messages, eight schemas, and `index.json`, extracted deterministically by `tools/extract-prompts` from the five Archon workflow files with the variable rewrites the plan names. The extractor refuses collisions and unused inputs; `tools/check-prompts` renders every prompt against a sample context.
- **The scripts' convention:** the show root is the working directory; `--show-root <path>` or `--show-root=<path>` overrides it and is made absolute and loaded before the directory change; positional argv only, no `ARGUMENTS`; config through `sc.value`/`sc.path`; `::progress` once per unit; the last stdout line is the result where a gate reads it; a config error exits with one line.
- **The render project** reads its title card and every dimension from `timeline.json` through a typed parser; `REMOTION_EPISODE` must be set; `render/` is a standalone package (`npm run test:render`).
- **Two new scripts:** `populator-check.py` (exit 2 on a crowd without names) and `canon-diff.py` (the patch file plus a one-line result).

## Plan D — the Dead Light pipeline

- **A gate rejection must re-run the dependent script steps.** Six prompts used to tell the reject agent to run scripts by hand (`ARGUMENTS=… uv run .archon/scripts/…`); the fix wave replaced those lines with "the pipeline re-runs … before this gate reopens; do not run any script yourself." Plan A's gate runs the fix agent and reopens the gate; it does not re-run upstream steps. Plan D makes the sentence true — after `audio-gate`'s fix agent edits `tts-script.json`, synthesis, the three QC passes and the mix re-run (their declared inputs changed, so the cache does not serve them); after `final-gate`'s, the timeline and the master; after `image-gate`'s and `image-audit`'s, ambient generation; after `nano-banana-gate`'s, character generation for the named shots.
- **`prompts/index.json` is one row per written FILE, not per step.** A schema file has its own row, indistinguishable from its `.md` row except by extension; filter `file.endsWith(".md")` or key on `(nodeId, kind)`. `context` is absent where the YAML declared none and means the engine's default. Four rows carry raw Archon `when` expressions (`$diff.output != 'NO_CHANGES'` on `canon-gate`; `$outline-fix-gate.output == 'no'` on `outline-revise`; `$review-gate.output == 'no'` on `revise`) that Plan D translates into `when` predicates over `ctx.results`. `timeoutMs` is never recorded; Plan D chooses defaults. Twelve `dependsOn` targets have no row because they are script steps, guards or bash nodes (`audio-mix`, `diff`, `draft-complete-check`, `image-generate`, `master`, `nano-banana-generate`, `outline-fix-gate`, `review-gate`, `season-status`, `setup`, `stamp-outline`, `validate-manifest`); Plan D authors them from the YAML.
- **Three rewritten reject prompts keep an awkward lead-in** above the new sentence (`audio-gate.reject.md`'s "…then run:", `final-gate.reject.md`'s "— rebuild the timeline, re-render, re-master:", `image-audit.md`'s "run with Bash:"). Not contradictory; Plan D smooths them when it wires those gates, with one override each.
- **The three bash decisions** (`outline-fix-gate`, `review-gate`, the canon `diff`) become guards whose `check` always returns a message (`"yes"`/`"no"`), and `canon-diff.py` becomes a script step whose result the gate message quotes.
- **The premise is `Episodes/<id>/premise.md`**, written by the showrunner; the outline prompt reads it; `NEEDS_IDEA` derives from its existence. (This supersedes Plan B's record, which expected a setup-step result key.)
- **`publish-kit.py` requires `Episodes/<ep>/publish.json`** with a `logline`; the write pipeline creates one per new episode. All ten Season 1 files exist.
- **`finalize-video.py` exits non-zero** on an unresolvable slot or a missing video; a failed step, not a `SKIP`. It keeps the season-document fallback for a production id absent from `airMap`, and it has no `all` mode.
- **`populator-check.py` runs between `visual-direction` and the image branch** (spec F-16); the `visual-direction` prompt no longer embeds Python.
- **Staged timelines from before Plan C are rejected.** The show's `remotion/public/<ep>/timeline.json` files carry the old `title` shape; the render's parser refuses them. Always re-run `build-timeline.py` before a render. The stage (letterbox) colour reaches the render only through the title object; an episode with no title card letterboxes in black — write a top-level `stage` key if that ever matters.
- **Loop bodies carry no schema** (Plan B's guard), and the four loops (`draft`, `outline-revise`, `revise`, `image-audit`) are text-sentinel bodies.
- **Untested until the first real run:** `tts-generate.py`, `design-voice.py`, `image-generate.py`, `design-visual.py` (model or GPU), the render itself, the SDK's child process under abort. Also untested: `publish-kit.py`'s exit on an unplaced id; `populator-check.py` prints no progress for an episode with no character shots.
- **Test hygiene the reviews parked:** a disjunctive assertion in `test_season_status.py` (the property is pinned two tests later); a dead `import pytest`; the README-skip test in `tools` pairs the README with a good sibling (the fix wave added a bad one); the override lookarounds are unconditional, so a pattern must start and end at a word edge (loud when wrong); the two CLI `main()`s have no vitest.

## Plan E — the console

- The console's own copies of the air map, the NAS path and the id regex (inventory §6) are what Plan F deletes; until then the console still reads `.archon/scripts/finalize-video.py` as a data file. Plan E reads `showrunner.json` instead.
- `season-status.py` and `status.py` moved with the scripts and are retired at cutover; the board becomes the engine's derivation.

## Plan F — cutover

- Delete `.archon/`, `console/`, `remotion/` and the root `package.json` from the show repository; rename Season 1 to `sXXeYY`; empty `airMap`; retire the RULED-row grammar (it also accepts `**RULED-OUT**`, which no season document contains).
- The show's eight copied `test_*.py` files were moved or deleted with reasons in Task 5's report; `scripts/tests/` is the suite.
- Any SDK or Python dependency bump re-runs all four suites.

## Plan G — a second show

- The id grammar is the engine's (`engine/src/ids.ts`, mirrored in `scripts/lib/showconfig.py`); spec §7.3's "id scheme" is satisfied by `airMap` only. Whether a new show may choose a grammar is Plan G's question (spec §9.5).
- Unknown top-level groups in `showrunner.json` are dropped by the engine loader (the scripts read the raw file); a relative `..` `promptsDir` escapes the show root; `seasonOf` trusts a map the engine loader has validated. All three matter only once a config is not author-trusted.
- `video.compositionId` is in the config but nothing reads it yet; the render's composition id is the literal `Episode`.

## Stage 0 — the season desk (deferred by spec §0)

- `$desk-gate.output` renders as the whole gate answer object (`{{results.desk-gate}}`); the desk's plan decides a `<gate>:answer` key (F-04). `$season-status.output` renders as a script result the desk's plan must produce.
- The desk writes `Episodes/<id>/launch-premise.md`; the outline reads `premise.md`. Reconcile when the desk returns.

## Not a defect, recorded so nobody re-finds it

- Six scripts print no `::progress` line: `canon-diff.py` and `status.py` have no loop; `image-sheet.py`, `publish-kit.py`, `season-status.py`, `shot-sheet.py` complete in well under a second. Spec §6.7 scopes the contract to long-running scripts, all of which comply.
- The extractor does not prefix a workflow's name; a node id shared by two workflows is an error, and the five real workflows share none.
- The inventory's `Canon/season-1.md` count is thirteen sites plus one in a workflow's `description` field; the ten in prompt bodies are rewritten, the rest are never extracted.
- `finalize-video.py` treats two RULED rows naming one slot as one slot (a documented deviation from the original refusal); `publish-kit.py` exits 1 on an unplaced id instead of writing an `S00E00` kit.
- Two Task 1 hazards from Plan A that Plan C did not close and carries forward: no test that a stderr `::progress` line stays a `script_line` (the code is correct); the drain-grace test's `< 3000 ms` margin against a 2000 ms grace; two `hash.ts` tests still missing.
- `[YOUR NAME]` stays in `publish.channelName` until Ryan gives the credit name; `publish-kit.py` prints the reminder until then.

## Rulings made during execution

Each ruling is a decision the controller made without asking, with what it costs if wrong. Ryan can undo any of them.

1. **The seventeen inventory findings were ruled in the plan's table** before execution (premise file; script result line; guards with messages and `canon-diff.py`; F-04 deferred with Stage 0; `verdict` required; the sentence-period rule; `{{season}}`; argv-only everywhere; the mastered file beside its input; the lenient RULED grammar; QC children visible and in the group; the title card through the timeline; NAS keys; `airMap` plus fps/crossfade/loudness in config with milestones and the id regex as engine constants; `populator-check.py`; the credit name asked of Ryan). Cost if wrong: each is one config key or one script edit.
2. **DeadLight's branch cuts from `console-operating-layer`**, the real working branch, not the stale `main`. Cost if wrong: a rebase.
3. **`tools/show-data/` is the one engine-repository directory allowed to carry a show's name** (the extraction inputs). Cost if wrong: two files to move.
4. **The script result is read after the pipes drain**, not in the `exit` handler, and an escaped grandchild's late lines count toward it. Cost if wrong: an escapee's line replaces a summary, which only a session-escaping child can cause.
5. **The whole `ShowConfig` is visible to prompts as `{{show.*}}`** — the agent can read `showrunner.json` from disk anyway. Cost if wrong: none.
6. **`Override.nodeId` is optional; `index.json` has one row per file; `context` is recorded only where declared; a node without a model inherits the workflow's.** Cost if wrong: none.
7. **The extractor fails loudly**: collisions throw before any write, unused overrides and schema entries exit 1, override patterns match on word boundaries, a non-empty output directory needs `--force`. Cost if wrong: none.
8. **`check-prompts` skips `README.md`.** Cost if wrong: one filename.
9. **The `visual-direction` override spans YAML 437–460**, through the end of the prompt body. Cost if wrong: one override entry.
10. **`airMap` keeps ten entries** (the values agree with the season-document resolution); `finalize-video.py` keeps the `season_slot` fallback and drops `all` mode. Cost if wrong: none today.
11. **Every script has a `__main__` guard, makes the root absolute and loads before `chdir`, catches `ShowConfigError` and `FileNotFoundError` in one line; `sc.value` is the seventh helper; both `--show-root` forms.** Cost if wrong: none.
12. **`MIX_OK` reports the loudness the apply pass measured**, with a `(target)` suffix only when the parse fails. Cost if wrong: none.
13. **Only an unmapped, well-formed production id falls back to `episode.wav`** (`UnmappedEpisodeId`); a malformed id is a config error. Cost if wrong: none.
14. **The capping idiom is clean** in the populator guard (the brief's "flagged" was the controller's slip). Cost if wrong: none.
15. **`build-timeline.py`'s staging root is the engine's `render/public/<ep>`**, with `--render-root` for tests. Cost if wrong: one flag.
16. **`render/` is a standalone package**, not a root workspace. Cost if wrong: one `workspaces` entry.
17. **`REMOTION_EPISODE` has no default.** Cost if wrong: one environment variable the assemble step must set.
18. **Task 7's review was folded into the whole-branch review** (token budget). Cost if wrong: a docs defect caught one review later.
19. **The six reject prompts were rewritten to the pipeline-run form** rather than left byte-faithful to their sources, with the Plan D obligation above. Cost if wrong: Plan D edits six prompt files.
20. **The Python loader was brought to parity with the engine loader** rather than only rewording the parity sentences. Cost if wrong: fifteen lines.
21. **The README's constraint grep carries the plan's full word list** (the whole-branch reviewer's dispute, accepted), and character and place names beyond it are a review obligation. Cost if wrong: none.
22. **Plan C's spec §7.3 override is recorded** (the id grammar is the engine's; `airMap` is the "id scheme"). Cost if wrong: one sentence.
