import { defineConfig } from "vitest/config";

/** The console's tests run in Node by default: almost every one of them drives the server, the
 *  worker or the run store against a temporary show on disk, and needs no DOM at all.
 *
 *  **The exception is `test/client/*.test.tsx`, which renders components into jsdom.** Those files
 *  declare their own environment with a `// @vitest-environment jsdom` pragma on their first line
 *  rather than this config switching on a directory, which is ruling H-10's "`environment` per
 *  file". The reason is cost and blast radius: jsdom is a DOM implementation built per test file,
 *  and paying for one in the fifteen files that drive a live Hono app would slow the suite for
 *  nothing. A per-file pragma also means the environment a test needs is stated in the test, where
 *  the next reader of it is looking, instead of in a glob three directories away.
 *
 *  The `.tsx` tests are listed as a second `include` entry rather than folded into a brace pattern
 *  so that this line reads as the two kinds of test this suite holds.
 *
 *  The three workspaces' vitest configs carry the same three keys, so a test moved between them
 *  runs under the same rules: `include`, `testTimeout: 20_000` and `environment: "node"`. This
 *  file had no `testTimeout` and so ran under vitest's 5-second default while the engine's and the
 *  tools' declared 20 — a difference no one chose, and the wrong way round for a suite made of
 *  tests that drive a live server. No test here needs more than 5 seconds today; the allowance is
 *  so that one which does fails for its own reason rather than on the clock. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 20_000,
    environment: "node",
  },
});
