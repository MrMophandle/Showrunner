import { declarePositionSection, type DeclarePositionSection } from './canon-bench.ts'
import { costOfEpisode, spentSentence, type CostTotals } from './cost.ts'
import type { Store } from './db/store.ts'
import { findArtifact, type ArtifactKind } from './domain/artifact.ts'
import type { CanonEntity } from './domain/canon.ts'
import { clusterFindings, type ClusterSay } from './domain/panel.ts'
import type { FindingSeverity } from './domain/finding.ts'
import { episodeInShow, episodeLabel, type EpisodeLifecycle } from './domain/spine.ts'
import {
  composeWriteContext,
  producedBy,
  WRITE_STEP,
  type ArcInContext,
  type ContextGap,
  type EntityLeftOut,
  type FactReach,
  type InclusionReason,
  type NoteOrigin,
  type WriteContext,
  type WriteStep,
} from './domain/write-context.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import {
  gateOnThePage,
  lifecycleTrack,
  stageOffer,
  writtenOnThePage,
  type GateOnThePage,
  type LifecycleStop,
  type Offer,
  type WrittenOnThePage,
} from './operating.ts'
import { historyOf } from './runner/correction-loop.ts'
import { gatesOfEpisode } from './runner/gate.ts'
import { PRESENTING_STAGE } from './runner/present-step.ts'
import {
  BLOCKS_THE_NEXT_STAGE,
  stageBlockedBecause,
  stageBlockingFindings,
} from './runner/stage-wall.ts'
import { stageCatalogue } from './runner/stages.ts'
import type { StageCatalogue } from './runner/step.ts'
import { composeWritePrompt, REACH, WRITING_STAGE } from './runner/write-step.ts'
import { sweepOnThePage, type SweepOnThePage } from './sweep.ts'

/**
 * **The writing room** (E4-7, #67) — the read model behind the operating page's writing
 * section, and the epic exit of E4: the surface Ryan writes an episode from, rules its three
 * gates at, edits its drafts by hand, declares its arc position, and finishes its completion
 * sweep, with the writer's desk open beside every button.
 *
 * ## It composes seven issues of scaffolding and invents no mechanic
 *
 * Every offer, sentence, refusal and record on it belongs to an issue that already landed.
 * The three launch buttons are `write-step.ts`'s own `offerOn` declarations, run through the
 * same `stageOffer` a card uses. The gates are `operating.ts`'s `gateOnThePage`, whole. The
 * edit and presenting doors are `writtenOnThePage`. The riders are `sweep.ts`'s. The pin is
 * `canon-bench.ts`'s `declarePositionSection`. The clustered findings are `panel.ts`'s. This
 * module starts nothing, spends nothing, writes no row, and calls no model — a GET of it is
 * free, which is invariant 5 at page-load scale.
 *
 * **The one genuinely new render is the desk** (`DeskInTheRoom`), and even that composes
 * nothing: it is E4-0's `WriteContext` in its own vocabulary — every entity with the door it
 * came through and the words for it, every entity that did NOT make the slice with the rule
 * that kept it out, every fact with the door in TIME it came through, and Ryan's own notes
 * with their three origins kept apart.
 *
 * ## Why the desk is on the screen at all — the HIL contract, at the writing line
 *
 * "Everything pertinent, present, zero archaeology" (4.6). Ryan judges a draft, and the only
 * fair way to judge one is against **what the writer knew**. Four questions come up at every
 * writing gate and not one of them is answerable from the draft:
 *
 *   * *Why did it write that?* — the facts on the desk, each with its reach.
 *   * *Why did it not know about X?* — `leftOut`, with the rule in words. This is the half that
 *     cannot be inferred from a list of what WAS included, which is why `write-context.ts`
 *     carries it at all.
 *   * *Did it read my note?* — the notes, with their origin. A rejection routed back here is a
 *     different authority from a finding he dismissed three episodes ago, and the desk keeps
 *     them apart rather than flattening both into a bag of sentences.
 *   * *Is it about to spend my money on the wrong thing?* — the desk is rendered BEFORE the
 *     click, off the same composer the click uses. That is the whole point of the panel:
 *     it is a preview of what a call will be handed, not a post-mortem of one.
 *
 * ## What the desk cannot know before the click, and says so
 *
 * The prompt below is composed by `composeWritePrompt` — the step's own function, never a
 * reconstruction (write-step.ts says so where it exports it). What it takes beyond the desk is
 * a `ProducerBrief`, and exactly one part of that is unknowable in advance: **the checks' notes
 * from a round that has not run yet.** So the round number is computed the way the loop
 * computes it (`historyOf`) and the findings are empty, and `promptCaveat` states which clause
 * a real round would add. Rendering a guess as the real thing is the collapse invariant 4
 * forbids one layer up; saying which part is a floor is the honest version.
 *
 * ## Where it stops, deliberately
 *
 * **It is not the episode room, and it is not the gate room.** Both are E5's, both are drawn
 * (`mockups/episode-room.html`, `mockups/gate-room.html`), and nothing here spends a character
 * on looking like them: no colour, no fold, no dock, no chips. What this owes those mockups is
 * the FACTS they render, already queryable and already in sentences with tests — so E5 finds
 * the arrangement true and only has to make it beautiful.
 *
 * **It adds no verb.** There is no button here that is not already reachable through an API
 * route that existed before this issue, and in particular there is no bulk anything: the sweep
 * still rules one rider at a time (E4-6's ledger entry forbids a fourth button in as many
 * words), and the three gate verdicts are still three.
 */

// ── What the room is handed ─────────────────────────────────────────────────────
//
// There is no `refusals` object here, unlike every other bench, and that is not an omission:
// the one precondition the PAGE owns at a gate — a rejection needs a note — names the artifact
// being rejected, so it rides on each gate as `GateOnThePage.rejectNeedsNote` rather than on
// the room. One string, three readers (`runner/gate.ts`).

export interface WritingRoomView {
  episodeId: string
  /** "ep02". */
  label: string
  title: string
  show: { id: string; title: string }
  lifecycle: EpisodeLifecycle
  /** premise → … → published, and where this episode stands (`operating.ts`). */
  track: LifecycleStop[]
  spend: CostTotals
  spendSentence: string
  /**
   * The writing line, in the order it runs: premise, outline, script. Each carries the stage
   * that does its work, that stage's button, and the desk behind it.
   */
  line: StepInTheRoom[]
  /**
   * Which of the three the lifecycle is AT — the work this episode still owes — or null past
   * the writing line, where `assets` and beyond are E6's and no writing stage applies.
   */
  at: WriteStep | null
  /** Every written artifact, with its freshness and both of Ryan's doors (E4-5). */
  written: WrittenOnThePage[]
  /** Every gate ever opened on this episode, newest first, each readable in full. */
  gates: GateInTheRoom[]
  /** The completion sweep this episode owes canon, or null when it owes none (E4-6). */
  sweep: SweepOnThePage | null
  /** The pin on every arc this episode is written under, and the door that moves it (E4-4). */
  positions: DeclarePositionSection | null
  /**
   * D12's wall in its own words, or null. The same string `launchBlockedBecause` refuses a
   * producing stage with, so the room and the disabled button cannot drift.
   */
  wall: string | null
}

/** One step of the writing line: the stage that does it, its button, and its desk. */
export interface StepInTheRoom {
  step: WriteStep
  /** What it produces. `num_scenes` is an output of the script, never an input to it (D3). */
  kind: ArtifactKind
  /** The stage's name, as `run.stage` persists it and as `POST /api/run` takes it. */
  stage: string
  /** Verb + object + scope + upper-bound cost, and the reason it cannot be pressed. */
  offer: Offer
  /** The stage that puts this artifact in front of Ryan for a ruling — free, never walled. */
  presentStage: string
  /** True for the step the episode's lifecycle names. */
  current: boolean
  desk: DeskInTheRoom
}

/**
 * **What the writer was handed** — `WriteContext`, rendered, and nothing added to it.
 *
 * Every field below is E4-0's, carried through in its own words. Nothing here re-derives a
 * slice, re-reads canon, or asks a second question of the store: a desk composed twice is two
 * desks, and the one on the screen would be the one that was right yesterday.
 */
export interface DeskInTheRoom {
  step: WriteStep
  /** The line the desk composes about itself — the same one the step's progress prints. */
  sentence: string
  upstream: UpstreamOnTheDesk
  /** Every entity in the slice, with every door it came through. */
  entities: EntityOnTheDesk[]
  /** Every entity of the show that did NOT make it, with the rule that kept it out. */
  leftOut: EntityLeftOut[]
  arcs: ArcOnTheDesk[]
  /** No declared position on any arc — legal, tracked, never a failure state (1.1). */
  vanilla: boolean
  /** Ryan's own words, newest first, with their three origins kept apart. */
  notes: NoteOnTheDesk[]
  /** The words a call would be handed, composed by the step's own function. */
  prompt: string
  /** Which round that prompt is for, computed the way the loop computes it. */
  round: number
  /** What the prompt cannot know before the click, in words. Never omitted (invariant 4). */
  promptCaveat: string
}

/** What the step reads from, rendered — never a path (D15), and which nothing it is. */
export interface UpstreamOnTheDesk {
  /** The kind the step before this one produces. Null for the premise, which reads canon. */
  expected: ArtifactKind | null
  artifactId: string | null
  version: number | null
  text: string | null
  /** Why there is no text, when there is none. Null when there is. */
  note: string | null
}

export interface EntityOnTheDesk {
  id: string
  name: string
  categoryKey: string
  standing: CanonEntity['standing']
  status: CanonEntity['status']
  /** Every door it came through, in `INCLUSION_REASON` order. Never empty. */
  reasons: { reason: InclusionReason; because: string }[]
  facts: FactOnTheDesk[]
  /** A fact-carrying edge that brought nothing, and which kind of nothing it was. */
  gaps: ContextGap[]
}

/** One fact on the desk, with the door in TIME it came through (the audience rule). */
export interface FactOnTheDesk {
  id: string
  statement: string
  reach: FactReach
  /** What that reach means, in the words the prompt itself uses (`write-step.ts`'s `REACH`). */
  reachSentence: string
  /** Where it travelled from (D22), or null when it is the entity's own. */
  inherited: { source: string; via: string } | null
}

export interface ArcOnTheDesk {
  arcId: string
  name: string
  kind: string
  scope: string
  statement: string
  waypoints: { id: string; ordinal: number; name: string; landingCriteria: string }[]
  /** The declared waypoint's ordinal, or null. Null on every arc is vanilla. */
  declaredOrdinal: number | null
  /** "ep02 is declared at waypoint 2 — Ilse is found out. Land it." */
  sentence: string
}

/**
 * One note the writer will be answering, and **which of the three authorities wrote it**.
 *
 * The origin is the load-bearing part and it is why this is not a list of strings: "your round
 * 2 rejection of this draft" is Ryan's opinion of the thing being rewritten, "your note from
 * the ep02 script gate, routed here" is his opinion of THIS artifact given while he stood at a
 * later one (D21), and "a world-rules finding you dismissed in ep01" is his ruling on a check.
 * Flattened together they read as three instructions with no provenance, and Ryan cannot tell
 * from the screen whether the note he wrote five minutes ago is on the desk at all — which is
 * exactly the question the E4 drill's rejection round trip is operated to answer.
 */
export interface NoteOnTheDesk {
  note: string
  at: string
  /** The desk's own sentence, as the prompt prints it. */
  sentence: string
  /** `gate-rejection`, `routed-rejection`, or `finding-dismissal`. */
  origin: NoteOrigin['kind']
  /** What that origin IS — a different act, said as one. */
  originSentence: string
}

/**
 * One gate, whole: what was under review, the loop history, what the checks said at the spans
 * they said it about, and the three verbs.
 *
 * It extends `GateOnThePage` rather than re-composing it — the subject, the three offers, the
 * rounds, the artifact and the note refusal are all `operating.ts`'s, where they have tests.
 * What the room adds is the clustered findings, which the check bench renders for the script
 * and for nothing else (`BENCH_KIND`), so a premise-brief's and an outline's reviewers had no
 * surface at all before this.
 */
export interface GateInTheRoom extends GateOnThePage {
  runId: string
  /** The stage whose step opened it — which door Ryan came through. */
  stage: string
  /** One card per cluster, in document order, each with every reviewer's say (4.5). */
  clusters: ClusterInTheRoom[]
}

export interface ClusterInTheRoom {
  /** As the episode numbers it. Null when the finding is about the whole artifact. */
  scene: number | null
  quote: string
  from: number
  to: number
  standing: number
  worstSeverity?: FindingSeverity
  says: SayInTheRoom[]
}

/** One reviewer's say at a gate. The remediation buttons are the check bench's, not this. */
export interface SayInTheRoom extends ClusterSay {
  /**
   * Whether D12's wall is standing on this one right now — asked of the wall rather than read
   * off the finding, because "blocking" is a computation and there is no column for it.
   */
  blocking: boolean
  /** Said on the card, so a red mark at a gate never reads as a veto over the gate. */
  blockingSentence: string | null
}

// ── The room ────────────────────────────────────────────────────────────────────

export function writingRoomView(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
  llm: LLMReadiness,
): WritingRoomView | undefined {
  const where = episodeInShow(store, episodeId)
  if (!where) return undefined

  const catalogue = stageCatalogue(library)
  const spend = costOfEpisode(store, episodeId)
  // Asked once and shared by every card below: the wall is a read over live rows, and asking
  // it per finding would be the same query once per say.
  const blocking = new Set(stageBlockingFindings(store, episodeId).map((one) => one.finding.id))

  return {
    episodeId,
    label: episodeLabel(where.episode.number),
    title: where.episode.title,
    show: { id: where.show.id, title: where.show.title },
    lifecycle: where.episode.lifecycle,
    track: lifecycleTrack(where.episode.lifecycle),
    spend,
    spendSentence: spentSentence(spend),
    line: WRITE_STEP.map((step): StepInTheRoom => {
      const stage = WRITING_STAGE[stepLifecycle(step)]!
      return {
        step,
        kind: producedBy(step),
        stage,
        offer: stageOffer(store, llm, episodeId, catalogue[stage]!),
        presentStage: PRESENTING_STAGE[step],
        current: where.episode.lifecycle === stepLifecycle(step),
        desk: deskInTheRoom(store, library, episodeId, step),
      }
    }),
    at: (WRITE_STEP as readonly string[]).includes(where.episode.lifecycle)
      ? (where.episode.lifecycle as WriteStep)
      : null,
    written: writtenOnThePage(store, library, llm, catalogue, episodeId),
    gates: gatesInTheRoom(store, library, episodeId, catalogue, blocking),
    sweep: sweepOnThePage(store, episodeId),
    positions: declarePositionSection(store, where.show.id, episodeId) ?? null,
    wall: stageBlockedBecause(store, episodeId),
  }
}

/**
 * The lifecycle stop a writing step does the work of.
 *
 * The three share their names with the first three stops, and that is not a coincidence to be
 * exploited quietly — `WRITING_STAGE` is keyed by lifecycle and `WRITE_STEP` is keyed by step,
 * so something has to say they line up. It says so here, in one narrow function, rather than
 * in three call sites casting a string.
 */
const stepLifecycle = (step: WriteStep): EpisodeLifecycle => step

// ── The desk ────────────────────────────────────────────────────────────────────

/**
 * **What the writer would be handed if this stage were clicked now**, in the desk's own words.
 *
 * `composeWriteContext` is the one door onto canon for a writing step and it is the one door
 * here too (E4-0's rule, pointed at a screen): no `canonAsOf`, no `entitiesOfShow`, no query
 * of this module's own. A panel that answered "what did the writer know" from a second read
 * would agree with the writer until the day one of them learned something — and then it would
 * be showing Ryan a world no call was ever made with.
 */
function deskInTheRoom(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
  step: WriteStep,
): DeskInTheRoom {
  const desk = composeWriteContext(store, library, { episodeId, step })
  // The round the loop would call this: a round IS a version a check has read, computed off
  // `check_pass` rows every time it is asked (`correction-loop.ts`), never a column.
  const round = desk.producing === null ? 1 : historyOf(store, desk.producing).length + 1

  return {
    step,
    sentence: desk.sentence,
    upstream: {
      expected: desk.upstream.expected,
      artifactId: desk.upstream.artifact?.id ?? null,
      version: desk.upstream.artifact?.version ?? null,
      text: desk.upstream.text,
      note: desk.upstream.note,
    },
    entities: desk.entities.map((held) => ({
      id: held.entity.id,
      name: held.entity.name,
      categoryKey: held.entity.categoryKey,
      standing: held.entity.standing,
      status: held.entity.status,
      reasons: held.reasons.map((one) => ({ reason: one.reason, because: one.because })),
      facts: held.facts.map((one) => ({
        id: one.fact.id,
        statement: one.fact.statement,
        reach: one.reach,
        reachSentence: REACH[one.reach],
        inherited:
          one.inherited === null
            ? null
            : { source: one.inherited.source.name, via: one.inherited.via },
      })),
      gaps: held.gaps,
    })),
    leftOut: desk.leftOut,
    arcs: desk.arcs.map(arcOnTheDesk),
    vanilla: desk.vanilla,
    notes: desk.notes.map((note) => ({
      note: note.note,
      at: note.at,
      sentence: note.sentence,
      origin: note.origin.kind,
      originSentence: originSentence(note.origin),
    })),
    // The step's own composer, not a second one. What is passed beyond the desk is the round
    // and an empty findings list, which is exactly a fresh run's first round; a round that
    // follows a check has the reviewers' notes appended, and `promptCaveat` says so.
    prompt: composeWritePrompt(desk, { round, findings: [], ruling: [] }),
    round,
    promptCaveat: promptCaveat(desk, round),
  }
}

/**
 * What this prompt is a floor of, in words — the same shape as the reviewer count on the
 * button above it, which is an upper bound and says so (`write-step.ts`'s `offerFor`).
 *
 * A prompt is composed at the moment a round runs, and one part of it cannot exist before the
 * click: what the checks said about the draft the round before. Round 1 of a fresh run has
 * none, so the string below IS what would be sent; a later round is this plus the reviewers'
 * notes. Ryan's own notes are not in that gap — they are already on the desk above, which is
 * `write-step.ts`'s ruling that a producer reads his words off the desk and never off the loop.
 */
function promptCaveat(desk: WriteContext, round: number): string {
  const label = episodeLabel(desk.where.episode.number)
  const notes =
    desk.notes.length === 0
      ? 'You have said nothing about it yet, so there is nothing of yours in it.'
      : `Your ${desk.notes.length} note(s) are already in it, above — verbatim, each with where ` +
        'you gave it.'
  return (
    `This is the prompt for round ${round}, composed by the step’s own function rather than ` +
    `rebuilt here. ${notes} What it cannot carry before the click is the CHECKS’ notes: a ` +
    'round after a panel is this, plus what the checks said about the draft before it. ' +
    `So it is a floor on what the model writing ${label} will be handed, never a ceiling.`
  )
}

const arcOnTheDesk = (held: ArcInContext): ArcOnTheDesk => ({
  arcId: held.arc.id,
  name: held.arc.name,
  kind: held.arc.kind,
  scope: held.arc.scope,
  statement: held.arc.statement,
  waypoints: held.waypoints.map((waypoint) => ({
    id: waypoint.id,
    ordinal: waypoint.ordinal,
    name: waypoint.name,
    landingCriteria: waypoint.landingCriteria,
  })),
  declaredOrdinal: held.position?.waypoint.ordinal ?? null,
  sentence:
    held.position === null
      ? `This episode declares no position on “${held.arc.name}”. Nothing is owed here — an ` +
        'episode that touches no arc is vanilla, and not every episode advances one.'
      : `This episode is declared at waypoint ${held.position.waypoint.ordinal} — ` +
        `“${held.position.waypoint.name}”. A pin is not a landing: the landing proposal is ` +
        'raised when the script is read, and only the model writing it can say which entity ' +
        'it reads on.',
})

/**
 * The three authorities, said apart. One arm per origin, so a fourth is a compile error rather
 * than a sentence somebody forgot to write.
 */
function originSentence(origin: NoteOrigin): string {
  switch (origin.kind) {
    case 'gate-rejection': {
      // The target is printed only when it is Ryan's own word for a piece of THIS draft — a
      // scene. A depth naming another written kind was resolved to an artifact id when the
      // note landed (`domain/routing.ts`), and an id on the screen is the archaeology the HIL
      // contract forbids; when it resolved to this very artifact it says nothing anyway.
      const where =
        origin.target === null || origin.target === origin.artifactId
          ? ''
          : ` at “${origin.target}”`
      // One authority, two verbs (0015). What he did next is the difference, and it is said
      // rather than left to be inferred from a round number that did not go up.
      const act =
        origin.verdict === 'close'
          ? 'Your own note on this draft, written when you put it down at its gate — round'
          : 'Your own rejection of this draft, at its gate — round'
      return (
        `${act} ${origin.round}, ` +
        `${origin.depth === null ? 'unrouted, which is the legal default' : `routed at ${origin.depth} depth`}` +
        `${where}. It is your opinion of the thing being rewritten.`
      )
    }
    case 'routed-rejection':
      return (
        `Your note from the ${origin.fromKind} gate at round ${origin.round}, routed here at ` +
        `${origin.depth} depth — your opinion of THIS artifact, given while you were standing ` +
        `at a later one. It landed when this stood at v${origin.routedAtVersion}, and ` +
        `${
          origin.addressed
            ? 'a newer version has landed since — computed, never a flag anybody set'
            : 'nothing has answered it yet, which is why the stage that writes this is offerable'
        }.`
      )
    case 'finding-dismissal':
      return (
        `A ${origin.checkKey} finding you dismissed — your ruling on a CHECK, which is a ` +
        `different act from rejecting a draft. It quoted: “${origin.quote}”.`
      )
  }
}

// ── The gates ───────────────────────────────────────────────────────────────────

/**
 * Every gate this episode has ever had, newest first, each with what the checks said at the
 * spans they argued with.
 *
 * A ruled gate is kept and rendered, not hidden: it is the record of a decision Ryan made, and
 * reading back what he said at the premise while standing at the script is most of what a room
 * is for. `gateOnThePage` returns null for a gate whose standing has gone, which is a row
 * problem rather than a state, and those drop out.
 */
function gatesInTheRoom(
  store: Store,
  library: LibraryPaths,
  episodeId: string,
  catalogue: StageCatalogue,
  blocking: Set<string>,
): GateInTheRoom[] {
  return gatesOfEpisode(store, episodeId).flatMap((gate): GateInTheRoom[] => {
    const rendered = gateOnThePage(store, library, gate.id, catalogue)
    if (!rendered) return []

    const artifact = findArtifact(store, gate.artifactId)
    const clusters =
      artifact === undefined || rendered.artifact.text === null
        ? []
        : clusterFindings(store, artifact, rendered.artifact.text).map(
            (cluster): ClusterInTheRoom => ({
              scene: cluster.scene,
              quote: cluster.quote,
              from: cluster.from,
              to: cluster.to,
              standing: cluster.standing,
              ...(cluster.worstSeverity && { worstSeverity: cluster.worstSeverity }),
              says: cluster.says.map((say): SayInTheRoom => {
                const blocks = blocking.has(say.findingId)
                return {
                  ...say,
                  blocking: blocks,
                  blockingSentence: blocks ? BLOCKS_THE_NEXT_STAGE : null,
                }
              }),
            }),
          )

    return [
      {
        ...rendered,
        runId: gate.runId,
        stage: store.get<{ stage: string }>('SELECT stage FROM run WHERE id = ?', gate.runId)
          ?.stage ?? '',
        clusters,
      },
    ]
  })
}
