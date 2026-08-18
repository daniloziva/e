import { describe, expect, it } from 'vitest'
import { parseAmount } from '../../src/engine/money.js'
import {
  RATE_STALENESS_MAX_DAYS,
  isRateStale,
  isRateUsableForConfirm,
  parseNbsDate,
  parseSerbianRate,
  rateAgeInDays,
  resolveRate,
  selectRate,
  toBookCurrency,
  toQuotes,
  type RateQuote,
  type RawRateRow,
} from '../../src/engine/rates.js'

const EUR = 117.5
const USD = 101

const row = (over: Partial<RawRateRow> = {}): RawRateRow => ({
  code: 'EUR',
  formedOn: '14.8.2026.',
  appliesOn: '15.8.2026.',
  unit: '1',
  middleRate: '117,3433',
  ...over,
})

const quote = (over: Partial<RateQuote> = {}): RateQuote => ({
  currency: 'EUR',
  rateDate: '2026-08-17',
  formedOn: '2026-08-17',
  rate: EUR,
  ...over,
})

describe('parseSerbianRate', () => {
  it('reads a 4dp comma decimal at full precision', () => {
    expect(parseSerbianRate('117,3510')).toBe(117.351)
  })

  it('is NOT the fiscal-receipt money path, and must never become it', () => {
    expect(parseAmount('117,3510')).toBeNull()
    expect(parseAmount('101,2869')).toBeNull()
    expect(parseSerbianRate('117,3510')).toBe(117.351)
    expect(parseSerbianRate('101,2869')).toBe(101.2869)
  })

  it('refuses a DOT decimal, which is the receipt grammar and not the rate grammar', () => {
    expect(parseSerbianRate('117.3510')).toBeNull()
  })

  it('accepts 5 decimals, because NBS prints XDR at 5', () => {
    expect(parseSerbianRate('1,36584')).toBe(1.36584)
  })

  it('reads the HUF quote, which is per 100', () => {
    expect(parseSerbianRate('32,2833')).toBe(32.2833)
  })

  it.each([
    ['no decimal part', '117'],
    ['grouped thousands', '1.117,3510'],
    ['two commas', '117,35,10'],
    ['negative', '-117,3510'],
    ['trailing junk', '117,3510abc'],
    ['empty', ''],
    ['only a comma', ','],
  ])('refuses %s', (_label, text) => {
    expect(parseSerbianRate(text)).toBeNull()
  })

  it('trims surrounding whitespace from the cell text', () => {
    expect(parseSerbianRate('  117,3510  ')).toBe(117.351)
  })
})

describe('parseNbsDate', () => {
  it('ZERO-PADS a single-digit month, or every at-or-before comparison breaks', () => {
    expect(parseNbsDate('14.8.2026.')).toBe('2026-08-14')
  })

  it('zero-pads a single-digit day too', () => {
    expect(parseNbsDate('1.1.2026.')).toBe('2026-01-01')
  })

  it('accepts the form without the trailing dot', () => {
    expect(parseNbsDate('14.08.2026')).toBe('2026-08-14')
  })

  it('refuses a date that does not exist', () => {
    expect(parseNbsDate('31.2.2026.')).toBeNull()
  })

  it('refuses an ISO date, which is not the wire format', () => {
    expect(parseNbsDate('2026-08-14')).toBeNull()
  })

  it.each([
    ['slashes', '14/8/2026'],
    ['month 13', '14.13.2026.'],
    ['day 0', '0.8.2026.'],
    ['two-digit year', '14.8.26.'],
    ['empty', ''],
  ])('refuses %s', (_label, text) => {
    expect(parseNbsDate(text)).toBeNull()
  })

  it('padding is what makes the string compare a date compare', () => {
    const nine = parseNbsDate('9.8.2026.')
    const ten = parseNbsDate('10.8.2026.')
    expect(nine).toBe('2026-08-09')
    expect(ten).toBe('2026-08-10')
    expect(nine === null || ten === null ? '' : nine < ten).toBe(true)
  })
})

describe('toQuotes', () => {
  it('keys the quote on the APPLICATION date, not the formation date', () => {
    expect(toQuotes([row()])).toEqual([
      { currency: 'EUR', rateDate: '2026-08-15', formedOn: '2026-08-14', rate: 117.3433 },
    ])
  })

  it('divides by the unit UNCONDITIONALLY — the JPY-day regression', () => {
    // The unit "100" and the rate "32,2833" are the real measured HUF row; the
    // code is EUR only because the allowlist below drops HUF. The day a per-100
    // currency joins types.ts:7 this case is the only thing between it and a
    // 100x error.
    const [only] = toQuotes([row({ unit: '100', middleRate: '32,2833' })])
    expect(only?.rate).toBe(0.322833)
  })

  it('drops a currency E does not book, so dead codes never reach the ledger', () => {
    expect(toQuotes([row({ code: 'HUF' }), row({ code: 'BEF' }), row({ code: 'HRK' })])).toEqual([])
  })

  it('keeps all four foreign codes types.ts:7 allows', () => {
    const codes = toQuotes([
      row({ code: 'EUR' }),
      row({ code: 'USD' }),
      row({ code: 'CHF' }),
      row({ code: 'GBP' }),
    ]).map((q) => q.currency)
    expect(codes).toEqual(['EUR', 'USD', 'CHF', 'GBP'])
  })

  it('drops RSD, which is a constant and must never come from the page', () => {
    expect(toQuotes([row({ code: 'RSD', middleRate: '1,0000' })])).toEqual([])
  })

  it.each([
    ['an unreadable rate', { middleRate: '117.3433' }],
    ['an unreadable application date', { appliesOn: 'n/a' }],
    ['a unit of zero', { unit: '0' }],
    ['a non-numeric unit', { unit: 'jedan' }],
  ])('drops a row with %s rather than guessing', (_label, over) => {
    expect(toQuotes([row(over)])).toEqual([])
  })

  it('falls back to the application date when only the formation date is unreadable', () => {
    const [only] = toQuotes([row({ formedOn: '' })])
    expect(only?.formedOn).toBe('2026-08-15')
    expect(only?.rateDate).toBe('2026-08-15')
  })

  it('keeps the good rows when one row in the response is junk', () => {
    const kept = toQuotes([row({ code: 'EUR' }), row({ code: 'USD', middleRate: 'x' }), row({ code: 'CHF' })])
    expect(kept.map((q) => q.currency)).toEqual(['EUR', 'CHF'])
  })
})

describe('selectRate', () => {
  const HELD = [
    quote({ rateDate: '2026-08-14', rate: 117.3433 }),
    quote({ rateDate: '2026-08-17', rate: EUR }),
    quote({ currency: 'USD', rateDate: '2026-08-18', rate: USD }),
  ]

  it('prefers the exact date', () => {
    expect(selectRate(HELD, 'EUR', '2026-08-17')?.rateDate).toBe('2026-08-17')
  })

  it('never returns a rate from AFTER the document date', () => {
    expect(selectRate(HELD, 'EUR', '2026-08-16')?.rateDate).toBe('2026-08-14')
  })

  it('is order-independent: a reversed array selects the same row', () => {
    expect(selectRate([...HELD].reverse(), 'EUR', '2026-08-16')?.rateDate).toBe('2026-08-14')
  })

  it('never crosses currencies, however much closer the other date is', () => {
    expect(selectRate(HELD, 'CHF', '2026-08-18')).toBeNull()
  })

  it('returns null when every held row is newer than the document — the same-day window', () => {
    expect(selectRate([quote({ rateDate: '2026-08-18' })], 'EUR', '2026-08-17')).toBeNull()
  })

  it('returns null for an empty table', () => {
    expect(selectRate([], 'EUR', '2026-08-17')).toBeNull()
  })

  it('treats a duplicate insert of the same dated rate as one row', () => {
    expect(selectRate([quote(), quote()], 'EUR', '2026-08-17')?.rate).toBe(EUR)
  })

  it('REFUSES two different rates for one date rather than picking by array order', () => {
    const diverged = [quote({ rate: EUR }), quote({ rate: 117.3510 })]
    expect(selectRate(diverged, 'EUR', '2026-08-17')).toBeNull()
    expect(selectRate([...diverged].reverse(), 'EUR', '2026-08-17')).toBeNull()
  })
})

describe('the staleness flag and the 7-day bound are two mechanisms', () => {
  it('flags at one day', () => {
    expect(isRateStale('2026-08-16', '2026-08-17')).toBe(true)
  })

  it('does not flag an exact hit', () => {
    expect(isRateStale('2026-08-17', '2026-08-17')).toBe(false)
  })

  it('STILL flags at exactly the bound, where a merged implementation would not', () => {
    expect(RATE_STALENESS_MAX_DAYS).toBe(7)
    expect(isRateStale('2026-08-10', '2026-08-17')).toBe(true)
    expect(isRateUsableForConfirm('2026-08-10', '2026-08-17')).toBe(true)
  })

  it('is usable at the bound and unusable one day past it', () => {
    expect(isRateUsableForConfirm('2026-08-10', '2026-08-17')).toBe(true)
    expect(isRateUsableForConfirm('2026-08-09', '2026-08-17')).toBe(false)
  })

  it('counts whole days across a spring-forward, where a local-time clock loses one', () => {
    // Europe/Belgrade springs forward 2026-03-29; vitest runs in that zone.
    expect(rateAgeInDays('2026-03-26', '2026-04-02')).toBe(7)
    expect(isRateUsableForConfirm('2026-03-25', '2026-04-02')).toBe(false)
  })

  it('counts whole days across an autumn fall-back', () => {
    expect(rateAgeInDays('2026-10-22', '2026-10-29')).toBe(7)
  })

  it('refuses a rate dated after the document', () => {
    expect(isRateUsableForConfirm('2026-08-18', '2026-08-17')).toBe(false)
  })

  it('refuses an unparseable pair rather than treating it as fresh', () => {
    expect(rateAgeInDays('not-a-date', '2026-08-17')).toBeNull()
    expect(isRateUsableForConfirm('not-a-date', '2026-08-17')).toBe(false)
  })
})

describe('resolveRate', () => {
  it('answers RSD from a constant with an EMPTY table', () => {
    expect(resolveRate([], 'RSD', '2026-08-17')).toEqual({ rate: 1, rateDate: '2026-08-17' })
  })

  it('answers RSD from the constant even if a bogus RSD row was stored', () => {
    const bogus = [quote({ currency: 'RSD' as RateQuote['currency'], rate: 999 })]
    expect(resolveRate(bogus, 'RSD', '2026-08-17')).toEqual({ rate: 1, rateDate: '2026-08-17' })
  })

  it('never flags an RSD row as stale, on any date', () => {
    const resolved = resolveRate([], 'RSD', '2026-01-01')
    expect(resolved === null ? true : isRateStale(resolved.rateDate, '2026-01-01')).toBe(false)
  })

  it('carries the rate DATE, not the document date, for a stale foreign hit', () => {
    expect(resolveRate([quote({ rateDate: '2026-08-14' })], 'EUR', '2026-08-17')).toEqual({
      rate: EUR,
      rateDate: '2026-08-14',
    })
  })

  it('returns null when the currency has never been fetched', () => {
    expect(resolveRate([quote()], 'CHF', '2026-08-17')).toBeNull()
  })
})

describe('toBookCurrency', () => {
  it('is free for an RSD book', () => {
    expect(toBookCurrency(47000, { rate: 1, rateDate: '2026-08-17' })).toBe(47000)
  })

  it('DIVIDES by the book rate — multiplying is the inverted implementation', () => {
    const inBook = toBookCurrency(60000, { rate: EUR, rateDate: '2026-08-17' })
    expect(inBook).toBeCloseTo(510.6382978723404, 10)
  })

  it('does not round before the comparison', () => {
    // 58749.5 / 117.5 = 499.99574..., which round2 would lift to 500.00 and
    // over a 500 threshold. The money never crossed it.
    const inBook = toBookCurrency(58749.5, { rate: EUR, rateDate: '2026-08-17' })
    expect(inBook === null ? 0 : inBook < 500).toBe(true)
  })

  it.each([
    ['an unconverted amount', null, { rate: EUR, rateDate: '2026-08-17' }],
    ['no book rate', 47000, null],
  ])('returns null for %s', (_label, amountRsd, bookRate) => {
    expect(toBookCurrency(amountRsd, bookRate)).toBeNull()
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s book rate, exactly as toRsd does', (_label, rate) => {
    expect(toBookCurrency(47000, { rate, rateDate: '2026-08-17' })).toBeNull()
  })
})
