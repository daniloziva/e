import type { Clock, Confidence, ExtractedFacts, Extraction, ReviewStatus } from '../types.js'
import { round2 } from '../money.js'

export interface ValidationResult {
  facts: ExtractedFacts          // invalid fields nulled out, never coerced
  reviewStatus: ReviewStatus
  rejected: string[]             // field names that failed validation
}

/**
 * Applied to EVERY ladder rung's output identically — regex, Document Intelligence,
 * LLM, or manual. Rules (01 §5):
 *  - vendorPib: exactly 9 digits or null
 *  - docDate: parseable and within [now - 18 months, now + 2 days] or null
 *  - amountTotal: 0 < x < 100_000_000 or null
 *  - vatAmount: <= amountTotal, else drop the VAT only
 *  - currency: from the allowlist or null
 *  - any null in {amountTotal, docDate}, or confidence below 'high' -> needs_review
 */

/** Exactly nine ASCII digits. No trimming, no stripping of separators. */
const PIB_PATTERN = /^[0-9]{9}$/

/**
 * The ISO 7064 MOD 11,10 check digit a Serbian PIB carries (UNFREEZE CANDIDATE-002).
 *
 * Shape alone accepted `000000000` and `111111111` — numbers that cannot have been
 * issued — and, more importantly, accepted a one-digit OCR misread, which stays nine
 * digits long and is OCR's characteristic failure. PIB is *identity* for vendor
 * profiles (`01-ARCHITECTURE.md` §5), so a silent misread creates or contaminates one.
 *
 * Verified against three real, independently sourced PIBs before this landed:
 * 104052135 (NIS) and 111886391 (DILIGAF) from the F4 receipt, and 100002887 —
 * confirmed by the NBS account registry as TELEKOM SRBIJA A.D. All three validate.
 * No real PIB is known to fail it. See `TEST-FREEZE.md` for the full blast radius.
 *
 * Callers must apply PIB_PATTERN first: this reads exactly nine ASCII digits and
 * assumes it. `Number(undefined)` is NaN, which would make the comparison false
 * rather than throw, but a shorter string is a caller error, not an input case.
 */
function pibChecksumValid(pib: string): boolean {
  let p = 10
  for (let i = 0; i < 8; i += 1) {
    p = (p + Number(pib[i])) % 10
    if (p === 0) p = 10
    p = (p * 2) % 11
  }
  return (11 - p) % 10 === Number(pib[8])
}

/** Exactly YYYY-MM-DD in ASCII digits. Anything else is not a date we will guess at. */
const ISO_DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/

/** The `Currency` union, as runtime data. A model emits strings, not union members. */
const CURRENCY_ALLOWLIST: readonly string[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

/** Confidence levels that do NOT by themselves send a document to the queue. */
const CONFIDENT_ENOUGH: readonly Confidence[] = ['exact', 'high']

/** Both ends exclusive: 0 < amountTotal < 100_000_000. */
const AMOUNT_LOWER_EXCLUSIVE = 0
const AMOUNT_UPPER_EXCLUSIVE = 100_000_000

const WINDOW_MONTHS_BACK = 18
const WINDOW_DAYS_AHEAD = 2

/** A calendar day, free of instants and time zones — the unit the window is defined in. */
interface CalendarDate {
  year: number
  month: number // 1-12
  day: number // 1-31
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    default:
      return isLeapYear(year) ? 29 : 28
  }
}

/**
 * Strict YYYY-MM-DD. Returns null rather than guessing: no Date parsing, so
 * "2026-02-30" and "2026-8-1" are refusals rather than silent roll-overs.
 */
function parseCalendarDate(value: string): CalendarDate | null {
  const match = ISO_DATE_PATTERN.exec(value)
  if (match === null) return null

  const [, yearText, monthText, dayText] = match
  // The pattern has three capture groups, so a match guarantees all three, but
  // noUncheckedIndexedAccess types them as possibly-undefined.
  if (yearText === undefined || monthText === undefined || dayText === undefined) return null

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)

  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return { year, month, day }
}

function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) return a.year - b.year
  if (a.month !== b.month) return a.month - b.month
  return a.day - b.day
}

/** The calendar day the injected clock is pointing at, read in UTC. */
function calendarDayOf(clock: Clock): CalendarDate {
  const instant = clock.now()
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  }
}

/**
 * Calendar-clamped month subtraction: 2026-08-31 minus 18 months is 2025-02-28,
 * the last real day of that month, not a roll-over into March.
 */
function minusMonths(date: CalendarDate, months: number): CalendarDate {
  const totalMonths = date.year * 12 + (date.month - 1) - months
  const year = Math.floor(totalMonths / 12)
  const month = totalMonths - year * 12 + 1
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

function plusDays(date: CalendarDate, days: number): CalendarDate {
  let { year, month } = date
  let day = date.day + days

  let lengthOfMonth = daysInMonth(year, month)
  while (day > lengthOfMonth) {
    day -= lengthOfMonth
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
    lengthOfMonth = daysInMonth(year, month)
  }

  return { year, month, day }
}

export function validateFacts(
  facts: ExtractedFacts,
  extraction: Extraction,
  clock: Clock,
): ValidationResult {
  const rejected: string[] = []

  // vendorPib — nine digits AND a valid ISO 7064 MOD 11,10 check digit, or nothing.
  // Never repaired, never stripped.
  let vendorPib: string | null = null
  if (facts.vendorPib === null) {
    vendorPib = null
  } else if (
    typeof facts.vendorPib === 'string' &&
    PIB_PATTERN.test(facts.vendorPib) &&
    pibChecksumValid(facts.vendorPib)
  ) {
    vendorPib = facts.vendorPib
  } else {
    // The typeof guard is load-bearing, not belt-and-braces. These facts come
    // from an LLM's JSON, where `"vendorPib": 123456789` (unquoted) is entirely
    // plausible — and RegExp.test() COERCES its argument, so the number 123456789
    // stringifies to "123456789" and satisfies /^[0-9]{9}$/. Without this guard a
    // number lands in a `string | null` field, having passed the one gate that
    // exists to prevent exactly that. TypeScript cannot police a runtime boundary.
    rejected.push('vendorPib')
  }

  // docDate — a real calendar date inside [now - 18 months, now + 2 days],
  // both edges inclusive. The reference day comes from the injected clock.
  const today = calendarDayOf(clock)
  const lowerBound = minusMonths(today, WINDOW_MONTHS_BACK)
  const upperBound = plusDays(today, WINDOW_DAYS_AHEAD)

  let docDate: string | null = null
  if (facts.docDate === null) {
    docDate = null
  } else {
    const parsed = parseCalendarDate(facts.docDate)
    if (
      parsed !== null &&
      compareCalendarDates(parsed, lowerBound) >= 0 &&
      compareCalendarDates(parsed, upperBound) <= 0
    ) {
      docDate = facts.docDate
    } else {
      // Out of window is a refusal, not a clamp to the nearest edge.
      rejected.push('docDate')
    }
  }

  // amountTotal — 0 < x < 100_000_000, both ends exclusive, and finite.
  //
  // QUANTISED TO CENTS on the way through. This is the engine's only
  // cent-boundary, and it is here because this is the one function every rung's
  // output passes through, whatever produced it.
  //
  // Nothing upstream constrains an extractor to two decimals: a model may emit
  // 33.333 as readily as 33.33. Downstream, four modules then disagree about
  // where rounding happens — measured consequences of leaving it unquantised
  // were ~2% of invoice nets landing a cent low, ~50% of invoices whose printed
  // lines do not sum to their printed net (an EN 16931 BR-CO-10 violation), and
  // ~70% of monthly packages where SUM(manifest.csv) != the emailed total.
  // Every one of those measured 0% when the inputs were already 2dp.
  //
  // Rounding once, here, deletes that class for every consumer including the
  // ones not yet written. round2 is the engine's single convention (half away
  // from zero); it is the identity on any value that was already 2dp, which is
  // every value the frozen suite supplies.
  let amountTotal: number | null = null
  if (facts.amountTotal === null) {
    amountTotal = null
  } else if (
    Number.isFinite(facts.amountTotal) &&
    facts.amountTotal > AMOUNT_LOWER_EXCLUSIVE &&
    facts.amountTotal < AMOUNT_UPPER_EXCLUSIVE
  ) {
    amountTotal = round2(facts.amountTotal)
  } else {
    rejected.push('amountTotal')
  }

  // vatAmount — at most the total that survived validation. An impossible VAT
  // costs only the VAT: the total is never repaired or recomputed from it.
  let vatAmount: number | null = null
  if (facts.vatAmount === null) {
    vatAmount = null
  } else if (
    Number.isFinite(facts.vatAmount) &&
    facts.vatAmount >= 0 &&
    amountTotal !== null &&
    facts.vatAmount <= amountTotal
  ) {
    vatAmount = round2(facts.vatAmount) // quantised for the same reason as the total
  } else {
    rejected.push('vatAmount')
  }

  // amountNet — no range rule (01 §5 names none, and the frozen suite pins that
  // a large net and a net that disagrees with total-minus-VAT both survive).
  //
  // But a NON-FINITE net is not a value at all, and it is the one field here
  // with no guard whatsoever: NaN currently passes certification and would
  // poison any sum that later reads it. Quantised alongside the other two so all
  // three money fields leave this function on the same grid.
  //
  // Sign is deliberately NOT constrained: a credit note or storno has a
  // legitimately negative net.
  let amountNet: number | null = null
  if (facts.amountNet === null) {
    amountNet = null
  } else if (Number.isFinite(facts.amountNet)) {
    amountNet = round2(facts.amountNet)
  } else {
    rejected.push('amountNet')
  }

  // currency — on the allowlist exactly, or nothing. No trimming, no
  // upper-casing, and no fallback to the book's default.
  let currency = facts.currency
  if (currency !== null && !CURRENCY_ALLOWLIST.includes(currency)) {
    currency = null
    rejected.push('currency')
  }

  const missingEssential = amountTotal === null || docDate === null
  const lowConfidence = !CONFIDENT_ENOUGH.includes(extraction.confidence)
  const reviewStatus: ReviewStatus = missingEssential || lowConfidence ? 'needs_review' : 'ok'

  return {
    // Fields with no rule — vendorName, amountNet, lineItems — pass through as
    // they arrived. Neither argument is mutated.
    //
    // lineItems is copied rather than aliased: the tests demand the INPUT is not
    // mutated, but a shared array means a caller mutating the result reaches back
    // into the extractor's output and breaks that guarantee one step later.
    facts: {
      ...facts,
      vendorPib,
      docDate,
      amountNet,
      amountTotal,
      vatAmount,
      currency,
      lineItems: [...facts.lineItems],
    },
    reviewStatus,
    rejected,
  }
}
