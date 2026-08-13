import { describe, it, expect } from 'vitest'
import { resolveVatMode, rendersVatLine } from '../../../src/core/invoicing/vat-mode.js'
import type { CustomerTaxInfo, VatMode } from '../../../src/core/invoicing/vat-mode.js'
import { computeTotals, vatRateFor } from '../../../src/core/invoicing/invoice-model.js'
import type { InvoiceLineItem } from '../../../src/core/invoicing/invoice-model.js'
import {
  suggestNextNumber,
  isDuplicateNumber,
  validateNumber,
} from '../../../src/core/invoicing/invoice-number.js'
import { buildInvoiceData } from '../../../src/core/invoicing/invoice-template.js'
import type { BuildInvoiceInput } from '../../../src/core/invoicing/invoice-template.js'
import type { Currency } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fixtures. No mocking library, no clock, no randomness: every
// function under test here is pure.
// ---------------------------------------------------------------------------

const LEGAL_NOTES: Record<VatMode, string> = {
  none: 'Nije u sistemu PDV-a.',
  standard20: 'PDV obracunat po stopi od 20%.',
  reduced10: 'PDV obracunat po stopi od 10%.',
  exempt_export: 'Oslobodjeno PDV-a — mesto prometa u inostranstvu.',
}

const SELLER = {
  name: 'DILIGAF DOO',
  pib: '123456789',
  mb: '21123456',
  address: 'Bulevar 1, Beograd',
  bankAccount: '265-0000000000000-00',
}

const RS_CUSTOMER = {
  name: 'Klijent A DOO',
  pib: '987654321',
  mb: '20987654',
  address: 'Knez Mihailova 1, Beograd',
  country: 'RS' as string | null,
}

const ONE_LINE: InvoiceLineItem[] = [{ description: 'Konsultantske usluge', amount: 1000 }]

function baseInput(over: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
  return {
    invoiceNumber: '0008/2026',
    issueDate: '2026-07-31',
    seller: SELLER,
    customer: RS_CUSTOMER,
    lineItems: ONE_LINE,
    currency: 'RSD',
    vatMode: 'standard20',
    exchangeRate: null,
    legalNotes: LEGAL_NOTES,
    ...over,
  }
}

// ===========================================================================
// resolveVatMode — derived from the customer, never asked (D13)
// ===========================================================================

describe('resolveVatMode', () => {
  it.each<[string, CustomerTaxInfo, VatMode | null]>([
    ['a Serbian business', { country: 'RS', isBusiness: true }, 'standard20'],
    ['a Serbian individual', { country: 'RS', isBusiness: false }, 'standard20'],
    ['a Serbian customer of unknown legal form', { country: 'RS', isBusiness: null }, 'standard20'],
    ['a foreign business', { country: 'DE', isBusiness: true }, 'exempt_export'],
    ['a foreign individual', { country: 'DE', isBusiness: false }, 'standard20'],
  ])('resolves %s to the mode the customer implies', (_label, customer, expected) => {
    expect(resolveVatMode(customer)).toBe(expected)
  })

  it('charges Serbian VAT on a domestic supply regardless of business flag', () => {
    expect(resolveVatMode({ country: 'RS', isBusiness: true })).toBe('standard20')
    expect(resolveVatMode({ country: 'RS', isBusiness: false })).toBe('standard20')
  })

  it('treats a foreign business as an exempt export, not as a zero-rated domestic supply', () => {
    expect(resolveVatMode({ country: 'CH', isBusiness: true })).toBe('exempt_export')
  })

  it('returns null when the country is missing, rather than assuming Serbia', () => {
    expect(resolveVatMode({ country: null, isBusiness: true })).toBeNull()
  })

  it('returns null when the country is missing even for a known individual', () => {
    expect(resolveVatMode({ country: null, isBusiness: false })).toBeNull()
  })

  it('returns null when neither country nor business status is known', () => {
    expect(resolveVatMode({ country: null, isBusiness: null })).toBeNull()
  })

  it('refuses an empty-string country the same way it refuses a missing one', () => {
    // Malformed input: '' is not an ISO-2 code, so it cannot be resolved.
    expect(resolveVatMode({ country: '', isBusiness: true })).toBeNull()
  })

  it('does not treat an unknown business flag on a foreign customer as a business', () => {
    // isBusiness === null is not "true": the exempt_export branch must not fire on a guess.
    expect(resolveVatMode({ country: 'DE', isBusiness: null })).toBe('standard20')
  })
})

// ===========================================================================
// rendersVatLine — presentation, and a tax inspector reads it
// ===========================================================================

describe('rendersVatLine', () => {
  it.each<[VatMode, boolean]>([
    ['standard20', true],
    ['reduced10', true],
    ['exempt_export', false],
    ['none', false],
  ])('returns %s -> %s', (mode, expected) => {
    expect(rendersVatLine(mode)).toBe(expected)
  })

  it('renders no VAT line at all for an exempt export, not a zero one', () => {
    // A "PDV 0,00" line says "taxed at zero". An exempt export is a different
    // document: no VAT line, exemption note instead (03 §3, D13).
    expect(rendersVatLine('exempt_export')).toBe(false)
  })
})

// ===========================================================================
// vatRateFor
// ===========================================================================

describe('vatRateFor', () => {
  it.each<[VatMode, number]>([
    ['none', 0],
    ['standard20', 0.2],
    ['reduced10', 0.1],
    ['exempt_export', 0],
  ])('returns the fractional rate for %s', (mode, expected) => {
    expect(vatRateFor(mode)).toBe(expected)
  })
})

// ===========================================================================
// computeTotals — half-up to 2dp, per invoice, not per line
// ===========================================================================

describe('computeTotals', () => {
  it('computes net, VAT and total for a single domestic line', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], 'standard20')).toEqual({
      net: 1000,
      vat: 200,
      total: 1200,
    })
  })

  it('sums every line into the net before applying VAT', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge A', amount: 300000 },
      { description: 'Usluge B', amount: 300000 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 600000, vat: 120000, total: 720000 })
  })

  it.each<[VatMode, number, number]>([
    ['none', 0, 1000],
    ['standard20', 200, 1200],
    ['reduced10', 100, 1100],
    ['exempt_export', 0, 1000],
  ])('applies the %s rate, giving vat %d and total %d', (mode, vat, total) => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], mode)).toEqual({
      net: 1000,
      vat,
      total,
    })
  })

  it('charges no VAT on an exempt export and leaves the total equal to the net', () => {
    const result = computeTotals([{ description: 'Consulting', amount: 2500 }], 'exempt_export')
    expect(result).toEqual({ net: 2500, vat: 0, total: 2500 })
  })

  it('returns zero totals for an invoice with no line items', () => {
    expect(computeTotals([], 'standard20')).toEqual({ net: 0, vat: 0, total: 0 })
  })

  it('returns zero totals for an empty invoice under an exempt mode too', () => {
    expect(computeTotals([], 'exempt_export')).toEqual({ net: 0, vat: 0, total: 0 })
  })

  it('rounds VAT once over the whole invoice, not once per line', () => {
    // Per line: round2(1.03 * 0.2) = 0.21, three times = 0.63.
    // Per invoice: round2(3.09 * 0.2) = round2(0.618) = 0.62.  <- required
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 1.03 },
      { description: 'b', amount: 1.03 },
      { description: 'c', amount: 1.03 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 3.09, vat: 0.62, total: 3.71 })
  })

  it('rounds the net once over the whole invoice, not once per line', () => {
    // Per line: round2(0.0625) = 0.06, twice = 0.12.
    // Per invoice: round2(0.125) = 0.13.                       <- required
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 0.0625 },
      { description: 'b', amount: 0.0625 },
    ]
    expect(computeTotals(items, 'none').net).toBe(0.13)
  })

  it.each<[number, number]>([
    [0.125, 0.13],
    [0.625, 0.63],
    [2.125, 2.13],
    [1.0625, 1.06],
    [1.006, 1.01],
    [1.004, 1.0],
  ])('rounds a net of %s half-up to %s', (amount, expected) => {
    expect(computeTotals([{ description: 'x', amount }], 'none').net).toBe(expected)
  })

  it('rounds an exact half up, not to even', () => {
    // Banker's rounding would give 0.12 and 0.62 here. Half-up is required.
    expect(computeTotals([{ description: 'x', amount: 0.125 }], 'none').net).toBe(0.13)
    expect(computeTotals([{ description: 'x', amount: 0.625 }], 'none').net).toBe(0.63)
  })

  it('leaves an amount that is already at 2dp untouched', () => {
    expect(computeTotals([{ description: 'x', amount: 4210.55 }], 'none')).toEqual({
      net: 4210.55,
      vat: 0,
      total: 4210.55,
    })
  })

  it('keeps the total equal to the rounded net plus the rounded VAT', () => {
    const result = computeTotals([{ description: 'x', amount: 186430 }], 'standard20')
    expect(result.total).toBe(result.net + result.vat)
  })

  it('subtracts a negative line from the net before VAT is applied', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge', amount: 1000 },
      { description: 'Popust', amount: -100 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 900, vat: 180, total: 1080 })
  })

  it('handles a zero-amount line without changing the totals', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge', amount: 1000 },
      { description: 'Gratis', amount: 0 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 1000, vat: 200, total: 1200 })
  })

  it('does not mutate the line items it is given', () => {
    const items: InvoiceLineItem[] = [{ description: 'Usluge', amount: 1.03 }]
    const snapshot = JSON.parse(JSON.stringify(items))
    computeTotals(items, 'standard20')
    expect(items).toEqual(snapshot)
  })
})

// ===========================================================================
// suggestNextNumber — a typing shortcut behind a confirm step (D12)
// ===========================================================================

describe('suggestNextNumber', () => {
  it('suggests 0008/2026 from 0007/2026, keeping the padding and the year', () => {
    expect(suggestNextNumber('0007/2026')).toBe('0008/2026')
  })

  it('suggests KLIJENTA-2026-04 from KLIJENTA-2026-03', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe('KLIJENTA-2026-04')
  })

  it.each<[string, string]>([
    ['9', '10'],
    ['099', '100'],
    ['7', '8'],
    ['0009', '0010'],
    ['99', '100'],
    ['0099', '0100'],
    ['999', '1000'],
    ['0000', '0001'],
    ['INV-9', 'INV-10'],
    ['FAKTURA-2026-09', 'FAKTURA-2026-10'],
    ['FAKTURA-2026-99', 'FAKTURA-2026-100'],
  ])('suggests %s -> %s', (last, expected) => {
    expect(suggestNextNumber(last)).toBe(expected)
  })

  it('preserves the zero-padding width when the increment still fits', () => {
    expect(suggestNextNumber('0009')).toBe('0010')
  })

  it('grows the width rather than truncating when the increment overflows the padding', () => {
    expect(suggestNextNumber('099')).toBe('100')
    expect(suggestNextNumber('999')).toBe('1000')
  })

  it('does not add padding to a number that had none', () => {
    expect(suggestNextNumber('9')).toBe('10')
  })

  it.each<[string]>([
    ['2026/07/A'],
    ['FAKTURA'],
    ['99/A'],
    ['0007/2026-REV'],
    ['-'],
    ['   '],
  ])('returns null for %s, where there is no numeric group to increment', (last) => {
    expect(suggestNextNumber(last)).toBeNull()
  })

  it('returns null for the first invoice to a customer, where there is no last number', () => {
    expect(suggestNextNumber(null)).toBeNull()
  })

  it('returns null for an empty last number rather than inventing a 1', () => {
    expect(suggestNextNumber('')).toBeNull()
  })

  it('returns a string, never a number, so the caller cannot lose the padding', () => {
    expect(typeof suggestNextNumber('0007/2026')).toBe('string')
  })

  it('is a pure suggestion: calling it twice on the same input gives the same answer', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe(suggestNextNumber('KLIJENTA-2026-03'))
  })
})

// ===========================================================================
// isDuplicateNumber — warn, never block
// ===========================================================================

describe('isDuplicateNumber', () => {
  it('reports a duplicate when the number has been used on this book before', () => {
    expect(isDuplicateNumber('0008/2026', ['0007/2026', '0008/2026'])).toBe(true)
  })

  it('reports no duplicate when the number is new', () => {
    expect(isDuplicateNumber('0009/2026', ['0007/2026', '0008/2026'])).toBe(false)
  })

  it('reports no duplicate when no numbers have been used yet', () => {
    expect(isDuplicateNumber('0001/2026', [])).toBe(false)
  })

  it('reports a duplicate when the number appears more than once in the history', () => {
    expect(isDuplicateNumber('0008/2026', ['0008/2026', '0008/2026'])).toBe(true)
  })

  it('compares free text exactly, so a differently formatted number is not a duplicate', () => {
    expect(isDuplicateNumber('8/2026', ['0008/2026'])).toBe(false)
  })

  it('does not mutate the list of used numbers', () => {
    const used = ['0007/2026', '0008/2026']
    isDuplicateNumber('0008/2026', used)
    expect(used).toEqual(['0007/2026', '0008/2026'])
  })
})

// ===========================================================================
// validateNumber — free text; only emptiness and length are rejected
// ===========================================================================

describe('validateNumber', () => {
  it('accepts an ordinary invoice number', () => {
    expect(validateNumber('0008/2026')).toEqual({ valid: true })
  })

  it.each<[string]>([
    ['0008/2026'],
    ['KLIJENTA-2026-04'],
    ['2026/07/A'],
    ['7'],
    ['Faktura br. 7 — Klijent A'],
    ['№7/2026'],
    ['A'],
  ])('accepts %s, because the scheme belongs to the user, not to E', (candidate) => {
    expect(validateNumber(candidate).valid).toBe(true)
  })

  it('rejects an empty number with an explanation', () => {
    const result = validateNumber('')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects a whitespace-only number', () => {
    expect(validateNumber('   ').valid).toBe(false)
  })

  it('rejects an absurdly long number with an explanation', () => {
    const result = validateNumber('X'.repeat(1000))
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('accepts a long but plausible number', () => {
    expect(validateNumber('KLIJENTA-KONSULTANTSKE-USLUGE-2026-07-0008').valid).toBe(true)
  })

  it('carries no error when the number is valid', () => {
    expect(validateNumber('0008/2026').error).toBeUndefined()
  })
})

// ===========================================================================
// buildInvoiceData — everything the renderer needs, fully resolved
// ===========================================================================

describe('buildInvoiceData', () => {
  it('renders the invoice number exactly as supplied, never zero-padded', () => {
    expect(buildInvoiceData(baseInput({ invoiceNumber: '7' })).invoiceNumber).toBe('7')
  })

  it.each<[string]>([['7'], ['0007/2026'], ['KLIJENTA-2026-04'], ['2026/07/A']])(
    'passes the number %s through as text',
    (invoiceNumber) => {
      expect(buildInvoiceData(baseInput({ invoiceNumber })).invoiceNumber).toBe(invoiceNumber)
    },
  )

  it.each<[Currency, boolean]>([
    ['RSD', false],
    ['EUR', true],
    ['USD', true],
    ['CHF', true],
    ['GBP', true],
  ])('is bilingual for %s: %s', (currency, bilingual) => {
    expect(buildInvoiceData(baseInput({ currency })).bilingual).toBe(bilingual)
  })

  it.each<[VatMode, boolean]>([
    ['standard20', true],
    ['reduced10', true],
    ['exempt_export', false],
    ['none', false],
  ])('sets showVatLine to %s -> %s', (vatMode, showVatLine) => {
    expect(buildInvoiceData(baseInput({ vatMode })).showVatLine).toBe(showVatLine)
  })

  it('gives an exempt export no VAT line and a zero VAT amount, which are different things', () => {
    const data = buildInvoiceData(baseInput({ vatMode: 'exempt_export' }))
    expect(data.showVatLine).toBe(false)
    expect(data.totals).toEqual({ net: 1000, vat: 0, total: 1000 })
  })

  it.each<[VatMode]>([['none'], ['standard20'], ['reduced10'], ['exempt_export']])(
    'prints the caller-supplied legal note for %s verbatim',
    (vatMode) => {
      expect(buildInvoiceData(baseInput({ vatMode })).legalNote).toBe(LEGAL_NOTES[vatMode])
    },
  )

  it('does not invent legal wording of its own', () => {
    const notes: Record<VatMode, string> = { ...LEGAL_NOTES, exempt_export: 'CUSTOM NOTE 17.1' }
    const data = buildInvoiceData(baseInput({ vatMode: 'exempt_export', legalNotes: notes }))
    expect(data.legalNote).toBe('CUSTOM NOTE 17.1')
  })

  it.each<[Currency, VatMode, number, boolean, boolean]>([
    ['RSD', 'standard20', 200, true, false],
    ['RSD', 'exempt_export', 0, false, false],
    ['EUR', 'standard20', 200, true, true],
    ['EUR', 'exempt_export', 0, false, true],
  ])(
    'keeps currency %s and VAT mode %s independent (vat %d, vatLine %s, bilingual %s)',
    (currency, vatMode, vat, showVatLine, bilingual) => {
      const data = buildInvoiceData(baseInput({ currency, vatMode }))
      expect(data.currency).toBe(currency)
      expect(data.vatMode).toBe(vatMode)
      expect(data.totals.vat).toBe(vat)
      expect(data.showVatLine).toBe(showVatLine)
      expect(data.bilingual).toBe(bilingual)
    },
  )

  it('charges domestic VAT on an invoice denominated in EUR', () => {
    const data = buildInvoiceData(baseInput({ currency: 'EUR', vatMode: 'standard20' }))
    expect(data.totals).toEqual({ net: 1000, vat: 200, total: 1200 })
  })

  it('charges no VAT on an exempt export invoiced in RSD', () => {
    const data = buildInvoiceData(baseInput({ currency: 'RSD', vatMode: 'exempt_export' }))
    expect(data.totals.vat).toBe(0)
    expect(data.showVatLine).toBe(false)
  })

  it('defaults the payment reference to the invoice number', () => {
    const data = buildInvoiceData(baseInput({ invoiceNumber: 'KLIJENTA-2026-04' }))
    expect(data.paymentReference).toBe('KLIJENTA-2026-04')
  })

  it('uses an explicitly supplied payment reference instead of the invoice number', () => {
    const data = buildInvoiceData(
      baseInput({ invoiceNumber: '0008/2026', paymentReference: '97-1234567890' }),
    )
    expect(data.paymentReference).toBe('97-1234567890')
  })

  it('converts the total to RSD with the supplied rate', () => {
    const data = buildInvoiceData(baseInput({ currency: 'EUR', exchangeRate: 117.25 }))
    expect(data.exchangeRate).toBe(117.25)
    expect(data.totalRsd).toBe(140700)
  })

  it('leaves totalRsd null when a foreign-currency invoice has no exchange rate', () => {
    const data = buildInvoiceData(baseInput({ currency: 'EUR', exchangeRate: null }))
    expect(data.totalRsd).toBeNull()
    expect(data.exchangeRate).toBeNull()
  })

  it.each<[number]>([[0], [-117.25]])(
    'leaves totalRsd null for the non-positive rate %s rather than producing a zero total',
    (exchangeRate) => {
      expect(buildInvoiceData(baseInput({ currency: 'USD', exchangeRate })).totalRsd).toBeNull()
    },
  )

  it('leaves totalRsd null on an RSD invoice, where there is nothing to convert', () => {
    const data = buildInvoiceData(baseInput({ currency: 'RSD', exchangeRate: null }))
    expect(data.totalRsd).toBeNull()
  })

  it('rounds the converted RSD total to 2 decimals', () => {
    const data = buildInvoiceData(
      baseInput({ lineItems: [{ description: 'x', amount: 1 }], currency: 'EUR', exchangeRate: 117.2033, vatMode: 'none' }),
    )
    expect(data.totalRsd).toBe(117.2)
  })

  it('snapshots the seller exactly as supplied', () => {
    expect(buildInvoiceData(baseInput()).seller).toEqual(SELLER)
  })

  it('snapshots the customer exactly as supplied', () => {
    expect(buildInvoiceData(baseInput()).customer).toEqual(RS_CUSTOMER)
  })

  it('keeps a null customer country null rather than defaulting it to RS', () => {
    const customer = { name: 'Foreign Ltd', country: null }
    expect(buildInvoiceData(baseInput({ customer })).customer.country).toBeNull()
  })

  it('carries a foreign customer without a PIB', () => {
    const customer = { name: 'Foreign Ltd', country: 'DE', address: 'Berlin' }
    const data = buildInvoiceData(baseInput({ customer, currency: 'EUR', vatMode: 'exempt_export' }))
    expect(data.customer.pib).toBeUndefined()
    expect(data.customer.country).toBe('DE')
  })

  it('passes the issue date through unchanged', () => {
    expect(buildInvoiceData(baseInput({ issueDate: '2026-02-29' })).issueDate).toBe('2026-02-29')
  })

  it('passes the line items through in order', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'Konsultantske usluge', amount: 300000 },
      { description: 'Putni troskovi', amount: 12500 },
    ]
    expect(buildInvoiceData(baseInput({ lineItems })).lineItems).toEqual(lineItems)
  })

  it('does not mutate the line items it is given', () => {
    const lineItems: InvoiceLineItem[] = [{ description: 'Usluge', amount: 1000 }]
    const snapshot = JSON.parse(JSON.stringify(lineItems))
    buildInvoiceData(baseInput({ lineItems }))
    expect(lineItems).toEqual(snapshot)
  })

  it('builds an invoice with no line items as zero totals rather than failing', () => {
    const data = buildInvoiceData(baseInput({ lineItems: [] }))
    expect(data.lineItems).toEqual([])
    expect(data.totals).toEqual({ net: 0, vat: 0, total: 0 })
  })

  it('rounds the totals once per invoice, as computeTotals does', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'a', amount: 1.03 },
      { description: 'b', amount: 1.03 },
      { description: 'c', amount: 1.03 },
    ]
    expect(buildInvoiceData(baseInput({ lineItems })).totals).toEqual({
      net: 3.09,
      vat: 0.62,
      total: 3.71,
    })
  })

  it('does no I/O and no drawing: the same input always builds the same data', () => {
    expect(buildInvoiceData(baseInput())).toEqual(buildInvoiceData(baseInput()))
  })
})
