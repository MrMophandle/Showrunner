import { useCallback, useEffect, useRef, useState } from 'react'
import type { CanonBenchView } from '../server/canon-bench.ts'
import type { CheckBenchView } from '../server/check-bench.ts'
import type { EventRecord } from '../server/events.ts'
import type { EpisodeOnThePage, OperatingView, RunView } from '../server/operating.ts'
import type { NoteDepth } from '../server/runner/gate.ts'
import type { SweepView } from '../server/sweep.ts'
import type { WritingRoomView } from '../server/writing-room.ts'
import {
  CanonBench,
  EMPTY_BENCH,
  type BenchDraft,
  type CanonBenchProps,
  type Edge,
  type SheetForm,
} from './CanonBench.tsx'
import {
  CheckBench,
  EMPTY_CHECK_DRAFT,
  type CheckBenchProps,
  type CheckDraft,
} from './CheckBench.tsx'
import { EMPTY_SWEEP, Sweep, type SweepDraft, type SweepProps } from './Sweep.tsx'
import { WritingRoom, type WritingRoomProps } from './WritingRoom.tsx'
import { ARTIFACT, Button, CARD, FAINT, needing, PAGE, STREAM } from './kit.tsx'

/**
 * The bare-bones operating page (E1-8, grown by E2-6) — one page, and the last thing E1
 * builds. Its canon section is `CanonBench.tsx`, and the same contract binds both.
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
  /**
   * The draft Ryan is typing over, and nothing else about it. Null when no edit is open —
   * there is deliberately no "dirty" flag and no autosave: an edit lands when he presses the
   * button, and the volume is what says what the draft is until he does (E4-5).
   */
  const [editing, setEditing] = useState<{ artifactId: string; text: string } | null>(null)
  /** The kinds the stream will send. Fixed for the life of the process; read once. */
  const [stream, setStream] = useState<OperatingView['stream'] | null>(null)
  /** Which run is on screen, readable inside the stream's listener without re-subscribing. */
  const showing = useRef<string | null>(null)

  // The canon bench (E2-6). Its own state, its own endpoint, and deliberately NOT on the
  // event stream: a bench ruling convenes no gate and no run, so it lands on `canon_ruling`
  // and the section re-reads from there after every act (#29, ruled Aug 7 2026).
  const [benchShow, setBenchShow] = useState<string | null>(null)
  const [canon, setCanon] = useState<CanonBenchView | null>(null)
  const [entityId, setEntityId] = useState<string | null>(null)
  const [asOf, setAsOf] = useState({ ruling: '', date: '' })
  const [bench, setBench] = useState<BenchDraft>(EMPTY_BENCH)

  // The check bench (E3-7). Scoped to an EPISODE rather than a show, because a check reads
  // one artifact, and opened by hand — a page that picked an episode silently would be
  // reading a bench Ryan did not ask for.
  const [checkEpisode, setCheckEpisode] = useState<string | null>(null)
  const [checks, setChecks] = useState<CheckBenchView | null>(null)
  const [checkDraft, setCheckDraft] = useState<CheckDraft>(EMPTY_CHECK_DRAFT)
  /** Which bench is on screen, readable inside the stream's listener without re-subscribing. */
  const benched = useRef<string | null>(null)

  // The completion sweep (E4-6). Episode-scoped like the checks, opened by hand, and NOT on
  // the event stream for the same reason the canon section is not: a ruling made here convenes
  // no gate, so it lands on `canon_ruling` and nowhere else, and the pass re-reads from there
  // after every act.
  const [sweepEpisode, setSweepEpisode] = useState<string | null>(null)
  const [sweep, setSweep] = useState<SweepView | null>(null)
  const [sweepDraft, setSweepDraft] = useState<SweepDraft>(EMPTY_SWEEP)

  // The writing room (E4-7). Episode-scoped and opened by hand, like the check bench and the
  // sweep — a page that picked an episode silently would be composing three writer's desks
  // for an episode Ryan never asked about. It IS on the event stream, unlike the other two:
  // every button in it starts a run, and what a run does to the desk, the gates, the wall and
  // the offers is exactly what the room renders.
  const [roomEpisode, setRoomEpisode] = useState<string | null>(null)
  const [room, setRoom] = useState<WritingRoomView | null>(null)
  /** Which desk is folded open, by step. A read the server already composed — never a fetch. */
  const [openDesk, setOpenDesk] = useState<string | null>(null)
  /** Which room is on screen, readable inside the stream's listener without re-subscribing. */
  const inTheRoom = useRef<string | null>(null)

  /** Where the bench's controls stand, as the API reads them — a string, so an effect can watch it. */
  const controls = new URLSearchParams({
    ...(entityId !== null && { entity: entityId }),
    ...(asOf.ruling !== '' && { ruling: asOf.ruling }),
    ...(asOf.date !== '' && { date: asOf.date }),
  }).toString()

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

  const loadCanon = useCallback(async (showId: string, query: string): Promise<void> => {
    const res = await fetch(`/api/canon/${showId}?${query}`)
    setCanon(res.ok ? ((await res.json()) as CanonBenchView) : null)
  }, [])

  const loadChecks = useCallback(async (episodeId: string): Promise<void> => {
    const res = await fetch(`/api/checks/${episodeId}`)
    setChecks(res.ok ? ((await res.json()) as CheckBenchView) : null)
  }, [])

  const loadSweep = useCallback(async (episodeId: string): Promise<void> => {
    const res = await fetch(`/api/sweep/${episodeId}`)
    setSweep(res.ok ? ((await res.json()) as SweepView) : null)
  }, [])

  const loadRoom = useCallback(async (episodeId: string): Promise<void> => {
    const res = await fetch(`/api/writing/${episodeId}`)
    setRoom(res.ok ? ((await res.json()) as WritingRoomView) : null)
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
      const first = next?.shows[0]
      if (first) setBenchShow((held) => held ?? first.id)
    })
  }, [loadView])

  // The bench re-reads when a control moves, and on nothing else. A GET, so opening this
  // page still starts nothing (invariant 5).
  useEffect(() => {
    if (benchShow) void loadCanon(benchShow, controls)
  }, [benchShow, controls, loadCanon])

  useEffect(() => {
    showing.current = runId
    if (runId) void loadRun(runId)
  }, [runId, loadRun])

  // The check bench re-reads when Ryan opens a different episode, and on nothing else. A GET,
  // so opening it starts nothing and costs nothing (invariant 5).
  useEffect(() => {
    benched.current = checkEpisode
    if (checkEpisode) void loadChecks(checkEpisode)
  }, [checkEpisode, loadChecks])

  // The sweep re-reads when Ryan opens a different episode's pass, and on nothing else. A GET,
  // so opening it rules nothing and spends nothing (invariant 5).
  useEffect(() => {
    if (sweepEpisode) void loadSweep(sweepEpisode)
  }, [sweepEpisode, loadSweep])

  // The writing room re-reads when Ryan opens a different episode's, and on nothing else. A
  // GET, so opening it writes nothing and spends nothing (invariant 5).
  useEffect(() => {
    inTheRoom.current = roomEpisode
    if (roomEpisode) void loadRoom(roomEpisode)
  }, [roomEpisode, loadRoom])

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
        // A check run finishing changes every number on the bench — the board, the wall, the
        // cards. It is re-read rather than patched: the whole thing is computed off rows, so
        // there is nothing here that could be kept up to date by hand (1.3).
        if (benched.current !== null) void loadChecks(benched.current)
        // Everything in the writing room moves when a run does: the desk (a note landed, a
        // finding was dismissed), the gates, the wall, and every offer. It is re-read rather
        // than patched, for the reason the bench is — the whole thing is computed off rows.
        if (inTheRoom.current !== null) void loadRoom(inTheRoom.current)
      })
    }
    return () => source.close()
  }, [stream, loadView, loadRun, loadChecks, loadRoom])

  /**
   * Ryan's click on one stage's button — the demo's, or one of the check bench's.
   *
   * The stage is a string that came down the wire on the offer it belongs to. The browser
   * never holds its own copy of a stage name: a page that did could ask for a stage this
   * build does not have, and the catalogue is the one place they are written down.
   */
  /**
   * **Ryan's hand on a written artifact** (E4-5): the draft, fetched to type over, and the
   * edit that lands it back verbatim.
   *
   * A GET to open it, so opening one costs nothing and starts nothing (invariant 5); a POST
   * to land it, which is one motion on the server — revise, re-delineate, and let the free
   * deterministic tier read the new version before it answers (`edit.ts`). The page re-reads
   * afterwards rather than patching: freshness, the wall and the offers are all computed off
   * rows, and a screen keeping them in step by hand would be the remembered state 1.3 refuses.
   */
  async function openEdit(artifactId: string): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/artifact/${artifactId}`)
      const body = (await res.json()) as { text?: string | null; error?: string }
      if (!res.ok) setProblem(body.error ?? 'That artifact could not be read.')
      else setEditing({ artifactId, text: body.text ?? '' })
    } finally {
      setBusy(false)
    }
  }

  async function landEdit(): Promise<void> {
    if (!editing) return
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/artifact/${editing.artifactId}/edit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Verbatim, character for character (D20). Nothing here trims it on the way past.
        body: JSON.stringify({ text: editing.text }),
      })
      const body = (await res.json()) as { sentence?: string; error?: string }
      if (!res.ok) setProblem(body.error ?? 'The edit was refused, and said nothing about why.')
      else setEditing(null)
      await loadView()
      if (checkEpisode) await loadChecks(checkEpisode)
      if (roomEpisode) await loadRoom(roomEpisode)
    } finally {
      setBusy(false)
    }
  }

  /**
   * **Moving the pin** (E4-4, D8): free, and it raises nothing. The landing proposal that
   * turns a pin into a fact is raised when the script is read, with the subject only the
   * writer can answer for — which is why declaring and landing are two calls (`canon-bench.ts`).
   *
   * The route answers with the canon bench, because that is where it was built; the room is
   * re-read afterwards because the pin is on its desks as well as on its door.
   */
  async function declare(episodeId: string, arcId: string, waypointId: string): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/canon/episode/${episodeId}/position`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ arcId, waypointId }),
      })
      const payload: unknown = await res.json()
      if (!res.ok) {
        setProblem(
          (payload as { error?: string }).error ??
            'The declaration was refused, and said nothing about why.',
        )
      } else if (benchShow) {
        setCanon(payload as CanonBenchView)
      }
      if (roomEpisode) await loadRoom(roomEpisode)
    } finally {
      setBusy(false)
    }
  }

  async function launch(episodeId: string, stage: string): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episodeId, stage }),
      })
      const body = (await res.json()) as { runId?: string; error?: string }
      if (!res.ok) setProblem(body.error ?? 'The run was refused, and said nothing about why.')
      else if (body.runId) setRunId(body.runId)
      await loadView()
      if (checkEpisode) await loadChecks(checkEpisode)
      if (roomEpisode) await loadRoom(roomEpisode)
    } finally {
      setBusy(false)
    }
  }

  /**
   * One remediation, and the bench as the act left it.
   *
   * Every one of these raises, revises or records — not one ratifies (`remediation.ts`). The
   * bench is re-read afterwards rather than patched, for the same reason the canon section is:
   * the board, the wall and the cards are all computed off rows, and a screen that tried to
   * keep them in step by hand would be the remembered state this design refuses.
   */
  async function remediate(path: string, body: unknown): Promise<unknown> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload: unknown = await res.json()
      if (!res.ok) {
        setProblem(
          (payload as { error?: string }).error ??
            'The remediation was refused, and said nothing about why.',
        )
        return null
      }
      if (checkEpisode) await loadChecks(checkEpisode)
      if (roomEpisode) await loadRoom(roomEpisode)
      await loadView()
      return payload
    } finally {
      setBusy(false)
    }
  }

  /**
   * The pre-draft, which spends a call and **moves nothing**: what comes back lands in the
   * box for Ryan to edit, and applying is a separate click (4.3). His edit wins over the
   * model's words the same way a hand-made still does (D20).
   */
  async function predraft(findingId: string): Promise<void> {
    const drafted = (await remediate(`/api/finding/${findingId}/predraft`, {})) as {
      replacement?: string
      sentence?: string
    } | null
    if (!drafted?.replacement) return
    setCheckDraft((held) => ({
      ...held,
      replacements: { ...held.replacements, [findingId]: drafted.replacement! },
      drafted: { ...held.drafted, [findingId]: drafted.sentence ?? '' },
    }))
  }

  async function rule(gateId: string, verdict: 'approve' | 'reject' | 'override'): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      // An override carries the same optional words an approval does. They are two verbs and
      // two rows in the ledger, forever (invariant 3) — never one verb with a flag on it.
      const body =
        verdict === 'reject'
          ? {
              notes: [
                {
                  note: draft.note,
                  ...(draft.depth === '' ? {} : { depth: draft.depth }),
                  ...(draft.target === '' ? {} : { target: draft.target }),
                },
              ],
            }
          : { comment: draft.comment }
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
      // An override takes D12's wall down (`stage-wall.ts`), and the bench is where Ryan
      // watches it fall. Nothing wrote an unblock — this is a re-read of the same question.
      if (checkEpisode) await loadChecks(checkEpisode)
      // A rejection lands a note that the next writer run reads back off the desk, so the
      // room's inspector is where "it provably read it" is seen — before the next click.
      if (roomEpisode) await loadRoom(roomEpisode)
    } finally {
      setBusy(false)
    }
  }

  /**
   * One act at the bench, and the bench as the act left it. Every canon endpoint answers
   * with the recomposed view, so the section — entities, facts, queue and ledger — re-renders
   * off `canon_ruling` the moment a ruling lands, without a second round trip.
   */
  async function act(path: string, body: unknown): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`${path}?${controls}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload: unknown = await res.json()
      if (!res.ok) {
        setProblem(
          (payload as { error?: string }).error ?? 'The bench refused, and said nothing about why.',
        )
      } else {
        setCanon(payload as CanonBenchView)
        // The form is what the act consumed, so it empties: a create form left full is one
        // that raises the same sheet twice. It takes the queue's notes with it, which is
        // the cost of one draft object — the queue rules one proposal at a time anyway.
        setBench(EMPTY_BENCH)
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * **One rider, one ruling** (E4-6). The sweep answers with the pass as the ruling left it,
   * so the rider that was just disposed of moves out of the list and onto the record without a
   * second round trip — and the episode card's own sentence is re-read beside it, because "N
   * proposals still ride ep02" is computed from the same queue this just changed.
   *
   * There is deliberately no sibling of this that takes a list.
   */
  async function ruleRider(
    proposalId: string,
    verdict: 'ratify' | 'reject' | 'defer',
  ): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const res = await fetch(`/api/sweep/proposal/${proposalId}/${verdict}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: sweepDraft.notes[proposalId] ?? '' }),
      })
      const payload: unknown = await res.json()
      if (!res.ok) {
        setProblem(
          (payload as { error?: string }).error ?? 'The ruling was refused, and said nothing why.',
        )
      } else {
        setSweep(payload as SweepView)
        setSweepDraft(EMPTY_SWEEP)
      }
      await loadView()
      // A ratified rider is canon now, so the bench's own facts, ledger and queue have all
      // moved. Re-read rather than patched: every number on it is computed off rows.
      if (benchShow) await loadCanon(benchShow, controls)
      // And so has every desk in the room: a fact ratified onto this episode reaches its own
      // writer as `established-here` rather than as a claim still riding (`write-context.ts`).
      if (roomEpisode) await loadRoom(roomEpisode)
    } finally {
      setBusy(false)
    }
  }

  const sheetBody = (form: SheetForm, relations: Edge[]): Record<string, unknown> => ({
    categoryKey: form.categoryKey,
    name: form.name,
    standing: form.standing,
    aliases: form.aliases,
    facts: form.facts,
    body: form.body,
    usageContext: form.usageContext,
    relations,
  })

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
      onLaunch={(episode, stage) => void launch(episode.id, stage ?? episode.launchStage)}
      editing={editing}
      onEdit={(artifactId) => void openEdit(artifactId)}
      onEditDraft={(text) => setEditing(editing && { ...editing, text })}
      onLandEdit={() => void landEdit()}
      onCancelEdit={() => setEditing(null)}
      onShowRun={setRunId}
      onRule={(gateId, verdict) => void rule(gateId, verdict)}
      onShowBench={(id) => {
        setBenchShow(id)
        setEntityId(null)
      }}
      onShowChecks={(episodeId) => {
        setCheckEpisode(episodeId)
        setCheckDraft(EMPTY_CHECK_DRAFT)
      }}
      checkEpisode={checkEpisode}
      roomEpisode={roomEpisode}
      onShowRoom={(episodeId) => {
        setRoomEpisode(episodeId)
        setOpenDesk(null)
      }}
      room={
        room === null || roomEpisode === null
          ? null
          : {
              room,
              busy,
              openDesk,
              onOpenDesk: setOpenDesk,
              onLaunch: (stage) => void launch(roomEpisode, stage),
              note: { note: draft.note, depth: draft.depth, target: draft.target },
              onNote: (next) => setDraft({ ...draft, ...next }),
              onRule: (gateId, verdict) => void rule(gateId, verdict),
              onEdit: (artifactId) => void openEdit(artifactId),
              onDeclare: (arcId, waypointId) => void declare(roomEpisode, arcId, waypointId),
              onShowSweep: (episodeId) => {
                setSweepEpisode(episodeId)
                setSweepDraft(EMPTY_SWEEP)
              },
              onShowRun: setRunId,
              onClose: () => setRoomEpisode(null),
            }
      }
      sweepEpisode={sweepEpisode}
      onShowSweep={(episodeId) => {
        setSweepEpisode(episodeId)
        setSweepDraft(EMPTY_SWEEP)
      }}
      sweep={
        sweep === null || sweepEpisode === null
          ? null
          : {
              sweep,
              draft: sweepDraft,
              busy,
              onDraft: (next) => setSweepDraft({ ...sweepDraft, ...next }),
              onRule: (proposalId, verdict) => void ruleRider(proposalId, verdict),
              onClose: () => setSweepEpisode(null),
            }
      }
      checks={
        checks === null || checkEpisode === null
          ? null
          : {
              checks,
              draft: checkDraft,
              busy,
              onDraft: (next) => setCheckDraft({ ...checkDraft, ...next }),
              onRun: (stage) => void launch(checkEpisode, stage),
              onPredraft: (findingId) => void predraft(findingId),
              onApply: (findingId) =>
                void remediate(`/api/finding/${findingId}/rewrite`, {
                  // Verbatim, character for character: whatever he settled on is what lands
                  // (D20). Nothing here trims, tidies or re-wraps it on the way past.
                  replacement: checkDraft.replacements[findingId] ?? '',
                }),
              onPropose: (findingId) =>
                void remediate(`/api/finding/${findingId}/canon-change`, {
                  statement: checkDraft.statements[findingId] ?? '',
                }),
              onDismiss: (findingId) =>
                void remediate(`/api/finding/${findingId}/dismiss`, {
                  note: checkDraft.notes[findingId] ?? '',
                }),
              onRecheck: (artifactId, sceneId) =>
                void remediate(`/api/artifact/${artifactId}/recheck`, { sceneId }),
              onShowRun: setRunId,
            }
      }
      bench={
        canon === null || benchShow === null
          ? null
          : {
              canon,
              draft: bench,
              busy,
              asOf,
              onDraft: (next) => setBench({ ...bench, ...next }),
              onAsOf: setAsOf,
              onShowEntity: setEntityId,
              onFound: () => void act(`/api/canon/${benchShow}/found`, {}),
              onCreate: (categoryKey, relations) =>
                void act(
                  `/api/canon/${benchShow}/entity`,
                  sheetBody({ ...bench.create, categoryKey }, relations),
                ),
              onPromote: (id, relations) =>
                void act(`/api/canon/entity/${id}/promote`, sheetBody(bench.promote, relations)),
              onPropose: (factId) =>
                void act(`/api/canon/fact/${factId}/propose`, {
                  statement: bench.statements[factId] ?? '',
                  usageContext: bench.changeContext,
                }),
              onAddFact: (id) =>
                void act(`/api/canon/entity/${id}/fact`, {
                  field: bench.addition.field,
                  statement: bench.addition.statement,
                  usageContext: bench.changeContext,
                }),
              onRuleProposal: (proposalId, verdict) =>
                void act(`/api/proposal/${proposalId}/${verdict}`, {
                  note: bench.notes[proposalId] ?? '',
                }),
            }
      }
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
  onLaunch(episode: EpisodeOnThePage, stage?: string): void
  onShowRun(runId: string): void
  onRule(gateId: string, verdict: 'approve' | 'reject' | 'override'): void
  /**
   * **Ryan's two doors onto a written artifact** (E4-5): put it in front of himself for a
   * ruling, or type over it. Both offers were composed on the server, like every other
   * sentence on this page; what lives here is the textarea his words are typed into.
   */
  editing: { artifactId: string; text: string } | null
  onEdit(artifactId: string): void
  onEditDraft(text: string): void
  onLandEdit(): void
  onCancelEdit(): void
  /**
   * The canon section, whole — its view, its draft and its handlers in one object rather
   * than ten props threaded through a page that does nothing with any of them. Null until
   * the bench has answered, and on a library with no show in it at all.
   */
  bench: CanonBenchProps | null
  /** The checks section, whole (E3-7), on the same terms. Null until an episode is opened. */
  checks: CheckBenchProps | null
  /** Which episode's checks are on the bench, so the button for it can say it is already open. */
  checkEpisode: string | null
  /** Checks are scoped to an artifact, so an episode has to be chosen — never picked silently. */
  onShowChecks(episodeId: string): void
  /**
   * The completion sweep, whole (E4-6): the ruling pass an approved episode still owes canon,
   * one rider at a time. Null until one is opened — a pass that convened itself would be a
   * screen ruling on Ryan's behalf about when he sits down to it.
   */
  sweep: SweepProps | null
  /** Which episode's pass is open, so the button for it can say it already is. */
  sweepEpisode: string | null
  onShowSweep(episodeId: string): void
  /**
   * **The writing room, whole** (E4-7): the writing line's three buttons with the writer's
   * desk behind each, every gate readable, the doors onto each draft, the arc pin, and the
   * owed sweep. Null until one is opened — three desks composed for an episode Ryan is not
   * looking at is work nobody asked for.
   */
  room: WritingRoomProps | null
  /** Which episode's room is open, so the button for it can say it already is. */
  roomEpisode: string | null
  onShowRoom(episodeId: string): void
  /**
   * Which show the bench is standing at. Canon is scoped to a show and this page renders
   * one bench, so a library with two shows needs a way to say which — never a first one
   * picked silently.
   */
  onShowBench(showId: string): void
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

              {/* **The two doors the refusal above names** (E4-5): rule on it at its gate, or
                  edit it directly. Both offers, both freshness sentences and every routed note
                  were composed on the server; this renders the strings it was handed. */}
              {episode.artifacts.length > 0 && (
                <div>
                  <h4>What is written, and what you may do with it</h4>
                  {episode.artifacts.map((written) => (
                    <div key={written.id} style={ARTIFACT}>
                      <strong>
                        {written.kind} v{written.version} — {written.status}
                      </strong>
                      {written.staleBecause && (
                        <p>
                          <small>{written.staleBecause}</small>
                        </p>
                      )}
                      {written.standing.map((note) => (
                        <p key={note.note}>
                          <small>Standing against it: {note.sentence}</small>
                        </p>
                      ))}
                      <Button
                        offer={written.present}
                        busy={busy}
                        onClick={() => props.onLaunch(episode, written.presentStage)}
                      />
                      {props.editing?.artifactId === written.id ? (
                        <div>
                          <textarea
                            value={props.editing.text}
                            onChange={(event) => props.onEditDraft(event.target.value)}
                            rows={20}
                            style={{ width: '100%', fontFamily: 'inherit' }}
                          />
                          <Button
                            offer={written.edit}
                            busy={busy}
                            onClick={() => props.onLandEdit()}
                          />
                          <button type="button" onClick={() => props.onCancelEdit()}>
                            Leave it as it stands
                          </button>
                        </div>
                      ) : (
                        <Button
                          offer={written.edit}
                          busy={busy}
                          onClick={() => props.onEdit(written.id)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

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

              {/* **What approving the script left owed** (E4-6, 1.2). It is here and only
                  here while something rides — the sentence is computed off the queue, so it
                  appears with the riders and goes when the last one is ruled. Nothing about
                  it blocks the launch button above: it is Ryan's owed pass, never a wall. */}
              {episode.sweep && (
                <div style={ARTIFACT}>
                  <p>{episode.sweep.sentence}</p>
                  {props.sweepEpisode === episode.id ? (
                    <em>The completion sweep below is standing at {episode.label}.</em>
                  ) : (
                    <Button
                      offer={episode.sweep.open}
                      busy={busy}
                      onClick={() => props.onShowSweep(episode.id)}
                    />
                  )}
                </div>
              )}

              {/* Not an action and so not a costed sentence: it opens a read. The writing
                  room's own buttons are where anything is written or spent (E4-7). */}
              <p>
                {props.roomEpisode === episode.id ? (
                  <em>The writing room below is standing at {episode.label}.</em>
                ) : (
                  <button type="button" onClick={() => props.onShowRoom(episode.id)}>
                    Open the {episode.label} writing room below
                  </button>
                )}
              </p>

              {/* Not an action and so not a costed sentence: it opens a read. The check
                  bench's own buttons are where anything is run or spent (E3-7). */}
              <p>
                {props.checkEpisode === episode.id ? (
                  <em>The check bench below is standing at {episode.label}.</em>
                ) : (
                  <button type="button" onClick={() => props.onShowChecks(episode.id)}>
                    Open the {episode.label} check bench below
                  </button>
                )}
              </p>
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

              {/* The wall's third door (D12, E3-3): a red finding makes an artifact loud, Ryan
                  may carry on anyway, and what he did stays readable a season later. It is a
                  separate verb from approve and a separate row in the ledger (invariant 3). */}
              <Button
                offer={run.gate.override}
                busy={busy}
                onClick={() => props.onRule(run.gate!.id, 'override')}
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
              {/* The one precondition this section applies rather than reads — the note is in
                  a textarea the server has never seen. The SENTENCE is still the server's, and
                  it is the one the API refuses with (E4-7, `runner/gate.ts`). */}
              <Button
                offer={needing(run.gate.reject, draft.note, run.gate.rejectNeedsNote)}
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

      {/* Canon (E2-6). It rules through the same API the gate above does, and renders its
          rulings from the ledger rather than from the log — see the section's own note. */}
      {view.shows.length > 1 && (
        <p>
          Canon is scoped to a show. The bench below is standing at{' '}
          <strong>{props.bench?.canon.show.title ?? 'no show'}</strong>:{' '}
          {view.shows.map((show) => (
            <button key={show.id} type="button" onClick={() => props.onShowBench(show.id)}>
              Stand at the {show.title} bench
            </button>
          ))}
        </p>
      )}
      {props.bench && <CanonBench {...props.bench} />}

      {/* The writing room (E4-7). It renders what seven issues recorded and invents no
          mechanic: every button on it is a route that existed before it did. */}
      {props.room && <WritingRoom {...props.room} />}

      {/* Checks (E3-7). It renders what six issues recorded and records nothing of its own;
          the acts on it raise, revise or record, and not one of them ratifies. */}
      {props.checks && <CheckBench {...props.checks} />}

      {/* The completion sweep (E4-6). The one section on this page where ratifying happens
          over an episode's own claims — one rider at a time, each on its own row. */}
      {props.sweep && <Sweep {...props.sweep} />}

      <h2>Live</h2>
      <p>
        Every event this process has written, oldest first — replayed from the start when
        the page opens, so what a killed process wrote is still here after the restart.
        Runs and gates: a canon ruling made at the bench convenes neither, so it is on the
        ledger in the canon section above and not here.
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
