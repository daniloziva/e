import type { ExtractedFacts } from '../types.js'
import type { RawCandidates } from './vendor-profile.js'

/**
 * PLACEHOLDER — layer 4: Azure Document Intelligence `prebuilt-invoice` and
 * `prebuilt-receipt` field sets mapped into facts (01-ARCHITECTURE §5).
 *
 * BLOCKED ON: real Document Intelligence responses for Serbian documents,
 * which in turn need fixture F4. Spike S-DI measures per-field accuracy and
 * decides how often the LLM rung (layer 5) has to fire.
 *
 * NOTE ON THE INPUT TYPE — this is a security boundary, not a style choice.
 * These functions take `RawCandidates`: a FLAT record keyed by atomic source
 * labels such as 'di.InvoiceTotal'. The dots are part of the key and are never
 * a path to walk into a nested object. The adapter flattens DI's own response
 * tree before engine sees it, so engine never learns any provider's wire shape,
 * and a hostile trust label like `__proto__.polluted` is an ordinary missing
 * key rather than a write into Object.prototype. See vendor-profile.ts.
 */

/** Map flattened `prebuilt-invoice` candidates into facts. Null when unusable. */
export function factsFromDiInvoice(_raw: RawCandidates): ExtractedFacts | null {
  throw new Error('not implemented')
}

/** Map flattened `prebuilt-receipt` candidates into facts. Null when unusable. */
export function factsFromDiReceipt(_raw: RawCandidates): ExtractedFacts | null {
  throw new Error('not implemented')
}
