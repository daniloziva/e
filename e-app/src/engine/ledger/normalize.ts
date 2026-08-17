import { round2 } from '../money.js'
import type { BookCode, Currency, Transaction, TxDirection } from '../types.js'

export interface RawTransaction {
  txDate: string
  valueDate: string | null
  description: string
  amount: number
  currency: string
  balanceAfter: number | null
}

// ---------------------------------------------------------------------------
// Statement line -> ledger identity. 04-PERSONAL.md §2.
//
// Everything here runs on values that arrived from a parsed statement or from
// JSON in blob storage, so every field is re-checked at runtime even where the
// declared type already promises a string. A previous module shipped a defect
// where RegExp.test() coerced a JSON number past a string-only rule; the guards
// below are `typeof` checks for exactly that reason.
// ---------------------------------------------------------------------------

const CURRENCIES: readonly string[] = ['RSD', 'EUR', 'USD', 'CHF', 'GBP']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && CURRENCIES.includes(value)
}

/** A field off a value that only claims to be a record. Missing is `undefined`, never a throw. */
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

/** A string, or the empty string. Never `String(x)` — a number is not a date. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The canonical 2dp decimal form of a number, or '' when there is no number.
 *
 * Canonical rather than `String(n)` so that two parsers writing the same money
 * as 1890 and 1890.0 produce one identity. Absence and garbage share the empty
 * form: a NaN balance tells us exactly as much as a missing one, which is
 * nothing, and both must still dedupe a re-sent statement against itself.
 */
function asNumberText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return round2(value).toFixed(2)
}

/**
 * Direction is derived from the sign and never stored independently, so a
 * corrected amount cannot leave a transaction pointing the wrong way.
 *
 * Zero has no direction to read. It is reported as an outflow because a
 * zero-value row in a spend ledger is a fee reversal or a placeholder far more
 * often than it is income, and `direction` has no third state to express the
 * doubt. Nothing in the frozen suite constrains it.
 */
export function directionOf(amount: number): TxDirection {
  return typeof amount === 'number' && amount > 0 ? 'in' : 'out'
}

// ===========================================================================
// dedupeKey
// ===========================================================================

/**
 * Stable dedupe identity: sha256(book | txDate | valueDate | amount | currency
 * | normalize(description) | balanceAfter), with the digest function injected
 * so the engine stays pure and the material stays inspectable in tests.
 *
 * The fields are joined positionally with a separator that cannot occur in any
 * of them (the normalized description is letters, digits and single spaces), so
 * a transaction date and a value date that swap places produce different keys
 * rather than the same concatenation.
 *
 * balanceAfter is in the identity because it is the only thing that tells two
 * genuinely identical same-day charges apart. Its accepted limitation: when the
 * bank reports no running balance those two rows collapse into one. That is the
 * deliberate trade — a re-sent statement must dedupe against itself, and losing
 * a duplicate charge is recoverable where duplicating every line is not.
 */
export function dedupeKey(book: BookCode, raw: RawTransaction, hash: (s: string) => string): string {
  const material = [
    asText(book),
    asText(field(raw, 'txDate')),
    asText(field(raw, 'valueDate')),
    asNumberText(field(raw, 'amount')),
    asText(field(raw, 'currency')),
    normalizeDescription(asText(field(raw, 'description'))),
    asNumberText(field(raw, 'balanceAfter')),
  ].join('|')

  return hash(material)
}

// ===========================================================================
// normalizeDescription
// ===========================================================================

/**
 * Serbian diacritics down to the bare letter. NFD splits "ć" into "c" plus a
 * combining mark, which is then dropped; "đ" has no decomposition of its own
 * and is mapped explicitly to a bare "d" — the same rule vendor-profile.ts
 * follows, so a merchant keys identically in both places.
 */
function foldDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
}

/**
 * The volatile tokens — the parts of a bank descriptor that change between two
 * statements describing the SAME charge. Applied in this order: the shapes that
 * contain their own punctuation must be recognised before punctuation is
 * flattened to spaces.
 *
 * The governing rule, pinned by the frozen suite from both sides: digits are
 * volatile when they follow a marker (POS / TERM / REF / RRN), or when they
 * form a date or a time. Digits standing on their own are part of the merchant
 * name — "MAXI 011" and "MAXI 022" are two branches and must stay two strings.
 */
const VOLATILE: readonly RegExp[] = [
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, //            09:14, 09:14:32
  /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b\.?/g, //        11.08.2026, 4.7.26.
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g, //               2026-08-11
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, //           04/07/26
  /\b(?:TERMINAL|TERM|POS|REF|RRN)\b[\s:#-]*\d*/g, // POS 4738, TERM 00123, REF:000123456789
  /[*X#]{2,}[\s-]*\d+/g, //                      **** 1234, ****1234, XXXX-5678
]

/**
 * A descriptor reduced to the part that identifies the merchant: upper case,
 * diacritics folded, volatile tokens removed, punctuation flattened, whitespace
 * collapsed.
 *
 * Idempotent by construction — the output contains no punctuation, no marker
 * and no date, so a second pass has nothing left to strip. That property is
 * load-bearing: a categorisation rule is derived from a normalized description
 * and must still match one.
 */
export function normalizeDescription(description: string): string {
  if (typeof description !== 'string') return ''

  let text = foldDiacritics(description.toUpperCase())
  for (const pattern of VOLATILE) text = text.replace(pattern, ' ')

  return text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ===========================================================================
// extractCounterparty
// ===========================================================================

/**
 * Bank verbs, prepositions and legal-form suffixes: words that appear in a
 * descriptor without naming anybody. A closed list, never a fuzzy rule — an
 * unrecognised word is a merchant name, which is the safe direction to fail in.
 */
const NOISE = new Set([
  'KUPOVINA', 'PLACANJE', 'PLACENO', 'UPLATA', 'ISPLATA', 'PRENOS', 'TRANSAKCIJA',
  'NAKNADA', 'PROVIZIJA', 'IZVOD', 'RACUN', 'RACUNU', 'TEKUCEM', 'OD', 'ZA', 'PO',
  'NA', 'DOO', 'AD', 'PR', 'SZR', 'STR',
])

/**
 * The merchant name a descriptor carries, or null.
 *
 * The first token that survives normalisation, is not bank boilerplate and
 * holds at least one letter. A single token rather than the whole remainder:
 * "WOLT BEOGRAD" names WOLT in Belgrade, and the city is not part of who was
 * paid. A descriptor with nothing but digits, markers and punctuation in it
 * returns null — no merchant is better than a guessed one (05-SMOQUA §3a).
 */
export function extractCounterparty(description: string): string | null {
  const normalized = normalizeDescription(description)
  if (normalized === '') return null

  for (const token of normalized.split(' ')) {
    if (token.length < 2) continue
    if (NOISE.has(token)) continue
    if (!/\p{L}/u.test(token)) continue
    return token
  }

  return null
}

// ===========================================================================
// toTransaction
// ===========================================================================

/**
 * A parsed statement line as a ledger transaction. Identity (id, dedupeKey) and
 * time (createdAt) are injected — this module reads neither a clock nor a
 * random source.
 *
 * The transaction starts in MISC with no dimensions: categorisation is a
 * separate, reviewable step, and inventing a category here would put a guess
 * where the accountant package expects a decision.
 */
export function toTransaction(
  raw: RawTransaction,
  book: BookCode,
  id: string,
  dedupeKeyValue: string,
  createdAt: string,
): Transaction {
  const description = asText(field(raw, 'description'))
  const amountValue = field(raw, 'amount')
  const amount = typeof amountValue === 'number' && Number.isFinite(amountValue) ? amountValue : 0
  const currencyValue = field(raw, 'currency')

  // The statement's own currency label is preserved rather than replaced by a
  // guess when it is not one this workspace knows. `as Currency` is deliberate:
  // amountRsd below keys off the literal 'RSD' and nothing else, so an
  // unrecognised code can never be mistaken for dinars — it only means the
  // amount stays un-converted until a rate is supplied.
  const currency: Currency = isCurrency(currencyValue)
    ? currencyValue
    : (asText(currencyValue) as Currency)

  const valueDateValue = field(raw, 'valueDate')

  return {
    id,
    book,
    txDate: asText(field(raw, 'txDate')),
    valueDate: typeof valueDateValue === 'string' ? valueDateValue : null,
    description,
    counterparty: extractCounterparty(description),
    amount,
    currency,
    // No rate is supplied here, so only an amount already in dinars has an RSD
    // value. A foreign line stays null rather than carrying its face value into
    // a total that is denominated in dinars.
    amountRsd: currency === 'RSD' ? amount : null,
    direction: directionOf(amount),
    category: 'MISC',
    dimensions: {},
    source: 'statement',
    sourceDocument: null,
    dedupeKey: dedupeKeyValue,
    // 'ok' rather than 'needs_review': an imported statement line is not itself
    // suspect, and flagging every one of them would drown the review queue the
    // month a statement lands. What needs review is decided downstream, by the
    // categoriser that could not place it. Nothing in the frozen suite pins it.
    reviewStatus: 'ok',
    createdAt,
  }
}
