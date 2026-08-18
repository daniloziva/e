# 10 — LCY: staff review before code

Reviewing `10-LCY.md` (authority), the two drafts (evidence), `e-app/TEST-FREEZE.md` (binding) and
`01-ARCHITECTURE.md` §3/§4/§9. **Nothing in the real tree was modified** — `git diff -- e-app` is
empty. Every number below came from a command run against a private copy at
`…/scratchpad/lcy-review/`, where the whole change was implemented and the whole new suite written.
Anything I did not run is labelled **UNVERIFIED**.

**Method.** Four trees: `base-app` (pristine), `e-app` (LCY implemented, 7 fixtures repaired, new
suite added), `variant-noguards` (the recommended shape), `mut` (19 mutants, each `diff`-verified to
have landed before running).

---

## 0. Headline

| | measured |
|---|---|
| files changed under `src/engine/**` | **5** (1 new, 4 edited) |
| files created outside `engine/` | **9**, in three layers that do not exist yet |
| compile breaks | **8** — 1 in `src/`, **7 test sites in 6 files**. Exact list in §2 |
| frozen assertions changed | **0**. Independently reproduced, not taken on trust |
| new test files | 3, **111 cases** |
| mutants killed | **19 / 19** |
| coverage verdict | the 44-branch margin holds (**→ 47**, or **54** in the recommended shape). **But branches were never the binding gate — statements/lines at 95% is, and it comes within 6 of red** |
| blocking underspecifications in `10-LCY.md` | **5** (§5) |

---

## 1. Blast radius — `src/engine/**`

### 1.1 The five files that change

| File | Change | Why |
|---|---|---|
| `src/engine/types.ts:88`, `:107` | `rate: number \| null` · `rateDate: string \| null` on `DocumentFacts` and `Transaction`. 4 lines | §1. **This is the whole compile blast radius** — see §2 |
| `src/engine/rates.ts` | **NEW**, pure. 10 exports, 103 statements, 68 branches | R1: Table Storage has no descending sort, so at-or-before selection is a choice, and a choice belongs where the coverage gate can see it |
| `src/engine/nlu/confirm-policy.ts:6`, `:49`, `:62-69` | `'no_rate'` added to the `reason` union; `decide` gains a third parameter; the 5-line comment at `:62-66` becomes **false** and must be rewritten, not left | §3 + C1. The comment currently asserts the bug is deliberate |
| `src/engine/ledger/normalize.ts:186-193`, `:246-249` | `toTransaction` gains a 6th parameter `resolved: ResolvedRate \| null = null`; `amountRsd` routes through `toRsd`; `rate`/`rateDate` stamped | §1. RSD ⇒ `rate: 1, rateDate: txDate`; foreign ⇒ the resolved pair or nulls |
| `src/engine/ledger/fold.ts:12`, `:97`, `:181`, `:363`, `:415` | `set_rate` added to `LedgerEvent`; `readTransaction` validates `rate` as strictly as `amount`; one `normalizeEvent` case; one apply arm; `invert` returns `null` | C3: `set_rate` survives the withdrawn backfill because event blobs are immutable and a repair has no other expression |

### 1.2 Files that do **not** change — checked, because it is not obvious

- **`src/engine/money.ts` — zero changes.** `toRsd` (`:294-298`) already takes the rate explicitly
  and already `round2`s the product once. Verified by running the full LCY change against it.
  *(v8 reports money.ts gaining 4 branches, 130 → 134, with no edit. That is an instrumentation
  artifact of new call sites, not a code change — noted because it means the branch **denominator**
  is not a stable quantity and a margin computed to ±5 is over-precise.)*
- **`src/engine/packaging/manifest.ts` — do not touch.** `CSV_COLUMNS` at `:365` is 8 columns and
  carries no rate. Adding one changes the goldens in `packaging.test.ts` (frozen, 230 cases) and
  would need an `UNFREEZE:` commit. The accountant's CSV getting a rate column is a separate,
  ruled decision — not a side effect of LCY.
- **`src/engine/tebra/aggregate.ts`** — `field: 'amountRsd'` and `checkField` (`:226-231`) need
  nothing. C4 stands: the grand-total pooling still has to be fixed at M4.5.
- **`src/engine/invoicing/invoice-template.ts:90`** — already takes `exchangeRate` as an argument.
  Leave it. Unifying it with `resolveRate` is a follow-up, not this change.
- **`src/engine/extract/validate.ts`** — the currency-blind `amountTotal` ceiling (`:239-241`) is
  draft-model §3.3's third candidate. Out of scope; do not bundle.

### 1.3 The layers that do not exist yet — LCY sets the pattern

`src/` is engine-only today and `package.json` has **zero runtime dependencies**. Nine new files:

```
src/adapters/nbs/client.ts        I/O only. URL, fetch, AbortSignal, returns a string.
src/adapters/nbs/rate-page.ts     HTML string -> RawRateRow[]. DOM selection ONLY here.
src/adapters/store/rate-store.ts  Table Storage. get / getRange / insertIfAbsent.
src/app/refresh-rates.ts          the timer's one call.
src/app/resolve-rate.ts           the read path ingest and WhatsApp share.
src/functions/rates-timer.ts      thin binding.
src/lib/env.ts                    does not exist. CLAUDE.md requires it. See §5-B4.
e-app/.env.example                does not exist. No .env* of any kind is present.
test/fakes/rate-store.ts          in-memory, insert-only, seeded EUR 117.5 / USD 101.
```

Note `01-ARCHITECTURE.md` §4 draws this tree as `function-app/src/…`; the real repo is
`e-app/src/…`. Follow the repo, not the diagram, and the diagram should be corrected separately.

**`.github/workflows/ci.yml:133-143`** holds a disabled `contract` job (`if: false`) waiting on
Azurite. Activating it is the honest home for the `rate-store` contract tests — and `.github/**` is
a named high-blast-radius file in `CLAUDE.md`, so it gets its own commit and is named before being
touched. Azurite's table-storage support is assumed by the pipeline draft and **UNVERIFIED** here
(no network in this container).

### 1.4 Spec files needing a follow-up edit — not in this change

`05-SMOQUA.md:130` and `07-ROADMAP.md:589` both still say *rate failure → null + `needs_review`*,
which R3 supersedes. `01-ARCHITECTURE.md`'s sidecar sample (~`:160`) needs `rate` and `rate_date`
(snake_case there, unlike the engine). `01-ARCHITECTURE.md` §10's dependency table has no row for
the HTML parser §6 approves. `test/fixtures/README.md` needs F12–F14.

---

## 2. Compile breaks — enumerated, not estimated

Applied the type change alone and ran `npx tsc --noEmit`. **8 errors, and `tsc` names all of them.**

| # | `file:line` | What it is | Frozen? | Repair |
|---|---|---|---|---|
| 1 | `src/engine/ledger/normalize.ts:237` | `toTransaction`'s return literal | src | the real implementation (§1.1) |
| 2 | `test/unit/tebra.test.ts:75` | `tx()` builder | **FROZEN** | `+2 lines` |
| 3 | `test/unit/tebra.test.ts:97` | `doc()` builder | **FROZEN** | `+2 lines` |
| 4 | `test/unit/packaging.test.ts:85` | `BASE_DOC` | **FROZEN** | `+2 lines` |
| 5 | `test/unit/ledger-core.test.ts:69` | `makeTx()` | **FROZEN** | `+2 lines` |
| 6 | `test/unit/ledger-categorize.test.ts:87` | `tx()` builder | **FROZEN** | `+2 lines` |
| 7 | `test/unit/fold-guards.test.ts:24` | `tx()` builder | post-freeze | `+2 lines` |
| 8 | `test/unit/packaging-guards.test.ts:49` | `BASE_DOC` | post-freeze | `+2 lines` |

**draft-model §2.1's list is correct**, with one line-number correction: the `tebra.test.ts` `doc()`
literal is at **`:97`**, not `:99`. The brief's concern that three newly-landed files would change
the count is measured and does **not** hold: `packaging-guards` and `fold-guards` are already in
that list, and **`documents-guards.test.ts` and `mail-guards.test.ts` reference neither
`Transaction` nor `DocumentFacts` at all** (`grep -c` = 0 in both). Nor do the other twelve unit
files. The count is 7 test sites in 6 files, and the *set* is unchanged.

**Freeze legality.** Sites 2–6 are in five of the fourteen frozen files
(`TEST-FREEZE.md:29-32`, baseline table `:195-203`). All five are `TEST-FREEZE.md:26` — *"fixing a
test that cannot compile"* — in the **Allowed while frozen** column, so **no ruling is needed for
any of them**. Sites 7–8 are post-freeze additions and are editable outright, but each was written
to kill a specific mutant, so the edit must be additive only.

**Default the new keys to `null`, not `1`,** in all six builders. Measured: with `null`,
`3132 / 3132` stay green with no behaviour change. `rate: 1` would also make
`tebra.test.ts:154` (`currency: 'EUR', amountRsd: -11700`) internally incoherent.

**Measured, in this order:**

```
types.ts change alone                          8 errors  (1 src, 7 test)
+ the real src/ implementation                 7 errors  (normalize.ts:237 resolved by it)
+ 7 × 2-line fixture repairs                   0 errors  ·  Tests 3132 passed (3132)
```

### 2.1 Zero unfreezes — reproduced, not taken on trust

C2's conclusion holds. I re-derived it the hard way: with LCY fully implemented, I reverted the
threshold comparison to the raw amount and ran **only the fourteen frozen files**:

```
Test Files  14 passed (14)
     Tests  2772 passed (2772)
```

**The ~117× hole is invisible to the entire frozen suite.** Six of the seven threshold cases are
currency-matched, the seventh sits below its threshold either way. Only the new
`confirm-rate-guards.test.ts` sees it (6 failures).

**One correction to C2.** It says *"nothing in the codebase switches on `Decision.reason`."* Nothing
switches, but two frozen assertions **whitelist** it: `nlu.test.ts:1025` and `:1031` assert
`toContain(['conflict','large_amount'])` and `(['low_confidence','large_amount'])`. Those pass only
because `no_rate` never outranks `conflict` or `low_confidence`. The conclusion is unchanged; the
precedence is now load-bearing and is pinned by three new cases.

---

## 3. Coverage — the gate, and which one actually binds

`ci.yml:92-97` runs `pnpm coverage` with `continue-on-error: false`; `vitest.config.ts` gates
**95 lines / 90 branches / 95 functions / 95 statements** over `src/engine/**`.

**Baseline, reproduced exactly** (`base-app`, pristine `types.ts`):

| | covered / total | % | uncovered | allowance | margin |
|---|---|---|---|---|---|
| branches | 1742 / 1886 | 92.3648 | 144 | 188 | **44** ✔ matches `ci.yml:86` |
| statements | 3162 / 3201 | 98.7816 | 39 | 160 | 121 |
| functions | 262 / 262 | 100 | 0 | 13 | 13 |

**LCY adds 105 real branches to `engine/`** (+7 more if the defensive guards of §4.4 are kept):
`rates.ts` 68, `fold.ts` +17, `normalize.ts` +10, `confirm-policy.ts` +6, plus the 4-branch v8
denominator artifact in `money.ts`.

**Verdict: 44 branches absorbs it, comfortably — but branches were never the risk.**

| scenario | branches | margin | statements | margin | verdict |
|---|---|---|---|---|---|
| baseline | 92.36% | 44 | 98.78% | 121 | green |
| LCY, **no new tests** | 91.92% | 36 | **95.21%** | **6** | green by 6 statements |
| LCY + the 111-case suite | 92.39% | **47** | 98.83% | 127 | green, margin *improves* |
| + guards of §4.4 removed | **92.72%** | **54** | 98.82% | 127 | green, and `pnpm lint` goes 21 errors → 0 |

The binding constraint is **statements/lines at 95%**, not branches at 90%. An entirely untested
`rates.ts` is 103 uncovered statements and burns 115 of the 121-statement margin on its own. The
general rule, derived from the arithmetic: a new engine file of `M` statements at coverage `c`
survives only while `M(0.95 − c) ≤ 121`, so **~127 statements of wholly untested engine code is the
hard ceiling**, against `rates.ts`'s 103. There is no room for a second untested module.

**Functions is the sleeper.** 262/262 today, so the allowance is 13 uncovered functions in total.
`rates.ts` exports 10. A new adapter-shaped engine file with a dozen unexercised helpers puts
functions red before either other gate notices.

Coverage `include` is `src/engine/**`, so **`adapters/nbs/rate-page.ts` is not gated at all** — the
fragile half is the ungated half. That is the argument for the L2 fixture test in §4.1 being
non-optional even though CI will not enforce it.

**draft-model §2.5 is stale**: it quotes 89.04% branches from `UNFREEZE-LOG.md:276-283`. The
measured figure is 92.36%. Its instruction — *every new branch needs a test in the same commit* —
is right for the wrong reason, and right about the wrong metric.

---

## 4. The new test suite

Three new files, **111 cases**, all `*-guards.test.ts` per the established additive convention.
Written and run: `Tests 3243 passed (3243)`, `tsc` clean, `eslint` clean, `tsc -p
tsconfig.build.json` clean.

| File | Cases | Owns |
|---|---|---|
| `test/unit/rates-guards.test.ts` | **65** | `parseSerbianRate`, `parseNbsDate`, `toQuotes` (unit division, allowlist), `selectRate`, the flag/bound split, `resolveRate`, `toBookCurrency` |
| `test/unit/confirm-rate-guards.test.ts` | **17** | CANDIDATE-006 and its siblings; `no_rate`; reason precedence |
| `test/unit/ledger-rate-guards.test.ts` | **29** | `toTransaction`'s 6th parameter; the `set_rate` op end to end |

Every case below was chosen so that a plausible wrong implementation gives a **different** answer.
Where a case cannot do that, it is not in the suite.

### 4.1 `confirm-rate-guards.test.ts` — the tests nobody wrote

The cases compose `resolveRate` → `toBookCurrency` → `decide` rather than asserting a hand-computed
constant, so a mutant anywhere in the chain surfaces here.

| Case | Answer | Catches what nothing else does |
|---|---|---|
| **400 EUR / 500 threshold / RSD book** | `confirm` | the entire ~117× hole. Pre-LCY: `commit`. This is the one case in the project that separates the fix from the bug |
| **50,000 RSD / 500 / EUR book** | `commit` | the inverse direction. 425.53 EUR. Pre-LCY: `confirm`. **Without this the guard can silently invert** — a multiply-instead-of-divide passes the row above and fails only here |
| 60,000 RSD / 500 / EUR book | `confirm` | same answer as pre-LCY, so it proves the fix did not disable the gate on that side |
| **550 USD / 500 / EUR book** | `commit` | neither currency is the other's: 55,550 RSD = 472.77 EUR. Forgetting to divide by the **book** rate confirms instead |
| 600 USD / 500 / EUR book | `confirm` | the paired direction of the above |
| 400 EUR / **47,000** / RSD book | `confirm` | `>=` at the *converted* boundary, which is a different boundary from the raw one |
| 399.99 EUR / 47,000 / RSD book | `commit` | the cent below it |
| **58,749.5 RSD / 500 / EUR book** | `commit` | 499.99574… EUR. `round2` lifts it to 500.00 and confirms. Pins "do not round before comparing" — see §5-B2 |
| 400/500 EUR, 500/500 EUR, 19999/20000 RSD, 20000/20000 RSD | as frozen | the currency-matched cases stay where the frozen suite has them |
| 1500 RSD / RSD book, **empty rate table** | `commit` | RSD never touches the store. PERSONAL is entirely RSD and the highest-volume book; a cache miss must never gate a dinar receipt |
| `amountInBookCurrency: 600`, `money.amount: 100` | `confirm` | kills a mutant that ORs the raw amount back in |
| `amountInBookCurrency: 100`, `money.amount: 600` | `commit` | the other half of that pair |
| 300 EUR, conversion `null` | `confirm / no_rate` | the reason exists and is reachable |
| **1 CHF, empty table** | `confirm / no_rate` | tiny amount, no rate: this is not committing a small amount, it is committing past a gate never evaluated |
| 300 EUR / **GBP book**, EUR-only table | `confirm / no_rate` | C1's consequence — two reads, a miss on **either** takes the tap |
| 400 EUR, arg **omitted** vs arg **`null`** | `commit` vs `confirm` | the three-state contract. See §5-B1 |
| null money · conflict · low confidence, each with `null` | `ask` / `conflict` / `low_confidence` | `no_rate` must not outrank them — what keeps `nlu.test.ts:1025/1031` green |

### 4.2 `rates-guards.test.ts` — parsing, selection, staleness

**The money-path separation, in one case, deliberately:**

```ts
expect(parseAmount('117,3510')).toBeNull()      // money.ts:87 refuses >2 decimals
expect(parseSerbianRate('117,3510')).toBe(117.351)
```

Both assertions in the same `it`, so a future "let's DRY these" turns it red rather than silently
routing rates through the receipt grammar. Same precedent as the duplicated currency table at
`money.ts:19-24`. Paired with `parseSerbianRate('117.3510') === null` — the **dot** grammar is the
receipt grammar and must stay refused. `'1,36584'` (5dp) is accepted, because NBS prints XDR at 5
and a hard-4dp regex would be a lie about the source.

**`parseNbsDate` — the case that matters is the zero-pad.** `'14.8.2026.' → '2026-08-14'`. A naive
split-and-join yields `'2026-8-14'`, and `'2026-8-9' > '2026-8-10'` lexically, so every at-or-before
comparison downstream silently inverts. One case asserts the pad; one asserts
`parseNbsDate('9.8.2026.') < parseNbsDate('10.8.2026.')`. `'31.2.2026.'` → null;
`'2026-08-14'` → null (ISO is not the wire format).

**Unit division.** The task is right that this is otherwise untestable, and the reason is the
allowlist: a real HUF row is *dropped* before the divisor runs. So the suite does both halves and
says so in the test body:

- `toQuotes([{code:'HUF', unit:'100', middleRate:'32,2833'}])` → `[]` — allowlist, dead codes never
  reach the ledger (also BEF, HRK).
- `toQuotes([{code:'EUR', unit:'100', middleRate:'32,2833'}])` → `rate: 0.322833` — the real
  measured per-100 quote with a synthetic code. **The day JPY joins `types.ts:7`, this case is the
  only thing between it and a 100× ledger error.**

The adapter test proves the `'100'` is genuinely on the page; the engine test proves the division
happens. Neither is sufficient alone.

**`selectRate`.** Exact hit preferred; `onDate '2026-08-16'` against rows on the 14th and 17th
returns the **14th** (a mutant that drops the upper bound returns the 17th); the same array
**reversed** returns the same row (kills first-match-wins); a USD row is never returned for a CHF
ask however much closer its date; all-rows-newer → null (the same-day window); empty → null; a
duplicate insert of the same dated rate is one row; **two different rates for one date → null in
both array orders** (§5-B3).

**The flag and the bound are two mechanisms, and one case proves it:**
`isRateStale('2026-08-10','2026-08-17') === true` **while**
`isRateUsableForConfirm('2026-08-10','2026-08-17') === true`. An implementation that folds the flag
into the 7-day bound returns `false` for the first and passes everything else.
`isRateUsableForConfirm('2026-08-09', …) === false` is the day past it.

**Two DST cases**, because `vitest.config.ts` runs `TZ=Europe/Belgrade` precisely to catch this:
`rateAgeInDays('2026-03-26','2026-04-02') === 7` (spring-forward: a local-time `Math.floor`
implementation computes 6.958 → **6**) and `isRateUsableForConfirm('2026-03-25','2026-04-02') ===
false` (8 days; the same broken implementation says 7 → usable).

**`resolveRate`** answers RSD from a constant against an **empty** table, and still answers `1` when
a bogus `RSD` row at 999 is present — the constant outranks the store. It carries the rate's own
date for a stale hit, never the document date.

### 4.3 `ledger-rate-guards.test.ts`

**The single most important case in the file:** `toTransaction(raw, …, {rate: 117.5, rateDate:
'2026-08-14'})` on a `txDate` of `2026-08-17` must yield `rateDate === '2026-08-14'`. A mutant that
stamps `txDate` here makes `rateDate !== txDate` unable to fire, which **silently deletes the entire
staleness mechanism** while leaving every amount correct.

Also: RSD ⇒ `rate: 1`, `rateDate: txDate`; a dinar line handed a EUR rate by mistake still books at
1; foreign with no rate stays `null/null/null`; `rate` 0 / negative / NaN ⇒ `amountRsd: null`,
matching `toRsd`'s own contract at `money.ts:296`.

**Rounding, at rates that can actually tell.** `0.15 USD × 101 = 15.149999999999999` in IEEE754 →
`15.15`, where truncation books `15.14`; `−0.15 USD → −15.15` proves half-away-from-zero on the sign
in the same breath; `0.15 EUR × 117.5 = 17.625 → 17.63`. These pin that `toTransaction` routes
through `round2` rather than doing its own arithmetic — which `money-guards.test.ts` cannot see,
because a bypass never calls `toRsd`.

**`set_rate`:** supplies and recomputes (`−300 EUR @ 117.5 → −35250`); carries a stale rate date
through; is a **no-op on a row that already has a rate** (recomputing would move a figure already
sent to the accountant); is order-independent; is idempotent when the blob is listed twice; is
dropped for rate 0 / negative / NaN / Infinity / string / missing, and for an empty or missing
`rateDate` or `ref` (9 rows); is ignored for an unknown `ref` without losing the rest of the log;
**reverts the row to unconverted when folded by a build that does not know the op** (so a rollback
past this change shows as a *missing* dinar total, never a wrong one); has no inverse; and a bad
`rate` on an `add` blob reads as `null` rather than being multiplied by. One composition case
proves `set_amount` after `set_rate` rescales at the repaired rate.

### 4.4 What must NOT be tested

**Seven defensive branches in `rates.ts` that no typed input can reach** — and keeping them is worse
than untestable, it is *red*:

```
rates.ts:45,53,69   if (typeof text !== 'string') return null      × 3
rates.ts:77         if (!Array.isArray(rows)) return []
rates.ts:80         if (row === null || typeof row !== 'object') continue
rates.ts:81         typeof row.code === 'string' ? … : ''
rates.ts:112        if (!Array.isArray(quotes)) return null
```

Measured: with them, `rates.ts` is 68/75 branches and **`pnpm eslint .` reports 21 errors** — the
`Array.isArray` guard narrows the parameter to `any[]`, and every subsequent member access trips
`@typescript-eslint/no-unsafe-member-access`. Removing all seven: `rates.ts` **100% branches**,
whole-repo margin **44 → 54**, `eslint` **exit 0**. Precedent for calling these unreachable rather
than untested: `money.ts:218` (`next === undefined`), `blob-path.ts:216` (`sha8 === undefined`),
`normalize.ts:231`, `confirm-policy.ts:34` — all four are `noUncheckedIndexedAccess` obligations
sitting uncovered in the baseline today. *(I could not find a written register of "three identified
elsewhere"; `grep noUncheckedIndexedAccess *.md e-app/*.md` returns nothing. The four above are my
own enumeration from the baseline coverage report.)*

**Where the validation belongs instead.** It is a real boundary — `rate-store.getRange()` returns
parsed Table Storage JSON, which is untrusted. Put **one** `unknown`-taking validator at that seam,
in the house style of `fold.ts`'s `readTransaction`, and test it with real junk. Then the inner
functions take typed values and carry no redundant guards. Do not sprinkle `typeof` checks down the
call chain: seven untestable branches and a red lint is what that costs.

**One more, introduced by the change:** `confirm-policy.ts:72` (`if (money === null)`) is
unreachable, because `missingSlots` already returned `ask`. It is the same unreachable condition the
pre-LCY `money !== null &&` carried, relocated. Do not write a test for it; prefer restructuring so
the nullness is not re-tested.

### 4.5 Fixture strategy

| | File | From | Must contain |
|---|---|---|---|
| **F12** | `f12-nbs-middle-rate-bydate-2026-08-17.html` | `ExchangeRate/IndexByDate?Date=17.8.2026.&ExchangeRateListTypeID=3` | all 34 rows incl. **HUF at unit 100, 32,2833**; EUR/USD/CHF/GBP; the dead codes (BEF, GRD, SKK, SIT, HRK) that must be dropped; both `<h6>` dates so *formation* and *application* are separable |
| **F13** | `f13-nbs-middle-rate-period-eur-2026-08.html` | `IndexPeriod` | at least one row where `appliesOn !== formedOn` — otherwise nothing proves the `RowKey` ruling |
| **F14** | `f14-nbs-indikativni-kurs-2026-08-17.html` | the briefed partial widget | `kurs_d`/`kurs_date` and `kurs_e`/`kurs_e_2` in one document, so the **prefix collision is a regression test and not a comment** |

All three are public data with no personal detail, so all three commit
(`e-app/test/fixtures/README.md`); three `curl`s, none of Danilo's time. F14's job is specifically
that `kurs_e_2` holds the *label* `EUR/RSD` — a fixture without it cannot fail a `startsWith`
implementation, which makes the ruling in §2 untested. Exact class-token matching only, asserted at
the adapter.

`test/fakes/rate-store.ts`: `Map<string, RateQuote>` with insert-only semantics, seeded EUR 117.5 /
USD 101 / CHF 125 / GBP 136.

### 4.6 Mutation plan — 19 run, 19 killed

Each patch was `diff`-verified to have landed before the run, and a non-matching patch aborts rather
than reporting a survivor.

| Mutant | Killed by | Failures |
|---|---|---|
| M1 `confirm-policy`: compare the raw amount again | confirm-rate-guards | 6 |
| M2 `toBookCurrency`: multiply instead of divide | confirm-rate-guards | 6 |
| M3 `selectRate`: drop the at-or-before bound | rates-guards | 3 |
| M4 `selectRate`: drop the currency filter | rates + confirm | 11 |
| M5 `toQuotes`: drop the unit division | rates-guards | 1 |
| M6 `parseNbsDate`: stop zero-padding | rates-guards | 9 |
| M7 `isRateStale`: fold the flag into the 7-day bound | rates-guards | 2 |
| M8 `resolveRate`: look RSD up in the table | rates + confirm | 10 |
| M9 `toTransaction`: stamp `txDate` as the rate date | ledger-rate-guards | 1 |
| M10 `set_rate`: replace an existing rate | ledger-rate-guards | 1 |
| M11 `readTransaction`: stop checking the rate | ledger-rate-guards | 1 |
| M12 `parseSerbianRate`: accept the dot grammar too | rates-guards | 2 |
| M13 `confirm-policy`: treat a failed conversion as an omitted one | confirm-rate-guards | 4 |
| M14 `selectRate`: pick by array order on divergence | rates-guards | 1 |
| M15 `isRateUsableForConfirm`: `<` instead of `<=` | rates-guards | 2 |
| M16 `confirm-policy`: `>` instead of `>=` | confirm-rate-guards | 5 |
| M17 `toTransaction`: truncate the product instead of `round2` | ledger-rate-guards | 4 |
| M18 `toQuotes`: key on the formation date | rates-guards | 3 |
| M19 `toQuotes`: widen the allowlist to all 34 | rates-guards | 2 |

M5, M9, M10, M11, M14 and M18 are each caught by **exactly one** case. Those six cases are
load-bearing and must not be "simplified".

---

## 5. Underspecified enough to block a coder

**B1. `decide()`'s third parameter has no signature, and omitted-vs-failed is undecided.**
C1 rules "pass the pre-converted `amountInBookCurrency`" but never says what to pass when the
conversion **failed**. If `null` means both *not asked* and *asked and could not*, then either
`no_rate` is unreachable or `nlu.test.ts:916` flips and the zero-unfreeze result is lost. Measured,
the only shape that gives both is three-state:

```ts
decide(interpretation, book, amountInBookCurrency?: number | null)
//  undefined  no conversion was asked for  -> legacy raw comparison (33 frozen call sites)
//  null       asked, and failed            -> { action:'confirm', reason:'no_rate' }
//  number     already in the book currency -> compare it
```

M13 proves the distinction is load-bearing. **Name it in the spec**; a coder who writes
`= null` as the default gets a silently unreachable `no_rate`. *Residual risk, stated plainly: the
`undefined` arm keeps the raw comparison reachable by omission, and the only production caller is
`app/handle-whatsapp-message.ts`, which does not exist yet. A required parameter would remove that
risk and is freeze-legal (all 33 sites are compile fixes, and C2 measured that none changes answer)
— but it puts 33 edits into a frozen file. I recommend the optional form plus an L3 test in
`test/app/` asserting the composition passes the third argument, because that is the only layer
where the omission is observable.*

**B2. Who rounds the converted amount, and does the comparison see it?** §3 gives
`amountInBookCurrency = amountRsd / rateOf(book.currency)` and says the engine "stays a pure
comparison" — but not whether the value is `round2`'d first. It changes answers: 58,749.5 RSD is
499.99574 EUR raw and 500.00 EUR rounded, against a 500 threshold. One line of ruling. **Recommend
no rounding before `>=`** — rounding can only manufacture a crossing the money never made.

**B3. `R4`'s divergence signal has no read-path rule.** R4 tells the *adapter* what to do on a 409.
It is silent on the engine reading two rows for one date with different rates — which is exactly the
state a broken parser leaves behind *before* the guard exists. Unspecified: pick one, or refuse.
**Recommend refuse** (→ `no_rate` → the tap), which is the house rule at `money.ts:7` and is
order-independent; picking by array order is not, and `01-ARCHITECTURE.md:283` forbids the system
changing its mind about the same input twice. M14.
*Related and smaller: §3b says a duplicate write "may be dropped **without reading** the stored
value" while R4 says read and compare. R4 is later and claims to combine, so it governs — but the
adapter contract must say which, once.*

**B4. `RATE_STALENESS_MAX_DAYS` has two homes, and one of them cannot work.** §4 rules it a constant
(`= 7`); the pipeline draft §9 lists it as an env key. `engine/` may not read env
(`01-ARCHITECTURE.md:189`, §4's purity rule), so it cannot be both. **Recommend the engine constant
is the only one.** More broadly, the five named config keys land in a project with **no `.env*` file
and no `src/lib/env.ts`**, and `CLAUDE.md` requires both plus zod validation. **zod is a new runtime
dependency and therefore an architectural decision that needs Danilo** — as is §6's approved "HTML
parsing dependency", which names no library and has no row in `01-ARCHITECTURE.md` §10. Two
`pnpm add`s and a `pnpm-lock.yaml` change, in a repo with zero runtime deps: name them before
starting, and in their own commit.

**B5. `ResolvedRate` carries no currency, so nothing can catch a mismatched rate.**
`normalize.ts:227-233` deliberately casts an unrecognised statement currency to `Currency`. Hand
that row a EUR `ResolvedRate` and a SEK line books at 117.5 with no complaint — today's code
protects against this only because it never converts at all. **Recommend
`ResolvedRate { currency, rate, rateDate }` and a refusal on mismatch.** This blocks a coder because
it is a type two layers share, and retrofitting it later touches both.

**Smaller, but decide before coding:** does `readTransaction` null `amountRsd` when it nulls a bad
`rate`? A blob carrying `rate: -1, amountRsd: 47000` currently feeds `aggregate.ts`'s
`field: 'amountRsd'` total unchallenged. Model §1.4 is silent. One sentence.

**Still UNVERIFIED and it gates the sidecar half only:** whether the document sidecar `.json` write
path permits an overwrite. `01-ARCHITECTURE.md:174` forbids overwriting *documents* and is silent on
the sibling. Build the ledger half first (§6) and this stops being on the critical path.

---

## 6. Build order

Every slice below leaves `pnpm lint && pnpm typecheck && pnpm test && pnpm coverage && pnpm build`
green. Slices 1–3 were run end to end; 4–6 are UNVERIFIED (they need the network and Azurite).

**Slice 0 — the two dependency decisions.** HTML parser and zod (or an explicit "no zod, use the
`fold.ts` type-guard style"). Nothing else can start; `pnpm-lock.yaml` is high blast radius.

**Slice 1 — the shape.** `types.ts` (4 lines) + `normalize.ts`'s implementation + the 7 two-line
fixture repairs. Measured: `0` tsc errors, `3132 / 3132`, coverage unchanged.
*Smallest shippable first slice.* It closes the `fold.ts:253-258` backwards-rate defect's *cause*
even before a rate exists, because RSD rows now carry `rate: 1` honestly.

**Slice 2 — `engine/rates.ts` + `rates-guards.test.ts`, together in one commit.** 65 cases. Do not
land the module without the tests: untested it is 103 statements and leaves 6 statements of margin.
Skip the seven defensive guards of §4.4 from the start.

**Slice 3 — `confirm-policy` + `fold.ts` `set_rate` + their two guard files.** 46 cases. This is the
commit that closes CANDIDATE-006. Measured after slices 1–3: `3243 / 3243`, branches **92.72%
(margin 54)**, statements 98.82%, functions 100%, lint clean, build clean.

**Slice 4 — `adapters/nbs/rate-page.ts` + F12/F13/F14** and its L2 fixture test. No network. Not
coverage-gated, so the test discipline has to come from the reviewer.

**Slice 5 — `adapters/store/rate-store.ts`** + `test/fakes/rate-store.ts`, and turn on `ci.yml`'s
`contract` job (own commit, named). `insertIfAbsent` only: no CAS, no TTL, no invalidation.

**Slice 6 — `app/resolve-rate.ts`, `app/refresh-rates.ts`, `functions/rates-timer.ts`,
`.env.example`, `src/lib/env.ts`.** The read path before the write path: `resolve-rate` against the
fake is what makes slice 3's `no_rate` path reachable in a real composition. Backfill last — it is
idempotent (§3b), so it is the cheapest thing to retry and the safest thing to defer.

Do **not** bundle: the manifest CSV rate column (§1.2, needs an unfreeze), C4's M4.5 render-layer
suppression, `validate.ts`'s currency-blind ceiling, and the four spec-file edits of §1.4.

---

## 7. One ruling with a measured cost — §5's CHF 125

Not "wrong", and I plan against it as written. But §5 rules four test rates partly on the ground
that a rate must be able to tell a correct conversion from a truncating one, and measures USD 101 at
12.00%. It does not measure the two rates it rules the same day. Over every cent from 0.01 to
1000.00, against the real `round2`:

| rate | `round2` ≠ `floor` |
|---|---|
| EUR 117.5 | 48.94% |
| GBP 136 | 12.13% |
| USD 101 | 12.00% |
| **CHF 125** | **0.59%** |
| any live 4dp value | ~50.00% |

**CHF 125 is blind by construction** — `125 = 1000/8`, so `cents × 1.25` lands exactly on 2dp and
the residual 0.59% is IEEE754 noise. A rounding guard written at the CHF rate is 83× less
discriminating than the same guard at the EUR rate, which is precisely the property that let a
truncating `toRsd` survive 547 cases. §5's own advice — *"prefer fractional averages for CHF and GBP
when they are computed"* — argues against 125, and was overridden by the ruling on the same day.

**No change requested; the constants stay as ruled.** The mitigation is a suite rule, and it is
already applied in §4.3: **rounding guards are written at EUR 117.5 and USD 101, never at CHF 125.**
If CHF ever becomes the vehicle for a rounding assertion, 124.9529 (the observed spot, 50.00%) or
any 4dp value is the value to use — and the "a test constant equal to a live value can pass by
accident" objection does not apply to a *rounding* assertion, which compares two computations of the
same product rather than a product against the network.

---

## 8. Open items — three, and no padding

1. **Azurite table-storage support in CI.** Assumed by the pipeline draft, UNVERIFIED here (no
   network). Ten minutes before slice 5 commits to it; slices 1–4 do not depend on it.
2. **Sidecar overwrite** (§5, last item). Gates the sidecar half of the repair path only.
3. **`ExchangeRateListTypeID=3`.** §3b names it as the assumption that would break immutability if
   NBS ever issued a corrected list under another type id. Nothing to do now; R4's 409-comparison is
   the detector, which is one more reason to implement R4 rather than §3b's drop-without-reading.
