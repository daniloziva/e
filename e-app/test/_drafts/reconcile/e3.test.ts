import { describe, it, expect } from 'vitest'
import {
  reconcile,
  totalsFromTransactions,
  type StatementTotals,
  type ReconcileResult,
} from '../../../src/engine/statements/reconcile.js'

/**
 * Statement reconciliation guard — 04-PERSONAL.md §2.
 *
 *   assert  opening + Σcredits − Σdebits ≈ closing   (±0.01)
 *
 * Pass  → transactions committed as 'ok'.
 * Fail  → transactions committed as 'needs_review' and E announces the difference.
 *
 * `difference` is defined by the contract as `expectedClosing - closingBalance`,
 * rounded to 2dp.
 */

// --- test-side helpers (never implementation, never mocks) -------------------

/** -0 and 0 are the same money; toBe() uses Object.is and would split them. */
const norm = (n: number): number => (Object.is(n, -0) ? 0 : n)

/** Exact cent arithmetic, used to build fixtures the implementation must match. */
const cents = (n: number): number => Math.round(n * 100)
const fromCents = (c: number): number => c / 100
const sumExact = (xs: readonly number[]): number =>
  fromCents(xs.reduce((acc, x) => acc + cents(x), 0))

const totals = (
  openingBalance: number,
  totalCredits: number,
  totalDebits: number,
  closingBalance: number,
): StatementTotals => ({ openingBalance, closingBalance, totalCredits, totalDebits })

/**
 * A guard may legitimately reject malformed input by throwing OR by reporting
 * `balanced: false`. What it may never do is wave it through. The stub's
 * "not implemented" is re-thrown so these cases stay RED until implemented.
 */
function neverClaimsBalanced(t: StatementTotals, tolerance?: number): boolean {
  try {
    const r: ReconcileResult =
      tolerance === undefined ? reconcile(t) : reconcile(t, tolerance)
    return r.balanced === false
  } catch (err) {
    if (err instanceof Error && err.message === 'not implemented') throw err
    return true
  }
}

/** Same idea for the totals helper: garbage in must not yield a plausible number. */
function neverYieldsPlausibleTotals(amounts: number[]): boolean {
  try {
    const r = totalsFromTransactions(amounts)
    return !Number.isFinite(r.totalCredits) || !Number.isFinite(r.totalDebits)
  } catch (err) {
    if (err instanceof Error && err.message === 'not implemented') throw err
    return true
  }
}

/** 50 two-decimal signed amounts — a realistic month, built deterministically. */
const fiftyAmounts: number[] = Array.from({ length: 50 }, (_, i) =>
  i % 3 === 0
    ? Number(((i + 1) * 1.07).toFixed(2))
    : -Number(((i + 1) * 0.31 + 0.07).toFixed(2)),
)
const fiftyCredits = sumExact(fiftyAmounts.filter((a) => a > 0))
const fiftyDebits = sumExact(fiftyAmounts.filter((a) => a < 0).map((a) => -a))

// ---------------------------------------------------------------------------

describe('reconcile — a statement that balances', () => {
  it('accepts a statement whose parsed movements land exactly on the stated closing balance', () => {
    const r = reconcile(totals(1000, 500, 200, 1300))
    expect(r.balanced).toBe(true)
    expect(r.expectedClosing).toBeCloseTo(1300, 2)
    expect(norm(r.difference)).toBe(0)
  })

  it.each([
    ['an empty statement with no movement at all', 0, 0, 0, 0],
    ['credits only', 100, 50, 0, 150],
    ['debits only', 100, 0, 40, 60],
    ['a full month of salary in and spending out', 12345.67, 8900.11, 4200.78, 17045],
    ['an account that starts overdrawn and recovers', -250.5, 1000, 100, 649.5],
    ['an account that ends overdrawn', 500, 0, 1200.75, -700.75],
    ['an account overdrawn on both sides of the month', -1000, 200, 500, -1300],
    ['balances in the millions', 9876543.21, 1234567.89, 2345678.9, 8765432.2],
    ['a closing balance of exactly zero', 750.25, 0, 750.25, 0],
    ['sub-cent-free values that a naive float sum would drift on', 0.1, 0.2, 0.3, 0],
  ])('balances %s', (_name, opening, credits, debits, closing) => {
    const r = reconcile(totals(opening, credits, debits, closing))
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
    expect(r.expectedClosing).toBeCloseTo(closing, 2)
  })

  it('reports the expected closing balance it derived, so a failure message can quote it', () => {
    const r = reconcile(totals(2000, 150.25, 400.75, 1749.5))
    expect(r.expectedClosing).toBeCloseTo(1749.5, 2)
  })
})

describe('reconcile — the ±0.01 tolerance boundary', () => {
  // opening + credits - debits = 1300.00 in every row below.
  it.each([
    ['exactly on the balance', 1300, 0, true],
    ['exactly +0.01 out — the inclusive edge of tolerance', 1299.99, 0.01, true],
    ['exactly -0.01 out — the inclusive edge of tolerance', 1300.01, -0.01, true],
    ['exactly +0.02 out — the first cent past tolerance', 1299.98, 0.02, false],
    ['exactly -0.02 out — the first cent past tolerance', 1300.02, -0.02, false],
    ['+0.03 out', 1299.97, 0.03, false],
    ['-0.03 out', 1300.03, -0.03, false],
  ])('is %s → balanced=%j', (_name, closing, expectedDifference, expectedBalanced) => {
    const r = reconcile(totals(1000, 500, 200, closing as number))
    expect(norm(r.difference)).toBe(expectedDifference)
    expect(r.balanced).toBe(expectedBalanced)
  })

  it('treats one cent of slack as passing rather than flagging every rounded statement', () => {
    expect(reconcile(totals(0, 0, 0, -0.01)).balanced).toBe(true)
    expect(reconcile(totals(0, 0, 0, 0.01)).balanced).toBe(true)
  })

  it('treats two cents of slack as a failure even on a tiny statement', () => {
    expect(reconcile(totals(0, 0, 0, -0.02)).balanced).toBe(false)
    expect(reconcile(totals(0, 0, 0, 0.02)).balanced).toBe(false)
  })

  it('applies the same one-cent tolerance to a balance in the millions, not a proportional one', () => {
    const r = reconcile(totals(9_000_000, 500_000, 250_000, 9_250_000.01))
    expect(norm(r.difference)).toBe(-0.01)
    expect(r.balanced).toBe(true)

    const worse = reconcile(totals(9_000_000, 500_000, 250_000, 9_250_000.02))
    expect(norm(worse.difference)).toBe(-0.02)
    expect(worse.balanced).toBe(false)
  })
})

describe('reconcile — the sign convention of `difference`', () => {
  it('is positive when the parse produced more money than the statement says is there', () => {
    // A debit line was missed: we expect a higher closing balance than the bank states.
    const r = reconcile(totals(100000, 50000, 20000, 128760))
    expect(r.balanced).toBe(false)
    expect(r.expectedClosing).toBeCloseTo(130000, 2)
    expect(norm(r.difference)).toBe(1240)
  })

  it('is negative when the parse produced less money than the statement says is there', () => {
    // A credit line was missed: the bank states more than we can account for.
    const r = reconcile(totals(100000, 50000, 20000, 131240))
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(-1240)
  })

  it('keeps the sign convention intact when the closing balance is negative', () => {
    // expected -1300, stated -1250 → we are 50 short of what the bank reports.
    const r = reconcile(totals(-1000, 200, 500, -1250))
    expect(r.expectedClosing).toBeCloseTo(-1300, 2)
    expect(norm(r.difference)).toBe(-50)
    expect(r.balanced).toBe(false)
  })

  it('keeps the sign convention intact when expected and stated straddle zero', () => {
    const r = reconcile(totals(100, 0, 150, 25))
    expect(r.expectedClosing).toBeCloseTo(-50, 2)
    expect(norm(r.difference)).toBe(-75)
    expect(r.balanced).toBe(false)
  })

  it.each([
    ['missed one 1.240,00 debit', 1240, 1240],
    ['missed one 0,50 debit', 0.5, 0.5],
    ['double-counted one 89,90 credit', -89.9, -89.9],
    ['transposed digits, 540 vs 450', 90, 90],
  ])('reports %s as a difference of %j', (_name, _delta, expected) => {
    const r = reconcile(totals(1000, 500, 200, 1300 - (expected as number)))
    expect(norm(r.difference)).toBe(expected)
    expect(r.balanced).toBe(false)
  })

  it('rounds the reported difference to two decimals so the message never shows float noise', () => {
    const r = reconcile(totals(0.1, 0.2, 0, 0.2))
    // raw expected closing is 0.30000000000000004; the reported difference is 0.10
    expect(norm(r.difference)).toBe(0.1)
  })
})

describe('reconcile — floating point accumulation must not fake a failure', () => {
  it('balances a fifty-transaction month whose naive float sum drifts below a cent', () => {
    const opening = 4210.55
    const closing = fromCents(cents(opening) + cents(fiftyCredits) - cents(fiftyDebits))
    const r = reconcile(totals(opening, fiftyCredits, fiftyDebits, closing))
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('balances fifty repetitions of 0.10, which sum to 5.000000000000004 in raw IEEE arithmetic', () => {
    const credits = sumExact(Array.from({ length: 50 }, () => 0.1))
    const r = reconcile(totals(0, credits, 0, 5))
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('balances the classic 0.1 + 0.2 case that raw arithmetic puts at 0.30000000000000004', () => {
    const r = reconcile(totals(0, 0.3, 0, 0.1 + 0.2))
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('still fails a fifty-transaction month that is genuinely one cent and a bit out', () => {
    const opening = 4210.55
    const exact = fromCents(cents(opening) + cents(fiftyCredits) - cents(fiftyDebits))
    const r = reconcile(totals(opening, fiftyCredits, fiftyDebits, fromCents(cents(exact) + 2)))
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(-0.02)
  })

  it('does not let large balances swallow a one-cent discrepancy', () => {
    const r = reconcile(totals(8_388_608.01, 0.02, 0, 8_388_608.05))
    expect(norm(r.difference)).toBe(-0.02)
    expect(r.balanced).toBe(false)
  })
})

describe('reconcile — an explicit tolerance', () => {
  it('requires an exact match when the tolerance is zero', () => {
    expect(reconcile(totals(1000, 500, 200, 1300), 0).balanced).toBe(true)
    expect(reconcile(totals(1000, 500, 200, 1299.99), 0).balanced).toBe(false)
    expect(reconcile(totals(1000, 500, 200, 1300.01), 0).balanced).toBe(false)
  })

  it.each([
    [0.05, 1299.95, true],
    [0.05, 1300.05, true],
    [0.05, 1299.94, false],
    [0.05, 1300.06, false],
    [1, 1299, true],
    [1, 1301, true],
    [1, 1298.99, false],
    [1, 1301.01, false],
    [1000, 300, true],
    [1000, 299.99, false],
  ])('with tolerance %j and closing %j reports balanced=%j', (tolerance, closing, expected) => {
    expect(reconcile(totals(1000, 500, 200, closing as number), tolerance as number).balanced).toBe(
      expected,
    )
  })

  it('falls back to the ±0.01 default when the tolerance argument is omitted', () => {
    expect(reconcile(totals(1000, 500, 200, 1299.99)).balanced).toBe(true)
    expect(reconcile(totals(1000, 500, 200, 1299.98)).balanced).toBe(false)
  })

  it('falls back to the ±0.01 default when the tolerance argument is explicitly undefined', () => {
    expect(reconcile(totals(1000, 500, 200, 1299.99), undefined).balanced).toBe(true)
    expect(reconcile(totals(1000, 500, 200, 1299.98), undefined).balanced).toBe(false)
  })

  it('reports the same difference regardless of the tolerance in force', () => {
    const t = totals(1000, 500, 200, 1299.5)
    expect(norm(reconcile(t, 0).difference)).toBe(0.5)
    expect(norm(reconcile(t, 0.01).difference)).toBe(0.5)
    expect(norm(reconcile(t, 10).difference)).toBe(0.5)
  })
})

describe('reconcile — malformed, absent and adversarial input', () => {
  it.each([
    ['openingBalance is NaN', totals(NaN, 500, 200, 1300)],
    ['totalCredits is NaN', totals(1000, NaN, 200, 1300)],
    ['totalDebits is NaN', totals(1000, 500, NaN, 1300)],
    ['closingBalance is NaN', totals(1000, 500, 200, NaN)],
    ['every field is NaN', totals(NaN, NaN, NaN, NaN)],
    ['openingBalance is Infinity', totals(Infinity, 500, 200, 1300)],
    ['closingBalance is -Infinity', totals(1000, 500, 200, -Infinity)],
    ['credits and closing are both Infinity', totals(0, Infinity, 0, Infinity)],
  ])('never claims a statement balances when %s', (_name, t) => {
    expect(neverClaimsBalanced(t)).toBe(true)
  })

  it.each([
    ['openingBalance', { closingBalance: 1300, totalCredits: 500, totalDebits: 200 }],
    ['closingBalance', { openingBalance: 1000, totalCredits: 500, totalDebits: 200 }],
    ['totalCredits', { openingBalance: 1000, closingBalance: 1300, totalDebits: 200 }],
    ['totalDebits', { openingBalance: 1000, closingBalance: 1300, totalCredits: 500 }],
    ['all four fields', {}],
  ])('never claims a statement balances when %s is absent', (_name, partial) => {
    expect(neverClaimsBalanced(partial as unknown as StatementTotals)).toBe(true)
  })

  it.each([
    ['openingBalance', { openingBalance: null, closingBalance: 1300, totalCredits: 500, totalDebits: 200 }],
    ['closingBalance', { openingBalance: 1000, closingBalance: null, totalCredits: 500, totalDebits: 200 }],
    ['totalCredits', { openingBalance: 1000, closingBalance: 1300, totalCredits: null, totalDebits: 200 }],
    ['totalDebits', { openingBalance: 1000, closingBalance: 1300, totalCredits: 500, totalDebits: null }],
  ])('never claims a statement balances when %s is null', (_name, t) => {
    expect(neverClaimsBalanced(t as unknown as StatementTotals)).toBe(true)
  })

  it('rejects a missing totals object rather than treating it as a zero statement', () => {
    expect(() => reconcile(null as unknown as StatementTotals)).toThrow()
    expect(() => reconcile(undefined as unknown as StatementTotals)).toThrow()
  })

  it('never claims a statement balances when the tolerance itself is NaN', () => {
    expect(neverClaimsBalanced(totals(1000, 500, 200, 1300), NaN)).toBe(true)
  })

  it('flags a statement whose credits and debits are both negative — a sign-parse failure', () => {
    // Credits and debits arrive as magnitudes; negatives mean the header was misread.
    const r = reconcile(totals(1000, -500, -200, 1300))
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(-600)
  })

  it('flags a statement where the parser produced nothing but the balances moved', () => {
    const r = reconcile(totals(1000, 0, 0, 1300))
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(-300)
  })
})

describe('reconcile — purity and self-consistency', () => {
  it('does not mutate the totals it was given', () => {
    const t = totals(1000, 500, 200, 1300)
    const snapshot = { ...t }
    reconcile(t)
    expect(t).toEqual(snapshot)
  })

  it('returns the same result for the same input every time', () => {
    const t = totals(1234.56, 789.01, 234.5, 1789.07)
    expect(reconcile(t)).toEqual(reconcile(t))
  })

  it('works on a frozen totals object', () => {
    const t = Object.freeze(totals(1000, 500, 200, 1300))
    expect(reconcile(t).balanced).toBe(true)
  })

  it.each([
    [totals(1000, 500, 200, 1300), 0.01],
    [totals(1000, 500, 200, 1299.99), 0.01],
    [totals(1000, 500, 200, 1299.98), 0.01],
    [totals(-500, 0, 250, -750), 0.01],
    [totals(0, 0, 0, 12.34), 0.01],
    [totals(1000, 500, 200, 1295), 5],
    [totals(1000, 500, 200, 1294.99), 5],
  ])('reports balanced exactly when |difference| is within the tolerance (case %#)', (t, tol) => {
    const r = reconcile(t, tol)
    expect(r.balanced).toBe(Math.abs(r.difference) <= tol)
  })
})

describe('totalsFromTransactions — splitting signed amounts', () => {
  it('returns zero credits and zero debits for a statement with no transactions', () => {
    const r = totalsFromTransactions([])
    expect(norm(r.totalCredits)).toBe(0)
    expect(norm(r.totalDebits)).toBe(0)
  })

  it('counts a positive amount as a credit', () => {
    const r = totalsFromTransactions([100])
    expect(norm(r.totalCredits)).toBe(100)
    expect(norm(r.totalDebits)).toBe(0)
  })

  it('counts a negative amount as a debit and reports it as a positive magnitude', () => {
    // The guard is opening + credits - debits, so debits must not arrive pre-negated.
    const r = totalsFromTransactions([-100])
    expect(norm(r.totalCredits)).toBe(0)
    expect(norm(r.totalDebits)).toBe(100)
  })

  it.each([
    ['a single salary credit', [85000], 85000, 0],
    ['a single card debit', [-1249.99], 0, 1249.99],
    ['a mixed month', [100, -40, 30, -10], 130, 50],
    ['only debits', [-1, -2, -3.5], 0, 6.5],
    ['only credits', [1, 2, 3.5], 6.5, 0],
    ['zero amounts contribute to neither side', [0, 0, 0], 0, 0],
    ['negative zero is not a debit', [-0], 0, 0],
    ['zero mixed with real movement', [0, 50, -20, 0], 50, 20],
    ['two identical same-day charges are both counted', [-320, -320], 0, 640],
    ['large amounts', [9_876_543.21, -1_234_567.89], 9_876_543.21, 1_234_567.89],
  ])('splits %s', (_name, amounts, credits, debits) => {
    const r = totalsFromTransactions(amounts as number[])
    expect(norm(r.totalCredits)).toBe(credits)
    expect(norm(r.totalDebits)).toBe(debits)
  })

  it('sums 0.1 and 0.2 to exactly 0.30, not 0.30000000000000004', () => {
    const r = totalsFromTransactions([0.1, 0.2])
    expect(norm(r.totalCredits)).toBe(0.3)
  })

  it('sums fifty debits of 0.10 to exactly 5.00', () => {
    const r = totalsFromTransactions(Array.from({ length: 50 }, () => -0.1))
    expect(norm(r.totalDebits)).toBe(5)
    expect(norm(r.totalCredits)).toBe(0)
  })

  it('sums a realistic fifty-transaction month to the cent', () => {
    const r = totalsFromTransactions(fiftyAmounts)
    expect(norm(r.totalCredits)).toBe(fiftyCredits)
    expect(norm(r.totalDebits)).toBe(fiftyDebits)
  })

  it('is order-independent', () => {
    const forward = totalsFromTransactions(fiftyAmounts)
    const backward = totalsFromTransactions([...fiftyAmounts].reverse())
    expect(norm(backward.totalCredits)).toBe(norm(forward.totalCredits))
    expect(norm(backward.totalDebits)).toBe(norm(forward.totalDebits))
  })

  it('does not mutate the amounts it was given', () => {
    const amounts = [100, -40, 30]
    const snapshot = [...amounts]
    totalsFromTransactions(amounts)
    expect(amounts).toEqual(snapshot)
  })

  it.each([
    ['a NaN amount', [100, NaN, -40]],
    ['an Infinite amount', [100, Infinity]],
    ['a -Infinite amount', [-Infinity, 5]],
  ])('never returns a plausible finite total when the list contains %s', (_name, amounts) => {
    expect(neverYieldsPlausibleTotals(amounts as number[])).toBe(true)
  })

  it('rejects a missing amounts list rather than treating it as an empty statement', () => {
    expect(() => totalsFromTransactions(null as unknown as number[])).toThrow()
    expect(() => totalsFromTransactions(undefined as unknown as number[])).toThrow()
  })
})

describe('the guard end to end — parsed transactions against the statement header', () => {
  it('balances when every parsed transaction is accounted for', () => {
    const amounts = [1200.5, -300.25, -49.99, 80, -15.5]
    const opening = 5000
    const t = totalsFromTransactions(amounts)
    const closing = fromCents(cents(opening) + cents(t.totalCredits) - cents(t.totalDebits))
    const r = reconcile({
      openingBalance: opening,
      closingBalance: closing,
      totalCredits: t.totalCredits,
      totalDebits: t.totalDebits,
    })
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('balances a fifty-transaction month end to end without float drift', () => {
    const opening = 4210.55
    const t = totalsFromTransactions(fiftyAmounts)
    const closing = fromCents(cents(opening) + cents(fiftyCredits) - cents(fiftyDebits))
    const r = reconcile({
      openingBalance: opening,
      closingBalance: closing,
      totalCredits: t.totalCredits,
      totalDebits: t.totalDebits,
    })
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('fails by exactly the amount of a debit the parser dropped', () => {
    const opening = 5000
    const full = [1200.5, -300.25, -49.99, 80, -15.5]
    const dropped = full.filter((a) => a !== -49.99)
    const stated = totalsFromTransactions(full)
    const statedClosing = fromCents(
      cents(opening) + cents(stated.totalCredits) - cents(stated.totalDebits),
    )
    const parsed = totalsFromTransactions(dropped)
    const r = reconcile({
      openingBalance: opening,
      closingBalance: statedClosing,
      totalCredits: parsed.totalCredits,
      totalDebits: parsed.totalDebits,
    })
    expect(r.balanced).toBe(false)
    // The missing debit leaves us expecting 49.99 more money than the bank reports.
    expect(norm(r.difference)).toBe(49.99)
  })

  it('fails by exactly the amount of a credit the parser dropped', () => {
    const opening = 5000
    const full = [1200.5, -300.25, 80]
    const dropped = full.filter((a) => a !== 80)
    const stated = totalsFromTransactions(full)
    const statedClosing = fromCents(
      cents(opening) + cents(stated.totalCredits) - cents(stated.totalDebits),
    )
    const parsed = totalsFromTransactions(dropped)
    const r = reconcile({
      openingBalance: opening,
      closingBalance: statedClosing,
      totalCredits: parsed.totalCredits,
      totalDebits: parsed.totalDebits,
    })
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(-80)
  })

  it('fails when the parser read a debit as a credit — a sign flip doubles the error', () => {
    const opening = 1000
    const stated = totalsFromTransactions([-250])
    const statedClosing = fromCents(
      cents(opening) + cents(stated.totalCredits) - cents(stated.totalDebits),
    )
    const parsed = totalsFromTransactions([250])
    const r = reconcile({
      openingBalance: opening,
      closingBalance: statedClosing,
      totalCredits: parsed.totalCredits,
      totalDebits: parsed.totalDebits,
    })
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(500)
  })

  it('balances a month with no transactions at all against an unchanged balance', () => {
    const t = totalsFromTransactions([])
    const r = reconcile({
      openingBalance: 812.4,
      closingBalance: 812.4,
      totalCredits: t.totalCredits,
      totalDebits: t.totalDebits,
    })
    expect(r.balanced).toBe(true)
    expect(norm(r.difference)).toBe(0)
  })

  it('fails a month with no parsed transactions when the balance did move', () => {
    const t = totalsFromTransactions([])
    const r = reconcile({
      openingBalance: 812.4,
      closingBalance: 512.4,
      totalCredits: t.totalCredits,
      totalDebits: t.totalDebits,
    })
    expect(r.balanced).toBe(false)
    expect(norm(r.difference)).toBe(300)
  })
})
