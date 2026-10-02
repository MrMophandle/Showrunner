import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The client build and the dev server. The dev server proxies `/api` to the console's own server
 *  (Task 4), which is the only origin the client talks to; the built client is served by that
 *  same server out of `dist/client`. */
export default defineConfig({
  plugins: [react()],
  root: ".",
  build: { outDir: "dist/client" },
  server: { host: true, port: 5183, proxy: { "/api": "http://localhost:4400" } },
});
