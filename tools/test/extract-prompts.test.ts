import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractPrompts } from "../src/extract-prompts.js";

const workflowsDir = path.resolve(import.meta.dirname, "fixtures/workflows");
const overridesFile = path.resolve(import.meta.dirname, "fixtures/overrides.json");

describe("extractPrompts", () => {
  it("writes one file per prompt, reject prompt, gate message and schema, and an index", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const r = await extractPrompts({ workflowsDir, outDir, overridesFile, schemaRequiredAdd: { "outline-check": ["verdict"] } });
    expect(r.unmapped).toEqual([]);
    const files = r.index.map((e) => e.file).sort();
    expect(files).toEqual(["draft.md", "outline-check.md", "outline-check.schema.json", "outline-gate.gate.md", "outline-gate.reject.md", "outline.md"].sort());
    const outline = await readFile(path.join(outDir, "outline.md"), "utf8");
    expect(outline).toContain("The episode is {{episodeId}}.");
    expect(outline).toContain("The premise is in Episodes/{{episodeId}}/premise.md");
    expect(outline).toContain("Canon/season-{{season}}.md");
    expect(outline).not.toContain("$");
    const reject = await readFile(path.join(outDir, "outline-gate.reject.md"), "utf8");
    expect(reject).toContain("{{results.outline-gate:rejection}}");
    const gate = await readFile(path.join(outDir, "outline-gate.gate.md"), "utf8");
    expect(gate).toContain("{{results.outline-check.verdict}}");
    const schema = JSON.parse(await readFile(path.join(outDir, "outline-check.schema.json"), "utf8"));
    expect(schema.required).toEqual(["pass", "issues", "verdict"]);
    const index = JSON.parse(await readFile(path.join(outDir, "index.json"), "utf8"));
    const draft = index.find((e: { nodeId: string }) => e.nodeId === "draft");
    expect(draft).toMatchObject({ kind: "loop", model: "writer", context: "fresh", until: "DRAFT_COMPLETE", maxIterations: 15, idleTimeoutMs: 900000, dependsOn: ["outline-gate"] });
    const check = index.find((e: { nodeId: string }) => e.nodeId === "outline-check");
    expect(check).toMatchObject({ kind: "agent", model: "medium", context: "fresh", allowedTools: ["Read", "Glob", "Grep"], schema: "outline-check.schema.json" });
    const rej = index.find((e: { file: string }) => e.file === "outline-gate.reject.md");
    expect(rej).toMatchObject({ kind: "reject", gateId: "outline-gate", maxAttempts: 3 });
  });
  it("reports unmapped forms with their node when no override covers them", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const r = await extractPrompts({ workflowsDir, outDir });
    expect(r.unmapped).toEqual([{ file: "harbor-write.yaml", nodeId: "outline", form: "$ARGUMENTS" }]);
  });
});
