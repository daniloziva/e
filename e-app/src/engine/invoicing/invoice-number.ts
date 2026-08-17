/**
 * Invoice numbers belong to the user (D12). Nothing here allocates, reserves or
 * counts: `suggestNextNumber` saves one retype behind a confirm step, and being
 * wrong costs one tap.
 */

/** Longest number accepted. Free text, but a document field, not an essay. */
const MAX_NUMBER_LENGTH = 64

interface DigitRun {
  text: string
  start: number
  /** exclusive */
  end: number
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

/** Every maximal run of digits, in order. charCodeAt keeps this free of the
 *  `string | undefined` that indexing would introduce. */
function digitRuns(text: string): DigitRun[] {
  const runs: DigitRun[] = []
  let start = -1

  for (let i = 0; i <= text.length; i += 1) {
    const inRun = i < text.length && isDigitCode(text.charCodeAt(i))
    if (inRun) {
      if (start === -1) start = i
    } else if (start !== -1) {
      runs.push({ text: text.slice(start, i), start, end: i })
      start = -1
    }
  }

  return runs
}

/**
 * A four-digit group in the calendar range, e.g. the `2026` of `0007/2026`.
 *
 * This is the one piece of shape-reading in the module, and it is deliberately
 * minimal. The spec's own worked example — `"0007/2026" -> "0008/2026"` — is
 * the sequence being incremented while the year stands still, so "increment the
 * trailing run" cannot be taken literally: it would produce `0007/2027`. The
 * rule is therefore "increment the trailing run, unless that run is a trailing
 * year and something earlier can carry the sequence".
 *
 * It is a padding/position rule, not calendar logic: nothing here rolls a year
 * over, and `KLIJENTA-2026-12` still becomes `KLIJENTA-2026-13` rather than
 * inventing a January.
 */
function isYearGroup(text: string): boolean {
  if (text.length !== 4) return false
  const value = Number(text)
  return value >= 1900 && value <= 2999
}

/**
 * Suggest the next invoice number by incrementing the sequence group and
 * preserving its zero-padding width. E never allocates — this is a typing
 * shortcut behind a confirm step (D12).
 *   "0007/2026"        -> "0008/2026"   (the year is a suffix, not the sequence)
 *   "KLIJENTA-2026-03" -> "KLIJENTA-2026-04"
 *   "2026007"          -> "2026008"     (one group: year+sequence run together)
 *   "2026/07/A"        -> null          (no trailing digit run)
 *   null | ""          -> null          (first invoice for this customer)
 */
export function suggestNextNumber(last: string | null): string | null {
  if (typeof last !== 'string') return null

  const runs = digitRuns(last)
  const trailing = runs[runs.length - 1]
  if (trailing === undefined) return null

  // The number must END in digits. A trailing revision marker ("0008/2026-rev")
  // or a non-numeric group ("2026/07/A") is a scheme E does not understand, and
  // it asks rather than guesses.
  if (trailing.end !== last.length) return null

  const previous = runs[runs.length - 2]
  const target = previous !== undefined && isYearGroup(trailing.text) ? previous : trailing

  // BigInt, not Number: a long number must not lose its last digit to a double.
  const bumped = (BigInt(target.text) + 1n).toString().padStart(target.text.length, '0')

  return last.slice(0, target.start) + bumped + last.slice(target.end)
}

/** Trim and case-fold: a warning is cheap, a missed clash is a numbering
 *  problem with the tax authority. Non-strings (JSON slips a number into the
 *  history) normalise to '' and therefore never match a real candidate. */
function normaliseNumber(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Warn, never block: has this number been used on this book before? */
export function isDuplicateNumber(candidate: string, used: string[]): boolean {
  const key = normaliseNumber(candidate)
  // Nothing was typed yet, so nothing can clash. Whole-value comparison
  // throughout: "0008" is not a use of "0008/2026".
  if (key === '') return false
  return used.some((entry) => normaliseNumber(entry) === key)
}

/**
 * Invoice numbers are free text; only emptiness and length are rejected. The
 * scheme belongs to the user, so Cyrillic, em dashes and numbers E cannot
 * increment are all legal — `validateNumber` and `suggestNextNumber` are
 * independent judgements.
 */
export function validateNumber(candidate: string): { valid: boolean; error?: string } {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : ''

  if (trimmed === '') {
    return { valid: false, error: 'Broj fakture ne moze biti prazan.' }
  }
  if (trimmed.length > MAX_NUMBER_LENGTH) {
    return {
      valid: false,
      error: `Broj fakture je predug — najvise ${MAX_NUMBER_LENGTH} znakova.`,
    }
  }

  return { valid: true }
}
