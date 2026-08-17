export type VatMode = 'none' | 'standard20' | 'reduced10' | 'exempt_export'

export interface CustomerTaxInfo {
  country: string | null      // ISO-2, 'RS' for Serbia
  isBusiness: boolean | null
}

/**
 * Derived from the customer, never asked (D13):
 *   RS                      -> standard20
 *   non-RS + business       -> exempt_export
 *   non-RS + not business   -> standard20
 *   country missing         -> null (refuse to assume; the caller must ask)
 */
export function resolveVatMode(_customer: CustomerTaxInfo): VatMode | null {
  throw new Error('not implemented')
}

/** exempt_export renders an exemption note and NO VAT line — not a zero-VAT line. */
export function rendersVatLine(_mode: VatMode): boolean {
  throw new Error('not implemented')
}

