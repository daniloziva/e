/**
 * E — engineer #2 draft tests.
 * AREA: manifest, accountant email body, period math.
 *
 * Written before any implementation exists. Every case below is expected to be RED
 * (stubs throw "not implemented"). Nothing here may be relaxed to make it green —
 * the implementation moves, not the assertion.
 *
 * Contract under test:
 *   src/engine/clock.ts              previousMonth / currentMonth / monthBounds / periodOf
 *   src/engine/packaging/manifest.ts buildManifest / manifestToCsv
 *   src/engine/packaging/email-body.ts buildEmailBody / buildEmailSubject / periodLabel
 *
 * Spec: 03-DILIGAF.md §5, 01-ARCHITECTURE.md §9 (clock discipline), §5 (provenance).
 */

import { describe, it, expect } from 'vitest'

import { previousMonth, currentMonth, monthBounds, periodOf } from '../../../src/engine/clock.js'
import { buildManifest, manifestToCsv } from '../../../src/engine/packaging/manifest.js'
import type { Manifest, ManifestGroup, ManifestRow } from '../../../src/engine/packaging/manifest.js'
import { buildEmailBody, buildEmailSubject, periodLabel } from '../../../src/engine/packaging/email-body.js'
import type {
  Clock,
  Currency,
  DocCategory,
  DocumentFacts,
  ExtractionMethod,
  ReviewStatus,
} from '../../../src/engine/types.js'

// ───────────────────────────── fakes & fixtures ─────────────────────────────
// No mocking library. A Clock is two lines of hand-written code with a fixed value.

const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) })

let seq = 0
function doc(over: Partial<DocumentFacts> = {}): DocumentFacts {
  seq += 1
  const base: DocumentFacts = {
    book: 'DILIGAF',
    category: 'expense',
    period: '2026-07',
    source: 'whatsapp',
    sourceRef: `wa-${seq}`,
    blobPath: `diligaf/2026/07/doc-${seq}.pdf`,
    filename: `doc-${seq}.pdf`,
    mimeType: 'application/pdf',
    byteSize: 1024,
    sha256: `sha-${seq}`,
    amountRsd: 1000,
    dimensions: {},
    extraction: { method: 'pdf_text', confidence: 'high', model: null },
    reviewStatus: 'ok',
    createdAt: '2026-08-01T06:00:00.000Z',
    vendorName: `Vendor ${seq}`,
    vendorPib: null,
    docDate: '2026-07-15',
    amountNet: null,
    vatAmount: null,
    amountTotal: 1000,
    currency: 'RSD',
    lineItems: [],
  }
  const merged = { ...base, ...over }
  // keep amountRsd consistent with amountTotal for RSD docs unless explicitly overridden,
  // so the tests pass whether the implementation reads amountTotal or amountRsd.
  if (!('amountRsd' in over) && merged.currency === 'RSD') merged.amountRsd = merged.amountTotal
  return merged
}

/** DILIGAF-shaped set roughly mirroring the 03-DILIGAF §5 example. */
function specDocs(): DocumentFacts[] {
  return [
    doc({ category: 'izvod', filename: 'izvod 265-07-01.pdf', docDate: '2026-07-05', vendorName: null, amountTotal: null, amountRsd: null, extraction: { method: 'pdf_text', confidence: 'exact', model: null } }),
    doc({ category: 'izvod', filename: 'izvod 265-07-02.pdf', docDate: '2026-07-15', vendorName: null, amountTotal: null, amountRsd: null, extraction: { method: 'pdf_text', confidence: 'exact', model: null } }),
    doc({ category: 'izvod', filename: 'izvod 265-07-03.pdf', docDate: '2026-07-31', vendorName: null, amountTotal: null, amountRsd: null, extraction: { method: 'pdf_text', confidence: 'exact', model: null } }),
    doc({ category: 'expense', filename: 'omv.pdf', docDate: '2026-07-02', vendorName: 'OMV Srbija', amountTotal: 4210, vatAmount: 716.67 }),
    doc({ category: 'expense', filename: 'kancelarija.pdf', docDate: '2026-07-04', vendorName: 'Kancelarijski materijal', amountTotal: 182220, vatAmount: 30355 }),
    doc({ category: 'invoice_out', filename: '0007-2026.pdf', docDate: '2026-07-20', vendorName: 'Klijent A', amountTotal: 360000, amountNet: 300000, vatAmount: 60000 }),
    doc({ category: 'sef_inbound', filename: 'telekom.xml', docDate: '2026-07-09', vendorName: 'Telekom Srbija', amountTotal: 12480 }),
  ]
}

const groupOf = (m: Manifest, c: DocCategory): ManifestGroup => {
  const g = m.groups.find((x) => x.category === c)
  if (!g) throw new Error(`no group for category ${c}`)
  return g
}

const allRows = (m: Manifest): ManifestRow[] => m.groups.flatMap((g) => g.rows)

// ───────────────────── an RFC4180 reader, used to check the writer ─────────────────────
// Decoding the published format is not "asserting on internals": it is the only way to
// check escaping without pinning whether the writer quotes minimally or always.
function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      field += ch; i += 1; continue
    }
    if (ch === '"') { inQuotes = true; i += 1; continue }
    if (ch === ',') { record.push(field); field = ''; i += 1; continue }
    if (ch === '\r' && text[i + 1] === '\n') { record.push(field); records.push(record); record = []; field = ''; i += 2; continue }
    if (ch === '\n' || ch === '\r') { record.push(field); records.push(record); record = []; field = ''; i += 1; continue }
    field += ch; i += 1
  }
  if (field !== '' || record.length > 0) { record.push(field); records.push(record) }
  return records
}

// ═══════════════════════════════════════════════════════════════════════════
// clock.ts — period math. Never the real clock; always an injected fake.
// ═══════════════════════════════════════════════════════════════════════════

describe('previousMonth', () => {
  it('packages July when the timer fires on 1 August — the D6 decision', () => {
    expect(previousMonth(fixedClock('2026-08-01T06:00:00.000Z'))).toBe('2026-07')
  })

  it('rolls back to December of the prior year on 1 January', () => {
    expect(previousMonth(fixedClock('2026-01-01T06:00:00.000Z'))).toBe('2025-12')
  })

  it.each([
    ['exact first instant of January', '2026-01-01T00:00:00.000Z', '2025-12'],
    ['exact last instant of January', '2026-01-31T23:59:59.999Z', '2025-12'],
    ['exact first instant of February', '2026-02-01T00:00:00.000Z', '2026-01'],
    ['exact last instant of December', '2026-12-31T23:59:59.999Z', '2026-11'],
    ['exact first instant of a new year', '2027-01-01T00:00:00.000Z', '2026-12'],
  ])('handles the %s', (_label, iso, expected) => {
    expect(previousMonth(fixedClock(iso))).toBe(expected)
  })

  it.each([
    ['1 March in a leap year yields February of that leap year', '2024-03-01T06:00:00.000Z', '2024-02'],
    ['1 March in a non-leap year yields February all the same', '2026-03-01T06:00:00.000Z', '2026-02'],
    ['the leap day itself yields January', '2024-02-29T12:00:00.000Z', '2024-01'],
    ['1 March 2000 (century leap year) yields February 2000', '2000-03-01T06:00:00.000Z', '2000-02'],
    ['1 March 2100 (century non-leap year) yields February 2100', '2100-03-01T06:00:00.000Z', '2100-02'],
  ])('%s', (_label, iso, expected) => {
    expect(previousMonth(fixedClock(iso))).toBe(expected)
  })

  it.each([
    ['the instant CET becomes CEST', '2026-03-29T01:00:00.000Z', '2026-02'],
    ['a moment inside the spring-forward day', '2026-03-29T06:00:00.000Z', '2026-02'],
    ['the instant CEST becomes CET', '2026-10-25T01:00:00.000Z', '2026-09'],
    ['a moment inside the repeated autumn hour', '2026-10-25T00:30:00.000Z', '2026-09'],
    ['the 06:00 UTC timer on the first CET morning after the switch', '2026-11-01T06:00:00.000Z', '2026-10'],
    ['the 06:00 UTC timer on the first CEST morning after the switch', '2026-04-01T06:00:00.000Z', '2026-03'],
  ])('picks the same month across %s — DST may shift the hour, never the month', (_label, iso, expected) => {
    expect(previousMonth(fixedClock(iso))).toBe(expected)
  })

  it('interprets the clock instant as UTC, not as a local wall-clock time', () => {
    // 23:30 UTC on 31 December is already 00:30 on 1 January in Belgrade.
    // Reading the instant as UTC is what makes the answer independent of where the
    // function app happens to run (01-ARCHITECTURE §9).
    expect(previousMonth(fixedClock('2025-12-31T23:30:00.000Z'))).toBe('2025-11')
  })

  it('zero-pads single-digit months', () => {
    expect(previousMonth(fixedClock('2026-05-10T06:00:00.000Z'))).toBe('2026-04')
  })
})

describe('currentMonth', () => {
  it.each([
    ['2026-08-01T06:00:00.000Z', '2026-08'],
    ['2026-08-31T23:59:59.999Z', '2026-08'],
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
    ['2024-02-29T12:00:00.000Z', '2024-02'],
    ['2026-03-29T01:00:00.000Z', '2026-03'],
  ])('returns the clock month for %s', (iso, expected) => {
    expect(currentMonth(fixedClock(iso))).toBe(expected)
  })

  it('is exactly one month ahead of previousMonth across the year boundary', () => {
    const c = fixedClock('2026-01-01T06:00:00.000Z')
    expect(currentMonth(c)).toBe('2026-01')
    expect(previousMonth(c)).toBe('2025-12')
  })
})

describe('monthBounds', () => {
  it('returns an inclusive first-to-last-day range for a 31-day month', () => {
    expect(monthBounds('2026-07')).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })

  it.each([
    ['2024-02', '2024-02-01', '2024-02-29', 'leap year'],
    ['2026-02', '2026-02-01', '2026-02-28', 'ordinary year'],
    ['2000-02', '2000-02-01', '2000-02-29', 'century leap year'],
    ['1900-02', '1900-02-01', '1900-02-28', 'century non-leap year'],
    ['2100-02', '2100-02-01', '2100-02-28', 'century non-leap year'],
  ])('ends February %s on %s..%s (%s)', (period, start, end) => {
    expect(monthBounds(period)).toEqual({ start, end })
  })

  it.each([
    ['2026-01', '2026-01-31'],
    ['2026-03', '2026-03-31'],
    ['2026-04', '2026-04-30'],
    ['2026-05', '2026-05-31'],
    ['2026-06', '2026-06-30'],
    ['2026-08', '2026-08-31'],
    ['2026-09', '2026-09-30'],
    ['2026-10', '2026-10-31'],
    ['2026-11', '2026-11-30'],
    ['2026-12', '2026-12-31'],
  ])('ends %s on %s', (period, end) => {
    expect(monthBounds(period)).toEqual({ start: `${period}-01`, end })
  })

  it('ends the spring-forward month on the 31st, not the 30th', () => {
    // A month containing a DST transition is 23 hours short. Anything that adds
    // 30 * 86_400_000 ms in local time lands on 2026-03-30 here.
    expect(monthBounds('2026-03').end).toBe('2026-03-31')
  })

  it.each([
    ['month 13', '2026-13'],
    ['month 00', '2026-00'],
    ['an unpadded month', '2026-7'],
    ['a full date instead of a period', '2026-07-15'],
    ['prose', 'not-a-month'],
    ['an empty string', ''],
  ])('refuses %s rather than inventing a range', (_label, period) => {
    expect(() => monthBounds(period)).toThrow()
  })
})

describe('periodOf', () => {
  it.each([
    ['2026-07-15', '2026-07'],
    ['2026-01-01', '2026-01'],
    ['2026-12-31', '2026-12'],
    ['2024-02-29', '2024-02'],
    ['2026-07-01', '2026-07'],
    ['2026-07-31', '2026-07'],
  ])('maps %s to %s', (date, expected) => {
    expect(periodOf(date)).toBe(expected)
  })

  it('returns null for 29 February in a non-leap year rather than rolling into March', () => {
    // The silent-rollover bug: new Date('2026-02-29') is 1 March. A late receipt
    // would then be filed into the wrong month's package forever.
    expect(periodOf('2026-02-29')).toBeNull()
  })

  it.each([
    ['a 31st in a 30-day month', '2026-04-31'],
    ['day 00', '2026-07-00'],
    ['month 13', '2026-13-01'],
    ['month 00', '2026-00-10'],
    ['an unpadded month', '2026-7-15'],
    ['the Serbian dotted format', '15.07.2026'],
    ['a bare period', '2026-07'],
    ['prose', 'juče'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, input) => {
    expect(periodOf(input)).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns null when the date is %s', (_label, input) => {
    expect(periodOf(input as unknown as string)).toBeNull()
  })

  it('returns null for a full ISO timestamp — the contract is YYYY-MM-DD', () => {
    expect(periodOf('2026-07-15T10:00:00Z')).toBeNull()
  })

  it('agrees with monthBounds at both ends of a month', () => {
    const { start, end } = monthBounds('2024-02')
    expect(periodOf(start)).toBe('2024-02')
    expect(periodOf(end)).toBe('2024-02')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// buildManifest
// ═══════════════════════════════════════════════════════════════════════════

describe('buildManifest — shape and grouping', () => {
  it('carries the requested period through onto the manifest', () => {
    expect(buildManifest(specDocs(), '2026-07').period).toBe('2026-07')
  })

  it('returns an empty manifest for no documents at all', () => {
    const m = buildManifest([], '2026-07')
    expect(m.period).toBe('2026-07')
    expect(m.groups).toEqual([])
    expect(m.totalDocuments).toBe(0)
    expect(m.warnings).toEqual([])
  })

  it('groups documents by category and counts each group', () => {
    const m = buildManifest(specDocs(), '2026-07')
    expect(groupOf(m, 'izvod').count).toBe(3)
    expect(groupOf(m, 'expense').count).toBe(2)
    expect(groupOf(m, 'invoice_out').count).toBe(1)
    expect(groupOf(m, 'sef_inbound').count).toBe(1)
  })

  it('emits no group for a category with no documents', () => {
    const m = buildManifest([doc({ category: 'expense' })], '2026-07')
    expect(m.groups.map((g) => g.category)).toEqual(['expense'])
  })

  it('orders groups the way the accountant email reads them', () => {
    const docs = [
      doc({ category: 'sef_inbound' }),
      doc({ category: 'invoice_out' }),
      doc({ category: 'expense' }),
      doc({ category: 'izvod' }),
    ]
    expect(buildManifest(docs, '2026-07').groups.map((g) => g.category))
      .toEqual(['izvod', 'expense', 'invoice_out', 'sef_inbound'])
  })

  it('puts the catch-all "other" category last', () => {
    const docs = [doc({ category: 'other' }), doc({ category: 'izvod' }), doc({ category: 'expense' })]
    const cats = buildManifest(docs, '2026-07').groups.map((g) => g.category)
    expect(cats[cats.length - 1]).toBe('other')
  })

  it('counts every document exactly once in totalDocuments', () => {
    const m = buildManifest(specDocs(), '2026-07')
    expect(m.totalDocuments).toBe(7)
    expect(allRows(m)).toHaveLength(7)
  })

  it('orders rows inside a group by date, oldest first', () => {
    const docs = [
      doc({ category: 'izvod', filename: 'c.pdf', docDate: '2026-07-31' }),
      doc({ category: 'izvod', filename: 'a.pdf', docDate: '2026-07-05' }),
      doc({ category: 'izvod', filename: 'b.pdf', docDate: '2026-07-15' }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'izvod').rows.map((r) => r.filename))
      .toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
  })

  it('keeps an undated document in the manifest, sorted after the dated ones', () => {
    const docs = [
      doc({ category: 'expense', filename: 'undated.pdf', docDate: null }),
      doc({ category: 'expense', filename: 'dated.pdf', docDate: '2026-07-05' }),
    ]
    const rows = groupOf(buildManifest(docs, '2026-07'), 'expense').rows
    expect(rows.map((r) => r.filename)).toEqual(['dated.pdf', 'undated.pdf'])
  })

  it('copies date, vendor, amount, currency and filename onto the row verbatim', () => {
    const d = doc({ category: 'expense', filename: 'omv.pdf', docDate: '2026-07-02', vendorName: 'OMV Srbija', amountTotal: 4210, currency: 'RSD' })
    const row = groupOf(buildManifest([d], '2026-07'), 'expense').rows[0]!
    expect(row).toMatchObject({
      category: 'expense',
      date: '2026-07-02',
      vendor: 'OMV Srbija',
      amount: 4210,
      currency: 'RSD',
      filename: 'omv.pdf',
    })
  })

  it('leaves an unread vendor null rather than substituting a placeholder', () => {
    const row = groupOf(buildManifest([doc({ vendorName: null })], '2026-07'), 'expense').rows[0]!
    expect(row.vendor).toBeNull()
  })

  it('leaves an unread date null rather than defaulting to the period start', () => {
    const row = groupOf(buildManifest([doc({ docDate: null })], '2026-07'), 'expense').rows[0]!
    expect(row.date).toBeNull()
  })

  it('leaves an unread amount null rather than zero', () => {
    const row = groupOf(buildManifest([doc({ amountTotal: null, amountRsd: null })], '2026-07'), 'expense').rows[0]!
    expect(row.amount).toBeNull()
    expect(row.amount).not.toBe(0)
  })
})

describe('buildManifest — totals', () => {
  it('totals a group when every row has an amount', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: 4210 }),
      doc({ category: 'expense', amountTotal: 182220 }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'expense').total).toBe(186430)
  })

  it('returns a null group total when any single row is missing an amount', () => {
    const docs = [
      doc({ category: 'expense', filename: 'a.pdf', amountTotal: 4210 }),
      doc({ category: 'expense', filename: 'b.pdf', amountTotal: 8900 }),
      doc({ category: 'expense', filename: 'c.pdf', amountTotal: null, amountRsd: null }),
    ]
    const g = groupOf(buildManifest(docs, '2026-07'), 'expense')
    expect(g.total).toBeNull()
  })

  it('does not silently total the subset it could read', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: 4210 }),
      doc({ category: 'expense', amountTotal: 8900 }),
      doc({ category: 'expense', amountTotal: null, amountRsd: null }),
    ]
    const g = groupOf(buildManifest(docs, '2026-07'), 'expense')
    expect(g.total).not.toBe(13110)
    expect(g.total).not.toBe(0)
    expect(g.count).toBe(3)
    expect(g.rows.map((r) => r.amount)).toContain(null)
  })

  it('nulls only the affected group, leaving other groups totalled', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: null, amountRsd: null }),
      doc({ category: 'sef_inbound', amountTotal: 12480 }),
    ]
    const m = buildManifest(docs, '2026-07')
    expect(groupOf(m, 'expense').total).toBeNull()
    expect(groupOf(m, 'sef_inbound').total).toBe(12480)
  })

  it('refuses to total a group whose rows are in different currencies', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: 4210, currency: 'RSD' }),
      doc({ category: 'expense', amountTotal: 300, currency: 'EUR', amountRsd: null }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'expense').total).toBeNull()
  })

  it('totals VAT when every row in the group carries a VAT amount', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: 4210, vatAmount: 716.67 }),
      doc({ category: 'expense', amountTotal: 182220, vatAmount: 30355 }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'expense').vatTotal).toBeCloseTo(31071.67, 2)
  })

  it('reports a null VAT total, not zero, when no row carries VAT', () => {
    const docs = [doc({ category: 'izvod', amountTotal: null, amountRsd: null, vatAmount: null })]
    expect(groupOf(buildManifest(docs, '2026-07'), 'izvod').vatTotal).toBeNull()
  })

  it('keeps a total of exactly zero distinguishable from an unknown total', () => {
    const docs = [doc({ category: 'other', amountTotal: 0, amountRsd: 0 })]
    expect(groupOf(buildManifest(docs, '2026-07'), 'other').total).toBe(0)
  })
})

describe('buildManifest — warnings, one per uncertain document', () => {
  it('emits exactly one warning per document with no amount', () => {
    const docs = [
      doc({ category: 'expense', filename: 'ok.pdf', amountTotal: 4210 }),
      doc({ category: 'expense', filename: 'unreadable-a.pdf', amountTotal: null, amountRsd: null }),
      doc({ category: 'sef_inbound', filename: 'unreadable-b.xml', amountTotal: null, amountRsd: null }),
    ]
    expect(buildManifest(docs, '2026-07').warnings).toHaveLength(2)
  })

  it('names the offending document in its warning so it can be found', () => {
    const docs = [doc({ category: 'expense', filename: 'racun-0007.pdf', amountTotal: null, amountRsd: null })]
    const w = buildManifest(docs, '2026-07').warnings
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('racun-0007.pdf')
  })

  it('emits no warnings when every document was read cleanly', () => {
    const docs = [doc({ amountTotal: 4210 }), doc({ amountTotal: 8900 })]
    expect(buildManifest(docs, '2026-07').warnings).toEqual([])
  })

  it('marks the uncertain row itself with a warning and leaves clean rows null', () => {
    const docs = [
      doc({ category: 'expense', filename: 'ok.pdf', amountTotal: 4210 }),
      doc({ category: 'expense', filename: 'bad.pdf', amountTotal: null, amountRsd: null }),
    ]
    const rows = groupOf(buildManifest(docs, '2026-07'), 'expense').rows
    const ok = rows.find((r) => r.filename === 'ok.pdf')!
    const bad = rows.find((r) => r.filename === 'bad.pdf')!
    expect(ok.warning).toBeNull()
    expect(bad.warning).not.toBeNull()
  })

  it('warns once, not twice, for a document that is both undated and unpriced', () => {
    const docs = [doc({ filename: 'blur.jpg', docDate: null, amountTotal: null, amountRsd: null })]
    expect(buildManifest(docs, '2026-07').warnings).toHaveLength(1)
  })

  it('flags a document queued for review even though an amount was read', () => {
    const docs = [doc({ filename: 'sumnjivo.jpg', amountTotal: 4210, reviewStatus: 'needs_review' })]
    const m = buildManifest(docs, '2026-07')
    expect(m.warnings).toHaveLength(1)
    expect(groupOf(m, 'expense').rows[0]!.warning).not.toBeNull()
  })

  it.each<[ReviewStatus]>([['ok'], ['reviewed']])(
    'does not flag a document whose review status is %s',
    (reviewStatus) => {
      const docs = [doc({ amountTotal: 4210, reviewStatus })]
      expect(buildManifest(docs, '2026-07').warnings).toEqual([])
    },
  )

  it('does not let a flagged-but-priced document null the group total', () => {
    const docs = [
      doc({ category: 'expense', amountTotal: 4210, reviewStatus: 'needs_review' }),
      doc({ category: 'expense', amountTotal: 8900 }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'expense').total).toBe(13110)
  })
})

describe('buildManifest — provenance', () => {
  it.each<[ExtractionMethod]>([
    ['cache'], ['fiscal_qr'], ['vendor_profile'], ['pdf_text'],
    ['di_invoice'], ['di_receipt'], ['llm_vision'], ['manual'],
  ])('carries the %s extraction method through to the row', (method) => {
    const d = doc({ extraction: { method, confidence: 'high', model: method === 'llm_vision' ? 'gpt-4o-mini@2026-05' : null } })
    expect(groupOf(buildManifest([d], '2026-07'), 'expense').rows[0]!.extractionMethod).toBe(method)
  })

  it('keeps each document’s own extraction method rather than the first one seen', () => {
    const docs = [
      doc({ category: 'expense', filename: 'qr.pdf', docDate: '2026-07-01', extraction: { method: 'fiscal_qr', confidence: 'exact', model: null } }),
      doc({ category: 'expense', filename: 'llm.jpg', docDate: '2026-07-02', extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' } }),
    ]
    const rows = groupOf(buildManifest(docs, '2026-07'), 'expense').rows
    expect(rows.map((r) => r.extractionMethod)).toEqual(['fiscal_qr', 'llm_vision'])
  })
})

describe('buildManifest — book isolation', () => {
  it('never lets a PERSONAL document into a DILIGAF manifest', () => {
    const docs = [
      doc({ book: 'DILIGAF', category: 'expense', filename: 'poslovni-racun.pdf', vendorName: 'OMV Srbija' }),
      doc({ book: 'DILIGAF', category: 'izvod', filename: 'izvod 265-07-01.pdf', vendorName: null, amountTotal: null, amountRsd: null }),
      doc({ book: 'PERSONAL', category: 'expense', filename: 'apoteka-privatno.pdf', vendorName: 'Apoteka Jankovic' }),
    ]
    const m = buildManifest(docs, '2026-07')
    const files = allRows(m).map((r) => r.filename)
    expect(files).not.toContain('apoteka-privatno.pdf')
    expect(allRows(m).map((r) => r.vendor)).not.toContain('Apoteka Jankovic')
    expect(m.totalDocuments).toBe(2)
  })

  it('excludes a PERSONAL document from the group total as well as from the rows', () => {
    const docs = [
      doc({ book: 'DILIGAF', category: 'expense', amountTotal: 4210 }),
      doc({ book: 'DILIGAF', category: 'expense', amountTotal: 8900 }),
      doc({ book: 'PERSONAL', category: 'expense', amountTotal: 999999 }),
    ]
    expect(groupOf(buildManifest(docs, '2026-07'), 'expense').total).toBe(13110)
  })

  it('does not warn about an excluded PERSONAL document', () => {
    const docs = [
      doc({ book: 'DILIGAF', category: 'expense', amountTotal: 4210 }),
      doc({ book: 'PERSONAL', category: 'expense', filename: 'privatno.jpg', amountTotal: null, amountRsd: null }),
    ]
    const m = buildManifest(docs, '2026-07')
    expect(m.warnings).toEqual([])
    expect(JSON.stringify(m)).not.toContain('privatno.jpg')
  })

  it('excludes a document belonging to a different period than the one requested', () => {
    const docs = [
      doc({ filename: 'jul.pdf', period: '2026-07', docDate: '2026-07-20' }),
      doc({ filename: 'jun.pdf', period: '2026-06', docDate: '2026-06-20' }),
    ]
    const m = buildManifest(docs, '2026-07')
    expect(allRows(m).map((r) => r.filename)).toEqual(['jul.pdf'])
    expect(m.totalDocuments).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifestToCsv — RFC4180
// ═══════════════════════════════════════════════════════════════════════════

describe('manifestToCsv', () => {
  const csvOf = (docs: DocumentFacts[]) => manifestToCsv(buildManifest(docs, '2026-07'))

  it('writes a header plus one record per document', () => {
    const rows = parseCsv(csvOf(specDocs()))
    expect(rows).toHaveLength(1 + 7)
  })

  it('writes only the header for an empty manifest', () => {
    const rows = parseCsv(manifestToCsv(buildManifest([], '2026-07')))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.length).toBeGreaterThan(0)
  })

  it('carries an extraction_method column so LLM-read facts are visible as such', () => {
    const csv = csvOf([doc({ extraction: { method: 'llm_vision', confidence: 'low', model: 'gpt-4o-mini@2026-05' } })])
    const [header, row] = parseCsv(csv)
    const idx = header!.indexOf('extraction_method')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(row![idx]).toBe('llm_vision')
  })

  it('gives every record the same number of fields as the header', () => {
    const rows = parseCsv(csvOf(specDocs()))
    const width = rows[0]!.length
    for (const r of rows) expect(r).toHaveLength(width)
  })

  it('separates records with CRLF as RFC4180 requires', () => {
    const csv = csvOf([doc()])
    expect(csv).toContain('\r\n')
  })

  it('round-trips a vendor name containing a comma', () => {
    const csv = csvOf([doc({ vendorName: 'OMV Srbija, DOO Beograd' })])
    const rows = parseCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('OMV Srbija, DOO Beograd')
  })

  it('doubles an embedded double quote rather than escaping it with a backslash', () => {
    const csv = csvOf([doc({ vendorName: 'The "Best" Shop' })])
    expect(csv).toContain('"The ""Best"" Shop"')
    expect(csv).not.toContain('\\"')
    expect(parseCsv(csv)[1]).toContain('The "Best" Shop')
  })

  it('round-trips a vendor name containing a newline without inventing a record', () => {
    const csv = csvOf([doc({ vendorName: 'Prvi red\nDrugi red' })])
    const rows = parseCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('Prvi red\nDrugi red')
  })

  it('round-trips a vendor name containing a CRLF', () => {
    const rows = parseCsv(csvOf([doc({ vendorName: 'Prvi red\r\nDrugi red' })]))
    expect(rows).toHaveLength(2)
    expect(rows[1]!.join('|')).toContain('Drugi red')
  })

  it('round-trips a vendor name that is nothing but a quoted comma', () => {
    const rows = parseCsv(csvOf([doc({ vendorName: '","' })]))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('","')
  })

  it('round-trips Serbian diacritics untouched', () => {
    const rows = parseCsv(csvOf([doc({ vendorName: 'Šećerana Đurđević Čačak' })]))
    expect(rows[1]).toContain('Šećerana Đurđević Čačak')
  })

  it('writes an empty field, not a zero, when the amount was not read', () => {
    const csv = csvOf([
      doc({ filename: 'unreadable.pdf', vendorName: 'Nepoznat', amountTotal: null, amountRsd: null }),
    ])
    const [, row] = parseCsv(csv)
    expect(row).not.toContain('0')
    expect(row!.filter((f) => f === '')).not.toHaveLength(0)
  })

  it('writes an empty field for a vendor that was never read', () => {
    const rows = parseCsv(csvOf([doc({ vendorName: null, filename: 'anon.pdf' })]))
    expect(rows[1]).toContain('anon.pdf')
    expect(rows[1]!.filter((f) => f === '').length).toBeGreaterThan(0)
  })

  it('carries the warning text for an uncertain document into the record', () => {
    const csv = csvOf([doc({ filename: 'blur.jpg', amountTotal: null, amountRsd: null })])
    const m = buildManifest([doc({ filename: 'blur.jpg', amountTotal: null, amountRsd: null })], '2026-07')
    const warning = groupOf(m, 'expense').rows[0]!.warning!
    expect(parseCsv(csv)[1]).toContain(warning)
  })

  it('never writes a PERSONAL document into a DILIGAF manifest.csv', () => {
    const csv = csvOf([
      doc({ book: 'DILIGAF', vendorName: 'OMV Srbija' }),
      doc({ book: 'PERSONAL', vendorName: 'Apoteka Jankovic', filename: 'privatno.pdf' }),
    ])
    expect(csv).not.toContain('Apoteka Jankovic')
    expect(csv).not.toContain('privatno.pdf')
    expect(parseCsv(csv)).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body
// ═══════════════════════════════════════════════════════════════════════════

let rowSeq = 0
function row(over: Partial<ManifestRow> = {}): ManifestRow {
  rowSeq += 1
  return {
    category: 'expense',
    date: '2026-07-02',
    vendor: `Vendor ${rowSeq}`,
    amount: 1000,
    currency: 'RSD' as Currency,
    filename: `doc-${rowSeq}.pdf`,
    extractionMethod: 'pdf_text',
    warning: null,
    ...over,
  }
}

function group(category: DocCategory, rows: ManifestRow[], over: Partial<ManifestGroup> = {}): ManifestGroup {
  const amounts = rows.map((r) => r.amount)
  const total = amounts.some((a) => a === null) ? null : amounts.reduce((s, a) => s! + a!, 0)
  return { category, rows, count: rows.length, total, vatTotal: null, ...over }
}

function manifest(groups: ManifestGroup[], over: Partial<Manifest> = {}): Manifest {
  return {
    period: '2026-07',
    groups,
    totalDocuments: groups.reduce((s, g) => s + g.rows.length, 0),
    warnings: [],
    ...over,
  }
}

/** The 03-DILIGAF §5 example, trimmed to a size a test can assert on. */
function specManifest(): Manifest {
  return manifest(
    [
      group('izvod', [
        row({ category: 'izvod', date: '2026-07-05', vendor: null, amount: null, filename: 'izvod 265-07-01.pdf' }),
        row({ category: 'izvod', date: '2026-07-15', vendor: null, amount: null, filename: 'izvod 265-07-02.pdf' }),
        row({ category: 'izvod', date: '2026-07-31', vendor: null, amount: null, filename: 'izvod 265-07-03.pdf' }),
      ], { total: null, vatTotal: null }),
      group('expense', [
        row({ category: 'expense', date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, filename: 'omv.pdf' }),
        row({ category: 'expense', date: '2026-07-04', vendor: 'Kancelarijski materijal', amount: 182220, filename: 'kancelarija.pdf' }),
      ], { total: 186430, vatTotal: 31071.67 }),
      group('invoice_out', [
        row({ category: 'invoice_out', date: '2026-07-20', vendor: 'Klijent A', amount: 360000, filename: '0007-2026.pdf' }),
      ], { total: 360000, vatTotal: 60000 }),
      group('sef_inbound', [
        row({ category: 'sef_inbound', date: '2026-07-09', vendor: 'Telekom Srbija', amount: 12480, filename: 'telekom.xml' }),
      ], { total: 12480, vatTotal: null }),
    ],
  )
}

const bodyInput = (m: Manifest, revised = false) => ({
  companyName: 'DILIGAF DOO',
  manifest: m,
  periodLabel: 'jul 2026',
  revised,
})

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

  it('labels a month in a different year with that year', () => {
    expect(periodLabel('2025-12')).toBe('decembar 2025')
  })

  it.each([['2026-13'], ['2026-00'], ['2026-7'], [''], ['jul 2026']])(
    'refuses the malformed period %s',
    (period) => {
      expect(() => periodLabel(period)).toThrow()
    },
  )
})

describe('buildEmailSubject', () => {
  it('matches the subject line in the spec exactly', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'jul 2026', false))
      .toBe('DILIGAF DOO — dokumentacija za jul 2026')
  })

  it('marks a re-sent package as revised', () => {
    const s = buildEmailSubject('DILIGAF DOO', 'jul 2026', true)
    expect(s).toContain('DILIGAF DOO — dokumentacija za jul 2026')
    expect(s).toContain('revidirano')
  })

  it('uses the period label it is given without re-translating it', () => {
    expect(buildEmailSubject('DILIGAF DOO', 'decembar 2025', false))
      .toBe('DILIGAF DOO — dokumentacija za decembar 2025')
  })

  it('uses the company name it is given', () => {
    expect(buildEmailSubject('SMOQUA DOO', 'jul 2026', false)).toContain('SMOQUA DOO')
  })
})

describe('buildEmailBody — the spec example', () => {
  it('renders the whole body stably', () => {
    expect(buildEmailBody(bodyInput(specManifest()))).toMatchSnapshot()
  })

  it('opens with a Serbian greeting and states the period', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b).toContain('Zdravo,')
    expect(b).toContain('u prilogu je dokumentacija za jul 2026.')
  })

  it('signs off as E', () => {
    expect(buildEmailBody(bodyInput(specManifest())).trimEnd().endsWith('E')).toBe(true)
  })

  it.each([
    ['izvod', 'IZVODI'],
    ['expense', 'TROŠKOVI'],
    ['invoice_out', 'IZLAZNE FAKTURE'],
    ['sef_inbound', 'SEF ULAZNE'],
  ])('titles the %s group "%s"', (_category, heading) => {
    expect(buildEmailBody(bodyInput(specManifest()))).toContain(heading)
  })

  it('puts the count next to each heading', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b).toContain('IZVODI (3)')
    expect(b).toContain('TROŠKOVI (2)')
  })

  it('orders the sections izvodi, troškovi, izlazne fakture, SEF', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b.indexOf('IZVODI')).toBeLessThan(b.indexOf('TROŠKOVI'))
    expect(b.indexOf('TROŠKOVI')).toBeLessThan(b.indexOf('IZLAZNE FAKTURE'))
    expect(b.indexOf('IZLAZNE FAKTURE')).toBeLessThan(b.indexOf('SEF ULAZNE'))
  })

  it('shows the group total in Serbian number format with its currency', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b).toContain('186.430,00 RSD')
  })

  it('shows the VAT figure alongside the expense total', () => {
    expect(buildEmailBody(bodyInput(specManifest()))).toContain('31.071,67')
  })

  it('lists each document with its date and vendor', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b).toContain('2026-07-05')
    expect(b).toContain('OMV Srbija')
    expect(b).toContain('Telekom Srbija')
  })

  it('closes with the total document count', () => {
    expect(buildEmailBody(bodyInput(specManifest()))).toContain('Ukupno u prilogu: 7')
  })
})

describe('buildEmailBody — the ⚠ lines', () => {
  const uncertain = () =>
    manifest(
      [
        group('expense', [
          row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210 }),
          row({ date: '2026-07-19', vendor: null, amount: null, filename: 'blur.jpg', warning: 'iznos nije pročitan' }),
        ], { total: null, vatTotal: null }),
      ],
      { warnings: ['blur.jpg: iznos nije pročitan'] },
    )

  it('marks the uncertain document with a ⚠', () => {
    expect(buildEmailBody(bodyInput(uncertain()))).toContain('⚠')
  })

  it('says on the ⚠ line that the amount was not read', () => {
    expect(buildEmailBody(bodyInput(uncertain()))).toContain('iznos nije pročitan')
  })

  it('names an unknown vendor as unknown instead of leaving the column blank', () => {
    expect(buildEmailBody(bodyInput(uncertain()))).toContain('nepoznat dobavljač')
  })

  it('still lists the certain documents alongside the uncertain one', () => {
    const b = buildEmailBody(bodyInput(uncertain()))
    expect(b).toContain('OMV Srbija')
    expect(b).toContain('2026-07-02')
  })

  it('marks only the uncertain line — the clean line carries no ⚠', () => {
    const b = buildEmailBody(bodyInput(uncertain()))
    const warned = b.split('\n').filter((l) => l.includes('⚠') && l.includes('2026-07-'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).not.toContain('OMV Srbija')
  })

  it('adds the closing note counting the documents with no amount', () => {
    const b = buildEmailBody(bodyInput(uncertain()))
    expect(b).toContain('Napomena:')
    expect(b).toContain('bez pročitanog iznosa')
    expect(b).toContain('manifest.csv')
  })

  it('omits the closing note entirely when nothing is uncertain', () => {
    const b = buildEmailBody(bodyInput(specManifest()))
    expect(b).not.toContain('Napomena:')
  })

  it('omits any ⚠ when nothing is uncertain', () => {
    expect(buildEmailBody(bodyInput(specManifest()))).not.toContain('⚠')
  })

  it('never prints a subtotal for a group whose total could not be established', () => {
    const b = buildEmailBody(bodyInput(uncertain()))
    // 4.210,00 alone is not the group total — printing it would understate the month.
    expect(b).not.toContain('TROŠKOVI (2) — 4.210,00')
  })
})

describe('buildEmailBody — degenerate and adversarial input', () => {
  it('produces a valid body for a month with no documents at all', () => {
    const b = buildEmailBody(bodyInput(manifest([])))
    expect(b).toContain('Zdravo,')
    expect(b).toContain('jul 2026')
    expect(b).toContain('Ukupno u prilogu: 0')
  })

  it('prints no category heading for a month with no documents', () => {
    const b = buildEmailBody(bodyInput(manifest([])))
    for (const h of ['IZVODI', 'TROŠKOVI', 'IZLAZNE FAKTURE', 'SEF ULAZNE']) {
      expect(b).not.toContain(h)
    }
  })

  it('marks a re-compiled package as revised in the body too', () => {
    expect(buildEmailBody(bodyInput(specManifest(), true))).toContain('revidirano')
  })

  it('does not mark a first send as revised', () => {
    expect(buildEmailBody(bodyInput(specManifest(), false))).not.toContain('revidirano')
  })

  it('uses the company name it is given', () => {
    expect(buildEmailBody({ ...bodyInput(specManifest()), companyName: 'SMOQUA DOO' })).toContain('SMOQUA DOO')
  })

  it('never leaks a PERSONAL vendor even if one is handed to it in the manifest', () => {
    const leaked = manifest([
      group('expense', [
        row({ vendor: 'OMV Srbija', amount: 4210 }),
        row({ vendor: 'Apoteka Jankovic — privatno', amount: 2300, filename: 'privatno.pdf' }),
      ]),
    ])
    const b = buildEmailBody(bodyInput(leaked))
    expect(b).not.toContain('Apoteka Jankovic')
    expect(b).not.toContain('privatno.pdf')
  })

  it('keeps a vendor name containing a newline from breaking the line layout', () => {
    const m = manifest([group('expense', [row({ vendor: 'Prvi red\nDrugi red', amount: 4210 })])])
    const b = buildEmailBody(bodyInput(m))
    const listed = b.split('\n').filter((l) => l.includes('Drugi red'))
    expect(listed).toHaveLength(1)
  })

  it('renders a long vendor name without truncating the amount off the line', () => {
    const long = 'Preduzeće za proizvodnju i promet Šećerana Đurđević doo Čačak'
    const m = manifest([group('expense', [row({ vendor: long, amount: 4210 })])])
    expect(buildEmailBody(bodyInput(m))).toContain('4.210,00')
  })

  it('lists a document that has no date at all', () => {
    const m = manifest([group('expense', [row({ date: null, vendor: 'OMV Srbija', amount: 4210, filename: 'nedatirano.pdf' })])])
    const b = buildEmailBody(bodyInput(m))
    expect(b).toContain('OMV Srbija')
  })

  it.each([
    [1, 'dokument'],
    [2, 'dokumenta'],
    [4, 'dokumenta'],
    [5, 'dokumenata'],
    [11, 'dokumenata'],
    [21, 'dokument'],
    [23, 'dokumenta'],
  ])('declines the noun correctly for %i documents', (n, form) => {
    const rows = Array.from({ length: n }, () => row({ amount: 100 }))
    const m = manifest([group('expense', rows)])
    expect(buildEmailBody(bodyInput(m))).toContain(`Ukupno u prilogu: ${n} ${form}`)
  })
})
