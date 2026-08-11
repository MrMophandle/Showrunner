import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glossary, markTerms, type GlossaryEntry } from './glossary.ts'

/**
 * The glossary, held to the register it exists to serve (#99).
 *
 * A definition is copy Ryan reads mid-operation, so it obeys the same rule every other
 * sentence in this cockpit now obeys: it names its subject, it says who acts, it finishes
 * its grammar, and it carries no citation, no pattern name and no ruling quoted at him.
 *
 * The assertions here are mechanical on purpose. "Written fresh, not lifted" is the kind of
 * claim that is true the day it is written and quietly false the next time somebody needs a
 * definition in a hurry and has `CLAUDE.md` open — so it is checked against the file rather
 * than promised in a comment.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const CLAUDE = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')

const TERMS = glossary()

/** The set #99 ruled, by name. Anything the sweep met since is extra, never instead. */
const RULED = [
  'gate',
  'finding',
  'proposal',
  'ruling',
  'ratify',
  'defer',
  'override',
  'arc',
  'waypoint',
  'pin',
  'landing',
  'provenance',
  'provisional',
  'riding',
  'candidate',
  'standing',
  'lifecycle',
  'scene',
  'continuity board',
  'deterministic',
  'severity',
  'confidence',
  'sweep',
  'vanilla',
  'stale',
  'fresh',
  'blast radius',
] as const

describe('the glossary covers the words Ryan was ruled to be owed', () => {
  it('defines every term #99 listed', () => {
    const defined = new Set(TERMS.map((entry) => entry.term))
    for (const term of RULED) {
      expect(defined.has(term), `${term} has no definition`).toBe(true)
    }
  })

  it('files each term once, under one headword', () => {
    const headwords = TERMS.map((entry) => entry.term)
    expect(new Set(headwords).size).toBe(headwords.length)
  })

  it('gives every term at least one spelling a sentence can be marked on', () => {
    for (const entry of TERMS) {
      expect(entry.marks.length, `${entry.term} can never be marked`).toBeGreaterThan(0)
      for (const mark of entry.marks) {
        expect(mark, `${entry.term} has a mark with capitals in it`).toBe(mark.toLowerCase())
        expect(mark.trim(), `${entry.term} has a blank mark`).not.toBe('')
      }
    }
  })

  it('never lets one spelling belong to two terms', () => {
    const owner = new Map<string, string>()
    for (const entry of TERMS) {
      for (const mark of entry.marks) {
        expect(owner.get(mark), `"${mark}" is claimed by two terms`).toBeUndefined()
        owner.set(mark, entry.term)
      }
    }
  })
})

describe('every definition is written in the operator register', () => {
  const complete = (entry: GlossaryEntry): string => entry.definition

  it('finishes its grammar — a capital, a full stop, and no dangling dash', () => {
    for (const entry of TERMS) {
      const definition = complete(entry)
      expect(definition[0], `${entry.term} does not start a sentence`).toBe(
        definition[0]!.toUpperCase(),
      )
      expect(definition.endsWith('.'), `${entry.term} does not end its sentence`).toBe(true)
      expect(definition, `${entry.term} trails off`).not.toMatch(/[—-]\s*$/)
    }
  })

  it('carries no doc citation — no ruling number, no invariant, no migration, no issue', () => {
    for (const entry of TERMS) {
      expect(complete(entry), `${entry.term} cites a design doc`).not.toMatch(
        /\((?:D\d+|\d+\.\d+[a-z]?|invariant \d+|E\d+-\d+|#\d+|\d{4})\)/,
      )
    }
  })

  it('quotes none of the phrases #99 ruled off the glass', () => {
    const killed = [
      'legal, tracked',
      'never a failure state',
      'computed, never remembered',
      'somebody looked and the world has not decided',
      'the three kinds of nothing',
      'checks argue, never veto',
      'the two doors',
    ]
    for (const entry of TERMS) {
      for (const phrase of killed) {
        expect(
          complete(entry).toLowerCase().includes(phrase),
          `${entry.term} still says "${phrase}"`,
        ).toBe(false)
      }
    }
  })

  /**
   * The one that makes "written fresh" a fact rather than an intention. `CLAUDE.md` is
   * doc-voice by construction — it settles arguments between sessions — so a definition
   * that appears in it word for word is a definition that was lifted rather than written.
   */
  it('appears nowhere in CLAUDE.md, because none of it was lifted from there', () => {
    for (const entry of TERMS) {
      for (const sentence of complete(entry).split('. ')) {
        const trimmed = sentence.trim()
        if (trimmed.length < 25) continue
        expect(CLAUDE.includes(trimmed), `${entry.term} was lifted out of CLAUDE.md`).toBe(false)
      }
    }
  })

  it('says who acts wherever an act is described', () => {
    // Not every definition describes an act — "severity" is a reading, not a verb. The ones
    // that DO name an actor rather than leaving the sentence agentless.
    const acting = TERMS.filter((entry) => /\b(approve|writes|reads|rule|raises|claims)\b/.test(entry.definition))
    expect(acting.length).toBeGreaterThan(8)
    for (const entry of acting) {
      expect(
        /\b(you|your|the model|a check|the app|code|a loader|the runner|an episode|the claim|a step|a check)\b/i.test(
          entry.definition,
        ),
        `${entry.term} describes an act with nobody doing it`,
      ).toBe(true)
    }
  })
})

describe('marking a sentence', () => {
  const say = (text: string) =>
    markTerms(text)
      .map((piece) => (piece.term === null ? piece.text : `[${piece.text}]`))
      .join('')

  it('leaves a sentence with no glossary word in it exactly as it was', () => {
    const plain = 'Eight of nine shots are on disk, and the ninth is still generating.'
    expect(markTerms(plain)).toEqual([{ text: plain, definition: null, term: null }])
  })

  it('marks a whole word and never a word that merely contains one', () => {
    // "arc" inside "architecture", "pin" inside "spine", "run" inside "runner".
    expect(say('the architecture of the spine, and the runner beneath it')).toBe(
      'the architecture of the spine, and the runner beneath it',
    )
    expect(say('this arc has three waypoints')).toBe('this [arc] has three [waypoints]')
  })

  it('marks a term once per sentence, on its first appearance', () => {
    expect(say('a finding argues, and a finding never decides — read the finding')).toBe(
      'a [finding] argues, and a finding never decides — read the finding',
    )
  })

  it('prefers the longer term where two overlap', () => {
    expect(say('the continuity board counts them')).toBe('the [continuity board] counts them')
  })

  it('carries the definition on the marked run and nothing else', () => {
    const pieces = markTerms('a gate waits on you')
    const marked = pieces.filter((piece) => piece.term !== null)
    expect(marked).toHaveLength(1)
    expect(marked[0]!.term).toBe('gate')
    expect(marked[0]!.text).toBe('gate')
    expect(marked[0]!.definition).toContain('waits on your verdict')
    for (const piece of pieces.filter((one) => one.term === null)) {
      expect(piece.definition).toBeNull()
    }
  })

  it('keeps the sentence intact — the pieces put back together are the input', () => {
    const sentence =
      'Every proposal riding ep02 reaches you at the sweep, and the arc has no landing yet.'
    expect(markTerms(sentence).map((piece) => piece.text).join('')).toBe(sentence)
  })

  it('matches however the sentence capitalises it, and marks the sentence’s own spelling', () => {
    const pieces = markTerms('Findings appear beside the lines they refer to.')
    expect(pieces[0]!.text).toBe('Findings')
    expect(pieces[0]!.term).toBe('finding')
  })

  it('leaves the ordinary verbs alone — "run the checks", not a run and not a check', () => {
    // `run`, `check`, `close` and `step` are glossary terms whose singular is also plain
    // English in this copy. Only the unambiguous spellings are marked.
    expect(say('run the checks yourself, then step through what they found')).toBe(
      'run the [checks] yourself, then step through what they found',
    )
  })
})
