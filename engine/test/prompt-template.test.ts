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
