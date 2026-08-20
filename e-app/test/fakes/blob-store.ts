import type { BlobStore, ETag, StoredBlob } from '../../src/adapters/store/blob-store.js'

/**
 * In-memory BlobStore. Declared in M0 and missing until now (U8), which is why
 * M1's use-case tests could not be written.
 *
 * It is NOT a convenience double. It is held to the same contract suite as the
 * Azure implementation (`test/contract/blob-store.contract.ts`), because a fake
 * that drifts from the real store is worse than no fake: every use-case test
 * above it then passes against semantics that do not exist.
 *
 * Three fidelity points that a naive Map would get wrong:
 *
 *  - **Bodies are copied on write and on read.** Azure cannot alias a caller's
 *    buffer, so neither may this. A shared reference would let a caller mutate
 *    stored bytes after the fact and no test would notice.
 *  - **ETags are opaque and change on every write.** A test must not be able to
 *    predict or construct one; that is what keeps `casPut` honest.
 *  - **Check-and-write is atomic.** JavaScript is single-threaded, so as long as
 *    no `await` sits between reading the ETag and writing, two concurrent
 *    `casPut`s cannot both win — which is the guarantee the interface demands.
 */
export function createFakeBlobStore(): BlobStore & {
  /** Test-only: everything currently stored, for assertions the interface does not expose. */
  snapshot(): Map<string, StoredBlob>
} {
  const blobs = new Map<string, { body: Uint8Array; etag: ETag }>()
  let seq = 0

  const nextETag = (): ETag => {
    seq += 1
    // Deliberately not derived from the content or the path: an ETag a test can
    // guess is an ETag that lets casPut pass without a real read.
    return `"fake-etag-${String(seq)}"`
  }

  const copy = (body: Uint8Array): Uint8Array => Uint8Array.from(body)

  return {
    put(path, body) {
      const etag = nextETag()
      blobs.set(path, { body: copy(body), etag })
      return Promise.resolve(etag)
    },

    get(path) {
      const found = blobs.get(path)
      if (found === undefined) return Promise.resolve(null)
      return Promise.resolve({ body: copy(found.body), etag: found.etag })
    },

    list(prefix) {
      const paths = [...blobs.keys()].filter((path) => path.startsWith(prefix))
      // Azure lists lexicographically; a fake that returned insertion order
      // would let an ordering bug pass here and fail in production.
      paths.sort()
      return Promise.resolve(paths)
    },

    exists(path) {
      return Promise.resolve(blobs.has(path))
    },

    putIfAbsent(path, body) {
      if (blobs.has(path)) return Promise.resolve(false)
      blobs.set(path, { body: copy(body), etag: nextETag() })
      return Promise.resolve(true)
    },

    casPut(path, body, etag) {
      const found = blobs.get(path)
      // Absent is a stale-ETag case, not a create: If-Match on a missing blob
      // fails in Azure too.
      if (found === undefined) return Promise.resolve(null)
      if (found.etag !== etag) return Promise.resolve(null)
      const next = nextETag()
      blobs.set(path, { body: copy(body), etag: next })
      return Promise.resolve(next)
    },

    remove(path) {
      return Promise.resolve(blobs.delete(path))
    },

    snapshot() {
      return new Map([...blobs].map(([path, held]) => [path, { body: copy(held.body), etag: held.etag }]))
    },
  }
}
