import { describe, it, expect } from 'vitest'
import { resolveBook, getBook, bookAllowsCommand } from '../../../src/core/books.js'
import { parseCommand } from '../../../src/core/command-parser.js'
import type { CommandName } from '../../../src/core/command-parser.js'
import type { Book, BookCode } from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fixtures. No mocking library, no shared fixture files — every
// book table used below is built here so each test states its own world.
// ---------------------------------------------------------------------------

const PHONE_DILIGAF = '+381641110001'
const PHONE_SMOQUA = '+381641110002'
const PHONE_DILIGAF_SECOND = '+381641110003'
/** Deliberately listed in BOTH DILIGAF and PERSONAL — the precedence case. */
const PHONE_SHARED = '+381641119999'
const PHONE_UNKNOWN = '+381649990000'

function makeBook(code: BookCode, senderPhones: string[], overrides: Partial<Book> = {}): Book {
  const base: Book = {
    code,
    name: code,
    senderPhones,
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
  return { ...base, ...overrides, features: { ...base.features, ...(overrides.features ?? {}) } }
}

function diligaf(phones: string[] = [PHONE_DILIGAF, PHONE_DILIGAF_SECOND, PHONE_SHARED]): Book {
  return makeBook('DILIGAF', phones, {
    name: 'DILIGAF DOO',
    accountantEmail: 'knjigovodja@example.com',
    features: { sef: true, invoicing: true, vat: null, confirmAboveAmount: 50000 },
  })
}

function personal(phones: string[] = [PHONE_SHARED]): Book {
  return makeBook('PERSONAL', phones, {
    name: 'Personal',
    accountantEmail: null,
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 20000 },
  })
}

function smoqua(phones: string[] = [PHONE_SMOQUA]): Book {
  return makeBook('SMOQUA', phones, {
    name: 'SMOQUA',
    currency: 'EUR',
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 30000 },
  })
}

/** The realistic three-book table, in books.json order. */
function books(): Book[] {
  return [diligaf(), personal(), smoqua()]
}

// ===========================================================================
// resolveBook — 02-WHATSAPP-INTERFACE §4, 00-OVERVIEW D1
// ===========================================================================

describe('resolveBook', () => {
  it.each([
    [PHONE_DILIGAF, 'DILIGAF'],
    [PHONE_DILIGAF_SECOND, 'DILIGAF'],
    [PHONE_SMOQUA, 'SMOQUA'],
  ])('resolves the known sender phone %s to book %s', (phone, expected) => {
    expect(resolveBook(phone, books())?.code).toBe(expected)
  })

  it('returns the whole book record, not just its code', () => {
    expect(resolveBook(PHONE_SMOQUA, books())).toEqual(smoqua())
  })

  it('returns null for a phone that belongs to no book', () => {
    expect(resolveBook(PHONE_UNKNOWN, books())).toBeNull()
  })

  it('returns null when the book table is empty', () => {
    expect(resolveBook(PHONE_DILIGAF, [])).toBeNull()
  })

  it('returns null for a book whose senderPhones list is empty', () => {
    expect(resolveBook('', [makeBook('PERSONAL', [])])).toBeNull()
  })

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('returns null for %s input rather than throwing', (_label, phone) => {
    expect(resolveBook(phone, books())).toBeNull()
  })

  // Exact table lookup: E refuses to guess which number a differently-formatted
  // string means, rather than normalising and possibly booking to the wrong book.
  it.each([
    '381641110001',
    '+381 64 111 0001',
    '064/111-0001',
    ' +381641110001 ',
    '+3816411100011',
  ])('returns null for %s, a phone that is not listed verbatim', (phone) => {
    expect(resolveBook(phone, books())).toBeNull()
  })

  it('resolves a phone listed second in a book senderPhones array', () => {
    const table = [smoqua(), makeBook('PERSONAL', ['+381600000001', PHONE_UNKNOWN])]
    expect(resolveBook(PHONE_UNKNOWN, table)?.code).toBe('PERSONAL')
  })

  it('resolves a phone listed in two books to DILIGAF, where documents pile up', () => {
    expect(resolveBook(PHONE_SHARED, books())?.code).toBe('DILIGAF')
  })

  it('resolves a phone listed in two books identically when the table order is reversed', () => {
    const reversed = books().reverse()
    expect(resolveBook(PHONE_SHARED, reversed)?.code).toBe('DILIGAF')
  })

  it('returns the same book on repeated calls with the same inputs', () => {
    const table = books()
    const first = resolveBook(PHONE_SHARED, table)
    const second = resolveBook(PHONE_SHARED, table)
    expect(second).toEqual(first)
  })

  it('does not mutate the book table it was given', () => {
    const table = books()
    const before = JSON.stringify(table)
    resolveBook(PHONE_SHARED, table)
    resolveBook(PHONE_UNKNOWN, table)
    expect(JSON.stringify(table)).toBe(before)
  })
})

// ===========================================================================
// getBook
// ===========================================================================

describe('getBook', () => {
  it.each<BookCode>(['DILIGAF', 'PERSONAL', 'SMOQUA'])('returns the book for code %s', (code) => {
    expect(getBook(code, books())?.code).toBe(code)
  })

  it('returns null when the requested code is absent from the table', () => {
    expect(getBook('SMOQUA', [diligaf(), personal()])).toBeNull()
  })

  it('returns null when the book table is empty', () => {
    expect(getBook('DILIGAF', [])).toBeNull()
  })

  it('returns the first entry when a code is duplicated, so lookup stays deterministic', () => {
    const firstDiligaf = diligaf([PHONE_DILIGAF])
    const shadow = makeBook('DILIGAF', [PHONE_UNKNOWN], { name: 'shadow' })
    expect(getBook('DILIGAF', [firstDiligaf, shadow])?.name).toBe('DILIGAF DOO')
  })

  it.each([
    ['a lowercase code', 'diligaf'],
    ['an unknown code', 'ACME'],
    ['an empty code', ''],
  ])('returns null for %s', (_label, code) => {
    expect(getBook(code as BookCode, books())).toBeNull()
  })
})

// ===========================================================================
// parseCommand — 02-WHATSAPP-INTERFACE §5, §5.1
// ===========================================================================

const EVERY_COMMAND: CommandName[] = [
  'expense', 'cash', 'invoice', 'pending', 'misc',
  'report', 'status', 'book', 'tebra', 'help',
]

describe('parseCommand — exact matches', () => {
  it.each(EVERY_COMMAND)('parses /%s with no argument', (name) => {
    expect(parseCommand(`/${name}`)).toEqual({ name, args: '', fuzzy: false })
  })

  it.each([
    ['/EXPENSE', 'expense'],
    ['/eXpEnSe', 'expense'],
    ['/Book', 'book'],
  ])('parses %s case-insensitively as an exact match', (text, name) => {
    expect(parseCommand(text)).toEqual({ name, args: '', fuzzy: false })
  })

  it.each([
    ['  /status', 'leading whitespace'],
    ['/status  ', 'trailing whitespace'],
    ['\n/status\n', 'surrounding newlines'],
  ])('parses %s (%s) as /status with no argument', (text) => {
    expect(parseCommand(text)).toEqual({ name: 'status', args: '', fuzzy: false })
  })
})

describe('parseCommand — arguments', () => {
  it.each([
    ['/expense 4.210,00 OMV gorivo', 'expense', '4.210,00 OMV gorivo'],
    ['/cash 1500din pijaca', 'cash', '1500din pijaca'],
    ['/expense MARKETING 12000 fb ads', 'expense', 'MARKETING 12000 fb ads'],
    ['/report 2026-07', 'report', '2026-07'],
    ['/book DILIGAF', 'book', 'DILIGAF'],
    ['/help me', 'help', 'me'],
  ])('parses %s keeping everything after the command token as args', (text, name, args) => {
    expect(parseCommand(text)).toEqual({ name, args, fuzzy: false })
  })

  it('does not interpret the argument — money grammar is a separate module', () => {
    expect(parseCommand('/expense tri hiljade za gorivo')?.args).toBe('tri hiljade za gorivo')
  })

  it('preserves the case of the argument so /book personal is not silently canonicalised', () => {
    expect(parseCommand('/book personal')).toEqual({ name: 'book', args: 'personal', fuzzy: false })
  })

  it('trims only the edges of the argument, keeping inner spacing verbatim', () => {
    expect(parseCommand('   /expense    4210   OMV   ')?.args).toBe('4210   OMV')
  })

  it('accepts a tab between the command token and its argument', () => {
    expect(parseCommand('/expense\t4210')?.args).toBe('4210')
  })

  it('keeps a newline inside a multi-line caption argument', () => {
    expect(parseCommand('/expense 4210\nOMV gorivo')?.args).toBe('4210\nOMV gorivo')
  })

})

describe('parseCommand — fuzzy matching at Levenshtein distance 1', () => {
  it.each([
    ['/expence', 'expense'],   // substitution
    ['/expens', 'expense'],    // deletion
    ['/expenses', 'expense'],  // insertion — the natural plural is still distance 1
    ['/cas', 'cash'],
    ['/invoce', 'invoice'],
    ['/pendin', 'pending'],
    ['/mis', 'misc'],
    ['/repor', 'report'],
    ['/statu', 'status'],
    ['/boo', 'book'],
    ['/tebr', 'tebra'],
    ['/hel', 'help'],
  ])('resolves %s to %s and flags it as fuzzy', (text, name) => {
    expect(parseCommand(text)).toEqual({ name, args: '', fuzzy: true })
  })

  it('keeps the argument when the command token was fuzzy-matched', () => {
    expect(parseCommand('/expence 4210 OMV')).toEqual({ name: 'expense', args: '4210 OMV', fuzzy: true })
  })

  it('fuzzy-matches case-insensitively', () => {
    expect(parseCommand('/EXPENCE')).toEqual({ name: 'expense', args: '', fuzzy: true })
  })

  it('resolves the Serbian synonym /troshak to expense without a model call', () => {
    const parsed = parseCommand('/troshak 4210 OMV')
    expect(parsed?.name).toBe('expense')
    expect(parsed?.args).toBe('4210 OMV')
  })

  it('resolves /trošak with diacritics stripped', () => {
    expect(parseCommand('/trošak')?.name).toBe('expense')
  })

  it('treats a doubled leading slash as a distance-1 typo of the command', () => {
    expect(parseCommand('//expense')?.name).toBe('expense')
  })
})

describe('parseCommand — refuses beyond distance 1', () => {
  it('returns null for /x, which is close to nothing', () => {
    expect(parseCommand('/x')).toBeNull()
  })

  it.each([
    '/exp',
    '/expnce',      // two edits from expense
    '/exepnse',     // a transposition is two edits under plain Levenshtein
    '/statuses',
    '/invoicing',
  ])('returns null for %s rather than guessing a command', (text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it('returns null for a slash followed by a word that resembles no command', () => {
    expect(parseCommand('/gorivo 4210')).toBeNull()
  })

  it('returns null for a Cyrillic command token, which is not transliterated', () => {
    expect(parseCommand('/трошак')).toBeNull()
  })
})

describe('parseCommand — not a command, falls through to free text', () => {
  it.each([
    ['an empty message', ''],
    ['whitespace only', '   '],
    ['a bare slash', '/'],
    ['a slash then a space', '/ expense'],
    ['a slash then digits', '/1234'],
    ['a slash then an emoji', '/🙂'],
    ['the SMOQUA dimension shorthand', 'MATERIALS 300e'],
    ['the reversed shorthand', '300e MATERIALS'],
    ['a command word without its slash', 'expense 4210'],
    ['free text mentioning a command', 'pošalji /expense sutra'],
    ['a free-text sentence', 'kupio sam gorivo za 4210'],
    ['free text for the model to slot-fill', 'MATERIJAAL PAMUK 200E Projekat 1'],
    ['a leading punctuation mark', '?/expense'],
  ])('returns null for %s', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it.each([
    ['null', null as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('returns null for %s input rather than throwing', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })
})

describe('parseCommand — /tebra and its quoted argument', () => {
  it('strips the surrounding quotes and keeps the prompt verbatim', () => {
    expect(parseCommand('/tebra "koliko sam dao na gorivo u julu?"')).toEqual({
      name: 'tebra',
      args: 'koliko sam dao na gorivo u julu?',
      fuzzy: false,
    })
  })

  it('keeps inner spacing and punctuation of a quoted prompt exactly as typed', () => {
    const text = '/tebra "napravi  tabelu: troškovi po dimenziji, Q3 — pošalji kao excel!"'
    expect(parseCommand(text)?.args).toBe('napravi  tabelu: troškovi po dimenziji, Q3 — pošalji kao excel!')
  })

  it('keeps spaces immediately inside the quotes, since the quotes delimit the prompt exactly', () => {
    expect(parseCommand('/tebra "  gorivo u julu  "')?.args).toBe('  gorivo u julu  ')
  })

  it('keeps the case of a quoted prompt', () => {
    expect(parseCommand('/TEBRA "Prebaci sve WOLT iz jula u HRANA"')).toEqual({
      name: 'tebra',
      args: 'Prebaci sve WOLT iz jula u HRANA',
      fuzzy: false,
    })
  })

  it('strips only the outermost quote pair, keeping quoted terms inside the prompt', () => {
    expect(parseCommand('/tebra "nadji "WOLT" u julu"')?.args).toBe('nadji "WOLT" u julu')
  })

  it('accepts an unquoted prompt verbatim', () => {
    expect(parseCommand('/tebra koliko sam dao na gorivo u julu?')).toEqual({
      name: 'tebra',
      args: 'koliko sam dao na gorivo u julu?',
      fuzzy: false,
    })
  })

  it('returns an empty argument for an empty quoted prompt', () => {
    expect(parseCommand('/tebra ""')).toEqual({ name: 'tebra', args: '', fuzzy: false })
  })

  it('returns an empty argument for a bare /tebra', () => {
    expect(parseCommand('/tebra')).toEqual({ name: 'tebra', args: '', fuzzy: false })
  })

  it.each([
    ['an unterminated opening quote', '/tebra "koliko sam dao', '"koliko sam dao'],
    ['a stray closing quote', '/tebra koliko"', 'koliko"'],
    ['text after the closing quote', '/tebra "gorivo" hvala', '"gorivo" hvala'],
  ])('leaves the argument verbatim for %s', (_label, text, args) => {
    expect(parseCommand(text)?.args).toBe(args)
  })

  it('does not strip single quotes, which are ordinary characters in a prompt', () => {
    expect(parseCommand("/tebra 'gorivo u julu'")?.args).toBe("'gorivo u julu'")
  })

  it('strips typographic quotes produced by a phone keyboard', () => {
    expect(parseCommand('/tebra “gorivo u julu”')?.args).toBe('gorivo u julu')
  })

  it('keeps the quoted prompt intact when the command token itself was fuzzy-matched', () => {
    expect(parseCommand('/tebr "koliko sam dao na gorivo u julu?"')).toEqual({
      name: 'tebra',
      args: 'koliko sam dao na gorivo u julu?',
      fuzzy: true,
    })
  })
})

// ===========================================================================
// bookAllowsCommand — /invoice is DILIGAF-only
// ===========================================================================

describe('bookAllowsCommand', () => {
  it('allows /invoice for DILIGAF, the only book that issues invoices', () => {
    expect(bookAllowsCommand(diligaf(), 'invoice')).toBe(true)
  })

  it.each([
    ['PERSONAL', personal()],
    ['SMOQUA', smoqua()],
  ])('refuses /invoice for %s', (_label, book) => {
    expect(bookAllowsCommand(book, 'invoice')).toBe(false)
  })

  it('refuses /invoice for a book whose invoicing feature is off, whatever its code', () => {
    const disabled = makeBook('DILIGAF', [PHONE_DILIGAF], {
      features: { sef: true, invoicing: false, vat: null, confirmAboveAmount: 50000 },
    })
    expect(bookAllowsCommand(disabled, 'invoice')).toBe(false)
  })

  it('allows /invoice for any book whose invoicing feature is on', () => {
    const enabled = makeBook('SMOQUA', [PHONE_SMOQUA], {
      features: { sef: false, invoicing: true, vat: null, confirmAboveAmount: 30000 },
    })
    expect(bookAllowsCommand(enabled, 'invoice')).toBe(true)
  })

  it('allows /pending for DILIGAF, the only book wired to SEF', () => {
    expect(bookAllowsCommand(diligaf(), 'pending')).toBe(true)
  })

  it.each([
    ['PERSONAL', personal()],
    ['SMOQUA', smoqua()],
  ])('refuses /pending for %s, which has no SEF', (_label, book) => {
    expect(bookAllowsCommand(book, 'pending')).toBe(false)
  })

  // Commands every book can run: they read or route, they never touch a feature
  // a book does not have.
  const universal: CommandName[] = ['help', 'status', 'book', 'tebra', 'expense', 'misc']
  it.each(universal)('allows /%s for every book', (command) => {
    expect(bookAllowsCommand(diligaf(), command)).toBe(true)
    expect(bookAllowsCommand(personal(), command)).toBe(true)
    expect(bookAllowsCommand(smoqua(), command)).toBe(true)
  })

  it('allows /cash for PERSONAL, where cash outflows are booked', () => {
    expect(bookAllowsCommand(personal(), 'cash')).toBe(true)
  })

  it.each([
    ['DILIGAF', diligaf()],
    ['PERSONAL', personal()],
  ])('allows /report for %s, which has an accountant package', (_label, book) => {
    expect(bookAllowsCommand(book, 'report')).toBe(true)
  })

  it.each([
    ['an unknown command', 'frobnicate'],
    ['an empty command', ''],
    ['a whitespace command', '   '],
    ['a near-miss of a real command', 'invoicing'],
    ['a command-shaped path', 'invoice_out'],
  ])('refuses %s rather than defaulting to allowed', (_label, command) => {
    expect(bookAllowsCommand(diligaf(), command)).toBe(false)
  })

  // Interpretation: the caller may hand over either the parsed CommandName or the
  // raw token. Both are accepted and answer identically. See specGaps.
  describe('input tolerance', () => {
    it('accepts the command with its leading slash', () => {
      expect(bookAllowsCommand(diligaf(), '/invoice')).toBe(true)
    })

    it('refuses the slashed form for a book that is not allowed the command', () => {
      expect(bookAllowsCommand(smoqua(), '/invoice')).toBe(false)
    })

    it('is case-insensitive about the command name', () => {
      expect(bookAllowsCommand(diligaf(), 'INVOICE')).toBe(true)
    })
  })

  it('does not mutate the book it was given', () => {
    const book = diligaf()
    const before = JSON.stringify(book)
    bookAllowsCommand(book, 'invoice')
    bookAllowsCommand(book, 'frobnicate')
    expect(JSON.stringify(book)).toBe(before)
  })
})
