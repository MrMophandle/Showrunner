import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { tokenUsage, type TokenUsage } from '../cost.ts'
import {
  chargeFailedLLMCall,
  chargeLLMCall,
  messageOf,
  modelOf,
  scrubSecrets,
  sentenceChunker,
  type CallSite,
  type Chunker,
  type LLMAdapter,
  type LLMCompletion,
  type LLMRequest,
} from './adapter.ts'

/**
 * The `claude` CLI backend (D6) — Claude Code in `--print` mode, not `ant`, not a shell
 * pipeline. It exists because Ryan's subscription authenticates it and an API key is a
 * separate bill; the same `LLMAdapter` interface, a different way in.
 *
 * ── argv, never a shell string ──────────────────────────────────────────────────
 * `spawn(command, argv)` with no `shell` option, and **the prompt goes on stdin**. Both
 * halves matter. A shell string would make every backtick in a script prompt a command
 * substitution. And an episode's prompt is tens of kilobytes of canon — as an argument it
 * would eventually hit ARG_MAX and fail on exactly the episodes that matter most, while
 * `--tools` is variadic and would happily swallow a trailing positional prompt whole.
 *
 * ── Getting money back out of it is the hard part ───────────────────────────────
 * The API backend is handed usage on a plate. Here it has to be read out of a JSONL
 * transcript, and what arrives depends on the CLI's version and how the session
 * authenticated. So this file takes what the CLI actually says and admits what it does
 * not:
 *   - `total_cost_usd` present → the row is `reported`, at the CLI's own number. It wins
 *     over our rate card because it is nearer the invoice. Note that on a subscription
 *     the figure is the API-equivalent price of tokens that were not billed per call —
 *     it is what the CLI states, and `backend = 'claude-cli'` on the row is what tells
 *     you how to read it.
 *   - no cost but usage present → priced from the rate card, same arithmetic as the API.
 *   - neither → the row says `unpriced` and the rollups count it. A ledger that guesses
 *     is worse than one that admits a gap.
 */

/**
 * The executable this backend spawns. Exported so `choose.ts` probes for the same binary
 * this file will actually run — a readiness check looking for a different name than the
 * adapter spawns is a readiness check that lies.
 */
export const CLAUDE_CLI_COMMAND = 'claude'

export interface ClaudeCliOptions {
  /** The executable. `claude` on PATH by default. */
  command?: string
  /**
   * Arguments before the flags. The seam a test uses to point `command` at a stand-in and
   * drive the whole subprocess path — spawn, stdin, JSONL, exit code — without a network
   * call or a cent of spend.
   */
  leadingArgs?: readonly string[]
  /**
   * Where the subprocess runs. A temp directory by default, deliberately: this backend is
   * a text completion, and it must not pick up the repository it happens to be running
   * inside. `--safe-mode` says the same thing from the other side.
   */
  cwd?: string
}

export function createClaudeCliAdapter(options: ClaudeCliOptions = {}): LLMAdapter {
  const command = options.command ?? CLAUDE_CLI_COMMAND
  const cwd = options.cwd ?? tmpdir()

  return {
    backend: 'claude-cli',

    async complete(request: LLMRequest, site: CallSite): Promise<LLMCompletion> {
      const model = modelOf(request)
      const chunker = sentenceChunker((text) => site.chunk(text))
      const transcript = newTranscript()

      try {
        await runClaude(
          command,
          [...(options.leadingArgs ?? []), ...claudeArgv(request)],
          cwd,
          request.prompt,
          (line) => readCliLine(transcript, line, chunker),
        )
        chunker.flush()
      } catch (error) {
        chunker.flush()
        // Whatever the transcript managed to say before it died is still what was spent.
        chargeFailedLLMCall(
          site,
          {
            backend: 'claude-cli',
            model: transcript.model ?? model,
            usage: transcript.usage,
            reportedMicroDollars: transcript.reportedMicroDollars,
          },
          messageOf(error),
        )
      }

      if (transcript.failure !== undefined) {
        chargeFailedLLMCall(
          site,
          {
            backend: 'claude-cli',
            model: transcript.model ?? model,
            usage: transcript.usage,
            reportedMicroDollars: transcript.reportedMicroDollars,
          },
          `the claude CLI reported a failure — ${transcript.failure}`,
        )
      }

      return chargeLLMCall(site, {
        backend: 'claude-cli',
        model: transcript.model ?? model,
        text: transcript.text,
        usage: transcript.usage,
        reportedMicroDollars: transcript.reportedMicroDollars,
        stopReason: transcript.stopReason,
      })
    },
  }
}

/**
 * The flags, in an array, every time. `--safe-mode` and a temp `cwd` keep the CLI from
 * loading this repository's CLAUDE.md, skills, hooks, and MCP servers — a completion
 * backend that read the codebase it lives in would answer differently depending on which
 * directory the server was started from. `--tools ''` leaves it no tools to reach for, and
 * goes last because it is variadic.
 */
export function claudeArgv(request: LLMRequest): string[] {
  const argv = [
    '--print',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--safe-mode',
    '--no-session-persistence',
    '--model',
    modelOf(request),
  ]
  if (request.system !== undefined) argv.push('--system-prompt', request.system)
  if (request.effort !== undefined) argv.push('--effort', request.effort)
  argv.push('--tools', '')
  return argv
}

// ── The subprocess ──────────────────────────────────────────────────────────────

/** How much of a failing process's stderr is worth keeping in an append-only log. */
const STDERR_KEPT = 4000

function runClaude(
  command: string,
  argv: readonly string[],
  cwd: string,
  prompt: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // No `shell` option, an argv array, and the environment passed through untouched —
    // the CLI finds its own credentials in there and nothing in this file reads them.
    const child = spawn(command, [...argv], { cwd, env: process.env })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (piece: string) => {
      stdout += piece
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        onLine(line)
        newline = stdout.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (piece: string) => {
      if (stderr.length < STDERR_KEPT) stderr += piece
    })

    child.stdin.on('error', () => {
      // A CLI that exits before reading the prompt gives us EPIPE here. The close handler
      // below is what reports it; this listener only stops it becoming an unhandled error.
    })
    child.stdin.end(prompt)

    child.on('error', (error) => {
      reject(
        new Error(
          `could not run the claude CLI (${command}) — ${scrubSecrets(messageOf(error))}. ` +
            'Install Claude Code, or point SHOWRUNNER_LLM_BACKEND at anthropic-api.',
        ),
      )
    })
    child.on('close', (code) => {
      if (stdout !== '') onLine(stdout) // a last line with no trailing newline
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `the claude CLI exited ${code} — ${scrubSecrets(stderr.trim()) || 'it said nothing on stderr'}`,
        ),
      )
    })
  })
}

// ── The transcript ──────────────────────────────────────────────────────────────

/** What the JSONL stream has told us so far. Built up line by line, never rewound. */
export interface CliTranscript {
  text: string
  model: string | undefined
  usage: TokenUsage | undefined
  reportedMicroDollars: number | undefined
  stopReason: string | undefined
  /** Set when the CLI itself reports the turn failed, exit code 0 notwithstanding. */
  failure: string | undefined
  streamed: boolean
}

export function newTranscript(): CliTranscript {
  return {
    text: '',
    model: undefined,
    usage: undefined,
    reportedMicroDollars: undefined,
    stopReason: undefined,
    failure: undefined,
    streamed: false,
  }
}

/**
 * One line of `--output-format stream-json`, folded into the transcript. Everything is
 * read defensively: the CLI is a separate program on its own release cadence, and a line
 * shaped differently than expected must degrade to "we could not say" rather than throw
 * away a completion that already cost money.
 */
export function readCliLine(transcript: CliTranscript, line: string, chunker: Chunker): void {
  const trimmed = line.trim()
  if (trimmed === '') return

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return // debug noise, a banner, a partial line — not ours to interpret
  }
  const record = asRecord(parsed)
  if (!record) return

  switch (record['type']) {
    case 'stream_event': {
      // The raw API event, forwarded. Text deltas are the live line under the progress
      // line; everything else here is bookkeeping the `result` line repeats anyway.
      const event = asRecord(record['event'])
      if (!event) return
      if (event['type'] === 'content_block_delta') {
        const delta = asRecord(event['delta'])
        if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          chunker.push(delta['text'])
          transcript.streamed = true
        }
      } else if (event['type'] === 'message_delta') {
        const delta = asRecord(event['delta'])
        if (typeof delta?.['stop_reason'] === 'string') transcript.stopReason = delta['stop_reason']
      }
      return
    }

    case 'assistant': {
      const message = asRecord(record['message'])
      if (!message) return
      if (typeof message['model'] === 'string') transcript.model = message['model']
      if (typeof message['stop_reason'] === 'string') transcript.stopReason = message['stop_reason']
      const usage = usageOf(message['usage'])
      if (usage) transcript.usage = usage
      const text = textOf(message['content'])
      if (text !== '') {
        transcript.text += text
        // Nothing streamed means this build of the CLI did not emit partial messages.
        // Better one late chunk than a silent spinner.
        if (!transcript.streamed) chunker.push(text)
      }
      return
    }

    case 'result': {
      // The last line, and the only one that carries dollars.
      if (typeof record['result'] === 'string' && record['result'] !== '') {
        transcript.text = record['result']
      }
      const usage = usageOf(record['usage'])
      if (usage) transcript.usage = usage
      const cost = record['total_cost_usd']
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        transcript.reportedMicroDollars = Math.max(0, Math.round(cost * 1e6))
      }
      if (record['is_error'] === true || record['subtype'] === 'error_during_execution') {
        transcript.failure = typeof record['subtype'] === 'string' ? record['subtype'] : 'unstated'
      }
      return
    }

    default:
      return
  }
}

/**
 * The CLI passes the API's usage object straight through, so `input_tokens` is the same
 * uncached remainder it is everywhere else — see cost.ts before touching this.
 */
function usageOf(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (!usage) return undefined
  const creation = asRecord(usage['cache_creation'])
  const write5m = numberOf(creation?.['ephemeral_5m_input_tokens'])
  const write1h = numberOf(creation?.['ephemeral_1h_input_tokens'])
  const input = numberOf(usage['input_tokens'])
  const output = numberOf(usage['output_tokens'])
  if (input === undefined && output === undefined) return undefined
  return tokenUsage({
    uncachedInput: input ?? 0,
    cacheWrite5m: write5m ?? numberOf(usage['cache_creation_input_tokens']) ?? 0,
    cacheWrite1h: write1h ?? 0,
    cacheRead: numberOf(usage['cache_read_input_tokens']) ?? 0,
    output: output ?? 0,
  })
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      const record = asRecord(block)
      return record?.['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
    })
    .join('')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
