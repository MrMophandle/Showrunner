import {
  DEFAULT_MODEL,
  priceLLMCall,
  recordCost,
  type CostEntry,
  type CostOutcome,
  type CostPricing,
  type TokenUsage,
} from '../cost.ts'
import type { Store } from '../db/store.ts'

/**
 * One `LLMAdapter`, two backends (D6): the Anthropic API and the `claude` CLI. This file
 * is the interface they share, the streaming seam they stream through, and the single
 * place a finished call becomes a row in the cost ledger.
 *
 * ── Why the ledger lives in here ────────────────────────────────────────────────
 * `complete` charges for the call itself, before it returns. It is not the caller's job
 * to remember: a ledger that depends on every call site remembering to file a receipt is
 * a ledger that is quietly wrong within a month, and the failure is invisible until an
 * invoice disagrees. `chargeLLMCall` below is the only path, and every backend — the two
 * real ones and the fake — ends there.
 *
 * ── Retry lives in the runner, not here ─────────────────────────────────────────
 * The Anthropic SDK retries 429s and 5xxs twice by default. That is switched OFF
 * (`maxRetries: 0` in anthropic.ts), because invariant 5 bounds retries at two — three
 * attempts in all — and it means the runner's three, not the runner's three times the
 * SDK's three. One adapter call is one attempt; when it fails, the runner decides. The
 * consequence is deliberate: three quick rate-limit errors spend the step's budget and
 * reach Ryan with the attempt history, which is visible, rather than backing off silently
 * inside a library for a minute and a half. If backoff is ever wanted it belongs in the
 * runner, where it is one policy for every kind of step.
 *
 * ── Secrets and the append-only log ─────────────────────────────────────────────
 * Everything this file streams or throws can end up in the event log, which SQLite will
 * not let anyone delete from (0003). An API key in an error message is therefore
 * permanent. `scrubSecrets` runs over every chunk and every error message before either
 * leaves this module, prompts are never streamed or logged, and no raw request object
 * goes into an event's `detail`.
 */

/** The two ruled backends (D6). Ids are kebab-case, like lock names and image backends. */
export const LLM_BACKEND = ['anthropic-api', 'claude-cli'] as const
export type LLMBackend = (typeof LLM_BACKEND)[number]

/** How hard the model works, and what it spends doing it. */
export const LLM_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type LLMEffort = (typeof LLM_EFFORT)[number]

/**
 * What Showrunner asks Claude for. One system prompt, one user prompt, one answer — there
 * is no conversation here, no tool loop, and no message array, because every stage in
 * this app is a step that composes its own prompt and reads one artifact back. If a stage
 * ever needs a real conversation it will be a second method with its own test, not a
 * `messages` escape hatch that quietly becomes an agent framework.
 */
export interface LLMRequest {
  /** Defaults to Opus (`claude-opus-5`). A model with no rate card records its cost as a gap. */
  model?: string
  system?: string
  prompt: string
  /** Defaults to 64000 — every call streams, so the ceiling is the model's, not a timeout's. */
  maxTokens?: number
  effort?: LLMEffort
}

export interface LLMCompletion {
  text: string
  model: string
  backend: LLMBackend
  /** Undefined when the backend could not say what the call used. */
  usage: TokenUsage | undefined
  microDollars: number
  dollars: number
  priced: CostPricing
  /**
   * Why the model stopped, when the backend says. `'max_tokens'` means the answer is cut
   * off mid-sentence: the text is real and was paid for, so it is returned rather than
   * thrown away, but a step that files it as a finished artifact is filing a truncated
   * one. Undefined when the backend does not report it.
   */
  stopReason: string | undefined
  /** The ledger row this call became — already written by the time this returns. */
  cost: CostEntry
}

/**
 * Where a call streams to, and what it is charged against.
 *
 * `StepContext` satisfies this structurally, so a step passes itself and gets both for
 * free: its output appears live under the progress line, and the money lands on its step,
 * its run, its episode, and its show. Anything outside a run supplies a `showId` instead.
 */
export interface CallSite {
  readonly store: Store
  readonly stepId?: string
  readonly runId?: string
  readonly episodeId?: string
  readonly showId?: string
  readonly attempt?: number
  /**
   * A piece of live output for the italic line under the progress line — "streams, not
   * spinners" (2.3). The adapter coalesces deltas into sentence-ish pieces before calling
   * this, because the event log stores what it is handed and one row per token would be
   * a hundred thousand rows nobody reads.
   */
  chunk(text: string): void
}

export interface LLMAdapter {
  readonly backend: LLMBackend
  /**
   * One call, streamed. Records its own cost row before returning, and — when a call dies
   * after the prompt was billed — records what it burned before throwing.
   */
  complete(request: LLMRequest, site: CallSite): Promise<LLMCompletion>
}

/** An adapter with its site already attached. This is what a step is handed. */
export interface BoundLLM {
  readonly backend: LLMBackend
  complete(request: LLMRequest): Promise<LLMCompletion>
}

/** Ties an adapter to one step, so a step cannot make a call that streams or bills nowhere. */
export function bindLLM(adapter: LLMAdapter, site: CallSite): BoundLLM {
  return {
    backend: adapter.backend,
    complete: (request) => adapter.complete(request, site),
  }
}

/**
 * Defers construction until the first call. The app picks a backend at boot, but building
 * an API client at boot would make a missing key break a process that has plenty of
 * non-LLM work to do — and would make every runner test construct one.
 */
export function lazyLLM(backend: LLMBackend, build: () => LLMAdapter): LLMAdapter {
  let built: LLMAdapter | undefined
  return {
    backend,
    complete(request, site) {
      built ??= build()
      return built.complete(request, site)
    },
  }
}

// ── Charging ────────────────────────────────────────────────────────────────────

/** What a backend knows once its call is over, before any of it is priced. */
export interface FinishedCall {
  backend: LLMBackend
  model: string
  text: string
  /** Undefined when the backend cannot report tokens. Then the row carries none. */
  usage: TokenUsage | undefined
  /**
   * Dollars the backend stated for itself, in whole micro-dollars. The `claude` CLI does;
   * the API does not. When present it WINS over the rate card: it is the number closer to
   * the invoice, and it accounts for things this app's price table has never heard of.
   */
  reportedMicroDollars?: number
  /** Why the model stopped, when the backend says so. */
  stopReason?: string
  /** 'failed' for a call that burned tokens and produced nothing usable. */
  outcome?: CostOutcome
}

/**
 * The one place a finished call becomes money. Every backend ends here, including the
 * fake — so the arithmetic a test exercises is the arithmetic production runs.
 */
export function chargeLLMCall(site: CallSite, call: FinishedCall): LLMCompletion {
  const rateCard = call.usage ? priceLLMCall(call.model, call.usage) : undefined
  const reported = call.reportedMicroDollars

  let microDollars = 0
  let priced: CostPricing = 'unpriced'
  // The backend's own number wins — it is nearer the invoice than our table, and knows
  // about tiers and surcharges the table has never heard of. With one exception: a
  // reported ZERO beside tokens that plainly cost something is not a price, it is an
  // absence, and letting it stand would hide a week of work from the budget. Fall back to
  // the rate card there, and let the row say that is where the number came from.
  if (reported !== undefined && !(reported === 0 && (rateCard ?? 0) > 0)) {
    microDollars = reported
    priced = 'reported'
  } else if (rateCard !== undefined) {
    microDollars = rateCard
    priced = 'rate-card'
  }

  const cost = recordCost(site.store, {
    kind: 'llm',
    backend: call.backend,
    model: call.model,
    outcome: call.outcome ?? 'ok',
    microDollars,
    priced,
    usage: call.usage,
    stepId: site.stepId,
    runId: site.runId,
    episodeId: site.episodeId,
    showId: site.showId,
    attempt: site.attempt,
  })

  return {
    text: call.text,
    model: call.model,
    backend: call.backend,
    usage: call.usage,
    microDollars: cost.microDollars,
    dollars: cost.dollars,
    priced,
    stopReason: call.stopReason,
    cost,
  }
}

/**
 * A call that died. Records what it burned — the prompt is billed the moment the model
 * starts, so a stream that fails halfway still costs money, and three of those is what a
 * spent retry budget looks like on the invoice — then throws the scrubbed error.
 *
 * When the backend could say nothing at all about usage, nothing is recorded: a ledger
 * that guesses is worse than one that admits a gap.
 */
export function chargeFailedLLMCall(
  site: CallSite,
  call: Omit<FinishedCall, 'outcome' | 'text'> & { text?: string },
  cause: unknown,
): never {
  if (call.usage || call.reportedMicroDollars !== undefined) {
    chargeLLMCall(site, { ...call, text: call.text ?? '', outcome: 'failed' })
  }
  throw new Error(scrubSecrets(messageOf(cause)))
}

export const modelOf = (request: LLMRequest): string => request.model ?? DEFAULT_MODEL

/** Every call streams, so this is the model's ceiling rather than a hedge against a timeout. */
export const MAX_TOKENS = 64000
export const maxTokensOf = (request: LLMRequest): number => request.maxTokens ?? MAX_TOKENS

// ── Streaming ───────────────────────────────────────────────────────────────────

/** Somewhere to put deltas that turns them into sentences. */
export interface Chunker {
  push(delta: string): void
  /** Emits whatever is left. Call it once, when the model is done. */
  flush(): void
}

/** Past this many characters with no sentence in sight, the line ships anyway. */
const CHUNK_CEILING = 240

/**
 * Coalesces token deltas into sentence-ish pieces, because that is what the line under the
 * progress line wants to show and because `chunk()` writes a row per call. A token-level
 * chunk stream would be a hundred thousand appends per script and an unreadable smear on
 * screen; a whole-response chunk would not be streaming at all.
 *
 * Everything is scrubbed on the way out: chunks land in an append-only log.
 */
export function sentenceChunker(sink: (text: string) => void, ceiling = CHUNK_CEILING): Chunker {
  let buffer = ''

  const emit = (text: string): void => {
    const scrubbed = scrubSecrets(text).trim()
    if (scrubbed !== '') sink(scrubbed)
  }

  return {
    push(delta: string): void {
      buffer += delta
      const cut = lastSentenceEnd(buffer)
      if (cut > 0) {
        emit(buffer.slice(0, cut))
        buffer = buffer.slice(cut)
        return
      }
      if (buffer.length >= ceiling) {
        emit(buffer)
        buffer = ''
      }
    },
    flush(): void {
      if (buffer !== '') {
        emit(buffer)
        buffer = ''
      }
    },
  }
}

/**
 * How much of the buffer is finished sentences: the index just past the last one. A
 * terminator at the very end of the buffer does not count — more may be arriving, and
 * "Mr" is not a sentence.
 */
function lastSentenceEnd(buffer: string): number {
  let cut = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index]!
    if (character === '\n') {
      cut = index + 1
      continue
    }
    if (!'.!?…'.includes(character)) continue
    const next = buffer[index + 1]
    if (next !== undefined && /\s/.test(next)) cut = index + 1
  }
  return cut
}

// ── Secrets ─────────────────────────────────────────────────────────────────────

const REDACTED = '[redacted]'

/**
 * Anything shaped like a credential. Belt and braces with `liveSecrets` below: the
 * patterns catch a key this process never held (one echoed back in an error body), the
 * live values catch one shaped in a way nobody predicted.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{24,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b(x-api-key|authorization|api[_-]?key)\b(\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
]

/** The credential env vars anything in this app might be holding. Never their values. */
const SECRET_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]

function liveSecrets(): string[] {
  return SECRET_ENV.map((name) => process.env[name]).filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  )
}

/**
 * Redacts credentials from text on its way into the append-only event log or a run's
 * failure line. **This is a one-way door**: nothing can delete an event once written, so a
 * key that reaches the log is in the library file forever. Call it on every error message
 * and every streamed piece — the cost is a regex per sentence.
 */
export function scrubSecrets(text: string): string {
  let scrubbed = text
  for (const value of liveSecrets()) scrubbed = scrubbed.split(value).join(REDACTED)
  for (const shape of SECRET_SHAPES) {
    scrubbed = scrubbed.replace(shape, (match, ...rest) => {
      // The header-shaped pattern keeps its name and separator so the message still reads
      // ("authorization: [redacted]"); the bare-token shapes are replaced whole.
      const groups = rest.slice(0, -2)
      return groups.length >= 2 ? `${groups[0]}${groups[1]}${REDACTED}` : REDACTED
    })
  }
  return scrubbed
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
