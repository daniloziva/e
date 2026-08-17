import type { Slots } from './slots.js'
import { isIsoDate } from './slots.js'
import type { Confidence, Currency, Money } from '../types.js'

export interface ModelSlots {
  money?: { amount: number; currency: string } | null
  dimensions?: Record<string, string>
  description?: string | null
  date?: string | null
  confidence: Confidence
}

export interface Interpretation {
  slots: Slots
  confidence: Confidence
  /** per-field origin, for provenance and for tests */
  sources: Record<string, 'deterministic' | 'model'>
  /** fields where deterministic and model disagreed; the deterministic value was kept */
  conflicts: string[]
}

// ---------------------------------------------------------------------------
// The merge. 02 §5.1 step 4; 00-OVERVIEW D8 ("the model proposes, the code
// decides") and D11.
//
// Two rules, and everything below is one of them:
//
//  1. A deterministic slot always wins. The model may only fill a gap. When it
//     proposes something else for a slot the grammar already read, the
//     deterministic value stands and the disagreement is RECORDED, because a
//     disagreement is a reason to ask the human, not a reason to change the
//     value.
//  2. Malformed model output is NO ANSWER. It is never a value, and it is never
//     a disagreement either — a model that emitted nonsense did not object to
//     the grammar, it simply failed to say anything.
//
// Everything arriving in `model` crossed a JSON boundary, so every field is
// checked with `typeof` before it is trusted. TypeScript's view of that
// parameter is a claim about the prompt, not a fact about the bytes.
// ---------------------------------------------------------------------------

/** Field keys. Axes are namespaced so an axis named "money" cannot collide. */
const MONEY = 'money'
const DESCRIPTION = 'description'
const DATE = 'date'
const dimKey = (axis: string): string => `dimensions.${axis}`

const CONFIDENCE_LEVELS: readonly Confidence[] = ['exact', 'high', 'medium', 'low']
const CURRENCIES: readonly Currency[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readConfidence(value: unknown): Confidence | null {
  if (typeof value !== 'string') return null
  return CONFIDENCE_LEVELS.find((level) => level === value) ?? null
}

/**
 * An amount from the model. A currency code is accepted in any casing but must
 * be one this system actually books in — a code nobody can convert is not an
 * answer. Zero is rejected on the same rule as the grammar's: absence is null
 * and never a zero (types.ts Money).
 */
function readModelMoney(value: unknown): Money | null {
  if (!isRecord(value)) return null

  const amount = value.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null

  const currency = value.currency
  if (typeof currency !== 'string') return null
  const code = CURRENCIES.find((c) => c === currency.trim().toUpperCase())
  if (code === undefined) return null

  return { amount, currency: code }
}

function readModelText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function readModelDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return isIsoDate(value) ? value : null
}

function sameMoney(a: Money, b: Money): boolean {
  return a.amount === b.amount && a.currency === b.currency
}

/**
 * Merge deterministic slots with model-proposed slots.
 * HARD RULE: a deterministic slot always wins. The model may only fill gaps.
 * Malformed/invalid model output is treated as NO ANSWER, never as a value.
 */
export function interpret(deterministic: Slots, model: ModelSlots | null): Interpretation {
  const slots: Slots = {
    money: deterministic.money === null ? null : { ...deterministic.money },
    dimensions: { ...deterministic.dimensions },
    description: deterministic.description,
    date: deterministic.date,
  }

  const sources: Record<string, 'deterministic' | 'model'> = {}
  const conflicts: string[] = []

  if (slots.money !== null) sources[MONEY] = 'deterministic'
  if (slots.description !== null) sources[DESCRIPTION] = 'deterministic'
  if (slots.date !== null) sources[DATE] = 'deterministic'
  for (const axis of Object.keys(slots.dimensions)) {
    if (UNSAFE_KEYS.has(axis)) continue
    sources[dimKey(axis)] = 'deterministic'
  }

  // An answer whose confidence field is not one of the four declared levels is
  // not a usable answer at all: the whole point of the field is that the caller
  // knows how much to trust the rest, and an unreadable one leaves that unknown.
  const answer = model === null || !isRecord(model) ? null : model
  const confidence = answer === null ? null : readConfidence(answer.confidence)
  if (answer === null || confidence === null) {
    return { slots, confidence: 'exact', sources, conflicts }
  }

  let usedModelValue = false

  const money = readModelMoney(answer.money)
  if (money !== null) {
    if (slots.money === null) {
      slots.money = money
      sources[MONEY] = 'model'
      usedModelValue = true
    } else if (!sameMoney(slots.money, money)) {
      conflicts.push(MONEY)
    }
  }

  const description = readModelText(answer.description)
  if (description !== null) {
    if (slots.description === null) {
      slots.description = description
      sources[DESCRIPTION] = 'model'
      usedModelValue = true
    } else if (slots.description !== description) {
      conflicts.push(DESCRIPTION)
    }
  }

  const date = readModelDate(answer.date)
  if (date !== null) {
    if (slots.date === null) {
      slots.date = date
      sources[DATE] = 'model'
      usedModelValue = true
    } else if (slots.date !== date) {
      conflicts.push(DATE)
    }
  }

  // A dimension map that is not a map is discarded whole; a single unusable
  // value inside a usable map costs only that axis.
  if (isRecord(answer.dimensions)) {
    for (const [axis, raw] of Object.entries(answer.dimensions)) {
      if (UNSAFE_KEYS.has(axis)) continue
      const value = readModelText(raw)
      if (value === null) continue

      const existing = slots.dimensions[axis]
      if (existing === undefined) {
        slots.dimensions[axis] = value
        sources[dimKey(axis)] = 'model'
        usedModelValue = true
      } else if (existing !== value) {
        conflicts.push(dimKey(axis))
      }
    }
  }

  // The reading is only as good as the weakest thing in it that the model
  // supplied. If the model contributed nothing that survived — because it was
  // silent, malformed, or overruled — nothing it said is in the answer, so the
  // answer is still purely deterministic.
  return { slots, confidence: usedModelValue ? confidence : 'exact', sources, conflicts }
}
