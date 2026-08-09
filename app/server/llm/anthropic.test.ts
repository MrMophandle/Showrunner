import type Anthropic from '@anthropic-ai/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { costOfStep } from '../cost.ts'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { findStepByName, recordRun } from '../runner/run.ts'
import type { CallSite } from './adapter.ts'
import { createAnthropicAdapter } from './anthropic.ts'
import { scaffoldStage } from '../runner/stage-fixture.ts'

/**
 * The API backend's reading of `usage`, proved against objects typed as the SDK's own
 * `Anthropic.Usage` — so a field renamed or misremembered is a typecheck failure here
 * rather than a quiet halving of the bill in production.
 *
 * No network, no key, no money: the client is a stub. What a stub cannot prove is that
 * the API sends what these objects say it sends — that is `scripts/smoke-llm.ts`, run by
 * hand, against the real thing.
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

/**
 * A usage object as the API sends one, typed as the SDK types it. Every field the ledger
 * reads is named here, so a rename in the SDK breaks the build.
 */
function usage(some: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    output_tokens: 0,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    ...some,
  }
}

interface Script {
  events: unknown[]
  final?: unknown
  /** Thrown from the iterator, part-way through, as a dying stream does. */
  diesWith?: Error
}

let captured: Record<string, unknown> | undefined

/** The sliver of the client this backend touches. Cast, and openly so. */
function stubClient(script: Script): Anthropic {
  return {
    messages: {
      stream(params: Record<string, unknown>) {
        captured = params
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of script.events) yield event
            if (script.diesWith) throw script.diesWith
          },
          finalMessage: async () => {
            if (script.diesWith) throw script.diesWith
            return script.final
          },
        }
      },
    },
  } as unknown as Anthropic
}

const message = (text: string, used: Anthropic.Usage, stopReason = 'end_turn'): unknown => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: OPUS,
  content: [{ type: 'text', text, citations: null }],
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details: null,
  usage: used,
})

describe('the Anthropic backend — reading what a call used', () => {
  it('reads all three input counts, not the one that reads like "the input"', async () => {
    const used = usage({
      input_tokens: 1000, // the UNCACHED REMAINDER of an 11,000-token prompt
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 8000,
      output_tokens: 500,
    })
    const adapter = createAnthropicAdapter({ client: stubClient({ events: [], final: message('the outline', used) }) })

    const completion = await adapter.complete({ prompt: 'Write the ep07 outline.' }, site)

    expect(completion.usage).toEqual({
      uncachedInput: 1000,
      cacheWrite5m: 2000,
      cacheWrite1h: 0,
      cacheRead: 8000,
      output: 500,
    })
    // 5,000 + 12,500 + 4,000 + 12,500 — see cost.test.ts for the arithmetic in full.
    expect(completion.microDollars).toBe(34_000)
    expect(completion.priced).toBe('rate-card')
    expect(costOfStep(store, stepId).promptTokens).toBe(11_000)
  })

  it('prices the model that answered, not the one that was asked for', async () => {
    // A request can be served by another model. The bill follows what ran, so the row has
    // to as well — Haiku rates for a Haiku answer, even under an Opus request.
    const used = usage({ input_tokens: 1000, output_tokens: 1000 })
    const served = { ...(message('.', used) as Record<string, unknown>), model: 'claude-haiku-4-5' }
    const adapter = createAnthropicAdapter({ client: stubClient({ events: [], final: served }) })

    const completion = await adapter.complete({ model: OPUS, prompt: 'x' }, site)

    expect(completion.model).toBe('claude-haiku-4-5')
    expect(completion.microDollars).toBe(6_000) // 1,000 x $1 + 1,000 x $5, not $5 and $25
  })

  it('honours the 5m/1h breakdown when the response carries one', async () => {
    // The flat `cache_creation_input_tokens` cannot tell 1.25x from 2x. The breakdown can,
    // and when it is there it wins.
    const used = usage({
      input_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
      output_tokens: 0,
    })
    const adapter = createAnthropicAdapter({ client: stubClient({ events: [], final: message('.', used) }) })

    const completion = await adapter.complete({ prompt: 'x' }, site)

    expect(completion.usage?.cacheWrite1h).toBe(1000)
    expect(completion.microDollars).toBe(10_000) // 1,000 x $5 x 2, not x 1.25
  })

  it('streams text deltas out as sentences and still returns the final message', async () => {
    const used = usage({ input_tokens: 10, output_tokens: 20 })
    const adapter = createAnthropicAdapter({
      client: stubClient({
        events: [
          { type: 'message_start', message: { usage: used } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The dock lights ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fail. Ferro runs.' } },
        ],
        final: message('The dock lights fail. Ferro runs.', used),
      }),
    })

    const completion = await adapter.complete({ prompt: 'x' }, site)

    expect(streamed).toEqual(['The dock lights fail.', 'Ferro runs.'])
    // The returned text is the finished message, not the pieces glued back together.
    expect(completion.text).toBe('The dock lights fail. Ferro runs.')
  })

  it('says when the answer was cut off rather than passing a stump off as finished', async () => {
    const used = usage({ input_tokens: 10, output_tokens: 64_000 })
    const adapter = createAnthropicAdapter({
      client: stubClient({ events: [], final: message('The dock lights fai', used, 'max_tokens') }),
    })

    const completion = await adapter.complete({ prompt: 'x' }, site)

    expect(completion.stopReason).toBe('max_tokens')
    expect(completion.text).toBe('The dock lights fai')
  })

  it('bills what a dying stream had already spent, then throws', async () => {
    const started = usage({ input_tokens: 12_000, cache_read_input_tokens: 40_000 })
    const adapter = createAnthropicAdapter({
      client: stubClient({
        events: [
          { type: 'message_start', message: { usage: started } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The dock ' } },
          {
            type: 'message_delta',
            delta: { stop_reason: null },
            usage: { input_tokens: 12_000, cache_read_input_tokens: 40_000, output_tokens: 300, cache_creation_input_tokens: null },
          },
        ],
        diesWith: new Error('terminated'),
      }),
    })

    await expect(adapter.complete({ prompt: 'x' }, site)).rejects.toThrow('terminated')

    // The prompt was read and billed before the socket dropped. 12,000 x $5 + 40,000 x
    // $0.50 + 300 x $25 = 60,000 + 20,000 + 7,500.
    const totals = costOfStep(store, stepId)
    expect(totals.calls).toBe(1)
    expect(totals.failedCalls).toBe(1)
    expect(totals.microDollars).toBe(87_500)
    // And what it had already said is on the floor, not thrown away with the error.
    expect(streamed).toEqual(['The dock'])
  })

  it('treats a refusal as a failed call, not as an empty success — and bills it once', async () => {
    // A refusal is HTTP 200 with nothing in it. Code that reaches for content[0] finds a
    // hole; a step that returned it would file an empty artifact.
    //
    // The `message_start` matters: charging for the refusal throws, and if that throw
    // were inside the same `try` as the stream, the catch would charge the same call a
    // second time — one refusal, two rows, and a bill that disagrees with itself.
    const used = usage({ input_tokens: 900 })
    const adapter = createAnthropicAdapter({
      client: stubClient({
        events: [{ type: 'message_start', message: { usage: used } }],
        final: {
          ...(message('', used, 'refusal') as Record<string, unknown>),
          content: [],
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        },
      }),
    })

    await expect(adapter.complete({ prompt: 'x' }, site)).rejects.toThrow(/declined this request \(cyber\)/)
    const totals = costOfStep(store, stepId)
    expect(totals.calls).toBe(1)
    expect(totals.failedCalls).toBe(1)
    expect(totals.microDollars).toBe(4_500) // 900 x $5, once
  })
})

describe('the Anthropic backend — what it sends', () => {
  it('sends the prompt, the system, the effort, and no sampling parameters at all', async () => {
    const used = usage({ input_tokens: 1, output_tokens: 1 })
    const adapter = createAnthropicAdapter({ client: stubClient({ events: [], final: message('.', used) }) })

    await adapter.complete(
      { prompt: 'Write the ep07 outline.', system: 'You write Grey Harbor.', effort: 'high' },
      site,
    )

    expect(captured).toMatchObject({
      model: OPUS,
      max_tokens: 64_000,
      system: 'You write Grey Harbor.',
      messages: [{ role: 'user', content: 'Write the ep07 outline.' }],
      output_config: { effort: 'high' },
    })
    // temperature, top_p and top_k are removed on Opus 5 and return a 400; `thinking` is
    // adaptive by default there, so setting it is a way to get it wrong.
    expect(captured).not.toHaveProperty('temperature')
    expect(captured).not.toHaveProperty('top_p')
    expect(captured).not.toHaveProperty('top_k')
    expect(captured).not.toHaveProperty('thinking')
  })

  it('leaves system and effort out entirely when the step did not ask for them', async () => {
    const used = usage({ input_tokens: 1, output_tokens: 1 })
    const adapter = createAnthropicAdapter({ client: stubClient({ events: [], final: message('.', used) }) })

    await adapter.complete({ prompt: 'x' }, site)

    expect(captured).not.toHaveProperty('system')
    expect(captured).not.toHaveProperty('output_config')
  })
})
