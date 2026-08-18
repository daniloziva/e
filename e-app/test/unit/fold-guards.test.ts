import { describe, it, expect } from 'vitest'
import { fold, invert } from '../../src/engine/ledger/fold.js'
import type { LedgerEvent } from '../../src/engine/ledger/fold.js'
import type { Transaction } from '../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// SURVIVABILITY — the malformed-blob half of `fold`, which nothing covered.
//
// `TEST-FREEZE.md` permits "adding tests for new behaviour that no test covers".
// Nothing frozen is touched here, and every case below exercises a branch the
// coverage report listed as unhit on 2026-08-17.
//
// Why this module and not another: `fold` reads event blobs off storage as
// untrusted JSON, and its own header promises SURVIVABILITY — "one bad blob may
// not take out the month ... Nothing here throws." That promise had 25 unhit
// branches, including both prototype-pollution guards. A guard with no test is
// indistinguishable from a guard someone can delete.
//
// The declared `LedgerEvent` type proves nothing about a blob, so these cases
// have to hand `fold` shapes the type forbids. Each cast is deliberate and marks
// the runtime boundary the module exists to police.
// ─────────────────────────────────────────────────────────────────────────────

const tx = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-1',
  book: 'DILIGAF',
  txDate: '2026-07-02',
  valueDate: null,
  description: 'OMV Srbija',
  counterparty: 'OMV Srbija',
  amount: -4210,
  currency: 'RSD',
  amountRsd: -4210,
  rate: null,
  rateDate: null,
  direction: 'out',
  category: 'FUEL',
  dimensions: {},
  source: 'document',
  sourceDocument: null,
  dedupeKey: 'k1',
  reviewStatus: 'ok',
  createdAt: '2026-07-02T10:00:00.000Z',
  ...over,
})

const add = (over: Partial<Transaction> = {}, id = 'e1', at = '2026-07-02T10:00:00.000Z'): LedgerEvent => ({
  op: 'add',
  id,
  at,
  tx: tx(over),
})

/** A blob shape the LedgerEvent type forbids. The cast IS the test. */
const blob = (value: unknown): LedgerEvent => value as LedgerEvent

const GOOD = add({ id: 'keep-me' }, 'e0', '2026-07-01T10:00:00.000Z')

/** Every case asserts the good event still folded — a bad blob must not take out the month. */
const foldWith = (bad: LedgerEvent): Transaction[] => fold([GOOD, bad])

describe('fold survives a malformed add', () => {
  it.each([
    ['tx is not a record', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: 'nope' })],
    ['tx is an array', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: [] })],
    ['tx is null', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: null })],
    ['id is missing', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { amount: -1 } })],
    ['id is the empty string', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: '', amount: -1 } })],
    ['id is a number', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 7, amount: -1 } })],
    ['amount is missing', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 'x' } })],
    ['amount is NaN', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 'x', amount: NaN } })],
    ['amount is Infinity', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 'x', amount: Infinity } })],
    ['amount is a numeric string', blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 'x', amount: '-4210' } })],
  ])('skips the event and keeps the month when %s', (_label, bad) => {
    const out = foldWith(bad)

    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('keep-me')
  })

  it('drops only the unusable event, not the whole log', () => {
    const out = fold([GOOD, blob({ op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: { id: 'x' } }), add({ id: 'also-fine' }, 'e2', '2026-07-03T10:00:00.000Z')])

    expect(out.map((t) => t.id)).toEqual(['keep-me', 'also-fine'])
  })
})

describe('fold never lets a dimension key reach the prototype chain', () => {
  // The guards at fold.ts:99 (dimensions on an `add`) and :161 (a set_dimension
  // axis). Both were unhit, so deleting either would have gone unnoticed.
  it.each(['__proto__', 'constructor', 'prototype'])('drops the %s axis carried by an add', (axis) => {
    const out = fold([blob({
      op: 'add',
      id: 'e1',
      at: '2026-07-02T10:00:00.000Z',
      tx: { ...tx(), dimensions: { [axis]: 'evil', project: 'P1' } },
    })])

    expect(out).toHaveLength(1)
    expect(Object.hasOwn(out[0]?.dimensions ?? {}, axis)).toBe(false)
    expect(out[0]?.dimensions['project']).toBe('P1')
    expect(Object.getPrototypeOf(out[0]?.dimensions ?? {})).toBe(Object.prototype)
  })

  it.each(['__proto__', 'constructor', 'prototype'])('refuses a set_dimension on the %s axis', (axis) => {
    const out = fold([
      add({ id: 'tx-1' }),
      blob({ op: 'set_dimension', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', axis, value: 'evil' }),
    ])

    expect(out).toHaveLength(1)
    expect(Object.hasOwn(out[0]?.dimensions ?? {}, axis)).toBe(false)
  })

  it('nulls a non-string dimension value rather than carrying it through', () => {
    const out = fold([blob({
      op: 'add',
      id: 'e1',
      at: '2026-07-02T10:00:00.000Z',
      tx: { ...tx(), dimensions: { project: 42, client: 'ACME' } },
    })])

    expect(out[0]?.dimensions['project']).toBeNull()
    expect(out[0]?.dimensions['client']).toBe('ACME')
  })
})

describe('fold survives a malformed correction', () => {
  const base = add({ id: 'tx-1' })

  it.each([
    ['set_dimension with no ref', blob({ op: 'set_dimension', id: 'e2', at: '2026-07-03T10:00:00.000Z', axis: 'project', value: 'P1' })],
    ['set_dimension with an empty axis', blob({ op: 'set_dimension', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', axis: '', value: 'P1' })],
    ['set_dimension with a numeric value', blob({ op: 'set_dimension', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', axis: 'project', value: 7 })],
    ['set_amount with no ref', blob({ op: 'set_amount', id: 'e2', at: '2026-07-03T10:00:00.000Z', amount: -99 })],
    ['set_amount with a NaN amount', blob({ op: 'set_amount', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', amount: NaN })],
    ['delete with no ref', blob({ op: 'delete', id: 'e2', at: '2026-07-03T10:00:00.000Z' })],
    ['delete with an empty ref', blob({ op: 'delete', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: '' })],
    ['split with no ref', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', parts: [{ amount: -1, category: 'A' }] })],
    ['an op this build does not know', blob({ op: 'set_vendor', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', vendor: 'X' })],
    ['no op at all', blob({ id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1' })],
    ['an event that is not a record', blob('not an event')],
    ['an unparseable at', blob({ op: 'delete', id: 'e2', at: 'yesterday', ref: 'tx-1' })],
  ])('leaves the transaction untouched given %s', (_label, bad) => {
    const out = fold([base, bad])

    expect(out).toHaveLength(1)
    // Compared against the fixture, never against `out` itself — an assertion
    // that reads its own subject passes whatever the subject is.
    expect(out[0]).toEqual(tx({ id: 'tx-1' }))
    expect(out[0]?.amount).toBe(-4210)
    expect(out[0]?.dimensions).toEqual({})
  })
})

describe('fold refuses a split it cannot trust', () => {
  const base = add({ id: 'tx-1', amount: -100, amountRsd: -100 })

  it.each([
    ['parts is not an array', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: 'two' })],
    ['a part is not a record', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: ['nope'] })],
    ['a part amount is not finite', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: [{ amount: NaN, category: 'A' }] })],
    ['a part amount is a string', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: [{ amount: '-50', category: 'A' }] })],
    ['a part category is empty', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: [{ amount: -100, category: '' }] })],
    ['a part category is missing', blob({ op: 'split', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', parts: [{ amount: -100 }] })],
  ])('keeps the parent whole when %s', (_label, bad) => {
    const out = fold([base, bad])

    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('tx-1')
    expect(out[0]?.amount).toBe(-100)
  })
})

describe('a corrected amount and its dinar mirror', () => {
  // rescaleRsd's two null paths (fold.ts:255-256). Neither was hit, and both
  // decide whether a corrected row stays in the dinar totals.
  it('leaves an un-converted row un-converted rather than inventing a rate', () => {
    const out = fold([
      add({ id: 'tx-1', amount: -100, currency: 'EUR', amountRsd: null }),
      { op: 'set_amount', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', amount: -120 },
    ])

    expect(out[0]?.amount).toBe(-120)
    expect(out[0]?.amountRsd).toBeNull()
  })

  it('implies no rate from a zero original amount', () => {
    const out = fold([
      add({ id: 'tx-1', amount: 0, amountRsd: 0 }),
      { op: 'set_amount', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', amount: -50 },
    ])

    expect(out[0]?.amount).toBe(-50)
    expect(out[0]?.amountRsd).toBeNull()
  })

  it('keeps the rate a foreign row was booked at', () => {
    const out = fold([
      add({ id: 'tx-1', amount: -100, currency: 'EUR', amountRsd: -11750 }),
      { op: 'set_amount', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', amount: -120 },
    ])

    expect(out[0]?.amountRsd).toBe(-14100)
  })
})

describe('fold given something that is not a log', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'events'],
    ['an object', { 0: 'e1' }],
  ])('returns an empty ledger for %s rather than throwing', (_label, notALog) => {
    expect(fold(notALog as unknown as LedgerEvent[])).toEqual([])
  })

  it('returns an empty ledger for an empty log', () => {
    expect(fold([])).toEqual([])
  })
})

describe('invert given state it cannot use', () => {
  const state = [tx({ id: 'tx-1', category: 'FUEL', dimensions: { project: 'P1' } })]

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an object', {}],
  ])('treats %s as an empty state and returns null', (_label, notAState) => {
    const event: LedgerEvent = { op: 'delete', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1' }

    expect(invert(event, notAState as unknown as Transaction[], 'e3', '2026-07-04T10:00:00.000Z')).toBeNull()
  })

  it('returns null when the referenced transaction is absent', () => {
    const event: LedgerEvent = { op: 'delete', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'missing' }

    expect(invert(event, state, 'e3', '2026-07-04T10:00:00.000Z')).toBeNull()
  })

  it('inverts clearing an axis the transaction never held back to a clear, not to a null', () => {
    // `{project: null}` and `{}` are different states, and undo depends on it.
    const event: LedgerEvent = { op: 'set_dimension', id: 'e2', at: '2026-07-03T10:00:00.000Z', ref: 'tx-1', axis: 'client', value: 'ACME' }
    const inverse = invert(event, state, 'e3', '2026-07-04T10:00:00.000Z')

    expect(inverse).not.toBeNull()
    const applied = fold([
      { op: 'add', id: 'e1', at: '2026-07-02T10:00:00.000Z', tx: state[0] as Transaction },
      event,
      inverse as LedgerEvent,
    ])
    expect(Object.hasOwn(applied[0]?.dimensions ?? {}, 'client')).toBe(false)
    expect(applied[0]?.dimensions['project']).toBe('P1')
  })
})
