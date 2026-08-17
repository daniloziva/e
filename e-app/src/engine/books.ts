import type { Book, BookCode } from './types.js'

/** Resolve the book a sender phone belongs to. Unknown phone -> null (silent 200, no reply). */
export function resolveBook(_phone: string, _books: Book[]): Book | null {
  throw new Error('not implemented')
}

export function getBook(_code: BookCode, _books: Book[]): Book | null {
  throw new Error('not implemented')
}

/** Is this command permitted for this book? e.g. /invoice is DILIGAF-only. */
export function bookAllowsCommand(_book: Book, _command: string): boolean {
  throw new Error('not implemented')
}

