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
  /**
   * The currency this rate IS for. Carried so a caller cannot apply the book's
   * rate to the transaction's amount, or vice versa: `app/` resolves two of these
   * on adjacent lines and they are otherwise structurally identical, so the type
   * alone would permit the swap. The engine refuses rather than trusting it.
   */
  currency: Currency
  rate: number
  rateDate: string
}

/** Only the four foreign codes types.ts:7 allows. The NBS list carries 34, incl. dead ones. */
const BOOKED_FOREIGN = new Set<string>(['EUR', 'USD', 'CHF', 'GBP'])

const MS_PER_DAY = 86400000

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n)
}

/**
 * An NBS middle rate: Serbian comma decimal, 1-6 decimals.
 *
 * Deliberately NOT `money.ts`'s parser. `money.ts:87` refuses more than two
 * decimals, which is correct for money and fatal for a 4dp rate — verified:
 * `parseAmount('117,3510')` returns null. Two separate grammars, and a test pins
 * that they stay separate.
 */
export function parseSerbianRate(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,6},\d{1,6}$/.test(trimmed)) return null
  return Number(trimmed.replace(',', '.'))
}

/** "14.8.2026." -> "2026-08-14". A date that does not exist on a calendar is null. */
export function parseNbsDate(text: string): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(text.trim())
  if (match === null) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  const iso = `${String(year)}-${pad2(month)}-${pad2(day)}`
  // Rejects 31.2. and 29.2. in a non-leap year, which the range checks cannot.
  if (new Date(`${iso}T00:00:00Z`).getUTCDate() !== day) return null
  return iso
}

/** "1" -> 1, "100" -> 100. The divisor is applied unconditionally: HUF and JPY are quoted per 100. */
function parseUnit(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null
  const unit = Number(text.trim())
  return unit > 0 ? unit : null
}

/** Rows -> validated quotes. An unknown code is DROPPED, never widened into `Currency`. */
export function toQuotes(rows: readonly RawRateRow[]): RateQuote[] {
  const quotes: RateQuote[] = []
  for (const row of rows) {
    const code = row.code.trim().toUpperCase()
    if (!BOOKED_FOREIGN.has(code)) continue
    const rateDate = parseNbsDate(row.appliesOn)
    if (rateDate === null) continue
    const unit = parseUnit(row.unit)
    if (unit === null) continue
    const quoted = parseSerbianRate(row.middleRate)
    if (quoted === null) continue
    quotes.push({
      // Safe: BOOKED_FOREIGN is a subset of the Currency union, checked above.
      currency: code as Currency,
      rateDate,
      formedOn: parseNbsDate(row.formedOn) ?? rateDate,
      rate: quoted / unit,
    })
  }
  return quotes
}

/**
 * The newest quote for `currency` dated at or before `onDate`, or null.
 *
 * Selection lives here, not in the adapter (R1): Table Storage has no descending
 * sort, so "newest at or before X" cannot be a top-1 query — it is a bounded range
 * read plus a choice, and the choice is a pure function.
 *
 * Two rows for the SAME date carrying DIFFERENT rates cannot both be right, and a
 * dated rate is immutable (§3b), so a divergence is evidence of a bug rather than
 * a value to pick between. Returning null refuses instead of guessing, which keeps
 * the fold order-independent (`01-ARCHITECTURE.md:283`).
 */
export function selectRate(
  quotes: readonly RateQuote[],
  currency: Currency,
  onDate: string,
): RateQuote | null {
  let best: RateQuote | null = null
  for (const quote of quotes) {
    if (quote.currency !== currency) continue
    if (quote.rateDate > onDate) continue
    if (best === null || quote.rateDate > best.rateDate) {
      best = quote
      continue
    }
    if (quote.rateDate === best.rateDate && quote.rate !== best.rate) return null
  }
  return best
}

/** The flag. §4: the inequality IS the flag, at any age. No stored boolean. */
export function isRateStale(rateDate: string, txDate: string): boolean {
  return rateDate !== txDate
}

/** Whole days from `rateDate` to `txDate`. Negative means the rate is from the future. */
export function rateAgeInDays(rateDate: string, txDate: string): number | null {
  const from = Date.parse(`${rateDate}T00:00:00Z`)
  const to = Date.parse(`${txDate}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.round((to - from) / MS_PER_DAY)
}

/** §4: beyond the bound the confirm path treats the rate as unusable and takes the tap. */
export function isRateUsableForConfirm(rateDate: string, txDate: string): boolean {
  const age = rateAgeInDays(rateDate, txDate)
  if (age === null) return false
  if (age < 0) return false
  return age <= RATE_STALENESS_MAX_DAYS
}

/**
 * RSD never touches the store — it is a constant, so a cache miss can never make a
 * dinar receipt need a confirmation. PERSONAL is entirely RSD and the highest-volume
 * book.
 */
export function resolveRate(
  quotes: readonly RateQuote[],
  currency: Currency,
  txDate: string,
): ResolvedRate | null {
  if (currency === 'RSD') return { currency: 'RSD', rate: 1, rateDate: txDate }
  const quote = selectRate(quotes, currency, txDate)
  if (quote === null) return null
  return { currency: quote.currency, rate: quote.rate, rateDate: quote.rateDate }
}

/**
 * LCY -> the book's currency, the pivot of §3's threshold rule.
 *
 * Deliberately NOT rounded. `58749.5 / 117.5` is `499.99574…`; `round2` would lift
 * it to `500.00` and over a 500 threshold the money never crossed. Rounding before
 * a comparison can only manufacture a boundary crossing.
 */
export function toBookCurrency(amountRsd: number | null, bookRate: ResolvedRate | null): number | null {
  if (amountRsd === null) return null
  if (bookRate === null) return null
  // Same contract as toRsd (money.ts:296): finite and > 0, or no answer.
  if (!Number.isFinite(bookRate.rate) || bookRate.rate <= 0) return null
  return amountRsd / bookRate.rate
}
