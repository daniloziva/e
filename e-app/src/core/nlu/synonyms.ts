import type { Currency } from '../types.js'

export interface SynonymTable {
  currency: Record<string, Currency>       // normalized token -> currency
  dimension: Record<string, string>        // normalized token -> canonical value
}

/** Lowercase, strip diacritics, collapse whitespace. The shared normalizer. */
export function normalize(_input: string): string {
  throw new Error('not implemented')
}

/**
 * Resolve a currency token deterministically.
 * "EVRA" | "evro" | "eura" | "€" | "e" | "eur" -> 'EUR'; "din"|"rsd"|"dinara" -> 'RSD'.
 * Unknown token -> null (E asks; it never defaults silently).
 */
export function resolveCurrency(_token: string, _table?: SynonymTable): Currency | null {
  throw new Error('not implemented')
}

/**
 * Fuzzy-match a token to a canonical value from a closed set.
 * Case/diacritic-insensitive, Levenshtein <= maxDistance (default 2).
 * Ambiguous (two candidates at the same distance) -> null. Never guesses.
 */
export function fuzzyMatch(
  _token: string,
  _candidates: string[],
  _aliases?: Record<string, string[]>,
  _maxDistance?: number,
): string | null {
  throw new Error('not implemented')
}

export function levenshtein(_a: string, _b: string): number {
  throw new Error('not implemented')
}

