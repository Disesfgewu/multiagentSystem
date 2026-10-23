'use strict';

/**
 * Who wrote a GitHub comment or review, as the report shows it (issue #342). The owner and every agent post with one shared GitHub
 * account and the repository is public, so the login says nothing about the person, and a missing signature does not make a comment
 * the owner's. The three answers, in this order:
 *   - the owner: its id is in the private record of what the owner published from VS Code (`ownerPosts.js`);
 *   - `Worker-01（自稱）`: its first line is an agent's signature. A claim the agent made, not proof;
 *   - unsigned: neither. When the owner record could not be read, it says so instead of guessing.
 * The text never contains " · ": the report uses that to separate fields, and the inline-comment links read the field after it.
 */

const SIGNATURE = /^\s*(?:—|–|-{1,2})\s*((?:PM|[A-Z][a-z]{1,19})-[0-9]{2,4})\s*$/;

/** The codename a body signs with on its first line, or null. */
function signatureOf(body) {
  if (typeof body !== 'string') return null;
  const first = body.split(/\r?\n/, 1)[0];
  const match = SIGNATURE.exec(first);
  return match ? match[1] : null;
}

/**
 * @param {{ id?: unknown, body?: unknown }} item a comment or review as the GitHub adapter gives it
 * @param {'comment' | 'review' | 'inline'} kind inline review comments cannot be posted from VS Code, so they are never the owner's
 * @param {{ comments: Set<number>, reviews: Set<number> } | null} owner the owner record, or null when it could not be read
 * @returns {{ who: 'owner' | 'agent' | 'unsigned' | 'unknown', codename: string | null, text: string }}
 */
function authorOf(item, kind, owner) {
  const id = item && Number.isSafeInteger(item.id) ? item.id : null;
  const recorded = owner && id !== null ? (kind === 'comment' ? owner.comments : kind === 'review' ? owner.reviews : null) : null;
  if (recorded && recorded.has(id)) return { who: 'owner', codename: null, text: '管理者' };
  const codename = signatureOf(item ? item.body : null);
  if (codename) return { who: 'agent', codename, text: `${codename}（自稱）` };
  if (owner === null && kind !== 'inline') return { who: 'unknown', codename: null, text: '未署名（讀不到管理者的留言紀錄，無法確認是不是管理者）' };
  return { who: 'unsigned', codename: null, text: '未署名' };
}

module.exports = { authorOf, signatureOf };
