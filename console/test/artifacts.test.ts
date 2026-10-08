import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRange, resolveArtifactPath } from "../server/artifacts.js";
import { appWith, makeShow, seedRun, writeIn } from "./helpers.js";

/** The artifact route and its fence. Three layers refuse a path, and each of these tests names
 *  which one does the refusing, because they catch different requests: the prefix rule refuses a
 *  file that is not this episode's, the segment rule refuses a traversal or a dotfile, and
 *  `safeResolve` refuses anything that lands outside the show root after resolution. */
const FILES = "/api/shows/show/episodes/s02e01/files";

/** A thousand bytes whose every byte is its own index mod 251, so a Range response can be
 *  checked against the offsets it claims rather than only against its length. */
function bytes(n: number): Buffer {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = i % 251;
  return buf;
}

describe("the artifact route", () => {
  it("serves a markdown file under the episode's Episodes/ directory", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e01/outline.md", "# A week on the water\n");
    const res = await app.request(`${FILES}/Episodes/s02e01/outline.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("# A week on the water\n");
    store.close();
  });

  it("lists a directory as JSON", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await writeIn(root, "Production/s02e01/images/prompts.json", "{}");
    await writeIn(root, "Production/s02e01/images/shot-01.png", "png");
    await mkdir(path.join(root, "Production", "s02e01", "images", "work"), { recursive: true });
    const res = await app.request(`${FILES}/Production/s02e01/images`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as { entries: Array<{ name: string; size: number; isDir: boolean }> };
    expect(body.entries.map((e) => e.name)).toEqual(["prompts.json", "shot-01.png", "work"]);
    expect(body.entries.find((e) => e.name === "work")?.isDir).toBe(true);
    expect(body.entries.find((e) => e.name === "shot-01.png")?.size).toBe(3);
    store.close();
  });

  it("refuses a path outside the episode's two trees — the prefix rule", async () => {
    const { app, store } = await appWith(await makeShow());
    const res = await app.request(`${FILES}/Canon/world-overview.md`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("must begin with") });
    // Another episode's file, through this episode's route, is the same refusal.
    expect((await app.request(`${FILES}/Episodes/s02e02/script.md`)).status).toBe(400);
    store.close();
  });

  it("refuses a traversal, whichever layer catches it", async () => {
    const { app, store } = await appWith(await makeShow());
    // Written plainly, the URL parser normalises the dot segment away before the server sees it,
    // and what arrives is `Episodes/s02e02/x.md` — refused by the prefix rule.
    const plain = await app.request(`${FILES}/Episodes/s02e01/../s02e02/x.md`);
    expect(plain.status).toBe(400);
    expect(await plain.json()).toMatchObject({ error: expect.stringContaining("must begin with") });
    // With the separators percent-encoded, the dot segment survives the URL parser and arrives
    // decoded as `Episodes/s02e01/../s02e02/x.md`, prefix intact — only the segment rule sees it.
    const encoded = await app.request(`${FILES}/Episodes/s02e01%2F%2E%2E%2Fs02e02/x.md`);
    expect(encoded.status).toBe(400);
    expect(await encoded.json()).toMatchObject({ error: expect.stringContaining("\"..\"") });
    store.close();
  });

  it("refuses a dotfile", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e01/.secret", "not yours\n");
    const res = await app.request(`${FILES}/Episodes/s02e01/.secret`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("dotfile") });
    store.close();
  });

  it("answers a byte range with 206 and exactly those bytes", async () => {
    const { root, app, store } = await appWith(await makeShow());
    const file = path.join(root, "Production", "s02e01", "video", "episode.mp4");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes(1000));

    const res = await app.request(`${FILES}/Production/s02e01/video/episode.mp4`, { headers: { Range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.equals(bytes(1000).subarray(100, 200))).toBe(true);

    const whole = await app.request(`${FILES}/Production/s02e01/video/episode.mp4`);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).length).toBe(1000);

    // RFC 7233 §3.1: a Range header in a unit the server does not understand is ignored, not
    // rejected — a 416 here would break playback for a client that sent an unusual one.
    const odd = await app.request(`${FILES}/Production/s02e01/video/episode.mp4`, { headers: { Range: "items=0-1" } });
    expect(odd.status).toBe(200);
    store.close();
  });

  it("answers an unsatisfiable range with 416", async () => {
    const { root, app, store } = await appWith(await makeShow());
    const file = path.join(root, "Production", "s02e01", "video", "episode.mp4");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes(1000));
    const res = await app.request(`${FILES}/Production/s02e01/video/episode.mp4`, { headers: { Range: "bytes=2000-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
    store.close();
  });

  it("404s a file that is inside the fence and not on disk", async () => {
    const { app, store } = await appWith(await makeShow());
    expect((await app.request(`${FILES}/Episodes/s02e01/nothing-here.md`)).status).toBe(404);
    store.close();
  });

  it("serves a run's log as a download", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_completed", payload: { result: "ok" } },
    ]);
    const res = await app.request("/api/shows/show/episodes/s02e01/runs/r1/log");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("r1.jsonl");
    const lines = (await res.text()).trim().split("\n");
    expect(lines.length).toBe(2);
    expect((JSON.parse(lines[0]!) as { kind: string }).kind).toBe("run_started");
    expect((await app.request("/api/shows/show/episodes/s02e01/runs/nosuchrun/log")).status).toBe(404);
    store.close();
  });
});

describe("the fence, called directly", () => {
  it("refuses the shapes a url cannot always deliver", async () => {
    const { ctx, store } = await appWith(await makeShow());
    const no = (rel: string): string => {
      const r = resolveArtifactPath(ctx, "s02e01", rel);
      expect(r.ok, `expected ${JSON.stringify(rel)} to be refused`).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(no("Episodes/s02e01/../s02e02/x.md")).toContain("\"..\"");
    expect(no("Episodes/s02e01//x.md")).toContain("empty segment");
    expect(no("Episodes/s02e01/./x.md")).toContain("dotfile");
    expect(no("Episodes/s02e01/x\u0001.md")).toContain("control character");
    // The episode's own directory, with or without a trailing separator: the prefix ends in a
    // separator, so the bare name fails the prefix rule and the trailing one ends in an empty
    // segment. Neither is ever listed.
    expect(no("Episodes/s02e01")).toContain("must begin with");
    expect(no("Episodes/s02e01/")).toContain("empty segment");
    expect(no("")).toContain("must begin with");
    const yes = resolveArtifactPath(ctx, "s02e01", "Production/s02e01/images/shot-01.png");
    expect(yes.ok).toBe(true);
    expect(yes.ok && yes.abs).toBe(path.join(ctx.showRoot, "Production/s02e01/images/shot-01.png"));
    store.close();
  });
});

/** `parseRange`, directly: the arithmetic is the part that is easy to get subtly wrong, and it is
 *  pure, so the named edge cases need no filesystem behind them. RFC 7233 §3.1's distinction is
 *  the one being asserted — a header this server does not understand is **ignored** and the whole
 *  representation is served, which is not the same answer as a well-formed range it cannot
 *  satisfy. */
describe("parseRange", () => {
  it("reads a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
    // A suffix longer than the file is the whole file, not a negative start.
    expect(parseRange("bytes=-5000", 1000)).toEqual({ kind: "range", start: 0, end: 999 });
  });

  it("reads a single-byte range, and the first byte of a file", () => {
    expect(parseRange("bytes=0-0", 1000)).toEqual({ kind: "range", start: 0, end: 0 });
    expect(parseRange("bytes=999-", 1000)).toEqual({ kind: "range", start: 999, end: 999 });
  });

  it("calls a zero-length suffix unsatisfiable rather than ignorable", () => {
    // "bytes=-0" is well-formed syntax asking for zero bytes: there is no span to answer with, so
    // it is a 416 and not a 200 with the whole file.
    expect(parseRange("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores a multi-range header and anything it does not understand", () => {
    // This server serves one span per response, so a multi-range request is a header it does not
    // understand: RFC 7233 §3.1 requires it to be ignored and the whole file served.
    expect(parseRange("bytes=0-99,200-299", 1000)).toEqual({ kind: "full" });
    expect(parseRange("items=0-99", 1000)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-", 1000)).toEqual({ kind: "full" });
    expect(parseRange("nonsense", 1000)).toEqual({ kind: "full" });
    expect(parseRange(undefined, 1000)).toEqual({ kind: "full" });
    expect(parseRange("", 1000)).toEqual({ kind: "full" });
  });
});
