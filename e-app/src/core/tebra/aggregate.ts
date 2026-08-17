import type { Transaction, DocumentFacts } from '../types.js'

export interface AggregateQuery {
  groupBy: string[]              // 'category' | 'dimension.project' | 'month' | 'currency' | 'vendor'
  metric: 'sum' | 'count' | 'avg'
  field?: 'amount' | 'amountRsd'
  filter?: TransactionFilter
  limit?: number
  sort?: 'asc' | 'desc'
}

export interface TransactionFilter {
  from?: string                  // YYYY-MM-DD
  to?: string
  categories?: string[]
  dimensions?: Record<string, string>
  minAmount?: number
  maxAmount?: number
  direction?: 'in' | 'out'
  descriptionContains?: string
}

export interface AggregateRow { key: Record<string, string>; value: number; count: number }

export interface AggregateResult {
  rows: AggregateRow[]
  total: number
  /** true when `limit` cut rows off — must ALWAYS be surfaced, never a silent top-N */
  truncated: boolean
  omittedRows: number
}

/** ALL /tebra arithmetic happens here, never in the model (D19). */
export function aggregate(_txs: Transaction[], _query: AggregateQuery): AggregateResult {
  throw new Error('not implemented')
}

export function filterTransactions(_txs: Transaction[], _filter: TransactionFilter): Transaction[] {
  throw new Error('not implemented')
}

export interface DocumentFilter {
  period?: string
  categories?: string[]
  vendor?: string
  minAmount?: number
  maxAmount?: number
  reviewStatus?: string
}

export function searchDocuments(_docs: DocumentFacts[], _filter: DocumentFilter, _limit?: number): {
  docs: DocumentFacts[]; truncated: boolean; omittedRows: number
} {
  throw new Error('not implemented')
}

