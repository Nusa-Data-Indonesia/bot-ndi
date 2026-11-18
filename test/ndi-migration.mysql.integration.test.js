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

test('021–023 upgrade legacy state additively, seed strategy once, and keep posting gated until explicit admin review', { skip: !enabled }, async () => {
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

    await fs.copyFile(path.join(sourceDir, '022_content_strategy.sql'), path.join(migrationDir, '022_content_strategy.sql'));
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), ['022_content_strategy.sql']);
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), [], 'migration runner must record 022 once');

    await fs.copyFile(path.join(sourceDir, '023_manual_website_knowledge_sync.sql'), path.join(migrationDir, '023_manual_website_knowledge_sync.sql'));
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), ['023_manual_website_knowledge_sync.sql']);
    assert.deepEqual(await runMigrations(pool, { migrationsDir: migrationDir }), [], 'migration runner must record 023 once');
    const [[initialKnowledgeVersion]] = await pool.execute('SELECT business_knowledge_version FROM settings WHERE id=1');
    assert.equal(Number(initialKnowledgeVersion.business_knowledge_version), 1, 'existing approved knowledge gets a stable initial version');

    const migrationSql = await fs.readFile(path.join(sourceDir, '021_ndi_business_knowledge.sql'), 'utf8');
    for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);

    const [[defaultCategory]] = await pool.execute("SELECT id,guidance,active FROM content_categories WHERE slug='edukasi-data-teknologi'");
    assert.ok(defaultCategory);
    await pool.execute('UPDATE content_categories SET guidance=?,active=TRUE WHERE id=?', ['Admin edit must survive migration replay.', defaultCategory.id]);
    const migration022Sql = await fs.readFile(path.join(sourceDir, '022_content_strategy.sql'), 'utf8');
    const migrationConnection = await pool.getConnection();
    try {
      for (const statement of migration022Sql.split(';').map((part) => part.trim()).filter(Boolean)) await migrationConnection.query(statement);
    } finally { migrationConnection.release(); }
    const [[retainedCategory]] = await pool.execute('SELECT guidance,active FROM content_categories WHERE id=?', [defaultCategory.id]);
    assert.equal(retainedCategory.guidance, 'Admin edit must survive migration replay.');
    assert.equal(Boolean(retainedCategory.active), true);
    const [[categoryCount]] = await pool.execute('SELECT COUNT(*) AS count FROM content_categories');
    const [[styleCount]] = await pool.execute('SELECT COUNT(*) AS count FROM content_styles');
    const [[strategySetting]] = await pool.execute('SELECT enabled FROM content_strategy_settings WHERE id=1');
    const [[proposalSetting]] = await pool.execute('SELECT enabled,interval_days FROM category_proposal_settings WHERE id=1');
    assert.equal(Number(categoryCount.count), 8, 'the migration seeds the exact eight SSOT categories');
    assert.equal(Number(styleCount.count), 7, 'the migration seeds the exact seven SSOT styles');
    assert.equal(Boolean(strategySetting.enabled), false, 'strategy approval stays off after migration');
    assert.equal(Boolean(proposalSetting.enabled), false, 'AI proposal scheduler is disabled by default');
    assert.equal(Number(proposalSetting.interval_days), 30);

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
    assert.equal(state.contentStrategyReady, false, 'posting must stay closed until an admin explicitly reviews strategy');
    assert.equal(state.contentStrategyReasonCode, 'CONTENT_STRATEGY_REVIEW_REQUIRED');
    assert.equal(state.automationEnabled, true);
    assert.deepEqual(state.facts, [], 'active runtime must not expose product facts as NDI knowledge');
    const promptContext = buildContentContext(state, state.settings);
    assert.doesNotMatch(JSON.stringify(promptContext), /RAHASIA-|Kedai\s*Merzz|Mobile Legends|top-up/iu);
    assert.equal(promptContext.pillar, 'ndi');

    await assert.rejects(repository.setContentStrategyEnabled(true, adminId), (error) => error.code === 'AUTOMATION_MUST_BE_PAUSED');
    await pool.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1');
    await repository.saveKnowledge(state.businessKnowledge, adminId);
    assert.deepEqual(await repository.setContentStrategyEnabled(true, adminId), { enabled: true });
    const reviewedState = await repository.getRuntimeState();
    assert.equal(reviewedState.contentStrategyReady, true);
    assert.equal(reviewedState.automationEnabled, false, 'reviewing strategy never enables posting');

    const customCategory = await repository.saveContentStrategyRecord('category', null, {
      name: 'Kategori Integration', guidance: 'Panduan kategori untuk verifikasi CRUD.', active: true,
    }, adminId);
    assert.ok(customCategory.id);
    await repository.setContentStrategyRecordActive('category', customCategory.id, false, adminId);
    await repository.archiveContentStrategyRecord('category', customCategory.id, adminId);
    const archived = (await repository.getContentStrategyState()).categories.find((item) => item.id === customCategory.id);
    assert.equal(archived.active, false);
    assert.ok(archived.archivedAt);

    const knowledgeBeforeProposal = (await repository.getSettings()).businessKnowledge;
    await repository.saveCategoryProposalSettings({ enabled: true, intervalDays: 30 }, adminId);
    await pool.execute('UPDATE category_proposal_settings SET next_run_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE id=1');
    const proposalRun = await repository.claimCategoryProposalRun({ now: new Date() });
    assert.equal(proposalRun.model, 'test-model-only');
    assert.equal(await repository.finishCategoryProposalRun({ token: proposalRun.token, proposals: [{
      name: 'Tinjauan Informasi', guidance: 'Usulan tema untuk percakapan umum tentang informasi yang tertata.',
    }] }), true);
    const proposal = (await repository.getContentStrategyState()).proposals.find((item) => item.name === 'Tinjauan Informasi');
    assert.equal(proposal.status, 'pending');
    assert.deepEqual((await repository.getSettings()).businessKnowledge, knowledgeBeforeProposal, 'AI proposals must not mutate official business knowledge');
    await repository.reviewCategoryProposal(proposal.id, 'approve', adminId);
    assert.ok((await repository.getContentStrategyState()).categories.some((item) => item.name === 'Tinjauan Informasi' && item.active));

    const [[categoryA]] = await pool.execute("SELECT id FROM content_categories WHERE slug='edukasi-data-teknologi'");
    const [[categoryB]] = await pool.execute("SELECT id FROM content_categories WHERE slug='engagement'");
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,content_category_id,provider_published_at) VALUES (?,?,'published',?,?)", [randomUUID(), new Date('2026-11-18T00:01:00.000Z'), categoryA.id, new Date('2026-11-18T08:00:00.000Z')]);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,content_category_id,provider_published_at) VALUES (?,?,'published',?,?)", [randomUUID(), new Date('2026-11-18T00:02:00.000Z'), categoryB.id, new Date('2026-11-18T10:00:00.000Z')]);
    const orderedState = await repository.getRuntimeState();
    assert.equal(orderedState.contentStrategy.latestCategoryId, String(categoryB.id), 'provider publication time wins over slot insertion order');
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,content_category_id,provider_published_at) VALUES (?,?,'unknown',?,NULL)", [randomUUID(), new Date('2026-11-18T00:03:00.000Z'), categoryA.id]);
    assert.equal((await repository.getRuntimeState()).contentStrategy.orderUncertain, false, 'unknown outcomes do not count as successful publications');
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,content_category_id,provider_published_at) VALUES (?,?,'published',?,?)", [randomUUID(), new Date('2026-11-18T00:04:00.000Z'), categoryA.id, new Date('2026-11-18T10:00:00.000Z')]);
    assert.equal((await repository.getRuntimeState()).contentStrategy.orderUncertain, true, 'timestamp ties across categories block further rotation');

    const webRun = await repository.startWebsiteSyncRun(adminId);
    assert.equal(webRun.knowledgeVersion, 2, 'manual approval of existing knowledge incremented its version');
    const webFetchedAt = new Date('2026-11-18T12:00:00.000Z');
    await repository.completeWebsiteSyncRun({
      id: webRun.id, knowledgeVersion: webRun.knowledgeVersion, sourceUrl: 'https://nusadataindonesia.com/',
      sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, completedAt: webFetchedAt,
      proposals: [
        { operation: 'add', targetValue: 'Integrasi API', baseValue: null, sourceUrl: 'https://nusadataindonesia.com/', sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, knowledgeVersion: webRun.knowledgeVersion },
        { operation: 'add', targetValue: 'Dashboard BI', baseValue: null, sourceUrl: 'https://nusadataindonesia.com/', sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, knowledgeVersion: webRun.knowledgeVersion },
        { operation: 'remove', targetValue: 'Pengembangan perangkat lunak kustom', baseValue: 'Pengembangan perangkat lunak kustom', sourceUrl: 'https://nusadataindonesia.com/', sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, knowledgeVersion: webRun.knowledgeVersion },
      ],
    });
    let websiteState = await repository.getWebsiteSyncState();
    const pendingWebsiteProposals = websiteState.proposals.filter((item) => item.syncRunId === webRun.id);
    assert.equal(pendingWebsiteProposals.length, 3);
    assert.ok(pendingWebsiteProposals.every((item) => item.status === 'pending' && item.sourceUrl === 'https://nusadataindonesia.com/'));
    const beforeWebsiteReview = await repository.getSettings();
    await repository.reviewWebsiteKnowledgeProposal(pendingWebsiteProposals.find((item) => item.targetValue === 'Dashboard BI').id, 'reject', adminId);
    assert.deepEqual((await repository.getSettings()).businessKnowledge, beforeWebsiteReview.businessKnowledge, 'rejecting one proposal changes no authoritative knowledge');
    const addProposal = pendingWebsiteProposals.find((item) => item.targetValue === 'Integrasi API');
    const removeProposal = pendingWebsiteProposals.find((item) => item.operation === 'remove');
    await repository.reviewWebsiteKnowledgeProposal(addProposal.id, 'approve', adminId);
    let websiteKnowledge = await repository.getSettings();
    assert.ok(websiteKnowledge.businessKnowledge.services.includes('Integrasi API'));
    assert.equal(websiteKnowledge.businessKnowledgeVersion, 3);
    await repository.reviewWebsiteKnowledgeProposal(removeProposal.id, 'approve', adminId);
    websiteKnowledge = await repository.getSettings();
    assert.ok(!websiteKnowledge.businessKnowledge.services.includes('Pengembangan perangkat lunak kustom'));
    assert.equal(websiteKnowledge.businessKnowledgeVersion, 4);

    const staleRun = await repository.startWebsiteSyncRun(adminId);
    await repository.completeWebsiteSyncRun({
      id: staleRun.id, knowledgeVersion: staleRun.knowledgeVersion, sourceUrl: 'https://nusadataindonesia.com/',
      sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, completedAt: webFetchedAt,
      proposals: [{ operation: 'remove', targetValue: 'Dashboard', baseValue: 'Dashboard', sourceUrl: 'https://nusadataindonesia.com/', sourceTitle: 'Nusa Data Indonesia', fetchedAt: webFetchedAt, knowledgeVersion: staleRun.knowledgeVersion }],
    });
    const staleProposal = (await repository.getWebsiteSyncState()).proposals.find((item) => item.syncRunId === staleRun.id);
    const manuallyEditedKnowledge = { ...websiteKnowledge.businessKnowledge, services: websiteKnowledge.businessKnowledge.services.filter((service) => service !== 'Dashboard') };
    await repository.saveKnowledge(manuallyEditedKnowledge, adminId);
    const beforeConflictReview = await repository.getSettings();
    const staleReview = await repository.reviewWebsiteKnowledgeProposal(staleProposal.id, 'approve', adminId);
    assert.equal(staleReview.status, 'conflict', 'manual edits after sync produce a conflict instead of overwrite');
    assert.deepEqual((await repository.getSettings()).businessKnowledge, beforeConflictReview.businessKnowledge);
    assert.ok((await repository.getWebsiteSyncState()).proposals.find((item) => item.id === staleProposal.id).status === 'conflict');

    const failedRun = await repository.startWebsiteSyncRun(adminId);
    const beforeFailedFetch = await repository.getSettings();
    await repository.failWebsiteSyncRun({ id: failedRun.id, errorCode: 'WEBSITE_SYNC_TIMEOUT', failedAt: webFetchedAt });
    const afterFailedFetch = await repository.getSettings();
    assert.deepEqual(afterFailedFetch.businessKnowledge, beforeFailedFetch.businessKnowledge, 'fetch failure leaves approved knowledge untouched');
    assert.equal(afterFailedFetch.businessKnowledgeVersion, beforeFailedFetch.businessKnowledgeVersion);
    assert.equal(afterFailedFetch.automationEnabled, beforeFailedFetch.automationEnabled, 'website failure does not affect posting controls');
    const failedRecord = (await repository.getWebsiteSyncState()).runs.find((item) => item.id === failedRun.id);
    assert.equal(failedRecord.status, 'failed');
    assert.equal(failedRecord.errorCode, 'WEBSITE_SYNC_TIMEOUT');
    const [websiteAudit] = await pool.execute(`SELECT action,admin_id,details_json FROM audit_logs
      WHERE action LIKE 'ndi_website_sync.%' ORDER BY id`);
    const websiteAuditActions = websiteAudit.map((item) => item.action);
    for (const action of [
      'ndi_website_sync.requested', 'ndi_website_sync.completed', 'ndi_website_sync.failed',
      'ndi_website_sync.proposal.approved', 'ndi_website_sync.proposal.rejected', 'ndi_website_sync.proposal.conflict',
    ]) assert.ok(websiteAuditActions.includes(action), `audit records ${action}`);
    assert.ok(websiteAudit.every((item) => Number(item.admin_id) === adminId), 'sync and review audit entries retain the admin actor');
    assert.ok(websiteAudit.some((item) => json(item.details_json).sourceUrl === 'https://nusadataindonesia.com/'), 'audit retains official-site provenance');
  } finally {
    await pool.end();
    await fs.rm(migrationDir, { recursive: true, force: true });
  }
});
