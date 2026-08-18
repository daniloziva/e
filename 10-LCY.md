# E — LCY (local currency)

**Status: reconciled and fully ruled. C1–C4 all closed 2026-08-18. No open decisions.** Two
independently-derived drafts sit alongside as evidence — `10-LCY-draft-model.md` (data model, freeze
impact) and `10-LCY-draft-pipeline.md` (rate source, storage, fallback). **This file is the
authority** wherever they disagree with each other or with the rulings below. Read the
Reconciliation section rather than the drafts.

The two drafts were written without seeing each other and **converged** on three things, which is
the strongest signal in either of them: `rateDate` means the date the rate is *for*; RSD rows carry
`rate: 1`; and a missing rate falls back to the newest rate *at or before* the document date.

---

## Rulings — Danilo, 2026-08-17

### 1. The stored value

**The LCY amount is stored on every transaction. It is never recomputed at read time.**

> "the LCY value should still get stored onto each transaction. so that I dont have to cacluate
> backwards when reporting or reviewing history."

This settles the model draft's central question in its favour: **LCY *is* `Transaction.amountRsd`**
(`types.ts:107`) — already stored per row — and what gets added beside it is the *rate*:

```
rate:     number | null      the rate applied, at full precision (4dp)
rateDate: string | null      the date that rate is FOR (not the date it was fetched)
```

RSD rows get `rate: 1, rateDate: txDate`.

The ruling closes an existing defect rather than only adding a field. Today `fold.ts:253-258`
reconstructs the rate by dividing an already-rounded `amountRsd` by `amount` — literally the
backwards calculation the ruling forbids. Measured over 110,446 correction pairs, that reconstruction
disagrees with the true rate in **9.76%** of cases at 117.5 (max 0.01 RSD). Small in money, but it
means the rate on file today is a guess.

Rejected: a second RSD field beside `amountRsd`. Two RSD numbers on one row are two answers to one
question, which is exactly what `aggregate.ts:243-250` exists to refuse. Also rejected: renaming
`amountRsd`, which would put ~130 assertion sites into an unfreeze commit instead of eight lines.

### 2. Rate source — endpoint switched

**Approved.** The source is `ExchangeRate/IndexByDate?Date={D.M.YYYY.}&ExchangeRateListTypeID=3`,
not the two-currency `IndexNew_Partial_IndikativniKurs` widget originally specced.

Verified live, unauthenticated, no cookie/JS/captcha: **34 currencies for any past date.** For
2026-08-14 it returns EUR 117,3433 · USD 101,6575 · CHF 124,9529 · GBP 137,2276. Cross-checked
against the widget for 2026-08-17: EUR 117,3510 / USD 101,2869 from both. Same host and same
anonymous GET as the company registry, so this does **not** reopen the "no paid API until the PoC is
validated" ruling.

Three constraints previously recorded as facts were artifacts of the endpoint, not of NBS, and are
withdrawn:

| Withdrawn claim | Reality |
|---|---|
| "only today's rate, no history" | any date; ≈8 requests backfill the whole `validate.ts` window `[now − 18 months, now + 2 days]`, so **no cold start** and no backdated document takes the fallback on day one |
| "only EUR and USD" | all 34, so `Transaction.currency`'s five-value union is fully served |
| implied: E needs a Serbian holiday calendar | **it does not, anywhere** — NBS resolves weekends and holidays server-side |

**`RowKey` is the APPLICATION date, not the formation date.** NBS forms a list on a working day and
it applies from 08:00 until the next is formed — the page states this. Keyed by formation date,
weekends have no row; keyed by application date, every calendar day resolves. Reported measurement
(not independently verified): 115 of 366 days carry an earlier list, so the formation-date reading
would fire the staleness flag on ~31% of all documents forever.

**Parser trap, verified:** the widget's class names are prefix-colliding — `kurs_d` is a prefix of
`kurs_date`, and `kurs_e` of `kurs_e_2`, which holds the *label* `EUR/RSD` rather than a number.
Exact class-token matching only. A `startsWith` or `/class="kurs_d[^"]*"/` read silently returns the
wrong cell. Applies to any endpoint on this app.

**Also verified:** `parseAmount('117,3510')` returns **null** — `money.ts:87` refuses more than two
decimals. So "the rate parser is not the fiscal-receipt money path" is true by construction today,
and a test must keep it true. Rates are 4dp; store the rate at full precision and round only the
product, once, via `round2`.

### 3. Threshold comparison — book currency

**`confirmAboveAmount` is denominated in the book's currency**, not RSD and not the transaction's.

`Book.currency` already exists (`types.ts:33`) and books are genuinely mixed: the frozen fixtures
carry an EUR book with threshold 500 (`nlu.test.ts:91,98`) and an RSD book with 20000 (`:109,111`).
So this is a real cross-currency comparison, not a relabelling.

**LCY is the pivot, which makes the rule uniform including the RSD case:**

```
amountInBookCurrency = amountRsd / rateOf(book.currency, rateDate)      rateOf(RSD) = 1
```

Worked against the ruled test rates (EUR 117.5, USD 101):

| Book | Threshold | Amount | → book currency | Decision |
|---|---|---|---|---|
| EUR | 500 | 400 EUR | 400.00 EUR | commit |
| EUR | 500 | 60,000 RSD | 510.64 EUR | confirm |
| RSD | 500 | 400 EUR | 47,000 RSD | **confirm** ← C-006's hole, closed |

The last row is the ~117× hole: today `confirm-policy.ts:68` compares `money.amount` raw, so
`400 >= 500` is false and 47,000 RSD of spend commits with no tap.

**Consequence for the freeze, and it needs re-deriving.** Both frozen threshold tests use **RSD**
books, so under this rule `200 EUR` = 23,500 RSD is still under a 50,000 threshold and
`nlu.test.ts:916-922` **still passes**; `:905-914` and `:896` also survive. The model draft's
"exactly 1 frozen test breaks" was derived under a different assumption about these semantics and
must be re-measured. The likely outcome is **zero unfreezes needed** — but `:916`'s title
("compares the raw amount against the threshold") becomes false and its fixture can no longer
distinguish the fix from the bug. That wants a **new discriminating test** (the third row above),
not an unfreeze. Do not treat the pre-authorization as evidence an unfreeze is required.

### 3b. A dated rate is immutable

> "the currencies will never change. once a currency for 0801 always stays"

**A published rate for a given date never changes.** This is Danilo's domain call, not something E
measures, and it is the single most simplifying fact in this design. Consequences, all of which
delete work:

- **The cache is write-once.** `putIfAbsent` semantics, never upsert. No compare-and-swap, no ETag
  round-trip, no TTL, no invalidation, no refresh of an existing row. A second write for the same
  `(currency, date)` is a duplicate and may be dropped without reading the stored value.
- **Backfill is idempotent.** Any date range may be re-requested at any time and the answer is
  identical, so a failed or partial backfill is retried by simply running it again. No resume
  bookkeeping, no cursor.
- **The only fetch that ever matters is for a date not yet held.** Nothing ages out.
- **The stale path narrows to one narrow case.** Since any past date is fetchable and final, a rate
  can only be *missing* for a date NBS has not published yet — in practice a same-day capture before
  the list is formed at 08:00 local. Every other gap is a backfill away. The fallback in §4 is
  therefore a same-day window, not a general condition, which is why Danilo is right that it
  "shouldn't really fail ever."
- **It makes every flagged transaction repairable, deterministically.** The legally correct
  rate-of-the-day is always eventually knowable, so `rateDate !== txDate` is a *temporary* state
  rather than a permanent compromise. That substantially defuses the Article 41 question below: the
  question stops being "is a stale rate acceptable in a filing" and becomes "by when must it be
  corrected" — and the natural gate is before the monthly package is sent, which is the same gate as
  open item 2.

**One guard.** The source URL pins `ExchangeRateListTypeID=3`, which implies other list types exist.
If NBS ever issues a *corrected* list under a different type id, E would not see it — immutability
would hold for type 3 while the operative rate had changed elsewhere. Not a blocker and not worth
engineering around now, but it is the assumption that would break this section, so it is written
down rather than assumed away.

### 4. Staleness

**`RATE_STALENESS_MAX_DAYS = 7`, and flag regardless of whether the bound is breached.**

> "yeah set 7 but flag anyhow. shouldnt really fail ever"

Two separate mechanisms, deliberately:

- **The flag fires whenever `rateDate !== txDate`.** Always, at any age. It needs no boolean field —
  the inequality *is* the flag, which is why no `rateStale` column is specified.
- **The 7-day bound** governs the confirm path only: beyond it, treat the rate as unusable and
  require the tap rather than commit on it.

Seven is defensible against measurement rather than taste — max legitimate staleness observed is 4
days and the max inter-list gap 5 (the New Year holiday) — and Danilo is right that with history
now backfillable it should essentially never fire. No "too stale to store" bound was invented; that
would become this change's `MAX_TOLERANCE`.

### 5. Test rates

Fixed constants, deliberately different from any live value so a test cannot pass by reaching the
network:

```
EUR = 117.5      ruled
USD = 101        ruled
CHF = 125        ruled 2026-08-18
GBP = 136        ruled 2026-08-18
```

All four are set. CHF 125 and GBP 136 sit near but not on the observed spot values (CHF 124,9529 /
GBP 137,2276 on 2026-08-14), which is the property that matters — a test constant equal to a live
value can pass by accident.

**One caution on the ruled values.** A test rate must be able to distinguish a correct conversion
from a truncating one, which is the hole `money-guards.test.ts` exists to close. Measured over every
cent from 0.01 to 1000.00:

| Rate | round2 vs floor divergence |
|---|---|
| USD 101 | **12.00%** |
| EUR 117.5 | 48.94% |
| USD 101.2869 (live) | 50.00% |
| EUR 117.351 (live) | 50.00% |

A round rate is four times less discriminating, so a rounding guard written only at the USD rate is
much easier to get accidentally blind. (An earlier claim that USD 101 was blind *by construction* was
wrong — the reasoning assumed `101 × n/100` is exact, but IEEE754 makes `0.15 × 101` =
`15.149999999999999`.) Prefer fractional averages for CHF and GBP when they are computed.

### 6. HTML parsing — NO dependency (Danilo, 2026-08-18)

**Parse it without a library.** Exact class-token string matching, confined to
`adapters/nbs/rate-page.ts` and nowhere else, so the fragility has a single home and the mapping
stays testable from a saved fixture with no network.

Rejected: `node-html-parser` and `cheerio`. The parse surface is one known table, the single real
hazard is already identified and testable (class names are prefix-colliding — `kurs_d` is a prefix of
`kurs_date`, `kurs_e` of `kurs_e_2` which holds a *label*, so `startsWith` reads the wrong cell), and
the repo keeps its zero-runtime-dependency property.

**`@azure/data-tables` is not part of this ruling** and needs no separate one:
`01-ARCHITECTURE.md:452` already anticipates `@azure/functions`, `pdfkit` and `openai`. The repo has
zero runtime deps only because nothing but the engine exists yet; the adapter layer arriving with
dependencies is the plan.

---

## Reconciliation of the two drafts

Read this instead of the drafts. They stay on disk as evidence; where they disagree with each other
or with the rulings above, this section is the authority. Both are dense and mostly
**complementary** — the model draft owns the shape and the freeze, the pipeline draft owns the source
and the store, and they overlap in exactly four places.

### Resolved — no decision needed from you

**R1. Who performs at-or-before selection.** The model draft puts it in the adapter
(`rate-store.latestRateAtOrBefore(currency, onDate)`); the pipeline draft puts `get / getRange /
insertIfAbsent` in the adapter and `selectRate` in `engine/rates.ts`. **The pipeline draft wins, on a
technical fact:** Table Storage has no descending sort, so "newest row at or before X" cannot be a
top-1 query — it is a bounded range read plus a choice. Selection is therefore a pure function and
belongs in `engine/`, where it is coverage-gated and fixture-tested. The adapter returns rows; the
engine picks. Exactly one half owns selection.

**R2. "No cold start" and "backfill the ledger" are different problems.** They read like a
contradiction and are not. The pipeline draft's *no cold start* is about the **rate table** — history
is fetchable, so ~8 requests fill the whole validation window. The model draft's *Option B backfill*
is about **ledger events already written**, which carry no rate at all and cannot be edited, because
one immutable blob per event means there is no `UPDATE`. Both are true and both are needed.

**R3. `reviewStatus` for a missing versus a stale rate.** The drafts appear to disagree; they are
describing different cases. Combined with your §4 ruling, the full table is:

| situation | `rate` | `amountRsd` | flag | `reviewStatus` |
|---|---|---|---|---|
| rate for the document's own date | the rate | computed | none | `ok` |
| older rate, within 7 days | that rate | computed | `rateDate !== txDate` | `ok` |
| older rate, beyond 7 days | that rate | computed | `rateDate !== txDate` | `needs_review` + tap |
| no rate for this currency at all | `null` | `null` | — | `needs_review` + tap |

Your "flag anyhow" ruling is the third column: it fires on any staleness, at any age. The 7-day bound
governs only whether the confirm path will *act* on the rate.

**R4. Storage is insert-only, and a 409 is a monitoring signal.** Your immutability ruling (§3b) plus
the pipeline draft's §3.2 give a better rule than either alone: on `409 EntityAlreadyExists`, read
the stored row and compare. Equal → silent no-op, the normal case. **Unequal → do not write, and
raise it loudly.** A rate for a past date cannot legitimately have changed, so a divergence is close
to unfalsifiable evidence that the parser broke or is reading the wrong column. That is the single
best monitoring signal in this pipeline and it exists for free.

### C1 — RESOLVED (Danilo, 2026-08-18): pass the pre-converted amount

**Both drafts assume the threshold moves to RSD. You ruled it moves to the book's currency.**

The pipeline draft says it outright — *"The whole point of LCY is that the threshold moves to RSD"* —
and the model draft encodes it in the signature it proposes:

```
decide(interpretation, book, amountRsd: number | null = null)      ← insufficient
```

`amountRsd` alone cannot evaluate a threshold denominated in EUR. Under your ruling the comparison
needs the book currency's rate as well, so the parameter has to be either the pre-converted
`amountInBookCurrency`, or the pair `(amountRsd, bookCurrencyRate)`.

**Recommendation: pass the pre-converted amount.** `decide()` stays a pure comparison with no
arithmetic, `app/` does the conversion where the rates already are, and the engine never needs a
second rate lookup. It also keeps the RSD case free, since `rateOf('RSD') = 1`.

**The consequence you should know:** for a non-RSD book this needs **two** rate reads for one
decision — the transaction's currency and the book's currency, both for the same date. On the
confirm path, which is "cache or do without", a miss on *either* means the tap. That makes the tap
marginally more likely for SMOQUA (the EUR book) than for the RSD books.

### C2 — RESOLVED by measurement, 2026-08-18: **LCY needs no unfreeze**

The question was only ever "does LCY need an `UNFREEZE:` commit". It does not. Measured, not argued.

**Reason 1 — the widened `reason` union breaks nothing.** Nothing in the codebase switches on
`Decision.reason`; `confirm-policy.ts` only ever *produces* it, at `:56`, `:59` and `:69`. So adding
`'no_rate'` to the union at `:6` is a pure widening: compile-safe, runtime-neutral, and every existing
assertion compares a specific value that is unchanged. `nlu.test.ts:1018` says so outright —
*"Ordering among the confirm reasons is unspecified; only the tap is pinned."*

**Reason 2 — every frozen threshold case gives the same answer under both semantics.** All seven were
enumerated from source and run against the real `decide()`:

```
case                                current   book-ccy   differs?
it.each 400 EUR / SMOQUA            commit    commit
:880  500 EUR at threshold          confirm   confirm
:887  19999 RSD / PERSONAL          commit    commit
:887  20000 RSD / PERSONAL          confirm   confirm
:895  0.01 EUR / zero threshold     confirm   confirm
:905  1200 RSD / 1000               confirm   confirm
:916  200 EUR / 50000 RSD book      commit    commit
NEW   400 EUR / 500 RSD book        commit    confirm    <<< DIFFERS
```

Zero frozen assertions change. `books-commands.test.ts` never calls `decide()` at all — its
`confirmAboveAmount` values are book fixtures only.

**The finding that matters more than the answer.** Not one of the seven existing tests can distinguish
the fix from the bug. Six are currency-*matched* — the money currency equals the book currency, so the
conversion ratio is 1 and old and new agree by construction. The seventh is cross-currency but sits
below its threshold under either reading. **The ~117× hole was invisible to the suite by construction,
not by oversight** — the same non-discriminating-fixture pattern that let a truncating `toRsd` survive
547 cases including all 354 money cases.

So the deliverable here is not an unfreeze, it is **the test nobody wrote**: the last row above.
`400 EUR` against a `500` threshold on an **RSD** book must confirm. That single case is the entire
behavioural content of CANDIDATE-006, and it needs at least one sibling per direction so the guard
cannot silently invert.

### C3 — WITHDRAWN (Danilo, 2026-08-18): there is nothing to backfill

> "tehres nothing to backfill. still draft. when I push this it will have a clean slate."

E has never processed a document. There are no ledger events, no sidecars and no packages sent, so
there is no historical data to give rates to and nothing whose figures a backfill could move.

**This deletes the whole of `10-LCY-draft-model.md` §4** — options A/B/C, the `set_rate` migration
script, the read-only diff, the staged-approval ceremony, and the open question about moving a total an
accountant already holds. All of it was reasoning about data that will not exist.

Two things survive from that section and should not be lost with it:

- **`set_rate` stays as a `LedgerEvent` op.** Its justification was never the migration; it is that
  ledger events are immutable one-blob-per-event with no `UPDATE`, so a correction to a rate — from
  `/tebra`, or after a stale capture is repaired — has no other expression.
- **`rate: number | null` stays nullable.** Not for historical rows, but for the live same-day window
  in §3b where NBS has not published yet.

### C4 — ACKNOWLEDGED (Danilo, 2026-08-18): not closed by LCY

**LCY does not retire the tebra grand-total currency pooling.** I said it would; that was wrong, and
the model draft verified it. The pooling lives on `field: 'amount'`, and `tebra.test.ts:494-499`
correctly requires that query to succeed. Measured: `['currency']`, `['category']` and `['vendor']`
still pool to −6100 against an honest −17750. **M4.5's render-layer suppression still has to be
built** — LCY makes it a substitution rather than a hole, not moot.

### Smaller items carried forward from the drafts

- **`unit` division is unconditional.** EUR/USD/CHF/GBP are all quoted per 1, but HUF and JPY are per
  100 (measured: HUF 32,2833). Divide always. Skipped, nothing breaks today and the ledger is out by
  100× the day someone adds JPY. Test it with a HUF row even though E does not book HUF.
- **Ingest only the four foreign codes in `types.ts:7`,** not all 34. The list carries BEF, GRD, SKK,
  SIT and HRK — dead currencies.
- **RSD must never touch the store.** `resolveRate(deps, 'RSD', d)` returns `{ rate: 1, rateDate: d }`
  as a constant. Guard test: empty table, network unreachable, an RSD receipt still books and still
  commits without a tap. PERSONAL is entirely RSD and the highest-volume book; a cache miss must
  never be able to make a dinar receipt need a confirmation.
- **A missing rate must never block storage.** `01-ARCHITECTURE.md:350` — the bytes land first,
  always. The confirmation is about the transaction, not the paper.
- **The reply must not show a number E is not confident in.** State the original amount and that the
  RSD equivalent is unknown.
- **UNVERIFIED, worth checking before planning the sidecar half:** whether the document sidecar write
  path permits an overwrite. `01-ARCHITECTURE.md:174` says no overwrite of *documents* ever and is
  silent on the `.json` sibling.
- **Azurite table-storage support in CI** is assumed by the pipeline draft, not measured.
- **Where `rate`/`rateDate` land besides the ledger event** — `03-DILIGAF.md:246` makes the invoice
  wizard a third interactive consumer alongside WhatsApp capture and `/tebra`.
