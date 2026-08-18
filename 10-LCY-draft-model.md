# 10 — LCY (local currency): draft data model

> **Scope.** The DATA-MODEL half of the LCY scoping document. Field shapes, freeze impact, backfill,
> ordering. It contains no code and changes no file. The rate-adapter half (Table Storage layout, NBS
> client, cache eviction) is a separate document.
>
> **Status:** draft for Danilo. **HIGH BLAST RADIUS** — see the banner below.

---

## 0. Blast radius, named up front

This is a **data-model change to money**. Per the working agreement it is named explicitly rather
than bundled: it alters `Transaction` and `DocumentFacts` in `e-app/src/engine/types.ts`, adds an op
to `LedgerEvent` in `e-app/src/engine/ledger/fold.ts`, and changes the number that
`e-app/src/engine/nlu/confirm-policy.ts` compares against the only automatic gate on the WhatsApp
path. Every total in every report is downstream of it.

There is no `prisma/schema.prisma` here and no migration to generate — the ledger is immutable blobs
(`01-ARCHITECTURE.md:45-66`). That makes the change *cheaper* to land and *harder* to reverse:
there is nothing to `ALTER`, and equally nothing to `UPDATE`. Every event blob already written is
final. §4 is therefore the section to read second.

### How the claims in this document were verified

Everything labelled *measured* was run. Method: the whole of `e-app/` (`src/`, `test/`, configs,
`node_modules` symlinked) was copied to a scratch directory, the candidate change applied there, and
`npx tsc --noEmit` + `npx vitest run` executed against the copy. **No file in
`/workspace/projects/E` was modified.** Baseline in the real tree, confirmed before starting:

```
Test Files  20 passed (20)
     Tests  3132 passed (3132)
```

A fully green baseline is what makes the enumeration in §2 trustworthy: any red is caused by the
change and nothing else. Claims I did not run are labelled **UNVERIFIED**.

---

## 1. The shape

### 1.1 The single most important decision: LCY **is** `amountRsd`. It does not sit beside it.

`Transaction.amountRsd: number | null` already exists (`types.ts:107`). So does
`DocumentFacts.amountRsd: number | null` (`types.ts:88`) and the sidecar's `amount_rsd`
(`01-ARCHITECTURE.md:162`).

**Decision: keep the field, keep the name, and give it the provenance it is missing.** LCY neither
replaces `amountRsd` nor sits beside it. `amountRsd` *is* the local-currency amount; the local
currency is RSD; a second RSD number on the same row would be two answers to one question.

The reasons, in descending order of force:

1. **A second RSD field is the exact failure this codebase is built to refuse.** `aggregate.ts`'s
   header states the rule — *"when the answer would be a guess, refuse"* (`aggregate.ts:19-22`) — and
   `checkCurrencies` (`aggregate.ts:243-250`) exists solely to stop one number standing for two
   units. Shipping `amountRsd` *and* `amountLcy`, both in dinars, both nullable, both summable,
   creates a permanent question at every call site: *which one is the total built from?* Nothing in
   the type system could answer it.
2. **`amountRsd` is already load-bearing as the cross-currency axis.** `AggregateQuery.field` is
   typed `'amount' | 'amountRsd'` (`aggregate.ts:32`); `checkField` refuses a query when any
   in-scope row has `amountRsd === null` (`aggregate.ts:226-234`); `checkCurrencies`'s error message
   *tells the caller to ask for `amountRsd` instead* (`aggregate.ts:248`); `fold`'s `rescaleRsd`
   maintains it across a correction (`fold.ts:253-258`). LCY is not a new concept in this codebase.
   It is the completion of an existing one that is (a) null too often and (b) carries no record of
   how it was computed.
3. **The unit is in the name, which is the strongest available guard against unit confusion.**
   `amountLcy` would need a companion `lcyCurrency` to be honest, and would invite the question of a
   second local currency that nobody has asked for. All three books are Serbian
   (`00-OVERVIEW.md`, `_state/books.json` per `01-ARCHITECTURE.md:121`); RSD is not going to move.
4. **A rename is maximum blast radius for zero semantic gain.** `amountRsd` appears at ~130 sites in
   `test/unit/**` (measured: `grep -c` over the frozen suite). Renaming it would put every one of
   them in an unfreeze commit. Adding two fields beside it puts **eight** lines in one (§2).

**What is genuinely missing is not an amount. It is the rate.** Today the rate exists only
implicitly, and `fold.ts:253-258` has to *reconstruct* it by dividing `amountRsd` by `amount`:

```ts
function rescaleRsd(tx: Transaction, amount: number): number | null {
  const rsd = tx.amountRsd
  if (!isFiniteNumber(rsd)) return null
  if (!isFiniteNumber(tx.amount) || tx.amount === 0) return null
  return round2((amount * rsd) / tx.amount)          // ← an implied rate, recovered by division
}
```

`amountRsd` is already rounded to 2dp, so the recovered rate is not the rate that was used.
**Measured** — 110,446 `(original, corrected)` pairs at amounts 100.00–104.00:

| rate | pairs where the implied rate disagrees with the true rate | max divergence |
|---|---|---|
| 117.5 | 10,781 (**9.76%**) | 0.01 RSD |
| 117.3510 | 12,759 (**11.55%**) | 0.01 RSD |
| 101 | 0 (0.00%) | 0 |

One para, so this is not the argument on its own — **the argument is auditability**: a rate you have
to divide to see is a rate you cannot show the accountant, cannot compare against NBS's published
figure for that date, and cannot use to explain why August's number is what it is. (The 0.00% row
for 101 is itself a finding; see §6, Q6.)

### 1.2 `Transaction` — the two fields added

```ts
export interface Transaction {
  …
  amount: number                  // signed: negative = outflow    ← unchanged
  currency: Currency              //                                ← unchanged
  amountRsd: number | null        // THE LCY AMOUNT. round2(amount * rate). ← unchanged shape
  rate: number | null             // ← NEW. full precision, never rounded
  rateDate: string | null         // ← NEW. YYYY-MM-DD, the date the rate is FOR
  direction: TxDirection
  …
}
```

Justification, field by field:

**`rate: number | null`** — required key, nullable value. Nullable because it must be: a row
captured before any rate for its currency was ever fetched, and a row whose statement carried a
currency code this build does not know (`normalize.ts:227-233` deliberately passes an unrecognised
code through as `Currency`), both genuinely have no rate. **Required key** (not `rate?: number`)
because the house convention is that absence is `null` and never `undefined`
(`types.ts:44`, `aggregate.ts:206-207`), and because `rate?:` cannot distinguish *"this row has no
rate"* from *"this writer did not know about rates"* — which is precisely the distinction §4 turns
on. The required key also produces the compile break in §2, which is a feature: it forces every
construction site to state a rate.

**`rateDate: string | null`** — `YYYY-MM-DD`, matching `txDate` (`types.ts:101`) and
`ExtractedFacts.docDate` (`types.ts:55`). This field is what makes staleness derivable rather than
declared:

```
isStale(tx)  ≡  tx.rateDate !== tx.txDate
```

No boolean. A boolean would be a second copy of a fact already present, and copies drift. This
follows the ruling already recorded for rule provenance in `UNFREEZE-LOG.md:212-217` — *"provenance
is not a property of the data, it is a property of the path the data took"* — one level down: the
date is the unforgeable thing, `stale: true` would be an assertion anyone could write.

**`rate` for a dinar transaction is `1`, and `rateDate` is `txDate`.** Not `null`. Three reasons:
(a) it makes `rateDate !== txDate` correct for RSD rows — with `rateDate: null` every dinar row
would read as *stale*, which is absurd; (b) `money.test.ts:497-498` already pins
`toRsd(rsd(1500), 1) === 1500` under the title *"passes an RSD amount through unchanged at a rate of
1"*, so rate 1 for dinars is the suite's own established convention; (c) it collapses a null branch
in every consumer. A dinar is worth a dinar on every date — that is an identity, and an identity
holds on the transaction's own date.

**No third field.** No `rateSource`, no `stale`, no `rateProvider`. `rateDate` plus the currency is
enough to re-derive everything: which NBS publication was used, whether it was the document's own
date, and how far off it was. The one thing this shape cannot express is *"a rate was requested and
the cache was empty"* — that case is `rate: null, amountRsd: null`, which is the honest encoding of
it.

**Naming, and a divergence I am not proposing to fix.** `PdfInvoiceData` already calls this number
`exchangeRate` (`invoice-template.ts:21`), paired with `totalRsd` (`:22`). I am using `rate` /
`rateDate` on `Transaction` because that is the naming in Danilo's ruling, and because renaming
`exchangeRate` would require unfreezing `invoicing.test.ts:872` and `:913`, which assert
`data.exchangeRate` by name. So the codebase will carry two names for one concept on two different
surfaces. That is worse than one name and better than an unfreeze bought for cosmetics. See §6, Q5.

**Also divergent, deliberately:** `invoice-template.ts:89-91` sets `totalRsd: null` on a **dinar**
invoice, pinned by `invoicing.test.ts:923-925` (*"leaves the dinar equivalent null on a dinar
invoice, which needs no conversion"*). That is right for an invoice — there is no second figure to
print — and wrong for a ledger row, where `amountRsd` is the number every cross-currency total is
built from and must never be null when it is knowable. Different jobs; stating it rather than
pretending consistency.

### 1.3 `DocumentFacts` — the same two fields

```ts
export interface DocumentFacts extends ExtractedFacts {
  …
  amountRsd: number | null        // ← unchanged
  rate: number | null             // ← NEW
  rateDate: string | null         // ← NEW
  …
}
```

Required for symmetry with the sidecar (`01-ARCHITECTURE.md:150-167`) and because
`05-SMOQUA.md:128` already specifies the rate is *"stored alongside"* — it currently is not.
`searchDocuments` (`aggregate.ts:424`) and `manifest.ts` are the consumers.

Note this is where the change touches the **document** path, not just the ledger, so `/tebra`'s
`get_document` (`09-TEBRA.md:41`) and the monthly manifest both gain the rate for free.

**Not touched:** `ExtractedFacts` (`types.ts:52-61`). An extractor reads what the document says; the
document does not say what the NBS rate was. Rate resolution happens after extraction — see §5.

### 1.4 `LedgerEvent` — one new op, `set_rate`

```ts
export type LedgerEvent =
  | { op: 'add'; …; tx: Transaction }                       // carries rate/rateDate inside tx
  | { op: 'set_category'; … }
  | { op: 'set_dimension'; … }
  | { op: 'set_amount'; … }
  | { op: 'split'; … }
  | { op: 'set_rate'; id: string; at: string; ref: string;  // ← NEW
        rate: number; rateDate: string; by?: string;
        replaces?: { rate: number; rateDate: string } | null }
  | { op: 'delete'; … }
```

`rate` and `rateDate` ride on the transaction inside `add` — that is the *capture* path, and it
needs no new op (`fold.ts:87-109` spreads the blob's own fields through). `set_rate` exists for one
reason: **event blobs are immutable, so a rate cannot be added to an existing row by editing it**
(§4). It is the only append-only way to attach a rate to a row captured without one.

Three properties it must have, all of them consequences of the freeze-at-capture ruling:

- **`set_rate` on a row that already has a rate is a no-op.** It supplies a missing rate; it never
  replaces one. Recomputing would move a figure already sent to the accountant, which is the whole
  reason the rate is frozen (`01-ARCHITECTURE.md:77-80`).
- **It recomputes `amountRsd = round2(tx.amount * rate)`**, same as `set_amount` recomputes it
  (`fold.ts:321-332`).
- **`invert(set_rate)` returns `null`.** Same class as `split` (`fold.ts:404`): there is no honest
  inverse of "the row now has a rate", because the prior state was *unknown*, not *a different
  rate*, and an undo that invents a prior value is worse than one that declines (`fold.ts:409-410`).

`normalizeEvent` must validate `rate` as strictly as `amount`: finite **and** `> 0`, matching
`toRsd`'s own contract (`money.ts:294-297`, pinned by `money.test.ts:512-521`). A rate arrives from
a blob as untrusted JSON and is then *multiplied by money*; `readTransaction`'s cast
(`fold.ts:104-108`) covers only `id` and `amount` today, so `rate` needs adding to the checked set —
a non-finite or non-positive rate must read as `null`, not flow through.

**Forward-compatibility hazard, worth one sentence in the runbook:** `normalizeEvent`'s `default:`
arm drops an op it does not know (`fold.ts:189-191`, tested at `fold-guards.test.ts:138`). A
`set_rate` blob written by a new build and folded by an old one is **silently dropped**, and the row
reverts to `amountRsd: null`. That is the correct behaviour for an unknown op and it means a rollback
past this change is visible as missing dinar totals, not as wrong ones.

### 1.5 Rounding: the RATE is stored at full precision; only the PRODUCT is rounded

Stated flatly because it is the one arithmetic rule the whole change rests on:

```
rate       stored EXACTLY as fetched. Never round2'd. NBS publishes 4dp
           (117.3510, 101.2869); the field is a plain `number` and takes whatever arrives.
amountRsd  = round2(amount * rate)                    — round2 applied ONCE, to the product
           `round2` is the single rounding convention (money.ts:270-291), half away from zero.
```

`toRsd` (`money.ts:293-298`) already implements exactly this and needs **no change at all**. Its
354-case contract in `money.test.ts:461-521` stands untouched, and `money-guards.test.ts:35-57` —
the file that closed GAP 1, the truncating-conversion mutant — keeps guarding it.

Never round the rate: at 4dp a rounded rate would move a 1,000,000 RSD figure by up to 50 RSD, and
the rate is the auditable link to NBS's published number. Never round twice: rounding a per-line
product and then a total is the drift `addExact` exists to prevent (`aggregate.ts:74-83`).

### 1.6 Where the rate is resolved, and how it reaches the pure engine

The engine takes no clock, no `fetch`, no `env` (`01-ARCHITECTURE.md:189`, `:457`). A rate is I/O.
So:

```
adapters/store/rate-store.ts   (NEW — Table Storage, PartitionKey=currency, RowKey=date)
    latestRateAtOrBefore(currency, onDate) -> { rate, rateDate } | null
        A pure LOOKUP with a stated contract: return the newest row whose RowKey <= onDate,
        together with the date it was actually found under. It makes no decision — the
        stale-fallback POLICY is expressed by the fact that rateDate may be < onDate,
        and the caller can see that.
    ⇣
app/ingest-document.ts  ·  app/handle-whatsapp-message.ts     (composition)
        resolve once, pass down as a plain value
    ⇣
engine/ledger/normalize.ts   toTransaction(raw, book, id, dedupeKey, createdAt,
                                           rate: { rate, rateDate } | null = null)   ← 6th param
engine/nlu/confirm-policy.ts decide(interpretation, book, amountRsd: number | null = null) ← 3rd param
engine/money.ts              toRsd(money, rate)                ← unchanged, already explicit
```

Both engine additions are **optional trailing parameters**, which is what makes them
freeze-compatible: every existing call site passes the old arity and gets the old behaviour. This is
the same mechanism `UNFREEZE-LOG.md:808-813` already recommends for CANDIDATE-004, so it is a house
pattern rather than an invention.

The **fallback ruling** — *use the most recent fetched rate and flag it* — is expressed entirely by
`latestRateAtOrBefore` returning a `rateDate` earlier than asked for, plus the derived
`rateDate !== documentDate`. No branch in the engine, no boolean in the store, no policy in the
adapter. That is the payoff of making staleness derivable.

⚠ **`05-SMOQUA.md:130` currently contradicts this ruling** — *"Rate lookup failure → …leave
`amount_rsd` null, `needs_review`, backfill on the next successful rate fetch"* — and so does
`07-ROADMAP.md:589` (*"rate failure → null + `needs_review`"*). Both need the matching edit. **I have
not made it** (spec files are out of scope for this document, and per `UNFREEZE-LOG.md:35-37` a spec
edit is deliberately not bundled into another change). The distinction the edit needs to draw:

| situation | `rate` | `amountRsd` | `reviewStatus` |
|---|---|---|---|
| rate for the document's own date | the rate | computed | `ok` |
| only an older rate available | that rate | computed, **flagged** via `rateDate !== txDate` | `ok` (see §6, Q3) |
| no rate ever fetched for this currency | `null` | `null` | `needs_review` |

---

## 2. Freeze impact — enumerated, not estimated

**Method.** The full change of §1 was applied in the scratch copy and `tsc` + `vitest` run. Total
across the whole design: **8 compile sites** (1 in `src/`, 7 in `test/`) and **exactly 1 broken
assertion**.

### 2.1 Compile breaks — 7 test sites, all fixture builders, all freeze-legal

Adding a required key to `Transaction` / `DocumentFacts` makes every full object literal fail to
typecheck. `TEST-FREEZE.md:26` lists **"fixing a test that cannot compile"** in the *Allowed while
frozen* column, so none of these needs a ruling. Measured — `tsc` names exactly these, one builder
per file, and the repair is two lines each (`rate: null,` / `rateDate: null,`):

| # | Site | What it is | Frozen? | Fix |
|---|---|---|---|---|
| 1 | `src/engine/ledger/normalize.ts:237` | `toTransaction`'s return literal | src | the real implementation (§1.6) |
| 2 | `test/unit/tebra.test.ts:75` | `tx()` builder, 260 cases | **frozen** | +2 lines, compile-only |
| 3 | `test/unit/tebra.test.ts:99` | `doc()` builder (`DocumentFacts`) | **frozen** | +2 lines, compile-only |
| 4 | `test/unit/ledger-core.test.ts:69` | `makeTx()`, 188 cases | **frozen** | +2 lines, compile-only |
| 5 | `test/unit/ledger-categorize.test.ts:87` | `tx()`, 165 cases | **frozen** | +2 lines, compile-only |
| 6 | `test/unit/packaging.test.ts:85` | `doc()` builder, 230 cases | **frozen** | +2 lines, compile-only |
| 7 | `test/unit/fold-guards.test.ts:24` | `tx()` builder | post-freeze¹ | +2 lines, compile-only |
| 8 | `test/unit/packaging-guards.test.ts:49` | `doc()` builder | post-freeze¹ | +2 lines, compile-only |

¹ The frozen surface is the **14 files** enumerated in `TEST-FREEZE.md:29-32` / `:195-203`.
`fold-guards`, `money-guards`, `packaging-guards`, `documents-guards`, `mail-guards` and
`slug-recovery` were added *after* the freeze under `TEST-FREEZE.md:24` (*"adding tests for new
behaviour that no test covers"*) — see `UNFREEZE-LOG.md:167-169`. They are editable without a
ruling, **but** each was written to kill a specific mutant, so any edit must preserve the mutant it
kills.

**Default the new keys to `null`, not to `1`, in all six fixture builders.** Measured: with
`rate: 1` defaults, three post-freeze cases go red as an artefact of the fixture (see 2.3); with
`rate: null` defaults, **`3132 / 3132` stay green**. `null` is also the honest value — these
fixtures predate rate provenance, and `tebra.test.ts:154` (`currency: 'EUR', amountRsd: -11700`)
would be internally inconsistent with a rate of 1.

**Measured result of the compile repairs alone, with no behaviour change:**
`Test Files 20 passed (20) · Tests 3132 passed (3132)`. The type change is assertion-neutral.

### 2.2 The one real unfreeze — `nlu.test.ts:916-922` (CANDIDATE-006)

**Pre-authorized by Danilo, 2026-08-17.** `TEST-FREEZE.md:108` and `07-ROADMAP.md:607-612` both
require this and both note a subagent cannot self-authorize it.

The frozen pair sits under one comment (`nlu.test.ts:902-903`):

```
// decide() is handed no FX rate, so it can only compare raw numbers. Both directions
// of the resulting asymmetry are pinned here deliberately — see the spec-gap report.
```

| line | title | verdict under LCY |
|---|---|---|
| `:905-914` | *"compares the raw amount against the threshold, so 1200 RSD trips a 1000 threshold"* | **SURVIVES.** An RSD amount equals its own LCY amount. No change. |
| `:916-922` | *"compares the raw amount against the threshold, so 200 EUR commits under a 50000 threshold"* | **BREAKS.** Measured: `expected { action: 'confirm' } to deeply equal { action: 'commit' }`. |

So the register's `:905-922` is **half** an unfreeze, and the half that breaks is one `it`. Measured,
whole-suite, with the §1 change plus an LCY-aware `decide`:

```
Test Files  1 failed | 19 passed (20)
     Tests  1 failed | 3131 passed (3132)
  × nlu.test.ts > decide > the book amount threshold, at the boundary exactly >
    compares the raw amount against the threshold, so 200 EUR commits under a 50000 threshold
```

**Why the assertion is wrong** (the `TEST-FREEZE.md:36-54` bar):
`confirm-policy.ts:62-72` compares `money.amount` — a bare number — against
`book.features.confirmAboveAmount`. Measured against a book with `currency: 'RSD'` and
`confirmAboveAmount: 500`:

```
400 RSD → commit          400 EUR → commit          400 USD → commit
1200 RSD → confirm (large_amount)
```

400 EUR at the fixed test rate of 117.5 is **47,000 RSD**, committed without a tap under a 500 RSD
threshold: the effective threshold for a EUR amount is `500 × rate` = 58,750 RSD, i.e. the gate is
loose by exactly the rate factor. Same defect class as UNFREEZE-001, whose entry
(`UNFREEZE-LOG.md:106-110`) explicitly left this open. `02-WHATSAPP-INTERFACE.md:193-197` — *"an
amount above a configurable threshold → require a tap"* — is not satisfiable by a currency-blind
comparison, so the code contradicts the spec, not merely taste.

**There is a design choice here that decides whether this unfreeze is needed at all, and the
freeze-compatible option is the wrong one.** Measured, both variants:

- **(a) Fall back to the raw amount when no LCY figure is supplied.** `nlu.test.ts:916` stays
  **green** — and only by luck: 200 EUR × 117.5 = 23,500, still under the 50,000 threshold that test
  uses. The assertion passes; its *title* becomes false. Nothing forces a caller to supply the LCY
  amount, so the ~117× hole survives for anyone who forgets. This is CANDIDATE-015's error exactly
  (`UNFREEZE-LOG.md:493-495`: *"a fix verified against the attacks you thought of is not a fix"*) and
  GAP 2's anatomy (`UNFREEZE-LOG.md:154-169`: a test whose title is false).
- **(b) Refuse: a foreign amount with no LCY figure is a tap, never a commit.** `:916` goes red.
  **Recommended**, and it is what the pre-authorization is for.

Land it per `TEST-FREEZE.md:44-54`: its own commit, message beginning `UNFREEZE:`, **no `src/`
changes in that commit**, reason in the body, and a matching `UNFREEZE-LOG.md` entry citing the
2026-08-17 pre-authorization. Replace the two-line comment at `:902-903` in the same commit — it is
the load-bearing part of the assertion, and leaving it would preserve the wrong claim after the test
that stated it is gone.

### 2.3 Post-freeze tests that need rewriting, and why each is not an unfreeze

All three are in `fold-guards.test.ts` (post-freeze), in the block *"a corrected amount and its dinar
mirror"* (`:174-203`), which exists specifically to cover `rescaleRsd`'s two null paths. Making
`rescaleRsd` prefer a stored rate changes what those paths mean. Measured with `rate: 1` defaults:

| line | asserts | LCY verdict |
|---|---|---|
| `:176-184` | un-converted EUR row (`amountRsd: null`), `set_amount −100→−120` ⇒ `amountRsd` stays `null` | **Still correct, and should be kept** — but the fixture must now say `rate: null` explicitly. "Un-converted" *means* rate-null under LCY. |
| `:186-194` | `amount: 0, amountRsd: 0`, `set_amount →−50` ⇒ `null`, *"implies no rate from a zero original amount"* | **The premise is retired.** The null came from being unable to divide by zero. With a stored rate, `round2(−50 × 1) = −50` is available and correct. LCY **fixes a real defect**: a zero-amount row currently drops out of the dinar totals the moment it is corrected. Rewrite to pin the new behaviour and keep a rate-null variant for the old path. |
| `:196-203` | EUR row `amountRsd: −11750`, corrected `−100→−120` ⇒ `−14100` | **Still passes**, provided the fixture states `rate: 117.5`. `round2(−120 × 117.5) = −14100`, identical to the division result. Add the rate; the assertion is unchanged. |

Keep the division as a **fallback** when `tx.rate === null`. That is what preserves these cases for
un-backfilled rows and is the same mechanism §4's "leave null" option relies on.

### 2.4 Frozen tests that LCY does **not** break — checked, because the register implied otherwise

Recording these so nobody spends a second unfreeze on them.

- **`tebra.test.ts:519` and `:526`** — *"refuses to sum/average `amountRsd` when a transaction in
  scope was never converted"*. **Green, and must stay green.** `amountRsd` remains
  `number | null`; the refusal at `aggregate.ts:226-234` remains reachable for un-backfilled rows and
  for currencies with no rate at all. Do **not** make `amountRsd` non-nullable to "finish" LCY — it
  would delete the safety net that stops a short total being reported as a complete one.
- **`tebra.test.ts:748` / `:761`** — `AggregateResult` pinned to exactly four fields by `toEqual`.
  **Green.** LCY adds nothing to `AggregateResult`. The caveat field that
  `TEST-FREEZE.md:109` says needs an unfreeze is still unavailable, and LCY does not buy it (§3.2).
- **`ledger-core.test.ts:1049-1053`** — *"leaves `amountRsd` null for a foreign currency, because no
  rate was supplied"*. **Green.** `toTransaction` gains an *optional* 6th parameter, so this call
  site keeps passing five arguments, gets no rate, and gets `null`. This is the assertion that
  looked most likely to require a ruling and does not.
- **`ledger-core.test.ts:1042-1046`** — *"sets `amountRsd` from the amount when the transaction is
  already in dinars"*. **Green.** Rate 1 for RSD preserves it.
- **All 354 `money.test.ts` cases and all 13 `money-guards.test.ts` cases.** **Green.** `toRsd` and
  `round2` are unchanged.
- **`invoicing.test.ts:872, 885, 905, 913, 919, 923-925`** (`exchangeRate` / `totalRsd`).
  **Green.** LCY does not touch `PdfInvoiceData`; see the divergence noted in §1.2.
- **`fold-guards.test.ts:138`** — `set_vendor` as *"an op this build does not know"*. **Green**;
  `set_rate` is not that fixture's op. (`set_vendor` becomes a real op at M8 per
  `09-TEBRA.md:76`, which will break this case then. Not LCY's problem, noted in passing.)

### 2.5 Coverage gate

`vitest.config.ts` gates 95% lines / 90% branches on `src/engine/**` (`TEST-FREEZE.md:205`), and
`UNFREEZE-LOG.md:276-283` records the real current figure as **89.04% branches against a 90% gate**.
LCY adds branches to `fold.ts`, `normalize.ts` and `confirm-policy.ts`. **Every new branch needs a
test in the same commit** or this change is what finally makes the gate red — on a number nobody has
ever seen. Named here so it is a plan and not a surprise. **UNVERIFIED:** I did not run
`--coverage.reportOnFailure` against the modified copy.

---

## 3. What LCY closes for free

### 3.1 CANDIDATE-006 — closed properly, not per-currency. ✅ Verified

Verified above (§2.2). Worth stating why LCY is the *right* fix rather than one of several:
`decide` needs one comparable number, and a per-currency threshold table in `books.json` would need
five entries per book, would go stale, and would still not compare `USD` against a book that never
declared a USD threshold. One LCY figure and one threshold is the general fix. `07-ROADMAP.md:610`
already anticipates exactly this (*"Superseded by the LCY work, which solves it generally rather than
per-currency"*).

**The unresolved half is which unit the threshold is in.** See §6, Q1 — this is the question I would
most like answered before implementation, because the wrong answer opens a fresh 117× hole facing the
other way.

### 3.2 The tebra grand-total currency pooling — LCY does **not** make it moot. ⚠ Verified

`07-ROADMAP.md:441-450` asks directly: *"If the LCY work lands first this problem disappears — every
row gains a comparable amount — so check before building the suppression."* **Checked. It does not
disappear.** Measured against the current `aggregate` with one EUR and one RSD row in different
categories and different vendors:

```
groupBy ['currency'] → rows −100 / −6000    total −6100     ← per-bucket check passes, total pools
groupBy ['category'] → rows −100 / −6000    total −6100     ← ALSO pools
groupBy ['vendor']   → rows −100 / −6000    total −6100     ← ALSO pools
metric 'avg'         →                      total −3050     ← a mean of two units
field 'amountRsd'    →                      total −17750    ← the honest figure
```

(Reproducing `UNFREEZE-LOG.md:358-370` exactly, at the 117.5 test rate. Note the buckets must differ
on the grouped axis for the pooling to be visible — with both rows in one category,
`checkCurrencies` at `aggregate.ts:243-250` correctly throws first.)

**Why LCY does not fix it:** the pooling lives on `field: 'amount'`, the *original* amount
(`aggregate.ts:282`, default). `AggregateResult.total` is summed over `field` regardless of currency
(`aggregate.ts:310-311, 339-346`), and no amount of LCY availability changes what happens when a
caller asks for the original. And it cannot be fixed by refusal: `tebra.test.ts:494-499` requires
`groupBy: ['currency'], field: 'amount'` to **succeed**, and that assertion is correct — it is what
makes the per-bucket design work. Confirmed by the reverted attempt (`TEST-FREEZE.md:111-113`).

**What LCY does change is worth having, and it is not nothing:**

1. **The honest alternative becomes always available.** Today `field: 'amountRsd'` throws whenever
   any in-scope row is unconverted (`aggregate.ts:226-234`), so the render layer cannot reliably fall
   back to it. Once capture always resolves a rate, that refusal stops firing on new data, and
   "ask for `amountRsd` instead" — which `aggregate.ts:248` already tells callers to do — becomes
   advice that works.
2. **The M4.5 render-layer suppression gets something to print.** Instead of suppressing the total
   and showing a gap, `/tebra` can print the LCY total with a per-currency breakdown underneath,
   which is what `05-SMOQUA.md:129` asks for anyway (*"dimension totals in RSD, with a per-currency
   breakdown underneath"*).

**Conclusion: M4.5's suppression is still required.** Build it. LCY makes it a *substitution* rather
than a *hole*. The same applies to the `manifest.ts` half of that finding
(`UNFREEZE-LOG.md:377-382`) — LCY gives `moneyTotal` a comparable figure but does not remove the need
for the `null`-when-mixed guard.

### 3.3 A third candidate, offered with its condition — the currency-blind `amountTotal` ceiling

`UNFREEZE-LOG.md:106-110` leaves UNFREEZE-001 explicitly open: `AMOUNT_UPPER_EXCLUSIVE = 100_000_000`
(`validate.ts:62`, applied at `:239-241`) is compared against `amountTotal` in whatever currency the
document is in, so EUR 99,999,999 (≈11.7bn RSD) passes.

LCY makes an LCY-denominated ceiling *possible*, and the frozen suite would not object:
**measured — `extract-validate.test.ts` contains zero foreign-currency fixtures** (`grep -c` for
`currency: 'EUR'|'USD'|'CHF'|'GBP'` returns 0 across all 183 cases). So the ceiling could be
LCY-aware with no unfreeze.

**But it is blocked on ordering, not on data.** `validateFacts(facts, extraction, clock)`
(`validate.ts:166-170`) runs at step 4 of the ingest pipeline, and the rate is resolved after
extraction (§5) — so validate has no rate to convert with. Making the ceiling LCY-aware means either
a 4th parameter and a pipeline reorder (`01-ARCHITECTURE.md:411-433`), or a second validation pass
after conversion. **UNVERIFIED and out of scope for this document.** Recorded so it is not
re-discovered: LCY is a *precondition* for closing it, not the closure.

---

## 4. Backfill — what happens to events already written

**The constraint that decides this.** Ledger events are one immutable blob per event
(`01-ARCHITECTURE.md:58`, `:105-109`), written with `If-None-Match: *`. Documents are never
overwritten because the path contains the content hash (`01-ARCHITECTURE.md:174`). **There is no
`UPDATE`.** An existing `add` event cannot gain a rate by being edited. That rules out the migration
shape everyone reaches for first.

Three real options.

### Option A — leave `null` forever

Old rows keep `rate: null, rateDate: null, amountRsd` as-is. `rescaleRsd`'s division survives as the
fallback (§2.3) so corrections still behave.

- **Consequence for reporting:** `field: 'amountRsd'` **throws** for any period containing an
  un-backfilled foreign row (`aggregate.ts:226-234`, pinned by `tebra.test.ts:519`). So every
  historical month with a single foreign transaction is permanently unanswerable by `/tebra`'s
  cross-currency queries. Loud, never wrong, and unusable.
- Cost: zero.

### Option B — a `set_rate` event per un-rated row *(recommended)*

A one-off script lists each `{book}/{YYYY}/{MM}/tx/` prefix, folds it, and for every row with
`rate === null && currency !== 'RSD'` appends one `set_rate` blob carrying
`latestRateAtOrBefore(currency, tx.txDate)`.

- **Consequence for reporting:** historical months become answerable. Every backfilled figure is
  **self-labelling**: `rateDate !== txDate` marks any row where the rate came from a different date,
  and `at` on the `set_rate` event records when the backfill ran. Nothing is silently improved.
- Fits every existing invariant: append-only, idempotent via `_index/event/*`
  (`01-ARCHITECTURE.md:54`), replayable, and a bad batch is undone by deleting the batch's blobs and
  re-folding — `01-ARCHITECTURE.md:64`'s rebuildability, used for the purpose it was designed for.
- **Consequence to be explicit about:** it *changes historical figures*. `amountRsd` goes from
  `null` to a number, so a dinar total for August computed after the backfill differs from the same
  total computed before it. That is the one thing the freeze-at-capture ruling exists to prevent
  — **and it is acceptable here, for a reason that must be written down rather than assumed**:
  going from *no answer* to *an answer, dated* is not the same as moving an answer already given.
  Any month already packaged and emailed (`packages/{book}/{period}/`) is a figure the accountant
  holds, so the honest sequencing is: backfill, then diff every affected period's rollup against the
  package that was sent, and report the deltas rather than let them appear silently.
  **This needs Danilo's ruling — see §6, Q2.** It is the only part of the backfill I would not do
  unasked.

### Option C — lazy backfill at fold time

`fold` fills a missing rate from the cache on read.

**Rejected.** It would put I/O inside the pure engine (`01-ARCHITECTURE.md:189`), and it would make
`fold` non-deterministic: the same event log would fold to different numbers as the cache filled,
destroying the ORDER INDEPENDENCE property `fold.ts:18-24` is built around and the reproducibility
`01-ARCHITECTURE.md:288` calls *"the property you actually wanted when you said deterministic"*.
Recorded only so it is not re-proposed.

### Recommendation

**Option B, staged, and the staging is what makes it safe:**

1. Ship capture-side LCY first. New rows carry rates. Nothing historical moves.
2. Run the backfill **read-only** — produce the `set_rate` blobs into a file, not into blob storage —
   and diff every affected period against the packages already sent.
3. Show Danilo the diff. Applying it is an operator action, exactly as applying a migration is
   (working agreement, *High blast radius*). Generate it, show it, stop.
4. Only then append.

**Document sidecars are a separate, smaller job.** They are mutable JSON (`_state`-like) rather than
ledger events, so they can be rewritten in place — but the document bytes must not be, and the
sidecar shares the document's hash-derived path. **UNVERIFIED:** I did not check whether the sidecar
write path permits an overwrite; `01-ARCHITECTURE.md:174` says *"no overwrite of documents ever"* and
is silent on the `.json` sibling. Worth confirming before planning that half.

---

## 5. Ordering — which modules change, in what order

The smallest shippable first slice is **Slice 1 alone**. It is a complete, verifiable change that
alters no behaviour: the fields exist, nothing populates them, the suite is green, and every later
slice becomes a small diff against a landed type.

| Slice | Files | What lands | Suite after (measured where stated) |
|---|---|---|---|
| **1. The shape** | `engine/types.ts` (+2 lines ×2 interfaces); the 6 fixture builders of §2.1; `engine/ledger/normalize.ts:237` | `rate` / `rateDate` on `Transaction` and `DocumentFacts`; `toTransaction` returns `null, null`. No behaviour change. | **measured: 3132 / 3132 green** |
| **2. Capture** | `engine/ledger/normalize.ts` (optional 6th param, §1.6); `engine/money.ts` **unchanged** | RSD ⇒ `rate: 1, rateDate: txDate`; foreign with a rate ⇒ `toRsd`; foreign without ⇒ `null`. New tests for each. | measured green |
| **3. Corrections** | `engine/ledger/fold.ts` — `rescaleRsd` prefers `tx.rate`, division kept as fallback; `partTransaction` carries the rate through (free, via spread at `:266`) | a corrected row keeps the rate it was booked at, from the record rather than from a division | measured green; 3 post-freeze cases rewritten (§2.3) |
| **4. `set_rate`** | `engine/ledger/fold.ts` — 7th op, `normalizeEvent` arm, `fold` arm, `invert ⇒ null`, `rate` added to `readTransaction`'s checked set | the append-only backfill primitive | **measured: assertion-neutral** |
| **5. The gate** ⚠ | `engine/nlu/confirm-policy.ts` — optional 3rd param + refuse-when-missing | closes C-006. **Needs the `UNFREEZE:` commit of §2.2 to land FIRST, on its own, with no `src/` changes.** | 1 frozen assertion red until the unfreeze lands |
| **6. Adapters** | `adapters/store/rate-store.ts` (NEW, Table Storage) + a fake; NBS client; `app/ingest-document.ts`, `app/handle-whatsapp-message.ts` | the rate actually arrives. L2 contract tests — not frozen (`TEST-FREEZE.md:223-224`). | — |
| **7. Reporting** | `engine/packaging/manifest.ts`, `engine/tebra/render/*` | the rate and the staleness flag become visible to the accountant and to `/tebra` | — |
| **8. Backfill** | a one-off script + the operator step of §4 | historical months answerable | — |

Ordering constraints, as opposed to preferences:

- **Slice 1 before everything.** Every other slice touches a type it defines.
- **Slice 5's unfreeze commit strictly precedes Slice 5's `src/` change**, in its own commit, per
  `TEST-FREEZE.md:44-54`. A commit that changes both is indistinguishable from a bug being papered
  over (`:52-54`).
- **Slice 4 before Slice 8.** `set_rate` is the only mechanism the backfill has.
- **Slice 6 can be developed in parallel with 2–5** — the engine takes the rate as an argument, so
  the fake is enough. That is the whole point of the purity rule.
- **`engine/money.ts` is never touched.** If a diff to `money.ts` appears in this work, something has
  gone wrong: `toRsd` and `round2` already implement §1.5 and carry 354 frozen cases
  (`money.test.ts`) plus the 13 that closed the GAP 1 truncation mutant (`money-guards.test.ts`).

**Test rates for the whole fleet: `EUR = 117.5`, `USD = 101`** (Danilo), deliberately unlike the live
117.3510 / 101.2869 so a test cannot pass by reaching the network. Corroboration worth having:
`117.5` is **already** the frozen suite's EUR rate (`invoicing.test.ts:848, 880, 949`) and the rate
implied by `fold-guards.test.ts:198`'s `−100 EUR / −11750 RSD`. The fleet is consistent with what
exists. One arithmetic warning about these two rates is in §6, Q6 — read it before writing the
rounding guards.

---

## 6. What I am not sure about

Six, in the order I would want them answered.

**Q1 — Is `confirmAboveAmount` denominated in RSD, or in the book's own currency?** *(blocks Slice
5.)* `Book.currency` is per-book (`types.ts:32`) and `confirmAboveAmount` carries no declared unit
(`types.ts:39-40`). Two facts pull opposite ways: `02-WHATSAPP-INTERFACE.md:197` states the threshold
in **euros** (*"Booking 200 EUR of cotton auto-commits"*), and the frozen SMOQUA fixture declares
`currency: 'EUR'` with `confirmAboveAmount: 500` (`nlu.test.ts:84-104`). If the threshold is in the
book's currency and SMOQUA's real book currency is EUR, then comparing an **RSD** LCY figure against
a **500 EUR** threshold is a fresh ~117× hole facing the other way — a 400 EUR purchase would read as
47,000 against 500 and always ask. Cleanest resolution: **thresholds are always RSD**, and
`_state/books.json` restates SMOQUA's 500 as ~58,750 RSD. That is an operator data edit, and it is a
decision about money, so it is yours.

**Q2 — May the backfill change a figure in a package already sent?** *(blocks Slice 8, not Slices
1–7.)* Going from `amountRsd: null` to a number moves a historical dinar total. My reading is that
*no answer → a dated answer* is materially different from *one answer → another*, so it is
allowable — but it is the exact thing the freeze-at-capture ruling protects against, so I will not
assume it. §4's staged plan (generate, diff against the sent packages, show, stop) is written to make
this a decision with the deltas in front of you rather than a surprise in December.

**Q3 — Does a stale rate set `needs_review`, or only flag?** Under the fallback ruling a stale rate
is normal, not exceptional, so `needs_review` on every one of them would drown the queue — precisely
the alarm-fatigue failure `04-PERSONAL.md` §2 warns about and `UNFREEZE-LOG.md:232-234` invokes.
NBS publishes on working days, so **every Saturday, Sunday and holiday transaction is stale by
construction** — a large fraction of personal spend. My recommendation: staleness flags in the
manifest and in `/tebra`, and `needs_review` **only** when there is no rate at all. `05-SMOQUA.md:130`
and `07-ROADMAP.md:589` say otherwise today and need the matching edit either way.

**Q4 — How stale is too stale?** A weekend gap is 1–3 days and unremarkable. A currency whose last
fetched rate is from March is a different thing wearing the same encoding, and `rateDate` alone does
not distinguish them without a policy. I have deliberately **not** invented a threshold — any number
I picked would be the `MAX_TOLERANCE = 100` of this change (`TEST-FREEZE.md:125-128`): a constant in
the code that appears in no spec, which someone later "cleans up" and breaks. If there is a bound,
it is yours to state; if there is not, the flag alone is the answer and I will write that down.

**Q5 — Rename `PdfInvoiceData.exchangeRate` to `rate`, or keep two names?** Keeping both means the
codebase has two names for one number on two surfaces. Renaming means unfreezing
`invoicing.test.ts:872` and `:913`, which assert `data.exchangeRate` by name — an unfreeze bought for
consistency, which the `TEST-FREEZE.md:36-42` bar does not obviously admit. **My recommendation: keep
both names and document the divergence** (done, §1.2). Flagging it because it is a decision, not an
oversight, and because a future reader will read the inconsistency as a mistake unless it is signed.

**Q6 — `USD = 101` cannot detect a truncating conversion, and that is arithmetic, not opinion.**
For any amount with at most 2 decimals, `101 × n/100 = 101n/100` has **exactly** two decimals, so
`round2` and `Math.floor(x*100)/100` are identical for every input. Measured: 110,446 pairs at rate
101, **zero** divergences, versus 9.76% at 117.5. So a rounding guard written at the USD test rate is
blind by construction — the same hole `money-guards.test.ts` was created to close
(`UNFREEZE-LOG.md:133-152`, GAP 1). The fleet's rounding cases must use **EUR at 117.5 with
cent-level amounts** (measured discriminators: `0.01 @ 117.5` gives `1.18` rounded, `1.17` truncated;
`money-guards.test.ts:35-57` lists four more). Two ways out: accept EUR-only coverage of the rounding
guard, or set the USD test rate to something with a fractional part. Not urgent, but it decides how
the test fleet is written, so it belongs before Slice 2 rather than after.

---

## Appendix — the whole change, as one measurement

| | count | freeze status |
|---|---|---|
| `src/` files changed | 4 (`types.ts`, `ledger/fold.ts`, `ledger/normalize.ts`, `nlu/confirm-policy.ts`) | — |
| `src/` files deliberately **not** changed | `money.ts` (`toRsd`, `round2` already correct) | — |
| compile-break sites | **8** — 1 in `src/`, 7 fixture builders in `test/` | 5 frozen; all permitted by `TEST-FREEZE.md:26` |
| frozen assertions broken | **1** — `nlu.test.ts:916-922` | pre-authorized (C-006, Danilo 2026-08-17) |
| post-freeze cases needing a rewrite | **3** — `fold-guards.test.ts:176, 186, 196` | editable; preserve the mutants they kill |
| new `LedgerEvent` op | **1** — `set_rate` | assertion-neutral (measured) |
| suite with §1 applied and fixtures repaired, no behaviour change | **3132 / 3132 green** | measured |
| suite with the full change including the LCY gate | **3131 passed, 1 failed** | measured; the 1 is C-006 |
