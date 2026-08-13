# E

WhatsApp admin assistant for one human, three books: **DILIGAF DOO**, **PERSONAL**, **SMOQUA**.

Named after Eric from Entourage — handles the life, never makes it a thing.

**Status: planning (docs v4). No code written. Nothing is approved yet.**

Shape as of v4:

- **Blob Storage only — no database.** Mail in/out over **IMAP/SMTP**, no Power Automate. Azure Functions timers, no Logic Apps.
- **Hybrid AI: the model proposes, the code decides.** Deterministic layers run first and win; AI handles genuinely unstructured input (arbitrary invoice layouts, free-text messages, mixed-basket categorization). Structured output only, cached by content hash so it's reproducible, provenance on every fact, confirmation required when confidence is low.
- **Routing is always deterministic** — attachment / button-id / slash-command. The model fills slots, never picks the branch, and never overwrites a deterministically parsed amount.
- **The system converges.** Correct a vendor's layout once and it's deterministic thereafter; correct a category once and a rule is written. `/status` shows the mix moving toward the cheap rungs.
- **`/tebra "<prompt>"`** — an agentic escape hatch over your own data (pull / aggregate / edit / print). Reads run; writes are proposals you tap. Same tools exposed over **MCP** so you can query E from Claude Code.
- **Invoices:** you own the numbering, VAT derived from the customer (20% domestic, none export), PDF only, no SEF submission yet.

## Read in this order

1. [`00-OVERVIEW.md`](00-OVERVIEW.md) — what E is, why before 1IA, decisions made
2. [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md) — components, data model, blob layout, security
3. [`02-WHATSAPP-INTERFACE.md`](02-WHATSAPP-INTERFACE.md) — commands and every conversation flow
4. [`03-DILIGAF.md`](03-DILIGAF.md) — izvodi, expenses, invoicing, SEF, accountant package
5. [`04-PERSONAL.md`](04-PERSONAL.md) — statement parsing, categorization, cash
6. [`05-SMOQUA.md`](05-SMOQUA.md) — shop expenses, financial dimensions
7. [`09-TEBRA.md`](09-TEBRA.md) — the `/tebra` NL command, its tools, and its guardrails
8. [`06-TDD-STRATEGY.md`](06-TDD-STRATEGY.md) — the test contract. read before any code.
9. [`07-ROADMAP.md`](07-ROADMAP.md) — milestones, test-first task lists
10. [`08-OPEN-QUESTIONS.md`](08-OPEN-QUESTIONS.md) — what E needs from you

## Ground rules

- Docs change before code changes.
- No code without per-milestone approval.
- No production line without a failing test first. CI never calls a model; a separate opt-in eval suite measures accuracy.
- **M1 is a decision point**: if WhatsApp expense capture doesn't feel good in the wild, the 1IA bet gets rethought rather than built.
