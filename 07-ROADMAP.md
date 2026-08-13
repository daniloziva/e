# E — Roadmap

Ordering principle: **the thing that validates the WhatsApp bet ships first.** M1 answers "does this feel good?" If the answer is no, M2–M7 don't matter and 1IA needs rethinking. Everything after M1 is ordered by pain relieved per day of work.

Sizes are relative effort, not calendar promises.

| M | What | Size | Blocked by |
|---|---|---|---|
| M0 | Repo, test harness, CI, infra | S | — |
| M1 | WhatsApp expense capture + the NLU layer, end to end (+ 2 spikes) | M–L | F4, F7, **F10** |
| M2 | IMAP ingest → izvodi + expense-by-subject | M | F1, F5, IMAP host+creds |
| M3 | Invoice issuing (PDF only, no SEF submit) | S | F8, the export exemption note text |
| M4 | Monthly accountant package | M | M1–M3 |
| M4.5 | `/tebra` read-only — tools, loop, render | M | M4 (needs real data) |
| M5 | SEF digest + inline accept + auto-archive | S | template approval |
| M6 | Personal statement parsing + categorization | L | F2, F9 |
| M7 | SMOQUA + dimensions | S | M1 |
| M8 | `/tebra` edits — proposals, rules, undo, audit | M | M4.5, M6 |
| M9 | MCP server — same tools, external clients | S | M4.5 |

M1 grew a little (the NLU layer and caching moved in from later). M3 shrank (no SEF sales submission, no XML builder, no counter — D10/D12). M6 keeps its deterministic statement parser but gains the categorization signal ladder.

---

## M0 — Foundation

Nothing user-visible. Exists so that M1 can be written test-first on day one instead of "we'll add tests after."

**Build:**
- Repo `E/e-app`, structure per `01-ARCHITECTURE.md` §4
- vitest + coverage thresholds + eslint (incl. the `core/` → `adapters/` import ban)
- Docker compose: **Azurite only** (no Postgres — D2)
- `BlobStore` interface + Azure impl + `InMemoryBlobStore`, sharing one contract test suite
- Fakes: `FakeClock`, `SeqIdGen`, `FakeWhatsApp`, per-layer extractor stubs
- Test harness (`harness()` from `06-TDD-STRATEGY.md` §4 L3)
- GitHub Actions: lint → unit → contract (Azurite) → build
- `_state/books.json` seeded with the three books
- Azure: storage account (**GPv2, hierarchical namespace OFF**) + private container `e-docs` (soft-delete 30d, versioning on `_state`), function app, Key Vault, managed identity
- `health.ts` — the one function; proves deployment works

**First tests (in this order, each red before green):**
1. `blob-path.ts` — a path is built for a known input *(the first real test in the project; pure, useful, and it forces the `Book`/`Category` types into existence)*
2. `books.ts` — phone resolves to book; unknown → null
3. **`putIfAbsent` returns 409 on the second call** — against both `InMemoryBlobStore` and Azurite, same suite
4. **`casPut` returns 412 on a stale ETag**; two concurrent CAS writes, exactly one wins

Tests 3 and 4 are the foundation of the no-database design. They come before any feature code because if Azurite's behavior surprises us, the storage model needs to change while nothing depends on it yet. (Test 4 matters less now that there's no invoice counter — D12 — but `_state` updates to rules, customers, and conversation state still ride on it.)

**Done when:** `npm test` passes offline with no Postgres anywhere, CI is green, `/api/health` responds in Azure, and the coverage gate demonstrably fails on a deliberately uncovered line.

---

## M1 — Expense capture from WhatsApp ⭐

The milestone that matters. Everything else is bookkeeping.

### Spikes first (both timeboxed, both before any extraction code)

- **S-QR (½ day, needs F10).** Take one real fiscal-receipt QR payload. Determine: does the payload itself carry the totals, or only a verification URL? Does `suf.purs.gov.rs` expose a JSON endpoint, or is it an HTML page to parse? How stable is that surface? **Outcome:** either layer 1 is confirmed as the primary path for fiscal receipts (and E needs no ML for its most common document), or it's dropped and layer 2 becomes primary. Either way we know before writing a line.
- **S-DI (½ day, needs F4).** Run real Serbian fiscal receipts and a couple of foreign supplier invoices through Document Intelligence `prebuilt-receipt` and `prebuilt-invoice`. Measure per-field accuracy against ground truth. **Outcome:** how often the LLM rung has to fire, and whether receipts are better served by OCR + our fiscal regex.

These two spikes decide the *shape* of the ladder — which rungs exist and in what order. Doing them first is cheaper than building rungs and discovering they're dead weight.

Both spike outputs become the first entries in the eval corpus (`06-TDD-STRATEGY.md` §4.5), so the accuracy numbers that justified the design stay measurable later.

**Build:**
- `whatsapp-webhook` with **HMAC signature verification** and sender allowlist
- `parseInboundMessage` — text/image/document/button/list (+ explicit unsupported-type reply)
- `parseCommand` + `core/money.ts`
- `adapters/whatsapp/media.ts` — media-id → bytes (the reusable half of `voice-handler`)
- `ingestDocument` pipeline (fingerprint → dedupe → ladder → validate → path → bytes → sidecar)
- Extraction ladder: **cache → fiscal QR → PDF text → DI** (per spike outcomes), **LLM vision** as the fallback rung
- `core/nlu/*` — deterministic slots, synonym table, model slot-fill, merge, confirm policy
- `_cache/*` content-hash caching, provenance (`method`/`confidence`/`model`) on every fact
- `_queue/review` pointers + `[Unesi iznos]` manual path (layer 5)
- Receipt reply + `[Ispravi] [SMOQUA] [Obriši]`; `[Ispravi]` mini-wizard
- `/status` (DILIGAF only for now)

**Test-first order:**
1. `parseInboundMessage` per type, from F7 fixtures — *including a type E doesn't support*
2. `parseCommand` — `/expense` with and without amount; caption forms
3. `money.ts` — the whole grammar table
4. signature verification — valid / tampered / missing / wrong secret
5. `extract/validate.ts` — every rejection rule, applied identically to regex and model output
6. `extract/ladder.ts` — **stops at the first success; a QR hit means DI and the LLM are never called**
7. `fiscal-qr` — real payload → facts; malformed → nothing, no crash
8. `fiscal-receipt-regex` — real OCR text → exact facts; Cyrillic and Latin; missing PDV line
9. `nlu/synonyms` — `EVRA`→EUR, `MATERIJAAL`→MATERIALS; no-match asks rather than guessing
10. `nlu/interpret` — **deterministic slots beat model slots**; conflicting model slots → ask
11. `nlu/confirm-policy` — commit vs tap, incl. the amount threshold
12. cache — identical input twice ⇒ one model call
13. `fingerprint` + `putIfAbsent` dedupe — same bytes twice
14. use case: photo + `/expense` → bytes + sidecar + index marker + reply
15. use case: duplicate message id → one document
16. use case: duplicate bytes → `↺`
17. use case: every layer fails → stored, `needs_review`, queued, `[Unesi iznos]` works
18. use case: model returns invalid JSON → treated as no answer, not as a value
19. use case: free text `MATERIJAAL PAMUK 200E Projekat 1` → correct slots, amount from the grammar
20. use case: blob fails → nothing claimed as saved
21. use case: unknown sender → 200, silence

**Smoke:** send a fiscal receipt from the register. Check reply latency, blob path, extracted amount, and **which layer read it**. Send the same photo twice (expect zero model calls the second time). Send a photo with no caption. Send a garbage photo. Send a receipt with the QR covered. Type `300 EVRA za gorivo` and check the interpretation.

**Done when:** you have used it on a real receipt in the wild and the reply arrived before you put your phone away. **Then stop and judge the bet** — this is the decision point the whole project exists for.

---

## M2 — IMAP ingest

**Build:**
- `adapters/mail/imap.ts` — imapflow: connect, fetch UNSEEN, parse (mailparser), **move to `E/Processed` / `E/Failed`**
- `imap-poll-timer` (10 min)
- `core/mail/route.ts` — the rules table
- `adapters/pdf/text-extract.ts` (pdfjs — text + coordinates)
- Izvod period/number detection (layer 0 regex)
- Server-side mail rule filing into `E/Inbox` (config, not code)

**Test-first order:**
1. `route()` against every `.eml` fixture subject (F5, F9) + diacritic/whitespace variants + no-match
2. MIME parsing — attachments vs inline images; multiple attachments; odd encodings
3. **folder moves**: success → Processed; no route → Failed; an already-moved message isn't refetched
4. izvod period detection from F1; failure → received-month + `needs_review`
5. use case: izvod `.eml` → `diligaf/YYYY/MM/izvod/…` + sidecar
6. use case: `E:EXPENSE` `.eml` → expense path, ladder runs
7. use case: same message polled twice → one document
8. use case: 3 attachments → 3 documents, one move
9. use case: ingest succeeds but the move fails → the `_index/event/mail` marker prevents a reprocess

**Smoke:** forward a real izvod, watch it land in `E/Processed`. Forward a supplier invoice with `E:EXPENSE`. Forward the same one twice. Send an email matching nothing and confirm it lands in `E/Failed` rather than crashing the poller.

---

## M3 — Invoice issuing (PDF only)

Scope narrowed by D10, D12, D13: **PDF only, you own the numbering, VAT derived from the customer.** No XML builder and no counter — two of the riskiest pieces are simply absent.

**Build:**
- `_state/customers/{id}.json` (incl. `country`, `is_business`, `last_*`) + used-number markers
- `core/invoicing/invoice-model.ts` — VAT modes, totals, rounding
- `core/invoicing/vat-mode.ts` — `resolveVatMode(customer)`
- `core/invoicing/invoice-number.ts` — `suggestNextNumber(last)`
- `core/invoicing/invoice-template.ts` → `PdfInvoiceData`
- `adapters/pdf/invoice-pdf.ts` (pdfkit, from 1IA) — PDV lines domestic, exemption note international, **text invoice number** (1IA's zero-padded integer assumption removed)
- `/invoice` wizard on `_state/conv`: customer → suggested number → prefilled description/amount → confirm
- Duplicate-number warning
- PDF → WhatsApp + blob `invoice_out/` + sidecar

**Test-first order:**
1. `resolveVatMode` — RS → 20%; foreign business → exempt; foreign individual → 20%; missing country → refuse
2. `suggestNextNumber` — padding preserved; last digit-run incremented; non-numeric tail → null; first-ever → null
3. `computeTotals` — all VAT modes, per-invoice half-up rounding, multi-line
4. `invoice-template` — snapshots for domestic-RSD and export-EUR; **export renders no VAT line, not `PDV 0,00`**
5. currency × VAT — all four combinations stay independent
6. PDF adapter — valid PDF, expected strings per mode, deterministic size for a fixed fixture
7. use case: wizard happy path (domestic) → PDF sent, blob + sidecar written
8. use case: wizard happy path (international) → no VAT, exemption note, NBS rate line
9. use case: defaults pulled from that customer's previous invoice
10. use case: duplicate number → warns, proceeds on confirm
11. use case: cancel mid-wizard → nothing written, no number consumed

**Smoke:** issue August's real invoices — **one domestic and one international** — and compare field-by-field against the ones you produced by hand, especially the VAT presentation and the exemption note. Then submit to SEF the way you do today.

---

## M4 — Monthly accountant package

**Build:**
- `core/packaging/manifest.ts` + `email-body.ts`
- `adapters/zip/archive.ts` (fflate)
- `send-monthly-package` use case, `previousMonth` from injected clock, docs by **prefix listing**
- `monthly-package-timer` (1st, 06:00 UTC)
- Template `e_monthly_package` + `[Pošalji] [Prikaži listu] [Odloži]`
- `adapters/mail/smtp.ts` (nodemailer); recipient from `_state/books.json` only
- ≤8 MB attach / >8 MB SAS link
- `/report [YYYY-MM]` for re-runs, marked `(revidirano)`

**Test-first order:**
1. `previousMonth` — 1 Jan, leap year, DST days
2. `manifest` — grouping, per-category totals, `⚠` for missing amounts, `extraction_method` column, CSV escaping
3. `email-body` — snapshot; **asserts PERSONAL documents never appear**
4. zip — structure, entry names, round-trip
5. size routing — 7.9 MB attaches, 8.1 MB links
6. use case: full period → correct zip contents + counts
7. use case: confirm → email sent once; second confirm → no second send (`_state/notified` marker)
8. use case: timer double-fire → one notification
9. use case: empty month → clear "nothing to send", no empty zip mailed
10. use case: recipient injection attempt in the input → ignored, config wins

**Smoke:** run `/report 2026-07` against real July data. Read the email yourself before it goes anywhere. **Send the first month's package to yourself, not the accountant.**

---

## M4.5 — `/tebra`, read-only

Pulled forward deliberately: cheap once the store exists, no write-risk to design around, and the fastest way to learn whether you actually reach for this command. If you don't use the read-only version, M8 isn't worth building.

**Build:**
- `core/tebra/tools/*` — `search_documents`, `get_document`, `query_transactions`, `aggregate`, `list_periods`, `get_rules`, `get_status`, `compare_periods`
- `core/tebra/render/*` — table, CSV, XLSX, chart
- `app/run-tebra.ts` — the bounded agentic loop (step cap, row cap, token cap)
- Book scoping injected server-side, outside the model's reach
- Untrusted-content wrapping for any document/email text entering context
- `_state/tebra/{session}.json` audit records
- **No write tools exist yet** — not disabled, absent

**Test-first order:**
1. each read tool over an in-memory store — filters, grouping, empty results, **explicit truncation reporting**
2. `aggregate` — sums, groupings, multi-currency, period boundaries
3. loop with a **scripted fake model** — bounded steps; results threaded correctly; a step-cap hit answers gracefully
4. **arithmetic provenance** — every number in the reply equals `aggregate` output exactly
5. **book scoping** — a SMOQUA-phone session cannot reach PERSONAL data, even if the model asks
6. **injection** — fixture document text containing `ignore previous instructions…` produces no tool call and no leak
7. render — CSV/XLSX round-trip; chart produced; document sent to WhatsApp
8. audit — every session recorded with prompt + tool calls

**Smoke:** ask it the five questions you'd actually ask about July, and check every number by hand against the package you already sent your accountant.

---

## M5 — SEF digest and inline action

Mostly harvesting. File the WhatsApp templates at the **start** of this milestone — approval latency is the long pole.

**Build:**
- `adapters/sef/client.ts` (verbatim from 1IA — **purchase** functions only) + the contract tests it never had
- `_state/sef/inbound/{sef_id}.json`
- `sef-poll-timer` (30 min) — write new by `sef_id` with `putIfAbsent`
- `sef-digest-timer` (daily 07:00 UTC) — only if pending > 0, once/day
- `adapters/whatsapp/template.ts` + template `e_sef_pending`, `[Pregledaj]`
- Card/list/detail/accept/reject/PDF handlers (from 1IA's button-router)
- **On accept: archive the SEF PDF into `sef_inbound`** — the loop-closer
- Spike: does SEF `publicApi` offer a push subscription? If yes, swap the poller behind the same interface and delete a timer

**Test-first order:**
1. contract tests for every SEF endpoint incl. errors and the PDF "generation triggered" text response
2. poll — new invoices written, existing untouched, `sef_id` dedupe via `putIfAbsent`
3. digest — 0 pending → silence; 3 pending → one message; twice in a day → one message
4. template payload — parameter count matches the registered definition
5. **free-form send outside the window → `131047` surfaced and logged, not swallowed**
6. accept → SEF called, state updated, **PDF archived with the right period**
7. reject → reason passed as comment, no PDF archived
8. SEF down during poll → no crash, no phantom state, logged

**Smoke:** wait for a real inbound eFaktura. Accept it from WhatsApp. Confirm the SEF portal agrees and the PDF is in the month's blob prefix.

---

## M6 — Personal statement parsing

Largest and least predictable — it depends entirely on your statement's real layout. **Do not start without F2.**

**Build:**
- `statements/parse-personal.ts` — coordinate-band parser (deterministic; **no model fallback here — the reconciliation guard gives ground truth, so failing loudly is strictly better**)
- `statements/reconcile.ts` — opening + credits − debits ≈ closing
- `normalize.ts` + dedupe key; tx event blobs
- `ledger/fold.ts` — events → transactions (the reporting core)
- `ledger/categorize.ts` — the §5.1 signal ladder (stated → items → rule → model → MISC)
- `ledger/ambiguous-vendor.ts` + `ledger/split.ts`
- `_state/rules/personal.json` + **seed file from your top merchants**
- `/cash`, `/misc` review with retroactive rule application
- Personal monthly report
- `PERSONAL_TX_SOURCE` flag + the `tx_email` seam (interface + tests, impl when you switch banks)

**Test-first order:**
1. text + coordinate extraction from F2
2. `parse-personal` → exact expected transactions for one real month (**the anchor test**)
3. reconciliation guard — a balancing statement passes; a deliberately corrupted one fails loudly
4. multi-page statement; **a page the parser can't resolve fails with the page number** (no fallback, by design)
5. `fold` — events → transactions; a `set_category` correction wins; out-of-order events fold identically
6. dedupe — re-sent statement → 0 new entries; two identical same-day charges → 2 entries
7. `categorize` — signal-ladder precedence; stated beats items beats rule beats model
7b. `ambiguous-vendor` — one category in history → auto-apply; two → stop and ask
7c. `split` — mixed basket into two categories; splits sum to the total exactly
8. rule derivation — volatile tokens (dates, terminal ids, refs) stripped
9. retroactive application — one review reclassifies N historical entries
10. `/cash` — amount, category guess, correction
11. use case: statement `.eml` → PDF stored + N tx events + summary message
12. use case: parse fails entirely → PDF still stored, `needs_review`, honest message naming the page

**Smoke:** feed three real months. Check every total against the bank's own figures. Run `/misc` until the queue is empty and confirm the rules stuck.

---

## M7 — SMOQUA

Small, because M1 did the work.

**Build:**
- `SMOQUA` entry in `_state/books.json` + second sender phone
- **typed dimension axes** (`closed_set` + `open_text`) + alias/fuzzy resolution
- Shorthand parsing (`MATERIALS 300e`, order-tolerant)
- Required-dimension enforcement with button fallback
- `[Dodaj račun]` attach-to-previous state (10 min TTL)
- Multi-currency rollup via `nbs-rates`
- SMOQUA `/status` with per-currency breakdown

**Test-first order:**
1. axis resolution: aliases incl. Serbian forms; `MATERIJAAL` fuzzy-matches; unknown → no default
2. slot parsing, any order, with and without description; `MATERIJAAL PAMUK 200E Projekat 1` end to end
2b. `open_text` axis — new project value accepted, remembered, offered as a button next time
3. required dimension — document with no caption → stored, question asked, not auto-`OTHER`
4. currency — EUR stored with `amount_rsd` at the doc date; rate failure → null + `needs_review`
5. attach-to-previous — within TTL attaches; after TTL creates new
6. rollup — mixed-currency dimension totals
7. use case: SMOQUA phone routes to SMOQUA; DILIGAF commands refused

**Smoke:** book three real shop expenses from the second phone, one with a PDF, one cash-with-dimension, one photo-then-dimension.

---

## M8 — `/tebra` edits

**Build:**
- write tools as **proposals only**: `set_category`, `set_dimension`, `set_amount`, `set_vendor`, `set_date`, `split_transaction`, `add_rule`, `add_synonym`, `flag_for_review`
- change-set rendering with affected count + sample + `[Primeni] [Primeni + zapamti] [Otkaži]`
- `/tebra undo` — appends the inverse event
- `/tebra istorija` — recent sessions
- session id carried into every ledger event it creates

**Test-first order:**
1. **no write tool ever executes inside the loop** — the single most important test in this milestone
2. change-set construction — correct refs, correct count, sample truthful
3. confirm → correction events appended; the original value still readable
4. `undo` → inverse event; folding returns the prior state exactly
5. bulk change → count and sample shown before the tap; truncation never silent
6. injection + write path → proposal is produced but **flagged as injection-adjacent**, never auto-applied
7. `add_rule` → retroactive application matches the `/misc` path exactly

---

## M9 — MCP server

Same tools, second transport. Reads first; writes only if you want them from a laptop too.

**Build:**
- MCP server exposing `core/tebra/tools/*` with their existing schemas
- auth (local credential vs hosted token — see `09-TEBRA.md` §9 Q3)
- book scoping enforced by the credential, not by the caller

**Test-first order:**
1. tool schemas exposed match the in-process definitions **exactly** (one contract, two transports — a drift test)
2. auth — missing/invalid credential returns nothing
3. scoping — a credential for one book cannot read another
4. no write tools exposed unless explicitly enabled

---

## After M7 — candidates, unranked

- **SEF sales-invoice submission** — the deferred half of D10, once you want to issue from the app; needs the UBL XML with correct PDV lines
- **Per-transaction bank emails** — same-day personal tracking (`04-PERSONAL.md` §5)
- **SMOQUA accountant package** — one `books.json` edit + reuse of M4
- **Weekly nudge** — "3 things need review" on Sunday evening
- **Search** — "koliko sam dao na gorivo u julu"; a fold + filter, no new storage needed
- **Prune the expensive rungs** — if vendor profiles and the cache push LLM usage near zero, tighten thresholds or drop a rung. `extraction.method` in the manifest is the evidence, and `/status` is the dashboard.
- **Grow the eval corpus into a regression suite** — every correction you make is already a labelled example (`06-TDD-STRATEGY.md` §4.5)
- **`/tebra` scheduled digests** — "every Friday tell me what changed", using the same tools
- **1IA proper** — with E's answers instead of E's guesses

---

## Working agreement

- **Docs before code.** These files are the spec; changes land here first.
- **No code until you approve it**, per milestone, not per project.
- **Tests before implementation**, always (`06-TDD-STRATEGY.md`).
- **Stop after M1 and judge the bet.** That's the point of building it first.
- One milestone in flight at a time. E exists to reduce your open loops, not add one.
