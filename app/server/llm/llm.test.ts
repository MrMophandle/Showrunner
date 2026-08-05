import { beforeEach, describe, expect, it } from 'vitest'
import {
  costOfEpisode,
  costOfRun,
  costOfShow,
  costOfStep,
  recordCost,
  remainingThisWeek,
  setShowBudget,
} from '../cost.ts'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { findStepByName } from '../runner/run.ts'
import { createRunner } from '../runner/runner.ts'
import type { StageCatalogue } from '../runner/step.ts'
import { createFakeLLM, type FakeLLM } from './fake.ts'

/**
 * A step calling Claude, all the way through the runner — the shape E3 writes against.
 *
 * The fake backend is the only one allowed in `npm test`; the two real ones are exercised
 * by hand through `scripts/smoke-llm.ts`. What this file proves is the wiring: that a
 * step's output streams to the floor as it arrives, and that the money lands on all four
 * of 2.4's levels without the step doing anything to make it.
 */

const OUTLINE =
  'The dock lights fail at 04:12. Ferro is three decks down when the klaxon starts. ' +
  'Nobody answers the hail.'

let store: Store
let events: EventLog
let llm: FakeLLM
let showId: string
let episodeId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  events = createEventLog(store)
  llm = createFakeLLM()
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  showId = show.id
  const season = createSeason(store, { showId, number: 1 })
  episodeId = createEpisode(store, { seasonId: season.id, number: 7, title: 'Salt' }).id
})

/** A one-step stage that writes an outline. The narrowest thing E3 will do. */
const writeStage: StageCatalogue = {
  write: {
    name: 'write',
    steps: [
      {
        name: 'outline',
        async execute(context) {
          context.progress('Writing the ep07 outline')
          const completion = await context.llm.complete({
            system: 'You write Grey Harbor.',
            prompt: 'Write the ep07 outline.',
          })
          return { text: completion.text, dollars: completion.dollars }
        },
      },
    ],
  },
}

describe('a step calling Claude', () => {
  it('streams what the model says to the floor as it says it', async () => {
    llm.reply({ text: OUTLINE, usage: { uncachedInput: 12_000, cacheRead: 40_000, output: 900 } })
    const runner = createRunner(store, writeStage, events, llm)

    const run = runner.enqueueRun({ episodeId, stage: 'write' })
    await runner.settled(run.id)

    const chunks = eventsOfRun(store, run.id)
      .filter((event) => event.kind === 'step-chunk')
      .map((event) => event.summary)

    // Sentences, not tokens and not one lump: the fake pushes eleven characters at a time
    // and the coalescer is what makes these three rows out of them.
    expect(chunks).toEqual([
      'The dock lights fail at 04:12.',
      'Ferro is three decks down when the klaxon starts.',
      'Nobody answers the hail.',
    ])
    expect(chunks.join(' ')).toBe(OUTLINE)

    // And the step got the whole thing back, whatever the streaming did.
    const step = findStepByName(store, run.id, 'outline')!
    expect(step.status).toBe('done')
    expect((step.output as { text: string }).text).toBe(OUTLINE)
  })

  it('charges the call to its step, run, episode, and show without being asked', async () => {
    llm.reply({ text: OUTLINE, usage: { uncachedInput: 12_000, cacheRead: 40_000, output: 900 } })
    const runner = createRunner(store, writeStage, events, llm)

    const run = runner.enqueueRun({ episodeId, stage: 'write' })
    await runner.settled(run.id)

    //  12,000 uncached x $5.00        =  60,000 micro-dollars
    //  40,000 read     x $5.00 x 0.10 =  20,000
    //     900 out      x $25.00       =  22,500
    //                                   ───────
    //                                   102,500 micro-dollars = $0.1025
    const stepId = findStepByName(store, run.id, 'outline')!.id
    expect(costOfStep(store, stepId).microDollars).toBe(102_500)
    expect(costOfRun(store, run.id).microDollars).toBe(102_500)
    expect(costOfEpisode(store, episodeId).microDollars).toBe(102_500)
    expect(costOfShow(store, showId).microDollars).toBe(102_500)

    // The prompt was 52,000 tokens. The field named `input_tokens` said 12,000 of them.
    expect(costOfRun(store, run.id).promptTokens).toBe(52_000)
    expect(costOfRun(store, run.id).uncachedInputTokens).toBe(12_000)
  })

  it('rolls a token-less image call up beside it, on the same four levels', async () => {
    // E6's `ImageAdapter` is not this issue's to build; the row it will write is. This
    // step stands in for it — dollars, no tokens, same ledger, same rollups, no migration.
    const stages: StageCatalogue = {
      produce: {
        name: 'produce',
        steps: [
          writeStage['write']!.steps[0]!,
          {
            name: 'shot-images',
            lock: 'image-api',
            async execute(context) {
              context.progress('Shot 1 of 1 — scene 2, the corridor')
              recordCost(context.store, {
                kind: 'image',
                backend: 'nano-banana-pro',
                model: 'gemini-3-pro-image',
                microDollars: 134_000, // $0.134 a frame, reported by the API
                priced: 'reported',
                stepId: context.stepId,
                attempt: context.attempt,
              })
              return { shots: 1 }
            },
          },
        ],
      },
    }
    llm.reply({ text: OUTLINE, usage: { uncachedInput: 12_000, cacheRead: 40_000, output: 900 } })
    const runner = createRunner(store, stages, events, llm)

    const run = runner.enqueueRun({ episodeId, stage: 'produce' })
    await runner.settled(run.id)

    const totals = costOfRun(store, run.id)
    expect(totals.calls).toBe(2)
    expect(totals.microDollars).toBe(236_500) // $0.1025 of writing + $0.134 of picture
    expect(totals.tokenlessCalls).toBe(1)
    // The image did not disturb the token totals — it is absent from them, not zero in them.
    expect(totals.outputTokens).toBe(900)
    expect(costOfEpisode(store, episodeId).microDollars).toBe(236_500)
    expect(costOfShow(store, showId).microDollars).toBe(236_500)

    // And each step carries its own share, which is what the episode room itemises.
    expect(costOfStep(store, findStepByName(store, run.id, 'outline')!.id).microDollars).toBe(102_500)
    expect(costOfStep(store, findStepByName(store, run.id, 'shot-images')!.id).microDollars).toBe(134_000)
  })

  it('keeps what each spent attempt burned when a step fails its way to Ryan', async () => {
    // Invariant 5: one try plus two retries, then it reaches Ryan. Each of those three
    // sent a prompt, and a prompt is billed the moment the model starts reading it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      llm.reply({ fails: 'the stream died', usage: { uncachedInput: 12_000, output: 0 } })
    }
    const runner = createRunner(store, writeStage, events, llm)

    const run = runner.enqueueRun({ episodeId, stage: 'write' })
    const settled = await runner.settled(run.id)

    expect(settled.status).toBe('failed')
    const totals = costOfRun(store, run.id)
    expect(totals.calls).toBe(3)
    expect(totals.failedCalls).toBe(3)
    expect(totals.microDollars).toBe(180_000) // three prompts at $0.06 each, and nothing to show
    // Which is exactly the sort of thing a weekly budget exists to make visible.
    setShowBudget(store, showId, 50)
    expect(remainingThisWeek(store, showId).sentence).toBe("$49.82 left of this week's $50.00")
  })

  it('records the attempt each cost belongs to', async () => {
    llm.reply({ fails: 'the stream died', usage: { uncachedInput: 1000 } })
    llm.reply({ text: OUTLINE, usage: { uncachedInput: 1000, output: 100 } })
    const runner = createRunner(store, writeStage, events, llm)

    const run = runner.enqueueRun({ episodeId, stage: 'write' })
    await runner.settled(run.id)

    const attempts = store.all<{ attempt: number; outcome: string }>(
      'SELECT attempt, outcome FROM cost_entry ORDER BY seq',
    )
    expect(attempts).toEqual([
      { attempt: 1, outcome: 'failed' },
      { attempt: 2, outcome: 'ok' },
    ])
  })

  it('asks for exactly what the step said, and nothing the step did not', async () => {
    llm.reply({ text: OUTLINE })
    const runner = createRunner(store, writeStage, events, llm)

    await runner.settled(runner.enqueueRun({ episodeId, stage: 'write' }).id)

    expect(llm.calls).toEqual([
      { system: 'You write Grey Harbor.', prompt: 'Write the ep07 outline.' },
    ])
  })
})
