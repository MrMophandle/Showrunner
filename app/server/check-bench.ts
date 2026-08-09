import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_REFUSALS } from './canon-bench.ts'
import { criedWolf, type CheckRecord } from './cried-wolf.ts'
import type { Store } from './db/store.ts'
import type { Artifact } from './domain/artifact.ts'
import { inheritedDismissal, type StandingDismissal } from './domain/concern.ts'
import {
  checkPassesOf,
  DISMISSAL_NEEDS_A_NOTE,
  findingsIn,
  findingsOfPass,
  gapsOfPass,
  scopeOfPass,
  type CheckGap,
  type CheckTier,
  type Finding,
  type FindingConfidence,
  type FindingSeverity,
  type FindingStatus,
} from './domain/finding.ts'
import { clusterFindings, verdictBoard, type BoardRow, type VerdictBoard } from './domain/panel.ts'
import { episodeInShow, episodeLabel } from './domain/spine.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { readingStages, stageOffer, type ArtifactUnderReview, type Offer } from './operating.ts'
import {
  recheckOffers,
  remediationsFor,
  type FindingRemediations,
  type RecheckOnTheBench,
} from './remediation.ts'
import { SCRIPT_GATE_KIND } from './runner/script-gate-step.ts'
import { stageBlockedBecause, stageBlockingFindings } from './runner/stage-wall.ts'
import { stageCatalogue } from './runner/stages.ts'
import { artifactOf } from './runner/text-check-step.ts'

/**
 * The check bench (E3-7) — **the read model behind the operating page's checks section, and
 * the epic exit of E3**: the surface Ryan runs the checks from, reads what they said at the
 * spans they said it about, remediates one finding at a time, and watches D12's wall stand
 * up and come down.
 *
 * ## It renders six issues of records and produces none of its own
 *
 * Nothing here checks anything. Every number, sentence and card below is a READ over rows
 * E3-0 through E3-6 already write — `check_pass` and its zero-finding rows, `finding` and
 * `finding_disposition`, `check_gap`, the continuity board, the panel roster, the gate
 * ledger. It runs no rule, calls no model, and writes nothing at all; the only acts it
 * offers are the ones `remediation.ts` and the runner already own, composed as offers with
 * their costs and their refusals on them.
 *
 * That is also why it is a bench rather than a screen. `mockups/gate-room.html` is what E5
 * makes of this and none of it is built here: no colour, no highlight, no fold, no dock. What
 * IS built is the SHAPE that mockup renders — the artifact readable with each finding at its
 * anchor, one card per cluster carrying every reviewer's say, severity and confidence side by
 * side, the verdict board beside it — so E5 finds all of it already queryable.
 *
 * ## The HIL contract is the test: everything pertinent, present, zero archaeology
 *
 * Which is why several things that could be inferred are said instead:
 *
 *   * **A blocking finding says it is blocking**, and says the same sentence the disabled
 *     button says (`stage-wall.ts`). D12 is a computation, so nothing marks a finding; this
 *     asks the wall which findings it is standing on and marks the cards from the answer.
 *   * **A twin that a standing dismissal reaches says so, by name** (E3-6). Without it Ryan
 *     sees an open finding beside a wall that is down and has to go and work out why — which
 *     is the archaeology this contract forbids, over the one mechanism built so his own
 *     ruling would keep working.
 *   * **A gap is on the bench, never folded into a silence** (0012). A pass with a gap is not
 *     a clean run, and the row that says "clean, and 1 thing it could not check at all" is the
 *     honest confidence invariant 4 is about.
 *   * **A check that has read and never fired is on the bench too** (D11). The Long Pier obeys
 *     rules 2 and 3 of *the hull and the void* on purpose, and their silence is a MEASUREMENT
 *     — visible as a `clean` row with its scope count, not as an absence.
 *
 * ## Every button here already existed, and none of them ratifies
 *
 * The run buttons are the stage catalogue filtered to the stages whose work is READING
 * (`readingStages`, operating.ts) — never a list of stage names, so a check stage added later
 * appears here by declaring itself rather than by somebody remembering this file. The
 * remediations are E3-5's three, unchanged. **Not one act on this bench writes canon**: the
 * propose button raises a proposal and stops, and ratifying it is Ryan's, at the canon bench,
 * through the one ruling API (invariant 1).
 *
 * ## What this read costs, written down before somebody wonders
 *
 * `remediationsFor` resolves where each finding stands, and resolving that reads the artifact
 * off the volume — so composing the cards reads one small file once per finding rather than
 * once per bench. That is deliberate and it is left alone: the alternative is threading a
 * cached text through `remediation.ts`, which would make "which draft was this offer composed
 * against" a question the call site could no longer answer, and that is the exact property
 * `panel.ts` and `composeTextCheck` both take an explicit text for. If a real episode ever
 * makes it slow, the fix is passing the text in, not caching it here.
 */

/**
 * The three preconditions the PAGE owns, because each lives in a field the server has never
 * seen — a note in a textarea, a replacement in one, a new statement in another.
 *
 * They are composed here, handed down the wire and refused with by the API, so a disabled
 * button and a 409 are one string. `BENCH_REFUSALS`'s shape, and its reason (canon-bench.ts).
 */
export const CHECK_REFUSALS = {
  dismissNeedsNote: DISMISSAL_NEEDS_A_NOTE,
  changeNeedsStatement: BENCH_REFUSALS.changeNeedsStatement,
  rewriteNeedsReplacement:
    'Pre-draft a replacement, or write one yourself — an apply lands what is in the box word ' +
    'for word (D20), and an empty box is not a deletion you meant.',
} as const

export type CheckRefusals = typeof CHECK_REFUSALS

// ── What the checks section is handed ───────────────────────────────────────────

export interface CheckBenchView {
  episodeId: string
  /** "ep01". */
  label: string
  title: string
  /** The show, because the cried-wolf window is a show's. */
  show: { id: string; title: string }
  /** The artifact the checks read, rendered — never a filename (D15, 4.6). */
  artifact: ArtifactUnderReview
  version: number
  /** One button per stage that READS this episode's material, in catalogue order. */
  runs: StageOnTheBench[]
  /** The verdict board, computed fresh (`panel.ts`) — one row per convened reviewer. */
  board: VerdictBoard
  /** What each row's verdict means and what to do about it, where there is something to do. */
  rows: RowOnTheBench[]
  /** Everything a reviewer could not check at all, kept out of every silence (0012). */
  gaps: GapOnTheBench[]
  /** One card per cluster, in document order, each with every reviewer's say (4.5). */
  clusters: ClusterOnTheBench[]
  /**
   * The paid half a rewrite deliberately did not run (D14): one button per scene still owed a
   * re-reading. These are NOT on the cards above and cannot be — a finding awaiting a re-check
   * is one this draft has already moved past, so it has left the cards by construction.
   */
  rechecks: RecheckOnTheBench[]
  /**
   * D12's wall in its own words, or null when nothing stands in the way — the same string
   * `launchBlockedBecause` refuses a producing stage with, so the two cannot drift.
   */
  wall: string | null
  /** The gate over this artifact, if a run has ever opened one — the wall's third door. */
  gateRunId: string | null
  /** D11's maintenance prompts, where a check has earned one. Questions, and nothing acts. */
  tune: string[]
  /** Every check that has read anything for this show lately, silent ones included (D11). */
  record: CheckRecord[]
  refusals: CheckRefusals
  /** What to do when there is nothing to check here yet, or null when there is. */
  emptyBecause: string | null
}

/** One stage's button, with the stage it starts so the page never holds its own copy. */
export interface StageOnTheBench {
  /** As `run.stage` persists it and the API takes it. */
  stage: string
  offer: Offer
}

/** One verdict-board row, with the sentence that says what to do about what it says. */
export interface RowOnTheBench {
  row: BoardRow
  /**
   * What would answer this row, in words, or null when the row is an answer already.
   *
   * `unread`, `stale` and `partial` are the three verdicts that are not a reading of this
   * draft, and each has a different fix: convene the reviewer, re-extract the board it was
   * computed from, read the rest of the draft. A screen that rendered all three as "not
   * green" would be inviting exactly the archaeology this bench exists to remove.
   */
  fix: string | null
  /**
   * **Every fact this reviewer was handed, and whether any of its findings cited one** —
   * the denominator of a measured silence, by name rather than as a count.
   *
   * This is what makes The Long Pier's controls readable. Rules 2 and 3 of *the hull and the
   * void* are obeyed throughout that script on purpose, and their silence is the fixture's
   * whole point (0010, D11). A row saying "clean · 6 facts in scope" proves a check ran and
   * says nothing about WHICH six — so a reader cannot tell a rule that was loaded and left
   * alone from one that was never in front of it, which is the difference the pass table was
   * built to record. Loaded and un-cited is a measurement; absent is not.
   */
  scope: ScopeOnTheBench[]
}

/** One fact a reviewer was handed, and what it did about it. */
export interface ScopeOnTheBench {
  factId: string
  statement: string
  /** The edge it travelled to get here (D22, D23). '' when it is the entity's own fact. */
  via: string
  /** Whether any finding of this pass quoted it. False is the measured silence. */
  cited: boolean
}

/** One thing a reviewer could not check, and why. Never a finding, never a silence (0012). */
export interface GapOnTheBench {
  checkKey: string
  reason: CheckGap['reason']
  /** "could not check Sefa Doule's physiology — species undecided". */
  detail: string
}

/** One reviewer's say, on a card that may carry several. */
export interface SayOnTheBench {
  findingId: string
  checkKey: string
  tier: CheckTier
  /** Two values, never one (invariant 4). */
  severity: FindingSeverity
  confidence: FindingConfidence
  concern: string
  /** What THIS reviewer quoted, which is rarely what the others on the card quoted. */
  quote: string
  status: FindingStatus
  /** The facts it argues with, as the card quotes them, with their lineage (3.1). */
  facts: string[]
  /** "world-rules · severity high · confidence high · text" — the card's own line. */
  sentence: string
  /**
   * Whether this finding is one D12's wall is standing on right now — asked of the wall
   * rather than read off the finding, because "blocking" is a computation and there is no
   * column for it (`stage-wall.ts`, 0010).
   */
  blocking: boolean
  /** Said on the card, so a red mark never implies a veto. */
  blockingSentence: string | null
  /** Ryan's own word on it, when he has put it down. */
  dismissal: { note: string; at: string } | null
  /**
   * His standing word on this exact concern, inherited from ANOTHER firing of it (E3-6).
   *
   * This is the sentence that closes E3-6's loop on screen. A free re-run raises an
   * identical twin of a finding he dismissed last week; the twin is open, it counts in
   * D11's denominator, and the wall stays down because `inheritedDismissal` reaches it. An
   * open finding beside a wall that is down, with nothing saying why, would be the app
   * hiding his own ruling from him.
   */
  inherited: (StandingDismissal & { sentence: string }) | null
  /** 4.3's three buttons, each with its cost and — where it cannot be pressed — its refusal. */
  remediations: FindingRemediations
}

/** One card in the gate room's shape: a span of the artifact, and everything said about it. */
export interface ClusterOnTheBench {
  /** As the episode numbers it. Null when the finding is about the whole artifact. */
  scene: number | null
  /** The span the card is anchored at. '' when there is nothing to highlight (4.3). */
  quote: string
  /** Where the span sits in the artifact's text, so the page can render it in place. */
  from: number
  to: number
  /** How many of the says still stand. A card of dismissals is still worth rendering. */
  standing: number
  worstSeverity?: FindingSeverity
  says: SayOnTheBench[]
}

// ── The bench ───────────────────────────────────────────────────────────────────

export function checkBenchView(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
  llm: LLMReadiness,
): CheckBenchView | undefined {
  const where = episodeInShow(store, episodeId)
  if (!where) return undefined

  const label = episodeLabel(where.episode.number)
  const catalogue = stageCatalogue(library)
  const runs = readingStages(catalogue).map((stage) => ({
    stage: stage.name,
    offer: stageOffer(store, llm, episodeId, stage),
  }))

  const artifact = artifactOf(store, episodeId, SCRIPT_GATE_KIND)
  const common = {
    episodeId,
    label,
    title: where.episode.title,
    show: { id: where.show.id, title: where.show.title },
    runs,
    wall: stageBlockedBecause(store, episodeId),
    gateRunId: gateRunOver(store, artifact),
    // Asked of the show, not of the episode: D11's question is "how has this check behaved
    // lately", and a check reads across an episode's siblings.
    record: criedWolf(store, { showId: where.show.id }),
    refusals: CHECK_REFUSALS,
  }

  if (!artifact) {
    return {
      ...common,
      artifact: {
        id: '',
        kind: SCRIPT_GATE_KIND,
        slot: '',
        version: 0,
        filePath: null,
        text: null,
        note: `${label} has no ${SCRIPT_GATE_KIND} on the volume.`,
      },
      version: 0,
      board: emptyBoard(),
      rows: [],
      gaps: [],
      clusters: [],
      rechecks: [],
      tune: [],
      emptyBecause:
        `${label} has no ${SCRIPT_GATE_KIND} to check. Checks fire at artifact boundaries ` +
        'and never continuously (4.1) — there is no boundary here yet, so there is nothing ' +
        'on this bench and nothing it could cost you to find that out.',
    }
  }

  const read = readArtifact(library, artifact)
  const board = verdictBoard(store, artifact)
  // Asked once and shared by every card: the wall is a read over live rows, and asking it
  // per finding would be the same query once per card.
  const blocking = new Set(
    stageBlockingFindings(store, episodeId).map((block) => block.finding.id),
  )
  const anchored = findingsIn(store, artifact.id)

  return {
    ...common,
    artifact: read,
    version: artifact.version,
    board,
    rows: board.rows.map((row) => ({
      row,
      fix: fixFor(row),
      scope: scopeOn(store, row),
    })),
    gaps: gapsOn(store, artifact),
    clusters: clustersOn(store, library, artifact, read.text ?? '', {
      anchored,
      blocking,
      llm,
    }),
    rechecks: recheckOffers(store, artifact, llm),
    tune: common.record.map((one) => one.tune).filter((one) => one !== null),
    emptyBecause:
      board.rows.length === 0
        ? `Nothing has read the ${label} ${SCRIPT_GATE_KIND} v${artifact.version} yet, and no ` +
          'reviewer is convened over it. Run the checks above — the deterministic ones cost ' +
          'nothing, and a clean run is a measurement rather than an absence.'
        : null,
  }
}

// ── The cards ───────────────────────────────────────────────────────────────────

/**
 * Every finding anchored in this draft, clustered at the spans they overlap on (`panel.ts`),
 * with what each says and what may be done about it.
 *
 * Findings from EARLIER drafts are deliberately absent: `clusterFindings` filters on the
 * current version, which is what makes a rewrite clear a card with nothing written to the
 * finding behind it (0010). What answers them is the scene-scoped re-check, and its button is
 * the one `applyRewrite` hands back.
 */
function clustersOn(
  store: Store,
  library: LibraryPaths,
  artifact: Artifact,
  text: string,
  at: { anchored: Finding[]; blocking: Set<string>; llm: LLMReadiness },
): ClusterOnTheBench[] {
  const byId = new Map(at.anchored.map((finding) => [finding.id, finding]))

  return clusterFindings(store, artifact, text).map((cluster) => ({
    scene: cluster.scene,
    quote: cluster.quote,
    from: cluster.from,
    to: cluster.to,
    standing: cluster.standing,
    ...(cluster.worstSeverity && { worstSeverity: cluster.worstSeverity }),
    says: cluster.says.map((say): SayOnTheBench => {
      const finding = byId.get(say.findingId)
      const inherited = finding ? inheritedDismissal(at.anchored, finding) : null
      const blocks = at.blocking.has(say.findingId)
      return {
        findingId: say.findingId,
        checkKey: say.checkKey,
        tier: say.tier,
        severity: say.severity,
        confidence: say.confidence,
        concern: say.concern,
        quote: say.quote,
        status: say.status,
        facts: say.facts,
        // Severity and confidence beside each other and never folded (invariant 4): "how bad
        // if true" and "how sure it is true" are two questions, and one word cannot answer
        // both. The tier rides with them because `certain` means something different from a
        // model's certainty, and 4.2 says so.
        sentence:
          `${say.checkKey} · severity ${say.severity} · confidence ${say.confidence} · ` +
          `${say.tier === 'deterministic' ? 'deterministic, from the rows' : 'text, a reading'}`,
        blocking: blocks,
        blockingSentence: blocks
          ? 'Blocks the next stage until it is resolved, and never this gate (D12): approving ' +
            'over it at the gate is recorded as your override, putting it down with a note is ' +
            'your answer, and a rewrite that re-reads clean is the third way.'
          : null,
        dismissal:
          finding?.disposition === null || finding?.disposition === undefined
            ? null
            : { note: finding.disposition.note, at: finding.disposition.at },
        inherited:
          inherited === null
            ? null
            : {
                ...inherited,
                sentence:
                  `You put this exact concern down at v${inherited.version} — “${inherited.note}”. ` +
                  'This is a later firing of it, raised by a check re-reading rows nobody ' +
                  'touched. It is open, and it counts in the cried-wolf record below; what it ' +
                  'does not do is put the wall back up, because your ruling reaches it (E3-6).',
              },
        remediations: remediationsFor(store, library, say.findingId, at.llm),
      }
    }),
  }))
}

// ── The board's rows, and what would answer each ────────────────────────────────

/**
 * What would answer a row that is not a reading of this draft, in words. Null when the row
 * has already answered.
 *
 * Three verdicts and three different fixes, and the reason they are said rather than left to
 * the verdict word is `panel.ts`'s own argument one screen out: `unread`, `stale` and
 * `partial` all render as "not clean", and a bench that stopped there would leave Ryan to work
 * out which of three quite different things had happened and which of three quite different
 * buttons answers it.
 */
function fixFor(row: BoardRow): string | null {
  if (row.verdict === 'unread') {
    return row.tier === 'deterministic'
      ? 'Re-run the deterministic rules — they read the rows an extraction wrote and cost nothing.'
      : 'Convene the panel over this draft. It is a reading, so it costs a call per reviewer.'
  }
  if (row.verdict === 'stale') {
    // The version this row was computed FROM is on `row.what` already, put there by the one
    // module that knows it (`panel.ts`). Restating it here would be a second arithmetic that
    // can disagree with the first, which is the freshness pattern's own complaint.
    return (
      'The continuity board these rules read was built out of a draft the ' +
      `${SCRIPT_GATE_KIND} has moved past. Re-running them costs nothing and tells you what ` +
      'they still say about the board as it stands; reading the new draft into a fresh board ' +
      'is the reading that costs money, and it is the only thing that makes these rows green ' +
      'about the draft in front of you.'
    )
  }
  if (row.verdict === 'partial') {
    return (
      'This reviewer read only the scene that was rewritten (D14) and found nothing there. ' +
      'The rest of this draft it has not read — convene the panel to have it read the whole ' +
      'thing, which is a call.'
    )
  }
  if (row.verdict === 'gapped') {
    return (
      `${row.gaps} thing(s) it could not check at all: canon has not decided them, so no ` +
      'rewrite would answer one. Rule the proposal, or decide the fact at the canon bench.'
    )
  }
  return null
}

/**
 * What this reviewer was handed, and which of it any of its findings quoted.
 *
 * Read off `check_pass_fact` — the historical record of what was in front of the check when it
 * ran, which is not the same question as what canon says now (0012's `artifact_version`
 * argument, one level down). A row with no pass was handed nothing, and that is an absence
 * rather than a silence.
 */
function scopeOn(store: Store, row: BoardRow): ScopeOnTheBench[] {
  if (row.passId === null) return []
  const cited = new Set(
    findingsOfPass(store, row.passId).flatMap((finding) => finding.facts.map((fact) => fact.id)),
  )
  return scopeOfPass(store, row.passId).map((entry) => ({
    factId: entry.fact.id,
    statement: entry.fact.statement,
    via: entry.via,
    cited: cited.has(entry.fact.id),
  }))
}

/**
 * Everything a reviewer could not reach, off the passes standing at this version.
 *
 * Read from the passes rather than summed off the board, because a gap is a row with a
 * sentence on it and the board carries only the count — and "1 thing it could not check" with
 * no way to see WHICH thing is the archaeology this bench refuses.
 */
function gapsOn(store: Store, artifact: Artifact): GapOnTheBench[] {
  return checkPassesOf(store, artifact.id)
    .filter((pass) => pass.artifactVersion === artifact.version)
    .flatMap((pass) =>
      gapsOfPass(store, pass.id).map((gap) => ({
        checkKey: gap.checkKey,
        reason: gap.reason,
        detail: gap.detail,
      })),
    )
}

// ── Rows ────────────────────────────────────────────────────────────────────────

/** The newest run that opened a gate over this artifact — where the override door is. */
function gateRunOver(store: Store, artifact: Artifact | undefined): string | null {
  if (!artifact) return null
  return (
    store.get<{ run_id: string }>(
      'SELECT run_id FROM gate WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1',
      artifact.id,
    )?.run_id ?? null
  )
}

/** A board with nothing on it, for an episode with no artifact to have one about. */
const emptyBoard = (): VerdictBoard => ({
  artifactId: '',
  version: 0,
  rows: [],
  convened: 0,
  read: 0,
  standing: 0,
  gaps: 0,
  sentence: 'Nothing is convened, because there is nothing here to convene over.',
})

/**
 * The artifact, off the volume — the same read `operating.ts` does at a gate, and for the same
 * reason: the bench renders the script, not its path (D15), and the two ways there can be
 * nothing to render are different pieces of news.
 *
 * The path comes off the artifact ROW, never off a request.
 */
function readArtifact(library: LibraryPaths, artifact: Artifact): ArtifactUnderReview {
  const common = {
    id: artifact.id,
    kind: artifact.kind,
    slot: artifact.slot,
    version: artifact.version,
    filePath: artifact.filePath,
  }
  try {
    return {
      ...common,
      text: readFileSync(join(library.artifactDir, artifact.filePath!), 'utf8'),
      note: null,
    }
  } catch (error) {
    return {
      ...common,
      text: null,
      note:
        `${artifact.filePath} is recorded on the artifact but could not be read from ` +
        `${library.artifactDir} — ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
