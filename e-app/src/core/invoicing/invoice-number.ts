/**
 * Suggest the next invoice number by incrementing the LAST run of digits,
 * preserving its zero-padding width. E never allocates — this is a typing
 * shortcut behind a confirm step (D12).
 *   "0007/2026"        -> "0008/2026"
 *   "KLIJENTA-2026-03" -> "KLIJENTA-2026-04"
 *   "2026/07/A"        -> null   (no trailing digit run)
 *   null | ""          -> null   (first invoice for this customer)
 */
export function suggestNextNumber(_last: string | null): string | null {
  throw new Error('not implemented')
}

/** Warn, never block: has this number been used on this book before? */
export function isDuplicateNumber(_candidate: string, _used: string[]): boolean {
  throw new Error('not implemented')
}

/** Invoice numbers are free text; only emptiness and length are rejected. */
export function validateNumber(_candidate: string): { valid: boolean; error?: string } {
  throw new Error('not implemented')
}

