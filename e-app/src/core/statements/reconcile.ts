export interface StatementTotals {
  openingBalance: number
  closingBalance: number
  totalCredits: number
  totalDebits: number
}

export interface ReconcileResult {
  balanced: boolean
  expectedClosing: number
  difference: number       // expectedClosing - closingBalance, rounded to 2dp
}

/**
 * opening + credits - debits ~= closing, tolerance +/- 0.01.
 * The hard gate that makes a deterministic statement parser safe (04 §2).
 */
export function reconcile(_totals: StatementTotals, _tolerance?: number): ReconcileResult {
  throw new Error('not implemented')
}

/** Sum parsed transaction amounts into credits/debits for comparison against the header. */
export function totalsFromTransactions(_amounts: number[]): { totalCredits: number; totalDebits: number } {
  throw new Error('not implemented')
}

