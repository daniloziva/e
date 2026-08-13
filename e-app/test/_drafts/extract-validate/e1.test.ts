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
// Hand-written fakes. No mocking library: a Clock is one method returning a
// fixed instant, so a literal object is the whole fake.
// ---------------------------------------------------------------------------

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) })

/**
 * Anchored at UTC midnight on purpose: it makes "now - 18 months" and
 * "now + 2 days" land on exact date boundaries, so an inclusive-boundary
 * assertion means the same thing whether the implementation compares
 * whole dates or instants.
 *   now          = 2026-08-12
 *   lower bound  = 2025-02-12
 *   upper bound  = 2026-08-14
 */
const CLOCK = clockAt('2026-08-12T00:00:00.000Z')

const LOWER_BOUND = '2025-02-12'
const UPPER_BOUND = '2026-08-14'

const facts = (over: Partial<ExtractedFacts> = {}): ExtractedFacts => ({
  vendorName: 'Maxi d.o.o.',
  vendorPib: '123456789',
  docDate: '2026-08-01',
  amountNet: 1000,
  vatAmount: 200,
  amountTotal: 1200,
  currency: 'RSD',
  lineItems: [],
  ...over,
})

const extraction = (over: Partial<Extraction> = {}): Extraction => ({
  method: 'pdf_text',
  confidence: 'high',
  model: null,
  ...over,
})

/** `rejected` is a set of field names; its order is not part of the contract. */
const rejectedSet = (r: string[]): string[] => [...r].sort()

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

// ---------------------------------------------------------------------------

describe('validateFacts — the happy path', () => {
  it('passes clean facts through untouched and marks them ok', () => {
    const input = facts()
    const result = validateFacts(input, extraction({ confidence: 'high' }), CLOCK)

    expect(result.facts).toEqual(input)
    expect(result.rejected).toEqual([])
    expect(result.reviewStatus).toBe('ok')
  })

  it('does not mutate the facts it was given', () => {
    const input = facts({ vendorPib: '12345678', amountTotal: 0 })
    const snapshot = structuredClone(input)

    validateFacts(input, extraction(), CLOCK)

    expect(input).toEqual(snapshot)
  })

  it('leaves fields it has no rule for exactly as they arrived', () => {
    const lineItems: LineItem[] = [
      { description: 'PAMPERS', quantity: 2, unitPrice: 550, lineTotal: 1100 },
      { description: 'MLEKO', quantity: null, unitPrice: null, lineTotal: null },
    ]
    const result = validateFacts(
      facts({ vendorName: '   ', amountNet: 999999999, lineItems }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.vendorName).toBe('   ')
    expect(result.facts.amountNet).toBe(999999999)
    expect(result.facts.lineItems).toEqual(lineItems)
  })

  it('never returns the reviewed status — only a human can mark a fact reviewed', () => {
    const result = validateFacts(facts(), extraction({ confidence: 'exact' }), CLOCK)
    expect(result.reviewStatus).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 01 §5 / 03 §2: "the same validators regardless of source"
// ---------------------------------------------------------------------------

describe('validateFacts — applied identically to every ladder rung', () => {
  const dirty = facts({
    vendorPib: '1234567890',
    docDate: '2019-01-01',
    amountTotal: 0,
    vatAmount: 200,
    currency: 'EVRA' as unknown as Currency,
  })

  const reference = () => validateFacts(dirty, extraction({ method: 'pdf_text' }), CLOCK)

  it.each(ALL_METHODS.map((method) => ({ method })))(
    'produces the identical verdict for method $method as it does for regex output',
    ({ method }) => {
      const result = validateFacts(dirty, extraction({ method }), CLOCK)
      const expected = reference()

      expect(result.facts).toEqual(expected.facts)
      expect(rejectedSet(result.rejected)).toEqual(rejectedSet(expected.rejected))
      expect(result.reviewStatus).toBe(expected.reviewStatus)
    },
  )

  it('nulls a bad PIB from the LLM exactly as it nulls a bad PIB from a regex', () => {
    const bad = facts({ vendorPib: '12345678' })

    const fromRegex = validateFacts(bad, extraction({ method: 'pdf_text', model: null }), CLOCK)
    const fromModel = validateFacts(
      bad,
      extraction({ method: 'llm_vision', model: 'gpt-4o-mini@2026-05', raw: { pib: '12345678' } }),
      CLOCK,
    )

    expect(fromRegex.facts.vendorPib).toBeNull()
    expect(fromModel.facts.vendorPib).toBeNull()
    expect(fromModel.facts).toEqual(fromRegex.facts)
  })

  it('does not trust a manually entered amount any more than a photographed one', () => {
    const overLimit = facts({ amountTotal: 10_000_000 })

    const manual = validateFacts(overLimit, extraction({ method: 'manual', confidence: 'exact' }), CLOCK)
    const vision = validateFacts(overLimit, extraction({ method: 'llm_vision', confidence: 'exact' }), CLOCK)

    expect(manual.facts.amountTotal).toBeNull()
    expect(vision.facts.amountTotal).toBeNull()
  })

  it('does not trust a government-signed fiscal QR read any more than a guessed one', () => {
    const badDate = facts({ docDate: '2030-01-01' })

    const qr = validateFacts(badDate, extraction({ method: 'fiscal_qr', confidence: 'exact' }), CLOCK)

    expect(qr.facts.docDate).toBeNull()
    expect(qr.rejected).toContain('docDate')
  })

  it('ignores the raw model payload entirely when deciding', () => {
    const withRaw = validateFacts(
      facts(),
      extraction({ method: 'di_invoice', raw: { InvoiceTotal: { confidence: 0.12 } } }),
      CLOCK,
    )
    const withoutRaw = validateFacts(facts(), extraction({ method: 'di_invoice' }), CLOCK)

    expect(withRaw).toEqual(withoutRaw)
  })
})

// ---------------------------------------------------------------------------
// vendorPib — exactly 9 digits or null
// ---------------------------------------------------------------------------

describe('validateFacts — vendorPib is exactly 9 digits or nothing', () => {
  it('keeps a PIB of exactly 9 digits', () => {
    const result = validateFacts(facts({ vendorPib: '100205514' }), extraction(), CLOCK)

    expect(result.facts.vendorPib).toBe('100205514')
    expect(result.rejected).not.toContain('vendorPib')
  })

  it('keeps a 9-digit PIB with leading zeroes rather than treating it as a number', () => {
    const result = validateFacts(facts({ vendorPib: '000000123' }), extraction(), CLOCK)
    expect(result.facts.vendorPib).toBe('000000123')
  })

  it.each([
    { label: '8 digits — one short', pib: '12345678' },
    { label: '10 digits — one long', pib: '1234567890' },
    { label: '13 digits — a maticni broj, not a PIB', pib: '1234567890123' },
    { label: 'a single digit', pib: '1' },
    { label: 'letters', pib: 'ABCDEFGHI' },
    { label: 'nine characters of which one is a letter', pib: '12345678A' },
    { label: 'an OCR-mangled O for 0', pib: '1O3456789' },
    { label: 'digits with a separator', pib: '123-456-789' },
    { label: 'digits with spaces', pib: '123 456 789' },
    { label: 'a PIB with the SR prefix still attached', pib: 'SR123456789' },
    { label: 'a decimal that happens to have 9 characters', pib: '12345.789' },
    { label: 'the empty string', pib: '' },
    { label: 'whitespace only', pib: '   ' },
    { label: 'nine digits wrapped in whitespace', pib: ' 123456789 ' },
    { label: 'nine digits followed by a newline', pib: '123456789\n' },
  ])('returns null for a PIB that is $label', ({ pib }) => {
    const result = validateFacts(facts({ vendorPib: pib }), extraction(), CLOCK)

    expect(result.facts.vendorPib).toBeNull()
    expect(result.rejected).toContain('vendorPib')
  })

  it('accepts any 9 digits — it validates the shape, it does not verify the taxpayer', () => {
    const result = validateFacts(facts({ vendorPib: '111111111' }), extraction(), CLOCK)
    expect(result.facts.vendorPib).toBe('111111111')
  })

  it('leaves an absent PIB null without recording it as a rejection', () => {
    const result = validateFacts(facts({ vendorPib: null }), extraction(), CLOCK)

    expect(result.facts.vendorPib).toBeNull()
    expect(result.rejected).not.toContain('vendorPib')
  })

  it('does not send a document to review merely because the PIB was unreadable', () => {
    const result = validateFacts(
      facts({ vendorPib: 'not a pib' }),
      extraction({ confidence: 'high' }),
      CLOCK,
    )

    expect(result.facts.vendorPib).toBeNull()
    expect(result.reviewStatus).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// docDate — [now - 18 months, now + 2 days]
// ---------------------------------------------------------------------------

describe('validateFacts — docDate must fall inside the window the clock defines', () => {
  it('accepts a date in the middle of the window', () => {
    const result = validateFacts(facts({ docDate: '2026-03-15' }), extraction(), CLOCK)

    expect(result.facts.docDate).toBe('2026-03-15')
    expect(result.rejected).not.toContain('docDate')
  })

  it("accepts today's date", () => {
    const result = validateFacts(facts({ docDate: '2026-08-12' }), extraction(), CLOCK)
    expect(result.facts.docDate).toBe('2026-08-12')
  })

  it('accepts the earliest date in the window exactly — 18 months back to the day', () => {
    const result = validateFacts(facts({ docDate: LOWER_BOUND }), extraction(), CLOCK)

    expect(result.facts.docDate).toBe(LOWER_BOUND)
    expect(result.rejected).not.toContain('docDate')
  })

  it('rejects the day before the earliest date in the window', () => {
    const result = validateFacts(facts({ docDate: '2025-02-11' }), extraction(), CLOCK)

    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('accepts the latest date in the window exactly — two days ahead', () => {
    const result = validateFacts(facts({ docDate: UPPER_BOUND }), extraction(), CLOCK)

    expect(result.facts.docDate).toBe(UPPER_BOUND)
    expect(result.rejected).not.toContain('docDate')
  })

  it('rejects the day after the latest date in the window', () => {
    const result = validateFacts(facts({ docDate: '2026-08-15' }), extraction(), CLOCK)

    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('accepts tomorrow, because a supplier invoice can be dated a day ahead', () => {
    const result = validateFacts(facts({ docDate: '2026-08-13' }), extraction(), CLOCK)
    expect(result.facts.docDate).toBe('2026-08-13')
  })

  it.each([
    { label: 'a receipt from before the window', date: '2019-01-01' },
    { label: 'a year misread as 2020 by OCR', date: '2020-08-12' },
    { label: 'a date far in the future', date: '2030-12-31' },
    { label: 'the Unix epoch', date: '1970-01-01' },
  ])('returns null for $label', ({ date }) => {
    const result = validateFacts(facts({ docDate: date }), extraction(), CLOCK)

    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('walks the window forward when the clock moves — the same date passes today and fails later', () => {
    const date = '2025-02-12'

    const today = validateFacts(facts({ docDate: date }), extraction(), clockAt('2026-08-12T00:00:00.000Z'))
    const tomorrow = validateFacts(facts({ docDate: date }), extraction(), clockAt('2026-08-13T00:00:00.000Z'))

    expect(today.facts.docDate).toBe(date)
    expect(tomorrow.facts.docDate).toBeNull()
  })

  it('reads the clock rather than the host system date', () => {
    const result = validateFacts(
      facts({ docDate: '2024-06-30' }),
      extraction(),
      clockAt('2024-07-01T00:00:00.000Z'),
    )

    expect(result.facts.docDate).toBe('2024-06-30')
    expect(result.reviewStatus).toBe('ok')
  })

  it('clamps the 18-month subtraction to the last real day of a short month', () => {
    // 2026-08-31 minus 18 months has no 31st in February 2025.
    const shortMonthClock = clockAt('2026-08-31T00:00:00.000Z')

    const onBoundary = validateFacts(facts({ docDate: '2025-02-28' }), extraction(), shortMonthClock)
    const dayBefore = validateFacts(facts({ docDate: '2025-02-27' }), extraction(), shortMonthClock)

    expect(onBoundary.facts.docDate).toBe('2025-02-28')
    expect(dayBefore.facts.docDate).toBeNull()
  })

  it('spans a leap day without drifting', () => {
    const leapClock = clockAt('2025-08-29T00:00:00.000Z')
    const result = validateFacts(facts({ docDate: '2024-02-29' }), extraction(), leapClock)

    expect(result.facts.docDate).toBe('2024-02-29')
  })
})

describe('validateFacts — docDate must be a well-formed YYYY-MM-DD', () => {
  it.each([
    { label: 'a Serbian-style date', date: '12.08.2026' },
    { label: 'a slashed US-style date', date: '08/12/2026' },
    { label: 'an unpadded month and day', date: '2026-8-1' },
    { label: 'a month that does not exist', date: '2026-13-01' },
    { label: 'a day that does not exist in that month', date: '2026-02-30' },
    { label: 'a zero day', date: '2026-08-00' },
    { label: 'a February 29 in a non-leap year', date: '2026-02-29' },
    { label: 'a year and month only', date: '2026-08' },
    { label: 'a full ISO timestamp rather than a plain date', date: '2026-08-12T09:30:00Z' },
    { label: 'prose', date: 'juce' },
    { label: 'the empty string', date: '' },
    { label: 'whitespace', date: '  ' },
    { label: 'a date wrapped in whitespace', date: ' 2026-08-12 ' },
  ])('returns null for $label rather than guessing what was meant', ({ date }) => {
    const result = validateFacts(facts({ docDate: date }), extraction(), CLOCK)

    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).toContain('docDate')
  })

  it('leaves an absent date null without recording it as a rejection', () => {
    const result = validateFacts(facts({ docDate: null }), extraction(), CLOCK)

    expect(result.facts.docDate).toBeNull()
    expect(result.rejected).not.toContain('docDate')
  })
})

// ---------------------------------------------------------------------------
// amountTotal — 0 < x < 10_000_000, both ends exclusive
// ---------------------------------------------------------------------------

describe('validateFacts — amountTotal bounds are exclusive at both ends', () => {
  it('rejects exactly zero, because absence is null and never a zero', () => {
    const result = validateFacts(facts({ amountTotal: 0 }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it('accepts the smallest amount above zero', () => {
    const result = validateFacts(facts({ amountTotal: 0.01, vatAmount: null }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBe(0.01)
    expect(result.rejected).not.toContain('amountTotal')
  })

  it('rejects exactly ten million', () => {
    const result = validateFacts(facts({ amountTotal: 10_000_000 }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it('accepts the largest amount below ten million', () => {
    const result = validateFacts(facts({ amountTotal: 9_999_999.99 }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBe(9_999_999.99)
    expect(result.rejected).not.toContain('amountTotal')
  })

  it.each([
    { label: 'a negative total', amount: -1200 },
    { label: 'a hair below zero', amount: -0.01 },
    { label: 'negative zero', amount: -0 },
    { label: 'a hair above ten million', amount: 10_000_000.01 },
    { label: 'a decimal point misread as a thousands separator', amount: 120_000_000 },
    { label: 'NaN', amount: Number.NaN },
    { label: 'Infinity', amount: Number.POSITIVE_INFINITY },
    { label: 'negative Infinity', amount: Number.NEGATIVE_INFINITY },
  ])('returns null for $label', ({ amount }) => {
    const result = validateFacts(facts({ amountTotal: amount, vatAmount: null }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).toContain('amountTotal')
  })

  it('leaves an absent total null without recording it as a rejection', () => {
    const result = validateFacts(facts({ amountTotal: null, vatAmount: null }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.rejected).not.toContain('amountTotal')
  })

  it('nulls an out-of-range total instead of clamping it to the limit', () => {
    const result = validateFacts(facts({ amountTotal: 50_000_000, vatAmount: null }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.amountTotal).not.toBe(10_000_000)
  })
})

// ---------------------------------------------------------------------------
// vatAmount — drop the VAT only
// ---------------------------------------------------------------------------

describe('validateFacts — an impossible VAT costs only the VAT', () => {
  it('drops the VAT and keeps everything else when the VAT exceeds the total', () => {
    const result = validateFacts(
      facts({ amountTotal: 1200, vatAmount: 1500, amountNet: 1000 }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
    expect(result.facts.amountNet).toBe(1000)
    expect(result.facts.vendorPib).toBe('123456789')
    expect(rejectedSet(result.rejected)).toEqual(['vatAmount'])
  })

  it('keeps a VAT that is exactly equal to the total', () => {
    const result = validateFacts(facts({ amountTotal: 1200, vatAmount: 1200 }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBe(1200)
    expect(result.rejected).not.toContain('vatAmount')
  })

  it('drops a VAT that exceeds the total by the smallest measurable amount', () => {
    const result = validateFacts(facts({ amountTotal: 1200, vatAmount: 1200.01 }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
  })

  it('keeps a plausible 20 percent Serbian VAT', () => {
    const result = validateFacts(
      facts({ amountNet: 1000, vatAmount: 200, amountTotal: 1200 }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.vatAmount).toBe(200)
    expect(result.rejected).toEqual([])
  })

  it('keeps a zero VAT, which is a real fact for a non-VAT supplier', () => {
    const result = validateFacts(facts({ vatAmount: 0 }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBe(0)
    expect(result.rejected).not.toContain('vatAmount')
  })

  it('leaves an absent VAT null without recording it as a rejection', () => {
    const result = validateFacts(facts({ vatAmount: null }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBeNull()
    expect(result.rejected).not.toContain('vatAmount')
  })

  it.each([
    { label: 'a negative VAT', vat: -200 },
    { label: 'a VAT of NaN', vat: Number.NaN },
    { label: 'a VAT of Infinity', vat: Number.POSITIVE_INFINITY },
  ])('drops $label without touching the total', ({ vat }) => {
    const result = validateFacts(facts({ amountTotal: 1200, vatAmount: vat }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
    expect(result.rejected).toContain('vatAmount')
  })

  it('drops the VAT and the total independently when both are wrong', () => {
    const result = validateFacts(facts({ amountTotal: 0, vatAmount: 200 }), extraction(), CLOCK)

    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.vatAmount).toBeNull()
    expect(rejectedSet(result.rejected)).toEqual(['amountTotal', 'vatAmount'])
  })

  it('keeps a VAT that no total contradicts, because nothing has proved it wrong', () => {
    const result = validateFacts(facts({ amountTotal: null, vatAmount: 200 }), extraction(), CLOCK)

    expect(result.facts.vatAmount).toBe(200)
    expect(result.rejected).not.toContain('vatAmount')
  })

  it('never repairs the total from the VAT it just dropped', () => {
    const result = validateFacts(
      facts({ amountNet: 1000, vatAmount: 5000, amountTotal: 1200 }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.amountTotal).toBe(1200)
    expect(result.facts.amountNet).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// currency allowlist
// ---------------------------------------------------------------------------

describe('validateFacts — currency comes from the allowlist or nowhere', () => {
  it.each(ALL_CURRENCIES.map((currency) => ({ currency })))(
    'keeps the allowed currency $currency',
    ({ currency }) => {
      const result = validateFacts(facts({ currency }), extraction(), CLOCK)

      expect(result.facts.currency).toBe(currency)
      expect(result.rejected).not.toContain('currency')
    },
  )

  it.each([
    { label: 'a currency outside the allowlist', currency: 'JPY' },
    { label: 'a Serbian word for euros the model failed to resolve', currency: 'EVRA' },
    { label: 'a colloquial dinar', currency: 'DIN' },
    { label: 'a currency symbol', currency: '€' },
    { label: 'a lowercase code', currency: 'eur' },
    { label: 'a mixed-case code', currency: 'Rsd' },
    { label: 'a code padded with whitespace', currency: ' EUR' },
    { label: 'a four-letter code', currency: 'EURO' },
    { label: 'the empty string', currency: '' },
  ])('returns null for $label', ({ currency }) => {
    const result = validateFacts(
      facts({ currency: currency as unknown as Currency }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.currency).toBeNull()
    expect(result.rejected).toContain('currency')
  })

  it('leaves an absent currency null without recording it as a rejection', () => {
    const result = validateFacts(facts({ currency: null }), extraction(), CLOCK)

    expect(result.facts.currency).toBeNull()
    expect(result.rejected).not.toContain('currency')
  })

  it('does not fall back to RSD when the currency is unrecognised', () => {
    const result = validateFacts(
      facts({ currency: 'EVRA' as unknown as Currency }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.currency).toBeNull()
    expect(result.facts.currency).not.toBe('RSD')
  })

  it('keeps a valid amount even when its currency is unrecognised', () => {
    const result = validateFacts(
      facts({ amountTotal: 1200, currency: 'JPY' as unknown as Currency }),
      extraction(),
      CLOCK,
    )

    expect(result.facts.amountTotal).toBe(1200)
    expect(result.facts.currency).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// needs_review triggers
// ---------------------------------------------------------------------------

describe('validateFacts — what sends a document to the review queue', () => {
  it('flags a document whose total was never read', () => {
    const result = validateFacts(
      facts({ amountTotal: null, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      CLOCK,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags a document whose total was read but failed validation', () => {
    const result = validateFacts(
      facts({ amountTotal: 10_000_000, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      CLOCK,
    )

    expect(result.facts.amountTotal).toBeNull()
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags a document whose date was never read', () => {
    const result = validateFacts(
      facts({ docDate: null }),
      extraction({ confidence: 'exact' }),
      CLOCK,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags a document whose date fell outside the window', () => {
    const result = validateFacts(
      facts({ docDate: '2019-01-01' }),
      extraction({ confidence: 'exact' }),
      CLOCK,
    )

    expect(result.facts.docDate).toBeNull()
    expect(result.reviewStatus).toBe('needs_review')
  })

  it.each([
    { confidence: 'exact' as Confidence, expected: 'ok' },
    { confidence: 'high' as Confidence, expected: 'ok' },
    { confidence: 'medium' as Confidence, expected: 'needs_review' },
    { confidence: 'low' as Confidence, expected: 'needs_review' },
  ])('returns $expected for otherwise clean facts at $confidence confidence', ({ confidence, expected }) => {
    const result = validateFacts(facts(), extraction({ confidence }), CLOCK)

    expect(result.reviewStatus).toBe(expected)
  })

  it('flags low-confidence facts even though nothing failed validation', () => {
    const result = validateFacts(facts(), extraction({ confidence: 'low' }), CLOCK)

    expect(result.rejected).toEqual([])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('does not flag a document merely because its PIB and currency were unreadable', () => {
    const result = validateFacts(
      facts({ vendorPib: 'XX', currency: 'EVRA' as unknown as Currency }),
      extraction({ confidence: 'high' }),
      CLOCK,
    )

    expect(rejectedSet(result.rejected)).toEqual(['currency', 'vendorPib'])
    expect(result.reviewStatus).toBe('ok')
  })

  it('does not flag a document merely because its VAT was dropped', () => {
    const result = validateFacts(
      facts({ amountTotal: 1200, vatAmount: 9999 }),
      extraction({ confidence: 'high' }),
      CLOCK,
    )

    expect(result.rejected).toEqual(['vatAmount'])
    expect(result.reviewStatus).toBe('ok')
  })

  it('flags a completely empty extraction rather than rejecting it', () => {
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

    const result = validateFacts(empty, extraction({ method: 'manual', confidence: 'low' }), CLOCK)

    expect(result.facts).toEqual(empty)
    expect(result.rejected).toEqual([])
    expect(result.reviewStatus).toBe('needs_review')
  })
})

// ---------------------------------------------------------------------------
// The whole thing at once
// ---------------------------------------------------------------------------

describe('validateFacts — a fully mangled read', () => {
  it('nulls every failing field, names each one, and queues the document', () => {
    const result = validateFacts(
      facts({
        vendorName: 'НЕЧИТЉИВО',
        vendorPib: '1234567',
        docDate: '31.02.2026',
        amountNet: 40,
        vatAmount: 50,
        amountTotal: 0,
        currency: 'EVRA' as unknown as Currency,
      }),
      extraction({ method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' }),
      CLOCK,
    )

    expect(result.facts.vendorName).toBe('НЕЧИТЉИВО')
    expect(result.facts.vendorPib).toBeNull()
    expect(result.facts.docDate).toBeNull()
    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.currency).toBeNull()
    expect(rejectedSet(result.rejected)).toEqual([
      'amountTotal',
      'currency',
      'docDate',
      'vatAmount',
      'vendorPib',
    ])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('names each failing field exactly once', () => {
    const result = validateFacts(
      facts({ amountTotal: -5, vatAmount: 10 }),
      extraction(),
      CLOCK,
    )

    expect(new Set(result.rejected).size).toBe(result.rejected.length)
  })

  it('returns the same verdict for the same input every time it is called', () => {
    const input = facts({ vendorPib: '12345678', docDate: '2025-02-12', amountTotal: 9_999_999.99 })

    const first = validateFacts(input, extraction(), CLOCK)
    const second = validateFacts(input, extraction(), CLOCK)

    expect(first).toEqual(second)
  })
})
