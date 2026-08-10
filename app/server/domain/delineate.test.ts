import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { FIXTURE_DIR } from '../fixture/read.ts'
import { loadFixture } from '../fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { delineateScript } from './delineate.ts'
import { delineateScenes, episodesOf, scenesOf, seasonsOf } from './spine.ts'

/**
 * **The delineator, and the fixture as its proof** (E4-3, D3).
 *
 * The convention is not written down anywhere but in code, and it has two callers that must
 * never disagree: the fixture's loader, which planted ep01's six scenes and the spans two
 * planted defects are anchored to, and the script stage, which delineates every draft that
 * lands. So the proof of one convention is not a comment — it is delineating
 * `fixtures/greyharbor/episode/01-the-long-pier/script.md` and getting back exactly the rows
 * `fixture:load` puts in the database, ids included.
 *
 * The fixture's scenes are FIXED POINTS (the E1 ledger): the planted world-rules violation is
 * scene 4 and the dual presence is scenes 5 and 6, and a delineator that wanted the script
 * changed would be the delineator that is wrong.
 */

const SCRIPT = join(FIXTURE_DIR, 'episode/01-the-long-pier/script.md')

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-delineate-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── The fixture is the convention's proof ───────────────────────────────────────

describe('delineating the fixture’s own script', () => {
  it('derives the six scenes ep01 has, in order, with the planted defects where they are', () => {
    const scenes = delineateScript(readFileSync(SCRIPT, 'utf8'), 'the ep01 script')

    expect(scenes.map((scene) => scene.heading)).toEqual([
      'INT. GREY HARBOR STATION — MESS DECK — 06:10',
      "INT. HARBOURMASTER'S OFFICE — 06:40",
      'INT. NO. 4 LOCK — 07:05',
      'EXT. THE LONG PIER — 07:07',
      "INT. HARBOURMASTER'S OFFICE — 07:20",
      'EXT. THE LONG PIER — CONTINUOUS',
    ])
    // The count is an OUTPUT and it is read off the array, never asserted as an input (D3).
    expect(scenes).toHaveLength(6)
    // Scene 4 is the world-rules violation and 5–6 are the dual presence. `episode.md` says so
    // and nothing may move them.
    expect(scenes[3]!.summary).toContain('in his coveralls')
    expect(scenes[5]!.heading).toContain('CONTINUOUS')
  })

  it('reproduces the rows `fixture:load` planted — same count, same headings, same ids', () => {
    const report = loadFixture(store, paths)
    const season = seasonsOf(store, report.show.id)[0]!
    const ep01 = episodesOf(store, season.id)[0]!
    const planted = scenesOf(store, ep01.id)

    // Delineating the same file again and writing it back through the same door: every row
    // survives with its id, because a scene is its heading and no heading moved. This is the
    // whole of "one convention" — the loader and the script stage cannot be two readings.
    const again = delineateScenes(store, ep01.id, delineateScript(readFileSync(SCRIPT, 'utf8'), SCRIPT))

    expect(again).toEqual(planted)
    expect(again.map((scene) => scene.id)).toEqual(planted.map((scene) => scene.id))
    expect(report.scenes).toBe(6)
  })
})

// ── The convention, and what it refuses ─────────────────────────────────────────

describe('the convention', () => {
  const script = (...lines: string[]): string => lines.join('\n')

  it('takes the heading after the dot and the blockquote under it as the summary', () => {
    const scenes = delineateScript(
      script(
        '# Dry Stores — script',
        '',
        '> Grey Harbor · Season 1 · Episode 2 · draft 1',
        '',
        '## 1 · INT. WATER PLANT — 05:50',
        '',
        '> Tobin reads the exchanger log and says the',
        '> thing out loud.',
        '',
        'The plant is loud in the way a thing is loud when it is working.',
        '',
        '## 2 · INT. HARBOURMASTER’S OFFICE — 06:30',
        '',
        'Ilse does not look up.',
      ),
      'the ep02 script draft',
    )

    expect(scenes).toEqual([
      {
        heading: 'INT. WATER PLANT — 05:50',
        // Folded to one line, and the prose beneath it is not part of it.
        summary: 'Tobin reads the exchanger log and says the thing out loud.',
      },
      { heading: 'INT. HARBOURMASTER’S OFFICE — 06:30', summary: '' },
    ])
  })

  it('refuses a draft with no scene headings at all, and says what one looks like', () => {
    expect(() => delineateScript('Ilse is at the end of the long table.\n', 'the ep02 script')).toThrow(
      /the ep02 script has no scene headings in it.*## 4 · EXT\. THE LONG PIER/s,
    )
  })

  it('refuses a heading that carries no ordinal', () => {
    expect(() =>
      delineateScript(script('## INT. WATER PLANT — 05:50', '', 'Loud.'), 'the ep02 script'),
    ).toThrow(/is not a scene heading/)
  })

  it('refuses a heading numbered out of order — one thing may not have two numbers', () => {
    expect(() =>
      delineateScript(
        script('## 1 · INT. WATER PLANT', '', 'a', '', '## 3 · INT. OFFICE', '', 'b'),
        'the ep02 script',
      ),
    ).toThrow(/scene 3 is the 2th heading in the file/)
  })

  it('does not mistake a sub-heading inside a scene for a scene of its own', () => {
    const scenes = delineateScript(
      script('## 1 · INT. WATER PLANT', '', '### The log', '', 'Loud.', '', '## 2 · INT. OFFICE', '', 'Quiet.'),
      'the ep02 script',
    )

    expect(scenes.map((scene) => scene.heading)).toEqual(['INT. WATER PLANT', 'INT. OFFICE'])
  })
})
