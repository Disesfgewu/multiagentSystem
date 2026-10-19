import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pruneInstalls } from './pruneInstalls';
const { fetchWithAllowedRedirects, CLAUDE_HOSTS } = require('./allowedRedirects') as { fetchWithAllowedRedirects(url: string, options: { allowedHosts: readonly string[]; init?: RequestInit }): Promise<Response>; CLAUDE_HOSTS: readonly string[] };

const { claudeRelease } = require('./tool-manifest') as {
  claudeRelease(platform?: string, arch?: string): ClaudeRelease | null;
};

// Pinned Claude Code 2.1.89 assets range from ~196 MB (darwin) to ~238 MB (win32).
const MAX_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_BINARY_BYTES = 384 * 1024 * 1024;
const POINTER = 'current.json';
const INSTALL_ID = /^[a-z0-9-]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ClaudeRelease {
  tool: 'claude';
  version: string;
  platform: string;
  arch: string;
  url: string;
  sha256: string;
  format: 'raw';
  entry: null;
  executable: string;
}

export type ClaudeStatus =
  | { state: 'ready'; version: string; verifiedAt: string; binDir: string; executable: string; source: string }
  | { state: 'missing' | 'corrupt' | 'unsupported'; reason: string };

export interface DownloadProgress { received: number; total: number | null }
export type Downloader = (url: string, maxBytes: number, progress?: (value: DownloadProgress) => void, signal?: AbortSignal) => Promise<Uint8Array>;

export interface ClaudeManagerDeps {
  root: string;
  boundary?: string;
  platform?: string;
  arch?: string;
  release?: ClaudeRelease | null;
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

function validRelease(value: ClaudeRelease | null): value is ClaudeRelease {
  if (!value || value.tool !== 'claude' || !['darwin', 'win32'].includes(value.platform) || !['x64', 'arm64'].includes(value.arch) ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.url !== 'string' ||
      !value.url.startsWith('https://downloads.claude.ai/claude-code-releases/') || !SHA.test(value.sha256) ||
      value.format !== 'raw' || !['claude', 'claude.exe'].includes(value.executable)) return false;
  const expectedName = value.platform === 'win32' ? 'claude.exe' : 'claude';
  const expectedUrl = `https://downloads.claude.ai/claude-code-releases/${value.version}/${value.platform}-${value.arch}/${expectedName}`;
  if (value.url !== expectedUrl) return false;
  return value.entry === null && value.executable === expectedName;
}

function validPointer(value: unknown, release: ClaudeRelease): value is Pointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = value as Record<string, unknown>;
  const keys = ['schema', 'installId', 'version', 'platform', 'arch', 'archiveSha256', 'executable', 'source', 'verifiedAt'];
  return Object.keys(pointer).length === keys.length && keys.every((key) => Object.hasOwn(pointer, key)) &&
    pointer.schema === 1 && typeof pointer.installId === 'string' && INSTALL_ID.test(pointer.installId) &&
    pointer.version === release.version && pointer.platform === release.platform && pointer.arch === release.arch &&
    pointer.archiveSha256 === release.sha256 &&
    pointer.executable === release.executable && pointer.source === release.url &&
    typeof pointer.verifiedAt === 'string' && UTC_INSTANT.test(pointer.verifiedAt) &&
    Number.isFinite(Date.parse(pointer.verifiedAt)) && new Date(pointer.verifiedAt).toISOString() === pointer.verifiedAt;
}

function extractBinary(archive: Uint8Array, release: ClaudeRelease): Uint8Array {
  if (release.format !== 'raw') throw new Error('archive-invalid');
  if (archive.byteLength < 1 || archive.byteLength > MAX_BINARY_BYTES) throw new Error('binary-size-invalid');
  return archive;
}

export const downloadHttps: Downloader = async (url, maxBytes, progress, signal) => {
  if (signal?.aborted) throw new Error('download-cancelled');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'downloads.claude.ai') throw new Error('source-refused');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchWithAllowedRedirects(url, { allowedHosts: CLAUDE_HOSTS, init: { signal: controller.signal, headers: { accept: 'application/octet-stream' } } });
    if (!response.ok || !response.body) throw new Error('download-failed');
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('download-too-large');
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new Error('download-cancelled');
      }
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
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message === 'download-cancelled')) {
      throw new Error('download-cancelled');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

export class ManagedClaude {
  private readonly release: ClaudeRelease | null;
  private readonly download: Downloader;
  private readonly now: () => Date;
  private readonly newId: () => string;
  readonly root: string;
  private readonly boundary: string;

  constructor(deps: ClaudeManagerDeps) {
    this.root = path.resolve(deps.root);
    this.boundary = path.resolve(deps.boundary ?? deps.root);
    this.release = deps.release === undefined ? claudeRelease(deps.platform, deps.arch) : deps.release;
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

  async status(): Promise<ClaudeStatus> {
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

    const installsDir = path.join(this.root, 'installs');
    if (!await directoryNoLink(installsDir)) return { state: 'corrupt', reason: 'managed-path-replaced' };
    const install = path.join(installsDir, value.installId);
    const binDir = path.join(install, 'bin');
    const executable = path.join(binDir, value.executable);
    const archivePath = path.join(install, 'asset.bin');
    if (!inside(this.root, install) || !await directoryNoLink(install) || !await directoryNoLink(binDir) ||
        !await regularNoLink(executable) || !await regularNoLink(archivePath)) return { state: 'corrupt', reason: 'managed-path-replaced' };

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

  async prepare(
    optionsOrProgress?: ((value: DownloadProgress) => void) | { progress?: (value: DownloadProgress) => void; signal?: AbortSignal },
    maybeSignal?: AbortSignal
  ): Promise<ClaudeStatus> {
    const progress = typeof optionsOrProgress === 'function' ? optionsOrProgress : optionsOrProgress?.progress;
    const signal = typeof optionsOrProgress === 'object' && optionsOrProgress?.signal ? optionsOrProgress.signal : maybeSignal;
    if (!validRelease(this.release)) return { state: 'unsupported', reason: 'platform-or-source-unverified' };
    const current = await this.status();
    if (current.state === 'ready') return current;
    if (signal?.aborted) return { state: 'missing', reason: 'download-cancelled' };
    try {
      if (!await this.ensureRoot()) return { state: 'corrupt', reason: 'managed-folder-replaced' };
    } catch { return { state: 'missing', reason: 'managed-folder-unavailable' }; }

    const safeVersion = this.release.version.replace(/\./g, '-');
    const id = `claude-${safeVersion}-${this.release.platform}-${this.release.arch}-${this.newId().replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 24)}`;
    if (!INSTALL_ID.test(id)) return { state: 'corrupt', reason: 'install-id-invalid' };
    const staging = path.join(this.root, `staging-${id}`);
    const installsDir = path.join(this.root, 'installs');
    const install = path.join(installsDir, id);
    const pointerTemp = path.join(this.root, `.current-${id}.json`);
    if (!inside(this.root, staging) || !inside(this.root, install)) return { state: 'corrupt', reason: 'managed-path-invalid' };

    try {
      const archive = await this.download(this.release.url, MAX_ARCHIVE_BYTES, progress, signal);
      if (signal?.aborted) throw new Error('download-cancelled');
      if (!(archive instanceof Uint8Array) || archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('download-invalid');
      if (hash(archive) !== this.release.sha256) throw new Error('integrity-mismatch');
      const binary = extractBinary(archive, this.release);
      await fs.promises.mkdir(path.join(staging, 'bin'), { recursive: true, mode: 0o700 });
      const executable = path.join(staging, 'bin', this.release.executable);
      await fs.promises.writeFile(executable, binary, { mode: 0o700, flag: 'wx' });
      await fs.promises.writeFile(path.join(staging, 'asset.bin'), archive, { mode: 0o400, flag: 'wx' });
      const pointer: Pointer = {
        schema: 1, installId: id, version: this.release.version, platform: this.release.platform, arch: this.release.arch,
        archiveSha256: this.release.sha256, executable: this.release.executable,
        source: this.release.url, verifiedAt: this.now().toISOString()
      };
      await fs.promises.writeFile(path.join(staging, POINTER), JSON.stringify(pointer), { mode: 0o600, flag: 'wx' });

      try { await fs.promises.mkdir(installsDir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!await directoryNoLink(installsDir)) throw new Error('installs-dir-replaced');
      if (signal?.aborted) throw new Error('download-cancelled');
      await fs.promises.rename(staging, install);
      await fs.promises.writeFile(pointerTemp, JSON.stringify(pointer), { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(pointerTemp, this.pointerPath());
      await pruneInstalls(installsDir, id, { pointerFile: this.pointerPath() });
      return await this.status();
    } catch (error) {
      if (await this.rootAllowed()) {
        try { await fs.promises.rm(staging, { recursive: true, force: true }); } catch { /* best effort */ }
        try { await fs.promises.rm(pointerTemp, { force: true }); } catch { /* best effort */ }
      }
      const isCancelled = signal?.aborted || (error instanceof Error && error.message === 'download-cancelled');
      const reason = isCancelled ? 'download-cancelled'
        : error instanceof Error && error.message === 'integrity-mismatch' ? 'archive-integrity-failed'
        : error instanceof Error && ['binary-size-invalid', 'archive-invalid'].includes(error.message) ? 'archive-invalid'
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
