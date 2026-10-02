import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The client build and the dev server. The dev server proxies `/api` to the console's own server
 *  (Task 4), which is the only origin the client talks to; the built client is served by that
 *  same server out of `dist/client`.
 *
 *  **5193 and 4410, not 5183 and 4400: those two are console v1's ports in the show repository**,
 *  and the defaults differ so both consoles run side by side (the showrunner's ruling of
 *  2026-10-02). The proxy target must stay equal to `DEFAULT_PORT` in `server/main.ts`, which is
 *  what the server binds when `npm run dev` starts it with no `--port`;
 *  `test/show.test.ts` asserts the two agree. The port here is repeated as `vite --port 5193` in
 *  `package.json`'s `dev` script, because the command-line flag overrides this value. */
export default defineConfig({
  plugins: [react()],
  root: ".",
  build: { outDir: "dist/client" },
  server: { host: true, port: 5193, proxy: { "/api": "http://localhost:4410" } },
});
