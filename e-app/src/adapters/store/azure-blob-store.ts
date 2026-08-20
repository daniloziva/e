import { RestError, type ContainerClient } from '@azure/storage-blob'
import type { BlobStore, ETag, StoredBlob } from './blob-store.js'

/**
 * The Azure Blob Storage implementation of `BlobStore`.
 *
 * It takes a `ContainerClient` rather than a connection string on purpose: how
 * the client is authenticated (managed identity in production, the well-known
 * development credential against Azurite in tests) is a composition concern for
 * `app/`, not this file's. It also means the Azurite contract run and production
 * exercise the same code path, which is what makes the contract suite meaningful.
 *
 * The only real work here is translating HTTP into the domain outcomes the
 * interface promises. Two of those translations carry the whole no-database
 * design (`01-ARCHITECTURE.md` §3):
 *
 *   409 Conflict            -> putIfAbsent returns false   (the blob was there)
 *   412 Precondition Failed -> casPut returns null         (the ETag was stale)
 *
 * Neither is an error, and neither may be allowed to propagate as one. A thrown
 * 409 from a dedupe check would turn "this document is a duplicate" into an
 * incident.
 */

/** 404 also means BlobNotFound on a conditional write against a missing blob. */
const NOT_FOUND = 404
const CONFLICT = 409
const PRECONDITION_FAILED = 412

function statusOf(error: unknown): number | null {
  if (error instanceof RestError && typeof error.statusCode === 'number') return error.statusCode
  return null
}

async function readAll(stream: NodeJS.ReadableStream | undefined): Promise<Uint8Array> {
  if (stream === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const body = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

export function createAzureBlobStore(container: ContainerClient): BlobStore {
  const headers = (contentType?: string) =>
    contentType === undefined ? undefined : { blobContentType: contentType }

  return {
    async put(path, body, contentType) {
      const response = await container
        .getBlockBlobClient(path)
        .upload(body, body.byteLength, { blobHTTPHeaders: headers(contentType) })
      // The service always returns one on success; the type is optional because
      // the generated client cannot know that.
      return response.etag ?? ''
    },

    async get(path): Promise<StoredBlob | null> {
      try {
        const response = await container.getBlobClient(path).download()
        // `download()` rather than `downloadToBuffer()`: it returns the ETag and
        // the bytes from ONE request, so they cannot disagree. Fetching
        // properties separately would be a race against a concurrent write.
        return { body: await readAll(response.readableStreamBody), etag: response.etag ?? '' }
      } catch (error) {
        if (statusOf(error) === NOT_FOUND) return null
        throw error
      }
    },

    async list(prefix) {
      const paths: string[] = []
      for await (const blob of container.listBlobsFlat({ prefix })) paths.push(blob.name)
      // Azure lists lexicographically already; sorting makes the contract
      // explicit rather than relying on a service ordering guarantee.
      paths.sort()
      return paths
    },

    exists(path) {
      return container.getBlockBlobClient(path).exists()
    },

    async putIfAbsent(path, body, contentType): Promise<boolean> {
      try {
        await container.getBlockBlobClient(path).upload(body, body.byteLength, {
          // `*` means "only if no blob exists at this path" — the atomic
          // create-if-absent the dedupe index is built on.
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: headers(contentType),
        })
        return true
      } catch (error) {
        if (statusOf(error) === CONFLICT) return false
        throw error
      }
    },

    async casPut(path, body, etag, contentType): Promise<ETag | null> {
      try {
        const response = await container.getBlockBlobClient(path).upload(body, body.byteLength, {
          conditions: { ifMatch: etag },
          blobHTTPHeaders: headers(contentType),
        })
        return response.etag ?? ''
      } catch (error) {
        const status = statusOf(error)
        // 412: someone else wrote first. 404: there is nothing to match against.
        // Both mean "you did not win" — the caller re-reads and retries.
        if (status === PRECONDITION_FAILED || status === NOT_FOUND) return null
        throw error
      }
    },

    async remove(path) {
      const response = await container.getBlockBlobClient(path).deleteIfExists()
      return response.succeeded
    },
  }
}
