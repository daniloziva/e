import { describe, it, expect } from 'vitest'
import { runLadder } from '../../../src/engine/extract/ladder.js'
import type { LadderInput, Rung, RungResult } from '../../../src/engine/extract/ladder.js'
import {
  vendorKey,
  learnFromCorrection,
  applyProfile,
} from '../../../src/engine/extract/vendor-profile.js'
import type { VendorProfile } from '../../../src/engine/extract/vendor-profile.js'
import type { Clock, ExtractedFacts, ExtractionMethod } from '../../../src/engine/types.js'

// ---------------------------------------------------------------------------
// Hand-written fakes. No mocking library anywhere in this file.
// ---------------------------------------------------------------------------

const FIXED_CLOCK: Clock = { now: () => new Date('2026-08-11T09:00:00Z') }
const OTHER_CLOCK: Clock = { now: () => new Date('2019-01-31T23:59:59Z') }

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

function facts(over: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return { ...NO_FACTS, lineItems: [], ...over }
}

function input(over: Partial<LadderInput> = {}): LadderInput {
  return {
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
    filename: 'racun-2026-08.pdf',
    vendorHint: null,
    ...over,
  }
}

/** A rung whose invocations are counted. `trace` records global ordering. */
interface Spy {
  rung: Rung
  calls: number
  seen: LadderInput[]
}

function spy(
  method: ExtractionMethod,
  behaviour: (i: LadderInput) => Promise<RungResult | null>,
  trace: string[] = [],
): Spy {
  const s: Spy = {
    calls: 0,
    seen: [],
    rung: {
      method,
      run: (i) => {
        s.calls++
        s.seen.push(i)
        trace.push(`${method}:start`)
        return behaviour(i).then((r) => {
          trace.push(`${method}:end`)
          return r
        })
      },
    },
  }
  return s
}

/** Answers with a result — the ladder must stop here. */
function answers(
  method: ExtractionMethod,
  result: Partial<RungResult> = {},
  trace: string[] = [],
): Spy {
  return spy(
    method,
    async () => ({ facts: facts({ amountTotal: 4210, docDate: '2026-08-11' }), confidence: 'high', ...result }),
    trace,
  )
}

/** Declines (returns null) — the ladder must fall through. */
function declines(method: ExtractionMethod, trace: string[] = []): Spy {
  return spy(method, async () => null, trace)
}

/** Rejects asynchronously. */
function rejects(method: ExtractionMethod, trace: string[] = []): Spy {
  return spy(
    method,
    async () => {
      throw new Error(`${method} blew up`)
    },
    trace,
  )
}

/** Throws synchronously, before ever returning a promise. */
function throwsSync(method: ExtractionMethod, thrown: unknown = new Error('sync boom'), trace: string[] = []): Spy {
  const s: Spy = {
    calls: 0,
    seen: [],
    rung: {
      method,
      run: ((i: LadderInput) => {
        s.calls++
        s.seen.push(i)
        trace.push(`${method}:throw`)
        throw thrown
      }) as Rung['run'],
    },
  }
  return s
}

// ---------------------------------------------------------------------------
// runLadder — short-circuiting. The headline guarantee.
// ---------------------------------------------------------------------------

describe('runLadder — short-circuiting', () => {
  it('invokes no later rung once a rung has answered', async () => {
    const cache = answers('cache')
    const di = declines('di_invoice')
    const llm = declines('llm_vision')

    await runLadder([cache.rung, di.rung, llm.rung], input(), FIXED_CLOCK)

    expect(cache.calls).toBe(1)
    expect(di.calls).toBe(0)
    expect(llm.calls).toBe(0)
  })

  it.each([
    { winnerIndex: 0, attempted: ['cache'], skipped: 4 },
    { winnerIndex: 1, attempted: ['cache', 'fiscal_qr'], skipped: 3 },
    { winnerIndex: 2, attempted: ['cache', 'fiscal_qr', 'vendor_profile'], skipped: 2 },
    { winnerIndex: 3, attempted: ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text'], skipped: 1 },
    { winnerIndex: 4, attempted: ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice'], skipped: 0 },
  ])(
    'stops at rung $winnerIndex and leaves $skipped later rungs uninvoked',
    async ({ winnerIndex, attempted, skipped }) => {
      const methods: ExtractionMethod[] = ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice']
      const spies = methods.map((m, i) => (i === winnerIndex ? answers(m) : declines(m)))

      const out = await runLadder(
        spies.map((s) => s.rung),
        input(),
        FIXED_CLOCK,
      )

      expect(out.attempted).toEqual(attempted)
      expect(spies.slice(0, winnerIndex + 1).map((s) => s.calls)).toEqual(
        new Array(winnerIndex + 1).fill(1),
      )
      expect(spies.slice(winnerIndex + 1).map((s) => s.calls)).toEqual(new Array(skipped).fill(0))
    },
  )

  it('stops at the winning rung even when its confidence is the lowest possible', async () => {
    const qr = answers('fiscal_qr', { confidence: 'low' })
    const llm = declines('llm_vision')

    const out = await runLadder([qr.rung, llm.rung], input(), FIXED_CLOCK)

    expect(llm.calls).toBe(0)
    expect(out.extraction.confidence).toBe('low')
    expect(out.attempted).toEqual(['fiscal_qr'])
  })

  it('treats a result carrying no facts at all as an answer and still stops', async () => {
    const qr = answers('fiscal_qr', { facts: facts(), confidence: 'low' })
    const di = declines('di_invoice')

    const out = await runLadder([qr.rung, di.rung], input(), FIXED_CLOCK)

    expect(di.calls).toBe(0)
    expect(out.extraction.method).toBe('fiscal_qr')
    expect(out.facts).toEqual(NO_FACTS)
  })

  it('runs rungs in the order the caller supplied, not in canonical ladder order', async () => {
    const llm = answers('llm_vision')
    const cache = answers('cache')

    const out = await runLadder([llm.rung, cache.rung], input(), FIXED_CLOCK)

    expect(out.attempted).toEqual(['llm_vision'])
    expect(cache.calls).toBe(0)
  })

  it('waits for each rung to settle before starting the next one', async () => {
    const trace: string[] = []
    const slow = spy(
      'pdf_text',
      () => new Promise<RungResult | null>((resolve) => setTimeout(() => resolve(null), 10)),
      trace,
    )
    const fast = answers('di_invoice', {}, trace)

    await runLadder([slow.rung, fast.rung], input(), FIXED_CLOCK)

    expect(trace).toEqual(['pdf_text:start', 'pdf_text:end', 'di_invoice:start', 'di_invoice:end'])
  })

  it('records a repeated method once per invocation when the same method appears twice', async () => {
    const first = declines('pdf_text')
    const second = answers('pdf_text')

    const out = await runLadder([first.rung, second.rung], input(), FIXED_CLOCK)

    expect(out.attempted).toEqual(['pdf_text', 'pdf_text'])
    expect(first.calls).toBe(1)
    expect(second.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// runLadder — the outcome it builds from the winning rung
// ---------------------------------------------------------------------------

describe('runLadder — outcome from the winning rung', () => {
  it('returns the winning rung facts unchanged', async () => {
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
    const qr = answers('fiscal_qr', { facts: won })

    const out = await runLadder([qr.rung], input(), FIXED_CLOCK)

    expect(out.facts).toEqual(won)
  })

  it('takes the extraction method from the rung, not from the rung result', async () => {
    const di = answers('di_receipt')

    const out = await runLadder([declines('cache').rung, di.rung], input(), FIXED_CLOCK)

    expect(out.extraction.method).toBe('di_receipt')
  })

  it.each(['exact', 'high', 'medium', 'low'] as const)(
    'carries the winning rung confidence "%s" through untouched',
    async (confidence) => {
      const rung = answers('pdf_text', { confidence })

      const out = await runLadder([rung.rung], input(), FIXED_CLOCK)

      expect(out.extraction.confidence).toBe(confidence)
    },
  )

  it('carries the model label of a model-backed rung', async () => {
    const llm = answers('llm_vision', { model: 'gpt-4o-mini@2026-05' })

    const out = await runLadder([llm.rung], input(), FIXED_CLOCK)

    expect(out.extraction.model).toBe('gpt-4o-mini@2026-05')
  })

  it.each([
    { label: 'omitted', result: {} as Partial<RungResult> },
    { label: 'explicitly null', result: { model: null } as Partial<RungResult> },
  ])('reports model as null when the rung leaves it $label', async ({ result }) => {
    const rung = answers('pdf_text', result)

    const out = await runLadder([rung.rung], input(), FIXED_CLOCK)

    expect(out.extraction.model).toBeNull()
  })

  it('passes facts through without validating them — validation is a separate step', async () => {
    const bogus = facts({
      vendorPib: '12345678901',
      docDate: '2099-12-31',
      amountTotal: 99_000_000,
      vatAmount: 100_000_000,
    })
    const llm = answers('llm_vision', { facts: bogus, confidence: 'low' })

    const out = await runLadder([llm.rung], input(), FIXED_CLOCK)

    expect(out.facts).toEqual(bogus)
  })

  it('produces the same outcome whatever the clock reads', async () => {
    const build = () => [declines('cache').rung, answers('pdf_text').rung]

    const a = await runLadder(build(), input(), FIXED_CLOCK)
    const b = await runLadder(build(), input(), OTHER_CLOCK)

    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------
// runLadder — exhaustion: nobody could answer
// ---------------------------------------------------------------------------

describe('runLadder — when no rung can answer', () => {
  it('falls to manual with empty facts when every rung declines', async () => {
    const spies = (['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice', 'llm_vision'] as const).map(
      (m) => declines(m),
    )

    const out = await runLadder(
      spies.map((s) => s.rung),
      input(),
      FIXED_CLOCK,
    )

    expect(out.facts).toEqual(NO_FACTS)
    expect(out.extraction.method).toBe('manual')
    expect(out.extraction.model).toBeNull()
  })

  it('reports the lowest confidence when it fell all the way to manual', async () => {
    const out = await runLadder([declines('pdf_text').rung], input(), FIXED_CLOCK)

    expect(out.extraction.confidence).toBe('low')
  })

  it('lists every rung it tried when all of them declined', async () => {
    const methods: ExtractionMethod[] = ['cache', 'fiscal_qr', 'vendor_profile', 'pdf_text', 'di_invoice', 'llm_vision']

    const out = await runLadder(
      methods.map((m) => declines(m).rung),
      input(),
      FIXED_CLOCK,
    )

    expect(out.attempted).toEqual(methods)
  })

  it('returns the manual floor with an empty attempted list when there are no rungs at all', async () => {
    const out = await runLadder([], input(), FIXED_CLOCK)

    expect(out.attempted).toEqual([])
    expect(out.extraction.method).toBe('manual')
    expect(out.facts).toEqual(NO_FACTS)
  })

})

// ---------------------------------------------------------------------------
// runLadder — a broken rung must never take the ladder down with it
// ---------------------------------------------------------------------------

describe('runLadder — a rung that fails', () => {
  it('keeps going when a rung rejects, and lets a later rung answer', async () => {
    const broken = rejects('di_invoice')
    const llm = answers('llm_vision')

    const out = await runLadder([broken.rung, llm.rung], input(), FIXED_CLOCK)

    expect(out.extraction.method).toBe('llm_vision')
    expect(llm.calls).toBe(1)
  })

  it('keeps going when a rung throws synchronously, before returning a promise', async () => {
    const broken = throwsSync('pdf_text')
    const di = answers('di_invoice')

    const out = await runLadder([broken.rung, di.rung], input(), FIXED_CLOCK)

    expect(out.extraction.method).toBe('di_invoice')
    expect(di.calls).toBe(1)
  })

  it('records a rung that failed as attempted', async () => {
    const out = await runLadder([rejects('di_invoice').rung, answers('llm_vision').rung], input(), FIXED_CLOCK)

    expect(out.attempted).toEqual(['di_invoice', 'llm_vision'])
  })

  it('contains a rung that throws a non-Error value', async () => {
    const broken = throwsSync('vendor_profile', 'just a string')
    const pdf = answers('pdf_text')

    const out = await runLadder([broken.rung, pdf.rung], input(), FIXED_CLOCK)

    expect(out.extraction.method).toBe('pdf_text')
  })

  it('falls to manual with empty facts when every rung fails', async () => {
    const out = await runLadder(
      [rejects('fiscal_qr').rung, throwsSync('pdf_text').rung, rejects('llm_vision').rung],
      input(),
      FIXED_CLOCK,
    )

    expect(out.facts).toEqual(NO_FACTS)
    expect(out.extraction.method).toBe('manual')
    expect(out.attempted).toEqual(['fiscal_qr', 'pdf_text', 'llm_vision'])
  })
})

// ---------------------------------------------------------------------------
// runLadder — what each rung is handed
// ---------------------------------------------------------------------------

describe('runLadder — the input handed to rungs', () => {
  it('hands every invoked rung the same input it was given', async () => {
    const given = input({ sha256: 'b'.repeat(64), filename: 'faktura.pdf', vendorHint: 'OMV' })
    const a = declines('cache')
    const b = answers('pdf_text')

    await runLadder([a.rung, b.rung], given, FIXED_CLOCK)

    expect(a.seen[0]).toEqual(given)
    expect(b.seen[0]).toEqual(given)
  })

  it('forwards an absent vendorHint without inventing one', async () => {
    const given = input()
    delete (given as Partial<LadderInput>).vendorHint
    const rung = answers('pdf_text')

    await runLadder([rung.rung], given, FIXED_CLOCK)

    expect(rung.seen[0]?.vendorHint ?? null).toBeNull()
  })

  it.each([
    { label: 'a zero-byte document', over: { bytes: new Uint8Array(0) } },
    { label: 'an empty sha256 and filename', over: { sha256: '', filename: '' } },
    { label: 'an unknown mime type', over: { mimeType: 'application/octet-stream' } },
  ])('still runs the ladder for $label rather than refusing up front', async ({ over }) => {
    const rung = declines('pdf_text')

    const out = await runLadder([rung.rung], input(over), FIXED_CLOCK)

    expect(rung.calls).toBe(1)
    expect(out.attempted).toEqual(['pdf_text'])
  })
})

// ---------------------------------------------------------------------------
// vendorKey
// ---------------------------------------------------------------------------

describe('vendorKey', () => {
  it('prefers the PIB over the name when both are known', () => {
    expect(vendorKey('OMV Srbija', '100002593')).toBe('100002593')
  })

  it('gives two differently spelled records of the same PIB the same key', () => {
    expect(vendorKey('OMV SRBIJA DOO', '100002593')).toBe(vendorKey('omv srbija', '100002593'))
  })

  it('trims surrounding whitespace from a PIB', () => {
    expect(vendorKey(null, '  100002593  ')).toBe('100002593')
  })

  it.each([
    { pib: '12345678', label: '8 digits' },
    { pib: '123456789', label: '9 digits' },
    { pib: '1234567890', label: '10 digits' },
  ])('accepts a PIB as the key only at exactly 9 digits ($label)', ({ pib, label }) => {
    const key = vendorKey('Neki Dobavljac', pib)
    if (label === '9 digits') expect(key).toBe(pib)
    else expect(key).not.toBe(pib)
  })

  it('falls back to the name when the PIB is not nine digits', () => {
    expect(vendorKey('OMV Srbija', '1234')).toBe(vendorKey('OMV Srbija', null))
  })

  it('falls back to the name when the PIB contains non-digits', () => {
    expect(vendorKey('OMV Srbija', '10000259X')).toBe(vendorKey('OMV Srbija', null))
  })

  it.each([
    { name: 'Wolt', expected: 'wolt' },
    { name: 'WOLT', expected: 'wolt' },
    { name: 'OMV Srbija', expected: 'omv-srbija' },
    { name: '  OMV   Srbija  ', expected: 'omv-srbija' },
    { name: 'ĐORĐE ŽIVKOVIĆ', expected: 'dorde-zivkovic' },
  ])('normalizes the name "$name" to "$expected" when no PIB is known', ({ name, expected }) => {
    expect(vendorKey(name, null)).toBe(expected)
  })

  it('produces a key that is safe to use as a blob path segment', () => {
    const key = vendorKey('A/B Trade & Co.', null)
    expect(key).not.toBeNull()
    expect(key).not.toMatch(/[\s/\\]/)
  })

  it.each([
    { label: 'both absent', name: null, pib: null },
    { label: 'both empty', name: '', pib: '' },
    { label: 'a whitespace-only name', name: '   ', pib: null },
    { label: 'a name with nothing alphanumeric in it', name: '---', pib: null },
    { label: 'an unusable PIB and no name', name: null, pib: '42' },
  ])('returns null rather than invent a key when there is $label', ({ name, pib }) => {
    expect(vendorKey(name, pib)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// learnFromCorrection
// ---------------------------------------------------------------------------

const BEFORE = facts({
  vendorName: 'OMV',
  vendorPib: null,
  docDate: '2026-07-01',
  amountTotal: 421,
  currency: 'RSD',
})

const AFTER = facts({
  vendorName: 'OMV Srbija',
  vendorPib: '100002593',
  docDate: '2026-08-11',
  amountTotal: 4210,
  currency: 'RSD',
})

function profileFor(over: Partial<VendorProfile> = {}): VendorProfile {
  return {
    vendorKey: 'omv-srbija',
    vendorName: 'OMV Srbija',
    vendorPib: null,
    trust: {},
    hints: {},
    defaultCategory: null,
    corrections: 3,
    lastSeen: '2026-07-01',
    ...over,
  }
}

describe('learnFromCorrection', () => {
  it('creates a first profile for a vendor that has never been corrected', () => {
    const p = learnFromCorrection(null, BEFORE, AFTER, '2026-08-11')

    expect(p.corrections).toBe(1)
    expect(p.vendorName).toBe('OMV Srbija')
    expect(p.vendorPib).toBe('100002593')
    expect(p.lastSeen).toBe('2026-08-11')
  })

  it('keys a brand-new profile the same way vendorKey would', () => {
    const p = learnFromCorrection(null, BEFORE, AFTER, '2026-08-11')

    expect(p.vendorKey).toBe(vendorKey('OMV Srbija', '100002593'))
  })

  it('increments the correction count of an existing profile', () => {
    const p = learnFromCorrection(profileFor({ corrections: 3 }), BEFORE, AFTER, '2026-08-11')

    expect(p.corrections).toBe(4)
  })

  it('moves lastSeen to the moment of the correction', () => {
    const p = learnFromCorrection(profileFor({ lastSeen: '2026-01-01' }), BEFORE, AFTER, '2026-08-11')

    expect(p.lastSeen).toBe('2026-08-11')
  })

  it('records a trust entry for each field the correction changed', () => {
    const before = facts({ amountTotal: 421, docDate: '2026-07-01', vendorName: 'OMV Srbija' })
    const after = facts({ amountTotal: 4210, docDate: '2026-08-11', vendorName: 'OMV Srbija' })

    const p = learnFromCorrection(profileFor(), before, after, '2026-08-11')

    expect(Object.keys(p.trust).sort()).toEqual(['amountTotal', 'docDate'])
  })

  it('records every trust value as a non-empty source label', () => {
    const p = learnFromCorrection(profileFor(), BEFORE, AFTER, '2026-08-11')

    for (const value of Object.values(p.trust)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('records nothing new for a field the correction left alone', () => {
    const before = facts({ amountTotal: 421, docDate: '2026-08-11' })
    const after = facts({ amountTotal: 4210, docDate: '2026-08-11' })

    const p = learnFromCorrection(profileFor(), before, after, '2026-08-11')

    expect(p.trust).not.toHaveProperty('docDate')
  })

  it('keeps trust learned from earlier corrections of other fields', () => {
    const existing = profileFor({ trust: { docDate: 'di.InvoiceDate' } })
    const before = facts({ amountTotal: 421 })
    const after = facts({ amountTotal: 4210 })

    const p = learnFromCorrection(existing, before, after, '2026-08-11')

    expect(p.trust['docDate']).toBe('di.InvoiceDate')
    expect(p.trust).toHaveProperty('amountTotal')
  })

  it('keeps one trust entry per field when the same field is corrected twice', () => {
    const first = learnFromCorrection(profileFor(), facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), '2026-08-10')
    const second = learnFromCorrection(first, facts({ amountTotal: 2 }), facts({ amountTotal: 3 }), '2026-08-11')

    expect(Object.keys(second.trust)).toEqual(['amountTotal'])
    expect(second.corrections).toBe(5)
  })

  it('does not record trust for a field the user cleared, because nothing was proved right', () => {
    const before = facts({ vatAmount: 999, amountTotal: 4210 })
    const after = facts({ vatAmount: null, amountTotal: 4210 })

    const p = learnFromCorrection(profileFor(), before, after, '2026-08-11')

    expect(p.trust).not.toHaveProperty('vatAmount')
  })

  it('still counts a confirmation where the user changed nothing', () => {
    const p = learnFromCorrection(profileFor({ corrections: 2 }), AFTER, AFTER, '2026-08-11')

    expect(p.corrections).toBe(3)
    expect(p.trust).toEqual({})
  })

  it('fills in a PIB the correction supplied for a profile that had none', () => {
    const p = learnFromCorrection(profileFor({ vendorPib: null }), BEFORE, AFTER, '2026-08-11')

    expect(p.vendorPib).toBe('100002593')
  })

  it('keeps the profile key stable when a later correction supplies a PIB', () => {
    const existing = profileFor({ vendorKey: 'omv-srbija', vendorPib: null })

    const p = learnFromCorrection(existing, BEFORE, AFTER, '2026-08-11')

    expect(p.vendorKey).toBe('omv-srbija')
  })

  it('adopts the corrected vendor name', () => {
    const p = learnFromCorrection(
      profileFor({ vendorName: 'OMV' }),
      facts({ vendorName: 'OMV' }),
      facts({ vendorName: 'OMV Srbija' }),
      '2026-08-11',
    )

    expect(p.vendorName).toBe('OMV Srbija')
  })

  it('learns the vendor default currency from a corrected currency', () => {
    const p = learnFromCorrection(
      profileFor(),
      facts({ currency: 'RSD' }),
      facts({ currency: 'EUR' }),
      '2026-08-11',
    )

    expect(p.hints.currencyDefault).toBe('EUR')
  })

  it('leaves the default category alone — categorization is not learned here', () => {
    const p = learnFromCorrection(profileFor({ defaultCategory: 'MATERIALS' }), BEFORE, AFTER, '2026-08-11')

    expect(p.defaultCategory).toBe('MATERIALS')
  })

  it('does not mutate the profile it was given', () => {
    const existing = profileFor({ corrections: 3, trust: {}, lastSeen: '2026-07-01' })

    learnFromCorrection(existing, BEFORE, AFTER, '2026-08-11')

    expect(existing.corrections).toBe(3)
    expect(existing.trust).toEqual({})
    expect(existing.lastSeen).toBe('2026-07-01')
  })

  it('still returns a profile when the correction carries no vendor identity at all', () => {
    const p = learnFromCorrection(null, facts({ amountTotal: 1 }), facts({ amountTotal: 2 }), '2026-08-11')

    expect(typeof p.vendorKey).toBe('string')
    expect(p.corrections).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// applyProfile
// ---------------------------------------------------------------------------

const LEARNED = profileFor({
  vendorKey: '100002593',
  vendorName: 'OMV Srbija',
  vendorPib: '100002593',
  trust: { amountTotal: 'di.InvoiceTotal', docDate: 'di.InvoiceDate' },
  hints: { dateFormat: 'DD.MM.YYYY', decimal: ',', currencyDefault: 'RSD' },
})

const RAW = { 'di.InvoiceTotal': '4.210,00', 'di.InvoiceDate': '11.08.2026' }

describe('applyProfile', () => {
  it('reads a second document from a corrected vendor without any model', () => {
    const out = applyProfile(LEARNED, RAW)

    expect(out).toEqual(
      facts({
        vendorName: 'OMV Srbija',
        vendorPib: '100002593',
        docDate: '2026-08-11',
        amountTotal: 4210,
        currency: 'RSD',
      }),
    )
  })

  it('reads a comma decimal separator when the vendor hint says comma', () => {
    const out = applyProfile(LEARNED, { ...RAW, 'di.InvoiceTotal': '1.234,56' })

    expect(out?.amountTotal).toBe(1234.56)
  })

  it('reads a dot decimal separator when the vendor hint says dot', () => {
    const p = profileFor({ ...LEARNED, hints: { ...LEARNED.hints, decimal: '.' } })

    const out = applyProfile(p, { ...RAW, 'di.InvoiceTotal': '1,234.56' })

    expect(out?.amountTotal).toBe(1234.56)
  })

  it('accepts a raw value that is already a number', () => {
    const out = applyProfile(LEARNED, { ...RAW, 'di.InvoiceTotal': 4210 })

    expect(out?.amountTotal).toBe(4210)
  })

  it('reads a day-first date as day-first when that is what the vendor uses', () => {
    const out = applyProfile(LEARNED, { ...RAW, 'di.InvoiceDate': '03.04.2026' })

    expect(out?.docDate).toBe('2026-04-03')
  })

  it('reads the same digits as month-first for a vendor whose hint says month-first', () => {
    const p = profileFor({ ...LEARNED, hints: { ...LEARNED.hints, dateFormat: 'MM/DD/YYYY' } })

    const out = applyProfile(p, { ...RAW, 'di.InvoiceDate': '03/04/2026' })

    expect(out?.docDate).toBe('2026-03-04')
  })

  it('accepts an unambiguous ISO date even with no date hint', () => {
    const p = profileFor({ ...LEARNED, hints: { decimal: ',', currencyDefault: 'RSD' } })

    const out = applyProfile(p, { ...RAW, 'di.InvoiceDate': '2026-08-11' })

    expect(out?.docDate).toBe('2026-08-11')
  })

  it('returns null rather than guess which number is the month when there is no date hint', () => {
    const p = profileFor({ ...LEARNED, hints: { decimal: ',', currencyDefault: 'RSD' } })

    expect(applyProfile(p, { ...RAW, 'di.InvoiceDate': '03/04/2026' })).toBeNull()
  })

  it('applies the vendor default currency', () => {
    const p = profileFor({ ...LEARNED, hints: { ...LEARNED.hints, currencyDefault: 'EUR' } })

    expect(applyProfile(p, RAW)?.currency).toBe('EUR')
  })

  it('leaves the currency null when the vendor has no default, rather than assuming RSD', () => {
    const p = profileFor({ ...LEARNED, hints: { dateFormat: 'DD.MM.YYYY', decimal: ',' } })

    const out = applyProfile(p, RAW)

    expect(out).not.toBeNull()
    expect(out?.currency).toBeNull()
  })

  it('leaves the currency null when the stored default is not a currency it knows', () => {
    const p = profileFor({ ...LEARNED, hints: { ...LEARNED.hints, currencyDefault: 'XYZ' } })

    expect(applyProfile(p, RAW)?.currency).toBeNull()
  })

  it('takes the vendor identity from the profile, not from the raw values', () => {
    const out = applyProfile(LEARNED, { ...RAW, 'di.VendorName': 'SOMETHING ELSE' })

    expect(out?.vendorName).toBe('OMV Srbija')
    expect(out?.vendorPib).toBe('100002593')
  })

  it('prefers a raw vendor name when the profile learned to trust one', () => {
    const p = profileFor({ ...LEARNED, trust: { ...LEARNED.trust, vendorName: 'di.VendorName' } })

    const out = applyProfile(p, { ...RAW, 'di.VendorName': 'OMV SRBIJA DOO BEOGRAD' })

    expect(out?.vendorName).toBe('OMV SRBIJA DOO BEOGRAD')
  })

  it('fills net and VAT only when the profile learned where they live', () => {
    const p = profileFor({
      ...LEARNED,
      trust: { ...LEARNED.trust, amountNet: 'di.SubTotal', vatAmount: 'di.TotalTax' },
    })

    const out = applyProfile(p, { ...RAW, 'di.SubTotal': '3.508,33', 'di.TotalTax': '701,67' })

    expect(out?.amountNet).toBe(3508.33)
    expect(out?.vatAmount).toBe(701.67)
  })

  it('returns no line items, because a profile cannot learn them', () => {
    const out = applyProfile(LEARNED, RAW)

    expect(out?.lineItems).toEqual([])
  })

  it('ignores raw keys the profile never learned to trust', () => {
    const out = applyProfile(LEARNED, { ...RAW, 'di.PurchaseOrder': 'PO-9', noise: 12345 })

    expect(out).toEqual(applyProfile(LEARNED, RAW))
  })

  it('returns null when the profile has learned nothing yet', () => {
    const p = profileFor({ ...LEARNED, trust: {}, corrections: 0 })

    expect(applyProfile(p, RAW)).toBeNull()
  })

  it('returns null when there are no raw candidates at all', () => {
    expect(applyProfile(LEARNED, {})).toBeNull()
  })

  it('returns null when the trusted amount path is absent from the raw values', () => {
    expect(applyProfile(LEARNED, { 'di.InvoiceDate': '11.08.2026' })).toBeNull()
  })

  it('returns null when the trusted date path is absent from the raw values', () => {
    expect(applyProfile(LEARNED, { 'di.InvoiceTotal': '4.210,00' })).toBeNull()
  })

  it('returns null rather than guess when the trusted amount is not a number', () => {
    expect(applyProfile(LEARNED, { ...RAW, 'di.InvoiceTotal': 'vidi prilog' })).toBeNull()
  })

  it('returns null rather than guess when the trusted date does not match the vendor format', () => {
    expect(applyProfile(LEARNED, { ...RAW, 'di.InvoiceDate': 'avgust 2026' })).toBeNull()
  })

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'an empty string', value: '' },
  ])('returns null when the trusted amount path holds $label', ({ value }) => {
    expect(applyProfile(LEARNED, { ...RAW, 'di.InvoiceTotal': value })).toBeNull()
  })

  it('does not mutate the profile or the raw values it was given', () => {
    const p = profileFor({ ...LEARNED })
    const raw = { ...RAW }

    applyProfile(p, raw)

    expect(p).toEqual(profileFor({ ...LEARNED }))
    expect(raw).toEqual(RAW)
  })
})
