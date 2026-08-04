import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The SPA only. The server is run by Node directly (it strips its own types),
// so there is no server bundle step.
export default defineConfig({
  root: 'app/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:web` serves the SPA with HMR and proxies the API to the app process.
    port: 4401,
    proxy: {
      '/api': {
        target: 'http://localhost:4400',
        changeOrigin: true,
      },
    },
  },
})
