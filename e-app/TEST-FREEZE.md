# TEST FREEZE — in force as of 2026-08-13

The unit suite is now **the specification**. It is frozen. Implementation begins.

```
Test Files  14 failed | 1 passed (15)
     Tests  2771 failed | 1 passed (2772)      ← the 1 pass is the harness smoke test
```

Every failure is `Error: not implemented` thrown from a stub. `npx tsc --noEmit` is clean
across `src/` and `test/unit/`. That is correct TDD RED, and it is the baseline.

---

## What the freeze means

**You may not change a test to make the implementation pass.** That is the only rule, and
it is the whole point. When a test and your code disagree, the test is right until it is
formally unfrozen.

| Allowed while frozen | Not allowed |
|---|---|
| writing implementations in `src/core/**` | editing an assertion so a stub passes |
| adding tests for **new** behaviour that no test covers | deleting or skipping a failing test |
| deleting a test whose contract was formally unfrozen (below) | `.skip`, `.only`, or commenting out a case |
| fixing a test that **cannot compile** | "adjusting" an expected value to match observed output |
| adding adapter (L2) and use-case (L3) tests — those layers were never frozen | weakening a refusal test into a permissive one |

The frozen surface is **`test/unit/**` only** — 14 files, 2,771 cases, covering all 31
modules under `src/core/`. Adapter contract tests and use-case tests do not exist yet and
are not covered by this freeze.

---

## How to unfreeze something

Not "I think this test is wrong." That instinct is exactly what the freeze exists to
resist — a test written before the code is the honest statement of intent, and the code is
the thing under suspicion.

Unfreezing requires all four:

1. **State which test, and what it currently asserts.**
2. **State why the assertion is wrong** — not inconvenient. Cite the spec section, or a
   real-world fact the spec got wrong (a bank's actual format, a tax rule, an API's real
   response).
3. **Get the product owner's explicit ruling.** Danilo decides. Not the implementer, and
   not a subagent.
4. **Change the test in its own commit**, message beginning `UNFREEZE:`, with the reason in
   the body. Never in the same commit as an implementation.

A test that was changed to go green, in a commit that also changed `src/`, is
indistinguishable from a bug being papered over. The commit discipline is what makes the
freeze auditable rather than aspirational.

---

## The one carve-out: vendor identity

Freezing a contract we have already decided to change would be dishonest, so this is named
precisely rather than left as a vague escape hatch.

**Provisional — `test/unit/extract-ladder.test.ts`, these describe blocks only:**

- `vendorKey` — every case (diacritic folding `Đ` → `d`, punctuation collapse, Cyrillic
  stability, PIB-preferred-over-name)
- the `learnFromCorrection` case asserting **"the profile key never changes when a PIB is
  learned later"**

**Why they are provisional:** vendor identity is moving to content matching over a single
`_state/vendor-profiles.json` — PIB as identity, names as matchable aliases — which removes
the derived-filename orphaning problem entirely and may retire `vendorKey` altogether
(`01-ARCHITECTURE.md` §5, D20). The canonical name will come from one authoritative source
(APR open data or the NBS PIB lookup), which is what makes normalization uniform by
construction and retires the folding question these tests currently pin.

**Blocked on spike S-PIB.** Until that spike runs, rewriting these tests would mean writing
assertions against an endpoint whose response shape is unconfirmed — the exact failure this
project has avoided throughout.

**Everything else in that file is frozen**, including the ladder short-circuit tests, the
`applyProfile` flat-key and prototype-pollution tests, and the rest of
`learnFromCorrection`.

When S-PIB lands: rewrite the provisional block, delete this carve-out, and the freeze
becomes total.

---

## Rules the suite enforces about itself

Learned the hard way — a bare `.toThrow()` went green the moment it was written, because
the stubs throw `not implemented`. A test that passes before the code exists is not a test.

- **No argument-less `.toThrow()` or `.rejects.toThrow()`.** Assert a *deliberate*
  rejection whose message is not `not implemented`, via the local `expectRejects` helper
  each file defines. Worth adding to eslint as a hard ban.
- **No test may pass while its implementation is a stub.** `passingCount` must stay at 1
  (the smoke test) until real code lands. If it rises, a test is fake.
- **`core/` never imports `adapters/`** — eslint-enforced, so the pure layer stays pure.

---

## Baseline, per area

| Area | Cases | | Area | Cases |
|---|---|---|---|---|
| money | 354 | | ledger-core | 188 |
| documents | 262 | | extract-validate | 182 |
| tebra | 260 | | extract-ladder | 178 |
| packaging | 230 | | ledger-categorize | 165 |
| nlu | 205 | | dimensions | 159 |
| invoicing | 193 | | mail-route | 111 |
| books-commands | 188 | | reconcile | 96 |

Coverage gate live in `vitest.config.ts`: 95% lines / 90% branches on `src/core/**`.

---

## Not frozen, because it does not exist yet

Six modules have no tests, blocked on real fixtures — writing them now would mean testing
against invented data:

| Module | Needs |
|---|---|
| `extract/fiscal-qr` | F10 — one real QR payload (+ spike S-QR) |
| `extract/fiscal-receipt-regex` | F4 — real receipt OCR text |
| `extract/di-map` | real Document Intelligence responses |
| `statements/parse-personal` | F2 — real statement PDFs |
| `mail` MIME parsing | F5 / F9 — real `.eml` files |
| `whatsapp/parseInboundMessage` | F7 — real `image` / `document` webhook bodies |

Also outstanding and unfrozen: all L2 adapter contract tests (Azurite `putIfAbsent` /
`casPut`, SEF, IMAP, SMTP, Document Intelligence, QR) and all L3 use-case tests.
