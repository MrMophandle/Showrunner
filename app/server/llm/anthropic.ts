import Anthropic from '@anthropic-ai/sdk'
import { tokenUsage, type TokenUsage } from '../cost.ts'
import {
  chargeFailedLLMCall,
  chargeLLMCall,
  maxTokensOf,
  messageOf,
  modelOf,
  scrubSecrets,
  sentenceChunker,
  type CallSite,
  type LLMAdapter,
  type LLMCompletion,
  type LLMRequest,
} from './adapter.ts'

/**
 * The Anthropic API backend (D6). Streams, prices what it used, and gets out of the way.
 *
 * ── What it does not set, and why ───────────────────────────────────────────────
 * - **No `temperature`, `top_p`, or `top_k`.** They are removed on Opus 5 and return a
 *   400. Steering is prompting.
 * - **No `thinking`.** Opus 5 thinks by default; omitting the parameter IS adaptive
 *   thinking. `effort` is the dial, and thinking tokens are billed as output, so the
 *   ledger already counts them.
 * - **No retries.** `maxRetries: 0` — the runner owns the retry budget (see adapter.ts).
 * - **No tools, no conversation.** One system prompt, one user prompt, one answer.
 */

/**
 * `client` exists so a test can hand in a stub and prove the usage arithmetic without a
 * network call — no test in this repo may spend real money (fixtures before features).
 * Left out, a real client is built on first use, which is also when a missing credential
 * is worth complaining about.
 */
export function createAnthropicAdapter(options: { client?: Anthropic } = {}): LLMAdapter {
  let client = options.client

  return {
    backend: 'anthropic-api',

    async complete(request: LLMRequest, site: CallSite): Promise<LLMCompletion> {
      // `new Anthropic()` resolves credentials itself — an API key in the environment, or
      // a logged-in profile. Never passed one here, and never read into a variable, so
      // there is nothing to accidentally put in a log line.
      client ??= new Anthropic({ maxRetries: 0 })

      const model = modelOf(request)
      const chunker = sentenceChunker((text) => site.chunk(text))

      // Kept up to date as the stream runs, so a call that dies mid-flight can still say
      // what it burned: the prompt is billed the moment the model starts.
      let spent: TokenUsage | undefined

      // Only the network work goes in the `try`. Everything after it — the refusal check
      // below — throws its own scrubbed error after charging, and a catch around that
      // would charge the same call a second time.
      let message: Anthropic.Message
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokensOf(request),
          messages: [{ role: 'user', content: request.prompt }],
          ...(request.system === undefined ? {} : { system: request.system }),
          ...(request.effort === undefined ? {} : { output_config: { effort: request.effort } }),
        })

        for await (const event of stream) {
          if (event.type === 'message_start') {
            spent = usageOf(event.message.usage)
          } else if (event.type === 'message_delta') {
            spent = deltaUsageOf(event.usage, spent)
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            // Text only. Thinking is billed as output and counted, but it is not what the
            // line under the progress line is for — and on Opus 5 it arrives empty anyway,
            // because summaries are off unless asked for.
            chunker.push(event.delta.text)
          }
        }
        chunker.flush()
        message = await stream.finalMessage()
      } catch (error) {
        chunker.flush()
        chargeFailedLLMCall(site, { backend: 'anthropic-api', model, usage: spent }, describe(error))
      }

      const usage = usageOf(message.usage)
      // What answered, which is not always what was asked for — a request can be served by
      // another model. The bill follows the model that ran, so the ledger does too.
      const served = message.model ?? model

      // Check the stop reason before reading the content: a refusal is a successful HTTP
      // response with nothing in it, and code that reaches for `content[0]` finds a hole.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category ?? 'unstated'
        chargeFailedLLMCall(
          site,
          { backend: 'anthropic-api', model: served, usage },
          `Claude declined this request (${category}). The prompt reached the model and was ` +
            'billed; nothing came back. Rewording is the fix, not a retry.',
        )
      }

      return chargeLLMCall(site, {
        backend: 'anthropic-api',
        model: served,
        text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
        usage,
        // 'max_tokens' means the answer is cut off mid-sentence. The text is real and was
        // paid for, so it is returned rather than thrown away — but a step that files it
        // as a finished artifact is filing a truncated one, and the field is here so it
        // can tell.
        stopReason: message.stop_reason ?? undefined,
      })
    },
  }
}

/**
 * The three input counts and the output count, kept apart because they bill apart.
 * `usage.input_tokens` is the UNCACHED REMAINDER of the prompt — see cost.ts.
 */
function usageOf(usage: Anthropic.Usage): TokenUsage {
  // The 5m/1h split is only present when something asked for a 1-hour TTL. Without it,
  // everything cached this call went to the 5-minute cache, which is the 1.25x rate.
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens
  return tokenUsage({
    uncachedInput: usage.input_tokens,
    cacheWrite5m: write5m ?? usage.cache_creation_input_tokens ?? 0,
    cacheWrite1h: write1h ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens,
  })
}

/**
 * A `message_delta`'s usage, which is cumulative and has no 5m/1h breakdown. Only ever
 * used to say what a call that died had already spent, so the cache write is priced at
 * the 5-minute rate — the one that is true unless a 1-hour TTL was asked for.
 */
function deltaUsageOf(usage: Anthropic.MessageDeltaUsage, known: TokenUsage | undefined): TokenUsage {
  return tokenUsage({
    uncachedInput: usage.input_tokens ?? known?.uncachedInput ?? 0,
    cacheWrite5m: usage.cache_creation_input_tokens ?? known?.cacheWrite5m ?? 0,
    cacheWrite1h: known?.cacheWrite1h ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? known?.cacheRead ?? 0,
    output: usage.output_tokens,
  })
}

/**
 * The SDK's typed errors, most specific first — never a string match on the message,
 * which changes without warning. What comes out of here goes into `run.failure` and into
 * the append-only event log, so it is a sentence for Ryan and it carries no credential.
 */
function describe(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'the Anthropic API rejected the credentials (401) — the key or profile this ' +
      'process is running under cannot call the model'
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `the Anthropic API refused this key access (403) — ${scrubSecrets(error.message)}`
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `the Anthropic API has no such model or endpoint (404) — ${scrubSecrets(error.message)}`
  }
  if (error instanceof Anthropic.RateLimitError) {
    return `the Anthropic API is rate-limiting this key (429) — ${scrubSecrets(error.message)}`
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `the Anthropic API refused the request (400) — ${scrubSecrets(error.message)}`
  }
  if (error instanceof Anthropic.InternalServerError) {
    return `the Anthropic API failed (${error.status}) — ${scrubSecrets(error.message)}`
  }
  // Before APIError: in this SDK the connection error is a subclass of it.
  if (error instanceof Anthropic.APIConnectionError) {
    return `could not reach the Anthropic API — ${scrubSecrets(error.message)}`
  }
  if (error instanceof Anthropic.APIError) {
    return `the Anthropic API errored — ${scrubSecrets(error.message)}`
  }
  return scrubSecrets(messageOf(error))
}
