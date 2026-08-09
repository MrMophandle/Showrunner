import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FREE } from './cost.ts'
import type { Store } from './db/store.ts'
import { artifactsOf } from './domain/artifact.ts'
import { recordCheckPass } from './domain/finding.ts'
import { episodesOf, findEpisode, scenesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { launchBlockedBecause, operatingView, runView } from './operating.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { DEMO_STAGE, stageCatalogue } from './runner/stages.ts'
import { STAGE_WORK, type Stage } from './runner/step.ts'

/**
 * The operating page's read model: the sentences Ryan reads, and the preconditions that
 * are stated in front of a button rather than discovered after it.
 *
 * Every sentence asserted here is a rule from CLAUDE.md with a test on it — verb + object
 * + scope + cost on every button, a blocked action disabled with the reason in words, a
 * gate that renders its artifact and never a filename. Those rules live on this side of
 * the wire precisely so they can be held to.
 */

/** A process with a key: something to call. */
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
/** The container as it booted on Aug 5: no key, no CLI, nothing behind the adapter. */
const NOTHING: LLMReadiness = describeLLMBackend({ PATH: '' })

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-operating-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  loadFixture(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  const episodes = episodesOf(store, seasonsOf(store, show.id)[0]!.id)
  ep01 = episodes.find((episode) => episode.number === 1)!.id
  ep02 = episodes.find((episode) => episode.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The one stage E1 ships, out of the catalogue — the refusal takes a stage, not a name. */
const demoStage = (): Stage => stageCatalogue(paths)[DEMO_STAGE]!

describe('the operating page — what it lists', () => {
  it('lists the fixture show and both episodes at their own lifecycle positions', () => {
    const view = operatingView(store, paths, READY)

    expect(view.emptyBecause).toBeNull()
    const show = view.shows[0]!
    expect([show.key, show.title]).toEqual(['greyharbor', 'Grey Harbor'])
    expect(show.episodes.map((episode) => [episode.label, episode.title, episode.lifecycle])).toEqual([
      ['ep01', 'The Long Pier', 'script'],
      ['ep02', 'Dry Stores', 'premise'],
    ])

    // The lifecycle as a track, so a screen can render where it stands rather than a word.
    const track = show.episodes[0]!.track
    expect(track.map((stop) => stop.stage)).toEqual([
      'premise',
      'outline',
      'script',
      'assets',
      'assembled',
      'published',
    ])
    expect(track.filter((stop) => stop.reached).map((stop) => stop.stage)).toEqual([
      'premise',
      'outline',
      'script',
    ])
    expect(track.find((stop) => stop.current)!.stage).toBe('script')
  })

  it('says what to do about an empty library instead of rendering nothing', () => {
    const empty = openLibraryStore(initLibrary(mkdtempSync(join(tmpdir(), 'showrunner-empty-'))))
    try {
      const view = operatingView(empty, paths, READY)
      expect(view.shows).toEqual([])
      expect(view.emptyBecause).toContain('npm run fixture:load')
    } finally {
      empty.close()
    }
  })
})

describe('the operating page — the launch button', () => {
  it('states verb, object, scope and cost, before the click', () => {
    const launch = operatingView(store, paths, READY).shows[0]!.episodes[0]!.launch

    expect(launch.enabled).toBe(true)
    expect(launch.blockedBecause).toBeNull()
    // Verb + object + scope, and never a generic verb.
    expect(launch.sentence).toBe(
      'Write the ep01 demo premise and present it for your ruling — “The Long Pier”, one call, one gate',
    )
    expect(launch.sentence).not.toMatch(/\b(Launch|Run|Go|Do|Start)\b/)
    // Cost, in the same arithmetic the ledger will use afterwards.
    expect(launch.cost).toMatch(/^1 Opus call, ~\$\d+\.\d\d · your money, spent when you click$/)
  })

  it('is blocked, with the reason in words, when nothing can reach a model', () => {
    const launch = operatingView(store, paths, NOTHING).shows[0]!.episodes[0]!.launch

    expect(launch.enabled).toBe(false)
    expect(launch.blockedBecause).toContain('Nothing to call')
    expect(launch.blockedBecause).toContain('no `claude` executable on PATH')
    // Quoted whole, never re-cased — a variable name Ryan is being told to set must be
    // the name that exists.
    expect(launch.blockedBecause).toContain('Export ANTHROPIC_API_KEY')
    expect(launch.blockedBecause).not.toMatch(/aNTHROPIC/)
    // The cost is still stated: what it WOULD cost is not a secret because it is blocked.
    expect(launch.cost).toContain('1 Opus call')
  })

  it('is blocked while the episode already has a run, and says what that run is doing', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    const view = operatingView(store, paths, READY)
    const [first, second] = view.shows[0]!.episodes

    // ep02 is parked on a gate: one run per episode (D7).
    expect(second!.launch.enabled).toBe(false)
    expect(second!.launch.blockedBecause).toContain('already has a demo run')
    expect(second!.launch.blockedBecause).toContain('waiting on your ruling')
    expect(second!.launch.blockedBecause).toContain('One run per episode')
    expect(second!.run).toMatchObject({ stage: DEMO_STAGE, status: 'paused' })
    expect(second!.run!.openGateId).toBe(openGates(store)[0]!.gate.id)

    // Cross-episode parallelism is the other half of the same ruling: ep01 is untouched.
    expect(first!.launch.enabled).toBe(true)
    expect(first!.run).toBeNull()
  })

  it('refuses an episode that is not in this library', () => {
    expect(launchBlockedBecause(store, READY, 'ep_nope', demoStage())).toBe(
      'There is no episode ep_nope in this library.',
    )
  })

  /**
   * E3-1's deferred defect, at the seam it was deferred to. The refusal used to be true of
   * every stage because every stage called a model; now each one says what it spends and the
   * refusal reads the declaration. **No stage name appears in `launchBlockedBecause`** — an
   * exemption list would be right today and wrong the day somebody adds a stage.
   */
  it('consults what the stage declared rather than assuming every stage spends', () => {
    const catalogue = stageCatalogue(paths)
    const spending = Object.values(catalogue).filter((stage) => {
      const episode = findEpisode(store, ep02)!
      return stage.offerOn(store, episode).callsModel
    })
    const free = Object.values(catalogue).filter(
      (stage) => !stage.offerOn(store, findEpisode(store, ep02)!).callsModel,
    )

    // Both kinds exist in this build, which is what makes the distinction testable at all.
    expect(spending.length).toBeGreaterThan(0)
    expect(free.length).toBeGreaterThan(0)

    for (const stage of spending) {
      const because = launchBlockedBecause(store, NOTHING, ep02, stage)
      // Either the adapter refuses it, or the stage had nothing to do on this episode in the
      // first place — never a silent pass on a stage that would have called a dead backend.
      expect(because).not.toBeNull()
    }
    for (const stage of free) {
      const because = launchBlockedBecause(store, NOTHING, ep02, stage)
      expect(because ?? '').not.toContain('Nothing to call')
    }
  })

  it('stands the wall in front of a stage that produces, and never one that reads', () => {
    const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
    recordCheckPass(store, {
      checkKey: 'dual-presence',
      tier: 'deterministic',
      artifactId: script.id,
      findings: [
        {
          concern: 'Ilse Renn is in two places at one time.',
          severity: 'high',
          confidence: 'certain',
          anchor: { sceneId: scenesOf(store, ep01)[5]!.id, quote: '' },
        },
      ],
    })

    const catalogue = stageCatalogue(paths)
    // D12 refuses the next stage. `demo` writes a premise out of this episode's material.
    expect(launchBlockedBecause(store, READY, ep01, catalogue[DEMO_STAGE]!)).toContain(
      'ep01 is blocked',
    )
    // And it never refuses a reading. The wall's own sentence recommends re-running the free
    // checks; a wall that refused that button would be a dead end built out of its own advice.
    for (const stage of Object.values(catalogue).filter((one) => one.work === 'reads')) {
      expect(launchBlockedBecause(store, READY, ep01, stage) ?? '').not.toContain('is blocked')
    }
  })
})

describe('the stage catalogue — every stage declares itself', () => {
  it('gives each stage a work, a sentence, a cost and a precondition', () => {
    const episode = findEpisode(store, ep01)!

    for (const stage of Object.values(stageCatalogue(paths))) {
      const declared = stage.offerOn(store, episode)
      expect(STAGE_WORK).toContain(stage.work)
      // Verb + object + scope, and never a generic verb — the rule, held to per stage rather
      // than per screen, because this is where the sentence is written.
      expect(declared.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
      expect(declared.sentence).toContain('ep01')
      expect(declared.cost).not.toBe('')
      // A stage that spends nothing says the free sentence, and one that spends says a
      // projection. Neither is left to be inferred from silence.
      if (!declared.callsModel) expect(declared.cost).toBe(FREE)
      else expect(declared.cost).toMatch(/~\$|cost unknown/)
    }
  })

  /**
   * D12's wall, on the button. The finding is planted through `recordCheckPass` — the only
   * path that writes one — because what is being tested here is the SENTENCE the page shows
   * and the API refuses with; which check produced the row is `stage-wall.test.ts`'s business,
   * and it proves it against the real planted contradiction.
   */
  it('renders the wall a deterministic finding puts up, disabled and in words', () => {
    const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
    recordCheckPass(store, {
      checkKey: 'dual-presence',
      tier: 'deterministic',
      artifactId: script.id,
      findings: [
        {
          concern: 'Ilse Renn is in two places at one time. Scenes 5 and 6 share one clock.',
          severity: 'high',
          confidence: 'certain',
          anchor: { sceneId: scenesOf(store, ep01)[5]!.id, quote: '' },
        },
      ],
    })

    const episode = operatingView(store, paths, READY).shows[0]!.episodes[0]!
    expect(episode.launch.enabled).toBe(false)
    expect(episode.launch.blockedBecause).toContain('ep01 is blocked')
    expect(episode.launch.blockedBecause).toContain('dual-presence')
    expect(episode.launch.blockedBecause).toContain('Ilse Renn is in two places at one time.')
    // Stated even when it is blocked: what it would have cost is not a secret.
    expect(episode.launch.cost).toContain('1 Opus call')
    // The API refuses with the same words. One composer, and they cannot drift.
    expect(launchBlockedBecause(store, READY, ep01, demoStage())).toBe(episode.launch.blockedBecause)
  })
})

describe('the operating page — one run, and the gate it parks on', () => {
  it('renders the artifact itself, not a filename, with both verdicts and their costs', async () => {
    const written = 'Three weeks after the harbourmaster took the spare, the water plant gives out.'
    llm.reply(written)
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    const view = runView(store, paths, run.id)!
    expect(view.sentence).toContain('demo on ep02 — waiting on your ruling')
    expect(view.steps.map((step) => [step.name, step.status])).toEqual([
      ['write-the-demo-premise', 'paused'],
      ['tally-the-demo-spend', 'pending'],
    ])

    // D15 / 4.6: the gate renders its artifact. The text is here, off the volume.
    const gate = view.gate!
    expect(gate).toMatchObject({ subject: 'the ep02 premise-brief demo', round: 1, isOpen: true })
    expect(gate.artifact).toMatchObject({ kind: 'premise-brief', slot: 'demo', version: 1 })
    expect(gate.artifact.text).toBe(`${written}\n`)
    expect(gate.artifact.note).toBeNull()

    // Both verdicts, both stating their own cost. A rejection buys another call and the
    // button that asks for it says so before it is pressed.
    expect(gate.approve.sentence).toBe(
      'Approve the ep02 premise-brief demo — round 1, and write-the-demo-premise carries the run on',
    )
    expect(gate.approve.cost).toBe('No model call · $0.00')
    expect(gate.reject.sentence).toContain('reopens as round 2')
    expect(gate.reject.cost).toContain('1 Opus call')
    expect([gate.approve.enabled, gate.reject.enabled]).toEqual([true, true])

    // And what it has cost so far, off the ledger rather than off a counter.
    expect(view.spend.sentence).toMatch(/^1 call · \$\d+\.\d\d$/)
    expect(view.spend.entries).toHaveLength(1)
    expect(view.spend.entries[0]).toMatchObject({ kind: 'llm', priced: 'rate-card' })
  })

  it('closes both verdicts once the round is ruled, and says why', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that reads.' })
    await runner.settled(run.id)

    const view = runView(store, paths, run.id)!
    expect(view.run.status).toBe('done')
    expect(view.sentence).toBe('demo on ep02 — finished')
    expect(view.gate!.isOpen).toBe(false)
    expect(view.gate!.approve.enabled).toBe(false)
    expect(view.gate!.approve.blockedBecause).toContain('already ruled "approve"')
    expect(view.gate!.reject.blockedBecause).toContain('A later opinion is a later round.')

    // The artifact is still rendered after the ruling — the round history is readable.
    expect(view.gate!.artifact.text).toContain('The exchanger fails')
    expect(view.gate!.rounds[0]!.ruling).toMatchObject({ verdict: 'approve', comment: 'that reads.' })
  })

  it('is undefined for a run that does not exist', () => {
    expect(runView(store, paths, 'run_nope')).toBeUndefined()
  })
})
