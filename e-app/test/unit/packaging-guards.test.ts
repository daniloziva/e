import { describe, it, expect } from 'vitest'

import {
  buildManifest,
  manifestToCsv,
  type Manifest,
  type ManifestGroup,
  type ManifestRow,
} from '../../src/engine/packaging/manifest.js'
import { buildEmailBody, periodLabel } from '../../src/engine/packaging/email-body.js'
import type { DocCategory, DocumentFacts } from '../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// GUARDS NO FROZEN CASE REACHES — new tests for behaviour packaging.test.ts
// does not cover.
//
// TEST-FREEZE.md permits "adding tests for new behaviour that no test covers".
// Nothing frozen is touched here, and nothing in src/ was changed.
//
// Every case below was located by reading the v8 branch map — file, line and
// branch id — not by guessing, and each was then MUTATION-VERIFIED: the guard
// was deliberately broken in src/, the suite was run, and a test here went red.
// A guard that no mutation could break is not listed as covered; it is listed
// in the UNREACHABLE block at the bottom of this file with the argument for
// why no input can reach it.
//
// `src/engine/packaging/**` was the worst directory in the codebase at 83.49%
// branches while the global gate (90%) had no margin, so these branches are
// the cheapest headroom available.
// ─────────────────────────────────────────────────────────────────────────────

// ── the RED guard, as packaging.test.ts defines it ───────────────────────────
// A bare .toThrow() is satisfied by a `not implemented` stub, so it proves
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

// ── document fixtures ───────────────────────────────────────────────────────
// Kept local and deliberately identical in shape to packaging.test.ts's
// BASE_DOC. That file is frozen, so it exports nothing and is not imported.

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
  dimensions: {},
  extraction: { method: 'fiscal_qr', confidence: 'exact', model: null },
  reviewStatus: 'ok',
  createdAt: '2026-07-02T09:14:22.000Z',
}

const doc = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({ ...BASE_DOC, ...over })

/**
 * A document whose `category` is a string the DocCategory union does not
 * contain. The cast IS the point and is the reason these branches exist:
 * buildManifest reads `entry['category']` through a runtime check rather than
 * trusting the type, because these facts are parsed out of sidecar JSON where
 * nothing enforces the union.
 */
const strangeCategoryDoc = (category: string, over: Partial<DocumentFacts> = {}): DocumentFacts =>
  ({ ...doc(over), category }) as unknown as DocumentFacts

/**
 * A document whose `extraction` is not an object at all. Same runtime boundary:
 * `prepare` calls `isRecord(extraction)` precisely because a sidecar can carry
 * anything, so the cast reproduces the malformed blob the guard is written for.
 */
const brokenExtractionDoc = (extraction: unknown, over: Partial<DocumentFacts> = {}): DocumentFacts =>
  ({ ...doc(over), extraction }) as unknown as DocumentFacts

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

const groupOf = (rows: ManifestRow[], over: Partial<ManifestGroup> = {}): ManifestGroup =>
  group({ category: rows[0]?.category ?? 'expense', rows, count: rows.length, ...over })

/**
 * Wraps one group in a manifest.
 *
 * The `Array.isArray` check is about the FIXTURE, not about the code under test:
 * several cases below hand this builder a group whose `rows` is deliberately not
 * an array, and a bare `g.rows.length` here threw inside the builder — so
 * `manifestToCsv` was never called and the case asserted nothing while looking
 * like a real failure. A fixture helper must reach src.
 */
const only = (g: ManifestGroup): Manifest =>
  manifest({ groups: [g], totalDocuments: Array.isArray(g.rows) ? g.rows.length : 0 })

const bodyInput = (over: Partial<Parameters<typeof buildEmailBody>[0]> = {}): Parameters<typeof buildEmailBody>[0] => ({
  companyName: 'DILIGAF DOO',
  manifest: manifest(),
  periodLabel: 'jul 2026',
  revised: false,
  ...over,
})

const categoryGroup = (m: Manifest, category: DocCategory): ManifestGroup => {
  const g = m.groups.find((x) => x.category === category)
  expect(g, `manifest has a "${category}" group`).toBeDefined()
  return g!
}

const firstRow = (m: Manifest, category: DocCategory): ManifestRow => {
  const r = categoryGroup(m, category).rows[0]
  expect(r, `the "${category}" group has a first row`).toBeDefined()
  return r!
}

/** Trailing whitespace stripped and internal runs of spaces collapsed — the
 *  packaging.test.ts idiom: content and indentation are pinned, the column
 *  padding (which no spec fixes) is not. */
const collapse = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 '))
    .join('\n')
    .replace(/\s+$/, '')

const linesOf = (s: string): string[] => collapse(s).split('\n')

const csvRecords = (csv: string): string[] => csv.replace(/\r\n$/, '').split('\r\n')

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — defensive field reads (prepare / readString / readDate)
// ═══════════════════════════════════════════════════════════════════════════

describe('a field that is present but blank reads as unread, not as a value', () => {
  // manifest.ts:95 — readString's `value.trim() === '' ? null : value`. Every
  // frozen case supplies either a real string or an explicit null, so the
  // whitespace-only case — which is what an OCR rung produces when it finds a
  // vendor box and reads nothing out of it — was never exercised.
  it('reads a whitespace-only vendor name as null rather than as a blank vendor', () => {
    const m = buildManifest([doc({ vendorName: '   ' })], '2026-07')

    expect(firstRow(m, 'expense').vendor).toBeNull()
  })

  it('does not warn about a blank vendor on its own — the money was read', () => {
    // 03-DILIGAF §5: the warning predicate is deliberately narrow (money), so a
    // blank vendor is visible as "nepoznat dobavljač" without being counted.
    const m = buildManifest([doc({ vendorName: '   ' })], '2026-07')

    expect(firstRow(m, 'expense').warning).toBeNull()
    expect(m.warnings).toEqual([])
  })

  // manifest.ts:201 — `readString(facts['filename']) ?? ''`.
  it('reads a blank filename as an empty cell, never as the string "null"', () => {
    const m = buildManifest([doc({ filename: '' })], '2026-07')

    expect(firstRow(m, 'expense').filename).toBe('')
  })

  // manifest.ts:111 — readDate's `periodOf(text) === null ? null : text`. A
  // syntactically valid date naming a day that does not exist must not reach
  // the accountant's spreadsheet as if it were data.
  it.each([
    ['2026-02-30'],
    ['2026-04-31'],
    ['2025-02-29'],
    ['2026-13-01'],
  ])('reads the impossible date %s as unread rather than passing it through', (docDate) => {
    const m = buildManifest([doc({ docDate })], '2026-07')

    expect(firstRow(m, 'expense').date).toBeNull()
  })

  it('leaps correctly — 2028-02-29 exists and is kept', () => {
    // The negative cases above would also pass against a readDate that rejected
    // every February 29. This is the assertion that stops that mutant.
    const m = buildManifest([doc({ docDate: '2028-02-29', period: '2026-07' })], '2026-07')

    expect(firstRow(m, 'expense').date).toBe('2028-02-29')
  })
})

describe('an extraction block that is not a record leaves the method column empty', () => {
  // manifest.ts:193 — `isRecord(extraction) ? readString(...) : null` — and
  // :204 — `method ?? ''`. §5's rule is that anything read by an LLM is visible
  // as such, so an unknown rung must print as an empty cell and never as
  // "manual", which would claim a human keyed the figures in.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'fiscal_qr'],
    ['an array', ['fiscal_qr']],
    ['a number', 7],
  ])('reads an extraction block that is %s as no method at all', (_label, extraction) => {
    const m = buildManifest([brokenExtractionDoc(extraction)], '2026-07')

    expect(firstRow(m, 'expense').extractionMethod).toBe('')
  })

  it('reads a blank method inside a well-formed extraction block as no method', () => {
    const m = buildManifest([brokenExtractionDoc({ method: '   ', confidence: 'low', model: null })], '2026-07')

    expect(firstRow(m, 'expense').extractionMethod).toBe('')
  })

  it('never substitutes "manual" for a method it could not read', () => {
    const m = buildManifest([brokenExtractionDoc(null)], '2026-07')

    expect(firstRow(m, 'expense').extractionMethod).not.toBe('manual')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — an amount whose currency was not read
// ═══════════════════════════════════════════════════════════════════════════

describe('an amount with no currency is not a read amount', () => {
  // manifest.ts:174 and :125 — the `valuta` noun and its feminine agreement.
  // No frozen case produces a document with a figure but no currency: the
  // noAmount() fixture clears both at once, so the one-noun feminine phrase and
  // the `else if` that pushes it were both unreachable from the frozen suite.
  it('warns that the currency was not read, with feminine agreement', () => {
    const m = buildManifest([doc({ filename: 'no-ccy.pdf', currency: null })], '2026-07')

    expect(firstRow(m, 'expense').warning).toBe('valuta nije pročitana')
  })

  it('lists that document once in the manifest warnings, named by file', () => {
    const m = buildManifest([doc({ filename: 'no-ccy.pdf', currency: null })], '2026-07')

    expect(m.warnings).toEqual(['no-ccy.pdf: valuta nije pročitana'])
  })

  it('says "nije pročitana", not the masculine "nije pročitan"', () => {
    // valuta is feminine; datum, dobavljač and iznos are masculine. The frozen
    // suite only ever reaches the masculine arm of that agreement.
    const m = buildManifest([doc({ currency: null })], '2026-07')

    expect(firstRow(m, 'expense').warning).not.toBe('valuta nije pročitan')
  })

  it('keeps the figure on the row — it is unread currency, not an unread amount', () => {
    const m = buildManifest([doc({ currency: null })], '2026-07')

    expect(firstRow(m, 'expense')).toMatchObject({ amount: 4210, currency: null })
  })

  // manifest.ts:240 — `item.row.currency ?? \` unread:${index}\``. This is the
  // measured hole the source comment describes: mapping a null currency to a
  // shared '' made every currency-less row share one key, so a group where no
  // row read a currency had a currency set of size 1 and the mixed-currency
  // guard did not fire.
  it('refuses to total two documents whose currencies were both unread', () => {
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', docDate: '2026-07-01', amountTotal: 100, currency: null }),
        doc({ filename: 'b.pdf', docDate: '2026-07-02', amountTotal: 6000, currency: null }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).toBeNull()
  })

  it('publishes no 6.100,00 for those two documents — the unit is unknown', () => {
    // The exact number the source comment records as having been published for
    // what was really ~17,720 RSD. An unread currency is its own distinct kind,
    // not a shared blank.
    const m = buildManifest(
      [
        doc({ filename: 'a.pdf', docDate: '2026-07-01', amountTotal: 100, currency: null }),
        doc({ filename: 'b.pdf', docDate: '2026-07-02', amountTotal: 6000, currency: null }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').total).not.toBe(6100)
    expect(categoryGroup(m, 'expense').vatTotal).toBeNull()
  })

  it('still totals a single document whose currency was unread — nothing is being added across kinds', () => {
    const m = buildManifest([doc({ amountTotal: 100, currency: null })], '2026-07')

    expect(categoryGroup(m, 'expense').total).toBe(100)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — a category this module does not know
// ═══════════════════════════════════════════════════════════════════════════

describe('a category outside the union is filed in OSTALO and says so', () => {
  // manifest.ts:318 (`known ? declared : 'other'`) and :179 (the note). A
  // document is never silently dropped for being unrecognisable (§5).
  it('files an unknown category under "other" rather than dropping the document', () => {
    const m = buildManifest([strangeCategoryDoc('kvitanca', { filename: 'k.pdf' })], '2026-07')

    expect(m.groups.map((g) => g.category)).toEqual(['other'])
    expect(m.totalDocuments).toBe(1)
  })

  it('warns that the category was not recognised', () => {
    const m = buildManifest([strangeCategoryDoc('kvitanca', { filename: 'k.pdf' })], '2026-07')

    expect(firstRow(m, 'other').warning).toBe('nepoznata kategorija, svrstano u OSTALO')
    expect(m.warnings).toEqual(['k.pdf: nepoznata kategorija, svrstano u OSTALO'])
  })

  it('rewrites the row category to "other" as well, so the CSV agrees with the group', () => {
    const m = buildManifest([strangeCategoryDoc('kvitanca', { filename: 'k.pdf' })], '2026-07')

    expect(firstRow(m, 'other').category).toBe('other')
  })

  it.each([['__proto__'], ['constructor'], ['toString'], ['']])(
    'treats the prototype-shaped category %s as unknown, not as a known one',
    (category) => {
      const m = buildManifest([strangeCategoryDoc(category, { filename: 'p.pdf' })], '2026-07')

      expect(m.groups.map((g) => g.category)).toEqual(['other'])
      expect(firstRow(m, 'other').warning).toBe('nepoznata kategorija, svrstano u OSTALO')
    },
  )

  it('still expects an amount from an unknown category, so unread money is warned about too', () => {
    const m = buildManifest(
      [strangeCategoryDoc('kvitanca', { filename: 'k.pdf', amountTotal: null, currency: null })],
      '2026-07',
    )

    expect(firstRow(m, 'other').warning).toBe(
      'iznos nije pročitan; nepoznata kategorija, svrstano u OSTALO',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — sort order when a date is missing
// ═══════════════════════════════════════════════════════════════════════════

describe('a document with no date sorts last from either input order', () => {
  // manifest.ts:216 — `if (a.row.date === null) return 1`. Which arm of byDate
  // runs depends on which element V8's insertion sort makes the pivot, so the
  // frozen suite's single input order only ever reached the `b === null` arm.
  // Both orders are asserted here; neither may drop the undated document.
  it('sorts an undated document last when it arrives second', () => {
    const m = buildManifest(
      [
        doc({ filename: 'jul-01.pdf', docDate: '2026-07-01' }),
        doc({ filename: 'undated.pdf', docDate: null }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual([
      'jul-01.pdf',
      'undated.pdf',
    ])
  })

  it('sorts an undated document last when it arrives first', () => {
    const m = buildManifest(
      [
        doc({ filename: 'undated.pdf', docDate: null }),
        doc({ filename: 'jul-01.pdf', docDate: '2026-07-01' }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual([
      'jul-01.pdf',
      'undated.pdf',
    ])
  })

  it('sorts an undated document last when it arrives in the middle', () => {
    const m = buildManifest(
      [
        doc({ filename: 'jul-02.pdf', docDate: '2026-07-02' }),
        doc({ filename: 'undated.pdf', docDate: null }),
        doc({ filename: 'jul-01.pdf', docDate: '2026-07-01' }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual([
      'jul-01.pdf',
      'jul-02.pdf',
      'undated.pdf',
    ])
  })

  it('keeps two undated documents in the order they arrived', () => {
    const m = buildManifest(
      [
        doc({ filename: 'first.pdf', docDate: null }),
        doc({ filename: 'second.pdf', docDate: null }),
      ],
      '2026-07',
    )

    expect(categoryGroup(m, 'expense').rows.map((r) => r.filename)).toEqual([
      'first.pdf',
      'second.pdf',
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — buildManifest's refusals
// ═══════════════════════════════════════════════════════════════════════════

describe('buildManifest refuses a period it cannot recognise', () => {
  // manifest.ts:294. An unrecognised period matches no document and would mail
  // an empty package to the accountant with a straight face.
  it.each([
    ['2026-13'],
    ['2026-00'],
    ['2026-7'],
    ['26-07'],
    ['2026-07-01'],
    [''],
    ['not-a-period'],
  ])('refuses the period %s', (period) => {
    expectRejects(() => buildManifest([doc()], period))
  })

  it('names the offending period in the message', () => {
    expect(() => buildManifest([doc()], '2026-13')).toThrow(/2026-13/)
    expect(() => buildManifest([doc()], '2026-13')).toThrow(/YYYY-MM/)
  })

  it('refuses a period that is not a string at all', () => {
    // Runtime boundary: the period reaches this function from a command parse,
    // so the cast reproduces the input the `typeof` half of the guard is for.
    expectRejects(() => buildManifest([doc()], 42 as unknown as string))
    expectRejects(() => buildManifest([doc()], null as unknown as string))
    expectRejects(() => buildManifest([doc()], undefined as unknown as string))
  })

  it('accepts every real month, so the refusal is not simply blanket', () => {
    for (const month of ['01', '02', '06', '09', '10', '11', '12']) {
      expect(buildManifest([], `2026-${month}`).period).toBe(`2026-${month}`)
    }
  })
})

describe('buildManifest refuses a document that is not a record of facts', () => {
  // manifest.ts:304. Refusing beats both alternatives: skipping it would be the
  // silent omission this module exists to prevent, and inventing a row would
  // put a document in the accountant's count that does not exist.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'omv.pdf'],
    ['a number', 7],
    ['an array', []],
    ['a boolean', true],
  ])('refuses a document that is %s', (_label, entry) => {
    // Runtime boundary: docs are parsed from sidecar JSON, which is exactly
    // where a non-record can appear inside a well-typed array.
    expectRejects(() => buildManifest([entry] as unknown as DocumentFacts[], '2026-07'))
  })

  it('refuses rather than quietly shortening the list', () => {
    expect(() =>
      buildManifest([doc(), null] as unknown as DocumentFacts[], '2026-07'),
    ).toThrow(/not a record of facts/)
  })

  // manifest.ts:301 — `Array.isArray(docs) ? docs : []`.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['a string', 'omv.pdf'],
  ])('builds an empty manifest when docs is %s rather than crashing', (_label, docs) => {
    // Runtime boundary: the same sidecar read that can hand over a bad entry can
    // hand over something that is not a list at all.
    const m = buildManifest(docs as unknown as DocumentFacts[], '2026-07')

    expect(m).toEqual({ period: '2026-07', groups: [], totalDocuments: 0, warnings: [] })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manifest.ts — manifestToCsv against a malformed manifest
// ═══════════════════════════════════════════════════════════════════════════

describe('manifestToCsv survives a manifest whose shape is wrong', () => {
  const HEADER = 'category,date,vendor,amount,currency,filename,extraction_method,warning'

  // manifest.ts:402 — `Array.isArray(manifest.groups) ? manifest.groups : []`.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('writes a header-only CSV when groups is %s', (_label, groups) => {
    // Runtime boundary: a manifest can be round-tripped through JSON before it
    // reaches the writer, which is why the writer re-checks the shape.
    const csv = manifestToCsv({ ...manifest(), groups } as unknown as Manifest)

    expect(csvRecords(csv)).toEqual([HEADER])
  })

  // manifest.ts:404 — `Array.isArray(group.rows) ? group.rows : []`.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('writes no records for a group whose rows is %s', (_label, rows) => {
    const csv = manifestToCsv(only({ ...group({ category: 'expense' }), rows } as unknown as ManifestGroup))

    expect(csvRecords(csv)).toEqual([HEADER])
  })

  it('still writes the good group when only one group is malformed', () => {
    const broken = { ...group({ category: 'izvod' }), rows: null } as unknown as ManifestGroup
    const csv = manifestToCsv(
      manifest({ groups: [broken, groupOf([row({ filename: 'omv.pdf' })])], totalDocuments: 1 }),
    )

    expect(csvRecords(csv)).toHaveLength(2)
    expect(csvRecords(csv)[1]).toContain('omv.pdf')
  })

  // manifest.ts:416 — `String(field ?? '')`. The nullable columns are already
  // defaulted upstream of that map, so this reaches it through the three
  // columns typed non-null: category, filename and extraction_method.
  it.each<[string, Partial<Record<'category' | 'filename' | 'extractionMethod', null>>, number]>([
    ['category', { category: null }, 0],
    ['filename', { filename: null }, 5],
    ['extraction_method', { extractionMethod: null }, 6],
  ])('writes an empty %s cell rather than the literal text "null"', (_label, over, column) => {
    // Runtime boundary: a JSON round-trip can null a field the type says is a
    // string, and "null" in an accountant's imported spreadsheet is worse than
    // a blank because it looks like data.
    const csv = manifestToCsv(only(groupOf([{ ...row(), ...over } as unknown as ManifestRow])))
    const record = csvRecords(csv)[1] ?? ''

    expect(record.split(',')[column]).toBe('')
    expect(record).not.toContain('null')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — periodLabel's non-string refusal
// ═══════════════════════════════════════════════════════════════════════════

describe('periodLabel refuses a period that is not a string', () => {
  // email-body.ts:85. The label is printed in the subject line and in the first
  // sentence of the body, so a period this function could not read must stop
  // the send rather than produce "undefined 2026".
  it.each<[string, unknown]>([
    ['a number', 202607],
    ['null', null],
    ['undefined', undefined],
    ['an object', { period: '2026-07' }],
    ['an array', ['2026-07']],
  ])('refuses a period that is %s', (_label, period) => {
    // Runtime boundary: the cast is what lets the non-string arm of the guard
    // be reached at all.
    expectRejects(() => periodLabel(period as unknown as string))
  })

  it('says the period must be a YYYY-MM string', () => {
    expect(() => periodLabel(202607 as unknown as string)).toThrow(/"YYYY-MM" string/)
  })

  it('never labels a non-string as a month', () => {
    // Written as a collected outcome rather than a try/continue loop: a loop that
    // `continue`s on throw asserts NOTHING when every case throws, which is the
    // correct case — the test could not fail. This shape fails if any input is
    // labelled instead of refused.
    const outcomes = [null, undefined, 202607, {}].map((bad) => {
      try {
        return { refused: false, text: periodLabel(bad as unknown as string) }
      } catch (e) {
        return { refused: true, text: e instanceof Error ? e.message : String(e) }
      }
    })

    expect(outcomes.map((o) => o.refused)).toEqual([true, true, true, true])
    for (const outcome of outcomes) {
      expect(outcome.text).not.toMatch(/undefined \d{4}/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — the heading unit when no row said what currency it was in
// ═══════════════════════════════════════════════════════════════════════════

describe('a group total with no currency prints no unit', () => {
  // email-body.ts:154 (`currenciesOf(rows)[0] ?? null`) and :177 (the empty
  // unit). Defaulting to RSD there would print a figure that could be euros as
  // dinars — the one mistake in this file nobody downstream would catch.
  const unpricedTotal = only(
    groupOf(
      [row({ amount: 4210, currency: null, warning: 'valuta nije pročitana' })],
      { total: 4210, vatTotal: null },
    ),
  )

  it('prints the total with no currency at all', () => {
    const heading = linesOf(buildEmailBody(bodyInput({ manifest: unpricedTotal })))[4]

    expect(heading).toBe('TROŠKOVI (1) — 4.210,00')
  })

  it('does not guess RSD for a figure whose currency was not read', () => {
    const body = buildEmailBody(bodyInput({ manifest: unpricedTotal }))
    const heading = linesOf(body)[4] ?? ''

    // Anchored to the END OF THE HEADING LINE, deliberately. An earlier draft
    // asserted `not.toMatch(/— 4\.210,00\s+\S/)` against the whole body: `\s`
    // matches a newline, so it ran past the heading onto the ⚠ row below and
    // went red on output that was in fact correct. Never let a body-wide regex
    // cross a line boundary — match a single line, or use [^\S\n].
    expect(heading).toMatch(/— 4\.210,00$/)
    expect(body).not.toContain('4.210,00 RSD')
  })

  // email-body.ts:159 — isPriced's second and third operands. Every frozen
  // warned row has `amount: null`, so `typeof row.amount === 'number'` short
  // circuits and neither Number.isFinite nor the currency check is ever
  // evaluated on the closing-note path.
  it('counts that document as being without a read amount', () => {
    const body = buildEmailBody(bodyInput({ manifest: unpricedTotal }))

    expect(collapse(body)).toContain(
      'Napomena: 1 dokument bez pročitanog iznosa (obeležen ⚠ i u manifest.csv).',
    )
  })

  it('does not count it as merely flagged for review', () => {
    const body = buildEmailBody(bodyInput({ manifest: unpricedTotal }))

    expect(body).not.toContain('za proveru')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — the "za proveru" closing note
// ═══════════════════════════════════════════════════════════════════════════

describe('a warned document whose money WAS read is counted separately', () => {
  // email-body.ts:289. The split exists so the printed count can never describe
  // a set the reader cannot count on the page: "bez pročitanog iznosa" counts
  // exactly the ⚠ lines that show no money, and everything else warned about is
  // counted in its own sentence.
  const flaggedOnly = only(
    groupOf(
      [row({ amount: 4210, currency: 'RSD', warning: 'označeno za proveru' })],
      { total: 4210, vatTotal: null },
    ),
  )

  it('prints the "za proveru" note', () => {
    expect(collapse(buildEmailBody(bodyInput({ manifest: flaggedOnly })))).toContain(
      'Napomena: 1 dokument za proveru (obeležen ⚠ i u manifest.csv).',
    )
  })

  it('does not claim its amount was unread', () => {
    expect(buildEmailBody(bodyInput({ manifest: flaggedOnly }))).not.toContain('bez pročitanog iznosa')
  })

  it('prints both notes, separately, when a month has one of each', () => {
    const both = only(
      groupOf(
        [
          row({ date: '2026-07-02', amount: 4210, currency: 'RSD', filename: 'a.pdf', warning: 'označeno za proveru' }),
          row({ date: '2026-07-03', amount: null, currency: null, filename: 'b.pdf', warning: 'iznos nije pročitan' }),
        ],
        { total: null, vatTotal: null },
      ),
    )
    const notes = linesOf(buildEmailBody(bodyInput({ manifest: both }))).filter((l) =>
      l.startsWith('Napomena:'),
    )

    expect(notes).toEqual([
      'Napomena: 1 dokument bez pročitanog iznosa (obeležen ⚠ i u manifest.csv).',
      'Napomena: 1 dokument za proveru (obeležen ⚠ i u manifest.csv).',
    ])
  })

  it('prints neither note for a month with nothing warned about', () => {
    const clean = only(groupOf([row()], { total: 4210, vatTotal: 701.67 }))

    expect(buildEmailBody(bodyInput({ manifest: clean }))).not.toContain('Napomena:')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — Serbian agreement above four
// ═══════════════════════════════════════════════════════════════════════════

describe('the closing note agrees with counts of five and above', () => {
  // email-body.ts:122 — markedAdjective's `obeleženih` arm. The frozen golden
  // uses a count of 2 ("obeležena"), so the plural-genitive participle every
  // count of 5 and up needs was never rendered.
  const unread = (n: number): Manifest => {
    const rows = Array.from({ length: n }, (_, i) =>
      row({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        amount: null,
        currency: null,
        filename: `blurry-${String(i + 1)}.jpg`,
        extractionMethod: 'llm_vision',
        warning: 'iznos nije pročitan',
      }),
    )
    return only(groupOf(rows, { total: null, vatTotal: null }))
  }

  it.each<[number, string, string]>([
    [1, 'dokument', 'obeležen'],
    [2, 'dokumenta', 'obeležena'],
    [4, 'dokumenta', 'obeležena'],
    [5, 'dokumenata', 'obeleženih'],
    [7, 'dokumenata', 'obeleženih'],
    [11, 'dokumenata', 'obeleženih'],
    [12, 'dokumenata', 'obeleženih'],
    [21, 'dokument', 'obeležen'],
    [22, 'dokumenta', 'obeležena'],
  ])('renders %i as "%s" with the participle "%s"', (n, noun, adjective) => {
    const note = linesOf(buildEmailBody(bodyInput({ manifest: unread(n) }))).find((l) =>
      l.startsWith('Napomena:'),
    )

    expect(note).toBe(
      `Napomena: ${String(n)} ${noun} bez pročitanog iznosa (${adjective} ⚠ i u manifest.csv).`,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — per-row currency in a section that mixes them
// ═══════════════════════════════════════════════════════════════════════════

describe('a section that mixes currencies prints the unit on every row', () => {
  // email-body.ts:223. The frozen body cases are all single-currency, so
  // showCurrency was never true and the per-row unit was never rendered. A bare
  // 4.210,00 next to a 300,00 that is euros is the failure mode.
  const mixed = only(
    groupOf(
      [
        row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, currency: 'RSD', filename: 'omv.pdf' }),
        row({ date: '2026-07-03', vendor: 'Hetzner', amount: 300, currency: 'EUR', filename: 'hetzner.pdf' }),
      ],
      { total: null, vatTotal: null },
    ),
  )

  it('prints each row with its own currency', () => {
    const lines = linesOf(buildEmailBody(bodyInput({ manifest: mixed })))

    expect(lines).toContain('  2026-07-02 OMV Srbija 4.210,00 RSD')
    expect(lines).toContain('  2026-07-03 Hetzner 300,00 EUR')
  })

  it('publishes no total for the mixed section', () => {
    expect(linesOf(buildEmailBody(bodyInput({ manifest: mixed })))[4]).toBe('TROŠKOVI (2)')
  })

  it('leaves the amount bare on a row whose own currency was not read', () => {
    const withUnread = only(
      groupOf(
        [
          row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, currency: 'RSD', filename: 'omv.pdf' }),
          row({ date: '2026-07-03', vendor: 'Hetzner', amount: 300, currency: 'EUR', filename: 'hetzner.pdf' }),
          row({ date: '2026-07-04', vendor: 'Nepoznat', amount: 50, currency: null, filename: 'x.pdf' }),
        ],
        { total: null, vatTotal: null },
      ),
    )
    const lines = linesOf(buildEmailBody(bodyInput({ manifest: withUnread })))

    expect(lines).toContain('  2026-07-04 Nepoznat 50,00')
  })

  it('omits the per-row unit when the section is single-currency', () => {
    const single = only(
      groupOf(
        [row({ date: '2026-07-02', vendor: 'OMV Srbija', amount: 4210, currency: 'RSD', filename: 'omv.pdf' })],
        { total: 4210, vatTotal: null },
      ),
    )
    const lines = linesOf(buildEmailBody(bodyInput({ manifest: single })))

    expect(lines).toContain('  2026-07-02 OMV Srbija 4.210,00')
    expect(lines).toContain('TROŠKOVI (1) — 4.210,00 RSD')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// email-body.ts — a manifest whose shape is wrong
// ═══════════════════════════════════════════════════════════════════════════

describe('buildEmailBody survives a manifest whose shape is wrong', () => {
  // email-body.ts:252 — `Array.isArray(manifest.groups) ? manifest.groups : []`.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('renders a section-less body when groups is %s', (_label, groups) => {
    // Runtime boundary: without the guard this is a TypeError inside the send
    // path, which loses a message that is otherwise fine.
    const body = buildEmailBody(
      bodyInput({ manifest: { ...manifest(), groups } as unknown as Manifest }),
    )

    expect(linesOf(body)).toEqual([
      'Zdravo,',
      '',
      'u prilogu je dokumentacija za DILIGAF DOO, jul 2026.',
      '',
      'Ukupno u prilogu: 0 dokumenata.',
      '',
      'E',
    ])
  })

  // email-body.ts:135 — rowsOf's `Array.isArray(group.rows) ? group.rows : []`.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('renders the heading but no lines when a group\'s rows is %s', (_label, rows) => {
    const broken = { ...group({ category: 'expense' }), rows } as unknown as ManifestGroup
    const lines = linesOf(
      buildEmailBody(bodyInput({ manifest: manifest({ groups: [broken], totalDocuments: 0 }) })),
    )

    expect(lines).toContain('TROŠKOVI (0)')
    expect(lines).toEqual([
      'Zdravo,',
      '',
      'u prilogu je dokumentacija za DILIGAF DOO, jul 2026.',
      '',
      'TROŠKOVI (0)',
      '',
      'Ukupno u prilogu: 0 dokumenata.',
      '',
      'E',
    ])
  })

  // email-body.ts:271 — the `rows.length` fallback for totalDocuments.
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '2'],
  ])('counts the rows it can see when totalDocuments is %s', (_label, totalDocuments) => {
    const m = {
      ...manifest({
        groups: [
          groupOf(
            [
              row({ date: '2026-07-02', filename: 'a.pdf' }),
              row({ date: '2026-07-03', filename: 'b.pdf' }),
            ],
            { total: 8420, vatTotal: null },
          ),
        ],
      }),
      totalDocuments,
    } as unknown as Manifest

    expect(collapse(buildEmailBody(bodyInput({ manifest: m })))).toContain(
      'Ukupno u prilogu: 2 dokumenta.',
    )
  })

  it('prints no "null" or "NaN" where the document count belongs', () => {
    for (const totalDocuments of [null, undefined, Number.NaN]) {
      const m = {
        ...manifest({ groups: [groupOf([row()], { total: 4210, vatTotal: null })] }),
        totalDocuments,
      } as unknown as Manifest
      const body = buildEmailBody(bodyInput({ manifest: m }))

      expect(body).not.toMatch(/Ukupno u prilogu: (null|undefined|NaN)/)
    }
  })

  // email-body.ts:168 — the `?? String(group.category).toUpperCase()` heading
  // fallback. buildManifest maps an unknown category to 'other', so this arm is
  // only reachable through a manifest that did not come from buildManifest.
  it.each([
    ['kvitanca', 'KVITANCA'],
    ['ugovor', 'UGOVOR'],
  ])('falls back to an uppercased heading for the unknown category %s', (category, heading) => {
    // Runtime boundary: buildEmailBody takes a Manifest from anywhere, and
    // "undefined (1)" in an accountant's inbox is the alternative.
    const strange = {
      ...groupOf([row({ vendor: 'Neko', amount: null, currency: null })], { total: null, vatTotal: null }),
      category,
    } as unknown as ManifestGroup

    expect(linesOf(buildEmailBody(bodyInput({ manifest: only(strange) })))[4]).toBe(`${heading} (1)`)
  })

  it('renders a known category through its §5 heading, not through the fallback', () => {
    // The assertion that stops a mutant which deletes the lookup entirely: the
    // fallback would render "EXPENSE" here instead of "TROŠKOVI".
    const lines = linesOf(
      buildEmailBody(bodyInput({ manifest: only(groupOf([row()], { total: 4210, vatTotal: null })) })),
    )

    expect(lines[4]).toBe('TROŠKOVI (1) — 4.210,00 RSD')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// JUDGED UNREACHABLE — deliberately NOT tested.
//
// Four branches in these two files cannot be reached by any input through the
// public API. A test for one of them could not fail, and a test that cannot
// fail is worse than no test: it reports coverage it did not earn. They are
// listed here so the next person does not spend the afternoon rediscovering it.
//
//  1. manifest.ts:122 — `unreadPhrase`'s `if (first === undefined) return ''`.
//     `unreadPhrase` has exactly one call site, manifest.ts:177, and it is
//     guarded by `if (unread.length > 0)`. `nouns[0]` is therefore always
//     present. The check exists to satisfy noUncheckedIndexedAccess.
//
//  2. manifest.ts:128 — `nouns[nouns.length - 1] ?? ''`. Control reaches that
//     line only after `nouns.length === 1` returned and `nouns[0] === undefined`
//     returned, so length is at least 2 and the last element is always present.
//     Same noUncheckedIndexedAccess origin.
//
//  3. manifest.ts:181 — `notes.length === 0 ? null : ...`. Reaching line 181
//     requires `unreadMoney || flagged || !knownCategory` (the early return at
//     :168). `flagged` pushes 'označeno za proveru'; `!knownCategory` pushes the
//     category note; and `unreadMoney` is `expectAmount && !isPriced`, which
//     means `amount === null` (so :173 pushes 'iznos') or `amount !== null &&
//     currency === null` (so :174 pushes 'valuta'). Every path that reaches the
//     line has therefore already pushed a note, so `notes` is never empty there.
//
//  4. email-body.ts:94 — `match[1] ?? ''`. `match` comes from
//     `/^(\d{4})-(\d{2})$/.exec(period)` and is null-checked at :88. Group 1 is
//     not optional and has no alternation, so on a successful match it always
//     participates. Same noUncheckedIndexedAccess origin.
//
// All four are the same shape: a guard that the type system demands and the
// control flow makes impossible. None is a bug, and none should be deleted —
// removing them would trade a dead branch for an unchecked index.
// ─────────────────────────────────────────────────────────────────────────────
