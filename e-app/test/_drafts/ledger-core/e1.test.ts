import { describe, it, expect } from 'vitest'

import { fold, invert, type LedgerEvent } from '../../../src/core/ledger/fold.js'
import {
  dedupeKey,
  normalizeDescription,
  extractCounterparty,
  toTransaction,
  type RawTransaction,
} from '../../../src/core/ledger/normalize.js'
import { validateSplit, suggestSplit, type SplitPart } from '../../../src/core/ledger/split.js'
import type { Transaction, BookCode } from '../../../src/core/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written fakes and fixture builders. No mocking library, no randomness,
// no clock: every value below is fixed and the injected hash is a plain
// function so the key material is observable.
// ─────────────────────────────────────────────────────────────────────────────

/** Identity hash — makes the material that went into a dedupe key observable. */
const identityHash = (s: string): string => s

/** Constant hash — proves the returned key is the hash's output, not a concat. */
const constantHash = (): string => 'CONSTANT'

function makeTx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'T1',
    book: 'PERSONAL',
    txDate: '2026-07-04',
    valueDate: '2026-07-04',
    description: 'WOLT BEOGRAD',
    counterparty: 'WOLT',
    amount: -1200,
    currency: 'RSD',
    amountRsd: -1200,
    direction: 'out',
    category: 'MISC',
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: 'k-T1',
    reviewStatus: 'ok',
    createdAt: '2026-07-05T08:00:00Z',
    ...over,
  }
}

function makeRaw(over: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txDate: '2026-07-04',
    valueDate: '2026-07-04',
    description: 'POS 4738 WOLT BEOGRAD',
    amount: -1200,
    currency: 'RSD',
    balanceAfter: 84320.55,
    ...over,
  }
}

function byId(txs: Transaction[], id: string): Transaction {
  const found = txs.find((t) => t.id === id)
  if (!found) throw new Error(`fold() output has no transaction ${id}`)
  return found
}

/** Deterministic Fisher–Yates so a "shuffled" log is reproducible, never flaky. */
function permute<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice()
  let s = seed
  const rand = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i]!
    const b = out[j]!
    out[i] = b
    out[j] = a
  }
  return out
}

const T1 = makeTx({ id: 'T1', description: 'WOLT BEOGRAD', amount: -1200, dedupeKey: 'k-T1' })
const T2 = makeTx({ id: 'T2', description: 'MAXI 021', amount: -4500, dedupeKey: 'k-T2' })
const T3 = makeTx({
  id: 'T3',
  description: 'PLATA JUL',
  amount: 150000,
  amountRsd: 150000,
  direction: 'in',
  dedupeKey: 'k-T3',
})

/** A realistic log: three adds, three corrections, one delete, one orphan. */
const BASE_LOG: LedgerEvent[] = [
  { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
  { op: 'add', id: 'E02', at: '2026-07-05T08:00:01Z', tx: T2 },
  { op: 'add', id: 'E03', at: '2026-07-05T08:00:02Z', tx: T3 },
  { op: 'set_category', id: 'E04', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
  { op: 'set_dimension', id: 'E05', at: '2026-07-07T09:00:00Z', ref: 'T2', axis: 'project', value: 'HOME' },
  { op: 'set_amount', id: 'E06', at: '2026-07-08T09:00:00Z', ref: 'T2', amount: -4600 },
  { op: 'set_category', id: 'E07', at: '2026-07-09T09:00:00Z', ref: 'T1', category: 'ZABAVA' },
  { op: 'delete', id: 'E08', at: '2026-07-10T09:00:00Z', ref: 'T3' },
  { op: 'set_category', id: 'E09', at: '2026-07-11T09:00:00Z', ref: 'GHOST', category: 'DECA' },
]

// ─────────────────────────────────────────────────────────────────────────────
// fold()
// ─────────────────────────────────────────────────────────────────────────────

describe('fold', () => {
  it('returns an empty array for an empty event log', () => {
    expect(fold([])).toEqual([])
  })

  it('materialises a transaction from a single add event', () => {
    const out = fold([{ op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 }])
    expect(out).toHaveLength(1)
    expect(byId(out, 'T1')).toEqual(T1)
  })

  it('does not mutate the events it is given', () => {
    const events = BASE_LOG.map((e) => structuredClone(e))
    const snapshot = structuredClone(events)
    fold(events)
    expect(events).toEqual(snapshot)
  })

  it('lets a later set_category correction win over the original category', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ category: 'MISC' }) },
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
    ])
    expect(byId(out, 'T1').category).toBe('HRANA')
  })

  it('applies the last of several corrections to the same field', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
      { op: 'set_category', id: 'E03', at: '2026-07-07T09:00:00Z', ref: 'T1', category: 'DECA' },
      { op: 'set_category', id: 'E04', at: '2026-07-08T09:00:00Z', ref: 'T1', category: 'ZABAVA' },
    ])
    expect(byId(out, 'T1').category).toBe('ZABAVA')
  })

  it('orders by `at`, so a correction that arrives last but happened first does not win', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_category', id: 'E03', at: '2026-07-08T09:00:00Z', ref: 'T1', category: 'ZABAVA' },
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
    ])
    expect(byId(out, 'T1').category).toBe('ZABAVA')
  })

  it('breaks a tie on identical `at` with the higher event id, whatever the array order', () => {
    const lower: LedgerEvent = {
      op: 'set_category',
      id: 'E-AAA',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    const higher: LedgerEvent = {
      op: 'set_category',
      id: 'E-BBB',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'DECA',
    }
    const add: LedgerEvent = { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 }
    expect(byId(fold([add, lower, higher]), 'T1').category).toBe('DECA')
    expect(byId(fold([add, higher, lower]), 'T1').category).toBe('DECA')
  })

  it.each([7, 42, 1337])('folds a shuffled copy (seed %i) identically to the sorted log', (seed) => {
    const shuffledLog = permute(BASE_LOG, seed)
    expect(shuffledLog).not.toEqual(BASE_LOG)
    expect(fold(shuffledLog)).toEqual(fold(BASE_LOG))
  })

  it('folds the exactly-reversed log identically to the sorted one', () => {
    expect(fold([...BASE_LOG].reverse())).toEqual(fold(BASE_LOG))
  })

  it.each<{ label: string; event: LedgerEvent }>([
    {
      label: 'set_category',
      event: { op: 'set_category', id: 'X1', at: '2026-07-20T09:00:00Z', ref: 'GHOST', category: 'HRANA' },
    },
    {
      label: 'set_amount',
      event: { op: 'set_amount', id: 'X2', at: '2026-07-20T09:00:00Z', ref: 'GHOST', amount: -99 },
    },
    {
      label: 'set_dimension',
      event: { op: 'set_dimension', id: 'X3', at: '2026-07-20T09:00:00Z', ref: 'GHOST', axis: 'project', value: 'X' },
    },
    { label: 'delete', event: { op: 'delete', id: 'X4', at: '2026-07-20T09:00:00Z', ref: 'GHOST' } },
    {
      label: 'split',
      event: {
        op: 'split',
        id: 'X5',
        at: '2026-07-20T09:00:00Z',
        ref: 'GHOST',
        parts: [
          { amount: -600, category: 'HRANA' },
          { amount: -600, category: 'DECA' },
        ],
      },
    },
  ])('ignores a $label event that references an unknown transaction instead of throwing', ({ event }) => {
    const withOrphan = fold([{ op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 }, event])
    const without = fold([{ op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 }])
    expect(withOrphan).toEqual(without)
  })

  it('returns an empty array for a log made entirely of unknown references', () => {
    expect(
      fold([
        { op: 'set_category', id: 'X1', at: '2026-07-20T09:00:00Z', ref: 'GHOST', category: 'HRANA' },
        { op: 'delete', id: 'X2', at: '2026-07-21T09:00:00Z', ref: 'GHOST2' },
      ]),
    ).toEqual([])
  })

  it('ignores a correction whose `at` sorts before the add that creates its transaction', () => {
    const out = fold([
      { op: 'set_category', id: 'E00', at: '2026-07-01T09:00:00Z', ref: 'T1', category: 'HRANA' },
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ category: 'MISC' }) },
    ])
    expect(byId(out, 'T1').category).toBe('MISC')
  })

  it('drops a deleted transaction from the folded state', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'add', id: 'E02', at: '2026-07-05T08:00:01Z', tx: T2 },
      { op: 'delete', id: 'E03', at: '2026-07-06T09:00:00Z', ref: 'T1' },
    ])
    expect(out.map((t) => t.id)).toEqual(['T2'])
  })

  it('does not resurrect a deleted transaction with a later correction', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'delete', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1' },
      { op: 'set_category', id: 'E03', at: '2026-07-07T09:00:00Z', ref: 'T1', category: 'HRANA' },
    ])
    expect(out).toEqual([])
  })

  it('lets a later add for the same id replace the earlier one', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ description: 'FIRST READ' }) },
      { op: 'add', id: 'E02', at: '2026-07-06T08:00:00Z', tx: makeTx({ description: 'REPARSED' }) },
    ])
    expect(out).toHaveLength(1)
    expect(byId(out, 'T1').description).toBe('REPARSED')
  })

  it('sets a dimension value on the referenced transaction', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_dimension', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', axis: 'project', value: 'HOME' },
    ])
    expect(byId(out, 'T1').dimensions['project']).toBe('HOME')
  })

  it('clears an axis when set_dimension carries a null value', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ dimensions: { project: 'HOME' } }) },
      { op: 'set_dimension', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', axis: 'project', value: null },
    ])
    expect(byId(out, 'T1').dimensions['project'] ?? null).toBeNull()
  })

  it('leaves other axes untouched when one axis is set', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ dimensions: { project: 'HOME', client: 'ACME' } }) },
      { op: 'set_dimension', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', axis: 'project', value: 'GARAGE' },
    ])
    expect(byId(out, 'T1').dimensions).toEqual({ project: 'GARAGE', client: 'ACME' })
  })

  it('applies a corrected amount to the referenced transaction', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_amount', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', amount: -1350.5 },
    ])
    expect(byId(out, 'T1').amount).toBe(-1350.5)
  })

  it('flips direction when a corrected amount changes sign', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_amount', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', amount: 1200 },
    ])
    expect(byId(out, 'T1').direction).toBe('in')
  })

  it('ignores the `by` attribution field when computing state', () => {
    const withBy = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA', by: 'tebra' },
    ])
    const withoutBy = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
    ])
    expect(withBy).toEqual(withoutBy)
  })

  it('leaves unrelated transactions untouched when one is corrected', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
      { op: 'add', id: 'E02', at: '2026-07-05T08:00:01Z', tx: T2 },
      { op: 'set_category', id: 'E03', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
    ])
    expect(byId(out, 'T2')).toEqual(T2)
  })

  it('folds transactions from different books together without scoping them', () => {
    const out = fold([
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ id: 'P1', book: 'PERSONAL' }) },
      { op: 'add', id: 'E02', at: '2026-07-05T08:00:01Z', tx: makeTx({ id: 'D1', book: 'DILIGAF' }) },
    ])
    expect(out.map((t) => t.book).sort()).toEqual(['DILIGAF', 'PERSONAL'])
  })

  describe('split', () => {
    const splitLog: LedgerEvent[] = [
      { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ amount: -1200, amountRsd: -1200 }) },
      {
        op: 'split',
        id: 'E02',
        at: '2026-07-06T09:00:00Z',
        ref: 'T1',
        parts: [
          { amount: -700, category: 'HRANA' },
          { amount: -500, category: 'DECA' },
        ],
      },
    ]

    it('replaces the original transaction with its parts', () => {
      const out = fold(splitLog)
      expect(out).toHaveLength(2)
      expect(out.some((t) => t.amount === -1200)).toBe(false)
    })

    it('produces parts whose amounts sum to the original amount', () => {
      const total = fold(splitLog).reduce((sum, t) => sum + t.amount, 0)
      expect(total).toBeCloseTo(-1200, 2)
    })

    it('produces one part per split entry with the stated amount and category', () => {
      const out = fold(splitLog)
      expect(out.map((t) => ({ amount: t.amount, category: t.category })).sort((a, b) => a.amount - b.amount)).toEqual([
        { amount: -700, category: 'HRANA' },
        { amount: -500, category: 'DECA' },
      ].sort((a, b) => a.amount - b.amount))
    })

    it('carries the original book, date and currency onto every part', () => {
      for (const part of fold(splitLog)) {
        expect(part.book).toBe('PERSONAL')
        expect(part.txDate).toBe('2026-07-04')
        expect(part.currency).toBe('RSD')
      }
    })

    it('gives the parts distinct ids that are stable across repeated folds', () => {
      const first = fold(splitLog).map((t) => t.id)
      const second = fold([...splitLog].reverse()).map((t) => t.id)
      expect(new Set(first).size).toBe(2)
      expect([...first].sort()).toEqual([...second].sort())
    })

    it('preserves the total when a correction arrives for the already-split original', () => {
      const out = fold([
        ...splitLog,
        { op: 'set_category', id: 'E03', at: '2026-07-07T09:00:00Z', ref: 'T1', category: 'ZABAVA' },
      ])
      expect(out.reduce((sum, t) => sum + t.amount, 0)).toBeCloseTo(-1200, 2)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// invert() — the undo path. `current` is the state as it stood BEFORE the event
// was applied; that is the only state from which a prior value is recoverable.
// ─────────────────────────────────────────────────────────────────────────────

describe('invert', () => {
  const INV_ID = 'E-UNDO'
  const INV_AT = '2026-09-01T00:00:00Z'

  /** The property that matters: event + inverse folds back to the prior state. */
  function expectRoundTrip(base: LedgerEvent[], event: LedgerEvent): void {
    const before = fold(base)
    const inverse = invert(event, before, INV_ID, INV_AT)
    expect(inverse).not.toBeNull()
    expect(fold([...base, event, inverse as LedgerEvent])).toEqual(before)
  }

  const addOnly: LedgerEvent[] = [{ op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ category: 'MISC' }) }]

  it('returns a set_category event carrying the category the transaction had before', () => {
    const event: LedgerEvent = {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    const inverse = invert(event, fold(addOnly), INV_ID, INV_AT)
    expect(inverse).toMatchObject({ op: 'set_category', ref: 'T1', category: 'MISC' })
  })

  it('stamps the inverse with the injected id and timestamp rather than reusing the original', () => {
    const event: LedgerEvent = {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    const inverse = invert(event, fold(addOnly), INV_ID, INV_AT)
    expect(inverse).toMatchObject({ id: INV_ID, at: INV_AT })
  })

  it('restores the prior category exactly when the inverse is folded in', () => {
    expectRoundTrip(addOnly, {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    })
  })

  it('restores the prior amount and direction exactly', () => {
    expectRoundTrip(addOnly, { op: 'set_amount', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', amount: 4321 })
  })

  it('restores a dimension that previously held another value', () => {
    expectRoundTrip([{ op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: makeTx({ dimensions: { project: 'HOME' } }) }], {
      op: 'set_dimension',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      axis: 'project',
      value: 'GARAGE',
    })
  })

  it('restores a dimension that was previously absent, rather than leaving the new value in place', () => {
    expectRoundTrip(addOnly, {
      op: 'set_dimension',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      axis: 'project',
      value: 'HOME',
    })
  })

  it('undoes an add by removing the transaction it created', () => {
    expectRoundTrip([], { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 })
  })

  it('undoes a delete by restoring the transaction exactly as it stood', () => {
    expectRoundTrip(
      [
        { op: 'add', id: 'E01', at: '2026-07-05T08:00:00Z', tx: T1 },
        { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA' },
      ],
      { op: 'delete', id: 'E03', at: '2026-07-07T09:00:00Z', ref: 'T1' },
    )
  })

  it('returns null for a split, because no single event can un-split a transaction', () => {
    const event: LedgerEvent = {
      op: 'split',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      parts: [
        { amount: -700, category: 'HRANA' },
        { amount: -500, category: 'DECA' },
      ],
    }
    expect(invert(event, fold(addOnly), INV_ID, INV_AT)).toBeNull()
  })

  it.each<{ label: string; event: LedgerEvent }>([
    {
      label: 'set_category',
      event: { op: 'set_category', id: 'X1', at: '2026-07-20T09:00:00Z', ref: 'GHOST', category: 'HRANA' },
    },
    { label: 'set_amount', event: { op: 'set_amount', id: 'X2', at: '2026-07-20T09:00:00Z', ref: 'GHOST', amount: -99 } },
    {
      label: 'set_dimension',
      event: { op: 'set_dimension', id: 'X3', at: '2026-07-20T09:00:00Z', ref: 'GHOST', axis: 'project', value: 'X' },
    },
    { label: 'delete', event: { op: 'delete', id: 'X4', at: '2026-07-20T09:00:00Z', ref: 'GHOST' } },
  ])('returns null for a $label whose target is not in the current state', ({ event }) => {
    expect(invert(event, fold(addOnly), INV_ID, INV_AT)).toBeNull()
  })

  it('returns null when the current state is empty', () => {
    const event: LedgerEvent = {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    expect(invert(event, [], INV_ID, INV_AT)).toBeNull()
  })

  it('inverting the inverse reapplies the original change', () => {
    const event: LedgerEvent = {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    const before = fold(addOnly)
    const undo = invert(event, before, INV_ID, INV_AT) as LedgerEvent
    const afterUndo = fold([...addOnly, event, undo])
    const redo = invert(undo, afterUndo, 'E-REDO', '2026-09-02T00:00:00Z') as LedgerEvent
    expect(byId(fold([...addOnly, event, undo, redo]), 'T1').category).toBe('HRANA')
  })

  it('does not mutate the event or the state it is given', () => {
    const event: LedgerEvent = {
      op: 'set_category',
      id: 'E02',
      at: '2026-07-06T09:00:00Z',
      ref: 'T1',
      category: 'HRANA',
    }
    const eventSnapshot = structuredClone(event)
    const state = fold(addOnly)
    const stateSnapshot = structuredClone(state)
    invert(event, state, INV_ID, INV_AT)
    expect(event).toEqual(eventSnapshot)
    expect(state).toEqual(stateSnapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// dedupeKey()
// 04-PERSONAL §2: sha256(book | tx_date | amount | normalize(description) |
//                       value_date | balance_after)
// ─────────────────────────────────────────────────────────────────────────────

describe('dedupeKey', () => {
  it('returns the injected hash function’s output rather than the raw material', () => {
    const a = dedupeKey('PERSONAL', makeRaw(), constantHash)
    const b = dedupeKey('SMOQUA', makeRaw({ amount: -9 }), constantHash)
    expect(a).toBe('CONSTANT')
    expect(b).toBe('CONSTANT')
  })

  it('is stable across calls for the same input', () => {
    expect(dedupeKey('PERSONAL', makeRaw(), identityHash)).toBe(dedupeKey('PERSONAL', makeRaw(), identityHash))
  })

  it.each<{ field: string; over: Partial<RawTransaction> }>([
    { field: 'txDate', over: { txDate: '2026-07-05' } },
    { field: 'amount', over: { amount: -1201 } },
    { field: 'description', over: { description: 'POS 4738 MAXI BEOGRAD' } },
    { field: 'valueDate', over: { valueDate: '2026-07-06' } },
    { field: 'balanceAfter', over: { balanceAfter: 84320.56 } },
  ])('produces a different key when $field differs', ({ over }) => {
    expect(dedupeKey('PERSONAL', makeRaw(over), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw(), identityHash),
    )
  })

  it.each<BookCode>(['DILIGAF', 'SMOQUA'])('produces a different key for book %s', (book) => {
    expect(dedupeKey(book, makeRaw(), identityHash)).not.toBe(dedupeKey('PERSONAL', makeRaw(), identityHash))
  })

  it('keeps two genuinely identical same-day charges apart via balanceAfter', () => {
    // Two identical coffees, same day, same amount, same descriptor. The running
    // balance is the only thing that differs — and it must be enough.
    const firstCoffee = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: 12000 })
    const secondCoffee = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: 11710 })
    expect(dedupeKey('PERSONAL', firstCoffee, identityHash)).not.toBe(
      dedupeKey('PERSONAL', secondCoffee, identityHash),
    )
  })

  it('collapses two identical same-day charges when the bank reports no running balance', () => {
    // The accepted limitation: with balanceAfter null there is nothing left to
    // tell the two rows apart, and a re-sent statement must still dedupe.
    const a = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: null })
    const b = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: null })
    expect(dedupeKey('PERSONAL', a, identityHash)).toBe(dedupeKey('PERSONAL', b, identityHash))
  })

  it('treats an absent balance as different from a zero balance', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ balanceAfter: null }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ balanceAfter: 0 }), identityHash),
    )
  })

  it('treats an absent value date as different from one that equals the transaction date', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ valueDate: null }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ valueDate: '2026-07-04' }), identityHash),
    )
  })

  it('gives an inflow and an outflow of the same size different keys', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ amount: -1200 }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ amount: 1200 }), identityHash),
    )
  })

  it('gives the same key when only volatile description tokens differ', () => {
    // A re-sent statement can carry a different terminal id for the same charge.
    const first = makeRaw({ description: 'POS 4738 WOLT BEOGRAD REF:000123456789' })
    const resent = makeRaw({ description: 'POS 5912 WOLT BEOGRAD REF:000987654321' })
    expect(dedupeKey('PERSONAL', first, identityHash)).toBe(dedupeKey('PERSONAL', resent, identityHash))
  })

  it('hashes the normalized description, not the raw one', () => {
    const key = dedupeKey('PERSONAL', makeRaw({ description: 'POS 4738 WOLT BEOGRAD' }), identityHash)
    expect(key).not.toContain('4738')
  })

  it('gives the same amount in two currencies different keys', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ currency: 'RSD' }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ currency: 'EUR' }), identityHash),
    )
  })

  it('does not throw on an empty description', () => {
    expect(() => dedupeKey('PERSONAL', makeRaw({ description: '' }), identityHash)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// normalizeDescription()
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeDescription', () => {
  it.each<{ label: string; input: string; volatile: string }>([
    { label: 'a dotted date', input: 'KUPOVINA 11.08.2026 WOLT BEOGRAD', volatile: '11.08.2026' },
    { label: 'an ISO date', input: 'PLACANJE 2026-08-11 WOLT BEOGRAD', volatile: '2026-08-11' },
    { label: 'a time stamp', input: 'PLACANJE 2026-08-11 09:14 WOLT BEOGRAD', volatile: '09:14' },
    { label: 'a terminal id', input: 'POS 4738 WOLT BEOGRAD', volatile: '4738' },
    { label: 'a reference number', input: 'WOLT BEOGRAD REF:000123456789', volatile: '000123456789' },
    { label: 'a masked card suffix', input: 'WOLT BEOGRAD ****1234', volatile: '1234' },
    { label: 'an x-masked card suffix', input: 'WOLT BEOGRAD XXXX-5678', volatile: '5678' },
  ])('strips $label while keeping the merchant name', ({ input, volatile: token }) => {
    const out = normalizeDescription(input)
    expect(out).not.toContain(token)
    expect(out.toUpperCase()).toContain('WOLT')
  })

  it.each<[string, string]>([
    ['POS 4738 WOLT BEOGRAD', 'POS 5912 WOLT BEOGRAD'],
    ['WOLT BEOGRAD REF:000123456789', 'WOLT BEOGRAD REF:000987654321'],
    ['KUPOVINA 11.08.2026 WOLT BEOGRAD', 'KUPOVINA 12.08.2026 WOLT BEOGRAD'],
    ['WOLT BEOGRAD ****1234', 'WOLT BEOGRAD ****9876'],
    ['  WOLT   BEOGRAD ', 'WOLT BEOGRAD'],
    ['wolt beograd', 'WOLT BEOGRAD'],
  ])('normalizes %s and %s to the same value', (a, b) => {
    expect(normalizeDescription(a)).toBe(normalizeDescription(b))
  })

  it('collapses runs of whitespace and trims the result', () => {
    const out = normalizeDescription('   WOLT     BEOGRAD   ')
    expect(out).toBe(out.trim())
    expect(out).not.toMatch(/\s{2,}/)
  })

  it('is idempotent, so a rule derived from a normalized description still matches', () => {
    const once = normalizeDescription('POS 4738 WOLT BEOGRAD 11.08.2026')
    expect(normalizeDescription(once)).toBe(once)
  })

  it('returns an empty string for an empty description', () => {
    expect(normalizeDescription('')).toBe('')
  })

  it('returns an empty string for a whitespace-only description', () => {
    expect(normalizeDescription('   \t \n ')).toBe('')
  })

  it('returns an empty string when the description is nothing but volatile tokens', () => {
    expect(normalizeDescription('POS 4738 11.08.2026 ****1234')).toBe('')
  })

  it('keeps two genuinely different merchants distinguishable', () => {
    expect(normalizeDescription('POS 4738 WOLT BEOGRAD')).not.toBe(normalizeDescription('POS 4738 MAXI BEOGRAD'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractCounterparty()
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCounterparty', () => {
  it.each<[string, string]>([
    ['POS 4738 WOLT BEOGRAD', 'WOLT'],
    ['KUPOVINA 11.08.2026 MAXI 021 NOVI SAD', 'MAXI'],
    ['UPLATA OD EPS SNABDEVANJE DOO', 'EPS'],
  ])('reads a merchant name out of %s', (input, expected) => {
    const out = extractCounterparty(input)
    expect(out).not.toBeNull()
    expect((out as string).toUpperCase()).toContain(expected)
  })

  it.each<string>(['', '   ', '4738', 'POS 4738', '****1234', '000123456789'])(
    'returns null rather than guessing a merchant from %j',
    (input) => {
      expect(extractCounterparty(input)).toBeNull()
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// toTransaction()
// ─────────────────────────────────────────────────────────────────────────────

describe('toTransaction', () => {
  const CREATED = '2026-08-01T06:00:00Z'

  it('carries the raw fields and the injected identity onto the transaction', () => {
    const tx = toTransaction(makeRaw(), 'PERSONAL', 'T-NEW', 'K-NEW', CREATED)
    expect(tx).toMatchObject({
      id: 'T-NEW',
      book: 'PERSONAL',
      txDate: '2026-07-04',
      valueDate: '2026-07-04',
      description: 'POS 4738 WOLT BEOGRAD',
      amount: -1200,
      currency: 'RSD',
      dedupeKey: 'K-NEW',
      createdAt: CREATED,
    })
  })

  it.each<[number, string]>([
    [-0.01, 'out'],
    [0.01, 'in'],
    [-1200, 'out'],
    [150000, 'in'],
  ])('derives direction %s from the sign of the amount', (amount, direction) => {
    expect(toTransaction(makeRaw({ amount }), 'PERSONAL', 'T', 'K', CREATED).direction).toBe(direction)
  })

  it('starts a transaction unresolved, in MISC, so nothing is silently categorized', () => {
    expect(toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED).category).toBe('MISC')
  })

  it('records the statement as the source and leaves the source document unset', () => {
    const tx = toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED)
    expect(tx.source).toBe('statement')
    expect(tx.sourceDocument).toBeNull()
  })

  it('starts with no dimensions rather than inventing any', () => {
    expect(toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED).dimensions).toEqual({})
  })

  it('passes an absent value date through as null', () => {
    expect(toTransaction(makeRaw({ valueDate: null }), 'PERSONAL', 'T', 'K', CREATED).valueDate).toBeNull()
  })

  it('sets amountRsd from the amount when the transaction is already in dinars', () => {
    expect(toTransaction(makeRaw({ currency: 'RSD', amount: -1200 }), 'PERSONAL', 'T', 'K', CREATED).amountRsd).toBe(-1200)
  })

  it('leaves amountRsd null for a foreign currency, because no rate was supplied', () => {
    expect(toTransaction(makeRaw({ currency: 'EUR', amount: -300 }), 'PERSONAL', 'T', 'K', CREATED).amountRsd).toBeNull()
  })

  it('leaves counterparty null when the descriptor holds no usable merchant name', () => {
    expect(toTransaction(makeRaw({ description: 'POS 4738' }), 'PERSONAL', 'T', 'K', CREATED).counterparty).toBeNull()
  })

  it('does not mutate the raw transaction it is given', () => {
    const raw = makeRaw()
    const snapshot = structuredClone(raw)
    toTransaction(raw, 'PERSONAL', 'T', 'K', CREATED)
    expect(raw).toEqual(snapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// validateSplit()
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSplit', () => {
  const spend = makeTx({ amount: -100, amountRsd: -100, direction: 'out' })
  const income = makeTx({ amount: 100, amountRsd: 100, direction: 'in' })

  it('accepts parts that sum exactly to the original amount', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -30, category: 'DECA' },
    ])
    expect(result).toEqual({ valid: true, difference: 0, errors: [] })
  })

  it('accepts a sum that only floating point makes inexact', () => {
    // -33.33 + -33.33 + -33.34 is -100.00000000000001 in IEEE 754.
    const result = validateSplit(spend, [
      { amount: -33.33, category: 'HRANA' },
      { amount: -33.33, category: 'DECA' },
      { amount: -33.34, category: 'ZABAVA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('accepts a ten-part split that sums exactly', () => {
    const parts: SplitPart[] = Array.from({ length: 10 }, () => ({ amount: -10, category: 'HRANA' }))
    expect(validateSplit(spend, parts).valid).toBe(true)
  })

  it('accepts a single part covering the whole amount', () => {
    expect(validateSplit(spend, [{ amount: -100, category: 'HRANA' }]).valid).toBe(true)
  })

  it('rejects a sum that is over by exactly one hundredth', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -30.01, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(-0.01)
  })

  it('rejects a sum that is under by exactly one hundredth', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -29.99, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0.01)
  })

  it('accepts a discrepancy that disappears at two decimal places', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -30.004, category: 'DECA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('reports the difference as the parts’ sum minus the original amount, to 2dp', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -25, category: 'DECA' },
    ])
    expect(result.difference).toBe(5)
  })

  it('rejects a part whose sign disagrees with the original even when the sum is right', () => {
    // -150 + 50 = -100: arithmetically fine, but a positive part inside an
    // outflow is a refund the ledger should record separately, not a split.
    const result = validateSplit(spend, [
      { amount: -150, category: 'HRANA' },
      { amount: 50, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('accepts an income transaction split into positive parts', () => {
    expect(
      validateSplit(income, [
        { amount: 60, category: 'PRIHOD' },
        { amount: 40, category: 'PRIHOD' },
      ]).valid,
    ).toBe(true)
  })

  it('rejects an income transaction split into negative parts', () => {
    expect(
      validateSplit(income, [
        { amount: -60, category: 'PRIHOD' },
        { amount: -40, category: 'PRIHOD' },
      ]).valid,
    ).toBe(false)
  })

  it('rejects a zero-amount part, which has no sign to share', () => {
    expect(
      validateSplit(spend, [
        { amount: -100, category: 'HRANA' },
        { amount: 0, category: 'DECA' },
      ]).valid,
    ).toBe(false)
  })

  it('rejects an empty list of parts and reports the whole amount as the difference', () => {
    const result = validateSplit(spend, [])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(100)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it.each<{ label: string; amount: number }>([
    { label: 'NaN', amount: Number.NaN },
    { label: 'Infinity', amount: Number.POSITIVE_INFINITY },
    { label: '-Infinity', amount: Number.NEGATIVE_INFINITY },
  ])('rejects a $label part instead of throwing', ({ amount }) => {
    const run = () => validateSplit(spend, [{ amount, category: 'HRANA' }])
    expect(run).not.toThrow()
    expect(run().valid).toBe(false)
  })

  it('reports at least one error whenever the split is invalid', () => {
    const invalid: SplitPart[][] = [
      [],
      [{ amount: -99, category: 'HRANA' }],
      [
        { amount: -150, category: 'HRANA' },
        { amount: 50, category: 'DECA' },
      ],
      [{ amount: Number.NaN, category: 'HRANA' }],
    ]
    for (const parts of invalid) {
      const result = validateSplit(spend, parts)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('reports no errors when the split is valid', () => {
    expect(
      validateSplit(spend, [
        { amount: -70, category: 'HRANA' },
        { amount: -30, category: 'DECA' },
      ]).errors,
    ).toEqual([])
  })

  it('does not mutate the transaction or the parts it is given', () => {
    const parts: SplitPart[] = [
      { amount: -70, category: 'HRANA' },
      { amount: -30, category: 'DECA' },
    ]
    const txSnapshot = structuredClone(spend)
    const partsSnapshot = structuredClone(parts)
    validateSplit(spend, parts)
    expect(spend).toEqual(txSnapshot)
    expect(parts).toEqual(partsSnapshot)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// suggestSplit()
// ─────────────────────────────────────────────────────────────────────────────

describe('suggestSplit', () => {
  const basket = makeTx({ amount: -1200, amountRsd: -1200, description: 'MAXI 021 NOVI SAD' })

  const mixedItems = [
    { description: 'PAMPERS', lineTotal: 700, category: 'DECA' },
    { description: 'MLEKO', lineTotal: 300, category: 'HRANA' },
    { description: 'HLEB', lineTotal: 200, category: 'HRANA' },
  ]

  it('suggests one part per distinct category, aggregating the items in each', () => {
    const parts = suggestSplit(basket, mixedItems)
    expect(parts).not.toBeNull()
    const byCategory = Object.fromEntries((parts as SplitPart[]).map((p) => [p.category, p.amount]))
    expect(Object.keys(byCategory).sort()).toEqual(['DECA', 'HRANA'])
    expect(byCategory['DECA']).toBeCloseTo(-700, 2)
    expect(byCategory['HRANA']).toBeCloseTo(-500, 2)
  })

  it('gives the parts the transaction’s sign, not the line items’', () => {
    const parts = suggestSplit(basket, mixedItems) as SplitPart[]
    for (const part of parts) expect(part.amount).toBeLessThan(0)
  })

  it('produces a suggestion that its own validator accepts', () => {
    const parts = suggestSplit(basket, mixedItems) as SplitPart[]
    expect(validateSplit(basket, parts).valid).toBe(true)
  })

  it('returns null when every line item agrees on one category', () => {
    expect(
      suggestSplit(basket, [
        { description: 'MLEKO', lineTotal: 900, category: 'HRANA' },
        { description: 'HLEB', lineTotal: 300, category: 'HRANA' },
      ]),
    ).toBeNull()
  })

  it('returns null when there are no line items to disagree', () => {
    expect(suggestSplit(basket, [])).toBeNull()
  })

  it('returns null when a line total is missing, rather than apportioning the remainder', () => {
    expect(
      suggestSplit(basket, [
        { description: 'PAMPERS', lineTotal: null, category: 'DECA' },
        { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      ]),
    ).toBeNull()
  })

  it('returns null when a line item has no category, rather than guessing one', () => {
    expect(
      suggestSplit(basket, [
        { description: 'PAMPERS', lineTotal: 700, category: 'DECA' },
        { description: 'NEPOZNATO', lineTotal: 500, category: null },
      ]),
    ).toBeNull()
  })

  it('returns null when the line totals do not add up to the transaction amount', () => {
    expect(
      suggestSplit(basket, [
        { description: 'PAMPERS', lineTotal: 700, category: 'DECA' },
        { description: 'MLEKO', lineTotal: 300, category: 'HRANA' },
      ]),
    ).toBeNull()
  })

  it('returns null for a single line item, since one item cannot disagree with itself', () => {
    expect(suggestSplit(basket, [{ description: 'PAMPERS', lineTotal: 1200, category: 'DECA' }])).toBeNull()
  })
})
