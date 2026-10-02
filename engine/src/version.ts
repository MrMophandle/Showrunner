/** The engine's version, recorded on every run_started beside the pipeline hash so a log says
 *  which engine wrote it. It lives in a module of its own, which imports nothing, because
 *  `runner.ts` reads it: taking it from the `index.ts` barrel would make runner.ts import index.ts
 *  while index.ts re-exports runner.ts, a cycle that drags the whole barrel into runner's
 *  evaluation. `index.ts` re-exports it, so the public name is unchanged. */
export const ENGINE_VERSION = "0.0.1";
