import { describe, it, expect } from "vitest";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BIBLE_FILES, EventLog, bibleFilePipeline, bibleLogDir, deriveRunState, describePipeline } from "@showrunner/engine";
import { initScaffold, type InitIO } from "@showrunner/tools";
import { createApp } from "../server/app.js";
import type { BibleFileView, BibleRow, SseMessage } from "../shared/types.js";
import { ENGINE_ROOT, SHOW_KEY_FIXTURE, appWithShows, waitFor } from "./helpers.js";

/** The Bible route family over a real scaffolded show: `initScaffold` into a temporary directory,
 *  which gives a git repository with one commit, a config that loads, the prompt set, and the two
 *  scaffold bible files — and **no** gated bible file on disk, which is exactly the state a show is
 *  in when its author opens the Bible page for the first time.
 *
 *  Nothing here calls a model. The writer runs in `fixtures/fake-setup-worker.mjs`, which reads the
 *  run's log and appends what a real worker would append next. */

const execFileAsync = promisify(execFile);

/** An `InitIO` for a phase that asks nothing; a question would be a hung test rather than a
 *  silent one. */
function io(): InitIO {
  return {
    say: () => undefined,
    ask: async () => { throw new Error("initScaffold asks nothing"); },
    choose: async () => { throw new Error("initScaffold asks nothing"); },
  };
}

/** A scaffolded show and the app over a registry holding it, reachable at `/api/shows/show/…`. */
async function bibleShow(opts: { readOnly?: boolean } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "bible-"));
  const root = path.join(parent, "HarborLights");
  const scaffold = await initScaffold({ name: "Harbor Lights", path: root, github: "none", engineRoot: ENGINE_ROOT }, io());
  const app = await appWithShows([{ root: scaffold.root, ...(opts.readOnly === true ? { readOnly: true } : {}) }], { pollMs: 50 });
  return { ...app, root: scaffold.root, parent };
}

const url = (rest: string) => `http://local/api/shows/${SHOW_KEY_FIXTURE}/${rest}`;
const post = (rest: string, body?: unknown) => new Request(url(rest), {
  method: "POST", headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function rows(app: Awaited<ReturnType<typeof bibleShow>>["app"]): Promise<BibleRow[]> {
  const res = await app.request(url("bible"));
  expect(res.status).toBe(200);
  return await res.json() as BibleRow[];
}

async function view(app: Awaited<ReturnType<typeof bibleShow>>["app"], key: string): Promise<BibleFileView> {
  const res = await app.request(url(`bible/${key}`));
  expect(res.status).toBe(200);
  return await res.json() as BibleFileView;
}

/** A setup run log written by hand, for the states a test needs without running anything — the
 *  twin of `seedRun` for the reserved setup id, whose log `EventLog.logPath` cannot address. */
async function seedSetupRun(root: string, key: string, runId: string, events: { kind: string; stepId?: string; payload?: Record<string, unknown> }[]): Promise<string> {
  const file = path.join(bibleLogDir(root, key), `${runId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, events.map((e) => JSON.stringify({
    ts: new Date().toISOString(), runId, ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
    kind: e.kind, payload: e.payload ?? {},
  }) + "\n").join(""), "utf8");
  return file;
}

/** An approved run for one bible file, as the terminal's interview would have left it. */
const approvedRun = (notes?: string) => [
  { kind: "run_started", payload: { pipeline: "bible", episodeId: "setup" } },
  { kind: "step_completed", stepId: "write", payload: {} },
  { kind: "gate_opened", stepId: "gate", payload: { attempt: 1, message: "m" } },
  { kind: "gate_answered", stepId: "gate", payload: { approved: true, attempt: 1, by: "init:test", ...(notes !== undefined ? { notes } : {}) } },
  { kind: "run_finished", payload: { status: "completed" } },
];

async function gitLog(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: root });
  return stdout.trim() === "" ? [] : stdout.trim().split("\n");
}

const CAST_ANSWER = "Vale — the keeper of the light\nPim — the boy who rows";

/** The rejection cap the engine declares on a bible file's gate, read out of the pipeline itself.
 *
 *  Asked of `bibleFilePipeline` rather than written as `10` here, because the point of carrying
 *  `maxAttempts` on the view at all is that the number is the engine's: a test that asserted its
 *  own literal would pass against a view that had stopped reading the pipeline. */
function bibleGateMaxAttempts(): number | undefined {
  const entry = BIBLE_FILES.find((b) => b.key === "world-overview")!;
  const pipeline = bibleFilePipeline({ entry, vars: {}, productionDir: "Production" });
  return describePipeline(pipeline).steps.find((step) => step.id === "gate")?.maxAttempts;
}

describe("the Bible view", () => {
  it("lists the fifteen files in interview order, every one of them pending on a new show", async () => {
    const { app } = await bibleShow();
    const list = await rows(app);
    expect(list.map((r) => r.key)).toEqual(BIBLE_FILES.map((b) => b.key));
    expect(list.every((r) => r.state === "pending")).toBe(true);
    expect(list.every((r) => r.answered === 0)).toBe(true);
    expect(list.every((r) => r.runId === undefined)).toBe(true);
    // The question counts the inventory measured, and the three modes.
    expect(list.map((r) => r.questions)).toEqual([9, 5, 5, 0, 8, 5, 3, 3, 9, 1, 4, 0, 0, 0, 0]);
    expect(list.filter((r) => r.mode === "scaffold").map((r) => r.key)).toEqual(["continuity-ledger", "voice-registry"]);
    expect(list[0]).toMatchObject({ key: "world-overview", file: "Canon/world-overview.md", mode: "interview" });
    expect(list[0]?.purpose).toContain("The premise");
  });

  it("saves the answers and prefills the form from them", async () => {
    const { app, root } = await bibleShow();
    const res = await app.request(post("bible/world-overview/answers", {
      answers: { "Logline": "A lighthouse keeper on a drowned coast.", "The primary cast": CAST_ANSWER },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ file: "Production/setup/world-overview/answers.md" });
    expect(await readFile(path.join(root, "Production/setup/world-overview/answers.md"), "utf8")).toContain("A lighthouse keeper");

    const v = await view(app, "world-overview");
    expect(v.state).toBe("answering");
    expect(v.prior).toBe(true);
    expect(v.answered).toBe(2);
    expect(v.questionsList).toHaveLength(9);
    expect(v.questionsList.find((q) => q.heading === "Logline")?.answer).toBe("A lighthouse keeper on a drowned coast.");
    expect(v.questionsList.find((q) => q.heading === "Premise")?.answer).toBe("");
    expect(v.questionsList[0]?.question).not.toBe("");
    // The row says so too, so the rail can show "2 of 9" without fetching every file.
    expect((await rows(app)).find((r) => r.key === "world-overview")).toMatchObject({ state: "answering", answered: 2 });
  });

  it("merges a second save over the first rather than erasing the answers it does not carry", async () => {
    const { app } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "Logline": "first", "Premise": "kept" } }));
    await app.request(post("bible/world-overview/answers", { answers: { "Logline": "second" } }));
    const v = await view(app, "world-overview");
    expect(v.questionsList.find((q) => q.heading === "Logline")?.answer).toBe("second");
    expect(v.questionsList.find((q) => q.heading === "Premise")?.answer).toBe("kept");
  });

  it("refuses an answers body that is not a record of strings", async () => {
    const { app } = await bibleShow();
    expect((await app.request(post("bible/world-overview/answers", { answers: "a string" }))).status).toBe(400);
    expect((await app.request(post("bible/world-overview/answers", { answers: { Logline: 3 } }))).status).toBe(400);
  });

  it("starts a run, shows the gate the worker opened, and refuses a second run while it is open", async () => {
    const { app, root, stores } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "The primary cast": CAST_ANSWER } }));

    const seen: SseMessage[] = [];
    stores.get(SHOW_KEY_FIXTURE)?.subscribe((m) => { seen.push(m); });

    const started = await app.request(post("bible/world-overview/runs"));
    expect(started.status).toBe(200);
    const { runId, pid } = await started.json() as { runId: string; pid: number };
    expect(runId).toMatch(/^\d{8}T\d{6}Z-[a-z0-9]{4}$/);
    expect(pid).toBeGreaterThan(0);

    await waitFor(async () => (await view(app, "world-overview")).state === "gate");
    const v = await view(app, "world-overview");
    expect(v).toMatchObject({ state: "gate", runId, attempt: 1, gateMessage: "gate world-overview" });
    expect(v.run).toMatchObject({ runId, status: "waiting", gate: { attempt: 1, message: "gate world-overview" } });
    // The projection is the bible file's own pipeline — two steps, not the episode's sixty-eight.
    expect(v.run?.steps.map((s) => s.id)).toEqual(["write", "gate"]);
    expect(v.run?.steps.map((s) => s.status)).toEqual(["completed", "waiting"]);
    expect(v.run?.offset).toBeGreaterThan(0);
    // The gate's rejection cap, read off `describePipeline`'s own gate step rather than typed into
    // the page: `GatePanel` drew "attempt 1 of 10" with the 10 as a literal, which is a number that
    // silently stops being the one the engine enforces. The view and the worker build the pipeline
    // from the same factory, so this is the cap the author's next rejection is counted against —
    // asserted against the engine's declaration and not against a copy of it here.
    expect(v.run?.maxAttempts).toBe(bibleGateMaxAttempts());

    // The store published the growth, keyed by show and by bible key.
    await waitFor(() => seen.some((m) => m.type === "setup"));
    const setup = seen.find((m) => m.type === "setup");
    expect(setup).toMatchObject({ type: "setup", show: SHOW_KEY_FIXTURE, key: "world-overview", runId });

    const again = await app.request(post("bible/world-overview/runs"));
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toBe(`answer the gate on run ${runId} first`);
    expect(await (await stat(path.join(bibleLogDir(root, "world-overview")))).isDirectory()).toBe(true);
  });

  it("refuses to start an interview file whose questions have no answers, and writes a default file's template before its gate", async () => {
    const { app, root } = await bibleShow();
    const refused = await app.request(post("bible/world-overview/runs"));
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error)
      .toBe("answer world-overview's questions first: Production/setup/world-overview/answers.md holds no answers, and it is the writer's one input");

    // A default file has no questions: its gate is the author reading the house template, so the
    // template has to be on disk before the run starts.
    await expect(stat(path.join(root, "Canon/story-craft.md"))).rejects.toThrow();
    const started = await app.request(post("bible/story-craft/runs"));
    expect(started.status).toBe(200);
    const text = await readFile(path.join(root, "Canon/story-craft.md"), "utf8");
    expect(text).toContain("## The causality law");
    expect(text).not.toContain("<!-- Q:");
  });

  it("approves a gate: the answer is in the log, a worker is spawned, and the server commits nothing", async () => {
    const { app, root } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "The primary cast": CAST_ANSWER } }));
    const { runId } = await (await app.request(post("bible/world-overview/runs"))).json() as { runId: string };
    await waitFor(async () => (await view(app, "world-overview")).state === "gate");
    // The writer's output, as the real agent would have left it for the gate to show.
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Harbor Lights\n\n## The primary cast\n\nVale — the keeper\n", "utf8");

    const res = await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "approve", expectedAttempt: 1 }));
    expect(res.status).toBe(200);
    const answered = await res.json() as { runId: string; pid: number };
    expect(answered.runId).toBe(runId);
    expect(answered.pid).toBeGreaterThan(0);

    const events = await new EventLog(path.join(bibleLogDir(root, "world-overview"), `${runId}.jsonl`)).read();
    const gate = events.filter((e) => e.kind === "gate_answered");
    expect(gate).toHaveLength(1);
    expect(gate[0]?.payload).toMatchObject({ approved: true, by: "console:test", attempt: 1 });

    // The worker the answer spawned closes the run, which is what `isApproved` reads.
    await waitFor(async () => (await view(app, "world-overview")).state === "approved");
    const v = await view(app, "world-overview");
    expect(v.run?.status).toBe("completed");
    expect(v.content).toContain("# Harbor Lights");

    // **The commit is the setup worker's, not this server's** (the ledger's ruling of 2026-10-07,
    // asserted in `setup-worker.test.ts`). The fixture worker writes no commit, so the repository
    // still holds only the scaffold's own — which is what proves the server made none.
    expect(await gitLog(root)).toEqual(["init: Harbor Lights — the house layout, the prompts, the scaffolds"]);
    // Nor did the server write the cast sheets or rewrite the main cast: both are the approval's
    // work and both belong to the worker that completes the run.
    await expect(stat(path.join(root, "Canon/characters/Vale"))).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(root, "showrunner.json"), "utf8")).audio.mainCast).not.toContain("Vale");
  });

  it("rejects a gate with notes, and the next attempt opens", async () => {
    const { app, root } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "The primary cast": CAST_ANSWER } }));
    const { runId } = await (await app.request(post("bible/world-overview/runs"))).json() as { runId: string };
    await waitFor(async () => (await view(app, "world-overview")).state === "gate");

    expect((await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "reject", expectedAttempt: 1 }))).status).toBe(400);
    const res = await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "reject", notes: "the tone is wrong", expectedAttempt: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json() as { runId: string }).runId).toBe(runId);
    // The fix agent's revision reopens the gate at attempt 2, and a rejection is not an approval:
    // no worker of a rejected run ever reaches `afterFileApproved`.
    expect(await gitLog(root)).not.toContain("canon: Canon/world-overview.md — approved");
    await waitFor(async () => (await view(app, "world-overview")).attempt === 2);
    expect((await view(app, "world-overview")).state).toBe("gate");
  });

  it("refuses an answer that names the wrong attempt", async () => {
    const { app } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "The primary cast": CAST_ANSWER } }));
    const { runId } = await (await app.request(post("bible/world-overview/runs"))).json() as { runId: string };
    await waitFor(async () => (await view(app, "world-overview")).state === "gate");
    const res = await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "approve", expectedAttempt: 2 }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/attempt/);
    expect((await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "approve" }))).status).toBe(400);
    expect((await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "shrug", expectedAttempt: 1 }))).status).toBe(400);
  });

  it("writes the empty template over the file when the author says they will write it themselves", async () => {
    const { app, root } = await bibleShow();
    await app.request(post("bible/world-overview/answers", { answers: { "The primary cast": CAST_ANSWER } }));
    const { runId } = await (await app.request(post("bible/world-overview/runs"))).json() as { runId: string };
    await waitFor(async () => (await view(app, "world-overview")).state === "gate");

    expect((await app.request(post(`bible/world-overview/runs/${runId}/gate`, { choice: "myself", expectedAttempt: 1 }))).status).toBe(200);
    const text = await readFile(path.join(root, "Canon/world-overview.md"), "utf8");
    expect(text).toContain("## The primary cast");
    expect(text).not.toContain("<!-- Q:");
    // The notes the approval carries are what the row and the worker's commit subject both read.
    const answered = (await new EventLog(path.join(bibleLogDir(root, "world-overview"), `${runId}.jsonl`)).read())
      .filter((e) => e.kind === "gate_answered");
    expect(answered[0]?.payload["notes"]).toBe("the author writes this file");
    await waitFor(async () => (await view(app, "world-overview")).state === "written-by-author");
  });

  it("imports a file the author already has, and refuses a symlink, a path inside the show and a sibling bible file", async () => {
    const { app, root } = await bibleShow();
    await app.request(post("bible/series-arc/answers", { answers: { "The core of the arc": "A tide that never turns." } }));
    const { runId } = await (await app.request(post("bible/series-arc/runs"))).json() as { runId: string };
    await waitFor(async () => (await view(app, "series-arc")).state === "gate");

    const outside = await mkdtemp(path.join(tmpdir(), "bible-import-"));
    const source = path.join(outside, "arc.md");
    await writeFile(source, "# The arc\n\nA tide that never turns.\n", "utf8");
    const link = path.join(outside, "arc-link.md");
    await symlink(source, link);
    // A sibling in the bible and the destination itself, both on disk, so the two refusals that
    // compare paths are reached rather than the earlier "does not exist".
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Harbor Lights\n", "utf8");
    await writeFile(path.join(root, "Canon/series-arc.md"), "a placeholder the refusals must not touch\n", "utf8");

    const refuse = async (importPath: string): Promise<string> => {
      const res = await app.request(post(`bible/series-arc/runs/${runId}/gate`, { choice: "import", importPath, expectedAttempt: 1 }));
      expect(res.status).toBe(400);
      return (await res.json() as { error: string }).error;
    };
    expect(await refuse(link)).toMatch(/is a symbolic link/);
    expect(await refuse(path.join(root, "Production/setup/series-arc/answers.md"))).toMatch(/holds this interview's own answers/);
    expect(await refuse(path.join(root, "Canon/world-overview.md"))).toMatch(/beside Canon\/series-arc\.md/);
    expect(await refuse(path.join(root, "Canon/series-arc.md"))).toMatch(/is the file being written/);
    expect(await refuse(path.join(outside, "nothing.md"))).toMatch(/does not exist/);
    expect(await refuse("")).toMatch(/no path was given/);
    // Nothing was written or appended by any of the six refusals: the destination still holds what
    // it held, and the gate is still open at the same attempt, so the author can answer again.
    expect(await readFile(path.join(root, "Canon/series-arc.md"), "utf8")).toBe("a placeholder the refusals must not touch\n");
    const log = path.join(bibleLogDir(root, "series-arc"), `${runId}.jsonl`);
    expect(deriveRunState(await new EventLog(log).read()).openGate?.attempt).toBe(1);

    const res = await app.request(post(`bible/series-arc/runs/${runId}/gate`, { choice: "import", importPath: source, expectedAttempt: 1 }));
    expect(res.status).toBe(200);
    expect(await readFile(path.join(root, "Canon/series-arc.md"), "utf8")).toBe("# The arc\n\nA tide that never turns.\n");
    const notes = String((await new EventLog(log).read()).filter((e) => e.kind === "gate_answered").at(-1)?.payload["notes"] ?? "");
    expect(notes).toBe(`imported from ${await realpath(source)}`);
    await waitFor(async () => (await view(app, "series-arc")).state === "imported");
  });

  it("serves exactly the bible file the key names, and 404s for every other path", async () => {
    const { app, root } = await bibleShow();
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Harbor Lights\n", "utf8");
    const res = await app.request(url("bible/world-overview/file"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe("# Harbor Lights\n");

    // Every other shape is a key that is not one of the fifteen, so no path is ever built from it.
    // `..` is spelled `%2e%2e` because `new Request` resolves a literal `..` segment out of the url
    // before the server ever sees it — which is itself part of the answer: a traversal cannot even
    // reach this route.
    for (const key of ["%2e%2e", "%2e%2e%2f%2e%2e%2fetc", "refs.json", "world-overview2", "characters", "README"]) {
      const bad = await app.request(url(`bible/${key}/file`));
      expect(bad.status).toBe(404);
    }
    expect((await (await app.request(url("bible/world-overview2/file"))).json() as { error: string }).error)
      .toMatch(/no such bible file/);
    // `Canon/refs.json` exists on this show and is still unreachable: it is not a bible key.
    await writeFile(path.join(root, "Canon/refs.json"), "{}", "utf8");
    expect((await app.request(url("bible/refs/file"))).status).toBe(404);
    // A gated file that has not been written yet is a 404 naming it, not an empty 200.
    const missing = await app.request(url("bible/series-arc/file"));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: string }).error).toBe("Canon/series-arc.md is not written yet");
  });

  it("reads a scaffold file as pending for the life of the show, and refuses to run one", async () => {
    const { app, root } = await bibleShow();
    // The scaffold wrote the continuity ledger at `initScaffold` time; the row is still `pending`,
    // because a file's presence on disk says nothing about an interview that never happens for it.
    expect(await (await stat(path.join(root, "Canon/continuity-ledger.md"))).isFile()).toBe(true);
    expect((await rows(app)).find((r) => r.key === "continuity-ledger")).toMatchObject({ state: "pending", mode: "scaffold", questions: 0 });
    const res = await app.request(post("bible/continuity-ledger/runs"));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/is a scaffold file/);
    expect((await app.request(post("bible/continuity-ledger/answers", { answers: {} }))).status).toBe(409);
    // The read side still answers for it: the rail links to every one of the fifteen rows, and a
    // row the view refused would be a dead link.
    const v = await view(app, "continuity-ledger");
    expect(v).toMatchObject({ state: "pending", mode: "scaffold", questions: 0, questionsList: [], prior: false });
    expect(v.content).toContain("Open threads");
    expect((await app.request(url("bible/continuity-ledger/file"))).status).toBe(200);
  });

  it("reads a gate exhausted by rejections as stalled, and a failed writer as failed", async () => {
    const { app, root } = await bibleShow();
    await seedSetupRun(root, "timeline", "20261007T100000Z-aaaa", [
      { kind: "run_started", payload: {} },
      { kind: "gate_opened", stepId: "gate", payload: { attempt: 10, message: "m" } },
      { kind: "step_failed", stepId: "gate", payload: { error: "rejected 10 times" } },
      { kind: "run_finished", payload: { status: "failed" } },
    ]);
    await seedSetupRun(root, "technology", "20261007T100000Z-bbbb", [
      { kind: "run_started", payload: {} },
      { kind: "step_failed", stepId: "write", payload: { error: "the writer timed out" } },
      { kind: "run_finished", payload: { status: "failed" } },
    ]);
    const list = await rows(app);
    expect(list.find((r) => r.key === "timeline")?.state).toBe("stalled");
    expect(list.find((r) => r.key === "technology")?.state).toBe("failed");
    expect((await view(app, "technology")).run?.error).toBe("write failed: the writer timed out");
  });

  it("tells the three approved states apart by the notes on the approval, and carries those notes to the page", async () => {
    const { app, root } = await bibleShow();
    await seedSetupRun(root, "world-overview", "20261007T100000Z-aaaa", approvedRun());
    await seedSetupRun(root, "series-arc", "20261007T100000Z-bbbb", approvedRun("imported from /elsewhere/arc.md"));
    await seedSetupRun(root, "timeline", "20261007T100000Z-cccc", approvedRun("the author writes this file"));
    const list = await rows(app);
    expect(list.find((r) => r.key === "world-overview")?.state).toBe("approved");
    expect(list.find((r) => r.key === "series-arc")?.state).toBe("imported");
    expect(list.find((r) => r.key === "timeline")?.state).toBe("written-by-author");

    // The notes themselves, not only the state they imply. The approved panel tells the author of
    // an imported file that its gate "was approved with that path in the log" and had no field to
    // read the path from, so it could not name the source.
    expect((await view(app, "series-arc")).note).toBe("imported from /elsewhere/arc.md");
    expect((await view(app, "timeline")).note).toBe("the author writes this file");
    // An ordinary approval records no notes, and the field is omitted rather than empty, so a
    // client can tell "no notes" from "notes nobody read".
    const plain = await view(app, "world-overview");
    expect("note" in plain).toBe(false);
  });

  it("refuses to finish while a gated file is unapproved, and finishes once every one is approved", async () => {
    const { app, root } = await bibleShow();
    const refused = await app.request(post("bible/finish", { github: "none" }));
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: string; unapproved: string[] };
    expect(body.unapproved).toEqual(BIBLE_FILES.filter((b) => b.mode !== "scaffold").map((b) => b.key));
    expect(body.error).toMatch(/13 bible file\(s\) are not approved yet/);

    for (const [i, entry] of BIBLE_FILES.filter((b) => b.mode !== "scaffold").entries()) {
      await seedSetupRun(root, entry.key, `20261007T10000${i % 10}Z-${String(i).padStart(4, "0")}`, approvedRun());
    }
    const res = await app.request(post("bible/finish", { github: "none" }));
    expect(res.status).toBe(200);
    const finished = await res.json() as { stalled: string[]; nextSteps: string; said: string[]; bibleCheck: { missingFiles: string[] } };
    expect(finished.stalled).toEqual([]);
    expect(finished.nextSteps).not.toBe("");
    // The phase's own prose is carried rather than paraphrased, and no GitHub repository is made.
    expect(finished.said.join("\n")).toMatch(/bible-check/);
    expect(finished.said.join("\n")).not.toMatch(/gh repo create/);
    expect((await app.request(post("bible/finish", { github: "sideways" }))).status).toBe(400);
  });

  it("refuses every bible POST on a read-only show, and writes nothing", async () => {
    const { app, root } = await bibleShow({ readOnly: true });
    for (const rest of ["bible/world-overview/answers", "bible/world-overview/runs", "bible/world-overview/runs/20261007T100000Z-aaaa/gate", "bible/finish"]) {
      const res = await app.request(post(rest, { answers: { Logline: "x" }, choice: "approve", expectedAttempt: 1, github: "none" }));
      expect(res.status).toBe(403);
      expect((await res.json() as { error: string }).error).toBe(`${SHOW_KEY_FIXTURE} is read-only`);
    }
    await expect(stat(path.join(root, "Production/setup/world-overview/answers.md"))).rejects.toThrow();
    // The read side is open: a read-only show is listed, read and browsed.
    expect((await rows(app)).length).toBe(15);
  });
});

/** `POST /api/shows` — the other half of the New-show surface: the scaffold and the registry entry
 *  in one request, and the maps gaining the show without a restart.
 *
 *  Every test here passes the temporary registry `appWithShows` made, so nothing ever writes
 *  `~/.showrunner/shows.json`. */
describe("creating a show", () => {
  it("scaffolds it, registers it, and answers for it at once — no restart", async () => {
    const existing = await bibleShow();
    const parent = await mkdtemp(path.join(tmpdir(), "new-show-"));
    const target = path.join(parent, "Lantern");

    const res = await existing.app.request(new Request("http://local/api/shows", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lantern Hill", path: target, github: "none", nasRoot: path.join(parent, "nas") }),
    }));
    expect(res.status).toBe(200);
    const made = await res.json() as { key: string; root: string; commits: string[] };
    // The key defaults to the directory's own name, which is what the URL carries.
    expect(made.key).toBe("Lantern");
    expect(made.commits).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(made.root, "showrunner.json"), "utf8")).showName).toBe("Lantern Hill");

    // The registry file on disk carries it, under the key the URL uses.
    const registry = JSON.parse(await readFile(existing.registryFile, "utf8")) as { shows: Record<string, { root: string }> };
    expect(Object.keys(registry.shows).sort()).toEqual(["Lantern", SHOW_KEY_FIXTURE]);
    expect(registry.shows["Lantern"]?.root).toBe(made.root);

    // And the server holds it now, with no restart: the list, the Board and the Bible all answer.
    const { shows: list } = await (await existing.app.request("http://local/api/shows")).json() as { shows: { key: string; showName: string }[] };
    expect(list.map((s) => s.key).sort()).toEqual(["Lantern", SHOW_KEY_FIXTURE]);
    expect(list.find((s) => s.key === "Lantern")?.showName).toBe("Lantern Hill");
    const board = await existing.app.request("http://local/api/shows/Lantern/episodes");
    expect(board.status).toBe(200);
    expect(await board.json()).toEqual([]);
    const bible = await existing.app.request("http://local/api/shows/Lantern/bible");
    expect(bible.status).toBe(200);
    expect((await bible.json() as BibleRow[]).every((r) => r.state === "pending")).toBe(true);
    existing.stores.get("Lantern")?.close();
  });

  it("refuses a key the grammar rejects, and writes nothing", async () => {
    const { app } = await bibleShow();
    const parent = await mkdtemp(path.join(tmpdir(), "new-show-"));
    const target = path.join(parent, "Lantern");
    const res = await app.request(new Request("http://local/api/shows", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lantern Hill", path: target, github: "none", key: "-nope" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/is not a show key/);
    await expect(stat(target)).rejects.toThrow();
  });

  it("refuses a path inside the engine repository, and one inside a registered show", async () => {
    const { app, root } = await bibleShow();
    const create = async (target: string) => {
      const res = await app.request(new Request("http://local/api/shows", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Lantern Hill", path: target, github: "none", key: "Lantern" }),
      }));
      return { status: res.status, error: (await res.json() as { error: string }).error };
    };
    const inEngine = path.join(ENGINE_ROOT, "a-show-that-must-not-be-made");
    expect(await create(inEngine)).toMatchObject({ status: 400, error: expect.stringContaining("inside the engine repository") });
    await expect(stat(inEngine)).rejects.toThrow();

    const inShow = path.join(root, "nested-show");
    expect(await create(inShow)).toMatchObject({ status: 400, error: expect.stringContaining(`registered as ${SHOW_KEY_FIXTURE}`) });
    await expect(stat(inShow)).rejects.toThrow();

    // And the other direction: a path that would hold a registered show.
    expect((await create(path.dirname(root))).status).toBe(400);
  });

  it("refuses a duplicate key with 409", async () => {
    const { app } = await bibleShow();
    const parent = await mkdtemp(path.join(tmpdir(), "new-show-"));
    const res = await app.request(new Request("http://local/api/shows", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lantern Hill", path: path.join(parent, "Lantern"), github: "none", key: SHOW_KEY_FIXTURE }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(new RegExp(`^${SHOW_KEY_FIXTURE} is already registered, at `));
    await expect(stat(path.join(parent, "Lantern"))).rejects.toThrow();
  });

  it("refuses a bad body, and a console started with --show that has no registry to write", async () => {
    const { app } = await bibleShow();
    const body = (b: unknown) => new Request("http://local/api/shows", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
    });
    expect((await app.request(body({ path: "/tmp/x", github: "none" }))).status).toBe(400);
    expect((await app.request(body({ name: "Lantern Hill", github: "none" }))).status).toBe(400);
    expect((await app.request(body({ name: "Lantern Hill", path: "/tmp/x", github: "sideways" }))).status).toBe(400);
    expect((await app.request(body({ name: "Lantern Hill", path: "/tmp/x", github: "none", slug: "" }))).status).toBe(400);

    // `--show <root>` mode holds one show and writes nothing on the machine (ruling H-01), so the
    // route refuses rather than inventing a registry file to append to.
    const single = createApp(new Map(), new Map(), {});
    const res = await single.request(body({ name: "Lantern Hill", path: "/tmp/x", github: "none" }));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/started with --show/);
  });
});
