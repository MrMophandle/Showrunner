import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { declareProvenance, recordArtifact, type Artifact } from './artifact.ts'
import { registerEntity } from './canon.ts'
import { declareCategory } from './category.ts'
import { dismissFinding, findingsOfPass, recordCheckPass } from './finding.ts'
import { createProposalRulings, raiseProposal } from './proposal.ts'
import {
  createEpisode,
  episodesOf,
  seasonsOf,
  type Episode,
  type Season,
} from './spine.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { createRulings, presentForRuling } from '../runner/gate.ts'
import { findStepByName, reconcileSteps, recordRun } from '../runner/run.ts'
import type { Runner } from '../runner/runner.ts'
import { scaffoldStage } from '../runner/stage-fixture.ts'
import { composeWriteContext, nameAppearingIn, type WriteContext } from './write-context.ts'

/**
 * The writer's desk (E4-0): what a writing step is handed, composed fresh out of records
 * five epics already laid down.
 *
 * The hard 20% is the **audience-knowledge filter**, and it has one test per edge below.
 * Every one of them is a lineage question rather than a clock question, because episodes
 * parallelize (D7): ep03 can ratify canon on a Tuesday while ep02 is still being written,
 * and `canonAsOf(now)` would hand ep02's writer next month's episode.
 *
 * The planted world under these tests is Grey Harbor **founded** — six sheets Ryan ruled —
 * plus the things a fixture deliberately does not carry: an ep03 to be the future, a house
 * style nobody wrote, an ep02 premise nobody wrote, a rejection at a gate and a dismissal
 * on a finding. Every one of them is planted through the real API.
 */

let root: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let season: Season
let ep01: Episode
let ep02: Episode
let ep03: Episode
let premise: Artifact

/** A premise nobody in the fixture wrote, named to put Ilse in the slice and Sefa out. */
const PREMISE_TEXT = [
  '# Dry Stores — premise',
  '',
  'The water plant’s exchanger fails three weeks after the harbourmaster took its',
  'spare for the beacon. Ilse Renn works the shortage the way she works everything',
  'else: off the roster, without saying whose week it costs.',
].join('\n')

const HOUSE_STYLE_BODY = [
  'The narrator never explains the harbour. Sentences are short when something is',
  'breaking and long when nobody will say why. No scene ends on a question.',
].join('\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-write-context-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)

  season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!
  ep02 = episodes[1]!
  // The future. The fixture stops at two episodes, and this filter is only testable
  // against an episode that has ratified canon ep02's audience has not seen.
  ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Slack Water' })

  premise = writePremise(PREMISE_TEXT)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Planting ────────────────────────────────────────────────────────────────────

/** The ep02 premise-brief, on the volume and in the row — the outline step's upstream. */
function writePremise(text: string): Artifact {
  const path = join('greyharbor', 's01e02', 'premise.md')
  mkdirSync(dirname(join(paths.artifactDir, path)), { recursive: true })
  writeFileSync(join(paths.artifactDir, path), text, 'utf8')
  const artifact = recordArtifact(store, {
    episodeId: ep02.id,
    kind: 'premise-brief',
    filePath: path,
    touches: [harbor.entity('Grey Harbor Station').id],
  })
  return artifact
}

/** A fact ratified into canon, riding the episode named — or riding nothing (the bench). */
function ratifyFact(entity: string, statement: string, episodeId?: string): void {
  const proposal = raiseProposal(store, {
    entityId: harbor.entity(entity).id,
    kind: 'fact-delta',
    raisedBy: 'writer',
    ...(episodeId !== undefined && { episodeId }),
    facts: [{ statement }],
  })
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'yes.' })
}

/** A claim riding an episode with nobody having ruled it — provisional, visible to checks. */
function rideFact(entity: string, statement: string, episodeId: string): string {
  const proposal = raiseProposal(store, {
    entityId: harbor.entity(entity).id,
    kind: 'fact-delta',
    raisedBy: 'writer',
    episodeId,
    facts: [{ statement }],
  })
  return proposal.id
}

/**
 * A house style, promoted the way canon is made. The fixture deliberately ships no
 * house-style sheet (`show.md` says so), and the desk must carry its prose anyway.
 */
function foundHouseStyle(): void {
  const category = declareCategory(store, {
    showId: harbor.show.id,
    key: 'house-style',
    name: 'House style',
    blurb: 'Narrator voice, pacing, content constraints.',
    appliesTo: ['outline', 'script'],
    checkInstructions: 'Read the draft against the voice below.',
  })
  const entity = registerEntity(store, {
    showId: harbor.show.id,
    categoryKey: category.key,
    name: 'The Grey Harbor voice',
  })
  const proposal = raiseProposal(store, {
    entityId: entity.id,
    kind: 'promotion',
    raisedBy: 'ryan',
    standing: 'core',
    body: HOUSE_STYLE_BODY,
  })
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'that is it.' })
}

/**
 * A gate over the ep02 outline, rejected twice — the rounds a later writer run reads back
 * (4.4). The runner below refuses to be called, which is the proof that a ruling on a run
 * nobody parked moves no run.
 */
const idleRunner: Runner = {
  enqueueRun: () => {
    throw new Error('this test enqueues nothing')
  },
  resumeRun: () => {
    throw new Error('a gate over a run nobody parked must not resume one')
  },
  resumeInterrupted: () => [],
  settled: () => {
    throw new Error('this test settles nothing')
  },
}

/** The outline artifact, its gate, and two rejections on it. Returns the outline. */
function rejectTheOutlineTwice(): Artifact {
  const outline = recordArtifact(store, {
    episodeId: ep02.id,
    kind: 'outline',
    filePath: join('greyharbor', 's01e02', 'outline.md'),
  })
  writeFileSync(join(paths.artifactDir, outline.filePath!), '# Dry Stores — outline\n', 'utf8')

  const stage = scaffoldStage('write', [{ name: 'write-outline', execute: async () => ({}) }])
  const run = recordRun(store, stage, ep02.id)
  reconcileSteps(store, run.id, stage)
  const step = findStepByName(store, run.id, 'write-outline')!
  const where = { runId: run.id, stepId: step.id, episodeId: ep02.id }
  const rulings = createRulings(store, createEventLog(store), idleRunner)

  const round1 = presentForRuling(store, where, { artifactId: outline.id })
  rulings.reject(round1.gate.id, {
    notes: [{ note: 'the exchanger is a plot device, not a problem.', depth: 'premise' }],
  })
  const round2 = presentForRuling(store, where, { artifactId: outline.id })
  rulings.reject(round2.gate.id, {
    notes: [{ note: 'Tobin cannot be the one who notices — he is off shift.', depth: 'scene' }],
  })
  return outline
}

/** One more round at that same gate — a note routed at the artifact he is standing at (#76). */
function rejectTheOutlineAgain(outline: Artifact, note: { note: string; depth: 'outline' }): void {
  const run = store.get<{ id: string }>('SELECT id FROM run WHERE episode_id = ?', ep02.id)!
  const step = findStepByName(store, run.id, 'write-outline')!
  const round = presentForRuling(
    store,
    { runId: run.id, stepId: step.id, episodeId: ep02.id },
    { artifactId: outline.id },
  )
  createRulings(store, createEventLog(store), idleRunner).reject(round.gate.id, { notes: [note] })
}

/** A world-rules finding on the ep01 script, dismissed with a note (E3-5's reader). */
function dismissAFinding(): string {
  const script = store.get<{ id: string }>(
    "SELECT id FROM artifact WHERE episode_id = ? AND kind = 'script'",
    ep01.id,
  )!
  const pass = recordCheckPass(store, {
    checkKey: 'world-rules',
    tier: 'text',
    artifactId: script.id,
    findings: [
      {
        concern: 'Tobin is outside the hull in coveralls.',
        severity: 'high',
        confidence: 'high',
        anchor: { quote: 'he took the torque bar' },
      },
    ],
  })
  const finding = findingsOfPass(store, pass.id)[0]!
  const note = 'the pier housing counts as inside for this one — I have ruled it before.'
  dismissFinding(store, finding.id, note)
  return note
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const outlineDesk = (): WriteContext =>
  composeWriteContext(store, paths, { episodeId: ep02.id, step: 'outline' })

const statements = (context: WriteContext): string[] =>
  context.entities.flatMap((entity) => entity.facts.map((held) => held.fact.statement))

const names = (context: WriteContext): string[] =>
  context.entities.map((entity) => entity.entity.name)

/** Every table in the library, as text — the proof that a read wrote nothing. */
function snapshot(): string {
  return store
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .map(({ name }) => {
      const rows = store
        .all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .map((row) => JSON.stringify(row))
        .sort()
      return `${name}: ${rows.join(' | ')}`
    })
    .join('\n')
}

// ── The prose the show is written to ────────────────────────────────────────────

describe('what the desk hands a writing step', () => {
  it('carries the world rules prose the show does not get to bend', () => {
    const rules = outlineDesk().entities.find(
      (entity) => entity.entity.name === 'The hull and the void',
    )

    expect(rules).toBeDefined()
    expect(rules!.entity.body).toContain('two hundred years calling itself')
    expect(rules!.facts.map((held) => held.fact.statement)).toContainEqual(
      expect.stringContaining('Outside the hull is vacuum.'),
    )
  })

  it('carries the house style prose, through no door of its own', () => {
    foundHouseStyle()
    const voice = outlineDesk().entities.find(
      (entity) => entity.entity.name === 'The Grey Harbor voice',
    )

    expect(voice).toBeDefined()
    expect(voice!.entity.body).toBe(HOUSE_STYLE_BODY)
    // It arrives the way the world rules do — as a core-standing entity of a category the
    // show declares. Nothing in the composer knows the words `house-style` or `world-rules`.
    expect(voice!.reasons.map((reason) => reason.reason)).toEqual(['core'])
  })

  it('carries the premise it writes from, off the volume', () => {
    const context = outlineDesk()

    expect(context.upstream.expected).toBe('premise-brief')
    expect(context.upstream.artifact!.id).toBe(premise.id)
    expect(context.upstream.text).toBe(PREMISE_TEXT)
    expect(context.upstream.note).toBeNull()
  })

  it('says which kind of nothing an unwritten upstream is', () => {
    const beforeAnything = composeWriteContext(store, paths, {
      episodeId: ep03.id,
      step: 'outline',
    })
    expect(beforeAnything.upstream.artifact).toBeNull()
    expect(beforeAnything.upstream.note).toContain('no premise-brief')

    const first = composeWriteContext(store, paths, { episodeId: ep02.id, step: 'premise' })
    expect(first.upstream.expected).toBeNull()
    expect(first.upstream.note).toContain('reads from nothing')
  })
})

// ── The audience-knowledge filter, one test per edge ────────────────────────────

describe('canon as the audience of this episode knows it', () => {
  it('holds a fact an EARLIER episode ratified', () => {
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01.id)

    expect(statements(outlineDesk())).toContain(
      'Ilse signed the beacon over to Tobin for one night.',
    )
  })

  it('refuses a fact a LATER episode ratified, which canonAsOf(now) would show', () => {
    ratifyFact('Ilse Renn', 'Ilse told the crew the lane is never reopening.', ep03.id)

    expect(statements(outlineDesk())).not.toContain(
      'Ilse told the crew the lane is never reopening.',
    )
  })

  it('holds a fact ruled at the bench, riding no episode at all', () => {
    ratifyFact('Ilse Renn', 'Ilse keeps a lathe in dry stores nobody signed for.')

    const held = statements(outlineDesk())
    expect(held).toContain('Ilse keeps a lathe in dry stores nobody signed for.')
    // And the founding facts, which ride nothing either — show-level canon, the audience's
    // from the start, and the whole of a first episode's canon plus the bench.
    expect(held).toContain(
      "Ilse has held the harbourmaster's post at Grey Harbor for eleven years.",
    )
  })

  it("holds this episode's OWN provisional claims, so scene 9 cannot contradict scene 4", () => {
    rideFact('Ilse Renn', 'Ilse has three days of water left and has not said so.', ep02.id)

    expect(statements(outlineDesk())).toContain(
      'Ilse has three days of water left and has not said so.',
    )
  })

  it("refuses another episode's provisional claims, always", () => {
    rideFact('Ilse Renn', 'Ilse resigned the post in the ep01 draft nobody ruled.', ep01.id)
    rideFact('Ilse Renn', 'Ilse resigned the post in the ep03 draft nobody ruled.', ep03.id)

    const held = statements(outlineDesk())
    expect(held).not.toContain('Ilse resigned the post in the ep01 draft nobody ruled.')
    expect(held).not.toContain('Ilse resigned the post in the ep03 draft nobody ruled.')
  })

  it('still holds what a LATER episode superseded — the audience has not seen the change', () => {
    ratifyFact('Ilse Renn', 'The beacon runs on the number four cell.', ep01.id)
    // The RATIFIED row: a claim riding ep01 became canon at its ruling, and the provisional
    // it superseded still carries the same words (fact.ts — ratifying writes a new row).
    const standing = store.get<{ id: string }>(
      'SELECT id FROM fact WHERE statement = ? AND ratified_by IS NOT NULL',
      'The beacon runs on the number four cell.',
    )!
    const later = raiseProposal(store, {
      entityId: harbor.entity('Ilse Renn').id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep03.id,
      facts: [
        { statement: 'The beacon runs off the water plant.', supersedes: standing.id },
      ],
    })
    createProposalRulings(store, createEventLog(store)).ratify(later.id, { note: 'yes.' })

    const held = statements(outlineDesk())
    expect(held).toContain('The beacon runs on the number four cell.')
    expect(held).not.toContain('The beacon runs off the water plant.')
  })

  it('says which door each fact came through', () => {
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01.id)
    ratifyFact('Ilse Renn', 'Ilse re-cut the roster on the day the exchanger failed.', ep02.id)
    rideFact('Ilse Renn', 'Ilse has three days of water left and has not said so.', ep02.id)

    const ilse = outlineDesk().entities.find((entity) => entity.entity.name === 'Ilse Renn')!
    const reach = new Map(ilse.facts.map((held) => [held.fact.statement, held.reach]))

    expect(
      reach.get("Ilse has held the harbourmaster's post at Grey Harbor for eleven years."),
    ).toBe('show-level')
    expect(reach.get('Ilse signed the beacon over to Tobin for one night.')).toBe(
      'established-earlier',
    )
    expect(reach.get('Ilse re-cut the roster on the day the exchanger failed.')).toBe(
      'established-here',
    )
    expect(reach.get('Ilse has three days of water left and has not said so.')).toBe('riding')
  })

  it('carries what a character inherits from its species (D22), filtered the same way', () => {
    ratifyFact('Halvani', 'Halvani lose fine motor control below four degrees.', ep03.id)

    const tobin = outlineDesk().entities.find((entity) => entity.entity.name === 'Tobin Wick')!
    const inherited = tobin.facts.filter((held) => held.inherited !== null)

    expect(inherited.length).toBeGreaterThan(0)
    expect(inherited[0]!.inherited!.source.name).toBe('Halvani')
    expect(inherited[0]!.inherited!.via).toBe('species')
    expect(tobin.facts.map((held) => held.fact.statement)).not.toContain(
      'Halvani lose fine motor control below four degrees.',
    )
  })
})

// ── The entity slice, and the record of it ──────────────────────────────────────

describe('the entity slice', () => {
  it('records why every entity is in it', () => {
    const context = outlineDesk()
    const reasons = new Map(
      context.entities.map((entity) => [
        entity.entity.name,
        entity.reasons.map((reason) => reason.reason),
      ]),
    )

    expect(reasons.get('Grey Harbor Station')).toEqual(['provenance', 'core'])
    expect(reasons.get('Ilse Renn')).toEqual(['named', 'core'])
    expect(reasons.get('Halvani')).toEqual(['core'])
  })

  it('says why the entity it left out is not there', () => {
    const context = outlineDesk()

    expect(names(context)).not.toContain('Sefa Doule')
    const left = context.leftOut.find((entity) => entity.name === 'Sefa Doule')
    expect(left).toBeDefined()
    expect(left!.because).toContain('not in the ep02 premise-brief’s provenance')
    expect(left!.because).toContain('not named')
    expect(left!.because).toContain('candidate')
  })

  it('lets the upstream name an entity into the slice that no standing would', () => {
    writeFileSync(
      join(paths.artifactDir, premise.filePath!),
      `${PREMISE_TEXT}\n\nSefa Doule has the only working exchanger key.`,
      'utf8',
    )

    const sefa = outlineDesk().entities.find((entity) => entity.entity.name === 'Sefa Doule')
    expect(sefa).toBeDefined()
    expect(sefa!.reasons.map((reason) => reason.reason)).toEqual(['named'])
    expect(sefa!.reasons[0]!.because).toContain('Sefa Doule')
  })

  /**
   * The `named` door's own matcher, exported because a WRITING step needs it pointing the
   * other way: the desk names entities out of what it READS, and a writer has to declare
   * provenance out of what it WROTE (invariant 2). One matcher, so "named in the upstream"
   * and "named in the draft" can never mean two different things.
   */
  it('lends its matcher out, and answers with the term that matched', () => {
    const ilse = harbor.entity('Ilse Renn')

    expect(nameAppearingIn('Ilse Renn works the shortage off the roster.', ilse)).toBe('Ilse Renn')
    // An alias counts, and the term that matched is what comes back — never the name.
    expect(nameAppearingIn('The harbourmaster works the shortage.', ilse)).toBe('the harbourmaster')
    expect(nameAppearingIn('The exchanger fails on a Tuesday.', ilse)).toBeUndefined()
    // Bounded by letters and digits rather than by `\b`, which is what stops the station's
    // "the harbour" matching inside "the harbourmaster".
    const station = harbor.entity('Grey Harbor Station')
    expect(nameAppearingIn('the harbourmaster took the spare', station)).toBeUndefined()
    expect(nameAppearingIn('nothing moves in the harbour tonight', station)).toBe('the harbour')
  })

  it('refuses to add an entity this show does not have', () => {
    expect(() =>
      composeWriteContext(store, paths, {
        episodeId: ep02.id,
        step: 'outline',
        include: ['ent_nobody'],
      }),
    ).toThrow(/ent_nobody/)
  })

  it('takes an entity the caller adds, and records that as the reason', () => {
    const context = composeWriteContext(store, paths, {
      episodeId: ep02.id,
      step: 'outline',
      include: [harbor.entity('Sefa Doule').id],
    })

    const sefa = context.entities.find((entity) => entity.entity.name === 'Sefa Doule')!
    expect(sefa.reasons.map((reason) => reason.reason)).toEqual(['added'])
    expect(context.leftOut.map((entity) => entity.name)).not.toContain('Sefa Doule')
  })
})

// ── Notes: one record, many readers, and the origin travels ─────────────────────

describe('the notes Ryan has already written', () => {
  it('reads back a rejection with the round it was given at', () => {
    const outline = rejectTheOutlineTwice()
    const context = outlineDesk()

    // Round 1's note was routed at PREMISE depth, so it is addressed to the premise-brief and
    // is not this writer's to answer (E4-5, `domain/routing.ts`) — handing it over here as
    // well would print one instruction to two writers. What is left is round 2's, which lands
    // on this draft because a scene is a scene OF it.
    const rejections = context.notes.filter((note) => note.origin.kind === 'gate-rejection')
    expect(rejections.map((note) => note.note)).toEqual([
      'Tobin cannot be the one who notices — he is off shift.',
    ])

    const latest = rejections[0]!
    expect(latest.origin).toMatchObject({
      kind: 'gate-rejection',
      round: 2,
      artifactId: outline.id,
      depth: 'scene',
    })
    expect(latest.sentence).toContain('round 2')
  })

  it('sends the note he routed to the premise onto the premise-brief’s desk instead', () => {
    rejectTheOutlineTwice()

    const premise = composeWriteContext(store, paths, { episodeId: ep02.id, step: 'premise' })
    const routed = premise.notes.filter((note) => note.origin.kind === 'routed-rejection')

    expect(routed.map((note) => note.note)).toEqual([
      'the exchanger is a plot device, not a problem.',
    ])
    expect(routed[0]!.sentence).toBe('your note from the ep02 outline gate, routed here')
    expect(routed[0]!.origin).toMatchObject({
      kind: 'routed-rejection',
      depth: 'premise',
      fromKind: 'outline',
      round: 1,
      addressed: false,
    })
  })

  /**
   * **The desk's half of the split issue #76 closed** (`domain/routing.ts`).
   *
   * A note Ryan writes at the outline's own gate and routes at OUTLINE depth is addressed to
   * the very artifact he was standing at. The OFFER now reads exactly that note — it is what
   * reopens the stage that could write the draft again — and the desk must go on reading it
   * once, as the ordinary rejection it is. Two origins for one row would hand a writer one
   * instruction twice, with two different attributions on it.
   */
  it('reads a note he routed at its own artifact once, and as his rejection of it', () => {
    const outline = rejectTheOutlineTwice()
    rejectTheOutlineAgain(outline, {
      note: 'the middle movement does not turn.',
      depth: 'outline',
    })

    const notes = outlineDesk().notes.filter((note) => note.note.includes('does not turn'))
    expect(notes).toHaveLength(1)
    expect(notes[0]!.origin.kind).toBe('gate-rejection')
    expect(notes[0]!.sentence).toBe('your round 3 rejection of the ep02 outline, routed at outline depth')
  })

  it('reads a dismissal note through the reader the checks use', () => {
    const note = dismissAFinding()
    const dismissals = outlineDesk().notes.filter(
      (one) => one.origin.kind === 'finding-dismissal',
    )

    expect(dismissals.map((one) => one.note)).toEqual([note])
    expect(dismissals[0]!.origin).toMatchObject({
      kind: 'finding-dismissal',
      checkKey: 'world-rules',
    })
    expect(dismissals[0]!.sentence).toContain('world-rules')
  })

  it('tells the three origins apart in one stream, and puts each on the right desk', () => {
    rejectTheOutlineTwice()
    dismissAFinding()

    // The outline's desk: his round-2 rejection of THIS draft, and the finding he dismissed.
    const outline = outlineDesk().notes.map((note) => note.origin.kind)
    expect(outline).toContain('gate-rejection')
    expect(outline).toContain('finding-dismissal')
    expect(outline).toHaveLength(2)

    // The premise-brief's: the note he routed there, and the same dismissal — the show's whole
    // dismissal stream reaches every desk (finding.ts), and a routed note reaches one.
    const premise = composeWriteContext(store, paths, { episodeId: ep02.id, step: 'premise' })
    expect(premise.notes.map((note) => note.origin.kind).sort()).toEqual([
      'finding-dismissal',
      'routed-rejection',
    ])
  })
})

// ── Arcs ────────────────────────────────────────────────────────────────────────

describe('arcs on the desk', () => {
  it("carries the season's arcs with their waypoints, and reports vanilla as vanilla", () => {
    const context = outlineDesk()

    expect(context.arcs).toHaveLength(1)
    expect(context.arcs[0]!.arc.name).toBe('What the harbor is for')
    expect(context.arcs[0]!.arc.statement).toContain('what the harbour is actually for')
    expect(context.arcs[0]!.waypoints.map((waypoint) => waypoint.name)).toEqual([
      'The harbor is a job',
      'The harbor is worth spending on',
      'The harbor is hers',
    ])
    expect(context.arcs[0]!.waypoints[1]!.description).toContain('spends something real')
    expect(context.arcs[0]!.position).toBeNull()
    expect(context.vanilla).toBe(true)
  })

  it("carries this episode's declared position when it has one", () => {
    const context = composeWriteContext(store, paths, { episodeId: ep01.id, step: 'script' })

    expect(context.vanilla).toBe(false)
    expect(context.arcs[0]!.position!.waypoint.ordinal).toBe(2)
  })
})

// ── A pure read, provably ───────────────────────────────────────────────────────

describe('the composition is a read', () => {
  it('composes the identical value twice', () => {
    foundHouseStyle()
    rejectTheOutlineTwice()
    dismissAFinding()
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01.id)
    rideFact('Tobin Wick', 'Tobin has not slept since the exchanger went.', ep02.id)

    expect(outlineDesk()).toEqual(outlineDesk())
  })

  it('leaves every table byte-identical, the event log included', () => {
    foundHouseStyle()
    rejectTheOutlineTwice()
    dismissAFinding()

    const before = snapshot()
    outlineDesk()
    composeWriteContext(store, paths, { episodeId: ep01.id, step: 'script' })
    composeWriteContext(store, paths, { episodeId: ep02.id, step: 'premise' })

    expect(snapshot()).toBe(before)
  })
})

// ── The sentence ────────────────────────────────────────────────────────────────

describe('the desk says what it handed over', () => {
  it('composes the line the inspector renders', () => {
    expect(outlineDesk().sentence).toBe(
      'The ep02 outline desk — reading the ep02 premise-brief v1, 6 canon entities in ' +
        'scope and 1 left out, canon as the audience knows it at ep02, 1 arc (vanilla), ' +
        'no notes standing.',
    )
  })
})
