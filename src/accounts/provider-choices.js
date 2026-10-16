'use strict';

const { builtIn } = require('../providers/registry');
const { PROVIDERS: profileProviders } = require('./profile');

// A provider can launch a terminal without having a safe, separate account profile.
// Keep the picker tied to the registry, while profile creation uses the actual profile support.
function accountProviderChoices() {
  return builtIn.list().map((provider) => {
    const canCreateProfile = Object.hasOwn(profileProviders, provider.id);
    const { accountIsolation, identityVerification, usageObservation } = provider.capabilities;
    return {
      id: provider.id,
      label: provider.label,
      description: canCreateProfile ? 'Account profile available' : 'Separate account profile unavailable',
      detail: `Account isolation: ${accountIsolation}; identity verification: ${identityVerification}; quota/usage: ${usageObservation}.${canCreateProfile ? '' : ' Use the provider’s default CLI sign-in; no separate account will be created.'}`,
      canCreateProfile
    };
  });
}

module.exports = { accountProviderChoices };
