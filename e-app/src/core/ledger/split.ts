import type { Transaction } from '../types.js'

export interface SplitPart { amount: number; category: string; description?: string }

export interface SplitValidation {
  valid: boolean
  /** difference between the parts' sum and the original amount, 2dp */
  difference: number
  errors: string[]
}

/** Parts must sum to the original amount exactly (to 2dp) and share its sign. */
export function validateSplit(_tx: Transaction, _parts: SplitPart[]): SplitValidation {
  throw new Error('not implemented')
}

/** Suggest a split from line items whose categories disagree. Null when they don't. */
export function suggestSplit(
  _tx: Transaction,
  _items: Array<{ description: string; lineTotal: number | null; category: string | null }>,
): SplitPart[] | null {
  throw new Error('not implemented')
}

