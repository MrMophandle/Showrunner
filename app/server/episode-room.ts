import { checkBenchView, type CheckBenchView, type SayOnTheBench } from './check-bench.ts'
import { destinationsOf, type Destination } from './cockpit.ts'
import {
  costOfEpisode,
  costsOfEpisode,
  money,
  spentSentence,
  type CostEntry,
  type CostTotals,
} from './cost.ts'
import type { Store } from './db/store.ts'
import { arcsOf, type Arc } from './domain/arc.ts'
import { findEntityById } from './domain/canon.ts'
import { artifactFreshness, revisionsOf, type ArtifactFreshness } from './domain/artifact.ts'
import { boardOf, type Board, type BoardScene } from './domain/board.ts'
import type { BoardVerdict } from './domain/panel.ts'
import { episodeInShow, episodeLabel, type EpisodeLifecycle } from './domain/spine.ts'
import {
  EDIT_REFUSALS,
  scenesToEdit,
  staleSentence,
  type EditRefusals,
  type SceneToEdit,
} from './edit.ts'
import {
  EVENT_KIND,
  latestSeq,
  PROSE_KIND,
  proseOfRun,
  transitionsOfRun,
  type EventKind,
} from './events.ts'
import {
  count,
  lifecycleStops,
  liveOfRun,
  queuedSentence,
  type FloorHeading,
  type FloorStop,
} from './floor.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { stageOffer, type Offer } from './operating.ts'
import { lockHolders, runsOfEpisode, type Run } from './runner/run.ts'
import { stageCatalogue } from './runner/stages.ts'
import type { StageWork } from './runner/step.ts'
import { sweepView, type SweepView } from './sweep.ts'
import type { GateInTheRoom, WritingRoomView } from './writing-room.ts'
import { writingRoomView } from './writing-room.ts'

/**
 * **The episode room** (E5-2, #82; 5.2, D14; `mockups/episode-room.html`) — one episode,
 * everything about it, nothing about any other.
 *
 * ## It composes three reads and derives nothing they already say
 *
 * The room's whole content already comes down three wires that landed in earlier epics:
 *
 *   * **`writing-room.ts`** (E4-7) — the writing line's three buttons with their declared
 *     costs, the writer's desk behind each, every gate with its rounds and its clustered
 *     findings, the two doors on every written artifact, the arc pin, D12's wall.
 *   * **`check-bench.ts`** (E3-7) — the verdict board with each row's own sentence and what
 *     would answer it, the gaps, the clusters with 4.3's three remediations and the
 *     dismissal behind every say, the scenes still owed a re-check, D11's cried-wolf record.
 *   * **`sweep.ts`** (E4-6) — the riders this episode still owes canon, each with its blast
 *     radius computed at read time and its own three verbs.
 *
 * All three are handed over WHOLE below (`writing`, `checks`, `sweep`). What this module adds
 * is the stitching a screen needs and none of them owns: the scene grid as the board's own
 * rows, the artifacts panel over every artifact rather than the three written ones, the stage
 * rail as one ordered list of offers, the itemised ledger, the arc chains, and the addresses
 * of the rooms this one links to. **Every sentence it composes cites the record it came out
 * of**, and where a sentence already exists somewhere it is quoted rather than re-worded —
 * `panel.ts` says what a verdict means, `stage-wall.ts` says what the wall refuses,
 * `floor.ts` says what a run is holding and what is queued behind it, and this file says
 * none of those things twice.
 *
 * ## Board-first, and the grid recomputes nothing
 *
 * The mockup's face is the scene grid, and the grid IS the continuity board (3.2b): one row
 * per scene, the location, who is present, what is between them and the void, where the ship
 * is, and the clock. Every cell is a `board_scene` / `board_presence` row read back through
 * `boardOf` — this module runs no rule, compares no clock, and decides nothing about whether
 * a scene is legal. **The deterministic verdicts where a rule meets a scene are the check
 * bench's own says**, filtered to the deterministic tier and grouped by the scene they are
 * anchored in; the grid's health is `panel.ts`'s verdict on each board row, in the words
 * `panel.ts` and `check-bench.ts` already wrote (`what`, and `fix` for the ones that are not
 * an answer yet). If anything below ever starts deciding what a row means, delete it and read
 * `domain/board-rules.ts`.
 *
 * An episode with no board renders the honest not-yet state and the priced button that builds
 * one — `continuity-board`'s own offer, through the same `stageOffer` every other button uses.
 *
 * ## What it deliberately does NOT do
 *
 * **It does not rule at a gate.** A gate is ruled in the gate room (#83), and every gate here
 * is a LINK there carrying that room's own honesty about itself — one decision, one room,
 * which is E5-1's precedent and the reason the floor's cards link rather than act.
 *
 * **It does not decide what needs Ryan.** That is the floor's read and its qualifying rule
 * (`floor.ts`); this room is where an episode is worked on, not where the day is triaged.
 *
 * **It does not claim a waypoint has landed.** The chain below draws the pin and the
 * waypoints in order. Which of them a ratified landing fact has actually reached is the arc
 * page's read (#85, D24), and a chain that painted earlier waypoints as done would be
 * asserting facts nobody ruled — which is D8 read backwards.
 *
 * **It does not compute a cost.** The ledger renders `cost_entry` rows grouped by the run
 * that spent them, against the projection the stage's own button states. No arithmetic here
 * that `cost.ts` does not already do.
 */

// ── What the screen is handed ───────────────────────────────────────────────────

export interface EpisodeRoomView {
  episodeId: string
  /** "ep01". */
  label: string
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  show: { id: string; title: string }
  /** "Grey Harbor · Season 1" — the breadcrumb's middle, in the mockup's own words. */
  where: string
  /** Back to the floor, at the address the shell's own bar uses. */
  floorHref: string
  floorName: string
  /** premise → published, with the ruled three states on it (`floor.ts`, Ryan's Aug 11 ruling). */
  track: FloorStop[]
  /** What the track is OF. `LifecycleTrack` refuses one without. */
  trackLabel: string
  /** Where this episode stands, in one line — vanilla, put down, published, or its pins. */
  standing: string

  /** The three wires, whole. Nothing in this module re-derives what they say. */
  writing: WritingRoomView
  checks: CheckBenchView
  sweep: SweepView

  grid: SceneGrid
  /** One card per cluster, in document order — the check bench's own, with where each is. */
  findings: FindingCard[]
  artifacts: ArtifactInTheRoom[]
  /** What an episode with nothing written yet says instead. Null while anything is. */
  noArtifacts: Absence | null
  rail: StageRail
  arcs: ArcInTheRoom[]
  /** What an episode under no arc says instead — vanilla is a standing, not a gap (1.1). */
  noArcs: Absence | null
  ledger: EpisodeLedger
  /** D11's record, each check in one sentence rather than a row of unlabelled numbers. */
  criedWolf: CheckOnTheRecord[]
  /** What this run is saying, or the idle box that holds its shape (E5-0's ruling). */
  live: RoomLive
  headings: RoomHeadings
  /**
   * The preconditions this SCREEN owns, because each lives in a field this process has never
   * seen. Composed on the server, refused with by the API, so a disabled button and a 409 are
   * one string — the shape every bench in this app already keeps.
   */
  refusals: EditRefusals
  /** What the stream sends and where this read was taken from — `floor.ts`'s protocol, reused. */
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

/**
 * An honest empty state: the absence said first, and then what there is instead or the way
 * out of it. Never a blank region, and never a spinner standing in for nothing.
 */
export interface Absence {
  lead: string
  sentence: string
}

/** Every section's name and its plain-words explanation. `SectionHeader` refuses one without. */
export interface RoomHeadings {
  grid: FloorHeading
  artifacts: FloorHeading
  findings: FloorHeading
  rail: FloorHeading
  gates: FloorHeading
  riders: FloorHeading
  arcs: FloorHeading
  ledger: FloorHeading
  desk: FloorHeading
  criedWolf: FloorHeading
}

// ── The scene grid, which is the continuity board (3.2b) ────────────────────────

export interface SceneGrid {
  /** The grid's column names. Copy is the server's, here as everywhere (E4-7's rule). */
  columns: string[]
  /** "derived from the ep01 script v1" — where the rows were read out of. */
  builtFrom: string
  /** The pill's word — "fresh", "stale", "no board". Short enough to glance at. */
  standing: string
  /** The board's own freshness sentence — computed off the edges, never remembered (1.3). */
  freshness: string
  /** Is the board stale? Drives which of two the pill wears; the words are above. */
  stale: boolean
  /** One row per convened deterministic reviewer, in `panel.ts`'s own words. */
  health: GridVerdict[]
  /** The verdict board's own one-line sentence, whole. */
  sentence: string
  rows: SceneOnTheGrid[]
  /** The crossings the rules time a character against, each citing the fact behind it. */
  transits: TransitInTheRoom[]
  /** The species the void kills, each citing the fact that says so. */
  hazards: HazardInTheRoom[]
  /** The absence and the priced button that answers it, or null when a board stands. */
  notYet: { lead: string; sentence: string; build: Offer; stage: string } | null
}

/**
 * One deterministic reviewer's line about the grid — `panel.ts`'s verdict and sentence, and
 * `check-bench.ts`'s sentence for what would answer it. **Both are quoted, never re-worded.**
 * `fresh`, `stale with what answers it`, `partial with what it read` and `unread` are four
 * different pieces of news and the two modules that own that distinction already say them.
 */
export interface GridVerdict {
  checkKey: string
  verdict: BoardVerdict
  /** "clean · 6 facts in scope" — `panel.ts`'s `what`, whole. */
  what: string
  /** What would answer it, or null when the row is an answer already. */
  fix: string | null
}

export interface SceneOnTheGrid {
  sceneId: string
  ordinal: number
  heading: string
  location: string
  /** "Vessa, Ferro" — the Present column, as the board's rows name them. */
  present: string
  /** "suited · exposed" — the pair 3.2b keeps in two columns and the mockup renders as one. */
  environment: string
  /** Whether the void is on this side of the hull. The one place this grid raises its voice. */
  exposed: boolean
  ship: string
  elapsed: string
  /** The deterministic says anchored in this scene — the check bench's own, filtered. */
  verdicts: SayOnTheBench[]
  /** The span the edit box opens on, and the door that lands it (D14, `edit.ts`). */
  edit: Offer
  /** The door's own short label — "edit scene 3". The offer's sentence is its title. */
  editLabel: string
  text: string
  /** The scene-scoped re-check this scene is owed, or null. `remediation.ts`'s own offer. */
  recheck: Offer | null
}

export interface TransitInTheRoom {
  /** "the mess deck → the No. 4 lock takes 90 seconds". */
  sentence: string
  /** The canon fact the number came from, or null when nothing was cited. */
  factId: string | null
}

export interface HazardInTheRoom {
  sentence: string
  factId: string
}

/**
 * One finding card: a span of the artifact, everything said about it, and the sentence that
 * says WHERE it is.
 *
 * The says are `check-bench.ts`'s, whole — severity and confidence side by side, the three
 * remediations, the dismissal, the inherited ruling. What the room adds is `where`, because a
 * card headed "4 ep01" is the bare schema noun Ryan ruled the E4 drill off over.
 */
export interface FindingCard {
  where: string
  /** The span the card is anchored at. '' when there is nothing to highlight (4.3). */
  quote: string
  says: SayOnTheBench[]
  /** How many of the says still stand. A card of dismissals is still worth rendering. */
  standing: number
}

// ── The artifacts panel ─────────────────────────────────────────────────────────

/**
 * One artifact of this episode, whatever kind — the mockup lists the board and the assets
 * beside the three Ryan writes, and freshness is computed for all of them.
 *
 * The two doors are E4-5's and they are the module's own offers (`edit.ts`, `present-step.ts`):
 * a kind nobody writes by hand gets the edit door **disabled with its reason in words** rather
 * than no door at all, because "why can I not type over the continuity board" is a question
 * the screen should answer before it is asked.
 */
export interface ArtifactInTheRoom {
  id: string
  kind: string
  slot: string
  version: number
  /** "fresh" / "stale" / "not started" — the pill's word. */
  standing: string
  stale: boolean
  /** Why it stands where it stands, in one sentence. Never blank. */
  because: string
  /** Notes routed at it that nothing has answered yet (D21). */
  notes: { note: string; sentence: string }[]
  edit: Offer
  /** Put it in front of yourself for a ruling — free, never walled. Null for a derived kind. */
  present: Offer | null
  presentStage: string | null
}

// ── The stage rail ──────────────────────────────────────────────────────────────

export interface StageRail {
  /** Every stage this build has, in catalogue order, each with its offer for THIS episode. */
  stages: StageInTheRoom[]
  /** D12's wall, in the words the producing buttons above are refused with. Null when none. */
  wall: string | null
  /** "Queued behind your ruling: …" — D7's serialization, said (`floor.ts`'s own sentence). */
  queued: string | null
  /** Every gate this episode has had, newest first — each a link into the room that rules it. */
  gates: GateDoor[]
  /** What an episode that has never opened one says instead. Null once one has. */
  noGates: Absence | null
  /** What is not in this build and therefore not on this rail, said rather than left blank. */
  notInThisBuild: string
}

export interface StageInTheRoom {
  /** As `run.stage` persists it and `POST /api/run` takes it. */
  stage: string
  /** What it does with the material — which is what decides whether the wall refuses it. */
  work: StageWork
  offer: Offer
}

/**
 * One gate, as a door rather than as a ruling. **The verdicts are not here** — a gate is
 * ruled in the gate room (#83), and this room links there carrying that room's own honesty
 * about what it can do today (`cockpit.ts`).
 */
export interface GateDoor {
  gateId: string
  /** "the ep01 script" — what is under review, in Ryan's words (`operating.ts`). */
  subject: string
  round: number
  isOpen: boolean
  /** "open, waiting on you · 2 findings stand on it" / "ruled at round 1". */
  standing: string
  href: string
  room: string
  roomNotYet: string | null
  /** Go and rule. Going there spends nothing; what a verdict buys is stated at the gate. */
  open: Offer
}

// ── The arcs this episode is written under ──────────────────────────────────────

export interface ArcInTheRoom {
  arcId: string
  name: string
  /** "character · season" — the mockup's parenthetical. */
  kindAndScope: string
  statement: string
  /** The pin, and what a pin is not (D8). `canon-bench.ts`'s own sentence. */
  note: string
  waypoints: WaypointInTheRoom[]
  href: string
  room: string
  roomNotYet: string | null
}

/**
 * One waypoint of the chain. `here` is the pin this episode declares; everything else is
 * `ahead`, and there is deliberately no `done` — see the module header.
 */
export const WAYPOINT_STANDING = ['here', 'ahead'] as const
export type WaypointStanding = (typeof WAYPOINT_STANDING)[number]

export interface WaypointInTheRoom {
  waypointId: string
  ordinal: number
  name: string
  landingCriteria: string
  standing: WaypointStanding
  /** Move the pin here. `canon-bench.ts`'s offer, with its own refusals. */
  declare: Offer
}

// ── The ledger: what a button projected, against what was recorded ──────────────

export interface EpisodeLedger {
  lines: LedgerLine[]
  totals: CostTotals
  /** The total, rendered. Arithmetic stays in micro-dollars (`cost.ts`). */
  spent: string
  /** `spentSentence`'s words — with the floor caveat when anything went unpriced. */
  sentence: string
  /** What is still offerable on this episode says it would cost — the stages' own sentences. */
  projection: string
}

export interface LedgerLine {
  /** The run's stage, or the door money was spent at when there was no run. */
  label: string
  /** "2 calls · 1 of them failed and cost money anyway" — what the rows say. */
  detail: string
  calls: number
  /** Rendered money. Arithmetic stays in micro-dollars (`cost.ts`). */
  spent: string
  microDollars: number
  failed: number
  unpriced: number
  /** What the button projected, in the stage's own words. Null for spend outside a run. */
  projected: string | null
}

/**
 * How one check has behaved lately, in a sentence.
 *
 * `cried-wolf.ts` composes the maintenance PROMPT (`tune`) and keeps the rest as counts,
 * which is right for a record and wrong for a screen: nine unlabelled numbers in a row is
 * exactly the friction Ryan named — *"names for sections that mean nothing to me"* — and the
 * labels are this room's to say because no earlier surface ever had to.
 */
export interface CheckOnTheRecord {
  checkKey: string
  sentence: string
  /** The maintenance question, when this check has earned one. Null otherwise. A QUESTION. */
  tune: string | null
}

// ── The live region ─────────────────────────────────────────────────────────────

/**
 * What is happening on this episode right now — and, when nothing is, the same box saying so.
 *
 * **Idle is a state, not an absence** (E5-0). A region that appeared when a run started would
 * move the page by existing, which is the defect the whole region exists to end.
 */
export interface RoomLive {
  /** Null only when nothing has ever run on this episode. */
  runId: string | null
  heading: string
  latest: string | null
  stream: string[]
  /** The log position the two lines above are as of — `floor.ts`'s dedup protocol, reused. */
  seq: number
  /** The run's transitions, oldest first. Re-read on every transition, never patched. */
  entries: { seq: number; sentence: string }[]
  idle: boolean
}

// ── The room ────────────────────────────────────────────────────────────────────

export function episodeRoomView(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
  llm: LLMReadiness,
): EpisodeRoomView | undefined {
  // Taken FIRST, before a row below is read: it is the position a browser opens the live
  // stream at, so anything landing while this view is composed is replayed rather than lost.
  const since = latestSeq(store)

  const where = episodeInShow(store, episodeId)
  if (!where) return undefined

  const writing = writingRoomView(store, library, episodeId, llm)
  const checks = checkBenchView(store, library, episodeId, llm)
  const sweep = sweepView(store, episodeId)
  if (!writing || !checks || !sweep) return undefined

  const label = episodeLabel(where.episode.number)
  const rooms = destinationsOf()
  const catalogue = stageCatalogue(library)
  const runs = runsOfEpisode(store, episodeId)
  const inFlight = runs.find((run) => run.status === 'queued' || run.status === 'running')

  return {
    episodeId,
    label,
    number: where.episode.number,
    title: where.episode.title,
    lifecycle: where.episode.lifecycle,
    show: { id: where.show.id, title: where.show.title },
    where: `${where.show.title} · Season ${where.season.number}`,
    floorHref: roomFor(rooms, 'floor').path,
    floorName: roomFor(rooms, 'floor').name,
    // The ruled three states, from the one composer both screens read (`floor.ts`). A second
    // implementation of the pip is the drift the chrome exists to prevent.
    track: lifecycleStops(where.episode.lifecycle, inFlight?.status === 'running'),
    trackLabel: `${label} ${where.episode.title} — premise through published`,
    standing: standingOf(writing, where.episode.abandonedAt, label),

    writing,
    checks,
    sweep,

    grid: sceneGrid(store, library, llm, catalogue, episodeId, label, checks),
    findings: findingCards(checks, label),
    artifacts: artifactsInTheRoom(store, episodeId, writing),
    noArtifacts: nothingWritten(writing, label),
    rail: stageRail(store, llm, catalogue, rooms, episodeId, runs, writing, label),
    arcs: arcsInTheRoom(store, rooms, where.show.id, writing),
    noArcs: noArcs(writing, label),
    ledger: episodeLedger(store, llm, catalogue, episodeId, runs, label),
    criedWolf: checks.record.map((one) => ({
      checkKey: one.checkKey,
      sentence:
        `${count(one.readings, 'reading')}, ${one.silent} of them silent · ` +
        `${count(one.firings, 'firing')} over ${count(one.concerns.length, 'concern')} · ` +
        `${one.dismissed} you dismissed, ${one.overridden} you overrode, ${one.confirmed} ` +
        `confirmed by a rewrite, ${one.unruled} unruled · ${one.gaps} it could not read`,
      tune: one.tune,
    })),
    live: roomLive(store, label, runs),
    headings: HEADINGS,
    refusals: EDIT_REFUSALS,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since },
  }
}

const HEADINGS: RoomHeadings = {
  grid: {
    name: 'Scene grid',
    explains:
      'The continuity board as it stands, one row per scene. The deterministic rules read ' +
      'these rows rather than the script, so re-checking a scene costs nothing.',
  },
  artifacts: {
    name: 'Artifacts',
    explains:
      'Every draft this episode has on the volume, with the version each one was built ' +
      'from. Those versions are compared every time you open this page. You can edit any ' +
      'of them yourself, or present one for a ruling.',
  },
  findings: {
    name: 'Findings',
    explains:
      'What the checks flagged, with severity and confidence printed as two readings. A ' +
      'check argues and never decides. For each finding you can rewrite the span, propose ' +
      'the canon change, or dismiss it with a note.',
  },
  rail: {
    name: 'Stage rail',
    explains:
      'What you can start on this episode, and what each one costs before you click it. ' +
      'Anything you cannot start says why here rather than failing after the click.',
  },
  gates: {
    name: 'Gates',
    explains:
      'Every draft this episode has opened a gate on, and the room where you rule on one.',
  },
  riders: {
    name: 'Riding this episode',
    explains:
      'What the writing claimed about canon and you have not ruled on yet. You rule on ' +
      'them one at a time. Approving the script did not rule on any of them.',
  },
  arcs: {
    name: 'Arc positions',
    explains:
      'Where this episode says it sits on each arc. A pin is not a landing: the landing ' +
      'proposal is raised when the script is read, and you rule on it.',
  },
  ledger: {
    name: 'Cost ledger',
    explains:
      'What each button projected before you clicked it, beside what the ledger recorded ' +
      'afterwards. Failed calls are in here too, because a call that came back wrong still ' +
      'spent money.',
  },
  desk: {
    name: 'The writer’s desk',
    explains:
      'What the model would be handed if you clicked: every fact, why it is there, what was ' +
      'left out and the rule that left it out, and your own notes with where you gave them.',
  },
  criedWolf: {
    name: 'Reviewing the reviewers',
    explains:
      'How each check has behaved across this show lately. This panel is yours to read, and ' +
      'nothing on it disables, demotes or re-weights a check.',
  },
}

/**
 * What an episode with nothing written yet says instead of an empty panel — the absence, and
 * the button that answers it, in the first writing stage's own words.
 */
function nothingWritten(writing: WritingRoomView, label: string): Absence | null {
  if (writing.written.length > 0) return null
  const first = writing.line[0]!
  return {
    lead: `Nothing has been written for ${label} yet.`,
    sentence:
      `${first.offer.sentence} — ${first.offer.enabled ? first.offer.cost : first.offer.blockedBecause}. ` +
      'Nothing has been built for this episode yet, so nothing here can be out of date.',
  }
}

/** An episode under no arc, said as the standing it is rather than as a gap (1.1). */
function noArcs(writing: WritingRoomView, label: string): Absence | null {
  if ((writing.positions?.waypoints.length ?? 0) > 0) return null
  return {
    lead: `${label} stands on no arc.`,
    sentence:
      writing.positions?.standing ??
      'This show declares no arcs, so there is nothing here for an episode to sit on. An ' +
        'episode that touches no arc is vanilla. Not every episode advances an arc, and the ' +
        'season map tracks which ones do.',
  }
}

/** Where this episode stands, in one line. Never blank — vanilla is a standing too (1.1). */
function standingOf(
  writing: WritingRoomView,
  abandonedAt: string | null,
  label: string,
): string {
  if (abandonedAt !== null) {
    return (
      `${label} was abandoned on ${abandonedAt.slice(0, 10)}. It keeps the stage it reached, ` +
      'the proposals riding it were parked, and each fact it had established came back to ' +
      'you as its own revert proposal.'
    )
  }
  // The pin's own sentence, composed where the pin is (`canon-bench.ts`) — including the
  // vanilla one, which says that touching no arc is legal and tracked rather than a gap.
  return writing.positions?.standing ?? `${label} stands at ${writing.lifecycle}.`
}

// ── The grid ────────────────────────────────────────────────────────────────────

/**
 * The mockup's own seven, and deliberately NOT an eighth for the verdicts.
 *
 * What the deterministic rules said about a scene is a full sentence plus the concern behind
 * it, and a column wide enough for one pushes the edit door off the end of the grid. So a
 * scene's verdicts land in a row of their own, directly under it and across the whole table —
 * which is also where the mockup puts a scene's own note ("✓ re-checked after your edit").
 */
const GRID_COLUMNS = ['Scene', 'Location', 'Present', 'Environment', 'Ship', 'Elapsed', '']

function sceneGrid(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  catalogue: ReturnType<typeof stageCatalogue>,
  episodeId: string,
  label: string,
  checks: CheckBenchView,
): SceneGrid {
  const board = boardOf(store, episodeId)
  // The board's verdicts, off the check bench's own rows. `panel.ts` decides what `stale`,
  // `partial` and `unread` mean and says each in a sentence; this filters and renders.
  const health = checks.rows
    .filter((row) => row.row.tier === 'deterministic')
    .map((row): GridVerdict => ({
      checkKey: row.row.checkKey,
      verdict: row.row.verdict,
      what: row.row.what,
      fix: row.fix,
    }))

  // The scene edit doors, and the scenes still owed a paid re-reading. Both are other
  // modules' offers with their own refusals on them (`edit.ts`, `remediation.ts`).
  const edits = new Map(
    (checks.artifact.id === ''
      ? []
      : scenesToEdit(store, library, checks.artifact.id)
    ).map((one: SceneToEdit) => [one.sceneId, one]),
  )
  const rechecks = new Map(
    checks.rechecks.map((one) => [one.sceneId, one.offer]),
  )
  // The deterministic says, by the scene they landed in. A cluster already carries the
  // scene as the episode numbers it, so nothing here re-resolves an anchor.
  const says = new Map<number, SayOnTheBench[]>()
  for (const cluster of checks.clusters) {
    if (cluster.scene === null) continue
    const deterministic = cluster.says.filter((say) => say.tier === 'deterministic')
    if (deterministic.length === 0) continue
    says.set(cluster.scene, [...(says.get(cluster.scene) ?? []), ...deterministic])
  }

  const build = catalogue['continuity-board']!
  const rows = (board?.scenes ?? []).map((scene): SceneOnTheGrid => {
    const edit = edits.get(scene.sceneId)
    return {
      sceneId: scene.sceneId,
      ordinal: scene.ordinal,
      heading: scene.heading,
      location: scene.location,
      present: scene.present.map((who) => who.characterName).join(', '),
      environment: environmentOf(scene),
      exposed: scene.environment === 'exposed',
      ship: scene.shipPosition,
      elapsed: scene.elapsedLabel,
      verdicts: says.get(scene.ordinal) ?? [],
      edit: edit?.edit ?? noSceneDoor(label, scene.ordinal),
      // Short, because it sits in a table cell. The offer's whole sentence rides on the
      // door's `title`, so nothing is trimmed away — it is said twice, at two lengths.
      editLabel: `edit scene ${scene.ordinal}`,
      text: edit?.text ?? '',
      recheck: rechecks.get(scene.sceneId) ?? null,
    }
  })

  const freshness = boardFreshness(store, episodeId, board, label)
  return {
    columns: GRID_COLUMNS,
    builtFrom:
      board?.source === undefined
        ? `Nothing has been read into a board for ${label} yet.`
        : `Derived from the ${label} ${board.source.kind} v${board.source.version}, one edge per scene.`,
    standing: board === undefined ? 'no board' : freshness.stale ? 'stale' : 'fresh',
    freshness: freshness.sentence,
    stale: freshness.stale,
    health,
    sentence: checks.board.sentence,
    rows,
    transits: (board?.transits ?? []).map((transit) => ({
      sentence: `${transit.from} → ${transit.to} takes ${transit.seconds} seconds`,
      factId: transit.factId,
    })),
    // The species the void kills, named — with the fact behind it, because a hazard nobody
    // can quote is an opinion (`domain/board.ts`) and a grid that stated one without its
    // lineage would be the rule speaking rather than canon.
    hazards: (board?.hazards ?? []).map((hazard) => ({
      sentence: `${findEntityById(store, hazard.entityId)?.name ?? hazard.entityId} — ${hazard.hazard}`,
      factId: hazard.factId,
    })),
    notYet:
      board !== undefined
        ? null
        : {
            lead: 'No continuity board yet.',
            sentence:
              `Nothing has read the ${label} script into a grid yet, so the deterministic ` +
              'rules have no rows to read. An empty grid is not a clean one. Extracting the ' +
              'board is one model call; running the rules over it afterwards costs nothing, ' +
              'as many times as you like.',
            build: stageOffer(store, llm, episodeId, build),
            stage: build.name,
          },
  }
}

/**
 * "suited · exposed" — the pair 3.2b keeps in two columns because one column could not say
 * both. The scene's environment leads, and what the bodies in it are wearing follows; a scene
 * where everybody is wearing the same thing says it once.
 */
function environmentOf(scene: BoardScene): string {
  const worn = [...new Set(scene.present.map((who) => who.protection))].filter(
    (protection) => protection !== 'none',
  )
  return [...worn, scene.environment].join(' · ')
}

/** The board's own freshness, in `edit.ts`'s words — computed off the edges, never a flag. */
function boardFreshness(
  store: Store,
  episodeId: string,
  board: Board | undefined,
  label: string,
): { sentence: string; stale: boolean } {
  if (!board) {
    return { sentence: `${label} has no continuity board on the volume.`, stale: false }
  }
  const freshness = artifactFreshness(store, episodeId).find(
    (one) => one.artifact.id === board.artifact.id,
  )
  if (freshness?.status === 'stale') {
    return { sentence: staleSentence(store, board.artifact, freshness.reasons), stale: true }
  }
  return {
    sentence:
      `The board stands at v${board.artifact.version}, and nothing it was built from has ` +
      'moved since. Those versions are compared every time you open this page.',
    stale: false,
  }
}

/** A scene the script has, that the draft on the volume does not — said, never hidden. */
const noSceneDoor = (label: string, ordinal: number): Offer => ({
  sentence: `Edit scene ${ordinal} of the ${label} script yourself`,
  cost: 'Nothing to cost: there is no draft to type over.',
  enabled: false,
  blockedBecause:
    `The board has a row for scene ${ordinal}, and there is no ${label} script on the volume ` +
    'to open it from. A scene is read out of the written episode, so write the script or ' +
    'edit the whole draft.',
})

/**
 * The check bench's clusters, each with the sentence that says where it is. Nothing is
 * re-clustered and nothing is re-worded — `where` is the only string added, and it exists
 * because a heading of a scene number beside an episode label is a name only the database
 * recognises (Ryan's second criterion, E5-0).
 */
function findingCards(checks: CheckBenchView, label: string): FindingCard[] {
  return checks.clusters.map((cluster): FindingCard => ({
    where:
      cluster.scene === null
        ? `The whole ${label} ${checks.artifact.kind} · ${count(cluster.says.length, 'reviewer')} on it · ${cluster.standing} still standing`
        : `Scene ${cluster.scene} of the ${label} ${checks.artifact.kind} · ${count(cluster.says.length, 'reviewer')} on this span · ${cluster.standing} still standing`,
    quote: cluster.quote,
    says: cluster.says,
    standing: cluster.standing,
  }))
}

// ── The artifacts panel ─────────────────────────────────────────────────────────

function artifactsInTheRoom(
  store: Store,
  episodeId: string,
  writing: WritingRoomView,
): ArtifactInTheRoom[] {
  // The three Ryan writes come from `writtenOnThePage` with both their doors already on them
  // (E4-5). Everything else is derived, and gets the same freshness read plus the edit door's
  // own refusal — which explains, in words, why nobody types a board by hand.
  const written = new Map(writing.written.map((one) => [one.id, one]))

  return artifactFreshness(store, episodeId).map((freshness): ArtifactInTheRoom => {
    const artifact = freshness.artifact
    const door = written.get(artifact.id)
    return {
      id: artifact.id,
      kind: artifact.kind,
      slot: artifact.slot,
      version: artifact.version,
      standing: STANDING_WORD[freshness.status],
      stale: freshness.status === 'stale',
      because: freshnessSentence(store, freshness),
      notes: door?.standing ?? [],
      edit: door?.edit ?? derivedEditDoor(artifact.kind),
      present: door?.present ?? null,
      presentStage: door?.presentStage ?? null,
    }
  })
}

const STANDING_WORD: Record<ArtifactFreshness['status'], string> = {
  fresh: 'fresh',
  stale: 'stale',
  'not-started': 'not started',
}

/**
 * Why an artifact stands where it stands, in one sentence, for all three standings.
 *
 * The stale one is `edit.ts`'s, whole — it is the sentence with the revision summaries in it
 * ("your scene-3 edit made v4") and there is exactly one of it in this app. The other two are
 * composed here because nothing else had to say them: a fresh artifact's news is what it last
 * did and that nothing under it has moved, and a recorded-but-never-produced one has no draft
 * at all, which is a third piece of news rather than a quiet kind of fresh.
 */
function freshnessSentence(store: Store, freshness: ArtifactFreshness): string {
  const artifact = freshness.artifact
  const subject = `The ${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`
  if (freshness.status === 'not-started') {
    return `${subject} has a row and no draft. Nothing was ever written to the volume for it.`
  }
  if (freshness.status === 'stale') {
    return staleSentence(store, artifact, freshness.reasons)
  }
  const last = revisionsOf(store, artifact.id).at(-1)
  return (
    `${subject} stands at v${artifact.version}` +
    (last === undefined ? ', as it was first written' : ` — ${last.summary}`) +
    '. Nothing it was built from has moved since.'
  )
}

/** The edit door on a kind nobody writes by hand: present, disabled, and it says why. */
const derivedEditDoor = (kind: string): Offer => ({
  sentence: `Edit the ${kind} yourself`,
  cost: 'Nothing to cost: this is not a kind anybody types.',
  enabled: false,
  blockedBecause:
    `A ${kind} is read out of something else rather than written by hand. Typing over it ` +
    'would put a reading on the volume that nothing read. Edit what it was built from, and ' +
    'build it again.',
})

// ── The stage rail ──────────────────────────────────────────────────────────────

function stageRail(
  store: Store,
  llm: LLMReadiness,
  catalogue: ReturnType<typeof stageCatalogue>,
  rooms: readonly Destination[],
  episodeId: string,
  runs: readonly Run[],
  writing: WritingRoomView,
  label: string,
): StageRail {
  const room = roomFor(rooms, 'gate-room')
  const gates = writing.gates.map((gate) => gateDoor(gate, room))

  return {
    // Every stage the catalogue has, in its own order — never a list of names kept here. A
    // stage E6 adds appears on this rail by declaring itself, exactly as it appears on the
    // check bench (`readingStages`) and on the floor.
    stages: Object.values(catalogue).map((stage): StageInTheRoom => ({
      stage: stage.name,
      work: stage.work,
      offer: stageOffer(store, llm, episodeId, stage),
    })),
    wall: writing.wall,
    queued: queuedSentence(store, runs),
    gates,
    noGates:
      gates.length > 0
        ? null
        : {
            lead: `No gate has ever opened on ${label}.`,
            sentence:
              'A writing stage opens one when its draft stops arguing with the checks. A ' +
              'presenting stage opens one whenever you ask for a ruling. Both stages are on ' +
              'the rail above, and both say what they cost before you click.',
          },
    notInThisBuild:
      'E6 builds shot images, speech takes and the mix. E7 builds assembly and publishing. ' +
      'None of them has a button here, because there is no code behind one yet.',
  }
}

function gateDoor(gate: GateInTheRoom, room: Destination): GateDoor {
  const standing = gate.clusters.reduce((sum, cluster) => sum + cluster.standing, 0)
  return {
    gateId: gate.id,
    subject: gate.subject,
    round: gate.round,
    isOpen: gate.isOpen,
    standing: gate.isOpen
      ? `Open at round ${gate.round}, waiting on you — ${count(standing, 'finding')} stand on ${gate.subject}`
      : `Ruled at round ${gate.round}, and kept as the record of what you decided`,
    href: `${room.path}/${gate.id}`,
    room: room.name,
    roomNotYet: room.notYetBecause,
    open: {
      sentence: gate.isOpen
        ? `Rule on ${gate.subject} — round ${gate.round}, at its gate`
        : `Read back ${gate.subject} at round ${gate.round} — what stood, and what you decided`,
      // Going there spends nothing. What a REJECTION buys is the stage's own declared cost and
      // it is stated at the gate, on the button that spends it — quoting one of three verdicts
      // here would be pricing a decision he has not made.
      cost: `${count(standing, 'finding')} · no model call · $0.00 to open it`,
      enabled: true,
      blockedBecause: null,
    },
  }
}

// ── The arcs ────────────────────────────────────────────────────────────────────

function arcsInTheRoom(
  store: Store,
  rooms: readonly Destination[],
  showId: string,
  writing: WritingRoomView,
): ArcInTheRoom[] {
  const section = writing.positions
  if (!section) return []

  const room = roomFor(rooms, 'arc-page')
  // Read once for the scope and the statement, which `declarePositionSection` does not carry
  // and the mockup prints ("character · season", and the arc's own prose).
  const arcs = new Map(arcsOf(store, showId).map((arc): [string, Arc] => [arc.id, arc]))
  const order: string[] = []
  for (const waypoint of section.waypoints) {
    if (!order.includes(waypoint.arcId)) order.push(waypoint.arcId)
  }

  return order.map((arcId): ArcInTheRoom => {
    const arc = arcs.get(arcId)!
    const waypoints = section.waypoints.filter((one) => one.arcId === arcId)
    const pinned = waypoints.find((one) => one.declared)
    return {
      arcId,
      name: arc.name,
      kindAndScope: `${arc.kind} · ${arc.scope}`,
      statement: arc.statement,
      note:
        pinned === undefined
          ? 'This episode declares no position on this arc, and owes it nothing. An episode ' +
            'that declares a position on no arc at all is vanilla. Not every episode ' +
            'advances an arc, and the season map tracks which ones do.'
          : `This episode declares waypoint ${pinned.ordinal}, and the checks read it against ` +
            'that waypoint. A pin is not a landing: the landing proposal is raised when the ' +
            'script is read, and you rule on it.',
      waypoints: waypoints.map((one): WaypointInTheRoom => ({
        waypointId: one.waypointId,
        ordinal: one.ordinal,
        name: one.name,
        landingCriteria: one.landingCriteria,
        standing: one.declared ? 'here' : 'ahead',
        declare: one.declare,
      })),
      href: `${room.path}/${arcId}`,
      room: room.name,
      roomNotYet: room.notYetBecause,
    }
  })
}

// ── The ledger ──────────────────────────────────────────────────────────────────

/**
 * **What each button projected, against what the ledger recorded.**
 *
 * One line per run, because a run is what a button starts — so "Script · 2 rounds + 1 retry ·
 * $3.85" has a projection beside it that is the same stage's own `offerOn` sentence, and the
 * two are comparable by construction rather than by coincidence. Rows with no run are the
 * clicks that spend outside one (a pre-drafted rewrite, a scene re-check) and they get their
 * own line rather than being dropped, which would make the lines not add up to the total.
 *
 * **A failed call is a line item, not a footnote.** It burned tokens and returned nothing
 * usable; a ledger that only counted the successful ones would under-report a bad afternoon,
 * and `cost.ts` already keeps `outcome` for exactly this.
 */
function episodeLedger(
  store: Store,
  llm: LLMReadiness,
  catalogue: ReturnType<typeof stageCatalogue>,
  episodeId: string,
  runs: readonly Run[],
  label: string,
): EpisodeLedger {
  const stageOf = new Map(runs.map((run) => [run.id, run.stage]))
  const byRun = new Map<string, CostEntry[]>()
  for (const entry of costsOfEpisode(store, episodeId)) {
    const key = entry.runId ?? ''
    byRun.set(key, [...(byRun.get(key) ?? []), entry])
  }

  const lines = [...byRun.entries()].map(([runId, entries]): LedgerLine => {
    const stage = runId === '' ? undefined : stageOf.get(runId)
    const declared = stage === undefined ? undefined : catalogue[stage]
    const microDollars = entries.reduce((sum, one) => sum + one.microDollars, 0)
    const failed = entries.filter((one) => one.outcome === 'failed').length
    const unpriced = entries.filter((one) => one.priced === 'unpriced').length

    return {
      label:
        stage ??
        (runId === ''
          ? 'Clicks outside a run — a pre-drafted rewrite, or a scene re-check'
          : `A run of a stage this build no longer has`),
      detail: [
        `${count(entries.length, 'call')}`,
        failed === 0 ? '' : `${failed} of them failed and cost money anyway`,
        unpriced === 0
          ? ''
          : `${count(unpriced, 'call')} came back with no price, so this total is a floor`,
      ]
        .filter(Boolean)
        .join(' · '),
      calls: entries.length,
      spent: money(microDollars),
      microDollars,
      failed,
      unpriced,
      // The stage's own declared cost — what its button says, and what it said when it was
      // clicked. Never a number this module works out.
      projected:
        declared === undefined
          ? null
          : stageOffer(store, llm, episodeId, declared).cost,
    }
  })

  const totals = costOfEpisode(store, episodeId)
  // What is still offerable, quoted rather than summed: adding up projections would be the
  // new cost computation this room is not allowed to invent, and the stages already say it.
  const offerable = Object.values(catalogue)
    .map((stage) => ({ stage, offer: stageOffer(store, llm, episodeId, stage) }))
    .filter((one) => one.offer.enabled && one.offer.cost !== 'No model call · $0.00')

  return {
    lines,
    totals,
    spent: money(totals.microDollars),
    sentence: spentSentence(totals),
    projection:
      offerable.length === 0
        ? `Nothing you can start on ${label} right now would spend a cent. Every stage still ` +
          'open to it reads rows instead of calling a model, and this build neither produces ' +
          'assets nor assembles an episode.'
        : `Every stage you can still start on ${label} states its price before you click: ` +
          offerable.map((one) => `${one.stage.name} — ${one.offer.cost}`).join('; ') +
          '. Nothing is projected past the writing line, because this build neither produces ' +
          'assets nor assembles an episode.',
  }
}

// ── The live region ─────────────────────────────────────────────────────────────

function roomLive(store: Store, label: string, runs: readonly Run[]): RoomLive {
  const holders = lockHolders(store)
  const running = runs.find((run) => run.status === 'running')
  const newest = runs[0]

  if (running) {
    const live = liveOfRun(store, holders, running)
    return { ...live, entries: entriesOf(store, running.id), idle: false }
  }

  if (!newest) {
    return {
      runId: null,
      heading: `Nothing has ever run on ${label}`,
      latest: null,
      stream: [],
      seq: 0,
      entries: [],
      idle: true,
    }
  }

  // The newest run's last words, under a heading that says the run is not talking any more.
  // The box holds its shape either way, so starting one moves nothing (E5-0).
  const prose = proseOfRun(store, newest.id)
  return {
    runId: newest.id,
    heading: `${newest.stage} on ${label} — ${IDLE[newest.status]}`,
    latest: prose.latest,
    stream: prose.stream,
    seq: prose.seq,
    entries: entriesOf(store, newest.id),
    idle: true,
  }
}

const IDLE: Record<Run['status'], string> = {
  queued: 'queued, and it starts when this episode is free',
  running: 'running',
  paused: 'waiting on your ruling',
  done: 'finished',
  failed: 'failed',
}

/**
 * The run's transitions, oldest first — its story, in the event log's own sentences.
 *
 * Transitions only: the streamed prose is the two lines above it and putting it here as well
 * would print the same words twice. It is re-read whenever a transition lands rather than
 * patched in the browser, which is the floor's protocol exactly (`Floor.tsx`): prose is
 * accumulated client-side, everything else re-reads.
 */
function entriesOf(store: Store, runId: string): { seq: number; sentence: string }[] {
  return transitionsOfRun(store, runId).map((event) => ({
    seq: event.seq,
    sentence: event.summary ?? event.kind,
  }))
}

// ── Reading ─────────────────────────────────────────────────────────────────────

/** The room by id, off the same list the shell draws its bar from (`cockpit.ts`). */
function roomFor(rooms: readonly Destination[], id: string): Destination {
  return rooms.find((room) => room.id === id)!
}
