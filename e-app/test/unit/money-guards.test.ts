import { describe, it, expect } from 'vitest'
import { toRsd } from '../../src/engine/money.js'
import { computeTotals } from '../../src/engine/invoicing/invoice-model.js'
import type { Currency } from '../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// GUARDS THE MERGE LOST — new tests for behaviour no frozen case covers.
//
// TEST-FREEZE.md permits "adding tests for new behaviour that no test covers".
// Nothing frozen is touched here.
//
// Both gaps were found by MUTATION TESTING, not by reading: an implementation
// was deliberately broken, the suite was run, and it stayed green. That is the
// only way to find an assertion that passes for the wrong reason.
// ─────────────────────────────────────────────────────────────────────────────

const eur = (amount: number): { amount: number; currency: Currency } => ({ amount, currency: 'EUR' })

// ── GAP 1 — the dinar conversion could truncate and nothing would notice ─────
//
// All THREE draft suites independently pinned an exact 2dp `totalRsd`, and one
// of them (e2) was the only round-UP case. The merge folded all three into one
// `it.each` whose body hardcodes `vatMode: 'none'`, which made the e2 row
// arithmetically unsatisfiable — it is the permanently-red `invoicing.test.ts:891`
// (CANDIDATE-014). The two surviving rows both round DOWN.
//
// Measured consequence: replacing `round2(amount * rate)` with
// `Math.floor(amount * rate * 100) / 100` in `toRsd` leaves the whole suite
// bit-identical — 547 cases, including all 354 money cases, cannot tell a
// truncating currency conversion from a correct one. Every foreign-currency
// invoice's RSD figure would be systematically a cent light, forever, silently.

describe('toRsd rounds half away from zero — it does not truncate', () => {
  it.each([
    // amount, rate, expected — chosen so truncation and rounding DIFFER
    [100, 117.2593, 11725.93], // raw 11725.93000…, third decimal forces the choice
    [1, 117.2345, 117.23], // rounds down — kept from the drafts
    [1, 117.2033, 117.2], // rounds down — kept from the drafts
    // Measured discriminators: round2 and a truncating floor disagree on these.
    [1, 117.235, 117.24], // floor gives 117.23
    [1, 117.125, 117.13], // floor gives 117.12
    [7, 14.2925, 100.05], // floor gives 100.04
    [2, 58.6175, 117.24], // floor gives 117.23
  ])('converts %s at %s to %s', (amount, rate, expected) => {
    expect(toRsd(eur(amount), rate)).toBe(expected)
  })

  it('rounds up rather than truncating, which a floor would get wrong', () => {
    // The assertion that kills the truncation mutant. NOTE: the value matters —
    // 100 @ 117.2593 does NOT discriminate (both give 11725.93), which is why
    // the frozen table cannot detect truncation at all. These do.
    for (const [amount, rate] of [
      [1, 117.235],
      [1, 117.125],
      [7, 14.2925],
    ] as const) {
      expect(toRsd(eur(amount), rate)).not.toBe(Math.floor(amount * rate * 100) / 100)
    }
  })

  it('is symmetric for a credit note, so a reversal returns the original figure', () => {
    const out = toRsd(eur(-100), 117.2593)
    expect(out).toBe(-11725.93)
    expect(out).toBe(-(toRsd(eur(100), 117.2593) ?? 0))
  })
})

// ── GAP 2 — the VAT ordering is documented but unguarded ─────────────────────
//
// `invoice-model.ts` states that VAT is computed on the ROUNDED net, not on the
// raw sum. `invoicing.test.ts:334-343` is titled "computes VAT on the rounded
// net, not on the raw sum" — but its fixture cannot tell the two apart: the net
// is `round2(sum)` under either reading, so the whole triple is identical.
//
// Measured: mutating `computeTotals` to `round2(sum * rate)` leaves the merged
// suite AND all three drafts green. The ordering is asserted by a comment only.
//
// These fixtures discriminate. Each has a raw sum whose 3rd decimal changes the
// answer depending on whether the rounding happens before or after the rate.

describe('VAT is computed on the rounded net, not on the raw sum', () => {
  it.each([
    // lines, mode, expected net, expected VAT (taken on the ROUNDED net)
    [[0.175], 'standard20' as const, 0.18, 0.04],
    [[8.575], 'standard20' as const, 8.58, 1.72],
    [[0.045], 'reduced10' as const, 0.05, 0.01],
  ])('lines %j at %s give net %s and VAT %s', (amounts, mode, net, vat) => {
    const totals = computeTotals(
      amounts.map((amount, i) => ({ description: `L${i}`, amount })),
      mode,
    )
    expect(totals.net).toBe(net)
    expect(totals.vat).toBe(vat)
  })

  it('takes the rate on the rounded net, which a raw-sum implementation gets wrong', () => {
    // 0.045 → net 0.05. 10% of the ROUNDED net is 0.005 → round2 → 0.01.
    // 10% of the RAW sum is 0.0045 → round2 → 0.00. The two disagree, which is
    // exactly what the frozen fixture could not express.
    const totals = computeTotals([{ description: 'L', amount: 0.045 }], 'reduced10')
    expect(totals.net).toBe(0.05)
    expect(totals.vat).toBe(0.01)
    expect(totals.vat).not.toBe(0)
  })
})
