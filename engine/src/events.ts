import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
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

  static logPath(showRoot: string, episodeId: string, runId: string): string {
    return path.join(showRoot, "Production", episodeId, "runs", `${runId}.jsonl`);
  }

  async append(e: Omit<Event, "ts">): Promise<Event> {
    const full: Event = { ts: new Date().toISOString(), ...e };
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
      } catch {
        throw new Error(`event log ${this.path}: malformed JSON at line ${i + 1}`);
      }
    }
    return out;
  }
}
