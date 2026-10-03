import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { asCheckContext, checkPrompts } from "../src/check-prompts.js";

describe("checkPrompts", () => {
  it("renders every prompt and reports the ones with holes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "good.md"), "{{episodeId}} {{results.x}} {{season}} {{show.showName}}");
    await writeFile(path.join(dir, "bad.md"), "{{results.missing}}");
    await writeFile(path.join(dir, "gate.gate.md"), "ok {{episodeId}}");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: { x: "1" }, season: 2, show: { showName: "H" } } });
    expect(errors).toEqual([{ file: "bad.md", error: expect.stringContaining("{{results.missing}}") }]);
  });

  it("renders {{vars.<name>}} from the context file's vars, and reports a prompt that names another", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    // One prompt file rendered for a named target is why vars exist: the context file supplies the
    // target, so the check runs the same prompt the pipeline's step will run.
    await writeFile(path.join(dir, "write.md"), "Write {{vars.file}} for {{episodeId}}.");
    await writeFile(path.join(dir, "stray.md"), "{{vars.nope}}");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: {}, vars: { file: "Canon/x.md" } } });
    expect(errors).toEqual([{ file: "stray.md", error: expect.stringContaining('{{vars.nope}}: no var "nope"') }]);
  });

  it("reports every {{vars.<name>}} when the context file carries no vars at all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "write.md"), "Write {{vars.file}}.");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: {} } });
    expect(errors).toEqual([{ file: "write.md", error: expect.stringContaining("{{vars.file}}: vars are not available") }]);
  });

  it("skips README.md and nothing else, so the exemption cannot hide a real hole", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "step.md"), "ok {{episodeId}}");
    // The prompts directory's README names the forms a prompt may write. None of them resolves
    // against a real context, and nothing renders the README at run time, so checking it would
    // report a hole in the one file that is supposed to contain one.
    await writeFile(path.join(dir, "README.md"), "The variables are {{results.<stepId>}}, {{show.<path>}} and {{results.<gateId>:rejection}}.");
    // bad.md is the control. It sits beside the README with a hole of exactly the kind the README
    // is excused for, so the assertion below proves the skip is narrow: a skip keyed on anything
    // looser than the name "README.md" would swallow this file's error too, and the test would
    // still pass if it only asserted that the README goes unreported.
    await writeFile(path.join(dir, "bad.md"), "{{results.missing}}");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: {} } });
    expect(errors).toEqual([{ file: "bad.md", error: expect.stringContaining("{{results.missing}}") }]);
  });
});

describe("asCheckContext: the context file's vars", () => {
  /** Writes `body` as the context file the CLI would read, then parses it the way the CLI does. */
  async function parsed(body: unknown): Promise<ReturnType<typeof asCheckContext>> {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-ctx-"));
    const file = path.join(dir, "context.json");
    await writeFile(file, JSON.stringify(body));
    return asCheckContext(JSON.parse(await readFile(file, "utf8")) as unknown, file);
  }
  const base = { episodeId: "s02e01", runId: "r", showRoot: "/s", results: {} };

  it("accepts vars of string values and renders them into a prompt", async () => {
    const context = await parsed({ ...base, vars: { file: "Canon/x.md", heading: "Voice" } });
    expect(context.vars).toEqual({ file: "Canon/x.md", heading: "Voice" });
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "write.md"), "Write {{vars.file}} under {{vars.heading}}.");
    expect(await checkPrompts({ promptsDir: dir, context })).toEqual([]);
  });

  it("refuses a vars that is not an object of string values, naming the file and the key", async () => {
    // The refusal is deliberate, and stricter than this function's own handling of `season` and
    // `show`: a silently dropped `vars` would report every var-naming prompt as a hole.
    await expect(parsed({ ...base, vars: { file: 7 } })).rejects.toThrow(/context\.json: vars\.file must be a string/);
    await expect(parsed({ ...base, vars: { file: null } })).rejects.toThrow(/vars\.file must be a string/);
    await expect(parsed({ ...base, vars: { file: { nested: "x" } } })).rejects.toThrow(/vars\.file must be a string/);
    await expect(parsed({ ...base, vars: ["Canon/x.md"] })).rejects.toThrow(/vars must be an object of string values/);
    await expect(parsed({ ...base, vars: "Canon/x.md" })).rejects.toThrow(/vars must be an object of string values/);
    await expect(parsed({ ...base, vars: null })).rejects.toThrow(/vars must be an object of string values/);
  });

  it("accepts a context file with no vars at all, leaving the field absent", async () => {
    const context = await parsed(base);
    expect("vars" in context).toBe(false);
  });
});
