/**
 * E — invoicing core: VAT modes, totals, invoice numbers, template data.
 * Engineer #1. Written BEFORE the implementation exists (strict TDD):
 * every module under test is currently a stub that throws "not implemented",
 * so every case here is expected to fail until the behaviour is written.
 *
 * Spec: 03-DILIGAF.md §3 (Invoice issuing), 00-OVERVIEW.md D12 / D13.
 */

import { describe, it, expect } from 'vitest'

import { resolveVatMode, rendersVatLine } from '../../../src/core/invoicing/vat-mode.js'
import type { VatMode, CustomerTaxInfo } from '../../../src/core/invoicing/vat-mode.js'
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

const ALL_MODES: VatMode[] = ['none', 'standard20', 'reduced10', 'exempt_export']

/** Hand-written note table — no mocking library; fixed, recognisable strings. */
const NOTES: Record<VatMode, string> = {
  none: 'NOTE-NONE',
  standard20: 'NOTE-STANDARD20',
  reduced10: 'NOTE-REDUCED10',
  exempt_export: 'Oslobodjeno PDV-a — clan 12. Zakona o PDV (mesto prometa u inostranstvu).',
}

const SELLER = {
  name: 'DILIGAF DOO',
  pib: '123456789',
  mb: '21000000',
  address: 'Beograd, Srbija',
  bankAccount: '265-0000000000000-00',
}

const CUSTOMER_RS = { name: 'Klijent A', pib: '987654321', address: 'Novi Sad', country: 'RS' }
const CUSTOMER_DE = { name: 'Kunde GmbH', address: 'Berlin', country: 'DE' }

function makeInput(overrides: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
  return {
    invoiceNumber: '0008/2026',
    issueDate: '2026-07-12',
    seller: SELLER,
    customer: CUSTOMER_RS,
    lineItems: [{ description: 'Konsultantske usluge', amount: 300000 }],
    currency: 'RSD',
    vatMode: 'standard20',
    exchangeRate: null,
    legalNotes: NOTES,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveVatMode — D13: derived from the customer, never asked
// ---------------------------------------------------------------------------

describe('resolveVatMode', () => {
  it('charges 20% to a Serbian business customer', () => {
    expect(resolveVatMode({ country: 'RS', isBusiness: true })).toBe('standard20')
  })

  it('charges 20% to a Serbian individual customer', () => {
    expect(resolveVatMode({ country: 'RS', isBusiness: false })).toBe('standard20')
  })

  it('charges 20% to a Serbian customer even when it is unknown whether they are a business', () => {
    // For RS the business flag cannot change the answer, so absence is not ambiguity.
    expect(resolveVatMode({ country: 'RS', isBusiness: null })).toBe('standard20')
  })

  it('exempts a foreign business customer as an export of services', () => {
    expect(resolveVatMode({ country: 'DE', isBusiness: true })).toBe('exempt_export')
  })

  it('charges 20% to a foreign individual customer (the B2C caveat, §3 caveat 2)', () => {
    expect(resolveVatMode({ country: 'DE', isBusiness: false })).toBe('standard20')
  })

  it('returns null when the country is missing rather than assuming domestic', () => {
    expect(resolveVatMode({ country: null, isBusiness: true })).toBeNull()
  })

  it('returns null when the country is an empty string', () => {
    expect(resolveVatMode({ country: '', isBusiness: true })).toBeNull()
  })

  it('returns null when the country is blank whitespace', () => {
    expect(resolveVatMode({ country: '   ', isBusiness: false })).toBeNull()
  })

  it('returns null for a foreign customer when it is unknown whether they are a business', () => {
    // The flag decides between VAT and no VAT here, so an unknown flag is a real
    // ambiguity and E must ask rather than guess a tax treatment.
    expect(resolveVatMode({ country: 'DE', isBusiness: null })).toBeNull()
  })

  it.each([
    { country: 'rs', isBusiness: true },
    { country: ' RS ', isBusiness: false },
  ])('treats country "$country" as Serbia regardless of case or padding', ({ country, isBusiness }) => {
    expect(resolveVatMode({ country, isBusiness })).toBe('standard20')
  })

  it.each([
    { country: 'CH', isBusiness: true, expected: 'exempt_export' as VatMode },
    { country: 'US', isBusiness: false, expected: 'standard20' as VatMode },
  ])(
    'resolves country $country with isBusiness $isBusiness to $expected',
    ({ country, isBusiness, expected }) => {
      const customer: CustomerTaxInfo = { country, isBusiness }
      expect(resolveVatMode(customer)).toBe(expected)
    },
  )
})

// ---------------------------------------------------------------------------
// rendersVatLine — an exempt invoice is a different document, not a zero one
// ---------------------------------------------------------------------------

describe('rendersVatLine', () => {
  it('renders no VAT line at all for an exempt export — not a zero-VAT line', () => {
    expect(rendersVatLine('exempt_export')).toBe(false)
  })

  it('renders a VAT line for a domestic 20% invoice', () => {
    expect(rendersVatLine('standard20')).toBe(true)
  })

  it('renders a VAT line for a reduced 10% invoice', () => {
    expect(rendersVatLine('reduced10')).toBe(true)
  })

  it('renders no VAT line when the seller is outside the VAT system', () => {
    expect(rendersVatLine('none')).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// vatRateFor
// ---------------------------------------------------------------------------

describe('vatRateFor', () => {
  it.each([
    { mode: 'standard20' as VatMode, rate: 0.2 },
    { mode: 'reduced10' as VatMode, rate: 0.1 },
    { mode: 'none' as VatMode, rate: 0 },
    { mode: 'exempt_export' as VatMode, rate: 0 },
  ])('returns $rate as a fraction for $mode', ({ mode, rate }) => {
    expect(vatRateFor(mode)).toBeCloseTo(rate, 10)
  })
})

// ---------------------------------------------------------------------------
// computeTotals — half-up to 2dp, per invoice not per line
// ---------------------------------------------------------------------------

describe('computeTotals', () => {
  it('computes net, VAT and total for a single domestic line', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 300000 }], 'standard20')).toEqual({
      net: 300000,
      vat: 60000,
      total: 360000,
    })
  })

  it('returns zero totals for an invoice with no line items', () => {
    expect(computeTotals([], 'standard20')).toEqual({ net: 0, vat: 0, total: 0 })
  })

  it('charges no VAT on an exempt export and makes the total equal the net', () => {
    const items: InvoiceLineItem[] = [{ description: 'Consulting', amount: 2500 }]
    expect(computeTotals(items, 'exempt_export')).toEqual({ net: 2500, vat: 0, total: 2500 })
  })

  it('charges no VAT when the mode is none', () => {
    expect(computeTotals([{ description: 'X', amount: 1234.56 }], 'none')).toEqual({
      net: 1234.56,
      vat: 0,
      total: 1234.56,
    })
  })

  it('rounds VAT once for the whole invoice, not once per line', () => {
    // Per line: 33.33 * 0.2 = 6.666 -> 6.67 each -> 20.01 of VAT and a 120.00 total.
    // Per invoice: 99.99 * 0.2 = 19.998 -> 20.00 of VAT and a 119.99 total.
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 33.33 },
      { description: 'B', amount: 33.33 },
      { description: 'C', amount: 33.33 },
    ]
    const totals = computeTotals(items, 'standard20')
    expect(totals).toEqual({ net: 99.99, vat: 20.0, total: 119.99 })
    expect(totals.vat).not.toBe(20.01)
  })

  it('rounds a reduced-rate invoice once for the whole invoice, not once per line', () => {
    // Per line: 0.05 * 0.1 = 0.005 -> 0.01 each -> 0.03 of VAT.
    // Per invoice: 0.15 * 0.1 = 0.015 -> 0.02 of VAT.
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 0.05 },
      { description: 'B', amount: 0.05 },
      { description: 'C', amount: 0.05 },
    ]
    const totals = computeTotals(items, 'reduced10')
    expect(totals).toEqual({ net: 0.15, vat: 0.02, total: 0.17 })
    expect(totals.vat).not.toBe(0.03)
  })

  it.each([
    { net: 0.05, vat: 0.01, total: 0.06 }, // 0.005 exactly -> up (banker's would give 0.00)
    { net: 0.25, vat: 0.03, total: 0.28 }, // 0.025 exactly -> up (banker's would give 0.02)
    { net: 12.25, vat: 1.23, total: 13.48 }, // 1.225 exactly -> up (banker's would give 1.22)
  ])(
    'rounds a VAT of exactly half a cent upwards: net $net gives VAT $vat',
    ({ net, vat, total }) => {
      expect(computeTotals([{ description: 'L', amount: net }], 'reduced10')).toEqual({
        net,
        vat,
        total,
      })
    },
  )

  it.each([
    { amount: 33.33, vat: 6.67, total: 40.0 }, // 6.666 -> 6.67
    { amount: 0.01, vat: 0.0, total: 0.01 }, // 0.002 -> 0.00, VAT can legitimately round away
    { amount: 999999.99, vat: 200000.0, total: 1199999.99 },
  ])('rounds 20% VAT on $amount half-up to $vat', ({ amount, vat, total }) => {
    expect(computeTotals([{ description: 'L', amount }], 'standard20')).toEqual({
      net: amount,
      vat,
      total,
    })
  })

  it('rounds the net itself to two decimals when the lines carry more precision', () => {
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 10.005 },
      { description: 'B', amount: 10.005 },
    ]
    // 20.01 net exactly; 4.002 VAT -> 4.00.
    expect(computeTotals(items, 'standard20')).toEqual({ net: 20.01, vat: 4.0, total: 24.01 })
  })

  it('keeps the total exactly equal to net plus VAT for every mode', () => {
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 33.33 },
      { description: 'B', amount: 0.05 },
      { description: 'C', amount: 12.25 },
    ]
    for (const mode of ALL_MODES) {
      const { net, vat, total } = computeTotals(items, mode)
      expect(total).toBe(Math.round((net + vat) * 100) / 100)
    }
  })

  it('lets a discount line reduce the taxable base', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge', amount: 1000 },
      { description: 'Popust', amount: -100 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 900, vat: 180, total: 1080 })
  })

  it('handles a fully credited invoice whose net is zero', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge', amount: 500 },
      { description: 'Storno', amount: -500 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 0, vat: 0, total: 0 })
  })

  it('does not accumulate binary floating-point error across many small lines', () => {
    const items: InvoiceLineItem[] = Array.from({ length: 10 }, (_, i) => ({
      description: `L${i}`,
      amount: 0.1,
    }))
    expect(computeTotals(items, 'standard20')).toEqual({ net: 1, vat: 0.2, total: 1.2 })
  })
})

// ---------------------------------------------------------------------------
// suggestNextNumber — D12: a typing shortcut behind a confirm step, not an allocator
// ---------------------------------------------------------------------------

describe('suggestNextNumber', () => {
  it('increments the invoice number and preserves its zero-padding', () => {
    expect(suggestNextNumber('0007/2026')).toBe('0008/2026')
  })

  it('increments a per-customer number with a text prefix', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe('KLIJENTA-2026-04')
  })

  it('returns null when the number has no numeric group to increment, rather than guessing', () => {
    expect(suggestNextNumber('2026/07/A')).toBeNull()
  })

  it('returns null for the first invoice to a customer, when there is no previous number', () => {
    expect(suggestNextNumber(null)).toBeNull()
  })

  it('returns null for an empty previous number', () => {
    expect(suggestNextNumber('')).toBeNull()
  })

  it('returns null for a previous number that is only whitespace', () => {
    expect(suggestNextNumber('   ')).toBeNull()
  })

  it('returns null when the previous number contains no digits at all', () => {
    expect(suggestNextNumber('FAKTURA')).toBeNull()
  })

  it.each([
    { last: '9', next: '10' }, // width 1, must grow rather than wrap to '0'
    { last: '0', next: '1' },
    { last: '00', next: '01' },
    { last: '099', next: '100' }, // width 3 exactly filled
    { last: '999', next: '1000' }, // width 3 overflowed
    { last: '12', next: '13' }, // never widened when it did not need widening
    { last: 'A1', next: 'A2' },
    { last: 'INV-0009', next: 'INV-0010' },
    { last: 'KLIJENTA-2026-09', next: 'KLIJENTA-2026-10' },
    { last: '0099/2026', next: '0100/2026' },
  ])('suggests $next after $last', ({ last, next }) => {
    expect(suggestNextNumber(last)).toBe(next)
  })

  it('returns null when the number ends in a separator', () => {
    expect(suggestNextNumber('0007/')).toBeNull()
  })

  it('returns null when the number ends in a letter after digits', () => {
    expect(suggestNextNumber('0007A')).toBeNull()
  })

  it('does not apply year-rollover or any other scheme understanding', () => {
    // A December number is incremented exactly like any other; E has no calendar logic.
    expect(suggestNextNumber('KLIJENTA-2026-12')).toBe('KLIJENTA-2026-13')
  })
})

// ---------------------------------------------------------------------------
// isDuplicateNumber — warn, never block
// ---------------------------------------------------------------------------

describe('isDuplicateNumber', () => {
  it('reports a duplicate when the number was already used on this book', () => {
    expect(isDuplicateNumber('0008/2026', ['0007/2026', '0008/2026'])).toBe(true)
  })

  it('reports no duplicate when the number is new', () => {
    expect(isDuplicateNumber('0009/2026', ['0007/2026', '0008/2026'])).toBe(false)
  })

  it('reports no duplicate when no invoice has been issued yet', () => {
    expect(isDuplicateNumber('0001/2026', [])).toBe(false)
  })

  it('reports a duplicate that appears several times in the history', () => {
    expect(isDuplicateNumber('A-1', ['A-1', 'A-2', 'A-1'])).toBe(true)
  })

  it('does not confuse a number with one that merely contains it', () => {
    expect(isDuplicateNumber('7/2026', ['17/2026', '7/20260'])).toBe(false)
  })

  it('reports a duplicate despite differing letter case, since a warning is cheap and a missed clash is not', () => {
    expect(isDuplicateNumber('klijenta-2026-03', ['KLIJENTA-2026-03'])).toBe(true)
  })

  it('reports a duplicate despite surrounding whitespace', () => {
    expect(isDuplicateNumber(' 0008/2026 ', ['0008/2026'])).toBe(true)
  })

  it('reports no duplicate for an empty candidate against a non-empty history', () => {
    expect(isDuplicateNumber('', ['0008/2026'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateNumber — free text; only emptiness and length are rejected
// ---------------------------------------------------------------------------

describe('validateNumber', () => {
  it.each(['0008/2026', 'KLIJENTA-2026-04', '7', 'FAKTURA br. 7 / 2026', 'a'.repeat(50)])('accepts the free-text invoice number %s', (candidate) => {
    expect(validateNumber(candidate)).toEqual({ valid: true })
  })

  it('rejects an empty invoice number', () => {
    const result = validateNumber('')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects an invoice number that is only whitespace', () => {
    const result = validateNumber('   ')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects an absurdly long invoice number', () => {
    const result = validateNumber('9'.repeat(1000))
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('carries no error message when the number is valid', () => {
    expect(validateNumber('0008/2026').error).toBeUndefined()
  })

  it('does not reject a number merely because it cannot be incremented', () => {
    // validateNumber and suggestNextNumber are independent: E may not be able to
    // suggest the next one, but the number you typed is still legal.
    expect(suggestNextNumber('2026/07/A')).toBeNull()
    expect(validateNumber('2026/07/A').valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildInvoiceData — everything the renderer needs, fully resolved
// ---------------------------------------------------------------------------

describe('buildInvoiceData', () => {
  it('passes the invoice number through as text, never zero-padding it', () => {
    expect(buildInvoiceData(makeInput({ invoiceNumber: '7' })).invoiceNumber).toBe('7')
  })

  it('preserves an invoice number that already carries zero-padding', () => {
    expect(buildInvoiceData(makeInput({ invoiceNumber: '0007/2026' })).invoiceNumber).toBe(
      '0007/2026',
    )
  })

  it('passes the issue date through unchanged', () => {
    expect(buildInvoiceData(makeInput({ issueDate: '2026-07-12' })).issueDate).toBe('2026-07-12')
  })

  it('carries the seller and customer snapshots through unchanged', () => {
    const data = buildInvoiceData(makeInput({ customer: CUSTOMER_DE }))
    expect(data.seller).toEqual(SELLER)
    expect(data.customer).toEqual(CUSTOMER_DE)
  })

  it('keeps a customer whose country is unknown rather than inventing one', () => {
    const customer = { name: 'Nepoznat', country: null }
    expect(buildInvoiceData(makeInput({ customer })).customer.country).toBeNull()
  })

  it('carries the line items through in the order given', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'Prva', amount: 100 },
      { description: 'Druga', amount: 200 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).lineItems).toEqual(lineItems)
  })

  it('resolves the totals from the line items and the VAT mode', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'A', amount: 33.33 },
      { description: 'B', amount: 33.33 },
      { description: 'C', amount: 33.33 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).totals).toEqual({
      net: 99.99,
      vat: 20.0,
      total: 119.99,
    })
  })

  it('produces zero totals for an invoice with no line items', () => {
    expect(buildInvoiceData(makeInput({ lineItems: [] })).totals).toEqual({
      net: 0,
      vat: 0,
      total: 0,
    })
  })

  it('suppresses the VAT line on an exempt export and carries the exemption note instead', () => {
    const data = buildInvoiceData(makeInput({ vatMode: 'exempt_export', currency: 'EUR' }))
    expect(data.showVatLine).toBe(false)
    expect(data.totals.vat).toBe(0)
    expect(data.legalNote).toBe(NOTES.exempt_export)
  })

  it('shows the VAT line on a domestic invoice', () => {
    expect(buildInvoiceData(makeInput({ vatMode: 'standard20' })).showVatLine).toBe(true)
  })

  it.each(ALL_MODES)('prints the configured legal note verbatim for mode %s', (mode) => {
    expect(buildInvoiceData(makeInput({ vatMode: mode })).legalNote).toBe(NOTES[mode])
  })

  it('prints an empty legal note when none is configured for the mode, rather than substituting one', () => {
    const legalNotes: Record<VatMode, string> = { ...NOTES, standard20: '' }
    expect(buildInvoiceData(makeInput({ legalNotes })).legalNote).toBe('')
  })

  it('echoes the resolved VAT mode back to the renderer', () => {
    expect(buildInvoiceData(makeInput({ vatMode: 'reduced10' })).vatMode).toBe('reduced10')
  })

  // --- bilingual output: currency-driven only ---

  it('produces a monolingual invoice in dinars', () => {
    expect(buildInvoiceData(makeInput({ currency: 'RSD' })).bilingual).toBe(false)
  })

  it.each<Currency>(['EUR', 'USD', 'CHF', 'GBP'])(
    'produces a bilingual invoice in %s',
    (currency) => {
      const data = buildInvoiceData(makeInput({ currency, exchangeRate: 117.2 }))
      expect(data.bilingual).toBe(true)
      expect(data.currency).toBe(currency)
    },
  )

  // --- currency and VAT stay independent (all four combinations) ---

  it('invoices a domestic customer in dinars with 20% VAT', () => {
    const data = buildInvoiceData(
      makeInput({ currency: 'RSD', vatMode: 'standard20', lineItems: [{ description: 'A', amount: 1000 }] }),
    )
    expect(data.bilingual).toBe(false)
    expect(data.showVatLine).toBe(true)
    expect(data.totals).toEqual({ net: 1000, vat: 200, total: 1200 })
  })

  it('invoices a domestic customer in euros while still charging 20% VAT', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'standard20',
        exchangeRate: 117.2,
        lineItems: [{ description: 'A', amount: 1000 }],
      }),
    )
    expect(data.bilingual).toBe(true)
    expect(data.showVatLine).toBe(true)
    expect(data.totals).toEqual({ net: 1000, vat: 200, total: 1200 })
  })

  it('invoices a foreign business in euros with no VAT', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'exempt_export',
        customer: CUSTOMER_DE,
        exchangeRate: 117.2,
        lineItems: [{ description: 'A', amount: 1000 }],
      }),
    )
    expect(data.bilingual).toBe(true)
    expect(data.showVatLine).toBe(false)
    expect(data.totals).toEqual({ net: 1000, vat: 0, total: 1000 })
  })

  it('invoices a foreign business in dinars with no VAT', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'RSD',
        vatMode: 'exempt_export',
        customer: CUSTOMER_DE,
        lineItems: [{ description: 'A', amount: 1000 }],
      }),
    )
    expect(data.bilingual).toBe(false)
    expect(data.showVatLine).toBe(false)
    expect(data.totals).toEqual({ net: 1000, vat: 0, total: 1000 })
  })

  // --- exchange rate and the RSD equivalent ---

  it('converts the total to dinars at the supplied middle rate', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'exempt_export',
        exchangeRate: 117.2,
        lineItems: [{ description: 'A', amount: 1000 }],
      }),
    )
    expect(data.exchangeRate).toBe(117.2)
    expect(data.totalRsd).toBe(117200)
  })

  it('rounds the dinar equivalent half-up to two decimals', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'exempt_export',
        exchangeRate: 117.2345,
        lineItems: [{ description: 'A', amount: 1 }],
      }),
    )
    expect(data.totalRsd).toBe(117.23)
  })

  it('leaves the dinar equivalent null when no exchange rate is available, rather than assuming one', () => {
    const data = buildInvoiceData(
      makeInput({ currency: 'EUR', vatMode: 'exempt_export', exchangeRate: null }),
    )
    expect(data.exchangeRate).toBeNull()
    expect(data.totalRsd).toBeNull()
  })

  it.each([0, -1])('leaves the dinar equivalent null for a non-positive rate of %s', (rate) => {
    expect(buildInvoiceData(makeInput({ currency: 'EUR', exchangeRate: rate })).totalRsd).toBeNull()
  })

  it('leaves the dinar equivalent null on a dinar invoice, which needs no conversion', () => {
    const data = buildInvoiceData(makeInput({ currency: 'RSD', exchangeRate: null }))
    expect(data.totalRsd).toBeNull()
  })

  // --- payment reference ---

  it('defaults the payment reference to the invoice number', () => {
    const data = buildInvoiceData(makeInput({ invoiceNumber: '0008/2026' }))
    expect(data.paymentReference).toBe('0008/2026')
  })

  it('uses the supplied payment reference when one is given', () => {
    const data = buildInvoiceData(makeInput({ paymentReference: '97-1234567890' }))
    expect(data.paymentReference).toBe('97-1234567890')
  })

  it('falls back to the invoice number when the supplied payment reference is empty', () => {
    const data = buildInvoiceData(makeInput({ invoiceNumber: 'A-1', paymentReference: '' }))
    expect(data.paymentReference).toBe('A-1')
  })

  it('does no I/O and no drawing — the same input always builds the same data', () => {
    const input = makeInput({ currency: 'EUR', exchangeRate: 117.2, vatMode: 'exempt_export' })
    expect(buildInvoiceData(input)).toEqual(buildInvoiceData(input))
  })

  it('does not mutate the input it was given', () => {
    const input = makeInput()
    const snapshot = JSON.parse(JSON.stringify(input))
    buildInvoiceData(input)
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })
})
