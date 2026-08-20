import { createFakeBlobStore } from '../fakes/blob-store.js'
import { describeBlobStoreContract } from './blob-store.contract.js'

// The same suite will run against Azurite once the Azure implementation lands
// (M0, Phase B). Holding both to one contract is what stops the fake drifting.
describeBlobStoreContract('in-memory fake', () => createFakeBlobStore())
