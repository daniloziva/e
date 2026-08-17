import { describe, it, expect } from 'vitest'

import { extractSlots } from '../../../src/engine/nlu/slots.js'
import type { Slots } from '../../../src/engine/nlu/slots.js'
import { interpret } from '../../../src/engine/nlu/interpret.js'
import type { ModelSlots } from '../../../src/engine/nlu/interpret.js'
import { decide } from '../../../src/engine/nlu/confirm-policy.js'
import type { Book, Confidence, DimensionAxisDef, Money } from '../../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Fixtures — hand-written, no mocking library. None of the three functions
// under test take an injected dependency, so there is no Clock/IdGen to fake:
// that absence is itself part of the contract (see the "date" refusals below).
// ---------------------------------------------------------------------------

/** SMOQUA's axes: one closed set that gets fuzzy matching, one open text axis. */
const SMOQUA_AXES: DimensionAxisDef[] = [
  {
    axis: 'category',
    type: 'closed_set',
    required: true,
    values: ['MATERIALS', 'MARKETING', 'TRANSPORT'],
    aliases: {
      MATERIALS: ['MATERIJAL', 'MATERIJALI'],
      TRANSPORT: ['PREVOZ'],
    },
  },
  { axis: 'project', type: 'open_text', required: false },
]

/** A closed set built so that one token sits at the same edit distance from two values. */
const AMBIGUOUS_AXES: DimensionAxisDef[] = [
  { axis: 'category', type: 'closed_set', required: true, values: ['MAX', 'MAXIM'] },
]

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    code: 'SMOQUA',
    name: 'Smoqua',
    senderPhones: ['+381600000001'],
    blobPrefix: 'smoqua/',
    defaultCategory: 'expense',
    accountantEmail: null,
    currency: 'EUR',
    dimensions: SMOQUA_AXES,
    features: {
      sef: false,
      invoicing: false,
      vat: null,
      confirmAboveAmount: 1000,
    },
    ...overrides,
  } as Book
}

/** A book with no required axes at all — money is then the only required slot. */
function makeBookWithoutRequiredAxes(confirmAboveAmount = 1000): Book {
  return makeBook({
    code: 'PERSONAL',
    currency: 'RSD',
    dimensions: [{ axis: 'project', type: 'open_text', required: false }],
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount },
  })
}

function det(overrides: Partial<Slots> = {}): Slots {
  return { money: null, dimensions: {}, description: null, date: null, ...overrides }
}

function model(overrides: Partial<ModelSlots> = {}): ModelSlots {
  return { confidence: 'high', ...overrides }
}

const EUR200: Money = { amount: 200, currency: 'EUR' }

/** A complete, conflict-free interpretation — the baseline every decide() case perturbs. */
function interpretation(overrides: Partial<ReturnType<typeof baseInterpretation>> = {}) {
  return { ...baseInterpretation(), ...overrides }
}

function baseInterpretation() {
  return {
    slots: det({ money: EUR200, dimensions: { category: 'MATERIALS' } }),
    confidence: 'exact' as Confidence,
    sources: { money: 'deterministic', category: 'deterministic' } as Record<
      string,
      'deterministic' | 'model'
    >,
    conflicts: [] as string[],
  }
}

// ===========================================================================
// extractSlots — the deterministic first pass. Whatever it returns is
// authoritative (02 §5.1) and no model may overwrite it.
// ===========================================================================

describe('extractSlots — order tolerance', () => {
  it.each([
    ['amount first', '300e MATERIALS'],
    ['dimension first', 'MATERIALS 300e'],
    ['amount first, extra whitespace', '  300e   MATERIALS  '],
  ])('extracts the same slots when the input is written %s', (_label, text) => {
    const result = extractSlots(text, SMOQUA_AXES)

    expect(result.slots.money).toEqual({ amount: 300, currency: 'EUR' })
    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(result.leftoverTokens).toEqual([])
  })

  it('produces byte-identical output for "300e MATERIALS" and "MATERIALS 300e"', () => {
    expect(extractSlots('300e MATERIALS', SMOQUA_AXES)).toEqual(
      extractSlots('MATERIALS 300e', SMOQUA_AXES),
    )
  })
})

describe('extractSlots — the amount grammar inside a sentence', () => {
  it.each([
    ['MATERIALS 300e', 300, 'EUR'],
    ['MATERIALS 300€', 300, 'EUR'],
    ['MATERIALS 300 eur', 300, 'EUR'],
    ['MATERIALS 300 EVRA', 300, 'EUR'],
    ['MATERIALS 4.210,00', 4210, 'RSD'],
    ['MATERIALS 4210.50', 4210.5, 'RSD'],
    ['MATERIALS 1500din', 1500, 'RSD'],
    ['MATERIALS 12k', 12000, 'RSD'],
  ])('extracts %s as %s %s', (text, amount, currency) => {
    expect(extractSlots(text, SMOQUA_AXES).slots.money).toEqual({ amount, currency })
  })

  it('leaves no leftover token behind when a two-word amount is consumed', () => {
    const result = extractSlots('MATERIALS 300 EVRA', SMOQUA_AXES)

    expect(result.leftoverTokens).toEqual([])
  })
})

describe('extractSlots — refusals around the amount', () => {
  it('returns no amount when the number is written as words', () => {
    const result = extractSlots('MATERIALS tri hiljade', SMOQUA_AXES)

    expect(result.slots.money).toBeNull()
    expect(result.leftoverTokens.join(' ')).toBe('tri hiljade')
  })

  it('returns null when the amount is ambiguous because two currency-marked amounts are present', () => {
    const result = extractSlots('MATERIALS 300e 400e', SMOQUA_AXES)

    expect(result.slots.money).toBeNull()
    expect(result.leftoverTokens.join(' ')).toContain('300e')
    expect(result.leftoverTokens.join(' ')).toContain('400e')
  })

  it('still resolves the dimension when it refuses the amount', () => {
    const result = extractSlots('MATERIALS 300e 400e', SMOQUA_AXES)

    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
  })

  it('does not treat a bare number that trails an open-text phrase as a competing amount', () => {
    const result = extractSlots('MATERIALS 300e Projekat 1', SMOQUA_AXES)

    expect(result.slots.money).toEqual({ amount: 300, currency: 'EUR' })
  })

  it('does not read a dotted calendar date as a Serbian-formatted amount', () => {
    const result = extractSlots('MATERIALS 15.03.2026', SMOQUA_AXES)

    expect(result.slots.money).toBeNull()
  })
})

describe('extractSlots — dimension resolution', () => {
  it('resolves a closed-set value written exactly', () => {
    expect(extractSlots('MATERIALS 300e', SMOQUA_AXES).slots.dimensions).toEqual({
      category: 'MATERIALS',
    })
  })

  it('resolves a declared alias to its canonical value', () => {
    expect(extractSlots('MATERIJAL 300e', SMOQUA_AXES).slots.dimensions).toEqual({
      category: 'MATERIALS',
    })
  })

  it.each([
    ['lowercase', 'materials 300e'],
    ['mixed case', 'MaTeRiAlS 300e'],
    ['diacritics on an alias', 'prevoz 300e'],
  ])('matches case- and diacritic-insensitively (%s)', (_label, text) => {
    const dimensions = extractSlots(text, SMOQUA_AXES).slots.dimensions

    expect(Object.values(dimensions).length).toBe(1)
  })

  it('resolves a typo within edit distance 2 without a model', () => {
    expect(extractSlots('MATERIJAAL 300e', SMOQUA_AXES).slots.dimensions).toEqual({
      category: 'MATERIALS',
    })
  })

  it('refuses to guess a token further than edit distance 2 from every candidate', () => {
    const result = extractSlots('MATERIC 300e', SMOQUA_AXES)

    expect(result.slots.dimensions).toEqual({})
    expect(result.leftoverTokens).toContain('MATERIC')
  })

  it('never silently falls back to OTHER for an unknown dimension word', () => {
    const result = extractSlots('GLURP 300e', SMOQUA_AXES)

    expect(result.slots.dimensions).toEqual({})
    expect(Object.values(result.slots.dimensions)).not.toContain('OTHER')
  })

  it('returns null rather than guessing when a token is equidistant from two candidates', () => {
    const result = extractSlots('MAXI 300e', AMBIGUOUS_AXES)

    expect(result.slots.dimensions).toEqual({})
    expect(result.leftoverTokens).toContain('MAXI')
  })

  it('does not deterministically claim an open-text axis — those words go to the model', () => {
    const result = extractSlots('MATERIALS 300e Projekat 1', SMOQUA_AXES)

    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(result.leftoverTokens.join(' ')).toBe('Projekat 1')
  })

  it('resolves nothing and keeps every word when the book declares no axes', () => {
    const result = extractSlots('MATERIALS 300e', [])

    expect(result.slots.dimensions).toEqual({})
    expect(result.slots.money).toEqual({ amount: 300, currency: 'EUR' })
    expect(result.leftoverTokens).toEqual(['MATERIALS'])
  })
})

describe('extractSlots — description is never claimed deterministically', () => {
  it('leaves free-text words as leftovers instead of guessing a description', () => {
    const result = extractSlots('MATERIALS 300e PAMUK', SMOQUA_AXES)

    expect(result.slots.description).toBeNull()
    expect(result.leftoverTokens).toEqual(['PAMUK'])
  })

  it('returns a null description even when the text is nothing but prose', () => {
    const result = extractSlots('rucak sa klijentom', SMOQUA_AXES)

    expect(result.slots.description).toBeNull()
    expect(result.slots.money).toBeNull()
    expect(result.leftoverTokens.join(' ')).toBe('rucak sa klijentom')
  })
})

describe('extractSlots — dates', () => {
  it('extracts a fully written Serbian date as an ISO date', () => {
    expect(extractSlots('MATERIALS 300e 15.03.2026', SMOQUA_AXES).slots.date).toBe('2026-03-15')
  })

  it('accepts an ISO date as written', () => {
    expect(extractSlots('MATERIALS 300e 2026-03-15', SMOQUA_AXES).slots.date).toBe('2026-03-15')
  })

  it('consumes the date token rather than leaving it for the model', () => {
    expect(extractSlots('MATERIALS 300e 15.03.2026', SMOQUA_AXES).leftoverTokens).toEqual([])
  })

  it('returns null for a relative date word, because core is given no clock', () => {
    const result = extractSlots('MATERIALS 300e juce', SMOQUA_AXES)

    expect(result.slots.date).toBeNull()
    expect(result.leftoverTokens).toContain('juce')
  })

  it('returns null for a day-and-month with no year rather than assuming the current one', () => {
    expect(extractSlots('MATERIALS 300e 11.08.', SMOQUA_AXES).slots.date).toBeNull()
  })

  it('returns null for an impossible calendar date', () => {
    expect(extractSlots('MATERIALS 300e 32.13.2026', SMOQUA_AXES).slots.date).toBeNull()
  })

  it('returns a null date when the text contains no date at all', () => {
    expect(extractSlots('MATERIALS 300e', SMOQUA_AXES).slots.date).toBeNull()
  })
})

describe('extractSlots — empty and absent input', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \t  '],
    ['newlines only', '\n\n'],
  ])('returns empty slots and no leftovers for %s', (_label, text) => {
    const result = extractSlots(text, SMOQUA_AXES)

    expect(result.slots).toEqual({ money: null, dimensions: {}, description: null, date: null })
    expect(result.leftoverTokens).toEqual([])
  })

  it('returns empty slots for punctuation that carries no slot', () => {
    const result = extractSlots('...', SMOQUA_AXES)

    expect(result.slots.money).toBeNull()
    expect(result.slots.dimensions).toEqual({})
  })
})

describe('extractSlots — the worked case from 02 §5.1', () => {
  const WORKED = 'MATERIJAAL PAMUK 200E Projekat 1'

  it('parses 200E as 200 EUR from the grammar, before any model is asked', () => {
    expect(extractSlots(WORKED, SMOQUA_AXES).slots.money).toEqual({ amount: 200, currency: 'EUR' })
  })

  it('fuzzy-matches MATERIJAAL to MATERIALS without a model', () => {
    expect(extractSlots(WORKED, SMOQUA_AXES).slots.dimensions).toEqual({ category: 'MATERIALS' })
  })

  it('hands exactly PAMUK and Projekat 1 to the model as leftovers', () => {
    expect(extractSlots(WORKED, SMOQUA_AXES).leftoverTokens.join(' ')).toBe('PAMUK Projekat 1')
  })

  it('never puts the amount or the matched dimension in front of the model', () => {
    const leftovers = extractSlots(WORKED, SMOQUA_AXES).leftoverTokens.join(' ').toUpperCase()

    expect(leftovers).not.toContain('200')
    expect(leftovers).not.toContain('MATERIJAAL')
  })
})

// ===========================================================================
// interpret — merge. A deterministic slot ALWAYS beats a model slot, and the
// disagreement is recorded. Malformed model output is NO ANSWER, not a value.
// ===========================================================================

describe('interpret — with no model answer at all', () => {
  it('returns the deterministic slots unchanged when the model was never called', () => {
    const result = interpret(det({ money: EUR200, dimensions: { category: 'MATERIALS' } }), null)

    expect(result.slots.money).toEqual(EUR200)
    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(result.conflicts).toEqual([])
  })

  it('marks every filled field as deterministic when there is no model answer', () => {
    const result = interpret(det({ money: EUR200, dimensions: { category: 'MATERIALS' } }), null)

    expect(result.sources).toEqual({ money: 'deterministic', category: 'deterministic' })
  })

  it('reports exact confidence when nothing came from a model', () => {
    expect(interpret(det({ money: EUR200 }), null).confidence).toBe('exact')
  })

  it('records no source for a field nobody filled', () => {
    const result = interpret(det(), null)

    expect(result.sources).toEqual({})
    expect(result.slots).toEqual({ money: null, dimensions: {}, description: null, date: null })
  })
})

describe('interpret — the model may only fill gaps', () => {
  it('takes the model description when the deterministic pass left it empty', () => {
    const result = interpret(
      det({ money: EUR200, dimensions: { category: 'MATERIALS' } }),
      model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' } }),
    )

    expect(result.slots.description).toBe('PAMUK')
    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
  })

  it('records per-field provenance when the two layers each filled something', () => {
    const result = interpret(
      det({ money: EUR200, dimensions: { category: 'MATERIALS' } }),
      model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' } }),
    )

    expect(result.sources).toEqual({
      money: 'deterministic',
      category: 'deterministic',
      description: 'model',
      project: 'model',
    })
  })

  it('adopts the model confidence once the model contributed a field', () => {
    const result = interpret(det({ money: EUR200 }), model({ description: 'PAMUK', confidence: 'medium' }))

    expect(result.confidence).toBe('medium')
  })

  it('stays exact when the model answered but contributed nothing new', () => {
    const result = interpret(det({ money: EUR200 }), model({ confidence: 'low' }))

    expect(result.confidence).toBe('exact')
    expect(result.sources).toEqual({ money: 'deterministic' })
  })

  it('takes a model amount when the grammar declined to parse one', () => {
    const result = interpret(det(), model({ money: { amount: 3000, currency: 'RSD' } }))

    expect(result.slots.money).toEqual({ amount: 3000, currency: 'RSD' })
    expect(result.sources).toEqual({ money: 'model' })
    expect(result.conflicts).toEqual([])
  })

  it('takes a model date when the grammar found none', () => {
    const result = interpret(det({ money: EUR200 }), model({ date: '2026-03-15' }))

    expect(result.slots.date).toBe('2026-03-15')
    expect(result.sources.date).toBe('model')
  })
})

describe('interpret — a deterministic slot always beats a model slot', () => {
  it('keeps the parsed amount when the model proposes a different one', () => {
    const result = interpret(det({ money: EUR200 }), model({ money: { amount: 20000, currency: 'RSD' } }))

    expect(result.slots.money).toEqual(EUR200)
    expect(result.sources.money).toBe('deterministic')
  })

  it('records the field name when it overrules the model on the amount', () => {
    const result = interpret(det({ money: EUR200 }), model({ money: { amount: 20000, currency: 'RSD' } }))

    expect(result.conflicts).toEqual(['money'])
  })

  it('treats the same amount in a different currency as a conflict', () => {
    const result = interpret(det({ money: EUR200 }), model({ money: { amount: 200, currency: 'RSD' } }))

    expect(result.slots.money).toEqual(EUR200)
    expect(result.conflicts).toEqual(['money'])
  })

  it('records no conflict when the model happens to agree exactly', () => {
    const result = interpret(det({ money: EUR200 }), model({ money: { amount: 200, currency: 'EUR' } }))

    expect(result.slots.money).toEqual(EUR200)
    expect(result.sources.money).toBe('deterministic')
    expect(result.conflicts).toEqual([])
  })

  it('keeps the fuzzy-matched dimension when the model proposes another value on the same axis', () => {
    const result = interpret(
      det({ dimensions: { category: 'MATERIALS' } }),
      model({ dimensions: { category: 'MARKETING' } }),
    )

    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(result.conflicts).toEqual(['category'])
  })

  it('records no conflict when the model repeats the dimension the grammar already resolved', () => {
    const result = interpret(
      det({ dimensions: { category: 'MATERIALS' } }),
      model({ dimensions: { category: 'MATERIALS' } }),
    )

    expect(result.conflicts).toEqual([])
    expect(result.sources.category).toBe('deterministic')
  })

  it('keeps a deterministic description over a model description', () => {
    const result = interpret(det({ description: 'parking' }), model({ description: 'rucak' }))

    expect(result.slots.description).toBe('parking')
    expect(result.conflicts).toEqual(['description'])
  })

  it('keeps a deterministic date over a model date', () => {
    const result = interpret(det({ date: '2026-03-15' }), model({ date: '2026-03-16' }))

    expect(result.slots.date).toBe('2026-03-15')
    expect(result.conflicts).toEqual(['date'])
  })

  it('records every disagreeing field, not just the first', () => {
    const result = interpret(
      det({ money: EUR200, dimensions: { category: 'MATERIALS' }, date: '2026-03-15' }),
      model({
        money: { amount: 20000, currency: 'RSD' },
        dimensions: { category: 'MARKETING' },
        date: '2026-01-01',
      }),
    )

    expect([...result.conflicts].sort()).toEqual(['category', 'date', 'money'])
  })

  it('merges a second axis from the model while overruling it on the first', () => {
    const result = interpret(
      det({ dimensions: { category: 'MATERIALS' } }),
      model({ dimensions: { category: 'MARKETING', project: 'Projekat 1' } }),
    )

    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
    expect(result.conflicts).toEqual(['category'])
    expect(result.sources).toEqual({ category: 'deterministic', project: 'model' })
  })
})

describe('interpret — malformed model output is no answer, never a value', () => {
  const badMoney: Array<{ name: string; money: unknown }> = [
    { name: 'the amount is not a number', money: { amount: '200', currency: 'EUR' } },
    { name: 'the amount is NaN', money: { amount: Number.NaN, currency: 'EUR' } },
    { name: 'the amount is Infinity', money: { amount: Number.POSITIVE_INFINITY, currency: 'EUR' } },
    { name: 'the amount is zero', money: { amount: 0, currency: 'EUR' } },
    { name: 'the amount is negative', money: { amount: -200, currency: 'EUR' } },
    { name: 'the currency is not a known code', money: { amount: 200, currency: 'XYZ' } },
    { name: 'the currency is empty', money: { amount: 200, currency: '' } },
    { name: 'the currency is missing', money: { amount: 200 } },
    { name: 'the amount is missing', money: { currency: 'EUR' } },
    { name: 'money is not an object', money: 'two hundred euro' },
    { name: 'money is an empty object', money: {} },
  ]

  it.each(badMoney)('leaves the amount empty when $name', ({ money }) => {
    const result = interpret(det(), { money, confidence: 'high' } as unknown as ModelSlots)

    expect(result.slots.money).toBeNull()
    expect(result.sources).not.toHaveProperty('money')
    expect(result.conflicts).toEqual([])
  })

  it.each(badMoney)('does not disturb the deterministic amount when $name', ({ money }) => {
    const result = interpret(det({ money: EUR200 }), {
      money,
      confidence: 'high',
    } as unknown as ModelSlots)

    expect(result.slots.money).toEqual(EUR200)
    expect(result.sources.money).toBe('deterministic')
    expect(result.conflicts).toEqual([])
  })

  it('rejects a bad amount without discarding a valid description in the same answer', () => {
    const result = interpret(det(), {
      money: { amount: 'lots', currency: 'EUR' },
      description: 'PAMUK',
      confidence: 'high',
    } as unknown as ModelSlots)

    expect(result.slots.money).toBeNull()
    expect(result.slots.description).toBe('PAMUK')
    expect(result.sources).toEqual({ description: 'model' })
  })

  it('accepts a well-formed model amount whose currency code differs only in case', () => {
    const result = interpret(det(), {
      money: { amount: 200, currency: 'eur' },
      confidence: 'high',
    } as unknown as ModelSlots)

    expect(result.slots.money).toEqual({ amount: 200, currency: 'EUR' })
  })

  it('treats an explicit null money from the model as no answer', () => {
    const result = interpret(det(), model({ money: null }))

    expect(result.slots.money).toBeNull()
    expect(result.conflicts).toEqual([])
  })

  const badDimensions: Array<{ name: string; dimensions: unknown }> = [
    { name: 'dimensions is a string', dimensions: 'MATERIALS' },
    { name: 'dimensions is an array', dimensions: ['MATERIALS'] },
    { name: 'dimensions is null', dimensions: null },
  ]

  it.each(badDimensions)('ignores the whole dimension map when $name', ({ dimensions }) => {
    const result = interpret(det(), { dimensions, confidence: 'high' } as unknown as ModelSlots)

    expect(result.slots.dimensions).toEqual({})
    expect(result.sources).toEqual({})
  })

  const badAxisValues: Array<{ name: string; value: unknown }> = [
    { name: 'the value is an empty string', value: '' },
    { name: 'the value is whitespace only', value: '   ' },
    { name: 'the value is null', value: null },
    { name: 'the value is a number', value: 42 },
    { name: 'the value is an object', value: { name: 'Projekat 1' } },
  ]

  it.each(badAxisValues)('drops a single axis when $name', ({ value }) => {
    const result = interpret(det(), {
      dimensions: { project: value, category: 'MATERIALS' },
      confidence: 'high',
    } as unknown as ModelSlots)

    expect(result.slots.dimensions).toEqual({ category: 'MATERIALS' })
    expect(result.sources).toEqual({ category: 'model' })
  })

  const badDescriptions: Array<{ name: string; description: unknown }> = [
    { name: 'it is an empty string', description: '' },
    { name: 'it is whitespace only', description: '  \t ' },
    { name: 'it is not a string', description: 12 },
  ]

  it.each(badDescriptions)('leaves the description empty when $name', ({ description }) => {
    const result = interpret(det(), { description, confidence: 'high' } as unknown as ModelSlots)

    expect(result.slots.description).toBeNull()
    expect(result.sources).not.toHaveProperty('description')
  })

  const badDates: Array<{ name: string; date: unknown }> = [
    { name: 'it is prose', date: 'yesterday' },
    { name: 'it is not ISO order', date: '15.03.2026' },
    { name: 'the month does not exist', date: '2026-13-01' },
    { name: 'the day does not exist', date: '2026-02-30' },
    { name: 'it is an empty string', date: '' },
    { name: 'it is a number', date: 20260315 },
  ]

  it.each(badDates)('leaves the date empty when $name', ({ date }) => {
    const result = interpret(det(), { date, confidence: 'high' } as unknown as ModelSlots)

    expect(result.slots.date).toBeNull()
    expect(result.sources).not.toHaveProperty('date')
  })

  it.each([['banana'], [''], [null], [undefined], [3]])(
    'discards the entire model answer when the confidence field is %s',
    (confidence) => {
      const result = interpret(det({ money: EUR200 }), {
        description: 'PAMUK',
        dimensions: { project: 'Projekat 1' },
        confidence,
      } as unknown as ModelSlots)

      expect(result.slots.description).toBeNull()
      expect(result.slots.dimensions).toEqual({})
      expect(result.sources).toEqual({ money: 'deterministic' })
    },
  )

  it('reports exact confidence after discarding an unusable model answer', () => {
    const result = interpret(det({ money: EUR200 }), {
      description: 'PAMUK',
      confidence: 'banana',
    } as unknown as ModelSlots)

    expect(result.confidence).toBe('exact')
  })

  it('does not mutate the deterministic slots it was given', () => {
    const deterministic = det({ money: EUR200, dimensions: { category: 'MATERIALS' } })
    interpret(deterministic, model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' } }))

    expect(deterministic).toEqual(det({ money: EUR200, dimensions: { category: 'MATERIALS' } }))
  })
})

describe('interpret — the worked case from 02 §5.1, end to end', () => {
  const deterministic = det({ money: EUR200, dimensions: { category: 'MATERIALS' } })
  const modelAnswer = model({
    description: 'PAMUK',
    dimensions: { project: 'Projekat 1' },
    confidence: 'high',
  })

  it('books 200 EUR from the grammar, MATERIALS by fuzzy match, PAMUK and Projekat 1 from the model', () => {
    const result = interpret(deterministic, modelAnswer)

    expect(result.slots).toEqual({
      money: { amount: 200, currency: 'EUR' },
      dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
      description: 'PAMUK',
      date: null,
    })
  })

  it('reports which layer produced each field of the worked case', () => {
    const result = interpret(deterministic, modelAnswer)

    expect(result.sources).toEqual({
      money: 'deterministic',
      category: 'deterministic',
      description: 'model',
      project: 'model',
    })
    expect(result.conflicts).toEqual([])
  })

  it('keeps 200 EUR even when the model hallucinates 20.000 RSD for the same message', () => {
    const result = interpret(deterministic, {
      ...modelAnswer,
      money: { amount: 20000, currency: 'RSD' },
    })

    expect(result.slots.money).toEqual({ amount: 200, currency: 'EUR' })
    expect(result.conflicts).toEqual(['money'])
  })
})

// ===========================================================================
// decide — commit, confirm, or ask.
// ===========================================================================

describe('decide — commit', () => {
  it('commits when every required slot is deterministic and the amount is small', () => {
    expect(decide(interpretation(), makeBook())).toEqual({ action: 'commit' })
  })

  it('commits a high-confidence model answer with every required slot filled', () => {
    const result = decide(
      interpretation({
        confidence: 'high',
        sources: { money: 'deterministic', category: 'model' },
      }),
      makeBook(),
    )

    expect(result).toEqual({ action: 'commit' })
  })

  it('commits an amount-only interpretation for a book that requires no axes', () => {
    const result = decide(
      interpretation({
        slots: det({ money: { amount: 800, currency: 'RSD' } }),
        sources: { money: 'deterministic' },
      }),
      makeBookWithoutRequiredAxes(),
    )

    expect(result).toEqual({ action: 'commit' })
  })
})

describe('decide — the book amount threshold', () => {
  const book = makeBook()

  it('commits an amount one cent below the threshold', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 999.99, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }) }),
      book,
    )

    expect(result).toEqual({ action: 'commit' })
  })

  it('requires a tap for an amount exactly at the threshold', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 1000, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }) }),
      book,
    )

    expect(result).toEqual({ action: 'confirm', reason: 'large_amount' })
  })

  it('requires a tap for an amount one cent above the threshold', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 1000.01, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }) }),
      book,
    )

    expect(result).toEqual({ action: 'confirm', reason: 'large_amount' })
  })

  it('compares the raw amount against the threshold regardless of currency', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 1200, currency: 'RSD' }, dimensions: { category: 'MATERIALS' } }) }),
      book,
    )

    expect(result).toEqual({ action: 'confirm', reason: 'large_amount' })
  })

  it('requires a tap for every amount when the threshold is configured as zero', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 0.01, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }) }),
      makeBook({ features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 0 } }),
    )

    expect(result).toEqual({ action: 'confirm', reason: 'large_amount' })
  })
})

describe('decide — confidence', () => {
  it.each([['low'], ['medium']] as Array<[Confidence]>)(
    'requires a tap when the interpretation confidence is %s',
    (confidence) => {
      const result = decide(interpretation({ confidence }), makeBook())

      expect(result).toEqual({ action: 'confirm', reason: 'low_confidence' })
    },
  )

  it.each([['exact'], ['high']] as Array<[Confidence]>)(
    'commits when the interpretation confidence is %s',
    (confidence) => {
      expect(decide(interpretation({ confidence }), makeBook())).toEqual({ action: 'commit' })
    },
  )
})

describe('decide — conflicts', () => {
  it('requires a tap when the deterministic layer had to overrule the model', () => {
    const result = decide(interpretation({ conflicts: ['money'] }), makeBook())

    expect(result).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('requires a tap for a dimension conflict even when the amount is tiny', () => {
    const result = decide(
      interpretation({
        slots: det({ money: { amount: 1, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }),
        conflicts: ['category'],
      }),
      makeBook(),
    )

    expect(result).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('never commits when a conflict and a large amount coincide', () => {
    const result = decide(
      interpretation({
        slots: det({ money: { amount: 50000, currency: 'EUR' }, dimensions: { category: 'MATERIALS' } }),
        conflicts: ['money'],
      }),
      makeBook(),
    )

    expect(result.action).toBe('confirm')
    expect(['conflict', 'large_amount']).toContain(
      (result as { action: 'confirm'; reason: string }).reason,
    )
  })
})

describe('decide — ask', () => {
  it('asks when no amount was resolved at all', () => {
    const result = decide(
      interpretation({
        slots: det({ dimensions: { category: 'MATERIALS' } }),
        sources: { category: 'deterministic' },
      }),
      makeBook(),
    )

    expect(result).toEqual({ action: 'ask', missing: ['money'] })
  })

  it('asks when a required axis was never resolved', () => {
    const result = decide(
      interpretation({ slots: det({ money: EUR200 }), sources: { money: 'deterministic' } }),
      makeBook(),
    )

    expect(result).toEqual({ action: 'ask', missing: ['category'] })
  })

  it('lists every missing required slot in one ask', () => {
    const result = decide(
      interpretation({ slots: det(), sources: {} }),
      makeBook(),
    ) as { action: 'ask'; missing: string[] }

    expect(result.action).toBe('ask')
    expect([...result.missing].sort()).toEqual(['category', 'money'])
  })

  it('asks rather than confirming when a required slot is missing and confidence is low', () => {
    const result = decide(
      interpretation({ slots: det({ money: EUR200 }), confidence: 'low' }),
      makeBook(),
    )

    expect(result.action).toBe('ask')
  })

  it('asks rather than confirming when a required slot is missing and the amount is large', () => {
    const result = decide(
      interpretation({ slots: det({ money: { amount: 50000, currency: 'EUR' } }) }),
      makeBook(),
    )

    expect(result.action).toBe('ask')
  })

  it('asks rather than confirming when a required slot is missing and a conflict was recorded', () => {
    const result = decide(
      interpretation({ slots: det({ money: EUR200 }), conflicts: ['description'] }),
      makeBook(),
    )

    expect(result.action).toBe('ask')
  })

  it('does not ask for an optional axis that stayed empty', () => {
    const result = decide(interpretation(), makeBook()) as { action: string; missing?: string[] }

    expect(result.action).toBe('commit')
    expect(result.missing).toBeUndefined()
  })

  it('treats an empty-string dimension value as a missing required axis', () => {
    const result = decide(
      interpretation({ slots: det({ money: EUR200, dimensions: { category: '' } }) }),
      makeBook(),
    )

    expect(result).toEqual({ action: 'ask', missing: ['category'] })
  })
})
