import { round2 } from '../money.js'
import type { Transaction } from '../types.js'

export interface SplitPart { amount: number; category: string; description?: string }

export interface SplitValidation {
  valid: boolean
  /** difference between the parts' sum and the original amount, 2dp */
  difference: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// One document, several categorized amounts. 04-PERSONAL.md §3.
//
// A split re-files money that is already in the ledger; it never creates or
// destroys any. Both halves of that are enforced here: the parts must sum to
// the original to the hundredth, and every part must point the same way as the
// original. A positive part inside an outflow sums correctly and is still
// wrong — that is a refund, and a refund is its own transaction.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite `amount` off a value that only claims to be an object, else null. */
function readAmount(source: unknown, key = 'amount'): number | null {
  const value = isRecord(source) ? source[key] : undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * -0 is not 0 under Object.is, which is what `toBe` compares with, and a
 * difference of negative zero would read as a real discrepancy to a caller
 * formatting it. Every number leaving this module goes through here.
 */
function zero(value: number): number {
  return value === 0 ? 0 : value
}

/** Two amounts point the same way. Zero points nowhere and never matches. */
function sameSign(a: number, b: number): boolean {
  return (a > 0 && b > 0) || (a < 0 && b < 0)
}

/** Millionths: four more decimal places than money has, so the rounding is the only tolerance. */
const SCALE = 1e6
const SAFE = Number.MAX_SAFE_INTEGER / SCALE

/**
 * Addition over the decimals as WRITTEN, not over their binary expansions.
 *
 * Plain `-70 + -29.995 - -100` is 0.0049999999999954525, whose third decimal is
 * a 4 — so a residue of exactly half a hundredth would round DOWN to nothing
 * and a real discrepancy would be accepted. Summing in millionths first keeps
 * the residue at the 0.005 the statement actually wrote, and leaves the half-up
 * rule in round2() as the single place a boundary is decided.
 *
 * Beyond the safe integer range the scaling would itself be lossy, so past that
 * point plain addition is the more honest of two imperfect answers.
 */
function addExact(a: number, b: number): number {
  if (Math.abs(a) > SAFE || Math.abs(b) > SAFE) return a + b
  return (Math.round(a * SCALE) + Math.round(b * SCALE)) / SCALE
}

/**
 * Check a proposed split. `difference` is the parts' sum minus the original
 * amount, rounded to 2dp — positive when the parts fall short, negative when
 * they overshoot — and `valid` is exactly `errors.length === 0`.
 *
 * The tolerance is the rounding itself, and nothing wider: a residue that
 * disappears at two decimal places is IEEE-754 noise and is accepted, while a
 * residue that rounds to a whole hundredth is a real hundredth and is refused.
 */
export function validateSplit(tx: Transaction, parts: SplitPart[]): SplitValidation {
  const errors: string[] = []

  const amount = readAmount(tx)
  if (amount === null) {
    errors.push('the transaction has no usable amount to split')
  } else if (amount === 0) {
    errors.push('a zero-amount transaction cannot be split')
  }

  const list = Array.isArray(parts) ? parts : null
  if (list === null) {
    errors.push('the split carries no parts')
  } else if (list.length === 0) {
    errors.push('a split needs at least one part')
  }

  let sum = 0
  for (const part of list ?? []) {
    const partAmount = readAmount(part)

    // A part with no readable amount is dropped from the sum rather than
    // poisoning it: the reported difference stays a number the caller can show,
    // and the error below is what makes the split invalid.
    if (partAmount === null) {
      errors.push('a part amount is not a finite number')
      continue
    }
    if (partAmount === 0) {
      errors.push('a part amount of zero has no sign to share with the transaction')
      continue
    }

    sum = addExact(sum, partAmount)

    if (amount !== null && amount !== 0 && !sameSign(partAmount, amount)) {
      errors.push('a part points the opposite way to the transaction; a refund is not a split')
    }

    const category = isRecord(part) ? part['category'] : undefined
    if (typeof category !== 'string' || category.trim() === '') {
      errors.push('every part needs a category; an uncategorized part is not a split')
    }
  }

  const difference = zero(round2(addExact(sum, -(amount ?? 0))))
  if (difference !== 0) {
    errors.push(`the parts differ from the transaction amount by ${difference}`)
  }

  return { valid: errors.length === 0, difference, errors }
}

/**
 * A split suggested from a document's line items — one part per distinct
 * category, aggregating the items filed under it.
 *
 * Every refusal below is the point of the function. It suggests only when the
 * items themselves prove the split: they must all be categorized, all be
 * priced, disagree about the category, and add up to the transaction exactly.
 * A missing line total is not apportioned across the rest and an uncategorized
 * item is not filed under a guess — either one means the document was only
 * partly read, and a suggestion built on that would be a plausible wrong answer
 * presented as an extracted fact.
 */
export function suggestSplit(
  tx: Transaction,
  items: Array<{ description: string; lineTotal: number | null; category: string | null }>,
): SplitPart[] | null {
  const amount = readAmount(tx)
  if (amount === null || amount === 0) return null

  if (!Array.isArray(items)) return null
  // One item cannot disagree with itself, so it cannot evidence a split.
  if (items.length < 2) return null

  const sign = amount < 0 ? -1 : 1
  // A Map, not an object: the category comes from an extracted document, and a
  // caller-supplied string may never key a plain object here.
  const totals = new Map<string, number>()
  let gross = 0

  for (const item of items) {
    const lineTotal = readAmount(item, 'lineTotal')
    if (lineTotal === null) return null

    const rawCategory = isRecord(item) ? item['category'] : undefined
    if (typeof rawCategory !== 'string') return null
    const category = rawCategory.trim()
    if (category === '') return null

    // The transaction's sign governs, not the line's: a receipt lists positive
    // prices for what is, in the ledger, money going out.
    const magnitude = Math.abs(lineTotal)
    gross = round2(gross + magnitude)
    totals.set(category, round2((totals.get(category) ?? 0) + magnitude))
  }

  if (totals.size < 2) return null
  if (gross !== Math.abs(round2(amount))) return null

  const parts: SplitPart[] = [...totals].map(([category, total]) => ({
    amount: zero(round2(sign * total)),
    category,
  }))

  // The suggestion is only offered if this module's own validator would accept
  // it, so a caller can fold it without re-deriving the arithmetic.
  return validateSplit(tx, parts).valid ? parts : null
}
