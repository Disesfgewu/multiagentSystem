import * as path from 'node:path';
import * as vscode from 'vscode';
import { privateStorage } from '../storage/storageCommands';
import { CANDIDATE_RESEARCH_TOOLS } from './catalog';
import { isExtensionTestMode, requireInteractive } from '../shared/testMode';

const {
  formatConsentManifest,
  listResearchTools,
  grantConsent,
  revokeConsent,
  prepareResearchTool,
  isConsentActive
} = require('./installer') as {
  formatConsentManifest(tool: any): string;
  listResearchTools(deps: { store?: any; catalog?: any[]; root?: string }): any[];
  grantConsent(serverId: string, deps: { store: any; catalog?: any[] }): { ok: boolean; record: any };
  revokeConsent(serverId: string, deps: { store: any; root?: string }): { ok: boolean; serverId: string; status: string; cleanup: 'none' | 'done' | 'failed' };
  prepareResearchTool(serverId: string, deps: { store: any; root: string; boundary?: string; download?: any; catalog?: any[]; assetBytes?: Uint8Array }): Promise<any>;
  isConsentActive(serverId: string, store: any): boolean;
};

export const RESEARCH_TOOL_SCHEME = 'multiagent-research-tool';

export const RESEARCH_COMMANDS = {
  listTools: 'multiagentSystem.research.listTools',
  reviewAndConsent: 'multiagentSystem.research.reviewAndConsent',
  revokeConsent: 'multiagentSystem.research.revokeConsent',
  inspectTool: 'multiagentSystem.research.inspectTool',
  prepareTool: 'multiagentSystem.research.prepareTool'
} as const;

export class ResearchToolManifestProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const serverId = uri.path.replace(/^\//, '').trim() || uri.authority;
    const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === serverId);
    if (!tool) {
      return `# Unknown Research Tool: ${serverId}\n\nThis tool is not part of the reviewed candidate academic catalog.\n`;
    }
    return formatConsentManifest(tool);
  }
}

async function getPrivateStore(): Promise<any> {
  const handle = privateStorage();
  const opened = await handle?.use();
  if (!opened?.ok) return undefined;
  return opened.store;
}

export function registerResearchCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const manifestProvider = new ResearchToolManifestProvider();
  const root = path.join(context.globalStorageUri.fsPath, 'managed-tools', 'research');
  const boundary = context.globalStorageUri.fsPath;

  const listTools = async () => {
    const store = await getPrivateStore();
    return listResearchTools({ store, root });
  };

  const inspectTool = async (serverId?: string) => {
    let id = serverId;
    if (!id) {
      const picked = await vscode.window.showQuickPick(
        CANDIDATE_RESEARCH_TOOLS.map((t) => ({ label: t.name, description: `${t.serverId} (${t.version})`, id: t.serverId })),
        { placeHolder: 'Select a research tool to inspect' }
      );
      if (!picked) return;
      id = picked.id;
    }
    const uri = vscode.Uri.parse(`${RESEARCH_TOOL_SCHEME}:/${id}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
    return { ok: true, uri: uri.toString() };
  };

  const reviewAndConsent = async (arg?: { serverId?: string; interactive?: boolean }) => {
    const interactive = requireInteractive(arg ?? {}).interactive !== false;
    let serverId = arg?.serverId;

    if (!serverId && interactive) {
      const store = await getPrivateStore();
      const current = listResearchTools({ store, root });
      const picked = await vscode.window.showQuickPick(
        current.map((t) => ({
          label: t.name,
          description: `${t.serverId} (${t.version}) · ${t.statusLabel}`,
          detail: `License: ${t.license} · Permissions: ${t.permissions.join(', ') || 'None'} · ${t.source}`,
          id: t.serverId
        })),
        { placeHolder: 'Choose a research tool to review and consent' }
      );
      if (!picked) return { ok: false, code: 'cancelled' };
      serverId = picked.id;
    }

    if (!serverId) {
      return { ok: false, code: 'server-id-required' };
    }

    const tool = CANDIDATE_RESEARCH_TOOLS.find((t) => t.serverId === serverId);
    if (!tool) {
      const msg = `Tool '${serverId}' is not in the reviewed candidate catalog.`;
      if (interactive) void vscode.window.showErrorMessage(msg);
      return { ok: false, code: 'tool-not-in-catalog', message: msg };
    }

    if (interactive) {
      const declared = listResearchTools({ catalog: [tool] })[0]?.permissions ?? [];
      const permissionsText = declared.length > 0 ? declared.join(', ') : 'None declared';
      const secretKeys = Object.keys((tool as any).env ?? {});
      const answer = await vscode.window.showWarningMessage(
        `Research MCP Tool Consent: ${tool.name} (${tool.serverId} ${tool.version})`,
        {
          modal: true,
          detail: [
            `Source Repository: ${tool.source}`,
            `License: ${tool.license}`,
            `Integrity Digest: ${tool.integrity}`,
            `Command: ${(tool as any).command?.join(' ') ?? 'unknown'}`,
            `Required secrets (SecretStorage only): ${secretKeys.length > 0 ? secretKeys.join(', ') : 'none'}`,
            `Required Permissions: ${permissionsText} (declared by the catalog; this extension does not enforce them)`,
            '',
            'All external literature and papers retrieved by this tool are strictly untrusted data.',
            'Read-only status is self-declared by tool schema (sandboxEnforced: false).',
            'Do you explicitly consent to enable this research tool?'
          ].join('\n')
        },
        'Consent & Enable',
        'Review Full Manifest'
      );

      if (answer === 'Review Full Manifest') {
        await inspectTool(serverId);
        return { ok: false, code: 'manifest-opened' };
      }

      if (answer !== 'Consent & Enable') {
        return { ok: false, code: 'cancelled' };
      }
    }

    const store = await getPrivateStore();
    if (!store) {
      const msg = 'Private storage is unavailable. Consent could not be recorded.';
      if (interactive) void vscode.window.showErrorMessage(msg);
      return { ok: false, code: 'storage-unavailable', message: msg };
    }

    try {
      const result = grantConsent(serverId, { store });
      if (interactive) {
        void vscode.window.showInformationMessage(`Explicit consent granted for '${tool.name}' (${tool.serverId}).`);
      }
      return { ok: true, serverId, record: result.record };
    } catch (err: any) {
      const msg = err?.message || 'Failed to grant consent.';
      if (interactive) void vscode.window.showErrorMessage(msg);
      return { ok: false, code: err?.code || 'grant-failed', message: msg };
    }
  };

  const revoke = async (arg?: { serverId?: string; interactive?: boolean }) => {
    const interactive = requireInteractive(arg ?? {}).interactive !== false;
    let serverId = arg?.serverId;

    const store = await getPrivateStore();
    if (!store) {
      const msg = 'Private storage is unavailable.';
      if (interactive) void vscode.window.showErrorMessage(msg);
      return { ok: false, code: 'storage-unavailable' };
    }

    if (!serverId && interactive) {
      const current = listResearchTools({ store, root }).filter((t) => t.consentStatus === 'consented');
      if (current.length === 0) {
        void vscode.window.showInformationMessage('No research tools currently have active consent.');
        return { ok: true, serverId: null };
      }
      const picked = await vscode.window.showQuickPick(
        current.map((t) => ({ label: t.name, description: `${t.serverId} (${t.version})`, id: t.serverId })),
        { placeHolder: 'Choose a tool to revoke consent and uninstall' }
      );
      if (!picked) return { ok: false, code: 'cancelled' };
      serverId = picked.id;
    }

    if (!serverId) return { ok: false, code: 'server-id-required' };
    // The id names a folder in private storage: refuse anything but a plain name before asking the user.
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(serverId) || serverId.includes('..')) return { ok: false, code: 'invalid-server-id' };

    if (interactive) {
      const answer = await vscode.window.showWarningMessage(
        `Revoke consent for research tool '${serverId}'?`,
        { modal: true, detail: 'The tool will be disabled and any installed files in private storage will be removed.' },
        'Revoke Consent'
      );
      if (answer !== 'Revoke Consent') return { ok: false, code: 'cancelled' };
    }

    const result = revokeConsent(serverId, { store, root });
    if (interactive) {
      if (result.cleanup === 'failed') void vscode.window.showWarningMessage(`Consent revoked for '${serverId}', but its installed files could not be fully removed. Delete the folder from private storage by hand.`);
      else void vscode.window.showInformationMessage(`Consent revoked for '${serverId}'. ${result.cleanup === 'done' ? 'Installed files were removed.' : 'Nothing was installed.'}`);
    }
    return result;
  };

  const prepareTool = async (arg?: { serverId?: string; assetBytes?: Uint8Array; download?: any }) => {
    const store = await getPrivateStore();
    if (!store) return { ok: false, code: 'storage-unavailable' };
    const serverId = arg?.serverId;
    if (!serverId) return { ok: false, code: 'server-id-required' };

    // Asset bytes and a download function in a command argument come from the caller, not from the
    // reviewed catalog source; only the extension's own tests may supply them (Refs #192). Without a
    // verified asset the installer writes nothing and reports `asset-unavailable`.
    const testMode = isExtensionTestMode();
    try {
      const outcome = await prepareResearchTool(serverId, {
        store,
        root,
        boundary,
        download: testMode ? arg?.download : undefined,
        assetBytes: testMode ? arg?.assetBytes : undefined
      });
      return { ok: true, outcome };
    } catch (err: any) {
      return { ok: false, code: err?.code || 'prepare-failed', message: err?.message };
    }
  };

  const disposable = vscode.Disposable.from(
    vscode.workspace.registerTextDocumentContentProvider(RESEARCH_TOOL_SCHEME, manifestProvider),
    vscode.commands.registerCommand(RESEARCH_COMMANDS.listTools, listTools),
    vscode.commands.registerCommand(RESEARCH_COMMANDS.inspectTool, inspectTool),
    vscode.commands.registerCommand(RESEARCH_COMMANDS.reviewAndConsent, reviewAndConsent),
    vscode.commands.registerCommand(RESEARCH_COMMANDS.revokeConsent, revoke),
    vscode.commands.registerCommand(RESEARCH_COMMANDS.prepareTool, prepareTool)
  );

  context.subscriptions.push(disposable);
  return disposable;
}
