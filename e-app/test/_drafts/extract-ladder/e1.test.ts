import { describe, it, expect } from 'vitest'
import { runLadder } from '../../../src/engine/extract/ladder.js'
import type { Rung, RungResult, LadderInput } from '../../../src/engine/extract/ladder.js'
import {
  vendorKey,
  learnFromCorrection,
  applyProfile,
} from '../../../src/engine/extract/vendor-profile.js'
import type { VendorProfile } from '../../../src/engine/extract/vendor-profile.js'
import type { Clock, Confidence, ExtractedFacts, ExtractionMethod } from '../../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library anywhere in this file (06-TDD §3).
// ---------------------------------------------------------------------------

const FIXED_CLOCK: Clock = { now: () => new Date('2026-08-11T09:00:00.000Z') }
const OTHER_CLOCK: Clock = { now: () => new Date('2019-01-31T23:59:59.000Z') }

const EMPTY_FACTS: ExtractedFacts = {
  vendorName: null,
  vendorPib: null,
  docDate: null,
  amountNet: null,
  vatAmount: null,
  amountTotal: null,
  currency: null,
  lineItems: [],
}

function facts(over: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return { ...EMPTY_FACTS, lineItems: [], ...over }
}

function input(over: Partial<LadderInput> = {}): LadderInput {
  return {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
    filename: 'racun-2026-08.pdf',
    vendorHint: null,
    ...over,
  }
}

/** Records which rungs were invoked, in order, and with what. */
interface Recorder {
  calls: ExtractionMethod[]
  inputs: LadderInput[]
  countOf(method: ExtractionMethod): number
}

function recorder(): Recorder {
  const calls: ExtractionMethod[] = []
  const inputs: LadderInput[] = []
  return {
    calls,
    inputs,
    countOf: (method) => calls.filter((m) => m === method).length,
  }
}

function okRung(method: ExtractionMethod, result: RungResult, rec: Recorder): Rung {
  return {
    method,
    run: async (i) => {
      rec.calls.push(method)
      rec.inputs.push(i)
      return result
    },
  }
}

function nullRung(method: ExtractionMethod, rec: Recorder): Rung {
  return {
    method,
    run: async (i) => {
      rec.calls.push(method)
      rec.inputs.push(i)
      return null
    },
  }
}

/** Rejects its promise — the ordinary async failure. */
function rejectingRung(method: ExtractionMethod, rec: Recorder): Rung {
  return {
    method,
    run: async (i) => {
      rec.calls.push(method)
      rec.inputs.push(i)
      throw new Error(`${method} exploded`)
    },
  }
}

/** Throws before ever returning a promise — the nastier failure. */
function syncThrowingRung(method: ExtractionMethod, rec: Recorder): Rung {
  return {
    method,
    run: (i) => {
      rec.calls.push(method)
      rec.inputs.push(i)
      throw new Error(`${method} threw synchronously`)
    },
  }
}

const QR_RESULT: RungResult = {
  facts: facts({ vendorName: 'MAXI DOO', amountTotal: 4210, currency: 'RSD', docDate: '2026-08-11' }),
  confidence: 'exact',
  model: null,
}

const DI_RESULT: RungResult = {
  facts: facts({ vendorName: 'Elektro Beograd', amountTotal: 9999.5, currency: 'RSD' }),
  confidence: 'high',
  model: null,
}

const VISION_RESULT: RungResult = {
  facts: facts({ vendorName: 'Handwritten Shop', amountTotal: 300, currency: 'EUR' }),
  confidence: 'medium',
  model: 'gpt-4o-mini@2026-05',
}

// ===========================================================================
// runLadder — short-circuiting is the whole point (01 §5, 06-TDD §4)
// ===========================================================================

describe('runLadder — short-circuiting', () => {
  it('stops at the first rung that answers and never invokes a later one', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      okRung('fiscal_qr', QR_RESULT, rec),
      nullRung('di_invoice', rec),
      nullRung('llm_vision', rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(rec.calls).toEqual(['fiscal_qr'])
    expect(rec.countOf('di_invoice')).toBe(0)
    expect(rec.countOf('llm_vision')).toBe(0)
    expect(outcome.attempted).toEqual(['fiscal_qr'])
    expect(outcome.extraction.method).toBe('fiscal_qr')
    expect(outcome.facts).toEqual(QR_RESULT.facts)
  })

  it('records every rung it had to fall through, in order, up to the one that answered', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      nullRung('cache', rec),
      nullRung('fiscal_qr', rec),
      nullRung('vendor_profile', rec),
      okRung('di_invoice', DI_RESULT, rec),
      nullRung('llm_vision', rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.attempted).toEqual(['cache', 'fiscal_qr', 'vendor_profile', 'di_invoice'])
    expect(rec.calls).toEqual(outcome.attempted)
    expect(rec.countOf('llm_vision')).toBe(0)
    expect(outcome.extraction.method).toBe('di_invoice')
  })

  it('attempts every rung when only the last one answers', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      nullRung('cache', rec),
      nullRung('pdf_text', rec),
      okRung('llm_vision', VISION_RESULT, rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.attempted).toEqual(['cache', 'pdf_text', 'llm_vision'])
    expect(outcome.extraction.method).toBe('llm_vision')
    expect(outcome.facts).toEqual(VISION_RESULT.facts)
  })

  it('treats a rung that answers with wholly empty facts as an answer and still short-circuits', async () => {
    const rec = recorder()
    const emptyAnswer: RungResult = { facts: facts(), confidence: 'low', model: null }
    const rungs: Rung[] = [okRung('pdf_text', emptyAnswer, rec), okRung('di_invoice', DI_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(rec.calls).toEqual(['pdf_text'])
    expect(outcome.extraction.method).toBe('pdf_text')
    expect(outcome.facts).toEqual(facts())
    expect(outcome.attempted).toEqual(['pdf_text'])
  })

  it('runs the rungs in the order it was given, not in a canonical ladder order', async () => {
    const rec = recorder()
    const rungs: Rung[] = [okRung('llm_vision', VISION_RESULT, rec), okRung('cache', QR_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(rec.calls).toEqual(['llm_vision'])
    expect(outcome.attempted).toEqual(['llm_vision'])
    expect(outcome.extraction.method).toBe('llm_vision')
  })

  it('lists the same method twice when two rungs share it and the first cannot answer', async () => {
    const rec = recorder()
    const rungs: Rung[] = [nullRung('llm_vision', rec), okRung('llm_vision', VISION_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.attempted).toEqual(['llm_vision', 'llm_vision'])
    expect(rec.countOf('llm_vision')).toBe(2)
  })

  it('invokes each rung at most once', async () => {
    const rec = recorder()
    const rungs: Rung[] = [nullRung('cache', rec), nullRung('pdf_text', rec), nullRung('di_receipt', rec)]

    await runLadder(rungs, input(), FIXED_CLOCK)

    expect(rec.countOf('cache')).toBe(1)
    expect(rec.countOf('pdf_text')).toBe(1)
    expect(rec.countOf('di_receipt')).toBe(1)
  })
})

describe('runLadder — the manual floor when nothing answers', () => {
  it('yields empty facts with method manual when every rung returns null', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      nullRung('cache', rec),
      nullRung('fiscal_qr', rec),
      nullRung('vendor_profile', rec),
      nullRung('pdf_text', rec),
      nullRung('di_invoice', rec),
      nullRung('llm_vision', rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.facts).toEqual(EMPTY_FACTS)
    expect(outcome.extraction.method).toBe('manual')
    expect(outcome.extraction.model).toBeNull()
    expect(outcome.attempted).toEqual([
      'cache',
      'fiscal_qr',
      'vendor_profile',
      'pdf_text',
      'di_invoice',
      'llm_vision',
    ])
  })

  it('reports the lowest confidence when it falls all the way to manual', async () => {
    const rec = recorder()
    const outcome = await runLadder([nullRung('di_invoice', rec)], input(), FIXED_CLOCK)

    expect(outcome.extraction.confidence).toBe('low')
  })

  it('does not list manual as attempted when no manual rung was supplied', async () => {
    const rec = recorder()
    const outcome = await runLadder([nullRung('pdf_text', rec)], input(), FIXED_CLOCK)

    expect(outcome.extraction.method).toBe('manual')
    expect(outcome.attempted).toEqual(['pdf_text'])
  })

  it('returns the manual outcome with nothing attempted when the rung list is empty', async () => {
    const outcome = await runLadder([], input(), FIXED_CLOCK)

    expect(outcome.attempted).toEqual([])
    expect(outcome.facts).toEqual(EMPTY_FACTS)
    expect(outcome.extraction.method).toBe('manual')
    expect(outcome.extraction.model).toBeNull()
  })

})

describe('runLadder — a failing rung must not abort the ladder', () => {
  it('falls through to the next rung when a rung rejects', async () => {
    const rec = recorder()
    const rungs: Rung[] = [rejectingRung('fiscal_qr', rec), okRung('di_invoice', DI_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.extraction.method).toBe('di_invoice')
    expect(outcome.facts).toEqual(DI_RESULT.facts)
  })

  it('falls through to the next rung when a rung throws synchronously', async () => {
    const rec = recorder()
    const rungs: Rung[] = [syncThrowingRung('pdf_text', rec), okRung('di_receipt', DI_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.extraction.method).toBe('di_receipt')
    expect(rec.calls).toEqual(['pdf_text', 'di_receipt'])
  })

  it('counts a rung that threw as attempted', async () => {
    const rec = recorder()
    const rungs: Rung[] = [rejectingRung('fiscal_qr', rec), okRung('pdf_text', DI_RESULT, rec)]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.attempted).toEqual(['fiscal_qr', 'pdf_text'])
  })

  it('reaches the manual floor instead of propagating when every rung throws', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      rejectingRung('cache', rec),
      syncThrowingRung('vendor_profile', rec),
      rejectingRung('llm_vision', rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(outcome.facts).toEqual(EMPTY_FACTS)
    expect(outcome.extraction.method).toBe('manual')
    expect(outcome.attempted).toEqual(['cache', 'vendor_profile', 'llm_vision'])
  })

  it('still short-circuits after a throw — no rung past the winner is invoked', async () => {
    const rec = recorder()
    const rungs: Rung[] = [
      rejectingRung('fiscal_qr', rec),
      okRung('vendor_profile', DI_RESULT, rec),
      okRung('llm_vision', VISION_RESULT, rec),
    ]

    const outcome = await runLadder(rungs, input(), FIXED_CLOCK)

    expect(rec.countOf('llm_vision')).toBe(0)
    expect(outcome.extraction.method).toBe('vendor_profile')
  })
})

describe('runLadder — provenance carried from the winning rung', () => {
  const confidences: Confidence[] = ['exact', 'high', 'medium', 'low']

  it.each(confidences)('carries the winning rung\'s confidence %s through verbatim', async (confidence) => {
    const rec = recorder()
    const result: RungResult = { facts: facts({ amountTotal: 1 }), confidence, model: null }

    const outcome = await runLadder([okRung('di_invoice', result, rec)], input(), FIXED_CLOCK)

    expect(outcome.extraction.confidence).toBe(confidence)
  })

  it('carries the model label of a model rung', async () => {
    const rec = recorder()

    const outcome = await runLadder([okRung('llm_vision', VISION_RESULT, rec)], input(), FIXED_CLOCK)

    expect(outcome.extraction.model).toBe('gpt-4o-mini@2026-05')
  })

  it('reports a null model when the winning rung omits the field entirely', async () => {
    const rec = recorder()
    const result: RungResult = { facts: facts({ amountTotal: 12 }), confidence: 'exact' }

    const outcome = await runLadder([okRung('fiscal_qr', result, rec)], input(), FIXED_CLOCK)

    expect(outcome.extraction.model).toBeNull()
  })

  it('returns the winning rung\'s facts unchanged, including line items', async () => {
    const rec = recorder()
    const rich: RungResult = {
      facts: facts({
        vendorName: 'Maxi',
        vendorPib: '123456789',
        docDate: '2026-08-01',
        amountNet: 1000,
        vatAmount: 200,
        amountTotal: 1200,
        currency: 'RSD',
        lineItems: [{ description: 'PAMPERS', quantity: 1, unitPrice: 1200, lineTotal: 1200 }],
      }),
      confidence: 'high',
      model: null,
    }

    const outcome = await runLadder([okRung('di_receipt', rich, rec)], input(), FIXED_CLOCK)

    expect(outcome.facts).toEqual(rich.facts)
  })
})

describe('runLadder — what each rung is handed', () => {
  it('hands every attempted rung the input it was given, unaltered', async () => {
    const rec = recorder()
    const given = input({ vendorHint: 'MAXI', filename: 'račun 08.pdf', mimeType: 'image/jpeg' })

    await runLadder([nullRung('cache', rec), nullRung('di_invoice', rec)], given, FIXED_CLOCK)

    expect(rec.inputs).toHaveLength(2)
    expect(rec.inputs[0]).toEqual(given)
    expect(rec.inputs[1]).toEqual(given)
  })

  it('passes an absent vendor hint through as absent rather than inventing one', async () => {
    const rec = recorder()
    const given: LadderInput = {
      bytes: new Uint8Array([1]),
      mimeType: 'application/pdf',
      sha256: 'b'.repeat(64),
      filename: 'x.pdf',
    }

    await runLadder([nullRung('vendor_profile', rec)], given, FIXED_CLOCK)

    expect(rec.inputs[0]?.vendorHint ?? null).toBeNull()
  })

  it('does not mutate the caller\'s input bytes', async () => {
    const rec = recorder()
    const given = input()
    const before = Array.from(given.bytes)

    await runLadder([nullRung('pdf_text', rec)], given, FIXED_CLOCK)

    expect(Array.from(given.bytes)).toEqual(before)
  })

  it('handles an empty byte payload without special-casing it away from the rungs', async () => {
    const rec = recorder()
    const given = input({ bytes: new Uint8Array([]), mimeType: 'application/octet-stream' })

    const outcome = await runLadder([nullRung('pdf_text', rec)], given, FIXED_CLOCK)

    expect(rec.calls).toEqual(['pdf_text'])
    expect(outcome.extraction.method).toBe('manual')
  })

  it('produces the same outcome regardless of the injected clock', async () => {
    const recA = recorder()
    const recB = recorder()

    const a = await runLadder([nullRung('cache', recA), okRung('di_invoice', DI_RESULT, recA)], input(), FIXED_CLOCK)
    const b = await runLadder([nullRung('cache', recB), okRung('di_invoice', DI_RESULT, recB)], input(), OTHER_CLOCK)

    expect(a).toEqual(b)
  })

  it('is repeatable — the same rungs and input yield an equal outcome twice', async () => {
    const rec = recorder()
    const rungs = () => [nullRung('cache', rec), okRung('pdf_text', DI_RESULT, rec)]

    const first = await runLadder(rungs(), input(), FIXED_CLOCK)
    const second = await runLadder(rungs(), input(), FIXED_CLOCK)

    expect(first).toEqual(second)
  })
})

// ===========================================================================
// vendorKey — PIB beats name (01 §5 layer 2)
// ===========================================================================

describe('vendorKey', () => {
  it('prefers the PIB over the name when both are known', () => {
    expect(vendorKey('Maxi d.o.o.', '123456789')).toBe('123456789')
  })

  it('uses the PIB when there is no name at all', () => {
    expect(vendorKey(null, '123456789')).toBe('123456789')
  })

  it('uses the PIB even when the name is an empty string', () => {
    expect(vendorKey('', '123456789')).toBe('123456789')
  })

  it('trims surrounding whitespace from a PIB before using it as the key', () => {
    expect(vendorKey('Maxi d.o.o.', '  123456789  ')).toBe('123456789')
  })

  it('gives two documents from the same PIB the same key even under different trade names', () => {
    expect(vendorKey('MAXI DOO BEOGRAD', '123456789')).toBe(vendorKey('Maxi', '123456789'))
  })

  it('returns null when neither a name nor a PIB is known', () => {
    expect(vendorKey(null, null)).toBeNull()
  })

  it.each([
    ['both empty strings', '', ''],
    ['name whitespace only, no PIB', '   ', null],
    ['name whitespace only, PIB whitespace only', '\t\n ', '   '],
  ])('returns null when %s', (_label, name, pib) => {
    expect(vendorKey(name, pib)).toBeNull()
  })

  it.each([
    ['eight digits', '12345678'],
    ['ten digits', '1234567890'],
    ['nine characters with a letter', '12345678a'],
    ['digits with punctuation', '123-456-789'],
    ['not a number at all', 'PIB'],
  ])('refuses a malformed PIB (%s) and returns null when there is no name to fall back to', (_label, pib) => {
    expect(vendorKey(null, pib)).toBeNull()
  })

  it('falls back to the name when the PIB is malformed rather than keying on garbage', () => {
    const key = vendorKey('Maxi d.o.o.', '12345678')

    expect(key).not.toBeNull()
    expect(key).toBe(vendorKey('Maxi d.o.o.', null))
  })

  it('accepts a PIB of exactly nine digits', () => {
    expect(vendorKey(null, '000000001')).toBe('000000001')
  })

  it('keys on the normalized name when only a name is known', () => {
    const key = vendorKey('Elektro Beograd', null)

    expect(typeof key).toBe('string')
    expect(key).not.toBe('')
  })

  it.each([
    ['case', 'MAXI DOO', 'maxi doo'],
    ['leading and trailing whitespace', 'Maxi doo', '   Maxi doo   '],
    ['collapsible inner whitespace', 'Maxi doo', 'Maxi    doo'],
  ])('produces the same key for names differing only in %s', (_label, a, b) => {
    expect(vendorKey(a, null)).toBe(vendorKey(b, null))
  })

  it('folds Serbian diacritics so OCR spelling variants share one profile', () => {
    expect(vendorKey('Šped Đorđević', null)).toBe(vendorKey('Sped Djordjevic', null))
  })

  it('gives genuinely different vendors different keys', () => {
    expect(vendorKey('Maxi doo', null)).not.toBe(vendorKey('Mini doo', null))
  })

  it('returns a key safe to use as a profile filename', () => {
    const key = vendorKey('Šped / Đorđe d.o.o. ../etc', null)

    expect(key).not.toBeNull()
    expect(key).not.toContain('/')
    expect(key).not.toContain('\\')
    expect(key).not.toContain('..')
    expect(key).not.toMatch(/\s/)
  })

  it('returns null for a name that normalizes away to nothing', () => {
    expect(vendorKey('---', null)).toBeNull()
  })
})

// ===========================================================================
// learnFromCorrection — the compounding rung (D15)
// ===========================================================================

function profile(over: Partial<VendorProfile> = {}): VendorProfile {
  return {
    vendorKey: '123456789',
    vendorName: 'MAXI DOO',
    vendorPib: '123456789',
    trust: {},
    hints: {},
    defaultCategory: null,
    corrections: 0,
    lastSeen: '2026-01-01',
    ...over,
  }
}

const AT = '2026-08-11'

describe('learnFromCorrection', () => {
  it('creates a profile from nothing on the first correction', () => {
    const before = facts({ vendorName: 'MAXI DOO', vendorPib: '123456789', amountTotal: 421 })
    const after = facts({ vendorName: 'MAXI DOO', vendorPib: '123456789', amountTotal: 4210 })

    const learned = learnFromCorrection(null, before, after, AT)

    expect(learned.vendorKey).toBe('123456789')
    expect(learned.vendorName).toBe('MAXI DOO')
    expect(learned.vendorPib).toBe('123456789')
    expect(learned.corrections).toBe(1)
    expect(learned.lastSeen).toBe(AT)
  })

  it('starts a new profile with no learned category, because facts do not carry one', () => {
    const after = facts({ vendorName: 'Maxi', amountTotal: 100 })

    expect(learnFromCorrection(null, facts(), after, AT).defaultCategory).toBeNull()
  })

  it('keys a new profile on the normalized name when the correction has no PIB', () => {
    const after = facts({ vendorName: 'Elektro Beograd', amountTotal: 100 })

    const learned = learnFromCorrection(null, facts(), after, AT)

    expect(learned.vendorKey).toBe(vendorKey('Elektro Beograd', null))
    expect(learned.vendorPib).toBeNull()
  })

  it('increments the existing correction count rather than resetting it', () => {
    const existing = profile({ corrections: 3 })
    const after = facts({ amountTotal: 4210 })

    expect(learnFromCorrection(existing, facts({ amountTotal: 421 }), after, AT).corrections).toBe(4)
  })

  it('stamps lastSeen from the supplied timestamp, never from a clock', () => {
    const existing = profile({ lastSeen: '2020-01-01' })

    expect(learnFromCorrection(existing, facts(), facts({ amountTotal: 1 }), '2026-12-31').lastSeen).toBe('2026-12-31')
  })

  const trustCases: [string, ExtractedFacts, ExtractedFacts, string][] = [
    ['amountTotal', facts({ amountTotal: 421 }), facts({ amountTotal: 4210 }), 'amountTotal'],
    ['docDate', facts({ docDate: '2026-11-08' }), facts({ docDate: '2026-08-11' }), 'docDate'],
    ['vendorPib', facts({ vendorPib: null }), facts({ vendorPib: '123456789' }), 'vendorPib'],
    ['vatAmount', facts({ vatAmount: null }), facts({ vatAmount: 200 }), 'vatAmount'],
    ['currency', facts({ currency: 'RSD' }), facts({ currency: 'EUR' }), 'currency'],
  ]

  it.each(trustCases)('records trust for %s when the user changed it', (_label, before, after, field) => {
    const learned = learnFromCorrection(profile(), before, after, AT)

    expect(Object.keys(learned.trust)).toContain(field)
    expect(learned.trust[field]).toBeTruthy()
  })

  it('records the human as the proven source for a corrected field', () => {
    const learned = learnFromCorrection(profile(), facts({ amountTotal: 421 }), facts({ amountTotal: 4210 }), AT)

    expect(learned.trust['amountTotal']).toBe('manual')
  })

  it('does not record trust for a field the user left alone', () => {
    const before = facts({ amountTotal: 421, docDate: '2026-08-11' })
    const after = facts({ amountTotal: 4210, docDate: '2026-08-11' })

    const learned = learnFromCorrection(profile(), before, after, AT)

    expect(Object.keys(learned.trust)).not.toContain('docDate')
  })

  it('keeps trust learned from earlier corrections for fields this one did not touch', () => {
    const existing = profile({ trust: { docDate: 'di.InvoiceDate' } })
    const learned = learnFromCorrection(existing, facts({ amountTotal: 421 }), facts({ amountTotal: 4210 }), AT)

    expect(learned.trust['docDate']).toBe('di.InvoiceDate')
    expect(learned.trust['amountTotal']).toBeTruthy()
  })

  it('overwrites the trusted source when the same field is corrected again', () => {
    const existing = profile({ trust: { amountTotal: 'di.InvoiceTotal' } })
    const learned = learnFromCorrection(existing, facts({ amountTotal: 421 }), facts({ amountTotal: 4210 }), AT)

    expect(learned.trust['amountTotal']).toBe('manual')
  })

  it('still counts a correction that changed nothing, and learns no new trust from it', () => {
    const same = facts({ amountTotal: 4210, docDate: '2026-08-11' })
    const existing = profile({ corrections: 2 })

    const learned = learnFromCorrection(existing, same, same, AT)

    expect(learned.corrections).toBe(3)
    expect(learned.trust).toEqual({})
  })

  it('learns the vendor name when the user supplied one the extractor missed', () => {
    const learned = learnFromCorrection(
      profile({ vendorName: 'MAXI', vendorPib: null, vendorKey: vendorKey('MAXI', null) as string }),
      facts({ vendorName: 'MAXI' }),
      facts({ vendorName: 'MAXI DOO BEOGRAD' }),
      AT,
    )

    expect(learned.vendorName).toBe('MAXI DOO BEOGRAD')
  })

  it('never erases a known vendor name with a null from the corrected facts', () => {
    const learned = learnFromCorrection(profile({ vendorName: 'MAXI DOO' }), facts(), facts({ amountTotal: 10 }), AT)

    expect(learned.vendorName).toBe('MAXI DOO')
  })

  it('never erases a known PIB with a null from the corrected facts', () => {
    const learned = learnFromCorrection(profile({ vendorPib: '123456789' }), facts(), facts({ amountTotal: 10 }), AT)

    expect(learned.vendorPib).toBe('123456789')
  })

  it('keeps the profile key stable when a later correction supplies a PIB for the first time', () => {
    const existing = profile({ vendorKey: vendorKey('Elektro Beograd', null) as string, vendorPib: null })

    const learned = learnFromCorrection(existing, facts(), facts({ vendorPib: '123456789' }), AT)

    expect(learned.vendorKey).toBe(existing.vendorKey)
    expect(learned.vendorPib).toBe('123456789')
  })

  it('adopts the corrected currency as the profile default when it has no currency hint', () => {
    const learned = learnFromCorrection(profile(), facts({ currency: null }), facts({ currency: 'EUR' }), AT)

    expect(learned.hints.currencyDefault).toBe('EUR')
  })

  it('leaves an already-learned currency hint alone', () => {
    const existing = profile({ hints: { currencyDefault: 'EUR', decimal: ',', dateFormat: 'DD.MM.YYYY' } })

    const learned = learnFromCorrection(existing, facts({ currency: 'EUR' }), facts({ currency: 'EUR' }), AT)

    expect(learned.hints.currencyDefault).toBe('EUR')
    expect(learned.hints.decimal).toBe(',')
    expect(learned.hints.dateFormat).toBe('DD.MM.YYYY')
  })

  it('does not mutate the profile it was handed', () => {
    const existing = profile({ corrections: 1, trust: { docDate: 'di.InvoiceDate' } })
    const snapshot = JSON.parse(JSON.stringify(existing)) as VendorProfile

    learnFromCorrection(existing, facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), AT)

    expect(existing).toEqual(snapshot)
  })

  it('folds two corrections in sequence into a profile that remembers both', () => {
    const first = learnFromCorrection(null, facts({ amountTotal: 421 }), facts({ amountTotal: 4210, vendorPib: '123456789', vendorName: 'MAXI DOO' }), '2026-08-01')
    const second = learnFromCorrection(first, facts({ docDate: '2026-01-08' }), facts({ docDate: '2026-08-01' }), '2026-08-11')

    expect(second.corrections).toBe(2)
    expect(second.lastSeen).toBe('2026-08-11')
    expect(second.trust['amountTotal']).toBeTruthy()
    expect(second.trust['docDate']).toBeTruthy()
    expect(second.vendorPib).toBe('123456789')
  })
})

// ===========================================================================
// applyProfile — deterministic rung 2, and its refusals
// ===========================================================================

const TRUSTED = { amountTotal: 'di.InvoiceTotal', docDate: 'di.InvoiceDate' }

function serbianProfile(over: Partial<VendorProfile> = {}): VendorProfile {
  return profile({
    trust: { ...TRUSTED },
    hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'RSD' },
    corrections: 1,
    ...over,
  })
}

describe('applyProfile — the happy path', () => {
  it('reads the fields the profile learned to trust out of the raw candidates', () => {
    const result = applyProfile(serbianProfile(), {
      'di.InvoiceTotal': '4.210,00',
      'di.InvoiceDate': '11.08.2026',
    })

    expect(result).not.toBeNull()
    expect(result?.amountTotal).toBe(4210)
    expect(result?.docDate).toBe('2026-08-11')
  })

  it('names the vendor from the profile rather than re-reading it from raw text', () => {
    const result = applyProfile(serbianProfile(), {
      'di.InvoiceTotal': '4.210,00',
      'di.InvoiceDate': '11.08.2026',
      'di.VendorName': 'MAXl DO0',
    })

    expect(result?.vendorName).toBe('MAXI DOO')
    expect(result?.vendorPib).toBe('123456789')
  })

  it('falls back to the profile currency default when raw carries no currency', () => {
    const result = applyProfile(serbianProfile({ hints: { decimal: ',', dateFormat: 'DD.MM.YYYY', currencyDefault: 'EUR' } }), {
      'di.InvoiceTotal': '1.500,00',
      'di.InvoiceDate': '11.08.2026',
    })

    expect(result?.currency).toBe('EUR')
  })

  it('prefers a currency the document actually states over the profile default', () => {
    const p = serbianProfile({
      trust: { ...TRUSTED, currency: 'di.Currency' },
      hints: { decimal: ',', dateFormat: 'DD.MM.YYYY', currencyDefault: 'RSD' },
    })

    const result = applyProfile(p, {
      'di.InvoiceTotal': '1.500,00',
      'di.InvoiceDate': '11.08.2026',
      'di.Currency': 'EUR',
    })

    expect(result?.currency).toBe('EUR')
  })

  it('leaves the currency null when neither the document nor the profile knows it', () => {
    const p = serbianProfile({ hints: { decimal: ',', dateFormat: 'DD.MM.YYYY' } })

    const result = applyProfile(p, { 'di.InvoiceTotal': '1.500,00', 'di.InvoiceDate': '11.08.2026' })

    expect(result?.currency).toBeNull()
  })

  it('refuses a profile currency default that is not a supported currency', () => {
    const p = serbianProfile({ hints: { decimal: ',', dateFormat: 'DD.MM.YYYY', currencyDefault: 'XXX' } })

    const result = applyProfile(p, { 'di.InvoiceTotal': '1.500,00', 'di.InvoiceDate': '11.08.2026' })

    expect(result?.currency).toBeNull()
  })

  it('returns line items as an empty array when the profile trusts no line-item source', () => {
    const result = applyProfile(serbianProfile(), { 'di.InvoiceTotal': '1.500,00', 'di.InvoiceDate': '11.08.2026' })

    expect(result?.lineItems).toEqual([])
  })

  it('ignores raw keys the profile does not trust', () => {
    const result = applyProfile(serbianProfile(), {
      'di.InvoiceTotal': '1.500,00',
      'di.InvoiceDate': '11.08.2026',
      'di.SubTotal': '99.999,00',
      noise: { nested: true },
    })

    expect(result?.amountTotal).toBe(1500)
    expect(result?.amountNet).toBeNull()
  })

  it('fills net and VAT when the profile learned to trust those sources too', () => {
    const p = serbianProfile({ trust: { ...TRUSTED, amountNet: 'di.SubTotal', vatAmount: 'di.TotalTax' } })

    const result = applyProfile(p, {
      'di.InvoiceTotal': '1.200,00',
      'di.InvoiceDate': '11.08.2026',
      'di.SubTotal': '1.000,00',
      'di.TotalTax': '200,00',
    })

    expect(result?.amountNet).toBe(1000)
    expect(result?.vatAmount).toBe(200)
  })

  it('does not mutate the profile or the raw candidates it was handed', () => {
    const p = serbianProfile()
    const raw = { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': '11.08.2026' }
    const pSnapshot = JSON.parse(JSON.stringify(p)) as VendorProfile
    const rawSnapshot = { ...raw }

    applyProfile(p, raw)

    expect(p).toEqual(pSnapshot)
    expect(raw).toEqual(rawSnapshot)
  })
})

describe('applyProfile — amount parsing under the decimal hint', () => {
  function totalFrom(hintDecimal: ',' | '.' | undefined, value: unknown): number | null | undefined {
    const p = serbianProfile({
      hints: hintDecimal ? { dateFormat: 'DD.MM.YYYY', decimal: hintDecimal } : { dateFormat: 'DD.MM.YYYY' },
    })
    const result = applyProfile(p, { 'di.InvoiceTotal': value, 'di.InvoiceDate': '11.08.2026' })
    return result === null ? null : result.amountTotal
  }

  const amountCases: [string, ',' | '.' | undefined, unknown, number][] = [
    ['comma decimal, thousands dot', ',', '4.210,00', 4210],
    ['comma decimal, millions', ',', '1.234.567,89', 1234567.89],
    ['comma decimal, no separators', ',', '300', 300],
    ['comma decimal, sub-unit only', ',', '0,50', 0.5],
    ['dot decimal, thousands comma', '.', '4,210.00', 4210],
    ['dot decimal, plain', '.', '4210.50', 4210.5],
    ['dot decimal, no separators', '.', '300', 300],
    ['no hint, plain machine number', undefined, '4210.50', 4210.5],
  ]

  it.each(amountCases)('parses %s', (_label, hintDecimal, value, expected) => {
    expect(totalFrom(hintDecimal, value)).toBe(expected)
  })

  it('accepts a raw candidate that is already a number', () => {
    expect(totalFrom(',', 4210.5)).toBe(4210.5)
  })

  it('refuses a value whose separators contradict the learned decimal hint', () => {
    expect(totalFrom(',', '4,210.00')).toBeNull()
  })

  const malformedTotals: [string, unknown][] = [
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['prose', 'ukupno'],
    ['an object', { amount: 4210 }],
    ['an array', ['4.210,00']],
    ['a boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ]

  it.each(malformedTotals)('returns null when the trusted total is %s', (_label, value) => {
    const result = applyProfile(serbianProfile(), { 'di.InvoiceTotal': value, 'di.InvoiceDate': '11.08.2026' })

    expect(result).toBeNull()
  })

  it('parses a zero total rather than re-implementing the range rules that validate owns', () => {
    expect(totalFrom(',', '0,00')).toBe(0)
  })
})

describe('applyProfile — date parsing under the format hint', () => {
  function dateFrom(dateFormat: string | undefined, value: unknown): string | null | undefined {
    const p = serbianProfile({
      hints: dateFormat ? { dateFormat, decimal: ',' } : { decimal: ',' },
      trust: { ...TRUSTED },
    })
    const result = applyProfile(p, { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': value })
    return result === null ? null : result.docDate
  }

  it.each([
    ['DD.MM.YYYY', 'DD.MM.YYYY', '11.08.2026', '2026-08-11'],
    ['DD.MM.YYYY with a trailing dot', 'DD.MM.YYYY', '01.01.2026', '2026-01-01'],
    ['DD/MM/YYYY', 'DD/MM/YYYY', '11/08/2026', '2026-08-11'],
    ['MM/DD/YYYY', 'MM/DD/YYYY', '08/11/2026', '2026-08-11'],
    ['YYYY-MM-DD', 'YYYY-MM-DD', '2026-08-11', '2026-08-11'],
    ['last day of the year', 'DD.MM.YYYY', '31.12.2026', '2026-12-31'],
    ['a leap day', 'DD.MM.YYYY', '29.02.2024', '2024-02-29'],
  ])('reads %s', (_label, format, value, expected) => {
    expect(dateFrom(format, value)).toBe(expected)
  })

  it('reads an unambiguous ISO date when the profile learned no date format', () => {
    expect(dateFrom(undefined, '2026-08-11')).toBe('2026-08-11')
  })

  it('leaves the date null rather than guessing day-first or month-first without a format hint', () => {
    expect(dateFrom(undefined, '11/08/2026')).toBeNull()
  })

  it.each([
    ['the value does not match the learned format', 'DD.MM.YYYY', '2026-08-11'],
    ['the day does not exist in that month', 'DD.MM.YYYY', '31.02.2026'],
    ['the day is zero', 'DD.MM.YYYY', '00.08.2026'],
    ['the month is thirteen', 'DD.MM.YYYY', '11.13.2026'],
    ['it is a leap day of a non-leap year', 'DD.MM.YYYY', '29.02.2026'],
    ['the value is prose', 'DD.MM.YYYY', 'datum izdavanja'],
    ['the value is an empty string', 'DD.MM.YYYY', ''],
  ])('drops the date, keeping the total, when %s', (_label, format, value) => {
    const p = serbianProfile({ hints: { dateFormat: format, decimal: ',' } })

    const result = applyProfile(p, { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': value })

    expect(result).not.toBeNull()
    expect(result?.docDate).toBeNull()
    expect(result?.amountTotal).toBe(4210)
  })

  it('drops the date when the trusted date source is absent from raw but keeps the total', () => {
    const result = applyProfile(serbianProfile(), { 'di.InvoiceTotal': '4.210,00' })

    expect(result).not.toBeNull()
    expect(result?.docDate).toBeNull()
  })
})

describe('applyProfile — the refusals that let the ladder fall through', () => {
  it('returns null when the profile has learned to trust nothing', () => {
    const p = serbianProfile({ trust: {}, corrections: 0 })

    expect(applyProfile(p, { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': '11.08.2026' })).toBeNull()
  })

  it('returns null when there are no raw candidates at all', () => {
    expect(applyProfile(serbianProfile(), {})).toBeNull()
  })

  it('returns null when none of the trusted source paths appear in the raw candidates', () => {
    const result = applyProfile(serbianProfile(), {
      'llm.total': '4.210,00',
      'llm.date': '11.08.2026',
    })

    expect(result).toBeNull()
  })

  it('returns null when the trusted total source is absent, even though other trusted fields resolve', () => {
    const result = applyProfile(serbianProfile(), { 'di.InvoiceDate': '11.08.2026' })

    expect(result).toBeNull()
  })

  it('returns null when the trusted total is present but null', () => {
    expect(applyProfile(serbianProfile(), { 'di.InvoiceTotal': null, 'di.InvoiceDate': '11.08.2026' })).toBeNull()
  })

  it('returns null when the trusted total is present but undefined', () => {
    expect(applyProfile(serbianProfile(), { 'di.InvoiceTotal': undefined, 'di.InvoiceDate': '11.08.2026' })).toBeNull()
  })

  it('returns null when the profile trusts a source path that is an empty string', () => {
    const p = serbianProfile({ trust: { amountTotal: '' } })

    expect(applyProfile(p, { '': '4.210,00' })).toBeNull()
  })
})
