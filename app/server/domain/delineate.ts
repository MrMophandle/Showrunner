import type { SceneDraft } from './spine.ts'

/**
 * **Delineation** (1.1, D3, E4-3): reading the scenes back out of a written script.
 *
 * Scenes are first-class and addressable — findings anchor in them, the continuity board is
 * one row per scene, the re-check narrows to one (D14) — and they are **derived from the
 * written episode, never prescribed to the writer**. This module is the derivation, and it is
 * the only one: `fixture/read.ts` reads the fixture's script through it, the script stage reads
 * every landed draft through it, and E4-5's direct edit will too. A second reader of the same
 * headings is the failure `text-check.ts` names about parsers — it agrees until the day one of
 * them learns something, and then the fixture's scenes and a draft's scenes are two conventions
 * with one name.
 *
 * ## The convention, whole
 *
 *     ## 4 · EXT. THE LONG PIER — 07:07
 *
 *     > Tobin works the relay housing at the head of the pier, in his coveralls.
 *
 *     The pier runs out from the ring in a long spar of gantry and clamp…
 *
 * An ordinal, a middle dot, the heading; the blockquote under it is the scene's summary and
 * everything after it is the scene. The heading stored is what follows the dot — the ordinal
 * is the scene's POSITION and is recomputed from the file every time, so it is never carried
 * on the row as a name.
 *
 * The ordinal in the text is checked against the position and refused when they disagree. It
 * is not decoration: a heading that says 4 over a row whose ordinal is 3 would put "the
 * scene 3 finding" beside a heading that reads 4 on Ryan's screen, and the HIL contract is that
 * he never has to reconcile two numbers for one thing.
 *
 * **Numbering what you wrote is not being told how many to write.** `num_scenes` is an output
 * (D3): nothing asks a model for a count, nothing asserts one as an input, and the count is
 * `scenes.length` after the fact. The outline that this script is written from carries no grid
 * at all, deliberately (`write-step.ts`, E4-2) — the numbers here are applied by the writer to
 * the scenes it turned out to write.
 *
 * ## The identity rule, in one sentence (E4-3's design decision)
 *
 * > **A scene is its heading**: re-delineating matches a new draft's scenes to the standing
 * > rows by heading and by nothing else, so a heading that is still there is the same scene
 * > wherever it has moved to, a heading that is gone takes its scene with it, and a heading
 * > that is new is a new scene.
 *
 * The rule is enforced in `delineateScenes` (spine.ts), which is where a row survives or does
 * not; the argument for it is here, with the convention it reads. Three cases, and the third is
 * why identity cannot be the ordinal:
 *
 *   1. **The heading is unchanged.** Same scene, same id, trivially — and the whole reason the
 *      other two are answerable at all.
 *   2. **The heading is renamed.** A NEW scene, and the old one is gone. A rename is the writer
 *      saying this is a different place, a different hour, or a different scene; and a finding
 *      anchored in the old one degrades to the whole artifact (`finding.scene_id` is
 *      `ON DELETE SET NULL`, 0010) rather than migrating onto prose nobody checked. That
 *      degradation is the honest answer and it is the one the schema was already built for.
 *   3. **A scene is inserted in the middle.** Every ordinal after it shifts by one, and under
 *      ordinal identity every anchor after the insertion would silently move one scene up —
 *      the finding from scene 4 would render against scene 5's prose, with nothing anywhere
 *      saying so. Under heading identity nothing moves: the inserted heading is new, the rest
 *      keep their ids, and their ordinals are recomputed around it.
 *
 * The rest of the app already reads scenes this way, which is the strongest argument of all:
 * `sceneSpans` (text-check.ts) finds a scene's text by `indexOf(scene.heading)` and knows
 * nothing about ordinals, and the scene-scoped re-check refuses outright when the draft no
 * longer carries the heading. **A scene row whose heading is not in the draft cannot locate
 * itself**, so keeping it alive across a rename would keep a row that can only answer "the
 * whole artifact" while claiming to be a scene.
 *
 * Two headings the same is therefore not a duplicate, it is an ambiguity, and `delineateScenes`
 * refuses it — `sceneSpans` would give both rows the same first occurrence and every span after
 * it would be wrong.
 */

/** The heading line: an ordinal, a middle dot, and the heading the row keeps. */
const HEADING = /^(\d+) · (.+)$/

/**
 * The scenes a script broke into, in order — or a refusal naming what is wrong with it.
 *
 * `subject` is what the refusals call the thing being read ("the ep02 script draft", the
 * fixture's own path), because both callers need the message to say WHICH script, and neither
 * of them can say it from inside here.
 *
 * It throws rather than salvaging, and the reasoning is `board.ts`'s: the runner's three
 * attempts (invariant 5) are exactly the budget for an answer that came back wrong, and a
 * script silently delineated out of half its headings would put a scene grid on screen that
 * nobody wrote.
 */
export function delineateScript(text: string, subject: string): SceneDraft[] {
  const lines = text.split('\n')
  const heads: number[] = []
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) heads.push(index)
  })

  if (heads.length === 0) {
    throw new Error(
      `${subject} has no scene headings in it, so there are no scenes to derive. Every scene ` +
        'opens with one: `## 4 · EXT. THE LONG PIER — 07:07`.',
    )
  }

  return heads.map((head, index) => {
    const name = lines[head]!.slice(3).trim()
    const match = HEADING.exec(name)
    if (!match) {
      throw new Error(
        `${subject}: “## ${name}” is not a scene heading. Every one is an ordinal, a middle ` +
          'dot and the heading: `## 4 · EXT. THE LONG PIER — 07:07`.',
      )
    }
    const ordinal = Number(match[1])
    if (ordinal !== index + 1) {
      throw new Error(
        `${subject}: scene ${ordinal} is the ${index + 1}th heading in the file, and scenes are ` +
          'numbered in the order they are written. A heading that says one number over a scene ' +
          'that is at another leaves every finding in it pointing at two different scenes.',
      )
    }
    return { heading: match[2]!.trim(), summary: summaryUnder(lines.slice(head + 1, heads[index + 1] ?? lines.length)) }
  })
}

/**
 * The `> …` block directly under a heading, folded to one line — the scene's summary, as the
 * episode room's grid renders it and as the fixture's own scripts already carry it.
 *
 * Blank lines above it are skipped and the first line that is not quoted ends it, so the prose
 * of the scene never leaks into the summary of it.
 */
function summaryUnder(body: string[]): string {
  const start = body.findIndex((line) => line.trim() !== '')
  if (start === -1 || !body[start]!.startsWith('> ')) return ''

  const quoted: string[] = []
  for (const line of body.slice(start)) {
    if (!line.startsWith('> ')) break
    quoted.push(line.slice(2).trim())
  }
  return quoted.join(' ')
}
