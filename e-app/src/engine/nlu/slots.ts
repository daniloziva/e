import type { Money, DimensionAxisDef } from '../types.js'
import { parseAmount } from '../money.js'
import { fuzzyMatch, normalize, resolveCurrency } from './synonyms.js'

export interface Slots {
  money: Money | null
  dimensions: Record<string, string>
  description: string | null
  date: string | null
}

export interface SlotExtraction {
  slots: Slots
  /** tokens no deterministic rule claimed — these are what the model is asked about */
  leftoverTokens: string[]
}

// ---------------------------------------------------------------------------
// The deterministic first pass. 02-WHATSAPP-INTERFACE §5.1 rows 1-2.
//
// Three claims are made over the token stream, in this order: date, amount,
// dimension. Every claim is all-or-nothing — a rule that cannot decide between
// two readings claims NOTHING and leaves the tokens for the model, rather than
// picking one. Whatever this function does claim is authoritative and no model
// may overwrite it, which is exactly why it may never half-guess.
//
// Every rule here is a function of the multiset of tokens, never of their
// order, because 02 §5.1 names order-tolerance explicitly: "300e MATERIALS"
// and "MATERIALS 300e" must produce byte-identical output.
// ---------------------------------------------------------------------------

/** Attached punctuation is noise, so it is stripped from both ends of a token. */
const EDGE_PUNCTUATION = /^[.,;:!?()[\]{}"'«»…]+|[.,;:!?()[\]{}"'«»…]+$/g

interface Token {
  /** the token as the sender wrote it, minus attached punctuation */
  text: string
  claimed: boolean
}

function tokenize(text: string): Token[] {
  if (typeof text !== 'string') return []
  const tokens: Token[] = []
  for (const raw of text.split(/\s+/)) {
    const trimmed = raw.replace(EDGE_PUNCTUATION, '')
    if (trimmed === '') continue
    tokens.push({ text: trimmed, claimed: false })
  }
  return tokens
}

// ── dates ──────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * A calendar check done in arithmetic, never through `Date`. Constructing a
 * Date here would both read the ambient time zone and silently roll 31.02 over
 * into March — the two failure modes this module is required not to have.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  const base = DAYS_IN_MONTH[month - 1]
  if (base === undefined) return false
  const limit = month === 2 && isLeapYear(year) ? 29 : base
  return day >= 1 && day <= limit
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** true for a strictly formatted, real YYYY-MM-DD. Shared with interpret.ts. */
export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * Read one token as an ISO date. Accepts the Serbian dd.mm.yyyy form and the
 * ISO form. A day-and-month with no year has no reading here: core is given no
 * Clock, so "the current year" is not a fact this module has access to.
 */
function readDate(token: string): string | null {
  if (isIsoDate(token)) return token

  const serbian = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(token)
  if (serbian === null) return null
  const day = Number(serbian[1])
  const month = Number(serbian[2])
  const year = Number(serbian[3])
  if (!isRealDate(year, month, day)) return null
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/**
 * Claim the date. Two tokens naming two different days is a question, not a
 * date, so nothing is claimed; two tokens naming the same day are one fact.
 */
function claimDate(tokens: Token[]): string | null {
  const hits: number[] = []
  const values = new Set<string>()
  tokens.forEach((token, index) => {
    const iso = readDate(token.text)
    if (iso === null) return
    hits.push(index)
    values.add(iso)
  })

  if (values.size !== 1) return null
  for (const index of hits) {
    const token = tokens[index]
    if (token !== undefined) token.claimed = true
  }
  const [only] = [...values]
  return only ?? null
}

// ── amounts ────────────────────────────────────────────────────────────────

interface AmountReading {
  money: Money
  /** true when the text itself named the currency, false when RSD was assumed */
  marked: boolean
}

/**
 * Read a fragment as an amount, delegating the whole grammar to money.ts.
 *
 * The two probes are how this asks money.ts a question its signature does not
 * expose: whether the currency came from the text or from the default. Parsing
 * twice under two different defaults answers it — the readings agree only when
 * the fragment carries its own marker. Re-deriving the marker with a second
 * regex here is what would actually be fragile: the grammar would then live in
 * two places and could drift.
 */
function readAmount(fragment: string): AmountReading | null {
  const asUsd = parseAmount(fragment, 'USD')
  const asChf = parseAmount(fragment, 'CHF')
  if (asUsd === null || asChf === null) return null

  const marked = asUsd.currency === asChf.currency
  return {
    money: { amount: asUsd.amount, currency: marked ? asUsd.currency : 'RSD' },
    marked,
  }
}

interface Candidate {
  money: Money
  marked: boolean
  indices: number[]
}

function collectCandidates(tokens: Token[]): Candidate[] {
  const candidates: Candidate[] = []
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === undefined || token.claimed) continue

    const single = readAmount(token.text)
    if (single === null) continue

    // A bare number may still be spelled over two tokens — "300 EVRA",
    // "1.500 rsd". The pair is offered to the same grammar; it accepts only
    // when the second token really is the unit of the first.
    if (!single.marked) {
      const next = tokens[index]
      if (next !== undefined && !next.claimed) {
        const pair = readAmount(`${token.text} ${next.text}`)
        if (pair !== null && pair.marked) {
          candidates.push({ money: pair.money, marked: true, indices: [index - 1, index] })
          index += 1
          continue
        }
      }
    }

    candidates.push({ money: single.money, marked: single.marked, indices: [index - 1] })
  }

  return candidates
}

/**
 * Claim the amount, under money.ts's own multi-candidate rule: a written
 * currency outranks a bare number, and two of either is a question. The losing
 * tokens stay unclaimed so the caller can ask which one was meant.
 */
function claimMoney(tokens: Token[]): Money | null {
  const candidates = collectCandidates(tokens)
  const claimedByCandidate = new Set(candidates.flatMap((c) => c.indices))

  // A currency word no number claimed leaves the currency of the whole message
  // in doubt, so there is no confident amount to return (money.ts, same rule).
  const hangingCurrency = tokens.some(
    (token, index) =>
      !token.claimed && !claimedByCandidate.has(index) && resolveCurrency(token.text) !== null,
  )
  if (hangingCurrency) return null

  const marked = candidates.filter((c) => c.marked)
  const winners = marked.length > 0 ? marked : candidates
  if (winners.length !== 1) return null

  const winner = winners[0]
  if (winner === undefined) return null
  for (const index of winner.indices) {
    const token = tokens[index]
    if (token !== undefined) token.claimed = true
  }
  return winner.money
}

// ── dimensions ─────────────────────────────────────────────────────────────

/** Keys that would reach up the prototype chain are never axis names. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * The fuzzy budget, relative to the length of the token.
 *
 * `fuzzyMatch`'s own default of 2 is ABSOLUTE, so on a four-letter word it
 * licenses replacing half the token — "juce" (yesterday) would land on the
 * alias "PIĆE" at distance 2 and be booked as DRINKS. A short word therefore
 * gets a proportionally shorter budget: exact-or-alias only below three
 * characters, one edit up to five, the full two from six.
 */
function editBudget(normalized: string): number {
  return Math.min(2, Math.floor(normalized.length / 3))
}

function matchAxis(token: string, values: string[], aliases?: Record<string, string[]>): string | null {
  const normalized = normalize(token)
  if (normalized === '') return null
  return fuzzyMatch(token, values, aliases, editBudget(normalized))
}

/**
 * Resolve every closed_set axis the book declares. An open_text axis is never
 * filled here — 02 §5.1 step 3 hands its words to the model on purpose.
 *
 * Two tokens resolving to two different values on the same axis is a question,
 * so the axis stays empty and both words go to the model. Deciding it by
 * position would make the result depend on word order, which §5.1 forbids.
 */
function claimDimensions(tokens: Token[], axes: DimensionAxisDef[]): Record<string, string> {
  const dimensions: Record<string, string> = {}

  for (const axis of axes) {
    if (axis.type !== 'closed_set') continue
    if (UNSAFE_KEYS.has(axis.axis)) continue
    const values = axis.values ?? []
    if (values.length === 0) continue

    const hits: number[] = []
    const resolved = new Set<string>()
    tokens.forEach((token, index) => {
      if (token.claimed) return
      const value = matchAxis(token.text, values, axis.aliases)
      if (value === null) return
      hits.push(index)
      resolved.add(value)
    })

    if (resolved.size !== 1) continue
    const [only] = [...resolved]
    if (only === undefined) continue

    for (const index of hits) {
      const token = tokens[index]
      if (token !== undefined) token.claimed = true
    }
    dimensions[axis.axis] = only
  }

  return dimensions
}

/**
 * Deterministic first pass over free text. Order-tolerant: "300e MATERIALS" and
 * "MATERIALS 300e" produce identical output. Whatever this returns is AUTHORITATIVE
 * and a model may not overwrite it (02 §5.1).
 */
export function extractSlots(text: string, axes: DimensionAxisDef[]): SlotExtraction {
  const tokens = tokenize(text)

  // Dates first: a dotted date must never be offered to the money grammar as a
  // Serbian-grouped number. Then the amount, then the dimensions — each pass
  // sees only what the previous ones left.
  const date = claimDate(tokens)
  const money = claimMoney(tokens)
  const dimensions = claimDimensions(tokens, Array.isArray(axes) ? axes : [])

  return {
    // A description is never claimed deterministically: deciding which leftover
    // words describe the expense is the one job the model is actually for.
    slots: { money, dimensions, description: null, date },
    leftoverTokens: tokens.filter((token) => !token.claimed).map((token) => token.text),
  }
}
