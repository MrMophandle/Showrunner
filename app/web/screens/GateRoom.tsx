import { useCallback, useEffect, useState } from 'react'
import type { ProposalOnTheBench } from '../../server/canon-bench.ts'
import type { EventRecord } from '../../server/events.ts'
import type {
  CardAtTheAnchor,
  DepthChoice,
  GateIndexView,
  GateRoomView,
  RoundAtTheGate,
  SayAtTheGate,
} from '../../server/gate-room.ts'
import type { NoteDepth } from '../../server/runner/gate.ts'
import { Card, Section } from '../chrome/Card.tsx'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { LiveRegion } from '../chrome/LiveRegion.tsx'
import { onLinkClick } from '../chrome/router.ts'
import { SectionHeader } from '../chrome/SectionHeader.tsx'
import { needing, SentenceButton, SentenceLink } from '../chrome/SentenceButton.tsx'
import type { ScreenProps } from '../chrome/Shell.tsx'
import { applyProse, type Prose } from './Floor.tsx'
import './gate-room.css'

/**
 * **The gate room** — one decision, the whole of what it is about (E5-3, #83; 5.3, D15, D21).
 *
 * ── The artifact is the page ───────────────────────────────────────────────────
 * The draft is rendered as a document, in its own scrolling box, with the quoted spans marked
 * where they are and one card per cluster folded in under each. `fold.pieces` arrives already
 * in document order (`server/gate-room.ts`), so this file slices nothing and orders nothing —
 * it renders three shapes and the union makes leaving one out a compile error.
 *
 * ── The dock is pinned, and the composer expands inside it ─────────────────────
 * `position: fixed` at the bottom, always visible, verbs as sentences. Pressing a verb that
 * takes notes grows the dock upward — **never a popup** (the ruled pattern, felt on the review
 * desk): the draft stays on screen while he says what is wrong with it. `Esc` collapses it and
 * files nothing, and what he typed stays where it was.
 *
 * Because the dock is out of flow, none of that can move the page. That is the whole reason
 * the mockup's own geometry was kept rather than adapted (`gate-room.css`).
 *
 * ── It writes no word ──────────────────────────────────────────────────────────
 * Every sentence, cost, refusal, verdict word, depth explanation and stale tag comes down the
 * wire. `gate-room.test.tsx` proves it the way the floor's and the room's tests do: hand it a
 * view of empty strings and see whether anything comes out.
 *
 * ── The one precondition it applies ────────────────────────────────────────────
 * A rejection and a close each need a note, and the note lives in a textarea the server has
 * never seen. So the SCREEN applies it — in the API's own sentence, off the wire (`needing`),
 * which is the same string the POST refuses with. It is the only disabled state any of the
 * four verbs may ever have: nothing about the findings disables anything here, because checks
 * argue and never veto (invariant 3, D12).
 */

/** One note as Ryan is writing it. `depth` '' is unrouted — the legal default (D21). */
export interface NoteInProgress {
  note: string
  depth: NoteDepth | ''
  target: string
}

/** What Ryan has typed in this room and not yet filed. */
export interface GateDraft {
  /** Which verb's composer is expanded in the dock. Null when none is. */
  composer: 'reject' | 'close' | null
  /** The notes being written, in the order he wrote them. Held across an Esc. */
  notes: NoteInProgress[]
  /** His optional words on an approval or an override. */
  comment: string
  /** Per finding: the replacement, the dismissal note, the new statement, the last pre-draft. */
  replacements: Record<string, string>
  findingNotes: Record<string, string>
  statements: Record<string, string>
  drafted: Record<string, string>
  /** Per rider: the note a rejection needs. */
  riderNotes: Record<string, string>
  /**
   * Which say's remediations are folded open, by finding. A fold rather than a fetch, because
   * reading one is free — and folded rather than always open, because a card is INSIDE the
   * script here and four open boxes are taller than the draft they are about.
   */
  openSay: string | null
}

export const EMPTY_NOTE: NoteInProgress = { note: '', depth: '', target: '' }

export const EMPTY_GATE_DRAFT: GateDraft = {
  composer: null,
  notes: [EMPTY_NOTE],
  comment: '',
  replacements: {},
  findingNotes: {},
  statements: {},
  drafted: {},
  riderNotes: {},
  openSay: null,
}

export function GateRoom(props: ScreenProps) {
  return props.id === null ? <GateIndex {...props} /> : <OneGate {...props} />
}

// ── One gate ────────────────────────────────────────────────────────────────────

function OneGate({ id, cockpit }: ScreenProps) {
  const [view, setView] = useState<GateRoomView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [stream, setStream] = useState<GateRoomView['stream'] | null>(null)
  const [prose, setProse] = useState<Prose>({})
  const [draft, setDraft] = useState<GateDraft>(EMPTY_GATE_DRAFT)

  const load = useCallback(async (): Promise<void> => {
    if (id === null) return
    try {
      const res = await fetch(`/api/gate/${id}`)
      if (!res.ok) {
        setProblem(((await res.json()) as { error?: string }).error ?? null)
        return
      }
      const next = (await res.json()) as GateRoomView
      setView(next)
      setStream((held) => held ?? next.stream)
      setProse((held) => seedGate(held, next))
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!stream) return
    // Opened at the position the first read was taken from, so the replay is the gap rather
    // than the whole log. Anything served twice is dropped by `applyProse`'s own seq check —
    // E5-1's protocol, reused rather than reinvented.
    const source = new EventSource(`/api/events?since=${stream.since}`)
    for (const kind of stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        setProse((held) => applyProse(held, record))
        if (stream.prose.includes(record.kind)) return
        void load()
      })
    }
    return () => source.close()
  }, [stream, load])

  /** One act, one refusal path: the API answers in the words the button was already showing. */
  const act = useCallback(
    async (key: string, path: string, body: unknown, after?: () => void): Promise<void> => {
      setBusy(key)
      setProblem(null)
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        const answered = (await res.json()) as { error?: string }
        if (!res.ok) setProblem(answered.error ?? null)
        else after?.()
        await load()
      } catch (error) {
        setProblem(`The API did not answer: ${String(error)}`)
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? cockpit.destinations[2]!.explains}
      </p>
    )
  }

  return (
    <GateRoomScreen
      view={view}
      prose={prose}
      draft={draft}
      busy={busy}
      problem={problem}
      onDraft={(next) => setDraft((held) => ({ ...held, ...next }))}
      onRule={(verdict) =>
        void act(
          verdict,
          `/api/gate/${view.gateId}/${verdict}`,
          verdict === 'reject' || verdict === 'close'
            ? { notes: notesOnTheWire(draft.notes) }
            : { comment: draft.comment },
          () => setDraft(EMPTY_GATE_DRAFT),
        )
      }
      onPredraft={(findingId) => {
        setBusy(findingId)
        setProblem(null)
        void (async () => {
          try {
            const res = await fetch(`/api/finding/${findingId}/predraft`, { method: 'POST' })
            const held = (await res.json()) as {
              error?: string
              replacement?: string
              sentence?: string
            }
            if (!res.ok) setProblem(held.error ?? null)
            else
              setDraft((was) => ({
                ...was,
                replacements: { ...was.replacements, [findingId]: held.replacement ?? '' },
                drafted: { ...was.drafted, [findingId]: held.sentence ?? '' },
              }))
            await load()
          } finally {
            setBusy(null)
          }
        })()
      }}
      onApply={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/rewrite`, {
          replacement: draft.replacements[findingId] ?? '',
        })
      }
      onPropose={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/canon-change`, {
          statement: draft.statements[findingId] ?? '',
        })
      }
      onDismiss={(findingId) =>
        void act(findingId, `/api/finding/${findingId}/dismiss`, {
          note: draft.findingNotes[findingId] ?? '',
        })
      }
      onRuleRider={(proposalId, verdict) =>
        void act(proposalId, `/api/sweep/proposal/${proposalId}/${verdict}`, {
          note: draft.riderNotes[proposalId] ?? '',
        })
      }
    />
  )
}

/**
 * The notes as the API takes them — blank ones dropped, and a depth omitted rather than sent
 * as an empty string.
 *
 * Dropping the blanks is not the precondition: the BUTTON is disabled while every note is
 * empty, in the API's own sentence. This is about the row that would otherwise be written for
 * a second note he started and left — a `gate_note` with no words in it is a note Ryan never
 * gave, kept forever.
 */
export function notesOnTheWire(
  notes: readonly NoteInProgress[],
): { note: string; depth?: NoteDepth; target?: string }[] {
  return notes
    .filter((one) => one.note.trim() !== '')
    .map((one) => ({
      note: one.note,
      ...(one.depth === '' ? {} : { depth: one.depth }),
      ...(one.target.trim() === '' ? {} : { target: one.target }),
    }))
}

/**
 * The prose a browser missed, off the server's read — so a page opened while the run behind
 * this gate is still talking shows the line it is on rather than an empty box. Seeded once and
 * never overwritten, for `Floor.tsx`'s reason.
 */
export function seedGate(held: Prose, view: GateRoomView): Prose {
  const live = view.live
  if (held[live.runId] !== undefined) return held
  return {
    ...held,
    [live.runId]: { latest: live.latest, chunks: [...live.stream], seq: live.seq },
  }
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface GateRoomScreenProps {
  view: GateRoomView
  prose: Prose
  draft: GateDraft
  busy: string | null
  problem: string | null
  onDraft(next: Partial<GateDraft>): void
  onRule(verdict: 'approve' | 'override' | 'reject' | 'close'): void
  onPredraft(findingId: string): void
  onApply(findingId: string): void
  onPropose(findingId: string): void
  onDismiss(findingId: string): void
  onRuleRider(proposalId: string, verdict: 'ratify' | 'reject' | 'defer'): void
}

export function GateRoomScreen(props: GateRoomScreenProps) {
  const { view, draft } = props
  const said = props.prose[view.live.runId]

  /**
   * `Esc` collapses the composer with nothing filed, and what he typed stays held — the ruled
   * behaviour, and the same one the review desk's composer has. Bound on the document rather
   * than on the dock so it works while his hand is anywhere on the page.
   */
  useEffect(() => {
    if (draft.composer === null) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onDraft({ composer: null })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [draft.composer, props])

  return (
    <div className="gate">
      <header className="gate-head">
        <p className="crumb">
          <a
            className="gate-crumb__back"
            href={view.floorHref}
            onClick={onLinkClick(view.floorHref)}
          >
            {view.floorName}
          </a>{' '}
          ·{' '}
          <a
            href={view.episodeHref}
            onClick={onLinkClick(view.episodeHref)}
            title={view.episodeRoomNotYet ?? view.episodeRoom}
          >
            {view.episodeCrumb}
          </a>{' '}
          · {view.where}
        </p>
        <div className="gate-head__line">
          <h1>{view.title}</h1>
          <span className="gate-chip" data-open={view.isOpen}>
            {view.chip}
          </span>
        </div>
        <span className="gate-head__standing">{view.standing}</span>
      </header>

      <div className="gate-cols stacks">
        <div>
          <Fold {...props} />
        </div>

        <div>
          <Board {...props} />
          <Loop {...props} />
          <Riders {...props} />
          <Rounds {...props} />
          <Card className="gate-panel">
            {/*
             * Always rendered, idle or not. A region that appeared when the run resumed would
             * move the page by existing, which is the defect it exists to end (E5-0).
             */}
            <div className="gate-body gate-body--live">
              <LiveRegion
                id={`live-${view.gateId}`}
                heading={view.live.heading}
                latest={said?.latest ?? view.live.latest}
                stream={said?.chunks ?? view.live.stream}
                entries={view.live.entries}
                idle={view.live.idle}
              />
            </div>
          </Card>
        </div>
      </div>

      {props.problem !== null && (
        <p className="gate-problem" role="alert">
          {props.problem}
        </p>
      )}

      <Dock {...props} />
    </div>
  )
}

// ── The draft, folded ───────────────────────────────────────────────────────────

/**
 * The artifact as a document, with the cards where their spans are.
 *
 * Three shapes and three renderings, off a union — a fourth piece would not compile until it
 * were handled, which is what keeps a card from silently vanishing out of the middle of a
 * script. Nothing here decides where a piece goes: `server/gate-room.ts` already sliced it.
 */
function Fold(props: GateRoomScreenProps) {
  const fold = props.view.fold
  return (
    <Section
      name={props.view.headings.artifact.name}
      explains={props.view.headings.artifact.explains}
      className="gate-panel"
    >
      <div className="gate-fold">
        <p className="gate-fold__head">{fold.docHeader}</p>
        <span className="gate-fold__note">{fold.sentence}</span>
        {fold.note !== null ? (
          <EmptyState lead={fold.docHeader} sentence={fold.note} />
        ) : (
          <div className="gate-doc">
            {fold.pieces.map((piece, index) => {
              if (piece.kind === 'prose') return <span key={index}>{piece.text}</span>
              if (piece.kind === 'span') {
                return (
                  <mark key={index} id={`span-${piece.cardId}`} data-blocking={piece.blocking}>
                    {piece.text}
                  </mark>
                )
              }
              return <Anchored key={index} card={piece.card} {...props} />
            })}
          </div>
        )}
      </div>
    </Section>
  )
}

/** One cluster's card, at its anchor: every reviewer's say, and 4.3's three remediations. */
function Anchored({ card, ...props }: { card: CardAtTheAnchor } & GateRoomScreenProps) {
  return (
    <div className="gate-card" id={card.id} data-blocking={card.blocking}>
      <span className="gate-card__where">{card.where}</span>
      {card.says.map((say) => (
        <Say key={say.findingId} say={say} {...props} />
      ))}
    </div>
  )
}

/**
 * One reviewer's say.
 *
 * Severity and confidence arrive side by side inside `say.sentence`, composed by `panel.ts`
 * where a say is defined — two values, never one (invariant 4), and never folded into a tick.
 * `blockingSentence` is `stage-wall.ts`'s, so a red mark at a gate can never read as a veto
 * OVER the gate: it says, in words, that it blocks the next stage and not this ruling.
 */
function Say({ say, ...props }: { say: SayAtTheGate } & GateRoomScreenProps) {
  const { draft, view } = props
  const id = say.findingId
  const replacement = draft.replacements[id] ?? ''
  const statement = draft.statements[id] ?? ''
  const note = draft.findingNotes[id] ?? ''

  return (
    <div className="gate-say" id={`finding-${id}`}>
      <div className="gate-say__line">
        <span className={`tag ${say.blocking ? 'tag--critical' : 'tag--warn'}`}>{say.status}</span>
        <span className="gate-say__meta">{say.sentence}</span>
      </div>
      <p className="gate-say__concern">{say.concern}</p>
      {say.facts.map((fact) => (
        <span className="gate-say__meta" key={fact}>
          {fact}
        </span>
      ))}
      {say.blockingSentence !== null && (
        <span className="gate-say__meta">{say.blockingSentence}</span>
      )}
      {say.dismissal !== null && (
        <span className="gate-say__meta">
          {say.dismissal.note} · {say.dismissal.at}
        </span>
      )}
      {/* E3-6's loop, closed on screen: an open twin, and why the wall stayed down. */}
      {say.inherited !== null && <span className="gate-say__meta">{say.inherited.sentence}</span>}
      {draft.drafted[id] !== undefined && (
        <span className="gate-say__meta">{draft.drafted[id]}</span>
      )}

      {/*
       * The fold. It opens IN PLACE, inside the card, inside the script — the same movement
       * the composer makes in the dock and the desk makes in the episode room, and it happens
       * because Ryan clicked, which is the one movement this page allows.
       */}
      <button
        type="button"
        className="editlink"
        id={`acts-${id}`}
        onClick={() => props.onDraft({ openSay: draft.openSay === id ? null : id })}
      >
        {say.open}
      </button>
      {draft.openSay !== id ? null : (
      <>
      <label>
        {say.remediations.apply.sentence}
        <textarea
          rows={3}
          value={replacement}
          onChange={(event) =>
            props.onDraft({ replacements: { ...draft.replacements, [id]: event.target.value } })
          }
        />
      </label>
      <div className="gate-say__acts">
        <SentenceButton
          offer={say.remediations.predraft}
          busy={props.busy === id}
          onClick={() => props.onPredraft(id)}
          dense
        />
        <SentenceButton
          offer={needing(
            say.remediations.apply,
            replacement,
            view.refusals.rewriteNeedsReplacement,
          )}
          busy={props.busy === id}
          onClick={() => props.onApply(id)}
          dense
        />
      </div>

      <label>
        {say.remediations.propose.sentence}
        <input
          value={statement}
          onChange={(event) =>
            props.onDraft({ statements: { ...draft.statements, [id]: event.target.value } })
          }
        />
      </label>
      <label>
        {say.remediations.dismiss.sentence}
        <textarea
          rows={2}
          value={note}
          onChange={(event) =>
            props.onDraft({ findingNotes: { ...draft.findingNotes, [id]: event.target.value } })
          }
        />
      </label>
      <div className="gate-say__acts">
        <SentenceButton
          offer={needing(say.remediations.propose, statement, view.refusals.changeNeedsStatement)}
          busy={props.busy === id}
          onClick={() => props.onPropose(id)}
          dense
        />
        <SentenceButton
          offer={needing(say.remediations.dismiss, note, view.refusals.dismissNeedsNote)}
          busy={props.busy === id}
          onClick={() => props.onDismiss(id)}
          dense
          quiet
        />
      </div>
      </>
      )}
    </div>
  )
}

// ── The rail ────────────────────────────────────────────────────────────────────

/** One row per convened reviewer. The dot is a second reading of a word, never the only one. */
function Board({ view }: GateRoomScreenProps) {
  return (
    <Section
      name={view.headings.board.name}
      explains={view.headings.board.explains}
      className="gate-panel"
    >
      <div className="gate-body gate-body--board">
        <span className="gate-note">{view.board.sentence}</span>
        {view.board.rows.map((row) => (
          <div className="gate-row" key={row.checkKey} data-check={row.checkKey}>
            <span className="gate-dot" data-verdict={row.verdict} aria-hidden="true" />
            <span className="gate-row__who">{row.label}</span>
            <span className="gate-row__what">
              {row.verdict} — {row.what}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/** Every draft a check has read, walkable — the machine's own argument with itself (4.4). */
function Loop({ view }: GateRoomScreenProps) {
  const loop = view.loop
  return (
    <Section
      name={view.headings.loop.name}
      explains={view.headings.loop.explains}
      className="gate-panel"
    >
      <div className="gate-body gate-body--loop">
        <span className="gate-note">{loop.sentence}</span>
        {loop.none !== null ? (
          <EmptyState lead={loop.none.lead} sentence={loop.none.sentence} />
        ) : (
          loop.drafts.map((one) => (
            <div className="gate-row" key={one.round} data-current={one.current}>
              <span className="gate-row__who">Round {one.round}</span>
              <span className="gate-row__what">{one.sentence}</span>
            </div>
          ))
        )}
        {loop.blocking.map((one) => (
          <span className="gate-note gate-note--warn" key={one.findingId}>
            {one.sentence}
          </span>
        ))}
      </div>
    </Section>
  )
}

/**
 * Every round, kept exactly as it was ruled. A stale one is MARKED and never replaced, and
 * the mark is the server's whole sentence — computed off the two rounds' versions, with no
 * flag anywhere in the schema (0004, `server/gate-room.ts`).
 */
function Rounds({ view }: GateRoomScreenProps) {
  return (
    <Section
      name={view.headings.rounds.name}
      explains={view.headings.rounds.explains}
      className="gate-panel"
    >
      <div className="gate-body gate-body--rounds">
        {view.rounds.map((round) => (
          <Round key={round.round} round={round} />
        ))}
      </div>
    </Section>
  )
}

function Round({ round }: { round: RoundAtTheGate }) {
  return (
    <div className="gate-round" id={`round-${round.round}`}>
      <span className="gate-round__name">{round.name}</span>
      <span className="gate-note">{round.standing}</span>
      {round.staleTag !== null && <span className="gate-round__stale">{round.staleTag}</span>}
      {round.ruling !== null && (
        <>
          <span className="gate-note">{round.ruling.sentence}</span>
          {round.ruling.comment !== null && (
            <span className="gate-round__quote">{round.ruling.comment}</span>
          )}
          {round.ruling.notes.map((note, index) => (
            <span key={index}>
              <span className="gate-round__quote">{note.note}</span>
              <span className="gate-note">{note.routing}</span>
            </span>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * What rides the episode, each with its five parts and its own three verbs. **There is
 * deliberately no button that rules them all** — three riders take three rulings and leave
 * three rows on the ledger (1.2), and ruling on the draft is not a ruling on any of them.
 */
function Riders(props: GateRoomScreenProps) {
  const sweep = props.view.sweep
  return (
    <Section
      name={props.view.headings.riders.name}
      explains={props.view.headings.riders.explains}
      className="gate-panel"
    >
      <div className="gate-body gate-body--riders">
        <span className="gate-rider__what">{sweep.sentence}</span>
        {sweep.nothingBecause !== null && (
          <span className="gate-rider__part">{sweep.nothingBecause}</span>
        )}
        {sweep.riders.map((rider) => (
          <Rider key={rider.id} rider={rider} {...props} />
        ))}
        {sweep.ruled.map((rider) => (
          <span className="gate-rider__part" key={rider.id}>
            {rider.status} — {rider.sentence}
          </span>
        ))}
      </div>
    </Section>
  )
}

function Rider({ rider, ...props }: { rider: ProposalOnTheBench } & GateRoomScreenProps) {
  const note = props.draft.riderNotes[rider.id] ?? ''
  return (
    <div className="gate-rider" id={`rider-${rider.id}`}>
      <span className="gate-rider__what">{rider.sentence}</span>
      {rider.change.map((line) => (
        <span className="gate-rider__part" key={line}>
          {line}
        </span>
      ))}
      <span className="gate-rider__part">{rider.usageContext}</span>
      {/* Computed at read time and never stored — the freshness pattern (1.2). */}
      <span className="gate-rider__part">{rider.implications}</span>
      {rider.alternatives.map((alternative) => (
        <span className="gate-rider__part" key={alternative}>
          {alternative}
        </span>
      ))}
      <div className="gate-offer">
        <SentenceButton
          offer={rider.ratify}
          busy={props.busy === rider.id}
          onClick={() => props.onRuleRider(rider.id, 'ratify')}
          wide
          dense
          ruling
        />
      </div>
      <label>
        {rider.reject.sentence}
        <textarea
          rows={2}
          value={note}
          onChange={(event) =>
            props.onDraft({
              riderNotes: { ...props.draft.riderNotes, [rider.id]: event.target.value },
            })
          }
        />
      </label>
      <div className="gate-offer">
        <SentenceButton
          offer={needing(rider.reject, note, props.view.sweep.refusals.rejectNeedsNote)}
          busy={props.busy === rider.id}
          onClick={() => props.onRuleRider(rider.id, 'reject')}
          wide
          dense
        />
      </div>
      <div className="gate-offer">
        <SentenceButton
          offer={rider.defer}
          busy={props.busy === rider.id}
          onClick={() => props.onRuleRider(rider.id, 'defer')}
          wide
          dense
          quiet
        />
      </div>
    </div>
  )
}

// ── The decision dock ───────────────────────────────────────────────────────────

/**
 * Pinned to the bottom, always visible, four verbs as sentences — and the composer expanding
 * IN PLACE above them when one of the two that take notes is pressed.
 *
 * The two note-taking verbs open a composer rather than firing: a verb whose object is a note
 * cannot be pressed until the note exists, and the disabled confirm inside the composer is
 * where that is said, in the sentence the API refuses with. The two that do not take notes
 * fire straight off the dock, because there is nothing to write first.
 */
function Dock(props: GateRoomScreenProps) {
  const { view, draft } = props
  const dock = view.dock
  const open = draft.composer

  return (
    <div className="gate-dock">
      <div className="gate-dock__inner">
        {open !== null && <Composer {...props} verb={open} />}
        <div className="gate-dock__verbs">
          <span className="gate-dock__headline">{dock.headline}</span>
          <SentenceButton
            offer={dock.approve}
            busy={props.busy === 'approve'}
            onClick={() => props.onRule('approve')}
            dense
            ruling
          />
          <SentenceButton
            offer={dock.override}
            busy={props.busy === 'override'}
            onClick={() => props.onRule('override')}
            dense
          />
          {/*
           * These two open the composer. They carry the gate's own offer — its sentence, its
           * cost and, when the round is already ruled, its refusal — so a ruled gate's dock is
           * disabled in the words the API would refuse with, before anything expands.
           */}
          <SentenceButton
            offer={dock.reject}
            busy={false}
            onClick={() => props.onDraft({ composer: 'reject' })}
            dense
          />
          <SentenceButton
            offer={dock.close}
            busy={false}
            onClick={() => props.onDraft({ composer: 'close' })}
            dense
            quiet
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The composer, expanded inside the dock — never a popup, so the draft stays on screen.
 *
 * One block per note, each with its own depth picker, because D21 routes per NOTE: "the pier
 * scene is wrong" and "the outline never turns" are two instructions that go two places, and a
 * single depth for a whole rejection would send one of them to the wrong artifact forever.
 */
function Composer({ verb, ...props }: { verb: 'reject' | 'close' } & GateRoomScreenProps) {
  const { view, draft } = props
  const dock = view.dock
  const offer = verb === 'reject' ? dock.reject : dock.close
  const refusal = verb === 'reject' ? dock.rejectNeedsNote : dock.closeNeedsNote
  const written = draft.notes.map((one) => one.note).join('')

  const change = (index: number, next: Partial<NoteInProgress>) =>
    props.onDraft({
      notes: draft.notes.map((one, at) => (at === index ? { ...one, ...next } : one)),
    })

  return (
    <div className="gate-composer" id={`composer-${verb}`}>
      <p className="gate-composer__h">
        {verb === 'reject' ? dock.rejectComposer : dock.closeComposer}
      </p>

      {draft.notes.map((note, index) => (
        <div className="gate-composer__note" key={index}>
          <textarea
            id={`note-${index}`}
            rows={3}
            value={note.note}
            onChange={(event) => change(index, { note: event.target.value })}
          />
          <div className="gate-depths">
            {dock.depths.map((choice) => (
              <Depth
                key={choice.depth}
                choice={choice}
                index={index}
                picked={note.depth === choice.depth}
                onPick={() => change(index, { depth: choice.depth, target: '' })}
              />
            ))}
          </div>
          {pickedDepth(dock.depths, note.depth)?.needsTarget === true && (
            <input
              id={`target-${index}`}
              value={note.target}
              onChange={(event) => change(index, { target: event.target.value })}
              aria-label={pickedDepth(dock.depths, note.depth)!.because}
            />
          )}
        </div>
      ))}

      <div className="gate-composer__foot">
        <button
          type="button"
          className="editlink"
          id="another-note"
          onClick={() => props.onDraft({ notes: [...draft.notes, EMPTY_NOTE] })}
        >
          {ANOTHER_NOTE}
        </button>
        <span className="gate-composer__hint">
          <span className="gate-kbd">Esc</span>
          {dock.escape}
        </span>
        <SentenceButton
          offer={needing(offer, written, refusal)}
          busy={props.busy === verb}
          onClick={() => props.onRule(verb)}
          dense
          ruling={verb === 'reject'}
        />
      </div>
    </div>
  )
}

/**
 * The one string this file authors, and it is about the FORM rather than about the product —
 * "one more of the field you are already looking at". Every word that says what the app does,
 * costs, or refuses comes down the wire (E4-7's rule, #80's extension of it).
 */
const ANOTHER_NOTE = '+ another note'

function Depth({
  choice,
  index,
  picked,
  onPick,
}: {
  choice: DepthChoice
  index: number
  picked: boolean
  onPick: () => void
}) {
  return (
    <label className="gate-depth" data-picked={picked} data-depth={choice.depth}>
      <input
        type="radio"
        name={`depth-${index}`}
        checked={picked}
        onChange={onPick}
        value={choice.depth}
      />
      <b>{choice.label}</b> {choice.because}
    </label>
  )
}

const pickedDepth = (
  depths: readonly DepthChoice[],
  depth: NoteDepth | '',
): DepthChoice | undefined => depths.find((one) => one.depth === depth)

// ── The index ───────────────────────────────────────────────────────────────────

/**
 * The thin index: every gate waiting on Ryan, oldest first, each a sentence that links.
 *
 * Deliberately not a second floor. It is the answer to "I typed /gate, what is open" — and it
 * is a list of LINKS, because a decision is made in the room that renders its artifact and
 * nowhere else (one artifact, one ruling).
 */
function GateIndex({ cockpit }: ScreenProps) {
  const [view, setView] = useState<GateIndexView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/gate')
      setView((await res.json()) as GateIndexView)
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!view) return
    const source = new EventSource(`/api/events?since=${view.stream.since}`)
    for (const kind of view.stream.kinds) {
      source.addEventListener(kind, (event) => {
        const record = JSON.parse((event as MessageEvent).data) as EventRecord
        if (view.stream.prose.includes(record.kind)) return
        void load()
      })
    }
    return () => source.close()
    // The stream is opened once, at the position the first read was taken from — `view` is in
    // the dependency list only so that position is available, and re-reading does not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view === null, load])

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? cockpit.destinations[2]!.explains}
      </p>
    )
  }

  return <GateIndexScreen view={view} />
}

export function GateIndexScreen({ view }: { view: GateIndexView }) {
  return (
    <div className="gate">
      <SectionHeader name={view.heading.name} explains={view.heading.explains}>
        {view.gates.length > 0 && <span className="section-h__count">{view.gates.length}</span>}
      </SectionHeader>
      <Card className="gate-panel">
        {view.empty !== null ? (
          <EmptyState lead={view.empty.lead} sentence={view.empty.sentence} />
        ) : (
          view.gates.map((gate) => (
            <div className="gate-index__row" key={gate.gateId} id={`open-${gate.gateId}`}>
              <span className="gate-index__sentence">{gate.sentence}</span>
              <SentenceLink offer={gate.open} href={gate.href} ruling dense />
            </div>
          ))
        )}
      </Card>
    </div>
  )
}
