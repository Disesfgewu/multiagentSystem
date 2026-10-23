'use strict';

/**
 * Whether the first-use download of the GitHub CLI is left out (#361). `mode` is VS Code's ExtensionMode (1 Production, 2 Development,
 * 3 Test). It is left out in the extension's own Extension Host tests, and in the end-to-end run, which starts VS Code with this
 * folder as a development extension and sets MULTIAGENT_E2E_NO_DOWNLOAD=1 so that the run never reaches the network. An installed
 * extension runs in Production mode, where nothing (no setting, no argument, no environment variable) leaves the download out.
 * Nothing here skips any verification of a download.
 */
const PRODUCTION = 1;
const DEVELOPMENT = 2;
const TEST = 3;

function skipsFirstUseDownload(mode, env) {
  if (mode === TEST) return true;
  return mode === DEVELOPMENT && Boolean(env) && env.MULTIAGENT_E2E_NO_DOWNLOAD === '1';
}

module.exports = { skipsFirstUseDownload, PRODUCTION, DEVELOPMENT, TEST };
