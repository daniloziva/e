/**
 * E — statement reconciliation guard.
 *
 * Merged from three independent drafts (engineers 1-3).
 * Spec: 04-PERSONAL.md §2 "The reconciliation guard (non-negotiable)".
 *
 *     opening + Σcredits − Σdebits ≈ closing   (±0.01)
 *
 * Pass → transactions committed, review_status='ok'.
 * Fail → committed as needs_review + a loud message quoting the difference.
 *
 * This guard is the ONLY ground truth the deterministic statement parser has,
 * and it is what makes "no model fallback" safe rather than reckless. Both
 * failure modes are expensive: a false PASS hides a parser bug for months; a
 * false FAIL trains you to ignore the warning. Both are tested here.
 *
 * All three drafts agreed on the contract, so this file is close to a union:
 *   - difference = expectedClosing − closingBalance, rounded to 2dp
 *   - ±0.01 is INCLUSIVE; ±0.02 fails
 *   - default tolerance 0.01; an explicit `undefined` also means default
 *   - tolerance 0 demands an exact match
 *   - accumulated binary floating-point error must never fake a failure
 */

import { describe, it, expect } from 'vitest'
import {
  reconcile,
  totalsFromTransactions,
  type StatementTotals,
} from '../../src/engine/statements/reconcile.js'

/** Positional builder so the arithmetic under test stays readable at the call site. */
function totals(
  openingBalance: number,
  totalCredits: number,
  totalDebits: number,
  closingBalance: number,
): StatementTotals {
  return { openingBalance, totalCredits, totalDebits, closingBalance }
}

/** `toBe(0)` uses Object.is, which distinguishes -0 from 0. Signed zero is not a behaviour. */
function expectZero(n: number): void {
  expect(Math.abs(n)).toBe(0)
}

/** 50 decimal-exact alternating amounts. Credits 43.75, debits 45.50, net -1.75. */
const FIFTY_AMOUNTS: number[] = Array.from({ length: 50 }, (_, i) =>
  (i % 2 === 0 ? 1 : -1) * Number((((i + 1) * 7) / 100).toFixed(2)),
)
const FIFTY_CREDITS = 43.75
const FIFTY_DEBITS = 45.5
const FIFTY_NET = -1.75

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — statements that balance
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — a statement that balances', () => {
  it('reports a statement whose own balances agree with its totals as balanced', () => {
    const result = reconcile(totals(1000, 250, 100, 1150))
    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(1150)
    expectZero(result.difference)
  })

  it.each<[string, StatementTotals, number]>([
    ['no movement at all', totals(0, 0, 0, 0), 0],
    ['an opening balance and no movement', totals(1000, 0, 0, 1000), 1000],
    ['credits only', totals(500, 125.5, 0, 625.5), 625.5],
    ['debits only', totals(500, 0, 125.5, 374.5), 374.5],
    ['debits taking the account below zero', totals(0, 0, 1000, -1000), -1000],
    ['a full month of movement', totals(128456.78, 210000, 187654.32, 150802.46), 150802.46],
    ['an account emptied to exactly zero', totals(900.25, 0, 900.25, 0), 0],
    ['sub-unit amounts', totals(0.01, 0.02, 0.02, 0.01), 0.01],
    ['a hundredth either side of a whole dinar', totals(12.34, 0.01, 0.02, 12.33), 12.33],
    ['amounts at the edge of exact float representation', totals(9999999.99, 0.01, 0, 10000000.0), 10000000.0],
  ])('balances %s', (_label, input, expectedClosing) => {
    const result = reconcile(input)
    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(expectedClosing)
    expectZero(result.difference)
  })

  it('derives the expected closing from opening plus credits minus debits, never from the stated closing', () => {
    const result = reconcile(totals(100, 50, 20, 999))
    expect(result.expectedClosing).toBe(130)
    expect(result.balanced).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — the ±0.01 tolerance boundary, tested exactly
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — the ±0.01 tolerance boundary', () => {
  it.each<[string, number, number, boolean]>([
    ['two cents short', 999.98, 0.02, false],
    ['exactly one cent short — the inclusive edge', 999.99, 0.01, true],
    ['exact', 1000.0, 0, true],
    ['exactly one cent over — the inclusive edge', 1000.01, -0.01, true],
    ['two cents over', 1000.02, -0.02, false],
  ])(
    'a stated closing %s of an expected 1000 gives difference %s and balanced=%s',
    (_label, closing, expectedDifference, balanced) => {
      const result = reconcile(totals(1000, 0, 0, closing))
      expect(result.expectedClosing).toBe(1000)
      if (expectedDifference === 0) expectZero(result.difference)
      else expect(result.difference).toBe(expectedDifference)
      expect(result.balanced).toBe(balanced)
    },
  )

  it.each<[number, boolean]>([
    [-0.01, true],
    [0.01, true],
    [-0.02, false],
    [0.02, false],
  ])('applies the same edge around a zero balance: closing %s gives balanced=%s', (closing, balanced) => {
    expect(reconcile(totals(0, 0, 0, closing)).balanced).toBe(balanced)
  })

  it('stays balanced at exactly +0.01 when the operands carry binary floating-point noise', () => {
    // 0.1 + 0.2 === 0.30000000000000004, so the raw difference is 0.010000000000000064 —
    // just over tolerance. Rounded to 2dp it is exactly 0.01 and the statement balances.
    const result = reconcile(totals(0.1, 0.2, 0, 0.29))
    expect(result.difference).toBe(0.01)
    expect(result.balanced).toBe(true)
  })

  it('stays balanced at exactly -0.01 when the operands carry binary floating-point noise', () => {
    const result = reconcile(totals(0.1, 0.2, 0, 0.31))
    expect(result.difference).toBe(-0.01)
    expect(result.balanced).toBe(true)
  })

  it('applies the one-cent edge identically at small and large magnitudes', () => {
    // 100.01 - 100 evaluates to 0.010000000000005116 in IEEE-754: a raw comparison
    // against 0.01 would fail here but pass at 1000.01 - 1000.
    const small = reconcile(totals(100.01, 0, 0, 100.0))
    const large = reconcile(totals(1000.01, 0, 0, 1000.0))
    expect(small.balanced).toBe(true)
    expect(large.balanced).toBe(true)
    expect(small.difference).toBe(0.01)
  })

  it('applies an absolute one-cent tolerance to a balance in the millions, not a proportional one', () => {
    const ok = reconcile(totals(9_000_000, 500_000, 250_000, 9_250_000.01))
    expect(ok.difference).toBe(-0.01)
    expect(ok.balanced).toBe(true)

    const worse = reconcile(totals(9_000_000, 500_000, 250_000, 9_250_000.02))
    expect(worse.balanced).toBe(false)
  })

  it('applies the tolerance to the total gap, not to each component', () => {
    // Credits are 0.01 high and debits 0.01 low: each component is within a cent,
    // but together they put the closing balance two cents out.
    const result = reconcile(totals(1000, 200.01, 49.99, 1150.0))
    expect(result.difference).toBe(0.02)
    expect(result.balanced).toBe(false)
  })

  it('fails at exactly two cents out when the error is in the debit total rather than the closing balance', () => {
    const result = reconcile(totals(1000, 0, 100.02, 900))
    expect(result.difference).toBe(-0.02)
    expect(result.balanced).toBe(false)
  })

  it('reports the difference rounded to two decimals rather than as floating-point noise', () => {
    // (100.10 + 0.20) - 100.00 evaluates to 0.29999999999999716 in binary floating point.
    const result = reconcile(totals(100.1, 0.2, 0, 100))
    expect(result.difference).toBe(0.3)
    expect(result.balanced).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — accumulated float error must never fake a failure
// This is the case that would otherwise cry wolf every month.
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — floating-point accumulation must not fake a failure', () => {
  it('balances fifty ten-cent credits against a five-dinar movement', () => {
    // Adding 0.1 fifty times gives 4.999999999999998, not 5.
    const credits = Array.from({ length: 50 }, () => 0.1).reduce((a, b) => a + b, 0)
    const result = reconcile(totals(0, credits, 0, 5))
    expect(result.balanced).toBe(true)
    expectZero(result.difference)
  })

  it('balances when the debit total arrives with accumulated binary error', () => {
    const result = reconcile(totals(1000, FIFTY_CREDITS, 45.49999999999999, 998.25))
    expect(result.balanced).toBe(true)
    expectZero(result.difference)
    expect(result.expectedClosing).toBeCloseTo(998.25, 2)
  })

  it('balances a fifty-transaction statement fed through totalsFromTransactions', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions(FIFTY_AMOUNTS)
    const result = reconcile(totals(1000, totalCredits, totalDebits, 1000 + FIFTY_NET))
    expect(result.balanced).toBe(true)
    expectZero(result.difference)
  })

  it('balances two hundred hundredth-of-a-dinar debits, where the error accumulates furthest', () => {
    const amounts = Array.from({ length: 200 }, () => -0.01)
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)
    const result = reconcile(totals(10, totalCredits, totalDebits, 8))
    expect(result.balanced).toBe(true)
    expectZero(result.difference)
  })

  it('still fails a fifty-transaction statement that is genuinely one transaction short', () => {
    const missingOne = FIFTY_AMOUNTS.slice(0, 49) // drops the final -3.50 debit
    const { totalCredits, totalDebits } = totalsFromTransactions(missingOne)
    const result = reconcile(totals(1000, totalCredits, totalDebits, 1000 + FIFTY_NET))
    expect(result.balanced).toBe(false)
    expect(result.difference).toBe(3.5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — negative balances
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — negative balances', () => {
  it.each<[string, StatementTotals, number]>([
    ['a statement that stays in overdraft all month', totals(-500, 100, 200, -600), -600],
    ['an account that crosses from credit into overdraft', totals(250, 0, 900, -650), -650],
    ['an account that recovers from overdraft into credit', totals(-300, 1000, 200, 500), 500],
  ])('balances %s', (_label, input, expectedClosing) => {
    const result = reconcile(input)
    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(expectedClosing)
    expectZero(result.difference)
  })

  it.each<[string, StatementTotals, number, number]>([
    ['deeper overdraft than stated', totals(-100, 0, 50, -160), -150, 10],
    ['shallower overdraft than stated', totals(-100, 0, 50, -140), -150, -10],
    ['expected negative, stated positive', totals(-1000, 100, 0, 900), -900, -1800],
  ])(
    'reports %s with the expected-minus-stated sign convention',
    (_label, input, expectedClosing, difference) => {
      const result = reconcile(input)
      expect(result.balanced).toBe(false)
      expect(result.expectedClosing).toBe(expectedClosing)
      expect(result.difference).toBe(difference)
    },
  )

  it('applies the same one-cent tolerance to negative closing balances', () => {
    const result = reconcile(totals(-500, 0, 100, -600.01))
    expect(result.difference).toBe(0.01)
    expect(result.balanced).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — the difference is a parser diagnostic, so its sign must be usable
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — difference sign convention as a parser diagnostic', () => {
  it('returns a positive difference when the parser missed a debit', () => {
    // Real debits were 500; only 400 was parsed, so we expect more money left
    // than the bank states.
    const result = reconcile(totals(1000, 0, 400, 500))
    expect(result.difference).toBe(100)
    expect(result.balanced).toBe(false)
  })

  it('returns a negative difference when the parser missed a credit', () => {
    const result = reconcile(totals(1000, 200, 0, 1300))
    expect(result.difference).toBe(-100)
    expect(result.balanced).toBe(false)
  })

  it('returns twice the amount when a debit was parsed with the wrong sign', () => {
    // A 500 outflow read as an inflow: credits are 500 too high and debits 500 too low.
    const result = reconcile(totals(1000, 500, 0, 500))
    expect(result.difference).toBe(1000)
    expect(result.balanced).toBe(false)
  })

  it('returns the doubled amount negated when a credit was parsed as a debit', () => {
    const result = reconcile(totals(1000, 0, 500, 1500))
    expect(result.difference).toBe(-1000)
    expect(result.balanced).toBe(false)
  })

  it('reports the 1.240,00 difference from the spec example verbatim', () => {
    // 04-PERSONAL §2: "parsirao 47 transakcija, ne poklapa se sa saldom (razlika 1.240,00)"
    const result = reconcile(totals(85000, 42000, 31000, 94760))
    expect(result.balanced).toBe(false)
    expect(result.difference).toBe(1240)
  })

  it('reports zero movement against changed balances as unbalanced', () => {
    const result = reconcile(totals(1000, 0, 0, 1500))
    expect(result.expectedClosing).toBe(1000)
    expect(result.difference).toBe(-500)
    expect(result.balanced).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — the tolerance argument
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — the tolerance argument', () => {
  it('uses the ±0.01 default when the tolerance argument is omitted', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99)).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.98)).balanced).toBe(false)
  })

  it('uses the ±0.01 default when the tolerance argument is explicitly undefined', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99), undefined)).toEqual(
      reconcile(totals(1000, 0, 0, 999.99)),
    )
    expect(reconcile(totals(1000, 0, 0, 999.98), undefined).balanced).toBe(false)
  })

  it('demands an exact match when the tolerance is zero', () => {
    expect(reconcile(totals(1000, 0, 0, 1000.0), 0).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.99), 0).balanced).toBe(false)
    expect(reconcile(totals(1000, 0, 0, 1000.01), 0).balanced).toBe(false)
  })

  it.each<[number, number, boolean]>([
    [0.01, 999.99, true],
    [0.5, 999.5, true],
    [0.5, 999.49, false],
    [1, 999.0, true],
    [1, 1001.0, true],
    [5, 995, true],
    // UNFREEZE CANDIDATE-013: was [1000, 1240, false], which asserts a difference of
    // 240 against a tolerance of 1000 is unbalanced. 1240 is `04-PERSONAL.md:87`'s
    // *razlika* (difference) pasted into the closing-balance column. 2240 encodes the
    // spec's own example correctly: difference -1240 against a tolerance of 1000.
    [1000, 2240, false],
  ])('with a tolerance of %s a stated closing of %s gives balanced=%s', (tolerance, closing, balanced) => {
    expect(reconcile(totals(1000, 0, 0, closing), tolerance).balanced).toBe(balanced)
  })

  it('never widens a tolerance narrower than one cent', () => {
    const result = reconcile(totals(1000, 0, 0, 999.99), 0.005)
    expect(result.difference).toBe(0.01)
    expect(result.balanced).toBe(false)
  })

  it('reports the same difference and expected closing whatever the tolerance', () => {
    const strict = reconcile(totals(1000, 0, 0, 995), 0)
    const loose = reconcile(totals(1000, 0, 0, 995), 100)
    expect(strict.difference).toBe(5)
    expect(loose.difference).toBe(5)
    expect(strict.expectedClosing).toBe(loose.expectedClosing)
    expect(strict.balanced).toBe(false)
    expect(loose.balanced).toBe(true)
  })

  it('refuses to call a statement balanced when the tolerance is not a number', () => {
    expect(reconcile(totals(1000, 0, 0, 1000), Number.NaN).balanced).toBe(false)
  })

  it('refuses to call a statement balanced when the tolerance is negative', () => {
    expect(reconcile(totals(1000, 0, 0, 1000), -0.01).balanced).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — malformed input must never report balanced
// A false PASS is the expensive failure: it hides a parser bug for months.
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — malformed or absent totals never report balanced', () => {
  it.each<[string, StatementTotals]>([
    ['a NaN opening balance', totals(Number.NaN, 100, 100, 1000)],
    ['a NaN closing balance', totals(1000, 100, 100, Number.NaN)],
    ['NaN credits', totals(1000, Number.NaN, 0, 1000)],
    ['NaN debits', totals(1000, 0, Number.NaN, 1000)],
    ['an infinite opening balance', totals(Number.POSITIVE_INFINITY, 0, 0, 1000)],
    ['a negatively infinite closing balance', totals(1000, 0, 0, Number.NEGATIVE_INFINITY)],
  ])('refuses to report balanced for %s', (_label, input) => {
    expect(reconcile(input).balanced).toBe(false)
  })

  it.each<[string]>([['openingBalance'], ['closingBalance'], ['totalCredits'], ['totalDebits']])(
    'refuses to report balanced when %s is absent from the totals',
    (field) => {
      const input = totals(1000, 0, 0, 1000) as unknown as Record<string, number | undefined>
      input[field] = undefined
      expect(reconcile(input as unknown as StatementTotals).balanced).toBe(false)
    },
  )

  it.each<[string, unknown]>([
    [
      'a string opening balance',
      { openingBalance: '1000', totalCredits: 0, totalDebits: 0, closingBalance: 1000 },
    ],
    [
      'a string credit total',
      { openingBalance: 1000, totalCredits: '0', totalDebits: 0, closingBalance: 1000 },
    ],
    [
      'a null closing balance',
      { openingBalance: 1000, totalCredits: 0, totalDebits: 0, closingBalance: null },
    ],
  ])('refuses to report balanced for %s rather than coercing it', (_label, input) => {
    expect(reconcile(input as StatementTotals).balanced).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// reconcile — purity
// ═══════════════════════════════════════════════════════════════════════════

describe('reconcile — purity', () => {
  it('does not mutate the totals it was given', () => {
    const input = totals(1000, 250, 100, 1150)
    const snapshot = { ...input }
    reconcile(input)
    expect(input).toEqual(snapshot)
  })

  it('returns an identical result when called twice with the same totals', () => {
    const input = totals(85000, 42000, 31000, 94760)
    expect(reconcile(input)).toEqual(reconcile(input))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// totalsFromTransactions
// ═══════════════════════════════════════════════════════════════════════════

describe('totalsFromTransactions — splitting signed amounts', () => {
  it('returns zero credits and zero debits for a statement with no transactions', () => {
    const result = totalsFromTransactions([])
    expectZero(result.totalCredits)
    expectZero(result.totalDebits)
  })

  it.each<[string, number[], number, number]>([
    ['a single inflow', [100], 100, 0],
    ['a single outflow', [-100], 0, 100],
    ['one of each', [100, -40], 100, 40],
    ['only outflows', [-1, -2, -3], 0, 6],
    ['only inflows', [1, 2, 3], 6, 0],
    ['an inflow and outflow that cancel', [100, -100], 100, 100],
    ['a zero amount', [0], 0, 0],
    ['a negative zero amount', [-0], 0, 0],
    ['large realistic amounts', [1234567.89, -987654.32], 1234567.89, 987654.32],
  ])('splits %s into credits and debits', (_label, amounts, credits, debits) => {
    const result = totalsFromTransactions(amounts)
    if (credits === 0) expectZero(result.totalCredits)
    else expect(result.totalCredits).toBeCloseTo(credits, 2)
    if (debits === 0) expectZero(result.totalDebits)
    else expect(result.totalDebits).toBeCloseTo(debits, 2)
  })

  it('reports debits as positive magnitudes so that opening + credits - debits holds', () => {
    const result = totalsFromTransactions([-10, -20, -30])
    expect(result.totalDebits).toBeGreaterThan(0)
    expect(result.totalDebits).toBeCloseTo(60, 2)
  })

  it('sums fifty mixed amounts to the decimal-exact credit and debit totals', () => {
    const result = totalsFromTransactions(FIFTY_AMOUNTS)
    expect(result.totalCredits).toBeCloseTo(FIFTY_CREDITS, 2)
    expect(result.totalDebits).toBeCloseTo(FIFTY_DEBITS, 2)
  })

  it('produces the same totals whatever order the transactions arrive in', () => {
    const forwards = totalsFromTransactions(FIFTY_AMOUNTS)
    const backwards = totalsFromTransactions([...FIFTY_AMOUNTS].reverse())
    expect(backwards.totalCredits).toBeCloseTo(forwards.totalCredits, 2)
    expect(backwards.totalDebits).toBeCloseTo(forwards.totalDebits, 2)
  })

  it('accumulates tenths without drifting more than a hundredth', () => {
    const result = totalsFromTransactions(Array.from({ length: 50 }, () => 0.1))
    expect(result.totalCredits).toBeCloseTo(5, 2)
    expectZero(result.totalDebits)
  })

  it('does not mutate the array of amounts it was given', () => {
    const amounts = [100, -40, 0, -0.01]
    const snapshot = [...amounts]
    totalsFromTransactions(amounts)
    expect(amounts).toEqual(snapshot)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The guard end to end — parsed transactions fed straight into reconcile
// ═══════════════════════════════════════════════════════════════════════════

describe('totalsFromTransactions feeding reconcile — the guard end to end', () => {
  it('passes a statement whose parsed transactions explain the balance change exactly', () => {
    const amounts = [-1200.5, 45000, -320.75, -89.99, -15000, 250]
    const net = amounts.reduce((a, b) => a + b, 0)
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)
    const result = reconcile(
      totals(12345.67, totalCredits, totalDebits, Number((12345.67 + net).toFixed(2))),
    )
    expect(result.balanced).toBe(true)
    expectZero(result.difference)
  })

  it('fails loudly when one parsed transaction is duplicated', () => {
    const amounts = [-1200.5, 45000, -320.75]
    const duplicated = [...amounts, -320.75]
    const net = amounts.reduce((a, b) => a + b, 0)
    const { totalCredits, totalDebits } = totalsFromTransactions(duplicated)
    const result = reconcile(totals(10000, totalCredits, totalDebits, Number((10000 + net).toFixed(2))))
    expect(result.balanced).toBe(false)
    expect(result.difference).toBe(-320.75)
  })

  it('passes an empty statement whose closing balance equals its opening balance', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([])
    const result = reconcile(totals(4210, totalCredits, totalDebits, 4210))
    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(4210)
    expectZero(result.difference)
  })

  it('fails an empty parse against a statement whose balance actually moved', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([])
    const result = reconcile(totals(4210, totalCredits, totalDebits, 2970))
    expect(result.balanced).toBe(false)
    expect(result.difference).toBe(1240)
  })

  it('refuses to report balanced when one parsed amount is not a number', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([100, Number.NaN, -40])
    expect(reconcile(totals(1000, totalCredits, totalDebits, 1060)).balanced).toBe(false)
  })

  it('refuses to report balanced when one parsed amount is infinite', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([100, Number.POSITIVE_INFINITY, -40])
    expect(reconcile(totals(1000, totalCredits, totalDebits, 1060)).balanced).toBe(false)
  })
})
