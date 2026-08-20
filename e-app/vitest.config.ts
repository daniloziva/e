import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // *.azurite.test.ts needs a live emulator, so it is NOT part of `pnpm test`
    // — that must run with nothing else installed (06-TDD-STRATEGY.md:244).
    // It runs via `pnpm test:contract` / vitest.contract.config.ts.
    exclude: ['test/_drafts/**', 'test/contract/**/*.azurite.test.ts'],
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
      // Without this the gate is dead whenever it matters most. vitest defaults
      // `reportOnFailure` to FALSE, so a red suite emits no report and evaluates
      // no threshold — coverage silently stops being checked at exactly the moment
      // the code is broken. Measured 2026-08-17: this was one of the two reasons
      // the thresholds below had never once been executed since M0 declared them.
      reportOnFailure: true,
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
})
