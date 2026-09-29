import path from "node:path";
import { hashFile } from "./hash.js";
import type { RunContext } from "./steps.js";

export interface HandEdit { file: string; recordedBy: string; recordedHash: string | null; currentHash: string | null }

/** Spec §2.3: a hand edit is any file whose current content differs from the hash the engine
 *  recorded when a step last wrote it. The record is the `outputHashes` of the most recent
 *  step_completed that lists the file — an agent step, a loop, or a gate's fix agent — and the
 *  comparison is made here, outside the agent, because an agent step cannot reach the log. A
 *  file no step has recorded is not reported: there is nothing to compare, and such a file (the
 *  premise, `locked-beats.md`) is the showrunner's by definition. */
export async function handEdits(ctx: RunContext, files: string[]): Promise<HandEdit[]> {
  const events = ctx.events ?? [];
  const out: HandEdit[] = [];
  for (const file of files) {
    let recordedBy: string | undefined;
    let recordedHash: string | null | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.kind !== "step_completed" || e.stepId === undefined) continue;
      const hashes = e.payload["outputHashes"];
      if (typeof hashes !== "object" || hashes === null || !Object.prototype.hasOwnProperty.call(hashes, file)) continue;
      recordedBy = e.stepId;
      recordedHash = (hashes as Record<string, string | null>)[file] ?? null;
      break;
    }
    if (recordedBy === undefined || recordedHash === undefined) continue;
    const currentHash = await hashFile(path.join(ctx.showRoot, file));
    if (currentHash !== recordedHash) out.push({ file, recordedBy, recordedHash, currentHash });
  }
  return out;
}
