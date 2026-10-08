import { describe, expect, it } from "vitest";
import type { GateView, SseMessage } from "../../shared/types.js";
import { parseMessage, showHref, showPath } from "../../src/api.js";
import { appWith, appWithShows, makeShow, seedRun, writeIn } from "../helpers.js";
import { SHOW_KEY as CLIENT_SHOW_KEY } from "../../shared/show-key.js";
import { SHOW_KEY as SERVER_SHOW_KEY } from "../../server/registry.js";

/** The client's addresses, and the notices it reads off the one channel.
 *
 *  **The addresses are asserted against the running app and not against a literal this file also
 *  wrote**, which is the lesson of the defect this task's quiz found: `server/gates.ts` built every
 *  gate artifact url as `/api/episodes/<id>/files/…` after that route had moved under
 *  `/api/shows/:show/`, and every shape assertion in `test/gates.test.ts` still passed because the
 *  test and the code agreed with each other about a string the server no longer answered. A test
 *  that says "this is the path, and the app answers it" cannot be wrong in that way.
 *
 *  So each test below builds a path exactly as the page that fetches it builds it — `showPath(key,
 *  …)` with the same suffix — and then drives the real Hono app with it. The pure assertions that
 *  follow are about encoding and about the one thing no request can show: which notices the client
 *  drops. */

/** The paths the four pages build, in the order a page builds them. Kept as a function of the key
 *  and the ids so the suffixes read as the pages' own lines. */
function clientPaths(key: string, episodeId: string, runId: string): Record<string, string> {
  const run = showPath(key, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`);
  return {
    // `App.tsx`'s ShowShell: the show and the Board's rows.
    show: showPath(key),
    episodes: showPath(key, "/episodes"),
    // `Run.tsx`: the view, the feed from zero, the raw log.
    run,
    events: `${run}/events?after=0`,
    log: `${run}/log`,
    // `Gate.tsx` and `WhatHappened.tsx`.
    gate: `${run}/gate`,
    context: `${run}/context`,
  };
}

describe("the api paths the client builds, against the app that answers them", () => {
  it("names the show, its episodes, a run, its feed and its log at addresses this app answers", async () => {
    const { root, key, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
    ]);
    const paths = clientPaths(key, "s02e01", "r1");
    for (const name of ["show", "episodes", "run", "events", "log"] as const) {
      const res = await app.request(paths[name]!);
      expect(res.status, `${name} at ${paths[name]!}`).toBe(200);
    }
    store.close();
  });

  it("builds the run-file url the Run page shows a crashed worker's log at", async () => {
    // `Run.tsx`'s `runFileUrl`: the artifact route, with the production directory taken from the
    // show rather than assumed, and the whole of it built by the client.
    const { root, key, app, ctx, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [{ kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } }]);
    await writeIn(root, "Production/s02e01/runs/r1.worker.log", "the worker died: ENOENT\n");
    const url = showPath(key, `/episodes/${encodeURIComponent("s02e01")}/files/${encodeURIComponent(ctx.productionDir)}/${encodeURIComponent("s02e01")}/runs/${encodeURIComponent("r1.worker.log")}`);
    const res = await app.request(url);
    expect(res.status, url).toBe(200);
    expect(await res.text()).toBe("the worker died: ENOENT\n");
    store.close();
  });

  it("reaches the gate's view and the gate's own artifact url, which the server builds complete", async () => {
    const { root, key, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the outline." } },
    ]);
    await writeIn(root, "Episodes/s02e01/outline.md", "# The Missing Week\n");
    const paths = clientPaths(key, "s02e01", "r1");
    const res = await app.request(paths["gate"]!);
    expect(res.status).toBe(200);
    const view = await res.json() as GateView;
    // The Gate page fetches these verbatim and adds nothing, so they have to be addresses this
    // app answers rather than paths the client could repair.
    expect(view.artifacts.length).toBeGreaterThan(0);
    const artifact = await app.request(view.artifacts[0]!.url);
    expect(artifact.status, view.artifacts[0]!.url).toBe(200);
    store.close();
  });

  it("reaches the What-happened context and the troubleshooting log the page reads beside it", async () => {
    const { root, key, app, ctx, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_completed", payload: { result: "wrote it" } },
    ]);
    await writeIn(root, "Production/s02e01/runs/r1.troubleshooting.jsonl", `${JSON.stringify({ ts: "2026-10-07T10:00:00Z", by: "console:test", question: "why?", answer: "because" })}\n`);
    const paths = clientPaths(key, "s02e01", "r1");
    expect((await app.request(paths["context"]!)).status).toBe(200);
    const logUrl = showPath(key, `/episodes/${encodeURIComponent("s02e01")}/files/${encodeURIComponent(ctx.productionDir)}/${encodeURIComponent("s02e01")}/runs/${encodeURIComponent("r1.troubleshooting.jsonl")}`);
    expect((await app.request(logUrl)).status, logUrl).toBe(200);
    store.close();
  });

  it("posts a new episode and a gate answer to routes this app registers", async () => {
    const { root, key, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve the outline." } },
    ]);
    const post = (path: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    // `NewEpisode.tsx` writes one premise and nothing else.
    const created = await post(showPath(key, "/episodes"), { id: "s02e09", premise: "A tide that is late." });
    expect(created.status).toBe(200);
    // `Gate.tsx` answers the attempt it read. A wrong `expectedAttempt` is refused by the engine
    // with a 409 the page keys on — which is the proof that the address is routed and reached,
    // without this test spawning a worker.
    const stale = await post(showPath(key, `/episodes/s02e01/runs/r1/gate`), { stepId: "outline-gate", approved: true, notes: "", expectedAttempt: 99 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: expect.stringContaining("is open at attempt 1") });
    store.close();
  });

  it("asks a show this console does not hold and is told so by the server, not by a client guess", async () => {
    const { app, store } = await appWith(await makeShow());
    const res = await app.request(showPath("nosuchshow", "/episodes"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no such show" });
    store.close();
  });

  it("keeps two shows' addresses apart, which is the whole point of the prefix", async () => {
    const { app, shows, stores } = await appWithShows([
      { root: await makeShow(), key: "live" },
      { root: await makeShow(), key: "archive", readOnly: true },
    ]);
    expect([...shows.keys()]).toEqual(["archive", "live"]);
    for (const key of ["live", "archive"]) {
      const res = await app.request(showPath(key, "/episodes"));
      expect(res.status, key).toBe(200);
    }
    // A POST to the read-only show is refused by the show middleware, which is why the client
    // draws no button there.
    const refused = await app.request(showPath("archive", "/episodes"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "s02e09", premise: "no." }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "archive is read-only" });
    for (const store of stores.values()) store.close();
  });
});

describe("showPath and showHref", () => {
  it("prefix the api and the browser addresses of one show", () => {
    expect(showPath("HarborLight")).toBe("/api/shows/HarborLight");
    expect(showPath("HarborLight", "/episodes")).toBe("/api/shows/HarborLight/episodes");
    expect(showHref("HarborLight")).toBe("/shows/HarborLight");
    expect(showHref("HarborLight", "/episodes/s02e01/runs/r1")).toBe("/shows/HarborLight/episodes/s02e01/runs/r1");
  });

  it("encode the key and leave the suffix as its caller built it", () => {
    // A key the registry would refuse, which is exactly why the key is encoded here rather than
    // trusted: this client never builds a path out of a string it has not been handed.
    expect(showPath("a b")).toBe("/api/shows/a%20b");
    expect(showHref("a/b")).toBe("/shows/a%2Fb");
    // The suffix carries ids the caller has already encoded; it is not encoded twice.
    expect(showPath("k", "/episodes/s02e01/files/Episodes/s02e01/outline.md"))
      .toBe("/api/shows/k/episodes/s02e01/files/Episodes/s02e01/outline.md");
  });
});

describe("the show key's grammar", () => {
  it("is one regex for the form's label and the server's fence", () => {
    // `NewShow.tsx` warns "that is not a key" while a key is being typed, which is a label and not
    // a fence — the fence is the show middleware's, and `registerShow` and `loadShows` apply it
    // again. It had its own third copy of the pattern, which is the copy that drifts: a form that
    // accepts a key the server refuses, or warns about one it would have taken.
    expect(CLIENT_SHOW_KEY).toBe(SERVER_SHOW_KEY);
    expect(CLIENT_SHOW_KEY.source).toBe("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
    // The three refusals the grammar exists for, asked of the one regex both halves read.
    expect(CLIENT_SHOW_KEY.test("HarborLight")).toBe(true);
    expect(CLIENT_SHOW_KEY.test("a.b")).toBe(false);
    expect(CLIENT_SHOW_KEY.test("a/b")).toBe(false);
    expect(CLIENT_SHOW_KEY.test("-leading")).toBe(false);
    expect(CLIENT_SHOW_KEY.test("")).toBe(false);
  });
});

describe("parseMessage, the notices the client keeps and the ones it drops", () => {
  const line = (m: unknown) => JSON.stringify(m);

  it("reads a run notice, an episodes notice and a setup notice, each with its show", () => {
    expect(parseMessage(line({ type: "run", show: "live", episodeId: "s02e01", runId: "r1", offset: 42 })))
      .toEqual({ type: "run", show: "live", episodeId: "s02e01", runId: "r1", offset: 42 });
    expect(parseMessage(line({ type: "episodes", show: "live" }))).toEqual({ type: "episodes", show: "live" });
    // Nothing publishes a setup notice until Task 6's Bible view; the parser accepts it from the
    // start so the channel is never the reason that page does not work.
    expect(parseMessage(line({ type: "setup", show: "live", key: "world-overview", runId: "r2", offset: 7 })))
      .toEqual({ type: "setup", show: "live", key: "world-overview", runId: "r2", offset: 7 });
  });

  it("drops a notice that cannot say which show it is about", () => {
    // The failure this guards against is not cosmetic: one channel carries every registered
    // show's notices, two shows can each hold an s02e01, and a Board that took an unkeyed notice
    // would re-read its whole show on another show's heartbeat (ruling H-12).
    expect(parseMessage(line({ type: "run", episodeId: "s02e01", runId: "r1", offset: 1 }))).toBeUndefined();
    expect(parseMessage(line({ type: "run", show: 7, episodeId: "s02e01", runId: "r1", offset: 1 }))).toBeUndefined();
    expect(parseMessage(line({ type: "episodes" }))).toBeUndefined();
    expect(parseMessage(line({ type: "setup", show: "live", key: "world-overview", runId: "r2" }))).toBeUndefined();
  });

  it("reads a hello's whole shows list, and drops a hello with one unreadable entry", () => {
    const hello = parseMessage(line({
      type: "hello", operator: "console:test",
      shows: [{ key: "live", showName: "Harbor Light", readOnly: false }, { key: "archive", showName: "Harbor Light", readOnly: true }],
      failed: [],
    }));
    expect(hello).toEqual({
      type: "hello", operator: "console:test",
      shows: [{ key: "live", showName: "Harbor Light", readOnly: false }, { key: "archive", showName: "Harbor Light", readOnly: true }],
      failed: [],
    } satisfies SseMessage);
    expect(parseMessage(line({ type: "hello", operator: "console:test", shows: [], failed: [] })))
      .toEqual({ type: "hello", operator: "console:test", shows: [], failed: [] });
    // Whole and not filtered: a list with a hole in it would have the Shows page draw a console
    // that is missing a show.
    expect(parseMessage(line({ type: "hello", operator: "console:test", shows: [{ key: "live", showName: "Harbor Light" }], failed: [] }))).toBeUndefined();
    expect(parseMessage(line({ type: "hello", operator: "console:test", shows: "live", failed: [] }))).toBeUndefined();
    expect(parseMessage(line({ type: "hello", shows: [], failed: [] }))).toBeUndefined();
    // `failed` is required and is validated by the same rule: a show the console could not load is
    // the one entry the page most needs, so a malformed one drops the hello rather than being
    // quietly left out of it.
    expect(parseMessage(line({ type: "hello", operator: "console:test", shows: [] }))).toBeUndefined();
    expect(parseMessage(line({
      type: "hello", operator: "console:test", shows: [],
      failed: [{ key: "gone", root: "/tmp/gone", error: "showrunner.json could not be read" }],
    }))).toEqual({
      type: "hello", operator: "console:test", shows: [],
      failed: [{ key: "gone", root: "/tmp/gone", error: "showrunner.json could not be read" }],
    } satisfies SseMessage);
    expect(parseMessage(line({
      type: "hello", operator: "console:test", shows: [], failed: [{ key: "gone", root: "/tmp/gone" }],
    }))).toBeUndefined();
  });

  it("drops a line that is not json, not an object, or a type it does not know", () => {
    expect(parseMessage("not json")).toBeUndefined();
    expect(parseMessage("[1,2]")).toBeUndefined();
    expect(parseMessage(line({ type: "something-later", show: "live" }))).toBeUndefined();
    expect(parseMessage("")).toBeUndefined();
  });
});
