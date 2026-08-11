import { useCallback, useEffect, useState } from 'react'
import type { RequiredRelation } from '../../server/canon-bench.ts'
import type {
  CanonLibraryView,
  EntityInTheLibrary,
  FactInTheLibrary,
  KindInTheLibrary,
} from '../../server/canon-library.ts'
import type { EventRecord } from '../../server/events.ts'
import { Card, Section } from '../chrome/Card.tsx'
import { EmptyState } from '../chrome/EmptyState.tsx'
import { onLinkClick } from '../chrome/router.ts'
import { SectionHeader } from '../chrome/SectionHeader.tsx'
import { needing, SentenceButton } from '../chrome/SentenceButton.tsx'
import type { ScreenProps } from '../chrome/Shell.tsx'
import './canon-library.css'

/**
 * **The canon library** — the bible, browsable, as of any moment (E5-4, #84; 5.4, D9, D22, D23).
 *
 * ── Three columns, and each one answers a different question ────────────────────
 * Left: *what is in this show* — every kind of canon it declares, every identity under each,
 * and the ones nobody has ruled marked as such. Middle: *what is true about this one*, read
 * at whatever point in time the control at the top is set to. Right: *what it is connected
 * to* — its references, its edges in both directions, the episodes written against it, and
 * the arcs those episodes stand on.
 *
 * ── It writes no word ──────────────────────────────────────────────────────────
 * Every sentence, label, cost, refusal, lineage line and honest empty comes down the wire
 * (E4-7's rule, extended to the whole chrome by #80) — including the labels on the forms,
 * because the word beside a box is what Ryan reads before he types in it.
 * `canon-library.test.tsx` proves it the way the floor's, the room's and the gate's tests do:
 * hand it a view of empty strings and see whether anything comes out.
 *
 * ── And it knows no kind of canon by name ──────────────────────────────────────
 * There is no word in this file for what an entity IS. The sidebar's entries, an identity's
 * chips, the inheritance blocks and the required edges on a form are all built out of what
 * the show declares, so declaring a new kind of canon lights all four up with nothing here
 * recompiled — and `canon-library.test.ts` fails if any of the show's own keys or names
 * appears in this file at all.
 *
 * ── The preconditions this screen owns ─────────────────────────────────────────
 * Four, and each lives in a field the server has never seen: a name, a new statement, an
 * added one, and a rejection's note. Each renders the API's own refusal off the wire
 * (`needing`), so the disabled button and the 409 are one string.
 */

/** A promotion's sheet, as Ryan is typing it. */
export interface SheetDraft {
  categoryKey: string
  name: string
  standing: string
  aliases: string
  /** One statement per line, the way a sheet's facts read on disk. */
  facts: string
  body: string
  usageContext: string
  /** The required edges, by declared type name. Unanswered reads as the declared unknown. */
  relations: Record<string, string>
}

/** One declared edge, as the API takes it. A wire shape, not copy. */
export interface DeclaredEdge {
  type: string
  to: string
}

export interface LibraryDraft {
  create: SheetDraft
  promote: SheetDraft
  /** The "after" per fact, so a change is raised from beside the fact it would replace. */
  statements: Record<string, string>
  /** A fact the entity does not have yet — the same delta with no before (#39). */
  addition: { field: string; statement: string }
  /** Why now, on whichever change is raised (1.2's second part). */
  changeContext: string
  /** A note per proposal, because the queue rules one at a time. */
  notes: Record<string, string>
}

export const EMPTY_SHEET_DRAFT: SheetDraft = {
  categoryKey: '',
  name: '',
  standing: '',
  aliases: '',
  facts: '',
  body: '',
  usageContext: '',
  relations: {},
}

export const EMPTY_LIBRARY_DRAFT: LibraryDraft = {
  create: EMPTY_SHEET_DRAFT,
  promote: EMPTY_SHEET_DRAFT,
  statements: {},
  addition: { field: '', statement: '' },
  changeContext: '',
  notes: {},
}

// ── The room, wired ─────────────────────────────────────────────────────────────

export function CanonLibrary({ id, cockpit }: ScreenProps) {
  const [view, setView] = useState<CanonLibraryView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<LibraryDraft>(EMPTY_LIBRARY_DRAFT)
  const [asOf, setAsOf] = useState({ ruling: '', date: '' })
  const [stream, setStream] = useState<CanonLibraryView['stream'] | null>(null)

  const showId = cockpit.shows[0]?.id ?? null

  /** The two controls, as the API reads them — a string, so an effect can watch it. */
  const controls = new URLSearchParams({
    ...(id !== null && { entity: id }),
    ...(asOf.ruling !== '' && { ruling: asOf.ruling }),
    ...(asOf.date !== '' && { date: asOf.date }),
  }).toString()

  const load = useCallback(async (): Promise<void> => {
    if (showId === null) return
    try {
      const res = await fetch(`/api/canon-library/${showId}?${controls}`)
      if (!res.ok) {
        setProblem(((await res.json()) as { error?: string }).error ?? null)
        return
      }
      const next = (await res.json()) as CanonLibraryView
      setView(next)
      setStream((held) => held ?? next.stream)
    } catch (error) {
      setProblem(`The API did not answer: ${String(error)}`)
    }
  }, [showId, controls])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * A ruling made HERE convenes no gate and no run, so it lands on `canon_ruling` and nowhere
   * else — this page re-reads from the ledger after every act (#29, ruled Aug 7 2026).
   *
   * A ruling made at a GATE writes canon too, and that one does reach the wire. So the stream
   * is subscribed to for the same reason the floor is: a completion sweep ratifying a rider in
   * another room changes what is true in here, and Ryan should not have to reload to see it.
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

  /** One act, and the library as the act left it. Every one of them raises; one rules. */
  const act = useCallback(
    async (key: string, path: string, body: unknown, after?: () => void): Promise<void> => {
      setBusy(key)
      setProblem(null)
      try {
        const res = await fetch(`${path}?${controls}`, {
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
    [controls, load],
  )

  if (showId === null) {
    return (
      <p className="crumb" role="status">
        {cockpit.switcherExplains}
      </p>
    )
  }

  if (view === null) {
    return (
      <p className="crumb" role="status">
        {problem ?? cockpit.destinations[3]!.explains}
      </p>
    )
  }

  const sheetBody = (form: SheetDraft, relations: DeclaredEdge[]): Record<string, unknown> => ({
    categoryKey: form.categoryKey,
    name: form.name,
    standing: form.standing,
    aliases: form.aliases,
    facts: form.facts,
    body: form.body,
    usageContext: form.usageContext,
    relations,
  })

  return (
    <CanonLibraryScreen
      view={view}
      draft={draft}
      asOf={asOf}
      busy={busy}
      problem={problem}
      onDraft={(next) => setDraft((held) => ({ ...held, ...next }))}
      onAsOf={setAsOf}
      onFound={() => void act('found', `/api/canon/${showId}/found`, {})}
      onCreate={(categoryKey, relations) =>
        void act(
          'create',
          `/api/canon/${showId}/entity`,
          sheetBody({ ...draft.create, categoryKey }, relations),
          () => setDraft((held) => ({ ...held, create: EMPTY_SHEET_DRAFT })),
        )
      }
      onPromote={(entityId, relations) =>
        void act(
          'promote',
          `/api/canon/entity/${entityId}/promote`,
          sheetBody(draft.promote, relations),
          () => setDraft((held) => ({ ...held, promote: EMPTY_SHEET_DRAFT })),
        )
      }
      onPropose={(factId) =>
        void act(
          factId,
          `/api/canon/fact/${factId}/propose`,
          { statement: draft.statements[factId] ?? '', usageContext: draft.changeContext },
          () => setDraft((held) => ({ ...held, statements: { ...held.statements, [factId]: '' } })),
        )
      }
      onAddFact={(entityId) =>
        void act(
          'add-fact',
          `/api/canon/entity/${entityId}/fact`,
          {
            field: draft.addition.field,
            statement: draft.addition.statement,
            usageContext: draft.changeContext,
          },
          () => setDraft((held) => ({ ...held, addition: { field: '', statement: '' } })),
        )
      }
      onRuleProposal={(proposalId, verdict) =>
        void act(proposalId, `/api/proposal/${proposalId}/${verdict}`, {
          note: draft.notes[proposalId] ?? '',
        })
      }
    />
  )
}

// ── Markup, and nothing else ────────────────────────────────────────────────────

export interface CanonLibraryScreenProps {
  view: CanonLibraryView
  draft: LibraryDraft
  /** Where the point-in-time control stands. Held above, because the page re-reads on it. */
  asOf: { ruling: string; date: string }
  busy: string | null
  problem: string | null
  onDraft(next: Partial<LibraryDraft>): void
  onAsOf(next: { ruling: string; date: string }): void
  onFound(): void
  onCreate(categoryKey: string, relations: DeclaredEdge[]): void
  onPromote(entityId: string, relations: DeclaredEdge[]): void
  onPropose(factId: string): void
  onAddFact(entityId: string): void
  onRuleProposal(proposalId: string, verdict: 'ratify' | 'reject' | 'defer'): void
}

export function CanonLibraryScreen(props: CanonLibraryScreenProps) {
  const { view } = props

  return (
    <div className="lib">
      <header className="lib-head">
        <p className="crumb">
          <a className="lib-crumb__back" href={view.floorHref} onClick={onLinkClick(view.floorHref)}>
            {view.floorName}
          </a>{' '}
          · {view.where}
        </p>
        <div className="lib-head__line">
          <h1>{view.title}</h1>
          <PointInTime {...props} />
        </div>
      </header>

      <div className="lib-cols stacks">
        <Browse {...props} />

        <div className="lib-main">
          {view.entity === null ? (
            <Card className="lib-panel">
              <EmptyState lead={view.nothingOpen.lead} sentence={view.nothingOpen.sentence} />
            </Card>
          ) : (
            <Sheet {...props} entity={view.entity} />
          )}
          <Founding {...props} />
          <Queue {...props} />
          <Create {...props} />
        </div>

        <div className="lib-rail">
          {view.entity !== null && <Rail {...props} entity={view.entity} />}
          <Ledger {...props} />
        </div>
      </div>

      {props.problem !== null && (
        <p className="lib-problem" role="alert">
          {props.problem}
        </p>
      )}
    </div>
  )
}

/**
 * The point-in-time control (D9). Every ruling on the ledger is a setting, and a date is a
 * setting too — it maps onto the last ruling at or before it, never the reverse, which is why
 * picking one clears the other rather than combining them.
 */
function PointInTime({ view, asOf, onAsOf }: CanonLibraryScreenProps) {
  return (
    <div className="lib-pit">
      <label className="lib-pit__label">
        {view.forms.asOfRuling}
        <select
          id="as-of"
          value={asOf.ruling}
          onChange={(event) => onAsOf({ ruling: event.target.value, date: '' })}
        >
          <option value="">{view.forms.asOfNow}</option>
          {view.bench.asOf.choices.map((ruling) => (
            <option key={ruling.seq} value={String(ruling.seq)}>
              {ruling.label}
            </option>
          ))}
        </select>
      </label>
      <label className="lib-pit__label">
        {view.forms.asOfDate}
        <input
          id="as-of-date"
          type="date"
          value={asOf.date}
          onChange={(event) => onAsOf({ ruling: '', date: event.target.value })}
        />
      </label>
      <span className="lib-pit__says" title={view.bench.asOf.sentence}>
        {view.bench.asOf.sentence}
      </span>
    </div>
  )
}

// ── Left: browse ────────────────────────────────────────────────────────────────

function Browse({ view }: CanonLibraryScreenProps) {
  return (
    <div className="lib-side">
      <SectionHeader name={view.headings.sidebar.name} explains={view.headings.sidebar.explains} />
      <a className="lib-side__queue" href="#queue">
        {view.headings.queue.name}
        <span className="lib-side__count">{view.bench.queue.length}</span>
      </a>

      {view.sidebar.map((kind) => (
        <Kind key={kind.key} kind={kind} open={view.entity} />
      ))}

      <div className="lib-side__gaps">
        <span className="lib-note">{view.headings.gaps.explains}</span>
        {view.gaps.map((gap) => (
          <a key={gap.entityId} className="lib-note" href={gap.href} onClick={onLinkClick(gap.href)}>
            {gap.sentence}
          </a>
        ))}
        {view.gapsNone !== null && (
          <span className="lib-note">
            {view.gapsNone.lead} {view.gapsNone.sentence}
          </span>
        )}
      </div>
    </div>
  )
}

/** One kind of canon: what it is, what it holds, and what reads it into a check (3.2). */
function Kind({ kind, open }: { kind: KindInTheLibrary; open: EntityInTheLibrary | null }) {
  return (
    <div className="lib-kind" data-kind={kind.key}>
      <span className="lib-kind__name" title={kind.blurb}>
        <span className="lib-kind__label">{kind.name}</span>
        <span className="lib-kind__n">{kind.count}</span>
      </span>
      <span className="lib-kind__checks" title={kind.instructions}>
        {kind.checks}
      </span>
      {kind.entities.map((entity) => (
        <a
          key={entity.id}
          className="lib-entity"
          href={entity.href}
          onClick={onLinkClick(entity.href)}
          title={entity.sentence}
          aria-current={open?.id === entity.id ? 'page' : undefined}
        >
          {entity.name}
          {entity.tag !== null && <span className="lib-entity__tag">{entity.tag}</span>}
        </a>
      ))}
      {kind.emptyBecause !== null && <span className="lib-kind__empty">{kind.emptyBecause}</span>}
    </div>
  )
}

// ── Middle: one sheet ───────────────────────────────────────────────────────────

function Sheet(props: CanonLibraryScreenProps & { entity: EntityInTheLibrary }) {
  const { view, entity, draft } = props

  return (
    <>
      <Section
        name={entity.name}
        explains={entity.sheet.sentence}
        className="lib-panel"
        id={`sheet-${entity.id}`}
      >
        <div className="lib-body lib-body--sheet">
          <div className="lib-ident">
            {entity.sheet.aliases.length > 0 && (
              <span className="lib-ident__alias">{entity.sheet.aliases.join(', ')}</span>
            )}
            {entity.chips.map((chip) => (
              <span
                key={chip.label}
                className="lib-chip"
                data-kind={chip.kind}
                data-value={chip.value}
                title={`${chip.label} — ${chip.because}`}
              >
                {chip.href === null ? (
                  chip.value
                ) : (
                  <a href={chip.href} onClick={onLinkClick(chip.href)}>
                    {chip.value}
                  </a>
                )}
              </span>
            ))}
          </div>
          <span className="lib-sub">{entity.subline}</span>
          {entity.open.map((proposal) => (
            <span className="lib-fact__touch" key={proposal.id}>
              {proposal.sentence}
            </span>
          ))}
          <div className="lib-prose">
            {entity.proseNone !== null ? (
              <EmptyState lead={entity.proseNone.lead} sentence={entity.proseNone.sentence} />
            ) : (
              entity.prose.map((section, index) => (
                <div key={index}>
                  {section.title !== null && <span className="lib-prose__h">{section.title}</span>}
                  {section.paragraphs.map((paragraph, at) => (
                    <p key={at}>{paragraph}</p>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </Section>

      <Section
        name={view.headings.facts.name}
        explains={view.headings.facts.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--facts">
          {entity.factsNone !== null ? (
            <EmptyState lead={entity.factsNone.lead} sentence={entity.factsNone.sentence} />
          ) : (
            <FactTable {...props} facts={entity.facts} change />
          )}
        </div>
        <label className="lib-form">
          {view.forms.changeContext}
          <input
            id="change-context"
            value={draft.changeContext}
            onChange={(event) => props.onDraft({ changeContext: event.target.value })}
          />
        </label>
      </Section>

      <Section
        name={view.headings.addFact.name}
        explains={view.headings.addFact.explains}
        className="lib-panel"
      >
        <div className="lib-form">
          <label>
            {view.forms.field}
            <input
              value={draft.addition.field}
              onChange={(event) =>
                props.onDraft({ addition: { ...draft.addition, field: event.target.value } })
              }
            />
          </label>
          <label>
            {view.forms.addition}
            <input
              id="addition"
              value={draft.addition.statement}
              onChange={(event) =>
                props.onDraft({ addition: { ...draft.addition, statement: event.target.value } })
              }
            />
          </label>
        </div>
        <SentenceButtonWithId
          id="add-fact"
          offer={needing(
            entity.sheet.addFact,
            draft.addition.statement,
            view.bench.refusals.additionNeedsStatement,
          )}
          busy={props.busy === 'add-fact'}
          onClick={() => props.onAddFact(entity.id)}
        />
      </Section>

      <Section
        name={view.headings.otherRows.name}
        explains={view.headings.otherRows.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--other lib-other">
          {entity.otherRowsNone !== null ? (
            <EmptyState lead={entity.otherRowsNone.lead} sentence={entity.otherRowsNone.sentence} />
          ) : (
            <FactTable {...props} facts={entity.otherRows} change={false} />
          )}
        </div>
      </Section>

      <Section
        name={view.headings.inherited.name}
        explains={view.headings.inherited.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--inherited">
          {entity.inherited.map((block) => (
            <div className="lib-inherited" key={block.type} data-case={block.case}>
              <span className="lib-inherited__via">
                {block.href === null ? (
                  block.via
                ) : (
                  <a href={block.href} onClick={onLinkClick(block.href)}>
                    {block.via}
                  </a>
                )}
              </span>
              <span className="lib-note">{block.sentence}</span>
              {block.facts.length > 0 && (
                <table className="lib-facts">
                  <thead>
                    <tr>
                      <th>{view.forms.columnStatement}</th>
                      <th>{view.forms.columnField}</th>
                      <th>{view.forms.columnStatus}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {block.facts.map((fact) => (
                      <tr className="lib-fact" key={fact.id}>
                        <td>
                          <span className="lib-fact__statement">{fact.statement}</span>
                          <span className="lib-fact__lineage">{fact.lineage}</span>
                        </td>
                        <td>{fact.field}</td>
                        <td>
                          <span className="tag tag--good">{fact.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <span className="lib-note">{block.note}</span>
            </div>
          ))}
        </div>
      </Section>

      {entity.exceptions.length > 0 && (
        <Section
          name={view.headings.exceptions.name}
          explains={view.headings.exceptions.explains}
          className="lib-panel"
        >
          <div className="lib-body lib-body--exceptions">
            {entity.exceptions.map((exception) => (
              <span className="lib-note" key={exception.factId} data-stale={exception.stale}>
                {exception.statement} — {exception.sentence}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/*
       * The promotion, and the sheet it carries. The form appears only while there is a
       * promotion to raise — a sheet Ryan cannot put to a ruling has nothing to fill in, and
       * the disabled button says why in the bench's own words.
       */}
      <Section
        name={view.headings.promote.name}
        explains={view.headings.promote.explains}
        className="lib-panel"
      >
        {entity.sheet.promote.enabled && (
          <SheetForm
            {...props}
            form={draft.promote}
            required={entity.sheet.required}
            onChange={(next) => props.onDraft({ promote: { ...draft.promote, ...next } })}
          />
        )}
        <SentenceButtonWithId
          id="promote"
          offer={entity.sheet.promote}
          busy={props.busy === 'promote'}
          onClick={() => props.onPromote(entity.id, edgesOf(entity.sheet.required, draft.promote))}
          wide
        />
      </Section>
    </>
  )
}

/** The facts table, at whatever point in time the control is set to. */
function FactTable({
  facts,
  change,
  ...props
}: CanonLibraryScreenProps & { facts: readonly FactInTheLibrary[]; change: boolean }) {
  const { view, draft } = props
  return (
    <table className={change ? 'lib-facts' : 'lib-facts lib-facts--other'}>
      <thead>
        <tr>
          <th>{view.forms.columnStatement}</th>
          <th>{view.forms.columnField}</th>
          <th>{view.forms.columnStatus}</th>
        </tr>
      </thead>
      <tbody>
        {facts.map((fact) => (
          <tr className="lib-fact" key={fact.id} data-where={fact.where}>
            <td>
              <span className="lib-fact__statement">{fact.statement}</span>
              <span className="lib-fact__lineage">{fact.lineage}</span>
              {fact.touchedBy !== null && <span className="lib-fact__touch">{fact.touchedBy}</span>}
              {fact.because !== null && <span className="lib-fact__because">{fact.because}</span>}
              {change && (
                <>
                  <label className="lib-fact__change">
                    {view.forms.statement}
                    <input
                      value={draft.statements[fact.id] ?? ''}
                      onChange={(event) =>
                        props.onDraft({
                          statements: { ...draft.statements, [fact.id]: event.target.value },
                        })
                      }
                    />
                  </label>
                  <SentenceButtonWithId
                    id={`propose-${fact.id}`}
                    offer={needing(
                      fact.propose,
                      draft.statements[fact.id] ?? '',
                      view.bench.refusals.changeNeedsStatement,
                    )}
                    busy={props.busy === fact.id}
                    onClick={() => props.onPropose(fact.id)}
                    dense
                    wide
                  />
                </>
              )}
            </td>
            <td>{fact.field}</td>
            <td>
              <span className={`tag ${fact.where === 'standing' ? 'tag--good' : 'tag--live'}`}>
                {fact.status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Middle, below the sheet: founding, the queue, and creating ─────────────────

function Founding(props: CanonLibraryScreenProps) {
  const { view } = props
  return (
    <Section
      name={view.headings.founding.name}
      explains={view.headings.founding.explains}
      className="lib-panel"
    >
      <div className="lib-body lib-body--found">
        {view.bench.emptyBecause !== null && (
          <span className="lib-note">{view.bench.emptyBecause}</span>
        )}
        <SentenceButtonWithId
          id="found"
          offer={view.bench.found}
          busy={props.busy === 'found'}
          onClick={props.onFound}
          wide
        />
      </div>
    </Section>
  )
}

/**
 * The queue: one card per proposal, five parts each, three verbs each. **There is no fourth
 * verb and no button that rules them all** — a stack of proposals takes a stack of rulings,
 * and each leaves its own row on the ledger (1.2).
 */
function Queue(props: CanonLibraryScreenProps) {
  const { view, draft } = props
  return (
    <Section
      name={view.headings.queue.name}
      explains={view.headings.queue.explains}
      className="lib-panel"
      id="queue"
    >
      <div className="lib-body lib-body--queue">
        {view.queueNone !== null ? (
          <EmptyState lead={view.queueNone.lead} sentence={view.queueNone.sentence} />
        ) : (
          view.bench.queue.map((proposal) => (
            <div className="lib-proposal" key={proposal.id} id={`proposal-${proposal.id}`}>
              <span className="lib-proposal__what">{proposal.sentence}</span>
              {proposal.change.map((line) => (
                <span className="lib-proposal__part" key={line}>
                  {line}
                </span>
              ))}
              <span className="lib-proposal__part">{proposal.usageContext}</span>
              {/* Computed at read time and never stored — the freshness pattern (1.2). */}
              <span className="lib-proposal__part">{proposal.implications}</span>
              {proposal.alternatives.map((alternative) => (
                <span className="lib-proposal__part" key={alternative}>
                  {alternative}
                </span>
              ))}
              <label className="lib-form">
                {view.forms.note}
                <textarea
                  rows={2}
                  value={draft.notes[proposal.id] ?? ''}
                  onChange={(event) =>
                    props.onDraft({ notes: { ...draft.notes, [proposal.id]: event.target.value } })
                  }
                />
              </label>
              <div className="lib-proposal__verbs">
                <SentenceButton
                  offer={proposal.ratify}
                  busy={props.busy === proposal.id}
                  onClick={() => props.onRuleProposal(proposal.id, 'ratify')}
                  wide
                  dense
                  ruling
                />
                <SentenceButton
                  offer={needing(
                    proposal.reject,
                    draft.notes[proposal.id] ?? '',
                    view.bench.refusals.rejectNeedsNote,
                  )}
                  busy={props.busy === proposal.id}
                  onClick={() => props.onRuleProposal(proposal.id, 'reject')}
                  wide
                  dense
                />
                <SentenceButton
                  offer={proposal.defer}
                  busy={props.busy === proposal.id}
                  onClick={() => props.onRuleProposal(proposal.id, 'defer')}
                  wide
                  dense
                  quiet
                />
              </div>
            </div>
          ))
        )}
      </div>
    </Section>
  )
}

/** Creating is proposing: the identity appears at once, visibly unofficial, and waits. */
function Create(props: CanonLibraryScreenProps) {
  const { view, draft } = props
  const kind =
    view.bench.create.categories.find((one) => one.key === draft.create.categoryKey) ??
    view.bench.create.categories[0]

  return (
    <Section
      name={view.headings.create.name}
      explains={view.headings.create.explains}
      className="lib-panel"
    >
      <div className="lib-body lib-body--create">
        {view.bench.create.blockedBecause !== null && (
          <span className="lib-note">{view.bench.create.blockedBecause}</span>
        )}
        {kind !== undefined && (
          <div className="lib-form">
            <label>
              {view.forms.category}
              <select
                value={kind.key}
                onChange={(event) =>
                  props.onDraft({
                    // The required edges belong to the kind, so switching drops the answers
                    // given for the other one's.
                    create: {
                      ...draft.create,
                      categoryKey: event.target.value,
                      relations: {},
                    },
                  })
                }
              >
                {view.bench.create.categories.map((one) => (
                  <option key={one.key} value={one.key}>
                    {one.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {view.forms.name}
              <input
                id="new-name"
                value={draft.create.name}
                onChange={(event) =>
                  props.onDraft({ create: { ...draft.create, name: event.target.value } })
                }
              />
            </label>
            <SheetForm
              {...props}
              form={draft.create}
              required={kind.required}
              onChange={(next) => props.onDraft({ create: { ...draft.create, ...next } })}
            />
            <SentenceButtonWithId
              id="create"
              offer={needing(kind.raise, draft.create.name, view.bench.refusals.entityNeedsName)}
              busy={props.busy === 'create'}
              onClick={() => props.onCreate(kind.key, edgesOf(kind.required, draft.create))}
              wide
            />
          </div>
        )}
      </div>
    </Section>
  )
}

/** The parts of a sheet below the identity — shared by creating and promoting. */
function SheetForm({
  view,
  form,
  required,
  onChange,
}: CanonLibraryScreenProps & {
  form: SheetDraft
  required: readonly RequiredRelation[]
  onChange(next: Partial<SheetDraft>): void
}) {
  return (
    <div className="lib-form">
      <label>
        {view.forms.standing}
        <select value={form.standing} onChange={(event) => onChange({ standing: event.target.value })}>
          <option value="">{view.forms.standingNotDeclared}</option>
          {view.bench.create.standings.map((standing) => (
            <option key={standing} value={standing}>
              {standing}
            </option>
          ))}
        </select>
      </label>
      <label>
        {view.forms.aliases}
        <input value={form.aliases} onChange={(event) => onChange({ aliases: event.target.value })} />
      </label>

      {required.map((edge) => (
        <label key={edge.type}>
          {edge.sentence}
          <select
            value={form.relations[edge.type] ?? edge.unknown}
            onChange={(event) =>
              onChange({ relations: { ...form.relations, [edge.type]: event.target.value } })
            }
          >
            <option value={edge.unknown}>{edge.unknown}</option>
            {edge.targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label>
        {view.forms.sheetFacts}
        <textarea rows={4} value={form.facts} onChange={(event) => onChange({ facts: event.target.value })} />
      </label>
      <label>
        {view.forms.body}
        <textarea rows={3} value={form.body} onChange={(event) => onChange({ body: event.target.value })} />
      </label>
      <label>
        {view.forms.usageContext}
        <input
          value={form.usageContext}
          onChange={(event) => onChange({ usageContext: event.target.value })}
        />
      </label>
    </div>
  )
}

/**
 * The required edges as the form answers them. Unanswered reads as the declared unknown,
 * which is a real answer and satisfies the requirement (D22) — so a promotion raised here is
 * always one that CAN be ratified, rather than one that aborts at D22's enforcement point.
 */
function edgesOf(required: readonly RequiredRelation[], form: SheetDraft): DeclaredEdge[] {
  return required.map((edge) => ({
    type: edge.type,
    to: form.relations[edge.type] ?? edge.unknown,
  }))
}

// ── Right: the graph, the record, the ledger ───────────────────────────────────

function Rail(props: CanonLibraryScreenProps & { entity: EntityInTheLibrary }) {
  const { view, entity } = props
  return (
    <>
      <Section
        name={view.headings.references.name}
        explains={view.headings.references.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--rail">
          {entity.referencesNone !== null ? (
            <EmptyState
              lead={entity.referencesNone.lead}
              sentence={entity.referencesNone.sentence}
            />
          ) : (
            entity.references.map((reference) => (
              <span className="lib-reference" key={reference.id}>
                {reference.sentence}
                <br />
                {reference.filePath}
              </span>
            ))
          )}
        </div>
      </Section>

      <Section
        name={view.headings.relations.name}
        explains={view.headings.relations.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--rail">
          {[...entity.relations, ...entity.incoming].map((edge) => (
            <div className="lib-edge" key={edge.id + edge.direction} data-direction={edge.direction}>
              <span className="lib-edge__kind">{edge.name}</span>
              {edge.href === null ? (
                <span>{edge.toName}</span>
              ) : (
                <a href={edge.href} onClick={onLinkClick(edge.href)}>
                  {edge.toName}
                </a>
              )}
              <span className="lib-edge__note">{edge.sentence}</span>
              <span className="lib-edge__note">{edge.inverse}</span>
            </div>
          ))}
          <span className="lib-note">{entity.relationsNote}</span>
        </div>
      </Section>

      <Section
        name={view.headings.appearances.name}
        explains={view.headings.appearances.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--rail">
          {entity.appearances.none !== null ? (
            <EmptyState
              lead={entity.appearances.none.lead}
              sentence={entity.appearances.none.sentence}
            />
          ) : (
            <div className="lib-appearances">
              {entity.appearances.episodes.map((episode) => (
                <a
                  className="lib-appearance"
                  key={episode.episodeId}
                  href={episode.href}
                  onClick={onLinkClick(episode.href)}
                  title={episode.sentence}
                >
                  {episode.chip}
                </a>
              ))}
            </div>
          )}
          <span className="lib-note">{entity.appearances.sentence}</span>
        </div>
      </Section>

      <Section
        name={view.headings.arcs.name}
        explains={view.headings.arcs.explains}
        className="lib-panel"
      >
        <div className="lib-body lib-body--rail">
          {entity.arcsNone !== null ? (
            <EmptyState lead={entity.arcsNone.lead} sentence={entity.arcsNone.sentence} />
          ) : (
            entity.arcs.map((arc) => (
              <div className="lib-arc" key={arc.arcId}>
                <div className="lib-way">
                  {arc.waypoints.map((waypoint) => (
                    <span className="lib-wp" key={waypoint.id} data-here={waypoint.here}>
                      {waypoint.name}
                    </span>
                  ))}
                </div>
                <span className="lib-note">
                  <a href={arc.href} onClick={onLinkClick(arc.href)} title={arc.statement}>
                    {arc.name}
                  </a>{' '}
                  · {arc.sentence}
                </span>
                <span className="lib-note">{arc.note}</span>
              </div>
            ))
          )}
        </div>
      </Section>
    </>
  )
}

/** Where a ruling made away from a gate is read back from — the ledger, not the log (#29). */
function Ledger({ view }: CanonLibraryScreenProps) {
  return (
    <Section
      name={view.headings.ledger.name}
      explains={view.headings.ledger.explains}
      className="lib-panel"
    >
      <div className="lib-body lib-body--ledger">
        {view.ledgerNone !== null ? (
          <EmptyState lead={view.ledgerNone.lead} sentence={view.ledgerNone.sentence} />
        ) : (
          view.bench.ledger.map((ruling) => (
            <span className="lib-ledger__row" key={ruling.seq}>
              {ruling.sentence}
            </span>
          ))
        )}
      </div>
    </Section>
  )
}

/**
 * The one button in the cockpit, with an id on it. The id is how a test — and a link from
 * another screen — reaches one particular door; `SentenceButton` itself has no business
 * carrying one, since it is the same button everywhere.
 */
function SentenceButtonWithId({
  id,
  ...props
}: { id: string } & Parameters<typeof SentenceButton>[0]) {
  return (
    <span id={id} className="lib-offer">
      <SentenceButton {...props} />
    </span>
  )
}
