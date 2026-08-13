import type { ExtractedFacts, Extraction, ReviewStatus, Clock } from '../types.js'

export interface ValidationResult {
  facts: ExtractedFacts          // invalid fields nulled out, never coerced
  reviewStatus: ReviewStatus
  rejected: string[]             // field names that failed validation
}

/**
 * Applied to EVERY ladder rung's output identically — regex, Document Intelligence,
 * LLM, or manual. Rules (01 §5):
 *  - vendorPib: exactly 9 digits or null
 *  - docDate: parseable and within [now - 18 months, now + 2 days] or null
 *  - amountTotal: 0 < x < 10_000_000 or null
 *  - vatAmount: <= amountTotal, else drop the VAT only
 *  - currency: from the allowlist or null
 *  - any null in {amountTotal, docDate}, or confidence below 'high' -> needs_review
 */
export function validateFacts(
  _facts: ExtractedFacts,
  _extraction: Extraction,
  _clock: Clock,
): ValidationResult {
  throw new Error('not implemented')
}

