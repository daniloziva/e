import type { ExtractedFacts, Extraction, ExtractionMethod, Clock, Confidence } from '../types.js'

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

// ---------------------------------------------------------------------------
// The ladder is a loop and nothing else. It does not validate, repair, retry,
// rank or merge: engine/extract/validate.ts owns every range rule (01 §5
// "Validation and failure"), and the product ruling of 2026-08-15 (07-ROADMAP
// §M1) is that a failed rung simply falls through — no recovery heroics.
//
// Rungs arrive INJECTED, so the ordering decision (QR -> Document Intelligence
// -> OpenAI parser) belongs to the caller. This module never re-sorts them into
// a canonical cost order, because the caller's order IS the cost order.
// ---------------------------------------------------------------------------

/** The floor when nothing answered: absence everywhere, expressed as null. */
function emptyFacts(): ExtractedFacts {
  return {
    vendorName: null,
    vendorPib: null,
    docDate: null,
    amountNet: null,
    vatAmount: null,
    amountTotal: null,
    currency: null,
    lineItems: [],
  }
}

const CONFIDENCE_VALUES: readonly Confidence[] = ['exact', 'high', 'medium', 'low']

/** Nothing answered, so the document is a human's problem — the lowest confidence there is. */
const FLOOR_CONFIDENCE: Confidence = 'low'

/**
 * A rung is injected code — an adapter around Document Intelligence or an LLM —
 * so what comes back is a runtime value, not merely a compile-time `RungResult`.
 * Anything that is not an object carrying a facts object is read as a decline
 * rather than trusted as an answer.
 */
function isRungResult(value: unknown): value is RungResult {
  if (typeof value !== 'object' || value === null) return false
  if (!('facts' in value)) return false
  const facts: unknown = value.facts
  return typeof facts === 'object' && facts !== null
}

/**
 * Membership test written as a loop rather than `includes` + a cast: it narrows
 * to the union without asserting anything TypeScript has not checked.
 */
function confidenceOf(value: unknown): Confidence {
  for (const confidence of CONFIDENCE_VALUES) {
    if (value === confidence) return confidence
  }
  // A rung that reports a confidence outside the union has told us nothing we
  // can act on, so it gets the reading that sends the document to review.
  return FLOOR_CONFIDENCE
}

/** Non-model rungs (QR, regex, cache) carry no model label; an absent one is null, never ''. */
function modelOf(result: RungResult): string | null {
  return typeof result.model === 'string' ? result.model : null
}

/**
 * The winning facts pass through unchanged — this layer adds no field and drops
 * none. Only the container is copied, so that a caller mutating the outcome
 * cannot reach back into the rung's own state.
 */
function passThrough(facts: ExtractedFacts): ExtractedFacts {
  return { ...facts, lineItems: Array.isArray(facts.lineItems) ? [...facts.lineItems] : [] }
}

/**
 * Invoke one rung and contain its failure. A rung that throws — synchronously
 * before ever returning a promise, or as a rejection, with an Error or with
 * anything else — is a rung that did not answer. It never aborts the climb, and
 * what it threw is never re-thrown: the product ruling is that a failed rung
 * simply falls through (07-ROADMAP §M1).
 */
async function attempt(rung: Rung, input: LadderInput): Promise<RungResult | null> {
  try {
    return await rung.run(input)
  } catch {
    return null
  }
}

/**
 * Run rungs in order, stop at the first that returns a result.
 * A cheaper rung succeeding means no later rung is invoked at all.
 * Every rung failing yields empty facts with method 'manual' and needs_review downstream.
 *
 * The clock is injected and deliberately UNREAD: the outcome of the ladder is a
 * function of the rungs and the document alone, so the same call yields an equal
 * outcome whatever instant the clock is pointing at. It stays in the signature
 * because the rung set is chosen by the caller and the ladder is the one seam
 * every extraction passes through — validate.ts is the module that needs "now".
 */
export async function runLadder(
  rungs: Rung[],
  input: LadderInput,
  _clock: Clock,
): Promise<LadderOutcome> {
  const attempted: ExtractionMethod[] = []

  for (const rung of rungs) {
    // Recorded BEFORE the call, so a rung that blows up still counts as tried.
    attempted.push(rung.method)

    // Awaited one at a time on purpose. Running the ladder concurrently would
    // pay for the expensive rungs before knowing whether the cheap one won,
    // which is the entire cost argument for having a ladder (01 §5).
    const result = await attempt(rung, input)
    if (!isRungResult(result)) continue

    // A result with entirely empty facts is still an answer: the rung looked and
    // reported what it found. Judging emptiness here would silently promote the
    // next, more expensive rung past a rung that did its job.
    return {
      facts: passThrough(result.facts),
      extraction: {
        // The method is the RUNG's identity, never a label inside its result.
        method: rung.method,
        confidence: confidenceOf(result.confidence),
        model: modelOf(result),
      },
      attempted,
    }
  }

  // The manual floor. 'manual' is not appended to `attempted`: nothing was
  // invoked for it — it is the outcome of having run out of rungs.
  return {
    facts: emptyFacts(),
    extraction: { method: 'manual', confidence: FLOOR_CONFIDENCE, model: null },
    attempted,
  }
}
