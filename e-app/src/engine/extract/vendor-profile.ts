import type { Currency, ExtractedFacts } from '../types.js'

/**
 * Candidate values keyed by their ATOMIC source label:
 *   { 'di.InvoiceTotal': '4.210,00', 'qr.total': 4210, 'pdf.regex.ukupno': '4210' }
 *
 * The dots are part of the key — NEVER a path to walk into nested objects.
 * Adapters flatten their own wire shapes into this before engine sees them, so
 * engine never learns any provider's response tree. Trust labels follow the
 * convention `{rung}.{field}`: documented, but never parsed.
 *
 * This is a security boundary, not only a style choice. Trust labels come from
 * `_state/vendor-profiles.json`, which `/tebra` can propose edits to (09-TEBRA
 * §3), so treating one as a path would turn `__proto__.polluted` into a write
 * into Object.prototype. A flat lookup makes that an ordinary missing key.
 */
export type RawCandidates = Record<string, unknown>

export interface VendorProfile {
  vendorKey: string
  vendorName: string
  vendorPib: string | null
  /** fact field -> atomic source label that proved correct, e.g. "di.InvoiceTotal" */
  trust: Record<string, string>
  hints: { dateFormat?: string; decimal?: ',' | '.'; currencyDefault?: string }
  defaultCategory: string | null
  corrections: number
  lastSeen: string
}

// ===========================================================================
// vendorKey
// ===========================================================================

/** Exactly nine ASCII digits — the same shape validate.ts enforces on a PIB. */
const PIB_PATTERN = /^[0-9]{9}$/

/**
 * Serbian Cyrillic -> Latin, lowercase, the standard one-to-one correspondence.
 * Applied before the diacritic fold so that Ђ and Đ land on the same letter and
 * a vendor written in either script keys the same. Digraph letters (љ, њ) expand;
 * ђ and џ fold to their bare letters for the same reason Đ does (see below).
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'd', е: 'e', ж: 'z', з: 'z',
  и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c',
  ч: 'c', џ: 'dz', ш: 's',
}

/**
 * Strip diacritics down to the bare letter: NFD splits "š" into "s" + a
 * combining mark, which is then dropped. "đ" has no decomposition of its own,
 * so it is mapped explicitly — to a bare "d", not the "dj" digraph, per the
 * merge ruling recorded in the frozen suite.
 */
function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
}

/**
 * A lowercase hyphen slug: letters and digits survive, every other run of
 * characters becomes a single hyphen, and the ends are trimmed. Returns null
 * when nothing survives — a name of only punctuation names no vendor.
 *
 * Everything that could make the key unsafe as a filename or a blob segment
 * ('/', '\', '.', whitespace) is a separator here, so `_state/vendor-profiles/
 * {vendor_key}.json` cannot be steered by a vendor name.
 */
function slugifyName(name: string): string | null {
  const transliterated = Array.from(name.toLowerCase())
    .map((ch) => CYRILLIC_TO_LATIN[ch] ?? ch)
    .join('')

  const slug = foldDiacritics(transliterated)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return slug === '' ? null : slug
}

/**
 * Stable key for a vendor: PIB when known, else normalized name.
 *
 * PROVISIONAL — under review, and the only part of the frozen suite that is.
 * Identity is moving to content matching over a single `_state/vendor-profiles.json`
 * (PIB as identity, names as matchable aliases), which removes the derived-filename
 * orphaning problem entirely and may retire this function. Blocked on the NBS
 * PIB-lookup spike. See 01-ARCHITECTURE.md §5 and TEST-FREEZE.md.
 *
 * PROVISIONAL, RESTATED FOR ANYONE ABOUT TO BUILD ON IT: TEST-FREEZE.md carves
 * this function out of the freeze pending spike S-PIB. Its behaviour below is
 * exactly what the frozen cases pin and NOTHING MORE — no anticipation of the
 * PIB-based content-matching design. Do not treat the slug shape, the PIB-beats-
 * name precedence, or the very existence of this function as stable; do not
 * persist anything that would be expensive to re-key when S-PIB lands.
 */
export function vendorKey(name: string | null, pib: string | null): string | null {
  // typeof, not a bare regex test: these values arrive from `_state` JSON and
  // from model output, where a PIB can plausibly be the NUMBER 100002887.
  // RegExp.test() coerces its argument, so an unguarded test would let a number
  // through into a `string` key — the defect a previous module shipped.
  const pibText = typeof pib === 'string' ? pib.trim() : ''
  if (PIB_PATTERN.test(pibText)) return pibText

  // A PIB that is not exactly nine digits is not a PIB at all (§5 "Validation
  // and failure"), so it is discarded rather than repaired, and the name
  // carries the key. Neither one usable means no key — never an invented one.
  if (typeof name !== 'string') return null
  return slugifyName(name)
}

// ===========================================================================
// learnFromCorrection
// ===========================================================================

/** The fact fields a correction can prove a source right about. lineItems are not learnable. */
const TRUSTED_FIELDS = [
  'vendorName',
  'vendorPib',
  'docDate',
  'amountNet',
  'vatAmount',
  'amountTotal',
  'currency',
] as const

/**
 * The source label recorded when a human corrects a field.
 *
 * SPEC GAP (recorded): learnFromCorrection is not handed the raw candidates, so
 * it cannot know WHICH extractor label was right — only that the human's value
 * is. 'manual' is the only honest label available. The frozen suite requires a
 * non-empty source label and deliberately does not pin the token (2-of-3).
 */
const CORRECTION_SOURCE = 'manual'

/** A string that actually says something. '' and whitespace are absence, not a value. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() === '' ? null : value
}

/**
 * What a correction TAUGHT about one field, as opposed to what it merely restated.
 *
 * Returns null when the value is unchanged (the user left it alone, so it proves
 * nothing) or was cleared (deleting a value is not endorsing one). This is the
 * same condition that governs which fields earn a `trust` entry, applied to the
 * profile's own identity and hints so the two cannot drift apart.
 */
function learnedValue(before: string | null, after: string | null): string | null {
  if (before === after) return null
  return nonEmptyString(after)
}

/** Fold a user correction into a profile. Increments `corrections`, records what was trusted. */
export function learnFromCorrection(
  profile: VendorProfile | null,
  before: ExtractedFacts,
  after: ExtractedFacts,
  at: string,
): VendorProfile {
  if (typeof at !== 'string' || at.trim() === '') {
    throw new Error('learnFromCorrection: the correction instant is required — this module reads no clock')
  }

  // Identity as STATED by the correction — used only to key a brand-new profile,
  // which has no prior knowledge to protect. A null is silence, never an erasure.
  const statedName = nonEmptyString(after.vendorName) ?? nonEmptyString(before.vendorName)
  const statedPib = nonEmptyString(after.vendorPib) ?? nonEmptyString(before.vendorPib)

  // Identity as TAUGHT by the correction. This is the distinction that matters
  // for an existing profile, and it is the same rule `trust` already uses below.
  //
  // A user who corrects only the amount leaves every other field sitting in
  // `after` exactly as the extractor misread it. Adopting those restated values
  // overwrites the profile's canonical identity with an unconfirmed reading —
  // and for the PIB that is identity itself, on receipts that carry both the
  // seller's and the buyer's (see UNFREEZE-LOG.md). Restated is not corrected.
  const learnedName = learnedValue(before.vendorName, after.vendorName)
  const learnedPib = learnedValue(before.vendorPib, after.vendorPib)

  let key: string
  if (profile === null) {
    const derived = vendorKey(statedName, statedPib)
    if (derived === null) {
      // Refused rather than stored under a made-up key: a profile nobody can
      // find again is worse than no profile, and §5 forbids inventing a PIB.
      throw new Error(
        'learnFromCorrection: the correction carries no vendor name or PIB, so no profile can be keyed',
      )
    }
    key = derived
  } else {
    // The key NEVER moves once a profile exists — the stored file lives at
    // _state/vendor-profiles/{vendor_key}.json (§5 layer 2), so re-keying it
    // onto a newly learned PIB would orphan everything written under the old key.
    key = profile.vendorKey
  }

  // Trust, carried forward and then overwritten field by field. Built through a
  // Map and Object.fromEntries: both define own data properties, so a stored key
  // of '__proto__' stays inert data instead of reaching the prototype setter.
  const trust = new Map<string, string>()
  for (const [field, label] of Object.entries(profile?.trust ?? {})) {
    if (typeof label === 'string' && label !== '') trust.set(field, label)
  }

  for (const field of TRUSTED_FIELDS) {
    const from: string | number | null = before[field]
    const to: string | number | null = after[field]
    if (from === to) continue
    // A CLEARED field proves no source right — the user deleted a value, they
    // did not endorse one — so it teaches nothing (merge ruling, 2-of-3).
    if (to === null) continue
    trust.set(field, CORRECTION_SOURCE)
  }

  const hints: VendorProfile['hints'] = { ...profile?.hints }
  // Learned, not restated — same reasoning as the identity fields above. An
  // unchanged `after.currency` is the extractor's reading that the user simply
  // did not touch; adopting it as the vendor's default would stamp it on every
  // future document from that vendor and feed DocumentFacts.amountRsd.
  const learnedCurrency = learnedValue(before.currency, after.currency)
  if (learnedCurrency !== null) hints.currencyDefault = learnedCurrency

  const priorCorrections =
    typeof profile?.corrections === 'number' && Number.isFinite(profile.corrections) ? profile.corrections : 0

  return {
    vendorKey: key,
    // A new profile keyed on a PIB alone has no name yet; '' is the absence the
    // type allows, and the next correction that names the vendor fills it in.
    vendorName: learnedName ?? nonEmptyString(profile?.vendorName) ?? statedName ?? '',
    vendorPib: learnedPib ?? nonEmptyString(profile?.vendorPib) ?? statedPib,
    trust: Object.fromEntries(trust),
    hints,
    // Never invented from one correction (§5.1: only when unambiguous), and
    // never dropped once set.
    defaultCategory: profile?.defaultCategory ?? null,
    // A correction that changed nothing is still a correction: the human looked.
    corrections: priorCorrections + 1,
    // Stamped from the supplied instant. This module reads no clock.
    lastSeen: at,
  }
}

// ===========================================================================
// applyProfile
// ===========================================================================

/** The `Currency` union as runtime data, matched exactly — a model emits strings, not union members. */
const CURRENCIES: readonly Currency[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

function currencyOf(value: unknown): Currency | null {
  for (const currency of CURRENCIES) {
    if (value === currency) return currency
  }
  return null
}

/** A machine number: what a JSON-ish source writes when no locale is involved. */
const MACHINE_NUMBER = /^[+-]?[0-9]+(?:\.[0-9]+)?$/
/** Serbian: '.' groups thousands, ',' is the decimal point. */
const COMMA_DECIMAL = /^[+-]?(?:[0-9]+|[0-9]{1,3}(?:\.[0-9]{3})+)(?:,[0-9]+)?$/
/** Anglo: ',' groups thousands, '.' is the decimal point. */
const DOT_DECIMAL = /^[+-]?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$/

/**
 * Read an amount under the learned decimal hint. A value whose separators
 * CONTRADICT the hint is refused, not re-read under the other convention: the
 * hint is what the profile learned about this vendor's documents, and guessing
 * past it is how 4.210,00 becomes 4.21.
 *
 * No range rule is applied here — 0 and 99,000,000 both parse. Ranges belong to
 * engine/extract/validate.ts (§5 "Validation and failure").
 */
function readAmount(value: unknown, decimal: ',' | '.' | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (text === '') return null

  if (decimal === undefined) {
    return MACHINE_NUMBER.test(text) ? finiteOrNull(Number(text)) : null
  }

  const pattern = decimal === ',' ? COMMA_DECIMAL : DOT_DECIMAL
  if (!pattern.test(text)) return null

  const grouping = decimal === ',' ? '.' : ','
  const canonical = text.split(grouping).join('').replace(decimal, '.')
  return finiteOrNull(Number(canonical))
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    default:
      return isLeapYear(year) ? 29 : 28
  }
}

type DatePart = 'year' | 'month' | 'day'

interface DatePattern {
  regex: RegExp
  order: DatePart[]
}

/**
 * Compile a learned format hint ("DD.MM.YYYY", "MM/DD/YYYY", "YYYY-MM-DD") into
 * a matcher. YYYY / MM / DD are the only tokens; every other character is a
 * literal, escaped so a hint can never smuggle in a pattern of its own. A hint
 * that does not name each of the three parts exactly once is unusable.
 */
function compileDateFormat(format: string): DatePattern | null {
  const TOKENS: readonly [token: string, part: DatePart, digits: number][] = [
    ['YYYY', 'year', 4],
    ['MM', 'month', 2],
    ['DD', 'day', 2],
  ]

  let source = '^'
  const order: DatePart[] = []
  let index = 0

  while (index < format.length) {
    const token = TOKENS.find((candidate) => format.startsWith(candidate[0], index))
    if (token !== undefined) {
      source += `([0-9]{${String(token[2])}})`
      order.push(token[1])
      index += token[0].length
      continue
    }
    source += (format[index] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    index += 1
  }

  if (order.length !== 3 || new Set(order).size !== 3) return null
  return { regex: new RegExp(`${source}$`), order }
}

/**
 * Read a date under the learned format hint and re-emit it as YYYY-MM-DD.
 *
 * With no hint only an unambiguous ISO date is accepted: "11/08/2026" has two
 * readings and this layer never picks one. With a hint, the hint is the ONLY
 * reading — a value that does not match it is unreadable rather than retried as
 * ISO, because the same digits mean different days under different hints.
 *
 * Calendar correctness only (31.02, month 13, a leap day of a non-leap year).
 * The [now - 18 months, now + 2 days] window is validate.ts's rule, not this
 * module's, which is also why nothing here reads a clock.
 */
function readDate(value: unknown, format: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null

  const pattern = compileDateFormat(typeof format === 'string' && format !== '' ? format : 'YYYY-MM-DD')
  if (pattern === null) return null

  const match = pattern.regex.exec(text)
  if (match === null) return null

  const parts: Record<DatePart, string> = { year: '', month: '', day: '' }
  for (let i = 0; i < pattern.order.length; i += 1) {
    const part = pattern.order[i]
    const captured = match[i + 1]
    if (part === undefined || captured === undefined) return null
    parts[part] = captured
  }

  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)

  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * Apply a known profile's trust labels and hints to flat raw candidates.
 * Returns null when the profile cannot produce a usable total.
 *
 * Lookups are single flat reads: `raw[profile.trust[field]]`. A trust label is
 * never split, never walked, and never used to reach a prototype.
 *
 * Both sides of this function are untrusted input. The profile comes from
 * `_state/vendor-profiles.json`, which /tebra can propose edits to (09-TEBRA §3,
 * D18); the raw candidates come from whatever adapter flattened a provider
 * response. So: every label is checked to be a non-empty string, every lookup
 * goes through a Map built from OWN entries only (no prototype chain to reach,
 * no '.' to split on), and neither argument is written to.
 *
 * The refusal rule: a total is REQUIRED — without one the profile has produced
 * nothing worth having and the ladder must fall through to the next rung. A
 * date that is missing or unreadable only nulls docDate, because §5 makes a null
 * doc_date a needs_review flag downstream, i.e. a legitimate output here.
 */
export function applyProfile(profile: VendorProfile, raw: RawCandidates): ExtractedFacts | null {
  // Own enumerable entries only. A Map lookup has no prototype chain behind it,
  // so a label of '__proto__' or 'constructor' is an ordinary missing key —
  // and a dotted label is one key, never a path.
  const candidates = new Map<string, unknown>(Object.entries(raw ?? {}))

  const trust = new Map<string, string>()
  for (const [field, label] of Object.entries(profile?.trust ?? {})) {
    // An empty label addresses nothing, even when the raw candidates happen to
    // carry an '' key. It is dropped here rather than resolved.
    if (typeof label === 'string' && label !== '') trust.set(field, label)
  }

  /** The one and only way a caller-supplied label is ever used. */
  const valueFor = (field: string): unknown => {
    const label = trust.get(field)
    return label === undefined ? undefined : candidates.get(label)
  }

  const hints = profile?.hints
  const decimal = hints?.decimal === ',' || hints?.decimal === '.' ? hints.decimal : undefined
  const dateFormat = typeof hints?.dateFormat === 'string' ? hints.dateFormat : undefined

  // The total is the profile's reason to exist. No total, no answer.
  const amountTotal = readAmount(valueFor('amountTotal'), decimal)
  if (amountTotal === null) return null

  const rawName = nonEmptyString(valueFor('vendorName'))
  const rawPib = nonEmptyString(valueFor('vendorPib'))

  return {
    // The profile names the vendor unless it learned to trust a source for the
    // name — the whole point of layer 2 is not re-reading identity per document.
    vendorName: rawName ?? nonEmptyString(profile?.vendorName),
    vendorPib: rawPib ?? nonEmptyString(profile?.vendorPib),
    docDate: readDate(valueFor('docDate'), dateFormat),
    amountNet: readAmount(valueFor('amountNet'), decimal),
    vatAmount: readAmount(valueFor('vatAmount'), decimal),
    amountTotal,
    // What the document states outranks the learned default; a default that is
    // not a currency we know is no default at all.
    currency: currencyOf(valueFor('currency')) ?? currencyOf(hints?.currencyDefault),
    // A profile cannot learn line items: there is no stable label for a row.
    lineItems: [],
  }
}
