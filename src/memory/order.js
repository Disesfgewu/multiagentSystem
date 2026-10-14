'use strict';

// Compares by UTF-16 code unit. `String.prototype.localeCompare` follows the machine's
// language and ICU version, so the same ids would sort differently on another machine or Node
// version and the injected text (and the retrieval order) would not be reproducible.
// Not a "natural" order: uppercase sorts before lowercase and `-` `.` `_` are ordered by code.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = { byCodeUnit };
