// The package starts no agent that adds an author line of its own to what it publishes (issue #293). For Claude Code the
// switch is a settings value passed on the command line, so no file of the person's is changed. Whether another provider has
// an equivalent setting is unknown, so nothing is claimed for it: see docs/PROVIDERS.md.
//
// Only one `--settings` is passed. If another feature ever needs to pass settings too, the two must be merged into this one
// value; two flags are not known to combine.

export const CLAUDE_ATTRIBUTION_SETTINGS = '{"attribution":{"commit":"","pr":"","sessionUrl":false}}';

/** The launch arguments that switch off the provider's own attribution, or none for a provider with no known switch. */
export function attributionArguments(provider: string): string[] {
  return provider === 'claude' ? ['--settings', CLAUDE_ATTRIBUTION_SETTINGS] : [];
}
