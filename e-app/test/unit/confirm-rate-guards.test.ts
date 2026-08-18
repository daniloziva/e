import { describe, expect, it } from 'vitest'
import { decide } from '../../src/engine/nlu/confirm-policy.js'
import type { Interpretation } from '../../src/engine/nlu/interpret.js'
import { resolveRate, toBookCurrency, type RateQuote } from '../../src/engine/rates.js'
import type { Book, Currency, DimensionAxisDef, Money } from '../../src/engine/types.js'

// The ruled test rates (10-LCY.md §5). Deliberately not live values.
const RATES: Record<'EUR' | 'USD' | 'CHF' | 'GBP', number> = {
  EUR: 117.5,
  USD: 101,
  CHF: 125,
  GBP: 136,
}
const D = '2026-08-17'

const HELD: RateQuote[] = (['EUR', 'USD', 'CHF', 'GBP'] as const).map((currency) => ({
  currency,
  rateDate: D,
  formedOn: D,
  rate: RATES[currency],
}))

const NO_AXES: DimensionAxisDef[] = []

const money = (amount: number, currency: Currency): Money => ({ amount, currency })

const interpretation = (m: Money | null): Interpretation => ({
  slots: { money: m, dimensions: {}, description: null, date: null },
  confidence: 'exact',
  sources: {},
  conflicts: [],
})

const book = (currency: Currency, confirmAboveAmount: number): Book => ({
  code: 'DILIGAF',
  name: 'B',
  senderPhones: [],
  blobPrefix: 'b/',
  defaultCategory: 'expense',
  accountantEmail: null,
  currency,
  dimensions: NO_AXES,
  features: { sef: false, invoicing: false, vat: null, confirmAboveAmount },
})

/**
 * What app/ will do, in three lines, so the cases below assert the composition
 * and not a hand-computed constant. Two rate reads per decision (C1).
 */
function inBookCurrency(m: Money, b: Book, quotes: RateQuote[] = HELD): number | null {
  const txRate = resolveRate(quotes, m.currency, D)
  const bookRate = resolveRate(quotes, b.currency, D)
  if (txRate === null) return null
  return toBookCurrency(m.amount * txRate.rate, bookRate)
}

const call = (m: Money, b: Book, quotes: RateQuote[] = HELD) =>
  decide(interpretation(m), b, inBookCurrency(m, b, quotes))

describe('CANDIDATE-006 — the threshold is in the BOOK currency', () => {
  it('400 EUR against a 500 threshold on an RSD book must CONFIRM', () => {
    // The whole behavioural content of CANDIDATE-006. 400 EUR = 47,000 RSD.
    // The pre-LCY engine compares 400 >= 500 and commits: a ~117x hole.
    expect(call(money(400, 'EUR'), book('RSD', 500))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('50,000 RSD against a 500 threshold on an EUR book must COMMIT', () => {
    // The sibling that stops the guard inverting. 50,000 RSD = 425.53 EUR.
    // The pre-LCY engine compares 50000 >= 500 and confirms.
    expect(call(money(50000, 'RSD'), book('EUR', 500))).toEqual({ action: 'commit' })
  })

  it('60,000 RSD against a 500 threshold on an EUR book confirms', () => {
    // 510.64 EUR. Same direction as the old answer, so it is here only to pin
    // that fixing the case above did not disable the gate on this side.
    expect(call(money(60000, 'RSD'), book('EUR', 500))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('550 USD against a 500 threshold on an EUR book must COMMIT', () => {
    // Neither currency is the other's: 550 USD = 55,550 RSD = 472.77 EUR.
    // Skipping the division by the BOOK rate confirms instead.
    expect(call(money(550, 'USD'), book('EUR', 500))).toEqual({ action: 'commit' })
  })

  it('600 USD against a 500 threshold on an EUR book confirms', () => {
    expect(call(money(600, 'USD'), book('EUR', 500))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('is at-or-above, at the converted boundary', () => {
    // 400 EUR is exactly 47,000 RSD at the ruled rate.
    expect(call(money(400, 'EUR'), book('RSD', 47000))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
    expect(call(money(399.99, 'EUR'), book('RSD', 47000))).toEqual({ action: 'commit' })
  })

  it('does not round the converted amount up over the threshold', () => {
    // 58,749.5 RSD = 499.99574... EUR. round2 lifts it to 500.00 and confirms.
    expect(call(money(58749.5, 'RSD'), book('EUR', 500))).toEqual({ action: 'commit' })
  })

  it('leaves the currency-matched cases exactly where the frozen suite has them', () => {
    expect(call(money(400, 'EUR'), book('EUR', 500))).toEqual({ action: 'commit' })
    expect(call(money(500, 'EUR'), book('EUR', 500))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
    expect(call(money(19999, 'RSD'), book('RSD', 20000))).toEqual({ action: 'commit' })
    expect(call(money(20000, 'RSD'), book('RSD', 20000))).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('an RSD receipt on an RSD book needs no rate at all', () => {
    // Empty table, so a cache miss cannot make a dinar receipt need a tap.
    // PERSONAL is entirely RSD and the highest-volume book.
    expect(call(money(1500, 'RSD'), book('RSD', 20000), [])).toEqual({ action: 'commit' })
  })

  it('compares the CONVERTED amount and nothing else', () => {
    // Kills a mutant that ORs the raw amount back in.
    expect(decide(interpretation(money(100, 'EUR')), book('RSD', 500), 600)).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
    expect(decide(interpretation(money(600, 'EUR')), book('RSD', 500), 100)).toEqual({
      action: 'commit',
    })
  })
})

describe('no rate — the tap, not a guess', () => {
  it('confirms with reason no_rate when the conversion failed', () => {
    expect(decide(interpretation(money(300, 'EUR')), book('RSD', 500), null)).toEqual({
      action: 'confirm',
      reason: 'no_rate',
    })
  })

  it('takes the tap for a currency never fetched, however small the amount', () => {
    // 1 CHF on an empty table. Committing here would not be committing a small
    // amount, it would be committing past a gate that was never evaluated.
    expect(call(money(1, 'CHF'), book('RSD', 500), [])).toEqual({
      action: 'confirm',
      reason: 'no_rate',
    })
  })

  it('takes the tap when the BOOK currency is the one missing', () => {
    // C1's consequence: two reads, and a miss on either means the tap.
    const eurOnly = HELD.filter((q) => q.currency === 'EUR')
    expect(call(money(300, 'EUR'), book('GBP', 500), eurOnly)).toEqual({
      action: 'confirm',
      reason: 'no_rate',
    })
  })

  it('distinguishes an OMITTED conversion from a FAILED one', () => {
    // The three-state contract. Omitting the argument is the legacy arity every
    // frozen call site uses; passing null is "asked, and could not".
    const m = money(400, 'EUR')
    const b = book('RSD', 500)
    expect(decide(interpretation(m), b)).toEqual({ action: 'commit' })
    expect(decide(interpretation(m), b, null)).toEqual({ action: 'confirm', reason: 'no_rate' })
  })

  it('does not let no_rate outrank a missing slot', () => {
    expect(decide(interpretation(null), book('RSD', 500), null)).toEqual({
      action: 'ask',
      missing: ['money'],
    })
  })

  it('does not let no_rate outrank a conflict', () => {
    const i: Interpretation = { ...interpretation(money(300, 'EUR')), conflicts: ['money'] }
    expect(decide(i, book('RSD', 500), null)).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('does not let no_rate outrank low confidence', () => {
    const i: Interpretation = { ...interpretation(money(300, 'EUR')), confidence: 'low' }
    expect(decide(i, book('RSD', 500), null)).toEqual({
      action: 'confirm',
      reason: 'low_confidence',
    })
  })
})
