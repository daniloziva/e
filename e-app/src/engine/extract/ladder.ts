import type { ExtractedFacts, Extraction, ExtractionMethod, Clock } from '../types.js'

export interface RungResult {
  facts: ExtractedFacts
  confidence: Extraction['confidence']
  model?: string | null
}

/** Each rung returns null when it cannot answer, so the ladder falls through. */
export type Rung = {
  method: ExtractionMethod
  run: (input: LadderInput) => Promise<RungResult | null>
}

export interface LadderInput {
  bytes: Uint8Array
  mimeType: string
  sha256: string
  filename: string
  vendorHint?: string | null
}

export interface LadderOutcome {
  facts: ExtractedFacts
  extraction: Extraction
  /** methods attempted, in order — asserts short-circuiting in tests */
  attempted: ExtractionMethod[]
}

/**
 * Run rungs in order, stop at the first that returns a result.
 * A cheaper rung succeeding means no later rung is invoked at all.
 * Every rung failing yields empty facts with method 'manual' and needs_review downstream.
 */
export function runLadder(
  _rungs: Rung[],
  _input: LadderInput,
  _clock: Clock,
): Promise<LadderOutcome> {
  throw new Error('not implemented')
}

