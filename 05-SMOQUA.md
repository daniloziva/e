# E — SMOQUA

Internal cost tracking for the shop. No invoicing, no SEF, no accountant package (v1) — just: **what did we spend, on what, and where's the paper.**

---

## 1. Identity

A second sender phone. `books.sender_phones` for `SMOQUA` holds it; `resolveBook()` does the rest. No second WhatsApp Business number, no second webhook, no extra cost (D1).

Consequence worth knowing: whoever holds that phone can book SMOQUA expenses. That's fine while it's you; if a shop employee ever uses it, add `books.allowed_actions` before handing the phone over, because right now a book grants everything E can do for that book.

---

## 2. Financial dimensions — typed axes, not one field

`MATERIJAAL PAMUK 200E Projekat 1` showed that one dimension isn't enough: that message carries a **category**, a **project**, an item, and an amount. So dimensions are a typed map, declared per book in `_state/books.json`:

```jsonc
"dimensions": [
  { "axis": "category", "type": "closed_set", "required": true,
    "values": ["MATERIALS","PACKAGING","MARKETING","EQUIPMENT","RENT",
               "UTILITIES","LOGISTICS","FEES","SERVICES","OTHER"],
    "aliases": { "MATERIALS": ["MATERIJAL","MAT","ROBA","SIROVINE"],
                 "MARKETING": ["REKLAMA","ADS","PROMO"],
                 "PACKAGING": ["PAKOVANJE","AMBALAZA"] } },
  { "axis": "project",  "type": "open_text", "required": false },
  { "axis": "cost_center", "type": "closed_set", "required": false, "values": [] }
]
```

Stored as `dimensions: { category: "MATERIALS", project: "Projekat 1" }` on both documents and transactions.

| Axis type | Behavior |
|---|---|
| `closed_set` | fuzzy-matched against values + aliases (edit distance ≤ 2, diacritics stripped) → deterministic, so `MATERIJAAL` resolves without a model. Unknown → buttons, never a silent `OTHER`. |
| `open_text` | accepts anything, but E remembers what you've used and offers past values as buttons — so `Projekat 1` is a typo-free tap the second time |

**Adding an axis is a config edit, not a migration.** `CAMPAIGN`, `CHANNEL`, `SUPPLIER_BATCH` next year: add a line, no code. That's what "grows with the company" has to mean in practice — and it's the reason this is a declared array rather than three hardcoded columns.

Reporting rolls up on any axis, or any pair: spend by category, by project, or category × project.

## 3. Intake

### 3a. Bare shorthand (the main path)

```
MATERIALS 300e
MARKETING 12000 fb ads avgust
PACKAGING 4500
MATERIJAAL PAMUK 200E Projekat 1        ← typo, item, amount, project — all in one
```

Order-tolerant and slot-based, not positional. The pipeline is `02-WHATSAPP-INTERFACE.md` §5.1 row 4: deterministic slots first (`200E` → 200 EUR, `MATERIJAAL` → MATERIALS by fuzzy match), model for the leftovers (`PAMUK` as description, `Projekat 1` as the project axis), then merge — where the deterministic amount always wins — then commit or confirm.

```
YOU  MATERIALS 300e
E    ✓ SMOQUA · MATERIALS · 300,00 EUR (≈ 35.130,00 RSD)
     gotovina, bez dokumenta
     [Dodaj račun] [Promeni dimenziju] [Obriši]

YOU  MATERIJAAL PAMUK 200E Projekat 1
E    ✓ SMOQUA · MATERIALS · PAMUK · 200,00 EUR (≈ 23.420,00 RSD)
     projekat: Projekat 1
     [Ispravi] [Promeni dimenziju]
```

The second one commits without a confirmation step because every slot resolved with high confidence and the amount came from the deterministic grammar. Had the model been unsure which token was the project, E would have echoed its reading and waited for a tap instead.

`[Dodaj račun]` arms a short-lived `conversation_state`: the next image/PDF from that phone attaches to this transaction instead of creating a new one. Expires in 10 minutes, then reverts to normal behavior — a stale "waiting for attachment" state that silently swallows next week's receipt is worse than asking again.

### 3b. Document with a dimension

```
YOU  [PDF invoice, caption: MATERIALS]
E    ✓ SMOQUA · MATERIALS · dobavljač Kartonaža doo · 48.900,00 RSD · 03.08.
     [Promeni dimenziju] [Ispravi]
```

Extraction runs the ladder in `01-ARCHITECTURE.md` §5. Dimensions come from the caption.

SMOQUA is where the **90-layout problem** actually lives: the shop buys abroad, so foreign supplier documents are the norm and the Serbian fiscal QR (layer 1) never applies to them. Expect layer 4 (`prebuilt-invoice`) to do most of the work here, layer 5 for the odd ones — and layer 2 to take over vendor by vendor as you correct each supplier once. Watch the mix in `/status`: if it isn't drifting toward layers 2–3 after a few months, the vendor-profile learning isn't working and that's a bug worth chasing.

### 3c. Document without a dimension

```
YOU  [PDF invoice, no caption]
E    ✓ SMOQUA · sačuvano · Kartonaža doo · 48.900,00 RSD
     Za šta je ovo?  [MATERIALS] [PACKAGING] [Ostalo…]
```

The document is stored first and the question comes after. You can ignore the question and answer it during `/misc` later — the paper is never held hostage to a classification.

If a vendor has been tagged before, E pre-selects that dimension as the first button — a rule in `_state/rules/smoqua.json`, learned from your taps. And as in PERSONAL, a vendor you've tagged more than one way is detected as ambiguous and E stops guessing for it rather than picking the most recent.

### 3d. Email

Subject prefix `E:SMOQUA` → `book=SMOQUA, category='expense'`. If the subject carries a dimension (`E:SMOQUA MATERIALS`), it's used; otherwise the document lands unclassified in `/misc`.

---

## 4. Currency

The shop buys abroad, so mixed currency is normal, not an edge case.

- Amount keeps its **original currency** (`300.00 EUR`) — that's the invoice's truth
- `amount_rsd` is computed with the NBS middle rate for the **document's date** (1IA's `nbs-rates.ts`), stored alongside
- Reports show both: dimension totals in RSD, with a per-currency breakdown underneath
- Rate lookup failure → store the original amount, leave `amount_rsd` null, `needs_review`, backfill on the next successful rate fetch

Storing the rate *as of the document date* rather than converting at report time is deliberate: it makes historical numbers stable. A report re-run in December must not change August's figures.

---

## 5. Reporting

```
YOU  (SMOQUA phone)  /status
E    SMOQUA · avgust 2026
     MATERIALS    620,00 € + 84.000 RSD   ≈ 156.600,00
     PACKAGING     48.900,00
     MARKETING     18.000,00
     LOGISTICS     12.400,00
     ─────────────────────────
     Ukupno      ≈ 235.900,00 RSD
     4 dokumenta · 3 bez računa
     [Detaljno] [Jul] [Bez računa]
```

`[Bez računa]` — cash expenses with no document — is the list that matters at month end, because those are the ones that need paper found or a note written.

### Later (explicitly out of scope for v1)

- Cost of goods / margin per product — needs sales data, which lives in the SMOQUA shop system, not in E
- Supplier-level spend trends
- Accountant package for SMOQUA — trivial once wanted: SMOQUA already produces documents in the same shape, so it's one field in `books.json` (`accountant_email`) plus reusing `send-monthly-package`. It isn't in v1 because you said internal tracking, not filing.

---

## 6. What SMOQUA reuses vs adds

| Reused unchanged | New for SMOQUA |
|---|---|
| `ingestDocument` pipeline | typed dimension axes + alias/fuzzy resolution |
| the extraction ladder + validation | required-axis enforcement, `open_text` axes |
| `engine/money.ts`, `engine/nlu/*` | multi-currency, multi-axis rollup |
| rules + ambiguous-vendor detection | vendor → dimension pre-selection |
| blob layout, sidecars, tx event blobs | `[Dodaj račun]` attach-to-previous state |
| `/status`, `/misc` | per-currency `/status` rendering |

Roughly 85% reuse — which is the argument for building DILIGAF's pipeline properly first (M1–M2) and letting SMOQUA be a two-day milestone (M7) rather than a parallel effort.
