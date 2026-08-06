import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { ARTIFACT_KIND } from '../domain/artifact.ts'
import { ENTITY_STANDING, ENTITY_STATUS, entitiesOfShow } from '../domain/canon.ts'
import { RELATION_CARDINALITY } from '../domain/category.ts'
import { factsInScope } from '../domain/fact.ts'
import { foundCanon } from '../domain/founding.ts'
import { openProposals } from '../domain/proposal.ts'
import { UNKNOWN_TARGET } from '../domain/relation.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { loadFixture } from './load.ts'
import { readFixture } from './read.ts'

/**
 * `docs/canon-schema.md` — the versioned schema document, held to the code it documents.
 *
 * The document is the product deliverable behind 3.5's empty-show story: a new showrunner
 * hands it to a Claude session along with source material and gets canon sheets back. Its
 * readers will never open `read.ts`, which is exactly why it needs a test — a schema
 * document that has drifted from its parser is worse than none, because it fails in the one
 * place nobody is watching: somebody else's show, at load time, in prose that reads
 * authoritative.
 *
 * Four things are pinned, and each closes a different way it could quietly go wrong.
 *
 * **The examples are the files.** Every sheet the document shows is quoted from
 * `docs/canon-schema-example/` and asserted byte for byte. Including by reference instead
 * would have made this test unnecessary, and was rejected: the document is handed to a
 * session that has the DOCUMENT and nothing else — no repository, no fixture, no code — so
 * an example it merely points at is an example that reader cannot see. Inlining is therefore
 * required, and this test is the price of it. The set of quoted paths must equal the set of
 * files in the tree, in both directions: an example nobody quotes rots, and a quote with no
 * file behind it is a sheet nobody ever parsed.
 *
 * **The pack the document teaches actually founds.** It round-trips through `read.ts` with
 * the values the document claims, and then goes through the real flow — `loadFixture` raises,
 * `foundCanon` rules — because the document's central claim is about what happens to a pack,
 * not about what parses. If founding a documented pack ever needs a step the document does
 * not mention, this is what notices.
 *
 * **The vocabularies match the app's own.** They are listed in the document as a table a
 * pack author reads; they exist in the domain as the arrays `read.ts` refuses against.
 * Adding a standing or an artifact kind in code fails here, which is the point — the failure
 * is a prompt to edit the document, where the version number lives.
 *
 * **The version is stated, and it is stated once.** See the bump checklist below.
 */

const ROOT = join(import.meta.dirname, '../../..')
const DOC = join(ROOT, 'docs/canon-schema.md')
const EXAMPLE_DIR = join(ROOT, 'docs/canon-schema-example')

/**
 * The version of the pack format `docs/canon-schema.md` describes.
 *
 * **Raise it when a pack written against the old version would no longer read the same
 * way**: a newly required section, a changed separator, a value removed from a vocabulary,
 * an optional part of the relation-type grammar becoming mandatory. Do NOT raise it for a
 * clarification, a better example, or a value ADDED to a vocabulary — an old pack that does
 * not use the new value is unaffected.
 *
 * Raising it means editing three things together: this constant, every `canon schema
 * version N` in the document, and §10's account of what changed. That the three cannot move
 * apart is the whole reason the number is duplicated here at all.
 */
const SCHEMA_VERSION = 1

const doc = (): string => readFileSync(DOC, 'utf8')

/** `<!-- example: canon/character/_category.md -->` and the fenced block under it. */
function quotedExamples(source: string): Map<string, string> {
  const quoted = new Map<string, string>()
  const marker = /<!-- example: (.+?) -->\n```markdown\n([\s\S]*?)```\n/g

  for (const [, path, body] of source.matchAll(marker)) {
    if (quoted.has(path!)) throw new Error(`${path} is quoted twice in the document`)
    quoted.set(path!, body!)
  }
  return quoted
}

/**
 * Every file in the example tree, by its path relative to the tree's root. Dotfiles are
 * skipped for the reason `read.ts` skips them: a `.DS_Store` Finder left in a canon
 * directory is not a sheet, and the reader would not read it either.
 */
function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path))
    else found.push(relative(EXAMPLE_DIR, path))
  }
  return found.sort()
}

describe('docs/canon-schema.md — the examples are the files', () => {
  it('quotes every sheet in the example pack, and quotes nothing else', () => {
    expect([...quotedExamples(doc()).keys()].sort()).toEqual(filesUnder(EXAMPLE_DIR))
  })

  it('quotes each one byte for byte', () => {
    for (const [path, body] of quotedExamples(doc())) {
      expect(body, `${path} has drifted from the block quoted in the document`).toBe(
        readFileSync(join(EXAMPLE_DIR, path), 'utf8'),
      )
    }
  })
})

describe('docs/canon-schema.md — the example pack round-trips through read.ts', () => {
  it('is the show, the seasons and the categories the document describes', () => {
    const pack = readFixture(EXAMPLE_DIR)

    expect(pack.key).toBe('saltmarch')
    expect(pack.title).toBe('Salt March')
    expect(pack.seasons).toEqual([{ number: 1, title: 'The Spring Walk' }])
    expect(pack.categories.map((category) => category.key)).toEqual(['character', 'species'])
    // A founding pack is canon only — the spine is not something a drafting session invents.
    expect(pack.arcs).toEqual([])
    expect(pack.episodes).toEqual([])
  })

  /**
   * §4.3's grammar, read back off the sheet: the target, the cardinality, the inverse, and
   * `inherits facts` — which is the part a hand-written parser drops silently, and the part
   * that decides whether a species' facts ever reach a check (D22).
   */
  it('reads the relation-type declarations whole, `inherits facts` included', () => {
    const character = readFixture(EXAMPLE_DIR).categories.find((c) => c.key === 'character')!

    expect(character.relationTypes).toEqual([
      {
        name: 'species',
        targetCategory: 'species',
        cardinality: 'exactly-one',
        required: true,
        inverse: 'members',
        inheritsFacts: true,
      },
      {
        name: 'walks-with',
        targetCategory: 'character',
        cardinality: 'any',
        required: false,
        inverse: 'walked-with',
        // Left off the sheet, which means no — §4.3, and the default the document states.
        inheritsFacts: false,
      },
    ])
    // A leaf category declaring no edges at all is legal, and the document shows one.
    expect(readFixture(EXAMPLE_DIR).categories.find((c) => c.key === 'species')!.relationTypes)
      .toEqual([])
  })

  it('reads the three entity sheets, with the candidate declaring `unknown` (D22)', () => {
    const pack = readFixture(EXAMPLE_DIR)
    const entity = (name: string) => pack.entities.find((e) => e.name === name)!

    expect(entity('Ottilie Bray')).toMatchObject({
      categoryKey: 'character',
      standing: 'core',
      status: 'active',
      aliases: ['Til'],
      relations: [{ type: 'species', target: 'Fennlander' }],
    })
    expect(entity('Corin Vale')).toMatchObject({
      standing: 'recurring',
      status: 'candidate',
      relations: [
        { type: 'species', target: UNKNOWN_TARGET },
        { type: 'walks-with', target: 'Ottilie Bray' },
      ],
    })
    // §5.5: a sheet with nothing checkable on it checks nothing, so every sheet carries facts.
    for (const sheet of pack.entities) expect(sheet.facts.length).toBeGreaterThan(0)
  })
})

/**
 * The claims the document makes about what is refused and what is merely ignored.
 *
 * Every one of these is here because the E2-5 empty-show check surfaced it: a session given
 * the document and nothing else drafted a valid pack, and then reported six places where it
 * had to GUESS. A guess that happens to be right is a bug with a delay on it — the next show
 * guesses the other way — so each answer went into the document and each one is pinned here.
 * The document says the reader behaves this way; this is what keeps that true.
 */
describe('docs/canon-schema.md — the refusals and permissions the document promises', () => {
  let copies: string[]

  beforeEach(() => {
    copies = []
  })

  afterEach(() => {
    for (const copy of copies) rmSync(copy, { recursive: true, force: true })
  })

  /** Reads a throwaway copy of the example pack with one edit applied, the way read.test.ts does. */
  function afterEditing(file: string, from: string, to: string): () => unknown {
    const copy = mkdtempSync(join(tmpdir(), 'schema-doc-probe-'))
    copies.push(copy)
    cpSync(EXAMPLE_DIR, copy, { recursive: true })

    const path = join(copy, file)
    const before = readFileSync(path, 'utf8')
    if (!before.includes(from)) throw new Error(`${file} no longer contains: ${from}`)
    writeFileSync(path, before.replace(from, to), 'utf8')
    return () => readFixture(copy)
  }

  // §5.7 and §7.2. The sheet is held to the format whatever its status says; what `candidate`
  // buys is that nothing is proposed, not that less has to be written.
  it('refuses a required relation left off a CANDIDATE sheet, not only an active one', () => {
    expect(afterEditing('canon/character/corin-vale.md', '- species: unknown\n', '')).toThrow(
      /declares no `species`.*requires exactly one/s,
    )
  })

  // §5.2. Names are how sheets point at each other, so a near miss is a refusal, not a guess.
  it('refuses a relation target that differs only in case', () => {
    expect(
      afterEditing('canon/character/ottilie-bray.md', '- species: Fennlander', '- species: fennlander'),
    ).toThrow(/points at “fennlander”, which is not an entity in this show/)
  })

  // §5.3. `unknown` is an answer, and an optional edge has three answers too.
  it('accepts `unknown` on an OPTIONAL relation type, not only a required one', () => {
    const pack = afterEditing(
      'canon/character/corin-vale.md',
      '- walks-with: Ottilie Bray',
      '- walks-with: unknown',
    )() as ReturnType<typeof readFixture>

    expect(pack.entities.find((e) => e.name === 'Corin Vale')!.relations).toEqual([
      { type: 'species', target: UNKNOWN_TARGET },
      { type: 'walks-with', target: UNKNOWN_TARGET },
    ])
  })

  // §5.1 and §4.2: `## Fields` is documentation, and Identity's three keys are the read ones.
  it('ignores an unrecognised key in `## Identity` rather than refusing it', () => {
    const pack = afterEditing(
      'canon/character/ottilie-bray.md',
      '- aliases: Til',
      '- aliases: Til\n- age: 41',
    )() as ReturnType<typeof readFixture>

    expect(pack.entities.find((e) => e.name === 'Ottilie Bray')).toMatchObject({
      standing: 'core',
      status: 'active',
      aliases: ['Til'],
    })
  })

  // §2: a sheet is a place to write things down, not a form.
  it('ignores a section it does not need, on an entity sheet and on a category sheet', () => {
    expect(
      afterEditing('canon/character/ottilie-bray.md', '## Body', '## Wardrobe\n\nOilskin.\n\n## Body'),
    ).not.toThrow()
    expect(
      afterEditing(
        'canon/character/_category.md',
        '## Check instructions',
        '## Notes\n\nMine.\n\n## Check instructions',
      ),
    ).not.toThrow()
  })

  // §2 and §5.5: which side of the field/statement line a bullet falls on is the section's
  // business. In `## Facts` a colon is part of the sentence — ugly, and read whole.
  it('keeps a `: ` inside a `## Facts` bullet as part of the statement', () => {
    const pack = afterEditing(
      'canon/species/fennlander.md',
      '- A Fennlander hears the turn',
      '- hearing: A Fennlander hears the turn',
    )() as ReturnType<typeof readFixture>

    expect(pack.entities.find((e) => e.name === 'Fennlander')!.facts[0]).toMatch(
      /^hearing: A Fennlander hears the turn/,
    )
  })
})

describe('docs/canon-schema.md — the example pack loads and founds', () => {
  let root: string
  let paths: LibraryPaths
  let store: Store

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'showrunner-schema-doc-'))
    paths = initLibrary(root)
    store = openLibraryStore(paths)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * §7 end to end, which is the claim the document is actually making: loading raises,
   * founding rules, and a candidate sheet is left alone by both.
   */
  it('raises a promotion per active sheet and rules them through the one ruling API', () => {
    const load = loadFixture(store, paths, EXAMPLE_DIR)

    expect(load.candidates).toEqual(['Corin Vale'])
    expect(load.promotions).toEqual({ created: 2, found: 0 })
    expect(openProposals(store, load.show.id)).toHaveLength(2)

    const founding = foundCanon(store, load.show.id)

    expect(founding.founded).toHaveLength(2)
    expect(founding.left).toEqual([])
    expect(
      entitiesOfShow(store, load.show.id).map((e) => `${e.name}: ${e.status}`),
    ).toEqual(['Corin Vale: candidate', 'Ottilie Bray: active', 'Fennlander: active'])
  })

  /**
   * §8.3, which is why `inherits facts: yes` is on the character category's `species` line
   * and not in anybody's code: the species' physiology reaches the character that declared
   * it, without being copied onto her sheet.
   */
  it('loads the species facts into the character check scope (D22)', () => {
    const load = loadFixture(store, paths, EXAMPLE_DIR)
    foundCanon(store, load.show.id)

    const ottilie = entitiesOfShow(store, load.show.id).find((e) => e.name === 'Ottilie Bray')!
    const scope = factsInScope(store, ottilie.id)

    expect(scope.own).toHaveLength(3)
    expect(scope.inheritance.map((edge) => [edge.type.name, edge.case, edge.source?.name])).toEqual(
      [['species', 'inherited', 'Fennlander']],
    )
    expect(scope.inScope).toHaveLength(6)
  })
})

describe('docs/canon-schema.md — version 1', () => {
  it('states its version, states it consistently, and states the one this test pins', () => {
    const stated = [...doc().matchAll(/canon schema version (\d+)/gi)].map(([, n]) => Number(n))

    expect(stated.length).toBeGreaterThan(0)
    expect([...new Set(stated)]).toEqual([SCHEMA_VERSION])
  })

  /**
   * The vocabularies the document publishes, against the arrays `read.ts` refuses with. A
   * value added in code and not here is a document that has quietly gone stale; a value here
   * and not in code is a document promising something the loader will refuse.
   */
  it('publishes the vocabularies the app actually enforces', () => {
    const known: Record<string, readonly string[]> = {
      standing: ENTITY_STANDING,
      status: ENTITY_STATUS,
      cardinality: RELATION_CARDINALITY,
      'declared-unknown target': [UNKNOWN_TARGET],
      'applies to': ARTIFACT_KIND,
    }

    const block = /<!-- vocabulary -->\n```\n([\s\S]*?)```\n/.exec(doc())
    expect(block, 'the document has no vocabulary block').not.toBeNull()

    const published = block![1]!
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const at = line.indexOf(': ')
        return [line.slice(0, at), line.slice(at + 2).split(' / ')] as const
      })

    expect(published.map(([key]) => key).sort()).toEqual(Object.keys(known).sort())
    for (const [key, values] of published) expect(values, key).toEqual(known[key])
  })
})
