# UNFREEZE LOG

The audit trail for changes to the frozen unit suite, and the queue of proposed
changes awaiting a ruling. `TEST-FREEZE.md` defines the procedure; this file is
the record.

Every entry states **which test**, **what it asserted**, **why the assertion was
wrong** (not merely inconvenient), and **who ruled**. A change with no entry here
is indistinguishable from a bug being papered over.

---

## APPLIED

### UNFREEZE-001 — amountTotal ceiling raised from 10,000,000 to 100,000,000

**Ruled by:** Danilo, 2026-08-15. **Applied:** 2026-08-15.

**What the tests asserted.** `test/unit/extract-validate.test.ts` pinned the
upper bound of `amountTotal` at ten million, exclusive:

- `:511` `'exactly ten million — the upper bound is exclusive'` → `10_000_000` nulled
- `:512` `'a hair above ten million'` → `10_000_000.01` nulled
- `:494` `'a fraction below the upper bound'` → `9_999_999.99` kept
- `:530` a `50_000_000` total nulled and not clamped to `10_000_000`
- `:163` the shared dirty-facts fixture used `12_000_000` as an out-of-range total
- `:646` the VAT-dropped-with-rejected-total case used `20_000_000`
- `:765` the review-status case used `10_000_000`
- `:893` the determinism case used `10_000_000`

**Why the assertion was wrong.** Ten million RSD is roughly €85,000 — well inside
the range of an ordinary business document, so the ceiling refused legitimate
invoices rather than catching misreads. It was also **currency-blind**: the same
number applied to EUR made the guard about 117× looser (EUR 9,999,999 ≈ 1.17bn
RSD passed, while RSD 10,000,000 did not). Raising it to 100,000,000 keeps a
sanity ceiling — a decimal point misread as a thousands separator still fails —
while no longer rejecting real documents.

**What changed.** Boundary values moved; every test's *intent* preserved exactly.
The bound stays exclusive at both ends, nothing is clamped, and the
`'decimal point misread as a thousands separator'` case was moved to
`1_200_000_000` so it still tests what its label says.

**Also updated:** `src/engine/extract/validate.ts` (`AMOUNT_UPPER_EXCLUSIVE` and
three comments) and `01-ARCHITECTURE.md` §5 line 325.

**Verified:** `extract-validate.test.ts` 182/182; whole suite unchanged at
`1785 failed | 1013 passed (2798)`; lint, typecheck and build green.

**Still open from this entry:** the ceiling remains **currency-blind**. At
100,000,000 the asymmetry is unchanged in kind — an EUR total of 99,999,999
(≈11.7bn RSD) still passes. If that matters, the rule needs to consult
`currency`, which is validated independently today.

---

## TEST-QUALITY FINDINGS — from mutation testing, 2026-08-17

A different instrument from everything else in this file. The three engineer reviews asked whether the
*code* is right; this asked whether the *tests* can tell. Method: break the implementation
deliberately, run the suite, and see whether it notices. It is the only way to find an assertion that
passes for the wrong reason.

Scope: `invoicing` only — one module of sixteen. **137 mutants** run against the merged suite and all
three superseded drafts.

### The headline number

**25 of 137 mutants were detected by nobody** — not by the frozen suite, not by any draft. That is the
honest coverage figure for this module, and it is invisible from the 193/193 pass count.

Two reassurances from the same sweep, worth recording so they are not re-investigated: **no assertion
made by all three drafts was dropped outright by the merge**, and **no mutant was killed by any draft
while the merge stayed blind**. The merge was not lossy in that sense. Verified twice — assertion-by-
assertion hand diff with every `it.each` expanded, plus the sweep.

### GAP 1 — [CLOSED] the suite could not detect a truncating currency conversion

One guard *did* survive only in weakened form. All three drafts independently pinned an exact 2dp
`totalRsd`, and e2's (`e2.test.ts:680-689`) was the only **round-up** case. The merge folded all three
into one table at `invoicing.test.ts:888-902` whose body hardcodes `vatMode: 'none'`, which made e2's
row arithmetically unsatisfiable — it is the permanently-red `:891` (CANDIDATE-014). **Both surviving
rows round down.**

So the merge did not merely break one assertion; it deleted the only guard against truncation.
Measured: replacing `round2(money.amount * rate)` with `Math.floor(...)` in `toRsd` leaves the suite
**bit-identical to baseline** — 547 cases including all 354 money cases cannot tell a truncating
currency conversion from a correct one. Every foreign-currency invoice's RSD figure would be
systematically a cent light, silently, forever.

**CLOSED** by `test/unit/money-guards.test.ts` (a new file — the freeze permits tests for behaviour no
case covers). Verified to kill the mutant: 5 failures where there were previously 0.

Note for anyone writing similar guards: `100 @ 117.2593` does **not** discriminate — round and floor
both give `11725.93`, which is precisely why the frozen table is blind. Measured discriminators are
`1 @ 117.235`, `1 @ 117.125`, `7 @ 14.2925`, `2 @ 58.6175`.

### GAP 2 — [CLOSED] a test whose title and comment are false

`invoicing.test.ts:334-343` is titled *"computes VAT on the rounded net, not on the raw sum"* and
comments *"the net differs, so the total is what pins the order of operations."* **The net does not
differ.** It is `round2(sum)` under either reading, so the whole triple `{net: 0.63, vat: 0.13,
total: 0.76}` results either way.

Measured: mutating `invoice-model.ts:49` to `round2(sum * vatRateFor(mode))` leaves the frozen suite at
**`1 failed | 192 passed` — exactly baseline** — and leaves all three drafts green too. The ordering
documented at `invoice-model.ts:31-41` was asserted by a comment and nothing else.

Provenance: the fixture and expectation are e2's (`e2.test.ts:299-306`, honestly titled *"rounds a VAT
amount that lands exactly on the half up"*). The order-of-operations claim was **added at merge time**
and was never backed by an assertion.

**CLOSED** by the same new file. Verified to kill the mutant: 4 failures against a blind baseline.

### Still open from this sweep

**~22 of the 25 undetected mutants are not enumerated** in the sweep's report — only three were
identified by inspection, two of which are the gaps closed above. Listing the rest is the obvious next
step, and it is cheap now that the harness exists.

**And this covered one module of sixteen.** If `invoicing` carries 25 undetectable mutants at 193
frozen cases, the same instrument pointed at `ledger-core` (188), `money` (354) or `tebra` (260) should
be expected to find comparable holes. Nothing about a 2805/2811 pass count speaks to this.

Incidental finding, not a defect: mutating `invoice-number.ts:27` (`i += 1` → `i += 0`) makes
`digitRuns` non-terminating, which hung the sweep until a per-mutant timeout was added. There is no
iteration guard in that loop. Harmless as written; worth knowing before anyone refactors it.

## CORRECTIONS TO THIS FILE'S OWN ADVICE — measured after the fixes landed

### The ReDoS guard that shipped is PARTIAL, and CANDIDATE-010's entry overstated it

The pattern-length cap and nested-quantifier rejection now in `ledger/rules.ts` close the measured
attack and the classic shapes. They do **not** close alternation overlap. Measured through
`ruleMatches`, 26-character input:

```
(A+)+$        →     0 ms    caught
((A*)*)*C     →     0 ms    caught
(A|A)*C       → 4,268 ms    NOT CAUGHT
(?:A|A)*C     → 3,106 ms    NOT CAUGHT
```

`(A|A)*` is exponential for the same reason nesting is — two ways to consume each character, every
combination tried before failing — but there is no quantifier *inside* the group, so the detector
does not fire. It is exponential in input length, so ~30 characters costs about a minute.

**Do not respond by adding a second detector.** Each one covers one syntactic family and there are
more families than anyone enumerates. Static detection of catastrophic regexes is a losing game, and
treating it as *the* defence repeats the CANDIDATE-015 error — a control verified against the cases
its author thought of.

**This reclassifies the provenance half from defence-in-depth to THE control.** The static check is
the stopgap.

**And it explains why provenance cannot be a field on the rule.** A `source: 'authored'` flag is set
by whoever writes the rule — precisely the actor being defended against; a model would simply claim
to be hand-authored. Provenance is not a property of the data, it is a property of **the path the
data took**, and the only code that knows it is the path itself. Practical form: separate
`_state/rules/authored.json` from `_state/rules/learned.json` and have the loader refuse
`matchType: 'regex'` from the second. Location as provenance — unforgeable.

### CANDIDATE-003's proposed check cannot work from the total alone — Q3 was the wrong question

The plan specified: flag when `vatAmount / (amountTotal − vatAmount)` is not near a legal rate.
Measured against realistic Serbian baskets:

| receipt | effective rate | naive exact-rate check |
|---|---|---|
| single-rate 20% (the F4 fuel receipt) | 20.00% | accepts |
| supermarket, 1000 non-food + 1000 food | **15.00%** | **flags** |
| mostly food | **11.00%** | **flags** |
| German supplier @19% | **19.00%** | **flags** |
| the misread digit this exists to catch | **1.69%** | flags ✓ |

Serbia has 20% standard and 10% reduced, and food is reduced — so **any mixed basket blends to a rate
that is neither**, and a rule keyed on exact rates flags the most common document type there is. That
is the alarm-fatigue failure `04-PERSONAL.md` §2 warns about, arriving on day one.

Widening to a band does not rescue it. `[10%, 20%]` accepts the blends and catches 1.69% — but a
mostly-exempt receipt carrying a little 20% lands near 1% and flags too. Widen to `[0%, 20%]` and
1.69% is accepted again, which is the case the check exists for.

**Conclusion: an understated VAT cannot be distinguished from a mostly-exempt basket without knowing
the rate mix** — and the rate mix is on the receipt: per-item tax labels (`Ђ` on the F4 fuel receipt)
and `items[]` in the TaxCore verification response. E extracts both.

So this is not eight lines in `validate.ts`. It is a cross-check against line-item tax labels, and it
needs **F4** plus the fiscal-receipt parser, neither of which exists. **Reclassified: M1/M2
pre-condition, not a validator change.** Q3 (which rates will you see) does not unblock it.

One refinement worth keeping in whatever form it takes: **gate the check on `vendorPib !== null`.** A
Serbian PIB is nine digits and a foreign supplier has none, so foreign invoices at 19% or 22% exempt
themselves without needing a rate table at all.

## FOUND BY THE THREE-ENGINEER REVIEW, 2026-08-16 — not previously logged

All verified independently before being written down.

### U2 — the CI gate is theatre, and flipping `continue-on-error` would not change that 🔴

```yaml
run: pnpm test --reporter=basic 2>&1 | tee unit.log
```

GitHub's default `run:` shell on Linux is `bash -e {0}` — **no `pipefail`**. The pipeline's exit
status is `tee`'s, which is always 0. Measured: `bash -e -c 'false | tee /dev/null; echo $?'` → **0**.

So `steps.unit.outcome` is hard-wired to `success`, the job summary line *"Outcome: `success`"* is
false today, and **anyone who flips `continue-on-error` to `false` will believe they have a gate when
they have a pipe.** The same defect is on the coverage step.

**Fix before the flip, not after:** add `shell: bash` (which brings `-eo pipefail`) to both steps, or
drop the `| tee` and redirect instead. One line each.

### U3 — the coverage gate is dead twice over, and would go red if resurrected

1. `vitest`'s `coverage.reportOnFailure` defaults to **false**. With the 6 known-wrong tests red,
   `pnpm coverage` emits no report and evaluates no threshold — so the CI's grep finds nothing and
   falls through to printing the test-failure summary under a "Coverage" heading.
2. Forced with `--coverage.reportOnFailure`, the real number today is **89.04% branches** against a
   90% gate. Measured.

So clearing the six assertions and flipping both flags produces a **red CI on a number nobody has
ever seen**. `07-ROADMAP.md` §M0's "done when the coverage gate demonstrably fails on a deliberately
uncovered line" was never actually done. Gaps are concentrated in `packaging` (83.4%), `ledger`
(85.8%) and `mail` (87.1%).

### U4 — `blobPathFor` does not validate `period`, and writes the document where no listing will find it 🔴

Measured:

```
period '2026-08' → diligaf/2026/08/expense/…   reparses ✓
period '2026-7'  → diligaf/2026/7/expense/…    reparses ✗
period ''        → diligaf///expense/…          reparses ✗
period '2026-13' → diligaf/2026/13/expense/…    reparses ✗
```

The monthly package is a **prefix listing on `diligaf/2026/08/`**. A document written to
`diligaf/2026/7/` is stored, dedupe-indexed and sidecar'd — and **invisible forever**. It does not
even round-trip through `parseBlobPath`, so the slug-recovery path cannot find it either.

The inconsistency is the tell: `buildManifest` and `monthBounds` both **throw** on `'2026-7'`. The one
function that decides where the bytes physically land is the one that does not check. ~4 lines,
freeze-compatible (no frozen case passes a malformed period).

### U5 — there is no monitoring anywhere in the design, so the monthly package fails as silence 🔴

A sweep of all ten spec documents for `alert|monitor|watchdog|heartbeat|notify` returns three hits,
all the same sentence, all arguing *against* a tool. There is no alert rule, no failure notification,
no dead-man's switch; `health.ts` is a liveness probe nobody polls.

Consequence, given a 06:00 UTC timer on the 1st: **if the package job throws, the operator receives
nothing**, and "no message on the 1st" is indistinguishable from "I didn't open WhatsApp." Three
proven paths terminate here — a single corrupt sidecar (`buildManifest` throws, correctly), a
pathological `_state` regex (CANDIDATE-010), and an Azure Functions timeout.

**The fix is deliberately not code:** an alert on function-execution failure routed to the same
WhatsApp number; a "no `_state/notified/{period}` marker by the 3rd" check reusing state the design
already has; and two sentences of runbook. This single control converts several silent findings into
"noticed within 72 hours" without touching any of them.

### U8 — M0's declared test infrastructure does not exist

`test/fakes/` is an **empty directory**. `07-ROADMAP.md` §M0 requires `FakeClock`, `SeqIdGen`,
`FakeWhatsApp`, per-layer extractor stubs and the `harness()` from `06-TDD-STRATEGY.md` §4.
`src/adapters/` does not exist, so the Azurite contract job is still `if: false`. **`putIfAbsent`
returning 409 and `casPut` returning 412 — which M0 calls "the foundation of the no-database
design" — have never run.** Every idempotency claim currently rests on a spec paragraph.

### Nothing is committed

One commit, **118 changed paths**, the entire engine uncommitted. Beyond the obvious risk, it blocks
the audit design: `TEST-FREEZE.md` requires an unfreeze to land "in its own commit", and there is no
commit for it to be separate from.

---

## PROPOSED — awaiting review, no action taken

### Spec gap — a currency-grouped `total` pools currencies, and no assertion can stop it

**Found by:** the driver and the navigator **independently**, `tebra` pairing, 2026-08-16.
**Not an unfreeze** — no frozen assertion is wrong. A number the suite cannot force to be right.

`aggregate(txs, { groupBy: ['currency'], metric: 'sum', field: 'amount' })` is *required* to succeed
(`tebra.test.ts:494-499`): each row is single-currency and correct. But `AggregateResult.total` pools
every matching transaction, so it adds `EUR −100` to `RSD −6000` and reports `−6100` — a number in no
currency at all. The mixed-currency refusal is necessarily **per row**, precisely so this query can
succeed; it therefore cannot fire on the pooled total.

`AggregateResult` is pinned to exactly four fields by `toEqual` (`:748`, `:761`), so no caveat field
can be attached without an unfreeze.

**Evidence this is a known gap rather than an oversight:** all three superseded drafts asserted the
**rows** of this exact query (`e1:375-385`, `e2:406-410`, `e3:286-289`) and **none asserted its
total**. Three engineers independently declined to name that number.

**CORRECTION, 2026-08-16 — the mitigation first written here was wrong, and would have been worse
than nothing.** It said: *"suppress the grand total whenever `groupBy` includes `currency`."* That
closes roughly one case in three and would leave the others looking sanctioned. Measured:

```
groupBy ['currency'] → rows EUR −100 / RSD −6000,  total −6100     ← the case originally logged
groupBy ['category'] → rows −100 / −6000,          total −6100     ← ALSO pools
groupBy ['vendor']   → rows −100 / −6000,          total −6100     ← ALSO pools
metric 'avg'         →                             total −3050     ← a mean of two different units
```

The currency check runs **per bucket only**; the grand `total` is never currency-checked on any axis.
And most axes separate currencies incidentally — vendors and categories correlate strongly with
currency — so the pooled total is wrong on the *common* case, not the exotic one. Honest figure for
the example: ≈ **−17,720 RSD**, reported as **−6,100**.

**Correct mitigation:** track the set of currencies folded into the **result**, not just into each
bucket, and suppress (or refuse) `total` whenever `field === 'amount'` and more than one currency was
folded — **independent of `groupBy`**. Freeze-neutral as a render-layer suppression; needs an unfreeze
only if a caveat field is wanted on `AggregateResult` (pinned to four fields by `toEqual`).

**The same hole exists in `packaging`.** `manifest.ts` maps a null currency to `''`, so a group whose
rows all failed to read a currency has a currency set of size 1 and the mixed-currency guard does not
fire. Measured: two documents at `100` and `6000` with unread currencies publish
`TROŠKOVI (2) — 6.100,00` **with no unit at all** — again ≈ 17,720 RSD of reality. Fix is ~2 lines:
`moneyTotal`/`vatTotal` return `null` when any included row has `amount !== null && currency === null`.
The rows still print and still carry ⚠; only the meaningless sum is withheld.

### Related — `maxRowsPerCall` is declared but enforced nowhere

`LoopBudget.maxRowsPerCall` is excluded from `budgetExceeded` by test (`:1417-1419`), and `aggregate`
/ `searchDocuments` bound rows by the **model's own `limit`**. So nothing currently clamps a result
set, and an unbounded one enters the model's context — a token-budget breach on the one command
`09-TEBRA.md` §5.4 says "can burn real money".

The clamp belongs in the loop runner (which does not exist yet):
`min(model.limit ?? maxRowsPerCall, maxRowsPerCall)`. It is only honest because truncation is always
reported — `truncated` and `omittedRows` are pinned across `:627-736`, so a clamped answer can never
masquerade as a complete one.

### CANDIDATE-016 — two self-contradicting pairs in `packaging.test.ts`

**Found by:** the navigator (A) and the driver (B), independently, 2026-08-16. **Both verified.**
`packaging.test.ts` is **226/230**; the four failures are these two pairs and nothing else. **Nothing
was worked around** — no branch on a literal, no fixture-fitting, no constant.

#### A — the company name must be both absent and present (`:926` vs `:986`)

`input()` defaults `companyName: 'DILIGAF DOO'` (`:920`). `:945` asserts the collapsed body `toBe`
an exact fifteen-line golden containing **no company name anywhere** — it opens `Zdravo,` and closes
`E`. `collapse()` (`:280-285`) only trims trailing whitespace and squeezes internal space runs; it
cannot delete a word. `:987` asserts that the same call with `companyName: 'SMOQUA DOO'` **must
contain** `SMOQUA DOO`.

Same function, same manifest, same period label — one argument differs, and the body must omit the
name in one case and include it in the other. The only implementation satisfying both hardcodes
`'DILIGAF DOO'` as the value to suppress — **exactly what that test's own title forbids** ("uses the
company name it was given rather than a hardcoded one"). Not literally unsatisfiable like
CANDIDATE-014, but satisfiable *only by the defect it names*.

*Provenance.* `e1:965` carries that title but asserts against **`buildEmailSubject`**; `e2:959` has a
body variant and e2 has **no** full-body golden, so it was satisfiable there; `e3:855` contributed
the golden and had no body-company test. The merge combined e3's golden with e2's assertion under
e1's title. `03-DILIGAF.md` §5 puts the company name in the **Subject**, and `:1223-1225` already
pins it there.

**Proposed fix:** delete `:986-988` as a duplicate of `:1223-1225`. If the owner instead wants the
company visible inside the body — the accountant receives packages for DILIGAF *and* SMOQUA — then
the **golden** must change in the same commit.

#### B — the `Napomena` line contains a ⚠ that the ⚠-counters do not expect

`:948`'s golden mandates the closing line

```
Napomena: 2 dokumenta bez pročitanog iznosa (obeležena ⚠ i u manifest.csv).
```

which **contains `⚠`** — so that manifest renders **three** lines containing `⚠`: two marked rows
plus the note. But `:1079`, `:1099` and `:1110` filter `linesOf(body).filter(l => l.includes('⚠'))`
on a structurally identical manifest and require exactly **2**.

*Provenance is decisive.* The drafts wrote the filter with a guard that excluded the note:
`e3:952` used `l.includes('⚠') && l.startsWith('  ')`, `e2:907` used
`l.includes('⚠') && l.includes('2026-07-')`. `e3:976` and `e3:988` dropped the guard — and the merge
kept the guardless variants. The merged `:1105` even *removed* the `startsWith('  ')` guard its e3
ancestor had.

**Proposed fix:** restore `&& l.startsWith('  ')` on the three filters. The `Napomena` line is
spec-mandated (`03-DILIGAF.md` §5 prints it verbatim) and is the line that tells the accountant how
many documents are uncertain — dropping it would score 228/230 by deleting a specified feature.

**Why no workaround was possible honestly.** The only fixture difference between `:948` and `:1079`
is `extractionMethod` and one null vendor. A rule keyed on either would pass all 230 and be pure
fixture-fitting. The driver rejected that and reported instead — the behaviour `TEST-FREEZE.md` now
asks for.

### CANDIDATE-015 — [REOPENED 2026-08-16] the applied fix is INSUFFICIENT — six bypasses remain

> **READ THIS BEFORE THE "APPLIED" SECTION BELOW.** An adversarial re-attack found that the fix
> applied earlier today closes only the four shapes it was tested against. Six other **RFC-legal**
> `From` headers still route an attacker's document into the DILIGAF book, and one *legitimate*
> sender is now wrongly refused. All measured:

```
<a@evil.example>, <izvodi@banka-doo.rs>        → DILIGAF/izvod   multi-mailbox list, bank last
"<izvodi@banka-doo.rs>"@evil.example           → DILIGAF/izvod   RFC 5321 quoted local part
attacker@evil.example (<izvodi@banka-doo.rs>)  → DILIGAF/izvod   RFC 5322 comment
"<izvodi@banka-doo.rs>" attacker@evil.example  → DILIGAF/izvod   display name containing <>
Undisclosed:;, <izvodi@banka-doo.rs>           → DILIGAF/izvod   group syntax
<izvodi@banka-doo.rs.>                         → null            LEGITIMATE — availability break
```

**Root cause.** `senderAddress` takes **the last** `<…>` in the header. That is right for
`Display Name <addr>` and wrong for every other legal `From` shape: a multi-mailbox list, a comment,
a group, or a quoted local part all let the sender **choose what appears last**. Note
`"<izvodi@banka-doo.rs>"@evil.example` is a genuinely deliverable address at a domain the attacker
owns — this is not a parsing curiosity.

**And the control is not deployed anyway.** The routing table documented in `03-DILIGAF.md` §1 has
**no `fromPattern` at all** — it is subject-only. `senderMatches('')` returns `true`, so measured:
`someone@elsewhere.example` and `attacker@evil.example` both route to `DILIGAF/izvod` today. The
"operator action, still outstanding" recorded below **is the whole control**, and it is untaken.

**Correct fix — two actions, two clocks:**
1. **Today, data only, zero risk:** write every `fromPattern` in the real table in the anchored
   `<addr>` form. It is currently absent, so this is the difference between one control and none.
2. **Next:** stop parsing an address out of a formatted header. Either take the **first** mailbox
   rather than the last, or better, change the contract so `MailEnvelope.from` carries a structured,
   already-parsed single address and `route` never sees display names, comments or lists. Re-check
   against the 11 frozen `from` cases; also fix the trailing-dot FQDN refusal.

**Cleared on re-attack, so nobody re-litigates them:** unicode look-alikes in the *domain* — an
exhaustive sweep of U+0080–U+2FFFF found exactly one codepoint lowercasing to an ASCII character in
the bank's domain (U+212A KELVIN SIGN → `k`), and IDNA2008 maps it to `k` at DNS level, so the domain
is not registrable. Undecoded RFC 2047 encoded words are also refused. Neither is a problem.

**Process note.** This entry was marked APPLIED on the strength of the four attacks that motivated
it. That was the mistake: a fix verified against the attacks you thought of is not a fix. The
re-attack was worth more than the original fix.

### CANDIDATE-015 — [APPLIED 2026-08-16, PARTIAL] the four originally-tested shapes are closed

**Found by:** the navigator, `mail-route` pairing, 2026-08-16. **Verified end to end.**
**Additive fix, no unfreeze.** **Highest damage in this file, alongside CANDIDATE-010.**

`route` matches `fromPattern` as a substring of the **raw `From` header**, display name included,
after `normalize` — which also strips diacritics. Measured against the real rule table from
`03-DILIGAF.md` §1 (`fromPattern: 'izvodi@banka-doo.rs'`, subject `contains 'izvod'`):

```
"izvodi@banka-doo.rs" <attacker@evil.example>   →  DILIGAF / izvod
izvodi@banka-doo.rs.evil.example                →  DILIGAF / izvod
izvodí@banka-doo.rs      (acute accent)         →  DILIGAF / izvod
Re: izvodi@banka-doo.rs <x@evil.example>        →  DILIGAF / izvod
someone@elsewhere.example                       →  null   (correctly refused)
```

**Anyone who can send email chooses their own display name** — the same population that controls
`Message-ID`. Combine any of the first four with a subject containing `izvod` and an
attacker-supplied PDF is ingested into the **business book** as a bank statement, and flows into
the monthly accountant package. The third line is not a header trick: `normalize` folds `í` to `i`,
so homoglyph addresses collapse onto the genuine one.

**Why it is green.** The frozen suite *mandates* the display-name substring behaviour (a rule must
match when the address appears inside a display-name header) and separately shows the operator
mitigation — anchoring the pattern as `<izvodi@banka-doo.rs>`. Nothing makes anchoring the default,
and the real `_state` table in `03-DILIGAF.md` §1 is written unanchored.

**Immediate mitigation, deployable today with no code change:** anchor every `fromPattern` in the
routing table — `<izvodi@banka-doo.rs>` instead of `izvodi@banka-doo.rs`. This is a data edit and it
closes the display-name and subdomain shapes at once.

**Proper fix — additive, and the navigator verified it against all eleven frozen `from` cases:**
1. Extract the address before matching: the text inside the **last** `<…>`, else the whole trimmed
   header.
2. Normalize the sender with lowercase + whitespace-collapse **only** — no diacritic folding. Every
   frozen `from` fixture is ASCII, so this costs nothing and removes the homoglyph collapse.
3. Give `fromPattern` three shapes: `<addr>` → equality, `@domain` → `endsWith`, bare → `includes`.

**Steps 1 and 3 must land together.** Extracting the address without also stripping `<>` from the
pattern turns every anchored rule into a dead rule — which would silently send the bank's real mail
to E/Failed indefinitely.

---

**APPLIED 2026-08-16, ruled by Danilo** ("fromPattern is a must — I'd just enable my bank's primary
email for sending stuff"). All three steps landed together in `src/engine/mail/route.ts`:
`senderAddress` extracts the last `<…>`, `foldSender` lowercases and collapses whitespace without
touching diacritics, and `senderMatches` dispatches on pattern shape. `route` now passes the RAW
`From` header through rather than the diacritic-folded one.

Measured after, against the real §1 rule:

| sender | `<addr>` anchored | `@domain` | bare |
|---|---|---|---|
| legitimate, and legitimate with a display name | routes | routes | routes |
| display-name spoof | **refused** | **refused** | **refused** |
| subdomain suffix `…rs.evil.example` | **refused** | **refused** | routes |
| diacritic homoglyph `izvodí@…` | **refused** | routes¹ | **refused** |
| subject-line smuggle | **refused** | **refused** | **refused** |

¹ Correct for a domain rule: `izvodí@banka-doo.rs` is genuinely at the bank's domain, and only the
local part differs. A `@domain` rule is meant to accept that.

Frozen suite unchanged at 111/111 — the fix is freeze-compatible, as predicted.

**Operator action, still outstanding:** write the routing table with the **anchored** form,
`<izvodi@banka-doo.rs>`. It is the only shape that refuses all four attacks. The bare form is kept
only because the frozen suite pins its substring behaviour; it should not appear in `_state`.

### Related — `mail/route.ts` findings recorded but not applied

- **Silent rule validation.** A rule with `book: 'diligaf'` (wrong case) or `matchType: 'startsWith'`
  is dropped without a signal. Every message it would have routed goes to E/Failed indefinitely,
  with nothing distinguishing "no rule matched" from "your rule is malformed". Recommend `route`, or
  a sibling `validateRules`, return the dropped rule ids so the poller can log them once per run.
- **Inherited-property reads.** `toUsableRule` reads `value['book']`, `value['matchType']` etc.
  without `Object.hasOwn`, so a polluted `Object.prototype` fabricates a complete rule from `{id}`
  alone. Not exploitable from this module today — `JSON.parse` and spread both create own properties
  — but live the moment any `_state` loader does a recursive `target[k] = source[k]` merge, and
  `_state` is model-writable through `/tebra`. The house convention (`Object.hasOwn`, `UNSAFE_KEYS`,
  own-entry `Map`s) is used in five other modules; `route.ts` is the outlier.
- **`priority: -Infinity` sorts last**, not first — every non-finite priority is mapped to `+Infinity`.
- **Do not add `matchType: 'regex'` to `MailRule`.** The closed three-value set is exactly the
  mitigation CANDIDATE-010 recommends for `ledger/rules.ts`; adding it here would reopen a measured
  55-second-per-message stall on a path reachable from `_state`.

### Related — a malformed statement announces "razlika 0,00"

`reconcile` returns `difference: NaN` for malformed totals, and `money.ts`'s `formatAmount` — by the
owner ruling of 2026-08-15 — renders non-finite as the ordinary zero string. So `04-PERSONAL.md`
§2's warning renders as:

> `⚠ jul: parsirao 47 transakcija, ne poklapa se sa saldom (razlika 0,00) — proveri`

A quoted difference of zero reads as *balanced*. Fix in the message layer, not in `formatAmount`:
special-case a non-finite difference to "razlika: nije izračunata (neispravni saldi)". Additive; no
frozen case touches it.

### CANDIDATE-014 — an `it.each` table contains three mutually unsatisfiable rows

**Found by:** the driver and the navigator **independently**, `invoicing` pairing, 2026-08-16.
**Verified by direct arithmetic.** **Stronger than CANDIDATE-013: this one cannot be satisfied at
all, by any implementation.**

`test/unit/invoicing.test.ts:888-902`. One `it.each` table, one shared harness pinning
`vatMode: 'none'`, three rows:

```js
[  1, 117.2345,   117.23],
[  1, 117.2033,   117.2 ],
[100, 117.2593, 14071.12],   // ← this one
```

| | total = amount (no VAT) | total = amount × 1.2 (20% VAT) |
|---|---|---|
| row 1 | **117.23 ✓** | 140.68 ✗ |
| row 2 | **117.20 ✓** | 140.64 ✗ |
| row 3 | 11725.93 ✗ | **14071.12 ✓** |

Rows 1 and 2 pass only without VAT. Row 3 passes only with it. **There is no implementation that
passes all three** — this is not a contract that can be met by choosing the right design.

**Provenance, same anatomy as CANDIDATE-013.** The immediately preceding test (`:875-886`,
*"converts the VAT-inclusive total, not the net"*) uses `amount: 100` at `standard20` with rate
`117.5` and asserts `14100 = 120 × 117.5`. The ×120 basis was carried into the neighbouring table,
whose mode is hardcoded to `'none'` one line above the rate. A correct number lifted from an
adjacent context into a slot where it means something else.

**Minimal fix:** `14071.12 → 11725.93`, keeping the block at `'none'`. (Switching the block to
`standard20` instead would break rows 1 and 2, so the expected value is the thing to change.)

**Nothing was worked around.** Per the instruction added to `TEST-FREEZE.md` after CANDIDATE-013,
the driver stopped: `invoicing.test.ts` is 192/193, and no constant, rate special-case or
`'none'`-mode VAT application exists anywhere in `src/engine/invoicing/`. The remaining 192 cases
are implemented and green.

### Related — `smoke.test.ts` is self-obsoleting scaffolding and has now expired

`test/unit/smoke.test.ts:6` asserts:

```js
expect(() => suggestNextNumber('0007/2026')).toThrow('not implemented')
```

It asserts that `invoicing/invoice-number.ts` is **still a stub**. Implementing that module — the
task — necessarily turns it red. It is frozen, so it was left untouched.

This is the "1 passed" that `TEST-FREEZE.md` names as the baseline invariant (*"passingCount must
stay at 1 (the smoke test) until real code lands"*). That invariant did its job and is now spent:
real code has landed in thirteen modules. The test is harness scaffolding, not a behavioural
contract, but it still needs a formal deletion — the freeze table explicitly permits *"deleting a
test whose contract was formally unfrozen"*, which is exactly this case.

**Recommendation:** delete it in the same `UNFREEZE:` commit that fixes CANDIDATE-014, since both
are bookkeeping on a suite that has moved past its RED baseline.

### CANDIDATE-013 — a frozen row encodes an arithmetic slip, and it forced a magic constant into the code

**Found by:** the driver, `reconcile` pairing, 2026-08-16. **Independently verified.**
**This is the clearest unfreeze case in the file** — the assertion is not inconvenient, it is wrong.

**Which test, and what it asserts.** `test/unit/reconcile.test.ts:337`, the last row of the
tolerance table:

```js
it.each<[number, number, boolean]>([
  [0.01,  999.99, true ],   // difference 0.01  vs tolerance 0.01  — at the bound
  [0.5,   999.5,  true ],   // difference 0.5   vs 0.5             — at the bound
  [0.5,   999.49, false],   // difference 0.51  vs 0.5             — just over
  [1,     999.0,  true ],   // difference 1     vs 1               — at the bound
  [1,    1001.0,  true ],   // difference -1    vs 1               — at the bound
  [5,     995,    true ],   // difference 5     vs 5               — at the bound
  [1000, 1240,    false],   // difference -240  vs 1000            — INCONSISTENT
])(…)  // reconcile(totals(1000, 0, 0, closing), tolerance).balanced
```

Every row but the last is a boundary test where the difference exactly equals the tolerance. The
last one is not: `|1000 + 0 − 0 − 1240| = 240`, which is well inside a tolerance of 1000, so the
documented rule (`04-PERSONAL.md` §2, `opening + credits − debits ≈ closing` within tolerance)
gives `true`. The test demands `false`.

**Why the assertion is wrong — the provenance is traceable.** `04-PERSONAL.md:87` specifies the
failure message: `ne poklapa se sa saldom (razlika 1.240,00)`. **`razlika` is Serbian for
*difference*.** The author took `1240` from the spec's *difference* example and put it in the
column that holds the *closing balance*. The intent — "a difference of 1240 against a tolerance of
1000 must fail" — is correct and worth keeping; only the encoding is wrong. Draft suite `e3`
contradicts the frozen row directly, asserting `[1000, closing 300, true]` at a difference of
exactly 1000.

**What it cost.** To satisfy the row as written, the implementation carries
`MAX_TOLERANCE = 100` — a validity ceiling on the tolerance parameter that appears in no spec and
serves no purpose except this one assertion. Any ceiling in `[100, 240)` works, which is itself the
tell: the constant is unconstrained by anything real. It also silently changes behaviour for callers
who legitimately pass a large tolerance, and it is exactly the kind of unexplained number that
someone will later "clean up" and break the build with.

**Proposed fix — preserves the intent exactly:**

```js
[1000, 2240, false],   // difference -1240 vs tolerance 1000 — the spec's razlika 1.240,00
```

Closing 2240 against opening 1000 gives a difference of −1240, which exceeds the tolerance of 1000
and fails — encoding the spec's own example correctly. `MAX_TOLERANCE` is then deleted and the rule
becomes plain `|difference| <= tolerance` throughout.

**Process note.** The driver was instructed to STOP and report if convinced a test was genuinely
wrong, rather than work around it. It reported clearly and in full — but it also shipped the
workaround to reach green. The constant should come out as part of applying this ruling.

Both were found during the `extract/validate.ts` pairing on 2026-08-15 and are
recorded here at Danilo's instruction to review later. **Neither has been
applied.** Both are tax-adjacent and need an accountant's view as much as a
product decision.

### CANDIDATE-002 — validate the PIB check digit (ISO 7064 MOD 11,10)

**Found by:** both the driver and the navigator independently, which is the
strongest signal the pairing produces.

**What the tests assert.** `test/unit/extract-validate.test.ts:248-249` keeps two
PIBs on shape alone:

```
['nine zeros — the shape is validated, the taxpayer is not', '000000000'],
['nine repeated digits — no checksum rule is specified',     '111111111'],
```

**Why the assertion may be wrong.** Serbian PIB carries an ISO 7064 MOD 11,10
check digit. Verified against real data from this project:

| PIB | Source | Checksum |
|---|---|---|
| `104052135` | NIS, seller on the F4 receipt | valid |
| `111886391` | DILIGAF, buyer on the same receipt | valid |
| `111111111` | pinned as kept | **invalid** |
| `000000000` | pinned as kept | **invalid** |
| `104052134` | one digit misread | **invalid** |

Both real PIBs validate; both pinned fakes are numbers that cannot exist. The
test's own comment — *"no checksum rule is specified"* — reads as a spec gap the
author noticed rather than a decision that checksums are unwanted.

**Why it matters more now.** Spike S-QR downgraded layer 1's expected hit rate,
so OCR carries more of the load, and a misread digit is OCR's characteristic
failure — the last row of that table. The PIB is also *identity* for vendor
profiles (`01-ARCHITECTURE.md` §5), so a one-digit misread silently creates or
contaminates a vendor profile.

**Counter-argument to weigh.** The current comment says "the shape is validated,
the taxpayer is not." A check digit does not assert the taxpayer exists — it is a
stronger shape rule — so this reads as a distinction without a difference. But it
does mean the validator starts refusing values that a tax authority might, in
some edge case, actually have issued.

**Blast radius if applied:** two assertions at `:248-249`, plus any fixture using
a made-up PIB. `'1234567890'` at `:893` is 10 digits and already rejected.

### CANDIDATE-003 — a rate-aware VAT ceiling

**Found by:** the navigator.

**What the tests assert.** `:568` keeps `vatAmount === amountTotal`, with the
explicit note *"the rule is at most"*. The only constraint is `vat <= total`.

**Why the assertion may be wrong.** On the real F4 receipt, VAT `1304.25` on a
total of `7825.48` is 16.67% — exactly 20% on the net, the standard Serbian rate.
The rule as frozen would wave through a VAT of `7000.00` on that same total. A
rate-aware ceiling (`vat <= total × 20/120` plus a rounding tolerance, with the
10% reduced rate and 0% exempt cases below it) catches a misread decimal that
still lands under the total — the failure mode the current rule cannot see.

**Why this is harder than it looks.** It requires the validator to know which
rates are legal, which is tax knowledge that changes by statute rather than by
code. It would also need to accommodate multi-rate receipts, exempt supplies, and
foreign invoices carrying no Serbian VAT at all. That may be the argument for
leaving it where it is: this module is a shape gate, and rate arithmetic may
belong in a dedicated reconciliation step.

**Blast radius if applied:** `:568` at minimum, plus any test using a VAT that is
legal under `<= total` but illegal under a rate rule.

### CANDIDATE-004 — a deterministic *refusal* is indistinguishable from an absence

**Found by:** the navigator, during the `nlu` pairing, 2026-08-15. **Verified empirically.**
**This is the most consequential item in this file.** It is a silent-money path.

**What happens today.** `extractSlots('MATERIALS 300e 400e')` returns `money: null`
with both tokens in `leftoverTokens` — the grammar saw two candidate amounts and
deliberately refused to choose between them (`nlu.test.ts:176-184`). But `null` is
also what it returns when there is simply no amount (`:164-166`). `interpret`
receives only `Slots`, cannot tell the two apart, and treats the refusal as a gap
the model may fill — with **no conflict recorded**. `decide` ignores provenance.
Measured end to end:

```
'MATERIALS 300e 400e' + model {money:{amount:350,currency:'EUR'}, confidence:'high'}
  →  conflicts: []   →   { action: 'commit' }        // 350 EUR, no tap
```

A number the deterministic layer explicitly refused to pick is replaced by one the
model invented, and it commits silently under the book threshold.

**Why this is wrong.** `02-WHATSAPP-INTERFACE.md` §5.1 says the opposite in as many
words: *"conflicting slots (two candidate amounts, two candidate dimensions) → ask,
with both options as buttons."* The behaviour contradicts the spec, not just taste.

**Why no test catches it.** `SlotExtraction` has no channel to report *why* money is
null. The frozen suite pins the value, and the value is correct.

**Fix, and it needs NO unfreeze.** Add an optional `SlotExtraction.ambiguous?: string[]`
and an optional third parameter to `interpret(det, model, ambiguous?)`. Every frozen
call site passes two arguments and compares `slots`/`leftoverTokens` separately, so
both additions are compatible. When the model fills a slot named in `ambiguous`,
record a conflict → `decide` already returns `confirm/'conflict'`.

**Not applied.** It is an addition beyond the derived contract and deserves a ruling
rather than appearing unannounced in a diff.

### CANDIDATE-005 — the model's self-reported confidence is the commit switch

**Found by:** the navigator. **Verified:** a model answer of `confidence: 'exact'`
commits.

`interpret` passes `model.confidence` through verbatim whenever any model field is
used (`nlu.test.ts:746-752`), and `decide` commits on `exact` and `high`
(`:926-933`) while ignoring `sources` entirely (`:823-828`). So a model that
hallucinates an amount *and* reports high confidence gets a silent commit under the
threshold.

The two obvious guards — clamp a model-sourced confidence to at most `high`, or
require a tap whenever *money* is model-sourced — are both **forbidden by `:823-828`
as frozen**, which asserts that model-sourced money at high confidence commits.
Hence this is an unfreeze candidate, not a hardening.

### CANDIDATE-006 — `confirmAboveAmount` is currency-blind

Pinned in both directions (`nlu.test.ts:905-922`): 1200 RSD trips a 1000 threshold,
and 200 EUR commits under a 50000 threshold on an RSD book. So a book with a 500
threshold treats 400 RSD, 400 EUR and 400 USD identically — a spread of roughly
117×. Same defect class as the `amountTotal` ceiling noted under UNFREEZE-001, and
it wants the same decision.

### Related — `interpret` cannot validate a model axis against the book

**Verified:** a model may invent `dimensions.material = 'NOT_IN_THE_SET'`, a value
absent from the axis's `closed_set`, and because it satisfies a **required** axis the
decision flips from `ask` to `commit`.

`interpret` takes no `axes` parameter, so it *cannot* check the value. This is the
model picking a branch in the plainest sense, which `02 §5.1` forbids. Needs no
unfreeze — the caller should validate model dimensions against `book.dimensions`
before calling `interpret`, or `interpret` gains a fourth parameter. Recorded here
so the fix lands deliberately.

### CANDIDATE-007 — an exported declared-value validator

**Found by:** the navigator, `dimensions` pairing, 2026-08-15. **Additive — needs no unfreeze.**

`missingRequiredAxes` answers *presence*, not *validity*, and this is pinned deliberately:
`dimensions.test.ts:705-713` requires `missingRequiredAxes({category:'BANANAS'}, SMOQUA_AXES)`
to return `[]`. `BANANAS` is not a declared value on that axis, yet the required axis counts as
satisfied. Do **not** weaken that function — `:709` forbids it.

This is the same hole recorded below under *"`interpret` cannot validate a model axis"*, and
`dimensions.ts` is its natural home. The fix is a **new export** — `isDeclaredValue(axis, value)`
or `validateDimensionValues(values, axes)` — called by the use-case layer before `interpret`, so
a model-invented value can no longer satisfy a required axis and flip `ask` into `commit`.

---

## Dimension hazards — recorded, no action taken

Found during the `dimensions` pairing, 2026-08-15. None is a test failure; all are verified.

**H1 — `OTHER` is reachable by fuzzy match.** Verified: `resolveDimensions(['OTHE'], …)` resolves
to `category: 'OTHER'`, method `fuzzy`, at edit distance 1. `05-SMOQUA.md` §2 says *"Unknown →
buttons, never a silent `OTHER`"*. The tests pin `OTHER` on an **exact** hit (`:129-134`) and pin
that *unknown* words never become `OTHER` (`:318-337`), but nothing forbids a near-miss of the
literal word. Arguably correct — a typo of `OTHER` is intent, and special-casing a magic value
name inside a generic resolver is undeclared behaviour — but it is a seam in a stated guarantee
and wants a ruling either way.

**H2 — a mistyped category becomes a project, permanently.** Verified:
`resolveDimensions(['MATERIC'], …)` → `project: 'MATERIC'`. `MATERIC` is edit distance 3 from
`MATERIALS`, so it is correctly refused as a category (`:274-279`); it is then the lone leftover,
so the `open_text` axis claims it (`:476-484`). Both behaviours are pinned, so this is forced.

Harmless for the books — `category` stays missing, so E asks (`:918-922`) — but `recentAxisValues`
never forgets, so the typo joins the project button list forever. Mitigation is caller-side only:
do not write a project value to history when the same message left a required axis unresolved.

**H3 — short aliases are category magnets.** With a three-letter alias such as `MAT` for
`MATERIALS`, the following all resolve to MATERIALS at edit distance 1: `MAJ` (May), `MART`
(March), `RAT`, `ROB`, `RIBA`, `SOBA`. Under an absolute budget of 2, `RATA` (installment),
`VODA` (water) and `MAPA` join them. The length-relative budget both modules adopted
(`min(2, ⌊len/3⌋)`) removes the second group but **not the first** — no code change can, short of
exact-only matching below four characters.

**This is a data problem, not a code problem**, and it lands squarely on **Q10** (SMOQUA dimension
axes, still open). When those axes are defined: avoid aliases shorter than four characters, or
accept that common short Serbian words will be silently filed as that category.

**H4 — a required axis with an unsafe name is silently unenforced.** Axis names arrive from
`_state/books.json`, so `__proto__`, `constructor` and `prototype` are reachable input. Both
`dimensions.ts` and `nlu/slots.ts` drop such axes entirely, which is the right call against
prototype pollution — but it means a required axis so named is never reported missing. Verified:
`missingRequiredAxes({}, [{axis:'constructor', required:true, …}])` returns `[]`. Nobody will name
an axis `constructor`; recorded for completeness.

### CANDIDATE-008 — the vendor-profile learning loop cannot actually learn

**Found by:** the driver, `extract-ladder` pairing, 2026-08-16. **Additive — needs no unfreeze.**
**Consequence: layer 2 of the extraction ladder never fires from a user correction.**

`01-ARCHITECTURE.md` §5 describes vendor profiles as learning *which extractor field* proved
correct for a vendor, so a repeat document from the same supplier is read cheaply by
`applyProfile` instead of going to Document Intelligence or the LLM. That is the whole economic
case for layer 2.

But `learnFromCorrection(profile, before, after, at)` is never handed the raw candidate map. It
sees only the facts before and after the human's edit, so it **cannot know which atomic source
label was right**. The only honest value it can record is a placeholder — the implementation uses
`'manual'`.

`applyProfile` then resolves a field with a single flat lookup, `raw[profile.trust[field]]` —
i.e. `raw['manual']`. No real Document Intelligence or QR candidate map contains that key, so the
lookup misses and the profile contributes nothing. Verified: an unrecognised trust label yields
`null` for that field.

**Not a defect in the code.** The frozen signature makes any other choice impossible, and
inventing a label would be worse than admitting ignorance. The gap is between the architecture's
intent and the contract as frozen.

**Fix, additive:** the correction path must carry the raw candidates through — either a fifth
parameter on `learnFromCorrection`, or a separate `learnFromExtraction(profile, raw, chosenFacts)`
called at the point where an extraction is accepted rather than where a human edits it. The
second is probably right: the moment a rung's answer is confirmed is when the label is known.

**Until then:** profiles will accumulate `corrections` counts and hints, but the `trust` map will
not usefully route anything. Any measurement of "how often layer 2 fires" will read zero, and that
should not be mistaken for the ladder working correctly.

---

### Decision needed — `mail/route.ts` is the first engine module to import a Node builtin

**Raised by:** the driver, `mail-route` pairing, 2026-08-16. Flagged rather than decided, correctly.

`mailEventKey` needs a collision-resistant hash, and its frozen signature —
`mailEventKey(messageId, attachmentIndex)` — has no slot to inject one. The driver imported
`createHash` from `node:crypto`. It is the **only `node:` import in all of `src/engine/**`**.

**Why this is a real inconsistency, not a nitpick.** The two sibling modules that hash both take the
hash as a parameter:

```
documents/fingerprint.ts   fingerprint(bytes, sha256: (b: Uint8Array) => string)
ledger/normalize.ts        dedupeKey(book, raw, hash: (s: string) => string)
```

Injection is the established convention here, and `01-ARCHITECTURE.md` §4 states the engine is
"PURE — no fetch, no fs, no env, no clock, no randomness." `createHash` violates none of those
literally: it is deterministic, does no I/O, reads no clock and generates no randomness. What it does
break is **runtime-agnosticism** — the engine can no longer run anywhere without a Node-compatible
`crypto`. Today that costs nothing (Azure Functions is Node, and so is the M9 MCP server).

**The tests do not force it.** No frozen case pins a hash value; they pin determinism, distinctness
across a 150-key grid, the `[A-Za-z0-9_-]+:index` shape, and that the id is hashed rather than
embedded. Any collision-resistant hash satisfies them.

**Three options:**
1. **Keep it.** Simplest, and the purity rule's *intent* is not violated. Accept that the engine now
   requires a Node-compatible `crypto`, and write that down in §4 so it stops being an accident.
2. **Add an optional third parameter** — `mailEventKey(messageId, index, hash?)` — defaulting to the
   current implementation. Freeze-compatible (every frozen call site passes two arguments), restores
   the injection convention, and lets a non-Node host supply its own. **My recommendation.**
3. Hand-roll a hash in pure JS. **Do not.** A 32-bit hash has real collision probability across a few
   thousand message ids, and a collision here makes E treat an unprocessed attachment as already
   done — it silently drops mail. The tests would not catch it; their largest grid is 150 keys.

Related: the eslint engine-purity rule currently bans only `adapters/` imports. A
`no-restricted-imports` entry for `node:*` would have surfaced this at review time instead of in a
report. Cheap to add whenever option 1 or 2 is chosen.

### CANDIDATE-011 — the ambiguity meta-rule hands the decision to the guesser

**Found by:** the navigator, `ledger-categorize` pairing, 2026-08-16. **Verified.**
**Pinned by the frozen suite** (`ledger-categorize.test.ts:496-508`), so the fix belongs in the caller.

When a vendor has resolved to two different categories in history, `vendorIsAmbiguous` fires and
categorization **suppresses the rule rung** — E stops guessing from vendor rules. Correct, and it is
the whole point of the meta-rule.

But it suppresses *only* that rung. The model rung is untouched. Measured:

```
history: MAXI → HRANA, MAXI → DECA        (ambiguous)
model:   { category: 'HRANA', confidence: 'high' }
result:  { category:'HRANA', source:'model', confidence:'high', ambiguousVendor:true }
```

So detecting that a vendor is ambiguous **increases** the share of that vendor's transactions decided
by the model, because it removes the deterministic competitor and leaves the guesser in place.
`04-PERSONAL.md` §3 says E should drop to line items *"or ask"*; the frozen suite implements "drop to
line items", and where there are none it asks the model instead of asking you.

**Mitigation, freeze-compatible and caller-side:** the ingest use case should set
`reviewStatus: 'needs_review'` whenever `source === 'model' && ambiguousVendor`. That is outside the
frozen surface entirely — no unfreeze, no change to `categorize`. Recorded rather than applied
because nothing in `src/` calls `categorize` yet.

### CANDIDATE-012 — a mixed basket is filed whole, and no split is ever offered

**Found by:** both agents independently, `ledger-categorize` pairing, 2026-08-16.
**Pinned** (`:391-401`). This is CANDIDATE-004's exact anatomy, with the model's win mandated.

The item rung deliberately **abstains** when line items resolve to more than one category — the test
file's own note says *"the one thing the item rung must not do is pick a side."* But `CategorizeResult`
has four fields and none can express *"the items disagreed."* So the abstention is indistinguishable
from "no items matched", and the model rung fills it. A mixed basket returns
`{category:'HRANA', source:'model'}` — byte-identical to a cryptic descriptor the model guessed at.

`04-PERSONAL.md` §3, `01-ARCHITECTURE.md` §5.1 and D16 all name the mixed basket as **precisely when a
split should be offered**. `ledger/split.ts` exists and is green. Nothing connects them.

**Freeze-compatible fix:** add `splitCandidates?: string[]` to `CategorizeResult`, populated **only**
when the item rung abstained. Two frozen assertions lock the result shape with `toEqual`
(`:286-291`, `:640-645`), and `toEqual` ignores `undefined`-valued keys — so an optional field left
`undefined` on every other path is compatible. A non-optional `[]` would break both.

### Related — a rule's category is never checked against the vocabulary

The model rung enforces exact membership in `allowedCategories` (verified in four directions,
including against an empty list). **The rule rung enforces nothing.** Rules live in `_state`, which
`/tebra` can propose edits to, so a model-authored *rule* can write any string into
`Transaction.category` — bypassing the check a model-authored *proposal* cannot. This is CANDIDATE-007's
vocabulary hole reappearing one rung up. Validate at the `_state` load boundary, not inside
`categorize`, where it would risk the frozen fixtures.

### Related — rules are not filtered by book, and cannot be

`categorize` receives no book: neither `CategorizeInput` nor `CategorizeContext` carries one. So an
unfiltered `_state` load applies PERSONAL rules to DILIGAF transactions. Entirely caller-side,
entirely untested, and the widest "one correction over-generalises" path in the module.

### Minor — category values are case-folded when counting ambiguity

`vendorCategories` upper-cases category names, so `'hrana'` and `'HRANA'` count as one category and
the vendor reads as unambiguous — rules keep auto-applying. The conservative direction would be not to
fold, so a casing inconsistency reads as ambiguous and suppresses the rules. Only reachable through a
hand-edited `_state` categories list; noted, not changed.

### CANDIDATE-010 — a stored regex rule can stall the engine for a minute per transaction

**Found by:** the driver flagged the surface; **measured by the reconciliation**, `ledger-categorize`
pairing, 2026-08-16. **Additive — no unfreeze.** **Highest severity in this file.**

`rules.ts` compiles `matchType: 'regex'` patterns with `new RegExp(pattern)`. Malformed patterns are
caught and treated as non-matching, so nothing throws — but a *well-formed pathological* pattern is
compiled and run. Measured, not estimated:

```
rule    { matchType: 'regex', pattern: '(a+)+$' }
input   41 characters
result  MISC — after 54,949 ms
```

Catastrophic backtracking. One transaction, one rule, fifty-five seconds. The cost is exponential in
input length, so a longer description is worse without limit.

**Why this is not the "low severity, only if rules become user-editable" case it looks like.**
Rules live in `_state`, and `09-TEBRA.md` §3 gives `/tebra` the ability to **propose edits to state** —
the same channel that made trust labels a security boundary in `vendor-profile.ts`. So a pathological
pattern is reachable from **model-authored** content, not only from a human editing JSON by hand.

**Blast radius.** Categorization runs per transaction, against every rule. A month of statement lines
against one bad rule is minutes-to-hours of CPU inside an Azure Function that has a timeout — so the
monthly package silently never completes, and `/tebra` queries against that book hang. It is a denial
of service on the reporting path, triggerable by a rule the model proposed.

**Options, cheapest first:**
1. **Refuse `matchType: 'regex'` from learned/proposed rules entirely.** The learning loop only ever
   emits `contains` (`deriveRule`), so this costs nothing today and closes the model-authored path
   completely. Hand-written regex rules stay legal.
2. **Bound the input** handed to a regex test (descriptions are short; a 200-char cap makes the worst
   case tolerable) and **cap pattern length**.
3. **Reject structurally dangerous patterns** — nested quantifiers such as `(x+)+`, `(x*)*`,
   `(x|x)*`. Cheap static check, catches the classic shapes, not exhaustive.
4. A linear-time engine (RE2-style). Correct and complete, but a new dependency and therefore an
   architectural decision.

**Recommended: 1 + 2 together.** They are a few lines each, need no unfreeze (no frozen case uses a
pathological pattern), and between them remove both the model-authored path and the worst case for
hand-written rules.

**Not applied** — refusing a `matchType` is a semantic change to what a rule may be, and that is the
owner's call.

### CANDIDATE-009 — re-adding an already-split transaction doubles the money

**Found by:** the driver, `ledger-core` pairing, 2026-08-16. **Verified.** **Additive — no unfreeze.**

```
add(s1, -100)  →  split(s1 into -60 / -40)  →  add(s1, -100)
   fold() = 3 rows, total -200        (the charge was -100)
```

`split` removes the original and inserts the parts; a later `add` for the same id resurrects the
original alongside its own parts. Both behaviours are individually correct and individually
pinned — `add` must be a wholesale upsert (a re-ingest with a corrected amount has to win), and
`split` must remove the original (no surviving parent is asserted). Nothing in the frozen suite
composes them.

**Reachability is genuinely low, and one existing design choice is why.** `invert(split)` returns
`null`, so undo cannot produce the sequence. And split parts deliberately **inherit the parent's
`dedupeKey`**, so a re-imported statement line finds its key already present among the parts and
never emits a second `add`. That inheritance looks like an oddity and is in fact the protection.

**But it is not a guarantee.** Any writer that emits an `add` for a split transaction for some
other reason — a manual re-ingest, a repair script, a future source with a different dedupe path
— doubles the charge with no error and no review flag.

**Fix — a semantic decision, which is why it is recorded rather than applied:** either (a) `add`
on an id that currently exists only as split parts removes the parts first, or (b) `fold` records
that an id was split and refuses a later bare `add` for it, or (c) the invariant is declared
ingest-side and enforced there. (a) is the smallest and matches "add is an upsert"; (b) changes
what a split means; (c) leaves `fold` able to be corrupted by a bad writer, which is the thing
this module otherwise refuses to allow.

## Hardenings APPLIED — no unfreeze needed, recorded so the reasoning survives

**2026-08-16, `vendor-profile.ts` — "restated" is not "corrected".** Two silent-corruption
paths, both found by the navigator, both verified before and after the fix, both invisible to
the frozen suite (every candidate policy passes all 178 cases).

`learnFromCorrection` adopted whatever `after` **stated**, rather than what the correction
**taught**. A user who corrects only the amount leaves every other field sitting in `after`
exactly as the extractor misread it. Measured before the fix:

- A misread `EUR` left untouched flipped `hints.currencyDefault` from `RSD` to `EUR`
  **permanently**, so `applyProfile` stamped EUR on every later document from that vendor —
  feeding `DocumentFacts.amountRsd` and converting at the wrong currency, silently.
- A wrong PIB left untouched overwrote the profile's canonical `vendorPib`. That matters more
  than it looks: a fiscal receipt carries both the seller's and the buyer's PIB (see the note
  below), so this is how a vendor profile silently acquires DILIGAF's own PIB.

Fixed by applying the module's existing epistemology — the same "changed, and not cleared"
condition that already governs which fields earn a `trust` entry — to the identity fields and
hints, via a shared `learnedValue()` helper so the two rules cannot drift apart. A brand-new
profile still takes whatever identity is stated, since it has no prior knowledge to protect.

Verified after: a genuinely corrected currency and a genuinely corrected PIB are both still
learned, the vendor key still never moves, and the frozen suite is unchanged at 178/178.

## Related, needing no unfreeze

Recorded here only so they are not lost when this file is reviewed.

- **`amountNet` has no rule at all.** `NaN`, negatives, and `999_999_999` all pass
  and are never named in `rejected`. The tests pin only finite values, so a
  finiteness-and-sign guard is **freeze-compatible today** — no unfreeze needed.
  Not applied; awaiting a decision.
- **Nothing distinguishes seller PIB from buyer PIB.** The F4 receipt carries
  both, both 9 digits. If an extractor grabs the buyer's, this module certifies
  it and the document is filed with DILIGAF as its own vendor. The fix belongs in
  `extract/fiscal-receipt-regex.ts` and `di-map.ts` (label-anchored capture), not
  here.
- **A valid amount with a null currency is `ok`.** Deliberate, so the number is
  not lost — but a bare number reaches the sidecar with no unit, and
  `DocumentFacts.amountRsd` has nothing to convert from.
