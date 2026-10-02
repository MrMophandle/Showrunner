// console/test/fixtures/fake-worker.mjs — a worker stand-in for the server's tests
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((p) => p.length));
const file = path.join(args.show, "Production", args.episode, "runs", `${args.run}.jsonl`);
await mkdir(path.dirname(file), { recursive: true });
const ev = (kind, stepId, payload = {}) => JSON.stringify({ ts: new Date().toISOString(), runId: args.run, ...(stepId ? { stepId } : {}), kind, payload }) + "\n";
const step = process.env.FAKE_WORKER_STEP ?? "fake";
let text = "";
if (!(await import("node:fs")).existsSync(file) || (await import("node:fs")).statSync(file).size === 0) text += ev("run_started", undefined, { pipeline: "episode", episodeId: args.episode, trigger: args.operator });
text += ev("step_started", step, { kind: "script" }) + ev("step_completed", step, { result: `${step} ok` });
if (process.env.FAKE_WORKER_GATE) text += ev("gate_opened", process.env.FAKE_WORKER_GATE, { attempt: 1, message: `gate ${process.env.FAKE_WORKER_GATE}` });
else text += ev("run_finished", undefined, { status: "completed" });
await appendFile(file, text);
