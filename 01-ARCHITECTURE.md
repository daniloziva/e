# E — Architecture

> **v2.** Supabase removed (blob-only). Power Automate removed (IMAP/SMTP). Extraction reordered deterministic-first.

## 1. The shape of the whole thing

```
INGEST  →  EXTRACT  →  STORE  →  REPORT
```

- **Ingest** — a document or a fact arrives from WhatsApp, email (IMAP), or SEF.
- **Extract** — get vendor/date/amount, using the cheapest *deterministic* method that works (§5).
- **Store** — bytes and facts to Blob. Blob is the only store. Everything derived is rebuildable.
- **Report** — monthly accountant package, daily SEF digest, review queue.

Every feature in `03`–`05` is a path through those four verbs, so the pipeline is written and tested once.

## 2. Components

```
   WhatsApp (you) ──────►┌───────────────────────────┐
                         │ fn: whatsapp-webhook      │
                         │ (HTTP, HMAC-verified)     │
                         └────────────┬──────────────┘
                                      │
  iCloud / self-hosted                │
   mailbox  ◄──IMAP poll──►┌──────────▼──────────────┐
            ◄──SMTP send───│  engine/ (pure, tested) │
                           │  routing · parsing ·    │      ┌──────────────────────┐
   SEF eFaktura ◄─poll 30m►│  extraction rules ·     │◄────►│  Azure Blob Storage  │
                           │  folding · compiling    │      │  (THE store)         │
   Document Intelligence ◄►│                         │      └──────────────────────┘
                           └──────────┬──────────────┘
   Timers ──────────────►             │
   · imap-poll     10m                └──► WhatsApp Cloud API (replies, PDFs, digests)
   · sef-poll      30m
   · sef-digest    daily 07:00 UTC
   · monthly-pkg   1st 06:00 UTC
```

**Runtime:** Azure Functions v4, Node 20, TypeScript, ESM. Every trigger E needs is native, cost at this volume is ~zero, and 1IA is a working reference for the deployment.

**No Logic Apps.** A Logic App would give a visual run history that App Insights already provides, in exchange for a second deploy artifact and a second place to look when something breaks. Timers live in the function app with the code they trigger.

## 3. Storage: blob only

### Why no database

E is one user, ~100 documents and ~500 transactions a month. At that size a relational database buys ad-hoc SQL and costs a service, a connection string, RLS reasoning, migration management, and a Postgres container in CI. Blob Storage supplies the two primitives that actually mattered:

| Need | Blob mechanism | Guarantee |
|---|---|---|
| dedupe by content | `PUT _index/hash/{book}/{sha256}` with `If-None-Match: *` | atomic create-if-absent, strongly consistent; 409 = duplicate |
| idempotent event | `PUT _index/event/{kind}/{id}` with `If-None-Match: *` | same |
| safe update of mutable state (rules, customers, conv) | `GET` → ETag → `PUT If-Match: {etag}` → 412 → bounded retry | compare-and-swap |
| "query by book+period" | prefix listing — the path *is* the index | strongly consistent |
| review queue | pointer blobs under `_queue/review/`, deleted on resolve | strongly consistent |
| ledger of money facts | one immutable blob per event, folded at read | no read-modify-write, no races |
| append-only log | one blob per entry (not Append Blob — fewer quirks, same effect) | — |
| TTL | expiry field inside the state JSON, checked on read + lifecycle rule sweeps | — |

**Not using blob index tags.** They're queryable but eventually consistent, and prefix listing plus pointer folders covers every query E has. Never use tags for dedupe or idempotency.

**The invariant that makes this safe:** *every derived artifact is rebuildable by replaying the event blobs.* Rollups, review queues, and monthly summaries are caches. If one is wrong, delete it and it regenerates.

**What we give up, plainly:** no SQL console to poke around in, and aggregation happens in TypeScript instead of the query planner. Neither costs anything at one user — and pure-function aggregation over in-memory arrays is markedly easier to unit-test than SQL. If E ever became multi-user this design would need revisiting; that's what 1IA (which keeps Postgres) is for.

### One carve-out: Table Storage for disposable reference data (Danilo, 2026-08-17)

**Exchange rates live in Table Storage, not blob.** `PartitionKey` = currency, `RowKey` = date.

This does not reopen D2. D2 refused a *relational database* — a service, a connection string, RLS
reasoning, migrations, a Postgres container in CI. Table Storage is a different API surface on the
**same storage account**: same resource, same managed identity, same credential, no new service to
provision. The incremental cost is one adapter and one fake.

The deciding argument is that the rate cache is **not the system of record.** A transaction's rate is
frozen onto it at capture (`rate` + `rateDate` on the ledger event), because a recomputed rate would
silently move historical reports and change a package already sent to the accountant. That makes the
cache a disposable lookup accelerator — losing it entirely costs nothing and rebuilds itself.

Blob earns its place in this design through `putIfAbsent` and `casPut`: atomic create-if-absent and
compare-and-swap. Write-once reference data needs neither. What it does want is cheap point lookups
and date-range queries, which is precisely Table Storage's shape.

**The boundary, so this stays one carve-out and not a habit:** blob remains THE store for anything
that is a money fact, a document, or mutable state — the ledger, sidecars, `_state`, `_index`,
`_queue`. Table Storage is only for data that is *derived, immutable and disposable*. Anything that
would be missed if it vanished belongs in blob.

### Layout

One GPv2 account, **hierarchical namespace off**, one private container `e-docs`:

```
# ── documents: immutable bytes + a sidecar of extracted facts ──
diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg
diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.json      ← facts sidecar
diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf   (+ .json)
diligaf/2026/08/invoice_out/2026-08-01--faktura-0007-2026--c40a1e88.pdf   (+ .json)
diligaf/2026/08/sef_inbound/2026-08-09--telekom-srbija--7ad3f012.pdf     (+ .json)
personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf    (+ .json)
smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.pdf           (+ .json)

# ── ledger: one immutable blob per money event, folded at read ──
personal/2026/08/tx/01J9F2QK7X8-statement.json     ← N transactions from one statement
personal/2026/08/tx/01J9G4M1P2Q-cash.json          ← one /cash entry
personal/2026/08/tx/01J9H8T5R3V-correct.json       ← {op:'set_category', ref, category}
smoqua/2026/08/tx/01J9K2N4S8W-cash.json

# ── indexes: existence markers, written with If-None-Match ──
_index/hash/diligaf/91be0d47a1…c9.txt              ← content dedupe
_index/event/wa/wamid.HBgLMzgxNjQ…                 ← WhatsApp message id
_index/event/mail/3f9a1c…                          ← hashed Message-ID + attachment idx

# ── queues: work that needs a human ──
_queue/review/diligaf/2026-08-11--omv--91be0d47.json
_queue/review/personal/01J9F2QK7X8--wolt-beograd.json

# ── state: small mutable JSON, ETag-guarded ──
_state/books.json                                  ← the 3 books, sender phones, config
_state/customers/{id}.json                         ← incl. country, is_business, last_invoice_number
_state/invoice-numbers/diligaf/{number}.json       ← used-number marker, for the duplicate warning
_state/rules/personal.json                         ← categorization rules
_state/rules/smoqua.json                           ← vendor/item → dimensions
_state/vendor-profiles.json                        ← learned trust + hints, matched by content (layer 2)
_state/synonyms.json                               ← EVRA→EUR, MATERIJAAL→MATERIALS, learned
_cache/extract/{sha256}.json                       ← model output, keyed by document content
_cache/intent/{hash}.json                          ← model output, keyed by normalized message
_state/conv/381641234567/invoice.json              ← wizard state + expiry
_state/sef/inbound/4471039.json                    ← SEF invoice status
_state/notified/2026-08/sef_digest-2026-08-11.json ← "already sent" marker

# ── derived caches: delete-safe, rebuildable ──
_rollup/diligaf/2026-08.json
_rollup/personal/2026-08.json

# ── output ──
packages/diligaf/2026-07/DILIGAF-2026-07.zip
packages/diligaf/2026-07/manifest.csv
```

Document path convention:
```
{book}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}
```

Properties: the month's package is a prefix listing; `sha8` makes names collision-proof without UUID soup; your accountant (or future you) can navigate it in Storage Explorer with no tooling; and the `YYYY/MM` in the path always equals the sidecar's `period` — asserted in tests.

### Sidecar shape (`…--91be0d47.json`)

```json
{
  "book": "DILIGAF", "category": "expense", "period": "2026-08",
  "source": "whatsapp", "source_ref": "wamid.HBgLMzgx…",
  "blob_path": "diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg",
  "filename": "IMG_4821.jpg", "mime_type": "image/jpeg",
  "byte_size": 812443, "sha256": "91be0d47…",
  "vendor_name": "OMV Srbija", "vendor_pib": "100002887",
  "doc_date": "2026-08-11",
  "amount_net": 3508.33, "vat_amount": 701.67, "amount_total": 4210.00,
  "currency": "RSD", "amount_rsd": 4210.00,
  "dimension": null,
  "extraction": { "method": "fiscal_qr", "confidence": "exact", "raw": { … } },
  "review_status": "ok",
  "created_at": "2026-08-11T09:14:22Z"
}
```

`extraction.method` is one of `pdf_text | fiscal_qr | di_ocr_regex | di_invoice | llm_vision | manual` (§5). It's carried into the manifest and `/status` so LLM usage is visible and prunable.

### Retention

Soft-delete 30 days, versioning on for `_state/**`, no overwrite of documents ever (the path contains the content hash). Lifecycle: cool tier after 90 days, keep forever — this is accounting data measured in megabytes.

## 4. Project structure

```
e-app/
  function-app/
    src/
      functions/                  ← thin Azure bindings ONLY. no logic.
        whatsapp-webhook.ts
        imap-poll-timer.ts
        sef-poll-timer.ts
        sef-digest-timer.ts
        monthly-package-timer.ts
        health.ts
      engine/                     ← PURE. no fetch, no fs, no env, no clock, no randomness.
        books.ts                  ← phone → book, book config shape
        command-parser.ts
        money.ts                  ← "4.210,00" | "300e" | "12k" → amount + currency
        clock.ts / ids.ts         ← Clock and IdGen interfaces (injected)
        mail/
          route.ts                ← (from, subject) → book + category
          parse-eml.ts            ← MIME → { headers, attachments } (via adapter's parsed input)
        extract/
          ladder.ts               ← orchestrates §5 order, records method + confidence + model
          pdf-text-rules.ts       ← regex/positional parse of digital PDFs
          fiscal-qr.ts            ← QR payload → verification URL + response → facts
          fiscal-receipt-regex.ts ← Serbian fiscal receipt layout over OCR text
          di-map.ts               ← DI prebuilt-invoice/receipt fields → facts
          llm-map.ts              ← LLM structured output → facts (validation, not the call)
          vendor-profile.ts       ← learned per-vendor trust + hints (layer 2)
          validate.ts             ← the rejection rules — applied to EVERY layer's output
        nlu/
          slots.ts                ← deterministic slot extraction: money, dimensions, dates
          synonyms.ts             ← EVRA/evro/€ → EUR; MATERIJAAL → MATERIALS (fuzzy, tested)
          interpret.ts            ← merges deterministic slots with LLM slots, decides confirm-vs-commit
          confirm-policy.ts       ← when a tap is required (amount thresholds, low confidence)
        statements/
          parse-personal.ts       ← coordinate-band parser
          reconcile.ts            ← opening + credits − debits ≈ closing
          normalize.ts            ← raw lines → Transaction[] + dedupe keys
        ledger/
          fold.ts                 ← event blobs → Transaction[]  (pure, the heart of reporting)
          categorize.ts           ← §5.1 signal ladder, rules before model
          rules.ts                ← rule derivation, precedence, normalization
          ambiguous-vendor.ts     ← detects vendors that resolve more than one way
          split.ts                ← one document → several categorized amounts
        documents/
          blob-path.ts
          fingerprint.ts
        invoicing/
          invoice-model.ts        ← VAT modes, totals, rounding
          vat-mode.ts             ← resolveVatMode(customer) — domestic 20% / export none
          invoice-number.ts       ← suggestNextNumber(last) — suggestion only, never allocation
          invoice-template.ts     ← builds PdfInvoiceData (data, not drawing)
        packaging/
          manifest.ts
          email-body.ts
        dimensions.ts             ← SMOQUA aliases → canonical
      adapters/                   ← ALL I/O. thin. faked in tests.
        store/
          blob-store.ts           ← put/get/list/exists/putIfAbsent/casPut  (+ Azure impl)
          doc-store.ts            ← document + sidecar reads/writes
          ledger-store.ts         ← append event blob, list month
          state-store.ts          ← ETag-guarded JSON
          queue-store.ts
          cache-store.ts          ← content-hash cache for model output (§5 mechanism 3)
        whatsapp/
          sender.ts   media.ts   signature.ts   template.ts
        sef/client.ts             ← from 1IA, verbatim
        mail/
          imap.ts                 ← imapflow: fetch, parse, move to Processed/Failed
          smtp.ts                 ← nodemailer
        doc-intelligence/client.ts
        llm/
          vision.ts               ← schema-constrained document read
          slots.ts                ← schema-constrained slot fill for free-text messages
          classify.ts             ← schema-constrained categorization
          client.ts               ← one place that records model id + caches by hash
        qr/decode.ts
        pdf/
          invoice-pdf.ts          ← pdfkit drawing (from 1IA)
          text-extract.ts         ← pdfjs-dist text + coordinates
        zip/archive.ts            ← fflate
      app/                        ← composition. one file per use case.
        handle-whatsapp-message.ts
        poll-mailbox.ts
        ingest-document.ts        ← THE shared pipeline
        run-sef-poll.ts   send-sef-digest.ts
        send-monthly-package.ts
        resolve-review-item.ts
    test/ { unit, contract, app, fixtures, fakes }
  docs/
  infra/
```

**The rule:** `functions/` parse a trigger, call one `app/` function, return. `engine/` never imports `adapters/` (eslint-enforced). `app/` receives adapters as arguments. That's the whole discipline, and it's what makes §5 and §6 testable without a network.

## 5. The hybrid principle: the model proposes, the code decides

E uses AI wherever input is genuinely unstructured, and never for control flow. The dividing line is not "how much AI" but **what the model is allowed to do with its answer**.

| The model may | The model may never |
|---|---|
| fill slots in a fixed schema (amount, vendor, date, dimensions) | choose which code path runs |
| propose a classification with a confidence | write money without passing validation |
| read a document layout it has never seen | bypass the confirm step when it's unsure |
| resolve `EVRA` → `EUR`, `MATERIJAAL` → `MATERIALS` | invent a PIB, a date, or a total |
| suggest a rule you might want | silently change its mind about the same input twice |

Five mechanisms turn "an LLM is in the loop" into a system you can still trust and audit:

1. **Structured output only.** Every model call returns JSON against a fixed schema (tool/function calling). Free text never drives behavior. If the JSON doesn't validate, it's a failure, not an interpretation.
2. **Same validators regardless of source.** `engine/extract/validate.ts` runs on model output exactly as it runs on regex output. PIB is 9 digits or null whether a human, a regex, or GPT produced it.
3. **Cache by content hash.** `_cache/extract/{sha256}.json` and `_cache/intent/{hash(normalized text)}.json`. The same receipt image or the same phrase resolves identically forever — re-running a month reuses the cached answer unless you explicitly invalidate. **This is what makes the system reproducible even though the model isn't deterministic**, and it's the property you actually wanted when you said "deterministic".
4. **Provenance on every fact.** `extraction.method`, `confidence`, `model` (e.g. `gpt-4o-mini@2026-05`), and the raw response. When a model version changes, you can tell exactly which facts came from the old one and re-run only those.
5. **Confirm when uncertain, commit when not.** High confidence with every slot filled → E just does it and shows a one-line receipt with `[Ispravi]`. Anything ambiguous → E echoes its interpretation and waits for a tap. The model never silently commits money it wasn't sure about.

Together these mean: AI expands what E can *understand*, and none of it expands what E can *do without telling you*.

### The extraction ladder

Still ordered cheapest-and-most-certain first — but the model is now a first-class rung, not a last resort. Stop at the first layer that yields a confident result; record which one did.

| # | Layer | Applies to | Character |
|---|---|---|---|
| 0 | **Cache hit** (`sha256`) | anything seen before | exact, free, instant |
| 1 | **Fiscal QR → `suf.purs.gov.rs`** | Serbian fiscal receipts | exact, government-signed |
| 2 | **Learned vendor profile** | a vendor whose layout you've already corrected once | deterministic, and it compounds |
| 3 | **PDF text layer + regex** | izvodi, statements, known digital layouts | deterministic, free |
| 4 | **DI `prebuilt-invoice` / `prebuilt-receipt`** | **arbitrary supplier layouts — the 90-layout problem** | fixed model, per-field confidence, no prompt drift |
| 5 | **LLM vision** | what DI reads with low confidence; odd, handwritten, foreign, photographed-screen documents | schema-constrained, cached, labelled |
| 6 | **Manual `[Unesi iznos]`** | anything | you. the floor, never removed. |

**Layer 4 is the answer to 90 invoice layouts.** Document Intelligence's prebuilt invoice model exists precisely to generalize across layouts it hasn't seen, and it returns typed fields with per-field confidence rather than prose. It is a model, but not a prompt-driven one — so it doesn't drift when someone edits a string. A hand-written regex per supplier was never going to work and I shouldn't have implied it might.

**Layer 2 is the compounding one.** The first time a vendor's document is read wrong and you fix it, E stores what it learned — in **one file, matched by content, with no derived filename** (D20):

```
_state/vendor-profiles.json
  { "01J9F2QK7X8": {
      "pib": "100002887",                    ← identity
      "names": ["OMV Srbija", "OMV SRBIJA DOO BEOGRAD"],   ← matchable aliases
      "trust": { "amountTotal": "di.InvoiceTotal", "docDate": "di.InvoiceDate" },
      "hints": { "dateFormat": "DD.MM.YYYY", "decimal": ",", "currencyDefault": "EUR" },
      "defaultCategory": "MATERIALS",        ← only when unambiguous, see §5.1
      "corrections": 3, "lastSeen": "2026-08-11" } }
```

Why one file rather than a file per vendor: a filename derived from mutable data strands itself. Key a profile `omv-srbija.json` today, learn the PIB tomorrow, and the old file is orphaned with no rename rule. At 50–200 vendors the whole map is ~50 KB — load it, match on **content** (`pib` first, then `names`), and there is no key to go stale. Aliases become an ordinary array instead of a migration. A blob GET is 10–30 ms against extraction measured in seconds, so the read costs nothing; updates use the ETag CAS already in the store interface, and a single writer means no contention.

**Identity is the PIB, and the canonical name comes from one authoritative source** — not from whatever a receipt happened to print. That makes name normalization uniform by construction rather than by regex, and retires the diacritic-folding question (`Đ` → `d` or `dj`?) that three engineers split on. Two candidate sources, and a spike decides:

| Source | Character |
|---|---|
| **APR open data** (1IA already shipped `apr_companies` + a trigram search) | local, deterministic, offline, no rate limit — the better fit for a hot path |
| **NBS PIB lookup** (`nbs.rs`, also returns bank accounts) | live; unconfirmed whether it is a documented API or an HTML form to parse |

*Caveat that needs a fallback:* **foreign vendors have no Serbian PIB**, and SMOQUA — where the 90-layout problem actually lives — buys abroad. For those, identity falls back to normalized name plus a `/tebra`-confirmable merge.

Second invoice from a known vendor takes layer 2 and never reaches the model. So **90 layouts becomes 90 one-time corrections**, after which the common path is deterministic again. The system converges toward the cheap rungs instead of sitting permanently on the expensive one — and `/status` reports the mix so you can watch it happen.

**Trust labels are atomic keys, never paths.** `applyProfile` reads `raw[profile.trust[field]]` — one flat lookup. Adapters flatten their own wire shapes into that map, so `engine/` never learns Document Intelligence's response tree (and the `engine/` ↔ `adapters/` import ban stays meaningful). This is also a security boundary: trust labels live in `_state`, which `/tebra` can propose edits to, so treating one as a dotted path would turn `__proto__.polluted` into a write into `Object.prototype` reachable from a model-authored proposal. Asserted in `test/unit/extract-ladder.test.ts`.

Second invoice from that vendor takes layer 2 and never reaches the model. So **90 layouts becomes 90 one-time corrections**, after which the common path is deterministic again. The system converges toward the cheap rungs instead of sitting permanently on the expensive one — and `/status` reports the mix so you can watch it happen.

### Spikes (unchanged, both against real files — `07-ROADMAP.md` M1)

- **S-QR:** confirm the exact `suf.purs.gov.rs` verification response — JSON endpoint or HTML page, and **whether it returns line items**, which matters a great deal for categorization (§5.1). I'm confident the path exists and is authoritative; I'm not confident of its shape.
- **S-DI:** measure `prebuilt-receipt` and `prebuilt-invoice` on real Serbian documents. This now decides how often layer 5 fires, not whether layer 4 exists.
- **S-PIB:** confirm how to resolve a PIB to a canonical company name. Compare APR open data (local, deterministic — 1IA's `apr_companies` table and trigram search already exist) against the NBS `nbs.rs` PIB lookup, whose response shape is unconfirmed. **Outcome:** the vendor-identity contract, which is the one part of the frozen test suite still provisional (`TEST-FREEZE.md`).

### Validation and failure

`engine/extract/validate.ts` applies to every layer's output: PIB exactly 9 digits or null; `doc_date` within `[now − 18 months, now + 2 days]`; `0 < amount_total < 100,000,000`; `vat_amount ≤ amount_total` or drop the VAT only; currency from an allowlist. Any null in `{amount_total, doc_date}`, or confidence below threshold, ⇒ `review_status='needs_review'`.

**Extraction failure never blocks storage.** The bytes land first, always. A receipt with an unreadable total is stored, queued, and one tap from fixed.

## 5.1 Categorization — why vendor isn't enough

You're right that vendor→category can't work: the same shop sells you food, a gift, and something for the kids.

What actually determines the category is **what you bought**, not who you bought it from. So the signal ladder is:

| # | Signal | Example |
|---|---|---|
| 0 | **You said so** in the message | `/cash 800 parking` → TRANSPORT; `MATERIJAL PAMUK 200E` → MATERIALS |
| 1 | **Line items** from the fiscal QR or OCR text | receipt lists `PAMPERS`, `MLEKO` → DECA + HRANA, not "Maxi" |
| 2 | **Learned rule** matching (vendor **+ item pattern + amount band**) | `WOLT` → HRANA (vendor alone is enough here) |
| 3 | **LLM classify** given vendor, line items, amount, your category list, and your recent similar transactions | mixed basket, unfamiliar merchant |
| 4 | **MISC** → review queue | genuinely can't tell |

Two mechanisms do the heavy lifting:

**Ambiguous-vendor detection.** If a vendor has been categorized more than one way in your history, E **stops auto-applying** and drops to line items or asks. That's a deterministic meta-rule, and it means E works out which of your vendors are ambiguous by itself rather than needing me to guess them in advance.

```
vendorIsAmbiguous(vendor, history) → boolean        ← pure, tested
```

**Split transactions.** A single receipt can carry two categories (nappies and beer). E supports splitting a document's amount across categories, offered automatically when line items disagree with each other. Without this, a mixed basket forces a lie.

Rules stay the deterministic backbone and keep learning from your taps — but they're now `(vendor, item pattern, amount band) → category`, not just vendor. And when the rules can't decide, a model that can see the line items is far better placed than a lookup table.

## 6. Email: IMAP in, SMTP out

Your mailbox is iCloud or self-hosted, so there is no Graph API and no usable Power Automate connector. Direct IMAP/SMTP is simpler, cheaper, and — the part that matters — **testable from a `.eml` fixture with zero network**, which an opaque Power Automate payload never was.

### Inbound

```
fn: imap-poll-timer   every 10 min
  1. connect (TLS), open the watch folder
  2. fetch UNSEEN
  3. for each message: parse MIME (mailparser) → { messageId, from, subject, attachments[] }
  4. route(from, subject) → { book, category }   ← pure, tested
  5. for each attachment: ingestDocument(...)
  6. success → MOVE the message to  E/Processed
     no route match / failure → MOVE to  E/Failed  + log
```

**Folder moves are the idempotency mechanism.** A processed message is no longer in the watch folder, so a double-poll can't reprocess it — and you get a human-visible audit trail in your own mail client, which beats any log. The `_index/event/mail/*` marker is belt-and-braces for the crash-between-ingest-and-move case.

Recommended: a server-side rule (Sieve on self-hosted, a Rule on iCloud) files matching mail into `E/Inbox` so E only ever polls one folder and never touches your actual inbox.

Config: `IMAP_HOST/PORT/USER/PASS`, `IMAP_WATCH_FOLDER`, `IMAP_PROCESSED_FOLDER`, `IMAP_FAILED_FOLDER`.

iCloud specifics: `imap.mail.me.com:993`, and a **app-specific password** is required on a 2FA account. Self-hosted is the more reliable of the two if it's already receiving the bank mail — Apple rate-limits IMAP connections, which a 10-minute poll won't hit but is worth knowing.

### Outbound

`nodemailer` → SMTP (`smtp.mail.me.com:587` STARTTLS, or your own host). Sends from your own address, so your accountant sees a familiar sender with no domain warm-up or third-party service.

The recipient is read from `_state/books.json` server-side and **never** taken from request input, so a confused or hostile caller can't redirect your accounting data.

Attachment ceiling: iCloud caps messages around 20 MB; self-hosted is your own limit. E attaches zips ≤ 8 MB and switches to a 7-day SAS link above that (`03-DILIGAF.md` §5).

## 7. The shared ingest pipeline

Every document path converges here. It gets the heaviest tests in the project.

```
ingestDocument(deps, { book, category, bytes, filename, mimeType, source, sourceRef, hints })
  1. fingerprint          → sha256, byte_size                            [pure]
  2. dedupe               → putIfAbsent(_index/hash/{book}/{sha256})
                            409 ⇒ return { status:'duplicate', existing }
  3. extract              → ladder(§5), cheapest deterministic layer first
  4. validate             → validate.ts; nulls are normal, not errors     [pure]
  5. resolve period       → doc_date's month → hint → clock.now()         [pure]
  6. build path           → blobPathFor(...)                              [pure]
  7. put bytes            → blob.put(path, bytes, mimeType)
  8. put sidecar          → blob.put(path + '.json', facts)
  9. side effects         → statement ⇒ write tx event blob
                            needs_review ⇒ write _queue/review pointer
                            sef ⇒ update _state/sef/inbound/{id}.json
 10. invalidate rollup    → delete _rollup/{book}/{period}.json
 11. return IngestResult  → drives the WhatsApp reply
```

Ordering is deliberate: **dedupe before spending money on extraction**, and **bytes before sidecar** so a crash leaves a document with no facts (recoverable by re-running extraction) rather than facts pointing at nothing (a lie).

## 8. Security

E can accept SEF invoices and email your accountant. Both are outward-facing actions reachable from inbound HTTP.

| Surface | Control |
|---|---|
| `whatsapp-webhook` | **`X-Hub-Signature-256` HMAC against `WHATSAPP_APP_SECRET`**, `timingSafeEqual`, 403 on mismatch. *1IA does not do this today — its webhook is `authLevel:'anonymous'` with no signature check, so anyone who learns the URL can forge messages and trigger SEF accepts. E must not inherit that.* |
| `whatsapp-webhook` | sender allowlist from `books.json`; unknown sender → 200, log, no reply (don't confirm E exists to strangers) |
| IMAP ingest | sender + subject must match a route, else `E/Failed`; no route ⇒ no guess. **No inbound HTTP surface at all** — a real reduction in attack surface vs the Power Automate design |
| Outbound email | recipient from `books.json` only; monthly package requires your confirmation tap |
| Secrets | App Settings → Key Vault references, function app managed identity. `SEF_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `IMAP_PASS`, `SMTP_PASS`, `DOCINTEL_KEY`, (`AZURE_OPENAI_API_KEY` only once layer 4 exists). Nothing in the repo. |
| Blob | no public access; managed identity only; sharing via short-lived user-delegation SAS (≤7 days) |
| Logs | never log document bytes, PDF text, statement contents, or mail bodies. Log ids, hashes, counts, and the extraction method. |
| PII | personal statements are your whole spending history. Encryption at rest is default; the real control is that only the app's managed identity can read the container. |

Two caveats stated rather than buried: (a) an IMAP password in Key Vault is a long-lived credential — rotate it if you ever suspect the function app; (b) layers 2–4 send document images to Azure services, which is a processor relationship you're accepting for your own DOO's receipts. Layers 0–1 send nothing anywhere, which is one more reason to prefer them.

## 9. Idempotency and clock discipline

- Every inbound event writes an `_index/event/*` marker with `If-None-Match: *` **before** doing work. Repeats are no-ops. WhatsApp redelivers; timers can double-fire on scale-out.
- Mail idempotency is primarily structural (folder moves, §6).
- Timers check `_state/notified/*` so the digest and the monthly package can't send twice.
- `engine/` never reads the clock or generates ids — `Clock` and `IdGen` are injected. Month boundaries, "previous month" on 1 January, leap years, and the DST drift on the 06:00 UTC timer all become plain unit tests rather than things you discover in January.
- Timers are declared in UTC with an explicit CET/CEST comment. The *which month am I packaging* decision is a pure function of the injected clock, never of the cron expression — so DST drift can shift the hour but can never pick the wrong month.

## 10. Dependencies

| Package | For |
|---|---|
| `@azure/storage-blob` + `@azure/identity` | the store |
| Document Intelligence client SDK (exact package pinned at M0) | layers 2–3 |
| a QR decoder (`jsqr` or a zxing wasm build) | layer 1 |
| `pdfjs-dist` | PDF text + coordinates (layer 0, statements) |
| `imapflow` + `mailparser` | inbound mail |
| `nodemailer` | outbound mail |
| `fflate` | zip (pure JS, no native deps unlike `archiver`) |
| `ulid` | sortable event-blob ids |
| `openai` | Azure OpenAI — schema-constrained slot fill, vision, classification (§5) |
| `vitest` | tests |

Kept from 1IA: `@azure/functions`, `pdfkit`, `openai`.
**Dropped:** `@supabase/supabase-js` (no DB).

Note on the model: structured output is a hard requirement, so the deployment must support tool/function calling or JSON-schema response format. Nothing in E parses prose from a model.

## 11. Environments

Two: `local` (Functions Core Tools + Azurite) and `prod` (one function app). No staging — one user, a full suite, and a smoke checklist per milestone. `npm test` runs **fully offline**: Azurite for blob, `.eml` and PDF fixtures for mail and documents, recorded payloads for WhatsApp/SEF/DI. No Postgres container, no Supabase project, no network in CI.
