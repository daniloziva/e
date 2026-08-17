/**
 * E — invoicing: VAT modes, totals, invoice numbers, template data.
 *
 * Merged from three independent drafts (engineers 1-3).
 * Spec: 03-DILIGAF.md §3, 00-OVERVIEW.md D12 / D13.
 *
 * Written BEFORE the implementation exists (strict TDD): every module under
 * test is a stub that throws "not implemented", so every case here fails until
 * the behaviour is written. That is correct RED.
 *
 * The arithmetic contract all three drafts converged on, made explicit here:
 *     net   = round2(sum of line amounts)      <- rounded ONCE, over the invoice
 *     vat   = round2(net * rate)               <- computed on the ROUNDED net
 *     total = round2(net + vat)
 * Rounding is half-up, never banker's.
 */

import { describe, it, expect } from 'vitest'

import { resolveVatMode, rendersVatLine } from '../../src/engine/invoicing/vat-mode.js'
import type { VatMode, CustomerTaxInfo } from '../../src/engine/invoicing/vat-mode.js'
import { computeTotals, vatRateFor } from '../../src/engine/invoicing/invoice-model.js'
import type { InvoiceLineItem } from '../../src/engine/invoicing/invoice-model.js'
import {
  suggestNextNumber,
  isDuplicateNumber,
  validateNumber,
} from '../../src/engine/invoicing/invoice-number.js'
import { buildInvoiceData } from '../../src/engine/invoicing/invoice-template.js'
import type { BuildInvoiceInput } from '../../src/engine/invoicing/invoice-template.js'
import type { Currency } from '../../src/engine/types.js'

const ALL_MODES: VatMode[] = ['none', 'standard20', 'reduced10', 'exempt_export']

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

const CUSTOMER_RS = {
  name: 'Klijent A DOO',
  pib: '987654321',
  mb: '20987654',
  address: 'Knez Mihailova 1, Beograd',
  country: 'RS' as string | null,
}

const CUSTOMER_DE = {
  name: 'Kunde GmbH',
  address: 'Berlin',
  country: 'DE' as string | null,
}

function makeInput(over: Partial<BuildInvoiceInput> = {}): BuildInvoiceInput {
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
    ...over,
  }
}

/** Freezing the input proves an implementation does not normalise in place. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.getOwnPropertyNames(value).forEach((k) =>
      deepFreeze((value as Record<string, unknown>)[k]),
    )
    Object.freeze(value)
  }
  return value
}

// ===========================================================================
// vat-mode.ts — resolveVatMode
// D13: derived from the customer, never asked.
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

  it('charges Serbian VAT even when it is unknown whether a Serbian customer is a business', () => {
    // For RS both branches land on standard20, so an unknown flag is not a real
    // ambiguity and must not force a refusal.
    expect(resolveVatMode({ country: 'RS', isBusiness: null })).toBe('standard20')
  })

  it.each<[string]>([['AT'], ['US'], ['CH']])(
    'exempts the business customer in %s as an export of services',
    (country) => {
      expect(resolveVatMode({ country, isBusiness: true })).toBe('exempt_export')
    },
  )

  it('returns null for a foreign customer whose business status is unknown', () => {
    // MERGE NOTE — 2-of-3 (e1, e2 refuse; e3 defaulted to standard20).
    // Abroad the flag decides between "no VAT" and "20%" — two different tax
    // documents — so an unknown flag is a genuine ambiguity. D13's "country
    // missing -> refuse to assume" extends to any input that decides the answer.
    expect(resolveVatMode({ country: 'DE', isBusiness: null })).toBeNull()
  })

  it.each<[CustomerTaxInfo]>([
    [{ country: null, isBusiness: true }],
    [{ country: null, isBusiness: false }],
    [{ country: null, isBusiness: null }],
    [{ country: '', isBusiness: true }],
    [{ country: '   ', isBusiness: true }],
  ])('returns null for %o rather than assuming a tax treatment', (customer) => {
    expect(resolveVatMode(customer)).toBeNull()
  })

  it.each<[string, boolean]>([
    ['rs', true],
    [' RS ', false],
  ])('treats country "%s" as Serbia regardless of case or padding', (country, isBusiness) => {
    expect(resolveVatMode({ country, isBusiness })).toBe('standard20')
  })

  it('never exempts a customer whose country is written out instead of ISO-2 coded', () => {
    // "Serbia" / "SRB" are malformed for an ISO-2 field. Whatever the function
    // does with them, silently zero-rating a Serbian client is not it.
    expect(resolveVatMode({ country: 'Serbia', isBusiness: true })).not.toBe('exempt_export')
    expect(resolveVatMode({ country: 'SRB', isBusiness: true })).not.toBe('exempt_export')
  })

  it('does not mutate the customer it is given', () => {
    const customer = deepFreeze<CustomerTaxInfo>({ country: 'RS', isBusiness: true })
    expect(resolveVatMode(customer)).toBe('standard20')
    expect(customer).toEqual({ country: 'RS', isBusiness: true })
  })
})

// ===========================================================================
// vat-mode.ts — rendersVatLine
// An exempt invoice is a different document, not a zero one.
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
    // A "PDV 0,00" line states the supply was taxed at zero. An exempt export is
    // a different document to a tax inspector: no VAT line, exemption note instead.
    expect(rendersVatLine('exempt_export')).toBe(false)
  })
})

// ===========================================================================
// invoice-model.ts — vatRateFor
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

  it('rates the standard mode at exactly twice the reduced mode', () => {
    expect(vatRateFor('standard20')).toBeCloseTo(vatRateFor('reduced10') * 2, 10)
  })

  it.each<[VatMode]>([['standard20'], ['reduced10']])(
    'agrees with the VAT computeTotals actually charges for %s',
    (mode) => {
      const totals = computeTotals([{ description: 'x', amount: 1000 }], mode)
      expect(totals.vat).toBe(Math.round(1000 * vatRateFor(mode) * 100) / 100)
    },
  )
})

// ===========================================================================
// invoice-model.ts — computeTotals
// Half-up to 2dp, per invoice, not per line.
// ===========================================================================

describe('computeTotals', () => {
  it('computes net, VAT and total for a single domestic line', () => {
    expect(computeTotals([{ description: 'Usluge', amount: 1000 }], 'standard20')).toEqual({
      net: 1000,
      vat: 200,
      total: 1200,
    })
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

  it('sums every line into the net before applying VAT', () => {
    const items: InvoiceLineItem[] = [
      { description: 'Konsultacije', amount: 200000 },
      { description: 'Odrzavanje', amount: 100000 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({
      net: 300000,
      vat: 60000,
      total: 360000,
    })
  })

  it.each<[VatMode]>([['none'], ['standard20'], ['reduced10'], ['exempt_export']])(
    'returns zeros for an empty invoice in %s mode',
    (mode) => {
      expect(computeTotals([], mode)).toEqual({ net: 0, vat: 0, total: 0 })
    },
  )

  // --- rounded once over the invoice, not once per line ---

  it('rounds VAT once for the whole invoice, not once per line', () => {
    // Per line: 33.33 * 0.2 = 6.666 -> 6.67 each -> 20.01 VAT and a 120.00 total.
    // Per invoice: 99.99 * 0.2 = 19.998 -> 20.00 VAT and a 119.99 total.
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 33.33 },
      { description: 'B', amount: 33.33 },
      { description: 'C', amount: 33.33 },
    ]
    const totals = computeTotals(items, 'standard20')
    expect(totals).toEqual({ net: 99.99, vat: 20.0, total: 119.99 })
    expect(totals.vat).not.toBe(20.01)
  })

  it('rounds VAT once for the whole invoice at the standard rate on awkward cents', () => {
    // Per line: round2(1.03 * 0.2) = 0.21, three times = 0.63.
    // Per invoice: round2(3.09 * 0.2) = round2(0.618) = 0.62.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 1.03 },
      { description: 'b', amount: 1.03 },
      { description: 'c', amount: 1.03 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 3.09, vat: 0.62, total: 3.71 })
  })

  it('rounds VAT once for the whole invoice at the reduced rate', () => {
    // Per line: 0.05 * 0.1 = 0.005 -> 0.01 each -> 0.03 VAT.
    // Per invoice: 0.15 * 0.1 = 0.015 -> 0.02 VAT.
    const items: InvoiceLineItem[] = [
      { description: 'A', amount: 0.05 },
      { description: 'B', amount: 0.05 },
      { description: 'C', amount: 0.05 },
    ]
    const totals = computeTotals(items, 'reduced10')
    expect(totals).toEqual({ net: 0.15, vat: 0.02, total: 0.17 })
    expect(totals.vat).not.toBe(0.03)
  })

  it('rounds a two-line reduced-rate invoice once rather than twice', () => {
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

  it('rounds the net once over the whole invoice, not once per line', () => {
    // Per line: round2(0.0625) = 0.06, twice = 0.12.
    // Per invoice: round2(0.125) = 0.13.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 0.0625 },
      { description: 'b', amount: 0.0625 },
    ]
    expect(computeTotals(items, 'none').net).toBe(0.13)
  })

  it('rounds a two-line net once rather than twice', () => {
    // Per line: 12.35 x2 = 24.70. Per invoice: 24.69.
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 12.345 },
      { description: 'b', amount: 12.345 },
    ]
    expect(computeTotals(items, 'standard20')).toEqual({ net: 24.69, vat: 4.94, total: 29.63 })
  })

  it('rounds the net when the lines carry more precision than two decimals', () => {
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 33.333 },
      { description: 'b', amount: 33.333 },
      { description: 'c', amount: 33.333 },
    ]
    // 99.999 net -> 100.00; VAT on the rounded net -> 20.00.
    expect(computeTotals(items, 'standard20')).toEqual({ net: 100, vat: 20, total: 120 })
  })

  it('computes VAT on the rounded net, not on the raw sum', () => {
    // Raw 0.625 -> net rounds to 0.63; VAT is 0.63 * 0.2 = 0.126 -> 0.13.
    // VAT on the raw 0.625 would give 0.125 -> 0.13 as well, but the net differs,
    // so the total is what pins the order of operations.
    expect(computeTotals([{ description: 'x', amount: 0.625 }], 'standard20')).toEqual({
      net: 0.63,
      vat: 0.13,
      total: 0.76,
    })
  })

  // --- half-up, never banker's ---

  it.each<[number, number]>([
    [0.125, 0.13],
    [0.375, 0.38],
    [0.625, 0.63],
    [0.875, 0.88],
    [2.125, 2.13],
  ])('rounds a net of exactly %s half-up to %s', (amount, expectedNet) => {
    // Banker's rounding would give 0.12 / 0.38 / 0.62 / 0.88 / 2.12 here.
    expect(computeTotals([{ description: 'x', amount }], 'none').net).toBe(expectedNet)
  })

  it.each<[number, number]>([
    [0.124, 0.12],
    [0.126, 0.13],
    [1.004, 1.0],
    [1.006, 1.01],
  ])('rounds %s to %s on either side of the half', (amount, expected) => {
    expect(computeTotals([{ description: 'x', amount }], 'none').net).toBe(expected)
  })

  it.each<[number, number, number]>([
    [0.05, 0.01, 0.06], // 0.005 exactly -> up
    [0.25, 0.03, 0.28], // 0.025 exactly -> up
    [12.25, 1.23, 13.48], // 1.225 exactly -> up
  ])(
    'rounds a reduced-rate VAT of exactly half a cent upwards: net %s gives VAT %s',
    (net, vat, total) => {
      expect(computeTotals([{ description: 'L', amount: net }], 'reduced10')).toEqual({
        net,
        vat,
        total,
      })
    },
  )

  it.each<[number, number, number]>([
    [33.33, 6.67, 40.0],
    [0.01, 0.0, 0.01], // VAT can legitimately round away entirely
    [999999.99, 200000.0, 1199999.99],
  ])('rounds 20%% VAT on %s to %s', (amount, vat, total) => {
    expect(computeTotals([{ description: 'L', amount }], 'standard20')).toEqual({
      net: amount,
      vat,
      total,
    })
  })

  it('leaves an amount that is already at two decimals untouched', () => {
    expect(computeTotals([{ description: 'x', amount: 4210.55 }], 'none')).toEqual({
      net: 4210.55,
      vat: 0,
      total: 4210.55,
    })
  })

  // --- floating point must not drift ---

  it('does not accumulate binary floating-point error across ten lines', () => {
    const items: InvoiceLineItem[] = Array.from({ length: 10 }, (_, i) => ({
      description: `L${i}`,
      amount: 0.1,
    }))
    expect(computeTotals(items, 'standard20')).toEqual({ net: 1, vat: 0.2, total: 1.2 })
  })

  it('keeps a hundred tiny lines from drifting', () => {
    const items: InvoiceLineItem[] = Array.from({ length: 100 }, (_, i) => ({
      description: `line ${i}`,
      amount: 0.01,
    }))
    expect(computeTotals(items, 'standard20')).toEqual({ net: 1, vat: 0.2, total: 1.2 })
  })

  // --- structural invariants ---

  it('keeps the total exactly equal to net plus VAT in every mode', () => {
    const items: InvoiceLineItem[] = [
      { description: 'a', amount: 33.333 },
      { description: 'b', amount: 12.345 },
      { description: 'c', amount: 1234.56 },
    ]
    for (const mode of ALL_MODES) {
      const { net, vat, total } = computeTotals(items, mode)
      expect(total).toBe(Math.round((net + vat) * 100) / 100)
    }
  })

  it.each<[VatMode]>([['standard20'], ['reduced10']])(
    'reports every figure at two decimals in %s mode',
    (mode) => {
      const { net, vat, total } = computeTotals([{ description: 'x', amount: 33.333 }], mode)
      for (const n of [net, vat, total]) {
        expect(Number(n.toFixed(2))).toBe(n)
      }
    },
  )

  it('leaves no VAT on an export invoice however large the net', () => {
    const totals = computeTotals(
      [{ description: 'Consulting', amount: 987654.321 }],
      'exempt_export',
    )
    expect(totals.vat).toBe(0)
    expect(totals.total).toBe(totals.net)
  })

  // --- discounts, credits, zero lines ---

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
// invoice-number.ts — suggestNextNumber
// D12: a typing shortcut behind a confirm step, never an allocator.
// ===========================================================================

describe('suggestNextNumber', () => {
  it('increments the invoice number and preserves its zero-padding', () => {
    expect(suggestNextNumber('0007/2026')).toBe('0008/2026')
  })

  it('increments a per-customer number with a text prefix', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe('KLIJENTA-2026-04')
  })

  it.each<[string, string]>([
    ['0', '1'],
    ['7', '8'],
    ['9', '10'], // width 1 must grow, never wrap to '0'
    ['00', '01'],
    ['12', '13'],
    ['99', '100'],
    ['099', '100'],
    ['999', '1000'],
    ['0000', '0001'],
    ['0009', '0010'],
    ['0099', '0100'],
    ['A1', 'A2'],
    ['INV-9', 'INV-10'],
    ['INV-0009', 'INV-0010'],
    ['FAKTURA 007', 'FAKTURA 008'],
    ['KLIJENTA-2026-09', 'KLIJENTA-2026-10'],
    ['KLIJENTA-2026-99', 'KLIJENTA-2026-100'],
    ['0099/2026', '0100/2026'],
  ])('suggests %s -> %s', (last, expected) => {
    expect(suggestNextNumber(last)).toBe(expected)
  })

  it('does not widen a number that still has room in its padding', () => {
    expect(suggestNextNumber('0007/2026')).not.toBe('008/2026')
    expect(suggestNextNumber('0007/2026')).not.toBe('8/2026')
  })

  it('does not add padding to a number that had none', () => {
    expect(suggestNextNumber('9')).toBe('10')
  })

  it.each<[string]>([
    ['2026/07/A'], // trailing group is not numeric
    ['0007A'],
    ['0007/'],
    ['INV-A'],
    ['99/A'],
    ['0008/2026-rev'],
    ['0007/2026-REV'],
    ['12-B'],
    ['-'],
    ['FAKTURA'], // no digits anywhere
    ['KLIJENTA'],
    ['   '], // whitespace only
    [''],
  ])('returns null for "%s" rather than guessing a scheme', (last) => {
    expect(suggestNextNumber(last)).toBeNull()
  })

  it('returns null for the first invoice to a customer, when there is no previous number', () => {
    expect(suggestNextNumber(null)).toBeNull()
  })

  it('does not apply year-rollover or any other scheme understanding', () => {
    // No calendar logic: December simply becomes a thirteenth month and the
    // human fixes it at the confirm step.
    expect(suggestNextNumber('KLIJENTA-2026-12')).toBe('KLIJENTA-2026-13')
  })

  it('can be applied twice to walk two invoices forward', () => {
    const once = suggestNextNumber('KLIJENTA-2026-03')
    expect(once).not.toBeNull()
    expect(suggestNextNumber(once)).toBe('KLIJENTA-2026-05')
  })

  it('returns a string, never a number, so the caller cannot lose the padding', () => {
    expect(typeof suggestNextNumber('0007/2026')).toBe('string')
  })

  it('is a pure suggestion: the same input always gives the same answer', () => {
    expect(suggestNextNumber('KLIJENTA-2026-03')).toBe(suggestNextNumber('KLIJENTA-2026-03'))
  })
})

// ===========================================================================
// invoice-number.ts — isDuplicateNumber
// Warn, never block.
// ===========================================================================

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

  it.each<[string, string[]]>([
    ['7/2026', ['17/2026', '7/20260']],
    ['8/2026', ['0008/2026']],
    ['0008', ['0008/2026']],
  ])('does not treat "%s" as used merely because another number contains it', (candidate, used) => {
    expect(isDuplicateNumber(candidate, used)).toBe(false)
  })

  it('reports no duplicate for an empty candidate against a non-empty history', () => {
    expect(isDuplicateNumber('', ['0008/2026'])).toBe(false)
  })

  // MERGE NOTE — no majority; only e1 took a position on leniency. Resolved
  // toward the safer behaviour: a false warning costs one tap, a missed clash
  // costs a numbering problem with the tax authority. Recorded as a spec gap.
  it('reports a duplicate despite surrounding whitespace', () => {
    expect(isDuplicateNumber(' 0008/2026 ', ['0008/2026'])).toBe(true)
  })

  it('reports a duplicate despite differing letter case, since a warning is cheap', () => {
    expect(isDuplicateNumber('klijenta-2026-03', ['KLIJENTA-2026-03'])).toBe(true)
  })

  it('does not mutate the history it is given', () => {
    const used = ['0007/2026', '0008/2026']
    expect(isDuplicateNumber('0008/2026', used)).toBe(true)
    expect(used).toEqual(['0007/2026', '0008/2026'])
  })
})

// ===========================================================================
// invoice-number.ts — validateNumber
// Free text; only emptiness and length are rejected.
// ===========================================================================

describe('validateNumber', () => {
  it.each<[string]>([
    ['0008/2026'],
    ['KLIJENTA-2026-04'],
    ['2026/07/A'],
    ['7'],
    ['A'],
    ['FAKTURA br. 7 / 2026'],
    ['Faktura br. 7 — Klijent A'],
    ['KLIJENTA-KONSULTANTSKE-USLUGE-2026-07-0008'],
    ['ФАКТУРА-1'], // Cyrillic
    ['№7/2026'], // numero sign
    ['—'], // em dash
  ])('accepts "%s", because the scheme belongs to the user, not to E', (candidate) => {
    expect(validateNumber(candidate).valid).toBe(true)
  })

  it('accepts a number of ordinary length', () => {
    expect(validateNumber('A'.repeat(32)).valid).toBe(true)
  })

  it('returns exactly { valid: true } with no error for an accepted number', () => {
    expect(validateNumber('0008/2026')).toEqual({ valid: true })
    expect(validateNumber('0008/2026').error).toBeUndefined()
  })

  it.each<[string, string]>([
    ['', 'an empty number'],
    ['   ', 'a whitespace-only number'],
  ])('rejects "%s" (%s) with an explanation', (candidate) => {
    const result = validateNumber(candidate)
    expect(result.valid).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
  })

  it('rejects an absurdly long number with an explanation', () => {
    const result = validateNumber('9'.repeat(1000))
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('does not reject a number merely because it cannot be incremented', () => {
    // validateNumber and suggestNextNumber are independent: E may be unable to
    // suggest the next one, but the number you typed is still legal.
    expect(suggestNextNumber('2026/07/A')).toBeNull()
    expect(validateNumber('2026/07/A').valid).toBe(true)
  })
})

// ===========================================================================
// invoice-template.ts — buildInvoiceData
// Everything the renderer needs, fully resolved. No drawing, no I/O.
// ===========================================================================

describe('buildInvoiceData', () => {
  // --- the invoice number is text (D12) ---

  it.each<[string]>([['7'], ['0007/2026'], ['KLIJENTA-2026-04'], ['2026/07/A']])(
    'passes the number "%s" through as text, never zero-padding it',
    (invoiceNumber) => {
      expect(buildInvoiceData(makeInput({ invoiceNumber })).invoiceNumber).toBe(invoiceNumber)
    },
  )

  // --- pass-through of the snapshots ---

  it('passes the issue date through unchanged', () => {
    expect(buildInvoiceData(makeInput({ issueDate: '2026-02-28' })).issueDate).toBe('2026-02-28')
  })

  it('carries the seller and customer snapshots through unchanged', () => {
    const data = buildInvoiceData(makeInput())
    expect(data.seller).toEqual(SELLER)
    expect(data.customer).toEqual(CUSTOMER_RS)
  })

  it('keeps a customer whose country is unknown rather than inventing one', () => {
    const customer = { name: 'Nepoznat', country: null }
    expect(buildInvoiceData(makeInput({ customer })).customer.country).toBeNull()
  })

  it('carries a foreign customer that has no PIB', () => {
    const data = buildInvoiceData(
      makeInput({ customer: CUSTOMER_DE, currency: 'EUR', vatMode: 'exempt_export' }),
    )
    expect(data.customer.pib).toBeUndefined()
    expect(data.customer.country).toBe('DE')
  })

  it('carries the line items through in the order given', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'Konsultantske usluge', amount: 300000 },
      { description: 'Putni troskovi', amount: 12500 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).lineItems).toEqual(lineItems)
  })

  // --- totals delegate to computeTotals ---

  it('resolves the totals from the line items and the VAT mode', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'a', amount: 1.03 },
      { description: 'b', amount: 1.03 },
      { description: 'c', amount: 1.03 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).totals).toEqual({
      net: 3.09,
      vat: 0.62,
      total: 3.71,
    })
  })

  it('rounds the totals once per invoice, exactly as computeTotals does', () => {
    const lineItems: InvoiceLineItem[] = [
      { description: 'a', amount: 33.333 },
      { description: 'b', amount: 33.333 },
      { description: 'c', amount: 33.333 },
    ]
    expect(buildInvoiceData(makeInput({ lineItems })).totals).toEqual({
      net: 100,
      vat: 20,
      total: 120,
    })
  })

  it('builds an invoice with no line items as zero totals rather than failing', () => {
    const data = buildInvoiceData(makeInput({ lineItems: [] }))
    expect(data.lineItems).toEqual([])
    expect(data.totals).toEqual({ net: 0, vat: 0, total: 0 })
  })

  // --- VAT presentation ---

  it.each<[VatMode, boolean]>([
    ['standard20', true],
    ['reduced10', true],
    ['exempt_export', false],
    ['none', false],
  ])('sets showVatLine for %s to %s', (vatMode, showVatLine) => {
    expect(buildInvoiceData(makeInput({ vatMode })).showVatLine).toBe(showVatLine)
  })

  it('gives an exempt export no VAT line and a zero VAT amount, which are different things', () => {
    const data = buildInvoiceData(
      makeInput({ vatMode: 'exempt_export', customer: CUSTOMER_DE, currency: 'EUR' }),
    )
    expect(data.showVatLine).toBe(false)
    expect(data.totals).toEqual({ net: 1000, vat: 0, total: 1000 })
    expect(data.legalNote).toBe(LEGAL_NOTES.exempt_export)
  })

  it('echoes the resolved VAT mode back to the renderer', () => {
    expect(buildInvoiceData(makeInput({ vatMode: 'reduced10' })).vatMode).toBe('reduced10')
  })

  // --- legal notes are supplied, never composed ---

  it.each<[VatMode]>([['none'], ['standard20'], ['reduced10'], ['exempt_export']])(
    'prints the caller-supplied legal note for %s verbatim',
    (vatMode) => {
      expect(buildInvoiceData(makeInput({ vatMode })).legalNote).toBe(LEGAL_NOTES[vatMode])
    },
  )

  it('does not invent legal wording of its own', () => {
    const legalNotes: Record<VatMode, string> = { ...LEGAL_NOTES, exempt_export: 'CUSTOM NOTE 17.1' }
    const data = buildInvoiceData(makeInput({ vatMode: 'exempt_export', legalNotes }))
    expect(data.legalNote).toBe('CUSTOM NOTE 17.1')
  })

  it('prints an empty legal note when none is configured, rather than substituting one', () => {
    const legalNotes: Record<VatMode, string> = { ...LEGAL_NOTES, exempt_export: '' }
    expect(buildInvoiceData(makeInput({ vatMode: 'exempt_export', legalNotes })).legalNote).toBe('')
  })

  // --- bilingual output is currency-driven only ---

  it.each<[Currency, boolean]>([
    ['RSD', false],
    ['EUR', true],
    ['USD', true],
    ['CHF', true],
    ['GBP', true],
  ])('renders a %s invoice with bilingual=%s', (currency, bilingual) => {
    expect(buildInvoiceData(makeInput({ currency, exchangeRate: null })).bilingual).toBe(bilingual)
  })

  it('does not turn a foreign-currency invoice monolingual because it is VAT-exempt', () => {
    const data = buildInvoiceData(
      makeInput({ currency: 'EUR', vatMode: 'exempt_export', customer: CUSTOMER_DE }),
    )
    expect(data.bilingual).toBe(true)
  })

  it('does not turn a dinar invoice bilingual because it is VAT-exempt', () => {
    expect(buildInvoiceData(makeInput({ currency: 'RSD', vatMode: 'exempt_export' })).bilingual).toBe(
      false,
    )
  })

  // --- currency and VAT stay independent: all four combinations ---

  it.each<[Currency, VatMode, number, boolean, boolean]>([
    ['RSD', 'standard20', 200, true, false],
    ['RSD', 'exempt_export', 0, false, false],
    ['EUR', 'standard20', 200, true, true],
    ['EUR', 'exempt_export', 0, false, true],
  ])(
    'keeps currency %s and VAT mode %s independent (vat %d, vatLine %s, bilingual %s)',
    (currency, vatMode, vat, showVatLine, bilingual) => {
      const data = buildInvoiceData(
        makeInput({
          currency,
          vatMode,
          exchangeRate: currency === 'RSD' ? null : 117.5,
          lineItems: [{ description: 'Usluge', amount: 1000 }],
        }),
      )
      expect(data.currency).toBe(currency)
      expect(data.vatMode).toBe(vatMode)
      expect(data.totals.vat).toBe(vat)
      expect(data.showVatLine).toBe(showVatLine)
      expect(data.bilingual).toBe(bilingual)
    },
  )

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

  it('converts the VAT-inclusive total, not the net', () => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'standard20',
        exchangeRate: 117.5,
        lineItems: [{ description: 'Consulting', amount: 100 }],
      }),
    )
    expect(data.totals.total).toBe(120)
    expect(data.totalRsd).toBe(14100)
  })

  it.each<[number, number, number]>([
    [1, 117.2345, 117.23],
    [1, 117.2033, 117.2],
    [100, 117.2593, 14071.12],
  ])('rounds the dinar equivalent of %s at rate %s half-up to %s', (amount, rate, expected) => {
    const data = buildInvoiceData(
      makeInput({
        currency: 'EUR',
        vatMode: 'none',
        exchangeRate: rate,
        lineItems: [{ description: 'A', amount }],
      }),
    )
    expect(data.totalRsd).toBe(expected)
  })

  it('leaves the dinar equivalent null when no exchange rate is available', () => {
    const data = buildInvoiceData(
      makeInput({ currency: 'EUR', vatMode: 'exempt_export', exchangeRate: null }),
    )
    expect(data.exchangeRate).toBeNull()
    expect(data.totalRsd).toBeNull()
  })

  it.each<[number]>([[0], [-1], [-117.5]])(
    'leaves the dinar equivalent null for the non-positive rate %s rather than producing a zero',
    (exchangeRate) => {
      expect(buildInvoiceData(makeInput({ currency: 'EUR', exchangeRate })).totalRsd).toBeNull()
    },
  )

  it('leaves the dinar equivalent null on a dinar invoice, which needs no conversion', () => {
    expect(buildInvoiceData(makeInput({ currency: 'RSD', exchangeRate: null })).totalRsd).toBeNull()
  })

  // --- payment reference ---

  it('defaults the payment reference to the invoice number', () => {
    expect(buildInvoiceData(makeInput({ invoiceNumber: 'KLIJENTA-2026-04' })).paymentReference).toBe(
      'KLIJENTA-2026-04',
    )
  })

  it('uses the payment reference the user overrode it with', () => {
    expect(buildInvoiceData(makeInput({ paymentReference: '97-1234567890' })).paymentReference).toBe(
      '97-1234567890',
    )
  })

  it('falls back to the invoice number when the supplied payment reference is blank', () => {
    const data = buildInvoiceData(makeInput({ invoiceNumber: 'A-1', paymentReference: '' }))
    expect(data.paymentReference).toBe('A-1')
  })

  // --- purity ---

  it('does no I/O and no drawing: the same input always builds the same data', () => {
    const input = makeInput({ currency: 'EUR', exchangeRate: 117.5, vatMode: 'exempt_export' })
    expect(buildInvoiceData(input)).toEqual(buildInvoiceData(input))
  })

  it('does not mutate the input it is given', () => {
    const input = deepFreeze(makeInput())
    expect(buildInvoiceData(input).totals.total).toBe(1200)
    expect(input.lineItems).toEqual([{ description: 'Konsultantske usluge', amount: 1000 }])
  })
})
