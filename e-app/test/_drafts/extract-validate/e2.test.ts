import { describe, it, expect } from 'vitest'
import { validateFacts } from '../../../src/core/extract/validate.js'
import type {
  Clock,
  Confidence,
  Currency,
  ExtractedFacts,
  Extraction,
  ExtractionMethod,
  LineItem,
} from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library; every dependency is a fixed value.
// ---------------------------------------------------------------------------

/** A Clock frozen at an exact instant. Core never reads the system clock. */
function fixedClock(iso: string): Clock {
  const instant = new Date(iso)
  return { now: () => new Date(instant.getTime()) }
}

/** The reference "now" for every window test unless a test says otherwise. */
const NOW = '2026-08-12T12:00:00Z'
const clock = fixedClock(NOW)

// Derived window edges for NOW, written out literally so the boundary is
// visible in the test rather than recomputed by the same logic under test.
const WINDOW_START = '2025-02-12' // now - 18 months, inclusive
const WINDOW_END = '2026-08-14' // now + 2 days, inclusive
const BEFORE_WINDOW = '2025-02-11'
const AFTER_WINDOW = '2026-08-15'

const ALL_METHODS: ExtractionMethod[] = [
  'cache',
  'fiscal_qr',
  'vendor_profile',
  'pdf_text',
  'di_invoice',
  'di_receipt',
  'llm_vision',
  'manual',
]

const ALL_CURRENCIES: Currency[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

const NO_LINE_ITEMS: LineItem[] = []

/** Facts that pass every rule cleanly: the happy path all other cases mutate. */
function validFacts(over: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    vendorName: 'Maxi d.o.o.',
    vendorPib: '100000001',
    docDate: '2026-08-01',
    amountNet: 1000,
    vatAmount: 200,
    amountTotal: 1200,
    currency: 'RSD',
    lineItems: NO_LINE_ITEMS,
    ...over,
  }
}

function extraction(over: Partial<Extraction> = {}): Extraction {
  return { method: 'pdf_text', confidence: 'high', model: null, ...over }
}

/** A deterministic regex rung and a model rung carrying identical facts. */
const REGEX_RUNG = extraction({ method: 'pdf_text', confidence: 'high', model: null })
const MODEL_RUNG = extraction({
  method: 'llm_vision',
  confidence: 'high',
  model: 'gpt-4o-mini@2026-05',
  raw: { some: 'provider payload' },
})

// ---------------------------------------------------------------------------
// The same validator, every rung
// ---------------------------------------------------------------------------

describe('validateFacts — applied identically to every ladder rung', () => {
  it.each(ALL_METHODS)(
    'accepts clean facts from the %s rung with the same result',
    (method) => {
      const result = validateFacts(validFacts(), extraction({ method }), clock)
      expect(result.facts).toEqual(validFacts())
      expect(result.rejected).toEqual([])
      expect(result.reviewStatus).toBe('ok')
    },
  )

  it('rejects the same bad facts on every rung, with no rung getting a pass', () => {
    const bad = validFacts({
      vendorPib: '12345678',
      docDate: BEFORE_WINDOW,
      amountTotal: 0,
      vatAmount: 99,
      currency: 'JPY' as Currency,
    })
    const results = ALL_METHODS.map((method) =>
      validateFacts(bad, extraction({ method }), clock),
    )
    for (const result of results) {
      expect(result).toEqual(results[0])
      expect(result.facts.vendorPib).toBeNull()
      expect(result.facts.docDate).toBeNull()
      expect(result.facts.amountTotal).toBeNull()
      expect(result.facts.currency).toBeNull()
    }
  })

  it('produces byte-identical results for regex output and model output carrying the same facts', () => {
    const facts = validFacts({
      vendorPib: '1234567890',
      docDate: AFTER_WINDOW,
      amountTotal: 20_000_000,
      vatAmount: 3_000_000,
      currency: 'JPY' as Currency,
    })
    const fromRegex = validateFacts(facts, REGEX_RUNG, clock)
    const fromModel = validateFacts(facts, MODEL_RUNG, clock)
    expect(fromModel).toEqual(fromRegex)
  })

  it('does not trust a model rung more than a regex rung at the same confidence', () => {
    const facts = validFacts({ amountTotal: 10_000_000 })
    expect(validateFacts(facts, MODEL_RUNG, clock).facts.amountTotal).toBeNull()
    expect(validateFacts(facts, REGEX_RUNG, clock).facts.amountTotal).toBeNull()
  })

  it('does not trust a manual rung more than a model rung', () => {
    const facts = validFacts({ vendorPib: 'not-a-pib' })
    const manual = validateFacts(facts, extraction({ method: 'manual', confidence: 'exact' }), clock)
    const model = validateFacts(facts, extraction({ method: 'llm_vision', confidence: 'exact' }), clock)
    expect(manual.facts).toEqual(model.facts)
    expect(manual.rejected).toEqual(model.rejected)
  })

  it('ignores the model name and the raw provider payload entirely', () => {
    const facts = validFacts()
    const withRaw = validateFacts(
      facts,
      extraction({ model: 'gpt-4o-mini@2026-05', raw: { total: 999_999_999 } }),
      clock,
    )
    const withoutRaw = validateFacts(facts, extraction({ model: null }), clock)
    expect(withRaw).toEqual(withoutRaw)
  })
})

// ---------------------------------------------------------------------------
// vendorPib — exactly nine digits or nothing
// ---------------------------------------------------------------------------

describe('validateFacts — vendorPib', () => {
  it('keeps a PIB that is exactly nine digits', () => {
    const result = validateFacts(validFacts({ vendorPib: '123456789' }), REGEX_RUNG, clock)
    expect(result.facts.vendorPib).toBe('123456789')
    expect(result.rejected).not.toContain('vendorPib')
  })

  it('keeps a nine-digit PIB with leading zeros rather than treating it as a number', () => {
    const result = validateFacts(validFacts({ vendorPib: '000123456' }), REGEX_RUNG, clock)
    expect(result.facts.vendorPib).toBe('000123456')
  })

  it.each([
    ['eight digits — one short of a PIB', '12345678'],
    ['ten digits — one long, likely a matični broj', '1234567890'],
    ['thirteen digits — a JMBG, not a PIB', '0101990710123'],
    ['letters', 'ABCDEFGHI'],
    ['eight digits and a letter', '12345678A'],
    ['digits with an embedded space', '123 45 678'],
    ['digits with separators', '123-456-789'],
    ['a labelled value', 'PIB:123456789'],
    ['an empty string', ''],
    ['non-ASCII digits', '١٢٣٤٥٦٧٨٩'],
  ])('returns null for a vendorPib that is %s', (_label, pib) => {
    const result = validateFacts(validFacts({ vendorPib: pib }), REGEX_RUNG, clock)
    expect(result.facts.vendorPib).toBeNull()
    expect(result.rejected).toContain('vendorPib')
  })

  it('leaves an absent vendorPib null without reporting it as rejected', () => {
    const result = validateFacts(validFacts({ vendorPib: null }), REGEX_RUNG, clock)
    expect(result.facts.vendorPib).toBeNull()
    expect(result.rejected).not.toContain('vendorPib')
  })

  it('does not send a document to review just because the PIB is missing', () => {
    const result = validateFacts(validFacts({ vendorPib: null }), REGEX_RUNG, clock)
    expect(result.reviewStatus).toBe('ok')
  })

  it('drops only the PIB and keeps the money when the PIB is malformed', () => {
    const result = validateFacts(validFacts({ vendorPib: '99' }), REGEX_RUNG, clock)
    expect(result.facts.vendorPib).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
    expect(result.facts.docDate).toBe('2026-08-01')
    expect(result.reviewStatus).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// docDate — inside [now - 18 months, now + 2 days], on the injected clock
// ---------------------------------------------------------------------------

describe('validateFacts — docDate window', () => {
  it('keeps a date comfortably inside the window', () => {
    const result = validateFacts(validFacts({ docDate: '2026-03-15' }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBe('2026-03-15')
    expect(result.rejected).not.toContain('docDate')
  })

  it('keeps a date exactly on the 18-month lower boundary', () => {
    const result = validateFacts(validFacts({ docDate: WINDOW_START }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBe(WINDOW_START)
    expect(result.reviewStatus).toBe('ok')
  })

  it('returns null for the day immediately before the 18-month lower boundary', () => {
    const result = validateFacts(validFacts({ docDate: BEFORE_WINDOW }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('keeps a date exactly two days in the future', () => {
    const result = validateFacts(validFacts({ docDate: WINDOW_END }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBe(WINDOW_END)
    expect(result.reviewStatus).toBe('ok')
  })

  it('returns null for a date three days in the future', () => {
    const result = validateFacts(validFacts({ docDate: AFTER_WINDOW }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('keeps today', () => {
    const result = validateFacts(validFacts({ docDate: '2026-08-12' }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBe('2026-08-12')
  })

  it('keeps tomorrow', () => {
    const result = validateFacts(validFacts({ docDate: '2026-08-13' }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBe('2026-08-13')
  })

  it('moves the window when the clock moves, not when the calendar does', () => {
    const earlier = fixedClock('2025-01-10T12:00:00Z')
    const inWindowForEarlierClock = '2023-08-01' // inside [2023-07-10, 2025-01-12]
    const result = validateFacts(
      validFacts({ docDate: inWindowForEarlierClock }),
      REGEX_RUNG,
      earlier,
    )
    expect(result.facts.docDate).toBe(inWindowForEarlierClock)

    const sameDateOnLaterClock = validateFacts(
      validFacts({ docDate: inWindowForEarlierClock }),
      REGEX_RUNG,
      clock,
    )
    expect(sameDateOnLaterClock.facts.docDate).toBeNull()
  })

  it('applies the window by calendar day, not by time of day, at the start of the day', () => {
    const midnight = fixedClock('2026-08-12T00:00:00Z')
    expect(validateFacts(validFacts({ docDate: WINDOW_START }), REGEX_RUNG, midnight).facts.docDate)
      .toBe(WINDOW_START)
    expect(validateFacts(validFacts({ docDate: WINDOW_END }), REGEX_RUNG, midnight).facts.docDate)
      .toBe(WINDOW_END)
  })

  it('applies the window by calendar day, not by time of day, at the end of the day', () => {
    const lateNight = fixedClock('2026-08-12T23:59:59Z')
    expect(validateFacts(validFacts({ docDate: WINDOW_START }), REGEX_RUNG, lateNight).facts.docDate)
      .toBe(WINDOW_START)
    expect(validateFacts(validFacts({ docDate: AFTER_WINDOW }), REGEX_RUNG, lateNight).facts.docDate)
      .toBeNull()
  })

  it('accepts a date across a year boundary that is inside the window', () => {
    const janClock = fixedClock('2026-01-05T12:00:00Z')
    const result = validateFacts(validFacts({ docDate: '2025-12-31' }), REGEX_RUNG, janClock)
    expect(result.facts.docDate).toBe('2025-12-31')
  })

  it('accepts 29 February in a leap year inside the window', () => {
    const leapClock = fixedClock('2024-03-01T12:00:00Z')
    const result = validateFacts(validFacts({ docDate: '2024-02-29' }), REGEX_RUNG, leapClock)
    expect(result.facts.docDate).toBe('2024-02-29')
  })

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['29 February in a non-leap year', '2025-02-29'],
    ['a month that does not exist', '2026-13-01'],
    ['a zero day', '2026-08-00'],
    ['day-first European format', '12/08/2026'],
    ['dotted Serbian format', '12.08.2026.'],
    ['a year and month only', '2026-08'],
    ['prose', 'yesterday'],
    ['an empty string', ''],
    ['a number that looks like a date', '20260812'],
  ])('returns null for a docDate that is %s', (_label, date) => {
    const result = validateFacts(validFacts({ docDate: date }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('refuses a date far in the past rather than clamping it to the window', () => {
    const result = validateFacts(validFacts({ docDate: '1999-01-01' }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
  })

  it('refuses a date far in the future rather than clamping it to today', () => {
    const result = validateFacts(validFacts({ docDate: '2099-01-01' }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
  })

  it('leaves an absent docDate null without reporting it as rejected', () => {
    const result = validateFacts(validFacts({ docDate: null }), REGEX_RUNG, clock)
    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).not.toContain('docDate')
  })
})

// ---------------------------------------------------------------------------
// amountTotal — strictly between 0 and 10,000,000
// ---------------------------------------------------------------------------

describe('validateFacts — amountTotal bounds', () => {
  it.each([
    ['the smallest sensible amount', 0.01],
    ['a typical receipt total', 1234.56],
    ['a fraction below the upper bound', 9_999_999.99],
  ])('keeps an amountTotal that is %s', (_label, amount) => {
    const result = validateFacts(
      validFacts({ amountTotal: amount, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBe(amount)
    expect(result.rejected).not.toContain('amountTotal')
  })

  it('returns null for an amountTotal of exactly zero — the lower bound is exclusive', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 0, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it('returns null for an amountTotal of exactly 10,000,000 — the upper bound is exclusive', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 10_000_000, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it.each([
    ['a negative amount', -1],
    ['a hair below zero', -0.01],
    ['just above the upper bound', 10_000_000.01],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('returns null for an amountTotal that is %s', (_label, amount) => {
    const result = validateFacts(
      validFacts({ amountTotal: amount, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it('nulls an out-of-range amountTotal rather than clamping it to the bound', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 50_000_000, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.amountTotal).not.toBe(10_000_000)
  })

  it('leaves an absent amountTotal null without reporting it as rejected', () => {
    const result = validateFacts(validFacts({ amountTotal: null, vatAmount: null }), REGEX_RUNG, clock)
    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).not.toContain('amountTotal')
  })

  it('keeps a valid docDate and vendor when the amount is unreadable', () => {
    const result = validateFacts(
      validFacts({ amountTotal: Number.NaN, vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.docDate).toBe('2026-08-01')
    expect(result.facts.vendorPib).toBe('100000001')
    expect(result.facts.vendorName).toBe('Maxi d.o.o.')
  })
})

// ---------------------------------------------------------------------------
// vatAmount — never more than the total, and its failure costs only itself
// ---------------------------------------------------------------------------

describe('validateFacts — vatAmount against amountTotal', () => {
  it('keeps a VAT amount below the total', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 200 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBe(200)
    expect(result.rejected).toEqual([])
  })

  it('keeps a VAT amount exactly equal to the total — the rule is "at most"', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 1200 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBe(1200)
    expect(result.rejected).not.toContain('vatAmount')
  })

  it('keeps a zero VAT amount, which is a real answer for a non-VAT vendor', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 0 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBe(0)
    expect(result.rejected).not.toContain('vatAmount')
  })

  it('drops only the VAT when it exceeds the total by the smallest margin', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 1200.01 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
    expect(result.rejected).toEqual(['vatAmount'])
  })

  it('drops only the VAT when a misread decimal makes it wildly larger than the total', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 120000 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
  })

  it('does not send a document to review merely because its VAT was dropped', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 1200, vatAmount: 5000 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.reviewStatus).toBe('ok')
  })

  it('leaves amountNet untouched when the VAT is dropped', () => {
    const result = validateFacts(
      validFacts({ amountNet: 1000, amountTotal: 1200, vatAmount: 5000 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountNet).toBe(1000)
  })

  it('leaves an absent vatAmount null without reporting it as rejected', () => {
    const result = validateFacts(
      validFacts({ vatAmount: null }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vatAmount).toBeNull()
    expect(result.rejected).not.toContain('vatAmount')
  })
})

// ---------------------------------------------------------------------------
// currency — allowlist only
// ---------------------------------------------------------------------------

describe('validateFacts — currency allowlist', () => {
  it.each(ALL_CURRENCIES)('keeps %s, which is on the allowlist', (currency) => {
    const result = validateFacts(validFacts({ currency }), REGEX_RUNG, clock)
    expect(result.facts.currency).toBe(currency)
    expect(result.rejected).not.toContain('currency')
  })

  it.each([
    ['a currency that is not on the allowlist', 'JPY'],
    ['the old Serbian abbreviation', 'DIN'],
    ['a currency symbol', '€'],
    ['a spelled-out currency', 'EURO'],
    ['a Serbian word for the currency', 'EVRA'],
    ['a lowercase code', 'eur'],
    ['a padded code', ' EUR '],
    ['an empty string', ''],
  ])('returns null for a currency that is %s', (_label, currency) => {
    const result = validateFacts(
      validFacts({ currency: currency as Currency }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.currency).toBeNull()
    expect(result.rejected).toContain('currency')
  })

  it('keeps the amount when only the currency is unrecognised', () => {
    const result = validateFacts(
      validFacts({ currency: 'JPY' as Currency }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.amountTotal).toBe(1200)
    expect(result.facts.currency).toBeNull()
  })

  it('leaves an absent currency null without reporting it as rejected', () => {
    const result = validateFacts(validFacts({ currency: null }), REGEX_RUNG, clock)
    expect(result.facts.currency).toBeNull()
    expect(result.rejected).not.toContain('currency')
  })
})

// ---------------------------------------------------------------------------
// reviewStatus
// ---------------------------------------------------------------------------

describe('validateFacts — needs_review triggers', () => {
  it('returns ok when every rule passes and confidence is high', () => {
    const result = validateFacts(validFacts(), extraction({ confidence: 'high' }), clock)
    expect(result.reviewStatus).toBe('ok')
  })

  it('returns ok when every rule passes and confidence is exact', () => {
    const result = validateFacts(validFacts(), extraction({ confidence: 'exact' }), clock)
    expect(result.reviewStatus).toBe('ok')
  })

  it.each<Confidence>(['medium', 'low'])(
    'returns needs_review on clean facts when confidence is %s',
    (confidence) => {
      const result = validateFacts(validFacts(), extraction({ confidence }), clock)
      expect(result.reviewStatus).toBe('needs_review')
      expect(result.rejected).toEqual([])
    },
  )

  it('returns needs_review when amountTotal is absent', () => {
    const result = validateFacts(
      validFacts({ amountTotal: null, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns needs_review when amountTotal was rejected by the bounds rule', () => {
    const result = validateFacts(
      validFacts({ amountTotal: 0, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns needs_review when docDate is absent', () => {
    const result = validateFacts(
      validFacts({ docDate: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns needs_review when docDate fell outside the window', () => {
    const result = validateFacts(
      validFacts({ docDate: BEFORE_WINDOW }),
      extraction({ confidence: 'exact' }),
      clock,
    )
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns needs_review for an unreadable total whichever rung produced it', () => {
    for (const method of ALL_METHODS) {
      const result = validateFacts(
        validFacts({ amountTotal: null, vatAmount: null }),
        extraction({ method, confidence: 'exact' }),
        clock,
      )
      expect(result.reviewStatus).toBe('needs_review')
    }
  })

  it('never returns reviewed — that status is a human act, not a validation outcome', () => {
    const clean = validateFacts(validFacts(), extraction({ confidence: 'exact' }), clock)
    const dirty = validateFacts(
      validFacts({ docDate: null, amountTotal: null, vatAmount: null }),
      extraction({ confidence: 'low' }),
      clock,
    )
    expect(clean.reviewStatus).not.toBe('reviewed')
    expect(dirty.reviewStatus).not.toBe('reviewed')
  })
})

// ---------------------------------------------------------------------------
// rejected, purity, and pass-through
// ---------------------------------------------------------------------------

describe('validateFacts — result shape and purity', () => {
  it('reports every failed field when a document fails several rules at once', () => {
    const result = validateFacts(
      validFacts({
        vendorPib: '12345678',
        docDate: AFTER_WINDOW,
        amountTotal: 0,
        vatAmount: 500,
        currency: 'JPY' as Currency,
      }),
      MODEL_RUNG,
      clock,
    )
    expect([...result.rejected].sort()).toEqual(
      ['amountTotal', 'currency', 'docDate', 'vatAmount', 'vendorPib'].sort(),
    )
    expect(result.facts).toEqual({
      vendorName: 'Maxi d.o.o.',
      vendorPib: null,
      docDate: null,
      amountNet: 1000,
      vatAmount: null,
      amountTotal: null,
      currency: null,
      lineItems: [],
    })
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns an empty rejected list when nothing failed', () => {
    const result = validateFacts(validFacts(), REGEX_RUNG, clock)
    expect(result.rejected).toEqual([])
  })

  it('does not list the same field twice', () => {
    const result = validateFacts(
      validFacts({ vendorPib: 'x', docDate: 'x', amountTotal: -5, currency: 'x' as Currency }),
      REGEX_RUNG,
      clock,
    )
    expect(new Set(result.rejected).size).toBe(result.rejected.length)
  })

  it('does not mutate the facts it was given', () => {
    const input = validFacts({ vendorPib: '12345678', amountTotal: 0, vatAmount: null })
    const snapshot = JSON.parse(JSON.stringify(input))
    validateFacts(input, REGEX_RUNG, clock)
    expect(input).toEqual(snapshot)
  })

  it('does not mutate the extraction it was given', () => {
    const rung = extraction({ method: 'llm_vision', confidence: 'low', model: 'm@1' })
    const snapshot = JSON.parse(JSON.stringify(rung))
    validateFacts(validFacts(), rung, clock)
    expect(rung).toEqual(snapshot)
  })

  it('returns the same answer when called twice with the same input', () => {
    const facts = validFacts({ vendorPib: '1234567890', amountTotal: 10_000_000 })
    const first = validateFacts(facts, MODEL_RUNG, clock)
    const second = validateFacts(facts, MODEL_RUNG, clock)
    expect(second).toEqual(first)
  })

  it('passes vendorName through untouched — no rule governs it', () => {
    const result = validateFacts(
      validFacts({ vendorName: '  ЕЛЕКТРОДИСТРИБУЦИЈА  ' }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.vendorName).toBe('  ЕЛЕКТРОДИСТРИБУЦИЈА  ')
    expect(result.rejected).not.toContain('vendorName')
  })

  it('passes line items through untouched', () => {
    const lineItems: LineItem[] = [
      { description: 'PAMPERS', quantity: 1, unitPrice: 1200, lineTotal: 1200 },
      { description: 'MLEKO', quantity: null, unitPrice: null, lineTotal: null },
    ]
    const result = validateFacts(
      validFacts({ lineItems, amountTotal: 2400 }),
      REGEX_RUNG,
      clock,
    )
    expect(result.facts.lineItems).toEqual(lineItems)
  })

  it('handles a fully empty fact set without throwing, and sends it to review', () => {
    const empty: ExtractedFacts = {
      vendorName: null,
      vendorPib: null,
      docDate: null,
      amountNet: null,
      vatAmount: null,
      amountTotal: null,
      currency: null,
      lineItems: [],
    }
    const result = validateFacts(empty, extraction({ confidence: 'low' }), clock)
    expect(result.facts).toEqual(empty)
    expect(result.rejected).toEqual([])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('reads the clock rather than the ambient system time', () => {
    let calls = 0
    const countingClock: Clock = {
      now: () => {
        calls += 1
        return new Date(NOW)
      },
    }
    const result = validateFacts(validFacts({ docDate: WINDOW_START }), REGEX_RUNG, countingClock)
    expect(calls).toBeGreaterThan(0)
    expect(result.facts.docDate).toBe(WINDOW_START)
  })
})
