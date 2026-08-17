import { describe, it, expect } from 'vitest'

import {
  categorize,
  type CategorizeInput,
  type CategorizeContext,
} from '../../../src/engine/ledger/categorize.js'
import {
  sortRules,
  ruleMatches,
  deriveRule,
  type CategorizationRule,
} from '../../../src/engine/ledger/rules.js'
import {
  vendorIsAmbiguous,
  vendorCategories,
} from '../../../src/engine/ledger/ambiguous-vendor.js'
import type { Transaction } from '../../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures. No mocking library: every dependency here is a plain literal.
// ─────────────────────────────────────────────────────────────────────────────

/** The PERSONAL v1 category set (04-PERSONAL §3). */
const ALLOWED = [
  'STAN', 'HRANA', 'TRANSPORT', 'ZDRAVLJE', 'DECA', 'ZABAVA',
  'ODECA', 'TEHNIKA', 'PUTOVANJA', 'FINANSIJE', 'PRIHOD', 'POREZI', 'MISC',
]

const AT = '2026-08-12T09:00:00.000Z'

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: over.id ?? 'tx-1',
    book: 'PERSONAL',
    txDate: '2026-07-01',
    valueDate: null,
    description: 'MAXI BEOGRAD',
    counterparty: 'MAXI',
    amount: -1000,
    currency: 'RSD',
    amountRsd: -1000,
    direction: 'out',
    category: 'HRANA',
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: 'k-1',
    reviewStatus: 'ok',
    createdAt: AT,
    ...over,
  }
}

function rule(over: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: 'r-1',
    book: 'PERSONAL',
    matchType: 'contains',
    pattern: 'MAXI',
    itemPattern: null,
    amountMin: null,
    amountMax: null,
    category: 'HRANA',
    priority: 100,
    hitCount: 0,
    createdAt: AT,
    ...over,
  }
}

function input(over: Partial<CategorizeInput> = {}): CategorizeInput {
  return {
    description: 'MAXI BEOGRAD',
    counterparty: 'MAXI',
    amount: -1000,
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

/** A vendor-only rule: the classic `WOLT -> HRANA` backbone rule. */
const vendorRule = rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' })

/** A rule carrying an item pattern: this is the line-item rung, not the vendor rung. */
const itemRule = rule({
  id: 'r-item',
  pattern: 'MAXI',
  itemPattern: 'PAMPERS',
  category: 'DECA',
  priority: 50, // deliberately LOWER priority than the vendor rule: the rung wins, not the priority
})

// ─────────────────────────────────────────────────────────────────────────────
// vendorIsAmbiguous — the deterministic meta-rule (04 §3, 01 §5.1, 00 D16)
// ─────────────────────────────────────────────────────────────────────────────

describe('vendorIsAmbiguous', () => {
  it('returns false for a vendor that has only ever resolved to one category', () => {
    const history = [
      tx({ id: 'a', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'b', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'c', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
    ]
    expect(vendorIsAmbiguous('EPS SNABDEVANJE', history)).toBe(false)
  })

  it('returns true the moment a vendor has resolved to exactly two categories', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('returns true for a vendor with three or more categories', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'c', counterparty: 'MAXI', category: 'ZABAVA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('returns false for an empty history', () => {
    expect(vendorIsAmbiguous('MAXI', [])).toBe(false)
  })

  it('returns false for a vendor that does not appear in history at all', () => {
    const history = [tx({ counterparty: 'LIDL', category: 'HRANA' })]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('returns false for an empty vendor name', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('', history)).toBe(false)
  })

  it('treats case variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'maxi', category: 'HRANA' }),
      tx({ id: 'c', counterparty: 'Maxi', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('treats whitespace variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 'a', counterparty: '  MAXI  ', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'c', counterparty: 'MAXI   DELTA', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('reports ambiguity when case and whitespace variants of one vendor disagree on category', () => {
    const history = [
      tx({ id: 'a', counterparty: ' maxi ', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('matches the queried vendor case-insensitively as well', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('  maxi  ', history)).toBe(true)
  })

  it('does not count MISC as a resolution, so one real category plus MISC is unambiguous', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('returns false for a vendor whose only history rows are unresolved MISC', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'MISC' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('ignores history rows with a null counterparty', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: null, category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('identifies the vendor by counterparty and not by the description text', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      // description mentions MAXI but the money went to a different counterparty
      tx({ id: 'b', counterparty: 'LIDL', description: 'POS MAXI BEOGRAD', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('ignores other vendors entirely when deciding ambiguity', () => {
    const history = [
      tx({ id: 'a', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'c', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 'd', counterparty: 'WOLT', category: 'ZABAVA' }),
    ]
    expect(vendorIsAmbiguous('EPS SNABDEVANJE', history)).toBe(false)
    expect(vendorIsAmbiguous('WOLT', history)).toBe(true)
  })

  it('is unaffected by the order the categories appear in history', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// vendorCategories
// ─────────────────────────────────────────────────────────────────────────────

describe('vendorCategories', () => {
  it('lists the categories a vendor has been assigned, most frequent first', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'c', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'd', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'e', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'f', counterparty: 'MAXI', category: 'ZABAVA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([
      { category: 'HRANA', count: 3 },
      { category: 'DECA', count: 2 },
      { category: 'ZABAVA', count: 1 },
    ])
  })

  it('returns an empty list for an empty history', () => {
    expect(vendorCategories('MAXI', [])).toEqual([])
  })

  it('returns an empty list for a vendor that never appears', () => {
    expect(vendorCategories('MAXI', [tx({ counterparty: 'LIDL' })])).toEqual([])
  })

  it('returns a single entry with its count for an unambiguous vendor', () => {
    const history = [
      tx({ id: 'a', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 'b', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
    ]
    expect(vendorCategories('EPS SNABDEVANJE', history)).toEqual([{ category: 'STAN', count: 2 }])
  })

  it('folds case and whitespace variants of the vendor into one count', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: ' maxi ', category: 'HRANA' }),
      tx({ id: 'c', counterparty: 'Maxi', category: 'HRANA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 3 }])
  })

  it('omits unresolved MISC rows, which are not category resolutions', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'MISC' }),
      tx({ id: 'c', counterparty: 'MAXI', category: 'MISC' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 1 }])
  })

  it('agrees with vendorIsAmbiguous: more than one listed category means ambiguous', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorCategories('MAXI', history)).toHaveLength(2)
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('does not mutate the history it was given', () => {
    const history = [
      tx({ id: 'a', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 'b', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    const before = JSON.parse(JSON.stringify(history))
    vendorCategories('MAXI', history)
    expect(history).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sortRules — pure ordering: priority, then specificity, then hitCount
// ─────────────────────────────────────────────────────────────────────────────

describe('sortRules', () => {
  it('returns an empty array unchanged', () => {
    expect(sortRules([])).toEqual([])
  })

  it('returns a single rule unchanged', () => {
    const only = rule({ id: 'only' })
    expect(sortRules([only]).map((r) => r.id)).toEqual(['only'])
  })

  it('puts the highest priority first', () => {
    const rules = [
      rule({ id: 'low', priority: 1 }),
      rule({ id: 'high', priority: 900 }),
      rule({ id: 'mid', priority: 100 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks a priority tie by specificity: more conditions beat fewer', () => {
    const rules = [
      rule({ id: 'vendor-only', priority: 100 }),
      rule({ id: 'vendor-item-band', priority: 100, itemPattern: 'PAMPERS', amountMin: 100, amountMax: 900 }),
      rule({ id: 'vendor-item', priority: 100, itemPattern: 'PAMPERS' }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['vendor-item-band', 'vendor-item', 'vendor-only'])
  })

  it('breaks a specificity tie by hitCount, most-used first', () => {
    const rules = [
      rule({ id: 'cold', priority: 100, hitCount: 0 }),
      rule({ id: 'hot', priority: 100, hitCount: 23 }),
      rule({ id: 'warm', priority: 100, hitCount: 4 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['hot', 'warm', 'cold'])
  })

  it('applies priority before specificity: a bare high-priority rule outranks a specific low-priority one', () => {
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

  it('does not mutate the array it was given', () => {
    const rules = [rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 900 })]
    const sorted = sortRules(rules)
    expect(rules.map((r) => r.id)).toEqual(['low', 'high'])
    expect(sorted).not.toBe(rules)
  })

  it('is stable for rules that tie on every key', () => {
    const rules = [
      rule({ id: 'first', priority: 100, hitCount: 3 }),
      rule({ id: 'second', priority: 100, hitCount: 3 }),
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['first', 'second'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ruleMatches — every condition is conjunctive; bands are inclusive at both ends
// ─────────────────────────────────────────────────────────────────────────────

describe('ruleMatches', () => {
  it('matches a contains rule against a substring of the description', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'WOLT' }), {
      description: 'POS 4738 WOLT BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(true)
  })

  it('matches a contains rule case-insensitively', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'wolt' }), {
      description: 'WOLT BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(true)
  })

  it('does not match a contains rule whose pattern is absent from the description', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'WOLT' }), {
      description: 'MAXI BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('matches through the volatile tokens a bank descriptor carries', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'WOLT' }), {
      description: 'POS 4738 12.03.2026 WOLT BEOGRAD REF 887766 ****1234',
      items: [],
      amount: -1200,
    })).toBe(true)
  })

  it('matches an exact rule only against the whole normalized description', () => {
    expect(ruleMatches(rule({ matchType: 'exact', pattern: 'WOLT' }), {
      description: 'WOLT',
      items: [],
      amount: -1200,
    })).toBe(true)
  })

  it('does not match an exact rule against a description that merely contains the pattern', () => {
    expect(ruleMatches(rule({ matchType: 'exact', pattern: 'WOLT' }), {
      description: 'WOLT BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('matches a regex rule', () => {
    expect(ruleMatches(rule({ matchType: 'regex', pattern: '^POS \\d{4} WOLT' }), {
      description: 'POS 4738 WOLT BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(true)
  })

  it('does not match a regex rule that fails', () => {
    expect(ruleMatches(rule({ matchType: 'regex', pattern: '^WOLT$' }), {
      description: 'POS 4738 WOLT',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('returns false rather than throwing when the regex pattern is malformed', () => {
    expect(ruleMatches(rule({ matchType: 'regex', pattern: '([unclosed' }), {
      description: 'ANYTHING AT ALL',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('returns false when the description is empty', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: 'WOLT' }), {
      description: '',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('returns false when the rule pattern is empty rather than matching everything', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: '' }), {
      description: 'MAXI BEOGRAD',
      items: [],
      amount: -1200,
    })).toBe(false)
  })

  it('matches when any one line item matches the item pattern', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' }), {
      description: 'MAXI BEOGRAD',
      items: ['MLEKO 1L', 'PAMPERS 4 MAXI', 'HLEB'],
      amount: -3400,
    })).toBe(true)
  })

  it('matches the item pattern case-insensitively', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: 'pampers' }), {
      description: 'MAXI BEOGRAD',
      items: ['PAMPERS 4'],
      amount: -3400,
    })).toBe(true)
  })

  it('does not match when no line item matches the item pattern', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' }), {
      description: 'MAXI BEOGRAD',
      items: ['MLEKO 1L', 'HLEB'],
      amount: -3400,
    })).toBe(false)
  })

  it('does not match a rule requiring an item pattern when there are no line items', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' }), {
      description: 'MAXI BEOGRAD',
      items: [],
      amount: -3400,
    })).toBe(false)
  })

  it('ignores line items when the rule states no item pattern', () => {
    expect(ruleMatches(rule({ pattern: 'MAXI', itemPattern: null }), {
      description: 'MAXI BEOGRAD',
      items: ['ANYTHING'],
      amount: -3400,
    })).toBe(true)
  })

  it.each([
    ['exactly at the lower bound', -500, true],
    ['exactly at the upper bound', -1500, true],
    ['one minor unit inside the lower bound', -501, true],
    ['one minor unit inside the upper bound', -1499, true],
    ['one minor unit below the lower bound', -499, false],
    ['one minor unit above the upper bound', -1501, false],
  ] as const)('with an inclusive 500..1500 amount band: %s -> %s', (_name, amount, expected) => {
    const banded = rule({ pattern: 'MAXI', amountMin: 500, amountMax: 1500 })
    expect(ruleMatches(banded, { description: 'MAXI BEOGRAD', items: [], amount })).toBe(expected)
  })

  it('compares the amount band against the magnitude, so a signed outflow still matches', () => {
    const banded = rule({ pattern: 'MAXI', amountMin: 500, amountMax: 1500 })
    expect(ruleMatches(banded, { description: 'MAXI', items: [], amount: -800 })).toBe(true)
    expect(ruleMatches(banded, { description: 'MAXI', items: [], amount: 800 })).toBe(true)
  })

  it('leaves the band open below when only amountMax is stated', () => {
    const capped = rule({ pattern: 'MAXI', amountMin: null, amountMax: 1000 })
    expect(ruleMatches(capped, { description: 'MAXI', items: [], amount: -1 })).toBe(true)
    expect(ruleMatches(capped, { description: 'MAXI', items: [], amount: -1000 })).toBe(true)
    expect(ruleMatches(capped, { description: 'MAXI', items: [], amount: -1001 })).toBe(false)
  })

  it('leaves the band open above when only amountMin is stated', () => {
    const floored = rule({ pattern: 'MAXI', amountMin: 1000, amountMax: null })
    expect(ruleMatches(floored, { description: 'MAXI', items: [], amount: -1000 })).toBe(true)
    expect(ruleMatches(floored, { description: 'MAXI', items: [], amount: -999 })).toBe(false)
    expect(ruleMatches(floored, { description: 'MAXI', items: [], amount: -9_999_999 })).toBe(true)
  })

  it('applies an amount band of zero to zero only to a zero amount', () => {
    const zero = rule({ pattern: 'MAXI', amountMin: 0, amountMax: 0 })
    expect(ruleMatches(zero, { description: 'MAXI', items: [], amount: 0 })).toBe(true)
    expect(ruleMatches(zero, { description: 'MAXI', items: [], amount: -1 })).toBe(false)
  })

  it('requires every stated condition at once: vendor and item hit but the amount misses', () => {
    const all = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 500, amountMax: 1500 })
    expect(ruleMatches(all, {
      description: 'MAXI BEOGRAD',
      items: ['PAMPERS 4'],
      amount: -4000,
    })).toBe(false)
  })

  it('requires every stated condition at once: item and amount hit but the vendor misses', () => {
    const all = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 500, amountMax: 1500 })
    expect(ruleMatches(all, {
      description: 'LIDL BEOGRAD',
      items: ['PAMPERS 4'],
      amount: -800,
    })).toBe(false)
  })

  it('matches when vendor, item and amount all hit', () => {
    const all = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 500, amountMax: 1500 })
    expect(ruleMatches(all, {
      description: 'POS 4738 MAXI BEOGRAD 12.03.2026',
      items: ['MLEKO', 'PAMPERS 4'],
      amount: -800,
    })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveRule — the learning loop; refuses rather than writes an unsafe rule
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveRule', () => {
  it('derives a reusable rule from a clean merchant description', () => {
    const derived = deriveRule('WOLT', 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived).not.toBeNull()
    expect(derived!.pattern.toUpperCase()).toBe('WOLT')
  })

  it('carries the category, book, id and timestamp through verbatim', () => {
    const derived = deriveRule('WOLT BEOGRAD', 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived).not.toBeNull()
    expect(derived!.category).toBe('HRANA')
    expect(derived!.book).toBe('PERSONAL')
    expect(derived!.id).toBe('r-new')
    expect(derived!.createdAt).toBe(AT)
  })

  it('starts a freshly derived rule at zero hits', () => {
    const derived = deriveRule('WOLT', 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived!.hitCount).toBe(0)
  })

  it('derives a substring rule rather than an exact one, so it survives descriptor noise', () => {
    const derived = deriveRule('POS 4738 WOLT BEOGRAD', 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived!.matchType).toBe('contains')
  })

  it('strips the transaction date from the derived pattern', () => {
    const derived = deriveRule('WOLT 12.03.2026', 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived!.pattern.toUpperCase()).toContain('WOLT')
    expect(derived!.pattern).not.toContain('12.03.2026')
  })

  it('strips the terminal id, reference number and card suffix from the derived pattern', () => {
    const derived = deriveRule(
      'POS 4738 WOLT BEOGRAD REF 887766 ****1234',
      'HRANA', 'PERSONAL', 'r-new', AT,
    )
    expect(derived!.pattern.toUpperCase()).toContain('WOLT')
    expect(derived!.pattern).not.toMatch(/\d/)
    expect(derived!.pattern).not.toContain('*')
  })

  it('derives the same pattern from two descriptions that differ only in volatile tokens', () => {
    const a = deriveRule('POS 4738 WOLT BEOGRAD 12.03.2026 REF 887766', 'HRANA', 'PERSONAL', 'r-a', AT)
    const b = deriveRule('POS 9911 WOLT BEOGRAD 04.04.2026 REF 112233', 'HRANA', 'PERSONAL', 'r-b', AT)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.pattern).toBe(b!.pattern)
  })

  it('produces a rule that matches the description it was derived from', () => {
    const description = 'POS 4738 WOLT BEOGRAD 12.03.2026'
    const derived = deriveRule(description, 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(ruleMatches(derived!, { description, items: [], amount: -1200 })).toBe(true)
  })

  it('returns null when every token in the description is volatile', () => {
    expect(deriveRule('POS 4738 12.03.2026 REF 887766', 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })

  it('returns null when only digits remain', () => {
    expect(deriveRule('4738 887766', 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })

  it('returns null when only a masked card number remains', () => {
    expect(deriveRule('****1234', 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })

  it('returns null when only punctuation remains', () => {
    expect(deriveRule('--- / ---', 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })

  it('returns null when the only surviving token is too short to be a safe pattern', () => {
    expect(deriveRule('X 12.03.2026 REF 887766', 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })

  it.each([
    ['WOLT', 'WOLT'],
    ['  WOLT  ', 'WOLT'],
    ['WOLT 12.03.2026', 'WOLT'],
    ['POS 4738 WOLT', 'WOLT'],
    ['WOLT ****1234', 'WOLT'],
    ['WOLT REF 887766', 'WOLT'],
  ] as const)('derives %s -> pattern containing %s', (description, expected) => {
    const derived = deriveRule(description, 'HRANA', 'PERSONAL', 'r-new', AT)
    expect(derived).not.toBeNull()
    expect(derived!.pattern.toUpperCase()).toContain(expected)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '  '],
    ['terminal id only', 'POS 4738'],
    ['date only', '12.03.2026'],
    ['reference only', 'REF 887766'],
    ['card suffix only', '****1234'],
  ] as const)('returns null for a description that is %s', (_name, description) => {
    expect(deriveRule(description, 'HRANA', 'PERSONAL', 'r-new', AT)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// categorize — strict precedence: stated > items > rule > model > MISC
// ─────────────────────────────────────────────────────────────────────────────

describe('categorize: the ladder in strict precedence', () => {
  it('takes what you stated over line items that say otherwise', () => {
    const result = categorize(
      input({ stated: 'TRANSPORT', items: [{ description: 'PAMPERS 4', lineTotal: -800 }] }),
      ctx({ rules: [itemRule] }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('stated')
  })

  it('takes what you stated over a rule that says otherwise', () => {
    const result = categorize(
      input({ stated: 'TRANSPORT' }),
      ctx({ rules: [vendorRule] }),
    )
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
      input({ stated: 'TRANSPORT', items: [{ description: 'PAMPERS 4', lineTotal: -800 }] }),
      ctx({
        rules: [vendorRule, itemRule],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('stated')
    expect(result.confidence).toBe('high')
  })

  it('takes the line items over a vendor rule that says otherwise', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: -800 }] }),
      ctx({ rules: [vendorRule, itemRule] }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('takes the line items over a high-confidence model proposal that says otherwise', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: -800 }] }),
      ctx({
        rules: [itemRule],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('takes the rule over a high-confidence model proposal that says otherwise', () => {
    const result = categorize(
      input(),
      ctx({
        rules: [vendorRule],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })

  it('reports the rule as the source even when the model happens to agree with it', () => {
    const result = categorize(
      input(),
      ctx({
        rules: [vendorRule],
        modelProposal: { category: 'HRANA', confidence: 'high' },
      }),
    )
    expect(result.source).toBe('rule')
  })

  it('takes a high-confidence in-list model proposal when no rung above it fires', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('model')
    expect(result.confidence).toBe('high')
  })

  it('falls to MISC in the review queue when no rung fires at all', () => {
    const result = categorize(input({ description: 'POS 4738 BEOGRAD', counterparty: null }), ctx())
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
    expect(result.confidence).toBe('low')
  })

  it('resolves an unambiguous vendor by rule with high confidence', () => {
    const result = categorize(input(), ctx({ rules: [vendorRule] }))
    expect(result).toEqual({
      category: 'HRANA',
      source: 'rule',
      confidence: 'high',
      ambiguousVendor: false,
    })
  })

  it.each([
    ['stated', 'stated'],
    ['items', 'items'],
    ['rule', 'rule'],
  ] as const)('resolves at the %s rung with high confidence', (_name, expectedSource) => {
    const withStated = expectedSource === 'stated' ? 'TRANSPORT' : null
    const items = expectedSource === 'items' ? [{ description: 'PAMPERS 4', lineTotal: -800 }] : []
    const result = categorize(
      input({ stated: withStated, items }),
      ctx({ rules: [vendorRule, itemRule] }),
    )
    expect(result.source).toBe(expectedSource)
    expect(result.confidence).toBe('high')
  })
})

describe('categorize: what you stated', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ] as const)('ignores a stated category that is %s and drops to the next rung', (_name, stated) => {
    const result = categorize(input({ stated }), ctx({ rules: [vendorRule] }))
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })

  it('ignores an absent stated field and drops to the next rung', () => {
    const bare = input()
    delete bare.stated
    const result = categorize(bare, ctx({ rules: [vendorRule] }))
    expect(result.source).toBe('rule')
  })

  it('honours a stated category even when it is outside the allowed list, because you outrank the list', () => {
    const result = categorize(
      input({ stated: 'KUCNI_LJUBIMCI' }),
      ctx({ rules: [vendorRule], allowedCategories: ALLOWED }),
    )
    expect(result.category).toBe('KUCNI_LJUBIMCI')
    expect(result.source).toBe('stated')
  })

  it('honours a stated MISC as an explicit statement rather than treating it as unresolved', () => {
    const result = categorize(input({ stated: 'MISC' }), ctx({ rules: [vendorRule] }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('stated')
  })
})

describe('categorize: the ambiguous-vendor meta-rule', () => {
  const ambiguousHistory = [
    tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
    tx({ id: 'h2', counterparty: 'MAXI', category: 'DECA' }),
  ]
  const unambiguousHistory = [
    tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
    tx({ id: 'h2', counterparty: 'MAXI', category: 'HRANA' }),
  ]

  it('does not apply a matching rule when the vendor is ambiguous', () => {
    const result = categorize(input(), ctx({ rules: [vendorRule], history: ambiguousHistory }))
    expect(result.source).not.toBe('rule')
    expect(result.category).toBe('MISC')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('applies the same rule once the vendor is unambiguous', () => {
    const result = categorize(input(), ctx({ rules: [vendorRule], history: unambiguousHistory }))
    expect(result.source).toBe('rule')
    expect(result.category).toBe('HRANA')
    expect(result.ambiguousVendor).toBe(false)
  })

  it('drops to the line items for an ambiguous vendor rather than guessing from the vendor', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: -800 }] }),
      ctx({ rules: [vendorRule, itemRule], history: ambiguousHistory }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('lets the model answer for an ambiguous vendor with no line items', () => {
    const result = categorize(
      input(),
      ctx({
        rules: [vendorRule],
        history: ambiguousHistory,
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('ZABAVA')
    expect(result.source).toBe('model')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('suppresses the rule when the ambiguity was recorded under a case and whitespace variant of the vendor', () => {
    const result = categorize(
      input({ counterparty: '  maxi  ' }),
      ctx({
        rules: [vendorRule],
        history: [
          tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' }),
          tx({ id: 'h2', counterparty: 'Maxi ', category: 'DECA' }),
        ],
      }),
    )
    expect(result.source).not.toBe('rule')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('applies rules normally when the counterparty is null, since no vendor can be ambiguous', () => {
    const result = categorize(
      input({ counterparty: null }),
      ctx({ rules: [vendorRule], history: ambiguousHistory }),
    )
    expect(result.source).toBe('rule')
    expect(result.ambiguousVendor).toBe(false)
  })

  it('applies rules normally when the counterparty is an empty string', () => {
    const result = categorize(
      input({ counterparty: '' }),
      ctx({ rules: [vendorRule], history: ambiguousHistory }),
    )
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
      input({ counterparty: 'EPS SNABDEVANJE', description: 'EPS SNABDEVANJE' }),
      ctx({
        rules: [rule({ pattern: 'EPS SNABDEVANJE', category: 'STAN' })],
        history: [
          ...ambiguousHistory,
          tx({ id: 'h3', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
        ],
      }),
    )
    expect(result.category).toBe('STAN')
    expect(result.source).toBe('rule')
    expect(result.ambiguousVendor).toBe(false)
  })
})

describe('categorize: the model proposes, the code decides', () => {
  const bare = input({ description: 'POS 4738 BEOGRAD', counterparty: null })

  it('accepts a proposal at exactly high confidence', () => {
    const result = categorize(bare, ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }))
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('model')
  })

  it.each([
    ['medium', 'medium'],
    ['low', 'low'],
  ] as const)('discards a proposal at %s confidence and falls to MISC', (_name, confidence) => {
    const result = categorize(bare, ctx({ modelProposal: { category: 'TRANSPORT', confidence } }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards a proposal for a category outside the allowed list and falls to MISC', () => {
    const result = categorize(
      bare,
      ctx({ modelProposal: { category: 'KUCNI_LJUBIMCI', confidence: 'high' } }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards a proposal whose category is an empty string', () => {
    const result = categorize(bare, ctx({ modelProposal: { category: '', confidence: 'high' } }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards a proposal that matches an allowed category only up to case', () => {
    const result = categorize(
      bare,
      ctx({ modelProposal: { category: 'hrana', confidence: 'high' }, allowedCategories: ['HRANA'] }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards every proposal when the allowed list is empty', () => {
    const result = categorize(
      bare,
      ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' }, allowedCategories: [] }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('falls to MISC when the model proposal is null', () => {
    const result = categorize(bare, ctx({ modelProposal: null }))
    expect(result.source).toBe('misc')
  })

  it('falls to MISC when no model proposal field is present at all', () => {
    const context = ctx()
    delete context.modelProposal
    const result = categorize(bare, context)
    expect(result.source).toBe('misc')
  })

  it('discards a below-threshold proposal even when a lower-confidence answer would be better than MISC', () => {
    const result = categorize(
      bare,
      ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'medium' } }),
    )
    expect(result.confidence).toBe('low')
    expect(result.category).toBe('MISC')
  })
})

describe('categorize: rule selection', () => {
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

  it('applies the highest-priority rule when two vendor rules both match and disagree', () => {
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
    const result = categorize(input(), ctx({ rules: [], modelProposal: { category: 'HRANA', confidence: 'high' } }))
    expect(result.source).toBe('model')
  })
})

describe('categorize: line items', () => {
  it('skips the item rung when there are no line items', () => {
    const result = categorize(input({ items: [] }), ctx({ rules: [vendorRule, itemRule] }))
    expect(result.source).toBe('rule')
    expect(result.category).toBe('HRANA')
  })

  it('skips the item rung when no line item resolves to a category', () => {
    const result = categorize(
      input({ items: [{ description: 'NEPOZNATO', lineTotal: -300 }] }),
      ctx({ rules: [vendorRule, itemRule] }),
    )
    expect(result.source).toBe('rule')
  })

  it('resolves from line items whose lineTotal is absent', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: null }] }),
      ctx({ rules: [itemRule] }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('resolves when the item rung agrees across several line items', () => {
    const result = categorize(
      input({
        items: [
          { description: 'PAMPERS 4', lineTotal: -800 },
          { description: 'PAMPERS 5', lineTotal: -900 },
        ],
      }),
      ctx({ rules: [itemRule] }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('does not pick one category arbitrarily when the line items disagree, and lets the model decide instead', () => {
    const result = categorize(
      input({
        items: [
          { description: 'PAMPERS 4', lineTotal: -800 },
          { description: 'MLEKO 1L', lineTotal: -200 },
        ],
      }),
      ctx({
        rules: [
          itemRule,
          rule({ id: 'r-item-food', pattern: 'MAXI', itemPattern: 'MLEKO', category: 'HRANA', priority: 50 }),
        ],
        modelProposal: { category: 'HRANA', confidence: 'high' },
      }),
    )
    expect(result.source).toBe('model')
    expect(result.category).toBe('HRANA')
  })

  it('sends a mixed basket to the review queue when nothing below the item rung can decide', () => {
    const result = categorize(
      input({
        items: [
          { description: 'PAMPERS 4', lineTotal: -800 },
          { description: 'MLEKO 1L', lineTotal: -200 },
        ],
      }),
      ctx({
        rules: [
          itemRule,
          rule({ id: 'r-item-food', pattern: 'MAXI', itemPattern: 'MLEKO', category: 'HRANA', priority: 50 }),
        ],
      }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })
})

describe('categorize: degenerate input', () => {
  it('returns MISC for an empty description with no other signal', () => {
    const result = categorize(input({ description: '', counterparty: null }), ctx())
    expect(result).toEqual({
      category: 'MISC',
      source: 'misc',
      confidence: 'low',
      ambiguousVendor: false,
    })
  })

  it('returns MISC for a zero amount with no other signal', () => {
    const result = categorize(input({ description: '', counterparty: null, amount: 0 }), ctx())
    expect(result.category).toBe('MISC')
  })

  it('categorizes an inflow the same way as an outflow', () => {
    const result = categorize(
      input({ description: 'PLATA', counterparty: 'POSLODAVAC', amount: 180_000 }),
      ctx({ rules: [rule({ pattern: 'PLATA', category: 'PRIHOD' })] }),
    )
    expect(result.category).toBe('PRIHOD')
    expect(result.source).toBe('rule')
  })

  it('is reproducible: the same input and context resolve identically twice', () => {
    const i = input({ items: [{ description: 'PAMPERS 4', lineTotal: -800 }] })
    const c = ctx({ rules: [vendorRule, itemRule] })
    expect(categorize(i, c)).toEqual(categorize(i, c))
  })

  it('does not mutate the rules or history it was given', () => {
    const rules = [vendorRule, itemRule]
    const history = [tx({ id: 'h1', counterparty: 'MAXI', category: 'HRANA' })]
    const before = JSON.parse(JSON.stringify({ rules, history }))
    categorize(input(), ctx({ rules, history }))
    expect({ rules, history }).toEqual(before)
  })
})
