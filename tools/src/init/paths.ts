import path from "node:path";
import { fileURLToPath } from "node:url";

/** The engine's template root, `tools/templates/`, resolved from this file's own location so the
 *  path is right from `src/init/` under vitest and from `dist/init/` under the built CLI — both
 *  two directories below the workspace root. */
export function templatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}
