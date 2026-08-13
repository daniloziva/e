import { describe, it, expect } from 'vitest'

import { parseAmount, formatAmount, round2, toRsd } from '../../src/core/money.js'
import {
  normalize,
  resolveCurrency,
  fuzzyMatch,
  levenshtein,
  type SynonymTable,
} from '../../src/core/nlu/synonyms.js'
import type { Currency, Money } from '../../src/core/types.js'

// ---------------------------------------------------------------------------
// Money grammar + currency synonyms.
//
// Merged from three independent drafts (test/_drafts/money/e1,e2,e3). Where the
// drafts disagreed the majority reading won unless the spec said otherwise; the
// remaining ambiguities are recorded in the merge report, not silently pinned.
//
// Spec: 02-WHATSAPP-INTERFACE.md §5 "Amount grammar" and §5.1 "Routing";
//       01-ARCHITECTURE.md §5 "The hybrid principle" / "Validation and failure".
//
// The governing rule (02 §5): "the deterministic parser either returns a
// confident amount or returns nothing — it never half-guesses."
//
// Hand-written fixtures only. These modules take no injected dependencies, so
// there is nothing to fake: everything below is plain data.
// ---------------------------------------------------------------------------

const rsd = (amount: number): Money => ({ amount, currency: 'RSD' })
const eur = (amount: number): Money => ({ amount, currency: 'EUR' })

/** A learned table, as `[Zapamti: EVRA = EUR]` in 02 §5.1 would grow it. */
const LEARNED_TABLE: SynonymTable = {
  currency: { ojro: 'EUR', kinta: 'CHF', bak: 'USD', funta: 'GBP' },
  dimension: { roba: 'MATERIALS' },
}

/** A SMOQUA-shaped closed set — 02 §5.1 "Dimensions are a typed map". */
const CATEGORIES = ['MATERIALS', 'MARKETING', 'TRANSPORT']

/** canonical value -> accepted aliases, the shape `DimensionAxisDef.aliases` uses. */
const CATEGORY_ALIASES: Record<string, string[]> = {
  MATERIALS: ['MATERIJAL', 'MATERIJALI', 'ROBA'],
  MARKETING: ['REKLAMA'],
  TRANSPORT: ['PREVOZ'],
}

// ===========================================================================
// parseAmount — the module where a silently wrong answer costs real money
// ===========================================================================

describe('parseAmount', () => {
  describe('the documented grammar table (02 §5)', () => {
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

    it('reads 4.210,00 and 4210.50 differently, which is the whole point of the module', () => {
      expect(parseAmount('4.210,00')).toEqual(rsd(4210))
      expect(parseAmount('4210.50')).toEqual(rsd(4210.5))
    })

    it('returns the same answer for the same input every time (01 §5 mechanism 3)', () => {
      const parsed = parseAmount('200E')
      expect(parsed).toEqual(eur(200))
      expect(parseAmount('200E')).toEqual(parsed)
    })

    it.each<[string, Money]>([
      ['  4.210,00  ', rsd(4210)],
      ['  4210  ', rsd(4210)],
    ])('ignores surrounding whitespace in %j', (input, expected) => {
      expect(parseAmount(input)).toEqual(expected)
    })
  })

  describe('Serbian separator disambiguation', () => {
    it.each<[string, number]>([
      ['1.500', 1500],
      ['4.210', 4210],
      ['12.000', 12000],
      ['12.345', 12345],
      ['1.234.567', 1234567],
      ['1.000.000', 1000000],
    ])('reads a dot before exactly three digits as a thousands separator: %j', (input, n) => {
      expect(parseAmount(input)).toEqual(rsd(n))
    })

    it.each<[string, number]>([
      ['4210.50', 4210.5],
      ['4210.5', 4210.5],
      ['12.34', 12.34],
      ['0.99', 0.99],
      ['1.23', 1.23],
      // No thousands group is one digit long, so "1.5" has only one reading.
      ['1.5', 1.5],
    ])('reads a dot before one or two digits as a decimal point: %j', (input, n) => {
      expect(parseAmount(input)).toEqual(rsd(n))
    })

    it.each<[string, number]>([
      ['4210,50', 4210.5],
      ['4210,5', 4210.5],
      ['0,50', 0.5],
      ['0,99', 0.99],
      ['0,01', 0.01],
      ['4.210,00', 4210],
      ['4.210,05', 4210.05],
      ['1.234.567,89', 1234567.89],
    ])('always reads a comma as the decimal separator: %j', (input, n) => {
      expect(parseAmount(input)).toEqual(rsd(n))
    })

    it.each<[string, number]>([
      ['999', 999],
      ['1000', 1000],
    ])('parses %j across the first grouping boundary as %d', (input, n) => {
      expect(parseAmount(input)).toEqual(rsd(n))
    })

    it('carries the decimals through exactly rather than re-rounding them', () => {
      expect(parseAmount('4.210,05')).toEqual(rsd(4210.05))
    })

    it.each<[string, number]>([
      ['10.000.000', 10000000],
      ['12.000.000,00', 12000000],
    ])('parses %j without capping it — bounds are validate.ts, not the grammar', (input, n) => {
      // 01 §5 "Validation and failure" owns 0 < amount_total < 10,000,000.
      // The grammar reports what was written; rejecting it is a later layer.
      expect(parseAmount(input)).toEqual(rsd(n))
    })
  })

  describe('the k shorthand', () => {
    it.each<[string, number]>([
      ['12k', 12000],
      ['12K', 12000],
      ['1k', 1000],
      ['100k', 100000],
      ['300k', 300000],
    ])('expands %j to %d RSD', (input, n) => {
      expect(parseAmount(input)).toEqual(rsd(n))
    })

    it('composes the k multiplier with an explicit currency', () => {
      expect(parseAmount('12k eur')).toEqual(eur(12000))
    })

    it('applies the supplied default currency to the k shorthand as well', () => {
      expect(parseAmount('12k', 'EUR')).toEqual(eur(12000))
    })
  })

  describe('currency synonyms attached to an amount', () => {
    it.each<[string, Money]>([
      ['300e', eur(300)],
      ['300E', eur(300)],
      ['200E', eur(200)],
      ['300€', eur(300)],
      ['300 €', eur(300)],
      ['300 eur', eur(300)],
      ['300 EUR', eur(300)],
      ['300 EVRA', eur(300)],
      ['300 evra', eur(300)],
      ['300 Evra', eur(300)],
      ['300 evro', eur(300)],
      ['300 eura', eur(300)],
      ['300,00 EUR', eur(300)],
      ['4.210,00 EUR', eur(4210)],
      ['1500din', rsd(1500)],
      ['1500 DIN', rsd(1500)],
      ['1500 dinara', rsd(1500)],
      ['1500 rsd', rsd(1500)],
      ['1.500 rsd', rsd(1500)],
    ])('parses %j with the currency the synonym table names', (input, expected) => {
      expect(parseAmount(input)).toEqual(expected)
    })

    it('accepts the euro symbol written in front of the digits', () => {
      // Not in the spec table, which shows suffix forms only — but "€300" has
      // exactly one reading, so refusing it would be pedantry, not caution.
      expect(parseAmount('€300')).toEqual(eur(300))
    })
  })

  describe('the default currency argument', () => {
    it('falls back to RSD when no currency is written and no default is supplied', () => {
      // 02 §5 grammar table: "4210 -> 4210.00 RSD".
      expect(parseAmount('4210')).toEqual(rsd(4210))
    })

    it.each<[Currency]>([['RSD'], ['EUR'], ['USD'], ['CHF'], ['GBP']])(
      'stamps a bare number with the supplied default currency %s',
      (currency) => {
        expect(parseAmount('4210', currency)).toEqual({ amount: 4210, currency })
      },
    )

    it.each<[string, Currency, Money]>([
      ['300e', 'RSD', eur(300)],
      ['1500 din', 'EUR', rsd(1500)],
    ])('lets the currency written in %j beat the default %s', (input, dflt, expected) => {
      // The book is one currency, the message said another. The message wins.
      expect(parseAmount(input, dflt)).toEqual(expected)
    })

    it('does not let a default currency rescue an unparseable amount', () => {
      // A default currency is a default, never a licence to invent the number.
      expect(parseAmount('tri hiljade', 'EUR')).toBeNull()
    })
  })

  describe('amounts embedded in a real message', () => {
    it.each<[string, Money]>([
      ['MATERIALS 300e', eur(300)],
      ['/cash 800 parking', rsd(800)],
      ['/expense MARKETING 12000 fb ads', rsd(12000)],
      ['MARKETING 12000 fb ads', rsd(12000)],
    ])('extracts the single amount from %j', (input, expected) => {
      expect(parseAmount(input)).toEqual(expected)
    })

    it('takes the currency-marked amount and ignores a bare digit in a project name', () => {
      // 02 §5.1 walks through exactly this message and expects 200 EUR:
      // "deterministic slots 200E -> { amount: 200, currency: EUR }".
      expect(parseAmount('MATERIJAAL PAMUK 200E Projekat 1')).toEqual(eur(200))
    })
  })

  describe('deliberate refusals — it returns nothing rather than half-guessing', () => {
    it.each<[string, string]>([
      ['', 'the input is empty'],
      ['   ', 'the input is only whitespace'],
      ['   \t\n ', 'the input is only whitespace and control characters'],
      ['tri hiljade', 'the amount is written in words and belongs to the model + a confirm'],
      ['parking', 'there is no number at all'],
      ['abc', 'there are no digits at all'],
      ['...', 'the input is only punctuation'],
      ['/expense', 'the command carries no amount'],
      ['/expense gorivo', 'the description carries no number'],
      ['eur', 'a currency with no number attached is not an amount'],
      ['€', 'a symbol with no number attached is not an amount'],
      ['20%', 'the number is a percentage, not an amount'],
    ])('returns null for %j because %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each<[string, string]>([
      ['1.5000', 'a dot before four digits is neither a thousands group nor a decimal'],
      ['4.2105', 'a dot before four digits is neither a thousands group nor a decimal'],
      ['1.2.3', 'the group sizes are not thousands groups'],
      ['1.23.456', 'the thousands grouping is malformed'],
      ['1.2345,00', 'a thousands group is four digits long'],
      ['1.500.00', 'the last dot group is two digits, so a dot would mean two things at once'],
      ['4.21,0', 'the dot group is two digits and a comma still follows it'],
      ['11.08.2026', 'the token is a date, not an amount'],
      ['1..500', 'the separator is doubled'],
      ['4..210', 'the separator is doubled'],
      ['4.210,00,00', 'there are two decimal separators'],
      ['4.210,00,50', 'there are two decimal separators'],
      ['.', 'a lone separator is not a number'],
      ['.50', 'there is no integer part'],
      [',50', 'there is no integer part'],
      ['4210,', 'the decimal separator has nothing after it'],
      ['1,234.56', 'the anglo-saxon convention inverts both Serbian separators'],
      ['4,210.50', 'the separators are in anglo order, not Serbian'],
      ['4,210', 'a comma before three digits is either 4,21 rounded away or 4210'],
      ['300,555', 'there are three digits after the decimal comma'],
      ['4210,505', 'there are three digits after the decimal comma'],
      ['4 210', 'a space is either a thousands separator or a second amount'],
      ['NaN', 'a non-numeric literal is not an amount'],
      ['Infinity', 'a non-finite literal is not an amount'],
      ['0x1F', 'a hexadecimal literal is not an amount'],
    ])('returns null for the malformed number %j because %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each<[string, string]>([
      ['1e3', 'exponent notation collides with the "e" euro suffix'],
      ['3e2', 'exponent notation collides with the "e" euro suffix'],
      ['300e5', 'digits after the currency letter are not part of the grammar'],
      ['300e300', 'digits and a currency letter are interleaved'],
      ['k', 'the thousands shorthand has no number in front of it'],
      ['12kk', 'the thousands suffix is doubled'],
    ])('returns null for %j because %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each<[string, string]>([
      ['300 zlatnika', 'the unit is not in the synonym table'],
      ['300kn', 'the unit is not in the synonym table and is never defaulted to the book currency'],
      ['300 xyz', 'the trailing token is an unknown currency'],
      ['300 evroo', 'a typo is not a synonym — the grammar never fuzzy-matches currencies'],
    ])('returns null for %j because %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each<[string, string]>([
      ['300 400', 'two bare numbers compete to be the amount'],
      ['300 400 nesto', 'two bare numbers compete to be the amount'],
      ['300e 400din', 'two currency-marked amounts compete'],
      ['300 eur 400 rsd', 'two amounts carry two different currencies'],
      ['300 eur din', 'one number is followed by two conflicting currency words'],
      ['300 eur rsd', 'one number is followed by two conflicting currency words'],
    ])('returns null for %j because %s (02 §5.1: conflicting slots are asked about)', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each<[string, string]>([
      ['-300', 'direction lives in Transaction.direction, not in the amount grammar'],
      ['300-', 'a trailing sign is not part of the grammar'],
    ])('returns null for the signed amount %j because %s', (input) => {
      expect(parseAmount(input)).toBeNull()
    })

    it.each(['0', '0,00', '0,00 rsd'])(
      'returns null for %j, because absence is never expressed as a zero amount',
      (input) => {
        // types.ts on Money: "Absence is expressed by returning null, never by a zero."
        expect(parseAmount(input)).toBeNull()
      },
    )

    it('returns null for an absent input instead of throwing', () => {
      expect(parseAmount(undefined as unknown as string)).toBeNull()
      expect(parseAmount(null as unknown as string)).toBeNull()
    })
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
    [0.05, '0,05'],
    [0.5, '0,50'],
    [1, '1,00'],
    [7, '7,00'],
    [200, '200,00'],
    [300, '300,00'],
    [800, '800,00'],
    [999, '999,00'],
    [1000, '1.000,00'],
    [35130, '35.130,00'],
    [1000000, '1.000.000,00'],
    [1234567.89, '1.234.567,89'],
  ])('formats %d as %j', (n, expected) => {
    expect(formatAmount(n)).toBe(expected)
  })

  it('groups thousands from exactly 1000 upward and not below', () => {
    expect(formatAmount(999.99)).toBe('999,99')
    expect(formatAmount(1000)).toBe('1.000,00')
  })

  it('groups millions at exactly the second boundary', () => {
    expect(formatAmount(999999)).toBe('999.999,00')
    expect(formatAmount(1000000)).toBe('1.000.000,00')
  })

  it('keeps the minus sign in front of a negative amount', () => {
    expect(formatAmount(-4210)).toBe('-4.210,00')
  })

  it.each<[number, string]>([
    [4210.567, '4.210,57'],
    [4210.564, '4.210,56'],
  ])('rounds %d to two decimals rather than printing a third', (n, expected) => {
    expect(formatAmount(n)).toBe(expected)
  })

  it.each<[number]>([[4210], [1234567.89]])(
    'round-trips %d back through parseAmount',
    (n) => {
      expect(parseAmount(formatAmount(n))).toEqual(rsd(n))
    },
  )
})

// ===========================================================================
// round2 — half-up on the written decimal, applied per invoice
// ===========================================================================

describe('round2', () => {
  it.each<[number, number]>([
    [4210, 4210],
    [0, 0],
    [1.234, 1.23],
    [1.236, 1.24],
    [4210.564, 4210.56],
    [4210.565, 4210.57],
    [4210.566, 4210.57],
    [4210.567, 4210.57],
    [1234567.891, 1234567.89],
    [0.001, 0],
    [1e-9, 0],
    [-3.456, -3.46],
    [-4210.126, -4210.13],
    [-4210.564, -4210.56],
    [-4210.567, -4210.57],
  ])('rounds %d to %d', (n, expected) => {
    expect(round2(n)).toBe(expected)
  })

  it.each<[number, number]>([
    [0.005, 0.01],
    [0.125, 0.13],
    [1.005, 1.01],
    [1.235, 1.24],
    [2.345, 2.35],
    [2.355, 2.36],
    [2.675, 2.68],
  ])('rounds the decimal half %d up to %d rather than to even', (n, expected) => {
    // 1.005, 2.675 and 0.125 are the classic traps: a naive Math.round(n*100)/100
    // gives 1.00, 2.67 and 0.12 because none of them is representable in binary.
    // "Half-up" here means half-up on the value as written.
    expect(round2(n)).toBe(expected)
  })

  it.each<[number, number]>([
    [4210.05, 4210.05],
    [35130.25, 35130.25],
  ])('leaves the already-two-decimal value %d untouched', (n, expected) => {
    expect(round2(n)).toBe(expected)
  })

  it('is idempotent, so folding a ledger twice cannot drift', () => {
    expect(round2(round2(1.005))).toBe(round2(1.005))
    expect(round2(round2(4210.567))).toBe(round2(4210.567))
  })

  it('clears binary floating point noise', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })
})

// ===========================================================================
// toRsd — an explicit rate only, never an invented one
// ===========================================================================

describe('toRsd', () => {
  it('converts euros at the supplied rate', () => {
    // 02 §6 F4: 300,00 EUR ≈ 35.130,00 RSD at 117,1.
    expect(toRsd(eur(300), 117.1)).toBe(35130)
  })

  it('converts the spec worked example to the exact printed figure', () => {
    // 02 §6 F5: 3.000,00 EUR at 117,1043 -> 351.312,90 RSD.
    expect(toRsd(eur(3000), 117.1043)).toBe(351312.9)
  })

  it.each<[Money, number, number]>([
    [eur(300), 117.1043, 35131.29],
    [eur(300), 117.1234, 35137.02],
    [eur(100), 117.2345, 11723.45],
  ])('rounds the converted result to two decimals', (money, rate, expected) => {
    expect(toRsd(money, rate)).toBe(expected)
  })

  it('converts a currency other than EUR by the same rule', () => {
    expect(toRsd({ amount: 200, currency: 'CHF' }, 125.5)).toBe(25100)
  })

  it('preserves the sign of an outflow', () => {
    expect(toRsd(eur(-300), 117.1)).toBe(-35130)
  })

  it('converts a zero amount to zero rather than to null', () => {
    // Absence is null; a zero-valued conversion of a zero amount is a fact.
    expect(toRsd(eur(0), 117.1)).toBe(0)
  })

  it('accepts the smallest plausible positive rate rather than treating it as missing', () => {
    expect(toRsd(eur(100), 0.01)).toBe(1)
  })

  it('passes an RSD amount through unchanged at a rate of 1', () => {
    expect(toRsd(rsd(1500), 1)).toBe(1500)
    expect(toRsd(rsd(4210), 1)).toBe(4210)
  })

  it('returns null when the rate is missing, rather than assuming parity', () => {
    // No rate means no number — never a silent 1:1 fallback.
    expect(toRsd(eur(300), null)).toBeNull()
  })

  it('requires a rate even for an amount already denominated in RSD', () => {
    // The contract says null when the rate is missing, with no exemption for
    // the no-op case. Literal reading; see the merge report.
    expect(toRsd(rsd(1500), null)).toBeNull()
  })

  it.each<[number, string]>([
    [0, 'zero'],
    [-1, 'negative'],
    [-0.0001, 'negative just below zero'],
    [-117.1, 'negative even when plausible in magnitude'],
    [Number.NaN, 'not a number'],
    [Number.POSITIVE_INFINITY, 'not finite'],
  ])('returns null when the rate is %d (%s)', (rate) => {
    expect(toRsd(eur(300), rate)).toBeNull()
  })
})

// ===========================================================================
// normalize — the shared normalizer every other function is built on
// ===========================================================================

describe('normalize', () => {
  it.each<[string, string]>([
    ['ŠĐČĆŽ', 'sdccz'],
    ['šđčćž', 'sdccz'],
    ['Račun', 'racun'],
    ['ČAČAK', 'cacak'],
    ['TROŠAK', 'trosak'],
    ['Trošak', 'trosak'],
    ['MATERIALS', 'materials'],
    ['MATERIJAAL', 'materijaal'],
    ['EVRA', 'evra'],
    ['already normal', 'already normal'],
  ])('lowercases and strips diacritics: %j -> %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it('handles Đ / đ, which unicode decomposition alone does not split', () => {
    // U+0110 / U+0111 have no combining-mark decomposition — they need a map.
    expect(normalize('Đorđe')).toBe('dorde')
  })

  it('collapses ć and č onto the same base letter, so they cannot be told apart after', () => {
    expect(normalize('ć')).toBe(normalize('č'))
    expect(normalize('ć')).toBe('c')
  })

  it('maps š and ž to distinct base letters rather than to the same one', () => {
    expect(normalize('šž')).toBe('sz')
  })

  it.each<[string, string]>([
    ['štampa', 'stampa'],
    ['štampa', 'stampa'],
  ])('treats the decomposed and precomposed spelling %j identically', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it('lands a bare combining caron on the same token as the precomposed letter', () => {
    expect(normalize('š')).toBe(normalize('š'))
  })

  it.each<[string, string]>([
    ['  MATERIJAAL   PAMUK  ', 'materijaal pamuk'],
    ['Materijal   Pamuk', 'materijal pamuk'],
    ['a\tb', 'a b'],
    ['a\nb', 'a b'],
    ['a\tb\nc', 'a b c'],
    ['a    b', 'a b'],
    ['', ''],
    ['   ', ''],
    ['   \t\n  ', ''],
  ])('collapses whitespace and trims: %j -> %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  it.each<[string, string]>([
    ['/EXPENCE', '/expence'],
    ['/expense MARKETING 12.000,00', '/expense marketing 12.000,00'],
    ['  4.210,00  ', '4.210,00'],
    ['300€', '300€'],
    ['€', '€'],
  ])('keeps digits, separators and symbols intact: %j -> %j', (input, expected) => {
    // The command parser still needs the leading slash, and the money grammar
    // still needs the separators, so normalize must not strip punctuation.
    expect(normalize(input)).toBe(expected)
  })

  it('is idempotent, so normalising an already-normalised token changes nothing', () => {
    const once = normalize('  ŠTAMPAČ   Račun ')
    expect(normalize(once)).toBe(once)
  })
})

// ===========================================================================
// resolveCurrency — deterministic, never a silent default
// ===========================================================================

describe('resolveCurrency', () => {
  it.each(['EUR', 'eur', 'Eur', 'e', 'E', '€', 'EVRA', 'evra', 'Evra', 'evro', 'eura'])(
    'resolves %j to EUR',
    (token) => {
      expect(resolveCurrency(token)).toBe('EUR')
    },
  )

  it.each(['RSD', 'rsd', 'din', 'DIN', 'Din', 'dinara', 'DINARA', 'Dinara'])(
    'resolves %j to RSD',
    (token) => {
      expect(resolveCurrency(token)).toBe('RSD')
    },
  )

  it.each<[string, Currency]>([
    ['usd', 'USD'],
    ['USD', 'USD'],
    ['chf', 'CHF'],
    ['CHF', 'CHF'],
    ['gbp', 'GBP'],
  ])('resolves the ISO code %j to %s', (token, expected) => {
    // types.ts allows five currencies and 01 §5 requires "currency from an
    // allowlist"; an ISO code has exactly one reading, so it is a lookup and
    // not a guess. See the merge report — the synonym doc only spells out
    // EUR and RSD.
    expect(resolveCurrency(token)).toBe(expected)
  })

  it.each([' eur ', ' rsd ', '  EVRA  '])('ignores whitespace around %j', (token) => {
    expect(resolveCurrency(token)).not.toBeNull()
  })

  it.each<[string, string]>([
    ['', 'the token is empty'],
    ['   ', 'the token is only whitespace'],
    ['xyz', 'the token is unrelated'],
    ['kn', 'the token is a currency E does not carry'],
    ['dolar', 'the word is not in the table, only the ISO code is'],
    ['money', 'the word is not a currency token'],
    ['evroo', 'a typo is not a synonym — resolution is a lookup, never a guess'],
    ['evrica', 'a near-miss is not a synonym'],
    ['ev', 'a prefix of a synonym is not a synonym'],
    ['euro-ish', 'punctuated nonsense is not a synonym'],
    ['euro dollar', 'two words are not one currency token'],
    ['300', 'digits are not a currency'],
    ['1500', 'digits are not a currency'],
    ['$', 'the symbol is not in the table'],
    ['€€', 'a doubled symbol is not a token'],
  ])('returns null for %j because %s, rather than defaulting', (token) => {
    // 02 §5.1 / synonyms.ts: "Unknown token -> null (E asks; it never defaults silently)".
    expect(resolveCurrency(token)).toBeNull()
  })

  it('returns null for an absent token instead of throwing', () => {
    expect(resolveCurrency(undefined as unknown as string)).toBeNull()
    expect(resolveCurrency(null as unknown as string)).toBeNull()
  })

  it.each<[string, Currency]>([
    ['ojro', 'EUR'],
    ['kinta', 'CHF'],
    ['bak', 'USD'],
    ['funta', 'GBP'],
  ])('resolves %j to %s from a supplied synonym table', (token, expected) => {
    // 02 §5.1: "[Zapamti: EVRA = EUR]" grows the deterministic layer over time.
    expect(resolveCurrency(token, LEARNED_TABLE)).toBe(expected)
  })

  it('normalizes the token before consulting a supplied table', () => {
    expect(resolveCurrency('  OJRO ', LEARNED_TABLE)).toBe('EUR')
    expect(resolveCurrency('  BAK  ', LEARNED_TABLE)).toBe('USD')
  })

  it.each(['zzz', 'bitcoin'])(
    'still returns null for %j when a table is supplied',
    (token) => {
      expect(resolveCurrency(token, LEARNED_TABLE)).toBeNull()
    },
  )
})

// ===========================================================================
// fuzzyMatch — matches or refuses, never guesses between two candidates
// ===========================================================================

describe('fuzzyMatch', () => {
  describe('matching', () => {
    it('returns the exact candidate at distance 0', () => {
      expect(fuzzyMatch('MATERIALS', CATEGORIES)).toBe('MATERIALS')
    })

    it('matches case-insensitively and returns the canonical spelling', () => {
      expect(fuzzyMatch('materials', CATEGORIES)).toBe('MATERIALS')
    })

    it.each<[string, string[], string]>([
      ['TROŠAK', ['TROSAK', 'MARKETING'], 'TROSAK'],
      ['troskovi', ['TROŠKOVI', 'MARKETING'], 'TROŠKOVI'],
      ['stampa', ['ŠTAMPA', 'TRANSPORT'], 'ŠTAMPA'],
    ])('matches %j diacritic-insensitively to %s', (token, candidates, expected) => {
      expect(fuzzyMatch(token, candidates)).toBe(expected)
    })

    it('ignores whitespace around the token', () => {
      expect(fuzzyMatch('  materials  ', CATEGORIES)).toBe('MATERIALS')
    })

    it.each(['MATERIALZ', 'MATERIAL', 'MTERIALS', 'MATERIALSS'])(
      'matches the single-edit typo %j to MATERIALS',
      (token) => {
        expect(fuzzyMatch(token, CATEGORIES)).toBe('MATERIALS')
      },
    )

    it('prefers the nearer candidate when the distances differ', () => {
      expect(fuzzyMatch('MARKETINK', CATEGORIES)).toBe('MARKETING')
      expect(fuzzyMatch('abc', ['abd', 'zzz'])).toBe('abd')
    })

    it.each<[string, string[], string]>([
      ['abc', ['abc', 'abd'], 'abc'],
      ['HRANA', ['HRANA', 'HRANE'], 'HRANA'],
      ['MATERIALE', ['MATERIALS', 'MATERIALE'], 'MATERIALE'],
    ])('prefers the exact candidate over a near one rather than calling %j a tie', (
      token,
      candidates,
      expected,
    ) => {
      expect(fuzzyMatch(token, candidates, undefined)).toBe(expected)
    })
  })

  describe('the alias list', () => {
    it.each<[string, string]>([
      ['ROBA', 'MATERIALS'],
      ['MATERIJAL', 'MATERIALS'],
      ['REKLAMA', 'MARKETING'],
      ['PREVOZ', 'TRANSPORT'],
    ])('returns the canonical value %s, not the alias %j that matched', (token, expected) => {
      expect(fuzzyMatch(token, CATEGORIES, CATEGORY_ALIASES)).toBe(expected)
    })

    it('matches MATERIJAAL to MATERIALS through the MATERIJAL alias at distance 1', () => {
      // 02 §5.1 calls this "edit distance <= 2 vs the ALIAS list". The raw
      // distance MATERIJAAL -> MATERIALS is 3; only the alias route is <= 2.
      expect(fuzzyMatch('MATERIJAAL', CATEGORIES, CATEGORY_ALIASES)).toBe('MATERIALS')
    })

    it('declines MATERIJAAL without an alias list, because the raw distance is 3', () => {
      expect(fuzzyMatch('MATERIJAAL', CATEGORIES)).toBeNull()
    })

    it('matches MATERIJAAL directly once maxDistance is raised to 3', () => {
      expect(fuzzyMatch('MATERIJAAL', CATEGORIES, undefined, 3)).toBe('MATERIALS')
    })

    it('is not ambiguous when two aliases of the same canonical value tie', () => {
      // Ambiguity is about the answer, not about how many routes reach it.
      expect(
        fuzzyMatch('MATERIJALX', ['MATERIALS'], { MATERIALS: ['MATERIJAL', 'MATERIJALI'] }),
      ).toBe('MATERIALS')
    })

    it('ignores an alias whose canonical value is not in the candidate set', () => {
      // The closed set is the authority; a stale alias must not smuggle a value in.
      expect(fuzzyMatch('MATERIJAL', ['MARKETING'], CATEGORY_ALIASES)).toBeNull()
    })

    it('resolves a slash-command typo without a model call', () => {
      // 02 §5.1 "Commands still get deterministic fuzzy matching", Levenshtein <= 1.
      const commands = ['expense', 'invoice', 'pending', 'report', 'status', 'help']
      expect(fuzzyMatch('expence', commands, { expense: ['trosak'] }, 1)).toBe('expense')
      expect(fuzzyMatch('troshak', commands, { expense: ['trosak'] }, 1)).toBe('expense')
    })
  })

  describe('the distance budget, exactly', () => {
    it('accepts a token at exactly the default distance of 2', () => {
      // levenshtein('materijal','materials') === 2
      expect(fuzzyMatch('MATERIJAL', CATEGORIES)).toBe('MATERIALS')
      expect(fuzzyMatch('MATERIALXY', ['MATERIALS'])).toBe('MATERIALS')
    })

    it('rejects a token at exactly one past the default distance', () => {
      // 06 §4: "MATERIC -> no match, ask". levenshtein('materic','materials') === 3.
      expect(fuzzyMatch('MATERIC', CATEGORIES)).toBeNull()
      expect(fuzzyMatch('MATERIALXYZ', ['MATERIALS'])).toBeNull()
    })

    it('accepts a token at exactly the supplied maxDistance', () => {
      expect(fuzzyMatch('MATERIALX', ['MATERIALS'], undefined, 1)).toBe('MATERIALS')
      expect(fuzzyMatch('abc', ['abd'], undefined, 1)).toBe('abd')
    })

    it('rejects a token one step past the supplied maxDistance', () => {
      expect(fuzzyMatch('MATERIALXY', ['MATERIALS'], undefined, 1)).toBeNull()
      expect(fuzzyMatch('abc', ['add'], undefined, 1)).toBeNull()
    })

    it('accepts only an exact token when maxDistance is 0', () => {
      expect(fuzzyMatch('MATERIALS', CATEGORIES, undefined, 0)).toBe('MATERIALS')
      expect(fuzzyMatch('MATERIAL', CATEGORIES, undefined, 0)).toBeNull()
    })
  })

  describe('deliberate refusals — a tie is a question, not a coin flip', () => {
    it.each<[string, string[]]>([
      ['abc', ['abd', 'abe']],
      ['HRANI', ['HRANA', 'HRANE']],
      ['MATERIALX', ['MATERIALS', 'MATERIALE']],
    ])('returns null when %j sits at the same distance from two candidates', (
      token,
      candidates,
    ) => {
      expect(fuzzyMatch(token, candidates)).toBeNull()
    })

    it('returns null when a canonical value ties with another value reached by alias', () => {
      expect(fuzzyMatch('abd', ['abc', 'zzz'], { zzz: ['abe'] })).toBeNull()
      expect(fuzzyMatch('PREVOZI', ['TRANSPORT', 'PREVOZE'], { TRANSPORT: ['PREVOZ'] })).toBeNull()
    })

    it('returns null when two aliases of two different canonical values tie', () => {
      expect(fuzzyMatch('DECU', ['HRANA', 'ZABAVA'], { HRANA: ['DECA'], ZABAVA: ['DECO'] })).toBeNull()
    })

    it.each<[string, string[], string]>([
      ['QQQQQQQQ', CATEGORIES, 'nothing in the closed set is close'],
      ['GORIVO', CATEGORIES, 'nothing in the closed set is close'],
      ['X', CATEGORIES, 'a single letter is far from every candidate'],
      ['MATERIALS', [], 'the candidate set is empty'],
      ['', CATEGORIES, 'the token is empty'],
      ['   ', CATEGORIES, 'the token is only whitespace'],
      ['', [], 'both the token and the candidate set are empty'],
    ])('returns null for %j against %j because %s', (token, candidates) => {
      expect(fuzzyMatch(token, candidates)).toBeNull()
    })

    it('returns null when nothing is within budget even with an alias list', () => {
      expect(fuzzyMatch('PAMUK', CATEGORIES, CATEGORY_ALIASES)).toBeNull()
    })

    it('returns null for an absent token instead of throwing', () => {
      expect(fuzzyMatch(undefined as unknown as string, CATEGORIES)).toBeNull()
      expect(fuzzyMatch(null as unknown as string, CATEGORIES)).toBeNull()
    })
  })
})

// ===========================================================================
// levenshtein — the raw primitive fuzzy matching is built on
// ===========================================================================

describe('levenshtein', () => {
  it.each<[string, string, number]>([
    ['', '', 0],
    ['a', '', 1],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['abc', 'abc', 0],
    ['abc', 'abd', 1],
    ['abc', 'axc', 1],
    ['kitten', 'sitting', 3],
    ['flaw', 'lawn', 2],
    ['book', 'back', 2],
    ['expence', 'expense', 1],
    ['EXPENCE', 'EXPENSE', 1],
    ['troshak', 'trosak', 1],
    ['evra', 'eura', 1],
  ])('reports the distance from %j to %j as %d', (a, b, expected) => {
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('counts a transposition as two edits, not one', () => {
    // Plain Levenshtein, not Damerau — the difference decides whether some
    // near-ties are ties at all.
    expect(levenshtein('ab', 'ba')).toBe(2)
  })

  it.each<[string, string, number]>([
    ['MATERIJAAL', 'MATERIJAL', 1],
    ['MATERIJAL', 'MATERIALS', 2],
    ['MATERIJAAL', 'MATERIALS', 3],
    ['MATERIC', 'MATERIALS', 3],
    ['MARKETING', 'MATERIALS', 6],
  ])('pins the MATERIJAAL family: %j -> %j is %d', (a, b, expected) => {
    // The headline spec gap. 02 §5.1 and 06 §4 say "MATERIJAAL -> MATERIALS at
    // edit distance <= 2"; the true distance is 3. It is <= 2 only against the
    // Serbian alias MATERIJAL, which is exactly why the alias list exists.
    expect(levenshtein(a, b)).toBe(expected)
  })

  it('is symmetric', () => {
    expect(levenshtein('MATERIJAAL', 'MATERIALS')).toBe(levenshtein('MATERIALS', 'MATERIJAAL'))
    expect(levenshtein('materijal', 'materials')).toBe(levenshtein('materials', 'materijal'))
  })

  it.each<[string, string, number]>([
    ['ABC', 'abc', 3],
    ['materials', 'MATERIALS', 9],
  ])('counts raw characters, leaving case folding to the caller: %j vs %j is %d', (
    a,
    b,
    expected,
  ) => {
    // Case- and diacritic-insensitivity live in fuzzyMatch, via normalize().
    expect(levenshtein(a, b)).toBe(expected)
  })
})
