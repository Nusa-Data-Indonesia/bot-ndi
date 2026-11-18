'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

function overrideModule(request, overrides) {
  const filename = require.resolve(request);
  if (!require.cache[filename]) require(filename);
  const moduleRecord = require.cache[filename];
  const originalExports = moduleRecord.exports;
  moduleRecord.exports = { ...originalExports, ...overrides };
  return () => { moduleRecord.exports = originalExports; };
}

test('CLI startup and manual dispatch stay inert with populated credentials until external activation', async (t) => {
  const config = {
    nodeEnv: 'test', port: 0, baseUrl: 'http://127.0.0.1', timezone: 'Asia/Jakarta', approvedCtaHosts: [],
    externalIntegrationsEnabled: false, schedulerEnabled: false, schedulerIntervalSeconds: 60,
    tebar: { apiKey: 'mock-tebar-key', profileId: 'mock-profile', accountId: 'mock-account', webhookSecret: 'mock-webhook-secret' },
    openRouter: { apiKey: 'mock-openrouter-key', model: 'mock/model', generatorSampling: {} },
    telegram: { botToken: '123456:mock-telegram-token', chatId: 'mock-chat' },
    learningCaptureEnabled: false, learningActivationEnabled: false, learningRetrievalEnabled: false,
    learningPromptIntegrationEnabled: false, learningShadowEnabled: false, learningRetentionEnabled: false,
  };
  const observed = { providerRequests: 0, dispatches: 0, schedulerCreations: 0, notifierCreations: 0, poolEnds: 0 };
  const pool = { end: async () => { observed.poolEnds++; }, execute: async () => [[]] };
  const repository = {
    setAutomationEnabled: async () => ({ changed: false }),
    claimCategoryProposalRun: async () => { throw new Error('disabled category proposal job must not run during startup'); },
    finishCategoryProposalRun: async () => { throw new Error('disabled category proposal job must not run during startup'); },
  };
  const configuration = {
    bootstrap: async () => {},
    getActive: async () => ({ status: 'ACTIVE', profileId: config.tebar.profileId, accountId: config.tebar.accountId, model: config.openRouter.model }),
  };
  const restoreModules = [
    overrideModule('../src/config', { loadEnv: () => config }),
    overrideModule('../src/db', { createPool: () => pool, endOptionalPoolBounded: async () => {} }),
    overrideModule('../src/migrate', { runMigrations: async () => [] }),
    overrideModule('../src/repository', { createRepository: () => repository }),
    overrideModule('../src/auth', { createAuth: () => ({}) }),
    overrideModule('../src/server', { createServer: ({ services }) => {
      observed.services = services;
      return { listen: (_port, callback) => { callback(); return { close() {} }; } };
    } }),
    overrideModule('../src/dispatcher', {
      runDispatcher: async () => { observed.dispatches++; },
      pauseAutomation: async () => {}, reconcileUnsettled: async () => {}, reconcileSwitch: async () => {},
    }),
    overrideModule('../src/content-service', { generatePost: async () => 'mock caption' }),
    overrideModule('../src/logger', { createLogger: () => ({ info() {}, error() {} }) }),
    overrideModule('../src/notifications', { createOutboxNotifier: () => { observed.notifierCreations++; return { enqueue: async () => {}, flush: async () => {} }; } }),
    overrideModule('../src/insights', { getClickMetric: async () => { observed.providerRequests++; return {}; } }),
    overrideModule('../src/scheduler', { createScheduler: () => { observed.schedulerCreations++; return { runNow() {}, start() {}, stop() {}, status: () => ({ enabled: true }) }; } }),
    overrideModule('../src/configuration', { createConfigurationService: () => configuration }),
    overrideModule('../src/generation-attempts', { createGenerationAttemptStore: () => ({}) }),
    overrideModule('../src/learning', { createLearningStore: () => ({}) }),
  ];
  const cliPath = require.resolve('../src/cli');
  delete require.cache[cliPath];
  const { main } = require('../src/cli');
  const originalAxiosRequest = axios.request;
  axios.request = async () => { observed.providerRequests++; throw new Error('mock external request'); };
  const originalStdoutWrite = process.stdout.write;
  const stdout = [];
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  const signalListeners = new Map(['SIGTERM', 'SIGINT'].map((signal) => [signal, new Set(process.listeners(signal))]));

  try {
    await main(['server']);
    assert.equal(observed.services.externalIntegrationsEnabled, false);
    assert.equal(observed.services.aiConfigured, false);
    assert.equal(observed.services.schedulerStatus().enabled, false);
    assert.equal(observed.services.notify, undefined);
    assert.equal(observed.services.flushNotifications, undefined);
    assert.deepEqual(await observed.services.getProviderStatus(), { connected: false, status: 'EXTERNAL_INTEGRATIONS_DISABLED' });
    assert.deepEqual(await observed.services.getClickMetric({ settings: {} }), { available: false, value: null, reason: 'provider_unavailable' });
    await assert.rejects(observed.services.configurationValidators.validateAccount({ profileId: 'mock-profile', accountId: 'mock-account' }), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });

    await main(['dispatch']);
    assert.match(stdout.join(''), /external_integrations_disabled/);
    assert.equal(observed.dispatches, 0);
    assert.equal(observed.schedulerCreations, 0);
    assert.equal(observed.notifierCreations, 0);
    assert.equal(observed.providerRequests, 0);
  } finally {
    process.stdout.write = originalStdoutWrite;
    axios.request = originalAxiosRequest;
    for (const [signal, before] of signalListeners) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
    delete require.cache[cliPath];
    for (const restore of restoreModules.reverse()) restore();
  }
});
