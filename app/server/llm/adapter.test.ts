import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { costOfStep, tokenUsage } from '../cost.ts'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { findStepByName, recordRun } from '../runner/run.ts'
import {
  bindLLM,
  chargeFailedLLMCall,
  chargeLLMCall,
  lazyLLM,
  scrubSecrets,
  sentenceChunker,
  type CallSite,
  type LLMAdapter,
} from './adapter.ts'
import { scaffoldStage } from '../runner/stage-fixture.ts'

/**
 * The machinery every backend shares: the sentence coalescer that feeds `chunk`, the
 * scrubber that stands between an error and the append-only log, and the one function
 * that turns a finished call into money.
 */

const OPUS = 'claude-opus-5'

let store: Store
let site: CallSite
let streamed: string[]
let stepId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  const episodeId = createEpisode(store, { seasonId: season.id, number: 7, title: 'Salt' }).id
  const runId = recordRun(
    store,
    scaffoldStage('write', [{ name: 'outline', execute: async () => undefined }]),
    episodeId,
  ).id
  stepId = findStepByName(store, runId, 'outline')!.id

  streamed = []
  site = { store, stepId, runId, episodeId, attempt: 1, chunk: (text) => streamed.push(text) }
})

describe('the adapter — coalescing deltas into sentences', () => {
  const collect = (deltas: string[], ceiling?: number): string[] => {
    const pieces: string[] = []
    const chunker = sentenceChunker((piece) => pieces.push(piece), ceiling)
    for (const delta of deltas) chunker.push(delta)
    chunker.flush()
    return pieces
  }

  it('emits a sentence when the sentence is finished, not when a token arrives', () => {
    // Deltas arrive a few characters at a time. One event log row per token would be a
    // hundred thousand rows per script and an unreadable smear on screen.
    expect(collect(['The dock ', 'lights ', 'fail. ', 'Ferro ', 'runs.'])).toEqual([
      'The dock lights fail.',
      'Ferro runs.',
    ])
  })

  it('waits when a terminator lands at the very end of the buffer', () => {
    // "Mr" is not a sentence, and neither is a full stop nobody has followed yet.
    const pieces: string[] = []
    const chunker = sentenceChunker((piece) => pieces.push(piece))
    chunker.push('Ferro waits.')
    expect(pieces).toEqual([])
    chunker.push(' Nothing moves.')
    expect(pieces).toEqual(['Ferro waits.'])
  })

  it('treats a line break as an end, because scripts are mostly line breaks', () => {
    expect(collect(['INT. HOLD — NIGHT\n', 'Ferro is alone'])).toEqual([
      'INT. HOLD — NIGHT',
      'Ferro is alone',
    ])
  })

  it('ships anyway once the line is long enough that nothing is streaming', () => {
    const wall = 'x'.repeat(300)
    expect(collect([wall], 240)).toEqual([wall])
  })

  it('emits nothing at all for whitespace', () => {
    expect(collect(['   ', '\n\n'])).toEqual([])
  })
})

describe('the adapter — secrets are a one-way door', () => {
  const KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF'

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY']
  })

  it('redacts anything key-shaped out of a message bound for the log', () => {
    // Nothing can delete an event once written (0003). A key that reaches the log is in
    // the library file forever, so it never gets there.
    expect(scrubSecrets(`401 from the API using ${KEY}`)).toBe('401 from the API using [redacted]')
    expect(scrubSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe(
      'Authorization: [redacted]',
    )
    expect(scrubSecrets('x-api-key: 0123456789abcdef')).toBe('x-api-key: [redacted]')
  })

  it('redacts the value this process is actually holding, whatever shape it is', () => {
    // The patterns catch keys nobody predicted; this catches the one we know.
    process.env['ANTHROPIC_API_KEY'] = 'not-key-shaped-at-all-9f2c1a4b'
    expect(scrubSecrets('failed with not-key-shaped-at-all-9f2c1a4b in the header')).toBe(
      'failed with [redacted] in the header',
    )
  })

  it('leaves ordinary prose alone', () => {
    const line = 'the ep07 outline stops mid-scene — the model hit max_tokens'
    expect(scrubSecrets(line)).toBe(line)
  })

  it('scrubs what it streams, not just what it throws', () => {
    const pieces: string[] = []
    const chunker = sentenceChunker((piece) => pieces.push(piece))
    chunker.push(`the key is ${KEY} apparently. `)
    chunker.flush()
    expect(pieces).toEqual(['the key is [redacted] apparently.'])
  })
})

describe('the adapter — one call becomes one row', () => {
  it('prices from the rate card when the backend only reports tokens', () => {
    const completion = chargeLLMCall(site, {
      backend: 'anthropic-api',
      model: OPUS,
      text: 'the outline',
      usage: tokenUsage({ uncachedInput: 1000, cacheRead: 8000, output: 500 }),
    })

    // 1,000 x $5 + 8,000 x $0.50 + 500 x $25 = 5,000 + 4,000 + 12,500
    expect(completion.microDollars).toBe(21_500)
    expect(completion.priced).toBe('rate-card')
    expect(completion.cost.stepId).toBe(stepId)
    expect(costOfStep(store, stepId).microDollars).toBe(21_500)
  })

  it("takes the backend's own number over the rate card when it states one", () => {
    // The `claude` CLI reports dollars. Its number is nearer the invoice than ours — it
    // knows about tiers and surcharges this app's price table has never heard of.
    const completion = chargeLLMCall(site, {
      backend: 'claude-cli',
      model: OPUS,
      text: 'the outline',
      usage: tokenUsage({ uncachedInput: 1000, output: 500 }),
      reportedMicroDollars: 99_000,
    })

    expect(completion.microDollars).toBe(99_000)
    expect(completion.priced).toBe('reported')
    // The tokens are still recorded — they are the audit, the dollars are the bill.
    expect(costOfStep(store, stepId).outputTokens).toBe(500)
  })

  it('does not let a reported zero hide tokens that plainly cost something', () => {
    // A backend that says "$0.00" beside eleven thousand tokens has not priced the call,
    // it has failed to. Taking that literally would show a week of CLI work as free.
    const completion = chargeLLMCall(site, {
      backend: 'claude-cli',
      model: OPUS,
      text: 'the outline',
      usage: tokenUsage({ uncachedInput: 1000, output: 500 }),
      reportedMicroDollars: 0,
    })

    expect(completion.microDollars).toBe(17_500) // 1,000 x $5 + 500 x $25
    expect(completion.priced).toBe('rate-card') // and the row says where that came from
  })

  it('accepts a reported zero when there is nothing to contradict it', () => {
    const completion = chargeLLMCall(site, {
      backend: 'claude-cli',
      model: OPUS,
      text: '',
      usage: undefined,
      reportedMicroDollars: 0,
    })

    expect(completion.priced).toBe('reported')
    expect(completion.microDollars).toBe(0)
  })

  it('admits a gap when nobody could say what it cost', () => {
    const completion = chargeLLMCall(site, {
      backend: 'claude-cli',
      model: OPUS,
      text: 'the outline',
      usage: undefined,
    })

    expect(completion.priced).toBe('unpriced')
    expect(completion.microDollars).toBe(0)
    expect(costOfStep(store, stepId).unpricedCalls).toBe(1)
  })

  it('records what a dead call burned, then throws a scrubbed error', () => {
    // The prompt is billed the moment the model starts. Three of these is what a spent
    // retry budget looks like on the invoice, and a ledger that only counted successes
    // would show none of it.
    expect(() =>
      chargeFailedLLMCall(
        site,
        {
          backend: 'anthropic-api',
          model: OPUS,
          usage: tokenUsage({ uncachedInput: 12_000 }),
        },
        'the stream died using sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
      ),
    ).toThrow('the stream died using [redacted]')

    const totals = costOfStep(store, stepId)
    expect(totals.calls).toBe(1)
    expect(totals.failedCalls).toBe(1)
    expect(totals.microDollars).toBe(60_000) // 12,000 x $5
  })

  it('records nothing for a call that never got as far as costing anything', () => {
    expect(() =>
      chargeFailedLLMCall(site, { backend: 'anthropic-api', model: OPUS, usage: undefined }, 'ENOTFOUND'),
    ).toThrow('ENOTFOUND')

    // A row of zeroes here would be a lie about a call that never happened.
    expect(costOfStep(store, stepId).calls).toBe(0)
  })
})

describe('the adapter — binding and laziness', () => {
  it('hands a step an adapter that already knows where to stream and what to charge', async () => {
    const adapter: LLMAdapter = {
      backend: 'anthropic-api',
      async complete(request, given) {
        given.chunk(request.prompt)
        return chargeLLMCall(given, {
          backend: 'anthropic-api',
          model: OPUS,
          text: 'done',
          usage: tokenUsage({ output: 400 }),
        })
      },
    }

    await bindLLM(adapter, site).complete({ prompt: 'write the ep07 outline' })

    expect(streamed).toEqual(['write the ep07 outline'])
    expect(costOfStep(store, stepId).microDollars).toBe(10_000)
  })

  it('does not build a backend until something asks it for a call', () => {
    let built = 0
    const lazy = lazyLLM('claude-cli', () => {
      built += 1
      return { backend: 'claude-cli', complete: async () => { throw new Error('unused') } }
    })

    // Every runner in every test constructs one of these. None of them may reach for a
    // credential, or open a socket, on the way.
    expect(built).toBe(0)
    expect(lazy.backend).toBe('claude-cli')
  })
})
