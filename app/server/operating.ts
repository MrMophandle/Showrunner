import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  costOfEpisode,
  costOfRun,
  costOfShow,
  costsOfRun,
  remainingThisWeek,
  spentSentence,
  type CostEntry,
  type CostTotals,
} from './cost.ts'
import type { Store } from './db/store.ts'
import { findArtifact, type Artifact } from './domain/artifact.ts'
import {
  EPISODE_LIFECYCLE,
  episodeLabel,
  episodesOf,
  findEpisode,
  seasonsOf,
  shows,
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
  gateOfRun,
  gateStanding,
  NOTE_DEPTH,
  openGates,
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
import { DEMO_CALL, DEMO_STAGE } from './runner/stages.ts'

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
  /** "demo — waiting on your ruling", "demo — finished". The run in one line. */
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

  const onThePage = shows(store).map((show): ShowOnThePage => {
    const episodes = seasonsOf(store, show.id).flatMap((season) =>
      episodesOf(store, season.id).map((episode) => {
        const run = runsOfEpisode(store, episode.id)[0]
        const spend = costOfEpisode(store, episode.id)
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
          launch: launchOffer(store, llm, episode.id),
          launchStage: DEMO_STAGE,
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
 * The demo run's button for one episode: the sentence, the cost, and — when it cannot be
 * pressed — the reason, in words, before the click rather than as a failure after it.
 *
 * The API calls this too. One composer, so the disabled button and the refusal can never
 * be telling Ryan two different stories.
 */
export function launchOffer(store: Store, llm: LLMReadiness, episodeId: string): Offer {
  const episode = findEpisode(store, episodeId)
  if (!episode) {
    return {
      sentence: 'Write a demo premise — no such episode',
      cost: DEMO_CALL.sentence,
      enabled: false,
      blockedBecause: `There is no episode ${episodeId} in this library.`,
    }
  }
  const label = episodeLabel(episode.number)
  const blocked = launchBlockedBecause(store, llm, episodeId)

  return {
    sentence:
      `Write the ${label} demo premise and present it for your ruling — ` +
      `“${episode.title}”, one call, one gate`,
    // Stated even when it is blocked: what it would have cost is not a secret, and a
    // button whose cost appears only once it is pressable teaches nothing about the one
    // that is greyed out beside it.
    cost: `${DEMO_CALL.sentence} · your money, spent when you click`,
    enabled: blocked === null,
    blockedBecause: blocked,
  }
}

/**
 * Why the demo cannot be launched on this episode, in the words the button shows and the
 * API refuses with. Null when it can.
 *
 * The unfinished run is checked first: it is the more specific state, and it is the one
 * that is true even when the adapter is healthy. The adapter comes second because the
 * page says that once, loudly, at the top, in its own line.
 */
export function launchBlockedBecause(
  store: Store,
  llm: LLMReadiness,
  episodeId: string,
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

  if (!llm.ready) {
    // The adapter's own sentence is quoted whole, never re-cased: it opens with the name
    // of an environment variable often enough that lowering its first letter would print
    // `aNTHROPIC_API_KEY` at Ryan and send him looking for a variable that does not exist.
    return `Nothing to call. ${llm.label} was chosen (${llm.chosenBy}) — ${llm.sentence}`
  }
  return null
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
  reject: Offer
  /** How deep a rejection note may route the work back (D21). Empty is the legal default. */
  noteDepths: readonly NoteDepth[]
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
    gate: gate ? gateOnThePage(store, library, gate.id) : null,
  }
}

function gateOnThePage(
  store: Store,
  library: LibraryPaths,
  gateId: string,
): GateOnThePage | null {
  const standing = gateStanding(store, gateId)
  if (!standing) return null

  const artifact = findArtifact(store, standing.gate.artifactId)
  const stepName = store.get<{ name: string }>(
    'SELECT name FROM step WHERE id = ?',
    standing.gate.stepId,
  )!.name

  return {
    id: standing.gate.id,
    subject: standing.subject,
    round: standing.round,
    isOpen: standing.isOpen,
    rounds: standing.rounds,
    artifact: read(library, artifact),
    approve: {
      sentence: `Approve ${standing.subject} — round ${standing.round}, and ${stepName} carries the run on`,
      cost: 'No model call · $0.00',
      enabled: standing.isOpen,
      blockedBecause: standing.isOpen
        ? null
        : `Round ${standing.round} was already ruled "${standing.ruling!.verdict}". A later opinion is a later round.`,
    },
    reject: {
      sentence:
        `Reject ${standing.subject} with notes — ${stepName} reopens as round ${standing.round + 1} ` +
        'and writes it again against them',
      cost: `${DEMO_CALL.sentence} · your money, spent when you click`,
      enabled: standing.isOpen,
      blockedBecause: standing.isOpen
        ? null
        : `Round ${standing.round} was already ruled "${standing.ruling!.verdict}". A later opinion is a later round.`,
    },
    noteDepths: NOTE_DEPTH,
  }
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
