import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractPrompts } from "../src/extract-prompts.js";

const workflowsDir = path.resolve(import.meta.dirname, "fixtures/workflows");
const overridesFile = path.resolve(import.meta.dirname, "fixtures/overrides.json");
const truncatedOverridesFile = path.resolve(import.meta.dirname, "fixtures/overrides-truncated.json");
const collideNodeIdDir = path.resolve(import.meta.dirname, "fixtures/collide-nodeid");
const collideKindsDir = path.resolve(import.meta.dirname, "fixtures/collide-kinds");
const outDir = () => mkdtemp(path.join(tmpdir(), "prompts-"));

describe("extractPrompts", () => {
  it("writes one file per prompt, reject prompt, gate message and schema, and an index", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const r = await extractPrompts({ workflowsDir, outDir, overridesFile, schemaRequiredAdd: { "outline-check": ["verdict"] } });
    expect(r.unmapped).toEqual([]);
    expect(r.unused).toEqual([]);
    expect(r.removed).toEqual([]);
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
  it("refuses two workflows whose nodes would write the same file", async () => {
    // File names come from the node id alone, with no workflow prefix, so the second write would
    // silently replace the first and leave no trace that a prompt had been lost.
    await expect(extractPrompts({ workflowsDir: collideNodeIdDir, outDir: await outDir() }))
      .rejects.toThrow(/two sources write "shared\.md": a-first\.yaml:shared \(prompt\) and b-second\.yaml:shared \(prompt\)/);
  });

  it("refuses one node that declares both a prompt and a loop body", async () => {
    await expect(extractPrompts({ workflowsDir: collideKindsDir, outDir: await outDir() }))
      .rejects.toThrow(/two sources write "twice\.md": one\.yaml:twice \(prompt\) and one\.yaml:twice \(loop\.prompt\)/);
  });

  it("writes nothing at all when a collision is found", async () => {
    const dir = await outDir();
    await expect(extractPrompts({ workflowsDir: collideNodeIdDir, outDir: dir })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports an override whose node id matches nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    const overrides = path.join(dir, "overrides.json");
    await writeFile(overrides, JSON.stringify([{ nodeId: "outlyne", pattern: "Canon/season-1.md", replacement: "X" }]));
    const r = await extractPrompts({ workflowsDir, outDir: await outDir(), overridesFile: overrides });
    expect(r.unused).toEqual([{ kind: "override", nodeId: "outlyne", pattern: "Canon/season-1.md" }]);
  });

  it("reports a schemaRequiredAdd entry whose node id matches nothing", async () => {
    const r = await extractPrompts({ workflowsDir, outDir: await outDir(), overridesFile, schemaRequiredAdd: { "outline-chek": ["verdict"] } });
    expect(r.unused).toEqual([{ kind: "schemaRequiredAdd", nodeId: "outline-chek" }]);
  });

  it("reports an override one character short of its form, and leaves the text alone", async () => {
    // "$ARGUMENT" against "$ARGUMENTS": the boundary rule refuses the match rather than rewriting
    // half a variable, so the override is reported unused and the form is still unmapped.
    const dir = await outDir();
    const r = await extractPrompts({ workflowsDir, outDir: dir, overridesFile: truncatedOverridesFile });
    expect(r.unused).toEqual([{ kind: "override", nodeId: "outline", pattern: "The full request is: $ARGUMENT" }]);
    expect(r.unmapped).toEqual([{ file: "harbor-write.yaml", nodeId: "outline", form: "$ARGUMENTS" }]);
    const outline = await readFile(path.join(dir, "outline.md"), "utf8");
    expect(outline).toContain("The full request is: $ARGUMENTS");
    expect(outline).not.toContain("This replacement must never be used.");
  });

  it("refuses a non-empty output directory unless forced", async () => {
    const dir = await outDir();
    await writeFile(path.join(dir, "ghost-node.md"), "left by an earlier run");
    await expect(extractPrompts({ workflowsDir, outDir: dir, overridesFile })).rejects.toThrow(dir);
    await expect(extractPrompts({ workflowsDir, outDir: dir, overridesFile })).rejects.toThrow(/not empty/);
  });

  it("removes the files an earlier run left behind when forced, but never README.md", async () => {
    const dir = await outDir();
    await writeFile(path.join(dir, "ghost-node.md"), "a prompt for a node that no longer exists");
    await writeFile(path.join(dir, "ghost-node.schema.json"), "{}");
    await writeFile(path.join(dir, "README.md"), "written by a person, not by the extractor");
    await writeFile(path.join(dir, "notes.txt"), "not a shape this program produces");
    const r = await extractPrompts({ workflowsDir, outDir: dir, overridesFile, schemaRequiredAdd: { "outline-check": ["verdict"] }, force: true });
    expect(r.removed).toEqual(["ghost-node.md", "ghost-node.schema.json"]);
    const left = (await readdir(dir)).sort();
    expect(left).toContain("README.md");
    expect(left).toContain("notes.txt");
    expect(left).toContain("index.json");
    expect(left).not.toContain("ghost-node.md");
    expect(left).not.toContain("ghost-node.schema.json");
    // The real extraction still happened alongside the cleanup.
    expect(left).toContain("outline.md");
    expect(r.unused).toEqual([]);
  });
});
