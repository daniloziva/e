import type { Money, DimensionAxisDef } from '../types.js'

export interface Slots {
  money: Money | null
  dimensions: Record<string, string>
  description: string | null
  date: string | null
}

export interface SlotExtraction {
  slots: Slots
  /** tokens no deterministic rule claimed — these are what the model is asked about */
  leftoverTokens: string[]
}

/**
 * Deterministic first pass over free text. Order-tolerant: "300e MATERIALS" and
 * "MATERIALS 300e" produce identical output. Whatever this returns is AUTHORITATIVE
 * and a model may not overwrite it (02 §5.1).
 */
export function extractSlots(_text: string, _axes: DimensionAxisDef[]): SlotExtraction {
  throw new Error('not implemented')
}

