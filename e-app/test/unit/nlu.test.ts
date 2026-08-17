import { describe, it, expect } from 'vitest'

import { extractSlots } from '../../src/engine/nlu/slots.js'
import type { Slots, SlotExtraction } from '../../src/engine/nlu/slots.js'
import { interpret } from '../../src/engine/nlu/interpret.js'
import type { ModelSlots, Interpretation } from '../../src/engine/nlu/interpret.js'
import { decide } from '../../src/engine/nlu/confirm-policy.js'
import type { Book, Confidence, DimensionAxisDef, Money } from '../../src/engine/types.js'

/* ==========================================================================
 * MERGED CONTRACT TESTS — slot extraction, model merge, confirm policy.
 *
 * Spec: 02-WHATSAPP-INTERFACE.md §5 (amount grammar) and §5.1 (row-4 cascade,
 * confirm policy); 00-OVERVIEW.md D8 (the model proposes, the code decides)
 * and D11 (deterministic routing, AI interpretation).
 *
 * Fixtures are plain hand-written data. None of the three functions under test
 * takes an injected dependency — no Clock, no IdGen, no book on extractSlots —
 * and that absence is itself part of the contract (see the date refusals).
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * DECIDED CONVENTION — per-axis key spelling.
 * `Interpretation.sources`, `Interpretation.conflicts` and `Decision.missing`
 * carry scalar fields under their bare names ('money' | 'description' | 'date')
 * and dimension axes under a 'dimensions.<axis>' prefix. The contract does not
 * fix this; the prefixed form is chosen because the flat form collides the day a
 * book declares an axis literally named 'money', 'date' or 'description'.
 * Every provenance assertion routes through this helper, so flipping the
 * convention is a one-line change here. See the spec-gap report.
 * -------------------------------------------------------------------------- */
const dimKey = (axis: string): string => `dimensions.${axis}`

/* --------------------------------------------------------------------------
 * Fixtures
 * -------------------------------------------------------------------------- */

/** SMOQUA-shaped axes: a required closed set with Serbian aliases, plus an open_text axis. */
const AXES: DimensionAxisDef[] = [
  {
    axis: 'category',
    type: 'closed_set',
    required: true,
    values: ['MATERIALS', 'MARKETING', 'PACKAGING', 'TRANSPORT', 'DRINKS'],
    aliases: {
      MATERIALS: ['MATERIJAL', 'MATERIJALI', 'ROBA', 'SIROVINE'],
      MARKETING: ['REKLAMA'],
      PACKAGING: ['PAKOVANJE', 'AMBALAZA'],
      TRANSPORT: ['PREVOZ'],
      DRINKS: ['PIĆE'],
    },
  },
  { axis: 'project', type: 'open_text', required: false },
  { axis: 'cost_center', type: 'closed_set', required: false, values: [] },
]

/** A closed set built so that "MOOD" sits one edit from two different candidates. */
const EQUIDISTANT_AXES: DimensionAxisDef[] = [
  { axis: 'category', type: 'closed_set', required: true, values: ['FOOD', 'WOOD'] },
]

const NO_AXES: DimensionAxisDef[] = []

const emptySlots = (): Slots => ({ money: null, dimensions: {}, description: null, date: null })
const slots = (patch: Partial<Slots> = {}): Slots => ({ ...emptySlots(), ...patch })

const eur = (amount: number): Money => ({ amount, currency: 'EUR' })
const rsd = (amount: number): Money => ({ amount, currency: 'RSD' })

const model = (patch: Partial<ModelSlots> = {}): ModelSlots => ({ confidence: 'high', ...patch })

const interpretation = (patch: Partial<Interpretation> = {}): Interpretation => ({
  slots: emptySlots(),
  confidence: 'exact',
  sources: {},
  conflicts: [],
  ...patch,
})

/** Slots that satisfy every required slot of the SMOQUA book, comfortably under its threshold. */
const filled = (patch: Partial<Slots> = {}): Slots =>
  slots({ money: eur(200), dimensions: { category: 'MATERIALS' }, ...patch })

const book = (patch: Partial<Book> = {}): Book => ({
  code: 'SMOQUA',
  name: 'SMOQUA',
  senderPhones: ['+381600000001'],
  blobPrefix: 'smoqua/',
  defaultCategory: 'expense',
  accountantEmail: null,
  currency: 'EUR',
  dimensions: AXES,
  ...patch,
  features: {
    sef: false,
    invoicing: false,
    vat: null,
    confirmAboveAmount: 500,
    ...(patch.features ?? {}),
  },
})

/** The book from the worked example: a required category axis, a 500 tap threshold. */
const SMOQUA = book()

/** A book with no required axes at all — money is then the only required slot. */
const PERSONAL = book({
  code: 'PERSONAL',
  currency: 'RSD',
  dimensions: [{ axis: 'project', type: 'open_text', required: false }],
  features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 20000 },
})

const leftover = (r: SlotExtraction): string => r.leftoverTokens.join(' ')

const WORKED = 'MATERIJAAL PAMUK 200E Projekat 1'

/* ==========================================================================
 * extractSlots — the deterministic first pass (02 §5.1 row 4, steps 1-2).
 * Whatever it returns is AUTHORITATIVE and no model may overwrite it.
 * ========================================================================== */

describe('extractSlots', () => {
  describe('amount grammar (02 §5)', () => {
    it.each<[string, Money]>([
      ['4210', rsd(4210)],
      ['4.210,00', rsd(4210)],
      ['4210.50', rsd(4210.5)],
      ['300e', eur(300)],
      ['300€', eur(300)],
      ['300 eur', eur(300)],
      ['300 EVRA', eur(300)],
      ['300 evra', eur(300)],
      ['300 evro', eur(300)],
      ['1500din', rsd(1500)],
      ['1.500 rsd', rsd(1500)],
      ['12k', rsd(12000)],
    ])('parses %j deterministically, before any model runs', (text, expected) => {
      expect(extractSlots(text, AXES).slots.money).toEqual(expected)
    })

    it.each<[string, Money]>([
      ['MATERIALS 4.210,00', rsd(4210)],
      ['MATERIALS 300 EVRA', eur(300)],
      ['MATERIALS 12k', rsd(12000)],
    ])('parses the amount inside the sentence %j', (text, expected) => {
      expect(extractSlots(text, AXES).slots.money).toEqual(expected)
    })

    it('defaults a bare number with no currency marker to RSD', () => {
      expect(extractSlots('MATERIALS 4210', AXES).slots.money).toEqual(rsd(4210))
    })

    it('leaves the amount tokens out of the leftovers once the grammar has claimed them', () => {
      expect(extractSlots('MATERIALS 300e', AXES).leftoverTokens).toEqual([])
    })

    it('consumes every token of a multi-token amount so the model is never asked about it', () => {
      const r = extractSlots('MATERIJAL 300 EVRA', AXES)
      expect(r.slots.money).toEqual(eur(300))
      expect(r.leftoverTokens).toEqual([])
    })

    it('never reports a missing amount as zero', () => {
      expect(extractSlots('MATERIALS', AXES).slots.money).toBeNull()
    })
  })

  describe('amount refusals — it never half-guesses (02 §5)', () => {
    it('returns no amount for a spelled-out number and hands the words to the model', () => {
      const r = extractSlots('MATERIALS tri hiljade', AXES)
      expect(r.slots.money).toBeNull()
      expect(leftover(r)).toContain('tri hiljade')
    })

    it('returns null when two currency-marked amounts compete', () => {
      expect(extractSlots('MATERIALS 300e 400e', AXES).slots.money).toBeNull()
    })

    it('leaves both competing amount tokens as leftovers so the caller can ask which one', () => {
      const r = extractSlots('MATERIALS 300e 400e', AXES)
      expect(leftover(r)).toContain('300e')
      expect(leftover(r)).toContain('400e')
    })

    it('still resolves the dimension when it refuses the amount', () => {
      expect(extractSlots('MATERIALS 300e 400e', AXES).slots.dimensions).toEqual({
        category: 'MATERIALS',
      })
    })

    it('returns null when two bare numbers compete and neither carries a currency', () => {
      expect(extractSlots('MATERIALS 300 500', AXES).slots.money).toBeNull()
    })

    it('returns null when a bare number competes with the bare number inside an open-text phrase', () => {
      // "Projekat 1" contributes a bare number, so "300" is no longer the only candidate.
      expect(extractSlots('MATERIALS 300 Projekat 1', AXES).slots.money).toBeNull()
    })

    it('prefers a currency-marked amount over a stray bare number rather than declaring a conflict', () => {
      const r = extractSlots('MATERIJAL 300e 4210', AXES)
      expect(r.slots.money).toEqual(eur(300))
      expect(r.leftoverTokens).toContain('4210')
    })

    it('does not treat the bare number of a trailing open-text phrase as a competing amount', () => {
      // The flagship case: "200E" wins outright over the "1" of "Projekat 1".
      expect(extractSlots('MATERIALS 300e Projekat 1', AXES).slots.money).toEqual(eur(300))
    })

    it('does not read a dotted calendar date as a Serbian-formatted amount', () => {
      expect(extractSlots('MATERIALS 15.03.2026', AXES).slots.money).toBeNull()
    })
  })

  describe('dimension resolution — exact, alias, fuzzy (02 §5.1 step 2)', () => {
    it.each<[string, string]>([
      ['MATERIALS 300e', 'MATERIALS'],
      ['materials 300e', 'MATERIALS'],
      ['MaTeRiAlS 300e', 'MATERIALS'],
      ['MATERIJAL 300e', 'MATERIALS'],
      ['ROBA 300e', 'MATERIALS'],
      ['MATERIJAAL 300e', 'MATERIALS'],
      ['REKLAMA 300e', 'MARKETING'],
      ['AMBALAZA 300e', 'PACKAGING'],
      ['AMBALAŽA 300e', 'PACKAGING'],
      ['PACKAGNG 300e', 'PACKAGING'],
      ['prevoz 300e', 'TRANSPORT'],
      ['pice 300e', 'DRINKS'],
    ])('resolves the closed-set axis in %j to %s without a model call', (text, expected) => {
      expect(extractSlots(text, AXES).slots.dimensions.category).toBe(expected)
    })

    it('consumes the matched dimension token instead of leaving it for the model', () => {
      expect(extractSlots('MATERIJAAL 200E', AXES).leftoverTokens).toEqual([])
    })

    it.each<[string, string]>([
      ['a word further than edit distance 2 from every candidate', 'MATERIC 300e'],
      ['a word with no relation to the closed set at all', 'KVANTNAFIZIKA 300e'],
    ])('leaves %s unresolved and hands it to the model', (_label, text) => {
      const r = extractSlots(text, AXES)
      expect(r.slots.dimensions).toEqual({})
      expect(r.leftoverTokens).toContain(text.split(' ')[0])
    })

    it('never silently falls back to OTHER for an unknown dimension word', () => {
      const r = extractSlots('KVAKA 300e', AXES)
      expect(r.slots.dimensions.category).toBeUndefined()
      expect(Object.values(r.slots.dimensions)).not.toContain('OTHER')
      expect(r.leftoverTokens).toContain('KVAKA')
    })

    it('returns nothing rather than guessing when a token is equidistant from two candidates', () => {
      const r = extractSlots('MOOD 300e', EQUIDISTANT_AXES)
      expect(r.slots.dimensions).toEqual({})
      expect(r.leftoverTokens).toContain('MOOD')
    })

    it('resolves nothing on a closed_set axis declared with an empty value list', () => {
      expect(extractSlots('MATERIALS 300e', AXES).slots.dimensions.cost_center).toBeUndefined()
    })

    it('resolves nothing and keeps every word when the book declares no axes', () => {
      const r = extractSlots('MATERIALS 300e', NO_AXES)
      expect(r.slots.dimensions).toEqual({})
      expect(r.slots.money).toEqual(eur(300))
      expect(r.leftoverTokens).toEqual(['MATERIALS'])
    })

    it('does not fill an open_text axis from leftover words — that is the model\'s job', () => {
      // 02 §5.1 step 3 lists "Projekat 1" among the leftovers sent to the model.
      const r = extractSlots(WORKED, AXES)
      expect(r.slots.dimensions).toEqual({ category: 'MATERIALS' })
      expect(r.slots.dimensions.project).toBeUndefined()
    })
  })

  describe('description is never claimed deterministically (02 §5.1 step 3)', () => {
    it('leaves free-text words as leftovers instead of guessing a description', () => {
      const r = extractSlots('MATERIALS 300e PAMUK', AXES)
      expect(r.slots.description).toBeNull()
      expect(r.leftoverTokens).toEqual(['PAMUK'])
    })

    it('returns a null description even when the text is nothing but prose', () => {
      const r = extractSlots('rucak sa klijentom', AXES)
      expect(r.slots.description).toBeNull()
      expect(r.slots.money).toBeNull()
      expect(leftover(r)).toBe('rucak sa klijentom')
    })
  })

  describe('dates — no clock is injected, so only fully specified dates resolve', () => {
    it('extracts a Serbian dd.mm.yyyy date as an ISO date without reading it as an amount', () => {
      const r = extractSlots('MATERIALS 300e 11.08.2026', AXES)
      expect(r.slots.date).toBe('2026-08-11')
      expect(r.slots.money).toEqual(eur(300))
    })

    it('accepts an ISO date as written', () => {
      expect(extractSlots('MATERIALS 300e 2026-03-11', AXES).slots.date).toBe('2026-03-11')
    })

    it('consumes the date token rather than leaving it for the model', () => {
      expect(extractSlots('MATERIALS 300e 15.03.2026', AXES).leftoverTokens).toEqual([])
    })

    it('returns null for a relative date word, because core is given no clock', () => {
      const r = extractSlots('MATERIALS 300e juce', AXES)
      expect(r.slots.date).toBeNull()
      expect(r.leftoverTokens).toContain('juce')
    })

    it('returns null for a day-and-month with no year rather than assuming the current one', () => {
      expect(extractSlots('MATERIALS 300e 11.08.', AXES).slots.date).toBeNull()
    })

    it.each<[string, string]>([
      ['a day that does not exist', 'MATERIALS 300e 31.02.2026'],
      ['a month that does not exist', 'MATERIALS 300e 32.13.2026'],
    ])('returns null for %s rather than a rolled-over date', (_label, text) => {
      expect(extractSlots(text, AXES).slots.date).toBeNull()
    })

    it('returns a null date when the message carries no date at all', () => {
      expect(extractSlots('MATERIALS 300e', AXES).slots.date).toBeNull()
    })
  })

  describe('order tolerance — the property 02 §5.1 names explicitly', () => {
    it('produces byte-identical output for "300e MATERIALS" and "MATERIALS 300e"', () => {
      expect(extractSlots('300e MATERIALS', AXES)).toEqual(extractSlots('MATERIALS 300e', AXES))
    })

    it.each<[string, string]>([
      ['MATERIJAL 4.210,00', '4.210,00 MATERIJAL'],
      [WORKED, '200E MATERIJAAL PAMUK Projekat 1'],
      [WORKED, 'PAMUK Projekat 1 200E MATERIJAAL'],
      ['MARKETING 12000 fb ads', '12000 fb ads MARKETING'],
    ])('extracts the same slots from %j and its permutation %j', (a, b) => {
      expect(extractSlots(a, AXES).slots).toEqual(extractSlots(b, AXES).slots)
    })

    it('leaves the same leftover words, whatever order they arrived in', () => {
      const a = extractSlots(WORKED, AXES).leftoverTokens
      const b = extractSlots('200E Projekat 1 MATERIJAAL PAMUK', AXES).leftoverTokens
      expect([...a].sort()).toEqual([...b].sort())
    })
  })

  describe('empty, absent and malformed input', () => {
    it.each<[string, string]>([
      ['an empty string', ''],
      ['spaces only', '   '],
      ['a tab and a newline', '\t\n'],
      ['punctuation only', '!!! ...'],
    ])('returns an empty extraction for %s without throwing', (_label, text) => {
      const r = extractSlots(text, AXES)
      expect(r.slots).toEqual(emptySlots())
      expect(r.leftoverTokens).toEqual([])
    })

    it('tolerates repeated whitespace between tokens', () => {
      expect(extractSlots('  MATERIALS    300e  ', AXES).slots).toEqual(
        extractSlots('MATERIALS 300e', AXES).slots,
      )
    })

    it('tolerates punctuation attached to the tokens', () => {
      expect(extractSlots('MATERIALS, 300e.', AXES).slots).toEqual(
        extractSlots('MATERIALS 300e', AXES).slots,
      )
    })

    it('does not mutate the axis definitions it was given', () => {
      const axes = JSON.parse(JSON.stringify(AXES)) as DimensionAxisDef[]
      extractSlots(WORKED, axes)
      expect(axes).toEqual(AXES)
    })
  })

  describe('the worked case from 02 §5.1 — "MATERIJAAL PAMUK 200E Projekat 1"', () => {
    it('reads 200 EUR from the money grammar, before any model is asked', () => {
      expect(extractSlots(WORKED, AXES).slots.money).toEqual(eur(200))
    })

    it('fuzzy-matches MATERIJAAL to MATERIALS without a model call', () => {
      expect(extractSlots(WORKED, AXES).slots.dimensions).toEqual({ category: 'MATERIALS' })
    })

    it('claims no description deterministically', () => {
      expect(extractSlots(WORKED, AXES).slots.description).toBeNull()
    })

    it('hands exactly PAMUK and Projekat 1 to the model, in input order and original casing', () => {
      expect(leftover(extractSlots(WORKED, AXES))).toBe('PAMUK Projekat 1')
    })

    it('never puts the amount or the matched dimension in front of the model', () => {
      const leftovers = leftover(extractSlots(WORKED, AXES)).toUpperCase()
      expect(leftovers).not.toContain('200')
      expect(leftovers).not.toContain('MATERIJAAL')
    })
  })
})

/* ==========================================================================
 * interpret — merge. A deterministic slot ALWAYS beats a model slot and the
 * disagreement is recorded. Malformed model output is NO ANSWER, not a value.
 * (02 §5.1 step 4; 00-OVERVIEW D8.)
 * ========================================================================== */

describe('interpret', () => {
  describe('with no model answer at all', () => {
    it('returns the deterministic slots unchanged when the model was never called', () => {
      const det = slots({ money: eur(200), dimensions: { category: 'MATERIALS' } })
      const r = interpret(det, null)
      expect(r.slots).toEqual(det)
      expect(r.conflicts).toEqual([])
    })

    it('marks every filled field as deterministic and records nothing for the unfilled ones', () => {
      const r = interpret(slots({ money: eur(200), description: 'PAMUK' }), null)
      expect(r.sources).toEqual({ money: 'deterministic', description: 'deterministic' })
    })

    it('marks a deterministically resolved axis as deterministic', () => {
      const r = interpret(slots({ dimensions: { category: 'MATERIALS' } }), null)
      expect(r.sources[dimKey('category')]).toBe('deterministic')
    })

    it('reports exact confidence when nothing came from a model', () => {
      expect(interpret(slots({ money: eur(200) }), null).confidence).toBe('exact')
    })

    it('returns an empty interpretation when nothing was extracted and no model ran', () => {
      const r = interpret(emptySlots(), null)
      expect(r.slots).toEqual(emptySlots())
      expect(r.sources).toEqual({})
      expect(r.conflicts).toEqual([])
      expect(r.confidence).toBe('exact')
    })
  })

  describe('the model may only fill gaps', () => {
    it('takes the amount from the model when the grammar declined to parse one', () => {
      const r = interpret(emptySlots(), model({ money: { amount: 3000, currency: 'RSD' } }))
      expect(r.slots.money).toEqual(rsd(3000))
      expect(r.sources.money).toBe('model')
      expect(r.conflicts).toEqual([])
    })

    it('takes the description from the model, which is what the model is actually for', () => {
      const r = interpret(slots({ money: eur(200) }), model({ description: 'PAMUK' }))
      expect(r.slots.description).toBe('PAMUK')
      expect(r.sources.description).toBe('model')
    })

    it('takes a well-formed ISO date from the model when the grammar found none', () => {
      const r = interpret(slots({ money: eur(200) }), model({ date: '2026-08-11' }))
      expect(r.slots.date).toBe('2026-08-11')
      expect(r.sources.date).toBe('model')
    })

    it('takes an open_text axis from the model while the closed-set axis stays deterministic', () => {
      const r = interpret(
        slots({ dimensions: { category: 'MATERIALS' } }),
        model({ dimensions: { project: 'Projekat 1' } }),
      )
      expect(r.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
      expect(r.sources[dimKey('project')]).toBe('model')
      expect(r.sources[dimKey('category')]).toBe('deterministic')
    })

    it('accepts a lower-case currency code from the model and normalizes it', () => {
      const r = interpret(emptySlots(), model({ money: { amount: 300, currency: 'eur' } }))
      expect(r.slots.money).toEqual(eur(300))
    })

    it('records a source for every filled slot and for nothing else', () => {
      const r = interpret(
        slots({ money: eur(200), dimensions: { category: 'MATERIALS' } }),
        model({ description: 'PAMUK' }),
      )
      expect(Object.keys(r.sources).sort()).toEqual(
        ['description', dimKey('category'), 'money'].sort(),
      )
    })
  })

  describe('a deterministic slot always beats a model slot (the safety property of D11)', () => {
    it('keeps the grammar-parsed amount when the model proposes a different one', () => {
      const r = interpret(slots({ money: eur(200) }), model({ money: { amount: 999, currency: 'EUR' } }))
      expect(r.slots.money).toEqual(eur(200))
      expect(r.sources.money).toBe('deterministic')
      expect(r.conflicts).toEqual(['money'])
    })

    it('treats the same number in a different currency as a conflict', () => {
      const r = interpret(slots({ money: eur(200) }), model({ money: { amount: 200, currency: 'RSD' } }))
      expect(r.slots.money).toEqual(eur(200))
      expect(r.conflicts).toEqual(['money'])
    })

    it('records no conflict when the model independently agrees with the grammar', () => {
      const r = interpret(slots({ money: eur(200) }), model({ money: { amount: 200, currency: 'EUR' } }))
      expect(r.slots.money).toEqual(eur(200))
      expect(r.sources.money).toBe('deterministic')
      expect(r.conflicts).toEqual([])
    })

    it('keeps the fuzzy-matched dimension when the model proposes another value on the same axis', () => {
      const r = interpret(
        slots({ dimensions: { category: 'MATERIALS' } }),
        model({ dimensions: { category: 'MARKETING' } }),
      )
      expect(r.slots.dimensions).toEqual({ category: 'MATERIALS' })
      expect(r.sources[dimKey('category')]).toBe('deterministic')
      expect(r.conflicts).toEqual([dimKey('category')])
    })

    it('records no conflict when the model repeats the dimension the grammar already resolved', () => {
      const r = interpret(
        slots({ dimensions: { category: 'MATERIALS' } }),
        model({ dimensions: { category: 'MATERIALS' } }),
      )
      expect(r.conflicts).toEqual([])
      expect(r.sources[dimKey('category')]).toBe('deterministic')
    })

    it('merges a second axis from the model while overruling it on the first', () => {
      const r = interpret(
        slots({ dimensions: { category: 'MATERIALS' } }),
        model({ dimensions: { category: 'MARKETING', project: 'Projekat 1' } }),
      )
      expect(r.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
      expect(r.conflicts).toEqual([dimKey('category')])
      expect(r.sources[dimKey('project')]).toBe('model')
    })

    it('keeps a deterministic description over the model rewording it', () => {
      const r = interpret(slots({ description: 'PAMUK' }), model({ description: 'cotton fabric' }))
      expect(r.slots.description).toBe('PAMUK')
      expect(r.conflicts).toEqual(['description'])
    })

    it('keeps a deterministic date over a model-proposed date', () => {
      const r = interpret(slots({ date: '2026-08-11' }), model({ date: '2026-08-12' }))
      expect(r.slots.date).toBe('2026-08-11')
      expect(r.conflicts).toEqual(['date'])
    })

    it('records every disagreeing field, not just the first', () => {
      const r = interpret(
        slots({
          money: eur(200),
          dimensions: { category: 'MATERIALS' },
          description: 'PAMUK',
          date: '2026-08-11',
        }),
        model({
          money: { amount: 999, currency: 'EUR' },
          dimensions: { category: 'MARKETING' },
          description: 'cotton',
          date: '2026-01-01',
        }),
      )
      expect([...r.conflicts].sort()).toEqual(
        ['date', 'description', dimKey('category'), 'money'].sort(),
      )
    })

    it('does not mutate the deterministic slots it was handed', () => {
      const det = slots({ money: eur(200), dimensions: { category: 'MATERIALS' } })
      const before = JSON.parse(JSON.stringify(det)) as Slots
      interpret(det, model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' } }))
      expect(det).toEqual(before)
    })
  })

  describe('malformed model output is no answer, never a value (02 §5.1 confirm table)', () => {
    const badMoney: Array<[string, unknown]> = [
      ['a non-numeric amount', { amount: '200', currency: 'EUR' }],
      ['NaN', { amount: Number.NaN, currency: 'EUR' }],
      ['Infinity', { amount: Number.POSITIVE_INFINITY, currency: 'EUR' }],
      ['zero — absence is never expressed as a zero (types.ts Money)', { amount: 0, currency: 'EUR' }],
      ['a negative amount', { amount: -200, currency: 'EUR' }],
      ['an unknown currency code', { amount: 200, currency: 'XYZ' }],
      ['an empty currency', { amount: 200, currency: '' }],
      ['a missing currency', { amount: 200 }],
      ['a missing amount', { currency: 'EUR' }],
      ['money that is not an object', 'about 200 euro'],
      ['an empty object', {}],
      ['an explicit null', null],
    ]

    it.each(badMoney)('drops a model amount given as %s', (_label, money) => {
      const r = interpret(emptySlots(), { money, confidence: 'high' } as unknown as ModelSlots)
      expect(r.slots.money).toBeNull()
      expect(r.sources.money).toBeUndefined()
      expect(r.conflicts).toEqual([])
    })

    it.each(badMoney)(
      'treats a model amount given as %s as silence, not as a disagreement with the grammar',
      (_label, money) => {
        const r = interpret(slots({ money: eur(200) }), {
          money,
          confidence: 'high',
        } as unknown as ModelSlots)
        expect(r.slots.money).toEqual(eur(200))
        expect(r.sources.money).toBe('deterministic')
        expect(r.conflicts).toEqual([])
      },
    )

    const badDescriptions: Array<[string, unknown]> = [
      ['an empty string', ''],
      ['whitespace only', '  \t '],
      ['a number', 42],
    ]

    it.each(badDescriptions)('drops a model description given as %s', (_label, description) => {
      const r = interpret(emptySlots(), { description, confidence: 'high' } as unknown as ModelSlots)
      expect(r.slots.description).toBeNull()
      expect(r.sources.description).toBeUndefined()
    })

    const badDates: Array<[string, unknown]> = [
      ['a dotted Serbian date', '11.08.2026'],
      ['a slashed date', '11/03/2026'],
      ['a slashed ISO-order date', '2026/08/11'],
      ['an unpadded date', '2026-8-1'],
      ['a month that does not exist', '2026-13-01'],
      ['a day that does not exist', '2026-02-30'],
      ['prose', 'yesterday'],
      ['a Serbian relative word', 'juce'],
      ['an empty string', ''],
      ['a number', 20260811],
    ]

    it.each(badDates)('drops a model date given as %s', (_label, date) => {
      const r = interpret(emptySlots(), { date, confidence: 'high' } as unknown as ModelSlots)
      expect(r.slots.date).toBeNull()
      expect(r.sources.date).toBeUndefined()
    })

    it('accepts a well-formed ISO date from the model', () => {
      const r = interpret(emptySlots(), model({ date: '2026-03-11' }))
      expect(r.slots.date).toBe('2026-03-11')
      expect(r.sources.date).toBe('model')
    })

    const badAxisValues: Array<[string, unknown]> = [
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['null', null],
      ['a number', 7],
      ['an object', { name: 'Projekat 1' }],
    ]

    it.each(badAxisValues)('drops a single model dimension whose value is %s', (_label, value) => {
      const r = interpret(emptySlots(), {
        dimensions: { project: value },
        confidence: 'high',
      } as unknown as ModelSlots)
      expect(r.slots.dimensions).toEqual({})
      expect(r.sources[dimKey('project')]).toBeUndefined()
    })

    it('keeps the valid axes when only one model dimension is malformed', () => {
      const r = interpret(emptySlots(), {
        dimensions: { project: 'Projekat 1', category: 42 },
        confidence: 'high',
      } as unknown as ModelSlots)
      expect(r.slots.dimensions).toEqual({ project: 'Projekat 1' })
      expect(r.sources[dimKey('project')]).toBe('model')
    })

    const badDimensionMaps: Array<[string, unknown]> = [
      ['a string', 'MATERIALS'],
      ['an array', ['MATERIALS']],
      ['null', null],
    ]

    it.each(badDimensionMaps)('ignores the whole dimension map when it is %s', (_label, dimensions) => {
      const r = interpret(emptySlots(), { dimensions, confidence: 'high' } as unknown as ModelSlots)
      expect(r.slots.dimensions).toEqual({})
      expect(r.sources).toEqual({})
    })

    it('rejects one bad field without discarding a good field in the same answer', () => {
      const r = interpret(emptySlots(), {
        money: { amount: 'lots', currency: 'EUR' },
        description: 'PAMUK',
        confidence: 'high',
      } as unknown as ModelSlots)
      expect(r.slots.money).toBeNull()
      expect(r.slots.description).toBe('PAMUK')
      expect(r.sources).toEqual({ description: 'model' })
    })

    it.each<[string, unknown]>([
      ['an invented level', 'very sure'],
      ['nonsense', 'banana'],
      ['an empty string', ''],
      ['null', null],
      ['undefined — the field is missing entirely', undefined],
      ['a number', 3],
    ])('discards the entire model answer when the confidence field is %s', (_label, confidence) => {
      const r = interpret(slots({ money: eur(200) }), {
        description: 'PAMUK',
        dimensions: { project: 'Projekat 1' },
        confidence,
      } as unknown as ModelSlots)
      expect(r.slots.description).toBeNull()
      expect(r.slots.dimensions).toEqual({})
      expect(r.sources).toEqual({ money: 'deterministic' })
    })

    it('reports exact confidence after discarding an unusable model answer', () => {
      const r = interpret(slots({ money: eur(200) }), {
        description: 'PAMUK',
        confidence: 'banana',
      } as unknown as ModelSlots)
      expect(r.confidence).toBe('exact')
    })

    it('treats a model object carrying no fields at all as no answer', () => {
      const r = interpret(slots({ money: eur(200) }), model({ confidence: 'low' }))
      expect(r.slots).toEqual(slots({ money: eur(200) }))
      expect(r.sources).toEqual({ money: 'deterministic' })
      expect(r.conflicts).toEqual([])
    })

    it('treats an explicit null money from the model as no answer', () => {
      const r = interpret(emptySlots(), model({ money: null }))
      expect(r.slots.money).toBeNull()
      expect(r.conflicts).toEqual([])
    })
  })

  describe('the resulting confidence level', () => {
    it.each<[Confidence]>([['exact'], ['high'], ['medium'], ['low']])(
      'reports %s when a model field of that confidence was actually used',
      (level) => {
        const r = interpret(slots({ money: eur(200) }), model({ description: 'PAMUK', confidence: level }))
        expect(r.confidence).toBe(level)
      },
    )

    it('stays exact when the model answered but contributed nothing new', () => {
      const r = interpret(slots({ money: eur(200) }), model({ confidence: 'low' }))
      expect(r.confidence).toBe('exact')
    })

    it('stays exact when every model value was overruled by the grammar', () => {
      const r = interpret(
        slots({ money: eur(200), dimensions: { category: 'MATERIALS' } }),
        model({ money: { amount: 999, currency: 'EUR' }, confidence: 'low' }),
      )
      expect(r.confidence).toBe('exact')
    })

    it('stays exact when every model value was rejected as malformed', () => {
      const r = interpret(slots({ money: eur(200) }), {
        description: '   ',
        confidence: 'low',
      } as unknown as ModelSlots)
      expect(r.confidence).toBe('exact')
    })
  })

  describe('the worked case from 02 §5.1, end to end', () => {
    const det = (): Slots => slots({ money: eur(200), dimensions: { category: 'MATERIALS' } })
    const answer = model({
      description: 'PAMUK',
      dimensions: { project: 'Projekat 1' },
      confidence: 'high',
    })

    it('merges the grammar amount, the fuzzy category and the model leftovers into one reading', () => {
      expect(interpret(det(), answer).slots).toEqual({
        money: eur(200),
        dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
        description: 'PAMUK',
        date: null,
      })
    })

    it('attributes the amount and the category to the grammar, the rest to the model', () => {
      const r = interpret(det(), answer)
      expect(r.sources.money).toBe('deterministic')
      expect(r.sources[dimKey('category')]).toBe('deterministic')
      expect(r.sources.description).toBe('model')
      expect(r.sources[dimKey('project')]).toBe('model')
      expect(r.conflicts).toEqual([])
      expect(r.confidence).toBe('high')
    })

    it('keeps 200 EUR even when the model hallucinates 20.000 RSD for the same message', () => {
      const r = interpret(det(), { ...answer, money: { amount: 20000, currency: 'RSD' } })
      expect(r.slots.money).toEqual(eur(200))
      expect(r.conflicts).toEqual(['money'])
    })
  })
})

/* ==========================================================================
 * decide — commit, confirm, or ask (02 §5.1 "The confirm policy").
 * Required slots = money, plus every axis the book declares required:true.
 * Description and date are never required.
 * ========================================================================== */

describe('decide', () => {
  describe('commit', () => {
    it('commits when every required slot is deterministic and the amount is small', () => {
      expect(decide(interpretation({ slots: filled() }), SMOQUA)).toEqual({ action: 'commit' })
    })

    it('commits a high-confidence model-sourced reading — provenance alone does not block a commit', () => {
      const r = decide(
        interpretation({ slots: filled(), confidence: 'high', sources: { money: 'model' } }),
        SMOQUA,
      )
      expect(r).toEqual({ action: 'commit' })
    })

    it('commits although the optional description and date are both absent', () => {
      expect(decide(interpretation({ slots: filled({ description: null, date: null }) }), SMOQUA)).toEqual({
        action: 'commit',
      })
    })

    it('commits without an optional axis being filled', () => {
      expect(SMOQUA.dimensions.find((a) => a.axis === 'project')?.required).toBe(false)
      expect(decide(interpretation({ slots: filled() }), SMOQUA)).toEqual({ action: 'commit' })
    })

    it('commits an amount-only booking for a book that declares no required axes', () => {
      const r = decide(interpretation({ slots: slots({ money: rsd(1500) }) }), PERSONAL)
      expect(r).toEqual({ action: 'commit' })
    })

    it('commits 200 EUR of cotton, exactly as 02 §5.1 promises', () => {
      const r = decide(
        interpretation({
          confidence: 'high',
          slots: slots({
            money: eur(200),
            dimensions: { category: 'MATERIALS', project: 'Projekat 1' },
            description: 'PAMUK',
          }),
          sources: {
            money: 'deterministic',
            [dimKey('category')]: 'deterministic',
            [dimKey('project')]: 'model',
            description: 'model',
          },
        }),
        SMOQUA,
      )
      expect(r).toEqual({ action: 'commit' })
    })
  })

  describe('the book amount threshold, at the boundary exactly', () => {
    it.each<[number, string, string]>([
      [1, 'commit', 'far below'],
      [499.99, 'commit', 'one cent below'],
      [500, 'confirm', 'exactly at'],
      [500.01, 'confirm', 'one cent above'],
      [5000, 'confirm', 'an order of magnitude above'],
    ])('%s -> %s (%s the 500 threshold)', (amount, action) => {
      expect(decide(interpretation({ slots: filled({ money: eur(amount) }) }), SMOQUA).action).toBe(action)
    })

    it('names large_amount as the reason exactly at the threshold', () => {
      expect(decide(interpretation({ slots: filled({ money: eur(500) }) }), SMOQUA)).toEqual({
        action: 'confirm',
        reason: 'large_amount',
      })
    })

    it('applies each book its own threshold, at the boundary', () => {
      expect(decide(interpretation({ slots: slots({ money: rsd(19999) }) }), PERSONAL).action).toBe('commit')
      expect(decide(interpretation({ slots: slots({ money: rsd(20000) }) }), PERSONAL)).toEqual({
        action: 'confirm',
        reason: 'large_amount',
      })
    })

    it('requires a confirmation for every amount when the threshold is configured as zero', () => {
      const zero = book({ features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 0 } })
      expect(decide(interpretation({ slots: filled({ money: eur(0.01) }) }), zero)).toEqual({
        action: 'confirm',
        reason: 'large_amount',
      })
    })

    // decide() is handed no FX rate, so it can only compare raw numbers. Both directions
    // of the resulting asymmetry are pinned here deliberately — see the spec-gap report.
    it('compares the raw amount against the threshold, so 1200 RSD trips a 1000 threshold', () => {
      const b = book({
        currency: 'RSD',
        features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 1000 },
      })
      expect(decide(interpretation({ slots: filled({ money: rsd(1200) }) }), b)).toEqual({
        action: 'confirm',
        reason: 'large_amount',
      })
    })

    it('compares the raw amount against the threshold, so 200 EUR commits under a 50000 threshold', () => {
      const b = book({
        currency: 'RSD',
        features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 50000 },
      })
      expect(decide(interpretation({ slots: filled({ money: eur(200) }) }), b)).toEqual({ action: 'commit' })
    })
  })

  describe('confidence', () => {
    it.each<[Confidence, string]>([
      ['exact', 'commit'],
      ['high', 'commit'],
      ['medium', 'confirm'],
      ['low', 'confirm'],
    ])('%s confidence means %s', (confidence, action) => {
      expect(decide(interpretation({ slots: filled(), confidence }), SMOQUA).action).toBe(action)
    })

    it.each<[Confidence]>([['medium'], ['low']])(
      'names low_confidence as the reason for the tap at %s confidence',
      (confidence) => {
        expect(decide(interpretation({ slots: filled(), confidence }), SMOQUA)).toEqual({
          action: 'confirm',
          reason: 'low_confidence',
        })
      },
    )
  })

  describe('conflicts', () => {
    it('never commits a conflicted reading, even at exact confidence and a tiny amount', () => {
      const r = decide(
        interpretation({ slots: filled({ money: eur(1) }), confidence: 'exact', conflicts: ['money'] }),
        SMOQUA,
      )
      expect(r).toEqual({ action: 'confirm', reason: 'conflict' })
    })

    it('requires a confirmation when the disagreement was on a dimension axis', () => {
      const r = decide(interpretation({ slots: filled(), conflicts: [dimKey('category')] }), SMOQUA)
      expect(r).toEqual({ action: 'confirm', reason: 'conflict' })
    })
  })

  describe('ask — a required slot is missing entirely', () => {
    it('asks, naming money, when no layer produced an amount', () => {
      expect(decide(interpretation({ slots: filled({ money: null }) }), SMOQUA)).toEqual({
        action: 'ask',
        missing: ['money'],
      })
    })

    it('asks for a required dimension axis rather than defaulting it to OTHER', () => {
      expect(decide(interpretation({ slots: filled({ dimensions: {} }) }), SMOQUA)).toEqual({
        action: 'ask',
        missing: [dimKey('category')],
      })
    })

    it('lists every missing required slot in one ask', () => {
      const r = decide(interpretation({ slots: emptySlots() }), SMOQUA)
      expect(r.action).toBe('ask')
      if (r.action === 'ask') {
        expect([...r.missing].sort()).toEqual(['money', dimKey('category')].sort())
      }
    })

    it('treats an empty-string dimension value as a missing required axis, not as filled', () => {
      const r = decide(interpretation({ slots: filled({ dimensions: { category: '' } }) }), SMOQUA)
      expect(r).toEqual({ action: 'ask', missing: [dimKey('category')] })
    })

    it('does not ask for an optional axis that stayed empty', () => {
      const r = decide(interpretation({ slots: filled() }), SMOQUA)
      expect(r).toEqual({ action: 'commit' })
      expect((r as { missing?: string[] }).missing).toBeUndefined()
    })

    it('does not ask for an optional open_text axis on a book that requires nothing else', () => {
      expect(decide(interpretation({ slots: slots({ money: rsd(1500) }) }), PERSONAL).action).toBe('commit')
    })
  })

  describe('precedence when several rules fire at once', () => {
    it.each<[string, Partial<Interpretation>]>([
      ['confidence is low', { confidence: 'low' }],
      ['a conflict was recorded', { conflicts: ['description'] }],
      ['the amount would otherwise be large', {}],
    ])('asks rather than confirming when a required slot is missing and %s', (_label, patch) => {
      const r = decide(
        interpretation({ slots: filled({ money: null, dimensions: {} }), ...patch }),
        SMOQUA,
      )
      expect(r.action).toBe('ask')
    })

    it('asks rather than confirming when the missing slot coincides with a large amount', () => {
      const r = decide(interpretation({ slots: slots({ money: eur(5000) }) }), SMOQUA)
      expect(r.action).toBe('ask')
    })

    // Ordering among the confirm reasons is unspecified; only the tap is pinned.
    it('confirms when the amount is large and the reading is also conflicted', () => {
      const r = decide(
        interpretation({ slots: filled({ money: eur(5000) }), conflicts: ['money'] }),
        SMOQUA,
      )
      expect(r.action).toBe('confirm')
      if (r.action === 'confirm') expect(['conflict', 'large_amount']).toContain(r.reason)
    })

    it('confirms when the amount is large and confidence is low', () => {
      const r = decide(interpretation({ slots: filled({ money: eur(5000) }), confidence: 'low' }), SMOQUA)
      expect(r.action).toBe('confirm')
      if (r.action === 'confirm') expect(['low_confidence', 'large_amount']).toContain(r.reason)
    })

    it('confirms when low confidence, a conflict and a large amount all coincide', () => {
      const r = decide(
        interpretation({
          slots: filled({ money: eur(9000) }),
          confidence: 'low',
          conflicts: ['money'],
        }),
        SMOQUA,
      )
      expect(r.action).toBe('confirm')
    })
  })
})

/* ==========================================================================
 * The three modules together, on the message the whole design is for.
 * ========================================================================== */

describe('the pipeline on "MATERIJAAL PAMUK 200E Projekat 1"', () => {
  it('extracts, merges and commits in one pass with the grammar amount intact', () => {
    const extracted = extractSlots(WORKED, AXES)
    const merged = interpret(
      extracted.slots,
      model({ description: 'PAMUK', dimensions: { project: 'Projekat 1' }, confidence: 'high' }),
    )
    expect(merged.slots.money).toEqual(eur(200))
    expect(merged.slots.dimensions).toEqual({ category: 'MATERIALS', project: 'Projekat 1' })
    expect(merged.slots.description).toBe('PAMUK')
    expect(decide(merged, SMOQUA)).toEqual({ action: 'commit' })
  })

  it('still books 200 EUR when the model hallucinates a different amount, and requires a tap', () => {
    const extracted = extractSlots(WORKED, AXES)
    const merged = interpret(
      extracted.slots,
      model({ money: { amount: 20000, currency: 'RSD' }, description: 'PAMUK' }),
    )
    expect(merged.slots.money).toEqual(eur(200))
    expect(decide(merged, SMOQUA)).toEqual({ action: 'confirm', reason: 'conflict' })
  })

  it('asks for the category when the word was unrecognisable and the model returned nothing usable', () => {
    const extracted = extractSlots('KVAKA 300e', AXES)
    const merged = interpret(extracted.slots, null)
    expect(decide(merged, SMOQUA)).toEqual({ action: 'ask', missing: [dimKey('category')] })
  })

  it('asks for the amount when the grammar declined it and the model answer was malformed', () => {
    const extracted = extractSlots('MATERIALS tri hiljade', AXES)
    const merged = interpret(extracted.slots, {
      money: { amount: 0, currency: 'EUR' },
      confidence: 'high',
    } as unknown as ModelSlots)
    expect(decide(merged, SMOQUA)).toEqual({ action: 'ask', missing: ['money'] })
  })
})
