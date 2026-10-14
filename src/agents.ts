export interface CliProvider {
  readonly label: string;
  readonly executable: string;
}

export const PROVIDERS: readonly CliProvider[] = [
  { label: 'Claude Code', executable: 'claude' },
  { label: 'Codex CLI', executable: 'codex' }
];

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
