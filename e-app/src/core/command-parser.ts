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

/**
 * Parse a slash command. Case-insensitive, diacritic-insensitive,
 * fuzzy at Levenshtein <= 1 ("/expence" -> expense, "/troshak" -> expense).
 * Not a command (no leading slash, or no match within distance) -> null,
 * which sends the caller down the free-text path.
 * `/tebra "..."` keeps its quoted argument intact, quotes stripped.
 */
export function parseCommand(_text: string): Command | null {
  throw new Error('not implemented')
}

