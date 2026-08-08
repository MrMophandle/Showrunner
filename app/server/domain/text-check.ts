import type { Store } from '../db/store.ts'
import { positionsOf, waypointsOf, type ArcPosition } from './arc.ts'
import { provenanceOf, type Artifact, type ArtifactKind } from './artifact.ts'
import type { CanonEntity } from './canon.ts'
import { categoriesForArtifactKind, type CanonCategory } from './category.ts'
import { factsInScope, type Fact, type Inheritance } from './fact.ts'
import {
  FINDING_SEVERITY,
  recordCheckPass,
  type CheckGapDraft,
  type CheckGapReason,
  type CheckPass,
  type FindingConfidence,
  type FindingDraft,
  type FindingSeverity,
  type ScopeFactDraft,
} from './finding.ts'
import { episodeInShow, scenesOf, type Scene } from './spine.ts'

/**
 * The semantic tier (3.4, 4.2): **one checker, parameterized by category**. It reads an
 * artifact against exactly the canon that artifact declares it touches, calls a model once,
 * and turns what comes back into findings — or refuses it.
 *
 * There is no catalogue of checks here and no registry. A check IS a category, and a
 * category is data: its `check_instructions` are what the reviewer is told to do, its
 * `applies to` decides which artifact kinds it fires on, and its declared relation types
 * decide what travels into scope. Nothing in this file knows the word `world-rules` or the
 * word `species`. Adding a category is an edit to a sheet (3.2, 3.5); adding a *tier* would
 * be a code change with a test, which is the line the Archon rule draws.
 *
 * The waypoint-drift check (D8) rides the same shape with a different subject: its
 * instructions are prose in this file rather than a row, because an arc is not a category
 * and there is no sheet to put them on, and it argues from the arc's statement and its
 * waypoint descriptions rather than from facts.
 *
 * The craft reviewers (D13, `craft.ts`) ride it too, and they are the proof that the
 * parameterization is the whole parameterization: a reviewer that reads the artifact as
 * CRAFT rather than against canon needed one more field on `CheckSubject` and not one line
 * of a second composer or a second parser. `readsCanon: false` empties the closed sets below
 * instead of exempting anything from them — see the field.
 *
 * ## Nothing trusts the model — `board.ts`'s rule, one tier up
 *
 * The board refuses an invented entity rather than dropping it, because the prompt handed the
 * model the exact list and inventing one is a broken read. This file holds the same line
 * about the three things a finding claims:
 *
 *   * the **span** it anchors at must be findable in the artifact's own text, and what is
 *     stored is the ARTIFACT's wrapping of it, never the model's — an anchor is searched for
 *     by quote (4.3), so a quote that has been re-flowed would land nowhere;
 *   * the **scene** it names must be a scene this episode has, and the span must be inside it;
 *   * the **fact** it quotes must be one of the facts this check was handed, and the
 *     **entity** it is about must be in the artifact's provenance. A craft reviewer was
 *     handed neither, so both sets are empty and anything it cites is refused by this same
 *     line — a finding that cites NOTHING is legal by kind, and one that cites ANYTHING is
 *     invented by definition. Two different nothings, told apart with no waiver.
 *
 * A reply that fails any of them **fails the step**. It is not filtered down to the findings
 * that survive and it is never recorded as a clean pass: recording a broken read as "ran,
 * zero findings" would poison D11's cried-wolf denominator AND render a broken check as a
 * green checkmark, which is invariant 4's exact failure mode. The runner's bounded retry
 * (three attempts, every one kept) is what handles it, and exhaustion reaches Ryan.
 *
 * `certain` is refused for the same reason. It is the deterministic tier's word — "that is
 * what the tier MEANS" (finding.ts) — and a model's confidence in its own reading is never
 * that, however sure it says it is.
 *
 * ## Three kinds of nothing, and this tier owns the third
 *
 * `factsInScope` reports each fact-carrying edge's case separately rather than collapsing an
 * empty inheritance into an empty array, and this is what that is for. An edge that carried
 * nothing becomes a **gap** (0012): a recorded, queryable "could not check X for anything
 * that travels `species` — species undecided". It is not a finding, because nothing is wrong
 * with the artifact and no rewrite would answer it; it is not silence, because the check did
 * not clear that entity, it could not reach it. The gap is also written into the PROMPT, so
 * the model is told where its scope has a hole instead of filling it in.
 *
 * A gap belongs to the pass, not to the entity, so every check handed the same hole records
 * its own — the world-rules check could not apply a vacuum rule to somebody whose species is
 * undecided any more than the character check could, and both are entitled to say so.
 */

/**
 * What a text check's confidence may be. `certain` is deliberately absent: 4.2 gives it to
 * the deterministic tier because that tier reads rows, and a reading is never certain of
 * itself. Refused at parse time rather than clamped, because a check that says `certain` has
 * misunderstood what it is, and quietly downgrading it would hide that.
 */
export const TEXT_CHECK_CONFIDENCE = ['high', 'medium', 'low'] as const
export type TextCheckConfidence = (typeof TEXT_CHECK_CONFIDENCE)[number]

/**
 * The one check key that is not a category key (D8). A show whose sheets declared a category
 * called `waypoint-drift` would collide with it, which is the only reason it is written down
 * in one place instead of inline.
 */
export const WAYPOINT_CHECK_KEY = 'waypoint-drift'

/**
 * What parameterizes one run of the checker: what it is told to do, what it is about, and
 * whatever prose it argues from that is not a canon fact.
 *
 * This is the whole of the parameterization. `categoryChecksFor` builds one of these out of a
 * row; `waypointChecksFor` builds one out of an arc. The composer and the parser below cannot
 * tell them apart, and that is the property this issue is for.
 */
export interface CheckSubject {
  /** The `check_pass.check_key` — a category's key, `waypoint-drift`, or a craft reviewer's. */
  key: string
  /** How the check names itself in a prompt heading and in a gap's prose. */
  label: string
  /** What the reviewer is told to do. A category's `check_instructions`, verbatim. */
  instructions: string
  /** Prose the check argues from that is not a fact: an arc's statement, its waypoints. */
  reference: string[]
  /** The entities in provenance this check is ABOUT. Empty for a check with no canon subject. */
  subjectEntityIds: string[]
  /**
   * Whether the artifact's provenance travels into this check's prompt (E3-4).
   *
   * Every canon check says yes, and a craft reviewer says no — it reads the artifact as
   * craft (D13) and there is no world in front of it. It is **not a flag that waives
   * validation**, and reading it that way would be the failure this exists to prevent: it
   * empties the closed sets the parser holds a reply to, and every id is outside an empty
   * set. So the two nothings stay apart with no exemption anywhere — a craft finding that
   * cites nothing is legal by kind, and one that cites anything at all is refused by the
   * same line of code that refuses an invented id from the world-rules check.
   *
   * Optional so that a subject which does not mention it argues from canon, which is what
   * every subject that existed before this field meant.
   */
  readsCanon?: boolean
}

/** A note Ryan has already put down, handed back to a later run (4.4). E3-5 builds the reader. */
export interface PriorNote {
  note: string
  /** The check that raised the finding he put down. Left out when it came from elsewhere. */
  checkKey?: string
  /** The span it was anchored at, when it had one. */
  quote?: string
}

export interface TextCheckRequest {
  artifact: Artifact
  /** The artifact's text, read off the volume by the step. */
  text: string
  subject: CheckSubject
  /**
   * Dismissal notes from earlier runs, as optional context. **This module accepts them and
   * does not go and find them** — E3-5 owns the reader, and a checker that queried for its
   * own context would make "what was this check told" unanswerable from the call site.
   */
  priorNotes?: PriorNote[]
}

/** One check, composed: what it will send, and what it will accept back. */
export interface ComposedCheck {
  subject: CheckSubject
  artifactId: string
  /** What was read, for the words a refusal uses — "not in the script". */
  kind: ArtifactKind
  /** The version composed against. The artifact may move on; this pass read this one. */
  version: number
  system: string
  prompt: string
  /** Every fact loaded, in prompt order — recorded with the pass (0012). */
  scope: ScopeFactDraft[]
  /** What the scope could not reach. */
  gaps: CheckGapDraft[]
  /** What a citation is checked against. Not sent; used to refuse a reply that invents one. */
  citable: Citable
}

/** The closed sets a reply is held to, gathered once while the prompt is composed. */
interface Citable {
  text: string
  factIds: Set<string>
  /** Name and every alias, lowercased, to the entity id — how a model's word becomes an id. */
  entityIds: Map<string, string>
  scenes: SceneSpan[]
}

/** One scene, and the run of the artifact's text that belongs to it. */
export interface SceneSpan {
  scene: Scene
  from: number
  to: number
}

// ── What fires (4.1) ────────────────────────────────────────────────────────────

/**
 * The category checks this artifact convenes: one per category whose `applies to` names this
 * artifact's kind AND which has at least one entity in the artifact's provenance.
 *
 * Both halves are needed and neither is redundant. The kind is the category's declaration
 * about where it is relevant (4.1); the provenance is this artifact's declaration about what
 * it touches (invariant 2). A category that applies to scripts but whose entities are nowhere
 * in this one has nothing to say, and firing it would spend a model call to be told so.
 */
export function categoryChecksFor(store: Store, artifact: Artifact): CheckSubject[] {
  const where = episodeInShow(store, artifact.episodeId)
  if (!where) throw new Error(`no such episode: ${artifact.episodeId}`)

  const provenance = provenanceOf(store, artifact.id)
  return categoriesForArtifactKind(store, where.show.id, artifact.kind)
    .map((category) => subjectOf(category, provenance))
    .filter((subject) => subject.subjectEntityIds.length > 0)
}

function subjectOf(category: CanonCategory, provenance: CanonEntity[]): CheckSubject {
  return {
    key: category.key,
    label: `the ${category.key} check`,
    instructions: category.checkInstructions,
    reference: [],
    subjectEntityIds: provenance
      .filter((entity) => entity.categoryKey === category.key)
      .map((entity) => entity.id),
  }
}

/**
 * The waypoint-drift checks this artifact convenes: one per arc position its episode declares
 * (D8). An episode that declares none is **vanilla** — legal, tracked, never a failure state
 * — and convenes nothing at all, which is an empty list rather than a check that says so.
 *
 * Two arcs give two passes under one key. That is right for D11: the question a cried-wolf
 * ratio asks is "how often does drift-checking cry wolf", not "how often does it on this arc",
 * and the finding's own concern names the arc it is about.
 */
export function waypointChecksFor(store: Store, artifact: Artifact): CheckSubject[] {
  return positionsOf(store, artifact.episodeId).map((position) => ({
    key: WAYPOINT_CHECK_KEY,
    label: `“${position.arc.name}” @ waypoint ${position.waypoint.ordinal} — ${position.waypoint.name}`,
    instructions: WAYPOINT_INSTRUCTIONS,
    reference: waypointReference(store, position),
    // An arc is not canon until a landing is ratified (D8), so there is no entity this check
    // is about and nothing for a finding to name.
    subjectEntityIds: [],
  }))
}

/**
 * D8's instructions, in code because there is no sheet to put them on. They are the arc
 * equivalent of a category's `check_instructions` and they are read by a model exactly the
 * same way — which is why they say what a finding must contain rather than how to find one.
 */
const WAYPOINT_INSTRUCTIONS = [
  'This episode declares a position on an arc. Read the artifact against the waypoint it',
  'declares, and against the waypoints on either side of it.',
  '',
  'Behaviour AHEAD of the declared position is a finding: the episode lands something a later',
  'waypoint was supposed to land, and the later one has been spent early. Behaviour BEHIND it',
  'is a finding too: the episode declares a position it has not reached, and what is on screen',
  'is still the waypoint before.',
  '',
  'Say which waypoint the behaviour actually belongs to, and what landing the DECLARED one',
  'would have looked like on screen. An arc carried by what someone spends is not moved by',
  'what they argue, so quote the action rather than the line wherever both are available.',
  '',
  'Nothing here is canon yet. A waypoint is landed by a proposal Ryan ratifies (D8), so cite',
  'no fact ids: the waypoint prose below is what you are arguing from.',
].join('\n')

/** The arc's statement and every waypoint, so "ahead of or behind" has an order to measure in. */
function waypointReference(store: Store, position: ArcPosition): string[] {
  const lines = [
    `### The arc — “${position.arc.name}” (${position.arc.kind}, scope ${position.arc.scope})`,
    '',
    position.arc.statement.trim(),
    '',
    `### The waypoints, in order. This episode declares **waypoint ${position.waypoint.ordinal}**.`,
    '',
  ]
  for (const waypoint of waypointsOf(store, position.arc.id)) {
    const declared = waypoint.id === position.waypoint.id ? ' ← declared by this episode' : ''
    lines.push(
      `#### Waypoint ${waypoint.ordinal} — ${waypoint.name}${declared}`,
      '',
      `- what it means: ${waypoint.description.trim()}`,
      `- landing criteria: ${waypoint.landingCriteria.trim()}`,
      '',
    )
  }
  return lines
}

// ── Composing one check ─────────────────────────────────────────────────────────

const SYSTEM =
  'You review one artifact of a television episode against the canon it declares it touches. ' +
  'You quote spans that are actually in the text, word for word, and you cite only the facts ' +
  'you are given. You never invent a fact id, an entity, or a scene. Return one JSON object ' +
  'and nothing else: no preamble, no code fence, no commentary.'

/**
 * Everything one check needs, built once: the prompt it sends, the scope that prompt carried,
 * the gaps in that scope, and the closed sets a reply will be held to.
 *
 * The scope is `provenanceOf` then `factsInScope` per entity — **exactly the entities in
 * scope, never the whole bible** (invariant 2). It is the artifact's whole provenance rather
 * than only the subject category's entities, and that is not a widening: a world rule about
 * vacuum catches nobody until something in scope says what a body is, and the body is a
 * character. The category decides the INSTRUCTIONS and the SUBJECT; the artifact decides the
 * scope, which is what its provenance declaration is for.
 */
export function composeTextCheck(store: Store, request: TextCheckRequest): ComposedCheck {
  const where = episodeInShow(store, request.artifact.episodeId)
  if (!where) throw new Error(`no such episode: ${request.artifact.episodeId}`)

  // A craft reviewer reads no canon (D13), so none is loaded, none is recorded on its pass,
  // and the closed sets below stay empty — which is what refuses a citation from it.
  const readsCanon = request.subject.readsCanon !== false
  const provenance = readsCanon ? provenanceOf(store, request.artifact.id) : []
  const subjects = new Set(request.subject.subjectEntityIds)
  const scope: ScopeFactDraft[] = []
  const gaps: CheckGapDraft[] = []
  const factIds = new Set<string>()
  const entityIds = new Map<string, string>()

  const blocks = { subject: [] as string[], rest: [] as string[] }
  for (const entity of provenance) {
    entityIds.set(entity.name.toLowerCase(), entity.id)
    for (const alias of entity.aliases) entityIds.set(alias.toLowerCase(), entity.id)

    const loaded = factsInScope(store, entity.id)
    const carried: { fact: Fact; via: string }[] = [
      ...loaded.own.map((fact) => ({ fact, via: '' })),
      ...loaded.inheritance.flatMap((edge) =>
        edge.facts.map((fact) => ({ fact, via: edge.type.name })),
      ),
    ]
    for (const { fact, via } of carried) {
      scope.push({ factId: fact.id, entityId: entity.id, via })
      factIds.add(fact.id)
    }
    for (const edge of loaded.inheritance) {
      const gap = gapOf(entity, edge, request.subject)
      if (gap) gaps.push(gap)
    }

    const into = subjects.has(entity.id) ? blocks.subject : blocks.rest
    into.push(...entityBlock(entity, carried))
  }

  const lines: string[] = [
    `Show: “${where.show.title}” · season ${where.season.number}, episode ` +
      `${where.episode.number}, “${where.episode.title}”.`,
    `Artifact: ${request.artifact.kind} v${request.artifact.version}.`,
    '',
    `## What you are checking: ${request.subject.label}`,
    '',
    request.subject.instructions.trim(),
    '',
    ...(request.subject.reference.length > 0 ? [...request.subject.reference, ''] : []),
  ]

  if (blocks.subject.length > 0) {
    lines.push(
      '## The canon this check is about',
      '',
      'Cite a fact by the id in brackets; never cite one that is not listed here or below.',
      '',
      ...blocks.subject,
    )
  }
  if (blocks.rest.length > 0) {
    lines.push(
      '## The rest of the canon in scope',
      '',
      'Everything else this artifact declares it touches, and the only other facts loaded.',
      'A rule lands on a body, and this is where the bodies are.',
      '',
      ...blocks.rest,
    )
  }
  if (!readsCanon) {
    lines.push(
      '## You have been handed no canon',
      '',
      'This is a reading of the craft, so nothing about the world has been loaded for you.',
      'Cite no fact and name no entity: there is no list here to copy one from, and anything',
      'you cited would be invented. Argue with the words in front of you.',
      '',
    )
  }
  if (gaps.length > 0) {
    lines.push(
      '## What could not be checked',
      '',
      'Canon has not decided these. Do not guess at them and do not raise a finding about',
      'them — they are recorded as gaps already, and a rewrite of this artifact cannot answer',
      'one of them.',
      '',
      ...gaps.map((gap) => `- ${gap.detail}`),
      '',
    )
  }

  const scenes = sceneSpans(request.text, scenesOf(store, request.artifact.episodeId))
  if (scenes.length > 0) {
    lines.push(
      '## The scenes, numbered',
      '',
      ...scenes.map((span) => `${span.scene.ordinal} · ${span.scene.heading}`),
      '',
    )
  }

  const notes = request.priorNotes ?? []
  if (notes.length > 0) {
    lines.push(
      '## What the showrunner has already put down',
      '',
      'He read these findings and dismissed them, with his reasons. Do not raise them again',
      'unless something in this version makes them true where they were not.',
      '',
      ...notes.map(
        (note) =>
          `- ${note.checkKey ? `${note.checkKey}` : 'a check'}` +
          `${note.quote ? `, at “${note.quote}”` : ''}: “${note.note}”`,
      ),
      '',
    )
  }

  lines.push(
    `## The ${request.artifact.kind}`,
    '',
    request.text.trim(),
    '',
    '## What to return',
    '',
    ...shapeFor(readsCanon),
  )

  return {
    subject: request.subject,
    artifactId: request.artifact.id,
    kind: request.artifact.kind,
    version: request.artifact.version,
    system: SYSTEM,
    prompt: lines.join('\n'),
    scope,
    gaps,
    citable: { text: request.text, factIds, entityIds, scenes },
  }
}

/** One entity's block: what it is, and every fact loaded with it, inherited ones marked. */
function entityBlock(entity: CanonEntity, carried: { fact: Fact; via: string }[]): string[] {
  const aliases = entity.aliases.length > 0 ? ` (also: ${entity.aliases.join(', ')})` : ''
  const lines = [`### ${entity.name} — ${entity.categoryKey}${aliases}`]
  if (carried.length === 0) lines.push('- (no facts)')
  for (const { fact, via } of carried) {
    lines.push(`- [${fact.id}] ${fact.statement}${via === '' ? '' : ` (inherited via ${via})`}`)
  }
  lines.push('')
  return lines
}

/**
 * What one fact-carrying edge could not carry. `undefined` when it carried something, which
 * is the ordinary case and not a gap.
 *
 * The words come from the declaration (`species`), never from this file — D22's mechanism is
 * general and the noun is a Grey Harbor sheet's business (D23).
 */
function gapOf(
  entity: CanonEntity,
  edge: Inheritance,
  subject: CheckSubject,
): CheckGapDraft | undefined {
  if (edge.case === 'inherited') return undefined
  const via = edge.type.name
  const opening = `Could not check ${entity.name} against ${subject.label}`

  const detail: Record<CheckGapReason, string> = {
    'declared-unknown':
      `${opening} — ${via} undecided. The edge is declared and its target is not (D22): ` +
      `somebody looked and the world has not answered, so nothing travels it and nothing ` +
      `${via} would have carried is in scope.`,
    undeclared:
      `${opening} — no ${via} is declared at all. That is a sheet nobody finished rather ` +
      `than a question nobody has answered, and until it is declared nothing travels the edge.`,
    'source-has-no-facts':
      `${opening} — ${entity.name} declares ${via}${edge.source ? ` “${edge.source.name}”` : ''}, ` +
      `and it carries no facts yet. The edge is whole and there is nothing on the far end of it.`,
  }
  return { entityId: entity.id, reason: edge.case, via, detail: detail[edge.case] }
}

/**
 * Where each scene's text begins and ends, found by its own heading (D3: the headings came
 * out of this file in the first place).
 *
 * A heading the text does not carry — a board checked against a script's scenes, an artifact
 * re-delineated since — gets the whole text as its span. That is the honest fallback: it can
 * still refuse a quote nobody wrote, and it stops short of refusing a real one because this
 * function could not find a boundary.
 *
 * Exported for `panel.ts`: clustering resolves a stored quote back to the span it came from,
 * and it must land in exactly the run of text the anchor was verified against. Two answers to
 * "where is scene 4" would be two answers to "do these two findings overlap".
 */
export function sceneSpans(text: string, scenes: Scene[]): SceneSpan[] {
  const found = scenes.map((scene) => ({ scene, at: text.indexOf(scene.heading) }))
  return found.map(({ scene, at }, index) => {
    if (at < 0) return { scene, from: 0, to: text.length }
    const next = found.slice(index + 1).find((later) => later.at > at)
    return { scene, from: at, to: next?.at ?? text.length }
  })
}

/**
 * The shape, in the prompt rather than in a schema object — one system prompt, one user
 * prompt, one answer (llm/adapter.ts). Every line here is a rule the parser enforces, which
 * is the point: the prompt asks for exactly what will be accepted, and asking for anything
 * looser would only produce replies that fail the step.
 *
 * The last two lines are the only thing a craft reviewer's shape differs by, and they are
 * dropped rather than reworded: a reviewer that was handed no lists cannot be asked to copy
 * from them, and leaving the fields in the shape would be inviting exactly the citation the
 * parser is about to refuse (D13, `readsCanon`). One shape, one branch, one parser.
 */
function shapeFor(readsCanon: boolean): string[] {
  return [
    '```',
    '{',
    '  "findings": [{                    // [] when you have nothing to raise about this artifact',
    '    "scene": 4,                     // the scene number above. Omit for a whole-artifact finding.',
    '    "quote": "…",                   // WORD FOR WORD from the text above, inside that scene.',
    '                                    //   The shortest span that carries the problem. A quote',
    '                                    //   that is not in the text fails the whole answer.',
    '    "concern": "…",                 // what is wrong, and which exception you looked for and',
    '                                    //   did not find. Argue with the text, not with a vibe.',
    '    "severity": "high",             // "low" | "medium" | "high" — how bad this is IF true',
    '    "confidence": "high",           // "high" | "medium" | "low" — how sure you are it IS true.',
    '                                    //   These are two different questions. Never "certain":',
    '                                    //   that belongs to the checks that read rows.',
    ...(readsCanon
      ? [
          '    "entity": "Tobin Wick",         // an entity name from the lists above, or omit',
          '    "facts": ["fact_…"]             // fact ids from the lists above, in the order the card',
          '                                    //   should quote them. Never an id that is not listed.',
        ]
      : []),
    '  }]',
    '}',
    '```',
  ]
}

// ── Reading the reply ───────────────────────────────────────────────────────────

/**
 * Turns one reply into findings, or throws.
 *
 * **There is no partial success.** A reply with three good findings and one that cites a fact
 * nobody handed it is a reply from a model that has lost the thread, and salvaging the three
 * would file a check pass that reads as a complete run. The step fails, the runner tries
 * again (bounded at two retries, invariant 5), and three failures reach Ryan with the attempt
 * history rather than a green checkmark.
 */
export function readTextCheckReply(reply: string, composed: ComposedCheck): FindingDraft[] {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(reply.trim())
  const body = (fenced ? fenced[1]! : reply).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `The answer did not come back as a check — it is not JSON. It began: “${body.slice(0, 80)}…”`,
    )
  }
  const findings = (parsed as { findings?: unknown })?.findings
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(findings)) {
    throw new Error(
      'The answer did not come back as a check — it has no `findings` array. An empty array ' +
        'is how a check says it found nothing, and there is nothing to salvage without one.',
    )
  }

  return findings.map((raw, index) => draftOf(raw as Record<string, unknown>, index, composed))
}

function draftOf(
  raw: Record<string, unknown>,
  index: number,
  composed: ComposedCheck,
): FindingDraft {
  const at = `Finding ${index + 1} of the ${composed.subject.key} check`

  const concern = typeof raw.concern === 'string' ? raw.concern.trim() : ''
  if (concern === '') throw new Error(`${at} has no concern. A finding with nothing to say is not one.`)

  const severity = raw.severity
  if (!(FINDING_SEVERITY as readonly unknown[]).includes(severity)) {
    throw new Error(
      `${at} has severity “${String(severity)}”. It is one of ${FINDING_SEVERITY.join(', ')} — ` +
        'how bad this is if it is true.',
    )
  }
  const confidence = raw.confidence
  if (!(TEXT_CHECK_CONFIDENCE as readonly unknown[]).includes(confidence)) {
    throw new Error(
      confidence === 'certain'
        ? `${at} claims confidence “certain”. That belongs to the checks that read rows and ` +
          'answer without a reading (4.2); a text check is one of ' +
          `${TEXT_CHECK_CONFIDENCE.join(', ')}.`
        : `${at} has confidence “${String(confidence)}”. It is one of ` +
          `${TEXT_CHECK_CONFIDENCE.join(', ')} — how sure you are that it is true.`,
    )
  }

  const span = anchorOf(raw, at, composed)
  const entityId = entityOf(raw, at, composed)
  const factIds = factsOf(raw, at, composed)

  return {
    concern,
    severity: severity as FindingSeverity,
    confidence: confidence as FindingConfidence,
    anchor: { sceneId: span.sceneId, quote: span.quote },
    entityId,
    factIds,
  }
}

/**
 * The anchor, verified against the material (4.3). The scene must be one this episode has,
 * and the span must be inside it — a real sentence pinned to the wrong scene is a finding the
 * gate room would render in the wrong place, which is worse than one it cannot render at all.
 *
 * What is stored is the ARTIFACT's own text, not the model's transcription of it. They differ
 * wherever the file wraps a line, and the quote is what the UI searches for.
 */
function anchorOf(
  raw: Record<string, unknown>,
  at: string,
  composed: ComposedCheck,
): { sceneId: string | null; quote: string } {
  const { scenes, text } = composed.citable

  let span: SceneSpan | undefined
  if (raw.scene !== undefined && raw.scene !== null) {
    span = scenes.find((one) => one.scene.ordinal === Number(raw.scene))
    if (!span) {
      throw new Error(
        `${at} anchors at scene ${String(raw.scene)}, and this episode has no scene ` +
          `${String(raw.scene)} — it has ${scenes.length}. Scenes are derived from the ` +
          'written episode (D3), so there is no such place to point at.',
      )
    }
  }

  const claimed = typeof raw.quote === 'string' ? raw.quote.trim() : ''
  if (claimed === '') return { sceneId: span?.scene.id ?? null, quote: '' }

  const searched = span ? text.slice(span.from, span.to) : text
  const found = findSpan(searched, claimed)
  if (found === undefined) {
    throw new Error(
      span
        ? `${at} quotes “${claimed.slice(0, 60)}…”, which is not in scene ${span.scene.ordinal}. ` +
          'An anchor is a span of the material, searched for by quote (4.3) — a span that is ' +
          'not there lands nowhere.'
        : `${at} quotes “${claimed.slice(0, 60)}…”, which is not in the ${composed.kind}. An ` +
          'anchor is a span of the material (4.3), and this one is not in it.',
    )
  }
  return { sceneId: span?.scene.id ?? null, quote: found }
}

/**
 * The span as the artifact writes it. An exact hit first; failing that, the same words with
 * whatever whitespace the file put between them, because a markdown file wraps and a model
 * quoting across a wrap has still quoted what is there.
 */
function findSpan(haystack: string, needle: string): string | undefined {
  if (haystack.includes(needle)) return needle
  const words = needle.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return undefined
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  return new RegExp(pattern).exec(haystack)?.[0]
}

/** The entity a finding is about — one this artifact declares it touches, or nothing. */
function entityOf(
  raw: Record<string, unknown>,
  at: string,
  composed: ComposedCheck,
): string | undefined {
  if (typeof raw.entity !== 'string' || raw.entity.trim() === '') return undefined
  const entityId = composed.citable.entityIds.get(raw.entity.trim().toLowerCase())
  if (!entityId) {
    throw new Error(
      `${at} is about “${raw.entity}”, which is not one of the entities this script declares ` +
        'it touches. The prompt carried the whole list; naming something outside it is a ' +
        'broken read rather than a nuance (invariant 2).',
    )
  }
  return entityId
}

/** The facts a card will quote — every one of them handed to this check by name. */
function factsOf(
  raw: Record<string, unknown>,
  at: string,
  composed: ComposedCheck,
): string[] | undefined {
  if (!Array.isArray(raw.facts)) return undefined
  for (const factId of raw.facts) {
    if (typeof factId !== 'string' || !composed.citable.factIds.has(factId)) {
      throw new Error(
        `${at} quotes “${String(factId)}”, which is not one of the facts this check was ` +
          'handed. The gate room renders a quoted fact with its lineage, and an invented id ' +
          'has no lineage to render — it is refused rather than dropped.',
      )
    }
  }
  return raw.facts as string[]
}

// ── Recording ───────────────────────────────────────────────────────────────────

/**
 * One pass of one check, with what it found, what it was handed, and what it could not reach.
 *
 * Written through `recordCheckPass` like every other check in the app, in one transaction:
 * the scope a pass ran with and the findings it raised are one act, and a half-written pass
 * would be a report card with no exam paper behind it.
 */
export function recordTextCheck(
  store: Store,
  composed: ComposedCheck,
  findings: FindingDraft[],
): CheckPass {
  return recordCheckPass(store, {
    checkKey: composed.subject.key,
    tier: 'text',
    artifactId: composed.artifactId,
    version: composed.version,
    findings,
    scope: composed.scope,
    gaps: composed.gaps,
  })
}
