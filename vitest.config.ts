import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['app/**/*.test.{ts,tsx}'],
    environment: 'node',
    // `node:sqlite` is stdlib but still warns on import; the warning is noise, not news.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
})
