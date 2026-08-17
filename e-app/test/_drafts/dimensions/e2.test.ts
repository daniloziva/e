import { describe, it, expect } from 'vitest'
import {
  resolveDimensions,
  missingRequiredAxes,
  recentAxisValues,
  type AxisResolution,
} from '../../../src/engine/dimensions.js'
import type { DimensionAxisDef, DimensionValues } from '../../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Fixtures — the SMOQUA axes exactly as declared in 05-SMOQUA.md §2.
// ---------------------------------------------------------------------------

const CATEGORY: DimensionAxisDef = {
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

const PROJECT: DimensionAxisDef = { axis: 'project', type: 'open_text', required: false }

/** Declared but with no members yet — nothing may ever resolve to it. */
const COST_CENTER: DimensionAxisDef = {
  axis: 'cost_center',
  type: 'closed_set',
  required: false,
  values: [],
}

const SMOQUA_AXES: DimensionAxisDef[] = [CATEGORY, PROJECT, COST_CENTER]

type Result = { resolved: AxisResolution[]; unresolvedTokens: string[] }

const byAxis = (r: Result, axis: string): AxisResolution | undefined =>
  r.resolved.find((x) => x.axis === axis)

// ---------------------------------------------------------------------------
// closed_set — exact
// ---------------------------------------------------------------------------

describe('resolveDimensions — closed_set exact matching', () => {
  it.each(['MATERIALS', 'RENT', 'SERVICES'])(
    'resolves the declared value %s exactly',
    (token) => {
      const r = resolveDimensions([token], [CATEGORY])
      expect(r.resolved).toEqual([{ axis: 'category', value: token, token, method: 'exact' }])
      expect(r.unresolvedTokens).toEqual([])
    },
  )

  it('resolves OTHER when OTHER is what the user actually typed', () => {
    const r = resolveDimensions(['OTHER'], [CATEGORY])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'OTHER',
      token: 'OTHER',
      method: 'exact',
    })
  })

  it.each(['materials', 'mAtErIaLs'])(
    'treats case as noise, so %s is still an exact match',
    (token) => {
      const r = resolveDimensions([token], [CATEGORY])
      expect(byAxis(r, 'category')).toEqual({
        axis: 'category',
        value: 'MATERIALS',
        token,
        method: 'exact',
      })
    },
  )

  it('returns the canonical value while echoing the token the user typed', () => {
    const r = resolveDimensions(['materijal'], [CATEGORY])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
    expect(byAxis(r, 'category')?.token).toBe('materijal')
  })

  it('never resolves anything to a closed_set axis that declares an empty value list', () => {
    const r = resolveDimensions(['ANYTHING', 'MATERIALS'], [COST_CENTER])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['ANYTHING', 'MATERIALS'])
  })

  it('treats a closed_set axis with no values property as having nothing to match', () => {
    const noValues: DimensionAxisDef = { axis: 'cost_center', type: 'closed_set', required: false }
    const r = resolveDimensions(['MATERIALS'], [noValues])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['MATERIALS'])
  })
})

// ---------------------------------------------------------------------------
// closed_set — Serbian aliases
// ---------------------------------------------------------------------------

describe('resolveDimensions — Serbian aliases', () => {
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
  ])('resolves the alias %s to %s by alias, not by fuzz', (token, expected) => {
    const r = resolveDimensions([token], [CATEGORY])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: expected,
      token,
      method: 'alias',
    })
  })

  it.each(['AMBALAŽA', 'ambalaža'])(
    'strips diacritics so %s still resolves through the AMBALAZA alias',
    (token) => {
      const r = resolveDimensions([token], [CATEGORY])
      expect(byAxis(r, 'category')).toEqual({
        axis: 'category',
        value: 'PACKAGING',
        token,
        method: 'alias',
      })
    },
  )

  it('resolves an alias whose canonical key is declared only in the alias map', () => {
    const axis: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['RENT'],
      aliases: { UTILITIES: ['STRUJA'] },
    }
    const r = resolveDimensions(['STRUJA'], [axis])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'UTILITIES',
      token: 'STRUJA',
      method: 'alias',
    })
  })

  it('prefers an exact value over an alias that points somewhere else', () => {
    const axis: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['RENT', 'SERVICES'],
      aliases: { SERVICES: ['RENT'] },
    }
    const r = resolveDimensions(['RENT'], [axis])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'RENT',
      token: 'RENT',
      method: 'exact',
    })
  })
})

// ---------------------------------------------------------------------------
// closed_set — fuzzy, and the exact edge of the fuzzy window
// ---------------------------------------------------------------------------

describe('resolveDimensions — fuzzy matching within edit distance 2', () => {
  it('resolves MATERIJAAL to MATERIALS without a model, as the spec promises', () => {
    const r = resolveDimensions(['MATERIJAAL'], [CATEGORY])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'MATERIALS',
      token: 'MATERIJAAL',
      method: 'fuzzy',
    })
  })

  it.each([
    ['LOGISTIKS', 'LOGISTICS'],
    ['PAKOVANJA', 'PACKAGING'],
    ['REKLAMAA', 'MARKETING'],
    ['EQUIPMEN', 'EQUIPMENT'],
  ])('resolves the near-miss %s to %s by fuzz', (token, expected) => {
    const r = resolveDimensions([token], [CATEGORY])
    expect(byAxis(r, 'category')).toMatchObject({ value: expected, method: 'fuzzy' })
  })

  it('accepts a token at exactly edit distance 2', () => {
    // EQUIPME -> EQUIPMENT is two deletions; no other candidate is within 2.
    const r = resolveDimensions(['EQUIPME'], [CATEGORY])
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'EQUIPMENT',
      token: 'EQUIPME',
      method: 'fuzzy',
    })
  })

  it('refuses a token at exactly edit distance 3', () => {
    // EQUIPM -> EQUIPMENT is three deletions: one past the window.
    const r = resolveDimensions(['EQUIPM'], [CATEGORY])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['EQUIPM'])
  })

  it('refuses MATERIC, which is three edits from both MATERIALS and MATERIJAL', () => {
    const r = resolveDimensions(['MATERIC'], [CATEGORY])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['MATERIC'])
  })

  it('returns null-equivalent (no resolution) when two candidates tie at the same distance', () => {
    const axis: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['FEED', 'FEES'],
    }
    const r = resolveDimensions(['FEET'], [axis])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['FEET'])
  })

  it('still resolves when two equidistant candidates point at the same canonical value', () => {
    const axis: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['MATERIALS'],
      aliases: { MATERIALS: ['MATERIALZ'] },
    }
    const r = resolveDimensions(['MATERIALX'], [axis])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
  })
})

// ---------------------------------------------------------------------------
// The central refusal
// ---------------------------------------------------------------------------

describe('resolveDimensions — an unknown token is never silently OTHER', () => {
  it.each(['PAMUK', 'KARTONAZA', 'avgust'])(
    'leaves the unknown token %s unresolved instead of bucketing it as OTHER',
    (token) => {
      const r = resolveDimensions([token], [CATEGORY])
      expect(byAxis(r, 'category')).toBeUndefined()
      expect(r.resolved.map((x) => x.value)).not.toContain('OTHER')
      expect(r.unresolvedTokens).toEqual([token])
    },
  )

  it('does not fuzzy an amount token into a category', () => {
    const r = resolveDimensions(['200E'], [CATEGORY])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['200E'])
  })

  it('reports an unresolved required axis as still missing rather than defaulting it', () => {
    const r = resolveDimensions(['MATERIC'], SMOQUA_AXES.filter((a) => a.type === 'closed_set'))
    const values: DimensionValues = Object.fromEntries(r.resolved.map((x) => [x.axis, x.value]))
    expect(missingRequiredAxes(values, SMOQUA_AXES)).toEqual(['category'])
  })

  it('never invents a value outside the declared closed set', () => {
    const r = resolveDimensions(['NEPOZNATO', 'MATERIALS'], [CATEGORY])
    for (const res of r.resolved) {
      expect(CATEGORY.values).toContain(res.value)
    }
  })
})

// ---------------------------------------------------------------------------
// open_text
// ---------------------------------------------------------------------------

describe('resolveDimensions — open_text axes', () => {
  it('accepts a token no closed_set axis claimed', () => {
    const r = resolveDimensions(['MATERIALS', 'Projekat1'], [CATEGORY, PROJECT])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
    expect(byAxis(r, 'project')).toEqual({
      axis: 'project',
      value: 'Projekat1',
      token: 'Projekat1',
      method: 'exact',
    })
    expect(r.unresolvedTokens).toEqual([])
  })

  it('keeps the open_text value verbatim, with its spacing and case intact', () => {
    const r = resolveDimensions(['Projekat 1'], [PROJECT])
    expect(byAxis(r, 'project')?.value).toBe('Projekat 1')
  })

  it('does not let an open_text axis swallow a token a closed_set axis can resolve', () => {
    // project is declared FIRST here: axis order must not beat axis type.
    const r = resolveDimensions(['MATERIALS'], [PROJECT, CATEGORY])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
    expect(byAxis(r, 'project')).toBeUndefined()
  })

  it('does not let an open_text axis swallow a token a closed_set axis resolves by fuzz', () => {
    const r = resolveDimensions(['MATERIJAAL'], [PROJECT, CATEGORY])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
    expect(byAxis(r, 'project')).toBeUndefined()
  })

  it('leaves an unknown token unresolved when the book declares no open_text axis', () => {
    const r = resolveDimensions(['Projekat1'], [CATEGORY, COST_CENTER])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['Projekat1'])
  })

  it('never assigns an empty token as an open_text value', () => {
    const r = resolveDimensions([''], [PROJECT])
    expect(r.resolved).toEqual([])
  })

  it('never assigns a whitespace-only token as an open_text value', () => {
    const r = resolveDimensions(['   '], [PROJECT])
    expect(r.resolved).toEqual([])
  })

  it('fills an open_text axis at most once even when several tokens are left over', () => {
    const r = resolveDimensions(['MATERIALS', 'PAMUK', 'Projekat 1'], SMOQUA_AXES)
    expect(r.resolved.filter((x) => x.axis === 'project')).toHaveLength(1)
    expect(r.resolved.filter((x) => x.axis === 'category')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Cross-axis determinism
// ---------------------------------------------------------------------------

describe('resolveDimensions — a token that could match two axes resolves deterministically', () => {
  const CAT: DimensionAxisDef = {
    axis: 'category',
    type: 'closed_set',
    required: true,
    values: ['SERVICES', 'RENT'],
  }
  const CC: DimensionAxisDef = {
    axis: 'cost_center',
    type: 'closed_set',
    required: false,
    values: ['SERVICES', 'SHOP'],
  }

  it('gives the token to the axis declared first when both match exactly', () => {
    const r = resolveDimensions(['SERVICES'], [CAT, CC])
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0]?.axis).toBe('category')
  })

  it('gives the token to the other axis when the declaration order is reversed', () => {
    const r = resolveDimensions(['SERVICES'], [CC, CAT])
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0]?.axis).toBe('cost_center')
  })

  it('prefers an exact match on a later axis over a fuzzy match on an earlier one', () => {
    const fuzzyFirst: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['RENT'],
    }
    const exactSecond: DimensionAxisDef = {
      axis: 'cost_center',
      type: 'closed_set',
      required: false,
      values: ['RENTA'],
    }
    const r = resolveDimensions(['RENTA'], [fuzzyFirst, exactSecond])
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0]).toMatchObject({ axis: 'cost_center', value: 'RENTA', method: 'exact' })
  })

  it('prefers an alias match on a later axis over a fuzzy match on an earlier one', () => {
    const fuzzyFirst: DimensionAxisDef = {
      axis: 'category',
      type: 'closed_set',
      required: true,
      values: ['ROBAA'],
    }
    const aliasSecond: DimensionAxisDef = {
      axis: 'cost_center',
      type: 'closed_set',
      required: false,
      values: ['MATERIALS'],
      aliases: { MATERIALS: ['ROBA'] },
    }
    const r = resolveDimensions(['ROBA'], [fuzzyFirst, aliasSecond])
    expect(r.resolved[0]).toMatchObject({ axis: 'cost_center', method: 'alias' })
  })

  it('returns identical output when the same input is resolved twice', () => {
    const tokens = ['MATERIJAAL', 'Projekat 1']
    expect(resolveDimensions(tokens, SMOQUA_AXES)).toEqual(
      resolveDimensions(tokens, SMOQUA_AXES),
    )
  })

  it('is order-tolerant: the same tokens in a different order resolve to the same values', () => {
    const a = resolveDimensions(['MATERIALS', 'Projekat 1'], SMOQUA_AXES)
    const b = resolveDimensions(['Projekat 1', 'MATERIALS'], SMOQUA_AXES)
    const pairs = (r: Result) =>
      r.resolved.map((x) => `${x.axis}=${x.value}`).sort()
    expect(pairs(a)).toEqual(pairs(b))
  })

  it('fills an axis from the first matching token and leaves the later duplicate unresolved', () => {
    const r = resolveDimensions(['MATERIALS', 'XYZ', 'ROBA'], [CATEGORY])
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0]).toMatchObject({ value: 'MATERIALS', token: 'MATERIALS' })
    expect(r.unresolvedTokens).toEqual(['XYZ', 'ROBA'])
  })

  it('preserves the original order and spelling of unresolved tokens', () => {
    const r = resolveDimensions(['pamuk', 'XYZ', 'Kartonaža'], [CATEGORY])
    expect(r.unresolvedTokens).toEqual(['pamuk', 'XYZ', 'Kartonaža'])
  })
})

// ---------------------------------------------------------------------------
// Empty / absent / malformed input
// ---------------------------------------------------------------------------

describe('resolveDimensions — empty and malformed input', () => {
  it('returns two empty lists for no tokens and no axes', () => {
    expect(resolveDimensions([], [])).toEqual({ resolved: [], unresolvedTokens: [] })
  })

  it('returns no resolutions when there are tokens but no axes are declared', () => {
    const r = resolveDimensions(['MATERIALS', 'Projekat 1'], [])
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual(['MATERIALS', 'Projekat 1'])
  })

  it('returns no resolutions when there are axes but no tokens', () => {
    const r = resolveDimensions([], SMOQUA_AXES)
    expect(r.resolved).toEqual([])
    expect(r.unresolvedTokens).toEqual([])
  })

  it('resolves a token surrounded by stray whitespace', () => {
    const r = resolveDimensions(['  MATERIALS  '], [CATEGORY])
    expect(byAxis(r, 'category')?.value).toBe('MATERIALS')
  })
})

// ---------------------------------------------------------------------------
// missingRequiredAxes
// ---------------------------------------------------------------------------

describe('missingRequiredAxes', () => {
  it('returns an empty list when every required axis has a value', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, SMOQUA_AXES)).toEqual([])
  })

  it('reports a required axis whose key is absent altogether', () => {
    expect(missingRequiredAxes({}, SMOQUA_AXES)).toEqual(['category'])
  })

  it('reports a required axis explicitly set to null', () => {
    expect(missingRequiredAxes({ category: null }, SMOQUA_AXES)).toEqual(['category'])
  })

  it('reports a required axis set to an empty string', () => {
    expect(missingRequiredAxes({ category: '' }, SMOQUA_AXES)).toEqual(['category'])
  })

  it('reports a required axis set to whitespace only', () => {
    expect(missingRequiredAxes({ category: '   ' }, SMOQUA_AXES)).toEqual(['category'])
  })

  it('does not report an optional axis that is missing', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, SMOQUA_AXES)).not.toContain('project')
  })

  it('reports a required open_text axis with no value', () => {
    const axes: DimensionAxisDef[] = [{ ...PROJECT, required: true }]
    expect(missingRequiredAxes({}, axes)).toEqual(['project'])
  })

  it('reports several missing required axes in declaration order', () => {
    const axes: DimensionAxisDef[] = [
      { ...PROJECT, required: true },
      CATEGORY,
      { ...COST_CENTER, required: true },
    ]
    expect(missingRequiredAxes({}, axes)).toEqual(['project', 'category', 'cost_center'])
  })

  it('returns an empty list when the book declares no axes at all', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [])).toEqual([])
  })

  it('returns an empty list when no declared axis is required', () => {
    expect(missingRequiredAxes({}, [PROJECT, COST_CENTER])).toEqual([])
  })

  it('ignores values for axes the book does not declare', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS', campaign: 'X' }, SMOQUA_AXES)).toEqual([])
  })

  it('treats a present-but-off-set value as present, since validity is not presence', () => {
    expect(missingRequiredAxes({ category: 'NEPOZNATO' }, SMOQUA_AXES)).toEqual([])
  })

  it('accepts OTHER as a satisfying value for a required axis', () => {
    expect(missingRequiredAxes({ category: 'OTHER' }, SMOQUA_AXES)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// recentAxisValues
// ---------------------------------------------------------------------------

describe('recentAxisValues', () => {
  // history is chronological (oldest first); the function answers newest first.
  const history: DimensionValues[] = [
    { category: 'MATERIALS', project: 'Projekat 1' },
    { category: 'PACKAGING', project: 'Projekat 2' },
    { category: 'MARKETING', project: 'Projekat 3' },
  ]

  it('returns previously used values most recent first', () => {
    expect(recentAxisValues('project', history)).toEqual([
      'Projekat 3',
      'Projekat 2',
      'Projekat 1',
    ])
  })

  it('returns an empty list when the history is empty', () => {
    expect(recentAxisValues('project', [])).toEqual([])
  })

  it('returns an empty list when the axis was never used', () => {
    expect(recentAxisValues('cost_center', history)).toEqual([])
  })

  it('skips entries where the axis is null', () => {
    const h: DimensionValues[] = [{ project: 'Projekat 1' }, { project: null }]
    expect(recentAxisValues('project', h)).toEqual(['Projekat 1'])
  })

  it('skips entries where the axis key is absent', () => {
    const h: DimensionValues[] = [{ project: 'Projekat 1' }, { category: 'MATERIALS' }]
    expect(recentAxisValues('project', h)).toEqual(['Projekat 1'])
  })

  it('skips empty-string and whitespace-only values', () => {
    const h: DimensionValues[] = [
      { project: 'Projekat 1' },
      { project: '' },
      { project: '   ' },
    ]
    expect(recentAxisValues('project', h)).toEqual(['Projekat 1'])
  })

  it('lists a repeated value once, at the position of its most recent use', () => {
    const h: DimensionValues[] = [
      { project: 'Projekat 1' },
      { project: 'Projekat 2' },
      { project: 'Projekat 1' },
    ]
    expect(recentAxisValues('project', h)).toEqual(['Projekat 1', 'Projekat 2'])
  })

  it('keeps values that differ only in case as separate entries, because the text is the user\'s', () => {
    const h: DimensionValues[] = [{ project: 'projekat 1' }, { project: 'Projekat 1' }]
    expect(recentAxisValues('project', h)).toEqual(['Projekat 1', 'projekat 1'])
  })

  it('returns values verbatim, without normalising spacing or diacritics', () => {
    const h: DimensionValues[] = [{ project: 'Kampanja  Đaci 2026' }]
    expect(recentAxisValues('project', h)).toEqual(['Kampanja  Đaci 2026'])
  })

  it('matches the axis name exactly and does not fall back to a case-insensitive key', () => {
    expect(recentAxisValues('Project', history)).toEqual([])
  })

  it('works for a closed_set axis name too, since it only reads the values map', () => {
    expect(recentAxisValues('category', history)).toEqual([
      'MARKETING',
      'PACKAGING',
      'MATERIALS',
    ])
  })

  it.each([
    [1, ['Projekat 3']],
    [2, ['Projekat 3', 'Projekat 2']],
    [3, ['Projekat 3', 'Projekat 2', 'Projekat 1']],
  ])('honours a limit of %i exactly', (limit, expected) => {
    expect(recentAxisValues('project', history, limit)).toEqual(expected)
  })

  it('returns an empty list for a limit of exactly zero', () => {
    expect(recentAxisValues('project', history, 0)).toEqual([])
  })

  it('returns an empty list for a negative limit rather than throwing', () => {
    expect(recentAxisValues('project', history, -1)).toEqual([])
  })

  it('returns everything it has when the limit exceeds the number of distinct values', () => {
    expect(recentAxisValues('project', history, 99)).toEqual([
      'Projekat 3',
      'Projekat 2',
      'Projekat 1',
    ])
  })

  it('applies the limit after de-duplication, not before', () => {
    const h: DimensionValues[] = [
      { project: 'Projekat 1' },
      { project: 'Projekat 2' },
      { project: 'Projekat 2' },
    ]
    expect(recentAxisValues('project', h, 2)).toEqual(['Projekat 2', 'Projekat 1'])
  })

  it('returns every distinct value when no limit is given', () => {
    const h: DimensionValues[] = Array.from({ length: 6 }, (_, i) => ({
      project: `Projekat ${i + 1}`,
    }))
    expect(recentAxisValues('project', h)).toEqual([
      'Projekat 6',
      'Projekat 5',
      'Projekat 4',
      'Projekat 3',
      'Projekat 2',
      'Projekat 1',
    ])
  })
})

// ---------------------------------------------------------------------------
// The message from the spec, end to end
// ---------------------------------------------------------------------------

describe('the SMOQUA shorthand from 05-SMOQUA.md §2', () => {
  it('resolves the typo and the project from "MATERIJAAL … Projekat 1" once the amount is consumed', () => {
    const r = resolveDimensions(['MATERIJAAL', 'Projekat 1'], SMOQUA_AXES)
    expect(byAxis(r, 'category')).toEqual({
      axis: 'category',
      value: 'MATERIALS',
      token: 'MATERIJAAL',
      method: 'fuzzy',
    })
    expect(byAxis(r, 'project')).toEqual({
      axis: 'project',
      value: 'Projekat 1',
      token: 'Projekat 1',
      method: 'exact',
    })
    expect(r.unresolvedTokens).toEqual([])

    const values: DimensionValues = Object.fromEntries(r.resolved.map((x) => [x.axis, x.value]))
    expect(missingRequiredAxes(values, SMOQUA_AXES)).toEqual([])
  })

  it('offers "Projekat 1" as a tap the second time it is used', () => {
    const first = resolveDimensions(['MATERIJAAL', 'Projekat 1'], SMOQUA_AXES)
    const stored: DimensionValues = Object.fromEntries(
      first.resolved.map((x) => [x.axis, x.value]),
    )
    expect(recentAxisValues('project', [stored])).toEqual(['Projekat 1'])
  })
})
