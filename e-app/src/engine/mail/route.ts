import { createHash } from 'node:crypto'

import type { BookCode, DocCategory } from '../types.js'
import { normalize } from '../nlu/synonyms.js'

export interface MailRule {
  id: string
  fromPattern?: string          // normalized substring match on the sender
  subjectPattern: string        // normalized prefix or substring
  matchType: 'prefix' | 'contains' | 'exact'
  book: BookCode
  category: DocCategory
  priority: number              // lower runs first
}

export interface MailEnvelope {
  messageId: string
  from: string
  subject: string
  receivedAt: string
}

export interface RouteResult {
  book: BookCode
  category: DocCategory
  ruleId: string
}

// ---------------------------------------------------------------------------
// Email routing — 03-DILIGAF §1, 04-PERSONAL §2, 05-SMOQUA §3d.
//
// Two untrusted inputs meet here. The envelope comes off a mail server, so
// every header is attacker-supplied; the rules come out of `_state` JSON, so
// they were never checked by the type system either. Neither is trusted:
// anything that is not a well-formed rule is dropped rather than half-applied,
// and no match at all is a REFUSAL (null -> E/Failed), never a default book.
// ---------------------------------------------------------------------------

/** The closed set of books a rule may name. */
const BOOK_CODES = ['DILIGAF', 'PERSONAL', 'SMOQUA'] as const satisfies readonly BookCode[]

/** The closed set of categories a rule may name. */
const DOC_CATEGORIES = [
  'izvod',
  'statement',
  'expense',
  'invoice_out',
  'sef_inbound',
  'other',
] as const satisfies readonly DocCategory[]

// Compile-time guard: adding a BookCode / DocCategory to types.ts without
// adding it to the list above makes these aliases `never` and typecheck fails,
// so the allow-lists cannot silently drift out of date.
type _AllBooksListed = Exclude<BookCode, (typeof BOOK_CODES)[number]> extends never ? true : never
type _AllCategoriesListed =
  Exclude<DocCategory, (typeof DOC_CATEGORIES)[number]> extends never ? true : never
const _BOOKS_LISTED: _AllBooksListed = true
const _CATEGORIES_LISTED: _AllCategoriesListed = true

const MATCH_TYPES = ['prefix', 'contains', 'exact'] as const satisfies readonly MailRule['matchType'][]

const BOOK_SET: ReadonlySet<string> = new Set<string>(BOOK_CODES)
const CATEGORY_SET: ReadonlySet<string> = new Set<string>(DOC_CATEGORIES)
const MATCH_TYPE_SET: ReadonlySet<string> = new Set<string>(MATCH_TYPES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'

/** A header that is absent or of the wrong runtime type reads as empty text. */
function text(value: unknown): string {
  return isString(value) ? value : ''
}

/**
 * A rule as it survives validation: the fields the decision is made from, all
 * already normalized, plus the ordering key.
 *
 * `subjectPattern` is normalized ONCE here and the subject is normalized once
 * per call, so both sides of every comparison always went through the same
 * normalizer (nlu/synonyms) — a table written `Izvod po tekućem računu` and a
 * subject written `IZVOD PO TEKUCEM RACUNU` meet in the middle.
 */
interface UsableRule {
  id: string
  subjectPattern: string
  fromPattern: string
  matchType: MailRule['matchType']
  book: BookCode
  category: DocCategory
  priority: number
  /** declaration index, so a priority tie is broken by table order */
  order: number
}

/**
 * Validate one caller-supplied rule.
 *
 * Rejected (rule dropped, never partly applied):
 *  - anything that is not an object;
 *  - a non-string or blank `id` — a routing decision that cannot name the row
 *    that made it is not auditable;
 *  - a non-string `subjectPattern`. This is deliberate and NOT incidental: a
 *    JSON number would otherwise be coerced to text by `String()`/`.test()` and
 *    match, which is exactly the defect another module in this codebase shipped;
 *  - a `subjectPattern` that normalizes to empty — it would match everything;
 *  - an unknown `matchType`. Guessing which comparison an unrecognized type
 *    meant is precisely the guess this module refuses to make;
 *  - a `fromPattern` that is present but not a string. Reading a malformed
 *    sender constraint as "no constraint" would WIDEN a rule the operator wrote
 *    to narrow it, so the rule is dropped instead;
 *  - a `book` or `category` outside the closed sets in types.ts.
 *
 * Tolerated: a non-finite `priority` sorts last (see `orderingPriority`).
 */
function toUsableRule(value: unknown, order: number): UsableRule | null {
  if (!isRecord(value)) return null

  const id = value['id']
  if (!isString(id) || id.trim() === '') return null

  const rawSubject = value['subjectPattern']
  if (!isString(rawSubject)) return null
  const subjectPattern = normalize(rawSubject)
  if (subjectPattern === '') return null

  const matchType = value['matchType']
  if (!isString(matchType) || !MATCH_TYPE_SET.has(matchType)) return null

  const rawFromPattern = value['fromPattern']
  if (rawFromPattern !== undefined && rawFromPattern !== null && !isString(rawFromPattern)) return null
  // Kept as written — normalize() would strip the '<' '>' anchors and the
  // '@' that give a pattern its shape. senderMatches folds it instead.
  const fromPattern = text(rawFromPattern).trim()

  const book = value['book']
  if (!isString(book) || !BOOK_SET.has(book)) return null

  const category = value['category']
  if (!isString(category) || !CATEGORY_SET.has(category)) return null

  return {
    id,
    subjectPattern,
    fromPattern,
    // Narrowed by the closed-set checks above; the sets are built from the
    // literal unions themselves, so these casts cannot widen the domain.
    matchType: matchType as MailRule['matchType'],
    book: book as BookCode,
    category: category as DocCategory,
    priority: orderingPriority(value['priority']),
    order,
  }
}

/**
 * A rule with a missing or non-finite priority still routes — priority only
 * says WHEN a rule is considered, not WHAT it decides — but it is considered
 * last, deterministically, rather than at an arbitrary point in the table.
 */
function orderingPriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/**
 * Never subtract: `Infinity - Infinity` is NaN, and a comparator that returns
 * NaN hands V8 an implementation-defined order. Compare, then fall back to the
 * declaration index so the ordering is total and stable.
 */
function byPriorityThenDeclaration(a: UsableRule, b: UsableRule): number {
  if (a.priority < b.priority) return -1
  if (a.priority > b.priority) return 1
  return a.order - b.order
}

function subjectMatches(rule: UsableRule, subject: string): boolean {
  switch (rule.matchType) {
    case 'prefix':
      // Prefix means prefix: no implicit word boundary is imposed, so
      // "e:expenses za jul" matches the pattern "e:expense".
      return subject.startsWith(rule.subjectPattern)
    case 'contains':
      return subject.includes(rule.subjectPattern)
    case 'exact':
      return subject === rule.subjectPattern
  }
}

/**
 * First matching rule wins, ordered by priority. Matching is normalized
 * (lowercase, diacritics stripped, whitespace collapsed).
 * No match -> null, which routes the message to E/Failed. E never guesses.
 */

/**
 * Sender text, folded for comparison — lowercase and whitespace-collapsed, and
 * DELIBERATELY NOT diacritic-folded.
 *
 * The shared `normalize` strips diacritics, which is right for Serbian subject
 * lines and wrong for an address: it folds `izvodí@banka-doo.rs` onto
 * `izvodi@banka-doo.rs`, collapsing a homoglyph address onto the real one.
 */
function foldSender(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The address a header actually came from, as opposed to what it claims to say.
 *
 * A `From` header is `Display Name <addr@host>`, and the display name is chosen
 * by the sender — anyone who can email the mailbox. Matching against the whole
 * header lets `"izvodi@banka-doo.rs" <attacker@evil.example>` satisfy a rule
 * written for the bank. Take the text inside the LAST angle-bracket pair; fall
 * back to the whole header when there is none.
 */
function senderAddress(rawFrom: string): string {
  const close = rawFrom.lastIndexOf('>')
  const open = close === -1 ? -1 : rawFrom.lastIndexOf('<', close)
  const inner = open === -1 ? '' : rawFrom.slice(open + 1, close).trim()
  return foldSender(inner === '' ? rawFrom : inner)
}

/**
 * Does the sender satisfy this rule's pattern?
 *
 *   `<addr>`   exact address — the anchored form, and the one to prefer in
 *              _state; nothing a sender controls can widen it
 *   `@domain`  suffix — matches the domain and refuses `…@domain.evil.example`
 *   bare       substring — the permissive legacy shape, kept because the frozen
 *              suite pins it
 */
function senderMatches(pattern: string, rawFrom: string): boolean {
  if (pattern === '') return true
  const address = senderAddress(rawFrom)
  const wanted = foldSender(pattern)

  if (wanted.startsWith('<') && wanted.endsWith('>') && wanted.length > 2) {
    return address === wanted.slice(1, -1).trim()
  }
  if (wanted.startsWith('@')) return address.endsWith(wanted)
  return address.includes(wanted)
}

export function route(envelope: MailEnvelope, rules: MailRule[]): RouteResult | null {
  if (!Array.isArray(rules) || rules.length === 0) return null

  const source: unknown = envelope
  const headers = isRecord(source) ? source : {}
  const subject = normalize(text(headers['subject']))
  // Raw, not normalized: senderMatches does its own folding, deliberately
  // without diacritic stripping. See foldSender.
  const rawFrom = text(headers['from'])

  // Validation builds a NEW array of new objects: the caller's rules array is
  // never sorted in place, and no rule object it holds is ever mutated.
  const ordered: UsableRule[] = []
  for (const [index, rule] of rules.entries()) {
    const usable = toUsableRule(rule, index)
    if (usable !== null) ordered.push(usable)
  }
  ordered.sort(byPriorityThenDeclaration)

  for (const rule of ordered) {
    // A sender-scoped rule that does not match the sender falls through to the
    // next rule; it never widens into a subject-only rule.
    if (!senderMatches(rule.fromPattern, rawFrom)) continue
    if (!subjectMatches(rule, subject)) continue
    return { book: rule.book, category: rule.category, ruleId: rule.id }
  }

  return null
}

/**
 * Idempotency key for one attachment of one message.
 *
 * `sha256(messageId)` in base64url, then `:` and the attachment index —
 * `_index/event/mail/{hash}:{idx}`.
 *
 * The message id is a `Message-ID` header, i.e. attacker-controlled text:
 * anyone who can send mail can choose it. Two properties therefore have to
 * hold at once, and hashing is what delivers both.
 *
 *  - PATH SAFETY. The output alphabet is fixed by base64url — `[A-Za-z0-9_-]`
 *    plus the single `:` separator and decimal digits for the index. No `/`,
 *    no `.`, no `\`, no NUL, no whitespace, no non-ASCII can appear no matter
 *    what arrives, because none of the input's own bytes survive into the
 *    output; only the digest of them does. `../../secret/` cannot escape the
 *    directory it names because the key is not built from the id's characters.
 *  - COLLISION RESISTANCE. Distinct ids give distinct keys under SHA-256's
 *    collision resistance, and the id is hashed RAW — no trimming, no case
 *    folding, no normalization — so `<a@x>` and `< a@x >` stay two messages,
 *    as RFC 5322 requires (Message-ID is case-sensitive and compared literally).
 *    The digest is fixed-length (43 base64url chars), so `hash:index` parses
 *    unambiguously and no (id, index) pair can be confused with another:
 *    `("a", 12)` and `("a1", 2)` differ in the digest, not merely in the tail.
 *
 * An unusable input throws rather than degrading to a placeholder key: a key
 * built from nothing would be shared by every unidentifiable message, and this
 * key is what decides "already processed" — a collision here silently DROPS a
 * real attachment. Failing loudly is the cheaper failure.
 */
export function mailEventKey(messageId: string, attachmentIndex: number): string {
  if (!isString(messageId) || messageId.trim() === '') {
    throw new Error(
      'mailEventKey: messageId must be a non-empty string — an unidentifiable message cannot be made idempotent',
    )
  }
  if (
    typeof attachmentIndex !== 'number' ||
    !Number.isSafeInteger(attachmentIndex) ||
    attachmentIndex < 0
  ) {
    throw new Error(
      `mailEventKey: attachmentIndex must be a non-negative safe integer, received ${String(attachmentIndex)}`,
    )
  }

  const digest = createHash('sha256').update(messageId, 'utf8').digest('base64url')
  return `${digest}:${attachmentIndex}`
}
