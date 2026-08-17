import type { RawTransaction } from '../ledger/normalize.js'
import type { StatementTotals } from './reconcile.js'

/**
 * PLACEHOLDER — the coordinate-band parser for PERSONAL bank statements
 * (01-ARCHITECTURE §4, 04-PERSONAL §2). Milestone M6.
 *
 * BLOCKED ON: fixture F2 — 2–3 real statement PDFs from different months, so
 * the multi-page and month-boundary cases are exercised against a real layout
 * rather than an imagined one. A band parser written against invented
 * coordinates is worse than no parser: it looks tested and is not.
 *
 * Q3 is resolved: the statements are NOT password-protected, so there is no
 * pdfjs password path to build.
 *
 * The parser is deliberately deterministic — no model anywhere in this path.
 * `reconcile()` is the hard gate that makes that safe: opening + credits −
 * debits ≈ closing, within ±0.01. A statement that does not reconcile is
 * rejected outright rather than partially trusted.
 */

/** One positioned text run, as produced by the pdf adapter. */
export interface PdfWord {
  text: string
  x: number
  y: number
  page: number
}

export interface ParsedStatement {
  totals: StatementTotals
  transactions: RawTransaction[]
  /** Statement period as YYYY-MM, read from the header. */
  period: string
}

/**
 * Parse positioned words into a statement.
 * Returns null when the document is not a recognisable statement; callers must
 * still run `reconcile()` on the result before trusting any of it.
 */
export function parsePersonalStatement(_words: PdfWord[]): ParsedStatement | null {
  throw new Error('not implemented')
}
