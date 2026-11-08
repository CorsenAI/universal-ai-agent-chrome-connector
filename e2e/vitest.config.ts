import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Real-browser end-to-end tests: built daemon + built extension in Chromium (Playwright).
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    name: 'e2e',
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
