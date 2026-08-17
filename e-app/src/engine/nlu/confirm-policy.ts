import type { Interpretation } from './interpret.js'
import type { Book } from '../types.js'

export type Decision =
  | { action: 'commit' }
  | { action: 'confirm'; reason: 'low_confidence' | 'missing_slot' | 'large_amount' | 'conflict' }
  | { action: 'ask'; missing: string[] }

// ---------------------------------------------------------------------------
// 02 §5.1, "The confirm policy". Three outcomes, in a fixed precedence:
//
//   ask     — a required slot is missing entirely. Nothing to confirm yet:
//             a tap can only mean "yes, that is right", and there is no "that".
//   confirm — the reading is complete but something makes it worth a second
//             of the sender's attention.
//   commit  — everything else. The common case, and it must stay common, or
//             the interface is worse than a spreadsheet.
//
// Required = money, plus every axis the book declares required. Description and
// date are never required: a booking with no description is still a booking.
// ---------------------------------------------------------------------------

const WEAK_CONFIDENCE = new Set(['medium', 'low'])

/** A required axis is satisfied only by a real value — "" is a hole, not a value. */
function isFilled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}

function missingSlots(interpretation: Interpretation, book: Book): string[] {
  const missing: string[] = []
  if (interpretation.slots.money === null) missing.push('money')

  const axes = Array.isArray(book.dimensions) ? book.dimensions : []
  for (const axis of axes) {
    if (!axis.required) continue
    if (!isFilled(interpretation.slots.dimensions[axis.axis])) missing.push(`dimensions.${axis.axis}`)
  }

  return missing
}

/**
 * Decide whether an interpretation may be written directly or needs a tap.
 * commit  — every required slot filled, confidence high/exact, amount under the book threshold
 * confirm — low confidence, a conflict, or an amount at/above book.features.confirmAboveAmount
 * ask     — a required slot is missing entirely
 */
export function decide(interpretation: Interpretation, book: Book): Decision {
  const missing = missingSlots(interpretation, book)
  if (missing.length > 0) return { action: 'ask', missing }

  // A conflict is the strongest reason of the three: it is the one case where
  // two layers read the same message differently, and the human is the only
  // thing that can settle it.
  if (interpretation.conflicts.length > 0) return { action: 'confirm', reason: 'conflict' }

  if (WEAK_CONFIDENCE.has(interpretation.confidence)) {
    return { action: 'confirm', reason: 'low_confidence' }
  }

  // At or above the threshold, not merely above it: a book that sets the bar at
  // 500 is saying 500 is already worth a look. `decide` is handed no FX rate,
  // so this compares raw numbers — 200 EUR is "under 50000" for an RSD book.
  // That asymmetry is deliberate and pinned by the suite; converting here would
  // mean reaching for a rate this function does not have.
  const money = interpretation.slots.money
  if (money !== null && money.amount >= book.features.confirmAboveAmount) {
    return { action: 'confirm', reason: 'large_amount' }
  }

  return { action: 'commit' }
}
