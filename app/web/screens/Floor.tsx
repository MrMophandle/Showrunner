import { useCallback, useEffect, useState } from 'react'
import type { EventRecord } from '../../server/events.ts'
import type {
  EpisodeOnTheFloor,
  FloorShow,
  FloorView,
  HealthTile,
  NeedsYouCard,
} from '../../server/floor.ts'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { LifecycleTrack } from '../chrome/LifecycleTrack.tsx'
import { LiveRegion } from '../chrome/LiveRegion.tsx'
import { onLinkClick } from '../chrome/router.ts'
import { SectionHeader } from '../chrome/SectionHeader.tsx'
import { SentenceButton, SentenceLink } from '../chrome/SentenceButton.tsx'
import type { ScreenProps } from '../chrome/Shell.tsx'
import './floor.css'

/**
 * **The floor** — the home screen, and the one whose whole job is bringing the work to Ryan
 * (E5-1, #81; 5.1; `mockups/floor.html`).
 *
 * ── What it is ─────────────────────────────────────────────────────────────────
 * A composition, and almost nothing else. Every sentence on it — the needs-you card's why,
 * the health tile's honesty, the wall, the owed sweep, the button's cost and its refusal —
 * is composed in `server/floor.ts`, where it has a test. **This file writes no word**, and
 * `floor.test.tsx` proves it the way `chrome.test.tsx` does: hand it a view of empty
 * strings and see whether anything comes out.
 *
 * ── The one thing it can DO ────────────────────────────────────────────────────
 * Start the stage an idle episode is at, which is the mockup's own row button ("Write the
 * ep07 outline · 1 Opus call · ~$0.85"). It goes through `POST /api/run`, which refuses
 * with the identical sentence the disabled button was already showing — so a precondition
 * can never become a failure after a click. Everything else on this screen is a LINK to the
 * room where the act happens: a gate is ruled at the gate room, a sweep in the episode
 * room. Nothing runs, nothing rules and nothing spends because a page loaded (invariant 5).
 *
 * ── Live, in place ─────────────────────────────────────────────────────────────
 * A run's prose lands in that episode row's `LiveRegion` and nowhere else. Transitions — a
 * step finishing, a gate opening, a lock changing hands — re-read the whole floor rather
 * than patching it, because every number on it is computed off rows and a screen keeping
 * them in step by hand is the remembered state 1.3 refuses. The re-read cannot move
 * anything: `floor.css` gives every region above a row, and every row, a fixed height.
 *
 * ── The row ratchet ────────────────────────────────────────────────────────────
 * A row is compact until a run starts on it and tall for the rest of the page's life. A run
 * starts because Ryan clicked, so the growth is his; a run ending is the system's, so the
 * height does not come back. `Row` below carries the argument, and `floor.css` the numbers.
 *
 * ── Why it is three exports ────────────────────────────────────────────────────
 * `Floor` holds the state and does the talking; `FloorScreen` is markup, plus the one latch
 * that is about this viewing of this page rather than about the world; `applyProse` is the
 * reduction an arriving event performs. The split is testability rather than architecture,
 * and it is the same one `App.tsx` made: effects do not run under `renderToString`, a
 * socket is not what needs testing, and what `floor.test.tsx` has to be able to do is push
 * a REAL event down the REAL fan-out and watch the DOM not move.
 */

/**
 * What each run is saying, keyed by run — the browser's copy of the prose it has heard, and
 * **the log position it has heard it up to**.
 *
 * The position is the load-bearing field. Two sources feed one line: the server's read
 * (`proseOfRun`), which is what a browser arriving mid-run is handed, and the live stream,
 * which replays the gap before it goes live. Without a position the browser cannot tell a
 * chunk it already has from one it does not — it appends both, and the line renders every
 * word twice. It did exactly that until the app was booted and the line was read.
 */
export type Prose = Readonly<
  Record<string, { latest: string | null; chunks: string[]; seq: number }>
>

export function Floor({ cockpit }: ScreenProps) {
  const [view, setView] = useState<FloorView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** The kinds the stream will send. Fixed for the life of the process; read once. */
  const [stream, setStream] = useState<FloorView['stream'] | null>(null)
  const [prose, setProse] = useState<Prose>({})

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = (await (await fetch('/api/floor')).json()) as FloorView
      setView(next)
      setStream((held) => held ?? next.stream)
      setProse((held) => seedProse(held, next))
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!stream) return
    // Opened at the position the first read was taken from, so the replay is the gap rather
    // than the whole log — and the gap is what a browser that arrived mid-run actually
    // missed. Anything served twice is dropped by `applyProse`'s own seq check.
    const source = new EventSource(`/api/events?since=${stream.since}`)
    for (const kind of stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        setProse((held) => applyProse(held, record))
        // Which kinds are prose is the wire's answer, never a list this browser keeps.
        if (stream.prose.includes(record.kind)) return
        void load()
      })
    }
    return () => source.close()
  }, [stream, load])

  async function launch(episodeId: string, stage: string): Promise<void> {
    setBusy(episodeId)
    setProblem(null)
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId, stage }),
      })
      if (!res.ok) {
        // The API refuses with the sentence the button was already showing. Reaching this
        // means the world moved between the render and the click — a race, not a surprise.
        setProblem(((await res.json()) as { error?: string }).error ?? 'The API refused the run.')
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? cockpit.destinations[0]!.explains}
      </p>
    )
  }

  return (
    <FloorScreen
      view={view}
      prose={prose}
      busy={busy}
      problem={problem}
      onLaunch={(episodeId, stage) => void launch(episodeId, stage)}
    />
  )
}

/**
 * What an arriving event does to the prose, as a function of the event and nothing else.
 *
 * Three shapes, matching what a step emits (`runner/step.ts`): `progress()` is latest-wins
 * and replaces one line; `chunk()` accumulates; and **a step STARTING clears both**, because
 * a new step is a new stream and carrying the last one's words into it would be the wrong
 * "now". Every other kind changes nothing here — it changes rows, and rows are re-read.
 */
export function applyProse(held: Prose, record: EventRecord): Prose {
  const said = held[record.runId] ?? { latest: null, chunks: [], seq: 0 }
  // Already in this line. The stream replays the gap on connect, and the server's read has
  // usually handed over the same words already — order by `seq`, never by the timestamp.
  if (record.seq <= said.seq) return held

  switch (record.kind) {
    case 'step-progress':
      return {
        ...held,
        [record.runId]: { latest: record.summary, chunks: said.chunks, seq: record.seq },
      }
    case 'step-chunk':
      return {
        ...held,
        [record.runId]: {
          latest: said.latest,
          chunks: [...said.chunks, record.summary ?? ''],
          seq: record.seq,
        },
      }
    case 'step-started':
      // A new step is a new stream. The position moves with it, so the replay cannot put
      // the last step's words back.
      return { ...held, [record.runId]: { latest: null, chunks: [], seq: record.seq } }
    default:
      return held
  }
}

/**
 * The prose a browser missed, off the server's read — so a page opened mid-run shows the
 * line the step is on rather than an empty box.
 *
 * Seeded once per run and never overwritten: after the first chunk arrives the browser has
 * a fuller picture than a re-read does, and clobbering it would rewind the line mid-sentence.
 */
export function seedProse(held: Prose, view: FloorView): Prose {
  const seeded: Record<string, { latest: string | null; chunks: string[]; seq: number }> = {
    ...held,
  }
  for (const show of view.shows) {
    for (const episode of show.episodes) {
      const live = episode.live
      if (live && seeded[live.runId] === undefined) {
        seeded[live.runId] = { latest: live.latest, chunks: [...live.stream], seq: live.seq }
      }
    }
  }
  return seeded
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface FloorScreenProps {
  view: FloorView
  prose: Prose
  busy: string | null
  problem: string | null
  onLaunch: (episodeId: string, stage: string) => void
}

export function FloorScreen({ view, prose, busy, problem, onLaunch }: FloorScreenProps) {
  return (
    <div className="floor">
      {view.shows.map((show) => (
        <Show key={show.id} show={show} prose={prose} busy={busy} onLaunch={onLaunch} />
      ))}
      {view.empty !== null && <EmptyState lead={view.empty.lead} sentence={view.empty.sentence} />}
      {problem !== null && (
        <p className="floor-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

function Show({
  show,
  prose,
  busy,
  onLaunch,
}: {
  show: FloorShow
  prose: Prose
  busy: string | null
  onLaunch: (episodeId: string, stage: string) => void
}) {
  return (
    <>
      <header className="floor-head">
        <h1>{show.title}</h1>
        <span className="floor-head__where">{show.where}</span>
      </header>

      <section className="floor-health">
        <SectionHeader name={show.healthHeading.name} explains={show.healthHeading.explains} />
        <div className="floor-health__tiles">
          {show.health.map((tile) => (
            <Tile key={tile.id} tile={tile} />
          ))}
        </div>
      </section>

      <section className="floor-needs">
        <SectionHeader name={show.needsYouHeading.name} explains={show.needsYouHeading.explains}>
          {show.needsYou.length > 0 && (
            <span className="section-h__count">{show.needsYou.length}</span>
          )}
        </SectionHeader>
        <div className="floor-needs__cards">
          {show.nothingNeedsYou === null ? (
            show.needsYou.map((card) => <Need key={card.id} card={card} />)
          ) : (
            <EmptyState lead={show.nothingNeedsYou.lead} sentence={show.nothingNeedsYou.sentence} />
          )}
        </div>
      </section>

      <section>
        <SectionHeader name={show.inFlightHeading.name} explains={show.inFlightHeading.explains} />
        <ol className="floor-rows">
          {show.episodes.map((episode) => (
            <Row key={episode.id} episode={episode} prose={prose} busy={busy} onLaunch={onLaunch} />
          ))}
        </ol>
      </section>

      <div className="floor-footer">
        <EmptyState lead={show.footer.lead} sentence={show.footer.sentence} />
      </div>
    </>
  )
}

/**
 * One health tile. The dot is a second reading of `standing`, never the only one — the value
 * and the sentence say it in words, which is what invariant 4 is about: a weak check may not
 * render as a green tick, and "E6 has not built the GPU worker" may not render as an outage.
 */
function Tile({ tile }: { tile: HealthTile }) {
  return (
    <div className="tile" data-standing={tile.standing} data-tile={tile.id} title={tile.detail}>
      <span className="tile__k">{tile.label}</span>
      <span className="tile__v">
        <span className="tile__dot" aria-hidden="true" />
        {tile.value}
      </span>
      <span className="tile__sub">{tile.sub}</span>
      {/*
       * A bar, and only over a cap somebody set. `floor.ts` sends `meter: null` when no row
       * exists — which is every library today — and the sentence above says so in words.
       */}
      {tile.meter !== null && (
        <div className="tile__meter">
          <i style={{ width: `${Math.round(tile.meter.filled * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * One needs-you card: what, why, and where the act happens.
 *
 * The act is a LINK, because the ruling is made in another room — and it says which room,
 * with that room's own "not built yet" on it, so a stub is honest before it is clicked
 * rather than after.
 */
function Need({ card }: { card: NeedsYouCard }) {
  return (
    <article className="need" data-kind={card.kind} data-card={card.id} title={card.detail}>
      <span className="need__kind">{card.kindLabel}</span>
      <span className="need__title">{card.title}</span>
      <p className="need__why">{card.why}</p>
      <span className="need__since">{card.since}</span>
      <SentenceLink offer={card.act} href={card.href} ruling title={card.roomNotYet ?? undefined} />
      {/*
       * Which room, named — and what that room can honestly do today on the link itself, so
       * a stub is honest before it is clicked rather than after. The room's own screen says
       * it in full and points at the page where the mechanism still works.
       */}
      <span className="need__room" title={card.roomNotYet ?? undefined}>
        {card.room}
      </span>
    </article>
  )
}

/**
 * One episode's row, and **the ratchet** — the one piece of state this screen holds.
 *
 * A row is compact until a run starts on it, and then it is tall for the life of the page.
 * That asymmetry is the whole design, and both halves of it are about who caused the move:
 *
 *   * **Growing is his.** A run starts on an episode because Ryan clicked to start it. The
 *     row grows at the moment he acted, on the row he acted on — the only movement a page
 *     is allowed, because he is looking at the thing he just moved.
 *   * **Shrinking never is.** A run FINISHING is the system's doing. So the height stays
 *     and the content changes inside it: the live region gives way to whatever the row says
 *     next, in place, moving nothing. A row that snapped back when a run ended would shove
 *     everything under it up the page at a moment Ryan had no part in — the original defect,
 *     arriving from the polite direction.
 *
 * **Resetting it is a reload's job**, which is his act too. This is deliberately not
 * remembered anywhere: it is a fact about one viewing of one page, not about the world, and
 * a `row_height` column would be the remembered state 1.3 refuses, in the silliest place.
 *
 * The latch is set during render rather than in an effect, which is React's own pattern for
 * adjusting state when props change: it re-renders before committing, so the row is never
 * painted at the wrong height for a frame.
 */
function Row({
  episode,
  prose,
  busy,
  onLaunch,
}: {
  episode: EpisodeOnTheFloor
  prose: Prose
  busy: string | null
  onLaunch: (episodeId: string, stage: string) => void
}) {
  const live = episode.live
  const said = live === null ? undefined : prose[live.runId]

  const [everRan, setEverRan] = useState(() => live !== null)
  if (live !== null && !everRan) setEverRan(true)

  return (
    <li
      className={`floor-row ${everRan ? 'floor-row--tall' : ''} ${
        episode.past ? 'floor-row--past' : ''
      }`
        .replace(/\s+/g, ' ')
        .trim()}
      id={`row-${episode.id}`}
    >
      <div className="floor-row__id">
        <span className="floor-row__num">{episode.label}</span>
        <a
          className="floor-row__title"
          id={`open-${episode.id}`}
          href={episode.href}
          onClick={onLinkClick(episode.href)}
        >
          {episode.title}
        </a>
        <span className="floor-row__note">{episode.note}</span>
        <span className="floor-row__standing">{episode.standing}</span>
      </div>

      <LifecycleTrack stops={episode.track} label={`${episode.label} ${episode.title}`} />

      <div className="floor-row__status">
        {live !== null && (
          <LiveRegion
            id={`live-${episode.id}`}
            heading={live.heading}
            latest={said?.latest ?? live.latest}
            stream={said?.chunks ?? live.stream}
          />
        )}
        {episode.waiting !== null && <span className="floor-row__waiting">{episode.waiting}</span>}
        {episode.launch !== null && (
          // The dense density, which is a ruled one of two (E5-0's review, Aug 11) and the
          // right one here for the reason the gate room and the arc page use it: a rail
          // stacking full sentences. Nothing is trimmed — `floor.css` explains what the
          // column does when a stage's cost runs longer than the box.
          <SentenceButton
            offer={episode.launch}
            busy={busy === episode.id}
            onClick={() => onLaunch(episode.id, episode.launchStage)}
            wide
            dense
          />
        )}
        {episode.done !== null && <span className="floor-row__done">{episode.done}</span>}
        {episode.wall !== null && <span className="floor-row__wall">{episode.wall}</span>}
        {episode.queued !== null && <span className="floor-row__queued">{episode.queued}</span>}
      </div>
    </li>
  )
}
