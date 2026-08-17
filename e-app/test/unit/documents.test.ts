import { describe, it, expect } from 'vitest'
import {
  blobPathFor,
  slugify,
  sidecarPath,
  hashIndexPath,
  parseBlobPath,
  type BlobPathInput,
} from '../../src/engine/documents/blob-path.js'
import { fingerprint, extensionFor } from '../../src/engine/documents/fingerprint.js'
import type { BookCode, DocCategory } from '../../src/engine/types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Blob paths + fingerprinting — 01-ARCHITECTURE §3 "Storage: blob only".
//
// Document path convention (§3, line 122):
//   {book}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}
//
// Merged from three independent drafts. Where the drafts disagreed the
// resolution is recorded inline as a RESOLVED note.
// ─────────────────────────────────────────────────────────────────────────────

// ── fixtures ─────────────────────────────────────────────────────────────────
// Full 64-hex digests. The first eight characters are the `sha8` that lands in
// a document path.
const SHA = '91be0d47a1c9f3e25b8d4470ac6f1e93d2b7c05a8e14f36092ad7bc4e5f10983'
const SHA8 = '91be0d47'
const SHA_IZVOD = '3f1a9c22112233445566778899aabbccddeeff00112233445566778899aabbcc'
const SHA_FAKTURA = 'c40a1e88aabbccddeeff00112233445566778899aabbccddeeff001122334455'
const SHA_STATEMENT = '02cc9a51ffeeddccbbaa998877665544332211000123456789abcdef01234567'
const SHA_KARTONAZA = 'd19f7b30ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544'

const ALL_CATEGORIES: DocCategory[] = [
  'izvod',
  'statement',
  'expense',
  'invoice_out',
  'sef_inbound',
  'other',
]

const ALL_PREFIXES = ['diligaf', 'personal', 'smoqua']

/** A well-formed slug: lowercase alphanumerics joined by single inner dashes. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A well-formed document path: four directory segments, then the filename. */
const PATH_SHAPE =
  /^[a-z0-9-]+\/\d{4}\/\d{2}\/[a-z_]+\/\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*--[0-9a-f]{8}\.[a-z0-9]+$/

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

/** The `{YYYY}/{MM}` directory a path actually landed in, rendered as `YYYY-MM`. */
function directoryPeriodOf(path: string): string {
  const parts = path.split('/')
  return `${parts[1]}-${parts[2]}`
}

// ── hand-written fakes (no mocking library) ──────────────────────────────────

/** A hash fn that always answers the same digest and records what it was asked. */
function fakeSha256(digest: string) {
  const calls: Uint8Array[] = []
  const fn = (bytes: Uint8Array): string => {
    calls.push(bytes)
    return digest
  }
  return { fn, calls }
}

// ─────────────────────────────────────────────────────────────────────────────
// blobPathFor
// ─────────────────────────────────────────────────────────────────────────────

describe('blobPathFor', () => {
  it('builds {prefix}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}', () => {
    expect(blobPathFor(OMV)).toBe('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')
  })

  it("dates the file on the period's first day when docDate is null", () => {
    expect(blobPathFor(input({ docDate: null }))).toBe(
      'diligaf/2026/08/expense/2026-08-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('uses the first day of the period even for a 31-day month when docDate is null', () => {
    expect(blobPathFor(input({ period: '2026-12', docDate: null }))).toBe(
      'diligaf/2026/12/expense/2026-12-01--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the previous month under the period, not its own month', () => {
    // A 31 July receipt photographed in August, filed to the August period.
    expect(blobPathFor(input({ period: '2026-08', docDate: '2026-07-31' }))).toBe(
      'diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the following month under the period, not its own month', () => {
    expect(blobPathFor(input({ period: '2026-08', docDate: '2026-09-02' }))).toBe(
      'diligaf/2026/08/expense/2026-09-02--omv-srbija--91be0d47.jpg',
    )
  })

  it('files a document dated in the previous year under the period year', () => {
    expect(
      blobPathFor(
        input({
          blobPrefix: 'personal',
          category: 'statement',
          period: '2026-01',
          docDate: '2025-12-31',
        }),
      ),
    ).toBe('personal/2026/01/statement/2025-12-31--omv-srbija--91be0d47.jpg')
  })

  it.each([
    { label: 'docDate matches the period', period: '2026-08', docDate: '2026-08-11' },
    { label: 'docDate is absent', period: '2026-08', docDate: null },
    { label: 'docDate is one day before the period', period: '2026-08', docDate: '2026-07-31' },
    { label: 'docDate is one day after the period', period: '2026-08', docDate: '2026-09-01' },
    { label: 'docDate is a year earlier', period: '2026-01', docDate: '2025-12-31' },
    { label: 'docDate is a year later', period: '2026-12', docDate: '2027-01-05' },
    { label: 'docDate is months away', period: '2026-03', docDate: '2026-11-09' },
    { label: 'docDate is a leap day from another year', period: '2026-02', docDate: '2024-02-29' },
    { label: 'the period is January', period: '2026-01', docDate: null },
    { label: 'the period is December', period: '2026-12', docDate: null },
    { label: 'the period is far in the future', period: '2030-02', docDate: '2029-02-28' },
  ])(
    'puts YYYY/MM equal to $period in the directory when $label (§3: the YYYY/MM in the path always equals the period)',
    ({ period, docDate }) => {
      expect(directoryPeriodOf(blobPathFor(input({ period, docDate })))).toBe(period)
    },
  )

  it.each(ALL_CATEGORIES)('places a %s document in its own category folder', (category) => {
    expect(blobPathFor(input({ category }))).toBe(
      `diligaf/2026/08/${category}/2026-08-11--omv-srbija--91be0d47.jpg`,
    )
  })

  it.each(ALL_PREFIXES)('roots the path at the %s blob prefix', (blobPrefix) => {
    expect(blobPathFor(input({ blobPrefix })).startsWith(`${blobPrefix}/2026/08/`)).toBe(true)
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

  it('produces exactly four directory segments before the filename', () => {
    expect(blobPathFor(OMV).split('/')).toHaveLength(5)
  })

  it('separates the date, slug and sha8 with double dashes', () => {
    expect(blobPathFor(input({ slugSource: 'Izvod 265/08' })).split('/')[4]).toBe(
      '2026-08-11--izvod-265-08--91be0d47.jpg',
    )
  })

  it('uses only the first 8 characters of the sha256 in the filename', () => {
    const path = blobPathFor(OMV)
    expect(path.endsWith(`--${SHA8}.jpg`)).toBe(true)
    expect(path).not.toContain(SHA)
  })

  it('shortens a different digest to its own first eight characters', () => {
    expect(blobPathFor(input({ sha256: SHA_IZVOD })).endsWith('--3f1a9c22.jpg')).toBe(true)
  })

  it('gives two documents with the same slug and date distinct paths via sha8', () => {
    expect(blobPathFor(OMV)).not.toBe(blobPathFor(input({ sha256: SHA_IZVOD })))
  })

  it.each([
    { extension: 'jpg', expected: '.jpg' },
    { extension: 'pdf', expected: '.pdf' },
    { extension: 'png', expected: '.png' },
    { extension: 'bin', expected: '.bin' },
  ])('appends .$extension as the file extension', ({ extension, expected }) => {
    expect(blobPathFor(input({ extension })).endsWith(expected)).toBe(true)
  })

  it('places the extension last, after a single dot', () => {
    expect(blobPathFor(input({ extension: 'pdf' }))).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.pdf',
    )
  })

  it.each([
    { slugSource: 'DOO "Kartonaža"/Beograd', slug: 'doo-kartonaza-beograd' },
    { slugSource: 'Kartonaža d.o.o.', slug: 'kartonaza-d-o-o' },
    { slugSource: 'IMG_4821.jpg', slug: 'img-4821-jpg' },
  ])('slugifies $slugSource into $slug rather than trusting it verbatim', ({ slugSource, slug }) => {
    expect(blobPathFor(input({ slugSource }))).toBe(
      `diligaf/2026/08/expense/2026-08-11--${slug}--91be0d47.jpg`,
    )
  })

  it('caps the slug inside the path at 40 characters', () => {
    expect(blobPathFor(input({ slugSource: 'x'.repeat(80) }))).toBe(
      `diligaf/2026/08/expense/2026-08-11--${'x'.repeat(40)}--91be0d47.jpg`,
    )
  })

  it('still produces a well-formed, parseable path when the slug source is empty', () => {
    const path = blobPathFor(input({ slugSource: '' }))
    expect(path).toMatch(PATH_SHAPE)
    expect(path).not.toContain('----')
    expect(parseBlobPath(path)).not.toBeNull()
  })

  it('never emits a leading slash or a double slash', () => {
    const path = blobPathFor(input({ slugSource: '///' }))
    expect(path.startsWith('/')).toBe(false)
    expect(path).not.toContain('//')
  })

  it.each([
    { label: 'a Serbian vendor name', slugSource: 'KARTONAŽA DOO', sha256: SHA_KARTONAZA },
    { label: 'an invoice number', slugSource: 'Faktura 0007/2026', sha256: SHA_FAKTURA },
    { label: 'a very long vendor name', slugSource: 'A'.repeat(120), sha256: SHA_IZVOD },
    { label: 'punctuation only', slugSource: '---', sha256: SHA },
    { label: 'symbols only', slugSource: '!!! ??? ...', sha256: SHA },
    { label: 'an empty source', slugSource: '', sha256: SHA },
  ])('produces a path matching the convention for $label', ({ slugSource, sha256 }) => {
    expect(blobPathFor(input({ slugSource, sha256 }))).toMatch(PATH_SHAPE)
  })

  // The four document lines listed verbatim in 01-ARCHITECTURE §3 Layout.
  it.each([
    {
      label: 'a DILIGAF izvod',
      patch: {
        category: 'izvod' as DocCategory,
        docDate: '2026-08-05',
        slugSource: 'IZVOD 265/08',
        sha256: SHA_IZVOD,
        extension: 'pdf',
      },
      expected: 'diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf',
    },
    {
      label: 'a DILIGAF outgoing invoice',
      patch: {
        category: 'invoice_out' as DocCategory,
        docDate: '2026-08-01',
        slugSource: 'Faktura 0007/2026',
        sha256: SHA_FAKTURA,
        extension: 'pdf',
      },
      expected: 'diligaf/2026/08/invoice_out/2026-08-01--faktura-0007-2026--c40a1e88.pdf',
    },
    {
      label: 'a PERSONAL statement',
      patch: {
        blobPrefix: 'personal',
        category: 'statement' as DocCategory,
        docDate: '2026-08-01',
        slugSource: 'izvod tekuci jul',
        sha256: SHA_STATEMENT,
        extension: 'pdf',
      },
      expected: 'personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf',
    },
    {
      label: 'a SMOQUA expense',
      patch: {
        blobPrefix: 'smoqua',
        category: 'expense' as DocCategory,
        docDate: '2026-08-03',
        slugSource: 'Kartonaža doo',
        sha256: SHA_KARTONAZA,
        extension: 'pdf',
      },
      expected: 'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.pdf',
    },
  ])('reproduces the §3 Layout example for $label', ({ patch, expected }) => {
    expect(blobPathFor(input(patch))).toBe(expected)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// slugify
// ─────────────────────────────────────────────────────────────────────────────

describe('slugify', () => {
  it.each([
    { source: 'OMV Srbija', expected: 'omv-srbija' },
    { source: 'OMV SRBIJA', expected: 'omv-srbija' },
    { source: 'Telekom Srbija', expected: 'telekom-srbija' },
    { source: 'Wolt Beograd', expected: 'wolt-beograd' },
    { source: 'lowercase', expected: 'lowercase' },
    { source: 'omv-srbija', expected: 'omv-srbija' },
    { source: '2026', expected: '2026' },
  ])('lowercases $source and joins its words with a single dash', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  // RESOLVED (2-of-3): 'đ' folds to 'd', not 'dj'. The spec says only
  // "ASCII-fold Serbian diacritics" and gives no đ example, so the majority
  // reading wins. Recorded as a spec gap — see the summary.
  it.each([
    { source: 'Čačak', expected: 'cacak' },
    { source: 'Ćuprija', expected: 'cuprija' },
    { source: 'Šabac', expected: 'sabac' },
    { source: 'Šećer', expected: 'secer' },
    { source: 'Žitište', expected: 'zitiste' },
    { source: 'Živojin', expected: 'zivojin' },
    { source: 'Đorđe', expected: 'dorde' },
    { source: 'čćžšđ', expected: 'cczsd' },
    { source: 'ČĆŽŠĐ', expected: 'cczsd' },
    { source: 'Užice Šped', expected: 'uzice-sped' },
    { source: 'KARTONAŽA DOO', expected: 'kartonaza-doo' },
    { source: 'Preduzeće Bačka', expected: 'preduzece-backa' },
    { source: 'Kartonaža d.o.o.', expected: 'kartonaza-d-o-o' },
    { source: 'Preduzeće "Đačko Ćoše" d.o.o.', expected: 'preduzece-dacko-cose-d-o-o' },
  ])('folds the Serbian diacritics in $source to $expected', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  it.each([
    { label: 'repeated spaces', source: 'a  b', expected: 'a-b' },
    { label: 'long runs of spaces', source: 'OMV    Srbija', expected: 'omv-srbija' },
    { label: 'tabs and newlines', source: 'omv\tsrbija\nbg', expected: 'omv-srbija-bg' },
    { label: 'dots', source: 'a....b', expected: 'a-b' },
    { label: 'a dot-separated abbreviation', source: 'd.o.o.', expected: 'd-o-o' },
    { label: 'underscores', source: 'a_b', expected: 'a-b' },
    { label: 'underscores around digits', source: 'IMG_4821_scan', expected: 'img-4821-scan' },
    { label: 'a slash', source: 'Izvod 265/08', expected: 'izvod-265-08' },
    { label: 'slashes and backslashes', source: 'a/b\\c', expected: 'a-b-c' },
    { label: 'a hash and a slash', source: 'Faktura #0007/2026', expected: 'faktura-0007-2026' },
    { label: 'an ampersand', source: 'a & b', expected: 'a-b' },
    { label: 'an ampersand between words', source: 'Petar & Sinovi', expected: 'petar-sinovi' },
    { label: 'quotes', source: '"Bačka"', expected: 'backa' },
    { label: 'a double dash', source: 'a--b', expected: 'a-b' },
    { label: 'runs of dashes', source: 'omv---srbija', expected: 'omv-srbija' },
    { label: 'spaced dashes', source: 'a - - b', expected: 'a-b' },
    { label: 'mixed punctuation runs', source: 'a  --  b', expected: 'a-b' },
  ])('collapses $label into a single dash', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  it.each([
    { source: '-omv-', expected: 'omv' },
    { source: '--omv--', expected: 'omv' },
    { source: '---omv', expected: 'omv' },
    { source: 'omv---', expected: 'omv' },
    { source: '  omv  ', expected: 'omv' },
    { source: '...omv...', expected: 'omv' },
    { source: '/omv/', expected: 'omv' },
    { source: '///slashes///', expected: 'slashes' },
    { source: '  ...Trim!!!  ', expected: 'trim' },
    { source: '  !!!omv srbija!!!  ', expected: 'omv-srbija' },
  ])('trims the leading and trailing separators from $source', ({ source, expected }) => {
    expect(slugify(source)).toBe(expected)
  })

  it('leaves a slug that is exactly 40 characters untouched', () => {
    const forty = 'a'.repeat(40)
    expect(slugify(forty)).toBe(forty)
    expect(slugify(forty)).toHaveLength(40)
  })

  it('caps a 41-character slug at exactly 40 characters', () => {
    expect(slugify('a'.repeat(41))).toBe('a'.repeat(40))
  })

  it('applies the 40-character cap after folding diacritics, not before', () => {
    // 50 two-byte characters fold to 50 ASCII characters, then cap to 40.
    expect(slugify('č'.repeat(50))).toBe('c'.repeat(40))
  })

  it('never leaves a trailing dash when the cap lands on a separator', () => {
    // 39 letters, then a separator: cutting at 40 would end on the dash.
    const slug = slugify(`${'a'.repeat(39)} bbbbb`)
    expect(slug).toBe('a'.repeat(39))
    expect(slug.endsWith('-')).toBe(false)
  })

  it('cuts mid-word rather than exceeding the cap', () => {
    // Consistent with the unanimous single-word rule above: a hard cut at 40,
    // then a trailing dash (if any) trimmed. See spec gap on truncation strategy.
    const slug = slugify('aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd')
    expect(slug).toBe('aaaaaaaaaa-bbbbbbbbbb-cccccccccc-ddddddd')
    expect(slug).toHaveLength(40)
  })

  it.each([
    { label: 'a long Serbian company name', source: 'Preduzeće za proizvodnju i promet Kartonaža Bačka doo Novi Sad' },
    { label: 'a long run of words', source: 'one two three four five six seven eight nine ten eleven twelve' },
    { label: 'a long single word', source: 'z'.repeat(200) },
    { label: 'a long punctuated string', source: 'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z' },
    { label: 'a long ASCII vendor name', source: 'Preduzece za proizvodnju i promet kartonaze doo Beograd' },
  ])('caps $label at forty characters with no dangling dash', ({ source }) => {
    const slug = slugify(source)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toMatch(SLUG_SHAPE)
  })

  it.each([
    { label: 'an empty string', source: '' },
    { label: 'only whitespace', source: '   ' },
    { label: 'only punctuation', source: '!!!' },
    { label: 'only punctuation and slashes', source: '!!!///...' },
    { label: 'a lone dash', source: '-' },
    { label: 'only dashes', source: '---' },
    { label: 'only symbols', source: '@#$%^&*()' },
    { label: 'only emoji', source: '📄🧾' },
    { label: 'Cyrillic only', source: 'Телеком Србија' },
  ])('returns a non-empty, well-formed fallback slug for $label', ({ source }) => {
    const slug = slugify(source)
    expect(slug.length).toBeGreaterThan(0)
    expect(slug).toMatch(SLUG_SHAPE)
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('uses one and the same fallback for every input that reduces to nothing', () => {
    const fallback = slugify('')
    expect(slugify('   ')).toBe(fallback)
    expect(slugify('!!!')).toBe(fallback)
    expect(slugify('###')).toBe(fallback)
    expect(slugify('---')).toBe(fallback)
    expect(slugify('@#$%^&*()')).toBe(fallback)
  })

  it.each(['Šećer', 'Kartonaža d.o.o.', '-- Faktura 0007/2026 --', '!!!', '', 'a'.repeat(120)])(
    'is idempotent for %s',
    (source) => {
      expect(slugify(slugify(source))).toBe(slugify(source))
    },
  )

  it.each([
    'Čačak Ćuprija Žitište Šabac Đorđe',
    'DOO "Kartonaža"/Beograd, 11000',
    'Šećer & Со',
    'Preduzeće za proizvodnju i promet Kartonaža doo',
    'a'.repeat(100),
    '📄 receipt.jpg',
    '🧾',
  ])('emits only lowercase ASCII, digits and inner dashes for %s', (source) => {
    const slug = slugify(source)
    expect(slug).toMatch(SLUG_SHAPE)
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('drops an emoji rather than letting it break the slug', () => {
    expect(slugify('Račun 🧾 2026')).toBe('racun-2026')
  })

  it('does not let a non-Serbian accent produce an invalid slug', () => {
    // Whether é folds to "e" or is dropped is unspecified; the slug must stay
    // well-formed either way, and the surrounding ASCII must survive.
    const slug = slugify('Café Bar')
    expect(slug).toMatch(SLUG_SHAPE)
    expect(slug.startsWith('caf')).toBe(true)
  })

  it('does not let Cyrillic input produce an empty slug', () => {
    expect(slugify('Јелена доо')).toMatch(SLUG_SHAPE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// sidecarPath
// ─────────────────────────────────────────────────────────────────────────────

describe('sidecarPath', () => {
  // RESOLVED (unanimous, and the spec agrees): the sidecar APPENDS '.json' to
  // the full document path — 01-ARCHITECTURE §6 line 384 `blob.put(path +
  // '.json', facts)`, the JSDoc on sidecarPath ("same path + '.json'"), and
  // 06-TDD-STRATEGY line 148 ('…--91be0d47.jpg.json'). The §3 Layout listing
  // shows the extension replaced; that listing is the documentation defect.
  it('appends .json to the document path, keeping the original extension', () => {
    expect(sidecarPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toBe(
      'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg.json',
    )
  })

  it.each([
    'diligaf/2026/08/izvod/2026-08-05--izvod-265-08--3f1a9c22.pdf',
    'diligaf/2026/08/invoice_out/2026-08-01--faktura-0007-2026--c40a1e88.pdf',
    'personal/2026/08/statement/2026-08-01--izvod-tekuci-jul--02cc9a51.pdf',
    'smoqua/2026/08/expense/2026-08-03--kartonaza-doo--d19f7b30.png',
  ])('sits next to %s in the same folder', (path) => {
    const sidecar = sidecarPath(path)
    expect(sidecar).toBe(`${path}.json`)
    expect(sidecar.slice(0, sidecar.lastIndexOf('/'))).toBe(path.slice(0, path.lastIndexOf('/')))
  })

  it('is the sidecar of whatever blobPathFor produced', () => {
    const path = blobPathFor(OMV)
    expect(sidecarPath(path)).toBe(`${path}.json`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hashIndexPath
// ─────────────────────────────────────────────────────────────────────────────

describe('hashIndexPath', () => {
  // RESOLVED (unanimous): lowercase book folder and a '.txt' suffix, per the
  // §3 Layout line `_index/hash/diligaf/91be0d47a1…c9.txt`. The §2 table writes
  // it as `_index/hash/{book}/{sha256}` with no suffix — recorded as a spec gap.
  it.each<{ book: BookCode; folder: string }>([
    { book: 'DILIGAF', folder: 'diligaf' },
    { book: 'PERSONAL', folder: 'personal' },
    { book: 'SMOQUA', folder: 'smoqua' },
  ])('writes the $book dedupe marker under _index/hash/$folder', ({ book, folder }) => {
    expect(hashIndexPath(book, SHA)).toBe(`_index/hash/${folder}/${SHA}.txt`)
  })

  it('keys the marker by the full sha256, not the shortened sha8', () => {
    const path = hashIndexPath('DILIGAF', SHA)
    expect(path).toContain(SHA)
    expect(path).not.toBe(`_index/hash/diligaf/${SHA8}.txt`)
  })

  it('scopes dedupe per book, so the same content in two books gets two markers', () => {
    expect(hashIndexPath('DILIGAF', SHA)).not.toBe(hashIndexPath('PERSONAL', SHA))
  })

  it('gives one book different markers for different content', () => {
    expect(hashIndexPath('DILIGAF', SHA)).not.toBe(hashIndexPath('DILIGAF', SHA_IZVOD))
  })

  it('is stable across calls for the same book and digest', () => {
    expect(hashIndexPath('SMOQUA', SHA)).toBe(hashIndexPath('SMOQUA', SHA))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// parseBlobPath
// ─────────────────────────────────────────────────────────────────────────────

describe('parseBlobPath', () => {
  it('reads the prefix, period, category and sha8 out of a document path', () => {
    expect(parseBlobPath('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it('reads the period from the directory, not from the date in the filename', () => {
    // The document is dated 31 July but was filed into the August period.
    expect(parseBlobPath('diligaf/2026/08/expense/2026-07-31--omv-srbija--91be0d47.jpg')).toEqual({
      prefix: 'diligaf',
      period: '2026-08',
      category: 'expense',
      sha8: '91be0d47',
    })
  })

  it('joins the year and month directory segments with a dash to form the period', () => {
    expect(parseBlobPath('personal/2026/01/statement/2026-01-01--izvod--3f1a9c22.pdf')?.period).toBe(
      '2026-01',
    )
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

  it.each(ALL_PREFIXES)('recognises the %s prefix', (prefix) => {
    expect(
      parseBlobPath(`${prefix}/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg`)?.prefix,
    ).toBe(prefix)
  })

  it.each<{ label: string; patch: Partial<BlobPathInput> }>([
    { label: 'a receipt photo', patch: {} },
    { label: 'a document with no docDate', patch: { docDate: null } },
    { label: 'a docDate outside the period', patch: { period: '2026-08', docDate: '2026-07-31' } },
    {
      label: 'a January document dated in the previous year',
      patch: { period: '2026-01', docDate: '2025-12-31' },
    },
    { label: 'a December period', patch: { period: '2026-12', docDate: '2027-01-03' } },
    {
      label: 'a personal statement',
      patch: {
        blobPrefix: 'personal',
        category: 'statement',
        extension: 'pdf',
        sha256: SHA_STATEMENT,
      },
    },
    {
      label: 'a smoqua expense',
      patch: {
        blobPrefix: 'smoqua',
        slugSource: 'Kartonaža doo',
        sha256: SHA_KARTONAZA,
        extension: 'pdf',
      },
    },
    {
      label: 'an outgoing invoice',
      patch: {
        category: 'invoice_out',
        slugSource: 'Faktura 0007/2026',
        sha256: SHA_FAKTURA,
        extension: 'pdf',
      },
    },
    {
      label: 'a SEF inbound document',
      patch: { category: 'sef_inbound', slugSource: 'Telekom Srbija', extension: 'pdf' },
    },
    { label: 'a document in the other category', patch: { category: 'other' } },
    { label: 'an unusable slug source', patch: { slugSource: '!!!' } },
    { label: 'an empty slug source', patch: { slugSource: '' } },
    { label: 'an over-long slug source', patch: { slugSource: 'x'.repeat(100) } },
  ])('round-trips a path built by blobPathFor for $label', ({ patch }) => {
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
    { label: 'a directory with no filename', path: 'diligaf/2026/08/expense' },
    {
      label: 'a path with no extension',
      path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47',
    },
    {
      label: 'a missing category segment',
      path: 'diligaf/2026/08/2026-08-11--omv-srbija--91be0d47.jpg',
    },
    { label: 'a missing filename date', path: 'diligaf/2026/08/expense/omv-srbija--91be0d47.jpg' },
    { label: 'a missing slug', path: 'diligaf/2026/08/expense/2026-08-11--91be0d47.jpg' },
    {
      label: 'a missing sha8 segment',
      path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija.jpg',
    },
    {
      label: 'single-dash separators',
      path: 'diligaf/2026/08/expense/2026-08-11-omv-srbija-91be0d47.jpg',
    },
    { label: 'a month of 13', path: 'diligaf/2026/13/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a month of 00', path: 'diligaf/2026/00/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'an unpadded month', path: 'diligaf/2026/8/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a non-numeric month', path: 'diligaf/2026/aug/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a two-digit year', path: 'diligaf/26/08/expense/2026-08-11--omv--91be0d47.jpg' },
    { label: 'a non-numeric year', path: 'diligaf/20xx/08/expense/2026-08-11--omv--91be0d47.jpg' },
    {
      label: 'a seven-character sha8',
      path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d4.jpg',
    },
    {
      label: 'a nine-character sha8',
      path: 'diligaf/2026/08/expense/2026-08-11--omv--91be0d47a.jpg',
    },
    { label: 'a non-hex sha8', path: 'diligaf/2026/08/expense/2026-08-11--omv--zzzzzzzz.jpg' },
    {
      label: 'an unpadded date in the filename',
      path: 'diligaf/2026/08/expense/2026-8-11--omv--91be0d47.jpg',
    },
    {
      label: 'a day-first date in the filename',
      path: 'diligaf/2026/08/expense/11-08-2026--omv--91be0d47.jpg',
    },
    {
      label: 'a leading slash',
      path: '/diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg',
    },
    {
      label: 'a trailing slash',
      path: 'diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg/',
    },
    {
      label: 'extra directory depth',
      path: 'diligaf/x/2026/08/expense/2026-08-11--omv--91be0d47.jpg',
    },
    {
      label: 'an extra nested segment',
      path: 'diligaf/2026/08/expense/x/2026-08-11--omv--91be0d47.jpg',
    },
    {
      label: 'an extra leading segment',
      path: 'e-docs/diligaf/2026/08/expense/2026-08-11--omv--91be0d47.jpg',
    },
    { label: 'a ledger transaction blob', path: 'personal/2026/08/tx/01J9F2QK7X8-statement.json' },
    { label: 'a hash index marker', path: `_index/hash/diligaf/${SHA}.txt` },
    { label: 'a review queue pointer', path: '_queue/review/diligaf/2026-08-11--omv--91be0d47.json' },
    { label: 'a state blob', path: '_state/books.json' },
    { label: 'a rollup blob', path: '_rollup/diligaf/2026-08.json' },
    { label: 'a package artefact', path: 'packages/diligaf/2026-07/DILIGAF-2026-07.zip' },
  ])('returns null for $label rather than guessing', ({ path }) => {
    expect(parseBlobPath(path)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe('fingerprint', () => {
  it('reports the injected digest, its first 8 characters and the byte size', () => {
    const hash = fakeSha256(SHA)
    expect(fingerprint(Uint8Array.from([1, 2, 3, 4, 5]), hash.fn)).toEqual({
      sha256: SHA,
      sha8: SHA8,
      byteSize: 5,
    })
  })

  it.each([
    { digest: SHA, sha8: '91be0d47' },
    { digest: SHA_IZVOD, sha8: '3f1a9c22' },
    { digest: SHA_FAKTURA, sha8: 'c40a1e88' },
    { digest: SHA_KARTONAZA, sha8: 'd19f7b30' },
  ])('shortens the digest starting $sha8 to exactly those eight characters', ({ digest, sha8 }) => {
    const fp = fingerprint(Uint8Array.from([7]), fakeSha256(digest).fn)
    expect(fp.sha8).toBe(sha8)
    expect(fp.sha8).toHaveLength(8)
  })

  it('hashes empty bytes rather than special-casing them', () => {
    const hash = fakeSha256(SHA)
    const fp = fingerprint(new Uint8Array(0), hash.fn)
    expect(fp).toEqual({ sha256: SHA, sha8: SHA8, byteSize: 0 })
    expect(hash.calls).toHaveLength(1)
  })

  it('calls the injected hash exactly once, with the bytes it was given', () => {
    const hash = fakeSha256(SHA)
    fingerprint(Uint8Array.from([9, 8, 7, 6]), hash.fn)
    expect(hash.calls).toHaveLength(1)
    expect(Array.from(hash.calls[0] ?? [])).toEqual([9, 8, 7, 6])
  })

  it('counts the view length, not the underlying buffer, for a subarray', () => {
    const backing = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    expect(fingerprint(backing.subarray(2, 5), fakeSha256(SHA).fn).byteSize).toBe(3)
  })

  it('counts the view length for a Uint8Array constructed over an offset window', () => {
    const view = new Uint8Array(new ArrayBuffer(1024), 16, 40)
    expect(fingerprint(view, fakeSha256(SHA).fn).byteSize).toBe(40)
  })

  it('reports the byte size of a large payload exactly', () => {
    expect(fingerprint(new Uint8Array(812443), fakeSha256(SHA).fn).byteSize).toBe(812443)
  })

  it('is pure: the same bytes and the same digest give the same fingerprint', () => {
    const bytes = Uint8Array.from([1, 2, 3])
    expect(fingerprint(bytes, fakeSha256(SHA).fn)).toEqual(fingerprint(bytes, fakeSha256(SHA).fn))
  })

  it('keeps sha8 a prefix of sha256 even when the hasher answers in uppercase', () => {
    // Case normalisation is unspecified; the prefix relation must hold either way.
    const fp = fingerprint(Uint8Array.from([1]), fakeSha256(SHA.toUpperCase()).fn)
    expect(fp.sha8.toLowerCase()).toBe(SHA8)
    expect(fp.sha256.toLowerCase().startsWith(fp.sha8.toLowerCase())).toBe(true)
  })

  it('produces the sha8 that blobPathFor puts in the filename', () => {
    const fp = fingerprint(Uint8Array.from([1, 2]), fakeSha256(SHA_KARTONAZA).fn)
    const path = blobPathFor(input({ sha256: fp.sha256 }))
    expect(path).toContain(`--${fp.sha8}.jpg`)
    expect(parseBlobPath(path)?.sha8).toBe(fp.sha8)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extensionFor
// ─────────────────────────────────────────────────────────────────────────────

describe('extensionFor', () => {
  it.each([
    { filename: 'IMG_4821.jpg', mimeType: 'image/jpeg', expected: 'jpg' },
    { filename: 'izvod-265-08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
    { filename: 'scan.png', mimeType: 'image/png', expected: 'png' },
  ])('reads $expected from the filename $filename', ({ filename, mimeType, expected }) => {
    expect(extensionFor(filename, mimeType)).toBe(expected)
  })

  it.each([
    { filename: 'SCAN.PDF', expected: 'pdf' },
    { filename: 'FAKTURA.PDF', expected: 'pdf' },
    { filename: 'Photo.JPG', expected: 'jpg' },
    { filename: 'Faktura.PdF', expected: 'pdf' },
  ])('lowercases the extension of $filename', ({ filename, expected }) => {
    expect(extensionFor(filename, 'application/octet-stream')).toBe(expected)
  })

  it('returns the extension without a leading dot', () => {
    expect(extensionFor('izvod.pdf', 'application/pdf').startsWith('.')).toBe(false)
  })

  it.each([
    { filename: 'izvod.2026.08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
    { filename: 'racun.2026.08.pdf', mimeType: 'application/pdf', expected: 'pdf' },
    { filename: 'arhiva.tar.gz', mimeType: 'application/gzip', expected: 'gz' },
  ])('takes only the last extension of $filename', ({ filename, mimeType, expected }) => {
    expect(extensionFor(filename, mimeType)).toBe(expected)
  })

  it.each([
    { filename: 'receipt.jpg', mimeType: 'application/pdf', expected: 'jpg' },
    { filename: 'scan.png', mimeType: 'application/pdf', expected: 'png' },
  ])(
    'prefers the filename extension $expected over the disagreeing mime type $mimeType',
    ({ filename, mimeType, expected }) => {
      expect(extensionFor(filename, mimeType)).toBe(expected)
    },
  )

  it.each([
    { mimeType: 'application/pdf', expected: 'pdf' },
    { mimeType: 'image/jpeg', expected: 'jpg' },
    { mimeType: 'image/png', expected: 'png' },
  ])(
    'falls back to $expected from the mime type $mimeType when the filename has no extension',
    ({ mimeType, expected }) => {
      expect(extensionFor('scan', mimeType)).toBe(expected)
    },
  )

  it('maps image/jpeg to jpg, not jpeg', () => {
    expect(extensionFor('attachment', 'image/jpeg')).toBe('jpg')
  })

  it('falls back to the mime type when the filename is empty', () => {
    expect(extensionFor('', 'application/pdf')).toBe('pdf')
  })

  it('falls back to the mime type when the filename ends in a dot', () => {
    expect(extensionFor('scan.', 'application/pdf')).toBe('pdf')
  })

  // RESOLVED: "Unknown -> 'bin'" in the JSDoc implies a known-type allow-list,
  // and all three drafts agree an unknown MIME type yields 'bin'. The coherent
  // (and safer) extension of that rule is that an unrecognised filename
  // extension is not trusted verbatim either — it yields to a recognised mime
  // type. Recorded as a spec gap: the type table itself is undocumented.
  it('falls back to the mime type when the filename extension is not a known type', () => {
    expect(extensionFor('receipt.xyzzy', 'image/jpeg')).toBe('jpg')
  })

  it('ignores mime type parameters when mapping', () => {
    expect(extensionFor('scan', 'application/pdf; charset=binary')).toBe('pdf')
    expect(extensionFor('scan', 'image/jpeg; charset=binary')).toBe('jpg')
  })

  it('accepts an upper-case mime type', () => {
    expect(extensionFor('scan', 'APPLICATION/PDF')).toBe('pdf')
  })

  it.each([
    { label: 'both inputs empty', filename: '', mimeType: '' },
    { label: 'no extension and no mime type', filename: 'receipt', mimeType: '' },
    { label: 'a filename ending in a dot and no mime type', filename: 'scan.', mimeType: '' },
    { label: 'whitespace only', filename: '   ', mimeType: '   ' },
    { label: 'the generic octet-stream', filename: 'blob', mimeType: 'application/octet-stream' },
    { label: 'an unknown mime type', filename: 'scan', mimeType: 'application/x-unknown-thing' },
    { label: 'a nonsense mime type', filename: 'attachment', mimeType: 'not/a-real-type' },
    { label: 'a mime type with no slash', filename: 'attachment', mimeType: 'pdf' },
    {
      label: 'an unknown filename extension and an unknown mime type',
      filename: 'thing.xyzzy',
      mimeType: 'application/x-nonsense',
    },
    { label: 'a dotfile with no mime type', filename: '.gitignore', mimeType: '' },
  ])('returns bin for $label rather than guessing', ({ filename, mimeType }) => {
    expect(extensionFor(filename, mimeType)).toBe('bin')
  })

  it.each([
    { filename: '.gitignore', mimeType: '' },
    { filename: 'receipt.xyzzy', mimeType: 'application/pdf' },
    { filename: 'weird name (1).pdf', mimeType: 'application/pdf' },
    { filename: 'нешто.pdf', mimeType: 'application/pdf' },
    { filename: '', mimeType: '' },
  ])(
    'returns a bare, non-empty lowercase token for $filename / $mimeType',
    ({ filename, mimeType }) => {
      const ext = extensionFor(filename, mimeType)
      expect(ext).toMatch(/^[a-z0-9]+$/)
      expect(ext.length).toBeGreaterThan(0)
    },
  )

  it('produces an extension that blobPathFor can use unchanged', () => {
    const ext = extensionFor('IMG_4821.jpg', 'image/jpeg')
    const path = blobPathFor(input({ extension: ext }))
    expect(path).toMatch(PATH_SHAPE)
    expect(path).toBe('diligaf/2026/08/expense/2026-08-11--omv-srbija--91be0d47.jpg')
  })
})
