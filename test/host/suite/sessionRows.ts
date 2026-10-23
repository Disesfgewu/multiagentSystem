'use strict';

/** The overview row label of a session named `name`: its codename in front (issue #342), e.g. `Agent-03 · name`. */
export const isSessionRow = (label: unknown, name: string): boolean => {
  const text = String(label);
  return text.endsWith(` · ${name}`) && /^(?:PM|[A-Z][a-z]{1,19})-[0-9]{2,4}$/.test(text.slice(0, text.length - name.length - 3));
};
