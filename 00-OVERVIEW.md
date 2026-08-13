# E — the assistant that does the admin so you don't notice it

> Eric from Entourage. Vinnie's right hand. Handles the life, never makes it a thing.

## What E is

A single-user WhatsApp-first admin robot for **one human (you)** covering **three books**:

| Book | Entity | What E does |
|---|---|---|
| `DILIGAF` | DILIGAF DOO | collect izvodi, collect expense docs, issue invoices, handle SEF inbound, ship a monthly package to the accountant |
| `PERSONAL` | you | parse the monthly bank statement into categorized transactions, absorb cash spend |
| `SMOQUA` | SMOQUA shop | collect expense docs + cash spend, tagged with a financial dimension (MATERIALS, MARKETING, …) |

## Why E exists before 1IA

1IA is a multi-tenant SaaS bet. E is the **cheap proof** that WhatsApp is a viable interface for this class of software, run on the only user whose patience is guaranteed. If `/expense` + a photo feels good on a Tuesday morning at a gas station, 1IA is worth building. If it doesn't, we learned that for the price of a few weekends instead of a product.

E is therefore explicitly allowed to be:
- single-user (no onboarding, no setup page, no tenant provisioning)
- opinionated (your banks, your accountant, your categories)
- narrow (no bookkeeping, no payroll, no financial statements)

E is explicitly **not** allowed to be:
- untested (see `06-TDD-STRATEGY.md` — no line of production code before a failing test)
- a data roach motel (every document is retrievable, indexed, and re-exportable)

## The one-sentence goal

**Monthly admin drops from "a despised pile" to "confirm a WhatsApp button on the 1st."**

## Success criteria (how we know E worked)

| # | Criterion | Measured how |
|---|---|---|
| S1 | Zero manual file handling for DILIGAF izvodi | count of izvodi in blob == count of statement emails received |
| S2 | Expense capture takes < 15 seconds | you, holding a receipt, at the register |
| S3 | Accountant package sent on the 1st with one tap | notification log shows one `monthly_package` event/month |
| S4 | SEF invoices never sit unactioned > 24h | daily digest + `actioned_at - created_at` |
| S5 | Personal statement lands ≥ 85% auto-categorized | `MISC` share of parsed transactions |
| S6 | Extraction shifts toward the cheap rungs over time | share resolved by cache / QR / vendor profile vs model, in `/status` |
| S7 | You stop dreading the 1st | self-report, the only metric that matters |

## Relationship to the existing code

E is a **fork of `1ia-mvp01`, not a branch of it.** Recommended: new repo `E/e-app`.

Reasoning: 1IA's complexity is multi-tenancy (setup app, setup tokens, tenant provisioning, APR company lookup, paušalac limits, KEP book, RFZO). None of that applies to E, and carrying it forward means every test needs a tenant fixture for a system with exactly one user. Forking lets us delete ~60% of the surface and keep the parts that are genuinely proven.

**Harvested from 1IA (proven, near copy/paste):**

| From | Reuse |
|---|---|
| `lib/sef-client.ts` | whole file — pending list, details, accept/decline, PDF, XML. Confirmed working. |
| `lib/whatsapp-sender.ts` | text/buttons/list/document-from-buffer + the Graph media upload dance |
| `lib/voice-handler.ts` | media-ID → URL → bytes, **and** the Whisper transcription (voice is back — D11) |
| `lib/pdf-generator.ts` | invoice PDF template + Serbian number/date formatting |
| `lib/gpt-router.ts` | the structured-output pattern (schema + low temperature + validation), retargeted at slot filling rather than intent |
| `lib/nbs-rates.ts` | EUR→RSD conversion for reporting |
| `lib/button-router.ts` | the `action:id` button-ID convention (accept/reject/details/pdf) |
| `functions/whatsapp-webhook.ts` | webhook shape, dedup-by-message-id, always-200-to-Meta |

**Deliberately dropped:** setup-app, setup_tokens, tenants/multi-tenancy, APR client, RFZO checker, paušalac limits, KEP book (a paušalac register; DILIGAF is a DOO), `db.ts` and all SQL (D2 — no database), and the SEF **sales**-invoice XML builder (D10 — purchase-invoice functions are kept).

**Rebuilt, not copied:** everything gets restructured into `core/` (pure, tested) and `adapters/` (I/O, faked in tests). The current code calls `supabase` and `fetch` at module scope and reads `process.env` at import time — that is untestable, and E is a TDD project. See `01-ARCHITECTURE.md`.

## Decisions already made (no need to discuss unless you disagree)

| D | Decision | Why |
|---|---|---|
| D1 | One WhatsApp number for E; **books identified by your sender phone** | free, instant; a second WABA number costs money and setup for zero extra capability |
| D2 | **Blob Storage is the only store — no database** | at one user, blob's `If-None-Match` create-if-absent and ETag CAS cover dedupe, idempotency and safe state updates; the path *is* the index. Drops a service, a connection string, RLS, migrations, and Postgres from CI. Your call, and it was the right one. |
| D3 | Inbound email via **IMAP poll**, successful mail **moved to `E/Processed`** | no Graph or Power Automate connector exists for iCloud/self-hosted; folder moves make idempotency structural and give you an audit trail in your own mail client |
| D4 | Outbound accountant email via **direct SMTP** (`nodemailer`) from your own address | simplest possible path, familiar sender, nothing to warm up or pay for |
| D5 | Invoice PDF stays **pdfkit**, not HTML→Chromium | pdfkit already produces your invoice today; headless Chromium in Azure Functions is a deployment tax for a template with 4 variable fields |
| D6 | Monthly package covers the **previous** month, sent on the 1st, **after you tap confirm** | an auto-send on the 1st mails a half-month if anything arrived late |
| D7 | SEF inbound is **polled** on a Function timer (30 min), digest daily | a Logic App adds a deploy artifact for a run history App Insights already gives; polling is indistinguishable from push at your volume |
| D8 | **Hybrid: the model proposes, the code decides.** Deterministic layers run first and win; AI handles genuinely unstructured input. | pure-deterministic broke on 90 supplier layouts, `300 EVRA`, and mixed-basket categorization. Safety comes from *how* model output is handled, not from excluding it: structured output only, same validators as every other layer, cached by content hash (so it's reproducible), provenance recorded, and confirmation required when confidence is low. `01-ARCHITECTURE.md` §5. |
| D9 | Proactive WhatsApp messages go out as **approved templates**, unconditionally | Meta rejects free-form business-initiated messages outside the 24h window (`131047`) regardless of what schedules them. Not branching on window state — you can't reliably know it. |
| D10 | **No SEF sales-invoice submission in v1** | you don't issue from the app yet. E generates the PDF and archives it; SEF submission stays where it is today. |
| D11 | **Deterministic routing, AI interpretation.** Attachment / button-id / slash-command resolve without a model; free text gets deterministic slots first, then model slot-fill, then commit-or-confirm. | SEF and commands don't need AI. `MATERIJAAL PAMUK 200E Projekat 1` does. The model fills slots, never picks the branch, and never overwrites a deterministically parsed amount. Voice is back on the same pipeline. `02-WHATSAPP-INTERFACE.md` §5.1. |
| D14 | **Dimensions are typed axes, not one field** | `category` (closed set, fuzzy-matched), `project` (open text), and whatever you add next — declared in `books.json`, so a new axis is a config edit rather than a migration. This is what "grows with the company" has to mean concretely. |
| D15 | **Vendor profiles: correct a layout once, it's deterministic after that** | the answer to 90 invoice layouts. Each correction stores what E learned about that vendor, so the second document from them skips the model. The system converges toward the cheap rungs instead of living on the expensive one. |
| D17 | **`/tebra "<prompt>"` — agentic NL over E's own data** | the escape hatch, so the command surface isn't the ceiling. Pull / aggregate / edit / print. Tool surface defined once, exposed in-process to `/tebra` and over **MCP** to external clients (Claude Code on your laptop), so there's one implementation and one permission model. `09-TEBRA.md`. |
| D18 | **`/tebra` reads auto-execute; writes are proposals requiring a tap** | and there are no destructive or outward-facing tools at all — no delete, no email, no SEF accept. The append-only ledger means an edit is a correction event, so `/tebra` cannot destroy history and `undo` is real. That property is *why* a model gets edit rights here. |
| D19 | **All `/tebra` arithmetic happens in code, never in the model** | a model summing 47 transactions will occasionally be wrong and always be confident. Totals come from `aggregate`; the model only presents them — and that's testable. |
| D16 | **Categorization uses line items, not vendors** | the same shop sells you food, a gift, and something for the kids. E also auto-detects which of *your* vendors are ambiguous (categorized more than one way) and stops guessing for those. Splits are supported, because a mixed basket otherwise forces a lie. |
| D12 | **You own invoice numbers. E suggests, never allocates.** | your scheme is per-customer; E increments the trailing digits of that customer's last number and you confirm. Number stored as text, no sequence, no counter — so there's nothing for E to make gappy. Duplicate use gets a warning, not a block. |
| D13 | **VAT derived from the customer**: `RS` → 20%, foreign business → no VAT | it's a property of who you invoice, not a per-invoice choice, so E never asks. Export renders an exemption note, **not** a `PDV 0,00` line — a different document to a tax inspector. Currency stays independent of VAT. |

## Open questions that change the work

Full list in `08-OPEN-QUESTIONS.md`. PDV treatment, mail transport, passwords, and number ownership are all settled. What's left:

1. **IMAP host and credentials** — assumed IMAP (your call), host/user/app-password still needed to configure and test M2.
2. **The export exemption note text** — the exact wording and legal citation your international invoices should carry. One string from your accountant; E prints it verbatim.
3. **Real fixtures** (`06-TDD-STRATEGY.md` §6) — you're gathering these. The statement and fiscal-receipt parsers can't be written against imagined layouts.

## Document map

| File | Contents |
|---|---|
| `00-OVERVIEW.md` | this |
| `01-ARCHITECTURE.md` | components, data model, blob layout, security, project structure |
| `02-WHATSAPP-INTERFACE.md` | command grammar, message handling, every conversation flow |
| `03-DILIGAF.md` | izvodi, expenses, invoicing, SEF, monthly accountant package |
| `04-PERSONAL.md` | statement parsing, categorization, cash, the bank-switch flag |
| `05-SMOQUA.md` | shop expenses and financial dimensions |
| `06-TDD-STRATEGY.md` | the test contract — read before writing any code |
| `07-ROADMAP.md` | milestones, test-first task lists, acceptance criteria |
| `08-OPEN-QUESTIONS.md` | what E needs from you |
