/**
 * E — email routing rules.
 *
 * Merged from three independent drafts (engineers 1-3).
 * Spec: 03-DILIGAF.md §1 Routing table, 04-PERSONAL.md §2, 05-SMOQUA.md §3d.
 *
 * Written BEFORE the implementation exists: every case fails with
 * "not implemented" until the stubs are filled in.
 *
 * The routing table is DATA, so every test supplies its own rules. The most
 * valuable behaviour in this module is the REFUSAL: an unroutable message goes
 * to E/Failed, and E never guesses which book an email belongs to.
 *
 * All three drafts agreed on every substantive point — priority ordering,
 * first-match-wins, sender fall-through, prefix semantics without an implicit
 * word boundary, and normalized matching. This file is close to their union.
 */

import { describe, it, expect } from 'vitest'
import {
  route,
  mailEventKey,
  type MailEnvelope,
  type MailRule,
  type RouteResult,
} from '../../src/engine/mail/route.js'
import type { BookCode, DocCategory } from '../../src/engine/types.js'

// ─────────────────────────────── fixtures ───────────────────────────────

const DOO_BANK_SENDER = 'izvodi@banka-doo.rs'
const PERSONAL_BANK_SENDER = 'noreply@banka-licna.rs'

const C_ACUTE = 'ć'
const C_CARON = 'č'
const S_CARON = 'Š'
const D_STROKE_UPPER = 'Đ'
const D_STROKE_LOWER = 'đ'
/** Same letters composed from a base letter + a combining mark (NFD). */
const C_ACUTE_NFD = 'ć'
const C_CARON_NFD = 'č'
const NBSP = ' '

const STATEMENT_ASCII = 'Izvod po tekucem racunu/Dinar Current Account Statement'
const STATEMENT_DIACRITIC = `Izvod po teku${C_ACUTE}em ra${C_CARON}unu/Dinar Current Account Statement`

const R_DOO_IZVOD: MailRule = {
  id: 'doo-izvod',
  fromPattern: DOO_BANK_SENDER,
  subjectPattern: 'izvod',
  matchType: 'contains',
  book: 'DILIGAF',
  category: 'izvod',
  priority: 10,
}

const R_EXPENSE_EN: MailRule = {
  id: 'diligaf-expense-en',
  subjectPattern: 'e:expense',
  matchType: 'prefix',
  book: 'DILIGAF',
  category: 'expense',
  priority: 20,
}

const R_EXPENSE_SR: MailRule = {
  id: 'diligaf-expense-sr',
  subjectPattern: 'e:trosak',
  matchType: 'prefix',
  book: 'DILIGAF',
  category: 'expense',
  priority: 21,
}

const R_PERSONAL_STATEMENT: MailRule = {
  id: 'personal-statement',
  subjectPattern: 'izvod po tekucem racunu/dinar current account statement',
  matchType: 'prefix',
  book: 'PERSONAL',
  category: 'statement',
  priority: 30,
}

const R_SMOQUA: MailRule = {
  id: 'smoqua-expense',
  subjectPattern: 'e:smoqua',
  matchType: 'prefix',
  book: 'SMOQUA',
  category: 'expense',
  priority: 40,
}

const SPEC_TABLE: MailRule[] = [R_DOO_IZVOD, R_EXPENSE_EN, R_EXPENSE_SR, R_PERSONAL_STATEMENT, R_SMOQUA]

/** Build an envelope. `from` defaults to a sender no rule is scoped to. */
function envelope(subject: string, from = 'someone@example.com'): MailEnvelope {
  return {
    messageId: '<20260811.0612.abcdef@mail.example>',
    from,
    subject,
    receivedAt: '2026-08-11T06:12:00.000Z',
  }
}

function hit(book: BookCode, category: DocCategory, ruleId: string): RouteResult {
  return { book, category, ruleId }
}

// ═══════════════════════════════════════════════════════════════════════════
// The spec table, end to end
// ═══════════════════════════════════════════════════════════════════════════

describe('route — the routing table from 03-DILIGAF §1', () => {
  it.each([
    {
      name: 'a DOO izvod from the business bank',
      subject: 'Izvod br. 152 za racun 170-0030012345678-90',
      from: DOO_BANK_SENDER,
      expected: hit('DILIGAF', 'izvod', 'doo-izvod'),
    },
    {
      name: 'the English expense prefix',
      subject: 'E:EXPENSE OMV Srbija gorivo',
      from: 'someone@example.com',
      expected: hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    },
    {
      name: 'the Serbian expense prefix',
      subject: 'E:TROSAK racun za struju',
      from: 'someone@example.com',
      expected: hit('DILIGAF', 'expense', 'diligaf-expense-sr'),
    },
    {
      name: 'the Serbian expense prefix written with diacritics',
      subject: `E:TRO${S_CARON}AK ra${C_CARON}un za struju`,
      from: 'someone@example.com',
      expected: hit('DILIGAF', 'expense', 'diligaf-expense-sr'),
    },
    {
      name: 'a personal statement with the account number and period appended',
      subject: `${STATEMENT_ASCII} 265-0000001234567-89 01.07.2026-31.07.2026`,
      from: PERSONAL_BANK_SENDER,
      expected: hit('PERSONAL', 'statement', 'personal-statement'),
    },
    {
      name: 'a personal statement written with Serbian diacritics',
      subject: `${STATEMENT_DIACRITIC} 265-0000001234567-89`,
      from: PERSONAL_BANK_SENDER,
      expected: hit('PERSONAL', 'statement', 'personal-statement'),
    },
    {
      name: 'the SMOQUA expense prefix',
      subject: 'E:SMOQUA faktura dobavljaca',
      from: 'someone@example.com',
      expected: hit('SMOQUA', 'expense', 'smoqua-expense'),
    },
    {
      name: 'the SMOQUA expense prefix carrying a dimension',
      subject: 'E:SMOQUA MATERIALS drvo za police',
      from: 'someone@example.com',
      expected: hit('SMOQUA', 'expense', 'smoqua-expense'),
    },
  ])('routes $name', ({ subject, from, expected }) => {
    expect(route(envelope(subject, from), SPEC_TABLE)).toEqual(expected)
  })

  it('returns exactly the book, category and rule id of the matching rule and nothing else', () => {
    expect(route(envelope('E:SMOQUA lepak'), SPEC_TABLE)).toEqual({
      book: 'SMOQUA',
      category: 'expense',
      ruleId: 'smoqua-expense',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The refusal — the most valuable behaviour in this module
// ═══════════════════════════════════════════════════════════════════════════

describe('route — no match means no guess', () => {
  it.each([
    { name: 'a personal reply', subject: 'Re: rucak u petak' },
    { name: 'a newsletter', subject: 'Vesti iz banke - avgust 2026' },
    { name: 'a shop newsletter', subject: 'Summer sale' },
    { name: 'an empty subject', subject: '' },
    { name: 'a whitespace-only subject', subject: '   \t\r\n ' },
    { name: 'a near-miss on the expense prefix', subject: 'E:EXPENS OMV' },
    { name: 'a near-miss on the SMOQUA prefix', subject: 'E SMOQUA faktura' },
    { name: 'a marker that is not at the start of the subject', subject: 'Fwd: E:EXPENSE OMV' },
    { name: 'a reply carrying the marker mid-subject', subject: 'RE: E:EXPENSE OMV faktura' },
    { name: 'the marker at the very end of the subject', subject: 'Faktura E:EXPENSE' },
    { name: 'the word expense used in prose', subject: 'expense report attached' },
    {
      name: 'the DOO izvod subject arriving from an unknown sender',
      subject: 'Izvod br. 152 za racun 170-0030012345678-90',
    },
    { name: 'the statement subject with a word in front of it', subject: `Vas ${STATEMENT_ASCII}` },
  ])('returns null for $name rather than guessing a book', ({ subject }) => {
    expect(route(envelope(subject), SPEC_TABLE)).toBeNull()
  })

  it('returns null when there are no rules at all', () => {
    expect(route(envelope('E:EXPENSE OMV Srbija'), [])).toBeNull()
  })

  it('returns null when the rules argument is absent, rather than throwing', () => {
    expect(route(envelope('E:EXPENSE OMV'), undefined as unknown as MailRule[])).toBeNull()
  })

  it('returns null for a bank subject that is not a statement', () => {
    expect(route(envelope('Obavestenje o promeni tarife', DOO_BANK_SENDER), SPEC_TABLE)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Normalization: lowercase, diacritics stripped, whitespace collapsed
// ═══════════════════════════════════════════════════════════════════════════

describe('route — normalized subject matching', () => {
  it.each([
    { name: 'the canonical ASCII form', subject: STATEMENT_ASCII },
    { name: 'Serbian diacritics on tekucem and racunu', subject: STATEMENT_DIACRITIC },
    {
      name: 'a stray double space between words',
      subject: 'Izvod po tekucem  racunu/Dinar Current Account Statement',
    },
    {
      name: 'diacritics and a double space together',
      subject: `Izvod po teku${C_ACUTE}em  ra${C_CARON}unu/Dinar Current Account Statement`,
    },
    { name: 'all upper case', subject: STATEMENT_ASCII.toUpperCase() },
    { name: 'all lower case', subject: STATEMENT_ASCII.toLowerCase() },
    { name: 'leading and trailing whitespace', subject: `   ${STATEMENT_ASCII}   ` },
    {
      name: 'a header folded across lines',
      subject: 'Izvod po tekucem racunu/Dinar\r\n Current Account Statement',
    },
    {
      name: 'tabs used as separators',
      subject: 'Izvod\tpo\ttekucem\tracunu/Dinar Current Account Statement',
    },
    {
      name: 'a non-breaking space between words',
      subject: `Izvod po${NBSP}tekucem racunu/Dinar Current Account Statement`,
    },
    {
      name: 'diacritics supplied as combining marks rather than precomposed',
      subject: `Izvod po teku${C_ACUTE_NFD}em ra${C_CARON_NFD}unu/Dinar Current Account Statement`,
    },
    {
      name: 'the account number appended after the prefix',
      subject: `${STATEMENT_ASCII} 265-0000001234567-89`,
    },
  ])('matches the PERSONAL statement rule by prefix given $name', ({ subject }) => {
    expect(route(envelope(subject, PERSONAL_BANK_SENDER), [R_PERSONAL_STATEMENT])).toEqual(
      hit('PERSONAL', 'statement', 'personal-statement'),
    )
  })

  it.each([
    { name: 'lower case', subject: 'e:expense omv' },
    { name: 'upper case', subject: 'E:EXPENSE OMV' },
    { name: 'mixed case', subject: 'e:ExPeNsE omv' },
    { name: 'leading whitespace', subject: '   E:EXPENSE omv' },
    { name: 'a trailing newline', subject: 'E:EXPENSE omv\r\n' },
  ])('matches the E:EXPENSE prefix in $name', ({ subject }) => {
    expect(route(envelope(subject), [R_EXPENSE_EN])).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    )
  })

  it('does not match E:EXPENSE when a space splits the marker itself', () => {
    // "E: EXPENSE" collapses to "e: expense", which is not the prefix "e:expense".
    expect(route(envelope('E: EXPENSE omv'), [R_EXPENSE_EN])).toBeNull()
  })

  it('matches a d-stroke in the subject against the same letter in the pattern', () => {
    // Whatever "diacritics stripped" does with dj, it must do to both sides.
    const rule: MailRule = {
      ...R_EXPENSE_SR,
      subjectPattern: `e:trosak ${D_STROKE_LOWER}ubrivo`,
      matchType: 'contains',
    }
    expect(route(envelope(`E:TRO${S_CARON}AK ${D_STROKE_UPPER}ubrivo`), [rule])).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-sr'),
    )
  })

  it('collapses runs of whitespace without deleting them, so words never fuse together', () => {
    expect(
      route(envelope('Izvodpo tekucem racunu/Dinar Current Account Statement'), [
        R_PERSONAL_STATEMENT,
      ]),
    ).toBeNull()
  })

  it('normalizes the rule pattern too, so a table written with diacritics still matches', () => {
    const rule: MailRule = {
      ...R_PERSONAL_STATEMENT,
      subjectPattern: `Izvod po teku${C_ACUTE}em  ra${C_CARON}unu/Dinar Current Account Statement`,
    }
    expect(route(envelope(`${STATEMENT_ASCII.toLowerCase()} 265`), [rule])).toEqual(
      hit('PERSONAL', 'statement', 'personal-statement'),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Match types
// ═══════════════════════════════════════════════════════════════════════════

describe('route — match types', () => {
  const prefixRule: MailRule = {
    id: 'p',
    subjectPattern: 'e:expense',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'expense',
    priority: 1,
  }
  const containsRule: MailRule = { ...prefixRule, id: 'c', matchType: 'contains' }
  const exactRule: MailRule = { ...prefixRule, id: 'x', matchType: 'exact' }

  it('matches a prefix rule when the pattern starts the subject', () => {
    expect(route(envelope('E:EXPENSE OMV'), [prefixRule])).toEqual(hit('DILIGAF', 'expense', 'p'))
  })

  it('matches a prefix rule when the subject is exactly the pattern', () => {
    expect(route(envelope('E:EXPENSE'), [prefixRule])).toEqual(hit('DILIGAF', 'expense', 'p'))
  })

  it('returns null for a prefix rule when the pattern appears later in the subject', () => {
    expect(route(envelope('Fwd: E:EXPENSE OMV'), [prefixRule])).toBeNull()
  })

  it('matches a prefix rule even when the next character is not a separator', () => {
    // Prefix means prefix — no implicit word boundary is imposed. All three
    // drafts agreed on this independently.
    expect(route(envelope('E:EXPENSES za jul'), [prefixRule])).toEqual(
      hit('DILIGAF', 'expense', 'p'),
    )
  })

  it('matches a contains rule when the pattern appears mid-subject', () => {
    expect(route(envelope('Fwd: E:EXPENSE OMV'), [containsRule])).toEqual(
      hit('DILIGAF', 'expense', 'c'),
    )
  })

  it('matches a contains rule when the pattern ends the subject', () => {
    expect(route(envelope('prosledjeno e:expense'), [containsRule])).toEqual(
      hit('DILIGAF', 'expense', 'c'),
    )
  })

  it('returns null for a contains rule whose pattern is absent from the subject', () => {
    expect(route(envelope('racun za gorivo'), [containsRule])).toBeNull()
  })

  it('matches an exact rule on the whole normalized subject', () => {
    expect(route(envelope('  e:EXPENSE  '), [exactRule])).toEqual(hit('DILIGAF', 'expense', 'x'))
  })

  it('returns null for an exact rule when the subject carries a suffix', () => {
    expect(route(envelope('E:EXPENSE OMV'), [exactRule])).toBeNull()
  })

  it('returns null for an exact rule when the subject carries a prefix', () => {
    expect(route(envelope('Fwd: E:EXPENSE'), [exactRule])).toBeNull()
  })

  it('never matches a rule whose subject pattern is empty', () => {
    expect(route(envelope('bilo sta'), [{ ...containsRule, subjectPattern: '' }])).toBeNull()
  })

  it('never matches a rule whose subject pattern is only whitespace', () => {
    expect(route(envelope('bilo sta'), [{ ...containsRule, subjectPattern: '   ' }])).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Rules that constrain the sender
// ═══════════════════════════════════════════════════════════════════════════

describe('route — rules that constrain the sender', () => {
  it('matches when both the sender and the subject match', () => {
    expect(route(envelope('Izvod br. 152', DOO_BANK_SENDER), [R_DOO_IZVOD])).toEqual(
      hit('DILIGAF', 'izvod', 'doo-izvod'),
    )
  })

  it('returns null when the subject matches but the sender does not', () => {
    expect(route(envelope('Izvod br. 152', PERSONAL_BANK_SENDER), [R_DOO_IZVOD])).toBeNull()
  })

  it('returns null when the sender matches but the subject does not', () => {
    expect(route(envelope('Obavestenje o naknadi', DOO_BANK_SENDER), [R_DOO_IZVOD])).toBeNull()
  })

  it('returns null when the sender is empty and the rule requires one', () => {
    expect(route(envelope('Izvod br. 152', ''), [R_DOO_IZVOD])).toBeNull()
  })

  it('matches the sender as a normalized substring of a display-name address', () => {
    const from = '"Banka DOO a.d. Beograd" <IZVODI@Banka-Doo.RS>'
    expect(route(envelope('Izvod br. 152', from), [R_DOO_IZVOD])).toEqual(
      hit('DILIGAF', 'izvod', 'doo-izvod'),
    )
  })

  it('matches the sender when only the domain is constrained', () => {
    const domainRule: MailRule = { ...R_DOO_IZVOD, fromPattern: '@banka-doo.rs' }
    expect(route(envelope('Izvod br. 152', 'noreply@banka-doo.rs'), [domainRule])).toEqual(
      hit('DILIGAF', 'izvod', 'doo-izvod'),
    )
  })

  it('returns null for a look-alike sender when the pattern is anchored with angle brackets', () => {
    const anchored: MailRule = { ...R_DOO_IZVOD, fromPattern: '<izvodi@banka-doo.rs>' }
    expect(
      route(envelope('Izvod br. 152', 'izvodi@banka-doo.rs.evil.example'), [anchored]),
    ).toBeNull()
  })

  it('ignores the sender entirely when the rule has no fromPattern', () => {
    expect(route(envelope('E:EXPENSE OMV', 'anyone@anywhere.example'), [R_EXPENSE_EN])).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    )
  })

  it('treats an empty fromPattern as no sender constraint', () => {
    const rule: MailRule = { ...R_EXPENSE_EN, fromPattern: '' }
    expect(route(envelope('E:EXPENSE OMV', 'anyone@anywhere.example'), [rule])).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    )
  })

  it('routes the personal statement to PERSONAL even though the DOO rule ranks higher, because that rule is sender-scoped', () => {
    const subject = `${STATEMENT_ASCII} 265-0000001234567-89`
    expect(route(envelope(subject, PERSONAL_BANK_SENDER), SPEC_TABLE)).toEqual(
      hit('PERSONAL', 'statement', 'personal-statement'),
    )
  })

  it('routes the same subject to DILIGAF when it arrives from the business bank, because the sender decides', () => {
    const subject = `${STATEMENT_ASCII} 170-0030012345678-90`
    expect(route(envelope(subject, DOO_BANK_SENDER), SPEC_TABLE)).toEqual(
      hit('DILIGAF', 'izvod', 'doo-izvod'),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Priority and first-match-wins
// ═══════════════════════════════════════════════════════════════════════════

describe('route — priority ordering', () => {
  const low: MailRule = {
    id: 'low-priority-number',
    subjectPattern: 'e:',
    matchType: 'prefix',
    book: 'SMOQUA',
    category: 'expense',
    priority: 1,
  }
  const high: MailRule = { ...low, id: 'high-priority-number', book: 'DILIGAF', priority: 99 }

  it('runs the lower priority number first regardless of array order', () => {
    expect(route(envelope('E:EXPENSE OMV'), [high, low])).toEqual(
      hit('SMOQUA', 'expense', 'low-priority-number'),
    )
  })

  it('gives the same answer when the array is already sorted by priority', () => {
    expect(route(envelope('E:EXPENSE OMV'), [low, high])).toEqual(
      hit('SMOQUA', 'expense', 'low-priority-number'),
    )
  })

  it('honours negative and zero priorities as ordinary ordering values', () => {
    const negative: MailRule = { ...low, id: 'negative', priority: -5 }
    const zero: MailRule = { ...high, id: 'zero', priority: 0 }
    expect(route(envelope('E:EXPENSE OMV'), [zero, negative])).toEqual(
      hit('SMOQUA', 'expense', 'negative'),
    )
  })

  it('breaks a priority tie by array order, so the table stays deterministic', () => {
    const first: MailRule = { ...low, id: 'declared-first', priority: 5 }
    const second: MailRule = { ...high, id: 'declared-second', priority: 5 }
    expect(route(envelope('E:EXPENSE OMV'), [first, second])).toEqual(
      hit('SMOQUA', 'expense', 'declared-first'),
    )
  })

  it('takes the first match even when a later rule would also match', () => {
    const subject = `E:EXPENSE ${STATEMENT_ASCII}`
    const alsoMatches: MailRule = { ...R_PERSONAL_STATEMENT, matchType: 'contains' }
    expect(route(envelope(subject), [R_EXPENSE_EN, alsoMatches])).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    )
  })

  it('resolves a subject carrying two book markers by priority rather than refusing', () => {
    expect(route(envelope('E:EXPENSE prosledjeno E:SMOQUA lepak'), SPEC_TABLE)).toEqual(
      hit('DILIGAF', 'expense', 'diligaf-expense-en'),
    )
  })

  it('skips a higher-ranked rule whose sender constraint fails and matches the next one', () => {
    const blocked: MailRule = {
      ...R_EXPENSE_EN,
      id: 'blocked',
      fromPattern: 'nobody@nowhere.example',
      priority: 1,
    }
    const open: MailRule = { ...R_EXPENSE_EN, id: 'open', priority: 2 }
    expect(route(envelope('E:EXPENSE OMV'), [blocked, open])).toEqual(
      hit('DILIGAF', 'expense', 'open'),
    )
  })

  it('does not reorder the rules array it was given', () => {
    const rules: MailRule[] = [high, low]
    route(envelope('E:EXPENSE OMV'), rules)
    expect(rules.map((r) => r.id)).toEqual(['high-priority-number', 'low-priority-number'])
  })

  it('returns the same answer when called twice with the same inputs', () => {
    const env = envelope('E:TROSAK struja')
    expect(route(env, SPEC_TABLE)).toEqual(route(env, SPEC_TABLE))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Malformed envelopes — the poller hands over whatever mailparser produced
// ═══════════════════════════════════════════════════════════════════════════

describe('route — malformed envelopes', () => {
  it('returns null when the subject header is absent', () => {
    const malformed = { ...envelope('ignored'), subject: undefined } as unknown as MailEnvelope
    expect(route(malformed, SPEC_TABLE)).toBeNull()
  })

  it('returns null when the sender header is absent and a rule requires one', () => {
    const malformed = { ...envelope('Izvod br. 152'), from: undefined } as unknown as MailEnvelope
    expect(route(malformed, [R_DOO_IZVOD])).toBeNull()
  })

  it('matches a subject-only rule even when the sender header is absent', () => {
    const malformed = { ...envelope('E:EXPENSE OMV'), from: undefined } as unknown as MailEnvelope
    expect(route(malformed, [R_EXPENSE_EN])).toEqual(hit('DILIGAF', 'expense', 'diligaf-expense-en'))
  })

  it('ignores messageId and receivedAt when deciding where a message belongs', () => {
    const a = envelope('E:SMOQUA lepak')
    const b: MailEnvelope = { ...a, messageId: '<b@y>', receivedAt: '2031-12-31T23:59:59.000Z' }
    expect(route(a, SPEC_TABLE)).toEqual(route(b, SPEC_TABLE))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// mailEventKey — the idempotency marker for one attachment of one message
// _index/event/mail/{hash(messageId)}:{idx}
// ═══════════════════════════════════════════════════════════════════════════

describe('mailEventKey', () => {
  const MSG = '<CAF=20260811.0612.abcdef@mail.example>'

  /**
   * A bare `.toThrow()` would pass today merely because the stub throws
   * "not implemented" — a test that is green before the code exists is not a
   * test. This asserts a DELIBERATE rejection instead.
   */
  function expectRejects(fn: () => unknown): void {
    let message = ''
    try {
      fn()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
      expect(message).not.toMatch(/not implemented/i)
      return
    }
    throw new Error('expected mailEventKey to reject the input, but it returned normally')
  }

  // ── stability and uniqueness ──────────────────────────────────────────────

  it('returns the same key for the same message and attachment index', () => {
    expect(mailEventKey(MSG, 0)).toBe(mailEventKey(MSG, 0))
  })

  it('returns a stable key for a differently constructed but equal id', () => {
    const rebuilt = ['<CAF=20260811.0612.abcdef@', 'mail.example>'].join('')
    expect(mailEventKey(rebuilt, 3)).toBe(mailEventKey(MSG, 3))
  })

  it('returns a different key for each attachment index of one message', () => {
    const keys = Array.from({ length: 10 }, (_v, i) => mailEventKey(MSG, i))
    expect(new Set(keys).size).toBe(10)
  })

  it('returns a different key for different messages at the same attachment index', () => {
    expect(mailEventKey('<a@mail.example>', 0)).not.toBe(mailEventKey('<b@mail.example>', 0))
  })

  it('does not collide across the message-and-index grid', () => {
    const ids = ['<a@x>', '<b@x>', '<a@y>', '<ab@x>', '<a1@x>']
    const keys: string[] = []
    for (const id of ids) for (let i = 0; i < 4; i++) keys.push(mailEventKey(id, i))
    expect(new Set(keys).size).toBe(ids.length * 4)
  })

  it('returns a distinct key for every attachment in a batch, so none can overwrite another', () => {
    const keys = new Set<string>()
    for (let m = 0; m < 50; m++) {
      for (let i = 0; i < 3; i++) keys.add(mailEventKey(`<msg-${m}@mail.example>`, i))
    }
    expect(keys.size).toBe(150)
  })

  it('does not collide when the message id and index could be concatenated ambiguously', () => {
    expect(mailEventKey('a', 12)).not.toBe(mailEventKey('a1', 2))
  })

  it('distinguishes index 1 from index 10, not by string prefix confusion', () => {
    expect(mailEventKey(MSG, 1)).not.toBe(mailEventKey(MSG, 10))
  })

  it('does not collide for message ids differing only in a trailing character', () => {
    expect(mailEventKey('<msg-1@mail.example>', 0)).not.toBe(mailEventKey('<msg-2@mail.example>', 0))
  })

  it('treats message ids that differ only in case as different messages, per RFC 5322', () => {
    expect(mailEventKey('<ABC@mail.example>', 0)).not.toBe(mailEventKey('<abc@mail.example>', 0))
  })

  it('treats message ids that differ only in whitespace as different messages', () => {
    expect(mailEventKey('<a@x>', 0)).not.toBe(mailEventKey('< a@x >', 0))
  })

  // ── shape: a safe blob path segment ───────────────────────────────────────

  it('produces a blob-path-safe key of the form hash:index', () => {
    expect(mailEventKey(MSG, 7)).toMatch(/^[A-Za-z0-9_-]+:7$/)
  })

  it.each([0, 1, 9, 10, 24])('ends with the attachment index %i', (index) => {
    expect(mailEventKey(MSG, index).endsWith(`:${index}`)).toBe(true)
  })

  it('keeps the message part of the key identical across attachment indices of one message', () => {
    const a = mailEventKey(MSG, 0)
    const b = mailEventKey(MSG, 11)
    expect(a.slice(0, a.lastIndexOf(':'))).toBe(b.slice(0, b.lastIndexOf(':')))
  })

  it('hashes the message id rather than embedding it, so the key is path-safe', () => {
    const key = mailEventKey(MSG, 0)
    expect(key).not.toBe(`${MSG}:0`)
    for (const ch of ['@', '<', '>', '=', 'abcdef', 'mail.example']) {
      expect(key).not.toContain(ch)
    }
  })

  it('produces a safe key even for a hostile message id', () => {
    const hostile = '<../../secret/ id with spaces\n and\ttabs@example.com>'
    expect(mailEventKey(hostile, 0)).toMatch(/^[A-Za-z0-9_-]+:0$/)
  })

  it('produces a safe key for a unicode message id without leaking non-ascii characters', () => {
    expect(() => mailEventKey('<račun-2026@пошта.example.rs>', 0)).not.toThrow()
    expect(mailEventKey('<račun-šifra@пример.rs>', 0)).toMatch(/^[A-Za-z0-9_-]+:0$/)
  })

  it('produces keys of a constant length for message ids of very different lengths', () => {
    const short = mailEventKey('<a@x>', 0)
    const long = mailEventKey(`<${'z'.repeat(5000)}@mail.example>`, 0)
    expect(long.length).toBe(short.length)
  })

  // ── refusals ──────────────────────────────────────────────────────────────
  // MERGE NOTE — only e1 took a position on invalid input. Resolved toward
  // throwing: an unidentifiable message cannot be made idempotent, and a key
  // built from nothing would collide with every other such message — silently
  // dropping real attachments. Fail loudly instead. Recorded as a spec gap.

  it.each<[string, unknown]>([
    ['an empty message id', ''],
    ['a whitespace-only message id', '   '],
    ['an absent message id', undefined],
    ['a null message id', null],
  ])('refuses to build a key from %s', (_label, id) => {
    expectRejects(() => mailEventKey(id as string, 0))
  })

  it.each<[string, number]>([
    ['a negative attachment index', -1],
    ['a fractional attachment index', 1.5],
    ['a NaN attachment index', Number.NaN],
  ])('refuses to build a key from %s', (_label, index) => {
    expectRejects(() => mailEventKey(MSG, index))
  })
})
