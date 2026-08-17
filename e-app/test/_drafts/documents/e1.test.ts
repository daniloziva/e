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
import type { DocCategory } from '../../../src/engine/types.js'

// ── fakes ────────────────────────────────────────────────────────────────────
// No mocking library: hand-written, fixed-value stand-ins for injected deps.

const SHA = '91be0d47a1c8e5f2b3d4a5960718293a4b5c6d7e8f90a1b2c3d4e5f60718293a'
const SHA8 = '91be0d47'

/** A hash fn that always answers the same digest, and records what it was asked. */
function fixedHash(digest: string) {
  const calls: Uint8Array[] = []
  const fn = (b: Uint8Array): string => {
    calls.push(b)
    return digest
  }
  return { fn, calls }
}

const ALL_CATEGORIES: DocCategory[] = [
  'izvod',
  'statement',
  'expense',
  'invoice_out',
  'sef_inbound',
  'other',
]

const baseInput = (over: Partial<BlobPathInput> = {}): BlobPathInput => ({
  blobPrefix: 'diligaf',
  period: '2026-08',
  category: 'expense',
  docDate: '2026-08-11',
  slugSource: 'OMV Srbija',
  sha256: SHA,
  extension: 'jpg',
  ...over,
})

// ── blobPathFor ──────────────────────────────────────────────────────────────

describe('blobPathFor', () => {
  it('builds the documented path for a WhatsApp receipt', () => {
    expect(blobPathFor(baseInput())).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    )
  })

  it('uses the first day of the period as the filename date when docDate is null', () => {
    expect(blobPathFor(baseInput({ docDate: null }))).toBe(
      'diligaf/2026/08/expense/2026-08-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('uses the first day of the period even for a 31-day month when docDate is null', () => {
    expect(blobPathFor(baseInput({ period: '2026-12', docDate: null }))).toBe(
      'diligaf/2026/12/expense/2026-12-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the period in the directory when docDate falls in an earlier month', () => {
    // A receipt from 31 July filed into the August period: the folder is the period.
    expect(blobPathFor(baseInput({ period: '2026-08', docDate: '2026-07-31' }))).toBe(
      'diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the period in the directory when docDate falls in a later month', () => {
    expect(blobPathFor(baseInput({ period: '2026-08', docDate: '2026-09-01' }))).toBe(
      'diligaf/2026/08/expense/2026-09-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('keeps the period in the directory when docDate falls in a different year', () => {
    expect(blobPathFor(baseInput({ period: '2026-01', docDate: '2025-12-31' }))).toBe(
      'diligaf/2026/01/expense/2025-12-31--omv-srbija--91be0d47.jpg',
    )
  })

  const periodCases: Array<{ period: string; docDate: string | null }> = [
    { period: '2026-01', docDate: '2026-01-01' },
    { period: '2026-01', docDate: null },
    { period: '2026-01', docDate: '2025-12-31' },
    { period: '2026-08', docDate: '2026-08-11' },
    { period: '2026-08', docDate: '2026-07-01' },
    { period: '2026-08', docDate: '2026-12-31' },
    { period: '2026-12', docDate: '2026-12-31' },
    { period: '2026-12', docDate: '2027-01-02' },
    { period: '2026-12', docDate: null },
    { period: '2030-02', docDate: '2029-02-28' },
  ]

  it.each(periodCases)(
    'puts $period in the YYYY/MM directory regardless of docDate $docDate',
    ({ period, docDate }) => {
      const path = blobPathFor(baseInput({ period, docDate }))
      const [year, month] = period.split('-')
      expect(path.startsWith(`diligaf/${year}/${month}/`)).toBe(true)
    },
  )

  it.each(ALL_CATEGORIES)('places a %s document in its own category folder', (category) => {
    expect(blobPathFor(baseInput({ category }))).toBe(
      `diligaf/2026/08/${category}/2026-08-11--omv-srbija--91be0d47.jpg`,
    )
  })

  it.each(['diligaf', 'personal', 'smoqua'])(
    'roots the path at the %s blob prefix',
    (blobPrefix) => {
      expect(blobPathFor(baseInput({ blobPrefix })).startsWith(`${blobPrefix}/2026/08/`)).toBe(true)
    },
  )

  it('uses only the first 8 characters of the sha256 in the filename', () => {
    const path = blobPathFor(baseInput())
    expect(path.endsWith(`--${SHA.slice(0, 8)}.jpg`)).toBe(true)
    expect(path).not.toContain(SHA)
  })

  it('gives two documents with the same slug and date distinct paths via sha8', () => {
    const other = '7ad3f012aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    expect(blobPathFor(baseInput())).not.toBe(blobPathFor(baseInput({ sha256: other })))
  })

  it.each([
    { extension: 'pdf', expected: '.pdf' },
    { extension: 'jpg', expected: '.jpg' },
    { extension: 'bin', expected: '.bin' },
  ])('appends .$extension as the file extension', ({ extension, expected }) => {
    expect(blobPathFor(baseInput({ extension })).endsWith(expected)).toBe(true)
  })

  it('still produces a well-formed, parseable path when the slug source is empty', () => {
    const path = blobPathFor(baseInput({ slugSource: '' }))
    expect(path).toMatch(
      /^diligaf\/2026\/08\/expense\/2026-08-11--[a-z0-9]+(?:-[a-z0-9]+)*--91be0d47\.jpg$/,
    )
    expect(parseBlobPath(path)).not.toBeNull()
  })

  it('slugifies the slug source rather than trusting it verbatim', () => {
    expect(blobPathFor(baseInput({ slugSource: 'DOO "Kartonaža"/Beograd' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--doo-kartonaza-beograd--91be0d47.jpg',
    )
  })

  it('produces the exact architecture-document example for an izvod', () => {
    expect(
      blobPathFor(
        baseInput({
          category: 'izvod',
          docDate: '2026-08-05',
          slugSource: 'IZVOD 265/08',
          sha256: '3f1a9c22' + SHA.slice(8),
          extension: 'pdf',
        }),
      ),
    ).toBe('diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf')
  })

  it('produces the exact architecture-document example for an outgoing invoice', () => {
    expect(
      blobPathFor(
        baseInput({
          category: 'invoice_out',
          docDate: '2026-08-01',
          slugSource: 'Faktura 0007/2026',
          sha256: 'c40a1e88' + SHA.slice(8),
          extension: 'pdf',
        }),
      ),
    ).toBe('diligaf/2026/08/invoice_out/2026-08-01--faktura-0007-2026--c40a1e88.pdf')
  })

  it('produces the exact architecture-document example for a personal statement', () => {
    expect(
      blobPathFor(
        baseInput({
          blobPrefix: 'personal',
          category: 'statement',
          docDate: '2026-08-01',
          slugSource: 'izvod tekuci jul',
          sha256: '02cc9a51' + SHA.slice(8),
          extension: 'pdf',
        }),
      ),
    ).toBe('personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf')
  })

  it('never emits a leading slash or a double slash', () => {
    const path = blobPathFor(baseInput({ slugSource: '///' }))
    expect(path.startsWith('/')).toBe(false)
    expect(path).not.toContain('//')
  })
})

// ── slugify ──────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it.each([
    { input: 'OMV Srbija', expected: 'omv-srbija' },
    { input: 'Telekom Srbija', expected: 'telekom-srbija' },
    { input: 'lowercase', expected: 'lowercase' },
    { input: 'Wolt Beograd', expected: 'wolt-beograd' },
    { input: 'IZVOD 265/08', expected: 'izvod-265-08' },
    { input: 'Faktura 0007/2026', expected: 'faktura-0007-2026' },
    { input: '2026', expected: '2026' },
  ])('turns $input into $expected', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it.each([
    { input: 'Čačak', expected: 'cacak' },
    { input: 'Ćuprija', expected: 'cuprija' },
    { input: 'Šabac', expected: 'sabac' },
    { input: 'Žitište', expected: 'zitiste' },
    { input: 'Đorđe', expected: 'djordje' },
    { input: 'čćžšđ', expected: 'cczsdj' },
    { input: 'ČĆŽŠĐ', expected: 'cczsdj' },
    { input: 'Kartonaža d.o.o.', expected: 'kartonaza-d-o-o' },
    { input: 'Užice Šped', expected: 'uzice-sped' },
  ])('folds the Serbian diacritics in $input to $expected', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it.each([
    { input: 'a  b', expected: 'a-b' },
    { input: 'a\t\nb', expected: 'a-b' },
    { input: 'a....b', expected: 'a-b' },
    { input: 'a - - b', expected: 'a-b' },
    { input: 'a_b', expected: 'a-b' },
    { input: 'a/b\\c', expected: 'a-b-c' },
    { input: 'a & b', expected: 'a-b' },
    { input: 'a--b', expected: 'a-b' },
  ])('collapses the punctuation run in $input to a single dash', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it.each([
    { input: '-omv-', expected: 'omv' },
    { input: '--omv--', expected: 'omv' },
    { input: '  omv  ', expected: 'omv' },
    { input: '...omv...', expected: 'omv' },
    { input: '/omv/', expected: 'omv' },
  ])('trims the leading and trailing dashes from $input', ({ input, expected }) => {
    expect(slugify(input)).toBe(expected)
  })

  it('leaves a slug that is exactly 40 characters untouched', () => {
    const input = 'a'.repeat(40)
    expect(slugify(input)).toBe(input)
    expect(slugify(input)).toHaveLength(40)
  })

  it('caps a 41-character slug at exactly 40 characters', () => {
    expect(slugify('a'.repeat(41))).toBe('a'.repeat(40))
  })

  it('applies the 40-character cap after folding diacritics, not before', () => {
    // 50 two-byte characters fold to 50 ASCII characters, then cap to 40.
    expect(slugify('č'.repeat(50))).toBe('c'.repeat(40))
  })

  it('never leaves a trailing dash when the cap lands on a separator', () => {
    const slug = slugify('a'.repeat(39) + ' ' + 'b'.repeat(5))
    expect(slug).toBe('a'.repeat(39))
    expect(slug.endsWith('-')).toBe(false)
  })

  it('cuts mid-word rather than exceeding the cap', () => {
    const slug = slugify('aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd')
    expect(slug).toBe('aaaaaaaaaa-bbbbbbbbbb-cccccccccc-ddddddd')
    expect(slug).toHaveLength(40)
  })

  it.each([
    { label: 'empty string', input: '' },
    { label: 'whitespace only', input: '   ' },
    { label: 'punctuation only', input: '!!!' },
    { label: 'a lone dash', input: '-' },
    { label: 'emoji only', input: '📄🧾' },
    { label: 'Cyrillic only', input: 'Телеком Србија' },
  ])('falls back to a non-empty safe slug for $label', ({ input }) => {
    const slug = slugify(input)
    expect(slug.length).toBeGreaterThan(0)
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('uses the same fallback slug for every input that slugifies to nothing', () => {
    expect(slugify('')).toBe(slugify('   '))
    expect(slugify('')).toBe(slugify('###'))
  })

  it.each(['Kartonaža d.o.o.', '-- Faktura 0007/2026 --', 'a'.repeat(60), ''])(
    'is idempotent for %s',
    (input) => {
      expect(slugify(slugify(input))).toBe(slugify(input))
    },
  )

  it.each([
    'Čačak Ćuprija Žitište Šabac Đorđe',
    'DOO "Kartonaža"/Beograd, 11000',
    'a'.repeat(100),
    '📄 receipt.jpg',
  ])('emits only lowercase ASCII, digits and inner dashes for %s', (input) => {
    const slug = slugify(input)
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(slug.length).toBeLessThanOrEqual(40)
  })
})

// ── sidecarPath ──────────────────────────────────────────────────────────────

describe('sidecarPath', () => {
  it('appends .json to the document path, keeping the original extension', () => {
    expect(sidecarPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg.json',
    )
  })

  it.each([
    'diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf',
    'personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf',
    'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.pdf',
  ])('sits next to %s in the same folder', (path) => {
    const sidecar = sidecarPath(path)
    expect(sidecar).toBe(`${path}.json`)
    expect(sidecar.slice(0, sidecar.lastIndexOf('/'))).toBe(path.slice(0, path.lastIndexOf('/')))
  })

  it('is the sidecar of whatever blobPathFor produced', () => {
    const path = blobPathFor(baseInput())
    expect(sidecarPath(path)).toBe(`${path}.json`)
  })
})

// ── hashIndexPath ────────────────────────────────────────────────────────────

describe('hashIndexPath', () => {
  it.each([
    { book: 'DILIGAF' as const, folder: 'diligaf' },
    { book: 'PERSONAL' as const, folder: 'personal' },
    { book: 'SMOQUA' as const, folder: 'smoqua' },
  ])('writes the $book dedupe marker under _index/hash/$folder', ({ book, folder }) => {
    expect(hashIndexPath(book, SHA)).toBe(`_index/hash/${folder}/${SHA}.txt`)
  })

  it('keys the marker by the full sha256, not the shortened sha8', () => {
    const path = hashIndexPath('DILIGAF', SHA)
    expect(path).toContain(SHA)
    expect(path).not.toBe(`_index/hash/diligaf/${SHA8}.txt`)
  })

  it('gives the same content in two different books two different markers', () => {
    expect(hashIndexPath('DILIGAF', SHA)).not.toBe(hashIndexPath('PERSONAL', SHA))
  })

  it('gives the same content in the same book a stable marker across calls', () => {
    expect(hashIndexPath('SMOQUA', SHA)).toBe(hashIndexPath('SMOQUA', SHA))
  })
})

// ── parseBlobPath ────────────────────────────────────────────────────────────

describe('parseBlobPath', () => {
  it('parses a document path into prefix, period, category and sha8', () => {
    expect(parseBlobPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it('reads the period from the directory, not from the filename date', () => {
    // The document is dated 31 July but was filed into the August period.
    expect(
      parseBlobPath('diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg'),
    ).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it('accepts a slug that itself contains dashes', () => {
    expect(
      parseBlobPath('diligaf/2026/08/invoice_out/2026-08-01--faktura-0007-2026--c40a1e88.pdf'),
    ).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'invoice_out',
      sha8: 'c40a1e88',
    })
  })

  it.each(ALL_CATEGORIES)('recognises the %s category folder', (category) => {
    expect(
      parseBlobPath(`smoqua/2026/08/${category}/2026-08-03--kartonaza-doo--d19f7b30.pdf`)?.category,
    ).toBe(category)
  })

  it.each(['diligaf', 'personal', 'smoqua'])('recognises the %s prefix', (prefix) => {
    expect(
      parseBlobPath(`${prefix}/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg`)?.prefix,
    ).toBe(prefix)
  })

  it('round-trips every path blobPathFor produces', () => {
    const inputs: BlobPathInput[] = [
      baseInput(),
      baseInput({ docDate: null }),
      baseInput({ blobPrefix: 'personal', category: 'statement', extension: 'pdf' }),
      baseInput({ blobPrefix: 'smoqua', category: 'other', slugSource: '!!!' }),
      baseInput({ period: '2026-12', docDate: '2027-01-03', category: 'sef_inbound' }),
      baseInput({ slugSource: 'a'.repeat(100) }),
    ]
    for (const input of inputs) {
      const parsed = parseBlobPath(blobPathFor(input))
      expect(parsed).toEqual({
        prefix: input.blobPrefix,
        period: input.period,
        category: input.category,
        sha8: input.sha256.slice(0, 8),
      })
    }
  })

  it.each([
    { label: 'an empty string', path: '' },
    { label: 'a bare filename', path: '2026-08-11--omv-srbija--91be0d47.jpg' },
    { label: 'a path with no extension', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47' },
    { label: 'a missing category folder', path: 'diligaf/2026/08/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a missing filename date', path: 'diligaf/2026/08/expense/omv--91be0d47.jpg' },
    { label: 'a missing slug', path: 'diligaf/2026/08/expense/2026-08-11--91be0d47.jpg' },
    { label: 'a single-dash separator', path: 'diligaf/2026/08/expense/2026-08-11-omv-91be0d47.jpg' },
    { label: 'a month out of range', path: 'diligaf/2026/13/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a non-numeric month', path: 'diligaf/2026/aug/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'an unpadded month', path: 'diligaf/2026/8/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a non-numeric year', path: 'diligaf/20xx/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a truncated sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0.jpg' },
    { label: 'an over-long sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47a1.jpg' },
    { label: 'a non-hex sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv--zzzzzzzz.jpg' },
    { label: 'a leading slash', path: '/diligaf/2026/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'extra directory depth', path: 'diligaf/x/2026/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a hash index marker', path: `_index/hash/diligaf/${SHA}.txt` },
    { label: 'a review queue entry', path: '_queue/review/diligaf/2026-08-11--omv--91be0d47.json' },
    { label: 'a ledger transaction blob', path: 'personal/2026/08/tx/01J9F2QK7X8-statement.json' },
    { label: 'a state blob', path: '_state/books.json' },
    { label: 'a rollup blob', path: '_rollup/diligaf/2026-08.json' },
    { label: 'a package artefact', path: 'packages/diligaf/2026-07/DILIGAF-2026-07.zip' },
  ])('returns null for $label rather than guessing', ({ path }) => {
    expect(parseBlobPath(path)).toBeNull()
  })
})

// ── fingerprint ──────────────────────────────────────────────────────────────

describe('fingerprint', () => {
  it('reports the injected digest, its first 8 characters and the byte size', () => {
    const hash = fixedHash(SHA)
    expect(fingerprint(new Uint8Array([1, 2, 3, 4, 5]), hash.fn)).toEqual({
      sha256: SHA,
      sha8: SHA8,
      byteSize: 5,
    })
  })

  it('takes sha8 as exactly the first 8 characters of sha256', () => {
    const digest = 'abcdef0123456789'.repeat(4)
    const result = fingerprint(new Uint8Array([0]), fixedHash(digest).fn)
    expect(result.sha8).toBe(digest.slice(0, 8))
    expect(result.sha8).toHaveLength(8)
  })

  it('hashes empty bytes rather than special-casing them', () => {
    const hash = fixedHash(SHA)
    const result = fingerprint(new Uint8Array([]), hash.fn)
    expect(result).toEqual({ sha256: SHA, sha8: SHA8, byteSize: 0 })
    expect(hash.calls).toHaveLength(1)
  })

  it('calls the injected hash exactly once, with the bytes it was given', () => {
    const hash = fixedHash(SHA)
    const bytes = new Uint8Array([9, 8, 7])
    fingerprint(bytes, hash.fn)
    expect(hash.calls).toHaveLength(1)
    expect(Array.from(hash.calls[0]!)).toEqual([9, 8, 7])
  })

  it('counts the view length, not the underlying buffer, for a subarray', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const view = backing.subarray(2, 5)
    expect(fingerprint(view, fixedHash(SHA).fn).byteSize).toBe(3)
  })

  it('reports the byte size of a large payload exactly', () => {
    expect(fingerprint(new Uint8Array(812443), fixedHash(SHA).fn).byteSize).toBe(812443)
  })

  it('is pure: the same bytes and hash fn give the same fingerprint', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(fingerprint(bytes, fixedHash(SHA).fn)).toEqual(fingerprint(bytes, fixedHash(SHA).fn))
  })

  it('produces a sha8 that matches the sha8 embedded in the blob path', () => {
    const fp = fingerprint(new Uint8Array([1]), fixedHash(SHA).fn)
    const path = blobPathFor(baseInput({ sha256: fp.sha256 }))
    expect(parseBlobPath(path)?.sha8).toBe(fp.sha8)
  })
})

// ── extensionFor ─────────────────────────────────────────────────────────────

describe('extensionFor', () => {
  it.each([
    { filename: 'IMG_4821.jpg', mimeType: 'image/jpeg', expected: 'jpg' },
    { filename: 'izvod-265-08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
    { filename: 'scan.png', mimeType: 'image/png', expected: 'png' },
  ])('takes $expected from the filename $filename', ({ filename, mimeType, expected }) => {
    expect(extensionFor(filename, mimeType)).toBe(expected)
  })

  it.each([
    { filename: 'SCAN.PDF', expected: 'pdf' },
    { filename: 'Photo.JPG', expected: 'jpg' },
    { filename: 'Faktura.PdF', expected: 'pdf' },
  ])('lowercases the extension of $filename', ({ filename, expected }) => {
    expect(extensionFor(filename, 'application/octet-stream')).toBe(expected)
  })

  it('takes the last extension of a multi-dot filename', () => {
    expect(extensionFor('izvod.2026.08.pdf', 'application/pdf')).toBe('pdf')
  })

  it.each([
    { mimeType: 'application/pdf', expected: 'pdf' },
    { mimeType: 'image/jpeg', expected: 'jpg' },
    { mimeType: 'image/png', expected: 'png' },
  ])('falls back to the mime type $mimeType when the filename has no extension', ({ mimeType, expected }) => {
    expect(extensionFor('attachment', mimeType)).toBe(expected)
  })

  it('ignores mime type parameters when mapping', () => {
    expect(extensionFor('attachment', 'application/pdf; charset=binary')).toBe('pdf')
  })

  it.each([
    { label: 'both inputs empty', filename: '', mimeType: '' },
    { label: 'a filename ending in a dot', filename: 'receipt.', mimeType: '' },
    { label: 'an unknown mime type and no extension', filename: 'attachment', mimeType: 'application/octet-stream' },
    { label: 'a nonsense mime type', filename: 'attachment', mimeType: 'not/a-real-type' },
    { label: 'a mime type with no slash', filename: 'attachment', mimeType: 'pdf' },
  ])('returns bin for $label', ({ filename, mimeType }) => {
    expect(extensionFor(filename, mimeType)).toBe('bin')
  })

  it.each([
    { filename: '.gitignore', mimeType: '' },
    { filename: 'receipt.xyzzy', mimeType: 'application/pdf' },
    { filename: 'weird name (1).pdf', mimeType: 'application/pdf' },
    { filename: 'нешто.pdf', mimeType: 'application/pdf' },
    { filename: '', mimeType: '' },
  ])('returns a bare lowercase extension for $filename / $mimeType', ({ filename, mimeType }) => {
    const ext = extensionFor(filename, mimeType)
    expect(ext).toMatch(/^[a-z0-9]+$/)
    expect(ext.startsWith('.')).toBe(false)
    expect(ext.length).toBeGreaterThan(0)
  })

  it('produces an extension that blobPathFor can use unchanged', () => {
    const ext = extensionFor('IMG_4821.jpg', 'image/jpeg')
    expect(blobPathFor(baseInput({ extension: ext })).endsWith('.jpg')).toBe(true)
  })
})
