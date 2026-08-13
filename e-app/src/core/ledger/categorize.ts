import type { Transaction } from '../types.js'
import type { CategorizationRule } from './rules.js'

export type CategorySource = 'stated' | 'items' | 'rule' | 'model' | 'misc'

export interface CategorizeInput {
  description: string
  counterparty: string | null
  amount: number
  items: Array<{ description: string; lineTotal: number | null }>
  /** a category the user explicitly stated in the message — outranks everything */
  stated?: string | null
}

export interface CategorizeContext {
  rules: CategorizationRule[]
  history: Transaction[]
  allowedCategories: string[]
  /** null when no model proposal was obtained or it failed validation */
  modelProposal?: { category: string; confidence: 'high' | 'medium' | 'low' } | null
}

export interface CategorizeResult {
  category: string          // 'MISC' when unresolved
  source: CategorySource
  confidence: 'high' | 'medium' | 'low'
  /** true when the vendor was ambiguous, so rule matching was deliberately skipped */
  ambiguousVendor: boolean
}

/**
 * The signal ladder (04 §3 / 01 §5.1), in strict precedence:
 *   stated -> line items -> rule -> model -> MISC
 * A rule is NOT applied when the vendor is ambiguous.
 * A model proposal outside allowedCategories, or below high confidence, is discarded.
 */
export function categorize(_input: CategorizeInput, _ctx: CategorizeContext): CategorizeResult {
  throw new Error('not implemented')
}

