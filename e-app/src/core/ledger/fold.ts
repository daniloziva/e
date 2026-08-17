import type { Transaction } from '../types.js'

export type LedgerEvent =
  | { op: 'add'; id: string; at: string; tx: Transaction }
  | { op: 'set_category'; id: string; at: string; ref: string; category: string; by?: string }
  | { op: 'set_dimension'; id: string; at: string; ref: string; axis: string; value: string | null; by?: string }
  | { op: 'set_amount'; id: string; at: string; ref: string; amount: number; by?: string }
  | { op: 'split'; id: string; at: string; ref: string; parts: Array<{ amount: number; category: string }>; by?: string }
  | { op: 'delete'; id: string; at: string; ref: string; by?: string }

/**
 * Fold an event log into current state. The heart of all reporting.
 * Later events win. Ordering is by `at` then `id`, so an out-of-order input
 * array folds identically to a sorted one. Events referencing an unknown tx are ignored.
 */
export function fold(_events: LedgerEvent[]): Transaction[] {
  throw new Error('not implemented')
}

/** The inverse event for /tebra undo. Returns null when the op isn't invertible. */
export function invert(_event: LedgerEvent, _current: Transaction[], _id: string, _at: string): LedgerEvent | null {
  throw new Error('not implemented')
}

