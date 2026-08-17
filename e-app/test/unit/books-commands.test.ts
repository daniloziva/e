import { describe, it, expect } from 'vitest'

import { resolveBook, getBook, bookAllowsCommand } from '../../src/engine/books.js'
import { parseCommand } from '../../src/engine/command-parser.js'
import type { Command, CommandName } from '../../src/engine/command-parser.js'
import type { Book, BookCode } from '../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Merged from three independent drafts (test/_drafts/books-commands/).
// Contract: src/engine/books.ts, src/engine/command-parser.ts, src/engine/types.ts
// Spec:     02-WHATSAPP-INTERFACE.md §4, §5, §5.1, §7 · 00-OVERVIEW.md D1, D11
//
// Fixtures are hand-written: every function under test is pure and synchronous,
// takes no Clock and no IdGen, so a plain object book is the whole world.
// ---------------------------------------------------------------------------

const DILIGAF_PHONE = '+381641234567'
const DILIGAF_PHONE_2 = '+381641110003'
const SMOQUA_PHONE = '+381651112223'
const PERSONAL_PHONE = '+381643333333'
const STRANGER_PHONE = '+381609998887'

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
      confirmAboveAmount: 50_000,
    },
  }
  return {
    ...base,
    ...overrides,
    senderPhones,
    features: { ...base.features, ...(overrides.features ?? {}) },
  }
}

function diligaf(phones: string[] = [DILIGAF_PHONE, DILIGAF_PHONE_2]): Book {
  return makeBook('DILIGAF', phones, {
    name: 'DILIGAF DOO',
    accountantEmail: 'knjigovodja@example.com',
    features: { sef: true, invoicing: true, vat: null, confirmAboveAmount: 100_000 },
  })
}

/**
 * 02 §4: PERSONAL "is reached by command, not by default" — in the real
 * books.json it carries no sender phone at all.
 */
function personal(phones: string[] = []): Book {
  return makeBook('PERSONAL', phones, {
    name: 'Personal',
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 20_000 },
  })
}

function smoqua(phones: string[] = [SMOQUA_PHONE]): Book {
  return makeBook('SMOQUA', phones, {
    name: 'SMOQUA',
    currency: 'EUR',
    features: { sef: false, invoicing: false, vat: null, confirmAboveAmount: 30_000 },
  })
}

/** The three real books, in the order `_state/books.json` declares them. */
function books(): Book[] {
  return [diligaf(), personal(), smoqua()]
}

// ===========================================================================
// resolveBook — 02-WHATSAPP-INTERFACE §4, 00-OVERVIEW D1
// ===========================================================================

describe('resolveBook', () => {
  it.each<[string, string, BookCode]>([
    ['your personal phone', DILIGAF_PHONE, 'DILIGAF'],
    ['a second phone listed for the same book', DILIGAF_PHONE_2, 'DILIGAF'],
    ['the shop phone', SMOQUA_PHONE, 'SMOQUA'],
  ])('resolves %s to its book', (_label, phone, expected) => {
    expect(resolveBook(phone, books())?.code).toBe(expected)
  })

  it('returns the whole book record, not just its code', () => {
    expect(resolveBook(SMOQUA_PHONE, books())).toEqual(smoqua())
  })

  it('is table-driven: a book that does list a phone is resolved by it', () => {
    const table = [diligaf(), personal([PERSONAL_PHONE]), smoqua()]
    expect(resolveBook(PERSONAL_PHONE, table)?.code).toBe('PERSONAL')
  })

  it('never resolves to PERSONAL in the real config, which has no sender phone at all', () => {
    for (const phone of [DILIGAF_PHONE, SMOQUA_PHONE, STRANGER_PHONE]) {
      expect(resolveBook(phone, books())?.code).not.toBe('PERSONAL')
    }
  })

  it('returns null for an unknown phone rather than falling back to a default book', () => {
    expect(resolveBook(STRANGER_PHONE, books())).toBeNull()
  })

  it('returns null when no books are configured at all', () => {
    expect(resolveBook(DILIGAF_PHONE, [])).toBeNull()
  })

  it('returns null when the only book has an empty sender phone list', () => {
    expect(resolveBook(DILIGAF_PHONE, [makeBook('DILIGAF', [])])).toBeNull()
  })

  it('ignores a book with an empty sender phone list when another book matches', () => {
    expect(resolveBook(DILIGAF_PHONE, [makeBook('SMOQUA', []), diligaf()])?.code).toBe('DILIGAF')
  })

  it.each<[string, string]>([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['null', null as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('returns null for %s rather than throwing, so the webhook can still answer 200', (
    _label,
    phone,
  ) => {
    expect(resolveBook(phone, books())).toBeNull()
  })

  // The WhatsApp Cloud API delivers `from` as bare digits ("381641234567" — see
  // the conversation-state path in 01-ARCHITECTURE §4), while books.json holds
  // the human form. Matching is therefore on the canonicalised digits.
  it.each<[string, string]>([
    ['bare digits, no plus', '381641234567'],
    ['a leading plus', '+381641234567'],
    ['a spaced human form', '+381 64 123 4567'],
    ['a dashed human form', '+381-64-123-4567'],
    ['surrounding whitespace', ' +381641234567 '],
  ])('resolves %s of a known phone to the same book', (_label, phone) => {
    expect(resolveBook(phone, books())?.code).toBe('DILIGAF')
  })

  it.each<[string, string]>([
    ['a suffix of a registered number', '641234567'],
    ['a prefix of a registered number', '38164123'],
    ['a registered number with an extra trailing digit', '+3816412345670'],
    ['the local 0-prefixed form, which is not expanded to a country code', '064/123-4567'],
    ['a non-numeric sender', 'not-a-phone'],
  ])('returns null for %s — matching is whole-number, never partial', (_label, phone) => {
    expect(resolveBook(phone, books())).toBeNull()
  })

  it('still resolves when a book lists the same phone twice', () => {
    const dupe = smoqua([SMOQUA_PHONE, SMOQUA_PHONE])
    expect(resolveBook(SMOQUA_PHONE, [dupe])?.code).toBe('SMOQUA')
  })

  it('resolves a phone listed second in a book senderPhones array', () => {
    const table = [smoqua(), personal(['+381600000001', PERSONAL_PHONE])]
    expect(resolveBook(PERSONAL_PHONE, table)?.code).toBe('PERSONAL')
  })

  // Collision precedence. 02 §4: "Your personal phone maps to DILIGAF as its
  // default book, because that's where documents pile up. PERSONAL is reached
  // by command, not by default." So a phone claimed twice belongs to DILIGAF —
  // and the answer must not depend on the order books.json happens to list.
  it.each<[string, Book[]]>([
    ['DILIGAF first', [diligaf([DILIGAF_PHONE]), personal([DILIGAF_PHONE])]],
    ['PERSONAL first', [personal([DILIGAF_PHONE]), diligaf([DILIGAF_PHONE])]],
  ])('prefers DILIGAF over PERSONAL for a shared phone, with %s in the table', (_label, table) => {
    expect(resolveBook(DILIGAF_PHONE, table)?.code).toBe('DILIGAF')
  })

  it.each<[string, Book[]]>([
    ['DILIGAF first', [diligaf([DILIGAF_PHONE]), smoqua([DILIGAF_PHONE])]],
    ['SMOQUA first', [smoqua([DILIGAF_PHONE]), diligaf([DILIGAF_PHONE])]],
  ])('prefers DILIGAF over SMOQUA for a shared phone, with %s in the table', (_label, table) => {
    expect(resolveBook(DILIGAF_PHONE, table)?.code).toBe('DILIGAF')
  })

  it('resolves a phone shared by all three books to DILIGAF whatever the table order', () => {
    const forwards = [diligaf([DILIGAF_PHONE]), personal([DILIGAF_PHONE]), smoqua([DILIGAF_PHONE])]
    const backwards = [...forwards].reverse()
    expect(resolveBook(DILIGAF_PHONE, forwards)?.code).toBe('DILIGAF')
    expect(resolveBook(DILIGAF_PHONE, backwards)?.code).toBe('DILIGAF')
  })

  // The spec gives no basis for picking a winner between PERSONAL and SMOQUA,
  // so only determinism is pinned here — not which one wins.
  it('gives the same answer for a PERSONAL/SMOQUA collision whichever order they are configured in', () => {
    const p = personal([PERSONAL_PHONE])
    const s = smoqua([PERSONAL_PHONE])
    const forwards = resolveBook(PERSONAL_PHONE, [p, s])
    const backwards = resolveBook(PERSONAL_PHONE, [s, p])
    expect(forwards?.code).toBeDefined()
    expect(forwards?.code).toBe(backwards?.code)
  })

  it('returns the same book on repeated calls with the same inputs', () => {
    const table = books()
    expect(resolveBook(DILIGAF_PHONE, table)).toEqual(resolveBook(DILIGAF_PHONE, table))
  })

  it('does not mutate the book table it was given', () => {
    const table = books()
    const before = JSON.stringify(table)
    resolveBook(DILIGAF_PHONE, table)
    resolveBook(STRANGER_PHONE, table)
    expect(JSON.stringify(table)).toBe(before)
  })
})

// ===========================================================================
// getBook — lookup by canonical code
// ===========================================================================

describe('getBook', () => {
  it.each<BookCode>(['DILIGAF', 'PERSONAL', 'SMOQUA'])(
    'returns the %s book when it is configured',
    (code) => {
      expect(getBook(code, books())?.code).toBe(code)
    },
  )

  it('returns the whole configured record', () => {
    expect(getBook('DILIGAF', books())).toEqual(diligaf())
  })

  it('returns null when the requested code is not among the configured books', () => {
    expect(getBook('SMOQUA', [diligaf(), personal()])).toBeNull()
  })

  it('returns null when no books are configured', () => {
    expect(getBook('DILIGAF', [])).toBeNull()
  })

  it('returns the first entry when a code is declared twice, so lookup stays deterministic', () => {
    const first = makeBook('SMOQUA', [SMOQUA_PHONE], { name: 'first' })
    const second = makeBook('SMOQUA', [STRANGER_PHONE], { name: 'second' })
    expect(getBook('SMOQUA', [first, second])?.name).toBe('first')
  })

  it.each<[string, string]>([
    ['a lowercase code, because book codes are canonical and are not normalised here', 'diligaf'],
    ['an unknown code', 'ACME'],
    ['an empty code', ''],
  ])('returns null for %s', (_label, code) => {
    expect(getBook(code as BookCode, books())).toBeNull()
  })
})

// ===========================================================================
// bookAllowsCommand — 02 §7: "⚠ /invoice radi samo za DILIGAF"
// ===========================================================================

describe('bookAllowsCommand', () => {
  it('allows /invoice for DILIGAF, the only book that issues invoices', () => {
    expect(bookAllowsCommand(diligaf(), 'invoice')).toBe(true)
  })

  it.each<[BookCode, Book]>([
    ['PERSONAL', personal()],
    ['SMOQUA', smoqua()],
  ])('denies /invoice for %s', (_code, book) => {
    expect(bookAllowsCommand(book, 'invoice')).toBe(false)
  })

  // Gating reads book.features, not book.code — a strict superset of
  // "DILIGAF-only" that a code-hardcoded implementation fails.
  it('gates /invoice on the invoicing feature flag rather than on the book code', () => {
    const shopThatInvoices = makeBook('SMOQUA', [SMOQUA_PHONE], {
      features: { sef: false, invoicing: true, vat: null, confirmAboveAmount: 30_000 },
    })
    const diligafWithoutInvoicing = makeBook('DILIGAF', [DILIGAF_PHONE], {
      features: { sef: true, invoicing: false, vat: null, confirmAboveAmount: 100_000 },
    })
    expect(bookAllowsCommand(shopThatInvoices, 'invoice')).toBe(true)
    expect(bookAllowsCommand(diligafWithoutInvoicing, 'invoice')).toBe(false)
  })

  it.each<[BookCode, Book, boolean]>([
    ['DILIGAF', diligaf(), true],
    ['PERSONAL', personal(), false],
    ['SMOQUA', smoqua(), false],
  ])('allows /pending for %s: %s — SEF is a per-book feature', (_code, book, expected) => {
    expect(bookAllowsCommand(book, 'pending')).toBe(expected)
  })

  // Commands that read or route: they never touch a feature a book lacks.
  it.each<CommandName>(['expense', 'misc', 'status', 'book', 'tebra', 'help'])(
    'allows /%s for every book',
    (command) => {
      for (const book of books()) {
        expect(bookAllowsCommand(book, command)).toBe(true)
      }
    },
  )

  it('allows /cash for PERSONAL, where cash outflows are booked', () => {
    expect(bookAllowsCommand(personal(), 'cash')).toBe(true)
  })

  it.each<[BookCode, Book]>([
    ['DILIGAF', diligaf()],
    ['PERSONAL', personal()],
  ])('allows /report for %s, which has an accountant package', (_code, book) => {
    expect(bookAllowsCommand(book, 'report')).toBe(true)
  })

  it.each<[string, string]>([
    ['an unknown command', 'frobnicate'],
    ['a near-miss of a real command', 'invoicing'],
    ['a command-shaped path', 'invoice_out'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a bare slash', '/'],
  ])('denies %s rather than defaulting to allowed', (_label, command) => {
    expect(bookAllowsCommand(diligaf(), command)).toBe(false)
  })

  it('denies a missing command rather than throwing', () => {
    expect(bookAllowsCommand(diligaf(), undefined as unknown as string)).toBe(false)
    expect(bookAllowsCommand(diligaf(), null as unknown as string)).toBe(false)
  })

  // Callers hold either the parsed CommandName or the raw token; both answer
  // identically. See specGaps — the contract does not state which is canonical.
  describe('input tolerance', () => {
    it('accepts the command written with its leading slash', () => {
      expect(bookAllowsCommand(diligaf(), '/invoice')).toBe(true)
      expect(bookAllowsCommand(smoqua(), '/invoice')).toBe(false)
    })

    it('answers identically with and without the leading slash', () => {
      expect(bookAllowsCommand(smoqua(), '/invoice')).toBe(bookAllowsCommand(smoqua(), 'invoice'))
      expect(bookAllowsCommand(diligaf(), '/invoice')).toBe(bookAllowsCommand(diligaf(), 'invoice'))
    })

    it('is case-insensitive about the command name', () => {
      expect(bookAllowsCommand(diligaf(), 'INVOICE')).toBe(true)
      expect(bookAllowsCommand(personal(), 'Invoice')).toBe(false)
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

// ===========================================================================
// parseCommand — 02 §5 grammar, §5.1 row 3 of the routing cascade
// ===========================================================================

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

  it.each<[string, string, CommandName]>([
    ['upper case', '/EXPENSE', 'expense'],
    ['mixed case', '/eXpEnSe', 'expense'],
    ['title case', '/Book', 'book'],
    ['title case again', '/Cash', 'cash'],
  ])('matches %s (%s) without counting it as a fuzzy match', (_label, text, name) => {
    expect(parseCommand(text)).toEqual(cmd(name))
  })

  it.each<[string, string]>([
    ['leading whitespace', '  /status'],
    ['trailing whitespace', '/status  '],
    ['a trailing newline', '/status\n'],
    ['surrounding newlines', '\n/status\n'],
  ])('ignores %s around the command', (_label, text) => {
    expect(parseCommand(text)).toEqual(cmd('status'))
  })

  // The Serbian alias table behind the command names. Whether an alias hit
  // counts as fuzzy is undefined, so only name and args are asserted.
  it.each<[string, string]>([
    ['the diacritic-free alias', '/trosak'],
    ['the same alias with diacritics', '/trošak'],
    ['the alias upper-cased with diacritics', '/TROŠAK'],
  ])('resolves %s (%s) to expense', (_label, text) => {
    expect(parseCommand(text)).toMatchObject({ name: 'expense', args: '' })
  })

  it('keeps the argument when the command token needed normalising', () => {
    expect(parseCommand('/TROŠAK 4210 gorivo')).toMatchObject({
      name: 'expense',
      args: '4210 gorivo',
    })
  })
})

describe('parseCommand — arguments', () => {
  it.each<[string, CommandName, string]>([
    ['/expense 4.210,00 OMV gorivo', 'expense', '4.210,00 OMV gorivo'],
    ['/expense MARKETING 12000 fb ads', 'expense', 'MARKETING 12000 fb ads'],
    ['/cash 1500din pijaca', 'cash', '1500din pijaca'],
    ['/report 2026-07', 'report', '2026-07'],
    ['/book DILIGAF', 'book', 'DILIGAF'],
    ['/help me', 'help', 'me'],
  ])('parses %s, keeping everything after the command token as args', (text, name, args) => {
    expect(parseCommand(text)).toEqual(cmd(name, args))
  })

  it('does not interpret the argument — the money grammar is a separate module', () => {
    expect(parseCommand('/expense tri hiljade za gorivo')?.args).toBe('tri hiljade za gorivo')
  })

  it.each<[string, string]>([
    ['/book personal', 'personal'],
    ['/book diligaf', 'diligaf'],
    ['/book NOSUCHBOOK', 'NOSUCHBOOK'],
  ])('passes the /book argument (%s) through verbatim, without validating it', (text, args) => {
    expect(parseCommand(text)).toEqual(cmd('book', args))
  })

  it('preserves the case of the argument while the command itself is case-insensitive', () => {
    expect(parseCommand('/EXPENSE MATERIALS Projekat 1')).toEqual(
      cmd('expense', 'MATERIALS Projekat 1'),
    )
  })

  it('preserves diacritics and punctuation inside the argument verbatim', () => {
    expect(parseCommand('/expense 300 kafa u kafiću, sa Šećerom!')?.args).toBe(
      '300 kafa u kafiću, sa Šećerom!',
    )
  })

  it('trims only the edges of the argument, keeping inner spacing verbatim', () => {
    expect(parseCommand('  /cash   500   kafa i burek  ')).toEqual(cmd('cash', '500   kafa i burek'))
  })

  it('accepts a tab between the command token and its argument', () => {
    expect(parseCommand('/report\t2026-07')).toEqual(cmd('report', '2026-07'))
  })

  it('keeps a newline inside a multi-line caption argument', () => {
    expect(parseCommand('/expense 4210\nOMV gorivo')?.args).toBe('4210\nOMV gorivo')
  })

  it('returns empty args for a command given without one', () => {
    expect(parseCommand('/report')).toEqual(cmd('report'))
  })
})

describe('parseCommand — fuzzy matching at Levenshtein distance 1', () => {
  it.each<[string, CommandName]>([
    ['/expence', 'expense'], // substitution
    ['/expens', 'expense'], // deletion
    ['/expenses', 'expense'], // insertion — the natural plural is still distance 1
    ['/expensee', 'expense'],
    ['/cas', 'cash'],
    ['/invoce', 'invoice'],
    ['/pendin', 'pending'],
    ['/pendng', 'pending'],
    ['/mis', 'misc'],
    ['/mist', 'misc'],
    ['/repor', 'report'],
    ['/statu', 'status'],
    ['/statuss', 'status'],
    ['/boo', 'book'],
    ['/bok', 'book'],
    ['/tebr', 'tebra'],
    ['/hel', 'help'],
    ['/hep', 'help'],
    ['/hlp', 'help'],
  ])('resolves %s to /%s and flags it as fuzzy', (text, name) => {
    expect(parseCommand(text)).toEqual(cmd(name, '', true))
  })

  it('keeps the argument when the command token was fuzzy-matched', () => {
    expect(parseCommand('/expence 4210 OMV')).toEqual(cmd('expense', '4210 OMV', true))
  })

  it('fuzzy-matches case-insensitively', () => {
    expect(parseCommand('/EXPENCE 300 gorivo')).toEqual(cmd('expense', '300 gorivo', true))
  })

  it('resolves the Serbian typo /troshak to expense without a model call (02 §5.1)', () => {
    expect(parseCommand('/troshak 300e')).toMatchObject({ name: 'expense', args: '300e' })
  })
})

describe('parseCommand — refuses beyond distance 1, rather than guessing', () => {
  it.each<[string, string]>([
    ['two substitutions', '/expance'],
    ['two deletions', '/expns'],
    ['a two-edit misspelling', '/expnce'],
    ['a transposition, which is distance 2 under plain Levenshtein', '/exepnse'],
    ['another transposition', '/expesne'],
    ['a transposition on a short command', '/tebar'],
    ['an over-long plural', '/statuses'],
    ['a doubled trailing letter run', '/statusss'],
    ['a two-edit insertion', '/expencee'],
    ['a derived word', '/invoicing'],
    ['a three-letter stub', '/exp'],
    ['a two-letter stub', '/he'],
    ['a three-letter stub of report', '/rep'],
    ['a single letter close to nothing', '/x'],
    ['a single-letter prefix of a real command', '/e'],
    ['another single-letter prefix', '/c'],
    ['a Serbian word that is no command', '/gorivo 4210'],
    ['a word far from everything', '/frobnicate 4210'],
    ['a Cyrillic command token, which is not transliterated', '/трошак'],
  ])('returns null for %s (%s)', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })
})

describe('parseCommand — not a command, so free text keeps flowing to the slot filler', () => {
  it.each<[string, string]>([
    ['an empty message', ''],
    ['whitespace only', '   '],
    ['newlines only', '\n\n'],
    ['a bare slash', '/'],
    ['a slash then a space', '/ expense 4210'],
    ['a slash then digits', '/1234'],
    ['a slash then an emoji', '/🙂'],
    ['a leading punctuation mark before the slash', '?/expense'],
    ['the SMOQUA dimension shorthand, which is handled downstream', 'MATERIALS 300e'],
    ['the shorthand in reversed order', '300e MATERIALS'],
    ['a bare amount', '4.210,00'],
    ['a command word without its slash', 'expense 4210 gorivo'],
    ['another command word without its slash', 'help'],
    ['a command word later in the sentence', 'danas /expense 4210'],
    ['a command word inside free text', 'pošalji /expense sutra'],
    ['a URL that happens to contain a command path', 'https://example.com/expense'],
    ['a plain courtesy', 'hvala'],
    ['an emoji', '👍'],
    ['a bare question', 'koliko sam dao na gorivo u julu?'],
    ['free text for the model to slot-fill', 'MATERIJAAL PAMUK 200E Projekat 1'],
  ])('returns null for %s', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })

  it.each<[string, string]>([
    ['null', null as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('returns null for %s input rather than throwing', (_label, text) => {
    expect(parseCommand(text)).toBeNull()
  })
})

describe('parseCommand — /tebra and its quoted argument (D17)', () => {
  it('strips the surrounding quotes and keeps the prompt verbatim', () => {
    expect(parseCommand('/tebra "koliko sam dao na gorivo u julu?"')).toEqual(
      cmd('tebra', 'koliko sam dao na gorivo u julu?'),
    )
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
    expect(parseCommand('/tebra "  gorivo u julu  "')?.args).toBe('  gorivo u julu  ')
  })

  it('keeps a quoted prompt that spans several lines', () => {
    expect(parseCommand('/tebra "prvi red\ndrugi red"')?.args).toBe('prvi red\ndrugi red')
  })

  it('keeps the case of a quoted prompt', () => {
    expect(parseCommand('/TEBRA "Prebaci sve WOLT iz jula u HRANA"')).toEqual(
      cmd('tebra', 'Prebaci sve WOLT iz jula u HRANA'),
    )
  })

  it('strips only the outermost quote pair, so an inner quoted word survives', () => {
    expect(parseCommand('/tebra "nadji "WOLT" u julu"')?.args).toBe('nadji "WOLT" u julu')
  })

  it('strips typographic quotes, which phone keyboards substitute automatically', () => {
    expect(parseCommand('/tebra “koliko sam potrošio?”')).toEqual(
      cmd('tebra', 'koliko sam potrošio?'),
    )
  })

  it('does not strip single quotes, which are ordinary characters in a prompt', () => {
    expect(parseCommand("/tebra 'koliko sam potrošio?'")?.args).toBe("'koliko sam potrošio?'")
  })

  it.each<[string, string, string]>([
    ['an unterminated opening quote', '/tebra "nedovrseno', '"nedovrseno'],
    ['a stray closing quote', '/tebra koliko"', 'koliko"'],
    ['text after the closing quote', '/tebra "gorivo" hvala', '"gorivo" hvala'],
  ])('leaves the argument verbatim for %s, rather than half-repairing it', (_label, text, args) => {
    expect(parseCommand(text)?.args).toBe(args)
  })

  it('accepts an unquoted prompt and keeps it whole', () => {
    expect(parseCommand('/tebra koliko sam dao na gorivo u julu?')).toEqual(
      cmd('tebra', 'koliko sam dao na gorivo u julu?'),
    )
  })

  it('returns empty args for an empty quoted prompt', () => {
    expect(parseCommand('/tebra ""')).toEqual(cmd('tebra'))
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
