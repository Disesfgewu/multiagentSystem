'use strict';

// Extracts exactly one named regular file from an already hash-verified release archive, in memory.
// Nothing is written and nothing is executed here. Anything unexpected (a missing entry, a duplicate,
// an oversize file, a truncated or malformed archive) throws instead of guessing.

const zlib = require('node:zlib');
const { unzipSync } = require('fflate');

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;

class ArchiveError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

function tarNumber(block, start, length) {
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('archive-invalid');
  return parseInt(text, 8);
}

function extractFromTarGz(archive, entry) {
  let tar;
  try { tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES }); } catch { throw new ArchiveError('archive-invalid'); }
  let found = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const name = prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw new ArchiveError('archive-invalid');
    // Only a plain regular file can match; links, directories and pax/GNU extension headers never do.
    if ((type === '0' || type === '\0') && name === entry) {
      if (found) throw new ArchiveError('archive-entry-duplicate');
      if (size < 1 || size > MAX_ENTRY_BYTES) throw new ArchiveError('archive-entry-size-invalid');
      found = Uint8Array.from(tar.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new ArchiveError('archive-entry-missing');
  return found;
}

function extractFromZip(archive, entry) {
  let seen = 0;
  let out;
  try {
    out = unzipSync(archive, {
      filter: (file) => {
        if (file.name !== entry) return false;
        seen += 1;
        if (file.originalSize < 1 || file.originalSize > MAX_ENTRY_BYTES) throw new ArchiveError('archive-entry-size-invalid');
        return true;
      }
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('archive-invalid');
  }
  if (seen > 1) throw new ArchiveError('archive-entry-duplicate');
  const bytes = out[entry];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_ENTRY_BYTES) throw new ArchiveError('archive-entry-missing');
  return bytes;
}

/**
 * @param {Uint8Array} archive verified archive bytes
 * @param {'tar.gz' | 'zip'} format
 * @param {string} entry exact archive path of the file to return
 * @returns {Uint8Array}
 */
function extractEntry(archive, format, entry) {
  if (!(archive instanceof Uint8Array) || archive.byteLength < 1) throw new ArchiveError('archive-invalid');
  if (typeof entry !== 'string' || entry === '') throw new ArchiveError('archive-entry-missing');
  if (format === 'tar.gz') return extractFromTarGz(archive, entry);
  if (format === 'zip') return extractFromZip(archive, entry);
  throw new ArchiveError('archive-format-unsupported');
}

module.exports = { ArchiveError, extractEntry };
