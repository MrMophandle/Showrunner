import type { Store } from '../db/store.ts'
import { artifactsOf, type Artifact } from '../domain/artifact.ts'
import { inheritedDismissal } from '../domain/concern.ts'
import { findingsIn, type Finding } from '../domain/finding.ts'
import { episodeLabel, findEpisode, scenesOf } from '../domain/spine.ts'
import { overriddenThrough } from './gate.ts'

/**
 * The D12 wall: **a deterministic finding blocks the next stage, and never Ryan's gate.**
 *
 * ## It is computed, and there is nothing here to clear
 *
 * "Blocked" is not a column, not a flag, and not an event anyone has to remember to write.
 * It is this read, over live rows, asked again every time somebody wants to start work —
 * exactly as artifact staleness is (1.3) and finding status is (0010). The wall goes UP
 * because five things are true at once, and it comes DOWN because one of them stopped being
 * true, with no unblocking write anywhere in the app:
 *
 *   1. the finding is `deterministic` — the tier that reads rows and answers `certain` (4.2).
 *      A text finding argues and never vetoes; that is invariant 3 and it is not negotiable.
 *   2. it is still open. A dismissal is a disposition, and a disposition is Ryan's answer.
 *   3. it is anchored at the artifact's CURRENT version. A finding is a record of what was
 *      true about one draft; when a rewrite lands, the draft it argued with is gone, and the
 *      free deterministic tier costs nothing to re-run over the new one (`board-rules.ts`).
 *      Without this the first rewrite would wall an episode forever, and the only way out
 *      would be dismissing a finding that had already been fixed — which would spend the
 *      check's credibility in D11's ratio for being right.
 *   4. Ryan has not overridden it. Approving over a red finding is recorded as an explicit
 *      override (invariant 3), and an override that did not move the wall would be a verdict
 *      with no consequence — which is the same as a check vetoing him.
 *   5. **He has not already put this exact concern down** (E3-6, `domain/concern.ts`). E3-5's
 *      one-motion apply re-runs the free tier on every rewrite, so a rule reading rows nobody
 *      touched raises a fresh open TWIN of a finding he ruled on last week — and without this
 *      the wall he brought down goes back up, for free, every time he fixes something else.
 *      That is a veto on a slow clock, which is invariant 3 in the one direction it can be
 *      violated without anybody writing "blocked" anywhere.
 *
 *      It is READ, never copied: `inheritedDismissal` compares identity across live rows, the
 *      twin stays `open`, and its firing still counts in D11's denominator. The identity is
 *      exact — same check, same span, same scene, same entity, same canon, same words — so a
 *      genuinely new contradiction the same rule finds raises the wall as it always did. That
 *      strictness is the load-bearing part; the failure it prevents is a wall that stays down
 *      over something nobody has ruled on.
 *
 * ## What it refuses, and what it must never touch
 *
 * It refuses **the next stage's enqueue**, through `launchBlockedBecause` (operating.ts) —
 * the one place in this app where work is already refused with a sentence. It has nothing to
 * do with `createRulings`: the three verbs take no preconditions, and adding one is the exact
 * thing D12 forbids. A gate says where Ryan stood, never whether he may rule.
 *
 * ## Two things this owes the issues after it
 *
 * **The wall is per EPISODE, because a button is.** `launchBlockedBecause` answers "may work
 * start on this episode", which is all E1's one button ever needed. E3-7 gives each stage its
 * own button (and its own declared spend), and that is where "the next stage" gets to mean a
 * particular stage rather than every stage — including the free re-check, which should never
 * be walled by the finding it exists to clear.
 *
 * **E3-5 landed the other two ways out, and neither is a hole.** Dismiss-with-note closes the
 * finding, which is condition 2 and is Ryan's answer either way. The pre-drafted rewrite moves
 * the artifact past the draft the finding argued with, which is condition 3 — and it is why
 * `applyRewrite` (`remediation.ts`) is ONE motion: it revises the artifact and re-runs this
 * free tier over the new version in the same transaction, so a `check_pass` at the current
 * version exists before anything can ask this question again. A rewrite that landed a version
 * and stopped would drop the wall over a draft nobody had read, which is never-checked
 * rendering as checked-clean; that is the collapse the motion exists to prevent, and it is
 * asserted directly in `remediation.test.ts` against a revise-and-stop control.
 *
 * The override below is still the third way, and still the only one that takes a gate.
 */

/**
 * **What a blocking finding says on the card it appears on** — D12 in one sentence, and the
 * three ways down from it.
 *
 * It lives here rather than on the surface that renders it because there is more than one
 * surface now: E3-7's check bench marks the script's blocking findings with it, and E4-7's
 * writing room marks them at the gate the override is pressed at. Two copies would drift, and
 * the one that drifted would be the one telling Ryan a deterministic finding reaches his gate
 * — which is the single thing D12 exists to deny.
 */
export const BLOCKS_THE_NEXT_STAGE =
  'Blocks the next stage until it is resolved, and never this gate (D12): approving over it ' +
  'at the gate is recorded as your override, putting it down with a note is your answer, and ' +
  'a rewrite that re-reads clean is the third way.'

/** One finding standing in the way, with what a sentence needs to name it. */
export interface StageBlock {
  finding: Finding
  /** What it is anchored in — the artifact a stage would consume next. */
  artifact: Artifact
  /** The scene it sits in, as the script numbers it. Null: it is about the whole artifact. */
  scene: number | null
  /** "the ep01 script" — the artifact in Ryan's words. */
  subject: string
}

/**
 * Every deterministic finding standing unresolved against this episode's material, in
 * document order per artifact.
 *
 * E3-7's check bench renders all of them, marked as stage-blocking; the sentence below names
 * the first and counts the rest.
 */
export function stageBlockingFindings(store: Store, episodeId: string): StageBlock[] {
  const scenes = new Map(scenesOf(store, episodeId).map((scene) => [scene.id, scene.ordinal]))
  const blocks: StageBlock[] = []

  for (const artifact of artifactsOf(store, episodeId)) {
    // Asked once per artifact rather than once per finding: it is one row either way, and
    // the version it answers with is what decides every finding anchored in it.
    const overridden = overriddenThrough(store, artifact.id)
    // And read once for the same reason. Every firing of one concern is anchored in the same
    // artifact by construction (`concern.ts`), so this list holds every twin there is.
    const anchored = findingsIn(store, artifact.id)

    for (const finding of anchored) {
      if (finding.tier !== 'deterministic') continue
      if (finding.status !== 'open') continue
      if (finding.anchor.version !== artifact.version) continue
      if (overridden !== null && overridden >= finding.anchor.version) continue
      if (inheritedDismissal(anchored, finding) !== null) continue

      blocks.push({
        finding,
        artifact,
        scene: finding.anchor.sceneId === null ? null : (scenes.get(finding.anchor.sceneId) ?? null),
        subject: subjectOf(store, artifact),
      })
    }
  }
  return blocks
}

/**
 * Why the next stage cannot start on this episode, in the words a disabled button renders and
 * the API refuses with. Null when nothing stands in the way.
 *
 * It names the finding and where it lands, out of the rows it computed from — never "checks
 * failed". A refusal Ryan has to go and investigate has failed the HIL contract before he has
 * even clicked anything.
 */
export function stageBlockedBecause(store: Store, episodeId: string): string | null {
  const [first, ...rest] = stageBlockingFindings(store, episodeId)
  if (!first) return null

  const where = first.scene === null ? first.subject : `scene ${first.scene} of ${first.subject}`
  const others =
    rest.length === 0
      ? ''
      : ` ${rest.length} more deterministic finding${rest.length === 1 ? '' : 's'} stand${
          rest.length === 1 ? 's' : ''
        } with it.`

  return (
    `${episodeLabel(numberOf(store, episodeId))} is blocked — the ${first.finding.checkKey} ` +
    `finding at ${where} stands unresolved: “${firstSentence(first.finding.concern)}”.${others} ` +
    'Deterministic findings block the next stage and never your gate (D12): rule on it at the ' +
    'gate as a recorded override, put it down with a note, or fix it and re-run the checks — ' +
    'the deterministic ones cost nothing.'
  )
}

/** "the ep01 script", "the ep01 shot-image shot-05" — the artifact in Ryan's words. */
function subjectOf(store: Store, artifact: Artifact): string {
  const label = episodeLabel(numberOf(store, artifact.episodeId))
  return `the ${label} ${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`
}

function numberOf(store: Store, episodeId: string): number {
  return findEpisode(store, episodeId)?.number ?? 0
}

/**
 * The first sentence of the concern, which is where every check in this app puts the claim —
 * "Ilse Renn is in two places at one time." The rest argues it, and a button has no room to.
 *
 * **Exported for the floor** (E5-1), which needs the same clip for the same reason: a
 * needs-you card is a summons and says what, why and where in one sentence, while the
 * argument in full lives in the room the card links to. One helper rather than two, because
 * two copies of "where does a sentence end" would eventually disagree about an ellipsis.
 */
export function firstSentence(concern: string): string {
  const end = /[.!?](\s|$)/.exec(concern)
  return end ? concern.slice(0, end.index + 1) : concern
}
