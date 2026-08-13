import { describe, it, expect } from 'vitest'
import { route, mailEventKey } from '../../../src/core/mail/route.js'
import type { MailEnvelope, MailRule, RouteResult } from '../../../src/core/mail/route.js'

/**
 * Email routing rules — 03-DILIGAF.md §1 (routing table), 04-PERSONAL.md §2.
 *
 * The routing table is DATA passed into route(), so every test here builds the
 * table it needs. `standardRules()` is the spec's table, written exactly as the
 * spec writes it (mixed case, spec spelling) — matching is normalized on BOTH
 * sides, so the stored pattern does not have to be pre-normalized.
 */

const DOO_BANK_SENDER = 'Banka DOO <izvodi@banka-doo.rs>'
const PERSONAL_BANK_SENDER = 'Moja Banka <no-reply@mojabanka.rs>'

const R_DILIGAF_IZVOD: MailRule = {
  id: 'diligaf-izvod',
  fromPattern: 'izvodi@banka-doo.rs',
  subjectPattern: 'Izvod',
  matchType: 'contains',
  book: 'DILIGAF',
  category: 'izvod',
  priority: 10,
}

const R_DILIGAF_EXPENSE_EN: MailRule = {
  id: 'diligaf-expense-en',
  subjectPattern: 'E:EXPENSE',
  matchType: 'prefix',
  book: 'DILIGAF',
  category: 'expense',
  priority: 20,
}

const R_DILIGAF_EXPENSE_SR: MailRule = {
  id: 'diligaf-expense-sr',
  subjectPattern: 'E:TROSAK',
  matchType: 'prefix',
  book: 'DILIGAF',
  category: 'expense',
  priority: 30,
}

const R_PERSONAL_STATEMENT: MailRule = {
  id: 'personal-statement',
  subjectPattern: 'Izvod po tekucem racunu/Dinar Current Account Statement',
  matchType: 'prefix',
  book: 'PERSONAL',
  category: 'statement',
  priority: 40,
}

const R_SMOQUA_EXPENSE: MailRule = {
  id: 'smoqua-expense',
  subjectPattern: 'E:SMOQUA',
  matchType: 'prefix',
  book: 'SMOQUA',
  category: 'expense',
  priority: 50,
}

const standardRules = (): MailRule[] => [
  R_DILIGAF_IZVOD,
  R_DILIGAF_EXPENSE_EN,
  R_DILIGAF_EXPENSE_SR,
  R_PERSONAL_STATEMENT,
  R_SMOQUA_EXPENSE,
]

const envelope = (over: Partial<MailEnvelope> = {}): MailEnvelope => ({
  messageId: '<msg-0001@banka-doo.rs>',
  from: DOO_BANK_SENDER,
  subject: 'Izvod po tekucem racunu/Dinar Current Account Statement 265-0000000000000-11',
  receivedAt: '2026-07-03T06:12:00.000Z',
  ...over,
})

const expectRoute = (r: RouteResult | null, book: string, category: string, ruleId: string) => {
  expect(r).not.toBeNull()
  expect(r).toEqual({ book, category, ruleId })
}

describe('route — the spec routing table, happy path', () => {
  it('routes a DOO bank izvod to DILIGAF/izvod', () => {
    const r = route(
      envelope({ from: DOO_BANK_SENDER, subject: 'Izvod broj 7 za racun 170-0000000000000-00' }),
      standardRules(),
    )
    expectRoute(r, 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('routes a personal monthly statement to PERSONAL/statement', () => {
    const r = route(envelope({ from: PERSONAL_BANK_SENDER }), standardRules())
    expectRoute(r, 'PERSONAL', 'statement', 'personal-statement')
  })

  it.each([
    ['E:EXPENSE Faktura 2026-118 Telekom', 'diligaf-expense-en'],
    ['E:TROSAK Racun za gorivo', 'diligaf-expense-sr'],
  ])('routes %s to DILIGAF/expense', (subject, ruleId) => {
    expectRoute(route(envelope({ subject, from: 'me@example.com' }), standardRules()), 'DILIGAF', 'expense', ruleId)
  })

  it('routes an E:SMOQUA forward to SMOQUA/expense', () => {
    const r = route(envelope({ subject: 'E:SMOQUA Racun za pakovanje', from: 'me@example.com' }), standardRules())
    expectRoute(r, 'SMOQUA', 'expense', 'smoqua-expense')
  })

  it('routes E:SMOQUA carrying a dimension to SMOQUA/expense, leaving the dimension to a later stage', () => {
    const r = route(envelope({ subject: 'E:SMOQUA MATERIALS invoice 12', from: 'me@example.com' }), standardRules())
    expectRoute(r, 'SMOQUA', 'expense', 'smoqua-expense')
  })

  it('reports which rule fired, so a mis-route is traceable to a table row', () => {
    const r = route(envelope({ subject: 'E:EXPENSE something', from: 'me@example.com' }), standardRules())
    expect(r?.ruleId).toBe('diligaf-expense-en')
  })
})

describe('route — normalized matching (lowercase, diacritics stripped, whitespace collapsed)', () => {
  const personalOnly = () => [R_PERSONAL_STATEMENT]

  it.each([
    ['exact spec spelling', 'Izvod po tekucem racunu/Dinar Current Account Statement'],
    ['serbian diacritics', 'Izvod po tekućem računu/Dinar Current Account Statement'],
    ['double spaces', 'Izvod po tekucem  racunu/Dinar Current Account Statement'],
    ['diacritics and double spaces together', 'Izvod  po  tekućem   računu/Dinar Current Account Statement'],
    ['all lowercase', 'izvod po tekucem racunu/dinar current account statement'],
    ['all uppercase', 'IZVOD PO TEKUCEM RACUNU/DINAR CURRENT ACCOUNT STATEMENT'],
    ['leading whitespace', '   Izvod po tekucem racunu/Dinar Current Account Statement'],
    ['trailing whitespace', 'Izvod po tekucem racunu/Dinar Current Account Statement   '],
    ['a tab between words', 'Izvod po\ttekucem racunu/Dinar Current Account Statement'],
    ['a folded header newline', 'Izvod po tekucem\r\n racunu/Dinar Current Account Statement'],
    ['a non-breaking space', 'Izvod po\u00a0tekucem racunu/Dinar Current Account Statement'],
  ])('matches the PERSONAL statement rule by prefix when the subject has %s', (_label, subject) => {
    expectRoute(route(envelope({ subject, from: PERSONAL_BANK_SENDER }), personalOnly()), 'PERSONAL', 'statement', 'personal-statement')
  })

  it('matches when the bank appends an account number and a period to the subject', () => {
    const subject = 'Izvod po tekućem  računu/Dinar Current Account Statement 265-1234567890123-11 01.07.2026-31.07.2026'
    expectRoute(route(envelope({ subject, from: PERSONAL_BANK_SENDER }), personalOnly()), 'PERSONAL', 'statement', 'personal-statement')
  })

  it('normalizes the stored pattern too, so a rule written with diacritics still matches an ASCII subject', () => {
    const rule: MailRule = { ...R_PERSONAL_STATEMENT, subjectPattern: 'Izvod po tekućem  računu' }
    const subject = 'IZVOD PO TEKUCEM RACUNU/Dinar Current Account Statement 265'
    expectRoute(route(envelope({ subject, from: PERSONAL_BANK_SENDER }), [rule]), 'PERSONAL', 'statement', 'personal-statement')
  })

  it.each([
    ['č', 'Račun', 'racun'],
    ['ć', 'tekućem', 'tekucem'],
    ['š', 'Šifra', 'sifra'],
    ['ž', 'Žiro', 'ziro'],
    ['đ', 'Đački', 'dacki'],
    ['precomposed and decomposed ć', 'tekuc\u0301em', 'tekucem'],
  ])('strips the %s diacritic when matching', (_label, decorated, ascii) => {
    const rule: MailRule = { ...R_PERSONAL_STATEMENT, subjectPattern: ascii, matchType: 'contains' }
    expectRoute(route(envelope({ subject: `Nesto ${decorated} nesto`, from: 'x@y.rs' }), [rule]), 'PERSONAL', 'statement', 'personal-statement')
  })

  it('collapses whitespace rather than deleting it, so words do not run together into a false match', () => {
    const rule: MailRule = { ...R_DILIGAF_EXPENSE_EN, subjectPattern: 'izvodpo', matchType: 'contains' }
    expect(route(envelope({ subject: 'Izvod  po tekucem racunu', from: 'x@y.rs' }), [rule])).toBeNull()
  })

  it('matches the E: prefixes case-insensitively', () => {
    expectRoute(route(envelope({ subject: 'e:expense faktura', from: 'me@x.rs' }), standardRules()), 'DILIGAF', 'expense', 'diligaf-expense-en')
    expectRoute(route(envelope({ subject: 'e:smoqua faktura', from: 'me@x.rs' }), standardRules()), 'SMOQUA', 'expense', 'smoqua-expense')
  })

  it('matches an E: prefix with collapsed spacing around the colon-tag', () => {
    expectRoute(route(envelope({ subject: 'E:EXPENSE   Faktura   118', from: 'me@x.rs' }), standardRules()), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })
})

describe('route — match types are anchored exactly as declared', () => {
  it('prefix matches only at the start of the subject', () => {
    const rules = [R_DILIGAF_EXPENSE_EN]
    expectRoute(route(envelope({ subject: 'E:EXPENSE faktura', from: 'x@y.rs' }), rules), 'DILIGAF', 'expense', 'diligaf-expense-en')
    expect(route(envelope({ subject: 'faktura E:EXPENSE', from: 'x@y.rs' }), rules)).toBeNull()
  })

  it('prefix matches when the subject is exactly the pattern and nothing else', () => {
    expectRoute(route(envelope({ subject: 'E:EXPENSE', from: 'x@y.rs' }), [R_DILIGAF_EXPENSE_EN]), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })

  it('prefix does not match a subject one character shorter than the pattern', () => {
    expect(route(envelope({ subject: 'E:EXPENS', from: 'x@y.rs' }), [R_DILIGAF_EXPENSE_EN])).toBeNull()
  })

  it('prefix matches a subject that continues past the pattern without a separator', () => {
    expectRoute(route(envelope({ subject: 'E:EXPENSES for july', from: 'x@y.rs' }), [R_DILIGAF_EXPENSE_EN]), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })

  it('contains matches anywhere in the subject', () => {
    const rules = [{ ...R_DILIGAF_IZVOD, fromPattern: undefined }]
    expectRoute(route(envelope({ subject: 'Mesecni izvod 07/2026', from: 'x@y.rs' }), rules), 'DILIGAF', 'izvod', 'diligaf-izvod')
    expectRoute(route(envelope({ subject: 'izvod', from: 'x@y.rs' }), rules), 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('exact matches the whole normalized subject and nothing longer', () => {
    const rule: MailRule = { ...R_PERSONAL_STATEMENT, matchType: 'exact', subjectPattern: 'Izvod po tekucem racunu' }
    expectRoute(route(envelope({ subject: 'Izvod po tekućem  racunu', from: 'x@y.rs' }), [rule]), 'PERSONAL', 'statement', 'personal-statement')
    expect(route(envelope({ subject: 'Izvod po tekucem racunu 265-11', from: 'x@y.rs' }), [rule])).toBeNull()
    expect(route(envelope({ subject: 'Re: Izvod po tekucem racunu', from: 'x@y.rs' }), [rule])).toBeNull()
  })
})

describe('route — rules requiring both from and subject must match both', () => {
  const rules = () => [R_DILIGAF_IZVOD]

  it('matches when both the sender and the subject match', () => {
    expectRoute(route(envelope({ from: DOO_BANK_SENDER, subject: 'Izvod broj 7' }), rules()), 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('returns null when the subject matches but the sender does not', () => {
    expect(route(envelope({ from: PERSONAL_BANK_SENDER, subject: 'Izvod broj 7' }), rules())).toBeNull()
  })

  it('returns null when the sender matches but the subject does not', () => {
    expect(route(envelope({ from: DOO_BANK_SENDER, subject: 'Obavestenje o promeni tarife' }), rules())).toBeNull()
  })

  it('returns null when neither matches', () => {
    expect(route(envelope({ from: 'newsletter@shop.rs', subject: 'Summer sale' }), rules())).toBeNull()
  })

  it('matches the sender as a normalized substring of the whole From header, display name included', () => {
    const r = route(envelope({ from: 'BANKA DOO A.D. <IZVODI@Banka-DOO.rs>', subject: 'Izvod broj 8' }), rules())
    expectRoute(r, 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('matches the sender when the From header is a bare address with no display name', () => {
    expectRoute(route(envelope({ from: 'izvodi@banka-doo.rs', subject: 'Izvod 9' }), rules()), 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('ignores the sender entirely when the rule declares no fromPattern', () => {
    const rule: MailRule = { ...R_DILIGAF_IZVOD, fromPattern: undefined }
    expectRoute(route(envelope({ from: 'anyone@anywhere.example', subject: 'Izvod 10' }), [rule]), 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('matches a sender substring wherever it appears, including a lookalike domain that contains it', () => {
    // Documents the declared semantics (substring, not domain equality). If routing
    // is ever expected to reject izvodi@banka-doo.rs.phish.example, the rule shape
    // has to change — this test is the tripwire for that decision.
    expectRoute(route(envelope({ from: 'izvodi@banka-doo.rs.phish.example', subject: 'Izvod 11' }), rules()), 'DILIGAF', 'izvod', 'diligaf-izvod')
  })
})

describe('route — priority ordering, first match wins', () => {
  it('applies the lowest-priority-number rule when two rules both match', () => {
    const first: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'first', priority: 1 }
    const second: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'second', book: 'SMOQUA', priority: 2 }
    expectRoute(route(envelope({ subject: 'E:EXPENSE x', from: 'x@y.rs' }), [first, second]), 'DILIGAF', 'expense', 'first')
  })

  it('orders by priority, not by the order rules appear in the array', () => {
    const first: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'first', priority: 1 }
    const second: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'second', book: 'SMOQUA', priority: 2 }
    expectRoute(route(envelope({ subject: 'E:EXPENSE x', from: 'x@y.rs' }), [second, first]), 'DILIGAF', 'expense', 'first')
  })

  it('honours negative and zero priorities as ordinary ordering values', () => {
    const lowest: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'negative', priority: -5 }
    const zero: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'zero', book: 'SMOQUA', priority: 0 }
    expectRoute(route(envelope({ subject: 'E:EXPENSE x', from: 'x@y.rs' }), [zero, lowest]), 'DILIGAF', 'expense', 'negative')
  })

  it('breaks a priority tie by array order, so the table stays deterministic', () => {
    const a: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'a', priority: 7 }
    const b: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'b', book: 'SMOQUA', priority: 7 }
    expectRoute(route(envelope({ subject: 'E:EXPENSE x', from: 'x@y.rs' }), [a, b]), 'DILIGAF', 'expense', 'a')
    expectRoute(route(envelope({ subject: 'E:EXPENSE x', from: 'x@y.rs' }), [b, a]), 'SMOQUA', 'expense', 'b')
  })

  it('falls through a higher-priority rule whose sender does not match, to a lower-priority one that does', () => {
    const r = route(envelope({ from: PERSONAL_BANK_SENDER }), standardRules())
    expectRoute(r, 'PERSONAL', 'statement', 'personal-statement')
  })

  it('gives the DOO izvod rule the personal statement when the DOO bank is also the sender', () => {
    const r = route(envelope({ from: DOO_BANK_SENDER }), standardRules())
    expectRoute(r, 'DILIGAF', 'izvod', 'diligaf-izvod')
  })

  it('returns the same result whatever order the standard table is given in', () => {
    const shuffled = [R_SMOQUA_EXPENSE, R_PERSONAL_STATEMENT, R_DILIGAF_EXPENSE_SR, R_DILIGAF_IZVOD, R_DILIGAF_EXPENSE_EN]
    const env = envelope({ from: PERSONAL_BANK_SENDER })
    expect(route(env, shuffled)).toEqual(route(env, standardRules()))
  })

  it('does not reorder or otherwise mutate the caller’s rules array', () => {
    const rules = standardRules()
    const before = rules.map((r) => r.id)
    route(envelope(), rules)
    expect(rules.map((r) => r.id)).toEqual(before)
    expect(rules).toHaveLength(before.length)
  })

  it('does not mutate the envelope it was given', () => {
    const env = envelope({ subject: '  E:EXPENSE  Faktura  ' })
    const snapshot = { ...env }
    route(env, standardRules())
    expect(env).toEqual(snapshot)
  })
})

describe('route — refuses to guess: no match returns null', () => {
  it.each([
    ['an unrelated newsletter', 'newsletter@shop.rs', 'Letnja akcija -30%'],
    ['an empty subject', 'izvodi@banka-doo.rs', ''],
    ['a whitespace-only subject', 'izvodi@banka-doo.rs', '   \t  '],
    ['a reply that buries the E: prefix', 'me@example.com', 'Re: E:EXPENSE Faktura 118'],
    ['a forward that buries the E: prefix', 'me@example.com', 'Fwd: E:EXPENSE Faktura 118'],
    ['a serbian forward prefix', 'me@example.com', 'Prosledjeno: E:TROSAK Racun'],
    ['the statement subject buried mid-line', 'no-reply@mojabanka.rs', 'Obavestenje: Izvod po tekucem racunu/Dinar Current Account Statement'],
    ['a near-miss on the E prefix', 'me@example.com', 'E-EXPENSE Faktura'],
    ['a near-miss with a space after E', 'me@example.com', 'E: EXPENSE Faktura'],
    ['a near-miss on the tag spelling', 'me@example.com', 'E:EXPENCE Faktura'],
    ['a near-miss on the serbian tag', 'me@example.com', 'E:TROSKOVI Racun'],
    ['a plausible but unlisted tag', 'me@example.com', 'E:INVOICE Faktura 118'],
    ['a plausible but unlisted book tag', 'me@example.com', 'E:TEBRA Racun'],
    ['a statement from a bank we never configured', 'izvodi@drugabanka.rs', 'Izvod za jul 2026'],
    ['a bare subject that only shares one word', 'me@example.com', 'racunu'],
  ])('returns null for %s', (_label, from, subject) => {
    expect(route(envelope({ from, subject }), standardRules())).toBeNull()
  })

  it('returns null when the rule table is empty', () => {
    expect(route(envelope(), [])).toBeNull()
  })

  it('never falls back to a default book when nothing matches', () => {
    const r = route(envelope({ from: 'someone@else.rs', subject: 'zdravo' }), standardRules())
    expect(r).toBeNull()
  })

  it('does not treat a rule with an empty subject pattern as a catch-all', () => {
    const catchAll: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'empty-pattern', subjectPattern: '', matchType: 'contains' }
    expect(route(envelope({ subject: 'bilo sta', from: 'x@y.rs' }), [catchAll])).toBeNull()
  })

  it('does not treat a rule with a whitespace-only subject pattern as a catch-all', () => {
    const catchAll: MailRule = { ...R_DILIGAF_EXPENSE_EN, id: 'blank-pattern', subjectPattern: '   ', matchType: 'contains' }
    expect(route(envelope({ subject: 'bilo sta', from: 'x@y.rs' }), [catchAll])).toBeNull()
  })

  it('does not treat a rule with an empty fromPattern as satisfied by any sender', () => {
    const rule: MailRule = { ...R_DILIGAF_IZVOD, id: 'empty-from', fromPattern: '' }
    expect(route(envelope({ from: 'anyone@anywhere.rs', subject: 'Izvod 7' }), [rule])).toBeNull()
  })
})

describe('route — malformed and absent input', () => {
  it('returns null rather than throwing when the subject header is absent', () => {
    const env = { ...envelope(), subject: undefined } as unknown as MailEnvelope
    expect(route(env, standardRules())).toBeNull()
  })

  it('returns null rather than throwing when the subject header is null', () => {
    const env = { ...envelope(), subject: null } as unknown as MailEnvelope
    expect(route(env, standardRules())).toBeNull()
  })

  it('returns null rather than throwing when the from header is absent and a rule needs it', () => {
    const env = { ...envelope(), from: undefined, subject: 'Izvod 7' } as unknown as MailEnvelope
    expect(route(env, [R_DILIGAF_IZVOD])).toBeNull()
  })

  it('still matches a subject-only rule when the from header is absent', () => {
    const env = { ...envelope(), from: undefined, subject: 'E:EXPENSE Faktura' } as unknown as MailEnvelope
    expectRoute(route(env, [R_DILIGAF_EXPENSE_EN]), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })

  it('returns null rather than throwing when the rules argument is absent', () => {
    expect(route(envelope(), undefined as unknown as MailRule[])).toBeNull()
  })

  it('matches a very long subject without truncating the prefix comparison', () => {
    const subject = 'E:EXPENSE ' + 'a'.repeat(5000)
    expectRoute(route(envelope({ subject, from: 'x@y.rs' }), standardRules()), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })

  it('ignores zero-width characters that would otherwise break a prefix match', () => {
    expectRoute(route(envelope({ subject: 'E:\u200bEXPENSE Faktura', from: 'x@y.rs' }), standardRules()), 'DILIGAF', 'expense', 'diligaf-expense-en')
  })
})

describe('mailEventKey — idempotency key per attachment', () => {
  const MSG = '<CAF=abc123@banka-doo.rs>'

  it('returns the same key for the same message and attachment index', () => {
    expect(mailEventKey(MSG, 0)).toBe(mailEventKey(MSG, 0))
  })

  it('returns a stable key across independent calls with a differently constructed but equal id', () => {
    const rebuilt = ['<CAF=abc123@', 'banka-doo.rs>'].join('')
    expect(mailEventKey(rebuilt, 3)).toBe(mailEventKey(MSG, 3))
  })

  it.each([
    [0, 1],
    [1, 2],
    [9, 10],
  ])('returns different keys for attachment index %i and %i of the same message', (a, b) => {
    expect(mailEventKey(MSG, a)).not.toBe(mailEventKey(MSG, b))
  })

  it('returns different keys for different messages at the same attachment index', () => {
    expect(mailEventKey('<a@banka-doo.rs>', 0)).not.toBe(mailEventKey('<b@banka-doo.rs>', 0))
  })

  it('returns a distinct key for every message in a batch, so no attachment can overwrite another', () => {
    const keys = new Set<string>()
    for (let m = 0; m < 50; m++) {
      for (let i = 0; i < 3; i++) keys.add(mailEventKey(`<msg-${m}@banka-doo.rs>`, i))
    }
    expect(keys.size).toBe(150)
  })

  it.each([0, 1, 12])('ends with the attachment index %i, per the _index/event/mail/{hash}:{idx} layout', (idx) => {
    expect(mailEventKey(MSG, idx).endsWith(`:${idx}`)).toBe(true)
  })

  it('keeps the message part of the key identical across attachment indices of one message', () => {
    const a = mailEventKey(MSG, 0)
    const b = mailEventKey(MSG, 11)
    expect(a.slice(0, a.lastIndexOf(':'))).toBe(b.slice(0, b.lastIndexOf(':')))
  })

  it('produces a key safe to use as a blob path segment even for a hostile message id', () => {
    const hostile = '<../../secret/ id with spaces\n and\ttabs@example.com>'
    expect(mailEventKey(hostile, 0)).toMatch(/^[A-Za-z0-9_.:-]+$/)
  })

  it('hashes the message id rather than embedding it verbatim', () => {
    expect(mailEventKey(MSG, 0)).not.toBe(`${MSG}:0`)
    expect(mailEventKey(MSG, 0)).not.toContain('banka-doo.rs')
  })

  it('produces a key for a unicode message id without leaking non-ascii characters', () => {
    expect(mailEventKey('<račun-šifra@пример.rs>', 0)).toMatch(/^[A-Za-z0-9_.:-]+$/)
  })

  it('treats message ids that differ only in case as different messages, per RFC 5322', () => {
    expect(mailEventKey('<ABC@banka-doo.rs>', 0)).not.toBe(mailEventKey('<abc@banka-doo.rs>', 0))
  })

  it('treats a message id with and without angle brackets as the same message', () => {
    expect(mailEventKey('<abc@banka-doo.rs>', 0)).toBe(mailEventKey('abc@banka-doo.rs', 0))
  })

  it.each([
    ['an empty message id', ''],
    ['a whitespace-only message id', '   '],
  ])('throws rather than minting a colliding key for %s', (_label, id) => {
    expect(() => mailEventKey(id, 0)).toThrow()
  })

  it.each([
    ['a negative index', -1],
    ['a fractional index', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as [string, number][])('throws rather than minting an ambiguous key for %s', (_label, idx) => {
    expect(() => mailEventKey('<abc@banka-doo.rs>', idx)).toThrow()
  })
})
