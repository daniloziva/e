import { describe, it, expect } from 'vitest'
import {
  blobPathFor,
  parseBlobPath,
  slugify,
  slugifyOrNull,
  PLACEHOLDER_SLUG,
  type BlobPathInput,
} from '../../src/engine/documents/blob-path.js'
import type { DocCategory } from '../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// GUARDS NO FROZEN CASE EXERCISES — new tests for new behaviour.
//
// TEST-FREEZE.md permits "adding tests for new behaviour that no test covers".
// Nothing frozen is touched: documents.test.ts pins the happy path of
// blobPathFor/slugify and slug-recovery.test.ts pins Serbian Cyrillic and the
// PLACEHOLDER_SLUG seam. Neither ever reaches:
//
//   1. `requireShape`'s refusal (blob-path.ts:119-126). Every frozen case feeds
//      a well-formed period/prefix/category/digest/extension/docDate, so the
//      whole reason the guard exists — a document written where no monthly
//      prefix listing will ever look — is asserted nowhere. Deleting any one of
//      the six `requireShape` calls leaves the frozen suite green.
//
//   2. The `?? '-'` fallback in the Cyrillic step (blob-path.ts:164). The frozen
//      Cyrillic cases all use letters the table maps. A letter OUTSIDE it
//      (тврди знак, Russian-only letters) takes the separator path, which the
//      table's own comment promises and no case checked.
//
// Both were found by reading v8 branch counts, then confirmed by mutation:
// each assertion below was watched to fail against a deliberately broken
// implementation before it was kept.
//
// THE OTHER THREE UNCOVERED BRANCHES ARE UNREACHABLE, and no test here pretends
// otherwise. All three exist only to satisfy `noUncheckedIndexedAccess`:
//
//   * `blob-path.ts:157` — `STROKE_FOLDINGS[character] ?? '-'`. The regex class
//     `[đĐðÐłŁøØ]` is character-for-character the table's key set, so a matched
//     character always has an entry and the `?? '-'` cannot be taken.
//   * `blob-path.ts:203-205` — the `undefined` check on parseBlobPath's capture
//     groups. All five groups in DOCUMENT_PATH are mandatory (the only optional
//     part, `(?:-[a-z0-9]+)*`, is non-capturing), so a successful `exec` never
//     yields an undefined group.
//   * `fingerprint.ts:112` — the `?? ''` after `mimeType.split(';')[0]?.…`.
//     `String.prototype.split` always returns at least one element, so `[0]` is
//     never undefined and the optional chain never short-circuits.
//
// Do not add tests for those three. A test that cannot fail is worse than none.
// ─────────────────────────────────────────────────────────────────────────────

const SHA = '91be0d47a1c9f3e25b8d4470ac6f1e93d2b7c05a8e14f36092ad7bc4e5f10983'

const OMV: BlobPathInput = {
  blobPrefix: 'diligaf',
  period: '2026-08',
  category: 'expense',
  docDate: '2026-08-11',
  slugSource: 'OMV Srbija',
  sha256: SHA,
  extension: 'jpg',
}

const input = (patch: Partial<BlobPathInput> = {}): BlobPathInput => ({ ...OMV, ...patch })

/**
 * Feed a deliberately malformed field to the validator. The cast IS the point:
 * these values arrive from outside the type system — `docDate` off a document,
 * `extension` out of a MIME `filename=` parameter, `period` out of a stored
 * queue item — so the runtime check is the only thing standing between them and
 * a blob key. Widening to `unknown` first because some cases are not even
 * strings, which is exactly the case the `typeof` half of the guard covers.
 */
const malformed = (patch: Record<string, unknown>): BlobPathInput =>
  ({ ...OMV, ...patch }) as unknown as BlobPathInput

// ─────────────────────────────────────────────────────────────────────────────
// blobPathFor refuses to write a document nobody can list again
// ─────────────────────────────────────────────────────────────────────────────

describe('blobPathFor shape refusals', () => {
  it.each([
    // ── period: the field that decides which monthly listing finds the file ──
    { field: 'period', label: 'an unpadded month', patch: { period: '2026-7' } },
    { field: 'period', label: 'month 13', patch: { period: '2026-13' } },
    { field: 'period', label: 'month 00', patch: { period: '2026-00' } },
    { field: 'period', label: 'no separator', patch: { period: '202608' } },
    { field: 'period', label: 'a full ISO day', patch: { period: '2026-08-11' } },
    { field: 'period', label: 'an empty string', patch: { period: '' } },
    { field: 'period', label: 'a two-digit year', patch: { period: '26-08' } },
    { field: 'period', label: 'a traversal attempt', patch: { period: '../07' } },
    // ── blobPrefix: the root of the listing ─────────────────────────────────
    { field: 'blobPrefix', label: 'uppercase', patch: { blobPrefix: 'DILIGAF' } },
    { field: 'blobPrefix', label: 'an embedded slash', patch: { blobPrefix: 'diligaf/2025' } },
    { field: 'blobPrefix', label: 'a space', patch: { blobPrefix: 'dili gaf' } },
    { field: 'blobPrefix', label: 'an empty string', patch: { blobPrefix: '' } },
    // ── category: the folder inside the month ───────────────────────────────
    // Not reachable through DocCategory — all six members are [a-z_]+ — so the
    // cast stands in for a category read back off a sidecar or a queue payload.
    { field: 'category', label: 'uppercase', patch: { category: 'Expense' } },
    { field: 'category', label: 'a hyphen', patch: { category: 'invoice-out' } },
    { field: 'category', label: 'an empty string', patch: { category: '' } },
    // ── sha256: the document's identity, and the filename's tail ────────────
    { field: 'sha256', label: 'fewer than eight characters', patch: { sha256: '91be0d4' } },
    { field: 'sha256', label: 'non-hex characters', patch: { sha256: 'zzzzzzzzzz' } },
    { field: 'sha256', label: 'an empty string', patch: { sha256: '' } },
    // ── extension: arrives from a MIME filename= parameter ──────────────────
    { field: 'extension', label: 'a space', patch: { extension: 'jp g' } },
    { field: 'extension', label: 'a leading dot', patch: { extension: '.jpg' } },
    { field: 'extension', label: 'an empty string', patch: { extension: '' } },
    // ── docDate: arrives from the document itself ───────────────────────────
    { field: 'docDate', label: 'an unpadded day', patch: { docDate: '2026-8-11' } },
    { field: 'docDate', label: 'Serbian dotted order', patch: { docDate: '11.08.2026' } },
    { field: 'docDate', label: 'a year and month only', patch: { docDate: '2026-08' } },
    { field: 'docDate', label: 'an empty string', patch: { docDate: '' } },
  ])('refuses $field when it is $label', ({ field, patch }) => {
    expect(() => blobPathFor(malformed(patch))).toThrow(
      new RegExp(`${field} is not a usable path segment`),
    )
  })

  it('names the offending value in the message, so the caller can see what it sent', () => {
    expect(() => blobPathFor(malformed({ period: '2026-7' }))).toThrow(/"2026-7"/)
  })

  it('says why it refused rather than just that it refused', () => {
    expect(() => blobPathFor(malformed({ period: '2026-7' }))).toThrow(
      /refusing to write a document where no listing will find it/,
    )
  })

  it('refuses before writing anything — no path is returned for a bad period', () => {
    // The failure mode this guard exists for: '2026-7' lands in
    // `diligaf/2026/7/…`, which the monthly package's prefix listing on
    // `diligaf/2026/07/` never sees, and which parseBlobPath cannot read back.
    // Stored, indexed, sidecar'd and invisible.
    expect(parseBlobPath('diligaf/2026/7/expense/2026-07-31--omv-srbija--91be0d47.jpg')).toBeNull()
    expect(() => blobPathFor(malformed({ period: '2026-7' }))).toThrow(/period/)
  })

  it('refuses a period that only looks right after coercion', () => {
    // A non-string whose toString() satisfies PERIOD_SHAPE: `shape.test(value)`
    // would coerce it and pass, so the `typeof value !== 'string'` half is the
    // only thing that catches it. `${value}` would then interpolate an object
    // into a blob key. The cast is the point — this is a runtime boundary.
    const periodLikeObject: unknown = { toString: () => '2026-08' }
    expect(() => blobPathFor(malformed({ period: periodLikeObject }))).toThrow(
      /period is not a usable path segment/,
    )
  })

  it('checks the period before anything else, so the first bad field is the one reported', () => {
    expect(() => blobPathFor(malformed({ period: '2026-7', blobPrefix: 'DILIGAF' }))).toThrow(
      /period is not a usable path segment/,
    )
  })
})

// ── the guards must not over-refuse ─────────────────────────────────────────
//
// A refusal test alone is satisfied by a guard that rejects everything. These
// pin the accepting side of each shape.

describe('blobPathFor accepts every legitimate field', () => {
  it.each(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])(
    'accepts month %s',
    (mm) => {
      const path = blobPathFor(input({ period: `2026-${mm}`, docDate: null }))
      expect(path).toBe(`diligaf/2026/${mm}/expense/2026-${mm}-01--omv-srbija--91be0d47.jpg`)
      expect(parseBlobPath(path)?.period).toBe(`2026-${mm}`)
    },
  )

  it.each<DocCategory>(['izvod', 'statement', 'expense', 'invoice_out', 'sef_inbound', 'other'])(
    'accepts the %s category, including the underscored ones',
    (category) => {
      expect(() => blobPathFor(input({ category }))).not.toThrow()
    },
  )

  it('accepts a docDate outside the period — the guard checks shape, not range', () => {
    expect(blobPathFor(input({ period: '2026-08', docDate: '2025-12-31' }))).toBe(
      'diligaf/2026/08/expense/2025-12-31--omv-srbija--91be0d47.jpg',
    )
  })

  it('accepts a null docDate and dates the file on the first of the period', () => {
    expect(blobPathFor(input({ docDate: null }))).toBe(
      'diligaf/2026/08/expense/2026-08-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('accepts an uppercase extension and an uppercase digest, lowercasing both', () => {
    expect(blobPathFor(input({ extension: 'PDF', sha256: SHA.toUpperCase() }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.pdf',
    )
  })

  it('accepts a hyphenated blob prefix', () => {
    expect(blobPathFor(input({ blobPrefix: 'smoqua-arhiva' })).startsWith('smoqua-arhiva/')).toBe(
      true,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cyrillic the transliteration table does not map
// ─────────────────────────────────────────────────────────────────────────────

describe('Cyrillic outside CYRILLIC_TO_LATIN', () => {
  it.each([
    // Serbian has no тврди знак / Russian-only vowels, so these letters have no
    // entry and fall through to the separator rule the table's comment names.
    { label: 'я', source: 'Мясо', slug: 'm-so' },
    { label: 'щ', source: 'Кафе Щука', slug: 'kafe-uka' },
    { label: 'ю', source: 'Юг Трејд', slug: 'g-trejd' },
    // `ы` separates, and the following `й` still transliterates: NFD splits it
    // into `и` plus a combining breve, so the slug is `nov-i-dom`, not `nov-dom`.
    { label: 'ы', source: 'Новый Дом', slug: 'nov-i-dom' },
    { label: 'э', source: 'Эра доо', slug: 'ra-doo' },
  ])('turns the unmapped letter $label into one separator ($source)', ({ source, slug }) => {
    expect(slugify(source)).toBe(slug)
  })

  it.each(['ъ', 'ь', 'ы', 'э', 'ю', 'я', 'щ'])(
    'reports null for %s alone, because nothing transliterable is left',
    (letter) => {
      expect(slugifyOrNull(letter)).toBeNull()
      expect(slugify(letter)).toBe(PLACEHOLDER_SLUG)
    },
  )

  it('still produces a parseable path for a name full of unmapped letters', () => {
    const path = blobPathFor(input({ slugSource: 'Щавель ъ ы' }))
    expect(path).toMatch(
      /^[a-z0-9-]+\/\d{4}\/\d{2}\/[a-z_]+\/\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{8}\.[a-z0-9]+$/,
    )
    expect(parseBlobPath(path)).not.toBeNull()
  })

  it('never emits a run of separators, however many letters are unmapped', () => {
    expect(slugify('ыыы Фирма ъъъ')).toBe('firma')
    expect(slugify('Фирма ъъъ доо')).toBe('firma-doo')
  })

  // The reason the fallback is '-' and not ''. With no space to lean on, an
  // unmapped letter is the ONLY thing separating two words; dropping it instead
  // of separating welds them together, so `Фирмаъдоо` would slug as `firmadoo`
  // and collide with a genuinely different vendor of that name.
  it('separates rather than welds when an unmapped letter sits between two mapped ones', () => {
    expect(slugify('Фирмаъдоо')).toBe('firma-doo')
    expect(slugify('абъвг')).toBe('ab-vg')
  })

  // The two letters absent from the table that still transliterate, because NFD
  // decomposes them into a mapped letter plus a combining mark that the earlier
  // step strips. Worth pinning: it looks like a hole in the table and is not.
  it.each([
    { source: 'Сергей', slug: 'sergei' },
    { source: 'Ёлка', slug: 'elka' },
    { source: 'Ѓорѓи', slug: 'gorgi' },
  ])('transliterates $source to $slug via NFD even though the table has no entry', ({
    source,
    slug,
  }) => {
    expect(slugify(source)).toBe(slug)
  })
})
