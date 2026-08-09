import type { Store } from './db/store.ts'
import {
  ENTITY_STANDING,
  entitiesOfShow,
  findEntity,
  findEntityById,
  registerEntity,
  type CanonEntity,
  type EntityStanding,
} from './domain/canon.ts'
import { categoriesOf, type CanonCategory } from './domain/category.ts'
import {
  canonAsOf,
  factsOfEntity,
  findFact,
  findRuling,
  rulingAsOfDate,
  rulingsOfShow,
  type AsOf,
  type CanonRuling,
  type Fact,
} from './domain/fact.ts'
import { foundingStack } from './domain/founding.ts'
import {
  blastRadius,
  findProposal,
  openProposals,
  raiseProposal,
  REJECTION_NEEDS_A_NOTE,
  type Proposal,
  type ProposalDraft,
  type ProposalOrigin,
} from './domain/proposal.ts'
import { relationsFrom, UNKNOWN_TARGET } from './domain/relation.ts'
import { episodeLabel, findEpisode, findShow, type Show } from './domain/spine.ts'
import type { Offer } from './operating.ts'

/**
 * The canon bench (E2-6) — the read model behind the operating page's canon section, and
 * the epic exit of E2: the surface Ryan founds a show from, promotes a candidate at, rules
 * a queue on, and reads canon back through at any point on its clock.
 *
 * ── It is scaffolding, and it is bound by the same rules as the cockpit ─────────
 * `mockups/canon-library.html` is what E5 makes of this; none of it is built here. What is
 * built is the FACTS that screen renders and the ACTS it convenes, so E5 finds both already
 * queryable. Every button below states verb + object + scope + cost in a full sentence,
 * every blocked action carries the reason in words before the click, and every cost on this
 * page is `No model call · $0.00` — nothing here can spend a cent, which is worth saying on
 * the buttons rather than leaving Ryan to infer.
 *
 * ── Where a bench ruling renders from: the ledger, not the log (RULED, Aug 7 2026) ──
 * Issue #27's amendment asked which, and #29 answered: `canon_ruling`. A ruling convened at
 * a gate reaches the event stream because a gate has a run and an episode to hang it on; a
 * ruling made HERE convenes no gate, no run and no episode, `event.run_id` is NOT NULL, and
 * `announce` correctly returns without appending. So the canon section re-reads the ledger
 * after every act and the Live panel stays runs-and-gates. Nothing in this module touches
 * `events.ts`, and the episode-less-event migration stays deferred until a real production
 * need pulls it.
 *
 * ── One ruling API, two surfaces, and neither is a bulk write ───────────────────
 * The queue rules one proposal at a time through `createProposalRulings` — the same three
 * verbs the gate room convenes over a script. The founding button convenes `foundCanon`,
 * which is not an exception to that: it rules a stack ONE AT A TIME through the same API and
 * writes one ledger row per sheet (D25). It is a deliberate act over documents Ryan has
 * already read, not a bulk-approve, and it is defined by origin — `loader` and `import` —
 * so a proposal a writer raised is never swept up in it.
 *
 * ── Creating is proposing ──────────────────────────────────────────────────────
 * `registerAndPropose` writes an identity — a `candidate`, which is what a row nobody has
 * ruled on looks like — and raises the promotion that would make it canon. Nothing on this
 * bench writes canon except a ratification, and the create form is the clearest case of it:
 * the entity appears immediately, visibly unofficial, and stays that way until Ryan rules
 * the proposal in the queue.
 *
 * **Why the sheet is typed rather than read off disk.** `fixture/load.ts` exports
 * `promotionFromSheet`, which turns a fixture sheet into exactly this draft, and it stays
 * the loader's builder. The bench does not call it, for two reasons that point the same way:
 * the create form has no sheet on disk to read — Ryan is typing one — so a builder for typed
 * input has to exist regardless, and calling BOTH would be the second payload builder that
 * hint exists to prevent. The other reason is decisive: `fixtures/` is not in the container
 * image (see the Dockerfile), and an app process that reads it at runtime is an app that
 * works for Grey Harbor and no other show. So there is one builder, `promotionDraft`, and
 * two entrances to it — a new identity, and a candidate that already has one.
 */

/** Nothing on this bench calls a model. Said on every button rather than left to inference. */
export const FREE = 'No model call · $0.00'

/**
 * The preconditions the PAGE owns, because each lives in a field the server has never seen
 * — a note in a textarea, a name in an input. They are composed here anyway, handed down the
 * wire, and refused with by the API, so the disabled button and the refusal are one string.
 */
export const BENCH_REFUSALS = {
  rejectNeedsNote: REJECTION_NEEDS_A_NOTE,
  entityNeedsName:
    'Type the name first — a promotion carries a sheet (1.2), and a sheet with no name on ' +
    'it is not a sheet about anybody.',
  changeNeedsStatement:
    'Write the new statement first — a fact delta is a before AND an after, and the after ' +
    'is what canon would say once you ruled it.',
} as const

export type BenchRefusals = typeof BENCH_REFUSALS

// ── What the canon section is handed ────────────────────────────────────────────

export interface CanonBenchView {
  show: { id: string; key: string; title: string }
  /** The point-in-time control, and what the facts below are being read as of (D9). */
  asOf: AsOfControl
  /** Every identity in the show — candidates among them, and visibly unofficial. */
  entities: EntityOnTheBench[]
  /** The one whose sheet is open, or null when none is. */
  entity: EntityInFull | null
  /** Unruled proposals, oldest first. Founding's ride nothing, so this is where they are. */
  queue: ProposalOnTheBench[]
  /** Every ruling this show's canon moved by, newest first — off `canon_ruling`. */
  ledger: RulingOnTheBench[]
  found: Offer
  create: CreateEntityForm
  refusals: BenchRefusals
  /** What to do about a show with no canon in it at all, or null when there is some. */
  emptyBecause: string | null
}

/** Where the point-in-time control stands, and what it resolved to. */
export interface AsOfControl {
  /** The ruling picked, or null for now. */
  ruling: number | null
  /** The date picked, `YYYY-MM-DD`, or null. */
  date: string | null
  /** "Canon as of ruling 7 (ratification, …) — a fact ratified at 7 is in." */
  sentence: string
  /** The rulings this show has, newest first — the control's own choices. */
  choices: RulingOnTheBench[]
}

export interface EntityOnTheBench {
  id: string
  name: string
  categoryKey: string
  status: CanonEntity['status']
  standing: EntityStanding | null
  /** "“Sefa Doule” is a candidate — an identity nobody has ruled on. Not canon." */
  sentence: string
  /** Ratified facts standing at the as-of setting. */
  factCount: number
  /** Proposals about it nobody has ruled. */
  openProposals: number
  /** Raise the promotion that would make it canon. Blocked once it is. */
  promote: Offer
}

export interface EntityInFull extends EntityOnTheBench {
  aliases: string[]
  body: string
  /** The ratified facts valid at the as-of setting — what re-renders when it moves. */
  facts: FactOnTheBench[]
  /** Every other fact row it carries: provisional, superseded, reverted. Status and why. */
  history: FactOnTheBench[]
  relations: RelationOnTheBench[]
  /** The edges a sheet of this category must answer before it can become canon (D22). */
  required: RequiredRelation[]
}

export interface FactOnTheBench {
  id: string
  field: string | null
  statement: string
  status: Fact['status']
  /** "established in ep02 · ratified at ruling 7 · 2026-08-06" — lineage, in words (3.1). */
  lineage: string
  /** Propose a change to it: a second proposal, carrying this fact as its before. */
  propose: Offer
}

export interface RelationOnTheBench {
  id: string
  /** "species → Halvani · required, exactly-one · facts travel it" */
  sentence: string
}

export interface ProposalOnTheBench {
  id: string
  kind: Proposal['kind']
  entityId: string
  entityName: string
  status: Proposal['status']
  /** "promotion · “Ilse Renn” — the full sheet, raised by the loader, riding nothing" */
  sentence: string
  usageContext: string
  alternatives: string[]
  /** The change itself, one line per part — what ratifying would write. */
  change: string[]
  /** The blast radius, computed at read time and never stored (1.2). */
  implications: string
  ratify: Offer
  reject: Offer
  defer: Offer
}

export interface RulingOnTheBench {
  seq: number
  kind: CanonRuling['kind']
  at: string
  note: string
  /** "ruling 7 · ratification — the “Sefa Doule” promotion · “…” · convened at the bench" */
  sentence: string
  /** The same ruling short enough to be an option in the point-in-time control. */
  label: string
}

export interface CreateEntityForm {
  /** One per category this show declares; the sentence on each names it. */
  categories: CategoryOnTheBench[]
  standings: readonly EntityStanding[]
  /** Why nothing can be created, in words. Null when something can. */
  blockedBecause: string | null
}

export interface CategoryOnTheBench {
  key: string
  name: string
  required: RequiredRelation[]
  raise: Offer
}

/** A required edge, with everything it may point at — and `unknown`, which is an answer. */
export interface RequiredRelation {
  type: string
  targetCategory: string
  targets: { id: string; name: string }[]
  /**
   * The literal word for a declared unknown (D22). Handed down rather than known by the
   * page, so the browser never holds its own copy of a vocabulary the store enforces.
   */
  unknown: string
  sentence: string
}

/** Where the bench's two controls stand when the view is composed. */
export interface BenchStanding {
  /** The entity whose sheet is open. */
  entityId?: string
  /** The as-of control: a ruling number, a date (`YYYY-MM-DD`), or neither, which is now. */
  ruling?: number
  date?: string
}

// ── The view ────────────────────────────────────────────────────────────────────

export function canonBenchView(
  store: Store,
  showId: string,
  standing: BenchStanding = {},
): CanonBenchView | undefined {
  const show = findShow(store, showId)
  if (!show) return undefined

  const at = asOf(standing)
  const entities = entitiesOfShow(store, show.id)
  const queue = openProposals(store, show.id)
  const categories = categoriesOf(store, show.id)
  const ledger = rulingsOfShow(store, show.id).map((ruling) => onTheLedger(store, ruling))

  const open = standing.entityId === undefined ? undefined : findEntityById(store, standing.entityId)

  return {
    show: { id: show.id, key: show.key, title: show.title },
    asOf: asOfControl(store, standing, at, ledger),
    entities: entities.map((entity) => onTheBench(store, entity, at, queue)),
    entity: open && open.showId === show.id ? inFull(store, open, at, queue, categories) : null,
    queue: queue.map((proposal) => inTheQueue(store, proposal)),
    ledger,
    found: foundingOffer(store, show, entities),
    create: createForm(store, show, categories, entities),
    refusals: BENCH_REFUSALS,
    emptyBecause:
      entities.length === 0
        ? `${show.title} has no canon in it yet — no identities, no sheets, nothing to rule. ` +
          'Run `npm run fixture:load` to put the Grey Harbor sheets on the queue, or create ' +
          'an entity below: creating is proposing, and nothing becomes canon until you rule it.'
        : null,
  }
}

/**
 * The point-in-time control's setting, resolved (D9). A date with no time in it means the
 * END of that day, which is what a person means by "as of Aug 7" — `rulingAsOfDate` compares
 * ISO strings as text, so a bare `2026-08-07` would otherwise sit before every ruling made
 * on the day it names and read as an empty canon.
 */
function asOf(standing: BenchStanding): AsOf {
  if (standing.ruling !== undefined) return { ruling: standing.ruling }
  if (standing.date !== undefined && standing.date !== '') {
    return { date: standing.date.includes('T') ? standing.date : `${standing.date}T23:59:59.999Z` }
  }
  return 'now'
}

function asOfControl(
  store: Store,
  standing: BenchStanding,
  at: AsOf,
  choices: RulingOnTheBench[],
): AsOfControl {
  return {
    ruling: standing.ruling ?? null,
    date: standing.date ?? null,
    sentence: asOfSentence(store, at),
    choices,
  }
}

function asOfSentence(store: Store, at: AsOf): string {
  if (at === 'now') {
    return 'Canon as of now — every ratified fact standing today, and nothing provisional.'
  }
  if ('ruling' in at) {
    const ruling = findRuling(store, at.ruling)
    if (!ruling) {
      return `Canon as of ruling ${at.ruling} — there is no such ruling on this ledger yet, so nothing had been ratified.`
    }
    return (
      `Canon as of ruling ${ruling.seq} (${ruling.kind}, ${ruling.at}) — a fact ratified AT ` +
      `${ruling.seq} is in, and one closed at ${ruling.seq} is out. The range is half-open (D9).`
    )
  }
  const ruling = rulingAsOfDate(store, at.date)
  const day = at.date.slice(0, 10)
  return ruling
    ? `Canon as of ${day} — which is ruling ${ruling.seq}, the last one made at or before it. ` +
        'A date maps onto a ruling, never the reverse.'
    : `Canon as of ${day} — no ruling had been made by then, so canon was empty.`
}

// ── The entities, and the candidate among them ──────────────────────────────────

function onTheBench(
  store: Store,
  entity: CanonEntity,
  at: AsOf,
  queue: Proposal[],
): EntityOnTheBench {
  const openHere = queue.filter((proposal) => proposal.entityId === entity.id)
  return {
    id: entity.id,
    name: entity.name,
    categoryKey: entity.categoryKey,
    status: entity.status,
    standing: entity.standing,
    sentence: entitySentence(entity),
    factCount: canonAsOf(store, { entityId: entity.id }, at).length,
    openProposals: openHere.length,
    promote: promoteOffer(entity, openHere),
  }
}

/** Status first, because "candidate" is the one word that says this is not canon. */
function entitySentence(entity: CanonEntity): string {
  const standing = entity.standing === null ? 'no standing declared' : `standing ${entity.standing}`
  if (entity.status === 'candidate') {
    return (
      `“${entity.name}” is a candidate — an identity registered, and a sheet nobody has ruled ` +
      `on. Not canon, and no check reads it. ${capitalise(standing)}.`
    )
  }
  if (entity.status === 'historical') {
    return `“${entity.name}” is historical canon — ruled once, and out of the story now. ${capitalise(standing)}.`
  }
  return `“${entity.name}” is canon — active, ${standing}.`
}

function promoteOffer(entity: CanonEntity, openHere: Proposal[]): Offer {
  const sentence =
    `Promote ${entity.name} — raise the sheet below as a promotion proposal, for your own ` +
    'ruling in the queue'
  const promotion = openHere.find((proposal) => proposal.kind === 'promotion')

  if (entity.status === 'active') {
    return {
      sentence,
      cost: FREE,
      enabled: false,
      blockedBecause:
        `“${entity.name}” is already active canon, so there is nothing to promote. A change ` +
        'to an entity that has been ruled on is a fact or relation delta, with a before — ' +
        'the facts on its sheet each offer one.',
    }
  }
  if (promotion) {
    return {
      sentence,
      cost: FREE,
      enabled: false,
      blockedBecause:
        `“${entity.name}” already has a promotion standing in the queue below, unruled. Rule ` +
        'that one — a second opinion is a second proposal, raised after this one is disposed of.',
    }
  }
  return { sentence, cost: FREE, enabled: true, blockedBecause: null }
}

// ── One entity's sheet, its facts, and their lineage ────────────────────────────

function inFull(
  store: Store,
  entity: CanonEntity,
  at: AsOf,
  queue: Proposal[],
  categories: CanonCategory[],
): EntityInFull {
  const standing = canonAsOf(store, { entityId: entity.id }, at)
  const standingIds = new Set(standing.map((fact) => fact.id))
  const category = categories.find((each) => each.key === entity.categoryKey)

  return {
    ...onTheBench(store, entity, at, queue),
    aliases: entity.aliases,
    body: entity.body,
    facts: standing.map((fact) => onTheSheet(store, fact)),
    history: factsOfEntity(store, entity.id)
      .filter((fact) => !standingIds.has(fact.id))
      .map((fact) => onTheSheet(store, fact)),
    relations: relationsFrom(store, entity.id).map((relation) => ({
      id: relation.id,
      sentence:
        `${relation.type.name} → ${
          relation.toEntityId === null
            ? UNKNOWN_TARGET
            : (findEntityById(store, relation.toEntityId)?.name ?? relation.toEntityId)
        } · ${relation.type.cardinality}${relation.type.required ? ', required' : ''}` +
        `${relation.type.inheritsFacts ? ' · facts travel it (D22)' : ''}`,
    })),
    required: category ? requiredOf(store, category, entity.showId) : [],
  }
}

function onTheSheet(store: Store, fact: Fact): FactOnTheBench {
  return {
    id: fact.id,
    field: fact.field,
    statement: fact.statement,
    status: fact.status,
    lineage: lineageOf(store, fact),
    propose: proposeOffer(fact),
  }
}

/** Where a fact came from and what put it there — kept forever, and readable (3.1, D9). */
function lineageOf(store: Store, fact: Fact): string {
  const parts: string[] = []
  const episode = fact.establishedIn === null ? null : findEpisode(store, fact.establishedIn)
  parts.push(
    episode
      ? `established in ${episodeLabel(episode.number)}`
      : 'established with no episode — a founding sheet, or a change ruled at the bench',
  )

  if (fact.ratifiedBy === null) {
    parts.push('provisional — riding its episode, visible to checks and not to canon (3.3)')
  } else {
    const ruling = findRuling(store, fact.ratifiedBy)
    parts.push(`ratified at ruling ${fact.ratifiedBy}${ruling ? ` · ${ruling.at}` : ''}`)
  }

  if (fact.closure) {
    parts.push(
      fact.closure.supersededBy === null
        ? `reverted at ruling ${fact.closure.closedBy} — closed with nothing in its place`
        : `superseded at ruling ${fact.closure.closedBy}`,
    )
  }
  return parts.join(' · ')
}

/**
 * The affordance the epic exit turns on: changing a ratified fact is a SECOND proposal, and
 * this is where it is raised from. Its before is the fact it is offered beside — which is
 * what makes a delta a delta rather than a quiet edit.
 */
function proposeOffer(fact: Fact): Offer {
  const sentence =
    `Propose a change to “${fact.statement}” — a second proposal, carrying this fact as its ` +
    'before, for your ruling in the queue'

  if (fact.closure) {
    return {
      sentence,
      cost: FREE,
      enabled: false,
      blockedBecause:
        `That fact was closed at ruling ${fact.closure.closedBy} and is no longer what canon ` +
        'says. Propose a change to the one standing in its place — a closed fact has no after.',
    }
  }
  if (fact.ratifiedBy === null) {
    return {
      sentence,
      cost: FREE,
      enabled: false,
      blockedBecause:
        'That claim is provisional — it rides its episode and no ruling has reached it. Rule ' +
        'the proposal it belongs to; a change to canon needs canon to change.',
    }
  }
  return { sentence, cost: FREE, enabled: true, blockedBecause: null }
}

// ── The queue: one proposal, and the three verbs that dispose of it ─────────────

function inTheQueue(store: Store, proposal: Proposal): ProposalOnTheBench {
  const name = findEntityById(store, proposal.entityId)?.name ?? proposal.entityId
  const subject = `the “${name}” ${KIND_NOUN[proposal.kind]}`
  const ruled = proposal.disposition !== null

  const already = ruled
    ? `That proposal was ${proposal.status} at ruling ${proposal.disposition!.seq}, and a ` +
      'proposal is ruled once. A later opinion is a new proposal.'
    : null

  return {
    id: proposal.id,
    kind: proposal.kind,
    entityId: proposal.entityId,
    entityName: name,
    status: proposal.status,
    sentence: queueSentence(store, proposal, name),
    usageContext: proposal.usageContext,
    alternatives: proposal.alternatives,
    change: changeLines(store, proposal),
    implications: blastRadius(store, proposal.id).sentence,
    ratify: {
      sentence: `Ratify ${subject} — this, and only this, writes it into canon`,
      cost: FREE,
      enabled: !ruled,
      blockedBecause: already,
    },
    reject: {
      sentence: `Reject ${subject} with your note — nothing is written, and the note is read back by later writer runs`,
      cost: FREE,
      enabled: !ruled,
      blockedBecause: already,
    },
    defer: {
      sentence:
        `Defer ${subject} — parks it${
          proposal.episodeId === null ? '' : ', and it stops riding its episode'
        }, and it can be raised again citing your note`,
      cost: FREE,
      enabled: !ruled,
      blockedBecause: already,
    },
  }
}

const KIND_NOUN: Record<Proposal['kind'], string> = {
  'fact-delta': 'fact delta',
  'relation-delta': 'relation delta',
  promotion: 'promotion',
  revert: 'revert',
  landing: 'waypoint landing',
}

const ORIGIN_PHRASE: Record<Proposal['raisedBy'], string> = {
  writer: 'raised by a writer run',
  check: 'raised by a check remediation',
  ryan: 'raised by you, at the bench',
  loader: 'raised by the loader, off a sheet on disk',
  import: 'raised by an import',
}

function queueSentence(store: Store, proposal: Proposal, name: string): string {
  const episode = proposal.episodeId === null ? null : findEpisode(store, proposal.episodeId)
  return (
    `${KIND_NOUN[proposal.kind]} · “${name}” — ${ORIGIN_PHRASE[proposal.raisedBy]}, ` +
    `${episode ? `riding ${episodeLabel(episode.number)}` : 'riding nothing'}`
  )
}

/** What ratifying would write, part by part — the first of the five (1.2). */
function changeLines(store: Store, proposal: Proposal): string[] {
  const lines: string[] = []

  if (proposal.change.standing !== null) lines.push(`sheet · standing ${proposal.change.standing}`)
  if (proposal.change.aliases !== null && proposal.change.aliases.length > 0) {
    lines.push(`sheet · aliases: ${proposal.change.aliases.join(', ')}`)
  }
  if (proposal.change.body !== null && proposal.change.body !== '') {
    lines.push(`sheet · a prose body of ${proposal.change.body.length} characters`)
  }

  for (const part of proposal.change.relations) {
    lines.push(
      part.op === 'remove'
        ? `edge · withdraw ${part.typeName}`
        : `edge · ${part.typeName} → ${
            part.toEntityId === null
              ? UNKNOWN_TARGET
              : (findEntityById(store, part.toEntityId)?.name ?? part.toEntityId)
          }`,
    )
  }

  for (const part of proposal.change.facts) {
    const before = part.supersedes === null ? undefined : findFact(store, part.supersedes)
    const field = part.field === null ? '' : `${part.field}: `
    lines.push(
      proposal.kind === 'revert'
        ? `revert · “${before?.statement ?? part.statement}” — closed with nothing in its place`
        : `fact · ${field}“${part.statement}”${before ? ` — replacing “${before.statement}”` : ''}`,
    )
  }

  for (const part of proposal.change.references) {
    lines.push(`reference · ${part.kind} ${part.filePath} (${part.stance})`)
  }

  return lines
}

// ── The ledger, which is where a bench ruling is read back from ─────────────────

function onTheLedger(store: Store, ruling: CanonRuling): RulingOnTheBench {
  const proposal = ruling.proposalId === null ? undefined : findProposal(store, ruling.proposalId)
  const name =
    proposal === undefined ? null : (findEntityById(store, proposal.entityId)?.name ?? null)

  const subject =
    proposal === undefined
      ? 'a ruling with no proposal on it'
      : `the “${name ?? proposal.entityId}” ${KIND_NOUN[proposal.kind]}`

  return {
    seq: ruling.seq,
    kind: ruling.kind,
    at: ruling.at,
    note: ruling.note,
    sentence:
      `ruling ${ruling.seq} · ${ruling.kind} — ${subject}${
        ruling.note === '' ? '' : ` · “${ruling.note}”`
      } · ${ruling.gateId === null ? 'convened at the bench, no gate' : 'convened at a gate'}`,
    // The note is left off this one on purpose: it is a founding note repeated on six
    // rulings, and a point-in-time control is a list to pick a moment from, not to read.
    label: `ruling ${ruling.seq} · ${ruling.kind} · ${ruling.at.slice(0, 10)} — ${subject}`,
  }
}

// ── Founding: one deliberate act, individually recorded (D25) ───────────────────

function foundingOffer(store: Store, show: Show, entities: CanonEntity[]): Offer {
  const stack = foundingStack(store, show.id)
  const sentence =
    `Found ${show.title} — ratify its ${stack.length} founding sheet${
      stack.length === 1 ? '' : 's'
    }, one ruling each on the ledger`

  if (stack.length > 0) return { sentence, cost: FREE, enabled: true, blockedBecause: null }

  return {
    sentence: `Found ${show.title} — ratify the sheets it was founded from, one ruling each`,
    cost: FREE,
    enabled: false,
    blockedBecause:
      entities.length === 0
        ? `Nothing has been loaded into ${show.title} yet. \`npm run fixture:load\` raises a ` +
          'promotion proposal per sheet and stops — loading raises, and only founding rules.'
        : `${show.title} has no founding sheets left to rule. Canon moves by proposal from ` +
          'here: raise one below, or open an entity and propose a change to a fact it carries.',
  }
}

// ── Creating an entity, which is proposing one ─────────────────────────────────

function createForm(
  store: Store,
  show: Show,
  categories: CanonCategory[],
  entities: CanonEntity[],
): CreateEntityForm {
  return {
    categories: categories.map((category) => ({
      key: category.key,
      name: category.name,
      required: requiredOf(store, category, show.id, entities),
      raise: {
        sentence:
          `Register a new ${category.key} in ${show.title} and raise its promotion — creating ` +
          'is proposing, and it stays a candidate until you rule it in the queue',
        cost: FREE,
        enabled: true,
        blockedBecause: null,
      },
    })),
    standings: ENTITY_STANDING,
    blockedBecause:
      categories.length === 0
        ? `${show.title} declares no canon categories, so there is no kind of thing to create. ` +
          'A category is data (3.2) — `npm run fixture:load` declares Grey Harbor’s, and ' +
          'E2-5’s schema document is what an empty show is founded from.'
        : null,
  }
}

/**
 * The edges a sheet of this category must answer before it can become canon (D22, D23) —
 * with everything each may point at, and `unknown` beside them, because a declared unknown
 * is a real answer and satisfies the requirement where a blank does not.
 */
function requiredOf(
  store: Store,
  category: CanonCategory,
  showId: string,
  entities?: CanonEntity[],
): RequiredRelation[] {
  const all = entities ?? entitiesOfShow(store, showId)
  return category.relationTypes
    .filter((type) => type.required)
    .map((type) => ({
      type: type.name,
      targetCategory: type.targetCategory,
      targets: all
        .filter((entity) => entity.categoryKey === type.targetCategory)
        .map((entity) => ({ id: entity.id, name: entity.name })),
      unknown: UNKNOWN_TARGET,
      sentence:
        `${type.name} → ${type.targetCategory} · ${type.cardinality}, required` +
        `${type.inheritsFacts ? ' · its facts load with this entity into every check (D22)' : ''}` +
        ` · \`${UNKNOWN_TARGET}\` is a real answer and satisfies it; blank does not`,
    }))
}

// ── The acts: each one raises, and none of them writes canon ───────────────────

/** The sheet Ryan typed at the bench — a promotion's five parts, in the words he used. */
export interface SheetDraft {
  standing?: EntityStanding
  aliases?: string[]
  body?: string
  /** One statement per line, as typed. */
  facts?: string[]
  /** The declared edges: a type name, and an entity id or the word `unknown`. */
  relations?: { type: string; to: string }[]
  usageContext?: string
}

/**
 * The one builder, and the reason the bench does not call `promotionFromSheet` (see the
 * header): the loader's sheet comes off disk and this one is typed, and two builders for one
 * payload eventually build two different ones.
 */
function promotionDraft(entityId: string, sheet: SheetDraft): ProposalDraft {
  return {
    entityId,
    kind: 'promotion',
    raisedBy: 'ryan',
    ...(sheet.standing !== undefined && { standing: sheet.standing }),
    ...(sheet.aliases !== undefined && { aliases: sheet.aliases }),
    ...(sheet.body !== undefined && { body: sheet.body }),
    facts: (sheet.facts ?? []).map((statement) => ({ statement })),
    relations: (sheet.relations ?? []).map((relation) => ({
      op: 'add' as const,
      type: relation.type,
      to: relation.to,
    })),
    usageContext:
      sheet.usageContext ??
      'Typed at the canon bench. No episode reads on it yet — the sheet itself is the ' +
        'context, and whatever is written against it will be written against what you rule here.',
    alternatives: [
      'reject it — a sheet is a draft until it is ruled, and a show need not keep everything drafted for it',
      'defer it — leave the identity a candidate until an episode actually reads on it',
    ],
  }
}

/**
 * Registers an identity and raises the promotion that would make it canon — **creating is
 * proposing**, and the two halves are one act because half of it is not a thing to leave
 * behind. The row that appears is a `candidate`: visible, unofficial, read by no check, and
 * exactly what "nothing becomes canon until Ryan rules it" looks like on a screen.
 */
export function registerAndPropose(
  store: Store,
  showId: string,
  identity: { categoryKey: string; name: string },
  sheet: SheetDraft = {},
): Proposal {
  return store.transaction(() => {
    const show = findShow(store, showId)
    if (!show) throw new Error(`No such show: ${showId}`)

    const name = identity.name.trim()
    if (name === '') throw new Error(BENCH_REFUSALS.entityNeedsName)

    const category = categoriesOf(store, show.id).find((each) => each.key === identity.categoryKey)
    if (!category) {
      throw new Error(
        `${show.title} declares no \`${identity.categoryKey}\` category, so there is no kind ` +
          'of thing to register. A category is data (3.2) — declare it first.',
      )
    }
    const clash = findEntity(store, { showId: show.id, categoryKey: category.key, name })
    if (clash) {
      throw new Error(
        `“${name}” is already a ${category.key} in ${show.title}. Open its sheet — a change to ` +
          'an entity that exists is a fact or relation delta, with a before.',
      )
    }

    const entity = registerEntity(store, { showId: show.id, categoryKey: category.key, name })
    return raiseProposal(store, promotionDraft(entity.id, sheet))
  })
}

/** Raises the promotion of an identity that already has a row — the candidate on the list. */
export function promoteCandidate(store: Store, entityId: string, sheet: SheetDraft = {}): Proposal {
  const entity = findEntityById(store, entityId)
  if (!entity) throw new Error(`No such canon entity: ${entityId}`)

  const openHere = openProposals(store, entity.showId).filter(
    (proposal) => proposal.entityId === entity.id,
  )
  const blocked = promoteOffer(entity, openHere).blockedBecause
  if (blocked) throw new Error(blocked)

  return raiseProposal(store, promotionDraft(entity.id, sheet))
}

/**
 * The second proposal, over a fact that is already canon (3.3) — the step the epic exit
 * turns on. The before is the fact itself, so the delta is a delta; the after is what Ryan
 * typed; and until he ratifies it, `canonAsOf` still answers with the before.
 *
 * **The one fact-delta builder, and E3-5's remediation raises through it** (`remediation.ts`).
 * The bench's own defaults are the ones written below — typed by Ryan, riding nothing — and a
 * caller with a different story about where the change came from says so in the three optional
 * fields rather than assembling a second draft. That is the same argument the header makes
 * about `promotionFromSheet`: two builders for one payload eventually build two payloads, and
 * the refusals a closed or provisional fact earns must be the same wherever the button is.
 */
export function proposeFactChange(
  store: Store,
  factId: string,
  change: {
    statement: string
    field?: string
    usageContext?: string
    /** Who raised it (1.2's fifth part). The bench is `ryan`; a check remediation is `check`. */
    raisedBy?: ProposalOrigin
    /** Left out, it rides nothing. A remediation rides the episode it was raised over (3.3). */
    episodeId?: string
    alternatives?: string[]
  },
): Proposal {
  const before = findFact(store, factId)
  if (!before) throw new Error(`No such fact: ${factId}`)

  const blocked = proposeOffer(before).blockedBecause
  if (blocked) throw new Error(blocked)

  const statement = change.statement.trim()
  if (statement === '') throw new Error(BENCH_REFUSALS.changeNeedsStatement)

  const field = change.field ?? before.field
  return raiseProposal(store, {
    entityId: before.entityId,
    kind: 'fact-delta',
    raisedBy: change.raisedBy ?? 'ryan',
    ...(change.episodeId !== undefined && { episodeId: change.episodeId }),
    facts: [{ statement, supersedes: before.id, ...(field !== null && { field }) }],
    usageContext:
      change.usageContext ??
      `Typed at the canon bench, over “${before.statement}”. Nothing has been written against ` +
        'the change yet — the before is what every artifact so far was checked against.',
    alternatives: change.alternatives ?? [
      'reject it — the fact as it stands is what canon keeps, and the note says why',
      'defer it — park the change until an episode forces the question',
    ],
  })
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
