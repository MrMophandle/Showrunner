# Canon Store — Index & Rules

This is the single source of truth for the universe. Read before writing an episode; write to it after. It is a house default: the format is the engine's, the content is the show's.

## What lives where

| File / folder | Holds | Changes… |
|---|---|---|
| `world-overview.md` | The premise, logline, tone, the rules of the universe | Rarely |
| `series-arc.md` | The long thread that runs under the episodes, and what is withheld | Occasionally |
| `episode-formula.md` | The repeatable beat structure for an episode | Rarely |
| `story-craft.md` | The causality and shape laws the structure auditor enforces | Rarely |
| `style-guide.md` | Narration voice, prose rules, cadence, the register sample | Rarely |
| `technology.md` | What is possible in this world and what is not, and the environment's rules | Occasionally |
| `timeline.md` | The chronology: eras, fixed events, the present-day baseline | Occasionally |
| `season-<n>.md` | One season's laws and its slate | Per season |
| `visual-style.md` | The look, the palette, the scaffolding every image prompt carries | Rarely |
| `visual-audit-laws.md` | The numbered laws the image audit rejects a frame for breaking | Rarely |
| `publishing-guide.md` | The standing copy and the choices made once | Rarely |
| `pipeline-artifacts.md` | What the pipeline writes where, and the dialogue-attribution convention | Rarely |
| `continuity-ledger.md` | Running log of what HAPPENED, episode by episode | Every episode |
| `voice-registry.md` | Prose about the voices; `Production/voice-refs/refs.json` is the source of truth | When cast changes |
| `refs.json` | One reference image per recurring subject, for image generation | When cast changes |
| `characters/` | One file per recurring character | When cast changes |
| `species/` | One file per species | When the world expands |
| `locations/` | One file per recurring location | When the world expands |
| `factions/` | One file per faction or organization | When the world expands |

## The two-way rule

**Entities** (characters, locations, factions) are mostly *static* — who they are, how they look, what they want.
**Plot state** (who is alive, who knows what, what is unresolved) is *dynamic* and lives in `continuity-ledger.md`. This split is deliberate: it is the plot state, not the descriptions, that a writing agent most often contradicts.

## Episode ids in prose

**Write `SxEy` in prose; a production id appears only inside a file path.** `S01E04` in a sentence, `Episodes/s01e04/` on disk. Keeping the two forms apart is how a reader can tell a story reference from a file reference when a page carries both.

## Naming

- One entity per file. Filename = the entity's canonical name in lowercase-with-hyphens (e.g. `characters/Vale/vale.md`).
- Copy `_TEMPLATE.md` from each folder to start a new entry.
- Every entity notes its **first appearance** (episode id) and **status**.

## Status vocabulary (characters)

`active` · `inactive` · `missing` · `dead` · `unknown` — keep this consistent so the ledger and the character files never disagree.
