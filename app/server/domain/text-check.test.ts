import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { promotionFromSheet } from '../fixture/load.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { readFixture } from '../fixture/read.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, declareProvenance, type Artifact } from './artifact.ts'
import { positionsOf } from './arc.ts'
import { recordExtractedBoard } from './board.ts'
import { runBoardRules } from './board-rules.ts'
import { factsOfEntity, findRuling } from './fact.ts'
import {
  checkPassesOf,
  findingsIn,
  findingsOfPass,
  gapsAbout,
  gapsOfPass,
  scopeOfPass,
} from './finding.ts'
import { createProposalRulings, raiseProposal } from './proposal.ts'
import { scenesOf } from './spine.ts'
import {
  categoryChecksFor,
  composeTextCheck,
  readTextCheckReply,
  recordTextCheck,
  waypointChecksFor,
  type CheckSubject,
  type ComposedCheck,
} from './text-check.ts'

/**
 * The semantic tier (3.4, 4.2): **one checker, parameterized by category**, reading an
 * artifact against exactly the canon it declares it touches.
 *
 * Not one test here calls a model. What the fake proves is everything that is ours: what the
 * prompt CARRIES (invariant 2, asserted against the composed string rather than against an
 * intention), what a reply is allowed to CLAIM (a span that is really there, a fact id that
 * is really in scope), and what the tier records when it cannot look at all.
 *
 * The Long Pier is the fixed point. One planted world-rules defect in scene 4, and two rules
 * of *The hull and the void* obeyed on purpose everywhere — so the silence is a measurement.
 */

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-text-check-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

interface LongPier {
  harbor: FoundedFixture
  episodeId: string
  script: Artifact
  text: string
}

function theLongPier(): LongPier {
  const harbor = greyHarborFounded(store, paths)
  const episodeId = store.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  const script = artifactsOf(store, episodeId).find((a) => a.kind === 'script')!
  const text = readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')
  return { harbor, episodeId, script, text }
}

/** The check for one category of the show, by key — the parameter the whole tier turns on. */
function subject(pier: LongPier, categoryKey: string): CheckSubject {
  const found = categoryChecksFor(store, pier.script).find((check) => check.key === categoryKey)
  if (!found) throw new Error(`no ${categoryKey} check fires on this script`)
  return found
}

function compose(pier: LongPier, categoryKey: string): ComposedCheck {
  return composeTextCheck(store, {
    artifact: pier.script,
    text: pier.text,
    subject: subject(pier, categoryKey),
  })
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((f) => f.statement.includes(needle))!.id
}

/**
 * Sefa Doule, promoted through the real ruling API — because only a ratification writes a
 * relation (invariant 1), and her `species: unknown` edge has to be real canon for the gap to
 * be recorded for the right reason.
 */
function promoteSefa(harbor: FoundedFixture): string {
  const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
  const id = harbor.entity('Sefa Doule').id
  const proposal = raiseProposal(store, promotionFromSheet(sheet, id, harbor.entities))
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, {
    note: 'Sefa walks the pier in this test; promote the sheet',
  })
  return id
}

/** What a good world-rules reply to The Long Pier looks like coming back off the wire. */
function theSceneFourReply(): string {
  return JSON.stringify({
    findings: [
      {
        scene: 4,
        // Spans a line break in the file on purpose: the span is verified against the
        // artifact's own text, which wraps, and a quote that only matches after the wrap is
        // collapsed is still a real span.
        quote:
          'Tobin comes out onto the pier in his coveralls and goes down the spar hand over hand',
        concern:
          'Tobin works the housing at the head of the Long Pier for three minutes in his ' +
          'coveralls. The rule names two exceptions — a sealed hardsuit or an active ' +
          'containment field — and the scene shows neither; the collars are on their pegs ' +
          'in scene 3. Nine seconds to unconsciousness, two minutes to dead.',
        severity: 'high',
        confidence: 'high',
        entity: 'Tobin Wick',
        facts: [factOf('Halvani', 'loses consciousness'), factOf('The hull and the void', 'Outside the hull is vacuum')],
      },
    ],
  })
}

// ── Invariant 2, proved against the string that is actually sent ────────────────

describe('the prompt carries exactly the entities in scope', () => {
  it('loads the artifact’s provenance and no more, with inherited facts marked (D22)', () => {
    const pier = theLongPier()
    promoteSefa(pier.harbor)

    const composed = compose(pier, 'world-rules')

    // In scope through Tobin's declared `species` edge, and the prompt says which edge it
    // travelled — the fact that makes the scene-4 violation checkable at all.
    expect(composed.prompt).toContain(
      'A Halvani in unprotected vacuum — no hardsuit, no active containment field — loses ' +
        'consciousness in about nine seconds and dies inside two minutes.',
    )
    expect(composed.prompt).toMatch(/loses\s+consciousness[\s\S]{0,200}?\(inherited via species\)/)

    // Sefa Doule is real, ratified canon in this show — and she is not in this script's
    // provenance, so not one word of her reaches the check. Scope is what you SEND.
    expect(composed.prompt).not.toContain('Sefa Doule')
    expect(composed.prompt).not.toContain('sent by the line office')
    expect(composed.scope.map((loaded) => loaded.factId)).not.toContain(
      factOf('Sefa Doule', 'line office'),
    )
  })

  it('is parameterized by the category’s own check instructions, which are data', () => {
    const pier = theLongPier()

    // Verbatim, both of them, from `_category.md` by way of `canon_category` — the checker
    // knows the word `world-rules` no better than it knows the word `character`.
    expect(compose(pier, 'world-rules').prompt).toContain(
      "Fire per scene, with the location's facts and the facts of **every species in the\nscene** loaded alongside (D22).",
    )
    expect(compose(pier, 'character').prompt).toContain(
      'Read the artifact against exactly the facts loaded for this character and for the\nspecies it declares.',
    )
  })

  it('fires one check per category the artifact’s kind and provenance both reach (4.1)', () => {
    const pier = theLongPier()

    expect(categoryChecksFor(store, pier.script).map((check) => check.key)).toEqual([
      'character',
      'location',
      'species',
      'technology',
      'world-rules',
    ])
  })

  it('accepts prior dismissal notes as context, and sends them (4.4)', () => {
    const pier = theLongPier()

    const composed = composeTextCheck(store, {
      artifact: pier.script,
      text: pier.text,
      subject: subject(pier, 'world-rules'),
      priorNotes: [
        { checkKey: 'world-rules', quote: 'four Kestrel collars', note: 'a stowed collar is not worn — you were right to fire' },
      ],
    })

    expect(composed.prompt).toContain('a stowed collar is not worn — you were right to fire')
    expect(composed.prompt).toContain('four Kestrel collars')
  })
})

// ── The planted defect ─────────────────────────────────────────────────────────

describe('the world-rules finding on scene 4', () => {
  it('anchors at a real span in scene 4 and quotes the Halvani fact with its lineage', () => {
    const pier = theLongPier()
    const scenes = scenesOf(store, pier.episodeId)
    const composed = compose(pier, 'world-rules')

    const pass = recordTextCheck(store, composed, readTextCheckReply(theSceneFourReply(), composed))
    const [finding] = findingsOfPass(store, pass.id)

    expect(pass).toMatchObject({ checkKey: 'world-rules', tier: 'text', findingCount: 1, gapCount: 0 })
    expect(finding).toMatchObject({
      checkKey: 'world-rules',
      tier: 'text',
      severity: 'high',
      // Never `certain`: that belongs to the tier that reads rows, not to a model's opinion
      // of its own reading (4.2, invariant 4).
      confidence: 'high',
      entityId: pier.harbor.entity('Tobin Wick').id,
      status: 'open',
    })

    // The anchor is the SCRIPT's own text, at scene 4 — and the span stored is the file's
    // wrapping rather than the model's, so the gate room's search for it lands.
    expect(finding!.anchor.sceneId).toEqual(scenes[3]!.id)
    expect(finding!.anchor.artifactId).toEqual(pier.script.id)
    expect(pier.text).toContain(finding!.anchor.quote)
    expect(finding!.anchor.quote).toContain('hand over\nhand')

    // "concern — entity + fact with lineage, quoted" (4.3). The lineage is the founding
    // ruling: these facts were ratified when Grey Harbor was founded, and the card renders
    // that off the fact rather than off a transcription.
    const halvani = finding!.facts[0]!
    expect(halvani.statement).toContain('loses consciousness in about nine seconds')
    expect(halvani.status).toEqual('ratified')
    expect(findRuling(store, halvani.ratifiedBy!)!.kind).toEqual('ratification')
    expect(finding!.facts[1]!.statement).toContain('Outside the hull is vacuum')
  })

  it('clusters with the board’s deterministic finding rather than deferring to it (4.5)', () => {
    const pier = theLongPier()
    const scenes = scenesOf(store, pier.episodeId)

    // E3-1's tier, over the same script: the board's vacuum rule fires on scene 4 because
    // the rows prove it — an exposed scene, a body with no protection, a hazard fact in
    // that body's scope.
    const board = recordExtractedBoard(store, {
      episodeId: pier.episodeId,
      scriptId: pier.script.id,
      extraction: theLongPierExtraction({
        lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
        halvaniVacuum: factOf('Halvani', 'loses consciousness'),
      }),
    })
    runBoardRules(store, board.artifact.id)

    const composed = compose(pier, 'world-rules')
    recordTextCheck(store, composed, readTextCheckReply(theSceneFourReply(), composed))

    // Two findings at ONE anchor, from two tiers — 4.5's clustering, not a duplicate. The
    // board's says the rows prove it and quotes the scene heading; this one quotes a line of
    // the script and names the exception it looked for and did not find.
    const atSceneFour = findingsIn(store, pier.script.id, { sceneId: scenes[3]!.id })
    expect(atSceneFour.map((finding) => finding.tier).sort()).toEqual(['deterministic', 'text'])
    expect(atSceneFour.map((finding) => finding.checkKey).sort()).toEqual([
      'vacuum-without-protection',
      'world-rules',
    ])

    const semantic = atSceneFour.find((finding) => finding.tier === 'text')!
    expect(semantic.concern).toContain('sealed hardsuit')
    expect(semantic.concern).toContain('containment field')
    // And the two carry different confidences on purpose: `certain` is what a count of rows
    // earns, and a reading never gets it however sure it sounds (4.2, invariant 4).
    expect(atSceneFour.map((finding) => finding.confidence).sort()).toEqual(['certain', 'high'])
  })
})

// ── The controls: rules the script obeys, and the record that says so ───────────

describe('the cried-wolf controls, measured', () => {
  it('records rules 2 and 3 as loaded and un-cited — a silence with something behind it', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    const pass = recordTextCheck(store, composed, readTextCheckReply(theSceneFourReply(), composed))

    const sound = factOf('The hull and the void', 'Sound does not carry')
    const idiom = factOf('The hull and the void', 'harbour language is idiom')
    const loaded = scopeOfPass(store, pass.id).map((one) => one.fact.id)
    const cited = findingsOfPass(store, pass.id).flatMap((f) => f.facts.map((fact) => fact.id))

    // Both rules were in front of the check when it ran — that is the denominator, and
    // without it "said nothing about rule 2" is indistinguishable from "never saw rule 2".
    expect(loaded).toContain(sound)
    expect(loaded).toContain(idiom)
    expect(cited).not.toContain(sound)
    expect(cited).not.toContain(idiom)
    expect(composed.prompt).toContain('Sound does not carry outside the hull.')
    expect(composed.prompt).toContain('The harbour language is idiom, not physics.')
  })

  it('records a pass at zero findings for every category the script obeys', () => {
    const pier = theLongPier()
    const clean = '{"findings": []}'

    for (const key of ['character', 'location', 'species', 'technology']) {
      const composed = compose(pier, key)
      recordTextCheck(store, composed, readTextCheckReply(clean, composed))
    }
    const world = compose(pier, 'world-rules')
    recordTextCheck(store, world, readTextCheckReply(theSceneFourReply(), world))

    expect(
      checkPassesOf(store, pier.script.id).map((pass) => [pass.checkKey, pass.findingCount]),
    ).toEqual([
      ['character', 0],
      ['location', 0],
      ['species', 0],
      ['technology', 0],
      ['world-rules', 1],
    ])
  })

  it('raises a finding for a second category through the same unmodified code path', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'character')

    // Its instructions, its subject, its facts — and not one line of the checker changed.
    // The `character` category's own facts are what this one argues with, which is the whole
    // of "adding a category is an edit, not engineering" (3.2).
    const reply = JSON.stringify({
      findings: [
        {
          scene: 2,
          quote: 'Ilse cuts the tag off with a thumbnail',
          concern:
            'Canon says Ilse has never filed a diversion against the spares ledger though ' +
            'the spares have moved. This scene shows the moving; nothing shows the not-filing.',
          severity: 'low',
          confidence: 'medium',
          entity: 'the harbourmaster',
          facts: [factOf('Ilse Renn', 'never filed a diversion')],
        },
      ],
    })

    const pass = recordTextCheck(store, composed, readTextCheckReply(reply, composed))
    const [finding] = findingsOfPass(store, pass.id)

    expect(pass).toMatchObject({ checkKey: 'character', tier: 'text', findingCount: 1 })
    // Named by an alias off her sheet and resolved to the identity — the entity list the
    // prompt carried is the one the reply is held to.
    expect(finding!.entityId).toEqual(pier.harbor.entity('Ilse Renn').id)
    expect(finding!.facts[0]!.statement).toContain('never filed a diversion')
    expect(finding!.severity).toEqual('low')
  })

  it('fires on a rule the script does not obey — so the silence above is a measurement', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    // The same checker, unmodified, handed a reply that argues with rule 2. Nothing about
    // the check makes rules 2 and 3 unfireable; the script is what makes them silent.
    const reply = JSON.stringify({
      findings: [
        {
          scene: 4,
          quote: 'He keys it twice — two clicks, the answer he always gives',
          concern: 'Sound does not carry outside the hull; this reads as heard rather than sent.',
          severity: 'high',
          confidence: 'medium',
          facts: [factOf('The hull and the void', 'Sound does not carry')],
        },
      ],
    })

    const pass = recordTextCheck(store, composed, readTextCheckReply(reply, composed))
    expect(pass.findingCount).toEqual(1)
    expect(findingsOfPass(store, pass.id)[0]!.facts[0]!.statement).toContain('Sound does not carry')
  })
})

// ── Nothing trusts the model ───────────────────────────────────────────────────

describe('a finding cites only what exists', () => {
  it('refuses a span that is not in the artifact', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            {
              quote: 'Tobin pulls his helmet seal down and checks the gauge',
              concern: 'a span nobody wrote',
              severity: 'high',
              confidence: 'high',
            },
          ],
        }),
        composed,
      ),
    ).toThrow(/is not in the script/)
  })

  it('refuses a span that is in the artifact but not in the scene it names', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            {
              scene: 4,
              quote: 'The mess deck is warm, which on Grey Harbor is a complaint.',
              concern: 'a real span, in the wrong scene',
              severity: 'high',
              confidence: 'high',
            },
          ],
        }),
        composed,
      ),
    ).toThrow(/scene 4/)
  })

  it('refuses a fact id that is not in scope', () => {
    const pier = theLongPier()
    promoteSefa(pier.harbor)
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            {
              scene: 4,
              quote: 'Three minutes of it, start to finish.',
              concern: 'quoting canon this check was never handed',
              severity: 'high',
              confidence: 'high',
              facts: [factOf('Sefa Doule', 'line office')],
            },
          ],
        }),
        composed,
      ),
    ).toThrow(/not one of the facts this check was handed/)
  })

  it('refuses an entity that is not in the artifact’s provenance', () => {
    const pier = theLongPier()
    promoteSefa(pier.harbor)
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            {
              scene: 4,
              quote: 'Three minutes of it, start to finish.',
              concern: 'about somebody who is not in this script',
              severity: 'high',
              confidence: 'high',
              entity: 'Sefa Doule',
            },
          ],
        }),
        composed,
      ),
    ).toThrow(/is not one of the entities this script declares/)
  })

  it('refuses a scene the episode does not have', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            { scene: 9, concern: 'somewhere else entirely', severity: 'low', confidence: 'low' },
          ],
        }),
        composed,
      ),
    ).toThrow(/has no scene 9/)
  })

  it('refuses `certain` — the deterministic tier’s word, not a reading’s', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(() =>
      readTextCheckReply(
        JSON.stringify({
          findings: [
            {
              scene: 4,
              quote: 'Three minutes of it, start to finish.',
              concern: 'sure of itself',
              severity: 'high',
              confidence: 'certain',
            },
          ],
        }),
        composed,
      ),
    ).toThrow(/certain/)
  })

  it('refuses a reply that is not findings at all, rather than reading it as none', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(() => readTextCheckReply('Certainly! The script looks great to me.', composed)).toThrow(
      /did not come back as a check/,
    )
    expect(() => readTextCheckReply('{"verdict": "fine"}', composed)).toThrow(
      /did not come back as a check/,
    )
    expect(() => readTextCheckReply('{"findings": [{"severity": "high"}]}', composed)).toThrow(
      /concern/,
    )
  })

  it('reads a fenced answer, because models fence things', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    expect(readTextCheckReply('```json\n{"findings": []}\n```', composed)).toEqual([])
  })
})

// ── The third kind of nothing ──────────────────────────────────────────────────

describe('the honest gap: could not check', () => {
  it('records "species undecided" as its own row, distinct from a clean pass', () => {
    const pier = theLongPier()
    const sefa = promoteSefa(pier.harbor)
    // She is written into this script now, so the check is handed her — and handed a hole.
    declareProvenance(store, pier.script.id, [sefa])
    const composed = compose(pier, 'world-rules')

    const pass = recordTextCheck(store, composed, readTextCheckReply('{"findings": []}', composed))

    expect([pass.findingCount, pass.gapCount]).toEqual([0, 1])
    expect(gapsOfPass(store, pass.id)).toEqual([
      {
        id: expect.stringMatching(/^gap_/),
        passId: pass.id,
        checkKey: 'world-rules',
        entityId: sefa,
        reason: 'declared-unknown',
        via: 'species',
        detail: expect.stringContaining('species undecided'),
      },
    ])
    // And it is in the prompt too, so the model is told where its scope has a hole rather
    // than being left to fill it in.
    expect(composed.prompt).toContain('species undecided')
  })

  it('says nothing of the sort about an entity whose scope is whole', () => {
    const pier = theLongPier()
    const composed = compose(pier, 'world-rules')

    const pass = recordTextCheck(store, composed, readTextCheckReply('{"findings": []}', composed))

    // Tobin and Ilse both declare Halvani, and Halvani carries facts. Nothing is missing, so
    // nothing is reported missing — a gap raised where there is none is its own cried wolf.
    expect(pass.gapCount).toEqual(0)
    expect(gapsAbout(store, pier.harbor.entity('Tobin Wick').id)).toEqual([])
  })

  it('is raised by every check that was handed the hole, and says which', () => {
    const pier = theLongPier()
    const sefa = promoteSefa(pier.harbor)
    declareProvenance(store, pier.script.id, [sefa])

    for (const key of ['character', 'world-rules']) {
      const composed = compose(pier, key)
      recordTextCheck(store, composed, readTextCheckReply('{"findings": []}', composed))
    }

    expect(gapsAbout(store, sefa).map((gap) => gap.checkKey)).toEqual(['character', 'world-rules'])
  })
})

// ── Waypoint drift rides the same shape (D8) ───────────────────────────────────

describe('the waypoint-drift check', () => {
  it('composes from the arc’s statement and its waypoint descriptions, not from facts', () => {
    const pier = theLongPier()

    const [check] = waypointChecksFor(store, pier.script)
    const composed = composeTextCheck(store, {
      artifact: pier.script,
      text: pier.text,
      subject: check!,
    })

    expect(check!.key).toEqual('waypoint-drift')
    expect(check!.label).toContain('What the harbor is for')
    expect(check!.label).toContain('waypoint 2')
    // The declared position, what it means, and what landing it looks like — plus the
    // waypoints on either side, which is what "ahead of or behind" is measured against.
    expect(composed.prompt).toContain('Ilse spends something real to keep the harbour working')
    expect(composed.prompt).toContain('Ilse treats the silence in the lane as a scheduling problem')
    expect(composed.prompt).toContain('The harbor is hers')
    expect(composed.prompt).toContain('carried by what she spends, not by what she argues')
    // The canon in scope still loads — an arc is about what somebody DOES, and who they are
    // is in their facts. What an arc check has is no SUBJECT in canon: there is no fact for
    // "arc1 reached waypoint2" until a landing proposal is ratified (D8), so nothing here
    // is the thing being checked and a finding names no entity.
    expect(check!.subjectEntityIds).toEqual([])
    expect(composed.scope.length).toBeGreaterThan(0)
  })

  it('fires on behaviour ahead of the declared waypoint', () => {
    const pier = theLongPier()
    const [check] = waypointChecksFor(store, pier.script)
    const composed = composeTextCheck(store, { artifact: pier.script, text: pier.text, subject: check! })

    // Synthetic, and deliberately so: the fixture script conforms to waypoint 2, and planting
    // drift in it would cost the conformity test below its meaning.
    const reply = JSON.stringify({
      findings: [
        {
          scene: 5,
          quote: "Then they'll tell me.",
          concern:
            'Ilse justifies the diversion out loud, which is waypoint 3’s landing, not ' +
            'waypoint 2’s — waypoint 2 answers a challenge with the schedule and does not ' +
            'account for the cost.',
          severity: 'medium',
          confidence: 'medium',
        },
      ],
    })

    const pass = recordTextCheck(store, composed, readTextCheckReply(reply, composed))
    expect(pass).toMatchObject({ checkKey: 'waypoint-drift', tier: 'text', findingCount: 1 })
    expect(findingsOfPass(store, pass.id)[0]!.entityId).toBeNull()
  })

  it('is silent on the script that conforms, with the pass recorded', () => {
    const pier = theLongPier()
    const [check] = waypointChecksFor(store, pier.script)
    const composed = composeTextCheck(store, { artifact: pier.script, text: pier.text, subject: check! })

    const pass = recordTextCheck(store, composed, readTextCheckReply('{"findings": []}', composed))

    expect([pass.findingCount, pass.gapCount]).toEqual([0, 0])
    expect(checkPassesOf(store, pier.script.id).map((p) => p.checkKey)).toEqual(['waypoint-drift'])
  })

  it('convenes nothing for a vanilla episode — legal, tracked, never a failure state', () => {
    theLongPier()
    const dryStores = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'Dry Stores'")!.id
    expect(positionsOf(store, dryStores)).toEqual([])
  })
})
