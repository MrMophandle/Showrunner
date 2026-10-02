import { defineConfig } from "vitest/config";

/** The console's tests run in Node: every one of them drives the server, the worker or the run
 *  store against a temporary show on disk, and none of them renders the client. */
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
