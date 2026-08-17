import { round2 } from '../money.js'
import type { Transaction, DocumentFacts } from '../types.js'

// ---------------------------------------------------------------------------
// /tebra's read-only surface: the fold that produces every number the model is
// allowed to say. 09-TEBRA.md §5.4 (bounds, reported truncation), §6 and
// 00-OVERVIEW.md D19 ("all arithmetic happens in aggregate, never in the
// model's head").
//
// Two rules decide every hard case in this file, and they point the same way:
//
//   NOTHING IS SILENTLY OMITTED FROM A NUMBER. A transaction is either counted
//   in the answer or the whole query is refused. It is never quietly dropped,
//   because a total that is missing a row still looks like a total. That is why
//   the unset-dimension bucket is kept rather than discarded, why truncation is
//   reported on the result instead of applied as a silent top-N, and why a
//   total is computed over the whole matching set even when rows were cut.
//
//   WHEN THE ANSWER WOULD BE A GUESS, REFUSE. Summing EUR and RSD as bare
//   numbers, summing an `amountRsd` that was never converted, bucketing a date
//   that cannot be read, and honouring a negative row limit are all refusals.
//   An error a human reads is recoverable; a confident wrong total is not.
//
// No clock and no randomness: the calendar month is sliced off the `YYYY-MM-DD`
// string, never derived from a `Date`, so the answer does not depend on the
// process time zone.
// ---------------------------------------------------------------------------

export interface AggregateQuery {
  groupBy: string[]              // 'category' | 'dimension.project' | 'month' | 'currency' | 'vendor'
  metric: 'sum' | 'count' | 'avg'
  field?: 'amount' | 'amountRsd'
  filter?: TransactionFilter
  limit?: number
  sort?: 'asc' | 'desc'
}

export interface TransactionFilter {
  from?: string                  // YYYY-MM-DD
  to?: string
  categories?: string[]
  dimensions?: Record<string, string>
  minAmount?: number
  maxAmount?: number
  direction?: 'in' | 'out'
  descriptionContains?: string
}

export interface AggregateRow { key: Record<string, string>; value: number; count: number }

export interface AggregateResult {
  rows: AggregateRow[]
  total: number
  /** true when `limit` cut rows off — must ALWAYS be surfaced, never a silent top-N */
  truncated: boolean
  omittedRows: number
}

// ── shared helpers ─────────────────────────────────────────────────────────

/**
 * -0 is not 0 under Object.is, which is what `toBe` compares with, and a total
 * of negative zero would read as a signed figure to whoever formats it. Every
 * number leaving this module goes through here (see ledger/split.ts).
 */
function zero(value: number): number {
  return value === 0 ? 0 : value
}

/** Millionths: four more decimal places than money has, so round2 is the only tolerance. */
const SCALE = 1e6
const SAFE = Number.MAX_SAFE_INTEGER / SCALE

/**
 * Addition over the decimals as WRITTEN. `-0.1 + -0.2` is -0.30000000000000004
 * in binary, and a fold over hundreds of those accumulates drift that a final
 * round2 can no longer undo. Summing in millionths keeps the running total on
 * the decimals the statement actually wrote. Sum first, round ONCE at the end.
 */
function addExact(a: number, b: number): number {
  if (Math.abs(a) > SAFE || Math.abs(b) > SAFE) return a + b
  return (Math.round(a * SCALE) + Math.round(b * SCALE)) / SCALE
}

/** Keys a caller-supplied string may never reach through on a plain object. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Read one axis off a `dimensions` map using a name that ultimately came from
 * the model. Own properties only, so `dimension.__proto__` reads as absent
 * rather than as `Object.prototype`.
 */
function readDimension(dimensions: Record<string, string | null>, axis: string): string | null {
  if (FORBIDDEN_KEYS.has(axis)) return null
  if (!Object.hasOwn(dimensions, axis)) return null
  const value = dimensions[axis]
  return typeof value === 'string' && value !== '' ? value : null
}

/** A never-NaN numeric comparator. A NaN comparator gives V8 an implementation-defined order. */
function compareNumbers(a: number, b: number): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * A row limit is a bound on the ANSWER, so a malformed one is refused rather
 * than reinterpreted: -1 rows and 2.5 rows have no reading, and picking one
 * would silently change what the caller is shown. 0 is a real limit (keep
 * nothing, report everything omitted) and is not the same as no limit at all.
 */
function checkedLimit(limit: number | undefined, what: string): number | null {
  if (limit === undefined) return null
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    throw new Error(`${what}: limit must be a whole number of rows, 0 or more; got ${String(limit)}`)
  }
  return limit
}

interface Truncation { truncated: boolean; omittedRows: number }

/** Cut a sorted list to `limit`, ALWAYS reporting what was cut (09 §5.4 — never a silent top-N). */
function applyLimit<T>(all: T[], limit: number | null): { kept: T[]; cut: Truncation } {
  if (limit === null || all.length <= limit) {
    return { kept: all, cut: { truncated: false, omittedRows: 0 } }
  }
  return {
    kept: all.slice(0, limit),
    cut: { truncated: true, omittedRows: all.length - limit },
  }
}

// ── group axes ─────────────────────────────────────────────────────────────

const DIMENSION_PREFIX = 'dimension.'
const PLAIN_AXES: ReadonlySet<string> = new Set(['category', 'month', 'currency', 'vendor'])

/**
 * The bucket for a transaction that carries no value on the grouped axis.
 *
 * It is a bucket rather than a discard: 09 §5.4 and §6 say money never leaves
 * the report unannounced, so "the 120.000 with no project on it" is a visible
 * row and not a hole between the rows and the total.
 */
const UNSET = '(unset)'

function isGroupAxis(axis: string): boolean {
  if (PLAIN_AXES.has(axis)) return true
  if (!axis.startsWith(DIMENSION_PREFIX)) return false
  const name = axis.slice(DIMENSION_PREFIX.length)
  return name !== '' && !FORBIDDEN_KEYS.has(name)
}

/** `YYYY-MM-DD`, shape and calendar ranges. No `Date`, so no time-zone dependency. */
function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const month = Number(text.slice(5, 7))
  const day = Number(text.slice(8, 10))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/**
 * The month a transaction belongs to, from `txDate`.
 *
 * `valueDate` (when the bank settled it) and `createdAt` (when E saw it) are
 * both deliberately ignored: the month a cost belongs to is the month it was
 * incurred, and either of the others would silently move spend between periods.
 *
 * A date that cannot be read is a refusal, not a guess — there is no honest
 * month for `not-a-date`, and inventing one would put real money in a bucket
 * nobody can check.
 */
function monthOf(tx: Transaction): string {
  if (typeof tx.txDate !== 'string' || !isCalendarDate(tx.txDate)) {
    throw new Error(
      `cannot group by month: transaction ${tx.id} has an unreadable txDate ${JSON.stringify(tx.txDate)}`,
    )
  }
  return tx.txDate.slice(0, 7)
}

function axisValue(tx: Transaction, axis: string): string {
  if (axis === 'category') return tx.category
  if (axis === 'currency') return tx.currency
  if (axis === 'month') return monthOf(tx)
  if (axis === 'vendor') {
    return typeof tx.counterparty === 'string' && tx.counterparty !== '' ? tx.counterparty : UNSET
  }
  return readDimension(tx.dimensions, axis.slice(DIMENSION_PREFIX.length)) ?? UNSET
}

// ── the fold ───────────────────────────────────────────────────────────────

interface Bucket {
  key: Record<string, string>
  values: string[]
  count: number
  sum: number
  currencies: Set<string>
}

/**
 * The value a metric folds over, for one transaction.
 *
 * `null` is absence and never zero (types.ts), so an unconverted `amountRsd`
 * cannot be read as 0 — it is caught before the fold starts, by `checkField`.
 */
function fieldOf(tx: Transaction, field: 'amount' | 'amountRsd', what: string): number {
  const value = field === 'amount' ? tx.amount : tx.amountRsd
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what}: transaction ${tx.id} has no usable ${field}`)
  }
  return value
}

/**
 * Refuse before folding when the requested field cannot be summed honestly.
 *
 * `amountRsd === null` means the conversion never happened, which is unknown
 * and not zero. Dropping those rows would produce a smaller total with no sign
 * that anything was left out — the silent top-N in a different costume — so the
 * whole query is refused instead. The check runs over the FILTERED set, so a
 * transaction the caller already excluded cannot block a query it is not in.
 */
function checkField(txs: Transaction[], field: 'amount' | 'amountRsd'): void {
  if (field !== 'amountRsd') return
  const missing = txs.filter((tx) => tx.amountRsd === null)
  if (missing.length === 0) return
  throw new Error(
    `cannot total amountRsd: ${missing.length} transaction(s) in scope were never converted to RSD ` +
      `(${missing.slice(0, 3).map((tx) => tx.id).join(', ')}). An unconverted amount is unknown, not zero.`,
  )
}

/**
 * Refuse a row that would add two currencies together as bare numbers.
 *
 * 100 EUR + 6.000 RSD is 6.100 of nothing. The caller has two honest ways
 * round it — put `currency` in the group key so no row mixes, or ask for the
 * converted `amountRsd` — and both are cheaper than a wrong number.
 */
function checkCurrencies(bucket: Bucket): void {
  if (bucket.currencies.size <= 1) return
  const seen = [...bucket.currencies].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  throw new Error(
    `cannot total the original amount across currencies: one group mixes ${seen.join(' and ')}. ` +
      `Group by currency, or aggregate the converted amountRsd instead.`,
  )
}

/** ALL /tebra arithmetic happens here, never in the model (D19). */
export function aggregate(txs: Transaction[], query: AggregateQuery): AggregateResult {
  const groupBy = query.groupBy
  if (!Array.isArray(groupBy)) {
    throw new Error('aggregate: groupBy must be a list of axes')
  }
  for (const axis of groupBy) {
    if (typeof axis !== 'string' || !isGroupAxis(axis)) {
      throw new Error(
        `aggregate: unknown groupBy axis ${String(axis)}. Known axes: category, month, currency, ` +
          `vendor, dimension.<axis>.`,
      )
    }
  }

  const metric = query.metric
  if (metric !== 'sum' && metric !== 'count' && metric !== 'avg') {
    throw new Error(`aggregate: unknown metric ${String(metric)}; expected sum, count or avg`)
  }

  const sort = query.sort ?? 'desc'
  if (sort !== 'asc' && sort !== 'desc') {
    throw new Error(`aggregate: unknown sort ${String(query.sort)}; expected asc or desc`)
  }

  const limit = checkedLimit(query.limit, 'aggregate')

  // `count` needs no field at all, so a field supplied alongside it is ignored
  // rather than validated — counting three transactions never touches an
  // amount, and an unconverted one must not block a count.
  const field: 'amount' | 'amountRsd' = query.field === 'amountRsd' ? 'amountRsd' : 'amount'
  const folds = metric !== 'count'

  const matching = filterTransactions(txs, query.filter ?? {})
  if (folds) checkField(matching, field)

  const buckets = new Map<string, Bucket>()
  let totalSum = 0

  for (const tx of matching) {
    const values = groupBy.map((axis) => axisValue(tx, axis))
    const id = JSON.stringify(values)

    let bucket = buckets.get(id)
    if (bucket === undefined) {
      // Built from the validated axis list only, so no caller string can key
      // this object; `__proto__` was refused as an axis above.
      const key: Record<string, string> = {}
      groupBy.forEach((axis, index) => {
        key[axis] = values[index] ?? UNSET
      })
      bucket = { key, values, count: 0, sum: 0, currencies: new Set<string>() }
      buckets.set(id, bucket)
    }

    bucket.count += 1
    if (folds) {
      const value = fieldOf(tx, field, 'aggregate')
      bucket.sum = addExact(bucket.sum, value)
      totalSum = addExact(totalSum, value)
      // Only the ORIGINAL amount is currency-bound; amountRsd is already one unit.
      if (field === 'amount') bucket.currencies.add(tx.currency)
    }
  }

  const rows: AggregateRow[] = []
  for (const bucket of buckets.values()) {
    if (folds && field === 'amount') checkCurrencies(bucket)
    const value =
      metric === 'count'
        ? bucket.count
        : metric === 'sum'
          ? zero(round2(bucket.sum))
          : zero(round2(bucket.sum / bucket.count))
    rows.push({ key: bucket.key, value, count: bucket.count })
  }

  rows.sort((a, b) =>
    sort === 'asc' ? compareNumbers(a.value, b.value) : compareNumbers(b.value, a.value),
  )

  // The total is taken over every MATCHING transaction, before the limit is
  // applied — a truncated report still reports the true total, and the gap
  // between the visible rows and that total is exactly what `omittedRows`
  // accounts for. The pooled average is the average of the transactions, not
  // the average of the group averages, which would weight a one-row group the
  // same as a forty-row one.
  const total =
    metric === 'count'
      ? matching.length
      : matching.length === 0
        ? 0
        : metric === 'sum'
          ? zero(round2(totalSum))
          : zero(round2(totalSum / matching.length))

  const { kept, cut } = applyLimit(rows, limit)
  return { rows: kept, total, truncated: cut.truncated, omittedRows: cut.omittedRows }
}

/**
 * Every criterion is ANDed, every one is optional, and the ledger is neither
 * mutated nor reordered — the result is a new array in the caller's order.
 *
 * An absent criterion is not a criterion. A criterion that is PRESENT and
 * matches nothing (an empty `categories` list, contradictory amount bounds, an
 * inverted date range) is honoured as written and yields nothing, rather than
 * being reinterpreted as "no filter".
 */
export function filterTransactions(txs: Transaction[], filter: TransactionFilter): Transaction[] {
  if (!Array.isArray(txs)) return []
  const wanted = filter ?? {}

  const needle =
    typeof wanted.descriptionContains === 'string' ? wanted.descriptionContains.toLowerCase() : null
  const dimensions = wanted.dimensions === undefined ? [] : Object.entries(wanted.dimensions)

  return txs.filter((tx) => {
    // Dates are compared against txDate as written. YYYY-MM-DD sorts
    // lexicographically, and both ends are inclusive.
    if (wanted.from !== undefined && tx.txDate < wanted.from) return false
    if (wanted.to !== undefined && tx.txDate > wanted.to) return false

    // Exact, case-sensitive category match: 'HRAN' is not 'HRANA' and 'hrana'
    // is not 'HRANA'. A near miss that matched would file spend under a
    // category the caller did not ask for.
    if (wanted.categories !== undefined && !wanted.categories.includes(tx.category)) return false

    for (const [axis, value] of dimensions) {
      // null is "not set on this axis", and a request for a value never
      // matches it — "project = ALFA" must not answer with the unfiled ones.
      if (readDimension(tx.dimensions, axis) !== value) return false
    }

    // The declared direction, not the sign of the amount: a refund can be an
    // inflow written as a negative correction, and the ledger already decided.
    if (wanted.direction !== undefined && tx.direction !== wanted.direction) return false

    // Bounds are on the MAGNITUDE, so "over 4.000" means a 4.000 outflow too.
    // Written as a negated comparison so a non-finite amount fails the bound
    // instead of slipping through every one of them.
    const magnitude = Math.abs(tx.amount)
    if (wanted.minAmount !== undefined && !(magnitude >= wanted.minAmount)) return false
    if (wanted.maxAmount !== undefined && !(magnitude <= wanted.maxAmount)) return false

    // The description only. The counterparty is a separate, structured field,
    // and folding it in here would make "wolt" match rows whose description
    // never says so — a filter the caller cannot predict.
    if (needle !== null && !tx.description.toLowerCase().includes(needle)) return false

    return true
  })
}

export interface DocumentFilter {
  period?: string
  categories?: string[]
  vendor?: string
  minAmount?: number
  maxAmount?: number
  reviewStatus?: string
}

/**
 * The document-side read tool. Same two rules as `aggregate`: every criterion
 * is ANDed, and truncation is reported rather than applied silently (09 §5.4).
 *
 * `null` is unknown and never zero, so a document whose total was never
 * extracted is excluded by ANY amount bound — including `minAmount: 0`, which
 * would otherwise quietly claim the document is worth nothing — and a document
 * with no vendor name is excluded by any vendor filter rather than guessed at.
 */
export function searchDocuments(docs: DocumentFacts[], filter: DocumentFilter, limit?: number): {
  docs: DocumentFacts[]; truncated: boolean; omittedRows: number
} {
  const bound = checkedLimit(limit, 'searchDocuments')
  if (!Array.isArray(docs)) return { docs: [], truncated: false, omittedRows: 0 }
  const wanted = filter ?? {}
  const vendor = typeof wanted.vendor === 'string' ? wanted.vendor.toLowerCase() : null

  const matching = docs.filter((document) => {
    if (wanted.period !== undefined && document.period !== wanted.period) return false
    if (wanted.categories !== undefined && !wanted.categories.includes(document.category)) return false
    if (wanted.reviewStatus !== undefined && document.reviewStatus !== wanted.reviewStatus) return false

    if (vendor !== null) {
      if (typeof document.vendorName !== 'string') return false
      if (!document.vendorName.toLowerCase().includes(vendor)) return false
    }

    if (wanted.minAmount !== undefined || wanted.maxAmount !== undefined) {
      const total = document.amountTotal
      if (typeof total !== 'number' || !Number.isFinite(total)) return false
      if (wanted.minAmount !== undefined && !(total >= wanted.minAmount)) return false
      if (wanted.maxAmount !== undefined && !(total <= wanted.maxAmount)) return false
    }

    return true
  })

  const { kept, cut } = applyLimit(matching, bound)
  return { docs: kept, truncated: cut.truncated, omittedRows: cut.omittedRows }
}
