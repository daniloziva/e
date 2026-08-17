import type { Transaction } from '../types.js'
import { vendorIsAmbiguous } from './ambiguous-vendor.js'
import type { CategorizationRule } from './rules.js'
import { ruleMatches, sortRules } from './rules.js'

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

/** The review queue. Not a category anybody chose — the record that nobody could. */
const UNRESOLVED = 'MISC'

/**
 * The only model confidence that is believed.
 *
 * 01 §5: the model proposes, the code decides. A proposal below this is
 * DISCARDED, not down-weighted and not stored with a caveat — a `medium` guess
 * filed under a real category looks exactly like a decision once it is in the
 * ledger, whereas MISC is visibly unfinished and lands in the review queue where
 * a human closes it.
 */
const MODEL_THRESHOLD = 'high'

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

/**
 * The signal ladder (04 §3 / 01 §5.1), in strict precedence:
 *
 *   0 stated  — what you said. Outranks the list itself.
 *   1 items   — what was bought.
 *   2 rule    — who sold it, unless that vendor is ambiguous.
 *   3 model   — only at high confidence, and only inside the allowed list.
 *   4 MISC    — the floor. The review queue, never a throw.
 *
 * Precedence is by RUNG and never by rule priority: an item-qualified rule is
 * evidence about WHAT WAS BOUGHT, so it resolves at rung 1 even when a
 * higher-priority vendor rule matches at rung 2. If priority could reach across
 * rungs the ladder would be decorative.
 *
 * Pure: no clock, no randomness, no mutation of the input, the rules or the
 * history. The same input and context always produce the same result.
 */
export function categorize(input: CategorizeInput, ctx: CategorizeContext): CategorizeResult {
  const rules = asArray(ctx.rules)
  const history = asArray(ctx.history)

  // Computed once, up front, and reported on every path — including the paths
  // where a higher rung made rule matching moot. `ambiguousVendor` is a fact
  // about the vendor, not a description of what this call happened to do with
  // it. A suppressed-signal flag that silently disappears when something else
  // resolves first is worse than one that is always true to the history: the
  // review UI uses it to explain the vendor, not the decision.
  //
  // The vendor is `input.counterparty` and is never re-derived from the
  // description. A caller that passes no counterparty is stating that this line
  // names no vendor, and no vendor can be ambiguous; inventing one here would
  // suppress rules the caller expects to fire.
  const vendor = asText(input.counterparty).trim()
  const ambiguousVendor = vendor !== '' && vendorIsAmbiguous(vendor, history)

  const resolved =
    fromStated(input) ??
    fromItems(input, rules) ??
    fromRules(input, rules, ambiguousVendor) ??
    fromModel(ctx)

  return { ...(resolved ?? miscFloor()), ambiguousVendor }
}

type Resolution = Omit<CategorizeResult, 'ambiguousVendor'>

function miscFloor(): Resolution {
  return { category: UNRESOLVED, source: 'misc', confidence: 'low' }
}

// ───────────────────────── rung 0 — what you stated ─────────────────────────

/**
 * A category the user stated outranks every other signal, including the allowed
 * list itself: the list is a default the user is allowed to be ahead of, and
 * refusing a stated `KUCNI_LJUBIMCI` would be the code overruling the person it
 * works for. A stated `MISC` is honoured as an explicit filing decision rather
 * than treated as unresolved.
 *
 * Only the surrounding whitespace is trimmed. The casing is NOT repaired —
 * consistent with the model rung below, which discards `'hrana'` rather than
 * meeting it half way.
 *
 * Absent, null, empty and whitespace-only all mean "nothing was stated" and drop
 * to the next rung.
 */
function fromStated(input: CategorizeInput): Resolution | null {
  const stated = asText(input.stated).trim()
  if (stated === '') return null
  return { category: stated, source: 'stated', confidence: 'high' }
}

// ───────────────────────── rung 1 — the line items ──────────────────────────

/**
 * What was bought beats who sold it. A receipt's line items are direct evidence
 * about this transaction; a vendor rule is a generalisation about the merchant,
 * and generalisations lose to observations.
 *
 * Only rules that STATE an item pattern are consulted here — that is what makes
 * a rule item evidence. The rest are left for rung 2. (They are also excluded
 * from rung 2, below, so no rule is read on two rungs.)
 *
 * When the matching item rules disagree, this rung ABSTAINS rather than picking
 * a side. 04 §3 answers a mixed basket with a SPLIT, and `CategorizeResult`
 * carries exactly one category, so there is no way to express the split here;
 * silently filing nappies-and-milk as one or the other would destroy the very
 * information a split needs. The ladder continues, and it usually ends at MISC —
 * the review queue, which is where a basket that needs splitting belongs.
 *
 * HAZARD, recorded rather than fixed: the frozen suite pins that a high-
 * confidence model proposal may resolve a basket this rung explicitly refused
 * to decide (`ledger-categorize.test.ts:391`). That is the shape of
 * UNFREEZE-LOG CANDIDATE-004 — a deterministic REFUSAL being indistinguishable
 * from an absence, and filled by the model. It is bounded here in a way the nlu
 * path is not (`fromModel` still checks the allowed list and the threshold, and
 * `source: 'model'` records the provenance in the stored result), but the
 * refusal itself is not carried into the model rung. Reporting it, not
 * unilaterally hardening past a frozen assertion.
 */
function fromItems(input: CategorizeInput, rules: CategorizationRule[]): Resolution | null {
  const items = asArray(input.items)
    .map((item) => (item !== null && typeof item === 'object' ? asText(item.description) : ''))
    .filter((description) => description !== '')

  // A line item with no amount is still a line item — a missing `lineTotal` is
  // a gap in the receipt, not the absence of the thing that was bought. Only the
  // descriptions are consulted, so the question never arises.
  if (items.length === 0) return null

  const matchInput = { description: asText(input.description), items, amount: input.amount }
  const categories = new Set<string>()

  for (const rule of rules) {
    if (!statesItemCondition(rule)) continue
    if (!ruleMatches(rule, matchInput)) continue

    const category = asText(rule.category).trim()
    if (category !== '') categories.add(category)
  }

  if (categories.size !== 1) return null

  const [category] = [...categories]
  if (category === undefined) return null
  return { category, source: 'items', confidence: 'high' }
}

/** Whether a rule is evidence about what was bought. An empty pattern states nothing. */
function statesItemCondition(rule: CategorizationRule): boolean {
  if (rule === null || typeof rule !== 'object') return false
  return asText(rule.itemPattern).trim() !== ''
}

// ─────────────────────────── rung 2 — who sold it ───────────────────────────

/**
 * The recurring-merchant backbone: the highest-ranked rule that matches wins,
 * ranked by `sortRules` (priority, then specificity, then hit count). The first
 * match in that order is taken, so two matching rules that disagree are settled
 * by rank and never by array order.
 *
 * Two exclusions:
 *
 *  - Item-qualified rules. They belong to rung 1 and were already read there,
 *    including when rung 1 abstained. Re-reading them here would let the
 *    highest-priority half of a mixed basket win the argument that rung 1
 *    deliberately declined to settle.
 *
 *  - Every rule, when the vendor is ambiguous (00 D16). A vendor that has been
 *    filed two ways has no single answer, so a rule claiming it has one is
 *    unsafe by construction. This suppresses the rung entirely rather than
 *    picking the more frequent category — the meta-rule exists precisely
 *    because frequency was not a good enough reason.
 */
function fromRules(
  input: CategorizeInput,
  rules: CategorizationRule[],
  ambiguousVendor: boolean,
): Resolution | null {
  if (ambiguousVendor) return null

  const items = asArray(input.items).map((item) =>
    item !== null && typeof item === 'object' ? asText(item.description) : '',
  )
  const matchInput = { description: asText(input.description), items, amount: input.amount }

  for (const rule of sortRules(rules)) {
    if (statesItemCondition(rule)) continue
    if (!ruleMatches(rule, matchInput)) continue

    const category = asText(rule.category).trim()
    if (category === '') continue
    return { category, source: 'rule', confidence: 'high' }
  }

  return null
}

// ──────────────── rung 3 — the model proposes, the code decides ─────────────

/**
 * The only place a model-produced string can reach the stored category, and it
 * passes three checks first:
 *
 *  1. the proposal is a well-formed object with a string category — it arrives
 *     from an LLM as JSON and nothing about its shape is guaranteed;
 *  2. the confidence is exactly `high`;
 *  3. the category is a member of `allowedCategories`, compared with `===`.
 *
 * Exact membership, never a repair. `'hrana'` against `['HRANA']` is discarded:
 * 01 §5 — "if the JSON doesn't validate, it's a failure, not an interpretation."
 * Case-folding it here would be the code meeting the model half way, and the
 * same latitude that repairs casing is the latitude that later repairs a
 * near-miss into a category the user never defined. An empty allowed list
 * therefore discards everything, which is correct: a workspace with no
 * categories has nothing the model could validly propose.
 *
 * The result is reported as `confidence: 'high'` — the rung's own outcome, not a
 * value passed through from the model. Below the threshold the model is not
 * believed at all, so there is no lower-confidence result for it to report;
 * this is deliberately unlike the nlu path, where a model's self-reported
 * confidence becomes the commit switch (UNFREEZE-LOG CANDIDATE-005).
 */
function fromModel(ctx: CategorizeContext): Resolution | null {
  const proposal = ctx.modelProposal
  if (proposal === null || proposal === undefined || typeof proposal !== 'object') return null
  if (proposal.confidence !== MODEL_THRESHOLD) return null

  const category = asText(proposal.category)
  if (category === '') return null

  const allowed = asArray(ctx.allowedCategories)
  if (!allowed.some((value) => typeof value === 'string' && value === category)) return null

  return { category, source: 'model', confidence: 'high' }
}
