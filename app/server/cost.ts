import type { Store } from './db/store.ts'

/**
 * The cost ledger (2.4): every LLM call and every generation records tokens and dollars
 * against its step, its run, its episode, and its show — plus the per-show budget that
 * spend is measured against, and the projection a button states before Ryan clicks it.
 *
 * ── usage.input_tokens is not the input ─────────────────────────────────────────
 * The single most expensive misreading available in this file. The Anthropic API's
 * `usage.input_tokens` is the UNCACHED REMAINDER of the prompt, not its size. The prompt
 * was `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and those
 * three bill at different rates — a cache write costs 1.25x the base input rate, a cache
 * read 0.1x. Multiply one field by one rate and every cached call under-reports, forever,
 * silently, because nothing in the response object disagrees with you. Showrunner's canon
 * scope is exactly the kind of large stable prefix that gets cached, so this is the normal
 * case, not the edge case. Hence `TokenUsage` below carries all of it separately and
 * `priceLLMCall` prices each part at its own rate.
 *
 * ── Money is an integer ─────────────────────────────────────────────────────────
 * Whole micro-dollars ($0.000001) everywhere, floats only at the edge where something is
 * rendered. A REAL column summed over a few thousand calls drifts by fractions of a cent,
 * and this is the one number in the app that has to reconcile against a real invoice.
 *
 * ── Not LLM-only ────────────────────────────────────────────────────────────────
 * D20's three image backends cost dollars and produce no tokens at all, and E6's TTS is
 * the same shape. A cost row therefore records dollars always and tokens optionally. E6
 * writes `image` and `audio` rows through `recordCost` and they roll up beside LLM rows in
 * the same queries — which is the whole reason this lands in E1 rather than E6.
 *
 * ── It decides nothing ──────────────────────────────────────────────────────────
 * Nothing here refuses a call, throttles one, or stops a run. A budget is a number Ryan
 * set so a screen can say "$37.60 left of this week's $50.00"; what to do about that is
 * his (invariant 5). If this file ever grows an `enforce` or a `canAfford` that gates
 * execution, that is a policy engine and the answer is no.
 */

// ── The price table ─────────────────────────────────────────────────────────────

/**
 * When these prices were last checked against Anthropic's published rates. **Prices
 * change.** Re-verify this table on that anniversary, whenever a model is added, and
 * before trusting a month-end total: nothing in the code can detect a stale rate, and a
 * wrong number here is wrong in every row written afterwards without a single test failing.
 */
export const PRICE_CHECKED_ON = '2026-08-05'

export interface ModelPrice {
  /** What a button calls it — "1 Opus call, ~$0.85". */
  label: string
  /**
   * Dollars per million input tokens. This number is ALSO micro-dollars per token —
   * $5/1e6 tokens is 5 micro-dollars each — which is why the pricing arithmetic below has
   * no scaling factor in it and none is missing.
   */
  inputPerMillion: number
  /** Dollars per million output tokens; thinking tokens are output tokens. */
  outputPerMillion: number
}

/**
 * One table, one place. Rates scattered through call sites rot invisibly — this is the
 * only place in the app that may know what a token costs.
 *
 * Sonnet 5 is listed at its list price. Anthropic is running an introductory $2/$10
 * through 2026-08-31; the ledger will therefore OVER-report Sonnet calls until then,
 * which is the safe direction for a budget, and the intro rate is deliberately not
 * encoded because it would silently become wrong on 2026-09-01.
 */
export const MODEL_PRICE: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5': { label: 'Opus', inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { label: 'Sonnet', inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { label: 'Haiku', inputPerMillion: 1, outputPerMillion: 5 },
}

/** What Showrunner writes with unless a call says otherwise. */
export const DEFAULT_MODEL = 'claude-opus-5'

/** A 5-minute cache write costs 1.25x the model's base input rate. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25
/** A 1-hour cache write costs 2x — a different number, hence a different field. */
export const CACHE_WRITE_1H_MULTIPLIER = 2
/** A cache read costs 0.1x. This is the discount the whole caching strategy is for. */
export const CACHE_READ_MULTIPLIER = 0.1

// ── What a call used ────────────────────────────────────────────────────────────

/**
 * The tokens one call actually consumed, split the way they are BILLED rather than the
 * way the response object happens to name them.
 */
export interface TokenUsage {
  /**
   * The API's `usage.input_tokens` — the part of the prompt that was neither written to
   * cache nor read from it. Named for what it is, so nobody reads this field and thinks
   * "the input". The prompt is `promptTokens()` below.
   */
  uncachedInput: number
  /** `usage.cache_creation.ephemeral_5m_input_tokens` — billed at 1.25x. */
  cacheWrite5m: number
  /** `usage.cache_creation.ephemeral_1h_input_tokens` — billed at 2x. Zero unless something asked for a 1h TTL. */
  cacheWrite1h: number
  /** `usage.cache_read_input_tokens` — billed at 0.1x. */
  cacheRead: number
  /** `usage.output_tokens`, thinking included — it is billed as output. */
  output: number
}

export const NO_TOKENS: TokenUsage = {
  uncachedInput: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
}

/** Fills in the zeroes, so a caller states only the fields it knows about. */
export function tokenUsage(some: Partial<TokenUsage>): TokenUsage {
  return { ...NO_TOKENS, ...some }
}

/**
 * The size of the prompt — all three input parts added up. This is the number a human
 * means by "input tokens", and it is never one field.
 */
export function promptTokens(usage: TokenUsage): number {
  return usage.uncachedInput + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead
}

/**
 * What one call cost, in whole micro-dollars, or undefined when the model is not in the
 * price table — in which case the caller records the row `unpriced` rather than inventing
 * a number.
 *
 * Each part at its own rate. Read the module header before changing this.
 */
export function priceLLMCall(model: string, usage: TokenUsage): number | undefined {
  const price = MODEL_PRICE[model]
  if (!price) return undefined
  // Dollars-per-million is micro-dollars-per-token, so this is a plain weighted sum.
  return Math.round(
    usage.uncachedInput * price.inputPerMillion +
      usage.cacheWrite5m * price.inputPerMillion * CACHE_WRITE_5M_MULTIPLIER +
      usage.cacheWrite1h * price.inputPerMillion * CACHE_WRITE_1H_MULTIPLIER +
      usage.cacheRead * price.inputPerMillion * CACHE_READ_MULTIPLIER +
      usage.output * price.outputPerMillion,
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────────

/** The three media that spend money. All three are legal in the schema from E1 (D20). */
export const COST_KIND = ['llm', 'image', 'audio'] as const
export type CostKind = (typeof COST_KIND)[number]

/** 'failed' is a call that cost money and returned nothing usable. It still spent. */
export const COST_OUTCOME = ['ok', 'failed'] as const
export type CostOutcome = (typeof COST_OUTCOME)[number]

/**
 * How the dollars were arrived at, so that "$0.00" and "we could not say" never look
 * alike in a total:
 * - `rate-card` — computed from the tokens and `MODEL_PRICE`.
 * - `reported`  — the backend stated the dollars itself (the `claude` CLI does).
 * - `unpriced`  — nobody could say; the amount is 0 and that 0 is a gap.
 */
export const COST_PRICING = ['rate-card', 'reported', 'unpriced'] as const
export type CostPricing = (typeof COST_PRICING)[number]

export interface CostEntry {
  seq: number
  kind: CostKind
  backend: string
  model: string
  outcome: CostOutcome
  microDollars: number
  dollars: number
  priced: CostPricing
  /** Undefined for a call that produces no tokens at all (image, TTS). */
  usage: TokenUsage | undefined
  showId: string
  episodeId: string | null
  runId: string | null
  stepId: string | null
  attempt: number | null
  at: string
}

/**
 * One call's cost, as its caller states it. Give it whichever of step / run / episode /
 * show it knows about and the rest is derived — so the four levels can never disagree.
 */
export interface CostDraft {
  kind: CostKind
  backend: string
  model: string
  microDollars: number
  priced: CostPricing
  outcome?: CostOutcome
  usage?: TokenUsage
  stepId?: string
  runId?: string
  episodeId?: string
  showId?: string
  attempt?: number
}

/**
 * The one write path into the ledger. There is no update path and no delete path here,
 * and SQLite refuses both independently (0005) — a correction is another row.
 *
 * The step / run / episode / show chain is walked here rather than passed in, which is
 * what makes the four rollups agree by construction: a caller that knows only its step id
 * cannot accidentally file the money against the wrong episode.
 */
export function recordCost(store: Store, draft: CostDraft): CostEntry {
  const site = siteOf(store, draft)
  const usage = draft.usage
  const row = store.get<CostRow>(
    `INSERT INTO cost_entry (
       kind, backend, model, outcome, micro_dollars, priced,
       uncached_input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
       show_id, episode_id, run_id, step_id, attempt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    draft.kind,
    draft.backend,
    draft.model,
    draft.outcome ?? 'ok',
    Math.max(0, Math.round(draft.microDollars)),
    draft.priced,
    usage ? usage.uncachedInput : null,
    // The 5m/1h split matters at pricing time, not at reading time — one column holds
    // both, and `priced` records that the split was already applied.
    usage ? usage.cacheWrite5m + usage.cacheWrite1h : null,
    usage ? usage.cacheRead : null,
    usage ? usage.output : null,
    site.showId,
    site.episodeId,
    site.runId,
    site.stepId,
    draft.attempt ?? null,
  )!
  return hydrateEntry(row)
}

/** Every cost row of a run, oldest first — the run's own spend, itemised. */
export function costsOfRun(store: Store, runId: string): CostEntry[] {
  return store
    .all<CostRow>('SELECT * FROM cost_entry WHERE run_id = ? ORDER BY seq', runId)
    .map(hydrateEntry)
}

// ── Rollups ─────────────────────────────────────────────────────────────────────

export interface CostTotals {
  calls: number
  microDollars: number
  /** The same money as a float, for rendering only. Do arithmetic in micro-dollars. */
  dollars: number
  /** Calls nobody could price. While this is non-zero the total is a floor, not a fact. */
  unpricedCalls: number
  /** Calls that cost money and returned nothing usable. */
  failedCalls: number
  /** Calls that produced no tokens at all — image and TTS work (D20, E6). */
  tokenlessCalls: number
  uncachedInputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** All three input parts added up: the size of every prompt sent. */
  promptTokens: number
}

export const costOfStep = (store: Store, stepId: string): CostTotals =>
  totals(store, 'step_id = ?', stepId)

export const costOfRun = (store: Store, runId: string): CostTotals =>
  totals(store, 'run_id = ?', runId)

export const costOfEpisode = (store: Store, episodeId: string): CostTotals =>
  totals(store, 'episode_id = ?', episodeId)

export const costOfShow = (store: Store, showId: string): CostTotals =>
  totals(store, 'show_id = ?', showId)

/** A show's spend since a moment — what the weekly budget is measured against. */
export const costOfShowSince = (store: Store, showId: string, since: string): CostTotals =>
  totals(store, 'show_id = ? AND at >= ?', showId, since)

// ── The budget ──────────────────────────────────────────────────────────────────

export interface ShowBudget {
  showId: string
  weeklyMicroDollars: number
  weeklyDollars: number
  setAt: string
}

/** Sets (or replaces) what this show may spend in a week. A setting, not a record. */
export function setShowBudget(store: Store, showId: string, weeklyDollars: number): ShowBudget {
  if (!(weeklyDollars >= 0)) {
    throw new Error(`a weekly budget cannot be ${weeklyDollars} — give dollars, zero or more`)
  }
  store.run(
    `INSERT INTO show_budget (show_id, weekly_micro_dollars) VALUES (?, ?)
     ON CONFLICT (show_id) DO UPDATE
        SET weekly_micro_dollars = excluded.weekly_micro_dollars,
            set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    showId,
    Math.round(weeklyDollars * 1e6),
  )
  return showBudget(store, showId)!
}

export function showBudget(store: Store, showId: string): ShowBudget | undefined {
  const row = store.get<{ show_id: string; weekly_micro_dollars: number; set_at: string }>(
    'SELECT * FROM show_budget WHERE show_id = ?',
    showId,
  )
  if (!row) return undefined
  return {
    showId: row.show_id,
    weeklyMicroDollars: row.weekly_micro_dollars,
    weeklyDollars: row.weekly_micro_dollars / 1e6,
    setAt: row.set_at,
  }
}

/**
 * Monday, 00:00 UTC, of the week containing `now` — the timestamp the weekly query
 * compares against. A production week starts on Monday; UTC because every timestamp in
 * the library is UTC and a budget that shifted with the clock twice a year would be a
 * bug nobody could reproduce.
 *
 * `now` is a parameter rather than a call to the clock so that a test can state which
 * Monday it means instead of passing on some days and failing on others.
 */
export function weekStart(now: Date): string {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  // getUTCDay is 0 for Sunday; this is days elapsed since Monday.
  midnight.setUTCDate(midnight.getUTCDate() - ((midnight.getUTCDay() + 6) % 7))
  return midnight.toISOString()
}

export interface WeekStanding {
  showId: string
  /** The Monday this week is measured from. */
  weekStart: string
  /** Undefined when no budget is set — which is legal, and says so rather than showing zero. */
  budgetDollars: number | undefined
  spentDollars: number
  /** Negative when the week has gone over. It is not clamped: over-budget is a real state. */
  remainingDollars: number | undefined
  spend: CostTotals
  /** The sentence a screen renders — "$37.60 left of this week's $50.00". */
  sentence: string
}

/** What this show has spent since Monday, and what that leaves. */
export function remainingThisWeek(
  store: Store,
  showId: string,
  now: Date = new Date(),
): WeekStanding {
  const since = weekStart(now)
  const spend = costOfShowSince(store, showId, since)
  const budget = showBudget(store, showId)
  const remainingMicro =
    budget === undefined ? undefined : budget.weeklyMicroDollars - spend.microDollars

  // While anything went unpriced, every sentence below is a floor rather than a total,
  // and it says so — a budget bar that quietly omits what it could not price is worse
  // than no bar at all.
  const caveat =
    spend.unpricedCalls === 0
      ? ''
      : ` (at least — ${spend.unpricedCalls} ${plural(spend.unpricedCalls, 'call')} nobody could price)`

  let sentence: string
  if (budget === undefined || remainingMicro === undefined) {
    sentence = `${money(spend.microDollars)} spent since Monday — no weekly budget set${caveat}`
  } else if (remainingMicro >= 0) {
    sentence = `${money(remainingMicro)} left of this week's ${money(budget.weeklyMicroDollars)}${caveat}`
  } else {
    sentence = `${money(-remainingMicro)} over this week's ${money(budget.weeklyMicroDollars)}${caveat}`
  }

  return {
    showId,
    weekStart: since,
    budgetDollars: budget?.weeklyDollars,
    spentDollars: spend.dollars,
    remainingDollars: remainingMicro === undefined ? undefined : remainingMicro / 1e6,
    spend,
    sentence,
  }
}

// ── Projection ──────────────────────────────────────────────────────────────────

/**
 * What a button says before Ryan clicks it. "Every action button states verb + object +
 * scope + cost" — the button owns the first three; this is the fourth.
 */
export interface CostProjection {
  calls: number
  microDollars: number
  dollars: number
  /** 'unpriced' when the model has no rate card — the button must not pretend otherwise. */
  priced: CostPricing
  /** "1 Opus call, ~$0.85" — the tail of the button's own sentence. */
  sentence: string
}

/**
 * An estimate, stated in the same arithmetic the ledger will use afterwards, so that
 * "~$0.85" and the row it becomes are comparable. It is a projection: it is allowed to be
 * wrong, and the ledger is what was actually spent.
 *
 * `promptTokens` is the WHOLE prompt — system, canon in scope, the artifact so far — not
 * the uncached remainder. Say how much of it is expected to come back from cache and the
 * discount is applied; say nothing and it is priced at full rate, which is the honest
 * direction for a number on a button.
 */
export function projectLLMCost(plan: {
  model?: string
  calls?: number
  promptTokens: number
  outputTokens: number
  cachedPromptTokens?: number
}): CostProjection {
  const model = plan.model ?? DEFAULT_MODEL
  const calls = plan.calls ?? 1
  const cached = Math.min(plan.cachedPromptTokens ?? 0, plan.promptTokens)
  const perCall = priceLLMCall(
    model,
    tokenUsage({
      uncachedInput: plan.promptTokens - cached,
      cacheRead: cached,
      output: plan.outputTokens,
    }),
  )
  const label = MODEL_PRICE[model]?.label ?? model
  const noun = `${calls} ${label} ${plural(calls, 'call')}`

  if (perCall === undefined) {
    return {
      calls,
      microDollars: 0,
      dollars: 0,
      priced: 'unpriced',
      sentence: `${noun}, cost unknown (${model} is not in the price table)`,
    }
  }
  const microDollars = perCall * calls
  return {
    calls,
    microDollars,
    dollars: microDollars / 1e6,
    priced: 'rate-card',
    sentence: `${noun}, ~${money(microDollars)}`,
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────────

/** Micro-dollars as money: `$0.85`, `$12.40`, and `<$0.01` for a real but tiny amount. */
export function money(microDollars: number): string {
  if (microDollars > 0 && microDollars < 5000) return '<$0.01'
  return `$${(microDollars / 1e6).toFixed(2)}`
}

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`)

// ── Derivation ──────────────────────────────────────────────────────────────────

interface CostSiteIds {
  showId: string
  episodeId: string | null
  runId: string | null
  stepId: string | null
}

/**
 * Walks step → run → episode → show, filling in whatever the caller left out. Every cost
 * belongs to a show, because the budget is per show; a call that cannot be traced to one
 * is refused here rather than filed somewhere it will never be found.
 */
function siteOf(store: Store, draft: CostDraft): CostSiteIds {
  let runId = draft.runId ?? null
  const stepId = draft.stepId ?? null

  if (stepId && !runId) {
    const step = store.get<{ run_id: string }>('SELECT run_id FROM step WHERE id = ?', stepId)
    if (!step) throw new Error(`cannot charge a cost to step ${stepId}: no such step`)
    runId = step.run_id
  }

  let episodeId = draft.episodeId ?? null
  if (runId && !episodeId) {
    const run = store.get<{ episode_id: string }>('SELECT episode_id FROM run WHERE id = ?', runId)
    if (!run) throw new Error(`cannot charge a cost to run ${runId}: no such run`)
    episodeId = run.episode_id
  }

  let showId = draft.showId ?? null
  if (episodeId && !showId) {
    const show = store.get<{ show_id: string }>(
      `SELECT season.show_id FROM episode
         JOIN season ON season.id = episode.season_id
        WHERE episode.id = ?`,
      episodeId,
    )
    if (!show) throw new Error(`cannot charge a cost to episode ${episodeId}: no such episode`)
    showId = show.show_id
  }

  if (!showId) {
    throw new Error(
      'a cost must name the show it belongs to — pass showId, or a step, run, or episode ' +
        'to derive it from. Spend that belongs to no show cannot be budgeted.',
    )
  }
  return { showId, episodeId, runId, stepId }
}

// ── Queries ─────────────────────────────────────────────────────────────────────

interface TotalsRow {
  calls: number
  micro_dollars: number
  unpriced_calls: number
  failed_calls: number
  tokenless_calls: number
  uncached_input_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  output_tokens: number
}

/**
 * The one rollup query, given the clause that scopes it. Every `clause` passed to this is
 * a literal written a few lines above — there is no caller-supplied SQL here and there
 * must never be one.
 */
function totals(store: Store, clause: string, ...params: (string | number)[]): CostTotals {
  const row = store.get<TotalsRow>(
    `SELECT COUNT(*)                                        AS calls,
            COALESCE(SUM(micro_dollars), 0)                 AS micro_dollars,
            COALESCE(SUM(priced = 'unpriced'), 0)           AS unpriced_calls,
            COALESCE(SUM(outcome = 'failed'), 0)            AS failed_calls,
            COALESCE(SUM(uncached_input_tokens IS NULL), 0) AS tokenless_calls,
            COALESCE(SUM(uncached_input_tokens), 0)         AS uncached_input_tokens,
            COALESCE(SUM(cache_write_tokens), 0)            AS cache_write_tokens,
            COALESCE(SUM(cache_read_tokens), 0)             AS cache_read_tokens,
            COALESCE(SUM(output_tokens), 0)                 AS output_tokens
       FROM cost_entry WHERE ${clause}`,
    ...params,
  )!
  return {
    calls: row.calls,
    microDollars: row.micro_dollars,
    dollars: row.micro_dollars / 1e6,
    unpricedCalls: row.unpriced_calls,
    failedCalls: row.failed_calls,
    tokenlessCalls: row.tokenless_calls,
    uncachedInputTokens: row.uncached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    outputTokens: row.output_tokens,
    promptTokens: row.uncached_input_tokens + row.cache_write_tokens + row.cache_read_tokens,
  }
}

interface CostRow {
  seq: number
  kind: CostKind
  backend: string
  model: string
  outcome: CostOutcome
  micro_dollars: number
  priced: CostPricing
  uncached_input_tokens: number | null
  cache_write_tokens: number | null
  cache_read_tokens: number | null
  output_tokens: number | null
  show_id: string
  episode_id: string | null
  run_id: string | null
  step_id: string | null
  attempt: number | null
  at: string
}

const hydrateEntry = (row: CostRow): CostEntry => ({
  seq: row.seq,
  kind: row.kind,
  backend: row.backend,
  model: row.model,
  outcome: row.outcome,
  microDollars: row.micro_dollars,
  dollars: row.micro_dollars / 1e6,
  priced: row.priced,
  usage:
    row.uncached_input_tokens === null
      ? undefined
      : {
          uncachedInput: row.uncached_input_tokens,
          // The written row keeps one cache-write column: which TTL it was changed the
          // price, and that price is already in `micro_dollars`.
          cacheWrite5m: row.cache_write_tokens ?? 0,
          cacheWrite1h: 0,
          cacheRead: row.cache_read_tokens ?? 0,
          output: row.output_tokens ?? 0,
        },
  showId: row.show_id,
  episodeId: row.episode_id,
  runId: row.run_id,
  stepId: row.step_id,
  attempt: row.attempt,
  at: row.at,
})
