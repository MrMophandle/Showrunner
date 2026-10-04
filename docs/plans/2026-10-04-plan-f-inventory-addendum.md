# Plan F inventory addendum — the fresh-instance cutover, measured

**Date:** 2026-10-04 · **Status:** measurement only. Nothing in any repository was changed to produce this document, except this file. No command below wrote to `DeadLight`, `DeadLight2` or the NAS.
**Purpose:** Ryan ruled on 2026-10-04 that the cutover is the **fresh-instance path**, not the in-place rename the Plan F inventory (`docs/plans/2026-10-02-plan-f-inventory.md`, 518 lines, 24 findings) measured. The first show repository is retired as it stands — console v1 keeps running from it until Ryan stops it, and **Plan F renames and deletes nothing inside it** — and Plan F moves into `DeadLight2` what Plan G's `showrunner-init --import` did not carry. This addendum measures what `DeadLight2` holds and lacks, measures each tree the copy would move, measures what the new console shows for Season 1 under each id shape, re-measures the `epNN` reference sweep for a copy rather than a rename, measures the first repository's retirement, and re-states which engine-side obligations survive the change of path. **It proposes no design.**

**The three directories this document cites.**

| Short form in a citation | Directory |
|---|---|
| `engine/src/*.ts`, `engine/test/*.ts`, `console/*` (v2), `scripts/*.py`, `tools/*`, `docs/*`, `README.md` (engine) | the engine — `/Users/ryanperkowski/GitHub/Showrunner`. Working tree on branch `plan-f`; `main` is at `4f4b949` (Plan G merged). Every engine citation below is read with `git show main:<path>` unless it names `plan-f` or `9347474`. |
| `Canon/*`, `Episodes/*`, `Production/*`, `prompts/*`, `showrunner.json`, `.gitignore`, `README.md` (show), `console/*` (v1), `.archon/*`, `remotion/*`, `.agent-logs/*` | the first show — `/Users/ryanperkowski/GitHub/DeadLight`, branch `main` at `25bb3c6`, read-only |
| the same paths, prefixed "DeadLight2" in prose | the fresh instance — `/Users/ryanperkowski/GitHub/DeadLight2`, branch `main` at `c74ec70`, read-only |

**Where a path could belong to either show repository, this document writes "the first repository" or "DeadLight2" explicitly. Where a `console/` path could be either console, it writes "console v1" for the first repository's and "the engine's `console/`" for Plan E's.**

**One tooling note, because it governs every command output below.** `tools/dist/` is git-ignored (`.gitignore:2`, `dist/`) and holds Plan G's build, dated 2026-10-04 09:49 — so `node tools/dist/bible-check.js` and `node tools/dist/check-prompts.js` run Plan G's code from the `plan-f` working tree even though `tools/src/bible-check.ts` and `tools/src/init/` exist only on `main`. Verified: `grep -c 'vars' tools/dist/check-prompts.js` returns 13, and the `vars` feature is on `main` only (`git diff plan-f main -- tools/src/check-prompts.ts`).

**Counts, stated up front.**

| Quantity | Count |
|---|---|
| Commits in DeadLight2 | **17** — `b706239` (`init: Dead Light — the house layout, the prompts, the scaffolds`) through `c74ec70` (`config: the show's own values, carried from the first repository`); fifteen of the seventeen are one-file bible imports |
| Tracked files in DeadLight2 | **82**, 343.32 KB; 1.5 MB on disk excluding `.git`; no untracked and no ignored files; **no git remote** (`git remote -v` prints nothing) |
| `showrunner.json` leaves, first repository / DeadLight2 | **71 / 61**, with **zero differing values** — the only difference is the ten `airMap` entries |
| Canon files imported byte for byte | **15** (`cmp -s` identical): thirteen gated bible files plus `continuity-ledger.md` and `voice-registry.md` |
| Canon root files absent from DeadLight2 | **2** — `Canon/season-2.md`, `Canon/season-desk-report.md` |
| `bible-check --show DeadLight2` | **season 1 passes (exit 0); season 2 fails (exit 1), naming `Canon/season-2.md`** |
| `check-prompts` over DeadLight2's prompts, season 2 | **every prompt renders (exit 0)** |
| `check-prompts` over DeadLight2's prompts with no season (a production id under `airMap: {}`) | **2 fail**: `outline.md` and `canon-review-outline.md`, both `{{season}}: season is not available` |
| Trees measured in §2 | **15** |
| Tracked files in the §2 carry set | **450**, 1,087.98 MB — of the first repository's 799 tracked files (1.12 GB) |
| Git-ignored files inside the §2 carry set | **6,946**, 14.85 GB; plus 2 untracked under `Production/ep10` |
| Of those 6,946 ignored files, how many DeadLight2's `.gitignore` would **not** ignore | **914**, 0.61 GB |
| Of the 450 tracked files, how many DeadLight2's `.gitignore` **would** ignore | **34** — every PNG under `Canon/_candidates/`, by DeadLight2's `.gitignore:7` |
| Prompt files: first repository / DeadLight2 | **51 / 43** tracked. Of the 34 common prompt bodies, **1 is identical** (`casting-gate.gate.md`) and **33 differ**; all 8 schemas are identical; 7 prompts and `prompts/index.json` exist only in the first repository |
| `epNN/` path references in tracked files, first repository, re-measured at `25bb3c6` | **83 files, 444 occurrences** (the inventory measured 83 / 443 at `6b157b8`; Plan G's bible PR added one) |
| — of those, in scope for the copy (a §2 tree, or a file DeadLight2 already holds) | **59 files, 292 occurrences** |
| — **files needing an edit in the copy** | **8 files, 32 occurrences** (§4) |
| — prose the `Canon/README.md:44-46` rule covers | **51 files, 260 occurrences** |
| `epNN/` path references already inside DeadLight2 | **57**, across 5 imported Canon files |
| Findings | **24** (§7) |

---

## 0 · What the 2026-10-04 ruling changes about the inventory

**Conclusion: the ruling voids one of the inventory's twenty-four findings outright, pays three for free, re-scopes four, and leaves sixteen standing.** The inventory's §1 (the rename, 20 directories, 185 tracked files, 13.20 GB) and §3 (what leaves the show repository) describe work Plan F no longer does. Plan G's deferred record names the substitution: "**Whether the cutover is an in-place rename or a fresh instance.** … Plan F's inventory on `plan-f` measures the in-place path, and the fresh-instance path is `init --import ~/GitHub/DeadLight` plus whatever Plan F rules for `Canon/characters/`, the references, the voices, Season 1's archived episodes and the NAS" (`docs/plans/2026-10-03-the-new-show-setup-deferred.md:32`).

**What the fresh-instance path replaces the rename with, in one sentence: twenty directories are not renamed and nothing is deleted — they are copied, under whichever id shape Ryan rules, into a repository that already holds the bible, the prompts and the config, and whose `.gitignore` is ten lines rather than thirty-eight.**

| Inventory finding | Status on the fresh-instance path |
|---|---|
| F-01 (`git mv` carries ignored content), F-02 (rename-plus-edit preserves history) | **Void.** There is no `git mv`. A copy into a different repository starts a new history for every file; `git log --follow` across the two repositories is not available at all, because DeadLight2's history begins at `b706239` and shares no commit with the first repository's 476-commit history rooted at `f73609b` (2026-07-09) |
| F-03 (empty `airMap` after the rename) | **Void.** The first repository keeps its ten entries untouched; DeadLight2's `showrunner.json:14` is already `"airMap": {}` |
| F-04 (the rename ends console v1) | **Void.** Nothing in the first repository changes, so console v1 keeps working from it indefinitely (§5) |
| F-08 (three prompts pin `Episodes/ep01/…`), F-16 (the spec's 52-file scope), F-23 (`audio-gate.gate.md`'s air-named glob) | **Paid by the generic prompt set, if it stays** (§2.15, §6) |
| F-19 (`remotion/public/` is 2.3 GB of copies) | **Void as a deletion question.** `remotion/` stays in the retired repository |
| F-05, F-06, F-07, F-09, F-10, F-11, F-12, F-13, F-14, F-15, F-17, F-18, F-20, F-21, F-22, F-24 | **Standing**, four of them re-scoped (§6) |

---

## 1 · What DeadLight2 holds and lacks

**Conclusion: DeadLight2 is a complete, loadable show with the first show's bible, the first show's twelve configured values, the engine's generic prompt set, and nothing else — no episode, no character sheet, no reference image, no voice WAV, no season-2 document, and no GitHub remote.** `bible-check --season 1` passes; `bible-check --season 2` fails on one file. Every prompt in it renders against a context built from its own config.

### 1.1 The tree

`git -C /Users/ryanperkowski/GitHub/DeadLight2 log --oneline` returns seventeen lines. The first is `b706239 init: Dead Light — the house layout, the prompts, the scaffolds`; the next fifteen are `canon: Canon/<file> — imported` (two of them `— imported from /Users/ryanperkowski/GitHub/DeadLight/Canon/<file>`); the last is `c74ec70 config: the show's own values, carried from the first repository`.

`find . -path ./.git -prune -o -maxdepth 2 -print` returns the following, and nothing else:

| Path | What it holds |
|---|---|
| `.gitignore` | **10 non-blank rules** (§2 measures the divergence from the first repository's) |
| `Canon/` | 16 root files, plus `characters/`, `species/`, `locations/`, `factions/` — **each holding only `_TEMPLATE.md`** |
| `Episodes/` | `_TEMPLATE/outline.md` and nothing else |
| `Production/` | `setup/` (thirteen bible-interview run logs plus `setup/world-overview/answers.md`) and `voice-refs/refs.json` (**no WAVs**) |
| `prompts/` | 43 files — 34 prompt bodies, `README.md`, 8 schemas |
| `README.md` | 61 lines, rendered from `main:tools/templates/show/README.md` (also 61 lines) |
| `showrunner.json` | 123 lines |

**`Production/setup/world-overview/answers.md` is three lines long and its one answer is the literal `(blank)`.** That is why `Canon/characters/` holds no sheets: the interview's cast question was not answered, so `init` wrote no sheet and left `audio.mainCast` as `["narrator"]` until `c74ec70` added the nine names by hand. **DeadLight2 therefore names nine recurring characters in `showrunner.json:42-52` and holds a sheet for none of them** — see A-04.

### 1.2 `showrunner.json`, diffed leaf by leaf

**Flattening both files to dotted leaf paths gives 71 leaves in the first repository and 61 in DeadLight2, with zero leaves whose values differ. The entire difference is the ten `airMap` entries.**

    leaves DeadLight: 71   leaves DeadLight2: 61
    --- only in DeadLight ---   airMap.ep01 = [1, 1] … airMap.ep10 = [1, 10]
    --- only in DeadLight2 ---  (none)
    --- differing values ---    (none)
    --- identical leaf count --- 61

`diff` on the raw files reports one more class of difference and it is cosmetic: five numbers are written `1.0`, `7.0`, `4.0`, `1.0`, `2.0` in the first repository and `1`, `7`, `4`, `1`, `2` in DeadLight2 (`audio.tailOutSeconds`, `audio.titleCardGapSeconds`, `audio.sceneTransitionGapMaxSeconds`, `video.crossfadeSeconds`, `video.titleCard.fadeSeconds`). **They are numerically identical and the leaf diff above does not see them**; the difference is a JSON round trip through `JSON.stringify`.

**Why `airMap` differs, at its address.** `main:engine/src/show-config.ts:165-167` refuses an aired id as an `airMap` key — `throw new ShowConfigError(\`${SHOW_CONFIG_FILE}: airMap.${id} must be a production id (epNN)\`)` — and `main:engine/src/show-config.ts:212-218`'s `seasonOf` reads an aired id's season off the id and consults the map only for a production id. `main:tools/src/init/config.ts:43-47` states the ruling in the code: "`airMap` is `{}` and that is the only honest value for a new show. … A show that starts at `s01e01` therefore has nothing it could legally or usefully put there." `scripts/lib/showconfig.py:120-128` mirrors the refusal.

**The twelve show-specific values, from `c74ec70`'s own diff.** The commit message names them: "audio.mainCast, the title card's colours, the publish playlist, tags and standing copy, and the visual style constants, ambient scaffold and collective-populator bans — the twelve values that are this show's and not the house defaults init writes." Counted leaf by leaf they are `audio.mainCast`, `visual.ambientPromptScaffold`, `visual.styleConstants`, `visual.collectivePopulatorBans`, `video.titleCard.colors.background`, `.type`, `.glow`, `.stage`, `publish.playlistUrl`, `publish.tags`, `publish.standingCopy.weekly`, `publish.standingCopy.aiDisclosure` — twelve.

**One value is a placeholder in both repositories and nobody has noticed: `publish.channelName` is the literal `[YOUR NAME]` at `showrunner.json:112` in DeadLight2 and `showrunner.json:153` in the first repository.** It is not among the twelve because the two files agree on it. See A-21.

### 1.3 What the import carried byte for byte, and what it did not

`cmp -s` against the first repository, file by file:

| DeadLight2 file | Result |
|---|---|
| `Canon/README.md`, `continuity-ledger.md`, `episode-formula.md`, `pipeline-artifacts.md`, `publishing-guide.md`, `season-1.md`, `series-arc.md`, `story-craft.md`, `style-guide.md`, `technology.md`, `timeline.md`, `visual-audit-laws.md`, `visual-style.md`, `voice-registry.md`, `world-overview.md` | **identical — 15 files** (the thirteen `BIBLE_FILES` interview/default rows plus the two `scaffold` rows, `main:engine/src/bible.ts:28-43`) |
| `Canon/factions/_TEMPLATE.md`, `Canon/locations/_TEMPLATE.md` | identical — the first repository's two entity templates already matched the generic ones |
| `Canon/characters/_TEMPLATE.md` | **differs.** `:24` is `## Stance toward the central mystery` in DeadLight2 against `## Dark-forest stance` in the first repository; `:26-28` and `:34-35` and `:47` differ in the same way (the stance vocabulary, and the audience-signal example `quiet-Vale, still-Pim, unhurried-Maeve` against `quiet-Trent, still-Opha, unprofitable-Remo`) |
| `Canon/species/_TEMPLATE.md` | **differs.** `:4` drops the first show's `0 (peer) \| 0.5 (elder mortal) \| 1 (Vanished)` tier line; `:17-18` is `## Relationship to the central mystery` against `## Relationship to the dark forest / the Vanished` |
| `Canon/refs.json` | **differs — it is the scaffold.** Two keys (`_doc`, `_workflow`) and no subject entries, against the first repository's 25 subject keys and 21 `ref` paths |
| `Production/voice-refs/refs.json` | **differs — it is the scaffold.** `"cast": {}` and no WAVs, against the first repository's nine LOCKED entries and nine WAVs |
| `Episodes/_TEMPLATE/outline.md` | **differs — entirely different documents** (§2.14) |
| `README.md`, `prompts/README.md`, `.gitignore` | differ — all three are the engine's templates |

**Absent from DeadLight2 entirely: `Canon/season-2.md` and `Canon/season-desk-report.md`.** Those are the only two of the first repository's eighteen `Canon/` root files the import did not bring.

### 1.4 `bible-check`, seasons 1 and 2

    $ node tools/dist/bible-check.js --show /Users/ryanperkowski/GitHub/DeadLight2 --season 1
    every bible file in /Users/ryanperkowski/GitHub/DeadLight2 is present and carries every section a prompt reads by name (season 1)
    EXIT=0

    $ node tools/dist/bible-check.js --show /Users/ryanperkowski/GitHub/DeadLight2 --season 2
    1 bible file(s) missing or empty:
      Canon/season-2.md
    EXIT=1

**The same tool passes both seasons against the first repository** (exit 0 for `--season 1` and for `--season 2`), which is the measurement that says `Canon/season-2.md` is already in the shape the engine's `REQUIRED_SECTIONS` wants: `main:engine/src/bible.ts:83-84` requires `## Season laws` and `## The slate` of `Canon/season-{season}.md`, and `/Users/ryanperkowski/GitHub/DeadLight/Canon/season-2.md` carries them at `:24` and `:66`.

**What the season-2 failure costs at run time, not only at check time.** `main:engine/src/pipelines/episode.ts:162-175` is the `bible-ready` guard, inserted by Plan G between `previous-episode` and `premise`; it fails a run with `BIBLE_INCOMPLETE: <list>`. So **a `s02e01` run in DeadLight2 stops at `bible-ready` by name until `Canon/season-2.md` is in place** — before the `premise` guard the inventory's F-12 named is ever reached.

### 1.5 `check-prompts` over DeadLight2's generic prompt set

**The context file.** Written to `<scratchpad>/deadlight2-check-context.json`: `main:tools/test/fixtures/harbor-check-context.json`'s `results` object with the two singular keys `outline-gate:rejection` and `script-gate:rejection` added (the fixture carries only the plural `…:rejections` forms), `show` replaced by DeadLight2's `showrunner.json` verbatim, `showRoot` set to `/Users/ryanperkowski/GitHub/DeadLight2`, `episodeId` `s02e01`, `season` 2, `runId` `check-prompts`. The `results` object holds 31 keys.

    $ node tools/dist/check-prompts.js --prompts /Users/ryanperkowski/GitHub/DeadLight2/prompts --context <that file>
    every prompt in /Users/ryanperkowski/GitHub/DeadLight2/prompts renders
    EXIT=0

**The same context against the first repository's prompts fails on four files, and all four are the season desk's:**

    apply.md            {{results.desk-gate}}: no result for step "desk-gate"
    desk-editor.md      {{results.season-status}}: no result for step "season-status"
    desk-gate.gate.md   {{results.desk-editor}}: no result for step "desk-editor"
    desk-gate.reject.md {{results.desk-gate:rejection}}: no result for step "desk-gate:rejection"
    EXIT=1

**That is not a defect in the first repository's prompts; it is the measurement that the seven desk prompts belong to a pipeline the engine does not define** (`docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md:37` records the desk as "spec §0's deferred desk, not dead code").

**The production-id case, measured.** With `season` removed from the context file and `episodeId` set to `ep01` — the state of an `epNN` id under `airMap: {}`:

    2 prompt(s) did not render:
      canon-review-outline.md   {{season}}: season is not available
      outline.md                {{season}}: season is not available
    EXIT=1

The two lines are `/Users/ryanperkowski/GitHub/DeadLight2/prompts/outline.md:18` (``- `Canon/season-{{season}}.md` — `## Season laws` bind every episode of the season``) and `prompts/canon-review-outline.md:10`. **This is the measurement §3 turns on: a Season 1 episode carried into DeadLight2 under its `epNN` id cannot run its `outline` or `canon-review-outline` step at all.**

---

## 2 · The trees to carry, measured one by one

**Conclusion: fifteen trees, 450 tracked files at 1,087.98 MB and 6,946 git-ignored files at 14.85 GB, and the copy's two hazards are both in `.gitignore` rather than in any file's content.** DeadLight2's `.gitignore` is ten rules against the first repository's thirty-eight non-blank ones; the consequence is that 34 currently-tracked files would arrive ignored and 914 currently-ignored files would arrive tracked (§2.16).

Each row's `tracked` and `ignored` figures are `git ls-files -- <path> | wc -l` and `git ls-files --others --ignored --exclude-standard -- <path> | wc -l` in the first repository at `25bb3c6`; bytes are `stat -f %z` summed over the same lists. `epNN/` counts are `grep -oE '\bep(0[1-9]|10)/' | wc -l` over the tracked text files (`.md`, `.json`, `.yaml`, `.py`, `.ts`, `.tsx`, `.srt`, `.txt`) only.

### 2.1 `Canon/season-2.md`

**1 tracked file, 35,528 bytes (34.7 KB), 139 lines, 1 `epNN/` reference.** `## Season laws` at `:24`, `## The slate` at `:66`, `## Load-bearing dependencies` at `:91`, `## Open questions this slate does not decide` at `:114`, `## Change log` at `:128`. The slate's twenty data rows are **3 `**RULED**` and 17 `**DRAFT**`** (`grep -cE '^\|\s*[0-9]+\s*\|\s*\*\*RULED'` → 3; the `DRAFT` form → 17). The one `epNN/` reference is at `:70`, inside row text: ``*"…used we didn't cash in on that relic"* (`ep10/script.md:389`)``.

**What reads it.** `main:engine/src/pipelines/episode.ts:82` adds `${canonDir}/season-${season}.md` to the canon spine when `seasonOf` resolves; `main:engine/src/bible.ts:49` (`SEASON_FILE_KEY = "season-1"`) and `:126-133` (`bibleFilesFor`) put `Canon/season-2.md` on the `bible-ready` guard's list for a season-2 episode; `main:engine/src/bible.ts:83-84` requires its two sections; and two generic prompts name it through the variable — `prompts/outline.md:18` and `prompts/canon-review-outline.md:10`. **This is the one file whose absence stops a run by name**, measured in §1.4.

### 2.2 `Canon/characters/`

**179 tracked files, 944.49 MB; 2 ignored (`.DS_Store` ×2, 30,728 bytes); 17 directories plus `_TEMPLATE.md`.** Of the 179: **14 Markdown files totalling 158.3 KB** (thirteen character sheets plus `_TEMPLATE.md`) and 165 images. **Four of the seventeen directories hold no sheet** — `Marle`, `Millies-Bite`, `Mink`, `Wella` — only stills.

Per-directory tracked counts: Trent 36, Sable 32, Sarn 32, Opha 30, Remo 25, Ansa 4, Cricket 3, Mardo 3, Ilvaren 2, The Mute 2, Vrask 2, Millies-Bite 2, Ernie Grother 1, Marle 1, Mink 1, The Vanished 1, Wella 1.

**`epNN/` path references: 3 files, 6 occurrences** — `Ansa/ansa.md` 2, `Ernie Grother/ernie-grother.md` 2, `The Mute/the-mute.md` 2. Seven more sheets carry `epNN` without a trailing slash (13 occurrences): `Cricket` 2, `Opha` 2, `Remo` 2, `Sable` 1, `Sarn` 1, `The Mute` 3, `Trent` 3.

**The 151 casting-pile stills, confirmed.** `git ls-files | grep -E '(^\|/)ep(0[1-9]|10)-[^/]*$'` returns **163 tracked files repo-wide whose own basename begins `epNN-`: 151 under `Canon/characters/` (Trent 34, Sarn 30, Sable 30, Opha 28, Remo 23, Millies-Bite 2, Ansa 2, Mink 1, Mardo 1) and 12 under `Canon/locations/Dead Light/`** — a folder the inventory's §1.9 did not count (§2.4).

**The heading mismatch, counted and quoted.** `## Dark-forest stance` appears in **twelve files under `Canon/characters/`**: eleven sheets (`Ansa`, `Cricket`, `Ernie Grother`, `Ilvaren`, `Mardo`, `Opha`, `Remo`, `Sable`, `Sarn`, `Trent`, `Vrask`) and `_TEMPLATE.md`. Two of the thirteen sheets carry neither heading: `The Mute/the-mute.md` (whose nineteen level-2 headings are its own) and `The Vanished/the-vanished.md`. Plan G's deferred record's figure of "twelve files" is exact (`docs/plans/2026-10-03-the-new-show-setup-deferred.md:28`).

**The generic prompt's line, quoted verbatim** — `/Users/ryanperkowski/GitHub/DeadLight2/prompts/character-check.md:26`:

    - **Stance toward the central mystery**: does what they say/do/joke about

**The first repository's line, at `/Users/ryanperkowski/GitHub/DeadLight/prompts/character-check.md:23`:**

    - **Dark-forest stance**: does what they say/do/joke about match their

**What reads the tree.** The config key is `visual.castingPileDir` (`showrunner.json:61` in both repositories, `Canon/characters`). Readers: `main:engine/src/pipelines/episode.ts:72` (defaulted) and `:342`, where the directory is declared as an input of the casting-pile step; `scripts/design-visual.py:63`, `scripts/image-sheet.py:71`, `scripts/registry-append.py:118`; and `scripts/nano-banana-generate.py:67-72`, which selects the two newest stills **by `os.path.getmtime`, never by name**. Five generic prompts name the directory on eight lines: `character-check.md:10-11` (`Glob Canon/characters/**/*.md`), `outline.md:21`, `:78`, `canon-review-script.md:11`, `:19`, `canon-review-outline.md:8`, `environment-check.md:29`.

### 2.3 `Canon/species/`

**12 tracked files, 19.14 MB; 1 ignored (`.DS_Store`); 7 Markdown files totalling 28.4 KB** — `README.md`, `_TEMPLATE.md`, `elyth.md`, `iss-kar.md`, `kessic.md`, `sethin.md`, `vesk.md` — plus 5 reference images (`Elyth/` 2 JPGs, `Iss-kar/` 3 PNGs). **1 `epNN/` reference** (`iss-kar.md`); 3 more `epNN` mentions without a slash (`iss-kar.md` 2, `sethin.md` 1).

**What reads it.** `/Users/ryanperkowski/GitHub/DeadLight2/prompts/outline.md:19` — `- Canon/species/ , Canon/locations/ , Canon/factions/`. Nothing in `engine/src/` or `scripts/` names the directory; `Canon/refs.json` points into it for three of its 21 `ref` paths.

### 2.4 `Canon/locations/`

**20 tracked files, 73.05 MB; 1 ignored; 6 Markdown files totalling 15.1 KB** — `_TEMPLATE.md`, `Dead Light/dead-light.md`, `Greenmarch/greenmarch.md`, `Half Shepard/half-shepard.md`, `Long Odds/long-odds.md`, `The Cairn/cairn.md` — plus 14 images. **2 `epNN/` references**, one each in `greenmarch.md` and `long-odds.md`.

**The measurement the inventory missed: `Canon/locations/Dead Light/` holds 12 tracked PNGs named `epNN-sNN-<shot-id>.png`** — `ep05-s01`, `ep05-s08`, `ep06-s10`, `ep07-s01`, `ep07-s02`, `ep07-s03`, `ep07-s10`, `ep07-s12`, `ep08-s01`, `ep08-s10`, `ep09-s10`, `ep10-s03`. The inventory's F-07 reasoned about 151 stills in 9 character folders; the real count of `epNN-`named pile stills is **163 in 10 folders**, and the tenth is a location.

**What reads it.** `prompts/outline.md:19` and `prompts/environment-check.md:10` (`any Canon/locations/ files for places in the script`). Two of `Canon/refs.json`'s 21 `ref` paths point into it.

### 2.5 `Canon/factions/`

**2 tracked files, 6,965 bytes** — `_TEMPLATE.md` and `salvagers-guild.md`. **Zero `epNN` references of any shape.** Read by `prompts/outline.md:19` only. DeadLight2 already holds the generic `_TEMPLATE.md`, which is **byte-identical** to the first repository's, so the carry is one file.

### 2.6 `Canon/refs.json` and its 21 `ref` paths

**1 tracked file, 26,817 bytes (26.2 KB). 25 subject keys plus 5 `_`-prefixed notes. 15 `epNN` mentions, none of them inside a path** — they sit in `locked` and description strings, e.g. `:66` `"Nano Banana, Ryan-approved 2026-07-22 (ep03 door shot; single-frame ref, not a turnaround)"`.

**All 21 `ref` paths resolve.** Walking the document and testing each with `os.path.exists` from the show root returned `OK` for all 21 and `missing: 0`:

| Key | `ref` |
|---|---|
| `dead-light` | `Canon/locations/Dead Light/Dead Light Reference.png` |
| `coalvane` | `Canon/locations/Coalvane Station/Coalvane Reference.png` |
| `remo`, `sarn`, `opha`, `cricket`, `sable`, `trent`, `ansa`, `mardo`, `marle`, `wella`, `vrask` | `Canon/characters/<Name>/<Name> Reference.png` |
| `the-mute` | `Canon/characters/The Mute/The Mute Reference.png` |
| `ilvaren` | `Canon/characters/Ilvaren/Ilvaren Reference Image.jpg` |
| `iss-kar`, `iss-kar-private`, `iss-kar-refugee` | `Canon/species/Iss-kar/Iss-kar <…>Reference.png` |
| `elyth`, `elyth-female` | `Canon/species/Elyth/Elyth <Male\|Female> Reference.jpg` |
| **`relic`** | **`Canon/_candidates/relic-2.png`** |

**The `relic` row is the one that matters for §2.7: one of the 21 reference images lives inside `Canon/_candidates/`, which DeadLight2's `.gitignore:7` ignores.**

**What reads the file.** The config key is `visual.refs` (`showrunner.json:58` in both, `Canon/refs.json`). Readers: `main:engine/src/needs.ts:48`, `:67-70` and `:97-99` (`missingRefs` resolves each named subject's `ref` and reports `reference image missing at <path>` when it does not exist); `main:engine/src/pipelines/episode.ts:70`, `:342`; `scripts/design-visual.py:61`, `scripts/image-generate.py:78`, `scripts/nano-banana-generate.py:423`, `scripts/registry-append.py:117`. Four generic prompts name it: `visual-direction.md:10`, `:76`, `visual-direction-fix.md:7`, `nano-banana-gate.reject.md:23`.

### 2.7 `Canon/_candidates/`

**34 tracked PNGs, 23,021,563 bytes (21.96 MB); 1 ignored (`.DS_Store`); zero `epNN` references.** Names are `<subject>-<n>.png` (`coalvane-1..3`, `cricket-1..2`, `relic-*`, and so on).

**What reads it.** The config key is `visual.candidatesDir` (`showrunner.json:62` in both, `Canon/_candidates`), and `main:engine/src/show-config.ts:94` records exactly one reader: `scripts/design-visual.py:62 (sc.path)`. That script **writes** candidates there (`:25` "Writes `<visual.candidatesDir>/<key>-1.png .. -N.png`"), and `:26` says locking is manual — "copy the chosen candidate into `<visual.castingPileDir>`". **So by the intended workflow the directory is scratch.**

**But `Canon/refs.json`'s `relic` entry points into it, so one of the show's 21 reference images is a candidate that was never copied out.** And DeadLight2's `.gitignore:7` is `Canon/_candidates/`:

    $ git -C /Users/ryanperkowski/GitHub/DeadLight2 check-ignore --no-index --verbose Canon/_candidates/relic-2.png
    .gitignore:7:Canon/_candidates/	Canon/_candidates/relic-2.png

In the first repository the 34 PNGs are tracked because `.gitignore:13` names the **retired** path `Canon/visual-refs/_candidates/` instead — Plan G's deferred record calls this out (`docs/plans/2026-10-03-the-new-show-setup-deferred.md:27`, "`.gitignore`'s candidates rule (names the retired `Canon/visual-refs/_candidates/` path; `Canon/_candidates/` is tracked — F-20)"). **Copied as they stand, all 34 arrive in DeadLight2 present on disk and absent from git**, and `missingRefs` would still pass because `main:engine/src/needs.ts:98` tests the filesystem, not the index — until someone clones DeadLight2, at which point `relic`'s reference image is gone. See A-05.

### 2.8 `Production/voice-refs/`

**10 tracked files, 5,729,268 bytes (5.46 MB): `refs.json` (6,966 bytes) and nine WAVs. 7 `epNN` mentions, all inside `arc_note` and register labels, none in a path.**

**All nine cast entries pass the engine's two tests.** Reading `cast` and testing each entry: every one of `narrator`, `Sable`, `Sarn`, `Opha`, `Trent`, `Cricket`, `Remo`, `Mute`, `Ilvaren` has a `status` containing `LOCKED` and a `ref` whose WAV exists. `narrator`'s status is `LOCKED (speed 1.12; 1.15 under A/B)`; the other eight are the bare word.

**The reader, quoted** — `main:engine/src/needs.ts:111`:

    if (!status.includes("LOCKED")) missing.push(`${entry.name}: voice is not LOCKED in ${path.posix.join(d.voiceRefs, "refs.json")} (cast key ${voiceKey})`);

with `:112` then testing the WAV's existence. The config key is `audio.voiceRefsDir` (`showrunner.json:53` in both). `main:engine/src/pipelines/episode.ts:266` declares `${voiceRefsDir}/refs.json` an input of the `tts-script` step. Two generic prompt lines name the path literally: `prompts/tts-script.md:7` and `:133`.

**The nine keys are exactly `audio.mainCast`'s nine values**, in the same order (`showrunner.json:42-52` in both repositories). **DeadLight2 holds the scaffold — `"cast": {}` and no WAVs — so every speaking recurring character would stop a run at `NEEDS_REFS` until the nine WAVs and their nine entries arrive.**

### 2.9 `Production/<id>/guest-refs/` for the Season 1 episodes

**54 tracked WAVs, 19,023,732 bytes (18.14 MB), in six of the ten Season 1 episodes;** two more exist on disk and are ignored (56 total under `find Production/*/guest-refs -type f`).

| Episode | Tracked WAVs | MB |
|---|---|---|
| `ep01` | 18 | 5.43 |
| `ep02` | 6 | 2.22 |
| `ep03` | 8 | 3.28 |
| `ep04` | 4 | 1.36 |
| `ep07` | 12 | 3.61 |
| `ep08` | 6 | 2.25 |

`ep05`, `ep06`, `ep09` and `ep10` have no `guest-refs/` directory at all. **The inventory's §1.1 figure of "64 `guest-refs/*.wav`" does not reproduce; today's count is 54, and the inventory's own next clause names a separate 10 under `Production/ep01/casting-samples/`, which is where the other ten are.**

**What reads the directory** — `main:engine/src/needs.ts:77`:

    const guestDir = path.join(showRoot, d.production, episodeId, "guest-refs");

**That is a hardcoded literal, not the config key.** `main:engine/src/show-config.ts:88` records `audio.guestRefsDir` as read by "nothing yet: `engine/src/needs.ts:77` hardcodes `<productionDir>/<episodeId>/guest-refs` instead of reading the key", and Plan G's deferred record lists it (`…deferred.md:31`). `showrunner.json:54` in both repositories is `Production/{episodeId}/guest-refs`. `main:engine/src/needs.ts:116` matches a guest WAV by `startsWith(slug)`. One generic prompt line names the path: `prompts/tts-script.md:141`.

### 2.10 `Episodes/ep01` … `Episodes/ep10`

**61 tracked files, 0.89 MB** (per-episode: ep01 8, ep02 5, ep03 5, ep04 5, ep05 7, ep06 6, ep07 6, ep08 6, ep09 7, ep10 6). One ignored file (`Episodes/ep10/.DS_Store`). **14 files carry 59 `epNN/` references:** `ep10/outline.md` 14, `ep09/outline.md` 9, `ep05/outline.md` 6, `ep08/outline.md` 5, `ep07/outline.md` 4, `ep10/launch-premise.md` 4, `ep01/outline.md` 3, `ep05/outline-v1-preMute.md` 3, `ep06/outline.md` 3, `ep01/locked-beats.md` 2, `ep04/locked-beats.md` 2, `ep05/launch-premise.md` 2, `ep09/launch-premise.md` 1, `ep09/removed-from-script-2026-08-29.md` 1.

**The ten archive markers, read.** Each `Episodes/epNN/archive.json` is exactly `{"stage": "COMPLETE", "note": "Season 1, made by console v1; final on the NAS <date>"}` with the dates 2026-07-18, 07-22, 07-24, 07-28, 08-02, 08-14, 08-18, 08-26, 09-04, 09-16. **No marker contains an episode id**, so the copy needs no content edit. `COMPLETE` is a valid stage (`main:engine/src/stages.ts:17`).

**Three shape measurements that bear on how the generic prompts behave once Season 1 is in DeadLight2.**

1. **Not one of the ten outlines carries a `## Cast` section** (`grep -l '^## Cast' Episodes/ep*/outline.md` returns nothing). `main:engine/src/needs.ts:63-65` returns an empty `missingRefs` list when the outline has no cast section, so `refsMissing` is false for every Season 1 episode for a reason that has nothing to do with the references being present.
2. **Three of the ten carry `## Scene synopsis`; eight each carry `## Arc beats`, `## Ending duties`, `## Threads opened`, `## New canon proposed`.** The generic `outline-gate.gate.md:6` reads `## Scene synopsis` by name; the generic `character-check.md:8` and `structure-check.md:19,22` read `## Arc beats`, `## Threads opened` and `## Endings`.
3. **No `premise.md` exists anywhere in the first repository.** `git ls-files '*premise*'` returns six files, all `Episodes/epNN/launch-premise.md` (`ep05`–`ep10`) — console v1's name. The engine reads `premise.md` (`main:engine/src/needs.ts:145`, `main:engine/src/pipelines/episode.ts:86`) and reads `launch-premise.md` nowhere.

### 2.11 `Production/ep01` … `Production/ep10`

**124 tracked files, 22.67 MB; 6,378 git-ignored files, 13.20 GB; 2 untracked.** Per-episode tracked: ep01 32, ep02 10, ep03 15, ep04 12, ep05 7, ep06 6, ep07 17, ep08 12, ep09 5, ep10 8 — the inventory's §1.1 table, confirmed at `25bb3c6`. Ignored bytes per episode run 1,001.0 MB (ep05) to 2,246.3 MB (ep01).

**The two untracked files are still there** (`git status --porcelain Production/ep10`): `Production/ep10/tts-script-v1-prepause.json` and `Production/ep10/tts-script.json.bak-preop`. Neither is ignored by either repository's `.gitignore`.

**The manifests with an `"episode"` field: 21 tracked, exactly the inventory's set** — `Production/epNN/tts-script.json` ×10, `Production/epNN/images/prompts.json` ×10, and `Production/ep03/tts-script.RESEG.json`. **`Production/ep01/tts-script.json` says `"episode": "ep01-v2"`** while its directory is `ep01`; the other twenty agree with their directory. The field's only writer is `scripts/tts-generate.py:133`, and nothing reads it back — the inventory's F-05 holds unchanged.

**31 files carry 163 `epNN/` references, and they split cleanly into two kinds.**

**Kind one — 30 references in 7 files, every one a `"ref"` value a Python step resolves.** `grep -oE '"ref"[^,]*\bep(0[1-9]|10)/'` accounts for all 30, and `grep -nE '\bep(0[1-9]|10)/' <file> | grep -v '"ref"'` returns nothing for all seven:

| File | `"ref"` references |
|---|---|
| `Production/ep01/tts-script.json` | 6 |
| `Production/ep07/tts-script.json` | 6 |
| `Production/ep03/tts-script.json` | 5 |
| `Production/ep03/tts-script.RESEG.json` | 5 |
| `Production/ep02/tts-script.json` | 3 |
| `Production/ep08/tts-script.json` | 3 |
| `Production/ep04/tts-script.json` | 2 |

Each is a path of the form `"ref": "Production/epNN/guest-refs/<slug>-N.wav"`. **Two scripts resolve them and both exit on a miss:** `scripts/tts-generate.py:38-39` (`if not os.path.exists(c["ref"]): sys.exit(f"tts-generate: reference WAV not found: {c['ref']}")`) and `scripts/validate-manifest.py:126-127` (`fails.append(f"cast {spk!r} ref not found: {c['ref']}")`).

**Kind two — 133 references in 24 files, every one prose inside a human instruction sheet.** `Production/ep08/images/SHOT-SHEET.md` 45, `Production/ep06/notes/hand-prompts.md` 19, `Production/ep10/images/SHOTS-TO-MAKE.md` 17, `Production/epNN/publish/upload.md` 4 each (ten files, 40), `Production/epNN/images/IMAGE-SHEET.md` 1 each (eight files), `Production/ep03/images/NANO-BANANA-BRIEFS.md` 2, `Production/ep04/images/NANO-BANANA-BRIEFS.md` 1, `Production/ep10/images/AMBIENT-CONTEXT.md` 1. They are of the shape `**File:** \`Production/ep08/images/s01-dead-light-braking-arrival.png\`` and `upload:  Production/ep01/publish/captions.srt` — addresses a person follows, which no program resolves.

**The ten `Production/epNN/video/timeline.json` files carry 504 more references and are ignored in both repositories.** Counts per file: ep01 56, ep02 51, ep03 45, ep04 49, ep05 47, ep06 49, ep07 55, ep08 46, ep09 55, ep10 51. DeadLight2's `.gitignore:3` (`Production/*/video/`) ignores them under either id shape, verified for both `Production/ep03/video/timeline.json` and `Production/s01e03/video/timeline.json`.

**No Season 1 episode has a `runs/` directory** (`ls -d Production/ep*/runs` returns only `Production/ep98/runs`). That is the state `main:engine/src/pipelines/episode.ts:152` reads as "the archive" (§3.4).

### 2.12 `ep98`

**`Episodes/ep98`: 3 tracked files, 0.06 MB** (`STATUS.md`, `outline.md`, `script.md`; no `archive.json`, no `premise.md`), carrying 3 `epNN/` references across `outline.md` (2) and `STATUS.md` (1). **`Production/ep98`: 2 tracked files, 0.11 MB; 561 ignored files, 1,621.57 MB; 563 on disk.**

**`Production/ep98/runs/` exists and holds zero entries** (`ls -la` shows `total 0`), left behind by the exercise's own cleanup. It does not change the Board — `main:console/server/runs.ts:373-374` keys on `latestRunId(...) === undefined`, which an empty directory satisfies — but it is exactly the state the `previous-episode` guard reads as a *failure* rather than as an archive (§3.4).

**`ep98` is load-bearing for the engine, not for the show.** `main:engine/test/ep98-exercise.test.ts:31` is `const EP = "ep98";` and `:35` is `const showRoot = process.env["SHOWRUNNER_SHOW_ROOT"] ?? "";` — "it comes from the environment and has no default: a default would have to spell some show's directory name, and nothing under `engine/` may name a show" (`:33-34`). It is the engine's only test that runs the real Python steps against a real show repository, documented at `main:README.md` under the ep98 exercise.

### 2.13 `ep99`

**`Production/ep99`: 1 tracked file (`tts-script.json`), 0.08 MB; 2 ignored, 98.27 MB; 3 on disk. `Episodes/ep99` does not exist; its narrative files are at `Episodes/_retired/ep99/` (3 tracked: `RETIRED.md`, `outline.md`, `script.md`, carrying 3 `epNN/` references), which `listEpisodeIds` never reaches because `main:engine/src/episodes.ts:13-18` scans one level only.**

### 2.14 `Episodes/_TEMPLATE/`

**Both repositories hold exactly one file, `outline.md`, and they are different documents: 32 lines in the first repository against 26 in DeadLight2, with no line in common beyond the `# ` and `## ` punctuation.**

The first repository's sections are `## Status` / `## Target runtime` / `## Canon loaded`, `## Premise`, `## Beat outline`, `## Script`, `## Image / slideshow prompts`, `## Publish package`, `## Post-episode canon updates`. **None of them is a section the generic `outline.md` prompt reads.**

DeadLight2's sections are `## Scene synopsis`, `## Arc beats`, `## Cast`, `### Beat 1 — <title>` / `### Beat 2 — <title>`, `## Ending duties`, `## Threads opened`, `## New canon proposed` — each with an HTML-comment instruction naming what reads it. Plan G's deferred record names the defect it fixes: "`Episodes/_TEMPLATE/outline.md` (does not teach the format the outline prompt requires — F-04)" (`…deferred.md:27`).

**DeadLight2's copy carries two Harbor Lights lines at `:11-12`:** `- Vale (recurring, speaks)` and `- Harbor (location)`.

### 2.15 The prompts: 41 against 34

**The first repository holds 51 tracked files under `prompts/`: 41 prompt bodies, `README.md`, 8 schemas, and `index.json` (883 lines). DeadLight2 holds 43: 34 prompt bodies, `README.md`, 8 schemas. All 43 of DeadLight2's are byte-identical to `main:tools/templates/prompts/`** (`git show main:<path> | cmp -s - <DeadLight2 path>` → 43 identical, 0 differ).

**The eight files that exist only in the first repository** are the seven season-desk prompts — `apply.md`, `arc-tracker.md`, `craft-critic.md`, `desk-editor.md`, `desk-gate.gate.md`, `desk-gate.reject.md`, `thread-auditor.md` — and `index.json`. **Nothing exists only in DeadLight2.**

**The 34 common prompt bodies, plus `README.md` and the 8 schemas.** `cmp -s` gives: 8 schemas identical; `casting-gate.gate.md` identical; 33 prompt bodies and `README.md` differ. The differences are five mechanical substitutions and one class of real loss.

| Substitution | Measured incidence |
|---|---|
| `*Dead Light*` → `*{{show.showName}}*` | 26 of the 33 differing bodies |
| literal `Episodes/`/`Production/` → `{{show.episodesDir}}`/`{{show.productionDir}}`, on lines that already render a variable | 70 substitutions across 32 bodies |
| an inline law → `` apply `## <Heading>` of `Canon/<file>.md` `` | **22 section citations added across 12 bodies, and none removed** — `tone-check.md` 6, `environment-check.md` 3, `outline.md` 3, `character-check.md` 2, and one each in `draft.md`, `outline-gate.reject.md`, `repetition-check.md`, `revise.md`, `script-gate.reject.md`, `structure-check.md`, `canon-review-script.md`, `tts-script.md` |
| a Dead Light cast name → a Harbor Lights one | 6 bodies (`environment-check.md`, `flow-check.md`, `outline.md`, `tts-script.md`, `visual-direction.md`, `nano-banana-gate.reject.md`) |
| a spelled-out show value → a config variable | 1 body: `visual-direction.md:38-43`'s thirteen-item ban list → `{{show.visual.collectivePopulatorBans}}` at `:40`, which DeadLight2's `showrunner.json:79-93` carries in full |

**What the generic version lost, file by file, with the first repository's address.** Each row is a law or a measured fact the first show's prompt stated inline; the "where it went" column is measured, not inferred.

| First repository's address | What it says | Where it went |
|---|---|---|
| `prompts/draft.md:6` `:26`, `prompts/outline.md:21`, `prompts/tone-check.md:3` | `Episodes/ep01/script.md` and `Episodes/ep01/outline.md` as the canonical register and format | **Replaced, not lost.** The generic `draft.md:7`, `:20`, `revise.md:30`, `repetition-check.md:9`, `tone-check.md:4` glob `Episodes/*/script.md` and fall back to `` `## Register sample` of `Canon/style-guide.md` ``. **This closes the inventory's F-08** |
| `prompts/draft.md:20`, `prompts/repetition-check.md:8` | the glob `Episodes/ep*/script.md` | **Replaced** by `Episodes/*/script.md` — the two globs Plan G's deferred record named as breaking at the rename (`…deferred.md:27`) |
| `prompts/outline-gate.reject.md:1-9` | the size-discipline law, with its measured example: "ep09's grew 55% across three rounds to 13,152 words — nearly double the script it describes — and that bloat is what exhausted the drafting agent's session. If the outline exceeds ~9,000 words, cut before you finish." | **Moved to the bible.** `Canon/episode-formula.md:8` in **both** repositories now carries the law and the number, stamped "(moved from prompts/outline-gate.reject.md at Plan G, 2026-10-03)". The ep09 measurement itself is the only thing dropped |
| `prompts/repetition-check.md:35-39` | the canonical cross-episode failure: "ep03's child's-drawing-with-sun-rays was the emotional core of a scene; ep04 independently reused it as a throwaway" | **Lost as a worked example.** The generic `:36-41` states the rule abstractly |
| `prompts/environment-check.md:20-37` | the PRESSURIZED / HARD VACUUM / MIXED vocabulary, the vacuum gear rules, and Opha's bespoke EVA shell | **Moved to the bible** as `` `## Environment rules` of `Canon/technology.md` `` (cited 7 times in the generic `environment-check.md`), which Plan G's bible PR added to `Canon/technology.md` in the first repository and the import carried |
| `prompts/character-check.md:14-27` | the four stance labels (`believer / denier / mercenary-indifferent / haunted`) and the named role dynamics (Sarn commands, Cricket needles, Trent overreaches, Sable steadies) | **Moved to the bible** as `` `## The primary cast` of `Canon/world-overview.md` `` and `` `## Character voices` of `Canon/style-guide.md` `` |
| `prompts/audio-gate.gate.md:2` | `Production/{{episodeId}}/audio/DeadLight *.wav  ({{results.audio-mix}})` | **Fixed.** The generic line is `{{show.productionDir}}/{{episodeId}}/audio/*.wav  ({{results.audio-mix}})`. **This closes O-16, O-20 and the inventory's F-23** |

**What the generic set gained that the first repository's does not have, and which does not belong to this show: seven lines of Harbor Lights in six prompt bodies, plus two more in a canon template and two in the outline template.**

| Address in DeadLight2 | Text |
|---|---|
| `prompts/environment-check.md:28-29` | `(the Warden's oilskin — see` / `Canon/characters/The Warden/the-warden.md).` |
| `prompts/outline.md:89-91` | `its Canon sheet spells it ("the Warden", "Maeve", "Harbor"). Examples:` / `` `- Vale (recurring, speaks)`, `- the Warden (recurring, speaks)`, `` / `` `- Harbormaster Quill (guest, speaks)`, `- Harbor (location)`. `` |
| `prompts/visual-direction.md:47` | `So 'three people: Vale, Pim and Maeve' PASSES; 'people' alone` |
| `prompts/flow-check.md:26` | `the flatness is intentional deadpan (e.g. Vale, Pim).` |
| `prompts/tts-script.md:59` | `("said X", "Maeve grinned") -> "narrator", as separate segments in` |
| `Canon/characters/_TEMPLATE.md:34-35` | `quiet-Vale,` / `still-Pim, unhurried-Maeve` |
| `Episodes/_TEMPLATE/outline.md:11-12` | `- Vale (recurring, speaks)` / `- Harbor (location)` |

**`prompts/environment-check.md:29` is the only one that is a path**, and it names a character directory DeadLight2 does not have.

### 2.16 The `.gitignore` divergence, and what it does to the copy

**The first repository's `.gitignore` has 38 non-blank, non-comment rules; DeadLight2's has 10. Sixteen rules exist only in the first repository and one only in DeadLight2.**

| Only in the first repository | Only in DeadLight2 |
|---|---|
| `.agent-logs/`, `console/node_modules/`, `console/dist/`, `remotion/node_modules/`, `remotion/public/`, `Production/bakeoff/`, `Production/tts-bakeoff/`, `Production/tts-casting/`, `Production/*/audio-spike/`, `Production/*/audio-v1-*/`, `Production/*/images-v1-dark/`, `Production/*/notes/*.draft.md`, `Canon/visual-refs/_candidates/`, `__pycache__/`, `*.pyc`, `.playwright-mcp/` | `Canon/_candidates/` |

**Measured consequence one — 34 tracked files would arrive ignored.** Running `git -C DeadLight2 check-ignore --no-index --verbose` over the carry set's 450 tracked paths matches **exactly 34**, all under `Canon/_candidates/`, all by `.gitignore:7` (§2.7).

**Measured consequence two — 914 ignored files, 0.61 GB, would arrive tracked.** Running the same check over the carry set's 6,946 ignored paths leaves 6,032 still ignored and **914 not matched by any DeadLight2 rule**:

| Directory | Files |
|---|---|
| `Production/ep10/audio-v1-prepause/segments` | 524 |
| `Production/ep01/audio-v1-predensity/segments` | 382 |
| `Production/ep10/audio-v1-prepause` | 2 |
| `Production/ep01/audio-v1-predensity` | 2 |
| `Production/ep04/notes` | 2 |
| `Production/ep05/notes` | 2 |
| `Production/ep99/audio-spike` | 1 |

**The missing rules are `Production/*/audio-v1-*/`, `Production/*/audio-spike/` and `Production/*/notes/*.draft.md`.** Two of the 914 are also the two manifests the inventory's §1.4 lists as ignored-with-an-`"episode"`-field (`Production/ep01/audio-v1-predensity/manifest.json`, `Production/ep10/audio-v1-prepause/manifest.json`).

### 2.17 The carry set, totalled

Over the thirty-one paths of §2.1–§2.13 (`Canon/season-2.md`, the four entity trees, `Canon/refs.json`, `Canon/_candidates`, `Production/voice-refs`, `Episodes/ep01`–`ep10`, `Production/ep01`–`ep10`, `Episodes/ep98`, `Production/ep98`, `Production/ep99`; `guest-refs` lives inside the Production directories):

| Quantity | Figure |
|---|---|
| Tracked files | **450** (of the first repository's 799) |
| Tracked bytes | **1,087.98 MB** (of 1.12 GB) |
| Git-ignored files | **6,946** |
| Git-ignored bytes | **14.85 GB** |
| Untracked files | **2** (`Production/ep10`'s two pre-op backups) |

**349 of the first repository's 799 tracked files are outside the carry set entirely** (§5).

---

## 3 · What Season 1 needs to show as COMPLETE on the new console from DeadLight2

**Conclusion: if the ten episodes are copied as `s01e01`…`s01e10` with their markers, the Board shows ten COMPLETE archived rows with no launch button and needs nothing else — the archive-marker mechanism Plan E shipped does the whole job. If they are copied as `ep01`…`ep10` with `airMap: {}`, the Board shows the same ten rows, sorted after every Season 2 row, but two of the generic prompts cannot render for them and the canon spine carries no season document — so the rows look right and the episodes cannot be re-run.** `s02e01`'s `previous-episode` guard requires nothing at all of `s01e10`, because it returns before it ever names a previous episode.

### 3.1 How the Board finds an episode at all

`main:engine/src/episodes.ts:10-21` is the row list. `:12` iterates `[show.episodesDir ?? "Episodes", show.productionDir ?? "Production"]`; `:18` is `for (const e of entries) if (e.isDirectory() && isEpisodeId(e.name)) ids.add(e.name);`; `:20` sorts with `compareEpisodeIds`. The grammar is `main:engine/src/ids.ts:12-13`:

    const AIRED = /^s(\d{2})e(\d{2})$/;
    const PRODUCTION = /^ep(\d{2})$/;

**Both shapes match, which is why the inventory's §2 conclusion — the engine already reads `sXXeYY` — survives the change of path unchanged.**

**DeadLight2 today returns an empty list.** Its `Episodes/` holds only `_TEMPLATE` and its `Production/` holds only `setup` and `voice-refs`; none parses as an episode id (`setup` is refused by name and by grammar, `main:engine/src/ids.ts:44-60`). **So the Board in DeadLight2 shows no rows until Plan F puts a directory there.**

### 3.2 Copied as `s01e01`…`s01e10` with their markers

**The Board shows ten rows at stage COMPLETE, status `archived`, each with the marker's note, no reasons beside it, and no launch button.** The path, link by link:

1. `listEpisodeIds` returns `s01e01`…`s01e10`, sorted first by `compareEpisodeIds` (`main:engine/src/ids.ts:73`: aired sorts before production).
2. `main:console/server/runs.ts:373-374` — `const runId = await latestRunId(…); if (runId === undefined) return idleEpisodeRow(this.#ctx, episodeId);`. No Season 1 episode has a `runs/` directory (§2.11), so all ten take this branch.
3. `main:console/server/episodes.ts:78` builds the marker path as `path.join(ctx.showRoot, ctx.episodesDir, episodeId, ARCHIVE_FILE)` with `ARCHIVE_FILE = "archive.json"` (`:57`) — i.e. `Episodes/s01e01/archive.json`, which is where the copy puts it.
4. `main:console/server/episodes.ts:89-97` accepts the marker: `stage` is a string and `isStage("COMPLETE")` is true (`main:engine/src/stages.ts:17`).
5. `main:console/server/episodes.ts:127-130` sets `row.stage = archive.marker.stage; row.status = "archived"; row.needs = { ideaMissing: false, refsMissing: [], imagesMissing: [] };` and attaches `archiveNote`.
6. `main:console/src/pages/Board.tsx:189-190` suppresses the launch button for `row.status === "archived"` and prints `archived; launch is not offered`; `:53-58` renders the chip as `archived · <note>`.

**The ten titles the Board would show**, read by `main:console/server/episodes.ts:17-27` (the `# ` heading of `outline.md`, else of `script.md`, else the id):

| Row | Title |
|---|---|
| `s01e01` | `Ep. 1 — "Dead Light" — OUTLINE (pilot rewrite)` |
| `s01e02` | `S1E2 — "Margin"` |
| `s01e03` | `S1E3 — "The Bag Comes Home By Hand"` |
| `s01e04` | `S1E4 "The Well"` |
| `s01e05` | `Ep. 5 — "Dead Quiet" — OUTLINE` |
| `s01e06` | `Ep. 6 — "Nobody Took a Step" — OUTLINE` |
| `s01e07` | `Ep. 7 — "A Living Vanished" — OUTLINE` |
| `s01e08` | `Ep. 8 — "The Wall of Silence" — OUTLINE` |
| `s01e09` | `Ep. 9 — "The Working Day, Part One" — OUTLINE (written fresh; ep98 is dead and was not consulted)` |
| `s01e10` | `Ep. 10 — "The Working Day, Part Two" — OUTLINE (SEASON FINALE)` |

**The marker is what prevents the rows reading `NEEDS_IDEA`,** and the reason is on disk rather than in the marker: no `premise.md` exists for any Season 1 episode (§2.10), so `main:engine/src/needs.ts:146` would set `ideaMissing: true` and `main:engine/src/stages.ts` would derive `NEEDS_IDEA`. `main:console/server/episodes.ts:105-111` states the rule in prose: the marker is read "only when the episode has no run logs at all, so no marker can mask a run that is waiting, failed, crashed or running."

### 3.3 Copied as `ep01`…`ep10` unchanged, with `airMap: {}`

**The Board's ten rows look identical, and three things behind them do not work.**

**What is unchanged.** `PRODUCTION` matches, so `listEpisodeIds` returns all ten; `idleEpisodeRow` still reads `Episodes/ep01/archive.json`; the stage, status, note and suppressed launch button are the same. **The console reads neither `seasonOf`, `formatAired` nor `airMap`:** `git grep -n 'seasonOf\|formatAired\|airMap' main -- console/` returns three hits and all three are test fixtures (`console/test/fixtures/seed-show.mjs:136`, `console/test/helpers.ts:48`, `console/test/worker.test.ts:11`). **So no Board row renders an air slot under either shape, and `formatAired` has exactly one production reader in the whole engine — `main:engine/src/pipelines/episode.ts:150`, inside the `previous-episode` guard.**

**What changes, measured.**

1. **Sort order.** `main:engine/src/ids.ts:73` — `if (a.kind !== b.kind) return a.kind === "aired" ? -1 : 1;` — puts every aired id before every production id. So the ten Season 1 rows would sit **below** `s02e01` and every later Season 2 episode, in ascending `epNN` order.
2. **`seasonOf` throws, and two of the three callers absorb it.** `main:engine/src/show-config.ts:216` — `throw new ShowConfigError(\`no season for production id ${id.raw}: it is not in airMap\`)`. `main:engine/src/pipelines/episode.ts:77` is `try { season = seasonOf(episodeId, show.airMap); } catch { season = undefined; }`, so **the canon spine for an `epNN` run carries no season document at all** (`:82` adds one only when `season !== undefined`), and `main:engine/src/bible.ts:126-133` drops the season row, so `bible-ready` demands no `season-N.md`. `main:engine/src/agent-step.ts:167-175` also absorbs it (`if (!(err instanceof ShowConfigError)) throw err;`) and leaves `season` undefined.
   **This corrects the inventory's §2.1 table, which says of `engine/src/agent-step.ts:160` "after emptying, the `seasonOf` throw propagates". It does not propagate, and it did not at `9347474` either:** `9347474:engine/src/agent-step.ts:156-164` has the same `catch`. What fails is the renderer, for a prompt that writes `{{season}}`.
3. **Two generic prompts fail to render.** Measured in §1.5: `outline.md` and `canon-review-outline.md` both report `{{season}}: season is not available`. So an `epNN`-shaped Season 1 episode in DeadLight2 **cannot run its `outline` or `canon-review-outline` step**, which is the only path by which a Season 1 episode would ever be re-made.
4. **`mixFilename` falls back.** `main:engine/src/show-config.ts`'s `UNMAPPED_MIX` returns `episode.wav` for an unmapped production id, so a re-run of the audio step would not write `DeadLight S01E01.wav`. The Python mirror behaves the same (`scripts/audio-mix.py`, `scripts/build-timeline.py`), and `scripts/publish-kit.py:106` (`season, episode = sc.season_of(cfg, ep)`) and `scripts/finalize-video.py:129` would exit.
5. **`airMap` cannot be fixed by adding aired keys.** `main:engine/src/show-config.ts:165-167` throws `airMap.<id> must be a production id (epNN)`. The only legal repair is to put `ep01: [1,1]`…`ep10: [1,10]` back — i.e. to re-create in DeadLight2 the map the fresh instance was created without.

### 3.4 The `previous-episode` guard, quoted, and what it asks of `s01e10`

`main:engine/src/pipelines/episode.ts:143-159`. The two lines that decide everything:

    if (id.kind !== "aired" || id.episode === 1) return { pass: true, message: "no previous episode to wait for" };
    const prev = formatAired(id.season, id.episode - 1);
    const dir = path.join(ctx.showRoot, productionDir, prev, "runs");
    if (!(await isDir(dir))) return { pass: true, message: `${prev} has no run logs (archive)` };

**`s02e01` requires nothing of `s01e10`.** `id.episode === 1` is true, so the guard returns at the first line with "no previous episode to wait for" and never computes `prev`. The guard would not look for `s01e10` even if Season 1 were absent entirely. O-15 is confirmed at its address on `main`, and the inventory's §2.5 reading holds.

**Does an archived episode with no run logs satisfy the guard? Yes — if "no run logs" means no `runs/` directory.** The test at the fourth line above is `isDir`, not "contains a `.jsonl`". So:

| State of `Production/<prev>/runs` | Guard result |
|---|---|
| absent (every Season 1 episode as copied) | **pass** — `<prev> has no run logs (archive)` |
| present and **empty** | **fail** — `isDir` is true, the loop at `:153-157` finds no completed run, and `:158` returns `<prev> has not completed its canon update (rule 1.3); finish it first` |
| present with a completed run | pass — `<prev> completed in run <runId>` |

**`Production/ep98/runs/` is an empty `runs/` directory today** (§2.12). It cannot break anything while `ep98` keeps a production id, because the guard only ever looks at an aired predecessor — but it is the shape Plan F must not reproduce: **copying an empty `runs/` directory into `Production/s01eNN/` would make `s01e<NN+1>`'s guard fail.** See A-12.

---

## 4 · The `epNN` references, re-measured for the copy

**Conclusion: of the 444 `epNN/` path references in the first repository's 83 tracked files, 292 in 59 files are in scope for the fresh-instance path, and only 32 in 8 files need an edit — the thirty `"ref"` values inside seven `tts-script.json` manifests, and the two `Episodes/ep01/script.md` addresses in `Canon/style-guide.md`. The other 260 are prose the `Canon/README.md:44-46` rule already covers.** The remaining 152 references in 24 files stay in the retired repository and are not Plan F's work at all.

### 4.1 The grep, re-run at `25bb3c6`

The inventory's grep, unchanged, run from the first repository's root:

    grep -rnoE '\bep(0[1-9]|10)/' --include='*.md' --include='*.json' --include='*.yaml' \
      --include='*.py' --include='*.ts' --include='*.tsx' --exclude-dir=node_modules \
      Canon Episodes Production prompts docs README.md showrunner.json package.json

**948 occurrences in 93 files; 83 of the 93 are tracked, with 444 occurrences; the other 10 are the git-ignored `Production/epNN/video/timeline.json` files with 504.** The inventory measured 443 tracked occurrences at `6b157b8`; the one additional occurrence is `Canon/style-guide.md:114`, added by the first repository's Plan G bible commit `499ba15` (`git diff 6b157b8..25bb3c6 | grep -E '^\+.*\bep(0[1-9]|10)/'` returns exactly that line).

### 4.2 The 444, grouped by whether the copy reaches them

| Group | Files | Occurrences | In scope for Plan F? |
|---|---|---|---|
| Files DeadLight2 **already holds** — `Canon/continuity-ledger.md` 40, `Canon/season-1.md` 12, `Canon/style-guide.md` 2, `Canon/technology.md` 2, `Canon/voice-registry.md` 1 | 5 | **57** | **Yes — an edit in place in DeadLight2, not a copy** |
| `Canon/season-2.md` | 1 | 1 | Yes — copied |
| `Canon/characters/` | 3 | 6 | Yes — copied |
| `Canon/locations/` | 2 | 2 | Yes — copied |
| `Canon/species/` | 1 | 1 | Yes — copied |
| `Episodes/ep01`–`ep10` | 14 | 59 | Yes — copied |
| `Production/ep01`–`ep10` | 31 | 163 | Yes — copied |
| `Episodes/ep98` | 2 | 3 | Yes, if `ep98` is carried |
| **In scope, total** | **59** | **292** | |
| `docs/superpowers/` and `docs/` | 17 | 65 | **No** — not carried |
| `Canon/season-desk-report.md` | 1 | 71 | **No** unless Ryan carries the desk |
| `prompts/draft.md` 2, `prompts/outline.md` 1, `prompts/tone-check.md` 1 | 3 | 4 | **No** if the generic set stays — the generic prompts carry **zero** `epNN` of any shape (`grep -rnoE '\bep(0[1-9]|10)\b' prompts/` in DeadLight2 returns nothing) |
| `Production/_archive/ep01-v2/tts-script.json` 6, `…/ep01-coldopen-v2/tts-script.json` 3 | 2 | 9 | **No** — not carried |
| `Episodes/_retired/ep99/outline.md` | 1 | 3 | **No** — not carried |
| **Out of scope, total** | **24** | **152** | |

### 4.3 The eight files that need an edit, with the reason

| File | References | What resolves the reference, at its address |
|---|---|---|
| `Production/ep01/tts-script.json` | 6 | `"ref": "Production/ep01/guest-refs/<slug>.wav"`. `scripts/tts-generate.py:38-39` `if not os.path.exists(c["ref"]): sys.exit(...)`; `scripts/validate-manifest.py:126-127` reports `cast <spk> ref not found` |
| `Production/ep07/tts-script.json` | 6 | same |
| `Production/ep03/tts-script.json` | 5 | same |
| `Production/ep03/tts-script.RESEG.json` | 5 | same |
| `Production/ep02/tts-script.json` | 3 | same |
| `Production/ep08/tts-script.json` | 3 | same |
| `Production/ep04/tts-script.json` | 2 | same |
| `Canon/style-guide.md` (**already in DeadLight2**) | 2 | `:3` `Canonical sample: \`Episodes/ep01/script.md\`.` and `:114` `the opening of ep01's cold open (\`Episodes/ep01/script.md:5-23\`)`. Three generic prompts send a writer to `` `## Register sample` of `Canon/style-guide.md` `` — `draft.md:8`, `revise.md:31`, `tone-check.md:5` |
| **Total** | **32** | |

**Two notes on the `Canon/style-guide.md` row, because it is the one that is load-bearing for a Season 2 run rather than for a Season 1 re-run.** First, `## Register sample` quotes the passage inline at `:116`, so the prompt reads the section and does not open the file — the address is a citation, not a dependency. Second, the address is wrong in DeadLight2 **today**, before Plan F does anything: `Episodes/ep01/script.md` does not exist there. If Season 1 is carried as `s01eNN` the correct address is `Episodes/s01e01/script.md:5-23`; if Season 1 is not carried at all, the address names no file in the repository and the quoted passage is the register's only form. Plan G's own deferred record flags the passage separately: "the Register sample (`Episodes/ep01/script.md:5-23`) stops one line before the rigger's callback that completes the beat" (`…deferred.md:29`).

### 4.4 The 260 references that do not break

**Every one is prose, and `Canon/README.md:44-46` in DeadLight2 already carries the rule that governs it, imported verbatim:**

> **`epNN` in prose always means Season 1, episode NN; new writing uses `SxEy` in prose and a production id only inside a file path.**

They fall into four kinds. **Bible prose citations** — 55 references in 4 files DeadLight2 already holds (`continuity-ledger.md` 40, `season-1.md` 12, `technology.md` 2, `voice-registry.md` 1) plus 10 in the carried entity sheets and `season-2.md`, all of the shape `` (`ep08/script.md:349`) `` or `` full premise `Episodes/ep08/launch-premise.md` ``. **Episode narrative cross-references** — 59 references in 14 `Episodes/epNN/` files, one episode's outline citing another's. **Human instruction sheets** — 133 references in 24 `Production/epNN/` files (§2.11), of the shape `**File:** \`Production/ep08/images/s01-….png\``. **The ep98 three** — `Episodes/ep98/outline.md` 2 and `Episodes/ep98/STATUS.md` 1, both pointing at Season 1 from a directory that keeps its own id.

**One sentence of the imported rule is now inaccurate on the fresh-instance path, and it is in `Canon/README.md:46`:** "Season 1 was produced under production ids (`ep01`–`ep10`) **that the cutover renames to aired slots** (`s01e01`–`s01e10`)". On the fresh-instance path nothing in the first repository is renamed; Season 1 is copied, and only if Ryan rules so. See A-20.

### 4.5 The completion check, re-scoped to DeadLight2

Spec §5.2's check is "a grep for stale `ep0N/` paths returning zero" (`docs/specs/2026-09-25-console-rewrite-design.md:138`). **Re-scoped to DeadLight2, that grep does not return zero today — it returns 57**, and all 57 are the imported prose of §4.2's first row:

    $ grep -rnoE '\bep(0[1-9]|10)/' --include='*.md' --include='*.json' --include='*.yaml' \
        --include='*.py' --include='*.ts' --include='*.tsx' --exclude-dir=node_modules --exclude-dir=video \
        Canon Episodes Production prompts README.md showrunner.json   # in DeadLight2
    57
    # files: Canon/technology.md, Canon/style-guide.md, Canon/voice-registry.md, Canon/season-1.md, Canon/continuity-ledger.md

**So on the fresh-instance path the inventory's F-14 grep cannot be the completion check as written.** The `--exclude-dir=video` the inventory's F-14 demands is still needed — `grep -r` reaches ignored files, and DeadLight2's `.gitignore:3` ignores `Production/*/video/` under both id shapes — but the check itself must be a *delta* against the 57, or must exclude the five imported bible files by name, or must be narrowed to the two reference kinds §4.3 names. See A-22.

---

## 5 · The old repository's retirement

**Conclusion: the first repository stays exactly as it is, 20 GB on disk and 349 tracked files outside the carry set, and console v1 keeps working from it without a single edit — because v1 resolves every path inside that repository and never reads `showrunner.json`'s `airMap` at all.** The only decision the retirement forces is the GitHub name (§5.4).

### 5.1 The repository, sized

| Quantity | Figure |
|---|---|
| On disk, excluding `.git` | **20 GB**; `.git` is a further 849 MB |
| Tracked files | **799**, 1.12 GB |
| Git-ignored files | **25,830**, 18.18 GB |
| Commits | **476**, rooted at `f73609b` (2026-07-09, `Initial File Upload`) |
| GitHub remote | `origin https://github.com/MrMophandle/DeadLight.git` |

### 5.2 What stays behind by design

**349 tracked files and roughly 3.4 GB of ignored trees are outside the carry set.** Note one correction to the inventory's framing: the carry set's ignored content is **14.85 GB**, not the inventory's 13.20 GB, because the ignored halves of `Production/ep98` (1,621.57 MB) and `Production/ep99` (98.27 MB) join Season 1's 13.20 GB. **Essentially all of `Production/`'s ignored content moves, not stays** (`git ls-files --others --ignored --exclude-standard Production | wc -l` → 6,947 files, 14.85 GB; the carry set holds 6,946 of them).

| Tree | Size | Tracked files | Why it stays |
|---|---|---|---|
| `console/` — console v1 | **109 MB** | **91** (21,643 lines of `.ts`/`.tsx` across 84 files, plus 2,233 lines of CSS) | It is the thing still running (§5.3) |
| `.archon/` | 1.3 MB | **35** (five workflow YAMLs, 2,167 lines; 29 Python files, 5,000 lines) | Console v1 shells four of its scripts and parses its workflows (§5.3); spec §7.4 rules the workflows deleted rather than moved |
| `remotion/` | **2.8 GB** | 6 | Replaced by the engine's `render/`. `remotion/public/` alone is **2.3 GB** in twelve staging directories named `ep01`–`ep10`, `ep98`, `ep99`; `remotion/node_modules/` is 505 MB |
| `.agent-logs/` | **496 MB**, 27 entries, 15 named with an `epNN` | 0 (git-ignored, `.gitignore:2`) | Archon and console-v1 run logs. The engine's equivalent is `Production/<id>/runs/<run-id>.jsonl` (`main:engine/src/events.ts:24`) |
| root `package.json` | 7 lines | 1 | Both its scripts point into `console/` |
| `prompts/index.json` + the 7 desk prompts + the 34 first-show prompt bodies | — | 42 | The generic set replaces them (§2.15); `index.json` is 883 lines and nothing reads it |
| `Canon/season-desk-report.md` | 0.03 MB | 1 | A generated artifact of the deferred desk, carrying 71 `epNN/` references |
| `Production/_archive/` | 39.85 MB | **81** | Nothing in the engine reads it; two of its manifests carry `"episode": "ep01-v2"` / `"ep01-coldopen-v2"` |
| `Production/casting-samples/` 25 tracked, 17.61 MB; `Production/ep01/casting-samples/` 10 tracked | — | 35 | Voice-design scratch |
| `Episodes/_retired/ep99/` | 0.06 MB | 3 | Already retired; outside `listEpisodeIds`' one-level scan |
| `docs/` | — | 21 files reference the leaving trees, 349 times | The historical record. `docs/console-redesign-brief.md` (211 lines) is the one live document that describes `console/` and `.archon/workflows/` as ground truth (the inventory's F-20) |
| `.superpowers/` 3.0 MB, `.playwright-mcp/` 164 KB, `.pytest_cache/` 32 KB | 3.2 MB | 0 | Scratch, all git-ignored |
| **`Finalized`** | a symlink | 0 | **It is a symlink, not a directory: `Finalized -> /Volumes/media/DeadLight`**, created 2026-07-20, git-ignored twice (`.gitignore:12` `Finalized/` and `:14` `Finalized`). `/Volumes/media` does not exist at measurement time (`ls /Volumes/` → `com.apple.TimeMachine.localsnapshots`, `Macintosh HD`, `TimeMachine`), so the link is dangling until Ryan remounts the NAS by hand |

**Nothing on the NAS changes, and nothing needs to.** `output.nasMount`, `output.nasRoot`, `output.finalFilename` and `output.mixFilename` are **byte-identical in both repositories** (§1.2's leaf diff found zero differing values), so DeadLight2 names the same `/Volumes/media/DeadLight/DeadLight S01E01.mp4` the first repository does. Whether DeadLight2 gets its own `Finalized` symlink is a convenience, not a dependency: the engine resolves the NAS from `output.nasRoot`, not from the link.

### 5.3 What console v1 needs to keep running, and what it does not

**It is running.** `lsof -i :4400` returns `node 3353 ryanperkowski 22u IPv4 … TCP *:ds-srv (LISTEN)` and `lsof -i :5183` returns `node 25817 … TCP *:5183 (LISTEN)`. Ports 4410 and 5193 — the engine's console — have no listener. `console/server/index.ts:1074` is `const port = 4400`; `console/package.json:6` runs `vite --port 5183`; `console/vite.config.ts:13-15` proxies `/api`, `/media` and `/events` to `http://localhost:4400`.

**What v1 reads, with addresses.**

| Dependency | Address |
|---|---|
| `.archon/workflows/<name>.yaml` | `console/server/archon.ts:207` `fs.readFileSync(path.join(root, ".archon/workflows", candidate), "utf-8")` |
| `.archon/scripts/season-status.py` | `console/server/board.ts:4`, `:67`, `:86` |
| `.archon/scripts/nano-banana-generate.py`, `image-generate.py`, `registry-append.py` | `console/server/actions.ts:55`, `:59`, `:64`, `:72`, `:75`, `:93`; `console/server/discuss.ts:420` |
| **its air map** | `console/server/repo.ts:110` `readFileIfExists(path.join(root, ".archon/scripts/finalize-video.py"))`, parsed with `console/server/repo.ts:46` `const SEASON_MAP_ENTRY_RE = /"(ep\d+)":\s*\((\d+),\s*(\d+)\)/g;` |
| the season document's RULED rows | `console/server/repo.ts:45` `SEASON_ROW_RE`, over `Canon/season-1.md` |
| `Episodes/epNN/` and `Production/epNN/` | `console/server/repo.ts:47` `const EPISODE_DIR_RE = /^ep\d+$/;` and `:126` |

**Two measurements make the retirement free.** First, **console v1 never reads `showrunner.json` at all for the air map** — it regex-parses a Python source file (`repo.ts:110`), so whatever either repository's `airMap` says is invisible to it. Second, **every path v1 resolves is inside the first repository**, so nothing Plan F writes into DeadLight2 can reach it. **The inventory's F-04 — "the side-by-side window closes at the rename, not at v1's deletion" — is void: there is no rename, and the window closes when Ryan stops the process.**

**What would end it.** Deleting or editing `.archon/scripts/finalize-video.py` (v1 loses its air map and shows an empty board), deleting `.archon/workflows/` (v1 loses its node lists), renaming `Episodes/epNN` or `Production/epNN` (all eleven of v1's id regexes are `/^ep\d+$/`-shaped and match no aired id), or stopping the two processes. **Plan F does none of those on the fresh-instance path.**

### 5.4 The GitHub side

**What exists.** `gh repo view MrMophandle/DeadLight --json …` returns `{"createdAt":"2026-07-09T15:25:08Z","defaultBranchRef":{"name":"main"},"diskUsage":771852,"isPrivate":true,"name":"DeadLight","pushedAt":"2026-10-04T13:33:01Z","visibility":"PRIVATE"}` — private, ≈754 MB, default branch `main`, pushed the morning of 2026-10-04. `gh auth status`: logged in as `MrMophandle`, scopes `gist, read:org, repo, workflow`. `gh repo list MrMophandle --limit 20` lists twenty repositories and **there is no `DeadLight2`**, so that name is free. DeadLight2 has **no remote at all**.

**One fact that bounds every option: the two histories share no commit.** DeadLight2 is rooted at `b706239` (2026-10-04) and the first repository at `f73609b` (2026-07-09); DeadLight2's seventeen commits were made by `init`, not branched from anything.

**The options, with their exact commands. None of these was run.**

| Option | Commands |
|---|---|
| **(a) Two repositories, new name for the new instance.** The first repository keeps `MrMophandle/DeadLight`; DeadLight2 gets its own | `gh repo create DeadLight2 --source /Users/ryanperkowski/GitHub/DeadLight2 --private --push`<br>(`gh repo create --help`: "To create a remote repository from an existing local repository, specify the source directory with `--source`. By default, the remote repository name will be the name of the source directory." — so the name argument may be omitted and `DeadLight2` is what it would pick) |
| **(b) Rename the old repository, give its name to the new instance.** The canonical name follows the live show | `gh repo rename -R MrMophandle/DeadLight DeadLight-v1 --yes`<br>then `gh repo create DeadLight --source /Users/ryanperkowski/GitHub/DeadLight2 --private --push`<br>then, in the retired checkout, `git remote set-url origin https://github.com/MrMophandle/DeadLight-v1.git` — because `gh repo rename` changes the remote repository and the local `origin` URL keeps pointing at the old address until it is reset. `gh repo rename --help` adds: "To transfer repository ownership to another user account or organization, you must follow additional steps on github.com" (not needed here — same owner) |
| **(c) A third name for the new instance**, leaving both the old name and `DeadLight2` unused | `gh repo create <name> --source /Users/ryanperkowski/GitHub/DeadLight2 --private --push` |
| **(d) One repository, two branches.** Not a `gh` command: `git -C /Users/ryanperkowski/GitHub/DeadLight2 remote add origin https://github.com/MrMophandle/DeadLight.git` then `git push -u origin main:<branch>`. **The two histories share no commit, so this creates an unrelated branch in the same repository**, and `main` there would still be the retired tree |

**`gh repo create` takes `--private`, `--public` or `--internal` and one is required for a non-interactive create** ("To create a remote repository non-interactively, supply the repository name and one of `--public`, `--private`, or `--internal`"). The existing repository is private, so `--private` matches it. Plan G's `init` already prints a `gh repo create <slug> --source <root> --push --<visibility>` line when `gh` is absent or signed out (`docs/plans/2026-10-03-the-new-show-setup-deferred.md:9`) — **the command is the same one, and the choice Ryan has to make is only the name.**

---

## 6 · The engine-side items, re-checked on the fresh-instance path

**Conclusion: nine of the fifteen items the inventory assigns to Plan F touch the engine regardless of which cutover path is taken; three are paid for free by the fresh-instance path; one is void; and two change their terms.** Every address below is read on `main` at `4f4b949`.

| Item | Applies? | Measured state, and why |
|---|---|---|
| **F-03** — the engine change that must follow the rename | **No — void.** Path-dependent | The inventory's F-03 is "emptying `airMap` is the one step that must come after the show's rename", because `scripts/publish-kit.py:106` (`season, episode = sc.season_of(cfg, ep)`) exits and `scripts/finalize-video.py:129` refuses an unmapped `epNN`. On the fresh-instance path the first repository keeps its ten entries and DeadLight2's `showrunner.json:14` is already `{}`. **Nothing is emptied and nothing is sequenced.** Touches the engine: **no** |
| **F-10** — `ep98`/`ep99` on the Board | **Yes, with its terms changed.** Path-dependent | DeadLight2 holds neither directory, so `main:engine/src/episodes.ts:18` returns no row for either and there is **no live-looking `NEEDS_IDEA` row to suppress** — the inventory's three options (a marker, a `retired` flag, deletion) all become moot for the Board. **What survives is the exercise:** `main:engine/test/ep98-exercise.test.ts:31` pins `const EP = "ep98";` and `:35` takes `SHOWRUNNER_SHOW_ROOT` from the environment with no default, so the engine's only real-script exercise needs *some* repository holding `Production/ep98/`'s 1.62 GB. Touches the engine: **only if `ep98` moves** — and then not the test's id, only which root the operator exports |
| **F-11** — `scripts/season-status.py` reports a wrong board silently | **Yes, unchanged.** Path-independent | Both files are still on `main`: `scripts/season-status.py` (275 lines) and `scripts/tests/test_season_status.py` (478 lines), **753 lines with no caller in the engine**. Against DeadLight2 it would be worse than wrong — `prod_id_for(air, {})` returns the literal `ep01`, a directory DeadLight2 does not have under any ruling. Its only ever caller was console v1's `console/server/board.ts:4,67,86`, which shells **the show's own `.archon/scripts/season-status.py`, not the engine's**. Touches the engine: **yes, regardless of path** |
| **F-12** — what `s02e01` needs before its first run | **Yes, with one file added.** Path-dependent | Plan G inserted `bible-ready` between `previous-episode` and `premise` (`main:engine/src/pipelines/episode.ts:162-175`), and `bible-check --show DeadLight2 --season 2` names `Canon/season-2.md` missing (§1.4). So the first Season 2 run in DeadLight2 is gated on **two** hand-placed files, `Canon/season-2.md` and `Episodes/s02e01/premise.md`, not on one. `main:engine/src/pipelines/episode.ts:181` is still `NEEDS_IDEA: write ${premise}`. The six `launch-premise.md` files remain unread by anything. Touches the engine: **no** |
| **F-14** — the completion grep | **Yes, re-scoped.** Path-dependent | The grep's exclusions are still needed (DeadLight2's `.gitignore:3` ignores `Production/*/video/` but `grep -r` reaches ignored files), and the baseline is no longer zero: **57 occurrences in 5 imported bible files** in DeadLight2 today (§4.5). Touches the engine: **no** |
| **F-17** — `scripts/check_layout.py` | **Yes, unchanged.** Path-independent | Still on `main` (59 lines, plus `scripts/tests/test_check_layout.py` at 55) with no caller. `scripts/check_layout.py:40` is `glob.glob(os.path.join(episodes_dir, "ep*"))` — against DeadLight2 it matches **nothing at all**; `:21-22` still reports `STATUS.md missing` as an issue, which becomes true for every episode once the stamps retire. Touches the engine: **yes, regardless of path** |
| **F-21** — hardcoded `Production/` literals | **Yes, unchanged, and the count holds.** Path-independent | Measured on `main`: **18 scripts with 27 f-string sites** that build a path from the literal `Production/` — `audio-mix.py:54`, `breath-qc.py:113`, `build-timeline.py:104`, `canon-diff.py:67`, `finalize-video.py:52,55,135,136`, `image-generate.py:75`, `image-qc.py:60,62`, `image-sheet.py:73,102`, `master-video.py:73`, `nano-banana-generate.py:430`, `pace-qc.py:51`, `populator-check.py:71`, `publish-kit.py:103,104,108,189`, `registry-append.py:122`, `shot-sheet.py:47,160`, `truncation-qc.py:155`, `tts-generate.py:77`, `validate-manifest.py:75` — plus 8 docstring mentions in 8 files. Invisible for both shows: `showrunner.json:7` is `"productionDir": "Production"` in both. Touches the engine: **yes, regardless of path** |
| **F-22** — `npm audit` | **Yes, unchanged.** Path-independent | `npm audit --json` on the engine returns `{"info":0,"low":0,"moderate":5,"high":1,"critical":1,"total":7}` — `vitest` **critical** (GHSA-5xrq-8626-4rwp), `vite` **high** (GHSA-fx2h-pf6j-xcff and two more), `react-router` and `react-router-dom` moderate (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg, range `6.0.0 - 7.17.0`), and `@vitest/mocker`, `esbuild`, `vite-node` moderate. `console/package.json:20` still pins `react-router-dom: ^6.26.0` as a `dependencies` entry, so the inventory's F-22 reading holds exactly. Touches the engine: **yes, regardless of path** |
| **F-23** — `prompts/audio-gate.gate.md`'s air-named glob | **No — paid.** Path-dependent | `main:tools/templates/prompts/audio-gate.gate.md:2` is `{{show.productionDir}}/{{episodeId}}/audio/*.wav  ({{results.audio-mix}})` and DeadLight2's copy is byte-identical. The glob `Production/{{episodeId}}/audio/DeadLight *.wav` survives only at `/Users/ryanperkowski/GitHub/DeadLight/prompts/audio-gate.gate.md:2`, in the retired repository. **O-16, O-20 and F-23 are closed by the generic template** — if the generic set stays (A-03). Touches the engine: **no** |
| **F-24** — `STATUS.md` in the walk test | **Yes, unchanged, at moved addresses.** Path-independent | `main:engine/test/episode-pipeline.test.ts:317` `expect(await readFile(path.join(root, "Episodes/s02e01/STATUS.md"), "utf8")).toContain("stamp-finalized")`; `:50` the `assemble-commit` dependency assertion; `:102` finds `stamp-outline`. The inventory's `:268`, `:41`, `:53-54` moved because Plan G inserted `bible-ready`. Touches the engine: **yes, regardless of path** |
| **Retirement — the six `stamp` steps** | **Yes, unchanged, at moved addresses.** Path-independent | All six still on `main`: `stamp-outline` `:211`, `stamp-script` `:248`, `stamp-casting` `:274`, `stamp-audio` `:285`, `stamp-images` `:340`, `stamp-finalized` `:372` (the inventory's `:195, 232, 258, 269, 324, 356`). `:378`'s `assemble-commit` still depends on `stamp-finalized` and still lists `status` among its paths. Touches the engine: **yes, regardless of path** |
| **Retirement — `scripts/status.py`, `season-status.py`, `check_layout.py`** | **Yes, unchanged.** Path-independent | All three on `main`; `git ls-tree main --name-only scripts/ \| grep -c '\.py$'` returns **26**, so `main:README.md:608`'s "twenty-six Python programs" still reads true and still changes when three go. `scripts/status.py`'s only production caller is the stamp helper at `main:engine/src/pipelines/episode.ts:106`. Touches the engine: **yes, regardless of path** |
| **Retirement — `prompts/index.json`** | **No — paid.** Path-dependent | `/Users/ryanperkowski/GitHub/DeadLight/prompts/index.json` is 883 lines; `ls /Users/ryanperkowski/GitHub/DeadLight2/prompts/index.json` → `No such file or directory`. **O-19 is closed by not copying it**, and the `prompts/README.md` sentence the inventory said would need editing is already gone: DeadLight2's `prompts/README.md` is 15 lines against the first repository's 25, and is the engine's template. Touches the engine: **no** |
| **Retirement — `EventLog.logPath`'s default** | **Yes, unchanged.** Path-independent | `main:engine/src/events.ts:24` `static logPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production")`, with `:22-23` recording why. Benign for both shows, which both set `productionDir: "Production"`. Touches the engine: **yes, regardless of path** |

**Which touch the engine regardless of which cutover path is taken: F-11, F-17, F-21, F-22, F-24, the six stamp steps, the three Python retirements, and `EventLog.logPath`'s default — nine items.** None of them is blocked by the cutover and none of them blocks it, which means Plan F can ship the engine hygiene and the copy in either order.

---

## 7 · Findings

Each finding names what was measured and the question Plan F's author must answer. Twenty-four, numbered `A-01` onward so they never collide with the inventory's `F-nn`.

| # | Finding | Question for Plan F |
|---|---|---|
| **A-01** | **Season 1's id shape is the whole of §3's answer, and the measurement says `s01eNN` works and `epNN` does not.** Copied as `s01e01`…`s01e10` with their ten `archive.json` markers, the Board shows ten rows at stage COMPLETE, status `archived`, each with its note, needs emptied and no launch button — the full chain is `main:console/server/runs.ts:373-374` → `main:console/server/episodes.ts:78`, `:89-97`, `:127-130` → `main:console/src/pages/Board.tsx:189-190`, and `isStage("COMPLETE")` is true at `main:engine/src/stages.ts:17`. Copied as `ep01`…`ep10` with `airMap: {}`, the rows look the same but sort **after** every Season 2 row (`main:engine/src/ids.ts:73`), the canon spine carries no season document (`main:engine/src/pipelines/episode.ts:77,82`), and **two generic prompts cannot render at all** — measured: `outline.md` and `canon-review-outline.md` both fail with `{{season}}: season is not available`. | **Is Season 1 carried into DeadLight2 as `s01e01`…`s01e10`, or left in the retired repository?** The measurement closes the middle option: `epNN` in DeadLight2 is a shape the generic prompts cannot run. If Season 1 is carried, carry the markers unedited — none contains an id. If it is left behind, say so explicitly, because the generic `draft.md:7,20`, `revise.md:30`, `repetition-check.md:9` and `tone-check.md:4` all glob `Episodes/*/script.md` for the register and would find nothing |
| **A-02** | **The two `.gitignore` files disagree in sixteen rules, and the disagreement silently changes what the copy commits in both directions.** Measured with `git -C DeadLight2 check-ignore --no-index --verbose` over the carry set: **34 currently-tracked files would arrive ignored** (every PNG under `Canon/_candidates/`, by DeadLight2's `.gitignore:7`) and **914 currently-ignored files, 0.61 GB, would arrive tracked** (`Production/ep10/audio-v1-prepause/segments` 524, `Production/ep01/audio-v1-predensity/segments` 382, and 8 more), because DeadLight2's ten rules lack `Production/*/audio-v1-*/`, `Production/*/audio-spike/` and `Production/*/notes/*.draft.md`. | **Reconcile `.gitignore` before the copy, not after.** Which of the first repository's sixteen extra rules does DeadLight2 take? The three audio/notes rules are needed by the copy; `console/*`, `remotion/*` and `.agent-logs/` are not. **And `Canon/_candidates/` is a straight contradiction (A-05) that must be decided in the same edit** |
| **A-03** | **The generic prompt set already pays three of the inventory's findings, and the first repository's set already carries one law the bible now holds twice.** DeadLight2's 43 prompt files are byte-identical to `main:tools/templates/prompts/`, all 34 bodies render against DeadLight2's own config (`check-prompts` exit 0), and the generic versions close F-08 (the `Episodes/ep01/…` exemplars become `Episodes/*/script.md` plus `` `## Register sample` ``), F-23/O-16/O-20 (`audio-gate.gate.md:2` globs `*.wav`), and Plan G's two broken `Episodes/ep*/script.md` globs. **But the first repository's 41 bodies carry what the generic ones traded away:** the ep09 size measurement at `prompts/outline-gate.reject.md:1-9` (the law itself moved to `Canon/episode-formula.md:8` in both repositories), the ep03/ep04 worked example at `prompts/repetition-check.md:35-39`, the named role dynamics at `prompts/character-check.md:22-27`, and the vacuum vocabulary at `prompts/environment-check.md:20-37` (that law moved to `## Environment rules` of `Canon/technology.md`, which the import carried). **Seven desk prompts and `index.json` exist only in the first repository, and the four desk prompts do not render under the engine's context at all.** | **Does the generic set stay in DeadLight2, or do the first repository's thirty-four bodies replace it?** The measurement favours the generic set: the moved laws are in the imported bible, the Register sample is in `Canon/style-guide.md:113-116`, and `check-prompts` passes. The cost of keeping it is the lost worked examples and the Harbor Lights residue (A-06). **If the generic set stays, the first repository's three `Episodes/ep01/…` references and its air-named audio glob never need an edit, because they stay behind — which is why §4's edit list is eight files and not eleven** |
| **A-04** | **DeadLight2 names nine recurring characters and holds a sheet for none of them, and the reason is on disk.** `showrunner.json:42-52` lists `narrator, Sarn, Sable, Trent, Opha, Cricket, Remo, Mute, Ilvaren`; `Canon/characters/` holds only `_TEMPLATE.md`. **`Production/setup/world-overview/answers.md` is three lines and its one answer is the literal `(blank)`**, so `init` wrote no sheets and left `audio.mainCast` as `["narrator"]` until `c74ec70` added the nine names by hand. The generic `prompts/character-check.md:10-11` globs `Canon/characters/**/*.md` and would find the template alone. | **The thirteen sheets are not optional if a Season 2 episode is to be reviewed.** Carry all thirteen, or the eleven of recurring cast? The measurement: thirteen sheets exist across seventeen directories, and four directories (`Marle`, `Millies-Bite`, `Mink`, `Wella`) hold stills with no sheet |
| **A-05** | **One of `Canon/refs.json`'s 21 reference images lives inside `Canon/_candidates/`, and DeadLight2's `.gitignore:7` ignores that directory.** All 21 `ref` paths resolve in the first repository (`missing: 0`), and `relic` resolves to `Canon/_candidates/relic-2.png`. The intended workflow says the directory is scratch — `scripts/design-visual.py:25-26` writes candidates there and "locking is manual: copy the chosen candidate into `<visual.castingPileDir>`" — and `main:engine/src/show-config.ts:94` names that script as the key's only reader. But `main:engine/src/needs.ts:98` tests the **filesystem**, so an ignored-but-present `relic-2.png` passes `missingRefs` and then disappears on the first clone of DeadLight2. | **Three ways out, and Plan F must pick one: (a) carry the 34 PNGs and drop `Canon/_candidates/` from DeadLight2's `.gitignore` (21.96 MB tracked, the first repository's own state); (b) carry `relic-2.png` alone, copied to a tracked path, and re-point `Canon/refs.json`'s `relic.ref` at it (one file, one JSON edit — which also makes the show's reference set obey its own documented workflow); (c) carry nothing and accept that `relic` has no image.** Option (b) is the only one that leaves both the `.gitignore` rule and the workflow intact |
| **A-06** | **The generic prompt set and two generic templates carry eleven lines of Harbor Lights into DeadLight2, and one of them is a path.** `prompts/environment-check.md:28-29` names `Canon/characters/The Warden/the-warden.md`; `prompts/outline.md:89-91` gives `- Vale (recurring, speaks)`, `- the Warden (recurring, speaks)`, `- Harbormaster Quill (guest, speaks)`, `- Harbor (location)` as the cast grammar's examples; `prompts/visual-direction.md:47` and `prompts/flow-check.md:26` and `prompts/tts-script.md:59` name Vale, Pim and Maeve; `Canon/characters/_TEMPLATE.md:34-35` names `quiet-Vale, still-Pim, unhurried-Maeve`; `Episodes/_TEMPLATE/outline.md:11-12` is `- Vale (recurring, speaks)` and `- Harbor (location)`. | **Are the eleven lines re-pointed at Dead Light's own cast, or left as the engine's worked examples?** The measurement that bears on it: only `environment-check.md:29` is a path, and it names a directory DeadLight2 does not have, so an agent following it gets a `Read` failure. The other ten are illustrative text. **If they are re-pointed, DeadLight2's prompts stop being byte-identical to `main:tools/templates/prompts/` and the engine's template harness no longer covers them** |
| **A-07** | **The character sheets' section heading is the one rename the copy has to make, or the generic auditor reads nothing.** Twelve files under `Canon/characters/` carry `## Dark-forest stance` — eleven sheets (`Ansa`, `Cricket`, `Ernie Grother`, `Ilvaren`, `Mardo`, `Opha`, `Remo`, `Sable`, `Sarn`, `Trent`, `Vrask`) and `_TEMPLATE.md`. The generic auditor reads `- **Stance toward the central mystery**:` (`/Users/ryanperkowski/GitHub/DeadLight2/prompts/character-check.md:26`) against the first repository's `- **Dark-forest stance**:` (`prompts/character-check.md:23`). `main:engine/src/bible.ts`'s `headingMatches` is a whole-word **prefix** match, so `## Dark-forest stance` does not satisfy `## Stance toward the central mystery` under any reading. Two of the thirteen sheets — `The Mute/the-mute.md` and `The Vanished/the-vanished.md` — carry neither heading. | **Are the eleven sheets renamed to `## Stance toward the central mystery` at the copy, and `_TEMPLATE.md` left as the generic one DeadLight2 already holds?** The alternative is to re-point the generic prompt instead, which reverses A-03. **Note the asymmetry: `Canon/species/_TEMPLATE.md:17-18` has the same problem (`## Relationship to the dark forest / the Vanished` against `## Relationship to the central mystery`) and the species sheets are not on `REQUIRED_SECTIONS`, so nothing checks them** |
| **A-08** | **`airMap` holds nothing in DeadLight2 if Season 1 arrives as `s01eNN`, and that is not a choice — the loader refuses the alternative.** `main:engine/src/show-config.ts:165-167` throws `airMap.<id> must be a production id (epNN)` for any aired key, and `main:engine/src/show-config.ts:212-218`'s `seasonOf` reads an aired id's season off the id and never consults the map. `main:tools/src/init/config.ts:43-47` states the ruling: "A show that starts at `s01e01` therefore has nothing it could legally or usefully put there." `scripts/lib/showconfig.py:120-128` mirrors the refusal. | **Nothing to decide if Season 1 arrives as `s01eNN`: `showrunner.json:14` stays `"airMap": {}` and the file needs no edit at all.** If Season 1 arrives as `epNN` instead, the ten entries must be copied back from the first repository's `showrunner.json:14-55`, and A-01's two broken prompts are the price. **Say which in the plan, with this reason, so nobody tries to add `s01e01: [1,1]` and gets a load error** |
| **A-09** | **The guest references are 54 WAVs in six of the ten episodes, and their thirty paths are the only machine-read `epNN` references the copy carries.** `ep01` 18 (5.43 MB), `ep02` 6, `ep03` 8, `ep04` 4, `ep07` 12, `ep08` 6 — 18.14 MB tracked, plus 2 ignored on disk. `ep05`, `ep06`, `ep09`, `ep10` have no `guest-refs/` at all. The thirty `"ref": "Production/epNN/guest-refs/<slug>.wav"` values inside seven `tts-script.json` manifests are resolved by `scripts/tts-generate.py:38-39` and `scripts/validate-manifest.py:126-127`, both of which exit on a miss. The reader of the directory itself, `main:engine/src/needs.ts:77`, hardcodes `guest-refs` rather than reading `audio.guestRefsDir` (`main:engine/src/show-config.ts:88` records that). **The inventory's §1.1 figure of 64 WAVs does not reproduce; today's is 54.** | **Carry the 54, and edit the thirty `"ref"` values if the directories are renamed — or carry the 54 and leave the manifests stale?** The measurement: nothing re-runs a Season 1 episode's audio, so a stale `"ref"` costs nothing until someone does, at which point the script exits with the path it could not find. **Thirty one-line JSON edits in seven files is the whole cost of making it correct** |
| **A-10** | **`Canon/season-2.md` is the one file whose absence stops a run by name, and `bible-check` says so.** `node tools/dist/bible-check.js --show /Users/ryanperkowski/GitHub/DeadLight2 --season 2` exits 1 with `1 bible file(s) missing or empty: Canon/season-2.md`; `--season 1` exits 0. `main:engine/src/pipelines/episode.ts:162-175`'s `bible-ready` guard fails a run with `BIBLE_INCOMPLETE: <list>` **before** the `premise` guard the inventory's F-12 names. The file is 1 tracked file, 35,528 bytes, 139 lines, with `## Season laws` at `:24` and `## The slate` at `:66` — the two sections `main:engine/src/bible.ts:83-84` requires — and 3 RULED plus 17 DRAFT slate rows. | **Carry it first, and name it in the plan as the gate on the first Season 2 run.** Its one `epNN/` reference (`:70`, `` (`ep10/script.md:389`) ``) is prose. **`Canon/season-desk-report.md` is the other file the import did not bring; it carries 71 `epNN/` references and nothing in the engine reads it — carry or leave?** |
| **A-11** | **The voice references are complete and self-consistent in the first repository and entirely absent from DeadLight2.** Nine cast entries, every one with a `status` containing `LOCKED` and a `ref` WAV that exists; the nine keys match `audio.mainCast`'s nine values exactly. 10 tracked files, 5.46 MB. DeadLight2 holds the scaffold: `"cast": {}` and no WAVs. The reader is `main:engine/src/needs.ts:111`, `if (!status.includes("LOCKED")) missing.push(…)`, with `:112` then testing the WAV. `main:engine/src/pipelines/episode.ts:266` declares `${voiceRefsDir}/refs.json` an input of the `tts-script` step. | **None — carry all ten files.** Recorded because the tree carries zero `epNN` paths and therefore needs no edit at all, which makes it the cheapest item in the whole copy. **The open half is whether `Production/casting-samples/` (25 tracked, 17.61 MB) and `Production/ep01/casting-samples/` (10 tracked) come too; nothing in the engine reads either** |
| **A-12** | **An empty `runs/` directory fails the `previous-episode` guard where an absent one passes, and the first repository has one.** `main:engine/src/pipelines/episode.ts:152` is `if (!(await isDir(dir))) return { pass: true, message: \`${prev} has no run logs (archive)\` }` — the test is `isDir`, not "holds a `.jsonl`". An **empty** `runs/` directory makes `isDir` true, the loop at `:153-157` finds no completed run, and `:158` returns `<prev> has not completed its canon update (rule 1.3); finish it first`. **`Production/ep98/runs/` exists and holds zero entries** (`ls -la` → `total 0`), left by the ep98 exercise's own cleanup. No Season 1 episode has a `runs/` directory. | **State in the plan that the copy must not create `Production/s01eNN/runs/`** — not even empty, not even as a placeholder. A `cp -R` that copies directory structure would create exactly this, and it would break `s01e02` through `s01e10`'s guard. **`s02e01` is immune either way: `:149` returns before `prev` is computed (A-13)** |
| **A-13** | **`s02e01`'s `previous-episode` guard requires nothing of `s01e10`, and an archived episode with no run logs satisfies the guard anyway.** `main:engine/src/pipelines/episode.ts:149` is `if (id.kind !== "aired" \|\| id.episode === 1) return { pass: true, message: "no previous episode to wait for" };` — `s02e01` has `id.episode === 1`, so the guard returns before `formatAired(id.season, id.episode - 1)` at `:150` is ever evaluated. It would not look for `s01e10` even if Season 1 were absent. O-15 is confirmed at its address on `main`, and `main:engine/src/pipelines/episode.ts:144-146`'s own comment states the archive rule. | **Nothing to decide; recorded so Plan F does not sequence Season 1's copy before the first Season 2 run on the belief that the guard needs it.** Season 1's copy and the first Season 2 run are independent, which also means the inventory's F-13 ("does Plan F include the first run, or hand it off?") stays open on exactly the same terms |
| **A-14** | **Eight files, 32 references, need an edit in the copy; the other 260 in-scope references are prose the imported `Canon/README.md:44-46` rule covers.** The eight: `Production/ep01/tts-script.json` (6), `ep07` (6), `ep03` (5), `ep03/tts-script.RESEG.json` (5), `ep02` (3), `ep08` (3), `ep04` (2) — all `"ref"` values two Python steps resolve — and `Canon/style-guide.md` (2, at `:3` and `:114`, both naming `Episodes/ep01/script.md`), which DeadLight2 already holds. The 260 split as 65 bible prose citations, 59 episode cross-references, 133 human instruction-sheet paths and 3 in `Episodes/ep98`. **The 152 remaining references in 24 files stay in the retired repository.** | **Edit the eight, and say in the plan that the 260 are deliberately not swept, with `Canon/README.md:44-46` as the authority.** `Canon/style-guide.md`'s two are the only ones a Season 2 run touches: three generic prompts send the writer to `` `## Register sample` of `Canon/style-guide.md` ``, whose `:114` names a file DeadLight2 does not have **today, before Plan F does anything** |
| **A-15** | **The two outline templates are different documents, and DeadLight2's is the one the generic prompts read.** The first repository's `Episodes/_TEMPLATE/outline.md` is 32 lines with sections (`## Status`, `## Premise`, `## Beat outline`, `## Script`, `## Image / slideshow prompts`, `## Publish package`, `## Post-episode canon updates`) of which **not one** is read by the generic `outline.md` prompt. DeadLight2's is 26 lines with `## Scene synopsis`, `## Arc beats`, `## Cast`, `### Beat <n>`, `## Ending duties`, `## Threads opened`, `## New canon proposed` — the sections `outline-gate.gate.md:6`, `character-check.md:8`, `structure-check.md:19,22` and `main:engine/src/needs.ts:64` read by name. Plan G's deferred record names the defect it fixes (`…deferred.md:27`). | **Keep DeadLight2's and do not copy the first repository's.** Recorded because a blanket `cp -R Episodes/` would overwrite it. **Its two Harbor Lights cast lines at `:11-12` are an A-06 item** |
| **A-16** | **None of the ten Season 1 outlines carries a `## Cast` section, so `missingRefs` returns an empty list for them for a reason unrelated to the references being present.** `grep -l '^## Cast' Episodes/ep*/outline.md` returns nothing; `main:engine/src/needs.ts:63-65` returns `[]` when the section is absent — "the section's absence is the canon reviewer's finding, not this probe's" (`:57-59`). Three of the ten carry `## Scene synopsis`; eight each carry `## Arc beats`, `## Ending duties`, `## Threads opened` and `## New canon proposed`. **The archive marker empties `needs` regardless (`main:console/server/episodes.ts:129`), so the Board never shows this.** | **Nothing to decide if Season 1 is only ever archived.** The question only opens if a Season 1 episode is ever re-run in DeadLight2, at which point its outline fails the generic `outline-gate`'s `## Scene synopsis` read and its `missingRefs` probe silently checks nothing. **Say in the plan that the carried Season 1 outlines are archive artifacts, not runnable inputs** |
| **A-17** | **`ep98` is load-bearing for the engine and for nothing else, and the fresh-instance path makes the engine choose a repository.** `main:engine/test/ep98-exercise.test.ts:31` pins `const EP = "ep98";`, and `:33-35` takes the show root from `SHOWRUNNER_SHOW_ROOT` **with no default**, because "nothing under `engine/` may name a show". It needs `Production/ep98/`'s 561 ignored files and 1,621.57 MB of real segments and stills; `Episodes/ep98` is 3 tracked files with no marker and no premise. `ep99` is 1 tracked manifest and 98.27 MB, with its narrative already retired to `Episodes/_retired/ep99/`. **DeadLight2 holds neither, so the inventory's F-10 Board problem does not exist there — `main:engine/src/episodes.ts:18` returns no row for either.** | **Does `ep98` move to DeadLight2, stay in the retired repository, or exist in both?** Staying is the cheapest and needs no engine change — the operator exports `SHOWRUNNER_SHOW_ROOT=/Users/ryanperkowski/GitHub/DeadLight` for the exercise. **Moving costs 1.62 GB and brings back exactly the F-10 Board question the fresh instance just dissolved, since `ep98` has no marker. `ep99` has no reader at all** |
| **A-18** | **Nine engine-side items touch the engine regardless of which cutover path Ryan takes, and none of them blocks the copy.** Measured on `main`: F-11 (`scripts/season-status.py` + its test, 753 lines, no engine caller), F-17 (`scripts/check_layout.py:40`'s `ep*` glob, no caller), F-21 (18 scripts, 27 f-string `Production/` sites), F-22 (`npm audit` → `{"moderate":5,"high":1,"critical":1,"total":7}`), F-24 (`engine/test/episode-pipeline.test.ts:317`, `:50`, `:102`), the six stamp steps (`engine/src/pipelines/episode.ts:211,248,274,285,340,372`), the three Python retirements (`ls scripts/*.py` → 26; `main:README.md:608` says "twenty-six Python programs"), and `EventLog.logPath`'s `productionDir = "Production"` default (`main:engine/src/events.ts:24`). | **Ship them in whatever order suits, and say in the plan that they are independent of the copy.** The one item whose terms the ruling changed is F-12: Plan G's `bible-ready` guard means the first Season 2 run is gated on **two** hand-placed files, `Canon/season-2.md` and `Episodes/s02e01/premise.md`, not one |
| **A-19** | **The inventory's §2.1 table is wrong about one row, and it was wrong at `9347474` too.** The row for `engine/src/agent-step.ts:160` reads "today `1`; after emptying, the `seasonOf` throw propagates". It does not propagate: `9347474:engine/src/agent-step.ts:156-164` and `main:engine/src/agent-step.ts:167-175` both wrap the call in `try { season = seasonOf(…) } catch (err) { if (!(err instanceof ShowConfigError)) throw err; }` and leave `season` undefined. **What fails is the renderer, and only for a prompt that writes `{{season}}` — measured: `check-prompts` with no season reports `outline.md` and `canon-review-outline.md` failing with `{{season}}: season is not available`, and no other prompt.** | **Carry the correction into Plan F rather than the inventory's row**, because A-01's `epNN` case turns on it: the failure is two named prompt files, not a propagating exception, which makes it diagnosable and makes the `epNN` option look survivable until someone tries to render an outline |
| **A-20** | **One sentence of `Canon/README.md:46` is now inaccurate in DeadLight2, and it was imported verbatim.** The rule's second sentence reads "Season 1 was produced under production ids (`ep01`–`ep10`) **that the cutover renames to aired slots** (`s01e01`–`s01e10`)". On the fresh-instance path nothing in the first repository is renamed, and whether Season 1 appears under aired slots in DeadLight2 at all is A-01's open question. The rule's first sentence — the binding one — is unaffected. | **Edit `Canon/README.md:46`'s second sentence in DeadLight2 at the copy, or leave it?** It is 1 line in a bible file every prompt's reader may open, and the sentence describes an operation Plan F no longer performs. **The first sentence is the law and must not change** |
| **A-21** | **`publish.channelName` is the literal `[YOUR NAME]` in both repositories.** `showrunner.json:112` in DeadLight2 and `showrunner.json:153` in the first repository. It is not among `c74ec70`'s twelve carried values because the two files agree on it — the first show never filled it in, and the import faithfully carried the placeholder. | **Fill it, or record that nothing reads it.** Plan F should check which script renders `publish.channelName` before deciding; it is a one-token edit either way, and it is the only configured value in DeadLight2 that is visibly a placeholder |
| **A-22** | **Spec §5.2's completion check does not return zero against DeadLight2 and cannot be carried forward as written.** Re-scoped to DeadLight2 and run today, the grep returns **57 occurrences in 5 files** — `Canon/continuity-ledger.md` 40, `Canon/season-1.md` 12, `Canon/style-guide.md` 2, `Canon/technology.md` 2, `Canon/voice-registry.md` 1 — all of them imported prose. The `--exclude-dir=video` the inventory's F-14 demands is still required, because `grep -r` reaches the ignored `Production/*/video/timeline.json` files (504 occurrences) under either id shape, verified with `git check-ignore --no-index` for both `Production/ep03/…` and `Production/s01e03/…`. | **Write the completion check in the plan as a measured delta, verbatim, with its expected non-zero baseline** — or narrow it to the two reference kinds A-14 names, which is the only form in which "zero" means what it claims on the fresh-instance path. **The 57 are the baseline before Plan F touches anything, and a plan that writes "returns zero" will either fail on day one or be ignored** |
| **A-23** | **The order of operations is forced in two places and free everywhere else.** Forced: `.gitignore` must be reconciled **before** any `git add` of the carried trees (A-02 — otherwise 34 files silently fail to commit and 914 silently do), and `Canon/season-2.md` must land before the first `s02e01` run (A-10 — `bible-ready` refuses it by name). Free: the copy of Season 1, the entity sheets, the references and the voices are independent of each other and of the engine hygiene (A-18), and `s02e01`'s guard requires nothing of Season 1 (A-13). **Measured sizes, for sequencing: 450 tracked files at 1,087.98 MB and 6,946 ignored at 14.85 GB, of which Season 1's directories are 185 tracked and 13.20 GB.** | **How many commits, and in what order?** Spec §5.2's "one commit" was a property of the rename's atomicity and has no counterpart here: a copy into a fresh repository can be any number of commits without risking history, because there is no rename for git to detect (§0's F-01/F-02 row). **A defensible sequence the measurements support: (1) `.gitignore`; (2) the bible's two missing files; (3) the entity trees and the references, with the `relic` decision; (4) the voices; (5) Season 1 under its ruled id shape, markers included, with the eight files of A-14 edited in the same commit; (6) `ep98` if it moves. State the number and the reason** |
| **A-24** | **Console v1 keeps running from the retired repository with no edit at all, and the GitHub name is the only decision the retirement forces.** v1 is listening (`lsof -i :4400` → `node 3353 … TCP *:ds-srv (LISTEN)`; `lsof -i :5183` → `node 25817`), and every path it resolves is inside the first repository: `.archon/workflows/*.yaml` (`console/server/archon.ts:207`), four `.archon/scripts/*.py` (`console/server/board.ts:4,67,86`; `actions.ts:55,59,64,72,75,93`), `Canon/season-1.md` and **its air map, which it regex-parses out of `.archon/scripts/finalize-video.py`** (`console/server/repo.ts:110`, `:46`). **It never reads `showrunner.json`**, so neither repository's `airMap` can affect it, and nothing Plan F writes into DeadLight2 can reach it. **The inventory's F-04 is void.** On GitHub: `MrMophandle/DeadLight` is private, ≈754 MB, default branch `main`; `MrMophandle/DeadLight2` does not exist; DeadLight2 has no remote; the two histories share no commit (`b706239` against `f73609b`). | **Which GitHub name?** §5.4 lists four options with their exact commands. **(a)** `gh repo create DeadLight2 --source /Users/ryanperkowski/GitHub/DeadLight2 --private --push`. **(b)** `gh repo rename -R MrMophandle/DeadLight DeadLight-v1 --yes`, then `gh repo create DeadLight --source … --private --push`, then `git remote set-url origin …DeadLight-v1.git` in the retired checkout. **(c)** a third name. **(d)** one repository, two unrelated branches. **Option (b) is the only one that keeps `MrMophandle/DeadLight` pointing at the live show, and the only one that needs a third command** |

---

## Change log

- **2026-10-04 — created.** The fresh-instance cutover measured against the engine at `main` `4f4b949`, the first show at `25bb3c6` and DeadLight2 at `c74ec70`. DeadLight2 is 17 commits and 82 tracked files; its `showrunner.json` differs from the first repository's in the ten `airMap` entries and in nothing else (71 leaves against 61, zero differing values); fifteen Canon files are byte-identical and two are absent; `bible-check` passes season 1 and fails season 2 on `Canon/season-2.md`; all 34 generic prompts render against DeadLight2's own config. Fifteen trees measured: 450 tracked files at 1,087.98 MB and 6,946 git-ignored at 14.85 GB. **Three measurements contradict or extend the inventory: DeadLight2's `.gitignore` would ignore all 34 tracked `Canon/_candidates/` PNGs — one of which `Canon/refs.json` names — while failing to ignore 914 files the first repository ignores (A-02, A-05); `engine/src/agent-step.ts` absorbs the `seasonOf` throw at both `9347474` and `main`, so the `epNN` failure is two named prompts rather than a propagating exception (A-19); and `Canon/locations/Dead Light/` holds 12 `epNN-`named pile stills the inventory's 151 did not count (§2.4).** Of the 444 tracked `epNN/` references, 292 in 59 files are in scope and **8 files with 32 references need an edit**. Twenty-four findings.
