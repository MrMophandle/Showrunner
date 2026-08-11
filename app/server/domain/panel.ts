import type { Store } from '../db/store.ts'
import { staleArtifacts, type Artifact } from './artifact.ts'
import { boardOf } from './board.ts'
import { craftChecksFor } from './craft.ts'
import {
  checkPassesOf,
  findingsIn,
  findingsOfPass,
  FINDING_CONFIDENCE,
  FINDING_SEVERITY,
  type CheckPass,
  type CheckTier,
  type Finding,
  type FindingConfidence,
  type FindingSeverity,
  type FindingStatus,
} from './finding.ts'
import { scenesOf } from './spine.ts'
import {
  categoryChecksFor,
  sceneSpans,
  waypointChecksFor,
  type CheckSubject,
} from './text-check.ts'

/**
 * The panel (4.5): **several reviewers against one artifact, as one verdict board.**
 *
 * Two halves, and they are different kinds of thing on purpose.
 *
 * `panelFor` is the ROSTER — who is convened. It is the composition of three existing
 * answers and adds no fourth: the categories this artifact's kind and provenance reach
 * (`categoryChecksFor`, 4.1), the arc positions its episode declares (`waypointChecksFor`,
 * D8), and the craft reviewers its kind is read by (`craftChecksFor`, D13). All three arrive
 * as `CheckSubject`, which is why there is one composer and one parser downstream and this
 * file contains neither.
 *
 * `verdictBoard` is the BOARD — what those reviewers have said. It is a READ.
 *
 * ## The board is a read, and this is the paragraph that keeps it one
 *
 * **Nothing is written when a panel finishes.** There is no `verdict_board` table, no
 * `panel_result` row, and no summary anybody has to keep up to date. Every number below is
 * computed out of `check_pass`, `check_pass_fact`, `finding`, `finding_disposition` and
 * `check_gap` at the moment it is asked for — the freshness pattern (1.3), the same rule that
 * makes artifact staleness, finding status and D12's wall computations rather than columns.
 *
 * The test that proves it is the dismissal: Ryan puts a finding down after a board was
 * rendered, and the row goes green with no write to any board anywhere. A stored summary
 * would have been falsified by that one ruling — and a gate payload is allowed to carry a
 * SNAPSHOT of this read (it is the record of what he was shown at that round, like
 * `gate_round.artifact_version`) precisely because the live answer can always be recomputed
 * and compared.
 *
 * So: **what a check SAID is immutable and derivable; what STANDS is computed.**
 *
 * ## What a row can say, and why `unread` is one of them
 *
 * A convened check with no pass at this version gets a row that says so. That is the same
 * argument `recordCheckPass` makes one level down — a clean run is a record and not an
 * absence — turned around: a check that has not run is not a check that found nothing, and a
 * board that simply omitted it would render an unread panel as a short clean one.
 *
 * `gapped` is 0012's third answer kept out of `clean`, and `stale` is invariant 4 applied to
 * the tier that is otherwise `certain`: four green deterministic rows computed from a board
 * built out of a script that has since been rewritten are four green checkmarks over a check
 * nobody has re-run. The deterministic rules cost nothing to re-run (`board-rules.ts`), which
 * is the answer, and saying so is this row's job.
 *
 * `partial` is E3-5's, and it is the same rule said about D14. A scene-scoped re-check reads
 * one scene of a draft and records a pass at that draft's version (`check_pass.scene_id`), so
 * without this the row for a reviewer that re-read scene 4 would go green over nine scenes it
 * never saw — a check that read a paragraph, rendered as a check that read the episode. What
 * it FOUND still counts as `found`, because a finding is a finding wherever it was read; what
 * it did not find is reported as what it is, which is not a clean reading of this artifact.
 *
 * ## Clustering is by OVERLAP, never by an equal quote
 *
 * Two reviewers reading the same moment quote it differently — one takes the sentence, the
 * other takes the clause inside it — so a byte-identical anchor key clusters nothing in
 * practice. `clusterFindings` resolves each stored quote back to its span in the artifact's
 * own text, through the same `sceneSpans` the anchor was verified against, and merges spans
 * that overlap inside one scene. The gate room renders one card per cluster with every
 * reviewer's say on it (4.5).
 *
 * It takes the text as an argument rather than reading the volume, exactly as
 * `composeTextCheck` does: what was read is the caller's business, and a domain module that
 * went and found its own file would make "which draft was this clustered against" a question
 * nobody at the call site could answer.
 */

// ── The roster ──────────────────────────────────────────────────────────────────

/**
 * Every reviewer this artifact convenes, in the order the panel runs them.
 *
 * Categories first because they are the ones that argue with canon and the ones whose
 * findings a producer can act on most directly; the arc positions next; the craft reviewers
 * last, because they are the ones Ryan reads rather than the writer.
 *
 * **Convening is decided by declarations, never by code** — with the one exception this
 * composition makes visible. A category is here because its sheet names this artifact kind
 * (3.2) AND this artifact declares it touches one of its entities (invariant 2); a waypoint
 * check is here because the episode declared a position (D8). Only the craft half is decided
 * by code, and `craft.ts` is where that exception is argued.
 */
export function panelFor(store: Store, artifact: Artifact): CheckSubject[] {
  return [
    ...categoryChecksFor(store, artifact),
    ...waypointChecksFor(store, artifact),
    ...craftChecksFor(artifact.kind),
  ]
}

// ── The board ───────────────────────────────────────────────────────────────────

/**
 * What one row of the verdict board can say.
 *
 * A const array and a union type, never a TS `enum` — the server runs its TypeScript under
 * Node's type stripping, which only erases.
 */
export const BOARD_VERDICT = ['unread', 'stale', 'partial', 'clean', 'gapped', 'found'] as const
export type BoardVerdict = (typeof BOARD_VERDICT)[number]

/** One reviewer's line on the board — the mockup's dot, name, and what-it-found. */
export interface BoardRow {
  checkKey: string
  /** How the reviewer names itself. The subject's label, or the check key for a rule. */
  label: string
  tier: CheckTier
  verdict: BoardVerdict
  /** Everything this check raised against this draft, standing or put down. */
  raised: number
  /** What still stands — what the verdict is computed from. */
  standing: number
  /** What it could not check at all. Never folded into `standing` (0012). */
  gaps: number
  /** How many facts it was handed. Zero for a craft reviewer, which was handed none (D13). */
  scope: number
  /** The worst severity still standing. Undefined when nothing does. */
  worstSeverity?: FindingSeverity
  /**
   * The strongest confidence among the findings at that worst severity. Reported BESIDE the
   * severity and never folded into it (invariant 4): "how bad if true" and "how sure it is
   * true" are two questions, and one number cannot answer both.
   */
  confidence?: FindingConfidence
  /** The scenes the standing findings land in, in document order — the mockup's anchor links. */
  scenes: number[]
  /** The pass this row reads, or null when the check has not read this draft. */
  passId: string | null
  /** The row's own sentence — "1 finding · severity high · confidence high · scene 4". */
  what: string
}

/** The board as a gate payload carries it and E5 renders it. */
export interface VerdictBoard {
  artifactId: string
  /** The draft every row is about. A row is about this version or it says it is unread. */
  version: number
  rows: BoardRow[]
  /** How many reviewers were convened, including the ones that have not read yet. */
  convened: number
  /**
   * How many of them have a pass to their name. `convened - read` is what the board is still
   * waiting on — and a `stale` row counts as read, because it did read something; what its
   * verdict says is that what it read has been rewritten since.
   */
  read: number
  /** Findings still standing across the whole panel. */
  standing: number
  gaps: number
  /** What the floor and the gate room say above the rows. */
  sentence: string
}

/**
 * The verdict board for one artifact, computed fresh.
 *
 * Deterministic rows join the text ones: E3-1's rules run against the continuity BOARD and
 * land their findings in the SCRIPT (0010), so a script's verdict board is incomplete without
 * them — which is 4.5's "one verdict board" rather than two half-boards Ryan has to read
 * together. They are read here and never RUN here: they belong to their own free stage and
 * their own button, and re-running a reading this file did not ask for would spend a stage's
 * money on a screen's behalf.
 */
export function verdictBoard(store: Store, artifact: Artifact): VerdictBoard {
  const scenes = new Map(scenesOf(store, artifact.episodeId).map((s) => [s.id, s.ordinal]))
  // What STANDS: anchored in this draft and not yet ruled on. A dismissal closes a finding
  // (0010) and this read is where that closure becomes a green row, with nothing rewritten.
  const standing = findingsIn(store, artifact.id).filter(
    (finding) => finding.anchor.version === artifact.version && finding.status === 'open',
  )

  const rows = [
    ...textRows(store, artifact, standing, scenes),
    ...deterministicRows(store, artifact, standing, scenes),
  ]
  const read = rows.filter((row) => row.passId !== null).length
  const open = rows.reduce((sum, row) => sum + row.standing, 0)
  const gaps = rows.reduce((sum, row) => sum + row.gaps, 0)

  return {
    artifactId: artifact.id,
    version: artifact.version,
    rows,
    convened: rows.length,
    read,
    standing: open,
    gaps,
    sentence: boardSentence(rows, read, open, gaps),
  }
}

/**
 * The scene-scoped rows (D14, E3-5). Counted separately from `read` on purpose: they DID read
 * something, so calling them unread would be a second lie, and folding them into a clean panel
 * would be the first one.
 */
const partialRows = (rows: BoardRow[]): BoardRow[] => rows.filter((row) => row.verdict === 'partial')

/**
 * One row per convened reviewer, paired with the pass it ran.
 *
 * The pairing is positional within a key, and that is not arbitrary: a key can be convened
 * more than once — two arc positions give two `waypoint-drift` subjects (D8) — and the panel
 * runs them in roster order, so the k-th pass under a key belongs to the k-th subject under
 * it. Taking the LAST n of them is what makes a re-run of the tier at the same version show
 * the latest reading rather than every reading it has ever had.
 *
 * **What latest-reading-wins costs, written down (noticed in E3-5).** A row's `standing` counts
 * only findings raised by the pass it shows, so a finding raised by an EARLIER pass at this
 * same version is open in the database and absent from this board — and `VerdictBoard.standing`
 * is the sum of the rows. It is reachable by running the tier twice over one draft and has
 * been since E3-4; E3-5's scene re-check makes it ordinary rather than rare, because a rewrite
 * is normally followed by a narrow reading and later by a wide one. It is left as it is on
 * purpose: the alternative is a board that shows a concern its own reviewer has since read
 * again and not repeated. The rows the loop and the gate room read (`findingsIn`,
 * `clusterFindings`) are unaffected — they are about the artifact, not about a reviewer's
 * latest word — so nothing is lost, only differently framed.
 */
function textRows(
  store: Store,
  artifact: Artifact,
  standing: Finding[],
  scenes: Map<string, number>,
): BoardRow[] {
  const roster = panelFor(store, artifact)
  const passes = checkPassesOf(store, artifact.id).filter(
    (pass) => pass.artifactVersion === artifact.version,
  )

  const taken = new Map<string, CheckPass[]>()
  for (const subject of roster) {
    if (taken.has(subject.key)) continue
    const expected = roster.filter((one) => one.key === subject.key).length
    taken.set(subject.key, passes.filter((pass) => pass.checkKey === subject.key).slice(-expected))
  }

  // Whether ANY pass under this key has read the whole draft at this version. A scene-scoped
  // pass says `partial` only when the answer is no (D14, E3-5): once a reviewer has read the
  // draft whole, "the rest of this draft it has not read" is false, and repeating it after a
  // scene re-check would be a second lie told in the safe direction.
  const readWhole = new Set(
    passes.filter((pass) => pass.sceneId === null).map((pass) => pass.checkKey),
  )

  const used = new Map<string, number>()
  return roster.map((subject) => {
    const at = used.get(subject.key) ?? 0
    used.set(subject.key, at + 1)
    const pass = taken.get(subject.key)![at]
    return rowOf(store, subject.key, subject.label, 'text', pass, standing, scenes, {
      readWhole: readWhole.has(subject.key),
    })
  })
}

/**
 * The deterministic verdicts standing on this artifact — the rules of the continuity board
 * derived from it (E3-1), if there is one.
 *
 * The board's own artifact is what those passes read, so the rows come from its current
 * version rather than from this artifact's; the FINDINGS they raised are anchored here, which
 * is what puts them on this board at all. A board the script has moved past renders `stale`:
 * its findings no longer stand against the current draft (D12's third condition), and a green
 * row there would be a check nobody has re-run rendered as a check that passed.
 */
function deterministicRows(
  store: Store,
  artifact: Artifact,
  standing: Finding[],
  scenes: Map<string, number>,
): BoardRow[] {
  const board = boardOf(store, artifact.episodeId)
  if (!board || board.source?.id !== artifact.id) return []

  const stale = staleArtifacts(store, artifact.episodeId).some(
    (one) => one.artifact.id === board.artifact.id,
  )
  const passes = checkPassesOf(store, board.artifact.id).filter(
    (pass) => pass.artifactVersion === board.artifact.version,
  )

  // One row per rule, latest reading first past the post — a rule is convened once per run
  // (`runBoardRules`), so unlike an arc there is never more than one live pass under a key.
  const latest = new Map(passes.map((pass) => [pass.checkKey, pass]))
  return [...latest.values()].map((pass) => {
    const row = rowOf(store, pass.checkKey, pass.checkKey, 'deterministic', pass, standing, scenes)
    if (!stale) return row
    return {
      ...row,
      verdict: 'stale' as const,
      what:
        `built from ${board.source?.kind ?? 'the source'} v${pass.artifactVersion}, and this is ` +
        `v${artifact.version} — re-run the board rules, they cost nothing`,
    }
  })
}

/** One row, from one pass or from the absence of one. */
function rowOf(
  store: Store,
  checkKey: string,
  label: string,
  tier: CheckTier,
  pass: CheckPass | undefined,
  standing: Finding[],
  scenes: Map<string, number>,
  /** Whether this check has read the whole draft at this version — see `textRows`. */
  read: { readWhole: boolean } = { readWhole: false },
): BoardRow {
  if (!pass) {
    return {
      checkKey,
      label,
      tier,
      verdict: 'unread',
      raised: 0,
      standing: 0,
      gaps: 0,
      scope: 0,
      scenes: [],
      passId: null,
      what: 'has not read this draft',
    }
  }

  const raised = findingsOfPass(store, pass.id)
  const open = standing.filter((finding) => finding.passId === pass.id)
  const worst = worstSeverityOf(open)
  const sure = worst === undefined ? undefined : strongestConfidence(open, worst)
  const where = [
    ...new Set(
      open
        .map((finding) => (finding.anchor.sceneId === null ? null : scenes.get(finding.anchor.sceneId)))
        .filter((ordinal): ordinal is number => ordinal !== undefined && ordinal !== null),
    ),
  ]

  // `partial` before `gapped`, because they answer about different things: a gap is a hole in
  // the SCOPE this pass was handed, and a scene-scoped pass narrowed the ARTIFACT. A pass that
  // read one scene and could not reach a species is both, and the narrower reading is the one
  // that decides whether this row may be read as an answer about the draft (D14, E3-5).
  const verdict: BoardVerdict =
    open.length > 0
      ? 'found'
      : pass.sceneId !== null && !read.readWhole
        ? 'partial'
        : pass.gapCount > 0
          ? 'gapped'
          : 'clean'
  return {
    checkKey,
    label,
    tier,
    verdict,
    raised: raised.length,
    standing: open.length,
    gaps: pass.gapCount,
    scope: pass.scopeCount,
    ...(worst && { worstSeverity: worst }),
    ...(sure && { confidence: sure }),
    scenes: where,
    passId: pass.id,
    what: whatItFound({
      verdict,
      raised: raised.length,
      open: open.length,
      pass,
      worst,
      sure,
      where,
      read: pass.sceneId === null ? null : (scenes.get(pass.sceneId) ?? null),
    }),
  }
}

/** The row's sentence, in the words the mockup's "what" column uses. */
function whatItFound(row: {
  verdict: BoardVerdict
  raised: number
  open: number
  pass: CheckPass
  worst: FindingSeverity | undefined
  sure: FindingConfidence | undefined
  where: number[]
  /** The one scene this pass was narrowed to, as the episode numbers it (D14). */
  read: number | null
}): string {
  const scope = row.pass.scopeCount === 0 ? '' : ` · ${row.pass.scopeCount} facts in scope`
  if (row.verdict === 'partial') {
    return (
      `read scene ${row.read ?? '?'} of this draft and found nothing there${scope} — the rest ` +
      'of this draft it has not read'
    )
  }
  if (row.verdict === 'gapped') {
    return (
      `clean, and ${row.pass.gapCount} thing(s) it could not check at all — canon has not ` +
      'decided them, so no rewrite would answer one'
    )
  }
  if (row.verdict === 'clean') {
    const put = row.raised === 0 ? '' : ` — ${row.raised} finding(s) you dismissed`
    return `clean${scope}${put}`
  }
  const at = row.where.length === 0 ? '' : ` · scene ${row.where.join(', ')}`
  return `${row.open} finding(s) · severity ${row.worst} · confidence ${row.sure}${at}`
}

/** What the panel says above its rows. */
function boardSentence(rows: BoardRow[], read: number, standing: number, gaps: number): string {
  if (rows.length === 0) {
    return (
      'No check was called over this artifact at all. That is not a clean reading; it is ' +
      'a draft nothing has read.'
    )
  }
  const partial = partialRows(rows).length
  if (read < rows.length) {
    const so = standing === 0 ? '' : ` ${standing} finding(s) stand on what they did read.`
    const narrowed =
      partial === 0
        ? ''
        : ` ${partial} of those read only the scene that was rewritten, not the whole draft.`
    return `${read} of ${rows.length} checks have read this draft.${narrowed}${so}`
  }
  const said =
    standing === 0
      ? partial === 0
        ? `${rows.length} checks read this draft and nothing stands. That pass is recorded, ` +
          'because a clean reading is a measurement'
        : `Nothing stands, and ${partial} of the ${rows.length} checks have read only the ` +
          'scene that was rewritten. They have not read the rest of this draft'
      : `${standing} finding(s) standing across ${rows.length} checks`
  return gaps === 0
    ? `${said}.`
    : `${said}, and ${gaps} thing(s) they could not check at all.`
}

const worstSeverityOf = (findings: Finding[]): FindingSeverity | undefined =>
  findings.length === 0
    ? undefined
    : FINDING_SEVERITY.filter((severity) => findings.some((one) => one.severity === severity)).at(-1)

/** The strongest claim made at the worst severity. `FINDING_CONFIDENCE` runs strongest first. */
const strongestConfidence = (
  findings: Finding[],
  severity: FindingSeverity,
): FindingConfidence | undefined =>
  FINDING_CONFIDENCE.find((confidence) =>
    findings.some((one) => one.severity === severity && one.confidence === confidence),
  )

// ── Clustering ──────────────────────────────────────────────────────────────────

/** One reviewer's say, on a card that may carry several. */
export interface ClusterSay {
  findingId: string
  checkKey: string
  tier: CheckTier
  severity: FindingSeverity
  confidence: FindingConfidence
  concern: string
  /** What this reviewer quoted, which is rarely what the others quoted. */
  quote: string
  status: FindingStatus
  /** The canon entity it is about. Null for a craft finding — there is no canon (D13). */
  entityId: string | null
  /** The facts it argues with, as the card quotes them. */
  facts: string[]
  /**
   * **"world-rules · severity high · confidence high · text, a reading"** — the card's own
   * line, composed here because a cluster has more than one reader now (E4-7).
   *
   * E3-7 composed it in `check-bench.ts`, which was right while the check bench was the only
   * surface that rendered a cluster. The writing room's gates render the premise-brief's and
   * the outline's findings, which that bench never sees (it is script-only), so the string
   * moved down to the module that owns what a say IS — one composer, two readers, which is the
   * same move `proposalOnTheBench` made for the sweep.
   *
   * Severity and confidence stay side by side and are never folded into one word (invariant
   * 4): "how bad if true" and "how sure it is true" are two questions. The tier rides with
   * them because `certain` off a row means something different from a model's certainty (4.2).
   */
  sentence: string
}

/** One card in the gate room: a span of the artifact, and everything said about it. */
export interface FindingCluster {
  sceneId: string | null
  /** The scene as the episode numbers it. Null when the finding is about the whole artifact. */
  scene: number | null
  /** The span the card highlights — the union of what was quoted. '' when nothing was. */
  quote: string
  /** Where the span starts in the artifact's text, for ordering and for the UI's highlight. */
  from: number
  to: number
  says: ClusterSay[]
  /** How many of the says still stand. A card of dismissals is still worth rendering. */
  standing: number
  worstSeverity?: FindingSeverity
}

/**
 * Every finding anchored in this draft, clustered at the spans they overlap on.
 *
 * A finding with no span (`quote: ''`) does not join a span cluster and does not swallow one:
 * it is about the scene or about the whole artifact, so it gets one card per scene, placed at
 * the scene's start. Giving it the scene's whole span would fold every other finding in that
 * scene into it, which is one card with everything on it rather than one card per moment.
 */
export function clusterFindings(store: Store, artifact: Artifact, text: string): FindingCluster[] {
  const scenes = scenesOf(store, artifact.episodeId)
  const ordinals = new Map(scenes.map((scene) => [scene.id, scene.ordinal]))
  const spans = new Map(sceneSpans(text, scenes).map((span) => [span.scene.id, span]))

  const placed = findingsIn(store, artifact.id)
    .filter((finding) => finding.anchor.version === artifact.version)
    .map((finding) => {
      const span = finding.anchor.sceneId ? spans.get(finding.anchor.sceneId) : undefined
      const from = span?.from ?? 0
      const to = span?.to ?? text.length
      if (finding.anchor.quote === '') return { finding, at: -1, end: -1, from, to }
      const at = text.indexOf(finding.anchor.quote, from)
      // A quote that no longer resolves — the artifact re-flowed under a finding still
      // anchored at this version — keeps its card rather than vanishing off the screen.
      return at < 0 || at >= to
        ? { finding, at: -1, end: -1, from, to }
        : { finding, at, end: at + finding.anchor.quote.length, from, to }
    })

  const clusters: FindingCluster[] = []
  for (const one of placed.filter((entry) => entry.at < 0)) {
    const key = one.finding.anchor.sceneId
    const existing = clusters.find((cluster) => cluster.quote === '' && cluster.sceneId === key)
    if (existing) existing.says.push(sayOf(one.finding))
    else {
      clusters.push({
        sceneId: key,
        scene: key === null ? null : (ordinals.get(key) ?? null),
        quote: '',
        from: one.from,
        to: one.from,
        says: [sayOf(one.finding)],
        standing: 0,
      })
    }
  }

  // The sweep: spans in document order, merged while they overlap and stay in one scene. Two
  // reviewers quoting the same moment differently land in one card; two moments in one scene
  // stay two cards.
  for (const one of placed.filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at || a.end - b.end)) {
    const open = clusters.at(-1)
    if (
      open &&
      open.quote !== '' &&
      open.sceneId === one.finding.anchor.sceneId &&
      one.at < open.to
    ) {
      open.to = Math.max(open.to, one.end)
      open.quote = text.slice(open.from, open.to)
      open.says.push(sayOf(one.finding))
      continue
    }
    clusters.push({
      sceneId: one.finding.anchor.sceneId,
      scene: one.finding.anchor.sceneId === null ? null : (ordinals.get(one.finding.anchor.sceneId) ?? null),
      quote: text.slice(one.at, one.end),
      from: one.at,
      to: one.end,
      says: [sayOf(one.finding)],
      standing: 0,
    })
  }

  for (const cluster of clusters) {
    cluster.standing = cluster.says.filter((say) => say.status === 'open').length
    const worst = worstOf(cluster.says.filter((say) => say.status === 'open'))
    if (worst) cluster.worstSeverity = worst
  }
  return clusters.sort((a, b) => a.from - b.from || a.to - b.to)
}

const sayOf = (finding: Finding): ClusterSay => ({
  findingId: finding.id,
  checkKey: finding.checkKey,
  tier: finding.tier,
  severity: finding.severity,
  confidence: finding.confidence,
  concern: finding.concern,
  quote: finding.anchor.quote,
  status: finding.status,
  entityId: finding.entityId,
  facts: finding.facts.map((fact) => fact.statement),
  sentence:
    `${finding.checkKey} · severity ${finding.severity} · confidence ${finding.confidence} · ` +
    `${finding.tier === 'deterministic' ? 'deterministic, from the rows' : 'text, a reading'}`,
})

const worstOf = (says: ClusterSay[]): FindingSeverity | undefined =>
  says.length === 0
    ? undefined
    : FINDING_SEVERITY.filter((severity) => says.some((say) => say.severity === severity)).at(-1)
