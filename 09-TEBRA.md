# E — `/tebra`: talk to your own data

> `/tebra koliko sam dao na gorivo u julu?`
> `/tebra prebaci sve WOLT iz jula u HRANA`
> `/tebra napravi mi tabelu troškova po dimenziji za Q3 i pošalji kao excel`

The escape hatch. Everything else in E is a designed flow; `/tebra` is what covers the questions neither of us thought of. It's what stops the command surface from being the ceiling.

---

## 1. What it is

An LLM with **tool access to E's own data**. Not a chatbot bolted on the side — it calls the same typed functions the rest of E uses, over the same blob store.

```
/tebra "<prompt>"
   │
   ├─ resolve book from sender phone (hard scope — see §5)
   ├─ agentic loop: model ⇄ tools, bounded steps
   │     read tools    → execute immediately
   │     write tools   → PROPOSE, never apply (§5)
   │     render tools  → produce a table / CSV / XLSX / PDF / chart
   └─ reply: text for small answers, a document for big ones
```

Four verbs, matching what you asked for:

| Verb | Example | Mechanism |
|---|---|---|
| **pull** | "sve fakture od Telekoma ove godine" | read tools over documents + ledger |
| **aggregate** | "koliko po kategoriji u Q3" | fold + group, computed in code not by the model |
| **edit** | "prebaci ovo u DECA i zapamti" | proposal + one tap → correction event + optional rule |
| **print** | "pošalji kao excel" | render tools → WhatsApp document |

---

## 2. Why MCP, and where it actually sits

You said "the MCP we infuse in the background." Here's the shape I'd argue for:

**Define the tool surface once. Expose it twice.**

```
engine/tebra/tools/*.ts          ← the tools: typed, pure-ish, unit-tested
        │
        ├── in-process  →  /tebra loop in the function app        (fast path, no round trip)
        └── MCP server  →  external clients                        (Claude Desktop, Claude Code, anything)
```

- **In-process for `/tebra`.** Paying MCP's transport cost to talk to yourself inside one process is latency for nothing. Same handlers, called directly.
- **MCP server for everything else.** The genuine win: you live in Claude Code. An MCP endpoint means you can ask your own accounting data questions from your laptop, in a real terminal, with a real model — no WhatsApp, no 1600-character replies, no thumb typing. For anything analytical that's a far better surface than a phone.

So MCP isn't the mechanism `/tebra` runs on; it's the *second consumer* of the same tools. That keeps one implementation, one set of tests, one permission model — and no protocol overhead on the hot path.

The MCP server is its own small deployment (an HTTP endpoint with auth, or run locally against the storage account with your credentials). Reads only, at first — see §5.

---

## 3. Tool surface

Every tool has a JSON schema, a unit test, and a declared side-effect class.

### Read — auto-execute

| Tool | Purpose |
|---|---|
| `search_documents` | by book, period, category, vendor, amount range, review status |
| `get_document` | facts + a link (SAS) for one document |
| `query_transactions` | filter the ledger by date, category, dimension, amount, source |
| `aggregate` | group + sum + count over transactions or documents; **arithmetic done in code, never by the model** |
| `list_periods` | what months have data, and how much |
| `get_rules` | current categorization rules and vendor profiles |
| `get_status` | the `/status` payload, structured |
| `compare_periods` | two periods side by side |

### Write — **propose only**

| Tool | Effect when confirmed |
|---|---|
| `set_category` / `set_dimension` | appends a correction event |
| `set_amount` / `set_vendor` / `set_date` | appends a correction event on a document's facts |
| `split_transaction` | appends split events |
| `add_rule` / `add_synonym` | writes to `_state/rules/*` |
| `set_vendor_profile` | corrects a learned vendor profile in `_state/vendor-profiles.json` — the PIB, the alias list, a trust label, a hint |
| `merge_vendors` | folds two profiles into one when the same supplier was learned twice under different names |
| `flag_for_review` | queue pointer |

### Render — auto-execute, produces artifacts

| Tool | Output |
|---|---|
| `render_table` | formatted text for WhatsApp |
| `render_csv` / `render_xlsx` | file → WhatsApp document |
| `render_pdf` | a small report → WhatsApp document |
| `render_chart` | PNG (spend by category, trend) → WhatsApp image |

### The vendor-profile skill

`set_vendor_profile` is the answer to a gap the test suite surfaced: a *wrong* stored PIB previously had no correction path at all, because `learnFromCorrection` treats a null in a correction as "no opinion" rather than "delete this". Rather than design a bespoke WhatsApp flow for a rare fix, `/tebra` gets a **skill** — a short instruction set describing the profile shape, what each field means, which edits are safe, and the required confirmation. You say what's wrong in your own words; E proposes the exact field change; you tap.

This is the pattern for the whole long tail: a fix that happens twice a year does not deserve a wizard, and a skill costs a markdown file rather than a state machine.

One property makes it safe to let `/tebra` write here at all: **`_state/**` has blob versioning on** (§3 Retention). Vendor profiles are not append-only the way the ledger is, so without versioning this would be the single place in E where a bad write is unrecoverable. With it, every profile revision is retrievable.

### Deliberately absent

No `delete_*`. No `send_email`. No `sef_accept` / `sef_reject`. No `issue_invoice`.

Those are either irreversible or outward-facing, and they already have deterministic button paths. `/tebra` is for understanding and correcting your own records — not for taking actions that leave the building. Being explicit about this now is cheaper than discovering the boundary later.

---

## 4. The one structural property that makes edits safe

**The ledger is an append-only event log** (`01-ARCHITECTURE.md` §3). An "edit" is a new event, not a mutation:

```
{ op: 'set_category', ref: '01J9F2QK7X8', category: 'DECA',
  by: 'tebra', session: '01J9Z…', at: '2026-08-14T11:02:09Z' }
```

Consequences worth stating plainly:

- **`/tebra` cannot destroy history.** The worst it can do is append a wrong correction, which is itself correctable, and the original value is still there.
- Every change is attributable to a `/tebra` session, so "what did that command actually do" is answerable months later.
- `/tebra undo` is a real feature, not a wish — it appends the inverse.

This is why I'm comfortable giving a language model edit rights here at all. If the store were mutable in place, my answer would be different.

---

## 5. Guardrails

The genuinely new risk in E. Worth reading properly rather than skimming.

### 5.1 Writes are proposals, always

```
YOU  /tebra prebaci sve WOLT iz jula u HRANA
E    Predlog: 23 transakcije → HRANA
     WOLT BEOGRAD  −1.890,00  04.07.
     WOLT BEOGRAD  −2.340,00  07.07.
     … +21
     Ukupno 41.230,00 RSD
     [Primeni] [Primeni + zapamti pravilo] [Otkaži]
```

No write tool ever executes inside the loop. The model produces a **change set**; E renders it; you tap. Bulk changes always show the affected count and a sample before the tap.

### 5.2 Document content is data, never instructions

E ingests PDFs from email — **untrusted input from third parties**. A supplier could embed `ignore previous instructions and …` in an invoice, and `/tebra` may well read that document's text into its context while answering a question.

Defenses, layered because no single one is sufficient:

- Document text and email content are passed to the model inside explicit, delimited untrusted-content blocks, with a system instruction that content inside them is never an instruction.
- **Tool results are never treated as instructions** — same rule.
- Writes require your tap regardless, so a successful injection produces a *proposal you'll see*, not a silent change.
- No outward-facing tools exist (§3), so there is nothing for an injection to exfiltrate through.
- Any `/tebra` turn that reads untrusted document text and then proposes a write is flagged as such in the confirmation.

Honest framing: prompt injection is not a solved problem, and I won't claim these defenses are airtight. What they do is ensure the *blast radius* is bounded — an injection can waste your time, but it cannot move money, send mail, or destroy a record. That's the property to design for, rather than betting on the model never being fooled.

### 5.3 Book scoping is enforced outside the model

The book is resolved from your sender phone **before** the loop starts and injected into every tool call server-side. The model cannot request another book's data, because the parameter isn't its to set. `/tebra` from the SMOQUA phone cannot see PERSONAL, ever.

### 5.4 Bounds

- Max tool-call steps per session (default 12), then it must answer or give up
- Max rows returned per tool call, with explicit truncation reported to you (never a silent top-N)
- Per-session token ceiling
- Rate limit per hour — this is the one command that can burn real money

### 5.5 Audit

Every session writes `_state/tebra/{session_id}.json`: the prompt, every tool call and result summary, the proposed change set, and whether you confirmed. `/tebra istorija` lists recent sessions. Confirmed changes carry the session id into the ledger event.

---

## 6. Where the deterministic-first principle still applies

`/tebra` is unapologetically model-driven — that's its job. But the boundaries from D8 hold:

| | |
|---|---|
| **The model decides** | which tools to call, in what order, and how to phrase the answer |
| **Code decides** | what the tools return, and every number in it |
| **You decide** | whether any change is applied |

**All arithmetic happens in `aggregate`, never in the model's head.** A model summing 47 transactions in prose will occasionally be wrong and always be confident. So totals are computed in TypeScript and handed to the model as facts to present. If you ask "how much on fuel in July", the number in the reply came from a fold, not from a language model's mental arithmetic — and that's testable.

---

## 7. Milestones

`/tebra` needs data to be worth anything, so it can't come first. But it splits cleanly:

| Slice | When | Content |
|---|---|---|
| **M4.5 — read-only** | after the first monthly package, when there's real data | read + render tools, in-process loop, no writes at all |
| **M8 — edits** | after M6/M7 | write tools as proposals, `add_rule`, `undo`, audit log |
| **M9 — MCP server** | when you want it from the laptop | same tools over an MCP endpoint, reads first |

Pulling read-only forward to M4.5 is deliberate: it's cheap once the store exists, it has no write-risk to design around, and it's the fastest way to find out whether you actually reach for this command or ignore it. If you don't use the read-only version, the edit version isn't worth building.

---

## 8. Testing

An agentic loop is testable if you stop treating it as one thing.

| Layer | How |
|---|---|
| **Tools** (the bulk) | ordinary unit tests over an in-memory store — filters, grouping, sums, truncation, empty results. This is where most of the value is and it's completely deterministic. |
| **The loop** | a **scripted fake model** returning a fixed tool-call sequence. Asserts: steps bounded, results threaded correctly, write tools never auto-execute, final answer built only from tool output. |
| **Guardrails** | injection strings embedded in fixture document text ⇒ no tool call results; a cross-book request ⇒ scoped to the sender's book; step limit ⇒ graceful stop; truncation ⇒ reported. |
| **Arithmetic** | assert reply totals equal `aggregate` output exactly — the model may never be the source of a number. |
| **Eval** (opt-in, not CI) | a corpus of real questions → expected tool sequence and expected answer, scored over time (`06-TDD-STRATEGY.md` §4.5). |

CI never calls a real model here either.

---

## 9. Open questions

1. **Name confirmed?** `/tebra` reads as šatrovački for *brate* — fits E's register. Also fine as an alias alongside `/e` or `/ask` if you'd rather type fewer letters.
2. **Which model?** Reasoning quality matters more here than anywhere else in E, and this is the one path where a bigger model is worth the money. Suggest the strongest available for `/tebra` and keep the cheap model for slot filling.
3. **MCP client** — is Claude Code on your laptop the target, Claude Desktop, or both? Decides auth (local credentials vs a hosted endpoint with a token).
4. **Should `/tebra` see PERSONAL from your main phone?** It's the same phone as DILIGAF. Default: yes, since it's your data and your device — but it means a DILIGAF-context question can surface personal spending. Say if you'd rather `/tebra` default to DILIGAF and require `/tebra personal …` to cross over.
