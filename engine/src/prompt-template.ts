import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RunContext } from "./steps.js";

export class TemplateError extends Error {}

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

/** Substitutes every `{{...}}` in `template`. Every hole is an error: an unknown name, a missing
 *  result, a path through a non-object, or a null value throws TemplateError naming the variable
 *  as written, because a prompt with a hole in it lies to the model quietly. */
export function renderPrompt(template: string, ctx: TemplateContext): string {
  return template.replace(VARIABLE, (whole, inner: string) => {
    const expr = inner.trim();
    const fail = (why: string): never => { throw new TemplateError(`${whole}: ${why}`); };
    if (expr === "") return fail("empty variable");
    if (expr === "episodeId") return ctx.episodeId;
    if (expr === "runId") return ctx.runId;
    if (expr === "showRoot") return ctx.showRoot;
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
    if (value === null || value === undefined) return fail("value is null");
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value, null, 2);
  });
}
