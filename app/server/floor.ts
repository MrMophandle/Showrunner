import { statfsSync } from 'node:fs'
import {
  costOfEpisode,
  costOfShow,
  FREE,
  money,
  remainingThisWeek,
  spentSentence,
  type CostTotals,
} from './cost.ts'
import { destinationsOf, type Destination } from './cockpit.ts'
import type { Store } from './db/store.ts'
import { findArtifact, artifactsOf } from './domain/artifact.ts'
import { isVanilla, positionsOf } from './domain/arc.ts'
import { sweepEpisode } from './domain/episode-canon.ts'
import { findingsIn } from './domain/finding.ts'
import {
  EPISODE_LIFECYCLE,
  episodeLabel,
  episodesOf,
  seasonsOf,
  shows,
  type Episode,
  type EpisodeLifecycle,
} from './domain/spine.ts'
import { EVENT_KIND, latestSeq, PROSE_KIND, proseOfRun, type EventKind } from './events.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { openGates, type OpenGate } from './runner/gate.ts'
import {
  lockHolders,
  queuedBehind,
  runsOfEpisode,
  stepsOf,
  waitingOn,
  type Run,
} from './runner/run.ts'
import { firstSentence, stageBlockedBecause, stageBlockingFindings } from './runner/stage-wall.ts'
import { stageCatalogue } from './runner/stages.ts'
import { stageForEpisode, stageOffer, type Offer } from './operating.ts'
import { sweepOnThePage } from './sweep.ts'

/**
 * **The floor** (E5-1, #81; 5.1) — the home screen's read, composed here in sentences.
 *
 * The floor's whole job is that the app always knows what needs Ryan and brings it to him.
 * Everything below is a READ over rows four epics already write: gates, findings, riders,
 * runs, locks, costs. Nothing here starts work, rules anything, or remembers a state — and
 * every number cites the record it came out of, in the comment beside it.
 *
 * ── The qualifying rule, which is the one sentence with a long shadow ────────────
 *
 * **A record earns a needs-you card when it is holding work still or standing owed —
 * a run parked on a ruling, a stage refused by the wall, a pass an approved episode
 * owes — and never when it is merely available to act on, which is presence rather than
 * alarm.**
 *
 * Three things qualify today and the rule says why each does:
 *
 *   * **An open gate** holds work still. A run is paused on it and the only thing in this
 *     app that resumes one is Ryan's ruling (`runner/gate.ts`). Nothing else can move it.
 *   * **A standing wall** holds work still. A deterministic finding refuses the next stage
 *     until it is resolved (D12, `runner/stage-wall.ts`), and all three ways down from it
 *     are his: override at the gate, dismiss with a note, or fix and re-check.
 *   * **An owed completion sweep** stands owed. The script was approved, extraction landed
 *     its claims, and the pass those riders are due is an obligation that episode incurred
 *     and nobody else can discharge (`sweep.ts`). It walls nothing, and it is still owed.
 *
 * And the thing that deliberately does NOT: **the canon queue**. A proposal raised at the
 * bench, or a founding sheet, rides nothing and blocks nothing; it is rulable at Ryan's
 * leisure, whenever he opens the library. The mockup renders the queue as presence rather
 * than alarm and this follows it — a floor that shouted about every rulable row would teach
 * him to stop reading the loud part, which costs more than it saves.
 *
 * **What E6 inherits from that sentence.** Seven stills waiting at the review desk are
 * *owed* — the episode cannot be assembled until Ryan's eye has been over them, one at a
 * time — so they qualify, and they join by composing a `NeedsYouCard` here rather than by
 * inventing a second loud region. A generation that merely *could* be re-rolled does not
 * qualify, because nothing is waiting on it. The test is not "is this interesting" but
 * "has something stopped, or does something stand owed, until he acts".
 *
 * ── One card per act ────────────────────────────────────────────────────────────
 *
 * A wall standing on an episode that ALSO has an open gate is said inside that gate's card
 * rather than beside it, because both are discharged in the same room by the same act — the
 * mockup does exactly this ("blocks the assets stage until resolved, your gate stays open").
 * Two cards for one decision would be two places to click for one ruling. A wall with no
 * open gate on its episode raises its own card, because then nothing else is going to
 * mention it.
 *
 * ── Every card names where the act happens, and what stands there today ─────────
 *
 * The room, its address and its "not built yet" all come off `cockpit.ts` — the same data
 * the shell draws its doors from — so a card can never point at a room the bar does not
 * have, and can never claim a room is built when it is a stub. A stub link is honest: it
 * lands on a screen that names the issue that fills it and points at the page where the
 * mechanism still works.
 *
 * ── What this module refuses to render ──────────────────────────────────────────
 *
 * **A dial over a mechanism that does not exist.** The mockup's health strip draws a budget
 * meter. `show_budget` and `remainingThisWeek` have existed since 0005 — the store and the
 * reader are real — but **nothing in this build ever sets a budget**: there is no route, no
 * button, and no fixture row, so every library in the world reads back "no weekly budget
 * set". So the meter is rendered when, and only when, a row exists, and the tile otherwise
 * says what was spent and that no cap stands against it (#88 adds the door). A bar drawn
 * against a cap nobody set would be the exact lie this app refuses everywhere else.
 */

// ── What the screen is handed ───────────────────────────────────────────────────

/** A section's name and the same thing in Ryan's words. `SectionHeader` refuses one without. */
export interface FloorHeading {
  name: string
  explains: string
}

/**
 * How a health tile reads at a glance. `not-built` is its own standing rather than a bad
 * `unknown`: "E6 has not built the GPU worker" and "the volume would not answer" are very
 * different pieces of news, and a screen that painted them the same colour would be
 * inventing an outage (invariant 4).
 */
export const HEALTH_STANDING = ['good', 'attention', 'unknown', 'not-built'] as const
export type HealthStanding = (typeof HEALTH_STANDING)[number]

export interface HealthTile {
  /** Stable id — the screen keys and tests address a tile by this, never by its label. */
  id: string
  /** "Claude adapter", "Library volume". */
  label: string
  /** The reading itself, short enough to glance at. */
  value: string
  /** Why, in one line. Never blank. */
  sub: string
  /** The whole of it, for a pointer and a reader, when `sub` had to be the short half. */
  detail: string
  standing: HealthStanding
  /**
   * A bar, and ONLY over a number somebody actually set. Null is the normal case and it is
   * not a gap — it means no cap is recorded, which the sentence says in words.
   */
  meter: { filled: number; sentence: string } | null
}

/**
 * The kinds of card, which are the qualifying rule enumerated. A const array and a union,
 * never a TS `enum` — the server runs under type stripping, which only erases.
 */
export const NEEDS_YOU_KIND = ['gate', 'wall', 'sweep'] as const
export type NeedsYouKind = (typeof NEEDS_YOU_KIND)[number]

export interface NeedsYouCard {
  /** The record's own id — the gate's, the finding's, the episode's. Stable across reads. */
  id: string
  kind: NeedsYouKind
  /** "Gate open · round 2" — what sort of summons this is. */
  kindLabel: string
  /** "ep01 “The Long Pier” — script gate". */
  title: string
  /** Why it needs him, in one sentence. The argument in full lives in the room. */
  why: string
  /** The whole sentence, when `why` is its opening. Rendered for a pointer and a reader. */
  detail: string
  /** "opened 4 min ago · round 1 rejected with your notes". Off the record's own timestamp. */
  since: string
  /** Where the act happens. An address in the shell's own bar (`cockpit.ts`). */
  href: string
  /** What that room is called. */
  room: string
  /** What it cannot do yet and which issue fixes it, or null once the room is built. */
  roomNotYet: string | null
  /** The act, stated as verb + object + scope + cost. Going there spends nothing. */
  act: Offer
  episodeId: string
}

/**
 * A stop on the lifecycle track, and where this episode stands on it.
 *
 * **The three states are Ryan's ruling of Aug 11 2026** (E5-0's review, recorded on #81):
 * done / current-**amber** / running-**blue, pulsing**. Amber means *your hand* and blue
 * means *in flight*, everywhere in this cockpit, always. `ahead` is the fourth and it is
 * the absence of the other three — a stop nothing has reached yet.
 */
export const PIP_STANDING = ['done', 'current', 'running', 'ahead'] as const
export type PipStanding = (typeof PIP_STANDING)[number]

export interface FloorStop {
  stage: EpisodeLifecycle
  standing: PipStanding
  /** "script — where ep01 stands, and it is waiting on you". Read aloud; never a colour. */
  sentence: string
}

/** What one episode's run is saying right now, for an eye that arrived mid-run. */
export interface FloorLive {
  runId: string
  /** "write-the-outline · holds the gpu lock" — composed off the step and the lock rows. */
  heading: string
  /** The newest `progress()` line, or null. */
  latest: string | null
  /** Every `chunk()` this step has emitted, oldest first. */
  stream: string[]
  /**
   * The log position the two lines above are as of. The browser drops anything at or below
   * it off the live stream, so the replay it is served on connecting cannot append a word
   * this read already handed it (`events.ts`, `proseOfRun`).
   */
  seq: number
}

export interface EpisodeOnTheFloor {
  id: string
  /** "ep01". */
  label: string
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  /** "2 calls · $0.02 · 3 proposals riding" — what this episode has cost and carries. */
  note: string
  /**
   * The second muted line: not-started, vanilla, or the arc positions it declared. Never
   * blank — an episode that has none of those still says which of them is true of it.
   */
  standing: string
  /** Published, or put down. The row is drawn quiet; it is history, not a failure. */
  past: boolean
  track: FloorStop[]
  /** Exactly one of the four below carries the status column. */
  waiting: string | null
  live: FloorLive | null
  launch: Offer | null
  done: string | null
  /** The stage `launch` starts. The browser never holds its own copy of a stage name. */
  launchStage: string
  /** D12's wall, when one stands on this episode. Said under whichever of the four it is. */
  wall: string | null
  /** "Queued behind it: …" — one run per episode (D7), said rather than left to be guessed. */
  queued: string | null
  /** The episode room's address, for the row's own door. */
  href: string
}

export interface FloorShow {
  id: string
  key: string
  title: string
  /** "Season 1 · the floor" — where this is, in the mockup's own words. */
  where: string
  health: HealthTile[]
  healthHeading: FloorHeading
  needsYouHeading: FloorHeading
  needsYou: NeedsYouCard[]
  /** What an empty needs-you section says. Null while anything needs him. */
  nothingNeedsYou: { lead: string; sentence: string } | null
  inFlightHeading: FloorHeading
  episodes: EpisodeOnTheFloor[]
  /** The footer the mockup draws: what is NOT in flight, and what there is instead. */
  footer: { lead: string; sentence: string }
}

export interface FloorView {
  library: LibraryPaths
  shows: FloorShow[]
  /**
   * The absence and what to do about it, or null when there is something to stand on. Both
   * halves, because the honest empty state says the absence first and then the way out.
   */
  empty: { lead: string; sentence: string } | null
  /**
   * What the event stream will send, and where this read was taken from.
   *
   * The kinds are handed over because SSE dispatches by event NAME and a second copy of a
   * twenty-one-string list living in the browser is a list that drifts.
   *
   * `since` is the log position taken BEFORE this view was composed, so a browser opening
   * the stream at it is served everything this read could possibly have missed. The overlap
   * is deliberate and it is the safe direction: an event replayed is a re-read that changes
   * nothing, and an event skipped is a screen quietly out of date. Nothing doubles, because
   * every prose line carries the seq it is as of (`FloorLive.seq`).
   */
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

// ── The floor ───────────────────────────────────────────────────────────────────

/**
 * Everything the floor renders, for every show in the library.
 *
 * `now` is a parameter rather than a call to the clock so that "opened 4 min ago" is a
 * testable sentence instead of one that passes on Tuesdays — the same reason
 * `remainingThisWeek` takes one.
 */
export function floorView(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  now: Date = new Date(),
): FloorView {
  // Taken FIRST, before a single row below is read: it is the position a browser opens the
  // live stream at, so anything landing while this view is being composed is replayed to it
  // rather than lost. Overlap is harmless (see `stream.since`); a gap would not be.
  const since = latestSeq(store)

  // Read once for the whole page rather than per episode: both are one query each, and
  // every card and every row below is a filter over them.
  const gates = openGates(store)
  const holders = lockHolders(store)
  const rooms = destinationsOf()
  const catalogue = stageCatalogue(library)

  const onTheFloor = shows(store).map((show): FloorShow => {
    const episodes = seasonsOf(store, show.id).flatMap((season) =>
      episodesOf(store, season.id).map((episode) =>
        episodeOnTheFloor(store, library, llm, catalogue, rooms, holders, gates, episode),
      ),
    )
    const seasons = seasonsOf(store, show.id)

    const needsYou = needsYouCards(store, rooms, gates, now, episodes)
    return {
      id: show.id,
      key: show.key,
      title: show.title,
      where: seasons.length === 1 ? `Season ${seasons[0]!.number} · the floor` : `${seasons.length} seasons · the floor`,
      health: healthStrip(store, library, llm, show.id),
      healthHeading: HEALTH_HEADING,
      needsYouHeading: NEEDS_YOU_HEADING,
      needsYou,
      nothingNeedsYou: needsYou.length > 0 ? null : nothingNeedsYou(episodes),
      inFlightHeading: IN_FLIGHT_HEADING,
      episodes,
      footer: footerOf(store, show.id, episodes),
    }
  })

  return {
    library,
    shows: onTheFloor,
    empty:
      onTheFloor.length === 0
        ? {
            lead: 'Nothing is in flight, because this library has no shows in it yet.',
            sentence:
              'Run `npm run fixture:load` to seed Grey Harbor — it spends nothing, ' +
              'generates nothing, and is safe to run twice.',
          }
        : null,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since },
  }
}

const HEALTH_HEADING: FloorHeading = {
  name: 'Health',
  explains:
    'what this process can reach, what the volume holds, and what this show has spent — ' +
    'no weekly cap is set anywhere in this build, so spend-to-date is the whole of it (#88)',
}

const NEEDS_YOU_HEADING: FloorHeading = {
  name: 'Needs you',
  explains:
    'what is holding work still or standing owed — a run parked on your ruling, a stage ' +
    'refused, a pass an episode owes. Everything else is rulable at your leisure',
}

const IN_FLIGHT_HEADING: FloorHeading = {
  name: 'In flight',
  explains:
    'one row per episode: where it stands, what it is thinking, and what it has cost so far',
}

// ── The health strip ────────────────────────────────────────────────────────────

/**
 * Four tiles: can this reach a model, is there a GPU worker, what does the volume hold,
 * and what has this show spent.
 *
 * Every one of them is a fact somebody records. The adapter's is `describeLLMBackend`'s own
 * sentence — the E1-8 tile's honesty, restyled and not re-worded, which matters because it
 * says "there is something to call" rather than "connected" on purpose (invariant 4). The
 * GPU worker's is that E6 has not built one. The volume's is the filesystem's own answer
 * plus the artifact rows. The spend is `cost_entry`, through `remainingThisWeek`.
 */
export function healthStrip(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  showId: string,
): HealthTile[] {
  return [adapterTile(llm), gpuWorkerTile(), volumeTile(store, library), spendTile(store, showId)]
}

function adapterTile(llm: LLMReadiness): HealthTile {
  return {
    id: 'adapter',
    label: 'Claude adapter',
    // Never "connected". `ready` proves presence, not reach — a key that is set may be
    // revoked and a CLI on PATH may be logged out, and `choose.ts` says so in as many words.
    value: llm.ready ? `${llm.label} · something to call` : `${llm.label} · nothing to call`,
    sub: firstSentence(llm.sentence),
    detail: `${llm.sentence} Chosen because ${llm.chosenBy}.`,
    standing: llm.ready ? 'good' : 'attention',
    meter: null,
  }
}

function gpuWorkerTile(): HealthTile {
  return {
    id: 'gpu-worker',
    label: 'GPU worker',
    value: 'Not built yet',
    sub: 'E6 builds the native Mac GPU worker (D5). Nothing in this build calls one.',
    detail:
      'E6 builds the native Mac GPU worker (D5) and the local image and TTS backends that ' +
      'run on it. Nothing in this build calls one, so there is no worker here to be down — ' +
      'the `gpu` lock exists and has never been held.',
    standing: 'not-built',
    meter: null,
  }
}

/**
 * What the volume holds. Free space is the filesystem's own answer through `statfsSync`;
 * the artifact count is the rows, which is what the LIBRARY reports as opposed to what the
 * disk does. Both are named, because "412 GB free" on a shared disk is not a statement
 * about this library and reading it as one is how a volume fills up by surprise.
 */
function volumeTile(store: Store, library: LibraryPaths): HealthTile {
  const filed = store.get<{ files: number }>(
    'SELECT COUNT(*) AS files FROM artifact WHERE file_path IS NOT NULL',
  )!.files
  const held = `${filed} artifact ${filed === 1 ? 'file' : 'files'} recorded`

  let free: number | undefined
  try {
    const stat = statfsSync(library.root)
    free = Number(stat.bavail) * Number(stat.bsize)
  } catch {
    free = undefined
  }

  if (free === undefined) {
    return {
      id: 'library-volume',
      label: 'Library volume',
      value: 'Free space unreadable',
      sub: `${held} · ${library.root} — the filesystem would not answer.`,
      detail:
        `${library.root} is mounted and the library is being read from it, but the ` +
        `filesystem did not answer a free-space query. ${held} in this library.`,
      standing: 'unknown',
      meter: null,
    }
  }

  return {
    id: 'library-volume',
    label: 'Library volume',
    // The count first and the path second: an absolute library root is longer than the tile
    // and the tile is a glance, so the half that is about THIS library leads and the path
    // trails off into the `title` that carries all of it.
    value: `${bytes(free)} free`,
    sub: `${held} · ${library.root}`,
    detail:
      `${bytes(free)} free on the volume ${library.root} is mounted from — which is the ` +
      `whole filesystem, not this library's share of it. ${held} in this library.`,
    standing: 'good',
    meter: null,
  }
}

/**
 * **What this show has spent, and the honest whole of what a budget means here** (#81's
 * fifth trap, resolved).
 *
 * `show_budget` is a real table with a real reader (`cost.ts`, since 0005) — but no route,
 * no button and no fixture ever writes a row, so in every library that exists today
 * `remainingThisWeek` returns "no weekly budget set" and there is nothing to draw a bar
 * against. The meter therefore appears if and only if a row is there, and the tile is
 * otherwise a spend reading with a sentence saying no cap stands against it. #88 files the
 * door that sets one; until it lands, this is the truth and it is stated as the truth.
 */
function spendTile(store: Store, showId: string): HealthTile {
  const week = remainingThisWeek(store, showId)
  const all = costOfShow(store, showId)
  const capped = week.budgetDollars !== undefined

  return {
    id: 'spend',
    label: capped ? 'Budget · this week' : 'Spend · this week',
    value: capped
      ? `${money(week.spend.microDollars)} of ${money(week.budgetDollars! * 1e6)}`
      : money(week.spend.microDollars),
    sub: week.sentence,
    detail:
      `${week.sentence}. Since Monday ${week.weekStart.slice(0, 10)}; ` +
      `${spentSentence(all)} on this show all told` +
      (capped
        ? '.'
        : '. Nothing in this build sets a weekly cap — the ledger and the reader are ' +
          'there and no surface writes one, so this tile shows what was spent rather ' +
          'than a bar against a number nobody chose (#88).'),
    standing: capped && (week.remainingDollars ?? 0) < 0 ? 'attention' : 'good',
    meter: capped
      ? {
          // Clamped for drawing only. The SENTENCE is not clamped, and it says "over" when
          // the week has gone over — a bar that stopped at full would hide the news.
          filled: Math.min(1, week.spend.microDollars / Math.max(1, week.budgetDollars! * 1e6)),
          sentence: week.sentence,
        }
      : null,
  }
}

// ── Needs you ───────────────────────────────────────────────────────────────────

/**
 * Every card, oldest summons first — the order `openGates` already reads in, which is the
 * order they started waiting.
 *
 * The rule that decides membership is the module header's, and this is it in code: a gate
 * that is open, a wall that stands where no gate is open to carry it, and a sweep that is
 * owed. Nothing else is consulted.
 */
export function needsYouCards(
  store: Store,
  rooms: readonly Destination[],
  gates: readonly OpenGate[],
  now: Date,
  episodes: readonly EpisodeOnTheFloor[],
): NeedsYouCard[] {
  const byId = new Map(episodes.map((episode) => [episode.id, episode]))
  const cards: NeedsYouCard[] = []

  for (const open of gates) {
    const episode = byId.get(open.gate.episodeId)
    if (!episode) continue
    cards.push(gateCard(store, rooms, now, open, episode))
  }

  const gated = new Set(gates.map((open) => open.gate.episodeId))
  for (const episode of episodes) {
    // The fold: a wall on an episode whose gate is open is said inside that gate's card,
    // because both come down at the same ruling in the same room.
    if (episode.wall !== null && !gated.has(episode.id)) {
      cards.push(wallCard(store, rooms, episode))
    }
  }

  for (const episode of episodes) {
    const sweep = sweepOnThePage(store, episode.id)
    if (sweep) cards.push(sweepCard(rooms, episode, sweep.riders, sweep.sentence, sweep.open))
  }

  return cards
}

function gateCard(
  store: Store,
  rooms: readonly Destination[],
  now: Date,
  open: OpenGate,
  episode: EpisodeOnTheFloor,
): NeedsYouCard {
  const artifact = findArtifact(store, open.gate.artifactId)
  const kind = artifact?.kind ?? 'artifact'
  // Open findings anchored in the very draft under review, and the deterministic ones the
  // wall is computed from. Both are reads over rows, asked again every time (0010, D12).
  const standing = findingsIn(store, open.gate.artifactId).filter(
    (finding) => finding.status === 'open' && finding.anchor.version === artifact?.version,
  )
  const blocking = stageBlockingFindings(store, open.gate.episodeId).filter(
    (block) => block.artifact.id === open.gate.artifactId,
  )
  const room = roomFor(rooms, 'gate-room')

  const why =
    standing.length === 0
      ? `No check has raised anything against it. The run is parked on this gate and your ` +
        `ruling is the only thing that moves it.`
      : `${count(standing.length, 'finding')} stand on it` +
        (blocking.length === 0
          ? ' — every one of them argues, and none of them can stop you ruling (invariant 3).'
          : `, ${blocking.length} of them deterministic: those refuse the next stage until they ` +
            'are resolved, and never this gate (D12).')

  return {
    id: open.gate.id,
    kind: 'gate',
    kindLabel: open.round === 1 ? 'Gate open' : `Gate open · round ${open.round}`,
    title: `${episode.label} “${episode.title}” — ${kind} gate`,
    why,
    detail: `${why} ${episode.wall ?? ''}`.trim(),
    since:
      `opened ${ago(open.since, now)}` +
      (open.round === 1 ? '' : ` · round ${open.round - 1} rejected with your notes`),
    href: `${room.path}/${open.gate.id}`,
    room: room.name,
    roomNotYet: room.notYetBecause,
    act: {
      sentence: `Rule on ${open.subject} — round ${open.round}, at its gate`,
      // Opening it is free. What a REJECTION buys is the stage's own declared cost and it
      // is stated at the gate, on the button that spends it (`gateOnThePage`) — a card that
      // priced the ruling here would be quoting one of three verdicts as if it were all of them.
      cost: `${count(standing.length, 'finding')} · round ${open.round} · ${FREE} to open it`,
      enabled: true,
      blockedBecause: null,
    },
    episodeId: open.gate.episodeId,
  }
}

function wallCard(
  store: Store,
  rooms: readonly Destination[],
  episode: EpisodeOnTheFloor,
): NeedsYouCard {
  const [first] = stageBlockingFindings(store, episode.id)
  const room = roomFor(rooms, 'episode-room')
  const wall = episode.wall ?? ''

  return {
    id: first?.finding.id ?? episode.id,
    kind: 'wall',
    kindLabel: 'Stage refused',
    title: `${episode.label} “${episode.title}” — the ${first?.finding.checkKey ?? 'check'} finding stands`,
    why: firstSentence(wall),
    detail: wall,
    since: `no gate is open on ${episode.label}, so nothing else is going to mention it`,
    href: `${room.path}/${episode.id}`,
    room: room.name,
    roomNotYet: room.notYetBecause,
    act: {
      sentence: `Take down the wall on ${episode.label} — dismiss it, fix it, or rule over it at a gate`,
      cost: `${FREE} to look · the deterministic checks cost nothing to re-run`,
      enabled: true,
      blockedBecause: null,
    },
    episodeId: episode.id,
  }
}

function sweepCard(
  rooms: readonly Destination[],
  episode: EpisodeOnTheFloor,
  riders: number,
  sentence: string,
  open: Offer,
): NeedsYouCard {
  const room = roomFor(rooms, 'episode-room')
  return {
    id: `sweep-${episode.id}`,
    kind: 'sweep',
    kindLabel: 'Completion sweep owed',
    title: `${episode.label} “${episode.title}” — ${count(riders, 'proposal')} riding`,
    why: firstSentence(sentence),
    detail: sentence,
    since: 'owed since its script was approved — approving it was not a ruling on any of them',
    href: `${room.path}/${episode.id}`,
    room: room.name,
    roomNotYet: room.notYetBecause,
    // The sweep's own offer, composed where the pass is (`sweep.ts`). A second wording of
    // "rule the riders" would be the one that quietly disagreed about how many there are.
    act: open,
    episodeId: episode.id,
  }
}

/**
 * The designed state, not a blank region. It says the absence first and then what there is
 * instead — which on this screen is either work in flight or a floor with nothing on it.
 */
function nothingNeedsYou(episodes: readonly EpisodeOnTheFloor[]): { lead: string; sentence: string } {
  const running = episodes.filter((episode) => episode.live !== null).length
  if (running > 0) {
    return {
      lead: 'Nothing needs you.',
      sentence:
        `${count(running, 'episode')} ${running === 1 ? 'is' : 'are'} working, and none of ` +
        'them is waiting on a ruling. What arrives will land here.',
    }
  }
  return {
    lead: 'Nothing needs you.',
    sentence:
      'No gate is open, no stage is refused, and no episode owes canon a pass. Every ' +
      'ruling in the queue is yours to make whenever you like, in the canon library.',
  }
}

// ── One episode's row ───────────────────────────────────────────────────────────

function episodeOnTheFloor(
  store: Store,
  library: LibraryPaths,
  llm: LLMReadiness,
  catalogue: ReturnType<typeof stageCatalogue>,
  rooms: readonly Destination[],
  holders: ReturnType<typeof lockHolders>,
  gates: readonly OpenGate[],
  episode: Episode,
): EpisodeOnTheFloor {
  const label = episodeLabel(episode.number)
  const spend = costOfEpisode(store, episode.id)
  const runs = runsOfEpisode(store, episode.id)
  const inFlight = runs.find((run) => run.status === 'queued' || run.status === 'running')
  const gate = gates.find((open) => open.gate.episodeId === episode.id)
  const sweep = sweepOnThePage(store, episode.id)
  const wall = stageBlockedBecause(store, episode.id)
  const artifacts = artifactsOf(store, episode.id)
  const stage = stageForEpisode(episode)
  const past = episode.lifecycle === 'published' || episode.abandonedAt !== null

  return {
    id: episode.id,
    label,
    number: episode.number,
    title: episode.title,
    lifecycle: episode.lifecycle,
    note: [spentSentence(spend), sweep === null ? '' : count(sweep.riders, 'proposal') + ' riding']
      .filter(Boolean)
      .join(' · '),
    standing: standingOf(store, episode, label, artifacts.length, runs.length),
    past,
    track: lifecycleStops(episode.lifecycle, inFlight?.status === 'running'),
    waiting: gate ? waitingSentence(store, label, gate) : null,
    live: inFlight && inFlight.status === 'running' ? liveOfRun(store, holders, inFlight) : null,
    launch:
      gate || inFlight || past
        ? null
        : stageOffer(store, llm, episode.id, catalogue[stage]!),
    done: past ? pastSentence(store, episode, label, spend) : null,
    launchStage: stage,
    wall,
    queued: queuedSentence(store, runs),
    href: `${roomFor(rooms, 'episode-room').path}/${episode.id}`,
  }
}

/**
 * premise → published, with the ruled three states on it.
 *
 * `EPISODE_LIFECYCLE` names the stage an episode is AT, meaning the work it still owes
 * (`domain/lifecycle.ts`) — so the stop it is at is `current` (his hand) unless a run is
 * actually turning on it right now, which makes it `running` (in flight).
 */
export function lifecycleStops(lifecycle: EpisodeLifecycle, running: boolean): FloorStop[] {
  const at = EPISODE_LIFECYCLE.indexOf(lifecycle)
  return EPISODE_LIFECYCLE.map((stage, index): FloorStop => {
    if (index < at) return { stage, standing: 'done', sentence: `${stage} — done` }
    if (index > at) return { stage, standing: 'ahead', sentence: `${stage} — not reached yet` }
    return running
      ? { stage, standing: 'running', sentence: `${stage} — running now` }
      : { stage, standing: 'current', sentence: `${stage} — where it stands, and it is yours to move` }
  })
}

/** "◆ Waiting on you — script gate, round 2, 3 findings". The mark is the stylesheet's. */
function waitingSentence(store: Store, label: string, open: OpenGate): string {
  const artifact = findArtifact(store, open.gate.artifactId)
  const standing = findingsIn(store, open.gate.artifactId).filter(
    (finding) => finding.status === 'open' && finding.anchor.version === artifact?.version,
  )
  return (
    `Waiting on you — ${artifact?.kind ?? 'artifact'} gate, round ${open.round}, ` +
    `${count(standing.length, 'finding')} on ${label}`
  )
}

/**
 * What this run is saying, and what it is holding while it says it.
 *
 * The heading is composed off the step rows and the lock rows — never off a remembered
 * string — so "holds the gpu lock" and "waiting on the gpu lock (held by ep05)" are the
 * same read answered twice. The prose is the event log's, which is what the log is for.
 *
 * **Exported for the episode room** (E5-2), which renders the same run one scope in. A second
 * composer would be the one that quietly disagreed about which lock is held — and the whole
 * point of "waiting on GPU (held by ep05)" is that the floor and the room say it identically.
 */
export function liveOfRun(
  store: Store,
  holders: ReturnType<typeof lockHolders>,
  run: Run,
): FloorLive {
  const steps = stepsOf(store, run.id)
  const at = steps.find((step) => step.status === 'running' || step.status === 'waiting-on-lock')
  const wait = waitingOn(store, run.id)
  const held = holders.find((hold) => hold.runId === run.id)

  const heading = wait
    ? `${at?.name ?? run.stage} · waiting on the ${wait.lock} lock, held by ${episodeLabel(wait.heldByEpisodeNumber)}`
    : held
      ? `${at?.name ?? run.stage} · holds the ${held.lock} lock`
      : `${at?.name ?? run.stage} · running`

  const prose = proseOfRun(store, run.id)
  return { runId: run.id, heading, latest: prose.latest, stream: prose.stream, seq: prose.seq }
}

/**
 * **What is queued behind whatever holds this episode** — D7's per-episode serialization,
 * said rather than left to be discovered.
 *
 * It names what the queued run is waiting ON, out of that run's own status, because the two
 * cases are different news. A run behind a RUNNING one waits for work to finish and there is
 * nothing for Ryan to do. A run behind a PAUSED one waits for HIM — his ruling at that gate
 * is what releases it — and a floor that showed the gate and stayed silent about the work
 * stacked up behind it would be hiding the consequence of the decision it is asking for.
 *
 * (That second case is the one this missed until it was booted and looked at: the queued run
 * WAS the in-flight one, so a guard meant to avoid naming a run behind itself dropped the
 * only sentence there was to say.)
 *
 * **Exported for the episode room** (E5-2). D7 is one rule and it is said once.
 */
export function queuedSentence(store: Store, runs: readonly Run[]): string | null {
  const queued = runs.find((run) => run.status === 'queued')
  if (!queued) return null
  const ahead = queuedBehind(store, queued.id)
  if (!ahead) return null

  return ahead.status === 'paused'
    ? `Queued behind your ruling: the ${queued.stage} stage — it starts when your ruling lets ` +
        `the ${ahead.stage} run finish (one run per episode, D7)`
    : `Queued behind it: the ${queued.stage} stage — it waits for the ${ahead.stage} run to ` +
        'finish (one run per episode, D7)'
}

/**
 * The second muted line under an episode's title, and it is never blank.
 *
 * **"Not started" is rendered because it is TRUE** — no artifact was ever recorded, no run
 * was ever asked for, and the lifecycle is still at the first stop — not because a column
 * says so (the fixture's own ep02 doc asks for exactly this). And a **vanilla** episode
 * says it is vanilla: touching no arc is legal, tracked, and never a failure state (1.1).
 */
function standingOf(
  store: Store,
  episode: Episode,
  label: string,
  artifacts: number,
  runs: number,
): string {
  if (episode.abandonedAt !== null) {
    return `Put down on ${episode.abandonedAt.slice(0, 10)} — it keeps the stage it reached.`
  }
  if (artifacts === 0 && runs === 0 && episode.lifecycle === EPISODE_LIFECYCLE[0]) {
    return `Not started — nothing has been written for ${label} yet.`
  }
  const positions = positionsOf(store, episode.id)
  if (isVanilla(store, episode.id) || positions.length === 0) {
    return 'Vanilla — it touches no arc, which is legal, tracked, and never a failure.'
  }
  return `Lands ${positions.map((position) => `${position.arc.name} @ ${position.waypoint.name}`).join(', ')}.`
}

/** What a finished episode's row says instead of an offer. History, never a failure. */
function pastSentence(store: Store, episode: Episode, label: string, spend: CostTotals): string {
  if (episode.abandonedAt !== null) {
    return `${label} was put down. Its claims were parked and its ratified facts each got a revert proposal of their own (3.3).`
  }
  const ruled = sweepEpisode(store, episode.id).ruled.length
  return (
    `Published · ${spentSentence(spend)}` +
    (ruled === 0 ? '' : ` · ${count(ruled, 'proposal')} ruled into canon from it`)
  )
}

// ── The footer ──────────────────────────────────────────────────────────────────

/**
 * The mockup's idea-pool footer, said honestly.
 *
 * It draws "the S1 idea pool holds 3 greenlit premises and 2 parked". **There is no idea
 * pool in this build** — no table, no greenlit, no parked, no spiked — so this says what
 * the season DOES hold and names the pool as a thing that is not here rather than
 * rendering a count of nothing. The same rule as the budget meter, one region down.
 */
function footerOf(
  store: Store,
  showId: string,
  episodes: readonly EpisodeOnTheFloor[],
): { lead: string; sentence: string } {
  const seasons = seasonsOf(store, showId)
  const working = episodes.filter((episode) => !episode.past).length
  return {
    lead: 'Nothing else in flight.',
    sentence:
      `${count(episodes.length, 'episode')} across ${count(seasons.length, 'season')}, and ` +
      `${working} of them still ${working === 1 ? 'has' : 'have'} work to do — every one is ` +
      'above. A season’s idea pool (greenlit, parked, spiked) is not in this build; ' +
      'nothing records one yet, so there is no count here to be wrong.',
  }
}

// ── Sentences ───────────────────────────────────────────────────────────────────

/** The room by id, off the same list the shell draws its bar from (`cockpit.ts`). */
function roomFor(rooms: readonly Destination[], id: string): Destination {
  return rooms.find((room) => room.id === id)!
}

/** "3 findings", "1 proposal", "no findings" — a count that reads as a phrase. */
export function count(n: number, noun: string): string {
  if (n === 0) return `no ${noun}s`
  return `${n} ${n === 1 ? noun : `${noun}s`}`
}

/**
 * How long ago, in the coarsest unit that is still true. A card says "opened 4 min ago"
 * rather than a timestamp because the question it answers is "how long has this been
 * waiting on me", and an ISO string makes Ryan do the arithmetic.
 */
export function ago(at: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** Bytes as a human reads them. Rendering only — nothing does arithmetic on this. */
function bytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let at = 0
  let value = size
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024
    at += 1
  }
  return `${value < 10 && at > 0 ? value.toFixed(1) : Math.round(value)} ${units[at]}`
}
