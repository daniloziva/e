import type { Currency } from './types.js'

/** §4 ruling: governs only whether the confirm path will ACT on a stale rate. */
export const RATE_STALENESS_MAX_DAYS = 7

/** adapters/nbs/rate-page.ts output. Every field is cell text, verbatim. */
export interface RawRateRow {
  code: string
  formedOn: string
  appliesOn: string
  unit: string
  middleRate: string
}

export interface RateQuote {
  currency: Currency
  /** ISO date this rate IS the rate for (the application date). */
  rateDate: string
  /** ISO date the list was formed. Audit only. */
  formedOn: string
  /** already divided by unit */
  rate: number
}

export interface ResolvedRate {
  rate: number
  rateDate: string
}

// ── STUBS. The contract above is the spec; these throw until implemented. ──

export function parseSerbianRate(_text: string): number | null {
  throw new Error('not implemented')
}

export function parseNbsDate(_text: string): string | null {
  throw new Error('not implemented')
}

export function toQuotes(_rows: readonly RawRateRow[]): RateQuote[] {
  throw new Error('not implemented')
}

export function selectRate(
  _quotes: readonly RateQuote[],
  _currency: Currency,
  _onDate: string,
): RateQuote | null {
  throw new Error('not implemented')
}

export function isRateStale(_rateDate: string, _txDate: string): boolean {
  throw new Error('not implemented')
}

export function rateAgeInDays(_rateDate: string, _txDate: string): number | null {
  throw new Error('not implemented')
}

export function isRateUsableForConfirm(_rateDate: string, _txDate: string): boolean {
  throw new Error('not implemented')
}

export function resolveRate(
  _quotes: readonly RateQuote[],
  _currency: Currency,
  _txDate: string,
): ResolvedRate | null {
  throw new Error('not implemented')
}

export function toBookCurrency(_amountRsd: number | null, _bookRate: ResolvedRate | null): number | null {
  throw new Error('not implemented')
}
