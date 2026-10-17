import * as vscode from 'vscode';
import { GROUP_NAMES, terminalTitle } from '../agents';

// The root is split left-to-right; each root child is split top-to-bottom. ViewColumn order
// follows the grid order (top-left, bottom-left, top-right, bottom-right).
export const FOUR_TERMINAL_LAYOUT = {
  orientation: 0,
  groups: [
    { groups: [{}, {}] },
    { groups: [{}, {}] }
  ]
} as const;

const FOUR_TERMINAL_COLUMNS = [
  vscode.ViewColumn.One,
  vscode.ViewColumn.Two,
  vscode.ViewColumn.Three,
  vscode.ViewColumn.Four
] as const;

/** Opens the four native shells in an editor-area 2×2 grid. */
export async function openTerminalGroup(cwd: vscode.Uri): Promise<void> {
  const titles = GROUP_NAMES.map(terminalTitle);
  const existing = titles.map((title) => vscode.window.terminals.find((terminal) => terminal.name === title));
  const found = existing.filter((terminal): terminal is vscode.Terminal => terminal !== undefined);

  if (found.length > 0) {
    for (const terminal of found) terminal.show(true);
    if (found.length !== titles.length) {
      void vscode.window.showInformationMessage('Some Multiagent terminals are already open. Close the existing group before creating a fresh 2×2 group.');
    }
    return;
  }

  await vscode.commands.executeCommand('vscode.setEditorLayout', FOUR_TERMINAL_LAYOUT);
  for (let index = 0; index < GROUP_NAMES.length; index += 1) {
    const terminal = vscode.window.createTerminal({
      name: titles[index],
      cwd,
      location: { viewColumn: FOUR_TERMINAL_COLUMNS[index] }
    });
    terminal.show();
  }
  // The 2×2 grid is only a starting arrangement, not a lock: VS Code's own tab drag-and-drop already
  // works on these terminals like any other editor tab, so the only thing missing was telling the
  // user that. Shown only when a fresh group is created, not on every refocus of an existing one.
  void vscode.window.showInformationMessage('Four native terminals are arranged in a 2×2 grid. Drag any terminal\'s tab to another position to rearrange them, the same way you would drag any editor tab.');
}
