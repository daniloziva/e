import type { DocumentFacts, DocCategory } from '../types.js'

export interface ManifestRow {
  category: DocCategory
  date: string | null
  vendor: string | null
  amount: number | null
  currency: string | null
  filename: string
  extractionMethod: string
  warning: string | null
}

export interface ManifestGroup {
  category: DocCategory
  rows: ManifestRow[]
  count: number
  total: number | null      // null when any row is missing an amount
  vatTotal: number | null
}

export interface Manifest {
  period: string
  groups: ManifestGroup[]
  totalDocuments: number
  warnings: string[]        // one per document missing an amount, etc.
}

export function buildManifest(_docs: DocumentFacts[], _period: string): Manifest {
  throw new Error('not implemented')
}

/** RFC4180 CSV, including an `extraction_method` column. */
export function manifestToCsv(_manifest: Manifest): string {
  throw new Error('not implemented')
}

