import type { Transaction, BookCode } from '../types.js'

export interface RawTransaction {
  txDate: string
  valueDate: string | null
  description: string
  amount: number
  currency: string
  balanceAfter: number | null
}

/**
 * Stable dedupe identity. Includes balanceAfter so two genuinely identical
 * same-day charges stay two transactions rather than collapsing into one.
 */
export function dedupeKey(_book: BookCode, _raw: RawTransaction, _hash: (s: string) => string): string {
  throw new Error('not implemented')
}

/** Strip volatile tokens (dates, terminal ids, reference numbers, card suffixes) for matching. */
export function normalizeDescription(_description: string): string {
  throw new Error('not implemented')
}

/** Best-effort merchant name from a bank descriptor. Returns null when nothing usable. */
export function extractCounterparty(_description: string): string | null {
  throw new Error('not implemented')
}

export function toTransaction(
  _raw: RawTransaction,
  _book: BookCode,
  _id: string,
  _dedupeKey: string,
  _createdAt: string,
): Transaction {
  throw new Error('not implemented')
}

