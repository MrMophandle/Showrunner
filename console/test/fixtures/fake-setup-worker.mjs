// console/test/fixtures/fake-setup-worker.mjs — a setup-worker stand-in for the server's tests.
//
// It reads the bible run's log and appends whatever a real worker would append next, so one
// fixture drives the whole gate cycle:
//
//   * an empty or absent log      → run_started, the `write` step (unless FAKE_SETUP_MODE=default),
//                                   and gate_opened at attempt 1;
//   * a gate answered `approved`  → the gate completed and run_finished, which is what makes
//                                   `isApproved` true and the Bible row read approved/imported/
//                                   written-by-author;
//   * a gate answered `rejected`  → the fix agent's step and gate_opened at the next attempt.
//
// It writes no lock and exits at once, as `fake-worker.mjs` does: the server's refusals are tested
// by writing locks by hand, and a fixture that held one would make every test wait for it.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((p) => p.length));
const file = path.join(args.show, process.env.FAKE_SETUP_PRODUCTION_DIR ?? "Production", "setup", args.key, "runs", `${args.run}.jsonl`);
await mkdir(path.dirname(file), { recursive: true });

let lines = [];
try {
  const text = await readFile(file, "utf8");
  lines = text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
} catch {
  lines = [];
}

const ev = (kind, stepId, payload = {}) => JSON.stringify({
  ts: new Date().toISOString(), runId: args.run, ...(stepId ? { stepId } : {}), kind, payload,
}) + "\n";

const answered = [...lines].reverse().find((e) => e.kind === "gate_answered");
const opened = [...lines].reverse().find((e) => e.kind === "gate_opened");
let text = "";

if (answered === undefined) {
  if (lines.length === 0) {
    text += ev("run_started", undefined, { pipeline: `bible-${args.key}`, episodeId: "setup", trigger: args.operator });
  }
  if ((process.env.FAKE_SETUP_MODE ?? "interview") === "interview") {
    text += ev("step_started", "write", { kind: "agent" }) + ev("step_completed", "write", { result: `wrote ${args.key}` });
  }
  if (process.env.FAKE_SETUP_FAIL) {
    text += ev("step_started", "write", { kind: "agent" }) + ev("step_failed", "write", { error: process.env.FAKE_SETUP_FAIL })
      + ev("run_finished", undefined, { status: "failed" });
  } else {
    text += ev("gate_opened", "gate", { attempt: 1, message: `gate ${args.key}` });
  }
} else if (answered.payload.approved === true) {
  text += ev("step_completed", "gate", { result: "approved" }) + ev("run_finished", undefined, { status: "completed" });
} else {
  const attempt = (opened?.payload.attempt ?? 1) + 1;
  // A rejection runs the gate's fix agent and the gate reopens at the next attempt — or, when the
  // cap is reached, the gate fails with the engine's own wording, which is what the Bible row
  // reads as `stalled`.
  if (process.env.FAKE_SETUP_EXHAUST) {
    text += ev("step_failed", "gate", { error: `rejected ${attempt} times` }) + ev("run_finished", undefined, { status: "failed" });
  } else {
    text += ev("step_started", "revise", { kind: "agent" }) + ev("step_completed", "revise", { result: "revised" })
      + ev("gate_opened", "gate", { attempt, message: `gate ${args.key} (attempt ${attempt})` });
  }
}

await appendFile(file, text);
