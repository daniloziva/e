import { round2 } from '../money.js'

import type { VatMode } from './vat-mode.js'

export interface InvoiceLineItem { description: string; amount: number }

export interface InvoiceTotals { net: number; vat: number; total: number }

/** Fractional VAT rates. `exempt_export` is 0 arithmetically and yet is not a
 *  zero-rated supply — that distinction lives in `rendersVatLine`, not here. */
const VAT_RATES: Record<VatMode, number> = {
  none: 0,
  standard20: 0.2,
  reduced10: 0.1,
  exempt_export: 0,
}

export function vatRateFor(mode: VatMode): number {
  return VAT_RATES[mode]
}

/**
 * `round2` can return -0 (it carries the sign through a magnitude that rounded
 * away). `-0` fails `toBe(0)` under Object.is and would surface as "-0,00" on a
 * printed document, so every figure leaving this module is normalised.
 */
function normaliseZero(n: number): number {
  return n === 0 ? 0 : n
}

/**
 * Rounding: half-up to 2dp, applied per invoice, not per line.
 *
 *     net   = round2(sum of line amounts)   <- summed raw, rounded ONCE
 *     vat   = round2(net * rate)            <- computed on the ROUNDED net
 *     total = round2(net + vat)
 *
 * Sum first, round last: rounding each line and then adding drifts by a cent
 * per line, and it is the invoice total — not any line — that the accountant
 * and a future UBL document have to agree on.
 */
export function computeTotals(items: InvoiceLineItem[], mode: VatMode): InvoiceTotals {
  let sum = 0
  for (const item of items) {
    sum += item.amount
  }

  const net = normaliseZero(round2(sum))
  const vat = normaliseZero(round2(net * vatRateFor(mode)))
  const total = normaliseZero(round2(net + vat))

  return { net, vat, total }
}
