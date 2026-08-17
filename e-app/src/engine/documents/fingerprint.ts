export interface Fingerprint {
  sha256: string
  sha8: string
  byteSize: number
}

/** Number of digest characters that land in a document filename. */
const SHA8_LENGTH = 8

/**
 * Filename extensions we are willing to trust verbatim. Anything outside the
 * list is treated as unknown and yields to the mime type — see the RESOLVED
 * note in test/unit/documents.test.ts ("Unknown -> 'bin'" implies an
 * allow-list, and an unrecognised suffix is not evidence of a type).
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'jpg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'tif',
  'bmp',
  'gz',
  'zip',
  'xml',
  'json',
  'csv',
  'txt',
  'html',
  'eml',
  'doc',
  'docx',
  'xls',
  'xlsx',
])

/**
 * Spellings we normalise so one file type has exactly one extension.
 *
 * Each entry must agree with MIME_EXTENSIONS below, or the same content type
 * lands on two different blob paths depending on whether the filename or the
 * mime type resolved it. Untested by the frozen suite — no case feeds a
 * `.tiff`/`.htm` filename — so the invariant is kept by hand here.
 */
const EXTENSION_ALIASES: Record<string, string> = {
  jpeg: 'jpg',
  tiff: 'tif',
  htm: 'html',
}

/** Mime types we can name an extension for. Everything else is unknown. */
const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tif',
  'image/bmp': 'bmp',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'message/rfc822': 'eml',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

/** Used when neither the filename nor the mime type names a type we know. */
const FALLBACK_EXTENSION = 'bin'

/** The last suffix of a filename, lowercased. Empty when there is none. */
function suffixOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  // `dot === 0` is a dotfile (`.gitignore`), whose name is not an extension.
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/** Hash bytes. Pure given the bytes; the hashing primitive is injected by the caller. */
export function fingerprint(bytes: Uint8Array, sha256: (b: Uint8Array) => string): Fingerprint {
  const digest = sha256(bytes).toLowerCase()

  return {
    sha256: digest,
    sha8: digest.slice(0, SHA8_LENGTH),
    // The view's length, not the length of any buffer backing it.
    byteSize: bytes.length,
  }
}

/** Extension from a filename or mime type, lowercase, no dot. Unknown -> 'bin'. */
export function extensionFor(filename: string, mimeType: string): string {
  const suffix = suffixOf(filename)
  const fromFilename = EXTENSION_ALIASES[suffix] ?? suffix
  if (KNOWN_EXTENSIONS.has(fromFilename)) return fromFilename

  // Parameters (`; charset=…`) and casing carry no type information.
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''

  return MIME_EXTENSIONS[mime] ?? FALLBACK_EXTENSION
}
