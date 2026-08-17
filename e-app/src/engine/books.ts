import type { Book, BookCode } from './types.js'

/**
 * Sender-phone collision precedence (02-WHATSAPP-INTERFACE §4): "Your personal
 * phone maps to DILIGAF as its default book, because that's where documents
 * pile up. PERSONAL is reached by command, not by default."
 *
 * A phone claimed by more than one book therefore resolves by this order and
 * never by the order `_state/books.json` happens to list the books in.
 */
const BOOK_PRECEDENCE: Readonly<Record<BookCode, number>> = {
  DILIGAF: 0,
  PERSONAL: 1,
  SMOQUA: 2,
}

/**
 * Every command the router knows. Gating is a lookup in this closed set: an
 * unknown token is denied rather than defaulting to allowed, and nothing here
 * is fuzzy-matched — "/invoicing" is not "/invoice".
 */
const COMMAND_NAMES: ReadonlySet<string> = new Set([
  'expense',
  'cash',
  'invoice',
  'pending',
  'misc',
  'report',
  'status',
  'book',
  'tebra',
  'help',
])

/**
 * The WhatsApp Cloud API delivers `from` as bare digits ("381641234567") while
 * books.json holds the human form ("+381 64 123 4567"), so matching is on the
 * digits alone. Nothing is expanded: a local "064/..." form is not rewritten to
 * a country code, and a partial number never matches.
 */
function phoneDigits(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\D/g, '')
}

/** Resolve the book a sender phone belongs to. Unknown phone -> null (silent 200, no reply). */
export function resolveBook(phone: string, books: Book[]): Book | null {
  const wanted = phoneDigits(phone)
  if (wanted === '') return null

  let winner: Book | null = null
  let winnerRank = Number.POSITIVE_INFINITY

  for (const book of books) {
    const matches = book.senderPhones.some((listed) => phoneDigits(listed) === wanted)
    if (!matches) continue

    const rank = BOOK_PRECEDENCE[book.code]
    // Strictly less-than: the first book at a given rank wins, so a table that
    // declares the same code twice still answers deterministically.
    if (rank < winnerRank) {
      winner = book
      winnerRank = rank
    }
  }

  return winner
}

export function getBook(code: BookCode, books: Book[]): Book | null {
  // Book codes are canonical; nothing is normalised here, so "diligaf" misses.
  // The first entry wins, so a table that declares a code twice stays deterministic.
  return books.find((book) => book.code === code) ?? null
}

/**
 * Accept both spellings a caller may hold — the parsed CommandName ("invoice")
 * and the raw token as typed ("/INVOICE"). Anything outside the closed command
 * set, including a near-miss, resolves to null.
 */
function canonicaliseCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const trimmed = command.trim()
  const bare = (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).toLowerCase()
  return COMMAND_NAMES.has(bare) ? bare : null
}

/** Is this command permitted for this book? e.g. /invoice is DILIGAF-only. */
export function bookAllowsCommand(book: Book, command: string): boolean {
  const name = canonicaliseCommand(command)
  if (name === null) return false

  // Gating reads the book's features, never its code: "/invoice is DILIGAF-only"
  // is a consequence of DILIGAF being the book that invoices, not the rule.
  switch (name) {
    case 'invoice':
      return book.features.invoicing
    case 'pending':
      return book.features.sef
    default:
      // Everything else reads or routes; it never touches a feature a book lacks.
      return true
  }
}
