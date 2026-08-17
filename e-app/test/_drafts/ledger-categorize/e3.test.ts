import { describe, it, expect } from 'vitest'
import { categorize } from '../../../src/engine/ledger/categorize.js'
import type { CategorizeContext, CategorizeInput } from '../../../src/engine/ledger/categorize.js'
import { sortRules, ruleMatches, deriveRule } from '../../../src/engine/ledger/rules.js'
import type { CategorizationRule } from '../../../src/engine/ledger/rules.js'
import { vendorIsAmbiguous, vendorCategories } from '../../../src/engine/ledger/ambiguous-vendor.js'
import type { Transaction } from '../../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — plain hand-written values, no mocking library.
// ─────────────────────────────────────────────────────────────────────────────

/** The v1 PERSONAL category set (04-PERSONAL §3). */
const CATEGORIES = [
  'STAN', 'HRANA', 'TRANSPORT', 'ZDRAVLJE', 'DECA', 'ZABAVA',
  'ODECA', 'TEHNIKA', 'PUTOVANJA', 'FINANSIJE', 'PRIHOD', 'POREZI', 'MISC',
]

let txSeq = 0
function tx(counterparty: string | null, category: string, over: Partial<Transaction> = {}): Transaction {
  txSeq += 1
  return {
    id: `tx-${txSeq}`,
    book: 'PERSONAL',
    txDate: '2026-07-14',
    valueDate: '2026-07-14',
    description: counterparty ?? 'NEPOZNATO',
    counterparty,
    amount: -1200,
    currency: 'RSD',
    amountRsd: -1200,
    direction: 'out',
    category,
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: `dk-${txSeq}`,
    reviewStatus: 'ok',
    createdAt: '2026-07-15T09:00:00.000Z',
    ...over,
  }
}

let ruleSeq = 0
function rule(over: Partial<CategorizationRule> = {}): CategorizationRule {
  ruleSeq += 1
  return {
    id: `r-${ruleSeq}`,
    book: 'PERSONAL',
    matchType: 'contains',
    pattern: 'WOLT',
    itemPattern: null,
    amountMin: null,
    amountMax: null,
    category: 'HRANA',
    dimensions: {},
    priority: 10,
    hitCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...over,
  }
}

function input(over: Partial<CategorizeInput> = {}): CategorizeInput {
  return {
    description: 'MAXI BB 12.08.2026 POS 4738',
    counterparty: 'MAXI',
    amount: -2400,
    items: [],
    ...over,
  }
}

function ctx(over: Partial<CategorizeContext> = {}): CategorizeContext {
  return {
    rules: [],
    history: [],
    allowedCategories: CATEGORIES,
    modelProposal: null,
    ...over,
  }
}

/** A rule whose evidence is what was bought (rung 1), not who sold it (rung 2). */
function itemRule(itemPattern: string, category: string, over: Partial<CategorizationRule> = {}) {
  return rule({ pattern: '', matchType: 'contains', itemPattern, category, ...over })
}

// ─────────────────────────────────────────────────────────────────────────────
// vendorIsAmbiguous — the deterministic meta-rule (04 §3, 01 §5.1, D16)
// ─────────────────────────────────────────────────────────────────────────────

describe('vendorIsAmbiguous', () => {
  it('becomes true the second time the same vendor is filed differently', () => {
    const history = [tx('MAXI', 'HRANA'), tx('MAXI', 'DECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it.each([
    { label: 'zero categories (vendor unknown)', history: () => [tx('LIDL', 'HRANA')], vendor: 'MAXI', expected: false },
    { label: 'exactly one category, seen once', history: () => [tx('MAXI', 'HRANA')], vendor: 'MAXI', expected: false },
    { label: 'exactly one category, seen four times', history: () => [tx('MAXI', 'HRANA'), tx('MAXI', 'HRANA'), tx('MAXI', 'HRANA'), tx('MAXI', 'HRANA')], vendor: 'MAXI', expected: false },
    { label: 'exactly two categories', history: () => [tx('MAXI', 'HRANA'), tx('MAXI', 'ODECA')], vendor: 'MAXI', expected: true },
    { label: 'three categories', history: () => [tx('MAXI', 'HRANA'), tx('MAXI', 'ODECA'), tx('MAXI', 'DECA')], vendor: 'MAXI', expected: true },
  ])('is $expected with $label', ({ history, vendor, expected }) => {
    expect(vendorIsAmbiguous(vendor, history())).toBe(expected)
  })

  it('treats case variants of the same vendor as one vendor', () => {
    const history = [tx('MAXI', 'HRANA'), tx('maxi', 'DECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('treats whitespace variants of the same vendor as one vendor', () => {
    const history = [tx('  MAXI  ', 'HRANA'), tx('MAXI', 'DECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })

  it('collapses case and whitespace variants into one category, not two', () => {
    const history = [tx('MAXI', 'HRANA'), tx(' maxi ', 'HRANA'), tx('Maxi', 'HRANA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('matches the queried vendor case-insensitively as well', () => {
    const history = [tx('MAXI', 'HRANA'), tx('MAXI', 'DECA')]
    expect(vendorIsAmbiguous('  maxi ', history)).toBe(true)
  })

  it('is false when the history is empty', () => {
    expect(vendorIsAmbiguous('MAXI', [])).toBe(false)
  })

  it('is false for an empty vendor string rather than matching everything', () => {
    const history = [tx('MAXI', 'HRANA'), tx('LIDL', 'DECA')]
    expect(vendorIsAmbiguous('', history)).toBe(false)
  })

  it('is false for a whitespace-only vendor string', () => {
    const history = [tx('MAXI', 'HRANA'), tx('MAXI', 'DECA')]
    expect(vendorIsAmbiguous('   ', history)).toBe(false)
  })

  it('ignores transactions whose counterparty is null', () => {
    const history = [tx('MAXI', 'HRANA'), tx(null, 'DECA'), tx(null, 'ODECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('does not let another vendor’s categories make this vendor ambiguous', () => {
    const history = [tx('MAXI', 'HRANA'), tx('LIDL', 'DECA'), tx('IDEA', 'ODECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('does not count MISC as a category, since MISC means unresolved', () => {
    const history = [tx('MAXI', 'HRANA'), tx('MAXI', 'MISC')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(false)
  })

  it('is true when two resolved categories exist alongside MISC entries', () => {
    const history = [tx('MAXI', 'MISC'), tx('MAXI', 'HRANA'), tx('MAXI', 'DECA')]
    expect(vendorIsAmbiguous('MAXI', history)).toBe(true)
  })
})

describe('vendorCategories', () => {
  it('returns the categories a vendor has been filed under, most frequent first', () => {
    const history = [
      tx('MAXI', 'DECA'),
      tx('MAXI', 'HRANA'),
      tx('MAXI', 'HRANA'),
      tx('MAXI', 'HRANA'),
      tx('MAXI', 'DECA'),
      tx('MAXI', 'ODECA'),
    ]
    expect(vendorCategories('MAXI', history)).toEqual([
      { category: 'HRANA', count: 3 },
      { category: 'DECA', count: 2 },
      { category: 'ODECA', count: 1 },
    ])
  })

  it('returns one entry per vendor spelling, merging case and whitespace variants', () => {
    const history = [tx('MAXI', 'HRANA'), tx(' maxi', 'HRANA'), tx('Maxi ', 'HRANA')]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 3 }])
  })

  it('returns an empty list for a vendor with no history', () => {
    expect(vendorCategories('MAXI', [tx('LIDL', 'HRANA')])).toEqual([])
  })

  it('returns an empty list when the history is empty', () => {
    expect(vendorCategories('MAXI', [])).toEqual([])
  })

  it('excludes MISC, which records that nothing was decided', () => {
    const history = [tx('MAXI', 'HRANA'), tx('MAXI', 'MISC'), tx('MAXI', 'MISC')]
    expect(vendorCategories('MAXI', history)).toEqual([{ category: 'HRANA', count: 1 }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sortRules — pure ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('sortRules', () => {
  it('puts the highest priority first', () => {
    const low = rule({ id: 'low', priority: 1 })
    const high = rule({ id: 'high', priority: 100 })
    const mid = rule({ id: 'mid', priority: 50 })
    expect(sortRules([low, high, mid]).map((r) => r.id)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks a priority tie in favour of the more specific rule', () => {
    const vendorOnly = rule({ id: 'vendor-only', priority: 10 })
    const specific = rule({ id: 'specific', priority: 10, itemPattern: 'PAMPERS', amountMin: 100, amountMax: 5000 })
    expect(sortRules([vendorOnly, specific]).map((r) => r.id)).toEqual(['specific', 'vendor-only'])
  })

  it('breaks a specificity tie in favour of the more frequently hit rule', () => {
    const rare = rule({ id: 'rare', priority: 10, hitCount: 2 })
    const proven = rule({ id: 'proven', priority: 10, hitCount: 87 })
    expect(sortRules([rare, proven]).map((r) => r.id)).toEqual(['proven', 'rare'])
  })

  it('orders by priority before specificity, so a specific low-priority rule still loses', () => {
    const specificLow = rule({ id: 'specific-low', priority: 1, itemPattern: 'PAMPERS', amountMin: 1, amountMax: 2 })
    const plainHigh = rule({ id: 'plain-high', priority: 99 })
    expect(sortRules([specificLow, plainHigh]).map((r) => r.id)).toEqual(['plain-high', 'specific-low'])
  })

  it('returns an empty array for an empty input', () => {
    expect(sortRules([])).toEqual([])
  })

  it('keeps every rule it was given and does not mutate the array', () => {
    const rules = [rule({ id: 'a', priority: 1 }), rule({ id: 'b', priority: 9 }), rule({ id: 'c', priority: 5 })]
    expect(sortRules(rules).map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    expect(rules.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ruleMatches — every condition, and every boundary exactly
// ─────────────────────────────────────────────────────────────────────────────

describe('ruleMatches', () => {
  it.each([
    { matchType: 'contains' as const, pattern: 'WOLT', description: 'WOLT BEOGRAD', expected: true },
    { matchType: 'contains' as const, pattern: 'WOLT', description: 'GLOVO BEOGRAD', expected: false },
    { matchType: 'exact' as const, pattern: 'WOLT', description: 'WOLT', expected: true },
    { matchType: 'exact' as const, pattern: 'WOLT', description: 'WOLT BEOGRAD', expected: false },
    { matchType: 'regex' as const, pattern: '^WOLT', description: 'WOLT BEOGRAD', expected: true },
    { matchType: 'regex' as const, pattern: '^WOLT', description: 'PAY WOLT', expected: false },
    { matchType: 'regex' as const, pattern: 'WOLT|GLOVO', description: 'GLOVO', expected: true },
  ])('$matchType "$pattern" against "$description" is $expected', ({ matchType, pattern, description, expected }) => {
    expect(ruleMatches(rule({ matchType, pattern }), { description, items: [], amount: -1000 })).toBe(expected)
  })

  it('matches on the normalized description, so a terminal id and a date do not defeat the rule', () => {
    const r = rule({ matchType: 'contains', pattern: 'WOLT' })
    expect(ruleMatches(r, { description: 'WOLT *1234 05.08.2026 REF 998877', items: [], amount: -1450 })).toBe(true)
  })

  it('matches regardless of the case the pattern was written in', () => {
    const r = rule({ matchType: 'contains', pattern: 'wolt' })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount: -1450 })).toBe(true)
  })

  it('does not match an empty pattern against everything', () => {
    const r = rule({ matchType: 'contains', pattern: '' })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount: -1450 })).toBe(false)
  })

  it('does not match anything against an empty description', () => {
    const r = rule({ matchType: 'contains', pattern: 'WOLT' })
    expect(ruleMatches(r, { description: '', items: [], amount: -1450 })).toBe(false)
  })

  it('returns false rather than throwing when the stored regex is malformed', () => {
    const r = rule({ matchType: 'regex', pattern: '([unclosed' })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount: -1450 })).toBe(false)
  })

  it.each([
    { label: 'exactly at amountMin', amount: 500, expected: true },
    { label: 'one minor unit below amountMin', amount: 499.99, expected: false },
    { label: 'one minor unit above amountMin', amount: 500.01, expected: true },
    { label: 'exactly at amountMax', amount: 2000, expected: true },
    { label: 'one minor unit below amountMax', amount: 1999.99, expected: true },
    { label: 'one minor unit above amountMax', amount: 2000.01, expected: false },
  ])('an amount $label is $expected for a 500-2000 band', ({ amount, expected }) => {
    const r = rule({ pattern: 'WOLT', amountMin: 500, amountMax: 2000 })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount })).toBe(expected)
  })

  it('compares an outflow against the band by magnitude, since spend is stored negative', () => {
    const r = rule({ pattern: 'WOLT', amountMin: 500, amountMax: 2000 })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount: -1500 })).toBe(true)
  })

  it.each([
    { label: 'no lower bound', amountMin: null, amountMax: 2000, amount: 0.01, expected: true },
    { label: 'no upper bound', amountMin: 500, amountMax: null, amount: 9_999_999, expected: true },
    { label: 'no bounds at all', amountMin: null, amountMax: null, amount: 12345, expected: true },
    { label: 'no lower bound, above the upper one', amountMin: null, amountMax: 2000, amount: 2000.01, expected: false },
  ])('with $label the amount test is $expected', ({ amountMin, amountMax, amount, expected }) => {
    const r = rule({ pattern: 'WOLT', amountMin, amountMax })
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount })).toBe(expected)
  })

  it('treats an absent amount band as no constraint', () => {
    const r: CategorizationRule = { ...rule({ pattern: 'WOLT' }) }
    delete (r as Partial<CategorizationRule>).amountMin
    delete (r as Partial<CategorizationRule>).amountMax
    expect(ruleMatches(r, { description: 'WOLT BEOGRAD', items: [], amount: 88 })).toBe(true)
  })

  it('matches when the item pattern hits any one of several items', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, { description: 'MAXI BB', items: ['MLEKO', 'PAMPERS 4', 'HLEB'], amount: -3200 })).toBe(true)
  })

  it('does not match when the item pattern hits nothing, even though the vendor matches', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, { description: 'MAXI BB', items: ['MLEKO', 'HLEB'], amount: -3200 })).toBe(false)
  })

  it('does not match an item-conditioned rule when there are no line items at all', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, { description: 'MAXI BB', items: [], amount: -3200 })).toBe(false)
  })

  it('does not match when the item pattern hits but the vendor pattern does not', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS' })
    expect(ruleMatches(r, { description: 'LIDL NOVI BEOGRAD', items: ['PAMPERS 4'], amount: -3200 })).toBe(false)
  })

  it('requires every stated condition at once', () => {
    const r = rule({ pattern: 'MAXI', itemPattern: 'PAMPERS', amountMin: 1000, amountMax: 5000 })
    expect(ruleMatches(r, { description: 'MAXI BB', items: ['PAMPERS 4'], amount: 3200 })).toBe(true)
    expect(ruleMatches(r, { description: 'MAXI BB', items: ['PAMPERS 4'], amount: 5000.01 })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// deriveRule — the learning loop, and its refusals
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveRule', () => {
  const AT = '2026-08-12T10:15:00.000Z'

  it('derives a reusable rule from one correction', () => {
    const r = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(r).not.toBeNull()
    expect(r!.category).toBe('HRANA')
    expect(r!.book).toBe('PERSONAL')
    expect(r!.id).toBe('rule-1')
    expect(r!.createdAt).toBe(AT)
    expect(r!.hitCount).toBe(0)
  })

  it.each([
    { label: 'a date', description: 'WOLT 05.08.2026', volatile: '05.08.2026' },
    { label: 'an ISO date', description: 'WOLT 2026-08-05', volatile: '2026-08-05' },
    { label: 'a terminal id', description: 'WOLT POS 4738', volatile: '4738' },
    { label: 'a reference number', description: 'WOLT REF 998877221', volatile: '998877221' },
    { label: 'a card suffix', description: 'WOLT *1234', volatile: '1234' },
    { label: 'a time', description: 'WOLT 14:22:07', volatile: '14:22:07' },
  ])('strips $label from the derived pattern', ({ description, volatile: v }) => {
    const r = deriveRule(description, 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(r).not.toBeNull()
    expect(r!.pattern).not.toContain(v)
    expect(r!.pattern.toUpperCase()).toContain('WOLT')
  })

  it('derives a pattern that also matches the next charge from the same merchant', () => {
    const r = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(ruleMatches(r!, { description: 'WOLT *9987 11.09.2026', items: [], amount: -1780 })).toBe(true)
  })

  it('derives a pattern that does not match a different merchant', () => {
    const r = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(ruleMatches(r!, { description: 'GLOVO *9987 11.09.2026', items: [], amount: -1780 })).toBe(false)
  })

  it('does not lock an amount band from a single example', () => {
    const r = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(r!.amountMin ?? null).toBeNull()
    expect(r!.amountMax ?? null).toBeNull()
  })

  it('does not invent an item condition from a description-only correction', () => {
    const r = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-1', AT)
    expect(r!.itemPattern ?? null).toBeNull()
  })

  it.each([
    { label: 'the description is empty', description: '' },
    { label: 'the description is whitespace only', description: '   ' },
    { label: 'the description is only a date', description: '12.08.2026' },
    { label: 'the description is only reference numbers', description: 'REF 998877 4738 1234' },
    { label: 'the description is only punctuation', description: '*** -- //' },
    { label: 'nothing but a single character survives stripping', description: 'A 12.08.2026' },
  ])('returns null when $label, rather than writing an unsafe rule', ({ description }) => {
    expect(deriveRule(description, 'HRANA', 'PERSONAL', 'rule-1', AT)).toBeNull()
  })

  it('returns null when the category is empty, rather than learning a rule to nowhere', () => {
    expect(deriveRule('WOLT *1234 05.08.2026', '', 'PERSONAL', 'rule-1', AT)).toBeNull()
  })

  it('keeps a multi-word merchant name intact', () => {
    const r = deriveRule('EPS SNABDEVANJE 08/2026 REF 4471', 'STAN', 'PERSONAL', 'rule-9', AT)
    expect(r).not.toBeNull()
    expect(r!.pattern.toUpperCase()).toContain('EPS')
    expect(r!.pattern.toUpperCase()).toContain('SNABDEVANJE')
  })

  it('derives the same rule twice from the same description, ids aside', () => {
    const a = deriveRule('WOLT *1234 05.08.2026', 'HRANA', 'PERSONAL', 'rule-a', AT)
    const b = deriveRule('WOLT *5678 09.09.2026', 'HRANA', 'PERSONAL', 'rule-b', AT)
    expect(a!.pattern).toBe(b!.pattern)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// categorize — the signal ladder, in strict precedence
// ─────────────────────────────────────────────────────────────────────────────

describe('categorize — stated outranks everything', () => {
  it('uses the stated category when line items say something else', () => {
    const result = categorize(
      input({ stated: 'TRANSPORT', items: [{ description: 'PAMPERS 4', lineTotal: 1800 }] }),
      ctx({ rules: [itemRule('PAMPERS', 'DECA')] }),
    )
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('stated')
  })

  it('uses the stated category when a rule says something else', () => {
    const result = categorize(
      input({ stated: 'ZABAVA', description: 'WOLT *1234', counterparty: 'WOLT' }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA', priority: 100 })] }),
    )
    expect(result.category).toBe('ZABAVA')
    expect(result.source).toBe('stated')
  })

  it('uses the stated category when the model proposes something else with high confidence', () => {
    const result = categorize(
      input({ stated: 'ZDRAVLJE' }),
      ctx({ modelProposal: { category: 'HRANA', confidence: 'high' } }),
    )
    expect(result.category).toBe('ZDRAVLJE')
    expect(result.source).toBe('stated')
  })

  it('reports high confidence for a stated category', () => {
    const result = categorize(input({ stated: 'TRANSPORT' }), ctx())
    expect(result.confidence).toBe('high')
  })

  it('accepts a stated category written in lower case', () => {
    const result = categorize(input({ stated: '  transport ' }), ctx())
    expect(result.category).toBe('TRANSPORT')
    expect(result.source).toBe('stated')
  })

  it.each([
    { label: 'null', stated: null as string | null },
    { label: 'an empty string', stated: '' },
    { label: 'whitespace only', stated: '   ' },
  ])('ignores a stated value that is $label and falls through to the rule', ({ stated }) => {
    const result = categorize(
      input({ stated, description: 'WOLT *1234', counterparty: 'WOLT' }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule' })
  })

  it('ignores an absent stated field and falls through to the rule', () => {
    const noStated = input({ description: 'WOLT *1234', counterparty: 'WOLT' })
    delete (noStated as Partial<CategorizeInput>).stated
    const result = categorize(noStated, ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }))
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule' })
  })
})

describe('categorize — line items outrank rules and the model', () => {
  it('files by what was bought, not by who sold it', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4 MAXI', lineTotal: 1800 }] }),
      ctx({
        rules: [
          rule({ pattern: 'MAXI', category: 'HRANA', priority: 100 }),
          itemRule('PAMPERS', 'DECA', { priority: 1 }),
        ],
      }),
    )
    expect(result.category).toBe('DECA')
    expect(result.source).toBe('items')
  })

  it('prefers line items over a high-confidence model proposal', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: 1800 }] }),
      ctx({
        rules: [itemRule('PAMPERS', 'DECA')],
        modelProposal: { category: 'HRANA', confidence: 'high' },
      }),
    )
    expect(result).toMatchObject({ category: 'DECA', source: 'items' })
  })

  it('ignores an empty item list and drops to the rule', () => {
    const result = categorize(
      input({ items: [], description: 'MAXI BB', counterparty: 'MAXI' }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })] }),
    )
    expect(result.source).toBe('rule')
  })

  it('handles a line item with no line total', () => {
    const result = categorize(
      input({ items: [{ description: 'PAMPERS 4', lineTotal: null }] }),
      ctx({ rules: [itemRule('PAMPERS', 'DECA')] }),
    )
    expect(result).toMatchObject({ category: 'DECA', source: 'items' })
  })

  it('does not use line items that match nothing', () => {
    const result = categorize(
      input({ items: [{ description: 'NEPOZNATA STAVKA', lineTotal: 500 }], counterparty: 'MAXI' }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })] }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule' })
  })
})

describe('categorize — rules outrank the model', () => {
  it('uses a matching rule instead of a high-confidence model proposal that disagrees', () => {
    const result = categorize(
      input({ description: 'WOLT *1234', counterparty: 'WOLT' }),
      ctx({
        rules: [rule({ pattern: 'WOLT', category: 'HRANA' })],
        modelProposal: { category: 'ZABAVA', confidence: 'high' },
      }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule', confidence: 'high' })
  })

  it('uses the highest-priority rule when several match and disagree', () => {
    const result = categorize(
      input({ description: 'WOLT *1234', counterparty: 'WOLT' }),
      ctx({
        rules: [
          rule({ pattern: 'WOLT', category: 'ZABAVA', priority: 1 }),
          rule({ pattern: 'WOLT', category: 'HRANA', priority: 99 }),
        ],
      }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule' })
  })

  it('applies a rule for an unambiguous vendor and reports no ambiguity', () => {
    const result = categorize(
      input({ description: 'EPS SNABDEVANJE 08/2026', counterparty: 'EPS SNABDEVANJE' }),
      ctx({
        rules: [rule({ pattern: 'EPS SNABDEVANJE', category: 'STAN' })],
        history: [tx('EPS SNABDEVANJE', 'STAN'), tx('EPS SNABDEVANJE', 'STAN')],
      }),
    )
    expect(result).toMatchObject({ category: 'STAN', source: 'rule', ambiguousVendor: false })
  })

  it('applies a rule matched on the description when the counterparty is null', () => {
    const result = categorize(
      input({ description: 'WOLT *1234 05.08.2026', counterparty: null }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule', ambiguousVendor: false })
  })

  it('falls through when no rule matches', () => {
    const result = categorize(
      input({ description: 'GLOVO *1234', counterparty: 'GLOVO' }),
      ctx({
        rules: [rule({ pattern: 'WOLT', category: 'HRANA' })],
        modelProposal: { category: 'HRANA', confidence: 'high' },
      }),
    )
    expect(result.source).toBe('model')
  })

  it('falls through when the rule list is empty', () => {
    const result = categorize(input(), ctx({ rules: [], modelProposal: { category: 'HRANA', confidence: 'high' } }))
    expect(result.source).toBe('model')
  })
})

describe('categorize — a rule is not applied when the vendor is ambiguous', () => {
  const ambiguousHistory = () => [tx('MAXI', 'HRANA'), tx('MAXI', 'DECA')]

  it('refuses to apply the vendor rule and lands in MISC rather than guessing', () => {
    const result = categorize(
      input({ description: 'MAXI BB 12.08.2026', counterparty: 'MAXI' }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: ambiguousHistory() }),
    )
    expect(result).toMatchObject({ category: 'MISC', source: 'misc', ambiguousVendor: true, confidence: 'low' })
  })

  it('drops to line items, which still decide, and reports the ambiguity', () => {
    const result = categorize(
      input({
        description: 'MAXI BB 12.08.2026',
        counterparty: 'MAXI',
        items: [{ description: 'PAMPERS 4', lineTotal: 1800 }],
      }),
      ctx({
        rules: [rule({ pattern: 'MAXI', category: 'HRANA', priority: 100 }), itemRule('PAMPERS', 'DECA')],
        history: ambiguousHistory(),
      }),
    )
    expect(result).toMatchObject({ category: 'DECA', source: 'items', ambiguousVendor: true })
  })

  it('drops to the model when there are no line items', () => {
    const result = categorize(
      input({ description: 'MAXI BB 12.08.2026', counterparty: 'MAXI' }),
      ctx({
        rules: [rule({ pattern: 'MAXI', category: 'HRANA' })],
        history: ambiguousHistory(),
        modelProposal: { category: 'ODECA', confidence: 'high' },
      }),
    )
    expect(result).toMatchObject({ category: 'ODECA', source: 'model', ambiguousVendor: true })
  })

  it('blocks the rule even when the vendor is spelled differently in history', () => {
    const result = categorize(
      input({ description: 'MAXI BB', counterparty: '  maxi ' }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: ambiguousHistory() }),
    )
    expect(result).toMatchObject({ source: 'misc', ambiguousVendor: true })
  })

  it('does not block a different vendor’s rule', () => {
    const result = categorize(
      input({ description: 'WOLT *1234', counterparty: 'WOLT' }),
      ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })], history: ambiguousHistory() }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule', ambiguousVendor: false })
  })

  it('still lets the user’s stated category through', () => {
    const result = categorize(
      input({ stated: 'ODECA', description: 'MAXI BB', counterparty: 'MAXI' }),
      ctx({ rules: [rule({ pattern: 'MAXI', category: 'HRANA' })], history: ambiguousHistory() }),
    )
    expect(result).toMatchObject({ category: 'ODECA', source: 'stated' })
  })

  it('reports no ambiguity when the vendor has resolved one way only', () => {
    const result = categorize(
      input({ description: 'MAXI BB', counterparty: 'MAXI' }),
      ctx({
        rules: [rule({ pattern: 'MAXI', category: 'HRANA' })],
        history: [tx('MAXI', 'HRANA'), tx('MAXI', 'HRANA'), tx('MAXI', 'HRANA')],
      }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'rule', ambiguousVendor: false })
  })
})

describe('categorize — the model proposal is filtered before it is believed', () => {
  it('accepts a high-confidence proposal from the allowed set', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: 'TRANSPORT', confidence: 'high' } }),
    )
    expect(result).toMatchObject({ category: 'TRANSPORT', source: 'model', confidence: 'high' })
  })

  it.each([
    { confidence: 'high' as const, expectedSource: 'model' as const, expectedCategory: 'TRANSPORT' },
    { confidence: 'medium' as const, expectedSource: 'misc' as const, expectedCategory: 'MISC' },
    { confidence: 'low' as const, expectedSource: 'misc' as const, expectedCategory: 'MISC' },
  ])('a $confidence-confidence proposal resolves to $expectedCategory', ({ confidence, expectedSource, expectedCategory }) => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: 'TRANSPORT', confidence } }),
    )
    expect(result).toMatchObject({ category: expectedCategory, source: expectedSource })
  })

  it('discards a high-confidence proposal for a category that is not allowed', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: 'KUCNI_LJUBIMCI', confidence: 'high' } }),
    )
    expect(result).toMatchObject({ category: 'MISC', source: 'misc', confidence: 'low' })
  })

  it('accepts an allowed category proposed in the wrong case, normalized to the allowed spelling', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: 'hrana', confidence: 'high' } }),
    )
    expect(result).toMatchObject({ category: 'HRANA', source: 'model' })
  })

  it('discards a proposal with an empty category', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ modelProposal: { category: '', confidence: 'high' } }),
    )
    expect(result).toMatchObject({ category: 'MISC', source: 'misc' })
  })

  it('discards every proposal when the allowed set is empty', () => {
    const result = categorize(
      input({ description: 'POS 4738 BEOGRAD', counterparty: null }),
      ctx({ allowedCategories: [], modelProposal: { category: 'HRANA', confidence: 'high' } }),
    )
    expect(result).toMatchObject({ category: 'MISC', source: 'misc' })
  })

  it('lands in MISC when the proposal is null', () => {
    const result = categorize(input({ counterparty: null }), ctx({ modelProposal: null }))
    expect(result).toMatchObject({ category: 'MISC', source: 'misc' })
  })

  it('lands in MISC when no proposal field is present at all', () => {
    const bare = ctx()
    delete (bare as Partial<CategorizeContext>).modelProposal
    const result = categorize(input({ counterparty: null }), bare)
    expect(result).toMatchObject({ category: 'MISC', source: 'misc' })
  })
})

describe('categorize — MISC is the floor', () => {
  it('returns MISC with low confidence when nothing at all is known', () => {
    const result = categorize(
      { description: '', counterparty: null, amount: 0, items: [] },
      ctx(),
    )
    expect(result).toEqual({ category: 'MISC', source: 'misc', confidence: 'low', ambiguousVendor: false })
  })

  it('returns MISC for a cryptic descriptor with no rule and no model answer', () => {
    const result = categorize(input({ description: 'POS 4738 BEOGRAD', counterparty: null }), ctx())
    expect(result).toMatchObject({ category: 'MISC', source: 'misc' })
  })
})

describe('categorize — purity', () => {
  it('does not mutate the rules it was given', () => {
    const rules = [rule({ id: 'a', pattern: 'MAXI', category: 'HRANA', priority: 1, hitCount: 3 })]
    const before = JSON.stringify(rules)
    categorize(input(), ctx({ rules }))
    expect(JSON.stringify(rules)).toBe(before)
  })

  it('does not mutate the input it was given', () => {
    const inp = input({ items: [{ description: 'PAMPERS 4', lineTotal: 1800 }] })
    const before = JSON.stringify(inp)
    categorize(inp, ctx({ rules: [itemRule('PAMPERS', 'DECA')] }))
    expect(JSON.stringify(inp)).toBe(before)
  })

  it('returns the same result for the same input twice', () => {
    const inp = input({ description: 'WOLT *1234', counterparty: 'WOLT' })
    const c = ctx({ rules: [rule({ pattern: 'WOLT', category: 'HRANA' })] })
    expect(categorize(inp, c)).toEqual(categorize(inp, c))
  })
})
