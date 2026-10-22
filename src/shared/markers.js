'use strict';

/**
 * The wording this package puts at the front of the prompts it types into an agent's terminal ("[Task from the administrator …]",
 * "[Administrator broadcast …]", "[Code discussion from the administrator] …"). Text that came from outside (GitHub, a selection,
 * something typed) is refused when it contains any of it, so it cannot pass itself off as one of those messages. One definition, used by
 * every module that builds such a prompt.
 */
const OWN_MARKER = /task\s+from\s+the\s+administrator|administrator\s+broadcast|code\s+discussion\s+from\s+the\s+administrator|meeting\s+topic\s+from\s+the\s+administrator/i;

module.exports = { OWN_MARKER };
