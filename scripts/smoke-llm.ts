import { parseArgs } from 'node:util'
import {
  costOfEpisode,
  costOfRun,
  costOfShow,
  costOfStep,
  costsOfRun,
  money,
  PRICE_CHECKED_ON,
  projectLLMCost,
  promptTokens,
  remainingThisWeek,
  setShowBudget,
} from '../app/server/cost.ts'
import { migrate } from '../app/server/db/migrate.ts'
import { openStore } from '../app/server/db/store.ts'
import { createEpisode, createSeason, createShow } from '../app/server/domain/spine.ts'
import { LLM_BACKEND, type CallSite, type LLMBackend, type LLMEffort } from '../app/server/llm/adapter.ts'
import { createAnthropicAdapter } from '../app/server/llm/anthropic.ts'
import { createClaudeCliAdapter } from '../app/server/llm/cli.ts'
import { findStepByName, recordRun } from '../app/server/runner/run.ts'

/**
 * The smoke test for E1-6 — **one real call, on real credentials, for real money.**
 *
 *     npm run smoke:llm -- --backend claude-cli
 *     npm run smoke:llm -- --backend anthropic-api --model claude-haiku-4-5
 *
 * It is a script and not a test on purpose. `npm test` never reaches the network and
 * never spends a cent (fixtures before features); the fake backend proves the wiring and
 * the arithmetic, and this proves that what the two real backends actually report is what
 * that arithmetic was fed. Run it by hand, after touching either backend, and read the
 * numbers against the Anthropic console.
 *
 * It writes to an in-memory database and leaves nothing behind. The money is real anyway.
 */

const DEFAULT_PROMPT =
  'In two sentences, describe the sound of a cargo hold on a becalmed ship at night. ' +
  'No preamble.'

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    prompt: { type: 'string' },
    budget: { type: 'string' },
    // Which `claude` to run. For a second install — and for proving this script itself
    // works end to end against a stand-in, without a network call or a cent of spend.
    command: { type: 'string' },
  },
})

const backend = (values.backend ?? 'claude-cli') as LLMBackend
if (!(LLM_BACKEND as readonly string[]).includes(backend)) {
  console.error(`--backend is one of ${LLM_BACKEND.join(', ')} — got "${backend}"`)
  process.exit(2)
}

const prompt = values.prompt ?? DEFAULT_PROMPT
const adapter =
  backend === 'anthropic-api'
    ? createAnthropicAdapter()
    : createClaudeCliAdapter(values.command === undefined ? {} : { command: values.command })

// A throwaway library with one episode and one run to charge the call against, so the
// four rollups below are the real queries rather than a mock of them.
const store = openStore(':memory:')
migrate(store)
const show = createShow(store, { key: 'smoke', title: 'Smoke Test' })
const season = createSeason(store, { showId: show.id, number: 1 })
const episode = createEpisode(store, { seasonId: season.id, number: 7, title: 'Salt' })
const run = recordRun(
  store,
  { name: 'write', steps: [{ name: 'outline', execute: async () => undefined }] },
  episode.id,
)
const step = findStepByName(store, run.id, 'outline')!
setShowBudget(store, show.id, Number(values.budget ?? 50))

const site: CallSite = {
  store,
  stepId: step.id,
  runId: run.id,
  episodeId: episode.id,
  attempt: 1,
  chunk: (text) => process.stdout.write(`  │ ${text}\n`),
}

const projection = projectLLMCost({
  ...(values.model === undefined ? {} : { model: values.model }),
  promptTokens: Math.ceil(prompt.length / 4),
  outputTokens: 120,
})

console.log(`Backend      ${backend}   (prices last checked ${PRICE_CHECKED_ON})`)
console.log(`Model        ${values.model ?? 'claude-opus-5 (default)'}`)
console.log(`Projection   ${projection.sentence}`)
console.log('')
console.log('THIS SPENDS REAL MONEY. Streaming:')
console.log('')

const started = Date.now()
const completion = await adapter.complete(
  {
    prompt,
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.effort === undefined ? {} : { effort: values.effort as LLMEffort }),
  },
  site,
)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log('')
console.log(`Answer       ${completion.text.replace(/\n/g, '\n             ')}`)
console.log(`Model said   ${completion.model}`)
console.log(`Stopped on   ${completion.stopReason ?? 'the backend did not say'}`)
console.log(`Took         ${elapsed}s`)
console.log('')

if (completion.usage) {
  const used = completion.usage
  console.log('Tokens       (usage.input_tokens is the UNCACHED REMAINDER, not the prompt)')
  console.log(`  uncached input   ${used.uncachedInput}`)
  console.log(`  cache write 5m   ${used.cacheWrite5m}`)
  console.log(`  cache write 1h   ${used.cacheWrite1h}`)
  console.log(`  cache read       ${used.cacheRead}`)
  console.log(`  prompt, in all   ${promptTokens(used)}`)
  console.log(`  output           ${used.output}`)
} else {
  console.log('Tokens       the backend reported none — the row records that as a gap')
}

console.log('')
console.log(`Cost         ${money(completion.microDollars)}  (${completion.priced})`)
console.log('')
console.log('Ledger row')
for (const entry of costsOfRun(store, run.id)) {
  console.log(`  ${JSON.stringify(entry, null, 2).replace(/\n/g, '\n  ')}`)
}

console.log('')
console.log('Rolls up to')
console.log(`  step     ${money(costOfStep(store, step.id).microDollars)}`)
console.log(`  run      ${money(costOfRun(store, run.id).microDollars)}`)
console.log(`  episode  ${money(costOfEpisode(store, episode.id).microDollars)}`)
console.log(`  show     ${money(costOfShow(store, show.id).microDollars)}`)
console.log(`  week     ${remainingThisWeek(store, show.id).sentence}`)
console.log('')
console.log(`Projected ${projection.sentence.split(', ').at(-1)}, actually ${money(completion.microDollars)}.`)
console.log('Compare the cost above against the Anthropic console before trusting it.')

store.close()
