# Plan D inventory — the Dead Light pipeline, measured

**Date:** 2026-09-29 · **Status:** measurement only. Nothing in either repository was changed to produce this document.
**Purpose:** the inventory Plan D ("the Dead Light pipeline") is written from. Plan D turns the five Archon workflows in the show repository into typed `Pipeline` definitions in the engine, supplies the `StageMap` and the two `Needs` probes, and runs the show's first episode on the new engine.

**The two repositories this document cites.**

| Short form in a citation | Repository |
|---|---|
| `.archon/workflows/*.yaml`, `prompts/*`, `showrunner.json`, `Canon/*`, `Episodes/*`, `Production/*`, `.agent-logs/*` | the show — `/Users/ryanperkowski/GitHub/DeadLight` |
| `engine/src/*.ts`, `scripts/*.py`, `render/*`, `docs/*` | the engine — `/Users/ryanperkowski/GitHub/Showrunner` |

**Counts, stated up front.**

| Quantity | Count |
|---|---|
| Workflow nodes across the five YAML files | **64** (write-episode 21, produce-assets 20, assemble-episode 9, canon-update 5, season-review 9) |
| Typed `gate` steps | **9** in the YAML; **8** in Plan D's scope (`desk-gate` belongs to the deferred season desk, spec §0:35) |
| Typed `loop` steps | **4** (`outline-revise`, `draft`, `revise`, `image-audit`) |
| Typed `script` steps | **25** |
| Typed `guard` steps | **9** |
| Typed `agent` steps (top level, excluding the 9 nested `onReject` agents and the 4 nested loop bodies) | **17** |
| `StageMap` entries Plan D writes | **17** (8 `gates`, 8 `approved`, 1 `final`) |
| Findings | **21** (§9) |

9 + 4 + 25 + 9 + 17 = 64.

---

## 1 · Every node of every workflow as a typed step

**How to read a row.** Every row names its workflow's YAML file and the line the node's `id` sits on. `dependsOn` is the node's `depends_on` list verbatim. "Inputs / outputs" are the files, relative to the show root, that Plan D must declare on the step for the engine's hash cache to be correct (`engine/src/runner.ts:247-268`); for a script step they are read out of the ported script's `main()` in `scripts/`, not out of the YAML. A blank cell means the node declares nothing for that field.

**The engine never caches an agent step.** `runAgentStep` (`engine/src/runner.ts:272-284`) has no `lastCompletion` lookup, so `inputs` on an agent step buys only the `inputHashes` recorded on its `step_started` and `step_completed`. That hash record is what spec §2.3 needs for hand-edit provenance detection, so it is still worth declaring.

### 1.1 `deadlight-write-episode.yaml` — 21 nodes

| Node id | Kind | `dependsOn` | Script + argv, or decision logic | Inputs (reads) | Outputs (writes) | Timeouts | `when` / `trigger_rule` |
|---|---|---|---|---|---|---|---|
| `setup` (`deadlight-write-episode.yaml:21`) | **guard** | — | Not a script. Validates that the first `ARGUMENTS` token matches `^ep[0-9]{2,}$`, refuses if `Episodes/$EP_ID/script.md` exists, then `mkdir -p "Episodes/$EP_ID"` (`:25-35`). | `Episodes/<ep>/script.md` (existence only) | `Episodes/<ep>/` (directory — **a write, see §1.6**) | `timeout: 15000` (`:36`) | — |
| `outline` (`:39`) | **agent** | `[setup]` | `prompts/outline.md`, model `writer`, tools `Read, Write, Glob, Grep` (`:41-42`) | `Canon/world-overview.md`, `Canon/series-arc.md`, `Canon/episode-formula.md`, `Canon/story-craft.md`, `Canon/continuity-ledger.md`, `Canon/style-guide.md`, `Canon/timeline.md`, `Canon/characters/**`, `Canon/species/**`, `Canon/locations/**`, `Canon/factions/**`, `Canon/technology.md`, `Episodes/ep01/outline.md`, `Episodes/_TEMPLATE/outline.md` (`:53-70`) | `Episodes/<ep>/outline.md` (`:132`) | none declared | — |
| `outline-canon-check` (`:142`) | **agent** | `[outline]` | `prompts/outline-canon-check.md` + `prompts/outline-canon-check.schema.json`, model `medium`, `context: fresh`, tools `Read, Glob, Grep` (`:144-159`) | `Episodes/<ep>/outline.md`, `Canon/world-overview.md`, `Canon/technology.md`, `Canon/characters/The Mute/the-mute.md`, `Canon/timeline.md`, `Canon/continuity-ledger.md`, `Canon/season-1.md`, `Episodes/<ep>/locked-beats.md` (`:165-172`) | none | none declared | — |
| `outline-fix-gate` (`:182`) | **guard** — pure decision | `[outline-canon-check]` | **Pure decision → guard.** Verbatim: `OC=$outline-canon-check.output.pass` / `if [ "$OC" = "true" ]; then printf 'yes'; else printf 'no'; fi` (`:185-186`). In the engine this is `check: (ctx) => (ctx.results["outline-canon-check"] as {pass:boolean}).pass ? {pass:true} : {pass:true, message:"no"}` — see finding F-04: the guard must **pass** in both branches, because a failing guard skips its dependents (`engine/src/runner.ts:228-229`). | `ctx.results["outline-canon-check"]` | none | `timeout: 15000` (`:187`) | — |
| `outline-revise` (`:189`) | **loop** | `[outline-fix-gate]` | Body `prompts/outline-revise.md`, model `writer`, `context: shared` (`fresh_context: false`, `:210`), `until: OUTLINE_FIXED`, `max_iterations: 2` (`:208-209`) | `Episodes/<ep>/outline.md`, the canon files the auditor cited, `ctx.results["outline-canon-check"]` | `Episodes/<ep>/outline.md` | `idle_timeout: 900000` (`:193`) | `when: "$outline-fix-gate.output == 'no'"` (`:191`) → `when: (ctx) => ctx.results["outline-fix-gate"] === "no"` |
| `outline-gate` (`:213`) | **gate** | `[outline-revise]` | Message `prompts/outline-gate.gate.md` (`:217-226`); `onReject` agent `prompts/outline-gate.reject.md` (`:229-248`), model `writer`; `max_attempts: 10` (`:256`) | `Episodes/<ep>/outline.md`, `ctx.results["outline-canon-check"].verdict` | `onReject` writes `Episodes/<ep>/outline.md` | none | `trigger_rule: all_done` (`:215`) — needed because `outline-revise` is legitimately bypassed |
| `stamp-outline` (`:258`) | **script** | `[outline-gate]` | `scripts/status.py <ep> outline "approved at outline-gate"` (`:262`) | `Episodes/<ep>/STATUS.md` (`scripts/status.py:19`) | `Episodes/<ep>/STATUS.md` (`scripts/status.py:31`) | `timeout: 15000` (`:263`) | — |
| `draft` (`:266`) | **loop** | `[stamp-outline]` | Body `prompts/draft.md`, model `writer`, `context: fresh` (`fresh_context: true`, `:364`), `until: DRAFT_COMPLETE`, `max_iterations: 15` (`:352-353`) | `Canon/style-guide.md`, `Canon/story-craft.md`, `Episodes/<ep>/outline.md`, `Episodes/<ep>/script.md`, `Episodes/ep*/script.md`, `Episodes/ep01/script.md`, the cited `Canon/**` sheets (`:276-294`) | `Episodes/<ep>/script.md`, `Episodes/<ep>/.draft-complete` (`:295-346`) | `idle_timeout: 900000` (`:269`) | — |
| `draft-complete-check` (`:378`) | **guard** | `[draft]` | Not a script. Hard-fails when `Episodes/<ep>/.draft-complete` is absent, printing the word count of `script.md`; on success **deletes the sentinel** (`rm -f "$SENT"`, `:408`). | `Episodes/<ep>/.draft-complete`, `Episodes/<ep>/script.md` | deletes `Episodes/<ep>/.draft-complete` (**a write, see §1.6**) | `timeout: 30000` (`:409`) | `trigger_rule: all_done` (`:393`) — the comment at `:380-384` records that v1 of this guard was itself skipped by the default rule |
| `continuity-check` (`:412`) | **agent** | `[draft-complete-check]` | `prompts/continuity-check.md` + `.schema.json`, `medium`, `context: fresh`, tools `Read, Glob, Grep` (`:414-429`) | `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md`, `Canon/world-overview.md`, `Canon/technology.md`, `Canon/characters/The Mute/the-mute.md`, `Canon/timeline.md`, `Canon/continuity-ledger.md`, `Canon/**/*.md` (`:434-442`) | none | none declared | — |
| `tone-check` (`:453`) | **agent** | `[draft-complete-check]` | `prompts/tone-check.md` + `.schema.json`, `medium`, `context: fresh` (`:455-470`) | `Canon/style-guide.md`, `Episodes/ep01/script.md`, `Episodes/<ep>/script.md` (`:472-475`) | none | none declared | — |
| `flow-check` (`:502`) | **agent** | `[draft-complete-check]` | `prompts/flow-check.md` + `.schema.json`, `medium`, `context: fresh` (`:504-519`) | `Canon/episode-formula.md`, `Canon/style-guide.md`, `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md` (`:522-524`) | none | none declared | — |
| `character-check` (`:557`) | **agent** | `[draft-complete-check]` | `prompts/character-check.md` + `.schema.json`, `medium`, `context: fresh` (`:559-574`) | `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md`, `Canon/characters/**/*.md`, `Canon/world-overview.md`, `Canon/style-guide.md` (`:582-593`) | none | none declared | — |
| `structure-check` (`:619`) | **agent** | `[draft-complete-check]` | `prompts/structure-check.md` + `.schema.json`, `medium`, `context: fresh` (`:621-636`) | `Canon/story-craft.md`, `Canon/episode-formula.md`, `Episodes/<ep>/outline.md`, `Episodes/<ep>/script.md` (`:642-644`) | none | none declared | — |
| `environment-check` (`:668`) | **agent** | `[draft-complete-check]` | `prompts/environment-check.md` + `.schema.json`, `medium`, `context: fresh` (`:670-685`) | `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md`, `Canon/technology.md`, `Canon/locations/**` (`:693-695`) | none | none declared | — |
| `repetition-check` (`:730`) | **agent** | `[draft-complete-check]` | `prompts/repetition-check.md` + `.schema.json`, `medium`, `context: fresh` (`:732-747`) | `Canon/style-guide.md`, `Episodes/<ep>/script.md`, the two highest-numbered previous `Episodes/ep*/script.md` (`:752-758`) | none | none declared | — |
| `review-gate` (`:796`) | **guard** — pure decision | `[continuity-check, tone-check, flow-check, character-check, environment-check, structure-check, repetition-check]` | **Pure decision → guard.** Verbatim: seven `$<check>.output.pass` reads, then `ALL_PASS="yes"` / `for v in …; do [ "$v" = "true" ] \|\| ALL_PASS="no"; done` / `printf '%s' "$ALL_PASS"` (`:799-810`). In the engine: `check: (ctx) => ({pass: true, message: SEVEN.every(id => (ctx.results[id] as any).pass) ? "yes" : "no"})`. | the seven verdicts in `ctx.results` | none | `timeout: 15000` (`:811`) | — |
| `revise` (`:814`) | **loop** | `[review-gate]` | Body `prompts/revise.md`, model `writer`, `context: shared` (`fresh_context: false`, `:849`), `until: REVISIONS_COMPLETE`, `max_iterations: 3` (`:847-848`) | `Canon/style-guide.md`, `Episodes/<ep>/script.md`, the seven verdicts | `Episodes/<ep>/script.md` | `idle_timeout: 900000` (`:818`) | `when: "$review-gate.output == 'no'"` (`:816`) → `when: (ctx) => ctx.results["review-gate"] === "no"` |
| `script-gate` (`:856`) | **gate** | `[revise]` | Message `prompts/script-gate.gate.md` (`:860-870`); `onReject` `prompts/script-gate.reject.md` (`:873-878`), model `writer`; `max_attempts: 10` (`:886`) | `Episodes/<ep>/script.md`, `ctx.results["review-gate"]` and the seven verdicts | `onReject` writes `Episodes/<ep>/script.md` | none | `trigger_rule: all_done` (`:858`) |
| `stamp-script` (`:888`) | **script** | `[script-gate]` | `scripts/status.py <ep> script "panel passed, showrunner approved"` (`:892`) | `Episodes/<ep>/STATUS.md` | `Episodes/<ep>/STATUS.md` | `timeout: 15000` (`:893`) | — |
| `commit` (`:898`) | **script** | `[stamp-script]` | `git add "Episodes/$EP"` then `git commit -m "<ep>: outline + script (write-episode; panel: …)"` — **two git commands with seven interpolated verdicts** (`:900-911`) | `Episodes/<ep>/**`, the seven verdicts | the git index and a commit | `timeout: 30000` (`:912`) | — |

### 1.2 `deadlight-produce-assets.yaml` — 20 nodes

| Node id | Kind | `dependsOn` | Script + argv, or decision logic | Inputs (reads) | Outputs (writes) | Timeouts | `when` / `trigger_rule` |
|---|---|---|---|---|---|---|---|
| `setup` (`deadlight-produce-assets.yaml:21`) | **guard** | — | Not a script. Validates `^ep[0-9]{2,}$`, requires `Episodes/$EP_ID/script.md`, then `mkdir -p "Production/$EP_ID/audio" "Production/$EP_ID/images"` (`:23-33`). | `Episodes/<ep>/script.md` (existence) | `Production/<ep>/audio/`, `Production/<ep>/images/` (**writes, see §1.6**) | `timeout: 15000` (`:34`) | — |
| `tts-script` (`:37`) | **agent** | `[setup]` | `prompts/tts-script.md`, model `large`, tools `Read, Write, Glob, Grep, Bash` (`:39-40`). The `Bash` grant exists only to shell `scripts/design-voice.py --instruct … --text … --out … --candidates 2` for guest voices (`:176-179`). | `Production/voice-refs/refs.json`, `Canon/voice-registry.md`, `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md` (`:49-57`) | `Production/<ep>/tts-script.json` (`:59`), `Production/<ep>/guest-refs/<name>-{1,2}.wav` (`:178`) | `idle_timeout: 1800000` (`:41`) | — |
| `validate-manifest` (`:232`) | **script** | `[tts-script]` | `scripts/validate-manifest.py <ep>` (`:236`) | `Production/<ep>/tts-script.json` (`scripts/validate-manifest.py:75`), `Canon/voice-registry.md` (read via `audio.voiceRegistry`, `scripts/validate-manifest.py:74`, `:130`), every cast `ref` WAV for existence (`:126`) | nothing — read-only, exits non-zero on a hard failure (`:177`) | `timeout: 60000` (`:237`) | — |
| `casting-gate` (`:240`) | **gate** | `[validate-manifest]` | Message `prompts/casting-gate.gate.md` (`:243-250`); `onReject` `prompts/casting-gate.reject.md` (`:253-260`); `max_attempts: 10` (`:268`) | `ctx.results["validate-manifest"]`, `ctx.results["tts-script"]` | `onReject` writes `Production/<ep>/tts-script.json` | none | — |
| `stamp-casting` (`:270`) | **script** | `[casting-gate]` | `scripts/status.py <ep> casting "guest voices approved"` (`:274`) | `Episodes/<ep>/STATUS.md` | `Episodes/<ep>/STATUS.md` | `timeout: 15000` (`:275`) | — |
| `tts-generate` (`:278`) | **script** | `[casting-gate]` | `scripts/tts-generate.py <ep>` (`:282`) | `Production/<ep>/tts-script.json`, each cast entry's `ref` WAV under `Production/voice-refs/` or `Production/<ep>/guest-refs/` (`scripts/tts-generate.py`) | `Production/<ep>/audio/segments/<i:04d>.wav`, `Production/<ep>/audio/manifest.json` | `timeout: 10800000` (3 h, `:283`) | — |
| `truncation-qc` (`:289`) | **script** | `[tts-generate]` | `scripts/truncation-qc.py <ep>` (`:293`) | `Production/<ep>/tts-script.json`, every `Production/<ep>/audio/segments/*.wav` | `Production/<ep>/tts-script.json` (bumped seeds), deletes and re-synthesizes offending segment WAVs, refreshes `audio/manifest.json` | `timeout: 1800000` (`:294`) | — |
| `pace-qc` (`:296`) | **script** | `[truncation-qc]` | `scripts/pace-qc.py <ep>` (`:300`) | `Production/<ep>/tts-script.json`, `Production/<ep>/audio/manifest.json`, the segment WAVs | `Production/<ep>/tts-script.json`, segment WAVs (deleted, re-rolled, or `atempo`-clamped in place), `audio/manifest.json` | `timeout: 3600000` (`:301`) | — |
| `breath-qc` (`:305`) | **script** | `[pace-qc]` | `scripts/breath-qc.py <ep>` (`:309`) | `Production/<ep>/tts-script.json`, every narrator segment WAV | those same WAVs, in place; `audio/manifest.json` refreshed via a `tts-generate` re-run | `timeout: 600000` (`:310`) | — |
| `audio-mix` (`:312`) | **script** | `[breath-qc]` | `scripts/audio-mix.py <ep>`; the YAML additionally sets `HUM_DB="${HUM_DB:--42}"` in the environment (`:318`). In the ported script the room tone is `audio.roomToneDb` in `showrunner.json:71`, so the env var is **dead** — see F-12. | `Production/<ep>/audio/manifest.json`, every `Production/<ep>/audio/segments/*.wav` | `Production/<ep>/audio/DeadLight S<ss>E<ee>.wav` (`output.mixFilename`, `showrunner.json:60`); `episode.wav` for an id the `airMap` does not place (`scripts/audio-mix.py:12,28`) | `timeout: 600000` (`:319`) | — |
| `audio-gate` (`:607`) | **gate** | `[audio-mix]` | Message `prompts/audio-gate.gate.md` (`:610-614`); `onReject` `prompts/audio-gate.reject.md` (`:617-630`); `max_attempts: 5` (`:631`) | `Production/<ep>/audio/DeadLight S<ss>E<ee>.wav`, `ctx.results["audio-mix"]` | `onReject` writes `Production/<ep>/tts-script.json` and deletes named segment WAVs | none | — |
| `stamp-audio` (`:633`) | **script** | `[audio-gate]` | `scripts/status.py <ep> audio "mix approved (-14 LUFS)"` (`:637`) | `Episodes/<ep>/STATUS.md` | `Episodes/<ep>/STATUS.md` | `timeout: 15000` (`:638`) | — |
| `visual-direction` (`:322`) | **agent** | `[audio-gate]` — **the ordering rule §1.1 lives in this one dependency** (`:332`, reason at `:323-331`) | `prompts/visual-direction.md`, model `medium`, `context: fresh`, tools `Read, Write, Glob, Grep` (`:333-335`) | `Canon/visual-style.md`, `Canon/refs.json`, `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md` (`:342-349`) | `Production/<ep>/images/prompts.json` (`:351`) | none declared | — |
| `image-generate` (`:467`) | **script** | `[visual-direction, audio-mix]` — depends on `audio-mix` to serialize Metal GPU use (`:462-466`) | `scripts/image-generate.py <ep>` (`:471`) | `Production/<ep>/images/prompts.json`, `Canon/refs.json`, each locked subject's `ref` image | `Production/<ep>/images/<shot-id>.png` for `type == "ambient"` only | `timeout: 10800000` (`:472`) | — |
| `nano-banana-generate` (`:480`) | **script** — **not expressible as one, see §1.6** | `[visual-direction]` | `set +e`; capture `scripts/nano-banana-generate.py <ep> 2>&1`; print it; run `scripts/image-sheet.py <ep>`; `grep -qE 'NANO_(OK\|PARTIAL)'` on the captured output to decide the exit code (`:482-495`) | `Production/<ep>/images/prompts.json`, `Canon/refs.json`, each subject's reference sheet and its two newest pile stills, `GEMINI_API_KEY` | `Production/<ep>/images/<shot-id>.png` for `type == "character"`, `.{id}.png.bak` during `--only`, `Production/<ep>/images/IMAGE-SHEET.md` | `timeout: 10800000` (`:496`) | — |
| `nano-banana-gate` (`:503`) | **gate** | `[nano-banana-generate, image-generate]` | Message `prompts/nano-banana-gate.gate.md` (`:506-517`); `onReject` `prompts/nano-banana-gate.reject.md` (`:520-541`); `max_attempts: 10` (`:549`) | `Production/<ep>/images/*.png`, `Production/<ep>/images/IMAGE-SHEET.md`, `ctx.results["nano-banana-generate"]` | `onReject` may write **`Canon/refs.json`** (`:535-539`) and re-roll named shots | none | — |
| `image-audit` (`:552`) | **loop** | `[nano-banana-gate]` | Body `prompts/image-audit.md`, model `medium`, `context: shared` (`fresh_context: false`, `:604`), `until: IMAGES_CLEAN`, `max_iterations: 3` (`:602-603`) | `Canon/visual-style.md`, `Production/<ep>/images/prompts.json`, every `Production/<ep>/images/*.png` | `Production/<ep>/images/prompts.json` (ambient rewrites, seed bumps), deletes and regenerates ambient PNGs | `idle_timeout: 1800000` (`:555`) | — |
| `image-gate` (`:641`) | **gate** | `[image-audit]` | Message `prompts/image-gate.gate.md` (`:644-648`); `onReject` `prompts/image-gate.reject.md` (`:651-659`); `max_attempts: 5` (`:660`) | `Production/<ep>/images/*.png`, `ctx.results["image-audit"]` | `onReject` writes `Production/<ep>/images/prompts.json` and deletes PNGs | none | — |
| `stamp-images` (`:662`) | **script** — **three programs in one node, see §1.6** | `[image-gate]` | `scripts/registry-append.py <ep>`; `scripts/image-sheet.py <ep>`; `scripts/status.py <ep> images "assets approved"` (`:669-672`) | `Production/<ep>/images/prompts.json`, `Canon/refs.json`, every approved `Production/<ep>/images/*.png`, `Episodes/<ep>/STATUS.md` | `Canon/characters/<Name>/<ep>-<shot-id>.png`, `Production/<ep>/images/IMAGE-SHEET.md`, `Episodes/<ep>/STATUS.md` | `timeout: 120000` (`:673`) | — |
| `commit` (`:676`) | **script** | `[stamp-audio, stamp-images]` | `git add` of five paths, then `git commit` (`:683-686`) | `Production/<ep>/tts-script.json`, `Production/<ep>/images/prompts.json`, `Production/<ep>/images/IMAGE-SHEET.md`, `Canon/characters/**`, `Canon/refs.json` | the git index and a commit | `timeout: 30000` (`:687`) | — |

### 1.3 `deadlight-assemble-episode.yaml` — 9 nodes

| Node id | Kind | `dependsOn` | Script + argv, or decision logic | Inputs (reads) | Outputs (writes) | Timeouts | `when` / `trigger_rule` |
|---|---|---|---|---|---|---|---|
| `setup` (`deadlight-assemble-episode.yaml:19`) | **guard** | — | Not a script. Validates `^ep[0-9]{2,}$`; requires at least one `Production/$EP_ID/audio/DeadLight *.wav`; requires at least one `Production/$EP_ID/images/*.png`; requires `/Volumes/media/DeadLight` to be a directory (`:21-38`). The NAS check is here so a finalize cannot fail after a four-hour render. | `Production/<ep>/audio/DeadLight *.wav`, `Production/<ep>/images/*.png`, the NAS mount | none | `timeout: 15000` (`:39`) | — |
| `build-timeline` (`:41`) | **script** | `[setup]` | `scripts/build-timeline.py <ep> --render-root <engine>/render/public` (`:45`; the ported script takes `--render-root`, `scripts/build-timeline.py:16`, `:26-30`) | `Production/<ep>/audio/manifest.json`, `Production/<ep>/tts-script.json`, `Production/<ep>/images/prompts.json`, `Episodes/<ep>/script.md`, `Production/<ep>/audio/<mix name>.wav`, every `Production/<ep>/images/<id>.png` | `Production/<ep>/video/timeline.json`; and, **outside the show root**, `<render-root>/<ep>/{audio.wav,timeline.json,images/<id>.png}` | `timeout: 300000` (`:46`) | — |
| `render` (`:48`) | **script** — **not expressible as one, see §1.6** | `[build-timeline]` | `cd remotion && REMOTION_EPISODE="$EP" npx remotion render Episode "../Production/$EP/video/episode.mp4" --log=error` (`:52`). The engine form is `argv: ["npx","remotion","render","Episode","<showRoot>/Production/<ep>/video/episode.mp4","--log=error"]` with `cwd: "<engine>/render"` and `env: {REMOTION_EPISODE: ctx.episodeId}` (`render/README.md:56-59`). | `<render-root>/<ep>/**` | `Production/<ep>/video/episode.mp4` (`output.videoFilename`, `showrunner.json:61`) | `timeout: 14400000` (4 h, `:53`) | — |
| `master` (`:55`) | **script** | `[render]` | `scripts/master-video.py <ep>` (`:59`) | `Production/<ep>/video/episode.mp4` | `Production/<ep>/video/episode-mastered.mp4` (`scripts/master-video.py:30,76` — written **beside** the input, never over it) | `timeout: 900000` (`:60`) | — |
| `final-gate` (`:63`) | **gate** | `[master]` | Message `prompts/final-gate.gate.md` (`:66-71`); `onReject` `prompts/final-gate.reject.md` (`:74-85`); `max_attempts: 2` (`:86`) — the tightest cap in the pipeline | `Production/<ep>/video/episode.mp4`, `ctx.results["master"]` | `onReject` rebuilds the timeline, re-renders and re-masters | none | — |
| `finalize` (`:88`) | **script** | `[final-gate]` | `scripts/finalize-video.py <ep>` (`:92`) | `Production/<ep>/video/episode-mastered.mp4` or `episode.mp4`, `showrunner.json` `airMap`, every `Canon/season-*.md` as a fallback, the NAS mount | `/Volumes/media/DeadLight/DeadLight S<ss>E<ee>.mp4` — **never writes locally** | `timeout: 1200000` (`:93`) | — |
| `stamp-finalized` (`:95`) | **script** | `[finalize]` | `scripts/status.py <ep> finalized "pushed to NAS"` (`:99`) | `Episodes/<ep>/STATUS.md` | `Episodes/<ep>/STATUS.md` | `timeout: 15000` (`:100`) | — |
| `publish-kit` (`:102`) | **script** | `[finalize]` | `scripts/publish-kit.py <ep>` (`:106`) | `Production/<ep>/audio/manifest.json`, `Production/<ep>/tts-script.json`, `Episodes/<ep>/script.md`, `Episodes/<ep>/publish.json` (`scripts/publish-kit.py:101`) | `Production/<ep>/publish/upload.md`, `Production/<ep>/publish/captions.srt` | `timeout: 60000` (`:107`) | — |
| `commit` (`:109`) | **script** | `[stamp-finalized, publish-kit]` | `git add` of three paths, then `git commit` (`:113-114`) | `Production/<ep>/video/timeline.json`, `Production/<ep>/publish/**`, `Episodes/<ep>/STATUS.md` | the git index and a commit | `timeout: 30000` (`:116`) | — |

### 1.4 `deadlight-canon-update.yaml` — 5 nodes

| Node id | Kind | `dependsOn` | Script + argv, or decision logic | Inputs (reads) | Outputs (writes) | Timeouts | `when` / `trigger_rule` |
|---|---|---|---|---|---|---|---|
| `setup` (`deadlight-canon-update.yaml:22`) | **guard** | — | Not a script. Validates `^ep[0-9]{2,}$`; requires `Episodes/$EP_ID/script.md`; **requires `git diff --quiet -- Canon/`** so the gate diff is only this episode's (`:24-37`). | `Episodes/<ep>/script.md`, the git working tree under `Canon/` | none | `timeout: 15000` (`:38`) | — |
| `propose` (`:41`) | **agent** | `[setup]` | `prompts/propose.md`, model `medium`, tools `Read, Edit, Write, Glob, Grep` (`:43-44`) — **the one licensed canon-writing agent in the pipeline** | `Episodes/<ep>/script.md`, `Episodes/<ep>/outline.md`, `Canon/continuity-ledger.md`, `Canon/timeline.md`, `Canon/**/*.md` (`:51-56`) | `Canon/continuity-ledger.md`, `Canon/timeline.md`, entity sheets under `Canon/`, new files from `Canon/<type>/_TEMPLATE.md`, `Canon/technology.md` (`:59-79`) | none declared | — |
| `diff` (`:92`) | **guard** — pure decision | `[propose]` | **Pure decision → guard, but it shells `git`.** Verbatim: `if git diff --quiet -- Canon/; then printf 'NO_CHANGES'; else git diff --stat -- Canon/; echo "---"; git diff -- Canon/ \| head -400; fi` (`:95-101`). Three `git` invocations and a `head` pipe — **see §1.6**. | the git working tree under `Canon/` | none | `timeout: 15000` (`:102`) | — |
| `canon-gate` (`:105`) | **gate** | `[diff]` | Message `prompts/canon-gate.gate.md` (`:109-117`); `onReject` `prompts/canon-gate.reject.md` (`:120-130`); `max_attempts: 10` (`:138`) | `ctx.results["propose"]`, `ctx.results["diff"]` | `onReject` writes `Canon/**` | none | `when: "$diff.output != 'NO_CHANGES'"` (`:107`) → `when: (ctx) => ctx.results["diff"] !== "NO_CHANGES"`. **Do not put this `when` on a gate a `StageMap` entry points at — see F-05.** |
| `commit` (`:143`) | **script** | `[canon-gate]` | `if git diff --quiet -- Canon/; then echo …; else git add Canon/; git commit -m "canon: absorb <ep> (canon-update)"; echo …; fi` — a conditional over three git commands (`:146-154`) | the git working tree under `Canon/` | the git index and a commit | `timeout: 30000` (`:155`) | `trigger_rule: all_done` (`:145`) — so the commit still runs when `canon-gate` was bypassed for `NO_CHANGES` |

### 1.5 `deadlight-season-review.yaml` — 9 nodes (Plan D scope: deferred, spec §0:35)

| Node id | Kind | `dependsOn` | Script + argv, or decision logic | Inputs (reads) | Outputs (writes) | Timeouts | `when` / `trigger_rule` |
|---|---|---|---|---|---|---|---|
| `setup` (`deadlight-season-review.yaml:21`) | **guard** | — | Not a script. Validates `^s[0-9]+$`; requires `Canon/season-<N>.md`; **hard-refuses any season but `s1`** because every downstream prompt names `Canon/season-1.md` literally (`:24-33`) | `Canon/season-<N>.md` | none | `timeout: 15000` (`:35`) | — |
| `season-status` (`:37`) | **script** | `[setup]` | `scripts/season-status.py` — **no episode argument** (`:40`) | `Canon/season-<N>.md`, `Episodes/<prod>/STATUS.md`, `Production/<prod>/images/prompts.json`, each shot PNG, the NAS directory | nothing — read-only | `timeout: 60000` (`:41`) | — |
| `thread-auditor` (`:44`) | **agent** | `[season-status]` | `prompts/thread-auditor.md`, `medium`, tools `Read, Glob, Grep` (`:46-47`) | `Canon/continuity-ledger.md`, every `Episodes/*/script.md`, `Canon/season-1.md` (`:52-55`) | none | `idle_timeout: 900000` (`:48`) | — |
| `arc-tracker` (`:71`) | **agent** | `[season-status]` | `prompts/arc-tracker.md`, `medium`, tools `Read, Glob, Grep` (`:73-74`) | `Canon/characters/*/*.md`, every `Episodes/*/script.md`, `Canon/season-1.md` (`:79-83`) | none | `idle_timeout: 900000` (`:75`) | — |
| `craft-critic` (`:99`) | **agent** | `[season-status]` | `prompts/craft-critic.md`, `medium`, tools `Read, Glob, Grep` (`:101-102`) | `Canon/story-craft.md`, `Canon/episode-formula.md`, `Canon/series-arc.md`, `Canon/season-1.md`, every `Episodes/*/script.md` (`:105-112`) | none | `idle_timeout: 900000` (`:102`) | — |
| `desk-editor` (`:130`) | **agent** | `[thread-auditor, arc-tracker, craft-critic]` | `prompts/desk-editor.md`, model `writer`, tools `Read, Glob, Grep, Write` (`:132-133`) | `ctx.results["season-status"]` and the three lens results, `Canon/season-1.md` (`:158`) | `Canon/season-desk-report.md`, `Episodes/<prod>/launch-premise.md` — and **nothing else**, by an absolute write fence (`:199-206`) | `idle_timeout: 1800000` (`:134`) | — |
| `desk-gate` (`:209`) | **gate** | `[desk-editor]` | Message `prompts/desk-gate.gate.md` (`:212-220`); `onReject` `prompts/desk-gate.reject.md` (`:223-241`); `max_attempts: 10` (`:249`) | `ctx.results["desk-editor"]` | `onReject` rewrites the two fenced files | none | — |
| `apply` (`:252`) | **agent** | `[desk-gate]` | `prompts/apply.md`, model `large`, tools `Read, Edit, Glob, Grep` (`:254-255`) | `ctx.results["desk-gate"]` (the ruling verbatim), `Canon/season-desk-report.md` | `Canon/season-1.md`, `Canon/continuity-ledger.md` — and nothing else (`:275-277`) | `idle_timeout: 900000` (`:256`) | — |
| `commit` (`:281`) | **script** | `[apply]` | `git add` of three canon paths plus `Episodes/*/launch-premise.md`, a `git diff --cached --quiet` branch that chooses one of two commit messages, then `git commit` (`:284-295`) | the git index | the git index and a commit | `timeout: 30000` (`:297`) | — |

### 1.6 The bash nodes a single `ScriptStep` cannot express

A `ScriptStep`'s `argv(ctx)` returns **one** argv array and is spawned directly — never through a shell (`engine/src/script-step.ts:53-60`, `engine/src/steps.ts:52-54`). Fourteen of the twenty-six bash nodes do something that shape cannot carry.

| Node | What it does that one argv cannot express | What Plan D must do |
|---|---|---|
| `setup` × 5 (`deadlight-write-episode.yaml:21`, `deadlight-produce-assets.yaml:21`, `deadlight-assemble-episode.yaml:19`, `deadlight-canon-update.yaml:22`, `deadlight-season-review.yaml:21`) | Regex-validates an id, probes several paths, and **creates directories** (`mkdir -p`). A `GuardStep`'s `check` is typed to return only pass/fail (`engine/src/steps.ts:44-49`) — it has no contract for a side effect. | Split each into a `guard` for the checks (`parseEpisodeId` already does the id validation, `engine/src/ids.ts:15`) plus either a tiny `script` step for the `mkdir`, or `mkdir`s inside the first script that needs the directory. Note `Episodes/<ep>/` and `Production/<ep>/{audio,images}` are already created by the ported scripts' `os.makedirs` in several places. |
| `draft-complete-check` (`deadlight-write-episode.yaml:378`) | Passes or fails on a sentinel file, and on success **deletes it** (`rm -f`, `:408`). | A `guard` cannot delete. Either move the deletion into a `script` step after the guard, or let the guard leave the sentinel and have the next `draft` run overwrite it — see F-06, which is a correctness question and not only a shape question. |
| `outline-fix-gate` (`:182`), `review-gate` (`:796`) | Pure decisions over earlier nodes' outputs, with no file access. | `guard` steps whose `check` reads `ctx.results` and returns `{pass: true, message: "yes"\|"no"}`. **They must always pass** — F-04. |
| `diff` (`deadlight-canon-update.yaml:92`) | `git diff --quiet`, `git diff --stat`, `git diff … \| head -400` — three git invocations, a pipe, and an if/else. | `scripts/canon-diff.py` already exists in the engine (`scripts/canon-diff.py:60-71`, usage `canon-diff.py <episode> [--show-root <path>]`); Plan D should confirm its output contract matches what `prompts/canon-gate.gate.md` renders, and whether it still emits `NO_CHANGES` as the whole stdout. |
| `nano-banana-generate` (`deadlight-produce-assets.yaml:480`) | `set +e`, output capture into a variable, a second program (`image-sheet.py`), a `grep -qE 'NANO_(OK\|PARTIAL)'` over the captured text, and a conditional exit code. | Two `script` steps (`nano-banana-generate`, then `image-sheet`) plus a decision. The `NANO_PARTIAL`-is-not-a-failure rule must move **into** `nano-banana-generate.py`'s exit code, or into a `guard` that reads `ctx.results["nano-banana-generate"]` (the script executor already sets `result` to the last non-progress stdout line, `engine/src/script-step.ts:66-68`). |
| `stamp-images` (`:662`) | Three programs in sequence: `registry-append.py`, `image-sheet.py`, `status.py`. | Three `script` steps in a chain, which also gives each its own `inputs`/`outputs` and its own progress. |
| `render` (`deadlight-assemble-episode.yaml:48`) | `cd remotion && REMOTION_EPISODE=… npx remotion render …` — a directory change, an environment variable, and a relative output path. | A `script` step with `cwd: "<engine>/render"`, `env: () => ({REMOTION_EPISODE: ctx.episodeId})`, and an **absolute** output path under the show root (`render/README.md:61-66` states the relative form is wrong). |
| `commit` × 5 (`deadlight-write-episode.yaml:898`, `deadlight-produce-assets.yaml:676`, `deadlight-assemble-episode.yaml:109`, `deadlight-canon-update.yaml:143`, `deadlight-season-review.yaml:281`) | `git add` then `git commit`, and in two cases a `git diff --cached --quiet` branch choosing between two commit messages. Two of the five interpolate earlier node outputs into the commit message. | Plan D needs one engine-owned `commit` program taking the paths and a message template, or a `script` step per git command plus a guard. The messages carry show-shaped text (`"<ep>: outline + script (write-episode; panel: …)"`), which by §7.4's rule must not be hardcoded in an engine script. |

---

## 2 · The `status.py` stamping points → the stage map

**Six stamping points exist in the five workflows, not nine.** The milestone vocabulary in `scripts/status.py:14-15` names nine — `beats, outline, script, canon, casting, audio, images, assembled, finalized` — and only six are ever stamped by a workflow.

| Milestone | Stamped at | Engine stage it becomes | Which step's completion or which gate's approval marks it |
|---|---|---|---|
| `beats` | **Nowhere in any workflow.** The one occurrence on disk, `Episodes/ep01/STATUS.md:3` (`- 2026-07-13 beats: locked-beats.md`), was stamped by hand. | folded into **IDEA** (spec §3.5:108) | Nothing. `deriveStage`'s floor is already `IDEA` (`engine/src/stages.ts:62`), so no `approved` entry is needed and none should be written. |
| `outline` | `deadlight-write-episode.yaml:262` (`stamp-outline`, after `outline-gate` approval) | **OUTLINE** | `map.approved["stamp-outline"] = "OUTLINE"` |
| `script` | `deadlight-write-episode.yaml:892` (`stamp-script`, after `script-gate` approval) | **SCRIPT** | `map.approved["stamp-script"] = "SCRIPT"` |
| `casting` | `deadlight-produce-assets.yaml:274` (`stamp-casting`, after `casting-gate` approval) | **CASTING** | `map.approved["stamp-casting"] = "CASTING"` |
| `audio` | `deadlight-produce-assets.yaml:637` (`stamp-audio`, after `audio-gate` approval) | **AUDIO** | `map.approved["stamp-audio"] = "AUDIO"` |
| `images` | `deadlight-produce-assets.yaml:672` (`stamp-images`, after `image-gate` approval) | **IMAGES** | `map.approved["stamp-images"] = "IMAGES"` |
| `assembled` | **Nowhere.** Declared at `scripts/status.py:14` and stamped by no workflow; the process map records the gap at `2026-09-25-pipeline-process-map.md:394`. | **ASSEMBLY** | `map.approved["final-gate"] = "ASSEMBLY"`. Keying it on the gate works because `deriveRunState` marks an approved gate's step `completed` (`engine/src/state.ts:94-96`). |
| `finalized` | `deadlight-assemble-episode.yaml:99` (`stamp-finalized`, after `finalize`) | folded into **PUBLISH_KIT** (spec §3.5:108) | `map.approved["publish-kit"] = "PUBLISH_KIT"`. `stamp-finalized` and `publish-kit` are siblings off `finalize`; PUBLISH_KIT's definition is "final MP4 on the NAS **and** the upload kit generated", so the later of the two is the honest key. |
| `canon` | **Nowhere.** Declared at `scripts/status.py:14`; the process map records the gap at `2026-09-25-pipeline-process-map.md:235`. | **CANON** | `map.approved["commit"] = "CANON"` on the canon-update pipeline (its `commit`, `deadlight-canon-update.yaml:143`). Not `canon-gate` — that gate carries a `when` and can be bypassed for `NO_CHANGES`, and a bypassed step never advances a stage (F-05). |
| — | — | **COMPLETE** | `map.final = "COMPLETE"` (`engine/src/stages.ts:56`, taken when the run finishes with status `completed`). |

**The gates half of the map.**

| Gate step id | YAML | `DRAFT_` stage it opens |
|---|---|---|
| `outline-gate` | `deadlight-write-episode.yaml:213` | `DRAFT_OUTLINE` |
| `script-gate` | `deadlight-write-episode.yaml:856` | `DRAFT_SCRIPT` |
| `casting-gate` | `deadlight-produce-assets.yaml:240` | `DRAFT_CASTING` |
| `audio-gate` | `deadlight-produce-assets.yaml:607` | `DRAFT_AUDIO` |
| `nano-banana-gate` | `deadlight-produce-assets.yaml:503` | `DRAFT_IMAGES` |
| `image-gate` | `deadlight-produce-assets.yaml:641` | `DRAFT_IMAGES` |
| `final-gate` | `deadlight-assemble-episode.yaml:63` | `DRAFT_ASSEMBLY` |
| `canon-gate` | `deadlight-canon-update.yaml:105` | `DRAFT_CANON` |
| `desk-gate` | `deadlight-season-review.yaml:209` | `DRAFT_IDEA` — **deferred**; the season desk is not ported in the first build (spec §0:35-37), so `DRAFT_IDEA` stays reserved and unused |

**Two gates map to the same `DRAFT_` stage.** `nano-banana-gate` and `image-gate` both open `DRAFT_IMAGES`. That is legal — `StageMap.gates` is `Record<string, Stage>` and nothing forbids two keys sharing a value (`engine/src/stages.ts:31-38`) — and it means the board cannot tell the character-shot review from the whole-pile review. If Plan D wants them distinguishable, the vocabulary needs a stage the spec does not have.

**Old vocabulary with no engine stage:** `beats` (folded into IDEA) and `finalized` (folded into PUBLISH_KIT). **Engine stages with no old milestone:** every `DRAFT_` stage (the old pipeline stamped only on approval, spec §3.1:76), `NEEDS_IDEA`, `DRAFT_IDEA`, `IDEA`, `NEEDS_REFS`, `NEEDS_IMAGES`, `ASSEMBLY`, `CANON`, `COMPLETE`.

**Does `status.py` keep being called?** Two facts, and they point opposite ways.

1. **The engine does not need it.** `deriveStage` reads only `RunState` (built from the event log), the `StageMap`, and the `Needs` probes (`engine/src/stages.ts:55-78`). `STATUS.md` is nowhere in that path.
2. **Two other readers still parse it.** `scripts/season-status.py` reads `Episodes/<prod>/STATUS.md` to build the board (Plan C inventory `2026-09-28-plan-c-inventory.md:480`), and console v1 parses the line grammar with `MILESTONE_LINE_RE` (`2026-09-28-plan-c-inventory.md:673`). Spec §7.5:218 keeps console v1 and `.archon/` working on the Season 1 archive **until cutover**, and Plan F is what deletes them.

**Therefore: Plan D keeps all six `status.py` script steps.** They are cheap (a 15 s timeout, an idempotent in-place line update, `scripts/status.py:21-31`), they keep the Season 1 board readable while console v1 still exists, and they are the only thing that writes the file the assemble pipeline's `commit` adds (`deadlight-assemble-episode.yaml:113`). Plan F removes them together with the old console. **What Plan D must not do is derive a stage from `STATUS.md`** — that would put a second, drifting answer beside the log.

---

## 3 · The two `Needs` probes

`deriveStage` takes a `Needs` value with three booleans and interrupts the derived stage until the first approved stage strictly after the `NEEDS_` state is reached (`engine/src/stages.ts:40-53, 69-71`).

```
NEEDS_RULES = [
  { flag: "ideaMissing",   stage: "NEEDS_IDEA",   passedAt: "OUTLINE" },
  { flag: "refsMissing",   stage: "NEEDS_REFS",   passedAt: "CASTING" },
  { flag: "imagesMissing", stage: "NEEDS_IMAGES", passedAt: "IMAGES"  },
]
```

Nothing in the engine computes these — Plan D supplies them.

### 3.1 `refsMissing` — no reference sheet, or no locked voice

The spec asks for one flag covering two different assets. Spec §0:26: *"A recurring character with no reference sheet or locked voice stops the line at `NEEDS_REFS`."* Spec §3.4:106 names only the visual half: *"any `refs` key named in the shot list without a locked reference sheet."*

**The authoritative check for the visual half already exists in a script.** `assemble_refs` in `scripts/nano-banana-generate.py:74-93` is exactly the test that decides whether a shot can be conditioned:

```
for raw in shot["refs"]:
    key = normalize_key(raw)                       # 'Mara' -> 'mara'; 'relic (style-token…)' -> 'relic'
    entry = bible.get(key)                         # bible = Canon/refs.json minus its "_"-prefixed keys
    if not entry or not os.path.exists(entry["ref"]):
        missing.append(key)
```

`Canon/refs.json` holds 26 top-level keys, 4 of which are `_`-prefixed metadata (`_doc`, `_ruled`, `_source`, `_workflow`, `_shard_scale`); each real entry carries `kind`, `ref`, `identity` and `locked`. `ilvaren` is at `Canon/refs.json:132` with `ref: "Canon/characters/Ilvaren/Ilvaren Reference Image.jpg"`; `the-mute` is at `Canon/refs.json:114` with `ref: "Canon/characters/The Mute/The Mute Reference.png"`. Both files exist on disk.

**The voice half has no script to borrow from.** The locked cast lives in `Production/voice-refs/refs.json` under a `cast` object (`:5`) whose nine keys are `narrator, Sable, Sarn, Opha, Trent, Cricket, Remo, Mute, Ilvaren`; each carries `ref`, `ref_text`, `status`, `direction` and optionally `fx`/`speed`. `Canon/voice-registry.md:13` names that file as the source of truth and restates each row in prose (`Mute` at `:24`, `Ilvaren` at `:25`). `scripts/validate-manifest.py:126` checks `os.path.exists(c["ref"])` per cast entry — **but only after `tts-script.json` exists**, which is a whole gate too late.

**Proposed probe.** It cannot read `prompts.json` or `tts-script.json`, because neither exists at the point the stage sits (F-01). It reads the script's `[SPEAKER]` tags instead.

```
refsMissing(showRoot, episodeId) -> boolean

  script   = read  Episodes/<episodeId>/script.md
  voices   = read  Production/voice-refs/refs.json        -> .cast      (9 keys today)
  bible    = read  Canon/refs.json, dropping keys starting "_"          (21 real keys today)

  # 1 · the voice half — who speaks, from the script's own attribution tags
  #     Convention ruled 2026-09-09, taught at deadlight-produce-assets.yaml:105-114:
  #     a paragraph beginning [SABLE] names the speaker of that paragraph's quotes;
  #     UNTAGGED MEANS NARRATOR. Present in Episodes/ep10/script.md (46 tag lines);
  #     absent from ep01..ep09 (0 lines) — S2-forward only.
  speakers = { tag for tag in /^\[([A-Z][A-Z0-9 _-]*)\]/ over script's lines
                   if tag not in {"BEAT"} and not tag.startswith("PAUSE") }
  for s in speakers:
      entry = voices[ match s case-insensitively against voices' keys ]
      if entry is absent:                 return true     # no voice designed at all
      if entry.ref is absent:             return true
      if not exists(showRoot/entry.ref):  return true     # e.g. Production/voice-refs/mute.wav
      if "LOCKED" not in entry.status:    return true     # the field is prose: "LOCKED", "LOCKED (speed 1.12; …)"

  # 2 · the visual half — which recurring subjects the episode uses.
  #     There is no shot list yet, so the only available signal is the speaker set
  #     plus whatever Plan D chooses to add (see F-01 for the three options).
  for s in speakers:
      key = lowercase(s)                                  # "SABLE" -> "sable"; "MUTE" -> needs "the-mute"
      entry = bible[key]
      if entry is absent:                 return true
      if not exists(showRoot/entry.ref):  return true     # the locked reference sheet

  return false
```

**Two name-mapping faults this probe would hit today, both real.** The script tag `[MUTE]` lowercases to `mute`, and `Canon/refs.json`'s key is `the-mute` (`:114`). The voice cast key is `Mute` (`Production/voice-refs/refs.json:62`) while `showrunner.json:83-91`'s `audio.mainCast` lists neither `Mute` nor `Ilvaren`. Plan D needs an explicit tag→key map in show config, or a rule that a tag resolves against both `<tag>` and `the-<tag>`.

### 3.2 `imagesMissing` — showrunner-made images not yet dropped in

Spec §3.3:104: *"the shot list (`prompts.json`) marks each shot's source — `pipeline` or `showrunner` — and the stage is `NEEDS_IMAGES` while any `showrunner` shot lacks a PNG."*

**No such field exists.** `Production/ep10/images/prompts.json` holds 50 shots whose keys are exactly `brief, height, id, prompt, refs, scene, seed, type, width`. The discriminator on disk is `type`, whose values are `ambient` (35 shots) and `character` (15). `visual-direction`'s prompt defines them (`deadlight-produce-assets.yaml:403-432`): `ambient` is the local Z-Image builder's, `character` is Nano Banana's. **`character` no longer means "the showrunner makes it by hand"** — `scripts/nano-banana-generate.py` generates every character shot through Gemini and `scripts/image-generate.py:84-89` merely skips them locally, printing `[MISSING — drop the file here]` when the PNG is absent.

So `type == "character"` over-reports: on a normal run all 15 character shots are pipeline-made and none of them should hold the stage at `NEEDS_IMAGES`. The genuine `NEEDS_IMAGES` case is the one `prompts/nano-banana-gate.gate.md` describes (`deadlight-produce-assets.yaml:516-517`): *"Any shot you'd rather make by hand: drop the PNG in yourself and approve; an existing file is never overwritten."* That intent is expressed in a rejection note and recorded nowhere on disk.

**Proposed probe, and the show-data change it needs.**

```
imagesMissing(showRoot, episodeId) -> boolean

  path = Production/<episodeId>/images/prompts.json
  if not exists(path):  return false          # no shot list yet is not "images missing";
                                              # the stage before DRAFT_IMAGES is AUDIO, and
                                              # NEEDS_IMAGES must not fire before a list exists
  shots = read(path).shots
  for shot in shots:
      if shot.get("source") != "showrunner":  continue
      if not exists(showRoot/Production/<episodeId>/images/<shot.id>.png):  return true
  return false
```

`source` does not exist today. Plan D must add it to `prompts/visual-direction.md`'s output shape and to `prompts/nano-banana-gate.reject.md` (the fix agent sets `source: "showrunner"` on a shot the showrunner claims), and must decide whether the absent value defaults to `"pipeline"`. **Keying the probe on `type == "character"` instead would park every episode at `NEEDS_IMAGES` for three hours while Gemini works** — the opposite of what the stage means.

### 3.3 `ideaMissing`

Not one of the two probes named in the task, but `NEEDS_RULES` has three entries and Plan D must supply all three. Spec §0:37 makes an episode start at `NEEDS_IDEA` and move to `IDEA` when the showrunner supplies the premise.

```
ideaMissing(showRoot, episodeId) -> not exists(showRoot/Episodes/<episodeId>/premise.md)
```

**No `premise.md` exists anywhere in the show repository** (a glob of `Episodes/*/premise.md` matches nothing). What does exist is `launch-premise.md`, written by `desk-editor` under its write fence (`deadlight-season-review.yaml:193-195`) — present for ep09 and ep10. Plan D must rule on the filename: `premise.md` (the task's and the spec's word) or `launch-premise.md` (what is on disk and what the deferred desk writes). Whichever it picks, the other must not also be accepted, or an episode will read as having an idea from a file nothing writes.

---

## 4 · The ordering rules and the gates

### 4.1 The eight gates of spec §0:21, in the order a run meets them

| # | Gate | Pipeline | Artifact the gate shows | `max_attempts` |
|---|---|---|---|---|
| 1 | `outline-gate` | write-episode | `Episodes/<ep>/outline.md` — specifically its "Scene synopsis" section, plus `outline-canon-check`'s verdict (`deadlight-write-episode.yaml:217-226`) | 10 (`:256`) |
| 2 | `script-gate` | write-episode | `Episodes/<ep>/script.md` plus all seven reviewer verdicts (`:860-870`) | 10 (`:886`) |
| 3 | `casting-gate` | produce-assets | `Production/<ep>/tts-script.json` via `validate-manifest`'s result line and the production editor's cast/guest/heteronym summary (`:243-250`) | 10 (`:268`) |
| 4 | `audio-gate` | produce-assets | `Production/<ep>/audio/DeadLight S<ss>E<ee>.wav` (`:610-614`) | 5 (`:631`) |
| 5 | `nano-banana-gate` | produce-assets | the character PNGs under `Production/<ep>/images/` plus `IMAGE-SHEET.md` (`:506-517`) | 10 (`:549`) |
| 6 | `image-gate` | produce-assets | the whole pile under `Production/<ep>/images/` plus `image-audit`'s summary (`:644-648`) | 5 (`:660`) |
| 7 | `final-gate` | assemble-episode | `Production/<ep>/video/episode.mp4` (`:66-71`) | **2** (`:86`) |
| 8 | `canon-gate` | canon-update | `propose`'s summary plus `git diff -- Canon/`, truncated to 400 lines (`:109-117`) | 10 (`:138`) |

The ninth, `desk-gate` (`deadlight-season-review.yaml:209`, `max_attempts: 10` at `:249`), shows `Canon/season-desk-report.md` verbatim and is out of Plan D's scope.

### 4.2 Which steps must RE-RUN after each gate rejection

Spec-derived requirement, recorded as Plan D's obligation at `2026-09-28-show-config-and-prompts-deferred.md:17`: *"after `audio-gate`'s fix agent edits `tts-script.json`, synthesis, the three QC passes and the mix re-run … after `final-gate`'s, the timeline and the master; after `image-gate`'s and `image-audit`'s, ambient generation; after `nano-banana-gate`'s, character generation for the named shots."*

| Gate | What the fix agent changes | Steps that must re-run, in order |
|---|---|---|
| `outline-gate` | `Episodes/<ep>/outline.md` (`prompts/outline-gate.reject.md`) | `outline-canon-check`, `outline-fix-gate`, `outline-revise`. **Not currently re-run and not named in the deferred record** — a showrunner-directed rewrite can introduce a canon conflict the auditor already cleared. Plan D must rule (F-03). |
| `script-gate` | `Episodes/<ep>/script.md` (`prompts/script-gate.reject.md`) | the seven reviewers, `review-gate`, `revise`. **Not currently re-run.** The gate's own message renders all seven verdicts (`deadlight-write-episode.yaml:862-869`), so after one rejection it shows verdicts about a script that no longer exists (F-03). |
| `casting-gate` | `Production/<ep>/tts-script.json` | `validate-manifest` |
| `audio-gate` | `Production/<ep>/tts-script.json`; deletes named `audio/segments/<i>.wav` | `tts-generate`, `truncation-qc`, `pace-qc`, `breath-qc`, `audio-mix` |
| `nano-banana-gate` | may write `Canon/refs.json` (`deadlight-produce-assets.yaml:535-539`); names shot ids to re-roll | `nano-banana-generate` with `--only <ids> --notes "<notes>"`, then `image-sheet`. `image-generate` too **if** the refs edit changes a subject an ambient shot conditions on. |
| `image-gate` | `Production/<ep>/images/prompts.json` (ambient wording and seeds); deletes PNGs | `image-generate`, then `image-audit` (its verdict is stale), then `image-sheet`. For a character re-brief: `nano-banana-generate --only <ids>`. |
| `final-gate` | nothing on disk if the rejection is a timing note | `build-timeline`, `render`, `master` |
| `canon-gate` | `Canon/**` in the working tree | `diff` (the gate message renders `$diff.output`, `:115`) |
| `desk-gate` | `Canon/season-desk-report.md`, `Episodes/<prod>/launch-premise.md` | none — the three lenses read scripts and canon, which the fix agent's write fence forbids it to touch (`:232-241`) |

§7 answers whether this is a runner change or something `inputs` can buy.

### 4.3 Where the spec's ordering rules change the YAML's order

| Spec rule | Does the YAML already do it? |
|---|---|
| **§1.1 audio finished, reviewed and approved before any image work starts** | **Yes, already.** `visual-direction` declares `depends_on: [audio-gate]` (`deadlight-produce-assets.yaml:332`), and the comment at `:323-331` records the 2026-08-31 ruling and its cost ("visual-direction … no longer overlaps the audio branch, so the run is longer in wall-clock. That is the trade he asked for"). The file's own description block at `:8-9` still says imagery runs "in parallel with" audio and is **stale on that point** — the process map flags it at `2026-09-25-pipeline-process-map.md:243`. Plan D makes the rule a declared contract by keeping that dependency; §1.1's phrase "the Vision module takes the approved mix as an input" additionally means `visual-direction` should declare `Production/<ep>/audio/<mix>.wav` in its `inputs`, which the YAML does not. |
| **§1.2 canon is updated at the end of an episode, after the publish kit** | **No.** Today canon-update is a separate workflow whose `setup` requires only that `Episodes/<ep>/script.md` exist (`deadlight-canon-update.yaml:29`), and its description says it runs "in parallel with asset production" (`:5`). Plan D must place the canon steps **after** `publish-kit` — either as the tail of one long pipeline or as a pipeline whose `setup` guard requires `Production/<ep>/publish/upload.md`. |
| **§1.3 episode N+1 does not start until episode N's canon update is committed** | **No, nothing enforces it.** `deadlight-write-episode.yaml`'s `setup` (`:21`) checks only the id shape and the absence of `script.md`. Plan D needs a guard on the write pipeline that refuses when the previous episode's CANON stage is not reached. Since the engine derives stage from the previous episode's run log, that guard reads a log, not a file. |
| **§0:13 premise as input** | **No.** The premise arrives today as free text in `$ARGUMENTS`, parsed by `awk 'NR==1{print $1; exit}'` inside `setup` (`deadlight-write-episode.yaml:25`), with the rest of the multi-line message read by the `outline` prompt as `$ARGUMENTS` (`:48`). The engine has no `$ARGUMENTS`: `2026-09-27-agent-runner-deferred.md:19` assigns "`$ARGUMENTS` (the premise) → a Plan D result key the setup step writes." So `setup` becomes a guard that reads `Episodes/<ep>/premise.md` (or `launch-premise.md`, §3.3) and returns its text as the guard's `message`, which lands in `ctx.results["setup"]` (`engine/src/runner.ts:225-226`) for `prompts/outline.md` to render as `{{results.setup}}`. |

### 4.4 The gate order inside `deadlight-produce-assets.yaml`, stated once

The dependency graph is not the reading order of the file. In execution order: `setup` → `tts-script` → `validate-manifest` → **`casting-gate`** → (`stamp-casting` ‖ `tts-generate` → `truncation-qc` → `pace-qc` → `breath-qc` → `audio-mix`) → **`audio-gate`** → (`stamp-audio` ‖ `visual-direction`) → (`image-generate` [also waits on `audio-mix`] ‖ `nano-banana-generate`) → **`nano-banana-gate`** → `image-audit` → **`image-gate`** → `stamp-images` → `commit`.

---

## 5 · The canon reviewer

### 5.1 What the two checks do today

| | `outline-canon-check` | `continuity-check` |
|---|---|---|
| Prompt | `prompts/outline-canon-check.md` (from `deadlight-write-episode.yaml:161-180`) | `prompts/continuity-check.md` (from `deadlight-write-episode.yaml:431-451`) |
| Schema | `prompts/outline-canon-check.schema.json` — `{pass: boolean, verdict: "OUTLINE PASSED"\|"OUTLINE FAILED", issues: string[]}`, `required: [pass, issues]` (`:147-159`) | `prompts/continuity-check.schema.json` — same shape, verdict enum `"DRAFT PASSED"\|"DRAFT FAILED"` (`:417-429`) |
| Subject | `Episodes/<ep>/outline.md` | `Episodes/<ep>/script.md` and `Episodes/<ep>/outline.md` |
| Rubric | `Canon/world-overview.md`, `Canon/technology.md`, `Canon/characters/The Mute/the-mute.md`, `Canon/timeline.md`, `Canon/continuity-ledger.md`, `Canon/season-1.md` if a RULED slate entry exists, `Episodes/<ep>/locked-beats.md` if present (BINDING — beats may be enriched, never reordered, removed or merged), plus the entity sheets the outline uses (`:166-173`) | the same canon spine plus "every character/species/location/faction file for entities appearing in the script (Glob `Canon/**/*.md`)" (`:436-442`) |
| Extra duties | flags undeclared new or retroactive canon missing from the outline's "## New canon proposed", undeclared arc beats, and death-rule violations (`:174-176`) | flags characters acting against their sheets, tech violating the tier ladder, Mute behaviour violating `the-mute.md`, timeline impossibilities, and new canon-worthy facts that conflict (`:444-447`) |
| Issue format | `"<beat> — <what conflicts> — <file that says otherwise>"` (`:178`) | `"<script location> — <what conflicts> — <canon file that says otherwise>"` (`:449`) |
| Consumer | `outline-fix-gate` reads `.pass` (`:185`); `outline-revise` renders the whole JSON (`:200`) | `review-gate` reads `.pass` (`:799`); `revise` renders it (`:826`); `script-gate` shows it (`:863`) |
| Writes | nothing — tools are `Read, Glob, Grep` | nothing — same allowlist |

Both are read-only, `model: medium`, `context: fresh`. Both treat **every** discrepancy as a defect routed to an auto-fix loop.

### 5.2 What the spec asks the single canon reviewer to do differently

Spec §2 (`2026-09-25-console-rewrite-design.md:53-70`), four changes:

1. **One agent, run twice** (§2.1:55). One prompt file reviews the outline against the canon store, and later the script against the canon store **and the approved outline** — "an approved outline is approved canon for that episode." It reads only; it never edits. Today's two prompts differ in subject and in rubric breadth, so merging them means one prompt with a subject parameter, or one prompt file used by two steps with different `inputs`.
2. **Provenance, not just conflict** (§2.2:57-62). For each discrepancy the reviewer decides who introduced it. **Agent-introduced** → a defect, routed to the auto-fix loop exactly as today; the showrunner never sees it unless the loop exhausts. **Ryan-introduced** — traceable to his launch premise, his `locked-beats.md`, a gate rejection note, or a hand edit — → a deliberate deviation, **logged and NOT fixed**, shown at the gate as information.
3. **How provenance is decided** (§2.3:64). The premise and `locked-beats.md` are his words; gate rejection notes are captured by the gate (`ctx.results["<gate-id>:rejection"]`, `engine/src/runner.ts:328`); a hand edit is "any file whose current content hash differs from the hash the engine recorded when an agent step last wrote it" — `step_completed`'s `outputHashes` (`engine/src/runner.ts:282`). **Tie-breaker when provenance is unclear: adhere** (§2.3:66) — treat it as an agent slip and let the loop fix it.
4. **The end-of-episode canon moment consumes the ledger** (§2.5:70). Accepted deviations become AS SHIPPED canon changes; fixed items are moot; the librarian's new-facts proposal is presented alongside. **One gate, one commit.**

### 5.3 The ledger file — proposed path and shape

Spec §2.2:62 names the path: **`Episodes/<episodeId>/canon-ledger.md`**. It does not exist for any episode today. Proposed shape, chosen so `propose` can consume it mechanically at the canon moment and so a reader can tell what shipped:

```markdown
# Canon ledger — <episodeId>

> Deliberate deviations from the canon store, recorded by the canon reviewer
> because their provenance is the showrunner's, not an agent's. Consumed at the
> end-of-episode canon moment: each ACCEPTED row becomes an AS SHIPPED canon
> change; each WITHDRAWN row is dropped.

| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |
|---|---|---|---|---|---|---|
| 1 | `script.md` SCENE FOUR | Opha walks the wreck unsuited | `Canon/characters/Opha/opha.md:41` | Ryan — rejection note | `script-gate` attempt 2, run `<runId>` | ACCEPTED |
| 2 | `outline.md` beat 7 | Grother's crew is four, not six | `Canon/characters/Grother/grother.md:18` | Ryan — premise | `Episodes/<id>/premise.md` | ACCEPTED |
| 3 | `script.md` SCENE TWO | A hum heard in vacuum | `Canon/technology.md` | Ryan — hand edit | output hash of `script.md` differs from `step_completed` of `draft`, run `<runId>` | WITHDRAWN |
```

Every row is readable cold, carries its own address, and names the run that produced the evidence. `Disposition` is written by the canon moment's gate, not by the reviewer — the reviewer writes `PENDING`.

### 5.4 Prompt change (show data) versus engine or pipeline change

| The change | Prompt (show data) | Engine or pipeline |
|---|---|---|
| One prompt file instead of two | **Prompt.** One new `prompts/canon-review.md` replaces `prompts/outline-canon-check.md` and `prompts/continuity-check.md`; the schema grows a `provenance` field per issue, so `prompts/canon-review.schema.json` replaces the two schema files. | — |
| Reading the approved outline when reviewing the script | **Prompt** (the instruction) | **Pipeline** — the script-stage step declares `Episodes/<ep>/outline.md` in its `inputs`. |
| Deciding provenance from the premise and `locked-beats.md` | **Prompt** — both are files the agent can read with `Read`. | — |
| Deciding provenance from a gate rejection note | — | **Pipeline.** The notes live in `ctx.results["<gate-id>:rejection"]`, which the runner sets only inside a gate's own `onReject` context (`engine/src/runner.ts:328`) and **not** in the surrounding run context. A canon reviewer running as an ordinary step cannot see them. Plan D must either make the reviewer the gate's `onReject` agent, or have the gate's fix agent append the note to `canon-ledger.md` itself, or add a runner change that keeps rejection notes in `ctx.results` for the rest of the run. **This is the one part of §2.3 the current engine cannot supply** (F-08). |
| Deciding provenance from a hand edit (content hash) | — | **Engine.** The hashes are in the log (`step_completed.outputHashes`), not on disk. An agent step's context is `RunContext`, which carries `results` and nothing about hashes (`engine/src/steps.ts:16-26`). Plan D must compute the comparison outside the agent and pass the answer in, e.g. a `guard` step that reads the log and writes a "hand-edited files" list into `ctx.results` for the reviewer's prompt to render. |
| **Writing** `canon-ledger.md` | — | **Pipeline.** §2.1 says the reviewer "reads only; it never edits", and today's allowlist is `Read, Glob, Grep`. A reviewer that writes the ledger needs `Write`, which contradicts §2.1. The clean split is: the reviewer returns the ledger rows in its verdict JSON, and a `script` step writes the file. Plan D must rule. |
| The end-of-episode "should we update canon" moment | **Prompt** — `prompts/propose.md` gains a section that reads `Episodes/<ep>/canon-ledger.md` and turns each ACCEPTED row into an AS SHIPPED edit. | **Pipeline** — the canon steps move to after `publish-kit` (§1.2), and `canon-gate`'s message renders the ledger alongside the diff. |

---

## 6 · The loop sentinels and iteration caps

| Loop | YAML | Body prompt | Sentinel (`until`) | Cap | Context | Sentinel file | Does the body read disk state, so a resumed iteration is safe? |
|---|---|---|---|---|---|---|---|
| `outline-revise` | `deadlight-write-episode.yaml:189` | `prompts/outline-revise.md` | `OUTLINE_FIXED` (`:208`) | 2 (`:209`) | `shared` (`fresh_context: false`, `:210`) | none | **Yes.** The body is told to reread the cited canon file and fix "the beat at its root", and the completion test is "when every listed issue is genuinely resolved **in the current text**" (`:206-207`). The findings come from `ctx.results["outline-canon-check"]`, which the engine re-renders every iteration. A resumed iteration reads the outline as it now stands. |
| `draft` | `deadlight-write-episode.yaml:266` | `prompts/draft.md` | `DRAFT_COMPLETE` (`:352`) | 15 (`:353`) | `fresh` (`fresh_context: true`, `:364`, ruled 2026-08-28 after ep09) | **`Episodes/<ep>/.draft-complete`**, containing the finished script's word count (`:344-346`) | **Yes, and deliberately so.** Steps 1-6 of the body re-read `Canon/style-guide.md`, `Canon/story-craft.md`, the outline, and `script.md` as written so far, then "identify the NEXT outline beat that has no scene yet" (`:276-292`). The comment at `:354-363` states the design: "This loop is written to be stateless — its own prompt re-reads … every time — so a shared session bought nothing and made the node fragile." |
| `revise` | `deadlight-write-episode.yaml:814` | `prompts/revise.md` | `REVISIONS_COMPLETE` (`:847`) | 3 (`:848`) | `shared` (`fresh_context: false`, `:849`) | none | **Partly.** Step 1 is "work through EVERY issue listed above **that you have not yet fixed**" and step 4 is a self-audit against the current text (`:835-843`) — both disk-derived. But the loop runs `shared`, and the engine does not recover a session after a restart (`engine/src/steps.ts:73-76`), so a resumed iteration loses the conversation and relies entirely on re-reading `script.md`. The prompt does instruct that re-read, so it survives; the risk is a fix already applied being re-applied. |
| `image-audit` | `deadlight-produce-assets.yaml:552` | `prompts/image-audit.md` | `IMAGES_CLEAN` (`:602`) | 3 (`:603`) | `shared` (`fresh_context: false`, `:604`) | none | **Yes for reading, no for safety.** Each iteration re-reads `Canon/visual-style.md`, `prompts.json` and **every PNG** in the images directory (`:562-563`), so the verdict is always about what is on disk. But its fixes are destructive and re-applied blind: "rewrite its prompt POSITIVELY in `prompts.json`, **bump its seed +1000**, delete that PNG" (`:588-590`). A resumed iteration that cannot tell it already bumped a seed bumps it again. |

### 6.1 How `draft-complete-check` decides

`deadlight-write-episode.yaml:394-409`, verbatim logic:

```
EP=$setup.output
S="Episodes/$EP/script.md"
SENT="Episodes/$EP/.draft-complete"
WORDS=$(wc -w < "$S" 2>/dev/null | tr -d ' ')
if [ ! -f "$SENT" ]; then
  echo "ERROR: the draft loop never signalled completion for $EP."
  … four more lines naming the word count and the ep09/ep10 failure …
  exit 1
fi
echo "draft complete for $EP — $WORDS words, sentinel present."
rm -f "$SENT"
```

The decision is **file presence only** — the word count is printed, never compared to a threshold. `trigger_rule: all_done` (`:393`) is load-bearing: the comment at `:380-384` records that v1 of this guard used the default rule and was itself skipped the moment `draft` failed to complete, which is the exact condition it exists to catch.

### 6.2 What the engine changes about loop failure, and the one loop that still has no guard

**The engine already fixes the class of bug `draft-complete-check` was built for.** `runLoopStep` treats exhausting the cap without the sentinel as a **failure**: `step_failed` with `exhausted ${maxIterations} iterations without sentinel ${until}` (`engine/src/runner.ts:382-384`). Archon instead completed the node, which is how ep09 and ep10 reached a gate with a partial script. In the engine a failed step skips every dependent (`engine/src/runner.ts:154-161, 186-201`) and `state.ts:75` distinguishes `skipped` from `bypassed`, so **a failing loop can stop a gate from opening** — the "known remaining gap" the YAML documents at `:386-392` closes by construction.

**`image-audit` has neither a sentinel file nor a guard, and it has already failed this way in production.** `.agent-logs/ep10-nano-gate-approve-20260915-131930.log` records `{"nodeId":"image-audit","iteration":2,"durationMs":3946,"msg":"loop_node.iteration_empty_output"}` — iteration 2 returned an empty output in 3.9 seconds, the same zero-work signature as the ep09 and ep10 draft failures. In that run Archon did fail the layer (`dag_layer_had_failures`) and skipped `image-gate`, `stamp-images` and `commit`, so the run ended `Workflow failed`. Under the engine an empty-output iteration is not itself an error — `r.text.includes(step.until)` is simply false (`engine/src/runner.ts:374`) — so the loop would burn its remaining iterations and then fail on the cap. That is the right outcome, but it costs the cap and reports "exhausted", not "an iteration did nothing". Spec §6.7:180 asks for exactly the better signal: *"an iteration with zero tool calls is flagged on the dashboard the moment it happens."* The engine records `toolCalls` on each `loop_iteration` (`engine/src/runner.ts:375`), so the flag is a console concern — except on a failed iteration, where the number is hardcoded to `0` and therefore indistinguishable (see §7).

---

## 7 · The engine changes Plan D needs

Each row cites the deferred record that assigns the change to Plan D.

| # | Change | Deferred-record line | What it is |
|---|---|---|---|
| 7.1 | **The loop-resume sentinel check.** A loop resumed after a crash ignores a recorded `sentinel: true`: `runLoopStep` counts this run's `loop_iteration` events to resume the counter but never inspects the last one's `sentinel`, so a crash landing between the final `loop_iteration` and `step_completed` resumes as exhausted. | `2026-09-26-engine-core-deferred.md:27` | Three lines in `runLoopStep` (`engine/src/runner.ts:354-364`): if the last `loop_iteration` since this step's most recent `step_started` carries `sentinel: true`, complete the loop without calling the body. The record asks for a hand-written-log test. **Load-bearing for `draft`:** a 15-iteration loop whose last iteration wrote the sentinel file and then crashed would, today, re-run the body — and `draft-complete-check` has already deleted nothing yet, so the body would see the sentinel and re-signal, but a `draft` that resumed as *exhausted* fails the whole pipeline after hours of work. |
| 7.2 | **`StageMap` key validation.** Keys are not validated against pipeline step ids; a typo degrades silently. | `2026-09-26-engine-core-deferred.md:29` | Plan D validates its map's keys against `pipeline.steps` at load time and its values with the exported `isStage()` (`engine/src/stages.ts:23-25`). With 17 entries and step ids that repeat across pipelines (`commit` and `setup` each appear five times), a typo is likely and invisible: `deriveStage` simply never advances past `IDEA`. |
| 7.3 | **`loop_iteration.toolCalls` on a failed iteration.** The value is hardcoded `0` even though the executor knows the real count and records it on `agent_result`. | `2026-09-27-agent-runner-deferred.md:29` | `engine/src/runner.ts:370` emits `toolCalls: 0` on the failure path. Carry `toolCalls` on `AgentOutcome`'s failure variant (`engine/src/steps.ts:136-138`) and make the number true. Until then the dashboard cannot distinguish "an iteration that failed after doing real work" from "an iteration that did nothing", which is precisely the ep09/ep10/ep10-image-audit signature. |
| 7.4 | **Gate rejection must re-run the dependent steps.** | `2026-09-28-show-config-and-prompts-deferred.md:17` | **A runner change. Plan D cannot express it as `inputs` on the script steps.** See the reasoning below. |
| 7.5 | **`untilVerdict`, if any loop needs a verdict.** A loop body may not carry a schema; `orderSteps` refuses the pipeline at load time (`engine/src/pipeline.ts:42-46`), because a schema step's final text is the serialized verdict and a prose sentinel would match substrings of the JSON. | `2026-09-27-agent-runner-deferred.md:28` | **No loop needs it.** All four loops are text-sentinel bodies with no `output_format`: `draft` (`DRAFT_COMPLETE`), `outline-revise` (`OUTLINE_FIXED`), `revise` (`REVISIONS_COMPLETE`), `image-audit` (`IMAGES_CLEAN`). `prompts/index.json` confirms no loop row carries a `schema` field. Plan D does not add `untilVerdict`. |
| 7.6 | **Fan-out of the review panel.** The runner executes steps one at a time in dependency order, so the seven reviewers run sequentially. | `2026-09-27-agent-runner-deferred.md:33` | Measured below. **Cost: 35 minutes 50 seconds per review round, on real numbers.** |
| 7.7 | **`LoopStep.progress` for `draft`.** §6.7 disk-derived in-loop progress belongs to Plan D. | `2026-09-26-engine-core-deferred.md:33`, `:86` | A `progress(ctx)` probe counting `^## ` scene headers in `Episodes/<ep>/script.md` against the numbered beats in `Episodes/<ep>/outline.md`. Declare `inputs`/`outputs` on the **loop**, not the body (`2026-09-26-engine-core-deferred.md:30`). |
| 7.8 | **`NestedAgentStep` typing, and the `StructuredOutput` filter.** `Omit` blocks `when`/`dependsOn` on fresh object literals only; and the tool-name filter is unconditional. | `2026-09-27-agent-runner-deferred.md:32`, `:31` | Plan D types its nine `onReject` agents and four loop bodies as `NestedAgentStep`, which is what makes the omission enforced. Gating the `StructuredOutput` drop on `outputFormat` being set is a two-line hardening Plan D adds with its first schema steps — and it has eight of them (the seven reviewers plus `outline-canon-check`, or in §5's design, six reviewers plus one canon reviewer). |

### 7.4 in detail — is the gate-rejection re-run a runner change, or can `inputs` buy it?

**It is a runner change. `inputs` cannot buy it.** Three facts from `engine/src/runner.ts`, in the order they apply:

1. `execute()`'s main loop reads each step's derived status and, at `engine/src/runner.ts:138`, does `if (status === "completed") continue;` — **before** `runStep` is called.
2. `runScriptStep`'s cache check, including the input-hash comparison and the `step_cached` / `input_changed` emits, lives inside `runScriptStep` (`engine/src/runner.ts:242-260`). A step skipped at line 138 never reaches it.
3. `deriveRunState` marks a step `completed` on `step_completed` **or** `step_cached` (`engine/src/state.ts:54-61`), and those events are in this run's own log.

So after `audio-gate`'s fix agent edits `Production/<ep>/tts-script.json`, the five audio steps are already `completed` in the current run's log and are skipped at line 138 without their hashes ever being compared. The `input_changed` event that would announce the edit is never emitted, and `step_cached` is never even reached. The hash cache is a **cross-run** mechanism — `lastCompletion` searches `[...priorEvents, events]` (`engine/src/runner.ts:171`, `:53-71`) and is consulted only for a step that has not yet completed in this run.

Two further consequences worth stating plainly:

- **The cache requires declared inputs to fire at all.** `if (prior && inputs.length > 0)` (`engine/src/runner.ts:249`). A script step with no `inputs` is never served from cache and never emits `input_changed`. This is spec §6.3's "declaring inputs is mandatory" made mechanical.
- **Agent steps have no cache path whatsoever** (`engine/src/runner.ts:272-284`), so `script-gate`'s re-run set — the seven reviewers — could not be handled by hashes even if the status check were removed.

**What the change has to be.** Something in `runGateStep` or in `execute()` must reset the status of a named set of steps after a rejection, so the runner re-executes them. Two shapes, both Plan D's to choose:

- **Declarative, on the gate:** add `rerunOnReject?: StepId[]` to `GateStep` (`engine/src/steps.ts:94-103`). After the fix agent completes, the runner emits a `step_skipped`-like reset (or a new event kind) for each named step and clears it from `state.steps`, so the loop re-executes it. The re-execution is then logged as a new `step_started` following the old one, which is the resume contract's own convention (`README.md`, resume contract).
- **Derived, from the gate's re-run graph:** after the fix agent completes, hash every declared `input` of every step downstream of the gate's dependencies, compare against the recorded `outputHashes`, and reset any step whose inputs changed. This needs no new field but does need the runner to walk the graph backwards, and it silently does nothing for the seven reviewers, which declare no `outputs` at all.

The declarative shape is the one that makes the six rewritten prompts' sentence true — "the pipeline re-runs … before this gate reopens; do not run any script yourself" (`2026-09-28-show-config-and-prompts-deferred.md:17`) — for every gate, including the agent-only cases.

### 7.6 in detail — the fan-out measurement

**How many agent steps could run concurrently, per pipeline.** Counting maximal sets of agent or loop steps whose `depends_on` lists are satisfiable at the same moment:

| Pipeline | Largest concurrent agent set | The steps |
|---|---|---|
| `deadlight-write-episode` | **7** | `continuity-check`, `tone-check`, `flow-check`, `character-check`, `structure-check`, `environment-check`, `repetition-check` — all seven declare `depends_on: [draft-complete-check]` |
| `deadlight-season-review` | **3** | `thread-auditor`, `arc-tracker`, `craft-critic` — all three declare `depends_on: [season-status]` |
| `deadlight-produce-assets` | **1** | `tts-script`, `visual-direction` and `image-audit` are strictly ordered behind gates; no two agent steps are ever simultaneously ready |
| `deadlight-canon-update` | **1** | `propose` only |
| `deadlight-assemble-episode` | **0** | the pipeline has no agent step except the gate's `onReject` |

Archon did fan these out: `.agent-logs/ep10-script-approve-20260909-104913.log:35` records `{"workflowName":"deadlight-write-episode","nodeCount":21,"layerCount":15}` — 21 nodes in 15 layers, and the seven reviewers are one of them.

**The wall-clock difference, from a real run rather than from timeouts.** *The seven reviewers declare no `timeout` and no `idle_timeout` in `deadlight-write-episode.yaml` — the only timeouts in that file sit on bash nodes (15 s / 30 s) and the three loops (`idle_timeout: 900000`), so the YAML's timeouts cannot supply this number.* The measurement comes instead from `.agent-logs/ep10-draft-finish-20260907-092413.log`, where all seven started at 09:34:55 on 2026-09-07:

| Reviewer | Completed | Duration |
|---|---|---|
| `repetition-check` | 09:39:30 | 275 s |
| `character-check` | 09:39:34 | 279 s |
| `structure-check` | 09:40:12 | 317 s |
| `environment-check` | 09:40:26 | 331 s |
| `flow-check` | 09:42:01 | 426 s |
| `tone-check` | 09:43:37 | 522 s |
| `continuity-check` | 09:44:31 | 576 s |

- **Concurrent (Archon, measured):** 576 s = **9 min 36 s** — the slowest reviewer.
- **Sequential (the engine's runner, as it stands):** 2,726 s = **45 min 26 s** — the sum.
- **Penalty: 2,150 s = 35 min 50 s per review round.** `revise` allows up to 3 iterations and `script-gate` up to 10 rejections; each rejection that re-runs the panel (§4.2) pays the penalty again.

The same measurement for the season desk's three lenses, `.agent-logs/season-review-s1-complete-20260916-132553.log`, all three started 13:25:54: `arc-tracker` 388 s, `thread-auditor` 418 s, `craft-critic` 463 s. Concurrent 463 s = 7 min 43 s; sequential 1,269 s = 21 min 9 s; **penalty 806 s = 13 min 26 s**. (The earlier run, `.agent-logs/season-review-s1-20260904-212135.log`, gives 577 s concurrent against 1,343 s sequential — penalty 766 s.)

**Other real durations from the same logs**, useful for the timeouts Plan D must choose (`prompts/index.json` records `timeoutMs` on no row): `tts-script` 2,136 s (35 min 36 s, `.agent-logs/ep10-produce-repause-20260910-165724.log`); `propose` 440 s (`.agent-logs/canon-update-ep09-20260903-113453.log`); `desk-editor` 511 s and `apply` 858 s (`.agent-logs/season-review-s1-complete-20260916-132553.log`, `.agent-logs/desk-approve-s1-final-20260917-120353.log`); Remotion `render` 877 s for ep10 against a 4-hour ceiling (`.agent-logs/ep10-assemble-20260915-145553.log`); `master` 140 s.

**A note on what parallel execution costs.** `engine/src/runner.ts:171` is a single `await` inside a `for` loop, and every event is appended through one `log.append`. Running steps concurrently means the log's order stops being the execution order — the deferred record's own condition, "with log order still authoritative" (`2026-09-27-agent-runner-deferred.md:33`), is the constraint to hold. Seven concurrent Agent SDK queries also multiply the rate-limit exposure; `.agent-logs/ep10-nano-gate-approve-20260915-131930.log` shows `claude.rate_limit_event` lines with `"overageStatus":"rejected","overageDisabledReason":"out_of_credits"` during ep10's image work, so the panel's seven-way fan-out is not free of that risk.

---

## 8 · The first real run

### 8.1 Which episode, and its premise

The show's Season 2 episode 1 is **`s02e01`**. Its plan is `Canon/season-2.md:69`, the first row of the slate table (header at `:67`, separator at `:68`). Quoted in full is 3,900 characters; the load-bearing parts, verbatim:

> `| 1 | **RULED** | **"The Word For It"** — The crew learns what its own rule costs, in money, and the season opens on that bill rather than on any mythology. **Remo was not in the room when the rule was made.** … **Act one, at Coalvane: three claims and an argument.** … **Act two, on the job: Opha feels it, and Cricket logs it.** … **Act three, back at Coalvane: the correlation and the argument.** … **Opha closes it with the episode's question — she felt the artifact and she did not feel him.** **Sarn ends it as an order rather than an argument: the rule stands.** … | Remo carries the POV and the dissent. Sarn ends the argument by authority rather than persuasion. Opha supplies the question. Cricket makes the discovery | The grading economics: possession is safe and proof is not, so the rule is a permanent tax rather than a one-time cost. … | **The doubt opens, correct and incomplete.** `continuity-ledger.md:33` is opened toward payment. **Opha's habituation clock starts here** … **Cricket takes the first measurement of Opha's range**, which is the seed of episodes 4 and 5 |`

Three of the twenty rows carry `**RULED**` (episodes 1, 2, 3); the other seventeen carry `**DRAFT**`.

### 8.2 What must exist before `NEEDS_IDEA` clears

| Requirement | State on disk |
|---|---|
| `Episodes/s02e01/premise.md` | **Does not exist. `Episodes/s02e01/` does not exist.** `Episodes/` holds `_retired`, `_TEMPLATE`, `ep01`–`ep10`, `ep98`. No `premise.md` exists for any episode; the analogous file that does exist is `launch-premise.md` (present for `ep09` and `ep10`), written by `desk-editor` (`deadlight-season-review.yaml:193-195`). |
| The premise's content | Must be written by hand. Spec §0:13 — "in the first build the showrunner writes it" — and §0:35 defers the desk that would draft it. `Canon/season-2.md:69` is the source to write it from. |
| `Production/s02e01/` | Does not exist. Created by the produce-assets `setup` node's `mkdir -p` (`deadlight-produce-assets.yaml:32`). |

### 8.3 References and voices for the S2 cast

| Subject | Locked voice | Locked reference sheet |
|---|---|---|
| **Ilvaren** (Elyth benefactor, recurring from S2 ep 2-3) | **Yes.** `Production/voice-refs/refs.json:71` — `ref: "Production/voice-refs/ilvaren.wav"`, `status: "LOCKED"`, no fx, `speed: 1.0`. The WAV exists (904 KB, dated 2026-09-18). Restated at `Canon/voice-registry.md:25` — "**S2 — LOCKED 2026-09-18** … designed i2 ('the auditor'), candidate 1. **NO FX.**" | **Yes.** `Canon/refs.json:132` — `ref: "Canon/characters/Ilvaren/Ilvaren Reference Image.jpg"`, `kind: "character"`, registered 2026-09-18, three-view plus expression/age insets. The file exists (2.4 MB). The `locked` field records that the sheet's printed title reads "Ilvargen" and that "the canonical name is **Ilvaren** (Ryan-ruled 2026-09-18). Image text is not authority." |
| **the Mute** | **Yes.** `Production/voice-refs/refs.json:62` — `ref: "Production/voice-refs/mute.wav"`, `status: "LOCKED"`, `fx: ""`, `speed: 1.0`. The WAV exists (746 KB, 2026-09-18). Its `note` field and `Canon/voice-registry.md:24` both record the binding constraint: he "speaks exactly twice in the series, both in S2 (hinge + ep20)" and "**the voice must be IDENTICAL both times — he does not age.**" `Canon/season-2.md:78` repeats it as a production constraint on episode 10. | **Yes.** `Canon/refs.json:114` — `ref: "Canon/characters/The Mute/The Mute Reference.png"`, registered 2026-09-01 for ep09's coda reveal, an author's-eyes reference ("the audience never sees inside the hood"). The file exists (7.7 MB). |
| **The Elyth species baseline** | n/a | **Yes.** `Canon/refs.json` `elyth` and `elyth-female`, sheets registered 2026-09-18 "for the S2 benefactor arc". |
| The seven S1 mains | **Yes**, all `LOCKED 2026-07-15` (`Production/voice-refs/refs.json:5-61`), WAVs present | `dead-light`, `remo`, `sarn`, `opha`, `cricket`, `sable`, `trent` all in `Canon/refs.json` |

**So `refsMissing` would be false for `s02e01` on both halves** — the S2 cast is fully locked. **One gap that is not a `Needs` problem but will produce a warning every S2 episode:** `showrunner.json:83-91`'s `audio.mainCast` lists only `narrator, Sarn, Sable, Trent, Opha, Cricket, Remo`. `scripts/validate-manifest.py:160-165` treats any speaker outside that list as a guest and flags a first line under five words as a runway violation, so `Mute` and `Ilvaren` — both locked mains for S2 — will be warned about as guests.

### 8.4 What the cutover sequence requires, and whether Plan D runs `s02e01`

Spec §7.5:218 gives one ordered sequence: **the engine reads `sXXeYY` (§5.4); Season 1 is renamed in one commit; `console/`, `.archon/`, `remotion/` and the root `package.json` are deleted from `DeadLight`; the first Season 2 episode runs on the new engine. Until cutover, nothing in `DeadLight` is removed.**

**The rename is Plan F's, but the first item of the sequence is already done.** `engine/src/ids.ts:12` accepts `^s(\d{2})e(\d{2})$` as an `aired` id; `show-config.ts:124-130`'s `seasonOf` reads the season off an aired id and never consults the `airMap`; `show-config.ts:74-79` **refuses** an aired id as an `airMap` key, precisely so there is never a second answer. So `s02e01` needs no `airMap` entry, and `showrunner.json:14-55`'s ten `ep01`–`ep10` entries stay untouched until Plan F.

**Plan D can therefore run `s02e01` directly, and should.** The whole path works on an aired id without the rename: `parseEpisodeId("s02e01")` → `{kind:"aired", season:2, episode:1}`; `scripts/audio-mix.py:14-31` names the mix `DeadLight S02E01.wav`; `scripts/finalize-video.py:108-120`'s `resolve_slot` returns `(2,1)` from `sc.season_of` without reaching the season-document fallback; `scripts/publish-kit.py:107` builds the slug `S02E01`. Nothing in that chain needs Season 1 renamed. **Plan F's rename is required for ordering across seasons, not for running one S2 episode** — the repetition reviewer's "two highest-numbered episodes below this one" (`deadlight-write-episode.yaml:756-758`) is the case that breaks, because globbing `Episodes/ep*/script.md` from `s02e01` finds `ep01`–`ep10` under a different shape and cannot sort them against it.

**What `Episodes/` and `Production/` hold for ep98 and ep99, and whether they are usable test episodes.**

| | `ep98` | `ep99` |
|---|---|---|
| `Episodes/` | `Episodes/ep98/` holds `outline.md` (27 KB), `script.md` (37 KB), `STATUS.md` | **No `Episodes/ep99/`.** It is at `Episodes/_retired/ep99/`, holding `outline.md`, `script.md`, `RETIRED.md` |
| `Production/` | `Production/ep98/` holds `tts-script.json` (93 KB), `audio/` with `DeadLight S01E09.wav` (101 MB), `audio/manifest.json`, `audio/segments/` (512 WAVs), `images/` (43 entries), `video/` | `Production/ep99/` holds `tts-script.json` (83 KB) and `audio-spike/cold-open.wav` (103 MB). No segments, no images, no video |
| `STATUS.md` | `Episodes/ep98/STATUS.md:3` — `- 2026-07-12 finalized: NAS DeadLight S01E09.mp4 (reprocess pending)`. `:6-12` carries **`## DEAD ARTIFACT (Ryan-ruled 2026-08-27)`**: "This production and its script are **non-canon and superseded** … **Do not read, cite, or lift from `Episodes/ep98/script.md`** — it is not a draft source. Kept only as production history." | none |
| Usable as a test episode? | **For the audio and image branches, yes; for the full pipeline, no.** Its `tts-script.json` and 512 rendered segments make `truncation-qc`, `pace-qc`, `breath-qc` and `audio-mix` runnable without three hours of synthesis, and `audio-mix.py:12,28` names its mix `episode.wav` because `ep98` is not in `showrunner.json`'s `airMap`. But `scripts/finalize-video.py:129-131` **hard-exits** for it: `ep98` is not in the `airMap`, and no RULED row in any season document defaults to the production id `ep98`. So an assemble run on `ep98` cannot reach `finalize`, `stamp-finalized` or `commit`. | **No.** No episode directory outside `_retired`, no rendered audio segments, no images, no video. Only a manifest and one spike WAV. |

**Recommendation for Plan D, stated as the choice it must make.** Use `ep98` for the engine's own integration exercise up to `audio-mix` and up to `image-audit` (its 43 image entries and rendered segments are free test data, and the DEAD ARTIFACT note means nothing written to it matters), and make **`s02e01` the first real run** — which is what spec §7.5 asks for and what §8.3 shows the bible is ready for. Do not attempt a `finalize` on `ep98`; if a NAS-write test is needed, add a temporary `airMap` entry and remove it, or test `finalize-video.py` against a fixture.

---

## 9 · Findings

| # | Finding | `file:line` | The question Plan D's author must answer |
|---|---|---|---|
| **F-01** | **`NEEDS_REFS` cannot be probed where the spec places it.** §3.4 puts `NEEDS_REFS` between SCRIPT and DRAFT_CASTING and derives it from "any `refs` key named in the shot list without a locked reference sheet" — but the shot list is written by `visual-direction`, which depends on `audio-gate`, i.e. two approved stages later (CASTING, then AUDIO). At the point the stage sits, `Production/<ep>/images/prompts.json` does not exist. | spec `docs/specs/2026-09-25-console-rewrite-design.md:106` against `.archon/workflows/deadlight-produce-assets.yaml:332`; `engine/src/stages.ts:51` (`passedAt: "CASTING"`) | Where does the refs probe get its subject list before the shot list exists? Three options: (a) parse `[SPEAKER]` tags from `Episodes/<ep>/script.md` (works from ep10 forward only — 46 tag lines in ep10, zero in ep01–ep09); (b) add a `## Recurring cast` section to the outline that the reviewer must fill; (c) move `NEEDS_REFS`'s `passedAt` to `IMAGES` and accept that the line stops later, after the audio is already paid for. |
| **F-02** | **`prompts.json` has no `source` field, so `imagesMissing` has nothing to read.** Spec §3.3 says the shot list "marks each shot's source — `pipeline` or `showrunner`". `Production/ep10/images/prompts.json`'s 50 shots carry only `brief, height, id, prompt, refs, scene, seed, type, width`; the discriminator is `type: "ambient"\|"character"` (35 / 15), and every `character` shot is generated by `scripts/nano-banana-generate.py`, not by hand. | spec `:104` against `Production/ep10/images/prompts.json`; `.archon/workflows/deadlight-produce-assets.yaml:403-432`; `scripts/image-generate.py:84-89` | Does Plan D add `source` to `prompts/visual-direction.md`'s output shape and to `prompts/nano-banana-gate.reject.md`, and does an absent `source` default to `"pipeline"`? Keying the probe on `type == "character"` instead would park every episode at `NEEDS_IMAGES` for the three hours Gemini works. |
| **F-03** | **A gate rejection re-runs nothing, and this is a runner change — `inputs` cannot buy it.** `execute()` does `if (status === "completed") continue;` **before** `runStep`, so a step already completed in this run's log never reaches `runScriptStep`'s hash comparison. The cache is a cross-run mechanism only. Six prompts were rewritten to promise "the pipeline re-runs … before this gate reopens; do not run any script yourself." | `engine/src/runner.ts:138` against `:242-260`; `engine/src/state.ts:54-61`; `docs/plans/2026-09-28-show-config-and-prompts-deferred.md:17` | Add `rerunOnReject?: StepId[]` to `GateStep`, or have the runner walk the graph and reset any step whose declared inputs changed? The declarative shape also covers `script-gate`'s seven reviewers, which declare no `outputs` and have no cache path at all (`engine/src/runner.ts:272-284`). |
| **F-04** | **A guard that fails skips its dependents, so `outline-fix-gate` and `review-gate` must never fail.** Both nodes print `yes` or `no` and exit 0 in both cases. In the engine, `{pass: false}` emits `step_failed` and the runner skips every dependent (`:228-229`, `:154-161`). Translating "no" to a failing guard would skip `outline-gate` / `script-gate` — the opposite of what the node means. | `.archon/workflows/deadlight-write-episode.yaml:184-186`, `:798-810`; `engine/src/runner.ts:221-229` | Confirm both guards return `{pass: true, message: "yes"\|"no"}` and that the `when` predicates read that message, not the pass flag. |
| **F-05** | **A gate bypassed by `when` never advances its approved stage.** `deriveStage` counts only `completed` steps toward `highest`; a `when: false` step is `bypassed` (`engine/src/state.ts:75`). `canon-gate` carries `when: "$diff.output != 'NO_CHANGES'"`, so on a no-op canon update the gate is bypassed. | `docs/plans/2026-09-26-engine-core-deferred.md:28`; `engine/src/stages.ts:63-66`; `.archon/workflows/deadlight-canon-update.yaml:107` | Confirm `map.approved` keys CANON on the canon-update `commit` (which carries `trigger_rule: all_done`, `:145`) and not on `canon-gate`. The same rule forbids ever pointing a `StageMap` entry at `outline-revise` or `revise`. |
| **F-06** | **`draft-complete-check` deletes the sentinel it checks, so it is not idempotent.** `rm -f "$SENT"` on the success path. Under the engine's resume contract any step whose status is not terminal is re-executed; a crash between the `rm` and the `step_completed` write leaves the guard failing on its next run for an episode whose draft actually finished. | `.archon/workflows/deadlight-write-episode.yaml:408`; `README.md` resume contract; `engine/src/runner.ts:139-145` | Does Plan D keep the sentinel file at all? The engine already fails a loop that exhausts its cap without the sentinel (`engine/src/runner.ts:382-384`), which is the guard's whole purpose — see F-07. |
| **F-07** | **The sentinel file and its guard may be redundant under the engine, and the guard's own comment says the gap it was built for is an engine change.** `deadlight-write-episode.yaml:386-392` records: "script-gate itself carries `trigger_rule: all_done` … so a FAILING guard still cannot stop the gate from opening. Closing the gap properly means teaching script-gate to distinguish 'skipped' from 'failed' among its dependencies — a workflow-engine change." The engine does exactly that (`engine/src/state.ts:70-78`, `engine/src/runner.ts:154-161`). | `.archon/workflows/deadlight-write-episode.yaml:366-409`; `engine/src/runner.ts:382-384`; `engine/src/state.ts:3`, `:75` | Drop `.draft-complete` and `draft-complete-check`, letting the loop's own failure carry the meaning — or keep both as belt and braces, and pay F-06's idempotency cost? If dropped, `prompts/draft.md`'s completion section (`:344-349`) must be edited, and the seven reviewers' `dependsOn` re-pointed at `draft`. |
| **F-08** | **§2.3's provenance rule needs gate rejection notes that the engine does not put in scope.** `ctx.results["<gate-id>:rejection"]` is set only inside the gate's own `onReject` context and is discarded afterwards; the surrounding run context never carries it. A canon reviewer running as an ordinary step cannot see "a gate rejection note", which is one of the four provenance sources §2.3 names. | `engine/src/runner.ts:328`; spec `:64` | Make the canon reviewer the gate's `onReject` agent, have each fix agent append its note to `Episodes/<ep>/canon-ledger.md`, or change the runner to keep rejection notes in `ctx.results` for the rest of the run? |
| **F-09** | **§2.3's hand-edit detection needs log data an agent step cannot reach.** "A hand edit is any file whose current content hash differs from the hash the engine recorded when an agent step last wrote it." `RunContext` carries `runId`, `episodeId`, `showRoot`, `trigger` and `results` — no hashes and no log handle. | `engine/src/steps.ts:16-26`; `engine/src/runner.ts:282`; spec `:64` | Add a `guard` step that reads the log, compares `outputHashes` against disk, and returns the hand-edited file list as its message for the reviewer's prompt to render — or widen `RunContext`? |
| **F-10** | **§2.1 says the canon reviewer "never edits", but something must write `canon-ledger.md`.** Today's canon checks run with `allowed_tools: [Read, Glob, Grep]`. Granting `Write` contradicts §2.1; not granting it leaves the ledger unwritten. | spec `:55`, `:62`; `.archon/workflows/deadlight-write-episode.yaml:146`, `:416` | Does the reviewer return the ledger rows inside its verdict JSON for a `script` step to write, or does it get `Write` and §2.1's sentence get amended? |
| **F-11** | **`nano-banana-gate` and `image-gate` both map to `DRAFT_IMAGES`, so the board cannot tell them apart.** Two `StageMap.gates` keys sharing one value is legal but means the operator sees "waiting on you to review images" for two different reviews eight steps apart. | `engine/src/stages.ts:31-38`; `.archon/workflows/deadlight-produce-assets.yaml:503`, `:641` | Accept the ambiguity, or ask for a stage the spec's twenty-one do not contain? |
| **F-12** | **`audio-mix`'s `HUM_DB` environment variable is dead in the ported script.** The YAML sets `HUM_DB="${HUM_DB:--42}"` with a comment calling the room-tone bed production canon; `scripts/audio-mix.py` reads `audio.roomToneDb` from `showrunner.json:71` (value `-42`) and reads no environment variable. The README states the rule: "no script reads a *setting* from the environment; the one environment read is the `GEMINI_API_KEY` secret" (`README.md`, Scripts). | `.archon/workflows/deadlight-produce-assets.yaml:318`; `scripts/audio-mix.py:33-52`; `README.md` Scripts section | Drop the `env` on the `audio-mix` step entirely — confirmed, but worth stating so it is not carried over out of fidelity to the YAML. |
| **F-13** | **`image-audit` is the one loop with no sentinel file and no guard, and it has already produced a zero-work iteration in production.** `.agent-logs/ep10-nano-gate-approve-20260915-131930.log` records `loop_node.iteration_empty_output` at iteration 2, 3,946 ms — the ep09/ep10 signature, in a different loop. Its fixes are destructive and not idempotent: "bump its seed +1000, delete that PNG." | `.agent-logs/ep10-nano-gate-approve-20260915-131930.log`; `.archon/workflows/deadlight-produce-assets.yaml:588-590`, `:602-604` | Does `image-audit` get a disk-derived `progress` probe (PNGs verdicted against PNGs present) so a no-op iteration is visible, and does its seed-bump become idempotent (write the bumped seed to `prompts.json` before deleting the PNG, so a resumed iteration can tell)? |
| **F-14** | **`loop_iteration.toolCalls` is `0` on a failure, so the dashboard cannot tell a failed iteration from a no-op one** — the exact distinction §6.7 asks to surface in real time. | `engine/src/runner.ts:370`; `engine/src/steps.ts:136-138`; spec `:180`; `docs/plans/2026-09-27-agent-runner-deferred.md:29` | Carry `toolCalls` on `AgentOutcome`'s failure variant as part of Plan D, or leave it to Plan E's dashboard to read `error` alongside `toolCalls`? |
| **F-15** | **The engine's runner is sequential, and the measured cost on the review panel is 35 min 50 s per round.** Measured on `.agent-logs/ep10-draft-finish-20260907-092413.log`: seven reviewers concurrent 576 s, sequential 2,726 s. Archon fanned them out — `nodeCount: 21, layerCount: 15`. | `engine/src/runner.ts:136-182`; `.agent-logs/ep10-draft-finish-20260907-092413.log`; `.agent-logs/ep10-script-approve-20260909-104913.log:35`; `docs/plans/2026-09-27-agent-runner-deferred.md:33` | Does Plan D add parallel execution of independent ready steps, with log order still authoritative — and if so, what happens to the rate-limit exposure that `.agent-logs/ep10-nano-gate-approve-20260915-131930.log`'s `overageDisabledReason: "out_of_credits"` lines show is already live? |
| **F-16** | **`premise.md` does not exist and `launch-premise.md` does; the task, the spec and the disk disagree.** No `Episodes/*/premise.md` exists. `Episodes/ep09/launch-premise.md` and `Episodes/ep10/launch-premise.md` do, written by `desk-editor` under its write fence. | `.archon/workflows/deadlight-season-review.yaml:193-195`; spec `:13`, `:37` | Which filename does `ideaMissing` probe? Accepting both would let an episode read as having an idea from a file nothing writes. |
| **F-17** | **`Canon/season-2.md` contradicts itself about whether any row is ruled.** Line 18 states "Every row in this file is DRAFT as of 2026-09-21"; rows 1, 2 and 3 (`:69`, `:70`, `:71`) each carry `**RULED**`. `scripts/finalize-video.py:38` and `scripts/season-status.py:39` both parse `\*\*RULED\b[^|]*\*\*` as ruled, so the three rows are machine-ruled while the prose says none are. | `Canon/season-2.md:18` against `:69-71` | Is `s02e01` ruled? Plan D's first run depends on the answer, and the fallback air-slot resolution in `scripts/finalize-video.py:80-105` reads RULED rows. (This is show-data hygiene, not an engine change — but it should be settled before the run.) |
| **F-18** | **`showrunner.json`'s `audio.mainCast` omits `Mute` and `Ilvaren`, both locked S2 mains.** `validate-manifest.py` treats any speaker outside `mainCast` as a guest and flags a first line under five words as a runway violation, so both will be warned about every S2 episode they speak in. | `showrunner.json:83-91`; `Production/voice-refs/refs.json:62`, `:71`; `scripts/validate-manifest.py:160-165` | Add both to `audio.mainCast` before the first S2 run, or accept the warnings? Note the Mute speaks in only two episodes of twenty (`Canon/voice-registry.md:24`), so "main" is a judgment about the runway rule rather than about screen time. |
| **F-19** | **The `[SPEAKER]` tag convention exists in exactly one script.** Ruled 2026-09-09 and taught at `deadlight-produce-assets.yaml:105-114`. `Episodes/ep10/script.md` carries 46 bracket lines (`[SABLE]` ×10, `[SARN]` ×12, `[TRENT]` ×9, `[CRICKET]` ×6, `[OPHA]` ×5, plus one `[BEAT]` and one `[PAUSE 1]`); `ep01`–`ep09` carry none. | `.archon/workflows/deadlight-produce-assets.yaml:105-114`; `Episodes/ep10/script.md`; `Episodes/ep01/script.md` | If F-01's refs probe reads tags, does `prompts/draft.md` need an instruction to emit them? The draft prompt's scene-writing section (`deadlight-write-episode.yaml:295-300`) never mentions the tags — ep10's tags were the showrunner's hand-authored marks, not the drafting agent's. |
| **F-20** | **`Canon/README.md` does not yet carry §5.3's `epNN`-means-Season-1 prose rule.** Spec §5.3 says `Canon/README.md` "gains one rule: **`epNN` in prose always means Season 1, episode NN**". A grep of `Canon/README.md` for `epNN` and `SxEy` returns nothing. | spec `:144`; `Canon/README.md` | Is this Plan D's or Plan F's? It is prose in show data, so it costs nothing to add early — but Plan D's first run introduces the first `s02eNN` path into a repository whose canon files are full of `ep0N/` citations, which is exactly the confusion the rule prevents. |
| **F-21** | **`Canon/season-2.md:69` cites `continuity-ledger.md:33`, which is now a resolved Season 1 thread.** The row says "`continuity-ledger.md:33` is opened toward payment"; line 33 of `Canon/continuity-ledger.md` is "The frame that shouldn't exist", sitting inside the `## Resolved (Season 1)` block (`:23`) and marked **RESOLVED Ep. 7**. The ledger was restructured by the 2026-09-17 desk (`Canon/continuity-ledger.md:24`), which moved the line the slate cites. | `Canon/season-2.md:69`; `Canon/continuity-ledger.md:23`, `:33` | Which ledger thread does `s02e01` actually open toward payment? The `outline` and `outline-canon-check` prompts both read `Canon/continuity-ledger.md` and will be measured against it, so a stale citation in the slate becomes a false canon conflict at the first gate. |

---

## Change log

- **2026-09-29 — created.** The five workflows' 64 nodes typed; the six `status.py` stamping points mapped to a 17-entry `StageMap`; the three `Needs` probes written as pseudo-code against named files and fields; the nine gates, their artifacts and their per-gate re-run sets recorded; the canon reviewer's current behaviour measured against spec §2 and a ledger path and shape proposed; the four loops' sentinels, caps and disk-reading behaviour recorded; the seven engine changes the deferred records assign to Plan D listed, with the gate-rejection re-run resolved as a runner change and the panel fan-out measured at 35 min 50 s per round from `.agent-logs/ep10-draft-finish-20260907-092413.log`; the first run resolved to `s02e01` with `ep98` as a partial test bed; 21 findings.
