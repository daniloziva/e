import { describe, it, expect } from 'vitest'

import { previousMonth, currentMonth, monthBounds, periodOf } from '../../../src/core/clock.js'
import { buildManifest, manifestToCsv } from '../../../src/core/packaging/manifest.js'
import type { Manifest } from '../../../src/core/packaging/manifest.js'
import { buildEmailBody, buildEmailSubject, periodLabel } from '../../../src/core/packaging/email-body.js'
import type { Clock, DocumentFacts, DocCategory, ExtractionMethod } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library, no real clock, no randomness.
// ---------------------------------------------------------------------------

/** A Clock frozen at an instant. Never the system clock. */
function clockAt(iso: string): Clock {
  const fixed = new Date(iso)
  return { now: () => new Date(fixed.getTime()) }
}

/** A Clock that hands back the very same Date instance every time, and counts calls. */
function sharedInstanceClock(iso: string): Clock & { calls: number; instant: Date } {
  const instant = new Date(iso)
  const c = {
    instant,
    calls: 0,
    now(): Date {
      c.calls += 1
      return instant
    },
  }
  return c
}

/** A DocumentFacts fixture. Every field explicit; overrides applied last. */
function doc(over: Partial<DocumentFacts> = {}): DocumentFacts {
  const base: DocumentFacts = {
    book: 'DILIGAF',
    category: 'expense',
    period: '2026-07',
    source: 'whatsapp',
    sourceRef: 'wamid.FIXTURE',
    blobPath: 'diligaf/2026/07/expense/2026-07-02--omv-srbija--91be0d47.pdf',
    filename: '2026-07-02--omv-srbija--91be0d47.pdf',
    mimeType: 'application/pdf',
    byteSize: 1024,
    sha256: 'a'.repeat(64),
    amountRsd: 4210,
    dimensions: {},
    extraction: { method: 'pdf_text', confidence: 'high', model: null },
    reviewStatus: 'ok',
    createdAt: '2026-07-02T10:00:00.000Z',
    vendorName: 'OMV Srbija',
    vendorPib: '123456789',
    docDate: '2026-07-02',
    amountNet: 3508.33,
    vatAmount: 701.67,
    amountTotal: 4210,
    currency: 'RSD',
    lineItems: [],
  }
  return { ...base, ...over }
}

/** A document whose amount could not be read — the uncertain case. */
function unreadableDoc(over: Partial<DocumentFacts> = {}): DocumentFacts {
  return doc({
    amountNet: null,
    vatAmount: null,
    amountTotal: null,
    amountRsd: null,
    currency: null,
    reviewStatus: 'needs_review',
    extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' },
    ...over,
  })
}

/** A PERSONAL-book document. Must never reach an accountant package. */
function personalDoc(over: Partial<DocumentFacts> = {}): DocumentFacts {
  return doc({
    book: 'PERSONAL',
    category: 'statement',
    vendorName: 'APOTEKA JANKOVIC PRIVATNO',
    filename: '2026-07-11--apoteka-jankovic--deadbeef.pdf',
    blobPath: 'personal/2026/07/statement/2026-07-11--apoteka-jankovic--deadbeef.pdf',
    amountTotal: 999999,
    amountRsd: 999999,
    ...over,
  })
}

/** Minimal RFC4180 reader used to assert on CSV *cells* rather than on raw text. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
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
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvCell(rows: string[][], rowIndex: number, column: string): string {
  const header = rows[0]!
  const col = header.indexOf(column)
  expect(col, `column "${column}" is present in the header`).toBeGreaterThanOrEqual(0)
  return rows[rowIndex]![col]!
}

/** Every row of a manifest, flattened across its groups. */
function allRows(m: Manifest) {
  return m.groups.flatMap((g) => g.rows)
}

// ---------------------------------------------------------------------------
// clock.ts — previousMonth
// ---------------------------------------------------------------------------

describe('previousMonth', () => {
  it.each([
    // the case that is silently wrong for a year if it is wrong at all
    ['2026-01-01T06:00:00.000Z', '2025-12', '1 January, when the package timer fires'],
    ['2026-01-01T00:00:00.000Z', '2025-12', 'the exact first instant of 1 January'],
    ['2026-01-31T23:59:59.999Z', '2025-12', 'the last instant of January'],
    ['2026-02-01T00:00:00.000Z', '2026-01', 'the first instant of February'],

    // month-length traps: a naive "minus 30 days" gets these wrong
    ['2026-03-31T06:00:00.000Z', '2026-02', '31 March, whose previous month has 28 days'],
    ['2026-05-31T06:00:00.000Z', '2026-04', '31 May, whose previous month has 30 days'],
    ['2026-07-31T23:59:59.999Z', '2026-06', 'the last instant of July'],
    ['2026-12-31T23:59:59.999Z', '2026-11', 'the last instant of December'],

    // leap years
    ['2024-02-29T06:00:00.000Z', '2024-01', '29 February in a leap year'],
    ['2024-03-01T00:00:00.000Z', '2024-02', '1 March in a leap year'],
    ['2023-03-01T00:00:00.000Z', '2023-02', '1 March in a non-leap year'],
    ['2024-03-31T06:00:00.000Z', '2024-02', '31 March in a leap year'],
    ['2000-03-01T00:00:00.000Z', '2000-02', '1 March in a century leap year'],
    ['2100-03-01T00:00:00.000Z', '2100-02', '1 March in a century non-leap year'],

    // DST boundary days in Europe/Belgrade (2026-03-29 forward, 2026-10-25 back)
    ['2026-03-29T00:59:59.999Z', '2026-02', 'the instant before the spring DST jump'],
    ['2026-03-29T01:00:00.000Z', '2026-02', 'the exact spring DST jump'],
    ['2026-03-29T06:00:00.000Z', '2026-02', 'the spring DST day at the timer hour'],
    ['2026-10-25T01:00:00.000Z', '2026-09', 'the exact autumn DST fallback'],
    ['2026-10-25T06:00:00.000Z', '2026-09', 'the autumn DST day at the timer hour'],

    // zero padding either side of the boundary
    ['2026-10-15T12:00:00.000Z', '2026-09', 'a single-digit previous month is zero padded'],
    ['2026-11-01T06:00:00.000Z', '2026-10', 'a two-digit previous month'],
  ])('returns %s -> %s (%s)', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  it('does not mutate the Date the clock handed it', () => {
    const clock = sharedInstanceClock('2026-01-01T06:00:00.000Z')
    const before = clock.instant.getTime()

    expect(previousMonth(clock)).toBe('2025-12')

    expect(clock.instant.getTime()).toBe(before)
    expect(previousMonth(clock)).toBe('2025-12')
  })

  it('reads the time only from the injected clock', () => {
    const clock = sharedInstanceClock('1999-01-01T00:00:00.000Z')

    expect(previousMonth(clock)).toBe('1998-12')
    expect(clock.calls).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// clock.ts — currentMonth
// ---------------------------------------------------------------------------

describe('currentMonth', () => {
  it.each([
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-01-31T23:59:59.999Z', '2026-01'],
    ['2026-08-11T09:00:00.000Z', '2026-08'],
    ['2026-09-30T23:59:59.999Z', '2026-09'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
    ['2024-02-29T12:00:00.000Z', '2024-02'],
    ['2026-03-29T01:00:00.000Z', '2026-03'],
    ['2026-10-25T01:00:00.000Z', '2026-10'],
  ])('returns %s -> %s', (now, expected) => {
    expect(currentMonth(clockAt(now))).toBe(expected)
  })

  it('is exactly one month ahead of previousMonth for the same clock', () => {
    const clock = clockAt('2026-01-01T06:00:00.000Z')

    expect(currentMonth(clock)).toBe('2026-01')
    expect(previousMonth(clock)).toBe('2025-12')
  })
})

// ---------------------------------------------------------------------------
// clock.ts — monthBounds
// ---------------------------------------------------------------------------

describe('monthBounds', () => {
  it.each([
    ['2024-02', '2024-02-01', '2024-02-29', 'February in a leap year ends on the 29th'],
    ['2023-02', '2023-02-01', '2023-02-28', 'February in a non-leap year ends on the 28th'],
    ['2000-02', '2000-02-01', '2000-02-29', 'February in a century leap year ends on the 29th'],
    ['1900-02', '1900-02-01', '1900-02-28', 'February in a century non-leap year ends on the 28th'],
    ['2100-02', '2100-02-01', '2100-02-28', 'February in 2100 ends on the 28th'],
  ])('bounds %s as %s..%s (%s)', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it.each([
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
  ])('bounds %s as %s..%s', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it('always starts on the first day of the month', () => {
    for (const period of ['2026-01', '2026-02', '2026-11', '2024-02']) {
      expect(monthBounds(period).start).toBe(`${period}-01`)
    }
  })

  it('returns an inclusive end date that belongs to the same period', () => {
    const bounds = monthBounds('2024-02')

    expect(periodOf(bounds.end)).toBe('2024-02')
    expect(periodOf(bounds.start)).toBe('2024-02')
  })
})

// ---------------------------------------------------------------------------
// clock.ts — periodOf
// ---------------------------------------------------------------------------

describe('periodOf', () => {
  it.each([
    ['2026-07-01', '2026-07'],
    ['2026-07-31', '2026-07'],
    ['2026-01-01', '2026-01'],
    ['2026-12-31', '2026-12'],
    ['2024-02-29', '2024-02'],
  ])('reads %s as period %s', (isoDate, expected) => {
    expect(periodOf(isoDate)).toBe(expected)
  })

  it.each([
    ['', 'an empty string'],
    ['   ', 'blank space'],
    ['not a date', 'free text'],
    ['2026-07', 'a period rather than a date'],
    ['31/07/2026', 'a non-ISO format'],
    ['2026-13-01', 'a month of 13'],
    ['2026-00-10', 'a month of 00'],
    ['2026-07-32', 'a day of 32'],
    ['2026-07-00', 'a day of 00'],
  ])('returns null for %s (%s)', (isoDate) => {
    expect(periodOf(isoDate)).toBeNull()
  })

  it('returns null for 29 February in a non-leap year rather than rolling into March', () => {
    expect(periodOf('2023-02-29')).toBeNull()
  })

  it('returns null for 30 February rather than rolling into March', () => {
    expect(periodOf('2026-02-30')).toBeNull()
  })

  it('returns null for 31 April rather than rolling into May', () => {
    expect(periodOf('2026-04-31')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildManifest — grouping and totals
// ---------------------------------------------------------------------------

describe('buildManifest', () => {
  it('echoes the period it was asked to build', () => {
    expect(buildManifest([doc()], '2026-07').period).toBe('2026-07')
  })

  it('returns an empty manifest for no documents at all', () => {
    const m = buildManifest([], '2026-07')

    expect(m.period).toBe('2026-07')
    expect(m.groups).toEqual([])
    expect(m.totalDocuments).toBe(0)
    expect(m.warnings).toEqual([])
  })

  it('groups documents by category and counts each group', () => {
    const m = buildManifest(
      [
        doc({ category: 'izvod', filename: 'izvod-01.pdf' }),
        doc({ category: 'izvod', filename: 'izvod-02.pdf' }),
        doc({ category: 'expense', filename: 'exp-01.pdf' }),
        doc({ category: 'invoice_out', filename: 'inv-01.pdf' }),
      ],
      '2026-07',
    )

    const byCategory = new Map(m.groups.map((g) => [g.category, g]))
    expect(byCategory.get('izvod')!.count).toBe(2)
    expect(byCategory.get('izvod')!.rows).toHaveLength(2)
    expect(byCategory.get('expense')!.count).toBe(1)
    expect(byCategory.get('invoice_out')!.count).toBe(1)
  })

  it('emits no group for a category with no documents', () => {
    const m = buildManifest([doc({ category: 'expense' })], '2026-07')

    expect(m.groups.map((g) => g.category)).toEqual(['expense'])
  })

  it('orders groups the way the accountant email reads them', () => {
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
        doc({ category: 'izvod', filename: 'a.pdf' }),
        doc({ category: 'expense', filename: 'b.pdf' }),
        doc({ category: 'expense', filename: 'c.pdf' }),
        doc({ category: 'sef_inbound', filename: 'd.pdf' }),
      ],
      '2026-07',
    )

    expect(m.totalDocuments).toBe(4)
    expect(allRows(m)).toHaveLength(4)
  })

  it('totals a group whose rows all carry an amount', () => {
    const m = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf', amountTotal: 4210, amountRsd: 4210 }),
        doc({ category: 'expense', filename: 'b.pdf', amountTotal: 8900, amountRsd: 8900 }),
      ],
      '2026-07',
    )

    expect(m.groups[0]!.total).toBe(13110)
  })

  it('totals a group of exactly one document', () => {
    const m = buildManifest([doc({ amountTotal: 4210, amountRsd: 4210 })], '2026-07')

    expect(m.groups[0]!.total).toBe(4210)
  })

  it('returns a null group total when any single row is missing an amount, rather than summing the rest', () => {
    const m = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf', amountTotal: 4210, amountRsd: 4210 }),
        doc({ category: 'expense', filename: 'b.pdf', amountTotal: 8900, amountRsd: 8900 }),
        unreadableDoc({ category: 'expense', filename: 'c.pdf' }),
      ],
      '2026-07',
    )

    const expenses = m.groups.find((g) => g.category === 'expense')!
    expect(expenses.total).toBeNull()
    expect(expenses.total).not.toBe(13110) // the subset sum is a lie, not a fallback
    expect(expenses.count).toBe(3) // the document is still listed
    expect(expenses.rows).toHaveLength(3)
  })

  it('returns a null group total when every row is missing an amount, rather than zero', () => {
    const m = buildManifest(
      [unreadableDoc({ filename: 'a.pdf' }), unreadableDoc({ filename: 'b.pdf' })],
      '2026-07',
    )

    expect(m.groups[0]!.total).toBeNull()
    expect(m.groups[0]!.total).not.toBe(0)
  })

  it('does not let one group with a missing amount null out another group total', () => {
    const m = buildManifest(
      [
        unreadableDoc({ category: 'expense', filename: 'a.pdf' }),
        doc({ category: 'invoice_out', filename: 'b.pdf', amountTotal: 360000, amountRsd: 360000 }),
        doc({ category: 'invoice_out', filename: 'c.pdf', amountTotal: 360000, amountRsd: 360000 }),
      ],
      '2026-07',
    )

    expect(m.groups.find((g) => g.category === 'expense')!.total).toBeNull()
    expect(m.groups.find((g) => g.category === 'invoice_out')!.total).toBe(720000)
  })

  it('sums the VAT of the rows that carry one', () => {
    const m = buildManifest(
      [
        doc({ category: 'invoice_out', filename: 'a.pdf', amountTotal: 360000, vatAmount: 60000 }),
        doc({ category: 'invoice_out', filename: 'b.pdf', amountTotal: 360000, vatAmount: 60000 }),
      ],
      '2026-07',
    )

    expect(m.groups[0]!.vatTotal).toBe(120000)
  })

  it('returns a null VAT total when no row in the group carries VAT, rather than zero', () => {
    const m = buildManifest(
      [
        doc({ category: 'izvod', filename: 'a.pdf', vatAmount: null, amountTotal: null, amountRsd: null }),
      ],
      '2026-07',
    )

    expect(m.groups[0]!.vatTotal).toBeNull()
    expect(m.groups[0]!.vatTotal).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildManifest — rows and provenance
// ---------------------------------------------------------------------------

describe('buildManifest rows', () => {
  it('carries the document facts onto the row', () => {
    const m = buildManifest(
      [
        doc({
          category: 'expense',
          docDate: '2026-07-02',
          vendorName: 'OMV Srbija',
          amountTotal: 4210,
          currency: 'RSD',
          filename: 'omv.pdf',
        }),
      ],
      '2026-07',
    )

    expect(m.groups[0]!.rows[0]).toMatchObject({
      category: 'expense',
      date: '2026-07-02',
      vendor: 'OMV Srbija',
      amount: 4210,
      currency: 'RSD',
      filename: 'omv.pdf',
    })
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
  ])('carries extraction method %s through to the row', (method) => {
    const m = buildManifest(
      [doc({ extraction: { method, confidence: 'high', model: null } })],
      '2026-07',
    )

    expect(m.groups[0]!.rows[0]!.extractionMethod).toBe(method)
  })

  it('keeps each row on the extraction method of its own document', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', extraction: { method: 'fiscal_qr', confidence: 'exact', model: null } }),
        doc({
          filename: 'b.pdf',
          extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' },
        }),
      ],
      '2026-07',
    )

    expect(m.groups[0]!.rows.map((r) => r.extractionMethod)).toEqual(['fiscal_qr', 'llm_vision'])
  })

  it('leaves an unread vendor null rather than inventing a placeholder', () => {
    const m = buildManifest([doc({ vendorName: null })], '2026-07')

    expect(m.groups[0]!.rows[0]!.vendor).toBeNull()
  })

  it('leaves an unread date null rather than falling back to today', () => {
    const m = buildManifest([doc({ docDate: null })], '2026-07')

    expect(m.groups[0]!.rows[0]!.date).toBeNull()
  })

  it('leaves an unread amount null rather than zero', () => {
    const m = buildManifest([unreadableDoc()], '2026-07')

    const row = m.groups[0]!.rows[0]!
    expect(row.amount).toBeNull()
    expect(row.amount).not.toBe(0)
    expect(row.currency).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildManifest — warnings
// ---------------------------------------------------------------------------

describe('buildManifest warnings', () => {
  it('produces no warnings when every document was read completely', () => {
    const m = buildManifest([doc({ filename: 'a.pdf' }), doc({ filename: 'b.pdf' })], '2026-07')

    expect(m.warnings).toEqual([])
    expect(allRows(m).every((r) => r.warning === null)).toBe(true)
  })

  it('warns once per document whose amount was not read', () => {
    const m = buildManifest(
      [
        doc({ filename: 'ok.pdf' }),
        unreadableDoc({ filename: 'bad-1.pdf', docDate: '2026-07-19' }),
        unreadableDoc({ filename: 'bad-2.pdf', docDate: '2026-07-23' }),
      ],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(2)
    expect(m.warnings.every((w) => typeof w === 'string' && w.length > 0)).toBe(true)
  })

  it('marks the uncertain row itself, and only that row', () => {
    const m = buildManifest(
      [doc({ filename: 'ok.pdf' }), unreadableDoc({ filename: 'bad.pdf' })],
      '2026-07',
    )

    const rows = allRows(m)
    expect(rows.find((r) => r.filename === 'ok.pdf')!.warning).toBeNull()
    expect(rows.find((r) => r.filename === 'bad.pdf')!.warning).not.toBeNull()
  })

  it('warns once, not twice, for a document missing both its amount and its date', () => {
    const m = buildManifest([unreadableDoc({ filename: 'bad.pdf', docDate: null })], '2026-07')

    expect(m.warnings).toHaveLength(1)
  })

  it('warns once, not twice, for a document missing its amount, date and vendor', () => {
    const m = buildManifest(
      [unreadableDoc({ filename: 'bad.pdf', docDate: null, vendorName: null })],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(1)
  })

  it('warns for every uncertain document even when they share a group', () => {
    const m = buildManifest(
      [
        unreadableDoc({ category: 'expense', filename: 'a.pdf' }),
        unreadableDoc({ category: 'expense', filename: 'b.pdf' }),
        unreadableDoc({ category: 'expense', filename: 'c.pdf' }),
      ],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(3)
    expect(m.groups[0]!.rows.filter((r) => r.warning !== null)).toHaveLength(3)
  })

  it('warns across groups, not just within the first one', () => {
    const m = buildManifest(
      [
        unreadableDoc({ category: 'expense', filename: 'a.pdf' }),
        unreadableDoc({ category: 'sef_inbound', filename: 'b.pdf' }),
      ],
      '2026-07',
    )

    expect(m.warnings).toHaveLength(2)
  })

  it('still lists an uncertain document rather than dropping it from the package', () => {
    const m = buildManifest([unreadableDoc({ filename: 'bad.pdf' })], '2026-07')

    expect(m.totalDocuments).toBe(1)
    expect(allRows(m).map((r) => r.filename)).toEqual(['bad.pdf'])
  })
})

// ---------------------------------------------------------------------------
// buildManifest — the PERSONAL firewall
// ---------------------------------------------------------------------------

describe('buildManifest and PERSONAL data', () => {
  it('excludes PERSONAL documents from a manifest built alongside DILIGAF documents', () => {
    const m = buildManifest(
      [doc({ filename: 'diligaf.pdf' }), personalDoc({ filename: 'personal.pdf' })],
      '2026-07',
    )

    expect(allRows(m).map((r) => r.filename)).toEqual(['diligaf.pdf'])
    expect(allRows(m).map((r) => r.vendor)).not.toContain('APOTEKA JANKOVIC PRIVATNO')
  })

  it('does not count PERSONAL documents in the document total', () => {
    const m = buildManifest(
      [doc({ filename: 'diligaf.pdf' }), personalDoc(), personalDoc({ filename: 'personal-2.pdf' })],
      '2026-07',
    )

    expect(m.totalDocuments).toBe(1)
  })

  it('does not fold a PERSONAL amount into any group total', () => {
    const m = buildManifest(
      [
        doc({ category: 'expense', filename: 'diligaf.pdf', amountTotal: 4210, amountRsd: 4210 }),
        personalDoc({ category: 'expense', amountTotal: 999999, amountRsd: 999999 }),
      ],
      '2026-07',
    )

    expect(m.groups.find((g) => g.category === 'expense')!.total).toBe(4210)
  })

  it('does not warn about an unreadable PERSONAL document in a DILIGAF package', () => {
    const m = buildManifest(
      [
        doc({ filename: 'diligaf.pdf' }),
        personalDoc({ amountTotal: null, amountRsd: null, vatAmount: null, currency: null }),
      ],
      '2026-07',
    )

    expect(m.warnings).toEqual([])
  })

  it('returns an empty manifest when handed nothing but PERSONAL documents', () => {
    const m = buildManifest([personalDoc(), personalDoc({ filename: 'p2.pdf' })], '2026-07')

    expect(m.groups).toEqual([])
    expect(m.totalDocuments).toBe(0)
    expect(m.warnings).toEqual([])
  })

  it('keeps PERSONAL vendors out of the CSV', () => {
    const csv = manifestToCsv(buildManifest([doc(), personalDoc()], '2026-07'))

    expect(csv).not.toContain('APOTEKA JANKOVIC PRIVATNO')
    expect(csv).not.toContain('999999')
    expect(csv).not.toContain('personal/')
  })

  it('keeps PERSONAL vendors out of the accountant email body', () => {
    const manifest = buildManifest([doc(), personalDoc()], '2026-07')
    const body = buildEmailBody({
      companyName: 'DILIGAF DOO',
      manifest,
      periodLabel: 'jul 2026',
      revised: false,
    })

    expect(body).not.toContain('APOTEKA JANKOVIC PRIVATNO')
    expect(body).not.toContain('999999')
  })
})

// ---------------------------------------------------------------------------
// manifestToCsv
// ---------------------------------------------------------------------------

describe('manifestToCsv', () => {
  const oneRowCsv = (over: Partial<DocumentFacts> = {}) =>
    parseCsv(manifestToCsv(buildManifest([doc(over)], '2026-07')))

  it('starts with a header row naming every column, including extraction_method', () => {
    const header = oneRowCsv()[0]!

    expect(header).toContain('extraction_method')
    for (const column of ['category', 'date', 'vendor', 'amount', 'currency', 'filename', 'warning']) {
      expect(header).toContain(column)
    }
  })

  it('writes one line per manifest row plus the header', () => {
    const rows = parseCsv(
      manifestToCsv(
        buildManifest(
          [
            doc({ category: 'izvod', filename: 'a.pdf' }),
            doc({ category: 'expense', filename: 'b.pdf' }),
            doc({ category: 'expense', filename: 'c.pdf' }),
          ],
          '2026-07',
        ),
      ),
    )

    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.length === rows[0]!.length)).toBe(true)
  })

  it('emits only the header for an empty manifest', () => {
    const rows = parseCsv(manifestToCsv(buildManifest([], '2026-07')))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('extraction_method')
  })

  it('terminates lines with CRLF as RFC4180 requires', () => {
    const csv = manifestToCsv(buildManifest([doc()], '2026-07'))

    expect(csv).toContain('\r\n')
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('writes the extraction method of each row into the extraction_method column', () => {
    const rows = parseCsv(
      manifestToCsv(
        buildManifest(
          [
            doc({ filename: 'a.pdf', extraction: { method: 'fiscal_qr', confidence: 'exact', model: null } }),
            doc({
              filename: 'b.pdf',
              extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' },
            }),
          ],
          '2026-07',
        ),
      ),
    )

    expect(csvCell(rows, 1, 'extraction_method')).toBe('fiscal_qr')
    expect(csvCell(rows, 2, 'extraction_method')).toBe('llm_vision')
  })

  it('writes the amount as a machine-readable number', () => {
    const rows = oneRowCsv({ amountTotal: 4210, amountRsd: 4210 })

    expect(Number(csvCell(rows, 1, 'amount'))).toBe(4210)
  })

  it('leaves the amount cell empty when the amount was never read', () => {
    const rows = parseCsv(manifestToCsv(buildManifest([unreadableDoc()], '2026-07')))

    expect(csvCell(rows, 1, 'amount')).toBe('')
  })

  it('leaves the vendor and date cells empty when they were never read', () => {
    const rows = oneRowCsv({ vendorName: null, docDate: null })

    expect(csvCell(rows, 1, 'vendor')).toBe('')
    expect(csvCell(rows, 1, 'date')).toBe('')
  })

  it('never writes the string "null" into a cell', () => {
    const csv = manifestToCsv(
      buildManifest([unreadableDoc({ vendorName: null, docDate: null })], '2026-07'),
    )

    expect(csv).not.toContain('null')
    expect(csv).not.toContain('undefined')
  })

  it('fills the warning cell for an uncertain row and leaves it empty for a clean one', () => {
    const rows = parseCsv(
      manifestToCsv(
        buildManifest([doc({ filename: 'ok.pdf' }), unreadableDoc({ filename: 'bad.pdf' })], '2026-07'),
      ),
    )

    expect(csvCell(rows, 1, 'warning')).toBe('')
    expect(csvCell(rows, 2, 'warning').length).toBeGreaterThan(0)
  })

  it.each([
    ['Marks & Spencer, Beograd d.o.o.', 'a comma'],
    ['DOO "MERKUR" Novi Sad', 'double quotes'],
    ['STR ""DVOSTRUKI""', 'doubled double quotes'],
    ['Vendor, "quoted", and more', 'a comma and quotes together'],
    ['Trailing quote"', 'a trailing quote'],
    ['"Leading quote', 'a leading quote'],
    ['Company\nSecond line', 'an embedded newline'],
    ['Company\r\nSecond line', 'an embedded CRLF'],
    ['A,B"C\nD', 'a comma, a quote and a newline at once'],
    ['Zdravo, "šta ima"?\nĆirilica ЋИРИЛИЦА', 'diacritics with every special character'],
  ])('round-trips a vendor name containing %s (%s)', (vendorName) => {
    const rows = parseCsv(manifestToCsv(buildManifest([doc({ vendorName })], '2026-07')))

    expect(rows).toHaveLength(2)
    expect(csvCell(rows, 1, 'vendor')).toBe(vendorName)
  })

  it('quotes a field containing a comma so the column count is unchanged', () => {
    const rows = parseCsv(
      manifestToCsv(buildManifest([doc({ vendorName: 'Marks, Spencer, Beograd' })], '2026-07')),
    )

    expect(rows[1]!.length).toBe(rows[0]!.length)
  })

  it('escapes a double quote by doubling it rather than by dropping or backslashing it', () => {
    const csv = manifestToCsv(buildManifest([doc({ vendorName: 'DOO "MERKUR"' })], '2026-07'))

    expect(csv).toContain('"DOO ""MERKUR"""')
    expect(csv).not.toContain('\\"')
  })

  it('keeps an embedded newline inside one quoted field instead of splitting the record', () => {
    const csv = manifestToCsv(buildManifest([doc({ vendorName: 'Company\nSecond line' })], '2026-07'))
    const rows = parseCsv(csv)

    expect(rows).toHaveLength(2)
    expect(csvCell(rows, 1, 'vendor')).toBe('Company\nSecond line')
  })

  it('escapes a filename containing a comma just as it escapes a vendor', () => {
    const rows = parseCsv(
      manifestToCsv(buildManifest([doc({ filename: 'racun, jul, 2026.pdf' })], '2026-07')),
    )

    expect(csvCell(rows, 1, 'filename')).toBe('racun, jul, 2026.pdf')
  })

  it('includes every row of every group', () => {
    const rows = parseCsv(
      manifestToCsv(
        buildManifest(
          [
            doc({ category: 'izvod', filename: 'izvod.pdf' }),
            doc({ category: 'expense', filename: 'exp.pdf' }),
            doc({ category: 'invoice_out', filename: 'inv.pdf' }),
            doc({ category: 'sef_inbound', filename: 'sef.pdf' }),
          ],
          '2026-07',
        ),
      ),
    )

    expect(rows.slice(1).map((r) => r[rows[0]!.indexOf('filename')])).toEqual([
      'izvod.pdf',
      'exp.pdf',
      'inv.pdf',
      'sef.pdf',
    ])
  })
})

// ---------------------------------------------------------------------------
// periodLabel
// ---------------------------------------------------------------------------

describe('periodLabel', () => {
  it.each([
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

  it('labels the month before January of the following year', () => {
    expect(periodLabel(previousMonth(clockAt('2026-01-01T06:00:00.000Z')))).toBe('decembar 2025')
  })
})

// ---------------------------------------------------------------------------
// buildEmailSubject
// ---------------------------------------------------------------------------

describe('buildEmailSubject', () => {
  it('names the company and the period exactly as the spec prints it', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).toBe(
      'DILIGAF DOO — dokumentacija za jul 2026',
    )
  })

  it('marks a re-sent package as revised', () => {
    const subject = buildEmailSubject('DILIGAF DOO', 'jul 2026', true)

    expect(subject).toContain('DILIGAF DOO — dokumentacija za jul 2026')
    expect(subject).toContain('revidirano')
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).not.toContain('revidirano')
  })

  it('uses the company name it was given rather than a hardcoded one', () => {
    expect(buildEmailSubject('SMOQUA', 'avgust 2026', false)).toBe(
      'SMOQUA — dokumentacija za avgust 2026',
    )
  })
})

// ---------------------------------------------------------------------------
// buildEmailBody
// ---------------------------------------------------------------------------

describe('buildEmailBody', () => {
  /** The worked example from 03-DILIGAF §5, shrunk to a readable size. */
  function julyPackage() {
    return buildManifest(
      [
        doc({
          category: 'izvod',
          filename: 'izvod-265-07-01.pdf',
          docDate: '2026-07-05',
          vendorName: null,
          amountTotal: null,
          amountRsd: null,
          vatAmount: null,
          currency: null,
          extraction: { method: 'pdf_text', confidence: 'high', model: null },
        }),
        doc({
          category: 'expense',
          filename: 'omv.pdf',
          docDate: '2026-07-02',
          vendorName: 'OMV Srbija',
          amountTotal: 4210,
          amountRsd: 4210,
          vatAmount: 701.67,
          extraction: { method: 'fiscal_qr', confidence: 'exact', model: null },
        }),
        doc({
          category: 'expense',
          filename: 'kancelarijski.pdf',
          docDate: '2026-07-04',
          vendorName: 'Kancelarijski materijal',
          amountTotal: 8900,
          amountRsd: 8900,
          vatAmount: 1483.33,
          extraction: { method: 'di_invoice', confidence: 'high', model: null },
        }),
        doc({
          category: 'invoice_out',
          filename: '0007-2026.pdf',
          docDate: '2026-07-10',
          vendorName: 'Klijent A',
          amountNet: 300000,
          vatAmount: 60000,
          amountTotal: 360000,
          amountRsd: 360000,
          extraction: { method: 'manual', confidence: 'exact', model: null },
        }),
        doc({
          category: 'invoice_out',
          filename: '0008-2026.pdf',
          docDate: '2026-07-20',
          vendorName: 'Klijent B',
          amountNet: 300000,
          vatAmount: 60000,
          amountTotal: 360000,
          amountRsd: 360000,
          extraction: { method: 'manual', confidence: 'exact', model: null },
        }),
        doc({
          category: 'sef_inbound',
          filename: 'telekom.pdf',
          docDate: '2026-07-09',
          vendorName: 'Telekom Srbija',
          amountTotal: 12480,
          amountRsd: 12480,
          vatAmount: 2080,
          extraction: { method: 'pdf_text', confidence: 'high', model: null },
        }),
      ],
      '2026-07',
    )
  }

  const bodyFor = (manifest: Manifest, revised = false) =>
    buildEmailBody({ companyName: 'DILIGAF DOO', manifest, periodLabel: 'jul 2026', revised })

  it('renders the accountant email for a full month', () => {
    expect(bodyFor(julyPackage())).toMatchSnapshot()
  })

  it('names the period in the body', () => {
    expect(bodyFor(julyPackage())).toContain('jul 2026')
  })

  it('heads each section with its Serbian name and document count', () => {
    const body = bodyFor(julyPackage())

    expect(body).toMatch(/IZVODI[^\n]*\(1\)/)
    expect(body).toMatch(/TROŠKOVI[^\n]*\(2\)/)
    expect(body).toMatch(/IZLAZNE FAKTURE[^\n]*\(2\)/)
    expect(body).toMatch(/SEF ULAZNE[^\n]*\(1\)/)
  })

  it('lists every document that is in the package', () => {
    const body = bodyFor(julyPackage())

    for (const vendor of ['OMV Srbija', 'Kancelarijski materijal', 'Klijent A', 'Klijent B', 'Telekom Srbija']) {
      expect(body).toContain(vendor)
    }
  })

  it('states the total number of attached documents', () => {
    const manifest = julyPackage()

    expect(bodyFor(manifest)).toContain(`Ukupno u prilogu: ${manifest.totalDocuments}`)
  })

  it('carries no warning marker when every document was read', () => {
    const manifest = buildManifest([doc({ filename: 'a.pdf' }), doc({ filename: 'b.pdf' })], '2026-07')
    const body = bodyFor(manifest)

    expect(manifest.warnings).toEqual([])
    expect(body).not.toContain('⚠')
  })

  it('marks one line with ⚠ for each document whose amount was not read', () => {
    const manifest = buildManifest(
      [
        doc({ filename: 'ok.pdf' }),
        unreadableDoc({ filename: 'bad-1.pdf', docDate: '2026-07-19', vendorName: null }),
        unreadableDoc({ filename: 'bad-2.pdf', docDate: '2026-07-23', vendorName: null }),
      ],
      '2026-07',
    )
    const warningLines = bodyFor(manifest)
      .split('\n')
      .filter((line) => line.trim().startsWith('⚠'))

    expect(manifest.warnings).toHaveLength(2)
    expect(warningLines).toHaveLength(2)
  })

  it('shows a group total when the group is complete', () => {
    const manifest = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf', amountTotal: 4210, amountRsd: 4210 }),
        doc({ category: 'expense', filename: 'b.pdf', amountTotal: 8900, amountRsd: 8900 }),
      ],
      '2026-07',
    )

    expect(manifest.groups[0]!.total).toBe(13110)
    expect(bodyFor(manifest)).toContain('13.110,00')
  })

  it('does not print a group total the manifest refused to compute', () => {
    const manifest = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf', amountTotal: 4210, amountRsd: 4210 }),
        doc({ category: 'expense', filename: 'b.pdf', amountTotal: 8900, amountRsd: 8900 }),
        unreadableDoc({ category: 'expense', filename: 'c.pdf' }),
      ],
      '2026-07',
    )
    const body = bodyFor(manifest)

    expect(manifest.groups[0]!.total).toBeNull()
    expect(body).not.toContain('13.110,00')
    expect(body).toContain('⚠')
  })

  it('marks a re-compiled package as revised in the body', () => {
    expect(bodyFor(julyPackage(), true)).toContain('revidirano')
  })

  it('does not mark a first send as revised in the body', () => {
    expect(bodyFor(julyPackage(), false)).not.toContain('revidirano')
  })

  it('renders a package with nothing in it without inventing content', () => {
    const body = bodyFor(buildManifest([], '2026-07'))

    expect(typeof body).toBe('string')
    expect(body).toContain('jul 2026')
    expect(body).not.toContain('⚠')
    expect(body).toContain('Ukupno u prilogu: 0')
  })

  it('renders a package where nothing at all could be read', () => {
    const manifest = buildManifest(
      [unreadableDoc({ filename: 'a.pdf', vendorName: null }), unreadableDoc({ filename: 'b.pdf', vendorName: null })],
      '2026-07',
    )
    const body = bodyFor(manifest)

    expect(body.split('\n').filter((l) => l.trim().startsWith('⚠'))).toHaveLength(2)
    expect(body).toContain('Ukupno u prilogu: 2')
  })

  it('uses the company name it was given', () => {
    const body = buildEmailBody({
      companyName: 'SMOQUA',
      manifest: buildManifest([doc()], '2026-07'),
      periodLabel: 'jul 2026',
      revised: false,
    })

    expect(body).toContain('SMOQUA')
  })
})
