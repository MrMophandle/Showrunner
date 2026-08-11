import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { EventRecord } from '../../server/events.ts'
import type {
  ArcCell,
  ArcRow,
  EpisodeColumn,
  MechanismGap,
  SeasonMapView,
  ThreadRow,
} from '../../server/season-map.ts'
import { Section } from '../chrome/Card.tsx'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { onLinkClick } from '../chrome/router.ts'
import type { ScreenProps } from '../chrome/Shell.tsx'
import './season-map.css'

/**
 * **The season map** — the season seen whole (E5-5, #85; 5.7, D8; `mockups/season-map.html`).
 *
 * ── Three inks, and the screen never invents one ────────────────────────────────
 * A cell is `landed`, `riding` or `pinned`, and the difference between them is the difference
 * between canon, a claim waiting on Ryan, and a plan. The screen renders `cell.waypoint.ink`
 * as a `data-ink` attribute and `cell.waypoint.sentence` as the words beside it; both are the
 * server's (`season-map.ts`), and a landing's ruling is printed IN the cell because the
 * lineage is what makes it canon rather than a nicer border.
 *
 * `data-ink` rather than a class is deliberate and it is about the reading eye: an attribute
 * is invisible to `held-still.ts`'s flow signature, so a cell repainting itself when a landing
 * ratifies is not a page that moved.
 *
 * ── The grid holds still and scrolls in its own box ─────────────────────────────
 * `.season-scroller` is the only element on this screen that scrolls sideways, and it declares
 * a height. Those are the same decision twice: the page never scrolls sideways (the approved
 * detail), and the box cannot grow, so a landing landing in a cell moves nothing below it. The
 * arc-label column is `position: sticky` inside it, so the names stay put under Ryan's eye
 * while the season slides.
 *
 * ── It writes no word and offers no verb ────────────────────────────────────────
 * Every sentence comes down the wire. There is deliberately **no button anywhere on this
 * screen**: nothing on a map spends or rules, and the two regions where the mockup draws a
 * costed button and a pool of cards are honest empty states naming the issues that hold their
 * mechanisms (#92, #93). A disabled button would say the act exists.
 */

export function SeasonMap(props: ScreenProps) {
  const [view, setView] = useState<SeasonMapView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [stream, setStream] = useState<SeasonMapView['stream'] | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(props.id === null ? '/api/season' : `/api/season/${props.id}`)
      if (!res.ok) {
        setProblem(((await res.json()) as { error?: string }).error ?? null)
        return
      }
      const next = (await res.json()) as SeasonMapView
      setProblem(null)
      setView(next)
      setStream((held) => held ?? next.stream)
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [props.id])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The map re-reads when a transition lands — a gate ruled, a run finished. Opened at the
   * position the first read was taken from, so the replay is the gap rather than the whole log
   * (E5-1's protocol, reused rather than reinvented).
   *
   * A ruling made at the canon bench or in the completion sweep convenes no gate and no run,
   * so it writes no event and this stream will not carry it (`events.ts`, 0008). That is not a
   * hole in the map: the sweep is opened from an episode and the map is re-read when Ryan comes
   * back to it — and every number on it is computed off rows, so coming back is enough.
   */
  useEffect(() => {
    if (!stream) return
    const source = new EventSource(`/api/events?since=${stream.since}`)
    for (const kind of stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        if (stream.prose.includes(record.kind)) return
        void load()
      })
    }
    return () => source.close()
  }, [stream, load])

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? props.destination.explains}
      </p>
    )
  }

  return <SeasonMapScreen view={view} problem={problem} />
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface SeasonMapScreenProps {
  view: SeasonMapView
  problem: string | null
}

export function SeasonMapScreen({ view, problem }: SeasonMapScreenProps) {
  return (
    <div className="season">
      <p className="crumb">
        <a href={view.floorHref} onClick={onLinkClick(view.floorHref)}>
          ← {view.floorName}
        </a>{' '}
        · {view.where}
      </p>

      <header className="season-head">
        <h1>{view.title}</h1>
        <span className="season-head__meta">{view.meta}</span>
        {view.seasons.length > 1 && (
          <nav className="season-choices" aria-label="which season">
            {view.seasons.map((season) => (
              <a
                key={season.seasonId}
                className="season-choice"
                href={season.href}
                onClick={onLinkClick(season.href)}
                aria-current={season.current ? 'page' : undefined}
              >
                {season.label}
              </a>
            ))}
          </nav>
        )}
      </header>

      <Section
        name={view.headings.grid.name}
        explains={view.headings.grid.explains}
        className="season-panel"
      >
        {view.noArcs !== null ? (
          <EmptyState lead={view.noArcs.lead} sentence={view.noArcs.sentence} />
        ) : (
          <Grid view={view} />
        )}
        {view.vanillaNote !== null && <span className="season-note">{view.vanillaNote}</span>}
      </Section>

      <Section
        name={view.headings.threads.name}
        explains={view.headings.threads.explains}
        className="season-panel"
      >
        {view.threads.map((thread, index) => (
          <Thread key={thread.arcId ?? index} thread={thread} />
        ))}
      </Section>

      <div className="season-gaps">
        <Gap gap={view.pool} />
        <Gap gap={view.pitch} />
      </div>

      {problem !== null && (
        <p className="crumb" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

// ── The grid ────────────────────────────────────────────────────────────────────

/**
 * Episodes as columns, arcs as rows.
 *
 * The two numbers this file computes are not copy: how many episodes the season has and how
 * many arcs run through it. They are facts about the season, and the stylesheet does the
 * arithmetic from them — the column ruler and the grid box's own height. Everything else on
 * the grid is a string the server composed.
 */
function Grid({ view }: { view: SeasonMapView }) {
  const ruler = {
    '--season-count': view.episodes.length,
    '--season-rows': view.arcs.length,
  } as CSSProperties

  return (
    <div
      className="season-scroller"
      style={ruler}
      data-cold={view.arcs.some((arc) => arc.warning !== null)}
    >
      <div className="season-map" style={ruler}>
        <div className="season-row season-row--head">
          <div className="season-cell" />
          {view.episodes.map((episode) => (
            <div className="season-cell" key={episode.episodeId}>
              <Column episode={episode} />
            </div>
          ))}
          <div className="season-cell">
            <span className="season-ep__n">{view.headings.ahead.name}</span>
          </div>
        </div>

        {view.arcs.map((arc) => (
          <Row key={arc.arcId} arc={arc} />
        ))}

        <div className="season-row season-row--foot">
          <div className="season-foot__label">{view.touchedLabel}</div>
          {view.episodes.map((episode) => (
            <div className="season-cell" key={episode.episodeId}>
              {episode.vanillaTag === null ? (
                episode.footNote
              ) : (
                <span className="season-vanilla">{episode.vanillaTag}</span>
              )}
            </div>
          ))}
          <div className="season-cell" />
        </div>
      </div>
    </div>
  )
}

function Column({ episode }: { episode: EpisodeColumn }) {
  return (
    <div className="season-ep" data-tone={episode.tone}>
      <span className="season-ep__n">{episode.label}</span>
      <a className="season-ep__t" href={episode.href} onClick={onLinkClick(episode.href)}>
        {episode.title}
      </a>
      <span className="season-ep__st">{episode.standing}</span>
    </div>
  )
}

function Row({ arc }: { arc: ArcRow }) {
  return (
    <div className="season-row season-row--arc" id={`arc-${arc.arcId}`}>
      <div className="season-arclabel">
        <span className="season-arclabel__nm">
          <a href={arc.href} onClick={onLinkClick(arc.href)} title={arc.roomNotYet ?? arc.room}>
            {arc.name}
          </a>
        </span>
        <span className="season-arclabel__kind">{arc.kind}</span>
        {arc.warning !== null && <span className="season-arclabel__warn">{arc.warning}</span>}
      </div>

      {arc.cells.map((cell) => (
        <Cell key={cell.episodeId} cell={cell} />
      ))}

      <div className="season-ahead">
        {arc.aheadNone !== null ? (
          <span className="season-ahead__none">{arc.aheadNone}</span>
        ) : (
          arc.ahead.map((waypoint) => (
            <span className="season-ahead__wp" key={waypoint.waypointId} title={waypoint.sentence}>
              <span className="season-wp__no">{waypoint.ordinal}</span>
              {waypoint.name}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * One cell: what an episode put on this arc, or the track dot for one that put nothing.
 *
 * The lineage is printed rather than hinted. A landing that only differed from a pin by its
 * border would be the two-inks rule kept in CSS and lost the moment anybody looked at a
 * screenshot in grayscale.
 */
function Cell({ cell }: { cell: ArcCell }) {
  const classes = [
    'season-cell',
    'season-cell--track',
    cell.first ? 'season-cell--first' : '',
    cell.cold ? 'season-cell--cold' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes}>
      {cell.waypoint === null ? (
        <span className="season-dot" aria-hidden="true" />
      ) : (
        <span
          className="season-wp"
          data-ink={cell.waypoint.ink}
          title={cell.waypoint.sentence}
          aria-label={cell.waypoint.sentence}
        >
          <span className="season-wp__no">{cell.waypoint.ordinal}</span>
          {cell.waypoint.name}
          {/*
           * The lineage slot, rendered on every chip and filled on exactly one of them. It is
           * always here because a slot that APPEARED when a landing ratified would add an
           * element to the flow above every arc below this one — and out of flow or not, an
           * element arriving is an element arriving. Empty on a pin, which is the truth: a pin
           * has no ruling behind it.
           */}
          <span className="season-wp__ruling">{cell.waypoint.lineage ?? ''}</span>
        </span>
      )}
    </div>
  )
}

// ── Below the grid ──────────────────────────────────────────────────────────────

function Thread({ thread }: { thread: ThreadRow }) {
  return (
    <div className="season-thread" data-cold={thread.cold} id={`thread-${thread.arcId ?? 'none'}`}>
      <div className="season-thread__h">
        {thread.href === null ? (
          thread.heading
        ) : (
          <a href={thread.href} onClick={onLinkClick(thread.href)}>
            {thread.heading}
          </a>
        )}
      </div>
      <p className="season-thread__p">{thread.sentence}</p>
      <span className="season-thread__why">{thread.why}</span>
    </div>
  )
}

/**
 * A region the mockup draws that this build has no mechanism for.
 *
 * It says the absence, says what would fill it, and names the issue — so the answer to "when"
 * is one click away, which is the #39 pattern. There is no button and no form: a screen that
 * offered either would be claiming a mechanism it does not have.
 */
function Gap({ gap }: { gap: MechanismGap }) {
  return (
    <Section name={gap.heading.name} explains={gap.heading.explains} className="season-panel">
      <EmptyState lead={gap.lead} sentence={gap.sentence}>
        <span className="season-gap__issue">
          <a href={gap.issueHref} target="_blank" rel="noreferrer">
            {gap.filed}
          </a>
        </span>
      </EmptyState>
    </Section>
  )
}
