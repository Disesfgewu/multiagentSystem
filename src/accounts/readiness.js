'use strict';

// Builds the redacted per-profile record the check script prints. Only codes,
// booleans and variable names are kept; no identity, path or credential value.
function reportEntry(id, { validation, blockers, identity }) {
  return {
    id,
    configDirProblems: validation.problems,
    launchBlockers: blockers.map((blocker) => blocker.variable),
    loggedIn: identity ? identity.loggedIn : null,
    authMethod: identity ? identity.authMethod : null,
    apiProvider: identity ? identity.apiProvider : null,
    configDirMatches: identity ? identity.configDirMatches : null,
    anomalies: identity ? identity.anomalies : [],
    subject: identity ? identity.subject.confidence : 'unknown',
    subjectReason: identity
      ? identity.subject.reason || null
      : (validation.ok ? 'cli-unavailable-or-error' : 'not-inspected-invalid-profile')
  };
}

// A profile is ready for a managed launch only when everything needed to say
// which account will run is known and consistent. Unknown is never ready: a
// missing directory report (null) is a reason, not a pass.
function profileReadiness(entry) {
  const reasons = [];
  for (const problem of entry.configDirProblems || []) reasons.push(`config-dir:${problem}`);
  for (const name of entry.launchBlockers || []) reasons.push(`credential-override:${name}`);

  if (entry.loggedIn === null || entry.loggedIn === undefined) reasons.push('not-inspected');
  else if (entry.loggedIn !== true) reasons.push('not-logged-in');

  if (entry.subject !== 'actual') reasons.push('subject-unverified');

  if (entry.configDirMatches === false) reasons.push('config-dir-mismatch');
  else if (entry.configDirMatches !== true) reasons.push('config-dir-unverified');

  for (const anomaly of entry.anomalies || []) {
    if (anomaly !== 'config-dir-mismatch') reasons.push(`anomaly:${anomaly}`);
  }
  return { ready: reasons.length === 0, reasons };
}

function fleetReadiness(entries, { conflicts = [], duplicates = [] } = {}) {
  const reasons = [];
  for (const conflict of conflicts) reasons.push(`config-dir-conflict:${conflict.kind}`);
  if (duplicates.length > 0) reasons.push('duplicate-account');
  const everyone = entries.map((entry) => profileReadiness(entry));
  return {
    ready: reasons.length === 0 && everyone.every((entry) => entry.ready),
    reasons
  };
}

module.exports = { reportEntry, profileReadiness, fleetReadiness };
