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
});
