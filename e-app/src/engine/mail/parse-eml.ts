import type { MailEnvelope } from './route.js'

/**
 * PLACEHOLDER — MIME → envelope + attachments (01-ARCHITECTURE §4).
 * Milestones M2 (bank notification emails) and M6 (`Izvod po tekucem racunu…`).
 *
 * BLOCKED ON: fixtures F5 (2–3 real bank notification emails as `.eml`) and
 * F9 (one real `Izvod po tekucem racunu…` email). Subject matching has to be
 * exact against what the bank actually sends, including how it encodes
 * Serbian diacritics in the Subject header — which is precisely the detail
 * that cannot be guessed.
 *
 * Core does not read the network or the filesystem. The IMAP adapter fetches
 * and pre-parses; this module interprets the already-parsed structure, so the
 * whole mail path stays testable from `.eml` fixtures alone (D3, D4).
 */

/** An already-decoded attachment handed over by the mail adapter. */
export interface MailAttachment {
  filename: string
  mimeType: string
  bytes: Uint8Array
}

/** The parsed shape the adapter produces; header names arrive lowercased. */
export interface ParsedMime {
  headers: Record<string, string>
  attachments: MailAttachment[]
}

/**
 * Build a routing envelope from parsed MIME headers.
 * Returns null when the required headers are absent — E routes such a message
 * to E/Failed rather than guessing a book (see route()).
 */
export function toEnvelope(_mime: ParsedMime): MailEnvelope | null {
  throw new Error('not implemented')
}

/**
 * The attachments worth ingesting, in the order they appeared.
 * Inline images, signatures and tracking pixels are dropped here rather than
 * downstream, so `mailEventKey(messageId, index)` indexes a stable list.
 */
export function ingestableAttachments(_mime: ParsedMime): MailAttachment[] {
  throw new Error('not implemented')
}
