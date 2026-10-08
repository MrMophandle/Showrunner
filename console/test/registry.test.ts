import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  SHOW_KEY, defaultRegistryPath, readRegistry, registerShow, singleShowRegistry, writeRegistry,
} from "../server/registry.js";
import { loadShows } from "../server/show.js";
import { ENGINE_ROOT, FAKE_WORKER, makeShow, writeIn } from "./helpers.js";

/** A temporary directory to put a registry file in. Never `~/.showrunner`: a test that wrote the
 *  operator's own registry would register a show on this machine and leave it there. */
async function registryDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "console-registry-"));
}

describe("SHOW_KEY", () => {
  it("accepts the keys a URL segment can carry and refuses the rest", () => {
    for (const good of ["a", "A1", "DeadLight2", "harbor-light", "harbor_light", "9lives", "x".repeat(64)]) {
      expect(SHOW_KEY.test(good), good).toBe(true);
    }
    // A leading hyphen or underscore would read as a flag; a dot opens `..`; a slash is a path
    // segment of its own; an empty key matches every map miss. Each one is refused before it
    // reaches a path or a process (spec §4.4).
    for (const bad of ["", "-a", "_a", "a.b", "..", "a/b", "a b", "x".repeat(65), "shöw"]) {
      expect(SHOW_KEY.test(bad), bad).toBe(false);
    }
  });
});

describe("defaultRegistryPath", () => {
  it("is shows.json under .showrunner in the operator's home directory", () => {
    const file = defaultRegistryPath();
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.endsWith(path.join(".showrunner", "shows.json"))).toBe(true);
  });
});

describe("readRegistry", () => {
  it("reads an absent file as an empty registry, so a console with no shows still starts", async () => {
    const dir = await registryDir();
    expect(await readRegistry(path.join(dir, "shows.json"))).toEqual({ shows: {} });
  });

  it("reads the shows and their readOnly flags", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await writeFile(file, JSON.stringify({
      shows: { live: { root: "/shows/live" }, retired: { root: "/shows/retired", readOnly: true } },
    }), "utf8");
    expect(await readRegistry(file)).toEqual({
      shows: { live: { root: "/shows/live" }, retired: { root: "/shows/retired", readOnly: true } },
    });
  });

  it("reads a file holding {} as an empty registry", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await writeFile(file, "{}", "utf8");
    expect(await readRegistry(file)).toEqual({ shows: {} });
  });

  it("refuses a malformed file by name, and says which key is wrong", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    const refuses = async (body: string, fragment: string) => {
      await writeFile(file, body, "utf8");
      await expect(readRegistry(file)).rejects.toThrow(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
      await expect(readRegistry(file)).rejects.toThrow(fragment);
    };
    await refuses("{ not json", "not valid JSON");
    await refuses("[]", 'expected an object with a "shows" key');
    await refuses('"a string"', 'expected an object with a "shows" key');
    await refuses('{"shows": []}', '"shows" must be an object of show keys');
    await refuses('{"shows": {"a.b": {"root": "/x"}}}', '"a.b" is not a show key');
    await refuses('{"shows": {"live": "/x"}}', "shows.live must be an object with a root");
    await refuses('{"shows": {"live": {}}}', "shows.live.root must be a non-empty path");
    await refuses('{"shows": {"live": {"root": ""}}}', "shows.live.root must be a non-empty path");
    await refuses('{"shows": {"live": {"root": 7}}}', "shows.live.root must be a non-empty path");
    await refuses('{"shows": {"live": {"root": "/x", "readOnly": "yes"}}}', "shows.live.readOnly must be true or false");
  });

  it("refuses a directory where the registry should be, rather than reading it as empty", async () => {
    const dir = await registryDir();
    await mkdir(path.join(dir, "shows.json"));
    await expect(readRegistry(path.join(dir, "shows.json"))).rejects.toThrow("could not be read");
  });
});

describe("writeRegistry", () => {
  it("writes the file, creating its directory, and leaves no temporary file behind", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "nested", "shows.json");
    await writeRegistry(file, { shows: { live: { root: "/shows/live" } } });
    expect(JSON.parse(await readFile(file, "utf8")) as unknown).toEqual({ shows: { live: { root: "/shows/live" } } });
    expect(await readdir(path.dirname(file))).toEqual(["shows.json"]);
  });

  it("writes the keys in sorted order and omits readOnly for a writable show", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await writeRegistry(file, {
      shows: { zulu: { root: "/z" }, alpha: { root: "/a", readOnly: true }, mike: { root: "/m", readOnly: false } },
    });
    const text = await readFile(file, "utf8");
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"mike"'));
    expect(text.indexOf('"mike"')).toBeLessThan(text.indexOf('"zulu"'));
    // A writable show carries no readOnly key at all, so the file reads as "these are read-only"
    // rather than as a column of booleans.
    expect(JSON.parse(text) as unknown).toEqual({
      shows: { alpha: { root: "/a", readOnly: true }, mike: { root: "/m" }, zulu: { root: "/z" } },
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("round-trips through readRegistry", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    const reg = { shows: { live: { root: "/shows/live" }, retired: { root: "/shows/retired", readOnly: true } } };
    await writeRegistry(file, reg);
    expect(await readRegistry(file)).toEqual(reg);
  });
});

describe("registerShow", () => {
  it("adds a show to a registry that does not exist yet", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await registerShow(file, "live", { root: "/shows/live" });
    expect(await readRegistry(file)).toEqual({ shows: { live: { root: path.resolve("/shows/live") } } });
  });

  it("keeps the shows already registered", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await registerShow(file, "live", { root: "/shows/live" });
    await registerShow(file, "retired", { root: "/shows/retired", readOnly: true });
    expect(Object.keys((await readRegistry(file)).shows)).toEqual(["live", "retired"]);
    expect((await readRegistry(file)).shows["retired"]?.readOnly).toBe(true);
  });

  it("refuses a key SHOW_KEY does not accept", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await expect(registerShow(file, "a.b", { root: "/x" })).rejects.toThrow('"a.b" is not a show key');
    await expect(registerShow(file, "", { root: "/x" })).rejects.toThrow("is not a show key");
    expect(await readRegistry(file)).toEqual({ shows: {} });
  });

  it("keeps both entries when two shows are registered at once", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    // Two creations in flight. Without the exclusive lock each read the file before the other
    // wrote and the second rename dropped the first entry, which leaves the worst shape available:
    // a show scaffolded on disk, live in the server's two maps, answering its routes, and absent
    // from the registry — so it disappears at the next restart with no message, and creating it
    // again refuses on a path that is already a show. The window is narrow inside one process and
    // real across two consoles sharing `~/.showrunner/shows.json`, which is what the registry is a
    // machine-wide file for.
    await Promise.all([
      registerShow(file, "live", { root: "/shows/live" }),
      registerShow(file, "retired", { root: "/shows/retired", readOnly: true }),
    ]);
    const reg = await readRegistry(file);
    expect(Object.keys(reg.shows)).toEqual(["live", "retired"]);
    expect(reg.shows["retired"]?.readOnly).toBe(true);
    // The lock is released whichever way the write went, so the next registration is not refused.
    await registerShow(file, "third", { root: "/shows/third" });
    expect(Object.keys((await readRegistry(file)).shows)).toEqual(["live", "retired", "third"]);
  });

  it("refuses with the lock's own path when another writer's lock is still there", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    // A lock left behind by a process that died mid-write. Waiting on it forever would hang the
    // route, so the refusal names the file and says what to do about it.
    await writeFile(`${file}.lock`, "", "utf8");
    await expect(registerShow(file, "live", { root: "/shows/live" })).rejects.toThrow(`${file}.lock`);
    await rm(`${file}.lock`, { force: true });
    await registerShow(file, "live", { root: "/shows/live" });
    expect(Object.keys((await readRegistry(file)).shows)).toEqual(["live"]);
  });

  it("refuses a duplicate key, naming where that key already points", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await registerShow(file, "live", { root: "/shows/live" });
    await expect(registerShow(file, "live", { root: "/shows/other" }))
      .rejects.toThrow(`live is already registered, at ${path.resolve("/shows/live")}`);
    expect((await readRegistry(file)).shows["live"]?.root).toBe(path.resolve("/shows/live"));
  });

  it("refuses a root already registered under another key, comparing resolved paths", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    const root = await makeShow();
    await registerShow(file, "live", { root });
    // The same repository written three ways: a trailing slash, a relative walk, and the path
    // itself. Two keys over one repository would be two RunStores and two watcher sets on the same
    // run logs, and a launch from each is the two-workers-on-one-episode failure.
    for (const spelling of [root, `${root}/`, path.join(root, "Episodes", "..")]) {
      await expect(registerShow(file, "second", { root: spelling }), spelling)
        .rejects.toThrow(`${root} is already registered as live`);
    }
    expect(Object.keys((await readRegistry(file)).shows)).toEqual(["live"]);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an entry with no root, with the message readRegistry uses", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await expect(registerShow(file, "live", { root: "" })).rejects.toThrow("root must be a non-empty path");
  });

  it("refuses to write into a registry file that is already malformed", async () => {
    const dir = await registryDir();
    const file = path.join(dir, "shows.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(registerShow(file, "live", { root: "/shows/live" })).rejects.toThrow("not valid JSON");
  });
});

describe("singleShowRegistry", () => {
  it("keys one writable show by the root's own directory name, and writes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "console-single-"));
    const root = path.join(dir, "HarborLight");
    await mkdir(root);
    expect(singleShowRegistry(root)).toEqual({ shows: { HarborLight: { root } } });
    // --show leaves no trace on the machine: the registry it means is a value, not a file.
    expect(await readdir(dir)).toEqual(["HarborLight"]);
  });

  it("resolves the root and strips a trailing slash before taking the basename", () => {
    const root = path.resolve("/shows/HarborLight");
    expect(singleShowRegistry(`${root}/`)).toEqual({ shows: { HarborLight: { root } } });
  });

  it("refuses a directory name that is not a show key, naming it and the remedy", () => {
    expect(() => singleShowRegistry(path.resolve("/shows/harbor light")))
      .toThrow(/"harbor light" is not a show key/);
    expect(() => singleShowRegistry(path.resolve("/shows/harbor light")))
      .toThrow(/--registry/);
  });
});

describe("loadShows", () => {
  const opts = { engineRoot: ENGINE_ROOT, operator: "console:test", workerCommand: [process.execPath, FAKE_WORKER] };

  it("builds one context per entry, carrying the key and the readOnly flag", async () => {
    const live = await makeShow();
    const retired = await makeShow();
    const { shows, skipped } = await loadShows({ shows: { live: { root: live }, retired: { root: retired, readOnly: true } } }, opts);
    expect([...shows.keys()]).toEqual(["live", "retired"]);
    expect(skipped).toEqual([]);
    expect(shows.get("live")).toMatchObject({ key: "live", readOnly: false, showRoot: live });
    expect(shows.get("retired")).toMatchObject({ key: "retired", readOnly: true, showRoot: retired });
    // Every context is loaded with the same operator and worker command, so a second show needs no
    // second set of flags.
    expect(shows.get("retired")?.operator).toBe("console:test");
    await rm(live, { recursive: true, force: true });
    await rm(retired, { recursive: true, force: true });
  });

  it("reports a root that will not load by key, returns it as skipped, and leaves the good shows reachable", async () => {
    const live = await makeShow();
    const empty = await mkdtemp(path.join(tmpdir(), "console-noconfig-"));
    const badKey = await makeShow();
    // A config that loads today and is refused at load after Task 1: one guest-references
    // directory shared by every episode.
    await writeIn(badKey, "showrunner.json", JSON.stringify({
      showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
      models: { medium: "m", large: "l", writer: "w" }, airMap: {},
      output: { nasRoot: path.join(badKey, "nas") },
      audio: { guestRefsDir: "Production/guest-refs" },
    }));
    const reported: string[] = [];
    const { shows, skipped } = await loadShows(
      { shows: { live: { root: live }, nothing: { root: empty }, guests: { root: badKey } } },
      { ...opts, report: (line) => reported.push(line) },
    );
    expect([...shows.keys()]).toEqual(["live"]);
    expect(reported).toHaveLength(2);
    expect(reported.join("\n")).toContain("nothing");
    expect(reported.join("\n")).toContain("guests");
    expect(reported.join("\n")).toContain("audio.guestRefsDir");
    // Returned as well as reported: the stderr line is the operator's at startup, and `skipped` is
    // what reaches the browser, so an entry the console refused is a row on the Shows page rather
    // than a show that silently is not there.
    expect(skipped.map((entry) => entry.key)).toEqual(["nothing", "guests"]);
    expect(skipped.map((entry) => entry.root)).toEqual([empty, badKey]);
    expect(skipped[0]?.reason).toContain("showrunner.json");
    expect(skipped[1]?.reason).toContain("audio.guestRefsDir");
    for (const dir of [live, empty, badKey]) await rm(dir, { recursive: true, force: true });
  });

  it("refuses a key SHOW_KEY does not accept rather than skipping it", async () => {
    const live = await makeShow();
    await expect(loadShows({ shows: { "a.b": { root: live } } }, opts)).rejects.toThrow('"a.b" is not a show key');
    await rm(live, { recursive: true, force: true });
  });

  it("returns an empty map and nothing skipped for an empty registry", async () => {
    expect(await loadShows({ shows: {} }, opts)).toEqual({ shows: new Map(), skipped: [] });
  });
});
