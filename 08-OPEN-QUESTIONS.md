# E — Open Questions

> **v5.** Vendor identity, `/tebra` corrections, and the `applyProfile` contract settled. Still open: Q17 (IMAP credentials), Q18 (export exemption note), Q10 (dimension axes), and spike S-PIB.

---

## Resolved

| # | Question | Answer | Consequence |
|---|---|---|---|
| Q1 | Is DILIGAF PDV-registered? | **Yes — but no invoice submission from the app yet, and PDV applies to domestic customers only** | Invoice PDF carries net / PDV 20% / total for RS customers; no VAT + an exemption note for international (D13). SEF sales submission and the UBL XML builder are **out of v1 scope** (D10). M3 shrank; the riskiest inherited code never ships. |
| Q2 | Which mail platform? | **Self-hosted SMTP or iCloud** | Power Automate and Graph are both out. Inbound = IMAP poll with folder moves; outbound = direct SMTP (D3, D4). Net win: no HTTP ingest surface, no Premium licence, and the whole mail path is testable from `.eml` fixtures. |
| Q3 | Are statement PDFs password-protected? | **No** | The pdfjs password path is dropped. One less config secret, one less failure mode. |
| Q5 | Fork or evolve 1IA? | **Fork — new repo** | E is custom and heavily tailored; 1IA stays generic. Confirmed. |
| Q7 | Supabase project or schema? | **No database at all** | Blob-only (D2). `If-None-Match` create-if-absent and ETag CAS cover dedupe, idempotency, and safe state updates; the path is the index. Drops a service, a connection string, RLS, migrations, and Postgres from CI. |
| — | Extraction & interpretation | **Hybrid — the model proposes, the code decides** | v3's pure-deterministic design broke on 90 supplier layouts, `300 EVRA`, and mixed-basket categorization. AI now handles unstructured input; safety comes from *how* its output is handled (structured only, same validators, cached by content hash, provenance recorded, confirm when unsure). Routing stays deterministic. `01-ARCHITECTURE.md` §5, `02-WHATSAPP-INTERFACE.md` §5.1. |
| — | Dimensions | **Typed axes** (`category`, `project`, …) | `MATERIJAAL PAMUK 200E Projekat 1` needs more than one axis. Declared in `books.json`; adding one later is config, not code (D14). |
| — | Voice | **Back in** | with the model in the loop for free text anyway, Whisper is a small addition and dictating while driving is a real case. Same confirm policy catches a misheard amount. |
| Q14 | Which mailbox? | **Assume IMAP** | Host/user/app-password still needed (Q17). Code is identical for iCloud or self-hosted. |
| Q15 | Who owns the invoice number? | **You do — per customer** | No counter, no sequence, no `_state/seq` (D12). Number is text; E suggests by incrementing the trailing digits of that customer's last one, and warns on reuse. M3 got smaller. |
| — | VAT treatment | **20% domestic, none international** | Derived from the customer's country + `is_business`, never asked (D13). Export renders an exemption note rather than a zero-VAT line. Currency kept independent of VAT. |
| — | Correcting a wrong stored vendor PIB | **Via `/tebra` + a skill**, hitting blob after your confirmation | No bespoke flow. Adds `set_vendor_profile` / `merge_vendors` as proposal-only write tools (09-TEBRA §3). Safe because `_state/**` carries blob versioning. |
| — | `applyProfile` raw-candidate shape | **Flat atomic keys**, never dotted paths | Adapters flatten their own wire shapes, so `core/` never learns a provider's response tree. Also a security boundary: a trust label is `_state` data `/tebra` can edit, so path-walking would expose `__proto__`. Asserted in `extract-ladder.test.ts`. |
| — | Vendor-profile re-keying / orphaned files | **No derived filename at all** — one `_state/vendor-profiles.json`, matched on content | Your call. At 50–200 vendors the whole map is ~50 KB; PIB is identity, names are matchable aliases, and there is no key to go stale. ETag CAS handles updates. |
| — | `vendorKey` normalization (Đ→d vs dj, Cyrillic, punctuation) | **Retired by PIB identity + a canonical name from one source** | Blocked on spike **S-PIB**: APR open data (local, deterministic — 1IA already shipped it) vs the NBS PIB lookup (live, response shape unconfirmed). Foreign vendors have no Serbian PIB and need a name-plus-merge fallback. |
| Q16 | Fixtures | **You're gathering them** | Drop into `test/fixtures/`. F10 (a QR payload string) is still the highest value-per-second item. |

---

## Blocking

### Q17 — IMAP/SMTP host and credentials
**Blocks:** M2 (all email ingest), M4's outbound send.
**Need:** host, port, username, and an app-specific password (iCloud) or account password (self-hosted), into Key Vault. Plus which folders to use for watch / processed / failed — defaults `E/Inbox`, `E/Processed`, `E/Failed`.
**Lean, if you have the choice:** the self-hosted box. You control it, there's no connection throttling, and a **Sieve rule can file matching mail into `E/Inbox` server-side** — which is the cleanest version of the whole design. iCloud works identically in code but adds Apple's IMAP rate limiting and an app-specific password to manage.
**Also:** do the DILIGAF izvodi and the personal statement arrive in the *same* mailbox? Different mailboxes just means two poller configs against one routing table.

### Q18 — The export exemption note
**Blocks:** M3's international invoice (the domestic one can ship without it).
**Need:** one string — the exact wording and legal citation your international invoices should carry in place of a VAT line. E prints it verbatim; I won't compose tax language for you.
**Also worth confirming while you're asking:** whether all your international customers are businesses. The rule in D13 treats foreign-business as exempt and foreign-individual as domestic-rate, because services to a foreign individual can still attract Serbian VAT depending on the service. If you only ever invoice foreign companies this never fires — but the flag is tracked so it's a data change if it ever does.

### Q16 — Fixtures *(in progress — you're gathering them)*
Drop into `test/fixtures/`. Full table in `06-TDD-STRATEGY.md` §6. The two cheapest with the most leverage:
- **F10 — one fiscal receipt's raw QR payload string.** Scan any receipt with a QR app, paste the string. It unblocks the S-QR spike, which decides whether E's most common document needs any ML at all. Highest value per second of your time in the project.
- **F7 — WhatsApp webhook bodies for `image` and `document`.** Send E one photo once the webhook logs raw bodies.

---

## Defaults I'll take unless you say otherwise

### Q4 — Which banks?
**Default:** write the parsers against whatever files arrive; name the modules after the banks.
**Still worth telling me:** whether the new bank you're considering offers per-transaction notification emails *with a reference id and the full merchant name*. Those two fields decide how good the dedupe and categorization can be — and if they're there, the PDF band parser (M6, the largest milestone) may never need to be written at all. That's a big enough saving to check before M6 starts.

### Q6 — Same Azure subscription as 1IA?
**Default:** new resource group `rg-e-prod`, same subscription, new storage account (**GPv2, hierarchical namespace off** — HNS would disable some blob features and E has no use for it).

### Q8 — Reuse 1IA's WhatsApp number?
**Default:** yes, as you indicated.
**One consequence:** templates are registered per-WABA, so when 1IA becomes real and needs its own number, the templates get re-registered on the new one. Small chore, not zero.

### Q9 — Personal categories
**Default:** the list in `04-PERSONAL.md` §3. Less urgent than in v3 — the model handles the tail from day one now — but a seed list of your top ~30 merchants still makes month one deterministic where it matters most, and every rule is one fewer model call forever.

### Q10 — SMOQUA dimension axes
**Default:** the axes in `05-SMOQUA.md` §2 — `category` (closed set) and `project` (open text).
**Ask:** which axes you actually want beyond those two (cost centre? campaign? supplier batch?), and the **aliases** — the words you'd type at 11pm matter more than the canonical names. Adding an axis later is a config edit, so this isn't a decision you're locked into.

### Q11 — Accountant's email and preferences?
**Default:** zip attached (≤8 MB), Serbian body, `manifest.csv` inside.
**Ask:** the address; whether they want a particular folder structure inside the zip, a filename convention, or Excel instead of CSV (one-line change). Cheap to match their habits now, annoying to retrofit once they've built a routine around what E sends.

### Q12 — Does the personal statement period align with calendar months?
**Default:** calendar months.
**Why it matters:** if the statement runs e.g. 15th–14th, the "which month is this transaction in" logic changes and the reconciliation guard must use the statement's own period rather than the calendar's.

### Q13 — Same phone for PERSONAL and DILIGAF?
**Default:** yes — DILIGAF is the default book, `/cash` and `/misc` reach PERSONAL explicitly.
**Why not a sticky `/book` toggle:** a forgotten mode files a receipt into the wrong book silently, which is the worst class of bug for this tool. If you want the toggle anyway, I'd pair it with the active book echoed in every reply.

---

## Things I'm assuming

| # | Assumption | If wrong |
|---|---|---|
| A1 | DILIGAF's SEF API key works today (per 1IA) | M5 needs a key provisioning step |
| A2 | ~~Power Automate rights~~ | **moot** — no Power Automate |
| A3 | The WABA can register UTILITY templates | proactive nudges move to email (SMTP is already there); WhatsApp stays request/response |
| A4 | A Document Intelligence resource can be provisioned in a nearby region | LLM vision covers the same rung, less cheaply and less consistently |
| A5 | Volume <100 docs/month, <500 transactions/month | the blob-only design is sized for roughly 100× this; past that, revisit |
| A6 | Sending receipt images and message text to Azure AI services is acceptable | the cache and QR rungs mean much of it never leaves anyway; a QR-only setup remains a real option for fiscal receipts |
| A10 | The Azure OpenAI deployment supports tool/function calling or JSON-schema output | nothing in E parses prose from a model, so structured output is a hard requirement, not a preference |
| A7 | DILIGAF izvodi need no line-item parsing | reuse the PERSONAL band parser — the pipeline already supports it |
| A8 | SMOQUA is a separate legal entity from DILIGAF | if it's a DILIGAF activity, dimensions may belong on DILIGAF rather than a separate book |
| A9 | Serbian fiscal receipts in your wallet carry a scannable QR | the S-QR spike answers this immediately; layer 2 (OCR + regex) becomes primary |

---

## Short version — what's left

1. **Q17** — IMAP/SMTP host + credentials → unblocks M2 and M4
2. **F10** — one fiscal receipt QR payload string (one scan) → unblocks the spike that decides how much ML E needs at all
3. **F4 + F7** — a few receipt photos; send E one photo once webhook logging is on → unblocks M1
4. **Q18** — the export exemption note string, from your accountant → unblocks M3's international path
5. **Q9/Q10** — a glance at the category and dimension lists; with rules-only categorization, your seed list *is* month one's accuracy
6. **F1/F2** — statements when you have them

Everything else has a default and I'll proceed on it.
