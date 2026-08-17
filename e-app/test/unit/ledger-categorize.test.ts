/**
 * E — categorization signal ladder: `categorize`, the rule primitives it stands
 * on, and the ambiguous-vendor meta-rule.
 *
 * Merged from three independent drafts (engineers 1-3).
 * Spec: 04-PERSONAL.md §3 (the signal ladder, ambiguous vendors, the learning
 * loop), 01-ARCHITECTURE.md §5.1 (why vendor isn't enough) and §5 (the model
 * proposes, the code decides), 00-OVERVIEW.md D16.
 *
 * Written BEFORE the implementation exists: every stub throws "not implemented",
 * so every case here fails until the code is written. That is correct RED. No
 * case asserts a throw, because nothing in this area rejects by throwing —
 * refusal is expressed as `null`, or as landing in MISC.
 *
 * ── MERGE RULING 1: precedence is by RUNG, never by rule priority ────────────
 * A rule that carries an `itemPattern` is evidence about WHAT WAS BOUGHT, so it
 * resolves at rung 1 with `source: 'items'`. A rule that matches only the
 * description resolves at rung 2 with `source: 'rule'`. The fixture item rule
 * therefore carries a DELIBERATELY LOWER `priority` than the vendor rule: if the
 * item rung ever lost to a higher-priority vendor rule, the ladder would be
 * decorative. e3 expressed the item rung with an empty `pattern`; that cannot
 * work, since all three drafts also agree an empty pattern matches nothing, so
 * the e1/e2 form (vendor pattern + item pattern) is used throughout.
 *
 * ── MERGE RULING 2: a model proposal must match `allowedCategories` exactly ──
 * `'hrana'` against `['HRANA']` is DISCARDED, not repaired (e2 over e3).
 * 01 §5: "If the JSON doesn't validate, it's a failure, not an interpretation."
 * The code decides; it does not meet the model half way.
 *
 * ── MERGE RULING 3: what "the normalized form" means for `ruleMatches` ───────
 * e1 assumed the volatile-token stripper `deriveRule` uses (so an `exact` rule
 * matches through a trailing date and reference number); e2 assumed only
 * case/whitespace folding (so a regex may match `POS 4738`). Those are mutually
 * exclusive and the spec defines neither, so this file asserts only what all
 * three drafts share: matching is case- and whitespace-insensitive, and a
 * `contains` pattern survives descriptor noise. The question is a spec gap.
 *
 * ── MERGE RULING 4: `ambiguousVendor` is a fact about the vendor ─────────────
 * It is reported `true` whenever the vendor is ambiguous, including when a
 * higher rung (stated, items) made rule matching moot. Only e1 took a position;
 * kept because a suppressed-signal flag that silently disappears is worse than
 * one that is always true to the history.
 */

import { describe, it, expect } from 'vitest'

import { categorize } from '../../src/engine/ledger/categorize.js'
import type { CategorizeInput, CategorizeContext } from '../../src/engine/ledger/categorize.js'
import { sortRules, ruleMatches, deriveRule } from '../../src/engine/ledger/rules.js'
import type { CategorizationRule } from '../../src/engine/ledger/rules.js'
import { vendorIsAmbiguous, vendorCategories } from '../../src/engine/ledger/ambiguous-vendor.js'
import type { Clock, IdGen, Transaction } from '../../src/engine/types.js'

// ─────────────────────────── hand-written fakes ───────────────────────────
// No mocking library. `deriveRule` is handed its id and timestamp because core
// never reads the clock or generates randomness itself; these supply fixed,
// inspectable values, and the id generator counts its calls so a test can prove
// the CALLER allocates ids.

const fakeClock: Clock = { now: () => new Date('2026-08-12T09:00:00.000Z') }

function countingIdGen(): IdGen & { calls: number } {
  const gen = {
    calls: 0,
    next(): string {
      gen.calls += 1
      return `rule-${gen.calls}`
    },
  }
  return gen
}

const AT = fakeClock.now().toISOString()
const ID = 'rule-1'
const BOOK = 'PERSONAL'

// ───────────────────────────── fixtures ─────────────────────────────
// Plain literals throughout.

/** The v1 PERSONAL category set (04 §3). Lives in a JSON blob, not in code. */
const ALLOWED = [
  'STAN', 'HRANA', 'TRANSPORT', 'ZDRAVLJE', 'DECA', 'ZABAVA',
  'ODECA', 'TEHNIKA', 'PUTOVANJA', 'FINANSIJE', 'PRIHOD', 'POREZI', 'MISC',
]

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    book: 'PERSONAL',
    txDate: '2026-07-01',
    valueDate: null,
    description: 'MAXI BEOGRAD',
    counterparty: 'MAXI',
    amount: -1200,
    currency: 'RSD',
    amountRsd: -1200,
    direction: 'out',
    category: 'HRANA',
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: 'dk-1',
    reviewStatus: 'ok',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }
}

function rule(over: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: 'r-1',
    book: BOOK,
    matchType: 'contains',
    pattern: 'MAXI',
    itemPattern: null,
    amountMin: null,
    amountMax: null,
    category: 'HRANA',
    priority: 100,
    hitCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

function input(over: Partial<CategorizeInput> = {}): CategorizeInput {
  return {
    description: 'MAXI BEOGRAD 12.08.2026',
    counterparty: 'MAXI',
    amount: -1200,
    items: [],
    ...over,
  }
}

function ctx(over: Partial<CategorizeContext> = {}): CategorizeContext {
  return {
    rules: [],
    history: [],
    allowedCategories: ALLOWED,
    modelProposal: null,
    ...over,
  }
}

function matchInput(
  over: Partial<{ description: string; items: string[]; amount: number }> = {},
): { description: string; items: string[]; amount: number } {
  return { description: 'MAXI BEOGRAD', items: [], amount: -1200, ...over }
}

/** Rung 2 evidence: who sold it. The recurring-merchant backbone rule. */
const vendorRule = rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA', priority: 100 })

/**
 * Rung 1 evidence: what was bought. Priority is deliberately LOWER than the
 * vendor rule's — see MERGE RULING 1.
 */
const itemRule = rule({
  id: 'r-item',
  pattern: 'MAXI',
  itemPattern: 'PAMPERS',
  category: 'DECA',
  priority: 1,
})

/** The other half of a mixed basket: nappies and milk, filed two ways. */
const foodItemRule = rule({
  id: 'r-item-food',
  pattern: 'MAXI',
  itemPattern: 'MLEKO',
  category: 'HRANA',
  priority: 1,
})

const NAPPIES = { description: 'PAMPERS 4', lineTotal: -800 }
const MILK = { description: 'MLEKO 1L', lineTotal: -200 }

/** A vendor filed two ways: MAXI is ambiguous from here on (04 §3). */
const ambiguousHistory = [
  tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
  tx({ id: 'h2', counterparty: 'MAXI', category: 'DECA' }),
]

/** The same vendor, only ever filed one way. `EPS SNABDEVANJE` never drifts. */
const unambiguousHistory = [
  tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
  tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
]

/** A bank descriptor with no vendor and no line items behind it. */
const cryptic = (): CategorizeInput =>
  input({ description: 'POS 4738 BEOGRAD', counterparty: null, items: [] })

// ═══════════════════════════════════════════════════════════════════════════
// categorize — the signal ladder in strict precedence:
//   stated > items > rule > model > MISC
// ═══════════════════════════════════════════════════════════════════════════

describe('categorize', () => {
  describe('strict precedence, proven where the rungs disagree', () => {
    it('takes what you stated over line items that say otherwise', () => {
      const result = categorize(
        input({ stated: 'TRANSPORT', items: [NAPPIES] }),
        ctx({ rules: [itemRule] }),
      )
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('stated')
    })

    it('takes what you stated over a rule that says otherwise', () => {
      const result = categorize(input({ stated: 'TRANSPORT' }), ctx({ rules: [vendorRule] }))
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('stated')
    })

    it('takes what you stated over a high-confidence model proposal that says otherwise', () => {
      const result = categorize(
        input({ stated: 'TRANSPORT' }),
        ctx({ modelProposal: { category: 'HRANA', confidence: 'high' } }),
      )
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('stated')
    })

    it('takes what you stated when every lower rung disagrees at once', () => {
      const result = categorize(
        input({ stated: 'TRANSPORT', items: [NAPPIES] }),
        ctx({
          rules: [vendorRule, itemRule],
          modelProposal: { category: 'ZABAVA', confidence: 'high' },
        }),
      )
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('stated')
      expect(result.confidence).toBe('high')
    })

    it('takes the line items over a lower-rung vendor rule that says otherwise', () => {
      const result = categorize(input({ items: [NAPPIES] }), ctx({ rules: [vendorRule, itemRule] }))
      expect(result.category).toBe('DECA')
      expect(result.source).toBe('items')
    })

    it('takes the line items over a high-confidence model proposal that says otherwise', () => {
      const result = categorize(
        input({ items: [NAPPIES] }),
        ctx({ rules: [itemRule], modelProposal: { category: 'ZABAVA', confidence: 'high' } }),
      )
      expect(result.category).toBe('DECA')
      expect(result.source).toBe('items')
    })

    it('takes the rule over a high-confidence model proposal that says otherwise', () => {
      const result = categorize(
        input(),
        ctx({ rules: [vendorRule], modelProposal: { category: 'ZABAVA', confidence: 'high' } }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
    })

    it('reports the rule as the source even when the model happens to agree with it', () => {
      const result = categorize(
        input(),
        ctx({ rules: [vendorRule], modelProposal: { category: 'HRANA', confidence: 'high' } }),
      )
      expect(result.source).toBe('rule')
    })

    it('takes a high-confidence in-list model proposal over the MISC floor', () => {
      const result = categorize(cryptic(), ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }))
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('model')
      expect(result.confidence).toBe('high')
    })

    it('falls to MISC and the review queue when no rung fires at all', () => {
      const result = categorize(cryptic(), ctx())
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
      expect(result.confidence).toBe('low')
    })

    it('resolves an unambiguous vendor by rule, at high confidence, with the full result shape', () => {
      expect(categorize(input(), ctx({ rules: [vendorRule] }))).toEqual({
        category: 'HRANA',
        source: 'rule',
        confidence: 'high',
        ambiguousVendor: false,
      })
    })

    it.each(['stated', 'items', 'rule'] as const)(
      'reports high confidence when the %s rung resolves it',
      (expectedSource) => {
        const result = categorize(
          input({
            stated: expectedSource === 'stated' ? 'TRANSPORT' : null,
            items: expectedSource === 'items' ? [NAPPIES] : [],
          }),
          ctx({ rules: [vendorRule, itemRule] }),
        )
        expect(result.source).toBe(expectedSource)
        expect(result.confidence).toBe('high')
      },
    )
  })

  describe('rung 0 — what you stated', () => {
    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ] as const)('ignores a stated value that is %s and drops to the next rung', (_label, stated) => {
      const result = categorize(input({ stated }), ctx({ rules: [vendorRule] }))
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
    })

    it('ignores an absent stated field and drops to the next rung', () => {
      const bare = input()
      delete bare.stated
      expect(categorize(bare, ctx({ rules: [vendorRule] })).source).toBe('rule')
    })

    it('honours a stated category outside the allowed list, because you outrank the list', () => {
      const result = categorize(
        input({ stated: 'KUCNI_LJUBIMCI' }),
        ctx({ rules: [vendorRule], allowedCategories: ALLOWED }),
      )
      expect(result.category).toBe('KUCNI_LJUBIMCI')
      expect(result.source).toBe('stated')
    })

    it('honours a stated MISC as an explicit statement rather than as unresolved', () => {
      const result = categorize(input({ stated: 'MISC' }), ctx({ rules: [vendorRule] }))
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('stated')
    })

    // MERGE NOTE — e3 also expected `'  transport '` to be upper-cased to
    // 'TRANSPORT'. Not adopted: it contradicts MERGE RULING 2, which refuses to
    // repair the model's casing. Only the trimming all three drafts imply (a
    // whitespace-only `stated` counts as absent) is asserted.
    it('trims the surrounding whitespace from a stated category', () => {
      const result = categorize(input({ stated: '  TRANSPORT  ' }), ctx())
      expect(result.category).toBe('TRANSPORT')
      expect(result.source).toBe('stated')
    })
  })

  describe('rung 1 — the line items', () => {
    it('skips the item rung when there are no line items', () => {
      const result = categorize(input({ items: [] }), ctx({ rules: [vendorRule, itemRule] }))
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
    })

    it('skips the item rung when no line item is recognised', () => {
      const result = categorize(
        input({ items: [{ description: 'NEPOZNATA STAVKA', lineTotal: -300 }] }),
        ctx({ rules: [vendorRule, itemRule] }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
    })

    it('resolves from a line item whose lineTotal is absent, since a missing amount is not a missing item', () => {
      const result = categorize(
        input({ items: [{ description: 'PAMPERS 4', lineTotal: null }] }),
        ctx({ rules: [itemRule] }),
      )
      expect(result.category).toBe('DECA')
      expect(result.source).toBe('items')
    })

    it('resolves when several line items agree', () => {
      const result = categorize(
        input({ items: [NAPPIES, { description: 'PAMPERS 5', lineTotal: -900 }] }),
        ctx({ rules: [itemRule] }),
      )
      expect(result.category).toBe('DECA')
      expect(result.source).toBe('items')
    })

    // MERGE NOTE — only e2 thought of the mixed basket. Kept: 04 §3 offers a
    // SPLIT when the line items disagree, and `CategorizeResult` carries one
    // category, so the one thing the item rung must not do is pick a side. It
    // abstains and the ladder continues.
    it('does not pick a side when the line items disagree, and lets the model decide instead', () => {
      const result = categorize(
        input({ items: [NAPPIES, MILK] }),
        ctx({
          rules: [itemRule, foodItemRule],
          modelProposal: { category: 'HRANA', confidence: 'high' },
        }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('model')
    })

    it('sends a mixed basket to the review queue when nothing below the item rung can decide', () => {
      const result = categorize(
        input({ items: [NAPPIES, MILK] }),
        ctx({ rules: [itemRule, foodItemRule] }),
      )
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })
  })

  describe('rung 2 — rule selection', () => {
    it('does not apply a rule whose pattern does not match the description', () => {
      const result = categorize(
        input({ description: 'LIDL BEOGRAD', counterparty: 'LIDL' }),
        ctx({ rules: [vendorRule] }),
      )
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    it('does not apply a rule whose amount band excludes this amount', () => {
      const result = categorize(
        input({ amount: -9000 }),
        ctx({
          rules: [rule({ pattern: 'MAXI', amountMin: 100, amountMax: 900, category: 'HRANA' })],
          modelProposal: { category: 'ZABAVA', confidence: 'high' },
        }),
      )
      expect(result.category).toBe('ZABAVA')
      expect(result.source).toBe('model')
    })

    it('applies the highest-priority rule when two rules both match and disagree', () => {
      const result = categorize(
        input(),
        ctx({
          rules: [
            rule({ id: 'r-low', pattern: 'MAXI', category: 'ZABAVA', priority: 10 }),
            rule({ id: 'r-high', pattern: 'MAXI', category: 'HRANA', priority: 900 }),
          ],
        }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
    })

    it('falls through an empty rule set', () => {
      const result = categorize(
        input(),
        ctx({ rules: [], modelProposal: { category: 'HRANA', confidence: 'high' } }),
      )
      expect(result.source).toBe('model')
    })

    it('applies a rule matched on the description when the counterparty is unknown', () => {
      const result = categorize(
        input({ description: 'WOLT DOSTAVA 12.08.2026', counterparty: null }),
        ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
      expect(result.ambiguousVendor).toBe(false)
    })
  })

  describe('the ambiguous-vendor meta-rule (00 D16)', () => {
    it('does not apply a matching rule when the vendor is ambiguous', () => {
      const result = categorize(input(), ctx({ rules: [vendorRule], history: ambiguousHistory }))
      expect(result).toMatchObject({
        category: 'MISC',
        source: 'misc',
        confidence: 'low',
        ambiguousVendor: true,
      })
    })

    it('applies the same rule when the vendor has only ever resolved one way', () => {
      const result = categorize(input(), ctx({ rules: [vendorRule], history: unambiguousHistory }))
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
      expect(result.ambiguousVendor).toBe(false)
    })

    it('still lets the line items decide for an ambiguous vendor', () => {
      const result = categorize(
        input({ items: [NAPPIES] }),
        ctx({ rules: [vendorRule, itemRule], history: ambiguousHistory }),
      )
      expect(result.category).toBe('DECA')
      expect(result.source).toBe('items')
      expect(result.ambiguousVendor).toBe(true)
    })

    it('falls through to the model when the rule was skipped and there are no line items', () => {
      const result = categorize(
        input(),
        ctx({
          rules: [vendorRule],
          history: ambiguousHistory,
          modelProposal: { category: 'ODECA', confidence: 'high' },
        }),
      )
      expect(result.category).toBe('ODECA')
      expect(result.source).toBe('model')
      expect(result.ambiguousVendor).toBe(true)
    })

    // MERGE NOTE — only e1 asserted the flag here; see MERGE RULING 4.
    it('reports the vendor as ambiguous even when a stated category made the rule moot', () => {
      const result = categorize(
        input({ stated: 'ODECA' }),
        ctx({ rules: [vendorRule], history: ambiguousHistory }),
      )
      expect(result.category).toBe('ODECA')
      expect(result.source).toBe('stated')
      expect(result.ambiguousVendor).toBe(true)
    })

    it('recognises the ambiguous vendor through a case and whitespace variant of its name', () => {
      const result = categorize(
        input({ counterparty: '  maxi ' }),
        ctx({
          rules: [vendorRule],
          history: [
            tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
            tx({ id: 'h2', counterparty: 'Maxi ', category: 'DECA' }),
          ],
        }),
      )
      expect(result.source).toBe('misc')
      expect(result.ambiguousVendor).toBe(true)
    })

    it.each([
      ['null', null],
      ['an empty string', ''],
    ] as const)('applies rules normally when the counterparty is %s, since no vendor can be ambiguous', (_label, counterparty) => {
      const result = categorize(
        input({ counterparty }),
        ctx({ rules: [vendorRule], history: ambiguousHistory }),
      )
      expect(result.category).toBe('HRANA')
      expect(result.source).toBe('rule')
      expect(result.ambiguousVendor).toBe(false)
    })

    it('applies rules normally against an empty history', () => {
      const result = categorize(input(), ctx({ rules: [vendorRule], history: [] }))
      expect(result.source).toBe('rule')
      expect(result.ambiguousVendor).toBe(false)
    })

    it('is not confused by a different vendor being ambiguous', () => {
      const result = categorize(
        input({ description: 'EPS SNABDEVANJE RACUN 08/2026', counterparty: 'EPS SNABDEVANJE' }),
        ctx({
          rules: [rule({ pattern: 'EPS SNABDEVANJE', category: 'STAN' })],
          history: [...ambiguousHistory, tx({ id: 'h3', counterparty: 'EPS SNABDEVANJE', category: 'STAN' })],
        }),
      )
      expect(result.category).toBe('STAN')
      expect(result.source).toBe('rule')
      expect(result.ambiguousVendor).toBe(false)
    })
  })

  describe('rung 3 — the model proposes, the code decides (01 §5)', () => {
    it.each([
      ['high', 'model', 'TRANSPORT'],
      ['medium', 'misc', 'MISC'],
      ['low', 'misc', 'MISC'],
    ] as const)(
      'resolves a %s-confidence proposal to %s / %s, because only high confidence is believed',
      (confidence, expectedSource, expectedCategory) => {
        const result = categorize(
          cryptic(),
          ctx({ modelProposal: { category: 'TRANSPORT', confidence } }),
        )
        expect(result.source).toBe(expectedSource)
        expect(result.category).toBe(expectedCategory)
      },
    )

    it('reports low confidence for the MISC it returns after discarding a below-threshold proposal', () => {
      const result = categorize(cryptic(), ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'medium' } }))
      expect(result.category).toBe('MISC')
      expect(result.confidence).toBe('low')
    })

    it('discards a confident proposal for a category outside the allowed list', () => {
      const result = categorize(cryptic(), ctx({ modelProposal: { category: 'KUCNI_LJUBIMCI', confidence: 'high' } }))
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    // MERGE NOTE — e2 discarded a case-only match, e3 accepted and normalized it.
    // Resolved to DISCARD per 01 §5 ("if the JSON doesn't validate, it's a
    // failure, not an interpretation") and, the drafts being 1-1, toward the
    // safer of the two.
    it('discards a proposal that matches an allowed category only up to case', () => {
      const result = categorize(
        cryptic(),
        ctx({ modelProposal: { category: 'hrana', confidence: 'high' }, allowedCategories: ['HRANA'] }),
      )
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    it('discards a proposal whose category is an empty string', () => {
      const result = categorize(cryptic(), ctx({ modelProposal: { category: '', confidence: 'high' } }))
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    it('discards every proposal when the allowed category list is empty', () => {
      const result = categorize(
        cryptic(),
        ctx({ allowedCategories: [], modelProposal: { category: 'TRANSPORT', confidence: 'high' } }),
      )
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    it('falls to MISC when the model proposal is null', () => {
      expect(categorize(cryptic(), ctx({ modelProposal: null })).source).toBe('misc')
    })

    it('falls to MISC when no model proposal field is present at all', () => {
      const context = ctx()
      delete context.modelProposal
      expect(categorize(cryptic(), context).source).toBe('misc')
    })
  })

  describe('rung 4 — MISC is the floor, and degenerate input never throws', () => {
    it('returns MISC at low confidence when nothing at all is known', () => {
      const result = categorize({ description: '', counterparty: null, amount: 0, items: [] }, ctx())
      expect(result).toEqual({
        category: 'MISC',
        source: 'misc',
        confidence: 'low',
        ambiguousVendor: false,
      })
    })

    // MERGE NOTE — only e1 took a position on a non-numeric amount. Kept, and
    // kept as MISC rather than a throw: MISC is the review queue, which is the
    // safe landing place for input the ladder cannot read.
    it('falls to MISC rather than throwing when the amount is not a number', () => {
      const result = categorize(
        input({ description: 'POS 4738 BEOGRAD', counterparty: null, amount: Number.NaN }),
        ctx(),
      )
      expect(result.category).toBe('MISC')
      expect(result.source).toBe('misc')
    })

    it('categorizes an inflow exactly as it categorizes an outflow', () => {
      const result = categorize(
        input({ description: 'PLATA 08/2026', counterparty: 'POSLODAVAC', amount: 180_000 }),
        ctx({ rules: [rule({ pattern: 'PLATA', category: 'PRIHOD' })] }),
      )
      expect(result.category).toBe('PRIHOD')
      expect(result.source).toBe('rule')
    })
  })

  describe('purity and reproducibility (01 §5)', () => {
    it('returns the same result for the same input and context twice', () => {
      const i = input({ items: [NAPPIES] })
      const c = ctx({ rules: [vendorRule, itemRule] })
      expect(categorize(i, c)).toEqual(categorize(i, c))
    })

    it('does not mutate the input, the rules or the history it was given', () => {
      const i = input({ items: [NAPPIES] })
      const rules = [vendorRule, itemRule]
      const history = [...unambiguousHistory]
      const before = JSON.stringify({ i, rules, history })
      categorize(i, ctx({ rules, history }))
      expect(JSON.stringify({ i, rules, history })).toBe(before)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// sortRules — pure ordering: priority, then specificity, then hitCount
// ═══════════════════════════════════════════════════════════════════════════

describe('sortRules', () => {
  it('returns an empty list for no rules', () => {
    expect(sortRules([])).toEqual([])
  })

  it('returns a single rule unchanged', () => {
    expect(sortRules([rule({ id: 'only' })]).map((r) => r.id)).toEqual(['only'])
  })

  it('puts the highest priority first', () => {
    const rules = [
      rule({ id: 'low', priority: 1 }),
      rule({ id: 'high', priority: 900 }),
      rule({ id: 'mid', priority: 100 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks a priority tie by specificity, so more conditions beat fewer', () => {
    const rules = [
      rule({ id: 'vendor-only', priority: 100 }),
      rule({ id: 'vendor-item-band', priority: 100, itemPattern: 'PAMPERS', amountMin: 100, amountMax: 900 }),
      rule({ id: 'vendor-item', priority: 100, itemPattern: 'PAMPERS' }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['vendor-item-band', 'vendor-item', 'vendor-only'])
  })

  it('breaks a priority and specificity tie by hit count, most used first', () => {
    const rules = [
      rule({ id: 'cold', priority: 100, hitCount: 0 }),
      rule({ id: 'hot', priority: 100, hitCount: 23 }),
      rule({ id: 'warm', priority: 100, hitCount: 4 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['hot', 'warm', 'cold'])
  })

  it('prefers specificity over hit count when priorities are equal', () => {
    const rules = [
      rule({ id: 'popular-but-bare', priority: 100, hitCount: 99 }),
      rule({ id: 'specific', priority: 100, hitCount: 0, itemPattern: 'PAMPERS' }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['specific', 'popular-but-bare'])
  })

  it('applies priority before specificity, so a bare high-priority rule outranks a specific low-priority one', () => {
    const rules = [
      rule({ id: 'specific-low', priority: 10, itemPattern: 'PAMPERS', amountMin: 1, amountMax: 2 }),
      rule({ id: 'bare-high', priority: 500 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['bare-high', 'specific-low'])
  })

  it('orders a mixed set by all three keys at once', () => {
    const rules = [
      rule({ id: 'e', priority: 10, hitCount: 5 }),
      rule({ id: 'b', priority: 100, itemPattern: 'X', hitCount: 1 }),
      rule({ id: 'd', priority: 100, hitCount: 0 }),
      rule({ id: 'a', priority: 100, itemPattern: 'X', amountMin: 1, hitCount: 0 }),
      rule({ id: 'c', priority: 100, hitCount: 9 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps every rule, returns a new list, and does not mutate the input', () => {
    const rules = [rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 900 })]
    const sorted = sortRules(rules)
    expect(sorted).toHaveLength(2)
    expect(sorted).not.toBe(rules)
    expect(rules.map((r) => r.id)).toEqual(['low', 'high'])
  })

  it('is stable for rules that tie on every key', () => {
    const rules = [
      rule({ id: 'first', priority: 100, hitCount: 3 }),
      rule({ id: 'second', priority: 100, hitCount: 3 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['first', 'second'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ruleMatches — (vendor + item pattern + amount band), all conjunctive
// ═══════════════════════════════════════════════════════════════════════════

describe('ruleMatches', () => {
  it.each([
    { matchType: 'contains' as const, pattern: 'WOLT', description: 'POS 4738 WOLT BEOGRAD', expected: true },
    { matchType: 'contains' as const, pattern: 'wolt', description: 'WOLT BEOGRAD', expected: true },
    { matchType: 'contains' as const, pattern: 'WOLT', description: 'GLOVO KURIRSKA SLUZBA', expected: false },
    { matchType: 'contains' as const, pattern: 'WOLT BEOGRAD', description: 'WOLT DOSTAVA BEOGRAD', expected: false },
    { matchType: 'exact' as const, pattern: 'WOLT', description: 'WOLT', expected: true },
    { matchType: 'exact' as const, pattern: 'wolt', description: '   WOLT   ', expected: true },
    { matchType: 'exact' as const, pattern: 'WOLT', description: 'WOLT BEOGRAD', expected: false },
    { matchType: 'regex' as const, pattern: '^WOLT', description: 'WOLT DOSTAVA', expected: true },
    { matchType: 'regex' as const, pattern: '^WOLT', description: 'PAY WOLT', expected: false },
    { matchType: 'regex' as const, pattern: 'WOLT|GLOVO', description: 'GLOVO KURIR', expected: true },
    { matchType: 'regex' as const, pattern: '^WOLT$', description: 'WOLT DOSTAVA', expected: false },
  ])('matches a $matchType rule "$pattern" against "$description": $expected', ({ matchType, pattern, description, expected }) => {
    expect(ruleMatches(rule({ matchType, pattern }), matchInput({ description }))).toBe(expected)
  })

  it('matches through the volatile tokens a bank descriptor carries', () => {
    const r = rule({ matchType: 'contains', pattern: 'WOLT' })
    const i = matchInput({ description: 'POS 4738 12.03.2026 WOLT BEOGRAD REF 887766 ****1234' })
    expect(ruleMatches(r, i)).toBe(true)
  })

  it('returns false for a malformed regex rather than throwing', () => {
    const bad = rule({ matchType: 'regex', pattern: 'WOLT([' })
    expect(ruleMatches(bad, matchInput({ description: 'WOLT DOSTAVA' }))).toBe(false)
  })

  it('returns false for an empty pattern rather than matching every description', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: '' }), matchInput())).toBe(false)
  })

  it('returns false when the description is empty', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI' }), matchInput({ description: '' }))).toBe(false)
  })

  it('matches when any one line item matches the item pattern', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, matchInput({ items: ['MLEKO 1L', 'PAMPERS 4 MAXI', 'HLEB'] }))).toBe(true)
  })

  it('matches the item pattern case-insensitively', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'pampers' })
    expect(ruleMatches(r, matchInput({ items: ['PAMPERS 4'] }))).toBe(true)
  })

  it('does not match when no line item matches the item pattern', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, matchInput({ items: ['MLEKO 1L', 'HLEB'] }))).toBe(false)
  })

  it('does not match an item-qualified rule when there are no line items at all', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, matchInput({ items: [] }))).toBe(false)
  })

  it('does not match when the item pattern hits but the vendor pattern does not', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, matchInput({ description: 'LIDL NOVI BEOGRAD', items: ['PAMPERS 4'] }))).toBe(false)
  })

  it('ignores the line items when the rule states no item pattern', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: null }), matchInput({ items: ['ANYTHING'] }))).toBe(true)
  })

  it.each([
    ['exactly at the lower bound', 500, true],
    ['one minor unit inside the lower bound', 500.01, true],
    ['one minor unit below the lower bound', 499.99, false],
    ['inside the band', 1200, true],
    ['exactly at the upper bound', 2000, true],
    ['one minor unit inside the upper bound', 1999.99, true],
    ['one minor unit above the upper bound', 2000.01, false],
  ] as const)('applies an inclusive 500..2000 amount band: %s is %s', (_label, amount, expected) => {
    const banded = rule({ pattern: 'MAXI', amountMin: 500, amountMax: 2000 })
    expect(ruleMatches(banded, matchInput({ amount }))).toBe(expected)
  })

  it('compares the amount band against the magnitude, so a signed outflow still matches', () => {
    const banded = rule({ pattern: 'MAXI', amountMin: 500, amountMax: 2000 })
    expect(ruleMatches(banded, matchInput({ amount: -1500 }))).toBe(true)
    expect(ruleMatches(banded, matchInput({ amount: 1500 }))).toBe(true)
  })

  it.each([
    ['no lower bound, inside', null, 2000, -1, true],
    ['no lower bound, at the upper bound', null, 2000, -2000, true],
    ['no lower bound, above the upper bound', null, 2000, -2000.01, false],
    ['no upper bound, at the lower bound', 1000, null, -1000, true],
    ['no upper bound, below the lower bound', 1000, null, -999.99, false],
    ['no upper bound, far above', 1000, null, -9_999_999, true],
    ['no bounds at all', null, null, -12_345, true],
  ] as const)('treats a half-open band as a single constraint: %s', (_label, amountMin, amountMax, amount, expected) => {
    expect(ruleMatches(rule({ pattern: 'MAXI', amountMin, amountMax }), matchInput({ amount }))).toBe(expected)
  })

  it('applies a zero-to-zero band only to a zero amount', () => {
    const zero = rule({ pattern: 'MAXI', amountMin: 0, amountMax: 0 })
    expect(ruleMatches(zero, matchInput({ amount: 0 }))).toBe(true)
    expect(ruleMatches(zero, matchInput({ amount: -1 }))).toBe(false)
  })

  it('treats absent band fields as no constraint at all', () => {
    const unbanded = rule({ pattern: 'MAXI' })
    delete unbanded.amountMin
    delete unbanded.amountMax
    expect(ruleMatches(unbanded, matchInput({ amount: 88 }))).toBe(true)
  })

  it('requires every stated condition at once: vendor and item hit but the amount misses', () => {
    const all = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 500, amountMax: 2000 })
    expect(ruleMatches(all, matchInput({ items: ['PAMPERS 4'], amount: -4000 }))).toBe(false)
  })

  it('matches when vendor, item and amount all hit', () => {
    const all = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 500, amountMax: 2000 })
    const i = matchInput({ description: 'MAXI BEOGRAD 12.03.2026', items: ['MLEKO', 'PAMPERS 4'], amount: -800 })
    expect(ruleMatches(all, i)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// deriveRule — the learning loop (04 §3), and its refusals
// ═══════════════════════════════════════════════════════════════════════════

describe('deriveRule', () => {
  it('derives a reusable rule from one correction, carrying the values it was given', () => {
    const derived = deriveRule('WOLT DOSTAVA 12.08.2026', 'HRANA', BOOK, ID, AT)
    expect(derived).not.toBeNull()
    expect(derived).toMatchObject({ id: ID, book: BOOK, category: 'HRANA', createdAt: AT, hitCount: 0 })
  })

  it('takes its id from the caller, so the derivation itself generates nothing', () => {
    const ids = countingIdGen()
    const first = deriveRule('WOLT DOSTAVA 12.08.2026', 'HRANA', BOOK, ids.next(), AT)
    const second = deriveRule('GLOVO KURIR 12.08.2026', 'HRANA', BOOK, ids.next(), AT)
    expect(ids.calls).toBe(2)
    expect(first!.id).toBe('rule-1')
    expect(second!.id).toBe('rule-2')
  })

  it('derives a contains rule rather than an exact one, so it survives descriptor noise', () => {
    expect(deriveRule('POS 4738 WOLT BEOGRAD', 'HRANA', BOOK, ID, AT)!.matchType).toBe('contains')
  })

  // MERGE NOTE — e1 asserted the derived pattern is upper-cased; e2 and e3 both
  // compared case-insensitively. Followed the majority: matching is already
  // case-insensitive, so the pattern's own casing is not a contract.
  it.each([
    ['a clean merchant name', 'WOLT', 'WOLT'],
    ['surrounding whitespace', '  WOLT  ', 'WOLT'],
    ['a lower-case description', 'wolt 12.08.2026', 'WOLT'],
    ['a date', 'WOLT 12.03.2026', 'WOLT'],
    ['an ISO date', 'WOLT 2026-08-05', 'WOLT'],
    ['a time', 'WOLT 14:22:07', 'WOLT'],
    ['a terminal id', 'POS 4738 WOLT', 'WOLT'],
    ['a reference number', 'WOLT REF 998877221', 'WOLT'],
    ['a masked card suffix', 'WOLT *1234', 'WOLT'],
  ] as const)('strips %s and keeps the stable merchant token', (_label, description, expected) => {
    const derived = deriveRule(description, 'HRANA', BOOK, ID, AT)
    expect(derived).not.toBeNull()
    expect(derived!.pattern.toUpperCase()).toContain(expected)
  })

  it('leaves no volatile token behind in the pattern at all', () => {
    const derived = deriveRule('POS 4738 WOLT BEOGRAD 12.03.2026 REF 887766 ****1234', 'HRANA', BOOK, ID, AT)!
    expect(derived.pattern.toUpperCase()).toContain('WOLT')
    expect(derived.pattern).not.toMatch(/\d/)
    expect(derived.pattern).not.toContain('*')
  })

  // MERGE NOTE — e1 required the pattern to equal 'EPS SNABDEVANJE' exactly,
  // which also demands stripping the stable word 'RACUN'. e2 and e3 only require
  // the merchant's words to survive; followed the majority, since a stopword list
  // is nowhere in the spec.
  it('keeps a multi-word merchant name intact', () => {
    const derived = deriveRule('EPS SNABDEVANJE RACUN 08/2026 REF 4471', 'STAN', BOOK, ID, AT)!
    expect(derived.pattern.toUpperCase()).toContain('EPS')
    expect(derived.pattern.toUpperCase()).toContain('SNABDEVANJE')
  })

  it('derives the same pattern from two visits that differ only in volatile tokens', () => {
    const july = deriveRule('POS 4738 WOLT BEOGRAD 03.07.2026 REF 111111', 'HRANA', BOOK, 'rule-1', AT)
    const august = deriveRule('POS 9911 WOLT BEOGRAD 12.08.2026 REF 998877', 'HRANA', BOOK, 'rule-2', AT)
    expect(july).not.toBeNull()
    expect(august).not.toBeNull()
    expect(july!.pattern).toBe(august!.pattern)
  })

  it('produces a rule that matches the description it was derived from', () => {
    const description = 'POS 4738 WOLT BEOGRAD 12.03.2026'
    const derived = deriveRule(description, 'HRANA', BOOK, ID, AT)!
    expect(ruleMatches(derived, matchInput({ description }))).toBe(true)
  })

  it('produces a rule that matches the next charge from the same merchant', () => {
    const derived = deriveRule('WOLT DOSTAVA *1234 05.08.2026', 'HRANA', BOOK, ID, AT)!
    expect(ruleMatches(derived, matchInput({ description: 'WOLT DOSTAVA *9987 11.09.2026' }))).toBe(true)
  })

  it('produces a rule that does not match a different merchant', () => {
    const derived = deriveRule('WOLT DOSTAVA *1234 05.08.2026', 'HRANA', BOOK, ID, AT)!
    expect(ruleMatches(derived, matchInput({ description: 'GLOVO KURIR *9987 11.09.2026' }))).toBe(false)
  })

  it('does not lock an amount band or an item condition in from a single example', () => {
    const derived = deriveRule('WOLT DOSTAVA 12.08.2026', 'HRANA', BOOK, ID, AT)!
    expect(derived.itemPattern ?? null).toBeNull()
    expect(derived.amountMin ?? null).toBeNull()
    expect(derived.amountMax ?? null).toBeNull()
    expect(typeof derived.priority).toBe('number')
  })

  it.each([
    ['it is empty', ''],
    ['it is whitespace only', '   '],
    ['it is only a date', '12.08.2026'],
    ['it is only a terminal id', 'POS 4738'],
    ['it is only a reference number', 'REF 99213847'],
    ['it is only reference digits', 'REF 998877 4738 1234'],
    ['it is only a masked card number', '****1234'],
    ['it is only punctuation', '*** -- //'],
    ['only a single character survives stripping', 'A 12.08.2026'],
  ] as const)('returns null when %s, rather than writing an unsafe rule', (_label, description) => {
    expect(deriveRule(description, 'HRANA', BOOK, ID, AT)).toBeNull()
  })

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ] as const)('returns null when the category is %s, rather than learning a rule to nowhere', (_label, category) => {
    expect(deriveRule('WOLT DOSTAVA 12.08.2026', category, BOOK, ID, AT)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// vendorIsAmbiguous — the deterministic meta-rule (04 §3, 01 §5.1, 00 D16)
// ═══════════════════════════════════════════════════════════════════════════

describe('vendorIsAmbiguous', () => {
  it.each([
    { label: 'the vendor never appears in history', categories: [] as string[], expected: false },
    { label: 'one category, seen once', categories: ['HRANA'], expected: false },
    { label: 'one category, seen four times', categories: ['HRANA', 'HRANA', 'HRANA', 'HRANA'], expected: false },
    { label: 'two categories', categories: ['HRANA', 'DECA'], expected: true },
    { label: 'three categories', categories: ['HRANA', 'DECA', 'ZABAVA'], expected: true },
  ])('is $expected when $label', ({ categories, expected }) => {
    const history = [
      tx({ id: 'other', counterparty: 'LIDL', category: 'HRANA' }),
      ...categories.map((category, n) => tx({ id: `h${n}`, counterparty: 'MAXI', category })),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(expected)
  })

  it('is false when the history is empty', () => {
    expect(vendorIsAmbiguous('MAXI', [])).toBe(false)
  })

  it('treats case variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'maxi', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('Maxi', history)).toBe(true)
  })

  it('treats whitespace variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 'h1', counterparty: '  MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI  ', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('collapses case and whitespace variants into one category rather than several', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: ' maxi ', category: 'HRANA' }),
      tx({ id: 'h3', counterparty: 'Maxi', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('matches the queried vendor case- and whitespace-insensitively as well', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('  maxi  ', history)).toBe(true)
  })

  it.each([
    ['an empty vendor name', ''],
    ['a whitespace-only vendor name', '   '],
  ] as const)('is false for %s rather than matching every vendor', (_label, vendor) => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'LIDL', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous(vendor, history)).toBe(false)
  })

  it('ignores history rows whose counterparty is null', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: null, category: 'DECA' }),
      tx({ id: 'h3', counterparty: null, category: 'ODECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('does not let another vendor s split history make this vendor ambiguous', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'h3', counterparty: 'MAXI', category: 'ODECA' }),
    ]
    expect(vendorIsAmbiguous('WOLT', history)).toBe(false)
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('identifies the vendor by counterparty and not by the description text', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'LIDL', description: 'POS MAXI BEOGRAD', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('does not count MISC as a resolution, so one real category plus MISC is unambiguous', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('is false for a vendor whose only history rows are unresolved MISC', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'MISC' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('is true when two real categories exist alongside MISC rows', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'MISC' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h3', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('is unaffected by the order the categories appear in history', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// vendorCategories — the same evidence, itemized
// ═══════════════════════════════════════════════════════════════════════════

describe('vendorCategories', () => {
  it('lists the categories a vendor has been filed under, most frequent first', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h3', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h4', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h5', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'h6', counterparty: 'MAXI', category: 'ODECA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([
      { category: 'HRANA', count: 3 },
      { category: 'DECA', count: 2 },
      { category: 'ODECA', count: 1 },
    ])
  })

  it('returns the single category with its count for an unambiguous vendor', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'h2', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'h3', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    expect(vendorCategories('EPS SNABDEVANJE', history)).toEqual([{ category: 'STAN', count: 2 }])
  })

  it('returns an empty list when the history is empty', () => {
    expect(vendorCategories('MAXI', [])).toEqual([])
  })

  it('returns an empty list for a vendor that never appears', () => {
    expect(vendorCategories('MAXI', [tx({ counterparty: 'LIDL', category: 'HRANA' })])).toEqual([])
  })

  it('returns an empty list for an empty vendor name', () => {
    expect(vendorCategories('', [tx({ counterparty: 'MAXI', category: 'HRANA' })])).toEqual([])
  })

  it('folds case and whitespace variants of the vendor into one count', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: ' maxi ', category: 'HRANA' }),
      tx({ id: 'h3', counterparty: 'Maxi', category: 'HRANA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 3 }])
  })

  it('omits unresolved MISC rows, which record that nothing was decided', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'MISC' }),
      tx({ id: 'h3', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 1 }])
  })

  it('agrees with vendorIsAmbiguous: more than one listed category means ambiguous', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorCategories('MAXI', history)).toHaveLength(2)
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('does not mutate the history it was given', () => {
    const history = [
      tx({ id: 'h1', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    const before = JSON.stringify(history)
    vendorCategories('MAXI', history)
    expect(JSON.stringify(history)).toBe(before)
  })
})
