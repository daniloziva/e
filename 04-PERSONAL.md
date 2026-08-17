# E — PERSONAL expense tracking

Goal: know where your money goes without ever opening a bank app or a spreadsheet.

---

## 1. Sources of truth, today and later

```
                              ┌────────────────────────┐
 monthly PDF statement ──────►│                        │
   (email trigger)            │   normalize →          │
                              │   dedupe →             │──► transactions
 per-transaction emails ─────►│   categorize →         │      (PERSONAL)
   (other bank, later)        │   flag MISC            │
                              │                        │
 /cash 800 parking ──────────►└────────────────────────┘
```

The switch you flagged is designed in from day one:

```
engine/statements/  →  StatementSource interface
  'monthly_pdf'      parse a whole statement PDF into N transactions
  'tx_email'         parse ONE notification email into 1 transaction
```

Both produce `RawTransaction[]`. Everything downstream — normalize, dedupe, categorize, store, review — is **shared and source-agnostic**. Config flag `PERSONAL_TX_SOURCE = monthly_pdf | tx_email | both`.

`both` is a real setting, not a placeholder: during a bank migration you'll have overlapping months from two banks, and the dedupe key handles it. That's the moment this abstraction pays for itself.

---

## 2. Monthly PDF statement path

### Trigger

A routing rule in the same IMAP poller as `03-DILIGAF.md` §1:

```
subject starts with "Izvod po tekucem racunu/Dinar Current Account Statement"
  → book PERSONAL, category 'statement'
```

Matching is normalized (lowercase, diacritics stripped, whitespace collapsed) so `tekućem` / `tekucem` and stray double spaces both hit. Prefix match, because banks append account numbers and dates to these subjects more often than not.

### Pipeline

```
ingestDocument(category='statement')
  → store PDF at personal/YYYY/MM/statement/…pdf          (always, first)
  → pdfjs text extraction (text + coordinates)            ← layer 0, no OCR, no ML
  → parseStatement(items) → RawTransaction[]              (pure, heavily tested)
  → reconcile against the statement's own balances        (hard gate, below)
  → normalize + dedupe → write tx event blob
  → categorize each → signal ladder (§3)
  → WhatsApp summary
```

Storage before parsing is not an implementation detail — a parser bug costs a re-run, not a lost statement. The PDF stays re-parseable forever, so improving the parser retroactively fixes history.

### Layout — the thing that will actually be hard

No password protection (confirmed), so that branch is gone. What remains is the layout.

Statement PDFs are tables rendered as absolutely-positioned text fragments, not rows. `pdfjs-dist` gives every fragment with its `x`/`y`, and the parser reconstructs rows from that:

**Coordinate-band parsing** — group fragments by `y` into bands (rows), then assign each fragment to a column by comparing its `x` against ranges *learned from the header row of that document*. Learning the column boundaries per-document rather than hardcoding pixel values is what keeps it working when the bank nudges its template.

Fully deterministic: same PDF in, same transactions out, every time. No model, no prompt, no temperature, no cost, no network.

**No model fallback here — and this is the principled exception, not a leftover.** E uses a model wherever input is unstructured (arbitrary invoice layouts, free-text messages, mixed-basket categorization). Statement parsing is different in one decisive way: **it has ground truth.** The statement states its own opening and closing balances, so a wrong parse is *detectable* (below). Everywhere else there's nothing to check the answer against, which is exactly why a model is worth having there.

Given a detectable failure, failing loudly beats papering over it: keep the PDF, flag the page, fix the parser, re-run — and every future statement benefits. A model fallback would quietly absorb the one signal that makes the parser converge. One statement layout that we control is also a very different problem from 90 supplier layouts we don't.

This is the one part of E I can't design blind. The parser is a "look at the real file, then write the test" job — see F2 in `06-TDD-STRATEGY.md` §6.

### The reconciliation guard (non-negotiable)

Every statement carries an opening balance, a closing balance, and total debit/credit. After parsing:

```
assert  opening + Σcredits − Σdebits ≈ closing   (±0.01)
```

Pass → transactions committed, `review_status='ok'`.
Fail → transactions committed as `needs_review` **and** E says: `⚠ jul: parsirao 47 transakcija, ne poklapa se sa saldom (razlika 1.240,00) — proveri`.

Without this check a silent parser bug produces a plausible-looking, wrong picture of your finances for months. With it, every statement either balances or announces that it doesn't. This is the single most valuable test in the personal module — and it's what makes the no-model-fallback exception safe rather than reckless: a deterministic parser that fails is *visibly* failing.

### Dedupe

```
dedupe_key = sha256(book | tx_date | amount | normalize(description) | value_date | balance_after)
```

Handles: re-sent statements, overlapping periods, the `both` migration mode. `balance_after` disambiguates two genuinely identical same-day charges (two identical coffees) which would otherwise collapse into one — a subtle but real data-loss bug that this avoids.

If your bank's per-transaction emails carry a reference id, that becomes the key instead — better, and a one-line change.

---

## 3. Categorization

### The signal ladder

You're right that vendor→category can't carry this: the same shop sells you groceries, a birthday present, and something for the kids. **What you bought** determines the category, not who you bought it from.

```
categorize(tx, ctx) → { category, confidence, source: 'stated'|'items'|'rule'|'model'|'misc' }

0. you stated it             /cash 800 parking → TRANSPORT
1. line items                receipt lists PAMPERS, MLEKO → DECA + HRANA
2. rule hit                  (vendor + item pattern + amount band) → category
3. model classify            vendor + items + amount + your category list
                             + your recent similar transactions → proposal + confidence
4. MISC                      → review queue
```

Two mechanisms carry the weight:

**Ambiguous-vendor detection.** If a vendor has resolved to more than one category in your history, E **stops auto-applying a rule** and drops to line items or asks:

```
vendorIsAmbiguous(vendor, history) → boolean          ← pure, tested
```

This is the part I'd have had to guess at otherwise. E discovers which of *your* vendors are ambiguous by watching you, rather than me pre-enumerating them. `MAXI` becomes ambiguous the second time you split it differently; `EPS SNABDEVANJE` never does.

**Splits.** One card swipe can be two categories. E supports splitting a transaction across categories and offers it automatically when the line items disagree with each other. Without splits, a mixed basket forces you to file a lie, and after a few of those you stop trusting the reports.

### Where the model helps and where it doesn't

| | |
|---|---|
| **Model earns its place** | mixed baskets, unfamiliar merchants, cryptic bank descriptors (`POS 4738 BEOGRAD`), the long tail you'd never write a rule for |
| **Rules stay better** | your ~30 recurring merchants: free, instant, and incapable of changing their mind next month |
| **Neither is used** | anything you stated explicitly — you outrank both |

Statement lines are the hard case, because a bank descriptor often has no line items behind it. There the model gets your category list, the amount, and your *recent similar transactions* as context — which is exactly the signal a fresh classifier lacks and you have in abundance after month one.

**Reproducibility:** classification is cached by `hash(normalized description + amount band)`, so the same descriptor always resolves the same way, and re-running a month never shifts your history. Rules learned from your `/misc` taps still take precedence over the cache, so a correction propagates immediately.

**Cold start.** Month one still benefits from a seed: name your top ~30 merchants once, or let E derive the candidate list from your first statement and you just confirm the mapping. That turns month one from mostly-MISC into mostly-right, and the model handles the tail from day one instead of month three.

### Category set (v1)

```
STAN          rent, utilities, internet, maintenance
HRANA         groceries, restaurants, delivery
TRANSPORT     fuel, parking, taxi, transit, tolls, service
ZDRAVLJE      pharmacy, doctors, insurance
DECA          childcare, school, kids' stuff
ZABAVA        entertainment, subscriptions, hobbies
ODECA         clothing, shoes
TEHNIKA       electronics, software, gadgets
PUTOVANJA     travel, hotels, flights
FINANSIJE     bank fees, interest, loan payments, transfers out
PRIHOD        incoming (salary, dividends, refunds)
POREZI        taxes, contributions
MISC          unresolved — the review queue
```

Lives in `_state/rules/personal.json`, not the code. Adding `KUCNI_LJUBIMCI` is an edit to a JSON blob, not a deploy.

### Learning loop

Every `/misc` resolution offers to write a rule:

```
E   ✓ HRANA · pravilo sačuvano: "WOLT" → HRANA (23 slična unosa ažurirano)
```

Retroactive application is the important half — resolving one MISC item cleans up its whole history. The rule's pattern is derived from the description's stable token (merchant name), with the volatile parts (dates, terminal ids, reference numbers) stripped by a tested normalizer.

### `/cash`

```
/cash 800 parking     → transactions(source='cash', direction='out', amount=-800)
```
Same categorizer, so cash and card spend are one dataset and one set of rules.

---

## 4. Reporting

### Monthly (with the DILIGAF package, 1st of month)

```
E   Jul 2026 · lično
    Prihodi     412.000,00
    Troškovi    338.150,00
    Neto         +73.850,00

    STAN         96.000   ████████
    HRANA        71.400   ██████
    TRANSPORT    41.200   ███
    …
    MISC          8.900   [Obradi 5]
    [Detaljno] [Uporedi sa junom]
```

Personal reporting is **for you, not for anyone else** — nothing personal is ever included in the accountant package. That separation is enforced by `book` on every query, and there's a test asserting the accountant package builder returns nothing when handed `PERSONAL` data.

### On demand

```
/status                  current month so far
/misc                    review queue
/report 2026-07          re-render a past month
```

---

## 5. The bank-switch flag (explicit)

When you move to the per-transaction bank:

1. Register the new subject/sender rule in `email-routing.ts` (+ test)
2. Implement `parse-tx-email.ts` → `RawTransaction[]` of length 1 (+ tests from real fixtures)
3. Set `PERSONAL_TX_SOURCE=both` for the overlap month, then `tx_email`
4. Nothing else changes — dedupe, categorization, review, and reporting are untouched

Expected upside beyond granularity: transactions arrive **same-day**, so `/status` becomes live rather than monthly, and MISC review becomes a 10-second daily habit instead of a monthly chore. That's a materially better product, and it's worth asking the new bank whether their notification emails include a reference id and the merchant's full name before committing — those two fields decide how good the dedupe and the categorization can be.
