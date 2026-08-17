# Fixtures

Real data. Every one of these unblocks something that is deliberately not
being written until it lands — see `TEST-FREEZE.md` ("Not frozen, because it
does not exist yet") and `06-TDD-STRATEGY.md` §5.

**Anything with real account numbers, balances or personal detail goes in
`private/`, which is gitignored.** Everything else can be committed.

## Ranked by value per second of Danilo's time

| | Fixture | What it is | Unblocks | For |
|---|---|---|---|---|
| 1 | **F10** ⚠ | the raw QR **payload string** from one fiscal receipt — scan with any QR app, paste the text | spike **S-QR** → `extract/fiscal-qr.ts` | M1 |
| 2 | **F7** | WhatsApp webhook bodies for `image` and `document` | `whatsapp/parse-inbound.ts` | M1 |
| 3 | **F4** ⚠ | 5–10 receipt photos: fiscal receipt with a clear QR, one with a damaged/absent QR, a digital supplier invoice PDF, a bad photo, a foreign/non-RSD one | the whole ladder + every failure path; spike **S-DI** | M1 |
| 4 | **F1** ⚠ | 1 real DILIGAF izvod PDF | period/number detection | M2 |
| 5 | **F5** | 2–3 real bank notification **emails** as `.eml` | `mail/parse-eml.ts`, routing | M2 |
| 6 | **F8** | one real issued DILIGAF invoice (PDF, or just the fields) | template correctness, PDV presentation | M3 |
| 7 | **F11** | 10–15 questions you would actually ask `/tebra`, in your own words | the eval corpus and the tool surface | M4.5 |
| 8 | **F6** | one real SEF pending-invoice JSON response | contract tests 1IA never had | M5 |
| 9 | **F2** ⚠ | 2–3 real PERSONAL statement PDFs, different months | `statements/parse-personal.ts` | M6 |
| 10 | **F9** | a `Izvod po tekucem racunu…` email as `.eml` | exact subject matching | M6 |

`F3` (statement PDF password) is **resolved** — no password protection. Nothing to supply.

## Why F10 is first

It is one scan and one paste, and it decides whether E needs **any** ML for its
most common document. If the QR payload or the `suf.purs.gov.rs` verification
response carries the totals, layer 1 of the extraction ladder is the primary
path for fiscal receipts and layers 4–5 rarely fire at all. If it does not,
layer 2 becomes primary and the ladder is shaped differently.

Until that is known, `extract/fiscal-qr.ts` stays a placeholder. Writing
assertions against an endpoint whose response shape is unconfirmed is the exact
failure this project has avoided throughout.

## Also blocking, but not fixtures

- **Q17** — IMAP/SMTP host and credentials (M2). Do not paste them here; they
  belong in Key Vault. Only the hostname and account are needed to write code.
- **Q18** — the exact export exemption note text for international invoices (M3).
- **S-PIB** — APR open data vs. the NBS PIB lookup. Decides the vendor-identity
  contract, which is the one part of the frozen suite still provisional.
