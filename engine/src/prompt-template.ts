import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RunContext } from "./steps.js";

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

/** Resolves `promptFile` inside `promptsDir`, refusing any path that escapes it, and returns the
 *  file's text with its sha256 — the hash is what agent_query records so "the prompt as it was"
 *  can be answered later (spec §6.8). */
export async function loadPrompt(promptsDir: string, promptFile: string): Promise<{ text: string; hash: string; path: string }> {
  const root = path.resolve(promptsDir);
  const abs = path.resolve(root, promptFile);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`prompt file ${JSON.stringify(promptFile)} escapes the prompts directory ${root}`);
  }
  let raw: Buffer;
  try {
    raw = await readFile(abs);
  } catch (err) {
    throw new Error(`prompt file ${JSON.stringify(promptFile)} could not be read at ${abs}: ${(err as Error).message}`, { cause: err });
  }
  return { text: raw.toString("utf8"), hash: createHash("sha256").update(raw).digest("hex"), path: abs };
}

type TemplateContext = Pick<RunContext, "episodeId" | "runId" | "showRoot" | "results">;

const VARIABLE = /\{\{([^{}]*)\}\}/g;
const LEFTOVER_BRACE = /\{\{|\}\}/;

/** What `{{prior.<stepId>}}` renders when there is no previous verdict for that step — round 1, or a
 *  step that was not in the last round's reset set. The word rather than an empty object or an empty
 *  string, because the reviewers' prompts are written against it ("Your prior verdict: none"). */
const NO_PRIOR = "none";

/** What the caller supplies beyond the run context: the episode's numeric season and the show's
 *  config. Both are optional, and both are only ever *needed* by a template that names them —
 *  `{{season}}` fails for an episode whose season cannot be determined, but a prompt that never
 *  writes `{{season}}` renders for that same episode. */
export interface RenderExtra {
  season?: number;
  show?: Record<string, unknown>;
  /** The step's own `vars` (steps.ts); `{{vars.<name>}}` fails when the step declared none, or
   *  none by that name. */
  vars?: Record<string, string>;
  /** The verdicts of the **previous** review round, by step id, from the latest `panel_round` event
   *  in the run's log. `{{prior.<stepId>}}` renders one of them, and an id this map does not carry
   *  renders the word `none` rather than failing — see `renderPrompt`'s note, since that is the one
   *  hole in this module that is not an error: on round 1 there is no previous verdict and the
   *  reviewers' prompts still have to render. The values are the verdicts as the reviewers returned
   *  them, so a prompt may not assume a shape. */
  prior?: Record<string, unknown>;
  /** The round a `panel` step is about to run, and what the review and revision of this script have
   *  cost so far: `{{round.n}}` and `{{round.costUsd}}`. Round 1 before any `panel_round` exists,
   *  with a cost of 0. Supplied by the agent executor and by the gate-message renderer from the same
   *  function, so a reviewer's prompt and the gate's message cannot disagree about which round the
   *  run is on. */
  round?: { n: number; costUsd: number };
}

/** Renders one resolved value as prompt text. Shared by the `results` and the `show` branches so
 *  the rules cannot drift between them: a string goes in as itself, a number or a boolean through
 *  String(), anything else as indented JSON, and null or undefined is a hole. */
function renderValue(value: unknown, fail: (why: string) => never): string {
  if (value === null || value === undefined) return fail("value is null");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // JSON.stringify returns undefined rather than throwing for a function or a symbol, and an
  // undefined return here would be substituted as the string "undefined" — a hole that renders
  // as prose. Every other hole is an error, and so is this one.
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return fail("value is not serializable");
  return json;
}

/** Substitutes every `{{...}}` in `template`. Every hole is an error: an unknown name, a missing
 *  result, a path through a non-object, or a null value throws TemplateError naming the variable
 *  as written, because a prompt with a hole in it lies to the model quietly.
 *
 *  The variables are `{{episodeId}}`, `{{runId}}`, `{{showRoot}}`, `{{results.<stepId>[.path]}}`,
 *  `{{season}}` (the numeric season, unpadded), `{{show.<path>}}` (a dotted path into the show
 *  config, so `{{show.video.fps}}`) and `{{vars.<name>}}` (one of the step's own `vars`, a flat
 *  name and never a path, so one prompt file can be run for several targets). The last three read
 *  `extra`, and each fails when the caller did not supply what it names — `{{season}}` for an
 *  episode with no season, `{{show.*}}` for an executor built without a show config, `{{vars.*}}`
 *  for a step that declared no vars at all, which is a different fault from a step that declared
 *  some but not that name and is worded differently for that reason.
 *
 *  Two more read `extra` and come from the run's `panel_round` events rather than from any step's
 *  result: `{{prior.<stepId>}}`, that step's verdict in the **previous** review round, and
 *  `{{round.n}}` / `{{round.costUsd}}`, the round about to run and what the review and revision have
 *  cost. `{{prior.*}}` is the single exception to "every hole is an error": an id with no previous
 *  verdict renders the word `none`, because round 1 has none for anybody and every reviewer's prompt
 *  names its own. `{{round.*}}` is not an exception — it fails when the caller supplied no round, as
 *  `{{vars.*}}` does, and on a field it does not know.
 *
 *  A doubled brace surviving the substitution is the one hole VARIABLE cannot see — its character
 *  class matches no brace, so `{{results.{x}}}` and an unterminated `{{results.setup` match nothing
 *  and would otherwise pass into the prompt verbatim. So after substituting, any remaining `{{` or
 *  `}}` is refused. Single braces are left alone. A rendered *value* that itself contains `{{` is
 *  refused too, which is intended: a step's result is never expected to carry template syntax. */
export function renderPrompt(template: string, ctx: TemplateContext, extra: RenderExtra = {}): string {
  const rendered = template.replace(VARIABLE, (whole, inner: string) => {
    const expr = inner.trim();
    const fail = (why: string): never => { throw new TemplateError(`${whole}: ${why}`); };
    if (expr === "") return fail("empty variable");
    if (expr === "episodeId") return ctx.episodeId;
    if (expr === "runId") return ctx.runId;
    if (expr === "showRoot") return ctx.showRoot;
    if (expr === "season") {
      if (extra.season === undefined) return fail("season is not available");
      return String(extra.season);
    }
    if (expr === "show" || expr.startsWith("show.")) {
      if (expr === "show") return fail("show needs a key path");
      if (extra.show === undefined) return fail("show config is not available");
      const segments = expr.slice("show.".length).split(".");
      if (segments.some((s) => s === "")) return fail("malformed path");
      let value: unknown = extra.show;
      for (const seg of segments) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${JSON.stringify(seg)} is not a key of a non-object`);
        if (!Object.prototype.hasOwnProperty.call(value, seg)) return fail(`no key ${JSON.stringify(seg)}`);
        value = (value as Record<string, unknown>)[seg];
      }
      return renderValue(value, fail);
    }
    if (expr === "vars" || expr.startsWith("vars.")) {
      if (expr === "vars") return fail("vars needs a name");
      if (extra.vars === undefined) return fail("vars are not available");
      const name = expr.slice("vars.".length);
      if (name === "" || name.includes(".")) return fail("malformed var name");
      if (!Object.prototype.hasOwnProperty.call(extra.vars, name)) return fail(`no var ${JSON.stringify(name)}`);
      // Through `renderValue`, as the `results` and `show` branches are. `vars` is typed
      // Record<string, string>, but the type is not a run-time guarantee: a caller that builds a
      // step's vars from untyped data — check-prompts' context file, an interview answer parsed
      // from JSON — can hand over null, or an object, and returning it unchecked would put the
      // literal text "null" or "[object Object]" into a prompt or into a gate message a
      // showrunner approves. Every hole in this module is an error; this is one of them.
      return renderValue(extra.vars[name], fail);
    }
    if (expr === "prior" || expr.startsWith("prior.")) {
      if (expr === "prior") return fail("prior needs a step id");
      const id = expr.slice("prior.".length);
      // One segment, never a path. A step id cannot contain ":" (pipeline.ts) and carries no "." in
      // any pipeline the engine ships, and a dotted path would need the `none` rule applied at
      // every level — "the prior verdict has no such field" is not the same answer as "there is no
      // prior verdict", and a prompt that asked for a field of `none` would read as prose.
      if (id === "" || id.includes(".")) return fail("malformed step id");
      const value = extra.prior === undefined || !Object.prototype.hasOwnProperty.call(extra.prior, id)
        ? undefined
        : extra.prior[id];
      // **The one hole in this module that is not an error.** Round 1 has no previous verdict for
      // anyone, and every reviewer's prompt renders `{{prior.<self>}}`; failing there would fail
      // the first round of every run. `none` is a word the prompts are written against, so the
      // model is told there is nothing rather than shown an empty object.
      if (value === null || value === undefined) return NO_PRIOR;
      return renderValue(value, fail);
    }
    if (expr === "round" || expr.startsWith("round.")) {
      if (expr === "round") return fail("round needs a field");
      if (extra.round === undefined) return fail("round is not available");
      const field = expr.slice("round.".length);
      if (field === "n") return String(extra.round.n);
      if (field === "costUsd") return String(extra.round.costUsd);
      // Two fields and no path: the round is a number and a figure, and a name this does not know
      // is a typo in a prompt, which is exactly the kind of hole this module refuses to render.
      return fail("unknown round field; the round carries n and costUsd");
    }
    if (expr === "results" || !expr.startsWith("results.")) return fail("unknown variable");
    const rest = expr.slice("results.".length);
    const dot = rest.indexOf(".");
    const key = dot === -1 ? rest : rest.slice(0, dot);
    const segments = dot === -1 ? [] : rest.slice(dot + 1).split(".");
    if (key === "" || segments.some((s) => s === "")) return fail("malformed path");
    if (!Object.prototype.hasOwnProperty.call(ctx.results, key)) return fail(`no result for step ${JSON.stringify(key)}`);
    let value: unknown = ctx.results[key];
    for (const seg of segments) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${JSON.stringify(seg)} is not a key of a non-object`);
      if (!Object.prototype.hasOwnProperty.call(value, seg)) return fail(`no key ${JSON.stringify(seg)}`);
      value = (value as Record<string, unknown>)[seg];
    }
    return renderValue(value, fail);
  });
  const leftover = rendered.search(LEFTOVER_BRACE);
  if (leftover !== -1) {
    throw new TemplateError(`unbalanced or malformed template braces near: ${rendered.slice(leftover, leftover + 40)}`);
  }
  return rendered;
}
