import { describe, it, expect } from 'vitest'
import {
  runLadder,
  type LadderInput,
  type Rung,
  type RungResult,
} from '../../../src/core/extract/ladder.js'
import {
  vendorKey,
  learnFromCorrection,
  applyProfile,
  type VendorProfile,
} from '../../../src/core/extract/vendor-profile.js'
import type {
  Clock,
  Confidence,
  ExtractedFacts,
  ExtractionMethod,
} from '../../../src/core/types.js'

// ---------------------------------------------------------------------------
// hand-written fakes (no mocking library — 06-TDD-STRATEGY §3)
// ---------------------------------------------------------------------------

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) })
const CLOCK = clockAt('2026-08-12T09:00:00Z')

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

const facts = (patch: Partial<ExtractedFacts> = {}): ExtractedFacts => ({
  ...NO_FACTS,
  ...patch,
})

interface FakeRung extends Rung {
  /** how many times the ladder invoked this rung */
  calls: number
  /** the inputs it was invoked with, in order */
  seen: LadderInput[]
}

/** A rung that answers with `result`, or declines when `result` is null. */
function fakeRung(method: ExtractionMethod, result: RungResult | null): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: async (input: LadderInput) => {
      r.calls += 1
      r.seen.push(input)
      return result
    },
  }
  return r
}

/** A rung that blows up synchronously inside its async body. */
function throwingRung(method: ExtractionMethod, message = 'rung exploded'): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: async (input: LadderInput) => {
      r.calls += 1
      r.seen.push(input)
      throw new Error(message)
    },
  }
  return r
}

/** A rung whose promise rejects rather than throwing on the synchronous path. */
function rejectingRung(method: ExtractionMethod): FakeRung {
  const r: FakeRung = {
    method,
    calls: 0,
    seen: [],
    run: (input: LadderInput) => {
      r.calls += 1
      r.seen.push(input)
      return Promise.reject(new Error('upstream 500'))
    },
  }
  return r
}

const answer = (
  patch: Partial<ExtractedFacts>,
  confidence: Confidence = 'high',
  model?: string | null,
): RungResult => ({
  facts: facts(patch),
  confidence,
  ...(model === undefined ? {} : { model }),
})

const INPUT: LadderInput = {
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  mimeType: 'application/pdf',
  sha256: '91be0d47',
  filename: 'IMG_4821.pdf',
  vendorHint: null,
}

const input = (patch: Partial<LadderInput> = {}): LadderInput => ({ ...INPUT, ...patch })

// ===========================================================================
// runLadder — the happy path and short-circuiting
// ===========================================================================

describe('runLadder — short-circuiting', () => {
  it('returns the facts of the first rung that answers', async () => {
    const qr = fakeRung('fiscal_qr', answer({ vendorName: 'OMV Srbija', amountTotal: 4210 }, 'exact'))
    const out = await runLadder([qr], input(), CLOCK)

    expect(out.facts.vendorName).toBe('OMV Srbija')
    expect(out.facts.amountTotal).toBe(4210)
    expect(out.extraction.method).toBe('fiscal_qr')
    expect(out.extraction.confidence).toBe('exact')
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
    expect(out.facts.amountTotal).toBe(4210)
  })

  it('reports every rung it attempted, in order, ending with the one that answered', async () => {
    const cache = fakeRung('cache', null)
    const qr = fakeRung('fiscal_qr', null)
    const profile = fakeRung('vendor_profile', answer({ amountTotal: 120 }))
    const di = fakeRung('di_invoice', answer({ amountTotal: 1 }))

    const out = await runLadder([cache, qr, profile, di], input(), CLOCK)

    expect(out.attempted).toEqual(['cache', 'fiscal_qr', 'vendor_profile'])
  })

  it('invokes rungs in the order given, not in a re-sorted canonical cost order', async () => {
    const llm = fakeRung('llm_vision', answer({ amountTotal: 500 }, 'low'))
    const cache = fakeRung('cache', answer({ amountTotal: 1 }, 'exact'))

    const out = await runLadder([llm, cache], input(), CLOCK)

    expect(out.attempted).toEqual(['llm_vision'])
    expect(cache.calls).toBe(0)
    expect(out.facts.amountTotal).toBe(500)
  })

  it.each<[label: string, winnerIndex: number]>([
    ['the very first rung answers', 0],
    ['a middle rung answers', 2],
    ['the very last rung answers', 4],
  ])('stops exactly at the winning rung when %s', async (_label, winnerIndex) => {
    const methods: ExtractionMethod[] = ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice']
    const rungs = methods.map((m, i) =>
      fakeRung(m, i === winnerIndex ? answer({ amountTotal: 100 + i }) : null),
    )

    const out = await runLadder(rungs, input(), CLOCK)

    expect(out.attempted).toEqual(methods.slice(0, winnerIndex + 1))
    expect(out.extraction.method).toBe(methods[winnerIndex])
    rungs.forEach((r, i) => expect(r.calls).toBe(i <= winnerIndex ? 1 : 0))
  })

  it('passes the caller‑supplied input unchanged to each rung it tries', async () => {
    const given = input({ vendorHint: 'OMV', filename: 'račun.pdf' })
    const a = fakeRung('cache', null)
    const b = fakeRung('pdf_text', answer({ amountTotal: 10 }))

    await runLadder([a, b], given, CLOCK)

    expect(a.seen[0]).toEqual(given)
    expect(b.seen[0]).toEqual(given)
    expect(b.seen[0]?.vendorHint).toBe('OMV')
  })

  it('treats a rung result whose facts are entirely null as an answer and stops there', async () => {
    const empty = fakeRung('pdf_text', { facts: facts(), confidence: 'low' })
    const di = fakeRung('di_invoice', answer({ amountTotal: 4210 }))

    const out = await runLadder([empty, di], input(), CLOCK)

    expect(di.calls).toBe(0)
    expect(out.extraction.method).toBe('pdf_text')
    expect(out.facts.amountTotal).toBeNull()
    expect(out.attempted).toEqual(['pdf_text'])
  })

  it('records the winning rung’s model string on the extraction', async () => {
    const llm = fakeRung('llm_vision', answer({ amountTotal: 4210 }, 'medium', 'gpt-4o-mini@2026-05'))
    const out = await runLadder([llm], input(), CLOCK)
    expect(out.extraction.model).toBe('gpt-4o-mini@2026-05')
  })

  it.each<[label: string, model: string | null | undefined]>([
    ['the rung omits it', undefined],
    ['the rung reports it as null', null],
  ])('reports model as null when %s', async (_label, model) => {
    const rung = fakeRung('pdf_text', answer({ amountTotal: 4210 }, 'high', model))
    const out = await runLadder([rung], input(), CLOCK)
    expect(out.extraction.model).toBeNull()
  })

  it.each<Confidence>(['exact', 'high', 'medium', 'low'])(
    'carries the winning rung’s confidence "%s" through unchanged',
    async (confidence) => {
      const rung = fakeRung('di_invoice', answer({ amountTotal: 4210 }, confidence))
      const out = await runLadder([rung], input(), CLOCK)
      expect(out.extraction.confidence).toBe(confidence)
    },
  )

  it('returns the same outcome for the same input no matter what the clock says', async () => {
    const build = () => [fakeRung('cache', null), fakeRung('pdf_text', answer({ amountTotal: 4210 }))]

    const early = await runLadder(build(), input(), clockAt('2020-01-01T00:00:00Z'))
    const late = await runLadder(build(), input(), clockAt('2031-12-31T23:59:59Z'))

    expect(early.facts).toEqual(late.facts)
    expect(early.extraction).toEqual(late.extraction)
    expect(early.attempted).toEqual(late.attempted)
  })

  it('does not let one document’s run leak into the next: each call reports its own attempts', async () => {
    const cache = fakeRung('cache', null)
    const pdf = fakeRung('pdf_text', answer({ amountTotal: 4210 }))

    const first = await runLadder([cache, pdf], input({ sha256: 'aaa' }), CLOCK)
    const second = await runLadder([cache, pdf], input({ sha256: 'bbb' }), CLOCK)

    expect(first.attempted).toEqual(['cache', 'pdf_text'])
    expect(second.attempted).toEqual(['cache', 'pdf_text'])
    expect(pdf.calls).toBe(2)
  })
})

// ===========================================================================
// runLadder — nobody can answer
// ===========================================================================

describe('runLadder — every rung declines', () => {
  it('falls through to manual with empty facts when every rung returns null', async () => {
    const rungs = [
      fakeRung('cache', null),
      fakeRung('fiscal_qr', null),
      fakeRung('vendor_profile', null),
      fakeRung('pdf_text', null),
      fakeRung('di_invoice', null),
      fakeRung('llm_vision', null),
    ]

    const out = await runLadder(rungs, input(), CLOCK)

    expect(out.extraction.method).toBe('manual')
    expect(out.facts).toEqual(NO_FACTS)
    expect(out.facts.lineItems).toEqual([])
    expect(out.extraction.model).toBeNull()
  })

  it('attempts every rung before giving up', async () => {
    const methods: ExtractionMethod[] = ['cache', 'fiscal_qr', 'pdf_text', 'di_receipt', 'llm_vision']
    const rungs = methods.map((m) => fakeRung(m, null))

    const out = await runLadder(rungs, input(), CLOCK)

    expect(out.attempted).toEqual(methods)
    rungs.forEach((r) => expect(r.calls).toBe(1))
  })

  it('reports the lowest confidence when nothing could be extracted', async () => {
    const out = await runLadder([fakeRung('pdf_text', null)], input(), CLOCK)
    expect(out.extraction.confidence).toBe('low')
  })

  it('returns the manual fallback for an empty ladder, having attempted nothing', async () => {
    const out = await runLadder([], input(), CLOCK)

    expect(out.attempted).toEqual([])
    expect(out.extraction.method).toBe('manual')
    expect(out.facts).toEqual(NO_FACTS)
  })

  it('invents no vendor, date or amount when it has nothing to go on', async () => {
    const out = await runLadder([fakeRung('di_invoice', null)], input({ vendorHint: 'OMV Srbija' }), CLOCK)

    expect(out.facts.vendorName).toBeNull()
    expect(out.facts.vendorPib).toBeNull()
    expect(out.facts.docDate).toBeNull()
    expect(out.facts.amountTotal).toBeNull()
    expect(out.facts.currency).toBeNull()
  })
})

// ===========================================================================
// runLadder — a rung that misbehaves
// ===========================================================================

describe('runLadder — a rung that throws', () => {
  it('keeps climbing when a rung throws, and returns the next rung’s answer', async () => {
    const boom = throwingRung('fiscal_qr')
    const di = fakeRung('di_invoice', answer({ amountTotal: 4210 }, 'medium'))

    const out = await runLadder([boom, di], input(), CLOCK)

    expect(di.calls).toBe(1)
    expect(out.facts.amountTotal).toBe(4210)
    expect(out.extraction.method).toBe('di_invoice')
  })

  it('counts a rung that threw as attempted', async () => {
    const boom = throwingRung('fiscal_qr')
    const di = fakeRung('di_invoice', answer({ amountTotal: 4210 }))

    const out = await runLadder([boom, di], input(), CLOCK)

    expect(out.attempted).toEqual(['fiscal_qr', 'di_invoice'])
  })

  it('treats a rejected promise exactly like a thrown error', async () => {
    const flaky = rejectingRung('di_invoice')
    const llm = fakeRung('llm_vision', answer({ amountTotal: 77 }, 'low'))

    const out = await runLadder([flaky, llm], input(), CLOCK)

    expect(out.extraction.method).toBe('llm_vision')
    expect(out.attempted).toEqual(['di_invoice', 'llm_vision'])
  })

  it('falls back to manual rather than rejecting when every rung throws', async () => {
    const out = await runLadder(
      [throwingRung('fiscal_qr'), rejectingRung('di_invoice'), throwingRung('llm_vision')],
      input(),
      CLOCK,
    )

    expect(out.extraction.method).toBe('manual')
    expect(out.facts).toEqual(NO_FACTS)
    expect(out.attempted).toEqual(['fiscal_qr', 'di_invoice', 'llm_vision'])
  })

  it('never reaches a throwing rung that sits below a successful one', async () => {
    const qr = fakeRung('fiscal_qr', answer({ amountTotal: 4210 }, 'exact'))
    const boom = throwingRung('llm_vision')

    const out = await runLadder([qr, boom], input(), CLOCK)

    expect(boom.calls).toBe(0)
    expect(out.extraction.method).toBe('fiscal_qr')
  })
})

// ===========================================================================
// vendorKey
// ===========================================================================

describe('vendorKey', () => {
  it.each<[name: string | null, pib: string | null, expected: string]>([
    ['OMV Srbija', '100002887', '100002887'],
    [null, '100002887', '100002887'],
    ['', '100002887', '100002887'],
  ])('prefers the PIB over the name (%s, %s)', (name, pib, expected) => {
    expect(vendorKey(name, pib)).toBe(expected)
  })

  it.each<[pib: string, label: string]>([
    ['10000288', '8 digits — one short'],
    ['1000028871', '10 digits — one over'],
    ['10000288A', 'nine characters but not all digits'],
    ['', 'empty string'],
  ])('falls back to the normalized name when the PIB is unusable (%s: %s)', (pib) => {
    expect(vendorKey('OMV Srbija', pib)).toBe('omv-srbija')
  })

  it('accepts a PIB of exactly nine digits, including all zeros', () => {
    expect(vendorKey('OMV Srbija', '000000000')).toBe('000000000')
  })

  it('trims surrounding whitespace from the PIB before using it', () => {
    expect(vendorKey('OMV Srbija', '  100002887  ')).toBe('100002887')
  })

  it.each<[name: string, expected: string]>([
    ['OMV Srbija', 'omv-srbija'],
    ['  OMV   Srbija  ', 'omv-srbija'],
    ['omv srbija', 'omv-srbija'],
    ['OMV-SRBIJA', 'omv-srbija'],
    ['Delhaize Serbia', 'delhaize-serbia'],
  ])('normalizes the vendor name to a stable slug: %s', (name, expected) => {
    expect(vendorKey(name, null)).toBe(expected)
  })

  it.each<[name: string, expected: string]>([
    ['Štark', 'stark'],
    ['Čačak', 'cacak'],
    ['Ćuprija Đak', 'cuprija-dak'],
    ['Žabalj', 'zabalj'],
  ])('folds Serbian diacritics so %s keys as %s', (name, expected) => {
    expect(vendorKey(name, null)).toBe(expected)
  })

  it('collapses punctuation in a legal form rather than dropping the name', () => {
    expect(vendorKey('Delhaize d.o.o.', null)).toBe('delhaize-d-o-o')
  })

  it.each<[label: string, name: string | null, pib: string | null]>([
    ['both are null', null, null],
    ['the name is empty and there is no PIB', '', null],
    ['the name is only whitespace', '   ', null],
    ['the name is only punctuation', '...', null],
    ['the name is only separators', '---', null],
    ['both are unusable', '  ', '123'],
  ])('returns null rather than guessing a key when %s', (_label, name, pib) => {
    expect(vendorKey(name, pib)).toBeNull()
  })

  it('gives one and the same key to every casing and spacing variant of a name', () => {
    const variants = ['OMV Srbija', 'omv srbija', '  OMV  SRBIJA ', 'Omv-Srbija']
    const keys = variants.map((v) => vendorKey(v, null))
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).not.toBeNull()
  })

  it('produces a stable non-null key for a Cyrillic vendor name', () => {
    const first = vendorKey('Максибрза Доо', null)
    const second = vendorKey('Максибрза Доо', null)
    expect(first).not.toBeNull()
    expect(first).toBe(second)
  })
})

// ===========================================================================
// learnFromCorrection
// ===========================================================================

const profileOf = (patch: Partial<VendorProfile> = {}): VendorProfile => ({
  vendorKey: '100002887',
  vendorName: 'OMV Srbija',
  vendorPib: '100002887',
  trust: {},
  hints: {},
  defaultCategory: null,
  corrections: 0,
  lastSeen: '2026-01-01',
  ...patch,
})

describe('learnFromCorrection', () => {
  const before = facts({ vendorName: 'OMV Srbija', vendorPib: '100002887', docDate: '2026-08-11', amountTotal: 421 })
  const after = facts({ vendorName: 'OMV Srbija', vendorPib: '100002887', docDate: '2026-08-11', amountTotal: 4210 })

  it('creates a profile from nothing when the vendor has never been corrected before', () => {
    const p = learnFromCorrection(null, before, after, '2026-08-12')

    expect(p.corrections).toBe(1)
    expect(p.vendorName).toBe('OMV Srbija')
    expect(p.vendorPib).toBe('100002887')
    expect(p.vendorKey).toBe('100002887')
    expect(p.lastSeen).toBe('2026-08-12')
  })

  it.each<[startingCorrections: number, expected: number]>([
    [0, 1],
    [1, 2],
    [3, 4],
  ])('increments corrections from %i to %i', (start, expected) => {
    const p = learnFromCorrection(profileOf({ corrections: start }), before, after, '2026-08-12')
    expect(p.corrections).toBe(expected)
  })

  it('increments corrections even when the user changed nothing', () => {
    const p = learnFromCorrection(profileOf({ corrections: 2 }), before, before, '2026-08-12')
    expect(p.corrections).toBe(3)
  })

  it('records no new trust when the user changed nothing', () => {
    const p = learnFromCorrection(profileOf({ corrections: 2 }), before, before, '2026-08-12')
    expect(p.trust).toEqual({})
  })

  it('stamps lastSeen with the supplied instant, never with a clock of its own', () => {
    const p = learnFromCorrection(profileOf({ lastSeen: '2020-02-02' }), before, after, '2026-08-12')
    expect(p.lastSeen).toBe('2026-08-12')
  })

  it('records what it learned for the field the user actually corrected', () => {
    const p = learnFromCorrection(null, before, after, '2026-08-12')

    expect(Object.keys(p.trust)).toContain('amountTotal')
    expect(typeof p.trust['amountTotal']).toBe('string')
    expect(p.trust['amountTotal']).not.toBe('')
  })

  it('records nothing for fields the user left alone', () => {
    const p = learnFromCorrection(null, before, after, '2026-08-12')

    expect(Object.keys(p.trust)).not.toContain('docDate')
    expect(Object.keys(p.trust)).not.toContain('vendorName')
  })

  it('keeps trust learned from earlier corrections that this one does not touch', () => {
    const existing = profileOf({ trust: { docDate: 'di.InvoiceDate' } })
    const p = learnFromCorrection(existing, before, after, '2026-08-12')

    expect(p.trust['docDate']).toBe('di.InvoiceDate')
    expect(Object.keys(p.trust)).toContain('amountTotal')
  })

  it('overwrites trust for a field that is corrected a second time', () => {
    const existing = profileOf({ trust: { amountTotal: 'pdf.regexTotal' } })
    const p = learnFromCorrection(existing, before, after, '2026-08-12')

    expect(p.trust['amountTotal']).not.toBe('pdf.regexTotal')
  })

  it('learns the vendor’s PIB when the correction supplies one the extractor missed', () => {
    const p = learnFromCorrection(
      profileOf({ vendorPib: null, vendorKey: 'omv-srbija' }),
      facts({ vendorName: 'OMV Srbija', vendorPib: null }),
      facts({ vendorName: 'OMV Srbija', vendorPib: '100002887' }),
      '2026-08-12',
    )

    expect(p.vendorPib).toBe('100002887')
    expect(p.vendorKey).toBe('100002887')
  })

  it('accepts a correction that removes a wrong PIB rather than keeping the bad one', () => {
    const p = learnFromCorrection(
      profileOf({ vendorPib: '123' }),
      facts({ vendorName: 'OMV Srbija', vendorPib: '123' }),
      facts({ vendorName: 'OMV Srbija', vendorPib: null }),
      '2026-08-12',
    )

    expect(p.vendorPib).toBeNull()
    expect(Object.keys(p.trust)).toContain('vendorPib')
  })

  it('keeps the existing key when the correction carries no vendor identity at all', () => {
    const p = learnFromCorrection(
      profileOf({ vendorKey: '100002887' }),
      facts({ amountTotal: 1 }),
      facts({ amountTotal: 2 }),
      '2026-08-12',
    )

    expect(p.vendorKey).toBe('100002887')
  })

  it('learns the vendor’s currency as a hint for next time', () => {
    const p = learnFromCorrection(
      null,
      facts({ vendorName: 'Wolt', currency: 'RSD', amountTotal: 1200 }),
      facts({ vendorName: 'Wolt', currency: 'EUR', amountTotal: 1200 }),
      '2026-08-12',
    )

    expect(p.hints.currencyDefault).toBe('EUR')
  })

  it('keeps hints that this correction says nothing about', () => {
    const existing = profileOf({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',' } })
    const p = learnFromCorrection(existing, before, after, '2026-08-12')

    expect(p.hints.dateFormat).toBe('DD.MM.YYYY')
    expect(p.hints.decimal).toBe(',')
  })

  it('never invents a default category from a single correction', () => {
    const p = learnFromCorrection(null, before, after, '2026-08-12')
    expect(p.defaultCategory).toBeNull()
  })

  it('preserves a default category that was already set', () => {
    const p = learnFromCorrection(profileOf({ defaultCategory: 'MATERIALS' }), before, after, '2026-08-12')
    expect(p.defaultCategory).toBe('MATERIALS')
  })

  it('does not mutate the profile it was given', () => {
    const existing = profileOf({ corrections: 3, trust: { docDate: 'di.InvoiceDate' } })
    const snapshot = structuredClone(existing)

    learnFromCorrection(existing, before, after, '2026-08-12')

    expect(existing).toEqual(snapshot)
  })

  it('does not mutate the facts it was given', () => {
    const b = structuredClone(before)
    const a = structuredClone(after)

    learnFromCorrection(null, b, a, '2026-08-12')

    expect(b).toEqual(before)
    expect(a).toEqual(after)
  })
})

// ===========================================================================
// applyProfile
// ===========================================================================

const trained = (patch: Partial<VendorProfile> = {}): VendorProfile =>
  profileOf({
    trust: {
      amountTotal: 'di.InvoiceTotal',
      docDate: 'di.InvoiceDate',
    },
    hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'EUR' },
    corrections: 1,
    ...patch,
  })

describe('applyProfile', () => {
  it('reads the fields the profile learned to trust and returns them as facts', () => {
    const out = applyProfile(trained(), {
      di: { InvoiceTotal: '1.234,56', InvoiceDate: '11.08.2026' },
    })

    expect(out).not.toBeNull()
    expect(out?.amountTotal).toBe(1234.56)
    expect(out?.docDate).toBe('2026-08-11')
  })

  it('stamps the vendor identity from the profile, not from the raw payload', () => {
    const out = applyProfile(trained(), {
      di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026', VendorName: 'WRONG SRL' },
    })

    expect(out?.vendorName).toBe('OMV Srbija')
    expect(out?.vendorPib).toBe('100002887')
  })

  it('applies the currency hint when the raw payload names no currency', () => {
    const out = applyProfile(trained(), { di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026' } })
    expect(out?.currency).toBe('EUR')
  })

  it('lets a currency the profile learned to read win over the default hint', () => {
    const p = trained({
      trust: { amountTotal: 'di.InvoiceTotal', docDate: 'di.InvoiceDate', currency: 'di.CurrencyCode' },
    })
    const out = applyProfile(p, {
      di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026', CurrencyCode: 'RSD' },
    })

    expect(out?.currency).toBe('RSD')
  })

  it.each<[decimal: ',' | '.', rawTotal: string, expected: number]>([
    [',', '1.234,56', 1234.56],
    [',', '4.210,00', 4210],
    [',', '0,01', 0.01],
    ['.', '1,234.56', 1234.56],
    ['.', '4210.50', 4210.5],
  ])('reads "%s"-decimal amount %s as %d', (decimal, rawTotal, expected) => {
    const out = applyProfile(trained({ hints: { decimal } }), { di: { InvoiceTotal: rawTotal } })
    expect(out?.amountTotal).toBe(expected)
  })

  it('takes a raw value that is already a number as-is', () => {
    const out = applyProfile(trained(), { di: { InvoiceTotal: 4210, InvoiceDate: '11.08.2026' } })
    expect(out?.amountTotal).toBe(4210)
  })

  it.each<[format: string, raw: string, expected: string]>([
    ['DD.MM.YYYY', '11.08.2026', '2026-08-11'],
    ['MM/DD/YYYY', '08/11/2026', '2026-08-11'],
    ['YYYY-MM-DD', '2026-08-11', '2026-08-11'],
    ['DD.MM.YYYY', '29.02.2024', '2024-02-29'],
  ])('reads a %s date "%s" as %s', (dateFormat, raw, expected) => {
    const out = applyProfile(trained({ hints: { dateFormat, decimal: ',' } }), {
      di: { InvoiceTotal: '100,00', InvoiceDate: raw },
    })
    expect(out?.docDate).toBe(expected)
  })

  it('reads the same digits differently under a different date hint — that is what the hint is for', () => {
    const raw = { di: { InvoiceTotal: '100,00', InvoiceDate: '08.11.2026' } }
    const dmy = applyProfile(trained({ hints: { dateFormat: 'DD.MM.YYYY', decimal: ',' } }), raw)
    const mdy = applyProfile(trained({ hints: { dateFormat: 'MM.DD.YYYY', decimal: ',' } }), raw)

    expect(dmy?.docDate).toBe('2026-11-08')
    expect(mdy?.docDate).toBe('2026-08-11')
  })

  it.each<[label: string, raw: string]>([
    ['a day that does not exist in that month', '31.02.2026'],
    ['a non-leap 29 February', '29.02.2026'],
    ['a month of 13', '11.13.2026'],
    ['text where a date should be', 'not a date'],
  ])('leaves docDate null rather than guessing when the raw date is %s', (_label, raw) => {
    const out = applyProfile(trained(), { di: { InvoiceTotal: '100,00', InvoiceDate: raw } })

    expect(out).not.toBeNull()
    expect(out?.docDate).toBeNull()
    expect(out?.amountTotal).toBe(100)
  })

  it('still returns facts when the date is missing but the trusted total resolves', () => {
    const out = applyProfile(trained(), { di: { InvoiceTotal: '100,00' } })

    expect(out).not.toBeNull()
    expect(out?.amountTotal).toBe(100)
    expect(out?.docDate).toBeNull()
  })

  it('resolves net and VAT when the profile learned where they live', () => {
    const p = trained({
      trust: {
        amountTotal: 'di.InvoiceTotal',
        amountNet: 'di.SubTotal',
        vatAmount: 'di.TotalTax',
        docDate: 'di.InvoiceDate',
      },
    })
    const out = applyProfile(p, {
      di: { InvoiceTotal: '4.210,00', SubTotal: '3.508,33', TotalTax: '701,67', InvoiceDate: '11.08.2026' },
    })

    expect(out?.amountNet).toBe(3508.33)
    expect(out?.vatAmount).toBe(701.67)
  })

  it('returns an empty line-item list rather than omitting it', () => {
    const out = applyProfile(trained(), { di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026' } })
    expect(out?.lineItems).toEqual([])
  })

  it.each<[label: string, raw: Record<string, unknown>]>([
    ['the payload is empty', {}],
    ['the trusted path is absent from the payload', { other: { Total: '100,00' } }],
    ['the trusted path resolves to null', { di: { InvoiceTotal: null } }],
    ['the trusted path resolves to undefined', { di: { InvoiceTotal: undefined } }],
    ['a path segment runs through a non-object', { di: 'nope' }],
    ['the trusted total is not a number at all', { di: { InvoiceTotal: 'n/a' } }],
    ['the trusted total is an empty string', { di: { InvoiceTotal: '' } }],
    ['the trusted total is negative', { di: { InvoiceTotal: '-100,00' } }],
    ['the trusted total is not finite', { di: { InvoiceTotal: Number.POSITIVE_INFINITY } }],
    ['the trusted total is an object', { di: { InvoiceTotal: { amount: 100 } } }],
  ])('returns null rather than guessing when %s', (_label, raw) => {
    expect(applyProfile(trained(), raw)).toBeNull()
  })

  it('returns null when the profile has learned nothing to trust yet', () => {
    const untrained = trained({ trust: {} })
    expect(applyProfile(untrained, { di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026' } })).toBeNull()
  })

  it('returns null when the profile knows where the date lives but not the total', () => {
    const dateOnly = trained({ trust: { docDate: 'di.InvoiceDate' } })
    expect(applyProfile(dateOnly, { di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026' } })).toBeNull()
  })

  it('does not mutate the raw payload or the profile', () => {
    const p = trained()
    const raw = { di: { InvoiceTotal: '100,00', InvoiceDate: '11.08.2026' } }
    const pSnapshot = structuredClone(p)
    const rawSnapshot = structuredClone(raw)

    applyProfile(p, raw)

    expect(p).toEqual(pSnapshot)
    expect(raw).toEqual(rawSnapshot)
  })

  it('gives the same answer every time for the same profile and payload', () => {
    const p = trained()
    const raw = { di: { InvoiceTotal: '4.210,00', InvoiceDate: '11.08.2026' } }

    expect(applyProfile(p, raw)).toEqual(applyProfile(p, raw))
  })
})
