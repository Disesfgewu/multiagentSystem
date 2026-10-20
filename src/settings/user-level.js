'use strict';

/**
 * The one place that decides which value of a setting counts when the setting chooses something that RUNS (a
 * provider's program, an MCP server): only the value from the user's own settings. A value from the workspace, a
 * workspace folder or a language override can arrive with any repository that is opened, so it is never used and
 * never returned; the caller only learns that one was ignored, so the person can be told.
 *
 * It takes the result of `vscode.workspace.getConfiguration(...).inspect(key)` rather than calling `vscode`, so it is
 * tested without the editor. A setting declared with `"scope": "application"` is not read from the workspace by the
 * editor either; this is the second guard, in case a setting is ever declared without that scope.
 */

const IGNORED_SCOPES = Object.freeze(['workspaceValue', 'workspaceFolderValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue']);

/**
 * @param {object|undefined} inspected the editor's `inspect()` result for one setting
 * @returns {{ value: unknown, ignoredScopes: string[] }} `value` is the user-level value or `undefined`; the default value is never returned, because a default is not something the person chose
 */
function readUserLevel(inspected) {
  if (inspected === null || typeof inspected !== 'object' || Array.isArray(inspected)) return { value: undefined, ignoredScopes: [] };
  const ignoredScopes = IGNORED_SCOPES.filter((name) => Object.hasOwn(inspected, name) && inspected[name] !== undefined);
  const value = Object.hasOwn(inspected, 'globalValue') ? inspected.globalValue : undefined;
  return { value, ignoredScopes };
}

module.exports = { readUserLevel, IGNORED_SCOPES };
