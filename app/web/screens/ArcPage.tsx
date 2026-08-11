import { useCallback, useEffect, useState } from 'react'
import type {
  ArcIndexView,
  ArcPageView,
  HistoryLine,
  WaypointOnTheSpine,
} from '../../server/arc-page.ts'
import type { EventRecord } from '../../server/events.ts'
import { Section } from '../chrome/Card.tsx'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { onLinkClick } from '../chrome/router.ts'
import type { ScreenProps } from '../chrome/Shell.tsx'
import './arc.css'

/**
 * **The arc page** — one arc, whole (E5-5, #85; 5.8, D24, D8; `mockups/arc.html`).
 *
 * ── The panel that teaches, teaches with the real thing ─────────────────────────
 * "How this arc is checked" renders the waypoint-drift check's actual composed instructions
 * and its actual reference material — the same strings `text-check.ts` sends when a run
 * convenes the check, off the same function (`waypointCheckFor`). It is not a description of
 * the check and there is no paraphrase of it anywhere in this file, because a paraphrase is a
 * second copy and the copy on the screen is the one Ryan would believe.
 *
 * ── Four standings, never three ─────────────────────────────────────────────────
 * `landed` is canon with a ruling behind it, `riding` is a claim waiting on Ryan, `pinned` is
 * a plan an episode declared, and `ahead` is a waypoint nothing holds. They are `data-standing`
 * on the row, and the words are the server's.
 *
 * ── It rules nothing ────────────────────────────────────────────────────────────
 * Moving a pin belongs to the episode's writing room, where the draft it is about is (E4-4).
 * Ratifying a landing belongs to the gate or the sweep, where the proposal's five parts are
 * rendered beside it. This page is a read, and its only controls are links.
 */

export function ArcPage(props: ScreenProps) {
  return props.id === null ? <ArcIndex {...props} /> : <OneArc {...props} />
}

/**
 * The bare address. **No door in this cockpit may be a dead end** — the bar carries `/arc` —
 * and an arc page with no arc genuinely has nothing on it, so this is the list instead. Its
 * every word is the server's, like everything else here.
 */
function ArcIndex(props: ScreenProps) {
  const [view, setView] = useState<ArcIndexView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setView((await (await fetch('/api/arc')).json()) as ArcIndexView)
      } catch (error) {
        setProblem(`The API did not answer: ${String(error)}`)
      }
    })()
  }, [])

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? props.destination.explains}
      </p>
    )
  }

  return <ArcIndexScreen view={view} />
}

export function ArcIndexScreen({ view }: { view: ArcIndexView }) {
  return (
    <div className="arc">
      <Section name={view.heading.name} explains={view.heading.explains} className="arc-panel">
        {view.empty !== null ? (
          <EmptyState lead={view.empty.lead} sentence={view.empty.sentence} />
        ) : (
          view.arcs.map((arc) => (
            <div className="arc-hist" key={arc.arcId}>
              <a
                className="arc-hist__w"
                href={arc.href}
                onClick={onLinkClick(arc.href)}
                id={`arc-${arc.arcId}`}
              >
                {arc.sentence}
              </a>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}

function OneArc(props: ScreenProps) {
  const [view, setView] = useState<ArcPageView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [stream, setStream] = useState<ArcPageView['stream'] | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (props.id === null) return
    try {
      const res = await fetch(`/api/arc/${props.id}`)
      if (!res.ok) {
        setProblem(((await res.json()) as { error?: string }).error ?? null)
        return
      }
      setProblem(null)
      const next = (await res.json()) as ArcPageView
      setView(next)
      setStream((held) => held ?? next.stream)
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [props.id])

  useEffect(() => {
    void load()
  }, [load])

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

  return <ArcPageScreen view={view} problem={problem} />
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface ArcPageScreenProps {
  view: ArcPageView
  problem: string | null
}

export function ArcPageScreen({ view, problem }: ArcPageScreenProps) {
  return (
    <div className="arc">
      <p className="crumb">
        <a href={view.floorHref} onClick={onLinkClick(view.floorHref)}>
          ← {view.floorName}
        </a>{' '}
        ·{' '}
        <a href={view.seasonHref} onClick={onLinkClick(view.seasonHref)}>
          {view.seasonName}
        </a>{' '}
        ·{' '}
        <a
          href={view.canonHref}
          onClick={onLinkClick(view.canonHref)}
          title={view.canonNotYet ?? view.canonName}
        >
          {view.canonName}
        </a>
      </p>

      <header className="arc-head">
        <h1>{view.name}</h1>
        <span className="arc-chip">{view.kindChip}</span>
        <span className="arc-chip arc-chip--standing">{view.standingChip}</span>
      </header>
      <p className="arc-headsub">{view.headsub}</p>

      <div className="arc-cols stacks">
        <div>
          <Section
            name={view.headings.statement.name}
            explains={view.headings.statement.explains}
            className="arc-panel"
          >
            {view.noStatement !== null ? (
              <EmptyState lead={view.noStatement.lead} sentence={view.noStatement.sentence} />
            ) : (
              <div className="arc-statement">
                {view.statement.map((part, index) => (
                  <p key={index}>{part}</p>
                ))}
              </div>
            )}
          </Section>

          <Section
            name={view.headings.waypoints.name}
            explains={view.headings.waypoints.explains}
            className="arc-panel"
          >
            {view.waypoints.map((waypoint) => (
              <Waypoint
                key={waypoint.waypointId}
                waypoint={waypoint}
                landingLabel={view.landingLabel}
              />
            ))}
          </Section>
        </div>

        <div>
          <Section
            name={view.headings.glance.name}
            explains={view.headings.glance.explains}
            className="arc-panel"
          >
            {view.glance.map((row) => (
              <div className="arc-kv" key={row.key}>
                <span className="arc-kv__k">{row.key}</span>
                <span className="arc-kv__v">{row.value}</span>
              </div>
            ))}
            {view.entities.length > 0 && (
              <div className="arc-eps">
                {view.entities.map((entity) => (
                  <a
                    className="arc-ep"
                    key={entity.entityId}
                    href={entity.href}
                    onClick={onLinkClick(entity.href)}
                  >
                    {entity.name}
                  </a>
                ))}
              </div>
            )}
            {view.noEntities !== null && (
              <EmptyState lead={view.noEntities.lead} sentence={view.noEntities.sentence} />
            )}
          </Section>

          <Section
            name={view.headings.episodes.name}
            explains={view.headings.episodes.explains}
            className="arc-panel"
          >
            {view.noEpisodes !== null ? (
              <EmptyState lead={view.noEpisodes.lead} sentence={view.noEpisodes.sentence} />
            ) : (
              <div className="arc-eps">
                {view.episodes.map((episode) => (
                  <a
                    className="arc-ep"
                    key={episode.episodeId}
                    href={episode.href}
                    onClick={onLinkClick(episode.href)}
                    data-standing={episode.standing}
                    title={episode.sentence}
                  >
                    {episode.label} · {episode.sentence}
                  </a>
                ))}
              </div>
            )}
            {view.untouchedNote !== null && (
              <span className="arc-note">{view.untouchedNote}</span>
            )}
          </Section>

          <Section
            name={view.headings.checked.name}
            explains={view.headings.checked.explains}
            className="arc-panel"
          >
            <p className="arc-rule">{view.checked.sentence}</p>
            {view.checked.none !== null ? (
              <EmptyState lead={view.checked.none.lead} sentence={view.checked.none.sentence} />
            ) : (
              <>
                <span className="arc-check__for">{view.checked.composedFor}</span>
                <span className="arc-check__label">
                  {view.checked.checkKey} — {view.checked.label}
                </span>
                {/*
                 * Verbatim, both of them. `instructions` is what the reviewer is told to do and
                 * `reference` is the arc prose it argues from; `arc-page.ts` took them off the
                 * check's own composer and this renders the strings it was handed.
                 */}
                <pre className="arc-check__text" id="drift-instructions">
                  {view.checked.instructions}
                </pre>
                <pre className="arc-check__text" id="drift-reference">
                  {view.checked.reference}
                </pre>
              </>
            )}
          </Section>

          <Section
            name={view.headings.history.name}
            explains={view.headings.history.explains}
            className="arc-panel"
          >
            {view.history.map((line, index) => (
              <Line key={index} line={line} />
            ))}
          </Section>
        </div>
      </div>

      {problem !== null && (
        <p className="crumb" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

/**
 * One waypoint on the spine: what it means, what landing it looks like, and what has actually
 * happened to it. The lineage tag is only ever on a landed one — that is the distinction the
 * whole screen turns on, and it is a separate tag rather than a shade of the same one.
 */
function Waypoint({
  waypoint,
  landingLabel,
}: {
  waypoint: WaypointOnTheSpine
  landingLabel: string
}) {
  return (
    <div
      className="arc-wprow"
      data-standing={waypoint.standing}
      id={`waypoint-${waypoint.waypointId}`}
    >
      <div className="arc-pip">{waypoint.ordinal}</div>
      <div>
        <div className="arc-wp__t">{waypoint.name}</div>
        <p className="arc-wp__means">{waypoint.description}</p>
        <p className="arc-wp__lands">
          <b>{landingLabel}</b> {waypoint.landingCriteria}
        </p>
        <div className="arc-wp__meta">
          {waypoint.lineage !== null && (
            <span className="tag arc-tag--ruling">{waypoint.lineage}</span>
          )}
          {waypoint.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        {waypoint.recheck !== null && <span className="arc-wp__recheck">{waypoint.recheck}</span>}
      </div>
    </div>
  )
}

function Line({ line }: { line: HistoryLine }) {
  return (
    <div className="arc-hist">
      <span className="arc-hist__w">{line.what}</span> <span className="arc-hist__d">{line.when}</span>
      {line.note !== null && <span className="arc-hist__note">{line.note}</span>}
    </div>
  )
}
