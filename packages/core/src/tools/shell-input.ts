export interface ParsedShellCommandInput {
  command: string;
  /** `!!` keeps the command in history while omitting it from later model context. */
  excludedFromContext: boolean;
}

/** Parse the shared CLI/Web `!command` and `!!command` input syntax. */
export function parseShellCommandInput(input: string): ParsedShellCommandInput | undefined {
  const value = input.trim();
  if (!value.startsWith('!')) return undefined;
  const excludedFromContext = value.startsWith('!!');
  return {
    command: value.slice(excludedFromContext ? 2 : 1).trim(),
    excludedFromContext,
  };
}
