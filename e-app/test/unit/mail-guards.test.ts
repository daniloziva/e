import { describe, it, expect } from 'vitest'
import {
  route,
  type MailEnvelope,
  type MailRule,
  type RouteResult,
} from '../../src/engine/mail/route.js'

// ─────────────────────────────────────────────────────────────────────────────
// RULE-VALIDATION GUARDS — new tests for behaviour no frozen case covers.
//
// TEST-FREEZE.md permits "adding tests for new behaviour that no test covers".
// Nothing frozen is touched here; `mail-route.test.ts` exercises the routing
// table through WELL-FORMED rules only, so every rejection path in
// `toUsableRule` was unexecuted (9 unhit branch blocks in mail/route.ts,
// 87.14% branches). The rules array comes out of `_state` JSON, which the type
// system never checked, so those paths are the ones that face real hostile
// input.
//
// WHAT THESE TESTS PIN, AND WHAT THEY DELIBERATELY DO NOT:
//
//  - They pin that a malformed rule is DROPPED — never half-applied, and never
//    widened into a rule the operator did not write. That is the module's
//    documented contract.
//  - They do NOT pin that the drop is SILENT. Rule-validation failures are
//    currently unreported (deferred to M2). Adding a report channel must not
//    have to fight this file, so nothing here asserts the absence of one.
//  - They do NOT touch `senderAddress()`. Its last-`<…>` behaviour is a known
//    defect deferred to M2, and a test written against it now would either
//    bless the bug or have to be rewritten when it is fixed. All nine branches
//    covered here sit in rule validation and envelope narrowing instead, so
//    none of them depends on how a `From` header is split.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The runtime boundary, and the point of this file.
 *
 * `route` is typed `(MailEnvelope, MailRule[])`, but the array it actually
 * receives was parsed from `_state` JSON that nothing typechecked, and the
 * envelope came off a mail server. The malformed shapes below are the real
 * input, not a hypothetical one — so the cast is the test, not a workaround
 * for one.
 */
function asRules(rules: unknown[]): MailRule[] {
  return rules as MailRule[]
}

/** Same boundary, for the envelope side. See `asRules`. */
function asEnvelope(value: unknown): MailEnvelope {
  return value as MailEnvelope
}

/** The well-formed rule that must win whenever a malformed one is dropped. */
const VALID: MailRule = {
  id: 'valid-fallback',
  subjectPattern: 'e:expense',
  matchType: 'prefix',
  book: 'DILIGAF',
  category: 'expense',
  priority: 50,
}

const HIT_VALID: RouteResult = {
  book: 'DILIGAF',
  category: 'expense',
  ruleId: 'valid-fallback',
}

/**
 * A rule that is well-formed except for the fields overridden, ranked ahead of
 * `VALID` and pointing at a DIFFERENT book, category and id.
 *
 * That asymmetry is what makes each case discriminating. A bare `.toBeNull()`
 * cannot tell "the rule was rejected" from "the rule was accepted and simply
 * did not match": both give null. Here, if a guard stops rejecting, the decoy
 * outranks `VALID` and wins with an observably wrong answer, so the assertion
 * `toEqual(HIT_VALID)` fails.
 */
function decoy(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'decoy',
    subjectPattern: 'e:expense',
    matchType: 'prefix',
    book: 'PERSONAL',
    category: 'statement',
    priority: 1,
    ...overrides,
  }
}

function envelope(subject: string, from = 'someone@example.com'): MailEnvelope {
  return {
    messageId: '<20260817.0900.aaaaaa@mail.example>',
    from,
    subject,
    receivedAt: '2026-08-17T09:00:00.000Z',
  }
}

/** Normalizes to `e:expense omv srbija`, so `VALID`'s prefix matches. */
const MATCHING = 'E:EXPENSE OMV Srbija'

// ═══════════════════════════════════════════════════════════════════════════
// A rules table is JSON: an entry need not be an object at all
// route.ts:120 — `if (!isRecord(value)) return null`
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a rules entry that is not an object', () => {
  it.each([
    { name: 'null', entry: null },
    { name: 'undefined', entry: undefined },
    { name: 'a number', entry: 1 },
    { name: 'a string', entry: 'doo-izvod' },
    { name: 'a boolean', entry: true },
    // An array has typeof 'object', so it reaches the Array.isArray half of the
    // record check rather than the typeof half.
    { name: 'an array of rule-ish values', entry: ['doo-izvod', 'izvod', 'prefix'] },
    { name: 'an empty array', entry: [] },
  ])('skips $name and still routes on the well-formed rules around it', ({ entry }) => {
    expect(route(envelope(MATCHING), asRules([entry, VALID]))).toEqual(HIT_VALID)
  })

  it('returns null rather than throwing when every entry is unusable', () => {
    expect(route(envelope(MATCHING), asRules([null, undefined, 7, 'x', [], true]))).toBeNull()
  })

  it('skips a non-object entry declared between two well-formed rules', () => {
    const first: MailRule = { ...VALID, id: 'first', priority: 10 }
    expect(route(envelope(MATCHING), asRules([null, first, undefined, VALID]))).toEqual({
      book: 'DILIGAF',
      category: 'expense',
      ruleId: 'first',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A decision that cannot name the row that made it is not auditable
// route.ts:123 — `if (!isString(id) || id.trim() === '') return null`
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a rule whose id cannot identify it', () => {
  it.each([
    { name: 'a numeric id', id: 7 },
    { name: 'a null id', id: null },
    { name: 'a boolean id', id: false },
    { name: 'an object id', id: { value: 'doo-izvod' } },
    { name: 'an array id', id: ['doo-izvod'] },
    { name: 'an empty id', id: '' },
    { name: 'a blank id', id: '   \t\r\n ' },
  ])('drops a rule with $name rather than routing unauditably', ({ id }) => {
    expect(route(envelope(MATCHING), asRules([decoy({ id }), VALID]))).toEqual(HIT_VALID)
  })

  it('drops a rule with no id key at all', () => {
    const noId = decoy({})
    delete noId['id']
    expect(route(envelope(MATCHING), asRules([noId, VALID]))).toEqual(HIT_VALID)
  })

  it('keeps a rule whose id merely needs trimming to be non-blank', () => {
    // The guard rejects blankness, not surrounding whitespace: the id is
    // reported as written, so a table typo stays traceable to the row.
    const padded = decoy({ id: '  decoy  ' })
    expect(route(envelope(MATCHING), asRules([padded, VALID]))).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: '  decoy  ',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A JSON number must not be coerced into a pattern
// route.ts:126 — `if (!isString(rawSubject)) return null`
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a subjectPattern that is not text', () => {
  it.each([
    { name: 'a number', subjectPattern: 152 },
    { name: 'zero', subjectPattern: 0 },
    { name: 'a boolean', subjectPattern: true },
    { name: 'null', subjectPattern: null },
    { name: 'an array', subjectPattern: ['e:expense'] },
    { name: 'an object', subjectPattern: { pattern: 'e:expense' } },
    // A RegExp stringifies to something pattern-shaped, which is exactly the
    // kind of value a coercing implementation would appear to handle.
    { name: 'a RegExp', subjectPattern: /e:expense/ },
  ])('drops a rule whose subjectPattern is $name', ({ subjectPattern }) => {
    expect(route(envelope(MATCHING), asRules([decoy({ subjectPattern }), VALID]))).toEqual(HIT_VALID)
  })

  it('drops a rule with no subjectPattern key at all', () => {
    const noPattern = decoy({})
    delete noPattern['subjectPattern']
    expect(route(envelope(MATCHING), asRules([noPattern, VALID]))).toEqual(HIT_VALID)
    expect(route(envelope(MATCHING), asRules([noPattern]))).toBeNull()
  })

  it('never lets a non-text subjectPattern match everything under contains', () => {
    // `contains` is the shape a coerced empty pattern would turn into a
    // catch-all: `subject.includes('')` is true for every subject alive.
    const catchAll = decoy({ subjectPattern: 152, matchType: 'contains' })
    expect(route(envelope('Re: rucak u petak'), asRules([catchAll]))).toBeNull()
    expect(route(envelope(MATCHING), asRules([catchAll, VALID]))).toEqual(HIT_VALID)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// An unrecognized matchType is not a comparison to guess at
// route.ts:131 — `if (!isString(matchType) || !MATCH_TYPE_SET.has(matchType)) return null`
// ═══════════════════════════════════════════════════════════════════════════

describe('route — an unusable matchType', () => {
  it.each([
    { name: 'an unknown name', matchType: 'regex' },
    { name: 'a plausible near-miss', matchType: 'suffix' },
    { name: 'a case variant of a known type', matchType: 'Prefix' },
    { name: 'a padded known type', matchType: ' prefix' },
    { name: 'a number', matchType: 0 },
    { name: 'null', matchType: null },
    { name: 'an array', matchType: ['prefix'] },
    // Set membership is not property lookup: a key that exists on Object's
    // prototype must not be mistaken for a declared match type.
    { name: 'a prototype key', matchType: 'constructor' },
    { name: 'toString', matchType: 'toString' },
  ])('drops a rule whose matchType is $name', ({ matchType }) => {
    expect(route(envelope(MATCHING), asRules([decoy({ matchType }), VALID]))).toEqual(HIT_VALID)
  })

  it('drops a rule with no matchType key at all', () => {
    const noType = decoy({})
    delete noType['matchType']
    expect(route(envelope(MATCHING), asRules([noType, VALID]))).toEqual(HIT_VALID)
  })

  it('accepts each of the three declared match types', () => {
    for (const matchType of ['prefix', 'contains', 'exact'] as const) {
      const rule = decoy({ matchType, subjectPattern: 'e:expense omv srbija' })
      expect(route(envelope(MATCHING), asRules([rule, VALID]))).toEqual({
        book: 'PERSONAL',
        category: 'statement',
        ruleId: 'decoy',
      })
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A malformed sender constraint must not read as "no constraint"
// route.ts:134 — the fromPattern type check
//
// This is the guard with real blast radius. `text()` maps a non-string to '',
// and an empty fromPattern means "any sender", so dropping the check would
// turn a rule the operator wrote to NARROW into one that matches every sender
// alive — a silent widening, in the direction that grants access.
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a fromPattern that is present but not text', () => {
  it.each([
    { name: 'a number', fromPattern: 152 },
    { name: 'zero', fromPattern: 0 },
    { name: 'a boolean', fromPattern: true },
    { name: 'an array of addresses', fromPattern: ['izvodi@banka-doo.rs'] },
    { name: 'an object', fromPattern: { address: 'izvodi@banka-doo.rs' } },
    { name: 'a RegExp', fromPattern: /banka-doo\.rs/ },
  ])('drops the rule rather than widening it to every sender when fromPattern is $name', ({
    fromPattern,
  }) => {
    const widened = decoy({ fromPattern })
    // The envelope sender matches no plausible reading of the pattern above, so
    // an accepted rule could only have matched by losing its constraint.
    expect(route(envelope(MATCHING, 'attacker@evil.example'), asRules([widened, VALID]))).toEqual(
      HIT_VALID,
    )
  })

  it('drops the rule even when it is the only one, rather than routing on it', () => {
    const widened = decoy({ fromPattern: 152 })
    expect(route(envelope(MATCHING, 'attacker@evil.example'), asRules([widened]))).toBeNull()
  })

  it('treats an absent or null fromPattern as no sender constraint', () => {
    // Absent and null are TOLERATED — the operator wrote no constraint — which
    // is what makes the non-string case above a genuine distinction rather
    // than a blanket rejection of anything unexpected.
    const nulled = decoy({ fromPattern: null })
    const absent = decoy({})
    delete absent['fromPattern']
    const expected = { book: 'PERSONAL', category: 'statement', ruleId: 'decoy' }
    expect(route(envelope(MATCHING, 'anyone@example.com'), asRules([nulled]))).toEqual(expected)
    expect(route(envelope(MATCHING, 'anyone@example.com'), asRules([absent]))).toEqual(expected)
  })

  it('treats a blank fromPattern as no sender constraint', () => {
    const blank = decoy({ fromPattern: '   \t ' })
    expect(route(envelope(MATCHING, 'anyone@example.com'), asRules([blank]))).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: 'decoy',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A book or category outside the closed sets in types.ts
// route.ts:140 — the book check
// route.ts:143 — the category check
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a book outside the closed set', () => {
  it.each([
    { name: 'a near-miss spelling', book: 'PERSONALL' },
    { name: 'the wrong case', book: 'personal' },
    { name: 'a padded code', book: ' PERSONAL' },
    { name: 'a retired code', book: 'DILIGAF_OLD' },
    { name: 'an empty code', book: '' },
    { name: 'a number', book: 1 },
    { name: 'null', book: null },
    { name: 'an array', book: ['PERSONAL'] },
    { name: 'a prototype key', book: 'constructor' },
  ])('drops a rule naming $name rather than emitting an unknown book', ({ book }) => {
    expect(route(envelope(MATCHING), asRules([decoy({ book }), VALID]))).toEqual(HIT_VALID)
  })

  it('drops a rule with no book key at all', () => {
    const noBook = decoy({})
    delete noBook['book']
    expect(route(envelope(MATCHING), asRules([noBook, VALID]))).toEqual(HIT_VALID)
  })

  it('never returns a book outside the closed set, whatever the table says', () => {
    const table = asRules([
      decoy({ id: 'a', book: 'PERSONALL' }),
      decoy({ id: 'b', book: 'personal' }),
      decoy({ id: 'c', book: 3 }),
      VALID,
    ])
    const result = route(envelope(MATCHING), table)
    expect(result).not.toBeNull()
    expect(['DILIGAF', 'PERSONAL', 'SMOQUA']).toContain(result?.book)
  })
})

describe('route — a category outside the closed set', () => {
  it.each([
    { name: 'a near-miss spelling', category: 'statements' },
    { name: 'the wrong case', category: 'Izvod' },
    { name: 'a padded value', category: ' izvod' },
    { name: 'a Serbian synonym that is not a category', category: 'racun' },
    { name: 'an empty value', category: '' },
    { name: 'a number', category: 4 },
    { name: 'null', category: null },
    { name: 'an array', category: ['izvod'] },
    { name: 'a prototype key', category: 'toString' },
  ])('drops a rule naming $name rather than emitting an unknown category', ({ category }) => {
    expect(route(envelope(MATCHING), asRules([decoy({ category }), VALID]))).toEqual(HIT_VALID)
  })

  it('drops a rule with no category key at all', () => {
    const noCategory = decoy({})
    delete noCategory['category']
    expect(route(envelope(MATCHING), asRules([noCategory, VALID]))).toEqual(HIT_VALID)
  })

  it('never returns a category outside the closed set, whatever the table says', () => {
    const table = asRules([
      decoy({ id: 'a', category: 'statements' }),
      decoy({ id: 'b', category: 'Izvod' }),
      decoy({ id: 'c', category: null }),
      VALID,
    ])
    const result = route(envelope(MATCHING), table)
    expect(result).not.toBeNull()
    expect(['izvod', 'statement', 'expense', 'invoice_out', 'sef_inbound', 'other']).toContain(
      result?.category,
    )
  })

  it('accepts every category in the closed set', () => {
    for (const category of [
      'izvod',
      'statement',
      'expense',
      'invoice_out',
      'sef_inbound',
      'other',
    ] as const) {
      const rule = decoy({ category })
      expect(route(envelope(MATCHING), asRules([rule]))?.category).toBe(category)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// A non-finite priority is considered LAST, deterministically
// route.ts:165 — the `Number.POSITIVE_INFINITY` arm of `orderingPriority`
//
// The decoy is declared FIRST here, so declaration order alone would let it
// win. Only sorting an unusable priority to the end lets `VALID` — which is
// declared second but carries a real priority — take the message.
// ═══════════════════════════════════════════════════════════════════════════

describe('route — a rule whose priority is not a finite number', () => {
  it.each([
    { name: 'undefined', priority: undefined },
    { name: 'null', priority: null },
    { name: 'NaN', priority: Number.NaN },
    { name: 'positive Infinity', priority: Number.POSITIVE_INFINITY },
    // -Infinity is the sharp one: read literally it would sort AHEAD of every
    // real priority, so a rule with a broken key would outrank the whole table.
    { name: 'negative Infinity', priority: Number.NEGATIVE_INFINITY },
    { name: 'a numeric string', priority: '1' },
    { name: 'a boolean', priority: true },
    { name: 'an array', priority: [1] },
    { name: 'an object', priority: { value: 1 } },
  ])('considers a rule with a $name priority after every ranked rule', ({ priority }) => {
    const unranked = decoy({ priority })
    expect(route(envelope(MATCHING), asRules([unranked, VALID]))).toEqual(HIT_VALID)
  })

  it('considers a rule with no priority key at all last', () => {
    const unranked = decoy({})
    delete unranked['priority']
    expect(route(envelope(MATCHING), asRules([unranked, VALID]))).toEqual(HIT_VALID)
  })

  it('still routes on an unranked rule when nothing ranked matches', () => {
    // Unranked means considered last, not discarded: priority says WHEN a rule
    // is considered, never WHAT it decides.
    const unranked = decoy({ priority: Number.NaN })
    expect(route(envelope(MATCHING), asRules([unranked]))).toEqual({
      book: 'PERSONAL',
      category: 'statement',
      ruleId: 'decoy',
    })
  })

  it('breaks a tie between two unranked rules by declaration order', () => {
    const a = decoy({ id: 'unranked-first', priority: undefined })
    const b = decoy({ id: 'unranked-second', priority: 'nope' })
    expect(route(envelope(MATCHING), asRules([a, b]))?.ruleId).toBe('unranked-first')
    expect(route(envelope(MATCHING), asRules([b, a]))?.ruleId).toBe('unranked-second')
  })

  it('ranks a finite priority ahead of an unranked rule in either declaration order', () => {
    const unranked = decoy({ priority: undefined })
    expect(route(envelope(MATCHING), asRules([unranked, VALID]))).toEqual(HIT_VALID)
    expect(route(envelope(MATCHING), asRules([VALID, unranked]))).toEqual(HIT_VALID)
  })

  it('keeps a finite priority that merely looks unusual', () => {
    // 0, negatives and fractions are all finite, so they rank normally — the
    // fallback is for values that are not numbers at all.
    for (const priority of [0, -5, -0.5, 49.999, Number.MAX_SAFE_INTEGER]) {
      const ranked = decoy({ priority })
      const expected = priority < 50 ? 'decoy' : 'valid-fallback'
      expect(route(envelope(MATCHING), asRules([ranked, VALID]))?.ruleId).toBe(expected)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// The envelope itself need not be an object
// route.ts:251 — `const headers = isRecord(source) ? source : {}`
//
// The frozen suite covers headers that are individually absent, but always on
// a real object. The poller hands over whatever the MIME parser produced, and
// a refusal is the right answer for an envelope that is not an envelope.
// ═══════════════════════════════════════════════════════════════════════════

describe('route — an envelope that is not an object', () => {
  it.each([
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'a string', value: 'Subject: E:EXPENSE OMV' },
    { name: 'a number', value: 0 },
    { name: 'a boolean', value: false },
    { name: 'an array', value: ['E:EXPENSE OMV'] },
  ])('returns null for $name rather than throwing', ({ value }) => {
    expect(route(asEnvelope(value), [VALID])).toBeNull()
  })

  it('returns null for a non-object envelope even against a catch-all rule', () => {
    // `contains` on a one-character pattern matches almost any real subject, so
    // a rule that still fires here could only have read a header off nothing.
    const permissive: MailRule = { ...VALID, id: 'permissive', subjectPattern: 'e', matchType: 'contains' }
    expect(route(asEnvelope(null), [permissive])).toBeNull()
    expect(route(asEnvelope(undefined), [permissive])).toBeNull()
  })

  it('returns null for an object with no headers on it at all', () => {
    expect(route(asEnvelope({}), [VALID])).toBeNull()
  })

  it('routes on an object carrying only the two headers the decision uses', () => {
    // The envelope is read as a bag of headers, so extra and missing fields are
    // both fine as long as subject and from are there.
    const minimal = asEnvelope({ subject: MATCHING, from: 'anyone@example.com' })
    expect(route(minimal, [VALID])).toEqual(HIT_VALID)
  })

  it('returns null when a non-object envelope meets an unusable rules table', () => {
    expect(route(asEnvelope(null), asRules([null, decoy({ book: 'PERSONALL' })]))).toBeNull()
  })
})
