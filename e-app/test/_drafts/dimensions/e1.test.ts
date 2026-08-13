import { describe, expect, it } from 'vitest'

import {
  missingRequiredAxes,
  recentAxisValues,
  resolveDimensions,
  type AxisResolution,
} from '../../../src/core/dimensions.js'
import type { DimensionAxisDef, DimensionValues } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Fixtures — the SMOQUA axes exactly as declared in 05-SMOQUA.md §2.
// ---------------------------------------------------------------------------

const CATEGORY_AXIS: DimensionAxisDef = {
  axis: 'category',
  type: 'closed_set',
  required: true,
  values: [
    'MATERIALS',
    'PACKAGING',
    'MARKETING',
    'EQUIPMENT',
    'RENT',
    'UTILITIES',
    'LOGISTICS',
    'FEES',
    'SERVICES',
    'OTHER',
  ],
  aliases: {
    MATERIALS: ['MATERIJAL', 'MAT', 'ROBA', 'SIROVINE'],
    MARKETING: ['REKLAMA', 'ADS', 'PROMO'],
    PACKAGING: ['PAKOVANJE', 'AMBALAZA'],
  },
}

const PROJECT_AXIS: DimensionAxisDef = {
  axis: 'project',
  type: 'open_text',
  required: false,
}

/** Declared in the spec with an empty value list — nothing can ever match it. */
const COST_CENTER_AXIS: DimensionAxisDef = {
  axis: 'cost_center',
  type: 'closed_set',
  required: false,
  values: [],
}

const SMOQUA_AXES: DimensionAxisDef[] = [CATEGORY_AXIS, PROJECT_AXIS, COST_CENTER_AXIS]
const CATEGORY_ONLY: DimensionAxisDef[] = [CATEGORY_AXIS]

const closed = (
  axis: string,
  values: string[],
  aliases?: Record<string, string[]>,
  required = false,
): DimensionAxisDef => ({ axis, type: 'closed_set', required, values, ...(aliases ? { aliases } : {}) })

const open = (axis: string, required = false): DimensionAxisDef => ({
  axis,
  type: 'open_text',
  required,
})

const res = (
  axis: string,
  value: string,
  token: string,
  method: AxisResolution['method'],
): AxisResolution => ({ axis, value, token, method })

// ---------------------------------------------------------------------------
// resolveDimensions — closed_set: exact
// ---------------------------------------------------------------------------

describe('resolveDimensions / closed_set exact matching', () => {
  it.each(['MATERIALS', 'PACKAGING', 'EQUIPMENT', 'RENT', 'FEES'])(
    'resolves the declared value %s exactly',
    (value) => {
      expect(resolveDimensions([value], CATEGORY_ONLY)).toEqual({
        resolved: [res('category', value, value, 'exact')],
        unresolvedTokens: [],
      })
    },
  )

  it.each([
    ['materials', 'MATERIALS'],
    ['Materials', 'MATERIALS'],
    ['mArKeTiNg', 'MARKETING'],
  ])('matches %s exactly despite casing and reports the canonical value %s', (token, value) => {
    expect(resolveDimensions([token], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', value, token, 'exact')],
      unresolvedTokens: [],
    })
  })

  it('reports the token exactly as it was supplied so the caller can consume it', () => {
    const { resolved } = resolveDimensions(['materials'], CATEGORY_ONLY)
    expect(resolved).toEqual([res('category', 'MATERIALS', 'materials', 'exact')])
  })

  it('resolves OTHER only when the user typed it, and calls that an exact match', () => {
    expect(resolveDimensions(['OTHER'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'OTHER', 'OTHER', 'exact')],
      unresolvedTokens: [],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — closed_set: alias (the Serbian vocabulary)
// ---------------------------------------------------------------------------

describe('resolveDimensions / closed_set alias matching', () => {
  it.each([
    ['MATERIJAL', 'MATERIALS'],
    ['MAT', 'MATERIALS'],
    ['ROBA', 'MATERIALS'],
    ['SIROVINE', 'MATERIALS'],
    ['REKLAMA', 'MARKETING'],
    ['ADS', 'MARKETING'],
    ['PROMO', 'MARKETING'],
    ['PAKOVANJE', 'PACKAGING'],
    ['AMBALAZA', 'PACKAGING'],
  ])('resolves the alias %s to %s and marks the method as alias', (token, value) => {
    expect(resolveDimensions([token], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', value, token, 'alias')],
      unresolvedTokens: [],
    })
  })

  it.each([
    ['materijal', 'MATERIALS'],
    ['roba', 'MATERIALS'],
    ['reklama', 'MARKETING'],
  ])('matches the lowercase alias %s to %s without downgrading it to fuzzy', (token, value) => {
    expect(resolveDimensions([token], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', value, token, 'alias')],
      unresolvedTokens: [],
    })
  })

  it('matches AMBALAŽA to PACKAGING as an alias once diacritics are stripped', () => {
    expect(resolveDimensions(['AMBALAŽA'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'PACKAGING', 'AMBALAŽA', 'alias')],
      unresolvedTokens: [],
    })
  })

  it('matches a diacritic-and-case mangled alias ambalaža as an alias, not a fuzzy guess', () => {
    expect(resolveDimensions(['ambalaža'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'PACKAGING', 'ambalaža', 'alias')],
      unresolvedTokens: [],
    })
  })

  it('ignores an alias entry whose canonical key is not a declared value', () => {
    const axes = [closed('category', ['RENT'], { MATERIALS: ['ROBA'] })]
    expect(resolveDimensions(['ROBA'], axes)).toEqual({
      resolved: [],
      unresolvedTokens: ['ROBA'],
    })
  })

  it('resolves an alias for an axis that declares aliases but no values as unresolved', () => {
    const axes: DimensionAxisDef[] = [
      { axis: 'category', type: 'closed_set', required: false, aliases: { MATERIALS: ['ROBA'] } },
    ]
    expect(resolveDimensions(['ROBA'], axes)).toEqual({
      resolved: [],
      unresolvedTokens: ['ROBA'],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — closed_set: fuzzy, and its exact boundary
// ---------------------------------------------------------------------------

describe('resolveDimensions / closed_set fuzzy matching', () => {
  it('resolves the spec typo MATERIJAAL to MATERIALS without a model', () => {
    expect(resolveDimensions(['MATERIJAAL'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIJAAL', 'fuzzy')],
      unresolvedTokens: [],
    })
  })

  it.each([
    ['MATERIALZ', 'MATERIALS'],
    ['PAKOVANE', 'PACKAGING'],
    ['REKLAM', 'MARKETING'],
    ['RENTA', 'RENT'],
  ])('resolves the near-miss %s to %s by fuzzy match', (token, value) => {
    expect(resolveDimensions([token], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', value, token, 'fuzzy')],
      unresolvedTokens: [],
    })
  })

  it('resolves a token at edit distance exactly 2 from an alias', () => {
    // MATERIA -> MATERIJAL is 2 edits (insert J, insert L); -> MATERIALS is 2 (delete L, S)
    expect(resolveDimensions(['MATERIA'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIA', 'fuzzy')],
      unresolvedTokens: [],
    })
  })

  it('refuses a token at edit distance exactly 3 rather than taking the nearest value', () => {
    // MATERI is 3 edits from MATERIALS, from MATERIJAL and from MAT
    expect(resolveDimensions(['MATERI'], CATEGORY_ONLY)).toEqual({
      resolved: [],
      unresolvedTokens: ['MATERI'],
    })
  })

  it('refuses MATERIC and asks, exactly as the synonym contract requires', () => {
    expect(resolveDimensions(['MATERIC'], CATEGORY_ONLY)).toEqual({
      resolved: [],
      unresolvedTokens: ['MATERIC'],
    })
  })

  it('strips diacritics before matching, so pakovanjé is still a plain alias hit', () => {
    expect(resolveDimensions(['pakovanjé'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'PACKAGING', 'pakovanjé', 'alias')],
      unresolvedTokens: [],
    })
  })

  it('returns null-equivalent refusal when two candidates sit at the same edit distance', () => {
    const axes = [closed('code', ['ALPHA', 'ALPHB'])]
    expect(resolveDimensions(['ALPHC'], axes)).toEqual({
      resolved: [],
      unresolvedTokens: ['ALPHC'],
    })
  })

  it('still resolves when two equidistant candidates are aliases of the same canonical value', () => {
    const axes = [closed('code', ['ALPHA'], { ALPHA: ['ALPHB'] })]
    expect(resolveDimensions(['ALPHC'], axes)).toEqual({
      resolved: [res('code', 'ALPHA', 'ALPHC', 'fuzzy')],
      unresolvedTokens: [],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — the load-bearing refusal: unknown is never OTHER
// ---------------------------------------------------------------------------

describe('resolveDimensions / unknown tokens are never silently OTHER', () => {
  it.each(['OSTALO', 'RAZNO', 'PAMUK', 'Kartonaža doo', '42'])(
    'leaves the unknown token %s unresolved instead of falling back to OTHER',
    (token) => {
      const { resolved, unresolvedTokens } = resolveDimensions([token], CATEGORY_ONLY)
      expect(resolved).toEqual([])
      expect(unresolvedTokens).toEqual([token])
    },
  )

  it('never emits OTHER for an unknown token even when OTHER is a declared value', () => {
    const { resolved } = resolveDimensions(['NEPOZNATO'], CATEGORY_ONLY)
    expect(resolved.map((r) => r.value)).not.toContain('OTHER')
  })

  it('does not resolve a token that merely equals the axis name', () => {
    expect(resolveDimensions(['category'], CATEGORY_ONLY)).toEqual({
      resolved: [],
      unresolvedTokens: ['category'],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — open_text
// ---------------------------------------------------------------------------

describe('resolveDimensions / open_text axes', () => {
  it('gives a single leftover token to the one open_text axis verbatim', () => {
    expect(resolveDimensions(['MATERIALS', 'Projekat 1'], SMOQUA_AXES)).toEqual({
      resolved: [
        res('category', 'MATERIALS', 'MATERIALS', 'exact'),
        res('project', 'Projekat 1', 'Projekat 1', 'exact'),
      ],
      unresolvedTokens: [],
    })
  })

  it('preserves the casing and diacritics of an open_text value', () => {
    expect(resolveDimensions(['MAT', 'Projekat Đorđe'], SMOQUA_AXES)).toEqual({
      resolved: [
        res('category', 'MATERIALS', 'MAT', 'alias'),
        res('project', 'Projekat Đorđe', 'Projekat Đorđe', 'exact'),
      ],
      unresolvedTokens: [],
    })
  })

  it('accepts a leftover token that looks like money, because open_text judges nothing', () => {
    expect(resolveDimensions(['200E'], [PROJECT_AXIS])).toEqual({
      resolved: [res('project', '200E', '200E', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('refuses to guess which of two leftovers is the project', () => {
    expect(resolveDimensions(['PAMUK', 'Projekat 1'], [PROJECT_AXIS])).toEqual({
      resolved: [],
      unresolvedTokens: ['PAMUK', 'Projekat 1'],
    })
  })

  it('refuses to guess which open_text axis a lone leftover belongs to', () => {
    expect(resolveDimensions(['Projekat 1'], [open('project'), open('note')])).toEqual({
      resolved: [],
      unresolvedTokens: ['Projekat 1'],
    })
  })

  it('lets a closed_set axis take a token even when an open_text axis is declared first', () => {
    expect(resolveDimensions(['MATERIALS'], [PROJECT_AXIS, CATEGORY_AXIS])).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIALS', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('never fuzzy-matches for an open_text axis; the token is taken as written', () => {
    expect(resolveDimensions(['MATERIJAAL'], [PROJECT_AXIS])).toEqual({
      resolved: [res('project', 'MATERIJAAL', 'MATERIJAAL', 'exact')],
      unresolvedTokens: [],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — cross-axis determinism
// ---------------------------------------------------------------------------

describe('resolveDimensions / a token that could match two axes', () => {
  const twinAxes = [closed('alpha', ['SHARED']), closed('beta', ['SHARED'])]

  it('assigns a token matched equally well by two axes to the first declared axis', () => {
    expect(resolveDimensions(['SHARED'], twinAxes)).toEqual({
      resolved: [res('alpha', 'SHARED', 'SHARED', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('assigns it to the other axis when the declaration order is reversed', () => {
    expect(resolveDimensions(['SHARED'], [twinAxes[1]!, twinAxes[0]!])).toEqual({
      resolved: [res('beta', 'SHARED', 'SHARED', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('returns the identical result when called twice with the same input', () => {
    const a = resolveDimensions(['SHARED'], twinAxes)
    const b = resolveDimensions(['SHARED'], twinAxes)
    expect(a).toEqual(b)
  })

  it('lets an exact match on a later axis beat an alias match on an earlier one', () => {
    const axes = [closed('alpha', ['A_CANON'], { A_CANON: ['BETAVAL'] }), closed('beta', ['BETAVAL'])]
    expect(resolveDimensions(['BETAVAL'], axes)).toEqual({
      resolved: [res('beta', 'BETAVAL', 'BETAVAL', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('lets an alias match on a later axis beat a fuzzy match on an earlier one', () => {
    const axes = [closed('alpha', ['BETAVAX']), closed('beta', ['B_CANON'], { B_CANON: ['BETAVAL'] })]
    expect(resolveDimensions(['BETAVAL'], axes)).toEqual({
      resolved: [res('beta', 'B_CANON', 'BETAVAL', 'alias')],
      unresolvedTokens: [],
    })
  })

  it('consumes a token once, so a second axis cannot also claim it', () => {
    const { resolved } = resolveDimensions(['SHARED'], twinAxes)
    expect(resolved).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — one axis, several candidate tokens
// ---------------------------------------------------------------------------

describe('resolveDimensions / several tokens competing for one axis', () => {
  it('resolves the axis once when two tokens agree on the same canonical value', () => {
    expect(resolveDimensions(['MATERIJAL', 'MAT'], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIJAL', 'alias')],
      unresolvedTokens: [],
    })
  })

  it('refuses the axis entirely when two tokens demand different values for it', () => {
    expect(resolveDimensions(['MATERIALS', 'PACKAGING'], CATEGORY_ONLY)).toEqual({
      resolved: [],
      unresolvedTokens: ['MATERIALS', 'PACKAGING'],
    })
  })

  it('does not spill the losing value of a contested axis onto an open_text axis', () => {
    const { resolved } = resolveDimensions(['MATERIALS', 'PACKAGING'], SMOQUA_AXES)
    expect(resolved).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — the spec's own worked example
// ---------------------------------------------------------------------------

describe('resolveDimensions / the MATERIJAAL PAMUK Projekat 1 message', () => {
  it('resolves the misspelled category deterministically and hands the rest to the caller', () => {
    expect(resolveDimensions(['MATERIJAAL', 'PAMUK', 'Projekat 1'], SMOQUA_AXES)).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIJAAL', 'fuzzy')],
      unresolvedTokens: ['PAMUK', 'Projekat 1'],
    })
  })

  it('produces the same resolution when the tokens arrive in a different order', () => {
    const a = resolveDimensions(['MATERIJAAL', 'PAMUK', 'Projekat 1'], SMOQUA_AXES)
    const b = resolveDimensions(['PAMUK', 'Projekat 1', 'MATERIJAAL'], SMOQUA_AXES)
    expect(b.resolved).toEqual(a.resolved)
  })

  it('returns unresolved tokens in the order they were supplied', () => {
    const { unresolvedTokens } = resolveDimensions(['PAMUK', 'MATERIALS', 'Projekat 1'], CATEGORY_ONLY)
    expect(unresolvedTokens).toEqual(['PAMUK', 'Projekat 1'])
  })
})

// ---------------------------------------------------------------------------
// resolveDimensions — empty, absent and malformed input
// ---------------------------------------------------------------------------

describe('resolveDimensions / empty and malformed input', () => {
  it('returns nothing resolved and nothing unresolved for an empty token list', () => {
    expect(resolveDimensions([], SMOQUA_AXES)).toEqual({ resolved: [], unresolvedTokens: [] })
  })

  it('leaves every token unresolved when the book declares no axes at all', () => {
    expect(resolveDimensions(['MATERIALS', 'PAMUK'], [])).toEqual({
      resolved: [],
      unresolvedTokens: ['MATERIALS', 'PAMUK'],
    })
  })

  it('resolves nothing against a closed_set axis declared with an empty value list', () => {
    expect(resolveDimensions(['ANYTHING'], [COST_CENTER_AXIS])).toEqual({
      resolved: [],
      unresolvedTokens: ['ANYTHING'],
    })
  })

  it('resolves nothing against a closed_set axis that omits values entirely', () => {
    const axes: DimensionAxisDef[] = [{ axis: 'cost_center', type: 'closed_set', required: false }]
    expect(resolveDimensions(['ANYTHING'], axes)).toEqual({
      resolved: [],
      unresolvedTokens: ['ANYTHING'],
    })
  })

  it('drops blank tokens rather than offering them to any axis', () => {
    expect(resolveDimensions(['', '   '], CATEGORY_ONLY).resolved).toEqual([])
  })

  it('does not let an empty token match an empty declared value', () => {
    expect(resolveDimensions([''], [closed('code', ['', 'RENT'])]).resolved).toEqual([])
  })

  it('ignores surrounding whitespace on a token when matching a closed set', () => {
    expect(resolveDimensions(['  MATERIALS  '], CATEGORY_ONLY)).toEqual({
      resolved: [res('category', 'MATERIALS', '  MATERIALS  ', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('uses the first declaration when the same axis name is declared twice', () => {
    const axes = [closed('category', ['RENT']), closed('category', ['MATERIALS'])]
    expect(resolveDimensions(['RENT'], axes)).toEqual({
      resolved: [res('category', 'RENT', 'RENT', 'exact')],
      unresolvedTokens: [],
    })
  })

  it('does not mutate the token list it was given', () => {
    const tokens = ['MATERIALS', 'PAMUK']
    resolveDimensions(tokens, SMOQUA_AXES)
    expect(tokens).toEqual(['MATERIALS', 'PAMUK'])
  })

  it('does not mutate the axis definitions it was given', () => {
    const axes = [closed('category', ['MATERIALS'], { MATERIALS: ['ROBA'] })]
    const snapshot = structuredClone(axes)
    resolveDimensions(['ROBA'], axes)
    expect(axes).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// missingRequiredAxes
// ---------------------------------------------------------------------------

describe('missingRequiredAxes', () => {
  it('reports nothing when every required axis carries a value', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, SMOQUA_AXES)).toEqual([])
  })

  it('reports the required axis when the key is absent from the value map', () => {
    expect(missingRequiredAxes({ project: 'Projekat 1' }, SMOQUA_AXES)).toEqual(['category'])
  })

  it('reports every required axis when the value map is empty', () => {
    expect(missingRequiredAxes({}, SMOQUA_AXES)).toEqual(['category'])
  })

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('treats a required axis set to %s as missing', (_label, value) => {
    expect(missingRequiredAxes({ category: value }, SMOQUA_AXES)).toEqual(['category'])
  })

  it.each([
    ['a declared value', 'MATERIALS'],
    ['an undeclared value', 'NOT_A_CATEGORY'],
    ['the string zero', '0'],
    ['a padded value', ' MATERIALS '],
  ])('treats a required axis set to %s as present', (_label, value) => {
    expect(missingRequiredAxes({ category: value }, SMOQUA_AXES)).toEqual([])
  })

  it('never reports an optional axis, however empty it is', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS', project: null, cost_center: '' }, SMOQUA_AXES)).toEqual([])
  })

  it('reports a required open_text axis that has no value', () => {
    const axes = [CATEGORY_AXIS, open('project', true)]
    expect(missingRequiredAxes({ category: 'MATERIALS' }, axes)).toEqual(['project'])
  })

  it('lists several missing axes in declaration order', () => {
    const axes = [closed('a', ['X'], undefined, true), open('b', true), closed('c', ['Y'], undefined, true)]
    expect(missingRequiredAxes({ b: null }, axes)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty list when the book declares no axes', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [])).toEqual([])
  })

  it('returns an empty list when no declared axis is required', () => {
    expect(missingRequiredAxes({}, [PROJECT_AXIS, COST_CENTER_AXIS])).toEqual([])
  })

  it('ignores values for axes the book never declared', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS', campaign: 'Q3' }, SMOQUA_AXES)).toEqual([])
  })

  it('does not mutate the value map it was given', () => {
    const values: DimensionValues = { category: null }
    missingRequiredAxes(values, SMOQUA_AXES)
    expect(values).toEqual({ category: null })
  })
})

// ---------------------------------------------------------------------------
// recentAxisValues
// ---------------------------------------------------------------------------

/** Chronological, oldest first — the order an append-only ledger folds into. */
const HISTORY: DimensionValues[] = [
  { category: 'MATERIALS', project: 'Projekat 1' },
  { category: 'PACKAGING', project: 'Projekat 2' },
  { category: 'MATERIALS', project: null },
  { category: 'MARKETING', project: 'Projekat 1' },
  { category: 'MATERIALS', project: 'Projekat 3' },
]

const SEVEN: DimensionValues[] = [
  { project: 'P1' },
  { project: 'P2' },
  { project: 'P3' },
  { project: 'P4' },
  { project: 'P5' },
  { project: 'P6' },
  { project: 'P7' },
]

describe('recentAxisValues', () => {
  it('returns previously used values most recent first', () => {
    expect(recentAxisValues('project', HISTORY)).toEqual(['Projekat 3', 'Projekat 1', 'Projekat 2'])
  })

  it('lists a repeated value once, at its most recent position', () => {
    const history: DimensionValues[] = [
      { project: 'Projekat 1' },
      { project: 'Projekat 2' },
      { project: 'Projekat 1' },
    ]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1', 'Projekat 2'])
  })

  it('skips entries where the axis is null', () => {
    expect(recentAxisValues('project', HISTORY)).not.toContain(null)
  })

  it('skips entries that do not carry the axis at all', () => {
    const history: DimensionValues[] = [{ category: 'MATERIALS' }, { project: 'Projekat 1' }]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1'])
  })

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('skips a value that is %s', (_label, value) => {
    const history: DimensionValues[] = [{ project: 'Projekat 1' }, { project: value }]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1'])
  })

  it('trims a padded value and folds it into its untrimmed twin', () => {
    const history: DimensionValues[] = [{ project: 'Projekat 1' }, { project: '  Projekat 1  ' }]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1'])
  })

  it('folds two casings of the same value together, keeping the most recent spelling', () => {
    const history: DimensionValues[] = [{ project: 'projekat 1' }, { project: 'Projekat 1' }]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1'])
  })

  it('preserves diacritics in the value it offers back', () => {
    expect(recentAxisValues('project', [{ project: 'Projekat Đorđe' }])).toEqual(['Projekat Đorđe'])
  })

  it('returns an empty list for an empty history', () => {
    expect(recentAxisValues('project', [])).toEqual([])
  })

  it('returns an empty list for an axis that appears nowhere in the history', () => {
    expect(recentAxisValues('campaign', HISTORY)).toEqual([])
  })

  it('returns an empty list when every entry for the axis is null', () => {
    expect(recentAxisValues('project', [{ project: null }, { project: null }])).toEqual([])
  })

  it('reads a closed_set axis from history the same way it reads an open_text one', () => {
    expect(recentAxisValues('category', HISTORY)).toEqual(['MATERIALS', 'MARKETING', 'PACKAGING'])
  })

  it('returns at most five values when no limit is given', () => {
    expect(recentAxisValues('project', SEVEN)).toEqual(['P7', 'P6', 'P5', 'P4', 'P3'])
  })

  it.each([
    [1, ['P7']],
    [2, ['P7', 'P6']],
    [5, ['P7', 'P6', 'P5', 'P4', 'P3']],
    [6, ['P7', 'P6', 'P5', 'P4', 'P3', 'P2']],
    [7, ['P7', 'P6', 'P5', 'P4', 'P3', 'P2', 'P1']],
  ])('returns exactly %i values when that is the limit', (limit, expected) => {
    expect(recentAxisValues('project', SEVEN, limit)).toEqual(expected)
  })

  it('returns an empty list when the limit is exactly zero', () => {
    expect(recentAxisValues('project', SEVEN, 0)).toEqual([])
  })

  it('returns an empty list when the limit is negative', () => {
    expect(recentAxisValues('project', SEVEN, -1)).toEqual([])
  })

  it('returns everything it has when the limit exceeds the number of distinct values', () => {
    expect(recentAxisValues('project', SEVEN, 99)).toEqual(['P7', 'P6', 'P5', 'P4', 'P3', 'P2', 'P1'])
  })

  it('applies the limit after deduplication, not before', () => {
    const history: DimensionValues[] = [
      { project: 'A' },
      { project: 'B' },
      { project: 'B' },
      { project: 'B' },
    ]
    expect(recentAxisValues('project', history, 2)).toEqual(['B', 'A'])
  })

  it('does not mutate the history it was given', () => {
    const history = structuredClone(HISTORY)
    recentAxisValues('project', history)
    expect(history).toEqual(HISTORY)
  })

  it('returns the identical list when called twice with the same history', () => {
    expect(recentAxisValues('project', HISTORY)).toEqual(recentAxisValues('project', HISTORY))
  })
})
