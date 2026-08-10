import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FREE } from './cost.ts'
import type { Store } from './db/store.ts'
import { artifactsOf, recordArtifact } from './domain/artifact.ts'
import { recordCheckPass } from './domain/finding.ts'
import { EPISODE_LIFECYCLE, episodesOf, findEpisode, scenesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { launchBlockedBecause, operatingView, runView, stageForEpisode, stageOffer } from './operating.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { STAGE_WORK, type Stage } from './runner/step.ts'
import { SCRIPT_GATE_STAGE } from './runner/present-step.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './runner/write-step.ts'

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

/** The writing line's first stage, out of the catalogue — the refusal takes a stage, not a name. */
const premiseStage = (): Stage => stageCatalogue(paths)[PREMISE_STAGE]!

/** What a Dry Stores premise run costs the fake: the draft, then the panel it convenes. */
const WRITTEN = 'Three weeks after the harbourmaster took the spare, the water plant gives out.'

/**
 * The whole of one round, scripted. The fixture is LOADED and not founded here, so every
 * entity is still a candidate with no standing — the desk hands the writer nobody, the brief
 * declares no provenance, and the panel is the two craft reviewers a premise-brief is read by
 * (D13). That is a legal empty case and it is what makes this file's runs cheap.
 */
function queueThePremise(text: string = WRITTEN): void {
  llm.reply(text)
  llm.reply('{"findings": []}')
  llm.reply('{"findings": []}')
}

/**
 * An episode with material standing against it and no premise-brief — the only shape in
 * which D12's wall can stand in front of the premise stage, and a planted one because the
 * premise is the FIRST thing an episode has, so a real episode with material already has one.
 * E4-2's outline stage meets this shape for real.
 */
function plantAWalledEpisode(): void {
  const script = recordArtifact(store, {
    episodeId: ep02,
    kind: 'script',
    filePath: 'greyharbor/s01e02/script.md',
  })
  recordCheckPass(store, {
    checkKey: 'dual-presence',
    tier: 'deterministic',
    artifactId: script.id,
    findings: [
      {
        concern: 'Ilse Renn is in two places at one time. Scenes 5 and 6 share one clock.',
        severity: 'high',
        confidence: 'certain',
      },
    ],
  })
}

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
    const launch = operatingView(store, paths, READY).shows[0]!.episodes[1]!.launch

    expect(launch.enabled).toBe(true)
    expect(launch.blockedBecause).toBeNull()
    // Verb + object + scope, and never a generic verb.
    expect(launch.sentence).toBe(
      'Write the ep02 premise-brief from the writer’s desk and present it for your ruling — ' +
        '“Dry Stores”, one call, then up to 7 reviewers read it',
    )
    expect(launch.sentence).not.toMatch(/\b(Launch|Run|Go|Do|Start)\b/)
    // Cost, in the same arithmetic the ledger will use afterwards — the writing call, the
    // panel it will convene, and the bound on how many drafts it may spend.
    expect(launch.cost).toMatch(/^1 Opus call, ~\$\d+\.\d\d \+ up to 7 Opus calls, ~\$\d+\.\d\d/)
    expect(launch.cost).toContain('stops at 3 drafts')
    expect(launch.cost).toContain('your money, spent when you click')
  })

  it('says so, in words, when the episode already has the artifact it would write (D20)', () => {
    // ep01 is at `script` and carries the fixture's own hand-written one. A hand-made asset
    // always wins, and a stage with nothing to do says so before the click rather than after
    // it. The sentence points at a gate, and since E4-3 there is one to point at: `script-gate`
    // presents a written artifact for a ruling whether or not the run that wrote it still
    // exists (`present-step.ts`).
    const launch = operatingView(store, paths, READY).shows[0]!.episodes[0]!.launch

    expect(launch.enabled).toBe(false)
    expect(launch.blockedBecause).toBe(
      'ep01 already has a script — rule on it at its gate, or edit it directly (E4-5).',
    )
    // Stated even when it is blocked: what it would have cost is not a secret.
    expect(launch.cost).toContain('Opus call')
    // And the gate it names is reachable, free, and refused by nothing.
    const present = stageOffer(store, READY, ep01, stageCatalogue(paths)[SCRIPT_GATE_STAGE]!)
    expect(present.enabled).toBe(true)
    expect(present.sentence).toContain('Present the ep01 script v1 for your ruling')
    expect(present.cost).toBe(FREE)
  })

  /**
   * **The floor's stage map, completed** (E4-3, #62). E1 offered `demo` on every card and E4-1
   * offered the premise on every card; the honest offer is the stage the episode's lifecycle
   * names, and it could not be pointed there while the writing line had a hole in it.
   */
  it('offers the stage the episode’s lifecycle is at, for every stop of the writing line', () => {
    const episode = findEpisode(store, ep01)!

    expect(stageForEpisode({ ...episode, lifecycle: 'premise' })).toBe(PREMISE_STAGE)
    expect(stageForEpisode({ ...episode, lifecycle: 'outline' })).toBe(OUTLINE_STAGE)
    expect(stageForEpisode({ ...episode, lifecycle: 'script' })).toBe(SCRIPT_STAGE)
    // Past the writing line this build has no producer at all, and the card says what it CAN
    // do rather than naming a stage with no code behind it: the script, presented for a ruling.
    for (const lifecycle of ['assets', 'assembled', 'published'] as const) {
      expect(stageForEpisode({ ...episode, lifecycle })).toBe(SCRIPT_GATE_STAGE)
    }
    // Every stage it can name is one the catalogue really has — a card offering a stage this
    // build has no code for is a click that queues a run nothing will ever pick up.
    for (const lifecycle of EPISODE_LIFECYCLE) {
      expect(stageCatalogue(paths)[stageForEpisode({ ...episode, lifecycle })]).toBeDefined()
    }
  })

  it('carries that map onto the page, so ep01 and ep02 are offered different stages', () => {
    const [first, second] = operatingView(store, paths, READY).shows[0]!.episodes

    expect([first!.lifecycle, first!.launchStage]).toEqual(['script', SCRIPT_STAGE])
    expect([second!.lifecycle, second!.launchStage]).toEqual(['premise', PREMISE_STAGE])
  })

  it('is blocked, with the reason in words, when nothing can reach a model', () => {
    const launch = operatingView(store, paths, NOTHING).shows[0]!.episodes[1]!.launch

    expect(launch.enabled).toBe(false)
    expect(launch.blockedBecause).toContain('Nothing to call')
    expect(launch.blockedBecause).toContain('no `claude` executable on PATH')
    // Quoted whole, never re-cased — a variable name Ryan is being told to set must be
    // the name that exists.
    expect(launch.blockedBecause).toContain('Export ANTHROPIC_API_KEY')
    expect(launch.blockedBecause).not.toMatch(/aNTHROPIC/)
    // The cost is still stated: what it WOULD cost is not a secret because it is blocked.
    expect(launch.cost).toContain('Opus call')
  })

  it('is blocked while the episode already has a run, and says what that run is doing', async () => {
    queueThePremise()
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    const view = operatingView(store, paths, READY)
    const [first, second] = view.shows[0]!.episodes

    // ep02 is parked on a gate: one run per episode (D7).
    expect(second!.launch.enabled).toBe(false)
    expect(second!.launch.blockedBecause).toContain('already has a write-the-premise run')
    expect(second!.launch.blockedBecause).toContain('waiting on your ruling')
    expect(second!.launch.blockedBecause).toContain('One run per episode')
    expect(second!.run).toMatchObject({ stage: PREMISE_STAGE, status: 'paused' })
    expect(second!.run!.openGateId).toBe(openGates(store)[0]!.gate.id)

    // Cross-episode parallelism is the other half of the same ruling: whatever ep01's own
    // answer is, ep02's run is not part of it.
    expect(first!.run).toBeNull()
    expect(first!.launch.blockedBecause).not.toContain('One run per episode')
  })

  it('refuses an episode that is not in this library', () => {
    expect(launchBlockedBecause(store, READY, 'ep_nope', premiseStage())).toBe(
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
    plantAWalledEpisode()

    const catalogue = stageCatalogue(paths)
    // D12 refuses the next stage. The premise stage writes an artifact, so the wall is what
    // stands in front of it — on an episode where it still has something to write.
    expect(launchBlockedBecause(store, READY, ep02, catalogue[PREMISE_STAGE]!)).toContain(
      'ep02 is blocked',
    )
    // And it never refuses a reading. The wall's own sentence recommends re-running the free
    // checks; a wall that refused that button would be a dead end built out of its own advice.
    for (const stage of Object.values(catalogue).filter((one) => one.work === 'reads')) {
      expect(launchBlockedBecause(store, READY, ep02, stage) ?? '').not.toContain('is blocked')
    }
  })

  /**
   * The order of the refusals, where it is load-bearing (operating.ts). ep01 has both a
   * standing deterministic finding and a premise-brief already, and what the button says is
   * the stage's own precondition: a stage with nothing to do has nothing to be blocked from
   * doing, and telling Ryan about a wall in front of work that does not exist would send him
   * to fix something for no reason.
   */
  it('says a stage has nothing to do before it says the wall is up', () => {
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

    expect(launchBlockedBecause(store, READY, ep01, premiseStage())).toContain(
      'already has a premise-brief',
    )
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
    plantAWalledEpisode()

    const episode = operatingView(store, paths, READY).shows[0]!.episodes[1]!
    expect(episode.launch.enabled).toBe(false)
    expect(episode.launch.blockedBecause).toContain('ep02 is blocked')
    expect(episode.launch.blockedBecause).toContain('dual-presence')
    expect(episode.launch.blockedBecause).toContain('Ilse Renn is in two places at one time.')
    // Stated even when it is blocked: what it would have cost is not a secret.
    expect(episode.launch.cost).toContain('Opus call')
    // The API refuses with the same words. One composer, and they cannot drift.
    expect(launchBlockedBecause(store, READY, ep02, premiseStage())).toBe(
      episode.launch.blockedBecause,
    )
  })
})

describe('the operating page — one run, and the gate it parks on', () => {
  it('renders the artifact itself, not a filename, with both verdicts and their costs', async () => {
    queueThePremise()
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    const view = runView(store, paths, run.id)!
    expect(view.sentence).toContain('write-the-premise on ep02 — waiting on your ruling')
    expect(view.steps.map((step) => [step.name, step.status])).toEqual([
      ['write-the-premise-brief', 'paused'],
      ['advance-past-the-premise-gate', 'pending'],
    ])

    // D15 / 4.6: the gate renders its artifact. The text is here, off the volume.
    const gate = view.gate!
    expect(gate).toMatchObject({ subject: 'the ep02 premise-brief', round: 1, isOpen: true })
    expect(gate.artifact).toMatchObject({ kind: 'premise-brief', slot: '', version: 1 })
    expect(gate.artifact.text).toBe(`${WRITTEN}\n`)
    expect(gate.artifact.note).toBeNull()

    // Both verdicts, both stating their own cost. A rejection buys another draft and another
    // reading, and the button that asks for it says so before it is pressed.
    expect(gate.approve.sentence).toBe(
      'Approve the ep02 premise-brief — round 1, and write-the-premise-brief carries the run on',
    )
    expect(gate.approve.cost).toBe('No model call · $0.00')
    expect(gate.reject.sentence).toContain('reopens as round 2')
    expect(gate.reject.sentence).toContain('writes it again against them')
    expect(gate.reject.cost).toContain('Opus call')
    expect([gate.approve.enabled, gate.reject.enabled]).toEqual([true, true])

    // And what it has cost so far, off the ledger rather than off a counter: the draft, and
    // the two craft reviewers that read it.
    expect(view.spend.sentence).toMatch(/^3 calls · \$\d+\.\d\d$/)
    expect(view.spend.entries).toHaveLength(3)
    expect(view.spend.entries[0]).toMatchObject({ kind: 'llm', priced: 'rate-card' })
  })

  it('closes both verdicts once the round is ruled, and says why', async () => {
    queueThePremise()
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that reads.' })
    await runner.settled(run.id)

    const view = runView(store, paths, run.id)!
    expect(view.run.status).toBe('done')
    expect(view.sentence).toBe('write-the-premise on ep02 — finished')
    expect(view.gate!.isOpen).toBe(false)
    expect(view.gate!.approve.enabled).toBe(false)
    expect(view.gate!.approve.blockedBecause).toContain('already ruled "approve"')
    expect(view.gate!.reject.blockedBecause).toContain('A later opinion is a later round.')

    // The artifact is still rendered after the ruling — the round history is readable.
    expect(view.gate!.artifact.text).toContain('the water plant gives out')
    expect(view.gate!.rounds[0]!.ruling).toMatchObject({ verdict: 'approve', comment: 'that reads.' })
  })

  it('is undefined for a run that does not exist', () => {
    expect(runView(store, paths, 'run_nope')).toBeUndefined()
  })
})
