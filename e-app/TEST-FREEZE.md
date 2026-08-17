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
| writing implementations in `src/engine/**` | editing an assertion so a stub passes |
| adding tests for **new** behaviour that no test covers | deleting or skipping a failing test |
| deleting a test whose contract was formally unfrozen (below) | `.skip`, `.only`, or commenting out a case |
| fixing a test that **cannot compile** | "adjusting" an expected value to match observed output |
| adding adapter (L2) and use-case (L3) tests — those layers were never frozen | weakening a refusal test into a permissive one |

The frozen surface is **`test/unit/**` only** — 14 files, 2,771 cases, covering all 31
modules under `src/engine/`. Adapter contract tests and use-case tests do not exist yet and
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

## Known-wrong assertions — read before you fight one

**As of 2026-08-16 the engine is implemented: 2,792 of 2,798 cases pass.** The six that do not are
all listed below, and none of them is a code defect. Full analysis for each is in `UNFREEZE-LOG.md`.

| Where | What is wrong | Status |
|---|---|---|
| `reconcile.test.ts:337` | difference 240 vs tolerance 1000 asserted unbalanced; `1240` is the spec's *razlika* pasted into the closing-balance column | **green, but only via an invented `MAX_TOLERANCE = 100`** — CANDIDATE-013 |
| `invoicing.test.ts:891` | three rows in one `it.each` are mutually unsatisfiable — two require no VAT, one requires 20% | red — CANDIDATE-014 |
| `packaging.test.ts:986` | the company name must be both absent from the golden body and present in it | red — CANDIDATE-016A |
| `packaging.test.ts:1093/1105/1116` | the spec-mandated `Napomena:` line contains a `⚠` these three counters do not exclude | red ×3 — CANDIDATE-016B |
| `smoke.test.ts:6` | asserts `suggestNextNumber` is *still a stub*; expired the moment it was implemented | red — expired scaffolding |

**One `UNFREEZE:` pass clears all seven** (six red plus the `reconcile` workaround) and deletes the
one unexplained constant in the codebase. Until then: do not "fix" any of them in `src/`.

---

## Assertions that BLOCK a proposed improvement — not wrong, but pinning behaviour under review

These are **correct as written**. They are listed because a reviewed, agreed improvement cannot land
while they stand, so each is an unfreeze decision rather than a bug. Full analysis for each is in
`UNFREEZE-LOG.md`. Nothing here has been changed in `src/`.

| Where | What it pins | What is blocked |
|---|---|---|
| `extract-validate.test.ts:248-249` | `'000000000'` and `'111111111'` are kept as valid PIBs | **CANDIDATE-002** — an ISO 7064 MOD 11,10 check digit. Both real PIBs in this project validate; both pinned fakes are numbers that cannot be issued, and a one-digit OCR misread is exactly what a checksum catches. PIB is *identity* for vendor profiles |
| `nlu.test.ts:823-828` | model-sourced money at `confidence: 'high'` commits without a tap | **CANDIDATE-005** — clamping a model's self-reported confidence, or requiring a tap when *money* is model-sourced. Both guards are forbidden here as frozen |
| `nlu.test.ts:905-922` | the confirm threshold compares raw amounts, currency-blind, in both directions | **CANDIDATE-006** — converting before comparing. 400 EUR ≈ 46,800 RSD currently commits under a 500 RSD threshold, a ~117× hole in the only gate on the WhatsApp path |
| `tebra.test.ts` — *"sums the original amount when currency is part of the group key"* | `groupBy: ['currency']` over mixed currencies must **succeed** | **Result-level currency checking.** The per-bucket check is correct and is what lets that query work; but the grand `total` is never currency-checked on *any* axis, so `['category']` and `['vendor']` pool too. Verified by attempting the fix: a result-level refusal turns this assertion red. `AggregateResult` is pinned to four fields, so a caveat field also needs an unfreeze. **The freeze-compatible route is render-layer suppression at M4.5** |

**Attempted and reverted, 2026-08-16:** the result-level currency check in `aggregate.ts` was written,
run against the frozen suite, found to break the assertion above, and removed. That is the intended
workflow — the suite refused, so the change became a register entry instead of a forced fix.

The freeze says the test is right and your code is wrong, and that is the correct default. But it
is not a claim that the suite is infallible, and one assertion has since been shown to be
arithmetically wrong rather than merely surprising.

**`test/unit/reconcile.test.ts:337` — the row `[1000, 1240, false]`.** It requires a difference of
**240** against a tolerance of **1000** to be unbalanced. Every other row in that table is a clean
at-the-boundary test. The `1240` was lifted from `04-PERSONAL.md:87`'s failure message
(`razlika 1.240,00` — *razlika* is **difference**) and placed in the column that holds the
**closing balance**, so the intended difference of 1240 became an actual difference of 240.

To satisfy it, `statements/reconcile.ts` currently carries an invented `MAX_TOLERANCE = 100`
constant that appears in no spec. **Do not "clean up" that constant without applying the ruling** —
the build will break. Full analysis, the one-line fix and the ruling status are in
`UNFREEZE-LOG.md` under **CANDIDATE-013**.

If you believe you have found a second one: the bar is the one that entry meets — a demonstrable
arithmetic or real-world error with traceable provenance, not "this assertion is inconvenient."
**Stop and report it. Do not work around it**, because a workaround is how an invented constant
ends up in the code with nothing explaining it.

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
- **`engine/` never imports `adapters/`** — eslint-enforced, so the pure layer stays pure.

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

Coverage gate live in `vitest.config.ts`: 95% lines / 90% branches on `src/engine/**`.

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
