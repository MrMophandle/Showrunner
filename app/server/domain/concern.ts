import type { Finding } from './finding.ts'

/**
 * **What makes two findings the same concern** — and what a standing dismissal therefore
 * reaches (D11, E3-5's amendment).
 *
 * A check that fires twice at one contradiction has not found two contradictions. Both of the
 * readers below rest on that sentence, and neither of them can be built without deciding it:
 *
 *   * **D11's ratio counts concerns, not rows.** E3-5's one-motion apply re-runs the free
 *     deterministic tier on every rewrite (`remediation.ts`), so a rewrite-heavy episode
 *     re-raises the same board-rule finding once per revision. Counting those as distinct
 *     findings would let an episode inflate a check's fired count with twins of one concern,
 *     and the cried-wolf ratio would be measuring how often Ryan rewrites rather than how
 *     often the check is wrong.
 *   * **The D12 wall.** A dismissal is Ryan's answer to a concern; the twin of a finding he
 *     put down last week is the same concern coming back because a rule read the same
 *     unchanged rows. `stage-wall.ts` reads `inheritedDismissal` so the wall stays down.
 *
 * ## Nothing here is written, and the twin's firing is still recorded
 *
 * These are pure functions over rows somebody else wrote. No disposition is copied onto a
 * twin, no `same_concern` column exists, and no identity is cached — 0010's freshness rule
 * (findings are records, never state) said one level out. The twin stays `open`, its
 * `check_pass` and `finding` rows stand exactly as raised, and D11 counts that firing in its
 * denominator. What identity buys is a READ over those rows, computed fresh, and it is the
 * only thing that changes.
 *
 * ## Strict, because the two failures are not the same size
 *
 * Mistaking a genuinely new contradiction for an old twin is the worst thing this file can
 * do, and it hides in both readers at once: a wall that stays down over a real contradiction,
 * and a ratio that under-counts a check that was right. Mistaking a twin for a new concern
 * costs a re-dismissal and a slightly loud ratio — visible, annoying, and self-correcting.
 * So every axis below is compared for EXACT equality, and any difference at all is a new
 * concern.
 *
 * ## The tuple, and why each part is in it
 *
 * `checkKey` — the ratio is per check, and two reviewers landing on one scene is 4.5's
 *   clustering rather than one concern. The deterministic vacuum rule and the semantic
 *   world-rules check both land on The Long Pier's scene 4 (`board-rules.ts`) and they are
 *   two opinions, not one repeated.
 *
 * `anchor.artifactId` — the material it is about. It is the anchor's artifact and not the
 *   pass's, because a board rule reads the BOARD and lands in the SCRIPT (E3-1), and the
 *   concern is about the script.
 *
 * `anchor.sceneId` — where in that material. NULL is a value here, not a wildcard: a finding
 *   about the whole artifact is not the same concern as one about scene 4. A scene deleted by
 *   a re-delineation sets it NULL (0010), which makes the old finding a different concern
 *   from the new one — the strict direction, and the honest one, because the place it named
 *   is gone.
 *
 * `anchor.quote` — the span. **A rewrite of the span therefore breaks identity**, and that is
 *   the point rather than a cost: if Ryan rewrote the words the check argued with and the
 *   check fires at the NEW words, it is reading something he has not ruled on. The ordinary
 *   twin — a rewrite somewhere else in the episode, the free tier re-run over unchanged rows
 *   — keeps its span exactly, because a board rule quotes the scene heading and a text check
 *   quotes the sentence it read.
 *
 * `entityId` — who it is about. NULL is a value, and it means a craft finding with no canon
 *   to name (D13).
 *
 * the quoted fact ids, in order — what it argues with. A finding quoting a superseded fact's
 *   successor argues with different canon, so it is a different concern.
 *
 * `concern` — the check's words, verbatim. The deterministic tier composes them from the rows
 *   it read (`board-rules.ts`, `structural.ts`), so they are stable exactly while those rows
 *   are, and they change the moment the reading does — a scene renumbered, a location
 *   different, a different character named. For the semantic tier this is the strictest part
 *   of the key: a model that rephrases raises a new concern. That is deliberate. A twin
 *   dismissal inherited across a rephrasing would be a model's paraphrase deciding what Ryan
 *   ruled on.
 *
 * ## What is deliberately NOT in it
 *
 * `anchor.version` — a twin is BY DEFINITION at a later version. Keying on it would make
 *   every firing its own concern and there would be no identity at all.
 *
 * `passId` — same reason, one level up. A twin is a different pass.
 *
 * `severity` and `confidence` — the check's ASSESSMENT of one concern, not the concern.
 *   A rule that raises a severity has not found a new contradiction, and folding the two
 *   axes into identity would quietly reset a standing dismissal on a code change that only
 *   changed how loud a rule is. They stay two values, and neither of them is identity
 *   (invariant 4).
 *
 * `status` and the disposition — what identity is FOR. A key that carried them could not
 *   answer the question the wall asks.
 */

/**
 * The concern behind one finding, as an exact string.
 *
 * `JSON.stringify` over an array rather than a delimiter join, because every part but the
 * first is free prose off the volume or out of a model, and there is no separator a quoted
 * span cannot contain. NULL survives as `null` and is distinct from `''` — an empty quote is
 * "nothing to highlight" (0010) and a missing scene is "about the whole artifact", and those
 * are two different concerns from the ones that name a span or a scene.
 *
 * Not hashed. It is long, and it is meant to be: a key somebody can read in a failing test is
 * worth more here than a short one, and nothing indexes it.
 */
export function concernKey(finding: Finding): string {
  return JSON.stringify([
    finding.checkKey,
    finding.anchor.artifactId,
    finding.anchor.sceneId,
    finding.anchor.quote,
    finding.entityId,
    finding.facts.map((fact) => fact.id),
    finding.concern,
  ])
}

/** Two firings of one concern — the question `stage-wall.ts` and `cried-wolf.ts` both ask. */
export function sameConcern(one: Finding, other: Finding): boolean {
  return concernKey(one) === concernKey(other)
}

/**
 * Every firing folded into its concern, groups in first-raised order and each group in the
 * order the firings came.
 *
 * Hand it `findingsIn` (document order: scene, then rowid) and the order inside a group is
 * chronological, because every firing of one concern shares its scene by construction — so
 * the first element of a group is the first time the check said it, and the last is the
 * latest word.
 */
export function concernGroups(findings: readonly Finding[]): Finding[][] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = concernKey(finding)
    const group = groups.get(key)
    if (group) group.push(finding)
    else groups.set(key, [finding])
  }
  return [...groups.values()]
}

/**
 * Ryan's standing word on a concern, as a twin of it reads it back.
 *
 * A record of the ORIGINAL, never a copy onto anything: the finding id is what a bench click
 * lands on, so the note is attributed to the finding he actually put down and the version he
 * put it down at.
 */
export interface StandingDismissal {
  /** The finding Ryan dismissed. The click target, and the provenance of the wall's silence. */
  findingId: string
  /** The draft he was looking at when he ruled. */
  version: number
  note: string
  at: string
}

/**
 * **The dismissal a twin inherits: Ryan's earliest word on this exact concern, from some other
 * finding.** Null when he has never put this concern down — which includes the case where the
 * finding in hand is itself the one he dismissed.
 *
 * THE CHOICE THIS ENCODES (E3-5's amendment named two answers and this is the second): an
 * identical twin at a new version reads the standing dismissal, and the wall stays down. The
 * alternative — the twin inherits nothing and Ryan re-dismisses after every rewrite — is
 * honest and was rejected, because E3-5 made re-firing ROUTINE: a rewrite anywhere in an
 * episode re-runs the free tier, so a finding he put down once comes back every time he fixes
 * something else. A check that can re-erect a wall Ryan has already brought down, indefinitely
 * and for free, is a veto on a slow clock — and invariant 3 says checks argue and never veto.
 * It also trains him to dismiss without reading, which spends the notes 4.4 exists to collect.
 *
 * **The earliest, not the latest.** A concern he has put down twice is attributed to the first
 * word he wrote on it, which is the one that explains why — the later ones are re-dismissals
 * of a twin, and pointing at them would hide the ruling behind its own echo.
 *
 * Hand it every finding anchored in the artifact (`findingsIn`), asked once per artifact
 * rather than once per finding — the same shape `stage-wall.ts` already uses for
 * `overriddenThrough`.
 */
export function inheritedDismissal(
  findings: readonly Finding[],
  finding: Finding,
): StandingDismissal | null {
  const key = concernKey(finding)
  for (const other of findings) {
    if (other.id === finding.id) continue
    // By KIND rather than by "has a disposition". `FINDING_DISPOSITION` is one member and
    // E3-5 argued it stays one; a kind added later would be a different answer from Ryan, and
    // it must not silently hold this wall down because it happened to close a finding.
    if (other.disposition?.kind !== 'dismissed') continue
    if (concernKey(other) !== key) continue
    return {
      findingId: other.id,
      version: other.anchor.version,
      note: other.disposition.note,
      at: other.disposition.at,
    }
  }
  return null
}
