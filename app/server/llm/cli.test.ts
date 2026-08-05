import { beforeEach, describe, expect, it } from 'vitest'
import { costOfStep, costsOfRun } from '../cost.ts'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import { findStepByName, recordRun } from '../runner/run.ts'
import { sentenceChunker, type CallSite } from './adapter.ts'
import { claudeArgv, createClaudeCliAdapter, newTranscript, readCliLine } from './cli.ts'

/**
 * The `claude` CLI backend: the argv it builds, the JSONL it reads, and the whole
 * subprocess path — spawn, stdin, lines, exit code — driven against a stand-in written in
 * Node. No network, no subscription, no money. The real CLI is exercised by hand through
 * `scripts/smoke-llm.ts`.
 */

let store: Store
let site: CallSite
let streamed: string[]
let stepId: string
let runId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  const episodeId = createEpisode(store, { seasonId: season.id, number: 7, title: 'Salt' }).id
  runId = recordRun(
    store,
    { name: 'write', steps: [{ name: 'outline', execute: async () => undefined }] },
    episodeId,
  ).id
  stepId = findStepByName(store, runId, 'outline')!.id
  streamed = []
  site = { store, stepId, runId, episodeId, attempt: 1, chunk: (text) => streamed.push(text) }
})

describe('the claude CLI backend — the command line', () => {
  it('builds an argv array, and keeps the prompt out of it', () => {
    const argv = claudeArgv({ prompt: 'Write the ep07 outline.' })

    expect(argv).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--safe-mode',
      '--no-session-persistence',
      '--model',
      'claude-opus-5',
      '--tools',
      '',
    ])
    // The prompt goes on stdin. As an argument it would eventually hit ARG_MAX on exactly
    // the episodes with the most canon in scope — and `--tools` is variadic, so a trailing
    // positional would be swallowed by it.
    expect(argv).not.toContain('Write the ep07 outline.')
    // Which is also why the variadic flag is last and nothing follows it.
    expect(argv.slice(-2)).toEqual(['--tools', ''])
  })

  it('passes a system prompt and an effort level as separate argv entries', () => {
    const argv = claudeArgv({
      prompt: 'x',
      system: 'You write Grey Harbor.',
      effort: 'xhigh',
      model: 'claude-sonnet-5',
    })

    // Separate entries, never interpolated into one string — a house style full of
    // quotation marks and backticks is a shell injection waiting to happen.
    expect(argv).toContain('--system-prompt')
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('You write Grey Harbor.')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('xhigh')
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5')
  })
})

describe('the claude CLI backend — reading the transcript', () => {
  const read = (lines: unknown[]) => {
    const transcript = newTranscript()
    const pieces: string[] = []
    const chunker = sentenceChunker((piece) => pieces.push(piece))
    for (const line of lines) {
      readCliLine(transcript, typeof line === 'string' ? line : JSON.stringify(line), chunker)
    }
    chunker.flush()
    return { transcript, pieces }
  }

  it('streams partial messages and takes the final text from the result line', () => {
    const { transcript, pieces } = read([
      { type: 'system', subtype: 'init' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The dock lights ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fail. Ferro runs.' } } },
      { type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The dock lights fail. Ferro runs.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'The dock lights fail. Ferro runs.' },
    ])

    expect(pieces).toEqual(['The dock lights fail.', 'Ferro runs.'])
    expect(transcript.text).toBe('The dock lights fail. Ferro runs.')
    expect(transcript.model).toBe('claude-opus-5')
    expect(transcript.stopReason).toBe('end_turn')
  })

  it('falls back to the assistant message when a build emits no partial messages', () => {
    const { pieces, transcript } = read([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The dock lights fail.' }] } },
    ])

    // Better one late chunk than a silent spinner (2.3).
    expect(pieces).toEqual(['The dock lights fail.'])
    expect(transcript.text).toBe('The dock lights fail.')
  })

  it('reads the same three input counts the API reports, because they are the same fields', () => {
    const { transcript } = read([
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 2000,
          cache_read_input_tokens: 8000,
          output_tokens: 500,
        },
      },
    ])

    expect(transcript.usage).toEqual({
      uncachedInput: 1000,
      cacheWrite5m: 2000,
      cacheWrite1h: 0,
      cacheRead: 8000,
      output: 500,
    })
  })

  it('takes the dollars the CLI states, to the micro-dollar', () => {
    const { transcript } = read([{ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.0342 }])
    expect(transcript.reportedMicroDollars).toBe(34_200)
  })

  it('notices a failure the CLI reports on its way out', () => {
    const { transcript } = read([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }])
    expect(transcript.failure).toBe('error_during_execution')
  })

  it('ignores anything it cannot read rather than throwing away a paid-for answer', () => {
    // The CLI is a separate program on its own release cadence: a banner, a debug line, a
    // shape nobody predicted. None of it is worth losing a completion over.
    const { transcript } = read([
      'not json at all',
      '',
      { type: 'something_new', payload: { nested: true } },
      { type: 'stream_event' },
      { type: 'result', subtype: 'success', result: 'the outline', total_cost_usd: 0.01 },
    ])

    expect(transcript.text).toBe('the outline')
    expect(transcript.reportedMicroDollars).toBe(10_000)
  })
})

// ── The whole subprocess, against a stand-in ────────────────────────────────────

/** Prints a plausible stream-json transcript and echoes stdin back, to prove it arrived. */
const FAKE_CLI = `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (piece) => { input += piece })
process.stdin.on('end', () => {
  const say = (line) => process.stdout.write(JSON.stringify(line) + '\\n')
  say({ type: 'system', subtype: 'init', model: 'claude-opus-5' })
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The dock lights ' } } })
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fail. Ferro runs.' } } })
  say({ type: 'assistant', message: { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } })
  say({
    type: 'result', subtype: 'success', is_error: false,
    result: 'ECHO ' + input.trim(),
    total_cost_usd: 0.0342,
    usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 500 },
  })
})
`

/** Says nothing useful at all — the honest-gap case. */
const MUTE_CLI = `
process.stdin.resume()
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'the outline' }) + '\\n')
})
`

const ANGRY_CLI = `
process.stderr.write('Invalid API key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF\\n')
process.exit(1)
`

const standIn = (script: string) => ({
  command: process.execPath,
  // `--` so Node stops reading the CLI's own flags as its options.
  leadingArgs: ['-e', script, '--'],
})

describe('the claude CLI backend — end to end through a real subprocess', () => {
  it('sends the prompt on stdin, streams what comes back, and files what it cost', async () => {
    const adapter = createClaudeCliAdapter(standIn(FAKE_CLI))

    const completion = await adapter.complete({ prompt: 'Write the ep07 outline.' }, site)

    // The prompt reached the process — on stdin, not in argv.
    expect(completion.text).toBe('ECHO Write the ep07 outline.')
    expect(streamed).toEqual(['The dock lights fail.', 'Ferro runs.'])

    // $0.0342 as the CLI stated it, NOT the $0.034 our rate card would have computed from
    // the same tokens. Its number is nearer the invoice, so its number wins.
    expect(completion.priced).toBe('reported')
    expect(completion.microDollars).toBe(34_200)
    const totals = costOfStep(store, stepId)
    expect(totals.microDollars).toBe(34_200)
    expect(totals.promptTokens).toBe(11_000)
    expect(totals.outputTokens).toBe(500)
    expect(costsOfRun(store, runId)[0]!.backend).toBe('claude-cli')
  })

  it('records the gap when the CLI reports neither dollars nor tokens', async () => {
    const adapter = createClaudeCliAdapter(standIn(MUTE_CLI))

    const completion = await adapter.complete({ prompt: 'Write the ep07 outline.' }, site)

    // The answer is real and is returned. What it cost is unknown, and says so — a ledger
    // that guessed here would be worse than one that admits a gap.
    expect(completion.text).toBe('the outline')
    expect(completion.priced).toBe('unpriced')
    expect(costOfStep(store, stepId).unpricedCalls).toBe(1)
  })

  it('reports a non-zero exit with its stderr, scrubbed', async () => {
    const adapter = createClaudeCliAdapter(standIn(ANGRY_CLI))

    await expect(adapter.complete({ prompt: 'x' }, site)).rejects.toThrow(
      /exited 1 — Invalid API key \[redacted\]/,
    )
    // Nothing is known to have been spent, so nothing is claimed to have been.
    expect(costOfStep(store, stepId).calls).toBe(0)
  })

  it('says which executable it could not find, and what to do instead', async () => {
    const adapter = createClaudeCliAdapter({ command: '/nonexistent/claude' })

    await expect(adapter.complete({ prompt: 'x' }, site)).rejects.toThrow(
      /could not run the claude CLI \(\/nonexistent\/claude\).*SHOWRUNNER_LLM_BACKEND/s,
    )
  })
})
