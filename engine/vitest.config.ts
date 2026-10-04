import { defineConfig } from "vitest/config";

/** The three workspaces' vitest configs carry the same three keys, so a test moved between them
 *  runs under the same rules: `include`, `testTimeout: 20_000` and `environment: "node"`.
 *  `"node"` is already vitest's default and is written out because the console's config has to
 *  state it — none of its tests renders the client — and a default stated in one of three places
 *  reads as a difference between them. The 20-second timeout is for the tests here that spawn a
 *  process or touch a temporary show on disk; vitest's own default is 5 seconds. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    environment: "node",
  },
});
