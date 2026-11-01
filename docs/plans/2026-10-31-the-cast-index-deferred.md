# The Cast Index (Plan L1) — deferred record

**Status (2026-11-01).** Branch `cast-index` on `casting-stop-spec` (the spec, 58f5c71), on origin/main 407442f. Tasks 1–5 done; Task 6 (the show's migration) is run by the controller after the engine PR is open and before the production rebuild. Commits: 9c702d5 (engine), 188f480 + 658e859 (scripts, prose), f4b012a + f2b3a64 (prompts), a1c2c7d + the prune-reporting fix (migration scripts), then docs. Suites at the last commit: engine 354 passed / 5 skipped, scripts 337, tools 196, console 388; the show-name grep clean.

## What the branch built
`Canon/cast.json` is the one record of who has a sheet, a face and a voice (spec §1.2). The engine's `refs-ready` probe looks every subject up there (a face for everyone on the page, a LOCKED voice with its WAV for everyone who speaks, guests included) and names the one-line remedy when the index is absent; every pipeline step takes the index as its input; the `registry-append` step that filled the character folders is gone. `scripts/lib/castindex.py` is the Python twin; the image generators condition on the reference and a gallery of at most three files named by the index and never list a folder. The prompt templates read the index first and only the sheets in play after it; the TTS script copies every voice from the index and designs none. Three migration tools build the index from the two registries (refusing on a path conflict), audit it against the retired repository read-only, and prune a character folder by moving everything but the sheet, the reference and three gallery images to `<productionDir>/_archive/characters/<Name>/`.

## Rulings made during execution
| id | ruling | why |
|---|---|---|
| R-01 | `castEntry`/`castKey` try the slug, `the-<slug>`, then an entry whose own `name` slugs to the slug | a display name with a title ("Dock Hand Pim") keys as `pim` in a hand-written index |
| R-02 | the `visual.refs` and `visual.characterKinds` config rows stay, with truthful `readBy` | `tools/test/config.test.ts` binds a row to every key the init writes; the init still writes both until L2 |
| R-03 | the loader carries `cast` (optRec); `ShowConfig.cast?`; the init writes `cast.index` | a configured path the engine could not see would document a dead key |
| R-04 | `slugName` lives in `cast.ts`, re-exported from `needs.ts` | no import cycle |
| R-05 | `slug_name`'s eighth test case `the_warden → the-warden` | pins the article rule before the hyphen collapse, which no listed case did |
| R-06 | `nano-banana-generate.py` keeps `load_bible` as the monkeypatch seam; `image-generate.py` drops it | nineteen tests patch the seam |
| R-07 | `image-generate.py` refuses an absent index (it used to generate ambient shots with an empty bible) | the index is the one record; running without it is a misconfiguration |
| R-08 | `design-visual.py` refuses a key with no `baseline_prompt` by name | the index holds the whole cast, not only designable subjects |
| R-09 | no `"model"` in the TTS manifest | no script reads one; the model is a constant in `tts-generate.py` |
| R-10 | index mentions backticked in every template; the templates test's allowance repointed from `Canon/refs.json` | one convention |
| R-11 | the H-19 `guestRefsDir` template assertion deleted with the guest procedure | it pinned text the index retires |
| R-12 | build conflicts are disagreements on `sheet`, `face.ref` or `voice.ref` across the four sources; exit 2, table printed, nothing written | a silently chosen wrong path is found episodes later; a refusal costs one read |
| R-13 | prune refusals exit 1; exit 2 is reserved for a build conflict | one meaning per code across the three tools |
| R-14 | a `the-`-keyed entry with no voice entry takes the sheet folder's spelling for its display name | precedence: existing index → voice registry → sheet folder → de-slugged key |
| R-15 | the prune reports the sheet as staying | its docstring said so and its output did not |

## Deferred
- **`checkGuestRefsDir` and `audio.guestRefsDir`** are still validated at load and read by `console/server/gates.ts` (the TTS-manifest picker); nothing in the engine reads them. L2 retires them with the guest-refs convention. Cost if left: a dead key accepted by the loader.
- **`audio.mainCast`** is still read by `validate-manifest.py` for the runway rule; the index could answer it (`debut` and `speaks`). Cost: one more hand-kept list.
- **The init scaffold** writes `Canon/refs.json` (`tools/templates/refs/canon-refs.json`) and names the two registries in `tools/templates/show/README.md:32` and `tools/templates/canon/visual-style.md:24`; a new show gets its index from `cast-index-build.py` until L2 scaffolds `cast.json`. Cost: a new show's first run stops at `refs-ready` with the remedy line.
- **The Cast page** in the console's bible rail is L2.
- **`casting-gate.reject.md:6`** still sends a rejected manifest to `Canon/voice-registry.md` alone (L2 owns that gate).
- **`tools/test/templates.test.ts`** pins nothing specific to the five templates Task 3 changed after H-19 went; the whole-corpus checks (renders, role line, a known canon file) are what remain. Cost: a regression in those templates is found by reading, as Task 3's review found "registry keys".
- **A build with an existing index** preserves `silent` and a hand-edited `name` by code (deep copy of the existing entry) but only `debut` has a test. Cost: a future merge-order change could drop them unnoticed.
- **The audit's `epNN → s01eNN`** mapping is the retired repository's; `--retired` is not general.
- **The first real build** (dry run 2026-11-01: 25 entries, 0 conflicts) infers `character` for `ernie-grother` and `vanished` and `voice` for `narrator`, names `the-mute` "Mute" and the Iss-kar extras from their slugs, and holds no entry for Veleth (voice in the episode's guest-refs, no face): Task 6 hand-fixes the names, files Veleth's and Hallet's voices, and Veleth's face is L2's first real run (or a hand design before then — after L1 the probe demands it on his next appearance).
- **A freshly built index has `gallery: []` for everyone**, so the prune must be run with `--keep <key>=<file>,…` per crew member (or the index edited first) or it moves every image but the reference; nothing is deleted either way.
- **The `environment-check.md:29` and `outline.md:81` mentions of `Canon/characters/`** are sheet-path citations, not listings; left alone.

## Not built
The casting stop, its gate, the brief agent, `casting-design.py`, `casting-file.py`, the Cast page, the init scaffold's `cast.json`, the retirement of `guestRefsDir` — all Plan L2.
