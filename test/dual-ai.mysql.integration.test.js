'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const enabled = process.env.NODE_ENV === 'test'
  && process.env.DB_NAME === 'bot_ndi_test'
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

function encodeJson(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

test('MySQL keeps Dual AI models and approved knowledge immutable per slot and stores safe review history', { skip: !enabled }, async () => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const { createConfigurationService } = require('../src/configuration');
  const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');
  const { contentSafetyHash } = require('../src/content-safety');
  const pool = createPool(loadEnv());
  const slotId = randomUUID();
  let followupSlotId;
  const secondUnknownSlotId = randomUUID();
  const profileId = `dual-ai-profile-${randomUUID()}`;
  const accountId = `dual-ai-account-${randomUUID()}`;
  const sessionId = randomUUID();
  const actorEmail = `dual-ai-${randomUUID()}@example.test`;
  const configurationVersion = 1_000_000_000_000 + Date.now();
  let savedSettings;
  let savedIntegration;
  let savedStrategy;
  let actorId;

  try {
    await runMigrations(pool);
    [[savedSettings]] = await pool.query(`SELECT settings_json,business_knowledge_json,business_knowledge_approved,
      business_knowledge_version,automation_enabled FROM settings WHERE id=1`);
    [[savedIntegration]] = await pool.query('SELECT * FROM integration_config WHERE id=1');
    [[savedStrategy]] = await pool.query('SELECT enabled,enabled_by,enabled_at FROM content_strategy_settings WHERE id=1');
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [actorEmail, 'test-only-password-hash']);
    actorId = admin.insertId;

    const schedule = { intervalMinutes: 60, timezone: 'Asia/Jakarta' };
    const hashtags = ['#NusaDataIndonesia'];
    const knowledge = { ...DEFAULT_NDI_KNOWLEDGE, ctaUrl: 'https://dual-ai.example.test/ndi' };
    const settings = {
      schedule, hashtags, profileId, targetAccountId: accountId, automationSessionId: sessionId,
      onboardingComplete: true, nextSlotAt: new Date(Date.now() - 30_000).toISOString(),
    };

    await pool.execute('UPDATE settings SET settings_json=?,business_knowledge_json=?,business_knowledge_approved=TRUE,business_knowledge_version=40,automation_enabled=FALSE WHERE id=1',
      [JSON.stringify(settings), JSON.stringify(knowledge)]);
    await pool.execute('UPDATE content_strategy_settings SET enabled=TRUE,enabled_by=?,enabled_at=UTC_TIMESTAMP(3) WHERE id=1', [actorId]);
    await pool.execute(`INSERT INTO integration_config
      (id,version,profile_id,account_id,model,reviewer_model,status)
      VALUES (1,?,?,?,?,?,'ACTIVE')
      ON DUPLICATE KEY UPDATE version=VALUES(version),profile_id=VALUES(profile_id),account_id=VALUES(account_id),
        model=VALUES(model),reviewer_model=VALUES(reviewer_model),status='ACTIVE',pending_profile_id=NULL,
        pending_account_id=NULL,pending_model=NULL,pending_reviewer_model=NULL`,
    [configurationVersion, profileId, accountId, 'fixture/generator-v1', null]);

    const repository = createRepository(pool);
    const configuration = createConfigurationService({ pool, config: loadEnv() });
    await assert.rejects(repository.setAutomationEnabled(true, actorId), error => error.code === 'REVIEWER_MODEL_REQUIRED');
    await pool.execute('UPDATE integration_config SET reviewer_model=model WHERE id=1');
    await assert.rejects(repository.setAutomationEnabled(true, actorId), error => error.code === 'REVIEWER_MODEL_REQUIRED');
    const [[stillPaused]] = await pool.execute('SELECT automation_enabled FROM settings WHERE id=1');
    assert.equal(Boolean(stillPaused.automation_enabled), false, 'missing or reused Reviewer cannot enable automation');

    await pool.execute('UPDATE integration_config SET reviewer_model=? WHERE id=1', ['fixture/reviewer-v1']);
    await pool.execute(`INSERT INTO slots (id,scheduled_at,automation_session_id,status,tebar_profile_id,tebar_account_id,tebar_config_version)
      VALUES (?,?,?,'pending',?,?,?)`,
    [slotId, new Date(Date.now() - 10_000), sessionId, profileId, accountId, configurationVersion]);
    await pool.execute('UPDATE settings SET automation_enabled=TRUE WHERE id=1');

    const claimed = await repository.claimDueSlot({ now: new Date() });
    assert.equal(claimed.id, slotId);
    assert.equal(claimed.model, 'fixture/generator-v1');
    assert.equal(claimed.reviewerModel, 'fixture/reviewer-v1');
    assert.equal(claimed.businessKnowledgeVersion, 40);
    assert.equal(claimed.businessKnowledge.ctaUrl, knowledge.ctaUrl);

    const changedGenerator = await configuration.setModel({ model: 'fixture/generator-v2', expectedVersion: configurationVersion, actorId });
    const changedReviewer = await configuration.setReviewerModel({ model: 'fixture/reviewer-v2', expectedVersion: changedGenerator.version, actorId });
    await assert.rejects(configuration.setReviewerModel({ model: 'fixture/generator-v2', expectedVersion: changedReviewer.version, actorId }),
      error => error.code === 'MODEL_IDS_MUST_DIFFER');
    const changedKnowledge = { ...knowledge, services: ['Pengembangan perangkat lunak kustom'] };
    await pool.execute('UPDATE settings SET business_knowledge_json=?,business_knowledge_version=41 WHERE id=1', [JSON.stringify(changedKnowledge)]);

    const [[slotSnapshot]] = await pool.execute(`SELECT status,openrouter_model,openrouter_reviewer_model,model_config_version,
      cta_url,content_category_id,content_style_id,content_strategy_json,business_knowledge_snapshot_json,
      business_knowledge_snapshot_version,generation_settings_snapshot_json
      FROM slots WHERE id=?`, [slotId]);
    assert.equal(slotSnapshot.status, 'generating');
    assert.equal(slotSnapshot.openrouter_model, 'fixture/generator-v1');
    assert.equal(slotSnapshot.openrouter_reviewer_model, 'fixture/reviewer-v1');
    assert.equal(Number(slotSnapshot.model_config_version), configurationVersion);
    assert.equal(slotSnapshot.cta_url, knowledge.ctaUrl);
    assert.ok(slotSnapshot.content_category_id && slotSnapshot.content_style_id);
    assert.equal(JSON.parse(encodeJson(slotSnapshot.business_knowledge_snapshot_json)).services.length, knowledge.services.length);
    assert.equal(Number(slotSnapshot.business_knowledge_snapshot_version), 40);
    const generationSettings = JSON.parse(encodeJson(slotSnapshot.generation_settings_snapshot_json));
    assert.deepEqual(generationSettings.schedule, schedule);
    assert.deepEqual(generationSettings.hashtags, hashtags);

    await repository.saveReviewAttempts(slotId, [{
      decision: 'REVISE', rationaleCode: 'SAFE_REPAIR', technicalRetry: false,
      draft: 'Kontak secret@example.test sk-or-v1-abcdefghijklmnopqrstuvwxyz',
      violations: [{ code: 'UNSUPPORTED_NUMERIC_CLAIM', path: 'caption.body', repairability: 'repairable_content', description: 'untrusted text is not persisted' }],
    }]);
    const [[attempt]] = await pool.execute('SELECT decision,rationale_code,sanitized_draft,violations_json FROM slot_content_review_attempts WHERE slot_id=?', [slotId]);
    assert.equal(attempt.decision, 'REVISE');
    assert.equal(attempt.rationale_code, 'SAFE_REPAIR');
    assert.doesNotMatch(attempt.sanitized_draft, /secret@example\.test|sk-or-v1-/u);
    assert.deepEqual(JSON.parse(encodeJson(attempt.violations_json)), [{ code: 'UNSUPPORTED_NUMERIC_CLAIM', path: 'caption.body', repairability: 'repairable_content' }]);

    const caption = `Informasi yang tertata membantu tim memahami konteks. Mari diskusikan kebutuhan teknologi organisasi Anda.\n#NusaDataIndonesia\n${knowledge.ctaUrl}`;
    assert.equal(await repository.savePreparedSlot(slotId, {
      requestPayload: { content: caption, targets: [{ account_id: accountId }] },
      idempotencyKey: `dual-ai-test-${slotId}`, caption, pillar: 'ndi',
      contentSafetyHash: contentSafetyHash(generationSettings), reviewed: true,
      reviewMetadata: { revisionCount: 1, rationaleCode: 'SAFE_REPAIR', reviewerModel: 'fixture/reviewer-v1' },
    }), true);
    const listedSlot = (await repository.listSlots()).find(item => item.id === slotId);
    assert.equal(listedSlot.reviewed, true);
    assert.equal(listedSlot.reviewMetadata.revisionCount, 1);

    const unknownAt = new Date('2026-11-20T05:00:00.000Z'); // 12:00 in Asia/Jakarta.
    const nextAt = new Date(unknownAt.getTime() + schedule.intervalMinutes * 60_000);
    await pool.execute("UPDATE slots SET scheduled_at=?,status='unknown',provider_status='unknown',error_code='unknown_outcome' WHERE id=?", [unknownAt, slotId]);
    await pool.execute(`INSERT INTO slots (id,scheduled_at,automation_session_id,status,provider_status,error_code,
      request_payload,idempotency_key,tebar_profile_id,tebar_account_id,tebar_config_version)
      VALUES (?,? ,?,'unknown','unknown','unknown_outcome',?,?,?,?,?)`,
    [secondUnknownSlotId, new Date(unknownAt.getTime() + 60_000), sessionId, JSON.stringify({ content: 'second unresolved fixture' }),
      `dual-ai-test-${secondUnknownSlotId}`, profileId, accountId, configurationVersion]);
    const [[unknownBefore]] = await pool.execute('SELECT request_payload,idempotency_key,status FROM slots WHERE id=?', [slotId]);
    settings.nextSlotAt = nextAt.toISOString();
    await pool.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(settings)]);
    const planned = await repository.ensureNextDueSlot({ now: nextAt, timezone: schedule.timezone });
    assert.equal(planned.created, true);
    assert.ok(planned.slot.id !== slotId, 'continuation must use a distinct slot ID');
    assert.notEqual(planned.slot.id, secondUnknownSlotId, 'multiple unresolved slots cannot be reused as the next scheduled slot');
    assert.equal(new Date(planned.slot.scheduledAt).getTime(), nextAt.getTime(), 'unknown at 12:00 WIB permits the 13:00 slot, not an immediate replacement');
    followupSlotId = planned.slot.id;
    await pool.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1');
    assert.equal(await repository.claimDueSlot({ now: nextAt }), null, 'emergency pause still blocks continuation');
    await pool.execute('UPDATE settings SET automation_enabled=TRUE WHERE id=1');
    const continued = await repository.claimDueSlot({ now: nextAt });
    assert.equal(continued.id, followupSlotId);
    assert.equal(continued.model, 'fixture/generator-v2');
    assert.equal(continued.reviewerModel, 'fixture/reviewer-v2');
    const [[unknownAfter]] = await pool.execute('SELECT request_payload,idempotency_key,status FROM slots WHERE id=?', [slotId]);
    assert.equal(unknownAfter.status, 'unknown');
    assert.deepEqual(encodeJson(unknownAfter.request_payload), encodeJson(unknownBefore.request_payload));
    assert.equal(unknownAfter.idempotency_key, unknownBefore.idempotency_key, 'the original unknown request identity remains immutable');

    const [[history]] = await pool.execute(`SELECT COUNT(*) AS count FROM integration_config_history
      WHERE version IN (?,?) AND action IN ('model_updated','reviewer_model_updated')`, [changedGenerator.version, changedReviewer.version]);
    assert.equal(Number(history.count), 2, 'both model edits are versioned in DB history');
    const [[audit]] = await pool.execute(`SELECT COUNT(*) AS count FROM audit_logs WHERE admin_id=?
      AND action IN ('integration.model_updated','integration.reviewer_model_updated')`, [actorId]);
    assert.equal(Number(audit.count), 2, 'both model edits are present in audit log');
  } finally {
    if (followupSlotId) {
      await pool.execute('DELETE FROM generation_slot_claims WHERE slot_id=?', [followupSlotId]).catch(() => {});
      await pool.execute('DELETE FROM generation_attempts WHERE slot_id=?', [followupSlotId]).catch(() => {});
      await pool.execute('DELETE FROM generation_learning_snapshots WHERE slot_id=?', [followupSlotId]).catch(() => {});
      await pool.execute('DELETE FROM slots WHERE id=?', [followupSlotId]).catch(() => {});
    }
    await pool.execute('DELETE FROM slots WHERE id=?', [secondUnknownSlotId]).catch(() => {});
    await pool.execute('DELETE FROM slot_content_review_attempts WHERE slot_id=?', [slotId]).catch(() => {});
    await pool.execute('DELETE FROM generation_slot_claims WHERE slot_id=?', [slotId]).catch(() => {});
    await pool.execute('DELETE FROM generation_attempts WHERE slot_id=?', [slotId]).catch(() => {});
    await pool.execute('DELETE FROM generation_learning_snapshots WHERE slot_id=?', [slotId]).catch(() => {});
    await pool.execute('DELETE FROM activity_logs WHERE slot_id=?', [slotId]).catch(() => {});
    await pool.execute('DELETE FROM slots WHERE id=?', [slotId]).catch(() => {});
    if (actorId) {
      await pool.execute('DELETE FROM audit_logs WHERE admin_id=?', [actorId]).catch(() => {});
      await pool.execute('DELETE FROM integration_config_history WHERE version IN (?,?)', [configurationVersion + 1, configurationVersion + 2]).catch(() => {});
      await pool.execute('DELETE FROM admins WHERE id=?', [actorId]).catch(() => {});
    }
    if (savedSettings) await pool.execute(`UPDATE settings SET settings_json=?,business_knowledge_json=?,business_knowledge_approved=?,
      business_knowledge_version=?,automation_enabled=? WHERE id=1`, [
      encodeJson(savedSettings.settings_json), encodeJson(savedSettings.business_knowledge_json), savedSettings.business_knowledge_approved,
      savedSettings.business_knowledge_version, savedSettings.automation_enabled,
    ]).catch(() => {});
    if (savedIntegration) await pool.execute(`UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,reviewer_model=?,status=?,
      pending_profile_id=?,pending_account_id=?,pending_model=?,pending_reviewer_model=?,updated_by=?,created_at=?,updated_at=? WHERE id=1`, [
      savedIntegration.version, savedIntegration.profile_id, savedIntegration.account_id, savedIntegration.model, savedIntegration.reviewer_model,
      savedIntegration.status, savedIntegration.pending_profile_id, savedIntegration.pending_account_id, savedIntegration.pending_model,
      savedIntegration.pending_reviewer_model, savedIntegration.updated_by, savedIntegration.created_at, savedIntegration.updated_at,
    ]).catch(() => {});
    else await pool.execute('DELETE FROM integration_config WHERE id=1').catch(() => {});
    if (savedStrategy) await pool.execute('UPDATE content_strategy_settings SET enabled=?,enabled_by=?,enabled_at=? WHERE id=1', [
      savedStrategy.enabled, savedStrategy.enabled_by, savedStrategy.enabled_at,
    ]).catch(() => {});
    await pool.end();
  }
});
