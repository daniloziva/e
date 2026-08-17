import { describe, it, expect } from 'vitest'

import { extractSlots } from '../../../src/engine/nlu/slots.js'
import type { Slots, SlotExtraction } from '../../../src/engine/nlu/slots.js'
import { interpret } from '../../../src/engine/nlu/interpret.js'
import type { ModelSlots, Interpretation } from '../../../src/engine/nlu/interpret.js'
import { decide } from '../../../src/engine/nlu/confirm-policy.js'
import type { Book, Confidence, DimensionAxisDef, Money } from '../../../src/engine/types.js'

/* ------------------------------------------------------------------ *
 * Fixtures — hand-written, fixed values, no mocking library.
 * The SMOQUA axis set is copied from 05-SMOQUA.md §2.
 * ------------------------------------------------------------------ */

const AXES: DimensionAxisDef[] = [
  {
    axis: 'category',
    type: 'closed_set',
    required: true,
    values: [
      'MATERIALS', 'PACKAGING', 'MARKETING', 'EQUIPMENT', 'RENT',
      'UTILITIES', 'LOGISTICS', 'FEES', 'SERVICES', 'OTHER',
    ],
    aliases: {
      MATERIALS: ['MATERIJAL', 'MAT', 'ROBA', 'SIROVINE'],
      MARKETING: ['REKLAMA', 'ADS', 'PROMO'],
      PACKAGING: ['PAKOVANJE', 'AMBALAZA'],
    },
  },
  { axis: 'project', type: 'open_text', required: false },
  { axis: 'cost_center', type: 'closed_set', required: false, values: [] },
]

const NO_AXES: DimensionAxisDef[] = []

function book(overrides: Partial<Book> = {}): Book {
  return {
    code: 'SMOQUA',
    name: 'SMOQUA',
    senderPhones: ['+381600000002'],
    blobPrefix: 'smoqua',
    defaultCategory: 'expense',
    accountantEmail: null,
    currency: 'RSD',
    dimensions: AXES,
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 50000 },
    ...overrides,
  }
}

function slots(partial: Partial<Slots> = {}): Slots {
  return { money: null, dimensions: {}, description: null, date: null, ...partial }
}

function interpretation(partial: Partial<Interpretation> = {}): Interpretation {
  return {
    slots: slots(),
    confidence: 'exact',
    sources: {},
    conflicts: [],
    ...partial,
  }
}

/** A fully-resolved SMOQUA booking well under the threshold: the commit baseline. */
function goodInterpretation(over: Partial<Interpretation> = {}): Interpretation {
  return interpretation({
    slots: slots({
      money: { amount: 300, currency: 'RSD' },
      dimensions: { category: 'MATERIALS' },
    }),
    sources: { money: 'deterministic', 'dimensions.category': 'deterministic' },
    ...over,
  })
}

const model = (partial: Partial<ModelSlots> = {}): ModelSlots => ({ confidence: 'high', ...partial })

const leftover = (r: SlotExtraction): string => r.leftoverTokens.join(' ')

/* ================================================================== *
 * extractSlots — the deterministic first pass (02 §5.1 row 4, step 1-2)
 * ================================================================== */

describe('extractSlots — amount grammar', () => {
  it.each<[string, Money]>([
    ['4210', { amount: 4210, currency: 'RSD' }],
    ['4.210,00', { amount: 4210, currency: 'RSD' }],
    ['4210.50', { amount: 4210.5, currency: 'RSD' }],
    ['300e', { amount: 300, currency: 'EUR' }],
    ['300€', { amount: 300, currency: 'EUR' }],
    ['300 eur', { amount: 300, currency: 'EUR' }],
    ['300 EVRA', { amount: 300, currency: 'EUR' }],
    ['300 evro', { amount: 300, currency: 'EUR' }],
    ['1500din', { amount: 1500, currency: 'RSD' }],
    ['1.500 rsd', { amount: 1500, currency: 'RSD' }],
    ['12k', { amount: 12000, currency: 'RSD' }],
  ])('parses the amount in %j deterministically, before any model runs', (text, expected) => {
    expect(extractSlots(text, AXES).slots.money).toEqual(expected)
  })

  it('returns no amount for a spelled-out number rather than guessing', () => {
    const r = extractSlots('tri hiljade', AXES)
    expect(r.slots.money).toBeNull()
    expect(leftover(r)).toBe('tri hiljade')
  })

  it('leaves the amount tokens out of the leftovers once the grammar has claimed them', () => {
    expect(extractSlots('MATERIALS 300e', AXES).leftoverTokens).toEqual([])
  })

  it('returns null when two currency-qualified amounts compete', () => {
    const r = extractSlots('MATERIALS 300e 400e', AXES)
    expect(r.slots.money).toBeNull()
    expect(leftover(r)).toContain('300e')
    expect(leftover(r)).toContain('400e')
  })

  it('returns null when two bare numbers compete', () => {
    const r = extractSlots('MATERIALS 300 500', AXES)
    expect(r.slots.money).toBeNull()
  })

  it('returns null when a bare number follows an unqualified amount elsewhere in the message', () => {
    // "Projekat 1" contributes a bare number, so "300" is no longer the only candidate.
    expect(extractSlots('MATERIALS 300 Projekat 1', AXES).slots.money).toBeNull()
  })

  it('prefers a currency-qualified amount over a stray bare number', () => {
    // The flagship case: "200E" wins outright over the "1" in "Projekat 1".
    expect(extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES).slots.money).toEqual({
      amount: 200,
      currency: 'EUR',
    })
  })

  it('never reports a missing amount as zero', () => {
    expect(extractSlots('MATERIALS', AXES).slots.money).toBeNull()
  })
})

describe('extractSlots — dimension resolution', () => {
  it.each<[string, string]>([
    ['MATERIALS 300e', 'MATERIALS'],
    ['materials 300e', 'MATERIALS'],
    ['MATERIJAL 300e', 'MATERIALS'],
    ['ROBA 300e', 'MATERIALS'],
    ['MATERIJAAL 300e', 'MATERIALS'],
    ['REKLAMA 300e', 'MARKETING'],
    ['AMBALAZA 300e', 'PACKAGING'],
    ['AMBALAŽA 300e', 'PACKAGING'],
    ['PACKAGNG 300e', 'PACKAGING'],
  ])('resolves the closed-set axis in %j to %s without a model', (text, expected) => {
    expect(extractSlots(text, AXES).slots.dimensions.category).toBe(expected)
  })

  it('leaves an unrecognised word unresolved rather than silently choosing OTHER', () => {
    const r = extractSlots('KVAKA 300e', AXES)
    expect(r.slots.dimensions.category).toBeUndefined()
    expect(r.leftoverTokens).toContain('KVAKA')
  })

  it('declines to resolve MATERIC, which is not close enough to any known value', () => {
    const r = extractSlots('MATERIC 300e', AXES)
    expect(r.slots.dimensions).toEqual({})
    expect(r.leftoverTokens).toContain('MATERIC')
  })

  it('resolves nothing when the book declares no axes and hands the word to the model', () => {
    const r = extractSlots('MATERIALS 300e', NO_AXES)
    expect(r.slots.dimensions).toEqual({})
    expect(r.leftoverTokens).toContain('MATERIALS')
    expect(r.slots.money).toEqual({ amount: 300, currency: 'EUR' })
  })

  it('does not fill an open_text axis from leftover words — that is the model\'s job', () => {
    const r = extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES)
    expect(r.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(r.slots.dimensions.project).toBeUndefined()
  })

  it('resolves nothing on a closed_set axis declared with an empty value list', () => {
    expect(extractSlots('MATERIALS 300e', AXES).slots.dimensions.cost_center).toBeUndefined()
  })
})

describe('extractSlots — description and date', () => {
  it('never fills description deterministically; free words become leftovers for the model', () => {
    const r = extractSlots('MATERIALS 300e PAMUK', AXES)
    expect(r.slots.description).toBeNull()
    expect(r.leftoverTokens).toContain('PAMUK')
  })

  it('returns a null date when the message carries no date', () => {
    expect(extractSlots('MATERIALS 300e', AXES).slots.date).toBeNull()
  })

  it('parses a Serbian dd.mm.yyyy date into an ISO date and does not mistake it for an amount', () => {
    const r = extractSlots('MATERIALS 300e 11.08.2026', AXES)
    expect(r.slots.date).toBe('2026-08-11')
    expect(r.slots.money).toEqual({ amount: 300, currency: 'EUR' })
  })

  it('returns a null date for an impossible calendar date rather than a rolled-over one', () => {
    expect(extractSlots('MATERIALS 300e 31.02.2026', AXES).slots.date).toBeNull()
  })
})

describe('extractSlots — order tolerance (the property 02 §5.1 names explicitly)', () => {
  it('produces byte-identical output for "300e MATERIALS" and "MATERIALS 300e"', () => {
    expect(extractSlots('300e MATERIALS', AXES)).toEqual(extractSlots('MATERIALS 300e', AXES))
  })

  it.each<[string, string]>([
    ['MATERIJAAL PAMUK 200E Projekat 1', '200E MATERIJAAL PAMUK Projekat 1'],
    ['MATERIJAAL PAMUK 200E Projekat 1', 'PAMUK Projekat 1 200E MATERIJAAL'],
    ['MARKETING 12000 fb ads', '12000 fb ads MARKETING'],
  ])('extracts the same slots from %j and its permutation %j', (a, b) => {
    expect(extractSlots(a, AXES).slots).toEqual(extractSlots(b, AXES).slots)
  })

  it('leaves the same leftover words, whatever the order they arrived in', () => {
    const a = extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES).leftoverTokens
    const b = extractSlots('200E Projekat 1 MATERIJAAL PAMUK', AXES).leftoverTokens
    expect([...a].sort()).toEqual([...b].sort())
  })
})

describe('extractSlots — empty, absent and malformed input', () => {
  it.each<[string, string]>([
    ['empty string', ''],
    ['spaces only', '   '],
    ['a tab and a newline', '\t\n'],
    ['punctuation only', '!!! ...'],
  ])('returns an empty extraction for %s without throwing', (_label, text) => {
    const r = extractSlots(text, AXES)
    expect(r.slots).toEqual({ money: null, dimensions: {}, description: null, date: null })
    expect(r.leftoverTokens).toEqual([])
  })

  it('tolerates repeated whitespace between tokens', () => {
    expect(extractSlots('MATERIALS    300e', AXES).slots).toEqual(
      extractSlots('MATERIALS 300e', AXES).slots,
    )
  })

  it('tolerates trailing punctuation around the tokens', () => {
    expect(extractSlots('MATERIALS, 300e.', AXES).slots).toEqual(
      extractSlots('MATERIALS 300e', AXES).slots,
    )
  })

  it('does not mutate the axis definitions it was given', () => {
    const axes = JSON.parse(JSON.stringify(AXES)) as DimensionAxisDef[]
    extractSlots('MATERIJAAL PAMUK 200E Projekat 1', axes)
    expect(axes).toEqual(AXES)
  })
})

describe('extractSlots — the full worked case from 02 §5.1', () => {
  it('reads "MATERIJAAL PAMUK 200E Projekat 1" as 200 EUR + MATERIALS, leaving PAMUK and Projekat 1', () => {
    const r = extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES)
    expect(r.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(r.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(r.slots.description).toBeNull()
    expect(leftover(r)).toBe('PAMUK Projekat 1')
  })
})

/* ================================================================== *
 * interpret — merge, with the deterministic layer strictly on top
 * ================================================================== */

describe('interpret — the deterministic layer always wins', () => {
  it('keeps the grammar-parsed amount when the model proposes a different one', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      model({ money: { amount: 999, currency: 'EUR' } }),
    )
    expect(r.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(r.sources.money).toBe('deterministic')
    expect(r.conflicts).toContain('money')
  })

  it('keeps the grammar-parsed currency when the model proposes a different one for the same number', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      model({ money: { amount: 200, currency: 'RSD' } }),
    )
    expect(r.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(r.conflicts).toContain('money')
  })

  it('records no conflict when the model happens to agree with the deterministic amount', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      model({ money: { amount: 200, currency: 'EUR' } }),
    )
    expect(r.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(r.sources.money).toBe('deterministic')
    expect(r.conflicts).toEqual([])
  })

  it('keeps the fuzzy-matched dimension when the model proposes a different value on the same axis', () => {
    const r = interpret(
      slots({ dimensions: { category: 'MATERIALS' } }),
      model({ dimensions: { category: 'MARKETING' } }),
    )
    expect(r.slots.dimensions.category).toBe('MATERIALS')
    expect(r.sources['dimensions.category']).toBe('deterministic')
    expect(r.conflicts).toContain('dimensions.category')
  })

  it('keeps a deterministic description over a model description and records the conflict', () => {
    const r = interpret(slots({ description: 'PAMUK' }), model({ description: 'cotton' }))
    expect(r.slots.description).toBe('PAMUK')
    expect(r.conflicts).toContain('description')
  })

  it('keeps a deterministic date over a model date and records the conflict', () => {
    const r = interpret(slots({ date: '2026-08-11' }), model({ date: '2026-08-12' }))
    expect(r.slots.date).toBe('2026-08-11')
    expect(r.conflicts).toContain('date')
  })

  it('records every disagreeing field, not just the first', () => {
    const r = interpret(
      slots({
        money: { amount: 200, currency: 'EUR' },
        dimensions: { category: 'MATERIALS' },
        description: 'PAMUK',
      }),
      model({
        money: { amount: 999, currency: 'EUR' },
        dimensions: { category: 'MARKETING' },
        description: 'cotton',
      }),
    )
    expect([...r.conflicts].sort()).toEqual(['description', 'dimensions.category', 'money'])
  })
})

describe('interpret — the model may only fill gaps', () => {
  it('takes the amount from the model when the grammar declined to parse one', () => {
    const r = interpret(slots(), model({ money: { amount: 3000, currency: 'RSD' } }))
    expect(r.slots.money).toEqual({ amount: 3000, currency: 'RSD' })
    expect(r.sources.money).toBe('model')
    expect(r.conflicts).toEqual([])
  })

  it('takes the description from the model, which is what the model is actually for', () => {
    const r = interpret(slots(), model({ description: 'PAMUK' }))
    expect(r.slots.description).toBe('PAMUK')
    expect(r.sources.description).toBe('model')
  })

  it('fills an untouched axis from the model while keeping the deterministic one', () => {
    const r = interpret(
      slots({ dimensions: { category: 'MATERIALS' } }),
      model({ dimensions: { category: 'MARKETING', project: 'Projekat 1' } }),
    )
    expect(r.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
    expect(r.sources['dimensions.category']).toBe('deterministic')
    expect(r.sources['dimensions.project']).toBe('model')
    expect(r.conflicts).toEqual(['dimensions.category'])
  })

  it('takes a well-formed ISO date from the model', () => {
    const r = interpret(slots(), model({ date: '2026-08-11' }))
    expect(r.slots.date).toBe('2026-08-11')
    expect(r.sources.date).toBe('model')
  })
})

describe('interpret — malformed model output is no answer, never a value', () => {
  it.each<[string, unknown]>([
    ['a non-numeric amount', { amount: '200', currency: 'EUR' }],
    ['NaN', { amount: Number.NaN, currency: 'EUR' }],
    ['Infinity', { amount: Number.POSITIVE_INFINITY, currency: 'EUR' }],
    ['zero', { amount: 0, currency: 'EUR' }],
    ['a negative amount', { amount: -200, currency: 'EUR' }],
    ['an unknown currency', { amount: 200, currency: 'XYZ' }],
    ['an empty currency', { amount: 200, currency: '' }],
    ['a missing currency', { amount: 200 }],
    ['a missing amount', { currency: 'EUR' }],
    ['an explicit null', null],
  ])('drops a model amount with %s', (_label, money) => {
    const r = interpret(slots(), { money, confidence: 'high' } as unknown as ModelSlots)
    expect(r.slots.money).toBeNull()
    expect(r.sources.money).toBeUndefined()
  })

  it('treats a rejected model amount as silence, not as a disagreement with the grammar', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      { money: { amount: Number.NaN, currency: 'ZZZ' }, confidence: 'high' } as unknown as ModelSlots,
    )
    expect(r.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(r.conflicts).toEqual([])
  })

  it.each<[string, unknown]>([
    ['a dotted Serbian date', '11.08.2026'],
    ['a slashed date', '2026/08/11'],
    ['an unpadded date', '2026-8-1'],
    ['a month that does not exist', '2026-13-01'],
    ['a day that does not exist', '2026-02-30'],
    ['prose', 'juce'],
    ['an empty string', ''],
    ['a number', 20260811],
  ])('drops a model date given as %s', (_label, date) => {
    const r = interpret(slots(), { date, confidence: 'high' } as unknown as ModelSlots)
    expect(r.slots.date).toBeNull()
    expect(r.sources.date).toBeUndefined()
  })

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
  ])('drops a model description given as %s', (_label, description) => {
    const r = interpret(slots(), { description, confidence: 'high' } as unknown as ModelSlots)
    expect(r.slots.description).toBeNull()
    expect(r.sources.description).toBeUndefined()
  })

  it('drops a model dimension whose value is an empty string', () => {
    const r = interpret(slots(), model({ dimensions: { project: '' } }))
    expect(r.slots.dimensions).toEqual({})
    expect(r.sources['dimensions.project']).toBeUndefined()
  })

  it('discards the whole model payload when its confidence field is not a known level', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      { description: 'PAMUK', confidence: 'very high' } as unknown as ModelSlots,
    )
    expect(r.slots.description).toBeNull()
    expect(r.sources.description).toBeUndefined()
  })

  it('discards the whole model payload when the confidence field is missing entirely', () => {
    const r = interpret(slots(), { description: 'PAMUK' } as unknown as ModelSlots)
    expect(r.slots.description).toBeNull()
  })

  it('keeps the good model fields when only one field is malformed', () => {
    const r = interpret(
      slots(),
      { money: { amount: 0, currency: 'EUR' }, description: 'PAMUK', confidence: 'high' } as unknown as ModelSlots,
    )
    expect(r.slots.money).toBeNull()
    expect(r.slots.description).toBe('PAMUK')
  })
})

describe('interpret — absent model, absent slots, provenance', () => {
  it('returns the deterministic slots untouched when there is no model answer at all', () => {
    const d = slots({ money: { amount: 300, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } })
    const r = interpret(d, null)
    expect(r.slots).toEqual(d)
    expect(r.conflicts).toEqual([])
  })

  it('reports exact confidence when every filled slot came from the deterministic layer', () => {
    const r = interpret(slots({ money: { amount: 300, currency: 'EUR' } }), null)
    expect(r.confidence).toBe('exact')
  })

  it('returns an empty interpretation when nothing was extracted and no model ran', () => {
    const r = interpret(slots(), null)
    expect(r.slots).toEqual({ money: null, dimensions: {}, description: null, date: null })
    expect(r.sources).toEqual({})
    expect(r.conflicts).toEqual([])
    expect(r.confidence).toBe('exact')
  })

  it('records a source for every filled slot and for nothing else', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }),
      model({ description: 'PAMUK' }),
    )
    expect(Object.keys(r.sources).sort()).toEqual(['description', 'dimensions.category', 'money'])
  })

  it.each<[Confidence, Confidence]>([
    ['exact', 'exact'],
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low'],
  ])('reports %s confidence when a model field of that confidence was used', (given, expected) => {
    const r = interpret(slots({ money: { amount: 200, currency: 'EUR' } }), model({ description: 'PAMUK', confidence: given }))
    expect(r.confidence).toBe(expected)
  })

  it('stays exact when the model was low confidence but none of its values were used', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' } }),
      model({ money: { amount: 999, currency: 'EUR' }, confidence: 'low' }),
    )
    expect(r.confidence).toBe('exact')
  })

  it('does not mutate the deterministic slots it was handed', () => {
    const d = slots({ money: { amount: 200, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } })
    const before = JSON.parse(JSON.stringify(d)) as Slots
    interpret(d, model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' } }))
    expect(d).toEqual(before)
  })

  it('merges the full worked case into 200 EUR, MATERIALS, PAMUK and Projekat 1', () => {
    const r = interpret(
      slots({ money: { amount: 200, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }),
      model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' }, confidence: 'high' }),
    )
    expect(r.slots).toEqual({
      money: { amount: 200, currency: 'EUR' },
      dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
      description: 'PAMUK',
      date: null,
    })
    expect(r.sources.money).toBe('deterministic')
    expect(r.sources.description).toBe('model')
    expect(r.conflicts).toEqual([])
    expect(r.confidence).toBe('high')
  })
})

/* ================================================================== *
 * decide — commit / confirm / ask
 * ================================================================== */

describe('decide — commit', () => {
  it('commits when every required slot is deterministic and the amount is small', () => {
    expect(decide(goodInterpretation(), book())).toEqual({ action: 'commit' })
  })

  it('commits when the model filled the gaps with high confidence and nothing conflicted', () => {
    const i = goodInterpretation({
      confidence: 'high',
      slots: slots({
        money: { amount: 300, currency: 'RSD' },
        dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
        description: 'PAMUK',
      }),
      sources: {
        money: 'deterministic',
        'dimensions.category': 'deterministic',
        'dimensions.project': 'model',
        description: 'model',
      },
    })
    expect(decide(i, book())).toEqual({ action: 'commit' })
  })

  it('commits without a description, which is never required', () => {
    expect(decide(goodInterpretation({ slots: slots({ money: { amount: 300, currency: 'RSD' }, dimensions: { category: 'MATERIALS' }, description: null }) }), book()))
      .toEqual({ action: 'commit' })
  })

  it('commits without a date, which is never required', () => {
    expect(decide(goodInterpretation(), book()).action).toBe('commit')
  })

  it('commits without an optional axis being filled', () => {
    const b = book()
    expect(b.dimensions.find((a) => a.axis === 'project')?.required).toBe(false)
    expect(decide(goodInterpretation(), b)).toEqual({ action: 'commit' })
  })

  it('commits an amount-only booking for a book that declares no required axes', () => {
    const i = interpretation({
      slots: slots({ money: { amount: 800, currency: 'RSD' } }),
      sources: { money: 'deterministic' },
    })
    expect(decide(i, book({ code: 'PERSONAL', dimensions: [] }))).toEqual({ action: 'commit' })
  })

  it('commits the flagship 200 EUR cotton booking', () => {
    const i = interpretation({
      confidence: 'high',
      slots: slots({
        money: { amount: 200, currency: 'EUR' },
        dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
        description: 'PAMUK',
      }),
      sources: { money: 'deterministic', 'dimensions.category': 'deterministic' },
    })
    expect(decide(i, book())).toEqual({ action: 'commit' })
  })
})

describe('decide — the book amount threshold, at the boundary exactly', () => {
  const b = book({ features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 50000 } })

  it('commits one cent below the threshold', () => {
    const i = goodInterpretation({ slots: slots({ money: { amount: 49999.99, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, b)).toEqual({ action: 'commit' })
  })

  it('requires a confirmation exactly at the threshold', () => {
    const i = goodInterpretation({ slots: slots({ money: { amount: 50000, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, b)).toEqual({ action: 'confirm', reason: 'large_amount' })
  })

  it('requires a confirmation one cent above the threshold', () => {
    const i = goodInterpretation({ slots: slots({ money: { amount: 50000.01, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, b)).toEqual({ action: 'confirm', reason: 'large_amount' })
  })

  it('requires a confirmation for every amount when the threshold is zero', () => {
    const zero = book({ features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 0 } })
    const i = goodInterpretation({ slots: slots({ money: { amount: 1, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, zero)).toEqual({ action: 'confirm', reason: 'large_amount' })
  })
})

describe('decide — confidence', () => {
  it.each<[Confidence, 'commit' | 'confirm']>([
    ['exact', 'commit'],
    ['high', 'commit'],
    ['medium', 'confirm'],
    ['low', 'confirm'],
  ])('decides %s confidence means %s', (confidence, action) => {
    expect(decide(goodInterpretation({ confidence }), book()).action).toBe(action)
  })

  it('names low confidence as the reason for the tap', () => {
    expect(decide(goodInterpretation({ confidence: 'low' }), book())).toEqual({
      action: 'confirm',
      reason: 'low_confidence',
    })
  })
})

describe('decide — conflicts', () => {
  it('requires a confirmation when the model contradicted the grammar, even though the grammar won', () => {
    const i = goodInterpretation({ conflicts: ['money'] })
    expect(decide(i, book())).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('requires a confirmation when two candidate dimensions disagreed', () => {
    const i = goodInterpretation({ conflicts: ['dimensions.category'] })
    expect(decide(i, book())).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('confirms rather than committing when several confirm triggers coincide', () => {
    const i = goodInterpretation({
      confidence: 'low',
      conflicts: ['money'],
      slots: slots({ money: { amount: 90000, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }),
    })
    expect(decide(i, book()).action).toBe('confirm')
  })
})

describe('decide — ask, when a required slot is missing entirely', () => {
  it('asks for the amount when no layer produced one', () => {
    const i = interpretation({ slots: slots({ dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, book())).toEqual({ action: 'ask', missing: ['money'] })
  })

  it('asks for a required dimension axis rather than defaulting it to OTHER', () => {
    const i = interpretation({ slots: slots({ money: { amount: 300, currency: 'RSD' } }) })
    expect(decide(i, book())).toEqual({ action: 'ask', missing: ['dimensions.category'] })
  })

  it('asks for every missing required slot at once', () => {
    const d = decide(interpretation(), book())
    expect(d.action).toBe('ask')
    expect([...(d as { missing: string[] }).missing].sort()).toEqual(['dimensions.category', 'money'])
  })

  it('asks rather than confirms when a required slot is missing and confidence is low', () => {
    const i = interpretation({ confidence: 'low', slots: slots({ dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, book())).toEqual({ action: 'ask', missing: ['money'] })
  })

  it('asks rather than confirms when a required slot is missing and a field conflicted', () => {
    const i = interpretation({ conflicts: ['description'], slots: slots({ dimensions: { category: 'MATERIALS' } }) })
    expect(decide(i, book()).action).toBe('ask')
  })

  it('treats an empty-string dimension value as a missing required axis', () => {
    const i = interpretation({
      slots: slots({ money: { amount: 300, currency: 'RSD' }, dimensions: { category: '' } }),
    })
    expect(decide(i, book())).toEqual({ action: 'ask', missing: ['dimensions.category'] })
  })

  it('does not ask for an optional axis that is missing', () => {
    const d = decide(interpretation({ slots: slots({ dimensions: { category: 'MATERIALS' } }) }), book())
    expect((d as { missing?: string[] }).missing).toEqual(['money'])
  })
})

/* ================================================================== *
 * The three modules together on the message the whole design is for
 * ================================================================== */

describe('the pipeline on "MATERIJAAL PAMUK 200E Projekat 1"', () => {
  it('extracts, merges and commits it in one pass with the grammar amount intact', () => {
    const extracted = extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES)
    const merged = interpret(
      extracted.slots,
      model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' }, confidence: 'high' }),
    )
    expect(merged.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(merged.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
    expect(merged.slots.description).toBe('PAMUK')
    expect(decide(merged, book())).toEqual({ action: 'commit' })
  })

  it('still books 200 EUR when the model hallucinates a different amount, and asks for a tap', () => {
    const extracted = extractSlots('MATERIJAAL PAMUK 200E Projekat 1', AXES)
    const merged = interpret(
      extracted.slots,
      model({ money: { amount: 20000, currency: 'RSD' }, description: 'PAMUK', confidence: 'high' }),
    )
    expect(merged.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(decide(merged, book())).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('asks for the category when the model returns nothing usable and the word was unrecognisable', () => {
    const extracted = extractSlots('KVAKA 300e', AXES)
    const merged = interpret(extracted.slots, null)
    expect(decide(merged, book())).toEqual({ action: 'ask', missing: ['dimensions.category'] })
  })
})
