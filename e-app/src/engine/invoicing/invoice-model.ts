import type { VatMode } from './vat-mode.js'

export interface InvoiceLineItem { description: string; amount: number }

export interface InvoiceTotals { net: number; vat: number; total: number }

/** Rounding: half-up to 2dp, applied per invoice, not per line. */
export function computeTotals(_items: InvoiceLineItem[], _mode: VatMode): InvoiceTotals {
  throw new Error('not implemented')
}

export function vatRateFor(_mode: VatMode): number {
  throw new Error('not implemented')
}

