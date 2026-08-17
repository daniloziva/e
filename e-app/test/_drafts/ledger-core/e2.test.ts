import { describe, it, expect } from 'vitest'
import { fold, invert, type LedgerEvent } from '../../../src/engine/ledger/fold.js'
import {
  dedupeKey,
  normalizeDescription,
  extractCounterparty,
  toTransaction,
  type RawTransaction,
} from '../../../src/engine/ledger/normalize.js'
import { validateSplit, suggestSplit, type SplitPart } from '../../../src/engine/ledger/split.js'
import type { Transaction } from '../../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written fakes. No mocking library: injected deps are plain functions
// with fixed, inspectable behaviour.
// ─────────────────────────────────────────────────────────────────────────────

/** Always returns the same digest, so the key can be traced back to the hash. */
const constantHash = (_s: string): string => 'FIXED-DIGEST'

/** Reversible "hash": the key differs iff the hashed input differs. */
const echoHash = (s: string): string => `H(${s})`

/** Records what was handed to the hash function. */
function recordingHash(): { fn: (s: string) => string; calls: string[] } {
  const calls: string[] = []
  return { fn: (s) => { calls.push(s); return `H(${s})` }, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

function makeTx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    book: 'PERSONAL',
    txDate: '2026-08-04',
    valueDate: '2026-08-04',
    description: 'WOLT BEOGRAD',
    counterparty: 'WOLT',
    amount: -1890,
    currency: 'RSD',
    amountRsd: -1890,
    direction: 'out',
    category: 'MISC',
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: 'dk-1',
    reviewStatus: 'ok',
    createdAt: '2026-08-05T06:00:00Z',
    ...over,
  }
}

function makeRaw(over: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txDate: '2026-08-04',
    valueDate: '2026-08-04',
    description: 'KAFETERIJA DOO BEOGRAD',
    amount: -280,
    currency: 'RSD',
    balanceAfter: 41230.55,
    ...over,
  }
}

const evAdd = (id: string, at: string, tx: Transaction): LedgerEvent => ({ op: 'add', id, at, tx })
const evCat = (id: string, at: string, ref: string, category: string): LedgerEvent =>
  ({ op: 'set_category', id, at, ref, category })
const evDim = (id: string, at: string, ref: string, axis: string, value: string | null): LedgerEvent =>
  ({ op: 'set_dimension', id, at, ref, axis, value })
const evAmt = (id: string, at: string, ref: string, amount: number): LedgerEvent =>
  ({ op: 'set_amount', id, at, ref, amount })
const evSplit = (
  id: string,
  at: string,
  ref: string,
  parts: Array<{ amount: number; category: string }>,
): LedgerEvent => ({ op: 'split', id, at, ref, parts })
const evDel = (id: string, at: string, ref: string): LedgerEvent => ({ op: 'delete', id, at, ref })

const byId = (txs: Transaction[], id: string): Transaction | undefined => txs.find((t) => t.id === id)

/** Deterministic reordering — no randomness in tests. */
function rotate<T>(xs: T[], by: number): T[] {
  const n = xs.length
  return xs.map((_, i) => xs[(i + by) % n] as T)
}

const sum2 = (ns: number[]): number => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100

// ═════════════════════════════════════════════════════════════════════════════
// fold()
// ═════════════════════════════════════════════════════════════════════════════

describe('fold', () => {
  it('returns no transactions for an empty event log', () => {
    expect(fold([])).toEqual([])
  })

  it('materialises an added transaction exactly as the event carried it', () => {
    const tx = makeTx({ id: 'tx-a' })
    expect(fold([evAdd('e1', '2026-08-05T06:00:00Z', tx)])).toEqual([tx])
  })

  it('returns transactions in the order their add events fold', () => {
    const a = makeTx({ id: 'tx-a' })
    const b = makeTx({ id: 'tx-b' })
    const c = makeTx({ id: 'tx-c' })
    const out = fold([
      evAdd('e2', '2026-08-05T06:00:01Z', b),
      evAdd('e1', '2026-08-05T06:00:00Z', a),
      evAdd('e3', '2026-08-05T06:00:02Z', c),
    ])
    expect(out.map((t) => t.id)).toEqual(['tx-a', 'tx-b', 'tx-c'])
  })

  it('applies a correction so the later category wins over the original', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' })),
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ])
    expect(byId(out, 'tx-a')?.category).toBe('HRANA')
  })

  it('breaks a tie on identical timestamps with the higher event id winning', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evCat('e9', '2026-08-06T09:00:00Z', 'tx-a', 'ZABAVA'),
      evCat('e3', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ])
    expect(byId(out, 'tx-a')?.category).toBe('ZABAVA')
  })

  it('leaves other transactions untouched when one is corrected', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b', category: 'STAN' })),
      evCat('e3', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ])
    expect(byId(out, 'tx-b')?.category).toBe('STAN')
  })

  it('folds a shuffled event array identically to a sorted one', () => {
    const sorted: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b', amount: -520 })),
      evCat('e3', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
      evDim('e4', '2026-08-06T09:00:01Z', 'tx-b', 'MESTO', 'BEOGRAD'),
      evAmt('e5', '2026-08-07T09:00:00Z', 'tx-b', -530),
      evCat('e6', '2026-08-08T09:00:00Z', 'tx-a', 'ZABAVA'),
    ]
    const expected = fold(sorted)
    expect(fold([...sorted].reverse())).toEqual(expected)
    expect(fold(rotate(sorted, 3))).toEqual(expected)
    expect(fold(rotate(sorted, 5))).toEqual(expected)
  })

  it('folds a shuffled log identically even when a delete is buried in the middle', () => {
    const sorted: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b' })),
      evCat('e3', '2026-08-06T09:00:00Z', 'tx-b', 'HRANA'),
      evDel('e4', '2026-08-07T09:00:00Z', 'tx-b'),
      evCat('e5', '2026-08-08T09:00:00Z', 'tx-a', 'STAN'),
    ]
    expect(fold(rotate(sorted, 2))).toEqual(fold(sorted))
    expect(fold([...sorted].reverse())).toEqual(fold(sorted))
  })

  it('does not mutate the event array it was given', () => {
    const events: LedgerEvent[] = [
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' })),
    ]
    const snapshot = JSON.parse(JSON.stringify(events)) as unknown
    fold(events)
    expect(JSON.parse(JSON.stringify(events))).toEqual(snapshot)
  })

  it('ignores a repeated identical event rather than applying it twice', () => {
    const once = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ])
    const twice = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ])
    expect(twice).toEqual(once)
  })

  it('keeps one transaction when the same transaction id is added twice, the later add winning', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -100 })),
      evAdd('e2', '2026-08-06T06:00:00Z', makeTx({ id: 'tx-a', amount: -250 })),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.amount).toBe(-250)
  })

  it('folds events from different books into one list without filtering', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', book: 'PERSONAL' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b', book: 'SMOQUA' })),
    ])
    expect(out.map((t) => t.book)).toEqual(['PERSONAL', 'SMOQUA'])
  })

  // ── unknown refs: ignored, never fatal ────────────────────────────────────

  it.each([
    ['set_category', evCat('e2', '2026-08-06T09:00:00Z', 'ghost', 'HRANA')],
    ['set_dimension', evDim('e2', '2026-08-06T09:00:00Z', 'ghost', 'MESTO', 'NIS')],
    ['set_amount', evAmt('e2', '2026-08-06T09:00:00Z', 'ghost', -99)],
    ['split', evSplit('e2', '2026-08-06T09:00:00Z', 'ghost', [{ amount: -50, category: 'HRANA' }])],
    ['delete', evDel('e2', '2026-08-06T09:00:00Z', 'ghost')],
  ])('ignores a %s event that references an unknown transaction', (_op, event) => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' }))
    expect(() => fold([base, event])).not.toThrow()
    expect(fold([base, event])).toEqual(fold([base]))
  })

  it('ignores a correction timestamped before the transaction was added', () => {
    const out = fold([
      evCat('e1', '2026-08-01T09:00:00Z', 'tx-a', 'HRANA'),
      evAdd('e2', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' })),
    ])
    expect(byId(out, 'tx-a')?.category).toBe('MISC')
  })

  it('ignores every event that lands after the transaction was deleted', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evDel('e2', '2026-08-06T09:00:00Z', 'tx-a'),
      evCat('e3', '2026-08-07T09:00:00Z', 'tx-a', 'HRANA'),
      evAmt('e4', '2026-08-08T09:00:00Z', 'tx-a', -1),
    ])
    expect(out).toEqual([])
  })

  it('removes only the deleted transaction from the fold', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b' })),
      evDel('e3', '2026-08-06T09:00:00Z', 'tx-a'),
    ])
    expect(out.map((t) => t.id)).toEqual(['tx-b'])
  })

  // ── field-level ops ───────────────────────────────────────────────────────

  it('sets a dimension value on the referenced transaction', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', dimensions: {} })),
      evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', 'BEOGRAD'),
    ])
    expect(byId(out, 'tx-a')?.dimensions['MESTO']).toBe('BEOGRAD')
  })

  it('clears a dimension when the event carries a null value', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', dimensions: { MESTO: 'BEOGRAD' } })),
      evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', null),
    ])
    expect(byId(out, 'tx-a')?.dimensions['MESTO'] ?? null).toBeNull()
  })

  it('leaves other dimension axes intact when one axis is set', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', dimensions: { PROJEKAT: 'SAJAM' } })),
      evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', 'NIS'),
    ])
    expect(byId(out, 'tx-a')?.dimensions).toEqual({ PROJEKAT: 'SAJAM', MESTO: 'NIS' })
  })

  it('applies a corrected amount to the referenced transaction', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -1890 })),
      evAmt('e2', '2026-08-06T09:00:00Z', 'tx-a', -1990),
    ])
    expect(byId(out, 'tx-a')?.amount).toBe(-1990)
  })

  it('flips the direction when a corrected amount changes the sign', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -1890, direction: 'out' })),
      evAmt('e2', '2026-08-06T09:00:00Z', 'tx-a', 1890),
    ])
    expect(byId(out, 'tx-a')?.direction).toBe('in')
  })

  // ── splits ────────────────────────────────────────────────────────────────

  it('replaces a split transaction with its parts rather than adding to it', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 })),
      evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -1800, category: 'HRANA' },
        { amount: -1200, category: 'DECA' },
      ]),
    ])
    expect(out).toHaveLength(2)
    expect(sum2(out.map((t) => t.amount))).toBe(-3000)
    expect(out.map((t) => t.category).sort()).toEqual(['DECA', 'HRANA'])
  })

  it('gives every transaction produced by a split a distinct non-empty id', () => {
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 })),
      evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -1800, category: 'HRANA' },
        { amount: -1200, category: 'DECA' },
      ]),
    ])
    const ids = out.map((t) => t.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the original date, book, currency and description onto every split part', () => {
    const original = makeTx({
      id: 'tx-a',
      amount: -3000,
      txDate: '2026-08-04',
      book: 'PERSONAL',
      currency: 'RSD',
      description: 'MAXI 011 BEOGRAD',
    })
    const out = fold([
      evAdd('e1', '2026-08-05T06:00:00Z', original),
      evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -1800, category: 'HRANA' },
        { amount: -1200, category: 'DECA' },
      ]),
    ])
    for (const part of out) {
      expect(part.txDate).toBe('2026-08-04')
      expect(part.book).toBe('PERSONAL')
      expect(part.currency).toBe('RSD')
      expect(part.description).toBe('MAXI 011 BEOGRAD')
      expect(part.direction).toBe('out')
    }
  })

  it('ignores a split whose parts do not sum to the original amount', () => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 }))
    const out = fold([
      base,
      evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -1800, category: 'HRANA' },
        { amount: -1000, category: 'DECA' },
      ]),
    ])
    expect(out).toEqual(fold([base]))
  })

  it('ignores a split whose parts do not share the original sign', () => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 }))
    const out = fold([
      base,
      evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -4000, category: 'HRANA' },
        { amount: 1000, category: 'DECA' },
      ]),
    ])
    expect(out).toEqual(fold([base]))
  })

  it('ignores a split that carries no parts at all', () => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 }))
    expect(fold([base, evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [])])).toEqual(fold([base]))
  })

  it('folds a split identically whatever order the events arrive in', () => {
    const sorted: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -3000 })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b', amount: -500 })),
      evSplit('e3', '2026-08-06T09:00:00Z', 'tx-a', [
        { amount: -1800, category: 'HRANA' },
        { amount: -1200, category: 'DECA' },
      ]),
    ]
    expect(fold([...sorted].reverse())).toEqual(fold(sorted))
    expect(fold(rotate(sorted, 1))).toEqual(fold(sorted))
  })

  // ── malformed input ───────────────────────────────────────────────────────

  it.each([
    ['an unknown op', { op: 'teleport', id: 'e2', at: '2026-08-06T09:00:00Z', ref: 'tx-a' }],
    ['a missing ref', { op: 'set_category', id: 'e2', at: '2026-08-06T09:00:00Z', category: 'HRANA' }],
    ['a null payload', { op: 'add', id: 'e2', at: '2026-08-06T09:00:00Z', tx: null }],
    ['no timestamp', { op: 'set_category', id: 'e2', ref: 'tx-a', category: 'HRANA' }],
    ['an absent event object', null],
    ['an undefined event object', undefined],
  ])('ignores a malformed event with %s instead of failing the whole fold', (_label, bad) => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' }))
    const events = [base, bad as unknown as LedgerEvent]
    expect(() => fold(events)).not.toThrow()
    expect(fold(events)).toEqual(fold([base]))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// invert()
// ═════════════════════════════════════════════════════════════════════════════

describe('invert', () => {
  const AT = '2026-08-09T10:00:00Z'
  const ID = 'inv-1'

  it('inverts an add into a delete of that transaction', () => {
    const tx = makeTx({ id: 'tx-a' })
    const event = evAdd('e1', '2026-08-05T06:00:00Z', tx)
    expect(invert(event, [], ID, AT)).toMatchObject({ op: 'delete', id: ID, at: AT, ref: 'tx-a' })
  })

  it('inverts a category correction back to the category the transaction had before it', () => {
    const before = [makeTx({ id: 'tx-a', category: 'MISC' })]
    const event = evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA')
    expect(invert(event, before, ID, AT)).toMatchObject({
      op: 'set_category',
      id: ID,
      at: AT,
      ref: 'tx-a',
      category: 'MISC',
    })
  })

  it('inverts an amount correction back to the previous amount', () => {
    const before = [makeTx({ id: 'tx-a', amount: -1890 })]
    const event = evAmt('e2', '2026-08-06T09:00:00Z', 'tx-a', -1990)
    expect(invert(event, before, ID, AT)).toMatchObject({ op: 'set_amount', ref: 'tx-a', amount: -1890 })
  })

  it('inverts a dimension change back to the previous value', () => {
    const before = [makeTx({ id: 'tx-a', dimensions: { MESTO: 'BEOGRAD' } })]
    const event = evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', 'NIS')
    expect(invert(event, before, ID, AT)).toMatchObject({
      op: 'set_dimension',
      ref: 'tx-a',
      axis: 'MESTO',
      value: 'BEOGRAD',
    })
  })

  it('inverts setting a previously absent dimension into clearing it', () => {
    const before = [makeTx({ id: 'tx-a', dimensions: {} })]
    const event = evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', 'NIS')
    expect(invert(event, before, ID, AT)).toMatchObject({ op: 'set_dimension', axis: 'MESTO', value: null })
  })

  it('inverts a delete into an add carrying the whole transaction back', () => {
    const tx = makeTx({ id: 'tx-a', category: 'HRANA' })
    const inverse = invert(evDel('e2', '2026-08-06T09:00:00Z', 'tx-a'), [tx], ID, AT)
    expect(inverse).toMatchObject({ op: 'add', id: ID, at: AT, tx })
  })

  it('returns an event stamped with exactly the id and timestamp it was given', () => {
    const before = [makeTx({ id: 'tx-a', category: 'MISC' })]
    const inverse = invert(evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'), before, 'chosen-id', '2030-01-01T00:00:00Z')
    expect(inverse?.id).toBe('chosen-id')
    expect(inverse?.at).toBe('2030-01-01T00:00:00Z')
  })

  it('returns an event that restores the same value when the correction changed nothing', () => {
    const before = [makeTx({ id: 'tx-a', category: 'HRANA' })]
    const inverse = invert(evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'), before, ID, AT)
    expect(inverse).toMatchObject({ op: 'set_category', ref: 'tx-a', category: 'HRANA' })
  })

  it('returns null for a split, which no single event can undo', () => {
    const before = [makeTx({ id: 'tx-a', amount: -3000 })]
    const event = evSplit('e2', '2026-08-06T09:00:00Z', 'tx-a', [
      { amount: -1800, category: 'HRANA' },
      { amount: -1200, category: 'DECA' },
    ])
    expect(invert(event, before, ID, AT)).toBeNull()
  })

  it.each([
    ['set_category', evCat('e2', '2026-08-06T09:00:00Z', 'ghost', 'HRANA')],
    ['set_amount', evAmt('e2', '2026-08-06T09:00:00Z', 'ghost', -10)],
    ['set_dimension', evDim('e2', '2026-08-06T09:00:00Z', 'ghost', 'MESTO', 'NIS')],
    ['delete', evDel('e2', '2026-08-06T09:00:00Z', 'ghost')],
  ])('returns null when a %s event references a transaction the state does not contain', (_op, event) => {
    expect(invert(event, [makeTx({ id: 'tx-a' })], ID, AT)).toBeNull()
  })

  it.each([
    ['an unknown op', { op: 'teleport', id: 'e2', at: '2026-08-06T09:00:00Z', ref: 'tx-a' }],
    ['an absent event', null],
    ['an add with no transaction', { op: 'add', id: 'e2', at: '2026-08-06T09:00:00Z', tx: null }],
  ])('returns null for a malformed event: %s', (_label, bad) => {
    expect(invert(bad as unknown as LedgerEvent, [makeTx({ id: 'tx-a' })], ID, AT)).toBeNull()
  })

  // ── the property that matters: appending the inverse restores the fold ────

  it('restores the prior state exactly when the inverse of a category correction is appended', () => {
    const base: LedgerEvent[] = [evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' }))]
    const correction = evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA')
    const inverse = invert(correction, fold(base), 'e3', '2026-08-07T09:00:00Z')
    expect(inverse).not.toBeNull()
    expect(fold([...base, correction, inverse as LedgerEvent])).toEqual(fold(base))
  })

  it('restores the prior state exactly when the inverse of an amount correction is appended', () => {
    const base: LedgerEvent[] = [evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', amount: -1890 }))]
    const correction = evAmt('e2', '2026-08-06T09:00:00Z', 'tx-a', 1990)
    const inverse = invert(correction, fold(base), 'e3', '2026-08-07T09:00:00Z')
    expect(fold([...base, correction, inverse as LedgerEvent])).toEqual(fold(base))
  })

  it('restores the prior state exactly when the inverse of a dimension change is appended', () => {
    const base: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', dimensions: { MESTO: 'BEOGRAD' } })),
    ]
    const correction = evDim('e2', '2026-08-06T09:00:00Z', 'tx-a', 'MESTO', 'NIS')
    const inverse = invert(correction, fold(base), 'e3', '2026-08-07T09:00:00Z')
    expect(fold([...base, correction, inverse as LedgerEvent])).toEqual(fold(base))
  })

  it('restores a deleted transaction exactly, including its corrections', () => {
    const base: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a', category: 'MISC' })),
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b' })),
      evCat('e3', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ]
    const removal = evDel('e4', '2026-08-07T09:00:00Z', 'tx-a')
    const inverse = invert(removal, fold(base), 'e5', '2026-08-08T09:00:00Z')
    expect(inverse).not.toBeNull()
    const restored = fold([...base, removal, inverse as LedgerEvent])
    expect(byId(restored, 'tx-a')).toEqual(byId(fold(base), 'tx-a'))
  })

  it('leaves nothing behind when the inverse of an add is appended', () => {
    const addEvent = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' }))
    const inverse = invert(addEvent, [], 'e2', '2026-08-06T09:00:00Z')
    expect(fold([addEvent, inverse as LedgerEvent])).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// dedupeKey()
// ═════════════════════════════════════════════════════════════════════════════

describe('dedupeKey', () => {
  it('returns the digest produced by the injected hash function', () => {
    expect(dedupeKey('PERSONAL', makeRaw(), constantHash)).toBe('FIXED-DIGEST')
  })

  it('hashes once per call and feeds it the book and the transaction date', () => {
    const rec = recordingHash()
    dedupeKey('PERSONAL', makeRaw({ txDate: '2026-08-04' }), rec.fn)
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]).toContain('PERSONAL')
    expect(rec.calls[0]).toContain('2026-08-04')
  })

  it('is stable across repeated calls with the same input', () => {
    const raw = makeRaw()
    expect(dedupeKey('PERSONAL', raw, echoHash)).toBe(dedupeKey('PERSONAL', raw, echoHash))
  })

  it('keeps two genuinely identical same-day charges apart when the running balance differs', () => {
    const coffee = { txDate: '2026-08-04', valueDate: '2026-08-04', description: 'KAFETERIJA DOO', amount: -280 }
    const first = dedupeKey('PERSONAL', makeRaw({ ...coffee, balanceAfter: 41230.55 }), echoHash)
    const second = dedupeKey('PERSONAL', makeRaw({ ...coffee, balanceAfter: 40950.55 }), echoHash)
    expect(second).not.toBe(first)
  })

  it('collapses a re-sent statement line that is identical in every field, balance included', () => {
    const line = makeRaw({ balanceAfter: 41230.55 })
    expect(dedupeKey('PERSONAL', { ...line }, echoHash)).toBe(dedupeKey('PERSONAL', { ...line }, echoHash))
  })

  it.each([
    ['book', 'SMOQUA' as const, {}],
    ['transaction date', 'PERSONAL' as const, { txDate: '2026-08-05' }],
    ['value date', 'PERSONAL' as const, { valueDate: '2026-08-06' }],
    ['amount', 'PERSONAL' as const, { amount: -281 }],
    ['amount sign', 'PERSONAL' as const, { amount: 280 }],
    ['currency', 'PERSONAL' as const, { currency: 'EUR' }],
    ['balance after', 'PERSONAL' as const, { balanceAfter: 1 }],
  ])('produces a different key when the %s differs', (_field, book, over) => {
    const base = dedupeKey('PERSONAL', makeRaw(), echoHash)
    expect(dedupeKey(book, makeRaw(over), echoHash)).not.toBe(base)
  })

  it('treats an absent balance as different from a zero balance', () => {
    const absent = dedupeKey('PERSONAL', makeRaw({ balanceAfter: null }), echoHash)
    const zero = dedupeKey('PERSONAL', makeRaw({ balanceAfter: 0 }), echoHash)
    expect(absent).not.toBe(zero)
  })

  it('treats an absent value date as different from a present one', () => {
    const absent = dedupeKey('PERSONAL', makeRaw({ valueDate: null }), echoHash)
    const present = dedupeKey('PERSONAL', makeRaw({ valueDate: '2026-08-04' }), echoHash)
    expect(absent).not.toBe(present)
  })

  it('does not confuse the transaction date with the value date when they are swapped', () => {
    const a = dedupeKey('PERSONAL', makeRaw({ txDate: '2026-08-04', valueDate: '2026-08-05' }), echoHash)
    const b = dedupeKey('PERSONAL', makeRaw({ txDate: '2026-08-05', valueDate: '2026-08-04' }), echoHash)
    expect(a).not.toBe(b)
  })

  it('gives the same key to two statements of the same line whose volatile description tokens differ', () => {
    const a = dedupeKey('PERSONAL', makeRaw({ description: 'WOLT BEOGRAD POS 4738 04.08.2026' }), echoHash)
    const b = dedupeKey('PERSONAL', makeRaw({ description: 'WOLT BEOGRAD POS 9911 04.08.2026' }), echoHash)
    expect(a).toBe(b)
  })

  it('gives different keys to different merchants on the same day for the same amount', () => {
    const a = dedupeKey('PERSONAL', makeRaw({ description: 'WOLT BEOGRAD' }), echoHash)
    const b = dedupeKey('PERSONAL', makeRaw({ description: 'MAXI BEOGRAD' }), echoHash)
    expect(a).not.toBe(b)
  })

  it('still produces a key when the description is empty', () => {
    const key = dedupeKey('PERSONAL', makeRaw({ description: '' }), echoHash)
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// normalizeDescription()
// ═════════════════════════════════════════════════════════════════════════════

describe('normalizeDescription', () => {
  it.each([
    ['a terminal id', 'WOLT BEOGRAD POS 4738', 'WOLT BEOGRAD POS 9911'],
    ['a transaction date, dotted', 'MAXI 011 BGD 04.08.2026', 'MAXI 011 BGD 27.09.2026'],
    ['a transaction date, ISO', 'MAXI 011 BGD 2026-08-04', 'MAXI 011 BGD 2026-09-27'],
    ['a transaction date, slashed', 'MAXI 011 BGD 04/08/26', 'MAXI 011 BGD 27/09/26'],
    ['a card suffix', 'IKEA BEOGRAD KARTICA ****1234', 'IKEA BEOGRAD KARTICA ****9876'],
    ['a reference number', 'EPS SNABDEVANJE REF 883910244', 'EPS SNABDEVANJE REF 771002993'],
    ['a trailing time stamp', 'LILLY APOTEKA 12:04', 'LILLY APOTEKA 21:47'],
  ])('normalises two descriptors that differ only by %s to the same value', (_label, a, b) => {
    expect(normalizeDescription(a)).toBe(normalizeDescription(b))
  })

  it.each([
    ['leading and trailing whitespace', '  WOLT BEOGRAD  ', 'WOLT BEOGRAD'],
    ['repeated inner whitespace', 'WOLT    BEOGRAD', 'WOLT BEOGRAD'],
    ['letter case', 'wolt beograd', 'WOLT BEOGRAD'],
    ['tabs and newlines', 'WOLT\tBEOGRAD\n', 'WOLT BEOGRAD'],
    ['diacritics', 'TRŽNI CENTAR UŠĆE', 'TRZNI CENTAR USCE'],
  ])('normalises two descriptors that differ only by %s to the same value', (_label, a, b) => {
    expect(normalizeDescription(a)).toBe(normalizeDescription(b))
  })

  it('keeps the merchant token that a learned rule has to match on', () => {
    expect(normalizeDescription('POS 4738 WOLT BEOGRAD 04.08.2026').toUpperCase()).toContain('WOLT')
  })

  it('keeps two different merchants distinguishable', () => {
    expect(normalizeDescription('WOLT BEOGRAD')).not.toBe(normalizeDescription('GLOVO BEOGRAD'))
  })

  it('keeps a merchant whose name contains digits distinguishable from another branch', () => {
    expect(normalizeDescription('MAXI 011')).not.toBe(normalizeDescription('MAXI 022'))
  })

  it('is idempotent: normalising an already normalised descriptor changes nothing', () => {
    const once = normalizeDescription('WOLT BEOGRAD POS 4738 04.08.2026')
    expect(normalizeDescription(once)).toBe(once)
  })

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \t\n '],
  ])('returns an empty string for %s', (_label, input) => {
    expect(normalizeDescription(input)).toBe('')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns an empty string when the description is %s', (_label, input) => {
    expect(normalizeDescription(input as unknown as string)).toBe('')
  })

  it('normalises two descriptors made only of volatile tokens to the same value', () => {
    expect(normalizeDescription('POS 4738 04.08.2026')).toBe(normalizeDescription('POS 9911 27.09.2026'))
  })

  it('handles a very long descriptor without truncating the merchant token away', () => {
    const long = `NAKNADA ZA ${'X'.repeat(400)} WOLT BEOGRAD`
    expect(normalizeDescription(long).toUpperCase()).toContain('WOLT')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// extractCounterparty()  — the refusal is the point
// ═════════════════════════════════════════════════════════════════════════════

describe('extractCounterparty', () => {
  it('reads the merchant out of a normal card descriptor', () => {
    expect(extractCounterparty('WOLT BEOGRAD POS 4738 04.08.2026')?.toUpperCase()).toContain('WOLT')
  })

  it.each([
    ['a descriptor with nothing but volatile tokens', 'POS 4738 04.08.2026'],
    ['an empty descriptor', ''],
    ['whitespace only', '    '],
    ['punctuation only', '*** ###'],
  ])('returns null for %s rather than guessing a merchant', (_label, input) => {
    expect(extractCounterparty(input)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// toTransaction()
// ═════════════════════════════════════════════════════════════════════════════

describe('toTransaction', () => {
  it('carries the id, dedupe key and creation timestamp through untouched', () => {
    const tx = toTransaction(makeRaw(), 'PERSONAL', 'tx-9', 'dk-9', '2026-08-05T06:00:00Z')
    expect(tx.id).toBe('tx-9')
    expect(tx.dedupeKey).toBe('dk-9')
    expect(tx.createdAt).toBe('2026-08-05T06:00:00Z')
    expect(tx.book).toBe('PERSONAL')
  })

  it.each([
    [-280, 'out'],
    [412000, 'in'],
  ])('derives direction from the sign and keeps the amount signed: %s becomes %s', (amount, direction) => {
    const tx = toTransaction(makeRaw({ amount }), 'PERSONAL', 'tx-9', 'dk-9', '2026-08-05T06:00:00Z')
    expect(tx.amount).toBe(amount)
    expect(tx.direction).toBe(direction)
  })

  it('leaves an unresolved transaction in MISC with no dimensions', () => {
    const tx = toTransaction(makeRaw(), 'PERSONAL', 'tx-9', 'dk-9', '2026-08-05T06:00:00Z')
    expect(tx.category).toBe('MISC')
    expect(tx.dimensions).toEqual({})
  })

  it('preserves both dates, including an absent value date', () => {
    const tx = toTransaction(
      makeRaw({ txDate: '2026-08-04', valueDate: null }),
      'PERSONAL',
      'tx-9',
      'dk-9',
      '2026-08-05T06:00:00Z',
    )
    expect(tx.txDate).toBe('2026-08-04')
    expect(tx.valueDate).toBeNull()
  })

  it('sets amountRsd to the amount itself for an RSD line', () => {
    const tx = toTransaction(makeRaw({ currency: 'RSD', amount: -280 }), 'PERSONAL', 'tx-9', 'dk-9', '2026-08-05T06:00:00Z')
    expect(tx.amountRsd).toBe(-280)
  })

  it('leaves amountRsd absent for a foreign-currency line rather than guessing a rate', () => {
    const tx = toTransaction(makeRaw({ currency: 'EUR', amount: -30 }), 'PERSONAL', 'tx-9', 'dk-9', '2026-08-05T06:00:00Z')
    expect(tx.amountRsd).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// validateSplit()
// ═════════════════════════════════════════════════════════════════════════════

describe('validateSplit', () => {
  const spend = makeTx({ id: 'tx-a', amount: -1000 })
  const income = makeTx({ id: 'tx-b', amount: 412000, direction: 'in' })

  it('accepts parts that sum to the original outflow', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -400, category: 'DECA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('accepts parts that sum to the original inflow', () => {
    const result = validateSplit(income, [
      { amount: 400000, category: 'PRIHOD' },
      { amount: 12000, category: 'PRIHOD' },
    ])
    expect(result.valid).toBe(true)
  })

  it('accepts a many-part split that lands exactly on the total', () => {
    const result = validateSplit(spend, [
      { amount: -333.33, category: 'HRANA' },
      { amount: -333.33, category: 'DECA' },
      { amount: -333.34, category: 'ZABAVA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('accepts a sum that only floating-point arithmetic makes inexact', () => {
    const result = validateSplit(spend, [
      { amount: -100.1, category: 'HRANA' },
      { amount: -899.9, category: 'DECA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('accepts a single part covering the whole amount', () => {
    const result = validateSplit(spend, [{ amount: -1000, category: 'HRANA' }])
    expect(result.valid).toBe(true)
  })

  it('reports the difference as the parts sum minus the original amount', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -300, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(100)
  })

  it('reports a negative difference when the parts overshoot the original', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -500, category: 'DECA' },
    ])
    expect(result.difference).toBe(-100)
  })

  it('rejects a split that is off by exactly one hundredth', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -399.99, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0.01)
  })

  it('accepts a residue smaller than half a hundredth, which rounds away at 2dp', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -399.9951, category: 'DECA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('rejects a residue of exactly half a hundredth, rounding half up to 0.01', () => {
    const result = validateSplit(spend, [
      { amount: -600, category: 'HRANA' },
      { amount: -399.995, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0.01)
  })

  it('rejects a part whose sign disagrees with the original even when the sum is right', () => {
    const result = validateSplit(spend, [
      { amount: -1200, category: 'HRANA' },
      { amount: 200, category: 'PRIHOD' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects a zero-amount part, which carries no sign at all', () => {
    const result = validateSplit(spend, [
      { amount: -1000, category: 'HRANA' },
      { amount: 0, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
  })

  it('rejects an empty parts list and reports the whole amount as missing', () => {
    const result = validateSplit(spend, [])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(1000)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('refuses to split a zero-amount transaction', () => {
    const result = validateSplit(makeTx({ amount: 0 }), [{ amount: 0, category: 'HRANA' }])
    expect(result.valid).toBe(false)
  })

  it('does not throw when the parts list is absent', () => {
    expect(() => validateSplit(spend, null as unknown as SplitPart[])).not.toThrow()
    expect(validateSplit(spend, null as unknown as SplitPart[]).valid).toBe(false)
  })

  it('rejects a part whose amount is not a number', () => {
    const result = validateSplit(spend, [
      { amount: Number.NaN, category: 'HRANA' },
      { amount: -1000, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
  })

  it('carries an error message for every rejection and none for an acceptance', () => {
    const cases: Array<[Transaction, SplitPart[]]> = [
      [spend, [{ amount: -600, category: 'HRANA' }, { amount: -400, category: 'DECA' }]],
      [spend, [{ amount: -600, category: 'HRANA' }, { amount: -300, category: 'DECA' }]],
      [spend, [{ amount: -1200, category: 'HRANA' }, { amount: 200, category: 'PRIHOD' }]],
      [spend, []],
    ]
    for (const [tx, parts] of cases) {
      const result = validateSplit(tx, parts)
      expect(result.errors.length === 0).toBe(result.valid)
    }
  })

})

// ═════════════════════════════════════════════════════════════════════════════
// suggestSplit()
// ═════════════════════════════════════════════════════════════════════════════

describe('suggestSplit', () => {
  const basket = makeTx({ id: 'tx-a', amount: -3000, description: 'MAXI 011 BEOGRAD' })

  it('proposes one part per category when the line items disagree', () => {
    const parts = suggestSplit(basket, [
      { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
    ])
    expect(parts).not.toBeNull()
    expect(parts?.map((p) => p.category).sort()).toEqual(['DECA', 'HRANA'])
  })

  it('gives the proposed parts the sign of the transaction, not of the receipt lines', () => {
    const parts = suggestSplit(basket, [
      { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
    ])
    expect(parts?.every((p) => p.amount < 0)).toBe(true)
    expect(sum2((parts ?? []).map((p) => p.amount))).toBe(-3000)
  })

  it('groups several items of the same category into one part', () => {
    const parts = suggestSplit(basket, [
      { description: 'MLEKO', lineTotal: 700, category: 'HRANA' },
      { description: 'HLEB', lineTotal: 500, category: 'HRANA' },
      { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
    ])
    expect(parts).toHaveLength(2)
    expect(parts?.find((p) => p.category === 'HRANA')?.amount).toBe(-1200)
  })

  it('proposes a split that its own validator accepts', () => {
    const parts = suggestSplit(basket, [
      { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
    ])
    expect(validateSplit(basket, parts as SplitPart[]).valid).toBe(true)
  })

  it('returns null when every line item agrees on one category', () => {
    expect(
      suggestSplit(basket, [
        { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
        { description: 'HLEB', lineTotal: 1800, category: 'HRANA' },
      ]),
    ).toBeNull()
  })

  it('returns null when there are no line items at all', () => {
    expect(suggestSplit(basket, [])).toBeNull()
  })

  it('returns null when there is a single line item', () => {
    expect(suggestSplit(basket, [{ description: 'MLEKO', lineTotal: 3000, category: 'HRANA' }])).toBeNull()
  })

  it('returns null when a line item is missing its total', () => {
    expect(
      suggestSplit(basket, [
        { description: 'MLEKO', lineTotal: null, category: 'HRANA' },
        { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
      ]),
    ).toBeNull()
  })

  it('returns null when a line item has no category, rather than filing it under a guess', () => {
    expect(
      suggestSplit(basket, [
        { description: 'MLEKO', lineTotal: 1200, category: null },
        { description: 'PAMPERS', lineTotal: 1800, category: 'DECA' },
      ]),
    ).toBeNull()
  })

  it('returns null when the line items do not add up to the transaction amount', () => {
    expect(
      suggestSplit(basket, [
        { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
        { description: 'PAMPERS', lineTotal: 900, category: 'DECA' },
      ]),
    ).toBeNull()
  })

  it('accepts line items whose rounding sums exactly to the transaction amount', () => {
    const parts = suggestSplit(makeTx({ amount: -1000 }), [
      { description: 'A', lineTotal: 333.33, category: 'HRANA' },
      { description: 'B', lineTotal: 333.33, category: 'DECA' },
      { description: 'C', lineTotal: 333.34, category: 'ZABAVA' },
    ])
    expect(parts).toHaveLength(3)
    expect(sum2((parts ?? []).map((p) => p.amount))).toBe(-1000)
  })

  it('returns null when the items argument is absent', () => {
    expect(
      suggestSplit(basket, null as unknown as Array<{ description: string; lineTotal: number | null; category: string | null }>),
    ).toBeNull()
  })

  it('returns null for a zero-amount transaction, which cannot be split', () => {
    expect(
      suggestSplit(makeTx({ amount: 0 }), [
        { description: 'MLEKO', lineTotal: 0, category: 'HRANA' },
        { description: 'PAMPERS', lineTotal: 0, category: 'DECA' },
      ]),
    ).toBeNull()
  })
})
