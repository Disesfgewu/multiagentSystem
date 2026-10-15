export interface CliProvider {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

const { builtIn } = require('./providers/registry') as { builtIn: { list(): CliProvider[] } };

export const PROVIDERS: readonly CliProvider[] = Object.freeze(builtIn.list());

export const GROUP_NAMES: readonly string[] = ['PM', 'Worker 1', 'Worker 2', 'Worker 3'];

const TERMINAL_PREFIX = 'Multiagent: ';

export function terminalTitle(name: string): string {
  return `${TERMINAL_PREFIX}${name.trim()}`;
}

export function validateTerminalName(value: string): string | undefined {
  return value.trim() ? undefined : 'Enter a terminal name.';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
