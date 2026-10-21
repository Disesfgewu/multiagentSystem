'use strict';

/**
 * Attribution lines that must never go out through the extension (issue #293): a `Co-authored-by:` trailer, or the
 * "Generated with Claude Code" footer. The check never rewrites anything; it only says which text fields hold such a line
 * (and on which line number, never the text), so the caller can refuse and the person can remove that line themselves.
 *
 * Invisible characters are dropped before a line is read, so a zero-width character inside the key does not hide it.
 * It matches shapes: a look-alike letter, or a line split in two, is not detected (the repository's own checks and a
 * person's review are still needed).
 */

// Lines git and GitHub read as attribution in a message: a body must not be able to add a co-author, sign-off or reviewer.
const TRAILER_LINE = /^\s*(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|on-behalf-of|cc)\s*:/i;
const CO_AUTHOR_LINE = /^\s*co-authored-by\s*:/i;
// The footer is a line of its own, possibly after an emoji, a quote mark or emphasis; a sentence that quotes it is not one.
const GENERATED_FOOTER = /^[\s\p{P}\p{S}]*generated\s+with\s+\[?\s*claude\s+code/iu;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

/** 1-based numbers of the lines of `value` that are attribution lines. */
function attributionLines(value) {
  if (typeof value !== 'string') return [];
  const found = [];
  value.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
    const clean = line.replace(INVISIBLE, '');
    if (CO_AUTHOR_LINE.test(clean) || GENERATED_FOOTER.test(clean)) found.push(index + 1);
  });
  return found;
}

/**
 * @param {Array<{ field: string, text: unknown }>} fields the text fields about to be published
 * @returns {Array<{ field: string, lines: number[] }>} the fields that hold an attribution line (empty when none)
 */
function findAttribution(fields) {
  const problems = [];
  for (const { field, text } of fields) {
    const lines = attributionLines(text);
    if (lines.length > 0) problems.push({ field, lines });
  }
  return problems;
}

module.exports = { findAttribution, attributionLines, TRAILER_LINE, CO_AUTHOR_LINE };
