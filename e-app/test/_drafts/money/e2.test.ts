import { describe, it, expect } from 'vitest'

import { parseAmount, formatAmount, round2, toRsd } from '../../../src/core/money.js'
import {
  normalize,
  resolveCurrency,
  fuzzyMatch,
  levenshtein,
  type SynonymTable,
} from '../../../src/core/nlu/synonyms.js'
import type { Currency, Money } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fixtures. No mocking library; these modules take no injected
// dependencies, so everything below is a plain literal.
// ---------------------------------------------------------------------------

const eur = (amount: number): Money => ({ amount, currency: 'EUR' })
const rsd = (amount: number): Money => ({ amount, currency: 'RSD' })

/** A learned table, as 02 §5.1 describes ("Zapamti: EVRA = EUR" grows this). */
const LEARNED_TABLE: SynonymTable = {
  currency: { kinta: 'CHF', kes: 'USD' },
  dimension: { materijal: 'MATERIALS' },
}

/** SMOQUA-shaped closed set, per 02 §5.1 "Dimensions are a typed map". */
const DIMENSION_VALUES = ['MATERIALS', 'MARKETING', 'TRANSPORT']
const DIMENSION_ALIASES: Record<string, string[]> = {
  MATERIALS: ['MATERIJAL', 'MATERIJALI'],
  MARKETING: ['REKLAMA'],
  TRANSPORT: ['PREVOZ'],
}

// ===========================================================================
// parseAmount — the Serbian number grammar (02 §5 "Amount grammar")
// ===========================================================================

describe('parseAmount', () => {
  describe('numeric forms', () => {
    it.each<[string, number]>([
      ['4210', 4210],
      ['4.210,00', 4210],
      ['4210,50', 4210.5],
    ])('parses the canonical form %s as %d in the book default currency', (input, expected) => {
      expect(parseAmount(input)).toEqual(rsd(expected))
    })

    it('reads a dot before exactly three digits as a thousands separator', () => {
      expect(parseAmount('1.500')).toEqual(rsd(1500))
    })

    it('reads a dot before exactly two digits as a decimal separator', () => {
      expect(parseAmount('4210.50')).toEqual(rsd(4210.5))
    })

    it('reads a dot before a single digit as a decimal separator', () => {
      // No thousands group is one digit long, so there is only one reading.
      expect(parseAmount('1.5')).toEqual(rsd(1.5))
    })

    it.each<[string, number]>([
      ['1.234.567', 1234567],
      ['1.234.567,89', 1234567.89],
      ['10.000.000,00', 10000000],
      ['12.345', 12345],
      ['12.34', 12.34],
      ['0,50', 0.5],
      ['999', 999],
      ['1000', 1000],
    ])('parses %s as %d', (input, expected) => {
      expect(parseAmount(input)).toEqual(rsd(expected))
    })

    it('parses a total at the validator ceiling — bounds are validate.ts, not the grammar', () => {
      // 01 §5 "Validation and failure" owns 0 < amount < 10,000,000. The grammar
      // reports what was written; rejecting it is a separate layer's decision.
      expect(parseAmount('12.000.000,00')).toEqual(rsd(12000000))
    })

    it('tolerates surrounding whitespace', () => {
      expect(parseAmount('  4.210,00  ')).toEqual(rsd(4210))
    })
  })

  describe('the k multiplier', () => {
    it.each<[string, number]>([
      ['12k', 12000],
      ['12K', 12000],
      ['1k', 1000],
      ['100k', 100000],
    ])('parses %s as %d RSD', (input, expected) => {
      expect(parseAmount(input)).toEqual(rsd(expected))
    })

    it('applies the k multiplier under an explicit currency', () => {
      expect(parseAmount('12k eur')).toEqual(eur(12000))
    })
  })

  describe('currency synonyms attached to an amount', () => {
    it.each<[string, Money]>([
      ['300e', eur(300)],
      ['300€', eur(300)],
      ['€300', eur(300)],
      ['300 eur', eur(300)],
      ['300 EUR', eur(300)],
      ['300 EVRA', eur(300)],
      ['300 evra', eur(300)],
      ['300 evro', eur(300)],
      ['300 eura', eur(300)],
      ['1500din', rsd(1500)],
      ['1500 DIN', rsd(1500)],
      ['1.500 rsd', rsd(1500)],
      ['1500 dinara', rsd(1500)],
      ['200E', eur(200)],
    ])('parses %s as the expected money', (input, expected) => {
      expect(parseAmount(input)).toEqual(expected)
    })

    it('combines the Serbian number grammar with a currency word', () => {
      expect(parseAmount('4.210,00 EUR')).toEqual(eur(4210))
    })
  })

  describe('the default currency argument', () => {
    it('falls back to RSD when no default currency is supplied', () => {
      expect(parseAmount('4210')).toEqual(rsd(4210))
    })

    it.each<[Currency]>([['EUR'], ['USD'], ['CHF'], ['GBP'], ['RSD']])(
      'stamps a bare number with the supplied default currency %s',
      (currency) => {
        expect(parseAmount('4210', currency)).toEqual({ amount: 4210, currency })
      },
    )

    it('lets an explicit currency token beat the default currency', () => {
      // The book is RSD, the message said euros. The message wins.
      expect(parseAmount('300e', 'RSD')).toEqual(eur(300))
    })

    it('does not let the default currency rescue an unparseable amount', () => {
      expect(parseAmount('tri hiljade', 'EUR')).toBeNull()
    })
  })

  describe('deliberate refusals — it returns nothing rather than half-guessing', () => {
    it('returns null for an empty string', () => {
      expect(parseAmount('')).toBeNull()
    })

    it('returns null for whitespace only', () => {
      expect(parseAmount('   \t\n ')).toBeNull()
    })

    it('returns null when the input is absent', () => {
      expect(parseAmount(null as unknown as string)).toBeNull()
      expect(parseAmount(undefined as unknown as string)).toBeNull()
    })

    it('returns null for an amount written in words', () => {
      // 02 §5: "tri hiljade" is exactly the case that must fall through to the model.
      expect(parseAmount('tri hiljade')).toBeNull()
    })

    it('returns null when two candidate amounts are present', () => {
      // 02 §5.1 confirm policy: conflicting slots are asked about, never merged.
      expect(parseAmount('300 400')).toBeNull()
    })

    it('returns null when two different currencies are named', () => {
      expect(parseAmount('300 eur din')).toBeNull()
    })

    it('returns null for a currency suffix that is not in the synonym table', () => {
      // E asks. It never silently defaults an unknown unit to the book currency.
      expect(parseAmount('300kn')).toBeNull()
    })

    it.each<[string, string]>([
      ['abc', 'no digits at all'],
      ['1.5000', 'a dot before four digits is neither a thousands group nor a decimal'],
      ['1.23.456', 'a malformed thousands grouping'],
      ['1,234.56', 'the anglo-saxon convention, which inverts both separators'],
      ['4.210,00,50', 'two decimal separators'],
      ['1..500', 'a doubled separator'],
      ['.', 'a lone separator'],
      [',50', 'a decimal with no integer part and no clear intent'],
      ['-300', 'a signed amount — direction is a separate field, not part of the grammar'],
      ['300-', 'a trailing sign'],
      ['12kk', 'a doubled multiplier'],
      ['NaN', 'a non-numeric literal'],
      ['Infinity', 'a non-finite literal'],
      ['0x1F', 'a hexadecimal literal'],
      ['1e3', 'exponent notation, which collides with the "e" euro suffix'],
    ])('returns null for %s — %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it('returns null for zero, because absence is never expressed as a zero amount', () => {
      // types.ts on Money: "Absence is expressed by returning null, never by a zero."
      expect(parseAmount('0')).toBeNull()
      expect(parseAmount('0,00 rsd')).toBeNull()
    })
  })

  it('returns a plain data value, so nothing downstream can be tempted to overwrite it', () => {
    const parsed = parseAmount('200E')
    expect(parsed).toEqual({ amount: 200, currency: 'EUR' })
    // Same input, same answer, every time — 01 §5 mechanism 3.
    expect(parseAmount('200E')).toEqual(parsed)
  })
})

// ===========================================================================
// formatAmount — Serbian display, always two decimals (02 §1 receipt line)
// ===========================================================================

describe('formatAmount', () => {
  it.each<[number, string]>([
    [4210, '4.210,00'],
    [4210.5, '4.210,50'],
    [0, '0,00'],
    [0.5, '0,50'],
    [0.05, '0,05'],
    [1234567.89, '1.234.567,89'],
    [35130, '35.130,00'],
    [800, '800,00'],
    [200, '200,00'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatAmount(input)).toBe(expected)
  })

  it('formats exactly at the first grouping boundary', () => {
    expect(formatAmount(999.99)).toBe('999,99')
    expect(formatAmount(1000)).toBe('1.000,00')
  })

  it('formats exactly at the second grouping boundary', () => {
    expect(formatAmount(999999)).toBe('999.999,00')
    expect(formatAmount(1000000)).toBe('1.000.000,00')
  })

  it('keeps the minus sign in front of a negative amount', () => {
    expect(formatAmount(-4210)).toBe('-4.210,00')
  })

  it('rounds to two decimals rather than printing more', () => {
    expect(formatAmount(4210.567)).toBe('4.210,57')
    expect(formatAmount(4210.564)).toBe('4.210,56')
  })

  it('round-trips the receipt example from the spec', () => {
    const parsed = parseAmount('4.210,00')
    expect(parsed).not.toBeNull()
    expect(formatAmount(parsed!.amount)).toBe('4.210,00')
  })
})

// ===========================================================================
// round2 — half-up, applied per invoice
// ===========================================================================

describe('round2', () => {
  it.each<[number, number]>([
    [4210, 4210],
    [0, 0],
    [4210.564, 4210.56],
    [4210.565, 4210.57],
    [4210.566, 4210.57],
    [-4210.126, -4210.13],
    [1234567.891, 1234567.89],
  ])('rounds %d to %d', (input, expected) => {
    expect(round2(input)).toBe(expected)
  })

  it('rounds a decimal half up even when binary floating point sits just below it', () => {
    // 2.675 and 1.005 are the classic traps: naive n*100 rounding yields 2.67 / 1.00.
    expect(round2(2.675)).toBe(2.68)
    expect(round2(1.005)).toBe(1.01)
  })

  it('is idempotent', () => {
    expect(round2(round2(4210.565))).toBe(round2(4210.565))
  })

  it('leaves an already-two-decimal value untouched', () => {
    expect(round2(35130.25)).toBe(35130.25)
  })
})

// ===========================================================================
// toRsd — conversion with an explicit rate
// ===========================================================================

describe('toRsd', () => {
  it('converts euros at the supplied rate', () => {
    // 02 §5 F4: 300,00 EUR ≈ 35.130,00 RSD.
    expect(toRsd(eur(300), 117.1)).toBe(35130)
  })

  it('rounds the converted result to two decimals', () => {
    expect(toRsd(eur(300), 117.1234)).toBe(35137.02)
  })

  it('returns the same amount for RSD at a rate of 1', () => {
    expect(toRsd(rsd(4210), 1)).toBe(4210)
  })

  it('returns null when the rate is missing', () => {
    // No rate means no number — never a silent 1:1 fallback.
    expect(toRsd(eur(300), null)).toBeNull()
  })

  it.each<[number, string]>([
    [0, 'zero'],
    [-1, 'negative'],
    [-117.1, 'negative even when plausible in magnitude'],
    [Number.NaN, 'not a number'],
  ])('returns null when the rate is %d (%s)', (rate) => {
    expect(toRsd(eur(300), rate)).toBeNull()
  })

  it('converts a zero amount to zero when the rate is valid', () => {
    expect(toRsd(eur(0), 117.1)).toBe(0)
  })

  it('preserves the sign of an outflow', () => {
    expect(toRsd(eur(-300), 117.1)).toBe(-35130)
  })
})

// ===========================================================================
// normalize — the shared normalizer (02 §8: input needs no diacritics)
// ===========================================================================

describe('normalize', () => {
  it('strips the Serbian latin diacritics', () => {
    expect(normalize('šđčćž')).toBe('sdccz')
  })

  it('strips the uppercase Serbian diacritics and lowercases them', () => {
    expect(normalize('ŠĐČĆŽ')).toBe('sdccz')
  })

  it('handles Đ, which unicode decomposition alone does not split', () => {
    // U+0110 / U+0111 have no combining-mark decomposition — they need a map.
    expect(normalize('Đorđe')).toBe('dorde')
  })

  it('treats a precomposed and a combining-mark spelling identically', () => {
    expect(normalize('trošak')).toBe(normalize('trošak'))
    expect(normalize('trošak')).toBe('trosak')
  })

  it.each<[string, string]>([
    ['EVRA', 'evra'],
    ['MATERIJAAL', 'materijaal'],
    ['  MATERIJAAL   PAMUK  ', 'materijaal pamuk'],
    ['a\tb\nc', 'a b c'],
    ['a    b', 'a b'],
    ['Račun', 'racun'],
    ['ČAČAK', 'cacak'],
    ['already normal', 'already normal'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it('returns an empty string for an empty string', () => {
    expect(normalize('')).toBe('')
  })

  it('returns an empty string for whitespace only', () => {
    expect(normalize('   \t\n  ')).toBe('')
  })

  it('is idempotent', () => {
    expect(normalize(normalize('  ŠĐČĆŽ  Račun '))).toBe(normalize('  ŠĐČĆŽ  Račun '))
  })
})

// ===========================================================================
// resolveCurrency — deterministic, never a silent default
// ===========================================================================

describe('resolveCurrency', () => {
  it.each<[string]>([
    ['EVRA'],
    ['evra'],
    ['evro'],
    ['eura'],
    ['€'],
    ['e'],
    ['E'],
    ['eur'],
    ['EUR'],
  ])('resolves %s to EUR', (token) => {
    expect(resolveCurrency(token)).toBe('EUR')
  })

  it.each<[string]>([['din'], ['DIN'], ['rsd'], ['RSD'], ['dinara'], ['Dinara']])(
    'resolves %s to RSD',
    (token) => {
      expect(resolveCurrency(token)).toBe('RSD')
    },
  )

  it.each<[string, Currency]>([
    ['usd', 'USD'],
    ['USD', 'USD'],
    ['chf', 'CHF'],
    ['gbp', 'GBP'],
  ])('resolves the ISO code %s to %s', (token, expected) => {
    expect(resolveCurrency(token)).toBe(expected)
  })

  it('ignores surrounding whitespace on the token', () => {
    expect(resolveCurrency('  EVRA  ')).toBe('EUR')
  })

  it.each<[string]>([['xyz'], ['kn'], ['dolar'], ['money'], ['1500'], ['€€']])(
    'returns null for the unknown token %s',
    (token) => {
      expect(resolveCurrency(token)).toBeNull()
    },
  )

  it('returns null for an empty token rather than defaulting to the book currency', () => {
    expect(resolveCurrency('')).toBeNull()
    expect(resolveCurrency('   ')).toBeNull()
  })

  it('returns null for an absent token', () => {
    expect(resolveCurrency(null as unknown as string)).toBeNull()
  })

  it('resolves a token learned into a supplied synonym table', () => {
    expect(resolveCurrency('kinta', LEARNED_TABLE)).toBe('CHF')
  })

  it('normalizes the token before looking it up in a supplied table', () => {
    expect(resolveCurrency('  KINTA ', LEARNED_TABLE)).toBe('CHF')
  })

  it('still returns null for a token absent from the supplied table', () => {
    expect(resolveCurrency('bitcoin', LEARNED_TABLE)).toBeNull()
  })
})

// ===========================================================================
// levenshtein — the primitive behind command and dimension matching
// ===========================================================================

describe('levenshtein', () => {
  it.each<[string, string, number]>([
    ['', '', 0],
    ['abc', 'abc', 0],
    ['a', '', 1],
    ['', 'abc', 3],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['expence', 'expense', 1],
    ['troshak', 'trosak', 1],
    ['abc', 'abd', 1],
    ['abc', 'axc', 1],
  ])('reports distance %s -> %s as %d', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('counts a transposition as two edits, not one', () => {
    // Plain Levenshtein, not Damerau — the spec says Levenshtein, and the
    // difference decides whether some near-ties are ties at all.
    expect(levenshtein('ab', 'ba')).toBe(2)
  })

  it('reports MATERIJAAL against MATERIALS as three edits', () => {
    // Worth pinning: this is over the default maxDistance of 2, which is why
    // 02 §5.1 matches MATERIJAAL against the *alias* list, not the canonical.
    expect(levenshtein('materijaal', 'materials')).toBe(3)
  })

  it('is symmetric', () => {
    expect(levenshtein('materijaal', 'materials')).toBe(
      levenshtein('materials', 'materijaal'),
    )
  })
})

// ===========================================================================
// fuzzyMatch — deterministic closed-set matching that refuses to guess
// ===========================================================================

describe('fuzzyMatch', () => {
  it('matches an exact token to its canonical value', () => {
    expect(fuzzyMatch('MATERIALS', DIMENSION_VALUES)).toBe('MATERIALS')
  })

  it('matches case-insensitively and returns the canonical spelling', () => {
    expect(fuzzyMatch('materials', DIMENSION_VALUES)).toBe('MATERIALS')
  })

  it('matches diacritic-insensitively and returns the canonical spelling', () => {
    expect(fuzzyMatch('troskovi', ['TROŠKOVI', 'MARKETING'])).toBe('TROŠKOVI')
  })

  it('ignores surrounding whitespace on the token', () => {
    expect(fuzzyMatch('  materials  ', DIMENSION_VALUES)).toBe('MATERIALS')
  })

  it.each<[string]>([['MATERIALZ'], ['MATERIAL'], ['MTERIALS'], ['MATERIALSS']])(
    'matches the single-edit typo %s to MATERIALS',
    (token) => {
      expect(fuzzyMatch(token, DIMENSION_VALUES)).toBe('MATERIALS')
    },
  )

  it('matches MATERIJAAL to MATERIALS through the alias list', () => {
    // 02 §5.1: MATERIJAAL is one edit from the alias MATERIJAL, and the alias
    // carries it to the canonical value. No model call needed.
    expect(fuzzyMatch('MATERIJAAL', DIMENSION_VALUES, DIMENSION_ALIASES)).toBe('MATERIALS')
  })

  it('returns the canonical value, not the alias that matched', () => {
    expect(fuzzyMatch('REKLAMA', DIMENSION_VALUES, DIMENSION_ALIASES)).toBe('MARKETING')
  })

  it('declines MATERIJAAL when there is no alias list to bridge the gap', () => {
    // Three edits from MATERIALS — over the default budget, so E asks.
    expect(fuzzyMatch('MATERIJAAL', DIMENSION_VALUES)).toBeNull()
  })

  it('matches MATERIJAAL to MATERIALS with no aliases once maxDistance is raised to 3', () => {
    expect(fuzzyMatch('MATERIJAAL', DIMENSION_VALUES, undefined, 3)).toBe('MATERIALS')
  })

  describe('the distance budget, exactly', () => {
    it('accepts a token at exactly the default distance of 2', () => {
      expect(fuzzyMatch('MATERIALXY', ['MATERIALS'])).toBe('MATERIALS')
    })

    it('rejects a token at exactly one past the default distance', () => {
      expect(fuzzyMatch('MATERIALXYZ', ['MATERIALS'])).toBeNull()
    })

    it('accepts a token at exactly the supplied maxDistance', () => {
      expect(fuzzyMatch('MATERIALX', ['MATERIALS'], undefined, 1)).toBe('MATERIALS')
    })

    it('rejects a token at exactly one past the supplied maxDistance', () => {
      expect(fuzzyMatch('MATERIALXY', ['MATERIALS'], undefined, 1)).toBeNull()
    })

    it('accepts only an exact match when maxDistance is 0', () => {
      expect(fuzzyMatch('MATERIALS', DIMENSION_VALUES, undefined, 0)).toBe('MATERIALS')
      expect(fuzzyMatch('MATERIALX', DIMENSION_VALUES, undefined, 0)).toBeNull()
    })
  })

  describe('deliberate refusals — a tie is a question, not a coin flip', () => {
    it('returns null when two candidates sit at the same distance', () => {
      expect(fuzzyMatch('MATERIALX', ['MATERIALS', 'MATERIALE'])).toBeNull()
    })

    it('returns null when the tie is between a canonical value and another value alias', () => {
      expect(
        fuzzyMatch('PREVOZI', ['TRANSPORT', 'PREVOZE'], { TRANSPORT: ['PREVOZ'] }),
      ).toBeNull()
    })

    it('picks the strictly closer candidate when the distances differ', () => {
      expect(fuzzyMatch('MATERIALS', ['MATERIALS', 'MATERIALE'])).toBe('MATERIALS')
      expect(fuzzyMatch('MATERIALE', ['MATERIALS', 'MATERIALE'])).toBe('MATERIALE')
    })

    it('is not ambiguous when two aliases of the same canonical value tie', () => {
      // Ambiguity is about the answer, not about how many routes reach it.
      expect(
        fuzzyMatch('MATERIJALX', ['MATERIALS'], { MATERIALS: ['MATERIJAL', 'MATERIJALI'] }),
      ).toBe('MATERIALS')
    })

    it('returns null when nothing is within the budget', () => {
      expect(fuzzyMatch('PAMUK', DIMENSION_VALUES, DIMENSION_ALIASES)).toBeNull()
    })

    it('returns null for an empty candidate set', () => {
      expect(fuzzyMatch('MATERIALS', [])).toBeNull()
    })

    it('returns null for an empty token', () => {
      expect(fuzzyMatch('', DIMENSION_VALUES)).toBeNull()
      expect(fuzzyMatch('   ', DIMENSION_VALUES)).toBeNull()
    })

    it('returns null for an absent token', () => {
      expect(fuzzyMatch(null as unknown as string, DIMENSION_VALUES)).toBeNull()
    })
  })

  it('resolves a slash command typo without a model call', () => {
    // 02 §5.1 "Commands still get deterministic fuzzy matching", Levenshtein ≤ 1.
    const commands = ['expense', 'invoice', 'pending', 'report', 'status', 'help']
    expect(fuzzyMatch('expence', commands, { expense: ['trosak'] }, 1)).toBe('expense')
    expect(fuzzyMatch('troshak', commands, { expense: ['trosak'] }, 1)).toBe('expense')
  })
})
