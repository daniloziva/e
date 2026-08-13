/**
 * E — ledger core: event folding, dedupe identity, splits.
 *
 * Merged from three independent drafts (engineers 1-3).
 * Spec: 01-ARCHITECTURE.md §3, 04-PERSONAL.md §2 Dedupe / §3 Splits, 09-TEBRA.md §4.
 *
 * Written BEFORE the implementation exists: every case fails with
 * "not implemented" until the stubs are filled in. That is correct RED.
 *
 * ── MERGE RULING: what `invert(event, current, ...)` receives ────────────────
 * All three drafts disagreed, and only one reading is coherent.
 *
 *   `current` is the state as it stood BEFORE the event was applied.
 *
 * That is the only state from which a prior value is recoverable: if `current`
 * were the post-state, inverting `set_category MISC -> HRANA` could not know
 * MISC. e1 and e2 use pre-state throughout. e3 used pre-state for its set_*
 * unit tests but post-state in its round-trip helper and for add/delete — an
 * internal contradiction, so its add/delete conclusions do not survive.
 *
 * Consequences, all asserted below:
 *   - invert(add)    -> a delete; needs only the event's own tx.id, so an empty
 *                       `current` is normal and must NOT return null.
 *   - invert(delete) -> an add carrying the whole transaction back; the tx IS
 *                       present in the pre-state, so this IS invertible.
 *   - invert(split)  -> null. No single event un-splits a transaction.
 *
 * The round-trip property is the real contract:
 *     fold([...base, event, invert(event, fold(base), ...)]) === fold(base)
 */

import { describe, it, expect } from 'vitest'
import { fold, invert, type LedgerEvent } from '../../src/core/ledger/fold.js'
import {
  dedupeKey,
  normalizeDescription,
  extractCounterparty,
  toTransaction,
  type RawTransaction,
} from '../../src/core/ledger/normalize.js'
import { validateSplit, suggestSplit, type SplitPart } from '../../src/core/ledger/split.js'
import type { Transaction, BookCode } from '../../src/core/types.js'

// ─────────────────────────── hand-written fakes ───────────────────────────
// No mocking library. Injected dependencies are plain functions with fixed,
// inspectable behaviour.

/** Identity "hash" — makes the material that went into a key observable. */
const identityHash = (s: string): string => s

/** Constant digest — proves the key is the hash's output, not a concatenation. */
const constantHash = (): string => 'FIXED-DIGEST'

/** Records everything handed to the hash. */
function recordingHash(): { calls: string[]; fn: (s: string) => string } {
  const calls: string[] = []
  return {
    calls,
    fn: (s: string) => {
      calls.push(s)
      return `H(${s})`
    },
  }
}

// ─────────────────────────── builders ───────────────────────────

function makeTx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    book: 'PERSONAL',
    txDate: '2026-07-04',
    valueDate: '2026-07-04',
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
    createdAt: '2026-08-01T09:00:00Z',
    ...over,
  }
}

function makeRaw(over: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txDate: '2026-07-04',
    valueDate: '2026-07-04',
    description: 'POS 4738 WOLT BEOGRAD',
    amount: -1890,
    currency: 'RSD',
    balanceAfter: 122430.55,
    ...over,
  }
}

const evAdd = (id: string, at: string, tx: Transaction): LedgerEvent => ({ op: 'add', id, at, tx })
const evCat = (id: string, at: string, ref: string, category: string): LedgerEvent => ({
  op: 'set_category',
  id,
  at,
  ref,
  category,
})
const evDim = (
  id: string,
  at: string,
  ref: string,
  axis: string,
  value: string | null,
): LedgerEvent => ({ op: 'set_dimension', id, at, ref, axis, value })
const evAmt = (id: string, at: string, ref: string, amount: number): LedgerEvent => ({
  op: 'set_amount',
  id,
  at,
  ref,
  amount,
})
const evSplit = (
  id: string,
  at: string,
  ref: string,
  parts: Array<{ amount: number; category: string }>,
): LedgerEvent => ({ op: 'split', id, at, ref, parts })
const evDel = (id: string, at: string, ref: string): LedgerEvent => ({ op: 'delete', id, at, ref })

/** Lookup that fails loudly rather than returning undefined. */
function one(list: Transaction[], id: string): Transaction {
  const found = list.find((t) => t.id === id)
  if (!found) throw new Error(`fold() output has no transaction ${id}`)
  return found
}

const byId = (txs: Transaction[], id: string): Transaction | undefined => txs.find((t) => t.id === id)

/** Deterministic Fisher-Yates, so a "shuffled" log is reproducible, never flaky. */
function permute<T>(xs: readonly T[], seed: number): T[] {
  const out = xs.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

const rotate = <T,>(xs: T[], by: number): T[] => xs.map((_, i) => xs[(i + by) % xs.length] as T)
const sum2 = (ns: number[]): number => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100

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
  evAdd('E01', '2026-07-05T08:00:00Z', T1),
  evAdd('E02', '2026-07-05T08:00:01Z', T2),
  evAdd('E03', '2026-07-05T08:00:02Z', T3),
  evCat('E04', '2026-07-06T09:00:00Z', 'T1', 'HRANA'),
  evDim('E05', '2026-07-07T09:00:00Z', 'T2', 'project', 'HOME'),
  evAmt('E06', '2026-07-08T09:00:00Z', 'T2', -4600),
  evCat('E07', '2026-07-09T09:00:00Z', 'T1', 'ZABAVA'),
  evDel('E08', '2026-07-10T09:00:00Z', 'T3'),
  evCat('E09', '2026-07-11T09:00:00Z', 'GHOST', 'DECA'),
]

// ═════════════════════════════════ fold() ═════════════════════════════════

describe('fold', () => {
  it('returns an empty array for an empty event log', () => {
    expect(fold([])).toEqual([])
  })

  it('materialises a transaction from a single add event, exactly as carried', () => {
    const tx = makeTx({ id: 'tx-a' })
    expect(fold([evAdd('e1', '2026-08-05T06:00:00Z', tx)])).toEqual([tx])
  })

  it('does not mutate the events it is given', () => {
    const events = BASE_LOG.map((e) => structuredClone(e))
    const snapshot = structuredClone(events)
    fold(events)
    expect(events).toEqual(snapshot)
  })

  // ── ordering and determinism ──────────────────────────────────────────────

  it('returns transactions in chronological order of their add events', () => {
    const out = fold([
      evAdd('e2', '2026-08-05T06:00:01Z', makeTx({ id: 'tx-b' })),
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evAdd('e3', '2026-08-05T06:00:02Z', makeTx({ id: 'tx-c' })),
    ])
    expect(out.map((t) => t.id)).toEqual(['tx-a', 'tx-b', 'tx-c'])
  })

  it('orders by `at`, so a correction that arrives last but happened first does not win', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evCat('E03', '2026-07-08T09:00:00Z', 'T1', 'ZABAVA'),
      evCat('E02', '2026-07-06T09:00:00Z', 'T1', 'HRANA'),
    ])
    expect(one(out, 'T1').category).toBe('ZABAVA')
  })

  it('breaks a tie on identical timestamps with the higher event id, whatever the array order', () => {
    const at = '2026-07-06T09:00:00Z'
    const lower = evCat('E-AAA', at, 'T1', 'HRANA')
    const higher = evCat('E-BBB', at, 'T1', 'DECA')
    const add = evAdd('E01', '2026-07-05T08:00:00Z', T1)
    expect(one(fold([add, lower, higher]), 'T1').category).toBe('DECA')
    expect(one(fold([add, higher, lower]), 'T1').category).toBe('DECA')
  })

  it.each([7, 42, 1337])(
    'folds a shuffled copy (seed %i) identically to the sorted log',
    (seed) => {
      const shuffled = permute(BASE_LOG, seed)
      expect(shuffled).not.toEqual(BASE_LOG)
      expect(fold(shuffled)).toEqual(fold(BASE_LOG))
    },
  )

  it('folds the exactly-reversed log identically to the sorted one', () => {
    expect(fold([...BASE_LOG].reverse())).toEqual(fold(BASE_LOG))
  })

  it.each([1, 3, 5])('folds a log rotated by %i identically to the sorted one', (by) => {
    expect(fold(rotate([...BASE_LOG], by))).toEqual(fold(BASE_LOG))
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

  // ── corrections ───────────────────────────────────────────────────────────

  it('lets a later set_category correction win over the original category', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ category: 'MISC' })),
      evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'),
    ])
    expect(one(out, 'tx-1').category).toBe('HRANA')
  })

  it('leaves every other field untouched when applying a set_category', () => {
    const original = makeTx({ category: 'MISC' })
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', original),
      evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'),
    ])
    expect(one(out, 'tx-1')).toEqual({ ...original, category: 'HRANA' })
  })

  it('applies the last of several corrections to the same field', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evCat('E02', '2026-07-06T09:00:00Z', 'T1', 'HRANA'),
      evCat('E03', '2026-07-07T09:00:00Z', 'T1', 'DECA'),
      evCat('E04', '2026-07-08T09:00:00Z', 'T1', 'ZABAVA'),
    ])
    expect(one(out, 'T1').category).toBe('ZABAVA')
  })

  it('leaves unrelated transactions untouched when one is corrected', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evAdd('E02', '2026-07-05T08:00:01Z', T2),
      evCat('E03', '2026-07-06T09:00:00Z', 'T1', 'HRANA'),
    ])
    expect(one(out, 'T2')).toEqual(T2)
  })

  it('ignores a repeated identical event rather than applying it twice', () => {
    const base: LedgerEvent[] = [
      evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' })),
      evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA'),
    ]
    expect(fold([...base, evCat('e2', '2026-08-06T09:00:00Z', 'tx-a', 'HRANA')])).toEqual(fold(base))
  })

  it('ignores the `by` attribution field when computing state', () => {
    const withBy = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      { op: 'set_category', id: 'E02', at: '2026-07-06T09:00:00Z', ref: 'T1', category: 'HRANA', by: 'tebra' },
    ])
    const withoutBy = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evCat('E02', '2026-07-06T09:00:00Z', 'T1', 'HRANA'),
    ])
    expect(withBy).toEqual(withoutBy)
  })

  it('applies a corrected amount to the referenced transaction', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evAmt('E02', '2026-07-06T09:00:00Z', 'T1', -1350.5),
    ])
    expect(one(out, 'T1').amount).toBe(-1350.5)
  })

  it('flips direction when a corrected amount changes sign', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evAmt('E02', '2026-07-06T09:00:00Z', 'T1', 1200),
    ])
    expect(one(out, 'T1').direction).toBe('in')
  })

  // ── dimensions ────────────────────────────────────────────────────────────

  it('sets a dimension value on the referenced transaction', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ dimensions: {} })),
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'HOME'),
    ])
    expect(one(out, 'tx-1').dimensions['project']).toBe('HOME')
  })

  // MERGE NOTE — 2-of-3 chose the permissive form (either drop the key or set it
  // to null). e3 alone required the key be retained holding null. `DimensionValues`
  // is Record<string, string | null>, which permits both. Recorded as a spec gap.
  it('clears an axis when set_dimension carries a null value', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ dimensions: { project: 'HOME' } })),
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', null),
    ])
    expect(one(out, 'tx-1').dimensions['project'] ?? null).toBeNull()
  })

  it('leaves other axes untouched when one axis is set', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ dimensions: { project: 'HOME', client: 'ACME' } })),
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'GARAGE'),
    ])
    expect(one(out, 'tx-1').dimensions).toEqual({ project: 'GARAGE', client: 'ACME' })
  })

  // ── deletes ───────────────────────────────────────────────────────────────

  it('drops a deleted transaction from the folded state', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', T1),
      evAdd('E02', '2026-07-05T08:00:01Z', T2),
      evDel('E03', '2026-07-06T09:00:00Z', 'T1'),
    ])
    expect(out.map((t) => t.id)).toEqual(['T2'])
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

  // ── re-adds and out-of-window corrections ─────────────────────────────────

  it('lets a later add for the same id replace the earlier one', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ amount: -1890 })),
      evAdd('E02', '2026-07-06T08:00:00Z', makeTx({ amount: -1990 })),
    ])
    expect(out).toHaveLength(1)
    expect(one(out, 'tx-1').amount).toBe(-1990)
  })

  it('ignores a correction whose `at` sorts before the add that creates its transaction', () => {
    const out = fold([
      evCat('E00', '2026-07-01T09:00:00Z', 'tx-1', 'HRANA'),
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ category: 'MISC' })),
    ])
    expect(one(out, 'tx-1').category).toBe('MISC')
  })

  // ── unknown references: ignored, never fatal ──────────────────────────────

  it.each<[string, LedgerEvent]>([
    ['set_category', evCat('x1', '2026-07-20T09:00:00Z', 'GHOST', 'HRANA')],
    ['set_amount', evAmt('x2', '2026-07-20T09:00:00Z', 'GHOST', -99)],
    ['set_dimension', evDim('x3', '2026-07-20T09:00:00Z', 'GHOST', 'project', 'X')],
    ['delete', evDel('x4', '2026-07-20T09:00:00Z', 'GHOST')],
    [
      'split',
      evSplit('x5', '2026-07-20T09:00:00Z', 'GHOST', [
        { amount: -600, category: 'HRANA' },
        { amount: -600, category: 'DECA' },
      ]),
    ],
  ])('ignores a %s event referencing an unknown transaction instead of throwing', (_op, event) => {
    const base = evAdd('E01', '2026-07-05T08:00:00Z', T1)
    expect(() => fold([base, event])).not.toThrow()
    expect(fold([base, event])).toEqual(fold([base]))
  })

  it('returns an empty array for a log made entirely of unknown references', () => {
    expect(
      fold([
        evCat('x1', '2026-07-20T09:00:00Z', 'GHOST', 'HRANA'),
        evDel('x2', '2026-07-21T09:00:00Z', 'GHOST2'),
      ]),
    ).toEqual([])
  })

  it('keeps applying valid events after an unknown-reference event in the middle of the log', () => {
    const out = fold([
      evAdd('e1', '2026-08-01T09:00:00Z', makeTx()),
      evCat('e2', '2026-08-01T10:00:00Z', 'ghost', 'ZABAVA'),
      evCat('e3', '2026-08-01T11:00:00Z', 'tx-1', 'HRANA'),
    ])
    expect(one(out, 'tx-1').category).toBe('HRANA')
  })

  // ── books are not filtered here ───────────────────────────────────────────

  it('folds transactions from different books together without scoping them', () => {
    const out = fold([
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ id: 'P1', book: 'PERSONAL' })),
      evAdd('E02', '2026-07-05T08:00:01Z', makeTx({ id: 'D1', book: 'DILIGAF' })),
    ])
    expect(out.map((t) => t.book).sort()).toEqual(['DILIGAF', 'PERSONAL'])
  })

  // ── splits ────────────────────────────────────────────────────────────────

  describe('split events', () => {
    const splitLog: LedgerEvent[] = [
      evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ amount: -1200, amountRsd: -1200 })),
      evSplit('E02', '2026-07-06T09:00:00Z', 'tx-1', [
        { amount: -700, category: 'HRANA' },
        { amount: -500, category: 'DECA' },
      ]),
    ]

    it('replaces the original transaction with its parts', () => {
      const out = fold(splitLog)
      expect(out).toHaveLength(2)
      expect(out.some((t) => t.amount === -1200)).toBe(false)
      expect(out.map((t) => t.category).sort()).toEqual(['DECA', 'HRANA'])
    })

    it('produces parts whose amounts sum to the original amount', () => {
      expect(sum2(fold(splitLog).map((t) => t.amount))).toBe(-1200)
    })

    it('conserves the ledger total across a split', () => {
      const before: LedgerEvent[] = [
        evAdd('e1', '2026-08-01T09:00:00Z', makeTx({ id: 'tx-1', amount: -1890 })),
        evAdd('e2', '2026-08-01T09:01:00Z', makeTx({ id: 'tx-2', amount: -540 })),
      ]
      const after: LedgerEvent[] = [
        ...before,
        evSplit('e3', '2026-08-01T10:00:00Z', 'tx-1', [
          { amount: -1200, category: 'HRANA' },
          { amount: -690, category: 'DECA' },
        ]),
      ]
      const total = (txs: Transaction[]): number => sum2(txs.map((t) => t.amount))
      expect(total(fold(after))).toBe(total(fold(before)))
    })

    it('carries the original book, date, currency, description and direction onto every part', () => {
      for (const part of fold(splitLog)) {
        expect(part.book).toBe('PERSONAL')
        expect(part.txDate).toBe('2026-07-04')
        expect(part.currency).toBe('RSD')
        expect(part.description).toBe('WOLT BEOGRAD')
        expect(part.direction).toBe('out')
      }
    })

    it('gives every part a distinct non-empty id, stable across repeated folds', () => {
      const first = fold(splitLog).map((t) => t.id)
      const second = fold([...splitLog].reverse()).map((t) => t.id)
      expect(first.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
      expect(new Set(first).size).toBe(first.length)
      expect([...first].sort()).toEqual([...second].sort())
    })

    it('folds a split identically whatever order the events arrive in', () => {
      expect(fold([...splitLog].reverse())).toEqual(fold(splitLog))
      expect(fold(rotate([...splitLog], 1))).toEqual(fold(splitLog))
    })

    it('preserves the total when a correction arrives for the already-split original', () => {
      const out = fold([...splitLog, evCat('E03', '2026-07-07T09:00:00Z', 'tx-1', 'ZABAVA')])
      expect(sum2(out.map((t) => t.amount))).toBe(-1200)
    })

    it('ignores a split whose parts do not sum to the original amount, rather than losing money', () => {
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
  })

  // ── malformed input must not fail the whole fold ──────────────────────────

  it.each<[string, unknown]>([
    ['an unknown op', { op: 'teleport', id: 'e2', at: '2026-08-06T09:00:00Z', ref: 'tx-a' }],
    ['a missing ref', { op: 'set_category', id: 'e2', at: '2026-08-06T09:00:00Z', category: 'HRANA' }],
    ['a null payload', { op: 'add', id: 'e2', at: '2026-08-06T09:00:00Z', tx: null }],
    ['no timestamp', { op: 'set_category', id: 'e2', ref: 'tx-a', category: 'HRANA' }],
    ['an absent event object', null],
    ['an undefined event object', undefined],
  ])('ignores a malformed event with %s instead of failing the whole fold', (_label, bad) => {
    const base = evAdd('e1', '2026-08-05T06:00:00Z', makeTx({ id: 'tx-a' }))
    const events = [base, bad as LedgerEvent]
    expect(() => fold(events)).not.toThrow()
    expect(fold(events)).toEqual(fold([base]))
  })
})

// ═════════════════════════════════ invert() ═════════════════════════════════
// `current` is the state BEFORE the event was applied — see the merge ruling
// at the top of this file.

describe('invert', () => {
  const INV_ID = 'E-UNDO'
  const INV_AT = '2026-09-01T00:00:00Z'

  const addOnly: LedgerEvent[] = [
    evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ category: 'MISC' })),
  ]

  /** The property that matters: event + inverse folds back to the prior state. */
  function expectRoundTrip(base: LedgerEvent[], event: LedgerEvent): void {
    const before = fold(base)
    const inverse = invert(event, before, INV_ID, INV_AT)
    expect(inverse).not.toBeNull()
    expect(fold([...base, event, inverse as LedgerEvent])).toEqual(before)
  }

  // ── the inverse event itself ──────────────────────────────────────────────

  it('inverts a category correction back to the category held before it', () => {
    const inverse = invert(
      evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'),
      fold(addOnly),
      INV_ID,
      INV_AT,
    )
    expect(inverse).toMatchObject({ op: 'set_category', ref: 'tx-1', category: 'MISC' })
  })

  it('inverts an amount correction back to the previous amount', () => {
    const before = [makeTx({ amount: -1890 })]
    const inverse = invert(evAmt('E02', '2026-07-06T09:00:00Z', 'tx-1', -1990), before, INV_ID, INV_AT)
    expect(inverse).toMatchObject({ op: 'set_amount', ref: 'tx-1', amount: -1890 })
  })

  it('inverts a dimension change back to the previous value on that axis', () => {
    const before = [makeTx({ dimensions: { project: 'HOME' } })]
    const inverse = invert(
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'GARAGE'),
      before,
      INV_ID,
      INV_AT,
    )
    expect(inverse).toMatchObject({ op: 'set_dimension', axis: 'project', value: 'HOME' })
  })

  it('inverts setting a previously absent dimension into clearing it', () => {
    const before = [makeTx({ dimensions: {} })]
    const inverse = invert(
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'HOME'),
      before,
      INV_ID,
      INV_AT,
    )
    expect(inverse).toMatchObject({ op: 'set_dimension', axis: 'project', value: null })
  })

  it('inverts an add into a delete of the transaction it created', () => {
    // MERGE NOTE — under pre-state semantics the transaction is NOT yet present,
    // so an empty `current` is the normal case. e3 required null here; that
    // followed from its post-state reading, which the ruling rejects.
    const inverse = invert(evAdd('E01', '2026-07-05T08:00:00Z', T1), [], INV_ID, INV_AT)
    expect(inverse).toMatchObject({ op: 'delete', id: INV_ID, at: INV_AT, ref: 'T1' })
  })

  it('inverts a delete into an add carrying the whole transaction back', () => {
    // MERGE NOTE — 2-of-3. The pre-state DOES contain the transaction, so a
    // delete is invertible; e3's "no longer available" reasoning came from its
    // post-state reading.
    const tx = makeTx({ category: 'HRANA' })
    const inverse = invert(evDel('E02', '2026-07-06T09:00:00Z', 'tx-1'), [tx], INV_ID, INV_AT)
    expect(inverse).toMatchObject({ op: 'add', id: INV_ID, at: INV_AT, tx })
  })

  it('stamps the inverse with the injected id and timestamp rather than reusing the original', () => {
    const inverse = invert(
      evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'),
      fold(addOnly),
      'chosen-id',
      '2030-01-01T00:00:00Z',
    )
    expect(inverse).toMatchObject({ id: 'chosen-id', at: '2030-01-01T00:00:00Z' })
  })

  it('returns an event restoring the same value when the correction changed nothing', () => {
    const before = [makeTx({ category: 'HRANA' })]
    const inverse = invert(evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'), before, INV_ID, INV_AT)
    expect(inverse).toMatchObject({ op: 'set_category', ref: 'tx-1', category: 'HRANA' })
  })

  // ── the round-trip property ───────────────────────────────────────────────

  it('restores the prior category exactly when the inverse is folded in', () => {
    expectRoundTrip(addOnly, evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'))
  })

  it('restores the prior amount and direction exactly', () => {
    expectRoundTrip(addOnly, evAmt('E02', '2026-07-06T09:00:00Z', 'tx-1', 4321))
  })

  it('restores a dimension that previously held another value', () => {
    expectRoundTrip(
      [evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ dimensions: { project: 'HOME' } }))],
      evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'GARAGE'),
    )
  })

  it('restores a dimension that was previously absent, rather than leaving the new value', () => {
    expectRoundTrip(addOnly, evDim('E02', '2026-07-06T09:00:00Z', 'tx-1', 'project', 'HOME'))
  })

  it('undoes an add by removing the transaction it created', () => {
    expectRoundTrip([], evAdd('E01', '2026-07-05T08:00:00Z', T1))
  })

  it('undoes a delete by restoring the transaction exactly as it stood, corrections included', () => {
    expectRoundTrip(
      [
        evAdd('E01', '2026-07-05T08:00:00Z', makeTx({ category: 'MISC' })),
        evAdd('E02', '2026-07-05T08:00:01Z', T2),
        evCat('E03', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'),
      ],
      evDel('E04', '2026-07-07T09:00:00Z', 'tx-1'),
    )
  })

  it('inverting the inverse reapplies the original change', () => {
    const event = evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA')
    const before = fold(addOnly)
    const undo = invert(event, before, INV_ID, INV_AT) as LedgerEvent
    const afterUndo = fold([...addOnly, event, undo])
    const redo = invert(undo, afterUndo, 'E-REDO', '2026-09-02T00:00:00Z') as LedgerEvent
    expect(one(fold([...addOnly, event, undo, redo]), 'tx-1').category).toBe('HRANA')
  })

  // ── refusals ──────────────────────────────────────────────────────────────

  it('returns null for a split, because no single event can un-split a transaction', () => {
    const event = evSplit('E02', '2026-07-06T09:00:00Z', 'tx-1', [
      { amount: -700, category: 'HRANA' },
      { amount: -500, category: 'DECA' },
    ])
    expect(invert(event, fold(addOnly), INV_ID, INV_AT)).toBeNull()
  })

  it.each<[string, LedgerEvent]>([
    ['set_category', evCat('X1', '2026-07-20T09:00:00Z', 'GHOST', 'HRANA')],
    ['set_amount', evAmt('X2', '2026-07-20T09:00:00Z', 'GHOST', -99)],
    ['set_dimension', evDim('X3', '2026-07-20T09:00:00Z', 'GHOST', 'project', 'X')],
    ['delete', evDel('X4', '2026-07-20T09:00:00Z', 'GHOST')],
  ])('returns null for a %s whose target is not in the current state', (_op, event) => {
    expect(invert(event, fold(addOnly), INV_ID, INV_AT)).toBeNull()
  })

  it('returns null for a correction when the current state is empty', () => {
    expect(invert(evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA'), [], INV_ID, INV_AT)).toBeNull()
  })

  it.each<[string, unknown]>([
    ['an unknown op', { op: 'teleport', id: 'e2', at: '2026-08-06T09:00:00Z', ref: 'tx-1' }],
    ['an absent event', null],
    ['an add with no transaction', { op: 'add', id: 'e2', at: '2026-08-06T09:00:00Z', tx: null }],
  ])('returns null for a malformed event: %s', (_label, bad) => {
    expect(invert(bad as LedgerEvent, [makeTx()], INV_ID, INV_AT)).toBeNull()
  })

  it('does not mutate the event or the state it is given', () => {
    const event = evCat('E02', '2026-07-06T09:00:00Z', 'tx-1', 'HRANA')
    const eventSnapshot = structuredClone(event)
    const state = fold(addOnly)
    const stateSnapshot = structuredClone(state)
    invert(event, state, INV_ID, INV_AT)
    expect(event).toEqual(eventSnapshot)
    expect(state).toEqual(stateSnapshot)
  })
})

// ═════════════════════════════════ dedupeKey() ═════════════════════════════════
// 04-PERSONAL §2: sha256(book | txDate | amount | normalize(description)
//                        | valueDate | balanceAfter)

describe('dedupeKey', () => {
  it('returns the injected hash function output rather than the raw material', () => {
    expect(dedupeKey('PERSONAL', makeRaw(), constantHash)).toBe('FIXED-DIGEST')
    expect(dedupeKey('SMOQUA', makeRaw({ amount: -9 }), constantHash)).toBe('FIXED-DIGEST')
  })

  it('hashes exactly once per call', () => {
    const rec = recordingHash()
    dedupeKey('PERSONAL', makeRaw(), rec.fn)
    expect(rec.calls).toHaveLength(1)
  })

  it('feeds the book, both dates, the amount and the balance into the hashed identity', () => {
    const rec = recordingHash()
    dedupeKey('PERSONAL', makeRaw(), rec.fn)
    const hashed = rec.calls[0] ?? ''
    expect(hashed).toContain('PERSONAL')
    expect(hashed).toContain('2026-07-04')
    expect(hashed).toContain('1890')
    expect(hashed).toContain('122430.55')
  })

  it('feeds the normalized description, not the raw one, into the hashed identity', () => {
    const rec = recordingHash()
    const raw = makeRaw({ description: 'POS 4738 WOLT BEOGRAD' })
    dedupeKey('PERSONAL', raw, rec.fn)
    const hashed = rec.calls[0] ?? ''
    expect(hashed).toContain(normalizeDescription(raw.description))
    expect(hashed).not.toContain('4738')
  })

  it('is stable across repeated calls for the same input', () => {
    expect(dedupeKey('PERSONAL', makeRaw(), identityHash)).toBe(
      dedupeKey('PERSONAL', makeRaw(), identityHash),
    )
  })

  it.each<[string, Partial<RawTransaction>]>([
    ['txDate', { txDate: '2026-07-05' }],
    ['valueDate', { valueDate: '2026-07-06' }],
    ['amount', { amount: -1891 }],
    ['amount sign', { amount: 1890 }],
    ['currency', { currency: 'EUR' }],
    ['balanceAfter', { balanceAfter: 122430.56 }],
    ['merchant in the description', { description: 'POS 4738 MAXI BEOGRAD' }],
  ])('produces a different key when the %s differs', (_field, over) => {
    expect(dedupeKey('PERSONAL', makeRaw(over), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw(), identityHash),
    )
  })

  it.each<BookCode>(['DILIGAF', 'SMOQUA'])('produces a different key for book %s', (book) => {
    expect(dedupeKey(book, makeRaw(), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw(), identityHash),
    )
  })

  it('keeps two genuinely identical same-day charges apart via balanceAfter', () => {
    // Two identical coffees, same day, same amount, same descriptor. The running
    // balance is the only thing that differs — and it must be enough.
    const first = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: 12000 })
    const second = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: 11710 })
    expect(dedupeKey('PERSONAL', first, identityHash)).not.toBe(
      dedupeKey('PERSONAL', second, identityHash),
    )
  })

  it('collapses a re-sent statement line that is identical in every field', () => {
    const line = makeRaw()
    expect(dedupeKey('PERSONAL', { ...line }, identityHash)).toBe(
      dedupeKey('PERSONAL', { ...line }, identityHash),
    )
  })

  it('collapses two identical same-day charges when the bank reports no running balance', () => {
    // The accepted limitation: with balanceAfter null nothing is left to tell the
    // two rows apart, and a re-sent statement must still dedupe.
    const a = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: null })
    const b = makeRaw({ description: 'POS 1122 KAFETERIJA', amount: -290, balanceAfter: null })
    expect(dedupeKey('PERSONAL', a, identityHash)).toBe(dedupeKey('PERSONAL', b, identityHash))
  })

  it('treats an absent balance as different from a zero balance', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ balanceAfter: null }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ balanceAfter: 0 }), identityHash),
    )
  })

  it('treats an absent value date as different from one equal to the transaction date', () => {
    expect(dedupeKey('PERSONAL', makeRaw({ valueDate: null }), identityHash)).not.toBe(
      dedupeKey('PERSONAL', makeRaw({ valueDate: '2026-07-04' }), identityHash),
    )
  })

  it('does not confuse the transaction date with the value date when they are swapped', () => {
    const a = dedupeKey('PERSONAL', makeRaw({ txDate: '2026-07-04', valueDate: '2026-07-05' }), identityHash)
    const b = dedupeKey('PERSONAL', makeRaw({ txDate: '2026-07-05', valueDate: '2026-07-04' }), identityHash)
    expect(a).not.toBe(b)
  })

  it('gives the same key when only volatile description tokens differ', () => {
    // A re-sent statement can carry a different terminal id for the same charge.
    const first = makeRaw({ description: 'POS 4738 WOLT BEOGRAD REF:000123456789' })
    const resent = makeRaw({ description: 'POS 5912 WOLT BEOGRAD REF:000987654321' })
    expect(dedupeKey('PERSONAL', first, identityHash)).toBe(
      dedupeKey('PERSONAL', resent, identityHash),
    )
  })

  it('still produces a key when the description is empty', () => {
    const key = dedupeKey('PERSONAL', makeRaw({ description: '' }), identityHash)
    expect(typeof key).toBe('string')
    expect(() => dedupeKey('PERSONAL', makeRaw({ description: '' }), identityHash)).not.toThrow()
  })

  it('produces a key without throwing when both optional fields are absent', () => {
    expect(() =>
      dedupeKey('PERSONAL', makeRaw({ valueDate: null, balanceAfter: null }), identityHash),
    ).not.toThrow()
  })
})

// ═══════════════════════════ normalizeDescription() ═══════════════════════════

describe('normalizeDescription', () => {
  it.each<[string, string, string]>([
    ['a dotted date', 'KUPOVINA 11.08.2026 WOLT BEOGRAD', '11.08.2026'],
    ['an ISO date', 'PLACANJE 2026-08-11 WOLT BEOGRAD', '2026-08-11'],
    ['a slashed short date', 'WOLT BEOGRAD 04/07/26', '04/07/26'],
    ['a time stamp', 'PLACANJE 2026-08-11 09:14 WOLT BEOGRAD', '09:14'],
    ['a POS terminal id', 'POS 4738 WOLT BEOGRAD', '4738'],
    ['a TERM terminal id', 'WOLT BEOGRAD TERM 00123', '00123'],
    ['a reference number', 'WOLT BEOGRAD REF:000123456789', '000123456789'],
    ['a masked card suffix', 'WOLT BEOGRAD **** 1234', '1234'],
    ['an x-masked card suffix', 'WOLT BEOGRAD XXXX-5678', '5678'],
  ])('strips %s while keeping the merchant name', (_label, input, stripped) => {
    const out = normalizeDescription(input)
    expect(out).not.toContain(stripped)
    expect(out.toUpperCase()).toContain('WOLT')
  })

  it.each<[string, string, string]>([
    ['a terminal id', 'POS 4738 WOLT BEOGRAD', 'POS 5912 WOLT BEOGRAD'],
    ['a reference number', 'WOLT BEOGRAD REF:000123456789', 'WOLT BEOGRAD REF:000987654321'],
    ['a date', 'KUPOVINA 11.08.2026 WOLT BEOGRAD', 'KUPOVINA 12.08.2026 WOLT BEOGRAD'],
    ['a card suffix', 'WOLT BEOGRAD ****1234', 'WOLT BEOGRAD ****9876'],
    ['leading and trailing whitespace', '  WOLT   BEOGRAD ', 'WOLT BEOGRAD'],
    ['letter case', 'wolt beograd', 'WOLT BEOGRAD'],
    ['tabs and newlines', 'WOLT\tBEOGRAD\n', 'WOLT BEOGRAD'],
  ])('normalizes two descriptors differing only by %s to the same value', (_label, a, b) => {
    expect(normalizeDescription(a)).toBe(normalizeDescription(b))
  })

  it('folds Serbian diacritics, so tekućem and tekucem normalize identically', () => {
    expect(normalizeDescription('IZVOD PO TEKUĆEM RAČUNU')).toBe(
      normalizeDescription('IZVOD PO TEKUCEM RACUNU'),
    )
    expect(normalizeDescription('TRŽNI CENTAR UŠĆE')).toBe(normalizeDescription('TRZNI CENTAR USCE'))
  })

  it('normalizes the same recurring charge on two different dates to one identical string', () => {
    expect(normalizeDescription('WOLT BEOGRAD 04.07.2026 POS 4738')).toBe(
      normalizeDescription('WOLT BEOGRAD 11.08.2026 POS 9911'),
    )
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

  it.each<[string, string]>([
    ['an empty string', ''],
    ['whitespace only', '   \t \n '],
  ])('returns an empty string for %s', (_label, input) => {
    expect(normalizeDescription(input)).toBe('')
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
  ])('returns an empty string when the description is %s', (_label, input) => {
    expect(normalizeDescription(input as string)).toBe('')
  })

  it('returns an empty string when the description is nothing but volatile tokens', () => {
    expect(normalizeDescription('POS 4738 11.08.2026 ****1234')).toBe('')
  })

  it('keeps two genuinely different merchants distinguishable', () => {
    expect(normalizeDescription('POS 4738 WOLT BEOGRAD')).not.toBe(
      normalizeDescription('POS 4738 MAXI BEOGRAD'),
    )
  })

  // This and the POS-stripping cases together pin the rule: digits are stripped
  // when they follow a marker (POS / TERM / REF / **** / XXXX) or form a date or
  // time, and survive otherwise. A branch number is part of the merchant name.
  it('keeps a merchant whose name contains digits distinguishable from another branch', () => {
    expect(normalizeDescription('MAXI 011')).not.toBe(normalizeDescription('MAXI 022'))
  })

  it('handles a very long descriptor without truncating the merchant token away', () => {
    const long = `NAKNADA ZA ${'X'.repeat(400)} WOLT BEOGRAD`
    expect(normalizeDescription(long).toUpperCase()).toContain('WOLT')
  })
})

// ═══════════════════════════ extractCounterparty() ═══════════════════════════

describe('extractCounterparty', () => {
  it.each<[string, string]>([
    ['POS 4738 WOLT BEOGRAD', 'WOLT'],
    ['WOLT BEOGRAD POS 4738 04.08.2026', 'WOLT'],
    ['KUPOVINA 11.08.2026 MAXI 021 NOVI SAD', 'MAXI'],
    ['UPLATA OD EPS SNABDEVANJE DOO', 'EPS'],
  ])('reads a merchant name out of %s', (input, expected) => {
    const out = extractCounterparty(input)
    expect(out).not.toBeNull()
    expect((out as string).toUpperCase()).toContain(expected)
  })

  it.each<[string, string]>([
    ['an empty descriptor', ''],
    ['whitespace only', '    '],
    ['a bare number', '4738'],
    ['nothing but volatile tokens', 'POS 4738'],
    ['a date and a terminal id only', 'POS 4738 04.08.2026'],
    ['a card suffix only', '****1234'],
    ['a reference number only', '000123456789'],
    ['punctuation only', '*** ###'],
  ])('returns null for %s rather than guessing a merchant', (_label, input) => {
    expect(extractCounterparty(input)).toBeNull()
  })
})

// ═════════════════════════════════ toTransaction() ═════════════════════════════════

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
      amount: -1890,
      currency: 'RSD',
      dedupeKey: 'K-NEW',
      createdAt: CREATED,
    })
  })

  it.each<[number, string]>([
    [-0.01, 'out'],
    [0.01, 'in'],
    [-1890, 'out'],
    [412000, 'in'],
  ])('derives direction %s from the sign of the amount, keeping the amount signed', (amount, direction) => {
    const tx = toTransaction(makeRaw({ amount }), 'PERSONAL', 'T', 'K', CREATED)
    expect(tx.amount).toBe(amount)
    expect(tx.direction).toBe(direction)
  })

  it('starts a transaction unresolved, in MISC, so nothing is silently categorized', () => {
    expect(toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED).category).toBe('MISC')
  })

  it('starts with no dimensions rather than inventing any', () => {
    expect(toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED).dimensions).toEqual({})
  })

  it('records the statement as the source and leaves the source document unset', () => {
    const tx = toTransaction(makeRaw(), 'PERSONAL', 'T', 'K', CREATED)
    expect(tx.source).toBe('statement')
    expect(tx.sourceDocument).toBeNull()
  })

  it('passes an absent value date through as null', () => {
    expect(
      toTransaction(makeRaw({ valueDate: null }), 'PERSONAL', 'T', 'K', CREATED).valueDate,
    ).toBeNull()
  })

  it('sets amountRsd from the amount when the transaction is already in dinars', () => {
    expect(
      toTransaction(makeRaw({ currency: 'RSD', amount: -1890 }), 'PERSONAL', 'T', 'K', CREATED)
        .amountRsd,
    ).toBe(-1890)
  })

  it('leaves amountRsd null for a foreign currency, because no rate was supplied', () => {
    expect(
      toTransaction(makeRaw({ currency: 'EUR', amount: -300 }), 'PERSONAL', 'T', 'K', CREATED)
        .amountRsd,
    ).toBeNull()
  })

  it('leaves counterparty null when the descriptor holds no usable merchant name', () => {
    expect(
      toTransaction(makeRaw({ description: 'POS 4738' }), 'PERSONAL', 'T', 'K', CREATED)
        .counterparty,
    ).toBeNull()
  })

  it('does not mutate the raw transaction it is given', () => {
    const raw = makeRaw()
    const snapshot = structuredClone(raw)
    toTransaction(raw, 'PERSONAL', 'T', 'K', CREATED)
    expect(raw).toEqual(snapshot)
  })
})

// ═════════════════════════════════ validateSplit() ═════════════════════════════════

describe('validateSplit', () => {
  const spend = makeTx({ amount: -100, amountRsd: -100, direction: 'out' })
  const income = makeTx({ amount: 100, amountRsd: 100, direction: 'in' })

  // ── acceptance ────────────────────────────────────────────────────────────

  it('accepts parts that sum exactly to the original amount', () => {
    expect(
      validateSplit(spend, [
        { amount: -70, category: 'HRANA' },
        { amount: -30, category: 'DECA' },
      ]),
    ).toEqual({ valid: true, difference: 0, errors: [] })
  })

  it('accepts a sum that only floating-point arithmetic makes inexact', () => {
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

  it('accepts an income transaction split into positive parts', () => {
    expect(
      validateSplit(income, [
        { amount: 60, category: 'PRIHOD' },
        { amount: 40, category: 'PRIHOD' },
      ]).valid,
    ).toBe(true)
  })

  // ── the 2dp tolerance boundary, exactly ───────────────────────────────────

  it('accepts a discrepancy that disappears at two decimal places', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -30.004, category: 'DECA' },
    ])
    expect(result.valid).toBe(true)
    expect(result.difference).toBe(0)
  })

  it('rejects a residue of exactly half a hundredth, which rounds half-up to 0.01', () => {
    const result = validateSplit(spend, [
      { amount: -70, category: 'HRANA' },
      { amount: -29.995, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0.01)
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

  it('reports the difference as the parts sum minus the original amount, to 2dp', () => {
    expect(
      validateSplit(spend, [
        { amount: -70, category: 'HRANA' },
        { amount: -25, category: 'DECA' },
      ]).difference,
    ).toBe(5)
  })

  it('reports a negative difference when the parts overshoot the original', () => {
    expect(
      validateSplit(spend, [
        { amount: -70, category: 'HRANA' },
        { amount: -50, category: 'DECA' },
      ]).difference,
    ).toBe(-20)
  })

  // ── sign discipline ───────────────────────────────────────────────────────

  it('rejects a part whose sign disagrees with the original even when the sum is right', () => {
    // -150 + 50 = -100: arithmetically fine, but a positive part inside an
    // outflow is a refund the ledger should record separately, not a split.
    const result = validateSplit(spend, [
      { amount: -150, category: 'HRANA' },
      { amount: 50, category: 'DECA' },
    ])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)
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

  it('refuses to split a zero-amount transaction', () => {
    expect(validateSplit(makeTx({ amount: 0 }), [{ amount: 0, category: 'HRANA' }]).valid).toBe(false)
  })

  // ── malformed input ───────────────────────────────────────────────────────

  it('rejects an empty list of parts and reports the whole amount as the difference', () => {
    const result = validateSplit(spend, [])
    expect(result.valid).toBe(false)
    expect(result.difference).toBe(100)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('does not throw when the parts list is absent', () => {
    const run = (): unknown => validateSplit(spend, null as unknown as SplitPart[])
    expect(run).not.toThrow()
    expect(validateSplit(spend, null as unknown as SplitPart[]).valid).toBe(false)
  })

  it.each<[string, number]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a %s part instead of throwing', (_label, amount) => {
    const run = (): unknown => validateSplit(spend, [{ amount, category: 'HRANA' }])
    expect(run).not.toThrow()
    expect(validateSplit(spend, [{ amount, category: 'HRANA' }]).valid).toBe(false)
  })

  // ── errors track validity exactly ─────────────────────────────────────────

  it('carries at least one error for every rejection and none for an acceptance', () => {
    const cases: SplitPart[][] = [
      [
        { amount: -70, category: 'HRANA' },
        { amount: -30, category: 'DECA' },
      ],
      [],
      [{ amount: -99, category: 'HRANA' }],
      [
        { amount: -150, category: 'HRANA' },
        { amount: 50, category: 'DECA' },
      ],
      [{ amount: Number.NaN, category: 'HRANA' }],
    ]
    for (const parts of cases) {
      const result = validateSplit(spend, parts)
      expect(result.errors.length === 0).toBe(result.valid)
    }
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

// ═════════════════════════════════ suggestSplit() ═════════════════════════════════

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

  it('gives the parts the transaction sign, not the line items sign', () => {
    const parts = suggestSplit(basket, mixedItems) as SplitPart[]
    expect(parts.every((p) => p.amount < 0)).toBe(true)
    expect(sum2(parts.map((p) => p.amount))).toBe(-1200)
  })

  it('produces a suggestion that its own validator accepts', () => {
    const parts = suggestSplit(basket, mixedItems) as SplitPart[]
    expect(validateSplit(basket, parts).valid).toBe(true)
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

  // ── the refusals are the point ────────────────────────────────────────────

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

  it('returns null for a single line item, since one item cannot disagree with itself', () => {
    expect(
      suggestSplit(basket, [{ description: 'PAMPERS', lineTotal: 1200, category: 'DECA' }]),
    ).toBeNull()
  })

  it('returns null when a line total is missing, rather than apportioning the remainder', () => {
    expect(
      suggestSplit(basket, [
        { description: 'PAMPERS', lineTotal: null, category: 'DECA' },
        { description: 'MLEKO', lineTotal: 1200, category: 'HRANA' },
      ]),
    ).toBeNull()
  })

  it('returns null when a line item has no category, rather than filing it under a guess', () => {
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

  it('returns null for a zero-amount transaction, which cannot be split', () => {
    expect(
      suggestSplit(makeTx({ amount: 0 }), [
        { description: 'MLEKO', lineTotal: 0, category: 'HRANA' },
        { description: 'PAMPERS', lineTotal: 0, category: 'DECA' },
      ]),
    ).toBeNull()
  })

  it('returns null when the items argument is absent', () => {
    expect(
      suggestSplit(
        basket,
        null as unknown as Array<{
          description: string
          lineTotal: number | null
          category: string | null
        }>,
      ),
    ).toBeNull()
  })
})
