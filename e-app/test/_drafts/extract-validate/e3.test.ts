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
// Hand-written fakes. No mocking library: a Clock is one method with a fixed
// answer, which is the whole point of injecting it.
// ---------------------------------------------------------------------------

function fixedClock(iso: string): Clock {
  const instant = new Date(iso)
  return { now: () => new Date(instant.getTime()) }
}

/**
 * Midnight UTC on 2026-08-12.
 *  - lower bound  now - 18 months = 2025-02-12
 *  - upper bound  now +  2 days   = 2026-08-14
 */
const NOW_ISO = '2026-08-12T00:00:00.000Z'
const clock = fixedClock(NOW_ISO)

const LOWER_BOUND = '2025-02-12'
const DAY_BEFORE_LOWER_BOUND = '2025-02-11'
const UPPER_BOUND = '2026-08-14'
const DAY_AFTER_UPPER_BOUND = '2026-08-15'

function facts(overrides: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    vendorName: 'Maxi d.o.o.',
    vendorPib: '123456789',
    docDate: '2026-07-15',
    amountNet: 1000,
    vatAmount: 200,
    amountTotal: 1200,
    currency: 'RSD',
    lineItems: [],
    ...overrides,
  }
}

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return { method: 'pdf_text', confidence: 'high', model: null, ...overrides }
}

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

const ALLOWED_CURRENCIES: Currency[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

/** Order of `rejected` is not part of the contract; content is. */
function rejected(result: { rejected: string[] }): string[] {
  return [...result.rejected].sort()
}

// ---------------------------------------------------------------------------

describe('validateFacts — happy path', () => {
  it('passes clean facts through untouched and marks them ok', () => {
    const input = facts()
    const result = validateFacts(input, extraction(), clock)

    expect(result.facts).toEqual(input)
    expect(result.reviewStatus).toBe('ok')
    expect(result.rejected).toEqual([])
  })

  it('keeps line items verbatim, since it validates money and identity, not descriptions', () => {
    const lineItems: LineItem[] = [
      { description: 'PAMPERS 4', quantity: 2, unitPrice: 1200, lineTotal: 2400 },
      { description: '', quantity: null, unitPrice: null, lineTotal: null },
    ]
    const result = validateFacts(facts({ lineItems }), extraction(), clock)

    expect(result.facts.lineItems).toEqual(lineItems)
  })

  it('leaves amountNet alone even when it disagrees with net plus VAT, because no rule governs it', () => {
    const result = validateFacts(
      facts({ amountNet: 999, vatAmount: 200, amountTotal: 1200 }),
      extraction(),
      clock,
    )

    expect(result.facts.amountNet).toBe(999)
    expect(rejected(result)).toEqual([])
  })

  it('leaves vendorName alone however odd it looks, because no rule governs it', () => {
    const result = validateFacts(facts({ vendorName: '   ' }), extraction(), clock)

    expect(result.facts.vendorName).toBe('   ')
    expect(rejected(result)).toEqual([])
  })

  it('never mutates the facts object it was given', () => {
    const input = facts({ vendorPib: '12345678', amountTotal: 0 })
    const snapshot = structuredClone(input)

    validateFacts(input, extraction(), clock)

    expect(input).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// The central claim of §5: the same validator, applied identically, whatever
// produced the facts.
// ---------------------------------------------------------------------------

describe('validateFacts — applied identically to every ladder rung', () => {
  const dirty = facts({
    vendorPib: '12345678',
    docDate: '2030-01-01',
    amountTotal: 12_000_000,
    vatAmount: 400,
    currency: 'JPY' as Currency,
  })

  it.each(ALL_METHODS)('applies the same rules when the method is %s', (method) => {
    const result = validateFacts(dirty, extraction({ method }), clock)

    expect(result.facts.vendorPib).toBeNull()
    expect(result.facts.docDate).toBeNull()
    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.currency).toBeNull()
    expect(rejected(result)).toEqual(['amountTotal', 'currency', 'docDate', 'vendorPib'])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it.each(ALL_METHODS)('produces a result identical to the regex rung for %s', (method) => {
    const baseline = validateFacts(dirty, extraction({ method: 'pdf_text' }), clock)
    const result = validateFacts(dirty, extraction({ method }), clock)

    expect(result).toEqual(baseline)
  })

  it('does not trust an LLM rung less than a regex rung when both claim the same confidence', () => {
    const clean = facts()
    const regex = validateFacts(clean, extraction({ method: 'pdf_text', confidence: 'high' }), clock)
    const llm = validateFacts(
      clean,
      extraction({ method: 'llm_vision', confidence: 'high', model: 'gpt-4o-mini@2026-05' }),
      clock,
    )

    expect(llm).toEqual(regex)
    expect(llm.reviewStatus).toBe('ok')
  })

  it('does not trust a fiscal QR rung more than a model rung when its confidence is low', () => {
    const result = validateFacts(facts(), extraction({ method: 'fiscal_qr', confidence: 'low' }), clock)

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('ignores the model identifier entirely', () => {
    const withModel = validateFacts(
      facts(),
      extraction({ method: 'llm_vision', model: 'some-model@2099-01' }),
      clock,
    )
    const withoutModel = validateFacts(facts(), extraction({ method: 'llm_vision', model: null }), clock)

    expect(withModel).toEqual(withoutModel)
  })

  it('ignores the raw provider payload', () => {
    const withRaw = validateFacts(
      facts(),
      { ...extraction(), raw: { InvoiceTotal: { confidence: 0.2 } } },
      clock,
    )

    expect(withRaw).toEqual(validateFacts(facts(), extraction(), clock))
  })
})

// ---------------------------------------------------------------------------
// PIB — exactly nine digits, or nothing.
// ---------------------------------------------------------------------------

describe('validateFacts — vendorPib', () => {
  it('accepts a PIB of exactly nine digits', () => {
    const result = validateFacts(facts({ vendorPib: '100002455' }), extraction(), clock)

    expect(result.facts.vendorPib).toBe('100002455')
    expect(rejected(result)).toEqual([])
  })

  it('accepts nine digits that begin with a zero, keeping it as text', () => {
    const result = validateFacts(facts({ vendorPib: '012345678' }), extraction(), clock)

    expect(result.facts.vendorPib).toBe('012345678')
  })

  it('accepts nine zeroes, because no checksum rule is specified', () => {
    const result = validateFacts(facts({ vendorPib: '000000000' }), extraction(), clock)

    expect(result.facts.vendorPib).toBe('000000000')
  })

  it('returns null for a PIB of eight digits', () => {
    const result = validateFacts(facts({ vendorPib: '12345678' }), extraction(), clock)

    expect(result.facts.vendorPib).toBeNull()
    expect(rejected(result)).toEqual(['vendorPib'])
  })

  it('returns null for a PIB of ten digits', () => {
    const result = validateFacts(facts({ vendorPib: '1234567890' }), extraction(), clock)

    expect(result.facts.vendorPib).toBeNull()
    expect(rejected(result)).toEqual(['vendorPib'])
  })

  it.each([
    ['seven digits', '1234567'],
    ['one digit', '1'],
    ['twelve digits', '123456789012'],
    ['letters mixed in', '12345678A'],
    ['a letter O standing in for a zero', '1234567O9'],
    ['punctuation separators', '123-456-789'],
    ['dotted separators', '123.456.789'],
    ['a PIB prefix', 'PIB:123456789'],
    ['an internal space', '123 456 789'],
    ['leading and trailing whitespace', ' 123456789 '],
    ['a newline', '123456789\n'],
    ['a decimal point', '123456.89'],
    ['a plus sign', '+123456789'],
    ['non-ASCII digits', '١٢٣٤٥٦٧٨٩'],
    ['full-width digits', '１２３４５６７８９'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns null when the PIB has %s', (_label, pib) => {
    const result = validateFacts(facts({ vendorPib: pib }), extraction(), clock)

    expect(result.facts.vendorPib).toBeNull()
    expect(rejected(result)).toEqual(['vendorPib'])
  })

  it('leaves an absent PIB null without reporting it as rejected', () => {
    const result = validateFacts(facts({ vendorPib: null }), extraction(), clock)

    expect(result.facts.vendorPib).toBeNull()
    expect(rejected(result)).toEqual([])
  })

  it('does not send a document to review just because the PIB was unreadable', () => {
    const result = validateFacts(
      facts({ vendorPib: 'nonsense' }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('ok')
    expect(rejected(result)).toEqual(['vendorPib'])
  })
})

// ---------------------------------------------------------------------------
// docDate — the window, both edges, exactly.
// ---------------------------------------------------------------------------

describe('validateFacts — docDate window', () => {
  it('accepts a date in the middle of the window', () => {
    const result = validateFacts(facts({ docDate: '2026-01-31' }), extraction(), clock)

    expect(result.facts.docDate).toBe('2026-01-31')
    expect(rejected(result)).toEqual([])
  })

  it('accepts a date exactly eighteen months before now', () => {
    const result = validateFacts(facts({ docDate: LOWER_BOUND }), extraction(), clock)

    expect(result.facts.docDate).toBe(LOWER_BOUND)
    expect(rejected(result)).toEqual([])
  })

  it('returns null for the day before the eighteen-month boundary', () => {
    const result = validateFacts(facts({ docDate: DAY_BEFORE_LOWER_BOUND }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
    expect(rejected(result)).toEqual(['docDate'])
  })

  it('accepts a date exactly two days after now', () => {
    const result = validateFacts(facts({ docDate: UPPER_BOUND }), extraction(), clock)

    expect(result.facts.docDate).toBe(UPPER_BOUND)
    expect(rejected(result)).toEqual([])
  })

  it('returns null for the day after the two-day boundary', () => {
    const result = validateFacts(facts({ docDate: DAY_AFTER_UPPER_BOUND }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
    expect(rejected(result)).toEqual(['docDate'])
  })

  it('accepts today', () => {
    const result = validateFacts(facts({ docDate: '2026-08-12' }), extraction(), clock)

    expect(result.facts.docDate).toBe('2026-08-12')
  })

  it('accepts tomorrow', () => {
    const result = validateFacts(facts({ docDate: '2026-08-13' }), extraction(), clock)

    expect(result.facts.docDate).toBe('2026-08-13')
  })

  it('returns null for a date years in the future rather than assuming a typo', () => {
    const result = validateFacts(facts({ docDate: '2030-01-01' }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
  })

  it('returns null for a date years in the past rather than assuming a typo', () => {
    const result = validateFacts(facts({ docDate: '2019-06-30' }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
  })

  it('treats the boundary as a calendar day, not an instant, when the clock is mid-afternoon', () => {
    const afternoon = fixedClock('2026-08-12T15:30:00.000Z')
    const result = validateFacts(facts({ docDate: LOWER_BOUND }), extraction(), afternoon)

    expect(result.facts.docDate).toBe(LOWER_BOUND)
  })

  it('reads the window from the injected clock and never from system time', () => {
    const longAgo = fixedClock('2020-06-15T00:00:00.000Z')

    const contemporary = validateFacts(facts({ docDate: '2020-01-10' }), extraction(), longAgo)
    const currentEra = validateFacts(facts({ docDate: '2026-07-15' }), extraction(), longAgo)

    expect(contemporary.facts.docDate).toBe('2020-01-10')
    expect(currentEra.facts.docDate).toBeNull()
  })

  it('handles a leap day inside the window', () => {
    const result = validateFacts(facts({ docDate: '2026-02-28' }), extraction(), clock)

    expect(result.facts.docDate).toBe('2026-02-28')
  })

  it('leaves an absent date null without reporting it as rejected', () => {
    const result = validateFacts(facts({ docDate: null }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
    expect(rejected(result)).toEqual([])
  })
})

describe('validateFacts — docDate parsing refusals', () => {
  it.each([
    ['free text', 'not a date'],
    ['an empty string', ''],
    ['whitespace only', '  '],
    ['a month of 13', '2026-13-01'],
    ['a month of 00', '2026-00-10'],
    ['a day of 00', '2026-07-00'],
    ['a day of 32', '2026-07-32'],
    ['a day that does not exist in that month', '2026-02-30'],
    ['a non-leap February 29', '2026-02-29'],
    ['a European day-first format', '15.07.2026'],
    ['a slashed ambiguous format', '12/08/2026'],
    ['unpadded month and day', '2026-8-1'],
    ['a full ISO timestamp rather than a date', '2026-07-15T10:30:00Z'],
    ['a bare year', '2026'],
    ['a bare year and month', '2026-07'],
    ['a Unix epoch number as text', '1786000000'],
    ['trailing text', '2026-07-15 (approx)'],
    ['leading whitespace', ' 2026-07-15'],
  ])('returns null rather than guessing when the date is %s', (_label, docDate) => {
    const result = validateFacts(facts({ docDate }), extraction(), clock)

    expect(result.facts.docDate).toBeNull()
    expect(rejected(result)).toEqual(['docDate'])
  })

  it('sends a document with an unparseable date to review', () => {
    const result = validateFacts(
      facts({ docDate: '31.31.2026' }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })
})

// ---------------------------------------------------------------------------
// amountTotal — both bounds exclusive.
// ---------------------------------------------------------------------------

describe('validateFacts — amountTotal bounds', () => {
  it('accepts an ordinary total', () => {
    const result = validateFacts(facts({ amountTotal: 4210 }), extraction(), clock)

    expect(result.facts.amountTotal).toBe(4210)
    expect(rejected(result)).toEqual([])
  })

  it('accepts the smallest representable amount above zero', () => {
    const result = validateFacts(
      facts({ amountTotal: 0.01, vatAmount: null, amountNet: null }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBe(0.01)
    expect(rejected(result)).toEqual([])
  })

  it('returns null for a total of exactly zero, because zero never means an amount', () => {
    const result = validateFacts(
      facts({ amountTotal: 0, vatAmount: null, amountNet: null }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBeNull()
    expect(rejected(result)).toEqual(['amountTotal'])
  })

  it('accepts a total just below ten million', () => {
    const result = validateFacts(
      facts({ amountTotal: 9_999_999.99, vatAmount: null }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBe(9_999_999.99)
    expect(rejected(result)).toEqual([])
  })

  it('returns null for a total of exactly ten million', () => {
    const result = validateFacts(
      facts({ amountTotal: 10_000_000, vatAmount: null }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBeNull()
    expect(rejected(result)).toEqual(['amountTotal'])
  })

  it.each([
    ['negative', -1],
    ['negative and small', -0.01],
    ['negative zero', -0],
    ['just over ten million', 10_000_000.01],
    ['a hundred million', 100_000_000],
    ['not a number', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('returns null when the total is %s', (_label, amountTotal) => {
    const result = validateFacts(
      facts({ amountTotal, vatAmount: null }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBeNull()
    expect(rejected(result)).toEqual(['amountTotal'])
  })

  it('leaves an absent total null without reporting it as rejected', () => {
    const result = validateFacts(facts({ amountTotal: null, vatAmount: null }), extraction(), clock)

    expect(result.facts.amountTotal).toBeNull()
    expect(rejected(result)).toEqual([])
  })

  it('does not touch the date or the vendor when only the total is out of bounds', () => {
    const result = validateFacts(
      facts({ amountTotal: 50_000_000, vatAmount: null }),
      extraction(),
      clock,
    )

    expect(result.facts.docDate).toBe('2026-07-15')
    expect(result.facts.vendorPib).toBe('123456789')
    expect(result.facts.currency).toBe('RSD')
  })
})

// ---------------------------------------------------------------------------
// VAT — the surgical rule: drop the VAT, keep the total.
// ---------------------------------------------------------------------------

describe('validateFacts — vatAmount against amountTotal', () => {
  it('accepts VAT below the total', () => {
    const result = validateFacts(facts({ vatAmount: 200, amountTotal: 1200 }), extraction(), clock)

    expect(result.facts.vatAmount).toBe(200)
    expect(rejected(result)).toEqual([])
  })

  it('accepts VAT exactly equal to the total', () => {
    const result = validateFacts(facts({ vatAmount: 1200, amountTotal: 1200 }), extraction(), clock)

    expect(result.facts.vatAmount).toBe(1200)
    expect(rejected(result)).toEqual([])
  })

  it('accepts VAT one cent below the total', () => {
    const result = validateFacts(facts({ vatAmount: 1199.99, amountTotal: 1200 }), extraction(), clock)

    expect(result.facts.vatAmount).toBe(1199.99)
    expect(rejected(result)).toEqual([])
  })

  it('drops only the VAT when it is one cent above the total', () => {
    const result = validateFacts(facts({ vatAmount: 1200.01, amountTotal: 1200 }), extraction(), clock)

    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(1200)
    expect(rejected(result)).toEqual(['vatAmount'])
  })

  it('drops only the VAT when the two were plainly swapped in the read', () => {
    const result = validateFacts(
      facts({ amountNet: 1000, vatAmount: 1200, amountTotal: 200 }),
      extraction(),
      clock,
    )

    expect(result.facts.vatAmount).toBeNull()
    expect(result.facts.amountTotal).toBe(200)
    expect(result.facts.amountNet).toBe(1000)
    expect(rejected(result)).toEqual(['vatAmount'])
  })

  it('keeps a document out of review when only the VAT was dropped', () => {
    const result = validateFacts(
      facts({ vatAmount: 99_999, amountTotal: 1200 }),
      extraction({ confidence: 'high' }),
      clock,
    )

    expect(result.reviewStatus).toBe('ok')
    expect(rejected(result)).toEqual(['vatAmount'])
  })

  it('drops the VAT when the total was itself rejected, since nothing can vouch for it', () => {
    const result = validateFacts(
      facts({ vatAmount: 200, amountTotal: 20_000_000 }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBeNull()
    expect(result.facts.vatAmount).toBeNull()
    expect(rejected(result)).toEqual(['amountTotal', 'vatAmount'])
  })

  it('drops the VAT when there was never a total to compare it against', () => {
    const result = validateFacts(facts({ vatAmount: 200, amountTotal: null }), extraction(), clock)

    expect(result.facts.vatAmount).toBeNull()
  })

  it('leaves an absent VAT null without reporting it as rejected', () => {
    const result = validateFacts(facts({ vatAmount: null }), extraction(), clock)

    expect(result.facts.vatAmount).toBeNull()
    expect(rejected(result)).toEqual([])
  })

  it('accepts a VAT of zero, which is what an exempt invoice reads', () => {
    const result = validateFacts(facts({ vatAmount: 0, amountTotal: 1200 }), extraction(), clock)

    expect(result.facts.vatAmount).toBe(0)
    expect(rejected(result)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Currency allowlist.
// ---------------------------------------------------------------------------

describe('validateFacts — currency allowlist', () => {
  it.each(ALLOWED_CURRENCIES)('accepts %s', (currency) => {
    const result = validateFacts(facts({ currency }), extraction(), clock)

    expect(result.facts.currency).toBe(currency)
    expect(rejected(result)).toEqual([])
  })

  it.each([
    ['an unlisted ISO code', 'JPY'],
    ['a former currency', 'YUM'],
    ['a lowercase code', 'rsd'],
    ['a mixed-case code', 'Eur'],
    ['a symbol', '€'],
    ['a spelled-out name', 'EURO'],
    ['the local word for the currency', 'DIN'],
    ['a code with whitespace', ' EUR'],
    ['a four-letter code', 'EURO '],
    ['an empty string', ''],
    ['a number', '978'],
  ])('returns null when the currency is %s', (_label, currency) => {
    const result = validateFacts(facts({ currency: currency as Currency }), extraction(), clock)

    expect(result.facts.currency).toBeNull()
    expect(rejected(result)).toEqual(['currency'])
  })

  it('leaves an absent currency null without reporting it as rejected', () => {
    const result = validateFacts(facts({ currency: null }), extraction(), clock)

    expect(result.facts.currency).toBeNull()
    expect(rejected(result)).toEqual([])
  })

  it('does not send a document to review just because the currency was unrecognised', () => {
    const result = validateFacts(
      facts({ currency: 'JPY' as Currency }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('ok')
    expect(rejected(result)).toEqual(['currency'])
  })

  it('keeps the amount when only the currency is unrecognised, so the number is not lost', () => {
    const result = validateFacts(
      facts({ amountTotal: 1200, currency: 'JPY' as Currency }),
      extraction(),
      clock,
    )

    expect(result.facts.amountTotal).toBe(1200)
  })
})

// ---------------------------------------------------------------------------
// needs_review.
// ---------------------------------------------------------------------------

describe('validateFacts — review status', () => {
  it.each<[Confidence, string]>([
    ['exact', 'ok'],
    ['high', 'ok'],
    ['medium', 'needs_review'],
    ['low', 'needs_review'],
  ])('returns %s facts as %s when every field is valid', (confidence, expected) => {
    const result = validateFacts(facts(), extraction({ confidence }), clock)

    expect(result.reviewStatus).toBe(expected)
  })

  it('flags for review when the total is absent', () => {
    const result = validateFacts(
      facts({ amountTotal: null, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags for review when the date is absent', () => {
    const result = validateFacts(
      facts({ docDate: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags for review when the total was valid on arrival but rejected by the bounds', () => {
    const result = validateFacts(
      facts({ amountTotal: 0, vatAmount: null }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('needs_review')
    expect(rejected(result)).toEqual(['amountTotal'])
  })

  it('flags for review when the date was valid on arrival but outside the window', () => {
    const result = validateFacts(
      facts({ docDate: DAY_AFTER_UPPER_BOUND }),
      extraction({ confidence: 'exact' }),
      clock,
    )

    expect(result.reviewStatus).toBe('needs_review')
  })

  it('flags a medium-confidence read for review even with nothing rejected', () => {
    const result = validateFacts(facts(), extraction({ confidence: 'medium' }), clock)

    expect(result.reviewStatus).toBe('needs_review')
    expect(result.rejected).toEqual([])
  })

  it('never returns reviewed, which only a human tap can produce', () => {
    for (const confidence of ['exact', 'high', 'medium', 'low'] as Confidence[]) {
      const result = validateFacts(facts(), extraction({ confidence }), clock)
      expect(result.reviewStatus).not.toBe('reviewed')
    }
  })

  it('reports every failing field at once rather than stopping at the first', () => {
    const result = validateFacts(
      facts({
        vendorPib: 'X',
        docDate: '2001-01-01',
        vatAmount: 5,
        amountTotal: 0,
        currency: 'JPY' as Currency,
      }),
      extraction({ confidence: 'low' }),
      clock,
    )

    expect(rejected(result)).toEqual(['amountTotal', 'currency', 'docDate', 'vatAmount', 'vendorPib'])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('returns an entirely empty set of facts as needs_review with nothing rejected', () => {
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
    const result = validateFacts(empty, extraction({ method: 'manual', confidence: 'exact' }), clock)

    expect(result.facts).toEqual(empty)
    expect(result.rejected).toEqual([])
    expect(result.reviewStatus).toBe('needs_review')
  })

  it('is stable when run twice over its own output', () => {
    const dirty = facts({ vendorPib: '1', docDate: '2001-01-01', amountTotal: 0, currency: 'JPY' as Currency })
    const once = validateFacts(dirty, extraction(), clock)
    const twice = validateFacts(once.facts, extraction(), clock)

    expect(twice.facts).toEqual(once.facts)
    expect(twice.reviewStatus).toBe(once.reviewStatus)
    expect(twice.rejected).toEqual([])
  })
})
