export type VatMode = 'none' | 'standard20' | 'reduced10' | 'exempt_export'

export interface CustomerTaxInfo {
  country: string | null      // ISO-2, 'RS' for Serbia
  isBusiness: boolean | null
}

/** ISO-3166-1 alpha-2 shape. Two letters, nothing else. */
const ISO2 = /^[A-Za-z]{2}$/

const SERBIA = 'RS'

/**
 * Derived from the customer, never asked (D13):
 *   RS                      -> standard20
 *   non-RS + business       -> exempt_export
 *   non-RS + not business   -> standard20
 *   country missing         -> null (refuse to assume; the caller must ask)
 *
 * Two refusals beyond "country missing", both for the same reason — the input
 * that decides the answer is not trustworthy, and the two possible answers are
 * different tax documents:
 *
 *   - A country that is not ISO-2 shaped ("Serbia", "SRB") is malformed for the
 *     field. Reading it as "not RS" would zero-rate a Serbian client on a typo,
 *     so it refuses instead of guessing which end of the mapping it belongs to.
 *   - Abroad, `isBusiness` alone decides between no VAT and 20%. Unknown there
 *     is a genuine ambiguity. Inside RS both branches land on standard20, so an
 *     unknown flag decides nothing and must not force a refusal.
 */
export function resolveVatMode(customer: CustomerTaxInfo): VatMode | null {
  // Guarded rather than trusted: a customer record arrives from JSON.
  const country = typeof customer.country === 'string' ? customer.country.trim() : ''
  if (!ISO2.test(country)) return null

  if (country.toUpperCase() === SERBIA) return 'standard20'

  if (customer.isBusiness === true) return 'exempt_export'
  if (customer.isBusiness === false) return 'standard20'
  return null
}

/**
 * exempt_export renders an exemption note and NO VAT line — not a zero-VAT line
 * (03-DILIGAF.md:181). A "PDV 0,00" line states the supply was taxed at zero;
 * an exempt export states it was outside the scope of the tax. Those are
 * different documents to an inspector, which is why this is a boolean the
 * renderer branches on rather than a formatting choice it makes for itself.
 *
 * `none` (not VAT-registered) prints no VAT line either, but for its own
 * reason, and it carries its own note.
 */
export function rendersVatLine(mode: VatMode): boolean {
  return mode === 'standard20' || mode === 'reduced10'
}
