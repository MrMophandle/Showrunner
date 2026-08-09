import type {
  CanonBenchView,
  CategoryOnTheBench,
  RequiredRelation,
} from '../server/canon-bench.ts'
import { ARTIFACT, Button, CARD, FAINT, needing } from './kit.tsx'

/**
 * The canon section of the operating page (E2-6) — the bench Ryan founds a show from and
 * moves its canon at.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * It is not the canon library. That screen is E5's, it is drawn in
 * `mockups/canon-library.html`, and none of it is built here: no columns, no point-in-time
 * chip, no sheet layout, no colour. What this owes the mockup is the FACTS it renders and
 * the ACTS it convenes, so E5 finds both already queryable.
 *
 * ── Every sentence came off the wire ────────────────────────────────────────────
 * Same contract as `App.tsx`: the server composes, this renders. Nothing here imports a
 * VALUE from `app/server` — not a standing, not the word `unknown`, not the sentence a
 * missing note is refused with — so the browser bundle stays a browser bundle and there is
 * one copy of every list. The four preconditions this file DOES own are the ones living in
 * a field the server has never seen (a name, a note, a new statement, an added one), and
 * each renders the server's own `refusals` string, which is the string the API refuses with.
 *
 * ── Nothing here writes canon ───────────────────────────────────────────────────
 * Six of the seven buttons RAISE — a promotion, a change, an addition, a ruling's note — and
 * only ratification writes (invariant 1). Loading this section reads. Every cost on it is
 * `No model call · $0.00`, stated on the button rather than left to be inferred.
 */

/** The sheet Ryan is typing: a promotion's five parts, before anything is raised. */
export interface SheetForm {
  categoryKey: string
  name: string
  standing: string
  aliases: string
  /** One statement per line, the way a sheet's `## Facts` reads. */
  facts: string
  body: string
  usageContext: string
  /** The required edges, by declared type name. Unset reads as the declared `unknown`. */
  relations: Record<string, string>
}

export interface BenchDraft {
  /** A note per proposal, because the queue rules one proposal at a time. */
  notes: Record<string, string>
  /** The "after" per fact, so a change is raised from beside the fact it replaces. */
  statements: Record<string, string>
  /** A fact the entity does not have yet: the same delta, with no before (#39). */
  addition: { field: string; statement: string }
  /** Why now — the usage context on whichever change is raised (1.2's second part). */
  changeContext: string
  create: SheetForm
  promote: SheetForm
}

export const EMPTY_SHEET: SheetForm = {
  categoryKey: '',
  name: '',
  standing: '',
  aliases: '',
  facts: '',
  body: '',
  usageContext: '',
  relations: {},
}

export const EMPTY_BENCH: BenchDraft = {
  notes: {},
  statements: {},
  addition: { field: '', statement: '' },
  changeContext: '',
  create: EMPTY_SHEET,
  promote: EMPTY_SHEET,
}

export interface CanonBenchProps {
  canon: CanonBenchView
  draft: BenchDraft
  busy: boolean
  /** Where the point-in-time control stands. Held by `App`, because it re-reads on it. */
  asOf: { ruling: string; date: string }
  onDraft(next: Partial<BenchDraft>): void
  onAsOf(next: { ruling: string; date: string }): void
  onShowEntity(entityId: string | null): void
  onFound(): void
  /** The category comes from here, not from the draft: the select falls back to the first. */
  onCreate(categoryKey: string, relations: Edge[]): void
  onPromote(entityId: string, relations: Edge[]): void
  onPropose(factId: string): void
  /** The addition — no fact to raise it beside, so it takes the entity (#39). */
  onAddFact(entityId: string): void
  onRuleProposal(proposalId: string, verdict: 'ratify' | 'reject' | 'defer'): void
}

export interface Edge {
  type: string
  to: string
}

/** Markup, and nothing else. */
export function CanonBench(props: CanonBenchProps) {
  const { canon, draft, busy, asOf } = props
  const category =
    canon.create.categories.find((each) => each.key === draft.create.categoryKey) ??
    canon.create.categories[0]

  return (
    <section>
      <h2>Canon — {canon.show.title}</h2>
      <p>
        Only ratification writes canon (invariant 1). Everything else on this bench{' '}
        <em>proposes</em>: an entity you create is a candidate until you rule its promotion, and
        a change to a ratified fact is a second proposal with the first as its before. Nothing
        here calls a model.
      </p>

      {canon.emptyBecause && <p>{canon.emptyBecause}</p>}

      {/* ── The point-in-time control (D9) ── */}
      <h3>Canon as of</h3>
      <p>
        <label>
          A ruling:{' '}
          <select
            value={asOf.ruling}
            onChange={(event) => props.onAsOf({ ruling: event.target.value, date: '' })}
          >
            <option value="">now — everything standing today</option>
            {canon.asOf.choices.map((ruling) => (
              <option key={ruling.seq} value={String(ruling.seq)}>
                {ruling.label}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          or a date:{' '}
          <input
            type="date"
            value={asOf.date}
            onChange={(event) => props.onAsOf({ ruling: '', date: event.target.value })}
          />
        </label>
      </p>
      <p>
        <strong>{canon.asOf.sentence}</strong>
      </p>

      {/* ── Founding: one deliberate act, one ruling per sheet (D25) ── */}
      <h3>Founding</h3>
      <p>
        <code>npm run fixture:load</code> raises a promotion proposal per sheet and stops —
        loading raises, and only founding rules. This is where the ruling happens, one sheet at
        a time through the same API the queue below uses.
      </p>
      <Button offer={canon.found} busy={busy} onClick={props.onFound} />

      {/* ── The entities, candidates visibly among them ── */}
      <h3>Entities</h3>
      <ul>
        {canon.entities.map((entity) => (
          <li key={entity.id}>
            <strong>{entity.name}</strong> <small>({entity.categoryKey})</small> —{' '}
            <span style={entity.status === 'candidate' ? FAINT : undefined}>{entity.status}</span>
            {entity.standing && ` · ${entity.standing}`} · {entity.factCount} fact
            {entity.factCount === 1 ? '' : 's'} standing
            {entity.openProposals > 0 &&
              ` · ${entity.openProposals} unruled proposal${entity.openProposals === 1 ? '' : 's'}`}
            {canon.entity?.id !== entity.id && (
              <>
                {' '}
                <button type="button" onClick={() => props.onShowEntity(entity.id)}>
                  Open “{entity.name}” below
                </button>
              </>
            )}
            <br />
            <small>{entity.sentence}</small>
          </li>
        ))}
      </ul>

      {/* ── One entity: its sheet, its facts, their lineage, and the change form ── */}
      {canon.entity && (
        <article style={CARD}>
          <h3>
            {canon.entity.name} <small>({canon.entity.categoryKey})</small>{' '}
            <button type="button" onClick={() => props.onShowEntity(null)}>
              Close this sheet
            </button>
          </h3>
          <p>{canon.entity.sentence}</p>
          {canon.entity.aliases.length > 0 && <p>Also called: {canon.entity.aliases.join(', ')}</p>}
          {canon.entity.body !== '' && <pre style={ARTIFACT}>{canon.entity.body}</pre>}

          <h4>Relations</h4>
          {canon.entity.relations.length === 0 ? (
            <p>No edges. A candidate may be ragged; canon may not (D22).</p>
          ) : (
            <ul>
              {canon.entity.relations.map((relation) => (
                <li key={relation.id}>{relation.sentence}</li>
              ))}
            </ul>
          )}

          <h4>Facts — standing at this point in time</h4>
          <p>
            <label>
              Why now — the usage context on whichever change you raise below (optional):{' '}
              <input
                value={draft.changeContext}
                onChange={(event) => props.onDraft({ changeContext: event.target.value })}
                size={56}
              />
            </label>
          </p>
          {canon.entity.facts.length === 0 ? (
            <p>
              Nothing ratified stands here at this setting — a candidate carries no canon until
              its promotion is ruled, and an entity promoted with its facts box empty carries
              none until you add one below.
            </p>
          ) : (
            <ol>
              {canon.entity.facts.map((fact) => (
                <li key={fact.id}>
                  {fact.field && <em>{fact.field}: </em>}“{fact.statement}” — {fact.status}
                  <br />
                  <small>{fact.lineage}</small>
                  <br />
                  <label>
                    What canon would say instead:{' '}
                    <input
                      value={draft.statements[fact.id] ?? ''}
                      onChange={(event) =>
                        props.onDraft({
                          statements: { ...draft.statements, [fact.id]: event.target.value },
                        })
                      }
                      size={72}
                    />
                  </label>
                  <Button
                    offer={needing(
                      fact.propose,
                      draft.statements[fact.id] ?? '',
                      canon.refusals.changeNeedsStatement,
                    )}
                    busy={busy}
                    onClick={() => props.onPropose(fact.id)}
                  />
                </li>
              ))}
            </ol>
          )}

          {/*
            The addition (#39): the same delta with nothing on the other side of it, and the
            only path to a fact on an entity that carries none — a change form is anchored to
            a fact that exists, so it cannot reach one. It takes the usage context above,
            which says "whichever change you raise below" and means this one too.
          */}
          <h4>Add a fact this entity does not have</h4>
          <p>
            <label>
              Field (optional):{' '}
              <input
                value={draft.addition.field}
                onChange={(event) =>
                  props.onDraft({ addition: { ...draft.addition, field: event.target.value } })
                }
                size={16}
              />
            </label>{' '}
            <label>
              What canon would say — one atomic, checkable statement:{' '}
              <input
                value={draft.addition.statement}
                onChange={(event) =>
                  props.onDraft({ addition: { ...draft.addition, statement: event.target.value } })
                }
                size={64}
              />
            </label>
          </p>
          <Button
            offer={needing(
              canon.entity.addFact,
              draft.addition.statement,
              canon.refusals.additionNeedsStatement,
            )}
            busy={busy}
            onClick={() => props.onAddFact(canon.entity!.id)}
          />

          {canon.entity.history.length > 0 && (
            <>
              <h4>Not standing here — every other row this entity carries</h4>
              <ul>
                {canon.entity.history.map((fact) => (
                  <li key={fact.id} style={FAINT}>
                    “{fact.statement}” — {fact.status}
                    <br />
                    <small>{fact.lineage}</small>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Promoting a candidate: the sheet is typed here, and ruled in the queue. */}
          {canon.entity.status === 'candidate' && (
            <>
              <h4>Promote this candidate</h4>
              <Sheet
                form={draft.promote}
                required={canon.entity.required}
                standings={canon.create.standings}
                onChange={(next) => props.onDraft({ promote: { ...draft.promote, ...next } })}
              />
              <Button
                offer={canon.entity.promote}
                busy={busy}
                onClick={() =>
                  props.onPromote(canon.entity!.id, edges(canon.entity!.required, draft.promote))
                }
              />
            </>
          )}
        </article>
      )}

      {/* ── Creating an entity, which is proposing one ── */}
      <h3>Create an entity</h3>
      {canon.create.blockedBecause ? (
        <p>{canon.create.blockedBecause}</p>
      ) : (
        category && (
          <div style={CARD}>
            <p>
              <label>
                Category:{' '}
                <select
                  value={category.key}
                  onChange={(event) =>
                    props.onDraft({
                      // The required edges belong to the category, so switching category
                      // drops the answers given for the other one's.
                      create: {
                        ...draft.create,
                        categoryKey: event.target.value,
                        relations: {},
                      },
                    })
                  }
                >
                  {canon.create.categories.map((each: CategoryOnTheBench) => (
                    <option key={each.key} value={each.key}>
                      {each.name} ({each.key})
                    </option>
                  ))}
                </select>
              </label>{' '}
              <label>
                Name:{' '}
                <input
                  value={draft.create.name}
                  onChange={(event) =>
                    props.onDraft({ create: { ...draft.create, name: event.target.value } })
                  }
                  size={32}
                />
              </label>
            </p>
            <Sheet
              form={draft.create}
              required={category.required}
              standings={canon.create.standings}
              onChange={(next) => props.onDraft({ create: { ...draft.create, ...next } })}
            />
            <Button
              offer={needing(category.raise, draft.create.name, canon.refusals.entityNeedsName)}
              busy={busy}
              onClick={() => props.onCreate(category.key, edges(category.required, draft.create))}
            />
          </div>
        )
      )}

      {/* ── The queue: three verbs, one proposal at a time ── */}
      <h3>Proposal queue</h3>
      {canon.queue.length === 0 ? (
        <p>Nothing is waiting on a ruling. Every proposal this show has raised has been ruled.</p>
      ) : (
        canon.queue.map((proposal) => (
          <article key={proposal.id} style={CARD}>
            <h4>{proposal.sentence}</h4>
            <p>
              <strong>The change</strong>
            </p>
            <ul>
              {proposal.change.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <p>
              <strong>Usage context:</strong> {proposal.usageContext}
            </p>
            <p>
              <strong>Implications:</strong> {proposal.implications}
            </p>
            {proposal.alternatives.length > 0 && (
              <>
                <p>
                  <strong>Alternatives</strong>
                </p>
                <ul>
                  {proposal.alternatives.map((alternative, index) => (
                    <li key={index}>{alternative}</li>
                  ))}
                </ul>
              </>
            )}

            <Button
              offer={proposal.ratify}
              busy={busy}
              onClick={() => props.onRuleProposal(proposal.id, 'ratify')}
            />

            <p>
              <label>
                Your note — kept forever, and read back by later writer runs:
                <br />
                <textarea
                  value={draft.notes[proposal.id] ?? ''}
                  onChange={(event) =>
                    props.onDraft({ notes: { ...draft.notes, [proposal.id]: event.target.value } })
                  }
                  rows={2}
                  cols={72}
                />
              </label>
            </p>
            <Button
              offer={needing(
                proposal.reject,
                draft.notes[proposal.id] ?? '',
                canon.refusals.rejectNeedsNote,
              )}
              busy={busy}
              onClick={() => props.onRuleProposal(proposal.id, 'reject')}
            />
            <Button
              offer={proposal.defer}
              busy={busy}
              onClick={() => props.onRuleProposal(proposal.id, 'defer')}
            />
          </article>
        ))
      )}

      {/* ── The ledger: where a bench ruling is read back from ── */}
      <h3>The ledger</h3>
      <p>
        Every ruling this show's canon has moved by, newest first, off <code>canon_ruling</code>{' '}
        — append-only, and the clock canon is read by. A ruling made here convenes no gate and
        no run, so it lands on the ledger rather than in the Live panel above; that is where it
        is read back from (ruled Aug 7 2026).
      </p>
      {canon.ledger.length === 0 ? (
        <p>No ruling has been made on this show's canon yet.</p>
      ) : (
        <ol>
          {canon.ledger.map((ruling) => (
            <li key={ruling.seq}>{ruling.sentence}</li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The five parts of a sheet, minus the identity — shared by create and promote. */
function Sheet({
  form,
  required,
  standings,
  onChange,
}: {
  form: SheetForm
  required: RequiredRelation[]
  standings?: readonly string[]
  onChange(next: Partial<SheetForm>): void
}) {
  return (
    <>
      <p>
        <label>
          Standing:{' '}
          <select
            value={form.standing}
            onChange={(event) => onChange({ standing: event.target.value })}
          >
            <option value="">not declared — which is different from one-shot</option>
            {(standings ?? []).map((standing) => (
              <option key={standing} value={standing}>
                {standing}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Aliases (comma separated):{' '}
          <input
            value={form.aliases}
            onChange={(event) => onChange({ aliases: event.target.value })}
            size={28}
          />
        </label>
      </p>

      {required.map((edge) => (
        <p key={edge.type}>
          <label>
            {edge.type}:{' '}
            <select
              value={form.relations[edge.type] ?? edge.unknown}
              onChange={(event) =>
                onChange({ relations: { ...form.relations, [edge.type]: event.target.value } })
              }
            >
              <option value={edge.unknown}>{edge.unknown} — declared, and a real answer</option>
              {edge.targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <br />
          <small>{edge.sentence}</small>
        </p>
      ))}

      <p>
        <label>
          Facts — one statement per line, atomic and checkable:
          <br />
          <textarea
            value={form.facts}
            onChange={(event) => onChange({ facts: event.target.value })}
            rows={4}
            cols={72}
          />
        </label>
      </p>
      <p>
        <label>
          Body — the prose that makes drafts good:
          <br />
          <textarea
            value={form.body}
            onChange={(event) => onChange({ body: event.target.value })}
            rows={3}
            cols={72}
          />
        </label>
      </p>
      <p>
        <label>
          Usage context — what made this necessary (optional):{' '}
          <input
            value={form.usageContext}
            onChange={(event) => onChange({ usageContext: event.target.value })}
            size={56}
          />
        </label>
      </p>
    </>
  )
}

/**
 * The required edges as the form answers them. Unanswered reads as the declared `unknown`,
 * which is a real answer and satisfies the requirement (D22) — so a promotion raised from
 * this bench is always one that CAN be ratified, rather than one that aborts at D22's
 * enforcement point three clicks later.
 */
function edges(required: RequiredRelation[], form: SheetForm): Edge[] {
  return required.map((edge) => ({
    type: edge.type,
    to: form.relations[edge.type] ?? edge.unknown,
  }))
}
