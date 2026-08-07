import type { Store } from '../db/store.ts'
import type { Artifact } from './artifact.ts'
import { findBoard, type Board, type BoardPresence, type BoardScene } from './board.ts'
import { factsInScope } from './fact.ts'
import { recordCheckPass, type CheckPass, type FindingDraft } from './finding.ts'

/**
 * The continuity board's deterministic rules (3.2b): **the worst continuity bugs, caught for
 * free.** Dual presence, impossible adjacency, duplicate arrival, vacuum without protection.
 *
 * ## Free, and it has to stay free
 *
 * Every function here is a pure read over rows E3-1's extraction already wrote and canon
 * already holds. **No model is called, nothing is re-read from the script, and nothing here
 * costs a cent** — which is what makes a re-check after a rewrite something the app can do on
 * every scene edit rather than something Ryan has to authorise. Extraction is the paid half
 * (`board.ts`), and if a rule ever reaches for the script's text, that property is gone and
 * every re-check bills him.
 *
 * ## Deterministic means certain, and unknown is not certain
 *
 * Every finding here is `confidence: certain`, because that is what the tier MEANS (4.2) —
 * not a value these rules happen to carry. The price of saying `certain` is that a rule must
 * ABSTAIN wherever the rows do not prove it, and it does, in four places worth naming:
 *
 *   * a scene with no clock (`elapsedSeconds` NULL) is compared with nothing;
 *   * a crossing canon states no number for raises nothing — "the lock is slow" is not
 *     something a machine can compare, and `location/_category.md` says so;
 *   * `protection: unknown` is not `protection: none`;
 *   * a character whose species is declared `unknown` (D22) inherits no facts, so the board's
 *     hazard is not in their scope and the vacuum rule has nothing certain to say.
 *
 * None of those silences is a gap. They are E3-2's semantic checker's honest "could not
 * check", and taking a guess here would spend the only thing this tier has.
 *
 * ## Where a board finding lands
 *
 * The pass reads the BOARD; the finding lands in the SCRIPT, at the scene, quoting the
 * scene's own heading. 0010 built the anchor's separate artifact column for exactly this,
 * and the gate room renders the script with the finding sitting at that scene.
 *
 * The heading is the honest span. These rules do not argue with a sentence — they argue with
 * a SCENE, whose own heading is a real, searchable span of the script (4.3's anchor is by
 * quote, never by offset). Inventing a line of dialogue to point at would be a guess dressed
 * as a `certain` finding, which is `structural.ts`'s reasoning for quoting nothing at all.
 *
 * ## And none of them blocks anything
 *
 * D12 says deterministic findings block the next stage and never Ryan's gate. **That wall is
 * not here.** It is a computation over open deterministic findings, and E3-3 builds it. These
 * rules mark the tier and enforce nothing — the same division `structural.ts` keeps.
 */

/**
 * The rules, in the order the tier runs them. A closed set called by name in plain
 * TypeScript below — no catalogue, no registry, no configurable list of checks (the Archon
 * rule). Adding one is an edit here with a test, as adding a stage to `runner/stages.ts` is.
 */
export const BOARD_RULE = [
  'dual-presence',
  'impossible-adjacency',
  'duplicate-arrival',
  'vacuum-without-protection',
] as const
export type BoardRule = (typeof BOARD_RULE)[number]

/**
 * Runs the whole tier over one board and records what each rule said, including the ones
 * that said nothing.
 *
 * One transaction: four passes are one run of the tier, and a half-recorded run would tell
 * E3-6 that one rule fires half as often as its sibling. **The zero-finding rows are the
 * point** — rules the script obeys are the cried-wolf controls, and their measured silence
 * only exists because `recordCheckPass` writes the row first and unconditionally (0010).
 */
export function runBoardRules(store: Store, boardId: string): CheckPass[] {
  const board = findBoard(store, boardId)
  if (!board) throw new Error(`No such continuity board: ${boardId}`)

  return store.transaction(() => [
    pass(store, board, 'dual-presence', dualPresence(board)),
    pass(store, board, 'impossible-adjacency', impossibleAdjacency(board)),
    pass(store, board, 'duplicate-arrival', duplicateArrival(board)),
    pass(store, board, 'vacuum-without-protection', vacuumWithoutProtection(store, board)),
  ])
}

function pass(
  store: Store,
  board: Board,
  rule: BoardRule,
  findings: FindingDraft[],
): CheckPass {
  return recordCheckPass(store, {
    checkKey: rule,
    tier: 'deterministic',
    artifactId: board.artifact.id,
    findings,
  })
}

// ── One character, two locations, one clock ─────────────────────────────────────

/**
 * **Dual presence.** The planted contradiction of The Long Pier: scene 5 is the
 * harbourmaster's office at 07:20 with Ilse in it, scene 6 is the head of the pier marked
 * CONTINUOUS with Ilse in a hardsuit, and she is in two places at one time.
 *
 * "Once the board has extracted its per-scene rows the contradiction is a `COUNT(*)`: one
 * character, two locations, one clock. No judgement is involved and no model needs to be
 * called" (`episode.md`). This is that count.
 *
 * A pair with different clocks is people walking through doors, and a pair whose clock the
 * script never stated is not a pair at all.
 */
export function dualPresence(board: Board): FindingDraft[] {
  const findings: FindingDraft[] = []

  for (const [, appearances] of walk(board)) {
    for (let earlier = 0; earlier < appearances.length; earlier += 1) {
      for (let later = earlier + 1; later < appearances.length; later += 1) {
        const here = appearances[earlier]!
        const there = appearances[later]!
        if (here.scene.elapsedSeconds === null || there.scene.elapsedSeconds === null) continue
        if (here.scene.elapsedSeconds !== there.scene.elapsedSeconds) continue
        if (here.scene.location === there.scene.location) continue

        findings.push({
          concern:
            `${here.name} is in two places at one time. Scene ${here.scene.ordinal} has them ` +
            `in ${here.scene.location} and scene ${there.scene.ordinal} in ` +
            `${there.scene.location}, both at ${clockOf(here.scene)}${continuation(here, there)}. ` +
            'One character, two locations, one clock — a count of the rows, not a reading ' +
            'of the script.',
          severity: 'high',
          confidence: 'certain',
          anchor: anchorAt(board, there.scene),
          entityId: there.who.entityId ?? undefined,
        })
      }
    }
  }
  return findings
}

// ── The crossing that does not fit ──────────────────────────────────────────────

/**
 * **Impossible adjacency.** Two consecutive appearances of one body in two places, with less
 * time between them than the geography costs.
 *
 * The numbers come from canon and were read ONCE, in extraction: "A location's facts carry
 * its geography and its transit costs… write them as numbers a machine can compare, not as
 * atmosphere" (`location/_category.md`). This rule subtracts two clocks and compares. Where
 * canon states no number it abstains, because "the lock is slow" is not a comparison.
 *
 * **A gap of zero belongs to dual presence, and is deliberately not reported here.** The
 * fixture is explicit that scenes 5 and 6 fail twice over and "should be reported once, not
 * twice — dual presence is the primary reading; impossible adjacency is the corroboration"
 * (`episode.md`). Zero elapsed is simultaneity, which is a statement about *one clock* rather
 * than about a crossing, and the rule that names it best is the one that keeps it. That is a
 * partition of the two rules' domains, not a suppression: a positive gap that is too small
 * still fires here, and a negative one — a body somewhere before it left somewhere else —
 * fires whatever the geography costs.
 */
export function impossibleAdjacency(board: Board): FindingDraft[] {
  const findings: FindingDraft[] = []

  for (const [, appearances] of walk(board)) {
    for (let index = 1; index < appearances.length; index += 1) {
      const from = appearances[index - 1]!
      const to = appearances[index]!
      if (from.scene.elapsedSeconds === null || to.scene.elapsedSeconds === null) continue
      if (from.scene.location === to.scene.location) continue

      const gap = to.scene.elapsedSeconds - from.scene.elapsedSeconds
      if (gap === 0) continue

      if (gap < 0) {
        findings.push({
          concern:
            `${to.name} is in ${to.scene.location} at ${clockOf(to.scene)} (scene ` +
            `${to.scene.ordinal}), before leaving ${from.scene.location} at ` +
            `${clockOf(from.scene)} (scene ${from.scene.ordinal}). The clock runs backwards ` +
            'across the crossing.',
          severity: 'high',
          confidence: 'certain',
          anchor: anchorAt(board, to.scene),
          entityId: to.who.entityId ?? undefined,
        })
        continue
      }

      const crossing = board.transits.find(
        (transit) => transit.from === from.scene.location && transit.to === to.scene.location,
      )
      if (!crossing || gap >= crossing.seconds) continue

      findings.push({
        concern:
          `${to.name} crosses from ${from.scene.location} to ${to.scene.location} in ${gap} ` +
          `seconds, and canon says the crossing takes ${crossing.seconds}. Scene ` +
          `${from.scene.ordinal} to scene ${to.scene.ordinal} does not fit.`,
        severity: 'high',
        confidence: 'certain',
        anchor: anchorAt(board, to.scene),
        entityId: to.who.entityId ?? undefined,
        factIds: crossing.factId ? [crossing.factId] : undefined,
      })
    }
  }
  return findings
}

// ── Brought in twice, and never let out ─────────────────────────────────────────

/**
 * **Duplicate arrival.** The script narrates a body coming into a place it has already been
 * shown coming into, with nothing in between putting it anywhere else.
 *
 * `arrives` is what the SCRIPT SHOWS — "TOBIN WICK comes in sideways" — and never what the
 * grid implies. Derived from the grid it would be worthless: a character whose last row was
 * elsewhere has obviously arrived, and a rule over that could never fire. So this is a claim
 * the extraction made about the text, and two of them at one place with no departure between
 * is the slip.
 *
 * Severity `medium`, not `high`: nobody dies of it and no canon is contradicted. It is a
 * scene that will read wrong, which is Ryan's call like every other finding (invariant 3).
 */
export function duplicateArrival(board: Board): FindingDraft[] {
  const findings: FindingDraft[] = []

  for (const [, appearances] of walk(board)) {
    const arrivals = appearances.filter((appearance) => appearance.who.arrives)

    for (let index = 1; index < arrivals.length; index += 1) {
      const first = arrivals[index - 1]!
      const again = arrivals[index]!
      if (first.scene.location !== again.scene.location) continue
      // Anything at all between them, anywhere else, and they left.
      const left = appearances.some(
        (appearance) =>
          appearance.scene.ordinal > first.scene.ordinal &&
          appearance.scene.ordinal < again.scene.ordinal &&
          appearance.scene.location !== again.scene.location,
      )
      if (left) continue

      findings.push({
        concern:
          `${again.name} arrives at ${again.scene.location} in scene ${again.scene.ordinal}, ` +
          `and the script already brought them in there in scene ${first.scene.ordinal} — ` +
          'with nothing in between putting them anywhere else. They are let in twice and ' +
          'never out.',
        severity: 'medium',
        confidence: 'certain',
        anchor: anchorAt(board, again.scene),
        entityId: again.who.entityId ?? undefined,
      })
    }
  }
  return findings
}

// ── Outside, with nothing between them and it ───────────────────────────────────

/**
 * **Vacuum without protection.** An exposed scene, a body with no hardsuit and no active
 * containment field, and a fact in that body's scope saying what the void does to it.
 *
 * This is D22's whole point made checkable. "A rule about vacuum catches nobody" until
 * something in scope says what a body IS — and the Halvani physiology fact is in Tobin
 * Wick's scope only because his sheet declares `species: Halvani` and the character
 * category declares that facts travel that edge (D23).
 *
 * **The rule reads no prose.** The board NAMES the hazard fact (extraction did the reading);
 * this checks whether that fact is still in this character's scope TODAY, through
 * `factsInScope`, and quotes it if it is. The certainty comes from that re-check rather than
 * from the board's memory: a species edge declared `unknown` inherits nothing, a reverted
 * fact is no longer open, and either way the rule falls silent without anyone having to
 * remember to clear a row.
 *
 * Both of E3's tiers land on The Long Pier's scene 4, and that is 4.5's clustering rather
 * than a duplicate: this one says the rows prove it, and E3-2's world-rules check says the
 * scene reads that way. They cluster by anchor and the gate room shows them together.
 */
export function vacuumWithoutProtection(store: Store, board: Board): FindingDraft[] {
  const lethal = board.hazards.filter((hazard) => hazard.hazard === 'lethal-in-vacuum')
  if (lethal.length === 0) return []

  const findings: FindingDraft[] = []
  for (const scene of board.scenes) {
    if (scene.environment !== 'exposed') continue

    for (const who of scene.present) {
      if (who.protection !== 'none') continue
      if (who.entityId === null) continue

      // The scope helper is what D22 exists for, and what makes `unknown` silent here.
      const inScope = new Set(
        factsInScope(store, who.entityId).inScope.map((fact) => fact.id),
      )
      const quoted = lethal.filter((hazard) => inScope.has(hazard.factId))
      if (quoted.length === 0) continue

      findings.push({
        concern:
          `${who.characterName} is outside the pressure hull in scene ${scene.ordinal} with ` +
          'nothing between them and the void — no sealed hardsuit, no active containment ' +
          'field. A fact loaded with them says what that costs.',
        severity: 'high',
        confidence: 'certain',
        anchor: anchorAt(board, scene),
        entityId: who.entityId,
        factIds: quoted.map((hazard) => hazard.factId),
      })
    }
  }
  return findings
}

// ── Reading the board ───────────────────────────────────────────────────────────

/** One body in one scene, as the rules walk it. */
interface Appearance {
  name: string
  who: BoardPresence
  scene: BoardScene
}

/**
 * Every body's appearances, in scene order.
 *
 * Keyed by canon identity where there is one and by name where there is not. A body the
 * extraction could not place in canon is still one body, and nothing about "she is in two
 * places at once" needs a sheet — which is why the rules that compare rows keep working when
 * the one that reads facts cannot.
 */
function walk(board: Board): Map<string, Appearance[]> {
  const bodies = new Map<string, Appearance[]>()

  for (const scene of board.scenes) {
    for (const who of scene.present) {
      const key = who.entityId ?? `name:${who.characterName.toLowerCase()}`
      const appearances = bodies.get(key) ?? []
      appearances.push({ name: who.characterName, who, scene })
      bodies.set(key, appearances)
    }
  }
  return bodies
}

/**
 * Where a board finding lands: the SCRIPT, at the scene, quoting the scene's own heading.
 * The version is left off deliberately — `raiseFinding` resolves it against the far
 * artifact, which is what "the script as it stands" means when the pass read the board.
 */
function anchorAt(board: Board, scene: BoardScene): FindingDraft['anchor'] {
  const anchored: Artifact = board.source ?? board.artifact
  return { artifactId: anchored.id, sceneId: scene.sceneId, quote: scene.heading }
}

/** What the grid prints for this scene's clock, or the seconds when it prints nothing. */
function clockOf(scene: BoardScene): string {
  return scene.elapsedLabel !== '' ? scene.elapsedLabel : `${scene.elapsedSeconds}s`
}

/**
 * The clock is quoted off the EARLIER scene, because the later one is often the reason the
 * two share it — "CONTINUOUS" is a relative marker, and "both at CONTINUOUS" is not a time
 * anybody can check. So the finding prints the hour and then says where the second scene
 * got it, which is the sentence `episode.md` uses.
 */
function continuation(here: Appearance, there: Appearance): string {
  const label = there.scene.elapsedLabel
  return label !== '' && label !== here.scene.elapsedLabel
    ? ` (scene ${there.scene.ordinal} is marked “${label}”)`
    : ''
}
