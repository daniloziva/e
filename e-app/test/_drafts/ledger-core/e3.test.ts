/**
 * E — ledger core: event folding, dedupe identity, splits.
 * Engineer #3. Written before any implementation exists: every case below is
 * expected to fail with "not implemented" until the stubs are filled in.
 *
 * Contract: src/core/ledger/fold.ts, normalize.ts, split.ts, src/core/types.ts
 * Spec: 01-ARCHITECTURE.md §3, 04-PERSONAL.md §2 Dedupe / §3 Splits, 09-TEBRA.md §4
 */

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
import type { Transaction } from '../../../src/core/types.js'

// ─────────────────────────── hand-written fakes & builders ───────────────────────────

/** Injected hash. Deterministic, collision-free for our inputs, and inspectable. */
const fakeHash = (s: string): string => `sha256:${s}`

/** Same, but records every input so we can assert what went into the key. */
function recordingHash(): { calls: string[]; hash: (s: string) => string } {
  const calls: string[] = []
  return { calls, hash: (s: string) => { calls.push(s); return fakeHash(s) } }
}

const BASE_TX: Transaction = {
  id: 'tx-1',
  book: 'PERSONAL',
  txDate: '2026-07-04',
  valueDate: '2026-07-04',
  description: 'WOLT BEOGRAD 04.07.2026 POS 4738',
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
  createdAt: '2026-08-01T09:00:00Z',
}

function mkTx(over: Partial<Transaction> = {}): Transaction {
  return { ...BASE_TX, dimensions: { ...BASE_TX.dimensions }, ...over }
}

function addEv(id: string, at: string, tx: Transaction): LedgerEvent {
  return { op: 'add', id, at, tx }
}

/** Fold output lookup that fails loudly rather than returning undefined. */
function one(list: Transaction[], id: string): Transaction {
  const found = list.find((t) => t.id === id)
  if (!found) throw new Error(`expected fold output to contain tx ${id}, got [${list.map((t) => t.id).join(', ')}]`)
  return found
}

/** Deterministic permutation — a "shuffle" with no randomness in the test. */
function shuffle<T>(xs: readonly T[]): T[] {
  const out = [...xs]
  let seed = 1337
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const j = seed % (i + 1)
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

const RAW: RawTransaction = {
  txDate: '2026-07-04',
  valueDate: '2026-07-04',
  description: 'WOLT BEOGRAD 04.07.2026 POS 4738',
  amount: -1890,
  currency: 'RSD',
  balanceAfter: 122430.55,
}

function mkRaw(over: Partial<RawTransaction> = {}): RawTransaction {
  return { ...RAW, ...over }
}

// ═════════════════════════════════════ fold() ═════════════════════════════════════

describe('fold', () => {
  it('returns an empty list for an empty event log', () => {
    expect(fold([])).toEqual([])
  })

  it('materialises a single add event as exactly that transaction', () => {
    const tx = mkTx()
    expect(fold([addEv('e1', '2026-08-01T09:00:00Z', tx)])).toEqual([tx])
  })

  it('applies a set_category correction over the original category', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ category: 'MISC' })),
      { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' },
    ]
    expect(one(fold(events), 'tx-1').category).toBe('HRANA')
  })

  it('leaves every other field untouched when applying a set_category', () => {
    const original = mkTx({ category: 'MISC' })
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', original),
      { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' },
    ]
    expect(one(fold(events), 'tx-1')).toEqual({ ...original, category: 'HRANA' })
  })

  it('applies a set_amount correction and preserves the description', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ amount: -1890 })),
      { op: 'set_amount', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', amount: -1990 },
    ]
    const result = one(fold(events), 'tx-1')
    expect(result.amount).toBe(-1990)
    expect(result.description).toBe(BASE_TX.description)
  })

  it('sets a dimension value on the referenced transaction', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ dimensions: {} })),
      { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', axis: 'projekat', value: 'STAN-01' },
    ]
    expect(one(fold(events), 'tx-1').dimensions).toEqual({ projekat: 'STAN-01' })
  })

  it('clears a dimension to null rather than dropping the axis when value is null', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ dimensions: { projekat: 'STAN-01' } })),
      { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', axis: 'projekat', value: null },
    ]
    const dims = one(fold(events), 'tx-1').dimensions
    expect(dims).toEqual({ projekat: null })
    expect('projekat' in dims).toBe(true)
  })

  it('lets the later of two corrections to the same field win', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx()),
      { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' },
      { op: 'set_category', id: 'e3', at: '2026-08-01T11:00:00Z', ref: 'tx-1', category: 'ZABAVA' },
    ]
    expect(one(fold(events), 'tx-1').category).toBe('ZABAVA')
  })

  it('lets the later correction win even when it appears first in the input array', () => {
    const later: LedgerEvent = { op: 'set_category', id: 'e3', at: '2026-08-01T11:00:00Z', ref: 'tx-1', category: 'ZABAVA' }
    const earlier: LedgerEvent = { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' }
    const events: LedgerEvent[] = [later, earlier, addEv('e1', '2026-08-01T09:00:00Z', mkTx())]
    expect(one(fold(events), 'tx-1').category).toBe('ZABAVA')
  })

  it('breaks an identical-timestamp tie by ascending event id', () => {
    const at = '2026-08-01T10:00:00Z'
    const a: LedgerEvent = { op: 'set_category', id: 'e-aaa', at, ref: 'tx-1', category: 'HRANA' }
    const b: LedgerEvent = { op: 'set_category', id: 'e-bbb', at, ref: 'tx-1', category: 'ZABAVA' }
    const add = addEv('e-000', '2026-08-01T09:00:00Z', mkTx())
    expect(one(fold([add, a, b]), 'tx-1').category).toBe('ZABAVA')
    expect(one(fold([add, b, a]), 'tx-1').category).toBe('ZABAVA')
  })

  it('folds a shuffled event array identically to a chronologically sorted one', () => {
    const sorted: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ id: 'tx-1' })),
      addEv('e2', '2026-08-01T09:05:00Z', mkTx({ id: 'tx-2', amount: -540, description: 'MAXI 04.07.2026' })),
      { op: 'set_category', id: 'e3', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' },
      { op: 'set_dimension', id: 'e4', at: '2026-08-01T10:30:00Z', ref: 'tx-2', axis: 'projekat', value: 'P1' },
      { op: 'set_amount', id: 'e5', at: '2026-08-01T11:00:00Z', ref: 'tx-1', amount: -1990 },
      { op: 'set_category', id: 'e6', at: '2026-08-01T12:00:00Z', ref: 'tx-2', category: 'HRANA' },
    ]
    expect(fold(shuffle(sorted))).toEqual(fold(sorted))
  })

  it('removes a transaction when a delete event references it', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ id: 'tx-1' })),
      addEv('e2', '2026-08-01T09:01:00Z', mkTx({ id: 'tx-2' })),
      { op: 'delete', id: 'e3', at: '2026-08-01T10:00:00Z', ref: 'tx-1' },
    ]
    expect(fold(events).map((t) => t.id)).toEqual(['tx-2'])
  })

  it('ignores a correction that arrives after the transaction was deleted', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx()),
      { op: 'delete', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1' },
      { op: 'set_category', id: 'e3', at: '2026-08-01T11:00:00Z', ref: 'tx-1', category: 'HRANA' },
    ]
    expect(fold(events)).toEqual([])
  })

  it('ignores a correction timestamped before the transaction it references was added', () => {
    const events: LedgerEvent[] = [
      { op: 'set_category', id: 'e1', at: '2026-08-01T08:00:00Z', ref: 'tx-1', category: 'HRANA' },
      addEv('e2', '2026-08-01T09:00:00Z', mkTx({ category: 'MISC' })),
    ]
    expect(one(fold(events), 'tx-1').category).toBe('MISC')
  })

  const unknownRefEvents: Array<{ name: string; event: LedgerEvent }> = [
    { name: 'set_category', event: { op: 'set_category', id: 'x1', at: '2026-08-01T10:00:00Z', ref: 'ghost', category: 'HRANA' } },
    { name: 'set_amount', event: { op: 'set_amount', id: 'x2', at: '2026-08-01T10:00:00Z', ref: 'ghost', amount: -1 } },
    { name: 'set_dimension', event: { op: 'set_dimension', id: 'x3', at: '2026-08-01T10:00:00Z', ref: 'ghost', axis: 'projekat', value: 'P1' } },
    { name: 'split', event: { op: 'split', id: 'x4', at: '2026-08-01T10:00:00Z', ref: 'ghost', parts: [{ amount: -1000, category: 'HRANA' }, { amount: -890, category: 'DECA' }] } },
    { name: 'delete', event: { op: 'delete', id: 'x5', at: '2026-08-01T10:00:00Z', ref: 'ghost' } },
  ]

  it.each(unknownRefEvents)('ignores a $name event referencing an unknown transaction instead of throwing', ({ event }) => {
    const tx = mkTx()
    const events: LedgerEvent[] = [addEv('e1', '2026-08-01T09:00:00Z', tx), event]
    expect(() => fold(events)).not.toThrow()
    expect(fold(events)).toEqual([tx])
  })

  it('returns an empty list when every event references an unknown transaction', () => {
    const events: LedgerEvent[] = [
      { op: 'set_category', id: 'x1', at: '2026-08-01T10:00:00Z', ref: 'ghost', category: 'HRANA' },
      { op: 'delete', id: 'x2', at: '2026-08-01T11:00:00Z', ref: 'ghost' },
    ]
    expect(fold(events)).toEqual([])
  })

  it('keeps applying valid events after an unknown-reference event in the middle of the log', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx()),
      { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'ghost', category: 'ZABAVA' },
      { op: 'set_category', id: 'e3', at: '2026-08-01T11:00:00Z', ref: 'tx-1', category: 'HRANA' },
    ]
    expect(one(fold(events), 'tx-1').category).toBe('HRANA')
  })

  it('collapses two add events carrying the same transaction id, letting the later one win', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ amount: -1890 })),
      addEv('e2', '2026-08-01T10:00:00Z', mkTx({ amount: -1990 })),
    ]
    const result = fold(events)
    expect(result).toHaveLength(1)
    expect(one(result, 'tx-1').amount).toBe(-1990)
  })

  it('replaces a transaction with its parts when a split event is folded', () => {
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ amount: -1890, category: 'MISC' })),
      {
        op: 'split',
        id: 'e2',
        at: '2026-08-01T10:00:00Z',
        ref: 'tx-1',
        parts: [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }],
      },
    ]
    const result = fold(events)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.category).sort()).toEqual(['DECA', 'HRANA'])
    expect(result.map((t) => t.amount).reduce((a, b) => a + b, 0)).toBeCloseTo(-1890, 2)
  })

  it('conserves the ledger total across a split', () => {
    const before: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', mkTx({ id: 'tx-1', amount: -1890 })),
      addEv('e2', '2026-08-01T09:01:00Z', mkTx({ id: 'tx-2', amount: -540 })),
    ]
    const after: LedgerEvent[] = [
      ...before,
      {
        op: 'split',
        id: 'e3',
        at: '2026-08-01T10:00:00Z',
        ref: 'tx-1',
        parts: [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }],
      },
    ]
    const total = (txs: Transaction[]) => txs.reduce((sum, t) => sum + t.amount, 0)
    expect(total(fold(after))).toBeCloseTo(total(fold(before)), 2)
  })

  it('ignores a split whose parts do not sum to the original amount rather than losing money', () => {
    const tx = mkTx({ amount: -1890 })
    const events: LedgerEvent[] = [
      addEv('e1', '2026-08-01T09:00:00Z', tx),
      {
        op: 'split',
        id: 'e2',
        at: '2026-08-01T10:00:00Z',
        ref: 'tx-1',
        parts: [{ amount: -1200, category: 'HRANA' }, { amount: -600, category: 'DECA' }],
      },
    ]
    expect(fold(events)).toEqual([tx])
  })

  it('does not mutate the event array it is given', () => {
    const events: LedgerEvent[] = [
      { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' },
      addEv('e1', '2026-08-01T09:00:00Z', mkTx()),
    ]
    const snapshot = structuredClone(events)
    fold(events)
    expect(events).toEqual(snapshot)
  })
})

// ═════════════════════════════════════ invert() ═════════════════════════════════════

describe('invert', () => {
  const NOW = '2026-08-02T12:00:00Z'
  const current = [mkTx({ id: 'tx-1', category: 'HRANA', amount: -1890, dimensions: { projekat: 'P1' } })]

  it('inverts an add into a delete of the transaction it created', () => {
    const add = addEv('e1', '2026-08-01T09:00:00Z', mkTx({ id: 'tx-1' }))
    expect(invert(add, current, 'undo-1', NOW)).toEqual({ op: 'delete', id: 'undo-1', at: NOW, ref: 'tx-1' })
  })

  it('inverts a set_category back to the category the transaction currently has', () => {
    const ev: LedgerEvent = { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'ZABAVA' }
    expect(invert(ev, current, 'undo-1', NOW)).toEqual({
      op: 'set_category', id: 'undo-1', at: NOW, ref: 'tx-1', category: 'HRANA',
    })
  })

  it('inverts a set_category back to MISC when the transaction is still unresolved', () => {
    const unresolved = [mkTx({ id: 'tx-1', category: 'MISC' })]
    const ev: LedgerEvent = { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'HRANA' }
    expect(invert(ev, unresolved, 'undo-1', NOW)?.op).toBe('set_category')
    expect(invert(ev, unresolved, 'undo-1', NOW)).toMatchObject({ category: 'MISC' })
  })

  it('inverts a set_amount back to the prior amount', () => {
    const ev: LedgerEvent = { op: 'set_amount', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', amount: -2500 }
    expect(invert(ev, current, 'undo-1', NOW)).toEqual({
      op: 'set_amount', id: 'undo-1', at: NOW, ref: 'tx-1', amount: -1890,
    })
  })

  it('inverts a set_dimension back to the prior value on that axis', () => {
    const ev: LedgerEvent = { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', axis: 'projekat', value: 'P2' }
    expect(invert(ev, current, 'undo-1', NOW)).toEqual({
      op: 'set_dimension', id: 'undo-1', at: NOW, ref: 'tx-1', axis: 'projekat', value: 'P1',
    })
  })

  it('inverts a set_dimension on an axis that had no value back to null', () => {
    const ev: LedgerEvent = { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', axis: 'lokacija', value: 'BG' }
    expect(invert(ev, current, 'undo-1', NOW)).toEqual({
      op: 'set_dimension', id: 'undo-1', at: NOW, ref: 'tx-1', axis: 'lokacija', value: null,
    })
  })

  it('uses the injected id and timestamp rather than copying the original event id', () => {
    const ev: LedgerEvent = { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'ZABAVA' }
    const inverse = invert(ev, current, 'undo-9', '2026-12-31T23:59:59Z')
    expect(inverse).toMatchObject({ id: 'undo-9', at: '2026-12-31T23:59:59Z' })
  })

  it('returns null for a delete, because the deleted transaction is no longer available to restore', () => {
    const ev: LedgerEvent = { op: 'delete', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1' }
    expect(invert(ev, [], 'undo-1', NOW)).toBeNull()
  })

  it('returns null for a split, because no single event un-splits a transaction', () => {
    const ev: LedgerEvent = {
      op: 'split', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1',
      parts: [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }],
    }
    expect(invert(ev, current, 'undo-1', NOW)).toBeNull()
  })

  const unknownRef: Array<{ name: string; event: LedgerEvent }> = [
    { name: 'set_category', event: { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'ghost', category: 'HRANA' } },
    { name: 'set_amount', event: { op: 'set_amount', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'ghost', amount: -1 } },
    { name: 'set_dimension', event: { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'ghost', axis: 'projekat', value: 'P2' } },
    { name: 'delete', event: { op: 'delete', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'ghost' } },
  ]

  it.each(unknownRef)('returns null for a $name event whose transaction is not in current state', ({ event }) => {
    expect(invert(event, current, 'undo-1', NOW)).toBeNull()
  })

  it('returns null when inverting an add whose transaction is already gone', () => {
    const add = addEv('e1', '2026-08-01T09:00:00Z', mkTx({ id: 'tx-1' }))
    expect(invert(add, [], 'undo-1', NOW)).toBeNull()
  })

  it('restores the exact prior state when the inverse of a set_category is appended and re-folded', () => {
    const before: LedgerEvent[] = [addEv('e1', '2026-08-01T09:00:00Z', mkTx({ category: 'HRANA' }))]
    const correction: LedgerEvent = { op: 'set_category', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', category: 'ZABAVA' }
    const afterCorrection = fold([...before, correction])
    const inverse = invert(correction, afterCorrection, 'undo-1', NOW)
    expect(inverse).not.toBeNull()
    expect(fold([...before, correction, inverse as LedgerEvent])).toEqual(fold(before))
  })

  it('restores the exact prior state when the inverse of a set_amount is appended and re-folded', () => {
    const before: LedgerEvent[] = [addEv('e1', '2026-08-01T09:00:00Z', mkTx({ amount: -1890 }))]
    const correction: LedgerEvent = { op: 'set_amount', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', amount: -2500 }
    const inverse = invert(correction, fold([...before, correction]), 'undo-1', NOW)
    expect(fold([...before, correction, inverse as LedgerEvent])).toEqual(fold(before))
  })

  it('restores an absent dimension exactly, not an empty string, when its set_dimension is undone', () => {
    const before: LedgerEvent[] = [addEv('e1', '2026-08-01T09:00:00Z', mkTx({ dimensions: {} }))]
    const correction: LedgerEvent = { op: 'set_dimension', id: 'e2', at: '2026-08-01T10:00:00Z', ref: 'tx-1', axis: 'projekat', value: 'P1' }
    const inverse = invert(correction, fold([...before, correction]), 'undo-1', NOW)
    const restored = one(fold([...before, correction, inverse as LedgerEvent]), 'tx-1')
    expect(restored.dimensions['projekat']).toBeNull()
  })

  it('undoes an add so that the transaction disappears from the fold', () => {
    const add = addEv('e1', '2026-08-01T09:00:00Z', mkTx())
    const inverse = invert(add, fold([add]), 'undo-1', NOW)
    expect(fold([add, inverse as LedgerEvent])).toEqual([])
  })
})

// ═══════════════════════════════════ dedupeKey() ═══════════════════════════════════

describe('dedupeKey', () => {
  it('returns exactly what the injected hash returned', () => {
    const { calls, hash } = recordingHash()
    const key = dedupeKey('PERSONAL', mkRaw(), hash)
    expect(key).toBe(fakeHash(calls[0] ?? '<never hashed>'))
  })

  it('hashes exactly once per transaction', () => {
    const { calls, hash } = recordingHash()
    dedupeKey('PERSONAL', mkRaw(), hash)
    expect(calls).toHaveLength(1)
  })

  it('feeds the book, dates, amount and balance into the hashed identity', () => {
    const { calls, hash } = recordingHash()
    dedupeKey('PERSONAL', mkRaw(), hash)
    const hashed = calls[0] ?? ''
    expect(hashed).toContain('PERSONAL')
    expect(hashed).toContain('2026-07-04')
    expect(hashed).toContain('1890')
    expect(hashed).toContain('122430.55')
  })

  it('feeds the normalized description, not the raw one, into the hashed identity', () => {
    const { calls, hash } = recordingHash()
    const raw = mkRaw({ description: 'WOLT BEOGRAD 04.07.2026 POS 4738' })
    dedupeKey('PERSONAL', raw, hash)
    const hashed = calls[0] ?? ''
    expect(hashed).toContain(normalizeDescription(raw.description))
    expect(hashed).not.toContain('04.07.2026')
    expect(hashed).not.toContain('4738')
  })

  it('produces the same key for the same raw transaction every time', () => {
    expect(dedupeKey('PERSONAL', mkRaw(), fakeHash)).toBe(dedupeKey('PERSONAL', mkRaw(), fakeHash))
  })

  it('keeps two genuinely identical same-day charges as two transactions via balanceAfter', () => {
    const firstCoffee = mkRaw({ description: 'KAFETERIJA BG', amount: -280, balanceAfter: 122430.55 })
    const secondCoffee = mkRaw({ description: 'KAFETERIJA BG', amount: -280, balanceAfter: 122150.55 })
    expect(dedupeKey('PERSONAL', firstCoffee, fakeHash)).not.toBe(dedupeKey('PERSONAL', secondCoffee, fakeHash))
  })

  it('treats an absent balance as different from a zero balance', () => {
    const absent = mkRaw({ balanceAfter: null })
    const zero = mkRaw({ balanceAfter: 0 })
    expect(dedupeKey('PERSONAL', absent, fakeHash)).not.toBe(dedupeKey('PERSONAL', zero, fakeHash))
  })

  it('treats an absent value date as different from a value date equal to the transaction date', () => {
    const absent = mkRaw({ valueDate: null })
    const same = mkRaw({ valueDate: '2026-07-04' })
    expect(dedupeKey('PERSONAL', absent, fakeHash)).not.toBe(dedupeKey('PERSONAL', same, fakeHash))
  })

  it('produces a key without throwing when both optional fields are absent', () => {
    expect(() => dedupeKey('PERSONAL', mkRaw({ valueDate: null, balanceAfter: null }), fakeHash)).not.toThrow()
  })

  const distinguishing: Array<{ field: string; over: Partial<RawTransaction> }> = [
    { field: 'txDate', over: { txDate: '2026-07-05' } },
    { field: 'valueDate', over: { valueDate: '2026-07-06' } },
    { field: 'amount', over: { amount: -1891 } },
    { field: 'amount sign', over: { amount: 1890 } },
    { field: 'balanceAfter', over: { balanceAfter: 122430.56 } },
    { field: 'merchant in description', over: { description: 'MAXI BEOGRAD 04.07.2026 POS 4738' } },
  ]

  it.each(distinguishing)('produces a different key when $field differs', ({ over }) => {
    expect(dedupeKey('PERSONAL', mkRaw(over), fakeHash)).not.toBe(dedupeKey('PERSONAL', mkRaw(), fakeHash))
  })

  it('produces a different key for the same row filed under a different book', () => {
    expect(dedupeKey('PERSONAL', mkRaw(), fakeHash)).not.toBe(dedupeKey('SMOQUA', mkRaw(), fakeHash))
  })

  it('produces the same key when only volatile tokens in the description differ', () => {
    const a = mkRaw({ description: 'WOLT BEOGRAD 04.07.2026 POS 4738' })
    const b = mkRaw({ description: 'WOLT BEOGRAD 04/07/26 POS 9911 REF 8812' })
    expect(dedupeKey('PERSONAL', a, fakeHash)).toBe(dedupeKey('PERSONAL', b, fakeHash))
  })
})

// ═══════════════════════════════ normalizeDescription() ═══════════════════════════════

describe('normalizeDescription', () => {
  const volatile: Array<{ token: string; input: string; keep: string; strip: string }> = [
    { token: 'dotted date', input: 'WOLT BEOGRAD 04.07.2026', keep: 'WOLT', strip: '04.07.2026' },
    { token: 'ISO date', input: 'MAXI 2026-07-04', keep: 'MAXI', strip: '2026-07-04' },
    { token: 'slashed short date', input: 'IDEA 04/07/26', keep: 'IDEA', strip: '04/07/26' },
    { token: 'terminal id', input: 'OMV SRBIJA TERM 00123', keep: 'OMV', strip: '00123' },
    { token: 'POS terminal number', input: 'LILLY POS 4738', keep: 'LILLY', strip: '4738' },
    { token: 'reference number', input: 'EPS SNABDEVANJE REF:998877', keep: 'EPS', strip: '998877' },
    { token: 'masked card suffix', input: 'AIR SERBIA **** 1234', keep: 'AIR', strip: '1234' },
    { token: 'x-masked card suffix', input: 'BOLT XXXX4821', keep: 'BOLT', strip: '4821' },
  ]

  it.each(volatile)('strips the $token and keeps the merchant token', ({ input, keep, strip }) => {
    const result = normalizeDescription(input)
    expect(result).not.toContain(strip)
    expect(result.toUpperCase()).toContain(keep)
  })

  it('normalizes the same recurring charge on two different dates to one identical string', () => {
    const july = normalizeDescription('WOLT BEOGRAD 04.07.2026 POS 4738')
    const august = normalizeDescription('WOLT BEOGRAD 11.08.2026 POS 9911')
    expect(july).toBe(august)
  })

  it('is idempotent, so normalizing an already normalized description changes nothing', () => {
    const once = normalizeDescription('WOLT BEOGRAD 04.07.2026 POS 4738')
    expect(normalizeDescription(once)).toBe(once)
  })

  it('ignores letter case differences between two spellings of the same merchant', () => {
    expect(normalizeDescription('wolt beograd')).toBe(normalizeDescription('WOLT Beograd'))
  })

  it('ignores diacritics, so tekućem and tekucem normalize identically', () => {
    expect(normalizeDescription('IZVOD PO TEKUĆEM RAČUNU')).toBe(normalizeDescription('IZVOD PO TEKUCEM RACUNU'))
  })

  it('collapses repeated whitespace and trims the ends', () => {
    expect(normalizeDescription('  WOLT   BEOGRAD  ')).toBe(normalizeDescription('WOLT BEOGRAD'))
  })

  it('preserves the order of the surviving merchant tokens', () => {
    const result = normalizeDescription('WOLT BEOGRAD 04.07.2026').toUpperCase()
    expect(result.indexOf('WOLT')).toBeLessThan(result.indexOf('BEOGRAD'))
  })

  it('returns an empty string for an empty description', () => {
    expect(normalizeDescription('')).toBe('')
  })

  it('returns an empty string for a whitespace-only description', () => {
    expect(normalizeDescription('   \t  ')).toBe('')
  })

  it('returns an empty string when the description is nothing but volatile tokens', () => {
    expect(normalizeDescription('04.07.2026 POS 4738 ****1234')).toBe('')
  })
})

// ══════════════════════════════ extractCounterparty() ══════════════════════════════

describe('extractCounterparty', () => {
  it('extracts the merchant name from a descriptor that contains one', () => {
    expect(extractCounterparty('WOLT BEOGRAD 04.07.2026 POS 4738')).toMatch(/^WOLT/i)
  })

  it('returns null when the descriptor is empty', () => {
    expect(extractCounterparty('')).toBeNull()
  })

  it('returns null rather than guessing when the descriptor is only a terminal reference', () => {
    expect(extractCounterparty('POS 4738')).toBeNull()
  })

  it('returns null when the descriptor is only digits', () => {
    expect(extractCounterparty('1234567890')).toBeNull()
  })
})

// ═══════════════════════════════════ toTransaction() ═══════════════════════════════

describe('toTransaction', () => {
  it('carries the injected id, dedupe key, book and creation timestamp verbatim', () => {
    const tx = toTransaction(mkRaw(), 'PERSONAL', 'tx-77', 'dk-77', '2026-08-02T12:00:00Z')
    expect(tx).toMatchObject({ id: 'tx-77', dedupeKey: 'dk-77', book: 'PERSONAL', createdAt: '2026-08-02T12:00:00Z' })
  })

  const directions: Array<{ amount: number; direction: 'in' | 'out' }> = [
    { amount: -1890, direction: 'out' },
    { amount: 412000, direction: 'in' },
    { amount: 0, direction: 'in' },
  ]

  it.each(directions)('derives direction $direction from a signed amount of $amount', ({ amount, direction }) => {
    const tx = toTransaction(mkRaw({ amount }), 'PERSONAL', 'tx-1', 'dk-1', '2026-08-02T12:00:00Z')
    expect(tx.direction).toBe(direction)
    expect(tx.amount).toBe(amount)
  })

  it('starts unresolved, with category MISC, no dimensions and no source document', () => {
    const tx = toTransaction(mkRaw(), 'PERSONAL', 'tx-1', 'dk-1', '2026-08-02T12:00:00Z')
    expect(tx.category).toBe('MISC')
    expect(tx.dimensions).toEqual({})
    expect(tx.sourceDocument).toBeNull()
  })

  it('keeps an absent value date absent rather than defaulting it to the transaction date', () => {
    const tx = toTransaction(mkRaw({ valueDate: null }), 'PERSONAL', 'tx-1', 'dk-1', '2026-08-02T12:00:00Z')
    expect(tx.valueDate).toBeNull()
  })

  it('sets amountRsd equal to the amount when the transaction is already in RSD', () => {
    const tx = toTransaction(mkRaw({ currency: 'RSD', amount: -1890 }), 'PERSONAL', 'tx-1', 'dk-1', '2026-08-02T12:00:00Z')
    expect(tx.amountRsd).toBe(-1890)
  })

  it('leaves amountRsd absent for a foreign-currency row rather than copying the foreign amount', () => {
    const tx = toTransaction(mkRaw({ currency: 'EUR', amount: -300 }), 'PERSONAL', 'tx-1', 'dk-1', '2026-08-02T12:00:00Z')
    expect(tx.amountRsd).toBeNull()
  })
})

// ═══════════════════════════════════ validateSplit() ═══════════════════════════════

describe('validateSplit', () => {
  const tx = mkTx({ amount: -1890 })
  const income = mkTx({ id: 'tx-2', amount: 412000, direction: 'in', category: 'PRIHOD' })

  it('accepts parts that sum exactly to the original amount and share its sign', () => {
    const parts: SplitPart[] = [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }]
    expect(validateSplit(tx, parts)).toEqual({ valid: true, difference: 0, errors: [] })
  })

  it('accepts a five-way split that sums exactly', () => {
    const parts: SplitPart[] = [
      { amount: -400, category: 'HRANA' }, { amount: -400, category: 'DECA' },
      { amount: -400, category: 'ZABAVA' }, { amount: -400, category: 'ODECA' },
      { amount: -290, category: 'TEHNIKA' },
    ]
    expect(validateSplit(tx, parts).valid).toBe(true)
  })

  it('accepts thirds that only sum exactly after 2dp rounding', () => {
    const hundred = mkTx({ amount: -100 })
    const parts: SplitPart[] = [
      { amount: -33.33, category: 'HRANA' }, { amount: -33.33, category: 'DECA' }, { amount: -33.34, category: 'ZABAVA' },
    ]
    const result = validateSplit(hundred, parts)
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('accepts a difference smaller than half a cent, because the check is to 2dp', () => {
    const hundred = mkTx({ amount: -100 })
    const parts: SplitPart[] = [{ amount: -66.667, category: 'HRANA' }, { amount: -33.33, category: 'DECA' }]
    expect(validateSplit(hundred, parts).valid).toBe(true)
  })

  it('reports the difference free of floating-point noise', () => {
    const three = mkTx({ amount: -3 })
    const parts: SplitPart[] = [{ amount: -0.1, category: 'HRANA' }, { amount: -0.2, category: 'DECA' }]
    expect(validateSplit(three, parts).difference).toBe(2.7)
  })

  const boundaries: Array<{ label: string; partAmount: number; valid: boolean; difference: number }> = [
    { label: 'two cents under', partAmount: -1187.98, valid: false, difference: 0.02 },
    { label: 'one cent under', partAmount: -1187.99, valid: false, difference: 0.01 },
    { label: 'exact', partAmount: -1188, valid: true, difference: 0 },
    { label: 'one cent over', partAmount: -1188.01, valid: false, difference: -0.01 },
    { label: 'two cents over', partAmount: -1188.02, valid: false, difference: -0.02 },
  ]

  it.each(boundaries)('is $valid when the parts land $label of the original', ({ partAmount, valid, difference }) => {
    const parts: SplitPart[] = [{ amount: partAmount, category: 'HRANA' }, { amount: -702, category: 'DECA' }]
    const result = validateSplit(tx, parts)
    expect(result.valid).toBe(valid)
    expect(result.difference).toBe(difference)
  })

  it('reports the difference as the parts sum minus the original amount', () => {
    const parts: SplitPart[] = [{ amount: -1000, category: 'HRANA' }, { amount: -800, category: 'DECA' }]
    expect(validateSplit(tx, parts).difference).toBe(90)
  })

  it('rejects a split where one part has the opposite sign to the original', () => {
    const parts: SplitPart[] = [{ amount: -2000, category: 'HRANA' }, { amount: 110, category: 'DECA' }]
    const result = validateSplit(tx, parts)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ').toLowerCase()).toMatch(/sign|znak/)
  })

  it('accepts an all-positive split of an incoming transaction', () => {
    const parts: SplitPart[] = [{ amount: 400000, category: 'PRIHOD' }, { amount: 12000, category: 'PRIHOD' }]
    expect(validateSplit(income, parts).valid).toBe(true)
  })

  it('rejects a zero-amount part, which has no sign and no meaning', () => {
    const parts: SplitPart[] = [{ amount: -1890, category: 'HRANA' }, { amount: 0, category: 'DECA' }]
    expect(validateSplit(tx, parts).valid).toBe(false)
  })

  it('rejects an empty parts list and reports the whole amount as the difference', () => {
    const result = validateSplit(tx, [])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(1890)
  })

  it('accepts a single part equal to the whole amount', () => {
    expect(validateSplit(tx, [{ amount: -1890, category: 'HRANA' }]).valid).toBe(true)
  })

  it('rejects a part with an empty category rather than filing it silently', () => {
    const parts: SplitPart[] = [{ amount: -1200, category: '' }, { amount: -690, category: 'DECA' }]
    expect(validateSplit(tx, parts).valid).toBe(false)
  })

  const malformed: Array<{ label: string; amount: number }> = [
    { label: 'NaN', amount: Number.NaN },
    { label: 'Infinity', amount: Number.POSITIVE_INFINITY },
    { label: '-Infinity', amount: Number.NEGATIVE_INFINITY },
  ]

  it.each(malformed)('rejects a part whose amount is $label without throwing', ({ amount }) => {
    const parts: SplitPart[] = [{ amount, category: 'HRANA' }, { amount: -690, category: 'DECA' }]
    let result: ReturnType<typeof validateSplit> | undefined
    expect(() => { result = validateSplit(tx, parts) }).not.toThrow()
    expect(result?.valid).toBe(false)
  })

  it('reports at least one error whenever the split is invalid', () => {
    const parts: SplitPart[] = [{ amount: -1000, category: 'HRANA' }, { amount: -800, category: 'DECA' }]
    const result = validateSplit(tx, parts)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('reports no errors when the split is valid', () => {
    const parts: SplitPart[] = [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }]
    expect(validateSplit(tx, parts).errors).toEqual([])
  })

  it('does not mutate the parts it was given', () => {
    const parts: SplitPart[] = [{ amount: -1200, category: 'HRANA' }, { amount: -690, category: 'DECA' }]
    const snapshot = structuredClone(parts)
    validateSplit(tx, parts)
    expect(parts).toEqual(snapshot)
  })
})

// ═══════════════════════════════════ suggestSplit() ═══════════════════════════════

describe('suggestSplit', () => {
  const tx = mkTx({ amount: -1890 })

  it('proposes one part per category when the line items disagree', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: 1200, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    const parts = suggestSplit(tx, items)
    expect(parts).not.toBeNull()
    expect(parts).toHaveLength(2)
    expect((parts ?? []).map((p) => p.category).sort()).toEqual(['DECA', 'HRANA'])
  })

  it('gives the proposed parts the same sign as the transaction they split', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: 1200, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    expect((suggestSplit(tx, items) ?? []).every((p) => p.amount < 0)).toBe(true)
  })

  it('proposes a split that validates against the original transaction', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: 1200, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    const parts = suggestSplit(tx, items) ?? []
    expect(validateSplit(tx, parts).valid).toBe(true)
  })

  it('merges several line items that share a category into one part', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: 800, category: 'DECA' },
      { description: 'KREMA', lineTotal: 400, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    const parts = suggestSplit(tx, items) ?? []
    expect(parts).toHaveLength(2)
    expect(parts.find((p) => p.category === 'DECA')?.amount).toBe(-1200)
  })

  it('returns null when every line item agrees on one category, because there is nothing to split', () => {
    const items = [
      { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      { description: 'HLEB', lineTotal: 690, category: 'HRANA' },
    ]
    expect(suggestSplit(tx, items)).toBeNull()
  })

  it('returns null when there are no line items at all', () => {
    expect(suggestSplit(tx, [])).toBeNull()
  })

  it('returns null rather than guessing when a line item has no amount', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: null, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    expect(suggestSplit(tx, items)).toBeNull()
  })

  it('returns null rather than guessing when a line item has no category', () => {
    const items = [
      { description: 'NEPOZNATO', lineTotal: 1200, category: null },
      { description: 'MLEKO', lineTotal: 690, category: 'HRANA' },
    ]
    expect(suggestSplit(tx, items)).toBeNull()
  })

  it('returns null when the line items do not add up to the transaction amount', () => {
    const items = [
      { description: 'PAMPERS', lineTotal: 1200, category: 'DECA' },
      { description: 'MLEKO', lineTotal: 500, category: 'HRANA' },
    ]
    expect(suggestSplit(tx, items)).toBeNull()
  })
})
