import { describe, it, expect } from 'vitest'
import { route, mailEventKey } from '../../../src/engine/mail/route.js'
import type { MailEnvelope, MailRule, RouteResult } from '../../../src/engine/mail/route.js'

/**
 * Email routing rules — engineer #3.
 *
 * Contract: src/engine/mail/route.ts
 * Spec:     03-DILIGAF.md §1 "Routing table", 04-PERSONAL.md §2, 05-SMOQUA.md §3d.
 *
 * The rules table is DATA, so these tests own their tables. What is under test is
 * route()'s semantics: normalized matching, match types, from+subject conjunction,
 * priority ordering, and — the most valuable behaviour in this module — the refusal
 * to guess a book when nothing matches.
 */

// ---------------------------------------------------------------------------
// helpers — no mocking library; plain fixed-value builders only
// ---------------------------------------------------------------------------

function envelope(overrides: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: '<0001@mail.example.com>',
    from: 'Banka <noreply@banka.example.rs>',
    subject: 'Neki subjekt',
    receivedAt: '2026-08-12T06:00:00.000Z',
    ...overrides,
  }
}

function rule(overrides: Partial<MailRule> & Pick<MailRule, 'id' | 'subjectPattern'>): MailRule {
  return {
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'other',
    priority: 100,
    ...overrides,
  }
}

/**
 * The production table as the spec describes it. The DOO bank's izvod subject is
 * not quoted verbatim anywhere in the spec, so a representative one stands in —
 * route() is what is under test, not that literal string.
 */
const TABLE: MailRule[] = [
  {
    id: 'diligaf-izvod',
    fromPattern: 'banka.example.rs',
    subjectPattern: 'Izvod po računu',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'izvod',
    priority: 10,
  },
  {
    id: 'diligaf-expense-en',
    subjectPattern: 'E:EXPENSE',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'expense',
    priority: 20,
  },
  {
    id: 'diligaf-expense-sr',
    subjectPattern: 'E:TROSAK',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'expense',
    priority: 21,
  },
  {
    id: 'personal-statement',
    subjectPattern: 'Izvod po tekućem računu',
    matchType: 'prefix',
    book: 'PERSONAL',
    category: 'statement',
    priority: 30,
  },
  {
    id: 'smoqua-expense',
    subjectPattern: 'E:SMOQUA',
    matchType: 'prefix',
    book: 'SMOQUA',
    category: 'expense',
    priority: 40,
  },
]

// ---------------------------------------------------------------------------
// 1. the routing table, one row per spec line
// ---------------------------------------------------------------------------

describe('route — the routing table from 03-DILIGAF §1', () => {
  it.each<[string, string, string, RouteResult]>([
    [
      'a DOO izvod from the bank',
      'noreply@banka.example.rs',
      'Izvod po računu 265-0000000000-11 za 07/2026',
      { book: 'DILIGAF', category: 'izvod', ruleId: 'diligaf-izvod' },
    ],
    [
      'an English expense forward',
      'danilo@vetatek.com',
      'E:EXPENSE OMV Beograd faktura 4471',
      { book: 'DILIGAF', category: 'expense', ruleId: 'diligaf-expense-en' },
    ],
    [
      'a Serbian expense forward',
      'danilo@vetatek.com',
      'E:TROSAK OMV Beograd racun 4471',
      { book: 'DILIGAF', category: 'expense', ruleId: 'diligaf-expense-sr' },
    ],
    [
      'a personal monthly statement with the account number appended',
      'noreply@drugabanka.example.rs',
      'Izvod po tekućem računu/Dinar Current Account Statement 170-0000012345-67',
      { book: 'PERSONAL', category: 'statement', ruleId: 'personal-statement' },
    ],
    [
      'a SMOQUA expense forward',
      'danilo@vetatek.com',
      'E:SMOQUA Kartonaza doo',
      { book: 'SMOQUA', category: 'expense', ruleId: 'smoqua-expense' },
    ],
    [
      'a SMOQUA expense carrying a dimension in the subject',
      'danilo@vetatek.com',
      'E:SMOQUA MATERIALS Kartonaza doo',
      { book: 'SMOQUA', category: 'expense', ruleId: 'smoqua-expense' },
    ],
  ])('routes %s', (_label, from, subject, expected) => {
    expect(route(envelope({ from, subject }), TABLE)).toEqual(expected)
  })

  it('returns the book, the category and the id of the rule that matched, and nothing else', () => {
    const result = route(envelope({ subject: 'E:SMOQUA Kartonaza doo' }), TABLE)
    expect(result).not.toBeNull()
    expect(Object.keys(result as RouteResult).sort()).toEqual(['book', 'category', 'ruleId'])
  })
})

// ---------------------------------------------------------------------------
// 2. normalization: lowercase, diacritics stripped, whitespace collapsed
// ---------------------------------------------------------------------------

describe('route — normalized subject matching', () => {
  const statementRule = rule({
    id: 'personal-statement',
    subjectPattern: 'Izvod po tekućem računu',
    matchType: 'prefix',
    book: 'PERSONAL',
    category: 'statement',
    priority: 30,
  })

  it.each([
    ['the diacritic spelling, as the bank sends it', 'Izvod po tekućem računu'],
    ['the ASCII spelling', 'Izvod po tekucem racunu'],
    ['the ASCII spelling with a stray double space', 'Izvod po tekucem  racunu'],
    ['mixed case and mixed diacritics', 'IzVoD po TEKUćem raCUNU'],
    ['with the English half appended', 'Izvod po tekucem racunu/Dinar Current Account Statement'],
    ['with an account number appended', 'Izvod po tekućem računu 170-0000012345-67'],
    ['with leading and trailing whitespace', '   Izvod po tekucem racunu  '],
    ['folded across a header line break', 'Izvod po tekucem\r\n racunu 170-0000012345-67'],
  ])('matches the PERSONAL statement rule for %s', (_label, subject) => {
    expect(route(envelope({ subject }), [statementRule])).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: 'personal-statement',
    })
  })

  it.each([
    ['lowercase', 'e:expense faktura 12'],
    ['mixed case', 'E:Expense Faktura 12'],
    ['with leading whitespace before the prefix', '  E:EXPENSE faktura 12'],
  ])('matches the E:EXPENSE prefix written %s', (_label, subject) => {
    expect(route(envelope({ subject }), TABLE)).toEqual({
      book: 'DILIGAF',
      category: 'expense',
      ruleId: 'diligaf-expense-en',
    })
  })

  it('matches the E:SMOQUA prefix written in lowercase', () => {
    expect(route(envelope({ subject: 'e:smoqua kartonaza' }), TABLE)).toEqual({
      book: 'SMOQUA',
      category: 'expense',
      ruleId: 'smoqua-expense',
    })
  })

  it('matches when the rule pattern carries the diacritics and the subject does not', () => {
    const r = rule({ id: 'r', subjectPattern: 'Račun za struju', book: 'DILIGAF', category: 'expense' })
    expect(route(envelope({ subject: 'Racun za struju 08/2026' }), [r])?.ruleId).toBe('r')
  })

  it('matches when the subject carries the diacritics and the rule pattern does not', () => {
    const r = rule({ id: 'r', subjectPattern: 'Racun za struju', book: 'DILIGAF', category: 'expense' })
    expect(route(envelope({ subject: 'Račun za struju 08/2026' }), [r])?.ruleId).toBe('r')
  })

  it('matches Serbian letters that differ only by case', () => {
    const r = rule({ id: 'r', subjectPattern: 'čačak šid žabalj' })
    expect(route(envelope({ subject: 'ČAČAK ŠID ŽABALJ — izvod' }), [r])?.ruleId).toBe('r')
  })

  it('normalizes the sender the same way it normalizes the subject', () => {
    const r = rule({
      id: 'r',
      fromPattern: 'Banka.Example.RS',
      subjectPattern: 'izvod',
      book: 'DILIGAF',
      category: 'izvod',
    })
    expect(route(envelope({ from: 'BANKA <NOREPLY@banka.example.rs>', subject: 'Izvod' }), [r])?.ruleId).toBe('r')
  })
})

// ---------------------------------------------------------------------------
// 3. match types
// ---------------------------------------------------------------------------

describe('route — match types', () => {
  it('anchors a prefix rule to the start of the subject', () => {
    const r = rule({ id: 'r', subjectPattern: 'E:EXPENSE', matchType: 'prefix' })
    expect(route(envelope({ subject: 'E:EXPENSE faktura' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ subject: 'Faktura E:EXPENSE' }), [r])).toBeNull()
  })

  it('returns null for a forwarded expense whose subject no longer starts with the prefix', () => {
    // A real hazard: mail clients prepend "Fwd:"/"RE:" and the tag stops being a prefix.
    // E must refuse rather than fall back to a contains match on its own initiative.
    expect(route(envelope({ subject: 'Fwd: E:EXPENSE OMV faktura' }), TABLE)).toBeNull()
    expect(route(envelope({ subject: 'RE: E:EXPENSE OMV faktura' }), TABLE)).toBeNull()
  })

  it('matches a contains rule anywhere in the subject', () => {
    const r = rule({ id: 'r', subjectPattern: 'E:EXPENSE', matchType: 'contains' })
    expect(route(envelope({ subject: 'Fwd: E:EXPENSE OMV faktura' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ subject: 'E:EXPENSE' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ subject: 'ovde nema ničega' }), [r])).toBeNull()
  })

  it('matches an exact rule only when the whole normalized subject equals the pattern', () => {
    const r = rule({ id: 'r', subjectPattern: 'Izvod po tekućem računu', matchType: 'exact' })
    expect(route(envelope({ subject: 'IZVOD  PO tekucem racunu ' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ subject: 'Izvod po tekucem racunu 170-12345' }), [r])).toBeNull()
    expect(route(envelope({ subject: 'Vas izvod po tekucem racunu' }), [r])).toBeNull()
  })

  it('matches a prefix rule when the subject is exactly the pattern with nothing appended', () => {
    const r = rule({ id: 'r', subjectPattern: 'E:TROSAK', matchType: 'prefix' })
    expect(route(envelope({ subject: 'E:TROSAK' }), [r])?.ruleId).toBe('r')
  })

  it('matches a prefix rule even when the next character is not a separator', () => {
    // Documented consequence of prefix semantics: the pattern is not word-anchored.
    const r = rule({ id: 'r', subjectPattern: 'E:EXPENSE', matchType: 'prefix' })
    expect(route(envelope({ subject: 'E:EXPENSES za jul' }), [r])?.ruleId).toBe('r')
  })

  it('returns null when the subject is only a prefix OF the pattern', () => {
    // Prefix matching is one-directional: the subject must start with the pattern,
    // never the other way round.
    const r = rule({
      id: 'r',
      subjectPattern: 'Izvod po tekućem računu/Dinar Current Account Statement',
      matchType: 'prefix',
    })
    expect(route(envelope({ subject: 'Izvod po tekucem racunu' }), [r])).toBeNull()
    expect(route(envelope({ subject: 'Izvod po tekucem racunu/Dinar Current Account Statement 170-1' }), [r])?.ruleId).toBe('r')
  })

  it('matches an exact rule with an empty pattern only against a subject that normalizes to empty', () => {
    const r = rule({ id: 'r', subjectPattern: '', matchType: 'exact' })
    expect(route(envelope({ subject: '   ' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ subject: 'bilo šta' }), [r])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. from + subject must BOTH match
// ---------------------------------------------------------------------------

describe('route — rules that constrain the sender', () => {
  const bankRule = rule({
    id: 'diligaf-izvod',
    fromPattern: 'banka.example.rs',
    subjectPattern: 'Izvod po računu',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'izvod',
    priority: 10,
  })

  it('matches when both the sender and the subject match', () => {
    const env = envelope({ from: 'Banka AD <noreply@banka.example.rs>', subject: 'Izvod po racunu 07/2026' })
    expect(route(env, [bankRule])?.ruleId).toBe('diligaf-izvod')
  })

  it('returns null when the subject matches but the sender does not', () => {
    const env = envelope({ from: 'phish@zlonamerni.example.com', subject: 'Izvod po racunu 07/2026' })
    expect(route(env, [bankRule])).toBeNull()
  })

  it('returns null when the sender matches but the subject does not', () => {
    const env = envelope({ from: 'noreply@banka.example.rs', subject: 'Obavestenje o novoj usluzi' })
    expect(route(env, [bankRule])).toBeNull()
  })

  it('matches the sender as a substring, not as a whole address', () => {
    const env = envelope({ from: '"Banka a.d. Beograd" <izvodi-noreply@mail.banka.example.rs>', subject: 'Izvod po racunu' })
    expect(route(env, [bankRule])?.ruleId).toBe('diligaf-izvod')
  })

  it('ignores the sender entirely when the rule has no fromPattern', () => {
    const r = rule({ id: 'r', subjectPattern: 'E:EXPENSE', book: 'DILIGAF', category: 'expense' })
    expect(route(envelope({ from: 'anyone@anywhere.example', subject: 'E:EXPENSE x' }), [r])?.ruleId).toBe('r')
    expect(route(envelope({ from: '', subject: 'E:EXPENSE x' }), [r])?.ruleId).toBe('r')
  })

  it('returns null when a sender-constrained rule meets an empty sender', () => {
    expect(route(envelope({ from: '', subject: 'Izvod po racunu 07/2026' }), [bankRule])).toBeNull()
  })

  it('falls through to a lower-priority rule when a higher-priority rule fails only on the sender', () => {
    const catchAll = rule({
      id: 'catch-all-izvod',
      subjectPattern: 'Izvod po računu',
      matchType: 'prefix',
      book: 'PERSONAL',
      category: 'statement',
      priority: 50,
    })
    const env = envelope({ from: 'noreply@drugabanka.example.rs', subject: 'Izvod po racunu 07/2026' })
    expect(route(env, [bankRule, catchAll])).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: 'catch-all-izvod',
    })
  })
})

// ---------------------------------------------------------------------------
// 5. priority and first-match-wins
// ---------------------------------------------------------------------------

describe('route — priority ordering', () => {
  const specific = rule({
    id: 'specific',
    subjectPattern: 'E:SMOQUA',
    matchType: 'prefix',
    book: 'SMOQUA',
    category: 'expense',
    priority: 10,
  })
  const general = rule({
    id: 'general',
    subjectPattern: 'E:',
    matchType: 'prefix',
    book: 'DILIGAF',
    category: 'expense',
    priority: 90,
  })

  it('lets the lower priority number win when two rules match', () => {
    expect(route(envelope({ subject: 'E:SMOQUA Kartonaza' }), [specific, general])?.ruleId).toBe('specific')
  })

  it('orders by priority regardless of the order the rules arrive in', () => {
    expect(route(envelope({ subject: 'E:SMOQUA Kartonaza' }), [general, specific])?.ruleId).toBe('specific')
  })

  it('falls through to the general rule when the specific one does not match', () => {
    expect(route(envelope({ subject: 'E:NESTO drugo' }), [general, specific])?.ruleId).toBe('general')
  })

  it('handles negative and zero priorities as ordinary, lower-running numbers', () => {
    const first = rule({ id: 'first', subjectPattern: 'E:', book: 'SMOQUA', category: 'expense', priority: -5 })
    const second = rule({ id: 'second', subjectPattern: 'E:', book: 'DILIGAF', category: 'expense', priority: 0 })
    expect(route(envelope({ subject: 'E:BILO STA' }), [second, first])?.ruleId).toBe('first')
  })

  it('resolves a priority tie deterministically', () => {
    const a = rule({ id: 'a', subjectPattern: 'E:', book: 'SMOQUA', category: 'expense', priority: 10 })
    const b = rule({ id: 'b', subjectPattern: 'E:', book: 'DILIGAF', category: 'expense', priority: 10 })
    const env = envelope({ subject: 'E:NESTO' })
    const first = route(env, [a, b])
    const second = route(env, [a, b])
    expect(first).toEqual(second)
    expect(['a', 'b']).toContain(first?.ruleId)
  })
})

// ---------------------------------------------------------------------------
// 6. the refusals — E never guesses a book
// ---------------------------------------------------------------------------

describe('route — refuses to guess', () => {
  it('returns null when no rule matches', () => {
    expect(route(envelope({ subject: 'Vaša mesečna newsletter' }), TABLE)).toBeNull()
  })

  it('returns null when the rules table is empty', () => {
    expect(route(envelope({ subject: 'E:EXPENSE faktura' }), [])).toBeNull()
  })

  it('returns null for an empty subject', () => {
    expect(route(envelope({ subject: '' }), TABLE)).toBeNull()
  })

  it('returns null for a whitespace-only subject', () => {
    expect(route(envelope({ subject: '   \t\r\n ' }), TABLE)).toBeNull()
  })

  it.each([
    ['no colon', 'E EXPENSE OMV faktura'],
    ['a doubled colon', 'E::EXPENSE OMV faktura'],
    ['a different letter', 'F:EXPENSE OMV faktura'],
    ['the tag misspelled', 'E:EXPNSE OMV faktura'],
    ['the Serbian tag misspelled', 'E:TROSHAK OMV racun'],
    ['a space inside the tag', 'E: EXPENSE OMV faktura'],
  ])('returns null for a near-miss subject with %s', (_label, subject) => {
    expect(route(envelope({ subject }), TABLE)).toBeNull()
  })

  it('returns null when the tag uses a Cyrillic homoglyph instead of Latin letters', () => {
    // "Е:ЕХРЕNSE" — Cyrillic Е/Х/Р/N look identical in a subject line but are different
    // characters. Diacritic folding is not transliteration, so this must not match.
    expect(route(envelope({ subject: 'Е:EXPENSE OMV faktura' }), TABLE)).toBeNull()
  })

  it('returns null rather than falling back to a default book when only the sender is known', () => {
    const env = envelope({ from: 'noreply@banka.example.rs', subject: 'Obavestenje o promeni tarife' })
    expect(route(env, TABLE)).toBeNull()
  })

  it('does not route a PERSONAL statement into a DILIGAF book when both patterns are similar', () => {
    // "Izvod po tekucem racunu" must not be absorbed by the DOO izvod rule.
    const env = envelope({
      from: 'noreply@banka.example.rs',
      subject: 'Izvod po tekućem računu/Dinar Current Account Statement 170-0000012345-67',
    })
    expect(route(env, TABLE)).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: 'personal-statement',
    })
  })
})

// ---------------------------------------------------------------------------
// 7. purity and robustness
// ---------------------------------------------------------------------------

describe('route — purity', () => {
  it('returns the same result for the same inputs on repeated calls', () => {
    const env = envelope({ subject: 'E:TROSAK racun 4471' })
    expect(route(env, TABLE)).toEqual(route(env, TABLE))
  })

  it('does not mutate or reorder the rules array it is given', () => {
    const rules = [TABLE[4]!, TABLE[0]!, TABLE[3]!]
    const before = structuredClone(rules)
    route(envelope({ subject: 'E:SMOQUA Kartonaza' }), rules)
    expect(rules).toEqual(before)
    expect(rules.map((r) => r.id)).toEqual(['smoqua-expense', 'diligaf-izvod', 'personal-statement'])
  })

  it('does not mutate the envelope it is given', () => {
    const env = envelope({ subject: '  E:EXPENSE  faktura ' })
    const before = structuredClone(env)
    route(env, TABLE)
    expect(env).toEqual(before)
  })

  it('ignores receivedAt and messageId when deciding a route', () => {
    const a = envelope({ subject: 'E:SMOQUA x', messageId: '<a@x>', receivedAt: '2020-01-01T00:00:00.000Z' })
    const b = envelope({ subject: 'E:SMOQUA x', messageId: '<b@y>', receivedAt: '2026-12-31T23:59:59.000Z' })
    expect(route(a, TABLE)).toEqual(route(b, TABLE))
  })

  it('matches a very long subject by its prefix without truncating the decision', () => {
    const subject = 'E:EXPENSE ' + 'faktura '.repeat(1000)
    expect(route(envelope({ subject }), TABLE)?.ruleId).toBe('diligaf-expense-en')
  })
})

// ---------------------------------------------------------------------------
// 8. mailEventKey — idempotency marker, one per attachment of one message
// ---------------------------------------------------------------------------

describe('mailEventKey', () => {
  const MSG = '<CAF=abc123.9f@mail.banka.example.rs>'

  it('returns the same key for the same message and attachment index', () => {
    expect(mailEventKey(MSG, 0)).toBe(mailEventKey(MSG, 0))
  })

  it('returns a different key for every attachment index of the same message', () => {
    const keys = Array.from({ length: 10 }, (_v, i) => mailEventKey(MSG, i))
    expect(new Set(keys).size).toBe(10)
  })

  it('returns a different key for different messages at the same attachment index', () => {
    const ids = [
      '<CAF=abc123.9f@mail.banka.example.rs>',
      '<CAF=abc124.9f@mail.banka.example.rs>',
      '<CAF=abc123.9g@mail.banka.example.rs>',
      '<0001@mail.example.com>',
      '<0002@mail.example.com>',
    ]
    const keys = ids.map((id) => mailEventKey(id, 0))
    expect(new Set(keys).size).toBe(ids.length)
  })

  it('does not collide across the message-and-index grid', () => {
    const ids = ['<a@x>', '<b@x>', '<a@y>', '<ab@x>', '<a1@x>']
    const keys: string[] = []
    for (const id of ids) for (let i = 0; i < 4; i++) keys.push(mailEventKey(id, i))
    expect(new Set(keys).size).toBe(ids.length * 4)
  })

  it('distinguishes attachment index 0 from index 1', () => {
    expect(mailEventKey(MSG, 0)).not.toBe(mailEventKey(MSG, 1))
  })

  it('distinguishes index 1 from index 10, not by string prefix confusion', () => {
    expect(mailEventKey(MSG, 1)).not.toBe(mailEventKey(MSG, 10))
  })

  it('produces a key that is safe to use as a single blob path segment', () => {
    const key = mailEventKey('<CAF=a b/c\\d?e#f@mail.example.com>', 2)
    expect(key).not.toMatch(/[\s/\\?#<>%]/)
  })

  it('produces a key of the same shape for a short and a very long Message-ID', () => {
    const long = '<' + 'x'.repeat(5000) + '@mail.example.com>'
    expect(mailEventKey(long, 0).length).toBe(mailEventKey('<a@b>', 0).length)
  })

  it('produces a hashed key that does not embed the raw Message-ID', () => {
    expect(mailEventKey(MSG, 0)).not.toContain('banka.example.rs')
  })

  it('handles a non-ASCII Message-ID without throwing', () => {
    expect(() => mailEventKey('<račun-2026@пошта.example.rs>', 0)).not.toThrow()
  })

  it('treats two Message-IDs that differ only in whitespace as different messages', () => {
    expect(mailEventKey('<a@x>', 0)).not.toBe(mailEventKey('< a@x >', 0))
  })

  it('rejects an empty Message-ID rather than minting a shared key', () => {
    expect(() => mailEventKey('', 0)).toThrow()
  })

  it('rejects a whitespace-only Message-ID', () => {
    expect(() => mailEventKey('   ', 0)).toThrow()
  })

  it('rejects a negative attachment index', () => {
    expect(() => mailEventKey(MSG, -1)).toThrow()
  })

  it('rejects a non-integer attachment index', () => {
    expect(() => mailEventKey(MSG, 1.5)).toThrow()
  })

  it('rejects a non-finite attachment index', () => {
    expect(() => mailEventKey(MSG, Number.NaN)).toThrow()
    expect(() => mailEventKey(MSG, Number.POSITIVE_INFINITY)).toThrow()
  })
})
