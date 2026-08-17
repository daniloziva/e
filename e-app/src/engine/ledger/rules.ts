export interface CategorizationRule {
  id: string
  book: string
  matchType: 'contains' | 'regex' | 'exact'
  pattern: string
  /** optional extra conditions — a rule may be vendor + item + amount band */
  itemPattern?: string | null
  amountMin?: number | null
  amountMax?: number | null
  category: string
  dimensions?: Record<string, string>
  priority: number
  hitCount: number
  createdAt: string
}

/** Highest priority first; ties broken by specificity then by hitCount. Pure ordering. */
export function sortRules(_rules: CategorizationRule[]): CategorizationRule[] {
  throw new Error('not implemented')
}

/** Does this rule match? Description matching uses the normalized form. */
export function ruleMatches(
  _rule: CategorizationRule,
  _input: { description: string; items: string[]; amount: number },
): boolean {
  throw new Error('not implemented')
}

/**
 * Derive a reusable rule from one user correction — the learning loop.
 * The pattern is the stable part of the description with volatile tokens stripped.
 * Returns null when nothing stable enough remains to make a safe rule.
 */
export function deriveRule(
  _description: string,
  _category: string,
  _book: string,
  _id: string,
  _at: string,
): CategorizationRule | null {
  throw new Error('not implemented')
}

