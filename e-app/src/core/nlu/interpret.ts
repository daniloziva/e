import type { Slots } from './slots.js'
import type { Confidence } from '../types.js'

export interface ModelSlots {
  money?: { amount: number; currency: string } | null
  dimensions?: Record<string, string>
  description?: string | null
  date?: string | null
  confidence: Confidence
}

export interface Interpretation {
  slots: Slots
  confidence: Confidence
  /** per-field origin, for provenance and for tests */
  sources: Record<string, 'deterministic' | 'model'>
  /** fields where deterministic and model disagreed; the deterministic value was kept */
  conflicts: string[]
}

/**
 * Merge deterministic slots with model-proposed slots.
 * HARD RULE: a deterministic slot always wins. The model may only fill gaps.
 * Malformed/invalid model output is treated as NO ANSWER, never as a value.
 */
export function interpret(_deterministic: Slots, _model: ModelSlots | null): Interpretation {
  throw new Error('not implemented')
}

