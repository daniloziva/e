# 10 — LCY: the rate pipeline

> **Draft scoping document, rate-pipeline half.** Where the rate comes from, how it is cached, and
> what happens when it is missing. The engine/ledger half — `rate` + `rateDate` on the event, LCY
> thresholds, LCY reporting, cross-currency comparison — is a separate document.
>
> No code was written for this. Every number below was measured against the live NBS site or run
> against `e-app/dist/engine/money.js` on **2026-08-17**; anything unmeasured is labelled
> **unverified**.

## 0. Decisions this builds on, not re-argued

| Decision | Where |
|---|---|
| Rate cache in Azure Table Storage, `PartitionKey` = currency, `RowKey` = date, same storage account as blob | `01-ARCHITECTURE.md:68-89` |
| Rate frozen at capture as `rate` + `rateDate` on the ledger event; staleness **derived** from `rateDate !== documentDate`, no boolean | `01-ARCHITECTURE.md:78` |
| Missing rate → use the most recent fetched rate and flag it. Not refuse, not null | Danilo |
| Test rates fixed at EUR = 117.5, USD = 101 | Danilo |
| Source is the public NBS scrape, not the licensed SOAP API, until the PoC is validated | `07-ROADMAP.md:131-137` |

Two of those get *refinements* below (§3 on "most recent", §2 on the write rule for today's row).
Neither is a reversal, and both are called out as needing a ruling in §8.

---

## 1. The source: what I measured, and one thing the brief has wrong

### 1.1 The briefed endpoint, confirmed

`GET https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRateRsd/IndexNew_Partial_IndikativniKurs?lang=cir`

Confirmed exactly as documented: HTTP 200, no auth, no cookie required, no JS, no captcha, 2,625
bytes (`lang=cir`) / 2,339 bytes (`lang=lat`), 0.100–0.160 s over five calls. Live values at fetch
time:

```html
<tr><th class="kurs_date">званични за  17.8.2026.</th></tr>   ← note the DOUBLE space, and D.M.YYYY.
<tr><th class="kurs_e_2 panel-date">EUR/RSD</th> …
<tr><th class="kurs_e">117,3510</th><td class="danger hidden-xs">0,0</td> …
<tr><th class="kurs_d_2 panel-date">USD/RSD</th> …
<tr><th class="kurs_d">101,2869</th><td class="warning hidden-xs">0,4</td> …
```

Confirmed and worth pinning:

- The label **does** read `zvanični` (official) on an endpoint named `IndikativniKurs`. **Do not
  "fix" this URL.** Renaming it to something that looks more correct breaks the fetch, and the
  mismatch is the site's, not ours. (§1.3 removes the need to depend on it at all, which is a better
  fix than a comment.)
- `lang` is load-bearing but only two-valued: `lang=lat` renders `zvanični za  17.8.2026.`;
  `lang=cir`, `lang=en` and *no* `lang` all render Cyrillic `званични за`. **`lang=en` is silently
  ignored.** So the parser must never key on a word — only on class attributes and digits.
- Class names are prefix-colliding. `kurs_d` is a prefix of `kurs_date`, and `kurs_e` a prefix of
  `kurs_e_2` (which holds the *label* `EUR/RSD`, not a number). A regex like `/class="kurs_d[^"]*"/`
  or a `startsWith('kurs_e')` check reads the wrong cell. Exact class-token matching only.
- `th.kurs_date` appears **twice**, once per `<tbody>`. Not a unique selector.
- The `td.danger` / `td.success` cells carry percentage deltas in the same comma format at 1dp
  (`0,0`, `-0,1`). A "find the first comma-decimal number" parser reads a delta as a rate.

### 1.2 …and its two hard limits, also confirmed

- **Only EUR and USD.** No CHF, no GBP.
- **Only today.** I tried `date=`, `Date=`, `datum=`, `onDate=`, both `14.8.2026.` and `2026-08-14`.
  Every one returned today's list, 117,3510. The endpoint takes no date parameter.

### 1.3 The finding that matters: the same public app serves history and all currencies

This is a change to a *verified fact*, so it needs Danilo's sign-off (§8, Q1) — but it does not
reopen the scrape-vs-paid-API ruling. It is still the same host, still a plain unauthenticated GET,
still HTML, still free, still no licence, no `LicenceID` GUID, no registration. It is the same
decision, executed against a better route on the same site.

`https://webappcenter.nbs.rs/ExchangeRateWebApp/` links three sibling routes. Two of them are what
this pipeline actually wants:

**A. Point lookup for an arbitrary date — `ExchangeRate/IndexByDate`**

```
GET /ExchangeRateWebApp/ExchangeRate/IndexByDate
      ?isSearchExecuted=true
      &Date=14.8.2026.                 ← D.M.YYYY. with the trailing dot, not zero-padded
      &ExchangeRateListTypeID=3        ← 3 = Srednji kurs (official middle rate). MANDATORY, see §7
      &lang=lat
```

A plain GET form (`<form id="searchParamForm" method="get">`), 23,118 bytes, 0.113–0.227 s. Renders
`KURSNA LISTA BR. 153 / ZA ZVANIČNI SREDNJI KURS DINARA / FORMIRANA NA DAN 14.8.2026. GODINE` and a
34-row table:

| OZNAKA VALUTE | ŠIFRA VALUTE | NAZIV ZEMLJE | VAŽI ZA | SREDNJI KURS |
|---|---|---|---|---|
| EUR | 978 | EMU | 1 | 117,3433 |
| CHF | 756 | Švajcarska | 1 | 124,9529 |
| GBP | 826 | Velika Britanija | 1 | 137,2276 |
| USD | 840 | SAD | 1 | 101,6575 |
| HUF | 348 | Mađarska | **100** | 32,2833 |

**B. Bulk range for one currency — `ExchangeRate/IndexPeriod`**

```
GET /ExchangeRateWebApp/ExchangeRate/IndexPeriod
      ?isSearchExecuted=true
      &DateFrom=1.8.2026.&DateTo=17.8.2026.
      &CurrencyCode=978                ← numeric ISO code: EUR 978, USD 840, CHF 756, GBP 826
      &ExchangeRateListTypeID=3
      &WorkingDays=2                   ← 1 = business days only (DEFAULT), 2 = every calendar day
      &lang=lat
```

Columns: `DATUM FORMIRANJA | DATUM PRIMENE | VAŽI ZA | SREDNJI KURS`. 147,438 bytes for one year,
0.176–0.282 s.

**The two dates in that table are the whole design.** With `WorkingDays=2` NBS itself performs the
weekend/holiday roll-forward and shows its work:

```
31.7.2026.  1.8.2026.  1  117,3963     ← Saturday, carrying Friday's list
31.7.2026.  2.8.2026.  1  117,3963     ← Sunday, same
 3.8.2026.  3.8.2026.  1  117,3863
 7.8.2026.  8.8.2026.  1  117,3582     ← Saturday
14.8.2026. 15.8.2026.  1  117,3433     ← Saturday
17.8.2026. 17.8.2026.  1  117,3510
```

`IndexByDate` applies the same rule server-side: asking for Sat 15.8 or Sun 16.8 returns list 153
formed 14.8; asking for Orthodox Christmas 7.1.2026 returns list 1 formed 5.1.2026; asking for
1.1.2026 returns list 251 formed 31.12.2025.

**E therefore never needs a Serbian public-holiday calendar, anywhere.** That is a whole class of
work and a whole class of annual maintenance eliminated, and it is worth more than the endpoint
switch itself.

### 1.4 Measured properties of the source, for the record

Fetched `IndexPeriod`, `WorkingDays=2`, `2025-08-17 → 2026-08-17`, one request per currency:

| | rows | unit (`VAŽI ZA`) | 12-month min | max | 2026-08-17 |
|---|---|---|---|---|---|
| EUR | 366 | `1` on all 252 business days | 117.1546 | 117.4414 | 117.3510 |
| USD | 366 | `1` | 97.8614 | 103.3044 | 101.2869 |
| CHF | 366 | `1` | 124.1419 | 130.2275 | 124.7884 |
| GBP | 366 | `1` | 132.2834 | 138.5080 | 137.2526 |

- **366 calendar days → 366 rows, zero gaps.** Every single day in the year is covered.
- **252 distinct lists** (68.6% of days have their own list). The other **115 days (31.4%)** carry
  an earlier list.
- Staleness distribution (`DATUM PRIMENE − DATUM FORMIRANJA`): 0 days ×251, 1 ×54, 2 ×54, 3 ×4,
  4 ×3. **Maximum legitimate staleness in twelve months: 4 days.**
- Longest gap between consecutive lists: **5 days**, four times — 31.12.2025→5.1.2026 (New Year),
  13.2→18.2.2026 (Statehood Day), 9.4→14.4.2026 (Orthodox Easter), 30.4→4.5.2026 (Labour Day).
- Cross-endpoint agreement: on 17.8.2026 `IndikativniKurs` reports EUR **117,3510** / USD
  **101,2869**, and `IndexByDate` list 154 reports EUR **117,3510** / USD **101,2869**. Identical.
  The `IndikativniKurs` widget is a two-currency view of the official middle-rate list — which
  settles the `zvanični`-vs-`IndikativniKurs` naming worry with data rather than with a comment.
- NBS's own effective-period rule, printed on `IndexPeriod`: *"Od 8. avgusta 2006. godine kursna
  lista za zvanični srednji kurs primenjuje se od 8 časova na dan formiranja do 8 časova na dan kada
  će biti formirana naredna kursna lista."* — from 08:00 local on the formation day until 08:00 on
  the day the next list is formed. And: *"Kursevi iz ove liste primenjuju se za potrebe
  knjigovodstva i statistike … saglasno članu 41. Zakona o deviznom poslovanju."* This is the
  authority for using it for accounting, and §4's answer to "what is the rate for Saturday".
- **Range cap, undocumented and silent.** `DateTo=17.8.2026.` with `DateFrom=14.8.2025.` (368 days)
  returns 254 rows; `DateFrom=10.8.2025.` (372 days) returns **HTTP 200, zero rows, and no
  validation message**. Chunk at ≤ 365 days.
- Header format drift: from at least 2010 onward the header is `FORMIRANA NA DAN …`. For
  `1.1.2005.` it is `Na dan: 1.1.2005.` — the *queried* date, with no formation date at all. E's
  acceptance window is `[now − 18 months, now + 2 days]` (`01-ARCHITECTURE.md:348`), so this is out
  of reach; noted so nobody widens the window and inherits it.
- Response is a partial view — no `<html>`, no `<head>`. `Content-Type: text/html; charset=utf-8`.
  No `Cache-Control`. Two `Set-Cookie` headers on every response, one of them `TS0158a2e7`, which is
  an F5 ASM cookie: **there is a WAF in front.** Cookies are not required for the response to be
  correct. Whether there is a rate limit is **unverified** — one request per day plus a bounded
  backfill is nowhere near anything plausible, but a retry storm is the shape of thing that gets
  blocked, so §5's "no retries on the hot path" is a source-protection rule as well as a latency one.

---

## 2. Where the code lives, and the adapter/engine split

The precedent to copy is `di-map.ts`, not `parse-eml.ts`: *"Adapters flatten their own wire shapes
into that map, so `engine/` never learns Document Intelligence's response tree"*
(`01-ARCHITECTURE.md:336`). Same sentence, same reason: `engine/` must never learn NBS's table
markup. Three files, one boundary each.

```
src/adapters/nbs/
  client.ts        ← I/O ONLY. builds the URL, fetch(), AbortSignal timeout, returns a string.
                     knows the base URL, ExchangeRateListTypeID=3, WorkingDays=2, the
                     D.M.YYYY. wire format, and the numeric ISO currency codes.
  rate-page.ts     ← HTML string -> RawRateRow[]. DOM selection lives here and ONLY here.
                     a pure function of a string. no fetch, no clock. THE FIXTURE-TESTED HALF.

src/engine/rates.ts      ← PURE. RawRateRow[] -> RateQuote[], plus selection and staleness.
src/adapters/store/
  rate-store.ts    ← Table Storage. get / getRange / insertIfAbsent. sits beside blob-store.ts.

src/app/
  refresh-rates.ts ← composition: client + rate-page + rates + rate-store. the timer's one call.
  resolve-rate.ts  ← composition: the read path both ingest and WhatsApp use.

src/functions/
  rates-timer.ts   ← thin binding. parses the trigger, calls refreshRates(deps), returns.
```

Note that `src/adapters/`, `src/app/` and `src/functions/` **do not exist yet** — `src/` is
engine-only today, and `package.json` has zero runtime dependencies. This is the first adapter, so
it sets the pattern; write it as if three more are coming, because they are.

### 2.1 The boundary types

```ts
/** adapters/nbs/rate-page.ts output. Every field is the cell text, VERBATIM. */
interface RawRateRow {
  code: string        // "EUR"
  formedOn: string    // "14.8.2026."   as printed
  appliesOn: string   // "15.8.2026."   as printed; === formedOn for IndexByDate/partial
  unit: string        // "1"  — or "100" for HUF/JPY
  middleRate: string  // "117,3433"     Serbian comma decimal, as printed
}

/** engine/rates.ts output. Validated, typed, normalized. */
interface RateQuote {
  currency: Currency  // narrowed against types.ts:7 — an unknown code is DROPPED, not widened
  rateDate: string    // "2026-08-15"  ISO. from appliesOn.  ← the date this rate IS the rate for
  formedOn: string    // "2026-08-14"  ISO. audit only.
  rate: number        // 117.3433  — already divided by unit
  listNumber: number | null
}
```

`rate-page.ts` returns strings because that keeps every decision that could be wrong — number
grammar, date grammar, the unit division, the currency allowlist — inside the pure, coverage-gated,
fixture-driven layer. It returns `unit` rather than applying it because dividing is arithmetic and
arithmetic belongs in `engine/`.

### 2.2 `engine/rates.ts` — the pure half

```ts
parseSerbianRate(text: string): number | null       // "117,3510" -> 117.351 ; "117.3510" -> null
parseNbsDate(text: string): string | null           // "14.8.2026." -> "2026-08-14" ; "" -> null
toQuotes(rows: RawRateRow[]): RateQuote[]           // validate, narrow, divide by unit, drop junk
selectRate(quotes, currency, documentDate): RateQuote | null   // exact hit, else newest at-or-before
isStale(q: RateQuote, documentDate: string): boolean           // q.rateDate !== documentDate
```

`selectRate` and `isStale` are pure functions over an array that someone else fetched — the same
shape as `vendorIsAmbiguous(vendor, history)` (`01-ARCHITECTURE.md:371`). `isStale` is a *derived
predicate*, not a stored field; the decision forbids a stored boolean and this respects it.

**`parseSerbianRate` must not be `money.ts`'s code path, and structurally cannot be.** Verified by
execution against `dist/engine/money.js`:

```
parseAmount("117,3510")  ->  null
parseAmount("117.3510")  ->  null
```

`money.ts:87` refuses more than two digits after the comma (`if (after.length > 2) return null`) and
`money.ts:103` does the same for a dot. That is correct for money and fatal for a 4dp rate. The
house rule — *the rate parser must never be the code path that reads fiscal receipts, which print
DOT decimals* — is therefore already true by construction, and the honest way to keep it true is a
test in `rates.test.ts` asserting `parseAmount('117,3510') === null` alongside
`parseSerbianRate('117,3510') === 117.351`, so a future "let's DRY these" refactor turns red. Same
precedent as the deliberately-duplicated currency table at `money.ts:19-24`.

Accept `/^\d{1,6},\d{2,6}$/` rather than exactly 4dp. NBS is not uniformly 4dp: the notes line on
every middle-rate page prints `Kurs za XDR 1,00 iznosi: USD 1,36584` — five decimals. E does not
book XDR, but a hard 4dp assertion would be a lie about the source. Store verbatim, parse to full
precision, and *log* anything that is not 4dp rather than truncating it. A silently truncated rate
is a wrong number in a filed report.

Rounding is unchanged: `toRsd(money, rate)` (`money.ts:294`) already takes the rate as an argument
and already applies `round2` to the product only. Verified: `toRsd({300,'EUR'}, 117.351)` →
`35205.3`; `formatAmount` → `35.205,30`. And `toRsd({3000,'EUR'}, 117.1043)` → `351312.9` →
`351.312,90`, which is character-for-character the invoice line in
`02-WHATSAPP-INTERFACE.md:272`. Nothing in `money.ts` changes for this work.

*Small observation, not a change:* `money.ts:269` documents `round2` as "half-up" but the
implementation is half **away from zero** — verified, `round2(-1.005) === -1.01`. The brief says
"half away from zero", so the code is right and the comment is stale. It is reachable, because
`Transaction.amount` is signed (`types.ts:104`, negative = outflow). Comment only; flagged, not
touched.

### 2.3 The fixtures

Both are public data with no personal detail, so both commit (`test/fixtures/README.md`). Naming
follows `f4-nis-petrol-2026-08-06.json`:

| | file | bytes | what it unblocks |
|---|---|---|---|
| **F12** | `f12-nbs-middle-rate-bydate-2026-08-17.html` | 23,118 | `rate-page.ts` `IndexByDate` parse: 34 rows, the three `<h6>` headers, `VAŽI ZA` |
| **F13** | `f13-nbs-middle-rate-period-eur-2026-08.html` | 22,882 | `IndexPeriod` parse, incl. the four rows where `appliesOn !== formedOn` |
| **F14** | `f14-nbs-indikativni-kurs-2026-08-17.html` | 2,625 | the briefed partial, kept as the liveness probe's fixture and the class-collision regression |

`test/fixtures/README.md` needs three rows added; I have not edited it. F12–F14 are the cheapest
fixtures in the project — one `curl` each, no ask of Danilo's time — and they are the reason
`rate-page.ts` needs no network in CI, which `01-ARCHITECTURE.md:482` requires.

`test/fakes/rate-store.ts` — an in-memory `Map<string, RateQuote>` honouring insert-only semantics,
seeded with **EUR 117.5, USD 101.0**. Contract tests for the real store run against Azurite, which
starts blob and table together, so §11's "no network in CI" holds. (Azurite table support: not
measured in this container — **unverified**, and worth ten minutes before committing to it.)

*On the fixed test rates.* EUR = 117.5 sits **outside** the measured 12-month range
(117.1546–117.4414) — but by only 0.0586, and the RSD is de facto managed against the EUR, so that
margin is structural rather than generous. USD = 101.0 sits **inside** the measured range
(97.8614–103.3044); USD has traded on both sides of it this year. The guarantee is still sound —
matching to 4dp on the day a test runs is a ~1-in-10,000 coincidence — but it is a *value*
guarantee only. A test asserting `amountRsd !== null` passes against the network just as happily.
The thing that actually keeps the network out is that `engine/` cannot fetch and CI has no network;
the fixed rates are the second line, not the first.

---

## 3. The Table Storage schema

One table, name `exchangeRates`. Azure table names are alphanumeric, 3–63 chars, must start with a
letter — `exchange-rates` is invalid, so do not reach for the kebab-case the blob paths use.

| | value | Edm type | note |
|---|---|---|---|
| `PartitionKey` | `"EUR"` | String | the ISO code. **Never `"RSD"`** — see §3.3 |
| `RowKey` | `"2026-08-15"` | String | ISO, zero-padded. **The application date** — see §3.1 |
| `rate` | `"117.3433"` | String | verbatim from `SREDNJI KURS`, comma → dot, unit **not** applied |
| `unit` | `1` | Int32 | `VAŽI ZA`. 1 for all four of E's currencies, verified over 252 days each |
| `formedOn` | `"2026-08-14"` | String | `DATUM FORMIRANJA`, ISO. Audit only |
| `listNumber` | `153` | Int32 | `KURSNA LISTA BR.` Cross-check, never an identity |
| `listType` | `"middle"` | String | pinned. If buy/sell were ever wanted it is a second *table*, not a partition |
| `source` | `"nbs:IndexByDate"` | String | or `nbs:IndexPeriod`. Which route wrote the row |
| `fetchedAt` | `2026-08-17T08:00:12Z` | DateTime | UTC |
| `schemaVersion` | `1` | Int32 | |

**`rate` is a String, deliberately.** `Edm.Double` would round-trip 117.3510 to the same double
`Number("117.3510")` produces, so nothing is *lost* numerically — but Storage Explorer would show
`117.351`, and "was the source 4dp?" stops being answerable from the row. Since the whole value of
this table is being auditable after the fact, the stored text should be what NBS printed. The
adapter parses it once on read. `Edm.Double` is defensible; this is the more honest default.

Size: 4 currencies × 366 days ≈ 1,464 rows/year at roughly 300 bytes ≈ 440 KB/year. Ten years is
under 5 MB and a few thousand transactions. The cost is not zero, it is *unmeasurable*.

### 3.1 `RowKey` is the application date, not the formation date

This is the single most consequential detail in the schema, and getting it backwards quietly ruins
the flag.

The source gives two dates. If `RowKey` (and therefore the frozen `rateDate`) were the **formation**
date, then `rateDate !== documentDate` would be true for **115 of every 366 days — 31.4% of all
calendar dates**, every weekend and every public holiday, forever. Roughly a third of all non-RSD
documents would carry a staleness flag that means nothing, and a flag that fires on a third of
everything is a flag nobody reads.

With `RowKey` = **application date** (`DATUM PRIMENE`), a Saturday-dated invoice resolves to
`rateDate === "2026-08-15" === documentDate` → not stale — which is not a convenient fiction but
literally what NBS asserts: list 153 *applies on* 15.8.2026. `formedOn` is kept as a property so the
provenance is never lost. `rateDate !== documentDate` then means exactly one thing: **we did not
have the official rate for that date and substituted something else.** That is what the flag is for.

Consistency check against the existing spec: `02-WHATSAPP-INTERFACE.md:272` renders
`Srednji kurs NBS 15.08.2026: 1 EUR = 117,1043 RSD` — and 15.08.2026 is a **Saturday**. The spec
already assumes a Saturday has a rate of its own. This reading is the one that makes that line true.

### 3.2 Duplicate write for a date already present

`insertIfAbsent`, mirroring blob's `putIfAbsent` (`01-ARCHITECTURE.md:53`): `createEntity`, and a
**409 `EntityAlreadyExists` is success-as-no-op**, never an error. This is also the idempotency
mechanism for timer double-fire on scale-out (`01-ARCHITECTURE.md:454`), so no
`_state/notified/*` marker is needed for this timer.

Never `upsertEntity`. An official middle rate for a past date is a historical fact; overwriting it
would silently move a report already sent to the accountant, which is the exact hazard the
freeze-at-capture decision exists to prevent (`01-ARCHITECTURE.md:78`).

But do not swallow the 409 blind:

```
409 → read the stored row
       stored.rate === fetched.rate  → no-op, silent. the normal case.
       stored.rate !== fetched.rate  → DO NOT WRITE. log a divergence at warning, surface in
                                       /status. this is the loudest available signal that the
                                       parser broke or is reading the wrong column (§7c).
```

A divergence on a past date is close to unfalsifiable evidence of a bug, because the source value
cannot have changed. Throwing that away to keep the log quiet would be discarding the best
monitoring signal this pipeline has.

**The one write-semantics refinement I am adding** (§8, Q3): the *only* date whose row is not yet a
historical fact is today's, and §4 arranges for it never to be written prematurely, so the table is
insert-only end to end. Stated as an invariant worth a test: *no code path in E ever replaces or
deletes a rate row.* Losing the whole table costs nothing (it rebuilds from §4's backfill in about
two seconds), which is the property `01-ARCHITECTURE.md:80` requires of anything living here.

### 3.3 RSD has no rows

`resolveRate(deps, 'RSD', d)` returns `{ rate: 1, rateDate: d }` as a pure constant and **must not
touch the store**. Guard test: with an empty table and the network unreachable, an RSD receipt still
books, still gets `amountRsd`, and still commits without a tap. A cache miss must never be able to
make a dinar receipt need a confirmation — PERSONAL is entirely RSD and it is the highest-volume book.

Ingest only the four foreign codes in `types.ts:7`, not all 34 rows. The list includes BEF, GRD,
SKK, SIT and HRK — dead currencies. Filtering against the `Currency` union means adding a currency
is a one-line change in one place and the table never fills with junk.

`unit` is verified `1` for EUR/USD/CHF/GBP on all 252 business days of the last year, but HUF and
JPY are quoted per **100** (measured: HUF 32,2833 per 100). Apply the division unconditionally in
`toQuotes`. If it is skipped, nothing breaks today and the day someone adds JPY the ledger is out by
100×. Test it with a HUF row from F12 even though E does not book HUF.

---

## 4. When the fetch runs

**Both. A timer as the mechanism, lazy fetch only as a repair.**

```
fn: rates-timer     0 0 8 * * *   UTC daily      ← 09:00 CET / 10:00 CEST
```

Two `IndexByDate` requests per day, total ~46 KB:

```
refreshRates(deps):
  today = isoDate(clock.now())                              ← UTC, per 01-ARCHITECTURE §9
  1. html   = nbs.byDate(today)                             ← one request, all 34 currencies
     quotes = toQuotes(parse(html)) filtered to EUR/USD/CHF/GBP
     for each: rateStore.insertIfAbsent(currency, today, quote)   ← 409 = no-op
  2. gap fill: rateStore.rangeKeys(currency, today-10 … today-1)
     for each of the four currencies, for each MISSING date D in that window:
        nbs.byDate(D) → insertIfAbsent(currency, D, …)
  3. return { written, skipped, divergences }               ← the timer logs counts, never bytes
```

**Why 08:00 UTC.** NBS's own rule is that a list applies from **08:00 local** on its formation day.
08:00 UTC is 09:00 CET in winter and 10:00 CEST in summer — comfortably after publication in both
regimes, with no second timer and no DST arithmetic. This is the discipline
`01-ARCHITECTURE.md:458` already sets for the monthly package, applied here: **DST drift can shift
the hour but can never change which date is written, because the date comes from the page's own
`FORMIRANA NA DAN` and `DATUM PRIMENE`, never from the cron expression.** The existing timers
(`sef-digest` 07:00 UTC, `monthly-pkg` 1st 06:00 UTC — `01-ARCHITECTURE.md:37-38`) are unaffected:
the monthly package converts a month that closed weeks ago and is fully cached.

**What "the rate for Saturday" means.** Friday's list, and that is not a fallback, an approximation
or a stale read — it is the official rate, by Article 41 and by NBS's own printed effective-period
rule. Because we ask *after* 09:00 local, `IndexByDate(today)` on a Saturday returns list 153 with
application date Saturday, we write a Saturday row with `rateDate = Saturday`, `formedOn = Friday`,
and nothing flags. The same mechanism covers Orthodox Easter and the 5-day New Year gap with **no
holiday calendar in the codebase**. Verified against 7.1.2026, 1.1.2026, 13.2→18.2.2026,
9.4→14.4.2026, 30.4→4.5.2026.

**Lazy fetch: yes, but not everywhere.** Allowed on the asynchronous ingest path (`ingestDocument`,
which already spends seconds on extraction, so 0.2 s is free) when the exact row is missing.
Forbidden on the WhatsApp confirm path (§5). One guard: if it is before 09:00 local and
`IndexByDate(today)` returns a list whose `formedOn` is not today, **use the value but do not cache
it** — today's own list may still appear at 08:00 and a premature insert would lock the wrong row in
permanently. That is the only place the clock enters this pipeline, it lives in `app/`, and it is
the reason §3.2's insert-only invariant can be absolute.

**Residual exposure, stated plainly.** A document *dated today* and captured between midnight and
~10:00 local finds no row for today, falls back one day, and is flagged — permanently, because the
rate is frozen at capture. The value is fine (EUR moved 0.24% across the entire year; consecutive
daily deltas are 0.001–0.01 RSD) but the flag is noise. It is a narrow window, it is self-healing
for every later document, and closing it further would mean either a second timer fire or trusting
a pre-publication read. I would leave it, and count flags in `/status` so the noise is measurable
rather than assumed.

### 4.1 Cold start: the honest answer is that there isn't one

The brief asks what happens on day one when the cache is empty and every backdated document takes
the fallback path. With the briefed endpoint, that is exactly right, and it is bad in a specific
way: the fallback is "the most recent fetched rate", the only rate ever fetched is *today's*, so a
receipt dated last Tuesday would be converted at a rate from the **future relative to the
document** — the one substitution that is affirmatively wrong for accounting rather than merely
imprecise, since Article 41 asks for the rate of the day. And it never repairs: the page has no
history, so last Tuesday's rate is unobtainable forever. Every non-RSD document dated before
go-live would be permanently flagged and permanently unfixable except by hand. That exposure is
concentrated exactly where it hurts — SMOQUA buys abroad (`05-SMOQUA.md:126`) and DILIGAF's export
invoices are USD (`03-DILIGAF.md:67`), while PERSONAL, the high-volume book, is RSD and unaffected.

With `IndexPeriod` the cold start is a one-off script that runs in about two seconds:

```
backfillRates(from = today − 18 months, to = today):
  for currency in [EUR, USD, CHF, GBP]:            ← 978, 840, 756, 826
    for chunk in chunks(from, to, maxDays = 365):  ← the measured silent cap is ~370
      rows = parse(nbs.period(currency, chunk, WorkingDays=2))
      assert rows.length > 0                       ← MANDATORY. see §7a
      existing = rateStore.rangeKeys(currency, chunk)
      insert the difference, batched ≤100 per transaction, same PartitionKey
```

**8 requests. ~1.2 MB. ~2 s. 4 × 548 = 2,192 rows.** That covers the entire `validate.ts` acceptance
window `[now − 18 months, now + 2 days]` (`01-ARCHITECTURE.md:348`), which means **zero** backdated
documents take the fallback path on day one, for any of the four currencies. The 18 months is not a
round number chosen for comfort — it is the exact window beyond which `validate.ts` rejects a
`doc_date` outright, so a document that could be accepted can always be converted.

Diff-then-insert rather than insert-and-catch because a transactional batch fails atomically on any
one 409, so a re-run of a partially-completed backfill would fail whole batches. One range query per
chunk gives the existing `RowKey`s and keeps §3.2's insert-only rule intact.

Run it from `app/` behind an explicit invocation — not on function-app start, where a cold start
would fire it on every scale-out event. `/tebra` is read-only until M8 and cannot be the trigger
(`07-ROADMAP.md:588`), so this is a `/status`-adjacent admin command or a one-shot local script.
Re-running it is free and idempotent, which makes it the answer to "the cache looks wrong" as well
as to day one: **delete the table, re-run, done.**

---

## 5. The synchronous path

The WhatsApp confirm-policy path runs when a message arrives, on a webhook Meta will retry if it is
slow. `decide()` (`confirm-policy.ts:51`) is pure and is currently handed no rate at all
(`confirm-policy.ts:63`, in a comment that says so and calls the omission deliberate).

**Rule: the confirm path never calls NBS. It reads the cache, or it does without.**

```
resolveRateForConfirm(deps, currency, date):
  currency === 'RSD'                      → { rate: 1, rateDate: date }        no store read
  exact row hit                            → { rate, rateDate: date }           not stale
  window [date−10 … date] has a row        → newest ≤ date; rateDate < date      FLAGGED
  window empty, any older row exists       → oldest available                    FLAGGED, see Q4
  nothing at all for that currency         → null                                → require the tap
```

Three reasons the fetch does not belong here, in order of weight:

1. **Determinism.** `01-ARCHITECTURE.md:283` forbids the system to *"silently change its mind about
   the same input twice."* A `decide()` that depends on whether a third-party HTML endpoint answered
   in time can commit a message at 10:00 and confirm the identical message at 10:01. That is a
   correctness property, not a performance one, and it is the reason this is a rule rather than a
   tuning knob.
2. **Tail latency.** 0.113–0.227 s measured over five calls from this container — but that is a
   median against a WAF-fronted ASP.NET app with no SLA, measured from a container rather than from
   Azure West Europe (**unverified** from the real runtime). The distribution's tail is exactly what
   is unknown, and it is unbounded from E's point of view. A Table Storage point query in the same
   region is 10–30 ms with an actual SLA.
3. **Blast radius.** The webhook is the only path where a hang is visible to the person waiting, and
   the only path an outsider can trigger.

**A cache miss on the confirm path is rare by construction**, because the timer pre-fills every
calendar date and the backfill covers 18 months. It is not the normal case being designed around; it
is the residue of §4's morning window and of a timer that has stopped — and if it starts happening
often, that *is* the signal from §7.

The lazy fetch still happens — just on the ingest path, which is asynchronous and already measured
in seconds. So a photographed receipt repairs its own missing row; a typed `MATERIALS 300e` does not
wait for one.

### 5.1 "No rate available and currency is not RSD → require the tap"

**Agreed, with three qualifications.**

Agreed because of what the tap is protecting. `book.features.confirmAboveAmount` is the only gate on
the WhatsApp write path, and it is currency-blind in both directions (CANDIDATE-006,
`07-ROADMAP.md:593`): measured at today's live rate, **400 EUR = 46.940,40 RSD** commits under a 500
RSD threshold, because `decide()` compares `400 >= 500`. The whole point of LCY is that the
threshold moves to RSD. With no rate you cannot evaluate the threshold at all — so committing would
not be "committing a small amount", it would be **committing past a gate that was never
evaluated.** A tap is the only honest answer, and it costs one tap on a path that is rare by
construction.

1. **It is `confirm`, not `ask`.** `confirm-policy.ts:29-31` defines the precedence: `ask` means a
   required slot is missing and there is nothing to confirm yet. The money slot *is* filled — 300
   EUR is a complete, valid reading. So `{ action: 'confirm', reason: 'no_rate' }`, a new member of
   the `reason` union at `confirm-policy.ts:6`. That union is exactly what `nlu.test.ts:905-922`
   asserts against, and that unfreeze is **already pre-authorized** for this work
   (`TEST-FREEZE.md:108`). Worth checking whether other frozen tests snapshot the `Decision` shape
   before starting; a wider unfreeze needs its own ruling and an isolated engineer cannot grant it.
2. **It must never block storage.** `01-ARCHITECTURE.md:350`: *"Extraction failure never blocks
   storage. The bytes land first, always."* A missing rate is the same class of thing. The document
   is stored, `amountRsd` is null, `reviewStatus = 'needs_review'`, and the confirmation is about the
   *transaction*, not the paper. The reply must say what is unknown — the original amount, and that
   the RSD equivalent could not be computed — rather than showing a number E is not confident in.
3. **A flagged fallback rate is good enough to evaluate the threshold, and I can show it.** Over
   twelve months EUR moved through a **0.24%** band (117.1546–117.4414), so a EUR fallback from any
   date in the last year is decision-equivalent for any threshold. USD moved **5.6%** (97.86–103.30),
   CHF **4.9%**, GBP **4.7%** — so a *months*-old fallback could flip a borderline USD/CHF/GBP
   comparison, while a few-days-old one cannot. That is the empirical case for a bounded staleness
   rule rather than an unbounded "most recent": **beyond `RATE_STALENESS_MAX_DAYS`, treat the
   fallback as no rate and take the tap.** The measured maximum *legitimate* staleness is 4 days and
   the longest gap between lists is 5, so **7** is a defensible default — comfortably above every
   legitimate gap observed in a year, comfortably below anything that could move a decision.

---

## 6. The third currency

`types.ts:7` allows `RSD | EUR | USD | CHF | GBP`. The briefed endpoint carries EUR and USD only.

**With the briefed endpoint**, a CHF invoice is the worst case in the design, not an edge case: the
fallback is "the most recent fetched rate", and for CHF **no rate has ever been fetched**, so the
fallback has nothing to fall back to. It resolves to null → `amountRsd` null → `needs_review` →
every CHF document requires a tap, forever, with no repair path and no way for the operator to tell
this apart from an outage. Same for GBP. Two of the five currencies E claims to support would be
structurally unsupported — a claim in `types.ts` that the pipeline cannot honour.

**With `IndexByDate`** it is a non-event: CHF and GBP are two of the 34 rows in the *same single
response* the timer already fetches for EUR and USD. Measured 2026-08-17, `VAŽI ZA` = 1 for both:

```
CHF  756  Švajcarska        1  124,7884       12-month range 124.1419 – 130.2275
GBP  826  Velika Britanija  1  137,2276       12-month range 132.2834 – 138.5080
```

`toRsd({1250,'CHF'}, 124.7884)` → `155985.5` → `155.985,50`. Verified against the built engine.

So: **fetch all four foreign currencies from day one.** It costs zero extra requests and it is the
difference between `Currency` being a supported set and being an aspiration. There are no fixed test
rates for CHF/GBP yet — §8, Q6.

What remains true regardless: a currency outside the union (a receipt in SEK, say) is refused by
`validate.ts`'s currency allowlist (`01-ARCHITECTURE.md:348`) before the rate pipeline is ever
consulted. Adding one is a one-line change to `types.ts:7` plus a numeric ISO code in
`adapters/nbs/client.ts`, and the source already carries all 34.

---

## 7. Failure modes, and what is observable

Every one of these was reproduced against the live site.

| | mode | what it looks like | detection |
|---|---|---|---|
| a | `IndexPeriod` range > ~370 days | **HTTP 200, zero rows, no validation message.** Measured: `DateFrom=10.8.2025.` → 0 rows, `14.8.2025.` → 254 rows | `assert rows.length > 0` in the backfill. Without it a backfill "succeeds" having written nothing |
| b | future or malformed `Date` | HTTP 200, no table. Measured: `18.8.2026.`, `1.9.2026.`, `junk` | same assert. Never treat "no rows" as "no rate today" |
| c | **`ExchangeRateListTypeID` omitted or wrong** | `IndexPeriod` silently returns `KUPOVNI KURS \| PRODAJNI KURS` instead of `SREDNJI KURS` — measured. `IndexByDate` returns nothing at all. **Inconsistent defaults between two routes on the same app** | Never index columns positionally. Map `thead th` text → index once, and **fail** if `SREDNJI KURS` is absent. A column-index parser reads the *buy* rate as the middle rate and every number is plausibly wrong |
| d | `WorkingDays` omitted | defaults to `1` — business days only, measured 11 rows vs 17 for 1–17 Aug. Non-business days silently vanish | assert the returned `DATUM PRIMENE` set covers every calendar day in the chunk |
| e | class-prefix collision | `kurs_d` is a prefix of `kurs_date`; `kurs_e` of `kurs_e_2`, which holds the *text* `EUR/RSD` | exact class-token matching; F14 as the regression fixture |
| f | markup or wording change | the `zvanični` / `IndikativniKurs` naming trap; `lang=en` silently serving Cyrillic | parse digits and class attributes, never words. §7c's header-text mapping is the one place words are read, and it fails loudly |
| g | WAF / throttle | `TS0158a2e7` (F5 ASM) on every response. Limits **unverified** | one timer fire/day, bounded backfill, a real `User-Agent`, no retry storm, `AbortSignal` timeout |
| h | divergence on a past date | §3.2's 409-with-different-value | the strongest available signal that the parser broke, because the source cannot have changed |

### 7.1 How the operator finds out — and the part I cannot solve here

`07-ROADMAP.md:390` is right and it applies with full force: **there is no monitoring anywhere in
this design, and silent failure is the established hazard.** A dead rate timer presents exactly as
a working one. Worse, the failure is *gradual*: rates keep resolving from cache, each day's flag
count creeps up, and nothing is ever wrong enough to notice — the reports stay plausible while
drifting away from the filed truth.

The cache's health is one cheap query, which is a real advantage of insert-only rows keyed by date:

```
freshness(currency) = today − max(RowKey for PartitionKey eq currency)
healthy ⇔ freshness ≤ 1 day for all four currencies
```

One row per calendar day means no holiday reasoning is needed in the check either. What to surface:

- **`/status`** — last successful fetch, freshness per currency, row count, and **the count of
  flagged transactions this month**. The last number is the leading indicator: it should be near
  zero, and a rising trend is the scrape breaking before freshness goes red.
- **`/tebra`** reads it for free once `get_status` exists (M4.5).
- **The monthly package** should carry a rate-health line. An accountant package built partly on
  flagged rates must say so on its face — the same argument that put `extraction_method` in the
  manifest (`03-DILIGAF.md:370`).

None of that is a dead-man's switch, and I want to be exact about why: **E has no daily outbound
message that always sends.** `sef-digest` is explicitly silent on zero pending
(`03-DILIGAF.md:274`, `07-ROADMAP.md:497`), and the monthly package is monthly and is itself U5's
worked example. So there is nothing to piggyback on, and a warning emitted *by* the timer cannot
detect the timer not running.

The cheapest thing that is actually a switch: **`functions/health.ts` already exists in §4's
structure** (`01-ARCHITECTURE.md:187`). Have it report rate-cache freshness in its response body and
return non-200 when freshness exceeds 1 day, then point a free external uptime checker at it with a
content assertion. That puts the observer outside the thing that can die, adds no service, and costs
nothing. But it is **U5's fix, not LCY's** — the same switch covers the monthly package, the IMAP
credential expiry and the Functions timeout. LCY should contribute the freshness field and a
runbook sentence, and should not pretend to have solved monitoring. If U5 slips, this pipeline
inherits the hazard, and that should be recorded rather than discovered.

Runbook sentence, so it is not reconstructed under pressure: *"If `/status` shows rate freshness
over 1 day: run the backfill for the last 30 days. If it still shows stale, fetch F12's URL by hand
— if the page renders, the parser broke; if it does not, NBS changed and every non-RSD capture is
taking the fallback until it is fixed."*

---

## 8. What I am not sure about

1. **The endpoint switch (Q1).** §1.3 is a change to a fact recorded as verified, so it is Danilo's
   call, not mine. It buys: history (so §4.1's cold start disappears), CHF and GBP (so §6 stops
   being a hole), server-side weekend/holiday resolution (so no holiday calendar ever), and a page
   whose own title says `ZA ZVANIČNI SREDNJI KURS DINARA`. It costs: a second route to keep working,
   and one more parser. It does **not** reopen the paid-API ruling — same host, same anonymous GET,
   no licence. I recommend it, and the rest of this document is written for it, with the
   briefed-endpoint behaviour stated wherever it differs so the fallback position is legible.
2. **`05-SMOQUA.md:130` and `07-ROADMAP.md:584` now contradict the LCY decision.** Both say a rate
   failure leaves `amount_rsd` **null** with `needs_review` and backfills later; LCY says use the
   most recent rate and flag it. One of them has to be rewritten before anyone writes code against
   the M7 test list, and I have not touched either file. My read: LCY supersedes, *and* the null
   path survives for the genuinely rate-less case (§5's "nothing at all for that currency"), so they
   are reconcilable — but somebody has to say so in writing.
3. **"Most recent" when the gap is in the past (Q3).** Taken literally, a document dated last
   Tuesday with an empty cache gets *today's* rate — a rate from the document's future, which
   Article 41 does not permit. I have specified **newest at-or-before the document date, else oldest
   available**, which I believe is what the decision meant. With the §4.1 backfill the case is
   nearly unreachable; without it, it is the common case on day one. Worth one sentence of
   confirmation.
4. **`RATE_STALENESS_MAX_DAYS` (Q4).** §5.1 argues for 7 from measured data (max legitimate
   staleness 4, longest inter-list gap 5). Is there a staleness beyond which "flag it" should become
   "refuse and tap"? I think yes and I think 7; it is a judgement call about how much a tap costs.
5. **The accountant question, which is the one with real weight.** Article 41 asks for the middle
   rate *of the day*. A flagged fallback rate is by construction **not** that rate. So: does the
   accountant accept a transaction booked at a flagged rate, or must every flagged transaction be
   corrected before a month can be filed? If the latter, the flag is not a report field, it is a
   **blocking review-queue item**, and `_queue/review` needs a rate reason — a different design from
   the one above. I am not qualified to answer this and would not guess; it belongs with the same
   accountant conversation as Q18's exemption note (`07-ROADMAP.md:402`).
6. **Fixed test rates for CHF and GBP.** EUR 117.5 and USD 101.0 are set; CHF and GBP have none. If
   §6 lands they are needed. Following the same "deliberately outside the plausible live range"
   logic and the measured 12-month bands, something like CHF 125.5 and GBP 140.0 — but the numbers
   are Danilo's to set, and note that USD 101.0 already sits *inside* its measured band (§2.3).
7. **The HTML-parse dependency.** `package.json` has **zero** runtime dependencies today, so this is
   a first, and CLAUDE.md makes a new dependency an architectural decision to be raised rather than
   picked. `cheerio` gives real CSS selectors and makes §7c/§7e's exact-token matching natural, at
   the cost of a non-trivial dependency tree. `node-html-parser` is far smaller with adequate
   selector support. Hand-rolled regex is what §7e is a cautionary tale about. I lean
   `node-html-parser`, but it is a ruling, not a preference, and the same choice will be reused by
   any future scrape (the S-PIB company registry is the obvious next one, `07-ROADMAP.md:137`).
8. **Whether the new list is genuinely up at 08:00 local.** NBS says so in print and I have no
   reason to doubt it, but I observed a single day. Everything in §4 is built to be safe if it is
   late — the 09:00/10:00 local timer, and the "use it, don't cache it" guard — so a wrong answer
   here costs flag noise, not wrong numbers. Still **unverified**, and one week of observing
   `listNumber` would settle it.
9. **Where the rate lands besides the ledger event.** `DocumentFacts` has `amountRsd`
   (`types.ts:88`) but no `rate`/`rateDate`; `Transaction` is the same (`types.ts:107`). The
   decision names the *ledger event*. A document sidecar with a converted amount but no record of
   the rate that produced it cannot be audited, which argues for both fields on both — but that is
   the ledger half's boundary and I am flagging it rather than deciding it. Note also
   `03-DILIGAF.md:246`: the invoice PDF **prints** the NBS middle-rate line, so an invoice being
   generated in the WhatsApp wizard is a third consumer of the rate on an interactive path, and it
   needs the rate for the *issue* date, which may be today, in the §4 morning window.
10. **Azurite table support in CI.** Assumed, not measured here. §11 promises fully offline tests;
    if Azurite's table emulation is inadequate, the store's contract tests need a different home and
    that is worth knowing before the adapter is written, not after.

---

## 9. Config keys

No secret is required for any of this — the scrape is anonymous and Table Storage uses the same
managed identity as blob (`01-ARCHITECTURE.md:74`). **The LCY pipeline adds zero entries to
`01-ARCHITECTURE.md:445`'s secrets list.** That is a genuine advantage of the scrape over the SOAP
API, which would need `UserName`, `Password` and a `LicenceID` GUID (`07-ROADMAP.md:126`).

Keys, named only — values are none of my business and I have looked for none:

| key | for |
|---|---|
| `NBS_RATE_BASE_URL` | `https://webappcenter.nbs.rs/ExchangeRateWebApp` — overridable so tests can point at a local fixture server |
| `NBS_FETCH_TIMEOUT_MS` | the `AbortSignal` bound. §7g |
| `RATE_TABLE_NAME` | `exchangeRates`. Alphanumeric only |
| `RATE_STALENESS_MAX_DAYS` | §5.1's bound. Recommend 7 |
| `RATE_BACKFILL_MONTHS` | §4.1. Recommend 18, matching `validate.ts`'s acceptance window |

Every one needs a matching line in `.env.example`. Note that **`e-app/.env.example` does not exist
yet** — no `.env*` file of any kind is present — so this work creates it or inherits it from
scaffolding. All five keys are non-secret and belong in it with real defaults.
