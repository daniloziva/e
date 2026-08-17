import { describe, it, expect } from 'vitest'
import { parseAmount, formatAmount, round2, toRsd } from '../../../src/engine/money.js'
import {
  normalize,
  resolveCurrency,
  fuzzyMatch,
  levenshtein,
  type SynonymTable,
} from '../../../src/engine/nlu/synonyms.js'
import type { Currency, Money } from '../../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Hand-written fakes / fixtures. No mocking library: these are plain data.
// ─────────────────────────────────────────────────────────────────────────────

/** A learned synonym table, as it would be loaded from _state/synonyms.json. */
const LEARNED_TABLE: SynonymTable = {
  currency: { ojro: 'EUR', kinta: 'RSD' },
  dimension: { materijal: 'MATERIALS' },
}

/** SMOQUA-ish closed set, per 02 §5.1 "dimensions are a typed map". */
const CATEGORIES = ['MATERIALS', 'MARKETING', 'TRANSPORT']
const CATEGORY_ALIASES: Record<string, string[]> = {
  MATERIALS: ['MATERIJAL', 'materijal'],
  MARKETING: ['MARKETINK'],
}

// ─────────────────────────────────────────────────────────────────────────────
// parseAmount — the confident parses (02 §5 "Amount grammar")
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAmount — amounts it is confident about', () => {
  const confident: Array<[string, number, Currency]> = [
    // plain integers default to the book's ledger currency
    ['4210', 4210, 'RSD'],
    // dot = thousands, comma = decimals (Serbian convention)
    ['4.210,00', 4210, 'RSD'],
    ['1.500', 1500, 'RSD'],
    ['1.234.567,89', 1234567.89, 'RSD'],
    // a lone comma is always the decimal separator
    ['4210,50', 4210.5, 'RSD'],
    ['0,99', 0.99, 'RSD'],
    // a lone dot with exactly two trailing digits is a decimal point
    ['4210.50', 4210.5, 'RSD'],
    // currency glued to the digits
    ['300e', 300, 'EUR'],
    ['300€', 300, 'EUR'],
    ['1500din', 1500, 'RSD'],
    // currency as a separate token
    ['300 €', 300, 'EUR'],
    ['300 eur', 300, 'EUR'],
    ['1.500 rsd', 1500, 'RSD'],
    ['1500 dinara', 1500, 'RSD'],
    ['300,00 EUR', 300, 'EUR'],
    // the synonym table, including the case that motivated it
    ['300 EVRA', 300, 'EUR'],
    ['300 evra', 300, 'EUR'],
    ['300 evro', 300, 'EUR'],
    ['300 eura', 300, 'EUR'],
    // thousands shorthand
    ['12k', 12000, 'RSD'],
    ['12K', 12000, 'RSD'],
    ['12k eur', 12000, 'EUR'],
    // the amount is embedded in a real message (02 §5 shorthand, F3, F4)
    ['MATERIALS 300e', 300, 'EUR'],
    ['/cash 800 parking', 800, 'RSD'],
    ['/expense MARKETING 12000 fb ads', 12000, 'RSD'],
    // surrounding whitespace is noise
    ['  4210  ', 4210, 'RSD'],
  ]

  it.each(confident)('parses %j as %d %s', (input, amount, currency) => {
    expect(parseAmount(input)).toEqual<Money>({ amount, currency })
  })

  it('parses an amount at the top of the valid range without capping it', () => {
    // The 0 < amount < 10,000,000 rule belongs to extract/validate.ts (01 §5),
    // not to the grammar. The grammar reports what was written.
    expect(parseAmount('10.000.000')).toEqual<Money>({ amount: 10000000, currency: 'RSD' })
  })

  it('carries the decimals through exactly rather than re-rounding them', () => {
    expect(parseAmount('4.210,05')).toEqual<Money>({ amount: 4210.05, currency: 'RSD' })
  })
})

describe('parseAmount — the default currency', () => {
  it('falls back to RSD when no currency is written and no default is supplied', () => {
    expect(parseAmount('4210')).toEqual<Money>({ amount: 4210, currency: 'RSD' })
  })

  it('uses the supplied default currency when the message names none', () => {
    expect(parseAmount('4210', 'EUR')).toEqual<Money>({ amount: 4210, currency: 'EUR' })
  })

  it('lets a written currency beat the supplied default', () => {
    expect(parseAmount('1500 din', 'EUR')).toEqual<Money>({ amount: 1500, currency: 'RSD' })
  })

  it('applies the supplied default to the 12k shorthand as well', () => {
    expect(parseAmount('12k', 'EUR')).toEqual<Money>({ amount: 12000, currency: 'EUR' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// parseAmount — the refusals. These are the tests that protect real money.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAmount — refuses rather than half-guessing', () => {
  const refused: Array<[string, string]> = [
    ['', 'the input is empty'],
    ['   ', 'the input is only whitespace'],
    ['tri hiljade', 'the amount is written in words'],
    ['parking', 'there is no number at all'],
    ['/expense', 'the command carries no amount'],
    ['/expense gorivo', 'the description carries no number'],
    ['k', 'the thousands shorthand has no number in front of it'],
    ['12kk', 'the thousands suffix is doubled'],
    ['300e300', 'digits and a currency letter are interleaved'],
    ['20%', 'the number is a percentage, not an amount'],
    ['4,210.50', 'the separators are in Anglo order, not Serbian'],
    ['1.2.3', 'the group sizes are not thousands groups'],
    ['1.2345,00', 'a thousands group is four digits long'],
    ['4.21,0', 'the dot group is two digits and a comma follows it'],
    ['1.500.00', 'the last dot group is two digits, so dot means two things at once'],
    ['11.08.2026', 'the token is a date, not an amount'],
    ['300,555', 'there are three digits after the decimal comma'],
    ['300 evroo', 'the currency word is not in the table and grammar never fuzzy-matches'],
    ['300 xyz', 'the trailing token is an unknown currency'],
    ['-300', 'the amount is signed and direction is not the grammar’s to decide'],
    ['0', 'zero is never a real amount, only a missing one'],
  ]

  it.each(refused)('returns null for %j because %s', (input) => {
    expect(parseAmount(input)).toBeNull()
  })

  it('returns null when the message contains two different candidate amounts', () => {
    expect(parseAmount('300 400 nesto')).toBeNull()
  })

  it('returns null when two amounts carry two different currencies', () => {
    expect(parseAmount('300 eur 400 rsd')).toBeNull()
  })

  it('returns null when one amount is followed by two conflicting currency words', () => {
    expect(parseAmount('300 eur din')).toBeNull()
  })

  it('returns null when the input is absent', () => {
    expect(parseAmount(undefined as unknown as string)).toBeNull()
    expect(parseAmount(null as unknown as string)).toBeNull()
  })

  it('still refuses an unparseable amount when a default currency is supplied', () => {
    // A default currency is a default, never a licence to invent the number.
    expect(parseAmount('tri hiljade', 'EUR')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// formatAmount
// ─────────────────────────────────────────────────────────────────────────────

describe('formatAmount', () => {
  const formatted: Array<[number, string]> = [
    [4210, '4.210,00'],
    [0, '0,00'],
    [0.5, '0,50'],
    [0.05, '0,05'],
    // exactly at the thousands boundary, and exactly below it
    [999, '999,00'],
    [1000, '1.000,00'],
    [1000000, '1.000.000,00'],
    [1234567.89, '1.234.567,89'],
    [-4210, '-4.210,00'],
  ]

  it.each(formatted)('formats %d as %j', (amount, expected) => {
    expect(formatAmount(amount)).toBe(expected)
  })

  it('always shows two decimals even when the amount is whole', () => {
    expect(formatAmount(300)).toBe('300,00')
  })

  it('rounds to two decimals rather than printing a third digit', () => {
    expect(formatAmount(4210.567)).toBe('4.210,57')
  })

  it('round-trips a formatted amount back through the parser', () => {
    expect(parseAmount(formatAmount(4210))).toEqual<Money>({ amount: 4210, currency: 'RSD' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// round2 — half-up, applied per invoice (02 §5, 06 §4)
// ─────────────────────────────────────────────────────────────────────────────

describe('round2', () => {
  const rounded: Array<[number, number]> = [
    [1.234, 1.23],
    [1.236, 1.24],
    [4210, 4210],
    [0, 0],
    [0.005, 0.01],
    [1.005, 1.01],
    [1.235, 1.24],
    [0.125, 0.13],
    [-3.456, -3.46],
    [1e-9, 0],
  ]

  it.each(rounded)('rounds %d to %d', (input, expected) => {
    expect(round2(input)).toBe(expected)
  })

  it('rounds a decimal exactly on the half upward, not to the nearest even', () => {
    expect(round2(2.345)).toBe(2.35)
    expect(round2(2.355)).toBe(2.36)
  })

  it('is idempotent, so folding a ledger twice cannot drift', () => {
    const once = round2(1.005)
    expect(round2(once)).toBe(once)
  })

  it('leaves an already-2dp amount untouched', () => {
    expect(round2(4210.05)).toBe(4210.05)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toRsd
// ─────────────────────────────────────────────────────────────────────────────

describe('toRsd', () => {
  it('converts using the supplied NBS middle rate, to two decimals', () => {
    // 02 §6 F5: 3.000,00 EUR at 117,1043 → 351.312,90 RSD
    expect(toRsd({ amount: 3000, currency: 'EUR' }, 117.1043)).toBe(351312.9)
  })

  it('rounds the converted amount rather than returning full float precision', () => {
    expect(toRsd({ amount: 300, currency: 'EUR' }, 117.1043)).toBe(35131.29)
  })

  it('preserves the sign of an outflow', () => {
    expect(toRsd({ amount: -300, currency: 'EUR' }, 117.1043)).toBe(-35131.29)
  })

  it('returns the same amount for RSD at a rate of one', () => {
    expect(toRsd({ amount: 1000, currency: 'RSD' }, 1)).toBe(1000)
  })

  const badRates: Array<[number | null, string]> = [
    [null, 'the rate is missing'],
    [0, 'the rate is exactly zero'],
    [-1, 'the rate is negative'],
    [-0.0001, 'the rate is negative just below zero'],
    [Number.NaN, 'the rate is not a number'],
    [Number.POSITIVE_INFINITY, 'the rate is not finite'],
  ]

  it.each(badRates)('returns null when the rate is %j because %s', (rate) => {
    expect(toRsd({ amount: 300, currency: 'EUR' }, rate)).toBeNull()
  })

  it('accepts the smallest positive rate rather than treating it as missing', () => {
    expect(toRsd({ amount: 100, currency: 'EUR' }, 0.01)).toBe(1)
  })

  it('converts a zero amount to zero rather than to null', () => {
    // Absence is null; a zero-valued conversion of a zero amount is a fact.
    expect(toRsd({ amount: 0, currency: 'EUR' }, 117.1043)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// normalize
// ─────────────────────────────────────────────────────────────────────────────

describe('normalize', () => {
  const normalized: Array<[string, string]> = [
    ['MATERIALS', 'materials'],
    ['Trošak', 'trosak'],
    ['ŠĐČĆŽ', 'sdccz'],
    ['šđčćž', 'sdccz'],
    ['Materijal   Pamuk', 'materijal pamuk'],
    ['  4.210,00  ', '4.210,00'],
    ['a\tb\nc', 'a b c'],
    ['', ''],
    ['   ', ''],
    ['/EXPENCE', '/expence'],
    ['EVRA', 'evra'],
    ['€', '€'],
  ]

  it.each(normalized)('normalizes %j to %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it('strips a combining diacritic as well as a precomposed one', () => {
    const precomposed = '\u0161tampa'
    const decomposed = 's\u030Ctampa'
    expect(normalize(precomposed)).toBe('stampa')
    expect(normalize(decomposed)).toBe('stampa')
  })

  it('keeps punctuation, because the command parser still needs the slash', () => {
    expect(normalize('/expense MARKETING 12.000,00')).toBe('/expense marketing 12.000,00')
  })

  it('is idempotent', () => {
    const once = normalize('  ŠTAMPA   Materijal ')
    expect(normalize(once)).toBe(once)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveCurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveCurrency', () => {
  const known: Array<[string, Currency]> = [
    ['EVRA', 'EUR'],
    ['evra', 'EUR'],
    ['evro', 'EUR'],
    ['eura', 'EUR'],
    ['€', 'EUR'],
    ['e', 'EUR'],
    ['eur', 'EUR'],
    ['EUR', 'EUR'],
    ['din', 'RSD'],
    ['rsd', 'RSD'],
    ['dinara', 'RSD'],
    ['usd', 'USD'],
    ['chf', 'CHF'],
    ['gbp', 'GBP'],
  ]

  it.each(known)('resolves %j to %s', (token, currency) => {
    expect(resolveCurrency(token)).toBe(currency)
  })

  it('resolves a token that arrives with surrounding whitespace', () => {
    expect(resolveCurrency('  EVRA  ')).toBe('EUR')
  })

  const unknown: Array<[string, string]> = [
    ['', 'the token is empty'],
    ['   ', 'the token is only whitespace'],
    ['evroo', 'a typo is not a synonym — resolution is a lookup, never a guess'],
    ['ev', 'a prefix of a synonym is not a synonym'],
    ['euro dollar', 'two words are not one currency token'],
    ['300', 'digits are not a currency'],
    ['$', 'the symbol is not in the table'],
    ['xyz', 'the token is unrelated'],
  ]

  it.each(unknown)('returns null for %j because %s', (token) => {
    expect(resolveCurrency(token)).toBeNull()
  })

  it('resolves a token learned into a supplied synonym table', () => {
    expect(resolveCurrency('ojro', LEARNED_TABLE)).toBe('EUR')
    expect(resolveCurrency('kinta', LEARNED_TABLE)).toBe('RSD')
  })

  it('normalizes the token before consulting a supplied table', () => {
    expect(resolveCurrency('  OJRO ', LEARNED_TABLE)).toBe('EUR')
  })

  it('returns null for an unknown token even when a table is supplied', () => {
    expect(resolveCurrency('funta', LEARNED_TABLE)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// levenshtein
// ─────────────────────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  const distances: Array<[string, string, number]> = [
    ['', '', 0],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['abc', 'abc', 0],
    ['kitten', 'sitting', 3],
    ['EXPENCE', 'EXPENSE', 1],
    ['MATERIJAAL', 'MATERIJAL', 1],
    ['MATERIJAL', 'MATERIALS', 2],
    ['MATERIJAAL', 'MATERIALS', 3],
    ['MATERIC', 'MATERIALS', 3],
    ['MARKETING', 'MATERIALS', 6],
    ['ab', 'ba', 2],
  ]

  it.each(distances)('reports the distance from %j to %j as %d', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('is symmetric', () => {
    expect(levenshtein('MATERIJAAL', 'MATERIALS')).toBe(levenshtein('MATERIALS', 'MATERIJAAL'))
  })

  it('counts raw characters, leaving case and diacritic folding to the caller', () => {
    expect(levenshtein('materials', 'MATERIALS')).toBe(9)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fuzzyMatch
// ─────────────────────────────────────────────────────────────────────────────

describe('fuzzyMatch', () => {
  it('returns the canonical value for an exact token', () => {
    expect(fuzzyMatch('MATERIALS', CATEGORIES)).toBe('MATERIALS')
  })

  it('matches case-insensitively', () => {
    expect(fuzzyMatch('materials', CATEGORIES)).toBe('MATERIALS')
  })

  it('matches diacritic-insensitively', () => {
    expect(fuzzyMatch('stampa', ['ŠTAMPA', 'TRANSPORT'])).toBe('ŠTAMPA')
  })

  it('returns the canonical value, not the alias that matched', () => {
    expect(fuzzyMatch('MATERIJAL', CATEGORIES, CATEGORY_ALIASES)).toBe('MATERIALS')
  })

  it('resolves MATERIJAAL to MATERIALS through the alias list', () => {
    // 02 §5.1: MATERIJAAL is one edit from the alias MATERIJAL, three from
    // MATERIALS itself — which is exactly why the alias list exists.
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES, CATEGORY_ALIASES)).toBe('MATERIALS')
  })

  it('returns null for MATERIJAAL when no alias list is supplied', () => {
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES)).toBeNull()
  })

  it('matches at a distance of exactly two, the default limit', () => {
    expect(fuzzyMatch('MATERIJAL', CATEGORIES)).toBe('MATERIALS')
  })

  it('refuses at a distance of exactly three, one past the default limit', () => {
    expect(fuzzyMatch('MATERIC', CATEGORIES)).toBeNull()
  })

  it('matches at a raised maxDistance that admits the same token', () => {
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES, undefined, 3)).toBe('MATERIALS')
  })

  it('accepts only exact tokens when maxDistance is exactly zero', () => {
    expect(fuzzyMatch('MATERIALS', CATEGORIES, undefined, 0)).toBe('MATERIALS')
    expect(fuzzyMatch('MATERIAL', CATEGORIES, undefined, 0)).toBeNull()
  })

  it('returns null when two candidates sit at the same distance', () => {
    expect(fuzzyMatch('HRANI', ['HRANA', 'HRANE'])).toBeNull()
  })

  it('returns null when two candidates tie through their aliases', () => {
    expect(
      fuzzyMatch('DECU', ['HRANA', 'ZABAVA'], { HRANA: ['DECA'], ZABAVA: ['DECO'] }),
    ).toBeNull()
  })

  it('prefers the exact candidate over a candidate one edit away', () => {
    expect(fuzzyMatch('HRANA', ['HRANA', 'HRANE'])).toBe('HRANA')
  })

  it('prefers the nearer candidate when the distances differ', () => {
    expect(fuzzyMatch('MARKETINK', CATEGORIES)).toBe('MARKETING')
  })

  const noMatch: Array<[string, string[], string]> = [
    ['', CATEGORIES, 'the token is empty'],
    ['   ', CATEGORIES, 'the token is only whitespace'],
    ['MATERIALS', [], 'the candidate set is empty'],
    ['', [], 'both the token and the candidate set are empty'],
    ['GORIVO', CATEGORIES, 'nothing in the closed set is close'],
    ['X', CATEGORIES, 'a single letter is far from every candidate'],
  ]

  it.each(noMatch)('returns null for %j against %j because %s', (token, candidates) => {
    expect(fuzzyMatch(token, candidates)).toBeNull()
  })

  it('returns null for an absent token rather than throwing', () => {
    expect(fuzzyMatch(undefined as unknown as string, CATEGORIES)).toBeNull()
  })

  it('ignores an alias entry whose canonical value is not in the candidate set', () => {
    // The closed set is the authority; a stale alias must not smuggle a value in.
    expect(fuzzyMatch('MATERIJAL', ['MARKETING'], CATEGORY_ALIASES)).toBeNull()
  })

  it('matches a token that arrives with surrounding whitespace', () => {
    expect(fuzzyMatch('  materials  ', CATEGORIES)).toBe('MATERIALS')
  })
})
