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
- vitest + coverage thresholds + eslint (incl. the `engine/` → `adapters/` import ban)
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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17. M0's "Done when" below has never
actually been met**, and these are the reasons.

- **U2 — the CI gate was theatre, and flipping `continue-on-error` alone would not have fixed it.**
  The step piped through `tee`, and GitHub Actions' default shell is `bash -e {0}` with **no
  `pipefail`**, so the step's exit code was `tee`'s and `steps.unit.outcome` was hard-wired to
  `success`. **Fixed 2026-08-16** by adding `shell: bash` to both piped steps. Keep the comment
  explaining why, or someone will remove it as noise.
- **U3 — the coverage gate is dead twice over.** Thresholds have been declared since M0 and have
  **never once evaluated anything**: vitest's `reportOnFailure` defaults to *false*, so while any test
  is red no report is produced and no threshold is checked. Sequencing matters —
  (1) land the unfreeze so the suite is green, (2) set `reportOnFailure: true`, (3) close the branch
  gap, (4) *then* flip both `continue-on-error` flags, (5) prove it fails on a deliberately uncovered
  line, which is M0's own acceptance criterion and has never been done.
  Measured 2026-08-17: **branches 89.04%** against a 90% threshold — `packaging` 83.4%, `ledger` 85.8%,
  `mail` 87.1%. **Do not lower the threshold to 89 to make it pass**; that is the one move that makes
  the number permanently meaningless. Note C-002 *adds* branches, so the target moves before you reach
  it — this is the one item in the batch with unbounded size and it should not hold the rest up.
- **U8 — the declared test infrastructure does not exist.** `test/fakes/` is empty and the Azurite
  `putIfAbsent` / `casPut` contract tests have never run. M1 steps 13, 16 and 20 depend on both.
- **Mutation testing is the gap that matters most, because it is about what we don't know.** A sweep of
  `invoicing` alone ran 137 mutants against the frozen suite; **25 were detected by nobody** — a number
  completely invisible from a 193/193 pass count. Two were real and are now closed with new guards in
  `test/unit/money-guards.test.ts`: a **truncating** `toRsd` was bit-identical to a correct one across
  **547 cases including all 354 money cases** (every foreign-currency invoice systematically a cent
  light, forever), and VAT-on-raw-sum was undetectable by a test whose *title* asserts the opposite.
  **Fifteen of sixteen modules have never been mutation-tested**, and ~22 of the 25 known blind spots
  were never enumerated. When this runs, split it across four agents — the first attempt was one long
  job and lost its work to a network error.

**Done when:** `npm test` passes offline with no Postgres anywhere, CI is green, `/api/health` responds in Azure, and the coverage gate demonstrably fails on a deliberately uncovered line.

---

## M1 — Expense capture from WhatsApp ⭐

The milestone that matters. Everything else is bookkeeping.

### Spikes first (both timeboxed, both before any extraction code)

- **S-QR (½ day, needs F10).** Take one real fiscal-receipt QR payload. Determine: does the payload itself carry the totals, or only a verification URL? Does `suf.purs.gov.rs` expose a JSON endpoint, or is it an HTML page to parse? How stable is that surface? **Outcome:** either layer 1 is confirmed as the primary path for fiscal receipts (and E needs no ML for its most common document), or it's dropped and layer 2 becomes primary. Either way we know before writing a line.
- **S-DI (½ day, needs F4).** Run real Serbian fiscal receipts and a couple of foreign supplier invoices through Document Intelligence `prebuilt-receipt` and `prebuilt-invoice`. Measure per-field accuracy against ground truth. **Outcome:** how often the LLM rung has to fire, and whether receipts are better served by OCR + our fiscal regex.

These two spikes decide the *shape* of the ladder — which rungs exist and in what order. Doing them first is cheaper than building rungs and discovering they're dead weight.

**S-QR outcome, and the v1.1 ruling (Danilo, 2026-08-15).** The spike is answered
far enough to build on. The layer 1 *contract* is confirmed and good: the QR carries
only a verification URL, that URL answers a plain `GET` with `Accept: application/json`
and no authentication, and the response includes a populated `items[]` — enough to
categorize deterministically with no model at all. Two caveats: there is **no structured
VAT field** (the tax breakdown lives only inside the `journal` free-text blob, so
`vatAmount` and `amountNet` need parsing even on the happy path), and the QR's real-world
**hit rate is poor** — on a real receipt it could not be read by any phone scanner tried,
because the payload is a signed blob of ~400–600 bytes printed at ~2cm on thermal paper.

**The ruling: do not engineer around a failed QR.** When layer 1 misses, fall straight
back to Document Intelligence and then to the OpenAI parser — the rungs the ladder
already defines. That is judged sufficient for precision, and it is the **v1.1 MVP**
extraction path:

```
QR (layer 1)  →  Document Intelligence (layer 4)  →  OpenAI parser (layer 5)
```

The practical consequence is that no effort goes into QR recovery heroics — image
preprocessing, perspective correction, multi-pass decoding. One decode attempt, then
fall through. `extract/ladder.ts` already short-circuits on the first success, so this
needs no structural change; it is a decision about where NOT to spend effort.

Both spike outputs become the first entries in the eval corpus (`06-TDD-STRATEGY.md` §4.5), so the accuracy numbers that justified the design stay measurable later.

**S-PIB outcome (2026-08-17) — the scrape is the path, and it is enough.** `TEST-FREEZE.md`
names S-PIB as the blocker on the provisional `vendorKey` carve-out, on the grounds that the
response shape was unconfirmed. It is now confirmed, empirically, against live data.

*The paid SOAP API is not the near-term path.* `CompanyAccountService.asmx` authenticates via a
SOAP `AuthenticationHeader` of `UserName` / `Password` / **`LicenceID` (a required GUID)**, and
`GetCompanyAccountByNationalIdentificationNumber` is the right operation. But: **no registration
procedure, contact address, fee schedule or test environment is published anywhere on the
documentation site** — it assumes you already hold a licence. And the WSDL types the response as
`<s:any />`, so **reading the WSDL does not reveal the field shapes**. **Danilo's ruling, 2026-08-17: do not
pursue the licensed API until the PoC is validated.** The scrape is sufficient for now, the
registration lead time and cost are both unknown, and paying to de-risk a system that has not yet
read a receipt in the wild is the wrong order. Revisit after M1's "done when" is met. Note for
whenever that happens: `nationalIdentificationNumber` is typed `long` and more likely keys on
**matični broj** than PIB — confirm before designing around it. The Exchange Rate Service shares the
same auth model, so one registration would unlock both.

*The public registry needs no authentication.* `webappcenter.nbs.rs/PnWebApp/CompanyAccount/CompanyAccountResident`
answers a plain query string — no session cookie, no CSRF token, no JavaScript, no captcha —
and every `<td>` carries a `data-title` attribute, so **select cells by attribute, never by column
index**. Three exact keys resolve to a single company: `CompanyTaxCode` (PIB),
`CompanyNationalCode` (MB), `AccountNumber`. `City` AND-combines and is also a contains match.
A parseable `Укупан број резултата: N` lets you size a result set before fetching rows.

*Verified facts that the parser must be built around:*

| Finding | Evidence |
|---|---|
| `CompanyName` is a **contains** match, not a prefix match | `CLOTH` matched `…ODEĆE STUDIO CLOTH BEOGRAD` mid-string |
| **Diacritics are rejected** as "special characters" — the term must be ASCII-folded | `VRAČAR` returns a validation error, not zero rows |
| Search terms must be a **single word** | multi-word `CompanyName` returns a validation error |
| **Rows are accounts, not companies** — dedupe by matični broj | `UDRUZENJE CLOTH AND CLAY` twice under MB `28231628` |
| One MB returns **wildly different name strings** | MB `17454447` as `BORBA A.D. NOVINSKO…`, `NIP KOMPANIJA BORBA AD`, and `NOVINSKO IZDAVAČKO PREDUZEĆE KOMPANIJA BORBA AD BEOGRAD (STARI GRAD)` |
| The **registered name is not the receipt name** | brand `STUDIO CLOTH` is registered as `NADA STEVANOVIĆ PR PROIZVODNJA OSTALE ODEĆE STUDIO CLOTH BEOGRAD` |
| The registry's **own diacritics are inconsistent** — fold *both* sides of every comparison | `BEOGRAD, VRACAR` and `BEOGRAD-VRAČAR` in one result set |
| **Zero-width characters appear inside `Delatnost`** — strip them when parsing | `knjigo​vodstveni`, `el​ektričnih` |
| Registry text contains **plain typos** — never require exact equality | `INDIPENDET PROFIT SECTOR OF ACCOUNT` |
| Identity values are **Latin**; only localized enums follow page language | name/address/city stable; `Status` renders `Uključen` or `Укључен` |

*This confirms D20 empirically: **MB is identity, names are aliases.*** Store all name variants as
aliases and keep two fields — `legalName` (registry) and `displayName` (what the receipt says),
because for a `PR` the registry name embeds owner, activity and city and is useless as a label.

*Token selection is the whole game, and rarity cannot be guessed — measure it.* The result count
comes back on every query, so probe candidate tokens and keep the smallest:

```
LUKA    → 2,224 rows     unusable
SECTOR  →    36 rows     resolves to LUKA-SECTOR 6 DOO, MB 21359262
SEKTOR  →    57 rows     target absent — never auto-transliterate SECTOR→SEKTOR
```

A 62× spread between two tokens of one company name. Cap the probe: if the smallest count is
still in the hundreds, do not fetch rows — require `City`, or ask.

*The resolution cascade, cheapest first.* Exact keys → `City` → **subtract the `Mesto` and
`Delatnost` columns from the name string** (they arrive in their own columns, so noise tokens are
removed by subtraction rather than guessed) → rank **exact brand match above contains** →
filter on activity → filter on legal form. Worked example: `BORBA` gives 35 rows → 26 with
`City=BEOGRAD` → 14 distinct MB → ~4 after brand-exact → **1** on activity, since
`Računarsko programiranje` appears exactly once in 35 rows.

*Discard `-BOLOVANJE` / `-NAMENSKI` / `-RN BOLOVANJA` rows before dedupe* (Danilo, 2026-08-17) —
sick-leave and earmarked accounts are never payable. Two guards: if filtering empties an MB, keep
its rows for identity and store no account number (losing a bonus field beats losing the vendor);
and do **not** filter `DEVIZNI` (a legitimate FX account, and DILIGAF invoices in USD) or
`U STEČAJU` (company status inside the legal name, not an account designation). The marker list
belongs in JSON, same precedent as `_state/rules/personal.json`.

*Terminal state, and it is not a failure.* **≥10 surviving candidates → do not render a menu; ask
for a PIB or MB** (Danilo, 2026-08-17). The bound is WhatsApp's, not arbitrary: an interactive list
carries **max 10 rows**, so reserving one for `NOT HERE, I'LL SEND A PIB` leaves **9** candidate
slots. The tighter constraint is the row `title` limit of **24 characters** — no registry name fits,
so the menu must render the brand residue from the subtraction step, which is what makes that step
do double duty. Below three candidates skip the list entirely and use reply buttons (max 3).
The escape row stays present at **every** tier, including a single candidate.

*Never auto-select on a score.* A wrong pick writes a valid-but-wrong PIB into a vendor profile,
which the C-002 checksum cannot catch and every later document inherits silently. This is
`ambiguous-vendor.ts`'s job. The cost of ambiguity is one tap, once, per vendor, forever.

*Scope cut worth stating:* the hard name-only case largely does not need solving. Serbian receipts
and invoices are required to print the PIB, so the exact-key path covers documents. Name search
mostly arises from **bank statement descriptors**, and those need categorization rules
(`ledger/rules.ts`), not legal identity.

*Save as fixtures:* the `BORBA` (35 rows) and `SECTOR` (36 rows) responses verbatim. Between them
they exercise dedupe, name variance, token-rarity selection, hyphen tokenization, two-sided
folding, the zero-width characters and the activity discriminator — the mapper tests entirely
offline, and the fifteen-line adapter is the only fragile part.

**Build:**
- `whatsapp-webhook` with **HMAC signature verification** and sender allowlist
- `parseInboundMessage` — text/image/document/button/list (+ explicit unsupported-type reply)
- `parseCommand` + `engine/money.ts`
- `adapters/whatsapp/media.ts` — media-id → bytes (the reusable half of `voice-handler`)
- `ingestDocument` pipeline (fingerprint → dedupe → ladder → validate → path → bytes → sidecar)
- Extraction ladder: **cache → fiscal QR → PDF text → DI** (per spike outcomes), **LLM vision** as the fallback rung
- `engine/nlu/*` — deterministic slots, synonym table, model slot-fill, merge, confirm policy
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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.** These were found during the engine
build but cannot fire until this milestone's code exists, so they are acceptance criteria here
rather than register entries. Each needs an unfreeze only where noted.

- **CANDIDATE-004 — a deterministic refusal is indistinguishable from an absence.** The ladder
  reports "no answer" identically whether a rung declined to guess or simply had nothing. The
  ambiguity needs its own channel so `[Ispravi]` can say *why*. Unfreeze required.
- **CANDIDATE-008 — the vendor-profile learning loop cannot learn.** `learnFromExtraction` has no
  path that writes what a successful extraction taught. Layer 2 is inert until it does.
- **CANDIDATE-007 — export the declared-value validator.** `isDeclaredValue` is needed by the
  categorize path and is currently unreachable.
- **CANDIDATE-003 — VAT plausibility, reclassified.** The original proposal (flag an implausible
  *effective rate* on the invoice total) was measured and **does not work**: Serbia has 20% standard
  and 10% reduced with food reduced, so any mixed basket blends to a rate that is neither, and an
  exact-rate check flags most supermarket receipts on day one. The version that works is a
  **line-level** check (Danilo, 2026-08-17): allowed set `{0, 10, 20}` — 0% because exempt lines are
  legal — gated on **`vendorPib !== null`** so foreign suppliers at 19%/22% exempt themselves, and
  tested by **candidate rate** (`vat === round2(net × r)` for some `r`) rather than by computing an
  implied percentage, which is pure noise at small line amounts. The label→rate table comes from F4.
  *The guard this replaces is real:* `vat <= total` catches overshoot and leaves understatement
  entirely unguarded, and understating input VAT costs money while triggering no audit letter.
- **Seller-vs-buyer PIB.** The F4 receipt carries *two* PIBs (NIS as seller, DILIGAF as buyer).
  Extraction must not capture the buyer's as the vendor's.
- **M0's declared test infrastructure does not exist** (U8). `test/fakes/` is empty and the Azurite
  `putIfAbsent` / `casPut` contract tests have never run — yet steps 13, 16 and 20 above depend on
  them. Build the fakes before the use-case tests, not alongside.
- **F7 is now available** (2026-08-17) — real `image` and `document` webhook bodies are in hand, so
  step 1 is unblocked. `image` carries no `filename`; `document` does, and it is attacker-controlled
  text that reaches a blob path (`blob-path.ts`'s shape guard already covers it).
- **Media URLs expire in ~5 minutes.** Measured from the F7 bodies: `ext` minus `timestamp` is 301s
  and 302s. Ruling (Danilo, 2026-08-17): take the cheap path and use the webhook `url`; the Graph
  `id` fallback is **v1.1**. One guard now, because it is nearly free — **on a download failure,
  queue the message into `_queue/review/` with the `wamid` preserved** so a lost photo is visible
  and re-sendable instead of vanishing. The risk is not average latency, it is the retry path.

**Done when:** you have used it on a real receipt in the wild and the reply arrived before you put your phone away. **Then stop and judge the bet** — this is the decision point the whole project exists for.

---

## M2 — IMAP ingest

**Build:**
- `adapters/mail/imap.ts` — imapflow: connect, fetch UNSEEN, parse (mailparser), **move to `E/Processed` / `E/Failed`**
- `imap-poll-timer` (10 min)
- `engine/mail/route.ts` — the rules table
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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.**

- **CANDIDATE-015 — rewrite `senderAddress()`.** The shipped fix closes the four attack shapes its
  author thought of; an adversarial re-attack found **six more RFC-legal bypasses**. The parser takes
  the *last* `<…>` group, which is the defect. This is the entry that produced the standing rule:
  *a fix may be marked APPLIED only when verified against a case list its author did not write.*
  Urgency is genuinely low — `adapters/` does not exist, `parse-eml.ts` is a stub, so the mail path
  is not live. It becomes live in this milestone, which is why it lands here.
- **Rule-validation failures are silent.** A malformed routing rule is skipped with no report, so a
  typo in `_state` looks like "no mail matched" forever. Surface it.
- **`Object.hasOwn` in `toUsableRule`.** Caller-supplied keys reach an object literal; the house
  convention (`Object.hasOwn` / `Map` / `UNSAFE_KEYS`) is already applied elsewhere in the engine.
- **`fromPattern` is required** (Danilo, 2026-08-16) — routing on subject alone is not enough.
- **Q17 is closed** (Danilo, 2026-08-17). Mailbox `danilo@diligaf.rs`, host `mailcluster.loopia.se`.
  One protocol detail worth pinning, because inverting it is the classic bug: **IMAP 993 is implicit
  TLS** (imapflow `secure: true`); **SMTP 587 is STARTTLS** (nodemailer `secure: false` +
  `requireTLS: true`). Setting `secure: true` on 587 fails to connect. Passwords are `IMAP_PASS` /
  `SMTP_PASS` — Key Vault references plus matching `.env.example` lines; the operator sets values.

**Smoke:** forward a real izvod, watch it land in `E/Processed`. Forward a supplier invoice with `E:EXPENSE`. Forward the same one twice. Send an email matching nothing and confirm it lands in `E/Failed` rather than crashing the poller.

---

## M3 — Invoice issuing (PDF only)

Scope narrowed by D10, D12, D13: **PDF only, you own the numbering, VAT derived from the customer.** No XML builder and no counter — two of the riskiest pieces are simply absent.

**Build:**
- `_state/customers/{id}.json` (incl. `country`, `is_business`, `last_*`) + used-number markers
- `engine/invoicing/invoice-model.ts` — VAT modes, totals, rounding
- `engine/invoicing/vat-mode.ts` — `resolveVatMode(customer)`
- `engine/invoicing/invoice-number.ts` — `suggestNextNumber(last)`
- `engine/invoicing/invoice-template.ts` → `PdfInvoiceData`
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
- `engine/packaging/manifest.ts` + `email-body.ts`
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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.**

- **The dead-man's switch** (U5). There is no monitoring anywhere in the design, and this is the
  milestone where that stops being theoretical: **the monthly package fails as silence.** Nothing
  distinguishes "no package was due" from "the timer never fired", and the three plausible causes —
  an IMAP credential expiry, the pathological `_state` regex of CANDIDATE-010, and a Functions
  timeout — all present identically as nothing arriving. A package that did not arrive must be
  louder than one that did.
- **Cross-check the zip against the manifest** before sending. The manifest is built from sidecars
  and the zip from blobs; nothing today asserts they describe the same set of documents.
- **The runbook sentence.** One line saying what to do when a package does not arrive, so the
  answer is not reconstructed under pressure.
- **Q18 — the exemption note, and the only already-incurred exposure in the review.** Invoice
  `2026007` (DILIGAF → Vetatek LLC, 10,000 USD) rendered `VAT 0 USD` with no exemption note, which
  `03-DILIGAF.md:181` explicitly forbids — a zero-rate VAT line and an exempt supply are different
  documents to an inspector. Danilo's answer (2026-08-17): **"VAT not charged – reverse charge"**.
  Flagged for the accountant rather than settled: reverse charge is an EU-VAT mechanism and Vetatek
  is **US**, so the Serbian framing may be place-of-supply-outside-Serbia with an article citation
  instead. The note text is an *input* — no string is hardcoded and the frozen tests forbid one — so
  this blocks no code; only the wording is outstanding.

**Smoke:** run `/report 2026-07` against real July data. Read the email yourself before it goes anywhere. **Send the first month's package to yourself, not the accountant.**

---

## M4.5 — `/tebra`, read-only

Pulled forward deliberately: cheap once the store exists, no write-risk to design around, and the fastest way to learn whether you actually reach for this command. If you don't use the read-only version, M8 isn't worth building.

**Build:**
- `engine/tebra/tools/*` — `search_documents`, `get_document`, `query_transactions`, `aggregate`, `list_periods`, `get_rules`, `get_status`, `compare_periods`
- `engine/tebra/render/*` — table, CSV, XLSX, chart
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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.**

- **A currency-grouped `total` pools currencies, and no frozen assertion can stop it.** The
  per-bucket currency check is correct; the grand `total` is never currency-checked on *any* axis, so
  `groupBy: ['category']` and `['vendor']` sum RSD and EUR together. **This was attempted and
  reverted:** a result-level refusal in `aggregate.ts` turns red a frozen assertion that
  `groupBy: ['currency']` over mixed currencies must *succeed* — and that assertion is correct, since
  it is what makes the per-bucket design work. `AggregateResult` is pinned to four fields so a caveat
  field needs an unfreeze too. **The freeze-compatible route is render-layer suppression here:** do
  not print a grand total that spans currencies. (If the LCY work lands first this problem
  disappears — every row gains a comparable amount — so check before building the suppression.)
- **`maxRowsPerCall` is declared but enforced nowhere.** A single question can pull an unbounded row
  count into a model context.
- **A rule's category is never checked against the vocabulary.** A rule can write a
  `Transaction.category` value that no vocabulary contains — bypassing the check a *model-authored*
  proposal cannot bypass. Same anatomy as CANDIDATE-007.
- **Rules are not filtered by book, and cannot be.** A PERSONAL rule can categorize a DILIGAF
  transaction. This needs the rule shape to carry a book, so it is a data-model change, not a filter.

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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.**

- **CANDIDATE-011 — the ambiguity meta-rule hands the decision to the guesser.** When a vendor
  resolves more than one way, the resolution is delegated to the same component whose uncertainty
  created the ambiguity. Unfreeze required.
- **CANDIDATE-012 — a mixed basket is filed whole and no split is ever offered.** A single receipt
  covering two categories is booked to one. `split.ts` exists; nothing offers it. Pinned at `:391-401`
  with the model's win mandated — CANDIDATE-004's anatomy again. Unfreeze required.
- **CANDIDATE-009 — re-adding an already-split transaction doubles the money.** `add(s1,-100)` →
  `split(s1 → -60/-40)` → `add(s1,-100)` folds to **three rows totalling -200** for a -100 charge.
  `split` removes the parent and inserts the parts; a later `add` for the same id resurrects the
  parent alongside them. Both behaviours are individually pinned and correct; nothing in the frozen
  suite composes them. Reachability is low by accident of design — `invert(split)` returns `null` so
  undo cannot produce it, and split parts inherit the parent's `dedupeKey` so a re-imported statement
  line never emits a second `add` — but a manual re-ingest or repair script doubles the charge with
  no error and no review flag.
  **Fix: option (a) — an `add` on an id that currently exists only as split parts removes the parts
  first.** Additive, no unfreeze, and it matches "add is an upsert". Rejected alternative: declaring
  the invariant ingest-side only, which leaves `fold` corruptible by a bad writer — inconsistent with
  the module's own header promise that *"one bad blob may not take out the month"*, now backed by 49
  survivability tests in `fold-guards.test.ts`.
- **A malformed statement announces `razlika 0,00`.** The failure message prints a difference of zero
  when parsing failed outright, which reads as "reconciled" — the most misleading possible output on
  the path whose whole job is to refuse to balance.
- **Do not "clean up" `MAX_TOLERANCE`** — it was deleted with CANDIDATE-013 on 2026-08-17. If a
  tolerance ceiling reappears in `reconcile.ts`, it is a regression, not a fix.

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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.**

- **Q10 is CLOSED (Danilo, 2026-08-17).** The category axis is
  **`MARKETING`, `SHIPPING`, `MISC`, `MATERIALS`, `SEWING`** — recorded in `05-SMOQUA.md` §2, which
  is canonical. `OTHER` is gone and `MISC` is the catch-all, which **moots hazard H1**. The old
  placeholder alias `MAT` was deleted: it is H3's worked example. Still open there, both data not
  code: `MISC` at exactly four characters has the tightest fuzzy budget (Serbian `miš` → `MIS` is one
  insertion away), and `SHIPPING` / `SEWING` / `MISC` have no Serbian aliases yet.
- **Aliases must be at least four characters** (Danilo, 2026-08-17). This is a *data*
  constraint, not a code one: with a three-letter alias like `MAT` for `MATERIALS`, the strings `MAJ`,
  `MART`, `RAT`, `ROB`, `RIBA` and `SOBA` all resolve to it at edit distance 1. The length-relative
  fuzzy budget kills the worse cases (`VODA`, `RATA`, `MAPA`) but **cannot** kill these — nothing short
  of exact-only matching below four characters can. Danilo's note: months never appear as dimensions,
  so the calendar collisions are not a live risk.
- **Adding a dimension is a `_state` edit, not an inbound message.** Using an unknown dimension must
  ask, never invent — same precedent as `04-PERSONAL.md:164`, where adding a category is a JSON edit
  rather than a deploy. Sequencing note (Danilo, 2026-08-17): **Tebra is read-only until M8**, so until
  then the vocabulary is edited by hand and `/tebra` cannot be the path that adds one.
- **CANDIDATE-006 — `confirmAboveAmount` is currency-blind, in both directions.** Measured: `400 EUR`
  ≈ 46,800 RSD commits under a 500 RSD threshold — a ~117× hole in the only gate on the WhatsApp path.
  **Superseded by the LCY work**, which solves it generally rather than per-currency; see the LCY
  scoping document. Unfreeze of `nlu.test.ts:905-922` required either way, and it must be
  **pre-authorized** before an isolated engineer starts, since they cannot self-authorize it.
- **`interpret` cannot validate a model axis against the book.** A model may propose a dimension axis
  that the book does not define, and nothing checks.

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

**Hardening — moved here from `UNFREEZE-LOG.md`, 2026-08-17.** This milestone builds the `_state`
write boundary, which is where the remaining half of CANDIDATE-010 belongs.

- **CANDIDATE-010, provenance half.** A stored regex rule can stall the engine for a minute per
  transaction: a **9-byte** pattern against a **25-character** input — an ordinary Serbian card
  descriptor — measured at **64,261 ms**. The shipped guard (pattern-length cap + nested-quantifier
  rejection) takes that to **1 ms**, but it is a stopgap and known partial: alternation overlap is
  exponential for the same reason nesting is, and has no quantifier *inside* the group, so
  `(A|A)*C` (4,268 ms) and `(?:A|A)*C` (3,106 ms) are **not caught**. Adding a second detector is the
  wrong instinct — each covers one syntactic family, there are more families than anyone enumerates,
  and treating static detection as *the* defence repeats the CANDIDATE-015 error.
  - **The actual control: refuse `matchType: 'regex'` on model-proposed rules.** Free today, since
    the learning loop only ever emits `contains`.
  - **It cannot be a field on the rule.** A `source: 'authored'` flag is set by whoever writes the
    rule — precisely the actor being defended against. **Provenance is a property of the path the
    data took, not of the data.** Practical form: separate `_state/rules/authored.json` from
    `_state/rules/learned.json` and have the loader refuse regex from the second. Location as
    provenance, unforgeable.
  - **Do not cap the input length.** The register originally recommended it; measurement showed the
    attacker authors the pattern and therefore controls the exponent, not the input. That advice was
    deleted.
- **Do not replace `node:crypto` in `mail/route.ts` with a hand-rolled hash.** A 32-bit collision
  makes E treat unprocessed mail as already done and silently drop it. Keep the builtin, document the
  Node requirement, and keep the eslint `node:*` ban so the *next* such import is a review-time
  question.

---

## M9 — MCP server

Same tools, second transport. Reads first; writes only if you want them from a laptop too.

**Build:**
- MCP server exposing `engine/tebra/tools/*` with their existing schemas
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
- **Setup guide — "here are your currencies and synonyms"** — surface the deterministic tables E already carries (currency synonyms, dimension aliases, category rules, per-book command permissions) as something you can read and correct at setup, rather than discovering them by being misunderstood. Cheap: the tables exist and are pure, so this is a render plus an edit path into `_state`, not new logic. Two prerequisites, both already known: built-in synonyms win over learned ones (settled 2026-08-15, so the guide shows an authoritative list rather than a merged guess), and `money.ts` and `nlu/synonyms.ts` deliberately hold **separate** currency tables — the guide must either show one or reconcile them, which is the drift guard described below turning from nice-to-have into a dependency.
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
