'use strict';

/**
 * The answer an agent wrote for the Ask tab (#357, #360 item 5), read back from the one file the extension named for that question.
 * Pure apart from the file system it is given. The file is the agent's text: it is read as data, never run or followed. It must be a
 * plain file (not a link), inside the agent's private folder, at most 64 KB and valid UTF-8; anything else is said, not shown.
 */

const nodePath = require('node:path');
const crypto = require('node:crypto');

const MAX_ANSWER_BYTES = 64 * 1024;
const ID = /^[a-f0-9]{16}$/;

/** A new question id: 16 hexadecimal digits, made here, never from the page. */
const newQuestionId = () => crypto.randomBytes(8).toString('hex');

/** The file of one question's answer in the agent's answers folder. */
function answerFile(dir, id) {
  if (typeof dir !== 'string' || !nodePath.isAbsolute(dir) || !ID.test(String(id))) return null;
  return nodePath.join(dir, `${id}.md`);
}

const inside = (root, target) => {
  const rel = nodePath.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
};

/**
 * @param {{ file: string, root: string }} where the answer file, and the private folder it must be inside
 * @param {typeof import('node:fs')} [fs]
 * @returns {{ state: 'waiting' } | { state: 'answered', text: string, bytes: number } | { state: 'invalid', reason: string }}
 */
function readAnswer(where, fs = require('node:fs')) {
  const file = where && typeof where.file === 'string' ? where.file : '';
  const root = where && typeof where.root === 'string' ? where.root : '';
  if (!nodePath.isAbsolute(file) || !nodePath.isAbsolute(root)) return { state: 'invalid', reason: 'The answer file is not where it should be.' };
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { return error && error.code === 'ENOENT' ? { state: 'waiting' } : { state: 'invalid', reason: 'The answer file could not be read.' }; }
  // Not followed: a link could point anywhere on this computer.
  if (stat.isSymbolicLink()) return { state: 'invalid', reason: 'The answer is a link to another file, so it is not read.' };
  if (!stat.isFile()) return { state: 'invalid', reason: 'The answer is not a plain file.' };
  if (stat.size > MAX_ANSWER_BYTES) return { state: 'invalid', reason: `The answer is larger than ${MAX_ANSWER_BYTES / 1024} KB, so it is not shown. Open the agent's terminal instead.` };
  let realRoot;
  let realDir;
  try { realRoot = fs.realpathSync(root); realDir = fs.realpathSync(nodePath.dirname(file)); } catch { return { state: 'invalid', reason: 'The answer folder could not be checked.' }; }
  if (!inside(realRoot, nodePath.join(realDir, nodePath.basename(file)))) return { state: 'invalid', reason: 'The answer file is outside the agent\'s private folder, so it is not read.' };
  let bytes;
  try {
    // O_NOFOLLOW where the platform has it: the file cannot be swapped for a link between the check and the read.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(file, flags);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size > MAX_ANSWER_BYTES) return { state: 'invalid', reason: 'The answer changed while it was read.' };
      bytes = fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  } catch { return { state: 'invalid', reason: 'The answer file could not be read.' }; }
  if (bytes.length > MAX_ANSWER_BYTES) return { state: 'invalid', reason: 'The answer changed while it was read.' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { state: 'invalid', reason: 'The answer is not text (UTF-8), so it is not shown.' }; }
  if (text.includes('\0')) return { state: 'invalid', reason: 'The answer is not text, so it is not shown.' };
  // An empty file is the agent still writing (or starting to): wait for words.
  if (text.trim() === '') return { state: 'waiting' };
  return { state: 'answered', text, bytes: bytes.length };
}

module.exports = { readAnswer, answerFile, newQuestionId, MAX_ANSWER_BYTES };
