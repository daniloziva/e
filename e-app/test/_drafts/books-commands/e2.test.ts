import { describe, expect, it } from 'vitest'

import { bookAllowsCommand, getBook, resolveBook } from '../../../src/engine/books.js'
import { parseCommand } from '../../../src/engine/command-parser.js'
import type { Book, BookCode } from '../../../src/engine/types.js'
import type { Command, CommandName } from '../../../src/engine/command-parser.js'

// ---------------------------------------------------------------------------
// Fixtures. Hand-written, no mocking library. These functions take no injected
// dependencies (no Clock, no IdGen), so a plain object book is the whole world.
// ---------------------------------------------------------------------------

const MAIN_PHONE = '+381641234567' // your phone -> DILIGAF (02 §4)
const SMOQUA_PHONE = '+381651112223' // the shop phone -> SMOQUA
const STRANGER_PHONE = '+381609998887' // nobody: silent 200, no reply

function makeBook(code: BookCode, overrides: Partial<Book> = {}): Book {
  const base: Book = {
    code,
    name: code,
    senderPhones: [],
    blobPrefix: code.toLowerCase(),
    defaultCategory: 'expense',
    accountantEmail: null,
    currency: 'RSD',
    dimensions: [],
    features: {
      sef: false,
      invoicing: false,
      vat: null,
      confirmAboveAmount: 50000,
    },
  }
  return {
    ...base,
    ...overrides,
    features: { ...base.features, ...(overrides.features ?? {}) },
  }
}

/** The three real books, in the order `_state/books.json` declares them. */
const DILIGAF = makeBook('DILIGAF', {
  name: 'DILIGAF DOO',
  senderPhones: [MAIN_PHONE],
  accountantEmail: 'knjigovodja@example.com',
  features: { sef: true, invoicing: true, vat: null, confirmAboveAmount: 100000 },
})
const PERSONAL = makeBook('PERSONAL', {
  // Reached by command (/cash, /misc), never by sender phone (02 §4).
  senderPhones: [],
})
const SMOQUA = makeBook('SMOQUA', {
  senderPhones: [SMOQUA_PHONE],
  currency: 'RSD',
})
const BOOKS: Book[] = [DILIGAF, PERSONAL, SMOQUA]

// ---------------------------------------------------------------------------
// resolveBook — the sender allowlist. Refusal is the headline behaviour here.
// ---------------------------------------------------------------------------

describe('resolveBook', () => {
  it('resolves your personal phone to DILIGAF, because that is where documents pile up', () => {
    expect(resolveBook(MAIN_PHONE, BOOKS)).toBe(DILIGAF)
  })

  it('resolves the shop phone to SMOQUA', () => {
    expect(resolveBook(SMOQUA_PHONE, BOOKS)).toBe(SMOQUA)
  })

  it('returns null for an unknown phone rather than falling back to a default book', () => {
    expect(resolveBook(STRANGER_PHONE, BOOKS)).toBeNull()
  })

  it('never resolves to PERSONAL, which has no sender phone at all', () => {
    for (const phone of [MAIN_PHONE, SMOQUA_PHONE, STRANGER_PHONE]) {
      expect(resolveBook(phone, BOOKS)).not.toBe(PERSONAL)
    }
  })

  it('returns null when the book list is empty', () => {
    expect(resolveBook(MAIN_PHONE, [])).toBeNull()
  })

  it('returns null for an empty phone string', () => {
    expect(resolveBook('', BOOKS)).toBeNull()
  })

  it('returns null for a whitespace-only phone string', () => {
    expect(resolveBook('   ', BOOKS)).toBeNull()
  })

  it('returns null for a missing phone rather than throwing', () => {
    expect(resolveBook(undefined as unknown as string, BOOKS)).toBeNull()
    expect(resolveBook(null as unknown as string, BOOKS)).toBeNull()
  })

  it('ignores a book whose senderPhones list is empty when another book matches', () => {
    const empty = makeBook('SMOQUA', { senderPhones: [] })
    expect(resolveBook(MAIN_PHONE, [empty, DILIGAF])).toBe(DILIGAF)
  })

  it('still resolves when a book lists the same phone twice', () => {
    const dupe = makeBook('SMOQUA', { senderPhones: [SMOQUA_PHONE, SMOQUA_PHONE] })
    expect(resolveBook(SMOQUA_PHONE, [dupe])).toBe(dupe)
  })

  // Precedence: array order is the deterministic tiebreak, so the same input
  // with a different declaration order gives a different — but predictable —
  // answer. Asserted in both directions so a hidden priority table fails.
  it('returns the first matching book when a phone is listed in two books', () => {
    const a = makeBook('DILIGAF', { senderPhones: [MAIN_PHONE] })
    const b = makeBook('SMOQUA', { senderPhones: [MAIN_PHONE] })
    expect(resolveBook(MAIN_PHONE, [a, b])).toBe(a)
  })

  it('returns the other book first when the same two books are declared in the opposite order', () => {
    const a = makeBook('DILIGAF', { senderPhones: [MAIN_PHONE] })
    const b = makeBook('SMOQUA', { senderPhones: [MAIN_PHONE] })
    expect(resolveBook(MAIN_PHONE, [b, a])).toBe(b)
  })

  // WhatsApp's webhook delivers `from` as bare digits ("38164..."), while
  // books.json stores the human form ("+38164..."). Matching is on digits.
  it.each([
    ['bare digits, no plus', '381641234567'],
    ['spaced human form', '+381 64 123 4567'],
    ['dashed human form', '+381-64-123-4567'],
  ])('resolves a %s of a known phone to the same book', (_label, phone) => {
    expect(resolveBook(phone, BOOKS)).toBe(DILIGAF)
  })

  it('returns null for a phone that is only a suffix of a known phone, rather than guessing', () => {
    expect(resolveBook('641234567', BOOKS)).toBeNull()
  })

  it('returns null for a phone that merely contains a known phone as a substring', () => {
    expect(resolveBook('+3816412345670', BOOKS)).toBeNull()
  })

  it('returns null for a malformed non-numeric sender', () => {
    expect(resolveBook('not-a-phone', BOOKS)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getBook — lookup by canonical code.
// ---------------------------------------------------------------------------

describe('getBook', () => {
  it.each<[BookCode, Book]>([
    ['DILIGAF', DILIGAF],
    ['PERSONAL', PERSONAL],
    ['SMOQUA', SMOQUA],
  ])('returns the %s book by its code', (code, expected) => {
    expect(getBook(code, BOOKS)).toBe(expected)
  })

  it('returns null when the requested code is not in the list', () => {
    expect(getBook('SMOQUA', [DILIGAF, PERSONAL])).toBeNull()
  })

  it('returns null when the book list is empty', () => {
    expect(getBook('DILIGAF', [])).toBeNull()
  })

  it('returns the first book when a code is declared twice', () => {
    const first = makeBook('SMOQUA', { name: 'first' })
    const second = makeBook('SMOQUA', { name: 'second' })
    expect(getBook('SMOQUA', [first, second])).toBe(first)
  })

  it('returns null for a lowercase code, because codes are canonical and are not normalized here', () => {
    expect(getBook('diligaf' as BookCode, BOOKS)).toBeNull()
  })

  it.each([
    ['unknown code', 'ACME'],
    ['empty string', ''],
  ])('returns null for an %s', (_label, code) => {
    expect(getBook(code as BookCode, BOOKS)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// bookAllowsCommand — capability gating. Denial must be the default.
// ---------------------------------------------------------------------------

describe('bookAllowsCommand', () => {
  it('allows /invoice for DILIGAF, the only book that issues invoices', () => {
    expect(bookAllowsCommand(DILIGAF, 'invoice')).toBe(true)
  })

  it.each<[BookCode, Book]>([
    ['PERSONAL', PERSONAL],
    ['SMOQUA', SMOQUA],
  ])('denies /invoice for %s', (_code, book) => {
    expect(bookAllowsCommand(book, 'invoice')).toBe(false)
  })

  it('gates /invoice on the book feature flag, not on the book code', () => {
    const shopThatInvoices = makeBook('SMOQUA', {
      features: { sef: false, invoicing: true, vat: null, confirmAboveAmount: 0 },
    })
    const diligafWithoutInvoicing = makeBook('DILIGAF', {
      features: { sef: true, invoicing: false, vat: null, confirmAboveAmount: 0 },
    })
    expect(bookAllowsCommand(shopThatInvoices, 'invoice')).toBe(true)
    expect(bookAllowsCommand(diligafWithoutInvoicing, 'invoice')).toBe(false)
  })

  it('allows /pending only for a book wired to SEF', () => {
    expect(bookAllowsCommand(DILIGAF, 'pending')).toBe(true)
    expect(bookAllowsCommand(PERSONAL, 'pending')).toBe(false)
    expect(bookAllowsCommand(SMOQUA, 'pending')).toBe(false)
  })

  it.each<CommandName>(['expense', 'cash', 'misc', 'report', 'status', 'book', 'tebra', 'help'])(
    'allows /%s for every book',
    (command) => {
      for (const book of BOOKS) {
        expect(bookAllowsCommand(book, command)).toBe(true)
      }
    },
  )

  it('accepts the command written with its leading slash', () => {
    expect(bookAllowsCommand(DILIGAF, '/invoice')).toBe(true)
    expect(bookAllowsCommand(PERSONAL, '/invoice')).toBe(false)
  })

  it('is case-insensitive about the command name', () => {
    expect(bookAllowsCommand(DILIGAF, 'INVOICE')).toBe(true)
    expect(bookAllowsCommand(PERSONAL, 'Invoice')).toBe(false)
  })

  it('denies an unknown command rather than defaulting to allowed', () => {
    expect(bookAllowsCommand(DILIGAF, 'frobnicate')).toBe(false)
  })

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a bare slash', '/'],
  ])('denies %s as a command', (_label, command) => {
    expect(bookAllowsCommand(DILIGAF, command)).toBe(false)
  })

  it('denies a missing command rather than throwing', () => {
    expect(bookAllowsCommand(DILIGAF, undefined as unknown as string)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseCommand — the deterministic routing layer (02 §5, §5.1 row 3).
// ---------------------------------------------------------------------------

const cmd = (name: CommandName, args = '', fuzzy = false): Command => ({ name, args, fuzzy })

describe('parseCommand — exact recognition', () => {
  it.each<[string, CommandName]>([
    ['/expense', 'expense'],
    ['/cash', 'cash'],
    ['/invoice', 'invoice'],
    ['/pending', 'pending'],
    ['/misc', 'misc'],
    ['/report', 'report'],
    ['/status', 'status'],
    ['/book', 'book'],
    ['/tebra', 'tebra'],
    ['/help', 'help'],
  ])('parses %s as an exact command with empty args', (text, name) => {
    expect(parseCommand(text)).toEqual(cmd(name))
  })

  it.each([
    ['upper case', '/EXPENSE'],
    ['mixed case', '/ExPeNsE'],
    ['trailing whitespace', '/expense   '],
    ['leading whitespace', '   /expense'],
    ['a trailing newline', '/expense\n'],
  ])('parses a command with %s', (_label, text) => {
    expect(parseCommand(text)).toEqual(cmd('expense'))
  })

  it.each([
    ['diacritic-free alias', '/trosak'],
    ['the same alias with diacritics', '/trošak'],
    ['the alias upper-cased with diacritics', '/TROŠAK'],
  ])('parses the Serbian %s as /expense', (_label, text) => {
    const result = parseCommand(text)
    expect(result?.name).toBe('expense')
  })
})

describe('parseCommand — arguments', () => {
  it('captures the amount and description after /expense', () => {
    expect(parseCommand('/expense 4210 gorivo NIS')).toEqual(cmd('expense', '4210 gorivo NIS'))
  })

  it('preserves the case of the arguments while the command itself is case-insensitive', () => {
    expect(parseCommand('/EXPENSE MATERIALS Projekat 1')).toEqual(
      cmd('expense', 'MATERIALS Projekat 1'),
    )
  })

  it('trims the outside of the argument but leaves the inside verbatim', () => {
    expect(parseCommand('  /cash   500   kafa i burek  ')).toEqual(
      cmd('cash', '500   kafa i burek'),
    )
  })

  it('treats a tab between the command and its argument as a separator', () => {
    expect(parseCommand('/report\t2026-07')).toEqual(cmd('report', '2026-07'))
  })

  it('returns empty args for /report without a period', () => {
    expect(parseCommand('/report')).toEqual(cmd('report'))
  })

  it('passes the book code through /book verbatim, without validating it', () => {
    expect(parseCommand('/book DILIGAF')).toEqual(cmd('book', 'DILIGAF'))
    expect(parseCommand('/book personal')).toEqual(cmd('book', 'personal'))
    expect(parseCommand('/book NOSUCHBOOK')).toEqual(cmd('book', 'NOSUCHBOOK'))
  })

  it('captures arguments on a command that takes none, leaving rejection to the caller', () => {
    expect(parseCommand('/help me')).toEqual(cmd('help', 'me'))
  })

  it('keeps the SMOQUA dimension shorthand as args in the explicit /expense form', () => {
    expect(parseCommand('/expense MARKETING 12000 fb ads')).toEqual(
      cmd('expense', 'MARKETING 12000 fb ads'),
    )
  })
})

describe('parseCommand — /tebra keeps its prompt intact', () => {
  it('strips the surrounding quotes and preserves the prompt verbatim', () => {
    expect(parseCommand('/tebra "koliko sam dao na gorivo u julu?"')).toEqual(
      cmd('tebra', 'koliko sam dao na gorivo u julu?'),
    )
  })

  it('preserves spacing and punctuation inside the quotes exactly', () => {
    expect(parseCommand('/tebra "  prebaci sve WOLT  iz jula  u HRANA, molim te!  "')).toEqual(
      cmd('tebra', '  prebaci sve WOLT  iz jula  u HRANA, molim te!  '),
    )
  })

  it('strips only the outermost quotes, leaving quoted words inside the prompt', () => {
    expect(parseCommand('/tebra "prebaci sve "WOLT" u HRANA"')).toEqual(
      cmd('tebra', 'prebaci sve "WOLT" u HRANA'),
    )
  })

  it('strips typographic quotes, which phone keyboards substitute automatically', () => {
    expect(parseCommand('/tebra “koliko sam potrošio?”')).toEqual(
      cmd('tebra', 'koliko sam potrošio?'),
    )
  })

  it('strips single quotes used as the wrapper', () => {
    expect(parseCommand("/tebra 'koliko sam potrošio?'")).toEqual(
      cmd('tebra', 'koliko sam potrošio?'),
    )
  })

  it('keeps an unbalanced quote verbatim rather than guessing where the prompt ends', () => {
    expect(parseCommand('/tebra "nezatvoren navodnik')).toEqual(
      cmd('tebra', '"nezatvoren navodnik'),
    )
  })

  it('accepts an unquoted prompt', () => {
    expect(parseCommand('/tebra koliko sam dao na gorivo u julu?')).toEqual(
      cmd('tebra', 'koliko sam dao na gorivo u julu?'),
    )
  })

  it('returns empty args for an empty quoted prompt', () => {
    expect(parseCommand('/tebra ""')).toEqual(cmd('tebra', ''))
  })

  it('returns empty args for /tebra alone, leaving the "ask for a prompt" decision to the caller', () => {
    expect(parseCommand('/tebra')).toEqual(cmd('tebra'))
  })

  it('unwraps the quoted prompt even when the command token itself was fuzzy-matched', () => {
    expect(parseCommand('/tebr "koliko sam dao na gorivo?"')).toEqual(
      cmd('tebra', 'koliko sam dao na gorivo?', true),
    )
  })
})

describe('parseCommand — fuzzy matching at Levenshtein <= 1, and not one step further', () => {
  it.each([
    ['a substitution', '/expence'],
    ['a deletion', '/expens'],
    ['an insertion', '/expensee'],
  ])('resolves /expense through %s and flags it as fuzzy', (_label, text) => {
    expect(parseCommand(text)).toEqual(cmd('expense', '', true))
  })

  it('keeps the arguments when the command token was fuzzy-matched', () => {
    expect(parseCommand('/expence 4210 gorivo')).toEqual(cmd('expense', '4210 gorivo', true))
  })

  it('resolves the Serbian misspelling /troshak to expense as a fuzzy match', () => {
    expect(parseCommand('/troshak 300e')).toEqual(cmd('expense', '300e', true))
  })

  it.each([
    ['/hep', 'help'],
    ['/hlp', 'help'],
    ['/cas', 'cash'],
    ['/mist', 'misc'],
    ['/boo', 'book'],
    ['/statu', 'status'],
  ])('resolves %s to /%s at distance 1', (text, name) => {
    expect(parseCommand(text)).toEqual(cmd(name as CommandName, '', true))
  })

  it.each([
    ['distance 2 by two substitutions', '/expance'],
    ['distance 2 by two deletions', '/expns'],
    ['distance 2 by transposition, since this is Levenshtein and not Damerau', '/expesne'],
    ['distance 2 by transposition on a short command', '/tebar'],
  ])('returns null for %s', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it('returns null for /x, which is nowhere near any command', () => {
    expect(parseCommand('/x')).toBeNull()
  })

  it('returns null for a single-letter prefix of a real command', () => {
    expect(parseCommand('/e')).toBeNull()
    expect(parseCommand('/c')).toBeNull()
  })

  it('returns null for a command-shaped word that is far from everything', () => {
    expect(parseCommand('/frobnicate 4210')).toBeNull()
  })
})

describe('parseCommand — refusals, so free text keeps flowing to the slot filler', () => {
  it.each([
    ['the SMOQUA dimension shorthand', 'MATERIALS 300e'],
    ['the shorthand in reversed order', '300e MATERIALS'],
    ['a bare question', 'koliko sam potrosio na gorivo'],
    ['a command word without its slash', 'expense 4210 gorivo'],
    ['a plain courtesy', 'hvala'],
    ['an emoji', '👍'],
    ['a number', '4210'],
  ])('returns null for %s', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it('returns null when a command word appears somewhere other than the start', () => {
    expect(parseCommand('danas /expense 4210')).toBeNull()
  })

  it('returns null for a URL that happens to contain a command path', () => {
    expect(parseCommand('https://example.com/expense')).toBeNull()
  })

  it('returns null for a bare slash', () => {
    expect(parseCommand('/')).toBeNull()
  })

  it('returns null when a space follows the slash, because the first token is not a command', () => {
    expect(parseCommand('/ expense 4210')).toBeNull()
  })

  it('returns null for a slash followed by digits', () => {
    expect(parseCommand('/123')).toBeNull()
  })

  it.each([
    ['an empty message', ''],
    ['a whitespace-only message', '   '],
    ['a newline-only message', '\n\n'],
  ])('returns null for %s', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it('returns null for absent text rather than throwing', () => {
    expect(parseCommand(undefined as unknown as string)).toBeNull()
    expect(parseCommand(null as unknown as string)).toBeNull()
  })
})
