import { describe, it, expect } from 'vitest'
import {
  slugify,
  slugifyOrNull,
  blobPathFor,
  parseBlobPath,
  PLACEHOLDER_SLUG,
  type BlobPathInput,
} from '../../src/engine/documents/blob-path.js'

// ─────────────────────────────────────────────────────────────────────────────
// NEW BEHAVIOUR — not part of the freeze.
//
// TEST-FREEZE.md permits "adding tests for new behaviour that no test covers".
// documents.test.ts pins slugify's total contract and is untouched; this file
// covers two things it never asserts:
//
//   1. Serbian Cyrillic transliteration, so a vendor printing its name in
//      either script resolves to ONE identity.
//   2. slugifyOrNull — the seam letting the ingest pipeline recognise a
//      document that needs its real name asked for over WhatsApp.
//
// Owner decision (2026-08-15): ingest does NOT stop on an underivable name.
// The document is stored under PLACEHOLDER_SLUG, the user is asked afterwards,
// and the blob is renamed and moved when the answer arrives.
// ─────────────────────────────────────────────────────────────────────────────

const SHA = '91be0d47a1c9f3e25b8d4470ac6f1e93d2b7c05a8e14f36092ad7bc4e5f10983'

const base: BlobPathInput = {
  blobPrefix: 'diligaf',
  period: '2026-08',
  category: 'expense',
  docDate: '2026-08-11',
  slugSource: 'OMV Srbija',
  sha256: SHA,
  extension: 'jpg',
}

const input = (patch: Partial<BlobPathInput> = {}): BlobPathInput => ({ ...base, ...patch })

// ── Cyrillic is one vendor, not two ──────────────────────────────────────────

describe('Serbian Cyrillic transliteration', () => {
  it.each([
    { cyrillic: 'Телеком Србија', latin: 'Telekom Srbija', slug: 'telekom-srbija' },
    { cyrillic: 'Картонажа доо', latin: 'Kartonaža doo', slug: 'kartonaza-doo' },
    { cyrillic: 'Јелена доо', latin: 'Jelena doo', slug: 'jelena-doo' },
    { cyrillic: 'ОМВ Србија', latin: 'OMV Srbija', slug: 'omv-srbija' },
  ])('resolves $cyrillic and $latin to the same slug $slug', ({ cyrillic, latin, slug }) => {
    expect(slugify(cyrillic)).toBe(slug)
    expect(slugify(latin)).toBe(slug)
  })

  it('folds Cyrillic ђ the same way Latin đ folds, so Ђорђе matches Đorđe', () => {
    // Consistent with the đ → d (not dj) decision recorded in documents.test.ts.
    expect(slugify('Ђорђе')).toBe('dorde')
    expect(slugify('Ђорђе')).toBe(slugify('Đorđe'))
  })

  it.each(['љ', 'њ', 'џ'])('transliterates the digraph letter %s without breaking the slug shape', (letter) => {
    expect(slugify(`Фирма ${letter}`)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('no longer sends a Cyrillic vendor down the placeholder path', () => {
    expect(slugifyOrNull('Телеком Србија')).not.toBeNull()
    expect(slugify('Телеком Србија')).not.toBe(PLACEHOLDER_SLUG)
  })

  it('stays idempotent once transliterated', () => {
    const once = slugify('Картонажа доо')
    expect(slugify(once)).toBe(once)
  })
})

// ── the seam the ingest pipeline uses ────────────────────────────────────────

describe('slugifyOrNull', () => {
  it.each([
    { label: 'an empty string', source: '' },
    { label: 'whitespace only', source: '   ' },
    { label: 'punctuation only', source: '!!!' },
    { label: 'symbols only', source: '@#$%^&*()' },
    { label: 'dashes only', source: '---' },
    { label: 'emoji only', source: '📄🧾' },
  ])('reports null for $label, so the pipeline knows to ask', ({ source }) => {
    expect(slugifyOrNull(source)).toBeNull()
  })

  it.each(['OMV Srbija', 'Телеком', 'Kartonaža d.o.o.', 'IMG_4821.jpg', '2026'])(
    'returns the slug rather than null for the usable source %s',
    (source) => {
      expect(slugifyOrNull(source)).toBe(slugify(source))
    },
  )

  it('agrees with slugify everywhere except the unusable case', () => {
    expect(slugifyOrNull('Kartonaža doo')).toBe('kartonaza-doo')
    expect(slugifyOrNull('')).toBeNull()
    expect(slugify('')).toBe(PLACEHOLDER_SLUG)
  })
})

// ── ingest completes; the name is chased afterwards ──────────────────────────

describe('placeholder path', () => {
  it('is a well-formed slug, so the path it produces still parses', () => {
    expect(PLACEHOLDER_SLUG).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(slugify(PLACEHOLDER_SLUG)).toBe(PLACEHOLDER_SLUG)
  })

  it('still stores the document rather than refusing it', () => {
    const path = blobPathFor(input({ slugSource: '!!!' }))
    expect(path).toBe(`diligaf/2026/08/expense/2026-08-11--${PLACEHOLDER_SLUG}--91be0d47.jpg`)
    expect(parseBlobPath(path)).not.toBeNull()
  })

  it('keeps two unnamed documents distinct via sha8, so no rename can collide', () => {
    const first = blobPathFor(input({ slugSource: '' }))
    const second = blobPathFor(
      input({ slugSource: '📄', sha256: '3f1a9c22112233445566778899aabbccddeeff00112233445566778899aabbcc' }),
    )
    expect(first).not.toBe(second)
    expect(parseBlobPath(first)?.sha8).toBe('91be0d47')
    expect(parseBlobPath(second)?.sha8).toBe('3f1a9c22')
  })

  it('renames to the real path once the user supplies a name, sha8 unchanged', () => {
    // What the pipeline does when the WhatsApp answer arrives: re-derive the
    // path with the supplied name. The digest is the document's identity, so
    // it survives the move and the dedupe marker stays valid.
    const before = blobPathFor(input({ slugSource: '' }))
    const after = blobPathFor(input({ slugSource: 'Кафе Бар Лав' }))

    expect(before).toContain(`--${PLACEHOLDER_SLUG}--`)
    expect(after).toBe('diligaf/2026/08/expense/2026-08-11--kafe-bar-lav--91be0d47.jpg')
    expect(parseBlobPath(after)?.sha8).toBe(parseBlobPath(before)?.sha8)
  })
})
