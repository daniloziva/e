/**
 * E — the extraction ladder and learned vendor profiles.
 *
 * Merged from three independent drafts (test/_drafts/extract-ladder/e1,e2,e3).
 * Spec: 01-ARCHITECTURE.md §5 ("the model proposes, the code decides", the
 * extraction ladder, "Validation and failure") and §5.1; 00-OVERVIEW.md D8, D15.
 *
 * The headline guarantee: rungs run in the order given, the FIRST one that
 * answers wins, and no later rung is invoked at all — asserted here twice over,
 * with call counters on the fakes and with the `attempted` array. Every rung
 * declining (or failing) lands on the manual floor: empty facts, method
 * 'manual', confidence 'low'. A rung that blows up is skipped, never fatal.
 *
 * File-wide merge rulings, each repeated at its site:
 *  - `raw` handed to applyProfile is a FLAT map keyed by the literal source path
 *    ("di.InvoiceTotal"), not a nested object walked segment by segment (2-of-3).
 *  - applyProfile REQUIRES a resolvable trusted total; a trusted date that is
 *    absent or unreadable only nulls docDate (2-of-3, and §5 makes a null
 *    doc_date a needs_review flag downstream, i.e. a legitimate output here).
 *  - trust values are asserted as non-empty source labels, not pinned to the
 *    literal 'manual' (2-of-3).
 *  - vendorKey's name fallback is a lowercase hyphen slug with diacritics folded
 *    to their bare letter (2-of-3).
 *  - Range rules on amounts and dates belong to core/extract/validate.ts (§5
 *    "Validation and failure"), so nothing here re-implements them.
 */

import { describe, it, expect } from 'vitest'
import { runLadder } from '../../src/core/extract/ladder.js'
import type { LadderInput, Rung, RungResult } from '../../src/core/extract/ladder.js'
import { vendorKey, learnFromCorrection, applyProfile } from '../../src/core/extract/vendor-profile.js'
import type { VendorProfile, RawCandidates } from '../../src/core/extract/vendor-profile.js'
import type { Clock, Confidence, ExtractedFacts, ExtractionMethod } from '../../src/core/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library anywhere in this file: a Clock is one
// method returning a fixed instant, and a rung is an object with a counter.
// ---------------------------------------------------------------------------

function clockAt(iso: string): Clock {
  const instant = new Date(iso)
  return { now: () => new Date(instant.getTime()) }
}

const CLOCK = clockAt('2026-08-12T09:00:00.000Z')
const OTHER_CLOCK = clockAt('2019-01-31T23:59:59.000Z')

/**
 * Asserts a DELIBERATE refusal. Every implementation is still a stub that
 * throws 'not implemented', so a bare .toThrow() would pass today and prove
 * nothing; this insists the rejection is the module's own.
 */
function expectRejects(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    expect(e instanceof Error ? e.message : String(e)).not.toMatch(/not implemented/i)
    return
  }
  throw new Error('expected a rejection, but it returned normally')
}

const NO_FACTS: ExtractedFacts = {
  vendorName: null,
  vendorPib: null,
  docDate: null,
  amountNet: null,
  vatAmount: null,
  amountTotal: null,
  currency: null,
  lineItems: [],
}

function facts(patch: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return { ...NO_FACTS, lineItems: [], ...patch }
}

const INPUT: LadderInput = {
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
  mimeType: 'application/pdf',
  sha256: 'a'.repeat(64),
  filename: 'racun-2026-08.pdf',
  vendorHint: null,
}

function input(patch: Partial<LadderInput> = {}): LadderInput {
  return { ...INPUT, ...patch }
}

interface FakeRung extends Rung {
  /** how many times the ladder invoked this rung */
  calls: number
  /** the inputs it was invoked with, in order */
  seen: LadderInput[]
}

/** Answers with `result`, or declines (returns null) when `result` is null. */
function fakeRung(method: ExtractionMethod, result: RungResult | null, trace: string[] = []): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: async (given: LadderInput) => {
      r.calls += 1
      r.seen.push(given)
      trace.push(`${method}:start`)
      trace.push(`${method}:end`)
      return result
    },
  }
  return r
}

/** Declines, but only after a real turn of the event loop. */
function slowDecliningRung(method: ExtractionMethod, ms: number, trace: string[]): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: (given: LadderInput) => {
      r.calls += 1
      r.seen.push(given)
      trace.push(`${method}:start`)
      return new Promise<RungResult | null>((resolve) => {
        setTimeout(() => {
          trace.push(`${method}:end`)
          resolve(null)
        }, ms)
      })
    },
  }
  return r
}

/** Throws synchronously, before ever returning a promise — the nastier failure. */
function throwingRung(method: ExtractionMethod, thrown: unknown = new Error('rung exploded')): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: (given: LadderInput) => {
      r.calls += 1
      r.seen.push(given)
      throw thrown
    },
  }
  return r
}

/** Returns a promise that rejects — the ordinary async failure. */
function rejectingRung(method: ExtractionMethod): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: (given: LadderInput) => {
      r.calls += 1
      r.seen.push(given)
      return Promise.reject(new Error('upstream 500'))
    },
  }
  return r
}

function answer(
  patch: Partial<ExtractedFacts>,
  confidence: Confidence = 'high',
  model?: string | null,
): RungResult {
  return { facts: facts(patch), confidence, ...(model === undefined ? {} : { model }) }
}

const CONFIDENCES: Confidence[] = ['exact', 'high', 'medium', 'low']

// ===========================================================================
// runLadder
// ===========================================================================

describe('runLadder', () => {
  describe('short-circuiting', () => {
    it('returns the facts and provenance of the first rung that answers', async () => {
      const qr = fakeRung('fiscal_qr', answer({ vendorName: 'OMV Srbija', amountTotal: 4210 }, 'exact'))

      const out = await runLadder([qr], input(), CLOCK)

      expect(out.facts.vendorName).toBe('OMV Srbija')
      expect(out.facts.amountTotal).toBe(4210)
      expect(out.extraction.method).toBe('fiscal_qr')
      expect(out.extraction.confidence).toBe('exact')
      expect(out.attempted).toEqual(['fiscal_qr'])
    })

    it('never invokes a later rung once an earlier one has answered', async () => {
      const cache = fakeRung('cache', null)
      const qr = fakeRung('fiscal_qr', answer({ amountTotal: 4210 }, 'exact'))
      const di = fakeRung('di_invoice', answer({ amountTotal: 999 }, 'medium'))
      const llm = fakeRung('llm_vision', answer({ amountTotal: 888 }, 'low'))

      const out = await runLadder([cache, qr, di, llm], input(), CLOCK)

      expect(cache.calls).toBe(1)
      expect(qr.calls).toBe(1)
      expect(di.calls).toBe(0)
      expect(llm.calls).toBe(0)
      expect(out.attempted).toEqual(['cache', 'fiscal_qr'])
      expect(out.facts.amountTotal).toBe(4210)
    })

    it.each([0, 1, 2, 3, 4])(
      'stops exactly at the winning rung when rung %i is the one that answers',
      async (winnerIndex) => {
        const methods: ExtractionMethod[] = ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice']
        const rungs = methods.map((m, i) => fakeRung(m, i === winnerIndex ? answer({ amountTotal: 100 + i }) : null))

        const out = await runLadder(rungs, input(), CLOCK)

        expect(out.attempted).toEqual(methods.slice(0, winnerIndex + 1))
        expect(out.extraction.method).toBe(methods[winnerIndex])
        expect(rungs.map((r) => r.calls)).toEqual(methods.map((_m, i) => (i <= winnerIndex ? 1 : 0)))
      },
    )

    it('invokes rungs in the order it was given, not in a re-sorted canonical cost order', async () => {
      const llm = fakeRung('llm_vision', answer({ amountTotal: 500 }, 'low'))
      const cache = fakeRung('cache', answer({ amountTotal: 1 }, 'exact'))

      const out = await runLadder([llm, cache], input(), CLOCK)

      expect(out.attempted).toEqual(['llm_vision'])
      expect(cache.calls).toBe(0)
      expect(out.facts.amountTotal).toBe(500)
    })

    it('treats a result whose facts are entirely empty as an answer and still stops there', async () => {
      const empty = fakeRung('pdf_text', { facts: facts(), confidence: 'low' })
      const di = fakeRung('di_invoice', answer({ amountTotal: 4210 }))

      const out = await runLadder([empty, di], input(), CLOCK)

      expect(di.calls).toBe(0)
      expect(out.extraction.method).toBe('pdf_text')
      expect(out.facts).toEqual(NO_FACTS)
      expect(out.attempted).toEqual(['pdf_text'])
    })

    it('stops at the winning rung even when its confidence is the lowest possible', async () => {
      const qr = fakeRung('fiscal_qr', answer({ amountTotal: 4210 }, 'low'))
      const llm = fakeRung('llm_vision', answer({ amountTotal: 1 }, 'exact'))

      const out = await runLadder([qr, llm], input(), CLOCK)

      expect(llm.calls).toBe(0)
      expect(out.extraction.confidence).toBe('low')
      expect(out.attempted).toEqual(['fiscal_qr'])
    })

    it('lists the same method twice when two rungs share it and the first declines', async () => {
      const first = fakeRung('llm_vision', null)
      const second = fakeRung('llm_vision', answer({ amountTotal: 4210 }))

      const out = await runLadder([first, second], input(), CLOCK)

      expect(out.attempted).toEqual(['llm_vision', 'llm_vision'])
      expect(first.calls).toBe(1)
      expect(second.calls).toBe(1)
    })

    it('invokes each attempted rung exactly once', async () => {
      const rungs = (['cache', 'pdf_text', 'di_receipt'] as const).map((m) => fakeRung(m, null))

      await runLadder(rungs, input(), CLOCK)

      expect(rungs.map((r) => r.calls)).toEqual([1, 1, 1])
    })

    it('waits for each rung to settle before starting the next one', async () => {
      const trace: string[] = []
      const slow = slowDecliningRung('pdf_text', 10, trace)
      const fast = fakeRung('di_invoice', answer({ amountTotal: 4210 }), trace)

      await runLadder([slow, fast], input(), CLOCK)

      expect(trace).toEqual(['pdf_text:start', 'pdf_text:end', 'di_invoice:start', 'di_invoice:end'])
    })
  })

  describe('the outcome built from the winning rung', () => {
    it('returns the winning rung facts unchanged, line items included', async () => {
      const won = facts({
        vendorName: 'OMV Srbija',
        vendorPib: '100002593',
        docDate: '2026-08-11',
        amountNet: 3508.33,
        vatAmount: 701.67,
        amountTotal: 4210,
        currency: 'RSD',
        lineItems: [{ description: 'EVRO DIZEL', quantity: 20, unitPrice: 210.5, lineTotal: 4210 }],
      })

      const out = await runLadder([fakeRung('fiscal_qr', { facts: won, confidence: 'exact', model: null })], input(), CLOCK)

      expect(out.facts).toEqual(won)
    })

    it('takes the extraction method from the rung itself, not from the rung result', async () => {
      const out = await runLadder(
        [fakeRung('cache', null), fakeRung('di_receipt', answer({ amountTotal: 4210 }))],
        input(),
        CLOCK,
      )

      expect(out.extraction.method).toBe('di_receipt')
    })

    it.each(CONFIDENCES)('carries the winning rung confidence "%s" through untouched', async (confidence) => {
      const rung = fakeRung('di_invoice', answer({ amountTotal: 4210 }, confidence))

      const out = await runLadder([rung], input(), CLOCK)

      expect(out.extraction.confidence).toBe(confidence)
    })

    it('carries the model label of a model-backed rung', async () => {
      const llm = fakeRung('llm_vision', answer({ amountTotal: 4210 }, 'medium', 'gpt-4o-mini@2026-05'))

      const out = await runLadder([llm], input(), CLOCK)

      expect(out.extraction.model).toBe('gpt-4o-mini@2026-05')
    })

    it.each<[label: string, model: string | null | undefined]>([
      ['the rung omits it entirely', undefined],
      ['the rung reports it as null', null],
    ])('reports the model as null when %s', async (_label, model) => {
      const rung = fakeRung('pdf_text', answer({ amountTotal: 4210 }, 'high', model))

      const out = await runLadder([rung], input(), CLOCK)

      expect(out.extraction.model).toBeNull()
    })

    it('passes facts through without validating them — validate.ts owns the range rules (§5)', async () => {
      const bogus = facts({
        vendorPib: '12345678901',
        docDate: '2099-12-31',
        amountTotal: 99_000_000,
        vatAmount: 100_000_000,
      })

      const out = await runLadder([fakeRung('llm_vision', { facts: bogus, confidence: 'low' })], input(), CLOCK)

      expect(out.facts).toEqual(bogus)
    })

    it('produces the same outcome whatever the injected clock reads', async () => {
      const build = () => [fakeRung('cache', null), fakeRung('pdf_text', answer({ amountTotal: 4210 }))]

      const a = await runLadder(build(), input(), CLOCK)
      const b = await runLadder(build(), input(), OTHER_CLOCK)

      expect(a).toEqual(b)
    })

    it('does not let one document run leak into the next: each call reports its own attempts', async () => {
      const cache = fakeRung('cache', null)
      const pdf = fakeRung('pdf_text', answer({ amountTotal: 4210 }))

      const first = await runLadder([cache, pdf], input({ sha256: 'a'.repeat(64) }), CLOCK)
      const second = await runLadder([cache, pdf], input({ sha256: 'b'.repeat(64) }), CLOCK)

      expect(first.attempted).toEqual(['cache', 'pdf_text'])
      expect(second.attempted).toEqual(['cache', 'pdf_text'])
      expect(pdf.calls).toBe(2)
    })
  })

  describe('the manual floor when nothing answers', () => {
    it('yields empty facts with method manual when every rung declines', async () => {
      const methods: ExtractionMethod[] = [
        'cache',
        'fiscal_qr',
        'vendor_profile',
        'pdf_text',
        'di_invoice',
        'llm_vision',
      ]
      const rungs = methods.map((m) => fakeRung(m, null))

      const out = await runLadder(rungs, input(), CLOCK)

      expect(out.facts).toEqual(NO_FACTS)
      expect(out.facts.lineItems).toEqual([])
      expect(out.extraction.method).toBe('manual')
      expect(out.extraction.model).toBeNull()
      expect(out.attempted).toEqual(methods)
      expect(rungs.map((r) => r.calls)).toEqual(methods.map(() => 1))
    })

    it('reports the lowest confidence when it fell all the way to manual', async () => {
      const out = await runLadder([fakeRung('pdf_text', null)], input(), CLOCK)

      expect(out.extraction.confidence).toBe('low')
    })

    it('does not list manual as attempted when no manual rung was supplied', async () => {
      const out = await runLadder([fakeRung('pdf_text', null)], input(), CLOCK)

      expect(out.extraction.method).toBe('manual')
      expect(out.attempted).toEqual(['pdf_text'])
    })

    it('returns the manual floor having attempted nothing when the rung list is empty', async () => {
      const out = await runLadder([], input(), CLOCK)

      expect(out.attempted).toEqual([])
      expect(out.facts).toEqual(NO_FACTS)
      expect(out.extraction.method).toBe('manual')
      expect(out.extraction.model).toBeNull()
    })

    it('invents no vendor, date or amount from the vendor hint when nothing could answer', async () => {
      const out = await runLadder([fakeRung('di_invoice', null)], input({ vendorHint: 'OMV Srbija' }), CLOCK)

      expect(out.facts.vendorName).toBeNull()
      expect(out.facts.vendorPib).toBeNull()
      expect(out.facts.docDate).toBeNull()
      expect(out.facts.amountTotal).toBeNull()
      expect(out.facts.currency).toBeNull()
    })
  })

  describe('a rung that fails must not abort the ladder', () => {
    it('keeps climbing when a rung rejects, and lets a later rung answer', async () => {
      const flaky = rejectingRung('di_invoice')
      const llm = fakeRung('llm_vision', answer({ amountTotal: 77 }, 'low'))

      const out = await runLadder([flaky, llm], input(), CLOCK)

      expect(out.extraction.method).toBe('llm_vision')
      expect(out.facts.amountTotal).toBe(77)
      expect(llm.calls).toBe(1)
    })

    it('keeps climbing when a rung throws synchronously, before returning a promise', async () => {
      const boom = throwingRung('pdf_text')
      const di = fakeRung('di_invoice', answer({ amountTotal: 4210 }, 'medium'))

      const out = await runLadder([boom, di], input(), CLOCK)

      expect(boom.calls).toBe(1)
      expect(di.calls).toBe(1)
      expect(out.extraction.method).toBe('di_invoice')
    })

    it('contains a rung that throws a value that is not an Error', async () => {
      const boom = throwingRung('vendor_profile', 'just a string')
      const pdf = fakeRung('pdf_text', answer({ amountTotal: 4210 }))

      const out = await runLadder([boom, pdf], input(), CLOCK)

      expect(out.extraction.method).toBe('pdf_text')
    })

    it('counts a rung that failed as attempted', async () => {
      const out = await runLadder(
        [rejectingRung('fiscal_qr'), fakeRung('pdf_text', answer({ amountTotal: 4210 }))],
        input(),
        CLOCK,
      )

      expect(out.attempted).toEqual(['fiscal_qr', 'pdf_text'])
    })

    it('reaches the manual floor instead of propagating when every rung fails', async () => {
      const out = await runLadder(
        [rejectingRung('cache'), throwingRung('vendor_profile'), rejectingRung('llm_vision')],
        input(),
        CLOCK,
      )

      expect(out.facts).toEqual(NO_FACTS)
      expect(out.extraction.method).toBe('manual')
      expect(out.extraction.confidence).toBe('low')
      expect(out.attempted).toEqual(['cache', 'vendor_profile', 'llm_vision'])
    })

    it('still short-circuits after a failure — no rung past the winner is invoked', async () => {
      const boom = rejectingRung('fiscal_qr')
      const winner = fakeRung('vendor_profile', answer({ amountTotal: 4210 }))
      const llm = throwingRung('llm_vision')

      const out = await runLadder([boom, winner, llm], input(), CLOCK)

      expect(llm.calls).toBe(0)
      expect(out.extraction.method).toBe('vendor_profile')
      expect(out.attempted).toEqual(['fiscal_qr', 'vendor_profile'])
    })
  })

  describe('the input handed to each rung', () => {
    it('hands every attempted rung the input it was given, unaltered', async () => {
      const given = input({ vendorHint: 'OMV', filename: 'račun 08.pdf', mimeType: 'image/jpeg' })
      const a = fakeRung('cache', null)
      const b = fakeRung('pdf_text', answer({ amountTotal: 10 }))

      await runLadder([a, b], given, CLOCK)

      expect(a.seen).toHaveLength(1)
      expect(a.seen[0]).toEqual(given)
      expect(b.seen[0]).toEqual(given)
      expect(b.seen[0]?.vendorHint).toBe('OMV')
    })

    it('forwards an absent vendor hint as absent rather than inventing one', async () => {
      const given: LadderInput = {
        bytes: new Uint8Array([1]),
        mimeType: 'application/pdf',
        sha256: 'b'.repeat(64),
        filename: 'x.pdf',
      }
      const rung = fakeRung('vendor_profile', null)

      await runLadder([rung], given, CLOCK)

      expect(rung.seen[0]?.vendorHint ?? null).toBeNull()
    })

    it('does not mutate the caller input bytes', async () => {
      const given = input()
      const before = Array.from(given.bytes)

      await runLadder([fakeRung('pdf_text', null)], given, CLOCK)

      expect(Array.from(given.bytes)).toEqual(before)
    })

    it.each<[label: string, patch: Partial<LadderInput>]>([
      ['a zero-byte document', { bytes: new Uint8Array(0) }],
      ['an empty sha256 and filename', { sha256: '', filename: '' }],
      ['an unknown mime type', { mimeType: 'application/octet-stream' }],
    ])('still runs the ladder for %s rather than refusing up front', async (_label, patch) => {
      const rung = fakeRung('pdf_text', null)

      const out = await runLadder([rung], input(patch), CLOCK)

      expect(rung.calls).toBe(1)
      expect(out.attempted).toEqual(['pdf_text'])
      expect(out.extraction.method).toBe('manual')
    })

    it('is repeatable — the same rungs and input yield an equal outcome twice', async () => {
      const build = () => [fakeRung('cache', null), fakeRung('pdf_text', answer({ amountTotal: 4210 }))]

      const first = await runLadder(build(), input(), CLOCK)
      const second = await runLadder(build(), input(), CLOCK)

      expect(first).toEqual(second)
    })
  })
})

// ===========================================================================
// vendorKey — PIB beats name (§5 layer 2, D15)
// ===========================================================================

describe('vendorKey', () => {
  it.each<[name: string | null, pib: string, expected: string]>([
    ['OMV Srbija', '100002887', '100002887'],
    [null, '100002887', '100002887'],
    ['', '100002887', '100002887'],
  ])('prefers the PIB over the name (%s, %s)', (name, pib, expected) => {
    expect(vendorKey(name, pib)).toBe(expected)
  })

  it('trims surrounding whitespace from a PIB before using it as the key', () => {
    expect(vendorKey('OMV Srbija', '  100002887  ')).toBe('100002887')
  })

  it('accepts a PIB of exactly nine digits, including all zeros', () => {
    expect(vendorKey('OMV Srbija', '000000000')).toBe('000000000')
  })

  it('gives two differently spelled records of the same PIB the same key', () => {
    expect(vendorKey('OMV SRBIJA DOO BEOGRAD', '100002887')).toBe(vendorKey('omv srbija', '100002887'))
  })

  // MERGE NOTE — all three agreed the key falls back to the name for a PIB that
  // is not exactly nine digits, which §5 "Validation and failure" requires
  // ("PIB exactly 9 digits or null"). e2/e3 pinned the resulting slug; kept.
  it.each<[label: string, pib: string]>([
    ['eight digits — one short', '10000288'],
    ['ten digits — one over', '1000028871'],
    ['nine characters but not all digits', '10000288A'],
    ['digits with punctuation', '100-002-887'],
    ['prose', 'PIB'],
    ['an empty string', ''],
  ])('falls back to the normalized name when the PIB is unusable (%s)', (_label, pib) => {
    expect(vendorKey('OMV Srbija', pib)).toBe('omv-srbija')
  })

  // MERGE NOTE — e2/e3 pinned the exact slug; e1 only asserted that variants
  // agree. The stronger reading wins, and the key must survive being a filename:
  // profiles live at _state/vendor-profiles/{vendor_key}.json (§5 layer 2).
  it.each<[name: string, expected: string]>([
    ['Wolt', 'wolt'],
    ['WOLT', 'wolt'],
    ['OMV Srbija', 'omv-srbija'],
    ['  OMV   Srbija  ', 'omv-srbija'],
    ['OMV-SRBIJA', 'omv-srbija'],
    ['Delhaize Serbia', 'delhaize-serbia'],
  ])('normalizes the name "%s" to the stable slug "%s" when no PIB is known', (name, expected) => {
    expect(vendorKey(name, null)).toBe(expected)
  })

  // MERGE NOTE — 2-of-3 (e2, e3) fold Đ to a bare "d"; e1 expected the "dj"
  // digraph. Majority wins; the spec says nothing about transliteration.
  it.each<[name: string, expected: string]>([
    ['Štark', 'stark'],
    ['Čačak', 'cacak'],
    ['Ćuprija Đak', 'cuprija-dak'],
    ['Žabalj', 'zabalj'],
    ['ĐORĐE ŽIVKOVIĆ', 'dorde-zivkovic'],
  ])('folds Serbian diacritics so "%s" keys as "%s"', (name, expected) => {
    expect(vendorKey(name, null)).toBe(expected)
  })

  it('collapses the punctuation of a legal form rather than dropping the name', () => {
    expect(vendorKey('Delhaize d.o.o.', null)).toBe('delhaize-d-o-o')
  })

  it('returns a key that is safe to use as a profile filename or blob segment', () => {
    const key = vendorKey('Šped / Đorđe d.o.o. ../etc', null)

    expect(key).not.toBeNull()
    expect(key).not.toContain('/')
    expect(key).not.toContain('\\')
    expect(key).not.toContain('..')
    expect(key).not.toMatch(/\s/)
  })

  it('gives one and the same key to every casing and spacing variant of a name', () => {
    const keys = ['OMV Srbija', 'omv srbija', '  OMV  SRBIJA ', 'Omv-Srbija'].map((v) => vendorKey(v, null))

    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).not.toBeNull()
  })

  it('gives genuinely different vendors different keys', () => {
    expect(vendorKey('Maxi doo', null)).not.toBe(vendorKey('Mini doo', null))
  })

  it('produces a stable non-null key for a Cyrillic vendor name', () => {
    const first = vendorKey('Максибрза Доо', null)
    const second = vendorKey('Максибрза Доо', null)

    expect(first).not.toBeNull()
    expect(first).toBe(second)
  })

  it.each<[label: string, name: string | null, pib: string | null]>([
    ['both are null', null, null],
    ['the name is empty and there is no PIB', '', null],
    ['both are empty strings', '', ''],
    ['the name is whitespace only', '   ', null],
    ['the name is whitespace and the PIB is whitespace', '\t\n ', '   '],
    ['the name is only punctuation', '...', null],
    ['the name is only separators', '---', null],
    ['the PIB is unusable and there is no name to fall back to', null, '42'],
    ['both are unusable', '  ', '123'],
  ])('returns null rather than invent a key when %s', (_label, name, pib) => {
    expect(vendorKey(name, pib)).toBeNull()
  })
})

// ===========================================================================
// learnFromCorrection — the compounding rung (D15)
// ===========================================================================

function profileOf(patch: Partial<VendorProfile> = {}): VendorProfile {
  return {
    vendorKey: '100002887',
    vendorName: 'OMV Srbija',
    vendorPib: '100002887',
    trust: {},
    hints: {},
    defaultCategory: null,
    corrections: 0,
    lastSeen: '2026-01-01',
    ...patch,
  }
}

const AT = '2026-08-12'

describe('learnFromCorrection', () => {
  const IDENTIFIED = { vendorName: 'OMV Srbija', vendorPib: '100002887' } as const
  const before = facts({ ...IDENTIFIED, docDate: '2026-08-11', amountTotal: 421 })
  const after = facts({ ...IDENTIFIED, docDate: '2026-08-11', amountTotal: 4210 })

  it('creates a profile from nothing on the first correction', () => {
    const p = learnFromCorrection(null, before, after, AT)

    expect(p.vendorKey).toBe('100002887')
    expect(p.vendorName).toBe('OMV Srbija')
    expect(p.vendorPib).toBe('100002887')
    expect(p.corrections).toBe(1)
    expect(p.lastSeen).toBe(AT)
  })

  it('keys a brand-new profile exactly the way vendorKey would', () => {
    const p = learnFromCorrection(null, facts(), facts({ vendorName: 'Elektro Beograd', amountTotal: 100 }), AT)

    expect(p.vendorKey).toBe(vendorKey('Elektro Beograd', null))
    expect(p.vendorPib).toBeNull()
  })

  it.each<[start: number, expected: number]>([
    [0, 1],
    [1, 2],
    [3, 4],
  ])('increments corrections from %i to %i', (start, expected) => {
    expect(learnFromCorrection(profileOf({ corrections: start }), before, after, AT).corrections).toBe(expected)
  })

  it('stamps lastSeen from the supplied instant, never from a clock of its own', () => {
    expect(learnFromCorrection(profileOf({ lastSeen: '2020-02-02' }), before, after, '2026-12-31').lastSeen).toBe(
      '2026-12-31',
    )
  })

  // MERGE NOTE — e1 pinned every trust value to the literal 'manual'; e2 and e3
  // required only a non-empty source label. Majority wins, so the token itself
  // is left to the implementation (recorded as a spec gap).
  it.each<[label: string, from: ExtractedFacts, to: ExtractedFacts, field: string]>([
    ['a corrected total', facts({ amountTotal: 421 }), facts({ amountTotal: 4210 }), 'amountTotal'],
    ['a corrected date', facts({ docDate: '2026-11-08' }), facts({ docDate: '2026-08-11' }), 'docDate'],
    ['a PIB the extractor missed', facts({ vendorPib: null }), facts({ vendorPib: '100002887' }), 'vendorPib'],
    ['a VAT amount the extractor missed', facts({ vatAmount: null }), facts({ vatAmount: 200 }), 'vatAmount'],
    ['a corrected currency', facts({ currency: 'RSD' }), facts({ currency: 'EUR' }), 'currency'],
  ])('records what it trusted for %s', (_label, from, to, field) => {
    const p = learnFromCorrection(profileOf(), from, to, AT)

    expect(Object.keys(p.trust)).toContain(field)
    expect(typeof p.trust[field]).toBe('string')
    expect(p.trust[field]).not.toBe('')
  })

  it('records one trust entry per field the correction changed and nothing else', () => {
    const from = facts({ amountTotal: 421, docDate: '2026-07-01', vendorName: 'OMV Srbija' })
    const to = facts({ amountTotal: 4210, docDate: '2026-08-11', vendorName: 'OMV Srbija' })

    const p = learnFromCorrection(profileOf(), from, to, AT)

    expect(Object.keys(p.trust).sort()).toEqual(['amountTotal', 'docDate'])
  })

  it('records nothing for a field the user left alone', () => {
    const p = learnFromCorrection(profileOf(), before, after, AT)

    expect(Object.keys(p.trust)).not.toContain('docDate')
    expect(Object.keys(p.trust)).not.toContain('vendorName')
  })

  it('keeps trust learned from earlier corrections for fields this one did not touch', () => {
    const p = learnFromCorrection(profileOf({ trust: { docDate: 'di.InvoiceDate' } }), before, after, AT)

    expect(p.trust['docDate']).toBe('di.InvoiceDate')
    expect(Object.keys(p.trust)).toContain('amountTotal')
  })

  it('overwrites the trusted source when the same field is corrected again', () => {
    const p = learnFromCorrection(profileOf({ trust: { amountTotal: 'pdf.regexTotal' } }), before, after, AT)

    expect(p.trust['amountTotal']).not.toBe('pdf.regexTotal')
    expect(p.trust['amountTotal']).toBeTruthy()
  })

  it('keeps a single trust entry per field across two corrections of the same field', () => {
    const first = learnFromCorrection(profileOf({ corrections: 3 }), facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), '2026-08-11')
    const second = learnFromCorrection(first, facts({ amountTotal: 2 }), facts({ amountTotal: 3 }), AT)

    expect(Object.keys(second.trust)).toEqual(['amountTotal'])
    expect(second.corrections).toBe(5)
  })

  it('still counts a correction that changed nothing, and learns no trust from it', () => {
    const p = learnFromCorrection(profileOf({ corrections: 2 }), after, after, AT)

    expect(p.corrections).toBe(3)
    expect(p.trust).toEqual({})
  })

  // MERGE NOTE — e3 recorded trust when the user CLEARED a field; e1 and e2 do
  // not, on the ground that clearing proves no source right. Majority wins.
  it('does not record trust for a field the user cleared, because nothing was proved right', () => {
    const p = learnFromCorrection(
      profileOf(),
      facts({ vatAmount: 999, amountTotal: 4210 }),
      facts({ vatAmount: null, amountTotal: 4210 }),
      AT,
    )

    expect(p.trust).not.toHaveProperty('vatAmount')
  })

  it('learns a PIB the correction supplied for a profile that had none', () => {
    const p = learnFromCorrection(
      profileOf({ vendorPib: null, vendorKey: 'omv-srbija' }),
      facts({ vendorName: 'OMV Srbija', vendorPib: null }),
      facts({ vendorName: 'OMV Srbija', vendorPib: '100002887' }),
      AT,
    )

    expect(p.vendorPib).toBe('100002887')
  })

  // MERGE NOTE — 2-of-3 (e1, e2) keep the key stable when a later correction
  // supplies a PIB for the first time; e3 re-keyed the profile onto the PIB.
  // Majority, and re-keying would orphan the stored file
  // _state/vendor-profiles/{vendor_key}.json (§5 layer 2).
  it('keeps the profile key stable when a later correction supplies a PIB for the first time', () => {
    const existing = profileOf({ vendorKey: 'omv-srbija', vendorPib: null })

    const p = learnFromCorrection(
      existing,
      facts({ vendorName: 'OMV Srbija', vendorPib: null }),
      facts({ vendorName: 'OMV Srbija', vendorPib: '100002887' }),
      AT,
    )

    expect(p.vendorKey).toBe('omv-srbija')
    expect(p.vendorPib).toBe('100002887')
  })

  it('keeps the existing key when the correction carries no vendor identity at all', () => {
    const p = learnFromCorrection(profileOf({ vendorKey: '100002887' }), facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), AT)

    expect(p.vendorKey).toBe('100002887')
  })

  // MERGE NOTE — only e2 covered a first correction with no vendor identity at
  // all, and it expected an invented key. No majority and the spec is silent, so
  // the safest reading wins: an unkeyable profile is refused rather than stored
  // under a made-up key (§5: never invent a PIB). Recorded as a spec gap.
  it('refuses to create a profile when the correction carries nothing to key a vendor on', () => {
    expectRejects(() => learnFromCorrection(null, facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), AT))
  })

  it('adopts a corrected vendor name', () => {
    const p = learnFromCorrection(
      profileOf({ vendorName: 'OMV' }),
      facts({ vendorName: 'OMV' }),
      facts({ vendorName: 'OMV Srbija' }),
      AT,
    )

    expect(p.vendorName).toBe('OMV Srbija')
  })

  // MERGE NOTE — e3 let a null in the corrected facts clear a known identity;
  // e1 forbade it and e2 refuses to learn from a cleared field. Majority: a
  // correction that is silent about the vendor never erases what is known.
  it('never erases a known vendor name with a null in the corrected facts', () => {
    const p = learnFromCorrection(profileOf({ vendorName: 'OMV Srbija' }), facts(), facts({ amountTotal: 10 }), AT)

    expect(p.vendorName).toBe('OMV Srbija')
  })

  it('never erases a known PIB with a null in the corrected facts', () => {
    const p = learnFromCorrection(profileOf({ vendorPib: '100002887' }), facts(), facts({ amountTotal: 10 }), AT)

    expect(p.vendorPib).toBe('100002887')
  })

  it('adopts the corrected currency as the profile default when it had no currency hint', () => {
    const p = learnFromCorrection(profileOf(), facts({ currency: null }), facts({ currency: 'EUR' }), AT)

    expect(p.hints.currencyDefault).toBe('EUR')
  })

  it('keeps hints the correction says nothing about', () => {
    const existing = profileOf({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'EUR' } })

    const p = learnFromCorrection(existing, facts({ currency: 'EUR' }), facts({ currency: 'EUR' }), AT)

    expect(p.hints.dateFormat).toBe('DD.MM.YYYY')
    expect(p.hints.decimal).toBe(',')
    expect(p.hints.currencyDefault).toBe('EUR')
  })

  it('never invents a default category from a single correction (§5.1: only when unambiguous)', () => {
    expect(learnFromCorrection(null, before, after, AT).defaultCategory).toBeNull()
  })

  it('preserves a default category that was already set', () => {
    expect(learnFromCorrection(profileOf({ defaultCategory: 'MATERIALS' }), before, after, AT).defaultCategory).toBe(
      'MATERIALS',
    )
  })

  it('does not mutate the profile it was handed', () => {
    const existing = profileOf({ corrections: 3, trust: { docDate: 'di.InvoiceDate' } })
    const snapshot = structuredClone(existing)

    learnFromCorrection(existing, before, after, AT)

    expect(existing).toEqual(snapshot)
  })

  it('does not mutate the facts it was handed', () => {
    const from = structuredClone(before)
    const to = structuredClone(after)

    learnFromCorrection(profileOf(), from, to, AT)

    expect(from).toEqual(before)
    expect(to).toEqual(after)
  })

  it('folds two corrections in sequence into a profile that remembers both', () => {
    const first = learnFromCorrection(
      null,
      facts({ ...IDENTIFIED, amountTotal: 421 }),
      facts({ ...IDENTIFIED, amountTotal: 4210 }),
      '2026-08-01',
    )
    const second = learnFromCorrection(
      first,
      facts({ ...IDENTIFIED, docDate: '2026-01-08' }),
      facts({ ...IDENTIFIED, docDate: '2026-08-01' }),
      '2026-08-11',
    )

    expect(second.corrections).toBe(2)
    expect(second.lastSeen).toBe('2026-08-11')
    expect(second.trust['amountTotal']).toBeTruthy()
    expect(second.trust['docDate']).toBeTruthy()
    expect(second.vendorPib).toBe('100002887')
  })
})

// ===========================================================================
// applyProfile — deterministic layer 2, and the refusals that let the ladder
// fall through to layer 3+ (§5 layer 2, D15)
//
// MERGE NOTE — 2-of-3 (e1, e2) read `raw` as a FLAT map keyed by the literal
// trusted source path, e.g. { 'di.InvoiceTotal': '4.210,00' }; e3 walked the
// dotted path through nested objects. Majority wins — the spec only ever shows
// the path as an opaque string. Recorded as a spec gap.
// ===========================================================================

const TRUSTED: Record<string, string> = { amountTotal: 'di.InvoiceTotal', docDate: 'di.InvoiceDate' }

function trained(patch: Partial<VendorProfile> = {}): VendorProfile {
  return profileOf({
    trust: { ...TRUSTED },
    hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'RSD' },
    corrections: 1,
    ...patch,
  })
}

const RAW: Record<string, unknown> = { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': '11.08.2026' }

describe('applyProfile', () => {
  describe('reading a second document from a corrected vendor', () => {
    it('returns the trusted fields as facts, with no model involved at all', () => {
      const out = applyProfile(trained(), RAW)

      expect(out).toEqual(
        facts({
          vendorName: 'OMV Srbija',
          vendorPib: '100002887',
          docDate: '2026-08-11',
          amountTotal: 4210,
          currency: 'RSD',
        }),
      )
    })

    it('names the vendor from the profile rather than re-reading it from the raw candidates', () => {
      const out = applyProfile(trained(), { ...RAW, 'di.VendorName': 'MAXl DO0' })

      expect(out?.vendorName).toBe('OMV Srbija')
      expect(out?.vendorPib).toBe('100002887')
    })

    it('prefers a raw vendor name when the profile learned to trust one', () => {
      const p = trained({ trust: { ...TRUSTED, vendorName: 'di.VendorName' } })

      const out = applyProfile(p, { ...RAW, 'di.VendorName': 'OMV SRBIJA DOO BEOGRAD' })

      expect(out?.vendorName).toBe('OMV SRBIJA DOO BEOGRAD')
    })

    it('applies the profile currency default when the raw candidates name no currency', () => {
      const p = trained({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'EUR' } })

      expect(applyProfile(p, RAW)?.currency).toBe('EUR')
    })

    it('prefers a currency the document actually states over the profile default', () => {
      const p = trained({ trust: { ...TRUSTED, currency: 'di.Currency' } })

      const out = applyProfile(p, { ...RAW, 'di.Currency': 'EUR' })

      expect(out?.currency).toBe('EUR')
    })

    it('leaves the currency null when neither the document nor the profile knows it', () => {
      const p = trained({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',' } })

      const out = applyProfile(p, RAW)

      expect(out).not.toBeNull()
      expect(out?.currency).toBeNull()
    })

    it('leaves the currency null when the stored default is not a currency it knows', () => {
      const p = trained({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'XYZ' } })

      expect(applyProfile(p, RAW)?.currency).toBeNull()
    })

    it('fills net and VAT only when the profile learned where they live', () => {
      const p = trained({ trust: { ...TRUSTED, amountNet: 'di.SubTotal', vatAmount: 'di.TotalTax' } })

      const out = applyProfile(p, { ...RAW, 'di.SubTotal': '3.508,33', 'di.TotalTax': '701,67' })

      expect(out?.amountNet).toBe(3508.33)
      expect(out?.vatAmount).toBe(701.67)
    })

    it('leaves net and VAT null when the profile trusts no source for them', () => {
      const out = applyProfile(trained(), { ...RAW, 'di.SubTotal': '99.999,00' })

      expect(out?.amountTotal).toBe(4210)
      expect(out?.amountNet).toBeNull()
      expect(out?.vatAmount).toBeNull()
    })

    it('returns an empty line-item list, because a profile cannot learn line items', () => {
      expect(applyProfile(trained(), RAW)?.lineItems).toEqual([])
    })

    it('ignores raw keys the profile never learned to trust', () => {
      const out = applyProfile(trained(), { ...RAW, 'di.PurchaseOrder': 'PO-9', noise: { nested: true } })

      expect(out).toEqual(applyProfile(trained(), RAW))
    })

    it('gives the same answer every time for the same profile and raw candidates', () => {
      expect(applyProfile(trained(), RAW)).toEqual(applyProfile(trained(), RAW))
    })

    it('does not mutate the profile or the raw candidates it was handed', () => {
      const p = trained()
      const raw = { ...RAW }
      const pSnapshot = structuredClone(p)
      const rawSnapshot = structuredClone(raw)

      applyProfile(p, raw)

      expect(p).toEqual(pSnapshot)
      expect(raw).toEqual(rawSnapshot)
    })
  })

  describe('amounts read under the learned decimal hint', () => {
    function totalFrom(decimal: ',' | '.' | undefined, value: unknown): number | null | undefined {
      const p = trained({
        hints: decimal ? { dateFormat: 'DD.MM.YYYY', decimal } : { dateFormat: 'DD.MM.YYYY' },
      })
      const out = applyProfile(p, { 'di.InvoiceTotal': value, 'di.InvoiceDate': '11.08.2026' })
      return out === null ? null : out.amountTotal
    }

    it.each<[label: string, decimal: ',' | '.' | undefined, value: unknown, expected: number]>([
      ['comma decimal, thousands dot', ',', '4.210,00', 4210],
      ['comma decimal, millions', ',', '1.234.567,89', 1234567.89],
      ['comma decimal, no separators', ',', '300', 300],
      ['comma decimal, sub-unit only', ',', '0,01', 0.01],
      ['dot decimal, thousands comma', '.', '4,210.00', 4210],
      ['dot decimal, plain', '.', '4210.50', 4210.5],
      ['dot decimal, no separators', '.', '300', 300],
      ['no hint, plain machine number', undefined, '4210.50', 4210.5],
    ])('parses %s', (_label, decimal, value, expected) => {
      expect(totalFrom(decimal, value)).toBe(expected)
    })

    it('accepts a raw candidate that is already a number', () => {
      expect(totalFrom(',', 4210.5)).toBe(4210.5)
    })

    it('refuses a value whose separators contradict the learned decimal hint', () => {
      expect(totalFrom(',', '4,210.00')).toBeNull()
    })

    // MERGE NOTE — e3 additionally required a NEGATIVE total to yield null. Dropped:
    // §5 "Validation and failure" gives the 0 < amount_total < 10,000,000 range to
    // core/extract/validate.ts, so this layer must not re-implement it. e1's zero
    // case pins that division. Recorded as a spec gap.
    it('parses a zero total rather than re-implementing the range rules validate owns', () => {
      expect(totalFrom(',', '0,00')).toBe(0)
    })

    it.each<[label: string, value: unknown]>([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['prose', 'ukupno'],
      ['an object', { amount: 4210 }],
      ['an array', ['4.210,00']],
      ['a boolean', true],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('returns null when the trusted total is %s', (_label, value) => {
      expect(applyProfile(trained(), { 'di.InvoiceTotal': value, 'di.InvoiceDate': '11.08.2026' })).toBeNull()
    })
  })

  describe('dates read under the learned format hint', () => {
    function dateFrom(dateFormat: string | undefined, value: unknown): ExtractedFacts | null {
      const p = trained({ hints: dateFormat ? { dateFormat, decimal: ',' } : { decimal: ',' } })
      return applyProfile(p, { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': value })
    }

    it.each<[label: string, format: string, value: string, expected: string]>([
      ['DD.MM.YYYY', 'DD.MM.YYYY', '11.08.2026', '2026-08-11'],
      ['DD.MM.YYYY at the start of a year', 'DD.MM.YYYY', '01.01.2026', '2026-01-01'],
      ['DD.MM.YYYY at the end of a year', 'DD.MM.YYYY', '31.12.2026', '2026-12-31'],
      ['DD/MM/YYYY', 'DD/MM/YYYY', '11/08/2026', '2026-08-11'],
      ['MM/DD/YYYY', 'MM/DD/YYYY', '08/11/2026', '2026-08-11'],
      ['YYYY-MM-DD', 'YYYY-MM-DD', '2026-08-11', '2026-08-11'],
      ['a leap day', 'DD.MM.YYYY', '29.02.2024', '2024-02-29'],
    ])('reads a %s date "%s" as %s', (_label, format, value, expected) => {
      expect(dateFrom(format, value)?.docDate).toBe(expected)
    })

    it('reads the same digits differently under a different hint — that is what the hint is for', () => {
      expect(dateFrom('DD.MM.YYYY', '08.11.2026')?.docDate).toBe('2026-11-08')
      expect(dateFrom('MM.DD.YYYY', '08.11.2026')?.docDate).toBe('2026-08-11')
    })

    it('reads an unambiguous ISO date even when the profile learned no date format', () => {
      expect(dateFrom(undefined, '2026-08-11')?.docDate).toBe('2026-08-11')
    })

    // MERGE NOTE — e2 wanted an unreadable trusted date to sink the whole result;
    // 2-of-3 (e1, e3) keep the total and null the date. Majority, and §5 makes a
    // null doc_date a needs_review flag downstream rather than a hard failure —
    // so facts with a null date are a legitimate output of this layer.
    it.each<[label: string, format: string | undefined, value: unknown]>([
      ['the value does not match the learned format', 'DD.MM.YYYY', '2026-08-11'],
      ['the day does not exist in that month', 'DD.MM.YYYY', '31.02.2026'],
      ['the day is zero', 'DD.MM.YYYY', '00.08.2026'],
      ['the month is thirteen', 'DD.MM.YYYY', '11.13.2026'],
      ['it is a leap day of a non-leap year', 'DD.MM.YYYY', '29.02.2026'],
      ['the value is prose', 'DD.MM.YYYY', 'avgust 2026'],
      ['the value is an empty string', 'DD.MM.YYYY', ''],
      ['there is no hint and the date is ambiguous day-first or month-first', undefined, '11/08/2026'],
    ])('keeps the total and leaves docDate null when %s', (_label, format, value) => {
      const out = dateFrom(format, value)

      expect(out).not.toBeNull()
      expect(out?.docDate).toBeNull()
      expect(out?.amountTotal).toBe(4210)
    })

    it('keeps the total and leaves docDate null when the trusted date source is absent from raw', () => {
      const out = applyProfile(trained(), { 'di.InvoiceTotal': '4.210,00' })

      expect(out).not.toBeNull()
      expect(out?.docDate).toBeNull()
      expect(out?.amountTotal).toBe(4210)
    })
  })

  describe('the refusals that let the ladder fall through', () => {
    it('returns null when the profile has learned to trust nothing yet', () => {
      expect(applyProfile(trained({ trust: {}, corrections: 0 }), RAW)).toBeNull()
    })

    it('returns null when there are no raw candidates at all', () => {
      expect(applyProfile(trained(), {})).toBeNull()
    })

    it('returns null when none of the trusted source paths appear in the raw candidates', () => {
      expect(applyProfile(trained(), { 'llm.total': '4.210,00', 'llm.date': '11.08.2026' })).toBeNull()
    })

    it('returns null when the trusted total source is absent, even though the date resolves', () => {
      expect(applyProfile(trained(), { 'di.InvoiceDate': '11.08.2026' })).toBeNull()
    })

    it('returns null when the profile knows where the date lives but not the total', () => {
      const dateOnly = trained({ trust: { docDate: 'di.InvoiceDate' } })

      expect(applyProfile(dateOnly, RAW)).toBeNull()
    })

    it('returns null when the profile trusts a source path that is an empty string', () => {
      expect(applyProfile(trained({ trust: { amountTotal: '' } }), { '': '4.210,00' })).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // A trust label is an ATOMIC KEY, never a path to walk.
  //
  // This is a security boundary, not a style preference. Trust labels live in
  // `_state/vendor-profiles.json`, which /tebra can propose edits to (09-TEBRA
  // §3, D18). If applyProfile split a label on '.' and descended, a label of
  // `__proto__.polluted` would become a write into Object.prototype reachable
  // from a model-authored proposal. A flat lookup makes it a missing key.
  // ─────────────────────────────────────────────────────────────────────────

  describe('trust labels are atomic keys, not paths', () => {
    it('reads a dotted trust label as one flat key rather than descending into nested candidates', () => {
      const nested = { di: { InvoiceTotal: '9.999,00' } } as unknown as RawCandidates

      // The value exists only at the nested path, never at the flat key, so a
      // flat lookup finds nothing and the profile is unusable.
      expect(applyProfile(trained(), nested)).toBeNull()
    })

    it('prefers the flat key even when a nested shape of the same name is also present', () => {
      const both = {
        ...RAW,
        di: { InvoiceTotal: '9.999,00' },
      } as unknown as RawCandidates

      expect(applyProfile(trained(), both)?.amountTotal).toBe(4210)
    })

    it.each<[string]>([
      ['__proto__.polluted'],
      ['constructor.prototype.polluted'],
      ['__proto__'],
      ['constructor'],
    ])('treats the trust label %s as an ordinary missing key', (label) => {
      const p = trained({ trust: { amountTotal: label } })

      expect(applyProfile(p, RAW)).toBeNull()
    })

    it('never reaches Object.prototype through a hostile trust label', () => {
      const p = trained({ trust: { amountTotal: '__proto__.polluted' } })

      applyProfile(p, { ...RAW, polluted: '4.210,00' })

      expect((Object.prototype as unknown as Record<string, unknown>)['polluted']).toBeUndefined()
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it('does not mutate the raw candidates it was given', () => {
      const raw: RawCandidates = { ...RAW }
      const snapshot = structuredClone(raw)

      applyProfile(trained(), raw)

      expect(raw).toEqual(snapshot)
    })
  })
})
