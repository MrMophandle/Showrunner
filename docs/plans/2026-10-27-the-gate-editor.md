# The Gate Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The showrunner edits a gate's markdown artifact (the outline, the script, the image sheet, the canon ledger) in the browser, from the gate page, and the gate shows the saved text at once — one file on disk, one version anywhere.

**Architecture:** The engine already treats a hand-edited artifact as the showrunner's (the `hand-edits-outline` / `hand-edits-script` guards, `engine/src/provenance.ts`), so nothing in the engine changes. The console gains a run-scoped file route (GET returns `{text, hash}`, POST writes atomically against a base hash and publishes a `file` message on the existing SSE channel), an editor page reached from the gate, and a gate page that refetches an artifact when a `file` message names it.

**Tech Stack:** Hono 4 server, React 18 + react-router-dom 7 client, vitest 4 (node for the server, jsdom for `test/client/*.test.tsx`), TypeScript strict / NodeNext / ESM.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §7 (the console's surfaces; the gate is one of its four) and §6 (the event log as the source of truth: the file on disk is the artifact; the console never keeps a second copy). The ruling this plan implements is Ryan's of 2026-10-27: "editing the script (or whatever file, be it outline, script, etc) and hitting 'save' needs to update the gate's view of the script. we don't need two versions floating around while trying to edit."

## Global Constraints

- **No show's name in `console/`** — fixtures and tests use Harbor Lights (Vale, the Warden, Pim, Maeve, Harbor). The grep `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` must print nothing.
- **A read-only show refuses every POST with 403** — the middleware at `console/server/app.ts:431` does this for every POST under `/api/shows/:show`; no handler re-checks it.
- **The artifact fence is the only path check** — `resolveArtifactPath` (`console/server/artifacts.ts:62`) is applied to every path this plan reads or writes; no handler resolves a path by hand.
- **The engine is not modified.** Hashes come from `hashFile` exported by `@showrunner/engine` (`engine/src/hash.ts`, sha256 hex of the file's bytes).
- **Typecheck and tests green at every commit:** `npm run typecheck -w console` and `npm test -w console`.
- **Commits end with exactly one trailer line:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Prose for the showrunner's eyes follows `~/.claude/CLAUDE.md`** (complete sentences, the actor named, no unanchored "now").

---

### Task 1: The run-scoped file route, the `file` message, and the artifact's path

**Files:**
- Modify: `console/shared/types.ts` (`GateArtifact.path`, `FileRead`, `FileWritten`, the `file` variant of `SseMessage`)
- Modify: `console/server/gates.ts:67-77` (`file()` and `dir()` carry `path`)
- Modify: `console/server/artifacts.ts` (new `editableArtifact`, `writeAtomically`)
- Modify: `console/server/runs.ts` (`RunStore.publishFile`)
- Modify: `console/server/app.ts` (two routes, after the `/files/:path{.+}` GET at line ~1113)
- Test: `console/test/editor.test.ts`

**Interfaces:**
- Consumes: `resolveArtifactPath(ctx, episodeId, showRelative)` → `{ok:true, rel, abs} | {ok:false, error}`; `gateView(ctx, store, episodeId, runId)` → `GateView | undefined`; `readLock(ctx, episodeId, runId)` → `{pid, alive, …} | undefined`; `hashFile(abs)` → `string | null` from `@showrunner/engine`; `checkIds(c)`, `readJsonBody(c)` in `app.ts`; `RunStore.#publish` (private) and `RunStore.subscribe`.
- Produces: `GET /api/shows/:show/episodes/:id/runs/:run/files/:path{.+}` → `FileRead = { path: string; text: string; hash: string }`; `POST` same url with body `{ text: string; baseHash: string }` → `FileWritten = { path: string; hash: string; bytes: number }`; SSE message `{ type: "file"; show: string; episodeId: string; runId: string; path: string; hash: string }`; `GateArtifact.path` (show-relative, e.g. `Episodes/s02e01/script.md`).

- [x] **Step 1: Types.** In `console/shared/types.ts` add `path: string` to `GateArtifact` (doc: "the show-relative path the url serves, for the editor's address and for matching a `file` message"), add the `file` variant to `SseMessage`:

```ts
  | { type: "file"; show: string; episodeId: string; runId: string; path: string; hash: string }
```

and add, beside `GateArtifact`:

```ts
/** One markdown artifact of an open gate, as the editor reads it: the text and the sha256 hex of
 *  the bytes on disk. The hash goes back as `baseHash` on the write, so a save against a file
 *  that changed underneath the editor is refused (409) rather than silently overwriting it. */
export interface FileRead { path: string; text: string; hash: string }
/** The answer to a write: the hash of what is now on disk, which is the next write's `baseHash`. */
export interface FileWritten { path: string; hash: string; bytes: number }
```

- [x] **Step 2: `path` on artifacts.** In `console/server/gates.ts` make `file()` return `{ kind, label, path: showRelative, url }` and `dir()` return `{ kind, label, path: showRelative, url, listUrl: url }`. Run `npm run typecheck -w console`; fix the test fixtures in `console/test/client/gate-page.test.tsx` and `console/test/gates.test.ts` that build a `GateArtifact` by adding `path` (the script fixture's path is `Episodes/s02e01/script.md`).

- [x] **Step 3: Write the failing route tests.** Create `console/test/editor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SseMessage } from "../shared/types.js";
import { appWith, appWithShows, makeShow, seedRun, writeIn, writeLock, type SeedEvent } from "./helpers.js";

const FILES = "/api/shows/show/episodes/s02e01/runs/r1/files";
const SCRIPT = "Episodes/s02e01/script.md";
const sha = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** A show with one run of s02e01 parked at `gateId` — the same seed `test/gates.test.ts` uses. */
async function parkedAt(gateId: string, before: SeedEvent[] = []) {
  const { root, app, ctx, store } = await appWith(await makeShow());
  await seedRun(root, "s02e01", "r1", [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
    ...before,
    { stepId: gateId, kind: "gate_opened", payload: { attempt: 1, message: `Approve ${gateId}.` } },
  ]);
  return { root, app, ctx, store };
}

const post = (app: { request: (u: string, i?: RequestInit) => Promise<Response> }, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the editor's file route", () => {
  it("reads the script at an open script gate, with the sha256 of its bytes", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    await writeIn(root, SCRIPT, "## COLD OPEN\n\nVale checked the tide table twice.\n");
    const res = await app.request(`${FILES}/${SCRIPT}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; text: string; hash: string };
    expect(body.path).toBe(SCRIPT);
    expect(body.text).toBe("## COLD OPEN\n\nVale checked the tide table twice.\n");
    expect(body.hash).toBe(sha(body.text));
    store.close();
  });

  it("is 404 when no gate is open on the run", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [{ kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } }]);
    await writeIn(root, SCRIPT, "x\n");
    const res = await app.request(`${FILES}/${SCRIPT}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("no gate is open");
    store.close();
  });

  it("is 403 for a markdown file the open gate does not list", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    await writeIn(root, "Episodes/s02e01/outline.md", "# outline\n");
    const res = await app.request(`${FILES}/Episodes/s02e01/outline.md`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("not a file script-gate edits");
    store.close();
  });

  it("is 400 for a file that is not markdown, and 400 for a path the fence refuses", async () => {
    const { root, app, store } = await parkedAt("casting-gate");
    await writeIn(root, "Production/s02e01/tts-script.json", "{}");
    expect((await app.request(`${FILES}/Production/s02e01/tts-script.json`)).status).toBe(400);
    expect((await app.request(`${FILES}/Canon/world-overview.md`)).status).toBe(400);
    store.close();
  });

  it("writes atomically against the base hash, answers the new hash, and publishes a file message", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    const before = "## COLD OPEN\n\nVale checked the tide table twice.\n";
    await writeIn(root, SCRIPT, before);
    const seen: SseMessage[] = [];
    const unsubscribe = store.subscribe((m) => { seen.push(m); });
    const after = "## COLD OPEN\n\nVale checked the tide table once.\n";
    const res = await post(app, `${FILES}/${SCRIPT}`, { text: after, baseHash: sha(before) });
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string; hash: string; bytes: number };
    expect(body.hash).toBe(sha(after));
    expect(body.bytes).toBe(Buffer.byteLength(after, "utf8"));
    expect(await readFile(path.join(root, SCRIPT), "utf8")).toBe(after);
    expect((await readdir(path.join(root, "Episodes", "s02e01"))).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(seen).toContainEqual({ type: "file", show: "show", episodeId: "s02e01", runId: "r1", path: SCRIPT, hash: sha(after) });
    unsubscribe();
    store.close();
  });

  it("refuses a stale base hash with 409 and the current hash, leaving the file alone", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    await writeIn(root, SCRIPT, "current text\n");
    const res = await post(app, `${FILES}/${SCRIPT}`, { text: "my edit\n", baseHash: sha("what I opened\n") });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; hash: string };
    expect(body.error).toContain("changed on disk");
    expect(body.hash).toBe(sha("current text\n"));
    expect(await readFile(path.join(root, SCRIPT), "utf8")).toBe("current text\n");
    store.close();
  });

  it("refuses a write while a live worker holds the run", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    await writeIn(root, SCRIPT, "text\n");
    await writeLock(root, "s02e01", "r1", process.pid);
    const res = await post(app, `${FILES}/${SCRIPT}`, { text: "edit\n", baseHash: sha("text\n") });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("held by pid");
    store.close();
  });

  it("rejects a body without text or baseHash with 400", async () => {
    const { root, app, store } = await parkedAt("script-gate");
    await writeIn(root, SCRIPT, "text\n");
    expect((await post(app, `${FILES}/${SCRIPT}`, { text: "edit\n" })).status).toBe(400);
    expect((await post(app, `${FILES}/${SCRIPT}`, { baseHash: sha("text\n") })).status).toBe(400);
    store.close();
  });

  it("is 403 on a read-only show, by the middleware every POST passes through", async () => {
    const root = await makeShow();
    const { app, stores } = await appWithShows([{ key: "show", root, readOnly: true }]);
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "script-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve script-gate." } },
    ]);
    await writeIn(root, SCRIPT, "text\n");
    const res = await post(app, `${FILES}/${SCRIPT}`, { text: "edit\n", baseHash: sha("text\n") });
    expect(res.status).toBe(403);
    for (const s of stores.values()) s.close();
  });
});
```

Read `console/test/helpers.ts:136-186` for the exact return shape of `appWithShows` and `appWith` (the names `stores` / `store` above are the ones they return; if `appWithShows` returns them under another name, use that name and keep the assertions).

- [x] **Step 4: Run the tests to verify they fail.** `npm test -w console -- test/editor.test.ts` — expected: every test fails on a 404 from Hono (no route) or a type error on `path`.

- [x] **Step 5: The store publishes a file message.** In `console/server/runs.ts`, on `RunStore`, beside `subscribe`:

```ts
  /** Tells every subscriber that the editor wrote one of a run's artifacts: the Gate page refetches
   *  the pane that shows it, and an editor open on the same file in another tab learns the hash
   *  it holds is stale. Published by the file route and by nothing else — the engine's own writes
   *  reach the pages as `run` messages, through the log. */
  publishFile(episodeId: string, runId: string, path: string, hash: string): void {
    this.#publish({ type: "file", show: this.#ctx.key, episodeId, runId, path, hash });
  }
```

- [x] **Step 6: The fence for an editable artifact, and the atomic write.** In `console/server/artifacts.ts` add:

```ts
import { rename, rm, writeFile } from "node:fs/promises";
import type { RunStore } from "./runs.js";
import { gateView } from "./gates.js";

/** The one artifact the editor may read or write: a markdown file the run's OPEN gate lists.
 *  Three refusals, each its own status: the fence's 400 (`resolveArtifactPath`, then "not
 *  markdown"), a 404 when no gate is open on the run, and a 403 when the gate is open but does
 *  not list this file — `Episodes/<id>/outline.md` at the script gate, say, which is a real file
 *  the showrunner may not edit from there because nothing downstream would notice the edit. */
export async function editableArtifact(
  ctx: ShowContext, store: RunStore, episodeId: string, runId: string, showRelative: string,
): Promise<{ ok: true; rel: string; abs: string; gateId: string } | { ok: false; status: 400 | 403 | 404; error: string }> {
  const fenced = resolveArtifactPath(ctx, episodeId, showRelative);
  if (!fenced.ok) return { ok: false, status: 400, error: fenced.error };
  if (!fenced.rel.endsWith(".md")) return { ok: false, status: 400, error: `path ${JSON.stringify(fenced.rel)} is not a markdown file; the editor edits markdown only` };
  const view = await gateView(ctx, store, episodeId, runId);
  if (view === undefined) return { ok: false, status: 404, error: `no gate is open on run ${runId} of ${episodeId}; a file is editable only while a gate that lists it is open` };
  const listed = view.artifacts.some((a) => a.kind === "markdown" && a.path === fenced.rel);
  if (!listed) return { ok: false, status: 403, error: `${fenced.rel} is not a file ${view.stepId} edits` };
  return { ok: true, rel: fenced.rel, abs: fenced.abs, gateId: view.stepId };
}

/** Writes `text` to `abs` by way of a sibling temp file and a rename, so a reader never sees a
 *  half-written artifact and a crash leaves the old text in place. The temp name carries the pid
 *  and does not start with a dot, so a leftover is visible in a listing rather than hidden. */
export async function writeAtomically(abs: string, text: string): Promise<number> {
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return Buffer.byteLength(text, "utf8");
}
```

If importing `gates.js` from `artifacts.js` makes a cycle (`gates.ts` imports `artifactUrl`… check: `gates.ts` does not import `artifacts.ts` today; `app.ts` imports both), keep it; if it does, move `editableArtifact` into `gates.ts` instead and import `resolveArtifactPath` there.

- [x] **Step 7: The routes.** In `console/server/app.ts`, after the `/files/:path{.+}` GET (line ~1113), add:

```ts
  /** The editor's read of one artifact of the run's open gate: the text and the hash the write
   *  must carry back. Run-scoped, unlike the artifact route above, because "which files may be
   *  edited" is a fact about the gate that is open, not about the episode's tree. */
  app.get("/api/shows/:show/episodes/:id/runs/:run/files/:path{.+}", async (c) => {
    const ctx = c.get("ctx");
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const target = await editableArtifact(ctx, c.get("store"), checked.id, checked.run, c.req.param("path"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const hash = await hashFile(target.abs);
    if (hash === null) return c.json({ error: `${target.rel} does not exist` }, 404);
    const text = await readFile(target.abs, "utf8");
    return c.json({ path: target.rel, text, hash } satisfies FileRead);
  });

  /** The editor's save. The body's `baseHash` is the hash the editor read; a file whose bytes no
   *  longer hash to it has changed underneath the editor — another tab, the showrunner's own
   *  editor, a worker — and the write is refused with the current hash rather than applied over
   *  the top. A live worker holding the run refuses the write too, as every action route does. */
  app.post("/api/shows/:show/episodes/:id/runs/:run/files/:path{.+}", async (c) => {
    const ctx = c.get("ctx");
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const body = await readJsonBody(c);
    const text = body["text"];
    const baseHash = body["baseHash"];
    if (typeof text !== "string") return c.json({ error: "text must be a string" }, 400);
    if (typeof baseHash !== "string" || baseHash === "") return c.json({ error: "baseHash must be the hash the editor read" }, 400);
    const store = c.get("store");
    const target = await editableArtifact(ctx, store, checked.id, checked.run, c.req.param("path"));
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const held = await readLock(ctx, checked.id, checked.run);
    if (held?.alive === true) return c.json({ error: `run ${checked.run} is held by pid ${held.pid}` }, 409);
    const current = await hashFile(target.abs);
    if (current !== baseHash) {
      return c.json({ error: `${target.rel} changed on disk since the editor read it; reload to see the current text`, hash: current }, 409);
    }
    const bytes = await writeAtomically(target.abs, text);
    const hash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    store.publishFile(checked.id, checked.run, target.rel, hash);
    return c.json({ path: target.rel, hash, bytes } satisfies FileWritten);
  });
```

Imports to add at the top of `app.ts`: `createHash` from `node:crypto`, `readFile` from `node:fs/promises`, `hashFile` from `@showrunner/engine` (check `engine/src/index.ts:8` re-exports `hash.js`), `editableArtifact, writeAtomically` from `./artifacts.js`, `FileRead, FileWritten` types from `../shared/types.js`. Route order: Hono matches by registration; register these two **before** nothing in particular, since `/runs/:run/files/…` shares no prefix with `/files/…` and the existing `/runs/:run/gate|resume|…` routes are literal segments.

- [x] **Step 8: Run the tests.** `npm test -w console -- test/editor.test.ts` — expected: 9 passed. Then the whole suite and the typecheck: `npm test -w console && npm run typecheck -w console`.

- [x] **Step 9: Commit.**

```bash
git add console/shared/types.ts console/server/gates.ts console/server/artifacts.ts console/server/runs.ts console/server/app.ts console/test/editor.test.ts console/test/gates.test.ts console/test/client/gate-page.test.tsx
git commit -m "console: a run-scoped file route for the gate's markdown artifacts, hashed writes, and a file message

The editor reads one markdown artifact of the run's open gate as {text, hash} and writes it
back against that hash: a file that changed underneath the editor is refused with 409 and
the current hash, a live worker refuses the write, and the write is a sibling temp file and
a rename. A successful write publishes a file message on the SSE channel, so the Gate page
and any other editor on the same file learn of it. GateArtifact carries its show-relative
path for the editor's address.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The editor page

**Files:**
- Create: `console/src/pages/Edit.tsx`
- Modify: `console/src/App.tsx:61` (route), `console/src/api.ts` (`filePath`, `editHref`), `console/src/console.css` (`.editor-*`)
- Test: `console/test/client/edit-page.test.tsx`

**Interfaces:**
- Consumes: Task 1's `GET`/`POST …/runs/:run/files/<path>` and the `FileRead` / `FileWritten` types; `useApi`, `post`, `ApiError`, `useConsole().canAct`, `useSSE`, `useShowKey`, `showHref`, `showPath` from `src/api.ts`; `Markdown` from `src/components/Markdown.tsx`; `readOnlyLine` from `src/projections.ts`.
- Produces: the route `/shows/:show/episodes/:id/runs/:run/edit/*` (the splat is the show-relative path); `editHref(show, episodeId, runId, showRelative)` and `filePath(show, episodeId, runId, showRelative)` in `src/api.ts`, both encoding each path segment the way `artifactUrl` does (`server/gates.ts:56`).

- [x] **Step 1: Address builders.** In `console/src/api.ts`, beside `showHref`:

```ts
/** A show-relative path as url segments: each segment encoded on its own, so a slash stays a
 *  slash — the same shape `artifactUrl` builds on the server (`server/gates.ts`). */
function encodedSegments(showRelative: string): string {
  return showRelative.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

/** The api address of one editable artifact of a run's open gate (Task 1's file route). */
export function filePath(show: string, episodeId: string, runId: string, showRelative: string): string {
  return showPath(show, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}/files/${encodedSegments(showRelative)}`);
}

/** The browser address of the editor for that artifact. */
export function editHref(show: string, episodeId: string, runId: string, showRelative: string): string {
  return showHref(show, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}/edit/${encodedSegments(showRelative)}`);
}
```

Add to `console/test/client/api-paths.test.ts` one case each: `filePath("harbor", "s02e01", "r1", "Episodes/s02e01/script.md")` is `/api/shows/harbor/episodes/s02e01/runs/r1/files/Episodes/s02e01/script.md`, and `editHref` with the same arguments is `/shows/harbor/episodes/s02e01/runs/r1/edit/Episodes/s02e01/script.md`; and a path with a space in a segment (`Production/s02e01/images/IMAGE SHEET.md`) encodes the space as `%20` and keeps the slashes.

- [x] **Step 2: Write the failing page test.** Create `console/test/client/edit-page.test.tsx`, following `gate-page.test.tsx`'s four stubs (fetch keyed on url, `FakeEventSource`, `MemoryRouter` with the real route, `ConsoleContext.Provider`):

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConsoleContext, type ConsoleData } from "../../src/api.js";
import { Edit } from "../../src/pages/Edit.js";

afterEach(cleanup);

const FILE_URL = "/api/shows/harbor/episodes/s02e01/runs/r1/files/Episodes/s02e01/script.md";
const EDIT_HREF = "/shows/harbor/episodes/s02e01/runs/r1/edit/Episodes/s02e01/script.md";
const TEXT = "## COLD OPEN\n\nVale checked the tide table twice.\n";
const HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void { /* nothing to close */ }
}

/** The network: the file read, and a POST that answers as `onPost` says. */
function stubFetch(onPost: (body: unknown) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === FILE_URL && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ path: "Episodes/s02e01/script.md", text: TEXT, hash: HASH }), { status: 200 });
    }
    if (url === FILE_URL && init?.method === "POST") return onPost(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  return fetchMock;
}

function mount(canAct = true) {
  const data: ConsoleData = { show: null, showError: null, canAct, readOnly: !canAct } as ConsoleData;
  return render(
    <ConsoleContext.Provider value={data}>
      <MemoryRouter initialEntries={[EDIT_HREF]}>
        <Routes>
          <Route path="/shows/:show/episodes/:id/runs/:run/edit/*" element={<Edit />} />
        </Routes>
      </MemoryRouter>
    </ConsoleContext.Provider>,
  );
}

describe("the editor page", () => {
  it("shows the file's text in the box and renders its heading in the preview", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    expect(box).toHaveValue(TEXT);
    expect(screen.getByRole("heading", { name: "COLD OPEN" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the gate/i })).toHaveAttribute("href", "/shows/harbor/episodes/s02e01/runs/r1/gate");
  });

  it("saves the typed text against the hash it read, then shows the save", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ path: "Episodes/s02e01/script.md", hash: NEW_HASH, bytes: 10 }), { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: TEXT + "\nMaeve said nothing.\n" } });
    expect(save).toBeEnabled();
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/^saved/i)).toBeInTheDocument());
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({ text: TEXT + "\nMaeve said nothing.\n", baseHash: HASH });
    expect(save).toBeDisabled();
  });

  it("keeps the typed text and says so when the save is refused as stale", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "Episodes/s02e01/script.md changed on disk since the editor read it; reload to see the current text", hash: NEW_HASH }), { status: 409 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/changed on disk/i)).toBeInTheDocument());
    expect(box).toHaveValue("my edit\n");
    expect(screen.getByRole("button", { name: /load the current text/i })).toBeInTheDocument();
  });

  it("is read-only, with no Save, when the console cannot act on the show", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount(false);
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    expect(box).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });
});
```

Check `ConsoleData`'s fields in `src/api.ts:495-520` and build the value with every required field rather than the cast, if the cast fails the typecheck.

- [x] **Step 3: Run it to verify it fails.** `npm test -w console -- test/client/edit-page.test.tsx` — expected: fails to import `../../src/pages/Edit.js`.

- [x] **Step 4: The page.** Create `console/src/pages/Edit.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FileRead, FileWritten } from "../../shared/types.js";
import { ApiError, editHref, filePath, post, showHref, useApi, useConsole, useSSE, useShowKey } from "../api.js";
import { readOnlyLine } from "../projections.js";
import { Markdown } from "../components/Markdown.js";

/** The editor for one markdown artifact of a run's open gate — the outline, the script, the image
 *  sheet, the canon ledger — reached from the Edit link on the gate's pane.
 *
 *  **One file, one version (Ryan, 2026-10-27).** The box holds the file on disk and nothing else
 *  holds a copy: Save writes the file the gate page reads, the server publishes a `file` message,
 *  and the gate's pane refetches. The hash the page read goes back with the save as `baseHash`,
 *  so a save over a file that changed underneath — another tab, a worker — is refused (409) and
 *  the typed text stays in the box for the showrunner to reconcile, never silently overwritten and
 *  never silently discarded.
 *
 *  The preview is the same renderer the gate's pane uses, fed from the box as it is typed: what
 *  the showrunner sees on the right is what the gate will show. */
export function Edit() {
  const params = useParams();
  const showKey = useShowKey();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const showRelative = params["*"] ?? "";
  const { canAct, readOnly } = useConsole();
  const api = filePath(showKey, episodeId, runId, showRelative);
  const gateHref = showHref(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}/gate`);
  const file = useApi<FileRead>(api);

  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);

  // The box is filled from the first successful read, and refilled only when the showrunner
  // asks ("load the current text") — a refetch must never replace what is being typed.
  useEffect(() => {
    if (file.data === null || loaded.current === file.data.hash) return;
    loaded.current = file.data.hash;
    setText(file.data.text);
    setSaved(file.data.text);
    setHash(file.data.hash);
    setElsewhere(null);
  }, [file.data]);

  const dirty = text !== null && text !== saved;

  // Another save of this file — another tab, another editor — arrives as a `file` message with a
  // hash this page does not hold. With nothing typed, follow it; with edits in the box, say so.
  useSSE((message) => {
    if (message.type !== "file" || message.show !== showKey || message.episodeId !== episodeId || message.runId !== runId || message.path !== showRelative) return;
    if (message.hash === hash) return;
    if (!dirty) { file.refetch(); return; }
    setElsewhere("This file was saved elsewhere while you were editing. Save will be refused until you load the current text; your edits stay in the box until then.");
  });

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, [dirty]);

  async function save(): Promise<void> {
    if (text === null || hash === null || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const written = await post<FileWritten>(api, { text, baseHash: hash });
      setHash(written.hash);
      loaded.current = written.hash;
      setSaved(text);
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setElsewhere(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof ApiError && err.status === 409) setElsewhere("stale");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  });

  const label = showRelative.split("/").pop() ?? showRelative;

  if (file.error !== null && file.data === null) {
    return (
      <section className="editor">
        <p className="error-line">{file.error}</p>
        <Link to={gateHref}>Back to the gate</Link>
      </section>
    );
  }
  if (text === null) return <p className="quiet">reading…</p>;

  const status = busy ? "saving…"
    : error !== null ? null
    : dirty ? "unsaved changes"
    : savedAt !== null ? `saved ${savedAt}`
    : "no changes";

  return (
    <section className="editor">
      <header className="editor-head">
        <Link to={gateHref} className="btn btn-small">Back to the gate</Link>
        <span className="mono editor-path">{showRelative}</span>
        {canAct && (
          <button type="button" className="btn" disabled={!dirty || busy} onClick={() => { void save(); }}>Save</button>
        )}
        {status !== null && <span className="quiet">{status}</span>}
        {error !== null && <span className="error-line">{error}</span>}
      </header>
      {readOnly && <p className="quiet">{readOnlyLine()}</p>}
      {elsewhere !== null && (
        <p className="editor-notice">
          {elsewhere === "stale" ? "The file changed on disk since you opened it." : elsewhere}{" "}
          <button type="button" className="btn btn-small" onClick={() => { loaded.current = null; file.refetch(); }}>load the current text</button>
        </p>
      )}
      <div className="editor-split">
        <textarea
          className="editor-text mono"
          aria-label={label}
          value={text}
          readOnly={!canAct}
          spellCheck
          onChange={(e) => { setText(e.target.value); }}
        />
        <Markdown text={text} className="editor-preview" />
      </div>
    </section>
  );
}
```

Read `readOnlyLine`'s signature in `src/projections.ts` and call it as it is declared (it may take the show key). If `useConsole()` exposes `readOnly` under another name, use that.

- [x] **Step 5: Route and styles.** In `console/src/App.tsx` add, after the gate route at line 61:

```tsx
        <Route path="episodes/:id/runs/:run/edit/*" element={<Edit />} />
```

with `import { Edit } from "./pages/Edit.js";`. In `console/src/console.css`, after `.artifact-head` (line ~512):

```css
/* The editor page: the box and the preview side by side, each with its own scrollbar, the page
   never scrolling as a whole — the Save button stays where it is while a 400-line script is
   being read. */
.editor { display: flex; flex-direction: column; gap: 0.6rem; height: calc(100vh - 7rem); }
.editor-head { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.editor-path { color: var(--text-dim); }
.editor-notice { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.5rem 0.9rem; }
.editor-split { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; min-height: 0; flex: 1; }
.editor-text { width: 100%; height: 100%; resize: none; padding: 0.6rem 0.9rem; background: var(--bg-raised); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); line-height: 1.5; font-size: 0.95rem; }
.editor-preview { overflow: auto; padding: 0.6rem 0.9rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-raised); }
@media (max-width: 60rem) { .editor-split { grid-template-columns: 1fr; } }
```

Use the variable names `console.css` already defines (`--bg-raised`, `--border`, `--radius`, `--text`, `--text-dim`, `--mono`); check lines 1-40 and substitute if a name differs.

- [x] **Step 6: Run the tests.** `npm test -w console -- test/client/edit-page.test.tsx test/client/api-paths.test.ts` — expected: pass. Then `npm test -w console && npm run typecheck -w console`.

- [x] **Step 7: Commit.**

```bash
git add console/src/pages/Edit.tsx console/src/App.tsx console/src/api.ts console/src/console.css console/test/client/edit-page.test.tsx console/test/client/api-paths.test.ts
git commit -m "console: the editor page for a gate's markdown artifact

The box holds the file on disk and the preview is the gate's own renderer fed from the box.
Save writes against the hash the page read; a 409 keeps the typed text and offers the
current text instead of overwriting either. A file message for this path from elsewhere is
followed when nothing is typed and announced when something is. Cmd/Ctrl+S saves; leaving
with unsaved edits asks first.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The gate's Edit link and the pane that follows the save

**Files:**
- Modify: `console/src/pages/Gate.tsx:51-56` (`MarkdownArtifact` takes a `version`), `:127-129` (the SSE handler), `:242-251` (the pane head)
- Modify: `console/test/client/gate-page.test.tsx`
- Modify: `docs/specs/2026-09-25-console-rewrite-design.md` (§8 change log)

**Interfaces:**
- Consumes: Task 1's `GateArtifact.path` and the `file` SSE message; Task 2's `editHref`.
- Produces: an `edit` link on every markdown artifact pane when `canAct`; a pane that refetches when a `file` message names its path.

- [x] **Step 1: Write the failing tests.** In `console/test/client/gate-page.test.tsx`, make `FakeEventSource` remember its last instance (`static last: FakeEventSource | null = null;` set in the constructor) so a test can push a message with `FakeEventSource.last?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }))`. Add two tests to the existing describe (keep the fixture's `GateArtifact` with `path: "Episodes/s02e01/script.md"` from Task 1):

```tsx
  it("offers an edit link on the script's pane, to the editor's address", async () => {
    stubFetch(view());
    mountGate();
    await screen.findByText(SCRIPT_LINE);
    expect(screen.getByRole("link", { name: /^edit$/i })).toHaveAttribute("href", "/shows/harbor/episodes/s02e01/runs/r1/edit/Episodes/s02e01/script.md");
  });

  it("refetches the script's pane when a file message names it", async () => {
    let served = SCRIPT_LINE;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/gate")) return new Response(JSON.stringify(view()), { status: 200 });
      if (url === SCRIPT_URL) return new Response(served, { status: 200 });
      return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
    }));
    vi.stubGlobal("EventSource", FakeEventSource);
    mountGate();
    await screen.findByText(SCRIPT_LINE);
    served = "INT. HARBOR OFFICE — DUSK";
    FakeEventSource.last?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "file", show: "harbor", episodeId: "s02e01", runId: "r1", path: "Episodes/s02e01/script.md", hash: "c".repeat(64) }) }));
    await waitFor(() => expect(screen.getByText("INT. HARBOR OFFICE — DUSK")).toBeInTheDocument());
  });
```

`view()` and `mountGate()` are whatever the file already names its fixture builder and its render helper; use those names. The existing tests mount with `canAct: true`, which the link needs.

- [x] **Step 2: Run them to verify they fail.** `npm test -w console -- test/client/gate-page.test.tsx` — expected: the two new tests fail (no link; no refetch).

- [x] **Step 3: The pane follows the save, and carries the link.** In `console/src/pages/Gate.tsx`:

```tsx
/** A gate's markdown artifact … (keep the existing comment, and add:) `version` changes when a
 *  `file` message names this pane's path — the editor saved it — and the pane refetches, so the
 *  gate shows the saved text without a reload: one file, one version (Ryan, 2026-10-27). */
function MarkdownArtifact({ url, version }: { url: string; version: string }) {
  const file = useTextApi(url);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    file.refetch();
  }, [version, file]);
  if (file.error !== null && file.data === null) return <p className="error-line">{file.error}</p>;
  if (file.data === null) return <p className="quiet">reading…</p>;
  return <Markdown text={file.data} className="pane" />;
}
```

In `Gate()`, add state `const [fileVersions, setFileVersions] = useState<Record<string, string>>({});` and extend the SSE handler:

```tsx
  useSSE((message) => {
    if (message.show !== showKey || message.episodeId !== episodeId || message.runId !== runId) return;
    if (message.type === "run") setChanged(true);
    if (message.type === "file") setFileVersions((v) => ({ ...v, [message.path]: message.hash }));
  });
```

(`hello`, `episodes` and `setup` messages carry no `episodeId`; narrow on `message.type` before reading it if the union makes the first line a type error — read the `SseMessage` union in `shared/types.ts:475` and write the guard the types allow.) In the pane head, after the download link, for markdown artifacts when `canAct`:

```tsx
              {artifact.kind === "markdown" && canAct && (
                <Link className="btn btn-small" to={editHref(showKey, episodeId, runId, artifact.path)}>edit</Link>
              )}
```

and render the pane as `<MarkdownArtifact url={artifact.url} version={fileVersions[artifact.path] ?? ""} />`. Import `editHref` from `../api.js` and `useRef` if not already imported (it is, line 1).

- [x] **Step 4: Run the tests.** `npm test -w console -- test/client/gate-page.test.tsx` — expected: all pass. Then `npm test -w console && npm run typecheck -w console`.

- [x] **Step 5: The spec's change log.** Append to §8 of `docs/specs/2026-09-25-console-rewrite-design.md`:

```markdown
- **2026-10-27 — the gate editor.** A gate's markdown artifact (outline, script, image sheet, canon ledger) is editable in the console from the gate's pane: a run-scoped file route reads `{text, hash}` and writes against that hash (409 on a file that changed underneath, 409 while a worker holds the run, 403 for a file the open gate does not list), an editor page with the gate's own renderer as live preview, and a `file` message on the SSE channel that makes the gate's pane refetch. One file on disk, one version anywhere (Ryan's ruling of 2026-10-27). The engine is unchanged: the hand-edits guards already treat an edited artifact as the showrunner's.
```

- [x] **Step 6: Commit.**

```bash
git add console/src/pages/Gate.tsx console/test/client/gate-page.test.tsx docs/specs/2026-09-25-console-rewrite-design.md
git commit -m "console: the gate's edit link, and a pane that follows the save

Every markdown artifact pane on the gate carries an edit link to the editor page when the
console can act on the show. A file message naming the pane's path makes it refetch, so the
gate shows what the editor saved without a reload. The spec's change log records the editor.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
