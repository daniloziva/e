import { round2 } from '../money.js'

// ---------------------------------------------------------------------------
// E — statement reconciliation guard. 04-PERSONAL.md §2.
//
//     opening + Σcredits − Σdebits ≈ closing        (default ±0.01)
//
// Pass → transactions commit as review_status='ok'.
// Fail → they commit as 'needs_review' and E announces the difference.
//
// This is the ONLY ground truth the deterministic statement parser has, which
// is what makes "regex and coordinate bands, no model fallback" safe rather
// than reckless. Both failure modes are expensive and the design below is
// pulled between them: a false PASS hides a parser bug for months, a false FAIL
// trains the owner to ignore the warning. Where the two conflict, this module
// prefers the loud answer — every uncertain or malformed input reports
// `balanced: false` rather than waving a statement through.
// ---------------------------------------------------------------------------

export interface StatementTotals {
  openingBalance: number
  closingBalance: number
  totalCredits: number
  totalDebits: number
}

export interface ReconcileResult {
  balanced: boolean
  expectedClosing: number
  difference: number // expectedClosing - closingBalance, rounded to 2dp
}

/** ±0.01 — the spec's tolerance, used when the argument is omitted or undefined. */
const DEFAULT_TOLERANCE = 0.01

// NOTE (UNFREEZE CANDIDATE-013, applied 2026-08-17): a `MAX_TOLERANCE = 100`
// constant used to sit here. It appeared in no spec and existed only to satisfy
// `reconcile.test.ts:337`, which asserted that a difference of 240 against a
// tolerance of 1000 was unbalanced — an arithmetic slip, since 1240 was the
// spec's *razlika* (difference) pasted into the closing-balance column. The row
// now reads `[1000, 2240, false]`, the rule is plain `|difference| <= tolerance`,
// and the ceiling is gone. Any tolerance ceiling reappearing here is a
// regression, not a fix. See `TEST-FREEZE.md` and `07-ROADMAP.md` §M6.

/** Totals arrive from a PDF parser: strings, nulls, NaN and ±Infinity are all reachable. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * A money value as an exact integer number of hundredths.
 *
 * `round2` first, so the engine's one rounding convention (half-up on the
 * decimal as written) decides the cent, and so a total that arrives carrying
 * accumulated binary error — 45.49999999999999 for 45.50 — lands on the cent it
 * names rather than the one below it.
 */
function toCents(value: number): number {
  return Math.round(round2(value) * 100)
}

/** Back to a money double. `-0` is not a behaviour: 0 cents is 0. */
function fromCents(cents: number): number {
  return cents === 0 ? 0 : cents / 100
}

/**
 * opening + credits − debits ≈ closing, within `tolerance` (default ±0.01,
 * INCLUSIVE at the edge: 0.01 out balances, 0.02 out does not).
 *
 * Arithmetic is done in integer hundredths. Every operand is converted to
 * cents once, then the whole expression is summed and subtracted exactly, so
 * the reported difference can never be binary-float dust and the verdict can
 * never turn on the third decimal of an accumulation error. Statement headers
 * are two-decimal quantities, so nothing real is lost by that conversion.
 *
 * `difference` is `expectedClosing − closingBalance`: POSITIVE when the parse
 * accounts for more money than the bank states (a missed debit), NEGATIVE when
 * it accounts for less (a missed credit). It is reported identically whatever
 * tolerance was supplied — the tolerance decides only `balanced`.
 *
 * Malformed totals (absent, null, a string, NaN, ±Infinity) never report
 * balanced; `expectedClosing` and `difference` come back as NaN, because no
 * expected closing balance can honestly be derived from them.
 *
 * Throws only when there is no totals object at all — that is a caller bug, not
 * a statement that failed to reconcile.
 */
export function reconcile(totals: StatementTotals, tolerance: number = DEFAULT_TOLERANCE): ReconcileResult {
  if (typeof totals !== 'object' || totals === null) {
    throw new TypeError('reconcile requires a StatementTotals object')
  }

  const opening = totals.openingBalance
  const credits = totals.totalCredits
  const debits = totals.totalDebits
  const closing = totals.closingBalance

  if (
    !isFiniteNumber(opening) ||
    !isFiniteNumber(credits) ||
    !isFiniteNumber(debits) ||
    !isFiniteNumber(closing)
  ) {
    return { balanced: false, expectedClosing: Number.NaN, difference: Number.NaN }
  }

  const expectedCents = toCents(opening) + toCents(credits) - toCents(debits)
  const differenceCents = expectedCents - toCents(closing)
  const difference = fromCents(differenceCents)

  // The tolerance is compared as given and is never rounded to the cent: a
  // caller who asks for 0.005 gets 0.005, not a silently widened 0.01.
  // NaN fails both comparisons, so an unusable tolerance can only ever fail.
  const balanced = tolerance >= 0 && Math.abs(difference) <= tolerance

  return { balanced, expectedClosing: fromCents(expectedCents), difference }
}

/**
 * Split parsed transaction amounts into the credit and debit totals the header
 * check compares against. Debits come back as POSITIVE magnitudes, because the
 * guard is `opening + credits − debits`.
 *
 * Summed in integer hundredths, so the result is order-independent and fifty
 * amounts of 0.10 total exactly 5.00 rather than 4.999999999999998.
 *
 * One unusable amount (NaN, ±Infinity, or something that is not a number at
 * all) poisons BOTH totals to NaN rather than being skipped. Skipping it would
 * hand reconcile a plausible-looking total that is quietly short — the false
 * PASS this module exists to prevent.
 */
export function totalsFromTransactions(amounts: number[]): { totalCredits: number; totalDebits: number } {
  if (!Array.isArray(amounts)) {
    throw new TypeError('totalsFromTransactions requires an array of amounts')
  }

  let creditCents = 0
  let debitCents = 0

  for (const amount of amounts) {
    if (!isFiniteNumber(amount)) {
      return { totalCredits: Number.NaN, totalDebits: Number.NaN }
    }
    const cents = toCents(amount)
    // A zero — including a negative zero — is neither a credit nor a debit.
    if (cents > 0) creditCents += cents
    else if (cents < 0) debitCents -= cents
  }

  return { totalCredits: fromCents(creditCents), totalDebits: fromCents(debitCents) }
}
