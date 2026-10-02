# Plan F inventory — the cutover, measured

**Date:** 2026-10-02 · **Status:** measurement only. Nothing in either repository was changed to produce this document, except this file.
**Purpose:** the inventory Plan F ("cutover") is written from. Plan F executes spec §7.5's ordered sequence — the engine reads `sXXeYY` (already true), Season 1 is renamed in one commit, `console/`, `.archon/`, `remotion/` and the root `package.json` are deleted from the show repository, and the first Season 2 episode runs on the new engine — and pays the twenty-three obligations the five earlier plans deferred to it. This document measures the rename as it stands on 2026-10-02, measures what the engine and the Python scripts assume about ids once the rename lands, measures what leaves the show repository, and records the engine repository's own outstanding hygiene. **It proposes no design.**

**The two repositories this document cites.**

| Short form in a citation | Repository |
|---|---|
| `Canon/*`, `Episodes/*`, `Production/*`, `prompts/*`, `showrunner.json`, `README.md` (show), `docs/superpowers/*`, `console/*` (v1), `.archon/*`, `remotion/*`, `.agent-logs/*` | the show — `/Users/ryanperkowski/GitHub/DeadLight`, branch `main` at `6b157b8` |
| `engine/src/*.ts`, `engine/test/*.ts`, `console/server/*.ts` (v2), `scripts/*.py`, `scripts/tests/*.py`, `render/*`, `tools/*`, `docs/*`, `README.md` (engine) | the engine — `/Users/ryanperkowski/GitHub/Showrunner`, branch `plan-f` cut from `main` at `9347474` |

**Where a citation is ambiguous between the two `console/` trees, this document writes "console v1" for the show's and "the engine's `console/`" for Plan E's.**

**Counts, stated up front.**

| Quantity | Count |
|---|---|
| Directories the rename moves | **20** — `Episodes/ep01`–`ep10` and `Production/ep01`–`ep10` (spec §5.2's figure, confirmed) |
| Git-tracked files inside those 20 directories | **185** (Episodes 61, Production 124) |
| Files on disk inside those 20 directories | **6,565** — 185 tracked, 6,378 git-ignored, 2 untracked |
| Bytes inside those 20 directories | **13.20 GB** |
| Git-tracked files carrying an `epNN/` path reference | **83**, with **443** occurrences |
| Git-ignored files carrying an `epNN/` path reference | **10** (`Production/epNN/video/timeline.json`), with **504** occurrences |
| — of the 83 tracked: inside a renamed directory (move **and** edit) | **45** |
| — of the 83 tracked: outside every renamed directory (edit in place) | **38** |
| Tracked manifests carrying an `"episode"` field | **29** show-wide; **21** inside `Production/ep01`–`ep10` |
| Ignored or untracked manifests carrying an `"episode"` field | **13**, all inside `Production/ep01`–`ep10` |
| `airMap` entries to empty (`showrunner.json:14-55`) | **10** |
| `prompts/*.md` naming an `Episodes/ep01/…` exemplar path | **3 files, 4 references** |
| Archive markers to carry through the rename | **10** (`Episodes/epNN/archive.json`) |
| Tracked casting-pile stills named `<ep>-<shot-id>.png` | **151**, across 9 character folders under `Canon/characters/` |
| Bare `epNN` prose mentions that are **not** swept (spec §5.3) | **585**, across **135** files |
| Air-slot prose mentions already in the show (`E9`, `Ep. 9`, `S1E9`, `S01E09`) | **1,594**, across **95** files |
| Console v1 lines of TypeScript and TSX leaving the show | **21,643** across 84 files (11,770 production, 9,873 test), plus **2,233** lines of CSS |
| `.archon/` files leaving the show | **35** tracked — 5 workflow YAMLs (2,167 lines), 30 Python files (5,000 lines, of which 8 are copied `test_*.py`) |
| `remotion/` files leaving the show | **6** tracked (186 lines of TSX/TS), plus 505 MB of `node_modules` and 2.3 GB of ignored `remotion/public/` staging |
| Obligations the five deferred records assign to Plan F | **23** (table below) |
| Findings | **24** (§5) |

---

## The obligations the five deferred records assign to Plan F, collected

**Every Plan-F bullet in the five records, with its address.** Plan F's author is accountable for each one; the findings in §5 restate the subset that needs a ruling rather than a line of code. Rows O-01 through O-09 are engine hygiene (§4); O-10 through O-23 are the cutover itself (§1–§3).

| # | Obligation, in one line | Source |
|---|---|---|
| O-01 | **The engine version exists three times** and the smoke test compares a literal to itself. Read it from `package.json` in one place. | `docs/plans/2026-09-26-engine-core-deferred.md:53` |
| O-02 | **Every `mkdtemp` root in the suite is left behind.** Add a suite-wide `afterEach` cleanup. | `docs/plans/2026-09-26-engine-core-deferred.md:54` |
| O-03 | **Two commits carry their trailers in two paragraphs** (`402e489`, `2fc5e7f`), so `git log --format='%(trailers)'` parses only `Claude-Session` on them. History stands because every plan amendment names those SHAs. | `docs/plans/2026-09-26-engine-core-deferred.md:55` |
| O-04 | **A subpath export for the SDK adapter.** `engine/src/index.ts` re-exports `sdk-query.js`, so every consumer of the barrel loads the SDK module at import. Parked as a packaging decision. | `docs/plans/2026-09-27-agent-runner-deferred.md:47` |
| O-05 | **The SDK's three peer dependencies** (`zod ^4`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) are satisfied by npm's automatic peer install and are undeclared in `engine/package.json`. | `docs/plans/2026-09-27-agent-runner-deferred.md:48` |
| O-06 | **`npm audit` reports five advisories**, all in the vitest/vite/esbuild chain; none reachable from shipped code. Plan F's hygiene task decides. | `docs/plans/2026-09-27-agent-runner-deferred.md:49` |
| O-07 | **`devDependencies` key order** was normalized by npm; noise. | `docs/plans/2026-09-27-agent-runner-deferred.md:50` |
| O-08 | **The three Plan A items** (version triplication, `mkdtemp` cleanup, the two-paragraph trailer commits) still stand as of Plan B. | `docs/plans/2026-09-27-agent-runner-deferred.md:51` |
| O-09 | **The barrel's re-export of the adapter stays**, under one condition: **any bump of the pinned SDK version re-runs the import side-effect probe before merging.** | `docs/plans/2026-09-27-agent-runner-deferred.md:77` |
| O-10 | **Console v1's own copies of the air map, the NAS path and the id regex are what Plan F deletes**; until Plan F, v1 still reads `.archon/scripts/finalize-video.py` as a data file. | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:32` |
| O-11 | **Delete `.archon/`, `console/`, `remotion/` and the root `package.json` from the show repository; rename Season 1 to `sXXeYY`; empty `airMap`; retire the RULED-row grammar** (which also accepts `**RULED-OUT**`, a form no season document contains). | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:37` |
| O-12 | **The show's eight copied `test_*.py` files were moved or deleted with reasons in Plan C's Task 5 report; `scripts/tests/` is the suite.** | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:38` |
| O-13 | **Any SDK or Python dependency bump re-runs all four suites.** | `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:39` |
| O-14 | **The six `scripts/status.py` steps and `STATUS.md` retire with console v1. `prompts/index.json` can be deleted then. The `previous-episode` guard's "no run logs means the archive" rule stays correct after the rename.** | `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:30` |
| O-15 | **`previous-episode` never crosses a season boundary** (`id.episode === 1` passes unconditionally), so rule 1.3 is not enforced from `s01e10` to `s02e01`. | `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:31` |
| O-16 | **`prompts/audio-gate.gate.md` names the mix with an air-named glob** (`DeadLight *.wav`), which misses an unmapped production id's `episode.wav`; every id is air-named after the rename. | `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:32` |
| O-17 | **`EventLog.logPath` hardcodes `Production`** while the pipeline reads `show.productionDir`; identical for this show. | `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:33` |
| O-18 | **Console v1, `.archon/`, `remotion/` and the root `package.json` leave the show repository; `STATUS.md` and the six `scripts/status.py` steps retire. Archived episodes carry `<episodesDir>/<id>/archive.json` `{stage, note}`, read only when the episode has no run logs; Plan F carries the ten files through the Season 1 rename and decides what `ep98` and `ep99` should show.** | `docs/plans/2026-10-02-the-console-deferred.md:19` |
| O-19 | **`prompts/index.json` can be deleted.** | `docs/plans/2026-10-02-the-console-deferred.md:20` |
| O-20 | **`prompts/audio-gate.gate.md`'s air-named glob and the ten `epNN` encodings the Plan E inventory listed in console v1 go with v1.** | `docs/plans/2026-10-02-the-console-deferred.md:21` |
| O-21 | **Console v1 listens on 4400 (Vite 5183); the engine's console defaults to 4410 and 5193**, so both run side by side during the transition. Plan F retires v1. | `docs/plans/2026-10-02-the-console-deferred.md:44` |
| O-22 | **`ep99` is a production directory holding a spike, not an episode**; it joins Plan F's archived-episode question with Season 1. | `docs/plans/2026-10-02-the-console-deferred.md:46` |
| O-23 | **The ten `archive.json` marker files move with the Season 1 rename.** | `docs/plans/2026-10-02-the-console-deferred.md:69` |

**Three spec clauses are obligations too, and are not in the table because they come from the spec rather than a deferred record.** Spec §5.2 (`docs/specs/2026-09-25-console-rewrite-design.md:138`): the rename is **one commit**, and "the completion check is a grep for stale `ep0N/` paths returning zero". Spec §5.4 (`:146`): the rename is the orchestrator's **first shipped task** — "teach the engine `sXXeYY`, move Season 1 in one commit, then delete every `epNN`-shaped code path". Spec §7.4 (`:212`): `.archon/workflows/` "is the source the prompts are extracted from and is deleted at cutover".

---

## 1 · The rename, measured today

**Conclusion: the rename is 20 directory renames, 83 tracked file edits, one `airMap` emptied, and nothing on the NAS.** Every substitution is mechanical, as spec §5.2 (`docs/specs/2026-09-25-console-rewrite-design.md:138`) says. Two measurements contradict assumptions in the record and are stated in §1.2 and §1.3: `git mv` on a directory **does** carry its git-ignored content, and the file count is 83 rather than the spec's 52.

### 1.1 The 20 directories, with their tracked file counts

Each count is `git ls-files <dir> | wc -l` run in the show repository at `6b157b8`. "On disk" is `find <dir> -type f | wc -l`; "ignored" is `git ls-files --others --ignored --exclude-standard <dir> | wc -l`.

| Directory | → becomes | Tracked | On disk | Ignored | Bytes |
|---|---|---|---|---|---|
| `Episodes/ep01` | `Episodes/s01e01` | 8 | 8 | 0 | 0.2 MB |
| `Episodes/ep02` | `Episodes/s01e02` | 5 | 5 | 0 | 0.1 MB |
| `Episodes/ep03` | `Episodes/s01e03` | 5 | 5 | 0 | 0.1 MB |
| `Episodes/ep04` | `Episodes/s01e04` | 5 | 5 | 0 | 0.1 MB |
| `Episodes/ep05` | `Episodes/s01e05` | 7 | 7 | 0 | 0.1 MB |
| `Episodes/ep06` | `Episodes/s01e06` | 6 | 6 | 0 | 0.1 MB |
| `Episodes/ep07` | `Episodes/s01e07` | 6 | 6 | 0 | 0.1 MB |
| `Episodes/ep08` | `Episodes/s01e08` | 6 | 6 | 0 | 0.1 MB |
| `Episodes/ep09` | `Episodes/s01e09` | 7 | 7 | 0 | 0.1 MB |
| `Episodes/ep10` | `Episodes/s01e10` | 6 | 7 | 1 (`.DS_Store`) | 0.2 MB |
| `Production/ep01` | `Production/s01e01` | 32 | 897 | 865 | 2,256 MB |
| `Production/ep02` | `Production/s01e02` | 10 | 518 | 508 | 1,166 MB |
| `Production/ep03` | `Production/s01e03` | 15 | 403 | 388 | 1,061 MB |
| `Production/ep04` | `Production/s01e04` | 12 | 436 | 424 | 1,137 MB |
| `Production/ep05` | `Production/s01e05` | 7 | 482 | 475 | 1,002 MB |
| `Production/ep06` | `Production/s01e06` | 6 | 580 | 574 | 1,090 MB |
| `Production/ep07` | `Production/s01e07` | 17 | 802 | 785 | 1,412 MB |
| `Production/ep08` | `Production/s01e08` | 12 | 573 | 561 | 1,416 MB |
| `Production/ep09` | `Production/s01e09` | 5 | 588 | 583 | 1,340 MB |
| `Production/ep10` | `Production/s01e10` | 8 | 1,224 | 1,214 + 2 untracked | 1,637 MB |
| **Total** | | **185** | **6,565** | **6,378 + 2** | **13.20 GB** |

**The two untracked files under `Production/ep10` are the ones `git status` reports at `6b157b8`:** `Production/ep10/tts-script-v1-prepause.json` and `Production/ep10/tts-script.json.bak-preop`. Neither is ignored by `.gitignore`; both are pre-op backups from ep10's pause work. **Plan F decides whether they are committed, deleted, or carried as untracked content through the rename.**

**What the tracked files inside those directories are**, so the plan can state what moves. Under `Episodes/epNN`: `STATUS.md` ×10, `script.md` ×10, `publish.json` ×10, `archive.json` ×10, `outline.md` ×7, `launch-premise.md` ×6, `locked-beats.md` ×4, and four one-off historical variants (`script-v1-handwritten.md`, `outline-v1-handwritten.md`, `outline-v1-preMute.md`, `removed-from-script-2026-08-29.md`). Under `Production/epNN`: `tts-script.json` ×10, `publish/upload.md` ×10, `publish/captions.srt` ×10, `images/prompts.json` ×10, `images/IMAGE-SHEET.md` ×8, 64 `guest-refs/*.wav`, 10 `casting-samples/*.wav` (all under `Production/ep01`), five `notes/*.md` (all under `Production/ep06`), four other image sheets, `tts-script.RESEG.json`, and one tracked Python file, `Production/ep10/fix_ep10_audio.py`.

**Directories that are NOT renamed, and are named here so the plan does not sweep them by accident.** `Episodes/ep98` (3 tracked files), `Production/ep98` (2 tracked, 563 on disk, 1.6 GB), `Production/ep99` (1 tracked, 3 on disk, 98 MB), `Episodes/_retired/ep99` (3 tracked), `Episodes/_TEMPLATE` (1), `Production/_archive/ep01-v2` and `Production/_archive/ep01-coldopen-v2` (1 tracked manifest each), `Production/_archive/test-fixture`, `Production/casting-samples` (25), `Production/voice-refs` (10). **`Production/voice-refs` carries no `epNN` in any name** — its ten files are `cricket.wav`, `ilvaren.wav`, `mute.wav`, `narrator.wav`, `opha.wav`, `refs.json`, `remo.wav`, `sable.wav`, `sarn.wav`, `trent.wav` — so it is untouched by the rename despite being named in the Plan F brief as a candidate. Per-episode guest references live at `Production/epNN/guest-refs/` and move with their episode directory; `showrunner.json:95` already addresses them as `Production/{episodeId}/guest-refs`.

### 1.2 What `git mv` actually moves — measured, and it is not what the record assumed

**Measured 2026-10-02 in a scratch repository: `git mv <dir> <newdir>` moves git-ignored and untracked content inside that directory, because it performs one filesystem `rename(2)` of the directory and then updates the index for the tracked entries only.** The test built `ep01/` holding one tracked file, one tracked file in a subdirectory, one ignored file under an ignored subdirectory, and one untracked file; `git mv ep01 s01e01` exited 0, `ep01` no longer existed, and all four files were present under `s01e01`, with `git status` reporting `R ep01/tracked.md -> s01e01/tracked.md`, `R ep01/sub/tracked2.md -> s01e01/sub/tracked2.md`, and `?? s01e01/untracked.txt`.

**The consequence for Plan F: the 13.20 GB of audio, video and PNGs does not need a separate filesystem move, and the rename stays one commit.** Twenty `git mv` calls move 6,565 files at the cost of twenty directory renames. The atomicity spec §5.2 asks for is achievable without a second, unversioned step — see F-01.

**No `.gitignore` edit is needed.** `/Users/ryanperkowski/GitHub/DeadLight/.gitignore` names no `epNN` anywhere. Every per-episode pattern is a one-level wildcard that keeps matching after the rename: `Production/*/audio/`, `Production/*/audio-spike/`, `Production/*/video/`, `Production/*/images/*.png`, `Production/*/images/*.jpg`, `Production/*/images/.*.bak`, `Production/*/images-v1-dark/`, `Production/*/audio-v1-*/`, `Production/*/notes/*.draft.md`.

**Five files on disk carry `epNN` in their own basename inside the renamed directories**, and nothing parses any of them: `Production/ep10/fix_ep10_audio.py` (tracked) and four ignored audition WAVs under `Production/ep09/audio/_audition/` named `ep08-seg329-original.wav`, `ep08-seg329-reroll.wav`, `ep08-seg355-original.wav`, `ep08-seg355-reroll.wav`. They move with their directory and keep their old basenames.

### 1.3 The 93 files carrying an `epNN/` path reference

The grep, run from the show root, with `console/`, `.archon/`, `remotion/`, `node_modules` and the two untracked `Production/ep10/*` backups excluded:

    grep -rnoE '\bep(0[1-9]|10)/' --include='*.md' --include='*.json' --include='*.yaml' \
      --include='*.py' --include='*.ts' --include='*.tsx' --exclude-dir=node_modules \
      Canon Episodes Production prompts docs README.md showrunner.json package.json

**93 files, 947 occurrences. 83 of the 93 are git-tracked (443 occurrences); the other 10 are the git-ignored `Production/epNN/video/timeline.json` files (504 occurrences).**

**The spec's measured scope was 52 files (spec §5.2, `docs/specs/2026-09-25-console-rewrite-design.md:138`), measured 2026-09-25.** Today's figure is 83 tracked files. The difference is not reconcilable by any single obvious filter — `.md` only gives 74, `.md` outside `docs/` gives 57, `.md` outside `docs/` and `Production/` gives 33 — and the show repository has taken Plan C's, Plan D's and the archive-marker PR's edits since. **Plan F should re-measure rather than carry the 52 forward** (F-16).

**By group. 1.3.1 Canon and documentation prose citations — 30 files, 202 occurrences, all edited in place.**

| File | Occurrences |
|---|---|
| `Canon/season-desk-report.md` | 71 |
| `Canon/continuity-ledger.md` | 40 |
| `Canon/season-1.md` | 12 |
| `Canon/technology.md`, `Canon/characters/The Mute/the-mute.md`, `Canon/characters/Ernie Grother/ernie-grother.md`, `Canon/characters/Ansa/ansa.md` | 2 each |
| `Canon/voice-registry.md`, `Canon/style-guide.md`, `Canon/species/iss-kar.md`, `Canon/season-2.md`, `Canon/locations/Long Odds/long-odds.md`, `Canon/locations/Greenmarch/greenmarch.md` | 1 each |
| `docs/superpowers/plans/2026-07-23-archon-getwell-phase5-ep05-acceptance.md` | 14 |
| `docs/superpowers/plans/2026-07-09-pipeline-v1-write-and-canon.md` | 14 |
| `docs/superpowers/plans/2026-07-23-archon-getwell-phase0-1.md` | 7 |
| `docs/superpowers/plans/2026-07-28-season-desk.md` | 6 |
| `docs/superpowers/plans/2026-07-27-nano-banana-generate.md` | 5 |
| `docs/superpowers/specs/2026-09-18-season-2-mechanisms-design.md` | 4 |
| `docs/superpowers/specs/2026-07-09-deadlight-production-pipeline-design.md`, `docs/superpowers/plans/2026-07-31-console-operating-layer.md`, `docs/superpowers/plans/2026-07-28-console-phase2a.md`, `docs/superpowers/2026-09-17-season-2-next-session-prompt.md` | 2 each |
| `docs/superpowers/specs/2026-09-17-season-2-design.md`, `…/2026-07-31-console-operating-layer-design.md`, `…/2026-07-30-the-mute-redesign-design.md`, `…/2026-07-28-season-desk-design.md`, `…/2026-07-28-console-phase2a-design.md`, `…/2026-07-27-nano-banana-generate-design.md`, `docs/superpowers/plans/2026-07-23-archon-getwell-phase4-assemble-publish.md` | 1 each |

These are the `ep09/script.md:430`-shaped citations spec §5.2 describes. **`Canon/season-desk-report.md` alone carries 71 of them** and is a generated artifact of the deferred season desk (`docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:37` records the seven desk prompts as "spec §0's deferred desk, not dead code"), so whether it is swept or deleted is a decision rather than a substitution.

**1.3.2 Episode narrative files — 17 files, 65 occurrences; 14 move with their directory, 3 are edited in place.** `Episodes/ep10/outline.md` (14), `Episodes/ep09/outline.md` (9), `Episodes/ep05/outline.md` (6), `Episodes/ep08/outline.md` (5), `Episodes/ep10/launch-premise.md` (4), `Episodes/ep07/outline.md` (4), `Episodes/ep06/outline.md` (3), `Episodes/ep05/outline-v1-preMute.md` (3), `Episodes/ep01/outline.md` (3), `Episodes/ep05/launch-premise.md` (2), `Episodes/ep04/locked-beats.md` (2), `Episodes/ep01/locked-beats.md` (2), `Episodes/ep09/removed-from-script-2026-08-29.md` (1), `Episodes/ep09/launch-premise.md` (1). **Edited in place because they live outside the 20 directories:** `Episodes/_retired/ep99/outline.md` (3), `Episodes/ep98/outline.md` (2), `Episodes/ep98/STATUS.md` (1).

**1.3.3 Production sheets and publish copy — 31 files, 157 occurrences; 29 move with their directory, 2 are edited in place.** `Production/ep08/images/SHOT-SHEET.md` (45), `Production/ep06/notes/hand-prompts.md` (19), `Production/ep10/images/SHOTS-TO-MAKE.md` (17), `Production/epNN/publish/upload.md` (4 each, ten files, 40 total), `Production/epNN/images/IMAGE-SHEET.md` (1 each, eight files), `Production/ep03/images/NANO-BANANA-BRIEFS.md` (2), `Production/ep04/images/NANO-BANANA-BRIEFS.md` (1), `Production/ep10/images/AMBIENT-CONTEXT.md` (1). **Edited in place:** `Production/_archive/ep01-v2/tts-script.json` (6) and `Production/_archive/ep01-coldopen-v2/tts-script.json` (3) — see F-15.

**1.3.4 The ten `Production/epNN/video/timeline.json` files are git-ignored and carry 504 of the 947 occurrences.** Each one holds the `epNN/`-prefixed paths the Remotion renderer resolves against its `public/` staging directory: `Production/ep03/video/timeline.json:5` carries `"audio": "ep03/audio.wav"` and every one of its 44 `shots[].src` entries is `ep03/images/<shot-id>.png`. **These are not swept by a tracked-file grep and must not be, because the engine rewrites them: `scripts/build-timeline.py` regenerates the file from scratch and stages into `render/public/<episodeId>/` in the engine repository.** No Season 1 episode will be rebuilt, so their stale paths are harmless — but spec §5.2's completion check ("a grep for stale `ep0N/` paths returning zero") will **not** return zero unless the grep excludes them (F-14).

**1.3.5 Rename similarity, measured.** The densest reference-carrying file is `Production/ep08/images/SHOT-SHEET.md` at 45 referenced lines in 816 — 5.5%. Across all 45 files that both move and are edited, the maximum share of lines touched is **8.5%** (`Production/ep10/images/SHOTS-TO-MAKE.md`, 17 of 201). A scratch-repository test of rename-plus-edit in one commit reported `R099` similarity and `git log --follow` traversed the rename, so **history is preserved** (F-02).

### 1.4 The manifests with an `"episode"` field

**29 tracked JSON files carry an `"episode"` field; 21 of them are inside the 20 directories.** `Production/epNN/tts-script.json` ×10, `Production/epNN/images/prompts.json` ×10, and `Production/ep03/tts-script.RESEG.json`. **Spec §5.2 counted 22**; the 21 measured today is the same set minus whatever the twenty-second was on 2026-09-25.

Outside the 20 directories: `Production/ep98/tts-script.json`, `Production/ep98/images/prompts.json`, `Production/ep99/tts-script.json` (all keep their ids), `Production/_archive/ep01-v2/tts-script.json` (`"episode": "ep01-v2"`), `Production/_archive/ep01-coldopen-v2/tts-script.json` (`"episode": "ep01-coldopen-v2"`), `Production/_archive/test-fixture/tts-script.json` and `…/images/prompts.json` (`"episode": "test-fixture"`).

**A further 13 manifests with an `"episode"` field are git-ignored or untracked, all inside the 20 directories:** `Production/epNN/audio/manifest.json` ×10, `Production/ep01/audio-v1-predensity/manifest.json`, `Production/ep10/audio-v1-prepause/manifest.json`, and the untracked `Production/ep10/tts-script-v1-prepause.json`. They move with the directory and keep their stale values unless edited.

**`Production/epNN/video/timeline.json` has no `"episode"` key at all.** Its keys are `fps`, `width`, `height`, `audio`, `durationInFrames`, `crossfadeFrames`, `shots`, `title`.

**Nothing in the engine or the scripts reads the `"episode"` field back.** The only site that touches it is `scripts/tts-generate.py:133`, which writes it: `json.dump({"episode": ep, "sr": sr, "segments": manifest}, f, indent=1)`. `scripts/validate-manifest.py` never mentions it; neither does `engine/src/needs.ts`, which reads `prompts.json`'s `shots` and nothing else. **The field is already wrong for ep01 and nobody noticed:** `Production/ep01/tts-script.json` and `Production/ep01/audio/manifest.json` both say `"episode": "ep01-v2"` while the directory is `ep01`. That is the measurement that settles O-18's question about validation — see F-05.

### 1.5 `showrunner.json`'s `airMap`

**Ten entries, `showrunner.json:14-55`**: `ep01: [1,1]` through `ep10: [1,10]`, one array per line in the pretty-printed file. Emptying it is a replacement of lines 14–55 with `"airMap": {},`.

**Both loaders accept an empty `airMap`, verified by running them against a copy of the show's config with `airMap` set to `{}`.** The engine's `loadShowConfig` loaded it and `seasonOf("s01e01", {})` returned `1`; `mixFilename(cfg, "s01e01")` returned `DeadLight S01E01.wav` and `mixFilename(cfg, "ep98")` returned `episode.wav`; `seasonOf("ep01", {})` threw `ShowConfigError: no season for production id ep01: it is not in airMap`. The Python loader loaded it, `sc.season_of(cfg, "s01e01")` returned `(1, 1)`, and `sc.season_of(cfg, "ep01")` and `sc.season_of(cfg, "ep98")` both raised `UnmappedEpisodeId`. `airMap` stays a required key in both loaders (`scripts/lib/showconfig.py:60`, `engine/src/show-config.ts:66`), so the key must remain present with an empty object rather than be deleted.

### 1.6 The prompt files naming `Episodes/ep01/…` as an exemplar

**Three files, four references, and each one is a path an agent `Read`s at run time.**

| Address | Text |
|---|---|
| `prompts/draft.md:6` | `Episodes/ep01/script.md is the canonical register; reread its first` |
| `prompts/draft.md:26` | `header matching Episodes/ep01/script.md's header format if it does` |
| `prompts/outline.md:21` | `Read Episodes/ep01/outline.md — your output must match its format and` |
| `prompts/tone-check.md:3` | `Episodes/ep01/script.md (the register made flesh). Read both, then read` |

**After the rename these four paths do not exist, and the first Season 2 run's `outline`, `draft` and `tone-check` steps each read a missing file.** This is the highest-consequence single substitution in the whole sweep — see F-08.

### 1.7 The ten archive markers

`Episodes/ep01/archive.json` … `Episodes/ep10/archive.json`, each `{"stage": "COMPLETE", "note": "Season 1, made by console v1; final on the NAS <date>"}` with the ten dates 2026-07-18, 07-22, 07-24, 07-28, 08-02, 08-14, 08-18, 08-26, 09-04, 09-16.

**No marker contains an episode id, so none needs a content edit — only the move.** The reader is `console/server/episodes.ts:78` in the engine: `path.join(ctx.showRoot, ctx.episodesDir, episodeId, ARCHIVE_FILE)`, with `ARCHIVE_FILE = "archive.json"` (`:57`). After the rename the console asks for `Episodes/s01e01/archive.json`, which is where `git mv Episodes/ep01 Episodes/s01e01` puts it. **O-23 is paid by the directory rename alone.**

**`ep98` and `ep99` have no marker,** which is the state O-18 asks Plan F to rule on (§2.7, F-10).

### 1.8 `Canon/season-1.md` and `Canon/season-2.md`

**Both slate tables key their rows on a bare air ordinal, not on a production id.** `Canon/season-1.md:21-32` is `| Ep | Status | Job of the episode | Character focus | World element planted | Arc notch |` with ten data rows beginning `| 1 | **RULED** |` through `| 10 | **RULED — REWRITTEN 2026-08-27** |`. `Canon/season-2.md:68-89` has the same header and twenty data rows, `| 1 |` through `| 20 |`, of which **3 are `**RULED**` (air 1, 2, 3) and 17 are `**DRAFT**`**.

**So the rename does not touch either table's keys.** What it touches is the `epNN/` file paths quoted inside row text: 12 occurrences in `Canon/season-1.md` (rows 1, 6, 7, 8, 10 and the notes below the table, citing `Episodes/ep01/locked-beats.md`, `Episodes/ep06/launch-premise.md`, `Episodes/ep07/launch-premise.md`, `Episodes/ep08/launch-premise.md`, `ep09/script.md:426,438`) and 1 in `Canon/season-2.md` (row 1, citing `ep10/script.md:389`).

### 1.9 The casting-pile stills under `Canon/characters/`

**151 tracked PNGs named `<ep>-<shot-id>.png`, in 9 folders:** Trent 34, Sarn 30, Sable 30, Opha 28, Remo 23, Millies-Bite 2, Ansa 2, Mink 1, Mardo 1. They are **tracked, not ignored** (`git check-ignore` returns nothing for them), so a rename of each is a `git mv` per file.

**`scripts/registry-append.py:90` writes the name:** `dst = os.path.join(folder, f"{ep}-{s['id']}.png")`, where `ep` is `sys.argv[1]`. For a Season 2 episode that is `s02e01-<shot-id>.png`, which is correct with no code change.

**`scripts/nano-banana-generate.py:67-72` selects the two newest pile stills by modification time, never by name:**

    def _pile_stills(sheet_path: str) -> list[str]:
        """Newest-first approved stills from the character's folder (sheet excluded)."""
        folder = os.path.dirname(sheet_path)
        pngs = [os.path.join(folder, f) for f in os.listdir(folder)
                if f.endswith(".png") and os.path.join(folder, f) != sheet_path]
        return sorted(pngs, key=os.path.getmtime, reverse=True)[:STILLS_PER_SUBJECT]

`STILLS_PER_SUBJECT = 2` (`:39`). **Nothing in the engine or the scripts parses a pile still's filename** — the only other reader of `visual.castingPileDir` is `scripts/image-sheet.py:71`, which uses the directory to name the style authority in its sheet text, and `scripts/design-visual.py:63`, which writes candidates into it. **So the 151 old names are inert either way, and whether they are renamed is a legibility decision rather than a correctness one** (F-07).

### 1.10 The NAS finals — nothing on the NAS needs renaming

**`showrunner.json:59`: `"finalFilename": "{slug} S{season:02d}E{episode:02d}.mp4"`, with `"showSlug": "DeadLight"` (`:3`).** `scripts/finalize-video.py:138-141` renders it:

    name = sc.format_filename(str(sc.value(cfg, "output", "finalFilename")),
                              slug=str(sc.value(cfg, "showSlug")),
                              season=season, episode=episode, episode_id=ep)

where `(season, episode)` comes from `resolve_slot` (`:108-120`). **The name is built from the air slot and never from the production id, so `DeadLight S01E01.mp4` through `DeadLight S01E10.mp4` are the same names before and after the rename:** `sc.season_of(cfg, "ep01")` returned `(1, 1)` through the `airMap`, and `sc.season_of(cfg, "s01e01")` returns `(1, 1)` off the id itself. The show's own records confirm the names — `Episodes/ep01/STATUS.md:5` reads `- 2026-07-18 finalized: NAS DeadLight S01E01.mp4`, and `Episodes/ep02/STATUS.md:4` reads `- 2026-07-22 finalized: NAS DeadLight S01E02.mp4 (scene pauses)`.

**The NAS was not mounted at the time of measurement** (`/Volumes/media` does not exist; it needs remounting by hand after every reboot), so the names above are derived from the config, the script and the show's `STATUS.md` records rather than read off the share. **Spec §5.2 attributes the air-slot naming to `scripts/audio-mix.py:17`; that line names the mixed WAV, not the final MP4.** `scripts/audio-mix.py:14-31`'s `mix_wav` renders `output.mixFilename` (`showrunner.json:60`, `"{slug} S{season:02d}E{episode:02d}.wav"`), and the local mixes confirm it: `Production/ep01/audio/DeadLight S01E01.wav` and `Production/ep10/audio/DeadLight S01E10.wav` are on disk under the old directory names today. **The local mixes are therefore already air-named and do not change either.** `output.videoFilename` is the literal `episode.mp4` (`showrunner.json:61`), and `Production/ep10/video/episode.mp4` is on disk.

### 1.11 What is NOT swept — spec §5.3's bare prose mentions

**585 bare `epNN` prose mentions across 135 files, measured with the same id range and the trailing `/` excluded.** Spec §5.3 (`docs/specs/2026-09-25-console-rewrite-design.md:144`) said "roughly 600", and the measurement holds. The heaviest files: `Production/ep06/notes/hand-prompts.md` (41), `docs/superpowers/plans/2026-07-23-archon-getwell-phase0-1.md` (41), `Canon/voice-registry.md` (27), `docs/superpowers/plans/2026-07-28-season-desk.md` (26), `docs/superpowers/plans/2026-07-09-pipeline-v1-write-and-canon.md` (23), `docs/superpowers/plans/2026-07-31-console-operating-layer.md` (22), `docs/superpowers/plans/2026-07-27-nano-banana-generate.md` (21), `Episodes/ep09/outline.md` (18), `Canon/technology.md` (17), `Canon/season-desk-report.md` (16).

**Two of the 135 are JSON data files rather than prose**, and both carry their `epNN` inside free-text annotation fields, so they are prose by §5.3's test: `Canon/refs.json` (15 mentions, in `locked` and description strings — e.g. `:66` `"Nano Banana, Ryan-approved 2026-07-22 (ep03 door shot; single-frame ref, not a turnaround)"`) and `Production/voice-refs/refs.json` (7 mentions, in `arc_note` and register labels — e.g. `:43` `"R1 cocky (ep01-ep03 opening — the original base)"`). **No key in either file is an episode id.**

**The air-slot forms already outnumber them 1,594 to 585** across 95 files: `EN` 1,112, `Ep. N` 313, `S1EN` 107, `S01EN` 57, `Ep.N` 3, `EpN` 2. Spec §5.3's "~1,500" holds.

**Spec §5.3's rule is already in place.** `Canon/README.md:44-46` carries the heading "## Episode ids in prose (added 2026-09-29, from the console rewrite spec §5.3)" and the rule verbatim: "**`epNN` in prose always means Season 1, episode NN; new writing uses `SxEy` in prose and a production id only inside a file path.**" **Plan D's F-20 is therefore paid and is not Plan F's work.**

---

## 2 · What the engine and scripts assume about ids after the rename

**Conclusion: the engine already accepts both shapes and needs no change to read `s01eNN`; what the rename breaks is three Python programs and three prompt files, all of which the records already schedule for retirement or edit.** Spec §5.4 (`docs/specs/2026-09-25-console-rewrite-design.md:146`) sequences the rename after "teach the engine `sXXeYY`", and `docs/plans/2026-09-29-plan-d-inventory.md:549` recorded that first item as already done. The measurements below confirm it and name the three programs.

### 2.1 Every reader of `airMap` / `season_of`, and what each does for three kinds of id

`engine/src/ids.ts:12-13` is the grammar: `AIRED = /^s(\d{2})e(\d{2})$/`, `PRODUCTION = /^ep(\d{2})$/`. `scripts/lib/showconfig.py:74-75` mirrors it exactly. **These two regexes are the only id encodings in the engine repository** (verified by grep over `scripts/`, `engine/src/` and `console/`), and neither changes: `ep98` and `ep99` keep the production shape.

`engine/src/show-config.ts:124-130`'s `seasonOf` reads the season off an aired id and consults the map only for a production id. `engine/src/show-config.ts:74-79` **refuses** an aired id as an `airMap` key, so a second answer can never exist. `scripts/lib/showconfig.py:215-260`'s `season_of` is the same, and distinguishes `UnmappedEpisodeId` (a well-formed production id the map does not place — absorbable) from a plain `ShowConfigError` (a malformed id — fatal).

| Reader | `s01e01` (aired) | `ep01` (mapped today, unmapped after) | `ep98` / `ep99` (never mapped) |
|---|---|---|---|
| `engine/src/show-config.ts:124` `seasonOf` | returns `1` off the id | today `1` from the map; after emptying, throws `ShowConfigError` | throws `ShowConfigError` |
| `engine/src/show-config.ts:155-160` `mixFilename` | `DeadLight S01E01.wav` | today the same; after emptying, `episode.wav` (`UNMAPPED_MIX`, `:152`) | `episode.wav` |
| `engine/src/agent-step.ts:160` — renders `{{season}}` | `1` | today `1`; after emptying, the `seasonOf` throw propagates | the throw propagates |
| `engine/src/pipelines/episode.ts:76` — chooses the season document for `canonSpine` | `Canon/season-1.md` added | today added; after emptying, **absorbed** (`try { … } catch { season = undefined; }`) and the season document is simply absent from the spine | absorbed; no season document in the spine |
| `scripts/audio-mix.py:14-31` `mix_wav` | `DeadLight S01E01.wav` | today the same; after emptying, `episode.wav` (`UNMAPPED_MIX`, `:12`) | `episode.wav` |
| `scripts/build-timeline.py:53-63` `mix_wav` | `DeadLight S01E01.wav` | same as above | `"episode.wav"` (`:60`) |
| `scripts/publish-kit.py:106-107` | `S01E01` in the title line | today the same; after emptying, **exits** — there is no `except UnmappedEpisodeId`, so the error reaches `:210`'s handler and the script dies | exits |
| `scripts/finalize-video.py:108-120` `resolve_slot` | `(1, 1)` off the id; the season-document fallback is never reached | today `(1, 1)` from the map; after emptying, falls through to `season_slot` | falls through to `season_slot` → `None` → `:129` exits |
| `scripts/season-status.py:47-70` `air_map_for_season` / `prod_id_for` | not consulted — the board is keyed on the air ordinal | after emptying, `prod_id_for(1, {})` returns the literal `"ep01"`, a directory that no longer exists | `ep98`/`ep99` never appear on the board |

**The two consequences that matter.** First, **every path that names an output works on an aired id with an empty `airMap`** — the mixes, the finals, the publish kit and the prompt's `{{season}}` all resolve off `s01eNN` alone. Second, **`scripts/season-status.py` does not fail when the map empties; it silently reports a wrong board** (F-11).

### 2.2 `scripts/finalize-video.py`'s season-document fallback, and the two RULED-row parsers

**Two parsers share one grammar.** `scripts/finalize-video.py:38`:

    RULED_ROW = re.compile(r'^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^|]*\*\*\s*\|', re.M)

`scripts/season-status.py:39` is the same pattern with a trailing capture for the title cell: `r'^\|\s*(\d+)\s*\|\s*\*\*RULED\b[^|]*\*\*\s*\|(.*)$'`. Both accept a status cell carrying its own ruling history — `**RULED — REWRITTEN 2026-08-27**` is E10's — and both require the bold markers. `scripts/finalize-video.py:37` already says so: "Not config: Plan F retires this parse entirely when ids carry their own season."

**The `**RULED-OUT**` form O-11 names does not appear in either season document** (`grep -c RULED-OUT` returns 0 for both `Canon/season-1.md` and `Canon/season-2.md`).

**The fallback is already ambiguous for three ids today, and only the `airMap` is hiding it.** `scripts/finalize-video.py:70-105`'s `season_slot` matches an `epNN` id against a RULED row whose *default* production id is `ep{air:02d}`, across every `Canon/season-N.md`. Run against the show's real `Canon/` on 2026-10-02:

| Episode | `season_slot(ep, Canon)` |
|---|---|
| `ep01` | **refuses** — "ep01 matches RULED-row defaults in more than one season document (S01E01 (season-1.md), S02E01 (season-2.md))" |
| `ep02` | **refuses** — S01E02 and S02E02 |
| `ep03` | **refuses** — S01E03 and S02E03 |
| `ep04` | `(1, 4)` |
| `ep10` | `(1, 10)` |
| `ep98`, `ep99` | `None` |

`Canon/season-2.md` gained three `**RULED**` rows at air 1, 2 and 3, which is exactly the cross-document collision `scripts/finalize-video.py:79-82` was written to refuse. **The fallback is reachable only for an id the map does not place, and after the rename no Season 1 id is an `epNN` id at all** — so for `s01e01`..`s01e10` the fallback is unreachable, and for `ep98`/`ep99` it returns `None` and `scripts/finalize-video.py:129` exits with a clear message. **What retires is `RULED_ROW`, `_season_docs` (`:59-67`), `season_slot` (`:70-105`), the `except sc.UnmappedEpisodeId` branch of `resolve_slot` (`:117-120`), the `canon_dir` argument threaded through `finalize` and `main` (`:123`, `:166`), and the five tests in `scripts/tests/test_finalize_video.py` that exercise them.**

### 2.3 `scripts/status.py` and `scripts/season-status.py` — who reads them after console v1 is gone

**`scripts/season-status.py` (275 lines) has no caller anywhere except its own test suite.** A grep across `engine/`, `console/`, `scripts/` and `README.md` finds only its own docstring, its own `sys.exit` handler, and 29 `load_script("season-status.py")` calls in `scripts/tests/test_season_status.py` (478 lines). The engine's pipeline does not run it; the engine's console does not shell it. **Its only reader ever was console v1's season strip and the Archon season-desk workflow, both of which leave at cutover.** So `scripts/season-status.py` plus `test_season_status.py` is **753 lines with no reader after Plan F**, and the RULED-row grammar O-11 retires lives in it.

**`scripts/status.py` (56 lines) has exactly two callers:** `engine/src/pipelines/episode.ts:106`, the `stamp` helper, and `scripts/tests/test_status.py` (74 lines). Retiring the six stamp steps leaves it with no production caller.

**A third program is in the same position and no deferred record names it.** `scripts/check_layout.py` (59 lines, with `scripts/tests/test_check_layout.py` at 55 lines) has **no caller at all** — not in `engine/src/`, not in the engine's `console/`, not in `README.md`. It also carries two assumptions the rename and the stamp retirement both break: `:40` globs `glob.glob(os.path.join(episodes_dir, "ep*"))`, an `ep*` literal that after the rename matches only `ep98`; and `:21-22` reports `STATUS.md missing` as an issue, which becomes true for every episode once the stamps retire. See F-17.

**`README.md:540` states "twenty-six Python programs"** and `ls scripts/*.py` counts 26, so retiring three of them changes that sentence.

### 2.4 The pipeline's six stamp steps, `STATUS.md`, and the walk test

**`engine/src/pipelines/episode.ts:105-106` is the helper:**

    const stamp = (id: StepId, dependsOn: StepId[], milestone: string, detail: string): ScriptStep =>
      ({ kind: "script", id, dependsOn, argv: py("status.py", milestone, detail), outputs: [status], timeoutMs: 15_000 });

with `const status = \`${ep}/STATUS.md\`` at `:88`, where `ep = \`${episodesDir}/${episodeId}\`` (`:65`). **The six call sites:**

| Step id | Address | Depends on | Milestone and detail |
|---|---|---|---|
| `stamp-outline` | `engine/src/pipelines/episode.ts:195` | `outline-gate` | `outline` · "approved at outline-gate" |
| `stamp-script` | `engine/src/pipelines/episode.ts:232` | `script-gate` | `script` · "panel passed, showrunner approved" |
| `stamp-casting` | `engine/src/pipelines/episode.ts:258` | `casting-gate` | `casting` · "guest voices approved" |
| `stamp-audio` | `engine/src/pipelines/episode.ts:269` | `audio-gate` | `audio` · "mix approved (-14 LUFS)" |
| `stamp-images` | `engine/src/pipelines/episode.ts:324` | `image-sheet-final` | `images` · "assets approved" |
| `stamp-finalized` | `engine/src/pipelines/episode.ts:356` | `finalize` | `finalized` · "pushed to NAS" |

**`STATUS.md` also appears in one commit step's paths:** `engine/src/pipelines/episode.ts:362-363`, `commit("assemble-commit", ["stamp-finalized", "publish-kit"], …, [publishJson, prompts, \`${prod}/publish\`, status, runsDir])`. Retiring the stamps removes `status` from that list and removes `stamp-finalized` from `assemble-commit`'s `dependsOn`, which `engine/test/episode-pipeline.test.ts:41` asserts verbatim: `expect(by.get("assemble-commit")?.dependsOn).toEqual(["stamp-finalized", "publish-kit"])`.

**The walk test's assertions on `STATUS.md`.** `engine/test/episode-pipeline.test.ts:268` is the last line of the full-pipeline walk:

    expect(await readFile(path.join(root, "Episodes/s02e01/STATUS.md"), "utf8")).toContain("stamp-finalized");

Two other assertions in the same file go with the stamps: `:53-54` finds `stamp-outline` and asserts its exact argv array, and `:41` is the `assemble-commit` dependency above. **In the engine's console suite, four more assertions name a stamp step by id** — `console/test/app.test.ts:299`, `:307`, `:327`, `:337` (the `step_reset` and reset-response tests) and `console/test/episodes.test.ts:38`, `:77` (board rows seeded from `stamp-outline` and `stamp-audio` events) — all of which use `stamp-*` only as a convenient step id and can name any other step.

**`engine/test/ep98-exercise.test.ts:169` restores the file from git** when the env-gated real-script exercise finishes: `await exec("git", ["checkout", "--", \`Episodes/${EP}/STATUS.md\`], { cwd: showRoot })`. **`README.md:757-759` documents that behaviour in prose** — "it deletes the two run logs it wrote and restores `Episodes/ep98/STATUS.md` from git when it is done, so `git status` in the show repository is the same before and after" — so retiring the stamps edits that paragraph as well as the test.

**`README.md` sections that describe the retiring machinery:** `:324` ("A step's status is derived from the log, never stamped by hand"), `:540-542` (the scripts section's "twenty-six Python programs"), `:567-576` (the `sc.season_of` / `UnmappedEpisodeId` contract, which survives for `ep98`), `:757-763` (the ep98 exercise), `:467-491` (the console section, which already documents the archive marker at `:480-483`).

### 2.5 The `previous-episode` guard and the season boundary

`engine/src/pipelines/episode.ts:142-159`. Line `:148`:

    if (id.kind !== "aired" || id.episode === 1) return { pass: true, message: "no previous episode to wait for" };

**So `s02e01` passes unconditionally and never looks for `s01e10`** — O-15 confirmed at its address. Line `:151` is the archive rule: `if (!(await isDir(dir))) return { pass: true, message: \`${prev} has no run logs (archive)\` }`, where `dir` is `Production/<prev>/runs`. **That rule stays correct after the rename:** `Production/s01e01` … `Production/s01e10` will each contain no `runs/` directory (no Season 1 episode ever ran under the engine), so `s01e02`'s guard would pass with "s01e01 has no run logs (archive)" if anyone ever launched a Season 1 episode. O-14's claim holds.

### 2.6 What reads `Episodes/<id>/`, and what reads `Production/<id>/`

**`engine/src/needs.ts` (152 lines) reads four paths under an episode id:** `:62` `path.join(showRoot, d.episodes, episodeId, "outline.md")`, `:145` `path.join(showRoot, d.episodes, episodeId, "premise.md")`, `:77` `path.join(showRoot, d.production, episodeId, "guest-refs")`, `:129-130` `path.join(showRoot, d.production, episodeId, "images")` and its `prompts.json`, and `:137` each shot's `<shot-id>.png` beneath it. `:45` takes `episodes` from `show.episodesDir ?? "Episodes"`. All four are built from the id, so all four follow the rename with no edit.

**No `premise.md` exists anywhere in the show today.** `git ls-files '*premise*'` returns six files, all named `launch-premise.md` (`Episodes/ep05`–`ep10`) — console v1's name, not the engine's. So `episodeNeeds` reports `ideaMissing: true` for every Season 1 episode, and `deriveStage` (`engine/src/stages.ts:57`, the `ideaMissing → NEEDS_IDEA` rule) would put all ten at `NEEDS_IDEA`. **That is precisely what the archive markers exist to prevent**, and `console/server/episodes.ts:112-131`'s `idleEpisodeRow` is where they do it: an episode with no run logs and a valid marker is shown at the marker's stage with `status: "archived"`, the marker's note, and `needs` emptied (`:127-129`).

**`engine/src/episodes.ts:10-21`'s `listEpisodeIds` is the Board's row list:** the union of directory names under `episodesDir` and `productionDir` that `isEpisodeId` accepts, sorted by `compareEpisodeIds`. `_TEMPLATE`, `_retired`, `_archive`, `voice-refs` and `casting-samples` all fall out. **After the rename it returns twelve ids: `s01e01`…`s01e10` first (aired sorts before production, `engine/src/ids.ts:55`), then `ep98`, then `ep99`.**

### 2.7 `ep98` and `ep99`

**What the spec says they are.** Spec §5.1 (`docs/specs/2026-09-25-console-rewrite-design.md:138`): "After the rename below, only two directories carry the second shape: `ep98` (the non-canon test-bed) and `ep99` (the retired proof-of-concept), both of which were used to flesh out console v1.0 and never had an air slot."

**What exists on disk.** `Episodes/ep98` holds `outline.md`, `script.md`, `STATUS.md` (3 tracked files, no `archive.json`, no `premise.md`). `Production/ep98` holds 2 tracked files (`images/prompts.json`, `tts-script.json`) and 563 on disk, 1.6 GB. `Production/ep99` holds 1 tracked file (`tts-script.json`), 3 on disk, 98 MB, plus an `audio-spike/` directory. `Episodes/ep99` does not exist; its narrative files are at `Episodes/_retired/ep99/` (`outline.md`, `script.md`, `RETIRED.md`), which `listEpisodeIds` does not reach because it scans only one level.

**What the Board shows for each after the rename.** Both are discovered (`ep98` from both directories, `ep99` from `Production` alone). Neither has run logs, so both take the `idleEpisodeRow` path. Neither has an `archive.json`, so `readArchiveMarker` returns `undefined` and the row keeps its derived values: `stage` from `deriveStage(deriveRunState([]), EPISODE_STAGE_MAP, flags)` with `ideaMissing: true` → **`NEEDS_IDEA`**, `status: "none"`, and `needs` listing the missing premise. `console/src/pages/Board.tsx:186-190` offers a launch button, because the no-launch branch keys on `row.status === "archived"`. **So the Board after the rename shows ten archived Season 1 rows and two live-looking `NEEDS_IDEA` rows inviting a launch.**

**Neither id is in `airMap` today**, so emptying the map changes nothing for them. `mixFilename(cfg, "ep98")` returns `episode.wav`, verified.

**`ep98` cannot simply be deleted.** `engine/test/ep98-exercise.test.ts:31` pins `const EP = "ep98"`, and that file is the engine's only test that runs the real Python steps against a real show repository — `audio-mix`, `build-timeline`, `render` and `master`, gated on `SHOWRUNNER_EP98=1` and `SHOWRUNNER_SHOW_ROOT`, documented at `README.md:744-763`. It depends on `Production/ep98/` holding a real `tts-script.json`, real trimmed segments and real stills.

**One historical hazard worth recording.** `Episodes/ep98/STATUS.md:3` reads `- 2026-07-12 finalized: NAS DeadLight S01E09.mp4 (reprocess pending)` — the ep98 test bed was once finalized into ep09's air slot. `Canon/season-1.md:31` records the ruling that closed it: "**The old ep98 production is DEAD** — a non-canon pipeline test-bed; its script is not a source for this episode. Write E9 fresh." With no `airMap` entry and no RULED row at air 98, `season_slot("ep98")` returns `None` today, so `scripts/finalize-video.py` would refuse rather than repeat the collision.

**The three options O-18 names.** A marker with a stage and a note (the same mechanism as Season 1, at whatever stage is honest for a test bed); a `retired` flag the Board reads as a fourth status; or deletion of the directories. **The measurement that bears on the choice: `ep98`'s directories are load-bearing for the engine's only real-script exercise, and `ep99`'s are 98 MB of spike with one tracked manifest.** See F-10.

---

## 3 · What leaves the show repository

**Conclusion: four trees and 24,000 lines of TypeScript, 7,200 lines of Python and YAML, 612 MB of `node_modules` and 2.3 GB of ignored render staging leave the show, and exactly one sentence of the show's `README.md` and three sentences of `docs/console-redesign-brief.md` describe them as present.** Spec §7.4 (`docs/specs/2026-09-25-console-rewrite-design.md:212`) names the four; spec §7.5 (`:218`) says they go at cutover and "Until cutover, nothing in `DeadLight` is removed."

### 3.1 `console/` — console v1

**91 tracked files; 93 files on disk excluding `node_modules` and `dist`.** 21,643 lines of `.ts`/`.tsx` across 84 files — **11,770 production** across 49 files, **9,873 test** across 35 `*.test.ts` files — plus **2,233 lines of CSS** (`console/src/theme.css`, `console/src/console.css`), `console/package.json`, `console/package-lock.json` (3,218 lines), `console/index.html`, `console/README.md`, `console/vite.config.ts`. On disk but ignored: `console/node_modules` (107 MB) and `console/dist` (268 KB).

**The ten `epNN` encodings the Plan E inventory listed (O-20), verified at their addresses in the show today:**

| Address | Line |
|---|---|
| `console/server/repo.ts:47` | `const EPISODE_DIR_RE = /^ep\d+$/;` |
| `console/server/discuss.ts:23` | `const PROD_RE = /^ep\d+$/;` |
| `console/server/sse.ts:107` | `const EPISODES_MD_RE = /^Episodes\/ep\d+\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;` |
| `console/server/gates.ts:107` | `const DOC_PATH_RE = /\bEpisodes\/(ep\d+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)\b/gi;` |
| `console/server/manifest.ts:17` | `const PROD_RE = /^ep\d+$/;` |
| `console/server/deskzone.ts:84` | `const PROD_RE = /^ep\d+$/;` |
| `console/server/index.ts:81` | `const PROD_RE = /^ep\d+$/;` |
| `console/src/components/LaunchCard.tsx:274` | `const EP_ID_RE = /^ep\d+$/;` |
| `console/src/pages/GateRoom.tsx:27` | `const EP_ID_RE = /\bep\d+\b/gi;` |
| `console/server/repo.ts:78` | ``return airMap.get(air) ?? `ep${String(air).padStart(2, "0")}`;`` |
| `console/server/repo.ts:46` | `const SEASON_MAP_ENTRY_RE = /"(ep\d+)":\s*\((\d+),\s*(\d+)\)/g;` |

**Not one of them matches `s01e01`.** The air map read O-10 names is `console/server/repo.ts:110`, `path.join(root, ".archon/scripts/finalize-video.py")` — v1 regex-parses a Python source file for its data, so it also loses its air map the moment `.archon/` goes.

### 3.2 `.archon/` — the Archon pipeline

**35 tracked files.** Five workflow YAMLs totalling **2,167 lines** (`deadlight-write-episode.yaml` 912, `deadlight-produce-assets.yaml` 687, `deadlight-season-review.yaml` 297, `deadlight-canon-update.yaml` 155, `deadlight-assemble-episode.yaml` 116), `.archon/config.yaml`, and 29 Python files totalling **5,000 lines** under `.archon/scripts/` — 21 programs and **8 copied `test_*.py` files** (`test_check_layout.py`, `test_finalize_video.py`, `test_nano_banana_generate.py`, `test_registry_append.py`, `test_season_review_workflow.py`, `test_season_status.py`, `test_status.py`, `test_truncation_qc.py`).

**O-12 is paid: the eight copies are the show's, and the engine's `scripts/tests/` (25 files) is the suite.** Nothing remains to move; the eight leave with `.archon/`. **Spec §7.4 (`:212`) rules `.archon/workflows/` deleted rather than moved**, because it is the source `tools/src/extract-prompts.ts` extracted the prompts from.

### 3.3 `remotion/` — the render project's predecessor

**6 tracked files:** `remotion/src/Episode.tsx`, `remotion/src/Root.tsx`, `remotion/src/index.ts` (186 lines together), `remotion/package.json`, `remotion/package-lock.json`, `remotion/tsconfig.json`. On disk and ignored: `remotion/node_modules` (505 MB) and **`remotion/public/` (2.3 GB), which holds twelve staging directories named `ep01`–`ep10`, `ep98`, `ep99`** — real directories, not symlinks. The engine's `render/` has replaced it; `scripts/build-timeline.py:48-50` stages into `<engineRoot>/render/public` and the engine's `README.md:690-699` documents `render/` as carrying no show literal.

### 3.4 The root `package.json`

**7 lines, and there is no root lockfile and no root `node_modules`** in the show repository:

    {
      "name": "deadlight",
      "private": true,
      "scripts": {
        "console": "npm --prefix console run dev",
        "console:serve": "npm --prefix console run serve"
      }
    }

Both scripts point into `console/`, so the file has no residue once `console/` goes. The only lockfiles in the show are `console/package-lock.json` and `remotion/package-lock.json`, each of which leaves with its own tree.

### 3.5 What references the four, quoted

**The show's `README.md` (49 lines) has exactly one reference to any of the four**, and two more sentences the rename touches:

| Address | Text |
|---|---|
| `README.md:26` | `- \`/.archon\` — Archon pipeline: workflow definitions, scripts, model config` |
| `README.md:22` | `- \`/Episodes\` — one folder per episode: \`Episodes/epNN/outline.md\` + \`script.md\` (creative text only)` |
| `README.md:33` | "…the `airMap` that places each production id (`ep01` through `ep10`) in its season and episode slot…" |

`README.md` mentions neither `console/` nor `remotion/` nor the root `package.json` anywhere. `README.md:24` describes `prompts/` as holding "every agent prompt the pipeline runs, one per file, plus `index.json` (see `prompts/README.md`)", which O-19's deletion of `index.json` edits.

**There is no `CLAUDE.md` in the show repository.** `/Users/ryanperkowski/GitHub/DeadLight/CLAUDE.md` does not exist; `.claude/settings.json` holds only `{"enabledPlugins": {"bmb@banyan": true}}`.

**`Canon/README.md` (56 lines) references none of the four.** Its only match on "console" is the heading `## Episode ids in prose (added 2026-09-29, from the console rewrite spec §5.3)` at `:44`.

**`docs/` has 349 references across 21 files, of which exactly one file is live rather than a historical record.** `docs/console-redesign-brief.md` (211 lines) is a design brief handed to an outside designer and it describes all three trees as present:

| Address | Text |
|---|---|
| `docs/console-redesign-brief.md:5-6` | "…through Archon workflow automation. The console (`console/` — Hono server + Vite/React, no database, LAN-only) is where he launches pipeline stages…" |
| `docs/console-redesign-brief.md:17-18` | "(`.archon/workflows/*.yaml` is the source of truth for pipeline behavior; `console/server/index.ts` for what data is served)." |

The other 20 files are under `docs/superpowers/plans/` and `docs/superpowers/specs/`, dated 2026-07-09 through 2026-07-31, and are the historical record of building the Archon pipeline and console v1. The heaviest are `docs/superpowers/plans/2026-07-31-console-operating-layer.md` (85), `…/2026-07-23-archon-getwell-phase0-1.md` (43), `…/2026-07-27-nano-banana-generate.md` (34), `…/2026-07-10-pipeline-v2-produce-assets.md` (26), `…/2026-07-23-archon-getwell-phase2-produce-assets.md` (25). **Whether a deleted tree's design record is edited, prefaced, or left alone is a decision, not a substitution** (F-20).

### 3.6 The show's own test files, and what `tools/extract-prompts` loses

**No test file remains in the show outside `console/` and `.archon/`.** `git ls-files | grep -E 'test_|\.test\.'` returns exactly the eight `.archon/scripts/test_*.py` files and console v1's 35 `*.test.ts` files. Both sets leave with their trees.

**`tools/src/extract-prompts.ts` loses its input, not a hardcoded path.** The program takes `--workflows <dir>` in argv (`:456` `USAGE`, `:493`, `:505`, `:510`) and reads the directory with `readdir` (`:214`, `:229`); nothing in it names `.archon`. Its two show-specific inputs live in the engine at `tools/show-data/deadlight-overrides.json` and `tools/show-data/deadlight-check-context.json`, which `README.md:681-688` documents as "the one place under `tools/` that carries a show's name" and which the show-name grep excludes by name. **So after `.archon/workflows/` is deleted the extractor still builds, still passes its tests against `tools/test/fixtures/workflows/harbor-write.yaml`, and simply has no Dead Light workflows left to re-extract from.** Spec §7.4 (`:212`) rules that acceptable: the workflows are deleted, not archived.

**`prompts/index.json` (883 lines) goes with it (O-19).** The only module that mentions it is `tools/src/extract-prompts.ts` (`:105` `const INDEX_FILE = "index.json"`, `:372`, `:420`), which **writes** it; nothing reads it. The show's own `prompts/README.md:9` already records it as frozen: "`index.json` is the record of Plan C's extraction from the Archon workflows (2026-09-28) and is frozen: from Plan D (2026-09-29) the engine's pipeline definition, `engine/src/pipelines/episode.ts` in `~/GitHub/Showrunner`, is the manifest of which prompt file each step reads, and this directory is hand-maintained." **Deleting it edits `prompts/README.md:9-10` and the show's `README.md:24`.**

### 3.7 Four more ignored trees in the show, named so Plan F can rule on them

| Tree | Size | What it is |
|---|---|---|
| `.agent-logs/` | **496 MB**, 27 entries, **15 named with an `epNN`** (e.g. `ep10-assemble-respin-20260916-104557.log`, `assemble-ep09-rebuild-20260904-122458.log`) | Archon and console v1 run logs, git-ignored (`.gitignore:2`). The engine's equivalent is `Production/<id>/runs/<run-id>.jsonl` |
| `remotion/public/` | 2.3 GB | the staging tree §3.3 names |
| `.playwright-mcp/`, `.pytest_cache/`, `.superpowers/` | 164 KB, 32 KB, 3.0 MB | scratch, all git-ignored |
| `Finalized/` | 0 B | an empty directory, git-ignored (`.gitignore:12`) |

---

## 4 · The engine repository's own hygiene

**Conclusion: all five Plan A/B hygiene items still hold at `9347474`, one of them has moved address, and one has changed in a way that matters — `npm audit` now reports seven advisories, not five, and two of them are reachable from shipped code.**

| # | Item | Address today | Still holds? |
|---|---|---|---|
| O-01 | **The version exists three times.** `engine/package.json:3` `"version": "0.0.1"`, `engine/src/version.ts:6` `export const ENGINE_VERSION = "0.0.1"`, `engine/test/smoke.test.ts:6` `expect(ENGINE_VERSION).toBe("0.0.1")`. The test imports the constant from the barrel and compares it to a fourth copy of the literal. | **Address moved.** The deferred record named `engine/src/index.ts`; the constant moved to `engine/src/version.ts` to break an import cycle (`engine/src/version.ts:1-5` records why), and `engine/src/index.ts:1` re-exports it | **Yes** |
| O-02 | **Every `mkdtemp` root is left behind.** **81 `mkdtemp` call sites across 21 test files** — 16 under `engine/test/`, 3 under `console/test/`, 2 under `tools/test/`. No `afterEach` or `afterAll` cleanup exists in any suite; the only `rm` calls are the five in `engine/test/ep98-exercise.test.ts` and one in `console/test/runs.test.ts:96`, all of which delete specific artifacts rather than temp roots | `engine/test/*.test.ts`, `console/test/*.ts`, `tools/test/*.test.ts` | **Yes** |
| O-03 | **Two commits carry their trailers in two paragraphs.** `git log -1 --format='%(trailers)'` on `402e489` ("chore: ignore the SDD workspace") and `2fc5e7f` ("engine: bootstrap workspace, TypeScript, vitest; untrack .DS_Store") each prints only `Claude-Session:` | `402e489`, `2fc5e7f` | **Yes** — and history stands, as the record says |
| O-04 / O-09 | **The barrel re-exports the SDK adapter and there is no `exports` map.** `engine/src/index.ts:15` `export * from "./sdk-query.js";`. `engine/package.json` is `"private": true` with `"main": "./dist/index.js"` and `"types"`, and **no `exports` key** | `engine/src/index.ts:15`, `engine/package.json:6-7` | **Yes.** The pinned SDK is still `0.3.283` (`engine/package.json:19`), so O-09's condition — re-run the import side-effect probe on any bump — has not been triggered |
| O-05 | **The SDK's three peer dependencies are undeclared.** `node_modules/@anthropic-ai/claude-agent-sdk/package.json` declares `peerDependencies` `{"@anthropic-ai/sdk": ">=0.93.0", "@modelcontextprotocol/sdk": "^1.29.0", "zod": "^4.0.0"}` with **no `peerDependenciesMeta`** (so none is optional). None appears in `engine/package.json`. All three are installed at the workspace root by npm's automatic peer install — `zod@4.6.5`, `@modelcontextprotocol/sdk@1.30.1`, `@anthropic-ai/sdk@0.128.0` — and **no source file under `engine/src`, `console/server`, `console/src` or `tools/src` imports any of them** | `engine/package.json:18-20` | **Yes** |
| O-06 | **`npm audit` reports seven advisories, not five, and the severities have moved.** `{"info":0,"low":0,"moderate":5,"high":1,"critical":1,"total":7}`. The five the record describes are still there in the vitest/vite/esbuild chain — and two of them have escalated: `vitest` is now **critical** (GHSA-5xrq-8626-4rwp, UI server arbitrary file read and execute, `<3.2.6`) and `vite` is now **high** (GHSA-fx2h-pf6j-xcff, `server.fs.deny` bypass on Windows, `<=6.4.2`). **The two new ones are `react-router` and `react-router-dom`** (GHSA-wrjc-x8rr-h8h6 open redirect via backslash in `<Link>`/`useNavigate`; GHSA-337j-9hxr-rhxg arbitrary constructor injection via `deserializeErrors()`), both moderate, both `>=6.0.0 <7.18.0` | `console/package.json:20` pins `"react-router-dom": "^6.26.0"` | **Changed.** The record's "none reachable from shipped code" **no longer holds**: `react-router-dom` is a `dependencies` entry of the engine's `console/`, i.e. it ships in the client bundle. See F-22 |
| O-07 | **`devDependencies` key order** normalized by npm — noise, confirmed as noise | `engine/package.json:13-17` | **Yes, and immaterial** |

---

## 5 · Findings

Each finding names what was measured and the question Plan F's author must answer.

| # | Finding | Question for Plan F |
|---|---|---|
| **F-01** | **The rename can be one commit including the 13.20 GB of ignored data, because `git mv` on a directory moves ignored and untracked content.** Measured in a scratch repository on 2026-10-02: `git mv ep01 s01e01` on a directory holding a tracked file, a tracked file in a subdirectory, an ignored file under an ignored subdirectory, and an untracked file left `ep01` gone, all four files under `s01e01`, and `git status` reporting two `R` renames plus one `??`. **Twenty `git mv` calls move all 6,565 files in the 20 directories.** | Does Plan F still want a separate filesystem step for the ignored data? The measurement says no — and a split would make spec §5.2's "one commit" a half-truth, because the `git mv` would have *already* moved the data. **State the mechanism explicitly in the plan so nobody adds a redundant `mv`.** |
| **F-02** | **`git mv` plus a content edit in the same commit preserves history for every one of the 45 move-and-edit files.** Measured: a file renamed and edited in one commit reported `R099` in `git diff -M --name-status`, `git show --stat --find-renames` printed `Episodes/{ep03 => s01e03}/outline.md`, and `git log --follow` traversed the rename to both earlier commits. The worst real case is 8.5% of lines touched (`Production/ep10/images/SHOTS-TO-MAKE.md`, 17 of 201), far above git's 50% similarity floor. | None — this is a closed question, recorded so Plan F does not split the rename and the edits into two commits to "protect history". **It needs no protection.** |
| **F-03** | **The order of operations across the two repositories is already half-satisfied, and only one engine change must follow the rename rather than precede it.** `engine/src/ids.ts:12-13` accepts both shapes; `engine/src/show-config.ts:124-130`'s `seasonOf` reads an aired id off the id; `engine/src/show-config.ts:74-79` refuses an aired `airMap` key. So the engine reads `s01eNN` today. **Emptying `airMap` is the one step that must come after the show's rename**, because `scripts/publish-kit.py:106` exits on an unmapped `epNN` and `scripts/finalize-video.py:129` refuses one. | Does Plan F empty `airMap` in the show's rename commit, or in a follow-up? Both loaders accept `{}` (verified, §1.5), and no aired-id path consults the map — so the same commit is safe. **Name the choice and the reason.** |
| **F-04** | **The rename ends console v1, and no transition window survives it.** O-21 records Ryan's ruling that v1 (4400/5183) and the engine's console (4410/5193) run side by side during the transition. **But all eleven of v1's id encodings are `/^ep\d+$/`-shaped (§3.1), so `s01e01` matches none of them**, and v1's air map is a regex read of `.archon/scripts/finalize-video.py` (`console/server/repo.ts:110`), which disappears with `.archon/`. **The moment Season 1 is renamed, v1 shows an empty season and an empty board, whether or not it is still installed.** | State this plainly in the plan: **the side-by-side window closes at the rename, not at v1's deletion**, so v1 must be deleted in or before the rename commit rather than left running. If Ryan wants a read-only v1 against the old shape, the only mechanism is a git tag or branch of the show at `6b157b8`. |
| **F-05** | **No script validates a manifest's `"episode"` field against its directory, and the field is already wrong for ep01.** `scripts/tts-generate.py:133` is the only site that touches it, and it writes it. `scripts/validate-manifest.py` never mentions it. `engine/src/needs.ts:130` reads `prompts.json`'s `shots` and nothing else. **`Production/ep01/tts-script.json` and `Production/ep01/audio/manifest.json` both say `"episode": "ep01-v2"` while the directory is `ep01`, and nothing has ever noticed.** | Does Plan F edit the 21 tracked + 13 ignored manifests' `"episode"` values, or leave them as a dead field? **The measurement says leaving them costs nothing and editing them buys nothing except grep-cleanliness** — but spec §5.2 counted them as in scope. Rule it. |
| **F-06** | **`Canon/season-1.md`'s RULED rows are keyed by air ordinal, not by production id, so the rename does not touch the table's keys.** `Canon/season-1.md:23-32` begins each row `\| 1 \| **RULED** \|` … `\| 10 \| **RULED — REWRITTEN 2026-08-27** \|`. `scripts/season-status.py:39-44` and `scripts/finalize-video.py:38` both capture that first cell as `air`. What the rename touches is the 12 `epNN/` file paths quoted *inside* row text. | Nothing to decide about the keys. **The decision is whether the RULED-row grammar's retirement (O-11) also means deleting `parse_season_table` and its 29 tests, or keeping `scripts/season-status.py` as an operator tool.** See F-11. |
| **F-07** | **The 151 casting-pile stills need not be renamed: `scripts/nano-banana-generate.py` selects by `os.path.getmtime`, never by name.** `scripts/nano-banana-generate.py:67-72`'s `_pile_stills` lists the folder, excludes the sheet, and sorts by mtime descending, taking `STILLS_PER_SUBJECT = 2`. A `git mv` is a `rename(2)` and preserves mtime, so the selection is identical whether the files are renamed or not. `scripts/registry-append.py:90` names a *new* still `f"{ep}-{s['id']}.png"`, which is `s02e01-<shot-id>.png` for Season 2 with no code change. | Rename the 151 for legibility, or leave them? **Correctness is unaffected either way.** If renamed, it is 151 more `git mv` calls in the same commit; if not, the pile carries two naming eras and `Canon/characters/Opha/` reads `ep04-…png` beside `s02e01-…png`. Ryan's call. |
| **F-08** | **Three prompt files name `Episodes/ep01/…` as an exemplar, and after the rename the first Season 2 run reads four missing files.** `prompts/outline.md:21` ("Read `Episodes/ep01/outline.md` — your output must match its format and"), `prompts/draft.md:6` and `:26` (both naming `Episodes/ep01/script.md`), `prompts/tone-check.md:3` (`Episodes/ep01/script.md`). These are not documentation; they are instructions an agent follows with a `Read` tool call inside the `outline`, `draft` and `tone-check` steps. | **This is the single substitution that must not be missed, and it is not caught by a directory rename.** Does Plan F hardcode `Episodes/s01e01/…`, or replace the exemplar with a template variable so a new show's prompts are not pinned to Dead Light's pilot? Plan G's §9.5 question — "whether the interview can cite Dead Light's files as worked examples" — is the same question one plan early. |
| **F-09** | **The ten archive markers need no content edit, only the move, and the move is free.** None of the ten contains an episode id (§1.7); `console/server/episodes.ts:78` builds the path from `episodeId`, so `Episodes/s01e01/archive.json` is where `git mv` puts it. O-23 is paid by `git mv` alone. | None for Season 1. **The open half is `ep98` and `ep99` (F-10).** |
| **F-10** | **`ep98` and `ep99` have no marker, and after the rename the Board shows them as two live `NEEDS_IDEA` rows with launch buttons offered.** Verified by reading the path: `listEpisodeIds` returns both (`engine/src/episodes.ts:18`); neither has run logs, so both take `idleEpisodeRow`; `readArchiveMarker` returns `undefined`; `deriveStage` with `ideaMissing: true` gives `NEEDS_IDEA` (`engine/src/stages.ts:57`); `console/src/pages/Board.tsx:189` suppresses the launch button only for `status === "archived"`. **`ep98` cannot be deleted: `engine/test/ep98-exercise.test.ts:31` pins it, and that file is the engine's only real-script exercise** (documented at `README.md:744-763`), depending on `Production/ep98/`'s 1.6 GB of real segments and stills. `ep99` is 98 MB with one tracked manifest and its narrative files already retired to `Episodes/_retired/ep99/`. | Three options, with their measured costs. **(a) A marker each** — `ep98` at some honest stage with a note naming it the engine's exercise bed, `ep99` at `COMPLETE` or similar; cost: two files, zero code, and the Board stops offering a launch. **(b) A `retired` flag** — a fourth `status` in `EpisodeRow` and a Board branch; cost: a type, a render branch, tests. **(c) Deletion** — impossible for `ep98` without also deleting the exercise and the README section that documents it; cheap for `ep99`. **The marker is the only option that costs nothing new, and `README.md:480-483` already documents the mechanism.** |
| **F-11** | **`scripts/season-status.py` does not fail when `airMap` empties — it silently reports a wrong board for a finished season.** `scripts/season-status.py:161` calls `air_map_for_season(cfg, season)`, which returns `{}` for an empty map (`:56-57`); `:172` then calls `prod_id_for(air, {})`, which falls back to the literal `f"ep{air:02d}"` (`:70`). After the rename `Episodes/ep01` does not exist, so `:184` takes the `not os.path.isdir(ep_dir)` branch and every row reads `ruled/unstarted` with next action `write-episode`. **Exit code stays 0.** Ten finished episodes would read as never started. | **`scripts/season-status.py` must be deleted at the rename, not merely left unused** — leaving it is leaving a tool that lies. Measured cost of deletion: 275 lines plus `scripts/tests/test_season_status.py` at 478 lines, **753 lines with no reader after console v1 leaves** (verified: 29 `load_script` calls in its own test file and nothing else). Does Plan F delete it, or fix `prod_id_for` to the aired id? |
| **F-12** | **`s02e01` needs nothing before its first run except `Episodes/s02e01/premise.md`.** `engine/src/pipelines/episode.ts:161-167`'s `premise` guard fails with `NEEDS_IDEA: write Episodes/s02e01/premise.md` when the file is absent or blank, and passes with its text as the message. Everything else the write phase reads already exists: `Canon/season-2.md` (3 RULED rows, 17 DRAFT), the eight-file canon spine (`engine/src/pipelines/episode.ts:78-82`), `Episodes/_TEMPLATE/outline.md`, `Canon/refs.json`, `Production/voice-refs/refs.json`. `previous-episode` passes unconditionally for episode 1 (`:148`). **No `premise.md` exists anywhere in the show today** — the six existing files are `launch-premise.md`, console v1's name. | Confirm in the plan that the first Season 2 run is gated on one hand-written file and nothing else. **Does Plan F also rename the six `launch-premise.md` files to `premise.md`, or leave them as console v1 artifacts?** Nothing in the engine reads `launch-premise.md`. |
| **F-13** | **The first real run is last in spec §7.5's sequence, and Ryan has already moved it later than that.** Spec §7.5 (`docs/specs/2026-09-25-console-rewrite-design.md:218`) ends the cutover with "the first Season 2 episode runs on the new engine". `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:41` records Task 10 (concurrent agent steps) as "the first thing to add", measured at 35 min 50 s per sequential review round — **and that is now shipped**: `engine/src/runner.ts:33` takes `concurrency?: number` and `:294-298` batches agent steps. Six items are explicitly deferred to the first real run (`docs/plans/2026-10-02-the-console-deferred.md:28-34` and `…pipeline-deferred.md:42-43`): the SDK child under `SIGTERM`, `scripts/render-video.py` against a full render, the seven-query rate-limit exposure, the 2,000-event feed window, the Board's 4 Hz projection, and `scripts/tts-generate.py` under the engine. | **Does Plan F include the first run, or hand it off?** The measurement that bears on it: nothing in the rename or the deletions depends on a run having happened, and nothing in a run depends on the deletions. **They are separable**, which means Plan F can ship the cutover and leave the run to Ryan's own schedule — possibly after Plan G, as he ruled. State which. |
| **F-14** | **Spec §5.2's completion check will not return zero unless it excludes ten git-ignored files.** "The completion check is a grep for stale `ep0N/` paths returning zero" (`docs/specs/2026-09-25-console-rewrite-design.md:138`). **The ten `Production/epNN/video/timeline.json` files carry 504 of the 947 occurrences** — every `shots[].src` and the `audio` key, e.g. `Production/ep03/video/timeline.json:5` `"audio": "ep03/audio.wav"` — and they are git-ignored by `.gitignore:5` (`Production/*/video/`). They are regenerated from scratch by `scripts/build-timeline.py` and no Season 1 episode will be rebuilt. | **Write the completion grep with its exclusions in the plan, verbatim**, so a zero result means what it claims. The grep in §1.3 of this document plus `--exclude-dir=video` returns the 443 tracked occurrences and nothing else. |
| **F-15** | **Two `Production/_archive/` directories carry `ep01` in their names and `"episode"` values, and spec §5.2 does not cover them.** `Production/_archive/ep01-v2/tts-script.json` (6 `epNN/` references, `"episode": "ep01-v2"`) and `Production/_archive/ep01-coldopen-v2/tts-script.json` (3 references, `"episode": "ep01-coldopen-v2"`). Neither parses as an episode id, so `listEpisodeIds` never sees them and nothing in the engine reads them. | Rename them to `s01e01-v2` and `s01e01-coldopen-v2`, or leave them? **No code is affected either way.** Plan F should say which, so the completion grep's expected count is known in advance. |
| **F-16** | **The spec's measured scope of "52 canon and documentation files" is not reproducible today; the measurement is 83 tracked files and 443 occurrences.** Spec §5.2's figure was measured 2026-09-25; the show has since taken Plan C's `showrunner.json`, Plan D's show data, and the archive-marker PR. No single filter reproduces 52: all `.md` gives 74, `.md` outside `docs/` gives 57, `.md` outside `docs/` and `Production/` gives 33. | **Plan F must re-measure rather than carry 52 forward**, and should record the exact grep it used so the next plan can reproduce it. The grep and the per-file counts in §1.3 of this document are that record. |
| **F-17** | **A third Python program retires with the stamps and no deferred record names it.** `scripts/check_layout.py` (59 lines, plus `scripts/tests/test_check_layout.py` at 55) has **no caller anywhere** in `engine/src/`, the engine's `console/`, or `README.md`. It also carries two assumptions the cutover breaks: `:40` globs `glob.glob(os.path.join(episodes_dir, "ep*"))`, which after the rename matches only `ep98`; and `:21-22` reports `STATUS.md missing` as an issue, which becomes true for every episode once the six stamp steps retire. | Delete it with `scripts/status.py` and `scripts/season-status.py`, or fix its glob? **`README.md:540` says "twenty-six Python programs"; retiring three makes it twenty-three** and that sentence changes either way. |
| **F-18** | **`.agent-logs/` is 496 MB of console-v1 and Archon run logs, 15 of whose 27 entries carry an `epNN` in the filename.** Git-ignored (`.gitignore:2`). The engine's equivalent is `Production/<id>/runs/<run-id>.jsonl` (`engine/src/events.ts:24-28`), which lives inside the renamed directories and moves with them. | Does `.agent-logs/` leave with console v1, stay as a record, or get renamed? **It is the only remaining tree whose epNN-bearing names are a historical record of the Archon era rather than a path anything resolves.** The 496 MB is the argument for deletion; the ep09 and ep10 failure logs are the argument against. |
| **F-19** | **`remotion/public/` is 2.3 GB of per-episode staging in twelve real directories named `ep01`–`ep10`, `ep98`, `ep99`**, git-ignored by `.gitignore:8`. The engine's replacement is `render/public/<episodeId>/`, which `scripts/build-timeline.py:48-50` fills and which `engine/test/ep98-exercise.test.ts:174` deletes after the exercise so no show name stays inside the engine checkout. | Deleted outright with `remotion/`, or is any of the 2.3 GB a source rather than a copy? **The staged stills and mix are copies of `Production/<id>/images/*.png` and `Production/<id>/audio/*.wav`, so nothing is lost** — Plan F should confirm that before deleting and say so. |
| **F-20** | **One live design brief in the show describes `console/` and `.archon/workflows/` as the ground truth of a system that will not exist.** `docs/console-redesign-brief.md:5-6` and `:17-18`, quoted in §3.5. The other 20 `docs/superpowers/` files that reference the three trees are dated 2026-07-09 to 2026-07-31 and are the historical record of building them. | Edit, preface, or delete `docs/console-redesign-brief.md`? **It is a brief addressed to an outside designer and it will mislead one.** The historical records under `docs/superpowers/` need no edit — but the plan should say so out loud rather than leave 349 references unmentioned. |
| **F-21** | **The hardcoded `"Production"` the record names is one of nineteen, not one.** O-17 names `engine/src/events.ts:24`, whose `logPath` takes `productionDir = "Production"` as a default parameter — benign. **Eighteen Python scripts hardcode the literal string `Production/` in an f-string rather than reading `productionDir` from config:** `scripts/breath-qc.py:113`, `scripts/build-timeline.py:104`, `scripts/audio-mix.py:54`, `scripts/canon-diff.py:67`, `scripts/image-generate.py:75`, `scripts/finalize-video.py:52`, `:55`, `:135-136`, `scripts/image-qc.py:60`, `:62`, `scripts/master-video.py:73`, `scripts/image-sheet.py:73`, `:102`, `scripts/nano-banana-generate.py:430`, `scripts/publish-kit.py:103`, `:104`, `:108`, `:189`, `scripts/pace-qc.py:51`, `scripts/populator-check.py:71`, `scripts/registry-append.py:122`, `scripts/shot-sheet.py:47`, `:160`, `scripts/tts-generate.py:77`, `scripts/validate-manifest.py:75`, `scripts/truncation-qc.py:155`. It is invisible for Dead Light, whose `showrunner.json:7` says `"productionDir": "Production"`, and it carries no show name so `README.md:768`'s grep does not catch it. | **Is this Plan F's or Plan G's?** It is not a rename item and nothing breaks today. The cost of deferring is that the first show whose `productionDir` is not `"Production"` fails in eighteen places at once — which is Plan G's first user, Ryan, on his own second show. |
| **F-22** | **`npm audit` is seven advisories, not five, and two of them ship in the client bundle.** `{"moderate":5,"high":1,"critical":1,"total":7}`. `vitest` is now **critical** (GHSA-5xrq-8626-4rwp) and `vite` **high** (GHSA-fx2h-pf6j-xcff), both still devDependencies. **The two new ones are `react-router` and `react-router-dom`** — GHSA-wrjc-x8rr-h8h6 (open redirect via backslash in `<Link>`/`useNavigate`) and GHSA-337j-9hxr-rhxg (arbitrary constructor injection via `deserializeErrors()`), both `>=6.0.0 <7.18.0`. `console/package.json:20` pins `"react-router-dom": "^6.26.0"` as a **`dependencies`** entry of the engine's console. **O-06's "none reachable from shipped code" no longer holds.** | The console is LAN-only and single-operator, so neither router advisory is a live exposure — **but the fix is a major-version bump to `react-router-dom@7`, which is a breaking change to the engine console's five routes at `console/src/App.tsx:67-73`.** Does Plan F take it, or record the exposure and the reason for declining? Decide, and record the reason either way, because the next audit will raise it again. |
| **F-23** | **`prompts/audio-gate.gate.md:2` names the mix with an air-named glob, and after the rename it is correct for every id except `ep98`.** The line is `Production/{{episodeId}}/audio/DeadLight *.wav  ({{results.audio-mix}})`. After the rename `{{episodeId}}` is `s01e01`…`s02e01`, and `mixFilename` gives `DeadLight S01E01.wav`, so the glob matches. For `ep98` the mix is `episode.wav` (verified, §1.5) and the glob matches nothing. | O-16 and O-20 both assign this to Plan F. **The one-line fix is to glob the directory rather than the pattern.** Does Plan F take it, or does it depend on F-10's ruling for `ep98` (an archived `ep98` never opens an audio gate, which would close the item for free)? |
| **F-24** | **`engine/test/episode-pipeline.test.ts` is the walk test and it asserts on `STATUS.md` in three places.** `:268` `expect(await readFile(path.join(root, "Episodes/s02e01/STATUS.md"), "utf8")).toContain("stamp-finalized")`; `:41` `expect(by.get("assemble-commit")?.dependsOn).toEqual(["stamp-finalized", "publish-kit"])`; `:53-54` finds `stamp-outline` and asserts its full argv array. Six more assertions in the engine's console suite use a `stamp-*` id as a convenient step name (`console/test/app.test.ts:299`, `:307`, `:327`, `:337`; `console/test/episodes.test.ts:38`, `:77`) and can name any other step. **`engine/test/ep98-exercise.test.ts:169` restores `Episodes/ep98/STATUS.md` from git, and `README.md:757-759` documents that in prose.** | Retiring the six stamps is six deletions in `episode.ts` plus one `commit()` path list, and then **three real test edits, six cosmetic ones, one test-cleanup line, and one README paragraph.** Name them in the plan so the retirement is not scoped as "delete six lines". |

---

## Change log

- **2026-10-02 — created.** The cutover measured against the show at `6b157b8` and the engine at `9347474`. Twenty directories, 185 tracked files inside them, 13.20 GB; 83 tracked files carrying 443 `epNN/` path references and 10 git-ignored files carrying 504 more; 29 tracked manifests with an `"episode"` field; 585 bare prose mentions not swept against 1,594 air-slot mentions already in place; the 23 obligations the five deferred records assign to Plan F; 24 findings. Two measurements contradict the record: `git mv` on a directory carries its ignored content (F-01), and `npm audit` is seven advisories with two reachable from shipped code (F-22). Three Python programs lose their last reader at the cutover rather than two (F-11, F-17).
