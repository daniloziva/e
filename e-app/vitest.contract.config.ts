import { defineConfig } from 'vitest/config'

/**
 * L2 contract tests that need a live local emulator.
 *
 * Separated from `vitest.config.ts` because `pnpm test` must run with nothing
 * else installed or listening (`06-TDD-STRATEGY.md:244`). These are the tests
 * that cannot honour that, so they get their own entry point rather than a
 * conditional skip inside the default run.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/contract/**/*.azurite.test.ts'],
    env: { TZ: 'Europe/Belgrade' },
    // Azurite is a real service over HTTP; the unit-suite defaults are too tight.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
