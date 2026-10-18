'use strict';

// Every deployable asset is fixed here. Nothing comes from a workspace setting or a remote
// manifest at runtime. The hashes are the release publisher's SHA-256 values recorded in
// docs/TOOL_SOURCE_MATRIX.md; ManagedGh.prepare recalculates them before extracting anything.
const GH_VERSION = '2.102.0';
const GH_BASE = `https://github.com/cli/cli/releases/download/v${GH_VERSION}`;

const GH_ASSETS = Object.freeze({
  'darwin-x64': Object.freeze({
    url: `${GH_BASE}/gh_${GH_VERSION}_macOS_amd64.zip`,
    sha256: 'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3',
    entry: `gh_${GH_VERSION}_macOS_amd64/bin/gh`, executable: 'gh'
  }),
  'darwin-arm64': Object.freeze({
    url: `${GH_BASE}/gh_${GH_VERSION}_macOS_arm64.zip`,
    sha256: 'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e',
    entry: `gh_${GH_VERSION}_macOS_arm64/bin/gh`, executable: 'gh'
  }),
  'win32-x64': Object.freeze({
    url: `${GH_BASE}/gh_${GH_VERSION}_windows_amd64.zip`,
    sha256: 'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4',
    entry: `gh_${GH_VERSION}_windows_amd64/bin/gh.exe`, executable: 'gh.exe'
  }),
  'win32-arm64': Object.freeze({
    url: `${GH_BASE}/gh_${GH_VERSION}_windows_arm64.zip`,
    sha256: '5dcf12aa8525eabd0c46ec414f323ab6cf65229fc2cd46543cc705001bbaf223',
    entry: `gh_${GH_VERSION}_windows_arm64/bin/gh.exe`, executable: 'gh.exe'
  })
});

const CODEX_VERSION = '0.163.0';
const CODEX_TAG = `rust-v${CODEX_VERSION}`;
const CODEX_BASE = `https://github.com/openai/codex/releases/download/${CODEX_TAG}`;
const CODEX_ASSETS = Object.freeze({
  'darwin-x64': Object.freeze({
    url: `${CODEX_BASE}/codex-x86_64-apple-darwin.tar.gz`,
    sha256: '562a1aea0e5686283a467687d268ae33705f02fd4d40f1bc4110a415c5c1c7b1',
    format: 'tar.gz', entry: 'codex-x86_64-apple-darwin', executable: 'codex'
  }),
  'darwin-arm64': Object.freeze({
    url: `${CODEX_BASE}/codex-aarch64-apple-darwin.tar.gz`,
    sha256: '61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10',
    format: 'tar.gz', entry: 'codex-aarch64-apple-darwin', executable: 'codex'
  }),
  'win32-x64': Object.freeze({
    url: `${CODEX_BASE}/codex-x86_64-pc-windows-msvc.exe`,
    sha256: '2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993',
    format: 'raw', entry: null, executable: 'codex.exe'
  }),
  'win32-arm64': Object.freeze({
    url: `${CODEX_BASE}/codex-aarch64-pc-windows-msvc.exe`,
    sha256: 'babd1ee5a76e4299d18f7ef99aa39d330e176e837566d3e2325d9b6b64e1ca61',
    format: 'raw', entry: null, executable: 'codex.exe'
  })
});

function ghRelease(platform = process.platform, arch = process.arch) {
  const asset = GH_ASSETS[`${platform}-${arch}`];
  return asset ? Object.freeze({ tool: 'gh', version: GH_VERSION, platform, arch, ...asset }) : null;
}

function codexRelease(platform = process.platform, arch = process.arch) {
  const asset = CODEX_ASSETS[`${platform}-${arch}`];
  return asset ? Object.freeze({ tool: 'codex', version: CODEX_VERSION, platform, arch, ...asset }) : null;
}

const CLAUDE_VERSION = '2.1.89';
const CLAUDE_BASE = `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}`;
const CLAUDE_ASSETS = Object.freeze({
  'darwin-x64': Object.freeze({
    url: `${CLAUDE_BASE}/darwin-x64/claude`,
    sha256: '1322c5eecec8047e9cd7114f7d547ef6a9596563d6bbc7e594167d0f8bc8b406',
    format: 'raw', entry: null, executable: 'claude'
  }),
  'darwin-arm64': Object.freeze({
    url: `${CLAUDE_BASE}/darwin-arm64/claude`,
    sha256: 'f903a5e53f845b1ac5566296b713193827665f28da16300fdca7539cb0669a7f',
    format: 'raw', entry: null, executable: 'claude'
  }),
  'win32-x64': Object.freeze({
    url: `${CLAUDE_BASE}/win32-x64/claude.exe`,
    sha256: '2e312000b538f11d13f1dfc52d4131996895b9a07bd8897d8f9153635d4ea092',
    format: 'raw', entry: null, executable: 'claude.exe'
  }),
  'win32-arm64': Object.freeze({
    url: `${CLAUDE_BASE}/win32-arm64/claude.exe`,
    sha256: '5f1d597c542aac3a11f557e12c92d0c49220ab77e741014b0599a572d81ca679',
    format: 'raw', entry: null, executable: 'claude.exe'
  })
});

function claudeRelease(platform = process.platform, arch = process.arch) {
  const asset = CLAUDE_ASSETS[`${platform}-${arch}`];
  return asset ? Object.freeze({ tool: 'claude', version: CLAUDE_VERSION, platform, arch, ...asset }) : null;
}

/**
 * agy CLI deployment support assessment (Refs #73, #94, docs/AGY_INVESTIGATION.md).
 * Returns null for all platforms. Google Antigravity CLI does not publish fixed standalone
 * release binaries with official SHA-256 metadata or redistribution terms that satisfy
 * extension-managed automated deployment. The CLI must be installed manually by the user.
 */
function agyRelease(_platform = process.platform, _arch = process.arch) {
  return null;
}

module.exports = {
  GH_VERSION, GH_ASSETS, ghRelease,
  CODEX_VERSION, CODEX_ASSETS, codexRelease,
  CLAUDE_VERSION, CLAUDE_ASSETS, claudeRelease,
  agyRelease
};

