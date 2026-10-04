import { defineConfig } from "vitest/config";

/** The console's tests run in Node: every one of them drives the server, the worker or the run
 *  store against a temporary show on disk, and none of them renders the client.
 *
 *  The three workspaces' vitest configs carry the same three keys, so a test moved between them
 *  runs under the same rules: `include`, `testTimeout: 20_000` and `environment: "node"`. This
 *  file had no `testTimeout` and so ran under vitest's 5-second default while the engine's and the
 *  tools' declared 20 — a difference no one chose, and the wrong way round for a suite made of
 *  tests that drive a live server. No test here needs more than 5 seconds today; the allowance is
 *  so that one which does fails for its own reason rather than on the clock. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    environment: "node",
  },
});
