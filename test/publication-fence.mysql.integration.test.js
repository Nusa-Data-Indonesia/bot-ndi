'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

const databaseName = 'bot_ndi_test_publication_upgrade';
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === databaseName
  && ['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST)
  && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('MySQL serializes a publish outcome with recovery and admin closure, and denies a stale worker afterward', { skip: !enabled }, async () => {
  const { createPool } = require('../src/db');
  const { loadEnv } = require('../src/config');
  const { runMigrations } = require('../src/migrate');
  const { createRepository } = require('../src/repository');
  const pool = createPool(loadEnv());
  const recoveryPool = createPool(loadEnv());
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const requestIds = [randomUUID(), randomUUID()];
  const sessionId = randomUUID();
  const profileId = `fence-profile-${randomUUID()}`;
  const accountId = `fence-account-${randomUUID()}`;
  let adminId;
  let savedSettings;
  let savedAutomation;
  let savedIntegration;
  let insertedIntegration = false;
  let releaseProviderStub;
  let fencePromise;

  try {
    const [[database]] = await pool.query('SELECT DATABASE() AS name, VERSION() AS version');
    assert.equal(database.name, databaseName);
    assert.match(database.version, /^8\.4\./);
    await runMigrations(pool);
    [[savedSettings]] = await pool.query('SELECT settings_json,automation_enabled FROM settings WHERE id=1');
    savedAutomation = savedSettings.automation_enabled;
    [[savedIntegration]] = await pool.query('SELECT * FROM integration_config WHERE id=1');
    if (savedIntegration) {
      await pool.execute("UPDATE integration_config SET profile_id=?,account_id=?,model='test/generator',reviewer_model='test/reviewer',status='ACTIVE',version=version+1 WHERE id=1", [profileId, accountId]);
    } else {
      await pool.execute("INSERT INTO integration_config (id,version,profile_id,account_id,model,reviewer_model,status) VALUES (1,1,?,?,'test/generator','test/reviewer','ACTIVE')", [profileId, accountId]);
      insertedIntegration = true;
    }
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [`fence-${randomUUID()}@example.test`, 'test-only-password-hash']);
    adminId = admin.insertId;
    await pool.execute('UPDATE settings SET settings_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify({ automationSessionId: sessionId, profileId, targetAccountId: accountId })]);

    const staleAt = new Date(Date.now() - 10 * 60_000);
    for (let index = 0; index < ids.length; index++) {
      await pool.execute(`INSERT INTO slots (id,scheduled_at,automation_session_id,status,provider_status,error_code,publish_started_at,request_payload,idempotency_key,tebar_profile_id,tebar_account_id)
        VALUES (?,?,?,'publishing','unknown','network_error',?,?,?,?,?)`,
      [ids[index], new Date(Date.now() + index * 1000), sessionId, index === 0 ? staleAt : new Date(),
        index === 0 ? JSON.stringify({ content: 'Mocked fence request', targets: [{ account_id: accountId }] }) : null,
        index === 0 ? `fence-${ids[index]}` : null, index === 0 ? profileId : null, index === 0 ? accountId : null]);
    }

    const repository = createRepository(pool);
    const secondRepository = createRepository(recoveryPool);
    const events = [];
    let providerStubEntered;
    const providerStarted = new Promise(resolve => { providerStubEntered = resolve; });
    const providerRelease = new Promise(resolve => { releaseProviderStub = resolve; });

    fencePromise = repository.withPublicationFence(ids[0], async recordOutcome => {
      // This callback stands in for the provider mutation. No provider client is created.
      events.push('provider-stub-entered');
      providerStubEntered();
      await providerRelease;
      await recordOutcome({ status: 'unknown', providerStatus: 'unknown', errorCode: 'unknown_outcome' });
      events.push('outcome-recorded');
      return 'outcome-saved';
    }).then(result => { events.push('fence-committed'); return result; });

    await providerStarted;
    const recoveredDuringFence = await secondRepository.recoverStalePublishing({ now: new Date() });
    assert.equal(recoveredDuringFence.includes(ids[0]), false, 'SKIP LOCKED must leave a live publisher-owned slot untouched');

    let closeLockRequested;
    const lockRequest = new Promise(resolve => { closeLockRequested = resolve; });
    const closePool = {
      execute: (...args) => pool.execute(...args),
      query: (...args) => pool.query(...args),
      getConnection: async () => {
        const connection = await pool.getConnection();
        const query = connection.query.bind(connection);
        connection.query = (sql, ...args) => {
          if (String(sql).includes('settings') && String(sql).includes('FOR UPDATE')) closeLockRequested();
          return query(sql, ...args);
        };
        return connection;
      },
    };
    const closeRepository = createRepository(closePool);
    const input = (slotId, requestId) => ({ slotId, requestId, actorId: adminId,
      reason: 'Provider outcome is still unverified.',
      evidenceSummary: 'Test-only mock callback; no live provider request was sent.' });
    const closeEvents = [];
    const closeFirst = closeRepository.closeUnknownPublication(input(ids[0], requestIds[0]))
      .then(result => { closeEvents.push('close-committed'); return result; });
    await lockRequest;
    assert.deepEqual(events, ['provider-stub-entered']);
    releaseProviderStub();
    const [fenceResult, closeResult] = await Promise.all([fencePromise, closeFirst]);
    assert.equal(fenceResult, 'outcome-saved');
    assert.equal(closeResult.previousStatus, 'unknown');
    assert.equal((await repository.getPublicationSlot(ids[0])).status, 'admin_closed_unknown');
    assert.deepEqual(events, ['provider-stub-entered', 'outcome-recorded', 'fence-committed']);
    assert.deepEqual(closeEvents, ['close-committed']);
    let [[unknownEvidence]] = await pool.execute('SELECT COUNT(*) AS count FROM publication_unknown_events WHERE slot_id=?', [ids[0]]);
    assert.equal(Number(unknownEvidence.count), 1);
    let [[thresholdAlerts]] = await pool.execute(`SELECT COUNT(*) AS count FROM publication_unknown_threshold_alerts a
      JOIN publication_unknown_events e ON e.id=a.threshold_event_id WHERE e.slot_id IN (${ids.map(() => '?').join(',')})`, ids);
    assert.equal(Number(thresholdAlerts.count), 0);

    await pool.execute('UPDATE slots SET publish_started_at=? WHERE id IN (?,?)', [staleAt, ids[1], ids[2]]);
    const recoveredAfterPause = await secondRepository.recoverStalePublishing({ now: new Date(), slotIds: [ids[1]] });
    assert.ok(recoveredAfterPause.includes(ids[1]), 'a stale row without target metadata must be made operator-resolvable');
    assert.equal(recoveredAfterPause.includes(ids[2]), false, 'a scoped recovery must leave unrelated stale slots unchanged');
    assert.equal((await repository.getPublicationSlot(ids[2])).status, 'publishing');
    const recoveredOutOfScope = await secondRepository.recoverStalePublishing({ now: new Date() });
    assert.ok(recoveredOutOfScope.includes(ids[2]), 'the unrelated slot remains recoverable by a later global sweep');
    await pool.execute('UPDATE slots SET publish_started_at=? WHERE id=?', [staleAt, ids[3]]);
    assert.deepEqual(await secondRepository.recoverStalePublishing({ now: new Date(), slotIds: [ids[3]] }), [ids[3]]);
    [[unknownEvidence]] = await pool.execute(`SELECT COUNT(*) AS count FROM publication_unknown_events WHERE slot_id IN (${ids.map(() => '?').join(',')})`, ids);
    assert.equal(Number(unknownEvidence.count), 4);
    [[thresholdAlerts]] = await pool.execute(`SELECT COUNT(*) AS count FROM publication_unknown_threshold_alerts a
      JOIN publication_unknown_events e ON e.id=a.threshold_event_id WHERE e.slot_id IN (${ids.map(() => '?').join(',')})`, ids);
    assert.equal(Number(thresholdAlerts.count), 1);
    const [[automationAfterThreshold]] = await pool.execute('SELECT automation_enabled FROM settings WHERE id=1');
    assert.equal(Boolean(automationAfterThreshold.automation_enabled), true, 'unknown threshold alerts must not pause automation');
    const unknownNoticeKeys = ids.map(id => createHash('sha256').update(`unknown-slot:${id}:1`).digest('hex'));
    const [[queuedNotices]] = await pool.execute(`SELECT COUNT(*) AS count FROM notification_outbox
      WHERE dedupe_key IN (${unknownNoticeKeys.map(() => '?').join(',')})`, unknownNoticeKeys);
    assert.equal(Number(queuedNotices.count), 4);
    const [thresholdNoticeRows] = await pool.execute(`SELECT dedupe_key FROM publication_unknown_threshold_alerts a
      JOIN publication_unknown_events e ON e.id=a.threshold_event_id WHERE e.slot_id IN (${ids.map(() => '?').join(',')})`, ids);
    assert.equal(thresholdNoticeRows.length, 1);
    const [[queuedThresholdNotice]] = await pool.execute('SELECT COUNT(*) AS count FROM notification_outbox WHERE dedupe_key=?', [thresholdNoticeRows[0].dedupe_key]);
    assert.equal(Number(queuedThresholdNotice.count), 1);
    await repository.closeUnknownPublication(input(ids[1], requestIds[1]));
    let staleProviderStubCalled = false;
    const staleWorkerResult = await repository.withPublicationFence(ids[1], async () => {
      staleProviderStubCalled = true;
    });
    assert.equal(staleWorkerResult, false);
    assert.equal(staleProviderStubCalled, false, 'a stale worker must not reach the provider callback after closure');

    const [[migrationSnapshot]] = await pool.execute(`SELECT s.status,s.request_payload,s.idempotency_key,s.tebar_profile_id,s.tebar_account_id,
      s.unknown_occurrence_count,i.model,i.reviewer_model FROM slots s JOIN integration_config i ON i.id=1 WHERE s.id=?`, [ids[2]]);
    await pool.execute("DELETE FROM schema_migrations WHERE version='024_dual_ai_and_unknown_continuation.sql'");
    assert.deepEqual(await runMigrations(pool), ['024_dual_ai_and_unknown_continuation.sql']);
    const [[migrationAfter]] = await pool.execute(`SELECT s.status,s.request_payload,s.idempotency_key,s.tebar_profile_id,s.tebar_account_id,
      s.unknown_occurrence_count,i.model,i.reviewer_model FROM slots s JOIN integration_config i ON i.id=1 WHERE s.id=?`, [ids[2]]);
    assert.deepEqual(migrationAfter, migrationSnapshot);
    [[unknownEvidence]] = await pool.execute(`SELECT COUNT(*) AS count FROM publication_unknown_events WHERE slot_id IN (${ids.map(() => '?').join(',')})`, ids);
    assert.equal(Number(unknownEvidence.count), 4, 'migration rerun must not duplicate occurrence history');

    const [[eventsForSlots]] = await pool.execute('SELECT COUNT(*) AS count FROM publication_resolution_events WHERE slot_id IN (?,?)', [ids[0], ids[1]]);
    assert.equal(Number(eventsForSlots.count), 2);
  } finally {
    releaseProviderStub?.();
    await fencePromise?.catch(() => {});
    await pool.execute('UPDATE settings SET settings_json=?,automation_enabled=? WHERE id=1', [JSON.stringify(savedSettings?.settings_json || {}), savedAutomation ?? false]).catch(() => {});
    if (insertedIntegration) await pool.execute('DELETE FROM integration_config WHERE id=1').catch(() => {});
    else if (savedIntegration) await pool.execute(`UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,reviewer_model=?,status=?,pending_profile_id=?,pending_account_id=?,pending_model=?,pending_reviewer_model=?,updated_by=?,updated_at=? WHERE id=1`,
      [savedIntegration.version, savedIntegration.profile_id, savedIntegration.account_id, savedIntegration.model, savedIntegration.reviewer_model, savedIntegration.status,
        savedIntegration.pending_profile_id, savedIntegration.pending_account_id, savedIntegration.pending_model, savedIntegration.pending_reviewer_model, savedIntegration.updated_by, savedIntegration.updated_at]).catch(() => {});
    if (adminId) {
      const [thresholdRows] = await pool.execute(`SELECT a.dedupe_key FROM publication_unknown_threshold_alerts a
        JOIN publication_unknown_events e ON e.id=a.threshold_event_id WHERE e.slot_id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => [[]]);
      const slotNoticeKeys = ids.map(id => createHash('sha256').update(`unknown-slot:${id}:1`).digest('hex'));
      const outboxKeys = [...slotNoticeKeys, ...thresholdRows.map(row => row.dedupe_key),
        ...requestIds.map(id => createHash('sha256').update(`publication-resolution:${id}`).digest('hex'))];
      await pool.execute(`DELETE FROM notification_outbox WHERE dedupe_key IN (${outboxKeys.map(() => '?').join(',')})`, outboxKeys).catch(() => {});
      await pool.execute(`DELETE a FROM publication_unknown_threshold_alerts a JOIN publication_unknown_events e ON e.id=a.threshold_event_id WHERE e.slot_id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
      await pool.execute(`DELETE FROM publication_unknown_events WHERE slot_id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
      await pool.execute('DELETE FROM publication_resolution_events WHERE slot_id IN (?,?)', [ids[0],ids[1]]).catch(() => {});
      await pool.execute(`DELETE FROM activity_logs WHERE slot_id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
      await pool.execute('DELETE FROM audit_logs WHERE admin_id=?', [adminId]).catch(() => {});
      await pool.execute(`DELETE FROM slots WHERE id IN (${ids.map(() => '?').join(',')})`, ids).catch(() => {});
      await pool.execute('DELETE FROM admins WHERE id=?', [adminId]).catch(() => {});
    }
    await recoveryPool.end();
    await pool.end();
  }
});
