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

function ghRelease(platform = process.platform, arch = process.arch) {
  const asset = GH_ASSETS[`${platform}-${arch}`];
  return asset ? Object.freeze({ tool: 'gh', version: GH_VERSION, platform, arch, ...asset }) : null;
}

module.exports = { GH_VERSION, GH_ASSETS, ghRelease };
