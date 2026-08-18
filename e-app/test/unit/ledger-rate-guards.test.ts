import { describe, expect, it } from 'vitest'
import { fold, invert, type LedgerEvent } from '../../src/engine/ledger/fold.js'
import { toTransaction, type RawTransaction } from '../../src/engine/ledger/normalize.js'
import type { ResolvedRate } from '../../src/engine/rates.js'
import type { Currency, Transaction } from '../../src/engine/types.js'

const EUR = 117.5
const USD = 101

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-1',
  book: 'SMOQUA',
  txDate: '2026-08-17',
  valueDate: null,
  description: 'KARTONAZA DOO',
  counterparty: 'KARTONAZA',
  amount: -300,
  currency: 'EUR',
  amountRsd: null,
  rate: null,
  rateDate: null,
  direction: 'out',
  category: 'MISC',
  dimensions: {},
  source: 'document',
  sourceDocument: null,
  dedupeKey: 'dk-1',
  reviewStatus: 'needs_review',
  createdAt: '2026-08-17T09:00:00Z',
  ...over,
})

const add = (over: Partial<Transaction> = {}): LedgerEvent => ({
  op: 'add',
  id: 'e1',
  at: '2026-08-17T09:00:00.000Z',
  tx: tx(over),
})

const setRate = (over: Record<string, unknown> = {}): LedgerEvent =>
  ({
    op: 'set_rate',
    id: 'e2',
    at: '2026-08-17T10:00:00.000Z',
    ref: 'tx-1',
    rate: EUR,
    rateDate: '2026-08-17',
    ...over,
  }) as LedgerEvent

const one = (events: LedgerEvent[]): Transaction | undefined => fold(events)[0]

const raw = (over: Partial<RawTransaction> = {}): RawTransaction => ({
  txDate: '2026-08-17',
  valueDate: null,
  description: 'KARTONAZA DOO',
  amount: -300,
  currency: 'EUR',
  balanceAfter: null,
  ...over,
})

const resolved = (rate: number, rateDate: string, currency: Currency = 'EUR'): ResolvedRate => ({ currency, rate, rateDate })

describe('toTransaction — the rate reaches the pure engine as a value', () => {
  it('stamps rate 1 and the transaction date on a dinar line', () => {
    const t = toTransaction(raw({ currency: 'RSD', amount: -1890 }), 'PERSONAL', 'i', 'dk', 'c')
    expect(t.rate).toBe(1)
    expect(t.rateDate).toBe('2026-08-17')
    expect(t.amountRsd).toBe(-1890)
  })

  it('leaves a foreign line unconverted when no rate was resolved', () => {
    const t = toTransaction(raw(), 'SMOQUA', 'i', 'dk', 'c')
    expect(t.rate).toBeNull()
    expect(t.rateDate).toBeNull()
    expect(t.amountRsd).toBeNull()
  })

  // `app/` resolves TWO structurally identical ResolvedRate values on adjacent
  // lines — the transaction's currency and the book's — so swapping them is a
  // plausible caller bug that the type cannot catch. Booking money at another
  // currency's rate is irreversible once written, so the engine refuses.
  //
  // Found by mutation: deleting the `resolved.currency !== currency` check killed
  // ZERO tests before these three existed.
  it.each([
    ['USD rate handed to a EUR line', 'EUR' as Currency, USD, 'USD' as Currency],
    ['EUR rate handed to a USD line', 'USD' as Currency, EUR, 'EUR' as Currency],
    ['EUR rate handed to a GBP line', 'GBP' as Currency, EUR, 'EUR' as Currency],
  ])('refuses to convert when a %s', (_label, lineCurrency, rate, rateCurrency) => {
    const t = toTransaction(
      raw({ currency: lineCurrency, amount: -100 }),
      'SMOQUA',
      'i',
      'dk',
      'c',
      resolved(rate, '2026-08-17', rateCurrency),
    )

    // Refused, not silently converted at the wrong rate.
    expect(t.amountRsd).toBeNull()
    expect(t.rate).toBeNull()
    expect(t.rateDate).toBeNull()
    // The original money is untouched — refusing a rate must not lose the amount.
    expect(t.amount).toBe(-100)
    expect(t.currency).toBe(lineCurrency)
  })

  it('still converts when the rate matches the line currency', () => {
    // The companion to the three above: without this, a guard that refused
    // EVERYTHING would also pass them.
    const t = toTransaction(raw({ currency: 'USD', amount: -100 }), 'SMOQUA', 'i', 'dk', 'c', resolved(USD, '2026-08-17', 'USD'))
    expect(t.amountRsd).toBe(-10100)
    expect(t.rate).toBe(USD)
  })

  it('converts a foreign line at the supplied rate, rounding the product once', () => {
    const t = toTransaction(raw(), 'SMOQUA', 'i', 'dk', 'c', resolved(EUR, '2026-08-17'))
    expect(t.rate).toBe(EUR)
    expect(t.amountRsd).toBe(-35250)
  })

  it('carries the RATE DATE, not the transaction date — the staleness flag depends on it', () => {
    // A mutant that stamps txDate here makes `rateDate !== txDate` unable to
    // fire, which silently deletes the entire staleness mechanism.
    const t = toTransaction(raw(), 'SMOQUA', 'i', 'dk', 'c', resolved(EUR, '2026-08-14'))
    expect(t.rateDate).toBe('2026-08-14')
    expect(t.txDate).toBe('2026-08-17')
    expect(t.rateDate === t.txDate).toBe(false)
  })

  it('never converts a dinar line, even if a rate is handed to it by mistake', () => {
    const t = toTransaction(
      raw({ currency: 'RSD', amount: -1890 }),
      'PERSONAL',
      'i',
      'dk',
      'c',
      resolved(EUR, '2026-08-14'),
    )
    expect(t.rate).toBe(1)
    expect(t.amountRsd).toBe(-1890)
    expect(t.rateDate).toBe('2026-08-17')
  })

  it('rounds half away from zero on the product, not toward it', () => {
    // 0.15 * 101 is 15.149999999999999 in IEEE754; a truncating conversion
    // books 15.14. -0.15 proves the sign handling in the same breath.
    expect(toTransaction(raw({ amount: 0.15, currency: 'USD' }), 'SMOQUA', 'i', 'dk', 'c', resolved(USD, '2026-08-17', 'USD')).amountRsd).toBe(15.15)
    expect(toTransaction(raw({ amount: -0.15, currency: 'USD' }), 'SMOQUA', 'i', 'dk', 'c', resolved(USD, '2026-08-17', 'USD')).amountRsd).toBe(-15.15)
    expect(toTransaction(raw({ amount: 0.15, currency: 'EUR' }), 'SMOQUA', 'i', 'dk', 'c', resolved(EUR, '2026-08-17')).amountRsd).toBe(17.63)
  })

  it.each([
    ['zero', 0],
    ['negative', -117.5],
    ['NaN', Number.NaN],
  ])('refuses a %s rate rather than booking a nonsense figure', (_label, rate) => {
    const t = toTransaction(raw(), 'SMOQUA', 'i', 'dk', 'c', resolved(rate, '2026-08-17'))
    expect(t.amountRsd).toBeNull()
  })
})

describe('set_rate — the only append-only way to attach a rate', () => {
  it('supplies a missing rate and recomputes amountRsd', () => {
    const t = one([add(), setRate()])
    expect(t?.rate).toBe(EUR)
    expect(t?.rateDate).toBe('2026-08-17')
    expect(t?.amountRsd).toBe(-35250)
  })

  it('carries a STALE rate date through, so the flag survives the correction', () => {
    const t = one([add(), setRate({ rateDate: '2026-08-14' })])
    expect(t?.rateDate).toBe('2026-08-14')
    expect(t?.txDate).toBe('2026-08-17')
  })

  it('is a NO-OP on a row that already has a rate', () => {
    // Recomputing would move a figure already sent to the accountant.
    const t = one([add({ rate: USD, rateDate: '2026-08-10', amountRsd: -30300 }), setRate()])
    expect(t?.rate).toBe(USD)
    expect(t?.rateDate).toBe('2026-08-10')
    expect(t?.amountRsd).toBe(-30300)
  })

  it('is order-independent', () => {
    const forward = one([add(), setRate()])
    const reversed = one([setRate(), add()])
    expect(reversed).toEqual(forward)
  })

  it('is idempotent when the same event blob is listed twice', () => {
    expect(one([add(), setRate(), setRate()])).toEqual(one([add(), setRate()]))
  })

  it.each([
    ['zero', { rate: 0 }],
    ['negative', { rate: -117.5 }],
    ['NaN', { rate: Number.NaN }],
    ['Infinity', { rate: Number.POSITIVE_INFINITY }],
    ['a string', { rate: '117.5' }],
    ['missing', { rate: undefined }],
    ['an empty rateDate', { rateDate: '' }],
    ['a missing rateDate', { rateDate: undefined }],
    ['a missing ref', { ref: undefined }],
  ])('drops an event whose rate is %s, leaving the row untouched', (_label, over) => {
    const t = one([add(), setRate(over)])
    expect(t?.rate).toBeNull()
    expect(t?.amountRsd).toBeNull()
  })

  it('ignores a set_rate for a transaction this window does not hold', () => {
    const t = one([add(), setRate({ ref: 'tx-9' })])
    expect(t?.rate).toBeNull()
    expect(fold([add(), setRate({ ref: 'tx-9' })])).toHaveLength(1)
  })

  it('reverts to an unconverted row when folded by a build that does not know the op', () => {
    // fold's default: arm drops an unknown op, so a rollback past this change is
    // visible as a MISSING dinar total, never as a wrong one.
    const future = { ...setRate(), op: 'set_rate_v2' } as unknown as LedgerEvent
    const t = one([add(), future])
    expect(t?.rate).toBeNull()
    expect(t?.amountRsd).toBeNull()
  })

  it('has no honest inverse', () => {
    expect(invert(setRate(), [tx()], 'e9', '2026-08-17T11:00:00.000Z')).toBeNull()
  })

  it('reads a non-positive rate off an add blob as null rather than multiplying by it', () => {
    const bad = { ...add(), tx: { ...tx(), rate: -117.5 } } as LedgerEvent
    expect(one([bad])?.rate).toBeNull()
  })

  it('reads a non-numeric rate off an add blob as null', () => {
    const bad = { ...add(), tx: { ...tx(), rate: '117.5' } } as unknown as LedgerEvent
    expect(one([bad])?.rate).toBeNull()
  })

  it('lets a repaired row be corrected afterwards, at the rate it was repaired with', () => {
    const events: LedgerEvent[] = [
      add(),
      setRate(),
      { op: 'set_amount', id: 'e3', at: '2026-08-17T11:00:00.000Z', ref: 'tx-1', amount: -400 },
    ]
    const t = one(events)
    expect(t?.amount).toBe(-400)
    expect(t?.amountRsd).toBe(-47000)
    expect(t?.rate).toBe(EUR)
  })
})
