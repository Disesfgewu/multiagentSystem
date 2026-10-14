'use strict';

const { createGitHubClient, DEFAULTS } = require('./client');
const { isSuccess, mostSevereFailure } = require('./result');
const { createUrlBuilder } = require('./urls');
const {
  assertRepository,
  repositoryKey,
  assertPositiveInteger,
  assertSha,
  assertBranchName
} = require('./validate');
const models = require('./models');
const { assessApprovals } = require('./approval');
const { summarizeChecks } = require('./checks');
const { mergeBranchRequirements } = require('./requirements');
const { REVIEW_THREADS_QUERY, normalizeThread, readPullRequestNode } = require('./threads');

const ISSUE_STATES = new Set(['open', 'closed', 'all']);
const PROTECTION_KEYS = [
  'required_pull_request_reviews',
  'required_status_checks',
  'required_conversation_resolution',
  'enforce_admins',
  'required_linear_history',
  'allow_force_pushes'
];

function deriveWebBaseUrl(apiBaseUrl) {
  const url = new URL(apiBaseUrl === undefined ? 'https://api.github.com' : apiBaseUrl);
  return url.hostname === 'api.github.com' ? 'https://github.com' : url.origin;
}

function oldestFetchedAt(results) {
  return results.map((result) => result.fetchedAt).sort()[0];
}

function sourceOf(results) {
  return results.every((result) => result.source === 'cache') ? 'cache' : 'network';
}

/**
 * Read-only GitHub adapter for one active repository at a time.
 *
 * Nothing here writes to GitHub or touches the machine: the HTTP transport and the
 * token provider are injected by the host (the Extension supplies them later).
 *
 * `useRepository(repo)` returns a reader bound to that repository. Switching to a
 * different repository aborts every in-flight read of the previous one and retires the old
 * reader, so a late response can never be shown for the wrong repository.
 *
 * @param {object} options see createGitHubClient; additionally `webBaseUrl` for page links
 */
function createGitHubReadAdapter(options) {
  const client = createGitHubClient(options);
  const urls = createUrlBuilder(options.webBaseUrl || deriveWebBaseUrl(options.apiBaseUrl));
  const maxPages = options.maxPages === undefined ? DEFAULTS.maxPages : options.maxPages;
  const clock = options.now || Date.now;
  const nowIso = () => new Date(clock()).toISOString();

  let generation = 0;
  let active;
  const inflight = new Set();

  function createReader(repo, readerGeneration) {
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const retired = () => readerGeneration !== generation;
    const cancelledByRepoChange = () => client.failure('cancelled', { reason: 'repository_changed' });

    /** Wraps one read: caller cancellation, repository-switch cancellation, stale-result guard. */
    async function run(opts, work) {
      if (retired()) return cancelledByRepoChange();
      const controller = new AbortController();
      inflight.add(controller);
      const caller = opts && opts.signal;
      const onCallerAbort = () => controller.abort();
      if (caller) {
        if (caller.aborted) controller.abort();
        else caller.addEventListener('abort', onCallerAbort, { once: true });
      }
      try {
        const result = await work(controller.signal);
        return retired() ? cancelledByRepoChange() : result;
      } finally {
        inflight.delete(controller);
        if (caller) caller.removeEventListener('abort', onCallerAbort);
      }
    }

    const cacheOptions = (opts) => ({
      forceRefresh: opts && opts.forceRefresh,
      maxAgeMs: opts && opts.maxAgeMs
    });

    /** Converts raw client data to the public model; malformed payloads become `invalid`. */
    function mapResult(result, convert) {
      if (isSuccess(result)) {
        let data;
        try {
          data = convert(result.data, result.extra);
        } catch (error) {
          return client.failure('invalid', {
            reason: 'malformed_payload',
            ...(error && error.field ? { field: error.field } : {})
          });
        }
        const { extra, ...rest } = result;
        const kind = Array.isArray(data) ? (data.length === 0 ? 'empty' : 'ok') : rest.kind;
        return { ...rest, kind, data };
      }
      const out = { ...result };
      if (result.lastKnown) {
        try {
          out.lastKnown = {
            data: convert(result.lastKnown.data, result.lastKnown.extra),
            fetchedAt: result.lastKnown.fetchedAt
          };
        } catch {
          delete out.lastKnown;
        }
      }
      if (result.partialData) {
        try {
          out.partialData = convert(result.partialData);
        } catch {
          delete out.partialData;
          delete out.pagesFetched;
        }
      }
      return out;
    }

    function listOf(convertItem) {
      return (items) => items.map(convertItem);
    }

    /**
     * No source produced a usable answer. Reports the most severe failure; when every source
     * was merely truncated there is no failure to report, so the result stays `truncated`
     * (with what was read) instead of losing its kind.
     */
    function unusable(parts, components, assemblePartial) {
      const failure = mostSevereFailure(parts);
      if (failure) return { ...failure, components };
      const pagesFetched = parts.reduce((total, part) => total + (part.pagesFetched || 0), 0);
      const partialData = assemblePartial ? assemblePartial() : undefined;
      return client.failure('truncated', {
        reason: 'page_limit',
        pageLimit: maxPages,
        components,
        pagesFetched,
        ...(partialData === undefined ? {} : { partialData })
      });
    }

    const paginated = (path, signal, opts, extra = {}) =>
      client.getPaginated(path, { signal, ...cacheOptions(opts), ...extra });

    const reader = {
      repository: Object.freeze({ owner: repo.owner, name: repo.name }),
      links: {
        repository: () => urls.repository(repo),
        issues: () => urls.issues(repo),
        issue: (number) => urls.issue(repo, assertPositiveInteger(number, 'issue number')),
        pullRequests: () => urls.pullRequests(repo),
        pullRequest: (number) => urls.pullRequest(repo, assertPositiveInteger(number, 'pull request number')),
        pullRequestChecks: (number) => urls.pullRequestChecks(repo, assertPositiveInteger(number, 'pull request number')),
        pullRequestFiles: (number) => urls.pullRequestFiles(repo, assertPositiveInteger(number, 'pull request number')),
        commit: (sha) => urls.commit(repo, assertSha(sha))
      },

      getRepository(opts) {
        return run(opts, async (signal) =>
          mapResult(await client.getJson(base, { signal, ...cacheOptions(opts) }), (raw) =>
            models.normalizeRepository(raw, urls, repo)
          )
        );
      },

      getIssue(number, opts) {
        assertPositiveInteger(number, 'issue number');
        return run(opts, async (signal) =>
          mapResult(await client.getJson(`${base}/issues/${number}`, { signal, ...cacheOptions(opts) }), (raw) =>
            models.normalizeIssue(raw, urls, repo)
          )
        );
      },

      /** Issues only: pull requests (which the issues endpoint also returns) are filtered out. */
      listIssues(filter = {}, opts) {
        const state = filter.state === undefined ? 'open' : filter.state;
        if (!ISSUE_STATES.has(state)) throw new TypeError('state must be open, closed or all');
        const query = { state };
        if (Array.isArray(filter.labels) && filter.labels.length > 0) query.labels = filter.labels.join(',');
        if (typeof filter.assignee === 'string') query.assignee = filter.assignee;
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/issues`, signal, opts, { query }), (items) =>
            items.map((raw) => models.normalizeIssue(raw, urls, repo)).filter((issue) => !issue.isPullRequest)
          )
        );
      },

      getPullRequest(number, opts) {
        assertPositiveInteger(number, 'pull request number');
        return run(opts, async (signal) =>
          mapResult(await client.getJson(`${base}/pulls/${number}`, { signal, ...cacheOptions(opts) }), (raw) =>
            models.normalizePullRequest(raw, urls, repo)
          )
        );
      },

      /** The list endpoint does not compute `mergeable`; it is null for every item. */
      listPullRequests(filter = {}, opts) {
        const state = filter.state === undefined ? 'open' : filter.state;
        if (!ISSUE_STATES.has(state)) throw new TypeError('state must be open, closed or all');
        const query = { state };
        if (typeof filter.base === 'string') query.base = filter.base;
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/pulls`, signal, opts, { query }), listOf((raw) =>
            models.normalizePullRequest(raw, urls, repo)
          ))
        );
      },

      getReviews(number, opts) {
        assertPositiveInteger(number, 'pull request number');
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/pulls/${number}/reviews`, signal, opts), listOf((raw) =>
            models.normalizeReview(raw, urls, repo, number)
          ))
        );
      },

      getIssueComments(number, opts) {
        assertPositiveInteger(number, 'issue number');
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/issues/${number}/comments`, signal, opts), listOf((raw) =>
            models.normalizeComment(raw, 'issue_comment', urls, repo, number)
          ))
        );
      },

      getReviewComments(number, opts) {
        assertPositiveInteger(number, 'pull request number');
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/pulls/${number}/comments`, signal, opts), listOf((raw) =>
            models.normalizeComment(raw, 'review_comment', urls, repo, number)
          ))
        );
      },

      /**
       * Check runs plus commit statuses for one commit. `partial` when only one of the two
       * sources could be read.
       */
      getChecks(sha, opts) {
        const head = assertSha(sha);
        return run(opts, async (signal) => {
          const [runsRaw, statusesRaw] = await Promise.all([
            paginated(`${base}/commits/${head}/check-runs`, signal, opts, {
              query: { filter: 'latest' },
              itemsOf: (body) => ({ items: body.check_runs, extra: { totalCount: body.total_count } })
            }),
            paginated(`${base}/commits/${head}/status`, signal, opts, {
              itemsOf: (body) => ({ items: body.statuses, extra: { state: body.state } })
            })
          ]);
          const runs = mapResult(runsRaw, listOf((raw) => models.normalizeCheckRun(raw, urls)));
          const statuses = mapResult(statusesRaw, listOf((raw) => models.normalizeCommitStatus(raw, urls)));
          const parts = { checkRuns: runs, statuses };
          const okParts = Object.values(parts).filter(isSuccess);

          if (Object.values(parts).some((part) => part.kind === 'cancelled')) {
            return Object.values(parts).find((part) => part.kind === 'cancelled');
          }
          if (okParts.length === 0) {
            return unusable(Object.values(parts), { checkRuns: runs.kind, statuses: statuses.kind }, () => ({
              headSha: head,
              checkRuns: runs.partialData || [],
              statuses: statuses.partialData || []
            }));
          }
          const data = {
            headSha: head,
            checkRuns: isSuccess(runs) ? runs.data : [],
            statuses: isSuccess(statuses) ? statuses.data : []
          };
          const meta = { fetchedAt: oldestFetchedAt(okParts), source: sourceOf(okParts), pages: okParts.length };
          if (okParts.length < 2) {
            const unavailable = {};
            if (!isSuccess(runs)) unavailable.checkRuns = runs.kind;
            if (!isSuccess(statuses)) unavailable.statuses = statuses.kind;
            return { kind: 'partial', data, unavailable, ...meta };
          }
          const empty = data.checkRuns.length === 0 && data.statuses.length === 0;
          return { kind: empty ? 'empty' : 'ok', data, ...meta };
        });
      },

      /**
       * Review threads (with resolved state) through a fixed GraphQL query. Needs a token:
       * GitHub's GraphQL API rejects anonymous requests, which is reported as `denied`.
       */
      getReviewThreads(number, opts) {
        assertPositiveInteger(number, 'pull request number');
        return run(opts, async (signal) => {
          const threads = [];
          let after = null;
          let pages = 0;
          let headSha = null;
          let reviewDecision = null;
          for (;;) {
            const response = await client.graphql({
              query: REVIEW_THREADS_QUERY,
              variables: { owner: repo.owner, name: repo.name, number, after },
              signal
            });
            if (response.kind !== 'ok') {
              return threads.length > 0 ? { ...response, partialData: threads, pagesFetched: pages } : response;
            }
            let node;
            let page;
            try {
              node = readPullRequestNode(response.data);
              page = node && node.reviewThreads.nodes.map((raw) => normalizeThread(raw, urls));
            } catch (error) {
              return client.failure('invalid', { reason: 'malformed_payload', field: error.field });
            }
            if (node === null) return client.failure('not_found', { possiblyHidden: true });
            if (pages === 0) {
              headSha = typeof node.headRefOid === 'string' ? node.headRefOid.toLowerCase() : null;
              reviewDecision = typeof node.reviewDecision === 'string' ? node.reviewDecision : null;
            }
            threads.push(...page);
            pages += 1;
            const info = node.reviewThreads.pageInfo;
            if (!info || info.hasNextPage !== true) break;
            if (typeof info.endCursor !== 'string') return client.failure('invalid', { reason: 'bad_page_info' });
            if (pages >= maxPages) {
              return client.failure('truncated', {
                reason: 'page_limit',
                pageLimit: maxPages,
                partialData: threads,
                pagesFetched: pages
              });
            }
            after = info.endCursor;
          }
          const unresolvedCount = threads.filter((thread) => !thread.isResolved).length;
          return {
            kind: threads.length === 0 ? 'empty' : 'ok',
            data: { headSha, reviewDecision, threads, unresolvedCount },
            fetchedAt: nowIso(),
            source: 'network',
            pages
          };
        });
      },

      /** Active rulesets that apply to the branch (readable without admin rights). */
      getBranchRules(branch, opts) {
        const name = encodeURIComponent(assertBranchName(branch));
        return run(opts, async (signal) =>
          mapResult(await paginated(`${base}/rules/branches/${name}`, signal, opts), listOf((raw) => {
            if (!raw || typeof raw.type !== 'string') throw new models.MalformedPayloadError('rule.type');
            return {
              type: raw.type,
              rulesetId: Number.isSafeInteger(raw.ruleset_id) ? raw.ruleset_id : null,
              parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {}
            };
          }))
        );
      },

      /**
       * Classic branch protection. Reading it needs admin rights, so `denied` is common and
       * means "unknown", not "unprotected". A confirmed unprotected branch is `empty` (data null).
       */
      getBranchProtection(branch, opts) {
        const name = encodeURIComponent(assertBranchName(branch));
        return run(opts, async (signal) => {
          const raw = await client.getJson(`${base}/branches/${name}/protection`, { signal, ...cacheOptions(opts) });
          if (raw.kind === 'not_found' && /branch not protected/i.test(raw.message || '')) {
            return { kind: 'empty', data: null, fetchedAt: raw.observedAt, source: 'network', pages: 1 };
          }
          return mapResult(raw, (payload) => {
            if (!payload || typeof payload !== 'object') throw new models.MalformedPayloadError('protection');
            const picked = {};
            for (const key of PROTECTION_KEYS) if (key in payload) picked[key] = payload[key];
            return picked;
          });
        });
      },

      /**
       * Rulesets and classic protection merged. `partial` when one source is unavailable;
       * its values are then only a lower bound (`data.complete === false`).
       */
      getBranchRequirements(branch, opts) {
        assertBranchName(branch);
        return run(opts, async (signal) => {
          const inner = { ...opts, signal };
          const [rules, protection] = await Promise.all([
            reader.getBranchRules(branch, inner),
            reader.getBranchProtection(branch, inner)
          ]);
          const parts = [rules, protection];
          const cancelled = parts.find((part) => part.kind === 'cancelled');
          if (cancelled) return cancelled;
          const okParts = parts.filter(isSuccess);
          if (okParts.length === 0) {
            return unusable(parts, { rules: rules.kind, protection: protection.kind });
          }
          const data = mergeBranchRequirements({ rules, protection });
          const meta = { fetchedAt: oldestFetchedAt(okParts), source: sourceOf(okParts), pages: okParts.length };
          if (!data.complete) return { kind: 'partial', data, unavailable: data.unavailable, ...meta };
          return { kind: data.ruleTypes.length === 0 ? 'empty' : 'ok', data, ...meta };
        });
      },

      /**
       * Everything the overview needs about one pull request, with derived verdicts.
       *
       * The head SHA is read again after the other reads; if it moved, `consistent` is
       * false, approvals are judged against the newest head (so older ones are stale) and
       * the checks read for the previous head are reported as unknown.
       */
      getPullRequestSnapshot(number, opts) {
        assertPositiveInteger(number, 'pull request number');
        return run(opts, async (signal) => {
          const inner = { ...opts, signal };
          const first = await reader.getPullRequest(number, inner);
          const links = { pullRequest: urls.pullRequest(repo, number), checks: urls.pullRequestChecks(repo, number), files: urls.pullRequestFiles(repo, number) };
          if (!isSuccess(first)) {
            return { repository: reader.repository, number, readAt: nowIso(), status: first.kind === 'cancelled' ? 'cancelled' : 'unavailable', consistent: false, headSha: null, pullRequest: first, links };
          }
          const [reviews, checks, threads, requirements] = await Promise.all([
            reader.getReviews(number, inner),
            reader.getChecks(first.data.headSha, inner),
            reader.getReviewThreads(number, inner),
            reader.getBranchRequirements(first.data.baseRef, inner)
          ]);
          const second = await reader.getPullRequest(number, { ...inner, forceRefresh: true });

          const verified = isSuccess(second);
          const pullRequest = verified ? second : first;
          const headSha = pullRequest.data.headSha;
          const consistent = verified && second.data.headSha === first.data.headSha;

          const requiredApprovals =
            requirements.data && Number.isInteger(requirements.data.requiredApprovingReviewCount)
              ? requirements.data.requiredApprovingReviewCount
              : 1;
          let approval;
          if (isSuccess(reviews)) {
            approval = assessApprovals({ reviews: reviews.data, headSha, prAuthor: pullRequest.data.author, requiredApprovals });
          } else {
            approval = { status: 'unknown', reason: `reviews_${reviews.kind}`, headSha };
          }

          let checksSummary;
          if (!isSuccess(checks)) {
            checksSummary = { headSha, state: 'unknown', requiredState: 'unknown', reason: `checks_${checks.kind}` };
          } else if (checks.data.headSha !== headSha) {
            checksSummary = { headSha, state: 'unknown', requiredState: 'unknown', reason: 'checks_for_previous_head' };
          } else {
            const required = requirements.data && requirements.data.complete ? requirements.data.requiredStatusChecks : null;
            checksSummary = summarizeChecks(checks.data, required);
          }

          const allKnown = [reviews, checks, threads, requirements].every(isSuccess);
          return {
            repository: reader.repository,
            number,
            readAt: nowIso(),
            status: allKnown && consistent ? 'complete' : 'partial',
            consistent,
            headSha,
            pullRequest,
            reviews,
            checks,
            threads,
            requirements,
            approval,
            checksSummary,
            unresolvedThreads: isSuccess(threads) ? threads.data.unresolvedCount : null,
            links
          };
        });
      }
    };
    return reader;
  }

  return {
    /** Activates a repository. A different repository cancels the previous one's reads. */
    useRepository(repo) {
      const normalized = assertRepository(repo);
      if (active && repositoryKey(active.repo) === repositoryKey(normalized)) return active.reader;
      generation += 1;
      for (const controller of inflight) controller.abort();
      inflight.clear();
      const reader = createReader(normalized, generation);
      active = { repo: normalized, reader };
      return reader;
    },
    getActiveRepository: () => (active ? { ...active.repo } : undefined),
    getRateLimit: () => client.getRateLimit(),
    clearCache: () => client.clearCache(),
    urls
  };
}

module.exports = { createGitHubReadAdapter };
