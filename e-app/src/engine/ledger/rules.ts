import { normalizeDescription } from './normalize.js'

export interface CategorizationRule {
  id: string
  book: string
  matchType: 'contains' | 'regex' | 'exact'
  pattern: string
  /** optional extra conditions — a rule may be vendor + item + amount band */
  itemPattern?: string | null
  amountMin?: number | null
  amountMax?: number | null
  category: string
  dimensions?: Record<string, string>
  priority: number
  hitCount: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// Every value here arrives from `_state` JSON — a rule is persisted data, not a
// literal in the source. So the declared types are treated as claims, not
// facts: a `pattern` that is really the NUMBER 4738 must not reach
// `RegExp.test()`, which coerces its argument and would let it through a
// string-only rule. That defect has already shipped once in this codebase
// (see the note at the top of `normalize.ts`); the `typeof` guards below exist
// for exactly that reason and are not decoration.
// ---------------------------------------------------------------------------

/** A string, or '' when the value is not a string. Never `String(x)`. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A finite number, or null. `null`, `undefined`, NaN and non-numbers all mean "no constraint". */
function asBound(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** An ordering key that cannot be NaN — a non-numeric priority/hitCount sorts as 0. */
function asRank(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// ===========================================================================
// sortRules
// ===========================================================================

/**
 * How many conditions beyond the pattern a rule states. More conditions means
 * the rule was written about a narrower situation, so it should be consulted
 * first when priorities tie.
 *
 * The pattern itself is not counted: every rule has one, so it cannot separate
 * two rules. An empty `itemPattern` counts as absent — `ruleMatches` refuses to
 * match on one, so it constrains nothing and must not buy specificity.
 */
function specificity(rule: CategorizationRule): number {
  let score = 0
  if (asText(rule.itemPattern).trim() !== '') score += 1
  if (asBound(rule.amountMin) !== null) score += 1
  if (asBound(rule.amountMax) !== null) score += 1
  return score
}

/**
 * Highest priority first; ties broken by specificity, then by hitCount. Pure
 * ordering — a new array, the input untouched, and stable for rules that tie on
 * every key.
 *
 * Stability is achieved by carrying the original index as the final tie-break
 * rather than by trusting the engine's sort to be stable. `Array#sort` is
 * specified stable since ES2019 and V8 honours it, but the ordering of stored
 * rules decides which category a transaction gets, and that is not a place to
 * depend on a property nothing in this file asserts.
 *
 * Priority strictly outranks specificity, and specificity strictly outranks
 * hitCount: a bare high-priority rule beats a narrow low-priority one, and a
 * specific cold rule beats a bare popular one. hitCount is the weakest signal
 * because it measures habit, not fit.
 */
export function sortRules(rules: CategorizationRule[]): CategorizationRule[] {
  if (!Array.isArray(rules)) return []

  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const byPriority = asRank(b.rule.priority) - asRank(a.rule.priority)
      if (byPriority !== 0) return byPriority

      const bySpecificity = specificity(b.rule) - specificity(a.rule)
      if (bySpecificity !== 0) return bySpecificity

      const byHits = asRank(b.rule.hitCount) - asRank(a.rule.hitCount)
      if (byHits !== 0) return byHits

      return a.index - b.index
    })
    .map((entry) => entry.rule)
}

// ===========================================================================
// ruleMatches
// ===========================================================================

/**
 * The form a description is matched in.
 *
 * `normalizeDescription` — the same one `deriveRule` uses below, and the same
 * one the ledger keys transactions with. One normalizer over one history: a
 * second one written here would build a rule corpus that the first could never
 * match against. The consequence, which is deliberate, is that a rule matches
 * THROUGH the volatile parts of a descriptor — a `contains` rule for WOLT hits
 * `POS 4738 12.03.2026 WOLT BEOGRAD REF 887766`, and an `exact` rule for WOLT
 * hits `WOLT 12.03.2026`, because the terminal id, the date and the reference
 * are not part of what the bank is describing.
 *
 * UNDERDETERMINED: the frozen suite deliberately declines to settle this (see
 * MERGE RULING 3 in the test file — one draft assumed volatile stripping, one
 * assumed case/whitespace folding only). Both readings satisfy every frozen
 * case. This one is chosen because it is the only one that keeps `deriveRule`
 * and `ruleMatches` describing the same string.
 */
function matchableDescription(description: unknown): string {
  return normalizeDescription(asText(description))
}

/** True when `pattern` matches `text` under `matchType`. Both are already normalized. */
function textMatches(matchType: unknown, pattern: string, text: string): boolean {
  if (pattern === '' || text === '') return false

  if (matchType === 'regex') return regexMatches(pattern, text)
  if (matchType === 'exact') return text === pattern
  // 'contains' is the default: an unrecognised matchType is treated as the
  // narrowest of the three rather than as a wildcard, because failing to match
  // sends a transaction to the review queue while over-matching files it
  // silently under the wrong category.
  return text.includes(pattern)
}

/**
 * A regex rule, compiled defensively. A malformed pattern is a broken rule, and
 * a broken rule matches nothing — it never throws out of categorisation, and it
 * never falls back to a substring match, which would silently widen a rule its
 * author wrote to be narrow.
 *
 * No flags: the description and the pattern are both upper-cased before they
 * get here, so case-insensitivity is already handled, and `i` would additionally
 * change what a character class means.
 */
/**
 * Longest stored regex we will compile. Every hand-written rule is a merchant
 * fragment; nothing legitimate needs more.
 */
const MAX_PATTERN_LENGTH = 200

/**
 * A quantifier applied to a group that already contains one — `(a+)+`, `(A*)*`,
 * `((A*)*)*`. This is the shape that makes backtracking exponential.
 */
const NESTED_QUANTIFIER = /\([^()]*[*+][^()]*\)\s*[*+{]/

/**
 * Catastrophic backtracking is a denial of service on the reporting path, and
 * the attacker is the model: `09-TEBRA.md` §3 lets `/tebra` propose edits to
 * `_state`, and rules live there.
 *
 * MEASURED, on this machine, through this function:
 *
 *     pattern '(A+)+$'     (6 bytes)  vs 25 chars  ->      159 ms
 *     pattern '((A*)*)*C'  (9 bytes)  vs 25 chars  ->   64,261 ms
 *
 * Note what that rules OUT. Capping the INPUT length — the obvious mitigation,
 * and the one first written into UNFREEZE-LOG.md — buys nothing: 25 characters
 * is an ordinary Serbian card descriptor, and the pattern author controls the
 * exponent base rather than the input. Only bounding the PATTERN helps.
 *
 * Categorisation runs per transaction per rule, so one stored pattern like the
 * second is hours of CPU per fold, inside a Function that has a timeout — and
 * the monthly package then simply never arrives.
 *
 * Both guards refuse the rule (no match) rather than throwing: a malformed or
 * hostile rule must not take down the categorisation of every other transaction,
 * which is the same reasoning as the existing catch below.
 *
 * NOT closed here, deliberately: refusing `matchType: 'regex'` on *learned or
 * model-proposed* rules. `CategorizationRule` carries no provenance, so this
 * function cannot tell a proposed rule from a hand-written one. That check
 * belongs at the `_state` write boundary, which does not exist yet — recorded as
 * an M8 pre-condition in UNFREEZE-LOG.md (CANDIDATE-010).
 */
function regexMatches(pattern: string, text: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false
  if (NESTED_QUANTIFIER.test(pattern)) return false
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return false
  }
}

/**
 * Does this rule match? Vendor pattern, item pattern and amount band are
 * CONJUNCTIVE — every condition the rule states must hold at once. A rule that
 * states no item pattern ignores the line items entirely; a rule that states one
 * requires at least one line item to hit it, and therefore cannot match a
 * transaction with no line items at all.
 */
export function ruleMatches(
  rule: CategorizationRule,
  input: { description: string; items: string[]; amount: number },
): boolean {
  if (rule === null || typeof rule !== 'object') return false

  // The pattern is normalized the same way the description is, so that a rule
  // written as 'wolt' or ' WOLT ' is the same rule as 'WOLT'. A regex pattern is
  // NOT normalized: its punctuation is syntax (`^`, `$`, `|`), and flattening it
  // would rewrite the rule its author stated.
  const rawPattern = asText(rule.pattern)
  const pattern =
    rule.matchType === 'regex' ? rawPattern.trim().toUpperCase() : normalizeDescription(rawPattern)

  if (!textMatches(rule.matchType, pattern, matchableDescription(input.description))) return false

  if (!itemMatches(rule, input.items)) return false

  return amountInBand(rule, input.amount)
}

/**
 * The item condition. An item pattern is always a `contains` test, regardless of
 * the rule's `matchType`: `matchType` describes how to read a bank descriptor,
 * and a line item is a different kind of string — 'PAMPERS' is meant to hit
 * 'PAMPERS 4 MAXI', which an `exact` reading would refuse.
 *
 * UNDERDETERMINED: no frozen case pairs a non-`contains` matchType with an item
 * pattern. Chosen this way because the alternative makes an `exact` vendor rule
 * silently unable to carry an item condition.
 */
function itemMatches(rule: CategorizationRule, items: unknown): boolean {
  const itemPattern = normalizeDescription(asText(rule.itemPattern))
  if (itemPattern === '') return true // no item condition stated

  if (!Array.isArray(items)) return false
  return items.some((item) => matchableDescription(item).includes(itemPattern))
}

/**
 * The amount band, inclusive at both ends, compared against the MAGNITUDE.
 *
 * Magnitude because a band is written about the size of a charge, not its
 * direction: a rule for 500..2000 is about what a basket costs, and the ledger
 * stores an outflow as -1200. Comparing signed would make every outflow band
 * unwritable.
 *
 * A missing bound is one missing constraint, not a missing band: `amountMin`
 * alone is "at least this much", with no ceiling. A non-finite amount (NaN from
 * an unreadable statement line) satisfies no band, so a banded rule declines and
 * the transaction lands in the review queue.
 */
function amountInBand(rule: CategorizationRule, amount: unknown): boolean {
  const min = asBound(rule.amountMin)
  const max = asBound(rule.amountMax)
  if (min === null && max === null) return true

  if (typeof amount !== 'number' || !Number.isFinite(amount)) return false
  const magnitude = Math.abs(amount)

  if (min !== null && magnitude < min) return false
  if (max !== null && magnitude > max) return false
  return true
}

// ===========================================================================
// deriveRule — the learning loop (04 §3)
// ===========================================================================

/** Minimum characters that must survive stripping before a pattern is safe to store. */
const MIN_PATTERN_LENGTH = 2

/**
 * Derive a reusable rule from one user correction.
 *
 * The pattern is the stable part of the description: `normalizeDescription`
 * removes the dates, times, terminal ids, references and card masks, and then
 * every remaining token that carries a digit is dropped as well. That second
 * step is what separates a RULE from a ledger identity — `normalizeDescription`
 * deliberately keeps bare digit runs so that MAXI 011 and MAXI 022 stay two
 * distinct transactions, but a rule built from one visit must not be pinned to
 * the branch, the basket size or the invoice number that happened to be in that
 * one descriptor. A whole token is dropped rather than only its digits, so that
 * 'A1B' cannot be silently rewritten into a pattern 'AB' that nobody wrote.
 *
 * The id and the timestamp are the caller's: this module reads no clock and
 * generates no randomness, so the same correction derives the same rule forever.
 *
 * Returns null rather than writing an unsafe rule. Nothing stable left, a
 * single surviving character, or a category that is blank — each of those would
 * produce a rule that either matches everything or files it nowhere, and a bad
 * stored rule is worse than no rule because it keeps being applied.
 */
export function deriveRule(
  description: string,
  category: string,
  book: string,
  id: string,
  at: string,
): CategorizationRule | null {
  const trimmedCategory = asText(category).trim()
  if (trimmedCategory === '') return null

  const pattern = stablePattern(asText(description))
  if (pattern === null) return null

  return {
    id: asText(id),
    book: asText(book),
    // `contains`, never `exact`: the next charge from this merchant will carry a
    // different date and a different terminal id, and a rule that only fires on
    // a descriptor it has already seen has learned nothing.
    matchType: 'contains',
    pattern,
    // One example proves the merchant, and nothing else. Locking in the amount
    // of that one basket, or the items in it, would produce a rule that stops
    // matching the moment the user buys anything different.
    itemPattern: null,
    amountMin: null,
    amountMax: null,
    category: trimmedCategory,
    // The neutral rank the rest of the corpus is written at. A correction is
    // strong evidence, but nothing in the spec says a learned rule should
    // outrank a hand-written one, and quietly promoting it would let the
    // learning loop overrule a deliberate decision. UNDERDETERMINED — the frozen
    // suite only requires a number.
    priority: 100,
    hitCount: 0,
    createdAt: asText(at),
  }
}

/** The merchant-identifying remainder of a descriptor, or null when too little survives. */
function stablePattern(description: string): string | null {
  const normalized = normalizeDescription(description)
  if (normalized === '') return null

  const stable = normalized
    .split(' ')
    .filter((token) => token !== '' && !/\d/.test(token))
    .join(' ')

  if (stable.length < MIN_PATTERN_LENGTH) return null
  if (!/\p{L}/u.test(stable)) return null

  return stable
}
