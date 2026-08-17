import { round2 } from '../money.js'
import type { DimensionValues, Transaction } from '../types.js'
import { directionOf } from './normalize.js'
import { validateSplit } from './split.js'

export type LedgerEvent =
  | { op: 'add'; id: string; at: string; tx: Transaction }
  | { op: 'set_category'; id: string; at: string; ref: string; category: string; by?: string; replaces?: string }
  | { op: 'set_dimension'; id: string; at: string; ref: string; axis: string; value: string | null; by?: string; replaces?: string | null }
  | { op: 'set_amount'; id: string; at: string; ref: string; amount: number; by?: string; replaces?: number }
  | { op: 'split'; id: string; at: string; ref: string; parts: Array<{ amount: number; category: string }>; by?: string }
  | { op: 'delete'; id: string; at: string; ref: string; by?: string }

// ---------------------------------------------------------------------------
// The event log -> current state. 01-ARCHITECTURE.md §3.
//
// Everything downstream reads this function's output, so it holds two
// properties above all others:
//
//   ORDER INDEPENDENCE. Events arrive from blob storage in no guaranteed order.
//   The log is sorted here, by (at, id, canonical form), before anything is
//   applied — a total order over the events themselves, not over the array they
//   came in. A shuffled, reversed or rotated log therefore folds to a byte-
//   identical result, and re-running a month cannot produce a second answer.
//
//   SURVIVABILITY. One bad blob may not take out the month. Every event is
//   re-validated against the runtime shapes it claims (it is JSON, and the
//   declared types prove nothing about it); anything that does not validate,
//   and anything referencing a transaction that is not there, is skipped and
//   the fold continues. Nothing here throws.
//
// `by` is attribution, not instruction: it is dropped during normalisation, so
// two otherwise identical events fold identically whoever recorded them.
// ---------------------------------------------------------------------------

/** Keys that would reach up the prototype chain are never dimension axes. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * A key-order-independent serialisation, used only as the last tie-break and as
 * the identity for dropping a repeated event. Two events that differ solely in
 * the order their JSON keys happened to be written in must sort — and dedupe —
 * as the same event.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// ===========================================================================
// reading an event blob
// ===========================================================================

/**
 * The transaction an `add` carries, cloned, with its dimensions rebuilt onto a
 * fresh object so no caller-supplied key can reach the prototype chain.
 *
 * Only `id` and `amount` are required: those two are what the ledger is FOR,
 * and a row missing either cannot be corrected, deleted or totalled. The rest
 * is carried verbatim. That asymmetry is deliberate — fold materialises what a
 * blob recorded, it is not the validation layer, and dropping a whole
 * transaction because one cosmetic field came back malformed would lose money
 * to protect a display string.
 */
function readTransaction(value: unknown): Transaction | null {
  if (!isRecord(value)) return null

  const id = value['id']
  const amount = value['amount']
  if (!isNonEmptyText(id)) return null
  if (!isFiniteNumber(amount)) return null

  const dimensions: DimensionValues = {}
  const rawDimensions = value['dimensions']
  if (isRecord(rawDimensions)) {
    for (const [axis, axisValue] of Object.entries(rawDimensions)) {
      if (UNSAFE_KEYS.has(axis)) continue
      dimensions[axis] = typeof axisValue === 'string' ? axisValue : null
    }
  }

  // Cast, deliberately: the guards above cover the fields this module reads and
  // writes, and everything else is passed through exactly as the blob carried
  // it (see above). `unknown` in between because a checked record is not
  // structurally a Transaction until those unchecked fields are asserted.
  return { ...value, id, amount, dimensions } as unknown as Transaction
}

/** The parts of a split, or null if any one of them is not a {amount, category} pair. */
function readParts(value: unknown): Array<{ amount: number; category: string }> | null {
  if (!Array.isArray(value)) return null

  const parts: Array<{ amount: number; category: string }> = []
  for (const raw of value) {
    if (!isRecord(raw)) return null
    const amount = raw['amount']
    const category = raw['category']
    if (!isFiniteNumber(amount)) return null
    if (!isNonEmptyText(category)) return null
    parts.push({ amount, category })
  }
  return parts
}

/**
 * An event blob as an event, or null.
 *
 * The six ops below are the whole vocabulary; anything else — a typo, a newer
 * writer's op this build does not know — is not an instruction this build can
 * honour, and an event it cannot honour is one it must not half-apply.
 *
 * `id` and `at` are read leniently here because `invert` does not need them;
 * `fold` separately requires an `at` it can place on a timeline (below).
 */
function normalizeEvent(value: unknown): LedgerEvent | null {
  if (!isRecord(value)) return null

  const id = asText(value['id'])
  const at = asText(value['at'])
  const ref = value['ref']

  switch (value['op']) {
    case 'add': {
      const tx = readTransaction(value['tx'])
      return tx === null ? null : { op: 'add', id, at, tx }
    }
    case 'set_category': {
      const category = value['category']
      if (!isNonEmptyText(ref) || typeof category !== 'string') return null
      const event: LedgerEvent = { op: 'set_category', id, at, ref, category }
      const replaces = value['replaces']
      if (typeof replaces === 'string') event.replaces = replaces
      return event
    }
    case 'set_dimension': {
      const axis = value['axis']
      const dimensionValue = value['value']
      if (!isNonEmptyText(ref) || !isNonEmptyText(axis)) return null
      if (UNSAFE_KEYS.has(axis)) return null
      if (typeof dimensionValue !== 'string' && dimensionValue !== null) return null
      const event: LedgerEvent = { op: 'set_dimension', id, at, ref, axis, value: dimensionValue }
      // `null` is a value here (the axis was previously unset), so presence is
      // what is tested, not truthiness.
      if (Object.hasOwn(value, 'replaces')) {
        const replaces = value['replaces']
        if (typeof replaces === 'string' || replaces === null) event.replaces = replaces
      }
      return event
    }
    case 'set_amount': {
      const amount = value['amount']
      if (!isNonEmptyText(ref) || !isFiniteNumber(amount)) return null
      const event: LedgerEvent = { op: 'set_amount', id, at, ref, amount }
      const replaces = value['replaces']
      if (isFiniteNumber(replaces)) event.replaces = replaces
      return event
    }
    case 'split': {
      const parts = readParts(value['parts'])
      if (!isNonEmptyText(ref) || parts === null) return null
      return { op: 'split', id, at, ref, parts }
    }
    case 'delete': {
      if (!isNonEmptyText(ref)) return null
      return { op: 'delete', id, at, ref }
    }
    default:
      return null
  }
}

/**
 * The log, validated, placed on a timeline and de-duplicated.
 *
 * The tie-break when two events land on the same instant is the higher event
 * id, and after that the canonical form of the event itself. Both are
 * properties of the events, never of the array, which is what makes the sort a
 * total order and the fold order-independent.
 *
 * An event whose `at` cannot be placed on a timeline is dropped: it has no
 * position relative to the correction before or after it, and applying it
 * anyway would make the answer depend on arrival order — the one failure mode
 * this function exists to prevent.
 */
function timeline(events: readonly unknown[]): LedgerEvent[] {
  const placed: Array<{ event: LedgerEvent; time: number; key: string }> = []

  for (const raw of events) {
    const event = normalizeEvent(raw)
    if (event === null) continue
    const time = Date.parse(event.at)
    if (!Number.isFinite(time)) continue
    placed.push({ event, time, key: stableStringify(event) })
  }

  placed.sort(
    (a, b) => a.time - b.time || compare(a.event.id, b.event.id) || compare(a.key, b.key),
  )

  // A repeated event is one event. Identical events sort adjacent by
  // construction, so this drops them without a second pass over the log.
  const ordered: LedgerEvent[] = []
  let previous: string | null = null
  for (const item of placed) {
    if (item.key === previous) continue
    ordered.push(item.event)
    previous = item.key
  }
  return ordered
}

// ===========================================================================
// fold
// ===========================================================================

interface Slot {
  tx: Transaction
  /** position of the transaction's FIRST add in the log; survives a delete */
  order: number
  /** position within a split of that transaction; 0 for an unsplit one */
  sub: number
}

/**
 * The RSD mirror of a corrected amount, at the rate the transaction already
 * implies. A dinar transaction gets the new amount unchanged; a foreign one
 * keeps the rate it was booked at rather than silently dropping out of the
 * dinar totals. Null when there is no rate to imply — an un-converted line
 * stays un-converted, and a zero original implies nothing at all.
 */
function rescaleRsd(tx: Transaction, amount: number): number | null {
  const rsd = tx.amountRsd
  if (!isFiniteNumber(rsd)) return null
  if (!isFiniteNumber(tx.amount) || tx.amount === 0) return null
  return round2((amount * rsd) / tx.amount)
}

/** One part of a split, as a transaction: the original in every respect but amount and category. */
function partTransaction(
  parent: Transaction,
  part: { amount: number; category: string },
  id: string,
): Transaction {
  return {
    ...parent,
    id,
    amount: part.amount,
    amountRsd: rescaleRsd(parent, part.amount),
    direction: directionOf(part.amount),
    category: part.category,
    dimensions: { ...parent.dimensions },
    // The parts share the original's dedupe identity on purpose: they came from
    // one statement line, and re-importing that line must still find a match
    // rather than book the money a second time.
  }
}

/**
 * Fold an event log into current state. The heart of all reporting.
 * Later events win. Ordering is by `at` then `id`, so an out-of-order input
 * array folds identically to a sorted one. Events referencing an unknown tx are ignored.
 */
export function fold(events: LedgerEvent[]): Transaction[] {
  if (!Array.isArray(events)) return []

  const live = new Map<string, Slot>()
  // First-add position per transaction id. Never cleared, so a transaction that
  // is deleted and later added back — which is exactly what undoing a delete
  // does — returns to the place it held, and the output stays stable.
  const order = new Map<string, number>()
  let next = 0

  const orderOf = (id: string): number => {
    const existing = order.get(id)
    if (existing !== undefined) return existing
    order.set(id, next)
    next += 1
    return next - 1
  }

  for (const event of timeline(events)) {
    if (event.op === 'add') {
      live.set(event.tx.id, { tx: event.tx, order: orderOf(event.tx.id), sub: 0 })
      continue
    }

    // Every remaining op corrects a transaction that must already be there. An
    // unknown reference is not an error to raise: it is a correction for a row
    // this window does not hold, or one that was deleted, and the rest of the
    // log is still good.
    const slot = live.get(event.ref)
    if (slot === undefined) continue

    switch (event.op) {
      case 'set_category': {
        live.set(event.ref, { ...slot, tx: { ...slot.tx, category: event.category } })
        break
      }
      case 'set_amount': {
        live.set(event.ref, {
          ...slot,
          tx: {
            ...slot.tx,
            amount: event.amount,
            amountRsd: rescaleRsd(slot.tx, event.amount),
            direction: directionOf(event.amount),
          },
        })
        break
      }
      case 'set_dimension': {
        const dimensions: DimensionValues = { ...slot.tx.dimensions }
        // Clearing an axis REMOVES it rather than parking a null on it, so that
        // clearing a value the transaction never had leaves the same object it
        // started with. Undo depends on that: `{project: null}` and `{}` are
        // not the same state.
        if (event.value === null) delete dimensions[event.axis]
        else dimensions[event.axis] = event.value
        live.set(event.ref, { ...slot, tx: { ...slot.tx, dimensions } })
        break
      }
      case 'split': {
        // A split that does not conserve the money, or that turns part of an
        // outflow into an inflow, is not applied at all. Half-applying it would
        // leave the ledger holding an amount nobody spent.
        if (!validateSplit(slot.tx, event.parts).valid) break
        live.delete(event.ref)
        event.parts.forEach((part, index) => {
          const id = `${event.ref}:${event.id}:${index + 1}`
          live.set(id, {
            tx: partTransaction(slot.tx, part, id),
            order: slot.order,
            sub: index + 1,
          })
        })
        break
      }
      case 'delete': {
        live.delete(event.ref)
        break
      }
    }
  }

  return [...live.values()]
    .sort((a, b) => a.order - b.order || a.sub - b.sub || compare(a.tx.id, b.tx.id))
    .map((slot) => slot.tx)
}

// ===========================================================================
// invert
// ===========================================================================

/**
 * The inverse event for /tebra undo. Returns null when the op isn't invertible.
 *
 * `current` is the state as it stood BEFORE `event` was applied — the only
 * state a prior value is recoverable from. So:
 *
 *   invert(add)    -> a delete. It needs nothing but the event's own tx id, so
 *                     an empty `current` is the normal case, not a refusal.
 *   invert(delete) -> an add carrying the whole transaction back, exactly as it
 *                     stood, corrections included.
 *   invert(split)  -> null. No single event un-splits a transaction.
 *
 * The inverse of a set_* records the value it displaced in `replaces`, which is
 * what makes an undo re-invertible: a redo is invert() applied to the undo, and
 * by then the state no longer remembers what the undo overwrote. When an event
 * carries `replaces`, that record is authoritative — it was written by whoever
 * knew; otherwise the prior value is read from `current`.
 */
export function invert(
  event: LedgerEvent,
  current: Transaction[],
  id: string,
  at: string,
): LedgerEvent | null {
  const normalized = normalizeEvent(event)
  if (normalized === null) return null

  if (normalized.op === 'add') return { op: 'delete', id, at, ref: normalized.tx.id }
  if (normalized.op === 'split') return null

  const state = Array.isArray(current) ? current : []
  const target = state.find((tx) => isRecord(tx) && tx['id'] === normalized.ref)
  // Nothing to restore to, so nothing honest to return. An undo that invents a
  // prior value is worse than an undo that declines.
  if (target === undefined) return null

  switch (normalized.op) {
    case 'delete': {
      const tx = readTransaction(target)
      return tx === null ? null : { op: 'add', id, at, tx }
    }
    case 'set_category': {
      const category = normalized.replaces ?? asText(target.category)
      return { op: 'set_category', id, at, ref: normalized.ref, category, replaces: normalized.category }
    }
    case 'set_amount': {
      const amount = normalized.replaces ?? (isFiniteNumber(target.amount) ? target.amount : 0)
      return { op: 'set_amount', id, at, ref: normalized.ref, amount, replaces: normalized.amount }
    }
    case 'set_dimension': {
      const held = isRecord(target.dimensions) ? target.dimensions[normalized.axis] : undefined
      const previous = Object.hasOwn(normalized, 'replaces')
        ? (normalized.replaces ?? null)
        : (typeof held === 'string' ? held : null)
      return {
        op: 'set_dimension',
        id,
        at,
        ref: normalized.ref,
        axis: normalized.axis,
        value: previous,
        replaces: normalized.value,
      }
    }
  }
}
