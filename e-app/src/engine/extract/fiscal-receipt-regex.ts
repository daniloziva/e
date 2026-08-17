import type { ExtractedFacts } from '../types.js'

/**
 * PLACEHOLDER — layer 2 of the extraction ladder: the Serbian fiscal receipt
 * layout read off OCR text (01-ARCHITECTURE §5).
 *
 * BLOCKED ON: fixture F4 (5–10 real receipt photos, including one with a
 * damaged or absent QR and one foreign/non-RSD). Writing the regexes against
 * invented receipt text would encode a layout no printer actually produces.
 *
 * Whether this module is the PRIMARY path or a fallback is decided by spike
 * S-QR; how often it must carry the load is decided by spike S-DI.
 *
 * Known requirements from the roadmap's test-first order (M1 §8), which is
 * what the eventual test file must cover:
 *   - real OCR text → exact facts
 *   - both Cyrillic and Latin receipts
 *   - a receipt with the PDV line missing
 */

/**
 * Read facts out of OCR'd fiscal receipt text.
 * Returns null when the text is not a recognisable fiscal receipt, so the
 * ladder falls through to the next rung rather than emitting a guess.
 */
export function factsFromReceiptText(_ocrText: string): ExtractedFacts | null {
  throw new Error('not implemented')
}
