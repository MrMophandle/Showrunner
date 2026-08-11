import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  costOfEpisode,
  costOfRun,
  costOfShow,
  costsOfRun,
  FREE,
  remainingThisWeek,
  spentSentence,
  type CostEntry,
  type CostTotals,
} from './cost.ts'
import type { Store } from './db/store.ts'
import { findArtifact, type Artifact, type FreshnessStatus } from './domain/artifact.ts'
import { routedNoteSentence } from './domain/routing.ts'
import { producedBy, WRITE_STEP } from './domain/write-context.ts'
import { writtenArtifacts } from './edit.ts'
import {
  EPISODE_LIFECYCLE,
  episodeLabel,
  episodesOf,
  findEpisode,
  seasonsOf,
  shows,
  type Episode,
  type EpisodeLifecycle,
} from './domain/spine.ts'
import {
  EVENT_KIND,
  eventsOfRun,
  PROSE_KIND,
  type EventKind,
  type EventRecord,
} from './events.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import {
  closingNeedsANote,
  gateOfRun,
  gateStanding,
  NOTE_DEPTH,
  openGates,
  rejectionNeedsANote,
  type GateRound,
  type NoteDepth,
} from './runner/gate.ts'
import {
  attemptsOf,
  findRun,
  runsOfEpisode,
  stepsOf,
  type Attempt,
  type Run,
  type StepStatus,
} from './runner/run.ts'
import { stageBlockedBecause, stageBlockingFindings, type StageBlock } from './runner/stage-wall.ts'
import { stageCatalogue } from './runner/stages.ts'
import type { Stage, StageCatalogue } from './runner/step.ts'
import { PRESENTING_STAGE, SCRIPT_GATE_STAGE } from './runner/present-step.ts'
import { WRITING_STAGE } from './runner/write-step.ts'
import { sweepOnThePage, type SweepOnThePage } from './sweep.ts'

/**
 * The operating page's read model — everything the bare-bones page renders, composed
 * here, in sentences, with tests.
 *
 * ── Why the sentences live on this side ─────────────────────────────────────────
 * "Every action button states verb + object + scope + cost" and "a blocked action renders
 * disabled with the reason in words" are rules about what Ryan reads, and a rule that
 * lives in JSX is a rule with no test. So the server composes the button's sentence, the
 * reason it is blocked, and the sentence for what a run spent — and the page renders the
 * strings it was handed. The API refuses a launch with the SAME sentence the button was
 * showing, which is what makes "preconditions before the button" true rather than
 * decorative: the disabled button and the 409 cannot drift apart.
 *
 * ── This is not the floor ───────────────────────────────────────────────────────
 * The floor is E5's, built to `mockups/floor.html`, and so are the other seven screens.
 * This module is E1's scaffolding: one page, no design system, no components. What it
 * does owe the mockups is the FACTS they render — the health tile's "can this reach a
 * model right now", the lifecycle track, the cost — so that E5 finds the answers already
 * queryable and only has to make them beautiful.
 */

// ── What the page is handed ─────────────────────────────────────────────────────

/** A button, whole: what it does, what it costs, and why it cannot be pressed. */
export interface Offer {
  /** Verb + object + scope, in one sentence. Never "Run", never "Go". */
  sentence: string
  /** The cost, stated before the click. "No model call · $0.00" when there is none. */
  cost: string
  enabled: boolean
  /** Why not, in words. Null when it is enabled. */
  blockedBecause: string | null
}

export interface EpisodeOnThePage {
  id: string
  /** "ep01". */
  label: string
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  /** premise → outline → script → assets → assembled → published, and where this stands. */
  track: LifecycleStop[]
  spend: CostTotals
  spendSentence: string
  /** The newest run on this episode, whatever its state, or null if there has never been one. */
  run: RunOnThePage | null
  launch: Offer
  /**
   * The stage `launch` starts. Handed over rather than known by the page, so the one place
   * that names a stage is the catalogue — a browser holding its own copy of a stage name
   * is a browser that can ask for a stage this build does not have.
   */
  launchStage: string
  /** Every written artifact this episode has, with its freshness and both of Ryan's doors. */
  artifacts: WrittenOnThePage[]
  /**
   * **The completion sweep this episode still owes, or null when it owes none** (E4-6, 1.2).
   *
   * Derived from the proposals riding it, both ways: the sentence appears when something rides
   * and disappears when nothing does. There is no `swept_at` column and no sweep table — the
   * pass is a standing obligation computed from the queue, and `sweep.ts` argues why it stands
   * OWED after the approval rather than inside the gate that gave it.
   */
  sweep: SweepOnThePage | null
}

/**
 * **One written artifact, with the two doors the refusal names** (E4-5, #65).
 *
 * A writing stage refuses an episode that already has its artifact with "rule on it at its
 * gate, or edit it directly", and until E4-5 neither door was on the card that sentence
 * appears on: E4-3 built the presenting stages and nothing offered them, and the edit did not
 * exist. Both are here now, beside the refusal, per artifact — because a sentence in this app
 * may not point at a door Ryan cannot open.
 *
 * The freshness sentence rides with them for the same reason (5.2): "built from a draft the
 * outline has moved past" is the answer to why he might want either door, and it is computed
 * off the edges every time it is asked (1.3).
 */
export interface WrittenOnThePage {
  id: string
  kind: string
  slot: string
  version: number
  filePath: string | null
  status: FreshnessStatus
  /** Why it is stale, in one sentence. Null when it is not. */
  staleBecause: string | null
  /** Notes routed here from another gate that nothing has answered yet (D21). */
  standing: { note: string; sentence: string }[]
  /** Type it over yourself. Free, verbatim, and one motion (`edit.ts`). */
  edit: Offer
  /** Put it in front of yourself for a ruling. Free, never walled (`present-step.ts`). */
  present: Offer
  presentStage: string
}

export interface LifecycleStop {
  stage: EpisodeLifecycle
  /** Reached: this episode is here or past here. */
  reached: boolean
  current: boolean
}

export interface RunOnThePage {
  id: string
  stage: string
  status: Run['status']
  /** "write-the-premise — waiting on your ruling", "… — finished". The run in one line. */
  sentence: string
  /** Set while a gate on this run is open, so the page can go straight to the ruling. */
  openGateId: string | null
}

export interface ShowOnThePage {
  id: string
  key: string
  title: string
  spend: CostTotals
  spendSentence: string
  /** "$0.02 spent since Monday — no weekly budget set". */
  budgetSentence: string
  episodes: EpisodeOnThePage[]
}

export interface OperatingView {
  library: LibraryPaths
  /** Can this process reach a model right now — the floor's first tile, in plain words. */
  llm: LLMReadiness
  shows: ShowOnThePage[]
  /** What to do about an empty library, or null when there is something to operate. */
  emptyBecause: string | null
  /**
   * What the event stream will send. SSE dispatches by event NAME, so a browser has to
   * name every kind it wants to hear — and a second copy of a twenty-one-string list
   * living in the page is a list that drifts, which is the complaint events.ts already
   * makes about its own two. It is handed over instead.
   */
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[] }
}

// ── The page ────────────────────────────────────────────────────────────────────

export function operatingView(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
): OperatingView {
  const waiting = new Map(openGates(store).map((open) => [open.gate.runId, open.gate.id]))
  // Built once for the page rather than per episode: it is a plain object of TypeScript
  // functions, and the sentences on every button below come out of the stages themselves.
  const catalogue = stageCatalogue(library)

  const onThePage = shows(store).map((show): ShowOnThePage => {
    const episodes = seasonsOf(store, show.id).flatMap((season) =>
      episodesOf(store, season.id).map((episode) => {
        const run = runsOfEpisode(store, episode.id)[0]
        const spend = costOfEpisode(store, episode.id)
        // **The stage the episode's lifecycle is at** — closed here by E4-3, once, for all
        // three writing stages (see `stageForEpisode`).
        const stage = stageForEpisode(episode)
        return {
          id: episode.id,
          label: episodeLabel(episode.number),
          number: episode.number,
          title: episode.title,
          lifecycle: episode.lifecycle,
          track: lifecycleTrack(episode.lifecycle),
          spend,
          spendSentence: spentSentence(spend),
          run: run ? runOnThePage(run, waiting.get(run.id) ?? null) : null,
          launch: stageOffer(store, llm, episode.id, catalogue[stage]!),
          launchStage: stage,
          artifacts: writtenOnThePage(store, library, llm, catalogue, episode.id),
          sweep: sweepOnThePage(store, episode.id),
        }
      }),
    )
    const spend = costOfShow(store, show.id)
    return {
      id: show.id,
      key: show.key,
      title: show.title,
      spend,
      spendSentence: spentSentence(spend),
      budgetSentence: remainingThisWeek(store, show.id).sentence,
      episodes,
    }
  })

  return {
    library,
    llm,
    shows: onThePage,
    emptyBecause:
      onThePage.length === 0
        ? 'This library has no shows in it yet. Run `npm run fixture:load` to seed Grey ' +
          'Harbor — it spends nothing, generates nothing, and is safe to run twice.'
        : null,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND },
  }
}

/**
 * **Which stage an episode's card offers** — the map E4-2 could not close, closed (E4-3, #62).
 *
 * The lifecycle names the stage an episode is AT, meaning the work it still owes
 * (`domain/lifecycle.ts`), so the honest offer is the stage that does that work. For the three
 * writing stops there is one, and `WRITING_STAGE` is the whole map: premise → outline → script,
 * done once rather than by special-casing two of them. E1's single `demo` button and E4-1's
 * single premise button were both this question answered with a constant.
 *
 * **Past the writing line there is no producer in this build**, and that is stated rather than
 * papered over: an episode at `assets` is waiting on E6, and the one thing this app can still
 * honestly do with it is put its script in front of Ryan again — free, never walled, and a
 * ruling he may make at any time (`present-step.ts`). A card that offered nothing at all would
 * be a screen with a hole in it, and a card that offered a stage with no code behind it would
 * be a button promising work nothing is going to do. E6 replaces the tail with its own stages
 * by adding them to the map.
 *
 * **This is the map, not the card.** E5 owns how it renders (D24); what lives here is which
 * stage is behind the button, because the button's sentence, its cost and its refusal all come
 * off that stage's own declaration (step.ts) and are already tested where they are written.
 */
export function stageForEpisode(episode: Episode): string {
  return WRITING_STAGE[episode.lifecycle] ?? SCRIPT_GATE_STAGE
}

/**
 * Every written artifact of this episode, with its freshness and Ryan's two doors onto it.
 *
 * The edit door and its sentences are `edit.ts`'s, where they have tests; the presenting door
 * is a STAGE, so its offer comes off `stage.offerOn` like every other button in this app and
 * `stageOffer` adds the same preconditions it adds to a launch — a run already holding the
 * episode refuses both doors with one sentence, which is D7 said once (`launchBlockedBecause`).
 *
 * **Exported for the writing room** (E4-7), which renders the same three artifacts beside the
 * stage that writes each one. One composer, two readers: a second list of doors would be the
 * one that quietly dropped the freshness sentence beside them.
 */
export function writtenOnThePage(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  catalogue: StageCatalogue,
  episodeId: string,
): WrittenOnThePage[] {
  return writtenArtifacts(store, library, episodeId).map((written) => {
    const step = WRITE_STEP.find((one) => producedBy(one) === written.artifact.kind)!
    const stage = PRESENTING_STAGE[step]
    return {
      id: written.artifact.id,
      kind: written.artifact.kind,
      slot: written.artifact.slot,
      version: written.artifact.version,
      filePath: written.artifact.filePath,
      status: written.status,
      staleBecause: written.staleBecause,
      standing: written.standing.map((note) => ({
        note: note.note,
        sentence: routedNoteSentence([note], subject(store, episodeId, written.artifact.kind)),
      })),
      edit: written.edit,
      present: stageOffer(store, llm, episodeId, catalogue[stage]!),
      presentStage: stage,
    }
  })
}

/** "the ep01 outline" — what a routed note's sentence is about. */
const subject = (store: Store, episodeId: string, kind: string): string =>
  `the ${episodeLabel(findEpisode(store, episodeId)?.number ?? 0)} ${kind}`

/** premise → … → published, with where this episode stands on it. */
export function lifecycleTrack(lifecycle: EpisodeLifecycle): LifecycleStop[] {
  const at = EPISODE_LIFECYCLE.indexOf(lifecycle)
  return EPISODE_LIFECYCLE.map((stage, index) => ({
    stage,
    reached: index <= at,
    current: index === at,
  }))
}

// ── The launch button, and the preconditions in front of it ─────────────────────

/**
 * One stage's button for one episode: the sentence, the cost, and — when it cannot be
 * pressed — the reason, in words, before the click rather than as a failure after it.
 *
 * **The stage composes the first two and this composes the third.** Verb, object, scope and
 * cost come off `stage.offerOn` (step.ts), written where the stage is; what this adds is
 * whether Ryan may press it, which is about the episode's state and the process's rather than
 * about the stage. The API calls the same refusal, so the disabled button and the 409 can
 * never be telling him two different stories.
 */
export function stageOffer(
  store: Store,
  llm: LLMReadiness,
  episodeId: string,
  stage: Stage,
): Offer {
  const episode = findEpisode(store, episodeId)
  if (!episode) {
    return {
      sentence: `The ${stage.name} stage — there is nothing here to run it on`,
      cost: 'Nothing to cost: this episode is not in the library.',
      enabled: false,
      blockedBecause: `There is no episode ${episodeId} in this library.`,
    }
  }

  const declared = stage.offerOn(store, episode)
  const blocked = launchBlockedBecause(store, llm, episodeId, stage)
  return {
    sentence: declared.sentence,
    // Stated even when it is blocked: what it would have cost is not a secret, and a button
    // whose cost appears only once it is pressable teaches nothing about the one greyed out
    // beside it. Whose money and when is appended exactly where a call will be made — a free
    // stage that said "spent when you click" would be charging for a reading of rows.
    cost: declared.callsModel
      ? `${declared.cost} · your money, spent when you click`
      : declared.cost,
    enabled: blocked === null,
    blockedBecause: blocked,
  }
}

/**
 * Why this stage cannot be started on this episode, in the words the button shows and the
 * API refuses with. Null when it can.
 *
 * The order is from the most specific to the least, and every step of it is a different
 * question:
 *
 *   1. **An unfinished run** — the one state that is true whatever the stage and whatever the
 *      adapter is doing. One run per episode (D7).
 *   2. **The stage's own precondition**, off its declaration: an episode with no script to
 *      check, a board that has never been built. It comes before the wall because a stage with
 *      nothing to do has nothing to be blocked from doing.
 *   3. **D12's wall**, and only in front of a stage that PRODUCES (step.ts, `STAGE_WORK`).
 *      Computed fresh off open findings every time this is asked (`stage-wall.ts`). Refusing a
 *      stage that only reads would refuse the way out of the wall — the wall's own sentence
 *      recommends re-running the checks — and refusing the gate stage would be a deterministic
 *      finding blocking Ryan's gate, which is precisely what D12 forbids.
 *   4. **The adapter**, and only for a stage that DECLARED IT SPENDS. This is E3-1's deferred
 *      defect, mended: until a stage could say what it costs, this refusal was true of every
 *      stage because every stage called a model, and the first free one was told "Nothing to
 *      call" about a call it never makes. The fix consults the declaration and enumerates no
 *      stage names — a list of exemptions here would be right today and wrong the day after
 *      somebody adds a stage without reading this paragraph.
 */
export function launchBlockedBecause(
  store: Store,
  llm: LLMReadiness,
  episodeId: string,
  stage: Stage,
): string | null {
  const episode = findEpisode(store, episodeId)
  if (!episode) return `There is no episode ${episodeId} in this library.`
  const label = episodeLabel(episode.number)

  const busy = runsOfEpisode(store, episodeId).find((run) =>
    ['queued', 'running', 'paused'].includes(run.status),
  )
  if (busy) {
    const doing =
      busy.status === 'paused'
        ? `is waiting on your ruling — ${busy.pauseReason ?? 'a gate is open'}`
        : `is ${busy.status}`
    return `${label} already has a ${busy.stage} run, and it ${doing}. One run per episode (D7): rule on it, or let it finish.`
  }

  const declared = stage.offerOn(store, episode)
  if (declared.nothingToDoBecause !== null) return declared.nothingToDoBecause

  if (stage.work === 'produces') {
    const wall = stageBlockedBecause(store, episodeId)
    if (wall) return wall
  }

  if (declared.callsModel && !llm.ready) {
    // The adapter's own sentence is quoted whole, never re-cased: it opens with the name
    // of an environment variable often enough that lowering its first letter would print
    // `aNTHROPIC_API_KEY` at Ryan and send him looking for a variable that does not exist.
    return `Nothing to call. ${llm.label} was chosen (${llm.chosenBy}) — ${llm.sentence}`
  }
  return null
}

/**
 * The stage by that name, or undefined — the one lookup between a string off the wire and the
 * TypeScript that is the stage.
 *
 * It is here rather than in the API because the refusal above takes a `Stage`, and a caller
 * holding a name needs somewhere honest to turn it into one. `stageCatalogue` is the map
 * (stages.ts); this is a reader of it that says nothing about what a stage is.
 */
export function findStage(library: LibraryPaths, name: string): Stage | undefined {
  return stageCatalogue(library)[name]
}

/** Every stage whose work is READING the episode's material — the check bench's buttons. */
export function readingStages(catalogue: StageCatalogue): Stage[] {
  return Object.values(catalogue).filter((stage) => stage.work === 'reads')
}

// ── One run, in full ────────────────────────────────────────────────────────────

export interface StepOnThePage {
  id: string
  name: string
  status: StepStatus
  lock: string | null
  waitingOn: string | null
  failure: string | null
  /** Every attempt, kept — the loop history a spent retry budget hands to Ryan. */
  attempts: Attempt[]
}

/** The artifact under a gate, rendered — never a filename (D15, 4.6). */
export interface ArtifactUnderReview {
  id: string
  kind: string
  slot: string
  version: number
  filePath: string | null
  /** The artifact itself, read off the volume. Null only when there is nothing to read. */
  text: string | null
  /** Why there is no text, when there is none. */
  note: string | null
}

export interface GateOnThePage {
  id: string
  /** "the ep01 premise-brief demo" — what is under review, in Ryan's words. */
  subject: string
  round: number
  isOpen: boolean
  rounds: GateRound[]
  artifact: ArtifactUnderReview
  approve: Offer
  /**
   * Approve OVER what is standing on it, recorded as itself forever (invariant 3) — and the
   * one verdict that takes D12's wall down (`stage-wall.ts`).
   *
   * A third button rather than a checkbox on the first, because they are two different
   * sentences in the ledger and must stay two on the screen: "he approved" and "he approved
   * over a contradiction the board is certain about" are not the same ruling, and a season
   * later the difference is the whole record.
   */
  override: Offer
  reject: Offer
  /**
   * **Put the draft down** (E5-3, #83) — the run ends, the note stands, the episode is free.
   *
   * A fourth button rather than a checkbox on the rejection, for `override`'s own reason one
   * paragraph up: "he rejected it and the step reopens" and "he stopped, and nothing is going
   * to happen until he asks" are two rulings and two rows, and a season later the difference
   * is the whole record (0015).
   */
  close: Offer
  /** How deep a rejection note may route the work back (D21). Empty is the legal default. */
  noteDepths: readonly NoteDepth[]
  /**
   * **Why the rejection is disabled while the note box is empty**, in the words the API
   * refuses with (E4-7, `runner/gate.ts`).
   *
   * The note lives in a textarea this process has never seen, so the precondition is the
   * page's to apply — but never the page's to WORD. It came down the wire until E4-7 in three
   * different wordings, one per surface, which is the drift `refusals` exists on every other
   * bench to prevent (`CHECK_REFUSALS`, `BENCH_REFUSALS`).
   */
  rejectNeedsNote: string
  /**
   * The same rule for the fourth verb, in ITS own words (E5-3, `runner/gate.ts`). A close
   * reopens nothing, so its note is not "what the step writes against" but the whole record
   * of why he stopped — a different reason, and therefore a different sentence rather than
   * the rejection's with a word swapped.
   */
  closeNeedsNote: string
}

export interface RunView {
  run: Run
  /** "demo on ep01 — waiting on your ruling". */
  sentence: string
  steps: StepOnThePage[]
  /** Everything about this run in order, prose and transitions alike. */
  events: EventRecord[]
  spend: { totals: CostTotals; sentence: string; entries: CostEntry[] }
  /** The gate this run's step opened, if it ever opened one. */
  gate: GateOnThePage | null
}

export function runView(store: Store, library: LibraryPaths, runId: string): RunView | undefined {
  const run = findRun(store, runId)
  if (!run) return undefined

  const steps = stepsOf(store, runId)
  const totals = costOfRun(store, runId)
  const gate = gateOfRun(store, runId)

  return {
    run,
    sentence: runSentence(store, run),
    steps: steps.map((step) => ({
      id: step.id,
      name: step.name,
      status: step.status,
      lock: step.lock,
      waitingOn: step.waitingOn,
      failure: step.failure,
      attempts: attemptsOf(store, step.id),
    })),
    events: eventsOfRun(store, runId),
    spend: { totals, sentence: spentSentence(totals), entries: costsOfRun(store, runId) },
    gate: gate ? gateOnThePage(store, library, gate.id, stageCatalogue(library)) : null,
  }
}

/**
 * The gate, whole: what is under review, the four verdicts, and their costs.
 *
 * **None of the four takes a precondition on the artifact's account.** The only thing that
 * closes them is a round already ruled — checks argue and never veto (invariant 3), and D12
 * lets a deterministic finding block the next stage and never this. What the standing findings
 * DO reach is the override's sentence, which names what he would be ruling over: a verb that
 * records something forever should say what it is recording.
 *
 * The rejection's cost comes off the STAGE's declaration (step.ts) rather than off a constant,
 * because a rejection buys another run of the step that opened this gate — a call and a panel
 * for the premise writer, nothing at all for the stage that only presents what stands. A single
 * hardcoded number here was right while `demo` was the only stage with a gate and would have
 * quietly charged Ryan for a re-presentation the day a second one arrived.
 *
 * **A gate whose stage this build no longer has still renders.** `demo` was retired in E4-1 and
 * its gates are still in Ryan's library; the catalogue lookup misses, `again` is null, and the
 * three verdicts come back with the free cost rather than a guess. Rows are records — a stage
 * leaving the catalogue may not take its history off the screen.
 *
 * **Exported for the writing room** (E4-7), which is its second reader. What a gate IS, what
 * the three verbs would do and why one is refused are one answer wherever Ryan is standing —
 * the same rule `proposalOnTheBench` keeps for the sweep and `draftsUnderReview` for a gate's
 * payload. The room adds the findings clustered at their spans and renders the same three
 * offers; it composes none of them.
 */
export function gateOnThePage(
  store: Store,
  library: LibraryPaths,
  gateId: string,
  catalogue: StageCatalogue,
): GateOnThePage | null {
  const standing = gateStanding(store, gateId)
  if (!standing) return null

  const artifact = findArtifact(store, standing.gate.artifactId)
  const stepName = store.get<{ name: string }>(
    'SELECT name FROM step WHERE id = ?',
    standing.gate.stepId,
  )!.name

  const ruled = standing.isOpen
    ? null
    : `Round ${standing.round} was already ruled "${standing.ruling!.verdict}". A later opinion is a later round.`
  const blocking = stageBlockingFindings(store, standing.gate.episodeId).filter(
    (block) => block.artifact.id === standing.gate.artifactId,
  )
  const stage = catalogue[findRun(store, standing.gate.runId)?.stage ?? '']
  const episode = findEpisode(store, standing.gate.episodeId)
  const again = stage && episode ? stage.offerOn(store, episode) : null

  return {
    id: standing.gate.id,
    subject: standing.subject,
    round: standing.round,
    isOpen: standing.isOpen,
    rounds: standing.rounds,
    artifact: read(library, artifact),
    approve: {
      sentence: `Approve ${standing.subject} — round ${standing.round}, and ${stepName} carries the run on`,
      cost: FREE,
      enabled: standing.isOpen,
      blockedBecause: ruled,
    },
    override: {
      sentence:
        `Approve ${standing.subject} OVER ${overSentence(blocking)} — round ${standing.round}, ` +
        'recorded as your override forever, and the next stage stops being refused on it',
      cost: FREE,
      enabled: standing.isOpen,
      blockedBecause: ruled,
    },
    reject: {
      // What the step will actually DO comes off the stage's declared work, never off a
      // guess: a stage that produces writes it again against the notes, and a stage that only
      // presents re-presents it with them recorded. Saying "writes it again" over a gate with
      // no writer behind it would be the button promising work nothing is going to do — which
      // is also why a RETIRED stage gets its own clause rather than the producer's. E4-1 took
      // `demo` out of the catalogue and left its gates in the library, and a rejection there
      // is a note on the record with nothing left to route it to.
      sentence:
        `Reject ${standing.subject} with notes — ${stepName} reopens as round ${standing.round + 1} ` +
        (stage === undefined
          ? 'if it can: this build has no code for the stage that opened this gate, so the ' +
            'notes are recorded against the round and nothing is rewritten'
          : stage.work === 'reads'
            ? 'and presents it again with them recorded against it; there is no writer behind ' +
              'this gate to route them to yet, so the notes land and ride (D21)'
            : 'and writes it again against them') +
        // The other half of D21, on the same button (E4-5): a note that names another written
        // artifact is not this producer's to answer, so nothing here is rewritten at all and
        // the work turns up as an offer where it belongs (`domain/routing.ts`).
        '. But a note you route to another artifact lands there instead — nothing here is ' +
        'rewritten, and the stage that writes it becomes offerable with your note on it (D21)',
      cost: again === null || !again.callsModel ? FREE : `${again.cost} · your money, spent when you click`,
      enabled: standing.isOpen,
      blockedBecause: ruled,
    },
    close: {
      // **The verb the E4 ledger asked for, said as a consequence** (E5-3, #83). It names what
      // ends, what is free afterwards, and what the note does — because "close" on its own is
      // the generic verb the UI rules forbid, and because what Ryan needs to know before he
      // presses it is that nothing regenerates and nothing is lost.
      sentence:
        `Put ${standing.subject} down with your note — ${stepName} ends here, ` +
        `${episode ? episodeLabel(episode.number) : 'this episode'} is free the moment you ` +
        'click, and your note stands against the draft until something answers it',
      // Nothing is re-run and nothing is re-read, whatever the stage behind this gate does. A
      // close is the one verdict whose price is the same at every gate in the app.
      cost: FREE,
      enabled: standing.isOpen,
      blockedBecause: ruled,
    },
    noteDepths: NOTE_DEPTH,
    rejectNeedsNote: rejectionNeedsANote(standing.subject),
    closeNeedsNote: closingNeedsANote(standing.subject),
  }
}

/** What an override would be standing over, named out of the rows rather than counted. */
function overSentence(blocking: StageBlock[]): string {
  if (blocking.length === 0) {
    return 'whatever stands on it — nothing deterministic does right now, so this records the same decision as approving, in the louder word'
  }
  const [first, ...rest] = blocking
  const where = first!.scene === null ? '' : ` at scene ${first!.scene}`
  const others =
    rest.length === 0 ? '' : ` and ${rest.length} more deterministic finding${rest.length === 1 ? '' : 's'}`
  return `the ${first!.finding.checkKey} finding${where}${others}`
}

/**
 * The artifact, off the volume. A gate always renders its artifact, so this reads the file
 * rather than handing over its path — and when there is nothing to read it says which of
 * the two reasons it is, because "no premise here" and "the volume is not mounted" are
 * very different pieces of news.
 *
 * The path comes off the artifact ROW, never off the request. Nothing a browser sends
 * chooses which file this process opens.
 */
function read(library: LibraryPaths, artifact: Artifact | undefined): ArtifactUnderReview {
  if (!artifact) {
    return {
      id: '',
      kind: '',
      slot: '',
      version: 0,
      filePath: null,
      text: null,
      note: 'The gate points at an artifact that is no longer in the library.',
    }
  }
  const common = {
    id: artifact.id,
    kind: artifact.kind,
    slot: artifact.slot,
    version: artifact.version,
    filePath: artifact.filePath,
  }
  if (artifact.filePath === null) {
    return { ...common, text: null, note: 'This artifact has been recorded but not produced yet.' }
  }
  try {
    return { ...common, text: readFileSync(join(library.artifactDir, artifact.filePath), 'utf8'), note: null }
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

// ── Sentences ───────────────────────────────────────────────────────────────────

function runOnThePage(run: Run, openGateId: string | null): RunOnThePage {
  return {
    id: run.id,
    stage: run.stage,
    status: run.status,
    sentence: statusSentence(run),
    openGateId,
  }
}

function runSentence(store: Store, run: Run): string {
  const episode = findEpisode(store, run.episodeId)
  const where = episode ? ` on ${episodeLabel(episode.number)}` : ''
  return `${run.stage}${where} — ${lowerFirst(statusSentence(run))}`
}

function statusSentence(run: Run): string {
  switch (run.status) {
    case 'queued':
      return 'Queued — it starts when its episode is free'
    case 'running':
      return 'Running'
    case 'paused':
      return `Waiting on your ruling — ${run.pauseReason ?? 'a gate is open'}`
    case 'done':
      return 'Finished'
    case 'failed':
      return `Failed — ${run.failure ?? 'no reason recorded'}`
  }
}

/**
 * Lowercases a leading capital so a sentence can be folded into a longer one — and leaves
 * an all-caps opening alone, because `ANTHROPIC_API_KEY` is a real name and
 * `aNTHROPIC_API_KEY` is a wild goose chase.
 */
const lowerFirst = (text: string): string =>
  /^[A-Z][A-Z0-9_]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1)
