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

/** `{prefix}/{YYYY}/{MM}/{category}/{YYYY-MM-DD}--{slug}--{sha8}.{ext}` */
export function blobPathFor(_input: BlobPathInput): string {
  throw new Error('not implemented')
}

/** Lowercase, ASCII-fold Serbian diacritics, non-alphanumerics to '-', collapse, trim, max 40 chars. */
export function slugify(_input: string): string {
  throw new Error('not implemented')
}

/** The sidecar path for a document path: same path + '.json'. */
export function sidecarPath(_blobPath: string): string {
  throw new Error('not implemented')
}

/** Index marker path used for content dedupe (written with If-None-Match). */
export function hashIndexPath(_book: BookCode, _sha256: string): string {
  throw new Error('not implemented')
}

/** Parse a document path back into its parts. Returns null when it doesn't match the convention. */
export function parseBlobPath(_path: string): { prefix: string; period: string; category: string; sha8: string } | null {
  throw new Error('not implemented')
}

