import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

export async function hashFile(absPath: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return hash.digest("hex");
}

export async function hashFiles(showRoot: string, relPaths: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const rel of relPaths) {
    out[rel] = await hashFile(path.join(showRoot, rel));
  }
  return out;
}

export function sameHashes(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k === undefined || k !== kb[i]) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}
