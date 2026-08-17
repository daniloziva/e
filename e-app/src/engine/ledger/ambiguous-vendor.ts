import type { Transaction } from '../types.js'

/**
 * The category a transaction carries when nothing was decided about it. It is
 * the review queue, not an answer, so it is not evidence about the vendor.
 */
const UNRESOLVED = 'MISC'

/**
 * Vendor identity: upper case, diacritics folded, whitespace collapsed.
 *
 * NOT `normalizeDescription`. That function is written about bank DESCRIPTORS
 * and strips the volatile parts of one — dates, terminal ids, `REF`/`POS`
 * markers, punctuation. A counterparty is an identity rather than a descriptor,
 * and running the volatile stripper over it would fold a merchant whose name
 * collides with a marker word down to the empty string, which reads here as
 * "no vendor" and quietly re-enables the rules the ambiguity check exists to
 * suppress. This is the letter-folding half only, which is exactly the case-
 * and whitespace-insensitivity the frozen suite pins and nothing more.
 *
 * `đ` has no NFD decomposition of its own and is mapped explicitly, the same
 * way `normalize.ts` does it, so a merchant keys identically in both places.
 */
function vendorFold(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Category identity: a category is a code, so only case and whitespace are folded. */
function categoryFold(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().toUpperCase()
}

/**
 * Categories a vendor has been filed under, most frequent first.
 *
 * `MISC` rows are omitted. A transaction sitting in MISC records that the
 * ladder could NOT decide, so counting it as a resolution would make every
 * vendor with a single unreviewed line look like it had been filed two ways —
 * the ambiguity flag would then suppress exactly the rules that would have
 * cleared the queue.
 *
 * Ties on count are broken by first appearance in the history, so the result is
 * a deterministic function of the history and its order, never of a hash order.
 * UNDERDETERMINED — no frozen case ties two counts.
 *
 * A `Map` rather than an object literal: the keys here are counterparty and
 * category strings that arrive from stored JSON, and `__proto__`, `constructor`
 * and `prototype` are all values a statement descriptor could in principle
 * produce. A Map has no prototype chain to walk into.
 */
export function vendorCategories(
  vendor: string,
  history: Transaction[],
): Array<{ category: string; count: number }> {
  const wanted = vendorFold(vendor)
  // An empty vendor name matches no vendor rather than every vendor: the safe
  // direction, since the alternative reports the whole ledger's spread as one
  // merchant's ambiguity.
  if (wanted === '') return []
  if (!Array.isArray(history)) return []

  const counts = new Map<string, { category: string; count: number; first: number }>()

  history.forEach((row, index) => {
    if (row === null || typeof row !== 'object') return
    // Identity is the counterparty field and never the description text: a
    // descriptor that merely mentions a merchant is not a transaction with it.
    if (vendorFold(row.counterparty) !== wanted) return

    const category = categoryFold(row.category)
    if (category === '' || category === UNRESOLVED) return

    const seen = counts.get(category)
    if (seen === undefined) {
      counts.set(category, { category, count: 1, first: index })
      return
    }
    seen.count += 1
  })

  return [...counts.values()]
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.first - b.first))
    .map((entry) => ({ category: entry.category, count: entry.count }))
}

/**
 * A vendor that has resolved to more than one category is ambiguous: E must
 * stop auto-applying a rule for it and fall back to the line items or ask
 * (04 §3, 00 D16).
 *
 * Strictly `> 1` resolved categories. One category seen a hundred times is a
 * habit, not a conflict; a vendor never seen before is not ambiguous either,
 * because absence of evidence is not evidence of a split.
 *
 * Defined in terms of `vendorCategories` rather than alongside it, so the flag
 * and the itemisation the user is shown can never disagree about what the
 * history says.
 */
export function vendorIsAmbiguous(vendor: string, history: Transaction[]): boolean {
  return vendorCategories(vendor, history).length > 1
}
