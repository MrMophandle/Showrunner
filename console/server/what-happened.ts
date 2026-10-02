import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import {
  EventLog, describePipeline, episodePipeline, hashFile, parseEpisodeId, pipelineHash, resolveShowPath, sdkQuery,
  type AgentQueryOptions, type Event, type QueryFn,
} from "@showrunner/engine";
import type { PromptAtRun, WhatHappenedContext, WireEvent } from "../shared/types.js";
import type { RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";

/** "What happened": the run's own record, assembled, and an agent that answers questions about it.
 *
 *  The console already shows what a run did. This answers why, and it does so from the log rather
 *  than from a model's memory of how the pipeline is supposed to work: `assemble` hands the agent
 *  the pipeline as a document, the run at the middle altitude, the run's events with the chatter
 *  collapsed, every prompt the run read with its hash then and now, and every file the run wrote.
 *  The agent's tools are the three read-only ones, so an explanation of a failure can never become
 *  an edit to the show it is explaining. */

/** The tools the troubleshooter is given, and the only ones it can be given. `Read` opens the run
 *  log, the prompts and the artifacts; `Glob` and `Grep` find the handful of relevant lines in a
 *  log of thousands without pulling the whole file into the context window. `Write` and `Edit`
 *  would let an account of a failure silently change the show it is accounting for, and `Bash`
 *  would put git, the Python steps and a four-hour render inside what is nominally a question. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** How many lines of a step's output the context keeps. A render writes one `script_line` a second
 *  for four hours; the lines that say why it stopped are the last ones. */
const SCRIPT_LINES_PER_STEP = 50;

/** How many turns the troubleshooter gets. A question about one run is a handful of greps and a
 *  read or two; a cap means a question that has gone wrong costs a minute rather than an hour. */
const MAX_TURNS = 20;

/** The log of questions asked about one run, beside the run's own log and never inside it:
 *  `<runs>/<runId>.troubleshooting.jsonl`.
 *
 *  Three reasons it is a separate file. The run log is a typed append-only `Event` stream and the
 *  sole input to `deriveRunState` — a `{question, answer}` line is not an `Event`, and every reader
 *  of the log would have to tolerate it. The engine reads that same log back for cache decisions
 *  (`RunOptions.priorLogs`), so a conversation written into it would become part of what the next
 *  run treats as the record of what happened. And `RunStore` tails the run log and announces every
 *  appended line to every connected client, which a long answer would turn into a flood of notices
 *  about a run that did not change — the store already skips this filename, because its would-be
 *  run id carries a dot and `RUN_ID` refuses one. */
export function troubleshootingPath(ctx: ShowContext, episodeId: string, runId: string): string {
  return EventLog.logPath(ctx.showRoot, episodeId, runId, ctx.productionDir).replace(/\.jsonl$/, ".troubleshooting.jsonl");
}

/** One event on the wire: the engine's `Event` minus the `runId` every line of one log repeats. */
function wire(e: Event): WireEvent {
  return { ts: e.ts, ...(e.stepId !== undefined ? { stepId: e.stepId } : {}), kind: e.kind, payload: e.payload };
}

/** The run's events with the chatter collapsed: the last fifty `script_line`s per step and the
 *  last `step_progress` per step, everything else whole, all of it in log order.
 *
 *  Collapsed by counting first and then walking, rather than by keeping a per-step buffer, so the
 *  result is a subsequence of the log in the log's own order — an agent reading it sees the
 *  surviving lines where they actually happened, between the step's start and its failure. */
function collapse(events: Event[]): WireEvent[] {
  const lineCounts = new Map<string, number>();
  const progressCounts = new Map<string, number>();
  for (const e of events) {
    const key = e.stepId ?? "";
    if (e.kind === "script_line") lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
    else if (e.kind === "step_progress") progressCounts.set(key, (progressCounts.get(key) ?? 0) + 1);
  }
  const lineSeen = new Map<string, number>();
  const progressSeen = new Map<string, number>();
  const out: WireEvent[] = [];
  for (const e of events) {
    const key = e.stepId ?? "";
    if (e.kind === "script_line") {
      const n = (lineSeen.get(key) ?? 0) + 1;
      lineSeen.set(key, n);
      const total = lineCounts.get(key) ?? 0;
      if (n <= total - SCRIPT_LINES_PER_STEP) continue;
    } else if (e.kind === "step_progress") {
      const n = (progressSeen.get(key) ?? 0) + 1;
      progressSeen.set(key, n);
      if (n < (progressCounts.get(key) ?? 0)) continue;
    }
    out.push(wire(e));
  }
  return out;
}

/** Every prompt file the run's agent steps read, with the hash the run recorded and the hash of
 *  the same file now.
 *
 *  One row per step and prompt file, not one per `agent_query`: a loop body logs an `agent_query`
 *  per iteration, and fifteen identical rows for the draft loop would bury the one row that
 *  matters. The hash kept is the **last** one the run recorded for that pair, since that is the
 *  prompt the step most recently read; the order is first appearance, which is the order the run
 *  ran them in. */
async function promptRows(ctx: ShowContext, events: Event[]): Promise<PromptAtRun[]> {
  const promptsDir = resolveShowPath(ctx.showRoot, ctx.show.promptsDir);
  const order: string[] = [];
  const seen = new Map<string, { stepId: string; promptFile: string; hashAtRun: string }>();
  for (const e of events) {
    if (e.kind !== "agent_query" || e.stepId === undefined) continue;
    const promptFile = e.payload["promptFile"];
    const hashAtRun = e.payload["promptHash"];
    if (typeof promptFile !== "string" || typeof hashAtRun !== "string") continue;
    const key = `${e.stepId}\u0000${promptFile}`;
    if (!seen.has(key)) order.push(key);
    seen.set(key, { stepId: e.stepId, promptFile, hashAtRun });
  }
  // Hashed once per file, not once per row: two steps can read the same prompt.
  const now = new Map<string, string | null>();
  const rows: PromptAtRun[] = [];
  for (const key of order) {
    const row = seen.get(key);
    if (row === undefined) continue;
    if (!now.has(row.promptFile)) now.set(row.promptFile, await hashFile(path.join(promptsDir, row.promptFile)));
    const hashNow = now.get(row.promptFile) ?? null;
    rows.push({ ...row, hashNow, changed: hashNow !== row.hashAtRun });
  }
  return rows;
}

/** Every path any step of the run recorded an output hash for, sorted and without repeats: the
 *  files this run put on disk, which is the list an operator checks against what they expected. */
function outputsOf(events: Event[]): string[] {
  const paths = new Set<string>();
  for (const e of events) {
    const hashes = e.payload["outputHashes"];
    if (typeof hashes !== "object" || hashes === null || Array.isArray(hashes)) continue;
    for (const key of Object.keys(hashes as Record<string, unknown>)) paths.add(key);
  }
  return [...paths].sort();
}

/** Everything the troubleshooter is handed before it is asked anything. Assembled per question
 *  rather than cached: the point of the prompt-hash comparison is that it reflects the disk at the
 *  moment the question is asked. */
export async function assemble(ctx: ShowContext, store: RunStore, episodeId: string, runId: string): Promise<WhatHappenedContext> {
  parseEpisodeId(episodeId);
  const { events } = await store.get(episodeId, runId);
  const pipeline = episodePipeline({ show: ctx.show, episodeId, engineRoot: ctx.engineRoot });
  return {
    pipeline: describePipeline(pipeline),
    // The hash of the pipeline above, beside the run's own recorded hash on `run.pipeline`: the
    // two differing is why a run has steps the code does not, and the troubleshooter would
    // otherwise have the logged hash and nothing to compare it with.
    pipelineHashNow: pipelineHash(pipeline),
    run: await store.view(episodeId, runId),
    events: collapse(events),
    prompts: await promptRows(ctx, events),
    outputs: outputsOf(events),
  };
}

/** The prompt. It states the question first, then the instructions, then the context — the
 *  question first so a long context cannot bury what was asked, and the instructions before the
 *  context so they are not read as part of the data. */
function troubleshootingPrompt(context: WhatHappenedContext, question: string): string {
  const { episodeId, runId } = context.run;
  return [
    `The showrunner is asking about run ${runId} of episode ${episodeId}, and wants to know:`,
    "",
    question,
    "",
    "How to answer:",
    "",
    "- Answer from this run's log and the files below. The run has already happened; you are",
    "  explaining a record, not predicting a behaviour.",
    "- You are read-only. You have Read, Glob and Grep and nothing else: do not propose to edit a",
    "  file as part of answering, and do not assume anything has been changed.",
    "- Cite what you rely on: the step id and the event's timestamp for anything from the log, and",
    "  the path for anything from a file. An uncited claim about this run is a guess.",
    "- If a prompt below has `changed: true`, the prompt file on disk is not the one this run read,",
    "  and anything about that step's behaviour has to be read in that light.",
    "- If the log does not answer the question, say so and say which file or which earlier run",
    "  would. Do not fill the gap.",
    "- Be brief. A paragraph that answers it beats a page that surveys it.",
    "",
    "The run's context, as JSON:",
    "",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

/** Appends one question and its answer to the run's troubleshooting log. Called once per question,
 *  whatever the question came to: a stream that was cut off still cost money and still said
 *  something, and a log that recorded only the clean answers would be the wrong record to check
 *  when the troubleshooter itself is what went wrong. */
async function record(ctx: ShowContext, episodeId: string, runId: string, entry: { question: string; answer: string; costUsd?: number }): Promise<void> {
  const file = troubleshootingPath(ctx, episodeId, runId);
  const row = {
    ts: new Date().toISOString(),
    by: ctx.operator,
    question: entry.question,
    answer: entry.answer,
    ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

/** Asks the troubleshooter one question and streams its answer as it arrives.
 *
 *  `query` is a parameter rather than an import so a test can drive the whole path — the prompt,
 *  the options, the streaming and the log entry — without a model behind it; production takes the
 *  default, `sdkQuery`.
 *
 *  Only two message types are read. An `assistant` message's `text` blocks are the answer and are
 *  yielded as they arrive, so the operator reads the first sentence while the agent is still
 *  working; a `tool_use` block in the same message is the agent reading a file, which is its own
 *  business and not part of the answer. The `result` message is read for `total_cost_usd` alone.
 *  Everything else the SDK emits is ignored.
 *
 *  The log entry is written in a `finally`, so a question whose stream failed or whose reader
 *  walked away is still recorded with whatever answer had arrived. What is recorded as the answer
 *  is exactly the concatenation of what was streamed, so the log holds what the operator read. */
export async function* ask(
  ctx: ShowContext, context: WhatHappenedContext, question: string, query: QueryFn = sdkQuery,
): AsyncIterable<string> {
  const abortController = new AbortController();
  const options: AgentQueryOptions = {
    cwd: ctx.showRoot,
    model: ctx.show.models.medium,
    tools: [...READ_ONLY_TOOLS],
    allowedTools: [...READ_ONLY_TOOLS],
    permissionMode: "dontAsk",
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code" },
    abortController,
    maxTurns: MAX_TURNS,
  };
  const chunks: string[] = [];
  let costUsd: number | undefined;
  let drained = false;
  try {
    for await (const message of query({ prompt: troubleshootingPrompt(context, question), options })) {
      if (message.type === "assistant" && message.message !== undefined) {
        for (const block of message.message.content) {
          if (block.type !== "text" || !("text" in block)) continue;
          if (block.text === "") continue;
          chunks.push(block.text);
          yield block.text;
        }
      } else if (message.type === "result" && typeof message.total_cost_usd === "number") {
        costUsd = message.total_cost_usd;
      }
    }
    drained = true;
  } finally {
    // Aborted only when the stream was abandoned — the reader disconnected, or the query threw.
    // A query that ran to the end has nothing left to abort, and aborting it anyway would hand the
    // SDK a cancellation for work it had already finished.
    if (!drained) abortController.abort();
    await record(ctx, context.run.episodeId, context.run.runId, {
      question, answer: chunks.join(""), ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }
}
