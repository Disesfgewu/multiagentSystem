import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, UnzipFileInfo } from 'fflate';
import { pruneInstalls } from './pruneInstalls';
const { fetchWithAllowedRedirects, GITHUB_RELEASE_HOSTS } = require('./allowedRedirects') as { fetchWithAllowedRedirects(url: string, options: { allowedHosts: readonly string[]; init?: RequestInit }): Promise<Response>; GITHUB_RELEASE_HOSTS: readonly string[] };

const { ghRelease } = require('./tool-manifest') as {
  ghRelease(platform?: string, arch?: string): GhRelease | null;
};

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const POINTER = 'current.json';
const INSTALL_ID = /^[a-z0-9-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;

export interface GhRelease {
  tool: 'gh';
  version: string;
  platform: string;
  arch: string;
  url: string;
  sha256: string;
  entry: string;
  executable: string;
}

export type GhStatus =
  | { state: 'ready'; version: string; verifiedAt: string; binDir: string; executable: string; source: string }
  | { state: 'missing' | 'corrupt' | 'unsupported'; reason: string };

export interface DownloadProgress { received: number; total: number | null }
export type Downloader = (url: string, maxBytes: number, progress?: (value: DownloadProgress) => void) => Promise<Uint8Array>;

export interface GhManagerDeps {
  root: string;
  boundary?: string;
  platform?: string;
  arch?: string;
  release?: GhRelease | null;
  download?: Downloader;
  now?: () => Date;
  newId?: () => string;
}

type Pointer = {
  schema: 1; installId: string; version: string; platform: string; arch: string;
  archiveSha256: string; executable: string; source: string; verifiedAt: string;
};

const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

async function regularNoLink(target: string): Promise<boolean> {
  try { const found = await fs.promises.lstat(target); return found.isFile() && !found.isSymbolicLink(); } catch { return false; }
}

async function directoryNoLink(target: string): Promise<boolean> {
  try { const found = await fs.promises.lstat(target); return found.isDirectory() && !found.isSymbolicLink(); } catch { return false; }
}

function validRelease(value: GhRelease | null): value is GhRelease {
  if (!value || value.tool !== 'gh' || !['darwin', 'win32'].includes(value.platform) || !['x64', 'arm64'].includes(value.arch) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.url !== 'string' ||
      !value.url.startsWith('https://github.com/cli/cli/releases/download/') || !SHA.test(value.sha256) ||
      typeof value.entry !== 'string' || value.entry.includes('..') || path.posix.isAbsolute(value.entry) ||
      !['gh', 'gh.exe'].includes(value.executable)) return false;
  return value.entry.endsWith(`/bin/${value.executable}`);
}

function validPointer(value: unknown, release: GhRelease): value is Pointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = value as Record<string, unknown>;
  const keys = ['schema', 'installId', 'version', 'platform', 'arch', 'archiveSha256', 'executable', 'source', 'verifiedAt'];
  return Object.keys(pointer).length === keys.length && keys.every((key) => Object.hasOwn(pointer, key)) &&
    pointer.schema === 1 && typeof pointer.installId === 'string' && INSTALL_ID.test(pointer.installId) &&
    pointer.version === release.version && pointer.platform === release.platform && pointer.arch === release.arch &&
    pointer.archiveSha256 === release.sha256 &&
    pointer.executable === release.executable && pointer.source === release.url &&
    typeof pointer.verifiedAt === 'string' && Number.isFinite(Date.parse(pointer.verifiedAt));
}

/**
 * Extracts exactly the pinned entry from an archive already known to match the release's trusted
 * sha256 (the caller verifies that). Shared by prepare() (fresh download) and status() (the retained
 * archive), so the binary that is checked against is always one this function just derived from a
 * hash-anchored archive, never a value some other step merely asserted.
 */
function extractBinary(archive: Uint8Array, release: GhRelease): Uint8Array {
  let entrySeen = false;
  const extracted = unzipSync(archive, {
    filter: (file: UnzipFileInfo) => {
      if (file.name !== release.entry) return false;
      entrySeen = true;
      if (file.originalSize < 1 || file.originalSize > MAX_BINARY_BYTES) throw new Error('binary-size-invalid');
      return true;
    }
  });
  const binary = extracted[release.entry];
  if (!entrySeen || !(binary instanceof Uint8Array) || binary.byteLength < 1 || binary.byteLength > MAX_BINARY_BYTES) throw new Error('archive-entry-missing');
  return binary;
}

export const downloadHttps: Downloader = async (url, maxBytes, progress) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Error('source-refused');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchWithAllowedRedirects(url, { allowedHosts: GITHUB_RELEASE_HOSTS, init: { signal: controller.signal, headers: { accept: 'application/octet-stream' } } });
    if (!response.ok || !response.body) throw new Error('download-failed');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('download-too-large');
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) { await reader.cancel(); throw new Error('download-too-large'); }
      chunks.push(next.value);
      progress?.({ received, total: Number.isFinite(declared) && declared >= 0 ? declared : null });
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  } finally { clearTimeout(timer); }
};

export class ManagedGh {
  private readonly release: GhRelease | null;
  private readonly download: Downloader;
  private readonly now: () => Date;
  private readonly newId: () => string;
  readonly root: string;
  private readonly boundary: string;

  constructor(deps: GhManagerDeps) {
    this.root = path.resolve(deps.root);
    this.boundary = path.resolve(deps.boundary ?? deps.root);
    this.release = deps.release === undefined ? ghRelease(deps.platform, deps.arch) : deps.release;
    this.download = deps.download ?? downloadHttps;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  private pointerPath(): string { return path.join(this.root, POINTER); }

  private async rootAllowed(): Promise<boolean> {
    if (!await directoryNoLink(this.root) || !await directoryNoLink(this.boundary)) return false;
    try {
      const [realRoot, realBoundary] = await Promise.all([fs.promises.realpath(this.root), fs.promises.realpath(this.boundary)]);
      return realRoot === realBoundary || inside(realBoundary, realRoot);
    } catch { return false; }
  }

  /**
   * Creates each directory below the already verified storage boundary separately. A recursive
   * mkdir could follow a pre-existing symlink in an intermediate component and write outside the
   * editor's private storage before rootAllowed() had a chance to reject it.
   */
  private async ensureRoot(): Promise<boolean> {
    if (!await directoryNoLink(this.boundary)) return false;
    const relative = path.relative(this.boundary, this.root);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
    let current = this.boundary;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try { await fs.promises.mkdir(current, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
      if (!await directoryNoLink(current)) return false;
    }
    return await this.rootAllowed();
  }

  async status(): Promise<GhStatus> {
    if (!validRelease(this.release)) return { state: 'unsupported', reason: 'platform-or-source-unverified' };
    if (!path.isAbsolute(this.root) || !await this.rootAllowed()) return { state: 'missing', reason: 'managed-folder-unavailable' };
    const pointerPath = this.pointerPath();
    if (!await regularNoLink(pointerPath)) return { state: 'missing', reason: 'not-prepared' };
    let value: unknown;
    try {
      const bytes = await fs.promises.readFile(pointerPath);
      if (bytes.byteLength > 4096) return { state: 'corrupt', reason: 'invalid-install-record' };
      value = JSON.parse(bytes.toString('utf8'));
    } catch { return { state: 'corrupt', reason: 'invalid-install-record' }; }
    if (!validPointer(value, this.release)) return { state: 'corrupt', reason: 'invalid-install-record' };
    // 'installs' is a fixed, reused path component. If it were ever replaced by a symlink before
    // this install existed, every path built under it would resolve outside the boundary even
    // though each of THOSE path's own final components is a real, non-symlink entry. It is checked
    // on every status() call, not only when prepare() happens to (re)create it.
    const installsDir = path.join(this.root, 'installs');
    if (!await directoryNoLink(installsDir)) return { state: 'corrupt', reason: 'managed-path-replaced' };
    const install = path.join(installsDir, value.installId);
    const binDir = path.join(install, 'bin');
    const executable = path.join(binDir, value.executable);
    const archivePath = path.join(install, 'archive.zip');
    if (!inside(this.root, install) || !await directoryNoLink(install) || !await directoryNoLink(binDir) ||
        !await regularNoLink(executable) || !await regularNoLink(archivePath)) return { state: 'corrupt', reason: 'managed-path-replaced' };
    // The binary is never trusted from a scalar some earlier step merely asserted (that value could
    // be edited to match a tampered binary with nothing left to catch it). It is re-derived here from
    // the retained archive, and that archive is itself re-checked against the hardcoded release
    // digest, so an attacker must defeat a hash they do not control to make either lie convincing.
    let archive: Buffer;
    try {
      archive = await fs.promises.readFile(archivePath);
      if (archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) return { state: 'corrupt', reason: 'managed-archive-changed' };
    } catch { return { state: 'corrupt', reason: 'managed-archive-unreadable' }; }
    if (hash(archive) !== this.release.sha256) return { state: 'corrupt', reason: 'managed-archive-changed' };
    let expectedBinary: Uint8Array;
    try { expectedBinary = extractBinary(archive, this.release); } catch { return { state: 'corrupt', reason: 'managed-archive-changed' }; }
    try {
      const binary = await fs.promises.readFile(executable);
      if (binary.byteLength < 1 || binary.byteLength > MAX_BINARY_BYTES || hash(binary) !== hash(expectedBinary)) return { state: 'corrupt', reason: 'managed-binary-changed' };
    } catch { return { state: 'corrupt', reason: 'managed-binary-unreadable' }; }
    return { state: 'ready', version: value.version, verifiedAt: value.verifiedAt, binDir, executable, source: value.source };
  }

  async prepare(progress?: (value: DownloadProgress) => void): Promise<GhStatus> {
    if (!validRelease(this.release)) return { state: 'unsupported', reason: 'platform-or-source-unverified' };
    const current = await this.status();
    if (current.state === 'ready') return current;
    try {
      if (!await this.ensureRoot()) return { state: 'corrupt', reason: 'managed-folder-replaced' };
    } catch { return { state: 'missing', reason: 'managed-folder-unavailable' }; }

    const safeVersion = this.release.version.replace(/\./g, '-');
    const id = `gh-${safeVersion}-${this.release.platform}-${this.release.arch}-${this.newId().replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24)}`;
    if (!INSTALL_ID.test(id)) return { state: 'corrupt', reason: 'install-id-invalid' };
    const staging = path.join(this.root, `staging-${id}`);
    const installsDir = path.join(this.root, 'installs');
    const install = path.join(installsDir, id);
    const pointerTemp = path.join(this.root, `.current-${id}.json`);
    if (!inside(this.root, staging) || !inside(this.root, install)) return { state: 'corrupt', reason: 'managed-path-invalid' };
    try {
      const archive = await this.download(this.release.url, MAX_ARCHIVE_BYTES, progress);
      if (!(archive instanceof Uint8Array) || archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('download-invalid');
      if (hash(archive) !== this.release.sha256) throw new Error('integrity-mismatch');
      const binary = extractBinary(archive, this.release);
      await fs.promises.mkdir(path.join(staging, 'bin'), { recursive: true, mode: 0o700 });
      const executable = path.join(staging, 'bin', this.release.executable);
      await fs.promises.writeFile(executable, binary, { mode: 0o700, flag: 'wx' });
      // The verified archive itself moves into the install directory, read-only: status() re-derives
      // the expected binary from it on every check instead of trusting a scalar hash on its own.
      await fs.promises.writeFile(path.join(staging, 'archive.zip'), archive, { mode: 0o400, flag: 'wx' });
      const pointer: Pointer = {
        schema: 1, installId: id, version: this.release.version, platform: this.release.platform, arch: this.release.arch,
        archiveSha256: this.release.sha256, executable: this.release.executable,
        source: this.release.url, verifiedAt: this.now().toISOString()
      };
      await fs.promises.writeFile(path.join(staging, POINTER), JSON.stringify(pointer), { mode: 0o600, flag: 'wx' });
      // 'installs' is reused across every install this manager ever makes. A recursive mkdir would
      // silently follow it if something had already replaced it with a symlink; create and verify it
      // as its own real, non-symlink step, not folded into one recursive call with the rename target.
      try { await fs.promises.mkdir(installsDir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!await directoryNoLink(installsDir)) throw new Error('installs-dir-replaced');
      await fs.promises.rename(staging, install);
      await fs.promises.writeFile(pointerTemp, JSON.stringify(pointer), { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(pointerTemp, this.pointerPath());
      await pruneInstalls(installsDir, id, { pointerFile: this.pointerPath() });
      return await this.status();
    } catch (error) {
      // Do not follow a replaced parent while cleaning up. In that case leaving this attempt's
      // private staging name behind is safer than deleting through an unverified path.
      if (await this.rootAllowed()) {
        try { await fs.promises.rm(staging, { recursive: true, force: true }); } catch { /* best effort only inside this attempt's staging folder */ }
        try { await fs.promises.rm(pointerTemp, { force: true }); } catch { /* best effort only for this attempt's pointer */ }
      }
      const reason = error instanceof Error && error.message === 'integrity-mismatch' ? 'archive-integrity-failed'
        : error instanceof Error && ['archive-entry-missing', 'binary-size-invalid'].includes(error.message) ? 'archive-invalid'
          : error instanceof Error && error.message === 'installs-dir-replaced' ? 'managed-folder-replaced'
            : 'download-or-install-failed';
      const after = await this.status();
      return after.state === 'ready' ? after : { state: 'missing', reason };
    }
  }
}

export function prependPath(binDir: string, environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Record<string, string> {
  const key = platform === 'win32' ? (Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'Path') : 'PATH';
  const existing = environment[key] ?? '';
  return { [key]: existing ? `${binDir}${path.delimiter}${existing}` : binDir };
}
