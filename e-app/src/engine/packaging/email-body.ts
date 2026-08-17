import { formatAmount, round2 } from '../money.js'

import type { Manifest, ManifestGroup, ManifestRow } from './manifest.js'
import type { DocCategory } from '../types.js'

export interface EmailBodyInput {
  companyName: string
  manifest: Manifest
  periodLabel: string       // "jul 2026"
  revised: boolean
}

// ---------------------------------------------------------------------------
// The message that arrives in the accountant's inbox. 03-DILIGAF.md §5.
//
// Nothing downstream checks this text. It is read once, by someone who was not
// in the conversation, and it is the last artefact anybody sees — so every
// number it prints is either the whole truth or is not printed at all:
//
//   - A group heading shows a total only when the manifest established one.
//     4.210,00 next to a group whose second document could not be read is a
//     figure that understates the month and looks exactly like a correct one.
//   - ⚠ marks each uncertain document on its own line, and the closing note
//     counts them. An accountant who can see what is uncertain is far more
//     useful than a clean list that hides it (§5).
//   - Amounts print in Serbian notation (13.110,00) — the dot-decimal form
//     lives in manifest.csv, which is what their software imports.
//
// Pure: no clock, no ids, no I/O, and the caller's manifest is only read.
// ---------------------------------------------------------------------------

const SERBIAN_MONTHS: readonly string[] = [
  'januar',
  'februar',
  'mart',
  'april',
  'maj',
  'jun',
  'jul',
  'avgust',
  'septembar',
  'oktobar',
  'novembar',
  'decembar',
]

/**
 * Section headings, in the words §5 prints them.
 *
 * Typed as a Record over DocCategory so the compiler refuses a category with no
 * heading: a missing key would render "undefined (1)" in an accountant's inbox,
 * and the one category §5 never names ("statement") is exactly the one a
 * hand-written lookup would forget. Read through a Map, so a category that is a
 * stranger at runtime keys nothing and can never reach a prototype member.
 */
const HEADING_BY_CATEGORY: Record<DocCategory, string> = {
  izvod: 'IZVODI',
  // Not in §5. A statement that is not the company bank izvod still needs a
  // section of its own, and it may not be filed under IZVODI, which the
  // accountant reconciles against.
  statement: 'OSTALI IZVODI',
  expense: 'TROŠKOVI',
  invoice_out: 'IZLAZNE FAKTURE',
  sef_inbound: 'SEF ULAZNE — PRIHVAĆENE',
  other: 'OSTALO',
}

const HEADINGS: ReadonlyMap<string, string> = new Map(Object.entries(HEADING_BY_CATEGORY))

/** Categories listed by filename rather than by vendor: a bank statement has no
 *  counterparty of its own, and "nepoznat dobavljač" against one would be an
 *  invented complaint about a document that is perfectly fine. */
const LISTED_BY_FILENAME: ReadonlySet<DocCategory> = new Set<DocCategory>(['izvod', 'statement'])

const UNKNOWN_VENDOR = 'nepoznat dobavljač'

/**
 * Serbian month name for a "YYYY-MM" period.
 *
 * Refuses anything else rather than labelling it. The label is printed in the
 * subject line and in the first sentence of the body, so a period this function
 * could not read must stop the send, not produce "undefined 2026".
 */
export function periodLabel(period: string): string {
  if (typeof period !== 'string') throw new Error('periodLabel: period must be a "YYYY-MM" string')

  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match === null) throw new Error(`periodLabel: "${period}" is not a YYYY-MM period`)

  const month = Number(match[2])
  const name = SERBIAN_MONTHS[month - 1]
  if (name === undefined) throw new Error(`periodLabel: "${period}" has no month ${String(month)}`)

  return `${name} ${match[1] ?? ''}`
}

/**
 * The subject line. The company name lives here — this is the one place the
 * package announces whose books it is, and the recipient's mailbox sorts on it.
 */
export function buildEmailSubject(companyName: string, periodLabel: string, revised: boolean): string {
  const suffix = revised ? ' (revidirano)' : ''
  return `${companyName} — dokumentacija za ${periodLabel}${suffix}`
}

/** Serbian numeric agreement: 1 -> dokument, 2-4 -> dokumenta, 5+ -> dokumenata,
 *  with 11-14 always the plural genitive, and the pattern repeating from 21. */
function documentNoun(count: number): string {
  const abs = Math.abs(Math.trunc(count))
  const hundreds = abs % 100
  if (hundreds >= 11 && hundreds <= 14) return 'dokumenata'
  const units = abs % 10
  if (units === 1) return 'dokument'
  if (units >= 2 && units <= 4) return 'dokumenta'
  return 'dokumenata'
}

/** The participle that agrees with that noun: obeležen / obeležena / obeleženih. */
function markedAdjective(count: number): string {
  const noun = documentNoun(count)
  if (noun === 'dokument') return 'obeležen'
  return noun === 'dokumenta' ? 'obeležena' : 'obeleženih'
}

/**
 * A cell can never introduce a line. A vendor name carrying a newline would
 * otherwise inject a row into a list an accountant reads as a list — the spec
 * fixes no sanitisation rule, so the safest reading is taken.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

const rowsOf = (group: ManifestGroup): readonly ManifestRow[] =>
  Array.isArray(group.rows) ? group.rows : []

/** The currencies attached to money in this group. */
function currenciesOf(rows: readonly ManifestRow[]): string[] {
  const seen: string[] = []
  for (const row of rows) {
    const currency = row.amount === null ? null : row.currency
    if (currency !== null && !seen.includes(currency)) seen.push(currency)
  }
  return seen
}

/**
 * The currency a group's total is denominated in, or null when not one row
 * carrying money said what it was in. Defaulting to RSD there would print a
 * figure that could be euros as dinars, which is the one mistake in this file
 * nobody downstream would catch.
 */
function groupCurrency(rows: readonly ManifestRow[]): string | null {
  return currenciesOf(rows)[0] ?? null
}

/** Money that was actually read: a figure with a currency on it. */
function isPriced(row: ManifestRow): boolean {
  return typeof row.amount === 'number' && Number.isFinite(row.amount) && row.currency !== null
}

/**
 * `TROŠKOVI (2) — 13.110,00 RSD  (PDV 2.185,00)`, and no amount at all when the
 * manifest could not establish one. An outgoing-invoice section reads as net
 * plus VAT equals total, which is the shape that section is checked against.
 */
function headingFor(group: ManifestGroup, rows: readonly ManifestRow[]): string {
  const label = HEADINGS.get(group.category) ?? String(group.category).toUpperCase()
  const head = `${label} (${rows.length})`

  const total = typeof group.total === 'number' && Number.isFinite(group.total) ? group.total : null
  if (total === null) return head

  const vat =
    typeof group.vatTotal === 'number' && Number.isFinite(group.vatTotal) ? group.vatTotal : null
  const currency = groupCurrency(rows)
  const unit = currency === null ? '' : ` ${currency}`

  if (group.category === 'invoice_out' && vat !== null) {
    const net = round2(total - vat)
    return `${head} — neto ${formatAmount(net)} + PDV ${formatAmount(vat)} = ${formatAmount(total)}${unit}`
  }

  const money = `${head} — ${formatAmount(total)}${unit}`
  return vat === null ? money : `${money}  (PDV ${formatAmount(vat)})`
}

/**
 * One listed document.
 *
 * `  2026-07-02  OMV Srbija               4.210,00`
 * `  ⚠ 2026-07-19  nepoznat dobavljač     iznos nije pročitan`
 *
 * The ⚠ hangs into the left margin exactly as §5 prints it, so a clean line is
 * never indented to make room for a marker it does not carry. Columns are
 * padded for readability; no spec fixes the alignment.
 */
function lineFor(row: ManifestRow, widths: { name: number; amount: number }, showCurrency: boolean): string {
  const marker = row.warning === null ? '' : '⚠ '
  const date = (row.date ?? '').padEnd(10)

  const name = nameOf(row).padEnd(widths.name)
  const amount = amountOf(row, showCurrency).padStart(widths.amount)
  const warning = row.warning === null ? '' : oneLine(row.warning)

  return `  ${marker}${date} ${name} ${amount} ${warning}`.replace(/[ \t]+$/, '')
}

function nameOf(row: ManifestRow): string {
  if (LISTED_BY_FILENAME.has(row.category)) return oneLine(row.filename)
  const vendor = typeof row.vendor === 'string' ? oneLine(row.vendor) : ''
  return vendor === '' ? UNKNOWN_VENDOR : vendor
}

/**
 * The amount as the accountant reads it. The currency is printed per row only
 * when one section mixes currencies — otherwise it is stated once, in the
 * heading, and a bare 4.210,00 under a RSD heading cannot be a euro.
 */
function amountOf(row: ManifestRow, showCurrency: boolean): string {
  if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) return ''
  const formatted = formatAmount(row.amount)
  return showCurrency && row.currency !== null ? `${formatted} ${row.currency}` : formatted
}

function sectionFor(group: ManifestGroup): string[] {
  const rows = rowsOf(group)
  const showCurrency = currenciesOf(rows).length > 1

  const widths = { name: 0, amount: 0 }
  for (const row of rows) {
    widths.name = Math.max(widths.name, nameOf(row).length)
    widths.amount = Math.max(widths.amount, amountOf(row, showCurrency).length)
  }

  return ['', headingFor(group, rows), ...rows.map((row) => lineFor(row, widths, showCurrency))]
}

/**
 * The Serbian body, grouped by category, with a ⚠ line for anything uncertain.
 *
 * Sections are emitted in manifest order — buildManifest already puts them in
 * the order §5 reads them (izvodi, troškovi, izlazne fakture, SEF), and
 * re-sorting them here would mean two modules owning the same decision.
 *
 * The closing note counts the uncertain documents the reader can count on the
 * page, split by what is actually uncertain about them, so the sentence is
 * never a claim the ⚠ lines do not support.
 */
export function buildEmailBody(input: EmailBodyInput): string {
  const manifest = input.manifest
  const groups: readonly ManifestGroup[] = Array.isArray(manifest.groups) ? manifest.groups : []
  const revised = input.revised === true ? ' (revidirano)' : ''

  const lines: string[] = ['Zdravo,', '', `u prilogu je dokumentacija za ${input.periodLabel}${revised}.`]

  for (const group of groups) lines.push(...sectionFor(group))

  const rows = groups.flatMap((group) => [...rowsOf(group)])
  const total =
    typeof manifest.totalDocuments === 'number' && Number.isFinite(manifest.totalDocuments)
      ? manifest.totalDocuments
      : rows.length

  lines.push('', `Ukupno u prilogu: ${String(total)} ${documentNoun(total)}.`)

  // Split so the count can never describe a set the reader cannot count: the
  // first sentence counts exactly the ⚠ lines that show no money, which is what
  // "bez pročitanog iznosa" claims; anything else warned about is counted
  // separately rather than folded into a sentence that would misstate it.
  const warned = rows.filter((row) => row.warning !== null)
  const unpriced = warned.filter((row) => !isPriced(row)).length
  const flagged = warned.length - unpriced

  if (unpriced > 0) {
    lines.push(
      `Napomena: ${String(unpriced)} ${documentNoun(unpriced)} bez pročitanog iznosa (${markedAdjective(unpriced)} ⚠ i u manifest.csv).`,
    )
  }
  if (flagged > 0) {
    lines.push(
      `Napomena: ${String(flagged)} ${documentNoun(flagged)} za proveru (${markedAdjective(flagged)} ⚠ i u manifest.csv).`,
    )
  }

  lines.push('', 'E', '')

  return lines.join('\n')
}
