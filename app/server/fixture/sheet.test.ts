import { describe, expect, it } from 'vitest'
import { field, fields, parseSheet, section } from './sheet.ts'

/**
 * The sheet format is the fixture's whole user interface: a showrunner copying Grey
 * Harbor edits markdown, not TypeScript and not JSON. So the parser is held to the
 * shapes those files actually use — wrapped prose, repeated keys, values with colons
 * in them — rather than to the tidy subset a hand-written example would show.
 */

const SHEET = `# Ilse Renn

> Harbourmaster of Grey Harbor.
> Answers with a duty time.

## Identity

- standing: core
- aliases: the harbourmaster, Renn

## Relations

- species: Halvani
- carries: Kestrel-pattern containment collar

## Body

She runs the harbour the way it was run when there were ships.

### An aside

Which is not the same thing as running it well.

## Facts

- Ilse has kept the post for eleven years, seven of them with traffic and four
  without, and has never once said why.
- Ilse quotes the budget: 4.1kW, which is not a reason.
`

describe('the fixture sheet format', () => {
  it('reads the title and the blurb beneath it', () => {
    const sheet = parseSheet('ilse-renn.md', SHEET)

    expect(sheet.title).toBe('Ilse Renn')
    expect(sheet.quote).toBe('Harbourmaster of Grey Harbor. Answers with a duty time.')
  })

  it('splits the sections and keeps them in file order', () => {
    const sheet = parseSheet('ilse-renn.md', SHEET)

    expect(sheet.sections.map((s) => s.name)).toEqual(['Identity', 'Relations', 'Body', 'Facts'])
  })

  it('reads a section as prose, sub-headings and all', () => {
    const body = section(parseSheet('ilse-renn.md', SHEET), 'Body')!

    expect(body.text).toContain('the way it was run when there were ships')
    expect(body.text).toContain('### An aside')
  })

  it('folds a wrapped bullet into one line', () => {
    const facts = section(parseSheet('ilse-renn.md', SHEET), 'Facts')!

    expect(facts.bullets[0]).toBe(
      'Ilse has kept the post for eleven years, seven of them with traffic and four ' +
        'without, and has never once said why.',
    )
  })

  it('reads key/value bullets, splitting at the first colon only', () => {
    const identity = section(parseSheet('ilse-renn.md', SHEET), 'Identity')!

    expect(fields(identity)).toEqual([
      { key: 'standing', value: 'core' },
      { key: 'aliases', value: 'the harbourmaster, Renn' },
    ])
  })

  it('keeps a colon inside a value, and reads a bullet with none as prose', () => {
    const sheet = parseSheet(
      'arc.md',
      '# What the harbor is for\n\n## Waypoint 1 — The harbor is a job\n\n' +
        '- landing criteria: She answers once: with the roster.\n' +
        '- this bullet is prose and has no colon\n',
    )
    const waypoint = section(sheet, 'Waypoint 1 — The harbor is a job')!

    expect(fields(waypoint)).toEqual([
      { key: 'landing criteria', value: 'She answers once: with the roster.' },
    ])
    expect(waypoint.bullets).toHaveLength(2)
  })

  it('finds one field by key, and says nothing rather than guessing', () => {
    const relations = section(parseSheet('ilse-renn.md', SHEET), 'Relations')!

    expect(field(relations, 'species')).toBe('Halvani')
    expect(field(relations, 'homeworld')).toBeUndefined()
    expect(section(parseSheet('ilse-renn.md', SHEET), 'Nowhere')).toBeUndefined()
  })

  it('reads a section that is prose only, with no bullets, without inventing any', () => {
    const sheet = parseSheet('empty.md', '# Dry Stores\n\n## Artifacts\n\nNone. Nothing yet.\n')

    expect(section(sheet, 'Artifacts')!.bullets).toEqual([])
    expect(section(sheet, 'Artifacts')!.text).toBe('None. Nothing yet.')
  })

  it('refuses a file with no title, naming the file', () => {
    expect(() => parseSheet('broken.md', '## Identity\n- standing: core\n')).toThrow(
      /broken\.md.*no `# ` title/,
    )
  })
})
