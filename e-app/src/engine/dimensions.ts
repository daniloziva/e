import type { DimensionAxisDef, DimensionValues } from './types.js'
import { fuzzyMatch, levenshtein, normalize } from './nlu/synonyms.js'

export interface AxisResolution {
  axis: string
  value: string
  /** which token of the input produced it, so the caller can consume it */
  token: string
  method: 'exact' | 'alias' | 'fuzzy'
}

// ---------------------------------------------------------------------------
// Dimension resolution — 05-SMOQUA.md §2/§3a.
//
// The deterministic half of understanding a message. It claims only what it can
// justify: a token either lands on a declared value by an argument the user
// could follow (it IS the value, it is a declared alias of the value, or it is
// within a short edit budget of one of those and of nothing else), or it is
// handed back untouched for the model to interpret. "Unknown -> buttons, never
// a silent OTHER" is the whole point, so every ambiguity here resolves to a
// refusal rather than to a guess.
// ---------------------------------------------------------------------------

/** Keys that would reach up the prototype chain are never axis names. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Strength order: a stronger reading on any axis beats a weaker one anywhere. */
const METHOD_ORDER: readonly AxisResolution['method'][] = ['exact', 'alias', 'fuzzy']

/**
 * The fuzzy budget, relative to the length of the normalized token.
 *
 * `fuzzyMatch`'s own default of 2 is ABSOLUTE, which on a four-letter word
 * licenses replacing half of it — Serbian "juce" (yesterday) sits at distance 2
 * from the alias "PIĆE". `nlu/slots.ts` adopted a proportional budget for that
 * reason and this module uses the identical one, so a token cannot mean one
 * thing to the slot grammar and another thing here: exact-or-alias only below
 * three characters, one edit up to five, the full two from six.
 */
function editBudget(normalized: string): number {
  return Math.min(2, Math.floor(normalized.length / 3))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Axis definitions arrive from a book row — that is `_state` JSON, not a value
 * the type system ever checked. Anything that is not a well-formed axis is
 * dropped rather than trusted.
 */
function isAxisDef(value: unknown): value is DimensionAxisDef {
  if (!isRecord(value)) return false
  if (!isString(value['axis'])) return false
  return value['type'] === 'closed_set' || value['type'] === 'open_text'
}

/**
 * The axes actually in play: well-formed, safely named, and de-duplicated by
 * name keeping the FIRST declaration — a book that names an axis twice has one
 * axis, and the earlier line is the one that counts.
 */
function usableAxes(axes: DimensionAxisDef[]): DimensionAxisDef[] {
  if (!Array.isArray(axes)) return []
  const seen = new Set<string>()
  const usable: DimensionAxisDef[] = []
  for (const axis of axes) {
    if (!isAxisDef(axis)) continue
    if (UNSAFE_KEYS.has(axis.axis)) continue
    if (seen.has(axis.axis)) continue
    seen.add(axis.axis)
    usable.push(axis)
  }
  return usable
}

/** The declared closed set. `values` is the sole authority on what an axis may hold. */
function declaredValues(axis: DimensionAxisDef): string[] {
  const values: unknown = axis.values
  if (!Array.isArray(values)) return []
  return values.filter(isString)
}

/**
 * The alias table, restricted to entries whose canonical key is a declared
 * value. An orphan alias must never smuggle a value into a closed set.
 * Returns a fresh object; the caller's definition is never touched.
 */
function usableAliases(axis: DimensionAxisDef, values: string[]): Record<string, string[]> {
  const aliases: unknown = axis.aliases
  const table: Record<string, string[]> = {}
  if (!isRecord(aliases)) return table
  for (const [canonical, spellings] of Object.entries(aliases)) {
    if (UNSAFE_KEYS.has(canonical)) continue
    if (!Array.isArray(spellings)) continue
    if (!values.some((value) => normalize(value) === normalize(canonical))) continue
    table[canonical] = spellings.filter(isString)
  }
  return table
}

/** Every spelling that leads to one canonical value: the value itself and its aliases. */
function spellingsOf(value: string, aliases: Record<string, string[]>): string[] {
  const spellings = [value]
  for (const [canonical, entries] of Object.entries(aliases)) {
    if (normalize(canonical) !== normalize(value)) continue
    spellings.push(...entries)
  }
  return spellings
}

interface Reading {
  value: string
  method: AxisResolution['method']
  distance: number
}

interface Candidate extends Reading {
  axis: string
  /** declaration index, so ties between equally strong readings are broken deterministically */
  order: number
}

/**
 * How one closed_set axis reads one token, at the strongest method available.
 * The caller guarantees a closed_set axis and a non-empty `normalized`.
 */
function readAxis(token: string, normalized: string, axis: DimensionAxisDef): Reading | null {
  const values = declaredValues(axis)
  if (values.length === 0) return null

  // Exact — the token IS a declared value, modulo case, diacritics and padding.
  // Checked before aliases so an alias pointing elsewhere cannot outrank the
  // value the user actually typed.
  const exact = values.find((value) => normalize(value) === normalized)
  if (exact !== undefined) return { value: exact, method: 'exact', distance: 0 }

  const aliases = usableAliases(axis, values)

  // Alias — the token IS a declared alias. Two aliases of one axis pointing at
  // two different values is a question, not a reading.
  const targets = new Set<string>()
  for (const [canonical, spellings] of Object.entries(aliases)) {
    if (!spellings.some((spelling) => normalize(spelling) === normalized)) continue
    const target = values.find((value) => normalize(value) === normalize(canonical))
    if (target !== undefined) targets.add(target)
  }
  if (targets.size === 1) {
    const [only] = [...targets]
    if (only !== undefined) return { value: only, method: 'alias', distance: 0 }
  }
  if (targets.size > 1) return null

  // Fuzzy — near a single value and near nothing else. `fuzzyMatch` owns the
  // tie rule (several routes to ONE value are not a conflict; two values at the
  // same distance are) and returns null on both ambiguity and over-budget.
  const winner = fuzzyMatch(token, values, aliases, editBudget(normalized))
  if (winner === null) return null

  let distance = Number.POSITIVE_INFINITY
  for (const spelling of spellingsOf(winner, aliases)) {
    distance = Math.min(distance, levenshtein(normalized, normalize(spelling)))
  }
  return { value: winner, method: 'fuzzy', distance }
}

/**
 * Pick between axes that all claim the same token.
 *
 * Method strength first, so declaration order never beats evidence: an exact
 * match on the last axis outranks a fuzzy one on the first. Within `exact` and
 * `alias` the reading is certain on every contender, so the first-declared axis
 * takes it. Within `fuzzy` nothing is certain, so the closest wins and a tie
 * refuses outright — the same rule `fuzzyMatch` applies inside one axis, lifted
 * across axes.
 */
function pickCandidate(candidates: Candidate[]): Candidate | null {
  for (const method of METHOD_ORDER) {
    const atMethod = candidates.filter((candidate) => candidate.method === method)
    if (atMethod.length === 0) continue

    if (method !== 'fuzzy') {
      return atMethod.reduce((best, candidate) => (candidate.order < best.order ? candidate : best))
    }

    const nearest = atMethod.reduce((best, candidate) =>
      candidate.distance < best.distance ? candidate : best,
    )
    const tied = atMethod.filter((candidate) => candidate.distance === nearest.distance)
    return tied.length === 1 ? nearest : null
  }
  return null
}

interface TokenReading {
  index: number
  token: string
  candidate: Candidate | null
}

/**
 * Resolve tokens against a book's declared axes.
 * closed_set axes: exact -> alias -> fuzzy (<=2). Unknown -> unresolved, never OTHER.
 * open_text axes: accept anything not consumed by another axis.
 */
export function resolveDimensions(
  tokens: string[],
  axes: DimensionAxisDef[],
): { resolved: AxisResolution[]; unresolvedTokens: string[] } {
  const declared = usableAxes(axes)
  const closedAxes = declared.filter((axis) => axis.type === 'closed_set')
  const openAxes = declared.filter((axis) => axis.type === 'open_text')

  // Read every token independently of every other one. A word means what it
  // means; only which token gets to FILL an axis depends on the others.
  const readings: TokenReading[] = []
  const source = Array.isArray(tokens) ? tokens : []
  source.forEach((token, index) => {
    // A blank token is not an answer and not a question: it is dropped
    // entirely, appearing in neither list.
    if (!isString(token)) return
    const normalized = normalize(token)
    if (normalized === '') return

    const candidates: Candidate[] = []
    closedAxes.forEach((axis, order) => {
      const reading = readAxis(token, normalized, axis)
      if (reading !== null) candidates.push({ ...reading, axis: axis.axis, order })
    })

    readings.push({ index, token, candidate: pickCandidate(candidates) })
  })

  const resolved: (AxisResolution & { index: number })[] = []
  const filled = new Set<string>()
  const leftovers: TokenReading[] = []

  for (const reading of readings) {
    const candidate = reading.candidate
    if (candidate === null) {
      // Nothing in the closed sets recognised this token, so it is genuinely
      // free text and only now may an open_text axis look at it.
      leftovers.push(reading)
      continue
    }
    // A token that lost a filled axis stays unresolved. It was understood as a
    // category and is therefore not free text — letting it fall through to an
    // open_text axis would silently file "PACKAGING" as the project name.
    if (filled.has(candidate.axis)) continue
    filled.add(candidate.axis)
    resolved.push({
      axis: candidate.axis,
      value: candidate.value,
      token: reading.token,
      method: candidate.method,
      index: reading.index,
    })
  }

  // An open_text axis claims a leftover only when there is nothing to decide:
  // exactly one unclaimed word and exactly one axis to put it in. Two words, or
  // two axes, is a question for the model (05-SMOQUA §3a) — claiming one here
  // would leave the model nothing to interpret and no way to correct us.
  const onlyLeftover = leftovers.length === 1 ? leftovers[0] : undefined
  const onlyOpenAxis = openAxes.length === 1 ? openAxes[0] : undefined
  if (onlyLeftover !== undefined && onlyOpenAxis !== undefined) {
    resolved.push({
      axis: onlyOpenAxis.axis,
      // open_text judges nothing about CONTENT — case and diacritics survive
      // exactly as written, and no fuzzing happens here.
      //
      // Edge padding is the one exception, and it is not cosmetic:
      // recentAxisValues dedupes byte-exactly, so an untrimmed value makes
      // '  Projekat 1  ' and 'Projekat 1' two different projects, and two
      // buttons, forever — the history never forgets. `token` stays verbatim
      // because it records what the user actually typed.
      value: onlyLeftover.token.trim(),
      token: onlyLeftover.token,
      method: 'exact',
      index: onlyLeftover.index,
    })
  }

  resolved.sort((a, b) => a.index - b.index)
  const claimedIndices = new Set(resolved.map((entry) => entry.index))

  const unresolvedTokens = readings
    .filter((reading) => !claimedIndices.has(reading.index))
    .map((reading) => reading.token)

  return {
    resolved: resolved.map(({ index: _index, ...entry }) => entry),
    unresolvedTokens,
  }
}

/**
 * Presence, not validity: a required axis holding "BANANAS" is answered, even
 * though nothing declares that value. Blank, null and absent are all missing —
 * and so is a non-string, which is what a `_state` JSON round-trip can leave
 * behind; asking again is safer than passing a number downstream as a name.
 */
export function missingRequiredAxes(values: DimensionValues, axes: DimensionAxisDef[]): string[] {
  const map: unknown = values
  const missing: string[] = []

  for (const axis of usableAxes(axes)) {
    if (axis.required !== true) continue
    if (!isRecord(map) || !Object.hasOwn(map, axis.axis)) {
      missing.push(axis.axis)
      continue
    }
    const value = map[axis.axis]
    if (!isString(value) || value.trim() === '') missing.push(axis.axis)
  }

  return missing
}

/** Previously used values for an open_text axis, most recent first — offered as buttons. */
export function recentAxisValues(
  axis: string,
  history: DimensionValues[],
  limit?: number,
): string[] {
  if (!isString(axis) || axis === '' || UNSAFE_KEYS.has(axis)) return []
  if (!Array.isArray(history)) return []

  // An absent limit means every distinct value; how many become buttons is the
  // caller's presentation decision, not this module's.
  const cap = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : null
  if (cap !== null && cap <= 0) return []

  // History folds oldest-first, so walking it backwards is "most recent first",
  // and the first sighting of a value on that walk is its most recent use.
  const values: string[] = []
  const seen = new Set<string>()
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry: unknown = history[i]
    if (!isRecord(entry)) continue
    if (!Object.hasOwn(entry, axis)) continue
    const value = entry[axis]
    // Verbatim and case-sensitive: "Projekat 1" and "projekat 1" are two
    // different things the user typed, so they are two different buttons.
    if (!isString(value) || value.trim() === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    values.push(value)
    // The limit counts distinct values — buttons on a screen, not ledger rows.
    if (cap !== null && values.length >= cap) break
  }

  return values
}
