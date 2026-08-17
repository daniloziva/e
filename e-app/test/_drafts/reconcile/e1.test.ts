import { describe, it, expect } from 'vitest'
import {
  reconcile,
  totalsFromTransactions,
  type StatementTotals,
} from '../../../src/engine/statements/reconcile.js'

/**
 * Statement reconciliation guard — 04-PERSONAL §2 "The reconciliation guard (non-negotiable)".
 *
 *   assert  opening + Σcredits − Σdebits ≈ closing   (±0.01)
 *
 * difference is defined by the contract as `expectedClosing - closingBalance`, rounded to 2dp.
 * A statement either balances or announces that it doesn't; it must never *claim* to balance
 * on input it cannot evaluate.
 */

/** `toBe(0)` uses Object.is, which distinguishes -0 from 0. Signed zero is not a behaviour. */
function expectZero(n: number): void {
  expect(Math.abs(n)).toBe(0)
}

function totals(
  openingBalance: number,
  totalCredits: number,
  totalDebits: number,
  closingBalance: number,
): StatementTotals {
  return { openingBalance, totalCredits, totalDebits, closingBalance }
}

/** 50 alternating amounts of 0.07, 0.14, 0.21 … — decimal-exact credits 43.75, debits 45.50. */
const FIFTY_AMOUNTS: number[] = Array.from({ length: 50 }, (_, i) =>
  (i % 2 === 0 ? 1 : -1) * Number((((i + 1) * 7) / 100).toFixed(2)),
)
const FIFTY_CREDITS = 43.75
const FIFTY_DEBITS = 45.5
const FIFTY_NET = -1.75

describe('reconcile — a statement that balances', () => {
  it('reports a statement whose own balances agree with its totals as balanced', () => {
    const result = reconcile(totals(1000, 250, 100, 1150))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(1150)
    expectZero(result.difference)
  })

  it.each<[string, StatementTotals, number]>([
    ['no movement at all', totals(0, 0, 0, 0), 0],
    ['credits only', totals(500, 125.5, 0, 625.5), 625.5],
    ['debits only', totals(500, 0, 125.5, 374.5), 374.5],
    ['a full month of movement', totals(128456.78, 210000, 187654.32, 150802.46), 150802.46],
    ['an account emptied to exactly zero', totals(900.25, 0, 900.25, 0), 0],
    ['sub-unit amounts', totals(0.01, 0.02, 0.02, 0.01), 0.01],
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

describe('reconcile — the ±0.01 tolerance boundary', () => {
  it.each<[number, number, boolean]>([
    // stated closing, difference (expected - closing), balanced
    [999.98, 0.02, false],
    [999.99, 0.01, true],
    [1000.0, 0, true],
    [1000.01, -0.01, true],
    [1000.02, -0.02, false],
  ])(
    'a stated closing of %s against an expected 1000 gives a difference of %s and balanced=%s',
    (closing, expectedDifference, balanced) => {
      const result = reconcile(totals(1000, 0, 0, closing))

      expect(result.expectedClosing).toBe(1000)
      if (expectedDifference === 0) expectZero(result.difference)
      else expect(result.difference).toBe(expectedDifference)
      expect(result.balanced).toBe(balanced)
    },
  )

  it('stays balanced at exactly +0.01 when the operands carry binary floating-point noise', () => {
    // 0.1 + 0.2 === 0.30000000000000004, so the raw difference is 0.010000000000000064 —
    // just over the tolerance. Rounded to 2dp it is exactly 0.01 and the statement balances.
    const result = reconcile(totals(0.1, 0.2, 0, 0.29))

    expect(result.difference).toBe(0.01)
    expect(result.balanced).toBe(true)
  })

  it('stays balanced at exactly -0.01 when the operands carry binary floating-point noise', () => {
    const result = reconcile(totals(0.1, 0.2, 0, 0.31))

    expect(result.difference).toBe(-0.01)
    expect(result.balanced).toBe(true)
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

describe('reconcile — floating-point accumulation must not fake a failure', () => {
  it('balances fifty ten-cent credits against a five-dinar movement', () => {
    // Adding 0.1 fifty times gives 4.999999999999998, not 5.
    const credits = Array.from({ length: 50 }, () => 0.1).reduce((a, b) => a + b, 0)
    const result = reconcile(totals(0, credits, 0, 5))

    expect(result.balanced).toBe(true)
    expectZero(result.difference)
  })

  it('balances when the debit total arrives with accumulated binary error', () => {
    // 45.49999999999999 is what summing the fifty statement amounts actually produces.
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

describe('reconcile — negative balances', () => {
  it('balances a statement that stays in overdraft all month', () => {
    const result = reconcile(totals(-500, 100, 200, -600))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(-600)
    expectZero(result.difference)
  })

  it('balances an account that crosses from credit into overdraft', () => {
    const result = reconcile(totals(250, 0, 900, -650))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(-650)
    expectZero(result.difference)
  })

  it('balances an account that recovers from overdraft into credit', () => {
    const result = reconcile(totals(-300, 1000, 200, 500))

    expect(result.balanced).toBe(true)
    expect(result.expectedClosing).toBe(500)
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

describe('reconcile — difference sign convention as a parser diagnostic', () => {
  it('returns a positive difference when the parser missed a debit', () => {
    // Real debits were 500; only 400 was parsed, so we expect more money left than the bank states.
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

describe('reconcile — the tolerance argument', () => {
  it('uses the ±0.01 default when the tolerance argument is omitted', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99)).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.98)).balanced).toBe(false)
  })

  it('uses the ±0.01 default when the tolerance argument is explicitly undefined', () => {
    expect(reconcile(totals(1000, 0, 0, 999.99), undefined).balanced).toBe(true)
    expect(reconcile(totals(1000, 0, 0, 999.98), undefined).balanced).toBe(false)
  })

  it.each<[number, number, boolean]>([
    // tolerance, stated closing (expected 1000), balanced
    [0, 1000, true],
    [0, 999.99, false],
    [0.01, 999.99, true],
    [0.5, 999.5, true],
    [0.5, 999.49, false],
    [5, 995, true],
    [1000, 1240, false],
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

  it.each<[string]>([
    ['openingBalance'],
    ['closingBalance'],
    ['totalCredits'],
    ['totalDebits'],
  ])('refuses to report balanced when %s is absent from the totals', (field) => {
    const input = totals(1000, 0, 0, 1000) as unknown as Record<string, number | undefined>
    input[field] = undefined

    expect(reconcile(input as unknown as StatementTotals).balanced).toBe(false)
  })

  it.each<[string, unknown]>([
    ['a string opening balance', { openingBalance: '1000', totalCredits: 0, totalDebits: 0, closingBalance: 1000 }],
    ['a string credit total', { openingBalance: 1000, totalCredits: '0', totalDebits: 0, closingBalance: 1000 }],
    ['a null closing balance', { openingBalance: 1000, totalCredits: 0, totalDebits: 0, closingBalance: null }],
  ])('refuses to report balanced for %s rather than coercing it', (_label, input) => {
    expect(reconcile(input as unknown as StatementTotals).balanced).toBe(false)
  })
})

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
    const result = totalsFromTransactions(amounts as number[])

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

  it('does not mutate the array of amounts it was given', () => {
    const amounts = [100, -40, 0, -0.01]
    const snapshot = [...amounts]

    totalsFromTransactions(amounts)

    expect(amounts).toEqual(snapshot)
  })

  it('accumulates tenths without drifting more than a hundredth', () => {
    const result = totalsFromTransactions(Array.from({ length: 50 }, () => 0.1))

    expect(result.totalCredits).toBeCloseTo(5, 2)
    expectZero(result.totalDebits)
  })
})

describe('totalsFromTransactions feeding reconcile — the guard end to end', () => {
  it('passes a statement whose parsed transactions explain the balance change exactly', () => {
    const amounts = [-1200.5, 45000, -320.75, -89.99, -15000, 250]
    const net = amounts.reduce((a, b) => a + b, 0)
    const { totalCredits, totalDebits } = totalsFromTransactions(amounts)

    const result = reconcile(totals(12345.67, totalCredits, totalDebits, Number((12345.67 + net).toFixed(2))))

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

  it('refuses to report balanced when one parsed amount is not a number', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([100, Number.NaN, -40])

    expect(reconcile(totals(1000, totalCredits, totalDebits, 1060)).balanced).toBe(false)
  })

  it('refuses to report balanced when one parsed amount is infinite', () => {
    const { totalCredits, totalDebits } = totalsFromTransactions([100, Number.POSITIVE_INFINITY, -40])

    expect(reconcile(totals(1000, totalCredits, totalDebits, 1060)).balanced).toBe(false)
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
})
