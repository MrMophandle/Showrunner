import { describe, it, expect } from "vitest";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

  it("stamps every event itself, ignoring a ts the caller supplied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const log = new EventLog(path.join(dir, "r1.jsonl"));
    const stale = { ts: "1999-01-01T00:00:00.000Z", runId: "r1", kind: "run_started" as const, payload: {} };
    const written = await log.append(stale as unknown as Parameters<typeof log.append>[0]);
    expect(written.ts).not.toBe(stale.ts);
    expect(Date.parse(written.ts)).toBeGreaterThan(Date.parse("2020-01-01T00:00:00.000Z"));
    expect((await log.read())[0]?.ts).toBe(written.ts);
  });

  it("names the malformed line and keeps the parse error as the cause", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "evlog-"));
    const p = path.join(dir, "bad.jsonl");
    await writeFile(p, '{"ts":"t","runId":"r","kind":"run_started","payload":{}}\nnot json\n');
    const err = await new EventLog(p).read().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBeInstanceOf(Error);
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

describe("readFrom", () => {
  it("returns the events after an offset and the offset to resume from, leaving a partial line unconsumed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "log-"));
    const log = new EventLog(path.join(root, "r.jsonl"));
    expect(await log.readFrom(0)).toEqual({ events: [], offset: 0 });
    await log.append({ runId: "r", kind: "run_started", payload: {} });
    await log.append({ runId: "r", stepId: "a", kind: "step_started", payload: {} });
    const first = await log.readFrom(0);
    expect(first.events.map((e) => e.kind)).toEqual(["run_started", "step_started"]);
    const partial = '{"ts":"t","runId":"r","kind":"step_comp';
    await appendFile(log.path, partial);
    const second = await log.readFrom(first.offset);
    expect(second).toEqual({ events: [], offset: first.offset });
    await appendFile(log.path, 'leted","payload":{}}\n');
    const third = await log.readFrom(second.offset);
    expect(third.events.map((e) => e.kind)).toEqual(["step_completed"]);
    expect(third.offset).toBe((await stat(log.path)).size);
  });
  it("logPath takes the production directory", () => {
    expect(EventLog.logPath("/show", "s02e01", "r1")).toBe(path.join("/show", "Production", "s02e01", "runs", "r1.jsonl"));
    expect(EventLog.logPath("/show", "s02e01", "r1", "Prod")).toBe(path.join("/show", "Prod", "s02e01", "runs", "r1.jsonl"));
  });
});
