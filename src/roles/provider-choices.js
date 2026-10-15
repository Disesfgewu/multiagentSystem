'use strict';

const { builtIn } = require('../providers/registry');
const { injectionStatus } = require('./injection-status');

const STATUS = Object.freeze({
  verified: '已驗證',
  unverified: '未驗證',
  unsupported: '不支援',
  unknown: '未知'
});
const INJECTION = Object.freeze({
  'sent-to-cli': '已送入 CLI（有證據）',
  'preview-only': '僅預覽，未注入',
  unsupported: '不支援／需手動'
});

/** Human-readable capabilities for the role group's provider picker. No workspace input is read. */
function roleProviderChoices(registry = builtIn) {
  return registry.list().map((provider) => {
    const capability = (name) => STATUS[registry.capability(provider.id, name)] ?? STATUS.unknown;
    const injection = injectionStatus({ provider: provider.id, registry }).state;
    return {
      id: provider.id,
      label: provider.label,
      detail: `帳號隔離：${capability('accountIsolation')} · 身份核實：${capability('identityVerification')} · 額度：${capability('usageObservation')} · 規則注入：${INJECTION[injection] ?? INJECTION.unsupported}`
    };
  });
}

module.exports = { roleProviderChoices };
