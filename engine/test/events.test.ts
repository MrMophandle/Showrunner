import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog } from "../src/events.js";

describe("EventLog", () => {
  it("appends one JSON line per event and reads them back in order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const log = new EventLog(path.join(dir, "nested", "r1.jsonl"));
    const a = await log.append({ runId: "r1", kind: "run_started", payload: { pipeline: "p" } });
    const b = await log.append({ runId: "r1", stepId: "s1", kind: "step_started", payload: { kind: "guard" } });
    expect(typeof a.ts).toBe("string");
    const text = await readFile(log.path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    const events = await log.read();
    expect(events.map((e) => e.kind)).toEqual(["run_started", "step_started"]);
    expect(events[1]?.stepId).toBe("s1");
    expect(events[0]?.ts).toBe(a.ts);
    expect(events[1]?.ts).toBe(b.ts);
  });

  it("reads an absent log as empty", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const log = new EventLog(path.join(dir, "none.jsonl"));
    expect(await log.read()).toEqual([]);
  });

  it("throws on a malformed line rather than dropping it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const p = path.join(dir, "bad.jsonl");
    await writeFile(p, '{"ts":"t","runId":"r","kind":"run_started","payload":{}}\nnot json\n');
    await expect(new EventLog(p).read()).rejects.toThrow(/line 2/);
  });

  it("computes the canonical log path under the show root", () => {
    expect(EventLog.logPath("/show", "s02e01", "run-7")).toBe(path.join("/show", "Production", "s02e01", "runs", "run-7.jsonl"));
  });

  it("refuses to build a path from an episode id that is not an episode id", () => {
    expect(() => EventLog.logPath("/show", "../../x", "r1")).toThrow(/invalid episode id/);
  });

  it("refuses to build a path from a run id outside the allowed alphabet", () => {
    expect(() => EventLog.logPath("/show", "s02e01", "../x")).toThrow(/invalid run id/);
    expect(() => EventLog.logPath("/show", "s02e01", "")).toThrow(/invalid run id/);
  });
});
