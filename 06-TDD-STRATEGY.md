# E — TDD Strategy

> **The rule:** no line of production code is written before a failing test that requires it. This document is the contract that makes that rule practical instead of aspirational.

---

## 1. Why this is non-negotiable here (not just discipline theater)

E handles money, files things for a tax authority, and emails an accountant. The failure modes are quiet: a statement parser that drops every third line, a receipt whose amount is off by a factor of 100, a package that silently omits a category. None of those throw an exception. None of them are visible in a smoke test. All of them are trivially catchable by a test with a real fixture.

Second reason: E runs unattended. Timers fire at 06:00 on the 1st of the month. You will not be watching. The test suite is the only thing standing between a bug and a wrong number in your accountant's hands.

---

## 2. The discipline

Per unit of work, in this order, no exceptions:

```
1. RED      write the smallest failing test that expresses the next behavior
            run it, SEE it fail, and check it fails for the RIGHT reason
2. GREEN    the least code that passes. ugly is fine here.
3. REFACTOR clean up under a green suite. no new behavior.
4. COMMIT   test + implementation together, message says the behavior
```

Rules that keep it honest:

- **A test that has never been seen failing is not a test.** If you write the implementation first "because it was obvious," delete it and start over. Yes, really — it's five minutes.
- **Bugs start with a failing test that reproduces them.** Always. The test is the bug report.
- **No test is modified to match a wrong implementation.** Either the test's expectation was wrong (fix it deliberately, in its own commit, with a note on why) or the code is wrong.
- **`skip`/`only` never reach `main`.** Lint rule enforces it.
- **Commits are test-first-visible.** A commit that adds production code with no test change should be rare enough to be worth explaining.

Where TDD is *not* dogma: the pdfkit drawing code and the raw Azure/Meta wire adapters. There, "test-first" means writing the characterization test against a recorded fixture first, then the adapter — the test still comes first, it just asserts shape and behavior rather than logic. Pretending to unit-test a PDF's visual layout would be theater.

---

## 3. The architectural precondition

TDD is impossible against the current 1IA structure. `db.ts` creates a Supabase client at module load from `process.env`; `whatsapp-sender.ts` reads the token at import time; business logic calls `fetch` and `Date.now()` inline. Importing any of it in a test starts by needing a live environment.

Dropping the database (D2) helps here more than it might appear: the store is now a handful of blob operations behind one narrow `BlobStore` interface, and aggregation is a **pure fold over in-memory arrays** rather than SQL. Reporting logic — historically the least-tested part of any accounting tool — becomes ordinary unit tests.

E fixes this by construction (`01-ARCHITECTURE.md` §3):

| Rule | Consequence |
|---|---|
| `engine/` imports nothing from `adapters/` | every business rule is a pure-function test with no setup |
| `engine/` never calls `fetch`, `Date.now()`, `crypto.randomUUID()`, or reads `process.env` | determinism; time and randomness are injected |
| `app/` use cases take their dependencies as arguments | fakes swap in with no mocking framework |
| `functions/` contain no logic | the untestable layer is 10 lines per file and has nothing to get wrong |
| config is read once at startup and passed down | no hidden global state between tests |

```ts
// the shape every use case takes
export async function ingestDocument(deps: IngestDeps, input: IngestInput): Promise<IngestResult>

interface IngestDeps {
  blob: BlobStore          // put, get, list, putIfAbsent, casPut
  extract: ExtractorSet    // { pdfText, qr, docIntel, llm } — each independently stubbable
  cache: CacheStore        // content-hash cache; a hit means no model call at all
  clock: Clock
  ids: IdGen
  log: Logger
}
```

Production wires the real ones. Tests pass `InMemoryBlobStore`, `FakeClock`, `SeqIdGen`, and per-layer extractor stubs. No `vi.mock`, no module interception, no import-order voodoo — those are the things that make test suites rot.

`ExtractorSet` being one stubbable object per ladder layer is what lets a single test assert *"the QR layer answered, so Document Intelligence was never called"* — the determinism guarantee is itself under test, not just a stated intention.

---

## 4. Test layers

### L1 — Unit (`test/unit/`) — the bulk

Mirrors `engine/` 1:1. Pure functions, no I/O, no async unless the function is async. Target: **milliseconds each, thousands of them.**

Coverage: **95% lines / 90% branches on `engine/**`, enforced in CI.** High, and reachable precisely because it's pure code.

What lives here — and these are the tests that catch the bugs that would actually hurt:

| Module | Representative cases |
|---|---|
| `money.ts` | `4.210,00` vs `4210.50` vs `300e` vs `12k`; ambiguous input returns nothing; rounding half-up at 2dp |
| `command-parser.ts` | every command, missing args, extra whitespace, diacritics, uppercase, `300e MATERIALS` reversed order |
| `books.ts` | known phones, unknown phone → null, phone in two books → deterministic precedence |
| `mail/route.ts` | every real subject line from `.eml` fixtures; diacritic and whitespace variants; no-match → no guess |
| `extract/ladder.ts` | **stops at the first successful layer**; a QR hit means DI is never called; layer order is asserted, not assumed |
| `extract/fiscal-qr.ts` | real QR payloads → verification request; malformed payload → no facts, no crash |
| `extract/fiscal-receipt-regex.ts` | real OCR text from Serbian receipts → exact facts; Cyrillic and Latin variants; missing PDV line |
| `extract/validate.ts` | PIB not 9 digits → null; future date → null; VAT > total → VAT dropped — **applied identically to model output and regex output** |
| `nlu/slots.ts` | deterministic slots from free text; `200E` parsed before any model runs |
| `nlu/synonyms.ts` | `EVRA`/`evro`/`€`/`eura` → EUR; `MATERIJAAL` → MATERIALS at edit distance ≤ 2; `MATERIC` → no match, ask |
| `nlu/interpret.ts` | **deterministic slots always beat model slots** for the same field; conflicting model slots → ask |
| `nlu/confirm-policy.ts` | full slots + high confidence → commit; low confidence → tap; amount over threshold → tap; invalid model JSON → treated as no answer |
| `ledger/ambiguous-vendor.ts` | one category in history → auto-apply; two → stop and ask |
| `ledger/split.ts` | one document → several categorized amounts; splits sum to the total exactly |
| `extract/vendor-profile.ts` | a corrected vendor is trusted next time; profile hints override generic parsing |
| `blob-path.ts` | path always matches `period`; slug sanitization; unicode filenames; hash suffix |
| `statements/parse-personal.ts` | real statement fragments → exact expected transactions; a mangled page fails loudly with the page number |
| `statements/reconcile.ts` | a balancing statement passes; a corrupted one fails; ±0.01 tolerance boundary |
| `ledger/fold.ts` | events → transactions; a `set_category` correction wins over the original; out-of-order events fold identically |
| `normalize.ts` | dedupe key stability; two identical same-day charges stay two entries |
| `ledger/categorize.ts` + `rules.ts` | signal-ladder precedence (stated → items → rule → model → MISC); rule derivation strips volatile tokens |
| `invoice-model.ts` | all four VAT modes; per-invoice half-up rounding; `exempt_export` renders **no** VAT line, not a zero one |
| `vat-mode.ts` | RS → 20%; foreign business → exempt; foreign individual → 20%; missing `country` → refuse, don't assume |
| `invoice-number.ts` | zero-padding preserved; last digit-run incremented; non-numeric tail → null; empty/null → null; number kept as text |
| currency × VAT | all four combinations (RS+RSD, RS+EUR, foreign+EUR, foreign+RSD) — the two must never be coupled |
| `tebra/tools/*` | filters, grouping, sums, multi-currency, empty results, **truncation always reported** |
| `tebra/loop` (scripted fake model) | steps bounded; write tools never auto-execute; reply numbers equal `aggregate` output exactly |
| `tebra/scoping` | a session cannot reach a book its sender phone doesn't own |
| `manifest.ts` / `email-body.ts` | snapshot of the accountant email; `⚠` lines for missing amounts; `extraction_method` column; **PERSONAL data never appears** |
| `clock`-dependent | `previousMonth` on 1 Jan; leap years; DST boundary days |

### L2 — Contract (`test/contract/`) — adapters vs recorded reality

Each adapter is tested against **recorded real payloads** using undici's built-in `MockAgent`. No live network, ever, in CI.

- `sef/client` — pending list, detail, accept, reject, PDF (binary and the "generation triggered" text case), 401, 500, malformed JSON
- `whatsapp/sender` — correct Graph body per message type; >3 buttons falls back to a list; media upload two-step; API error surfaces
- `whatsapp/template` — parameter count matches the registered definition; `131047` is surfaced, not swallowed
- `whatsapp/signature` — valid HMAC passes, tampered body fails, missing header fails, wrong secret fails
- `whatsapp/media` — media-id → url → bytes; 404 at each step
- `store/blob-store` — against **Azurite** (docker) in CI: put/get/list-by-prefix; **`putIfAbsent` returns 409 on the second call**; **`casPut` returns 412 on a stale ETag**. These two are the load-bearing guarantees of the whole no-database design and get the most adversarial tests in the suite — including two concurrent `casPut`s where exactly one must win.
- `mail/imap` — against `.eml` fixtures served by a fake IMAP layer: fetch, parse, **move to Processed on success / Failed on no-route**; a message already moved is not refetched
- `mail/smtp` — recipient always from config, never from input; attachment assembly; size ceiling
- `pdf/text-extract` — real PDF fixtures; text + coordinates preserved
- `doc-intelligence/client` — recorded responses mapped to facts; low-confidence fields dropped
- `qr/decode` — real receipt photos: readable, blurry, absent, and rotated
- `zip/archive` — round-trips; entry names and paths correct

**Recording rule:** every fixture is a real payload, redacted by a committed script (`test/fixtures/redact.ts`) — never hand-written from memory. Hand-written fixtures encode your assumptions, and it's your assumptions that are wrong. Redaction strips: PIB/JMBG of real people, account numbers, tokens, real names on personal statements.

### L3 — Use case (`test/app/`) — behavior with fakes

The layer that proves features work. Real `engine`, in-memory everything else.

```ts
it('stores a receipt photo, reads it from the QR, and replies with a receipt line', async () => {
  const t = harness({ now: '2026-08-11T09:00:00Z' })
  await t.receiveWhatsApp(imageMessage({ from: DILIGAF_PHONE, caption: '/expense' }))

  expect(t.blob.paths()).toEqual([
    'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg.json',
    '_index/hash/diligaf/91be0d47…c9.txt',
  ])
  expect(t.blob.json('…91be0d47.jpg.json')).toMatchObject({
    book: 'DILIGAF', amount_total: 4210, review_status: 'ok',
    extraction: { method: 'fiscal_qr' },
  })
  expect(t.extract.docIntel.callCount).toBe(0)   // the QR answered; nothing else ran
  expect(t.whatsapp.lastText()).toContain('4.210,00 RSD')
})
```

Required cases per feature, because these are the ones that bite in production:

- **happy path**
- **duplicate delivery** — same message id twice ⇒ one document, one reply
- **duplicate content** — same bytes twice ⇒ one document, `↺` reply
- **extraction failure at every layer** ⇒ stored, `needs_review`, queued, honest reply
- **ladder short-circuit** ⇒ a cheaper layer succeeding means no expensive layer is called
- **cache hit** ⇒ identical input, zero model calls, identical result
- **model returns nonsense** ⇒ schema rejection treated as no answer, never as a value
- **model contradicts a deterministic slot** ⇒ the deterministic slot wins
- **low confidence** ⇒ confirmation required before anything is written
- **blob failure** ⇒ nothing claimed as saved
- **sidecar write failure after bytes written** ⇒ document recoverable by re-running extraction
- **unknown sender** ⇒ 200, nothing stored, nothing sent
- **wrong book for the command** ⇒ refusal, nothing stored
- **timer double-fire** ⇒ one send (`_state/notified/*` marker)
- **free-form send outside the 24h window** ⇒ `131047` surfaced and logged, not silently swallowed
- **month boundary** ⇒ 1 Aug packages July; a 31 Jul document arriving 3 Aug lands in July

### L4 — Live smoke (`test/smoke/`, manual)

Not in CI. The `.http` files 1IA already uses, plus a written checklist per milestone: send a real photo, check the blob, check the reply. Run before each deploy to prod. Documented in `07-ROADMAP.md` per milestone.

---

## 4.5 Testing with a model in the loop

A non-deterministic component in a TDD project is a solved problem, but only if you're strict about where it's allowed to appear.

### The rule: CI never calls a model

Every test in `npm test` is deterministic and offline. The model is reached only through `adapters/llm/*`, which is stubbed in L1/L3 and replayed from recorded responses in L2. A live model call in CI would be non-deterministic, cost money, need network, and — worst — make a red build ambiguous.

That means the *interesting* logic is still fully testable, because the model's job is narrow and everything around it is pure:

| Under test | How |
|---|---|
| the schema the model must satisfy | reject malformed/partial JSON as "no answer", not as a value |
| `validate.ts` on model output | same rejection rules as any other layer — PIB, dates, amounts |
| **deterministic slots beat model slots** | stub returns `amount: 999`; deterministic grammar parsed `200E`; assert 200 wins |
| ladder short-circuiting | QR hit ⇒ DI and LLM stubs record zero calls |
| the cache | second identical input ⇒ zero model calls, identical result |
| `confirm-policy` | high confidence + full slots ⇒ commit; low confidence ⇒ tap required; above threshold ⇒ tap required |
| ambiguous-vendor detection | history with two categories ⇒ no auto-apply |
| provenance | `method`, `confidence`, `model` recorded on every fact |

Note the third row. **The most valuable test in this whole area asserts a model's answer is ignored** when a deterministic layer already has one. That property is what makes the hybrid safe, and it's cheap to test precisely because the model is stubbed.

### The eval suite — separate, opt-in, not a gate

Accuracy is a different question from correctness, and it needs a different tool. `test/eval/` holds a labelled corpus and runs against the **real** model on demand (`npm run eval`), never in CI:

```
test/eval/
  receipts/       50 real documents + expected facts (vendor, date, total, currency)
  messages/       80 real phrasings + expected slots  ("300 EVRA", "MATERIJAAL PAMUK 200E Projekat 1")
  categories/     150 real transactions + your actual category choices
  report.md       accuracy per set, per model version, dated
```

How it earns its place:

- **Every correction you make in WhatsApp becomes a labelled example.** The corpus grows from real use, so it gets more representative exactly as fast as E gets more used.
- Run it before changing a prompt, a model version, or a ladder threshold. A prompt tweak that reads better but scores worse is caught here rather than in your accounting.
- Track scores in `report.md` over time. **A regression in the eval is not a red build, it's a decision** — sometimes you accept a 2% drop for a large latency win. Making it a CI gate would be false precision.
- Set a floor per set (e.g. amounts ≥ 98%, categories ≥ 85%) and treat crossing it as a stop-and-look.

### Golden-path snapshots

The three highest-consequence model outputs get committed snapshots from real inputs — a receipt read, a slot fill, a categorization. These *are* in CI, replayed from the recorded response, so a refactor that quietly changes how model output maps into facts fails immediately.

## 5. Tooling

| Concern | Choice | Why |
|---|---|---|
| Runner | **vitest** | ESM + TS native, fast watch, snapshots, built-in coverage — no ts-jest config archaeology |
| HTTP fakes | **undici `MockAgent`** | already in Node 20; adding nock for this is unnecessary |
| Blob | **Azurite** (docker) | real API surface — and `If-None-Match`/`If-Match` semantics are exactly what must be verified against a real implementation, not a mock |
| DB | **none** | D2 — there is no database to test |
| Mail | **`.eml` fixtures** + a fake IMAP layer | the entire mail path is offline-testable; this was impossible with Power Automate's opaque payloads |
| Coverage | **v8** provider, thresholds in CI | `engine/**` gated; adapters reported, not gated |
| Lint | eslint + `no-only-tests`, `no-restricted-imports` (blocks `engine/` → `adapters/`) | the architecture rule is enforced by the linter, not by memory |
| CI | GitHub Actions: lint → unit → contract (Azurite only) → build | ~2 min; PRs blocked on red |

`npm test` must run **fully offline**. If a test needs the internet, it's in the wrong layer.

---

## 6. Fixtures needed from you (critical path)

Parsers cannot be written against imagined data. Anything marked ⚠ blocks its milestone.

| # | Fixture | For | Blocks |
|---|---|---|---|
| F1 ⚠ | 1 real DILIGAF izvod PDF | period/number detection (layer 0 regex) | M2 |
| F2 ⚠ | 2–3 real PERSONAL statement PDFs (different months) | the band parser; multi-page and month-boundary cases | M6 |
| F3 | ~~statement PDF password~~ | **resolved: no password protection** | — |
| F4 ⚠ | 5–10 receipt photos: fiscal receipt **with a clear QR**, one with a damaged/absent QR, a digital supplier invoice PDF, a bad photo, a foreign/non-RSD one | the whole ladder + every failure path | M1 |
| F5 | 2–3 real bank notification **emails**, exported as `.eml` (File → Save As, or drag to Finder) | subject/sender routing; MIME parsing | M2 |
| F6 | one real SEF pending-invoice JSON response | contract tests 1IA never had | M5 |
| F7 | WhatsApp webhook bodies for `image` and `document` | the inbound parser | M1 |
| F8 | one real issued DILIGAF invoice (PDF or just the fields) | template correctness, PDV presentation | M3 |
| F9 | a `Izvod po tekucem racunu…` email as `.eml` | exact subject matching | M6 |
| F10 ⚠ | the raw QR **payload string** from one fiscal receipt | the S-QR spike — confirms the SUF response shape before any code | M1 |
| F11 | 10–15 questions you'd actually ask `/tebra`, in your own words | the eval corpus + the tool surface — if a question needs a tool that doesn't exist, better to find out now | M4.5 |

`.eml` files are the ideal mail fixture: they're the complete message, so routing, MIME parsing, and attachment extraction all get tested from one file with zero network. This is a concrete benefit of dropping Power Automate — its payloads could only ever be approximated.

Redact before committing: F2 is your complete spending history. The redaction script keeps amounts and merchant names (the parser needs them) and strips account numbers, JMBG, and address. If you'd rather not commit F2 at all, the alternative is a `.gitignored` local fixture directory plus a committed synthetic statement derived from it — slightly weaker tests, no personal data in git. Reasonable trade; your call.

**F10 and F7 are the cheapest things you can send first.** F10 is one scan with any QR reader app, pasted into a message — and it unblocks the spike that decides whether E needs any ML for its most common document. F7 costs you sending one photo once the webhook logs raw bodies.

---

## 7. Definition of Done (every task, every milestone)

A change is done when **all** of these hold:

1. Tests written first, seen failing, now passing
2. `engine/**` coverage thresholds met
3. Contract tests cover every new external call, including its error cases
4. Use-case tests cover happy path + duplicate + failure + boundary
5. No `only`/`skip`, no commented-out tests
6. Any change to `_state` shapes ships with a documented migration path and a test reading the old shape (no DB migrations to write — but blob JSON still evolves)
7. Secrets in Key Vault; nothing sensitive in the repo, logs, or fixtures
8. Smoke checklist for the milestone executed against prod and its result recorded in the milestone doc
9. The docs in this folder updated when behavior diverges from what they say

Item 9 matters more than it looks. These documents are the spec; a spec that silently drifts from the code is worse than no spec, because it makes future decisions from stale facts.
