'use strict';

const { isSuccess } = require('./result');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyRequirements() {
  return {
    requiredApprovingReviewCount: 0,
    dismissStaleReviewsOnPush: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireThreadResolution: false,
    requiredStatusChecks: [],
    strictStatusChecks: false,
    ruleTypes: []
  };
}

function applyRuleset(target, rules) {
  for (const rule of rules) {
    if (!isObject(rule) || typeof rule.type !== 'string') continue;
    target.ruleTypes.push(rule.type);
    const parameters = isObject(rule.parameters) ? rule.parameters : {};
    if (rule.type === 'pull_request') {
      target.requiredApprovingReviewCount = Math.max(
        target.requiredApprovingReviewCount,
        Number.isInteger(parameters.required_approving_review_count) ? parameters.required_approving_review_count : 0
      );
      target.dismissStaleReviewsOnPush ||= parameters.dismiss_stale_reviews_on_push === true;
      target.requireCodeOwnerReview ||= parameters.require_code_owner_review === true;
      target.requireLastPushApproval ||= parameters.require_last_push_approval === true;
      target.requireThreadResolution ||= parameters.required_review_thread_resolution === true;
    } else if (rule.type === 'required_status_checks') {
      const checks = Array.isArray(parameters.required_status_checks) ? parameters.required_status_checks : [];
      for (const check of checks) if (isObject(check) && typeof check.context === 'string') target.requiredStatusChecks.push(check.context);
      target.strictStatusChecks ||= parameters.strict_required_status_checks_policy === true;
    }
  }
}

function applyProtection(target, protection) {
  const reviews = isObject(protection.required_pull_request_reviews) ? protection.required_pull_request_reviews : null;
  if (reviews) {
    target.requiredApprovingReviewCount = Math.max(
      target.requiredApprovingReviewCount,
      Number.isInteger(reviews.required_approving_review_count) ? reviews.required_approving_review_count : 0
    );
    target.dismissStaleReviewsOnPush ||= reviews.dismiss_stale_reviews === true;
    target.requireCodeOwnerReview ||= reviews.require_code_owner_reviews === true;
    target.requireLastPushApproval ||= reviews.require_last_push_approval === true;
    target.ruleTypes.push('protection:required_pull_request_reviews');
  }
  const status = isObject(protection.required_status_checks) ? protection.required_status_checks : null;
  if (status) {
    for (const context of Array.isArray(status.contexts) ? status.contexts : []) {
      if (typeof context === 'string') target.requiredStatusChecks.push(context);
    }
    for (const check of Array.isArray(status.checks) ? status.checks : []) {
      if (isObject(check) && typeof check.context === 'string') target.requiredStatusChecks.push(check.context);
    }
    target.strictStatusChecks ||= status.strict === true;
    target.ruleTypes.push('protection:required_status_checks');
  }
  if (isObject(protection.required_conversation_resolution) && protection.required_conversation_resolution.enabled === true) {
    target.requireThreadResolution = true;
    target.ruleTypes.push('protection:required_conversation_resolution');
  }
}

/**
 * Merges branch rulesets and classic branch protection into one set of requirements.
 *
 * Each source is a read result; `protection` data is the raw payload or null when the
 * branch is confirmed unprotected. When a source could not be read, the values are only a
 * lower bound: `complete` is false and `unavailable` names the missing sources.
 *
 * @param {{ rules: object, protection: object }} sources
 */
function mergeBranchRequirements({ rules, protection }) {
  const data = emptyRequirements();
  const unavailable = {};
  if (isSuccess(rules)) applyRuleset(data, rules.data);
  else unavailable.rules = rules.kind;
  if (isSuccess(protection)) {
    if (protection.data) applyProtection(data, protection.data);
  } else {
    unavailable.protection = protection.kind;
  }
  data.requiredStatusChecks = [...new Set(data.requiredStatusChecks)].sort();
  data.ruleTypes = [...new Set(data.ruleTypes)].sort();
  data.complete = Object.keys(unavailable).length === 0;
  data.unavailable = unavailable;
  return data;
}

module.exports = { mergeBranchRequirements, emptyRequirements };
