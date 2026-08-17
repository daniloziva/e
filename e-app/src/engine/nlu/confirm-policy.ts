import type { Interpretation } from './interpret.js'
import type { Book } from '../types.js'

export type Decision =
  | { action: 'commit' }
  | { action: 'confirm'; reason: 'low_confidence' | 'missing_slot' | 'large_amount' | 'conflict' }
  | { action: 'ask'; missing: string[] }

/**
 * Decide whether an interpretation may be written directly or needs a tap.
 * commit  — every required slot filled, confidence high/exact, amount under the book threshold
 * confirm — low confidence, a conflict, or an amount at/above book.features.confirmAboveAmount
 * ask     — a required slot is missing entirely
 */
export function decide(_interpretation: Interpretation, _book: Book): Decision {
  throw new Error('not implemented')
}

