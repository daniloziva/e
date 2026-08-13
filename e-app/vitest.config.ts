import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/_drafts/**'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
})
