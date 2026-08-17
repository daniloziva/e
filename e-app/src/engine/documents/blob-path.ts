import type { BookCode, DocCategory } from '../types.js'

export interface BlobPathInput {
  blobPrefix: string      // 'diligaf' | 'personal' | 'smoqua'
  period: string          // 'YYYY-MM'
  category: DocCategory
  docDate: string | null  // YYYY-MM-DD; falls back to period's first day
  slugSource: string      // vendor name or filename
  sha256: string
  extension: string       // without the dot
}

/** Longest slug that may appear in a filename. */
const SLUG_MAX_LENGTH = 40

/**
 * Marks a document whose name could not be derived — the source was empty,
 * punctuation only, or emoji only. Ingest does NOT stop for this: the document
 * is stored under this token, queued, and the real name is asked for over
 * WhatsApp afterwards, at which point the blob is renamed and moved.
 *
 * DELIBERATELY FIXED, not random or numbered, for three reasons:
 *   1. `documents.test.ts:433` requires every unusable source to produce the
 *      same token, and `:442` requires slugify to be idempotent.
 *   2. The engine may not generate randomness — `Clock` and `IdGen` are
 *      injected precisely so nothing in here invents values (types.ts:118).
 *   3. It does not need to be unique. `sha8` is already in the filename, so
 *      two unnamed documents differ: `…--randslug--91be0d47.jpg` versus
 *      `…--randslug--3f1a9c22.jpg`.
 *
 * Exported so the ingest pipeline can recognise a document still awaiting its
 * real name without re-deriving the rule.
 */
export const PLACEHOLDER_SLUG = 'randslug'

/**
 * Latin letters carrying a stroke rather than a combining accent: Unicode NFD
 * does not decompose them, so they need an explicit mapping. `đ` folds to `d`
 * (not `dj`) — see the RESOLVED note in test/unit/documents.test.ts.
 */
const STROKE_FOLDINGS: Record<string, string> = {
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  ł: 'l',
  Ł: 'l',
  ø: 'o',
  Ø: 'o',
}

/**
 * Serbian Cyrillic → Latin, applied after lowercasing.
 *
 * Serbian is digraphia: the same vendor prints its name in either script, so
 * without this every Cyrillic-named vendor reduces to nothing and lands on
 * PLACEHOLDER_SLUG — which in Serbia is the common case, not an edge case.
 *
 * The mapping is deliberately the identity-preserving one: it composes with
 * STROKE_FOLDINGS so that `Телеком Србија` and `Telekom Srbija` produce the
 * SAME slug, and `Ђорђе` matches `Đorđe` at `dorde`. Two spellings of one
 * vendor must not become two vendors.
 *
 * `ђ` → `d` (not `dj`) to stay consistent with the Latin `đ` → `d` decision
 * recorded in test/unit/documents.test.ts. Cyrillic outside this table (тврди
 * знак, Russian-only letters) falls through to the separator rule.
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'd', е: 'e', ж: 'z',
  з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n',
  њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u',
  ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
}

/**
 * `{prefix}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}`
 *
 * The `{YYYY}/{MM}` directory always comes from the accounting period; the date
 * in the filename is the document's own date, which may fall outside it.
 */
const DOCUMENT_PATH =
  /^([a-z0-9-]+)\/(\d{4})\/(0[1-9]|1[0-2])\/([a-z_]+)\/\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*--([0-9a-f]{8})\.[a-z0-9]+$/

/** Strip leading and trailing separators, which are never part of a slug. */
function trimDashes(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '')
}

/**
 * Shapes every interpolated field must satisfy. These mirror the path grammar
 * `parseBlobPath` enforces, so a path this function builds always round-trips.
 */
const PERIOD_SHAPE = /^[0-9]{4}-(0[1-9]|1[0-2])$/
const PREFIX_SHAPE = /^[a-z0-9-]+$/
const CATEGORY_SHAPE = /^[a-z_]+$/
const ISO_DAY_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const SHA_SHAPE = /^[0-9a-fA-F]{8,}$/
const EXTENSION_SHAPE = /^[a-z0-9]+$/

/**
 * Refuse rather than build a path nobody can find again.
 *
 * `slugSource` is the only field that was ever sanitised, and the asymmetry was
 * unintentional. Every other field is interpolated straight into a blob key, and
 * two of them come from outside: `docDate` from the document, `extension` from a
 * MIME `filename=` parameter.
 *
 * The damage is not traversal — Azure Blob has a flat namespace, so `a/../b` is
 * a literal key, not an escape. It is that the document becomes UNFINDABLE. The
 * monthly package is a prefix listing on `{prefix}/{YYYY}/{MM}/`, so a period of
 * '2026-7' writes to `diligaf/2026/7/…` where no listing looks, and the path does
 * not even round-trip through `parseBlobPath`, so slug recovery cannot find it
 * either. The document is stored, dedupe-indexed and sidecar'd — and invisible.
 *
 * `buildManifest` and `monthBounds` both already throw on a malformed period.
 * The one function that decides where the bytes physically land was the one that
 * did not check.
 */
// `value` is `unknown`, not `string`, and deliberately so. These fields arrive from
// JSON and a MIME header; the declared types prove nothing about them, and typing the
// parameter as `string` made the `typeof` check below look like dead code to both a
// reader and to TypeScript. It is not dead — it is the runtime boundary.
function requireShape(field: string, value: unknown, shape: RegExp): string {
  if (typeof value !== 'string' || !shape.test(value)) {
    throw new Error(
      `blobPathFor: ${field} is not a usable path segment (${JSON.stringify(value)}) — refusing to write a document where no listing will find it`,
    )
  }
  return value
}

/** `{prefix}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}` */
export function blobPathFor(input: BlobPathInput): string {
  requireShape('period', input.period, PERIOD_SHAPE)
  requireShape('blobPrefix', input.blobPrefix, PREFIX_SHAPE)
  requireShape('category', input.category, CATEGORY_SHAPE)
  requireShape('sha256', input.sha256, SHA_SHAPE)
  // EXTENSION_SHAPE is lowercase-only, so the value must be folded before the shape
  // is applied — `PDF` is a legitimate input. But the fold may only happen once the
  // value is known to be a string: `input.extension.toLowerCase()` evaluated first
  // throws a bare `TypeError: ... is not a function` instead of the diagnostic above,
  // and `extension` is precisely the field this function's docstring names as arriving
  // from an untrusted MIME `filename=` parameter. Guarding the deref is the whole point.
  const extension = requireShape(
    'extension',
    typeof input.extension === 'string' ? input.extension.toLowerCase() : input.extension,
    EXTENSION_SHAPE,
  )
  if (input.docDate !== null) requireShape('docDate', input.docDate, ISO_DAY_SHAPE)

  const year = input.period.slice(0, 4)
  const month = input.period.slice(5, 7)
  const fileDate = input.docDate ?? `${input.period}-01`
  const sha8 = input.sha256.slice(0, 8).toLowerCase()
  // `extension` is the validated, folded value from above — not a second `.toLowerCase()`.
  const filename = `${fileDate}--${slugify(input.slugSource)}--${sha8}.${extension}`

  return `${input.blobPrefix}/${year}/${month}/${input.category}/${filename}`
}

/**
 * The slug for a source, or null when the source carries no usable name at all.
 *
 * This is the seam the ingest pipeline uses. `null` does NOT stop ingest — the
 * document is stored under PLACEHOLDER_SLUG and queued, the real name is asked
 * for over WhatsApp, and the blob is renamed and moved once it arrives. E never
 * invents a vendor name, and never silently drops a document either.
 */
export function slugifyOrNull(input: string): string | null {
  const folded = input
    .replace(/[đĐðÐłŁøØ]/g, (character) => STROKE_FOLDINGS[character] ?? '-')
    // NFD splits č/ć/ž/š (and any other accented Latin letter) into a base
    // letter plus a combining mark; dropping the marks leaves the ASCII base.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // After lowercasing, so the table only needs lowercase keys.
    .replace(/[Ѐ-ӿ]/g, (character) => CYRILLIC_TO_LATIN[character] ?? '-')

  // Anything that is not a lowercase ASCII alphanumeric — including whitespace,
  // punctuation, emoji and untransliterated scripts — becomes one separator.
  const separated = trimDashes(folded.replace(/[^a-z0-9]+/g, '-'))

  // Hard cut at the cap, then trim again in case the cut landed on a separator.
  const capped = trimDashes(separated.slice(0, SLUG_MAX_LENGTH))

  return capped.length > 0 ? capped : null
}

/** Lowercase, ASCII-fold Serbian diacritics, non-alphanumerics to '-', collapse, trim, max 40 chars. */
export function slugify(input: string): string {
  return slugifyOrNull(input) ?? PLACEHOLDER_SLUG
}

/** The sidecar path for a document path: same path + '.json'. */
export function sidecarPath(blobPath: string): string {
  return `${blobPath}.json`
}

/** Index marker path used for content dedupe (written with If-None-Match). */
export function hashIndexPath(book: BookCode, sha256: string): string {
  return `_index/hash/${book.toLowerCase()}/${sha256.toLowerCase()}.txt`
}

/** Parse a document path back into its parts. Returns null when it doesn't match the convention. */
export function parseBlobPath(path: string): { prefix: string; period: string; category: string; sha8: string } | null {
  const match = DOCUMENT_PATH.exec(path)
  if (match === null) return null

  const [, prefix, year, month, category, sha8] = match
  if (
    prefix === undefined ||
    year === undefined ||
    month === undefined ||
    category === undefined ||
    sha8 === undefined
  ) {
    return null
  }

  return { prefix, period: `${year}-${month}`, category, sha8 }
}
