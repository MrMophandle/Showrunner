import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkPrompts } from "../src/check-prompts.js";

describe("checkPrompts", () => {
  it("renders every prompt and reports the ones with holes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "good.md"), "{{episodeId}} {{results.x}} {{season}} {{show.showName}}");
    await writeFile(path.join(dir, "bad.md"), "{{results.missing}}");
    await writeFile(path.join(dir, "gate.gate.md"), "ok {{episodeId}}");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: { x: "1" }, season: 2, show: { showName: "H" } } });
    expect(errors).toEqual([{ file: "bad.md", error: expect.stringContaining("{{results.missing}}") }]);
  });

  it("skips README.md, which documents the variable syntax rather than using it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    await writeFile(path.join(dir, "step.md"), "ok {{episodeId}}");
    // The prompts directory's README names the forms a prompt may write. None of them resolves
    // against a real context, and nothing renders the README at run time, so checking it would
    // report a hole in the one file that is supposed to contain one.
    await writeFile(path.join(dir, "README.md"), "The variables are {{results.<stepId>}}, {{show.<path>}} and {{results.<gateId>:rejection}}.");
    const errors = await checkPrompts({ promptsDir: dir, context: { episodeId: "s02e01", runId: "r", showRoot: "/s", results: {} } });
    expect(errors).toEqual([]);
  });
});
