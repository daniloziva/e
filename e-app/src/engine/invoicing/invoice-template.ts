import { toRsd } from '../money.js'

import { computeTotals } from './invoice-model.js'
import { rendersVatLine } from './vat-mode.js'

import type { VatMode } from './vat-mode.js'
import type { InvoiceLineItem, InvoiceTotals } from './invoice-model.js'
import type { Currency } from '../types.js'

export interface PdfInvoiceData {
  invoiceNumber: string          // text, exactly as supplied — never zero-padded
  issueDate: string              // YYYY-MM-DD
  seller: { name: string; pib: string; mb?: string; address?: string; bankAccount: string }
  customer: { name: string; pib?: string; mb?: string; address?: string; country: string | null }
  lineItems: InvoiceLineItem[]
  totals: InvoiceTotals
  vatMode: VatMode
  showVatLine: boolean
  legalNote: string
  currency: Currency
  exchangeRate: number | null
  totalRsd: number | null
  paymentReference: string
  bilingual: boolean             // true for non-RSD invoices
}

export interface BuildInvoiceInput {
  invoiceNumber: string
  issueDate: string
  seller: PdfInvoiceData['seller']
  customer: PdfInvoiceData['customer']
  lineItems: InvoiceLineItem[]
  currency: Currency
  vatMode: VatMode
  exchangeRate: number | null
  legalNotes: Record<VatMode, string>
  paymentReference?: string
}

/**
 * Fully resolve everything the renderer needs. No drawing, no I/O.
 *
 * Three things this layer decides, and one it refuses to:
 *
 *  - `showVatLine` — the exempt-export boundary (03-DILIGAF.md:181). An exempt
 *    export emits `showVatLine: false` with `vat: 0` and an exemption note; a
 *    zero-rated supply would emit `showVatLine: true` with `vat: 0` and no such
 *    note. Same arithmetic, different documents, and the renderer must never
 *    have to infer which from the number 0.
 *  - `bilingual` — driven by currency alone. Currency and VAT mode are
 *    independent: a domestic customer can be billed in EUR and a foreign one in
 *    RSD, and coupling them would silently produce a wrong invoice.
 *  - `totalRsd` — the VAT-inclusive total at the supplied middle rate, or null.
 *    Null when there is no rate, when the rate is not positive, and on a dinar
 *    invoice that needs no conversion. Never a placeholder zero.
 *
 * What it refuses: composing legal wording. `legalNote` is whatever the caller
 * configured for this mode, printed verbatim — including the empty string. The
 * export exemption text and its citation are an accountant's determination
 * (08-OPEN-QUESTIONS.md Q18), still open, so it is an input to this layer and
 * never a constant inside it.
 *
 * Nothing supplied by the caller is mutated; the snapshots are copied out.
 */
export function buildInvoiceData(input: BuildInvoiceInput): PdfInvoiceData {
  const lineItems = input.lineItems.map((item) => ({ ...item }))
  const totals = computeTotals(lineItems, input.vatMode)

  const bilingual = input.currency !== 'RSD'

  const supplied = input.paymentReference
  const paymentReference =
    typeof supplied === 'string' && supplied.trim() !== '' ? supplied : input.invoiceNumber

  return {
    invoiceNumber: input.invoiceNumber,
    issueDate: input.issueDate,
    seller: { ...input.seller },
    customer: { ...input.customer },
    lineItems,
    totals,
    vatMode: input.vatMode,
    showVatLine: rendersVatLine(input.vatMode),
    // `?? ''` guards a note table that arrived from JSON short of a key: a
    // missing note prints as nothing, never as "undefined" on a tax document.
    legalNote: input.legalNotes[input.vatMode] ?? '',
    currency: input.currency,
    exchangeRate: input.exchangeRate,
    totalRsd: bilingual
      ? toRsd({ amount: totals.total, currency: input.currency }, input.exchangeRate)
      : null,
    paymentReference,
    bilingual,
  }
}
