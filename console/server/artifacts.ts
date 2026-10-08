import path from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readdir, stat } from "node:fs/promises";
import { EventLog, parseEpisodeId } from "@showrunner/engine";
import type { Context } from "hono";
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
