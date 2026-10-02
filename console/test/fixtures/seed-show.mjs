// console/test/fixtures/seed-show.mjs — a temporary show for driving the client in a browser.
//
// Plan E's Task 6 has no browser test suite: the screenshots of these episodes are the review's
// evidence that the four surfaces draw what the spec says they draw. So this fixture's job is to
// put every state those surfaces have a branch for onto one Board, on disk, with no engine and no
// model involved — the run logs are written by hand, exactly as `test/helpers.ts`'s `seedRun`
// writes them for the server's own tests.
//
// Run it, and it prints the show root:
//
//   node console/test/fixtures/seed-show.mjs
//   node console/dist/server/main.js --show <that path> \
//     --worker console/test/fixtures/fake-worker.mjs --port 4400
//
// Five episodes. The brief names three — the first three below — and the last two are additions,
// each for a surface element the first three cannot show: `image-gate` needs a directory of images
// for the contact sheet and the flag-to-rejection path, and the `did nothing` loop flag and the
// Continue action only exist on a run that is crashed mid-step (`server/runs.ts` computes a loop's
// flag for a *running* step only).
//
// Every name here belongs to the invented show, "Harbor Light" — the same one `test/helpers.ts`
// uses. This repository names no real show anywhere.

import path from "node:path";
import zlib from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const GATES = ["outline-gate", "script-gate", "casting-gate", "audio-gate", "nano-banana-gate", "image-gate", "final-gate", "canon-gate"];

const CANON = [
  "world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula",
  "story-craft", "style-guide", "season-2", "visual-style", "voice-registry", "publishing-guide",
];

/** Writes one file under the show root, creating its directory. */
async function writeIn(root, rel, text) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

/** A run log, one JSON object per line, with the timestamps this fixture chose. */
async function seedRun(root, episodeId, runId, events) {
  const file = path.join(root, "Production", episodeId, "runs", `${runId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const lines = events.map((e) => `${JSON.stringify({
    ts: e.ts, runId,
    ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
    kind: e.kind, payload: e.payload ?? {},
  })}\n`);
  await writeFile(file, lines.join(""), "utf8");
  return file;
}

/** A lock file: the one fact a log cannot state. A pid nothing holds makes a run look crashed. */
async function writeLock(root, episodeId, runId, pid, groups = []) {
  const now = new Date().toISOString();
  const file = path.join(root, "Production", episodeId, "runs", `${runId}.lock`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ pid, startedAt: now, heartbeatAt: now, groups }), "utf8");
}

// ── a PNG writer, so the contact sheet has real frames to draw ────────────────────────────────
//
// Twenty lines of zlib and a CRC table, rather than checking binary fixtures into the repository:
// the images are generated, so the fixture is one file and the frames are legible (a distinct hue
// and a letterbox band each) instead of being 1×1 pixels nobody can see in a screenshot.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A 320×180 RGB PNG whose colour comes from `hue` (0–1), with a darker band across the middle so
 *  the frame reads as a frame. */
function framePng(hue) {
  const width = 320;
  const height = 180;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    const band = y > height * 0.62 ? 0.45 : 1;
    for (let x = 0; x < width; x++) {
      const t = x / width;
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.round(255 * band * (0.25 + 0.6 * hue * (1 - t)));
      raw[o + 1] = Math.round(255 * band * (0.3 + 0.45 * t));
      raw[o + 2] = Math.round(255 * band * (0.35 + 0.5 * (1 - hue) * t));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the show ──────────────────────────────────────────────────────────────────────────────────

const root = await mkdtemp(path.join(tmpdir(), "console-walkthrough-"));

await writeIn(root, "showrunner.json", JSON.stringify({
  showName: "Harbor Light",
  showSlug: "HarborLight",
  promptsDir: "prompts",
  models: { medium: "claude-sonnet-4-5", large: "claude-opus-4-1", writer: "claude-opus-4-1" },
  airMap: {},
  output: { nasRoot: path.join(root, "nas") },
}, null, 2));

for (const name of CANON) await writeIn(root, `Canon/${name}.md`, `# ${name}\n\nfixture canon for the walkthrough.\n`);
await writeIn(root, "Canon/refs.json", "{}");
await writeIn(root, "Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
await writeIn(root, "Episodes/_TEMPLATE/outline.md", "# Template\n");
for (const gate of GATES) {
  await writeIn(root, `prompts/${gate}.gate.md`, `${gate} for {{episodeId}}`);
  await writeIn(root, `prompts/${gate}.reject.md`, `${gate} rejected for {{episodeId}}`);
}

/** A clock that walks forward from `minutesAgo` minutes before now. */
function clock(minutesAgo) {
  let at = Date.now() - minutesAgo * 60_000;
  return (seconds = 0) => {
    at += seconds * 1000;
    return new Date(at).toISOString();
  };
}

// 1. s02e01 — no premise at all: NEEDS_IDEA, no runs, and a Launch button that must be disabled
//    with the reason rather than launching a run that would stop at the `premise` guard.
await mkdir(path.join(root, "Episodes", "s02e01"), { recursive: true });

// 2. s02e02 — parked at outline-gate, with the outline the gate is asking about and a verdict in
//    its log. The gate's message is markdown, and it carries a raw <script> tag so the screenshot
//    shows what this client does with HTML from a prompt: renders it as text.
await writeIn(root, "Episodes/s02e02/premise.md", "The harbourmaster's log has a week missing from it, and two people remember that week differently.\n");
await writeIn(root, "Episodes/s02e02/outline.md", `# The Missing Week

## Cold open
Vale reads the log aloud to an empty office. The page for Tuesday is gone — not torn, *cut*.

## Act one
- Vale walks the quay and asks three people the same question
- the dockmaster answers it twice, differently
- the tide chart disagrees with both of them

## Act two
The second account is the one that cannot be true, and it is the one with a witness.

| beat | who | where |
|---|---|---|
| 1 | Vale | the office |
| 2 | the dockmaster | the quay |
| 3 | both | the tide chart |
`);

const t2 = clock(26);
await seedRun(root, "s02e02", "20261002-1030-ab12", [
  { ts: t2(), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e02", pipelineHash: "9f2c41d0e8ab7c6b", engineVersion: "0.4.0", trigger: "console:walkthrough" } },
  { ts: t2(1), stepId: "previous-episode", kind: "step_started", payload: { kind: "guard" } },
  { ts: t2(1), stepId: "previous-episode", kind: "step_completed", payload: { result: { pass: true, message: "s02e01 is not aired; nothing to wait for" } } },
  { ts: t2(1), stepId: "premise", kind: "step_started", payload: { kind: "guard" } },
  { ts: t2(1), stepId: "premise", kind: "step_completed", payload: { result: { pass: true, message: "premise.md is 184 characters" } } },
  { ts: t2(2), stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
  { ts: t2(1), stepId: "outline", kind: "agent_query", payload: { promptFile: "outline.md", promptHash: "c1d2e3f405162738495a6b7c8d9e0f1122334455667788990011223344556677" } },
  { ts: t2(240), stepId: "outline", kind: "step_completed", payload: { result: "wrote Episodes/s02e02/outline.md (118 lines)", toolCalls: 9, outputHashes: { "Episodes/s02e02/outline.md": "aa11bb22cc33" } } },
  { ts: t2(2), stepId: "hand-edits-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t2(3), stepId: "hand-edits-outline", kind: "step_completed", payload: { result: "no hand edits since the last run" } },
  { ts: t2(2), stepId: "canon-review-outline", kind: "step_started", payload: { kind: "agent" } },
  { ts: t2(1), stepId: "canon-review-outline", kind: "agent_query", payload: { promptFile: "canon-review-outline.md", promptHash: "b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990011223344556677" } },
  {
    ts: t2(95), stepId: "canon-review-outline", kind: "step_completed",
    payload: {
      toolCalls: 14,
      result: {
        pass: false,
        issues: [
          { line: 14, issue: "the tide chart was established as weekly in s01e07, not daily" },
          { line: 31, issue: "the dockmaster has no name in the canon ledger yet — name him here or do not" },
        ],
      },
    },
  },
  { ts: t2(2), stepId: "outline-gate", kind: "step_started", payload: { kind: "gate" } },
  {
    ts: t2(1), stepId: "outline-gate", kind: "gate_opened",
    payload: {
      attempt: 1,
      message: `# Approve the outline for s02e02?

**The outline is at \`Episodes/s02e02/outline.md\`** and the canon reviewer did not pass it.

What it is asking you to decide:

1. whether *The Missing Week* is the episode, at this shape
2. whether the two canon findings below are wrong, or are things you are choosing
3. whether the act-two turn lands where you want it

The reviewer's two findings are in the verdict board. The second one is a naming decision and not
an error — if you want the dockmaster named, say the name when you reject.

<script>alert("a prompt wrote this")</script>

Reject with notes if any of that is wrong; the fix agent reads your notes and the outline is
written again from them.
`,
    },
  },
]);

// 3. s02e03 — failed at tts-generate, with everything up to casting approved behind it.
await writeIn(root, "Episodes/s02e03/premise.md", "A container that nobody ordered has been on the quay for eleven days, and the paperwork for it is perfect.\n");
await writeIn(root, "Episodes/s02e03/outline.md", "# Eleven Days\n\nThe paperwork is perfect, which is the problem.\n");
await writeIn(root, "Episodes/s02e03/script.md", "# Eleven Days\n\n## Cold open\n\nVALE: Eleven days.\n");

const t3 = clock(74);
const reviewers = ["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"];
await seedRun(root, "s02e03", "20261002-0915-cd34", [
  { ts: t3(), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e03", pipelineHash: "9f2c41d0e8ab7c6b", engineVersion: "0.4.0", trigger: "console:walkthrough" } },
  { ts: t3(1), stepId: "previous-episode", kind: "step_started", payload: { kind: "guard" } },
  { ts: t3(1), stepId: "previous-episode", kind: "step_completed", payload: { result: { pass: true } } },
  { ts: t3(1), stepId: "premise", kind: "step_started", payload: { kind: "guard" } },
  { ts: t3(1), stepId: "premise", kind: "step_completed", payload: { result: { pass: true } } },
  { ts: t3(2), stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
  { ts: t3(1), stepId: "outline", kind: "agent_query", payload: { promptFile: "outline.md", promptHash: "c1d2e3f405162738495a6b7c8d9e0f1122334455667788990011223344556677" } },
  { ts: t3(200), stepId: "outline", kind: "step_completed", payload: { result: "wrote Episodes/s02e03/outline.md", toolCalls: 7, outputHashes: { "Episodes/s02e03/outline.md": "dd44ee55" } } },
  { ts: t3(2), stepId: "hand-edits-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(2), stepId: "hand-edits-outline", kind: "step_completed", payload: { result: "no hand edits" } },
  { ts: t3(2), stepId: "outline-gate", kind: "step_started", payload: { kind: "gate" } },
  { ts: t3(1), stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the outline for s02e03?" } },
  { ts: t3(600), stepId: "outline-gate", kind: "gate_answered", payload: { approved: true, notes: "", by: "console:walkthrough", attempt: 1, waitedMs: 600_000 } },
  { ts: t3(1), stepId: "stamp-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(1), stepId: "stamp-outline", kind: "step_completed", payload: { result: { milestone: "outline", detail: "approved at outline-gate" } } },
  { ts: t3(2), stepId: "draft", kind: "step_started", payload: { kind: "loop" } },
  { ts: t3(120), stepId: "draft", kind: "loop_iteration", payload: { iteration: 1, toolCalls: 11 } },
  { ts: t3(140), stepId: "draft", kind: "loop_iteration", payload: { iteration: 2, toolCalls: 8 } },
  { ts: t3(90), stepId: "draft", kind: "step_completed", payload: { result: "DRAFT_COMPLETE after 3 iterations", toolCalls: 27, outputHashes: { "Episodes/s02e03/script.md": "ff66aa77" } } },
  { ts: t3(2), stepId: "hand-edits-script", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(2), stepId: "hand-edits-script", kind: "step_completed", payload: { result: "no hand edits" } },
  ...reviewers.flatMap((id, i) => [
    { ts: t3(2), stepId: id, kind: "step_started", payload: { kind: "agent" } },
    // A hash-shaped hash: the "then and now" table truncates it to twelve characters, and a
    // fixture string that is not hex would read as the table mangling a real one.
    { ts: t3(1), stepId: id, kind: "agent_query", payload: { promptHash: `${(i + 3).toString(16).repeat(2)}${"39f7a1c04e8b26d5".repeat(4)}`.slice(0, 64), promptFile: `${id}.md` } },
    { ts: t3(40), stepId: id, kind: "step_completed", payload: { toolCalls: 5, result: { pass: i !== 1, issues: i === 1 ? ["scene 6 and scene 7 open the same way"] : [] } } },
  ]),
  { ts: t3(2), stepId: "script-gate", kind: "step_started", payload: { kind: "gate" } },
  { ts: t3(1), stepId: "script-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the script for s02e03?" } },
  { ts: t3(420), stepId: "script-gate", kind: "gate_answered", payload: { approved: true, notes: "the flow note is a choice, keep it", by: "console:walkthrough", attempt: 1 } },
  { ts: t3(1), stepId: "stamp-script", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(1), stepId: "stamp-script", kind: "step_completed", payload: { result: { milestone: "script", detail: "panel passed, showrunner approved" } } },
  { ts: t3(2), stepId: "refs-ready", kind: "step_started", payload: { kind: "guard" } },
  { ts: t3(1), stepId: "refs-ready", kind: "step_completed", payload: { result: { pass: true, message: "no guest speakers in the cast list" } } },
  { ts: t3(2), stepId: "tts-script", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(12), stepId: "tts-script", kind: "step_completed", payload: { result: "wrote 142 lines for 6 speakers", outputHashes: { "Production/s02e03/tts-script.json": "11aa22bb" } } },
  { ts: t3(2), stepId: "validate-manifest", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(2), stepId: "validate-manifest", kind: "step_completed", payload: { result: { pass: true, message: "142 lines, 6 speakers, all voices LOCKED" } } },
  { ts: t3(2), stepId: "casting-gate", kind: "step_started", payload: { kind: "gate" } },
  { ts: t3(1), stepId: "casting-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the casting for s02e03?" } },
  { ts: t3(300), stepId: "casting-gate", kind: "gate_answered", payload: { approved: true, notes: "", by: "console:walkthrough", attempt: 1 } },
  { ts: t3(1), stepId: "stamp-casting", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(1), stepId: "stamp-casting", kind: "step_completed", payload: { result: { milestone: "casting", detail: "guest voices approved" } } },
  { ts: t3(2), stepId: "tts-generate", kind: "step_started", payload: { kind: "script" } },
  { ts: t3(20), stepId: "tts-generate", kind: "script_line", payload: { line: "elevenlabs: line 1/142 ok" } },
  { ts: t3(2), stepId: "tts-generate", kind: "script_line", payload: { line: "elevenlabs: line 2/142 ok" } },
  { ts: t3(2), stepId: "tts-generate", kind: "step_progress", payload: { done: 2, total: 142, unit: "lines" } },
  { ts: t3(2), stepId: "tts-generate", kind: "script_line", payload: { line: "elevenlabs: line 3/142 — HTTP 429" } },
  { ts: t3(1), stepId: "tts-generate", kind: "step_failed", payload: { error: "tts-generate exited 1\nelevenlabs returned 429 for line 3 after three retries\n  at post (scripts/tts_generate.py:181)" } },
  { ts: t3(1), kind: "run_finished", payload: { status: "failed" } },
]);

// Two questions already asked about s02e03's failure, so "What happened" has a troubleshooting
// log to read back. It is written beside the run's log and never inside it, and its would-be run
// id carries a dot, which `RUN_ID` refuses — so `RunStore` ignores the file rather than
// announcing it as a run that changed (`server/what-happened.ts` sets out why).
await writeIn(root, "Production/s02e03/runs/20261002-0915-cd34.troubleshooting.jsonl", [
  JSON.stringify({
    ts: new Date(Date.now() - 32 * 60_000).toISOString(),
    by: "console:walkthrough",
    question: "did tts-generate fail on the first line or part way through?",
    answer: "Part way through: the step logged `elevenlabs: line 1/142 ok` and `line 2/142 ok` at 09:42:13 and 09:42:15, and its last progress was 2 of 142 lines. The failure is on line 3 — `elevenlabs returned 429 for line 3 after three retries` — so the credentials and the manifest are fine and the problem is rate limiting, not configuration.",
    costUsd: 0.0214,
  }),
  JSON.stringify({
    ts: new Date(Date.now() - 19 * 60_000).toISOString(),
    by: "console:walkthrough",
    question: "is the prompt the outline step read still the one on disk?",
    answer: "Yes. `outline.md`'s hash at the run and its hash now are the same, so nothing has been edited under this run. The same is true of every prompt this run read.",
    costUsd: 0.0097,
  }),
].join("\n") + "\n");

// 4. s02e04 — parked at image-gate with a directory of frames, and one showrunner-made shot that
//    is not on disk. Its stage is NEEDS_IMAGES *and* its gate is open, which is the Board's
//    hardest row: `deriveStage` tests the NEEDS_ rules before it looks at the open gate
//    (engine/src/stages.ts), so both are true and the row has to show both.
await writeIn(root, "Episodes/s02e04/premise.md", "Two boats with the same name are tied up on opposite sides of the harbour.\n");
await writeIn(root, "Episodes/s02e04/outline.md", "# Same Name, Two Hulls\n\nThe registry says one of them does not exist.\n");
await writeIn(root, "Production/s02e04/images/prompts.json", JSON.stringify({
  shots: [
    { id: "s01-harbour-wide", source: "nano-banana", prompt: "the harbour at first light, wide" },
    { id: "s02-registry-desk", source: "nano-banana", prompt: "the registry desk, close on the ledger" },
    { id: "s03-two-hulls", source: "nano-banana", prompt: "two hulls, same name, opposite quays" },
    { id: "s04-vale-portrait", source: "showrunner", prompt: "Vale, three-quarter, the one you said you would make" },
  ],
}, null, 2));
for (const [i, id] of ["s01-harbour-wide", "s02-registry-desk", "s03-two-hulls"].entries()) {
  const file = path.join(root, "Production", "s02e04", "images", `${id}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, framePng(0.2 + i * 0.3));
}
await writeIn(root, "Production/s02e04/images/IMAGE-SHEET.md", "# s02e04 — image sheet\n\n| shot | source | state |\n|---|---|---|\n| s01-harbour-wide | nano-banana | generated |\n| s02-registry-desk | nano-banana | generated |\n| s03-two-hulls | nano-banana | generated |\n| s04-vale-portrait | showrunner | **not on disk** |\n");

const t4 = clock(48);
await seedRun(root, "s02e04", "20261002-0840-ef56", [
  { ts: t4(), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e04", pipelineHash: "9f2c41d0e8ab7c6b", engineVersion: "0.4.0" } },
  { ts: t4(1), stepId: "stamp-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t4(1), stepId: "stamp-outline", kind: "step_completed", payload: { result: { milestone: "outline" } } },
  { ts: t4(1), stepId: "stamp-script", kind: "step_started", payload: { kind: "script" } },
  { ts: t4(1), stepId: "stamp-script", kind: "step_completed", payload: { result: { milestone: "script" } } },
  { ts: t4(1), stepId: "stamp-casting", kind: "step_started", payload: { kind: "script" } },
  { ts: t4(1), stepId: "stamp-casting", kind: "step_completed", payload: { result: { milestone: "casting" } } },
  { ts: t4(1), stepId: "stamp-audio", kind: "step_started", payload: { kind: "script" } },
  { ts: t4(1), stepId: "stamp-audio", kind: "step_completed", payload: { result: { milestone: "audio", detail: "mix approved (-14 LUFS)" } } },
  { ts: t4(4), stepId: "image-generate", kind: "step_started", payload: { kind: "script" } },
  { ts: t4(30), stepId: "image-generate", kind: "step_progress", payload: { done: 1, total: 3, unit: "shots" } },
  { ts: t4(40), stepId: "image-generate", kind: "step_progress", payload: { done: 3, total: 3, unit: "shots" } },
  { ts: t4(5), stepId: "image-generate", kind: "step_completed", payload: { result: "3 shots generated, 1 left to the showrunner", outputHashes: { "Production/s02e04/images/s01-harbour-wide.png": "7788aabb" } } },
  { ts: t4(2), stepId: "image-audit-verdict", kind: "step_started", payload: { kind: "agent" } },
  { ts: t4(50), stepId: "image-audit-verdict", kind: "step_completed", payload: { toolCalls: 6, result: { pass: false, issues: ["s03-two-hulls: the second hull reads as the same boat"] } } },
  { ts: t4(2), stepId: "image-gate", kind: "step_started", payload: { kind: "gate" } },
  { ts: t4(1), stepId: "image-gate", kind: "gate_answered", payload: { approved: false, notes: "s02-registry-desk: the ledger is unreadable", by: "console:walkthrough", attempt: 1 } },
  { ts: t4(60), stepId: "image-gate", kind: "gate_opened", payload: { attempt: 2, message: "# Approve the shots for s02e04?\n\nThree of the four shots are on disk. **s04-vale-portrait is yours** and is not there yet.\n\nFlag any shot below to compose a re-roll note; a flagged shot with no reason means redo.\n" } },
]);

// 5. s02e05 — crashed mid-loop: a draft loop running, a lock whose pid is dead, two recorded
//    process groups, an iteration that called no tool, and twenty minutes of silence. This is the
//    `did nothing` flag, the amber stall label and the Continue action, none of which any state
//    above can show.
await writeIn(root, "Episodes/s02e05/premise.md", "The lighthouse keeper's replacement arrives a month early and will not say why.\n");
await writeIn(root, "Episodes/s02e05/outline.md", "# A Month Early\n\nHe has the paperwork. That is what is wrong with it.\n");

const t5 = clock(33);
await seedRun(root, "s02e05", "20261002-1005-gh78", [
  { ts: t5(), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e05", pipelineHash: "4c7b19ae55d0f331", engineVersion: "0.4.0" } },
  { ts: t5(1), stepId: "premise", kind: "step_started", payload: { kind: "guard" } },
  { ts: t5(1), stepId: "premise", kind: "step_completed", payload: { result: { pass: true } } },
  { ts: t5(2), stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
  { ts: t5(1), stepId: "outline", kind: "agent_query", payload: { promptFile: "outline.md", promptHash: "0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff" } },
  { ts: t5(150), stepId: "outline", kind: "step_completed", payload: { result: "wrote Episodes/s02e05/outline.md", toolCalls: 6 } },
  { ts: t5(2), stepId: "hand-edits-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t5(1), stepId: "hand-edits-outline", kind: "step_completed", payload: { result: "no hand edits" } },
  { ts: t5(2), stepId: "outline-gate", kind: "step_started", payload: { kind: "gate" } },
  { ts: t5(1), stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the outline for s02e05?" } },
  { ts: t5(240), stepId: "outline-gate", kind: "gate_answered", payload: { approved: true, notes: "", by: "console:walkthrough", attempt: 1 } },
  { ts: t5(1), stepId: "stamp-outline", kind: "step_started", payload: { kind: "script" } },
  { ts: t5(1), stepId: "stamp-outline", kind: "step_completed", payload: { result: { milestone: "outline" } } },
  { ts: t5(2), stepId: "draft", kind: "step_started", payload: { kind: "loop" } },
  { ts: t5(130), stepId: "draft", kind: "loop_iteration", payload: { iteration: 1, toolCalls: 9 } },
  { ts: t5(1), stepId: "draft", kind: "step_progress", payload: { done: 4, total: 11, unit: "scenes", message: "scene 4 drafted" } },
  { ts: t5(170), stepId: "draft", kind: "loop_iteration", payload: { iteration: 2, toolCalls: 0 } },
  { ts: t5(1), stepId: "draft", kind: "step_progress", payload: { done: 5, total: 11, unit: "scenes", message: "scene 5 drafted" } },
]);
// A pid nothing holds, and two process groups the dead worker recorded. 999998/999999 are above
// macOS's pid ceiling, so nothing is signalled when Continue kills them — the console reports the
// attempt, which is what the screenshot is for.
await writeLock(root, "s02e05", "20261002-1005-gh78", 999999, [999998, 999997]);

process.stdout.write(`${root}\n`);
