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

/** Fully resolve everything the renderer needs. No drawing, no I/O. */
export function buildInvoiceData(_input: BuildInvoiceInput): PdfInvoiceData {
  throw new Error('not implemented')
}

