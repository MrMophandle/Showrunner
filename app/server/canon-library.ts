import {
  canonBenchView,
  lineageOf,
  type BenchStanding,
  type CanonBenchView,
  type EntityInFull,
  type EntityOnTheBench,
  type FactOnTheBench,
  type ProposalOnTheBench,
} from './canon-bench.ts'
import { destinationsOf, type Destination } from './cockpit.ts'
import type { Store } from './db/store.ts'
import { positionsOf, waypointsOf, type Arc } from './domain/arc.ts'
import { findEntityById, referencesOf, type CanonEntity } from './domain/canon.ts'
import { categoriesOf, type CanonCategory, type CategoryField } from './domain/category.ts'
import {
  canonAsOf,
  factsInScope,
  findFact,
  type AsOf,
  type Fact,
  type InheritanceCase,
} from './domain/fact.ts'
import { episodesTouching, proposalsOfEntity, type Proposal } from './domain/proposal.ts'
import { declaredUnknowns, relationsFrom, relationsTo } from './domain/relation.ts'
import { episodeLabel, episodesOf, findShow, seasonsOf, type Episode } from './domain/spine.ts'
import type { Absence } from './episode-room.ts'
import { EVENT_KIND, latestSeq, PROSE_KIND, type EventKind } from './events.ts'
import { count, type FloorHeading } from './floor.ts'

/**
 * **The canon library** (E5-4, #84; 5.4, D9, D22, D23; `mockups/canon-library.html`) — the
 * bible, browsable, as of any moment.
 *
 * ## It composes one wire and derives nothing it already says
 *
 * `canon-bench.ts` (E2-6) is the read this screen is made of, and it is handed over WHOLE
 * below (`bench`). Every ruling verb, every five-part anatomy, every refusal, every lineage
 * line, every ledger sentence and the point-in-time setting itself are quoted from it — the
 * bench proved them at a bench, and a second wording of any of them would be the drift E5-2
 * spent a test preventing.
 *
 * What this module adds is the four things a BROWSABLE bible needs and a bench never did:
 *
 *   * **the sidebar**, which is a query over the show's declared kinds of canon;
 *   * **inheritance made visible** — one block per fact-carrying edge, with the edge it
 *     travelled written on it, and the three kinds of nothing kept apart (D22, `fact.ts`);
 *   * **edges navigable from both ends**, the far one by the inverse name (D23);
 *   * **appearances and arcs**, computed from provenance rather than from what a sheet says
 *     about itself (3.1).
 *
 * ## Nothing here knows what kind of canon it is looking at
 *
 * A kind of canon is DATA (3.2): its name, its sheet's fields, the artifact kinds its checks
 * fire on, and the edges it declares are rows. So declaring one lights up a sidebar entry, an
 * identity chip per required edge, an inheritance block per fact-carrying edge and a check
 * column, with **no code change here** — and `canon-library.test.ts` proves it the only way
 * that stays true: it reads the show's own keys and names out of the store and fails if any
 * of them appears in this file or in the screen.
 *
 * ## The point-in-time control is the whole screen, not a widget on it
 *
 * "As of" is a place on `canon_ruling.seq`, and a date maps onto a ruling, never the reverse
 * (D9). Setting it re-reads the page through `canonAsOf`: the facts table, the inherited
 * block, the identity's fact count. What does NOT move is the graph — a relation row has no
 * validity range, so an edge is as it stands today and the facts that travel it are read at
 * the setting. That asymmetry is real and is said on the block rather than smoothed over.
 *
 * A claim riding an episode is never rendered as canon at any setting: it has no ruling, so
 * it has no place on that clock (3.3), and it sits in its own group saying which episode it
 * rides. A fact ratified AFTER the setting is not absent either — it is ahead of where Ryan
 * is standing, and it says so.
 *
 * ## What it does NOT do
 *
 * **It rules nothing and writes nothing.** Every act on this screen is a route that existed
 * before it (`app.ts`'s canon section), and only ratification writes canon (invariant 1).
 *
 * **It does not move an episode's pin.** Declaring a position is a production decision about
 * an episode, so it is made in the episode room (E5-2) — this page draws the pins its
 * appearing episodes have declared and links to the room where they are moved.
 *
 * **It does not claim a waypoint has landed.** A pin is not a landing (D8); which waypoints a
 * ratified landing fact has reached is the arc page's read (#85).
 */

// ── What the screen is handed ───────────────────────────────────────────────────

export interface CanonLibraryView {
  show: { id: string; key: string; title: string }
  /** What the cockpit calls this room — the screen's own title, off `cockpit.ts`. */
  title: string
  /** Back to the floor, at the address the shell's own bar uses. */
  floorHref: string
  floorName: string
  /** "Grey Harbor · the canon library" — the breadcrumb's middle. */
  where: string
  /**
   * The bench, whole (E2-6). The queue, the ledger, the point-in-time setting, the founding
   * offer, the create form, the refusals and the open sheet are all read from here.
   */
  bench: CanonBenchView
  /** One entry per kind of canon this show declares — a query, never a list held here. */
  sidebar: KindInTheLibrary[]
  /** The entity whose page is open, or null. */
  entity: EntityInTheLibrary | null
  /** What the middle column says when nothing is open. */
  nothingOpen: Absence
  /** Every declared unknown in the show (D22) — `relation.ts`'s own gaps list. */
  gaps: GapInTheLibrary[]
  gapsNone: Absence | null
  queueNone: Absence | null
  ledgerNone: Absence | null
  headings: LibraryHeadings
  forms: LibraryForms
  /** What the stream sends and where this read was taken from — `floor.ts`'s protocol. */
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

/** Every section's name and its plain-words explanation. `SectionHeader` refuses one without. */
export interface LibraryHeadings {
  asOf: FloorHeading
  sidebar: FloorHeading
  founding: FloorHeading
  create: FloorHeading
  queue: FloorHeading
  ledger: FloorHeading
  gaps: FloorHeading
  facts: FloorHeading
  otherRows: FloorHeading
  inherited: FloorHeading
  exceptions: FloorHeading
  references: FloorHeading
  relations: FloorHeading
  appearances: FloorHeading
  arcs: FloorHeading
  promote: FloorHeading
  addFact: FloorHeading
  open: FloorHeading
}

/**
 * Every label on every field of every form on this screen. They are here for E4-7's reason:
 * **nothing in `app/web/` writes copy**, and a label is copy — the word beside the box is
 * what Ryan reads before he types into it.
 */
export interface LibraryForms {
  asOfRuling: string
  asOfNow: string
  asOfDate: string
  category: string
  name: string
  standing: string
  standingNotDeclared: string
  aliases: string
  sheetFacts: string
  body: string
  usageContext: string
  changeContext: string
  statement: string
  field: string
  addition: string
  note: string
  /** The facts table's columns. A table with no headers is a grid only an eye can read. */
  columnStatement: string
  columnField: string
  columnStatus: string
}

/** One kind of canon, with what it holds and what reads it. All of it is rows (3.2). */
export interface KindInTheLibrary {
  key: string
  name: string
  /** What this kind of canon is, in the words its own declaration carries. */
  blurb: string
  count: number
  /** "7 identities · 6 canon, 1 candidate" — the line under the name. */
  sentence: string
  /**
   * Which artifact kinds its checks fire on (3.2, 4.1) — the column that lights up when a
   * kind of canon is declared, with nothing recompiled. Short, because it sits in a rail.
   */
  checks: string
  /**
   * What that reviewer is actually told to do, whole. It is a paragraph off the declaration
   * and it goes beside the entry rather than in it — booting the room with the instructions
   * in the rail made the rail a wall of text and pushed the names out of sight (#84).
   */
  instructions: string
  /** The sections a sheet of this kind is written in. */
  fields: CategoryField[]
  /** Its declared edges, each with its cardinality and the name it is navigable back by. */
  edges: string[]
  entities: EntityInTheSidebar[]
  /** Why it is empty, in words. Null when it holds something. */
  emptyBecause: string | null
}

export interface EntityInTheSidebar extends EntityOnTheBench {
  href: string
  /** "candidate", "historical" — the tag beside a name. Null when it is plain active canon. */
  tag: string | null
}

/** What an identity chip is: a value read off the sheet, or off an edge the kind requires. */
export const CHIP_KIND = ['status', 'standing', 'edge', 'unknown', 'undeclared'] as const
export type ChipKind = (typeof CHIP_KIND)[number]

export interface IdentityChip {
  /** The label: a field of the sheet, or the declared name of a required edge. */
  label: string
  value: string
  kind: ChipKind
  /** Where the chip points, when it is an edge with something at the far end. */
  href: string | null
  /** What it means, in one line — a pointer's title, and a reader's. */
  because: string
}

/** Where a fact row stands relative to the point-in-time setting. */
export const FACT_WHERE = ['standing', 'riding', 'closed', 'ahead'] as const
export type FactWhere = (typeof FACT_WHERE)[number]

export interface FactInTheLibrary extends FactOnTheBench {
  where: FactWhere
  /** "1 unruled proposal touches this" — off the queue, computed at read time. */
  touchedBy: string | null
  /** Why it is not in the standing table, when the lineage does not already say. */
  because: string | null
}

/** One fact-carrying edge, and what came across it — the four cases of `fact.ts`. */
export interface InheritedInTheLibrary {
  /** The declared edge's own name. */
  type: string
  case: InheritanceCase
  sourceId: string | null
  sourceName: string | null
  href: string | null
  /** "from “Halvani”, via the edge it declares" — D22, made visible on the block itself. */
  via: string
  /** The case said as the different thing it is. Four cases, four sentences. */
  sentence: string
  /** Read at the point-in-time setting, like everything else on the page. */
  facts: InheritedFact[]
  /** Whose facts these are, and what editing one would really edit. */
  note: string
}

/**
 * An inherited fact carries its lineage and **no verb**. Changing one is a change to the
 * sheet it belongs to — the block links there and says so — and a disabled button here would
 * be inventing a refusal for an act that has a perfectly good home (D22).
 */
export interface InheritedFact {
  id: string
  field: string | null
  statement: string
  status: Fact['status']
  lineage: string
}

/** An individual exception: a fact here that displaces an inherited one (D22 addendum). */
export interface ExceptionInTheLibrary {
  factId: string
  statement: string
  sentence: string
  /** The ground moved under it: what it was written against has been superseded. */
  stale: boolean
}

export interface EdgeInTheLibrary {
  id: string
  /** The declared type from this end, the inverse name from the far one (D23). */
  name: string
  direction: 'declared' | 'inverse'
  toId: string | null
  toName: string | null
  href: string | null
  /** The bench's own sentence for an edge this entity declares. */
  sentence: string
  /** "inverse: members — the name it is navigable by from the far end (D23)". */
  inverse: string
}

export interface ReferenceInTheLibrary {
  id: string
  kind: string
  stance: string
  label: string
  filePath: string
  sentence: string
}

export interface AppearanceInTheLibrary {
  episodeId: string
  /** "ep01". */
  label: string
  title: string
  href: string
  /** "ep01 · script" — the label, with where the episode stands when it is still moving. */
  chip: string
  sentence: string
}

export interface ArcInTheLibrary {
  arcId: string
  name: string
  kind: Arc['kind']
  scope: Arc['scope']
  statement: string
  href: string
  waypoints: { id: string; ordinal: number; name: string; here: boolean }[]
  /** "ep01 declares waypoint 2 “The harbor is worth spending on”". */
  sentence: string
  /** A pin is not a landing (D8). */
  note: string
}

export interface GapInTheLibrary {
  entityId: string
  name: string
  type: string
  href: string
  sentence: string
}

export interface EntityInTheLibrary {
  id: string
  name: string
  href: string
  /** The bench's sheet, whole — its offers, its required edges, its history, its sentence. */
  sheet: EntityInFull
  /** What kind of canon it is, in the words its declaration carries. Its key when undeclared. */
  kindName: string
  /** "standing is declared intent; appearances below are computed from provenance (3.1)". */
  subline: string
  chips: IdentityChip[]
  prose: ProseSection[]
  proseNone: Absence | null
  /** Ratified and standing at the setting — `canonAsOf`, quoted from the bench. */
  facts: FactInTheLibrary[]
  factsNone: Absence | null
  /** Every other row this sheet carries: riding, closed, or ahead of the setting. */
  otherRows: FactInTheLibrary[]
  otherRowsNone: Absence | null
  inherited: InheritedInTheLibrary[]
  exceptions: ExceptionInTheLibrary[]
  relations: EdgeInTheLibrary[]
  incoming: EdgeInTheLibrary[]
  /** D23 in one line, under the edges. */
  relationsNote: string
  references: ReferenceInTheLibrary[]
  referencesNone: Absence | null
  appearances: {
    episodes: AppearanceInTheLibrary[]
    sentence: string
    none: Absence | null
  }
  arcs: ArcInTheLibrary[]
  arcsNone: Absence | null
  /** The proposals about it nobody has ruled — the queue, filtered to this subject. */
  open: ProposalOnTheBench[]
}

/** One block of the prose sheet: a title where the body declares one, and its paragraphs. */
export interface ProseSection {
  title: string | null
  paragraphs: string[]
}

// ── The view ────────────────────────────────────────────────────────────────────

export function canonLibraryView(
  store: Store,
  showId: string,
  standing: BenchStanding = {},
): CanonLibraryView | undefined {
  const show = findShow(store, showId)
  if (!show) return undefined

  const bench = canonBenchView(store, showId, standing)!
  const rooms = destinationsOf()
  const floor = rooms[0]!
  const here = roomFor(rooms, 'canon-library')
  const at = asOf(standing)
  const kinds = categoriesOf(store, showId)
  const gaps = gapsOf(store, showId)

  return {
    show: bench.show,
    title: here.name,
    floorHref: floor.path,
    floorName: floor.name,
    where: `${show.title} · ${here.name}`,
    bench,
    sidebar: sidebarOf(bench, kinds),
    entity: bench.entity === null ? null : entityInFull(store, bench, bench.entity, at, kinds),
    nothingOpen: {
      lead: 'No sheet is open.',
      sentence:
        'Pick a name on the left and its whole sheet opens here — what is true about it, who ' +
        'established each of those, and when each became true. The queue below is what is ' +
        'waiting on your ruling either way.',
    },
    gaps,
    gapsNone: gaps.length > 0 ? null : nothingUnknown(show.title),
    queueNone:
      bench.queue.length > 0
        ? null
        : {
            lead: 'Nothing is waiting on a ruling.',
            sentence:
              'Every proposal this show has raised has been ruled, and each ruling is on the ' +
              'ledger with the words you ruled it in. Canon moves from here by proposal: open ' +
              'a sheet and change a fact, or register something new below.',
          },
    ledgerNone:
      bench.ledger.length > 0
        ? null
        : {
            lead: 'No ruling has moved this show’s canon yet.',
            sentence:
              'The ledger is the clock canon is read by — every range above is measured in ' +
              'these numbers — so until the first ruling lands there is nothing to read as of.',
          },
    headings: HEADINGS,
    forms: FORMS,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since: latestSeq(store) },
  }
}

/** The setting, resolved the way the bench resolves it — one reading, quoted (D9). */
function asOf(standing: BenchStanding): AsOf {
  if (standing.ruling !== undefined) return { ruling: standing.ruling }
  if (standing.date !== undefined && standing.date !== '') {
    return { date: standing.date.includes('T') ? standing.date : `${standing.date}T23:59:59.999Z` }
  }
  return 'now'
}

const roomFor = (rooms: readonly Destination[], id: string): Destination =>
  rooms.find((room) => room.id === id)!

const entityHref = (entityId: string): string => `/canon/${entityId}`

// ── The sidebar, which is a query (3.2) ────────────────────────────────────────

/**
 * One entry per kind of canon the show declares, in the store's own order — plus one per key
 * that has identities and no declaration, which is an E1-era library rather than a gap in a
 * sheet (`canon.ts`, 0006). Nothing is dropped: an identity with nowhere to sit would be an
 * identity nobody can reach.
 */
function sidebarOf(bench: CanonBenchView, kinds: CanonCategory[]): KindInTheLibrary[] {
  const held = new Map<string, EntityInTheSidebar[]>()
  for (const entity of bench.entities) {
    const list = held.get(entity.categoryKey) ?? []
    list.push({ ...entity, href: entityHref(entity.id), tag: tagOf(entity) })
    held.set(entity.categoryKey, list)
  }

  const declared = kinds.map((kind): KindInTheLibrary => {
    const entities = held.get(kind.key) ?? []
    return {
      key: kind.key,
      name: kind.name,
      blurb: plain(kind.blurb),
      count: entities.length,
      sentence: heldSentence(entities),
      checks: checksSentence(kind),
      instructions: plain(kind.checkInstructions),
      fields: kind.fields,
      edges: kind.relationTypes.map(
        (type) =>
          `${type.name} → ${type.targetCategory} · ${type.cardinality}` +
          `${type.required ? ', required' : ''} · inverse: ${type.inverse}` +
          `${type.inheritsFacts ? ' · facts travel it (D22)' : ''}`,
      ),
      entities,
      emptyBecause:
        entities.length > 0
          ? null
          : `${kind.name} holds nothing yet. Register the first one below — creating is ` +
            'proposing, and it stays a candidate until you rule its promotion.',
    }
  })

  const undeclared = [...held.keys()]
    .filter((key) => !kinds.some((kind) => kind.key === key))
    .map((key): KindInTheLibrary => {
      const entities = held.get(key)!
      return {
        key,
        name: key,
        blurb: '',
        count: entities.length,
        sentence: heldSentence(entities),
        checks: `nothing reads these — this show declares no \`${key}\``,
        instructions:
          'They were registered before the declaration existed (0006), so nothing traverses ' +
          'their edges and nothing inherits through them. Declaring it links them.',
        fields: [],
        edges: [],
        entities,
        emptyBecause: null,
      }
    })

  return [...declared, ...undeclared]
}

const tagOf = (entity: EntityOnTheBench): string | null =>
  entity.status === 'active' ? null : entity.status

/** "7 identities · 6 canon, 1 candidate" — what is in here, and how much of it is ruled. */
function heldSentence(entities: readonly EntityInTheSidebar[]): string {
  const canon = entities.filter((entity) => entity.status === 'active').length
  const parts = [`${canon} canon`]
  for (const status of ['candidate', 'historical'] as const) {
    const many = entities.filter((entity) => entity.status === status).length
    if (many > 0) parts.push(`${many} ${status}`)
  }
  const many = entities.length
  return `${many} ${many === 1 ? 'identity' : 'identities'} · ${parts.join(', ')}`
}

/** Where this kind of canon's checks fire (3.2, 4.1). What they are told to do is beside it. */
function checksSentence(kind: CanonCategory): string {
  return kind.appliesTo.length === 0
    ? 'no artifact kind yet, so nothing reads it'
    : `reads on ${kind.appliesTo.join(', ')}`
}

/**
 * A sheet is markdown on disk, and every surface in this app renders a sentence as TEXT — so
 * `**transit costs**` reaches Ryan as asterisks. E5-2 found this in a sentence we composed
 * (`positionStanding`, #82) and fixed it at the composer; this is the other half, where the
 * prose is the SHEET'S own and the fix cannot be "write it differently".
 *
 * Emphasis only. Nothing else is touched — a backtick is how this app quotes a declared name
 * on screen, and a sheet that spells one is spelling it deliberately.
 */
const plain = (prose: string): string => prose.replaceAll(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')

// ── One entity, whole ───────────────────────────────────────────────────────────

function entityInFull(
  store: Store,
  bench: CanonBenchView,
  sheet: EntityInFull,
  at: AsOf,
  kinds: CanonCategory[],
): EntityInTheLibrary {
  const entity = findEntityById(store, sheet.id)!
  const kind = kinds.find((each) => each.key === sheet.categoryKey)
  const open = bench.queue.filter((proposal) => proposal.entityId === sheet.id)
  // The rows behind those, because "which fact would this change" is a `supersedes` and not
  // a string match on a sentence composed for reading.
  const unruled = proposalsOfEntity(store, sheet.id).filter(
    (proposal) => proposal.disposition === null,
  )
  const scope = factsInScope(store, sheet.id)
  const appearances = episodesTouching(store, sheet.id)
  const arcs = arcsOf(store, appearances)

  return {
    id: sheet.id,
    name: sheet.name,
    href: entityHref(sheet.id),
    sheet,
    kindName: kind?.name ?? sheet.categoryKey,
    subline:
      `${kind?.blurb === undefined || kind.blurb === '' ? sheet.categoryKey : kind.blurb} · ` +
      'standing is declared intent; the appearances beside this are computed from provenance ' +
      '(3.1), and every fact below carries the episode that established it and the ruling ' +
      'that made it canon',
    chips: chipsOf(store, sheet, entity),
    prose: proseOf(plain(sheet.body)),
    proseNone:
      sheet.body.trim() === ''
        ? {
            lead: 'No prose on this sheet.',
            sentence:
              'The body is what makes drafts good (3.1) — it is written by promoting a sheet ' +
              'with one, and a sheet without one still checks against its facts.',
          }
        : null,
    facts: sheet.facts.map((fact) => inTheLibrary(store, fact, 'standing', unruled)),
    factsNone: sheet.facts.length > 0 ? null : factsNone(sheet),
    otherRows: sheet.history.map((fact) => inTheLibrary(store, fact, whereOf(fact), unruled)),
    otherRowsNone:
      sheet.history.length > 0
        ? null
        : {
            lead: 'Nothing else is on this sheet.',
            sentence:
              'Every row it carries is standing at this setting — nothing riding an episode, ' +
              'nothing superseded or reverted, and nothing ratified after the point you are ' +
              'reading at. A fact is never deleted, so this fills in as canon moves.',
          },
    inherited: inheritedOf(store, scope, at),
    exceptions: exceptionsOf(store, scope),
    relations: declaredEdges(store, sheet),
    incoming: incomingEdges(store, sheet.id),
    relationsNote:
      'An edge whose type nobody declared cannot be written at all — a checker cannot ' +
      'traverse what it cannot interpret (D23). Types are declared by the kind of canon this ' +
      'is, with a target, a cardinality and the name the edge is navigable back by.',
    references: referencesOf(store, sheet.id).map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      stance: reference.stance,
      label: reference.label,
      filePath: reference.filePath,
      sentence:
        `${reference.label === '' ? reference.kind : reference.label} · ${reference.stance} — ` +
        (reference.stance === 'locked'
          ? 'what a generation of this has to match (D20)'
          : 'what somebody hopes for, gathered and not binding'),
    })),
    referencesNone:
      referencesOf(store, sheet.id).length > 0
        ? null
        : {
            lead: `Nothing is pinned to ${sheet.name} to match against yet.`,
            sentence:
              'A reference is a face to match, a voice to match, a board to shoot toward — the ' +
              'model is E2’s and the files are E6’s, so nothing in this build produces one.',
          },
    appearances: {
      episodes: appearances.map((episode) => onScreen(episode)),
      sentence: appearanceSentence(store, entity, appearances),
      none:
        appearances.length > 0
          ? null
          : {
              lead: `Nothing has been written against ${sheet.name} yet.`,
              sentence:
                'Appearances are computed from provenance — the edge an artifact declares when ' +
                'it was written against this (invariant 2) — so this fills in as episodes are ' +
                'written, and never from the standing on the sheet.',
            },
    },
    arcs,
    arcsNone:
      arcs.length > 0
        ? null
        : {
            lead: `No episode that reads on ${sheet.name} stands on an arc.`,
            sentence:
              'An episode touching no arc is vanilla — legal, tracked, and never a failure ' +
              'state (1.1). A pin is declared in the episode’s own room.',
          },
    open,
  }
}

/** The absence beside an empty facts table, which is two different absences (3.3). */
function factsNone(sheet: EntityInFull): Absence {
  return sheet.status === 'candidate'
    ? {
        lead: `${sheet.name} is a candidate, so nothing here is canon.`,
        sentence:
          'A candidate’s facts ride its promotion and are ruled with the rest of the sheet — ' +
          'rule that promotion and they land here with the ruling that made each one true.',
      }
    : {
        lead: 'No fact stands here at this setting.',
        sentence:
          'Either nothing was ratified onto this sheet, or every ruling that did came after ' +
          'the point you are reading at. Use the form on this page to add one — it is a fact ' +
          'delta with no before, and it waits in the queue for your ruling.',
      }
}

/** Which group a row off the sheet's history belongs in, and it is derivable from its status. */
function whereOf(fact: FactOnTheBench): FactWhere {
  if (fact.status === 'provisional') return 'riding'
  if (fact.status === 'ratified') return 'ahead'
  return 'closed'
}

function inTheLibrary(
  store: Store,
  fact: FactOnTheBench,
  where: FactWhere,
  unruled: readonly Proposal[],
): FactInTheLibrary {
  const touching = unruled.filter((proposal) =>
    proposal.change.facts.some((part) => part.supersedes === fact.id),
  ).length

  return {
    ...fact,
    where,
    touchedBy:
      touching === 0
        ? null
        : `${count(touching, 'unruled proposal')} in the queue would change this`,
    because: where === 'ahead' ? aheadBecause(store, fact) : null,
  }
}

/**
 * A fact ratified after the setting is not missing — it is ahead of where Ryan is standing,
 * and saying so is the difference between a point-in-time read and a page with holes in it.
 */
function aheadBecause(store: Store, fact: FactOnTheBench): string {
  const ruling = findFact(store, fact.id)?.ratifiedBy
  return (
    `Ratified at ruling ${ruling ?? '—'}, which is after the point you are reading at. It is ` +
    'not absent from canon; it is ahead of you on the clock (D9).'
  )
}

// ── The identity chips, which the declaration decides (D22, D23) ───────────────

function chipsOf(store: Store, sheet: EntityInFull, entity: CanonEntity): IdentityChip[] {
  const chips: IdentityChip[] = [
    { label: 'status', value: sheet.status, kind: 'status', href: null, because: sheet.sentence },
    {
      label: 'standing',
      value: sheet.standing ?? 'not declared',
      kind: 'standing',
      href: null,
      because:
        sheet.standing === null
          ? 'Nobody has declared one, which is not the same as declaring one-shot (3.1).'
          : 'Declared intent, not a count — the appearances beside this are the record (3.1).',
    },
  ]

  const edges = relationsFrom(store, entity.id)
  for (const required of sheet.required) {
    const edge = edges.find((one) => one.type.name === required.type)
    if (edge === undefined) {
      chips.push({
        label: required.type,
        value: 'not declared',
        kind: 'undeclared',
        href: null,
        because:
          `Nothing declares a \`${required.type}\` here — a hole in the sheet, and a different ` +
          `thing from a declared \`${required.unknown}\`. ${required.sentence}`,
      })
      continue
    }
    const target = edge.toEntityId === null ? null : (findEntityById(store, edge.toEntityId) ?? null)
    chips.push({
      label: required.type,
      value: target?.name ?? required.unknown,
      kind: target === null ? 'unknown' : 'edge',
      href: target === null ? null : entityHref(target.id),
      because:
        target === null
          ? `Declared \`${required.unknown}\`: somebody looked and the world has not decided ` +
            `(D22). It is a real answer. ${required.sentence}`
          : required.sentence,
    })
  }
  return chips
}

/** The prose body, in the sections it declares. A body with none is one section (3.1). */
function proseOf(body: string): ProseSection[] {
  const sections: ProseSection[] = []
  let open: ProseSection | undefined

  for (const block of body.split(/\n{2,}/).map((part) => part.trim())) {
    if (block === '') continue
    const heading = /^#{1,6}\s+(.*)$/.exec(block)
    if (heading) {
      open = { title: heading[1]!.trim(), paragraphs: [] }
      sections.push(open)
      continue
    }
    if (open === undefined) {
      open = { title: null, paragraphs: [] }
      sections.push(open)
    }
    open.paragraphs.push(block)
  }
  return sections
}

// ── Inheritance, made visible (D22) ────────────────────────────────────────────

/**
 * One block per fact-carrying edge, with the four cases kept apart — the "one kind of
 * something and three kinds of nothing" `fact.ts` refuses to collapse, at the screen.
 *
 * The structure is `factsInScope`'s and the FACTS are re-read at the setting: an edge has no
 * validity range, so the graph is as it stands today, and what travels it is read as of the
 * point-in-time control like everything else on the page. The displaced ones are dropped,
 * because an exception is what stands in their place (D22 addendum).
 */
function inheritedOf(
  store: Store,
  scope: ReturnType<typeof factsInScope>,
  at: AsOf,
): InheritedInTheLibrary[] {
  const displaced = new Set(
    scope.overrides.map((override) => override.displaces?.id).filter((id) => id !== undefined),
  )

  return scope.inheritance.map((edge): InheritedInTheLibrary => {
    const source = edge.source
    const facts: InheritedFact[] =
      source === null
        ? []
        : canonAsOf(store, { entityId: source.id }, at)
            .filter((fact) => !displaced.has(fact.id))
            .map((fact) => ({
              id: fact.id,
              field: fact.field,
              statement: fact.statement,
              status: fact.status,
              // The bench's own composer, quoted — a second lineage sentence beside the first
              // is exactly the drift this module refuses everywhere else.
              lineage: lineageOf(store, fact),
            }))

    return {
      type: edge.type.name,
      case: edge.case,
      sourceId: source?.id ?? null,
      sourceName: source?.name ?? null,
      href: source === null ? null : entityHref(source.id),
      via:
        source === null
          ? `via \`${edge.type.name}\`, which nothing is at the far end of`
          : `from “${source.name}”, via \`${edge.type.name}\``,
      sentence: inheritanceSentence(edge.case, edge.type.name, source?.name ?? null, facts.length),
      facts,
      note:
        source === null
          ? `Nothing loads into a check across \`${edge.type.name}\` for ${scope.entity.name}.`
          : `These are “${source.name}”’s facts, not ${scope.entity.name}’s — they load with ` +
            `${scope.entity.name} into every check that reads it (D22). Editing one edits ` +
            `“${source.name}”, and everything else that declares it inherits the change; an ` +
            `individual exception is a fact on ${scope.entity.name} naming what it overrides.`,
    }
  })
}

/** Four cases, four sentences — never one sentence with a count of zero in it. */
function inheritanceSentence(
  which: InheritanceCase,
  type: string,
  source: string | null,
  many: number,
): string {
  if (which === 'inherited') {
    return `${count(many, 'fact')} load with this across \`${type}\` from “${source}” (D22).`
  }
  if (which === 'source-has-no-facts') {
    return (
      `\`${type}\` is declared and points at “${source}”, and “${source}” carries no ratified ` +
      'fact at this setting. The edge is there; there is nothing at the far end of it yet.'
    )
  }
  if (which === 'declared-unknown') {
    return (
      `\`${type}\` is declared \`unknown\` — somebody looked and the world has not decided ` +
      '(D22). It is a real answer and it satisfies the requirement at ratification; nothing ' +
      'travels it, because there is nothing to travel from.'
    )
  }
  return (
    `Nothing declares a \`${type}\` here at all — no edge, which is a sheet nobody finished ` +
    'rather than an answer. It is the hole, not the unknown, and the two are different news.'
  )
}

function exceptionsOf(
  store: Store,
  scope: ReturnType<typeof factsInScope>,
): ExceptionInTheLibrary[] {
  return scope.overrides.map((override) => {
    const source = findEntityById(store, override.overridden.entityId)
    return {
      factId: override.by.id,
      statement: override.by.statement,
      stale: override.stale,
      sentence: override.stale
        ? `Displaces “${override.overridden.statement}” from “${source?.name ?? 'elsewhere'}” — ` +
          'and what it was written against has been superseded since, so it is worth ' +
          're-reading. The exception is still canon; the ground under it moved (D22).'
        : `Displaces “${override.overridden.statement}” from “${source?.name ?? 'elsewhere'}” — ` +
          'an individual exception, which is how one member differs without editing what it ' +
          'inherits from (D22).',
    }
  })
}

// ── The edges, from both ends (D23) ────────────────────────────────────────────

/** What this entity declares. The sentence is the bench's, quoted; the target is new here. */
function declaredEdges(store: Store, sheet: EntityInFull): EdgeInTheLibrary[] {
  return relationsFrom(store, sheet.id).map((edge): EdgeInTheLibrary => {
    const target = edge.toEntityId === null ? null : (findEntityById(store, edge.toEntityId) ?? null)
    return {
      id: edge.id,
      name: edge.type.name,
      direction: 'declared',
      toId: target?.id ?? null,
      toName: target?.name ?? null,
      href: target === null ? null : entityHref(target.id),
      sentence: sheet.relations.find((one) => one.id === edge.id)?.sentence ?? '',
      inverse: `inverse: ${edge.type.inverse} — the name this is navigable by from the far end (D23)`,
    }
  })
}

/**
 * What points AT this entity, each carrying the inverse name it is navigable by. Nothing
 * declares the inverse from this end — that is what an inverse is for, and it is why blast
 * radius is computable from both sides (D23, `relation.ts`).
 */
function incomingEdges(store: Store, entityId: string): EdgeInTheLibrary[] {
  return relationsTo(store, entityId).map((edge): EdgeInTheLibrary => {
    const from = findEntityById(store, edge.fromEntityId)!
    return {
      id: edge.id,
      name: edge.type.inverse,
      direction: 'inverse',
      toId: from.id,
      toName: from.name,
      href: entityHref(from.id),
      sentence:
        `${edge.type.inverse} → “${from.name}” — the far end of the \`${edge.type.name}\` it ` +
        `declares. Nothing here declares \`${edge.type.inverse}\`; it is navigable because ` +
        'the other end named it (D23).',
      inverse: `declared as \`${edge.type.name}\` by “${from.name}”`,
    }
  })
}

// ── Provenance: what has been written against this, and where it stands ────────

function onScreen(episode: Episode): AppearanceInTheLibrary {
  const label = episodeLabel(episode.number)
  return {
    episodeId: episode.id,
    label,
    title: episode.title,
    href: `/episode/${episode.id}`,
    chip: episode.lifecycle === 'published' ? label : `${label} · ${episode.lifecycle}`,
    sentence:
      `${label} “${episode.title}” — ${episode.lifecycle}` +
      `${episode.abandonedAt === null ? '' : `, put down on ${episode.abandonedAt}`}`,
  }
}

/**
 * The two answers side by side, and never merged: what the sheet DECLARES about how often
 * this turns up, and what the record actually holds. Standing is intent (3.1) and a screen
 * that reconciled them would be deciding something nobody ruled.
 */
function appearanceSentence(
  store: Store,
  entity: CanonEntity,
  touching: readonly Episode[],
): string {
  const all = seasonsOf(store, entity.showId).flatMap((season) => episodesOf(store, season.id))
  const record = `the record has it in ${touching.length} of ${all.length} episode${
    all.length === 1 ? '' : 's'
  }, computed from provenance`
  return entity.standing === null
    ? `No standing is declared on this sheet; ${record}.`
    : `Standing says ${entity.standing}; ${record}.`
}

/** The arcs the appearing episodes stand on, with the waypoints each has pinned (D8). */
function arcsOf(store: Store, touching: readonly Episode[]): ArcInTheLibrary[] {
  const found = new Map<string, { arc: Arc; pins: { episode: Episode; waypointId: string; ordinal: number; name: string }[] }>()

  for (const episode of touching) {
    for (const position of positionsOf(store, episode.id)) {
      const held = found.get(position.arc.id) ?? { arc: position.arc, pins: [] }
      held.pins.push({
        episode,
        waypointId: position.waypoint.id,
        ordinal: position.waypoint.ordinal,
        name: position.waypoint.name,
      })
      found.set(position.arc.id, held)
    }
  }

  return [...found.values()].map(({ arc, pins }) => ({
    arcId: arc.id,
    name: arc.name,
    kind: arc.kind,
    scope: arc.scope,
    statement: arc.statement,
    href: `/arc/${arc.id}`,
    waypoints: waypointsOf(store, arc.id).map((waypoint) => ({
      id: waypoint.id,
      ordinal: waypoint.ordinal,
      name: waypoint.name,
      here: pins.some((pin) => pin.waypointId === waypoint.id),
    })),
    sentence: pins
      .map(
        (pin) =>
          `${episodeLabel(pin.episode.number)} declares waypoint ${pin.ordinal} “${pin.name}”`,
      )
      .join(' · '),
    note:
      'A pin is a production decision, never a landing: "this episode is written to land it". ' +
      'Which waypoints a ratified landing fact has actually reached is read on the arc itself ' +
      '(D8), and the pin is moved in the episode’s own room.',
  }))
}

// ── The gaps list (D22) ────────────────────────────────────────────────────────

function gapsOf(store: Store, showId: string): GapInTheLibrary[] {
  return declaredUnknowns(store, showId).map((gap) => ({
    entityId: gap.entity.id,
    name: gap.entity.name,
    type: gap.type.name,
    href: entityHref(gap.entity.id),
    sentence:
      `“${gap.entity.name}” declares \`${gap.type.name}\` unknown — somebody looked and the ` +
      'world has not decided (D22). It is legal, it is tracked, it satisfies the requirement ' +
      'at ratification, and resolving it is a proposal with a before.',
  }))
}

const nothingUnknown = (title: string): Absence => ({
  lead: 'Nothing in this show is declared unknown.',
  sentence:
    `Every required edge ${title} has ratified points at something. A declared unknown is a ` +
    'row with nothing at the far end — an answer somebody gave, kept apart from a sheet ' +
    'nobody finished, which has no row at all.',
})

// ── The copy the screen renders and does not write ─────────────────────────────

const HEADINGS: LibraryHeadings = {
  asOf: {
    name: 'Canon as of',
    explains: 'any ruling, any date — every fact carries the range it was true over',
  },
  sidebar: {
    name: 'Browse',
    explains: 'every kind of canon this show declares, and what it holds',
  },
  founding: {
    name: 'Founding',
    explains: 'loading raises a proposal per sheet; only your ruling makes any of it canon',
  },
  create: {
    name: 'Register something new',
    explains: 'creating is proposing — it stays a candidate until you rule its promotion',
  },
  queue: {
    name: 'Proposal queue',
    explains: 'what is waiting on your ruling, one at a time, with what each would write',
  },
  ledger: {
    name: 'The ledger',
    explains: 'every ruling this canon has moved by, newest first, kept forever',
  },
  gaps: {
    name: 'Declared unknown',
    explains: 'somebody looked and the world has not decided — legal, tracked, never blank',
  },
  facts: {
    name: 'Facts',
    explains: 'atomic and checkable, each with the episode and the ruling behind it',
  },
  otherRows: {
    name: 'Not standing here',
    explains: 'every other row this sheet carries, and which of the three it is',
  },
  inherited: {
    name: 'Inherited',
    explains: 'not its facts — they load with it, and every check reads them too',
  },
  exceptions: {
    name: 'Exceptions',
    explains: 'a fact here that displaces one it would otherwise inherit',
  },
  references: {
    name: 'References',
    explains: 'a face to match, a voice to match, a board to shoot toward',
  },
  relations: {
    name: 'Relations',
    explains: 'typed edges — every one names the kind it points at and its inverse',
  },
  appearances: {
    name: 'Appearances',
    explains: 'computed from provenance, never from what the sheet claims about itself',
  },
  arcs: {
    name: 'Arcs',
    explains: 'where the episodes that read on this have pinned themselves',
  },
  promote: {
    name: 'Promote',
    explains: 'put the whole sheet to a ruling — the only way a candidate becomes canon',
  },
  addFact: {
    name: 'Add a fact',
    explains: 'the same delta with no before — it waits in the queue like everything else',
  },
  open: {
    name: 'Waiting on you',
    explains: 'the unruled proposals about this one, in the queue below',
  },
}

const FORMS: LibraryForms = {
  asOfRuling: 'Read canon as of a ruling',
  asOfNow: 'now — every ratified fact standing today',
  asOfDate: 'or as of a date, which maps onto the last ruling at or before it',
  category: 'What kind of canon it is',
  name: 'Its name, as the scripts will call it',
  standing: 'Standing — declared intent, not a count',
  standingNotDeclared: 'not declared — which is not the same as one-shot',
  aliases: 'Aliases, comma separated — what else the scripts call it',
  sheetFacts: 'Facts — one atomic, checkable statement per line',
  body: 'Body — the prose that makes drafts good',
  usageContext: 'Why now — what made this necessary (optional)',
  changeContext: 'Why now — the usage context on whichever change you raise (optional)',
  statement: 'What canon would say instead',
  field: 'Field (optional)',
  addition: 'What canon would say — one atomic, checkable statement',
  note: 'Your note — kept forever, and read back by later writer runs',
  columnStatement: 'Statement and lineage',
  columnField: 'Field',
  columnStatus: 'Status',
}
