import type { Clock } from './types.js'

// ---------------------------------------------------------------------------
// The engine's time vocabulary. 01-ARCHITECTURE.md §9.
//
// The engine never reads the system clock: an instant arrives through an
// injected Clock, and every calendar answer is derived from that instant's
// **UTC** components. That is the whole discipline in one sentence, and it is
// load-bearing rather than stylistic:
//
//   - Both this container and Azure Functions run UTC, so an implementation
//     that read local components would be green here, green in CI, and wrong
//     only on the Belgrade laptop the documents come from. The suite is pinned
//     to TZ=Europe/Belgrade for exactly that reason.
//   - 23:00 UTC on 31 December is already 1 January in Belgrade. Which month
//     the monthly package covers must not depend on where the function app
//     happens to run.
//
// Nothing here constructs a Date from local components (`new Date(y, m, d)`),
// and nothing here calls toISOString() on a locally-built Date. Month lengths
// come from the proleptic Gregorian rule directly, so 1900, 2000 and 2100 are
// arithmetic rather than a trust exercise in the host's calendar.
// ---------------------------------------------------------------------------

/** "YYYY-MM". A two-digit month in 01..12 — 2026-00 and 2026-13 are not periods. */
const PERIOD_RE = /^(\d{4})-(\d{2})$/

/** "YYYY-MM-DD", strictly: zero-padded, no time part, no other separator. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const MONTH_LENGTHS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** Proleptic Gregorian: every 4 years, except centuries, except every 400. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Days in a 1-based month. February is the only interesting case. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  const length = MONTH_LENGTHS[month - 1]
  // month is validated by the callers; this keeps the indexed access total
  // under noUncheckedIndexedAccess without inventing a fallback length.
  if (length === undefined) throw new Error(`clock: ${month} is not a month`)
  return length
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const pad4 = (n: number): string => String(n).padStart(4, '0')

/**
 * The instant the injected clock is reporting, as a Date this module only ever
 * READS. The Date is never mutated and never re-created from local components,
 * so a clock that hands out the same instance on every call keeps answering the
 * same question (the fake in the suite asserts exactly that).
 */
function instantOf(clock: Clock): Date {
  const now = clock.now()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    // A clock that cannot say what time it is must not be allowed to produce
    // "NaN-NaN" and package a month that does not exist.
    throw new Error('clock: now() did not return a usable instant')
  }
  return now
}

/**
 * "2026-07" for the month before the clock's current month.
 *
 * This is the D6 decision (03-DILIGAF §5): the timer fires at 06:00 UTC on the
 * 1st and packages the month that just ended. Computed by decrementing the
 * month NUMBER, never by subtracting days — "minus 30 days" and
 * `setMonth(getMonth() - 1)` both land back inside the starting month when the
 * current day is the 31st, and both are silently right for eleven months a year.
 */
export function previousMonth(clock: Clock): string {
  const now = instantOf(clock)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1 // getUTCMonth is 0-based

  return month === 1 ? `${pad4(year - 1)}-12` : `${pad4(year)}-${pad2(month - 1)}`
}

/** "2026-08" for the clock's current month, read as UTC. */
export function currentMonth(clock: Clock): string {
  const now = instantOf(clock)
  return `${pad4(now.getUTCFullYear())}-${pad2(now.getUTCMonth() + 1)}`
}

/**
 * Inclusive [start, end] ISO dates (YYYY-MM-DD) covering the given "YYYY-MM".
 *
 * Both ends belong to the period. The end day comes from the Gregorian month
 * length, so a month containing a DST transition — which is 23 or 25 hours
 * short of thirty times 86_400_000 ms — still ends on its real last day.
 *
 * Refuses a malformed period rather than guessing a range: the return type is
 * not nullable, so a refusal can only be an exception, and a guessed range here
 * would silently package the wrong documents.
 */
export function monthBounds(period: string): { start: string; end: string } {
  const parsed = parsePeriod(period)
  if (parsed === null) throw new Error(`monthBounds: "${String(period)}" is not a YYYY-MM period`)

  const { year, month } = parsed
  return {
    start: `${pad4(year)}-${pad2(month)}-01`,
    end: `${pad4(year)}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
  }
}

/** The parts of a "YYYY-MM", or null when it is not one. */
function parsePeriod(period: string): { year: number; month: number } | null {
  if (typeof period !== 'string') return null
  const match = PERIOD_RE.exec(period)
  if (match === null) return null

  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return { year, month }
}

/**
 * The "YYYY-MM" a YYYY-MM-DD date falls in, or null for anything that is not
 * one — including a date that does not exist.
 *
 * The rollover is the point: `new Date('2026-02-29')` is 1 March, so a parser
 * built on Date would file a late receipt into the next month's package, every
 * time, forever, without ever raising anything. Here the day is checked against
 * the real length of its month and a non-existent date is simply not a date.
 */
export function periodOf(isoDate: string): string | null {
  if (typeof isoDate !== 'string') return null
  const match = DATE_RE.exec(isoDate)
  if (match === null) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return `${pad4(year)}-${pad2(month)}`
}
