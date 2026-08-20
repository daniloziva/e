import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { afterAll, beforeAll } from 'vitest'
import { createAzureBlobStore } from '../../src/adapters/store/azure-blob-store.js'
import { describeBlobStoreContract } from './blob-store.contract.js'

/**
 * The SAME 20 cases as the fake, against Azurite.
 *
 * This is the whole reason the contract is a function. `06-TDD-STRATEGY.md` §L2
 * calls `putIfAbsent`'s 409 and `casPut`'s 412 "the load-bearing guarantees of
 * the whole no-database design" — and a guarantee verified only against a fake we
 * wrote ourselves is not verified at all.
 *
 * `UseDevelopmentStorage=true` is the SDK's own shorthand: it expands to Azurite's
 * universal development credential internally, so no key, account name or
 * connection string appears anywhere in this repo.
 *
 * Not part of `pnpm test`, which must run with nothing else installed. Run it with
 * `pnpm test:contract`, which needs Azurite listening on 10000:
 *
 *     pnpm exec azurite-blob --silent --skipApiVersionCheck --location /tmp/azurite
 *
 * `--skipApiVersionCheck` is REQUIRED, not optional. Azurite 3.36 refuses the API
 * version `@azure/storage-blob` 12.33 sends (`2026-06-06`) and fails the whole
 * connection. Every operation this adapter uses — upload, download, list, delete,
 * If-None-Match, If-Match — long predates that version, and this suite is what
 * proves they behave. Azurite itself suggests the flag in its own error text.
 *
 * It FAILS rather than skips when Azurite is absent. A contract suite that
 * quietly skips is the same decorative gate the coverage thresholds were for
 * eight milestones.
 */

const CONNECTION = 'UseDevelopmentStorage=true'

let service: BlobServiceClient
const provisioned: ContainerClient[] = []
let seq = 0

beforeAll(async () => {
  service = BlobServiceClient.fromConnectionString(CONNECTION)
  try {
    // Cheapest possible reachability probe that also proves the credential works.
    await service.getProperties()
  } catch (error) {
    // Deliberately does NOT claim "unreachable". The first real failure here was
    // an API-version rejection from an Azurite that was running fine, and a
    // message naming the wrong cause sends the next person to check the port.
    throw new Error(
      `Could not talk to Azurite on 127.0.0.1:10000. Start it with ` +
        `\`pnpm exec azurite-blob --silent --skipApiVersionCheck --location /tmp/azurite\`. ` +
        `If it IS already running, read the underlying error before assuming the port: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}, 30_000)

afterAll(async () => {
  await Promise.all(provisioned.map((container) => container.deleteIfExists()))
}, 60_000)

describeBlobStoreContract('Azurite', async () => {
  // A fresh container per case, so isolation is the service's rather than a
  // path-prefix trick of our own that could mask a real failure.
  seq += 1
  const container = service.getContainerClient(`contract-${String(seq)}-${String(process.pid)}`)
  await container.createIfNotExists()
  provisioned.push(container)
  return createAzureBlobStore(container)
})
