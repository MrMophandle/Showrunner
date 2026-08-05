import { tokenUsage, type TokenUsage } from '../cost.ts'
import {
  chargeFailedLLMCall,
  chargeLLMCall,
  modelOf,
  sentenceChunker,
  type CallSite,
  type LLMAdapter,
  type LLMCompletion,
  type LLMRequest,
} from './adapter.ts'

/**
 * The fake backend — **the test path, and the only one**. No test in this repo may reach
 * the network or spend a cent (fixtures before features); the two real backends are
 * exercised by `scripts/smoke-llm.ts`, by hand, by Ryan.
 *
 * It is a fake rather than a stub: it streams through the same chunker, charges through
 * the same `chargeLLMCall`, and is priced by the same table, so a test that watches the
 * ledger is watching production's arithmetic run on scripted numbers. What it cannot
 * prove is that the numbers it is fed are the ones the API reports — that is what
 * `anthropic.test.ts` (real usage shapes, stub client) and the smoke script are for.
 */

export interface FakeReply {
  text?: string
  model?: string
  /** What the call "used". Omitted fields are zero, so a test states only what it means. */
  usage?: Partial<TokenUsage>
  /** Dollars the backend claims for itself, as the `claude` CLI does. */
  reportedMicroDollars?: number
  stopReason?: string
  /** Say nothing and fail instead — how a step's retry budget gets exercised. */
  fails?: string
  /** Report no tokens at all, as a CLI too old to say would. */
  usageUnknown?: boolean
}

export interface FakeLLM extends LLMAdapter {
  /** Every request made, in order, so a test can assert what a step actually asked for. */
  readonly calls: LLMRequest[]
  /** Queues one more answer. */
  reply(reply: FakeReply | string): void
}

/** A middling call, so a test that cares about rollups rather than tokens can say nothing. */
const DEFAULT_USAGE: Partial<TokenUsage> = { uncachedInput: 1000, output: 500 }

/** Deltas arrive in dribs; this is how big a drib is, so the chunker has work to do. */
const DELTA = 11

export function createFakeLLM(script: (FakeReply | string)[] = []): FakeLLM {
  const queue: FakeReply[] = script.map(normalise)
  const calls: LLMRequest[] = []

  return {
    // It answers to a real backend id rather than a third one called 'fake'. `LLMBackend`
    // is the two backends D6 ruled, and production code switches on it — a 'fake' member
    // would be a fake that typechecks its way into the live ledger.
    backend: 'anthropic-api',
    calls,

    reply(reply: FakeReply | string): void {
      queue.push(normalise(reply))
    },

    async complete(request: LLMRequest, site: CallSite): Promise<LLMCompletion> {
      calls.push(request)
      const next = queue.shift()
      if (!next) {
        throw new Error(
          `the fake LLM was asked for answer ${calls.length} and only ${calls.length - 1} were ` +
            'queued — script it, or the test is asserting on something nobody wrote',
        )
      }

      const model = next.model ?? modelOf(request)
      const usage = next.usageUnknown ? undefined : tokenUsage({ ...DEFAULT_USAGE, ...next.usage })

      if (next.fails !== undefined) {
        chargeFailedLLMCall(
          site,
          { backend: 'anthropic-api', model, usage, reportedMicroDollars: next.reportedMicroDollars },
          next.fails,
        )
      }

      // Through the real chunker, in real dribs: a step that streams is being tested for
      // streaming, and a fake that handed over the whole answer at once would prove none
      // of it. `await` between pieces so the event loop turns, exactly as it does when
      // the pieces are arriving over a socket — and no timers, so no sleeping in tests.
      const text = next.text ?? ''
      const chunker = sentenceChunker((piece) => site.chunk(piece))
      for (let at = 0; at < text.length; at += DELTA) {
        chunker.push(text.slice(at, at + DELTA))
        await Promise.resolve()
      }
      chunker.flush()

      return chargeLLMCall(site, {
        backend: 'anthropic-api',
        model,
        text,
        usage,
        reportedMicroDollars: next.reportedMicroDollars,
        stopReason: next.stopReason,
      })
    },
  }
}

const normalise = (reply: FakeReply | string): FakeReply =>
  typeof reply === 'string' ? { text: reply } : reply
