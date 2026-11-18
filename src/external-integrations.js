'use strict';

function externalIntegrationsDisabled() {
  return Object.assign(new Error('EXTERNAL_INTEGRATIONS_DISABLED'), {
    code: 'EXTERNAL_INTEGRATIONS_DISABLED',
    status: 503,
  });
}

function isExternalIntegrationsEnabled(config) {
  return config?.externalIntegrationsEnabled === true;
}

function assertExternalIntegrationsEnabled(enabled) {
  if (enabled !== true) throw externalIntegrationsDisabled();
}

function canStartPublisherScheduler(config) {
  return isExternalIntegrationsEnabled(config) && config?.schedulerEnabled === true;
}

module.exports = {
  externalIntegrationsDisabled,
  isExternalIntegrationsEnabled,
  assertExternalIntegrationsEnabled,
  canStartPublisherScheduler,
};
