import { describe, it, expect } from 'vitest'

import { categorize } from '../../../src/core/ledger/categorize.js'
import type { CategorizeInput, CategorizeContext } from '../../../src/core/ledger/categorize.js'
import { sortRules, ruleMatches, deriveRule } from '../../../src/core/ledger/rules.js'
import type { CategorizationRule } from '../../../src/core/ledger/rules.js'
import { vendorIsAmbiguous, vendorCategories } from '../../../src/core/ledger/ambiguous-vendor.js'
import type { Clock, IdGen, Transaction } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. Core never reads the clock or generates ids itself, so
// deriveRule takes both as arguments; these supply fixed values.
// ---------------------------------------------------------------------------

const fakeClock: Clock = { now: () => new Date('2026-08-12T09:00:00.000Z') }
const fakeIds: IdGen = { next: () => 'rule-0001' }

const AT = fakeClock.now().toISOString()
const ID = fakeIds.next()
const BOOK = 'PERSONAL'

/** The v1 personal category set (04 §3). Lives in JSON, not in code. */
const ALLOWED = [
  'STAN', 'HRANA', 'TRANSPORT', 'ZDRAVLJE', 'DECA', 'ZABAVA',
  'ODECA', 'TEHNIKA', 'PUTOVANJA', 'FINANSIJE', 'PRIHOD', 'POREZI', 'MISC',
]

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't-1',
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
    dedupeKey: 'k-1',
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
    createdAt: '2026-07-01T00:00:00.000Z',
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

function matchInput(over: Partial<{ description: string; items: string[]; amount: number }> = {}) {
  return { description: 'WOLT DOSTAVA BEOGRAD', items: [] as string[], amount: 1200, ...over }
}

// ---------------------------------------------------------------------------
// vendorIsAmbiguous — the deterministic meta-rule (04 §3, 01 §5.1)
// ---------------------------------------------------------------------------

describe('vendorIsAmbiguous', () => {
  it('is false when the vendor has resolved to exactly one category in history', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 't-3', counterparty: 'WOLT', category: 'HRANA' }),
    ]
    expect(vendorIsAmbiguous('WOLT', history)).toBe(false)
  })

  it('is true the second time the vendor is categorized differently', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('is false when the vendor has never been seen', () => {
    const history = [tx({ counterparty: 'MAXI', category: 'HRANA' })]
    expect(vendorIsAmbiguous('LIDL', history)).toBe(false)
  })

  it('is false when history is empty', () => {
    expect(vendorIsAmbiguous('MAXI', [])).toBe(false)
  })

  it('is false for an empty vendor name', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'MAXI', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('', history)).toBe(false)
  })

  it('treats case variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'maxi', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('Maxi', history)).toBe(true)
  })

  it('treats whitespace variants of the same vendor as one vendor', () => {
    const history = [
      tx({ id: 't-1', counterparty: '  MAXI', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'MAXI  ', category: 'DECA' }),
    ]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('is false when the only differing category is the unresolved MISC placeholder', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'EPS SNABDEVANJE', category: 'STAN' }),
      tx({ id: 't-2', counterparty: 'EPS SNABDEVANJE', category: 'MISC' }),
    ]
    expect(vendorIsAmbiguous('EPS SNABDEVANJE', history)).toBe(false)
  })

  it('does not let a different vendor s split history make this vendor ambiguous', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 't-3', counterparty: 'MAXI', category: 'ODECA' }),
      tx({ id: 't-4', counterparty: null, category: 'ZABAVA' }),
    ]
    expect(vendorIsAmbiguous('WOLT', history)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// vendorCategories
// ---------------------------------------------------------------------------

describe('vendorCategories', () => {
  it('returns an empty list for a vendor with no history', () => {
    expect(vendorCategories('LIDL', [])).toEqual([])
  })

  it('returns the single category with its count for an unambiguous vendor', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: 'WOLT', category: 'HRANA' }),
      tx({ id: 't-3', counterparty: 'MAXI', category: 'HRANA' }),
    ]
    expect(vendorCategories('WOLT', history)).toEqual([{ category: 'HRANA', count: 2 }])
  })

  it('orders categories most frequent first', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'MAXI', category: 'DECA' }),
      tx({ id: 't-2', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-3', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-4', counterparty: 'MAXI', category: 'HRANA' }),
      tx({ id: 't-5', counterparty: 'MAXI', category: 'ODECA' }),
      tx({ id: 't-6', counterparty: 'MAXI', category: 'ODECA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([
      { category: 'HRANA', count: 3 },
      { category: 'ODECA', count: 2 },
      { category: 'DECA', count: 1 },
    ])
  })

  it('counts case and whitespace variants of the vendor as one vendor', () => {
    const history = [
      tx({ id: 't-1', counterparty: 'maxi ', category: 'HRANA' }),
      tx({ id: 't-2', counterparty: ' MAXI', category: 'HRANA' }),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 2 }])
  })

  it('returns an empty list for an empty vendor name', () => {
    const history = [tx({ counterparty: 'MAXI', category: 'HRANA' })]
    expect(vendorCategories('', history)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ruleMatches — (vendor + item pattern + amount band)
// ---------------------------------------------------------------------------

describe('ruleMatches', () => {
  it.each<[string, string, boolean]>([
    ['WOLT', 'WOLT DOSTAVA BEOGRAD', true],
    ['wolt', 'WOLT DOSTAVA BEOGRAD', true],
    ['WOLT', 'GLOVO KURIRSKA SLUZBA', false],
    ['WOLT BEOGRAD', 'WOLT DOSTAVA BEOGRAD', false],
  ])('contains pattern %j against %j matches: %s', (pattern, description, expected) => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern }), matchInput({ description }))).toBe(expected)
  })

  it.each<[string, string, boolean]>([
    ['WOLT', 'WOLT', true],
    ['wolt', '   WOLT   ', true],
    ['WOLT', 'WOLT DOSTAVA', false],
  ])('exact pattern %j against %j matches: %s', (pattern, description, expected) => {
    expect(ruleMatches(rule({ matchType: 'exact', pattern }), matchInput({ description }))).toBe(expected)
  })

  it.each<[string, string, boolean]>([
    ['^WOLT', 'WOLT DOSTAVA', true],
    ['^DOSTAVA', 'WOLT DOSTAVA', false],
    ['WOLT|GLOVO', 'GLOVO KURIR', true],
  ])('regex pattern %j against %j matches: %s', (pattern, description, expected) => {
    expect(ruleMatches(rule({ matchType: 'regex', pattern }), matchInput({ description }))).toBe(expected)
  })

  it('returns false for a malformed regex rather than throwing', () => {
    const bad = rule({ matchType: 'regex', pattern: 'WOLT([' })
    expect(() => ruleMatches(bad, matchInput({ description: 'WOLT DOSTAVA' }))).not.toThrow()
    expect(ruleMatches(bad, matchInput({ description: 'WOLT DOSTAVA' }))).toBe(false)
  })

  it('returns false for an empty pattern rather than matching every description', () => {
    expect(ruleMatches(rule({ matchType: 'contains', pattern: '' }), matchInput())).toBe(false)
  })

  it('returns false when the description is empty', () => {
    expect(ruleMatches(rule({ pattern: 'WOLT' }), matchInput({ description: '' }))).toBe(false)
  })

  it('ignores volatile tokens in the description, matching against the normalized form', () => {
    const r = rule({ matchType: 'exact', pattern: 'WOLT DOSTAVA' })
    expect(ruleMatches(r, matchInput({ description: 'WOLT DOSTAVA 12.08.2026 REF 99213847' }))).toBe(true)
  })

  it.each<[number, boolean]>([
    [1000, true],
    [5000, true],
    [3000, true],
    [999.99, false],
    [5000.01, false],
  ])('amount %s inside the band 1000..5000 matches: %s', (amount, expected) => {
    const banded = rule({ pattern: 'WOLT', amountMin: 1000, amountMax: 5000 })
    expect(ruleMatches(banded, matchInput({ amount }))).toBe(expected)
  })

  it.each<[number, boolean]>([
    [5000, true],
    [5000.01, false],
  ])('amount %s under an open-ended lower bound (max 5000) matches: %s', (amount, expected) => {
    const banded = rule({ pattern: 'WOLT', amountMin: null, amountMax: 5000 })
    expect(ruleMatches(banded, matchInput({ amount }))).toBe(expected)
  })

  it.each<[number, boolean]>([
    [1000, true],
    [999.99, false],
  ])('amount %s over an open-ended upper bound (min 1000) matches: %s', (amount, expected) => {
    const banded = rule({ pattern: 'WOLT', amountMin: 1000, amountMax: null })
    expect(ruleMatches(banded, matchInput({ amount }))).toBe(expected)
  })

  it('compares the amount band against the magnitude, so an outflow of -3000 is inside 1000..5000', () => {
    const banded = rule({ pattern: 'WOLT', amountMin: 1000, amountMax: 5000 })
    expect(ruleMatches(banded, matchInput({ amount: -3000 }))).toBe(true)
  })

  it('matches when any one line item matches the item pattern', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'pampers' })
    const i = matchInput({ description: 'MAXI BEOGRAD', items: ['MLEKO 1L', 'PAMPERS 4 MAXI'] })
    expect(ruleMatches(r, i)).toBe(true)
  })

  it('does not match when no line item matches the item pattern', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    const i = matchInput({ description: 'MAXI BEOGRAD', items: ['MLEKO 1L', 'HLEB'] })
    expect(ruleMatches(r, i)).toBe(false)
  })

  it('does not match an item-qualified rule when there are no line items at all', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, matchInput({ description: 'MAXI BEOGRAD', items: [] }))).toBe(false)
  })

  it('requires every condition to hold, so a matching vendor and item outside the band do not match', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 1000, amountMax: 5000 })
    const i = matchInput({ description: 'MAXI BEOGRAD', items: ['PAMPERS 4'], amount: 6000 })
    expect(ruleMatches(r, i)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sortRules — pure ordering
// ---------------------------------------------------------------------------

describe('sortRules', () => {
  it('returns an empty list for no rules', () => {
    expect(sortRules([])).toEqual([])
  })

  it('puts the highest priority first', () => {
    const low = rule({ id: 'low', priority: 1 })
    const high = rule({ id: 'high', priority: 900 })
    const mid = rule({ id: 'mid', priority: 100 })
    expect(sortRules([low, high, mid]).map((r) => r.id)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks a priority tie by specificity, so the more constrained rule comes first', () => {
    const bare = rule({ id: 'bare', priority: 100 })
    const specific = rule({ id: 'specific', priority: 100, itemPattern: 'PAMPERS', amountMin: 100, amountMax: 900 })
    expect(sortRules([bare, specific]).map((r) => r.id)).toEqual(['specific', 'bare'])
  })

  it('breaks a priority and specificity tie by hit count, most used first', () => {
    const cold = rule({ id: 'cold', priority: 100, hitCount: 0 })
    const hot = rule({ id: 'hot', priority: 100, hitCount: 42 })
    expect(sortRules([cold, hot]).map((r) => r.id)).toEqual(['hot', 'cold'])
  })

  it('prefers specificity over hit count when priorities are equal', () => {
    const popularButBare = rule({ id: 'bare', priority: 100, hitCount: 99 })
    const specific = rule({ id: 'specific', priority: 100, hitCount: 0, itemPattern: 'PAMPERS' })
    expect(sortRules([popularButBare, specific]).map((r) => r.id)).toEqual(['specific', 'bare'])
  })

  it('keeps every rule and does not mutate the input list', () => {
    const a = rule({ id: 'a', priority: 1 })
    const b = rule({ id: 'b', priority: 900 })
    const original = [a, b]
    expect(sortRules(original)).toHaveLength(2)
    expect(original.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// deriveRule — the learning loop (04 §3)
// ---------------------------------------------------------------------------

describe('deriveRule', () => {
  it('derives an upper-cased contains rule from the stable part of the description', () => {
    const derived = deriveRule('wolt 12.08.2026', 'HRANA', BOOK, ID, AT)
    expect(derived).not.toBeNull()
    expect(derived!.pattern).toBe('WOLT')
    expect(derived!.matchType).toBe('contains')
  })

  it('keeps a multi-word merchant name intact', () => {
    expect(deriveRule('EPS SNABDEVANJE RACUN 8837742', 'STAN', BOOK, ID, AT)!.pattern).toBe('EPS SNABDEVANJE')
  })

  it('strips dates, terminal ids, reference numbers and card suffixes from the pattern', () => {
    const derived = deriveRule('WOLT DOSTAVA 12.08.2026 TERM 4738 REF 99213847 ***1234', 'HRANA', BOOK, ID, AT)!
    expect(derived.pattern).toContain('WOLT')
    expect(derived.pattern).not.toContain('12.08.2026')
    expect(derived.pattern).not.toContain('4738')
    expect(derived.pattern).not.toContain('99213847')
    expect(derived.pattern).not.toContain('1234')
  })

  it('derives the same pattern from two visits to the same merchant with different volatile tokens', () => {
    const july = deriveRule('WOLT DOSTAVA 03.07.2026 REF 11111111', 'HRANA', BOOK, ID, AT)
    const august = deriveRule('WOLT DOSTAVA 12.08.2026 REF 99213847', 'HRANA', BOOK, ID, AT)
    expect(july!.pattern).toBe(august!.pattern)
  })

  it('carries the given category, book, id and timestamp onto the rule', () => {
    expect(deriveRule('WOLT 12.08.2026', 'HRANA', BOOK, ID, AT)).toMatchObject({
      id: ID,
      book: BOOK,
      category: 'HRANA',
      createdAt: AT,
    })
  })

  it('starts a freshly derived rule at zero hits with no item pattern and no amount band', () => {
    const derived = deriveRule('WOLT 12.08.2026', 'HRANA', BOOK, ID, AT)!
    expect(derived.hitCount).toBe(0)
    expect(derived.itemPattern ?? null).toBeNull()
    expect(derived.amountMin ?? null).toBeNull()
    expect(derived.amountMax ?? null).toBeNull()
    expect(typeof derived.priority).toBe('number')
  })

  it.each<[string, string]>([
    ['an empty description', ''],
    ['a whitespace-only description', '   '],
    ['a description that is only a date', '12.08.2026'],
    ['a description that is only a reference number', 'REF 99213847'],
    ['a description that is only a terminal id', 'POS 4738'],
    ['a description whose only word is a single letter', 'A 12.08.2026'],
  ])('returns null for %s rather than writing an unsafe rule', (_label, description) => {
    expect(deriveRule(description, 'HRANA', BOOK, ID, AT)).toBeNull()
  })

  it('returns null when the category is blank rather than deriving a rule to nowhere', () => {
    expect(deriveRule('WOLT 12.08.2026', '   ', BOOK, ID, AT)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// categorize — the signal ladder in strict precedence
// ---------------------------------------------------------------------------

describe('categorize — precedence', () => {
  it('uses what you stated even when line items, a rule and the model all disagree', () => {
    const result = categorize(
      input({
        stated: 'TRANSPORT',
        description: 'MAXI BEOGRAD',
        items: [{ description: 'PAMPERS 4', lineTotal: 900 }],
      }),
      ctx({
        rules: [
          rule({ id: 'r-item', pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' }),
          rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' }),
        ],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('stated')
  })

  it('uses the line items over a vendor rule that says something else', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', items: [{ description: 'PAMPERS 4', lineTotal: 900 }] }),
      ctx({
        rules: [
          rule({ id: 'r-item', pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' }),
          rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' }),
        ],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('uses a matching rule over a confident model proposal that says something else', () => {
    const result = categorize(
      input({ description: 'WOLT DOSTAVA', counterparty: 'WOLT', items: [] }),
      ctx({
        rules: [rule({ id: 'r-wolt', pattern: 'WOLT', category: 'HRANA' })],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })

  it('uses a confident model proposal over the MISC floor', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null, items: [] }),
      ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('model')
  })

  it('falls to MISC when no signal resolves the transaction', () => {
    const result = categorize(input({ description: 'POS 4738 BEOGRAD', counterparty: null, items: [] }), ctx())
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('picks the highest priority rule when two rules both match the description', () => {
    const result = categorize(
      input({ description: 'WOLT DOSTAVA', counterparty: 'WOLT', items: [] }),
      ctx({
        rules: [
          rule({ id: 'r-low', pattern: 'WOLT', category: 'ZABAVA', priority: 1 }),
          rule({ id: 'r-high', pattern: 'WOLT', category: 'HRANA', priority: 900 }),
        ],
      }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })
})

describe('categorize — the stated signal', () => {
  it('reports high confidence for a stated category', () => {
    expect(categorize(input({ stated: 'TRANSPORT' }), ctx()).confidence).toBe('high')
  })

  it('honours a stated category that is not in the allowed list, because you outrank the list', () => {
    const result = categorize(input({ stated: 'KUCNI_LJUBIMCI' }), ctx({ allowedCategories: ALLOWED }))
    expect(result.category).toBe('KUCNI_LJUBIMCI')
    expect(result.source).toBe('stated')
  })

  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('treats a stated value of %s as absent and drops to the next signal', (_label, stated) => {
    const result = categorize(
      input({ stated, description: 'WOLT DOSTAVA', counterparty: 'WOLT' }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })
})

describe('categorize — the line item signal', () => {
  it('reports high confidence when line items decide', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', items: [{ description: 'PAMPERS 4', lineTotal: 900 }] }),
      ctx({ rules: [rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' })] }),
    )
    expect(result.confidence).toBe('high')
  })

  it('uses a line item whose lineTotal is missing, because an absent amount is not a missing item', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', items: [{ description: 'PAMPERS 4', lineTotal: null }] }),
      ctx({ rules: [rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' })] }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('drops past the item signal when the line item list is empty', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', items: [] }),
      ctx({
        rules: [
          rule({ id: 'r-item', pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' }),
          rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' }),
        ],
      }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })

  it('drops past the item signal when no line item is recognised', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', items: [{ description: 'NEPOZNATO', lineTotal: 100 }] }),
      ctx({
        rules: [
          rule({ id: 'r-item', pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' }),
          rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' }),
        ],
      }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })
})

describe('categorize — the ambiguous vendor guard', () => {
  const splitHistory = [
    tx({ id: 't-1', counterparty: 'MAXI', category: 'HRANA' }),
    tx({ id: 't-2', counterparty: 'MAXI', category: 'DECA' }),
  ]
  const consistentHistory = [
    tx({ id: 't-1', counterparty: 'MAXI', category: 'HRANA' }),
    tx({ id: 't-2', counterparty: 'MAXI', category: 'HRANA' }),
  ]

  it('does not apply a matching rule when the vendor is ambiguous', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', counterparty: 'MAXI', items: [] }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: splitHistory }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('applies the same rule when the vendor has only ever resolved one way', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', counterparty: 'MAXI', items: [] }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: consistentHistory }),
    )
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
    expect(result.ambiguousVendor).toBe(false)
  })

  it('still lets the line items decide for an ambiguous vendor', () => {
    const result = categorize(
      input({
        description: 'MAXI BEOGRAD',
        counterparty: 'MAXI',
        items: [{ description: 'PAMPERS 4', lineTotal: 900 }],
      }),
      ctx({
        rules: [
          rule({ id: 'r-item', pattern: 'MAXI', itemPattern: 'PAMPERS', category: 'DECA' }),
          rule({ id: 'r-vendor', pattern: 'MAXI', category: 'HRANA' }),
        ],
        history: splitHistory,
      }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('falls through to the model when the rule is skipped for an ambiguous vendor', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', counterparty: 'MAXI', items: [] }),
      ctx({
        rules: [rule({ pattern: 'MAXI', category: 'HRANA' })],
        history: splitHistory,
        modelProposal: { category: 'ODECA', confidence: 'high' },
      }),
    )
    expect(result.category).toBe('ODECA')
    expect(result.source).toBe('model')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('reports the vendor as ambiguous even when a stated category made the rule irrelevant', () => {
    const result = categorize(
      input({ stated: 'TRANSPORT', description: 'MAXI BEOGRAD', counterparty: 'MAXI', items: [] }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: splitHistory }),
    )
    expect(result.source).toBe('stated')
    expect(result.ambiguousVendor).toBe(true)
  })

  it('reports no ambiguity when the counterparty is unknown', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', counterparty: null, items: [] }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: splitHistory }),
    )
    expect(result.ambiguousVendor).toBe(false)
    expect(result.category).toBe('HRANA')
    expect(result.source).toBe('rule')
  })

  it('recognises the ambiguous vendor through a case and whitespace variant of its name', () => {
    const result = categorize(
      input({ description: 'MAXI BEOGRAD', counterparty: '  maxi ', items: [] }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: splitHistory }),
    )
    expect(result.ambiguousVendor).toBe(true)
    expect(result.category).toBe('MISC')
  })
})

describe('categorize — the model signal', () => {
  const cryptic = () => input({ description: 'POS 4738 BEOGRAD', counterparty: null, items: [] })

  it('accepts a high confidence proposal that is inside the allowed categories', () => {
    const result = categorize(cryptic(), ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }))
    expect(result).toMatchObject({ category: 'TRANSPORT', source: 'model', confidence: 'high' })
  })

  it.each(['medium', 'low'] as const)('discards a %s confidence proposal and falls to MISC', (confidence) => {
    const result = categorize(cryptic(), ctx({ modelProposal: { category: 'TRANSPORT', confidence } }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards a confident proposal for a category that is not in the allowed list', () => {
    const result = categorize(cryptic(), ctx({ modelProposal: { category: 'KRIPTO', confidence: 'high' } }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('discards a proposal with an empty category', () => {
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

  it.each<[string, null | undefined]>([
    ['null', null],
    ['undefined', undefined],
  ])('falls to MISC when the model proposal is %s', (_label, modelProposal) => {
    const result = categorize(cryptic(), ctx({ modelProposal }))
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })
})

describe('categorize — the MISC floor', () => {
  it('reports MISC at low confidence when nothing resolved', () => {
    const result = categorize(input({ description: '', counterparty: null, items: [] }), ctx())
    expect(result).toMatchObject({ category: 'MISC', source: 'misc', confidence: 'low' })
  })

  it('falls to MISC when no rule matches the description', () => {
    const result = categorize(
      input({ description: 'GLOVO KURIR', counterparty: 'GLOVO', items: [] }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('falls to MISC rather than throwing when the amount is not a number', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null, amount: Number.NaN, items: [] }),
      ctx(),
    )
    expect(result.category).toBe('MISC')
    expect(result.source).toBe('misc')
  })

  it('reports high confidence for a rule hit', () => {
    const result = categorize(
      input({ description: 'WOLT DOSTAVA', counterparty: 'WOLT', items: [] }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
    )
    expect(result.confidence).toBe('high')
  })
})
