import { levenshtein } from './nlu/synonyms.js'

export type CommandName =
  | 'expense' | 'cash' | 'invoice' | 'pending' | 'misc'
  | 'report' | 'status' | 'book' | 'tebra' | 'help'

export interface Command {
  name: CommandName
  /** everything after the command token, trimmed; '' when absent */
  args: string
  /** true when the command token was reached by fuzzy match rather than exactly */
  fuzzy: boolean
}

const COMMAND_NAMES: readonly CommandName[] = [
  'expense',
  'cash',
  'invoice',
  'pending',
  'misc',
  'report',
  'status',
  'book',
  'tebra',
  'help',
]

/**
 * Serbian spellings that reach a command directly. Keys are already folded
 * (lowercase, diacritics stripped), so "/trošak", "/TROŠAK" and "/trosak" all
 * land on the same entry, and "/troshak" reaches it as a distance-1 typo.
 */
const COMMAND_ALIASES: Readonly<Record<string, CommandName>> = {
  trosak: 'expense',
}

/**
 * Beyond one edit the parser refuses rather than guessing: "/expance" is two
 * substitutions from expense and goes down the free-text path instead.
 */
const MAX_EDIT_DISTANCE = 1

/**
 * Quote pairs a phone keyboard actually produces. Only a matched outer pair is
 * stripped, and only the outermost one — an inner quoted word is part of the
 * prompt. Single quotes are ordinary characters and are never stripped.
 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'], // “ ”
  ['„', '“'], // „ “ — the Serbian typographic pair
  ['„', '”'], // „ ”
]

/**
 * Fold a command token for matching: lowercase, diacritics stripped.
 * Deliberately local to the command grammar rather than shared with the NLU
 * synonym layer — the grammar is a closed set, and it must not start
 * transliterating Cyrillic if the learned-vocabulary side ever does.
 */
function foldToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/đ/g, 'd') // đ is atomic — NFD leaves it standing
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function exactMatch(folded: string): CommandName | null {
  const direct = COMMAND_NAMES.find((name) => name === folded)
  if (direct !== undefined) return direct
  return COMMAND_ALIASES[folded] ?? null
}

/**
 * Nearest command within MAX_EDIT_DISTANCE, over both the canonical spellings
 * and the aliases. Two different commands equally near is an ambiguity, and an
 * ambiguity is refused — E never picks one of two readings on the user's behalf.
 */
function fuzzyMatchCommand(folded: string): CommandName | null {
  if (folded === '') return null

  const spellings: [string, CommandName][] = [
    ...COMMAND_NAMES.map((name): [string, CommandName] => [name, name]),
    ...Object.entries(COMMAND_ALIASES),
  ]

  let best = Number.POSITIVE_INFINITY
  const winners = new Set<CommandName>()

  for (const [spelling, name] of spellings) {
    const distance = levenshtein(folded, spelling)
    if (distance < best) {
      best = distance
      winners.clear()
      winners.add(name)
    } else if (distance === best) {
      winners.add(name)
    }
  }

  if (best > MAX_EDIT_DISTANCE) return null
  if (winners.size !== 1) return null
  const [only] = winners
  return only ?? null
}

/**
 * The quotes are the argument boundary, so what sits between them survives
 * untouched — inner padding, inner spacing, newlines and case all included.
 * An unbalanced quote is left verbatim rather than half-repaired.
 */
function unquoteArgs(args: string): string {
  if (args.length < 2) return args
  const first = args.slice(0, 1)
  const last = args.slice(-1)
  for (const [open, close] of QUOTE_PAIRS) {
    if (first === open && last === close) return args.slice(1, -1)
  }
  return args
}

/**
 * Parse a slash command. Case-insensitive, diacritic-insensitive,
 * fuzzy at Levenshtein <= 1 ("/expence" -> expense, "/troshak" -> expense).
 * Not a command (no leading slash, or no match within distance) -> null,
 * which sends the caller down the free-text path.
 * `/tebra "..."` keeps its quoted argument intact, quotes stripped.
 */
export function parseCommand(text: string): Command | null {
  // Untrusted webhook text: an absent body is "not a command", never a throw.
  if (typeof text !== 'string') return null

  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  // The token is the run up to the first whitespace; everything after it is the
  // argument, so "/ expense" (slash, then a space) is not a command at all.
  const split = /^(\S+)([\s\S]*)$/.exec(trimmed.slice(1))
  if (split === null) return null

  const folded = foldToken(split[1] ?? '')
  const rest = (split[2] ?? '').trim()

  const exact = exactMatch(folded)
  const name = exact ?? fuzzyMatchCommand(folded)
  if (name === null) return null

  const args = name === 'tebra' ? unquoteArgs(rest) : rest
  return { name, args, fuzzy: exact === null }
}
