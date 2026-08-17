import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/_drafts/**'],
    // Deliberately NOT UTC. The engine must derive calendar days from the
    // injected clock's UTC components (01-ARCHITECTURE §9). Both this container
    // and Azure Functions run UTC, so a local-time implementation would be green
    // here and in CI, and wrong only on a Belgrade laptop — a divergence the
    // suite could never catch. Running the tests in a non-UTC zone makes that
    // class of bug fail loudly instead. Belgrade because it is where the
    // documents come from; any non-UTC zone would serve.
    env: { TZ: 'Europe/Belgrade' },
    coverage: {
      provider: 'v8',
      include: ['src/engine/**'],
      // Placeholder modules, blocked on real fixtures (TEST-FREEZE.md "Not
      // frozen, because it does not exist yet"). They are stubs with no test
      // file, so leaving them in would hold the gate hostage to F2/F4/F5/F7/F10.
      //
      // DELETE THE LINE when its fixture lands and its tests are written. An
      // entry that outlives its blocker is a hole in the gate.
      exclude: [
        'src/engine/extract/fiscal-qr.ts', //             F10 + spike S-QR
        'src/engine/extract/fiscal-receipt-regex.ts', //  F4
        'src/engine/extract/di-map.ts', //                F4 + spike S-DI
        'src/engine/statements/parse-personal.ts', //     F2
        'src/engine/mail/parse-eml.ts', //                F5 / F9
        'src/engine/whatsapp/parse-inbound.ts', //        F7
      ],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
})
