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

// ---------------------------------------------------------------------------
// Shared fixtures. No mocking library: everything injected is a plain value.
// ---------------------------------------------------------------------------

const LEGAL_NOTES: Record<VatMode, string> = {
  none: 'Nije u sistemu PDV-a.',
  standard20: 'PDV obračunat po stopi od 20%.',
  reduced10: 'PDV obračunat po stopi od 10%.',
  exempt_export: 'Oslobođeno PDV-a — promet usluga van Republike Srbije.',
}

const SELLER = {
  name: 'DILIGAF DOO',
  pib: '123456789',
  mb: '21234567',
  address: 'Bulevar 1, Beograd',
  bankAccount: '160-0000000000000-11',
}

const CUSTOMER_RS = {
  name: 'Klijent A DOO',
  pib: '987654321',
  mb: '20123456',
  address: 'Novi Sad',
  country: 'RS' as string | null,
}

const CUSTOMER_DE = {
  name: 'Kunde GmbH',
  address: 'Berlin',
  country: 'DE' as string | null,
}

function makeInput(overrides: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
  return {
    invoiceNumber: '0008/2026',
    issueDate: '2026-07-12',
    seller: SELLER,
    customer: CUSTOMER_RS,
    lineItems: [{ description: 'Konsultantske usluge', amount: 1000 }],
    currency: 'RSD',
    vatMode: 'standard20',
    exchangeRate: null,
    legalNotes: LEGAL_NOTES,
    ...overrides,
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.getOwnPropertyNames(value).forEach((k) =>
      deepFreeze((value as Record<string, unknown>)[k]),
    )
    Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// resolveVatMode — derived from the customer, never asked (D13)
// ---------------------------------------------------------------------------

describe('resolveVatMode', () => {
  it('charges Serbian VAT to a Serbian business', () => {
    expect(resolveVatMode({ country: 'RS', isBusiness: true })).toBe('standard20')
  })

  it('charges Serbian VAT to a Serbian individual', () => {
    expect(resolveVatMode({ country: 'RS', isBusiness: false })).toBe('standard20')
  })

  it('charges Serbian VAT to a Serbian customer even when it is unknown whether they are a business', () => {
    // For RS the country alone settles it: both branches land on standard20,
    // so an unknown isBusiness is not ambiguous and must not force a refusal.
    expect(resolveVatMode({ country: 'RS', isBusiness: null })).toBe('standard20')
  })

  it('exempts a foreign business as an export of services', () => {
    expect(resolveVatMode({ country: 'DE', isBusiness: true })).toBe('exempt_export')
  })

  it('charges Serbian VAT to a foreign individual', () => {
    expect(resolveVatMode({ country: 'DE', isBusiness: false })).toBe('standard20')
  })

  it.each<[string]>([['AT'], ['US'], ['CH']])(
    'exempts the business customer in %s as well',
    (country) => {
      expect(resolveVatMode({ country, isBusiness: true })).toBe('exempt_export')
    },
  )

  it.each<[CustomerTaxInfo]>([
    [{ country: null, isBusiness: true }],
    [{ country: null, isBusiness: false }],
    [{ country: null, isBusiness: null }],
    [{ country: '', isBusiness: true }],
    [{ country: '   ', isBusiness: true }],
  ])('returns null for %o rather than assuming a tax treatment', (customer) => {
    expect(resolveVatMode(customer)).toBeNull()
  })

  it('returns null for a foreign customer whose business status is unknown', () => {
    // Abroad the flag decides between "no VAT" and "20%" — two different tax
    // documents — so an unknown flag is a genuine ambiguity, not a default.
    expect(resolveVatMode({ country: 'DE', isBusiness: null })).toBeNull()
  })

  it('treats a lower-case country code as Serbia rather than as an export', () => {
    expect(resolveVatMode({ country: 'rs', isBusiness: true })).toBe('standard20')
  })

  it('never exempts a customer whose country is written out instead of coded', () => {
    // "Serbia" / "SRB" are malformed for an ISO-2 field. Whatever the function
    // does with them, silently zero-rating a Serbian client is not it.
    expect(resolveVatMode({ country: 'Serbia', isBusiness: true })).not.toBe('exempt_export')
    expect(resolveVatMode({ country: 'SRB', isBusiness: true })).not.toBe('exempt_export')
  })

  it('does not mutate the customer it is given', () => {
    // The input is frozen, so an implementation that normalises in place throws.
    const customer = deepFreeze<CustomerTaxInfo>({ country: 'RS', isBusiness: true })
    expect(resolveVatMode(customer)).toBe('standard20')
    expect(customer).toEqual({ country: 'RS', isBusiness: true })
  })
})

// ---------------------------------------------------------------------------
// rendersVatLine — presentation is a tax fact, not a formatting choice
// ---------------------------------------------------------------------------

describe('rendersVatLine', () => {
  it('renders a VAT line for a domestic 20% invoice', () => {
    expect(rendersVatLine('standard20')).toBe(true)
  })

  it('renders a VAT line for a reduced-rate invoice', () => {
    expect(rendersVatLine('reduced10')).toBe(true)
  })

  it('renders no VAT line at all for an export-exempt invoice', () => {
    // Not a "PDV 0,00" line — that would state the supply was taxed at zero.
    expect(rendersVatLine('exempt_export')).toBe(false)
  })

  it('renders no VAT line when no VAT applies', () => {
    expect(rendersVatLine('none')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// vatRateFor
// ---------------------------------------------------------------------------

describe('vatRateFor', () => {
  it.each<[VatMode, number]>([
    ['none', 0],
    ['standard20', 0.2],
    ['reduced10', 0.1],
    ['exempt_export', 0],
  ])('gives the %s rate as a fraction of net', (mode, expected) => {
    expect(vatRateFor(mode)).toBe(expected)
  })

  it('rates the standard mode at exactly twice the reduced mode', () => {
    expect(vatRateFor('standard20')).toBeCloseTo(vatRateFor('reduced10') * 2, 10)
  })

  it.each<[VatMode]>([['standard20'], ['reduced10']])(
    'agrees with the VAT computeTotals charges for %s',
    (mode) => {
      const totals = computeTotals([{ description: 'x', amount: 1000 }], mode)
      expect(totals.vat).toBe(Math.round(1000 * vatRateFor(mode) * 100) / 100)
    },
  )
})

// ---------------------------------------------------------------------------
// computeTotals — half-up to 2dp, per invoice, not per line
// ---------------------------------------------------------------------------

describe('computeTotals', () => {
  it('adds 20% VAT to a single domestic line', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], 'standard20')).toEqual({
      net: 1000,
      vat: 200,
      total: 1200,
    })
  })

  it('adds 10% VAT at the reduced rate', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], 'reduced10')).toEqual({
      net: 1000,
      vat: 100,
      total: 1100,
    })
  })

  it('charges no VAT on an export-exempt invoice', () => {
    expect(computeTotals([{ description: 'Consulting', amount: 1000 }], 'exempt_export')).toEqual({
      net: 1000,
      vat: 0,
      total: 1000,
    })
  })

  it('charges no VAT when the mode is none', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], 'none')).toEqual({
      net: 1000,
      vat: 0,
      total: 1000,
    })
  })

  it('sums several lines before taxing them', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Konsultacije', amount: 200000 },
      { description: 'Održavanje', amount: 100000 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({
      net: 300000,
      vat: 60000,
      total: 360000,
    })
  })

  it('rounds the invoice as a whole, not each line, when the two disagree', () => {
    // Per line: 33.33 x3 = 99.99 net and 6.67 x3 = 20.01 VAT.
    // Per invoice: 99.999 -> 100.00 net and 19.9998 -> 20.00 VAT.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 33.333 },
      { description: 'b', amount: 33.333 },
      { description: 'c', amount: 33.333 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 100, vat: 20, total: 120 })
  })

  it('rounds VAT once for the whole invoice at the reduced rate', () => {
    // Per line VAT: 123.46 x2 = 246.92. Per invoice: 246.912 -> 246.91.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 1234.56 },
      { description: 'b', amount: 1234.56 },
    ]
    expect(computeTotals(items, 'reduced10')).toEqual({
      net: 2469.12,
      vat: 246.91,
      total: 2716.03,
    })
  })

  it('rounds a two-line net once rather than twice', () => {
    // Per line: 12.35 x2 = 24.70. Per invoice: 24.69.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 12.345 },
      { description: 'b', amount: 12.345 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 24.69, vat: 4.94, total: 29.63 })
  })

  it('keeps a hundred tiny lines from drifting', () => {
    const items: InvoiceLineItem[] = Array.from({ length: 100 }, (_, i) => ({
      description: `line ${i}`,
      amount: 0.01,
    }))
    expect(computeTotals(items, 'standard20')).toEqual({ net: 1, vat: 0.2, total: 1.2 })
  })

  it.each<[number, number]>([
    [0.125, 0.13],
    [0.375, 0.38],
    [0.875, 0.88],
    [2.125, 2.13],
  ])('rounds a net of %s exactly half-up to %s', (amount, expectedNet) => {
    expect(computeTotals([{ description: 'x', amount }], 'none').net).toBe(expectedNet)
  })

  it('rounds just below the half down', () => {
    expect(computeTotals([{ description: 'x', amount: 0.124 }], 'none').net).toBe(0.12)
  })

  it('rounds just above the half up', () => {
    expect(computeTotals([{ description: 'x', amount: 0.126 }], 'none').net).toBe(0.13)
  })

  it('rounds a VAT amount that lands exactly on the half up', () => {
    // 0.625 net at 20% = 0.125 VAT exactly.
    expect(computeTotals([{ description: 'x', amount: 0.625 }], 'standard20')).toEqual({
      net: 0.63,
      vat: 0.13,
      total: 0.76,
    })
  })

  it.each<[VatMode]>([['none'], ['standard20'], ['reduced10'], ['exempt_export']])(
    'returns zeros for an empty invoice in %s mode',
    (mode) => {
      expect(computeTotals([], mode)).toEqual({ net: 0, vat: 0, total: 0 })
    },
  )

  it('handles a zero-amount line without inventing a total', () => {
    expect(computeTotals([{ description: 'Gratis', amount: 0 }], 'standard20')).toEqual({
      net: 0,
      vat: 0,
      total: 0,
    })
  })

  it('taxes the net after a negative discount line', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Usluge', amount: 100 },
      { description: 'Popust', amount: -30 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 70, vat: 14, total: 84 })
  })

  it('leaves no VAT on an export invoice however large the net', () => {
    const totals = computeTotals([{ description: 'Consulting', amount: 987654.321 }], 'exempt_export')
    expect(totals.vat).toBe(0)
    expect(totals.total).toBe(totals.net)
  })

  it.each<[VatMode]>([['standard20'], ['exempt_export']])(
    'keeps total equal to net plus VAT in %s mode',
    (mode) => {
      const items: InvoiceLineItem[] = [
        { description: 'a', amount: 33.333 },
        { description: 'b', amount: 12.345 },
        { description: 'c', amount: 1234.56 },
      ]
      const { net, vat, total } = computeTotals(items, mode)
      expect(total).toBe(Math.round((net + vat) * 100) / 100)
    },
  )

  it.each<[VatMode]>([['standard20'], ['reduced10']])(
    'reports every figure at two decimals in %s mode',
    (mode) => {
      const { net, vat, total } = computeTotals([{ description: 'x', amount: 33.333 }], mode)
      for (const n of [net, vat, total]) {
        expect(Number(n.toFixed(2))).toBe(n)
      }
    },
  )

  it('does not mutate the line items it is given', () => {
    const items: InvoiceLineItem[] = [{ description: 'Usluge', amount: 1000 }]
    expect(computeTotals(items, 'standard20').net).toBe(1000)
    expect(items).toEqual([{ description: 'Usluge', amount: 1000 }])
  })
})

// ---------------------------------------------------------------------------
// suggestNextNumber — a typing shortcut behind a confirm step (D12)
// ---------------------------------------------------------------------------

describe('suggestNextNumber', () => {
  it('suggests the next number and keeps the zero padding', () => {
    expect(suggestNextNumber('0007/2026')).toBe('0008/2026')
  })

  it('suggests the next number for a per-customer scheme', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe('KLIJENTA-2026-04')
  })

  it.each<[string, string]>([
    ['9', '10'],
    ['099', '100'],
    ['0009', '0010'],
    ['00', '01'],
    ['INV-9', 'INV-10'],
    ['KLIJENTA-2026-09', 'KLIJENTA-2026-10'],
    ['KLIJENTA-2026-99', 'KLIJENTA-2026-100'],
    ['FAKTURA 007', 'FAKTURA 008'],
  ])('suggests %s -> %s', (last, expected) => {
    expect(suggestNextNumber(last)).toBe(expected)
  })

  it('does not widen a number that has room left in its padding', () => {
    expect(suggestNextNumber('0007/2026')).not.toBe('008/2026')
    expect(suggestNextNumber('0007/2026')).not.toBe('8/2026')
  })

  it('widens the padding only when the increment needs another digit', () => {
    expect(suggestNextNumber('99')).toBe('100')
  })

  it('returns null when the number does not end in digits', () => {
    expect(suggestNextNumber('2026/07/A')).toBeNull()
  })

  it.each<[string]>([['INV-A'], ['0008/2026-rev'], ['12-B']])(
    'returns null rather than guessing a scheme for %s',
    (last) => {
      expect(suggestNextNumber(last)).toBeNull()
    },
  )

  it('returns null for the first invoice to a customer', () => {
    expect(suggestNextNumber(null)).toBeNull()
  })

  it('returns null for an empty last number', () => {
    expect(suggestNextNumber('')).toBeNull()
  })

  it('returns null for a whitespace-only last number', () => {
    expect(suggestNextNumber('   ')).toBeNull()
  })

  it('returns null when there is no digit anywhere in the number', () => {
    expect(suggestNextNumber('KLIJENTA')).toBeNull()
  })

  it('does not roll a month or a year over on its own', () => {
    // No scheme understanding: December simply becomes a thirteenth month and
    // the human fixes it at the confirm step.
    expect(suggestNextNumber('KLIJENTA-2026-12')).toBe('KLIJENTA-2026-13')
  })

  it('can be applied twice to walk two invoices forward', () => {
    const once = suggestNextNumber('KLIJENTA-2026-03')
    expect(once).not.toBeNull()
    expect(suggestNextNumber(once)).toBe('KLIJENTA-2026-05')
  })

  it('returns a string, never a number, so the suggestion stays text', () => {
    expect(typeof suggestNextNumber('0007/2026')).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// isDuplicateNumber — warn, never block
// ---------------------------------------------------------------------------

describe('isDuplicateNumber', () => {
  it('flags a number that has already been used on this book', () => {
    expect(isDuplicateNumber('0008/2026', ['0007/2026', '0008/2026'])).toBe(true)
  })

  it('does not flag a number that is new to this book', () => {
    expect(isDuplicateNumber('0009/2026', ['0007/2026', '0008/2026'])).toBe(false)
  })

  it('does not flag anything when no invoice has been issued yet', () => {
    expect(isDuplicateNumber('0001/2026', [])).toBe(false)
  })

  it('flags a number that appears more than once in the history', () => {
    expect(isDuplicateNumber('0008/2026', ['0008/2026', '0008/2026'])).toBe(true)
  })

  it('does not treat a number as used because another number contains it', () => {
    expect(isDuplicateNumber('8/2026', ['0008/2026'])).toBe(false)
    expect(isDuplicateNumber('0008', ['0008/2026'])).toBe(false)
  })

  it('does not flag an empty candidate against a non-empty history', () => {
    expect(isDuplicateNumber('', ['0008/2026'])).toBe(false)
  })

  it('does not mutate the history it is given', () => {
    const used = ['0007/2026', '0008/2026']
    expect(isDuplicateNumber('0008/2026', used)).toBe(true)
    expect(used).toEqual(['0007/2026', '0008/2026'])
  })
})

// ---------------------------------------------------------------------------
// validateNumber — free text; only emptiness and length are rejected
// ---------------------------------------------------------------------------

describe('validateNumber', () => {
  it.each<[string]>([
    ['0008/2026'],
    ['KLIJENTA-2026-04'],
    ['2026/07/A'],
    ['ФАКТУРА-1'],
    ['—'],
  ])('accepts %s, because the scheme belongs to the user', (candidate) => {
    expect(validateNumber(candidate).valid).toBe(true)
  })

  it('reports no error on a number it accepts', () => {
    expect(validateNumber('0008/2026').error).toBeUndefined()
  })

  it('rejects an empty number', () => {
    expect(validateNumber('').valid).toBe(false)
  })

  it('explains why an empty number was rejected', () => {
    const result = validateNumber('')
    expect(result.valid).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
  })

  it('rejects a number that is only whitespace', () => {
    expect(validateNumber('   ').valid).toBe(false)
  })

  it('rejects an absurdly long number', () => {
    const result = validateNumber('A'.repeat(1000))
    expect(result.valid).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  it('accepts a number of ordinary length', () => {
    expect(validateNumber('A'.repeat(32)).valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildInvoiceData — everything the renderer needs, fully resolved
// ---------------------------------------------------------------------------

describe('buildInvoiceData', () => {
  it('renders the invoice number exactly as supplied', () => {
    expect(buildInvoiceData(makeInput({ invoiceNumber: 'KLIJENTA-2026-04' })).invoiceNumber).toBe(
      'KLIJENTA-2026-04',
    )
  })

  it('never zero-pads the invoice number the way the old template did', () => {
    expect(buildInvoiceData(makeInput({ invoiceNumber: '7' })).invoiceNumber).toBe('7')
  })

  it('keeps the issue date exactly as supplied', () => {
    expect(buildInvoiceData(makeInput({ issueDate: '2026-07-12' })).issueDate).toBe('2026-07-12')
  })

  it('carries the seller and customer snapshots through unchanged', () => {
    const data = buildInvoiceData(makeInput())
    expect(data.seller).toEqual(SELLER)
    expect(data.customer).toEqual(CUSTOMER_RS)
  })

  it('keeps a customer without a known country rather than filling one in', () => {
    const customer = { name: 'Nepoznat', country: null }
    expect(buildInvoiceData(makeInput({ customer })).customer.country).toBeNull()
  })

  it('carries the line items through in order and unchanged', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'Konsultacije', amount: 200000 },
      { description: 'Održavanje', amount: 100000 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).lineItems).toEqual(lineItems)
  })

  it('echoes the VAT mode it was told to use', () => {
    expect(buildInvoiceData(makeInput({ vatMode: 'exempt_export' })).vatMode).toBe('exempt_export')
  })

  it.each<[Currency, boolean]>([
    ['RSD', false],
    ['EUR', true],
    ['USD', true],
    ['CHF', true],
    ['GBP', true],
  ])('renders %s invoices bilingual=%s', (currency, bilingual) => {
    expect(buildInvoiceData(makeInput({ currency, exchangeRate: null })).bilingual).toBe(bilingual)
  })

  it('does not turn a foreign-currency invoice monolingual because it is VAT-exempt', () => {
    const data = buildInvoiceData(
      makeInput({ currency: 'EUR', vatMode: 'exempt_export', customer: CUSTOMER_DE }),
    )
    expect(data.bilingual).toBe(true)
  })

  it('does not turn a dinar invoice bilingual because it is VAT-exempt', () => {
    const data = buildInvoiceData(makeInput({ currency: 'RSD', vatMode: 'exempt_export' }))
    expect(data.bilingual).toBe(false)
  })

  it.each<[VatMode, boolean]>([
    ['standard20', true],
    ['reduced10', true],
    ['exempt_export', false],
    ['none', false],
  ])('sets showVatLine=%s for %s', (vatMode, showVatLine) => {
    expect(buildInvoiceData(makeInput({ vatMode })).showVatLine).toBe(showVatLine)
  })

  it('shows no VAT line on an export invoice, instead of a zero one', () => {
    const data = buildInvoiceData(
      makeInput({ vatMode: 'exempt_export', customer: CUSTOMER_DE, currency: 'EUR' }),
    )
    expect(data.showVatLine).toBe(false)
    expect(data.totals.vat).toBe(0)
    expect(data.legalNote).toBe(LEGAL_NOTES.exempt_export)
  })

  it.each<[VatMode]>([['none'], ['standard20'], ['reduced10'], ['exempt_export']])(
    'prints the %s legal note verbatim',
    (vatMode) => {
      expect(buildInvoiceData(makeInput({ vatMode })).legalNote).toBe(LEGAL_NOTES[vatMode])
    },
  )

  it('prints an empty legal note when the accountant has not supplied one yet', () => {
    const legalNotes: Record<VatMode, string> = { ...LEGAL_NOTES, exempt_export: '' }
    expect(buildInvoiceData(makeInput({ vatMode: 'exempt_export', legalNotes })).legalNote).toBe('')
  })

  it('resolves the totals for the invoice as a whole', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'a', amount: 33.333 },
      { description: 'b', amount: 33.333 },
      { description: 'c', amount: 33.333 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems, vatMode: 'standard20' })).totals).toEqual({
      net: 100,
      vat: 20,
      total: 120,
    })
  })

  it('resolves totals of zero for an invoice with no lines', () => {
    expect(buildInvoiceData(makeInput({ lineItems: [] })).totals).toEqual({
      net: 0,
      vat: 0,
      total: 0,
    })
  })

  it.each<[Currency, VatMode, number, boolean, boolean]>([
    ['RSD', 'standard20', 200, true, false],
    ['EUR', 'standard20', 200, true, true],
    ['EUR', 'exempt_export', 0, false, true],
    ['RSD', 'exempt_export', 0, false, false],
  ])(
    'keeps %s and %s independent: vat=%s, showVatLine=%s, bilingual=%s',
    (currency, vatMode, vat, showVatLine, bilingual) => {
      const data = buildInvoiceData(
        makeInput({
          currency,
          vatMode,
          exchangeRate: currency === 'RSD' ? null : 117.5,
          lineItems: [{ description: 'Usluge', amount: 1000 }],
        }),
      )
      expect(data.totals.vat).toBe(vat)
      expect(data.showVatLine).toBe(showVatLine)
      expect(data.bilingual).toBe(bilingual)
      expect(data.currency).toBe(currency)
      expect(data.vatMode).toBe(vatMode)
    },
  )

  it('converts the total at the supplied middle rate', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        exchangeRate: 117.5,
        lineItems: [{ description: 'Consulting', amount: 100 }],
      }),
    )
    expect(data.totals.total).toBe(120)
    expect(data.exchangeRate).toBe(117.5)
    expect(data.totalRsd).toBe(14100)
  })

  it('rounds the converted total half-up to two decimals', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        exchangeRate: 117.2593,
        lineItems: [{ description: 'Consulting', amount: 100 }],
      }),
    )
    expect(data.totalRsd).toBe(14071.12)
  })

  it('returns no dinar total when no exchange rate is known', () => {
    const data = buildInvoiceData(makeInput({ currency: 'EUR', exchangeRate: null }))
    expect(data.exchangeRate).toBeNull()
    expect(data.totalRsd).toBeNull()
  })

  it('returns no dinar total for a zero exchange rate rather than a zero amount', () => {
    expect(buildInvoiceData(makeInput({ currency: 'EUR', exchangeRate: 0 })).totalRsd).toBeNull()
  })

  it('returns no dinar total for a negative exchange rate', () => {
    expect(buildInvoiceData(makeInput({ currency: 'EUR', exchangeRate: -117.5 })).totalRsd).toBeNull()
  })

  it('never reports a dinar total at the wrong scale for a dinar invoice', () => {
    // Either the field is left null or it repeats the total — never a converted
    // figure, since a dinar invoice has nothing to convert.
    const data = buildInvoiceData(makeInput({ currency: 'RSD', exchangeRate: null }))
    expect([null, data.totals.total]).toContain(data.totalRsd)
  })

  it('defaults the payment reference to the invoice number', () => {
    const data = buildInvoiceData(makeInput({ invoiceNumber: 'KLIJENTA-2026-04' }))
    expect(data.paymentReference).toBe('KLIJENTA-2026-04')
  })

  it('uses the payment reference the user overrode it with', () => {
    const data = buildInvoiceData(makeInput({ paymentReference: '97-1234567890' }))
    expect(data.paymentReference).toBe('97-1234567890')
  })

  it('falls back to the invoice number when the payment reference is blank', () => {
    const data = buildInvoiceData(makeInput({ invoiceNumber: '0008/2026', paymentReference: '' }))
    expect(data.paymentReference).toBe('0008/2026')
  })

  it('does not mutate the input it is given', () => {
    // The input is frozen, so an implementation that writes back into it throws.
    const input = deepFreeze(makeInput())
    expect(buildInvoiceData(input).totals.total).toBe(1200)
    expect(input.lineItems).toEqual([{ description: 'Konsultantske usluge', amount: 1000 }])
  })

  it('builds the same document twice from the same input', () => {
    // Purely a function of its input: no clock, no I/O, nothing to drift.
    const input = makeInput({ currency: 'EUR', exchangeRate: 117.5, vatMode: 'exempt_export' })
    expect(buildInvoiceData(input)).toEqual(buildInvoiceData(input))
  })
})
