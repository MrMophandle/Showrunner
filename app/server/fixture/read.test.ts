import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_DIR, readFixture } from './read.ts'

/**
 * What the Grey Harbor fixture must CONTAIN, asserted against the real files rather
 * than against a sample built here. The fixture is the worked example a new showrunner
 * copies (3.5) and the show every later epic's tests are written against, so a shape
 * that goes missing from it gets copied rather than corrected. These tests are the
 * thing that notices.
 *
 * The validation tests edit a throwaway copy of the real directory. Breaking the real
 * shapes one at a time is the only honest way to show the loader would refuse them.
 */

let copies: string[]

beforeEach(() => {
  copies = []
})

afterEach(() => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true })
})

/** Rewrites the first occurrence of `from` in a throwaway copy, then reads it back. */
function afterEditing(file: string, from: string, to: string): () => unknown {
  const copy = mkdtempSync(join(tmpdir(), 'greyharbor-'))
  copies.push(copy)
  cpSync(FIXTURE_DIR, copy, { recursive: true })

  const path = join(copy, file)
  const before = readFileSync(path, 'utf8')
  if (!before.includes(from)) throw new Error(`${file} no longer contains: ${from}`)
  writeFileSync(path, before.replace(from, to), 'utf8')
  return () => readFixture(copy)
}

describe('the Grey Harbor fixture — the show', () => {
  it('is one show, one season, and two episodes: one mid-script, one un-started', () => {
    const show = readFixture()

    expect(show.key).toBe('greyharbor')
    expect(show.seasons).toEqual([{ number: 1, title: 'Slack Water' }])
    expect(show.episodes.map((e) => [e.number, e.title, e.lifecycle])).toEqual([
      [1, 'The Long Pier', 'script'],
      [2, 'Dry Stores', 'premise'],
    ])
  })

  it('has six entities across five categories', () => {
    const show = readFixture()

    expect(show.entities.map((e) => `${e.categoryKey}/${e.name}`)).toEqual([
      'character/Ilse Renn',
      'character/Tobin Wick',
      'location/Grey Harbor Station',
      'species/Halvani',
      'technology/Kestrel-pattern containment collar',
      'world-rules/The hull and the void',
    ])
  })
})

describe('the Grey Harbor fixture — the shapes that must be complete', () => {
  it('every character declares a species, and it resolves to the species entity (D22)', () => {
    const show = readFixture()
    const characters = show.entities.filter((e) => e.categoryKey === 'character')

    expect(characters).toHaveLength(2)
    for (const character of characters) {
      const declared = character.relations.filter((r) => r.type === 'species')
      expect(declared).toHaveLength(1)
      const species = show.entities.find((e) => e.name === declared[0]!.target)
      expect(species?.categoryKey).toBe('species')
    }
  })

  it('every category declares the fields its sheets carry (3.2)', () => {
    const character = readFixture().categories.find((c) => c.key === 'character')!

    expect(character.fields.map((f) => f.name)).toEqual(['standing', 'status', 'aliases'])
    expect(character.fields[0]!.description).toMatch(/core \/ recurring \/ one-shot \/ retired/)
    expect(character.fields[2]!.description).toBe(
      'what else the scripts call them, comma separated.',
    )
  })

  it('every category declares its relation types with target, cardinality and inverse (D23)', () => {
    const show = readFixture()

    expect(show.categories.map((c) => c.key)).toEqual([
      'character',
      'location',
      'species',
      'technology',
      'world-rules',
    ])
    for (const category of show.categories) {
      expect(category.relationTypes.length).toBeGreaterThan(0)
      for (const type of category.relationTypes) {
        expect(type.name).not.toBe('')
        expect(type.inverse).not.toBe('')
        expect(show.categories.map((c) => c.key)).toContain(type.targetCategory)
      }
    }

    // D22's species declaration is the first of them, it is the required one, and it is the
    // only one facts travel (E2-1) — the sheet is where that is said, not the code.
    const character = show.categories.find((c) => c.key === 'character')!
    expect(character.relationTypes.find((t) => t.name === 'species')).toEqual({
      name: 'species',
      targetCategory: 'species',
      cardinality: 'exactly-one',
      required: true,
      inverse: 'members',
      inheritsFacts: true,
    })
    expect(
      character.relationTypes.filter((t) => t.inheritsFacts).map((t) => t.name),
    ).toEqual(['species'])
  })

  it('refuses a third answer to `inherits facts`, because a typo would mean “no”', () => {
    expect(
      afterEditing(
        'canon/character/_category.md',
        '· inherits facts: yes',
        '· inherits facts: sometimes',
      ),
    ).toThrow(/inherits facts: sometimes/)
  })

  it('the arc carries a statement, and every waypoint what it means and what landing looks like (D24)', () => {
    const arc = readFixture().arcs[0]!

    expect(readFixture().arcs).toHaveLength(1)
    expect(arc.name).toBe('What the harbor is for')
    expect(arc.scope).toBe('season')
    expect(arc.kind).toBe('character')
    expect(arc.statement).toMatch(/asks/)
    expect(arc.waypoints.map((w) => w.ordinal)).toEqual([1, 2, 3])
    for (const waypoint of arc.waypoints) {
      expect(waypoint.description.length).toBeGreaterThan(40)
      expect(waypoint.landingCriteria.length).toBeGreaterThan(40)
    }
  })

  it('the mid-script episode declares a position on the arc; the un-started one is vanilla', () => {
    const [first, second] = readFixture().episodes

    expect(first!.positions).toEqual([{ arcName: 'What the harbor is for', waypointOrdinal: 2 }])
    expect(second!.positions).toEqual([])
    expect(second!.artifacts).toEqual([])
  })

  it('derives the scenes from the script, in order — the count is never declared', () => {
    const [first, second] = readFixture().episodes

    expect(first!.scenes.map((s) => s.heading)).toEqual([
      'INT. GREY HARBOR STATION — MESS DECK — 06:10',
      "INT. HARBOURMASTER'S OFFICE — 06:40",
      'INT. NO. 4 LOCK — 07:05',
      'EXT. THE LONG PIER — 07:07',
      "INT. HARBOURMASTER'S OFFICE — 07:20",
      'EXT. THE LONG PIER — CONTINUOUS',
    ])
    // Exactly one CONTINUOUS in the script: the planted dual presence, and nothing
    // innocent sharing a clock with anything for the board to trip over.
    expect(first!.scenes.filter((s) => s.heading.endsWith('CONTINUOUS'))).toHaveLength(1)
    expect(first!.scenes.every((s) => s.summary !== '')).toBe(true)
    expect(second!.scenes).toEqual([])
  })

  it('declares provenance and freshness edges on the mid-script episode (invariant 2)', () => {
    const artifacts = readFixture().episodes[0]!.artifacts

    expect(artifacts.map((a) => [a.kind, a.builtFrom])).toEqual([
      ['premise-brief', []],
      ['outline', ['premise-brief']],
      ['script', ['outline']],
    ])
    expect(artifacts.find((a) => a.kind === 'script')!.touches).toHaveLength(6)
  })
})

describe('the Grey Harbor fixture — the planted violations have something to violate', () => {
  it('a world rule forbids it, a location puts the scene outside, and a species fact makes it fatal', () => {
    const show = readFixture()
    const factsOf = (name: string) => show.entities.find((e) => e.name === name)!.facts.join('\n')

    // The rule. Without this, scene 4 is merely unusual.
    expect(factsOf('The hull and the void')).toMatch(
      /outside the pressure hull is in vacuum unless a sealed hardsuit or an active containment field/i,
    )
    // What makes the rule reach the Long Pier.
    expect(factsOf('Grey Harbor Station')).toMatch(/Long Pier is outside the pressure hull/i)
    // What makes it land on a body — in scope only because Tobin declares this species.
    expect(factsOf('Halvani')).toMatch(/unprotected vacuum.*dies inside two minutes/is)
    // And the exception the check must look for and fail to find.
    expect(factsOf('Kestrel-pattern containment collar')).toMatch(
      /a collar on the rack is a collar nobody is wearing/i,
    )
  })

  it('the script plants both defects and says nothing about either inside itself', () => {
    const script = readFileSync(
      join(FIXTURE_DIR, 'episode/01-the-long-pier/script.md'),
      'utf8',
    )

    // World rules, scene 4: outside, in coveralls, with every collar still on the rack.
    expect(script).toMatch(/four Kestrel collars hang closed on their pegs/)
    expect(script).toMatch(/comes out onto the pier in his coveralls/)
    // Continuity, scenes 5 and 6: Ilse in the office, and on the pier, on one clock.
    expect(script).toMatch(/## 5 · INT\. HARBOURMASTER'S OFFICE — 07:20/)
    expect(script).toMatch(/## 6 · EXT\. THE LONG PIER — CONTINUOUS/)
    // A check reads this file. It must not be told what it is looking for.
    expect(script).not.toMatch(/planted|deliberate|fixture|world rules|continuity board/i)
  })
})

describe('the Grey Harbor fixture — what the reader refuses', () => {
  it('a character with no species (D22)', () => {
    expect(afterEditing('canon/character/tobin-wick.md', '- species: Halvani\n', '')).toThrow(
      /tobin-wick\.md: declares no `species`.*requires exactly one/i,
    )
  })

  it('a category that stopped declaring the fields its sheets carry (3.2)', () => {
    expect(
      afterEditing('canon/character/_category.md', '## Fields', '## Fields (draft)'),
    ).toThrow(/_category\.md: has no `## Fields` section/)
  })

  it('a relation type the category never declared (D23)', () => {
    expect(
      afterEditing('canon/character/tobin-wick.md', '- carries:', '- keeps:'),
    ).toThrow(/tobin-wick\.md.*`keeps`.*not declared by the character category/i)
  })

  it('a relation pointing at nothing, while accepting an explicit `unknown` species', () => {
    expect(
      afterEditing('canon/character/tobin-wick.md', '- species: Halvani', '- species: Vantid'),
    ).toThrow(/tobin-wick\.md.*“Vantid”, which is not an entity/)

    expect(
      afterEditing('canon/character/tobin-wick.md', '- species: Halvani', '- species: unknown'),
    ).not.toThrow()
  })

  it('a waypoint whose landing criteria went missing (D24)', () => {
    // The key is mistyped, which is how it actually goes missing — the prose is still
    // there, under a name nothing reads.
    expect(
      afterEditing('arc/what-the-harbor-is-for.md', '- landing criteria:', '- landing looks like:'),
    ).toThrow(/waypoint 1.*landing criteria/i)
  })

  it('an arc with no statement (D24)', () => {
    expect(
      afterEditing('arc/what-the-harbor-is-for.md', '## Statement', '## Statement (later)'),
    ).toThrow(/statement/i)
  })

  it('an artifact whose file is not there', () => {
    expect(
      afterEditing('episode/01-the-long-pier/episode.md', 'script: script.md', 'script: draft.md'),
    ).toThrow(/draft\.md/)
  })
})
