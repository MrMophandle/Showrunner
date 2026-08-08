import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, type Artifact } from './artifact.ts'
import { CRAFT_REVIEWER, craftChecksFor, MANDATORY_CRAFT } from './craft.ts'
import { checkPassesOf, findingsOfPass, scopeOfPass } from './finding.ts'
import { composeTextCheck, readTextCheckReply, recordTextCheck } from './text-check.ts'

/**
 * The craft reviewers (D13, 4.5): **the passes that read an artifact as craft rather than
 * against canon**, and the one of them that is equipment.
 *
 * What is proved here is the two properties the issue turns on. Story-craft is convened
 * without being asked for and there is no data that removes it — the test that would fail
 * the day somebody deletes it is the whole of what "mandatory equipment" can mean in code.
 * And a craft pass is handed NO canon, so the parser it already shares with the category
 * checks refuses a citation without anybody adding a flag that waives validation: the closed
 * set is empty, and every id is outside an empty set.
 */

let root: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let script: Artifact
let text: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-craft-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  const episodeId = store.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!
  text = readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const storyCraft = () => craftChecksFor('script').find((subject) => subject.key === MANDATORY_CRAFT)!

describe('story-craft is equipment, not a setting (D13)', () => {
  it('ships in the roster for every written artifact kind, and CI says so if it stops', () => {
    const mandated = CRAFT_REVIEWER.find((reviewer) => reviewer.key === MANDATORY_CRAFT)

    // The only enforcement a piece of equipment can have: deleting it fails the build.
    expect(mandated).toBeDefined()
    expect(mandated!.appliesTo).toEqual(expect.arrayContaining(['outline', 'script']))
  })

  it('is convened first, and its instructions are D13’s three questions', () => {
    const convened = craftChecksFor('script')

    expect(convened[0]!.key).toEqual(MANDATORY_CRAFT)
    expect(convened[0]!.instructions).toMatch(/story shape/i)
    expect(convened[0]!.instructions).toMatch(/trope/i)
    expect(convened[0]!.instructions).toMatch(/set up|setup/i)
  })

  it('is not a category, so no show can declare it away', () => {
    const declared = store.all<{ key: string }>(
      'SELECT key FROM canon_category WHERE show_id = ?',
      harbor.show.id,
    )

    // Not one row in the store carries a craft key. Convening reads the roster in code, and
    // there is no sheet to edit, no `applies to` to empty, and no row to delete.
    expect(declared.map((row) => row.key)).not.toContain(MANDATORY_CRAFT)
    expect(craftChecksFor('script').map((subject) => subject.key)).toContain(MANDATORY_CRAFT)
  })
})

describe('which craft reviewers a kind convenes is code, and that is the declared exception', () => {
  it('convenes all four on a script', () => {
    expect(craftChecksFor('script').map((subject) => subject.key)).toEqual([
      'story-craft',
      'pacing',
      'dialogue',
      'hook',
    ])
  })

  it('leaves the dialogue reviewer out of an outline, which has no dialogue in it', () => {
    expect(craftChecksFor('outline').map((subject) => subject.key)).toEqual([
      'story-craft',
      'pacing',
      'hook',
    ])
  })

  it('convenes nothing on an artifact nobody reads as prose', () => {
    expect(craftChecksFor('shot-image')).toEqual([])
    expect(craftChecksFor('continuity-board')).toEqual([])
  })
})

describe('a craft pass is handed no canon at all', () => {
  it('composes a prompt with no facts, no entities, and no scope to record', () => {
    const composed = composeTextCheck(store, { artifact: script, text, subject: storyCraft() })

    expect(composed.scope).toEqual([])
    expect(composed.gaps).toEqual([])
    // Invariant 2 the other way round: the canon this script declares it touches is real, and
    // a craft reviewer is not entitled to it. Asserted against the string that would go over
    // the wire, not against an intention.
    expect(composed.prompt).not.toContain('The canon this check is about')
    expect(composed.prompt).not.toContain('loses consciousness in about nine seconds')
    expect(composed.prompt).not.toContain('fact_')
    // And the prompt asks for exactly what will be accepted (text-check.ts's rule).
    expect(composed.prompt).toMatch(/cite no fact/i)
  })

  it('still carries the artifact and its scenes — a craft reviewer reads the material', () => {
    const composed = composeTextCheck(store, { artifact: script, text, subject: storyCraft() })

    expect(composed.prompt).toContain('Tobin comes out onto the pier in his coveralls')
    expect(composed.prompt).toContain('## The scenes, numbered')
  })
})

describe('two nothings, kept apart in the parser', () => {
  const craftFinding = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      findings: [
        {
          scene: 4,
          quote: 'Three minutes of it, start to finish.',
          concern:
            'The spacewalk is the episode’s only physical risk and it is narrated as a chore. ' +
            'Nothing is spent and nothing is nearly lost, so the pier costs the story nothing.',
          severity: 'medium',
          confidence: 'medium',
          ...extra,
        },
      ],
    })

  it('accepts a finding that cites nothing — legal by kind, not by waiver', () => {
    const composed = composeTextCheck(store, { artifact: script, text, subject: storyCraft() })

    const [finding] = readTextCheckReply(craftFinding(), composed)

    expect(finding).toMatchObject({ severity: 'medium', confidence: 'medium' })
    expect(finding!.factIds).toBeUndefined()
    expect(finding!.entityId).toBeUndefined()
    expect(finding!.anchor?.quote).toEqual('Three minutes of it, start to finish.')
  })

  it('refuses a citation from a craft reviewer, because it was handed nothing to cite', () => {
    const composed = composeTextCheck(store, { artifact: script, text, subject: storyCraft() })
    const real = store.get<{ id: string }>('SELECT id FROM fact LIMIT 1')!.id

    // Not an invented id — a REAL fact of this show, which this pass was never handed. The
    // refusal is the same closed-set check the category checks run, over an empty set.
    expect(() => readTextCheckReply(craftFinding({ facts: [real] }), composed)).toThrow(
      /not one of the facts this check was handed/,
    )
    expect(() => readTextCheckReply(craftFinding({ entity: 'Tobin Wick' }), composed)).toThrow(
      /not one of the entities this script declares/,
    )
  })

  it('records the pass with no scope behind it, and the finding with no entity on it', () => {
    const composed = composeTextCheck(store, { artifact: script, text, subject: storyCraft() })

    const pass = recordTextCheck(store, composed, readTextCheckReply(craftFinding(), composed))

    expect(pass).toMatchObject({ checkKey: MANDATORY_CRAFT, tier: 'text', findingCount: 1, gapCount: 0 })
    expect(scopeOfPass(store, pass.id)).toEqual([])
    expect(findingsOfPass(store, pass.id)[0]).toMatchObject({ entityId: null, facts: [] })
    expect(checkPassesOf(store, script.id).map((one) => one.checkKey)).toEqual([MANDATORY_CRAFT])
  })
})
