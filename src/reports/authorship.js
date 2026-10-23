'use strict';

/**
 * Who wrote a GitHub comment or review, as the report shows it (issue #342). The owner and every agent post with one shared GitHub
 * account and the repository is public, so the login says nothing about the person, and a missing signature does not make a comment
 * the owner's. The answers, in this order:
 *   - the owner: its id is in the private record of what the owner published from VS Code (`ownerPosts.js`) AND its text is still
 *     exactly the text recorded (same SHA-256). The account is shared, so an agent can edit the owner's comment afterwards;
 *   - modified: the id is the owner's but the text has changed since. Who changed it cannot be told, so it is never the owner's;
 *   - `Worker-01（自稱）`: its first line is an agent's signature, read as the agents' gh wrapper reads it. A claim, not proof. A
 *     codename whose prefix reads like the person in charge (`Admin-01`, `Owner-01`) is never given out, so it is not one;
 *   - unsigned: none of these. When the owner record could not be read, it says so instead of guessing.
 * The text never contains " · ": the report uses that to separate fields, and the inline-comment links read the field after it.
 */

// The same reading of a signature as the agents' gh wrapper (`decide.js`): invisible marks removed, every Unicode dash made one.
const { signedAs, LINES } = require('../sessions/ghGuard/decide');
const { OWNER_LIKE } = require('../sessions/codenames');
const { bodyHash } = require('./ownerPosts');
const CODENAME = /^(PM|[A-Z][a-z]{1,19})-[0-9]{2,4}$/;

/** The codename a body signs with on its first line, or null. Only a codename this extension could have given out counts. */
function signatureOf(body) {
  if (typeof body !== 'string') return null;
  const codename = signedAs(body.split(LINES, 1)[0]);
  const match = codename === null ? null : CODENAME.exec(codename);
  return match && !OWNER_LIKE.includes(match[1].toLowerCase()) ? codename : null;
}

/**
 * @param {{ id?: unknown, body?: unknown }} item a comment or review as the GitHub adapter gives it
 * @param {'comment' | 'review' | 'inline'} kind inline review comments cannot be posted from VS Code, so they are never the owner's
 * @param {{ comments: Map<number, string>, reviews: Map<number, string> } | null} owner the owner record (id to SHA-256 of the text),
 *   or null when it could not be read
 * @returns {{ who: 'owner' | 'modified' | 'agent' | 'unsigned' | 'unknown', codename: string | null, text: string }}
 */
function authorOf(item, kind, owner) {
  const id = item && Number.isSafeInteger(item.id) ? item.id : null;
  const recorded = owner && id !== null ? (kind === 'comment' ? owner.comments : kind === 'review' ? owner.reviews : null) : null;
  if (recorded && recorded.has(id)) {
    // An entry from before texts were hashed has null here, which no hash equals: it cannot be confirmed either.
    const same = typeof item.body === 'string' && recorded.get(id) === bodyHash(item.body);
    if (same) return { who: 'owner', codename: null, text: '管理者' };
    return { who: 'modified', codename: null, text: '管理者發的留言，但之後被修改過，無法確認作者' };
  }
  const codename = signatureOf(item ? item.body : null);
  if (codename) return { who: 'agent', codename, text: `${codename}（自稱）` };
  if (owner === null && kind !== 'inline') return { who: 'unknown', codename: null, text: '未署名（讀不到管理者的留言紀錄，無法確認是不是管理者）' };
  return { who: 'unsigned', codename: null, text: '未署名' };
}

module.exports = { authorOf, signatureOf };
