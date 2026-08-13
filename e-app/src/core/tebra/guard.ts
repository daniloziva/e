import type { BookCode } from '../types.js'

export interface ToolCall { name: string; args: Record<string, unknown> }

export type SideEffect = 'read' | 'write' | 'render'

export function sideEffectOf(_toolName: string): SideEffect | null {
  throw new Error('not implemented')
}

/**
 * The book is resolved from the sender phone BEFORE the loop and injected
 * server-side. A model-supplied `book` argument is always overwritten, never trusted.
 */
export function enforceBookScope(_call: ToolCall, _book: BookCode): ToolCall {
  throw new Error('not implemented')
}

/** Write tools never execute inside the loop — they become proposals (09 §5.1). */
export function isExecutableInLoop(_toolName: string): boolean {
  throw new Error('not implemented')
}

/** Wrap third-party document/email text so the model treats it as data, not instructions. */
export function wrapUntrusted(_content: string, _source: string): string {
  throw new Error('not implemented')
}

export interface LoopBudget { maxSteps: number; maxRowsPerCall: number; maxTokens: number }

export interface BudgetState { steps: number; tokens: number }

export function budgetExceeded(_state: BudgetState, _budget: LoopBudget): 'steps' | 'tokens' | null {
  throw new Error('not implemented')
}

