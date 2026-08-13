import { describe, it, expect } from 'vitest'

import { previousMonth, currentMonth, monthBounds, periodOf } from '../../../src/core/clock.js'
import { buildManifest, manifestToCsv } from '../../../src/core/packaging/manifest.js'
import type { Manifest, ManifestGroup, ManifestRow } from '../../../src/core/packaging/manifest.js'
import { buildEmailBody, buildEmailSubject, periodLabel } from '../../../src/core/packaging/email-body.js'
import type { Clock, DocumentFacts, DocCategory, ExtractionMethod } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library, no real clock, fixed values only.
// ---------------------------------------------------------------------------

/** A Clock frozen at an instant. `now()` returns a fresh Date each call so a
 *  caller that mutates it cannot corrupt the fake. */
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) })

/** A Clock that hands out the SAME Date instance every time — used to prove
 *  the period functions do not mutate what the clock gave them. */
const sharedInstanceClock = (iso: string): { clock: Clock; instance: Date } => {
  const instance = new Date(iso)
  return { clock: { now: () => instance }, instance }
}

const doc = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  book: 'DILIGAF',
  category: 'expense',
  period: '2026-07',
  source: 'whatsapp',
  sourceRef: 'wamid.TEST',
  blobPath: 'diligaf/2026/07/expense/2026-07-02--omv-srbija--91be0d47.pdf',
  filename: 'omv.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  sha256: '91be0d47',
  vendorName: 'OMV Srbija',
  vendorPib: '100002887',
  docDate: '2026-07-02',
  amountNet: 3508.33,
  vatAmount: 701.67,
  amountTotal: 4210,
  currency: 'RSD',
  lineItems: [],
  amountRsd: 4210,
  dimensions: {},
  extraction: { method: 'fiscal_qr', confidence: 'exact', model: null },
  reviewStatus: 'ok',
  createdAt: '2026-07-02T09:14:22Z',
  ...over,
})

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

/** Trailing whitespace stripped and internal runs of spaces collapsed, so a
 *  golden body pins CONTENT and indentation without pinning column alignment
 *  (which no spec fixes). Leading indentation is preserved deliberately. */
const collapse = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 '))
    .join('\n')
    .replace(/\s+$/, '')

const linesOf = (s: string): string[] => collapse(s).split('\n')

// ===========================================================================
// clock.ts — previousMonth
// ===========================================================================

describe('previousMonth', () => {
  // The real trigger instant: 1st of the month, 06:00 UTC (03-DILIGAF §5).
  it.each([
    ['2026-01-01T06:00:00.000Z', '2025-12'],
    ['2026-03-01T06:00:00.000Z', '2026-02'],
    ['2026-08-01T06:00:00.000Z', '2026-07'],
    ['2026-10-01T06:00:00.000Z', '2026-09'],
    ['2026-12-01T06:00:00.000Z', '2026-11'],
  ])('packages the preceding month when the timer fires at %s', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  it('rolls back to December of the prior year on 1 January', () => {
    expect(previousMonth(clockAt('2026-01-01T06:00:00.000Z'))).toBe('2025-12')
  })

  it('rolls back to December of the prior year at the exact stroke of 1 January', () => {
    expect(previousMonth(clockAt('2026-01-01T00:00:00.000Z'))).toBe('2025-12')
  })

  // A naive `d.setMonth(d.getMonth() - 1)` on a 31st overflows back into the
  // month it started in (31 March minus one month = 3 March in some engines,
  // or stays March). These are the cases that catch it.
  it.each([
    ['2026-03-31T06:00:00.000Z', '2026-02'],
    ['2026-07-31T23:00:00.000Z', '2026-06'],
    ['2026-12-31T12:00:00.000Z', '2026-11'],
  ])('does not overflow when the current day is the 31st (%s)', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  it.each([
    ['2024-02-29T06:00:00.000Z', '2024-01'], // on the leap day itself
    ['2024-03-01T06:00:00.000Z', '2024-02'], // the package run that ships a leap February
    ['2024-03-31T06:00:00.000Z', '2024-02'], // 31st -> a 29-day month
    ['2023-03-01T06:00:00.000Z', '2023-02'], // the same run in a non-leap year
    ['2000-03-01T06:00:00.000Z', '2000-02'], // divisible by 400: a leap year
    ['2100-03-01T06:00:00.000Z', '2100-02'], // divisible by 100, not 400: not a leap year
  ])('handles leap and non-leap February around %s', (now, expected) => {
    expect(previousMonth(clockAt(now))).toBe(expected)
  })

  // DST: the EU switches at 01:00 UTC on the last Sunday of March and October.
  // The 06:00 UTC cron drifts one hour across those; the MONTH must not move.
  it('returns February on the spring-forward instant in March', () => {
    expect(previousMonth(clockAt('2026-03-29T01:00:00.000Z'))).toBe('2026-02')
  })

  it('returns September on the fall-back instant in October', () => {
    expect(previousMonth(clockAt('2026-10-25T01:00:00.000Z'))).toBe('2026-09')
  })

  it('picks the same month either side of the spring-forward transition', () => {
    const before = previousMonth(clockAt('2026-03-29T00:59:59.999Z'))
    const after = previousMonth(clockAt('2026-03-29T01:00:00.001Z'))
    expect(before).toBe('2026-02')
    expect(after).toBe('2026-02')
  })

  it('packages March on the first run after the clocks went forward', () => {
    expect(previousMonth(clockAt('2026-04-01T06:00:00.000Z'))).toBe('2026-03')
  })

  it('packages October on the first run after the clocks went back', () => {
    expect(previousMonth(clockAt('2026-11-01T06:00:00.000Z'))).toBe('2026-10')
  })

  // Pins the timezone interpretation. 23:00 UTC on 31 December is already
  // 1 January in Belgrade; UTC says the previous month is November.
  it('interprets the clock instant in UTC, not in local time', () => {
    expect(previousMonth(clockAt('2025-12-31T23:00:00.000Z'))).toBe('2025-11')
  })

  it('does not mutate the Date the clock handed it, so a second call agrees with the first', () => {
    const { clock, instance } = sharedInstanceClock('2026-01-01T06:00:00.000Z')
    const before = instance.getTime()
    expect(previousMonth(clock)).toBe('2025-12')
    expect(previousMonth(clock)).toBe('2025-12')
    expect(instance.getTime()).toBe(before)
  })
})

// ===========================================================================
// clock.ts — currentMonth
// ===========================================================================

describe('currentMonth', () => {
  it.each([
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-08-12T06:00:00.000Z', '2026-08'],
    ['2026-09-05T13:37:00.000Z', '2026-09'],
    ['2024-02-29T23:59:59.999Z', '2024-02'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
  ])('reports the month containing %s', (now, expected) => {
    expect(currentMonth(clockAt(now))).toBe(expected)
  })

  it('interprets the clock instant in UTC, not in local time', () => {
    expect(currentMonth(clockAt('2025-12-31T23:00:00.000Z'))).toBe('2025-12')
  })

  it('does not mutate the Date the clock handed it', () => {
    const { clock, instance } = sharedInstanceClock('2026-08-12T06:00:00.000Z')
    const before = instance.getTime()
    currentMonth(clock)
    expect(instance.getTime()).toBe(before)
  })

})

// ===========================================================================
// clock.ts — monthBounds
// ===========================================================================

describe('monthBounds', () => {
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
  ])('covers %s inclusively from %s to %s', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it('ends February on the 29th in a leap year', () => {
    expect(monthBounds('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
  })

  it('ends February on the 28th in a non-leap year', () => {
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  it('ends February on the 29th in a year divisible by 400', () => {
    expect(monthBounds('2000-02')).toEqual({ start: '2000-02-01', end: '2000-02-29' })
  })

  it('ends February on the 28th in a year divisible by 100 but not 400', () => {
    expect(monthBounds('1900-02')).toEqual({ start: '1900-02-01', end: '1900-02-28' })
    expect(monthBounds('2100-02')).toEqual({ start: '2100-02-01', end: '2100-02-28' })
  })

  // The return type is not nullable, so refusal can only be an exception.
  it.each([['2026-13'], ['2026-00'], ['2026-7'], ['2026-07-01'], ['not-a-period'], ['']])(
    'refuses the malformed period %s rather than guessing a range',
    (period) => {
      expect(() => monthBounds(period)).toThrow()
    },
  )
})

// ===========================================================================
// clock.ts — periodOf
// ===========================================================================

describe('periodOf', () => {
  it.each([
    ['2026-07-15', '2026-07'],
    ['2026-07-01', '2026-07'], // first day of the month
    ['2026-07-31', '2026-07'], // last day of the month
    ['2026-01-01', '2026-01'], // first day of the year
    ['2026-12-31', '2026-12'], // last day of the year
    ['2024-02-29', '2024-02'], // the leap day
  ])('places %s in %s', (date, expected) => {
    expect(periodOf(date)).toBe(expected)
  })

  it('returns null for 29 February in a non-leap year', () => {
    expect(periodOf('2026-02-29')).toBeNull()
  })

  it.each([['2026-13-01'], ['2026-07-32'], ['2026-04-31']])(
    'returns null for the impossible date %s',
    (date) => {
      expect(periodOf(date)).toBeNull()
    },
  )

  it.each([['2026-7-15'], ['15-07-2026'], ['2026/07/15'], ['garbage'], ['']])(
    'returns null for the unparseable date %s',
    (date) => {
      expect(periodOf(date)).toBeNull()
    },
  )

  it('returns null for a full ISO timestamp rather than silently truncating it', () => {
    expect(periodOf('2026-07-15T10:00:00Z')).toBeNull()
  })
})

// ===========================================================================
// manifest.ts — buildManifest
// ===========================================================================

describe('buildManifest', () => {
  it('carries the period it was asked for', () => {
    expect(buildManifest([doc()], '2026-07').period).toBe('2026-07')
  })

  it('returns an empty manifest for no documents', () => {
    const m = buildManifest([], '2026-07')
    expect(m).toEqual({ period: '2026-07', groups: [], totalDocuments: 0, warnings: [] })
  })

  it('groups documents by category', () => {
    const m = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf' }),
        doc({ category: 'izvod', filename: 'b.pdf', amountTotal: null, vatAmount: null, vendorName: null }),
        doc({ category: 'expense', filename: 'c.pdf' }),
      ],
      '2026-07',
    )
    expect(m.groups.map((g) => g.category)).toEqual(['izvod', 'expense'])
    expect(m.groups.find((g) => g.category === 'expense')?.rows).toHaveLength(2)
    expect(m.groups.find((g) => g.category === 'izvod')?.rows).toHaveLength(1)
  })

  it('emits groups in the accountant-facing order regardless of input order', () => {
    const m = buildManifest(
      [
        doc({ category: 'other', filename: 'o.pdf', amountTotal: null, vatAmount: null }),
        doc({ category: 'sef_inbound', filename: 's.pdf' }),
        doc({ category: 'invoice_out', filename: 'i.pdf' }),
        doc({ category: 'expense', filename: 'e.pdf' }),
        doc({ category: 'izvod', filename: 'z.pdf', amountTotal: null, vatAmount: null }),
      ],
      '2026-07',
    )
    expect(m.groups.map((g) => g.category)).toEqual(['izvod', 'expense', 'invoice_out', 'sef_inbound', 'other'])
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
    expect(m.groups[0]?.rows.map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
  })

  it('places rows with no date last rather than dropping them', () => {
    const m = buildManifest(
      [
        doc({ filename: 'undated.pdf', docDate: null }),
        doc({ filename: 'dated.pdf', docDate: '2026-07-02' }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.rows.map((r) => r.filename)).toEqual(['dated.pdf', 'undated.pdf'])
  })

  it('counts the rows in each group', () => {
    const m = buildManifest([doc({ filename: 'a.pdf' }), doc({ filename: 'b.pdf' })], '2026-07')
    expect(m.groups[0]?.count).toBe(2)
  })

  it('reports totalDocuments as the number of documents included', () => {
    const m = buildManifest(
      [
        doc({ category: 'expense', filename: 'a.pdf' }),
        doc({ category: 'invoice_out', filename: 'b.pdf' }),
        doc({ category: 'sef_inbound', filename: 'c.pdf' }),
      ],
      '2026-07',
    )
    expect(m.totalDocuments).toBe(3)
    expect(m.totalDocuments).toBe(m.groups.reduce((n, g) => n + g.count, 0))
  })

  it('totals a group when every row has an amount', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, vatAmount: 701.67 }),
        doc({ filename: 'b.pdf', amountTotal: 8900, vatAmount: 1483.33 }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBe(13110)
    expect(m.groups[0]?.vatTotal).toBe(2185)
  })

  it('returns a null group total when any row is missing an amount', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210 }),
        doc({ filename: 'b.pdf', amountTotal: 8900 }),
        doc({ filename: 'c.pdf', amountTotal: null, vatAmount: null }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBeNull()
  })

  it('does not quietly total the readable subset when one amount is missing', () => {
    const m = buildManifest(
      [doc({ filename: 'a.pdf', amountTotal: 4210 }), doc({ filename: 'b.pdf', amountTotal: null, vatAmount: null })],
      '2026-07',
    )
    expect(m.groups[0]?.total).not.toBe(4210)
    expect(m.groups[0]?.total).toBeNull()
  })

  it('still lists the row whose amount could not be read', () => {
    const m = buildManifest(
      [doc({ filename: 'a.pdf', amountTotal: 4210 }), doc({ filename: 'unreadable.pdf', amountTotal: null })],
      '2026-07',
    )
    expect(m.groups[0]?.rows.map((r) => r.filename)).toContain('unreadable.pdf')
    expect(m.groups[0]?.count).toBe(2)
    expect(m.totalDocuments).toBe(2)
  })

  it('treats a zero amount as a read amount, not as an absent one', () => {
    const m = buildManifest(
      [doc({ filename: 'a.pdf', amountTotal: 0, vatAmount: 0 }), doc({ filename: 'b.pdf', amountTotal: 4210, vatAmount: 701.67 })],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBe(4210)
    expect(m.warnings).toHaveLength(0)
  })

  it('returns a null group total when the rows are in different currencies', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, currency: 'RSD' }),
        doc({ filename: 'b.pdf', amountTotal: 300, currency: 'EUR' }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBeNull()
  })

  it('returns a null VAT total when any row is missing a VAT amount', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210, vatAmount: 701.67 }),
        doc({ filename: 'b.pdf', amountTotal: 8900, vatAmount: null }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBe(13110)
    expect(m.groups[0]?.vatTotal).toBeNull()
  })

  it('leaves an izvod group without a total, because a statement carries no amount', () => {
    const m = buildManifest(
      [
        doc({ category: 'izvod', filename: 'izvod-265-07-01.pdf', vendorName: null, amountTotal: null, vatAmount: null, amountRsd: null }),
        doc({ category: 'izvod', filename: 'izvod-265-07-02.pdf', vendorName: null, amountTotal: null, vatAmount: null, amountRsd: null }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBeNull()
    expect(m.groups[0]?.vatTotal).toBeNull()
    expect(m.groups[0]?.count).toBe(2)
  })

  it('does not warn about an izvod that has no amount, because none was expected', () => {
    const m = buildManifest(
      [doc({ category: 'izvod', filename: 'izvod-265-07-01.pdf', vendorName: null, amountTotal: null, vatAmount: null })],
      '2026-07',
    )
    expect(m.warnings).toEqual([])
    expect(m.groups[0]?.rows[0]?.warning).toBeNull()
  })

  it('raises exactly one warning per expense whose amount could not be read', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', amountTotal: 4210 }),
        doc({ filename: 'b.pdf', amountTotal: null, vatAmount: null }),
        doc({ filename: 'c.pdf', amountTotal: null, vatAmount: null }),
      ],
      '2026-07',
    )
    expect(m.warnings).toHaveLength(2)
  })

  it('raises one warning per document even when a document has several problems', () => {
    const m = buildManifest(
      [doc({ filename: 'bad.pdf', amountTotal: null, vatAmount: null, docDate: null, vendorName: null, reviewStatus: 'needs_review' })],
      '2026-07',
    )
    expect(m.warnings).toHaveLength(1)
  })

  it('names the document in its warning so the accountant can find it', () => {
    const m = buildManifest([doc({ filename: 'blurry-receipt.jpg', amountTotal: null, vatAmount: null })], '2026-07')
    expect(m.warnings[0]).toContain('blurry-receipt.jpg')
  })

  it('warns about a document flagged for review even when its amount was read', () => {
    const m = buildManifest([doc({ filename: 'doubtful.pdf', amountTotal: 4210, reviewStatus: 'needs_review' })], '2026-07')
    expect(m.warnings).toHaveLength(1)
    expect(m.groups[0]?.rows[0]?.warning).not.toBeNull()
  })

  it('does not warn about a document that was reviewed and settled', () => {
    const m = buildManifest([doc({ filename: 'fixed.pdf', amountTotal: 4210, reviewStatus: 'reviewed' })], '2026-07')
    expect(m.warnings).toEqual([])
    expect(m.groups[0]?.rows[0]?.warning).toBeNull()
  })

  it('marks only the uncertain rows, leaving the certain ones with a null warning', () => {
    const m = buildManifest(
      [doc({ filename: 'good.pdf', amountTotal: 4210 }), doc({ filename: 'bad.pdf', amountTotal: null, vatAmount: null })],
      '2026-07',
    )
    const rows = m.groups[0]?.rows ?? []
    expect(rows.find((r) => r.filename === 'good.pdf')?.warning).toBeNull()
    expect(rows.find((r) => r.filename === 'bad.pdf')?.warning).not.toBeNull()
  })

  it('copies the document facts onto the row unchanged', () => {
    const m = buildManifest(
      [doc({ filename: 'omv.pdf', docDate: '2026-07-02', vendorName: 'OMV Srbija', amountTotal: 4210, currency: 'RSD' })],
      '2026-07',
    )
    expect(m.groups[0]?.rows[0]).toMatchObject({
      category: 'expense',
      date: '2026-07-02',
      vendor: 'OMV Srbija',
      amount: 4210,
      currency: 'RSD',
      filename: 'omv.pdf',
    })
  })

  it('keeps null vendor, date and amount as null rather than inventing placeholders', () => {
    const m = buildManifest(
      [doc({ filename: 'x.pdf', vendorName: null, docDate: null, amountTotal: null, currency: null, vatAmount: null })],
      '2026-07',
    )
    expect(m.groups[0]?.rows[0]).toMatchObject({ vendor: null, date: null, amount: null, currency: null })
  })

  const allMethods: ExtractionMethod[] = [
    'cache',
    'fiscal_qr',
    'vendor_profile',
    'pdf_text',
    'di_invoice',
    'di_receipt',
    'llm_vision',
    'manual',
  ]

  it.each(allMethods)('carries extraction method %s through to the row', (method) => {
    const m = buildManifest([doc({ extraction: { method, confidence: 'high', model: null } })], '2026-07')
    expect(m.groups[0]?.rows[0]?.extractionMethod).toBe(method)
  })

  it('records the extraction method per document, not per group', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', extraction: { method: 'fiscal_qr', confidence: 'exact', model: null } }),
        doc({ filename: 'b.pdf', extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' } }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.rows.map((r) => r.extractionMethod)).toEqual(['fiscal_qr', 'llm_vision'])
  })

  it('excludes PERSONAL documents from a DILIGAF manifest', () => {
    const m = buildManifest(
      [
        doc({ book: 'DILIGAF', category: 'expense', filename: 'omv.pdf' }),
        doc({ book: 'PERSONAL', category: 'statement', filename: 'licni-izvod.pdf', vendorName: 'Banka Intesa' }),
        doc({ book: 'PERSONAL', category: 'expense', filename: 'wolt.pdf', vendorName: 'Wolt Beograd', amountTotal: 1450 }),
      ],
      '2026-07',
    )
    const filenames = m.groups.flatMap((g) => g.rows.map((r) => r.filename))
    expect(filenames).toEqual(['omv.pdf'])
    expect(m.groups.map((g) => g.category)).not.toContain('statement')
    expect(m.totalDocuments).toBe(1)
  })

  it('excludes PERSONAL documents from the totals and the warnings', () => {
    const m = buildManifest(
      [
        doc({ book: 'DILIGAF', filename: 'omv.pdf', amountTotal: 4210, vatAmount: 701.67 }),
        doc({ book: 'PERSONAL', filename: 'wolt.pdf', amountTotal: 1450, vatAmount: null }),
        doc({ book: 'PERSONAL', filename: 'unreadable-personal.jpg', amountTotal: null, vatAmount: null }),
      ],
      '2026-07',
    )
    expect(m.groups[0]?.total).toBe(4210)
    expect(m.groups[0]?.vatTotal).toBe(701.67)
    expect(m.warnings).toEqual([])
  })

  it('produces an empty manifest when every document is PERSONAL', () => {
    const m = buildManifest([doc({ book: 'PERSONAL', category: 'statement', filename: 'p.pdf' })], '2026-07')
    expect(m.groups).toEqual([])
    expect(m.totalDocuments).toBe(0)
  })

  it('excludes a document belonging to another period', () => {
    const m = buildManifest(
      [doc({ filename: 'july.pdf', period: '2026-07' }), doc({ filename: 'june.pdf', period: '2026-06' })],
      '2026-07',
    )
    expect(m.groups.flatMap((g) => g.rows.map((r) => r.filename))).toEqual(['july.pdf'])
    expect(m.totalDocuments).toBe(1)
  })

  it('includes a late arrival whose period is the packaged month', () => {
    // A July receipt that landed on 3 August still belongs to the July package.
    const m = buildManifest(
      [doc({ filename: 'late.pdf', period: '2026-07', docDate: '2026-07-31', createdAt: '2026-08-03T10:00:00Z' })],
      '2026-07',
    )
    expect(m.totalDocuments).toBe(1)
  })
})

// ===========================================================================
// manifest.ts — manifestToCsv
// ===========================================================================

const CSV_HEADER = 'category,date,vendor,amount,currency,filename,extraction_method,warning'

describe('manifestToCsv', () => {
  const oneRowManifest = (r: Partial<ManifestRow>): Manifest =>
    manifest({
      groups: [group({ category: 'expense', rows: [row(r)], count: 1, total: null, vatTotal: null })],
      totalDocuments: 1,
    })

  const dataLines = (csv: string): string[] => csv.replace(/\r\n$/, '').split('\r\n').slice(1)

  it('starts with a header row that includes extraction_method', () => {
    const csv = manifestToCsv(oneRowManifest({}))
    expect(csv.split('\r\n')[0]).toBe(CSV_HEADER)
  })

  it('separates records with CRLF', () => {
    const csv = manifestToCsv(
      manifest({
        groups: [group({ category: 'expense', rows: [row({ filename: 'a.pdf' }), row({ filename: 'b.pdf' })], count: 2 })],
        totalDocuments: 2,
      }),
    )
    expect(csv).toContain('\r\n')
    expect(dataLines(csv)).toHaveLength(2)
  })

  it('emits a header and nothing else for an empty manifest', () => {
    const csv = manifestToCsv(manifest())
    expect(csv.replace(/\r\n$/, '')).toBe(CSV_HEADER)
  })

  it('writes one line per document and no total lines', () => {
    const csv = manifestToCsv(
      manifest({
        groups: [
          group({ category: 'izvod', rows: [row({ category: 'izvod', filename: 'z.pdf' })], count: 1 }),
          group({ category: 'expense', rows: [row({ filename: 'a.pdf' }), row({ filename: 'b.pdf' })], count: 2, total: 8420 }),
        ],
        totalDocuments: 3,
      }),
    )
    expect(dataLines(csv)).toHaveLength(3)
  })

  it('writes the groups in manifest order', () => {
    const csv = manifestToCsv(
      manifest({
        groups: [
          group({ category: 'izvod', rows: [row({ category: 'izvod', filename: 'z.pdf' })], count: 1 }),
          group({ category: 'expense', rows: [row({ filename: 'a.pdf' })], count: 1 }),
        ],
        totalDocuments: 2,
      }),
    )
    expect(dataLines(csv).map((l) => l.split(',')[0])).toEqual(['izvod', 'expense'])
  })

  it('writes a plain row unquoted', () => {
    const csv = manifestToCsv(oneRowManifest({}))
    expect(dataLines(csv)[0]).toBe('expense,2026-07-02,OMV Srbija,4210.00,RSD,omv.pdf,fiscal_qr,')
  })

  it('does not let a comma in a vendor name add a column', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: 'A, B, C' }))
    const line = dataLines(csv)[0] ?? ''
    expect(line.startsWith('expense,2026-07-02,"A, B, C",4210.00,RSD,omv.pdf,fiscal_qr,')).toBe(true)
  })

  it('doubles a double quote inside a vendor name and quotes the field', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: 'Vendor "X" d.o.o.' }))
    expect(dataLines(csv)[0]).toContain('"Vendor ""X"" d.o.o."')
  })

  it('quotes a vendor name that is only a double quote', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: '"' }))
    expect(dataLines(csv)[0]).toContain('""""')
  })

  it('quotes a vendor name containing a newline and keeps the newline inside the field', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: 'Prvi red\nDrugi red' }))
    expect(csv).toContain('"Prvi red\nDrugi red"')
  })

  it('quotes a vendor name containing a CRLF and keeps it inside the field', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: 'Prvi red\r\nDrugi red' }))
    expect(csv).toContain('"Prvi red\r\nDrugi red"')
    expect(csv.startsWith(`${CSV_HEADER}\r\nexpense,2026-07-02,"Prvi red\r\nDrugi red",`)).toBe(true)
  })

  it('quotes a vendor name containing a comma, a quote and a newline at once', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: 'A, "B"\nC' }))
    expect(csv).toContain('"A, ""B""\nC"')
  })

  it('preserves leading and trailing spaces in a vendor name', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: '  OMV  ' }))
    expect(csv).toContain('  OMV  ')
  })

  it('writes an empty field, not the word null, for an absent value', () => {
    const csv = manifestToCsv(oneRowManifest({ vendor: null, date: null, amount: null, currency: null }))
    expect(dataLines(csv)[0]).toBe('expense,,,,,omv.pdf,fiscal_qr,')
    expect(csv).not.toContain('null')
  })

  it('writes the amount with a dot decimal separator so the file stays machine-readable', () => {
    const csv = manifestToCsv(oneRowManifest({ amount: 186430 }))
    expect(dataLines(csv)[0]).toContain(',186430.00,')
    expect(csv).not.toContain('186.430,00')
  })

  it('writes the warning text in its own column', () => {
    const csv = manifestToCsv(oneRowManifest({ amount: null, warning: 'iznos nije pročitan' }))
    expect(dataLines(csv)[0]?.endsWith(',iznos nije pročitan')).toBe(true)
  })

  it('quotes a warning that contains a comma', () => {
    const csv = manifestToCsv(oneRowManifest({ warning: 'iznos nije pročitan, proveriti' }))
    expect(csv).toContain('"iznos nije pročitan, proveriti"')
  })

})

// ===========================================================================
// email-body.ts — periodLabel
// ===========================================================================

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

  it('keeps the year of a December period', () => {
    expect(periodLabel('2025-12')).toBe('decembar 2025')
  })

  it.each([['2026-13'], ['2026-00'], ['2026-7'], [''], ['garbage']])(
    'refuses the malformed period %s rather than labelling it',
    (period) => {
      expect(() => periodLabel(period)).toThrow()
    },
  )
})

// ===========================================================================
// email-body.ts — buildEmailSubject
// ===========================================================================

describe('buildEmailSubject', () => {
  it('names the company and the period', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).toBe('DILIGAF DOO — dokumentacija za jul 2026')
  })

  it('marks a re-sent package as revised', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', true)).toBe('DILIGAF DOO — dokumentacija za jul 2026 (revidirano)')
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false)).not.toContain('revidirano')
  })

  it('uses the period label verbatim', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'decembar 2025', false)).toContain('decembar 2025')
  })

  it('is a single line', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', true)).not.toContain('\n')
  })
})

// ===========================================================================
// email-body.ts — buildEmailBody
// ===========================================================================

const izvodGroup = group({
  category: 'izvod',
  count: 2,
  total: null,
  vatTotal: null,
  rows: [
    row({ category: 'izvod', date: '2026-07-05', vendor: null, amount: null, currency: null, filename: 'izvod 265-07-01.pdf', extractionMethod: 'pdf_text' }),
    row({ category: 'izvod', date: '2026-07-15', vendor: null, amount: null, currency: null, filename: 'izvod 265-07-02.pdf', extractionMethod: 'pdf_text' }),
  ],
})

const expenseGroup = group({
  category: 'expense',
  count: 2,
  total: 13110,
  vatTotal: 2185,
  rows: [
    row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, filename: 'omv.pdf' }),
    row({ date: '2026-07-04', vendor: 'Kancelarijski materijal', amount: 8900, filename: 'kancelarija.pdf' }),
  ],
})

const canonicalManifest = manifest({
  period: '2026-07',
  groups: [izvodGroup, expenseGroup],
  totalDocuments: 4,
  warnings: [],
})

const input = (over: Partial<Parameters<typeof buildEmailBody>[0]> = {}) => ({
  companyName: 'DILIGAF DOO',
  manifest: canonicalManifest,
  periodLabel: 'jul 2026',
  revised: false,
  ...over,
})

describe('buildEmailBody', () => {
  it('renders the whole accountant email for a clean month', () => {
    const expected = [
      'Zdravo,',
      '',
      'u prilogu je dokumentacija za jul 2026.',
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

  it('uses the period label it was given rather than deriving one', () => {
    expect(buildEmailBody(input({ periodLabel: 'decembar 2025' }))).toContain('decembar 2025')
  })

  it.each([
    ['izvod' as DocCategory, 'IZVODI'],
    ['expense' as DocCategory, 'TROŠKOVI'],
    ['invoice_out' as DocCategory, 'IZLAZNE FAKTURE'],
    ['sef_inbound' as DocCategory, 'SEF ULAZNE — PRIHVAĆENE'],
    ['other' as DocCategory, 'OSTALO'],
  ])('heads the %s group with "%s"', (category, heading) => {
    const body = buildEmailBody(
      input({
        manifest: manifest({
          groups: [group({ category, count: 1, total: null, vatTotal: null, rows: [row({ category, amount: null, currency: null, filename: 'x.pdf' })] })],
          totalDocuments: 1,
        }),
      }),
    )
    expect(collapse(body)).toContain(`${heading} (1)`)
  })

  it('shows the total without a VAT figure when the VAT total is unknown', () => {
    const g = group({ category: 'expense', count: 1, total: 4210, vatTotal: null, rows: [row({})] })
    const body = collapse(buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: 1 }) })))
    expect(body).toContain('TROŠKOVI (1) — 4.210,00 RSD')
    expect(body).not.toContain('PDV')
  })

  it('shows no amount in the heading when the group total could not be established', () => {
    const g = group({
      category: 'expense',
      count: 2,
      total: null,
      vatTotal: null,
      rows: [row({ filename: 'a.pdf' }), row({ filename: 'b.pdf', amount: null, warning: 'iznos nije pročitan' })],
    })
    const m = manifest({ groups: [g], totalDocuments: 2, warnings: ['b.pdf: iznos nije pročitan'] })
    const heading = linesOf(buildEmailBody(input({ manifest: m }))).find((l) => l.startsWith('TROŠKOVI'))
    expect(heading).toBe('TROŠKOVI (2)')
  })

  it('renders an outgoing-invoice heading as net plus VAT equals total', () => {
    const g = group({
      category: 'invoice_out',
      count: 2,
      total: 720000,
      vatTotal: 120000,
      rows: [
        row({ category: 'invoice_out', date: '2026-07-10', vendor: 'Klijent A', amount: 360000, filename: '0007-2026.pdf', extractionMethod: 'manual' }),
        row({ category: 'invoice_out', date: '2026-07-20', vendor: 'Klijent B', amount: 360000, filename: '0008-2026.pdf', extractionMethod: 'manual' }),
      ],
    })
    const body = collapse(buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: 2 }) })))
    expect(body).toContain('IZLAZNE FAKTURE (2) — neto 600.000,00 + PDV 120.000,00 = 720.000,00 RSD')
  })

  it('formats amounts in Serbian notation', () => {
    const body = buildEmailBody(input())
    expect(body).toContain('4.210,00')
    expect(body).toContain('8.900,00')
    expect(body).not.toContain('4210.00')
  })

  it('marks a document with no readable amount with a ⚠ line', () => {
    const g = group({
      category: 'expense',
      count: 2,
      total: null,
      vatTotal: null,
      rows: [
        row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, filename: 'omv.pdf' }),
        row({ date: '2026-07-19', vendor: null, amount: null, currency: null, filename: 'blurry.jpg', extractionMethod: 'llm_vision', warning: 'iznos nije pročitan' }),
      ],
    })
    const body = buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: 2, warnings: ['blurry.jpg: iznos nije pročitan'] }) }))
    const warned = linesOf(body).filter((l) => l.includes('⚠') && l.startsWith('  '))
    expect(warned).toEqual(['  ⚠ 2026-07-19 nepoznat dobavljač iznos nije pročitan'])
  })

  it('does not mark a document whose amount was read', () => {
    const body = buildEmailBody(input())
    expect(body).not.toContain('⚠')
  })

  it('marks each uncertain document on its own line', () => {
    const g = group({
      category: 'expense',
      count: 3,
      total: null,
      vatTotal: null,
      rows: [
        row({ filename: 'ok.pdf' }),
        row({ date: '2026-07-19', vendor: 'Dobavljač A', amount: null, filename: 'a.jpg', warning: 'iznos nije pročitan' }),
        row({ date: '2026-07-21', vendor: 'Dobavljač B', amount: null, filename: 'b.jpg', warning: 'iznos nije pročitan' }),
      ],
    })
    const body = buildEmailBody(
      input({ manifest: manifest({ groups: [g], totalDocuments: 3, warnings: ['a.jpg: iznos nije pročitan', 'b.jpg: iznos nije pročitan'] }) }),
    )
    expect(linesOf(body).filter((l) => l.includes('⚠'))).toHaveLength(2)
  })

  it('still lists a row that has no date, marked as uncertain', () => {
    const g = group({
      category: 'expense',
      count: 1,
      total: null,
      vatTotal: null,
      rows: [row({ date: null, vendor: 'Dobavljač C', amount: null, filename: 'nodate.jpg', warning: 'datum i iznos nisu pročitani' })],
    })
    const body = buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: 1, warnings: ['nodate.jpg: datum i iznos nisu pročitani'] }) }))
    const warned = linesOf(body).filter((l) => l.includes('⚠'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('Dobavljač C')
  })

  it('closes with a note counting the uncertain documents', () => {
    const g = group({
      category: 'expense',
      count: 3,
      total: null,
      vatTotal: null,
      rows: [
        row({ filename: 'ok.pdf' }),
        row({ vendor: null, amount: null, filename: 'a.jpg', warning: 'iznos nije pročitan' }),
        row({ vendor: null, amount: null, filename: 'b.jpg', warning: 'iznos nije pročitan' }),
      ],
    })
    const body = collapse(
      buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: 3, warnings: ['a.jpg: iznos nije pročitan', 'b.jpg: iznos nije pročitan'] }) })),
    )
    expect(body).toContain('Napomena: 2 dokumenta bez pročitanog iznosa (obeležena ⚠ i u manifest.csv).')
  })

  it('omits the closing note when nothing is uncertain', () => {
    expect(buildEmailBody(input())).not.toContain('Napomena:')
  })

  // Serbian numeric agreement: 1 -> dokument, 2-4 -> dokumenta, 5+ -> dokumenata,
  // with 11-14 always taking the plural genitive.
  it.each([
    [1, 'Ukupno u prilogu: 1 dokument.'],
    [2, 'Ukupno u prilogu: 2 dokumenta.'],
    [5, 'Ukupno u prilogu: 5 dokumenata.'],
    [11, 'Ukupno u prilogu: 11 dokumenata.'],
    [21, 'Ukupno u prilogu: 21 dokument.'],
    [23, 'Ukupno u prilogu: 23 dokumenta.'],
  ])('agrees the noun with a count of %i', (count, expected) => {
    const rows = Array.from({ length: count }, (_, i) => row({ filename: `doc-${i}.pdf` }))
    const g = group({ category: 'expense', count, total: 4210 * count, vatTotal: null, rows })
    expect(collapse(buildEmailBody(input({ manifest: manifest({ groups: [g], totalDocuments: count }) })))).toContain(expected)
  })

  it('renders a month with no documents without inventing sections', () => {
    const body = collapse(buildEmailBody(input({ manifest: manifest({ period: '2026-07', groups: [], totalDocuments: 0 }) })))
    expect(body).toContain('Ukupno u prilogu: 0 dokumenata.')
    expect(body).not.toContain('TROŠKOVI')
    expect(body).not.toContain('IZVODI')
    expect(body).toContain('Zdravo,')
  })

  it('marks a re-compiled package as revised', () => {
    expect(buildEmailBody(input({ revised: true }))).toContain('revidirano')
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailBody(input({ revised: false }))).not.toContain('revidirano')
  })
})

// ===========================================================================
// The safety property: a DILIGAF package never contains PERSONAL data.
// ===========================================================================

describe('PERSONAL documents in a DILIGAF package', () => {
  const mixed: DocumentFacts[] = [
    doc({ book: 'DILIGAF', category: 'expense', filename: 'omv.pdf', vendorName: 'OMV Srbija', amountTotal: 4210, vatAmount: 701.67 }),
    doc({
      book: 'PERSONAL',
      category: 'statement',
      filename: 'izvod-tekuci-jul.pdf',
      vendorName: 'Banka Intesa',
      amountTotal: null,
      vatAmount: null,
      blobPath: 'personal/2026/07/statement/izvod-tekuci-jul.pdf',
    }),
    doc({
      book: 'PERSONAL',
      category: 'expense',
      filename: 'wolt.pdf',
      vendorName: 'Wolt Beograd',
      amountTotal: 1450,
      vatAmount: null,
      blobPath: 'personal/2026/07/expense/wolt.pdf',
    }),
  ]

  it('never lists a PERSONAL document in the manifest', () => {
    const m = buildManifest(mixed, '2026-07')
    const serialized = JSON.stringify(m)
    expect(serialized).not.toContain('Wolt Beograd')
    expect(serialized).not.toContain('Banka Intesa')
    expect(serialized).not.toContain('izvod-tekuci-jul.pdf')
    expect(serialized).not.toContain('personal/')
  })

  it('never writes a PERSONAL document into the CSV', () => {
    const csv = manifestToCsv(buildManifest(mixed, '2026-07'))
    expect(csv).not.toContain('Wolt')
    expect(csv).not.toContain('Banka Intesa')
    expect(csv).not.toContain('izvod-tekuci-jul.pdf')
    expect(csv.replace(/\r\n$/, '').split('\r\n')).toHaveLength(2) // header + the single DILIGAF row
  })

  it('never mentions a PERSONAL document in the accountant email', () => {
    const m = buildManifest(mixed, '2026-07')
    const body = buildEmailBody({ companyName: 'DILIGAF DOO', manifest: m, periodLabel: 'jul 2026', revised: false })
    expect(body).not.toContain('Wolt')
    expect(body).not.toContain('Banka Intesa')
    expect(body).toContain('OMV Srbija')
    expect(collapse(body)).toContain('Ukupno u prilogu: 1 dokument.')
  })

  it('does not count a PERSONAL document toward the DILIGAF totals', () => {
    const m = buildManifest(mixed, '2026-07')
    expect(m.totalDocuments).toBe(1)
    expect(m.groups.find((g) => g.category === 'expense')?.total).toBe(4210)
  })
})
