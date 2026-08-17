import { describe, it, expect } from 'vitest'

import {
  resolveDimensions,
  missingRequiredAxes,
  recentAxisValues,
  type AxisResolution,
} from '../../src/engine/dimensions.js'
import type { DimensionAxisDef, DimensionValues } from '../../src/engine/types.js'

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

/** Declared in the spec with an empty value list — nothing can ever resolve to it. */
const COST_CENTER: DimensionAxisDef = {
  axis: 'cost_center',
  type: 'closed_set',
  required: false,
  values: [],
}

/** The full book declaration from 05-SMOQUA.md §2. */
const SMOQUA_AXES: DimensionAxisDef[] = [CATEGORY, PROJECT, COST_CENTER]

/** No open_text axis — used whenever a test needs to observe unresolved tokens. */
const CLOSED_ONLY: DimensionAxisDef[] = [CATEGORY, COST_CENTER]

const CATEGORY_ONLY: DimensionAxisDef[] = [CATEGORY]

// helpers -------------------------------------------------------------------

const closed = (
  axis: string,
  values: string[],
  aliases?: Record<string, string[]>,
  required = false,
): DimensionAxisDef => ({
  axis,
  type: 'closed_set',
  required,
  values,
  ...(aliases ? { aliases } : {}),
})

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

const byAxis = (resolved: AxisResolution[], axis: string): AxisResolution | undefined =>
  resolved.find((r) => r.axis === axis)

const valueOf = (resolved: AxisResolution[], axis: string): string | undefined =>
  byAxis(resolved, axis)?.value

// ---------------------------------------------------------------------------
// resolveDimensions
// ---------------------------------------------------------------------------

describe('resolveDimensions', () => {
  // -------------------------------------------------------------------------
  // closed_set — exact
  // -------------------------------------------------------------------------

  describe('closed_set exact matching', () => {
    it.each(['MATERIALS', 'PACKAGING', 'EQUIPMENT', 'RENT', 'LOGISTICS', 'FEES'])(
      'resolves the declared value %s to itself by exact match',
      (value) => {
        expect(resolveDimensions([value], CLOSED_ONLY)).toEqual({
          resolved: [res('category', value, value, 'exact')],
          unresolvedTokens: [],
        })
      },
    )

    it.each([
      ['materials', 'MATERIALS'],
      ['Materials', 'MATERIALS'],
      ['mArKeTiNg', 'MARKETING'],
    ])(
      'treats case as noise, so %s is still an exact match on %s',
      (token, value) => {
        expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
          resolved: [res('category', value, token, 'exact')],
          unresolvedTokens: [],
        })
      },
    )

    it('reports the original token, not the normalised one, so the caller can consume it', () => {
      const { resolved } = resolveDimensions(['MaTeRiAlS'], CLOSED_ONLY)
      expect(byAxis(resolved, 'category')?.token).toBe('MaTeRiAlS')
    })

    it('resolves OTHER only when the user typed it, and calls that an exact match', () => {
      expect(resolveDimensions(['OTHER'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'OTHER', 'OTHER', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('prefers an exact value over an alias that points somewhere else', () => {
      const axes = [closed('category', ['RENT', 'SERVICES'], { SERVICES: ['RENT'] })]
      expect(resolveDimensions(['RENT'], axes)).toEqual({
        resolved: [res('category', 'RENT', 'RENT', 'exact')],
        unresolvedTokens: [],
      })
    })
  })

  // -------------------------------------------------------------------------
  // closed_set — aliases (the Serbian vocabulary is the point of the feature)
  // -------------------------------------------------------------------------

  describe('closed_set alias matching', () => {
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
    ])('resolves the alias %s to the canonical value %s, by alias and not by fuzz', (token, value) => {
      expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
        resolved: [res('category', value, token, 'alias')],
        unresolvedTokens: [],
      })
    })

    it.each([
      ['materijal', 'MATERIALS'],
      ['Roba', 'MATERIALS'],
      ['sirovine', 'MATERIALS'],
      ['reklama', 'MARKETING'],
    ])('matches the lowercase alias %s to %s without downgrading it to fuzzy', (token, value) => {
      expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
        resolved: [res('category', value, token, 'alias')],
        unresolvedTokens: [],
      })
    })

    it.each(['AMBALAŽA', 'ambalaža'])(
      'strips diacritics so %s still resolves through the AMBALAZA alias',
      (token) => {
        expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
          resolved: [res('category', 'PACKAGING', token, 'alias')],
          unresolvedTokens: [],
        })
      },
    )

    it('treats a diacritic-mangled alias as an alias hit, not a fuzzy guess', () => {
      expect(resolveDimensions(['pakovanjé'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'PACKAGING', 'pakovanjé', 'alias')],
        unresolvedTokens: [],
      })
    })

    it('ignores an alias entry whose canonical key is not a declared value', () => {
      // `values` is the authority for what an axis may hold; an orphan alias
      // must never introduce a value outside the declared closed set.
      const axes = [closed('category', ['RENT'], { MATERIALS: ['ROBA'] })]
      expect(resolveDimensions(['ROBA'], axes)).toEqual({
        resolved: [],
        unresolvedTokens: ['ROBA'],
      })
    })

    it('resolves nothing for an axis that declares aliases but no values at all', () => {
      const axes: DimensionAxisDef[] = [
        { axis: 'category', type: 'closed_set', required: false, aliases: { MATERIALS: ['ROBA'] } },
      ]
      expect(resolveDimensions(['ROBA'], axes)).toEqual({
        resolved: [],
        unresolvedTokens: ['ROBA'],
      })
    })
  })

  // -------------------------------------------------------------------------
  // closed_set — fuzzy, and the exact edge of the fuzzy window
  // -------------------------------------------------------------------------

  describe('closed_set fuzzy matching within edit distance 2', () => {
    it('resolves MATERIJAAL to MATERIALS without a model, as 05-SMOQUA §2 requires', () => {
      expect(resolveDimensions(['MATERIJAAL'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'MATERIALS', 'MATERIJAAL', 'fuzzy')],
        unresolvedTokens: [],
      })
    })

    it.each([
      ['MATERIAL', 'MATERIALS'],
      ['MATERIALZ', 'MATERIALS'],
      ['MATERIA', 'MATERIALS'],
      ['PAKOVANE', 'PACKAGING'],
      ['PAKOVANJA', 'PACKAGING'],
      ['REKLAM', 'MARKETING'],
      ['REKLAMAA', 'MARKETING'],
      ['RENTA', 'RENT'],
      ['LOGISTIKS', 'LOGISTICS'],
      ['EQUIPMEN', 'EQUIPMENT'],
    ])('resolves the near-miss %s to %s by fuzzy match', (token, value) => {
      expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
        resolved: [res('category', value, token, 'fuzzy')],
        unresolvedTokens: [],
      })
    })

    it('accepts a token at exactly edit distance 2 from a declared value', () => {
      // EQUIPME -> EQUIPMENT is two insertions; no other candidate is within 2.
      expect(resolveDimensions(['EQUIPME'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'EQUIPMENT', 'EQUIPME', 'fuzzy')],
        unresolvedTokens: [],
      })
    })

    it('accepts a token at exactly edit distance 2 from an alias', () => {
      // ROBAXY -> ROBA is two deletions; ROBA is an alias of MATERIALS.
      expect(resolveDimensions(['ROBAXY'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'MATERIALS', 'ROBAXY', 'fuzzy')],
        unresolvedTokens: [],
      })
    })

    it.each([
      ['EQUIPM', 'three deletions from EQUIPMENT'],
      ['ROBAXYZ', 'three edits from the alias ROBA'],
      ['MATERI', 'three edits from MATERIALS, MATERIJAL and MAT'],
    ])('refuses %s, which is %s — one past the window', (token) => {
      expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
        resolved: [],
        unresolvedTokens: [token],
      })
    })

    it('refuses MATERIC, the case 06-TDD-STRATEGY names as "no match, ask"', () => {
      expect(resolveDimensions(['MATERIC'], CLOSED_ONLY)).toEqual({
        resolved: [],
        unresolvedTokens: ['MATERIC'],
      })
    })

    it('prefers the closer candidate when two fuzzy candidates are not tied', () => {
      // ALFAB is distance 1 from ALFA and distance 2 from ALFBBB.
      const axes = [closed('amb', ['ALFA', 'ALFBBB'])]
      expect(valueOf(resolveDimensions(['ALFAB'], axes).resolved, 'amb')).toBe('ALFA')
    })

    it('refuses when two candidates of one axis sit at the same edit distance', () => {
      const axes = [closed('amb', ['ALFA', 'ALFB'])]
      expect(resolveDimensions(['ALFX'], axes)).toEqual({
        resolved: [],
        unresolvedTokens: ['ALFX'],
      })
    })

    it('refuses when the two equidistant candidates live on different axes', () => {
      const axes = [closed('first', ['ALFA']), closed('second', ['ALFB'])]
      expect(resolveDimensions(['ALFX'], axes)).toEqual({
        resolved: [],
        unresolvedTokens: ['ALFX'],
      })
    })

    it('still resolves when two equidistant candidates share one canonical value', () => {
      const axes = [closed('code', ['ALPHA'], { ALPHA: ['ALPHB'] })]
      expect(resolveDimensions(['ALPHC'], axes)).toEqual({
        resolved: [res('code', 'ALPHA', 'ALPHC', 'fuzzy')],
        unresolvedTokens: [],
      })
    })
  })

  // -------------------------------------------------------------------------
  // The refusal that matters most: unknown is never a silent OTHER.
  // 05-SMOQUA §2: "Unknown → buttons, never a silent OTHER."
  // -------------------------------------------------------------------------

  describe('an unknown token is never silently OTHER', () => {
    it.each([
      'PAMUK',
      'KARTONAZA',
      'Kartonaža doo',
      'OSTALO',
      'RAZNO',
      'NEPOZNATO',
      'ZZZTOP',
      'avgust',
      'X',
      '42',
      '12000',
      '200E',
      '???',
    ])('leaves the unknown token %s unresolved rather than bucketing it as OTHER', (token) => {
      expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
        resolved: [],
        unresolvedTokens: [token],
      })
    })

    it('never emits a value outside the declared closed set', () => {
      const { resolved } = resolveDimensions(['NEPOZNATO', 'MATERIALS'], CATEGORY_ONLY)
      for (const r of resolved) {
        expect(CATEGORY.values).toContain(r.value)
      }
    })

    it('does not resolve a token that merely equals the axis name', () => {
      expect(resolveDimensions(['category'], CATEGORY_ONLY)).toEqual({
        resolved: [],
        unresolvedTokens: ['category'],
      })
    })

    it('resolves the known token and refuses the unknown one in the same message', () => {
      const { resolved, unresolvedTokens } = resolveDimensions(['ROBA', 'ZZZTOP'], CLOSED_ONLY)
      expect(valueOf(resolved, 'category')).toBe('MATERIALS')
      expect(unresolvedTokens).toEqual(['ZZZTOP'])
    })

    it('leaves the axis empty when nothing in the message resolves', () => {
      const { resolved } = resolveDimensions(['PAMUK', 'ZZZTOP'], CLOSED_ONLY)
      expect(byAxis(resolved, 'category')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // A token that could match two axes — method strength first, then order.
  // -------------------------------------------------------------------------

  describe('a token that could match two axes resolves deterministically', () => {
    const A = closed('a', ['SHARED', 'ALPHA'])
    const B = closed('b', ['SHARED', 'BETA'])

    it('gives the token to the first-declared axis when both match it exactly', () => {
      expect(resolveDimensions(['SHARED'], [A, B])).toEqual({
        resolved: [res('a', 'SHARED', 'SHARED', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('gives the token to the other axis when the declaration order is reversed', () => {
      expect(resolveDimensions(['SHARED'], [B, A])).toEqual({
        resolved: [res('b', 'SHARED', 'SHARED', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('consumes a token once, so a second axis cannot also claim it', () => {
      const { resolved } = resolveDimensions(['SHARED'], [A, B])
      expect(resolved).toHaveLength(1)
    })

    it('prefers an exact match on a later axis over a fuzzy match on an earlier one', () => {
      const axes = [closed('first', ['ALPHX']), closed('second', ['ALPHA'])]
      expect(resolveDimensions(['ALPHA'], axes)).toEqual({
        resolved: [res('second', 'ALPHA', 'ALPHA', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('prefers an alias match on a later axis over a fuzzy match on an earlier one', () => {
      const axes = [closed('first', ['ALPHX']), closed('second', ['CANON'], { CANON: ['ALPHA'] })]
      expect(resolveDimensions(['ALPHA'], axes)).toEqual({
        resolved: [res('second', 'CANON', 'ALPHA', 'alias')],
        unresolvedTokens: [],
      })
    })

    it('prefers an exact match on a later axis over an alias match on an earlier one', () => {
      const axes = [closed('first', ['CANON'], { CANON: ['ZETA'] }), closed('second', ['ZETA'])]
      expect(resolveDimensions(['ZETA'], axes)).toEqual({
        resolved: [res('second', 'ZETA', 'ZETA', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('reports resolutions in the order the producing tokens appeared', () => {
      const axes = [closed('a', ['ALPHA']), closed('b', ['BETA'])]
      const { resolved } = resolveDimensions(['BETA', 'ALPHA'], axes)
      expect(resolved.map((r) => r.axis)).toEqual(['b', 'a'])
    })
  })

  // -------------------------------------------------------------------------
  // Several tokens competing for one axis.
  // -------------------------------------------------------------------------

  describe('several tokens competing for one axis', () => {
    it('fills the axis from the first matching token and refuses the second', () => {
      expect(resolveDimensions(['MATERIALS', 'PACKAGING'], CLOSED_ONLY)).toEqual({
        resolved: [res('category', 'MATERIALS', 'MATERIALS', 'exact')],
        unresolvedTokens: ['PACKAGING'],
      })
    })

    it('refuses the later token even when it agrees with the value already resolved', () => {
      expect(resolveDimensions(['MATERIJAL', 'MAT'], CATEGORY_ONLY)).toEqual({
        resolved: [res('category', 'MATERIALS', 'MATERIJAL', 'alias')],
        unresolvedTokens: ['MAT'],
      })
    })

    it('resolves an axis exactly once when the same token appears twice', () => {
      const { resolved } = resolveDimensions(['ROBA', 'ROBA'], CLOSED_ONLY)
      expect(resolved.filter((r) => r.axis === 'category')).toHaveLength(1)
    })

    it('keeps the first match even when unrelated tokens sit between the two candidates', () => {
      const { resolved, unresolvedTokens } = resolveDimensions(
        ['MATERIALS', 'XYZ', 'ROBA'],
        CATEGORY_ONLY,
      )
      expect(resolved).toEqual([res('category', 'MATERIALS', 'MATERIALS', 'exact')])
      expect(unresolvedTokens).toEqual(['XYZ', 'ROBA'])
    })

    it('does not spill the losing token of a filled axis onto an open_text axis', () => {
      // PACKAGING was understood as a category; it is not free text, so it must
      // not silently become the project.
      const { resolved, unresolvedTokens } = resolveDimensions(
        ['MATERIALS', 'PACKAGING'],
        SMOQUA_AXES,
      )
      expect(valueOf(resolved, 'category')).toBe('MATERIALS')
      expect(byAxis(resolved, 'project')).toBeUndefined()
      expect(unresolvedTokens).toEqual(['PACKAGING'])
    })
  })

  // -------------------------------------------------------------------------
  // open_text
  // -------------------------------------------------------------------------

  describe('open_text axes', () => {
    const CAT_AND_PROJECT: DimensionAxisDef[] = [CATEGORY, PROJECT]

    it('gives a single leftover token to the one open_text axis, verbatim', () => {
      expect(resolveDimensions(['MATERIALS', 'Projekat 1'], SMOQUA_AXES)).toEqual({
        resolved: [
          res('category', 'MATERIALS', 'MATERIALS', 'exact'),
          res('project', 'Projekat 1', 'Projekat 1', 'exact'),
        ],
        unresolvedTokens: [],
      })
    })

    it('preserves the case and diacritics of an open_text value', () => {
      const { resolved } = resolveDimensions(['MAT', 'Projekat Đorđe'], SMOQUA_AXES)
      expect(resolved).toEqual([
        res('category', 'MATERIALS', 'MAT', 'alias'),
        res('project', 'Projekat Đorđe', 'Projekat Đorđe', 'exact'),
      ])
    })

    it('accepts a leftover that looks like money, because open_text judges nothing', () => {
      expect(resolveDimensions(['200E'], [PROJECT])).toEqual({
        resolved: [res('project', '200E', '200E', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('never fuzzy-matches for an open_text axis; the token is taken as written', () => {
      expect(resolveDimensions(['MATERIJAAL'], [PROJECT])).toEqual({
        resolved: [res('project', 'MATERIJAAL', 'MATERIJAAL', 'exact')],
        unresolvedTokens: [],
      })
    })

    it('does not let an open_text axis swallow a token a closed_set axis resolves exactly', () => {
      // project is declared FIRST here: axis order must not beat axis type.
      const { resolved } = resolveDimensions(['MATERIALS'], [PROJECT, CATEGORY])
      expect(valueOf(resolved, 'category')).toBe('MATERIALS')
      expect(byAxis(resolved, 'project')).toBeUndefined()
    })

    it('does not let an open_text axis swallow a token a closed_set axis resolves by fuzz', () => {
      const { resolved } = resolveDimensions(['MATERIJAAL'], [PROJECT, CATEGORY])
      expect(valueOf(resolved, 'category')).toBe('MATERIALS')
      expect(byAxis(resolved, 'project')).toBeUndefined()
    })

    it('leaves the open_text axis absent rather than empty when there are no leftovers', () => {
      const { resolved } = resolveDimensions(['MATERIALS'], CAT_AND_PROJECT)
      expect(resolved).toHaveLength(1)
      expect(byAxis(resolved, 'project')).toBeUndefined()
    })

    it('refuses to guess which of two leftovers is the project', () => {
      // 05-SMOQUA §3a: the model, not this deterministic pass, decides that
      // PAMUK is a description and "Projekat 1" is the project. Claiming both
      // here would leave the model nothing to interpret.
      expect(resolveDimensions(['PAMUK', 'Projekat 1'], [PROJECT])).toEqual({
        resolved: [],
        unresolvedTokens: ['PAMUK', 'Projekat 1'],
      })
    })

    it('refuses to guess which of two open_text axes a lone leftover belongs to', () => {
      expect(resolveDimensions(['Projekat 1'], [open('project'), open('note')])).toEqual({
        resolved: [],
        unresolvedTokens: ['Projekat 1'],
      })
    })

    it('leaves an unknown token unresolved when the book declares no open_text axis', () => {
      expect(resolveDimensions(['Projekat1'], CLOSED_ONLY)).toEqual({
        resolved: [],
        unresolvedTokens: ['Projekat1'],
      })
    })

    it.each(['', '   '])('never assigns the blank token %j as an open_text value', (token) => {
      expect(resolveDimensions([token], [PROJECT]).resolved).toEqual([])
    })

    it('still claims the single real leftover when blank tokens sit beside it', () => {
      expect(resolveDimensions(['MATERIALS', '  ', 'Projekat 1'], SMOQUA_AXES)).toEqual({
        resolved: [
          res('category', 'MATERIALS', 'MATERIALS', 'exact'),
          res('project', 'Projekat 1', 'Projekat 1', 'exact'),
        ],
        unresolvedTokens: [],
      })
    })

    it('fills an open_text axis at most once', () => {
      const { resolved } = resolveDimensions(['MATERIALS', 'Projekat 1'], SMOQUA_AXES)
      expect(resolved.filter((r) => r.axis === 'project')).toHaveLength(1)
      expect(resolved.filter((r) => r.axis === 'category')).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // Empty, blank and malformed input
  // -------------------------------------------------------------------------

  describe('empty, blank and malformed input', () => {
    it('returns two empty lists for no tokens and no axes', () => {
      expect(resolveDimensions([], [])).toEqual({ resolved: [], unresolvedTokens: [] })
    })

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
      expect(resolveDimensions(['ANYTHING', 'MATERIALS'], [COST_CENTER])).toEqual({
        resolved: [],
        unresolvedTokens: ['ANYTHING', 'MATERIALS'],
      })
    })

    it('treats a closed_set axis with no values property as matching nothing, without throwing', () => {
      const axes: DimensionAxisDef[] = [{ axis: 'broken', type: 'closed_set', required: false }]
      expect(resolveDimensions(['MATERIALS'], axes)).toEqual({
        resolved: [],
        unresolvedTokens: ['MATERIALS'],
      })
    })

    it.each(['', '   ', '\t'])(
      'drops the blank token %j entirely — neither resolved nor unresolved',
      (token) => {
        expect(resolveDimensions([token], CLOSED_ONLY)).toEqual({
          resolved: [],
          unresolvedTokens: [],
        })
      },
    )

    it('does not let an empty token match an empty declared value', () => {
      expect(resolveDimensions([''], [closed('code', ['', 'RENT'])]).resolved).toEqual([])
    })

    it('ignores surrounding whitespace on a token when matching a closed set', () => {
      expect(resolveDimensions(['  MATERIALS  '], CLOSED_ONLY)).toEqual({
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

    it('preserves the original order and spelling of unresolved tokens', () => {
      const { unresolvedTokens } = resolveDimensions(['pamuk', 'XYZ', 'Kartonaža'], CLOSED_ONLY)
      expect(unresolvedTokens).toEqual(['pamuk', 'XYZ', 'Kartonaža'])
    })
  })

  // -------------------------------------------------------------------------
  // Purity and determinism
  // -------------------------------------------------------------------------

  describe('purity and determinism', () => {
    it('returns the identical result when called twice with the same input', () => {
      const tokens = ['MATERIJAAL', 'Projekat 1']
      expect(resolveDimensions(tokens, SMOQUA_AXES)).toEqual(
        resolveDimensions(tokens, SMOQUA_AXES),
      )
    })

    it('is order-tolerant: the same tokens in another order resolve to the same values', () => {
      const pairs = (r: { resolved: AxisResolution[] }) =>
        r.resolved.map((x) => `${x.axis}=${x.value}`).sort()
      expect(pairs(resolveDimensions(['MATERIALS', 'Projekat 1'], SMOQUA_AXES))).toEqual(
        pairs(resolveDimensions(['Projekat 1', 'MATERIALS'], SMOQUA_AXES)),
      )
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
})

// ---------------------------------------------------------------------------
// missingRequiredAxes
// ---------------------------------------------------------------------------

describe('missingRequiredAxes', () => {
  const REQUIRED_PROJECT: DimensionAxisDef = { ...PROJECT, required: true }

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
    ['a tab and a newline', '\t\n'],
  ])('treats a required axis set to %s as missing', (_label, value) => {
    expect(missingRequiredAxes({ category: value }, SMOQUA_AXES)).toEqual(['category'])
  })

  it.each([
    ['a declared value', 'MATERIALS'],
    ['OTHER', 'OTHER'],
    ['a value outside the declared set', 'BANANAS'],
    ['the string zero', '0'],
    ['a padded value', ' MATERIALS '],
  ])('treats a required axis set to %s as present — validity is not presence', (_label, value) => {
    expect(missingRequiredAxes({ category: value }, SMOQUA_AXES)).toEqual([])
  })

  it('never reports an optional axis, however empty it is', () => {
    expect(
      missingRequiredAxes({ category: 'MATERIALS', project: null, cost_center: '' }, SMOQUA_AXES),
    ).toEqual([])
  })

  it('enforces a required open_text axis the same way as a closed_set one', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [CATEGORY, REQUIRED_PROJECT])).toEqual([
      'project',
    ])
  })

  it('lists several missing axes in declaration order', () => {
    expect(missingRequiredAxes({}, [CATEGORY, REQUIRED_PROJECT])).toEqual(['category', 'project'])
  })

  it('lists them in the reversed order when the book declares them reversed', () => {
    expect(missingRequiredAxes({}, [REQUIRED_PROJECT, CATEGORY])).toEqual(['project', 'category'])
  })

  it('reports a mix of absent and blank required axes in declaration order', () => {
    const axes = [closed('a', ['X'], undefined, true), open('b', true), closed('c', ['Y'], undefined, true)]
    expect(missingRequiredAxes({ b: null }, axes)).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty list when the book declares no axes', () => {
    expect(missingRequiredAxes({ category: 'MATERIALS' }, [])).toEqual([])
  })

  it('returns an empty list when no declared axis is required', () => {
    expect(missingRequiredAxes({}, [PROJECT, COST_CENTER])).toEqual([])
  })

  it('ignores values for axes the book never declared', () => {
    expect(
      missingRequiredAxes({ category: 'MATERIALS', supplier_batch: 'B7' }, SMOQUA_AXES),
    ).toEqual([])
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

/**
 * Chronological, oldest first — the order an append-only ledger folds into.
 * SPEC GAP: the contract pins the OUTPUT order ("most recent first") but never
 * states the INPUT order. All three drafts assumed oldest-first; if the caller
 * passes newest-first, every ordering assertion below inverts.
 */
const HISTORY: DimensionValues[] = [
  { category: 'MATERIALS', project: 'Projekat 1' },
  { category: 'PACKAGING', project: 'Projekat 2' },
  { category: 'MATERIALS', project: null },
  { category: 'MARKETING', project: 'Projekat 1' },
  { category: 'MARKETING' },
  { category: 'LOGISTICS', project: 'Projekat 3' },
]

describe('recentAxisValues', () => {
  it('returns previously used values most recent first', () => {
    expect(recentAxisValues('project', HISTORY)).toEqual([
      'Projekat 3',
      'Projekat 1',
      'Projekat 2',
    ])
  })

  it('lists a repeated value once, at its most recent position', () => {
    const history: DimensionValues[] = [{ project: 'A' }, { project: 'B' }, { project: 'A' }]
    expect(recentAxisValues('project', history)).toEqual(['A', 'B'])
  })

  it('skips entries where the axis is null', () => {
    expect(recentAxisValues('project', [{ project: null }, { project: 'A' }])).toEqual(['A'])
  })

  it('skips entries where the axis key is absent altogether', () => {
    expect(recentAxisValues('project', [{ category: 'RENT' }, { project: 'A' }])).toEqual(['A'])
  })

  it.each(['', '   '])('skips the blank value %j', (blank) => {
    expect(recentAxisValues('project', [{ project: blank }, { project: 'A' }])).toEqual(['A'])
  })

  it('treats values differing only in case as two distinct buttons', () => {
    const history: DimensionValues[] = [{ project: 'projekat 1' }, { project: 'Projekat 1' }]
    expect(recentAxisValues('project', history)).toEqual(['Projekat 1', 'projekat 1'])
  })

  it('returns values verbatim, without normalising spacing or diacritics', () => {
    expect(recentAxisValues('project', [{ project: 'Kampanja  Đaci 2026' }])).toEqual([
      'Kampanja  Đaci 2026',
    ])
  })

  it('returns an empty list for an empty history', () => {
    expect(recentAxisValues('project', [])).toEqual([])
  })

  it('returns an empty list for an axis that appears nowhere in the history', () => {
    expect(recentAxisValues('supplier_batch', HISTORY)).toEqual([])
  })

  it('returns an empty list when every entry for the axis is null', () => {
    expect(recentAxisValues('project', [{ project: null }, { project: null }])).toEqual([])
  })

  it('matches the axis name exactly and does not fall back to a case-insensitive key', () => {
    expect(recentAxisValues('Project', HISTORY)).toEqual([])
  })

  it('works for any axis name, including a closed_set one', () => {
    expect(recentAxisValues('category', HISTORY)).toEqual([
      'LOGISTICS',
      'MARKETING',
      'MATERIALS',
      'PACKAGING',
    ])
  })

  it.each([
    [1, ['Projekat 3']],
    [2, ['Projekat 3', 'Projekat 1']],
    [3, ['Projekat 3', 'Projekat 1', 'Projekat 2']],
    [4, ['Projekat 3', 'Projekat 1', 'Projekat 2']],
    [99, ['Projekat 3', 'Projekat 1', 'Projekat 2']],
  ])('returns the %i most recently used values when that limit is given', (limit, expected) => {
    expect(recentAxisValues('project', HISTORY, limit)).toEqual(expected)
  })

  it('returns an empty list when the limit is exactly zero', () => {
    expect(recentAxisValues('project', HISTORY, 0)).toEqual([])
  })

  it('returns an empty list when the limit is negative, rather than throwing', () => {
    expect(recentAxisValues('project', HISTORY, -1)).toEqual([])
  })

  it('counts the limit in distinct values, not in history entries', () => {
    const history: DimensionValues[] = [
      { project: 'A' },
      { project: 'B' },
      { project: 'B' },
      { project: 'B' },
    ]
    expect(recentAxisValues('project', history, 2)).toEqual(['B', 'A'])
  })

  it('returns every distinct value when no limit is given and there are only three', () => {
    // SPEC GAP: the default limit is unspecified (3 buttons in
    // 02-WHATSAPP-INTERFACE vs no cap). Deliberately not pinned: this passes
    // for any default >= 3 and for no default at all.
    expect(recentAxisValues('project', HISTORY)).toHaveLength(3)
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

// ---------------------------------------------------------------------------
// The SMOQUA shorthand from 05-SMOQUA.md §2/§3a, end to end
// ---------------------------------------------------------------------------

describe('the SMOQUA shorthand from 05-SMOQUA.md §2, end to end', () => {
  it('resolves the typo deterministically and hands the genuine leftovers to the model', () => {
    // "MATERIJAAL PAMUK 200E Projekat 1" with the amount already consumed by
    // the deterministic slot grammar. §3a: the model decides that PAMUK is a
    // description and "Projekat 1" is the project, so neither is claimed here.
    expect(resolveDimensions(['MATERIJAAL', 'PAMUK', 'Projekat 1'], SMOQUA_AXES)).toEqual({
      resolved: [res('category', 'MATERIALS', 'MATERIJAAL', 'fuzzy')],
      unresolvedTokens: ['PAMUK', 'Projekat 1'],
    })
  })

  it('resolves both axes once the caller has also consumed the description', () => {
    const { resolved, unresolvedTokens } = resolveDimensions(
      ['MATERIJAAL', 'Projekat 1'],
      SMOQUA_AXES,
    )
    expect(resolved).toEqual([
      res('category', 'MATERIALS', 'MATERIJAAL', 'fuzzy'),
      res('project', 'Projekat 1', 'Projekat 1', 'exact'),
    ])
    expect(unresolvedTokens).toEqual([])

    const values: DimensionValues = Object.fromEntries(resolved.map((r) => [r.axis, r.value]))
    expect(missingRequiredAxes(values, SMOQUA_AXES)).toEqual([])
  })

  it('reports the required category as still missing when nothing resolved it', () => {
    const { resolved } = resolveDimensions(['MATERIC'], CLOSED_ONLY)
    const values: DimensionValues = Object.fromEntries(resolved.map((r) => [r.axis, r.value]))
    expect(missingRequiredAxes(values, SMOQUA_AXES)).toEqual(['category'])
  })

  it('offers "Projekat 1" as a typo-free tap the second time it is used', () => {
    const first = resolveDimensions(['MATERIJAAL', 'Projekat 1'], SMOQUA_AXES)
    const stored: DimensionValues = Object.fromEntries(
      first.resolved.map((r) => [r.axis, r.value]),
    )
    expect(recentAxisValues('project', [stored])).toEqual(['Projekat 1'])
  })
})
