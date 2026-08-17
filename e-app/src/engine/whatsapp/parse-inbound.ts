/**
 * PLACEHOLDER — the inbound WhatsApp webhook body parser. Milestone M1, and
 * test #1 in that milestone's test-first order (07-ROADMAP.md §M1).
 *
 * BLOCKED ON: fixture F7 — real webhook bodies for `image` and `document`.
 * Meta's payload nesting is not something to reconstruct from documentation;
 * F7 costs one photo once the webhook logs raw bodies, which makes it the
 * second-cheapest unblock in the project after F10.
 *
 * The roadmap is explicit that the eventual test file must cover every type
 * INCLUDING one E does not support — the unsupported-type reply is a real
 * branch, not an afterthought.
 *
 * Placement note: 01-ARCHITECTURE §4 lists only adapters/whatsapp/*, but
 * parsing a webhook body is pure — no fetch, no clock, no randomness — so it
 * belongs in engine. The adapter half (sender, media, signature, template)
 * stays in adapters/.
 */

export type InboundKind = 'text' | 'image' | 'document' | 'button' | 'list' | 'unsupported'

export interface InboundMessage {
  kind: InboundKind
  /** Meta's message id — the idempotency key for the whole pipeline. */
  messageId: string
  from: string
  /** Body text, or the caption on an image/document. Null when there is none. */
  text: string | null
  /** Media id to resolve through adapters/whatsapp/media.ts. Null for text. */
  mediaId: string | null
  mimeType: string | null
  filename: string | null
  /** Payload of a tapped button or selected list row. */
  replyPayload: string | null
}

/**
 * Parse a raw webhook body into a message.
 *
 * Takes `unknown` by design: this is a trust boundary, and the body is
 * narrowed here rather than assumed. Returns null for a body carrying no user
 * message at all (status callbacks, delivery receipts) so the webhook can
 * answer 200 and stay silent. A recognised message of a type E does not
 * support returns `kind: 'unsupported'` — which is a reply, not silence.
 */
export function parseInboundMessage(_body: unknown): InboundMessage | null {
  throw new Error('not implemented')
}
