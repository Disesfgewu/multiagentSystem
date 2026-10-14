'use strict';

const { createGitHubReadAdapter } = require('./adapter');
const { createGitHubClient } = require('./client');
const { createFetchTransport, TransportError } = require('./transport');
const { isSuccess, isFailure, SUCCESS_KINDS, FAILURE_KINDS, INCOMPLETE_KINDS } = require('./result');
const { assessApprovals } = require('./approval');
const { summarizeChecks } = require('./checks');
const { mergeBranchRequirements } = require('./requirements');
const { extractIssueReferences } = require('./references');
const { createUrlBuilder } = require('./urls');

module.exports = {
  createGitHubReadAdapter,
  createGitHubClient,
  createFetchTransport,
  TransportError,
  isSuccess,
  isFailure,
  SUCCESS_KINDS,
  FAILURE_KINDS,
  INCOMPLETE_KINDS,
  assessApprovals,
  summarizeChecks,
  mergeBranchRequirements,
  extractIssueReferences,
  createUrlBuilder
};
