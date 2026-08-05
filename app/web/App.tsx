import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventRecord } from '../server/events.ts'
import type { EpisodeOnThePage, Offer, OperatingView, RunView } from '../server/operating.ts'
import type { NoteDepth } from '../server/runner/gate.ts'

/**
 * The bare-bones operating page (E1-8) — one page, and the last thing E1 builds.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * It is not the cockpit. The eight screens are E5's, they are already drawn in
 * `mockups/`, and this page deliberately spends nothing on looking like them: no design
 * system, no component library, no colour. Unstyled HTML is the point.
 *
 * ── What it still owes ──────────────────────────────────────────────────────────
 * Spending nothing on visuals is not permission to break the rules that are about words.
 * Every button below states verb + object + scope + cost in a full sentence, and states
 * the cost BEFORE the click; every blocked action renders disabled with the reason in
 * words; the gate renders its artifact, readable, never a filename. Those sentences are
 * composed on the server (`operating.ts`), where they have tests — this file renders the
 * strings it was handed and invents none of its own. That is also why nothing here
 * imports a VALUE from `app/server`: a stage name, an event kind, a note depth all come
 * down the wire, so the browser bundle stays a browser bundle and there is one copy of
 * each list.
 *
 * ── Why it is two components ────────────────────────────────────────────────────
 * `App` holds the state and does the talking; `Page` is markup and nothing else. The
 * split is not architecture, it is testability: effects do not run under
 * `renderToString`, so a one-component page could only ever be asserted in its
 * empty-before-the-API state. `Page` takes the server's own view objects, so
 * `App.test.tsx` renders the real thing with real data and no browser.
 *
 * ── Nothing runs without a click ────────────────────────────────────────────────
 * Loading this page reads. It never launches, never resumes, never rules. The two things
 * that move work are both `onClick`, and both go through the API, which re-checks the
 * same precondition the disabled button was already showing.
 */

/** What Ryan has typed but not yet submitted. One note, one comment — E5's desk does more. */
export interface Draft {
  note: string
  depth: NoteDepth | ''
  target: string
  comment: string
}

const EMPTY_DRAFT: Draft = { note: '', depth: '', target: '', comment: '' }

export function App() {
  const [view, setView] = useState<OperatingView | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunView | null>(null)
  const [live, setLive] = useState<EventRecord[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  /** The kinds the stream will send. Fixed for the life of the process; read once. */
  const [stream, setStream] = useState<OperatingView['stream'] | null>(null)
  /** Which run is on screen, readable inside the stream's listener without re-subscribing. */
  const showing = useRef<string | null>(null)

  const loadView = useCallback(async (): Promise<OperatingView | null> => {
    try {
      const next = (await (await fetch('/api/operating')).json()) as OperatingView
      setView(next)
      setStream((held) => held ?? next.stream)
      return next
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
      return null
    }
  }, [])

  const loadRun = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/run/${id}`)
    setRun(res.ok ? ((await res.json()) as RunView) : null)
  }, [])

  // First load. It also picks up whatever this process came back to: a run left parked on
  // a gate by a killed process is still parked, and this is what puts it back on screen.
  useEffect(() => {
    void loadView().then((next) => {
      const unfinished = next?.shows
        .flatMap((show) => show.episodes)
        .map((episode) => episode.run)
        .find((each) => each && ['queued', 'running', 'paused'].includes(each.status))
      if (unfinished) setRunId(unfinished.id)
    })
  }, [loadView])

  useEffect(() => {
    showing.current = runId
    if (runId) void loadRun(runId)
  }, [runId, loadRun])

  /**
   * The stream. It opens at sequence 0, so this panel is also the log — after a restart it
   * replays everything the killed process wrote before it died, which is how "it resumed"
   * is told from "it started again" by eye.
   *
   * Transitions are what change the tables, so those are what trigger a re-read; the two
   * prose kinds only scroll past underneath.
   */
  useEffect(() => {
    if (!stream) return
    const source = new EventSource('/api/events')
    for (const kind of stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        setLive((prior) => [...prior, record])
        if (stream.prose.includes(record.kind)) return
        void loadView()
        if (showing.current === null) setRunId(record.runId)
        else if (showing.current === record.runId) void loadRun(record.runId)
      })
    }
    return () => source.close()
  }, [stream, loadView, loadRun])

  async function launch(episode: EpisodeOnThePage): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId: episode.id, stage: episode.launchStage }),
      })
      const body = (await res.json()) as { runId?: string; error?: string }
      if (!res.ok) setProblem(body.error ?? 'The run was refused, and said nothing about why.')
      else if (body.runId) setRunId(body.runId)
      await loadView()
    } finally {
      setBusy(false)
    }
  }

  async function rule(gateId: string, verdict: 'approve' | 'reject'): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const body =
        verdict === 'approve'
          ? { comment: draft.comment }
          : {
              notes: [
                {
                  note: draft.note,
                  ...(draft.depth === '' ? {} : { depth: draft.depth }),
                  ...(draft.target === '' ? {} : { target: draft.target }),
                },
              ],
            }
      const res = await fetch(`/api/gate/${gateId}/${verdict}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const refused = (await res.json()) as { error?: string }
        setProblem(refused.error ?? 'The ruling was refused, and said nothing about why.')
      } else {
        setDraft(EMPTY_DRAFT)
        setRun((await res.json()) as RunView)
      }
      await loadView()
    } finally {
      setBusy(false)
    }
  }

  if (!view) {
    return (
      <main style={PAGE}>
        <h1>Showrunner — the operating page</h1>
        <p>{problem ?? 'The API has not answered yet.'}</p>
      </main>
    )
  }

  return (
    <Page
      view={view}
      run={run}
      runId={runId}
      live={live}
      problem={problem}
      busy={busy}
      draft={draft}
      onDraft={(next) => setDraft({ ...draft, ...next })}
      onLaunch={(episode) => void launch(episode)}
      onShowRun={setRunId}
      onRule={(gateId, verdict) => void rule(gateId, verdict)}
    />
  )
}

export interface PageProps {
  view: OperatingView
  run: RunView | null
  runId: string | null
  live: EventRecord[]
  problem: string | null
  busy: boolean
  draft: Draft
  onDraft(next: Partial<Draft>): void
  onLaunch(episode: EpisodeOnThePage): void
  onShowRun(runId: string): void
  onRule(gateId: string, verdict: 'approve' | 'reject'): void
}

/** Markup, and nothing else. Every sentence on it was composed by the server. */
export function Page(props: PageProps) {
  const { view, run, runId, live, problem, busy, draft } = props

  return (
    <main style={PAGE}>
      <h1>Showrunner — the operating page</h1>
      <p>
        E1's scaffolding, not the cockpit: one page, no design. The eight screens are E5's
        and are drawn in <code>mockups/</code>. Nothing here runs without a click.
      </p>

      {problem && (
        <p style={{ border: '2px solid currentColor', padding: '0.6rem' }}>
          <strong>Refused:</strong> {problem}
        </p>
      )}

      {/* The floor's first tile, in words: can this process reach a model right now. */}
      <h2>Claude adapter</h2>
      <p>
        <strong>
          {view.llm.label} — {view.llm.ready ? 'ready' : 'NOT READY'}
        </strong>{' '}
        ({view.llm.chosenBy})
        <br />
        {view.llm.sentence}
      </p>

      <h2>Library volume</h2>
      <ul>
        <li>root: {view.library.root}</li>
        <li>database: {view.library.databaseFile}</li>
        <li>artifacts: {view.library.artifactDir}</li>
      </ul>

      {view.emptyBecause && <p>{view.emptyBecause}</p>}

      {view.shows.map((show) => (
        <section key={show.id}>
          <h2>
            {show.title} <small>({show.key})</small>
          </h2>
          <p>
            Spend: {show.spendSentence}. {show.budgetSentence}.
          </p>

          {show.episodes.map((episode) => (
            <article key={episode.id} style={CARD}>
              <h3>
                {episode.label} · {episode.title}
              </h3>
              <p>
                {episode.track.map((stop, index) => (
                  <span key={stop.stage} style={stop.reached ? undefined : FAINT}>
                    {index === 0 ? '' : ' → '}
                    {stop.current ? <strong>[{stop.stage}]</strong> : stop.stage}
                  </span>
                ))}
              </p>
              <p>Spend on this episode: {episode.spendSentence}</p>

              <Button offer={episode.launch} busy={busy} onClick={() => props.onLaunch(episode)} />

              {episode.run && (
                <p>
                  Latest run: <code>{episode.run.id}</code> — {episode.run.sentence}{' '}
                  {episode.run.id !== runId && (
                    <button type="button" onClick={() => props.onShowRun(episode.run!.id)}>
                      Show this run below
                    </button>
                  )}
                </p>
              )}
            </article>
          ))}
        </section>
      ))}

      {run && (
        <section>
          <h2>
            The run — <code>{run.run.id}</code>
          </h2>
          <p>{run.sentence}</p>

          <h3>Steps</h3>
          <ol>
            {run.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.name}</strong> — {step.status}
                {step.waitingOn && ` (waiting on ${step.waitingOn})`}
                {step.failure && ` — ${step.failure}`}
                {step.attempts.length > 1 && (
                  <ul>
                    {step.attempts.map((attempt) => (
                      <li key={attempt.seq}>
                        attempt {attempt.attempt}: {attempt.outcome}
                        {attempt.failure && ` — ${attempt.failure}`}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>

          {/* One artifact, one ruling. A gate renders what is under review (D15, 4.6). */}
          {run.gate && (
            <>
              <h3>
                Gate — {run.gate.subject}, round {run.gate.round}
                {run.gate.isOpen ? ' · open, waiting on you' : ' · ruled'}
              </h3>
              <p>
                {run.gate.artifact.kind}
                {run.gate.artifact.slot && ` ${run.gate.artifact.slot}`} v
                {run.gate.artifact.version}
                {run.gate.artifact.filePath && ` · ${run.gate.artifact.filePath}`}
              </p>
              <pre style={ARTIFACT}>{run.gate.artifact.text ?? run.gate.artifact.note}</pre>

              <p>
                <label>
                  Your words on the approval (optional):{' '}
                  <input
                    value={draft.comment}
                    onChange={(event) => props.onDraft({ comment: event.target.value })}
                    size={56}
                  />
                </label>
              </p>
              <Button
                offer={run.gate.approve}
                busy={busy}
                onClick={() => props.onRule(run.gate!.id, 'approve')}
              />

              <p>
                <label>
                  Your note — the step reopens with it and writes again against it:
                  <br />
                  <textarea
                    value={draft.note}
                    onChange={(event) => props.onDraft({ note: event.target.value })}
                    rows={3}
                    cols={72}
                  />
                </label>
                <br />
                {/* Routing depth (D21): the note picks how deep the work goes back. E1
                    carries it and acts on none of it — E4 and E6 are what act. */}
                <label>
                  How deep it goes back:{' '}
                  <select
                    value={draft.depth}
                    onChange={(event) =>
                      props.onDraft({ depth: event.target.value as NoteDepth | '' })
                    }
                  >
                    <option value="">unrouted — the legal default</option>
                    {run.gate.noteDepths.map((each) => (
                      <option key={each} value={each}>
                        {each}
                      </option>
                    ))}
                  </select>
                </label>{' '}
                <label>
                  Which one:{' '}
                  <input
                    value={draft.target}
                    onChange={(event) => props.onDraft({ target: event.target.value })}
                    placeholder="scene-4"
                  />
                </label>
              </p>
              <Button
                offer={withNote(run.gate.reject, draft.note)}
                busy={busy}
                onClick={() => props.onRule(run.gate!.id, 'reject')}
              />

              {run.gate.rounds.length > 1 && (
                <>
                  <h4>Round history</h4>
                  <ul>
                    {run.gate.rounds.map((round) => (
                      <li key={round.round}>
                        Round {round.round} · v{round.artifactVersion}
                        {round.stale && ' · stale — from before your last rejection'}
                        {round.ruling &&
                          ` · ${round.ruling.verdict}${round.ruling.notes
                            .map((each) => ` — “${each.note}”`)
                            .join('')}`}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          <h3>What this run spent</h3>
          <p>{run.spend.sentence}</p>
          <ul>
            {run.spend.entries.map((entry) => (
              <li key={entry.seq}>
                {entry.kind} · {entry.model} · {entry.backend} · ${entry.dollars.toFixed(4)} (
                {entry.priced}
                {entry.outcome === 'failed' && ', and it failed'})
                {entry.usage &&
                  ` · ${entry.usage.uncachedInput + entry.usage.cacheWrite5m + entry.usage.cacheRead} prompt tokens in, ${entry.usage.output} out`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2>Live</h2>
      <p>
        Every event this process has written, oldest first — replayed from the start when
        the page opens, so what a killed process wrote is still here after the restart.
      </p>
      <ol style={STREAM}>
        {live.map((event) => (
          <li key={event.seq}>
            <code>{event.seq}</code> {event.kind}
            {event.summary ? ` — ${event.summary}` : ''}
          </li>
        ))}
      </ol>
    </main>
  )
}

/**
 * A button, and the only way this page renders one. It states the sentence it was handed,
 * states its cost before the click, and when it cannot be pressed renders disabled with
 * the reason in words — never a failure after the click.
 */
function Button({ offer, busy, onClick }: { offer: Offer; busy: boolean; onClick: () => void }) {
  return (
    <div style={{ margin: '0.6rem 0' }}>
      <button type="button" disabled={!offer.enabled || busy} onClick={onClick} style={BUTTON}>
        {offer.sentence}
        <br />
        <small>{offer.cost}</small>
      </button>
      {offer.blockedBecause && (
        <div>
          <small>Blocked: {offer.blockedBecause}</small>
        </div>
      )}
    </div>
  )
}

/**
 * The one precondition this page owns rather than reads: a rejection needs a note, and
 * the note is in a textarea the server has never seen. Same shape as every other blocked
 * button — disabled, with the reason in words, before the click.
 */
function withNote(reject: Offer, note: string): Offer {
  if (!reject.enabled || note.trim() !== '') return reject
  return {
    ...reject,
    enabled: false,
    blockedBecause:
      'Write the note first — "reject with notes" is the verb, and the note is what the ' +
      'step reopens with.',
  }
}

const PAGE = {
  fontFamily: 'ui-monospace, monospace',
  lineHeight: 1.6,
  padding: '2rem',
  maxWidth: '64rem',
}
const CARD = { border: '1px solid currentColor', padding: '0.8rem 1rem', margin: '1rem 0' }
const BUTTON = { font: 'inherit', textAlign: 'left' as const, padding: '0.5rem 0.8rem' }
const FAINT = { opacity: 0.5 }
const ARTIFACT = {
  border: '1px solid currentColor',
  padding: '1rem',
  whiteSpace: 'pre-wrap' as const,
  maxHeight: '30rem',
  overflow: 'auto',
}
const STREAM = { maxHeight: '24rem', overflow: 'auto', fontSize: '0.85rem' }
