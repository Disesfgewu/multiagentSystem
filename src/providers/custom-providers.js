'use strict';

const { describeProvider, builtIn } = require('./registry');

/**
 * Custom CLI providers a person lists in their own user settings (issue #59). A description here only says WHICH
 * program a terminal would start; it is validated by the registry's own `describeProvider`, so a custom provider is
 * held to the same rules as a built-in one: a plain program name (no path, no shell text), a bounded argument array,
 * no control or bidirectional characters. Support is always `terminal-only` and every capability is `unknown`: nothing
 * about an unfamiliar CLI is assumed.
 *
 * Nothing here starts a program. The program name is resolved later from the PATH, after the person has confirmed
 * the first launch of that provider.
 *
 * An error names the entry's position and a short code. It never contains the rejected value, because ids, program
 * names and arguments are the person's own data and are not public.
 */

const MAX_PROVIDERS = 10;
const ENTRY_KEYS = ['id', 'label', 'executable', 'args'];
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} raw the user-level setting value
 * @returns {{ providers: object[], rejected: Array<{ index: number, code: string }>, code: string | null }}
 *   `code` is set when the whole setting is unusable (not a list, or too long); `providers` is then empty.
 */
function customProvidersFrom(raw) {
  if (raw === undefined || raw === null) return { providers: [], rejected: [], code: null };
  if (!Array.isArray(raw)) return { providers: [], rejected: [], code: 'custom-providers-not-a-list' };
  if (raw.length > MAX_PROVIDERS) return { providers: [], rejected: [], code: 'custom-providers-too-many' };
  const builtInIds = new Set(builtIn.list().map((provider) => provider.id));
  const providers = [];
  const rejected = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const bad = (code) => rejected.push({ index, code });
    if (!isPlain(entry)) return bad('provider-not-object');
    // `support` and `capabilities` are fixed here (terminal-only, everything unknown); a person cannot set them.
    if (Object.keys(entry).some((key) => !ENTRY_KEYS.includes(key))) return bad('provider-unknown-field');
    if (typeof entry.id === 'string' && builtInIds.has(entry.id)) return bad('provider-id-reserved');
    if (typeof entry.id === 'string' && seen.has(entry.id)) return bad('provider-id-duplicate');
    let described;
    try {
      described = describeProvider({ id: entry.id, label: entry.label, executable: entry.executable, args: entry.args, support: 'terminal-only' });
    } catch (error) {
      return bad(error && typeof error.code === 'string' ? error.code : 'provider-invalid');
    }
    seen.add(described.id);
    providers.push(described);
  });
  return { providers, rejected, code: null };
}

module.exports = { customProvidersFrom, MAX_PROVIDERS };
