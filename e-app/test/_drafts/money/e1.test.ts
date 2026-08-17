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

// ---------------------------------------------------------------------------
// Hand-written fakes / fixtures. No mocking library anywhere in this file.
// ---------------------------------------------------------------------------

/** A hand-written synonym table with tokens the built-in table cannot know. */
const CUSTOM_TABLE: SynonymTable = {
  currency: {
    bak: 'USD',
    kinta: 'CHF',
    funta: 'GBP',
  },
  dimension: {
    roba: 'MATERIALS',
  },
}

/** The closed set a SMOQUA book declares for its `category` axis. */
const CATEGORIES = ['MATERIALS', 'MARKETING', 'TRANSPORT', 'SERVICES']

/** canonical -> accepted aliases, the shape `DimensionAxisDef.aliases` uses. */
const CATEGORY_ALIASES: Record<string, string[]> = {
  MATERIALS: ['MATERIJAL', 'ROBA'],
  MARKETING: ['REKLAMA'],
  TRANSPORT: ['PREVOZ'],
}

const rsd = (amount: number): Money => ({ amount, currency: 'RSD' })
const eur = (amount: number): Money => ({ amount, currency: 'EUR' })

// ===========================================================================
// normalize — the shared normalizer every other function is built on
// ===========================================================================

describe('normalize', () => {
  it.each([
    ['ŠĐČĆŽ', 'sdccz'],
    ['šđčćž', 'sdccz'],
    ['Račun', 'racun'],
    ['TROŠAK', 'trosak'],
    ['Đorđe', 'dorde'],
    ['MATERIJAAL', 'materijaal'],
    ['EVRA', 'evra'],
  ])('strips diacritics and lowercases %j to %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it.each([
    ['  MATERIJAAL   PAMUK  ', 'materijaal pamuk'],
    ['a\tb', 'a b'],
    ['a\nb', 'a b'],
    ['a b', 'a b'],
    ['   ', ''],
    ['', ''],
  ])('collapses whitespace in %j to %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it('maps š and ž to distinct base letters rather than to the same one', () => {
    expect(normalize('šž')).toBe('sz')
  })

  it('collapses ć and č onto the same base letter, so they cannot be told apart afterwards', () => {
    expect(normalize('ć')).toBe(normalize('č'))
    expect(normalize('ć')).toBe('c')
  })

  it('normalises decomposed input the same as precomposed input', () => {
    // "s" + U+030C combining caron must land on the same token as the
    // precomposed U+0161.
    expect(normalize('\u0073\u030C')).toBe('s')
    expect(normalize('\u0073\u030C')).toBe(normalize('\u0161'))
  })

  it('is idempotent, so normalising an already-normalised token changes nothing', () => {
    const once = normalize('  ŠTAMPAČ   Račun ')
    expect(normalize(once)).toBe(once)
  })

  it('leaves digits and currency symbols intact', () => {
    expect(normalize('300€')).toBe('300€')
  })
})

// ===========================================================================
// levenshtein — the primitive fuzzy matching is built on
// ===========================================================================

describe('levenshtein', () => {
  it.each([
    ['', '', 0],
    ['a', '', 1],
    ['', 'abc', 3],
    ['abc', 'abc', 0],
    ['abc', 'abd', 1],
    ['kitten', 'sitting', 3],
    ['expence', 'expense', 1],
    ['troshak', 'trosak', 1],
    ['evra', 'eura', 1],
    ['book', 'back', 2],
    ['flaw', 'lawn', 2],
  ])('reports distance %j -> %j as %i', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('is symmetric', () => {
    expect(levenshtein('materijal', 'materials')).toBe(levenshtein('materials', 'materijal'))
  })

  it('reports MATERIJAAL as distance 1 from the Serbian alias MATERIJAL', () => {
    expect(levenshtein('materijaal', 'materijal')).toBe(1)
  })

  it('reports MATERIJAAL as distance 3 from the English canonical MATERIALS', () => {
    // The spec's "MATERIJAAL -> MATERIALS at edit distance <= 2" only holds
    // via the alias list; the raw distance to the canonical is 3.
    expect(levenshtein('materijaal', 'materials')).toBe(3)
  })

  it('does not lowercase or strip diacritics on its own', () => {
    // Case-insensitivity is fuzzyMatch's job, applied via normalize().
    expect(levenshtein('ABC', 'abc')).toBe(3)
  })
})

// ===========================================================================
// resolveCurrency — deterministic, never a silent default
// ===========================================================================

describe('resolveCurrency', () => {
  it.each([
    'EUR',
    'eur',
    'Eur',
    'e',
    'E',
    '€',
    'EVRA',
    'evra',
    'Evra',
    'evro',
    'eura',
    ' eur ',
  ])('resolves %j to EUR', (token) => {
    expect(resolveCurrency(token)).toBe('EUR')
  })

  it.each(['RSD', 'rsd', 'din', 'DIN', 'Din', 'dinara', 'DINARA', ' rsd '])(
    'resolves %j to RSD',
    (token) => {
      expect(resolveCurrency(token)).toBe('RSD')
    },
  )

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['xyz', 'nonsense'],
    ['evrica', 'a near-miss that is not a known synonym'],
    ['euro-ish', 'punctuated nonsense'],
    ['300', 'a bare number'],
  ])('returns null for %j (%s) rather than defaulting', (token) => {
    expect(resolveCurrency(token)).toBeNull()
  })

  it('returns null for an absent token instead of throwing', () => {
    expect(resolveCurrency(undefined as unknown as string)).toBeNull()
  })

  it('resolves a token supplied only by an injected synonym table', () => {
    expect(resolveCurrency('bak', CUSTOM_TABLE)).toBe('USD')
    expect(resolveCurrency('kinta', CUSTOM_TABLE)).toBe('CHF')
    expect(resolveCurrency('funta', CUSTOM_TABLE)).toBe('GBP')
  })

  it('still returns null for an unknown token when a table is supplied', () => {
    expect(resolveCurrency('zzz', CUSTOM_TABLE)).toBeNull()
  })

  it('applies the shared normalizer to injected table lookups', () => {
    expect(resolveCurrency('  BAK  ', CUSTOM_TABLE)).toBe('USD')
  })
})

// ===========================================================================
// fuzzyMatch — matches or refuses, never guesses between two candidates
// ===========================================================================

describe('fuzzyMatch', () => {
  it('returns the exact candidate at distance 0', () => {
    expect(fuzzyMatch('MATERIALS', CATEGORIES)).toBe('MATERIALS')
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('materials', CATEGORIES)).toBe('MATERIALS')
  })

  it('is diacritic-insensitive', () => {
    expect(fuzzyMatch('TROŠAK', ['TROSAK', 'MARKETING'])).toBe('TROSAK')
  })

  it('returns the canonical value, not the alias, when an alias matches', () => {
    expect(fuzzyMatch('ROBA', CATEGORIES, CATEGORY_ALIASES)).toBe('MATERIALS')
  })

  it('matches MATERIJAAL to MATERIALS through the MATERIJAL alias at distance 1', () => {
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES, CATEGORY_ALIASES)).toBe('MATERIALS')
  })

  it('returns null for MATERIJAAL without the alias list, because the raw distance is 3', () => {
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES)).toBeNull()
  })

  it('matches MATERIJAAL to MATERIALS directly once maxDistance is raised to 3', () => {
    expect(fuzzyMatch('MATERIJAAL', CATEGORIES, undefined, 3)).toBe('MATERIALS')
  })

  it('accepts a candidate at exactly the default maximum distance of 2', () => {
    // levenshtein('materijal','materials') === 2
    expect(fuzzyMatch('MATERIJAL', CATEGORIES)).toBe('MATERIALS')
  })

  it('accepts a candidate at exactly a custom maxDistance', () => {
    expect(fuzzyMatch('abc', ['abd'], undefined, 1)).toBe('abd')
  })

  it('rejects a candidate one step beyond a custom maxDistance', () => {
    expect(fuzzyMatch('abc', ['add'], undefined, 1)).toBeNull()
  })

  it('accepts only exact matches when maxDistance is 0', () => {
    expect(fuzzyMatch('MATERIALS', CATEGORIES, undefined, 0)).toBe('MATERIALS')
    expect(fuzzyMatch('MATERIAL', CATEGORIES, undefined, 0)).toBeNull()
  })

  it('returns null when two candidates sit at the same distance', () => {
    expect(fuzzyMatch('abc', ['abd', 'abe'])).toBeNull()
  })

  it('returns null when a tie is created by an alias of a different canonical value', () => {
    expect(
      fuzzyMatch('abd', ['abc', 'zzz'], { zzz: ['abe'] }),
    ).toBeNull()
  })

  it('prefers an exact match over a nearby candidate rather than calling it a tie', () => {
    expect(fuzzyMatch('abc', ['abc', 'abd'])).toBe('abc')
  })

  it('prefers the nearer candidate when distances differ', () => {
    expect(fuzzyMatch('abc', ['abd', 'zzz'])).toBe('abd')
  })

  it('returns null when no candidate is within range', () => {
    expect(fuzzyMatch('QQQQQQQQ', CATEGORIES)).toBeNull()
  })

  it('returns null for an empty candidate set', () => {
    expect(fuzzyMatch('MATERIALS', [])).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ])('returns null for a %j token (%s)', (token) => {
    expect(fuzzyMatch(token, CATEGORIES)).toBeNull()
  })

  it('returns null for an absent token instead of throwing', () => {
    expect(fuzzyMatch(undefined as unknown as string, CATEGORIES)).toBeNull()
  })
})

// ===========================================================================
// parseAmount — the module where a silently wrong answer costs real money
// ===========================================================================

describe('parseAmount — the documented grammar', () => {
  it.each<[string, Money]>([
    ['4210', rsd(4210)],
    ['4.210,00', rsd(4210)],
    ['4210.50', rsd(4210.5)],
    ['300e', eur(300)],
    ['300€', eur(300)],
    ['300 eur', eur(300)],
    ['1500din', rsd(1500)],
    ['1.500 rsd', rsd(1500)],
    ['12k', rsd(12000)],
    ['300 EVRA', eur(300)],
    ['300 evra', eur(300)],
    ['300 evro', eur(300)],
  ])('parses %j exactly as the spec table says', (input, expected) => {
    expect(parseAmount(input)).toEqual(expected)
  })
})

describe('parseAmount — Serbian separator disambiguation', () => {
  it.each<[string, number]>([
    ['4.210', 4210],
    ['12.000', 12000],
    ['1.234.567', 1234567],
    ['1.000.000', 1000000],
  ])('reads a dot followed by exactly three digits as a thousands separator: %j', (input, n) => {
    expect(parseAmount(input)).toEqual(rsd(n))
  })

  it.each<[string, number]>([
    ['4210.50', 4210.5],
    ['4210.5', 4210.5],
    ['0.99', 0.99],
    ['1.23', 1.23],
  ])('reads a dot followed by one or two digits as a decimal point: %j', (input, n) => {
    expect(parseAmount(input)).toEqual(rsd(n))
  })

  it.each<[string, number]>([
    ['4210,50', 4210.5],
    ['4210,5', 4210.5],
    ['4.210,00', 4210],
    ['1.234.567,89', 1234567.89],
    ['0,01', 0.01],
  ])('always reads a comma as the decimal separator: %j', (input, n) => {
    expect(parseAmount(input)).toEqual(rsd(n))
  })

  it('reads 4.210,00 and 4210.50 differently, which is the whole point of the module', () => {
    expect(parseAmount('4.210,00')).toEqual(rsd(4210))
    expect(parseAmount('4210.50')).toEqual(rsd(4210.5))
  })
})

describe('parseAmount — currency synonyms', () => {
  it.each<[string, Currency]>([
    ['300e', 'EUR'],
    ['300E', 'EUR'],
    ['300€', 'EUR'],
    ['300 €', 'EUR'],
    ['300 eur', 'EUR'],
    ['300 EUR', 'EUR'],
    ['300 evra', 'EUR'],
    ['300 EVRA', 'EUR'],
    ['300 Evra', 'EUR'],
    ['300 evro', 'EUR'],
    ['300 eura', 'EUR'],
    ['1500din', 'RSD'],
    ['1500 DIN', 'RSD'],
    ['1500 dinara', 'RSD'],
    ['1500 rsd', 'RSD'],
    ['1500 RSD', 'RSD'],
  ])('attaches the right currency to %j', (input, currency) => {
    expect(parseAmount(input)?.currency).toBe(currency)
  })

  it('defaults to RSD when the text carries no currency marker', () => {
    expect(parseAmount('4210')).toEqual(rsd(4210))
  })

  it('uses the supplied default currency when the text carries no currency marker', () => {
    expect(parseAmount('300', 'EUR')).toEqual(eur(300))
  })

  it('lets a currency written in the text win over the supplied default', () => {
    expect(parseAmount('300 din', 'EUR')).toEqual(rsd(300))
  })

  it('returns null when the only currency token is one it does not know', () => {
    expect(parseAmount('300 zlatnika')).toBeNull()
  })
})

describe('parseAmount — the k shorthand', () => {
  it.each<[string, number]>([
    ['12k', 12000],
    ['12K', 12000],
    ['1k', 1000],
    ['300k', 300000],
  ])('expands %j to %i RSD', (input, n) => {
    expect(parseAmount(input)).toEqual(rsd(n))
  })

  it('returns null for a doubled k suffix', () => {
    expect(parseAmount('12kk')).toBeNull()
  })

  it('returns null for a k suffix on nothing', () => {
    expect(parseAmount('k')).toBeNull()
  })
})

describe('parseAmount — amounts embedded in a real message', () => {
  it('extracts the amount from the SMOQUA phone shorthand', () => {
    expect(parseAmount('MATERIALS 300e')).toEqual(eur(300))
  })

  it('extracts the amount from an explicit /expense line', () => {
    expect(parseAmount('MARKETING 12000 fb ads')).toEqual(rsd(12000))
  })

  it('takes the currency-marked amount and ignores a bare digit inside a project name', () => {
    // The spec walks through exactly this message and expects 200 EUR.
    expect(parseAmount('MATERIJAAL PAMUK 200E Projekat 1')).toEqual(eur(200))
  })
})

describe('parseAmount — deliberate refusals', () => {
  it('returns null for an empty string', () => {
    expect(parseAmount('')).toBeNull()
  })

  it('returns null for whitespace only', () => {
    expect(parseAmount('   ')).toBeNull()
  })

  it('returns null for an absent input instead of throwing', () => {
    expect(parseAmount(undefined as unknown as string)).toBeNull()
  })

  it('returns null for text spelling out a number, leaving it to the model and a confirm step', () => {
    expect(parseAmount('tri hiljade')).toBeNull()
  })

  it('returns null for a currency with no number attached', () => {
    expect(parseAmount('eur')).toBeNull()
    expect(parseAmount('€')).toBeNull()
  })

  it('returns null when two bare numbers compete to be the amount', () => {
    expect(parseAmount('300 400')).toBeNull()
  })

  it('returns null when two currency-marked amounts compete', () => {
    expect(parseAmount('300e 400din')).toBeNull()
  })

  it('returns null when one number carries two conflicting currencies', () => {
    expect(parseAmount('300 eur rsd')).toBeNull()
  })

  it.each([
    ['4,210', 'a comma followed by three digits is either 4.21 or 4210'],
    ['1,234.56', 'comma-thousands with a dot-decimal contradicts the Serbian convention'],
    ['4 210', 'a space could be a thousands separator or a second amount'],
  ])('returns null for %j because %s', (input) => {
    expect(parseAmount(input)).toBeNull()
  })

  it.each([
    '4.2105',
    '1.23.456',
    '1.2345,67',
    '4210,505',
    '4210,',
    '.50',
    ',50',
    '4..210',
    '4.210,00,00',
  ])('returns null for the malformed number %j', (input) => {
    expect(parseAmount(input)).toBeNull()
  })

  it('returns null for scientific notation rather than reading the e as euros', () => {
    expect(parseAmount('3e2')).toBeNull()
  })

  it('returns null for a digit-e-digit token rather than half-reading it', () => {
    expect(parseAmount('300e5')).toBeNull()
  })

  it('returns null for zero, because absence is a null and never a zero', () => {
    expect(parseAmount('0')).toBeNull()
    expect(parseAmount('0,00')).toBeNull()
  })

  it('returns null for a negative amount rather than booking an inverted expense', () => {
    expect(parseAmount('-300')).toBeNull()
  })

  it('returns null for a number that is only punctuation', () => {
    expect(parseAmount('...')).toBeNull()
  })
})

// ===========================================================================
// formatAmount — Serbian display, always two decimals
// ===========================================================================

describe('formatAmount', () => {
  it.each<[number, string]>([
    [4210, '4.210,00'],
    [0, '0,00'],
    [0.5, '0,50'],
    [1, '1,00'],
    [999, '999,00'],
    [1000, '1.000,00'],
    [4210.5, '4.210,50'],
    [1234567.89, '1.234.567,89'],
    [1000000, '1.000.000,00'],
  ])('formats %d as %j', (n, expected) => {
    expect(formatAmount(n)).toBe(expected)
  })

  it('groups thousands from exactly 1000 upward and not below', () => {
    expect(formatAmount(999.99)).toBe('999,99')
    expect(formatAmount(1000)).toBe('1.000,00')
  })

  it('keeps the sign in front of a negative amount', () => {
    expect(formatAmount(-4210)).toBe('-4.210,00')
  })

  it('always shows two decimals, padding a whole number', () => {
    expect(formatAmount(7)).toBe('7,00')
  })

  it('rounds a third decimal away rather than printing it', () => {
    expect(formatAmount(4210.567)).toBe('4.210,57')
  })

  it('round-trips through parseAmount for a value with thousands and decimals', () => {
    expect(parseAmount(formatAmount(1234567.89))).toEqual(rsd(1234567.89))
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
    [4210.567, 4210.57],
    [0.001, 0],
    [-4210.567, -4210.57],
    [-4210.564, -4210.56],
  ])('rounds %d to %d', (n, expected) => {
    expect(round2(n)).toBe(expected)
  })

  it('rounds a decimal half up rather than to even', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(0.125)).toBe(0.13)
  })

  it('rounds a negative half toward zero, which is what half-up means', () => {
    expect(round2(-1.005)).toBe(-1)
  })

  it('is idempotent', () => {
    expect(round2(round2(4210.567))).toBe(round2(4210.567))
  })

  it('clears binary floating point noise', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })
})

// ===========================================================================
// toRsd — explicit rate only, never an invented one
// ===========================================================================

describe('toRsd', () => {
  it('converts using the supplied rate', () => {
    expect(toRsd(eur(300), 117.2)).toBe(35160)
  })

  it('rounds the converted result to two decimals', () => {
    expect(toRsd(eur(100), 117.2345)).toBe(11723.45)
  })

  it('returns null when the rate is absent, rather than assuming parity', () => {
    expect(toRsd(eur(300), null)).toBeNull()
  })

  it.each([0, -1, -117.2])('returns null for the non-positive rate %d', (rate) => {
    expect(toRsd(eur(300), rate)).toBeNull()
  })

  it('returns null for a NaN rate', () => {
    expect(toRsd(eur(300), Number.NaN)).toBeNull()
  })

  it('requires a rate even for an amount already in RSD', () => {
    expect(toRsd(rsd(1500), null)).toBeNull()
  })

  it('passes an RSD amount through unchanged at a rate of 1', () => {
    expect(toRsd(rsd(1500), 1)).toBe(1500)
  })

  it('converts a currency other than EUR with the same rule', () => {
    expect(toRsd({ amount: 200, currency: 'CHF' }, 125.5)).toBe(25100)
  })
})
