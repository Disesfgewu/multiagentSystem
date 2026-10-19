'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyVsix } = require('./verify-vsix');

const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-beta(\.\d+)?)?$/;

function releaseName(version, release) {
  if (release === undefined || release === '') return `v${version}-beta`;
  if (typeof release !== 'string' || !RELEASE_TAG.test(release)) {
    throw new TypeError('release must look like v1.2.3, v1.2.3-beta or v1.2.3-beta.4');
  }
  const prefix = `v${version}`;
  if (release !== prefix && !release.startsWith(`${prefix}-`)) {
    throw new TypeError(`release ${release} does not match package version ${version}`);
  }
  return release;
}

function createCandidate({ archive, archiveName, lock, sourceCommit, release }) {
  if (!Buffer.isBuffer(archive) || archive.length === 0) throw new TypeError('archive is required');
  if (typeof archiveName !== 'string' || path.basename(archiveName) !== archiveName || !archiveName.endsWith('.vsix')) {
    throw new TypeError('archiveName must be a VSIX base name');
  }
  if (!COMMIT.test(sourceCommit)) throw new TypeError('sourceCommit must be a full lowercase Git commit');
  const verified = verifyVsix(archive, lock);
  return {
    schemaVersion: 1,
    release: releaseName(verified.version, release),
    version: verified.version,
    prerelease: true,
    sourceCommit,
    artifact: {
      name: archiveName,
      bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      verifiedFileCount: verified.fileCount
    },
    runtimeDependencies: verified.runtimeDependencies
  };
}

function currentCommit() {
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!COMMIT.test(checkedOut)) throw new TypeError('checked-out source commit is invalid');
  const fromCi = process.env.GITHUB_SHA;
  if (typeof fromCi === 'string' && fromCi !== checkedOut) throw new TypeError('GITHUB_SHA differs from checked-out source commit');
  return checkedOut;
}

if (require.main === module) {
  try {
    const [archivePath, outputPath, releaseArgument] = process.argv.slice(2);
    if (!archivePath || !outputPath) throw new TypeError('pass VSIX input and candidate JSON output paths');
    const root = path.join(__dirname, '..');
    const archive = fs.readFileSync(archivePath);
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const candidate = createCandidate({ archive, archiveName: path.basename(archivePath), lock, sourceCommit: currentCommit(), release: releaseArgument ?? process.env.RELEASE_TAG });
    const temporary = `${outputPath}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.rmSync(outputPath, { force: true });
    fs.renameSync(temporary, outputPath);
    process.stdout.write(`Release candidate recorded: ${candidate.release}; ${candidate.artifact.sha256}\n`);
  } catch (error) {
    process.stderr.write(`Release candidate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createCandidate };
