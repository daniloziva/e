import type { BookCode, DocCategory } from '../types.js'

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

/**
 * First matching rule wins, ordered by priority. Matching is normalized
 * (lowercase, diacritics stripped, whitespace collapsed).
 * No match -> null, which routes the message to E/Failed. E never guesses.
 */
export function route(_envelope: MailEnvelope, _rules: MailRule[]): RouteResult | null {
  throw new Error('not implemented')
}

/** Idempotency key for one attachment of one message. */
export function mailEventKey(_messageId: string, _attachmentIndex: number): string {
  throw new Error('not implemented')
}

