import type { Money, Currency } from './types.js'

// ---------------------------------------------------------------------------
// The Serbian money grammar. 02-WHATSAPP-INTERFACE.md §5.
//
// The governing rule: the deterministic parser either returns a confident
// amount or returns nothing. Every branch below that cannot decide between two
// readings returns null rather than picking one.
//
// The currency table below is local on purpose and stays that way — an owner
// ruling, not an oversight. nlu/synonyms.ts owns the shared `resolveCurrency`,
// whose signature takes an optional *learned* SynonymTable. Delegating to it
// would put the grammar one accidental argument away from resolving an amount
// through learned data. What this module returns is authoritative and a model
// may never overwrite it (02 §5.1), so it may not drift with anything learned.
// The cost is a duplicated closed ISO set; that cost is accepted knowingly.
// ---------------------------------------------------------------------------

/**
 * normalized token -> currency. A closed lookup, never a fuzzy match.
 *
 * Deliberately independent of nlu/synonyms.ts (see above). If you are here to
 * DRY these two tables together: that was considered and rejected by the owner.
 */
const CURRENCY_TOKENS: Record<string, Currency> = {
  // EUR
  eur: 'EUR',
  e: 'EUR',
  '€': 'EUR',
  evra: 'EUR',
  evro: 'EUR',
  eura: 'EUR',
  // RSD
  rsd: 'RSD',
  din: 'RSD',
  dinara: 'RSD',
  // the remaining ISO codes types.ts allows
  usd: 'USD',
  chf: 'CHF',
  gbp: 'GBP',
}

/** ISO-4217-shaped token -> currency, or null. Lookup only: a typo is not a synonym. */
function currencyOf(token: string): Currency | null {
  return CURRENCY_TOKENS[token.trim().toLowerCase()] ?? null
}

/** A digit run is a thousands group only at exactly three digits. */
function isThousandsGrouped(parts: string[]): boolean {
  const head = parts[0]
  if (head === undefined || head.length < 1 || head.length > 3) return false
  return parts.slice(1).every((p) => p.length === 3)
}

/**
 * The integer side of a number: either one plain digit run, or dot-separated
 * thousands groups. "4.210" is 4210; "4.21" and "1.2345" have no reading.
 */
function readInteger(text: string): string | null {
  const parts = text.split('.')
  if (parts.length === 1) return text
  if (!isThousandsGrouped(parts)) return null
  return parts.join('')
}

/**
 * Read the numeric core of a token — the part that is only digits and
 * separators. Comma is always the decimal separator; a dot is a thousands
 * separator when it precedes exactly three digits and a decimal point when it
 * precedes one or two and stands alone.
 */
function parseNumeric(text: string): number | null {
  // Separators must be single and must sit between digits.
  if (!/^\d+(?:[.,]\d+)*$/.test(text)) return null

  const commaParts = text.split(',')
  if (commaParts.length > 2) return null

  let intText: string
  let decText = ''

  if (commaParts.length === 2) {
    const [before, after] = commaParts
    if (before === undefined || after === undefined) return null
    // A comma is the decimal separator, so it is the last separator there is.
    if (after.includes('.')) return null
    if (after.length > 2) return null
    const intPart = readInteger(before)
    if (intPart === null) return null
    intText = intPart
    decText = after
  } else {
    const dotParts = text.split('.')
    if (dotParts.length === 1) {
      intText = text
    } else if (isThousandsGrouped(dotParts)) {
      intText = dotParts.join('')
    } else if (dotParts.length === 2) {
      // The thousands reading failed, so the lone dot can only be a decimal
      // point — and only over one or two digits.
      const [before, after] = dotParts
      if (before === undefined || after === undefined) return null
      if (after.length > 2) return null
      intText = before
      decText = after
    } else {
      return null
    }
  }

  // Rebuild the canonical decimal literal so the double is the one the written
  // digits name, rather than the product of an arithmetic round trip.
  return Number(decText === '' ? intText : `${intText}.${decText}`)
}

interface AmountToken {
  amount: number
  /** the currency written on the token itself, null when it carries none */
  currency: Currency | null
}

/**
 * Read one whitespace-delimited token as an amount: an optional currency
 * symbol, the digits, an optional "k", an optional currency word.
 */
function parseAmountToken(token: string): AmountToken | null {
  const match = /^(€?)(\d[\d.,]*)([A-Za-z€]*)$/.exec(token)
  if (match === null) return null

  const prefix = match[1] ?? ''
  const digits = match[2] ?? ''
  const suffix = match[3] ?? ''

  const value = parseNumeric(digits)
  if (value === null) return null

  let currency: Currency | null = prefix === '' ? null : currencyOf(prefix)
  let multiplier = 1

  if (suffix !== '') {
    const written = currencyOf(suffix)
    if (written !== null) {
      // "€300e" would name the currency twice; two markers are a conflict.
      if (currency !== null) return null
      currency = written
    } else if (/^k$/i.test(suffix)) {
      multiplier = 1000
    } else {
      return null
    }
  }

  return { amount: value * multiplier, currency }
}

/**
 * Parse a human-written amount. Serbian conventions: "." thousands, "," decimals.
 * Returns null when the input is absent or genuinely ambiguous — NEVER a half-guess.
 * A returned value is authoritative and may not be overridden by a model (02 §5.1).
 *
 * Handles at minimum: 4210 | 4.210,00 | 4210.50 | 300e | 300€ | "300 eur" |
 * "300 EVRA" | 1500din | "1.500 rsd" | 12k
 */
export function parseAmount(input: string, defaultCurrency?: Currency): Money | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return null

  const tokens = trimmed.split(/\s+/)
  const head = tokens[0]
  if (head === undefined) return null

  const opening = parseAmountToken(head)
  if (opening !== null) {
    // The message opens with the number, so the message *is* an amount: the
    // only thing allowed to follow it is the currency it is written in.
    // "300 zlatnika" and "300 400" are refusals, not amounts with noise.
    //
    // The asymmetry with the branch below is DELIBERATE and owner-approved:
    // "800 parking" is null while "/cash 800 parking" is 800 RSD. Position is
    // the whole signal — a message that opens with a label or a command is
    // prose with an amount in it, and a message that opens with the number is
    // an amount expression, where an unrecognised trailing word can only be a
    // unit the table does not know. Do not "fix" this into one lenient rule:
    // it would make "300 zlatnika" parse as 300 RSD, which the suite refuses.
    if (tokens.length === 1) return finish(opening, defaultCurrency)
    if (tokens.length === 2 && opening.currency === null) {
      const tail = tokens[1]
      const written = tail === undefined ? null : currencyOf(tail)
      if (written !== null) return finish({ amount: opening.amount, currency: written }, defaultCurrency)
    }
    return null
  }

  // Otherwise the amount is embedded in a real message ("/cash 800 parking"):
  // words around it are description, but a second candidate amount, or a
  // currency word left hanging, is a conflict and gets asked about (02 §5.1).
  const marked: AmountToken[] = []
  const bare: AmountToken[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === undefined) continue

    const parsed = parseAmountToken(token)
    if (parsed === null) {
      // A currency word that no number claimed leaves the currency in doubt.
      if (currencyOf(token) !== null) return null
      continue
    }

    if (parsed.currency !== null) {
      marked.push(parsed)
      continue
    }

    const next = tokens[index]
    const attached = next === undefined ? null : currencyOf(next)
    if (attached !== null) {
      index += 1
      marked.push({ amount: parsed.amount, currency: attached })
    } else {
      bare.push(parsed)
    }
  }

  // A written currency outranks a bare number; two of either is a question.
  const candidates = marked.length > 0 ? marked : bare
  if (candidates.length !== 1) return null
  const only = candidates[0]
  if (only === undefined) return null
  return finish(only, defaultCurrency)
}

/** Stamp the default currency and refuse a zero — absence is null, never 0. */
function finish(token: AmountToken, defaultCurrency?: Currency): Money | null {
  if (token.amount === 0) return null
  return { amount: token.amount, currency: token.currency ?? defaultCurrency ?? 'RSD' }
}

/** Format for display, Serbian locale, always 2 decimals. 4210 -> "4.210,00" */
export function formatAmount(amount: number): string {
  // Owner ruling: NaN and ±Infinity format as the ordinary zero string. This
  // is a display function on a receipt line, and throwing there would take
  // down a message that is otherwise fine — that alternative was considered
  // and rejected. Nothing in the frozen suite constrains this case. Note that
  // a zero *amount* still never reaches here as a parse result: parseAmount
  // refuses zero outright, because absence is null and never a zero (types.ts).
  if (!Number.isFinite(amount)) return formatAmount(0)

  const rounded = round2(amount)
  const negative = rounded < 0
  const fixed = Math.abs(rounded).toFixed(2)
  const dot = fixed.indexOf('.')
  const digits = fixed.slice(0, dot)
  const decimals = fixed.slice(dot + 1)

  let grouped = ''
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i
    if (i > 0 && fromEnd % 3 === 0) grouped += '.'
    grouped += digits[i]
  }

  return `${negative ? '-' : ''}${grouped},${decimals}`
}

/** Round half-up to 2 decimals. Applied per invoice, not per line. */
export function round2(n: number): number {
  // An integer (which includes every double too large to hold a fraction) and
  // a non-finite value are already their own answer.
  if (Number.isInteger(n)) return n

  const abs = Math.abs(n)
  // Below 1e-6 the default string form is exponential; toFixed is not.
  const text = abs < 1e-6 ? abs.toFixed(20) : String(abs)
  const dot = text.indexOf('.')
  if (dot === -1) return n

  const decimals = text.slice(dot + 1)
  if (decimals.length <= 2) return n

  // Half-up on the value as written: the shortest decimal that names this
  // double, not its binary expansion. That is what makes 1.005 -> 1.01.
  const kept = Number(text.slice(0, dot) + decimals.slice(0, 2))
  const next = decimals.charCodeAt(2) - 48
  const scaled = next >= 5 ? kept + 1 : kept

  return (n < 0 ? -scaled : scaled) / 100
}

/** Convert with an explicit rate. Returns null if the rate is missing or non-positive. */
export function toRsd(money: Money, rate: number | null): number | null {
  if (rate === null) return null
  if (!Number.isFinite(rate) || rate <= 0) return null
  return round2(money.amount * rate)
}
