import type { ExtractedFacts } from '../types.js'

/**
 * Candidate values keyed by their ATOMIC source label:
 *   { 'di.InvoiceTotal': '4.210,00', 'qr.total': 4210, 'pdf.regex.ukupno': '4210' }
 *
 * The dots are part of the key — NEVER a path to walk into nested objects.
 * Adapters flatten their own wire shapes into this before core sees them, so
 * core never learns any provider's response tree. Trust labels follow the
 * convention `{rung}.{field}`: documented, but never parsed.
 *
 * This is a security boundary, not only a style choice. Trust labels come from
 * `_state/vendor-profiles.json`, which `/tebra` can propose edits to (09-TEBRA
 * §3), so treating one as a path would turn `__proto__.polluted` into a write
 * into Object.prototype. A flat lookup makes that an ordinary missing key.
 */
export type RawCandidates = Record<string, unknown>

export interface VendorProfile {
  vendorKey: string
  vendorName: string
  vendorPib: string | null
  /** fact field -> atomic source label that proved correct, e.g. "di.InvoiceTotal" */
  trust: Record<string, string>
  hints: { dateFormat?: string; decimal?: ',' | '.'; currencyDefault?: string }
  defaultCategory: string | null
  corrections: number
  lastSeen: string
}

/**
 * Stable key for a vendor: PIB when known, else normalized name.
 *
 * PROVISIONAL — under review, and the only part of the frozen suite that is.
 * Identity is moving to content matching over a single `_state/vendor-profiles.json`
 * (PIB as identity, names as matchable aliases), which removes the derived-filename
 * orphaning problem entirely and may retire this function. Blocked on the NBS
 * PIB-lookup spike. See 01-ARCHITECTURE.md §5 and TEST-FREEZE.md.
 */
export function vendorKey(_name: string | null, _pib: string | null): string | null {
  throw new Error('not implemented')
}

/** Fold a user correction into a profile. Increments `corrections`, records what was trusted. */
export function learnFromCorrection(
  _profile: VendorProfile | null,
  _before: ExtractedFacts,
  _after: ExtractedFacts,
  _at: string,
): VendorProfile {
  throw new Error('not implemented')
}

/**
 * Apply a known profile's trust labels and hints to flat raw candidates.
 * Returns null when the profile cannot produce a usable total.
 *
 * Lookups are single flat reads: `raw[profile.trust[field]]`. A trust label is
 * never split, never walked, and never used to reach a prototype.
 */
export function applyProfile(_profile: VendorProfile, _raw: RawCandidates): ExtractedFacts | null {
  throw new Error('not implemented')
}

