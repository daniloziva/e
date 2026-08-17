# E — DILIGAF DOO

> **v2.** Power Automate → IMAP/SMTP. Invoicing scope narrowed (PDF with PDV, no SEF submission).

Five jobs: **izvodi in**, **expenses in**, **invoices out**, **SEF inbound**, **package to accountant**.

---

## 1. Izvodi (bank statements) from email

### Flow

```
Bank ──email──► mailbox ──(server-side rule)──► E/Inbox
                                                   │
                              fn: imap-poll-timer (10 min)
                                                   │
                                          route(from, subject)
                                                   │
                                          ingestDocument
                                                   │
                          blob: diligaf/YYYY/MM/izvod/…pdf  (+ .json sidecar)
                                                   │
                                  MOVE mail → E/Processed
```

### The poller

```
fn: imap-poll-timer     every 10 min
  1. connect TLS, open IMAP_WATCH_FOLDER (default: E/Inbox)
  2. fetch UNSEEN
  3. parse MIME (mailparser) → { messageId, from, subject, date, attachments[] }
  4. route(from, subject) → { book, category }        ← pure, tested
  5. per attachment → ingestDocument(...)
  6. all attachments ingested  → MOVE to E/Processed
     no route match / any failure → MOVE to E/Failed  + log
```

**Folder moves are the idempotency mechanism.** Once a message leaves the watch folder it cannot be reprocessed, so a double-poll or an overlapping run is harmless without any bookkeeping. It also gives you a human-visible audit trail in your own mail client: everything E handled is in `E/Processed`, everything it choked on is in `E/Failed`, and both are one tap away on your phone. The `_index/event/mail/{hash(messageId)}:{idx}` marker covers only the narrow crash-between-ingest-and-move case.

Recommended: a **server-side rule** (Sieve on the self-hosted box, a Rule on iCloud) files matching mail into `E/Inbox`. Then E polls one small folder, never touches your actual inbox, and adding a new sender is a mail-rule change you can make from your phone.

Why polling and not push: neither iCloud nor a typical self-hosted setup offers a webhook, IMAP IDLE needs a long-lived connection that a Function can't hold, and a bank statement that arrives 10 minutes late is a bank statement that arrived on time.

Config: `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` (Key Vault), `IMAP_WATCH_FOLDER`, `IMAP_PROCESSED_FOLDER`, `IMAP_FAILED_FOLDER`.

iCloud specifics: `imap.mail.me.com:993`, **app-specific password required** on a 2FA account. Self-hosted is the more reliable of the two if it already receives the bank mail — Apple rate-limits IMAP connections (a 10-minute poll won't hit it, but it's worth knowing before you scale the interval down).

### Routing table (`engine/mail/route.ts`)

| `from` (anchored) | Match | → book | → category |
|---|---|---|---|
| `<izvodi@banka-doo.rs>` | `subject` matches the DOO bank's izvod pattern | DILIGAF | `izvod` |
| *(none — you send these)* | `subject` starts with `E:EXPENSE` or `E:TROSAK` | DILIGAF | `expense` |
| `<noreply@banka-tekuci.rs>` | `subject` = `Izvod po tekucem racunu/Dinar Current Account Statement` (prefix match) | PERSONAL | `statement` |
| *(none — you send these)* | `subject` starts with `E:SMOQUA` | SMOQUA | `expense` |
| — | no match | — | `E/Failed`; E does not guess where an email belongs |

**Write `fromPattern` in the anchored `<addr>` form, always.** `senderMatches` supports three shapes and
they are not equivalent:

| shape | semantics | refuses |
|---|---|---|
| `<izvodi@banka-doo.rs>` | exact address | display-name spoofing, subdomain suffixes, homoglyphs |
| `@banka-doo.rs` | domain suffix | display-name spoofing, subdomain suffixes |
| `izvodi@banka-doo.rs` | substring — **the permissive legacy shape** | display-name spoofing only |

An empty or absent `fromPattern` is **no constraint at all**, so a subject-only rule routes any
sender who guesses the subject line. That is acceptable for the two `E:` rules — those are messages
*you* send — and unacceptable for a bank rule, where the subject is a fixed string an outsider can
copy. Fill in the real addresses before this table becomes `_state`.

**Known limitation, and why the anchored form is not sufficient on its own.** `route` currently
extracts the address by taking the **last** `<…>` in the header, which is a heuristic over a grammar.
Six RFC-legal `From` shapes defeat it — a multi-mailbox list with the bank last, an RFC 5322 comment,
a quoted local part, group syntax — and a trailing-dot FQDN is wrongly refused. The real fix belongs
at the `parse-eml` boundary: `MailEnvelope.from` should carry a single, already-parsed address so
`route` never sees a display name, a comment or a list. **This is a pre-condition for M2**, recorded
in `e-app/UNFREEZE-LOG.md` under CANDIDATE-015. Until then, the server-side mail rule (iCloud/Sieve)
that files bank mail into a folder is the real first line of defence, not this table.

Matching is normalized (lowercase, diacritics stripped, whitespace collapsed) so `tekućem`/`tekucem` and stray double spaces both hit — **except the sender**, which is folded for case and whitespace only, because stripping diacritics from an address collapses `izvodí@…` onto `izvodi@…`. Rules are ordered, first match wins, and the table is data — so one test enumerates every rule against real subject lines from fixtures.

All routing lives here, in code with tests, rather than in mail-client rules. Adding a bank is a tested change, not a click-path nobody remembers next year.

### Practical constraints

- **Attachment size.** No HTTP hop any more, so no base64 inflation and no payload ceiling — a win from dropping Power Automate. Cap at 25 MB per attachment purely as a sanity guard.
- **Non-PDF attachments.** Banks often attach XML or XLS alongside the PDF. Store all of them; the PDF is what your accountant reads, but the XML is better data if a parser ever wants it.
- **No password protection** (confirmed) — the pdfjs password path is dropped. If that ever changes, it's a config value and one branch.
- **Multipart / inline images.** `mailparser` distinguishes attachments from inline content; E ingests attachments only, so email signatures and logos don't become documents.

### What E extracts from an izvod

Extraction layer 0 only (`01-ARCHITECTURE.md` §5): the PDF's text layer, parsed with regex for the **statement period** and **statement number**. No OCR, no ML, no network.

Not the transaction lines — your accountant reconciles DILIGAF's bank movements from the statement itself, and parsing them adds risk for no gain. (PERSONAL is different: there, parsing *is* the feature. See `04`.)

Period detection failure → period = the email's received month, `needs_review`. It still lands in the right package.

---

## 2. Expenses

Two doors, one pipeline.

### 2a. WhatsApp

Photo or PDF, caption `/expense` (or no caption — DILIGAF is your phone's default book). Interaction detail in `02-WHATSAPP-INTERFACE.md` F1. Storage: `diligaf/YYYY/MM/expense/`.

### 2b. Email with a dedicated subject

Forward the supplier's email with the subject prefixed `E:EXPENSE`. Same `ingestDocument`, `source='email'`. Multiple attachments = multiple documents.

### Extraction

Runs the ladder in `01-ARCHITECTURE.md` §5. For DILIGAF expenses specifically:

| Document you send | Layer that handles it |
|---|---|
| supplier invoice PDF (digital) | **0** — text layer + regex. no ML, no cost. |
| photo of a Serbian fiscal receipt | **1** — QR → `suf.purs.gov.rs`. exact, authoritative. |
| photo of a fiscal receipt with an unreadable QR | **2** — DI OCR + fiscal-receipt regex |
| foreign receipt, handwritten, odd layout | **3** — DI `prebuilt-invoice`, then **4** LLM vision |
| anything the above failed on | **5** — `[Unesi iznos]`, one tap |

The Serbian fiscal receipt is the common case and it's the one with a **legally mandated layout** — PIB, the PDV breakdown, УКУПНО/UKUPNO, fiscal receipt number, timestamp. That's what makes layer 2 a regex parser rather than a model, and layer 1 skips recognition entirely by asking the tax authority what the receipt says.

`engine/extract/validate.ts` applies to every layer's output, so a bad read can't propagate regardless of which produced it. Rules and rationale in `01-ARCHITECTURE.md` §5. The chosen layer is recorded in `extraction.method` and surfaced in the manifest and `/status`, so you can watch LLM usage trend toward zero and delete layer 4 if it never fires.

---

## 3. Invoice issuing

### Scope (D10)

DILIGAF **is PDV-registered**, but you don't submit invoices from the app yet. So:

| In scope | Out of scope |
|---|---|
| `/invoice` wizard | SEF sales-invoice submission |
| PDF with **PDV 20% domestic / no VAT international** | the UBL XML builder |
| **you supply the invoice number**, E suggests | any number allocation by E |
| PDF delivered to WhatsApp | SEF status tracking for outbound |
| PDF archived to `diligaf/YYYY/MM/invoice_out/` | |
| invoice included in the accountant package | |

The SEF **purchase**-invoice functions stay (§4) — it's only the sales half that's deferred. That deletes the riskiest inherited code from the milestone: 1IA's XML builder hardcodes `Paušalac — nije u sistemu PDV-a` and `TaxAmount 0.00`, which would be wrong for DILIGAF. Nothing has to be corrected because nothing ships.

### Numbering — you own it (D12)

**E never allocates an invoice number.** No counter, no sequence, no CAS increment — `_state/seq` is deleted from the design. You own the scheme (per customer, or whatever it is), and E's job is simply to not make you retype it.

What E does instead:

```
_state/customers/{customer_id}.json
  { name, pib, mb, address, country, is_business, currency,
    last_invoice_number: "KLIJENTA-2026-03",
    last_description: "Konsultantske usluge",
    last_amount: 300000 }
```

On `/invoice` → pick customer → E **suggests** the next number by incrementing the trailing numeric group of that customer's last one:

```
suggestNextNumber(last: string): string | null       ← pure, tested

"0007/2026"          → "0008/2026"         (zero-padding preserved)
"KLIJENTA-2026-03"   → "KLIJENTA-2026-04"
"2026/07/A"          → null                 (trailing group isn't numeric → E just asks)
null (first invoice) → null                 → E asks
```

It increments the **last** run of digits and preserves its width. It deliberately does not try to understand your scheme — no year-rollover logic, no per-customer format registry, no guessing. It's a typing shortcut behind a confirm step, not an allocator, so being wrong costs you one tap.

The number is stored as **text**, never an integer. There is no global sequence to be gappy about.

**One guard:** if the number you enter has been used before on any DILIGAF invoice, E warns — `⚠ 0008/2026 već postoji (12.07.2026, Klijent A) — nastavi?`. It warns, it doesn't block; you own the numbering and may have a reason. Since you own the scheme, an accidental repeat is the realistic failure mode and it's cheap to catch here.

**Payment reference** (*poziv na broj*) defaults to the invoice number, overridable. Worth knowing: a structured payment reference with a model-97 check digit is a different thing from an invoice number — if you want one, that's a separate field and your bank's format rules apply.

### VAT — derived from the customer, never asked (D13)

20% domestic, none international. That's a property of *who you're invoicing*, not a per-invoice choice, so E derives it:

```
resolveVatMode(customer): VatMode            ← pure, tested

country === 'RS'                    → 'standard20'
country !== 'RS' && is_business     → 'exempt_export'   (no VAT + exemption note)
country !== 'RS' && !is_business    → 'standard20'      ⚠ see caveat 2 below
```

`engine/invoicing/invoice-model.ts` still supports `none | standard20 | reduced10 | exempt_export` — you'll eventually invoice something that isn't 20%, and a general model costs nothing.

```
computeTotals(lineItems, vatMode) → { net, vat, total }
```

Rounding: 2 decimals, half-up, **per invoice not per line** — the total your accountant and any future UBL document expect.

**Presentation matters as much as the arithmetic.** `exempt_export` must not render a `PDV 0,00` line as though the supply were taxed at zero — it renders no VAT line at all and carries an exemption note instead. Those are different documents to a tax inspector, so they're separate code paths with separate snapshot tests.

**Three things to confirm with your accountant rather than take from me.** I can make the arithmetic and the layout correct, but these are tax determinations:

1. **The exact note text and its legal basis** for international invoices. Services supplied to a foreign taxable person are generally outside the scope of Serbian VAT under the place-of-supply rules — but the wording your invoice should carry, and which article it cites, is worth getting right once and then never thinking about. Give me the string and E prints it verbatim.
2. **The B2C caveat.** The rule above assumes your international customers are businesses. Services to a foreign *individual* can still attract Serbian VAT depending on the service. If you only ever invoice foreign companies, `is_business` is always true and this branch never fires — but the flag is tracked so that the day it matters it's a data change, not a code change.
3. **Whether 20%** is the right rate for what you invoice domestically.

**Currency and VAT stay independent.** International customers are usually EUR and usually VAT-free, but these are separate fields: a domestic customer can be invoiced in EUR, and a foreign one in RSD. Coupling them would be a plausible-looking bug that silently produces a wrong invoice, so tests cover all four combinations explicitly.

### PDF

`pdfkit`, reusing 1IA's template (D5). Variables: invoice number (text), issue date, customer snapshot, line items, VAT mode, legal note, currency, exchange rate, payment reference. Non-RSD invoices keep the bilingual output and the NBS middle-rate line.

Note that 1IA's template assumes an integer number it zero-pads to `0007/2026`. That assumption is gone — the number is a string you supply, rendered as given.

Split for testability:
- `engine/invoicing/invoice-template.ts` builds the fully-resolved `PdfInvoiceData` — **tested exhaustively**
- `adapters/pdf/invoice-pdf.ts` draws it — **tested for**: valid PDF, non-trivial size, expected strings present via text extraction, deterministic byte length for a fixed fixture

Unit-testing a PDF's visual layout would be theater; asserting that the *data* handed to the renderer is right, and that the renderer produced a PDF containing those values, is not.

### Delivery

1. PDF to WhatsApp as a document (1IA's `sendDocumentFromBuffer`)
2. blob → `diligaf/YYYY/MM/invoice_out/` + sidecar with the invoice facts
3. reply with the number, totals, and `[Pošalji ponovo] [Otkaži fakturu]`

The wizard's real value: **defaults from that client's last invoice**, so the happy path is two taps (`02-WHATSAPP-INTERFACE.md` F5).

---

## 4. SEF inbound

Already working in 1IA. What changes.

### Polling and digest (D7)

```
fn: sef-poll-timer      every 30 min       getPurchaseInvoices → upsert new by sef_id
fn: sef-digest-timer    daily 07:00 UTC    if pending > 0 → template e_sef_pending
```

Your pipeline — `cron → SEF pull → parse → send to WhatsApp` — is exactly right. Two notes:

- **Timer, not Logic App.** A Logic App would give a visual run history that App Insights already provides, at the cost of a second deploy artifact and a second place to look when something breaks. The timer sits next to the code it triggers.
- **The final hop needs a template.** Free-form sends outside the 24-hour window are rejected with `131047` regardless of what scheduled them. Full mechanics in `02-WHATSAPP-INTERFACE.md` §2.

Worth a 30-minute spike during M5: check whether SEF's `publicApi` exposes any push subscription. If it does, the poller swaps out behind the same interface and a timer disappears. Until confirmed, 30-minute polling is functionally indistinguishable at your volume, and its worst failure mode is a delay.

### Digest rules

- fires only if `pending > 0` (no "nothing to do" noise — your requirement)
- once per day maximum, guarded by `_state/notified/{YYYY-MM}/sef_digest-{YYYY-MM-DD}.json` written with `If-None-Match: *`
- counts pending as of send time, not as of the last poll
- inline accept/reject via the existing button-router handlers

### The loop-closer

On accept: download the SEF PDF → `ingestDocument(category='sef_inbound')` → linked to `_state/sef/inbound/{sef_id}.json`.

Consequence: **accepted supplier invoices are in the accountant package automatically.** This is the highest-leverage small feature in E — it deletes the "did I download all the SEF invoices" chore entirely.

On reject: reason via buttons (wrong amount / wrong recipient / duplicate / other), passed to SEF as the comment. No PDF archived — it isn't DILIGAF's document.

---

## 5. Monthly package to the accountant

### Trigger

```
fn: monthly-package-timer    1st of month, 06:00 UTC (07:00 CET / 08:00 CEST)
```

The fixed UTC cron drifts an hour across DST. Accept it — 07:00 vs 08:00 is harmless. The part that would actually hurt is packaging the wrong month, and that can't happen: period selection is a pure function of the injected clock, not of the cron expression.

### What it does

```
1. period = previousMonth(clock.now())                  ← pure, tested at year boundaries
2. docs   = list blobs under diligaf/{YYYY}/{MM}/        ← the path IS the index
3. facts  = read each sidecar .json
4. txns   = fold(ledger blobs for the period)            ← totals only
5. manifest = buildManifest(facts)                       ← pure: rows, per-category totals, warnings
6. zip    = DILIGAF-2026-07.zip
              izvodi/…   expenses/…   invoices/…   sef/…
              manifest.csv   README.txt
7. store  → packages/diligaf/2026-07/DILIGAF-2026-07.zip
8. notify → template e_monthly_package  [Pošalji] [Prikaži listu] [Odloži]
9. on confirm → SMTP send to books.accountant_email
10. log   → _state/notified/2026-08/monthly_package.json  (If-None-Match)
```

### Period semantics (D6)

On 1 August, E packages **July**. Your note said "current month"; on the 1st the current month is one day old, so this is almost certainly what you meant — flagged because it's the kind of thing that's silently wrong for a year.

Late arrivals (a July receipt landing on 3 August) get `period = 2026-07` from their `doc_date` and are picked up by `/report 2026-07`, which re-compiles and re-sends marked `(revidirano)`.

### Email body

Generated by `engine/packaging/email-body.ts` — pure, snapshot-tested:

```
Subject: DILIGAF DOO — dokumentacija za jul 2026

Zdravo,

u prilogu je dokumentacija za jul 2026.

IZVODI (3)
  2026-07-05  izvod 265-07-01.pdf
  2026-07-15  izvod 265-07-02.pdf
  2026-07-31  izvod 265-07-03.pdf

TROŠKOVI (14) — 186.430,00 RSD  (PDV 31.071,67)
  2026-07-02  OMV Srbija               4.210,00
  2026-07-04  Kancelarijski materijal  8.900,00
  …
  ⚠ 2026-07-19  nepoznat dobavljač     iznos nije pročitan

IZLAZNE FAKTURE (2) — neto 600.000,00 + PDV 120.000,00 = 720.000,00 RSD
  0007/2026  Klijent A   360.000,00
  0008/2026  Klijent B   360.000,00

SEF ULAZNE — PRIHVAĆENE (4) — 41.220,00 RSD
  2026-07-09  Telekom Srbija  12.480,00
  …

Ukupno u prilogu: 23 dokumenta.
Napomena: 2 dokumenta bez pročitanog iznosa (obeležena ⚠ i u manifest.csv).

E
```

The `⚠` lines are deliberate. An accountant who can see what's uncertain is far more useful than a clean list that hides it. `manifest.csv` carries an `extraction_method` column for the same reason — anything read by an LLM is visible as such.

### Attachment vs link

| Zip size | Behavior |
|---|---|
| ≤ 8 MB | attach directly |
| > 8 MB | attach `manifest.csv` only; body carries a 7-day SAS link to the zip |

Accountants prefer attachments; mail infrastructure prefers links. 8 MB keeps the common case an attachment and stays well under iCloud's ~20 MB message ceiling.

### Outbound adapter

`nodemailer` → SMTP, from your own address. Recipient read from `_state/books.json` server-side, **never** from request input, so nothing that reaches the function can redirect your accounting data.

Config: `SMTP_HOST/PORT/USER/PASS` (Key Vault), `SMTP_FROM`. iCloud: `smtp.mail.me.com:587` STARTTLS with the same app-specific password as IMAP.
