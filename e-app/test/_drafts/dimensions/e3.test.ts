import { describe, it, expect } from 'vitest'
import {
  resolveDimensions,
  missingRequiredAxes,
  recentAxisValues,
  type AxisResolution,
} from '../../../src/core/dimensions.js'
import type { DimensionAxisDef, DimensionValues } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Fixtures — the SMOQUA axes exactly as declared in 05-SMOQUA.md §2.
// ---------------------------------------------------------------------------

const CATEGORY: DimensionAxisDef = {
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
}

const PROJECT: DimensionAxisDef = { axis: 'project', type: 'open_text', required: false }

const COST_CENTER: DimensionAxisDef = {
  axis: 'cost_center', type: 'closed_set', required: false, values: [],
}

/** The full book declaration. Note it contains an open_text axis, which swallows leftovers. */
const SMOQUA_AXES: DimensionAxisDef[] = [CATEGORY, PROJECT, COST_CENTER]

/** No open_text axis — used whenever a test needs to observe unresolved tokens. */
const CLOSED_ONLY: DimensionAxisDef[] = [CATEGORY, COST_CENTER]

// helpers -------------------------------------------------------------------

function byAxis(resolved: AxisResolution[], axis: string): AxisResolution | undefined {
  return resolved.find((r) => r.axis === axis)
}

function valueOf(resolved: AxisResolution[], axis: string): string | undefined {
  return byAxis(resolved, axis)?.value
}

function closed(axis: string, values: string[], aliases?: Record<string, string[]>): DimensionAxisDef {
  return aliases
    ? { axis, type: 'closed_set', required: false, values, aliases }
    : { axis, type: 'closed_set', required: false, values }
}

// ---------------------------------------------------------------------------
// closed_set — exact
// ---------------------------------------------------------------------------

describe('resolveDimensions — closed_set exact matching', () => {
  it.each([
    'MATERIALS', 'PACKAGING', 'EQUIPMENT', 'LOGISTICS',
  ])('resolves the declared value %s to itself by exact match', (value) => {
    const { resolved, unresolvedTokens } = resolveDimensions([value], CLOSED_ONLY)

    expect(resolved).toEqual([{ axis: 'category', value, token: value, method: 'exact' }])
    expect(unresolvedTokens).toEqual([])
  })

  it('matches a declared value regardless of the case the user typed', () => {
    const { resolved } = resolveDimensions(['materials'], CLOSED_ONLY)

    expect(resolved).toEqual([
      { axis: 'category', value: 'MATERIALS', token: 'materials', method: 'exact' },
    ])
  })

  it('reports the original token, not the normalised one, so the caller can consume it', () => {
    const { resolved } = resolveDimensions(['MaTeRiAlS'], CLOSED_ONLY)

    expect(byAxis(resolved, 'category')?.token).toBe('MaTeRiAlS')
  })

  it('resolves OTHER when the user typed OTHER explicitly', () => {
    const { resolved } = resolveDimensions(['OTHER'], CLOSED_ONLY)

    expect(resolved).toEqual([
      { axis: 'category', value: 'OTHER', token: 'OTHER', method: 'exact' },
    ])
  })
})

// ---------------------------------------------------------------------------
// closed_set — aliases (the Serbian ones are the point of the feature)
// ---------------------------------------------------------------------------

describe('resolveDimensions — closed_set alias matching', () => {
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
  ])('resolves the alias %s to the canonical value %s', (token, expected) => {
    const { resolved, unresolvedTokens } = resolveDimensions([token], CLOSED_ONLY)

    expect(resolved).toEqual([{ axis: 'category', value: expected, token, method: 'alias' }])
    expect(unresolvedTokens).toEqual([])
  })

  it.each([
    ['materijal', 'MATERIALS'],
    ['Roba', 'MATERIALS'],
    ['sirovine', 'MATERIALS'],
  ])('matches the Serbian alias %s case-insensitively', (token, expected) => {
    expect(valueOf(resolveDimensions([token], CLOSED_ONLY).resolved, 'category')).toBe(expected)
  })

  it.each([
    ['AMBALAŽA', 'PACKAGING'],
    ['ambalaža', 'PACKAGING'],
  ])('strips diacritics so %s still matches the ASCII alias', (token, expected) => {
    const { resolved } = resolveDimensions([token], CLOSED_ONLY)

    expect(byAxis(resolved, 'category')).toEqual({
      axis: 'category', value: expected, token, method: 'alias',
    })
  })

  it('ignores an alias whose canonical value is not declared in values', () => {
    const axes = [closed('x', ['ALPHA'], { GAMMA: ['GG'] })]

    const { resolved, unresolvedTokens } = resolveDimensions(['GG'], axes)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['GG'])
  })
})

// ---------------------------------------------------------------------------
// closed_set — fuzzy, and its exact boundary
// ---------------------------------------------------------------------------

describe('resolveDimensions — closed_set fuzzy matching at edit distance <= 2', () => {
  it('resolves MATERIJAAL to MATERIALS without a model, as 05-SMOQUA §2 requires', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERIJAAL'], CLOSED_ONLY)

    expect(resolved).toEqual([
      { axis: 'category', value: 'MATERIALS', token: 'MATERIJAAL', method: 'fuzzy' },
    ])
    expect(unresolvedTokens).toEqual([])
  })

  it.each([
    ['MATERIAL', 1],
    ['MATERIA', 2],
  ])('accepts %s because it is edit distance %i from MATERIALS', (token) => {
    const { resolved } = resolveDimensions([token], CLOSED_ONLY)

    expect(byAxis(resolved, 'category')).toEqual({
      axis: 'category', value: 'MATERIALS', token, method: 'fuzzy',
    })
  })

  it('refuses MATERI, which is edit distance 3 from every value and alias', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERI'], CLOSED_ONLY)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['MATERI'])
  })

  it('refuses MATERIC, the case 06-TDD-STRATEGY names as "no match, ask"', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERIC'], CLOSED_ONLY)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['MATERIC'])
  })

  it('accepts a token exactly 2 edits from an alias', () => {
    // ROBA -> ROBAX -> ROBAXY is distance 2 from the MATERIALS alias ROBA.
    const { resolved } = resolveDimensions(['ROBAXY'], CLOSED_ONLY)

    expect(byAxis(resolved, 'category')).toEqual({
      axis: 'category', value: 'MATERIALS', token: 'ROBAXY', method: 'fuzzy',
    })
  })

  it('refuses a token exactly 3 edits from an alias', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['ROBAXYZ'], CLOSED_ONLY)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['ROBAXYZ'])
  })

  it('returns null-equivalent (unresolved) when a token is equidistant from two values of one axis', () => {
    const axes = [closed('amb', ['ALFA', 'ALFB'])]

    const { resolved, unresolvedTokens } = resolveDimensions(['ALFX'], axes)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['ALFX'])
  })

  it('prefers the closer candidate when two fuzzy candidates are not tied', () => {
    const axes = [closed('amb', ['ALFA', 'ALFBBB'])]

    // ALFAB: distance 1 from ALFA, distance 2 from ALFBBB.
    expect(valueOf(resolveDimensions(['ALFAB'], axes).resolved, 'amb')).toBe('ALFA')
  })
})

// ---------------------------------------------------------------------------
// The refusal that matters most: unknown is never OTHER.
// ---------------------------------------------------------------------------

describe('resolveDimensions — an unknown token is never silently OTHER', () => {
  it.each([
    'ZZZTOP',
    'PAMUK',
    'KARTONAZA',
    'X',
    '200E',
    '12000',
    '???',
  ])('leaves %s unresolved rather than defaulting it to OTHER', (token) => {
    const { resolved, unresolvedTokens } = resolveDimensions([token], CLOSED_ONLY)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual([token])
  })

  it('leaves the category axis empty when nothing in the message resolves', () => {
    const { resolved } = resolveDimensions(['PAMUK', 'ZZZTOP'], CLOSED_ONLY)

    expect(byAxis(resolved, 'category')).toBeUndefined()
  })

  it('resolves the known token and refuses the unknown one in the same message', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['ROBA', 'ZZZTOP'], CLOSED_ONLY)

    expect(valueOf(resolved, 'category')).toBe('MATERIALS')
    expect(unresolvedTokens).toEqual(['ZZZTOP'])
  })
})

// ---------------------------------------------------------------------------
// Empty / absent / malformed input
// ---------------------------------------------------------------------------

describe('resolveDimensions — empty, absent and malformed input', () => {
  it('returns nothing for an empty token list', () => {
    expect(resolveDimensions([], SMOQUA_AXES)).toEqual({ resolved: [], unresolvedTokens: [] })
  })

  it('returns nothing for an empty axis list', () => {
    expect(resolveDimensions([], [])).toEqual({ resolved: [], unresolvedTokens: [] })
  })

  it('leaves every token unresolved when the book declares no axes', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERIALS', 'PAMUK'], [])

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['MATERIALS', 'PAMUK'])
  })

  it.each([[''], ['   '], ['\t']])('drops the blank token %j entirely', (token) => {
    expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({ resolved: [], unresolvedTokens: [] })
  })

  it('never resolves a closed_set axis declared with an empty value list', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['ANYTHING'], [COST_CENTER])

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['ANYTHING'])
  })

  it('treats a closed_set axis with no values property as matching nothing, without throwing', () => {
    const axes: DimensionAxisDef[] = [{ axis: 'broken', type: 'closed_set', required: false }]

    expect(resolveDimensions(['MATERIALS'], axes)).toEqual({
      resolved: [], unresolvedTokens: ['MATERIALS'],
    })
  })

  it('does not mutate the tokens it was given', () => {
    const tokens = ['ROBA', 'ZZZTOP']

    resolveDimensions(tokens, CLOSED_ONLY)

    expect(tokens).toEqual(['ROBA', 'ZZZTOP'])
  })

  it('does not mutate the axis definitions it was given', () => {
    const axes: DimensionAxisDef[] = [closed('x', ['ALPHA'], { ALPHA: ['A1'] })]
    const snapshot = JSON.parse(JSON.stringify(axes))

    resolveDimensions(['A1'], axes)

    expect(axes).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// Determinism when a token could belong to more than one axis
// ---------------------------------------------------------------------------

describe('resolveDimensions — a token that could match two axes resolves deterministically', () => {
  const A = closed('a', ['SHARED', 'ALPHA'])
  const B = closed('b', ['SHARED', 'BETA'])

  it('gives the token to the first-declared axis when both match it exactly', () => {
    const { resolved } = resolveDimensions(['SHARED'], [A, B])

    expect(resolved).toEqual([{ axis: 'a', value: 'SHARED', token: 'SHARED', method: 'exact' }])
  })

  it('gives the token to the other axis when the declaration order is reversed', () => {
    const { resolved } = resolveDimensions(['SHARED'], [B, A])

    expect(resolved).toEqual([{ axis: 'b', value: 'SHARED', token: 'SHARED', method: 'exact' }])
  })

  it('produces the same answer on repeated calls with the same input', () => {
    const first = resolveDimensions(['SHARED', 'ALPHA'], [A, B])
    const second = resolveDimensions(['SHARED', 'ALPHA'], [A, B])

    expect(second).toEqual(first)
  })

  it('prefers an exact match on a later axis over a fuzzy match on an earlier one', () => {
    const axes = [closed('first', ['ALPHX']), closed('second', ['ALPHA'])]

    const { resolved } = resolveDimensions(['ALPHA'], axes)

    expect(resolved).toEqual([{ axis: 'second', value: 'ALPHA', token: 'ALPHA', method: 'exact' }])
  })

  it('prefers an alias match on a later axis over a fuzzy match on an earlier one', () => {
    const axes = [closed('first', ['ALPHX']), closed('second', ['CANON'], { CANON: ['ALPHA'] })]

    const { resolved } = resolveDimensions(['ALPHA'], axes)

    expect(resolved).toEqual([{ axis: 'second', value: 'CANON', token: 'ALPHA', method: 'alias' }])
  })

  it('prefers an exact match on a later axis over an alias match on an earlier one', () => {
    const axes = [closed('first', ['CANON'], { CANON: ['ZETA'] }), closed('second', ['ZETA'])]

    const { resolved } = resolveDimensions(['ZETA'], axes)

    expect(resolved).toEqual([{ axis: 'second', value: 'ZETA', token: 'ZETA', method: 'exact' }])
  })

  it('refuses a token that is an equally close fuzzy candidate on two different axes', () => {
    const axes = [closed('first', ['ALFA']), closed('second', ['ALFB'])]

    const { resolved, unresolvedTokens } = resolveDimensions(['ALFX'], axes)

    expect(resolved).toEqual([])
    expect(unresolvedTokens).toEqual(['ALFX'])
  })

  it('fills each axis at most once, keeping the first token and refusing the second', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERIALS', 'PACKAGING'], CLOSED_ONLY)

    expect(resolved).toEqual([
      { axis: 'category', value: 'MATERIALS', token: 'MATERIALS', method: 'exact' },
    ])
    expect(unresolvedTokens).toEqual(['PACKAGING'])
  })

  it('resolves an axis exactly once when the same token appears twice', () => {
    const { resolved } = resolveDimensions(['ROBA', 'ROBA'], CLOSED_ONLY)

    expect(resolved.filter((r) => r.axis === 'category')).toHaveLength(1)
  })

  it('reports resolutions in the order the tokens appeared', () => {
    const axes = [closed('a', ['ALPHA']), closed('b', ['BETA'])]

    const { resolved } = resolveDimensions(['BETA', 'ALPHA'], axes)

    expect(resolved.map((r) => r.axis)).toEqual(['b', 'a'])
  })
})

// ---------------------------------------------------------------------------
// open_text
// ---------------------------------------------------------------------------

describe('resolveDimensions — open_text axes', () => {
  const CAT_AND_PROJECT: DimensionAxisDef[] = [CATEGORY, PROJECT]

  it('accepts a leftover token that no closed_set axis claimed', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(['MATERIALS', 'Projekat'], CAT_AND_PROJECT)

    expect(valueOf(resolved, 'category')).toBe('MATERIALS')
    expect(valueOf(resolved, 'project')).toBe('Projekat')
    expect(unresolvedTokens).toEqual([])
  })

  it('keeps the open_text value verbatim, with its original case and diacritics', () => {
    const { resolved } = resolveDimensions(['Šuma'], CAT_AND_PROJECT)

    expect(valueOf(resolved, 'project')).toBe('Šuma')
  })

  it('joins several leftover tokens into one value in input order', () => {
    const { resolved } = resolveDimensions(['Projekat', '1'], CAT_AND_PROJECT)

    expect(byAxis(resolved, 'project')).toEqual({
      axis: 'project', value: 'Projekat 1', token: 'Projekat 1', method: 'exact',
    })
  })

  it('does not take a token a closed_set axis already consumed', () => {
    const { resolved } = resolveDimensions(['ROBA'], CAT_AND_PROJECT)

    expect(valueOf(resolved, 'category')).toBe('MATERIALS')
    expect(byAxis(resolved, 'project')).toBeUndefined()
  })

  it('does not take a token a closed_set axis consumed by fuzzy match either', () => {
    const { resolved } = resolveDimensions(['MATERIJAAL'], CAT_AND_PROJECT)

    expect(valueOf(resolved, 'category')).toBe('MATERIALS')
    expect(byAxis(resolved, 'project')).toBeUndefined()
  })

  it('leaves the open_text axis absent rather than empty when there are no leftovers', () => {
    const { resolved } = resolveDimensions(['MATERIALS'], CAT_AND_PROJECT)

    expect(resolved).toHaveLength(1)
    expect(byAxis(resolved, 'project')).toBeUndefined()
  })

  it('reports no unresolved tokens at all while an open_text axis is declared', () => {
    const { unresolvedTokens } = resolveDimensions(['ZZZTOP', 'PAMUK', '???'], CAT_AND_PROJECT)

    expect(unresolvedTokens).toEqual([])
  })

  it('gives all leftovers to the first-declared open_text axis when two are declared', () => {
    const second: DimensionAxisDef = { axis: 'note', type: 'open_text', required: false }

    const { resolved } = resolveDimensions(['Projekat'], [CATEGORY, PROJECT, second])

    expect(valueOf(resolved, 'project')).toBe('Projekat')
    expect(byAxis(resolved, 'note')).toBeUndefined()
  })

  it('gives them to the other open_text axis when the declaration order is reversed', () => {
    const second: DimensionAxisDef = { axis: 'note', type: 'open_text', required: false }

    const { resolved } = resolveDimensions(['Projekat'], [CATEGORY, second, PROJECT])

    expect(valueOf(resolved, 'note')).toBe('Projekat')
    expect(byAxis(resolved, 'project')).toBeUndefined()
  })

  it('reads the SMOQUA message "MATERIJAAL Projekat 1" as a fuzzy category plus a project', () => {
    // The caller has already consumed the amount (200E) and the description (PAMUK).
    const { resolved, unresolvedTokens } = resolveDimensions(
      ['MATERIJAAL', 'Projekat', '1'],
      SMOQUA_AXES,
    )

    expect(byAxis(resolved, 'category')).toEqual({
      axis: 'category', value: 'MATERIALS', token: 'MATERIJAAL', method: 'fuzzy',
    })
    expect(valueOf(resolved, 'project')).toBe('Projekat 1')
    expect(byAxis(resolved, 'cost_center')).toBeUndefined()
    expect(unresolvedTokens).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// missingRequiredAxes
// ---------------------------------------------------------------------------

describe('missingRequiredAxes', () => {
  const REQUIRED_PROJECT: DimensionAxisDef = { ...PROJECT, required: true }

  it('reports nothing when every required axis has a value', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, SMOQUA_AXES)).toEqual([])
  })

  it('reports a required axis that is absent from the value map', () => {
    expect(missingRequiredAxes({}, SMOQUA_AXES)).toEqual(['category'])
  })

  it('reports a required axis whose value is null', () => {
    expect(missingRequiredAxes({ category: null }, SMOQUA_AXES)).toEqual(['category'])
  })

  it.each([[''], ['   '], ['\t\n']])('reports a required axis whose value is the blank string %j', (value) => {
    expect(missingRequiredAxes({ category: value }, SMOQUA_AXES)).toEqual(['category'])
  })

  it('never reports an optional axis, however empty it is', () => {
    expect(missingRequiredAxes({ project: null, cost_center: '' }, SMOQUA_AXES)).toEqual([])
  })

  it('enforces a required open_text axis the same way as a closed_set one', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [CATEGORY, REQUIRED_PROJECT]))
      .toEqual(['project'])
  })

  it('lists several missing axes in declaration order', () => {
    expect(missingRequiredAxes({}, [CATEGORY, REQUIRED_PROJECT])).toEqual(['category', 'project'])
  })

  it('lists them in the reversed declaration order when the book declares them reversed', () => {
    expect(missingRequiredAxes({}, [REQUIRED_PROJECT, CATEGORY])).toEqual(['project', 'category'])
  })

  it('returns nothing when the book declares no axes', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [])).toEqual([])
  })

  it('returns nothing for an empty value map when no axis is required', () => {
    expect(missingRequiredAxes({}, [PROJECT, COST_CENTER])).toEqual([])
  })

  it('ignores values for axes the book does not declare', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS', supplier_batch: 'B7' }, SMOQUA_AXES))
      .toEqual([])
  })

  it('reports presence only — a value outside the closed set is present, not missing', () => {
    expect(missingRequiredAxes({ category: 'BANANAS' }, SMOQUA_AXES)).toEqual([])
  })

  it('does not mutate the values it was given', () => {
    const values: DimensionValues = { category: null }

    missingRequiredAxes(values, SMOQUA_AXES)

    expect(values).toEqual({ category: null })
  })
})

// ---------------------------------------------------------------------------
// recentAxisValues
// ---------------------------------------------------------------------------

describe('recentAxisValues', () => {
  // Chronological, oldest first — the order an append-only ledger produces.
  const HISTORY: DimensionValues[] = [
    { category: 'MATERIALS', project: 'Projekat 1' },
    { category: 'PACKAGING', project: 'Projekat 2' },
    { category: 'MATERIALS', project: 'Projekat 1' },
    { category: 'MARKETING', project: null },
    { category: 'MARKETING' },
    { category: 'LOGISTICS', project: 'Projekat 3' },
  ]

  it('returns previously used values most recent first', () => {
    expect(recentAxisValues('project', HISTORY))
      .toEqual(['Projekat 3', 'Projekat 1', 'Projekat 2'])
  })

  it('lists a repeated value once, at its most recent position', () => {
    const history: DimensionValues[] = [
      { project: 'A' }, { project: 'B' }, { project: 'A' },
    ]

    expect(recentAxisValues('project', history)).toEqual(['A', 'B'])
  })

  it('skips entries where the axis is null', () => {
    expect(recentAxisValues('project', [{ project: null }, { project: 'A' }])).toEqual(['A'])
  })

  it('skips entries where the axis is absent altogether', () => {
    expect(recentAxisValues('project', [{ category: 'RENT' }, { project: 'A' }])).toEqual(['A'])
  })

  it.each([[''], ['   ']])('skips the blank value %j', (blank) => {
    expect(recentAxisValues('project', [{ project: blank }, { project: 'A' }])).toEqual(['A'])
  })

  it('treats values differing only in case as two distinct buttons', () => {
    const history: DimensionValues[] = [{ project: 'projekat 1' }, { project: 'Projekat 1' }]

    expect(recentAxisValues('project', history)).toEqual(['Projekat 1', 'projekat 1'])
  })

  it('returns nothing for an empty history', () => {
    expect(recentAxisValues('project', [])).toEqual([])
  })

  it('returns nothing for an axis that has never been used', () => {
    expect(recentAxisValues('supplier_batch', HISTORY)).toEqual([])
  })

  it('works for any axis name, including a closed_set one', () => {
    expect(recentAxisValues('category', HISTORY))
      .toEqual(['LOGISTICS', 'MARKETING', 'MATERIALS', 'PACKAGING'])
  })

  it.each([
    [1, ['Projekat 3']],
    [2, ['Projekat 3', 'Projekat 1']],
    [3, ['Projekat 3', 'Projekat 1', 'Projekat 2']],
    [4, ['Projekat 3', 'Projekat 1', 'Projekat 2']],
  ])('returns the %i most recently used values when that limit is given', (limit, expected) => {
    expect(recentAxisValues('project', HISTORY, limit)).toEqual(expected)
  })

  it('returns nothing when the limit is exactly zero', () => {
    expect(recentAxisValues('project', HISTORY, 0)).toEqual([])
  })

  it('returns nothing when the limit is negative', () => {
    expect(recentAxisValues('project', HISTORY, -1)).toEqual([])
  })

  it('counts the limit in distinct values, not in history entries', () => {
    const history: DimensionValues[] = [
      { project: 'A' }, { project: 'B' }, { project: 'B' }, { project: 'B' },
    ]

    expect(recentAxisValues('project', history, 2)).toEqual(['B', 'A'])
  })

  it('returns every distinct value when no limit is given and there are only three', () => {
    expect(recentAxisValues('project', HISTORY)).toHaveLength(3)
  })

  it('does not mutate the history it was given', () => {
    const history: DimensionValues[] = [{ project: 'A' }, { project: 'B' }]

    recentAxisValues('project', history)

    expect(history).toEqual([{ project: 'A' }, { project: 'B' }])
  })
})
