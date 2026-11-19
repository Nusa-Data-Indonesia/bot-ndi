'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, createConfigurationService } = require('../src/configuration');
const { loadEnv } = require('../src/config');

function modelConfigurationPool() {
  const calls = [];
  let row = {
    id: 1,
    version: 4,
    profile_id: 'profile-1',
    account_id: 'account-1',
    model: 'generator/model',
    reviewer_model: 'reviewer/model',
    status: 'ACTIVE',
    pending_profile_id: null,
    pending_account_id: null,
    pending_model: null,
    pending_reviewer_model: null,
  };
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql) => {
      if (sql.includes('SELECT settings_json,automation_enabled')) {
        return [[{ settings_json: JSON.stringify({ profileId: 'profile-1', targetAccountId: 'account-1' }), automation_enabled: 0 }]];
      }
      if (sql.includes('SELECT * FROM integration_config')) return [[{ ...row }]];
      return [[]];
    },
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE integration_config SET version=?,reviewer_model=?')) {
        row = { ...row, version: params[0], reviewer_model: params[1], updated_by: params[2] };
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  return { calls, pool: { getConnection: async () => connection, execute: connection.execute }, getRow: () => row };
}

test('effective configuration exposes both model roles while preserving the legacy generator alias', () => {
  const effective = snapshot({
    version: 4, profile_id: 'profile-1', account_id: 'account-1', model: 'generator/model',
    reviewer_model: 'reviewer/model', status: 'ACTIVE',
  });

  assert.equal(effective.generatorModel, 'generator/model');
  assert.equal(effective.reviewerModel, 'reviewer/model');
  assert.equal(effective.model, effective.generatorModel);
});

test('Reviewer model updates are versioned, audited, DB-authoritative and reject the Generator model', async () => {
  const { calls, pool, getRow } = modelConfigurationPool();
  const service = createConfigurationService({ pool, config: { openRouter: {} } });

  const changed = await service.setReviewerModel({ model: 'reviewer/next', expectedVersion: 4, actorId: 12 });
  assert.equal(changed.version, 5);
  assert.equal(changed.generatorModel, 'generator/model');
  assert.equal(changed.reviewerModel, 'reviewer/next');
  assert.equal(getRow().reviewer_model, 'reviewer/next');
  assert.ok(calls.some(({ sql, params }) => sql.startsWith('INSERT INTO integration_config_history')
    && params.includes('reviewer/next')));
  assert.ok(calls.some(({ sql, params }) => sql.startsWith('INSERT INTO audit_logs')
    && params[1] === 'integration.reviewer_model_updated'));

  await assert.rejects(service.setReviewerModel({ model: 'generator/model', expectedVersion: 5 }),
    (error) => error.code === 'MODEL_IDS_MUST_DIFFER');
  await assert.rejects(service.setReviewerModel({ model: 'reviewer/next', expectedVersion: 4 }),
    (error) => error.code === 'CONFIG_CONFLICT');
});

test('optional reviewer model environment value is available only for initial configuration bootstrap', () => {
  const config = loadEnv({
    NODE_ENV: 'test', PORT: '3000', BASE_URL: 'http://localhost:3000',
    OPENROUTER_REVIEWER_MODEL: 'reviewer/model',
  }, { requireDatabase: false });

  assert.equal(config.openRouter.reviewerModel, 'reviewer/model');
});
