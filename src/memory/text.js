'use strict';

// Private text is compared in a normalised "flat" form: lower case with all
// whitespace, punctuation and symbols removed, so reformatting does not hide it.
const flatten = (text) => text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// Anything shorter than this cannot be matched reliably without matching
// ordinary words, so the store refuses to keep private items that short.
const MIN_MATCHABLE_CHARS = 6;

module.exports = { flatten, MIN_MATCHABLE_CHARS };
