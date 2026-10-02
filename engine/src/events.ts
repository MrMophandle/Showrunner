import { appendFile, mkdir, open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { parseEpisodeId } from "./ids.js";
import { RUN_ID } from "./runs.js";
import type { EventKind } from "./steps.js";

export type { EventKind };

export interface Event {
  ts: string;
  runId: string;
  stepId?: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export class EventLog {
  constructor(readonly path: string) {}

  /** Both ids are validated here because this is where they become a filesystem path: an
   *  unchecked `..` segment in either one would put a run's log outside the episode. The
   *  production directory is the show's (`show.productionDir`), defaulting to the name this
   *  show uses; every other episode path is built from the same key. */
  static logPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production"): string {
    parseEpisodeId(episodeId);
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}: expected [A-Za-z0-9_-]+`);
    return path.join(showRoot, productionDir, episodeId, "runs", `${runId}.jsonl`);
  }

  async append(e: Omit<Event, "ts">): Promise<Event> {
    // The stamp is applied last so a caller cannot supply its own: the log is the source of
    // truth for when things happened, and a replayed or hand-built event must not backdate it.
    const full: Event = { ...e, ts: new Date().toISOString() };
    await mkdir(path.dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async read(): Promise<Event[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Event[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as Event);
      } catch (err) {
        throw new Error(`event log ${this.path}: malformed JSON at line ${i + 1}`, { cause: err });
      }
    }
    return out;
  }

  /** The events appended since `offset` (a byte position), and the position to resume from. A
   *  reader outside the writing process — the console's tail — calls this on every change
   *  notification rather than re-reading a file that grows by thousands of lines per run. Only
   *  complete lines are parsed: a line still being written is left for the next call, so the
   *  returned offset is the start of that partial line, never past it. */
  async readFrom(offset: number): Promise<{ events: Event[]; offset: number }> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], offset: 0 };
      throw err;
    }
    try {
      const size = (await handle.stat()).size;
      // A log that is shorter than the offset was truncated or replaced under the reader, so the
      // offset is clamped back to the file rather than left pointing past its end.
      if (size <= offset) return { events: [], offset: Math.min(offset, size) };
      const buf = Buffer.alloc(size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return { events: [], offset };
      const complete = text.slice(0, lastNewline);
      const events: Event[] = [];
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        try { events.push(JSON.parse(line) as Event); }
        catch (err) { throw new Error(`event log ${this.path}: malformed JSON after byte ${offset}`, { cause: err }); }
      }
      // Measured in bytes, not string length: the offset is a file position, and a non-ASCII
      // character in a payload is more bytes of UTF-8 than it is UTF-16 code units.
      return { events, offset: offset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8") };
    } finally {
      await handle.close();
    }
  }
}
