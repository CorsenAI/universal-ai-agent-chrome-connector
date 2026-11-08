import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'extension',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
