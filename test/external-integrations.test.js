'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEnv } = require('../src/config');
const { canStartPublisherScheduler } = require('../src/external-integrations');
const { createTebarClient } = require('../src/providers/tebar');
const { createOpenRouterClient } = require('../src/providers/openrouter');
const { createTelegramClient } = require('../src/providers/telegram');
const { createConfigurationValidators } = require('../src/configuration-providers');

const database = { DB_HOST: 'localhost', DB_USER: 'test', DB_PASSWORD: 'test-only', DB_NAME: 'bot_ndi_test' };
const credentials = {
  TEBAR_API_KEY: 'test-tebar-key', TEBAR_PROFILE_ID: 'test-profile', TEBAR_ACCOUNT_ID: 'test-account',
  TEBAR_WEBHOOK_SECRET: 'test-webhook-secret', OPENROUTER_API_KEY: 'test-openrouter-key',
  OPENROUTER_MODEL: 'vendor/test-model', TELEGRAM_BOT_TOKEN: '123456:test-telegram-token', TELEGRAM_CHAT_ID: '123456',
};

test('preconfigured credentials make no provider calls or background scheduler while external activity is disabled', async () => {
  const config = loadEnv({ ...database, ...credentials, SCHEDULER_ENABLED: 'false' });
  assert.equal(config.externalIntegrationsEnabled, false);
  assert.equal(canStartPublisherScheduler(config), false);

  let requests = 0;
  const http = { request: async () => { requests++; throw new Error('mock should remain unused'); } };
  const tebar = createTebarClient({ apiKey: config.tebar.apiKey, profileId: config.tebar.profileId, enabled: config.externalIntegrationsEnabled, http });
  const openrouter = createOpenRouterClient({ apiKey: config.openRouter.apiKey, model: config.openRouter.model, enabled: config.externalIntegrationsEnabled, http });
  const telegram = createTelegramClient({ ...config.telegram, enabled: config.externalIntegrationsEnabled, http });
  const validators = createConfigurationValidators({ config, enabled: config.externalIntegrationsEnabled, http });

  await assert.rejects(tebar.publishNow({ content: 'mock post', targets: [{ account_id: config.tebar.accountId }] }, 'mock-key'), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  await assert.rejects(openrouter.generate({ system: 'mock', user: 'mock prompt' }), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  await assert.rejects(telegram.send('mock notification'), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  await assert.rejects(validators.validateAccount({ profileId: config.tebar.profileId, accountId: config.tebar.accountId }), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  await assert.rejects(validators.listModels(), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  await assert.rejects(validators.validateModel(config.openRouter.model), { code: 'EXTERNAL_INTEGRATIONS_DISABLED' });
  assert.equal(requests, 0);
});

test('explicit post-deployment activation enables only mocked provider calls and publishing still needs the scheduler flag', async () => {
  const credentialsOnly = loadEnv({ ...database, ...credentials, SCHEDULER_ENABLED: 'false' });
  assert.equal(canStartPublisherScheduler({ ...credentialsOnly, externalIntegrationsEnabled: true }), false);

  const config = loadEnv({ ...database, ...credentials, EXTERNAL_INTEGRATIONS_ENABLED: 'true', SCHEDULER_ENABLED: 'true' });
  assert.equal(canStartPublisherScheduler(config), true);
  const calls = [];
  const http = { request: async (request) => {
    calls.push(request);
    if (request.url === 'https://api.tebar.app/v1/posts') {
      return { data: { id: 'mock-post', status: 'published', targets: [{ id: 'mock-target', account_id: 'test-account', platform: 'threads', status: 'published' }] } };
    }
    if (request.url === 'https://openrouter.ai/api/v1/chat/completions') {
      return { data: { choices: [{ message: { content: 'mock caption' } }] } };
    }
    if (request.url.includes('api.telegram.org')) return { data: { ok: true, result: { message_id: 1 } } };
    throw new Error('unexpected mock request');
  } };
  const tebar = createTebarClient({ apiKey: config.tebar.apiKey, profileId: config.tebar.profileId, enabled: config.externalIntegrationsEnabled, http });
  const openrouter = createOpenRouterClient({ apiKey: config.openRouter.apiKey, model: config.openRouter.model, enabled: config.externalIntegrationsEnabled, http });
  const telegram = createTelegramClient({ ...config.telegram, enabled: config.externalIntegrationsEnabled, http });

  assert.equal((await tebar.publishNow({ content: 'mock caption', targets: [{ account_id: config.tebar.accountId }] }, 'mock-key')).id, 'mock-post');
  assert.equal(await openrouter.generate({ system: 'mock', user: 'mock prompt' }), 'mock caption');
  assert.deepEqual(await telegram.send('mock notification'), { messageId: 1 });
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'POST', 'POST']);
  assert.ok(calls.every((call) => call.url.startsWith('https://') && call.timeout > 0));
});
