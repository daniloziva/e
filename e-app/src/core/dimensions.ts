import type { DimensionAxisDef, DimensionValues } from './types.js'

export interface AxisResolution {
  axis: string
  value: string
  /** which token of the input produced it, so the caller can consume it */
  token: string
  method: 'exact' | 'alias' | 'fuzzy'
}

/**
 * Resolve tokens against a book's declared axes.
 * closed_set axes: exact -> alias -> fuzzy (<=2). Unknown -> unresolved, never OTHER.
 * open_text axes: accept anything not consumed by another axis.
 */
export function resolveDimensions(
  _tokens: string[],
  _axes: DimensionAxisDef[],
): { resolved: AxisResolution[]; unresolvedTokens: string[] } {
  throw new Error('not implemented')
}

/** Which required axes are still missing from a set of values. */
export function missingRequiredAxes(_values: DimensionValues, _axes: DimensionAxisDef[]): string[] {
  throw new Error('not implemented')
}

/** Previously used values for an open_text axis, most recent first — offered as buttons. */
export function recentAxisValues(_axis: string, _history: DimensionValues[], _limit?: number): string[] {
  throw new Error('not implemented')
}

