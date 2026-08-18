import { describe, it, expect } from 'vitest'

import {
  buildManifest,
  manifestToCsv,
  type Manifest,
  type ManifestGroup,
  type ManifestRow,
} from '../../src/engine/packaging/manifest.js'
import { buildEmailBody, buildEmailSubject, periodLabel } from '../../src/engine/packaging/email-body.js'
import { previousMonth, currentMonth, monthBounds, periodOf } from '../../src/engine/clock.js'
import type { Clock, DocCategory, DocumentFacts, ExtractionMethod, ReviewStatus } from '../../src/engine/types.js'

/* ═══════════════════════════════════════════════════════════════════════════
 * AREA — the monthly accountant package: manifest, email body, period math.
 *
 * Under test (contract order):
 *   src/engine/packaging/manifest.ts    buildManifest, manifestToCsv
 *   src/engine/packaging/email-body.ts  buildEmailBody, buildEmailSubject, periodLabel
 *   src/engine/clock.ts                 previousMonth, currentMonth, monthBounds, periodOf
 *
 * Spec: 03-DILIGAF.md §5 (monthly package: period semantics D6, the worked
 *       email body, the ⚠ lines, the extraction_method column)
 *       01-ARCHITECTURE.md §9 (clock discipline: core never reads the clock;
 *       "previous month" on 1 January, leap years and DST are unit tests)
 *
 * Merged from three independent drafts (e1/e2/e3). Rulings that shape the
 * whole file:
 *
 *  1. Clocks are always injected fakes with a fixed instant. No test anywhere
 *     touches the system clock, and the instant is read as UTC (§9: the
 *     answer must not depend on where the function app runs).
 *  2. buildEmailBody is exercised against HAND-BUILT Manifest fixtures, not
 *     against buildManifest output. Two drafts routed the body tests through
 *     buildManifest, which makes them assertions about the manifest instead.
 *     The one place the pipeline is wired end to end is the final PERSONAL
 *     firewall block, where the property under test IS the whole pipeline.
 *  3. The body "snapshot" is an inline golden literal rather than
 *     toMatchSnapshot(). An external snapshot file would be written from
 *     whatever the first implementation emits, which is how a snapshot test
 *     silently ratifies a bug; the literal is checked against §5.
 *     Column alignment is not fixed by the spec, so goldens are compared
 *     through collapse() — content and indentation are pinned, padding is not.
 *  4. Every implementation is a stub that throws "not implemented", so no
 *     test may use expect(...).toThrow(): that passes today. Deliberate
 *     refusals go through expectRejects().
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── the RED guard ───────────────────────────────────────────────────────────
// A bare .toThrow() is satisfied by the "not implemented" stub, so it proves
// nothing. This asserts the rejection is a decision, not an absence.
function expectRejects(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    expect(e instanceof Error ? e.message : String(e)).not.toMatch(/not implemented/i)
    return
  }
  throw new Error('expected a rejection, but it returned normally')
}

// ── injected fakes ──────────────────────────────────────────────────────────

/** A Clock frozen at an instant. Hands out a fresh Date so a caller that
 *  mutates it cannot corrupt the fake. */
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) })

/** A Clock that hands out the SAME Date instance every time and counts calls —
 *  proves the period functions read the injected clock and do not mutate it. */
function sharedInstanceClock(iso: string): Clock & { calls: number; instant: Date } {
  const instant = new Date(iso)
  const fake = {
    instant,
    calls: 0,
    now(): Date {
      fake.calls += 1
      return instant
    },
  }
  return fake
}

// ── document fixtures ───────────────────────────────────────────────────────

const BASE_DOC: DocumentFacts = {
  book: 'DILIGAF',
  category: 'expense',
  period: '2026-07',
  source: 'whatsapp',
  sourceRef: 'wamid.FIXTURE',
  blobPath: 'diligaf/2026/07/expense/2026-07-02--omv-srbija--91be0d47.pdf',
  filename: 'omv.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  sha256: '91be0d47'.repeat(8),
  vendorName: 'OMV Srbija',
  vendorPib: '100002887',
  docDate: '2026-07-02',
  amountNet: 3508.33,
  vatAmount: 701.67,
  amountTotal: 4210,
  currency: 'RSD',
  lineItems: [],
  amountRsd: 4210,
  rate: null,
  rateDate: null,
  dimensions: {},
  extraction: { method: 'fiscal_qr', confidence: 'exact', model: null },
  reviewStatus: 'ok',
  createdAt: '2026-07-02T09:14:22.000Z',
}

/** A fully-read DILIGAF expense. amountRsd is kept in step with amountTotal
 *  unless a test overrides it, so no test accidentally depends on which of the
 *  two fields the implementation reads (see specGaps). */
function doc(over: Partial<DocumentFacts> = {}): DocumentFacts {
  const merged: DocumentFacts = { ...BASE_DOC, ...over }
  if (!('amountRsd' in over)) merged.amountRsd = merged.currency === 'RSD' ? merged.amountTotal : null
  return merged
}

/** A document whose amount could not be read. reviewStatus stays 'ok' so the
 *  missing amount is the only reason to warn about it. */
function noAmount(over: Partial<DocumentFacts> = {}): DocumentFacts {
  return doc({
    amountNet: null,
    vatAmount: null,
    amountTotal: null,
    currency: null,
    extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' },
    ...over,
  })
}

/** A bank statement: no vendor and no amount, and none was ever expected. */
function izvod(over: Partial<DocumentFacts> = {}): DocumentFacts {
  return doc({
    category: 'izvod',
    filename: 'izvod 265-07-01.pdf',
    vendorName: null,
    docDate: '2026-07-05',
    amountNet: null,
    vatAmount: null,
    amountTotal: null,
    currency: null,
    extraction: { method: 'pdf_text', confidence: 'exact', model: null },
    ...over,
  })
}

/** A PERSONAL-book document. Must never reach an accountant package. */
function personal(over: Partial<DocumentFacts> = {}): DocumentFacts {
  return doc({
    book: 'PERSONAL',
    category: 'expense',
    filename: 'wolt.pdf',
    blobPath: 'personal/2026/07/expense/wolt.pdf',
    vendorName: 'Wolt Beograd',
    amountTotal: 1450,
    vatAmount: null,
    ...over,
  })
}

// ── manifest fixtures, for the functions that consume a Manifest ────────────

const row = (over: Partial<ManifestRow> = {}): ManifestRow => ({
  category: 'expense',
  date: '2026-07-02',
  vendor: 'OMV Srbija',
  amount: 4210,
  currency: 'RSD',
  filename: 'omv.pdf',
  extractionMethod: 'fiscal_qr',
  warning: null,
  ...over,
})

const group = (over: Partial<ManifestGroup> = {}): ManifestGroup => ({
  category: 'expense',
  rows: [],
  count: 0,
  total: null,
  vatTotal: null,
  ...over,
})

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  period: '2026-07',
  groups: [],
  totalDocuments: 0,
  warnings: [],
  ...over,
})

/** One group of rows, with count/total kept consistent for convenience. */
const groupOf = (rows: ManifestRow[], over: Partial<ManifestGroup> = {}): ManifestGroup =>
  group({ category: rows[0]?.category ?? 'expense', rows, count: rows.length, ...over })

const only = (g: ManifestGroup): Manifest =>
  manifest({ groups: [g], totalDocuments: g.rows.length })

const categoryGroup = (m: Manifest, category: DocCategory): ManifestGroup => {
  const g = m.groups.find((x) => x.category === category)
  expect(g, `manifest has a "${category}" group`).toBeDefined()
  return g!
}

const allRows = (m: Manifest): ManifestRow[] => m.groups.flatMap((g) => g.rows)
const filenames = (m: Manifest): string[] => allRows(m).map((r) => r.filename)

// ── CSV reader, used to check the writer ────────────────────────────────────
// Decoding the published format is the only way to assert escaping without
// also pinning whether the writer quotes minimally or always.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      record.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      record.push(field)
      rows.push(record)
      record = []
      field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || record.length > 0) {
    record.push(field)
    rows.push(record)
  }
  return rows
}

function csvCell(rows: string[][], rowIndex: number, column: string): string {
  const header = rows[0]!
  const col = header.indexOf(column)
  expect(col, `column "${column}" is present in the header`).toBeGreaterThanOrEqual(0)
  return rows[rowIndex]![col]!
}

/** Header + data records, ignoring a trailing CRLF on the last record. */
const csvRecords = (csv: string): string[][] => parseCsv(csv.replace(/\r\n$/, ''))
const csvDataLines = (csv: string): string[] => csv.replace(/\r\n$/, '').split('\r\n').slice(1)

// ── body goldens ────────────────────────────────────────────────────────────
// Trailing whitespace stripped and internal runs of spaces collapsed: the
// golden pins content and indentation without pinning column alignment, which
// no spec fixes.
const collapse = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 '))
    .join('\n')
    .replace(/\s+$/, '')

const linesOf = (s: string): string[] => collapse(s).split('\n')

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — buildManifest
// ═══════════════════════════════════════════════════════════════════════════

describe('buildManifest', () => {
  it('carries the period it was asked to build', () => {
    expect(buildManifest([doc()], '2026-07').period).toBe('2026-07')
  })

  it('returns an empty manifest for no documents at all', () => {
    expect(buildManifest([], '2026-07')).toEqual({
      period: '2026-07',
      groups: [],
      totalDocuments: 0,
      warnings: [],
    })
  })

  it('groups documents by category and counts each group', () => {
    const m = buildManifest(
      [
        izvod({ filename: 'izvod-01.pdf' }),
        izvod({ filename: 'izvod-02.pdf', docDate: '2026-07-15' }),
        doc({ filename: 'exp-01.pdf' }),
        doc({ category: 'invoice_out', filename: 'inv-01.pdf' }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'izvod').count).toBe(2)
    expect(categoryGroup(m, 'izvod').rows).toHaveLength(2)
    expect(categoryGroup(m, 'expense').count).toBe(1)
    expect(categoryGroup(m, 'invoice_out').count).toBe(1)
  })

  it('emits no group for a category with no documents', () => {
    expect(buildManifest([doc()], '2026-07').groups.map((g) => g.category)).toEqual(['expense'])
  })

  // MERGE NOTE — group order: two drafts pinned izvod, expense, invoice_out,
  // sef_inbound (03-DILIGAF §5 zip layout and email order) with "other" last;
  // one also placed "statement" straight after "izvod". Kept as the union: the
  // spec-backed five in order, statement adjacent to its bank-statement
  // sibling. The statement/other placement is a spec gap, not a ruling.
  it('orders groups the way the accountant email reads them, regardless of input order', () => {
    const shuffled: DocCategory[] = ['other', 'sef_inbound', 'invoice_out', 'expense', 'statement', 'izvod']
    const m = buildManifest(
      shuffled.map((category) => doc({ category, filename: `${category}.pdf` })),
      '2026-07',
    )

    expect(m.groups.map((g) => g.category)).toEqual([
      'izvod',
      'statement',
      'expense',
      'invoice_out',
      'sef_inbound',
      'other',
    ])
  })

  it('counts every document it kept, across all groups', () => {
    const m = buildManifest(
      [
        izvod({ filename: 'a.pdf' }),
        doc({ filename: 'b.pdf' }),
        doc({ filename: 'c.pdf' }),
        doc({ category: 'sef_inbound', filename: 'd.pdf' }),
      ],
      '2026-07',
    )

    expect(m.totalDocuments).toBe(4)
    expect(allRows(m)).toHaveLength(4)
    expect(m.totalDocuments).toBe(m.groups.reduce((n, g) => n + g.count, 0))
  })

  it('sorts rows inside a group by document date, oldest first', () => {
    const m = buildManifest(
      [
        doc({ filename: 'c.pdf', docDate: '2026-07-20' }),
        doc({ filename: 'a.pdf', docDate: '2026-07-02' }),
        doc({ filename: 'b.pdf', docDate: '2026-07-11' }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
  })

  it('places a document with no date last rather than dropping it', () => {
    const m = buildManifest(
      [doc({ filename: 'undated.pdf', docDate: null }), doc({ filename: 'dated.pdf', docDate: '2026-07-02' })],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual(['dated.pdf', 'undated.pdf'])
  })

  it('excludes a document belonging to a different period than the one requested', () => {
    const m = buildManifest(
      [
        doc({ filename: 'jul.pdf', period: '2026-07', docDate: '2026-07-20' }),
        doc({ filename: 'jun.pdf', period: '2026-06', docDate: '2026-06-20' }),
      ],
      '2026-07',
    )

    expect(filenames(m)).toEqual(['jul.pdf'])
    expect(m.totalDocuments).toBe(1)
  })

  it('includes a late arrival whose period is the packaged month', () => {
    // A July receipt that landed on 3 August still belongs to the July package (§5, D6).
    const m = buildManifest(
      [doc({ filename: 'late.pdf', period: '2026-07', docDate: '2026-07-31', createdAt: '2026-08-03T10:00:00.000Z' })],
      '2026-07',
    )

    expect(m.totalDocuments).toBe(1)
  })
})

describe('buildManifest rows', () => {
  it('copies date, vendor, amount, currency and filename onto the row', () => {
    const m = buildManifest(
      [doc({ filename: 'omv.pdf', docDate: '2026-07-02', vendorName: 'OMV Srbija', amountTotal: 4210, currency: 'RSD' })],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows[0]).toMatchObject({
      category: 'expense',
      date: '2026-07-02',
      vendor: 'OMV Srbija',
      amount: 4210,
      currency: 'RSD',
      filename: 'omv.pdf',
    })
  })

  it('leaves an unread vendor, date, amount and currency null rather than inventing placeholders', () => {
    const m = buildManifest([noAmount({ filename: 'x.pdf', vendorName: null, docDate: null })], '2026-07')
    const unread = categoryGroup(m, 'expense').rows[0]!

    expect(unread).toMatchObject({ vendor: null, date: null, amount: null, currency: null })
    expect(unread.amount).not.toBe(0)
  })

  it.each<[ExtractionMethod]>([
    ['cache'],
    ['fiscal_qr'],
    ['vendor_profile'],
    ['pdf_text'],
    ['di_invoice'],
    ['di_receipt'],
    ['llm_vision'],
    ['manual'],
  ])('carries the %s extraction method through to the row', (method) => {
    const m = buildManifest([doc({ extraction: { method, confidence: 'high', model: null } })], '2026-07')

    expect(categoryGroup(m, 'expense').rows[0]!.extractionMethod).toBe(method)
  })

  it('records the extraction method per document, not per group', () => {
    const m = buildManifest(
      [
        doc({ filename: 'qr.pdf', docDate: '2026-07-01', extraction: { method: 'fiscal_qr', confidence: 'exact', model: null } }),
        doc({
          filename: 'llm.jpg',
          docDate: '2026-07-02',
          extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' },
        }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.extractionMethod)).toEqual(['fiscal_qr', 'llm_vision'])
  })
})

describe('buildManifest totals', () => {
  it('totals a group whose rows all carry an amount', () => {
    const m = buildManifest(
      [doc({ filename: 'a.pdf', amountTotal: 4210 }), doc({ filename: 'b.pdf', amountTotal: 182220 })],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBe(186430)
  })

  it('totals a group of exactly one document', () => {
    expect(categoryGroup(buildManifest([doc({ amountTotal: 4210 })], '2026-07'), 'expense').total).toBe(4210)
  })

  it('returns a null group total when any single row is missing an amount, rather than summing the rest', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210 }),
        doc({ filename: 'b.pdf', amountTotal: 8900 }),
        noAmount({ filename: 'c.pdf' }),
      ],
      '2026-07',
    )
    const expenses = categoryGroup(m, 'expense')

    expect(expenses.total).toBeNull()
    expect(expenses.total).not.toBe(13110) // the subset sum is a lie, not a fallback
    expect(expenses.count).toBe(3) // the document is still listed
    expect(expenses.rows.map((r) => r.amount)).toContain(null)
  })

  it('returns a null group total when every row is missing an amount, rather than zero', () => {
    const m = buildManifest([noAmount({ filename: 'a.pdf' }), noAmount({ filename: 'b.pdf' })], '2026-07')

    expect(categoryGroup(m, 'expense').total).toBeNull()
    expect(categoryGroup(m, 'expense').total).not.toBe(0)
  })

  it('does not let one group with a missing amount null out another group total', () => {
    const m = buildManifest(
      [noAmount({ filename: 'a.pdf' }), doc({ category: 'sef_inbound', filename: 'b.pdf', amountTotal: 12480 })],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBeNull()
    expect(categoryGroup(m, 'sef_inbound').total).toBe(12480)
  })

  it('keeps a total of exactly zero distinguishable from an unknown total', () => {
    const m = buildManifest(
      [doc({ category: 'other', filename: 'a.pdf', amountTotal: 0, vatAmount: 0 })],
      '2026-07',
    )

    expect(categoryGroup(m, 'other').total).toBe(0)
  })

  it('treats a zero amount as a read amount, not as an absent one', () => {
    const m = buildManifest(
      [doc({ filename: 'a.pdf', amountTotal: 0, vatAmount: 0 }), doc({ filename: 'b.pdf', amountTotal: 4210 })],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBe(4210)
    expect(m.warnings).toEqual([])
  })

  it('returns a null group total when the rows are in different currencies', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, currency: 'RSD' }),
        doc({ filename: 'b.pdf', amountTotal: 300, currency: 'EUR' }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBeNull()
  })

  it('totals VAT when every row in the group carries a VAT amount', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, vatAmount: 716.67 }),
        doc({ filename: 'b.pdf', amountTotal: 182220, vatAmount: 30355 }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').vatTotal).toBeCloseTo(31071.67, 2)
  })

  // MERGE NOTE — vatTotal with a partial VAT reading: only one draft covered it,
  // the other two only covered "all rows have VAT" and "no row has VAT". Adopted
  // the strict reading (null when any row lacks VAT) to match the ruling the spec
  // does make for the money total — never publish a subset sum. Whether a null
  // vatAmount means "no VAT on this document" or "VAT not read" is a spec gap.
  it('returns a null VAT total when any row is missing a VAT amount, while still totalling the money', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, vatAmount: 701.67 }),
        doc({ filename: 'b.pdf', amountTotal: 8900, vatAmount: null }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBe(13110)
    expect(categoryGroup(m, 'expense').vatTotal).toBeNull()
  })

  it('returns a null VAT total, not zero, when no row in the group carries VAT', () => {
    const m = buildManifest([izvod()], '2026-07')

    expect(categoryGroup(m, 'izvod').vatTotal).toBeNull()
    expect(categoryGroup(m, 'izvod').vatTotal).not.toBe(0)
  })

  it('leaves an izvod group without a total, because a statement carries no amount of its own', () => {
    const m = buildManifest(
      [izvod({ filename: 'izvod-01.pdf' }), izvod({ filename: 'izvod-02.pdf', docDate: '2026-07-15' })],
      '2026-07',
    )

    expect(categoryGroup(m, 'izvod').total).toBeNull()
    expect(categoryGroup(m, 'izvod').vatTotal).toBeNull()
    expect(categoryGroup(m, 'izvod').count).toBe(2)
  })
})

describe('buildManifest warnings', () => {
  it('produces no warnings when every document was read completely', () => {
    const m = buildManifest([doc({ filename: 'a.pdf' }), doc({ filename: 'b.pdf' })], '2026-07')

    expect(m.warnings).toEqual([])
    expect(allRows(m).every((r) => r.warning === null)).toBe(true)
  })

  it('warns exactly once per document whose amount was not read', () => {
    const m = buildManifest(
      [
        doc({ filename: 'ok.pdf' }),
        noAmount({ filename: 'bad-1.pdf', docDate: '2026-07-19' }),
        noAmount({ filename: 'bad-2.pdf', docDate: '2026-07-23' }),
      ],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(2)
    expect(m.warnings.every((w) => typeof w === 'string' && w.length > 0)).toBe(true)
  })

  it('names the offending document in its warning so the accountant can find it', () => {
    const m = buildManifest([noAmount({ filename: 'blurry-receipt.jpg' })], '2026-07')

    expect(m.warnings).toHaveLength(1)
    expect(m.warnings[0]).toContain('blurry-receipt.jpg')
  })

  it('marks the uncertain row itself, and only that row', () => {
    const m = buildManifest([doc({ filename: 'ok.pdf' }), noAmount({ filename: 'bad.pdf' })], '2026-07')
    const rows = allRows(m)

    expect(rows.find((r) => r.filename === 'ok.pdf')!.warning).toBeNull()
    expect(rows.find((r) => r.filename === 'bad.pdf')!.warning).not.toBeNull()
  })

  it('warns once, not once per problem, for a document missing its amount, date and vendor', () => {
    const m = buildManifest(
      [noAmount({ filename: 'bad.pdf', docDate: null, vendorName: null, reviewStatus: 'needs_review' })],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(1)
  })

  it('warns for every uncertain document sharing one group', () => {
    const m = buildManifest(
      [
        noAmount({ filename: 'a.pdf', docDate: '2026-07-01' }),
        noAmount({ filename: 'b.pdf', docDate: '2026-07-02' }),
        noAmount({ filename: 'c.pdf', docDate: '2026-07-03' }),
      ],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(3)
    expect(categoryGroup(m, 'expense').rows.filter((r) => r.warning !== null)).toHaveLength(3)
  })

  it('warns across groups, not just within the first one', () => {
    const m = buildManifest(
      [noAmount({ filename: 'a.pdf' }), noAmount({ category: 'sef_inbound', filename: 'b.xml' })],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(2)
  })

  it('still lists an uncertain document rather than dropping it from the package', () => {
    const m = buildManifest([noAmount({ filename: 'bad.pdf' })], '2026-07')

    expect(m.totalDocuments).toBe(1)
    expect(filenames(m)).toEqual(['bad.pdf'])
  })

  // MERGE NOTE — an izvod with no amount: one draft exempted it, the others
  // never covered it. Exemption kept, on the spec: the §5 worked example lists
  // IZVODI (3) with no amounts and no ⚠, and its closing note counts only the
  // 2 expense documents "bez pročitanog iznosa".
  it('does not warn about an izvod that carries no amount, because none was expected', () => {
    const m = buildManifest([izvod()], '2026-07')

    expect(m.warnings).toEqual([])
    expect(categoryGroup(m, 'izvod').rows[0]!.warning).toBeNull()
  })

  it('warns about a document queued for review even though its amount was read', () => {
    const m = buildManifest([doc({ filename: 'doubtful.pdf', amountTotal: 4210, reviewStatus: 'needs_review' })], '2026-07')

    expect(m.warnings).toHaveLength(1)
    expect(categoryGroup(m, 'expense').rows[0]!.warning).not.toBeNull()
  })

  it.each<[ReviewStatus]>([['ok'], ['reviewed']])(
    'does not warn about a document whose review status is %s',
    (reviewStatus) => {
      const m = buildManifest([doc({ filename: 'settled.pdf', amountTotal: 4210, reviewStatus })], '2026-07')

      expect(m.warnings).toEqual([])
      expect(categoryGroup(m, 'expense').rows[0]!.warning).toBeNull()
    },
  )

  it('does not let a flagged-but-priced document null the group total', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, reviewStatus: 'needs_review' }),
        doc({ filename: 'b.pdf', amountTotal: 8900 }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBe(13110)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — manifestToCsv
// ═══════════════════════════════════════════════════════════════════════════

// MERGE NOTE — header: one draft pinned the exact column list, two only checked
// that the columns are present. Pinned version kept: it is the ManifestRow field
// order from the source contract, and it is the only form that also fixes the
// column order an accountant's spreadsheet import depends on.
const CSV_HEADER = 'category,date,vendor,amount,currency,filename,extraction_method,warning'

describe('manifestToCsv', () => {
  const oneRow = (over: Partial<ManifestRow> = {}): Manifest => only(groupOf([row(over)]))

  it('starts with a header row naming every column, including extraction_method', () => {
    const csv = manifestToCsv(oneRow())

    expect(csv.split('\r\n')[0]).toBe(CSV_HEADER)
  })

  it('emits the header and nothing else for an empty manifest', () => {
    const csv = manifestToCsv(manifest())

    expect(csv.replace(/\r\n$/, '')).toBe(CSV_HEADER)
    expect(csvRecords(csv)).toHaveLength(1)
  })

  it('terminates records with CRLF as RFC4180 requires', () => {
    const csv = manifestToCsv(oneRow())

    expect(csv).toContain('\r\n')
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('writes one record per manifest row and no total lines', () => {
    const csv = manifestToCsv(
      manifest({
        groups: [
          groupOf([row({ category: 'izvod', filename: 'z.pdf', vendor: null, amount: null, currency: null })]),
          groupOf([row({ filename: 'a.pdf' }), row({ filename: 'b.pdf' })], { total: 8420 }),
        ],
        totalDocuments: 3,
      }),
    )

    expect(csvDataLines(csv)).toHaveLength(3)
    expect(csvRecords(csv).every((r) => r.length === CSV_HEADER.split(',').length)).toBe(true)
  })

  it('writes the rows of every group, in manifest order', () => {
    const csv = manifestToCsv(
      manifest({
        groups: [
          groupOf([row({ category: 'izvod', filename: 'izvod.pdf', vendor: null, amount: null, currency: null })]),
          groupOf([row({ filename: 'exp.pdf' })]),
          groupOf([row({ category: 'invoice_out', filename: 'inv.pdf' })]),
          groupOf([row({ category: 'sef_inbound', filename: 'sef.pdf' })]),
        ],
        totalDocuments: 4,
      }),
    )
    const records = csvRecords(csv)

    expect(records.slice(1).map((r) => r[0])).toEqual(['izvod', 'expense', 'invoice_out', 'sef_inbound'])
    expect(records.slice(1).map((r) => r[records[0]!.indexOf('filename')])).toEqual([
      'izvod.pdf',
      'exp.pdf',
      'inv.pdf',
      'sef.pdf',
    ])
  })

  it('writes a plain row unquoted', () => {
    const csv = manifestToCsv(oneRow())

    expect(csvDataLines(csv)[0]).toBe('expense,2026-07-02,OMV Srbija,4210.00,RSD,omv.pdf,fiscal_qr,')
  })

  it('writes the extraction method of each row into the extraction_method column', () => {
    const csv = manifestToCsv(
      only(
        groupOf([
          row({ filename: 'a.pdf', extractionMethod: 'fiscal_qr' }),
          row({ filename: 'b.jpg', extractionMethod: 'llm_vision' }),
        ]),
      ),
    )
    const records = csvRecords(csv)

    expect(csvCell(records, 1, 'extraction_method')).toBe('fiscal_qr')
    expect(csvCell(records, 2, 'extraction_method')).toBe('llm_vision')
  })

  // MERGE NOTE — amount format: one draft pinned "4210.00", one only required
  // Number(cell) to round-trip, one only required it not be a zero. Pinned the
  // machine-readable fixed-2dp dot form here (§5: the CSV is for the
  // accountant's software, the Serbian formatting lives in the email body);
  // every other CSV test asserts through Number() so only this one case
  // depends on the decimal count. The exact form is a spec gap.
  it('writes the amount with a dot decimal separator, never in Serbian notation', () => {
    const csv = manifestToCsv(oneRow({ amount: 186430 }))

    expect(csvDataLines(csv)[0]).toContain(',186430.00,')
    expect(csv).not.toContain('186.430,00')
    expect(Number(csvCell(csvRecords(csv), 1, 'amount'))).toBe(186430)
  })

  it('writes an empty field, never the word null, for a value that was not read', () => {
    const csv = manifestToCsv(oneRow({ vendor: null, date: null, amount: null, currency: null }))

    expect(csvDataLines(csv)[0]).toBe('expense,,,,,omv.pdf,fiscal_qr,')
    expect(csv).not.toContain('null')
    expect(csv).not.toContain('undefined')
  })

  it('fills the warning cell for an uncertain row and leaves it empty for a clean one', () => {
    const csv = manifestToCsv(
      only(
        groupOf([
          row({ filename: 'ok.pdf' }),
          row({ filename: 'bad.jpg', amount: null, currency: null, warning: 'iznos nije pročitan' }),
        ]),
      ),
    )
    const records = csvRecords(csv)

    expect(csvCell(records, 1, 'warning')).toBe('')
    expect(csvCell(records, 2, 'warning')).toBe('iznos nije pročitan')
  })

  it('quotes a warning that contains a comma', () => {
    const csv = manifestToCsv(oneRow({ warning: 'iznos nije pročitan, proveriti' }))

    expect(csv).toContain('"iznos nije pročitan, proveriti"')
    expect(csvCell(csvRecords(csv), 1, 'warning')).toBe('iznos nije pročitan, proveriti')
  })

  it.each<[string, string]>([
    ['Marks & Spencer, Beograd d.o.o.', 'a comma'],
    ['A, B, C', 'several commas'],
    ['DOO "MERKUR" Novi Sad', 'double quotes'],
    ['"', 'nothing but a double quote'],
    ['","', 'a quoted comma'],
    ['Trailing quote"', 'a trailing quote'],
    ['"Leading quote', 'a leading quote'],
    ['Company\nSecond line', 'an embedded newline'],
    ['Company\r\nSecond line', 'an embedded CRLF'],
    ['A, "B"\nC', 'a comma, a quote and a newline at once'],
    ['  OMV  ', 'leading and trailing spaces'],
    ['Šećerana Đurđević Čačak', 'Serbian diacritics'],
    ['Zdravo, "šta ima"?\nĆirilica ЋИРИЛИЦА', 'diacritics with every special character'],
  ])('round-trips the vendor name %j, which contains %s', (vendor) => {
    const records = csvRecords(manifestToCsv(oneRow({ vendor })))

    expect(records).toHaveLength(2)
    expect(records[1]!.length).toBe(records[0]!.length)
    expect(csvCell(records, 1, 'vendor')).toBe(vendor)
  })

  it('escapes a double quote by doubling it rather than by dropping or backslashing it', () => {
    const csv = manifestToCsv(oneRow({ vendor: 'Vendor "X" d.o.o.' }))

    expect(csv).toContain('"Vendor ""X"" d.o.o."')
    expect(csv).not.toContain('\\"')
  })

  it('keeps an embedded CRLF inside one quoted field instead of splitting the record', () => {
    const csv = manifestToCsv(oneRow({ vendor: 'Prvi red\r\nDrugi red' }))

    expect(csv).toContain('"Prvi red\r\nDrugi red"')
    expect(csv.startsWith(`${CSV_HEADER}\r\nexpense,2026-07-02,"Prvi red\r\nDrugi red",`)).toBe(true)
    expect(csvRecords(csv)).toHaveLength(2)
  })

  it('escapes a filename containing a comma just as it escapes a vendor', () => {
    const records = csvRecords(manifestToCsv(oneRow({ filename: 'racun, jul, 2026.pdf' })))

    expect(csvCell(records, 1, 'filename')).toBe('racun, jul, 2026.pdf')
    expect(records[1]!.length).toBe(records[0]!.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — buildEmailBody
// ═══════════════════════════════════════════════════════════════════════════

const IZVOD_GROUP = groupOf(
  [
    row({ category: 'izvod', date: '2026-07-05', vendor: null, amount: null, currency: null, filename: 'izvod 265-07-01.pdf', extractionMethod: 'pdf_text' }),
    row({ category: 'izvod', date: '2026-07-15', vendor: null, amount: null, currency: null, filename: 'izvod 265-07-02.pdf', extractionMethod: 'pdf_text' }),
  ],
  { total: null, vatTotal: null },
)

const EXPENSE_GROUP = groupOf(
  [
    row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, filename: 'omv.pdf' }),
    row({ date: '2026-07-04', vendor: 'Kancelarijski materijal', amount: 8900, filename: 'kancelarija.pdf' }),
  ],
  { total: 13110, vatTotal: 2185 },
)

const CLEAN_MANIFEST = manifest({ groups: [IZVOD_GROUP, EXPENSE_GROUP], totalDocuments: 4 })

const input = (over: Partial<Parameters<typeof buildEmailBody>[0]> = {}) => ({
  companyName: 'DILIGAF DOO',
  manifest: CLEAN_MANIFEST,
  periodLabel: 'jul 2026',
  revised: false,
  ...over,
})

describe('buildEmailBody', () => {
  it('renders the whole accountant email for a clean month', () => {
    const expected = [
      'Zdravo,',
      '',
      // UNFREEZE CANDIDATE-016A: this golden omitted the company name while `:986`
      // required it in the same body — unsatisfiable without hardcoding 'DILIGAF DOO',
      // which that test's own title forbids. Danilo's ruling: carry it in both the
      // Subject and the body, since the accountant receives DILIGAF *and* SMOQUA
      // packages, and duplication is safer than an accidental omission.
      // NOTE: `03-DILIGAF.md` §5's verbatim body sample still omits it and needs the
      // matching line. Serbian wording here is provisional pending Danilo's review.
      'u prilogu je dokumentacija za DILIGAF DOO, jul 2026.',
      '',
      'IZVODI (2)',
      '  2026-07-05 izvod 265-07-01.pdf',
      '  2026-07-15 izvod 265-07-02.pdf',
      '',
      'TROŠKOVI (2) — 13.110,00 RSD (PDV 2.185,00)',
      '  2026-07-02 OMV Srbija 4.210,00',
      '  2026-07-04 Kancelarijski materijal 8.900,00',
      '',
      'Ukupno u prilogu: 4 dokumenta.',
      '',
      'E',
    ].join('\n')

    expect(collapse(buildEmailBody(input()))).toBe(expected)
  })

  it('renders the whole accountant email for a month with uncertain documents', () => {
    const uncertain = manifest({
      groups: [
        groupOf(
          [
            row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, filename: 'omv.pdf' }),
            row({ date: '2026-07-19', vendor: null, amount: null, currency: null, filename: 'blurry.jpg', extractionMethod: 'llm_vision', warning: 'iznos nije pročitan' }),
            row({ date: '2026-07-23', vendor: 'Dobavljač B', amount: null, currency: null, filename: 'racun.jpg', extractionMethod: 'llm_vision', warning: 'iznos nije pročitan' }),
          ],
          { total: null, vatTotal: null },
        ),
      ],
      totalDocuments: 3,
      warnings: ['blurry.jpg: iznos nije pročitan', 'racun.jpg: iznos nije pročitan'],
    })
    const expected = [
      'Zdravo,',
      '',
      // UNFREEZE CANDIDATE-016A — see the note on the preceding golden.
      'u prilogu je dokumentacija za DILIGAF DOO, jul 2026.',
      '',
      'TROŠKOVI (3)',
      '  2026-07-02 OMV Srbija 4.210,00',
      '  ⚠ 2026-07-19 nepoznat dobavljač iznos nije pročitan',
      '  ⚠ 2026-07-23 Dobavljač B iznos nije pročitan',
      '',
      'Ukupno u prilogu: 3 dokumenta.',
      'Napomena: 2 dokumenta bez pročitanog iznosa (obeležena ⚠ i u manifest.csv).',
      '',
      'E',
    ].join('\n')

    expect(collapse(buildEmailBody(input({ manifest: uncertain })))).toBe(expected)
  })

  it('uses the period label it was given rather than deriving one', () => {
    expect(buildEmailBody(input({ periodLabel: 'decembar 2025' }))).toContain('decembar 2025')
  })

  it('uses the company name it was given rather than a hardcoded one', () => {
    expect(buildEmailBody(input({ companyName: 'SMOQUA DOO' }))).toContain('SMOQUA DOO')
  })

  // MERGE NOTE — SEF heading: two drafts asserted only the substring
  // "SEF ULAZNE"; the third pinned "SEF ULAZNE — PRIHVAĆENE", which is what
  // 03-DILIGAF §5 prints. The spec-backed form wins. "OSTALO" for the
  // catch-all category is not in the spec — see specGaps.
  it.each<[DocCategory, string]>([
    ['izvod', 'IZVODI'],
    ['expense', 'TROŠKOVI'],
    ['invoice_out', 'IZLAZNE FAKTURE'],
    ['sef_inbound', 'SEF ULAZNE — PRIHVAĆENE'],
    ['other', 'OSTALO'],
  ])('heads the %s group "%s" with its document count', (category, heading) => {
    const g = groupOf([row({ category, amount: null, currency: null, filename: 'x.pdf' })], {
      total: null,
      vatTotal: null,
    })

    expect(collapse(buildEmailBody(input({ manifest: only(g) })))).toContain(`${heading} (1)`)
  })

  it('orders the sections izvodi, troškovi, izlazne fakture, SEF', () => {
    const body = buildEmailBody(
      input({
        manifest: manifest({
          groups: [
            IZVOD_GROUP,
            EXPENSE_GROUP,
            groupOf([row({ category: 'invoice_out', vendor: 'Klijent A', amount: 360000, filename: '0007-2026.pdf' })], { total: 360000, vatTotal: 60000 }),
            groupOf([row({ category: 'sef_inbound', vendor: 'Telekom Srbija', amount: 12480, filename: 'telekom.xml' })], { total: 12480, vatTotal: null }),
          ],
          totalDocuments: 6,
        }),
      }),
    )

    expect(body.indexOf('IZVODI')).toBeLessThan(body.indexOf('TROŠKOVI'))
    expect(body.indexOf('TROŠKOVI')).toBeLessThan(body.indexOf('IZLAZNE FAKTURE'))
    expect(body.indexOf('IZLAZNE FAKTURE')).toBeLessThan(body.indexOf('SEF ULAZNE'))
  })

  it('formats amounts in Serbian notation', () => {
    const body = buildEmailBody(input())

    expect(body).toContain('13.110,00 RSD')
    expect(body).toContain('4.210,00')
    expect(body).toContain('8.900,00')
    expect(body).not.toContain('4210.00')
  })

  it('shows the group total without a VAT figure when the VAT total is unknown', () => {
    const g = groupOf([row({})], { total: 4210, vatTotal: null })
    const body = collapse(buildEmailBody(input({ manifest: only(g) })))

    expect(body).toContain('TROŠKOVI (1) — 4.210,00 RSD')
    expect(body).not.toContain('PDV')
  })

  it('renders an outgoing-invoice heading as net plus VAT equals total', () => {
    const g = groupOf(
      [
        row({ category: 'invoice_out', date: '2026-07-10', vendor: 'Klijent A', amount: 360000, filename: '0007-2026.pdf', extractionMethod: 'manual' }),
        row({ category: 'invoice_out', date: '2026-07-20', vendor: 'Klijent B', amount: 360000, filename: '0008-2026.pdf', extractionMethod: 'manual' }),
      ],
      { total: 720000, vatTotal: 120000 },
    )

    expect(collapse(buildEmailBody(input({ manifest: only(g) })))).toContain(
      'IZLAZNE FAKTURE (2) — neto 600.000,00 + PDV 120.000,00 = 720.000,00 RSD',
    )
  })

  it('prints no amount in the heading of a group whose total could not be established', () => {
    const g = groupOf(
      [row({ filename: 'a.pdf' }), row({ filename: 'b.jpg', amount: null, currency: null, warning: 'iznos nije pročitan' })],
      { total: null, vatTotal: null },
    )
    const m = manifest({ groups: [g], totalDocuments: 2, warnings: ['b.jpg: iznos nije pročitan'] })
    const heading = linesOf(buildEmailBody(input({ manifest: m }))).find((l) => l.startsWith('TROŠKOVI'))

    // 4.210,00 alone is not the group total — printing it would understate the month.
    expect(heading).toBe('TROŠKOVI (2)')
  })

  it('carries no warning marker and no closing note when every document was read', () => {
    const body = buildEmailBody(input())

    expect(body).not.toContain('⚠')
    expect(body).not.toContain('Napomena:')
  })

  it('marks one ⚠ line per uncertain document and leaves the clean lines unmarked', () => {
    const g = groupOf(
      [
        row({ date: '2026-07-02', filename: 'ok.pdf' }),
        row({ date: '2026-07-19', vendor: 'Dobavljač A', amount: null, currency: null, filename: 'a.jpg', warning: 'iznos nije pročitan' }),
        row({ date: '2026-07-21', vendor: 'Dobavljač B', amount: null, currency: null, filename: 'b.jpg', warning: 'iznos nije pročitan' }),
      ],
      { total: null, vatTotal: null },
    )
    const m = manifest({
      groups: [g],
      totalDocuments: 3,
      warnings: ['a.jpg: iznos nije pročitan', 'b.jpg: iznos nije pročitan'],
    })
    // UNFREEZE CANDIDATE-016B: the guard `&& l.startsWith('  ')` was present in drafts
    // e3:952 and e2:907 and dropped by the merge. Without it the spec-mandated
    // `Napomena:` closing line — which itself contains ⚠ — is counted as a document row.
    const warned = linesOf(buildEmailBody(input({ manifest: m }))).filter((l) => l.includes('⚠') && l.startsWith('  '))

    expect(warned).toHaveLength(2)
    expect(warned.some((l) => l.includes('OMV Srbija'))).toBe(false)
  })

  it('names an unknown vendor on the ⚠ line instead of leaving the column blank', () => {
    const g = groupOf(
      [row({ date: '2026-07-19', vendor: null, amount: null, currency: null, filename: 'blurry.jpg', warning: 'iznos nije pročitan' })],
      { total: null, vatTotal: null },
    )
    const m = manifest({ groups: [g], totalDocuments: 1, warnings: ['blurry.jpg: iznos nije pročitan'] })
    // UNFREEZE CANDIDATE-016B — see the note on the preceding test.
    const warned = linesOf(buildEmailBody(input({ manifest: m }))).filter((l) => l.includes('⚠') && l.startsWith('  '))

    expect(warned).toEqual(['  ⚠ 2026-07-19 nepoznat dobavljač iznos nije pročitan'])
  })

  it('still lists an uncertain document that has no date at all', () => {
    const g = groupOf(
      [row({ date: null, vendor: 'Dobavljač C', amount: null, currency: null, filename: 'nodate.jpg', warning: 'datum i iznos nisu pročitani' })],
      { total: null, vatTotal: null },
    )
    const m = manifest({ groups: [g], totalDocuments: 1, warnings: ['nodate.jpg: datum i iznos nisu pročitani'] })
    // UNFREEZE CANDIDATE-016B — see the note two tests above.
    const warned = linesOf(buildEmailBody(input({ manifest: m }))).filter((l) => l.includes('⚠') && l.startsWith('  '))

    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('Dobavljač C')
  })

  it('lists a document with no date that is otherwise complete', () => {
    const g = groupOf([row({ date: null, vendor: 'OMV Srbija', amount: 4210, filename: 'nedatirano.pdf' })], {
      total: 4210,
      vatTotal: null,
    })
    const body = buildEmailBody(input({ manifest: only(g) }))

    expect(body).toContain('OMV Srbija')
    expect(body).toContain('4.210,00')
  })

  // Serbian numeric agreement: 1 -> dokument, 2-4 -> dokumenta, 5+ -> dokumenata,
  // 11-14 always the plural genitive, and the pattern repeats from 21.
  it.each<[number, string]>([
    [0, 'Ukupno u prilogu: 0 dokumenata.'],
    [1, 'Ukupno u prilogu: 1 dokument.'],
    [2, 'Ukupno u prilogu: 2 dokumenta.'],
    [4, 'Ukupno u prilogu: 4 dokumenta.'],
    [5, 'Ukupno u prilogu: 5 dokumenata.'],
    [11, 'Ukupno u prilogu: 11 dokumenata.'],
    [21, 'Ukupno u prilogu: 21 dokument.'],
    [23, 'Ukupno u prilogu: 23 dokumenta.'],
  ])('agrees the closing noun with a count of %i', (count, expected) => {
    const rows = Array.from({ length: count }, (_, i) => row({ filename: `doc-${i}.pdf` }))
    const groups = count === 0 ? [] : [groupOf(rows, { total: 4210 * count, vatTotal: null })]

    expect(collapse(buildEmailBody(input({ manifest: manifest({ groups, totalDocuments: count }) })))).toContain(expected)
  })

  it('renders a month with no documents without inventing sections', () => {
    const body = collapse(buildEmailBody(input({ manifest: manifest() })))

    expect(body).toContain('Zdravo,')
    expect(body).toContain('jul 2026')
    expect(body).toContain('Ukupno u prilogu: 0 dokumenata.')
    expect(body).not.toContain('⚠')
    for (const heading of ['IZVODI', 'TROŠKOVI', 'IZLAZNE FAKTURE', 'SEF ULAZNE', 'OSTALO']) {
      expect(body).not.toContain(heading)
    }
  })

  it('marks a re-compiled package as revised', () => {
    expect(buildEmailBody(input({ revised: true }))).toContain('revidirano')
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailBody(input({ revised: false }))).not.toContain('revidirano')
  })

  // The spec fixes no sanitisation rule, so the safest reading is taken: a
  // vendor name may not inject a line into a body an accountant reads as a list.
  it('keeps a vendor name containing a newline on a single listed line', () => {
    const g = groupOf([row({ vendor: 'Prvi red\nDrugi red', amount: 4210, filename: 'omv.pdf' })], {
      total: 4210,
      vatTotal: null,
    })
    const listed = linesOf(buildEmailBody(input({ manifest: only(g) }))).filter((l) => l.includes('Drugi red'))

    expect(listed).toHaveLength(1)
    expect(listed[0]).toContain('Prvi red')
    expect(listed[0]).toContain('4.210,00')
  })

  it('renders a long vendor name without truncating the amount off the line', () => {
    const vendor = 'Preduzeće za proizvodnju i promet Šećerana Đurđević doo Čačak'
    const g = groupOf([row({ vendor, amount: 4210 })], { total: 4210, vatTotal: null })
    const listed = linesOf(buildEmailBody(input({ manifest: only(g) }))).filter((l) => l.includes('Šećerana'))

    expect(listed).toHaveLength(1)
    expect(listed[0]).toContain('4.210,00')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — buildEmailSubject
// ═══════════════════════════════════════════════════════════════════════════

describe('buildEmailSubject', () => {
  it('names the company and the period exactly as the spec prints it', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).toBe('DILIGAF DOO — dokumentacija za jul 2026')
  })

  // MERGE NOTE — revised subject: two drafts only asserted it contains
  // "revidirano"; the third pinned the parenthetical suffix, which is the form
  // 03-DILIGAF §5 uses ("re-sends marked (revidirano)"). Pinned form kept.
  it('marks a re-sent package as revised', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', true)).toBe(
      'DILIGAF DOO — dokumentacija za jul 2026 (revidirano)',
    )
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).not.toContain('revidirano')
  })

  it('uses the period label it is given without re-translating it', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'decembar 2025', false)).toBe(
      'DILIGAF DOO — dokumentacija za decembar 2025',
    )
  })

  it('uses the company name it is given rather than a hardcoded one', () => {
    expect(buildEmailSubject('SMOQUA DOO', 'avgust 2026', false)).toBe('SMOQUA DOO — dokumentacija za avgust 2026')
  })

  it('is a single line', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', true)).not.toContain('\n')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — periodLabel
// ═══════════════════════════════════════════════════════════════════════════

describe('periodLabel', () => {
  it.each<[string, string]>([
    ['2026-01', 'januar 2026'],
    ['2026-02', 'februar 2026'],
    ['2026-03', 'mart 2026'],
    ['2026-04', 'april 2026'],
    ['2026-05', 'maj 2026'],
    ['2026-06', 'jun 2026'],
    ['2026-07', 'jul 2026'],
    ['2026-08', 'avgust 2026'],
    ['2026-09', 'septembar 2026'],
    ['2026-10', 'oktobar 2026'],
    ['2026-11', 'novembar 2026'],
    ['2026-12', 'decembar 2026'],
  ])('labels %s as "%s"', (period, expected) => {
    expect(periodLabel(period)).toBe(expected)
  })

  it('keeps the year of a December period, which is the one the January run packages', () => {
    expect(periodLabel('2025-12')).toBe('decembar 2025')
  })

  it.each<[string]>([['2026-13'], ['2026-00'], ['2026-7'], ['2026-07-15'], ['jul 2026'], ['garbage'], ['']])(
    'refuses to label the malformed period %j',
    (period) => {
      expectRejects(() => periodLabel(period))
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// clock.ts — previousMonth
// ═══════════════════════════════════════════════════════════════════════════

describe('previousMonth', () => {
  it('packages July when the timer fires on 1 August — the D6 decision', () => {
    expect(previousMonth(clockAt('2026-08-01T06:00:00.000Z'))).toBe('2026-07')
  })

  it('rolls back to December of the prior year on 1 January', () => {
    expect(previousMonth(clockAt('2026-01-01T06:00:00.000Z'))).toBe('2025-12')
  })

  it.each<[string, string, string]>([
    ['2026-01-01T00:00:00.000Z', '2025-12', 'the exact first instant of 1 January'],
    ['2026-01-31T23:59:59.999Z', '2025-12', 'the last instant of January'],
    ['2026-02-01T00:00:00.000Z', '2026-01', 'the first instant of February'],
    ['2026-12-31T23:59:59.999Z', '2026-11', 'the last instant of December'],
    ['2027-01-01T00:00:00.000Z', '2026-12', 'the first instant of a new year'],
    ['2026-05-10T06:00:00.000Z', '2026-04', 'a single-digit previous month, zero padded'],
    ['2026-11-01T06:00:00.000Z', '2026-10', 'a two-digit previous month'],
  ])('reads %s as %s (%s)', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  // A naive "minus 30 days" or setMonth(getMonth() - 1) on a 31st overflows
  // back into the month it started in. These are the cases that catch it.
  it.each<[string, string]>([
    ['2026-03-31T06:00:00.000Z', '2026-02'],
    ['2026-05-31T06:00:00.000Z', '2026-04'],
    ['2026-07-31T23:59:59.999Z', '2026-06'],
    ['2026-12-31T12:00:00.000Z', '2026-11'],
  ])('does not overflow when the current day is the 31st (%s)', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  it.each<[string, string, string]>([
    ['2024-02-29T06:00:00.000Z', '2024-01', 'the leap day itself'],
    ['2024-03-01T06:00:00.000Z', '2024-02', 'the run that ships a leap February'],
    ['2024-03-31T06:00:00.000Z', '2024-02', 'the 31st, whose previous month has 29 days'],
    ['2023-03-01T06:00:00.000Z', '2023-02', 'the same run in a non-leap year'],
    ['2026-03-01T06:00:00.000Z', '2026-02', '1 March in a non-leap year'],
    ['2000-03-01T06:00:00.000Z', '2000-02', 'a century leap year, divisible by 400'],
    ['2100-03-01T06:00:00.000Z', '2100-02', 'a century non-leap year, divisible by 100 only'],
  ])('handles leap and non-leap February at %s -> %s (%s)', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  // The EU switches at 01:00 UTC on the last Sunday of March and October. The
  // 06:00 UTC cron drifts an hour across those; the MONTH must never move
  // (01-ARCHITECTURE §9).
  it.each<[string, string, string]>([
    ['2026-03-29T00:59:59.999Z', '2026-02', 'the instant before the spring-forward jump'],
    ['2026-03-29T01:00:00.000Z', '2026-02', 'the exact instant CET becomes CEST'],
    ['2026-03-29T01:00:00.001Z', '2026-02', 'the instant after the spring-forward jump'],
    ['2026-03-29T06:00:00.000Z', '2026-02', 'the spring-forward day at the timer hour'],
    ['2026-10-25T00:30:00.000Z', '2026-09', 'a moment inside the repeated autumn hour'],
    ['2026-10-25T01:00:00.000Z', '2026-09', 'the exact instant CEST becomes CET'],
    ['2026-10-25T06:00:00.000Z', '2026-09', 'the fall-back day at the timer hour'],
    ['2026-04-01T06:00:00.000Z', '2026-03', 'the first run after the clocks went forward'],
    ['2026-11-01T06:00:00.000Z', '2026-10', 'the first run after the clocks went back'],
  ])('picks %s -> %s across %s', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  it('interprets the clock instant as UTC, not as a local wall-clock time', () => {
    // 23:00 UTC on 31 December is already 1 January in Belgrade. Reading the
    // instant as UTC is what makes the answer independent of where the function
    // app runs (01-ARCHITECTURE §9).
    expect(previousMonth(clockAt('2025-12-31T23:00:00.000Z'))).toBe('2025-11')
  })

  it('does not mutate the Date the clock handed it, so a second call agrees with the first', () => {
    const clock = sharedInstanceClock('2026-01-01T06:00:00.000Z')
    const before = clock.instant.getTime()

    expect(previousMonth(clock)).toBe('2025-12')
    expect(previousMonth(clock)).toBe('2025-12')
    expect(clock.instant.getTime()).toBe(before)
  })

  it('reads the time only from the injected clock', () => {
    const clock = sharedInstanceClock('1999-01-01T00:00:00.000Z')

    expect(previousMonth(clock)).toBe('1998-12')
    expect(clock.calls).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// clock.ts — currentMonth
// ═══════════════════════════════════════════════════════════════════════════

describe('currentMonth', () => {
  it.each<[string, string]>([
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-01-31T23:59:59.999Z', '2026-01'],
    ['2026-08-12T06:00:00.000Z', '2026-08'],
    ['2026-09-05T13:37:00.000Z', '2026-09'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
    ['2024-02-29T23:59:59.999Z', '2024-02'],
    ['2026-03-29T01:00:00.000Z', '2026-03'],
    ['2026-10-25T01:00:00.000Z', '2026-10'],
  ])('reports the month containing %s as %s', (now, expected) => {
    expect(currentMonth(clockAt(now))).toBe(expected)
  })

  it('interprets the clock instant as UTC, not as a local wall-clock time', () => {
    expect(currentMonth(clockAt('2025-12-31T23:00:00.000Z'))).toBe('2025-12')
  })

  it('is exactly one month ahead of previousMonth across the year boundary', () => {
    const clock = clockAt('2026-01-01T06:00:00.000Z')

    expect(currentMonth(clock)).toBe('2026-01')
    expect(previousMonth(clock)).toBe('2025-12')
  })

  it('does not mutate the Date the clock handed it', () => {
    const clock = sharedInstanceClock('2026-08-12T06:00:00.000Z')
    const before = clock.instant.getTime()

    expect(currentMonth(clock)).toBe('2026-08')
    expect(clock.instant.getTime()).toBe(before)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// clock.ts — monthBounds
// ═══════════════════════════════════════════════════════════════════════════

describe('monthBounds', () => {
  it.each<[string, string, string]>([
    ['2026-01', '2026-01-01', '2026-01-31'],
    ['2026-02', '2026-02-01', '2026-02-28'],
    ['2026-03', '2026-03-01', '2026-03-31'],
    ['2026-04', '2026-04-01', '2026-04-30'],
    ['2026-05', '2026-05-01', '2026-05-31'],
    ['2026-06', '2026-06-01', '2026-06-30'],
    ['2026-07', '2026-07-01', '2026-07-31'],
    ['2026-08', '2026-08-01', '2026-08-31'],
    ['2026-09', '2026-09-01', '2026-09-30'],
    ['2026-10', '2026-10-01', '2026-10-31'],
    ['2026-11', '2026-11-01', '2026-11-30'],
    ['2026-12', '2026-12-01', '2026-12-31'],
  ])('covers %s inclusively from %s to %s', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it.each<[string, string, string, string]>([
    ['2024-02', '2024-02-01', '2024-02-29', 'a leap year ends February on the 29th'],
    ['2026-02', '2026-02-01', '2026-02-28', 'an ordinary year ends February on the 28th'],
    ['2000-02', '2000-02-01', '2000-02-29', 'a year divisible by 400 is a leap year'],
    ['1900-02', '1900-02-01', '1900-02-28', 'a year divisible by 100 but not 400 is not'],
    ['2100-02', '2100-02-01', '2100-02-28', '2100 is not a leap year either'],
  ])('bounds %s as %s..%s (%s)', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it('ends the spring-forward month on the 31st, not the 30th', () => {
    // A month containing a DST transition is 23 hours short. Anything that adds
    // 30 * 86_400_000 ms in local time lands on 2026-03-30 here.
    expect(monthBounds('2026-03').end).toBe('2026-03-31')
  })

  it('returns an inclusive range whose ends both belong to the period', () => {
    const bounds = monthBounds('2024-02')

    expect(bounds.start).toBe('2024-02-01')
    expect(periodOf(bounds.start)).toBe('2024-02')
    expect(periodOf(bounds.end)).toBe('2024-02')
  })

  // MERGE NOTE — malformed periods: two drafts asserted only `.toThrow()`,
  // which the "not implemented" stub already satisfies. Same expectation, now
  // asserted as a deliberate refusal. The return type is not nullable, so
  // refusal can only be an exception.
  it.each<[string]>([['2026-13'], ['2026-00'], ['2026-7'], ['2026-07-01'], ['not-a-period'], ['']])(
    'refuses the malformed period %j rather than guessing a range',
    (period) => {
      expectRejects(() => monthBounds(period))
    },
  )
})

// ═══════════════════════════════════════════════════════════════════════════
// clock.ts — periodOf
// ═══════════════════════════════════════════════════════════════════════════

describe('periodOf', () => {
  it.each<[string, string]>([
    ['2026-07-01', '2026-07'],
    ['2026-07-15', '2026-07'],
    ['2026-07-31', '2026-07'],
    ['2026-01-01', '2026-01'],
    ['2026-12-31', '2026-12'],
    ['2024-02-29', '2024-02'],
  ])('places %s in %s', (isoDate, expected) => {
    expect(periodOf(isoDate)).toBe(expected)
  })

  it.each<[string, string]>([
    ['2023-02-29', '29 February in a non-leap year'],
    ['2026-02-29', '29 February in another non-leap year'],
    ['2026-02-30', '30 February'],
    ['2026-04-31', 'a 31st in a 30-day month'],
  ])('returns null for %s (%s) rather than rolling into the next month', (isoDate) => {
    // The silent-rollover bug: new Date('2026-02-29') is 1 March, which would
    // file a late receipt into the wrong month's package forever.
    expect(periodOf(isoDate)).toBeNull()
  })

  it.each<[string, string]>([
    ['2026-13-01', 'a month of 13'],
    ['2026-00-10', 'a month of 00'],
    ['2026-07-32', 'a day of 32'],
    ['2026-07-00', 'a day of 00'],
    ['2026-7-15', 'an unpadded month'],
    ['2026/07/15', 'slash separators'],
    ['15.07.2026', 'the Serbian dotted format'],
    ['31/07/2026', 'a non-ISO format'],
    ['2026-07', 'a period rather than a date'],
    ['2026-07-15T10:00:00Z', 'a full ISO timestamp, which the contract does not accept'],
    ['juče', 'prose'],
    ['   ', 'blank space'],
    ['', 'an empty string'],
  ])('returns null for %j (%s)', (isoDate) => {
    expect(periodOf(isoDate)).toBeNull()
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
  ])('returns null when the date is %s', (_label, value) => {
    expect(periodOf(value as string)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The safety property, end to end: a DILIGAF package never carries PERSONAL
// data. This is the one block that deliberately runs the whole pipeline
// (buildManifest -> manifestToCsv / buildEmailBody), because the property
// under test is the pipeline.
// ═══════════════════════════════════════════════════════════════════════════

describe('a DILIGAF package never contains PERSONAL data', () => {
  const mixed = (): DocumentFacts[] => [
    doc({ filename: 'omv.pdf', vendorName: 'OMV Srbija', amountTotal: 4210, vatAmount: 701.67 }),
    personal({
      category: 'statement',
      filename: 'izvod-tekuci-jul.pdf',
      blobPath: 'personal/2026/07/statement/izvod-tekuci-jul.pdf',
      vendorName: 'Banka Intesa',
      amountTotal: null,
      vatAmount: null,
    }),
    personal({ filename: 'wolt.pdf', vendorName: 'Wolt Beograd', amountTotal: 1450 }),
    personal({ filename: 'privatno.jpg', vendorName: 'Apoteka Janković', amountTotal: null, vatAmount: null }),
  ]

  it('never lists a PERSONAL document in the manifest', () => {
    const serialised = JSON.stringify(buildManifest(mixed(), '2026-07'))

    expect(serialised).not.toContain('Wolt Beograd')
    expect(serialised).not.toContain('Banka Intesa')
    expect(serialised).not.toContain('Apoteka Janković')
    expect(serialised).not.toContain('izvod-tekuci-jul.pdf')
    expect(serialised).not.toContain('privatno.jpg')
    expect(serialised).not.toContain('personal/')
  })

  it('does not count a PERSONAL document toward the totals', () => {
    const m = buildManifest(mixed(), '2026-07')

    expect(filenames(m)).toEqual(['omv.pdf'])
    expect(m.totalDocuments).toBe(1)
    expect(m.groups.map((g) => g.category)).toEqual(['expense'])
    expect(categoryGroup(m, 'expense').total).toBe(4210)
    expect(categoryGroup(m, 'expense').vatTotal).toBe(701.67)
  })

  it('does not warn about an unreadable PERSONAL document', () => {
    expect(buildManifest(mixed(), '2026-07').warnings).toEqual([])
  })

  it('returns an empty manifest when handed nothing but PERSONAL documents', () => {
    const m = buildManifest([personal(), personal({ filename: 'p2.pdf' })], '2026-07')

    expect(m.groups).toEqual([])
    expect(m.totalDocuments).toBe(0)
    expect(m.warnings).toEqual([])
  })

  it('never writes a PERSONAL document into manifest.csv', () => {
    const csv = manifestToCsv(buildManifest(mixed(), '2026-07'))

    expect(csv).not.toContain('Wolt')
    expect(csv).not.toContain('Banka Intesa')
    expect(csv).not.toContain('Apoteka')
    expect(csv).not.toContain('izvod-tekuci-jul.pdf')
    expect(csv).not.toContain('1450')
    expect(csvRecords(csv)).toHaveLength(2) // header + the single DILIGAF row
  })

  it('never mentions a PERSONAL document in the accountant email', () => {
    const body = buildEmailBody({
      companyName: 'DILIGAF DOO',
      manifest: buildManifest(mixed(), '2026-07'),
      periodLabel: 'jul 2026',
      revised: false,
    })

    expect(body).not.toContain('Wolt')
    expect(body).not.toContain('Banka Intesa')
    expect(body).not.toContain('Apoteka')
    expect(body).not.toContain('1.450,00')
    expect(body).toContain('OMV Srbija')
    expect(collapse(body)).toContain('Ukupno u prilogu: 1 dokument.')
  })
})
