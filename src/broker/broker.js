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
const FORBIDDEN_FIELDS = ['actorId', 'role', 'token', 'credential', 'credentials', 'authorization', 'password', 'secret', 'headers'];
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const SCAN_OPTION_KEYS = ['memories', 'rules', 'knownValues'];
const MAX_TEXT_CHARS = 262144;
const text = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT_CHARS;

// field checks per operation; `roles` are who may ask, `policy` is how `publish-policy` sees it
const OPERATIONS = Object.freeze({
  createIssue: { roles: ['pm'], fields: { title: text, body: text } },
  editIssue: { roles: ['pm'], fields: { number: positive }, optional: { title: text, body: text } },
  claimIssue: { roles: ['worker'], fields: { number: positive } },
  createPr: { roles: ['worker'], fields: { title: text, body: text, headBranch: (v) => typeof v === 'string' && BRANCH.test(v), headSha: (v) => typeof v === 'string' && SHA.test(v), baseBranch: (v) => typeof v === 'string' && BRANCH.test(v) } },
  commit: { roles: ['worker'], fields: { headSha: (v) => typeof v === 'string' && SHA.test(v) } },
  push: { roles: ['worker'], fields: { branch: (v) => typeof v === 'string' && BRANCH.test(v), headSha: (v) => typeof v === 'string' && SHA.test(v) } },
  comment: { roles: ['pm', 'worker'], fields: { target: (v) => v === 'issue' || v === 'pr', number: positive, body: text } },
  reviewPr: { roles: ['pm'], fields: { number: positive, decision: (v) => ['approve', 'request_changes', 'comment'].includes(v), body: text, expectedHeadSha: (v) => typeof v === 'string' && SHA.test(v) } },
  mergePr: { roles: ['pm'], fields: { number: positive } }
});

/**
 * The permission each operation is expected to need from the GitHub credential the transport uses.
 * These are expectations for a person to check against the real App or account settings; none has
 * been verified against GitHub.
 */
const EXPECTED_PERMISSIONS = Object.freeze({
  createIssue: 'issues:write',
  editIssue: 'issues:write',
  claimIssue: 'issues:write',
  createPr: 'pull_requests:write, contents:read',
  commit: 'contents:write',
  push: 'contents:write',
  comment: 'issues:write (issue) or pull_requests:write (pull request)',
  reviewPr: 'pull_requests:write',
  mergePr: 'pull_requests:write, contents:write'
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
   * @param {object} [deps.scanOptions] extra private references for the content scan
   * @param {boolean} [deps.privateReferencesChecked]
   */
  constructor(deps = {}) {
    for (const name of ['identity', 'reader', 'transport', 'audit']) if (!isPlain(deps[name])) throw new TypeError(`${name} is required`);
    if (!isPlain(deps.config) || !text(deps.config.pmActorId) || !text(deps.config.pmLogin)) throw new TypeError('config.pmActorId and config.pmLogin are required');
    if (!isPlain(deps.project) || !isPlain(deps.project.repository)) throw new TypeError('project.repository is required');
    // Settings may add private reference material to the scan. They may never replace a detector.
    if (deps.scanOptions !== undefined && (!isPlain(deps.scanOptions) || Object.keys(deps.scanOptions).some((key) => !SCAN_OPTION_KEYS.includes(key)))) throw new TypeError('scanOptions may only hold memories, rules and knownValues');
    this.d = deps;
    this.done = new Map();
    this.unknown = new Map();
    this.inFlight = new Set();
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
    const known = ['createIssue', 'editIssue', 'claimIssue', 'createPr'].includes(operation) || (['reviewPr', 'mergePr'].includes(operation) && pullRequest !== undefined);
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
    return isPlain(content) && content.complete === true && content.headSha === headSha && typeof content.message === 'string' && typeof content.diff === 'string' ? content : null;
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

    if (operation === 'createIssue') {
      units = [{ kind: 'issue-title', text: payload.title }, { kind: 'issue-body', text: payload.body }];
      send = () => this.d.transport.createIssue({ repository, title: payload.title, body: payload.body });
    } else if (operation === 'editIssue') {
      if (payload.title !== undefined) units.push({ kind: 'issue-title', text: payload.title });
      if (payload.body !== undefined) units.push({ kind: 'issue-body', text: payload.body });
      send = () => this.d.transport.editIssue({ repository, number: payload.number, ...(payload.title !== undefined ? { title: payload.title } : {}), ...(payload.body !== undefined ? { body: payload.body } : {}) });
    } else if (operation === 'comment') {
      units = [{ kind: 'comment', text: payload.body }];
      send = () => this.d.transport.comment({ repository, target: payload.target, number: payload.number, body: payload.body });
    } else if (operation === 'claimIssue') {
      send = () => this.d.transport.claimIssue({ repository, number: payload.number, actorId: actor.actorId });
    } else if (operation === 'createPr') {
      const content = await this.#trustedContent(payload.headSha);
      if (!content) return deny('content-unverified');
      units = [{ kind: 'pr-title', text: payload.title }, { kind: 'pr-body', text: payload.body }, { kind: 'branch-name', text: payload.headBranch }, { kind: 'branch-name', text: payload.baseBranch }, { kind: 'commit-message', text: content.message }, { kind: 'diff', text: content.diff }];
      send = () => this.d.transport.createPullRequest({ repository, title: payload.title, body: payload.body, headBranch: payload.headBranch, headSha: payload.headSha, baseBranch: payload.baseBranch });
    } else if (operation === 'commit' || operation === 'push') {
      const content = await this.#trustedContent(payload.headSha);
      if (!content) return deny('content-unverified');
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
    if (!this.#audit({ ...entry, stage: 'intent' })) return deny('audit-unavailable');
    let result;
    try {
      result = await send();
    } catch {
      // The merge coordinator turns writer failures into results itself; a throw from it means a
      // precondition could not even be set up, and nothing was sent.
      if (delegated) {
        this.#audit({ ...entry, stage: 'result', outcome: 'refused', reason: 'merge-unavailable' });
        return deny('merge-unavailable');
      }
      this.unknown.set(key, { print });
      this.#audit({ ...entry, stage: 'result', outcome: 'unknown' });
      return deny('outcome-unknown');
    }
    if (!isPlain(result) || typeof result.ok !== 'boolean' || (delegated && result.reason === 'merge-outcome-unknown')) {
      this.unknown.set(key, { print });
      this.#audit({ ...entry, stage: 'result', outcome: 'unknown' });
      return deny('outcome-unknown');
    }
    if (result.ok !== true) {
      // Nothing was published. A merge refusal from the decision core is already a plain reason.
      const reason = delegated && typeof result.reason === 'string' ? result.reason : 'write-refused';
      this.#audit({ ...entry, stage: 'result', outcome: 'refused', reason });
      return deny(reason);
    }
    const stored = delegated ? { ok: true, reason: result.reason, pullNumber: result.pullNumber, headSha: result.headSha } : { ok: true, ...(positive(result.number) ? { number: result.number } : {}) };
    this.done.set(key, { print, result: stored });
    this.#audit({ ...entry, stage: 'result', outcome: 'done' });
    return stored;
  }
}

module.exports = { Broker, OPERATIONS, EXPECTED_PERMISSIONS };
