// Official CLI flags, checked 2026-10-17. This records a request, never proof of the model used.
// https://learn.chatgpt.com/docs/cli/reference
// https://code.claude.com/docs/en/cli-reference
const PROVIDERS = new Set(['claude', 'codex']);
// These tokens are typed into a native shell. Do not accept whitespace, shell syntax or option prefixes.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function supportsModelSelection(provider: string): boolean { return PROVIDERS.has(provider); }

export function normalizeRequestedModel(provider: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!supportsModelSelection(provider)) throw Object.assign(new Error('This provider has no verified model selection flag.'), { code: 'model-selection-unsupported' });
  if (typeof value !== 'string' || !MODEL.test(value)) throw Object.assign(new Error('Use a model ID of 1–128 letters, digits, dots, underscores, colons, slashes or hyphens, starting with a letter or digit.'), { code: 'invalid-model' });
  return value;
}

export function modelArguments(provider: string, value: unknown): string[] {
  const model = normalizeRequestedModel(provider, value);
  return model === null ? [] : ['--model', model];
}
