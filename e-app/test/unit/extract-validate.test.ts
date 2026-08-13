import { describe, it, expect } from 'vitest'
import { validateFacts } from '../../src/core/extract/validate.js'
import type {
  Clock,
  Confidence,
  Currency,
  ExtractedFacts,
  Extraction,
  ExtractionMethod,
  LineItem,
} from '../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library: a Clock is one method returning a
// fixed instant, which is the whole point of injecting it (01 §5).
// ---------------------------------------------------------------------------

function fixedClock(iso: string): Clock {
  const instant = new Date(iso)
  return { now: () => new Date(instant.getTime()) }
}

/**
 * The reference "now" for every window test unless a test says otherwise.
 * Anchored at UTC midnight so that the boundaries land on exact dates:
 *   now         = 2026-08-12
 *   lower bound = 2025-02-12   (now - 18 months, inclusive)
 *   upper bound = 2026-08-14   (now +  2 days,   inclusive)
 * Separate tests pin that the time of day on the clock never changes a verdict.
 */
const NOW_ISO = '2026-08-12T00:00:00.000Z'
const CLOCK = fixedClock(NOW_ISO)

const LOWER_BOUND = '2025-02-12'
const BEFORE_LOWER_BOUND = '2025-02-11'
const UPPER_BOUND = '2026-08-14'
const AFTER_UPPER_BOUND = '2026-08-15'

/** Facts that pass every rule cleanly: the happy path every other case mutates. */
function facts(overrides: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    vendorName: 'Maxi d.o.o.',
    vendorPib: '123456789',
    docDate: '2026-08-01',
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

/** A deterministic rung and a model rung, for the "same validator" claim (03 §2). */
const REGEX_RUNG = extraction({ method: 'pdf_text', confidence: 'high', model: null })
const MODEL_RUNG = extraction({
  method: 'llm_vision',
  confidence: 'high',
  model: 'gpt-4o-mini@2026-05',
  raw: { some: 'provider payload' },
})

const EMPTY_FACTS: ExtractedFacts = {
  vendorName: null,
  vendorPib: null,
  docDate: null,
  amountNet: null,
  vatAmount: null,
  amountTotal: null,
  currency: null,
  lineItems: [],
}

/** `rejected` is a set of field names; its order is not part of the contract. */
function rejectedSet(result: { rejected: string[] }): string[] {
  return [...result.rejected].sort()
}

/** A value a model plausibly emits that the Currency union does not admit. */
function offAllowlist(code: string): Currency {
  return code as unknown as Currency
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

const ALL_CURRENCIES: Currency[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

// ---------------------------------------------------------------------------

describe('validateFacts', () => {
  // -------------------------------------------------------------------------
  // Happy path and pass-through
  // -------------------------------------------------------------------------

  describe('the happy path', () => {
    it('passes clean facts through untouched and marks them ok', () => {
      const input = facts()
      const result = validateFacts(input, REGEX_RUNG, CLOCK)

      expect(result.facts).toEqual(input)
      expect(result.rejected).toEqual([])
      expect(result.reviewStatus).toBe('ok')
    })

    it('leaves fields it has no rule for exactly as they arrived', () => {
      const lineItems: LineItem[] = [
        { description: 'PAMPERS', quantity: 2, unitPrice: 550, lineTotal: 1100 },
        { description: 'MLEKO', quantity: null, unitPrice: null, lineTotal: null },
      ]
      const result = validateFacts(
        facts({ vendorName: '  ЕЛЕКТРОДИСТРИБУЦИЈА  ', amountNet: 999_999_999, lineItems }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vendorName).toBe('  ЕЛЕКТРОДИСТРИБУЦИЈА  ')
      expect(result.facts.amountNet).toBe(999_999_999)
      expect(result.facts.lineItems).toEqual(lineItems)
      expect(result.rejected).toEqual([])
    })

    it('leaves amountNet alone even when net plus VAT disagrees with the total', () => {
      const result = validateFacts(
        facts({ amountNet: 999, vatAmount: 200, amountTotal: 1200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountNet).toBe(999)
      expect(result.rejected).toEqual([])
    })

    it('handles a fully empty fact set without throwing, rejecting nothing and queueing it', () => {
      const result = validateFacts(EMPTY_FACTS, extraction({ confidence: 'exact' }), CLOCK)

      expect(result.facts).toEqual(EMPTY_FACTS)
      expect(result.rejected).toEqual([])
      expect(result.reviewStatus).toBe('needs_review')
    })
  })

  // -------------------------------------------------------------------------
  // 01 §5 / 03 §2 mechanism 2: the same validators regardless of source
  // -------------------------------------------------------------------------

  describe('applied identically to every ladder rung', () => {
    const dirty = facts({
      vendorPib: '12345678',
      docDate: '2030-01-01',
      amountTotal: 12_000_000,
      vatAmount: 400,
      currency: offAllowlist('EVRA'),
    })

    it.each(ALL_METHODS)('accepts clean facts from the %s rung with the same result', (method) => {
      const result = validateFacts(facts(), extraction({ method }), CLOCK)

      expect(result.facts).toEqual(facts())
      expect(result.rejected).toEqual([])
      expect(result.reviewStatus).toBe('ok')
    })

    it.each(ALL_METHODS)('rejects the same bad facts on the %s rung, with no rung getting a pass', (method) => {
      const baseline = validateFacts(dirty, extraction({ method: 'pdf_text' }), CLOCK)
      const result = validateFacts(dirty, extraction({ method }), CLOCK)

      expect(result).toEqual(baseline)
      expect(result.facts.vendorPib).toBeNull()
      expect(result.facts.docDate).toBeNull()
      expect(result.facts.amountTotal).toBeNull()
      expect(result.facts.currency).toBeNull()
      expect(result.reviewStatus).toBe('needs_review')
    })

    it('nulls a bad PIB from a model exactly as it nulls a bad PIB from a regex', () => {
      const bad = facts({ vendorPib: '12345678' })

      const fromRegex = validateFacts(bad, REGEX_RUNG, CLOCK)
      const fromModel = validateFacts(bad, MODEL_RUNG, CLOCK)

      expect(fromRegex.facts.vendorPib).toBeNull()
      expect(fromModel).toEqual(fromRegex)
    })

    it('does not trust a manually entered amount any more than a photographed one', () => {
      const overLimit = facts({ amountTotal: 10_000_000, vatAmount: null })

      const manual = validateFacts(overLimit, extraction({ method: 'manual', confidence: 'exact' }), CLOCK)
      const vision = validateFacts(overLimit, extraction({ method: 'llm_vision', confidence: 'exact' }), CLOCK)

      expect(manual.facts.amountTotal).toBeNull()
      expect(vision.facts.amountTotal).toBeNull()
      expect(manual.facts).toEqual(vision.facts)
    })

    it('does not trust a government-signed fiscal QR read any more than a guessed one', () => {
      const result = validateFacts(
        facts({ docDate: '2030-01-01' }),
        extraction({ method: 'fiscal_qr', confidence: 'exact' }),
        CLOCK,
      )

      expect(result.facts.docDate).toBeNull()
      expect(result.rejected).toContain('docDate')
    })

    it('queues a low-confidence fiscal QR read exactly as it queues a low-confidence model read', () => {
      const qr = validateFacts(facts(), extraction({ method: 'fiscal_qr', confidence: 'low' }), CLOCK)
      const llm = validateFacts(facts(), extraction({ method: 'llm_vision', confidence: 'low' }), CLOCK)

      expect(qr.reviewStatus).toBe('needs_review')
      expect(llm.reviewStatus).toBe('needs_review')
    })

    it('ignores the model identifier and the raw provider payload entirely', () => {
      const withRaw = validateFacts(
        facts(),
        extraction({ model: 'gpt-4o-mini@2026-05', raw: { InvoiceTotal: { confidence: 0.12 } } }),
        CLOCK,
      )
      const withoutRaw = validateFacts(facts(), extraction({ model: null }), CLOCK)

      expect(withRaw).toEqual(withoutRaw)
    })
  })

  // -------------------------------------------------------------------------
  // vendorPib — exactly 9 digits or null
  // -------------------------------------------------------------------------

  describe('vendorPib is exactly nine digits or nothing', () => {
    it.each([
      ['an ordinary PIB', '100205514'],
      ['leading zeros, kept as text rather than a number', '000123456'],
      ['nine zeros — the shape is validated, the taxpayer is not', '000000000'],
      ['nine repeated digits — no checksum rule is specified', '111111111'],
    ])('keeps a PIB with %s', (_label, pib) => {
      const result = validateFacts(facts({ vendorPib: pib }), REGEX_RUNG, CLOCK)

      expect(result.facts.vendorPib).toBe(pib)
      expect(result.rejected).not.toContain('vendorPib')
    })

    it.each([
      ['eight digits — one short', '12345678'],
      ['seven digits', '1234567'],
      ['a single digit', '1'],
      ['ten digits — one long, likely a matični broj', '1234567890'],
      ['twelve digits', '123456789012'],
      ['thirteen digits — a JMBG, not a PIB', '0101990710123'],
      ['letters', 'ABCDEFGHI'],
      ['eight digits and a letter', '12345678A'],
      ['an OCR-mangled letter O standing in for a zero', '1O3456789'],
      ['hyphen separators', '123-456-789'],
      ['dotted separators', '123.456.789'],
      ['an internal space', '123 456 789'],
      ['a decimal point', '123456.89'],
      ['a plus sign', '+123456789'],
      ['a label still attached', 'PIB:123456789'],
      ['an SR country prefix still attached', 'SR123456789'],
      ['leading and trailing whitespace', ' 123456789 '],
      ['a trailing newline', '123456789\n'],
      ['non-ASCII digits', '١٢٣٤٥٦٧٨٩'],
      ['full-width digits', '１２３４５６７８９'],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('returns null for a PIB that is %s', (_label, pib) => {
      const result = validateFacts(facts({ vendorPib: pib }), REGEX_RUNG, CLOCK)

      expect(result.facts.vendorPib).toBeNull()
      expect(result.rejected).toContain('vendorPib')
    })

    it('leaves an absent PIB null without reporting it as rejected', () => {
      const result = validateFacts(facts({ vendorPib: null }), REGEX_RUNG, CLOCK)

      expect(result.facts.vendorPib).toBeNull()
      expect(result.rejected).not.toContain('vendorPib')
      expect(result.reviewStatus).toBe('ok')
    })

    it('drops only the PIB and keeps the money when the PIB is malformed', () => {
      const result = validateFacts(
        facts({ vendorPib: 'nonsense' }),
        extraction({ confidence: 'exact' }),
        CLOCK,
      )

      expect(result.facts.vendorPib).toBeNull()
      expect(result.facts.amountTotal).toBe(1200)
      expect(result.facts.docDate).toBe('2026-08-01')
      expect(rejectedSet(result)).toEqual(['vendorPib'])
    })

    it('does not send a document to review merely because the PIB was unreadable', () => {
      const result = validateFacts(
        facts({ vendorPib: 'not a pib' }),
        extraction({ confidence: 'high' }),
        CLOCK,
      )

      expect(result.reviewStatus).toBe('ok')
    })
  })

  // -------------------------------------------------------------------------
  // docDate — must parse as a real YYYY-MM-DD, never coerced
  // -------------------------------------------------------------------------

  describe('docDate must be a well-formed calendar date', () => {
    it.each([
      ['a Serbian day-first format', '15.07.2026'],
      ['a dotted Serbian format with a trailing dot', '12.08.2026.'],
      ['a slashed ambiguous format', '12/08/2026'],
      ['an unpadded month and day', '2026-8-1'],
      ['a compact digits-only date', '20260812'],
      ['a month of 13', '2026-13-01'],
      ['a month of 00', '2026-00-10'],
      ['a day of 00', '2026-08-00'],
      ['a day of 32', '2026-07-32'],
      ['a day that does not exist in that month', '2026-02-30'],
      ['a 29 February in a non-leap year', '2026-02-29'],
      ['a bare year', '2026'],
      ['a bare year and month', '2026-08'],
      ['a full ISO timestamp rather than a plain date', '2026-08-12T09:30:00Z'],
      ['a Unix epoch number as text', '1786000000'],
      ['trailing text', '2026-08-12 (approx)'],
      ['leading whitespace', ' 2026-08-12'],
      ['surrounding whitespace', ' 2026-08-12 '],
      ['prose', 'juče'],
      ['an empty string', ''],
      ['whitespace only', '  '],
    ])('returns null rather than guessing when the date is %s', (_label, docDate) => {
      const result = validateFacts(facts({ docDate }), REGEX_RUNG, CLOCK)

      expect(result.facts.docDate).toBeNull()
      expect(result.rejected).toContain('docDate')
    })

    it('leaves an absent date null without reporting it as rejected', () => {
      const result = validateFacts(facts({ docDate: null }), REGEX_RUNG, CLOCK)

      expect(result.facts.docDate).toBeNull()
      expect(result.rejected).not.toContain('docDate')
    })
  })

  // -------------------------------------------------------------------------
  // docDate — inside [now - 18 months, now + 2 days], both edges inclusive
  // -------------------------------------------------------------------------

  describe('docDate must fall inside the window the clock defines', () => {
    it.each([
      ['comfortably inside the window', '2026-03-15'],
      ['today', '2026-08-12'],
      ['tomorrow — a supplier invoice can be dated a day ahead', '2026-08-13'],
      ['exactly eighteen months back, the inclusive lower edge', LOWER_BOUND],
      ['exactly two days ahead, the inclusive upper edge', UPPER_BOUND],
    ])('keeps a date that is %s', (_label, docDate) => {
      const result = validateFacts(facts({ docDate }), REGEX_RUNG, CLOCK)

      expect(result.facts.docDate).toBe(docDate)
      expect(result.rejected).not.toContain('docDate')
      expect(result.reviewStatus).toBe('ok')
    })

    it.each([
      ['the day before the eighteen-month lower edge', BEFORE_LOWER_BOUND],
      ['the day after the two-day upper edge', AFTER_UPPER_BOUND],
      ['a receipt from years before the window', '2019-01-01'],
      ['a year misread as 2020 by OCR', '2020-08-12'],
      ['the Unix epoch', '1970-01-01'],
      ['a date years in the future', '2030-12-31'],
      ['a date a lifetime in the future', '2099-01-01'],
    ])('returns null for %s', (_label, docDate) => {
      const result = validateFacts(facts({ docDate }), REGEX_RUNG, CLOCK)

      expect(result.facts.docDate).toBeNull()
      expect(result.rejected).toContain('docDate')
    })

    it('refuses an out-of-window date rather than clamping it to the nearest edge', () => {
      const result = validateFacts(facts({ docDate: '1999-01-01' }), REGEX_RUNG, CLOCK)

      expect(result.facts.docDate).toBeNull()
      expect(result.facts.docDate).not.toBe(LOWER_BOUND)
    })

    it.each([
      ['midnight', '2026-08-12T00:00:00.000Z'],
      ['mid-morning', '2026-08-12T09:15:00.000Z'],
      ['mid-afternoon', '2026-08-12T15:30:00.000Z'],
      ['one second before midnight', '2026-08-12T23:59:59.000Z'],
    ])('applies the window by calendar day, not by instant, with a clock at %s', (_label, iso) => {
      const atTime = fixedClock(iso)

      expect(validateFacts(facts({ docDate: LOWER_BOUND }), REGEX_RUNG, atTime).facts.docDate)
        .toBe(LOWER_BOUND)
      expect(validateFacts(facts({ docDate: UPPER_BOUND }), REGEX_RUNG, atTime).facts.docDate)
        .toBe(UPPER_BOUND)
      expect(validateFacts(facts({ docDate: BEFORE_LOWER_BOUND }), REGEX_RUNG, atTime).facts.docDate)
        .toBeNull()
      expect(validateFacts(facts({ docDate: AFTER_UPPER_BOUND }), REGEX_RUNG, atTime).facts.docDate)
        .toBeNull()
    })

    it('walks the window forward when the clock moves — the same date passes today and fails tomorrow', () => {
      const today = validateFacts(facts({ docDate: LOWER_BOUND }), REGEX_RUNG, CLOCK)
      const tomorrow = validateFacts(
        facts({ docDate: LOWER_BOUND }),
        REGEX_RUNG,
        fixedClock('2026-08-13T00:00:00.000Z'),
      )

      expect(today.facts.docDate).toBe(LOWER_BOUND)
      expect(tomorrow.facts.docDate).toBeNull()
    })

    it('reads the injected clock rather than the host system date', () => {
      const longAgo = fixedClock('2020-06-15T00:00:00.000Z')

      const contemporary = validateFacts(facts({ docDate: '2020-01-10' }), REGEX_RUNG, longAgo)
      const currentEra = validateFacts(facts({ docDate: '2026-07-15' }), REGEX_RUNG, longAgo)

      expect(contemporary.facts.docDate).toBe('2020-01-10')
      expect(currentEra.facts.docDate).toBeNull()
    })

    it('actually calls the clock rather than reading ambient time', () => {
      let calls = 0
      const countingClock: Clock = {
        now: () => {
          calls += 1
          return new Date(NOW_ISO)
        },
      }

      const result = validateFacts(facts({ docDate: LOWER_BOUND }), REGEX_RUNG, countingClock)

      expect(calls).toBeGreaterThan(0)
      expect(result.facts.docDate).toBe(LOWER_BOUND)
    })

    it('accepts a date across a year boundary that is inside the window', () => {
      const janClock = fixedClock('2026-01-05T12:00:00.000Z')
      const result = validateFacts(facts({ docDate: '2025-12-31' }), REGEX_RUNG, janClock)

      expect(result.facts.docDate).toBe('2025-12-31')
    })

    it('accepts 29 February of a leap year inside the window', () => {
      const leapClock = fixedClock('2025-08-29T00:00:00.000Z')
      const result = validateFacts(facts({ docDate: '2024-02-29' }), REGEX_RUNG, leapClock)

      expect(result.facts.docDate).toBe('2024-02-29')
    })

    // SPEC GAP: "minus 18 months" from a 31st has no counterpart in February.
    // Pinned here as calendar clamping (2026-08-31 - 18mo = 2025-02-28), not
    // JS Date rollover (which would give 2025-03-03). Needs an explicit ruling.
    it('clamps the eighteen-month subtraction to the last real day of a short month', () => {
      const shortMonthClock = fixedClock('2026-08-31T00:00:00.000Z')

      const onBoundary = validateFacts(facts({ docDate: '2025-02-28' }), REGEX_RUNG, shortMonthClock)
      const dayBefore = validateFacts(facts({ docDate: '2025-02-27' }), REGEX_RUNG, shortMonthClock)

      expect(onBoundary.facts.docDate).toBe('2025-02-28')
      expect(dayBefore.facts.docDate).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // amountTotal — 0 < x < 10_000_000, both ends exclusive
  // -------------------------------------------------------------------------

  describe('amountTotal bounds are exclusive at both ends', () => {
    it.each([
      ['the smallest amount above zero', 0.01],
      ['a typical receipt total', 1234.56],
      ['an ordinary invoice total', 4210],
      ['a fraction below the upper bound', 9_999_999.99],
    ])('keeps an amountTotal that is %s', (_label, amountTotal) => {
      const result = validateFacts(
        facts({ amountTotal, vatAmount: null }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBe(amountTotal)
      expect(result.rejected).not.toContain('amountTotal')
    })

    it.each([
      ['exactly zero — absence is null and never a zero', 0],
      ['negative zero', -0],
      ['a hair below zero', -0.01],
      ['a negative total', -1200],
      ['exactly ten million — the upper bound is exclusive', 10_000_000],
      ['a hair above ten million', 10_000_000.01],
      ['a decimal point misread as a thousands separator', 120_000_000],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['negative Infinity', Number.NEGATIVE_INFINITY],
    ])('returns null for an amountTotal of %s', (_label, amountTotal) => {
      const result = validateFacts(
        facts({ amountTotal, vatAmount: null }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBeNull()
      expect(result.rejected).toContain('amountTotal')
    })

    it('nulls an out-of-range total instead of clamping it to the limit', () => {
      const result = validateFacts(
        facts({ amountTotal: 50_000_000, vatAmount: null }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBeNull()
      expect(result.facts.amountTotal).not.toBe(10_000_000)
    })

    it('leaves an absent total null without reporting it as rejected', () => {
      const result = validateFacts(facts({ amountTotal: null, vatAmount: null }), REGEX_RUNG, CLOCK)

      expect(result.facts.amountTotal).toBeNull()
      expect(result.rejected).not.toContain('amountTotal')
    })

    it('keeps the date, the vendor and the currency when only the total is unreadable', () => {
      const result = validateFacts(
        facts({ amountTotal: Number.NaN, vatAmount: null }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.docDate).toBe('2026-08-01')
      expect(result.facts.vendorPib).toBe('123456789')
      expect(result.facts.vendorName).toBe('Maxi d.o.o.')
      expect(result.facts.currency).toBe('RSD')
    })
  })

  // -------------------------------------------------------------------------
  // vatAmount — "drop the VAT only"
  // -------------------------------------------------------------------------

  describe('an impossible VAT costs only the VAT', () => {
    it.each([
      ['below the total', 200],
      ['one cent below the total', 1199.99],
      ['exactly equal to the total — the rule is "at most"', 1200],
      ['zero, which is what an exempt or non-VAT supplier reads', 0],
    ])('keeps a vatAmount that is %s', (_label, vatAmount) => {
      const result = validateFacts(
        facts({ vatAmount, amountTotal: 1200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vatAmount).toBe(vatAmount)
      expect(result.rejected).not.toContain('vatAmount')
    })

    it.each([
      ['one cent above the total', 1200.01],
      ['above the total', 1500],
      ['wildly larger than the total after a misread decimal', 120_000],
    ])('drops the VAT and keeps everything else when the VAT is %s', (_label, vatAmount) => {
      const result = validateFacts(
        facts({ amountNet: 1000, vatAmount, amountTotal: 1200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vatAmount).toBeNull()
      expect(result.facts.amountTotal).toBe(1200)
      expect(result.facts.amountNet).toBe(1000)
      expect(result.facts.vendorPib).toBe('123456789')
      expect(rejectedSet(result)).toEqual(['vatAmount'])
    })

    it('drops only the VAT when the VAT and the total were plainly swapped in the read', () => {
      const result = validateFacts(
        facts({ amountNet: 1000, vatAmount: 1200, amountTotal: 200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vatAmount).toBeNull()
      expect(result.facts.amountTotal).toBe(200)
      expect(rejectedSet(result)).toEqual(['vatAmount'])
    })

    it('never repairs the total from the VAT it just dropped', () => {
      const result = validateFacts(
        facts({ amountNet: 1000, vatAmount: 5000, amountTotal: 1200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBe(1200)
      expect(result.facts.amountNet).toBe(1000)
    })

    // SPEC GAP: the spec states only "vat_amount <= amount_total". A negative or
    // non-finite VAT satisfies that relation literally. Pinned as a refusal here:
    // it is not a valid money fact, and refusing loses less than filing a lie.
    it.each([
      ['a negative VAT', -200],
      ['a VAT of NaN', Number.NaN],
      ['a VAT of Infinity', Number.POSITIVE_INFINITY],
    ])('drops %s without touching the total', (_label, vatAmount) => {
      const result = validateFacts(
        facts({ vatAmount, amountTotal: 1200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vatAmount).toBeNull()
      expect(result.facts.amountTotal).toBe(1200)
      expect(result.rejected).toContain('vatAmount')
    })

    // SPEC GAP: with no left-hand side the relation cannot be evaluated. Pinned as
    // "drop it" — an unverifiable VAT on a document already headed for review is
    // worse than no VAT at all. Keeping it is the other defensible reading.
    it('drops the VAT when the total was itself rejected, since nothing can vouch for it', () => {
      const result = validateFacts(
        facts({ vatAmount: 200, amountTotal: 20_000_000 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBeNull()
      expect(result.facts.vatAmount).toBeNull()
      expect(rejectedSet(result)).toEqual(['amountTotal', 'vatAmount'])
    })

    it('drops the VAT when there was never a total to compare it against', () => {
      const result = validateFacts(
        facts({ vatAmount: 200, amountTotal: null }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.vatAmount).toBeNull()
      expect(rejectedSet(result)).toEqual(['vatAmount'])
    })

    it('reports the total and the VAT separately when both are wrong', () => {
      const result = validateFacts(
        facts({ amountTotal: 0, vatAmount: 200 }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(result.facts.amountTotal).toBeNull()
      expect(result.facts.vatAmount).toBeNull()
      expect(rejectedSet(result)).toEqual(['amountTotal', 'vatAmount'])
    })

    it('leaves an absent VAT null without reporting it as rejected', () => {
      const result = validateFacts(facts({ vatAmount: null }), REGEX_RUNG, CLOCK)

      expect(result.facts.vatAmount).toBeNull()
      expect(result.rejected).not.toContain('vatAmount')
    })
  })

  // -------------------------------------------------------------------------
  // currency — from the allowlist, never coerced
  // -------------------------------------------------------------------------

  describe('currency comes from the allowlist or nowhere', () => {
    it.each(ALL_CURRENCIES)('keeps %s, which is on the allowlist', (currency) => {
      const result = validateFacts(facts({ currency }), REGEX_RUNG, CLOCK)

      expect(result.facts.currency).toBe(currency)
      expect(result.rejected).not.toContain('currency')
    })

    it.each([
      ['an ISO code that is not on the allowlist', 'JPY'],
      ['a former currency', 'YUM'],
      ['the colloquial dinar', 'DIN'],
      ['a Serbian word for euros the model failed to resolve', 'EVRA'],
      ['a currency symbol', '€'],
      ['a spelled-out name', 'EURO'],
      ['a lowercase code', 'eur'],
      ['a mixed-case code', 'Rsd'],
      ['a code with leading whitespace', ' EUR'],
      ['a code padded on both sides', ' EUR '],
      ['a numeric ISO code', '978'],
      ['an empty string', ''],
    ])('returns null for a currency that is %s', (_label, currency) => {
      const result = validateFacts(facts({ currency: offAllowlist(currency) }), REGEX_RUNG, CLOCK)

      expect(result.facts.currency).toBeNull()
      expect(result.rejected).toContain('currency')
    })

    it('does not fall back to RSD when the currency is unrecognised', () => {
      const result = validateFacts(facts({ currency: offAllowlist('EVRA') }), REGEX_RUNG, CLOCK)

      expect(result.facts.currency).toBeNull()
      expect(result.facts.currency).not.toBe('RSD')
    })

    it('keeps a valid amount even when its currency is unrecognised, so the number is not lost', () => {
      const result = validateFacts(
        facts({ amountTotal: 1200, currency: offAllowlist('JPY') }),
        extraction({ confidence: 'exact' }),
        CLOCK,
      )

      expect(result.facts.amountTotal).toBe(1200)
      expect(result.facts.currency).toBeNull()
      expect(result.reviewStatus).toBe('ok')
    })

    it('leaves an absent currency null without reporting it as rejected', () => {
      const result = validateFacts(facts({ currency: null }), REGEX_RUNG, CLOCK)

      expect(result.facts.currency).toBeNull()
      expect(result.rejected).not.toContain('currency')
    })
  })

  // -------------------------------------------------------------------------
  // reviewStatus — what sends a document to the queue
  // -------------------------------------------------------------------------

  describe('what sends a document to the review queue', () => {
    it.each<{ confidence: Confidence; expected: string }>([
      { confidence: 'exact', expected: 'ok' },
      { confidence: 'high', expected: 'ok' },
      { confidence: 'medium', expected: 'needs_review' },
      { confidence: 'low', expected: 'needs_review' },
    ])('returns $expected for otherwise clean facts at $confidence confidence', ({ confidence, expected }) => {
      const result = validateFacts(facts(), extraction({ confidence }), CLOCK)

      expect(result.reviewStatus).toBe(expected)
      expect(result.rejected).toEqual([])
    })

    it.each([
      ['the total was never read', { amountTotal: null, vatAmount: null }],
      ['the total was read but failed the bounds', { amountTotal: 10_000_000, vatAmount: null }],
      ['the total was read as zero', { amountTotal: 0, vatAmount: null }],
      ['the date was never read', { docDate: null }],
      ['the date fell outside the window', { docDate: '2019-01-01' }],
      ['the date could not be parsed at all', { docDate: '31.31.2026' }],
    ] as [string, Partial<ExtractedFacts>][])('queues a document when %s, even at exact confidence', (_label, over) => {
      const result = validateFacts(facts(over), extraction({ confidence: 'exact' }), CLOCK)

      expect(result.reviewStatus).toBe('needs_review')
    })

    it.each(ALL_METHODS)('queues an unreadable total from the %s rung', (method) => {
      const result = validateFacts(
        facts({ amountTotal: null, vatAmount: null }),
        extraction({ method, confidence: 'exact' }),
        CLOCK,
      )

      expect(result.reviewStatus).toBe('needs_review')
    })

    it('does not queue a document merely because its PIB and currency were unreadable', () => {
      const result = validateFacts(
        facts({ vendorPib: 'XX', currency: offAllowlist('EVRA') }),
        extraction({ confidence: 'high' }),
        CLOCK,
      )

      expect(rejectedSet(result)).toEqual(['currency', 'vendorPib'])
      expect(result.reviewStatus).toBe('ok')
    })

    it('does not queue a document merely because its VAT was dropped', () => {
      const result = validateFacts(
        facts({ amountTotal: 1200, vatAmount: 9999 }),
        extraction({ confidence: 'high' }),
        CLOCK,
      )

      expect(rejectedSet(result)).toEqual(['vatAmount'])
      expect(result.reviewStatus).toBe('ok')
    })

    it.each<Confidence>(['exact', 'high', 'medium', 'low'])(
      'never returns reviewed at %s confidence — only a human tap produces that',
      (confidence) => {
        const clean = validateFacts(facts(), extraction({ confidence }), CLOCK)
        const dirty = validateFacts(
          facts({ docDate: null, amountTotal: null, vatAmount: null }),
          extraction({ confidence }),
          CLOCK,
        )

        expect(clean.reviewStatus).not.toBe('reviewed')
        expect(dirty.reviewStatus).not.toBe('reviewed')
      },
    )
  })

  // -------------------------------------------------------------------------
  // Result shape, purity, determinism
  // -------------------------------------------------------------------------

  describe('result shape and purity', () => {
    it('nulls every failing field, names each one, and queues the document', () => {
      const result = validateFacts(
        facts({
          vendorName: 'НЕЧИТЉИВО',
          vendorPib: '1234567',
          docDate: '31.02.2026',
          amountNet: 40,
          vatAmount: 50,
          amountTotal: 0,
          currency: offAllowlist('EVRA'),
        }),
        extraction({ method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' }),
        CLOCK,
      )

      expect(result.facts).toEqual({
        vendorName: 'НЕЧИТЉИВО',
        vendorPib: null,
        docDate: null,
        amountNet: 40,
        vatAmount: null,
        amountTotal: null,
        currency: null,
        lineItems: [],
      })
      expect(rejectedSet(result)).toEqual([
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
        facts({ vendorPib: 'x', docDate: 'x', amountTotal: -5, vatAmount: 10, currency: offAllowlist('x') }),
        REGEX_RUNG,
        CLOCK,
      )

      expect(new Set(result.rejected).size).toBe(result.rejected.length)
    })

    it('does not mutate the facts it was given', () => {
      const input = facts({ vendorPib: '12345678', amountTotal: 0 })
      const snapshot = structuredClone(input)

      validateFacts(input, REGEX_RUNG, CLOCK)

      expect(input).toEqual(snapshot)
    })

    it('does not mutate the extraction it was given', () => {
      const rung = extraction({ method: 'llm_vision', confidence: 'low', model: 'm@1' })
      const snapshot = structuredClone(rung)

      validateFacts(facts(), rung, CLOCK)

      expect(rung).toEqual(snapshot)
    })

    it('returns the same verdict for the same input every time it is called', () => {
      const input = facts({ vendorPib: '1234567890', docDate: LOWER_BOUND, amountTotal: 10_000_000 })

      const first = validateFacts(input, MODEL_RUNG, CLOCK)
      const second = validateFacts(input, MODEL_RUNG, CLOCK)

      expect(second).toEqual(first)
    })

    it('is stable when run a second time over its own output', () => {
      const dirty = facts({
        vendorPib: '1',
        docDate: '2001-01-01',
        amountTotal: 0,
        vatAmount: null,
        currency: offAllowlist('JPY'),
      })

      const once = validateFacts(dirty, REGEX_RUNG, CLOCK)
      const twice = validateFacts(once.facts, REGEX_RUNG, CLOCK)

      expect(twice.facts).toEqual(once.facts)
      expect(twice.reviewStatus).toBe(once.reviewStatus)
      expect(twice.rejected).toEqual([])
    })
  })
})
