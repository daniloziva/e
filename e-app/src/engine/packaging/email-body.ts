import type { Manifest } from './manifest.js'

export interface EmailBodyInput {
  companyName: string
  manifest: Manifest
  periodLabel: string       // "jul 2026"
  revised: boolean
}

/** Serbian body, grouped by category, ⚠ lines for anything uncertain. */
export function buildEmailBody(_input: EmailBodyInput): string {
  throw new Error('not implemented')
}

export function buildEmailSubject(_companyName: string, _periodLabel: string, _revised: boolean): string {
  throw new Error('not implemented')
}

/** Serbian month name for a "YYYY-MM" period. */
export function periodLabel(_period: string): string {
  throw new Error('not implemented')
}

