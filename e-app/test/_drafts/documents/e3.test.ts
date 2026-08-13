import { describe, it, expect } from 'vitest'
import {
  blobPathFor,
  slugify,
  sidecarPath,
  hashIndexPath,
  parseBlobPath,
  type BlobPathInput,
} from '../../../src/core/documents/blob-path.js'
import { fingerprint, extensionFor } from '../../../src/core/documents/fingerprint.js'
import type { BookCode, DocCategory } from '../../../src/core/types.js'

// ── fixtures ──────────────────────────────────────────────────────────────────
// 64-hex digests. The first eight characters are the sha8 that lands in a path.
const SHA_OMV = '91be0d47a1c2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d9'
const SHA_IZVOD = '3f1a9c22112233445566778899aabbccddeeff00112233445566778899aabbcc'
const SHA_FAKTURA = 'c40a1e88aabbccddeeff00112233445566778899aabbccddeeff001122334455'
const SHA_KARTONAZA = 'd19f7b30ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544'

const CATEGORIES: DocCategory[] = [
  'izvod',
  'statement',
  'expense',
  'invoice_out',
  'sef_inbound',
  'other',
]

const OMV: BlobPathInput = {
  blobPrefix: 'diligaf',
  period: '2026-08',
  category: 'expense',
  docDate: '2026-08-11',
  slugSource: 'OMV Srbija',
  sha256: SHA_OMV,
  extension: 'jpg',
}

const input = (patch: Partial<BlobPathInput>): BlobPathInput => ({ ...OMV, ...patch })

/** A well-formed document path: four directory segments, then the filename. */
const PATH_SHAPE = /^[a-z0-9-]+\/\d{4}\/\d{2}\/[a-z_]+\/\d{4}-\d{2}-\d{2}--[a-z0-9-]+--[0-9a-f]{8}\.[a-z0-9]+$/
/** A well-formed slug: lowercase alphanumerics and inner dashes only, never empty. */
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// ── hand-written fakes (no mocking library) ───────────────────────────────────
function fakeSha256(digest: string) {
  const calls: Uint8Array[] = []
  return {
    calls,
    fn: (bytes: Uint8Array): string => {
      calls.push(bytes)
      return digest
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('blobPathFor', () => {
  it('builds the documented path for a receipt photo', () => {
    expect(blobPathFor(OMV)).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    )
  })

  it('falls back to the first day of the period when docDate is null', () => {
    expect(blobPathFor(input({ docDate: null }))).toBe(
      'diligaf/2026/08/expense/2026-08-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the document under the period even when docDate is in the previous month', () => {
    // A 31 July receipt photographed in August, filed to the August period.
    expect(blobPathFor(input({ period: '2026-08', docDate: '2026-07-31' }))).toBe(
      'diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the document under the period even when docDate is in the following month', () => {
    expect(blobPathFor(input({ period: '2026-08', docDate: '2026-09-02' }))).toBe(
      'diligaf/2026/08/expense/2026-09-02--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the document under the period even when docDate is in the previous year', () => {
    expect(blobPathFor(input({ period: '2026-01', docDate: '2025-12-31' }))).toBe(
      'diligaf/2026/01/expense/2025-12-31--omv-srbija--91be0d47.jpg',
    )
  })

  it.each([
    { label: 'docDate equal to the period', period: '2026-08', docDate: '2026-08-11' },
    { label: 'docDate absent', period: '2026-08', docDate: null },
    { label: 'docDate one day before the period', period: '2026-08', docDate: '2026-07-31' },
    { label: 'docDate one day after the period', period: '2026-08', docDate: '2026-09-01' },
    { label: 'docDate a year earlier', period: '2026-01', docDate: '2025-12-31' },
    { label: 'docDate a year later', period: '2025-12', docDate: '2026-01-01' },
    { label: 'docDate months away', period: '2026-03', docDate: '2026-11-09' },
  ])('puts YYYY/MM from the period, not from docDate, when $label', ({ period, docDate }) => {
    const path = blobPathFor(input({ period, docDate }))
    const [, yyyy, mm] = path.split('/')
    expect(`${yyyy}-${mm}`).toBe(period)
  })

  it.each(CATEGORIES)('uses %s verbatim as the category segment', (category) => {
    expect(blobPathFor(input({ category })).split('/')[3]).toBe(category)
  })

  it.each(['diligaf', 'personal', 'smoqua'])('starts the path with the %s blob prefix', (blobPrefix) => {
    expect(blobPathFor(input({ blobPrefix })).startsWith(`${blobPrefix}/`)).toBe(true)
  })

  it.each([
    { period: '2026-01', mm: '01' },
    { period: '2026-02', mm: '02' },
    { period: '2026-09', mm: '09' },
    { period: '2026-10', mm: '10' },
    { period: '2026-12', mm: '12' },
  ])('renders the month of $period as the zero-padded segment $mm', ({ period, mm }) => {
    expect(blobPathFor(input({ period, docDate: null })).split('/')[2]).toBe(mm)
  })

  it('shortens the sha256 to its first eight characters', () => {
    const path = blobPathFor(input({ sha256: SHA_IZVOD }))
    expect(path.endsWith('--3f1a9c22.jpg')).toBe(true)
  })

  it('places the extension last, without a second dot', () => {
    expect(blobPathFor(input({ extension: 'pdf' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.pdf',
    )
  })

  it('slugifies a filename used as the slug source', () => {
    expect(blobPathFor(input({ slugSource: 'IMG_4821.jpg' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--img-4821-jpg--91be0d47.jpg',
    )
  })

  it('separates the date, slug and sha8 with double dashes', () => {
    const filename = blobPathFor(input({ slugSource: 'Izvod 265/08' })).split('/')[4]
    expect(filename).toBe('2026-08-11--izvod-265-08--91be0d47.jpg')
  })

  it('produces exactly four directory segments before the filename', () => {
    expect(blobPathFor(OMV).split('/')).toHaveLength(5)
  })

  it('still produces a well-formed path when the slug source has no usable characters', () => {
    const path = blobPathFor(input({ slugSource: '!!! ??? ...' }))
    expect(path).toMatch(PATH_SHAPE)
    expect(parseBlobPath(path)).not.toBeNull()
  })

  it.each([
    { label: 'a Serbian vendor name', slugSource: 'KARTONAŽA DOO', sha256: SHA_KARTONAZA },
    { label: 'an invoice number', slugSource: 'Faktura 0007/2026', sha256: SHA_FAKTURA },
    { label: 'a very long vendor name', slugSource: 'A'.repeat(120), sha256: SHA_IZVOD },
    { label: 'punctuation only', slugSource: '---', sha256: SHA_OMV },
    { label: 'an empty source', slugSource: '', sha256: SHA_OMV },
  ])('produces a path matching the convention for $label', ({ slugSource, sha256 }) => {
    expect(blobPathFor(input({ slugSource, sha256 }))).toMatch(PATH_SHAPE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('slugify', () => {
  it.each([
    { source: 'Šećer', expected: 'secer' },
    { source: 'Đorđe', expected: 'dorde' },
    { source: 'Živojin', expected: 'zivojin' },
    { source: 'Čačak', expected: 'cacak' },
    { source: 'Ćuprija', expected: 'cuprija' },
    { source: 'KARTONAŽA DOO', expected: 'kartonaza-doo' },
    { source: 'čćžšđ', expected: 'cczsd' },
    { source: 'ČĆŽŠĐ', expected: 'cczsd' },
    { source: 'Preduzeće Bačka', expected: 'preduzece-backa' },
  ])('folds the Serbian diacritics in $source to $expected', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  it.each([
    { label: 'spaces', source: 'OMV Srbija', expected: 'omv-srbija' },
    { label: 'repeated spaces', source: 'OMV    Srbija', expected: 'omv-srbija' },
    { label: 'a slash', source: 'Izvod 265/08', expected: 'izvod-265-08' },
    { label: 'a hash and a slash', source: 'Faktura #0007/2026', expected: 'faktura-0007-2026' },
    { label: 'dots', source: 'd.o.o.', expected: 'd-o-o' },
    { label: 'underscores', source: 'IMG_4821', expected: 'img-4821' },
    { label: 'quotes', source: '"Bačka"', expected: 'backa' },
    { label: 'existing dashes', source: 'omv-srbija', expected: 'omv-srbija' },
    { label: 'runs of dashes', source: 'omv---srbija', expected: 'omv-srbija' },
    { label: 'mixed punctuation runs', source: 'a  --  b', expected: 'a-b' },
    { label: 'leading and trailing punctuation', source: '  ...Trim!!!  ', expected: 'trim' },
    { label: 'tabs and newlines', source: 'omv\tsrbija\nbg', expected: 'omv-srbija-bg' },
    { label: 'digits only', source: '2026', expected: '2026' },
    { label: 'an ampersand', source: 'Petar & Sinovi', expected: 'petar-sinovi' },
  ])('collapses $label into single dashes', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  it('lowercases an all-caps source', () => {
    expect(slugify('OMV SRBIJA')).toBe('omv-srbija')
  })

  it('keeps a slug of exactly forty characters unchanged', () => {
    const forty = 'a'.repeat(40)
    expect(slugify(forty)).toBe(forty)
    expect(slugify(forty)).toHaveLength(40)
  })

  it('caps a forty-one character slug at forty characters', () => {
    expect(slugify('a'.repeat(41))).toBe('a'.repeat(40))
  })

  it('never leaves a trailing dash at the truncation boundary', () => {
    // 39 letters, then a separator: cutting at 40 would end on a dash.
    const slug = slugify(`${'a'.repeat(39)} bbbbb`)
    expect(slug).toBe('a'.repeat(39))
  })

  it.each([
    { label: 'a long Serbian company name', source: 'Preduzeće za proizvodnju i promet Kartonaža Bačka doo Novi Sad' },
    { label: 'a long run of words', source: 'one two three four five six seven eight nine ten eleven twelve' },
    { label: 'a long single word', source: 'z'.repeat(200) },
    { label: 'a long punctuated string', source: 'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z' },
  ])('caps $label at forty characters with no dangling dash', ({ source }) => {
    const slug = slugify(source)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toMatch(SLUG_SHAPE)
  })

  it.each([
    '-leading',
    'trailing-',
    '-both-',
    '///slashes///',
  ])('never returns a leading or trailing dash for %s', (source) => {
    const slug = slugify(source)
    expect(slug.startsWith('-')).toBe(false)
    expect(slug.endsWith('-')).toBe(false)
  })

  it.each([
    { label: 'an empty string', source: '' },
    { label: 'only spaces', source: '   ' },
    { label: 'only punctuation', source: '!!!' },
    { label: 'only dashes', source: '---' },
    { label: 'only symbols', source: '@#$%^&*()' },
  ])('returns a non-empty fallback slug for $label', ({ source }) => {
    expect(slugify(source)).toMatch(SLUG_SHAPE)
    expect(slugify(source).length).toBeGreaterThan(0)
  })

  it('returns the same fallback slug for every unusable source', () => {
    const fallback = slugify('')
    expect(slugify('   ')).toBe(fallback)
    expect(slugify('!!!')).toBe(fallback)
    expect(slugify('---')).toBe(fallback)
    expect(slugify('@#$%^&*()')).toBe(fallback)
  })

  it.each([
    'Šećer & Со',
    'Preduzeće za proizvodnju i promet Kartonaža doo',
    '🧾',
  ])('emits only lowercase letters, digits and inner dashes for %s', (source) => {
    expect(slugify(source)).toMatch(SLUG_SHAPE)
  })

  it.each([
    'Šećer',
    '!!!',
    'a'.repeat(120),
  ])('is idempotent for %s', (source) => {
    expect(slugify(slugify(source))).toBe(slugify(source))
  })

  it('drops an emoji rather than letting it break the slug', () => {
    expect(slugify('Račun 🧾 2026')).toBe('racun-2026')
  })

  it('does not let a non-Serbian accent produce an invalid slug', () => {
    // Whether é folds to "e" or is dropped is unspecified; the slug must stay well-formed either way.
    const slug = slugify('Café Bar')
    expect(slug).toMatch(SLUG_SHAPE)
    expect(slug.startsWith('caf')).toBe(true)
  })

  it('does not let Cyrillic input produce an empty slug', () => {
    const slug = slugify('Јелена доо')
    expect(slug).toMatch(SLUG_SHAPE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('sidecarPath', () => {
  it('appends .json to the document path, keeping the original extension visible', () => {
    expect(sidecarPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg.json',
    )
  })

  it.each([
    {
      path: 'diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf',
      expected: 'diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf.json',
    },
    {
      path: 'personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf',
      expected: 'personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf.json',
    },
    {
      path: 'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.png',
      expected: 'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.png.json',
    },
  ])('appends .json to $path', ({ path, expected }) => {
    expect(sidecarPath(path)).toBe(expected)
  })

  it('is the document path plus a suffix for whatever blobPathFor produced', () => {
    const path = blobPathFor(OMV)
    expect(sidecarPath(path)).toBe(`${path}.json`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('hashIndexPath', () => {
  it.each([
    { book: 'DILIGAF' as BookCode, expected: `_index/hash/diligaf/${SHA_OMV}.txt` },
    { book: 'PERSONAL' as BookCode, expected: `_index/hash/personal/${SHA_OMV}.txt` },
    { book: 'SMOQUA' as BookCode, expected: `_index/hash/smoqua/${SHA_OMV}.txt` },
  ])('scopes the marker for $book under its own folder', ({ book, expected }) => {
    expect(hashIndexPath(book, SHA_OMV)).toBe(expected)
  })

  it('uses the full digest, not the shortened sha8', () => {
    const path = hashIndexPath('DILIGAF', SHA_OMV)
    expect(path).toContain(SHA_OMV)
    expect(path).not.toBe(`_index/hash/diligaf/${SHA_OMV.slice(0, 8)}.txt`)
  })

  it('gives two books different markers for identical bytes', () => {
    expect(hashIndexPath('DILIGAF', SHA_OMV)).not.toBe(hashIndexPath('PERSONAL', SHA_OMV))
  })

  it('gives one book different markers for different bytes', () => {
    expect(hashIndexPath('DILIGAF', SHA_OMV)).not.toBe(hashIndexPath('DILIGAF', SHA_IZVOD))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('parseBlobPath', () => {
  it('splits the documented path into its parts', () => {
    expect(parseBlobPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it.each([
    { label: 'a receipt photo', patch: {} as Partial<BlobPathInput> },
    { label: 'a null docDate', patch: { docDate: null } },
    { label: 'a docDate outside the period', patch: { period: '2026-08', docDate: '2026-07-31' } },
    { label: 'a personal statement', patch: { blobPrefix: 'personal', category: 'statement' as DocCategory, extension: 'pdf', sha256: SHA_IZVOD } },
    { label: 'a smoqua expense', patch: { blobPrefix: 'smoqua', slugSource: 'Kartonaža doo', sha256: SHA_KARTONAZA, extension: 'pdf' } },
    { label: 'an outgoing invoice', patch: { category: 'invoice_out' as DocCategory, slugSource: 'Faktura 0007/2026', sha256: SHA_FAKTURA, extension: 'pdf' } },
    { label: 'a SEF inbound document', patch: { category: 'sef_inbound' as DocCategory, slugSource: 'Telekom Srbija', extension: 'pdf' } },
    { label: 'an unusable slug source', patch: { slugSource: '!!!' } },
    { label: 'a January period', patch: { period: '2026-01', docDate: null } },
    { label: 'a December period', patch: { period: '2026-12', docDate: null } },
  ])('round-trips a path built for $label', ({ patch }) => {
    const built = input(patch)
    expect(parseBlobPath(blobPathFor(built))).toEqual({
      prefix: built.blobPrefix,
      period: built.period,
      category: built.category,
      sha8: built.sha256.slice(0, 8),
    })
  })

  it.each([
    { label: 'an empty string', path: '' },
    { label: 'a bare filename', path: '2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a missing category segment', path: 'diligaf/2026/08/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'an extra leading segment', path: 'e-docs/diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a leading slash', path: '/diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a trailing slash', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg/' },
    { label: 'a missing extension', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47' },
    { label: 'a two-digit year', path: 'diligaf/26/08/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'an unpadded month', path: 'diligaf/2026/8/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a month of 13', path: 'diligaf/2026/13/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a month of 00', path: 'diligaf/2026/00/expense/2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a seven-character sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d4.jpg' },
    { label: 'a nine-character sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47a.jpg' },
    { label: 'a non-hex sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--zzzzzzzz.jpg' },
    { label: 'single-dash separators', path: 'diligaf/2026/08/expense/2026-08-11-omv-srbija-91be0d47.jpg' },
    { label: 'a malformed date in the filename', path: 'diligaf/2026/08/expense/11-08-2026--omv-srbija--91be0d47.jpg' },
    { label: 'a missing date in the filename', path: 'diligaf/2026/08/expense/omv-srbija--91be0d47.jpg' },
    { label: 'a ledger event blob', path: 'personal/2026/08/tx/01J9F2QK7X8-statement.json' },
    { label: 'a hash index marker', path: `_index/hash/diligaf/${SHA_OMV}.txt` },
    { label: 'a state blob', path: '_state/books.json' },
    { label: 'a review queue pointer', path: '_queue/review/diligaf/2026-08-11--omv--91be0d47.json' },
    { label: 'a package artifact', path: 'packages/diligaf/2026-07/DILIGAF-2026-07.zip' },
  ])('returns null for $label', ({ path }) => {
    expect(parseBlobPath(path)).toBeNull()
  })

  it('reads the period from the directory, not from the date in the filename', () => {
    const parsed = parseBlobPath('diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg')
    expect(parsed?.period).toBe('2026-08')
  })

  it('joins the year and month with a dash to form the period', () => {
    expect(parseBlobPath('personal/2026/01/statement/2026-01-01--izvod--3f1a9c22.pdf')?.period).toBe(
      '2026-01',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('fingerprint', () => {
  it('returns the digest produced by the injected hash function', () => {
    const hash = fakeSha256(SHA_OMV)
    expect(fingerprint(Uint8Array.from([1, 2, 3]), hash.fn).sha256).toBe(SHA_OMV)
  })

  it('takes the first eight characters of the digest as sha8', () => {
    const hash = fakeSha256(SHA_OMV)
    expect(fingerprint(Uint8Array.from([1, 2, 3]), hash.fn).sha8).toBe('91be0d47')
  })

  it.each([
    { digest: SHA_OMV, sha8: '91be0d47' },
    { digest: SHA_IZVOD, sha8: '3f1a9c22' },
    { digest: SHA_FAKTURA, sha8: 'c40a1e88' },
    { digest: SHA_KARTONAZA, sha8: 'd19f7b30' },
  ])('shortens $digest to $sha8', ({ digest, sha8 }) => {
    expect(fingerprint(Uint8Array.from([7]), fakeSha256(digest).fn).sha8).toBe(sha8)
  })

  it('reports the byte size of the buffer', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5])
    expect(fingerprint(bytes, fakeSha256(SHA_OMV).fn).byteSize).toBe(5)
  })

  it('reports a byte size of zero for empty bytes rather than refusing', () => {
    const result = fingerprint(new Uint8Array(0), fakeSha256(SHA_OMV).fn)
    expect(result.byteSize).toBe(0)
    expect(result.sha256).toBe(SHA_OMV)
  })

  it('reports the length of a view, not of the buffer behind it', () => {
    const view = new Uint8Array(new ArrayBuffer(1024), 16, 40)
    expect(fingerprint(view, fakeSha256(SHA_OMV).fn).byteSize).toBe(40)
  })

  it('calls the injected hash exactly once, with the bytes it was given', () => {
    const hash = fakeSha256(SHA_OMV)
    const bytes = Uint8Array.from([9, 8, 7])
    fingerprint(bytes, hash.fn)
    expect(hash.calls).toHaveLength(1)
    expect(Array.from(hash.calls[0]!)).toEqual([9, 8, 7])
  })

  it('produces a sha8 that matches the sha8 in the blob path for the same digest', () => {
    const fp = fingerprint(Uint8Array.from([1]), fakeSha256(SHA_KARTONAZA).fn)
    const path = blobPathFor(input({ sha256: fp.sha256 }))
    expect(parseBlobPath(path)?.sha8).toBe(fp.sha8)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('extensionFor', () => {
  it.each([
    { filename: 'IMG_4821.jpg', mimeType: 'image/jpeg', expected: 'jpg' },
    { filename: 'izvod.pdf', mimeType: 'application/pdf', expected: 'pdf' },
    { filename: 'scan.png', mimeType: 'image/png', expected: 'png' },
    { filename: 'racun.2026.08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
  ])('reads $expected from the filename $filename', ({ filename, mimeType, expected }) => {
    expect(extensionFor(filename, mimeType)).toBe(expected)
  })

  it('lowercases an upper-case filename extension', () => {
    expect(extensionFor('IMG_4821.JPG', 'image/jpeg')).toBe('jpg')
  })

  it('returns the extension without a dot', () => {
    expect(extensionFor('izvod.pdf', 'application/pdf').startsWith('.')).toBe(false)
  })

  it('takes only the last extension of a double-extension filename', () => {
    expect(extensionFor('arhiva.tar.gz', 'application/gzip')).toBe('gz')
  })

  it.each([
    { mimeType: 'application/pdf', expected: 'pdf' },
    { mimeType: 'image/jpeg', expected: 'jpg' },
    { mimeType: 'image/png', expected: 'png' },
  ])('falls back to the mime type $mimeType when the filename has no extension', ({ mimeType, expected }) => {
    expect(extensionFor('scan', mimeType)).toBe(expected)
  })

  it('falls back to the mime type when the filename is empty', () => {
    expect(extensionFor('', 'application/pdf')).toBe('pdf')
  })

  it('falls back to the mime type when the filename ends in a dot', () => {
    expect(extensionFor('scan.', 'application/pdf')).toBe('pdf')
  })

  it('falls back to the mime type when the filename extension is not a known type', () => {
    expect(extensionFor('receipt.xyzzy', 'image/jpeg')).toBe('jpg')
  })

  it('prefers the filename extension over a disagreeing mime type', () => {
    expect(extensionFor('scan.png', 'application/pdf')).toBe('png')
  })

  it('ignores mime type parameters', () => {
    expect(extensionFor('scan', 'application/pdf; charset=binary')).toBe('pdf')
  })

  it('accepts an upper-case mime type', () => {
    expect(extensionFor('scan', 'APPLICATION/PDF')).toBe('pdf')
  })

  it.each([
    { label: 'both inputs empty', filename: '', mimeType: '' },
    { label: 'a generic binary mime type', filename: 'blob', mimeType: 'application/octet-stream' },
    { label: 'an unknown filename extension and an unknown mime type', filename: 'thing.xyzzy', mimeType: 'application/x-nonsense' },
    { label: 'no extension and no mime type', filename: 'receipt', mimeType: '' },
    { label: 'whitespace only', filename: '   ', mimeType: '   ' },
  ])('returns bin when it cannot tell the type from $label', ({ filename, mimeType }) => {
    expect(extensionFor(filename, mimeType)).toBe('bin')
  })

  it('produces an extension that keeps the blob path well-formed', () => {
    const path = blobPathFor(input({ extension: extensionFor('IMG_4821.jpg', 'image/jpeg') }))
    expect(path).toMatch(PATH_SHAPE)
    expect(path.endsWith('.jpg')).toBe(true)
  })
})
