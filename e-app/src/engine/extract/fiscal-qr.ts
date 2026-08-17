import type { ExtractedFacts } from '../types.js'

/**
 * PLACEHOLDER — layer 1 of the extraction ladder (01-ARCHITECTURE §5).
 *
 * STILL BLOCKED ON: fixture F10 (one real QR payload string) and a real Serbian
 * verification response. No test file exists for this module and none should be
 * written until both land.
 *
 * WHAT SPIKE S-QR HAS ESTABLISHED (2026-08-15), from the TaxCore documentation:
 *
 *   - The QR carries ONLY a verification URL. No totals are in the payload.
 *   - That URL answers a plain `GET` with `Accept: application/json`, and needs
 *     NO authentication.
 *   - The response carries taxId, businessName, totalAmount, isValid,
 *     refundStatus and a populated `items[]` — enough to categorize a receipt
 *     deterministically, with no model involved.
 *
 * TWO CAVEATS THAT SHAPE THIS MODULE:
 *
 *   1. There is NO structured VAT field. `invoiceResult.totalAmount` is the
 *      gross; the tax breakdown exists only inside the `journal` free-text
 *      blob. So `vatAmount` and `amountNet` require parsing `journal` even on
 *      the happy path — this rung is not purely structural.
 *   2. Real-world hit rate is POOR: on a real receipt the QR could not be read by
 *      any phone scanner tried. The payload is a signed blob of ~400–600 bytes
 *      printed at ~2cm on thermal paper.
 *
 * THE v1.1 RULING (Danilo, 2026-08-15): do NOT engineer around a failed QR.
 * One decode attempt, then fall through to Document Intelligence and then to the
 * OpenAI parser — the rungs the ladder already defines, judged sufficient for
 * precision. No preprocessing, no perspective correction, no multi-pass decoding
 * heroics belong in this module or its adapter. `runLadder` short-circuits on the
 * first success, so a miss here costs only the attempt.
 *
 * The response types below mirror the documented TaxCore shape. They are named
 * after the wire fields deliberately: this is the ONE place that shape is
 * allowed to be known. Everything downstream sees `ExtractedFacts`.
 */

/** Врста рачуна — invoice type. */
export type FiscalInvoiceType = 0 | 1 | 2 | 3 | 4 // Промет | Предрачун | Копија | Обука | Аванс

/** Тип трансакције — 0 sale, 1 refund. */
export type FiscalTransactionType = 0 | 1

/** Начин плаћања — other-cashless | cash | card | cheque | transfer | voucher | instant. */
export type FiscalPaymentType = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface FiscalVerificationResponse {
  invoiceRequest: {
    posTime: string | null
    /** Seller PIB — 9 digits. */
    taxId: string
    businessName: string
    locationName: string
    address: string
    city: string
    administrativeUnit: string
    /**
     * Buyer identity when the receipt was issued to a company, e.g. `10:111886391`
     * where the `10:` prefix is the ID-type code for a PIB.
     *
     * WORTH MORE THAN IT LOOKS: a receipt carrying DILIGAF's own PIB is a business
     * expense by construction, and one without it is personal. That is a
     * deterministic book-routing signal, free at this rung, and it separates the
     * one case `resolveBook` cannot — PERSONAL and DILIGAF share a phone (Q13).
     */
    /** Documented as nullable; `unknown` already admits null, so it is not spelled out. */
    buyer: unknown
    buyerCostCenter: unknown
    cashier: string | null
    requestedBy: string
    referentDocumentNumber: string | null
    invoiceType: FiscalInvoiceType
    transactionType: FiscalTransactionType
    payments: { paymentType: FiscalPaymentType; amount: number }[]
    items: {
      name: string | null
      quantity: number
      unitPrice: number
      totalPrice: number
      gtin: string | null
    }[]
  }
  invoiceResult: {
    /** Gross total. The VAT split is NOT here — parse `journal` for it. */
    totalAmount: number
    transactionTypeCounter: number
    totalCounter: number
    invoiceCounterExtension: string
    /** PFR invoice number, e.g. `GVE2USTM-GVE2USTM-348119`. */
    invoiceNumber: string
    signedBy: string
    /** PFR signing time, ISO 8601. */
    sdcTime: string
  }
  /** Textual rendering of the receipt. The only place the tax breakdown lives. */
  journal: string
  isValid: boolean
  refundStatus: 'Partial' | 'Full' | null
}

/** What a QR payload resolves to before verification is attempted. */
export interface FiscalQrRef {
  verificationUrl: string
}

/**
 * Parse a raw QR payload into a verification reference.
 * Malformed input returns null — never throws, never guesses.
 */
export function parseQrPayload(_payload: string): FiscalQrRef | null {
  throw new Error('not implemented')
}

/**
 * Map a verification response into facts.
 *
 * Takes `unknown` by design: the adapter performs the fetch, this module does
 * the narrowing, so the wire shape never leaks past this boundary. Must reject
 * rather than trust when `isValid` is false, and must not silently treat a
 * refunded receipt (`refundStatus`) as an ordinary expense.
 */
export function factsFromVerification(_response: unknown): ExtractedFacts | null {
  throw new Error('not implemented')
}

/**
 * Extract the VAT breakdown from the `journal` text.
 *
 * Separate from the mapping above because it is the one genuinely fragile part
 * of this rung. A real Serbian receipt labels 20% PDV as `Ђ` / `О-ПДВ`; the
 * sample in the TaxCore docs is a demo tenant with French labels and must not
 * be used as a fixture. Blocked on F4.
 */
export function vatFromJournal(_journal: string): { vatAmount: number; amountNet: number } | null {
  throw new Error('not implemented')
}
