import type { Transaction } from '../types.js'

/**
 * A vendor that has resolved to more than one category in history is ambiguous:
 * E must stop auto-applying a rule for it and fall back to line items or ask (04 §3).
 */
export function vendorIsAmbiguous(_vendor: string, _history: Transaction[]): boolean {
  throw new Error('not implemented')
}

/** Categories a vendor has been assigned, most frequent first. */
export function vendorCategories(_vendor: string, _history: Transaction[]): Array<{ category: string; count: number }> {
  throw new Error('not implemented')
}

