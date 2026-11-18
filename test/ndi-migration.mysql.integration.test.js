'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const enabled = process.env.NODE_ENV === 'test'
  && process.env.DB_NAME === 'bot_ndi_test_ndi_upgrade'
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

test('021 upgrades representative legacy NDI state without deleting data or changing uncertain publication state', { skip: !enabled }, async () => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const { buildContentContext } = require('../src/content-context');
  const pool = createPool(loadEnv());
  const migrationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-ndi-ndi-upgrade-'));
  const sourceDir = path.resolve(__dirname, '../migrations');
  try {
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=DATABASE()');
    assert.equal(Number(count), 0, 'upgrade test requires a fresh, dedicated disposable schema');
    const priorMigrations = (await fs.readdir(sourceDir)).filter((file) => /^\d+_[a-zA-Z0-9_-]+\.sql$/.test(file) && file < '021_');
    await Promise.all(priorMigrations.map((file) => fs.copyFile(path.join(sourceDir, file), path.join(migrationDir, file))));
    assert.equal((await runMigrations(pool, { migrationsDir: migrationDir })).length, 20);

    const sessionId = randomUUID();
    const oldSettings = {
      schedule: { intervalHours: 1, timezone: 'Asia/Jakarta' },
      brand: { name: 'Kedai Merzz', voice: 'gamer santai' },
      gameWhitelist: ['Mobile Legends'], priceMode: 'static',
      trackedLinks: { topup: 'https://merzz.example.test/topup', account: 'https://merzz.example.test/account' },
      hashtags: ['#KedaiMerzz'], onboardingComplete: true,
      automationSessionId: sessionId, targetAccountId: 'test-account-ndi-upgrade', profileId: 'test-profile-ndi-upgrade',
      nextSlotAt: '2026-11-20T00:00:00.000Z',
    };
    const oldKnowledge = { brand: oldSettings.brand, guardrails: { forbiddenClaims: ['harga pasti'] }, note: 'RAHASIA-LEGACY-KNOWLEDGE' };
    await pool.execute('UPDATE settings SET settings_json=?,knowledge_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify(oldSettings), JSON.stringify(oldKnowledge)]);
    const [adminResult] = await pool.execute('INSERT INTO admins (email,password_hash,active) VALUES (?,?,TRUE)', ['ndi-upgrade@example.test', 'fake-test-only-hash']);
    const adminId = adminResult.insertId;
    const tokenHash = createHash('sha256').update('ndi-upgrade-test-session').digest('hex');
    await pool.execute('INSERT INTO sessions (token_hash,admin_id,csrf_token,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [tokenHash, adminId, 'c'.repeat(64)]);
    await pool.execute('INSERT INTO audit_logs (admin_id,action,details_json) VALUES (?,?,?)', [adminId, 'ndi_upgrade_fixture', JSON.stringify({ retained: true })]);
    await pool.execute('INSERT INTO service_facts (service,summary_json,active) VALUES (?,?,TRUE),(?,?,TRUE)', [
      'topup', JSON.stringify({ game: 'Mobile Legends', price: 'RAHASIA-LEGACY-PRICE' }),
      'account', JSON.stringify({ game: 'RAHASIA-LEGACY-GAME', attributes: ['RAHASIA-LEGACY-ACCOUNT'] }),
    ]);
    await pool.execute('INSERT INTO templates (id,name,category,data_json,created_by) VALUES (?,?,?, ?,?)', [randomUUID(), 'Legacy template', 'topup', JSON.stringify({ game: 'Mobile Legends' }), adminId]);
    await pool.execute('INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,7,?,?,? ,\'ACTIVE\')', ['test-profile-ndi-upgrade', 'test-account-ndi-upgrade', 'test-model-only']);

    const slotFixtures = [
      { id: randomUUID(), status: 'pending', pillar: 'topup', providerStatus: null, postId: null, caption: null },
      { id: randomUUID(), status: 'ready', pillar: 'topup', providerStatus: null, postId: null, caption: 'RAHASIA-LEGACY-READY-CAPTION' },
      { id: randomUUID(), status: 'publishing', pillar: 'topup', providerStatus: 'scheduled', postId: 'legacy-provider-publishing' , caption: 'RAHASIA-LEGACY-PUBLISHING-CAPTION' },
      { id: randomUUID(), status: 'unknown', pillar: 'topup', providerStatus: 'unknown', postId: 'legacy-provider-unknown', caption: 'RAHASIA-LEGACY-UNKNOWN-CAPTION' },
      { id: randomUUID(), status: 'published', pillar: 'topup', providerStatus: 'published', postId: 'legacy-provider-published', caption: 'RAHASIA-LEGACY-PUBLISHED-CAPTION' },
    ];
    for (const [index, slot] of slotFixtures.entries()) {
      const payload = slot.status === 'ready' || slot.status === 'publishing' || slot.status === 'unknown'
        ? JSON.stringify({ content: `${slot.caption}\nhttps://merzz.example.test/topup`, targets: [{ account_id: oldSettings.targetAccountId }] }) : null;
      await pool.execute(
        'INSERT INTO slots (id,automation_session_id,scheduled_at,status,pillar,provider_status,provider_post_id,caption,request_payload,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [slot.id, sessionId, new Date(Date.now() + index * 60_000), slot.status, slot.pillar, slot.providerStatus, slot.postId, slot.caption, payload, oldSettings.profileId, oldSettings.targetAccountId, 7],
      );
    }

    await fs.copyFile(path.join(sourceDir, '021_ndi_business_knowledge.sql'), path.join(migrationDir, '021_ndi_business_knowledge.sql'));
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), ['021_ndi_business_knowledge.sql']);
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), [], 'migration runner must record 021 once');

    const migrationSql = await fs.readFile(path.join(sourceDir, '021_ndi_business_knowledge.sql'), 'utf8');
    for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);

    const [[settingsRow]] = await pool.execute('SELECT settings_json,knowledge_json,business_knowledge_json,business_knowledge_approved,legacy_business_settings_json,legacy_business_knowledge_json,automation_enabled FROM settings WHERE id=1');
    const currentSettings = json(settingsRow.settings_json);
    assert.equal(Boolean(settingsRow.automation_enabled), true, 'migration must not rewrite the existing automation flag');
    assert.equal(settingsRow.business_knowledge_approved, 0, 'legacy knowledge must not become implicitly approved');
    assert.equal(currentSettings.onboardingComplete, false, 'old onboarding must be reviewed against NDI facts');
    assert.equal(currentSettings.schedule.intervalHours, 1);
    assert.equal(currentSettings.automationSessionId, sessionId);
    assert.equal(currentSettings.targetAccountId, oldSettings.targetAccountId);
    assert.equal(currentSettings.profileId, oldSettings.profileId);
    assert.equal(currentSettings.nextSlotAt, oldSettings.nextSlotAt);
    assert.deepEqual(currentSettings.hashtags, []);
    for (const key of ['brand', 'gameWhitelist', 'priceMode', 'trackedLinks']) assert.equal(Object.hasOwn(currentSettings, key), false, `old active field ${key} must leave runtime settings`);
    assert.equal(json(settingsRow.business_knowledge_json).companyName, 'Nusa Data Indonesia');
    assert.equal(json(settingsRow.legacy_business_settings_json).brand.name, 'Kedai Merzz');
    assert.equal(json(settingsRow.legacy_business_knowledge_json).note, 'RAHASIA-LEGACY-KNOWLEDGE');
    assert.deepEqual(json(settingsRow.knowledge_json), {});

    const [facts] = await pool.execute('SELECT service,summary_json,active FROM service_facts ORDER BY service');
    assert.equal(facts.length, 2);
    assert.ok(facts.every((fact) => Boolean(fact.active)), 'legacy fact state must remain available for rollback');
    assert.equal(json(facts.find((fact) => fact.service === 'topup').summary_json).price, 'RAHASIA-LEGACY-PRICE');
    const [[templateCount]] = await pool.execute('SELECT COUNT(*) AS count FROM templates');
    assert.equal(Number(templateCount.count), 1);
    const [[adminCount]] = await pool.execute('SELECT COUNT(*) AS count FROM admins WHERE id=?', [adminId]);
    const [[sessionCount]] = await pool.execute('SELECT COUNT(*) AS count FROM sessions WHERE token_hash=?', [tokenHash]);
    const [[auditCount]] = await pool.execute('SELECT COUNT(*) AS count FROM audit_logs WHERE admin_id=? AND action=?', [adminId, 'ndi_upgrade_fixture']);
    assert.equal(Number(adminCount.count), 1);
    assert.equal(Number(sessionCount.count), 1);
    assert.equal(Number(auditCount.count), 1);
    const [[integration]] = await pool.execute('SELECT version,profile_id,account_id,model,status FROM integration_config WHERE id=1');
    assert.equal(Number(integration.version), 7);
    assert.equal(integration.profile_id, oldSettings.profileId);
    assert.equal(integration.account_id, oldSettings.targetAccountId);
    assert.equal(integration.model, 'test-model-only');
    assert.equal(integration.status, 'ACTIVE');

    const [slots] = await pool.execute('SELECT id,status,pillar,provider_status,provider_post_id,caption,request_payload,cta_url FROM slots ORDER BY scheduled_at');
    assert.equal(slots.length, slotFixtures.length);
    for (const fixture of slotFixtures) {
      const row = slots.find((slot) => slot.id === fixture.id);
      assert.equal(row.status, fixture.status, `${fixture.status} slot status must remain unchanged`);
      assert.equal(row.pillar, fixture.pillar);
      assert.equal(row.provider_status, fixture.providerStatus);
      assert.equal(row.provider_post_id, fixture.postId);
      assert.equal(row.caption, fixture.caption);
      assert.equal(row.cta_url, null, 'existing slots have no NDI CTA snapshot and must fail closed');
    }

    const repository = createRepository(pool);
    const state = await repository.getRuntimeState();
    assert.equal(state.businessKnowledge.companyName, 'Nusa Data Indonesia');
    assert.equal(state.businessKnowledgeApproved, false);
    assert.equal(state.contentStrategyReady, false, 'publishing must remain closed until the Phase B engine exists');
    assert.match(state.contentStrategyReason, /Fase B/u);
    assert.equal(state.automationEnabled, true);
    assert.deepEqual(state.facts, [], 'active runtime must not expose product facts as NDI knowledge');
    const promptContext = buildContentContext(state, state.settings);
    assert.doesNotMatch(JSON.stringify(promptContext), /RAHASIA-|Kedai\s*Merzz|Mobile Legends|top-up/iu);
    assert.equal(promptContext.pillar, 'ndi');
  } finally {
    await pool.end();
    await fs.rm(migrationDir, { recursive: true, force: true });
  }
});
