import { periodOf } from '../clock.js'
import { round2 } from '../money.js'

import type { DocumentFacts, DocCategory } from '../types.js'

export interface ManifestRow {
  category: DocCategory
  date: string | null
  vendor: string | null
  amount: number | null
  currency: string | null
  filename: string
  extractionMethod: string
  warning: string | null
}

export interface ManifestGroup {
  category: DocCategory
  rows: ManifestRow[]
  count: number
  total: number | null      // null when any row is missing an amount
  vatTotal: number | null
}

export interface Manifest {
  period: string
  groups: ManifestGroup[]
  totalDocuments: number
  warnings: string[]        // one per document missing an amount, etc.
}

// ---------------------------------------------------------------------------
// The monthly accountant package's index. 03-DILIGAF.md §5.
//
// This is read by someone who cannot ask a follow-up question, so the two
// governing rules are:
//
//  1. NOTHING IS SILENTLY DROPPED. A document leaves this manifest for exactly
//     two reasons, both of them declared facts about the document rather than
//     judgements about its quality: it belongs to the PERSONAL book, or it
//     belongs to a different period. A document that could not be read is
//     listed, warned about, and counted — never quietly omitted, because an
//     accountant who can see what is uncertain is far more useful than a clean
//     list that hides it (§5).
//  2. NO SUBSET SUM IS EVER PUBLISHED. A group total is the sum of every row or
//     it is null. A partial total looks exactly like a complete one and would
//     understate the month with no way to notice.
// ---------------------------------------------------------------------------

/** The order the accountant reads the package in (03-DILIGAF §5, zip layout). */
const CATEGORY_ORDER: readonly DocCategory[] = [
  'izvod',
  'statement',
  'expense',
  'invoice_out',
  'sef_inbound',
  'other',
]

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<string>(CATEGORY_ORDER)

/**
 * A bank statement carries no vendor and no amount of its own, and none was
 * ever expected of it: the §5 worked example lists IZVODI with neither, and no
 * ⚠. Anything else that arrives without an amount is a document we failed to
 * read, which is a different thing and says so.
 *
 * `statement` joins `izvod` here by owner ruling. Only `izvod` is pinned by the
 * suite, but the two are the same kind of paper — both are listed by filename
 * in the email body for the same reason — and a ⚠ on a statement would count a
 * document into "bez pročitanog iznosa" that never had an amount to read. The
 * cost, stated plainly: if `statement` is ever used for a document that DOES
 * carry an amount, an unread one will not be flagged here.
 */
const NO_AMOUNT_EXPECTED: ReadonlySet<DocCategory> = new Set<DocCategory>(['izvod', 'statement'])

const PERIOD_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * -0 is not 0 under Object.is — the comparison `toBe` uses — and a total of
 * negative zero formats as "-0,00" in an accountant's inbox. Every number
 * leaving this module passes through here (the `ledger/split.ts` idiom).
 */
function zero(value: number): number {
  return value === 0 ? 0 : value
}

/** A non-blank string, or null. Absence is null; it is never a placeholder. */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/** A real number, or null. Zero is a read amount, not an absent one. */
function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A YYYY-MM-DD that names a day that exists, or null. A date that does not
 * exist ("2026-02-30") is not passed through to the accountant's spreadsheet as
 * if it were data; it is reported as unread, which is what it is.
 */
function readDate(value: unknown): string | null {
  const text = readString(value)
  if (text === null) return null
  return periodOf(text) === null ? null : text
}

interface Prepared {
  row: ManifestRow
  vatAmount: number | null
}

/** Serbian agreement for the one-or-many warning phrase. */
function unreadPhrase(nouns: readonly string[]): string {
  const first = nouns[0]
  if (first === undefined) return ''
  if (nouns.length === 1) {
    // valuta is feminine; datum, dobavljač and iznos are masculine.
    return first === 'valuta' ? `${first} nije pročitana` : `${first} nije pročitan`
  }
  const head = nouns.slice(0, -1).join(', ')
  const tail = nouns[nouns.length - 1] ?? ''
  return `${head} i ${tail} nisu pročitani`
}

/** Money that was actually read: a figure with a currency on it. An amount
 *  whose currency was not read is not a read amount — it is a number that could
 *  be dinars or euros, and nothing may add it up or print it as either. */
function isPriced(row: ManifestRow): boolean {
  return row.amount !== null && row.currency !== null
}

/**
 * One warning per document, never one per problem: a receipt whose amount,
 * date and vendor were all unread is one thing to go and look at, not three.
 *
 * WHAT TRIGGERS a warning is deliberately narrow — unread money where money was
 * expected, a review flag, or a category this module does not know. It is NOT
 * widened to a missing date or a missing vendor on their own. The closing line
 * of the accountant email counts these documents and calls them "bez pročitanog
 * iznosa"; a predicate wider than the money would make that printed number
 * describe a set the reader cannot count on the page. An unread vendor is
 * already visible as "nepoznat dobavljač" and an unread date as an empty date
 * column, in both the body and manifest.csv — visible, just not counted.
 *
 * WHAT IT SAYS is complete: once a document is warned about, the note lists
 * everything that was not read, date and vendor included, so the accountant
 * gets the whole story about the document rather than only its amount.
 *
 * Every note a document earns is joined into this single string, so the
 * manifest's warning list, the row's ⚠ and the CSV's warning cell are three
 * views of the same fact and can never disagree about how many there are.
 */
function warningFor(
  row: ManifestRow,
  reviewStatus: unknown,
  expectAmount: boolean,
  knownCategory: boolean,
): string | null {
  const flagged = reviewStatus === 'needs_review'
  const unreadMoney = expectAmount && !isPriced(row)
  if (!unreadMoney && !flagged && knownCategory) return null

  const unread: string[] = []
  if (row.date === null) unread.push('datum')
  if (expectAmount && row.vendor === null) unread.push('dobavljač')
  if (expectAmount && row.amount === null) unread.push('iznos')
  else if (row.amount !== null && row.currency === null) unread.push('valuta')

  const notes: string[] = []
  if (unread.length > 0) notes.push(unreadPhrase(unread))
  if (flagged) notes.push('označeno za proveru')
  if (!knownCategory) notes.push('nepoznata kategorija, svrstano u OSTALO')

  return notes.length === 0 ? null : notes.join('; ')
}

/** Facts -> row. Every field is read defensively: these arrive from sidecar
 *  JSON, and a field that is not what it claims to be reads as unread rather
 *  than as a plausible-looking value. */
function prepare(
  facts: Record<string, unknown>,
  category: DocCategory,
  knownCategory: boolean,
): Prepared {
  const extraction = facts['extraction']
  const method = isRecord(extraction) ? readString(extraction['method']) : null

  const row: ManifestRow = {
    category,
    date: readDate(facts['docDate']),
    vendor: readString(facts['vendorName']),
    amount: readNumber(facts['amountTotal']),
    currency: readString(facts['currency']),
    filename: readString(facts['filename']) ?? '',
    // An unknown rung prints as an empty cell rather than as "manual", which
    // would claim a human keyed the figures in.
    extractionMethod: method ?? '',
    warning: null,
  }

  row.warning = warningFor(row, facts['reviewStatus'], !NO_AMOUNT_EXPECTED.has(category), knownCategory)

  return { row, vatAmount: readNumber(facts['vatAmount']) }
}

/** Oldest first; a document with no date sorts last rather than disappearing. */
function byDate(a: Prepared, b: Prepared): number {
  if (a.row.date === b.row.date) return 0
  if (a.row.date === null) return 1
  if (b.row.date === null) return -1
  return a.row.date < b.row.date ? -1 : 1
}

/**
 * The currencies actually attached to money in this group.
 *
 * An UNREAD currency counts as its own distinct kind, not as a shared blank.
 *
 * Mapping a null currency to `''` made every currency-less row share one key, so
 * a group where no row read a currency had a set of size 1 and the mixed-currency
 * guard did not fire. Measured: two documents at 100 and 6000 with unread
 * currencies published `TROŠKOVI (2) — 6.100,00`, printed with no unit at all,
 * for what was really ≈17,720 RSD. The guard had a hole exactly where the
 * currency is unknown — which is the case it most needed to cover.
 *
 * A unique marker per unpriced-but-unread row means one such row still totals
 * (nothing is being added across kinds), while two or more refuse.
 */
function currenciesOf(prepared: readonly Prepared[]): Set<string> {
  const currencies = new Set<string>()
  prepared.forEach((item, index) => {
    if (item.row.amount === null) return
    currencies.add(item.row.currency ?? `\u0000unread:${index}`)
  })
  return currencies
}

/**
 * The sum of every row's amount, or null. Null when any row is missing an
 * amount (a subset sum is a lie, not a fallback) and null when the rows are in
 * more than one currency (adding EUR to RSD produces a number that is wrong in
 * both). Summed first and rounded ONCE at the end.
 */
function moneyTotal(prepared: readonly Prepared[], mixedCurrency: boolean): number | null {
  if (prepared.length === 0 || mixedCurrency) return null

  let sum = 0
  for (const item of prepared) {
    if (item.row.amount === null) return null
    sum += item.row.amount
  }
  return zero(round2(sum))
}

/**
 * The same rule for VAT: every row or nothing. Whether a null vatAmount means
 * "no VAT on this document" or "VAT not read" is a spec gap, and the strict
 * reading is the one that cannot publish a figure that is quietly too small.
 * A group that carries no VAT at all totals to null, never to a zero that would
 * read as "checked, and it is nil".
 */
function vatTotal(prepared: readonly Prepared[], mixedCurrency: boolean): number | null {
  if (prepared.length === 0 || mixedCurrency) return null

  let sum = 0
  for (const item of prepared) {
    if (item.vatAmount === null) return null
    sum += item.vatAmount
  }
  return zero(round2(sum))
}

/**
 * Build the manifest for one period out of one book's documents.
 *
 * The caller supplies the documents of a single book. PERSONAL documents are
 * dropped here as well, unconditionally and before anything else is computed —
 * defence in depth for the one property in this file that has to hold even if
 * something upstream is wrong: a DILIGAF package never carries PERSONAL data
 * (04-PERSONAL.md). They are not counted, not totalled and not warned about,
 * because a warning naming a private document would leak it just as effectively
 * as a row would.
 *
 * Nothing the caller passed in is mutated.
 */
export function buildManifest(docs: DocumentFacts[], period: string): Manifest {
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    // An unrecognised period would match no document and mail an empty package
    // to the accountant with a straight face.
    throw new Error(`buildManifest: "${String(period)}" is not a YYYY-MM period`)
  }

  const byCategory = new Map<DocCategory, Prepared[]>()
  const source: readonly unknown[] = Array.isArray(docs) ? docs : []

  for (const entry of source) {
    if (!isRecord(entry)) {
      // Refusing beats both alternatives. Skipping it would be the silent
      // omission this whole module exists to prevent, and inventing a row for
      // it would put a document in the accountant's count that does not exist.
      throw new Error('buildManifest: a document is not a record of facts')
    }
    if (entry['book'] === 'PERSONAL') continue
    if (entry['period'] !== period) continue

    const declared = entry['category']
    const known = typeof declared === 'string' && KNOWN_CATEGORIES.has(declared)
    // Assertion is safe: `declared` was just checked against KNOWN_CATEGORIES,
    // which is built from the DocCategory union itself, and 'other' is the only
    // fallback. A category this module does not know still gets a row.
    const category = (known ? declared : 'other') as DocCategory

    const prepared = prepare(entry, category, known)

    // A Map, never an object literal: `category` is a caller-supplied string at
    // runtime, and "__proto__" must key a group rather than a prototype.
    const bucket = byCategory.get(category)
    if (bucket === undefined) byCategory.set(category, [prepared])
    else bucket.push(prepared)
  }

  const groups: ManifestGroup[] = []
  let totalDocuments = 0

  for (const category of CATEGORY_ORDER) {
    const prepared = byCategory.get(category)
    if (prepared === undefined || prepared.length === 0) continue

    // A copy: the caller's array was never touched, and the sort is stable, so
    // documents sharing a date keep the order they arrived in.
    const sorted = [...prepared].sort(byDate)
    const mixedCurrency = currenciesOf(sorted).size > 1

    groups.push({
      category,
      rows: sorted.map((item) => item.row),
      count: sorted.length,
      total: moneyTotal(sorted, mixedCurrency),
      vatTotal: vatTotal(sorted, mixedCurrency),
    })
    totalDocuments += sorted.length
  }

  // Warnings in the order the package reads, so the list and the ⚠ lines agree:
  // exactly one entry per warned row, naming the file so it can be found.
  const warnings: string[] = []
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.warning !== null) warnings.push(`${row.filename}: ${row.warning}`)
    }
  }

  return { period, groups, totalDocuments, warnings }
}

// ── manifest.csv ────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'category',
  'date',
  'vendor',
  'amount',
  'currency',
  'filename',
  'extraction_method',
  'warning',
] as const

const CRLF = '\r\n'

/** RFC4180: quote only when the field needs it, escape a quote by doubling it. */
function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * The machine-readable half of the package: this one is imported into the
 * accountant's software, so amounts are written with a dot decimal separator
 * and a fixed 2 decimals, never in the Serbian notation the email body uses.
 */
function csvAmount(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return ''
  return zero(round2(amount)).toFixed(2)
}

/**
 * RFC4180 CSV, including an `extraction_method` column — anything read by an
 * LLM is visible as such (§5). One record per manifest row, in manifest order,
 * and no total lines: a total in a column of amounts is a row that sums itself.
 */
export function manifestToCsv(manifest: Manifest): string {
  let out = `${CSV_COLUMNS.join(',')}${CRLF}`

  const groups: readonly ManifestGroup[] = Array.isArray(manifest.groups) ? manifest.groups : []
  for (const group of groups) {
    const rows: readonly ManifestRow[] = Array.isArray(group.rows) ? group.rows : []
    for (const row of rows) {
      const fields = [
        row.category,
        row.date ?? '',
        row.vendor ?? '',
        csvAmount(row.amount),
        row.currency ?? '',
        row.filename,
        row.extractionMethod,
        row.warning ?? '',
      ]
      out += `${fields.map((field) => csvField(String(field ?? ''))).join(',')}${CRLF}`
    }
  }

  return out
}
