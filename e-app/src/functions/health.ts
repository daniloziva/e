import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions'

/**
 * The one function M0 asks for: it proves the deployment works.
 *
 * `07-ROADMAP.md` §M0 lists it as "`health.ts` — the one function; proves
 * deployment works", and M0's last unchecked acceptance box is `/api/health`
 * responding in Azure. Its job is to answer that question and nothing else.
 *
 * Deliberately minimal. A health endpoint is unauthenticated by nature, so every
 * field it returns is public: no store probe (a public endpoint that reaches
 * storage on demand is an amplifier), no configuration echo, no environment
 * dump. It answers "is the app deployed and routing" — which is the only thing
 * anyone can act on from outside.
 *
 * Note the contrast with the webhook. `01-ARCHITECTURE.md:418` is emphatic that
 * `whatsapp-webhook` must NOT be anonymous — 1IA's is, and anyone who learns the
 * URL can forge messages. That reasoning does not transfer here precisely because
 * this returns nothing worth forging.
 */
function buildId(): string {
  const value: unknown = process.env['BUILD_ID']
  return typeof value === 'string' ? value.trim() : ''
}

export function health(_request: HttpRequest, _context: InvocationContext): HttpResponseInit {
  return {
    status: 200,
    jsonBody: {
      status: 'ok',
      // Set by the deployment, not by code, so a stale build is visible from
      // outside without needing logs. Absent locally, which is also the answer.
      //
      // Truthiness, not `??`. An env var set to the EMPTY STRING is a realistic
      // deployment mistake — a CI variable that failed to interpolate — and `??`
      // passes it through, so the endpoint reports `"build": ""`. That reads as a
      // build with no name rather than a build id that never arrived. Found by
      // test, not by review.
      build: buildId() || 'local',
    },
  }
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: health,
})
