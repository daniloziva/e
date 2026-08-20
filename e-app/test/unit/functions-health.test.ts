import type { HttpRequest, InvocationContext } from '@azure/functions'
import { describe, expect, it, vi } from 'vitest'
import { health } from '../../src/functions/health.js'

/**
 * `06-TDD-STRATEGY.md:52` says `functions/` contain no logic — "the untestable
 * layer is 10 lines per file and has nothing to get wrong". Mostly true, and this
 * file is the exception that proves the rule worth checking: `health` has one
 * branch (the BUILD_ID fallback), and M0's last acceptance box depends on this
 * endpoint answering correctly.
 *
 * The arguments are unused by the handler, so they are cast rather than
 * constructed — building a full HttpRequest would be fixture theatre.
 */
const req = {} as HttpRequest
const ctx = {} as InvocationContext

describe('health', () => {
  it('answers 200 with an ok status', () => {
    const response = health(req, ctx)

    expect(response.status).toBe(200)
    expect(response.jsonBody).toMatchObject({ status: 'ok' })
  })

  it('reports the deployment build when one is set', () => {
    vi.stubEnv('BUILD_ID', 'deadbeef')
    expect(health(req, ctx).jsonBody).toMatchObject({ build: 'deadbeef' })
    vi.unstubAllEnvs()
  })

  it("reports 'local' when no build is set, rather than undefined", () => {
    // A health endpoint whose body says `"build": undefined` serialises the key
    // away entirely, so the absence looks like an older deployment shape.
    vi.stubEnv('BUILD_ID', '')
    expect(health(req, ctx).jsonBody).toMatchObject({ build: 'local' })
    vi.unstubAllEnvs()
  })

  it('leaks nothing beyond status and build', () => {
    // It is unauthenticated by design, so the response shape IS the security
    // boundary. A future field is a deliberate decision, not an accident.
    expect(Object.keys(health(req, ctx).jsonBody as object).sort()).toEqual(['build', 'status'])
  })
})
