/**
 * The blob store contract — the whole of E's persistence surface.
 *
 * `01-ARCHITECTURE.md` §3 chose Blob Storage over a database because two
 * primitives were all that mattered, and both are here: `putIfAbsent` for
 * atomic create-if-absent, and `casPut` for compare-and-swap. Everything else
 * — dedupe by content hash, idempotent events, the review queue, the ledger,
 * "query by book and period" — is expressed with those two plus prefix listing.
 * That is the entire justification for the no-database design, so these are the
 * most adversarially tested methods in the codebase (`06-TDD-STRATEGY.md` §L2).
 *
 * HTTP status codes do not appear in this interface. Translating the wire into
 * domain types is the adapter's job, exactly as `di-map.ts` flattens Document
 * Intelligence's response tree so `engine/` never learns it. A 409 and a 412 are
 * both NORMAL outcomes here, not failures — see each method.
 *
 * `engine/` may never import this (eslint-enforced). `app/` receives an
 * implementation as an argument.
 */

/** Opaque. Produced by the store, echoed back to it, never parsed or compared for order. */
export type ETag = string

export interface StoredBlob {
  body: Uint8Array
  etag: ETag
}

export interface BlobStore {
  /** Unconditional write, creating or replacing. Returns the new ETag. */
  put(path: string, body: Uint8Array, contentType?: string): Promise<ETag>

  /** The blob and its current ETag, or `null` when the path holds nothing. */
  get(path: string): Promise<StoredBlob | null>

  /**
   * Every path under `prefix`, lexicographically ordered.
   *
   * This is E's only query mechanism: the path IS the index (§3). A month's
   * documents are a listing of `{book}/{YYYY}/{MM}/`, which is why a malformed
   * period makes a document unfindable rather than merely misfiled.
   */
  list(prefix: string): Promise<string[]>

  exists(path: string): Promise<boolean>

  /**
   * Create-if-absent, atomically. `PUT` with `If-None-Match: *`.
   *
   * `false` means the blob was already there — Azure's 409. That is NOT an
   * error: it is the answer this call exists to obtain. Dedupe-by-content and
   * idempotent-event both work by attempting the write and reading the refusal.
   *
   * An implementation MUST leave the existing body untouched when it returns
   * false. Overwriting would silently defeat both mechanisms.
   */
  putIfAbsent(path: string, body: Uint8Array, contentType?: string): Promise<boolean>

  /**
   * Compare-and-swap. `PUT` with `If-Match: {etag}`.
   *
   * Returns the new ETag on success, or `null` when `etag` was stale — Azure's
   * 412. Again not an error: the caller re-reads and retries, bounded. This is
   * how mutable state (`_state/rules`, customers, conversation state) is updated
   * without a database's transactions.
   *
   * An implementation MUST leave the stored body untouched when it returns null,
   * and MUST guarantee that of two concurrent calls holding the same ETag,
   * exactly one succeeds.
   */
  casPut(path: string, body: Uint8Array, etag: ETag, contentType?: string): Promise<ETag | null>

  /**
   * Delete, returning whether anything was there.
   *
   * Needed by the review queue: pointer blobs under `_queue/review/` are deleted
   * on resolve (§3). Documents are never deleted — their path contains the
   * content hash, so a rewrite is a different path.
   */
  remove(path: string): Promise<boolean>
}
