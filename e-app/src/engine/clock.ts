import type { Clock } from './types.js'

/** "2026-08" for the month before the clock's current month. Pure. */
export function previousMonth(_clock: Clock): string {
  throw new Error('not implemented')
}

/** "2026-08" for the clock's current month. */
export function currentMonth(_clock: Clock): string {
  throw new Error('not implemented')
}

/** Inclusive [start, end] ISO dates (YYYY-MM-DD) covering the given "YYYY-MM". */
export function monthBounds(_period: string): { start: string; end: string } {
  throw new Error('not implemented')
}

/** The "YYYY-MM" a YYYY-MM-DD date falls in. Returns null for an unparseable date. */
export function periodOf(_isoDate: string): string | null {
  throw new Error('not implemented')
}

