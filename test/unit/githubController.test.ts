import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createGitHubReadAdapter } from '../../packages/github-read-adapter/src';
import {
  Category,
  GitHubAdapter,
  GitHubController,
  GitHubUi,
  PickItem,
  PullRequestSnapshot,
  SignInOutcome,
  describeSnapshot,
  displayText,
  bodyText,
  isGitHubWebUrl,
  parseNumber,
  parseRepository
} from '../../src/github/controller';

// Everything here is synthetic: no real account, repository, token or network.
const TOKEN = 'synthetic-token-for-tests-0000';
const SHA = 'a'.repeat(40);
const WEB = 'https://github.com/example-org/example-repo';

interface Call {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}
interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}
type Route = (call: Call) => FakeResponse | Promise<FakeResponse>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse => ({ status, headers, body: JSON.stringify(body) });

class FakeGitHub {
  readonly calls: Call[] = [];
  private readonly routes: Array<{ method: string; path: RegExp; route: Route }> = [];

  on(method: string, path: RegExp, route: Route): this {
    this.routes.push({ method, path, route });
    return this;
  }

  readonly transport = async (request: { method: string; url: string; headers: Record<string, string> }): Promise<FakeResponse> => {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method, url: request.url, path: url.pathname,
      query: Object.fromEntries(url.searchParams), headers: request.headers
    };
    this.calls.push(call);
    for (const entry of this.routes) {
      if (entry.method === call.method && entry.path.test(call.path)) return entry.route(call);
    }
    return json(404, { message: 'Not Found' });
  };
}

const issue = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number, title: `Issue ${number}`, state: 'open', user: { login: 'pm-user' }, labels: [{ name: 'ready' }],
  assignees: [], comments: 0, html_url: `${WEB}/issues/${number}`, ...extra
});
const pull = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number, title: `PR ${number}`, state: 'open', draft: false, merged: false, user: { login: 'worker-user' }, labels: [],
  head: { sha: SHA, ref: 'feat/example' }, base: { ref: 'main', sha: 'c'.repeat(40) }, html_url: `${WEB}/pull/${number}`, ...extra
});

interface Interaction {
  errors: string[];
  infos: string[];
  warnings: string[];
  summaries: Array<{ title: string; lines: string[] }>;
  opened: string[];
  picks: string[];
  signIns: number;
  asked: string[];
}

class FakeUi implements GitHubUi {
  readonly log: Interaction = { errors: [], infos: [], warnings: [], summaries: [], opened: [], picks: [], signIns: 0, asked: [] };
  trusted = true;
  folders: string[] = [];
  pickedFolder: string | undefined;
  typedRepository: string | undefined;
  typedNumber: string | undefined;
  category: Category | undefined;
  choose: (items: PickItem<unknown>[]) => number | undefined = () => 0;
  cancelNow = false;
  openResult = true;
  signInResult: SignInOutcome = 'signed-in';
  /** When set, any prompt is a test failure: a non-interactive call must never reach the UI. */
  forbidPrompts = false;

  private prompt(name: string): void {
    this.log.asked.push(name);
    if (this.forbidPrompts) throw new Error(`unexpected prompt: ${name}`);
  }

  isTrusted(): boolean { return this.trusted; }
  workspaceFolders(): string[] { return this.folders; }
  async pickProjectFolder(): Promise<string | undefined> { this.prompt('pickProjectFolder'); return this.pickedFolder; }
  async askRepository(): Promise<string | undefined> { this.prompt('askRepository'); return this.typedRepository; }
  async askNumber(): Promise<string | undefined> { this.prompt('askNumber'); return this.typedNumber; }
  async pickCategory(items: PickItem<Category>[]): Promise<PickItem<Category> | undefined> {
    this.prompt('pickCategory');
    return items.find((item) => item.value === this.category);
  }
  async pickItem<T>(items: PickItem<T>[], placeholder: string): Promise<PickItem<T> | undefined> {
    this.prompt('pickItem');
    this.log.picks.push(placeholder);
    const index = this.choose(items as PickItem<unknown>[]);
    return index === undefined ? undefined : items[index];
  }
  async withProgress<T>(_title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.forbidPrompts) throw new Error('unexpected progress');
    const controller = new AbortController();
    if (this.cancelNow) queueMicrotask(() => controller.abort());
    return task(controller.signal);
  }
  showSummary(title: string, lines: string[]): void { this.log.summaries.push({ title, lines }); }
  async openExternal(url: string): Promise<boolean> { this.log.opened.push(url); return this.openResult; }
  async signIn(): Promise<SignInOutcome> { this.log.signIns += 1; return this.signInResult; }
  info(message: string): void { this.log.infos.push(message); }
  warn(message: string): void { this.log.warnings.push(message); }
  error(message: string): void { this.log.errors.push(message); }
}

interface Rig {
  github: FakeGitHub;
  ui: FakeUi;
  controller: GitHubController;
  clock: { now: number };
  origin: { value: string | null | Error };
  originCalls: string[];
}

function rig(options: { token?: string | undefined | Error; maxPages?: number } = {}): Rig {
  const github = new FakeGitHub();
  const ui = new FakeUi();
  const clock = { now: Date.parse('2026-10-14T12:00:00Z') };
  const origin: { value: string | null | Error } = { value: 'github.com/example-org/example-repo' };
  const originCalls: string[] = [];
  const adapter = createGitHubReadAdapter({
    transport: github.transport,
    getToken: async () => {
      if (options.token instanceof Error) throw options.token;
      return options.token;
    },
    now: () => clock.now,
    sleep: async () => undefined,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    cacheTtlMs: 1000,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages })
  }) as unknown as GitHubAdapter;
  const controller = new GitHubController({
    ui,
    adapter: () => adapter,
    resolveOriginRepository: async (folder) => {
      originCalls.push(folder);
      if (origin.value instanceof Error) throw origin.value;
      return origin.value;
    }
  });
  return { github, ui, controller, clock, origin, originCalls };
}

const ISSUES = /\/repos\/example-org\/example-repo\/issues$/;
const PULLS = /\/repos\/example-org\/example-repo\/pulls$/;
const REPO = 'example-org/example-repo';

// ---- reading and listing ----------------------------------------------------

test('issues are listed from GET requests only, pull requests among them are left out, and links are exact', async () => {
  const { github, ui, controller } = rig();
  ui.forbidPrompts = true;
  github.on('GET', ISSUES, () => json(200, [issue(12, { title: 'Real issue' }), issue(13, { pull_request: { url: 'x' } }), issue(14)]));
  const result = await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items.map((item) => item.number), [12, 14]);
  assert.deepEqual(result.items.map((item) => item.url), [`${WEB}/issues/12`, `${WEB}/issues/14`]);
  assert.equal(result.items[0].title, 'Real issue');
  assert.equal(result.opened, null, 'nothing is opened unless asked');
  assert.deepEqual(github.calls.map((call) => call.method), ['GET']);
  assert.equal(github.calls[0].query.state, 'open');
  assert.equal(new URL(github.calls[0].url).origin, 'https://api.github.com');
});

test('pull requests are listed with their draft or merged state, and review and CI state is shown as not loaded', async () => {
  const { github, ui, controller } = rig();
  ui.forbidPrompts = true;
  github.on('GET', PULLS, () => json(200, [pull(7), pull(8, { draft: true }), pull(9, { merged: true })]));
  const result = await controller.browse({ interactive: false, repository: REPO, kind: 'pullRequests' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items.map((item) => [item.number, item.state]), [[7, 'open'], [8, 'draft'], [9, 'merged']]);
  for (const item of result.items) {
    assert.match(item.detail, /head aaaaaaa -> main/);
    assert.match(item.detail, /review and CI: not loaded/);
    assert.doesNotMatch(item.detail, /approved|passing|failing|pending/i, 'no state is guessed');
  }
  assert.equal(result.items[0].url, `${WEB}/pull/7`);
});

test('an empty list is confirmed as empty, and says so, rather than being a blank picker', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', ISSUES, () => json(200, []));
  ui.category = 'issues';
  const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 'empty');
  assert.match(result.note ?? '', /confirmed there are no open issues/);
  assert.deepEqual(ui.log.picks, [], 'no picker is shown for nothing');
  assert.equal(ui.log.infos.length, 1);
  assert.deepEqual(ui.log.errors, []);
});

test('a failed read is a failure with its own message and never an empty list', async () => {
  const cases: Array<{ name: string; setup: (github: FakeGitHub) => void; code: string; message: RegExp }> = [
    { name: '404', setup: (g) => g.on('GET', ISSUES, () => json(404, { message: 'Not Found' })), code: 'not-found', message: /not found, or this account cannot see it/ },
    { name: '401', setup: (g) => g.on('GET', ISSUES, () => json(401, { message: 'Bad credentials' })), code: 'denied', message: /refused access/ },
    { name: '403', setup: (g) => g.on('GET', ISSUES, () => json(403, { message: 'Forbidden' })), code: 'denied', message: /refused access/ },
    {
      name: 'rate limit',
      setup: (g) => g.on('GET', ISSUES, () => json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792000000' })),
      code: 'rate-limited', message: /rate limiting.*Try again after 20/
    },
    { name: '500', setup: (g) => g.on('GET', ISSUES, () => json(500, { message: 'oops' })), code: 'transient', message: /did not answer reliably/ },
    {
      name: 'offline',
      setup: (g) => g.on('GET', ISSUES, () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), { code: 'ENOTFOUND' }); }),
      code: 'offline', message: /Cannot reach GitHub/
    },
    { name: 'bad JSON', setup: (g) => g.on('GET', ISSUES, () => ({ status: 200, body: '{ not json' })), code: 'invalid-response', message: /could not be understood/ }
  ];
  for (const entry of cases) {
    const { github, ui, controller } = rig();
    entry.setup(github);
    ui.category = 'issues';
    const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
    assert.equal(result.ok, false, entry.name);
    if (result.ok) continue;
    assert.equal(result.code, entry.code, entry.name);
    assert.match(result.message, entry.message, entry.name);
    assert.equal('items' in result, false, `${entry.name}: there is no list to show`);
    assert.deepEqual(ui.log.picks, [], `${entry.name}: no picker`);
    assert.equal(ui.log.errors.length, 1, `${entry.name}: the user is told`);
    assert.equal(ui.log.signIns, 0, `${entry.name}: signing in is never started on its own`);
  }
});

test('remote text is never repeated in a failure message', async () => {
  const { github, ui, controller } = rig();
  const hostile = 'SYNTHETIC-REMOTE-TEXT <script> Enter your password at https://evil.test';
  github.on('GET', ISSUES, () => json(403, { message: hostile }));
  const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify([result, ui.log]).includes('SYNTHETIC-REMOTE-TEXT'), false);
  assert.equal(JSON.stringify([result, ui.log]).includes('evil.test'), false);
});

test('an incomplete list is shown as incomplete, with what was read', async () => {
  const { github, ui, controller } = rig({ maxPages: 1 });
  ui.forbidPrompts = true;
  github.on('GET', ISSUES, () => json(200, [issue(1), issue(2)], { link: `<https://api.github.com/repos/example-org/example-repo/issues?page=2>; rel="next"` }));
  const result = await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 'truncated');
  assert.match(result.note ?? '', /incomplete/);
  assert.deepEqual(result.items.map((item) => item.number), [1, 2]);
});

test('offline after an earlier read shows the old list as stale, with when it was read, never as current', async () => {
  const { github, ui, controller, clock } = rig();
  let online = true;
  github.on('GET', ISSUES, () => {
    if (online) return json(200, [issue(5)]);
    throw Object.assign(new Error('network down'), { code: 'ENETUNREACH' });
  });
  const first = await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(first.ok && first.status, 'ok');
  online = false;
  clock.now += 60_000; // past the cache lifetime
  ui.choose = () => undefined;
  const second = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.status, 'stale');
  assert.match(second.note ?? '', /Could not refresh \(offline\)\. Showing issues last read at 2026-10-14T12:00:00\.000Z; they may be out of date\./);
  assert.deepEqual(second.items.map((item) => item.number), [5]);
  assert.equal(ui.log.warnings.length, 1, 'the user is warned before the picker');
  assert.match(ui.log.picks[0], /\(stale\)/);
});

test('an access failure never falls back to old data, even when some is cached', async () => {
  const { github, ui, controller, clock } = rig();
  let allowed = true;
  github.on('GET', ISSUES, () => (allowed ? json(200, [issue(5)]) : json(403, { message: 'Forbidden' })));
  await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  allowed = false;
  clock.now += 60_000;
  const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, false);
  assert.deepEqual(ui.log.picks, [], 'what the account may no longer see is not shown');
});

// ---- cancel and repository switching -----------------------------------------

test('cancelling a read ends it silently: no message, no list, nothing opened', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', ISSUES, () => new Promise<FakeResponse>(() => undefined)); // never answers
  ui.cancelNow = true;
  const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.deepEqual(result, { ok: false, code: 'cancelled', message: 'Cancelled.' });
  assert.deepEqual([ui.log.errors, ui.log.infos, ui.log.warnings, ui.log.picks, ui.log.opened], [[], [], [], [], []]);
});

test('switching repository cancels the earlier read, and its late answer is never shown', async () => {
  const { github, ui, controller } = rig();
  ui.forbidPrompts = true;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  github.on('GET', /\/repos\/example-org\/first\/issues$/, async () => { await held; return json(200, [issue(1, { title: 'Late answer for the first repository' })]); });
  github.on('GET', /\/repos\/example-org\/second\/issues$/, () => json(200, [issue(2, { title: 'Second repository' })]));

  const first = controller.browse({ interactive: false, repository: 'example-org/first', kind: 'issues' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await controller.browse({ interactive: false, repository: 'example-org/second', kind: 'issues' });
  release?.();
  const firstResult = await first;

  assert.equal(second.ok, true);
  assert.equal(second.ok && second.items[0].title, 'Second repository');
  assert.deepEqual(firstResult, { ok: false, code: 'cancelled', message: 'Cancelled.' });
  assert.equal(JSON.stringify(firstResult).includes('Late answer'), false);
});

// ---- opening pages ----------------------------------------------------------

test('issue, pull request and checks pages are built locally, without a read, and opened only when asked', async () => {
  const { github, ui, controller } = rig();
  ui.forbidPrompts = true;
  const issueResult = await controller.openPage('issue', { interactive: false, repository: REPO, number: 12 });
  const pullResult = await controller.openPage('pullRequest', { interactive: false, repository: REPO, number: 7 });
  const checksResult = await controller.openPage('checks', { interactive: false, repository: REPO, number: 7 });
  assert.deepEqual(issueResult, { ok: true, url: `${WEB}/issues/12`, opened: false });
  assert.deepEqual(pullResult, { ok: true, url: `${WEB}/pull/7`, opened: false });
  assert.deepEqual(checksResult, { ok: true, url: `${WEB}/pull/7/checks`, opened: false });
  assert.deepEqual(ui.log.opened, []);
  assert.equal(github.calls.length, 0, 'no network is needed to build a link');

  const opened = await controller.openPage('checks', { interactive: false, repository: REPO, number: 7, open: true });
  assert.deepEqual(opened, { ok: true, url: `${WEB}/pull/7/checks`, opened: true });
  assert.deepEqual(ui.log.opened, [`${WEB}/pull/7/checks`]);
});

test('a browser that cannot be opened is reported, not claimed as opened', async () => {
  const { ui, controller } = rig();
  ui.openResult = false;
  const result = await controller.openPage('issue', { interactive: false, repository: REPO, number: 1, open: true });
  assert.deepEqual(result, { ok: false, code: 'open-failed', message: 'The browser could not be opened.' });
});

test('numbers and repositories are checked before anything is built', async () => {
  const { ui, controller } = rig();
  ui.forbidPrompts = true;
  for (const number of [0, -1, 1.5, Number.NaN, 1e12, '7', null]) {
    const result = await controller.openPage('issue', { interactive: false, repository: REPO, number: number as unknown as number });
    assert.equal(result.ok, false, String(number));
    assert.equal(!result.ok && result.code, 'number-invalid', String(number));
  }
  const missing = await controller.openPage('issue', { interactive: false, repository: REPO });
  assert.equal(!missing.ok && missing.code, 'number-required');
  const noRepository = await controller.openPage('issue', { interactive: false, number: 1 });
  assert.equal(!noRepository.ok && noRepository.code, 'repository-required');
  for (const repository of ['a', 'a/b/c', '../x', 'a/..', 'a/b?x=1', 'a b/c', '', 'a/b#frag']) {
    const result = await controller.openPage('issue', { interactive: false, repository, number: 1 });
    assert.equal(!result.ok && result.code, 'repository-invalid', JSON.stringify(repository));
  }
  const kind = await controller.browse({ interactive: false, repository: REPO, kind: 'projects' as unknown as Category });
  assert.equal(!kind.ok && kind.code, 'kind-invalid');
  const noKind = await controller.browse({ interactive: false, repository: REPO });
  assert.equal(!noKind.ok && noKind.code, 'kind-required');
});

test('only https pages on github.com are ever handed to the browser', () => {
  for (const good of [`${WEB}/issues/1`, 'https://github.com/a/b/pull/2/checks', 'https://github.com/']) {
    assert.equal(isGitHubWebUrl(good), true, good);
  }
  for (const bad of [
    'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://evil.test/github.com/a/b', 'https://github.com@evil.test/a/b',
    'https://user:pass@github.com/a/b', 'https://github.com:8443/a/b', 'javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y',
    'https://gist.github.com/a', 'https://api.github.com/repos/a/b', '//github.com/a/b', 'github.com/a/b',
    'https://github.com\\@evil.test/a/b', 'https://github.com/%5c@evil.test/a/b', 'https://github.com/a/%2fb',
    'HTTPS://GITHUB.COM/a/b', ' https://github.com/a/b', 'https://github.com/a/b\n', '', null, undefined, 42
  ]) {
    assert.equal(isGitHubWebUrl(bad), false, String(bad));
  }
});

// ---- repository, number and text parsing ------------------------------------

test('repositories are accepted as owner/name or a GitHub address, and nothing else', () => {
  assert.deepEqual(parseRepository('example-org/example-repo'), { owner: 'example-org', name: 'example-repo' });
  assert.deepEqual(parseRepository('  github.com/example-org/example-repo '), { owner: 'example-org', name: 'example-repo' });
  assert.deepEqual(parseRepository('https://github.com/example-org/example-repo.git'), { owner: 'example-org', name: 'example-repo' });
  assert.deepEqual(parseRepository('https://www.github.com/o/n/'), { owner: 'o', name: 'n' });
  assert.deepEqual(parseRepository('owner/na.me_1-x'), { owner: 'owner', name: 'na.me_1-x' });
  assert.deepEqual(parseRepository('a/b\n'), { owner: 'a', name: 'b' }, 'whitespace around pasted text is ignored');
  for (const bad of ['https://gitlab.com/a/b', 'git@github.com:a/b', 'a', 'a/', '/b', 'a/b/c', 'a/b/pull/1', '../b', 'a/..', './b', 'a/.', 'a/b c', 'a/b;rm', 'a/b\nrm -rf', 'a\n/b', '', 7, null, {}]) {
    assert.equal(parseRepository(bad), null, JSON.stringify(bad));
  }
});

test('numbers must be positive integers', () => {
  assert.equal(parseNumber('12'), 12);
  assert.equal(parseNumber('#12'), 12);
  assert.equal(parseNumber(12), 12);
  for (const bad of ['0', '-1', '1.5', '1e3', '12a', '', ' ', '9999999999', 0, -3, Number.NaN, null, undefined, {}]) {
    assert.equal(parseNumber(bad), null, JSON.stringify(bad));
  }
});

test('titles, labels and logins from GitHub are shown as plain single-line text of limited length', async () => {
  const hidden = ['\u202e', '\u200b', '\u2066', '\u2069', '\ufeff', '\u0007', '\u0085', '\u2028'];
  const hostile = `evil${hidden.join('')}title\nwith\tbreaks${'x'.repeat(300)}`;
  const text = displayText(hostile, 100);
  assert.ok(text.length <= 100);
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    assert.ok(code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f), `U+${code.toString(16)} is not shown`);
    assert.ok(!(code >= 0x200b && code <= 0x200f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069) && code !== 0xfeff && code !== 0x2028);
  }
  assert.match(text, /^evil +title with breaks/);
  assert.equal(displayText(42), '');
  assert.equal(displayText(undefined), '');

  const { github, controller, ui } = rig();
  ui.forbidPrompts = true;
  github.on('GET', ISSUES, () => json(200, [issue(1, { title: hostile, labels: [{ name: `bad\u202elabel` }], user: { login: 'a\u200bb' } })]));
  const result = await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const shown of [result.items[0].title, result.items[0].detail]) {
    assert.equal([...shown].some((char) => (char.codePointAt(0) ?? 0) > 0x2000 && (char.codePointAt(0) ?? 0) < 0x2070), false);
  }
});

// ---- choosing the repository --------------------------------------------------

test('the repository comes from the GitHub origin of the workspace without asking', async () => {
  const { github, ui, controller, originCalls } = rig();
  ui.folders = ['/workspace/project'];
  ui.category = 'issues';
  ui.choose = () => undefined;
  github.on('GET', ISSUES, () => json(200, [issue(1)]));
  const result = await controller.browse({ interactive: true });
  assert.equal(result.ok && result.repository, REPO);
  assert.deepEqual(originCalls, ['/workspace/project']);
  assert.deepEqual(ui.log.asked, ['pickCategory', 'pickItem'], 'the repository itself was never asked for');
});

test('without a GitHub origin the user is asked, and what they type is checked', async () => {
  for (const origin of [null, new Error('not a git repository')] as const) {
    const { github, ui, controller, origin: setting } = rig();
    setting.value = origin;
    ui.folders = ['/workspace/project'];
    ui.typedRepository = 'https://github.com/example-org/example-repo';
    ui.category = 'issues';
    ui.choose = () => undefined;
    github.on('GET', ISSUES, () => json(200, [issue(1)]));
    const result = await controller.browse({ interactive: true });
    assert.equal(result.ok && result.repository, REPO);
    assert.ok(ui.log.asked.includes('askRepository'));
  }
  const { ui, controller } = rig();
  ui.typedRepository = 'not a repository';
  const refused = await controller.browse({ interactive: true, kind: 'issues' });
  assert.equal(!refused.ok && refused.code, 'repository-invalid');
  ui.typedRepository = undefined;
  const dismissed = await controller.browse({ interactive: true, kind: 'issues' });
  assert.equal(!dismissed.ok && dismissed.code, 'cancelled');
});

test('an untrusted workspace is never asked for its origin, and several folders ask which one', async () => {
  const untrusted = rig();
  untrusted.ui.trusted = false;
  untrusted.ui.folders = ['/workspace/project'];
  untrusted.ui.typedRepository = REPO;
  untrusted.github.on('GET', ISSUES, () => json(200, []));
  const result = await untrusted.controller.browse({ interactive: true, kind: 'issues' });
  assert.equal(result.ok, true);
  assert.deepEqual(untrusted.originCalls, [], 'git is not run in a workspace the user has not trusted');
  assert.ok(untrusted.ui.log.asked.includes('askRepository'));

  const several = rig();
  several.ui.folders = ['/workspace/a', '/workspace/b'];
  several.ui.pickedFolder = '/workspace/b';
  several.github.on('GET', ISSUES, () => json(200, []));
  await several.controller.browse({ interactive: true, kind: 'issues' });
  assert.deepEqual(several.originCalls, ['/workspace/b']);
  several.ui.pickedFolder = undefined;
  const dismissed = await several.controller.browse({ interactive: true, kind: 'issues' });
  assert.equal(!dismissed.ok && dismissed.code, 'cancelled');
  assert.deepEqual(several.originCalls, ['/workspace/b'], 'nothing is read for a folder that was not chosen');
});

// ---- interactive flows --------------------------------------------------------

test('picking an issue opens that issue', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', ISSUES, () => json(200, [issue(12), issue(14)]));
  ui.category = 'issues';
  ui.choose = () => 1;
  const result = await controller.browse({ interactive: true, repository: REPO });
  assert.equal(result.ok && result.opened, `${WEB}/issues/14`);
  assert.deepEqual(ui.log.opened, [`${WEB}/issues/14`]);
});

test('picking a pull request offers its pages, and opens the one chosen', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', PULLS, () => json(200, [pull(7)]));
  ui.category = 'pullRequests';
  const pages: string[][] = [];
  let step = 0;
  ui.choose = (items) => {
    step += 1;
    if (step === 1) return 0; // the pull request
    pages.push(items.map((item) => item.label));
    return 1; // "Open checks"
  };
  const result = await controller.browse({ interactive: true, repository: REPO });
  assert.equal(result.ok && result.opened, `${WEB}/pull/7/checks`);
  assert.deepEqual(pages, [['Open pull request', 'Open checks', 'Open changed files', 'Read review and CI status here']]);
  assert.deepEqual(ui.log.opened, [`${WEB}/pull/7/checks`]);
});

test('dismissing any picker opens nothing and reads nothing further', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', ISSUES, () => json(200, [issue(1)]));
  ui.category = 'issues';
  ui.choose = () => undefined;
  const result = await controller.browse({ interactive: true, repository: REPO });
  assert.equal(result.ok && result.opened, null);
  assert.deepEqual(ui.log.opened, []);
  ui.category = undefined;
  const none = await controller.browse({ interactive: true, repository: REPO });
  assert.equal(!none.ok && none.code, 'cancelled');
});

// ---- credentials --------------------------------------------------------------

test('a signed-in token goes only to the API host, only in the Authorization header, and appears nowhere else', async () => {
  const { github, ui, controller } = rig({ token: TOKEN });
  github.on('GET', ISSUES, () => json(200, [issue(1)]));
  github.on('GET', PULLS, () => json(401, { message: 'Bad credentials' }));
  ui.category = 'issues';
  ui.choose = () => 0;
  const ok = await controller.browse({ interactive: true, repository: REPO });
  ui.category = 'pullRequests';
  const denied = await controller.browse({ interactive: true, repository: REPO });
  const link = await controller.openPage('issue', { interactive: false, repository: REPO, number: 1, open: true });

  assert.ok(github.calls.length >= 2);
  for (const call of github.calls) {
    assert.equal(new URL(call.url).hostname, 'api.github.com');
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.url.includes(TOKEN), false, 'the token is not in the address');
  }
  assert.equal(JSON.stringify([ok, denied, link, ui.log]).includes(TOKEN), false, 'not in results, messages or opened pages');
});

test('without a sign-in the requests are anonymous', async () => {
  const { github, ui, controller } = rig({ token: undefined });
  ui.forbidPrompts = true;
  github.on('GET', ISSUES, () => json(200, []));
  await controller.browse({ interactive: false, repository: REPO, kind: 'issues' });
  assert.equal(github.calls.length, 1);
  assert.equal('authorization' in github.calls[0].headers, false);
});

test('if the editor cannot supply the sign-in, the read is refused with that reason, not made anonymously', async () => {
  const { github, ui, controller } = rig({ token: new Error('SYNTHETIC-AUTH-DETAIL') });
  github.on('GET', ISSUES, () => json(200, [issue(1)]));
  const result = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'denied');
  assert.match(!result.ok ? result.message : '', /sign-in could not be read from the editor/);
  assert.equal(github.calls.length, 0, 'no request left the editor');
  assert.equal(JSON.stringify([result, ui.log]).includes('SYNTHETIC-AUTH-DETAIL'), false);
});

test('signing in happens only when asked, and its outcomes are reported plainly', async () => {
  const { ui, controller } = rig();
  assert.deepEqual(await controller.signIn(), { ok: true });
  assert.match(ui.log.infos[0], /stay read-only/);
  ui.signInResult = 'cancelled';
  assert.equal((await controller.signIn()).ok, false);
  ui.signInResult = 'unavailable';
  const unavailable = await controller.signIn();
  assert.equal(!unavailable.ok && unavailable.code, 'sign-in-unavailable');
  assert.equal(ui.log.errors.length, 1);
  assert.equal(ui.log.signIns, 3);
});

// ---- review and CI status -----------------------------------------------------

const snapshot = (extra: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  status: 'complete', consistent: true, headSha: SHA, readAt: '2026-10-14T12:00:00.000Z',
  pullRequest: { kind: 'ok' },
  approval: { status: 'approved', reason: 'approved_on_current_head' },
  checksSummary: { state: 'passing', requiredState: 'passing' },
  unresolvedThreads: 0, ...extra
});

test('status text says what was read, and shows everything that was not read as unknown', () => {
  const full = describeSnapshot(snapshot());
  assert.deepEqual(full, [
    'Head commit: aaaaaaa (read at 2026-10-14T12:00:00.000Z).',
    'The head did not change while this was read.',
    'Review: approved on the current head.',
    'CI checks: passing; required checks: passing.',
    'Unresolved review threads: 0.',
    'This is evidence read from GitHub, not a decision to merge. Merging stays with a person.'
  ]);

  const unknowns = describeSnapshot(snapshot({
    status: 'partial', consistent: false,
    approval: { status: 'unknown', reason: 'reviews_forbidden' },
    checksSummary: { state: 'unknown', requiredState: 'unknown', reason: 'checks_for_previous_head' },
    unresolvedThreads: null
  }));
  assert.match(unknowns[1], /head changed, or could not be confirmed/);
  assert.equal(unknowns[2], 'Review: unknown (reviews_forbidden).');
  assert.equal(unknowns[3], 'CI checks: unknown (checks_for_previous_head).');
  assert.equal(unknowns[4], 'Unresolved review threads: unknown.');

  assert.equal(describeSnapshot(snapshot({ approval: { status: 'not_approved', reason: 'approval_stale' } }))[2],
    'Review: not approved (the only approval is for an older head, so it no longer counts).');
  assert.equal(describeSnapshot(snapshot({ approval: { status: 'not_approved', reason: 'self_approval_only' } }))[2],
    "Review: not approved (only the author's own approval, which does not count).");
  assert.equal(describeSnapshot(snapshot({ approval: { status: 'changes_requested' } }))[2], 'Review: changes requested.');
  assert.equal(describeSnapshot(snapshot({ approval: undefined, checksSummary: undefined }))[2], 'Review: unknown (not read).');

  const unavailable = describeSnapshot(snapshot({ status: 'unavailable', headSha: null, pullRequest: { kind: 'not_found', possiblyHidden: true } }));
  assert.match(unavailable[0], /was not found, or this account cannot see it/);
  assert.equal(unavailable[1], 'Review and CI status: unknown.');
  assert.equal(JSON.stringify(full).match(/merge-ready|ready to merge/i), null, 'no verdict about merging is made');
});

test('reading the status of a pull request shows what could and could not be read', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', /\/pulls\/7$/, () => json(200, pull(7)));
  github.on('GET', /\/pulls\/7\/reviews$/, () => json(403, { message: 'Forbidden' })); // reviews cannot be read
  github.on('GET', /\/commits\/[0-9a-f]{40}\/check-runs$/, () => json(200, { total_count: 0, check_runs: [] }));
  github.on('GET', /\/commits\/[0-9a-f]{40}\/status$/, () => json(200, { state: 'pending', statuses: [] }));
  github.on('POST', /\/graphql$/, () => json(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }));
  const result = await controller.pullRequestStatus({ interactive: true, repository: REPO, number: 7 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(ui.log.summaries.length, 1);
  assert.equal(ui.log.summaries[0].title, `${REPO}#7`);
  assert.match(result.lines.join('\n'), /Review: unknown \(reviews_denied\)/, 'a review that could not be read is unknown, not "no approval"');
  assert.doesNotMatch(result.lines.join('\n'), /not approved/);
  assert.ok(github.calls.every((call) => call.method === 'GET' || (call.method === 'POST' && call.path.endsWith('/graphql'))),
    'only reads: GET, and the fixed GraphQL query');
});

test('a status read that is cancelled says nothing', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', /\/pulls\/7$/, () => new Promise<FakeResponse>(() => undefined));
  ui.cancelNow = true;
  const result = await controller.pullRequestStatus({ interactive: true, repository: REPO, number: 7 });
  assert.equal(!result.ok && result.code, 'cancelled');
  assert.deepEqual(ui.log.summaries, []);
});

test('picking "read status" from the list shows the summary and opens nothing', async () => {
  const { github, ui, controller } = rig();
  github.on('GET', PULLS, () => json(200, [pull(7)]));
  github.on('GET', /\/pulls\/7$/, () => json(404, { message: 'Not Found' }));
  ui.category = 'pullRequests';
  let step = 0;
  ui.choose = () => { step += 1; return step === 1 ? 0 : 3; };
  await controller.browse({ interactive: true, repository: REPO });
  assert.equal(ui.log.summaries.length, 1);
  assert.match(ui.log.summaries[0].lines[0], /was not found, or this account cannot see it/);
  assert.deepEqual(ui.log.opened, []);
});

test('error messages distinguish session expiration from transient errors and rate limits', async () => {
  const { github, controller } = rig();
  github.on('GET', ISSUES, () => json(401, { message: 'Bad credentials' }));
  const expired = await controller.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(!expired.ok && expired.code, 'denied');
  assert.match(!expired.ok ? expired.message : '', /Session expired or invalid.*Use "Multiagent: Sign In to GitHub"/);

  const { github: gRate, controller: cRate } = rig();
  gRate.on('GET', ISSUES, () => json(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792000000' }));
  const rateLimit = await cRate.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(!rateLimit.ok && rateLimit.code, 'rate-limited');
  assert.match(!rateLimit.ok ? rateLimit.message : '', /sign-in is intact/);
  assert.doesNotMatch(!rateLimit.ok ? rateLimit.message : '', /Signing in raises the limit/);

  const { github: gTransient, controller: cTransient } = rig();
  gTransient.on('GET', ISSUES, () => json(500, { message: 'Server error' }));
  const transient = await cTransient.browse({ interactive: true, repository: REPO, kind: 'issues' });
  assert.equal(!transient.ok && transient.code, 'transient');
  assert.match(!transient.ok ? transient.message : '', /temporary server or network issue.*retry automatically/);
});

test('bodyText keeps lines and tabs but replaces control, invisible and direction-changing characters, including the ones the old editor text let through', () => {
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);
  const hostile = `line one\r\n\tindented${cp(0x200e)}${cp(0x200f)}${cp(0x061c)}${cp(0xfeff)}${cp(0x2060)}${cp(0x2062)}${cp(0x2065)}${cp(0x85)}${cp(0x202e)}${cp(0x2066)}${cp(0)}end`;
  const out = bodyText(hostile);
  assert.equal(out, 'line one\r\n\tindented           end');
  for (const code of [0x200e, 0x200f, 0x061c, 0xfeff, 0x2060, 0x2062, 0x2065, 0x85, 0x202e, 0x2066, 0]) assert.equal(out.includes(cp(code)), false, code.toString(16));
  assert.equal(bodyText('x'.repeat(300_000)).length, 200_000, 'long bodies are capped');
  assert.equal(bodyText(undefined), '');
  assert.equal(bodyText(42), '');
});
