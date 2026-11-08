import { defineConfig } from 'vitest/config'

// Each workspace package owns its vitest.config.ts (name, environment, includes).
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
})
