# Pipeline Artifacts & Folder Convention

> The canonical reference for **what artifacts the pipeline produces and where they live.** Every episode's files land in these locations identically. The pipeline steps write to these paths by contract. It is a house default stating the engine's own facts: edit the names if your config renames the directories, but the shape is the engine's.

## Artifact catalog

Each pipeline step's output is a named artifact with a fixed home. `<ep>` below is the episode id.

| Stage | Artifact | Home | In git? |
|---|---|---|---|
| beats | `locked-beats.md` | `Episodes/<ep>/` | ✅ source |
| outline | `outline.md` | `Episodes/<ep>/` | ✅ source |
| script | `script.md` (+ archived `-vN` on rewrite) | `Episodes/<ep>/` | ✅ source |
| canon-update | ledger/sheet edits + the gate diff | `Canon/` | ✅ source |
| TTS manifest | `tts-script.json` | `Production/<ep>/` | ✅ (small) |
| guest voices | `guest-refs/*.wav` | `Production/<ep>/guest-refs/` | ✅ **irreplaceable** (voice design is non-deterministic — the WAV *is* the voice) |
| audio | `segments/`, `manifest.json`, the episode mix | `Production/<ep>/audio/` | ⛔ regenerable |
| images | `prompts.json` + `IMAGE-SHEET.md` + `*.png` | `Production/<ep>/images/` | prompts ✅, sheet ✅, PNGs ⛔ |
| casting registry | `<ep>-<shot-id>.png` per subject | `Canon/characters/<Name>/` or `Canon/locations/<Name>/` (the pile follows the reference, not the kind) | ✅ (grows each episode) |
| video | `timeline.json`, `episode.mp4` | `Production/<ep>/video/` | timeline ✅, mp4 ⛔ |
| publish | `upload.md`, `captions.srt` | `Production/<ep>/publish/` | ✅ |
| final | the finished episode, named by `output.finalFilename` | **NAS**, at `output.nasRoot` | ⛔ (backed-up storage) |
| notes | `scene-<n>.md`/`episode.md` (submitted-note record, append-only) · `scene-<n>.draft.md`/`episode.draft.md` (autosave, overwrite) · `scene-<n>.thread.md`/`episode.thread.md` (the showrunner's dialogue with the editor, append-only) | `Production/<ep>/notes/` | ✅ (small) |
| setup | the bible interview's event log and answers | `Production/setup/<file-key>/` | ✅ (the interview's record) |

## Folder convention — three homes, one rule each

- **`Episodes/<ep>/`** — human-authored **narrative** of record (beats → outline → script). Small, versioned. Retired episodes live under `Episodes/_retired/<ep>/`.
- **`Production/<ep>/`** — **generated** assets. Manifests and irreplaceable references committed; binaries gitignored and regenerable. Research scratch (bake-offs, experiments, fixtures) is quarantined under `Production/_archive/`, never mixed with episode output.
- **`Canon/`** — **cross-episode** truth (the ledger, the timeline, the entity sheets, the laws — style guide, voice registry, visual style, story craft). Updated only by the canon-update step through its gate.
- **The NAS**, at `output.nasRoot` — **finished episodes only**, named by `output.finalFilename`.

## Script dialogue attribution

`script.md` is prose, not a play — the narrator is the show and must never be
demoted to stage directions. But the tts-script step has to decide a `speaker`
for every segment, and inferring that from prose is where it guesses wrong. So
dialogue carries an explicit tag and narration carries none:

```
[VALE] "It's cold," she said. "It stays cold. That's all I ever got out of it."

[MAEVE] "Right," said Maeve.

She took the bundle two-handed, the way a person takes a thing she has agreed
to be responsible for, and she did not open it.
```

**The whole rule, both directions:**
- A paragraph containing dialogue is prefixed `[NAME]` in caps — the speaker of
  the QUOTED text in that paragraph.
- **Anything untagged is the narrator.** No narrator tags, ever; that would be
  most of the script.
- One speaker per tagged paragraph. A second speaker starts a new paragraph —
  which is ordinary prose practice anyway.
- Unquoted words inside a tagged paragraph (`she said`, and any action beat)
  stay the narrator's. The tag answers "who is speaking the quotes," nothing
  more.
- Names come from `voice-registry.md`, so a tag that does not match a cast
  entry is a defect the manifest stage should refuse rather than guess at.

### Author-designed pauses — `[BEAT]` and `[PAUSE n]`

The same bracket family, and the same rule that neither is ever spoken:

```
She laid her hand over the glass. [BEAT] She turned it on.

At the top she wrote the name, and underlined it. [PAUSE 2.0]
```

`[BEAT]` is 0.8 s; `[PAUSE n]` is exactly n. Both force a segment split at that
point and set `gap_before` on what follows. Between paragraphs the mark
REPLACES the paragraph gap instead of adding to it. The permitted range is
`audio.authoredPauseRangeSeconds` in the config — see `voice-registry.md` for
why both ends are bounded. The manifest stage honours an authored pause exactly
and still owns every gap the author left unmarked.

**Why it is worth the keystrokes:** the writer no longer has to solve
attribution in prose while drafting, and the manifest stage stops inferring.
The prose is unchanged in voice — the tags sit outside the sentences and strip
cleanly.

## Storage policy

- **NEVER Git LFS.** A finished episode is hundreds of megabytes; git never holds it. Finals go to the NAS (multiply-backed-up); the repository's `Finalized` symlink points there for browsing.
- **Binaries are gitignored and regenerable** (audio segments and the mix, image PNGs, the video MP4). Delete one and the pipeline re-creates it deterministically (pinned per-segment seeds; pinned image seeds).
- **Guest-reference WAVs ARE committed** — voice design is non-deterministic, so a guest voice cannot be regenerated identically; the WAV is the source of truth.
- Manifests (`tts-script.json`, `images/prompts.json`), the timeline, and publish kits are small and committed.
