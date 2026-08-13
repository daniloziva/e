# E — WhatsApp Interface

## 1. Design principle

You are lazy on purpose. So:

- **One message should be enough.** A photo with the caption `/expense` is a complete instruction — E must never reply "now send the image."
- **Deterministic routing, flexible interpretation.** Which code path runs is always decided by a pure function. What your words *meant* can involve a model (§5.1). The model fills slots; it never picks the branch, and it never commits money it wasn't sure about.
- **Every write gets a one-line receipt.** `✓ DILIGAF expense · OMV · 4.210,00 RSD · 11.08.` Short enough to skim while walking.
- **Fixing a mistake is one tap**, never a re-send. Every receipt carries the buttons needed to reclassify or delete.

## 2. The 24-hour window — the constraint that shapes proactive messaging

### The mechanic

WhatsApp Cloud API distinguishes two kinds of outbound message:

| | When it's allowed | Payload |
|---|---|---|
| **Free-form** (text, interactive buttons, lists, documents) | only within **24 hours** of your last inbound message | `type: 'text'` / `'interactive'` / `'document'` |
| **Template** (pre-registered, pre-approved) | any time | `type: 'template'` with a name, language, and parameters |

Send free-form outside the window and the API returns **error `131047`** — *"Message failed to send because more than 24 hours have passed since the customer last replied."* The message is rejected, not queued. And it fails silently from your point of view: at 07:00 on a Tuesday nobody is reading the function's logs.

**This is a Meta messaging policy, not a scheduling problem.** A cron expression, a Logic App recurrence, and an Azure Functions timer all do the same thing — decide when to call the API. None of them change whether that call is accepted. So `cron → SEF pull → parse → send` is exactly the right pipeline; the only part that needs adjusting is the payload on the final hop.

### What E does about it

Register two **UTILITY** templates with quick-reply buttons:

```
e_sef_pending      "Imaš {{1}} eFaktura na čekanju."         [Pregledaj] [Kasnije]
e_monthly_package  "{{1}} paket spreman: {{2}} dokumenata."  [Pošalji] [Prikaži listu]
```

Tapping a quick-reply button arrives as an ordinary inbound `interactive.button_reply` webhook → **the 24-hour window opens** → every message after that is normal free-form interactive messaging. The template is only ever the doorbell. All the real UX lives behind it, unchanged.

| Proactive message | Delivery |
|---|---|
| Daily SEF digest | template `e_sef_pending` |
| Monthly package ready | template `e_monthly_package` |
| Anything answering something you just sent | free-form — you're inside the window |

**Send the nudge as a template unconditionally.** You'll message E most days, so the digest will often land inside the window where free-form would work — but you cannot reliably know the window's state from the outside (it depends on your last inbound, which E would have to track and would get wrong after any missed webhook). Branching on a guess to save a fraction of a cent is how you get a silent 07:00 failure in February. Templates work in both cases.

### Practical notes

- **Approval is a review.** Usually quick for UTILITY, but it can bounce — commonly for a variable at the very start or end of the body, or a body that reads as marketing. Both templates above put text around every `{{n}}` for that reason. File them at the *start* of M5, not when the code is ready.
- **Cost.** Utility template messages are billed per message; user-initiated service conversations are free. At ~30 nudges a month this is a rounding error, but it's not zero, which is another reason the digest only fires when there's actually something pending.
- **Parameters are positional and typed.** `{{1}}` etc. are filled from a `components` array, and the count must match the registered template exactly or the send fails. `adapters/whatsapp/template.ts` builds these, and its contract test asserts the parameter count against the registered definition.

*Assumption to verify (A3): E's number is on a WABA in good standing that can register utility templates. If template approval turns out to be blocked, the fallback is that proactive nudges arrive by email (SMTP is already in the stack for the accountant package) and WhatsApp stays request/response. Degraded, but nothing breaks.*

## 3. Message types E must handle

`1ia-mvp01`'s parser handles `text`, `interactive.button_reply`, `interactive.list_reply`, `audio`. E adds the two that matter most:

| WhatsApp type | E's treatment |
|---|---|
| `image` | receipt/invoice photo. `caption` is the command line. |
| `document` | PDF receipt, izvod, supplier invoice. `caption` is the command line. `filename` is a hint. |
| `text` | command → switch; otherwise free-text slot filling (§5.1) |
| `interactive` | button/list reply — routed by `action:id` convention |
| `audio` | Whisper (`language: 'sr'`) → transcript → the same free-text pipeline as `text`, same confirm policy |
| anything else | polite "ne razumem ovaj tip poruke" + menu |

The parser becomes: `parseInboundMessage(webhookBody) → InboundMessage` where `InboundMessage` is a discriminated union with a `media?: { id, mimeType, filename?, caption? }`. Pure function, one test per type, fixtures captured from real webhook payloads.

## 4. Book resolution

```
resolveBook(senderPhone, books) → Book | null
```

Pure, table-driven from `books.sender_phones`. Unknown sender → 200, log, no reply (E is not a public service and shouldn't confirm its own existence to strangers).

Your personal phone maps to **DILIGAF** as its default book, because that's where documents pile up. `PERSONAL` is reached by command (`/cash`, `/misc`), not by default — personal spend arrives mostly via the bank, not via photos. The SMOQUA phone maps to **SMOQUA**.

## 5. Command grammar

One pure parser: `parseCommand(text) → Command`. Case-insensitive, diacritic-insensitive, tolerant of a missing slash for the SMOQUA dimension shorthand.

```
/expense [AMT] [description...]        attach image or PDF (or reply to one)
/cash AMT description...              PERSONAL cash outflow
/invoice                              start the invoice wizard
/pending                              SEF invoices awaiting action
/misc                                 review queue: uncategorized transactions + unread receipts
/report [YYYY-MM]                     compile + offer the accountant package now
/status                               what E has collected this period
/book DILIGAF|PERSONAL|SMOQUA         set the book for your next message
/tebra "<prompt>"                     ask anything about your own data (09-TEBRA.md)
/help                                 the list above

SMOQUA phone shorthand:
MATERIALS 300e                        = /expense with dimension MATERIALS, 300 EUR, cash
/expense MARKETING 12000 fb ads       explicit form
```

### Amount grammar (`core/money.ts`)

Serbian formatting is a minefield and gets its own tested module:

```
4210        → 4210.00 RSD
4.210,00    → 4210.00 RSD      (dot = thousands, comma = decimal)
4210.50     → 4210.50 RSD      (ambiguous single dot with 2 decimals = decimal)
300e  300€  300 eur            → 300.00 EUR
1500din  1.500 rsd             → 1500.00 RSD
12k                            → 12000.00 RSD
300 EVRA  300 evra  300 evro   → 300.00 EUR   (synonym table, extensible, learned)
"tri hiljade"                  → deterministic parser declines → model slot-fill → confirm
```

Rule: the deterministic parser either returns a confident amount or returns **nothing** — it never half-guesses. What it does return is authoritative and a model can never overwrite it. What it declines to parse falls through to the model, and comes back through a confirm step. Amounts are the field where a silently wrong answer costs real money, so this is the one place the layering is strictly enforced.

## 5.1 Routing — deterministic shell, AI core

Two different jobs get two different mechanisms, and conflating them was my mistake in v2.

**Routing** (which code path runs) is deterministic, always. **Interpretation** (what did this human or this document mean) uses AI wherever the input is genuinely unstructured. The model fills slots; it never picks the branch.

### The cascade

| # | Signal | Resolution | Model? |
|---|---|---|---|
| 1 | **Attachment present** | it's a document → ingest for the sender's book | no |
| 2 | **Button / list reply** | explicit id: `accept:4471039`, `dim:MATERIALS` | no |
| 3 | **Slash command** | first token → switch (fuzzy-matched, below) | no — except `/tebra`, whose *argument* is the model's whole job |
| 4 | **Free text** | deterministic slot pass → LLM slot-fill for what's left → confirm-or-commit | **yes** |
| 5 | **Nothing resolved** | menu | no |

Rows 1–3 are your point about SEF and fiscal invoices: buttons and commands are trivially deterministic and should stay that way. Accepting a SEF invoice will never route through a model. Row 4 is your point about everything else.

### Row 4 in detail — `MATERIJAAL PAMUK 200E Projekat 1`

The pass order matters, because deterministic wins are free and they shrink the model's job:

```
1. deterministic slots        200E        → { amount: 200, currency: EUR }
                              (money grammar + the synonym table: EVRA/evro/€/eura → EUR)
2. fuzzy dimension match      MATERIJAAL  → MATERIALS   (edit distance ≤ 2 vs the alias list)
3. leftovers to the model     "PAMUK", "Projekat 1"
   → schema-constrained call, returns:
     { description: "PAMUK", dimensions: { project: "Projekat 1" }, confidence: "high" }
4. merge + validate           amount/currency from step 1 always win over the model
5. confirm policy             all slots filled, high confidence → commit + one-line receipt
                              anything ambiguous → echo the interpretation, wait for a tap
```

```
E   ✓ SMOQUA · MATERIALS · PAMUK · 200,00 EUR
    projekat: Projekat 1
    [Ispravi] [Promeni dimenziju]
```

Three things worth calling out:

- **`200E` never reaches the model.** Deterministic slots are extracted first and are authoritative — the model can't overwrite an amount the grammar already parsed. That's the single most important safety property here, because the amount is the field where a wrong answer costs real money.
- **`EVRA` is fixed twice over.** The synonym table catches it deterministically and for free; the model is the backstop for the tail the table hasn't learned yet. When the model resolves something the table could have, E offers `[Zapamti: EVRA = EUR]` — so the deterministic layer grows and the model fires less over time.
- **`MATERIJAAL` doesn't need AI at all.** Fuzzy matching against a known alias list handles typos deterministically. The model is only for slots that aren't drawn from a closed set.

### Dimensions are a typed map, not one string

`Projekat 1` revealed something the v2 model couldn't hold: you need more than one axis. So:

```
dimensions: { category: "MATERIALS", project: "Projekat 1", cost_center: null, … }
```

Axes are declared per book in `_state/books.json` — each with a type (`closed_set` like category, or `open_text` like project) and aliases. Adding `COST_CENTER` or `CAMPAIGN` next year is a config edit, not a migration. `closed_set` axes get fuzzy matching and buttons; `open_text` axes accept anything but E remembers what you've used so it can offer them as buttons next time.

This is what "grows with the company" has to mean concretely: new axes without new code.

### Commands still get deterministic fuzzy matching

Case-insensitive, diacritics stripped, Levenshtein ≤ 1 — `/expence` and `/troshak` resolve without a model call. Cheap, instant, tested.

### Cost, latency, and drift

- The model only fires on **row 4 fallthrough** and on documents the deterministic extraction layers didn't resolve. Not on every message.
- Every call is **cached by content hash** (`01-ARCHITECTURE.md` §5), so the same phrase or the same photo resolves identically forever. Re-running a month is free and gives the same answer.
- Every model-derived fact records `method`, `confidence`, and `model` id, so a model upgrade is auditable and selectively re-runnable.
- `/status` reports the deterministic-vs-model mix, so you can watch it shift toward deterministic as vendor profiles and synonyms accumulate — and notice if it doesn't.

### The confirm policy (`core/nlu/confirm-policy.ts`)

The one rule that keeps a flexible front end from becoming a liability:

| Situation | Behavior |
|---|---|
| all slots deterministic, or model high-confidence with every slot filled | **commit**, one-line receipt, `[Ispravi]` |
| any slot low confidence, or an amount above a configurable threshold | **echo the interpretation, require a tap** |
| conflicting slots (two candidate amounts, two candidate dimensions) | ask, with both options as buttons |
| model returns invalid JSON, or validation rejects a field | treat as no answer — fall through to asking |

Amount thresholds are per book. Booking 200 EUR of cotton auto-commits; something an order of magnitude larger asks first.

### Voice comes back

With the model in the loop for free text anyway, Whisper is a small addition and dictating a cash expense while driving is a real use case. Transcript → the same row 4 pipeline. Same confirm policy, so a misheard amount gets caught by the same guard.

## 6. Flows

### F1 — Expense from a photo (the flagship, must be flawless)

```
YOU  [photo of a fiscal receipt, caption: /expense]

E    ⏳ (typing/ack within 2s)
E    ✓ DILIGAF · trošak sačuvan
     OMV Srbija · 4.210,00 RSD · 11.08.2026
     diligaf/2026/08/expense/…--91be0d47.jpg
     [Ispravi] [SMOQUA] [Obriši]
```

Details that decide whether this feels good:
- **Ack fast, extract after.** Store the blob and reply within ~2s; extraction (QR verification or Document Intelligence) can take 2–8s. Two messages beats one slow one: ack first, then a follow-up carrying the facts.
- **No caption?** Still stored as a DILIGAF expense; the receipt line says so and offers `[PERSONAL] [SMOQUA]` to move it. Zero-friction default beats a clarifying question.
- **Extraction failed?** `✓ sačuvano · nisam pročitao iznos [Unesi iznos]` — the document is safe, the number is a one-tap fix, and it lands in `/misc`.
- **Duplicate photo of the same receipt?** `↺ već imam ovaj dokument (11.08.)` — no second row, no second entry in the accountant package.
- **`[Ispravi]`** opens a tiny wizard: amount → vendor → date, each step skippable.

### F2 — Expense forwarded by email

No WhatsApp involvement; covered in `03-DILIGAF.md` §2. E sends an unsolicited receipt line only if you're inside the 24h window; otherwise it appears in `/status` and the monthly package. (Deliberate: an email-forwarded receipt is already a low-friction act; it doesn't need a push.)

### F3 — Cash expense

```
YOU  /cash 800 parking
E    ✓ PERSONAL · gotovina · 800,00 RSD · parking
     kategorija: TRANSPORT  [Promeni]
```

Category is guessed by the same rules engine that handles statement lines, so a `/cash` correction teaches the statement parser too.

### F4 — SMOQUA dimension shorthand

```
YOU  (from SMOQUA phone)  MATERIALS 300e
E    ✓ SMOQUA · MATERIALS · 300,00 EUR (≈ 35.130,00 RSD)
     gotovina, bez dokumenta  [Dodaj račun] [Promeni dimenziju]
```

Unknown dimension word → buttons with the book's dimension list. Never silently `OTHER`.

### F5 — Invoice issuing

Domestic customer — VAT derived, number suggested:

```
YOU  /invoice
E    Za koga?  [Klijent A] [Klijent B] [Novi]
YOU  [Klijent A]
E    Broj fakture?  [KLIJENTA-2026-04] [Unesi drugi]
YOU  [KLIJENTA-2026-04]
E    KLIJENTA-2026-04 · 15.08.2026
     Klijent A (RS) · "Konsultantske usluge, avgust 2026"
     Neto 300.000,00 · PDV 20% 60.000,00 · Ukupno 360.000,00 RSD
     [Potvrdi] [Izmeni opis] [Izmeni iznos] [Izmeni datum]
YOU  [Potvrdi]
E    [PDF: KLIJENTA-2026-04.pdf]
     ✓ sačuvano u avgust paket
```

International customer — no VAT, EUR, bilingual PDF:

```
E    ACME GmbH (DE) · "Consulting services, August 2026"
     Ukupno 3.000,00 EUR · bez PDV-a (izvoz usluga)
     Srednji kurs NBS 15.08.2026: 1 EUR = 117,1043 RSD → 351.312,90 RSD
     [Potvrdi] [Izmeni opis] [Izmeni iznos] [Izmeni datum]
```

Three things make this two-or-three taps instead of a form:

- **Defaults from that customer's last invoice** — description, amount, currency.
- **The number is suggested, never allocated** (D12). E increments the trailing digits of your last number for that customer and you confirm. You own the scheme; E just saves you the typing.
- **VAT is derived from the customer, never asked** (D13) — `RS` → 20%, foreign business → none, with the exemption note instead of a `PDV 0,00` line.

If the number you enter has been used before: `⚠ KLIJENTA-2026-04 već postoji (12.07.2026) — nastavi?`. A warning, not a block.

### F6 — SEF daily digest + inline action

```
E    [template] Imaš 3 eFakture na čekanju.  [Pregledaj] [Kasnije]
YOU  [Pregledaj]
E    (list) Telekom Srbija · 12.480,00 · 09.08.
          EPS Snabdevanje · 8.115,00 · 08.08.
          Kancelarijski materijal doo · 3.900,00 · 07.08.
YOU  [Telekom Srbija]
E    eFaktura · Telekom Srbija · PIB 100002887
     Neto 10.400 · PDV 2.080 · Ukupno 12.480,00 RSD
     [Prihvati] [Odbij] [PDF]
YOU  [Prihvati]
E    ✓ prihvaćeno na SEF-u · PDF arhiviran u avgust paket
```

Reuses 1IA's `sendInvoiceCard` / `sendPendingInvoiceList` / button-router `accept:`/`reject:`/`details:`/`pdf:` handlers almost verbatim. New behavior: on accept, the SEF PDF is auto-downloaded into `diligaf/YYYY/MM/sef_inbound/` so it's in the accountant package without you thinking about it.

### F7 — Monthly package confirmation

```
E    [template] Jul paket spreman: 23 dokumenta.  [Pošalji] [Prikaži listu]
YOU  [Prikaži listu]
E    DILIGAF · jul 2026
     3 izvoda
     14 troškova · 186.430,00 RSD
     2 izlazne fakture · 720.000,00 RSD
     4 SEF ulazne · 41.220,00 RSD
     ⚠ 2 dokumenta bez iznosa
     [Pošalji računovođi] [Vidi problematične] [Odloži za sutra]
```

The `⚠` line is the reason confirmation exists (D6). Two unpriced receipts is exactly the thing you want to fix before the accountant sees it.

### F8 — MISC review

```
YOU  /misc
E    7 stvari za obradu:
     (list) 2026-08-04 · WOLT BEOGRAD · -1.890,00
            2026-08-06 · AIRBNB · -12.400,00
            …
YOU  [WOLT BEOGRAD]
E    WOLT BEOGRAD · -1.890,00 · 04.08.
     [HRANA] [ZABAVA] [Ostalo…]
YOU  [HRANA]
E    ✓ HRANA · pravilo sačuvano: "WOLT" → HRANA (23 slična unosa ažurirano)
```

Rule learning is what makes S5 (≥85% auto-categorized) reachable by month three instead of never.

### F9 — Status

```
YOU  /status
E    Avgust 2026 · do danas
     DILIGAF: 1 izvod · 9 troškova · 1 faktura · 2 SEF
     PERSONAL: 47 transakcija (5 MISC)
     SMOQUA: 4 troška · MATERIALS 620€ · MARKETING 18.000 RSD
     [Paket za jul] [Obradi MISC]
```

## 7. Error and edge behavior

| Situation | E's response |
|---|---|
| Media download from Meta fails | `⚠ nisam preuzeo fajl, pošalji ponovo` + retry once with backoff first |
| Same WhatsApp message redelivered | silent no-op (`processed_events`) |
| Blob write fails | `⚠ nije sačuvano — probaj ponovo`, and **nothing is claimed as saved** |
| Sidecar write fails after the bytes landed | reply with the receipt but flag it; the document is intact and extraction can be re-run against it |
| Extraction unavailable (DI down, QR unreadable) | store, `needs_review`, `[Unesi iznos]` offered. Never a lost document. |
| Unparseable text | menu buttons + `/help`. Never a silent drop, never a guess. |
| Message from an unknown number | 200, log, no reply |
| Command in the wrong book (e.g. `/invoice` from SMOQUA phone) | `⚠ /invoice radi samo za DILIGAF` |

## 8. Language

Serbian, latin script, no diacritics required on input, diacritics used on output. Terse. No emoji except the four status glyphs `✓ ⚠ ↺ ⏳` — they carry meaning at a glance and nothing else does.
