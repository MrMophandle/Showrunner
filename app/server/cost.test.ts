import { beforeEach, describe, expect, it } from 'vitest'
import {
  costOfEpisode,
  costOfRun,
  costOfShow,
  costOfStep,
  costsOfRun,
  MODEL_PRICE,
  money,
  priceLLMCall,
  projectLLMCost,
  promptTokens,
  recordCost,
  remainingThisWeek,
  setShowBudget,
  showBudget,
  tokenUsage,
  weekStart,
} from './cost.ts'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'
import { createEpisode, createSeason, createShow } from './domain/spine.ts'
import { findStepByName, recordRun } from './runner/run.ts'

/**
 * The cost ledger: the arithmetic, the four rollups, the budget, and the projection.
 *
 * The arithmetic is the point of this file. A fake adapter will happily confirm whatever
 * pricing was written, so the numbers below are computed by hand from the published rates
 * in the comments rather than from the code under test — if this file ever starts
 * agreeing with cost.ts by construction, it has stopped proving anything.
 */

const OPUS = 'claude-opus-5'

let store: Store
let showId: string
let episodeId: string
let runId: string
let stepId: string
let otherEpisodeId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  showId = show.id
  const season = createSeason(store, { showId, number: 1 })
  episodeId = createEpisode(store, { seasonId: season.id, number: 7, title: 'Salt' }).id
  otherEpisodeId = createEpisode(store, { seasonId: season.id, number: 8, title: 'Slack Water' }).id

  const stage = { name: 'write', steps: [{ name: 'outline', execute: async () => undefined }] }
  runId = recordRun(store, stage, episodeId).id
  stepId = findStepByName(store, runId, 'outline')!.id
})

describe('the cost ledger — what a call costs', () => {
  it('prices the three input parts at their three different rates', () => {
    // Opus 5, from the dated table in cost.ts: $5.00 per million in, $25.00 per million
    // out; a cache write is 1.25x the input rate and a cache read is 0.1x.
    const usage = tokenUsage({
      uncachedInput: 1000,
      cacheWrite5m: 2000,
      cacheRead: 8000,
      output: 500,
    })

    //   1,000 uncached x $5.00        =  5,000 micro-dollars
    //   2,000 written  x $5.00 x 1.25 = 12,500
    //   8,000 read     x $5.00 x 0.10 =  4,000
    //     500 out      x $25.00       = 12,500
    //                                   ──────
    //                                   34,000 micro-dollars = $0.034
    expect(priceLLMCall(OPUS, usage)).toBe(34_000)
  })

  it('would report half of that if it believed usage.input_tokens was the input', () => {
    // The whole reason the columns are named the way they are. This is the same call as
    // above: the prompt was ELEVEN THOUSAND tokens, and `usage.input_tokens` — the field
    // that reads like "the input" — said one thousand of them.
    const usage = tokenUsage({
      uncachedInput: 1000,
      cacheWrite5m: 2000,
      cacheRead: 8000,
      output: 500,
    })
    expect(promptTokens(usage)).toBe(11_000)
    expect(usage.uncachedInput).toBe(1_000)

    const price = MODEL_PRICE[OPUS]!
    const naive = usage.uncachedInput * price.inputPerMillion + usage.output * price.outputPerMillion
    expect(naive).toBe(17_500)

    // 17,500 against a true 34,000 — the naive ledger under-reports this call by 49%, and
    // nothing in the API response ever says so. It only shows up on the invoice.
    expect(naive).toBeLessThan(priceLLMCall(OPUS, usage)! * 0.52)
  })

  it('prices a one-hour cache write at 2x, which is a different number from 1.25x', () => {
    // 1,000 x $5.00 x 2 = 10,000, where the five-minute TTL would have been 6,250.
    expect(priceLLMCall(OPUS, tokenUsage({ cacheWrite1h: 1000 }))).toBe(10_000)
    expect(priceLLMCall(OPUS, tokenUsage({ cacheWrite5m: 1000 }))).toBe(6_250)
  })

  it('counts thinking as what it is billed as — output', () => {
    // There is no thinking rate. `usage.output_tokens` already includes it, so a call
    // that thought hard is simply a call with a lot of output.
    expect(priceLLMCall(OPUS, tokenUsage({ output: 40_000 }))).toBe(1_000_000) // $1.00
  })

  it('says it cannot price a model it has never heard of, rather than guessing', () => {
    expect(priceLLMCall('claude-opus-9', tokenUsage({ output: 1000 }))).toBeUndefined()
  })
})

describe('the cost ledger — the four levels', () => {
  it('derives run, episode, and show from the step the caller named', () => {
    const entry = recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 34_000,
      priced: 'rate-card',
      usage: tokenUsage({ uncachedInput: 1000, output: 500 }),
      stepId,
      attempt: 1,
    })

    // The caller knew one id. All four levels agree because only one place fills them in.
    expect(entry.stepId).toBe(stepId)
    expect(entry.runId).toBe(runId)
    expect(entry.episodeId).toBe(episodeId)
    expect(entry.showId).toBe(showId)
    expect(entry.dollars).toBeCloseTo(0.034, 6)
  })

  it('refuses a cost that belongs to no show, because a budget could never see it', () => {
    expect(() =>
      recordCost(store, {
        kind: 'llm',
        backend: 'anthropic-api',
        model: OPUS,
        microDollars: 1,
        priced: 'rate-card',
      }),
    ).toThrow(/must name the show/)
  })

  it('rolls the same spend up to step, run, episode, and show', () => {
    const write = (microDollars: number, episode: string, on: string | undefined) =>
      recordCost(store, {
        kind: 'llm',
        backend: 'anthropic-api',
        model: OPUS,
        microDollars,
        priced: 'rate-card',
        usage: tokenUsage({ uncachedInput: 1000, cacheRead: 4000, output: 200 }),
        ...(on ? { stepId: on } : { episodeId: episode }),
      })

    write(34_000, episodeId, stepId)
    write(16_000, episodeId, stepId)
    // Same episode, no step: an ad-hoc call, or E4's canon sweep.
    write(5_000, episodeId, undefined)
    // A different episode of the same show — in the show total, in nothing narrower.
    write(100_000, otherEpisodeId, undefined)

    expect(costOfStep(store, stepId).microDollars).toBe(50_000)
    expect(costOfRun(store, runId).microDollars).toBe(50_000)
    expect(costOfEpisode(store, episodeId).microDollars).toBe(55_000)
    expect(costOfShow(store, showId).microDollars).toBe(155_000)

    // And the tokens roll up the same way, all three input parts kept apart.
    const episode = costOfEpisode(store, episodeId)
    expect(episode.calls).toBe(3)
    expect(episode.uncachedInputTokens).toBe(3_000)
    expect(episode.cacheReadTokens).toBe(12_000)
    expect(episode.outputTokens).toBe(600)
    expect(episode.promptTokens).toBe(15_000) // not 3,000
  })

  it('rolls a token-less image call up beside the LLM rows', () => {
    // D20's cloud backend costs dollars and produces no tokens at all. E6 writes this row
    // through this same function; nothing about the rollups changes, which is the whole
    // reason the ledger lands in E1 instead of E6.
    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 34_000,
      priced: 'rate-card',
      usage: tokenUsage({ uncachedInput: 1000, output: 500 }),
      stepId,
    })
    const shot = recordCost(store, {
      kind: 'image',
      backend: 'nano-banana-pro',
      model: 'gemini-3-pro-image',
      microDollars: 134_000, // $0.134 a frame
      priced: 'reported',
      stepId,
    })

    expect(shot.usage).toBeUndefined()

    for (const totals of [
      costOfStep(store, stepId),
      costOfRun(store, runId),
      costOfEpisode(store, episodeId),
      costOfShow(store, showId),
    ]) {
      expect(totals.calls).toBe(2)
      expect(totals.microDollars).toBe(168_000) // $0.168 — the image is money like any other
      expect(totals.tokenlessCalls).toBe(1)
      // The image contributed no tokens, and did not corrupt the token totals by counting
      // as a zero either — it is simply absent from them.
      expect(totals.outputTokens).toBe(500)
      expect(totals.promptTokens).toBe(1_000)
    }
  })

  it('keeps a call that failed after the prompt was billed', () => {
    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 60_000,
      priced: 'rate-card',
      outcome: 'failed',
      usage: tokenUsage({ uncachedInput: 12_000, output: 0 }),
      stepId,
      attempt: 2,
    })

    const totals = costOfStep(store, stepId)
    expect(totals.calls).toBe(1)
    expect(totals.failedCalls).toBe(1)
    expect(totals.microDollars).toBe(60_000) // it still spent
  })

  it('counts what nobody could price, instead of calling it zero', () => {
    recordCost(store, {
      kind: 'llm',
      backend: 'claude-cli',
      model: OPUS,
      microDollars: 34_000,
      priced: 'rate-card',
      usage: tokenUsage({ uncachedInput: 1000, output: 500 }),
      stepId,
    })
    recordCost(store, {
      kind: 'llm',
      backend: 'claude-cli',
      model: OPUS,
      microDollars: 0,
      priced: 'unpriced',
      stepId,
    })

    const totals = costOfStep(store, stepId)
    expect(totals.microDollars).toBe(34_000)
    expect(totals.unpricedCalls).toBe(1)
    // $0.034 is therefore a floor, and everything that renders it has to say so.
    expect(remainingThisWeek(store, showId).sentence).toMatch(/at least/)
  })

  it('itemises a run in the order the money was spent', () => {
    recordCost(store, { kind: 'llm', backend: 'claude-cli', model: OPUS, microDollars: 1, priced: 'rate-card', stepId })
    recordCost(store, { kind: 'image', backend: 'z-image-turbo', model: 'z-image-turbo', microDollars: 2, priced: 'reported', stepId })

    expect(costsOfRun(store, runId).map((entry) => entry.kind)).toEqual(['llm', 'image'])
  })
})

describe('the cost ledger — append-only', () => {
  it('refuses an UPDATE and a DELETE, in the database itself', () => {
    const entry = recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 34_000,
      priced: 'rate-card',
      stepId,
    })

    expect(() => store.run('UPDATE cost_entry SET micro_dollars = 0 WHERE seq = ?', entry.seq))
      .toThrow(/append-only/)
    expect(() => store.run('DELETE FROM cost_entry')).toThrow(/append-only/)
    expect(costOfStep(store, stepId).microDollars).toBe(34_000)
  })

  it('refuses to delete an episode that has spend against it', () => {
    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 34_000,
      priced: 'rate-card',
      stepId,
    })

    expect(() => store.run('DELETE FROM episode WHERE id = ?', episodeId)).toThrow(/FOREIGN KEY/i)
  })
})

describe('the cost ledger — the weekly budget', () => {
  it('measures from Monday, whatever day it is asked on', () => {
    // 2026-08-05 is a Wednesday; the Monday of its week is 2026-08-03.
    expect(weekStart(new Date('2026-08-05T16:15:00.000Z'))).toBe('2026-08-03T00:00:00.000Z')
    // Monday itself is its own week start, at midnight rather than now.
    expect(weekStart(new Date('2026-08-03T09:00:00.000Z'))).toBe('2026-08-03T00:00:00.000Z')
    // Sunday belongs to the week that began six days earlier, not the one starting tomorrow.
    expect(weekStart(new Date('2026-08-09T23:59:59.000Z'))).toBe('2026-08-03T00:00:00.000Z')
  })

  it('says what is left, in the words a screen renders', () => {
    setShowBudget(store, showId, 50)
    expect(showBudget(store, showId)!.weeklyDollars).toBe(50)

    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 12_400_000, // $12.40
      priced: 'rate-card',
      stepId,
    })

    const standing = remainingThisWeek(store, showId)
    expect(standing.spentDollars).toBeCloseTo(12.4, 6)
    expect(standing.remainingDollars).toBeCloseTo(37.6, 6)
    expect(standing.sentence).toBe("$37.60 left of this week's $50.00")
  })

  it('reports going over without clamping, because over-budget is a real state', () => {
    setShowBudget(store, showId, 10)
    recordCost(store, {
      kind: 'image',
      backend: 'nano-banana-pro',
      model: 'gemini-3-pro-image',
      microDollars: 17_400_000,
      priced: 'reported',
      stepId,
    })

    const standing = remainingThisWeek(store, showId)
    expect(standing.remainingDollars).toBeCloseTo(-7.4, 6)
    expect(standing.sentence).toBe("$7.40 over this week's $10.00")
  })

  it('counts only this week — last week is spent and gone', () => {
    setShowBudget(store, showId, 50)
    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 12_400_000,
      priced: 'rate-card',
      stepId,
    })

    // Asked a fortnight from now, everything above is in a previous week: the budget is
    // whole again. (Stated as a future `now` rather than a hand-dated row, so the test
    // writes its rows the same way production does.)
    const fortnight = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    const standing = remainingThisWeek(store, showId, fortnight)
    expect(standing.spentDollars).toBe(0)
    expect(standing.remainingDollars).toBe(50)
    expect(standing.weekStart).toBe(weekStart(fortnight))
  })

  it('offers no bar to fill when no budget is set, rather than a silent zero', () => {
    recordCost(store, {
      kind: 'llm',
      backend: 'anthropic-api',
      model: OPUS,
      microDollars: 12_400_000,
      priced: 'rate-card',
      stepId,
    })

    const standing = remainingThisWeek(store, showId)
    expect(standing.budgetDollars).toBeUndefined()
    expect(standing.remainingDollars).toBeUndefined()
    expect(standing.sentence).toBe('$12.40 spent since Monday — no weekly budget set')
  })

  it('replaces a budget rather than accumulating rows', () => {
    setShowBudget(store, showId, 50)
    setShowBudget(store, showId, 80)
    expect(showBudget(store, showId)!.weeklyDollars).toBe(80)
    expect(store.all('SELECT show_id FROM show_budget')).toHaveLength(1)
  })
})

describe('the cost ledger — what a button says before the click', () => {
  it('states the cost the way a button has to state it', () => {
    // 20,000 prompt x $5.00 = 100,000 micro-dollars; 30,000 out x $25.00 = 750,000.
    const projection = projectLLMCost({ promptTokens: 20_000, outputTokens: 30_000 })

    expect(projection.dollars).toBeCloseTo(0.85, 6)
    expect(projection.sentence).toBe('1 Opus call, ~$0.85')
  })

  it('multiplies by the number of calls, and pluralises like a sentence', () => {
    const projection = projectLLMCost({ promptTokens: 20_000, outputTokens: 30_000, calls: 6 })
    expect(projection.sentence).toBe('6 Opus calls, ~$5.10')
  })

  it('applies the cache discount when the caller expects one', () => {
    // Of a 20,000-token prompt, 16,000 is canon that will come back from cache at 0.1x:
    // 4,000 x $5 + 16,000 x $0.50 + 30,000 x $25 = 20,000 + 8,000 + 750,000 = 778,000.
    const projection = projectLLMCost({
      promptTokens: 20_000,
      cachedPromptTokens: 16_000,
      outputTokens: 30_000,
    })
    expect(projection.microDollars).toBe(778_000)
    expect(projection.sentence).toBe('1 Opus call, ~$0.78')
  })

  it('admits it cannot price a model rather than putting ~$0.00 on a button', () => {
    const projection = projectLLMCost({ model: 'claude-opus-9', promptTokens: 1000, outputTokens: 1000 })
    expect(projection.priced).toBe('unpriced')
    expect(projection.sentence).toBe('1 claude-opus-9 call, cost unknown (claude-opus-9 is not in the price table)')
  })

  it('renders a real but tiny amount as tiny rather than as nothing', () => {
    expect(money(0)).toBe('$0.00')
    expect(money(1)).toBe('<$0.01')
    expect(money(4_999)).toBe('<$0.01')
    expect(money(5_000)).toBe('$0.01')
    expect(money(12_400_000)).toBe('$12.40')
  })
})
