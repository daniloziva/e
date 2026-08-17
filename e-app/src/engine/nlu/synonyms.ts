import type { Currency } from '../types.js'

export interface SynonymTable {
  currency: Record<string, Currency>       // normalized token -> currency
  dimension: Record<string, string>        // normalized token -> canonical value
}

/**
 * The closed, canonical currency layer. Built in, never learned: a token here
 * has exactly one reading, so resolving it is a lookup and not a guess.
 * A supplied SynonymTable extends this; it never overrides it.
 */
const CANONICAL_CURRENCIES: Record<string, Currency> = {
  eur: 'EUR',
  e: 'EUR',
  '€': 'EUR',
  evra: 'EUR',
  evro: 'EUR',
  eura: 'EUR',
  rsd: 'RSD',
  din: 'RSD',
  dinara: 'RSD',
  usd: 'USD',
  chf: 'CHF',
  gbp: 'GBP',
}

/**
 * Đ and đ carry no combining-mark decomposition (U+0110 / U+0111 are atomic),
 * so NFD alone leaves them standing. Every other Serbian latin diacritic —
 * š ž č ć — does decompose and is handled by stripping combining marks.
 */
const ATOMIC_FOLDS: Record<string, string> = { đ: 'd' }

/** Lowercase, strip diacritics, collapse whitespace. The shared normalizer. */
export function normalize(input: string): string {
  // Callers hand this untrusted text (a WhatsApp body, a header). An absent
  // token normalizes to the empty token rather than throwing; every caller
  // already treats the empty token as "nothing to resolve".
  if (typeof input !== 'string') return ''

  return input
    .toLowerCase()
    .replace(/[đ]/g, (ch) => ATOMIC_FOLDS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resolve a currency token deterministically.
 * "EVRA" | "evro" | "eura" | "€" | "e" | "eur" -> 'EUR'; "din"|"rsd"|"dinara" -> 'RSD'.
 * Unknown token -> null (E asks; it never defaults silently).
 */
export function resolveCurrency(token: string, table?: SynonymTable): Currency | null {
  const key = normalize(token)
  if (key === '') return null

  // Canonical first: a learned entry extends the table, it never redefines a
  // token the closed layer already owns.
  const canonical = CANONICAL_CURRENCIES[key]
  if (canonical !== undefined) return canonical

  const learned = table?.currency[key]
  return learned ?? null
}

interface Route {
  /** the candidate exactly as the caller spelled it — the value we return */
  canonical: string
  distance: number
}

/**
 * Fuzzy-match a token to a canonical value from a closed set.
 * Case/diacritic-insensitive, Levenshtein <= maxDistance (default 2).
 * Ambiguous (two candidates at the same distance) -> null. Never guesses.
 */
export function fuzzyMatch(
  token: string,
  candidates: string[],
  aliases?: Record<string, string[]>,
  maxDistance = 2,
): string | null {
  const needle = normalize(token)
  if (needle === '') return null
  if (candidates.length === 0) return null

  // Best distance per candidate, over the candidate's own spelling and every
  // alias that points at it. Several routes to the same value are not a
  // conflict — ambiguity is about the answer, not about how it was reached.
  const best = new Map<string, Route>()
  const consider = (canonical: string, spelling: string): void => {
    const distance = levenshtein(needle, normalize(spelling))
    const current = best.get(canonical)
    if (current === undefined || distance < current.distance) {
      best.set(canonical, { canonical, distance })
    }
  }

  for (const candidate of candidates) consider(candidate, candidate)

  if (aliases !== undefined) {
    for (const [canonical, spellings] of Object.entries(aliases)) {
      // The closed set is the authority: an alias pointing at a value that is
      // not on offer must not smuggle it in.
      const target = candidates.find((c) => normalize(c) === normalize(canonical))
      if (target === undefined) continue
      for (const spelling of spellings) consider(target, spelling)
    }
  }

  let winner: Route | null = null
  let tied = false
  for (const route of best.values()) {
    if (winner === null || route.distance < winner.distance) {
      winner = route
      tied = false
    } else if (route.distance === winner.distance) {
      tied = true
    }
  }

  if (winner === null || tied) return null
  if (winner.distance > maxDistance) return null
  return winner.canonical
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const rows = a.length
  const cols = b.length
  if (rows === 0) return cols
  if (cols === 0) return rows

  // Two-row DP. Plain Levenshtein — a transposition costs two edits, not one;
  // Damerau would turn some deliberate ties into matches (see the suite).
  let previous: number[] = []
  for (let j = 0; j <= cols; j += 1) previous.push(j)

  for (let i = 1; i <= rows; i += 1) {
    const current: number[] = [i]
    let diagonal = i - 1
    let left = i
    for (let j = 1; j <= cols; j += 1) {
      const above = previous[j] ?? 0
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(above + 1, left + 1, diagonal + cost)
      current.push(value)
      diagonal = above
      left = value
    }
    previous = current
  }

  return previous[cols] ?? 0
}
