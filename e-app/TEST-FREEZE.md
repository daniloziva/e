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

## Known-wrong assertions — APPLIED 2026-08-17

**All six were ruled on by Danilo and unfrozen in a single `UNFREEZE:` commit.** Nothing below is
outstanding; the table is kept because the reasoning is what stops each one being reintroduced.

| Where | What was wrong | Applied |
|---|---|---|
| `reconcile.test.ts:337` | difference 240 vs tolerance 1000 asserted unbalanced; `1240` is the spec's *razlika* pasted into the closing-balance column | `1240 → 2240`. **`MAX_TOLERANCE` must now be deleted from `reconcile.ts`** — if a tolerance ceiling ever reappears there it is a regression, not a fix |
| `invoicing.test.ts:891` | three rows in one `it.each` were mutually unsatisfiable — two require no VAT, one requires 20% | `14071.12 → 11725.93` (the ×1.2 basis came from the preceding test) |
| `packaging.test.ts:986` | the company name had to be both absent from the golden body and present in it | Danilo's ruling: **both Subject and body**. Both goldens now carry it. `03-DILIGAF.md` §5's verbatim sample still omits it and needs the matching line; the Serbian wording is provisional |
| `packaging.test.ts:1093/1105/1116` | the spec-mandated `Napomena:` line contains a `⚠` these three counters did not exclude | restored `&& l.startsWith('  ')`, the guard drafts e3 and e2 both had and the merge dropped |
| `smoke.test.ts:6` | asserted `suggestNextNumber` was *still a stub*; expired the moment it was implemented | file deleted. The "passingCount must stay at 1" invariant is spent — 2,810 other cases prove the harness runs |
| `extract-validate.test.ts:248-249` | `'000000000'` and `'111111111'` kept as valid PIBs | **CANDIDATE-002 applied** — see below |

**CANDIDATE-002's blast radius was five times what the register predicted.** The entry said "two
assertions at `:248-249`, plus any fixture using a made-up PIB" without enumerating. Scanning every
PIB-shaped literal in the suite found **eleven affected sites**, including `vendorPib: '123456789'` in
`extract-validate.test.ts`'s **default `facts()` fixture** — which would have silently rejected the
vendor PIB in most of a 182-case file once the checksum landed in `src/`.

The algorithm was verified against three real, independently sourced PIBs before any test was touched:
`104052135` (NIS) and `111886391` (DILIGAF) from the F4 receipt, and `100002887` — used 27× in
`extract-ladder.test.ts` and confirmed by the NBS account registry as **TELEKOM SRBIJA A.D.** All three
validate. `100002593`, the other PIB-shaped fixture, returns **zero rows** from that registry, so it is
invented and was corrected rather than treated as a counterexample. **No real PIB fails this checksum.**

Corrected fixtures keep their original prefix with only the check digit fixed, so each case's intent
survives: `123456789→123456788`, `100205514→100205516`, `000123456→000123452`, `100002593→100002590`.

**Left alone deliberately:** `extract-ladder.test.ts:580` — `vendorKey('OMV Srbija', '000000000')`, titled
*"accepts a PIB of exactly nine digits, including all zeros"*. It tests `vendorKey`, not `validateFacts`,
and sits inside the provisional carve-out below. C-002 scopes the checksum to `validate.ts`. If a
checksum is ever added to `vendorKey` or to invoice-party PIBs, that test plus `invoicing.test.ts:44`
and `:52` become the next blast radius.

**Six cases are now correctly RED**, awaiting the `src/` half in a separate commit: three PIB rejections
(the checksum is not in `validate.ts` yet) and three `buildEmailBody` cases (the company name is not
emitted yet). That is TDD RED, not regression — before this commit the same six were *unsatisfiable*.

---

## Assertions that BLOCK a proposed improvement — not wrong, but pinning behaviour under review

These are **correct as written**. They are listed because a reviewed, agreed improvement cannot land
while they stand, so each is an unfreeze decision rather than a bug. Full analysis for each is in
`UNFREEZE-LOG.md`. Nothing here has been changed in `src/`.

| Where | What it pins | What is blocked |
|---|---|---|
| `nlu.test.ts:823-828` | model-sourced money at `confidence: 'high'` commits without a tap | **CANDIDATE-005** — clamping a model's self-reported confidence, or requiring a tap when *money* is model-sourced. Both guards are forbidden here as frozen. Deferred: the cost does not grow with time |
| `nlu.test.ts:905-922` | the confirm threshold compares raw amounts, currency-blind, in both directions | **CANDIDATE-006 — PRE-AUTHORIZED BY DANILO, 2026-08-17.** 400 EUR ≈ 46,800 RSD commits under a 500 RSD threshold, a ~117× hole in the only gate on the WhatsApp path. Superseded by the LCY work, which fixes it generally rather than per-currency. The ruling is the approval of LCY itself: LCY cannot be implemented without unfreezing this assertion, so approving the change authorized the unfreeze. Recorded here because rule 3 of the procedure above requires the product owner's ruling to be *named*, and an isolated engineer cannot self-authorize one. **Still lands in its own `UNFREEZE:` commit with no `src/` changes** |
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

**S-PIB is now substantially answered (2026-08-17) — this carve-out is close to retirable.** The
blocker was that the response shape was unconfirmed. It is confirmed: the NBS public account
registry needs no authentication, returns a stable `data-title`-keyed table, and was verified live
against DILIGAF, Telekom Srbija, and three multi-result name searches. Full findings —
including that **matični broj is identity and names are aliases** (one MB returns three different
name strings), that the registry's own diacritics are inconsistent, and that a `PR`'s registered
name embeds owner, activity and city — are in `07-ROADMAP.md` M1 under **S-PIB outcome**.

What is *not* yet settled, and what still holds this carve-out open: the paid SOAP API publishes no
registration procedure and types its response as `<s:any />`, so if the eventual canonical source is
the API rather than the scrape, the field names could still differ. Rewrite these tests against the
scrape's confirmed shape once the adapter exists — not before, because the mapper's own tests
(from the saved `BORBA` and `SECTOR` fixtures) are what will pin the contract.

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
