// Official CLI flags, checked 2026-10-17. This records a request, never proof of the model used.
// https://learn.chatgpt.com/docs/cli/reference
// https://code.claude.com/docs/en/cli-reference
const PROVIDERS = new Set(['claude', 'codex']);
// These tokens are typed into a native shell. Do not accept whitespace, shell syntax or option prefixes.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface ModelChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
}

export const KNOWN_MODELS: Record<string, readonly ModelChoice[]> = Object.freeze({
  claude: Object.freeze([
    Object.freeze({
      id: 'claude-3-7-sonnet-20250219',
      label: 'claude-3-7-sonnet-20250219',
      description: 'Claude 3.7 Sonnet (Hybrid Reasoning)',
      detail: 'Default frontier coding model supporting hybrid reasoning.'
    }),
    Object.freeze({
      id: 'claude-3-5-sonnet-20241022',
      label: 'claude-3-5-sonnet-20241022',
      description: 'Claude 3.5 Sonnet (v2)',
      detail: 'Reliable high-speed frontier model for general coding.'
    }),
    Object.freeze({
      id: 'claude-3-5-haiku-20241022',
      label: 'claude-3-5-haiku-20241022',
      description: 'Claude 3.5 Haiku',
      detail: 'Fast and lightweight for targeted code edits and searches.'
    }),
    Object.freeze({
      id: 'claude-3-opus-20240229',
      label: 'claude-3-opus-20240229',
      description: 'Claude 3 Opus',
      detail: 'Deep analytical reasoning and complex system architecture.'
    })
  ]),
  codex: Object.freeze([
    Object.freeze({
      id: 'o3-mini',
      label: 'o3-mini',
      description: 'OpenAI o3-mini (Coding Reasoning)',
      detail: 'High-intelligence reasoning model optimized for coding.'
    }),
    Object.freeze({
      id: 'o1',
      label: 'o1',
      description: 'OpenAI o1 (Full Reasoning)',
      detail: 'Broad reasoning model for complex multi-step reasoning.'
    }),
    Object.freeze({
      id: 'gpt-4o',
      label: 'gpt-4o',
      description: 'OpenAI GPT-4o (Flagship Multimodal)',
      detail: 'Versatile flagship model for coding and visual reasoning.'
    }),
    Object.freeze({
      id: 'gpt-4o-mini',
      label: 'gpt-4o-mini',
      description: 'OpenAI GPT-4o mini',
      detail: 'Fast, lightweight model for everyday scripting and tasks.'
    })
  ])
});

export function supportsModelSelection(provider: string): boolean { return PROVIDERS.has(provider); }

export function knownModelsForProvider(provider: string): readonly ModelChoice[] {
  return KNOWN_MODELS[provider] ?? Object.freeze([]);
}

export function normalizeRequestedModel(provider: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!supportsModelSelection(provider)) throw Object.assign(new Error('This provider has no verified model selection flag.'), { code: 'model-selection-unsupported' });
  if (typeof value !== 'string' || MODEL.exec(value)?.[0] !== value) throw Object.assign(new Error('Use a model ID of 1–128 letters, digits, dots, underscores, colons, slashes or hyphens, starting with a letter or digit.'), { code: 'invalid-model' });
  return value;
}

export function modelArguments(provider: string, value: unknown): string[] {
  const model = normalizeRequestedModel(provider, value);
  return model === null ? [] : ['--model', model];
}
