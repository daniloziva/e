import { describe, it, expect } from 'vitest'
import {
  blobPathFor,
  slugify,
  sidecarPath,
  hashIndexPath,
  parseBlobPath,
  type BlobPathInput,
} from '../../../src/engine/documents/blob-path.js'
import { fingerprint, extensionFor } from '../../../src/engine/documents/fingerprint.js'
import type { BookCode, DocCategory } from '../../../src/engine/types.js'

// ── fixtures ───────────────────────────────────────────────────────────────
// Two full 64-char sha256 digests. The first 8 chars are the `sha8` the path
// convention uses (01-ARCHITECTURE §3).
const SHA = '91be0d47a1c9f3e25b8d4470ac6f1e93d2b7c05a8e14f36092ad7bc4e5f10983'
const SHA8 = '91be0d47'
const SHA_B = '3f1a9c220e5d1b734a8c69f0d15e2b8477c30af61b9e40d2c8a567310fb2d94e'
const SHA8_B = '3f1a9c22'

/** A slug that is well-formed under every reading of the spec: lowercase alnum
 *  groups joined by single dashes, no leading/trailing dash, never empty. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const baseInput: BlobPathInput = {
  blobPrefix: 'diligaf',
  period: '2026-08',
  category: 'expense',
  docDate: '2026-08-11',
  slugSource: 'OMV Srbija',
  sha256: SHA,
  extension: 'jpg',
}

const withInput = (patch: Partial<BlobPathInput>): BlobPathInput => ({ ...baseInput, ...patch })

/** The `{YYYY}/{MM}` directory the path actually landed in, as `YYYY-MM`. */
function directoryPeriodOf(path: string): string {
  const [, year, month] = path.split('/')
  return `${year}-${month}`
}

// ── slugify ────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases and joins words with a single dash', () => {
    expect(slugify('OMV Srbija')).toBe('omv-srbija')
  })

  it.each([
    { input: 'Čačak', expected: 'cacak' },
    { input: 'Šabac', expected: 'sabac' },
    { input: 'Žitište', expected: 'zitiste' },
    { input: 'Đorđe', expected: 'dorde' },
    { input: 'ČĆŽŠĐ', expected: 'cczsd' },
  ])('folds the Serbian diacritics in $input to ASCII', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it('folds diacritics and collapses punctuation in a realistic company name', () => {
    expect(slugify('Preduzeće "Đačko Ćoše" d.o.o.')).toBe('preduzece-dacko-cose-d-o-o')
  })

  it.each([
    { name: 'runs of spaces', input: 'OMV   Srbija', expected: 'omv-srbija' },
    { name: 'underscores and digits', input: 'IMG_4821_scan', expected: 'img-4821-scan' },
    { name: 'slashes', input: 'Izvod 265/08', expected: 'izvod-265-08' },
    { name: 'existing dash runs', input: 'omv---srbija', expected: 'omv-srbija' },
  ])('collapses $name into a single dash', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it.each([
    { input: '---omv', expected: 'omv' },
    { input: 'omv---', expected: 'omv' },
    { input: '  !!!omv srbija!!!  ', expected: 'omv-srbija' },
  ])('never leaves a leading or trailing dash for $input', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it('keeps a slug that is exactly 40 characters untouched', () => {
    const exactly40 = 'a'.repeat(40)
    expect(slugify(exactly40)).toBe(exactly40)
  })

  it('truncates a 41-character slug to exactly 40 characters', () => {
    expect(slugify('a'.repeat(41))).toBe('a'.repeat(40))
  })

  it('does not leave a trailing dash when the 40-character cut lands on a dash', () => {
    // 39 letters, then a separator: cutting at 40 would end on the dash.
    const slug = slugify(`${'a'.repeat(39)} bbbb`)
    expect(slug).toBe('a'.repeat(39))
  })

  it('caps a long vendor name at 40 characters and keeps it well-formed', () => {
    const slug = slugify('Preduzece za proizvodnju i promet kartonaze doo Beograd')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toMatch(SLUG_RE)
  })

  it.each([
    { name: 'an empty string', input: '' },
    { name: 'only whitespace', input: '   ' },
    { name: 'only punctuation', input: '!!!///...' },
    { name: 'only emoji', input: '🧾🧾' },
  ])('returns a usable non-empty slug for $name rather than an empty segment', ({ input }) => {
    const slug = slugify(input)
    expect(slug).not.toBe('')
    expect(slug).toMatch(SLUG_RE)
  })

  it('uses one and the same fallback for every input that reduces to nothing', () => {
    expect(slugify('!!!')).toBe(slugify(''))
    expect(slugify('   ')).toBe(slugify(''))
  })

  it.each([
    { name: 'French accents', input: 'Café Müller' },
    { name: 'Cyrillic', input: 'Телеком Србија' },
  ])('produces a well-formed capped slug for non-Serbian text ($name)', ({ input }) => {
    const slug = slugify(input)
    expect(slug).toMatch(SLUG_RE)
    expect(slug.length).toBeLessThanOrEqual(40)
  })
})

// ── blobPathFor ────────────────────────────────────────────────────────────

describe('blobPathFor', () => {
  it('builds {prefix}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}', () => {
    expect(blobPathFor(baseInput)).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    )
  })

  it("dates the file on the period's first day when docDate is null", () => {
    expect(blobPathFor(withInput({ docDate: null }))).toBe(
      'diligaf/2026/08/expense/2026-08-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the previous month under the period, not its own month', () => {
    expect(blobPathFor(withInput({ docDate: '2026-07-31' }))).toBe(
      'diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the next month under the period, not its own month', () => {
    expect(blobPathFor(withInput({ docDate: '2026-09-02' }))).toBe(
      'diligaf/2026/08/expense/2026-09-02--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the previous year under the period year', () => {
    expect(
      blobPathFor(
        withInput({
          blobPrefix: 'personal',
          category: 'statement',
          period: '2026-01',
          docDate: '2025-12-31',
        }),
      ),
    ).toBe('personal/2026/01/statement/2025-12-31--omv-srbija--91be0d47.jpg')
  })

  it.each([
    { period: '2026-01', docDate: '2026-01-01' },
    { period: '2026-01', docDate: '2025-12-31' },
    { period: '2026-12', docDate: '2027-01-05' },
    { period: '2026-02', docDate: '2024-02-29' },
    { period: '2026-08', docDate: null },
    { period: '2026-12', docDate: null },
  ])('puts YYYY/MM equal to period $period even when docDate is $docDate', ({ period, docDate }) => {
    expect(directoryPeriodOf(blobPathFor(withInput({ period, docDate })))).toBe(period)
  })

  it.each<DocCategory>(['izvod', 'invoice_out', 'sef_inbound'])(
    'puts a %s document in its own category directory',
    (category) => {
      expect(blobPathFor(withInput({ category }))).toBe(
        `diligaf/2026/08/${category}/2026-08-11--omv-srbija--91be0d47.jpg`,
      )
    },
  )

  it.each(['diligaf', 'personal', 'smoqua'])(
    'prefixes the path with the %s book prefix',
    (blobPrefix) => {
      expect(blobPathFor(withInput({ blobPrefix })).startsWith(`${blobPrefix}/`)).toBe(true)
    },
  )

  it('slugifies the source, folding Serbian diacritics into the filename', () => {
    expect(blobPathFor(withInput({ slugSource: 'Kartonaža d.o.o.' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--kartonaza-d-o-o--91be0d47.jpg',
    )
  })

  it('caps the slug inside the path at 40 characters', () => {
    expect(blobPathFor(withInput({ slugSource: 'x'.repeat(80) }))).toBe(
      `diligaf/2026/08/expense/2026-08-11--${'x'.repeat(40)}--91be0d47.jpg`,
    )
  })

  it('still produces a well-formed filename when the slug source is empty', () => {
    const path = blobPathFor(withInput({ slugSource: '' }))
    const filename = path.split('/').pop() as string
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{8}\.jpg$/)
    expect(path).not.toContain('----')
  })

  it('uses only the first 8 characters of the sha256 in the name', () => {
    const path = blobPathFor(baseInput)
    expect(path).toContain(`--${SHA8}.jpg`)
    expect(path).not.toContain(SHA)
  })

  it('appends the extension after a single dot', () => {
    expect(blobPathFor(withInput({ extension: 'pdf' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.pdf',
    )
  })
})

// ── sidecarPath ────────────────────────────────────────────────────────────

describe('sidecarPath', () => {
  it('appends .json to the document path, keeping the original extension', () => {
    expect(sidecarPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg.json',
    )
  })

  it('appends .json for a PDF document too', () => {
    expect(sidecarPath('smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.pdf')).toBe(
      'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.pdf.json',
    )
  })

  it('sits directly next to the document produced by blobPathFor', () => {
    const path = blobPathFor(baseInput)
    expect(sidecarPath(path)).toBe(`${path}.json`)
  })
})

// ── hashIndexPath ──────────────────────────────────────────────────────────

describe('hashIndexPath', () => {
  it.each<{ book: BookCode; expected: string }>([
    { book: 'DILIGAF', expected: `_index/hash/diligaf/${SHA}.txt` },
    { book: 'PERSONAL', expected: `_index/hash/personal/${SHA}.txt` },
    { book: 'SMOQUA', expected: `_index/hash/smoqua/${SHA}.txt` },
  ])('puts the $book marker under its own book folder', ({ book, expected }) => {
    expect(hashIndexPath(book, SHA)).toBe(expected)
  })

  it('keys the marker on the full sha256, not on the 8-character prefix', () => {
    expect(hashIndexPath('DILIGAF', SHA)).toContain(SHA)
  })

  it('gives different content different markers', () => {
    expect(hashIndexPath('DILIGAF', SHA)).not.toBe(hashIndexPath('DILIGAF', SHA_B))
  })

  it('scopes dedupe per book, so the same content in two books gets two markers', () => {
    expect(hashIndexPath('DILIGAF', SHA)).not.toBe(hashIndexPath('PERSONAL', SHA))
  })
})

// ── parseBlobPath ──────────────────────────────────────────────────────────

describe('parseBlobPath', () => {
  it('reads the prefix, period, category and sha8 out of a document path', () => {
    expect(parseBlobPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it.each([
    { name: 'a receipt photo', input: baseInput },
    {
      name: 'a statement PDF',
      input: withInput({ blobPrefix: 'personal', category: 'statement', extension: 'pdf' }),
    },
    { name: 'an outgoing invoice', input: withInput({ category: 'invoice_out', extension: 'pdf' }) },
    { name: 'a document with no date', input: withInput({ docDate: null }) },
    {
      name: 'a January document dated in the previous year',
      input: withInput({ period: '2026-01', docDate: '2025-12-31' }),
    },
    { name: 'a document with an empty slug source', input: withInput({ slugSource: '' }) },
    {
      name: 'a document with an over-long slug source',
      input: withInput({ blobPrefix: 'smoqua', slugSource: 'x'.repeat(80), sha256: SHA_B }),
    },
  ])('round-trips $name built by blobPathFor', ({ input }) => {
    expect(parseBlobPath(blobPathFor(input))).toEqual({
      prefix: input.blobPrefix,
      period: input.period,
      category: input.category,
      sha8: input.sha256.slice(0, 8),
    })
  })

  it('reports the period from the directory, not from the date in the filename', () => {
    const path = blobPathFor(withInput({ period: '2026-08', docDate: '2026-07-31' }))
    expect(parseBlobPath(path)?.period).toBe('2026-08')
  })

  it.each([
    { name: 'an empty string', path: '' },
    { name: 'a directory with no filename', path: 'diligaf/2026/08/expense' },
    { name: 'a missing category segment', path: 'diligaf/2026/08/2026-08-11--omv--91be0d47.jpg' },
    { name: 'an extra nested segment', path: 'diligaf/2026/08/expense/x/2026-08-11--omv--91be0d47.jpg' },
    { name: 'a month out of range', path: 'diligaf/2026/13/expense/2026-13-11--omv--91be0d47.jpg' },
    { name: 'an unpadded month', path: 'diligaf/2026/8/expense/2026-08-11--omv--91be0d47.jpg' },
    { name: 'a two-digit year', path: 'diligaf/26/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { name: 'a missing sha8 segment', path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija.jpg' },
    { name: 'a 7-character hash suffix', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d4.jpg' },
    { name: 'a 9-character hash suffix', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47a.jpg' },
    { name: 'a non-hex hash suffix', path: 'diligaf/2026/08/expense/2026-08-11--omv--zzzzzzzz.jpg' },
    { name: 'a malformed date in the filename', path: 'diligaf/2026/08/expense/2026-8-11--omv--91be0d47.jpg' },
    { name: 'a filename with no date', path: 'diligaf/2026/08/expense/omv-srbija--91be0d47.jpg' },
    { name: 'a filename with no extension', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47' },
    { name: 'a leading slash', path: '/diligaf/2026/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { name: 'a ledger event path', path: 'personal/2026/08/tx/01J9F2QK7X8-statement.json' },
    { name: 'a hash index marker', path: `_index/hash/diligaf/${SHA}.txt` },
    { name: 'a review queue entry', path: '_queue/review/diligaf/2026-08-11--omv--91be0d47.json' },
  ])('returns null for $name rather than guessing', ({ path }) => {
    expect(parseBlobPath(path)).toBeNull()
  })
})

// ── fingerprint ────────────────────────────────────────────────────────────

/** Hand-written fake hasher: answers with a fixed digest and records what it
 *  was asked to hash. No mocking library. */
function fakeHasher(digest: string) {
  const calls: Uint8Array[] = []
  const fn = (bytes: Uint8Array): string => {
    calls.push(bytes)
    return digest
  }
  return { fn, calls }
}

describe('fingerprint', () => {
  it('reports the digest the injected hasher returned', () => {
    expect(fingerprint(new Uint8Array([1, 2, 3]), fakeHasher(SHA).fn).sha256).toBe(SHA)
  })

  it('derives sha8 as the first 8 characters of the sha256', () => {
    const fp = fingerprint(new Uint8Array([1]), fakeHasher(SHA_B).fn)
    expect(fp.sha8).toBe(SHA8_B)
  })

  it('reports the byte size of the input', () => {
    expect(fingerprint(new Uint8Array(812443), fakeHasher(SHA).fn).byteSize).toBe(812443)
  })

  it('reports zero bytes and still hashes an empty document', () => {
    const fp = fingerprint(new Uint8Array(0), fakeHasher(SHA).fn)
    expect(fp.byteSize).toBe(0)
    expect(fp.sha256).toBe(SHA)
    expect(fp.sha8).toBe(SHA8)
  })

  it('measures the view, not the buffer behind it, for a sliced Uint8Array', () => {
    const view = new Uint8Array(new ArrayBuffer(10), 4, 3)
    expect(fingerprint(view, fakeHasher(SHA).fn).byteSize).toBe(3)
  })

  it('hands the hasher exactly the bytes it was given, once', () => {
    const hasher = fakeHasher(SHA)
    fingerprint(new Uint8Array([9, 8, 7, 6]), hasher.fn)
    expect(hasher.calls).toHaveLength(1)
    expect(Array.from(hasher.calls[0] ?? [])).toEqual([9, 8, 7, 6])
  })

  it('keeps sha8 a prefix of sha256 even when the hasher answers in uppercase', () => {
    const fp = fingerprint(new Uint8Array([1]), fakeHasher(SHA.toUpperCase()).fn)
    expect(fp.sha8.toLowerCase()).toBe(SHA8)
    expect(fp.sha256.toLowerCase().startsWith(fp.sha8.toLowerCase())).toBe(true)
  })

  it('produces the same sha8 that blobPathFor puts in the filename', () => {
    const fp = fingerprint(new Uint8Array([1, 2]), fakeHasher(SHA).fn)
    expect(blobPathFor(withInput({ sha256: fp.sha256 }))).toContain(`--${fp.sha8}.jpg`)
  })
})

// ── extensionFor ───────────────────────────────────────────────────────────

describe('extensionFor', () => {
  it.each([
    { filename: 'IMG_4821.jpg', mimeType: 'image/jpeg', expected: 'jpg' },
    { filename: 'izvod-265-08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
  ])('takes $expected from the filename $filename', ({ filename, mimeType, expected }) => {
    expect(extensionFor(filename, mimeType)).toBe(expected)
  })

  it('lowercases an uppercase filename extension', () => {
    expect(extensionFor('FAKTURA.PDF', 'application/pdf')).toBe('pdf')
  })

  it('takes only the last extension of a double-barrelled filename', () => {
    expect(extensionFor('archive.tar.gz', 'application/gzip')).toBe('gz')
  })

  it('prefers the filename extension over a contradicting mime type', () => {
    expect(extensionFor('receipt.jpg', 'application/pdf')).toBe('jpg')
  })

  it.each([
    { mimeType: 'image/jpeg', expected: 'jpg' },
    { mimeType: 'application/pdf', expected: 'pdf' },
    { mimeType: 'image/png', expected: 'png' },
  ])(
    'falls back to $expected from the mime type $mimeType when the filename has no extension',
    ({ mimeType, expected }) => {
      expect(extensionFor('scan', mimeType)).toBe(expected)
    },
  )

  it('falls back to the mime type when the filename is empty', () => {
    expect(extensionFor('', 'image/jpeg')).toBe('jpg')
  })

  it('ignores mime type parameters', () => {
    expect(extensionFor('scan', 'image/jpeg; charset=binary')).toBe('jpg')
  })

  it.each([
    { name: 'both inputs empty', filename: '', mimeType: '' },
    { name: 'no extension and no mime type', filename: 'scan', mimeType: '' },
    { name: 'a trailing dot', filename: 'scan.', mimeType: '' },
    { name: 'an unknown mime type', filename: 'scan', mimeType: 'application/x-unknown-thing' },
    { name: 'the generic octet-stream', filename: 'scan', mimeType: 'application/octet-stream' },
    { name: 'a dotfile with no mime type', filename: '.gitignore', mimeType: '' },
  ])('returns bin for $name rather than guessing', ({ filename, mimeType }) => {
    expect(extensionFor(filename, mimeType)).toBe('bin')
  })

  it('produces an extension usable directly in a blob path (no leading dot)', () => {
    const ext = extensionFor('IMG_4821.jpg', 'image/jpeg')
    expect(blobPathFor(withInput({ extension: ext }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    )
  })
})
