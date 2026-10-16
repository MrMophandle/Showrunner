import path from "node:path";
import type { Event } from "./events.js";
import type { AgentLimit, AgentOutcome, AgentStep, Emit, Executors, GateMessageRenderer, JsonSchema, RunContext } from "./steps.js";
import { isReservedEpisodeId } from "./ids.js";
import { loadPrompt, renderPrompt, type RenderExtra } from "./prompt-template.js";
import { DEFAULT_AUTO_RETRY_WEEKLY_UTILIZATION_MAX, resolveShowPath, seasonOf, ShowConfigError, type ShowConfig } from "./show-config.js";

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

/** One `rate_limit_event` from the SDK, as the executor reads it: the window that was hit, how much
 *  of it is used, and when it resets. `window` is the SDK's `rateLimitType` verbatim (`five_hour`,
 *  `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`) so a
 *  window the SDK adds later still reaches the operator by name; `resetsAt` is an ISO string, the
 *  SDK's epoch seconds having been converted in sdk-query.ts. Every field but `status` is optional
 *  because the SDK declares them so: an `allowed` event often carries nothing else. */
export interface AgentRateLimit {
  status: "allowed" | "allowed_warning" | "rejected";
  window?: string;
  resetsAt?: string;
  utilization?: number;
}

/** The plan's utilization windows as a percentage, from the SDK's experimental usage call — the one
 *  source of the **weekly** figure Ryan's auto-retry rule reads, which no `rate_limit_event` for the
 *  five-hour window carries. `available: false` means the question could not be answered at all (an
 *  API-key, Bedrock or Vertex session, where plan limits do not apply; or a call that was missing,
 *  threw, or did not answer in time), and the executor then refuses to auto-retry rather than
 *  guessing. A window's `utilization` and `resetsAt` are nullable because the SDK types them so. */
export interface AgentUsage {
  available: boolean;
  fiveHour?: { utilization: number | null; resetsAt: string | null };
  sevenDay?: { utilization: number | null; resetsAt: string | null };
}

/** The subset of the SDK's message stream the executor reads. sdk-query.ts maps the SDK's own
 *  types onto this shape; tests build these by hand. */
export interface AgentMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content: AgentContentBlock[] };
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: Array<{ tool_name?: string }>;
  /** `SDKAssistantMessage.error`, verbatim: the kind that ended the turn (`rate_limit` and the
   *  twelve others). Read off an assistant message, whose text blocks carry the SDK's own sentence
   *  about it, which is where the reset time's zone is named. */
  error?: string;
  /** From a `rate_limit_event` message. The executor keeps the last one of a stream: the windows
   *  report `allowed`, then `allowed_warning`, then `rejected` as one fills up. */
  rateLimit?: AgentRateLimit;
  /** The one synthetic message sdk-query.ts yields after a rejected limit, carrying the plan's
   *  utilization windows. Nothing in the SDK's own stream sets it. */
  usage?: AgentUsage;
}

/** Exactly the SDK options the executor sets. Field names match the SDK's Options so the adapter
 *  is a spread. permissionMode is dontAsk and settingSources is empty by construction: nothing
 *  outside the allowlist is approved, and nothing on the host machine leaks into a step. */
export interface AgentQueryOptions {
  cwd: string;
  model: string;
  tools: string[];
  allowedTools: string[];
  permissionMode: "dontAsk";
  settingSources: [];
  systemPrompt: { type: "preset"; preset: "claude_code" };
  abortController: AbortController;
  outputFormat?: { type: "json_schema"; schema: JsonSchema };
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
}

export type QueryFn = (args: { prompt: string; options: AgentQueryOptions }) => AsyncIterable<AgentMessage>;

export interface AgentExecutorOptions {
  /** The query seam. Production passes `sdkQuery` from ./sdk-query.js; tests pass a fake. It is
   *  required so that importing this module never loads the SDK. */
  query: QueryFn;
  /** Absolute path of the show's prompts directory. Default: the show config's promptsDir resolved
   *  against the show root when a config is given, else `<showRoot>/prompts`, per call. */
  promptsDir?: string;
  /** Model alias → model id. A model not in the map is passed to the SDK unchanged. */
  models?: Record<string, string>;
  /** The show's config; supplies promptsDir and models when the explicit options are absent, the
   *  {{season}}/{{show.*}} variables, and the weekly auto-retry ceiling
   *  (`agents.autoRetryWeeklyUtilizationMax`) the usage-limit rule compares against. */
  show?: ShowConfig;
  /** The clock the default sleeper measures a wait against. Injected by the tests only; production
   *  passes none and gets `() => new Date()`. It exists because the one thing the usage-limit rule
   *  does that a test cannot wait for is sleep for five hours. */
  now?: () => Date;
  /** Sleeps until the given ISO instant. Injected by the tests only; production passes none and
   *  gets a real `setTimeout`. The executor calls it once per step at most — after a five-hour
   *  limit whose weekly quota is under the ceiling — and the wait happens here, in the worker,
   *  with the run's lock heartbeat still running (spec §4.2: the server owns no run state). */
  sleepUntil?: (iso: string) => Promise<void>;
}

/** Thrown by `pump` when the total or the idle clock fires. Its message is the failure string. */
class Deadline extends Error {}

/** Thrown in place of a rejected `emit` so the executor tells an event-log failure apart from a
 *  query failure — the query and the SDK stream were healthy; the run log is what broke, and
 *  script-step.ts words the same fault `log write failed: <msg>`. The class is also what makes the
 *  classification unconditional: the `query failed` branch only fires when no result message has
 *  arrived, so an emit that rejected after a result was stored would otherwise be swallowed and the
 *  step would report success. */
class EmitFailure extends Error {}

/** Thrown in place of anything else the executor's own message handler throws — a stream whose
 *  shape the handler did not survive, as against a query that failed or a log that failed. Without
 *  the class such a throw would land in the `query failed` branch, which fires only when no result
 *  message has arrived, so a handler fault after a result was stored would be swallowed and the
 *  step would report the success it never finished reading. */
class HandlerFailure extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pumps `iterable` under two clocks — a total deadline and an idle deadline reset on every
 *  message — and hands each message to `onMessage`. When a clock fires it aborts `controller`,
 *  asks the iterator to return without waiting for it (the SDK's iterator may not honour the
 *  abort promptly, and a step must not hang on it), and throws Deadline with the reason.
 *
 *  Every other error out of the iterator or the handler gets the same abort-and-return treatment
 *  before it is rethrown: a rejected emit or a handler fault abandons the iterator mid-stream, and
 *  without the abort the SDK's child process would keep running with nobody draining it. */
async function pump(
  iterable: AsyncIterable<AgentMessage>,
  controller: AbortController,
  bounds: { timeoutMs?: number; idleTimeoutMs?: number },
  onMessage: (m: AgentMessage) => Promise<void>,
): Promise<void> {
  const it = iterable[Symbol.asyncIterator]();
  // The reason is recorded as well as rejected, because the race below cannot be trusted to
  // observe the rejection — see the check after it.
  let reason: string | undefined;
  let fire!: (reason: string) => void;
  const fired = new Promise<never>((_, reject) => { fire = (why) => { reason = why; reject(new Deadline(why)); }; });
  const total = bounds.timeoutMs !== undefined ? setTimeout(() => fire(`timeout after ${bounds.timeoutMs}ms`), bounds.timeoutMs) : undefined;
  let idle: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (bounds.idleTimeoutMs === undefined) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => fire(`idle timeout after ${bounds.idleTimeoutMs}ms`), bounds.idleTimeoutMs);
  };
  fired.catch(() => {}); // the race below observes it; this silences an unhandled-rejection report when nothing is racing
  armIdle();
  try {
    while (true) {
      const next = await Promise.race([it.next(), fired]);
      // Promise.race adopts its inputs in array order when both are already settled, so an
      // end-of-stream next() — which resolves synchronously — beats a `fired` that rejected during
      // the previous onMessage, and the pump would return normally from a step that had already
      // timed out. `fire` sets `reason` synchronously, so this makes "did a clock fire" a question
      // of state rather than of scheduling. The `fired` rejection still covers a clock that fires
      // while next() is genuinely pending.
      if (reason !== undefined) throw new Deadline(reason);
      if (next.done) return;
      armIdle();
      // onMessage is not raced against the clocks: a stalled handler — a log append that blocks —
      // delays the deadline by its own duration, and the clock is observed at the next next().
      await onMessage(next.value);
    }
  } catch (err) {
    // A clock that fired is the truth about this step even when the race adopted something else.
    // `fired` and a rejecting next() can both be settled when the race is set up, and Promise.race
    // then adopts the array-order first — the iterator's rejection — so the check after the await
    // never runs. `fire` sets `reason` synchronously, so it outranks the error raised beside it.
    const out = reason !== undefined && !(err instanceof Deadline) ? new Deadline(reason) : err;
    controller.abort();
    try { void it.return?.().catch(() => {}); } catch { /* a return() that throws synchronously has nothing to tell us */ }
    throw out;
  } finally {
    if (total) clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}

/** Where an executor built with these options looks for prompt, schema and gate-message files,
 *  resolved per call because the show root is the run context's. Shared with
 *  `createGateMessageRenderer` so a gate's message and an agent's prompt are never read from two
 *  different directories. */
function promptsDirFor(opts: AgentExecutorOptions, ctx: RunContext): string {
  return opts.promptsDir ?? (opts.show ? resolveShowPath(ctx.showRoot, opts.show.promptsDir) : path.join(ctx.showRoot, "prompts"));
}

/** The `{{season}}` and `{{show.*}}` half of a render, shared with `createGateMessageRenderer` so
 *  the two cannot drift. The season is resolved eagerly but is not required: an id the air map does
 *  not carry leaves it undefined, and only a template that writes {{season}} then fails, in the
 *  renderer. A malformed episode id is an InvalidEpisodeId rather than a ShowConfigError, is not
 *  swallowed here, and fails the caller before anything is logged or queried.
 *
 *  The reserved id the bible interview runs under (ids.ts) is not asked for a season at all: it
 *  names no episode, so `seasonOf` would throw InvalidEpisodeId for it and every interview step
 *  and gate message would fail to render. Skipping the lookup leaves `season` undefined, which
 *  means `{{season}}` is simply unavailable to an interview prompt — none names it — while a
 *  malformed id still throws here as it always did.
 *
 *  `vars` comes from the step rather than from the executor's options — the step declares them —
 *  and is spread in only when it was given, so a step with no vars leaves the field absent and
 *  `{{vars.*}}` fails with "vars are not available" rather than with a missing name.
 *
 *  `prior` and `round` come from the run's log and are **always** supplied, because their round-1
 *  values are real answers rather than absences: no previous verdict for anybody, round 1, nothing
 *  spent. See `roundExtras`. */
function renderExtraFor(opts: AgentExecutorOptions, ctx: RunContext, vars?: Record<string, string>): RenderExtra {
  let season: number | undefined;
  if (opts.show && !isReservedEpisodeId(ctx.episodeId)) {
    try {
      season = seasonOf(ctx.episodeId, opts.show.airMap);
    } catch (err) {
      if (!(err instanceof ShowConfigError)) throw err;
    }
  }
  const { prior, round } = roundExtras(ctx.events);
  return {
    ...(season !== undefined ? { season } : {}),
    ...(opts.show ? { show: opts.show as unknown as Record<string, unknown> } : {}),
    ...(vars !== undefined ? { vars } : {}),
    prior, round,
  };
}

/** The review round as a prompt sees it, read from the log's latest `panel_round`: the previous
 *  round's verdicts for `{{prior.<stepId>}}`, and the round about to run with its cost so far for
 *  `{{round.n}}` and `{{round.costUsd}}`.
 *
 *  **The log and not `ctx.results`, and that is the whole point** (inventory J-14). A red round
 *  resets the round's steps, and `step_reset` deletes each one's result from the derived state
 *  (`state.ts`), so by the time a reviewer re-runs its own last verdict is gone from `ctx.results`.
 *  It survives in the log, which `RunContext.events` already carries for exactly this kind of
 *  reader.
 *
 *  **Two records answer the round, and the later one wins.** A `panel_round` is written when a round
 *  came back **red**, so the pass about to run is the one after it: one of them in the log means
 *  `n` is 2. A panel's own `step_completed` is written when a round came back **green**, and that
 *  round is the one the run is in: `n` is its number, which is what the `script-gate` message means
 *  by "green after 2 round(s)". Taking only the red record would make the gate's sentence print the
 *  cost as it stood when the loop last failed — the closing panel and the revision before it
 *  missing, which on the measured figures is most of the total. With neither record it is round 1,
 *  nothing has been spent, and no step has a prior verdict: the three values a first pass needs,
 *  which is why they are supplied rather than left absent.
 *
 *  **`prior` comes from the red record only**, whichever is later. Only a red round has verdicts to
 *  hand on, and a green round's completion carries none; after a gate rejection re-runs a panel that
 *  had gone green, the reviewers are still shown the last verdicts anyone wrote.
 *
 *  Exported because the gate-message renderer and the agent executor both go through
 *  `renderExtraFor`, and a console or a test that wants the same reading of a log should not write a
 *  second one. */
export function roundExtras(events: readonly Event[] | undefined): { prior: Record<string, unknown>; round: { n: number; costUsd: number } } {
  let red: Event | undefined;
  let latest: { round: number; costUsd: number } | undefined;
  for (const e of events ?? []) {
    if (e.kind === "panel_round") {
      red = e;
      latest = { round: Number(e.payload["round"]) + 1, costUsd: Number(e.payload["costUsd"]) };
    } else if (e.kind === "step_completed" && e.payload["green"] === true && e.payload["round"] !== undefined) {
      latest = { round: Number(e.payload["round"]), costUsd: Number(e.payload["costUsd"]) };
    }
  }
  const verdicts = red?.payload["verdicts"];
  const prior = typeof verdicts === "object" && verdicts !== null && !Array.isArray(verdicts)
    ? (verdicts as Record<string, unknown>)
    : {};
  // A payload whose numbers a hand-edited log made unreadable must not render as `NaN` in a prompt
  // or in a gate message a showrunner approves: round 1 and nothing spent is the same answer as no
  // round at all, which is the conservative one.
  return {
    prior,
    round: {
      n: latest !== undefined && Number.isFinite(latest.round) ? latest.round : 1,
      costUsd: latest !== undefined && Number.isFinite(latest.costUsd) ? latest.costUsd : 0,
    },
  };
}

/** The renderer a gate's `messageFile` needs, for `RunOptions.renderGateMessage`. It is built from
 *  the same options as the agent executor and reuses the same two functions — `loadPrompt` for the
 *  file (refusing a path that escapes the prompts directory) and `renderPrompt` for the `{{...}}`,
 *  with the same `RenderExtra` — so a gate message and an agent prompt see one prompts directory
 *  and one set of variables. Every hole is a TemplateError, as it is for a prompt: the runner
 *  catches it and fails the gate rather than opening it with a message that lies.
 *
 *  `vars` is the gate's own `GateStep.vars`, handed over by the runner at the call: the renderer is
 *  built once for a whole run and cannot know which gate it is about to render, so the per-step
 *  values arrive as an argument rather than in `opts`. */
export function createGateMessageRenderer(opts: AgentExecutorOptions): GateMessageRenderer {
  return async (file: string, ctx: RunContext, vars?: Record<string, string>): Promise<string> => {
    const loaded = await loadPrompt(promptsDirFor(opts, ctx), file);
    return renderPrompt(loaded.text, ctx, renderExtraFor(opts, ctx, vars));
  };
}

/** Everything one query of a step produced, so the executor can decide between two attempts with
 *  the same information after each. `base` is the outcome the stream alone implies — the subtype
 *  chain, which knows nothing about usage limits — and the limit classification is applied to it
 *  afterwards, because the measured limit arrived as `subtype: "success"` with the SDK's "you've hit
 *  your session limit" sentence as its text, and a success that did no work must not be reported as
 *  one. */
interface Attempt {
  base: AgentOutcome;
  result: AgentMessage | undefined;
  failure: string | undefined;
  /** The last `rate_limit_event` of the stream, whatever its status, and the last **rejected** one.
   *  They are kept apart because one stream reports several windows: a five-hour rejection can be
   *  followed by an `allowed` seven-day event, and reading "the last event" as the limit would then
   *  blame the window that was still fine and refuse to wait out the one that was not. */
  rateLimit: AgentRateLimit | undefined;
  rejected: AgentRateLimit | undefined;
  /** The seven-day quota as a percentage, read off a seven-day `rate_limit_event` in this stream.
   *  The **first** source of the weekly figure the auto-retry rule reads, ahead of the usage call:
   *  it arrives on the stream the query already delivered, with nothing to ask and nothing to time
   *  out. */
  weeklyFromEvent: number | undefined;
  usage: AgentUsage | undefined;
  sdkError: { kind: string; text: string } | undefined;
}

/** The SDK's name for the five-hour plan window — the only window the engine waits out on its own
 *  authority. */
const FIVE_HOUR = "five_hour";

/** The window name used when a limit arrived as an assistant `error: "rate_limit"` with no
 *  `rate_limit_event` beside it to say which window was hit. It reaches the log as the limit's
 *  `window` so the record never claims a window the SDK did not name. */
const UNNAMED_WINDOW = "unknown";

/** How long past a reset the executor waits before resuming. The window's clock and this machine's
 *  are not the same clock, and a query resumed on the second the window turns over is rejected
 *  again — a whole second wait for the sake of a minute. */
const WAIT_GRACE_MS = 60_000;

/** The longest wait the executor will take on a reset time the SDK sent, and the reason it has a
 *  ceiling at all: **a five-hour window cannot reset later than five hours after it was hit.** An
 *  hour on top covers the clock skew `WAIT_GRACE_MS` exists for and the grace itself, so a wake
 *  instant further ahead than this is not a reset time the engine can believe — most plausibly a
 *  unit change, an SDK that sends milliseconds where it sent epoch seconds mapping to a date in the
 *  year 58,000.
 *
 *  Refusing it is what keeps the log honest. A wait of that length would claim the step and the
 *  run's lock for as long as the number said, and `setTimeout`'s 24.8-day ceiling would fire the
 *  timer at once in any case — so the step would record `waited: true` for a sleep that took no
 *  time, which is the one thing ruling I-22 exists to prevent. An incredible reset takes the same
 *  path as one already past: no sleep, and the retry runs at once. */
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

/** The default sleeper: a real timer, to the millisecond the wake instant's ISO names. Production
 *  uses it for waits of up to five hours, which is well inside `setTimeout`'s 24.8-day ceiling.
 *
 *  **One reader checks the instant, and it is not this one.** The executor's call site is where an
 *  unreadable or already-past wake instant is caught, because the arithmetic that builds it there
 *  (`Date.parse(resetsAt) + WAIT_GRACE_MS`) is what would throw a `RangeError` on an unparseable
 *  reset — and a throw out of the executor is reserved for an unwritable event log (`steps.ts`'s
 *  `Executors` contract). So by the time an ISO reaches this function it has parsed and was still
 *  ahead of `now()`; `Math.max(0, …)` is the clamp for the milliseconds that pass between that
 *  check and this timer, not a second guard against the same fault. */
function sleepWithRealTimer(iso: string, now: () => Date): Promise<void> {
  const until = Date.parse(iso);
  return new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, until - now().getTime())); });
}

/** What the SDK named as the reason this attempt ended, or undefined when it named nothing.
 *
 *  A deadline, a rejected emit or a handler fault outranks it and returns undefined: those are the
 *  engine's own faults and already have their own wording, and a timeout that happened to coincide
 *  with a limit is still a timeout. Otherwise an assistant `error` kind wins, and a rejected
 *  `rate_limit_event` with no error kind beside it is a usage limit too — the engine's one measured
 *  limit (the s02e01 run of 2026-10-14) carried both, but the rejection alone is enough to know the
 *  query was refused. */
function classifyLimit(a: Attempt): AgentLimit | undefined {
  if (a.failure !== undefined) return undefined;
  if (a.sdkError !== undefined) return a.sdkError.kind === "rate_limit" ? { kind: "rate_limit", window: limitedWindow(a) ?? UNNAMED_WINDOW, waited: false } : { kind: a.sdkError.kind };
  if (a.rejected !== undefined) return { kind: "rate_limit", window: a.rejected.window ?? UNNAMED_WINDOW, waited: false };
  return undefined;
}

/** The window the limit was hit on, and the reset the operator is waiting for: the rejected event's
 *  when the stream carried one, else the last event's, which at least names a window for a limit
 *  that arrived as an assistant `error` with no rejection beside it. */
function limitedWindow(a: Attempt): string | undefined {
  return (a.rejected ?? a.rateLimit)?.window;
}
function limitedReset(a: Attempt): string | undefined {
  return (a.rejected ?? a.rateLimit)?.resetsAt;
}

/** The weekly quota as a percentage and where it came from: **the stream's own seven-day event
 *  first**, the SDK's experimental usage call second.
 *
 *  The order is not a preference, it is a reliability ranking. The event is part of the message
 *  stream the query already delivered; the usage call is a control request, which `sdk.d.ts` says is
 *  supported only on a streaming-input session while the engine passes a plain string prompt — so it
 *  can answer with nothing, and then the rule would refuse to auto-retry a limit it could in fact
 *  have waited out. Whichever source answered is recorded on the limit, so the log says which
 *  number the decision was made on. */
function weeklyFigure(a: Attempt): { value: number; source: "event" | "usage" } | undefined {
  if (a.weeklyFromEvent !== undefined) return { value: a.weeklyFromEvent, source: "event" };
  const fromCall = weeklyUtilization(a.usage);
  return fromCall === undefined ? undefined : { value: fromCall, source: "usage" };
}

/** The seven-day quota as a percentage, or undefined when the question could not be answered: the
 *  usage call was unavailable, carried no seven-day window, or carried one with no figure. The
 *  distinction matters because Ryan's rule retries only on a **known** weekly figure below the
 *  ceiling, and "unknown" is a manual resume, not a zero. */
function weeklyUtilization(usage: AgentUsage | undefined): number | undefined {
  if (usage?.available !== true) return undefined;
  const u = usage.sevenDay?.utilization;
  return typeof u === "number" && Number.isFinite(u) ? u : undefined;
}

/** Whether a window is a weekly one **for classification**: any of the four names the SDK declares
 *  that begin `seven_day` (`seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 *  `seven_day_overage_included`). All four are weekly limits the engine never waits out on its own
 *  authority, and all four read "7-day" in the operator's sentence. This is deliberately **not** the
 *  test for the weekly *figure* — see `isAccountWeeklyWindow`. */
function isSevenDay(window: string | undefined): boolean {
  return window !== undefined && window.startsWith("seven_day");
}

/** Whether a window is the **account-wide** weekly window, whose utilization is "the weekly figure"
 *  Ryan's rule reads against the ceiling.
 *
 *  Only `seven_day` is. The per-model kinds (`seven_day_opus`, `seven_day_sonnet`,
 *  `seven_day_overage_included`) are weekly limits for classification and are not this number,
 *  because the two answer different questions: a `seven_day_opus` event at 90% would block a wait
 *  the account-wide window at 20% allows, and a `seven_day_sonnet` event at 5% would authorize a
 *  five-hour wait while the account-wide window sits at 95% — the retry then spends the one wait and
 *  fails anyway. Which way it erred would depend on which per-model window the SDK happened to
 *  report. This is the same choice `toUsage` makes about the usage call's per-model rows
 *  (`sdk-query.ts`), so the rule's two sources answer one question. */
function isAccountWeeklyWindow(window: string | undefined): boolean {
  return window === "seven_day";
}

/** The operator's name for a plan window: `5-hour`, `7-day` for all four seven-day kinds, the
 *  SDK's own name for anything else (`overage`), and `usage` when the SDK named no window at all —
 *  so the sentence reads "hit its usage limit" rather than "hit its unknown limit". */
function windowLabel(window: string | undefined): string {
  if (window === FIVE_HOUR) return "5-hour";
  if (isSevenDay(window)) return "7-day";
  if (window === undefined || window === UNNAMED_WINDOW) return "usage";
  return window;
}

/** `(resets <time>)` as the sentences use it, or the empty string when no reset time is known — the
 *  clause is dropped rather than printed with a hole in it. */
function resetsClause(time: string | undefined): string {
  return time === undefined ? "" : ` (resets ${time})`;
}

/** The reset time as the operator reads it: **the zone the SDK's own sentence names, when it names
 *  one**, else the ISO string from the rate-limit event, else undefined.
 *
 *  The SDK's text is the only source of a zone — the event carries epoch seconds and nothing else —
 *  and the measured sentence was `You've hit your session limit · resets 7:50pm
 *  (America/New_York)`, which this renders as `7:50pm America/New_York`. The captured time may
 *  carry a weekday (`Mon 9:00am`) for a seven-day window.
 *
 *  **Module-private on purpose.** One rendering in one place is what keeps the engine's failure
 *  sentences and the `step_waiting` reason from drifting apart, and nothing outside this module has
 *  any business with it: the console renders the same reset in the **browser's** zone through its
 *  own `resetLabel` (Plan I's display ruling), deliberately a different answer, and the tests pin
 *  this one through the sentences that carry it. */
function renderResetTime(sdkText: string | undefined, resetsAtIso: string | undefined): string | undefined {
  const named = sdkText?.match(/resets\s+(.+?)\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/);
  if (named) return `${named[1]} ${named[2]}`;
  return resetsAtIso;
}

/** The step's error when the reply was refused for one of the twelve SDK error kinds that are not a
 *  usage limit — `billing_error`, `authentication_failed`, `overloaded` and the rest. No wait and no
 *  retry: none of them is cured by time (Ryan's ruling of 2026-10-15). */
function refusedSentence(kind: string, text: string): string {
  return `the model's reply was refused (${kind}): ${text}`;
}

/** The step's error when a usage limit will not be waited out: one sentence, with the numbers, that
 *  names the window, the reset, the weekly figure and the operator's move (Ryan's ruling of
 *  2026-10-15).
 *
 *  Four shapes, because four things can be true. A five-hour limit whose weekly quota is known and
 *  not below the ceiling names both percentages and the config key that sets the ceiling. A
 *  five-hour limit whose weekly quota could not be read says so, because the engine declined to
 *  wait on a figure it does not have. A five-hour limit under the ceiling that the SDK gave no reset
 *  time for cannot be waited out either, and says which half is missing. Every other window — the
 *  three seven-day kinds, `overage`, or none named — is never auto-retried at all, so its sentence
 *  only has to say when to come back. */
function manualResumeSentence(o: { window: string | undefined; time: string | undefined; weekly: number | undefined; ceiling: number }): string {
  const opening = limitOpening(o.window);
  if (o.window !== FIVE_HOUR) return `${opening}${resetsClause(o.time)}; press Resume after the reset.`;
  if (o.weekly === undefined) return `${opening}${resetsClause(o.time)} and the weekly utilization is unknown.`;
  // Reachable only when the SDK named no reset time: a five-hour limit under the ceiling *with* a
  // reset time is the one case the executor waits out, and never arrives here.
  if (o.weekly < o.ceiling) return `${opening} and the SDK named no reset time to wait for; press Resume once the window has reset.`;
  const relation = o.weekly > o.ceiling ? `above the ${o.ceiling}% auto-retry ceiling` : `at the ${o.ceiling}% auto-retry ceiling`;
  return `${opening}${resetsClause(o.time)} and the weekly quota is at ${o.weekly}%, ${relation} (agents.autoRetryWeeklyUtilizationMax).`;
}

/** The two words every sentence that hands the run back to the operator starts with. One constant
 *  because the sentences are built in two places now — the executor's usage-limit shapes here, and
 *  the `panel` step's weekly stop (`panelStopSentence`, read by the runner) — and the console's
 *  operator-facing copy keys on the phrase. A literal written twice is a literal reworded once. */
const MANUAL_RESUME = "Manual resume needed:";

/** The opening that every usage-limit sentence shares. Written once because six sentence shapes
 *  hang off it — four from `manualResumeSentence` and `limitedAgainSentence`'s two arms — and the
 *  same literal in two builders is a literal that gets reworded in one of them. */
function limitOpening(window: string | undefined): string {
  return `${MANUAL_RESUME} the writer's session hit its ${windowLabel(window)} limit`;
}

/** The step error a `panel` writes instead of starting another round, when the week's quota is at or
 *  above the show's auto-retry ceiling (Ryan's ruling of 2026-10-15, Plan J ruling 6).
 *
 *  It is built here, beside Plan I's sentences, rather than in the runner, because this module owns
 *  every sentence that asks the operator for a Resume and they have to read as one voice: the same
 *  opening, the same bare percentages, the same named config key in parentheses. The runner imports
 *  it; nothing else in the engine builds an operator sentence.
 *
 *  **"at or above", where Plan I's `manualResumeSentence` says "at" or "above".** The panel's rule is
 *  one `>=` comparison and has one sentence, so the phrase states the test; the executor's rule is
 *  reached from a `<` test and distinguishes the two sides because its reader is deciding whether a
 *  wait was owed. The numbers are the figure the log carried and the ceiling that refused it, as
 *  percentages, which is the form every other usage sentence and the console's own copy use. */
export function panelStopSentence(o: { round: number; weekly: number; ceiling: number }): string {
  return `${MANUAL_RESUME} the panel is still red after round ${o.round} and the weekly quota is at ${o.weekly}%, `
    + `at or above the ${o.ceiling}% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax); `
    + "press Resume after the reset to continue the loop.";
}

/** The step's error when the limit tripped again on the retry. One wait is all the executor takes
 *  (Ryan's ruling of 2026-10-15: a second limit after one wait is the operator's), and the sentence
 *  says that a wait was already spent so the operator does not read it as the first refusal.
 *
 *  `waited` is false for the one retry that spends no wait — a wake instant the clock had already
 *  passed is retried at once (ruling I-22) — and the sentence then says "again on the retry",
 *  because "again after waiting once" would be a claim about hours that nobody spent. */
function limitedAgainSentence(window: string | undefined, time: string | undefined, waited: boolean): string {
  return `${limitOpening(window)} ${waited ? "again after waiting once" : "again on the retry"}${resetsClause(time)}; press Resume after the reset.`;
}

/** `step_waiting`'s `reason`: the log's record of why the step stopped, and the sentence the console
 *  prints under the Board's stage chip and on every waiting rail row.
 *
 *  Four shapes, because the rule can fire on a reset instant that is not a thing to sleep until.
 *  `sleeping` is the ordinary case and the only one that claims a wait; the other three say the
 *  retry ran at once, because a reason reading "waiting for the usage limit to reset at …" beside a
 *  sleep of zero seconds would be the log recording a wait that never happened.
 *
 *  The three refusals name the **raw** `resetsAt` rather than the time rendered out of the SDK's
 *  prose, deliberately: the prose time is the part that looks credible ("7:50pm
 *  America/New_York"), and what the operator needs to see is the value the engine actually
 *  refused. The incredible case names how far ahead it was, because the number is the evidence. */
function waitingReason(o: { time: string | undefined; resetsAt: string; weekly: number; sleeping: boolean; readable: boolean; credible: boolean; aheadMs: number }): string {
  const quota = ` (weekly quota ${o.weekly}%)`;
  if (o.sleeping) return `waiting for the usage limit to reset at ${o.time ?? o.resetsAt}${quota}`;
  if (!o.readable) return `the usage limit's reset time ${o.resetsAt} could not be read as an instant; resuming at once${quota}`;
  if (!o.credible) return `the usage limit's reset time ${o.resetsAt} is ${Math.round(o.aheadMs / 3_600_000)} hours ahead, further than a 5-hour window can reset; resuming at once${quota}`;
  return `the usage limit's reset at ${o.time ?? o.resetsAt} had already passed; resuming at once${quota}`;
}

export function createAgentExecutor(opts: AgentExecutorOptions): Executors["agent"] {
  /** context: "shared" — session ids by `${episodeId}/${runId}/${stepId}`, for this executor's
   *  lifetime. The episode id is part of the key because a run id is only unique within an episode:
   *  two episodes could carry the same run-id string, and one long-lived executor (a console process
   *  that runs several episodes in turn) would then resume the first episode's session inside the
   *  second. A restart makes a new executor, so a resumed run's shared step starts a fresh session;
   *  the agent_query it logs says resumed: false, which is the record of that. */
  const sessions = new Map<string, string>();

  return async (step: AgentStep, ctx: RunContext, emit: Emit): Promise<AgentOutcome> => {
    // 1–2: the prompt and the schema, checked before anything is logged or queried.
    const promptsDir = promptsDirFor(opts, ctx);
    let prompt: string;
    let promptHash: string;
    let promptPath: string;
    try {
      const loaded = await loadPrompt(promptsDir, step.promptFile);
      promptHash = loaded.hash;
      promptPath = loaded.path;
      prompt = renderPrompt(loaded.text, ctx, renderExtraFor(opts, ctx, step.vars));
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    // The schema, from the step or from a file beside the prompts. The two are exclusive: a step
    // carrying both has two answers to "what shape is this verdict" and no way to tell which the
    // author meant, so the step fails rather than one of them winning silently.
    if (step.schema !== undefined && step.schemaFile !== undefined) {
      return { ok: false, error: "schema and schemaFile are exclusive" };
    }
    let schema: JsonSchema | undefined = step.schema;
    if (schema === undefined && step.schemaFile !== undefined) {
      let text: string;
      try {
        text = (await loadPrompt(promptsDir, step.schemaFile)).text;
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return { ok: false, error: `schema file ${JSON.stringify(step.schemaFile)} is not valid JSON: ${errorMessage(err)}` };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: `schema file ${JSON.stringify(step.schemaFile)} must be a JSON object` };
      }
      schema = parsed as JsonSchema;
    }
    // An allowlist rather than a denylist: the SDK validates against draft-07 only, so anything a
    // `$schema` names that is not draft-07 is refused, including a draft this code has never heard
    // of. A schema with no `$schema` key at all is accepted — draft-07 is the SDK's default. The
    // check is the same whether the schema came from the step or from a file.
    const declared = schema?.["$schema"];
    if (typeof declared === "string" && !declared.includes("draft-07")) {
      return { ok: false, error: `schema must be JSON Schema draft-07, got ${declared}` };
    }

    // 3: the options.
    const models: Record<string, string | undefined> | undefined = opts.models ?? opts.show?.models;
    const model = models?.[step.model] ?? step.model;
    // The usage-limit rule's three seams. `ceiling` falls back to the house default for a
    // ShowConfig built by hand that never passed through loadShowConfig, which materialises the
    // same number; the clock and the sleeper are real timers unless a test injected its own.
    const now = opts.now ?? (() => new Date());
    const sleepUntil = opts.sleepUntil ?? ((iso: string) => sleepWithRealTimer(iso, now));
    const ceiling = opts.show?.agents?.autoRetryWeeklyUtilizationMax ?? DEFAULT_AUTO_RETRY_WEEKLY_UTILIZATION_MAX;
    const abortController = new AbortController();
    // Both the read and the write of the session map are gated on "shared", so the policy is one
    // predicate rather than two that have to agree: a "fresh" step leaves no entry behind that a
    // later query could resume, whatever it does with its session id.
    const sessionKey = `${ctx.episodeId}/${ctx.runId}/${step.id}`;
    const resume = step.context === "shared" ? sessions.get(sessionKey) : undefined;
    const options: AgentQueryOptions = {
      cwd: ctx.showRoot,
      model,
      tools: step.allowedTools.filter((t) => !t.startsWith("mcp__")),
      allowedTools: [...step.allowedTools],
      permissionMode: "dontAsk",
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code" },
      abortController,
      ...(schema ? { outputFormat: { type: "json_schema" as const, schema } } : {}),
      ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
      ...(step.maxBudgetUsd !== undefined ? { maxBudgetUsd: step.maxBudgetUsd } : {}),
      ...(resume !== undefined ? { resume } : {}),
    };

    // 4–9 happen once per attempt. There are two attempts at most: a plan usage limit on the
    //     five-hour window, with the week's quota under the configured ceiling, is waited out here
    //     and the same query is resumed once (Ryan's ruling of 2026-10-15). `toolCalls` and
    //     `sessionId` are shared across the attempts on purpose — the agent_tool_call index stays
    //     monotone in the log, agent_result reports the step's whole tool count, and the retry
    //     resumes the session the limited attempt opened.
    let toolCalls = 0;
    let sessionId: string | undefined;

    const attempt = async (attemptOptions: AgentQueryOptions): Promise<Attempt> => {
      // 4: agent_query — one per query, so a resumed retry is its own line in the log with
      //    `resumed: true`, which is the only record that the step queried twice.
      await emit("agent_query", {
        promptFile: step.promptFile, promptHash, promptPath, model, modelAlias: step.model,
        allowedTools: [...step.allowedTools], context: step.context, schema: Boolean(schema), resumed: Boolean(attemptOptions.resume),
        showConfig: Boolean(opts.show),
      });

      // 5–7: drive the stream under the total and idle deadlines. The executor never relies on the
      //      iterator honouring the abort: pump races each next() against its own clocks.
      let result: AgentMessage | undefined;
      let failure: string | undefined;
      let rateLimit: AgentRateLimit | undefined;
      let rejected: AgentRateLimit | undefined;
      let weeklyFromEvent: number | undefined;
      let usage: AgentUsage | undefined;
      let sdkError: { kind: string; text: string } | undefined;
      try {
        await pump(opts.query({ prompt, options: attemptOptions }), attemptOptions.abortController, { ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}), ...(step.idleTimeoutMs !== undefined ? { idleTimeoutMs: step.idleTimeoutMs } : {}) }, async (m) => {
          // Every fault raised in here is classified before it leaves, so the `query failed` branch
          // below sees only what the iterator itself threw.
          try {
            if (m.session_id && !sessionId) sessionId = m.session_id;
            // One stream reports several windows, each as its own event. The last of any status is
            // kept, the last *rejected* one is kept separately as the limit that was hit, and the
            // **account-wide** seven-day event's utilization is the weekly figure the rule prefers
            // — it is on the stream already, where the usage call has to be asked for and can go
            // unanswered. A per-model seven-day event is not that figure (`isAccountWeeklyWindow`),
            // which is what keeps this source and the usage call answering one question.
            if (m.rateLimit !== undefined) {
              rateLimit = m.rateLimit;
              if (m.rateLimit.status === "rejected") rejected = m.rateLimit;
              if (isAccountWeeklyWindow(m.rateLimit.window) && typeof m.rateLimit.utilization === "number" && Number.isFinite(m.rateLimit.utilization)) {
                weeklyFromEvent = m.rateLimit.utilization;
              }
            }
            if (m.usage !== undefined) usage = m.usage;
            if (m.type === "assistant" && m.message) {
              // The first error kind wins, with the text of the same message: that message's text
              // blocks carry the SDK's own sentence about the fault, and a later assistant message
              // would describe a different one.
              if (m.error !== undefined && sdkError === undefined) {
                sdkError = { kind: m.error, text: m.message.content.filter((b): b is { type: "text"; text: string } => b.type === "text" && "text" in b).map((b) => b.text).join("\n") };
              }
              for (const block of m.message.content) {
                if (block.type === "tool_use" && "name" in block) {
                  toolCalls += 1;
                  try {
                    await emit("agent_tool_call", { tool: block.name, input: block.input, toolUseId: block.id, index: toolCalls });
                  } catch (err) {
                    throw new EmitFailure(errorMessage(err));
                  }
                }
              }
            } else if (m.type === "result") {
              result = m;
            }
          } catch (err) {
            if (err instanceof EmitFailure) throw err;
            throw new HandlerFailure(errorMessage(err));
          }
        });
      } catch (err) {
        // The result is deliberately left in place. `r` below is computed from `failure`, so a
        // failure still wins the outcome; keeping the message means agent_result can still report the
        // subtype, turns, duration, cost and session id of a result that raced in before the clock
        // was observed, which is the only record of what the query had spent when it was cut off.
        if (err instanceof Deadline) { failure = err.message; }
        else if (err instanceof EmitFailure) { failure = `log write failed: ${err.message}`; }
        else if (err instanceof HandlerFailure) { failure = `message handling failed: ${err.message}`; }
        // What is left is the iterator's own throw. A result already stored wins over it: the SDK
        // throws after yielding an error result, and that result classifies the failure precisely.
        else if (!result) failure = `query failed: ${errorMessage(err)}`;
      }

      // 8: the outcome the stream alone implies, before anything the SDK named is considered. A
      //    deadline, a rejected emit or a handler fault outranks the result that raced in: `r` is a
      //    result only when nothing has already failed, so the total timeout wins over a result
      //    that arrived after it. The result message itself is kept, and step 9 still reports its
      //    metadata.
      const r = failure !== undefined ? undefined : result;
      let base: AgentOutcome;
      if (r === undefined) {
        base = { ok: false, error: failure ?? "query ended without a result message", toolCalls };
      } else if (r.subtype === undefined) {
        base = { ok: false, error: "result message with no subtype", toolCalls };
      } else if (r.subtype === "success") {
        if (schema && r.structured_output === undefined) {
          base = { ok: false, error: "success without structured output", toolCalls };
        } else {
          base = {
            ok: true, text: r.result ?? "", toolCalls,
            ...(schema ? { verdict: r.structured_output } : {}),
          };
        }
      } else {
        const errors = r.errors ?? [];
        base = { ok: false, error: errors.length ? `${r.subtype}: ${errors.join("; ")}` : r.subtype, toolCalls };
      }
      return { base, result, failure, rateLimit, rejected, weeklyFromEvent, usage, sdkError };
    };

    const first = await attempt(options);
    let last = first;
    let outcome = first.base;
    // The limit as the log will carry it, which is not the same as the limit the outcome carries: a
    // step that waited and then succeeded is `ok: true` and still has to record that it waited.
    let limit: AgentLimit | undefined;

    const firstLimit = classifyLimit(first);
    if (firstLimit !== undefined && firstLimit.kind !== "rate_limit") {
      // The other twelve SDK error kinds: no wait, no retry (Ryan's ruling of 2026-10-15).
      limit = firstLimit;
      outcome = { ok: false, error: refusedSentence(firstLimit.kind, first.sdkError?.text ?? ""), toolCalls, limit };
    } else if (firstLimit !== undefined) {
      const window = limitedWindow(first);
      const resetsAt = limitedReset(first);
      const weekly = weeklyFigure(first);
      const time = renderResetTime(first.sdkError?.text, resetsAt);
      limit = {
        kind: "rate_limit", waited: false,
        window: window ?? UNNAMED_WINDOW,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(weekly !== undefined ? { weeklyUtilization: weekly.value, weeklySource: weekly.source } : {}),
      };
      if (window === FIVE_HOUR && weekly !== undefined && weekly.value < ceiling && resetsAt !== undefined) {
        // The rule: wait here, in the worker, with the run's lock heartbeat running (spec §4.2),
        // and resume the same query once. The reason is written into the log because the log is the
        // record (spec §6.5) and the console draws the wait from it rather than from a string of
        // its own.
        //
        // **One minute past the reset, not the reset** (ruling I-03): the two clocks are not the
        // same clock, and a query resumed on the second the window turns over is rejected again for
        // the sake of a minute. That wake instant is also the one thing checked before any sleeper
        // is called, and this is the only place that checks it (ruling I-22). Three things make a
        // reset no reset: one the SDK sent in a form that will not parse, one the clock has already
        // passed, and one further ahead than MAX_WAIT_MS — a five-hour window cannot reset in forty
        // years. All three are retried **at once**: `step_waiting` is still written, because it is
        // the log's only record that the rule fired at all, and its reason says which of the three
        // it was rather than claiming a sleep of zero seconds. `waited` then carries the same truth
        // onto `agent_result`.
        const resetMs = Date.parse(resetsAt);
        const wakeMs = resetMs + WAIT_GRACE_MS;
        const readable = Number.isFinite(resetMs);
        const aheadMs = wakeMs - now().getTime();
        const credible = readable && aheadMs <= MAX_WAIT_MS;
        const sleeping = credible && aheadMs > 0;
        const reason = waitingReason({ time, resetsAt, weekly: weekly.value, sleeping, readable, credible, aheadMs });
        await emit("step_waiting", { reason, window, resetsAt, weeklyUtilization: weekly.value, ceiling });
        if (sleeping) await sleepUntil(new Date(wakeMs).toISOString());
        const retry = await attempt({ ...options, abortController: new AbortController(), ...(sessionId !== undefined ? { resume: sessionId } : {}) });
        last = retry;
        const retryLimit = classifyLimit(retry);
        if (retryLimit === undefined) {
          // The retry ran. Its outcome is the step's — success or any ordinary failure — and the
          // limit stays on the log with `waited`, which is the record of whether this step spent a
          // wait; either way it is owed no second one.
          outcome = retry.base;
          limit = { kind: "rate_limit", window, resetsAt, weeklyUtilization: weekly.value, weeklySource: weekly.source, waited: sleeping };
        } else if (retryLimit.kind !== "rate_limit") {
          // The retry was refused for something else entirely — the credit ran out, the account was
          // suspended. The step reports that reason, and `waited` rides along so the log still says
          // a wait was spent on this step: `step_waiting` is in the log too, but a reader looking at
          // `agent_result.limit` alone would otherwise see no trace of the five hours.
          limit = { kind: retryLimit.kind, waited: sleeping };
          outcome = { ok: false, error: refusedSentence(retryLimit.kind, retry.sdkError?.text ?? ""), toolCalls, limit };
        } else {
          const again = {
            window: limitedWindow(retry) ?? window,
            resetsAt: limitedReset(retry) ?? resetsAt,
            weekly: weeklyFigure(retry) ?? weekly,
          };
          limit = {
            kind: "rate_limit", waited: sleeping, window: again.window,
            ...(again.resetsAt !== undefined ? { resetsAt: again.resetsAt } : {}),
            weeklyUtilization: again.weekly.value, weeklySource: again.weekly.source,
          };
          outcome = { ok: false, error: limitedAgainSentence(again.window, renderResetTime(retry.sdkError?.text, again.resetsAt), sleeping), toolCalls, limit };
        }
      } else {
        outcome = { ok: false, error: manualResumeSentence({ window, time, weekly: weekly?.value, ceiling }), toolCalls, limit };
      }
    }

    if (step.context === "shared" && sessionId !== undefined) sessions.set(sessionKey, sessionId);

    // 9: agent_result, once for the step however many attempts it made. The metadata is the last
    //    attempt's, because that is the query whose outcome the step returns.
    const result = last.result;
    const denials = result?.permission_denials ?? [];
    const deniedTools = [...new Set(denials.map((d) => d.tool_name).filter((n): n is string => typeof n === "string"))];
    await emit("agent_result", {
      ok: outcome.ok, toolCalls,
      ...(result?.subtype !== undefined ? { subtype: result.subtype } : {}),
      ...(result?.num_turns !== undefined ? { numTurns: result.num_turns } : {}),
      ...(result?.duration_ms !== undefined ? { durationMs: result.duration_ms } : {}),
      ...(result?.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      permissionDenials: denials.length, deniedTools,
      ...(limit !== undefined ? { limit } : {}),
      // The plan's utilization windows as the wrapper answered them for this query, on every query
      // and not only a limited one (Plan J, ruling 6). Until this field existed the figure reached
      // the log only through `limit.weeklyUtilization` or `step_waiting`, both of which need a
      // classified limit, so an unlimited run carried no weekly figure at all (inventory J-19: zero
      // in all fourteen logs measured). A `panel` step reads the latest of these before it starts
      // another round, and What-happened can answer "how full was the week when this ran". Absent
      // when the wrapper yielded no usage message, which is how a query that never opened a stream
      // reads.
      ...(last.usage !== undefined ? { usage: last.usage } : {}),
      ...(outcome.ok && schema ? { verdict: outcome.verdict } : {}),
      ...(outcome.ok && !schema ? { text: outcome.text } : {}),
      ...(!outcome.ok ? { error: outcome.error } : {}),
    });
    return outcome;
  };
}
