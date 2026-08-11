import {
  clustersOn,
  CHECK_REFUSALS,
  type CheckRefusals,
  type SayOnTheBench,
} from './check-bench.ts'
import { destinationsOf, type Destination } from './cockpit.ts'
import type { Store } from './db/store.ts'
import { findArtifact } from './domain/artifact.ts'
import { findingsIn } from './domain/finding.ts'
import type { VerdictBoard } from './domain/panel.ts'
import { episodeInShow, episodeLabel, scenesOf } from './domain/spine.ts'
import type { Absence } from './episode-room.ts'
import {
  EVENT_KIND,
  latestSeq,
  PROSE_KIND,
  proseOfRun,
  transitionsOfRun,
  type EventKind,
} from './events.ts'
import { ago, count, liveOfRun, type FloorHeading } from './floor.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { gateOnThePage, type GateOnThePage, type Offer } from './operating.ts'
import { draftsUnderReview, type CorrectionRound } from './runner/correction-loop.ts'
import {
  findGate,
  gateStanding,
  NOTE_DEPTH,
  openGates,
  type GateRound,
  type GateStanding,
  type NoteDepth,
  type RulingVerdict,
} from './runner/gate.ts'
import { findRun, lockHolders } from './runner/run.ts'
import { stageCatalogue } from './runner/stages.ts'
import { sweepView, type SweepView } from './sweep.ts'

/**
 * **The gate room** (E5-3, #83; 5.3, D15, D21, 4.7; `mockups/gate-room.html`) — one decision,
 * the whole of what it is about, and the four verbs that end it.
 *
 * ## The artifact IS the page
 *
 * "Gates render their artifact — readable script, viewable image, playable take" (CLAUDE.md),
 * and 4.6's contract says everything pertinent, present, zero archaeology. A findings LIST
 * beside the draft is the failure mode both of those rule out: it makes Ryan hold a quoted
 * span in his head, scroll to find it, and hold the finding in his head on the way back. So
 * the artifact is folded — `fold.pieces` is the draft in document order with the quoted spans
 * marked and one card sitting at each anchor, composed out of `panel.ts`'s clusters and
 * `check-bench.ts`'s says (`clustersOn`, exported for this and copied nowhere).
 *
 * ## What it composes, and what it hands over whole
 *
 * Almost nothing here is new. The gate's four offers, its rounds, its artifact and its two
 * note refusals are `operating.ts`'s `gateOnThePage`. The verdict board and the drafts under
 * review are `correction-loop.ts`'s, off the same function the payload was composed with. The
 * riders are `sweep.ts`'s pass, whole, with its own five-part anatomy and its own three verbs.
 * The findings are the check bench's cards. The live region is the floor's `liveOfRun`.
 *
 * What this module adds is the four things a screen needs and none of them owns: **the fold**,
 * **the round history in words** (below), **the dock's headline**, and **the depth choices**
 * with what each one would do to THIS episode.
 *
 * ## The round history says stale in versions, not in a flag
 *
 * `gate_round` has no `stale` column and never will (0004). `gate.ts` computes "a later round
 * exists"; this composes what that MEANS, off the versions the two rounds presented — and the
 * two cases are different news:
 *
 *   * A later round presented a NEWER draft. Round 1 was ruled on v1 and the thing on the
 *     volume is v2; his verdict stands as history and is not about what is on screen.
 *   * A later round presented **the same version** — which is what a presenting gate does,
 *     because nothing behind it rewrites anything. Saying "stale" and stopping would hide the
 *     exact fact the fourth verb exists for, so the sentence says it out loud.
 *
 * ## What it does NOT do
 *
 * **It does not decide whether Ryan may rule.** Every offer on it comes off `gateOnThePage`,
 * where all four are enabled unless the round is already ruled — no findings check, no wall,
 * no lifecycle test (invariant 3, D12). The only refusal this room adds is the note a rejection
 * or a close needs, and that is applied by the SCREEN to a field this process has never seen,
 * in the API's own sentence (`runner/gate.ts`).
 *
 * **It rules no proposal and runs no check.** The riders' three verbs and the findings' three
 * remediations are routes that existed before this issue; this composes their offers and posts
 * nothing.
 */

// ── What the room is handed ─────────────────────────────────────────────────────

export interface GateRoomView {
  gateId: string
  runId: string
  /** Back to the floor, at the address the shell's own bar uses. */
  floorHref: string
  floorName: string
  /** "Grey Harbor · Season 1" — the breadcrumb's middle. */
  where: string
  episodeId: string
  /** "ep01". */
  episodeLabel: string
  episodeTitle: string
  /**
   * "ep01 “The Long Pier”" — the breadcrumb's link text, composed here rather than assembled
   * in the browser. The quotation marks around a title are copy, and nothing in `app/web/`
   * writes copy (E4-7, extended to the whole chrome by #80).
   */
  episodeCrumb: string
  episodeHref: string
  episodeRoom: string
  episodeRoomNotYet: string | null
  /** "ep01 “The Long Pier” — the ep01 script". */
  title: string
  /** "Round 2 · open" — the mockup's chip, and how long it has waited. */
  chip: string
  /** "script v2 under review · …" — what the round is over, in one line. */
  standing: string
  round: number
  isOpen: boolean

  /** The draft, in document order, with the findings folded in at their anchors. */
  fold: Fold
  /** One row per convened reviewer over the draft under review — `panel.ts`'s, whole. */
  board: VerdictBoard
  /** Every draft a check has read, walkable — the correction loop's history (4.4). */
  loop: TheLoop
  /** Every round of this gate, oldest first, kept exactly as it was ruled. */
  rounds: RoundAtTheGate[]
  /** What still rides this episode, whole (`sweep.ts`) — five parts, three verbs, one at a time. */
  sweep: SweepView
  dock: TheDock
  live: GateLive
  headings: GateHeadings
  /** The preconditions the finding boxes own, in the words the API refuses with. */
  refusals: CheckRefusals
  /** What the stream sends and where this read was taken from — the floor's protocol, reused. */
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

/** Every section's name and its plain-words explanation. `SectionHeader` refuses one without. */
export interface GateHeadings {
  artifact: FloorHeading
  board: FloorHeading
  loop: FloorHeading
  rounds: FloorHeading
  riders: FloorHeading
  live: FloorHeading
}

// ── The fold ────────────────────────────────────────────────────────────────────

export interface Fold {
  /** "Grey Harbor · ep01 “The Long Pier” · SCRIPT v1 · 6 scenes" — the mockup's doc header. */
  docHeader: string
  /** The draft in document order. Prose, marked spans, and a card at each anchor. */
  pieces: FoldPiece[]
  /** Why there is nothing to read, when there is nothing. Null when the draft is on screen. */
  note: string | null
  /** What the fold IS, so a reader knows the cards are in the text rather than beside it. */
  sentence: string
}

/**
 * One piece of the folded draft.
 *
 * A union rather than a flag for the reason every union in this app is one: three shapes with
 * three different fields, and a renderer that must handle all three or fail to compile. A
 * `span` and the `finding` after it are two pieces because the mark is IN the prose and the
 * card is under it — that is the mockup, and it is what "anchored" means on a page.
 */
export type FoldPiece =
  | { kind: 'prose'; text: string }
  | { kind: 'span'; text: string; cardId: string; blocking: boolean }
  | { kind: 'finding'; card: CardAtTheAnchor }

export interface CardAtTheAnchor {
  /** Stable across a re-read: the gate, and where in the draft it sits. */
  id: string
  /** "Scene 4 of the ep01 script · 2 reviewers on this span · 1 still standing". */
  where: string
  /** The span, quoted from the artifact. '' when the finding is about the whole thing (4.3). */
  quote: string
  /** As the episode numbers it. Null when the card is about the whole artifact. */
  scene: number | null
  standing: number
  /** D12's wall is standing on one of these says. Marked, never a veto over this gate. */
  blocking: boolean
  /** Every reviewer's say, severity and confidence apart, with 4.3's three remediations. */
  says: SayAtTheGate[]
}

/**
 * One reviewer's say, plus the one thing this surface adds to it: **the label on the fold that
 * opens its remediations.**
 *
 * 4.3's three buttons are two textareas, an input and four offers, and this is the one screen
 * that puts a card INSIDE the document it is about. Rendered open, a single card is taller than
 * the box the script is in — booting it is what showed that: one finding, and the draft it is a
 * finding about was off the bottom of its own panel. So the card carries its say and the say
 * carries a fold, which is the pattern the writer's desk already uses in the episode room:
 * reading is free, so it is a disclosure and never a fetch, and it opens IN PLACE.
 *
 * The label is composed here rather than in the browser for the reason every label is
 * (E4-7, #80), and it names the check so the fold says what is behind it before it is opened.
 */
export type SayAtTheGate = SayOnTheBench & {
  /** "What you may do about the world-rules finding — rewrite the span, propose the change…" */
  open: string
}

// ── The loop's drafts ───────────────────────────────────────────────────────────

export interface TheLoop {
  /** Why this gate is open, in the words the floor shows while it waits. */
  sentence: string
  drafts: DraftInTheLoop[]
  /** What an artifact no check has read says instead. Null once one has. */
  none: Absence | null
  converged: boolean
  clean: boolean
  /** The deterministic findings standing on the draft under review — what an override is OF. */
  blocking: { findingId: string; sentence: string }[]
}

export interface DraftInTheLoop {
  round: number
  artifactVersion: number
  /** "v1 · 6 checks read it · nothing standing · as it was first written". */
  sentence: string
  /** The draft under review right now. */
  current: boolean
}

// ── The round history ───────────────────────────────────────────────────────────

export interface RoundAtTheGate {
  round: number
  artifactVersion: number
  /** "Round 1 · script v1". */
  name: string
  /**
   * "stale — from before your last rejection", with what that means in versions. Null on the
   * newest round. **Computed on every read**, off the rounds themselves (0004).
   */
  staleTag: string | null
  /** "open, waiting on you" / "rejected · 2 notes" / "put down · 1 note". */
  standing: string
  /** The ruling, or null while the round is open. */
  ruling: RulingAtTheGate | null
  openedAt: string
}

export interface RulingAtTheGate {
  verdict: string
  /** What the verb DID, in a sentence — never the bare schema word on its own. */
  sentence: string
  comment: string | null
  notes: NoteAtTheGate[]
  ruledAt: string
}

export interface NoteAtTheGate {
  note: string
  /** Where he sent it, in words — "unrouted, which lands on this draft (the legal default)". */
  routing: string
}

// ── The dock ────────────────────────────────────────────────────────────────────

export interface TheDock {
  /** "Your ruling closes round 2. 1 deterministic finding stands — it blocks the next stage…" */
  headline: string
  approve: Offer
  override: Offer
  reject: Offer
  /** The fourth verb (E5-3): the run ends, the note stands, the episode is free. */
  close: Offer
  /** Every depth a note may pick, and what each would do on THIS episode. */
  depths: DepthChoice[]
  /** The composer's heading for each verb that takes notes — "…where does the work land?" */
  rejectComposer: string
  closeComposer: string
  rejectNeedsNote: string
  closeNeedsNote: string
  /** What Esc does. The composer expands in place, so leaving it files nothing. */
  escape: string
}

/**
 * One routing depth, with what it would do here.
 *
 * **Never disabled, and that is a ruling rather than an omission** (`domain/routing.ts`): a
 * depth naming a kind this episode has not written resolves to no address and is recorded as a
 * note with no address, because nothing may block a ruling. So a depth that reaches nothing
 * says so in its own sentence, before the click, and stays pressable.
 */
export interface DepthChoice {
  /** '' is unrouted — the legal default (D21). */
  depth: NoteDepth | ''
  /** "this draft", "the outline", "a scene of it". */
  label: string
  /** What it does, and where it lands on this episode today. Never blank. */
  because: string
  /** True when the depth needs Ryan to say WHICH one — a scene, a shot, a take. */
  needsTarget: boolean
}

// ── The live region ─────────────────────────────────────────────────────────────

/**
 * What the run behind this gate is saying, and — when it is parked on Ryan, which is the
 * ordinary case here — the box saying that, at the same height. **Idle is a state, not an
 * absence** (E5-0): a region that appeared when the run resumed would move the dock by
 * existing, and the dock is the thing his hand is on.
 */
export interface GateLive {
  runId: string
  heading: string
  latest: string | null
  stream: string[]
  seq: number
  entries: { seq: number; sentence: string }[]
  idle: boolean
}

// ── The index ───────────────────────────────────────────────────────────────────

export interface GateIndexView {
  heading: FloorHeading
  gates: GateOnTheIndex[]
  /** What a library with nothing waiting says instead of an empty list. Null while one waits. */
  empty: Absence | null
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

export interface GateOnTheIndex {
  gateId: string
  /** "ep01 “The Long Pier” — the ep01 script, round 2 · opened 38 minutes ago". */
  sentence: string
  href: string
  /** Go and rule. Going there spends nothing; what a verdict buys is stated at the gate. */
  open: Offer
}

// ── The room ────────────────────────────────────────────────────────────────────

export function gateRoomView(
  store: Store,
  library: LibraryPaths,
  gateId: string,
  llm: LLMReadiness,
  now: Date = new Date(),
): GateRoomView | undefined {
  // Taken FIRST, before a row below is read: it is the position a browser opens the live
  // stream at, so anything landing while this view is composed is replayed rather than lost.
  const since = latestSeq(store)

  const gate = findGate(store, gateId)
  if (!gate) return undefined
  const standing = gateStanding(store, gateId)
  const rendered = gateOnThePage(store, library, gateId, stageCatalogue(library))
  const where = episodeInShow(store, gate.episodeId)
  const sweep = sweepView(store, gate.episodeId)
  if (!standing || !rendered || !where || !sweep) return undefined

  const rooms = destinationsOf()
  const label = episodeLabel(where.episode.number)
  const artifact = findArtifact(store, gate.artifactId)
  const under = artifact ? draftsUnderReview(store, artifact.id) : undefined
  const run = findRun(store, gate.runId)
  const episodeRoom = roomFor(rooms, 'episode-room')

  return {
    gateId,
    runId: gate.runId,
    floorHref: roomFor(rooms, 'floor').path,
    floorName: roomFor(rooms, 'floor').name,
    where: `${where.show.title} · Season ${where.season.number}`,
    episodeId: gate.episodeId,
    episodeLabel: label,
    episodeTitle: where.episode.title,
    episodeCrumb: `${label} “${where.episode.title}”`,
    episodeHref: `${episodeRoom.path}/${gate.episodeId}`,
    episodeRoom: episodeRoom.name,
    episodeRoomNotYet: episodeRoom.notYetBecause,
    title: `${label} “${where.episode.title}” — ${rendered.subject}`,
    chip: standing.isOpen
      ? `Round ${standing.round} · open ${ago(openedAt(standing), now)}`
      : `Round ${standing.round} · ruled ${ago(standing.ruling!.ruledAt, now)}`,
    standing: standingSentence(rendered, standing, label),
    round: standing.round,
    isOpen: standing.isOpen,

    fold: fold(store, library, llm, rendered, label),
    board: under?.board ?? emptyBoard(gate.artifactId),
    loop: theLoop(under, rendered, label),
    rounds: roundsAtTheGate(standing.rounds, rendered),
    sweep,
    dock: theDock(store, rendered, under, label, where.episode.id),
    live: gateLive(store, gate.runId, run?.status ?? 'done'),
    headings: headingsFor(rendered, under?.board ?? emptyBoard(gate.artifactId), label),
    refusals: CHECK_REFUSALS,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since },
  }
}

/**
 * The six section headings, two of them composed rather than declared (#99).
 *
 * Ryan's third and fourth examples on that issue are both here, and both are about the same
 * failure: **this page knows exactly what it is rendering and used to gesture at it anyway.**
 * The draft's heading said "what you are ruling on" while the payload was holding the
 * artifact's kind, slot and version. The board's heading said "one row per reviewer" while
 * the rows were holding what each reviewer IS. So the two that can spend what the page knows
 * are functions of it now, and the four that genuinely describe a section are constants.
 *
 * The board's three groups come off the rows themselves: a `deterministic` row is a rule that
 * code runs for nothing, and a text row was handed facts (`scope`) if it is a canon check and
 * none at all if it is a craft reviewer (D13). Nothing is counted here that the board does
 * not already say.
 */
function headingsFor(
  rendered: GateOnThePage,
  board: VerdictBoard,
  label: string,
): GateHeadings {
  const artifact = rendered.artifact
  const kind = `${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`

  return {
    artifact: {
      name: 'The draft',
      explains:
        `The ${label} ${kind}, version ${artifact.version}, shown in full. Findings appear ` +
        'beside the lines they refer to.',
    },
    board: { name: 'Verdict board', explains: boardSentence(board) },
    loop: {
      name: 'The drafts under this',
      explains:
        'Every version a check has read, in order, with what the model said it changed. The ' +
        'model and the checks went round this many times before the gate opened.',
    },
    rounds: {
      name: 'Round history',
      explains:
        'Every time this gate has come to you, kept exactly as you ruled it. A round you ' +
        'have ruled never changes; rejecting opens the next one under it.',
    },
    riders: {
      name: 'Riding this episode',
      explains:
        'What the writing claimed about canon and you have not ruled on yet. You rule on ' +
        'them one at a time, and ruling on this draft rules on none of them.',
    },
    live: {
      name: 'The run behind this gate',
      explains:
        'What the run was doing when it stopped to ask you, and what it does the moment you ' +
        'rule. Nothing here moves until you press something.',
    },
  }
}

/**
 * The verdict board's own heading, in Ryan's words on #99: who read the draft, what each of
 * them cost, and that not one of them decides anything.
 *
 * The counts are the rows'. A board nobody has read yet says so instead of counting to zero
 * three times, which is the same honesty the rows themselves keep (invariant 4).
 */
export function boardSentence(board: VerdictBoard): string {
  const text = board.rows.filter((row) => row.tier !== 'deterministic')
  const canon = text.filter((row) => row.scope > 0).length
  const craft = text.length - canon
  const rules = board.rows.length - text.length

  if (board.rows.length === 0) {
    return 'No check has read this draft, so there is no row here yet. Nothing a check says decides anything; deciding is yours, below.'
  }

  const paid = [
    canon === 0 ? '' : `${count(canon, 'canon check')}`,
    craft === 0 ? '' : `${count(craft, 'craft check')}`,
  ].filter(Boolean)

  const who =
    paid.length === 0
      ? `${count(rules, 'deterministic rule')}, which cost nothing to run`
      : `${paid.join(' and ')}, each one model call` +
        (rules === 0 ? '' : `, plus ${count(rules, 'deterministic rule')} that cost nothing`)

  return `One row per check that read this draft — ${who}. None of them decides anything; deciding is yours, below.`
}

/** When the round under review opened — what the chip counts from. */
function openedAt(standing: GateStanding): string {
  return standing.rounds.at(-1)?.openedAt ?? standing.gate.openedAt
}

/** "script v1 under review · nothing behind this gate rewrites it". */
function standingSentence(
  rendered: GateOnThePage,
  standing: GateStanding,
  label: string,
): string {
  const artifact = rendered.artifact
  const draft = `${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''} v${artifact.version}`
  if (!standing.isOpen) {
    return (
      `${draft} · this round is ruled, and it is kept as the record of what you decided. ` +
      'A later opinion is a later round.'
    )
  }
  const rewritten = standing.rounds.length > 1 && rounded(standing.rounds)
  return (
    `${draft} under review · ` +
    (standing.round === 1
      ? `the first time ${label} has put this in front of you`
      : rewritten
        ? 'rewritten since your last ruling, and the round history below keeps the one before it'
        : 'the same draft as the round before it — nothing behind this gate rewrites anything, ' +
          'which is what putting it down is for')
  )
}

/** Did the newest round present a newer draft than the one before it? */
function rounded(rounds: readonly GateRound[]): boolean {
  const [previous, newest] = [rounds.at(-2), rounds.at(-1)]
  return previous !== undefined && newest !== undefined && newest.artifactVersion > previous.artifactVersion
}

// ── The fold ────────────────────────────────────────────────────────────────────

/**
 * The draft, in document order, with the cards where their spans are.
 *
 * The clusters are `check-bench.ts`'s — one composer, and this is its second reader — and the
 * ONLY arithmetic here is slicing the text between them. A card whose cluster has no span
 * (`from === to`) is a point insertion at its scene's start: a finding about a whole scene has
 * nothing to mark, and giving it the scene's whole span would swallow every other card in it
 * (`panel.ts` argues this where the clusters are built).
 */
function fold(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  rendered: GateOnThePage,
  label: string,
): Fold {
  const artifact = findArtifact(store, rendered.artifact.id)
  const text = rendered.artifact.text
  const scenes = artifact ? scenesOf(store, artifact.episodeId).length : 0
  const docHeader =
    `${label} ${rendered.artifact.kind}${rendered.artifact.slot ? ` ${rendered.artifact.slot}` : ''} ` +
    `v${rendered.artifact.version}` +
    (scenes === 0 ? '' : ` · ${count(scenes, 'scene')}`)

  if (artifact === undefined || text === null) {
    return {
      docHeader,
      pieces: [],
      note: rendered.artifact.note,
      sentence:
        'This gate renders the draft itself rather than a filename, and there is nothing on ' +
        'the volume to render. The line above says which of the two reasons that is.',
    }
  }

  const blocking = new Set(
    (draftsUnderReview(store, artifact.id).blocking ?? []).map((one) => one.findingId),
  )
  const clusters = clustersOn(store, library, artifact, text, {
    anchored: findingsIn(store, artifact.id),
    blocking,
    llm,
  })
    .map((cluster, index) => ({ cluster, index }))
    // Document order, and a point insertion before the span that starts where it does — the
    // scene's own finding is about everything after it, so it reads first.
    .sort((a, b) => a.cluster.from - b.cluster.from || a.cluster.to - b.cluster.to)

  const pieces: FoldPiece[] = []
  let at = 0
  for (const { cluster, index } of clusters) {
    const id = `${rendered.id}-card-${index}`
    const from = Math.max(at, Math.min(cluster.from, text.length))
    const to = Math.max(from, Math.min(cluster.to, text.length))
    const blocks = cluster.says.some((say) => say.blocking)

    if (from > at) pieces.push({ kind: 'prose', text: text.slice(at, from) })
    if (to > from) {
      pieces.push({ kind: 'span', text: text.slice(from, to), cardId: id, blocking: blocks })
    }
    at = Math.max(at, to)
    pieces.push({
      kind: 'finding',
      card: {
        id,
        where: whereItLands(cluster.scene, cluster.says.length, cluster.standing, label, rendered),
        quote: cluster.quote,
        scene: cluster.scene,
        standing: cluster.standing,
        blocking: blocks,
        says: cluster.says.map((say): SayAtTheGate => ({
          ...say,
          open:
            `What you may do about the ${say.checkKey} finding: rewrite the span, propose the ` +
            'canon change, or dismiss it with a note. None of those three is a ruling on it.',
        })),
      },
    })
  }
  if (at < text.length) pieces.push({ kind: 'prose', text: text.slice(at) })

  const cards = pieces.filter((piece) => piece.kind === 'finding').length
  return {
    docHeader,
    pieces,
    note: null,
    sentence:
      cards === 0
        ? `Nothing is anchored in this draft, so it is here whole. A draft no check raised ` +
          'anything against is not the same as a draft nothing read; the board above says which.'
        : `${count(cards, 'card')}, each one beside the lines it refers to. The cards are in ` +
          'the text rather than in a list beside it, so you never have to go and find a ' +
          'quoted span.',
  }
}

/** "Scene 4 of the ep01 script · 2 reviewers on this span · 1 still standing". */
function whereItLands(
  scene: number | null,
  says: number,
  standing: number,
  label: string,
  rendered: GateOnThePage,
): string {
  const what = `${count(says, 'reviewer')} on ${scene === null ? 'it' : 'this span'}`
  const kept = `${standing} still standing`
  return scene === null
    ? `The whole ${label} ${rendered.artifact.kind} · ${what} · ${kept}`
    : `Scene ${scene} of the ${label} ${rendered.artifact.kind} · ${what} · ${kept}`
}

// ── The loop ────────────────────────────────────────────────────────────────────

function theLoop(
  under: ReturnType<typeof draftsUnderReview> | undefined,
  rendered: GateOnThePage,
  label: string,
): TheLoop {
  const rounds = under?.rounds ?? []
  const payload = rendered.rounds.at(-1)?.payload as { sentence?: string } | undefined
  return {
    // The gate's own payload sentence, which is why THIS gate opened — quoted, never re-worded
    // (`correction-loop.ts` and `present-step.ts` each compose their own, and only the sentence
    // differs between the two doors).
    sentence:
      typeof payload?.sentence === 'string'
        ? payload.sentence
        : `Waiting on your ruling over the ${label} ${rendered.artifact.kind}.`,
    drafts: rounds.map((round): DraftInTheLoop => ({
      round: round.round,
      artifactVersion: round.artifactVersion,
      sentence: draftSentence(round),
      current: round.artifactVersion === rendered.artifact.version,
    })),
    none:
      rounds.length > 0
        ? null
        : {
            lead: `No check has read the ${label} ${rendered.artifact.kind}.`,
            sentence:
              'A round here is a version some check answered about, and there are none. That ' +
              'is not a clean reading: nothing read it. The board above says which checks were ' +
              'called and what each of them did.',
          },
    converged: under?.converged ?? false,
    clean: under?.clean ?? false,
    blocking: (under?.blocking ?? []).map((one) => ({
      findingId: one.findingId,
      sentence:
        `${one.checkKey}${one.scene === null ? '' : ` · scene ${one.scene}`} — ${one.concern}`,
    })),
  }
}

/** "v2 · 6 checks read it · 1 finding standing · rewritten against your notes". */
function draftSentence(round: CorrectionRound): string {
  return [
    `v${round.artifactVersion}`,
    `${count(round.checks, 'check')} read it`,
    round.findings.length === 0
      ? 'nothing standing'
      : `${count(round.findings.length, 'finding')} standing`,
    round.gaps.length === 0 ? '' : `${count(round.gaps.length, 'thing')} they could not read`,
    round.summary === '' ? '' : round.summary,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

// ── The rounds ──────────────────────────────────────────────────────────────────

/**
 * Every round, kept exactly as it was ruled, with what "stale" MEANS said in versions.
 *
 * `GateRound.stale` is "a later round exists" and is computed off the row set (0004, `gate.ts`).
 * What is composed here is the sentence, and it takes two forms because the two cases are two
 * pieces of news — see the module header.
 */
function roundsAtTheGate(rounds: readonly GateRound[], rendered: GateOnThePage): RoundAtTheGate[] {
  const kind = rendered.artifact.kind
  return rounds.map((round, index): RoundAtTheGate => {
    const next = rounds[index + 1]
    return {
      round: round.round,
      artifactVersion: round.artifactVersion,
      name: `Round ${round.round} · ${kind} v${round.artifactVersion}`,
      staleTag:
        !round.stale || next === undefined
          ? null
          : next.artifactVersion > round.artifactVersion
            ? `stale — from before your last rejection: you ruled on ${kind} v${round.artifactVersion}, ` +
              `and round ${next.round} presented v${next.artifactVersion}`
            : `from before your last rejection — and round ${next.round} presented the SAME ` +
              `${kind} v${round.artifactVersion}, because nothing behind this gate rewrites it`,
      standing: standingOfRound(round, kind),
      ruling:
        round.ruling === undefined
          ? null
          : {
              verdict: round.ruling.verdict,
              sentence: VERDICT_SENTENCE[round.ruling.verdict],
              comment: round.ruling.comment,
              notes: round.ruling.notes.map((note) => ({
                note: note.note,
                routing: routingOf(note.depth, note.target, note.targetVersion),
              })),
              ruledAt: round.ruling.ruledAt,
            },
      openedAt: round.openedAt,
    }
  })
}

/**
 * What each verb DID, in a sentence — never the bare ledger word on its own.
 *
 * A record keyed by the verdict rather than a chain, so 0015's fourth (and any fifth) is a
 * type error here rather than a round that renders as an empty string.
 */
const VERDICT_SENTENCE: Record<RulingVerdict, string> = {
  approve: 'approved — the step carried the run on',
  override:
    'approved over the findings, and the override is on the record for good. The next stage ' +
    'stopped being refused on what you ruled over.',
  reject: 'rejected with notes — the step reopened as the next round',
  close:
    'closed with a note. The run ended, nothing was rewritten, and your note stands against ' +
    'the draft until something answers it.',
}

function standingOfRound(round: GateRound, kind: string): string {
  if (round.ruling === undefined) return 'open, waiting on you'
  const notes = round.ruling.notes.length
  return notes === 0
    ? `${round.ruling.verdict} · ${kind} v${round.artifactVersion}`
    : `${round.ruling.verdict} · ${count(notes, 'note')} on ${kind} v${round.artifactVersion}`
}

/**
 * Where a note was sent, in words. An id on a screen is the archaeology 4.6 forbids.
 *
 * It branches on the DEPTH rather than on whether a target happens to be filled in, which is
 * the difference between `scene` and `shot`: both carry a target Ryan typed, and only one of
 * them names a part of the thing under review. Reading "a target was set, so it is part of
 * this draft" told him a shot note had landed on the script (`domain/routing.ts` resolves
 * neither, but they are not the same nothing).
 *
 * A record keyed by the depth, so the closed set of 4.7 and D21 has one arm apiece and a
 * seventh depth is a type error here rather than a note that renders as an empty sentence.
 */
function routingOf(
  depth: NoteDepth | null,
  target: string | null,
  targetVersion: number | null,
): string {
  if (depth === null) return 'unrouted, so it lands on this draft — that is the default'
  // It named another written artifact, and the version it stood at is what "answered" is
  // computed against — the only thing 0014 put on the row, said in words.
  if (targetVersion !== null) {
    return (
      `routed at ${depth} depth — it landed when that artifact stood at v${targetVersion}, ` +
      'and a newer version is the only thing that answers it'
    )
  }
  const named = target === null ? '' : `, at “${target}”`
  const SAID: Record<NoteDepth, string> = {
    artifact: 'the draft in front of you, named rather than left to the default',
    scene: 'a part of this draft, so it stays on this draft',
    outline: 'the outline, which this episode has not written yet, so it reached nothing',
    premise: 'the premise, which this episode has not written yet, so it reached nothing',
    shot: 'a shot, which E6 builds, so it reaches nothing on this episode yet',
    take: 'a take, which E6 builds, so it reaches nothing on this episode yet',
  }
  const reaches = depth === 'artifact' || depth === 'scene'
  return (
    `routed at ${depth} depth${named} — ${SAID[depth]}` +
    (reaches ? '' : '. It was recorded rather than refused, because nothing may block a ruling')
  )
}

// ── The dock ────────────────────────────────────────────────────────────────────

function theDock(
  store: Store,
  rendered: GateOnThePage,
  under: ReturnType<typeof draftsUnderReview> | undefined,
  label: string,
  episodeId: string,
): TheDock {
  const blocking = under?.blocking.length ?? 0
  const standing = (under?.rounds.at(-1)?.findings.length ?? 0)
  const riders = sweepView(store, episodeId)?.riders.length ?? 0

  return {
    headline: rendered.isOpen
      ? `Your ruling closes round ${rendered.round}. ` +
        [
          blocking === 0
            ? 'nothing deterministic stands on it'
            : `${count(blocking, 'deterministic finding')}, which ${
                blocking === 1 ? 'refuses' : 'refuse'
              } the next stage and never this gate`,
          `${count(standing, 'argued note')} on the draft`,
          riders === 0
            ? 'nothing rides this episode'
            : `${count(riders, 'proposal')} awaiting a ruling of ${riders === 1 ? 'its' : 'their'} own`,
        ].join(' · ') + '.'
      : `Round ${rendered.round} is ruled, and it is kept as the record of what you decided. ` +
        'This round is closed; to change your mind, open a new one.',
    approve: rendered.approve,
    override: rendered.override,
    reject: rendered.reject,
    close: rendered.close,
    depths: depthChoices(label, rendered.artifact.kind),
    rejectComposer: `Reject ${rendered.subject} — where does the work go back to?`,
    closeComposer: `Close ${rendered.subject} — say why. Later writing runs read your note back.`,
    rejectNeedsNote: rendered.rejectNeedsNote,
    closeNeedsNote: rendered.closeNeedsNote,
    escape:
      'Esc closes this and files nothing. What you have typed stays until you leave the page. ' +
      'A ruling lands when you press the button, and never before.',
  }
}

/**
 * The depths, each with what it would do — the closed set of 4.7 and D21, plus the unrouted
 * default that is not one of them.
 *
 * `shot` and `take` are on the list and say what they are. Leaving them off would be a screen
 * deciding which of Ryan's ruled depths he may use; saying "E6's, and it reaches nothing yet"
 * is the honest version, and `domain/routing.ts` records a route that lands nowhere rather
 * than refusing it for exactly this reason.
 */
function depthChoices(label: string, kind: string): DepthChoice[] {
  const said: Record<NoteDepth, { label: string; because: string; needsTarget: boolean }> = {
    artifact: {
      label: 'this draft',
      because:
        `The ${label} ${kind} in front of you. A writing gate writes it again against your ` +
        'note. A presenting gate has no writer behind it, so close that one instead.',
      needsTarget: false,
    },
    scene: {
      label: 'a scene of it',
      because:
        'One named part of this draft. The note stays on this artifact and travels with the ' +
        'scene you name.',
      needsTarget: true,
    },
    outline: {
      label: 'the outline',
      because:
        `Sends the work back to the ${label} outline. Nothing regenerates on its own: the ` +
        'outline stage becomes startable again with your note quoted on its button, and you ' +
        'click it or you do not.',
      needsTarget: false,
    },
    premise: {
      label: 'the premise',
      because:
        `Sends the work back to the ${label} premise-brief the same way. The stage that ` +
        'writes it reopens with your note on it, and nothing runs until you ask.',
      needsTarget: false,
    },
    shot: {
      label: 'a shot',
      because:
        'E6 builds shots. Nothing in this build produces one, so your note is recorded with ' +
        'no address rather than refused: a route that lands nowhere is still a verdict.',
      needsTarget: true,
    },
    take: {
      label: 'a take',
      because:
        'E6 builds takes, the same as shots. Your note is recorded, addressed to nothing, and ' +
        'waiting for the epic that produces one.',
      needsTarget: true,
    },
  }

  return [
    {
      depth: '',
      label: 'unrouted',
      because:
        'The default. Your note lands on the draft in front of you, exactly as a note routed ' +
        'at “this draft” depth does, and it says nothing about where the work goes back to.',
      needsTarget: false,
    },
    ...NOTE_DEPTH.map((depth): DepthChoice => ({ depth, ...said[depth] })),
  ]
}

// ── The live region ─────────────────────────────────────────────────────────────

function gateLive(store: Store, runId: string, status: string): GateLive {
  const run = findRun(store, runId)
  const entries = transitionsOfRun(store, runId).map((event) => ({
    seq: event.seq,
    sentence: event.summary ?? event.kind,
  }))

  if (run && run.status === 'running') {
    const live = liveOfRun(store, lockHolders(store), run)
    return { ...live, entries, idle: false }
  }

  // **The last thing the step said before it stopped**, not a sentence composed here. On the
  // ordinary path that is the presentation itself — "Presenting the ep01 script v1 for your
  // ruling — round 1. …" — which is exactly the news, said by the step that decided it. An
  // invented "parked on you" line would be this module answering a question the log already
  // answers, and answering it less precisely. The heading says the run is not talking.
  const prose = proseOfRun(store, runId)
  return {
    runId,
    heading: `${run?.stage ?? 'the run'} — ${IDLE[status] ?? 'finished'}`,
    latest: prose.latest,
    stream: prose.stream,
    seq: prose.seq,
    entries,
    idle: true,
  }
}

const IDLE: Record<string, string> = {
  queued: 'queued, and it starts when this episode is free',
  running: 'running',
  paused: 'stopped here to ask you',
  done: 'finished',
  failed: 'failed',
}

/** A board over an artifact that is not there — the shape, honestly empty. */
const emptyBoard = (artifactId: string): VerdictBoard => ({
  artifactId,
  version: 0,
  rows: [],
  convened: 0,
  read: 0,
  standing: 0,
  gaps: 0,
  sentence:
    'No check has been called over this, because there is nothing on the volume for one to ' +
    'read. That is an absence, not a clean reading.',
})

// ── The index ───────────────────────────────────────────────────────────────────

/**
 * **Every gate waiting on Ryan, oldest first, each a sentence that links.**
 *
 * Deliberately thin. The floor already triages the day and this is not a second floor: it is
 * the answer to "I typed /gate, what is open" — one line apiece, at the address that rules it.
 * `openGates` is the same read the floor's needs-you list is built from, so the two can never
 * disagree about what is waiting.
 */
export function gateIndexView(
  store: Store,
  library: LibraryPaths,
  now: Date = new Date(),
): GateIndexView {
  const since = latestSeq(store)
  const room = roomFor(destinationsOf(), 'gate-room')
  const open = openGates(store)

  return {
    heading: {
      name: 'Open gates',
      explains:
        'Every draft waiting on your ruling right now, oldest first. You rule on one at a ' +
        'time, and opening one spends nothing.',
    },
    gates: open.map((gate): GateOnTheIndex => {
      const label = episodeLabel(gate.episodeNumber)
      const standing = findingsIn(store, gate.gate.artifactId).filter(
        (finding) => finding.status === 'open',
      ).length
      return {
        gateId: gate.gate.id,
        sentence:
          `${label} — ${gate.subject}, round ${gate.round} · opened ${ago(gate.since, now)} · ` +
          `${count(standing, 'finding')} standing on it`,
        href: `${room.path}/${gate.gate.id}`,
        open: {
          sentence: `Rule on ${gate.subject} — round ${gate.round}, at its gate`,
          // Going there spends nothing. What a VERDICT buys is stated at the gate, on the
          // button that spends it — pricing a decision he has not made would be a guess.
          cost: `${count(standing, 'finding')} · no model call · $0.00 to open it`,
          enabled: true,
          blockedBecause: null,
        },
      }
    }),
    empty:
      open.length > 0
        ? null
        : {
            lead: 'Nothing is waiting on your ruling.',
            sentence:
              'A gate opens when a stage puts a draft in front of you. Every gate that has ' +
              'ever opened is still readable from its episode’s room, because a ruled gate ' +
              'is the record of a decision and it is kept for good.',
          },
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since },
  }
}

/** The room by id, off the same list the shell draws its bar from (`cockpit.ts`). */
function roomFor(rooms: readonly Destination[], id: string): Destination {
  return rooms.find((room) => room.id === id)!
}
