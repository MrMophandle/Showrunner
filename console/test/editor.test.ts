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

/** A JSON POST through the app under test. The app is taken structurally rather than as
 *  `Hono<ShowVars>` so both `appWith`'s app and `appWithShows`'s reach it; `request` is declared
 *  returning `Response | Promise<Response>` because that is Hono's own signature, and the `await`
 *  here is what makes every call site a `Promise<Response>`. */
const post = async (
  app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, url: string, body: unknown,
): Promise<Response> =>
  await app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
