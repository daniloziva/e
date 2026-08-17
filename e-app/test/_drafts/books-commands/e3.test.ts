import { describe, it, expect } from 'vitest'

import { resolveBook, getBook, bookAllowsCommand } from '../../../src/engine/books.js'
import { parseCommand } from '../../../src/engine/command-parser.js'
import type { CommandName } from '../../../src/engine/command-parser.js'
import type { Book, BookCode } from '../../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Fixtures — hand-written, no mocking library. `books` is config, so every test
// builds exactly the config it is talking about.
// ---------------------------------------------------------------------------

const DILIGAF_PHONE = '381641111111'
const SMOQUA_PHONE = '381642222222'
const PERSONAL_PHONE = '381643333333'
const STRANGER_PHONE = '381649999999'

function makeBook(code: BookCode, senderPhones: string[], overrides: Partial<Book> = {}): Book {
  return {
    code,
    name: code,
    senderPhones,
    blobPrefix: code.toLowerCase(),
    defaultCategory: 'expense',
    accountantEmail: code === 'DILIGAF' ? 'racunovodja@example.test' : null,
    currency: code === 'SMOQUA' ? 'EUR' : 'RSD',
    dimensions: [],
    features: {
      sef: code === 'DILIGAF',
      invoicing: code === 'DILIGAF',
      vat: code === 'DILIGAF' ? 'standard20' : null,
      confirmAboveAmount: 50_000,
    },
    ...overrides,
  }
}

const DILIGAF = makeBook('DILIGAF', [DILIGAF_PHONE])
const PERSONAL = makeBook('PERSONAL', [PERSONAL_PHONE])
const SMOQUA = makeBook('SMOQUA', [SMOQUA_PHONE])
const ALL_BOOKS: Book[] = [DILIGAF, PERSONAL, SMOQUA]

// ===========================================================================
// resolveBook — 02-WHATSAPP-INTERFACE.md §4, 00-OVERVIEW.md D1
// ===========================================================================

describe('resolveBook', () => {
  it.each<[string, string, BookCode]>([
    ['the DILIGAF phone', DILIGAF_PHONE, 'DILIGAF'],
    ['the PERSONAL phone', PERSONAL_PHONE, 'PERSONAL'],
    ['the SMOQUA phone', SMOQUA_PHONE, 'SMOQUA'],
  ])('resolves %s to its book', (_label, phone, expected) => {
    expect(resolveBook(phone, ALL_BOOKS)?.code).toBe(expected)
  })

  it('returns null for a phone that belongs to no book, so E never confirms its own existence to a stranger', () => {
    expect(resolveBook(STRANGER_PHONE, ALL_BOOKS)).toBeNull()
  })

  it.each<[string, string]>([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns null when the sender phone is %s', (_label, phone) => {
    expect(resolveBook(phone, ALL_BOOKS)).toBeNull()
  })

  it('returns null when there are no books configured at all', () => {
    expect(resolveBook(DILIGAF_PHONE, [])).toBeNull()
  })

  it('returns null when the only book has an empty sender phone list', () => {
    expect(resolveBook(DILIGAF_PHONE, [makeBook('DILIGAF', [])])).toBeNull()
  })

  it.each<[string, string]>([
    ['a prefix of a registered number', DILIGAF_PHONE.slice(0, 8)],
    ['a registered number with extra trailing digits', `${DILIGAF_PHONE}7`],
  ])('returns null for %s — matching is whole-number, never partial', (_label, phone) => {
    expect(resolveBook(phone, ALL_BOOKS)).toBeNull()
  })

  it.each<[string, string]>([
    ['a leading plus', `+${DILIGAF_PHONE}`],
    ['separators', '+381 64 111-1111'],
  ])('resolves the same number written with %s', (_label, phone) => {
    expect(resolveBook(phone, ALL_BOOKS)?.code).toBe('DILIGAF')
  })

  // The collision cases. §4: the personal phone maps to DILIGAF as its default
  // book "because that's where documents pile up"; PERSONAL is reached by
  // command, not by default. So a phone claimed by both belongs to DILIGAF.
  it('prefers DILIGAF when the same phone is listed in both DILIGAF and PERSONAL', () => {
    const books = [makeBook('DILIGAF', [DILIGAF_PHONE]), makeBook('PERSONAL', [DILIGAF_PHONE])]
    expect(resolveBook(DILIGAF_PHONE, books)?.code).toBe('DILIGAF')
  })

  it('still prefers DILIGAF when PERSONAL is listed first — precedence is by book, not by array order', () => {
    const books = [makeBook('PERSONAL', [DILIGAF_PHONE]), makeBook('DILIGAF', [DILIGAF_PHONE])]
    expect(resolveBook(DILIGAF_PHONE, books)?.code).toBe('DILIGAF')
  })

  it('prefers DILIGAF when the same phone is listed in both DILIGAF and SMOQUA', () => {
    const books = [makeBook('SMOQUA', [DILIGAF_PHONE]), makeBook('DILIGAF', [DILIGAF_PHONE])]
    expect(resolveBook(DILIGAF_PHONE, books)?.code).toBe('DILIGAF')
  })

  it('gives the same answer for a PERSONAL/SMOQUA collision regardless of the order the books are configured in', () => {
    const personal = makeBook('PERSONAL', [PERSONAL_PHONE])
    const smoqua = makeBook('SMOQUA', [PERSONAL_PHONE])
    const forwards = resolveBook(PERSONAL_PHONE, [personal, smoqua])
    const backwards = resolveBook(PERSONAL_PHONE, [smoqua, personal])
    expect(forwards?.code).toBe(backwards?.code)
    expect(forwards?.code).toBeDefined()
  })
})

// ===========================================================================
// getBook
// ===========================================================================

describe('getBook', () => {
  it.each<[BookCode]>([['DILIGAF'], ['PERSONAL'], ['SMOQUA']])(
    'returns the %s book when it is configured',
    (code) => {
      expect(getBook(code, ALL_BOOKS)).toEqual(makeBook(code, [
        code === 'DILIGAF' ? DILIGAF_PHONE : code === 'PERSONAL' ? PERSONAL_PHONE : SMOQUA_PHONE,
      ]))
    },
  )

  it('returns null when the requested code is not among the configured books', () => {
    expect(getBook('SMOQUA', [DILIGAF, PERSONAL])).toBeNull()
  })

  it('returns null when no books are configured', () => {
    expect(getBook('DILIGAF', [])).toBeNull()
  })

  it('returns null for a code that differs only in case — book codes are canonical', () => {
    expect(getBook('diligaf' as BookCode, ALL_BOOKS)).toBeNull()
  })
})

// ===========================================================================
// bookAllowsCommand — §7: "/invoice radi samo za DILIGAF"
// ===========================================================================

describe('bookAllowsCommand', () => {
  it.each<[BookCode, boolean]>([
    ['DILIGAF', true],
    ['PERSONAL', false],
    ['SMOQUA', false],
  ])('allows /invoice in %s: %s', (code, expected) => {
    const book = code === 'DILIGAF' ? DILIGAF : code === 'PERSONAL' ? PERSONAL : SMOQUA
    expect(bookAllowsCommand(book, 'invoice')).toBe(expected)
  })

  it.each<[CommandName, BookCode]>([
    ['expense', 'DILIGAF'],
    ['expense', 'PERSONAL'],
    ['expense', 'SMOQUA'],
    ['tebra', 'DILIGAF'],
    ['tebra', 'PERSONAL'],
    ['tebra', 'SMOQUA'],
  ])('allows /%s in %s', (command, code) => {
    const book = code === 'DILIGAF' ? DILIGAF : code === 'PERSONAL' ? PERSONAL : SMOQUA
    expect(bookAllowsCommand(book, command)).toBe(true)
  })

  it('allows /help and /book in every book, because they are how you get unstuck', () => {
    for (const book of ALL_BOOKS) {
      expect(bookAllowsCommand(book, 'help')).toBe(true)
      expect(bookAllowsCommand(book, 'book')).toBe(true)
    }
  })

  it('accepts the command with or without its leading slash and answers identically', () => {
    expect(bookAllowsCommand(SMOQUA, '/invoice')).toBe(bookAllowsCommand(SMOQUA, 'invoice'))
    expect(bookAllowsCommand(DILIGAF, '/invoice')).toBe(bookAllowsCommand(DILIGAF, 'invoice'))
  })

  it('returns false for a command it does not recognise, rather than assuming permission', () => {
    expect(bookAllowsCommand(DILIGAF, 'launch_nukes')).toBe(false)
  })

  it('returns false for an empty command string', () => {
    expect(bookAllowsCommand(DILIGAF, '')).toBe(false)
  })
})

// ===========================================================================
// parseCommand — §5 grammar, §5.1 row 3 of the cascade
// ===========================================================================

describe('parseCommand — every command', () => {
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
  ])('parses %s exactly, with empty args and no fuzz', (text, name) => {
    expect(parseCommand(text)).toEqual({ name, args: '', fuzzy: false })
  })

  it.each<[string, CommandName, string]>([
    ['/expense 4210 gorivo', 'expense', '4210 gorivo'],
    ['/cash 800 parking', 'cash', '800 parking'],
    ['/report 2026-07', 'report', '2026-07'],
    ['/book PERSONAL', 'book', 'PERSONAL'],
    ['/expense MARKETING 12000 fb ads', 'expense', 'MARKETING 12000 fb ads'],
  ])('parses %s into its name and its remaining argument text', (text, name, args) => {
    expect(parseCommand(text)).toEqual({ name, args, fuzzy: false })
  })

  it('does not normalise the argument text — /book keeps the case it was typed in', () => {
    expect(parseCommand('/book diligaf')?.args).toBe('diligaf')
  })

  it('preserves diacritics and punctuation inside the argument verbatim', () => {
    expect(parseCommand('/expense 300 kafa u kafiću, sa Šećerom!')?.args).toBe(
      '300 kafa u kafiću, sa Šećerom!',
    )
  })

  it('preserves the spacing inside the argument, trimming only its ends', () => {
    expect(parseCommand('/expense   4210   gorivo  ')?.args).toBe('4210   gorivo')
  })
})

describe('parseCommand — normalisation of the command token', () => {
  it.each<[string, CommandName]>([
    ['/EXPENSE', 'expense'],
    ['/Cash', 'cash'],
    ['/HeLp', 'help'],
  ])('matches %s case-insensitively without counting it as a fuzzy match', (text, name) => {
    expect(parseCommand(text)).toEqual({ name, args: '', fuzzy: false })
  })

  it('matches a diacritic Serbian alias as an exact match once diacritics are stripped', () => {
    expect(parseCommand('/trošak')).toMatchObject({ name: 'expense', args: '' })
  })

  it('keeps the argument when the command token needed normalising', () => {
    expect(parseCommand('/TROŠAK 4210 gorivo')).toMatchObject({
      name: 'expense',
      args: '4210 gorivo',
    })
  })

  it.each<[string]>([['/status\n'], ['  /status  ']])(
    'ignores surrounding whitespace in %j',
    (text) => {
      expect(parseCommand(text)).toEqual({ name: 'status', args: '', fuzzy: false })
    },
  )
})

describe('parseCommand — fuzzy matching at Levenshtein distance 1 exactly', () => {
  it.each<[string, CommandName]>([
    ['/expence', 'expense'], // substitution
    ['/expens', 'expense'], // deletion
    ['/expensee', 'expense'], // insertion
    ['/invoce', 'invoice'],
    ['/statuss', 'status'],
    ['/hel', 'help'],
    ['/bok', 'book'],
    ['/pendng', 'pending'],
  ])('resolves %s to /%s and flags it as fuzzy', (text, name) => {
    expect(parseCommand(text)).toEqual({ name, args: '', fuzzy: true })
  })

  it('resolves /troshak to /expense, the Serbian typo named in §5.1', () => {
    expect(parseCommand('/troshak')).toMatchObject({ name: 'expense', args: '' })
  })

  it('keeps the arguments and the case-insensitivity when the token matched fuzzily', () => {
    expect(parseCommand('/EXPENCE 300 gorivo')).toEqual({
      name: 'expense',
      args: '300 gorivo',
      fuzzy: true,
    })
  })

  it.each<[string]>([
    ['/x'], // the adversarial one: short and close to nothing
    ['/he'], // distance 2 from help
    ['/rep'], // distance 3 from report
    ['/expencee'], // distance 2 from expense
    ['/exepnse'], // a transposition, which is distance 2 under plain Levenshtein
    ['/statusss'], // distance 2 from status
  ])('returns null for %s rather than guessing at distance 2 or more', (text) => {
    expect(parseCommand(text)).toBeNull()
  })
})

describe('parseCommand — not a command', () => {
  it.each<[string]>([
    ['MATERIALS 300e'], // the SMOQUA dimension shorthand, handled downstream
    ['300e'],
    ['expense 300 gorivo'], // a real command word, but no slash
    ['help'],
    ['koliko sam dao na gorivo u julu?'],
    ['4.210,00'],
    [''],
    ['   '],
    ['/'],
    ['/ expense'], // a slash, then nothing that is a command token
  ])('returns null for %j so the caller falls through to the free-text path', (text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it('returns null rather than throwing when there is no text at all', () => {
    expect(parseCommand(undefined as unknown as string)).toBeNull()
    expect(parseCommand(null as unknown as string)).toBeNull()
  })
})

describe('parseCommand — quoted arguments', () => {
  it('strips the quotes from a /tebra prompt and keeps the prompt verbatim', () => {
    expect(parseCommand('/tebra "koliko sam dao na gorivo u julu?"')).toEqual({
      name: 'tebra',
      args: 'koliko sam dao na gorivo u julu?',
      fuzzy: false,
    })
  })

  it('keeps punctuation, digits and diacritics inside a quoted prompt exactly as typed', () => {
    expect(
      parseCommand('/tebra "prebaci sve WOLT iz jula u HRANA — 1.890,00 RSD, molim!"')?.args,
    ).toBe('prebaci sve WOLT iz jula u HRANA — 1.890,00 RSD, molim!')
  })

  it('keeps the internal spacing of a quoted prompt instead of collapsing it', () => {
    expect(parseCommand('/tebra "koliko  je  ovo"')?.args).toBe('koliko  je  ovo')
  })

  it('keeps the padding inside the quotes, because the quotes are the argument boundary', () => {
    expect(parseCommand('/tebra "  koliko je ovo  "')?.args).toBe('  koliko je ovo  ')
  })

  it('keeps a quoted prompt that spans several lines', () => {
    expect(parseCommand('/tebra "prvi red\ndrugi red"')?.args).toBe('prvi red\ndrugi red')
  })

  it('strips only the outer quotes, so an inner quoted word survives', () => {
    expect(parseCommand('/tebra "sve sto ima "WOLT" u opisu"')?.args).toBe(
      'sve sto ima "WOLT" u opisu',
    )
  })

  it('leaves an unbalanced quote alone rather than half-stripping a malformed argument', () => {
    expect(parseCommand('/tebra "nedovrseno')?.args).toBe('"nedovrseno')
  })

  it('returns an empty argument for an empty quoted prompt', () => {
    expect(parseCommand('/tebra ""')).toEqual({ name: 'tebra', args: '', fuzzy: false })
  })

  it('returns an empty argument for /tebra with nothing after it, rather than refusing to parse', () => {
    expect(parseCommand('/tebra')).toEqual({ name: 'tebra', args: '', fuzzy: false })
  })

  it('accepts an unquoted /tebra prompt and keeps it whole', () => {
    expect(parseCommand('/tebra koliko sam dao na gorivo u julu?')).toEqual({
      name: 'tebra',
      args: 'koliko sam dao na gorivo u julu?',
      fuzzy: false,
    })
  })

  it.each<[string, CommandName, string]>([
    ['/expense "kafa u kafiću"', 'expense', 'kafa u kafiću'],
    ['/cash "800, parking kod pijace"', 'cash', '800, parking kod pijace'],
    ['/report "2026-07"', 'report', '2026-07'],
  ])('strips the quotes from %s too — quoting is a property of arguments, not of /tebra', (
    text,
    name,
    args,
  ) => {
    expect(parseCommand(text)).toEqual({ name, args, fuzzy: false })
  })
})
