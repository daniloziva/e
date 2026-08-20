import { describe, expect, it } from 'vitest'
import type { BlobStore } from '../../src/adapters/store/blob-store.js'

/**
 * THE blob-store contract, as one reusable suite.
 *
 * It is a function rather than a test file so that the SAME cases run against
 * both the in-memory fake and Azurite. That is the point: a fake proves nothing
 * on its own, and the only way to know it has not drifted is to hold both to one
 * suite. `06-TDD-STRATEGY.md` §L2 names `putIfAbsent`'s 409 and `casPut`'s 412 as
 * "the load-bearing guarantees of the whole no-database design" and asks for the
 * most adversarial tests in the codebase, "including two concurrent `casPut`s
 * where exactly one must win".
 *
 * Every case here is written in terms of the interface only. Nothing reaches for
 * an implementation detail, so an implementation that passes is substitutable.
 */
export function describeBlobStoreContract(
  label: string,
  // Async so a real store can provision isolated storage per case. The fake
  // returns synchronously; `await` handles both.
  makeStore: () => BlobStore | Promise<BlobStore>,
): void {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  const text = (body: Uint8Array): string => new TextDecoder().decode(body)

  describe(`BlobStore contract — ${label}`, () => {
    describe('put / get', () => {
      it('round-trips a body unchanged', async () => {
        const store = await makeStore()
        await store.put('a/b.json', bytes('{"x":1}'))
        const held = await store.get('a/b.json')

        expect(held).not.toBeNull()
        expect(text(held?.body ?? new Uint8Array())).toBe('{"x":1}')
      })

      it('returns null for a path holding nothing, rather than throwing or an empty body', async () => {
        const store = await makeStore()
        expect(await store.get('nothing/here')).toBeNull()
      })

      it('round-trips arbitrary bytes, not just text', async () => {
        const store = await makeStore()
        const raw = Uint8Array.from([0, 1, 2, 250, 251, 255])
        await store.put('bin', raw)

        expect([...((await store.get('bin'))?.body ?? [])]).toEqual([...raw])
      })

      it('replaces on an unconditional put, and the ETag changes', async () => {
        const store = await makeStore()
        const first = await store.put('p', bytes('one'))
        const second = await store.put('p', bytes('two'))

        expect(second).not.toBe(first)
        expect(text((await store.get('p'))?.body ?? new Uint8Array())).toBe('two')
      })

      it('does not alias the caller buffer — mutating it afterwards must not change the store', async () => {
        // Azure cannot share memory with the caller. A fake that stores the
        // reference would let this pass in tests and diverge in production.
        const store = await makeStore()
        const mutable = bytes('original')
        await store.put('p', mutable)
        mutable[0] = 88

        expect(text((await store.get('p'))?.body ?? new Uint8Array())).toBe('original')
      })
    })

    describe('exists / list / remove', () => {
      it('reports existence without reading the body', async () => {
        const store = await makeStore()
        expect(await store.exists('p')).toBe(false)
        await store.put('p', bytes('x'))
        expect(await store.exists('p')).toBe(true)
      })

      it('lists only what is under the prefix, lexicographically — the path IS the index', async () => {
        const store = await makeStore()
        await store.put('diligaf/2026/07/expense/b.pdf', bytes('b'))
        await store.put('diligaf/2026/07/expense/a.pdf', bytes('a'))
        await store.put('diligaf/2026/08/expense/c.pdf', bytes('c'))
        await store.put('personal/2026/07/expense/d.pdf', bytes('d'))

        expect(await store.list('diligaf/2026/07/')).toEqual([
          'diligaf/2026/07/expense/a.pdf',
          'diligaf/2026/07/expense/b.pdf',
        ])
      })

      it('returns an empty list for a prefix matching nothing', async () => {
        const store = await makeStore()
        await store.put('a/1', bytes('x'))
        expect(await store.list('b/')).toEqual([])
      })

      it('removes, and says whether anything was there', async () => {
        const store = await makeStore()
        await store.put('q/1', bytes('x'))

        expect(await store.remove('q/1')).toBe(true)
        expect(await store.exists('q/1')).toBe(false)
        expect(await store.remove('q/1')).toBe(false)
      })
    })

    // ── the first load-bearing guarantee ────────────────────────────────────
    describe('putIfAbsent — atomic create-if-absent (Azure 409)', () => {
      it('creates on the first call', async () => {
        const store = await makeStore()
        expect(await store.putIfAbsent('_index/hash/diligaf/abc', bytes('first'))).toBe(true)
        expect(await store.exists('_index/hash/diligaf/abc')).toBe(true)
      })

      it('refuses the second call — a duplicate is the answer, not an error', async () => {
        const store = await makeStore()
        await store.putIfAbsent('_index/hash/diligaf/abc', bytes('first'))

        expect(await store.putIfAbsent('_index/hash/diligaf/abc', bytes('second'))).toBe(false)
      })

      it('LEAVES THE EXISTING BODY UNTOUCHED when it refuses', async () => {
        // The whole mechanism turns on this. An implementation that overwrote
        // while returning false would defeat dedupe-by-content silently: the
        // caller reads "duplicate" and the bytes have already been replaced.
        const store = await makeStore()
        await store.putIfAbsent('k', bytes('first'))
        await store.putIfAbsent('k', bytes('second'))

        expect(text((await store.get('k'))?.body ?? new Uint8Array())).toBe('first')
      })

      it('refuses a path created by an unconditional put, not only by putIfAbsent', async () => {
        const store = await makeStore()
        await store.put('k', bytes('via put'))

        expect(await store.putIfAbsent('k', bytes('other'))).toBe(false)
        expect(text((await store.get('k'))?.body ?? new Uint8Array())).toBe('via put')
      })

      it('lets exactly one of many concurrent creates win', async () => {
        const store = await makeStore()
        const results = await Promise.all(
          Array.from({ length: 8 }, (_unused, i) => store.putIfAbsent('race', bytes(`w${String(i)}`))),
        )

        expect(results.filter((created) => created)).toHaveLength(1)
      })
    })

    // ── the second load-bearing guarantee ───────────────────────────────────
    describe('casPut — compare-and-swap (Azure 412)', () => {
      it('writes when the ETag is current, and returns a new one', async () => {
        const store = await makeStore()
        const etag = await store.put('_state/rules.json', bytes('v1'))
        const next = await store.casPut('_state/rules.json', bytes('v2'), etag)

        expect(next).not.toBeNull()
        expect(next).not.toBe(etag)
        expect(text((await store.get('_state/rules.json'))?.body ?? new Uint8Array())).toBe('v2')
      })

      it('refuses a stale ETag and LEAVES THE BODY UNTOUCHED', async () => {
        const store = await makeStore()
        const stale = await store.put('s', bytes('v1'))
        await store.put('s', bytes('v2')) // someone else wrote; `stale` is now old

        expect(await store.casPut('s', bytes('v3'), stale)).toBeNull()
        expect(text((await store.get('s'))?.body ?? new Uint8Array())).toBe('v2')
      })

      it('refuses on an absent blob — If-Match cannot match nothing', async () => {
        const store = await makeStore()
        expect(await store.casPut('gone', bytes('v1'), '"any"'), 'must not create').toBeNull()
        expect(await store.exists('gone')).toBe(false)
      })

      it('refuses a fabricated ETag', async () => {
        const store = await makeStore()
        await store.put('s', bytes('v1'))

        expect(await store.casPut('s', bytes('v2'), '"invented"')).toBeNull()
        expect(text((await store.get('s'))?.body ?? new Uint8Array())).toBe('v1')
      })

      it('accepts the ETag returned by a previous casPut, so a retry loop terminates', async () => {
        const store = await makeStore()
        let etag = await store.put('s', bytes('v0'))
        for (let i = 1; i <= 3; i += 1) {
          const next = await store.casPut('s', bytes(`v${String(i)}`), etag)
          expect(next).not.toBeNull()
          etag = next ?? etag
        }

        expect(text((await store.get('s'))?.body ?? new Uint8Array())).toBe('v3')
      })

      it('TWO CONCURRENT casPuts ON ONE ETAG: exactly one wins, and the winner is what is stored', async () => {
        // Named explicitly by 06-TDD-STRATEGY.md §L2. This is the case that
        // stands in for a database transaction across the whole design.
        const store = await makeStore()
        const etag = await store.put('_state/conv.json', bytes('base'))

        const [a, b] = await Promise.all([
          store.casPut('_state/conv.json', bytes('A'), etag),
          store.casPut('_state/conv.json', bytes('B'), etag),
        ])

        const winners = [a, b].filter((result) => result !== null)
        expect(winners).toHaveLength(1)

        const stored = text((await store.get('_state/conv.json'))?.body ?? new Uint8Array())
        expect(['A', 'B']).toContain(stored)
        // The stored body must belong to the call that succeeded, never the loser.
        expect(stored).toBe(a === null ? 'B' : 'A')
      })
    })
  })
}
