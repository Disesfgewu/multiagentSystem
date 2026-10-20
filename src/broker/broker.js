'use strict';

const crypto = require('node:crypto');
const { evaluatePublishRequest } = require('../publish-policy');
const { scanPublication } = require('../publish/scan');
const { mergePullRequest } = require('../delivery/merge');

// The write broker core. Every GitHub write goes through one call that, in this order:
// checks the request shape, takes the caller's identity from a trusted source (never from the
// request), authorizes the operation by role, replays an earlier identical request instead of
// writing twice, scans the exact text that will be published, checks the preconditions against
// freshly read state, records an audit entry, and only then calls the injected transport.
//
// Everything outside is injected: `identity`, `reader`, `content`, `transport`, `audit`, `lock`.
// This module stores, reads and logs no GitHub credential; the transport owns any credential and
// the terminal never sees one. It cannot stop an agent from running `git`, `gh` or an HTTP call by
// itself: isolating those paths is the job of the managed-environment issues, not of this module.
//
// Every operation is denied unless listed here. The text that is scanned is the text that is
// passed to the transport: nothing is re-read or re-composed between the two.

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A branch name that is safe to put in a ref path: no `..`, no segment that starts with `.` or ends with `.lock`, no empty segment.
const safeRefName = (name) => typeof name === 'string' && BRANCH.test(name) && name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
const FORBIDDEN_FIELDS = ['actorId', 'role', 'token', 'credential', 'credentials', 'authorization', 'password', 'secret', 'headers'];
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const SCAN_OPTION_KEYS = ['memories', 'rules', 'knownValues'];
const MAX_TEXT_CHARS = 262144;
const MAX_DIFF_CHARS = 524288;
const STORE_COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const text = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT_CHARS;
const storeRecordId = (key) => `broker-req-${crypto.createHash('sha256').update(key).digest('hex')}`;

// field checks per operation; `roles` are who may ask, `policy` is how `publish-policy` sees it
const OPERATIONS = Object.freeze({
  createIssue: { roles: ['pm'], fields: { title: text, body: text } },
  editIssue: { roles: ['pm'], fields: { number: positive }, optional: { title: text, body: text } },
  closeIssue: { roles: ['pm'], fields: { number: positive, reason: (v) => v === 'completed' || v === 'not_planned' } },
  claimIssue: { roles: ['worker'], fields: { number: positive } },
  createPr: { roles: ['worker'], fields: { title: text, body: text, headBranch: (v) => typeof v === 'string' && BRANCH.test(v), headSha: (v) => typeof v === 'string' && SHA.test(v), baseBranch: (v) => typeof v === 'string' && BRANCH.test(v) } },
  commit: { roles: ['worker'], fields: { headSha: (v) => typeof v === 'string' && SHA.test(v) } },
  push: { roles: ['worker'], fields: { branch: (v) => typeof v === 'string' && BRANCH.test(v), headSha: (v) => typeof v === 'string' && SHA.test(v) } },
  comment: { roles: ['pm', 'worker'], fields: { target: (v) => v === 'issue' || v === 'pr', number: positive, body: text } },
  reviewPr: { roles: ['pm'], fields: { number: positive, decision: (v) => ['approve', 'request_changes', 'comment'].includes(v), body: text, expectedHeadSha: (v) => typeof v === 'string' && SHA.test(v) } },
  mergePr: { roles: ['pm'], fields: { number: positive } },
  deleteBranch: { roles: ['pm'], fields: { number: positive, expectedHeadSha: (v) => typeof v === 'string' && SHA.test(v) } }
});

/**
 * The permission each operation is expected to need from the GitHub credential the transport uses.
 * These are expectations for a person to check against the real App or account settings; none has
 * been verified against GitHub.
 */
const EXPECTED_PERMISSIONS = Object.freeze({
  createIssue: 'issues:write',
  editIssue: 'issues:write',
  closeIssue: 'issues:write',
  claimIssue: 'issues:write',
  createPr: 'pull_requests:write, contents:read',
  commit: 'contents:write',
  push: 'contents:write',
  comment: 'issues:write (issue) or pull_requests:write (pull request)',
  reviewPr: 'pull_requests:write',
  mergePr: 'pull_requests:write, contents:write',
  deleteBranch: 'contents:write'
});

const deny = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const fingerprint = (operation, payload) => crypto.createHash('sha256').update(`${operation}\0${stable(payload)}`).digest('hex');

function checkShape(operation, request) {
  const spec = OPERATIONS[operation];
  const { operation: _operation, requestId: _requestId, ...payload } = request;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_FIELDS.includes(key)) return { problem: 'identity-or-credential-in-request' };
    if (!Object.hasOwn(spec.fields, key) && !(spec.optional && Object.hasOwn(spec.optional, key))) return { problem: 'unknown-field' };
  }
  for (const [key, valid] of Object.entries(spec.fields)) if (!valid(payload[key])) return { problem: 'invalid-field' };
  for (const [key, valid] of Object.entries(spec.optional || {})) if (payload[key] !== undefined && !valid(payload[key])) return { problem: 'invalid-field' };
  if (operation === 'editIssue' && payload.title === undefined && payload.body === undefined) return { problem: 'invalid-field' };
  return { payload };
}

class Broker {
  /**
   * @param {object} deps
   * @param {{ current(): { actorId: string, role: string }, actorIdForLogin(login: string): string|null }} deps.identity trusted
   * @param {object} deps.reader read adapter: getIssue, getPullRequestSnapshot, getPullRequestPublication
   * @param {{ getCommitContent(headSha: string): Promise<{ complete: boolean, headSha: string, message: string, diff: string }> }} deps.content trusted local content
   * @param {object} deps.transport the only code that writes to GitHub and the only holder of a credential
   * @param {{ record(entry: object): void }} deps.audit
   * @param {{ pmActorId: string, pmLogin: string, mergeAuthority?: 'human'|'pm' }} deps.config
   * @param {{ repository: { owner: string, name: string } }} deps.project
   * @param {{ acquire(key: string): string|null, release(key: string, token: string): void }} [deps.lock] single writer for claims
   * @param {{ get(collection: string, id: string): object, put(collection: string, id: string, value: object): object, delete?(collection: string, id: string): object, names?: string[] }} [deps.store] PrivateStore for persistent idempotency
   * @param {string} [deps.storeCollection] collection name in `deps.store`
   * @param {object} [deps.scanOptions] extra private references for the content scan
   * @param {boolean} [deps.privateReferencesChecked]
   */
  constructor(deps = {}) {
    for (const name of ['identity', 'reader', 'transport', 'audit']) if (!isPlain(deps[name])) throw new TypeError(`${name} is required`);
    if (!isPlain(deps.config) || !text(deps.config.pmActorId) || !text(deps.config.pmLogin)) throw new TypeError('config.pmActorId and config.pmLogin are required');
    if (!isPlain(deps.project) || !isPlain(deps.project.repository)) throw new TypeError('project.repository is required');
    if (deps.store !== undefined && (!isPlain(deps.store) || typeof deps.store.get !== 'function' || typeof deps.store.put !== 'function')) {
      throw new TypeError('store must provide get and put');
    }
    if (deps.storeCollection !== undefined && (typeof deps.storeCollection !== 'string' || !STORE_COLLECTION.test(deps.storeCollection))) {
      throw new TypeError('storeCollection must be a valid collection identifier');
    }
    // Settings may add private reference material to the scan. They may never replace a detector.
    if (deps.scanOptions !== undefined && (!isPlain(deps.scanOptions) || Object.keys(deps.scanOptions).some((key) => !SCAN_OPTION_KEYS.includes(key)))) throw new TypeError('scanOptions may only hold memories, rules and knownValues');
    this.d = deps;
    this.storeCollection = deps.storeCollection ?? (Array.isArray(deps.store?.names) && deps.store.names.includes('brokerRequests') ? 'brokerRequests' : 'policies');
    this.done = new Map();
    this.unknown = new Map();
    this.inFlight = new Set();
  }

  #readStored(key) {
    if (!this.d.store) return { ok: true, found: false, value: null };
    let got;
    try {
      got = this.d.store.get(this.storeCollection, storeRecordId(key));
    } catch {
      return { ok: false };
    }
    if (!isPlain(got) || got.ok !== true) return { ok: false };
    if (!got.found) return { ok: true, found: false, value: null };
    const val = got.value;
    if (!isPlain(val) || typeof val.print !== 'string' || typeof val.operation !== 'string' || !['pending', 'done', 'unknown'].includes(val.state)) {
      return { ok: false };
    }
    if (val.state === 'done' && (!isPlain(val.result) || val.result.ok !== true)) return { ok: false };
    return { ok: true, found: true, value: val };
  }

  #writeStored(key, record) {
    if (!this.d.store) return true;
    try {
      const res = this.d.store.put(this.storeCollection, storeRecordId(key), { kind: 'broker-idempotency-v1', ...record });
      return isPlain(res) && res.ok === true;
    } catch {
      return false;
    }
  }

  #deleteStored(key) {
    if (!this.d.store || typeof this.d.store.delete !== 'function') return true;
    try {
      const res = this.d.store.delete(this.storeCollection, storeRecordId(key));
      return isPlain(res) && res.ok === true;
    } catch {
      return false;
    }
  }

  #matchesActor(actorId, loginOrId) {
    if (typeof loginOrId !== 'string' || loginOrId === '') return false;
    if (loginOrId === actorId) return true;
    try {
      return this.d.identity.actorIdForLogin(loginOrId) === actorId;
    } catch {
      return false;
    }
  }

  async #reconcileRemote(operation, payload, actor) {
    try {
      if (operation === 'mergePr') {
        const snapshot = await this.d.reader.getPullRequestSnapshot(payload.number, { forceRefresh: true });
        if (!isPlain(snapshot) || snapshot.status !== 'complete' || snapshot.consistent !== true || !isPlain(snapshot.pullRequest) || snapshot.pullRequest.kind !== 'ok' || !isPlain(snapshot.pullRequest.data)) {
          return { status: 'unverified' };
        }
        const pr = snapshot.pullRequest.data;
        if (pr.merged === true && SHA.test(String(snapshot.headSha))) {
          return { status: 'already-applied', result: { ok: true, reason: 'merged', pullNumber: payload.number, headSha: snapshot.headSha } };
        }
        if (pr.merged === false && pr.state === 'open') return { status: 'not-applied' };
        return { status: 'unverified' };
      }
      if (operation === 'claimIssue') {
        const issue = await this.d.reader.getIssue(payload.number, { forceRefresh: true });
        if (!isPlain(issue) || issue.kind !== 'ok' || !isPlain(issue.data) || !Array.isArray(issue.data.assignees)) return { status: 'unverified' };
        const claimedByActor = issue.data.assignees.some((entry) => {
          const login = typeof entry === 'string' ? entry : isPlain(entry) && typeof entry.login === 'string' ? entry.login : null;
          return this.#matchesActor(actor.actorId, login);
        });
        if (claimedByActor) return { status: 'already-applied', result: { ok: true, number: payload.number } };
        if (issue.data.state === 'open' && issue.data.assignees.length === 0) return { status: 'not-applied' };
        return { status: 'unverified' };
      }
      if (operation === 'closeIssue') {
        const issue = await this.d.reader.getIssue(payload.number, { forceRefresh: true });
        if (!isPlain(issue) || issue.kind !== 'ok' || !isPlain(issue.data) || issue.data.isPullRequest !== false) return { status: 'unverified' };
        // Closed with a different reason than asked is not the same write: only the exact reason counts as applied.
        if (issue.data.state === 'closed') return issue.data.stateReason === payload.reason ? { status: 'already-applied', result: { ok: true, number: payload.number } } : { status: 'unverified' };
        return issue.data.state === 'open' ? { status: 'not-applied' } : { status: 'unverified' };
      }
      if (operation === 'editIssue') {
        const issue = await this.d.reader.getIssue(payload.number, { forceRefresh: true });
        if (!isPlain(issue) || issue.kind !== 'ok' || !isPlain(issue.data)) return { status: 'unverified' };
        const hasTitle = payload.title === undefined || typeof issue.data.title === 'string';
        const hasBody = payload.body === undefined || typeof issue.data.body === 'string';
        if (!hasTitle || !hasBody) return { status: 'unverified' };
        const titleMatches = payload.title === undefined || issue.data.title === payload.title;
        const bodyMatches = payload.body === undefined || issue.data.body === payload.body;
        return titleMatches && bodyMatches
          ? { status: 'already-applied', result: { ok: true, number: payload.number } }
          : { status: 'not-applied' };
      }
      if (operation === 'reviewPr') {
        const snapshot = await this.d.reader.getPullRequestSnapshot(payload.number, { forceRefresh: true });
        if (!isPlain(snapshot) || snapshot.status !== 'complete' || snapshot.consistent !== true || !isPlain(snapshot.reviews) || !['ok', 'empty'].includes(snapshot.reviews.kind)) {
          return { status: 'unverified' };
        }
        const reviews = snapshot.reviews.kind === 'empty' ? [] : Array.isArray(snapshot.reviews.data) ? snapshot.reviews.data : null;
        if (!reviews) return { status: 'unverified' };
        const expectedState = { approve: 'APPROVED', request_changes: 'CHANGES_REQUESTED', comment: 'COMMENTED' }[payload.decision];
        const found = reviews.find((review) => {
          if (!isPlain(review)) return false;
          const byActor = review.actorId === actor.actorId || this.#matchesActor(actor.actorId, review.reviewer ?? review.author ?? review.user);
          const onHead = (review.commitId ?? review.headSha) === payload.expectedHeadSha;
          const decisionOk = !review.state && !review.decision ? true : (typeof review.state === 'string' && review.state.toUpperCase() === expectedState) || review.decision === payload.decision;
          const bodyOk = review.body === undefined || review.body === payload.body;
          return byActor && onHead && decisionOk && bodyOk;
        });
        if (found) return { status: 'already-applied', result: { ok: true, ...(positive(found.reviewId ?? found.id ?? found.number) ? { number: found.reviewId ?? found.id ?? found.number } : {}) } };
        if (snapshot.headSha === payload.expectedHeadSha) return { status: 'not-applied' };
        return { status: 'unverified' };
      }
      if (operation === 'comment' && typeof this.d.reader.getIssueComments === 'function') {
        const comments = await this.d.reader.getIssueComments(payload.number, { forceRefresh: true });
        if (!isPlain(comments) || !['ok', 'empty'].includes(comments.kind)) return { status: 'unverified' };
        const list = comments.kind === 'empty' ? [] : Array.isArray(comments.data) ? comments.data : null;
        if (!list) return { status: 'unverified' };
        const found = list.find((item) => isPlain(item) && item.body === payload.body && (item.actorId === actor.actorId || item.author === undefined || this.#matchesActor(actor.actorId, item.author)));
        if (found) return { status: 'already-applied', result: { ok: true, ...(positive(found.number ?? found.id) ? { number: found.number ?? found.id } : {}) } };
        return { status: 'not-applied' };
      }
      if (operation === 'createIssue' && typeof this.d.reader.listIssues === 'function') {
        const issues = await this.d.reader.listIssues({ forceRefresh: true });
        if (!isPlain(issues) || !['ok', 'empty'].includes(issues.kind)) return { status: 'unverified' };
        const list = issues.kind === 'empty' ? [] : Array.isArray(issues.data) ? issues.data : null;
        if (!list) return { status: 'unverified' };
        const found = list.find((item) => isPlain(item) && item.title === payload.title && (item.body === undefined || item.body === payload.body) && positive(item.number));
        if (found) return { status: 'already-applied', result: { ok: true, number: found.number } };
        return { status: 'not-applied' };
      }
      if (operation === 'createPr' && typeof this.d.reader.listPullRequests === 'function') {
        const prs = await this.d.reader.listPullRequests({ forceRefresh: true });
        if (!isPlain(prs) || !['ok', 'empty'].includes(prs.kind)) return { status: 'unverified' };
        const list = prs.kind === 'empty' ? [] : Array.isArray(prs.data) ? prs.data : null;
        if (!list) return { status: 'unverified' };
        const found = list.find((item) => isPlain(item) && item.title === payload.title && (item.headSha === undefined || item.headSha === payload.headSha) && (item.headBranch === undefined || item.headBranch === payload.headBranch) && positive(item.number));
        if (found) return { status: 'already-applied', result: { ok: true, number: found.number } };
        return { status: 'not-applied' };
      }
      return { status: 'unverified' };
    } catch {
      return { status: 'unverified' };
    }
  }

  #identity() {
    let actor;
    try {
      actor = this.d.identity.current();
    } catch {
      return null;
    }
    return isPlain(actor) && text(actor.actorId) && ['pm', 'worker'].includes(actor.role) ? { actorId: actor.actorId, role: actor.role } : null;
  }

  #authorize(operation, actor, pullRequest) {
    const spec = OPERATIONS[operation];
    if (!spec.roles.includes(actor.role)) return deny('role-forbidden');
    const config = { pmActorId: this.d.config.pmActorId, mergeAuthority: this.d.config.mergeAuthority };
    // `publish-policy` owns identity separation and role rules. Operations it does not know
    // (commit, push, comment) are checked as a stand-in operation of the same role.
    // Review and merge need the pull request, which is read later; until then they are checked as
    // a stand-in of the same role, and the full rule runs once the state is known.
    const known = ['createIssue', 'editIssue', 'closeIssue', 'deleteBranch', 'claimIssue', 'createPr'].includes(operation) || (['reviewPr', 'mergePr'].includes(operation) && pullRequest !== undefined);
    const proxy = known ? operation : actor.role === 'pm' ? 'createIssue' : 'claimIssue';
    const verdict = evaluatePublishRequest({ operation: proxy, role: actor.role, actorId: actor.actorId, pullRequest }, config);
    return verdict.allowed ? null : deny(verdict.reason);
  }

  #audit(entry) {
    try {
      this.d.audit.record(entry);
      return true;
    } catch {
      return false;
    }
  }

  async #scan(units) {
    let result;
    try {
      // Only private reference material is passed on. `detectors` and any other key would replace
      // or switch off the standard detectors, so they never reach the scanner.
      const given = isPlain(this.d.scanOptions) ? this.d.scanOptions : {};
      const safe = {};
      for (const key of SCAN_OPTION_KEYS) if (Object.hasOwn(given, key)) safe[key] = given[key];
      result = scanPublication(units, safe);
    } catch {
      return deny('content-scan-failed');
    }
    if (!isPlain(result) || result.status !== 'clear' || result.blocked !== false) {
      return deny('content-blocked', { scanStatus: isPlain(result) && typeof result.status === 'string' ? result.status : 'error' });
    }
    if (result.privateReference !== 'supplied' && this.d.privateReferencesChecked !== true) return deny('private-reference-unchecked');
    return null;
  }

  async #trustedContent(headSha) {
    let content;
    try {
      content = await this.d.content.getCommitContent(headSha);
    } catch {
      return null;
    }
    if (!isPlain(content) || content.complete !== true || content.headSha !== headSha || typeof content.message !== 'string' || typeof content.diff !== 'string') {
      return null;
    }
    if (content.message.trim() === '' || content.message.length > MAX_TEXT_CHARS || content.diff.length > MAX_DIFF_CHARS) {
      return { tooLarge: true };
    }
    return content;
  }

  /**
   * @param {{ operation: string, requestId: string }} request plus that operation's fields
   * @returns {Promise<{ ok: boolean, reason?: string, replay?: boolean }>}
   */
  async request(request) {
    if (!isPlain(request) || typeof request.operation !== 'string' || !Object.hasOwn(OPERATIONS, request.operation)) return deny('operation-unsupported');
    if (typeof request.requestId !== 'string' || !REQUEST_ID.test(request.requestId)) return deny('request-id-invalid');
    const { operation, requestId } = request;
    const shape = checkShape(operation, request);
    if (shape.problem) return deny(shape.problem);
    const { payload } = shape;

    const actor = this.#identity();
    if (!actor) return deny('identity-unverified');
    const refused = this.#authorize(operation, actor, undefined);
    if (refused) return refused;

    const print = fingerprint(operation, payload);
    const key = `${actor.actorId}:${requestId}`;
    if (this.unknown.has(key)) return this.unknown.get(key).print === print ? deny('outcome-unknown', { replay: true }) : deny('request-id-conflict');
    if (this.done.has(key)) {
      const earlier = this.done.get(key);
      return earlier.print === print ? { ...earlier.result, replay: true } : deny('request-id-conflict');
    }
    if (this.inFlight.has(key)) return deny('request-in-progress');
    this.inFlight.add(key);
    try {
      const stored = this.#readStored(key);
      if (!stored.ok) return deny('store-unavailable');
      if (stored.found) {
        const record = stored.value;
        if (record.print !== print) return deny('request-id-conflict');
        if (record.state === 'done') {
          this.done.set(key, { print, result: record.result });
          return { ...record.result, replay: true };
        }
        const reconciled = await this.#reconcileRemote(operation, payload, actor);
        if (reconciled.status === 'already-applied') {
          if (!this.#writeStored(key, { operation, requestId, print, state: 'done', result: reconciled.result })) {
            return deny('store-unavailable');
          }
          this.done.set(key, { print, result: reconciled.result });
          this.#audit({ operation, requestId, actorId: actor.actorId, print, stage: 'result', outcome: 'done', reconciled: true });
          return { ...reconciled.result, replay: true };
        }
        if (reconciled.status === 'unverified') {
          this.unknown.set(key, { print });
          return deny('outcome-unknown', { replay: true });
        }
      }
      return await this.#run(operation, payload, actor, key, print, requestId);
    } finally {
      this.inFlight.delete(key);
    }
  }

  async #run(operation, payload, actor, key, print, requestId) {
    const { repository } = this.d.project;
    let send;
    let units = [];
    let release = null;
    let preflight = null;

    if (operation === 'createIssue') {
      units = [{ kind: 'issue-title', text: payload.title }, { kind: 'issue-body', text: payload.body }];
      send = () => this.d.transport.createIssue({ repository, title: payload.title, body: payload.body });
    } else if (operation === 'editIssue') {
      if (payload.title !== undefined) units.push({ kind: 'issue-title', text: payload.title });
      if (payload.body !== undefined) units.push({ kind: 'issue-body', text: payload.body });
      send = () => this.d.transport.editIssue({ repository, number: payload.number, ...(payload.title !== undefined ? { title: payload.title } : {}), ...(payload.body !== undefined ? { body: payload.body } : {}) });
    } else if (operation === 'deleteBranch') {
      const checked = await this.#branchDeletable(payload);
      if (!checked.ok) return checked;
      units = [{ kind: 'branch-name', text: checked.branch }];
      // The tip is read once more right before the write (after the scan), so the gap to the delete is as short as it can be.
      preflight = () => this.#branchTip(checked.branch, payload.expectedHeadSha);
      send = () => this.d.transport.deleteBranch({ repository, branch: checked.branch, expectedHeadSha: payload.expectedHeadSha });
    } else if (operation === 'closeIssue') {
      // Nothing free-form is published: the number and a fixed reason. The issue is read fresh and must be open.
      const issue = await this.#readIssue(payload.number);
      if (!issue.ok) return issue;
      if (issue.data.state !== 'open') return deny('issue-not-open');
      send = () => this.d.transport.closeIssue({ repository, number: payload.number, reason: payload.reason });
    } else if (operation === 'comment') {
      units = [{ kind: 'comment', text: payload.body }];
      send = () => this.d.transport.comment({ repository, target: payload.target, number: payload.number, body: payload.body });
    } else if (operation === 'claimIssue') {
      send = () => this.d.transport.claimIssue({ repository, number: payload.number, actorId: actor.actorId });
    } else if (operation === 'createPr') {
      const content = await this.#trustedContent(payload.headSha);
      if (!content) return deny('content-unverified');
      if (content.tooLarge) return deny('content-blocked', { scanStatus: 'error' });
      units = [{ kind: 'pr-title', text: payload.title }, { kind: 'pr-body', text: payload.body }, { kind: 'branch-name', text: payload.headBranch }, { kind: 'branch-name', text: payload.baseBranch }, { kind: 'commit-message', text: content.message }, { kind: 'diff', text: content.diff }];
      send = () => this.d.transport.createPullRequest({ repository, title: payload.title, body: payload.body, headBranch: payload.headBranch, headSha: payload.headSha, baseBranch: payload.baseBranch });
    } else if (operation === 'commit' || operation === 'push') {
      const content = await this.#trustedContent(payload.headSha);
      if (!content) return deny('content-unverified');
      if (content.tooLarge) return deny('content-blocked', { scanStatus: 'error' });
      units = [{ kind: 'commit-message', text: content.message }, { kind: 'diff', text: content.diff }];
      if (operation === 'push') units.push({ kind: 'branch-name', text: payload.branch });
      send = () => this.d.transport[operation]({ repository, ...(operation === 'push' ? { branch: payload.branch } : {}), headSha: payload.headSha });
    } else if (operation === 'reviewPr') {
      const state = await this.#readPullRequest(payload.number);
      if (!state.ok) return state;
      if (state.snapshot.headSha !== payload.expectedHeadSha) return deny('head-changed');
      const policy = this.#authorize('reviewPr', actor, { authorId: state.authorId, headSha: state.snapshot.headSha, state: state.snapshot.pullRequest.data.state });
      if (policy) return policy;
      units = [{ kind: 'review', text: payload.body }];
      send = () => this.d.transport.reviewPullRequest({ repository, number: payload.number, decision: payload.decision, body: payload.body, expectedHeadSha: payload.expectedHeadSha });
    } else if (operation === 'mergePr') {
      return this.#merge(payload, actor, key, print, requestId);
    }

    if (units.length > 0) {
      const scanned = await this.#scan(units);
      if (scanned) return scanned;
    }

    if (preflight) {
      const ready = await preflight();
      if (!ready.ok) return ready;
    }

    if (operation === 'claimIssue') {
      const claimed = await this.#claimPrecondition(payload.number);
      if (!claimed.ok) return claimed;
      release = claimed.release;
    }
    try {
      return await this.#write(operation, actor, key, print, requestId, send);
    } finally {
      if (release) release();
    }
  }

  /**
   * A pull request's head branch may be deleted only when everything is read fresh and agrees: the pull request is
   * merged and closed, its head is the one that was reviewed, the branch lives in this repository (not a fork), it is
   * neither the default branch nor the pull request's base, and it is confirmed unprotected. Anything that cannot be
   * read, or is only partly known, refuses: unknown protection is never read as "unprotected".
   */
  async #branchDeletable(payload) {
    const { repository } = this.d.project;
    const reader = this.d.reader;
    let snapshot;
    let repo;
    try {
      snapshot = await reader.getPullRequestSnapshot(payload.number, { forceRefresh: true });
      repo = typeof reader.getRepository === 'function' ? await reader.getRepository({ forceRefresh: true }) : null;
    } catch {
      return deny('cannot-verify');
    }
    const data = isPlain(snapshot) && snapshot.status === 'complete' && snapshot.consistent === true && isPlain(snapshot.pullRequest) && snapshot.pullRequest.kind === 'ok' ? snapshot.pullRequest.data : null;
    if (!isPlain(data) || !SHA.test(String(snapshot.headSha))) return deny('pr-unverified');
    if (data.merged !== true || data.state !== 'closed') return deny('pr-not-merged');
    if (snapshot.headSha !== payload.expectedHeadSha) return deny('head-changed');
    if (!safeRefName(data.headRef)) return deny('branch-invalid');
    if (typeof data.headRepository !== 'string' || data.headRepository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) return deny('branch-not-in-repository');
    const defaultBranch = isPlain(repo) && repo.kind === 'ok' && isPlain(repo.data) ? repo.data.defaultBranch : null;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') return deny('default-branch-unverified');
    if (data.headRef === defaultBranch || data.headRef === data.baseRef) return deny('branch-is-default');
    let requirements;
    try {
      requirements = typeof reader.getBranchRequirements === 'function' ? await reader.getBranchRequirements(data.headRef, { forceRefresh: true }) : null;
    } catch {
      return deny('cannot-verify');
    }
    if (!isPlain(requirements)) return deny('protection-unverified');
    if (requirements.kind === 'ok') return deny('branch-protected');
    if (requirements.kind !== 'empty') return deny('protection-unverified');
    // The pull request's head is fixed at the merge. What protects work pushed to the branch afterwards is the branch's own tip.
    const tip = await this.#branchTip(data.headRef, payload.expectedHeadSha);
    if (!tip.ok) return tip;
    return { ok: true, branch: data.headRef };
  }

  /** The branch's tip, read now, must be exactly the reviewed head: a newer commit means the branch holds unmerged work. */
  async #branchTip(branch, expectedHeadSha) {
    let read;
    try {
      read = typeof this.d.reader.getBranchHead === 'function' ? await this.d.reader.getBranchHead(branch, { forceRefresh: true }) : null;
    } catch {
      return deny('cannot-verify');
    }
    if (!isPlain(read) || read.kind !== 'ok' || !isPlain(read.data) || !SHA.test(String(read.data.sha))) return deny('branch-tip-unverified');
    return read.data.sha.toLowerCase() === expectedHeadSha ? { ok: true } : deny('head-changed');
  }

  async #readIssue(number) {
    let issue;
    try {
      issue = await this.d.reader.getIssue(number, { forceRefresh: true });
    } catch {
      return deny('cannot-verify');
    }
    if (!isPlain(issue) || issue.kind !== 'ok' || !isPlain(issue.data) || !['open', 'closed'].includes(issue.data.state)) return deny('issue-unverified');
    // The issues endpoint also answers for pull request numbers. A pull request is closed through review and merge, never here;
    // a read that does not say which it is, is refused.
    if (issue.data.isPullRequest !== false) return deny(issue.data.isPullRequest === true ? 'target-is-pull-request' : 'issue-unverified');
    return { ok: true, data: issue.data };
  }

  async #readPullRequest(number) {
    let snapshot;
    try {
      snapshot = await this.d.reader.getPullRequestSnapshot(number, { forceRefresh: true });
    } catch {
      return deny('cannot-verify');
    }
    const data = isPlain(snapshot) && snapshot.status === 'complete' && snapshot.consistent === true && isPlain(snapshot.pullRequest) ? snapshot.pullRequest.data : null;
    if (!isPlain(data) || typeof data.author !== 'string' || !SHA.test(String(snapshot.headSha))) return deny('pr-unverified');
    let authorId = null;
    try {
      authorId = this.d.identity.actorIdForLogin(data.author);
    } catch {
      authorId = null;
    }
    if (!text(authorId)) return deny('pr-unverified');
    return { ok: true, snapshot, authorId };
  }

  async #claimPrecondition(number) {
    // One writer per issue: the lock is taken before the issue is read and held until the write ends.
    const lockKey = `claim-issue-${number}`;
    const lock = this.d.lock;
    if (!isPlain(lock) || typeof lock.acquire !== 'function' || typeof lock.release !== 'function') return deny('claim-lock-unavailable');
    let token;
    try {
      token = lock.acquire(lockKey);
    } catch {
      return deny('claim-lock-unavailable');
    }
    if (!token) return deny('claim-in-progress');
    const release = () => { try { lock.release(lockKey, token); } catch { /* a lock that cannot be released is left to its stale rules */ } };
    let issue;
    try {
      issue = await this.d.reader.getIssue(number, { forceRefresh: true });
    } catch {
      release();
      return deny('cannot-verify');
    }
    const data = isPlain(issue) && ['ok'].includes(issue.kind) ? issue.data : null;
    if (!isPlain(data) || data.state !== 'open' || !Array.isArray(data.assignees)) {
      release();
      return deny('issue-unverified');
    }
    if (data.assignees.length > 0) {
      release();
      return deny('issue-already-claimed');
    }
    return { ok: true, release };
  }

  async #merge(payload, actor, key, print, requestId) {
    const state = await this.#readPullRequest(payload.number);
    if (!state.ok) return state;
    const { repository } = this.d.project;
    return this.#write('mergePr', actor, key, print, requestId, () => mergePullRequest({
      reader: this.d.reader,
      writer: { mergePullRequest: (input) => this.d.transport.mergePullRequest(input) },
      repository,
      pullNumber: payload.number,
      role: actor.role,
      actorId: actor.actorId,
      authorId: state.authorId,
      pmLogin: this.d.config.pmLogin,
      policyConfig: { pmActorId: this.d.config.pmActorId, pmLogin: this.d.config.pmLogin, mergeAuthority: this.d.config.mergeAuthority },
      scanOptions: this.d.scanOptions || {},
      privateReferencesChecked: this.d.privateReferencesChecked === true
    }), true);
  }

  async #write(operation, actor, key, print, requestId, send, delegated = false) {
    const entry = { operation, requestId, actorId: actor.actorId, print };
    if (!this.#writeStored(key, { operation, requestId, print, state: 'pending' })) return deny('store-unavailable');
    if (!this.#audit({ ...entry, stage: 'intent' })) {
      this.#deleteStored(key);
      return deny('audit-unavailable');
    }
    let result;
    try {
      result = await send();
    } catch {
      // The merge coordinator turns writer failures into results itself; a throw from it means a
      // precondition could not even be set up, and nothing was sent.
      if (delegated) {
        this.#deleteStored(key);
        this.#audit({ ...entry, stage: 'result', outcome: 'refused', reason: 'merge-unavailable' });
        return deny('merge-unavailable');
      }
      this.#writeStored(key, { operation, requestId, print, state: 'unknown' });
      this.unknown.set(key, { print });
      this.#audit({ ...entry, stage: 'result', outcome: 'unknown' });
      return deny('outcome-unknown');
    }
    if (!isPlain(result) || typeof result.ok !== 'boolean' || (delegated && result.reason === 'merge-outcome-unknown')) {
      this.#writeStored(key, { operation, requestId, print, state: 'unknown' });
      this.unknown.set(key, { print });
      this.#audit({ ...entry, stage: 'result', outcome: 'unknown' });
      return deny('outcome-unknown');
    }
    if (result.ok !== true) {
      // Nothing was published. A merge refusal from the decision core is already a plain reason.
      this.#deleteStored(key);
      const reason = delegated && typeof result.reason === 'string' ? result.reason : 'write-refused';
      this.#audit({ ...entry, stage: 'result', outcome: 'refused', reason });
      return deny(reason);
    }
    const stored = delegated ? { ok: true, reason: result.reason, pullNumber: result.pullNumber, headSha: result.headSha } : { ok: true, ...(positive(result.number) ? { number: result.number } : {}) };
    if (!this.#writeStored(key, { operation, requestId, print, state: 'done', result: stored })) {
      this.unknown.set(key, { print });
      this.#audit({ ...entry, stage: 'result', outcome: 'unknown' });
      return deny('outcome-unknown');
    }
    this.done.set(key, { print, result: stored });
    this.#audit({ ...entry, stage: 'result', outcome: 'done' });
    return stored;
  }
}

module.exports = { Broker, OPERATIONS, EXPECTED_PERMISSIONS, MAX_TEXT_CHARS, MAX_DIFF_CHARS };
