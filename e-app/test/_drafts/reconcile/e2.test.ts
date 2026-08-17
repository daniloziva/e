import { describe, it, expect } from 'vitest'
import {
  reconcile,
  totalsFromTransactions,
  type StatementTotals,
} from '../../../src/engine/statements/reconcile.js'

/**
 * 04-PERSONAL.md §2 — the reconciliation guard.
 *
 *   opening + Σcredits − Σdebits ≈ closing   (±0.01)
 *
 * Pass  → transactions committed, review_status='ok'.
 * Fail  → committed as needs_review + a loud message quoting the difference.
 *
 * The guard is the only ground truth the deterministic statement parser has, so
 * both failure modes are expensive: a false PASS hides a parser bug for months,
 * a false FAIL trains the user to ignore the warning. Both are tested here.
 */

/** Positional builder so the arithmetic under test stays readable at the call site. */
const totals = (
  openingBalance: number,
  totalCredits: number,
  totalDebits: number,
  closingBalance: number,
): StatementTotals => ({ openingBalance, totalCredits, totalDebits, closingBalance })

/** 50 cent-exact amounts, alternating credit/debit. Credits 506.75, debits 258.00. */
const FIFTY_AMOUNTS: number[] = Array.from({ length: 50 }, (_, i) =>
  Number((i % 2 === 0 ? 20.03 + i * 0.01 : -(10.07 + i * 0.01)).toFixed(2)),
)
const FIFTY_CREDITS = 506.75
const FIFTY_DEBITS = 258.0

describe('reconcile — a statement that adds up', () => {
  it('accepts a statement whose header totals reproduce the closing balance', () => {
    const result = reconcile(totals(12000.0, 3450.5, 1200.5, 14250.0))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBeCloseTo(14250.0, 2)
    expect(result.difference).toBeCloseTo(0, 10)
  })

  it.each([
    { opening: 0, credits: 0, debits: 0, expected: 0 },
    { opening: 1000, credits: 0, debits: 0, expected: 1000 },
    { opening: 0, credits: 1000, debits: 0, expected: 1000 },
    { opening: 0, credits: 0, debits: 1000, expected: -1000 },
    { opening: 100000, credits: 1740, debits: 400, expected: 101340 },
    { opening: 12.34, credits: 0.01, debits: 0.02, expected: 12.33 },
    { opening: 9999999.99, credits: 0.01, debits: 0, expected: 10000000.0 },
  ])(
    'reports expectedClosing = opening + credits - debits ($opening + $credits - $debits)',
    ({ opening, credits, debits, expected }) => {
      const result = reconcile(totals(opening, credits, debits, expected))
      expect(result.expectedClosing).toBeCloseTo(expected, 2)
    },
  )

  it('derives expectedClosing from the movements alone, never from the stated closing', () => {
    const honest = reconcile(totals(1000, 200, 50, 1150))
    const wrong = reconcile(totals(1000, 200, 50, 99999))

    expect(wrong.expectedClosing).toBeCloseTo(honest.expectedClosing, 10)
    expect(wrong.expectedClosing).toBeCloseTo(1150, 2)
  })

  it('accepts a month with no activity at all', () => {
    const result = reconcile(totals(842.17, 0, 0, 842.17))

    expect(result.balanced).toBe(true)
    expect(result.difference).toBeCloseTo(0, 10)
  })

  it('accepts a month that empties the account to exactly zero', () => {
    const result = reconcile(totals(500.0, 0, 500.0, 0))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBeCloseTo(0, 2)
  })

  it('is pure: the same totals reconcile identically on a second call', () => {
    const input = totals(1000, 200, 50, 1150.01)

    expect(reconcile(input)).toEqual(reconcile(input))
  })

  it('does not mutate the totals it was handed', () => {
    const input = totals(1000, 200, 50, 1150)
    reconcile(input)

    expect(input).toEqual(totals(1000, 200, 50, 1150))
  })
})

describe('reconcile — the ±0.01 tolerance boundary', () => {
  // Every row is 1000 opening / no movement, so the difference is 1000 - closing.
  it.each([
    { closing: 1000.0, difference: 0, balanced: true, why: 'exact' },
    { closing: 999.99, difference: 0.01, balanced: true, why: 'exactly +1 cent' },
    { closing: 1000.01, difference: -0.01, balanced: true, why: 'exactly -1 cent' },
    { closing: 999.98, difference: 0.02, balanced: false, why: 'exactly +2 cents' },
    { closing: 1000.02, difference: -0.02, balanced: false, why: 'exactly -2 cents' },
    { closing: 999.5, difference: 0.5, balanced: false, why: 'half a dinar short' },
    { closing: 1000.5, difference: -0.5, balanced: false, why: 'half a dinar over' },
    { closing: 998.76, difference: 1.24, balanced: false, why: 'clearly wrong' },
  ])('$why: closing $closing is balanced=$balanced with difference $difference', ({ closing, difference, balanced }) => {
    const result = reconcile(totals(1000, 0, 0, closing))

    expect(result.balanced).toBe(balanced)
    expect(result.difference).toBeCloseTo(difference, 10)
  })

  it('balances when the statement is short by exactly one cent', () => {
    const result = reconcile(totals(1000, 0, 0, 999.99))

    expect(result.balanced).toBe(true)
  })

  it('balances when the statement is over by exactly one cent', () => {
    const result = reconcile(totals(1000, 0, 0, 1000.01))

    expect(result.balanced).toBe(true)
  })

  it('refuses to balance when the statement is off by exactly two cents', () => {
    expect(reconcile(totals(1000, 0, 0, 999.98)).balanced).toBe(false)
    expect(reconcile(totals(1000, 0, 0, 1000.02)).balanced).toBe(false)
  })

  it('treats a one-cent gap the same at every magnitude, whatever binary rounding does to it', () => {
    // 100.01 - 100 evaluates to 0.010000000000005116 in IEEE-754: a raw
    // comparison against 0.01 would fail here but pass at 1000.01 - 1000.
    const small = reconcile(totals(100.01, 0, 0, 100.0))
    const large = reconcile(totals(1000.01, 0, 0, 1000.0))

    expect(small.balanced).toBe(true)
    expect(large.balanced).toBe(true)
    expect(small.difference).toBeCloseTo(0.01, 10)
  })

  it('applies the tolerance to the total gap, not to each component', () => {
    // Credits are 0.01 high and debits 0.01 low: components are each within a
    // cent, the closing balance is 0.02 out, so the statement must not balance.
    const result = reconcile(totals(1000, 200.01, 49.99, 1150.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(0.02, 10)
  })
})

describe('reconcile — an explicit tolerance', () => {
  it('uses the ±0.01 default when the tolerance argument is omitted', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99)).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.98)).balanced).toBe(false)
  })

  it('uses the default when the tolerance argument is explicitly undefined', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99), undefined)).toEqual(
      reconcile(totals(1000, 0, 0, 999.99)),
    )
  })

  it('demands an exact match when the tolerance is zero', () => {
    expect(reconcile(totals(1000, 0, 0, 1000.0), 0).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.99), 0).balanced).toBe(false)
  })

  it.each([
    { tolerance: 0.5, closing: 999.5, balanced: true },
    { tolerance: 0.5, closing: 999.49, balanced: false },
    { tolerance: 1, closing: 999.0, balanced: true },
    { tolerance: 1, closing: 1001.0, balanced: true },
    { tolerance: 1, closing: 998.99, balanced: false },
    { tolerance: 100, closing: 900.0, balanced: true },
    { tolerance: 100, closing: 899.99, balanced: false },
  ])(
    'with tolerance $tolerance a closing of $closing is balanced=$balanced',
    ({ tolerance, closing, balanced }) => {
      expect(reconcile(totals(1000, 0, 0, closing), tolerance).balanced).toBe(balanced)
    },
  )

  it('reports the same difference whatever tolerance was supplied', () => {
    const tight = reconcile(totals(1000, 0, 0, 999.5), 0.01)
    const loose = reconcile(totals(1000, 0, 0, 999.5), 10)

    expect(tight.difference).toBeCloseTo(0.5, 10)
    expect(loose.difference).toBeCloseTo(0.5, 10)
    expect(tight.balanced).toBe(false)
    expect(loose.balanced).toBe(true)
  })

  it('never claims balanced when the tolerance itself is NaN', () => {
    expect(reconcile(totals(1000, 0, 0, 1000.0), Number.NaN).balanced).toBe(false)
  })
})

describe('reconcile — the sign of the difference', () => {
  it('reports a negative difference when the parser dropped a credit', () => {
    // The real statement credited 1740; the parse only found 500.
    const result = reconcile(totals(100000, 500, 400, 101340))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-1240, 2)
    expect(Math.abs(result.difference)).toBeCloseTo(1240, 2)
  })

  it('reports a positive difference when the parser dropped a debit', () => {
    // The real statement debited 1640; the parse only found 400.
    const result = reconcile(totals(100000, 1740, 400, 100100))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(1240, 2)
  })

  it.each([
    { label: 'expected above stated closing', closing: 900, difference: 100 },
    { label: 'expected below stated closing', closing: 1100, difference: -100 },
    { label: 'expected above a negative closing', closing: -100, difference: 1100 },
    { label: 'expected far below closing', closing: 50000, difference: -49000 },
  ])('$label: difference is expectedClosing - closingBalance ($difference)', ({ closing, difference }) => {
    const result = reconcile(totals(1000, 0, 0, closing))
    expect(result.difference).toBeCloseTo(difference, 2)
  })

  it.each([
    { raw: 0.014, closing: 999.986, rounded: 0.01 },
    { raw: 0.016, closing: 999.984, rounded: 0.02 },
    { raw: -0.014, closing: 1000.014, rounded: -0.01 },
    { raw: 1.239, closing: 998.761, rounded: 1.24 },
  ])('rounds a reported difference of $raw to $rounded for display', ({ closing, rounded }) => {
    expect(reconcile(totals(1000, 0, 0, closing)).difference).toBeCloseTo(rounded, 10)
  })

  it('reports a difference of exactly zero rather than float dust when the statement is right', () => {
    const result = reconcile(totals(0.1, 0.2, 0, 0.3))

    expect(result.balanced).toBe(true)
    expect(result.difference).toBeCloseTo(0, 10)
    expect(Math.abs(result.difference)).toBeLessThan(0.005)
  })
})

describe('reconcile — negative balances', () => {
  it('accepts an account that spent its way into overdraft', () => {
    const result = reconcile(totals(100.0, 0, 500.0, -400.0))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBeCloseTo(-400.0, 2)
  })

  it('accepts an overdrawn account that was topped back up into the black', () => {
    const result = reconcile(totals(-250.0, 1000.0, 100.0, 650.0))

    expect(result.balanced).toBe(true)
  })

  it.each([
    { opening: -100, credits: 0, debits: 0, closing: -100, balanced: true },
    { opening: -100, credits: 0, debits: 50, closing: -150, balanced: true },
    { opening: -100, credits: 0, debits: 50, closing: -150.01, balanced: true },
    { opening: -100, credits: 0, debits: 50, closing: -150.02, balanced: false },
    { opening: -100, credits: 50, debits: 0, closing: -50, balanced: true },
    { opening: -0.01, credits: 0, debits: 0, closing: -0.01, balanced: true },
    { opening: -1000000, credits: 0, debits: 0, closing: -1000000, balanced: true },
  ])(
    'overdraft $opening + $credits - $debits vs $closing is balanced=$balanced',
    ({ opening, credits, debits, closing, balanced }) => {
      expect(reconcile(totals(opening, credits, debits, closing)).balanced).toBe(balanced)
    },
  )

  it('keeps the sign convention when the closing balance is negative', () => {
    // Expected -400, stated -350: expected is 50 below the stated closing.
    const result = reconcile(totals(100.0, 0, 500.0, -350.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-50, 2)
  })

  it('does not confuse a sign-flipped closing balance for a match', () => {
    const result = reconcile(totals(100.0, 0, 500.0, 400.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-800, 2)
  })
})

describe('reconcile — floating point accumulation must not fake a failure', () => {
  it('balances a month of 50 amounts that only add up in decimal', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions(FIFTY_AMOUNTS)
    const result = reconcile(totals(1000.0, totalCredits, totalDebits, 1248.75))

    expect(result.balanced).toBe(true)
    expect(result.difference).toBeCloseTo(0, 10)
  })

  it('balances fifty ten-para credits whose binary sum is not exactly 5.00', () => {
    // Σ(0.1 × 50) === 4.999999999999998 in IEEE-754.
    const amounts = Array.from({ length: 50 }, () => 0.1)
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)

    expect(reconcile(totals(0, totalCredits, totalDebits, 5.0)).balanced).toBe(true)
  })

  it('balances a month of large amounts where the accumulated error is bigger', () => {
    const amounts = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 99999.99 : -99999.98))
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)

    // 25 × 99999.99 - 25 × 99999.98 = 0.25
    expect(reconcile(totals(0, totalCredits, totalDebits, 0.25)).balanced).toBe(true)
  })

  it('still fails a fifty-transaction month that is genuinely one dinar out', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions(FIFTY_AMOUNTS)
    const result = reconcile(totals(1000.0, totalCredits, totalDebits, 1247.75))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(1.0, 2)
  })
})

describe('reconcile — malformed totals never pass the guard', () => {
  it.each([
    { field: 'openingBalance', input: totals(Number.NaN, 0, 0, 0) },
    { field: 'totalCredits', input: totals(1000, Number.NaN, 0, 1000) },
    { field: 'totalDebits', input: totals(1000, 0, Number.NaN, 1000) },
    { field: 'closingBalance', input: totals(1000, 0, 0, Number.NaN) },
  ])('refuses to balance when $field is NaN', ({ input }) => {
    expect(reconcile(input).balanced).toBe(false)
  })

  it.each([
    { field: 'openingBalance', input: totals(Number.POSITIVE_INFINITY, 0, 0, 0) },
    { field: 'totalCredits', input: totals(1000, Number.POSITIVE_INFINITY, 0, 1000) },
    { field: 'totalDebits', input: totals(1000, 0, Number.NEGATIVE_INFINITY, 1000) },
    { field: 'closingBalance', input: totals(1000, 0, 0, Number.POSITIVE_INFINITY) },
  ])('refuses to balance when $field is infinite', ({ input }) => {
    expect(reconcile(input).balanced).toBe(false)
  })

  it('refuses to balance when two infinities would cancel out', () => {
    const result = reconcile(
      totals(Number.POSITIVE_INFINITY, 0, 0, Number.POSITIVE_INFINITY),
    )
    expect(result.balanced).toBe(false)
  })

  it.each([
    { field: 'openingBalance', input: { totalCredits: 0, totalDebits: 0, closingBalance: 0 } },
    { field: 'closingBalance', input: { openingBalance: 0, totalCredits: 0, totalDebits: 0 } },
    { field: 'totalCredits', input: { openingBalance: 0, totalDebits: 0, closingBalance: 0 } },
  ])('refuses to balance when $field is absent from the header', ({ input }) => {
    expect(reconcile(input as unknown as StatementTotals).balanced).toBe(false)
  })

  it('refuses to balance when a header total is null', () => {
    const input = { ...totals(1000, 0, 0, 1000), totalCredits: null }
    expect(reconcile(input as unknown as StatementTotals).balanced).toBe(false)
  })
})

describe('totalsFromTransactions — splitting signed amounts', () => {
  it('sends positive amounts to credits and negative amounts to debits', () => {
    const result = totalsFromTransactions([1200.0, -350.5, -49.5, 100.0])

    expect(result.totalCredits).toBeCloseTo(1300.0, 2)
    expect(result.totalDebits).toBeCloseTo(400.0, 2)
  })

  it('reports debits as a positive magnitude, so opening + credits - debits works', () => {
    const result = totalsFromTransactions([-500.0])

    expect(result.totalDebits).toBeCloseTo(500.0, 2)
    expect(result.totalDebits).toBeGreaterThan(0)
  })

  it.each([
    { label: 'an empty statement', amounts: [] as number[], credits: 0, debits: 0 },
    { label: 'a single credit', amounts: [100.0], credits: 100.0, debits: 0 },
    { label: 'a single debit', amounts: [-100.0], credits: 0, debits: 100.0 },
    { label: 'credits only', amounts: [1.0, 2.0, 3.0], credits: 6.0, debits: 0 },
    { label: 'debits only', amounts: [-1.0, -2.0, -3.0], credits: 0, debits: 6.0 },
    { label: 'a mixed month', amounts: [10.0, -4.0, 2.5, -0.5], credits: 12.5, debits: 4.5 },
    { label: 'a zero amount', amounts: [0], credits: 0, debits: 0 },
    { label: 'a negative zero', amounts: [-0], credits: 0, debits: 0 },
    { label: 'zeros among real movement', amounts: [0, 25.0, -0, -5.0], credits: 25.0, debits: 5.0 },
    { label: 'one-para amounts', amounts: [0.01, -0.01], credits: 0.01, debits: 0.01 },
  ])('$label yields credits $credits and debits $debits', ({ amounts, credits, debits }) => {
    const result = totalsFromTransactions(amounts)

    expect(result.totalCredits).toBeCloseTo(credits, 2)
    expect(result.totalDebits).toBeCloseTo(debits, 2)
  })

  it('returns zero on both sides for a statement with no transactions', () => {
    expect(totalsFromTransactions([])).toEqual({ totalCredits: 0, totalDebits: 0 })
  })

  it('is order independent', () => {
    const forwards = totalsFromTransactions(FIFTY_AMOUNTS)
    const backwards = totalsFromTransactions([...FIFTY_AMOUNTS].reverse())

    expect(forwards.totalCredits).toBeCloseTo(backwards.totalCredits, 2)
    expect(forwards.totalDebits).toBeCloseTo(backwards.totalDebits, 2)
  })

  it('sums fifty alternating amounts to the decimal totals a human would get', () => {
    const result = totalsFromTransactions(FIFTY_AMOUNTS)

    expect(result.totalCredits).toBeCloseTo(FIFTY_CREDITS, 2)
    expect(result.totalDebits).toBeCloseTo(FIFTY_DEBITS, 2)
  })

  it('does not mutate the amounts it was handed', () => {
    const amounts = [10.0, -4.0, 2.5]
    totalsFromTransactions(amounts)

    expect(amounts).toEqual([10.0, -4.0, 2.5])
  })

  it('counts every transaction, including duplicates of the same amount', () => {
    const result = totalsFromTransactions([-320.0, -320.0, -320.0])

    expect(result.totalDebits).toBeCloseTo(960.0, 2)
    expect(result.totalCredits).toBeCloseTo(0, 2)
  })
})

describe('totalsFromTransactions + reconcile — the guard end to end', () => {
  it('passes when the parsed transactions reproduce the stated closing balance', () => {
    const amounts = [1240.0, 500.0, -300.0, -100.0]
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(true)
  })

  it('announces the exact size of a transaction the parser dropped', () => {
    // The real month had a 1.240,00 credit; the parse missed that row.
    const parsed = [500.0, -300.0, -100.0]
    const { totalCredits, totalDebits } = totalsFromTransactions(parsed)
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(false)
    expect(Math.abs(result.difference)).toBeCloseTo(1240.0, 2)
    expect(result.difference).toBeCloseTo(-1240.0, 2)
  })

  it('catches a debit the parser read as a credit, at double the amount', () => {
    const parsed = [1240.0, 500.0, 300.0, -100.0] // the 300 should have been -300
    const { totalCredits, totalDebits } = totalsFromTransactions(parsed)
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(600.0, 2)
  })

  it('catches a decimal-separator misparse of a single row', () => {
    const parsed = [1240.0, 500.0, -30000.0, -100.0] // -300,00 read as -30.000
    const { totalCredits, totalDebits } = totalsFromTransactions(parsed)
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-29700.0, 2)
  })

  it('catches a row counted twice by a band-splitting bug', () => {
    const parsed = [1240.0, 500.0, -300.0, -300.0, -100.0]
    const { totalCredits, totalDebits } = totalsFromTransactions(parsed)
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-300.0, 2)
  })

  it('fails an empty parse of a month that clearly had movement', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([])
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 101340.0))

    expect(result.balanced).toBe(false)
    expect(result.difference).toBeCloseTo(-1340.0, 2)
  })

  it('passes an empty parse of a month that genuinely had no movement', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([])
    const result = reconcile(totals(100000.0, totalCredits, totalDebits, 100000.0))

    expect(result.balanced).toBe(true)
  })

  it('never claims balanced when a parsed amount is NaN', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([100.0, Number.NaN, -50.0])
    const result = reconcile(totals(1000.0, totalCredits, totalDebits, 1050.0))

    expect(result.balanced).toBe(false)
  })

  it('never claims balanced when a parsed amount is infinite', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([
      100.0,
      Number.POSITIVE_INFINITY,
    ])
    const result = reconcile(totals(1000.0, totalCredits, totalDebits, 1100.0))

    expect(result.balanced).toBe(false)
  })

  it('holds the guard to the cent across a fifty-transaction month one cent out', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions(FIFTY_AMOUNTS)

    expect(reconcile(totals(1000.0, totalCredits, totalDebits, 1248.74)).balanced).toBe(true)
    expect(reconcile(totals(1000.0, totalCredits, totalDebits, 1248.73)).balanced).toBe(false)
  })
})
