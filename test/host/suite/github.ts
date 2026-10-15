import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
// The same module file the extension loaded, so the overrides apply to the running extension.
// They are accepted only while the editor runs in test mode.
import { GITHUB_COMMANDS, githubTreeForTests, installTestOverrides } from '../../../src/github/githubCommands';
import { GITHUB_TREE_COMMANDS } from '../../../src/github/githubTree';

// Drives the GitHub commands in non-interactive form inside a real Extension Host. Every
// answer comes from a synthetic fetch; nothing here contacts GitHub or uses a real account.
const TOKEN = 'synthetic-host-test-token-0000';
const REPO = 'example-org/example-repo';
const WEB = 'https://github.com/example-org/example-repo';

interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  status?: string;
  items?: Array<{ number: number; title: string; url: string; state: string }>;
  url?: string;
  opened?: boolean | string | null;
}

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
}

type Handler = (url: URL) => Response | Promise<Response>;

function fakeFetch(handler: Handler, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ method: init?.method ?? 'GET', url: url.href, authorization: headers.authorization ?? headers.Authorization });
    return handler(url);
  }) as typeof fetch;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const issue = (number: number, title: string): Record<string, unknown> => ({
  number, title, state: 'open', user: { login: 'pm-user' }, labels: [], assignees: [], comments: 0, html_url: `${WEB}/issues/${number}`
});

async function run<T = Outcome>(command: string, options: Record<string, unknown>): Promise<T> {
  return (await vscode.commands.executeCommand<T>(command, options)) as T;
}

export async function runGitHubChecks(registered: string[]): Promise<string> {
  for (const id of Object.values(GITHUB_COMMANDS)) assert.ok(registered.includes(id), `${id} is registered`);

  // 1. Anonymous read: a GET to the API host, no credential, links built locally.
  const seen: Seen[] = [];
  installTestOverrides({
    fetch: fakeFetch((url) => {
      if (url.pathname === '/repos/example-org/example-repo/issues') {
        return reply(200, [issue(12, 'Synthetic issue'), { ...issue(13, 'A pull request'), pull_request: { url: 'x' } }]);
      }
      return reply(404, { message: 'Not Found' });
    }, seen),
    getToken: async () => undefined
  });
  const listed = await run(GITHUB_COMMANDS.browse, { interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.items?.map((item) => [item.number, item.url]), [[12, `${WEB}/issues/12`]]);
  assert.deepEqual(seen.map((entry) => [entry.method, new URL(entry.url).hostname, entry.authorization]), [['GET', 'api.github.com', undefined]]);

  // 2. A credential reaches only the API host, in the Authorization header, and nowhere else.
  const authed: Seen[] = [];
  installTestOverrides({
    fetch: fakeFetch(() => reply(200, [issue(1, 'Synthetic issue')]), authed),
    getToken: async () => TOKEN
  });
  const withToken = await run(GITHUB_COMMANDS.browse, { interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(withToken.ok, true);
  assert.ok(authed.length >= 1);
  for (const entry of authed) {
    assert.equal(new URL(entry.url).hostname, 'api.github.com');
    assert.equal(entry.authorization, `Bearer ${TOKEN}`);
    assert.equal(entry.url.includes(TOKEN), false);
  }
  assert.equal(JSON.stringify(withToken).includes(TOKEN), false, 'the token is not in the result');

  // 3. A command argument cannot choose the transport or the credential.
  const injected: Seen[] = [];
  installTestOverrides({ fetch: fakeFetch(() => reply(200, []), injected), getToken: async () => undefined });
  let smuggled = false;
  const attempt = await run(GITHUB_COMMANDS.browse, {
    interactive: false, repository: REPO, kind: 'issues',
    fetch: () => { smuggled = true; }, transport: () => { smuggled = true; }, token: 'attacker-chosen-token', getToken: () => 'attacker-chosen-token'
  });
  assert.equal(attempt.ok, true);
  assert.equal(smuggled, false, 'an argument is never called as a transport');
  assert.deepEqual(injected.map((entry) => entry.authorization), [undefined]);

  // 4. Failures are failures, not empty lists.
  installTestOverrides({ fetch: fakeFetch(() => reply(403, { message: 'SYNTHETIC-REMOTE-TEXT' }), []), getToken: async () => undefined });
  const denied = await run(GITHUB_COMMANDS.browse, { interactive: false, repository: REPO, kind: 'issues' });
  assert.deepEqual([denied.ok, denied.code], [false, 'denied']);
  assert.equal('items' in denied, false);
  assert.equal(JSON.stringify(denied).includes('SYNTHETIC-REMOTE-TEXT'), false, 'remote text is not repeated');
  installTestOverrides({
    fetch: (() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch,
    getToken: async () => undefined
  });
  const offline = await run(GITHUB_COMMANDS.browse, { interactive: false, repository: REPO, kind: 'issues' });
  assert.deepEqual([offline.ok, offline.code], [false, 'offline']);

  // 5. Switching repository cancels the earlier read, and its late answer is not shown.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  installTestOverrides({
    fetch: fakeFetch(async (url) => {
      if (url.pathname.includes('/first/')) {
        await held;
        return reply(200, [issue(1, 'Late answer for the first repository')]);
      }
      return reply(200, [issue(2, 'Second repository')]);
    }, []),
    getToken: async () => undefined
  });
  const first = run(GITHUB_COMMANDS.browse, { interactive: false, repository: 'example-org/first', kind: 'issues' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await run(GITHUB_COMMANDS.browse, { interactive: false, repository: 'example-org/second', kind: 'issues' });
  release?.();
  const firstResult = await first;
  assert.equal(second.ok, true);
  assert.deepEqual([firstResult.ok, firstResult.code], [false, 'cancelled']);
  assert.equal(JSON.stringify(firstResult).includes('Late answer'), false);

  // 6. Pages are built locally and opened only when asked, and only through the editor's opener.
  const opened: string[] = [];
  installTestOverrides({ fetch: fakeFetch(() => reply(500, {}), []), openExternal: async (url) => { opened.push(url); return true; } });
  const issuePage = await run(GITHUB_COMMANDS.openIssue, { interactive: false, repository: REPO, number: 12 });
  const pullPage = await run(GITHUB_COMMANDS.openPullRequest, { interactive: false, repository: REPO, number: 7 });
  const checksPage = await run(GITHUB_COMMANDS.openChecks, { interactive: false, repository: REPO, number: 7, open: true });
  assert.deepEqual([issuePage.url, pullPage.url, checksPage.url], [`${WEB}/issues/12`, `${WEB}/pull/7`, `${WEB}/pull/7/checks`]);
  assert.deepEqual([issuePage.opened, pullPage.opened, checksPage.opened], [false, false, true]);
  assert.deepEqual(opened, [`${WEB}/pull/7/checks`]);

  // 7. Bad input is refused before anything is built.
  const badRepository = await run(GITHUB_COMMANDS.openIssue, { interactive: false, repository: '../x', number: 1 });
  const badNumber = await run(GITHUB_COMMANDS.openIssue, { interactive: false, repository: REPO, number: 0 });
  const noRepository = await run(GITHUB_COMMANDS.openIssue, { interactive: false, number: 1 });
  assert.deepEqual([badRepository.code, badNumber.code, noRepository.code], ['repository-invalid', 'number-invalid', 'repository-required']);

  // 8. The persistent view lists work without a number, and opens issue content inside VS Code.
  const workspace = process.env.MULTIAGENT_TEST_WORKSPACE;
  assert.ok(workspace);
  execFileSync('git', ['remote', 'add', 'origin', `${WEB}.git`], { cwd: workspace });
  const inEditorOpened: string[] = [];
  const pull = {
    number: 7, title: 'PR visible in tree', state: 'open', user: { login: 'worker' },
    body: 'Actual pull request body in editor', head: { sha: 'a'.repeat(40), ref: 'feature' },
    base: { sha: 'b'.repeat(40), ref: 'main' }, html_url: `${WEB}/pull/7`
  };
  installTestOverrides({
    fetch: fakeFetch((url) => {
      if (url.pathname === '/repos/example-org/example-repo/issues') return reply(200, [issue(12, 'Issue visible in tree')]);
      if (url.pathname === '/repos/example-org/example-repo/issues/12') return reply(200, { ...issue(12, 'Issue visible in tree'), body: 'Actual issue body in editor' });
      if (url.pathname === '/repos/example-org/example-repo/pulls') return reply(200, [pull]);
      if (url.pathname === '/repos/example-org/example-repo/pulls/7') return reply(200, pull);
      return reply(404, {});
    }, []),
    getToken: async () => undefined,
    openExternal: async (url) => { inEditorOpened.push(url); return true; }
  });
  assert.ok(registered.includes(GITHUB_TREE_COMMANDS.refresh));
  assert.ok(registered.includes(GITHUB_TREE_COMMANDS.openItem));
  const tree = githubTreeForTests();
  const categories = await tree.getChildren();
  assert.deepEqual(categories.map((item) => item.label), ['Issues', 'Pull requests']);
  const items = await tree.getChildren(categories[0]);
  const picked = items.find((item) => item.label === '#12 Issue visible in tree');
  assert.ok(picked?.command, 'the issue appears in the persistent tree without a typed number');
  await vscode.commands.executeCommand(picked.command.command, ...(picked.command.arguments ?? []));
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /Actual issue body in editor/);
  const pullItems = await tree.getChildren(categories[1]);
  const pickedPull = pullItems.find((item) => item.label === '#7 PR visible in tree');
  assert.ok(pickedPull?.command, 'the pull request appears in the persistent tree without a typed number');
  await vscode.commands.executeCommand(pickedPull.command.command, ...(pickedPull.command.arguments ?? []));
  const pullDetail = vscode.window.activeTextEditor?.document.getText() ?? '';
  assert.match(pullDetail, /Actual pull request body in editor/);
  assert.match(pullDetail, /Review and CI/);
  assert.deepEqual(inEditorOpened, [], 'opening the tree entry does not leave VS Code');

  installTestOverrides({});
  return 'github host smoke: native tree lists issues without a number and opens body in editor; reads use GET to the API host only; failures, cancel and repository switch are reported';
}
