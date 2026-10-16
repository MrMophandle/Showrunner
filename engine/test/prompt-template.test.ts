import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadPrompt, renderPrompt, TemplateError } from "../src/prompt-template.js";

const promptsDir = path.resolve(import.meta.dirname, "fixtures/prompts");
const ctx = {
  episodeId: "s02e01", runId: "r1", showRoot: "/show",
  results: { setup: "ready", review: { verdict: "DRAFT PASSED", issues: ["a", "b"] }, "gate:rejection": "too long", n: 3 },
};

describe("loadPrompt", () => {
  it("reads a prompt inside the prompts directory and hashes it", async () => {
    const p = await loadPrompt(promptsDir, "plain.md");
    const raw = await readFile(path.join(promptsDir, "plain.md"));
    expect(p.text).toBe(raw.toString("utf8"));
    expect(p.hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(p.path).toBe(path.join(promptsDir, "plain.md"));
  });
  it("refuses a path that escapes the prompts directory", async () => {
    await expect(loadPrompt(promptsDir, "../fail.py")).rejects.toThrow(/escapes/);
    await expect(loadPrompt(promptsDir, "/etc/passwd")).rejects.toThrow(/escapes/);
  });
  it("names a missing prompt file", async () => {
    await expect(loadPrompt(promptsDir, "nope.md")).rejects.toThrow(/nope\.md/);
  });
});

describe("renderPrompt", () => {
  it("substitutes context fields, results, dotted paths, and colon keys", async () => {
    const { text } = await loadPrompt(promptsDir, "hello.md");
    const out = renderPrompt(text, ctx);
    expect(out).toContain("episode s02e01 in run r1.");
    expect(out).toContain("Setup said: ready");
    expect(out).toContain("Verdict was: DRAFT PASSED with [\n  \"a\",\n  \"b\"\n]");
    expect(out).toContain("Rejection: too long");
  });
  it("stringifies numbers and objects", () => {
    expect(renderPrompt("{{results.n}}", ctx)).toBe("3");
    expect(renderPrompt("{{results.review}}", ctx)).toBe(JSON.stringify(ctx.results.review, null, 2));
  });
  it("leaves text without variables untouched, including single braces", async () => {
    const { text } = await loadPrompt(promptsDir, "plain.md");
    expect(renderPrompt(text, ctx)).toBe(text);
  });
  it("throws TemplateError naming the variable for every kind of hole", () => {
    expect(() => renderPrompt("{{nope}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{nope}}", ctx)).toThrow(/\{\{nope\}\}/);
    expect(() => renderPrompt("{{results.missing}}", ctx)).toThrow(/\{\{results\.missing\}\}/);
    expect(() => renderPrompt("{{results.setup.deeper}}", ctx)).toThrow(/\{\{results\.setup\.deeper\}\}/);
    expect(() => renderPrompt("{{results.review.absent}}", ctx)).toThrow(/absent/);
    expect(() => renderPrompt("{{results}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{results.nul}}", { ...ctx, results: { nul: null } })).toThrow(/nul/);
  });
  it("gives TemplateError a name of its own, so a caught error says which layer refused", () => {
    expect(new TemplateError("x").name).toBe("TemplateError");
  });
  it("refuses a value JSON.stringify cannot represent rather than rendering \"undefined\"", () => {
    expect(() => renderPrompt("{{results.fn}}", { ...ctx, results: { fn: () => 1 } })).toThrow(TemplateError);
    expect(() => renderPrompt("{{results.fn}}", { ...ctx, results: { fn: () => 1 } })).toThrow(/not serializable/);
  });
  it("refuses doubled braces left over after substitution, but not single braces in a value", () => {
    expect(() => renderPrompt("{{results.{x}}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{results.{x}}}", ctx)).toThrow(/unbalanced or malformed template braces near: \{\{results\.\{x\}\}\}/);
    expect(() => renderPrompt("{{results.setup", ctx)).toThrow(/unbalanced or malformed template braces near: \{\{results\.setup/);
    expect(renderPrompt("{{results.setup}}", { ...ctx, results: { setup: "a {b} c" } })).toBe("a {b} c");
  });
});

describe("renderPrompt: season and show", () => {
  const show = { showName: "Harbor Lights", video: { fps: 24, titleCard: { text: "HARBOR LIGHTS" } }, audio: { mainCast: ["a", "b"] } };
  it("renders {{season}} and {{show.<path>}}", () => {
    expect(renderPrompt("S{{season}} of {{show.showName}} at {{ show.video.fps }} fps: {{show.video.titleCard.text}}", ctx, { season: 2, show })).toBe("S2 of Harbor Lights at 24 fps: HARBOR LIGHTS");
    expect(renderPrompt("{{show.audio.mainCast}}", ctx, { show })).toBe(JSON.stringify(["a", "b"], null, 2));
  });
  it("throws when season or show is not available, naming the variable", () => {
    expect(() => renderPrompt("{{season}}", ctx)).toThrow(/\{\{season\}\}/);
    expect(() => renderPrompt("{{show.showName}}", ctx)).toThrow(/\{\{show\.showName\}\}/);
    expect(() => renderPrompt("{{show.nope}}", ctx, { show })).toThrow(/nope/);
    expect(() => renderPrompt("{{show}}", ctx, { show })).toThrow(TemplateError);
  });
});

describe("{{vars.<name>}}", () => {
  const ctx = { episodeId: "setup", runId: "r1", showRoot: "/show", results: {} };
  it("renders a declared var", () => {
    expect(renderPrompt("file: {{vars.file}}", ctx, { vars: { file: "Canon/style-guide.md" } })).toBe("file: Canon/style-guide.md");
  });
  it("fails on an undeclared var, naming it", () => {
    expect(() => renderPrompt("{{vars.nope}}", ctx, { vars: { file: "x" } })).toThrow(/\{\{vars\.nope\}\}: no var "nope"/);
  });
  it("fails when the step declares no vars at all", () => {
    expect(() => renderPrompt("{{vars.file}}", ctx, {})).toThrow(/vars are not available/);
  });
  it("fails on a bare {{vars}}", () => {
    expect(() => renderPrompt("{{vars}}", ctx, { vars: {} })).toThrow(/vars needs a name/);
  });
  it("renders a var's value by the same rules as a result's, so a null is a hole and an object is JSON", () => {
    // `vars` is typed Record<string, string>; the casts below are the untyped caller the type
    // cannot stop at run time — a value read out of check-prompts' context file, or an interview
    // answer parsed from JSON. The assertions are the `results` branch's own behaviour, because
    // one `renderValue` serves both and the rules must not drift between them.
    const varsOf = (v: unknown): { vars: Record<string, string> } => ({ vars: { x: v } as unknown as Record<string, string> });
    expect(() => renderPrompt("{{vars.x}}", ctx, varsOf(null))).toThrow(/\{\{vars\.x\}\}: value is null/);
    expect(() => renderPrompt("{{vars.x}}", ctx, varsOf(undefined))).toThrow(/\{\{vars\.x\}\}: value is null/);
    expect(() => renderPrompt("{{vars.x}}", ctx, varsOf(() => 1))).toThrow(/\{\{vars\.x\}\}: value is not serializable/);
    expect(renderPrompt("{{vars.x}}", ctx, varsOf({ a: 1 }))).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(renderPrompt("{{vars.x}}", ctx, varsOf(7))).toBe("7");
    expect(renderPrompt("{{vars.x}}", ctx, varsOf(false))).toBe("false");
    // The results branch, side by side, on the same values: one set of rules, not two.
    expect(() => renderPrompt("{{results.x}}", { ...ctx, results: { x: null } })).toThrow(/\{\{results\.x\}\}: value is null/);
    expect(renderPrompt("{{results.x}}", { ...ctx, results: { x: { a: 1 } } })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe("renderPrompt: the round's variables", () => {
  const prior = { "tone-check": { pass: false, issues: ["scene five"] }, revise: "## Changed\nScene five.", empty: null };
  const round = { n: 3, costUsd: 15.8878 };

  it("renders a prior verdict by step id, as the same JSON a result renders as", () => {
    expect(renderPrompt("{{prior.tone-check}}", ctx, { prior })).toBe(JSON.stringify(prior["tone-check"], null, 2));
    expect(renderPrompt("{{prior.revise}}", ctx, { prior })).toBe("## Changed\nScene five.");
  });

  it("renders `none` for a step with no prior verdict, and for a caller that supplied no priors at all", () => {
    // The one hole in this module that is not an error. Round 1 has no previous verdict for anybody
    // and every reviewer's prompt names its own, so failing here would fail the first round of every
    // run. A null in the map reads the same way: there is nothing to judge against.
    expect(renderPrompt("{{prior.flow-check}}", ctx, { prior })).toBe("none");
    expect(renderPrompt("{{prior.empty}}", ctx, { prior })).toBe("none");
    expect(renderPrompt("{{prior.tone-check}}", ctx)).toBe("none");
    expect(renderPrompt("prior: {{prior.tone-check}}.", ctx, { prior: {} })).toBe("prior: none.");
  });

  it("fails on a bare {{prior}} and on a dotted path into a verdict", () => {
    // A path would need the `none` rule at every level, and "the prior verdict has no such field" is
    // not the same answer as "there is no prior verdict": a prompt asking for a field of `none`
    // would render as prose. One segment only.
    expect(() => renderPrompt("{{prior}}", ctx, { prior })).toThrow(/prior needs a step id/);
    expect(() => renderPrompt("{{prior.tone-check.pass}}", ctx, { prior })).toThrow(/malformed step id/);
    expect(() => renderPrompt("{{prior.}}", ctx, { prior })).toThrow(/malformed step id/);
  });

  it("renders the round and its cost, and fails by name on anything else", () => {
    expect(renderPrompt("round {{round.n}} (${{round.costUsd}})", ctx, { round })).toBe("round 3 ($15.8878)");
    expect(renderPrompt("{{round.n}}", ctx, { round: { n: 1, costUsd: 0 } })).toBe("1");
    // Four decimals wherever the figure becomes text, so the gate's message and the gate's head
    // print one string for one number: a round 1 reads `$0.0000`, not `$0`, and a figure whose
    // value has a short tail is padded rather than printed short.
    expect(renderPrompt("${{round.costUsd}}", ctx, { round: { n: 1, costUsd: 0 } })).toBe("$0.0000");
    expect(renderPrompt("${{round.costUsd}}", ctx, { round: { n: 2, costUsd: 6.07 } })).toBe("$6.0700");
    expect(() => renderPrompt("{{round}}", ctx, { round })).toThrow(/round needs a field/);
    expect(() => renderPrompt("{{round.cost}}", ctx, { round })).toThrow(/unknown round field; the round carries n and costUsd/);
    // Absent is a named fault, not a hole: a caller that renders a prompt with no round — the
    // prompt checker's context file before it carries one — is told what it did not supply.
    expect(() => renderPrompt("{{round.n}}", ctx)).toThrow(/\{\{round\.n\}\}: round is not available/);
  });
});
