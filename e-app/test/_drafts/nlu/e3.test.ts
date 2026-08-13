import { describe, it, expect } from 'vitest'

import { extractSlots, type Slots } from '../../../src/core/nlu/slots.js'
import { interpret, type ModelSlots, type Interpretation } from '../../../src/core/nlu/interpret.js'
import { decide } from '../../../src/core/nlu/confirm-policy.js'
import type { Book, DimensionAxisDef, Confidence, Money } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Fixtures — plain hand-written data. None of the three functions under test
// takes an injected dependency, so there is nothing to fake here.
// ---------------------------------------------------------------------------

/** SMOQUA-shaped axes: one required closed set with Serbian aliases, one open_text axis. */
const smoquaAxes: DimensionAxisDef[] = [
  {
    axis: 'category',
    type: 'closed_set',
    required: true,
    values: ['MATERIALS', 'MARKETING', 'DRINKS'],
    aliases: {
      MATERIALS: ['MATERIJAL', 'MATERIJALI'],
      MARKETING: ['REKLAMA'],
      DRINKS: ['PIĆE'],
    },
  },
  { axis: 'project', type: 'open_text', required: false },
]

/** A closed set built so that "MOOD" sits one edit from two different candidates. */
const equidistantAxes: DimensionAxisDef[] = [
  { axis: 'category', type: 'closed_set', required: true, values: ['FOOD', 'WOOD'] },
]

const emptySlots = (): Slots => ({ money: null, dimensions: {}, description: null, date: null })

const slots = (patch: Partial<Slots> = {}): Slots => ({ ...emptySlots(), ...patch })

const interpretation = (patch: Partial<Interpretation> = {}): Interpretation => ({
  slots: emptySlots(),
  confidence: 'exact',
  sources: {},
  conflicts: [],
  ...patch,
})

const eur = (amount: number): Money => ({ amount, currency: 'EUR' })
const rsd = (amount: number): Money => ({ amount, currency: 'RSD' })

const book = (patch: Partial<Book> = {}): Book => ({
  code: 'SMOQUA',
  name: 'SMOQUA',
  senderPhones: ['+381600000003'],
  blobPrefix: 'SMOQUA/',
  defaultCategory: 'expense',
  accountantEmail: null,
  currency: 'EUR',
  dimensions: smoquaAxes,
  ...patch,
  features: {
    sef: false,
    invoicing: false,
    vat: null,
    confirmAboveAmount: 500,
    ...(patch.features ?? {}),
  },
})

/** The book from the worked example: a required category axis, a 500 EUR tap threshold. */
const smoqua = book()

/** A book with no required axes — money is then the only required slot. */
const personal = book({
  code: 'PERSONAL',
  currency: 'RSD',
  dimensions: [{ axis: 'project', type: 'open_text', required: false }],
  features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 20000 },
})

// The contract does not fix whether per-axis provenance / conflict / missing keys are
// spelled "category" or "dimensions.category". These helpers accept either, so the tests
// pin behaviour rather than a key spelling the spec never chose. (See specGaps.)
const axisEntry = (keys: string[], axis: string): string | undefined =>
  keys.find((k) => k === axis || k === `dimensions.${axis}`)

const sourceForAxis = (r: Interpretation, axis: string): string | undefined => {
  const key = axisEntry(Object.keys(r.sources), axis)
  return key === undefined ? undefined : r.sources[key]
}

const conflictsOnAxis = (r: Interpretation, axis: string): boolean =>
  axisEntry(r.conflicts, axis) !== undefined

// ===========================================================================
// extractSlots — the deterministic first pass
// ===========================================================================

describe('extractSlots — order tolerance', () => {
  const pairs: Array<{ a: string; b: string }> = [
    { a: '300e MATERIALS', b: 'MATERIALS 300e' },
    { a: 'MATERIJAL 4.210,00', b: '4.210,00 MATERIJAL' },
  ]

  it.each(pairs)('produces identical slots for "$a" and "$b"', ({ a, b }) => {
    expect(extractSlots(a, smoquaAxes).slots).toEqual(extractSlots(b, smoquaAxes).slots)
  })

  it('produces the same slots and the same leftover set regardless of word order', () => {
    const first = extractSlots('PAMUK 300e MATERIALS', smoquaAxes)
    const second = extractSlots('MATERIALS PAMUK 300e', smoquaAxes)
    expect(first.slots).toEqual(second.slots)
    expect([...first.leftoverTokens].sort()).toEqual([...second.leftoverTokens].sort())
  })
})

describe('extractSlots — amounts', () => {
  const amounts: Array<{ text: string; money: Money }> = [
    { text: '4210', money: rsd(4210) },
    { text: '4.210,00', money: rsd(4210) },
    { text: '300e', money: eur(300) },
    { text: '300€', money: eur(300) },
    { text: '300 EVRA', money: eur(300) },
    { text: '1500din', money: rsd(1500) },
    { text: '12k', money: rsd(12000) },
  ]

  it.each(amounts)('parses "$text" deterministically', ({ text, money }) => {
    expect(extractSlots(text, smoquaAxes).slots.money).toEqual(money)
  })

  it('consumes every token of a multi-token amount so the model is never asked about it', () => {
    const result = extractSlots('MATERIJAL 300 EVRA', smoquaAxes)
    expect(result.slots.money).toEqual(eur(300))
    expect(result.leftoverTokens).toEqual([])
  })

  it('returns null money for a spelled-out amount and hands the words to the model', () => {
    const result = extractSlots('tri hiljade materijal', smoquaAxes)
    expect(result.slots.money).toBeNull()
    expect(result.leftoverTokens.join(' ').toLowerCase()).toContain('tri hiljade')
  })

  it('returns null money when two currency-marked amounts compete', () => {
    expect(extractSlots('MATERIJAL 200e 300e', smoquaAxes).slots.money).toBeNull()
  })

  it('leaves both competing amount tokens as leftovers so the caller can ask which one', () => {
    const leftovers = extractSlots('MATERIJAL 200e 300e', smoquaAxes).leftoverTokens.join(' ')
    expect(leftovers).toContain('200e')
    expect(leftovers).toContain('300e')
  })

  it('returns null money when two bare numbers compete and neither carries a currency', () => {
    expect(extractSlots('MATERIJAL 4210 5000', smoquaAxes).slots.money).toBeNull()
  })

  it('prefers the currency-marked amount over a bare number rather than declaring a conflict', () => {
    const result = extractSlots('MATERIJAL 300e 4210', smoquaAxes)
    expect(result.slots.money).toEqual(eur(300))
    expect(result.leftoverTokens).toContain('4210')
  })
})

describe('extractSlots — dimensions', () => {
  it('resolves an exact closed-set value', () => {
    expect(extractSlots('MATERIALS 300e', smoquaAxes).slots.dimensions).toEqual({
      category: 'MATERIALS',
    })
  })

  it('resolves a declared alias to its canonical value', () => {
    expect(extractSlots('MATERIJAL 300e', smoquaAxes).slots.dimensions.category).toBe('MATERIALS')
  })

  it('resolves an alias written in lower case and without its diacritics', () => {
    expect(extractSlots('pice 300e', smoquaAxes).slots.dimensions.category).toBe('DRINKS')
  })

  it('resolves a typo within edit distance 2 of an alias', () => {
    const result = extractSlots('MATERIJAAL 200E', smoquaAxes)
    expect(result.slots.dimensions.category).toBe('MATERIALS')
    expect(result.leftoverTokens).toEqual([])
  })

  it('returns no dimension and never invents a fallback for an unknown word', () => {
    const result = extractSlots('KVANTNAFIZIKA 300e', smoquaAxes)
    expect(result.slots.dimensions).toEqual({})
    expect(result.leftoverTokens.join(' ')).toContain('KVANTNAFIZIKA')
  })

  it('returns null rather than guessing when a token is equidistant from two candidates', () => {
    const result = extractSlots('MOOD 300e', equidistantAxes)
    expect(result.slots.dimensions).toEqual({})
    expect(result.leftoverTokens).toContain('MOOD')
  })

  it('does not fill an open_text axis deterministically — free words go to the model', () => {
    const result = extractSlots('MATERIJAL 200e Projekat 1', smoquaAxes)
    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
  })

  it('claims no dimension at all when the book declares no axes', () => {
    const result = extractSlots('MATERIALS 300e', [])
    expect(result.slots.dimensions).toEqual({})
    expect(result.slots.money).toEqual(eur(300))
    expect(result.leftoverTokens).toContain('MATERIALS')
  })
})

describe('extractSlots — description, date, and empty input', () => {
  it('leaves description null and hands the unclaimed words to the model instead', () => {
    const result = extractSlots('MATERIJAL 200e PAMUK', smoquaAxes)
    expect(result.slots.description).toBeNull()
    expect(result.leftoverTokens).toContain('PAMUK')
  })

  it('extracts an unambiguous ISO date without reading it as an amount', () => {
    const result = extractSlots('MATERIJAL 200e 2026-03-11', smoquaAxes)
    expect(result.slots.date).toBe('2026-03-11')
    expect(result.slots.money).toEqual(eur(200))
  })

  const emptyish: Array<{ label: string; text: string }> = [
    { label: 'an empty string', text: '' },
    { label: 'whitespace only', text: '   \t\n ' },
  ]

  it.each(emptyish)('returns empty slots and no leftovers for $label', ({ text }) => {
    const result = extractSlots(text, smoquaAxes)
    expect(result.slots).toEqual(emptySlots())
    expect(result.leftoverTokens).toEqual([])
  })
})

describe('extractSlots — the worked case from 02 §5.1', () => {
  const run = () => extractSlots('MATERIJAAL PAMUK 200E Projekat 1', smoquaAxes)

  it('reads 200 EUR from the money grammar', () => {
    expect(run().slots.money).toEqual(eur(200))
  })

  it('fuzzy-matches MATERIJAAL to MATERIALS without a model call', () => {
    expect(run().slots.dimensions).toEqual({ category: 'MATERIALS' })
  })

  it('does not read the trailing "1" of "Projekat 1" as a second amount', () => {
    expect(run().slots.money).toEqual(eur(200))
    expect(run().leftoverTokens.join(' ')).toContain('1')
  })

  it('hands exactly PAMUK and Projekat 1 to the model, in input order and original casing', () => {
    expect(run().leftoverTokens.join(' ')).toBe('PAMUK Projekat 1')
  })
})

// ===========================================================================
// interpret — deterministic always wins, malformed model output is no answer
// ===========================================================================

describe('interpret — no model answer', () => {
  it('returns the deterministic slots unchanged when the model was never called', () => {
    const det = slots({ money: eur(200), dimensions: { category: 'MATERIALS' } })
    expect(interpret(det, null).slots).toEqual(det)
  })

  it('marks every filled field as deterministic and records nothing for unfilled ones', () => {
    const result = interpret(slots({ money: eur(200), description: 'PAMUK' }), null)
    expect(result.sources.money).toBe('deterministic')
    expect(result.sources.description).toBe('deterministic')
    expect(result.sources.date).toBeUndefined()
  })

  it('reports exact confidence and no conflicts when nothing came from a model', () => {
    const result = interpret(slots({ money: eur(200) }), null)
    expect(result.confidence).toBe('exact')
    expect(result.conflicts).toEqual([])
  })

  it('returns empty slots, empty sources and no conflicts for a wholly empty input', () => {
    const result = interpret(emptySlots(), null)
    expect(result.slots).toEqual(emptySlots())
    expect(result.sources).toEqual({})
    expect(result.conflicts).toEqual([])
  })
})

describe('interpret — the deterministic slot always wins', () => {
  const detMoney = () => slots({ money: eur(200) })

  it('keeps the deterministically parsed amount when the model proposes a different one', () => {
    const result = interpret(detMoney(), {
      money: { amount: 900, currency: 'USD' },
      confidence: 'high',
    })
    expect(result.slots.money).toEqual(eur(200))
    expect(result.sources.money).toBe('deterministic')
    expect(result.conflicts).toContain('money')
  })

  it('records a conflict when the model agrees on the number but not the currency', () => {
    const result = interpret(detMoney(), {
      money: { amount: 200, currency: 'USD' },
      confidence: 'high',
    })
    expect(result.slots.money).toEqual(eur(200))
    expect(result.conflicts).toContain('money')
  })

  it('records no conflict when the model independently agrees with the grammar', () => {
    const result = interpret(detMoney(), {
      money: { amount: 200, currency: 'EUR' },
      confidence: 'high',
    })
    expect(result.conflicts).toEqual([])
    expect(result.sources.money).toBe('deterministic')
  })

  it('keeps the deterministic dimension and records the disagreement on that axis', () => {
    const result = interpret(slots({ dimensions: { category: 'MATERIALS' } }), {
      dimensions: { category: 'MARKETING' },
      confidence: 'high',
    })
    expect(result.slots.dimensions.category).toBe('MATERIALS')
    expect(conflictsOnAxis(result, 'category')).toBe(true)
  })

  it('lets the model add a different axis while refusing to overwrite the deterministic one', () => {
    const result = interpret(slots({ dimensions: { category: 'MATERIALS' } }), {
      dimensions: { category: 'MARKETING', project: 'Projekat 1' },
      confidence: 'high',
    })
    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
    expect(result.conflicts).toHaveLength(1)
  })

  it('keeps the deterministic description over the model rewording it', () => {
    const result = interpret(slots({ description: 'PAMUK' }), {
      description: 'cotton fabric',
      confidence: 'high',
    })
    expect(result.slots.description).toBe('PAMUK')
    expect(result.conflicts).toContain('description')
  })

  it('keeps the deterministic date over a model-proposed date', () => {
    const result = interpret(slots({ date: '2026-03-11' }), {
      date: '2026-03-12',
      confidence: 'high',
    })
    expect(result.slots.date).toBe('2026-03-11')
    expect(result.conflicts).toContain('date')
  })

  it('does not mutate the deterministic slots it was given', () => {
    const det = slots({ money: eur(200), dimensions: { category: 'MATERIALS' } })
    interpret(det, {
      money: { amount: 9, currency: 'USD' },
      dimensions: { project: 'Projekat 1' },
      confidence: 'high',
    })
    expect(det).toEqual(slots({ money: eur(200), dimensions: { category: 'MATERIALS' } }))
  })
})

describe('interpret — the model may fill gaps', () => {
  it('takes the amount from the model when the grammar declined to parse one', () => {
    const result = interpret(slots(), { money: { amount: 3000, currency: 'RSD' }, confidence: 'high' })
    expect(result.slots.money).toEqual(rsd(3000))
    expect(result.sources.money).toBe('model')
    expect(result.conflicts).toEqual([])
  })

  it('takes the description from the model when the deterministic pass left it empty', () => {
    const result = interpret(slots({ money: eur(200) }), { description: 'PAMUK', confidence: 'high' })
    expect(result.slots.description).toBe('PAMUK')
    expect(result.sources.description).toBe('model')
  })

  it('takes an open_text axis from the model while the closed-set axis stays deterministic', () => {
    const result = interpret(slots({ dimensions: { category: 'MATERIALS' } }), {
      dimensions: { project: 'Projekat 1' },
      confidence: 'high',
    })
    expect(result.slots.dimensions.project).toBe('Projekat 1')
    expect(sourceForAxis(result, 'project')).toBe('model')
    expect(sourceForAxis(result, 'category')).toBe('deterministic')
  })

  it('accepts a lower-case currency code from the model and normalizes it', () => {
    const result = interpret(slots(), { money: { amount: 300, currency: 'eur' }, confidence: 'high' })
    expect(result.slots.money).toEqual(eur(300))
  })
})

describe('interpret — malformed model output is no answer, never a value', () => {
  const badMoney: Array<{ label: string; money: unknown }> = [
    { label: 'a NaN amount', money: { amount: Number.NaN, currency: 'EUR' } },
    { label: 'an infinite amount', money: { amount: Number.POSITIVE_INFINITY, currency: 'EUR' } },
    { label: 'a zero amount', money: { amount: 0, currency: 'EUR' } },
    { label: 'a negative amount', money: { amount: -200, currency: 'EUR' } },
    { label: 'a stringified amount', money: { amount: '200', currency: 'EUR' } },
    { label: 'an unknown currency code', money: { amount: 200, currency: 'XYZ' } },
    { label: 'no currency at all', money: { amount: 200 } },
    { label: 'money that is not an object', money: 'about 200 euro' },
  ]

  it.each(badMoney)('leaves money null when the model returns $label', ({ money }) => {
    const model = { money, confidence: 'high' } as unknown as ModelSlots
    expect(interpret(emptySlots(), model).slots.money).toBeNull()
  })

  it('records neither a source nor a conflict for money the model failed to answer', () => {
    const model = { money: { amount: Number.NaN, currency: 'EUR' }, confidence: 'high' } as ModelSlots
    const result = interpret(emptySlots(), model)
    expect(result.sources.money).toBeUndefined()
    expect(result.conflicts).toEqual([])
  })

  it('keeps the deterministic amount and records no conflict when the model answer was invalid', () => {
    const model = { money: { amount: -1, currency: 'EUR' }, confidence: 'high' } as ModelSlots
    const result = interpret(slots({ money: eur(200) }), model)
    expect(result.slots.money).toEqual(eur(200))
    expect(result.conflicts).toEqual([])
  })

  const badDescription: Array<{ label: string; description: unknown }> = [
    { label: 'an empty string', description: '' },
    { label: 'whitespace only', description: '   ' },
    { label: 'a number', description: 200 },
  ]

  it.each(badDescription)('leaves description null when the model returns $label', ({ description }) => {
    const model = { description, confidence: 'high' } as unknown as ModelSlots
    expect(interpret(emptySlots(), model).slots.description).toBeNull()
  })

  const badDate: Array<{ label: string; date: unknown }> = [
    { label: 'a non-ISO format', date: '11/03/2026' },
    { label: 'an impossible calendar date', date: '2026-13-45' },
    { label: 'prose', date: 'yesterday' },
    { label: 'an empty string', date: '' },
  ]

  it.each(badDate)('leaves date null when the model returns $label', ({ date }) => {
    const model = { date, confidence: 'high' } as unknown as ModelSlots
    expect(interpret(emptySlots(), model).slots.date).toBeNull()
  })

  it('accepts a well-formed ISO date from the model', () => {
    const result = interpret(emptySlots(), { date: '2026-03-11', confidence: 'high' })
    expect(result.slots.date).toBe('2026-03-11')
    expect(result.sources.date).toBe('model')
  })

  const badDimensionValues: Array<{ label: string; value: unknown }> = [
    { label: 'null', value: null },
    { label: 'an empty string', value: '' },
    { label: 'whitespace only', value: '  ' },
    { label: 'a number', value: 7 },
  ]

  it.each(badDimensionValues)('drops a model dimension whose value is $label', ({ value }) => {
    const model = { dimensions: { project: value }, confidence: 'high' } as unknown as ModelSlots
    expect(interpret(emptySlots(), model).slots.dimensions).toEqual({})
  })

  it('keeps the valid axes when only one model dimension is malformed', () => {
    const model = {
      dimensions: { project: 'Projekat 1', category: 42 },
      confidence: 'high',
    } as unknown as ModelSlots
    expect(interpret(emptySlots(), model).slots.dimensions).toEqual({ project: 'Projekat 1' })
  })

  it('drops the whole model answer when its confidence value is not a valid level', () => {
    const model = { description: 'PAMUK', confidence: 'very sure' } as unknown as ModelSlots
    const result = interpret(slots({ money: eur(200) }), model)
    expect(result.slots.description).toBeNull()
    expect(result.sources.description).toBeUndefined()
  })

  it('treats a model object carrying no fields at all as no answer', () => {
    const result = interpret(slots({ money: eur(200) }), { confidence: 'low' })
    expect(result.slots).toEqual(slots({ money: eur(200) }))
    expect(result.conflicts).toEqual([])
  })
})

describe('interpret — resulting confidence', () => {
  it('stays exact when the model contributed nothing, however confident it claimed to be', () => {
    const result = interpret(slots({ money: eur(200), dimensions: { category: 'MATERIALS' } }), {
      money: { amount: 200, currency: 'EUR' },
      confidence: 'low',
    })
    expect(result.confidence).toBe('exact')
  })

  const levels: Array<{ level: Confidence }> = [
    { level: 'exact' },
    { level: 'high' },
    { level: 'medium' },
    { level: 'low' },
  ]

  it.each(levels)('reports $level when the model contributed a field at $level', ({ level }) => {
    const result = interpret(slots({ money: eur(200) }), { description: 'PAMUK', confidence: level })
    expect(result.confidence).toBe(level)
  })
})

describe('interpret — the worked case from 02 §5.1', () => {
  const model: ModelSlots = {
    description: 'PAMUK',
    dimensions: { project: 'Projekat 1' },
    confidence: 'high',
  }
  const det = () => extractSlots('MATERIJAAL PAMUK 200E Projekat 1', smoquaAxes).slots

  it('merges the grammar amount, the fuzzy category and the model leftovers into one reading', () => {
    expect(interpret(det(), model).slots).toEqual({
      money: eur(200),
      dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
      description: 'PAMUK',
      date: null,
    })
  })

  it('attributes the amount and the category to the grammar, the rest to the model', () => {
    const result = interpret(det(), model)
    expect(result.sources.money).toBe('deterministic')
    expect(sourceForAxis(result, 'category')).toBe('deterministic')
    expect(result.sources.description).toBe('model')
    expect(sourceForAxis(result, 'project')).toBe('model')
    expect(result.conflicts).toEqual([])
  })

  it('refuses the model amount and records the conflict when the model contradicts 200E', () => {
    const result = interpret(det(), { ...model, money: { amount: 20000, currency: 'RSD' } })
    expect(result.slots.money).toEqual(eur(200))
    expect(result.conflicts).toContain('money')
  })
})

// ===========================================================================
// decide — commit vs confirm vs ask
// ===========================================================================

const filled = (patch: Partial<Slots> = {}): Slots =>
  slots({ money: eur(200), dimensions: { category: 'MATERIALS' }, ...patch })

describe('decide — commit', () => {
  it('commits when every required slot is filled deterministically and the amount is small', () => {
    expect(decide(interpretation({ slots: filled(), confidence: 'exact' }), smoqua)).toEqual({
      action: 'commit',
    })
  })

  it('commits a high-confidence model-sourced reading — provenance does not block a commit', () => {
    const result = decide(
      interpretation({ slots: filled(), confidence: 'high', sources: { money: 'model' } }),
      smoqua,
    )
    expect(result).toEqual({ action: 'commit' })
  })

  it('commits although the optional description and date are both absent', () => {
    const result = decide(interpretation({ slots: filled({ description: null, date: null }) }), smoqua)
    expect(result.action).toBe('commit')
  })

  it('commits 200 EUR of cotton, exactly as the spec promises', () => {
    const result = decide(
      interpretation({
        slots: {
          money: eur(200),
          dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
          description: 'PAMUK',
          date: null,
        },
        confidence: 'high',
      }),
      smoqua,
    )
    expect(result).toEqual({ action: 'commit' })
  })
})

describe('decide — the book amount threshold', () => {
  const cases: Array<{ amount: number; action: string; note: string }> = [
    { amount: 1, action: 'commit', note: 'far below' },
    { amount: 499.99, action: 'commit', note: 'one cent below' },
    { amount: 500, action: 'confirm', note: 'exactly at' },
    { amount: 500.01, action: 'confirm', note: 'one cent above' },
    { amount: 5000, action: 'confirm', note: 'an order of magnitude above' },
  ]

  it.each(cases)('$action for $amount — $note the 500 threshold', ({ amount, action }) => {
    const result = decide(interpretation({ slots: filled({ money: eur(amount) }) }), smoqua)
    expect(result.action).toBe(action)
  })

  it('gives large_amount as the reason at exactly the threshold', () => {
    expect(decide(interpretation({ slots: filled({ money: eur(500) }) }), smoqua)).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('applies each book its own threshold, exactly at the boundary', () => {
    expect(decide(interpretation({ slots: slots({ money: rsd(19999) }) }), personal).action).toBe('commit')
    expect(decide(interpretation({ slots: slots({ money: rsd(20000) }) }), personal)).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })

  it('confirms every amount when the book threshold is zero', () => {
    const zeroBook = book({
      features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 0 },
    })
    expect(decide(interpretation({ slots: filled({ money: eur(1) }) }), zeroBook)).toEqual({
      action: 'confirm',
      reason: 'large_amount',
    })
  })
})

describe('decide — confidence', () => {
  const levels: Array<{ level: Confidence; action: string }> = [
    { level: 'exact', action: 'commit' },
    { level: 'high', action: 'commit' },
    { level: 'medium', action: 'confirm' },
    { level: 'low', action: 'confirm' },
  ]

  it.each(levels)('$action on $level confidence', ({ level, action }) => {
    expect(decide(interpretation({ slots: filled(), confidence: level }), smoqua).action).toBe(action)
  })

  it('gives low_confidence as the reason for a merely medium reading', () => {
    expect(decide(interpretation({ slots: filled(), confidence: 'medium' }), smoqua)).toEqual({
      action: 'confirm',
      reason: 'low_confidence',
    })
  })
})

describe('decide — conflicts', () => {
  it('never commits a conflicted reading, even at exact confidence and a small amount', () => {
    expect(
      decide(interpretation({ slots: filled(), confidence: 'exact', conflicts: ['money'] }), smoqua),
    ).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('confirms when the disagreement was on a dimension axis', () => {
    const result = decide(
      interpretation({ slots: filled(), conflicts: ['dimensions.category'] }),
      smoqua,
    )
    expect(result.action).toBe('confirm')
  })
})

describe('decide — ask', () => {
  it('asks, naming money, when no amount was resolved at all', () => {
    expect(decide(interpretation({ slots: filled({ money: null }) }), smoqua)).toEqual({
      action: 'ask',
      missing: ['money'],
    })
  })

  it('asks when a required dimension axis is missing', () => {
    const result = decide(interpretation({ slots: filled({ dimensions: {} }) }), smoqua)
    expect(result.action).toBe('ask')
    if (result.action === 'ask') expect(axisEntry(result.missing, 'category')).toBeDefined()
  })

  it('does not ask for an optional open_text axis that was never filled', () => {
    expect(decide(interpretation({ slots: slots({ money: rsd(1500) }) }), personal).action).toBe('commit')
  })

  it('lists every missing required slot, not just the first', () => {
    const result = decide(interpretation({ slots: emptySlots() }), smoqua)
    expect(result.action).toBe('ask')
    if (result.action === 'ask') {
      expect(result.missing).toContain('money')
      expect(axisEntry(result.missing, 'category')).toBeDefined()
    }
  })
})

describe('decide — precedence when several rules fire at once', () => {
  it('asks rather than confirms when a required slot is missing and confidence is low', () => {
    const result = decide(interpretation({ slots: filled({ money: null }), confidence: 'low' }), smoqua)
    expect(result.action).toBe('ask')
  })

  it('asks rather than confirms when a required slot is missing and there is a conflict', () => {
    const result = decide(
      interpretation({ slots: filled({ money: null }), conflicts: ['description'] }),
      smoqua,
    )
    expect(result.action).toBe('ask')
  })

  it('confirms when the amount is large and the reading is also conflicted', () => {
    const result = decide(
      interpretation({ slots: filled({ money: eur(5000) }), conflicts: ['money'] }),
      smoqua,
    )
    expect(result.action).toBe('confirm')
    if (result.action === 'confirm') expect(['conflict', 'large_amount']).toContain(result.reason)
  })

  it('confirms when the amount is large and confidence is low', () => {
    const result = decide(
      interpretation({ slots: filled({ money: eur(5000) }), confidence: 'low' }),
      smoqua,
    )
    expect(result.action).toBe('confirm')
    if (result.action === 'confirm') expect(['low_confidence', 'large_amount']).toContain(result.reason)
  })
})
