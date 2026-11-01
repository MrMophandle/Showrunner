# The Casting Stop — design

> Status: **draft for Ryan's review**, written 2026-10-31 from the conversation of 2026-10-30/31. Engine repository `Showrunner`; the show-side files it names live in the show instance (`Episodes/`, `Canon/`, `Production/`, `prompts/`). Every ruling below is Ryan's unless marked as a proposal.

## 0 · What it does (one sentence)

When an episode's outline names a speaking character who has no filed voice or face, the pipeline stops once, before any rendering, at a casting gate in the console where candidate takes and candidate reference sheets are shown side by side per character; the showrunner picks one of each, and the picks are filed centrally the way the main cast is filed, so every later episode inherits them.

## 1 · The cast database (Ryan-ruled 2026-10-31)

**1.1 The rule.** A character who **speaks** on the page gets a voice and a face, filed centrally from their first episode. A character who is **seen but silent** gets a face and an explicit "no voice" mark. A character who is only ever off screen — named, never heard, never shown — gets nothing. The outline's `## Cast` section already carries the fact that decides this: `- <Name> (<recurring|guest>, speaks)`; the absence of `speaks` is silence.

**1.2 Storage of record.** The two files that exist stay the storage of record, and nothing moves on disk:
- voices: `<audio.voiceRefsDir>/refs.json` (`Production/voice-refs/refs.json`), the `cast` map the TTS script already copies locked entries from — `ref`, `ref_text`, `direction`, `fx`, `speed`, `status`, `note`;
- faces: `<visual.refs>` (`Canon/refs.json`), the visual bible — `kind`, `ref`, `identity`, `locked`, `baseline_prompt`.

Two fields are added, both optional so every existing reader keeps working: `debut` (the episode id the character was first cast for, on both files) and `guest: true` (on the voice entry, as the TTS manifest already marks guests). A face entry for a seen-but-silent character carries `silent: true`, which is what makes "no voice" explicit rather than a gap. A character's key is the engine's `slugName` of the cast name in both files (`engine/src/needs.ts`); the visual bible's existing `the-<slug>` alternative stays accepted on read.

**1.3 Consequence for the TTS stage.** Guests stop being a separate convention. The TTS script prompt copies every cast entry — recurring or guest — from the registry (`ref`, `ref_text`, `direction`, `fx`, `speed`), and the per-episode `guest-refs/` directory, the hand-run `design-voice.py`, and "Do not run design-voice.py" leave the prompt. `audio.guestRefsDir` stays in the config for the two steps that read it until §4's migration retires it; the casting gate's voice picker (PR #122) stays, as a re-pick of a filed voice.

**1.4 The Cast page.** The console's bible rail gains a page, `Cast`: one row per character across both files — name, kind, debut, voice (locked / none / silent), face (locked / none), and the gap when one side is missing. It reads the two files through the bible's existing file routes; it writes nothing. It is the standardised view Ryan asked for; the files are the database.

## 2 · The casting stop

**2.1 Where.** In the episode pipeline, between `write-commit` and `refs-ready` (`engine/src/pipelines/episode.ts`): after the script is approved and committed, so the brief agent has the character's real lines, and before the TTS script, which is the first step that needs the files. `refs-ready` stays as the final guard and should never fire NEEDS_REFS again for a speaking character; if it does, the stop has a bug.

**2.2 Steps.** Four, all bypassed (`when`) on an episode whose cast is already filed:

1. `casting-needs` — a guard. Computes the list of speaking cast entries lacking a voice or a face (the same probe `missingRefs` makes today, split into "needs voice" and "needs face"), writes it as its result, and bypasses everything below when the list is empty.
2. `casting-brief` — an agent (`model: medium`, tools Read/Write/Glob/Grep, prompt `casting-brief.md`). For each needed character it writes one brief into `<productionDir>/<episodeId>/casting/briefs.json`: the voice direction and the reference line (the character's most characteristic line in the script, which becomes `ref_text`), and the identity with a baseline image prompt in the visual bible's own words. It also writes the **unlocked** visual-bible entry (`kind`, `identity`, `baseline_prompt`, no `ref`), which is what `design-visual.py` reads today. It writes nothing for a character that needs only one of the two.
3. `casting-design` — a script (`casting-design.py`). For each brief it runs the existing designers: `design-voice.py` for `audio.castingTakes` takes (default 2) and `design-visual.py` for `visual.castingSheets` sheets (default 3), into `<productionDir>/<episodeId>/casting/<slug>/` as `voice-<n>.wav` with the reference line beside them as `voice.txt`, and `face-<n>.png`. Idempotent: a candidate file that exists is kept. Progress is per character.
4. `casting-gate` — a gate (`casting-gate.gate.md`, `maxAttempts` 10). Its artifacts are the casting directory (kind `casting`, new) and `briefs.json`. Its answer carries `picks`.

After an approve: `casting-file` — a script (`casting-file.py`). Reads `<casting>/picks.json` (written by the console on approve, §3.1) and files each pick: the voice WAV copied to `<voiceRefsDir>/<slug>.wav` and the entry added to the registry's `cast` (`ref`, `ref_text` from `voice.txt`, `direction` from the brief, `status: "LOCKED"`, `guest: true`, `debut`); the face copied to `Canon/characters/<Name>/<Name> Reference.png` with the bible entry completed (`ref`, `locked`, `debut`). Then `refs-ready` runs and passes. The filing is a pipeline step and not the console's gate answer, so the engine is the one writer of the registries and the console stays a reader plus one small file.

**2.3 Reject.** `casting-gate-fix` (agent, tools incl. Bash) reads the notes, folds them into the named characters' briefs (and, for a canon problem, the bible's `identity`), deletes those characters' candidates, and `casting-design` re-runs for what is missing (`rerunOnReject: ["casting-design"]`), then the gate reopens. A note naming no character re-rolls nothing and reopens the gate with the same candidates.

**2.4 What a filed character costs later.** Nothing. The next episode's `casting-needs` finds the voice and the face and bypasses the stop. A recurring guest is simply a cast entry with `guest: true` and an older `debut`.

## 3 · The console

**3.1 The gate page.** A `casting` artifact renders one fieldset per character from `briefs.json`: the takes as radios with a player and the transcript under each (the audio pane from PR #118/#122), the sheets as radios with the image shown (a new image-choice pane), and the brief's text shown beneath, editable through the gate editor (PR #116) since `briefs.json` is not markdown — the brief is rendered from json into the editor as a text form, or `briefs.json` is edited in place; **proposal: in place, as text, the same editor with a json mode**. Approve requires a voice pick and a face pick for every character that needs them (the button says what is missing otherwise), writes `<casting>/picks.json` through the fenced file route of PR #116 (extended to json under the casting directory), and answers the gate. Reject carries notes only.

**3.2 The Cast page.** §1.4. Route `/shows/:show/bible/cast`, read-only, sortable by debut.

**3.3 Nothing else moves.** The TTS-manifest picker (PR #122), the editor (PR #116), the Board and the Run page are unchanged.

## 4 · The migration (one-time, show-side)

**4.1 The audit.** A script (`cast-audit.py`, in the engine's `scripts/`, run by hand) reads the two registries and, given `--retired <path>`, the retired repository's six `Production/ep*/guest-refs/` directories (read only), and prints every character known anywhere with voice / face / source, and the gaps. Today's gaps, from the 2026-10-31 inventory: faces with no central voice — Ansa, Mardo, Marle, Wella, Vrask, the two Iss-kar extras, Hallet (now filed); twenty-six Season 1 guest voices never promoted, among them those five.

**4.2 The promotion.** Under Ryan's eye, the Season 1 guest WAVs for characters who have a face are copied into `Production/voice-refs/` with registry entries (`guest: true`, `debut` from the episode they came from, `ref_text` from the manifest that cast them); one-off voices with no face and no return are listed, not promoted. Veleth gets a face through the casting stop's first real run, since he was voice-only on 2026-10-30. A show-side PR carries the result.

**4.3 What is retired.** `audio.guestRefsDir`, the `guest-refs/` convention in the TTS prompt, and the hand steps `design-voice.py`/`design-visual.py` as operator actions (the scripts stay, called by `casting-design.py`).

## 5 · What this does not do

- It does not cast a character the outline failed to name, and it does not re-cast a filed one; a re-pick of a voice is the TTS gate's picker, and a re-pick of a face is a hand step until it is asked for.
- It does not generate the hero shots — the image stage after the image-prompt check is unchanged, including its reliance on the Google image model and Ryan's credits.
- It does not build a voice or a face for a location, a ship or a species; those stay bible entries written by hand.

## 6 · Open points, to be settled in the plan

- `casting-design.py`'s runtime: a voice take is ~1 min and a sheet ~3–5 min on the local models; two new characters are ~15 min. The step reports progress per character so the Board says what it is doing.
- Whether `briefs.json` is edited in place through the editor (json mode) or shown read-only with reject-to-change. Proposal: in place.
- The exact fields the Cast page sorts by.

## 7 · Change log

- **2026-10-31 — created.** From Ryan's rulings of 2026-10-30/31: every speaking character is filed like the main cast, voice and face together, through a gate in the console; seen-but-silent characters carry an explicit no-voice mark; off-screen characters get nothing; the existing registries are standardised by an audit and a promotion of the Season 1 guest voices.
