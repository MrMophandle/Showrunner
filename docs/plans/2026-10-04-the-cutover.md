# The Cutover Implementation Plan (Plan F, on the fresh-instance path)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the move from console v1 to the engine: carry into the fresh instance at `~/GitHub/DeadLight2` everything `showrunner-init --import` did not bring — Season 1's ten episodes as archived `s01e01` through `s01e10`, the entity sheets, the reference images, the locked voices, the two bible files the import skipped — with every machine-read path corrected in the copy; retire the engine's console-v1-era machinery (the six `STATUS.md` stamp steps and the three Python programs nothing calls); and leave the first repository at `~/GitHub/DeadLight` untouched, running console v1 until Ryan stops it.

**Architecture:** Two repositories, two branches, nothing deleted anywhere. **DeadLight2** (branch `plan-f`, cut from its `main` at `c74ec70`) receives copies — never moves — taken from the first repository's tracked files by explicit `git ls-files` lists, with `cp -p` so the casting-pile stills keep the modification times the generator sorts by; the 13.20 GB of git-ignored production trees, `ep98`, `ep99`, the seven season-desk prompts, the thirty-four old prompts and `prompts/index.json` stay behind by design. The copy edits exactly the references a program resolves (thirty `"ref"` paths in seven audio manifests, two addresses in the style guide, the eleven character sheets' stance heading, eleven Harbor Lights example lines in the generic set) and leaves the 260 prose references alone under the rule `Canon/README.md` already states. **Showrunner** (branch `plan-f`, which already holds the inventory and its addendum) takes the engine hygiene the inventory assigned to Plan F that is independent of the copy. **The retired repository** is read with `git ls-files` and `cp` and written by nothing; console v1 keeps running from it on port 4400 with no edit at all.

**Tech Stack:** shell (`git ls-files`, `cp -p`, `sed`), Python 3 for the JSON edits, the built engine tools (`bible-check`, `check-prompts`), the console on port 4410 for the live check; TypeScript and Python for the engine side.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §5 (the cutover: §5.1 the id scheme, §5.2 the rename — replaced by the copy on this path, §5.3 `epNN` in prose means Season 1, §5.4 console v1), §7.5 (the sequence). **The inventories this plan is written from:** `docs/plans/2026-10-02-plan-f-inventory.md` (the in-place path, 24 findings, of which sixteen stand and four are re-scoped) and `docs/plans/2026-10-04-plan-f-inventory-addendum.md` (the fresh-instance path, 24 findings A-01…A-24; its §2 is the carry set measured tree by tree, §4.3 the eight files that need an edit, §6 the engine items). **The obligations this plan pays:** the inventory's twenty-three collected obligations as re-scoped by the addendum's §0 and §6.

**Rulings that shaped this plan.** Ryan ruled on 2026-10-04 that the cutover is a fresh instance made by `init --import`, not an in-place rename ("Feels like Plan F"), and that Season 1 moves into the instance as archived `s01e01`…`s01e10` (option A). The GitHub name for the instance is the one decision this plan leaves to Ryan at its end (A-24): until it is made, DeadLight2's `plan-f` branch is local.

## Rulings on the addendum's findings (made 2026-10-04; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| A-01 Season 1's id shape | **`s01e01`…`s01e10`** (Ryan's ruling). The ten markers are copied unedited; the Board shows ten archived COMPLETE rows with no launch button. |
| A-02 the two `.gitignore` files | **DeadLight2's `.gitignore` gains the three rules the copy needs** — `Production/*/audio-v1-*/`, `Production/*/audio-spike/`, `Production/*/notes/*.draft.md` — and nothing else from the first repository's sixteen (console v1's, Archon's and Remotion's rules describe trees that never arrive). `Canon/_candidates/` stays ignored (A-05). The edit lands first (Task 1), before any `git add`. |
| A-03 which prompt set | **The generic set stays.** It pays F-08, F-23, O-16, O-20 and Plan G's two globs; the laws it traded away are in the bible by Plan G's bible PR. The seven season-desk prompts and `prompts/index.json` stay in the retired repository until the desk is built (spec §0). The ep03/ep04 worked example (`repetition-check.md:35-39`) is recorded as lost. |
| A-04 the character sheets | **All thirteen sheets and every still are carried** (179 files, 944 MB, `cp -p`); DeadLight2 keeps its generic `_TEMPLATE.md`. |
| A-05 `relic-2.png` in `_candidates/` | **Option (b):** `relic-2.png` alone is copied to a tracked path under the directory the `relic` entry's `kind` uses in `Canon/refs.json` (the implementer reads the entry), and `relic.ref` is re-pointed; the other 33 candidates are scratch and are not copied. |
| A-06 eleven Harbor Lights lines in DeadLight2 | **Re-pointed at Dead Light's own cast** in DeadLight2's copies (Task 4): the one path (`environment-check.md:28-29`) names Opha's sheet; the ten illustrative lines use Sarn, Sable, Trent, Opha and Dead Light. DeadLight2's prompts stop being byte-identical to the templates, which is what a show's prompts are for. |
| A-07 `## Dark-forest stance` | **Renamed to `## Stance toward the central mystery` in the eleven sheets at the copy**, so the generic `character-check.md` reads it; the species sheets' `## Relationship to the dark forest / the Vanished` is renamed to `## Relationship to the central mystery` in the same pass (nothing checks it, but the generic template names it). |
| A-08 `airMap` | **Stays `{}`.** The loader refuses aired keys; Season 1 arrives aired. |
| A-09 the guest references | **The 54 WAVs are carried inside `Production/s01eNN/guest-refs/` and the thirty `"ref"` values are edited** in the seven manifests, in the same commit. |
| A-10 `Canon/season-2.md` | **Carried in Task 1, first** — it is the gate on the first Season 2 run. `Canon/season-desk-report.md` is carried too (the desk's output is bible content; nothing reads it; 71 prose references under the README rule). |
| A-11 the voices | **All ten files carried.** `Production/casting-samples/` and `Production/ep01/casting-samples/` are not (nothing reads them; the retired repository keeps them). |
| A-12 an empty `runs/` fails the guard | **No `Production/s01eNN/runs/` is created, not even empty** — copies use explicit file lists, never `cp -R` of a directory. Task 3 asserts it. |
| A-13 `s02e01`'s guard | Nothing to decide; recorded: Season 1's copy and the first Season 2 run are independent. |
| A-14 the eight files | **Edited in the copy:** the thirty `"ref"` paths, and `Canon/style-guide.md:3` and `:114` → `Episodes/s01e01/script.md`. The 260 prose references are not swept; `Canon/README.md:44-46` is the authority. |
| A-15 the outline template | **DeadLight2 keeps the generic one;** the first repository's is not copied (its two Harbor Lights lines are an A-06 item). |
| A-16 the Season 1 outlines have no `## Cast` | Recorded: **the carried Season 1 outlines are archive artifacts, not runnable inputs.** The show README says so (Task 5). |
| A-17 `ep98`/`ep99` | **Neither moves.** The engine's exercise keeps `SHOWRUNNER_SHOW_ROOT=/Users/ryanperkowski/GitHub/DeadLight`; the README says so (Task 6). `Production/ep98/runs/` in the retired repository is left alone. |
| A-18 the nine engine items | **Shipped in Tasks 6–8, independent of the copy.** |
| A-19 the inventory's §2.1 row | Correction carried: an unmapped id leaves `season` undefined and fails only a prompt that writes `{{season}}`. |
| A-20 `Canon/README.md:46` | **The second sentence is edited in DeadLight2** to say Season 1 was copied into aired slots; the first sentence, the law, is untouched. |
| A-21 `publish.channelName` | **Left as `[YOUR NAME]`;** it is Ryan's to fill, and Task 5 reports which script renders it. |
| A-22 the completion check | **A narrowed grep with an expected zero** (Task 5): the two machine-read kinds only — `"ref": "Production/ep` in any `*.json` under `Production/` and `Episodes/ep` in `Canon/style-guide.md` — plus `bible-check` for seasons 1 and 2, `check-prompts`, and the Board. The 57-occurrence prose baseline is recorded, not swept. |
| A-23 the order | **Six commits on DeadLight2's `plan-f`**, in the addendum's order: `.gitignore` and the two bible files; the entity trees and the references; the voices; Season 1's episodes and production trees with their edits; the generic set's residue and the sheet headings; the README and the check. The engine side is independent. |
| A-24 the GitHub name | **Ryan's, asked at the end.** Recommendation (b): `gh repo rename -R MrMophandle/DeadLight DeadLight-v1 --yes`, then `gh repo create DeadLight --source ~/GitHub/DeadLight2 --private --push`, then `git -C ~/GitHub/DeadLight remote set-url origin https://github.com/MrMophandle/DeadLight-v1.git`. No `gh` command that creates or renames runs in this plan. |
| F-21 the hardcoded `Production/` | **Fixed** (Task 7): the twenty-seven f-string sites read the config's `productionDir` through one helper. |
| F-22 `npm audit` | **Task 8, last and cut-able:** the dev-only advisories are fixed by version bumps with the suites green; the `react-router-dom` 7 bump is attempted and, if the five routes do not survive a mechanical change, recorded with the reason. |
| F-24 and the retirements | **Task 6:** the six stamp steps, `scripts/status.py`, `scripts/season-status.py`, `scripts/check_layout.py` and their tests retire; the walk test, the console tests, the ep98 exercise's restore line and the README follow. `EventLog.logPath`'s default stays (benign, deliberate). |

## Global Constraints

- **The retired repository is never written.** Every command against `/Users/ryanperkowski/GitHub/DeadLight` is `git ls-files`, `git show`, `cat`, `cp` from it, or `grep`; after every task `git -C /Users/ryanperkowski/GitHub/DeadLight status --porcelain` prints exactly its two pre-existing untracked lines and nothing else. Console v1 (pid on port 4400) is not stopped.
- **Nothing is deleted anywhere.** DeadLight2 receives copies; the engine's retirements are `git rm` of files nothing calls, each named in this plan.
- **Copies come from explicit file lists** (`git -C <first> ls-files -- <path>`), copied with `cp -p` (modification times preserved — the casting-pile generator sorts by mtime), one file at a time or via `rsync --files-from`. **Never `cp -R` of a directory**: no `Production/s01eNN/runs/`, no `.DS_Store`, no git-ignored file arrives.
- **DeadLight2 work is on its branch `plan-f`** (cut from `main` at `c74ec70`); the branch is local until Ryan names the GitHub repository. **Showrunner work is on `plan-f`** (at `5cd74bf`). Nothing is merged or pushed to either `main` by this plan.
- **No show's name in the engine** (spec §7.4): after every engine task, the README's grep prints nothing. The engine's test fixtures use "Harbor Lights".
- **Every commit ends with this trailer line in its final paragraph** (use `git commit -F -` with a heredoc): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Engine gates: `cd engine && npx vitest run && npm run typecheck`; `npm run build -w engine && npm run build -w tools` from the root; `cd tools && npx vitest run && npm run typecheck`; `cd console && npx vitest run && npm run typecheck`; `cd scripts && uv run pytest -q`. Show gates (DeadLight2): `node ~/GitHub/Showrunner/tools/dist/bible-check.js --show ~/GitHub/DeadLight2 --season 1` and `--season 2`; `node ~/GitHub/Showrunner/tools/dist/check-prompts.js --prompts ~/GitHub/DeadLight2/prompts --context <the context file Task 4 writes>`. Report the numbers printed, never a prediction.

---

## File Structure

```
~/GitHub/DeadLight2/  (branch plan-f)
  .gitignore                              MODIFY (Task 1): +3 rules
  Canon/season-2.md, Canon/season-desk-report.md     NEW (Task 1): copied
  Canon/README.md                         MODIFY (Task 1): line 46's second sentence
  Canon/style-guide.md                    MODIFY (Task 1): lines 3 and 114 → Episodes/s01e01/script.md
  Canon/characters/<17 dirs>/             NEW (Task 2): 178 files copied (every tracked file but _TEMPLATE.md); eleven sheets' heading renamed
  Canon/species/, Canon/locations/, Canon/factions/   NEW (Task 2): every tracked file but the _TEMPLATE.md files; species sheets' heading renamed
  Canon/refs.json                         MODIFY (Task 2): the first repository's content with relic.ref re-pointed
  Canon/<kind dir>/Relic/relic-2.png      NEW (Task 2): the one candidate that is a reference
  Production/voice-refs/                  MODIFY/NEW (Task 2): refs.json replaced, nine WAVs copied
  Episodes/s01e01..s01e10/                NEW (Task 3): 61 files incl. archive.json ×10
  Production/s01e01..s01e10/              NEW (Task 3): 124 files incl. 54 guest WAVs; 7 manifests' 30 "ref" paths and 21 manifests' "episode" edited; no runs/
  prompts/{environment-check,outline,visual-direction,flow-check,tts-script}.md   MODIFY (Task 4): eleven lines
  Canon/characters/_TEMPLATE.md:34-35, Episodes/_TEMPLATE/outline.md:11-12        MODIFY (Task 4)
  README.md                               MODIFY (Task 5): a "Season 1" paragraph
  .superpowers/ is not used in DeadLight2 — the ledger lives in Showrunner's workspace

~/GitHub/Showrunner/  (branch plan-f)
  engine/src/pipelines/episode.ts         MODIFY (Task 6): six stamp steps and the stamp helper removed; assemble-commit's status path dropped
  engine/test/episode-pipeline.test.ts    MODIFY (Task 6): the three STATUS.md assertions and the step-count/first-ids assertions
  engine/test/ep98-exercise.test.ts       MODIFY (Task 6): the STATUS.md restore line
  console/test/app.test.ts, episodes.test.ts, runs.test.ts   MODIFY (Task 6): assertions that named a stamp step
  scripts/status.py, season-status.py, check_layout.py + scripts/tests/test_season_status.py, test_check_layout.py   DELETE (Task 6)
  README.md                               MODIFY (Task 6): "twenty-six Python programs" → the count; the ep98 exercise's show root; the STATUS.md paragraph
  scripts/lib/showconfig.py               MODIFY (Task 7): production_dir(cfg, root) helper
  scripts/*.py (18 files, 27 sites)       MODIFY (Task 7): the literal Production/ → the helper
  engine/src/needs.ts                     MODIFY (Task 7): audio.guestRefsDir honoured
  scripts/populator-check.py:79           MODIFY (Task 7): the citation
  engine/package.json, console/package.json, package-lock.json   MODIFY (Task 8): the audit bumps
  docs/plans/2026-10-04-the-cutover-deferred.md   NEW (by the controller, at the end)
```

---

## Task 1: DeadLight2 — `.gitignore` reconciled, the two bible files the import skipped, and the three addresses

**Repository:** `/Users/ryanperkowski/GitHub/DeadLight2`. First: `git checkout -b plan-f` from `main` (`c74ec70`).

**Files:** modify `.gitignore`, `Canon/README.md`, `Canon/style-guide.md`; create `Canon/season-2.md`, `Canon/season-desk-report.md`.

- [ ] **Step 1: Measure the baseline** and record it in the report: `git -C ~/GitHub/DeadLight status --porcelain` (two untracked `Production/ep10/` lines), `git -C ~/GitHub/DeadLight2 log --oneline | wc -l` (17), `node ~/GitHub/Showrunner/tools/dist/bible-check.js --show ~/GitHub/DeadLight2 --season 2` (exit 1, `Canon/season-2.md`).

- [ ] **Step 2: `.gitignore`.** Append, after the existing `Production/*/images/.*.bak` line, with a one-line comment above them:

```
# The first show's scratch trees under a production directory (the audio re-rolls, a spike, a draft note); never canon.
Production/*/audio-v1-*/
Production/*/audio-spike/
Production/*/notes/*.draft.md
```

Verify: `git -C ~/GitHub/DeadLight2 check-ignore --no-index Production/s01e10/audio-v1-prepause/segments/x.wav Production/s01e04/notes/a.draft.md Canon/_candidates/relic-2.png` prints all three.

- [ ] **Step 3: The two bible files.** `cp -p ~/GitHub/DeadLight/Canon/season-2.md ~/GitHub/DeadLight2/Canon/season-2.md` and the same for `Canon/season-desk-report.md`. Verify `cmp` against the source for both, and `bible-check --season 2` now exits 0.

- [ ] **Step 4: The three addresses.** In `Canon/style-guide.md`, line 3's `` `Episodes/ep01/script.md` `` and line 114's `` `Episodes/ep01/script.md:5-23` `` become `Episodes/s01e01/script.md` and `Episodes/s01e01/script.md:5-23` (verify the line numbers with `grep -n 'Episodes/ep01/script.md' Canon/style-guide.md` first — exactly two hits). In `Canon/README.md`, the sentence at line 46 beginning "Season 1 was produced under production ids" has its clause "that the cutover renames to aired slots (`s01e01`–`s01e10`)" replaced by "which the cutover copied into aired slots (`s01e01`–`s01e10`) in this repository, leaving the first repository as it was"; the first sentence of the rule is untouched (diff the file and confirm one line changed).

- [ ] **Step 5: Commit** (one commit): `git add .gitignore Canon/season-2.md Canon/season-desk-report.md Canon/README.md Canon/style-guide.md` and

```
cutover: the ignore rules the copy needs, the two bible files the import skipped, and three addresses

Three scratch-tree rules join .gitignore ahead of any copy. season-2.md
(the gate on the first Season 2 run) and season-desk-report.md arrive
byte for byte. The style guide's two Register-sample addresses and the
README's episode-id rule name the aired slots Season 1 is copied into.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

Then the retired-repository check from the Global Constraints.

---

## Task 2: DeadLight2 — the entity trees, the references, and the voices

**Repository:** DeadLight2, branch `plan-f`.

- [ ] **Step 1: The file lists.** From the first repository: `git -C ~/GitHub/DeadLight ls-files -- Canon/characters Canon/species Canon/locations Canon/factions Production/voice-refs Canon/refs.json > /tmp/carry-2.txt` (write it under the session scratchpad, not `/tmp`); remove the four `_TEMPLATE.md` lines (DeadLight2 keeps its generic templates; `Canon/factions/_TEMPLATE.md` and `Canon/locations/_TEMPLATE.md` are byte-identical anyway); count: expect 179 − 1 + 12 − 1 + 20 − 1 + 2 − 1 + 10 + 1 = **220**. Record the count printed.

- [ ] **Step 2: Copy** with `rsync -a --files-from=<list> ~/GitHub/DeadLight/ ~/GitHub/DeadLight2/` (`-a` preserves mtimes; `--files-from` copies exactly the listed files and creates their directories). `Production/voice-refs/refs.json` and `Canon/refs.json` overwrite the scaffolds. Verify: `find ~/GitHub/DeadLight2/Canon/characters -name .DS_Store` prints nothing; `git -C ~/GitHub/DeadLight2 status --porcelain | wc -l` is 220 (218 untracked plus the two modified scaffolds — report the number).

- [ ] **Step 3: The `relic` reference.** Read `Canon/refs.json`'s `relic` entry (`kind` and `ref`). Copy `~/GitHub/DeadLight/Canon/_candidates/relic-2.png` to `Canon/<the directory the other entries of that kind use>/Relic/relic-2.png` (for `kind: "ship"` or `"creature"` the other entries sit under `Canon/characters/<Name>/` or `Canon/species/<Name>/` — follow the entries of the same kind; say which in the report) and set `relic.ref` to that path with a Python edit that preserves the file's key order and formatting (`json.load` → assign → `json.dump(indent=2, ensure_ascii=False)` + newline; diff the result against the source and confirm the only change is the one value). Verify every `ref` resolves: a Python walk over `refs.json`'s non-underscore entries testing `os.path.exists` from the DeadLight2 root — expect `missing: 0`.

- [ ] **Step 4: The headings.** In the eleven sheets that carry it (`grep -l '^## Dark-forest stance' Canon/characters/*/*.md` — expect 11; `_TEMPLATE.md` is not among them because it was not copied), replace the heading line `## Dark-forest stance` with `## Stance toward the central mystery`. In the species sheets that carry it (`grep -l 'dark forest / the Vanished' Canon/species/*.md`), replace `## Relationship to the dark forest / the Vanished` with `## Relationship to the central mystery`. Only heading lines change; confirm with `git diff --stat` that each file shows one changed line.

- [ ] **Step 5: Verify the voices** with the engine's own test: a Node one-liner against `~/GitHub/Showrunner/engine/dist/index.js` calling `missingRefs(root, outlineText, show)` where `outlineText` is a minimal outline whose `## Cast` lists every `audio.mainCast` name except `narrator` as `- <Name> (recurring, speaks)` plus `- Dead Light (location)` — expect an empty list (every recurring subject has a reference image and a LOCKED voice). Record the output.

- [ ] **Step 6: Commit** in two commits — the entity trees and the references (`Canon/`), then the voices (`Production/voice-refs/`):

```
cutover: the entity sheets, the casting pile and the reference images, carried

179 files under Canon/characters (thirteen sheets, 165 stills, copied
with their modification times), the species, location and faction
sheets and images, and Canon/refs.json with its 21 references — the
one that lived in the ignored candidates directory now has a tracked
home and the entry points at it. Eleven character sheets and the
species sheets carry the generic headings the prompts read by name.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

```
cutover: the nine locked voices, carried

Production/voice-refs/refs.json and its nine WAVs, byte for byte; every
cast entry is LOCKED and every reference resolves.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 3: DeadLight2 — Season 1 as `s01e01`…`s01e10`, archived

**Repository:** DeadLight2, branch `plan-f`.

- [ ] **Step 1: The file lists, per episode.** For N in 01..10: `git -C ~/GitHub/DeadLight ls-files -- Episodes/epN Production/epN` (expect 61 + 124 = 185 lines in total; `Episodes/ep10/.DS_Store` is not tracked and must not appear). Write a mapping list for `rsync --files-from` by rewriting each path's first segment pair `Episodes/epNN` → `Episodes/s01eNN` and `Production/epNN` → `Production/s01eNN` — `rsync --files-from` cannot rename, so copy per file with `cp -p "$src" "$dst"` after `mkdir -p "$(dirname "$dst")"`, from the list. The two untracked `Production/ep10/*` files are not in `ls-files` and do not come.

- [ ] **Step 2: Assert the shape.** `find ~/GitHub/DeadLight2/Production/s01e* -type d -name runs` prints nothing; `ls ~/GitHub/DeadLight2/Episodes/s01e*/archive.json | wc -l` is 10; `git -C ~/GitHub/DeadLight2 status --porcelain | grep -c '^??'` is 20 (ten directory pairs) — report the numbers.

- [ ] **Step 3: The thirty `"ref"` paths.** In the seven manifests (`Production/s01e01/tts-script.json`, `s01e07`, `s01e03` and `s01e03/tts-script.RESEG.json`, `s01e02`, `s01e08`, `s01e04`), replace `"Production/epNN/guest-refs/` with `"Production/s01eNN/guest-refs/` by a Python edit over the JSON text (string replace on the file content, not a re-serialisation, so formatting is untouched); count the replacements — expect 6, 6, 5, 5, 3, 3, 2 = **30**. Verify every `ref` resolves: a Python walk over each manifest's cast entries testing `os.path.exists` — expect 0 missing across the seven.

- [ ] **Step 4: The twenty-one `"episode"` fields.** In every `Production/s01eNN/tts-script.json`, `Production/s01eNN/images/prompts.json` and `Production/s01e03/tts-script.RESEG.json`, the top-level `"episode"` value becomes `"s01eNN"` (it is `"ep01-v2"` in one and `"epNN"` in twenty); string-replace on the exact `"episode": "<old>"` text; expect 21 replacements.

- [ ] **Step 5: The completion grep for this task.** `grep -rnoE '"ref": "Production/ep' ~/GitHub/DeadLight2/Production --include='*.json'` prints nothing; `grep -rnoE '"episode": "ep' ~/GitHub/DeadLight2/Production --include='*.json'` prints nothing. The prose references inside the outlines and the instruction sheets (`grep -rnoE '\bep(0[1-9]|10)/' ~/GitHub/DeadLight2/Episodes ~/GitHub/DeadLight2/Production --include='*.md' | wc -l` — expect 59 + 133 = **192**) are left exactly as copied; record the count.

- [ ] **Step 6: Commit** (one commit; 185 files + the 28 edited ones are among them):

```
cutover: Season 1, archived as s01e01 through s01e10

The ten episodes' tracked files — outlines, scripts, locked beats, the
launch premises, the archive markers — and their production trees'
tracked files: the audio manifests, the shot lists, the publish kits
and the 54 guest-reference WAVs. Thirty guest-reference paths in seven
manifests and twenty-one "episode" fields name the aired slot; the 192
prose references stay under the Canon/README.md rule. No runs/ directory
is created, so every later episode's previous-episode guard reads the
archive as an archive. The 13 GB of generated audio, video and stills
stay in the first repository.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 4: DeadLight2 — the generic set's Harbor Lights lines become Dead Light's, and the prompts render

**Repository:** DeadLight2, branch `plan-f`.

- [ ] **Step 1: The eleven lines**, from the addendum's §2.15 table (verify each address with `grep -n` first; the files are byte-identical to `main:tools/templates/prompts/` so the addresses hold):
  - `prompts/environment-check.md:28-29` — the parenthetical naming the Warden's oilskin and `Canon/characters/The Warden/the-warden.md` becomes the first repository's own example: Opha's bespoke EVA shell, pointing at `Canon/characters/Opha/opha.md` (confirm the file exists in DeadLight2 after Task 2 — the sheet's file name is whatever `ls Canon/characters/Opha/` shows).
  - `prompts/outline.md:89-91` — the cast-grammar examples use Dead Light's spellings: `("Sarn", "the Mute", "Dead Light")` and `` `- Sarn (recurring, speaks)`, `- the Mute (recurring)`, `- Harbormaster Quill (guest, speaks)` → `- Vrask (guest, speaks)`, `- Dead Light (location)` `` (read `Canon/refs.json`'s keys for the spellings the sheets use).
  - `prompts/visual-direction.md:47` — `'three people: Sarn, Sable and Trent'`.
  - `prompts/flow-check.md:26` — `(e.g. Sable, the Mute)`.
  - `prompts/tts-script.md:59` — `"Sable grinned"`.
  - `Canon/characters/_TEMPLATE.md:34-35` — `quiet-Trent, still-Opha, unprofitable-Remo` (the first repository's own line at its `_TEMPLATE.md:34-35`).
  - `Episodes/_TEMPLATE/outline.md:11-12` — `- Sarn (recurring, speaks)` and `- Dead Light (location)`.
  Nothing else in any of the seven files changes; `git diff --stat` shows seven files, eleven lines.

- [ ] **Step 2: The check context.** Write `<scratchpad>/deadlight2-check-context.json`: `tools/test/fixtures/harbor-check-context.json`'s `results` plus `"outline-gate:rejection": "notes"` and `"script-gate:rejection": "notes"`, `episodeId: "s02e01"`, `season: 2`, `showRoot: "/Users/ryanperkowski/GitHub/DeadLight2"`, and `show` = DeadLight2's `showrunner.json` parsed. Run `node ~/GitHub/Showrunner/tools/dist/check-prompts.js --prompts ~/GitHub/DeadLight2/prompts --context <that file>` — expect `every prompt … renders`, exit 0. Copy the context file into the report.

- [ ] **Step 3: Commit:**

```
cutover: the prompts' worked examples are this show's

Eleven lines in five prompts, the character template and the outline
template name Sarn, Sable, Trent, Opha, the Mute and Dead Light where
the engine's templates named the invented show; the one path among
them names Opha's sheet. Every prompt still renders against this
show's config.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 5: DeadLight2 — the README's Season 1 paragraph, the completion check, and the Board

**Repository:** DeadLight2, branch `plan-f`.

- [ ] **Step 1: The README paragraph.** Under the README's layout section, add a `## Season 1` section (three or four sentences, Claude's prose rules): Season 1's ten episodes were made by console v1 in the first repository and were copied here as `s01e01` through `s01e10` on the cutover of 2026-10-04 with their archive markers, so the Board shows them COMPLETE; their outlines and manifests are archive artifacts, not inputs a run can re-use (they predate the `## Cast` grammar and the aired paths); the generated audio, video and stills, the `ep98` exercise tree and `ep99` stay in the first repository at `~/GitHub/DeadLight`, which console v1 still serves; `epNN` in prose means Season 1 (`Canon/README.md`'s rule).

- [ ] **Step 2: The completion check, verbatim, with its expected results:**

```
cd ~/GitHub/DeadLight2
grep -rnoE '"ref": "Production/ep' Production --include='*.json' | wc -l        # 0
grep -rnoE 'Episodes/ep0' Canon/style-guide.md | wc -l                          # 0
grep -rnoE '\bep(0[1-9]|10)/' --include='*.md' --include='*.json' Canon Episodes Production prompts README.md | wc -l   # the prose baseline: 57 (bible) + 192 (Season 1) + season-2.md 1 + season-desk-report.md 71 + the entity sheets 10 = report the number
node ~/GitHub/Showrunner/tools/dist/bible-check.js --show "$PWD" --season 1    # exit 0
node ~/GitHub/Showrunner/tools/dist/bible-check.js --show "$PWD" --season 2    # exit 0
node ~/GitHub/Showrunner/tools/dist/check-prompts.js --prompts prompts --context <Task 4's file>   # exit 0
find Production -type d -name runs | wc -l                                      # 0
git -C ~/GitHub/DeadLight status --porcelain | wc -l                            # 2
```

Record every number printed. Also report which script renders `publish.channelName` (`grep -rn channelName ~/GitHub/Showrunner/scripts/*.py`) so Ryan knows where `[YOUR NAME]` lands.

- [ ] **Step 3: The Board.** Build the console if needed (`npm run build -w console` from the engine root, or run it as the README's console section says), start it against DeadLight2 on its default port 4410 with `--engine-root ~/GitHub/Showrunner`, fetch `GET http://localhost:4410/api/episodes` with `curl`, and assert: ten rows `s01e01`…`s01e10` with `status: "archived"` and `stage: "COMPLETE"`, each carrying its note; no other rows (no `ep98`, no `setup`); then stop the console (it is the one you started; port 4400 is untouched — `lsof -i :4400` still shows the pre-existing pid). Copy the JSON (trimmed) into the report.

- [ ] **Step 4: Commit:**

```
docs: Season 1 is here as an archive; the first repository keeps the rest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

(with a short body saying what the README section states and that the completion check and the Board were run.)

---

## Task 6: Showrunner — the console-v1-era machinery retires

**Repository:** `/Users/ryanperkowski/GitHub/Showrunner`, branch `plan-f`.

**Files:** `engine/src/pipelines/episode.ts` (the `stamp` helper at `:106`-ish and its six uses — `stamp-outline`, `stamp-script`, `stamp-casting`, `stamp-audio`, `stamp-images`, `stamp-finalized`; `assemble-commit`'s `dependsOn` and path list; `status` in the path constants), `engine/src/stages.ts` if any stamp id is in `EPISODE_STAGE_MAP` (check with `grep -n stamp`), `engine/test/episode-pipeline.test.ts` (the three `STATUS.md`/stamp assertions the addendum's §6 names at `:317`, `:50`, `:102`, plus the step-count and first-ids assertions: 74 → 68, and any `dependsOn` assertion naming a stamp), `console/test/app.test.ts`, `console/test/episodes.test.ts`, `console/test/runs.test.ts` (assertions that used a `stamp-*` id as a convenient step name — re-point to a neighbouring step), `engine/test/ep98-exercise.test.ts` (the line that restores `Episodes/ep98/STATUS.md` from git), `scripts/status.py`, `scripts/season-status.py`, `scripts/check_layout.py`, `scripts/tests/test_season_status.py`, `scripts/tests/test_check_layout.py` (`git rm`), `README.md` (the "twenty-six Python programs" sentence → "twenty-three"; the ep98 exercise's paragraph about restoring `STATUS.md` removed; a sentence that the exercise's show root is the first show's retired repository, `SHOWRUNNER_SHOW_ROOT=/Users/ryanperkowski/GitHub/DeadLight` — the README may name the show).

- [ ] **Step 1: Failing tests first** — change the walk test's expectations (the step count, the first ids, no `STATUS.md` written, `assemble-commit.dependsOn` without `stamp-finalized`), run, see them fail.
- [ ] **Step 2: Retire** — remove the six steps, the helper, the `status` path constant and its use in `assemble-commit`; re-point the dependents (`draft` depended on `stamp-outline` → `outline-gate`; and so on for each stamp's downstream step — read each `dependsOn` and substitute the stamp's own dependency); `git rm` the five Python files; fix the console tests; fix the ep98 exercise's restore line; the README.
- [ ] **Step 3: Gates** — engine, build, tools, console, pytest (expect fewer tests: the two deleted test files), the grep. The `pipelineHash` of the episode pipeline changes; any snapshot of it in a test is updated.
- [ ] **Step 4: Commit:**

```
engine: the STATUS.md stamps and the three Python programs nothing calls retire

Six stamp steps, their helper and the status path leave the episode
pipeline; assemble-commit no longer stages STATUS.md. scripts/status.py,
season-status.py and check_layout.py and their tests go with them —
their only callers were console v1 and the stamps. The ep98 exercise no
longer restores a STATUS.md, and its show root is documented as the
first show's retired repository.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 7: Showrunner — the production directory comes from the config everywhere, and the guest-references key is honoured

- [ ] **Step 1: `scripts/lib/showconfig.py`** gains `def production_dir(cfg: dict, root: str) -> str` returning `path(cfg, "productionDir", root=root)` (default `"Production"` when the key is absent — but the key is required by `SHOW_CONFIG_KEYS`? It is optional with an engine default; mirror that: `value(cfg, "productionDir", default="Production")` resolved against `root`). A test in `scripts/tests/`.
- [ ] **Step 2: The twenty-seven sites** (the addendum's §6 F-21 row lists them: `audio-mix.py:54`, `breath-qc.py:113`, `build-timeline.py:104`, `canon-diff.py:67`, `finalize-video.py:52,55,135,136`, `image-generate.py:75`, `image-qc.py:60,62`, `image-sheet.py:73,102`, `master-video.py:73`, `nano-banana-generate.py:430`, `pace-qc.py:51`, `populator-check.py:71`, `publish-kit.py:103,104,108,189`, `registry-append.py:122`, `shot-sheet.py:47,160`, `truncation-qc.py:155`, `tts-generate.py:77`, `validate-manifest.py:75`) each build their path from the helper. The eight docstring mentions may stay. `grep -rn "f\"Production/\|'Production/\|\"Production/" scripts/*.py` afterwards prints only docstrings and comments.
- [ ] **Step 3: `engine/src/needs.ts`** reads `audio.guestRefsDir` (the config value `Production/{episodeId}/guest-refs`, with `{episodeId}` substituted) instead of the hardcoded segment, defaulting to the current literal when the key is absent; `SHOW_CONFIG_KEYS`'s row for the key records the reader; a test in `engine/test/needs.test.ts`. `scripts/populator-check.py:79`'s message cites `visual.collectivePopulatorBans` instead of the section the template no longer names.
- [ ] **Step 4: Gates** (pytest 350 − the two deleted files + the new test; engine; the grep). The ep98 exercise is env-gated and not run; say so.
- [ ] **Step 5: Commit:** `scripts, engine: the production directory and the guest-references directory come from the config` with a short body and the trailer.

---

## Task 8: Showrunner — `npm audit` (last, cut-able)

- [ ] **Step 1:** `npm audit --json` at the root; record the seven advisories. Bump `vitest`/`vite` (dev-only, critical/high) to versions that clear them; every suite green.
- [ ] **Step 2:** Attempt `react-router-dom@7` in `console/package.json`: the five routes at `console/src/App.tsx` and any `useNavigate`/`Link` usage; if the console suite and the typecheck pass with mechanical edits only, keep it; if not, revert to 6 and record the two advisories (open redirect via `<Link>`; `deserializeErrors()`) with the reason (LAN-only, single operator) in the report for the deferred record.
- [ ] **Step 3: Commit** whatever cleared, `deps: the audit's dev-only advisories cleared; react-router stays at 6 (reason)` or `… react-router at 7`, with the trailer.

---

## After the tasks: the whole-branch review, the deferred record, and the two pull requests

- The whole-branch reviewer (Opus) reads both branches: Showrunner `plan-f` (`5cd74bf..HEAD`) and DeadLight2 `plan-f` (`c74ec70..HEAD`), and reads the retired repository's `git status`.
- The controller writes `docs/plans/2026-10-04-the-cutover-deferred.md` in the Plan G record's shape: status; what Plan F established; **Plan H**; the first Season 2 run (what remains before it: `Episodes/s02e01/premise.md`, Ryan's `publish.channelName`, the Register sample's one-line question, the writer model's cost); what was left in the retired repository and why (the desk prompts, `index.json`, `ep98`/`ep99`, the casting samples, the 33 candidates, the 13 GB); the rulings with their cost if wrong.
- **Pull requests:** Showrunner `plan-f` → `main` when the review is clean. DeadLight2 has no remote until Ryan names it (A-24): the controller asks the one question at the end, runs the `gh` commands Ryan chooses, pushes `plan-f`, and opens the pull request against DeadLight2's `main`.

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §5.1 (aired ids) → Task 3; §5.2's rename → replaced by the copy, with the completion check re-scoped (A-22, Task 5); §5.3 (`epNN` in prose) → the 260 references left alone, `Canon/README.md:46` corrected (Task 1); §5.4 (console v1) → untouched and still running (Global Constraints, Task 5's `lsof`); §7.5's sequence → Tasks 1–5 in the addendum's order, the engine hygiene independent (A-18). The inventory's standing findings: F-05 (the `"episode"` field) → Task 3 step 4; F-07 (stills by mtime) → `cp -p`/`rsync -a`; F-09 (markers unedited) → Task 3; F-10 → A-17's ruling; F-11/F-17 → Task 6; F-12 → A-10/A-13 recorded; F-14 → Task 5; F-15 (`Production/_archive/`) → stays behind (not in the carry set); F-18/F-19 (`.agent-logs/`, `remotion/public/`) → stay behind; F-20 (the design brief) → stays behind in the retired repository; F-21 → Task 7; F-22 → Task 8; F-24 → Task 6.
2. **Placeholder scan.** Every copy step names its file list's source and expected count; every edit names its address and expected replacement count; the completion check is verbatim with expected values. Task 6's `dependsOn` re-pointing is described as a rule ("substitute the stamp's own dependency") rather than six listed pairs, because the implementer reads them from the file; the test change is specified.
3. **Consistency.** Task 2's `relic` path decision feeds Task 2's own verification; Task 3's `s01eNN` naming is used by Tasks 1 (the style-guide addresses) and 5 (the Board); Task 4's context file is reused by Task 5; Task 6's step count (74 → 68) must match `describePipeline` — the implementer measures.

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-04-the-cutover.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. Tasks 1–5 run in DeadLight2 and Tasks 6–8 in Showrunner; the two sequences are independent and may interleave, but no two implementers run in the same repository at once.
