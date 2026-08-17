import type { Money, Currency } from './types.js'

/**
 * Parse a human-written amount. Serbian conventions: "." thousands, "," decimals.
 * Returns null when the input is absent or genuinely ambiguous — NEVER a half-guess.
 * A returned value is authoritative and may not be overridden by a model (02 §5.1).
 *
 * Handles at minimum: 4210 | 4.210,00 | 4210.50 | 300e | 300€ | "300 eur" |
 * "300 EVRA" | 1500din | "1.500 rsd" | 12k
 */
export function parseAmount(_input: string, _defaultCurrency?: Currency): Money | null {
  throw new Error('not implemented')
}

/** Format for display, Serbian locale, always 2 decimals. 4210 -> "4.210,00" */
export function formatAmount(_amount: number): string {
  throw new Error('not implemented')
}

/** Round half-up to 2 decimals. Applied per invoice, not per line. */
export function round2(_n: number): number {
  throw new Error('not implemented')
}

/** Convert with an explicit rate. Returns null if the rate is missing or non-positive. */
export function toRsd(_money: Money, _rate: number | null): number | null {
  throw new Error('not implemented')
}

