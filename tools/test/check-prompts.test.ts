import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  asCheckContext, checkPrompts, promptBaseline,
  type BaselineRow, type BaselineVerdict,
} from "../src/check-prompts.js";
import { initScaffold } from "../src/init/init.js";
import { templatesDir } from "../src/init/paths.js";

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

/** The drift report, over a real show.
 *
 *  `initScaffold` is used rather than a hand-built directory on purpose: what the report compares
 *  against is the baseline `init` wrote, so a test that wrote its own baseline would prove that
 *  `promptBaseline` can read a file this test can write. The show here is the one `init` makes —
 *  forty-three prompt files and a baseline beside them — and every verdict below is produced by
 *  moving one side or the other afterwards. */
describe("promptBaseline: which side of a copied prompt has moved", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function newShow(): Promise<{ promptsDir: string; templates: string }> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "baseline-")));
    made.push(root);
    const said: string[] = [];
    await initScaffold(
      { name: "Harbor Lights", path: root, github: "none", engineRoot: path.resolve(templatesDir(), "..", "..") },
      { say: (t) => { said.push(t); }, ask: async () => ".", choose: async <T extends string>(_q: string, c: readonly { key: T }[]) => c[0]!.key },
    );
    return { promptsDir: path.join(root, "prompts"), templates: path.join(templatesDir(), "prompts") };
  }

  const verdictOf = (rows: BaselineRow[], file: string): BaselineVerdict | undefined =>
    rows.find((r) => r.file === file)?.verdict;

  it("reports every prompt unchanged the moment init has copied them", async () => {
    const { promptsDir, templates } = await newShow();
    const rows = await promptBaseline({ promptsDir, templatesPromptsDir: templates });
    // Every file the scaffold copied, and the baseline itself is not one of the rows.
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.map((r) => r.file)).not.toContain(".templates-baseline.json");
    expect(rows.map((r) => r.file)).toEqual([...rows.map((r) => r.file)].sort());
    expect(rows.filter((r) => r.verdict !== "unchanged")).toEqual([]);
  }, 120_000);

  it("tells the author's own edit apart from a template that moved, and names the file that is both", async () => {
    const { promptsDir, templates } = await newShow();
    // A copy of the engine's templates this test may move, so the real template directory is never
    // written to: "the template moved" is simulated by moving the copy the report reads.
    const movedTemplates = await realpath(await mkdtemp(path.join(tmpdir(), "baseline-templates-")));
    made.push(movedTemplates);
    await cp(templates, movedTemplates, { recursive: true });

    // 1. The author edits one of their own prompts, and nothing else changes.
    await writeFile(path.join(promptsDir, "outline.md"), `${await readFile(path.join(promptsDir, "outline.md"), "utf8")}\n<!-- our house rule -->\n`, "utf8");
    // 2. The engine's template for a second file moves, and the show's copy does not.
    await writeFile(path.join(movedTemplates, "draft.md"), `${await readFile(path.join(movedTemplates, "draft.md"), "utf8")}\n(a better instruction)\n`, "utf8");
    // 3. Both sides of a third move, independently.
    await writeFile(path.join(promptsDir, "tts-script.md"), `${await readFile(path.join(promptsDir, "tts-script.md"), "utf8")}\n<!-- ours -->\n`, "utf8");
    await writeFile(path.join(movedTemplates, "tts-script.md"), `${await readFile(path.join(movedTemplates, "tts-script.md"), "utf8")}\n(theirs)\n`, "utf8");

    const rows = await promptBaseline({ promptsDir, templatesPromptsDir: movedTemplates });
    expect(verdictOf(rows, "outline.md")).toBe("show-edited");
    expect(verdictOf(rows, "draft.md")).toBe("template-moved");
    expect(verdictOf(rows, "tts-script.md")).toBe("both");
    // And the file nobody touched is still unchanged, so the three verdicts above are about those
    // three files and not about the report having lost its baseline.
    expect(verdictOf(rows, "revise.md")).toBe("unchanged");
  }, 120_000);

  it("names a prompt the baseline does not list, one the show has lost, and one the engine no longer ships", async () => {
    const { promptsDir, templates } = await newShow();
    const partialTemplates = await realpath(await mkdtemp(path.join(tmpdir(), "baseline-partial-")));
    made.push(partialTemplates);
    await cp(templates, partialTemplates, { recursive: true });

    // A prompt added after init: it is in the show and in no baseline. Calling this "unchanged"
    // would be the report claiming to have compared something it has no record of.
    await writeFile(path.join(promptsDir, "house-rule.md"), "You are the archivist for *{{show.showName}}*.\n", "utf8");
    // A prompt the show has deleted, which the baseline still lists.
    await rm(path.join(promptsDir, "propose.md"));
    // A prompt the engine no longer ships: there is nothing left to refresh this one from.
    await rm(path.join(partialTemplates, "publish-copy.md"));

    const rows = await promptBaseline({ promptsDir, templatesPromptsDir: partialTemplates });
    expect(verdictOf(rows, "house-rule.md")).toBe("no-baseline");
    expect(verdictOf(rows, "propose.md")).toBe("missing");
    expect(verdictOf(rows, "publish-copy.md")).toBe("no-template");
  }, 120_000);

  it("refuses a prompts directory with no baseline, rather than reporting forty-three edited prompts", async () => {
    // The state of every show scaffolded before the baseline existed. A report is impossible and
    // saying so is the only honest answer: every row would otherwise read `no-baseline` and look
    // like an author who had rewritten the whole prompt set.
    const dir = await mkdtemp(path.join(tmpdir(), "chk-"));
    made.push(dir);
    await writeFile(path.join(dir, "outline.md"), "{{episodeId}}");
    await expect(promptBaseline({ promptsDir: dir })).rejects.toThrow(/prompt baseline at .*\.templates-baseline\.json could not be read/);
    // And a baseline that is not an object of hashes is the same refusal.
    await writeFile(path.join(dir, ".templates-baseline.json"), '["outline.md"]', "utf8");
    await expect(promptBaseline({ promptsDir: dir })).rejects.toThrow(/must hold a JSON object of file names to hashes/);
  });
});
