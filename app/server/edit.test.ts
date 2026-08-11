import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from './db/store.ts'
import {
  artifactsOf,
  reviseArtifact,
  staleArtifacts,
  type Artifact,
} from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { registerEntity } from './domain/canon.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import {
  checkPassesOf,
  dismissFinding,
  findingsIn,
  type Finding,
} from './domain/finding.ts'
import { createProposalRulings, proposalsRiding, raiseProposal } from './domain/proposal.ts'
import { episodesOf, findEpisode, scenesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { editArtifact, editOffer, editScene, scenesToEdit, writtenArtifacts } from './edit.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageBlockedBecause } from './runner/stage-wall.ts'
import { stageCatalogue } from './runner/stages.ts'

/**
 * **Ryan's hand on a written artifact** (E4-5, #65; D20, 1.3, D12).
 *
 * The whole of this file is one claim in several places: **his text lands verbatim as a new
 * version, and the free deterministic tier has already read that version by the time the call
 * returns.** That is E3-5's one motion (`remediation.ts`), generalized off the back of a
 * finding and onto every written kind — and the E3 constraints ledger's first entry says why
 * it may not be done any other way: "a version nobody has read looks identical to a version
 * read clean, and the wall cannot tell the difference from findings alone".
 *
 * Everything runs against a REAL library volume with Grey Harbor **founded** in it, and the
 * fake backend in front of the model — which every test here also asserts is never called,
 * because an edit that spent a model call would make "no model call · $0.00" a lie on the
 * button (invariant 5, trap 6 of the issue).
 */

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let harbor: FoundedFixture
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-edit-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)

  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Reading ─────────────────────────────────────────────────────────────────────

const artifact = (kind: string, episodeId: string = ep01): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === kind)!

const textOf = (one: Artifact): string =>
  readFileSync(join(paths.artifactDir, one.filePath!), 'utf8')

const passesAt = (one: Artifact, version: number): string[] =>
  checkPassesOf(store, one.id)
    .filter((pass) => pass.artifactVersion === version)
    .map((pass) => pass.checkKey)

/** The fixture's script with one heading renamed — a scene is its heading (E4-3). */
const renameScene = (from: string, to: string): string =>
  textOf(artifact('script')).replace(from, to)

/** The board, extracted once, so the free tier has continuity rules to re-run. */
function buildTheBoard(): void {
  const script = artifact('script')
  const board = recordExtractedBoard(store, {
    episodeId: ep01,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factIn('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factIn('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
}

function factIn(entity: string, needle: string): string {
  return factsOfEntity(store, harbor.entity(entity).id).find((fact) =>
    fact.statement.includes(needle),
  )!.id
}

// ── The one motion, at every written kind ───────────────────────────────────────

describe('an edit lands verbatim as a new version, already read', () => {
  it('lands the outline word for word and files the receipt at the new version', () => {
    const outline = artifact('outline')
    const typed = `${textOf(outline)}\n## After\n\n  Two spaces, a stray tab\there, and no full stop`

    expect(passesAt(outline, 2)).toEqual([])
    const edited = editArtifact(store, paths, { artifactId: outline.id, text: typed })

    // Verbatim: an edit is a hand-made asset and it wins (D20). Not trimmed, not reflowed,
    // not given a trailing newline it did not have.
    expect(edited.version).toBe(2)
    expect(readFileSync(join(paths.artifactDir, edited.filePath), 'utf8')).toBe(typed)
    expect(edited.filePath).toBe('greyharbor/s01e01/outline-v2.md')
    // The old draft is still beside it: nothing is ever written over (D20).
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/outline.md'))).toBe(true)

    // The receipt. It exists BEFORE the call returned, which is the whole of the motion.
    expect(edited.read.map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
    expect(passesAt(artifact('outline'), 2)).toEqual(['stale-exception', 'retired-reappearance'])
    expect(llm.calls).toEqual([])
  })

  it('lands the script the same way, and re-derives its scenes from what he typed', () => {
    const script = artifact('script')
    const before = scenesOf(store, ep01).map((scene) => scene.heading)
    const typed = textOf(script).replace('Three minutes of it, start to finish.', 'Four minutes.')

    const edited = editArtifact(store, paths, { artifactId: script.id, text: typed })

    expect(edited.version).toBe(2)
    expect(readFileSync(join(paths.artifactDir, edited.filePath), 'utf8')).toBe(typed)
    expect(passesAt(artifact('script'), 2)).toEqual(['stale-exception', 'retired-reappearance'])
    // Delineated per landed draft, exactly as the writer's own drafts are (E4-3's ledger
    // entry names this path by name). Same headings, so the same scene rows.
    expect(edited.scenes.map((scene: { heading: string }) => scene.heading)).toEqual(before)
    expect(scenesOf(store, ep01)).toHaveLength(6)
    expect(llm.calls).toEqual([])
  })

  it('lands the premise-brief too — there is no kind with its own door', () => {
    const brief = artifact('premise-brief')
    const edited = editArtifact(store, paths, {
      artifactId: brief.id,
      text: 'A relay goes dark, and the part that replaces it was promised to the water plant.\n',
    })

    expect(edited.version).toBe(2)
    expect(passesAt(artifact('premise-brief'), 2)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
  })
})

// ── D14's scene door: the same motion, aimed at a span (E5-2) ───────────────────

/**
 * **Editing one scene is composition, not a second write path.**
 *
 * `editScene` resolves the span through `sceneSpans` — the resolver `panel.ts` anchors a
 * finding with — splices Ryan's words into the whole draft, and hands the whole draft to
 * `editArtifact`. So every promise the door above keeps is kept here by construction:
 * verbatim text, re-delineation, the free tier's receipt at the new version, freshness off
 * the edges, no model call. What it adds is the touched SCENE, which is the one thing a
 * whole-artifact edit deliberately does not claim to know.
 */
describe('a scene edit is the one motion aimed at a span', () => {
  it('lands his words inside the draft, files the receipt, and names the scene he touched', () => {
    const script = artifact('script')
    const before = textOf(script)
    const scenes = scenesToEdit(store, paths, script.id)
    const three = scenes[2]!

    // The block is the scene's own LINES: it opens on the markdown heading that carries its
    // name and stops where the next scene's heading line begins (see `blockOf`).
    expect(three.ordinal).toBe(3)
    expect(three.text).toContain(three.heading)
    expect(three.text.trimStart().startsWith('## ')).toBe(true)
    expect(three.text).not.toContain(scenes[3]!.heading)
    expect(three.edit.enabled).toBe(true)
    expect(three.edit.cost).toBe('No model call · $0.00')

    const typed = `${three.text.trimEnd()}\n\nHe counts the seconds out loud, and gets one wrong.\n\n`
    const edited = editScene(store, paths, {
      artifactId: script.id,
      sceneId: three.sceneId,
      text: typed,
    })

    // Verbatim, and INSIDE the draft: the scenes around it are untouched, character for
    // character, which is what a splice means and what a whole-artifact edit cannot promise.
    const landed = readFileSync(join(paths.artifactDir, edited.filePath), 'utf8')
    expect(landed).toBe(before.replace(three.text, typed))
    expect(landed).toContain('He counts the seconds out loud, and gets one wrong.')
    expect(landed).toContain(scenes[1]!.text)
    expect(landed).toContain(scenes[3]!.text)

    // The receipt: a `check_pass` at the new version existed before this call returned.
    expect(edited.version).toBe(2)
    expect(edited.read.map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
    expect(passesAt(artifact('script'), 2)).toEqual(['stale-exception', 'retired-reappearance'])

    // The touched scene, named — on the record and in the sentence.
    expect(edited.touchedScene).toEqual({
      id: three.sceneId,
      ordinal: 3,
      heading: three.heading,
    })
    expect(edited.sentence).toContain('You typed over scene 3')
    expect(edited.sentence).toContain(three.heading)
    // Re-delineated from what he typed, and the headings are unchanged, so are the rows.
    expect(edited.scenes).toHaveLength(6)
    // And it spent nothing. "No model call · $0.00" on the button is the whole truth.
    expect(llm.calls).toEqual([])
  })

  /**
   * The point of naming the scene: staleness lands where the edit did. A board consumes the
   * script one edge per scene (`domain/board.ts`), so a scene-3 revision moves the scene-3
   * edge and a scene-3 edge only — which is `applyRewrite`'s rule reached by the other door.
   */
  it('names the scene on the revision, so what was built on THAT scene is what goes stale', () => {
    buildTheBoard()
    const script = artifact('script')
    const three = scenesToEdit(store, paths, script.id)[2]!

    editScene(store, paths, {
      artifactId: script.id,
      sceneId: three.sceneId,
      text: `${three.text}\nOne more line, in scene three only.\n`,
    })

    const stale = staleArtifacts(store, ep01)
    expect(stale.map((one) => one.artifact.kind)).toContain('continuity-board')
    const because = stale.find((one) => one.artifact.kind === 'continuity-board')!
    const moved = because.reasons.find((reason) => reason.kind === 'input-moved-on')!
    // The revision that moved it says which scene it was, in the words the screen renders.
    expect(moved.revisions.map((revision) => revision.summary)).toEqual([
      'you edited scene 3 by hand',
    ])
    expect(moved.sceneId).toBe(three.sceneId)
  })

  it('refuses a scene it cannot locate in the draft, rather than replacing the whole script', () => {
    const script = artifact('script')
    const scenes = scenesOf(store, ep01)
    // A heading the draft no longer carries — the state a hand edit can leave behind. Left
    // to `sceneSpans`, this resolves to the WHOLE artifact, and a splice would eat the script.
    store.run('UPDATE scene SET heading = ? WHERE id = ?', 'INT. NOWHERE', scenes[2]!.id)

    const three = scenesToEdit(store, paths, script.id)[2]!
    expect(three.text).toBe('')
    expect(three.edit.enabled).toBe(false)
    expect(three.edit.blockedBecause).toContain('that heading is not in the script')

    expect(() =>
      editScene(store, paths, { artifactId: script.id, sceneId: three.sceneId, text: 'x' }),
    ).toThrow(/heading is not in the script/)
    // Nothing landed: the draft is still at v1 and no second file is on the volume.
    expect(artifact('script').version).toBe(1)
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/script-v2.md'))).toBe(false)
  })

  it('refuses a kind that has no scenes, and a scene that belongs to another episode', () => {
    const outline = artifact('outline')
    const three = scenesOf(store, ep01)[2]!

    expect(() =>
      editScene(store, paths, { artifactId: outline.id, sceneId: three.id, text: 'x' }),
    ).toThrow(/Only a script breaks into scenes/)
    expect(() =>
      editScene(store, paths, { artifactId: artifact('script').id, sceneId: 'scene_nope', text: 'x' }),
    ).toThrow(/does not belong to this episode/)
  })

  /** Every precondition on the artifact stands on its scenes too, quoted rather than restated. */
  it('inherits D7’s refusal while a run holds the episode, in the same words', async () => {
    const script = artifact('script')
    const three = scenesToEdit(store, paths, script.id)[2]!
    expect(three.edit.enabled).toBe(true)

    llm.reply('A premise, and nothing more.')
    for (let n = 0; n < 8; n += 1) llm.reply('{"findings": []}')
    const run = runner.enqueueRun({ episodeId: ep01, stage: 'script-gate' })
    await runner.settled(run.id)

    const held = scenesToEdit(store, paths, script.id)[2]!
    expect(held.edit.enabled).toBe(false)
    expect(held.edit.blockedBecause).toContain('One run per episode (D7)')
    expect(() =>
      editScene(store, paths, { artifactId: script.id, sceneId: three.sceneId, text: 'x' }),
    ).toThrow(/One run per episode \(D7\)/)
  })
})

// ── The E3 ledger's first entry, at its second call site ────────────────────────

describe('the wall never reads a never-checked current version as clear', () => {
  it('stands on a reading of the new draft, never on the absence of one', () => {
    buildTheBoard()
    // Tobin on the pier in coveralls: the deterministic finding the fixture plants, standing
    // against v1. The wall is up.
    expect(stageBlockedBecause(store, ep01)).toContain('vacuum-without-protection')

    // ── The control: what a half-motion would do ──────────────────────────────
    // A version that lands and stops. Every finding was anchored in the draft it replaced, so
    // every one drops out of the wall and NOTHING has read what took its place.
    const control = anotherGreyHarbor()
    try {
      reviseArtifact(control.store, control.script.id, { summary: 'landed a version and stopped' })
      expect(stageBlockedBecause(control.store, control.episodeId)).toBeNull()
      expect(
        checkPassesOf(control.store, control.script.id).filter((pass) => pass.artifactVersion === 2),
      ).toEqual([])
    } finally {
      control.close()
    }

    // ── The motion ────────────────────────────────────────────────────────────
    const script = artifact('script')
    const edited = editArtifact(store, paths, {
      artifactId: script.id,
      text: textOf(script).replace('Three minutes of it,', 'Three and a half minutes of it,'),
    })

    expect(edited.wall).toContain('vacuum-without-protection')
    expect(stageBlockedBecause(store, ep01)).toEqual(edited.wall)
    expect(passesAt(artifact('script'), 2)).not.toEqual([])
  })
})

// ── Staleness flows downstream, and the lifecycle does not move ─────────────────

describe('an edit stales what was built on it and moves no episode', () => {
  it('renders the script stale with the sentence naming why, and leaves ep01 at script', () => {
    expect(staleArtifacts(store, ep01)).toEqual([])
    expect(findEpisode(store, ep01)!.lifecycle).toBe('script')

    const outline = artifact('outline')
    editArtifact(store, paths, {
      artifactId: outline.id,
      text: `${textOf(outline)}\n\nAnd a fourth movement nobody wrote a scene for.\n`,
    })

    const script = writtenArtifacts(store, paths, ep01).find(
      (one) => one.artifact.kind === 'script',
    )!
    expect(script.status).toBe('stale')
    expect(script.staleBecause).toBe(
      'The ep01 script was built from the ep01 outline v1, and the ep01 outline stands at v2 ' +
        'now — you edited it by hand. It is stale until something is written from what the ' +
        'outline says now.',
    )
    // Lifecycle names the stage the episode is AT (E4-1). Nothing here is an approval, so
    // nothing here moves it — forwards or backwards.
    expect(findEpisode(store, ep01)!.lifecycle).toBe('script')
    // Computed, never remembered (1.3): there is no flag for the edit to have set.
    expect(staleArtifacts(store, ep01).map((one) => one.artifact.kind)).toEqual(['script'])
  })
})

// ── An edit does not launder a finding ──────────────────────────────────────────

describe('his hand is not a fourth door through the wall', () => {
  it('meets the same wall again when the edit leaves the contradiction in place', () => {
    buildTheBoard()
    const before = openDeterministic()
    expect(before.map((one) => one.checkKey)).toContain('vacuum-without-protection')

    const script = artifact('script')
    editArtifact(store, paths, {
      artifactId: script.id,
      // Somewhere else entirely. The pier and the coveralls are exactly where they were.
      text: textOf(script).replace('answer he always gives', 'answer he has always given'),
    })

    // The rule read the NEW draft and found the same thing in it, so what stands against v2
    // is a fresh finding rather than the old one surviving. The v1 rows are still there and
    // still say what they said: a finding is what a check said at a version (0010).
    const after = openDeterministic()
    expect(after.filter((one) => one.anchor.version === 2).map((one) => one.checkKey)).toContain(
      'vacuum-without-protection',
    )
    expect(after.some((one) => one.anchor.version === 1)).toBe(true)
    expect(stageBlockedBecause(store, ep01)).toContain('vacuum-without-protection')
  })

  it('lets a standing dismissal reach the byte-identical twin his edit raised again', () => {
    buildTheBoard()
    // Every one of the fixture's planted contradictions put down with a note, so the wall is
    // his own ruling and nothing else — which is what makes the assertion after the edit mean
    // something (E3-6: a dismissal is concern-scoped and reaches byte-identical twins).
    for (const finding of openDeterministic()) {
      dismissFinding(store, finding.id, 'I know about this one — I will fix the line.')
    }
    expect(stageBlockedBecause(store, ep01)).toBeNull()

    const script = artifact('script')
    editArtifact(store, paths, {
      artifactId: script.id,
      text: textOf(script).replace('answer he always gives', 'answer he has always given'),
    })

    // The rule fired again — it reads rows and knows nothing about dispositions — and the
    // finding it raised is OPEN. What reaches it is E3-6's identity, not a copied flag.
    expect(openDeterministic().map((one) => one.checkKey)).toContain('vacuum-without-protection')
    expect(stageBlockedBecause(store, ep01)).toBeNull()
  })

  it('walls normally on a contradiction his own edit introduced', () => {
    const retired = registerEntity(store, {
      showId: harbor.show.id,
      categoryKey: 'location',
      name: 'The old wet dock',
    })
    const proposal = raiseProposal(store, {
      entityId: retired.id,
      kind: 'promotion',
      raisedBy: 'ryan',
      standing: 'retired',
      body: 'Sealed and struck off the plan two seasons before the series begins.',
    })
    createProposalRulings(store, events).ratify(proposal.id, { note: 'done with it.' })
    expect(stageBlockedBecause(store, ep01)).toBeNull()

    const script = artifact('script')
    const edited = editArtifact(store, paths, {
      artifactId: script.id,
      text: textOf(script).replace(
        'Three minutes of it, start to finish.',
        'Three minutes of it, start to finish. The old wet dock is dark behind him.',
      ),
    })

    // He wrote it, so he declared it (invariant 2, E4-1's rule pointed at his hand), and the
    // free tier read the provenance his own words made.
    expect(edited.wall).toContain('retired-reappearance')
    expect(edited.wall).toContain('The old wet dock is declared retired')
    expect(stageBlockedBecause(store, ep01)).toEqual(edited.wall)
  })
})

// ── It does not re-extract, and it does not spend ───────────────────────────────

describe('an edit spends nothing and raises nothing', () => {
  it('makes no call and raises no proposal — the bench is where his claims go', () => {
    const before = proposalsRiding(store, ep01).length
    const script = artifact('script')

    editArtifact(store, paths, {
      artifactId: script.id,
      text: textOf(script).replace('Three minutes of it,', 'Nine minutes of it,'),
    })

    expect(llm.calls).toEqual([])
    expect(proposalsRiding(store, ep01)).toHaveLength(before)
    expect(store.all('SELECT * FROM cost_entry')).toEqual([])
  })

  it('says so on the button before the click', () => {
    const offer = editOffer(store, paths, artifact('script').id)

    expect(offer.enabled).toBe(true)
    expect(offer.blockedBecause).toBeNull()
    expect(offer.sentence).toContain('Edit the ep01 script yourself')
    expect(offer.sentence).toContain('lands word for word as v2')
    expect(offer.cost).toBe('No model call · $0.00')
    expect(offer.sentence).not.toMatch(/^(Launch|Run|Go|Do|Edit it|Start)\b/)
  })
})

// ── A scene is its heading, and an edit inherits that whole ─────────────────────

describe('a script edit re-delineates by heading', () => {
  it('raises a new scene for a renamed heading and degrades what was anchored in the old one', () => {
    buildTheBoard()
    const script = artifact('script')
    const scene4 = scenesOf(store, ep01)[3]!
    const anchored = findingsIn(store, script.id, { sceneId: scene4.id })
    expect(anchored.length).toBeGreaterThan(0)

    editArtifact(store, paths, {
      artifactId: script.id,
      text: renameScene('4 · EXT. THE LONG PIER — 07:07', '4 · EXT. THE LONG PIER — 07:09'),
    })

    expect(scenesOf(store, ep01).map((one) => one.heading)).toContain('EXT. THE LONG PIER — 07:09')
    expect(scenesOf(store, ep01).map((one) => one.id)).not.toContain(scene4.id)
    // Degraded to the whole artifact rather than migrated onto prose nobody checked (0013).
    for (const finding of anchored) {
      expect(findingsIn(store, script.id).find((one) => one.id === finding.id)!.anchor.sceneId)
        .toBeNull()
    }
  })

  it('refuses a script it cannot read scenes out of, and writes no file at all', () => {
    const script = artifact('script')

    expect(() =>
      editArtifact(store, paths, { artifactId: script.id, text: 'Just prose, no headings.\n' }),
    ).toThrow(/no scene headings in it/)

    expect(artifact('script').version).toBe(1)
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/script-v2.md'))).toBe(false)
    expect(passesAt(artifact('script'), 2)).toEqual([])
  })
})

// ── Preconditions, before the button ────────────────────────────────────────────

describe('what the edit door refuses, in the words the button shows', () => {
  it('refuses an empty artifact — a deletion is not a draft', () => {
    const outline = artifact('outline')
    expect(() => editArtifact(store, paths, { artifactId: outline.id, text: '   \n' })).toThrow(
      /nothing for a check to read/,
    )
    expect(artifact('outline').version).toBe(1)
  })

  it('refuses the draft that is already on the volume', () => {
    const outline = artifact('outline')
    expect(() =>
      editArtifact(store, paths, { artifactId: outline.id, text: textOf(outline) }),
    ).toThrow(/already on the volume/)
  })

  it('refuses a kind nobody writes by hand, and says which kinds are his', () => {
    buildTheBoard()
    const board = artifact('continuity-board')
    const offer = editOffer(store, paths, board.id)

    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('continuity-board')
    expect(offer.blockedBecause).toContain('premise-brief, outline, script')
    expect(() => editArtifact(store, paths, { artifactId: board.id, text: 'nope' })).toThrow(
      offer.blockedBecause!,
    )
  })

  it('refuses while a run holds the episode, with D7’s own sentence', async () => {
    const run = runner.enqueueRun({ episodeId: ep01, stage: 'continuity-board-checks' })
    store.run("UPDATE run SET status = 'paused' WHERE id = ?", run.id)

    const offer = editOffer(store, paths, artifact('script').id)
    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('One run per episode (D7)')
    expect(() =>
      editArtifact(store, paths, { artifactId: artifact('script').id, text: 'x' }),
    ).toThrow(/One run per episode/)
  })

  it('refuses an artifact that was never produced, and one that is not there at all', () => {
    expect(() => editOffer(store, paths, 'art_nothing')).toThrow(/No such artifact/)
    expect(() =>
      editArtifact(store, paths, { artifactId: artifact('script', ep02).id, text: 'x' }),
    ).toThrow()
  })
})

/**
 * A second Grey Harbor, founded, on its own volume — the control for the one-motion test.
 *
 * A whole library rather than a second artifact in this one, for `remediation.test.ts`'s
 * reason: the question is about an EPISODE's wall, and two episodes carrying the same planted
 * contradiction in one store would be two answers to a question asked per episode.
 */
function anotherGreyHarbor(): {
  store: Store
  episodeId: string
  script: Artifact
  close(): void
} {
  const otherRoot = mkdtempSync(join(tmpdir(), 'showrunner-edit-control-'))
  const otherPaths = initLibrary(otherRoot)
  const otherStore = openLibraryStore(otherPaths)
  const other = greyHarborFounded(otherStore, otherPaths)
  const episodeId = episodesOf(otherStore, seasonsOf(otherStore, other.show.id)[0]!.id)[0]!.id
  const otherScript = artifactsOf(otherStore, episodeId).find((one) => one.kind === 'script')!
  const board = recordExtractedBoard(otherStore, {
    episodeId,
    scriptId: otherScript.id,
    extraction: theLongPierExtraction({
      lockCycle: factsOfEntity(otherStore, other.entity('Grey Harbor Station').id).find((fact) =>
        fact.statement.includes('Cycling the No. 4 lock'),
      )!.id,
      halvaniVacuum: factsOfEntity(otherStore, other.entity('Halvani').id).find((fact) =>
        fact.statement.includes('loses consciousness'),
      )!.id,
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(otherStore, board.artifact.id)

  return {
    store: otherStore,
    episodeId,
    script: otherScript,
    close() {
      otherStore.close()
      rmSync(otherRoot, { recursive: true, force: true })
    },
  }
}

/** Every deterministic finding still open on the ep01 script, whatever version it argued with. */
const openDeterministic = (): Finding[] =>
  findingsIn(store, artifact('script').id).filter(
    (one) => one.tier === 'deterministic' && one.status === 'open',
  )
