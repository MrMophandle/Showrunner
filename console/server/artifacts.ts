import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { EventLog, parseEpisodeId } from "@showrunner/engine";
import type { Context } from "hono";
import { gateView, guestRefsDirOf } from "./gates.js";
import type { RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";

/** The artifact route's fence and its reader. The console serves the episode's own files — the
 *  outline a gate is asking about, the mix, the shot images, the render, the canon patch — and
 *  nothing else on the machine it is running on.
 *
 *  Three layers refuse a path, and each one catches requests the other two let through:
 *
 *  1. **the prefix rule** — the path must begin with `<episodesDir>/<id>/` or
 *     `<productionDir>/<id>/`. This is not about escape: `Canon/world-overview.md` and
 *     `Episodes/<other episode>/script.md` are both real files inside the show root with no `..`
 *     and no dotfile in them, and only this rule says they are not this episode's business.
 *  2. **the segment rule** — no empty segment, no `..`, no dotfile, no control character. A
 *     request written `Episodes/s02e01%2F%2E%2E%2Fs02e02/x.md` arrives decoded as
 *     `Episodes/s02e01/../s02e02/x.md`: its prefix is this episode's, and it resolves to a path
 *     inside the show root, so layers 1 and 3 both pass it. Only this rule sees it.
 *  3. **the resolved-path check** (`safeResolve`, ported from console v1) — after `path.resolve`,
 *     the path must still be inside the show root. This is the layer that does not depend on the
 *     string rules above being complete: a show whose `episodesDir` is configured as
 *     `../shared/Episodes` satisfies the prefix rule by construction and lands outside the root,
 *     and a segment carrying a separator the scan does not split on resolves somewhere the scan
 *     never modelled. */

/** The content type for a filename, by extension. Chosen from the extension rather than sniffed
 *  from the bytes because the route serves whatever the pipeline wrote and a sniffer that guessed
 *  wrong on a WAV would hand the operator a download instead of a player. */
export function contentTypeFor(name: string): string {
  switch (path.posix.extname(name).toLowerCase()) {
    case ".md": return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".patch": case ".diff": return "text/plain; charset=utf-8";
    case ".txt": case ".srt": return "text/plain; charset=utf-8";
    case ".jsonl": return "application/x-ndjson";
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".mp4": return "video/mp4";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

/** Resolves a path inside `base`, or null when `segments` would resolve outside it — or when
 *  `base` itself does not stay within the show root, which a misconfigured `episodesDir` would
 *  cause. Ported from console v1 (`console/server/index.ts`'s `safeResolve`). */
function safeResolve(base: string, ...segments: string[]): string | null {
  const p = path.resolve(base, ...segments);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

/** A path the route may serve, or the message to answer 400 with. Exported so the fence can be
 *  tested on strings a URL cannot carry: the WHATWG URL parser normalises a literal `..` segment
 *  away before any server sees it, so the segment rule's real subject is a decoded parameter and a
 *  caller inside the server, not a hand-written url. */
export function resolveArtifactPath(
  ctx: ShowContext, episodeId: string, showRelative: string,
): { ok: true; rel: string; abs: string } | { ok: false; error: string } {
  parseEpisodeId(episodeId);
  const prefixes = [`${ctx.episodesDir}/${episodeId}/`, `${ctx.productionDir}/${episodeId}/`];
  const rel = showRelative;
  const named = JSON.stringify(rel);
  if (!prefixes.some((p) => rel.startsWith(p))) {
    return { ok: false, error: `path ${named} must begin with ${prefixes[0]} or ${prefixes[1]}` };
  }
  const segments = rel.split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, error: `path ${named} has an empty segment` };
    if (segment === "..") return { ok: false, error: `path ${named} has a "..", which the artifact route never follows` };
    if (segment.startsWith(".")) return { ok: false, error: `path ${named} names a dotfile (${JSON.stringify(segment)}), which the artifact route never serves` };
    // A NUL or any other control character in a path is never a filename the pipeline wrote, and
    // `fs` throws on it rather than returning an error — a 500 where a 400 belongs.
    if (/[\u0000-\u001f\u007f]/.test(segment)) return { ok: false, error: `path ${named} has a control character in a segment` };
  }
  // No check for "the prefix and nothing else" is needed, and one would be unreachable: the prefix
  // ends in a separator, so `Episodes/<id>` without it fails the prefix rule and `Episodes/<id>/`
  // ends in an empty segment. The episode's own directory is therefore never listed — the two
  // directories a gate points at (`images/`, `guest-refs/`) are a level further down.
  const abs = safeResolve(ctx.showRoot, rel);
  if (abs === null) return { ok: false, error: `path ${named} resolves outside the show root` };
  return { ok: true, rel, abs };
}

/** What a `Range` header came to: serve the whole file, serve one span, or refuse. */
type RangeResult =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** Parses a single `Range: bytes=a-b` header against a known total length. Ported from console v1
 *  (`parseRange`), and pure for the same reason it was there: the arithmetic is the part that is
 *  easy to get subtly wrong, and it can be exercised without a filesystem.
 *
 *  No header, an unparseable one, or one in a unit this server does not recognise is "full" — RFC
 *  7233 §3.1 requires a server to **ignore** a Range it does not understand and serve the whole
 *  representation with 200. That is not the same case as a well-formed range that is out of
 *  bounds, and conflating the two sends a hard 416 for something as harmless as a stray header,
 *  which silently breaks playback for a client or proxy that sends an unusual one. Handled:
 *  a closed range ("0-4"), an open-ended one ("500-", to EOF), a suffix one ("-500", the last 500
 *  bytes; "-0" is well-formed syntax asking for zero bytes, so it is unsatisfiable rather than
 *  ignorable), and a numeric start at or past EOF, which is unsatisfiable. */
export function parseRange(header: string | undefined, total: number): RangeResult {
  if (header === undefined || header === "") return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffixLength = Number(m[2]);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", start, end };
}

/** The headers a download carries, with the filename quoted. */
function disposition(name: string): string {
  return `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
}

/** Serves one file with HTTP Range: no usable `Range` header gives 200 and the whole file, a
 *  satisfiable one gives 206 and exactly that span, and a well-formed out-of-bounds one gives 416
 *  with `Content-Range: bytes * / <total>`. Ported from console v1's `serveMediaRange`, with the
 *  content type taken from the extension rather than passed per route, because this one route
 *  serves markdown, JSON, patches, WAVs, MP4s and PNGs.
 *
 *  A range matters for more than politeness here: the final gate's artifact is a rendered episode
 *  of several hundred megabytes, and a browser that cannot seek it has to download all of it
 *  before the showrunner can look at minute nine. */
async function serveFile(c: Context, absolute: string, size: number, name: string, download: boolean): Promise<Response> {
  const type = contentTypeFor(name);
  const range = parseRange(c.req.header("range"), size);
  if (range.kind === "unsatisfiable") {
    return c.body(null, 416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
  }
  if (range.kind === "full") {
    const body = Readable.toWeb(createReadStream(absolute)) as unknown as ReadableStream;
    return c.body(body, 200, {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      ...(download ? { "Content-Disposition": disposition(name) } : {}),
    });
  }
  const { start, end } = range;
  const body = Readable.toWeb(createReadStream(absolute, { start, end })) as unknown as ReadableStream;
  return c.body(body, 206, {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    ...(download ? { "Content-Disposition": disposition(name) } : {}),
  });
}

/** One entry of a directory listing: enough for the client to draw a gallery or a file list and
 *  to know which entries it can descend into. */
export interface DirEntry { name: string; size: number; isDir: boolean }

/** `GET /api/shows/:show/episodes/:id/files/*`: one file with Range, or one directory as a JSON
 *  listing.
 *
 *  A directory is answered rather than refused because three of the eight gates are about a
 *  directory and not a file — the shot images, the guest voice references — and the client cannot
 *  name their contents without being told what is in them. The listing is one level deep and
 *  hides the same dotfiles the fence refuses, so a name the listing offers is always a name the
 *  route will then serve. */
export async function serveArtifact(c: Context, ctx: ShowContext, episodeId: string, showRelative: string): Promise<Response> {
  const fenced = resolveArtifactPath(ctx, episodeId, showRelative);
  if (!fenced.ok) return c.json({ error: fenced.error }, 400);
  let info: Awaited<ReturnType<typeof stat>>;
  try { info = await stat(fenced.abs); } catch { return c.json({ error: `no such artifact: ${showRelative}` }, 404); }
  if (info.isDirectory()) {
    const names = (await readdir(fenced.abs)).filter((n) => !n.startsWith(".")).sort();
    const entries: DirEntry[] = [];
    for (const name of names) {
      try {
        const child = await stat(path.join(fenced.abs, name));
        entries.push({ name, size: child.size, isDir: child.isDirectory() });
      } catch { /* an entry that vanished between the readdir and the stat is not in the listing */ }
    }
    return c.json({ entries });
  }
  if (!info.isFile()) return c.json({ error: `not a file or a directory: ${showRelative}` }, 400);
  return serveFile(c, fenced.abs, info.size, path.posix.basename(showRelative), false);
}

/** `GET /api/shows/:show/episodes/:id/runs/:run/log`: the run's raw JSONL as a download.
 *
 *  Served from outside the artifact fence on purpose. The log lives at
 *  `<productionDir>/<id>/runs/<runId>.jsonl`, which the fence would allow, but routing it through
 *  `EventLog.logPath` means the run id is validated by the engine and the log's address is built
 *  in exactly one place — the same call the store and the worker use. The operator gets the file
 *  the engine wrote, byte for byte, which is what makes it attachable to a bug report. */
export async function serveRunLog(c: Context, ctx: ShowContext, episodeId: string, runId: string): Promise<Response> {
  const file = EventLog.logPath(ctx.showRoot, episodeId, runId, ctx.productionDir);
  let info: Awaited<ReturnType<typeof stat>>;
  try { info = await stat(file); } catch { return c.json({ error: `no log for run ${runId} of ${episodeId}` }, 404); }
  if (!info.isFile()) return c.json({ error: `no log for run ${runId} of ${episodeId}` }, 404);
  return serveFile(c, file, info.size, `${runId}.jsonl`, true);
}

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
 *  half-written artifact and a crash leaves the old text in place. The rename is what makes the
 *  write atomic; the temp file is removed again when either step throws, so a leftover is the
 *  crash case and not the ordinary one.
 *
 *  **The temp name is unique per write, not per process**, because this function is async and the
 *  console serves one artifact to more than one request: every `await` yields the event loop, so
 *  two saves of the same file interleave at the write and the rename. Sharing one name let the
 *  second call's bytes land on the artifact under the first call's rename — the first caller then
 *  hashing and publishing a file it did not write — and let the second rename find nothing there
 *  at all. The uuid makes each call's staging file its own, so neither write can reach the other's,
 *  and the catch below removes only the file this call created.
 *
 *  The temp name does **not** start with a dot. The editor route refuses a leftover —
 *  `script.md.tmp-4242-<uuid>` — by the "not markdown" rule, a 400, because the name does not end
 *  in `.md`; it never reaches the comparison against the gate's artifact list. The episode's
 *  artifact route (`serveArtifact`) does serve a leftover asked for by its exact name, since
 *  `resolveArtifactPath` refuses only a segment that *starts* with a dot, and that is the intent:
 *  a leftover should be visible in a listing and readable by the operator who finds it, rather
 *  than hidden as a dotfile the listing filters out. */
export async function writeAtomically(abs: string, text: string): Promise<number> {
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return Buffer.byteLength(text, "utf8");
}

/** One episode's TTS manifest, show-relative: the file a casting pick changes. */
function manifestRelOf(ctx: ShowContext, episodeId: string): string {
  return `${ctx.productionDir}/${episodeId}/tts-script.json`;
}

/** The manifest as `json.dump(doc, f, indent=1)` writes it, which is how every other writer of
 *  this file writes it (`scripts/pace-qc.py:89`, `scripts/truncation-qc.py:180`).
 *
 *  Three properties have to match, and `JSON.stringify` gives only one of them by itself:
 *
 *  1. **One space of indent**, which `JSON.stringify(doc, null, 1)` is.
 *  2. **Every character above U+007F written as a `\uXXXX` escape**, lowercase and four digits,
 *     which is `json.dump`'s default (`ensure_ascii=True`). A JS string is a sequence of UTF-16
 *     code units, so a character outside the BMP is already two units — an emoji is its surrogate
 *     pair — and escaping each unit is exactly what Python emits for it, since JSON has no other
 *     escape form. `JSON.stringify` writes such characters as themselves. **The match is per code
 *     unit, which is why the pattern carries no `u` flag**: under `u` a surrogate pair is one code
 *     point above U+FFFF, outside the class, and an emoji would be left as itself.
 *  3. **No trailing newline**, which `json.dump` does not write and `writeFile` does not add.
 *
 *  The reason is the diff and nothing else: a manifest's `ref_text` is the line the voice read, so
 *  it carries em dashes and curly quotes on nearly every entry. A console that wrote those bytes as
 *  themselves, or added a newline, would turn the one-line change a pick makes into a whole-file
 *  diff the next time either Python step rewrote the file — and the diff of a casting change is the
 *  one place a reader can see which take was chosen. */
function asPythonJson(doc: unknown): string {
  return JSON.stringify(doc, null, 1).replace(
    /[\u0080-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Writes the casting gate's picks into the manifest: `cast[<guest>].ref = <take>`.
 *
 *  Every pick is checked before anything is written — the name must be a guest in the manifest,
 *  the take must lie inside the episode's guest-reference directory (`guestRefsDirOf`, which
 *  reads the show's `audio.guestRefsDir`), be audio, pass the artifact fence, and be a file that
 *  `stat` can see — so one bad pick refuses the whole answer and the manifest on disk is
 *  untouched. Half a casting is a cast list nobody chose, and a 400 naming one bad take says
 *  nothing about which of the others landed; all-or-nothing makes the refusal mean "nothing
 *  happened, fix it and answer again".
 *
 *  **Existence is `stat().isFile()` and not a hash of the bytes.** The engine's `hashFile` returns
 *  null for a missing file and throws for every other failure, so a directory named `pim-3.wav`
 *  raised EISDIR out of this function and into `app.onError` — a 500 carrying a stack-trace
 *  fragment where a 400 and a sentence belong. A path `stat` refuses (a parent the console may not
 *  traverse, a dangling symlink) and a path that is not a regular file are both a plain refusal
 *  here. Nothing is read: the console is choosing a reference for the pipeline to read, and the
 *  bytes are `tts-generate`'s business.
 *
 *  **The manifest's own path goes through the fence too** (`resolveArtifactPath`), like every other
 *  path this module touches, so the one function that knows which trees the console may read and
 *  write is consulted for the file a pick rewrites and not only for the take it names.
 *
 *  **An unchanged casting writes nothing** (`wrote: false`). An approve that confirms what the
 *  manifest already says is a decision to leave the file alone: `tts-generate` is cached on the
 *  content hash and would not re-run either way, but the file the operator reads would have been
 *  reformatted and its mtime moved for a change that was not made.
 *
 *  The write is atomic (`writeAtomically`), so `tts-generate` never reads a half-written manifest,
 *  and its text is `asPythonJson`'s — `json.dump(doc, f, indent=1)`'s own bytes, for the reasons
 *  given there. `before` is the text as this call found it, which is what the answer route writes
 *  back when `answerGate` then refuses the answer because the gate is no longer open
 *  (`server/app.ts`).
 *
 *  **Nothing is recorded in the run log for a pick.** The engine learns of the change the way it
 *  learns of any edit to a declared input: `tts-generate` declares `tts-script.json` as its input
 *  (`engine/src/pipelines/episode.ts:325`), and `runScriptStep` compares the fresh input hashes
 *  with the last completion's (`engine/src/runner.ts:429-442`), so a picked manifest is not
 *  served from `step_cached` and emits `input_changed` instead. The hash trail is the record; a
 *  console-minted event would be a second claim about the same fact, able to disagree with the
 *  file on disk. */
export async function applyCastingPicks(
  ctx: ShowContext, episodeId: string, picks: Record<string, string>,
): Promise<
  | { ok: true; applied: Record<string, string>; wrote: boolean; before: string }
  | { ok: false; error: string }
> {
  const manifestRel = manifestRelOf(ctx, episodeId);
  const manifest = resolveArtifactPath(ctx, episodeId, manifestRel);
  if (!manifest.ok) return { ok: false, error: manifest.error };
  let before: string;
  let parsed: unknown;
  try {
    before = await readFile(manifest.abs, "utf8");
    parsed = JSON.parse(before);
  } catch (err) {
    return { ok: false, error: `${manifestRel} could not be read: ${(err as Error).message}` };
  }
  // Refused rather than coerced, because this object is what gets written back: a manifest that
  // parsed to `null` or to an array would otherwise reach `JSON.stringify` and replace the file.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${manifestRel} is not a JSON object, so it has no cast to pick from` };
  }
  const doc = parsed as { cast?: Record<string, { ref?: unknown; guest?: unknown }> };
  const cast = doc.cast ?? {};
  const refsPrefix = `${guestRefsDirOf(ctx.show, episodeId)}/`;
  const applied: Record<string, string> = {};
  for (const [name, take] of Object.entries(picks)) {
    const entry = cast[name];
    if (entry === undefined || entry.guest !== true) return { ok: false, error: `${JSON.stringify(name)} is not a guest in ${manifestRel}` };
    if (typeof take !== "string" || !take.startsWith(refsPrefix)) return { ok: false, error: `the take for ${name} must be a file under ${refsPrefix}` };
    if (!/\.(wav|mp3|flac|m4a|ogg|aac)$/i.test(take)) return { ok: false, error: `the take for ${name} is not an audio file: ${take}` };
    const fenced = resolveArtifactPath(ctx, episodeId, take);
    if (!fenced.ok) return { ok: false, error: fenced.error };
    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(fenced.abs); } catch { return { ok: false, error: `the take for ${name} does not exist: ${take}` }; }
    if (!info.isFile()) return { ok: false, error: `the take for ${name} is not a file: ${take}` };
    applied[name] = take;
  }
  if (Object.entries(applied).every(([name, take]) => cast[name]?.ref === take)) {
    return { ok: true, applied, wrote: false, before };
  }
  for (const [name, take] of Object.entries(applied)) (cast[name] as { ref: string }).ref = take;
  await writeAtomically(manifest.abs, asPythonJson(doc));
  return { ok: true, applied, wrote: true, before };
}

/** Puts the episode's manifest back to the text `applyCastingPicks` found there, and says whether
 *  it managed to. Called on the one path where a written pick has to be taken back: the gate was
 *  answered by somebody else while this answer was being written, so the picks are an edit to a
 *  casting that is already settled and nothing downstream will ever read this answer
 *  (`server/app.ts`'s gate answer handler).
 *
 *  A boolean rather than a throw because the caller is already answering 409: a failed restore
 *  must change the sentence that 409 carries, not replace it with a 500 that loses the refusal. */
export async function restoreCastingManifest(ctx: ShowContext, episodeId: string, before: string): Promise<boolean> {
  const manifest = resolveArtifactPath(ctx, episodeId, manifestRelOf(ctx, episodeId));
  if (!manifest.ok) return false;
  try { await writeAtomically(manifest.abs, before); return true; } catch { return false; }
}
