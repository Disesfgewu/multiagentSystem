import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { readProjectSnapshot, decisionCountsSnapshot } from '../reports/reportsView';
import { readTeamSnapshot } from '../commandCenter/commandCenter';

const { buildProjectReport } = require('./project-report') as {
  buildProjectReport(input: unknown): { ok: true; markdown: string; withheld: number } | { ok: false; reason: string };
};
const { describeDecisions } = require('../commandCenter/model') as { describeDecisions(counts: unknown): { issues: unknown; pullRequests: unknown } };
const { BroadcastStore } = require('../broadcast/store') as { BroadcastStore: new (store: any) => { list(): { ok: boolean; items?: unknown[] }; listDeliveries(): { ok: boolean; items?: unknown[] } } };
const { readMainHead } = require('../projects/gitEvidence') as { readMainHead(folder: string): Promise<unknown> };

export const EXPORT_COMMANDS = { projectReport: 'multiagentSystem.export.projectReport' } as const;

const REFUSALS: Record<string, string> = {
  'scan-failed': 'the privacy check could not run',
  'scan-incomplete': 'the privacy check could not look at everything',
  'scan-rejected': 'the finished report looked private as a whole',
  'invalid-time': 'the time could not be read'
};

/** Everything the report is built from, read now. A source that cannot be read is passed as unknown, never left out. */
async function gather(): Promise<Record<string, unknown>> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const [github, team, mainHead] = await Promise.all([
    readProjectSnapshot(),
    readTeamSnapshot(),
    folder ? readMainHead(folder) : Promise.resolve({ state: 'unknown', reason: 'no-folder' })
  ]);
  let broadcasts: unknown = null;
  try {
    const opened = await privateStorage()?.use();
    if (opened?.ok) {
      const store = new BroadcastStore(opened.store);
      const listed = store.list();
      const deliveries = store.listDeliveries();
      if (listed.ok) broadcasts = { items: listed.items ?? [], deliveries: deliveries.ok ? deliveries.items ?? [] : null };
    }
  } catch { broadcasts = null; }
  return { generatedAt: new Date(), repository: github.repository, mainHead, issues: github.issues, pullRequests: github.pullRequests, details: github.details, decisions: describeDecisions(decisionCountsSnapshot()), team, broadcasts };
}

/**
 * "Export Project Report (Markdown)" (issue #307). It takes no argument and opens the report in an UNSAVED editor: nothing is written to
 * the workspace or the repository unless the person chooses Save As. The text is built from what was read just now; whatever could
 * not be read is marked unknown in it.
 */
async function exportProjectReport(): Promise<void> {
  if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Trust this workspace before exporting a project report.'); return; }
  const built = buildProjectReport(await gather());
  if (!built.ok) { void vscode.window.showErrorMessage(`The project report was not made: ${REFUSALS[built.reason] ?? built.reason}.`); return; }
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: built.markdown });
  await vscode.window.showTextDocument(document, { preview: false });
  void vscode.window.showInformationMessage(`Project report opened (not saved).${built.withheld > 0 ? ` ${built.withheld} piece${built.withheld === 1 ? '' : 's'} of text looked private and ${built.withheld === 1 ? 'was' : 'were'} withheld.` : ''} Use Save As if you want a file.`);
}

export function registerExportCommands(context: vscode.ExtensionContext): void {
  // No argument is read: what is exported, and where, is decided here.
  context.subscriptions.push(vscode.commands.registerCommand(EXPORT_COMMANDS.projectReport, () => exportProjectReport()));
}
