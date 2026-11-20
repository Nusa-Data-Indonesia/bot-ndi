const { randomUUID, createHash } = require('node:crypto');
const { formatSlotNotice } = require('./telegram-format');
const { contentSafetyHash } = require('./content-safety');
const { validateNdiCaption } = require('./content-validation');
const { DateTime } = require('luxon');
const { isInActiveWindow, normalizeScheduleInterval } = require('./policy');
const { validateNdiSettings } = require('./ndi-settings');
const { validateBusinessKnowledge } = require('./business-knowledge');
const { contentStrategyReadiness, selectUniform, validateStrategyInput } = require('./content-strategy');
const { OFFICIAL_URL } = require('./website-knowledge-sync');
const { hasDistinctModels } = require('./configuration');

const STALE_PUBLISHING_AFTER_MS = 120_000;

const json = (value, fallback = {}) => {
  if (value === null || value === undefined) return fallback;
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch { return fallback; }
};
const safeId = (value) => String(value);
function loginThrottleKeys(email, ip) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedIp = String(ip || 'unknown').slice(0, 64);
  const hash = (scope, value) => createHash('sha256').update(`${scope}\0${value}`).digest('hex');
  return [
    { scope: 'pair', subjectHash: hash('pair', `${normalizedIp}\0${normalizedEmail}`) },
    { scope: 'account', subjectHash: hash('account', normalizedEmail) },
    { scope: 'ip', subjectHash: hash('ip', normalizedIp) },
  ];
}
function validThrottleTime(now) {
  return now instanceof Date && Number.isFinite(now.getTime());
}
function normalizeCompletedAt(value) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw Object.assign(new TypeError('completedAt must be a valid date'), { code: 'INVALID_COMPLETED_AT' });
    return value;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw Object.assign(new TypeError('completedAt must be an ISO timestamp, Date, or null'), { code: 'INVALID_COMPLETED_AT' });
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw Object.assign(new TypeError('completedAt must be a valid ISO timestamp'), { code: 'INVALID_COMPLETED_AT' });
  return parsed.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
}
function normalizeProviderPublishedAt(value) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw Object.assign(new TypeError('providerPublishedAt must be a valid date'), { code: 'INVALID_PROVIDER_PUBLISHED_AT' });
    return DateTime.fromJSDate(value, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm:ss.SSS');
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw Object.assign(new TypeError('providerPublishedAt must be an ISO timestamp, Date, or null'), { code: 'INVALID_PROVIDER_PUBLISHED_AT' });
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw Object.assign(new TypeError('providerPublishedAt must be a valid ISO timestamp'), { code: 'INVALID_PROVIDER_PUBLISHED_AT' });
  return parsed.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
}

/**
 * @typedef {{ provider: 'tebar' | 'openrouter', profileId: string | null, accountId: string | null, reasonCode: string, slotId?: string | null }} ProviderHold
 * @typedef {{ status: 'publishing' | 'unknown' | 'published' | 'failed' | 'partial' | 'canceled', providerPostId?: string | null, providerStatus?: string | null, errorCode?: string | null, completedAt?: Date | string | null, providerPublishedAt?: Date | string | null }} PublicationOutcomePatch
 * @typedef {import('mysql2/promise').Pool | import('mysql2/promise').PoolConnection} RepositoryConnection
 */

/**
 * @param {RepositoryConnection} connection
 * @param {string} sql
 * @param {import('mysql2').ExecuteValues | import('mysql2').QueryValues} [values]
 * @param {'execute' | 'query'} [method]
 * @returns {Promise<[import('mysql2').RowDataPacket[], import('mysql2').FieldPacket[]]>}
 */
async function selectQuery(connection, sql, values = [], method = 'execute') {
  const [rows, fields] = method === 'query'
    ? await connection.query(sql, /** @type {import('mysql2').QueryValues} */ (values))
    : await connection.execute(sql, /** @type {import('mysql2').ExecuteValues} */ (values));
  if (!Array.isArray(rows)) throw new TypeError('SELECT query did not return rows');
  return [/** @type {import('mysql2').RowDataPacket[]} */ (/** @type {unknown} */ (rows)), fields];
}

/**
 * @param {RepositoryConnection} connection
 * @param {string} sql
 * @param {import('mysql2').ExecuteValues} [values]
 * @returns {Promise<[import('mysql2').ResultSetHeader, import('mysql2').FieldPacket[]]>}
 */
async function mutationQuery(connection, sql, values = []) {
  const [result, fields] = await connection.execute(sql, values);
  if (!result || typeof result !== 'object' || !('affectedRows' in result)) {
    throw new TypeError('Mutation query did not return a result header');
  }
  return [/** @type {import('mysql2').ResultSetHeader} */ (result), fields];
}

/** @param {import('mysql2/promise').Pool} pool */
function createRepository(pool) {
  if (!pool || typeof pool.execute !== 'function') throw new TypeError('mysql pool is required');
  async function audit(connection, adminId, action, details = {}) {
    await connection.execute('INSERT INTO audit_logs (admin_id, action, details_json) VALUES (?, ?, ?)', [adminId || null, action, JSON.stringify(details)]);
  }
  async function getStrategyStatus(connection) {
    const [[counts]] = await selectQuery(connection, `SELECT
      (SELECT COUNT(*) FROM content_categories WHERE active=TRUE AND archived_at IS NULL) AS category_count,
      (SELECT COUNT(*) FROM content_styles WHERE active=TRUE AND archived_at IS NULL) AS style_count`);
    const [[strategy]] = await selectQuery(connection, 'SELECT enabled FROM content_strategy_settings WHERE id=1');
    const [[missingTime]] = await selectQuery(connection, `SELECT id FROM slots WHERE status='published'
      AND content_category_id IS NOT NULL AND (provider_published_at IS NULL OR YEAR(provider_published_at)<1000) LIMIT 1`);
    let latestCategoryId = null;
    let orderUncertain = Boolean(missingTime);
    if (!orderUncertain) {
      const [[latest]] = await selectQuery(connection, `SELECT provider_published_at,
        COUNT(DISTINCT content_category_id) AS category_count
        FROM slots WHERE status='published' AND content_category_id IS NOT NULL
        GROUP BY provider_published_at ORDER BY provider_published_at DESC LIMIT 1`);
      if (latest && Number(latest.category_count) > 1) orderUncertain = true;
      else if (latest) {
        const [[last]] = await selectQuery(connection, `SELECT content_category_id FROM slots
          WHERE status='published' AND content_category_id IS NOT NULL AND provider_published_at=?
          ORDER BY id DESC LIMIT 1`, [latest.provider_published_at]);
        latestCategoryId = last?.content_category_id == null ? null : String(last.content_category_id);
      }
    }
    const readiness = contentStrategyReadiness({
      approved: strategy?.enabled === 1 || strategy?.enabled === true,
      categoryCount: Number(counts?.category_count || 0),
      styleCount: Number(counts?.style_count || 0),
      orderUncertain,
    });
    return { ...readiness, approved: strategy?.enabled === 1 || strategy?.enabled === true,
      categoryCount: Number(counts?.category_count || 0), styleCount: Number(counts?.style_count || 0),
      orderUncertain, latestCategoryId };
  }
  function runtimeSettings(row) {
    const stored = json(row?.settings_json);
    const knowledge = json(row?.business_knowledge_json, null);
    const checked = validateNdiSettings({ schedule: stored.schedule || {}, hashtags: stored.hashtags || [], businessKnowledge: knowledge || {} });
    return {
      ...(checked.valid ? checked.settings : { schedule: normalizeScheduleInterval(stored.schedule || {}), hashtags: [], businessKnowledge: {} }),
      targetAccountId: stored.targetAccountId || null,
      profileId: stored.profileId || null,
      onboardingComplete: stored.onboardingComplete === true,
      automationSessionId: stored.automationSessionId || null,
      nextSlotAt: stored.nextSlotAt || null,
      integrationConfigInitialized: stored.integrationConfigInitialized === true,
    };
  }
  async function getSettings() {
    const [rows] = await selectQuery(pool, 'SELECT settings_json,business_knowledge_json,business_knowledge_approved,business_knowledge_version,automation_enabled FROM settings WHERE id=1');
    const row = rows[0];
    if (!row) return { automationEnabled: false, businessKnowledgeApproved: false, businessKnowledgeVersion: 1 };
    return { ...runtimeSettings(row), businessKnowledgeApproved: Boolean(row.business_knowledge_approved), businessKnowledgeVersion: Number(row.business_knowledge_version || 1), automationEnabled: Boolean(row.automation_enabled) };
  }
  async function getRuntimeState() {
    const [rows] = await selectQuery(pool, 'SELECT settings_json,business_knowledge_json,business_knowledge_approved,business_knowledge_version,automation_enabled FROM settings WHERE id=1');
    const row = rows[0];
    const settings = runtimeSettings(row);
    const history = await listSlots(1000);
    const strategy = await getStrategyStatus(pool);
    return { settings, businessKnowledge: settings.businessKnowledge, businessKnowledgeApproved: Boolean(row?.business_knowledge_approved),
      businessKnowledgeVersion: Number(row?.business_knowledge_version || 1),
      contentStrategyReady: strategy.ready, contentStrategyReason: strategy.message, contentStrategyReasonCode: strategy.reasonCode,
      contentStrategy: strategy, facts: [], history, automationEnabled: Boolean(row?.automation_enabled), accountId: settings.targetAccountId || null, profileId: settings.profileId || null, onboardingComplete: settings.onboardingComplete === true };
  }
  async function getContentStrategyState() {
    const [categories] = await selectQuery(pool, `SELECT id,slug,name,guidance,active,archived_at,created_at,updated_at
      FROM content_categories ORDER BY id`);
    const [styles] = await selectQuery(pool, `SELECT id,slug,name,instructions,active,archived_at,created_at,updated_at
      FROM content_styles ORDER BY id`);
    const [proposals] = await selectQuery(pool, `SELECT id,name,guidance,status,source,reviewed_by,reviewed_at,created_at
      FROM category_proposals ORDER BY id DESC LIMIT 100`);
    const [[proposalSettings]] = await selectQuery(pool, `SELECT enabled,interval_days,next_run_at,last_started_at,last_completed_at,last_error_code
      FROM category_proposal_settings WHERE id=1`);
    const strategy = await getStrategyStatus(pool);
    return {
      categories: categories.map((item) => ({ ...item, id: String(item.id), active: Boolean(item.active), archivedAt: item.archived_at, createdAt: item.created_at, updatedAt: item.updated_at })),
      styles: styles.map((item) => ({ ...item, id: String(item.id), active: Boolean(item.active), archivedAt: item.archived_at, createdAt: item.created_at, updatedAt: item.updated_at })),
      proposals: proposals.map((item) => ({ ...item, id: String(item.id), reviewedBy: item.reviewed_by == null ? null : String(item.reviewed_by), reviewedAt: item.reviewed_at, createdAt: item.created_at })),
      proposalSettings: proposalSettings ? { enabled: Boolean(proposalSettings.enabled), intervalDays: Number(proposalSettings.interval_days), nextRunAt: proposalSettings.next_run_at, lastStartedAt: proposalSettings.last_started_at, lastCompletedAt: proposalSettings.last_completed_at, lastErrorCode: proposalSettings.last_error_code } : { enabled: false, intervalDays: 30 },
      readiness: strategy,
    };
  }
  async function getWebsiteSyncState() {
    const [runs] = await selectQuery(pool, `SELECT id,requested_by,source_url,knowledge_version,status,proposal_count,error_code,fetched_at,completed_at,created_at
      FROM website_sync_runs ORDER BY created_at DESC,id DESC LIMIT 50`);
    const [proposals] = await selectQuery(pool, `SELECT id,sync_run_id,knowledge_version,field_name,operation,target_value,base_value,source_url,source_title,fetched_at,status,conflict_code,reviewed_by,reviewed_at,created_at
      FROM website_sync_proposals ORDER BY id DESC LIMIT 200`);
    return {
      knowledgeVersion: (await getSettings()).businessKnowledgeVersion,
      runs: runs.map((item) => ({ id: item.id, requestedBy: item.requested_by == null ? null : String(item.requested_by), sourceUrl: item.source_url,
        knowledgeVersion: Number(item.knowledge_version), status: item.status, proposalCount: Number(item.proposal_count), errorCode: item.error_code,
        fetchedAt: item.fetched_at, completedAt: item.completed_at, createdAt: item.created_at })),
      proposals: proposals.map((item) => ({ id: String(item.id), syncRunId: item.sync_run_id, knowledgeVersion: Number(item.knowledge_version),
        field: item.field_name, operation: item.operation, targetValue: item.target_value, baseValue: item.base_value, sourceUrl: item.source_url,
        sourceTitle: item.source_title, fetchedAt: item.fetched_at, status: item.status, conflictCode: item.conflict_code,
        reviewedBy: item.reviewed_by == null ? null : String(item.reviewed_by), reviewedAt: item.reviewed_at, createdAt: item.created_at })),
    };
  }
  async function startWebsiteSyncRun(adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[settings]] = await selectQuery(connection, `SELECT business_knowledge_json,business_knowledge_approved,business_knowledge_version
        FROM settings WHERE id=1 FOR UPDATE`, [], 'query');
      const knowledge = json(settings?.business_knowledge_json, {});
      const checked = validateBusinessKnowledge(knowledge);
      if (!settings?.business_knowledge_approved || !checked.valid) {
        throw Object.assign(new Error('BUSINESS_KNOWLEDGE_REVIEW_REQUIRED'), { code: 'BUSINESS_KNOWLEDGE_REVIEW_REQUIRED', status: 409 });
      }
      const id = randomUUID();
      const knowledgeVersion = Number(settings.business_knowledge_version || 1);
      await connection.execute(`INSERT INTO website_sync_runs (id,requested_by,source_url,knowledge_version,status)
        VALUES (?,?,?,?,'running')`, [id, adminId || null, OFFICIAL_URL, knowledgeVersion]);
      await audit(connection, adminId, 'ndi_website_sync.requested', { runId: id, sourceUrl: OFFICIAL_URL, knowledgeVersion });
      await connection.commit();
      return { id, knowledgeVersion, knowledge: checked.knowledge };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async function completeWebsiteSyncRun({ id, knowledgeVersion, sourceUrl, sourceTitle, fetchedAt, completedAt, proposals }) {
    if (typeof id !== 'string' || !Number.isInteger(knowledgeVersion) || sourceUrl !== OFFICIAL_URL
      || typeof sourceTitle !== 'string' || !sourceTitle.trim() || sourceTitle.length > 200
      || !(fetchedAt instanceof Date) || !Number.isFinite(fetchedAt.getTime())
      || !Array.isArray(proposals) || proposals.length > 100
      || !(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
      throw Object.assign(new Error('INVALID_WEBSITE_SYNC_RESULT'), { code: 'INVALID_WEBSITE_SYNC_RESULT', status: 400 });
    }
    const prepared = proposals.map((item) => {
      const cleanValue = (value) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 300
        && !/[\u0000-\u001f\u007f]/u.test(value);
      if (!['add', 'edit', 'remove'].includes(item?.operation) || !cleanValue(item.targetValue)
        || (item.operation === 'add' && item.baseValue !== null)
        || (item.operation !== 'add' && !cleanValue(item.baseValue))
        || item.sourceUrl !== OFFICIAL_URL || item.sourceTitle !== sourceTitle
        || !(item.fetchedAt instanceof Date) || item.fetchedAt.getTime() !== fetchedAt.getTime()
        || item.knowledgeVersion !== knowledgeVersion) {
        throw Object.assign(new Error('INVALID_WEBSITE_SYNC_PROPOSAL'), { code: 'INVALID_WEBSITE_SYNC_PROPOSAL', status: 400 });
      }
      return item;
    });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[run]] = await selectQuery(connection, 'SELECT status,knowledge_version,source_url,requested_by FROM website_sync_runs WHERE id=? FOR UPDATE', [id]);
      if (!run || run.status !== 'running' || Number(run.knowledge_version) !== knowledgeVersion || run.source_url !== OFFICIAL_URL) {
        throw Object.assign(new Error('WEBSITE_SYNC_RUN_NOT_FOUND'), { code: 'WEBSITE_SYNC_RUN_NOT_FOUND', status: 409 });
      }
      for (const proposal of prepared) {
        await connection.execute(`INSERT INTO website_sync_proposals (sync_run_id,knowledge_version,field_name,operation,target_value,base_value,source_url,source_title,fetched_at)
          VALUES (?,?, 'services', ?,?,?,?,?,?)`, [id, knowledgeVersion, proposal.operation, proposal.targetValue, proposal.baseValue, OFFICIAL_URL, sourceTitle, fetchedAt]);
      }
      await connection.execute(`UPDATE website_sync_runs SET status='completed',proposal_count=?,fetched_at=?,completed_at=? WHERE id=?`, [prepared.length, fetchedAt, completedAt, id]);
      await audit(connection, run.requested_by, 'ndi_website_sync.completed', { runId: id, proposalCount: prepared.length, sourceUrl: OFFICIAL_URL, knowledgeVersion });
      await connection.commit();
      return { syncRunId: id, proposalCount: prepared.length, fetchedAt };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async function failWebsiteSyncRun({ id, errorCode, failedAt }) {
    if (typeof id !== 'string' || !/^WEBSITE_SYNC_[A-Z0-9_]{2,60}$/.test(errorCode)
      || !(failedAt instanceof Date) || !Number.isFinite(failedAt.getTime())) return false;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[run]] = await selectQuery(connection, 'SELECT requested_by FROM website_sync_runs WHERE id=? AND status=\'running\' FOR UPDATE', [id]);
      if (!run) { await connection.commit(); return false; }
      const [updated] = await mutationQuery(connection, `UPDATE website_sync_runs SET status='failed',error_code=?,completed_at=?
        WHERE id=? AND status='running'`, [errorCode, failedAt, id]);
      if (updated.affectedRows) await audit(connection, run.requested_by, 'ndi_website_sync.failed', { runId: id, errorCode });
      await connection.commit();
      return Boolean(updated.affectedRows);
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async function reviewWebsiteKnowledgeProposal(id, decision, adminId) {
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !['approve', 'reject'].includes(decision)) {
      throw Object.assign(new Error('INVALID_WEBSITE_SYNC_REVIEW'), { code: 'INVALID_WEBSITE_SYNC_REVIEW', status: 400 });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[settings]] = await selectQuery(connection, 'SELECT business_knowledge_json,business_knowledge_approved,business_knowledge_version FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[proposal]] = await selectQuery(connection, 'SELECT * FROM website_sync_proposals WHERE id=? FOR UPDATE', [id]);
      if (!proposal) throw Object.assign(new Error('WEBSITE_SYNC_PROPOSAL_NOT_FOUND'), { code: 'WEBSITE_SYNC_PROPOSAL_NOT_FOUND', status: 404 });
      if (proposal.status !== 'pending') throw Object.assign(new Error('WEBSITE_SYNC_PROPOSAL_ALREADY_REVIEWED'), { code: 'WEBSITE_SYNC_PROPOSAL_ALREADY_REVIEWED', status: 409 });
      const currentVersion = Number(settings?.business_knowledge_version || 1);
      if (decision === 'reject') {
        await connection.execute(`UPDATE website_sync_proposals SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3)
          WHERE id=? AND status='pending'`, [adminId || null, proposal.id]);
        await audit(connection, adminId, 'ndi_website_sync.proposal.rejected', { proposalId: String(proposal.id), syncRunId: proposal.sync_run_id, field: proposal.field_name, operation: proposal.operation, knowledgeVersion: Number(proposal.knowledge_version) });
        await connection.commit();
        return { status: 'rejected', knowledgeVersion: currentVersion };
      }
      const conflict = (code) => ({ status: 'conflict', code });
      if (!settings?.business_knowledge_approved || currentVersion !== Number(proposal.knowledge_version)
        || proposal.field_name !== 'services' || proposal.source_url !== OFFICIAL_URL) {
        const code = currentVersion !== Number(proposal.knowledge_version) ? 'KNOWLEDGE_VERSION_CHANGED' : 'KNOWLEDGE_NOT_APPROVED';
        await connection.execute(`UPDATE website_sync_proposals SET status='conflict',conflict_code=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3)
          WHERE id=? AND status='pending'`, [code, adminId || null, proposal.id]);
        await audit(connection, adminId, 'ndi_website_sync.proposal.conflict', { proposalId: String(proposal.id), syncRunId: proposal.sync_run_id, conflictCode: code, proposalVersion: Number(proposal.knowledge_version), currentVersion });
        await connection.commit();
        return conflict(code);
      }
      const knowledge = json(settings.business_knowledge_json, {});
      const services = Array.isArray(knowledge.services) ? [...knowledge.services] : [];
      const normalized = (value) => String(value).normalize('NFKC').trim().toLocaleLowerCase('id');
      const baseIndex = proposal.base_value == null ? -1 : services.findIndex((value) => normalized(value) === normalized(proposal.base_value));
      const targetExists = services.some((value) => normalized(value) === normalized(proposal.target_value));
      let nextServices;
      let conflictCode = null;
      if (proposal.operation === 'add') {
        if (targetExists) conflictCode = 'SERVICE_ALREADY_EXISTS';
        else nextServices = [...services, proposal.target_value];
      } else if (proposal.operation === 'remove') {
        if (baseIndex < 0 || normalized(proposal.target_value) !== normalized(proposal.base_value)) conflictCode = 'SERVICE_CHANGED';
        else nextServices = services.filter((_value, index) => index !== baseIndex);
      } else if (proposal.operation === 'edit') {
        if (baseIndex < 0 || targetExists || normalized(proposal.target_value) === normalized(proposal.base_value)) conflictCode = 'SERVICE_CHANGED';
        else nextServices = services.map((value, index) => index === baseIndex ? proposal.target_value : value);
      } else conflictCode = 'INVALID_WEBSITE_SYNC_OPERATION';
      const checked = conflictCode ? null : validateBusinessKnowledge({ ...knowledge, services: nextServices });
      if (!conflictCode && !checked?.valid) conflictCode = 'KNOWLEDGE_VALIDATION_FAILED';
      if (conflictCode) {
        await connection.execute(`UPDATE website_sync_proposals SET status='conflict',conflict_code=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3)
          WHERE id=? AND status='pending'`, [conflictCode, adminId || null, proposal.id]);
        await audit(connection, adminId, 'ndi_website_sync.proposal.conflict', { proposalId: String(proposal.id), syncRunId: proposal.sync_run_id, conflictCode, proposalVersion: Number(proposal.knowledge_version), currentVersion });
        await connection.commit();
        return conflict(conflictCode);
      }
      const nextVersion = currentVersion + 1;
      await connection.execute(`UPDATE settings SET business_knowledge_json=?,business_knowledge_version=? WHERE id=1`, [JSON.stringify(checked.knowledge), nextVersion]);
      await connection.execute(`UPDATE website_sync_proposals SET status='approved',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3)
        WHERE id=? AND status='pending'`, [adminId || null, proposal.id]);
      await connection.execute(`UPDATE website_sync_proposals SET knowledge_version=? WHERE sync_run_id=? AND status='pending' AND id<>? AND knowledge_version=?`, [nextVersion, proposal.sync_run_id, proposal.id, currentVersion]);
      await audit(connection, adminId, 'ndi_website_sync.proposal.approved', { proposalId: String(proposal.id), syncRunId: proposal.sync_run_id, field: proposal.field_name, operation: proposal.operation, knowledgeVersion: nextVersion });
      await connection.commit();
      return { status: 'approved', knowledgeVersion: nextVersion, knowledge: checked.knowledge };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  function strategyTable(kind) {
    if (kind === 'category') return { table: 'content_categories', detail: 'guidance', event: 'content_category' };
    if (kind === 'style') return { table: 'content_styles', detail: 'instructions', event: 'content_style' };
    throw Object.assign(new Error('INVALID_CONTENT_STRATEGY_KIND'), { code: 'INVALID_CONTENT_STRATEGY_KIND', status: 400 });
  }
  function strategySlug(name) {
    return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'content-strategy';
  }
  async function saveContentStrategyRecord(kind, id, input, adminId) {
    const config = strategyTable(kind);
    const checked = validateStrategyInput(input, { kind });
    if (!checked.valid) throw Object.assign(new Error('INVALID_CONTENT_STRATEGY'), { code: 'INVALID_CONTENT_STRATEGY', status: 400, fields: checked.errors });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      let recordId = id;
      let slug = strategySlug(checked.record.name);
      if (id !== null && id !== undefined) {
        if (!/^[1-9]\d{0,19}$/.test(String(id))) throw Object.assign(new Error('CONTENT_STRATEGY_NOT_FOUND'), { code: 'CONTENT_STRATEGY_NOT_FOUND', status: 404 });
        const [[existing]] = await selectQuery(c, `SELECT id,slug,archived_at FROM ${config.table} WHERE id=? FOR UPDATE`, [id]);
        if (!existing || existing.archived_at) throw Object.assign(new Error('CONTENT_STRATEGY_NOT_FOUND'), { code: 'CONTENT_STRATEGY_NOT_FOUND', status: 404 });
        recordId = existing.id;
        slug = existing.slug;
        await c.execute(`UPDATE ${config.table} SET name=?,${config.detail}=?,active=? WHERE id=?`, [checked.record.name, checked.record[config.detail], checked.record.active, recordId]);
      } else {
        const [insert] = await mutationQuery(c, `INSERT INTO ${config.table} (slug,name,${config.detail},active) VALUES (?,?,?,?)`, [slug, checked.record.name, checked.record[config.detail], checked.record.active]);
        recordId = insert.insertId;
      }
      await audit(c, adminId, `${config.event}.${id == null ? 'created' : 'updated'}`, { id: String(recordId), slug, active: checked.record.active });
      await c.commit();
      return { id: String(recordId), slug, ...checked.record };
    } catch (error) {
      await c.rollback();
      if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('CONTENT_STRATEGY_DUPLICATE'), { code: 'CONTENT_STRATEGY_DUPLICATE', status: 409 });
      throw error;
    } finally { c.release(); }
  }
  async function setContentStrategyRecordActive(kind, id, active, adminId) {
    const config = strategyTable(kind);
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || typeof active !== 'boolean') throw Object.assign(new Error('INVALID_CONTENT_STRATEGY'), { code: 'INVALID_CONTENT_STRATEGY', status: 400 });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [updated] = await mutationQuery(c, `UPDATE ${config.table} SET active=? WHERE id=? AND archived_at IS NULL`, [active, id]);
      if (!updated.affectedRows) throw Object.assign(new Error('CONTENT_STRATEGY_NOT_FOUND'), { code: 'CONTENT_STRATEGY_NOT_FOUND', status: 404 });
      await audit(c, adminId, `${config.event}.${active ? 'activated' : 'deactivated'}`, { id: String(id) });
      await c.commit();
      return true;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function archiveContentStrategyRecord(kind, id, adminId) {
    const config = strategyTable(kind);
    if (!/^[1-9]\d{0,19}$/.test(String(id))) throw Object.assign(new Error('CONTENT_STRATEGY_NOT_FOUND'), { code: 'CONTENT_STRATEGY_NOT_FOUND', status: 404 });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [updated] = await mutationQuery(c, `UPDATE ${config.table} SET active=FALSE,archived_at=COALESCE(archived_at,UTC_TIMESTAMP(3)) WHERE id=? AND archived_at IS NULL`, [id]);
      if (!updated.affectedRows) throw Object.assign(new Error('CONTENT_STRATEGY_NOT_FOUND'), { code: 'CONTENT_STRATEGY_NOT_FOUND', status: 404 });
      await audit(c, adminId, `${config.event}.archived`, { id: String(id) });
      await c.commit();
      return true;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function setContentStrategyEnabled(enabled, adminId) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('INVALID_CONTENT_STRATEGY'), { code: 'INVALID_CONTENT_STRATEGY', status: 400 });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[settings]] = await selectQuery(c, 'SELECT automation_enabled FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      if (settings?.automation_enabled) throw Object.assign(new Error('AUTOMATION_MUST_BE_PAUSED'), { code: 'AUTOMATION_MUST_BE_PAUSED', status: 409 });
      if (enabled) {
        const readiness = await getStrategyStatus(c);
        if (readiness.categoryCount < 1 || readiness.styleCount < 1 || readiness.orderUncertain) {
          throw Object.assign(new Error(readiness.reasonCode || 'CONTENT_STRATEGY_NOT_READY'), { code: readiness.reasonCode || 'CONTENT_STRATEGY_NOT_READY', status: 409 });
        }
      }
      await c.execute('UPDATE content_strategy_settings SET enabled=?,enabled_by=?,enabled_at=IF(?,UTC_TIMESTAMP(3),enabled_at) WHERE id=1', [enabled, enabled ? adminId : null, enabled]);
      await audit(c, adminId, enabled ? 'content_strategy.enabled' : 'content_strategy.disabled', {});
      await c.commit();
      return { enabled };
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function saveCategoryProposalSettings({ enabled, intervalDays }, adminId) {
    if (typeof enabled !== 'boolean' || !Number.isInteger(intervalDays) || intervalDays < 30 || intervalDays > 365) {
      throw Object.assign(new Error('INVALID_PROPOSAL_SETTINGS'), { code: 'INVALID_PROPOSAL_SETTINGS', status: 400 });
    }
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[existing]] = await selectQuery(c, 'SELECT enabled FROM category_proposal_settings WHERE id=1 FOR UPDATE', [], 'query');
      if (enabled) {
        const nextRunAt = existing?.enabled ? undefined : new Date(Date.now() + intervalDays * 86_400_000);
        if (nextRunAt) await c.execute('UPDATE category_proposal_settings SET enabled=TRUE,interval_days=?,next_run_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=1', [intervalDays, nextRunAt]);
        else await c.execute('UPDATE category_proposal_settings SET enabled=TRUE,interval_days=?,next_run_at=COALESCE(next_run_at,?) WHERE id=1', [intervalDays, new Date(Date.now() + intervalDays * 86_400_000)]);
      } else {
        await c.execute('UPDATE category_proposal_settings SET enabled=FALSE,interval_days=?,next_run_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=1', [intervalDays]);
      }
      await audit(c, adminId, 'category_proposal_settings.updated', { enabled, intervalDays });
      await c.commit();
      return true;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function claimCategoryProposalRun({ now = new Date(), leaseMs = 120_000 } = {}) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[config]] = await selectQuery(c, 'SELECT enabled,interval_days,next_run_at,lease_token,lease_until FROM category_proposal_settings WHERE id=1 FOR UPDATE', [], 'query');
      const current = now instanceof Date ? now : new Date(now);
      if (!config?.enabled || !config.next_run_at || new Date(config.next_run_at) > current
        || config.lease_until && new Date(config.lease_until) > current) {
        await c.commit(); return null;
      }
      const [[state]] = await selectQuery(c, 'SELECT business_knowledge_json,business_knowledge_approved FROM settings WHERE id=1');
      if (!state?.business_knowledge_approved) { await c.commit(); return null; }
      const [[integration]] = await selectQuery(c, 'SELECT status,model FROM integration_config WHERE id=1');
      if (integration?.status !== 'ACTIVE' || !integration.model) { await c.commit(); return null; }
      const [categories] = await selectQuery(c, 'SELECT LEFT(name,120) AS name,LEFT(guidance,200) AS guidance FROM content_categories WHERE active=TRUE AND archived_at IS NULL ORDER BY id LIMIT 30');
      const token = randomUUID();
      const nextRunAt = new Date(current.getTime() + Number(config.interval_days) * 86_400_000);
      await c.execute(`UPDATE category_proposal_settings SET lease_token=?,lease_until=?,last_started_at=?,next_run_at=?,last_error_code=NULL WHERE id=1`, [token, new Date(current.getTime() + leaseMs), current, nextRunAt]);
      await c.commit();
      return { token, categories, knowledge: json(state.business_knowledge_json, {}), intervalDays: Number(config.interval_days), model: integration.model };
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function finishCategoryProposalRun({ token, proposals = [], errorCode = null, now = new Date() }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[config]] = await selectQuery(c, 'SELECT lease_token FROM category_proposal_settings WHERE id=1 FOR UPDATE', [], 'query');
      if (!config || config.lease_token !== token) { await c.commit(); return false; }
      if (!errorCode) {
        const [existing] = await selectQuery(c, `SELECT name FROM content_categories UNION ALL SELECT name FROM category_proposals WHERE status='pending'`);
        const names = new Set(existing.map((item) => String(item.name).trim().toLocaleLowerCase('id')));
        for (const proposal of proposals.slice(0, 3)) {
          const checked = validateStrategyInput(proposal, { kind: 'category' });
          if (!checked.valid || names.has(checked.record.name.toLocaleLowerCase('id'))) continue;
          names.add(checked.record.name.toLocaleLowerCase('id'));
          await c.execute("INSERT INTO category_proposals (name,guidance,status,source) VALUES (?,?,'pending','openrouter')", [checked.record.name, checked.record.guidance]);
        }
      }
      await c.execute('UPDATE category_proposal_settings SET lease_token=NULL,lease_until=NULL,last_completed_at=?,last_error_code=? WHERE id=1 AND lease_token=?', [now, errorCode, token]);
      await audit(c, null, errorCode ? 'category_proposal.job_failed' : 'category_proposal.job_completed', { errorCode, count: errorCode ? 0 : Math.min(3, proposals.length) });
      await c.commit();
      return true;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function reviewCategoryProposal(id, decision, adminId) {
    if (!/^[1-9]\d{0,19}$/.test(String(id)) || !['approve', 'reject'].includes(decision)) throw Object.assign(new Error('INVALID_CATEGORY_PROPOSAL'), { code: 'INVALID_CATEGORY_PROPOSAL', status: 400 });
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[proposal]] = await selectQuery(c, 'SELECT id,name,guidance,status FROM category_proposals WHERE id=? FOR UPDATE', [id]);
      if (!proposal) throw Object.assign(new Error('CATEGORY_PROPOSAL_NOT_FOUND'), { code: 'CATEGORY_PROPOSAL_NOT_FOUND', status: 404 });
      if (proposal.status !== 'pending') throw Object.assign(new Error('CATEGORY_PROPOSAL_ALREADY_REVIEWED'), { code: 'CATEGORY_PROPOSAL_ALREADY_REVIEWED', status: 409 });
      if (decision === 'approve') {
        const slug = strategySlug(proposal.name);
        const [[duplicate]] = await selectQuery(c, 'SELECT id FROM content_categories WHERE slug=? OR LOWER(name)=LOWER(?) LIMIT 1', [slug, proposal.name]);
        if (duplicate) throw Object.assign(new Error('CONTENT_STRATEGY_DUPLICATE'), { code: 'CONTENT_STRATEGY_DUPLICATE', status: 409 });
        const [insert] = await mutationQuery(c, 'INSERT INTO content_categories (slug,name,guidance,active) VALUES (?,?,?,TRUE)', [slug, proposal.name, proposal.guidance]);
        await c.execute("UPDATE category_proposals SET status='approved',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=? AND status='pending'", [adminId, id]);
        await audit(c, adminId, 'category_proposal.approved', { proposalId: String(id), categoryId: String(insert.insertId) });
      } else {
        await c.execute("UPDATE category_proposals SET status='rejected',reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3) WHERE id=? AND status='pending'", [adminId, id]);
        await audit(c, adminId, 'category_proposal.rejected', { proposalId: String(id) });
      }
      await c.commit();
      return true;
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function saveSettings(settings, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const checkedSettings = validateNdiSettings({ schedule: settings.schedule || {}, hashtags: settings.hashtags || [] });
      if (!checkedSettings.valid) throw Object.assign(new Error('INVALID_SETTINGS'), { code: 'INVALID_SETTINGS' });
      const safeSettings = { schedule: checkedSettings.settings.schedule, hashtags: checkedSettings.settings.hashtags };
      const [[existingRow]] = await selectQuery(connection, 'SELECT settings_json FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const existing = json(existingRow?.settings_json);
      for (const key of ['brand','guardrails','gameWhitelist','priceMode','trackedLinks']) delete existing[key];
      const scheduleKey = (schedule) => {
        const checked = validateNdiSettings({ schedule: schedule || {}, hashtags: [] });
        return JSON.stringify(checked.valid ? checked.settings.schedule : normalizeScheduleInterval(schedule || {}));
      };
      if (scheduleKey(existing.schedule) !== scheduleKey(safeSettings.schedule)) delete existing.nextSlotAt;
      const nextSettings = { ...existing, ...safeSettings };
      await connection.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(nextSettings)]);
      await audit(connection, adminId, 'settings.updated', {});
      await connection.commit(); return await getSettings();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function saveKnowledge(knowledge, adminId) {
    const checked = validateBusinessKnowledge(knowledge);
    if (!checked.valid) throw Object.assign(new Error('INVALID_KNOWLEDGE'), { code: 'INVALID_KNOWLEDGE', fields: checked.errors });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await selectQuery(connection, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[versionRow]] = await selectQuery(connection, 'SELECT business_knowledge_version FROM settings WHERE id=1', [], 'query');
      const nextVersion = Number(versionRow?.business_knowledge_version || 1) + 1;
      await connection.execute('UPDATE settings SET business_knowledge_json=?,business_knowledge_approved=TRUE,business_knowledge_version=? WHERE id=1', [JSON.stringify(checked.knowledge), nextVersion]);
      await audit(connection, adminId, 'ndi_knowledge.approved', { serviceCount: checked.knowledge.services.length, knowledgeVersion: nextVersion });
      await connection.commit(); return { knowledge: checked.knowledge, approved: true, knowledgeVersion: nextVersion };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function listFacts() {
    const [rows] = await selectQuery(pool, 'SELECT service, summary_json, active, updated_at FROM service_facts ORDER BY service');
    return Object.fromEntries(rows.map((row) => [row.service, { summary: json(row.summary_json), active: Boolean(row.active), updatedAt: row.updated_at }]));
  }
  async function saveFact(service, fact, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO service_facts (service,summary_json,active) VALUES (?,?,?) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json), active=VALUES(active), updated_at=UTC_TIMESTAMP(3)', [service, JSON.stringify(fact.summary), Boolean(fact.active)]);
      await audit(connection, adminId, 'fact.updated', { service }); await connection.commit();
      const facts = await listFacts(); return facts[service];
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function getAdminByEmail(email) {
    const [rows] = await selectQuery(pool, 'SELECT id,email,password_hash,active FROM admins WHERE email=? LIMIT 1', [email]);
    const row = rows[0]; return row && { id: row.id, email: row.email, passwordHash: row.password_hash, active: Boolean(row.active) };
  }
  async function getLoginAttemptCounts({ email, ip, now }) {
    if (!validThrottleTime(now)) throw Object.assign(new TypeError('now must be a valid date'), { code: 'INVALID_LOGIN_THROTTLE_TIME' });
    const keys = loginThrottleKeys(email, ip);
    const conditions = keys.map(() => '(scope=? AND subject_hash=?)').join(' OR ');
    const values = keys.flatMap(({ scope, subjectHash }) => [scope, subjectHash]);
    values.push(now);
    const [rows] = await selectQuery(pool, `SELECT scope,attempt_count FROM login_attempts WHERE (${conditions}) AND expires_at>?`, values);
    const counts = { pair: 0, account: 0, ip: 0 };
    for (const row of rows) if (Object.hasOwn(counts, row.scope)) counts[row.scope] = Number(row.attempt_count);
    return counts;
  }
  async function reserveLoginAttempt({ email, ip, now, windowMs, limits }) {
    const scopes = ['pair', 'account', 'ip'];
    if (!validThrottleTime(now) || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000) {
      throw Object.assign(new TypeError('invalid login throttle window'), { code: 'INVALID_LOGIN_THROTTLE_WINDOW' });
    }
    if (!limits || scopes.some((scope) => !Number.isSafeInteger(limits[scope]) || limits[scope] < 1 || limits[scope] > 10_000)) {
      throw Object.assign(new TypeError('invalid login throttle limits'), { code: 'INVALID_LOGIN_THROTTLE_LIMITS' });
    }
    await pool.execute('DELETE FROM login_attempts WHERE expires_at<=? LIMIT 1000', [now]);
    const expiresAt = new Date(now.getTime() + windowMs);
    const keys = loginThrottleKeys(email, ip);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const { scope, subjectHash } of keys) {
        await connection.execute(
          'INSERT INTO login_attempts (scope,subject_hash,attempt_count,window_started_at,expires_at) VALUES (?,?,1,?,?) ON DUPLICATE KEY UPDATE attempt_count=IF(expires_at<=?,1,attempt_count+1),window_started_at=IF(expires_at<=?,?,window_started_at),expires_at=IF(expires_at<=?,?,expires_at)',
          [scope, subjectHash, now, expiresAt, now, now, now, now, expiresAt],
        );
      }
      const conditions = keys.map(() => '(scope=? AND subject_hash=?)').join(' OR ');
      const values = keys.flatMap(({ scope, subjectHash }) => [scope, subjectHash]);
      values.push(now);
      const [rows] = await selectQuery(connection, `SELECT scope,subject_hash,attempt_count,window_started_at,expires_at FROM login_attempts WHERE (${conditions}) AND expires_at>? FOR UPDATE`,
        values,
      );
      const counts = { pair: 0, account: 0, ip: 0 };
      const reservations = [];
      const retryDelays = [];
      for (const row of rows) {
        if (!Object.hasOwn(counts, row.scope)) continue;
        counts[row.scope] = Number(row.attempt_count);
        reservations.push({ scope: row.scope, subjectHash: row.subject_hash, windowStartedAt: row.window_started_at });
        if (counts[row.scope] > limits[row.scope]) {
          const expiresAtMs = row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
          if (Number.isFinite(expiresAtMs)) retryDelays.push(Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000)));
        }
      }
      if (reservations.length !== scopes.length) throw Object.assign(new Error('LOGIN_THROTTLE_STORAGE_INCOMPLETE'), { code: 'LOGIN_THROTTLE_STORAGE_INCOMPLETE' });
      if (scopes.some((scope) => counts[scope] > limits[scope])) {
        await connection.rollback();
        return { allowed: false, counts, retryAfterSeconds: Math.max(1, ...retryDelays) };
      }
      await connection.commit();
      return { allowed: true, counts, reservation: { keys: reservations } };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async function releaseLoginReservation(reservation, now = new Date()) {
    const scopes = ['pair', 'account', 'ip'];
    if (!validThrottleTime(now) || !Array.isArray(reservation?.keys) || reservation.keys.length !== scopes.length
      || scopes.some((scope) => !reservation.keys.some((key) => key.scope === scope
        && /^[a-f0-9]{64}$/.test(key.subjectHash) && validThrottleTime(key.windowStartedAt)))) {
      throw Object.assign(new TypeError('invalid login reservation'), { code: 'INVALID_LOGIN_RESERVATION' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const { scope, subjectHash, windowStartedAt } of reservation.keys) {
        await connection.execute(
          'UPDATE login_attempts SET attempt_count=GREATEST(attempt_count-1,0) WHERE scope=? AND subject_hash=? AND window_started_at=? AND expires_at>?',
          [scope, subjectHash, windowStartedAt, now],
        );
        await connection.execute(
          'DELETE FROM login_attempts WHERE scope=? AND subject_hash=? AND window_started_at=? AND attempt_count=0',
          [scope, subjectHash, windowStartedAt],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async function listAdmins() {
    const [rows] = await selectQuery(pool, 'SELECT id,email,active,created_at FROM admins ORDER BY created_at,id');
    return rows.map((row) => ({ id: Number(row.id), email: row.email, active: Boolean(row.active), createdAt: row.created_at }));
  }
  async function createAdmin({ email, passwordHash, actorId }) {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); await selectQuery(conn, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query'); await conn.execute('INSERT INTO admins (email,password_hash,active) VALUES (?,?,TRUE)', [email,passwordHash]); const [rows] = await selectQuery(conn, 'SELECT id,email,active,created_at FROM admins WHERE email=?', [email]); await audit(conn, actorId, 'admin.created', { targetAdminId: Number(rows[0].id), email }); await conn.commit(); return { ...rows[0], id: Number(rows[0].id), active: Boolean(rows[0].active), createdAt: rows[0].created_at }; }
    catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('ADMIN_EXISTS'), { code: 'ADMIN_EXISTS' }); throw error; } finally { conn.release(); }
  }
  async function updateAdmin(id, { email, passwordHash, active }, actorId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await selectQuery(conn, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[target]] = await selectQuery(conn, 'SELECT id,email,active FROM admins WHERE id=? FOR UPDATE', [id]);
      if (!target) { await conn.rollback(); return null; }
      if (active === false && Boolean(target.active)) {
        const [activeAdmins] = await selectQuery(conn, 'SELECT id FROM admins WHERE active=TRUE FOR UPDATE');
        if (activeAdmins.length <= 1) throw Object.assign(new Error('LAST_ADMIN'), { code: 'LAST_ADMIN' });
      }
      const emailChanged = email !== undefined && email !== target.email;
      const passwordChanged = passwordHash !== undefined;
      const activeChanged = active !== undefined && Boolean(target.active) !== active;
      if (!emailChanged && !passwordChanged && !activeChanged) {
        await conn.rollback();
        return { id: Number(target.id), email: target.email, active: Boolean(target.active), credentialsChanged: false };
      }
      const fields = []; const values = [];
      if (emailChanged) { fields.push('email=?'); values.push(email); }
      if (passwordChanged) { fields.push('password_hash=?'); values.push(passwordHash); }
      if (activeChanged) { fields.push('active=?'); values.push(active); }
      values.push(id); await conn.execute(`UPDATE admins SET ${fields.join(',')} WHERE id=?`, values);
      if (emailChanged || passwordChanged || (active === false && activeChanged)) await conn.execute('DELETE FROM sessions WHERE admin_id=?', [id]);
      await audit(conn, actorId, active === false ? 'admin.deactivated' : active === true ? 'admin.reactivated' : 'admin.updated', { targetAdminId: Number(id), emailChanged, passwordReset: passwordChanged });
      const [[updated]] = await selectQuery(conn, 'SELECT id,email,active,created_at FROM admins WHERE id=?', [id]);
      await conn.commit();
      return { id: Number(updated.id), email: updated.email, active: Boolean(updated.active), createdAt: updated.created_at, credentialsChanged: emailChanged || passwordChanged };
    } catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('ADMIN_EXISTS'), { code: 'ADMIN_EXISTS' }); throw error; }
    finally { conn.release(); }
  }
  async function createSession({ tokenHash, adminId, csrfToken, expiresAt }) { await pool.execute('INSERT INTO sessions (token_hash,admin_id,csrf_token,expires_at) VALUES (?,?,?,?)', [tokenHash,adminId,csrfToken,expiresAt]); }
  async function getSession(tokenHash, now = new Date()) {
    const [rows] = await selectQuery(pool, 'SELECT s.csrf_token,s.expires_at,a.id,a.email FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=TRUE LIMIT 1', [tokenHash,now]);
    const row=rows[0]; return row ? { admin: { id: row.id,email:row.email }, csrfToken:row.csrf_token,expiresAt:row.expires_at } : null;
  }
  async function deleteSession(tokenHash) { await pool.execute('DELETE FROM sessions WHERE token_hash=?', [tokenHash]); }
  async function deleteAdminSessions(adminId) { await pool.execute('DELETE FROM sessions WHERE admin_id=?', [adminId]); }
  async function listSlots(limit=100) { const [rows]=await selectQuery(pool, 'SELECT id,scheduled_at,status,pillar,provider_post_id,provider_status,caption,error_code,cancellation_status,fact_bearing,fact_ids,content_strategy_json,reviewed,review_metadata_json,provider_published_at,created_at,completed_at FROM slots ORDER BY scheduled_at DESC LIMIT ?', [Math.max(1,Math.min(1000,Number(limit)||100))]); return rows.map((r)=>({id:r.id,scheduledAt:r.scheduled_at,status:r.status,pillar:r.pillar,providerPostId:r.provider_post_id,providerStatus:r.provider_status,caption:r.caption,errorCode:r.error_code,cancellationStatus:r.cancellation_status,factBearing:Boolean(r.fact_bearing),factIds:json(r.fact_ids,[]),contentStrategy:json(r.content_strategy_json,null),reviewed:Boolean(r.reviewed),reviewMetadata:json(r.review_metadata_json,null),providerPublishedAt:r.provider_published_at,createdAt:r.created_at,completedAt:r.completed_at})); }
  async function listActivity(limit=100) { const [rows]=await selectQuery(pool, 'SELECT event,details_json,created_at FROM activity_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.event,...json(r.details_json),createdAt:r.created_at})); }
  async function healthCheck() { await selectQuery(pool, 'SELECT 1'); return true; }
  async function listAudit(limit=100) { const [rows]=await selectQuery(pool, 'SELECT action,details_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.action,...json(r.details_json),createdAt:r.created_at})); }
  /** @param {{event: string, slotId?: string | null, details?: Record<string, unknown>}} input */
  async function appendActivity({event,slotId,details={}}) { await pool.execute('INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,?,?)', [slotId || null,event,JSON.stringify(details)]); }
  async function setAutomationEnabled(enabled, adminId) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[current]] = await selectQuery(c, 'SELECT settings_json,business_knowledge_json,business_knowledge_approved,automation_enabled FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const settings = json(current?.settings_json);
      if (enabled) {
        const strategy = await getStrategyStatus(c);
        if (!strategy.ready) throw Object.assign(new Error(strategy.reasonCode || 'CONTENT_STRATEGY_NOT_READY'), { code: strategy.reasonCode || 'CONTENT_STRATEGY_NOT_READY', status: 409 });
        const businessSettings = validateNdiSettings({ schedule: settings.schedule || {}, hashtags: settings.hashtags || [], businessKnowledge: json(current?.business_knowledge_json, {}) });
        if (current?.business_knowledge_approved !== 1 && current?.business_knowledge_approved !== true || !businessSettings.valid) {
          throw Object.assign(new Error('BUSINESS_KNOWLEDGE_REVIEW_REQUIRED'), { code: 'BUSINESS_KNOWLEDGE_REVIEW_REQUIRED', status: 409 });
        }
        const [[integration]] = await selectQuery(c, 'SELECT status,profile_id,account_id,model,reviewer_model FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
        if (!hasDistinctModels(integration?.model, integration?.reviewer_model)) {
          throw Object.assign(new Error('REVIEWER_MODEL_REQUIRED'), { code: 'REVIEWER_MODEL_REQUIRED', status: 409 });
        }
        if (integration?.status !== 'ACTIVE' || !integration.profile_id || !integration.account_id || !integration.model
          || settings.profileId !== integration.profile_id || settings.targetAccountId !== integration.account_id) {
          throw Object.assign(new Error('INTEGRATION_NOT_READY'), { code: 'INTEGRATION_NOT_READY', status: 409 });
        }
        const [[unsettled]] = await selectQuery(c, `SELECT id FROM slots
          WHERE (status IN ('publishing','unknown') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')))
          AND (tebar_profile_id IS NULL OR tebar_account_id IS NULL OR (tebar_profile_id=? AND tebar_account_id=?)
            OR (request_payload IS NOT NULL AND (
              COALESCE(JSON_LENGTH(JSON_EXTRACT(request_payload,'$.targets')),0)<>1
              OR JSON_UNQUOTE(JSON_EXTRACT(request_payload,'$.targets[0].account_id')) IS NULL
              OR JSON_UNQUOTE(JSON_EXTRACT(request_payload,'$.targets[0].account_id'))<>tebar_account_id
            )))
          LIMIT 1 FOR UPDATE`, [integration.profile_id, integration.account_id]);
        if (unsettled) throw Object.assign(new Error('RECONCILIATION_REQUIRED'), { code: 'RECONCILIATION_REQUIRED', status: 409 });
        if (await hasProviderHold(c, integration.profile_id, integration.account_id)) throw publicationError('AUTOMATION_PROVIDER_HOLD');
      }
      const changed = Boolean(current?.automation_enabled) !== enabled;
      let firstPostAt = settings.nextSlotAt || null;
      let immediate = false;
      if (enabled && changed) {
        const checked = validateNdiSettings({ schedule: settings.schedule || {}, hashtags: settings.hashtags || [], businessKnowledge: json(current?.business_knowledge_json, {}) });
        if (!checked.valid) throw Object.assign(new Error('INVALID_SETTINGS'), { code: 'INVALID_SETTINGS' });
        const now = new Date();
        firstPostAt = now.toISOString();
        immediate = true;
        settings.schedule = checked.settings.schedule;
        settings.onboardingComplete = true;
        settings.automationSessionId = randomUUID();
        settings.nextSlotAt = firstPostAt;
        settings.activationFirstPostAt = firstPostAt;
        await c.execute("UPDATE slots SET status='canceled',error_code='automation_reactivated',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");
        await c.execute('UPDATE settings SET settings_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify(settings)]);
      } else if (!enabled) {
        await c.execute("UPDATE slots SET status='canceled',error_code='automation_paused',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");
        delete settings.nextSlotAt;
        delete settings.activationFirstPostAt;
        delete settings.automationSessionId;
        firstPostAt = null;
        await c.execute('UPDATE settings SET settings_json=?,automation_enabled=FALSE WHERE id=1', [JSON.stringify(settings)]);
      }
      if (changed) await audit(c, adminId, enabled ? 'automation.enabled' : 'automation.paused', {});
      await c.commit();
      return { changed, firstPostAt, immediate, sessionId: enabled ? settings.automationSessionId : null };
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function setProviderTarget({accountId,profileId}) { const c=await pool.getConnection();try{await c.beginTransaction();const [[row]]=await selectQuery(c, 'SELECT settings_json FROM settings WHERE id=1 FOR UPDATE', [], 'query');const settings=json(row?.settings_json);const changed=(settings.targetAccountId||null)!==(accountId||null)||(settings.profileId||null)!==(profileId||null);settings.targetAccountId=accountId||null;settings.profileId=profileId||null;if(changed){settings.onboardingComplete=false;delete settings.nextSlotAt;delete settings.activationFirstPostAt;delete settings.automationSessionId;await c.execute("UPDATE slots SET status='canceled',error_code='account_reconfigured',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");}await c.execute('UPDATE settings SET settings_json=?,automation_enabled=IF(?,FALSE,automation_enabled) WHERE id=1',[JSON.stringify(settings),changed]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();} }
  async function ensureDueSlot({scheduledAt,sessionId}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]]=await selectQuery(c, 'SELECT settings_json FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const settings=json(state?.settings_json);
      const [[integration]]=await selectQuery(c, 'SELECT version,status,profile_id,account_id,model,reviewer_model FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
      if(integration?.status!=='ACTIVE'||!integration.profile_id||!integration.account_id||!hasDistinctModels(integration.model,integration.reviewer_model)||settings.profileId!==integration.profile_id||settings.targetAccountId!==integration.account_id){await c.rollback();return null;}
      if(sessionId===undefined)sessionId=settings.automationSessionId||null;
      const id=randomUUID();
      await c.execute("INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,'pending',?,?,?)",[id,scheduledAt,sessionId,integration.profile_id,integration.account_id,integration.version]);
      const [rows]=await selectQuery(c, 'SELECT * FROM slots WHERE scheduled_at=? AND automation_session_id <=> ?',[scheduledAt,sessionId]);
      await c.commit();return rows[0]||null;
    }catch(error){await c.rollback();throw error;}finally{c.release();}
  }
  async function claimDueSlot({ now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]] = await selectQuery(c, 'SELECT automation_enabled,settings_json,business_knowledge_json,business_knowledge_approved,business_knowledge_version FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[integration]] = await selectQuery(c, 'SELECT version,status,profile_id,account_id,model,reviewer_model FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
      const settings = json(state?.settings_json);
      const knowledge = json(state?.business_knowledge_json, {});
      const validated = validateNdiSettings({ schedule: settings.schedule || {}, hashtags: settings.hashtags || [], businessKnowledge: knowledge });
      const strategyStatus = await getStrategyStatus(c);
      const sessionId = settings.automationSessionId;
      if (state?.automation_enabled && integration?.status === 'ACTIVE' && !hasDistinctModels(integration.model, integration.reviewer_model)) {
        await c.commit();
        return { blocked: 'REVIEWER_MODEL_REQUIRED' };
      }
      if (!state?.automation_enabled || state.business_knowledge_approved !== 1 && state.business_knowledge_approved !== true
        || !strategyStatus.ready || !sessionId || settings.onboardingComplete !== true || !settings.targetAccountId || !validated.valid
        || integration?.status !== 'ACTIVE' || !hasDistinctModels(integration.model, integration.reviewer_model)
        || settings.profileId !== integration.profile_id || settings.targetAccountId !== integration.account_id) {
        if (state?.automation_enabled && !strategyStatus.ready) { await c.commit(); return { blocked: strategyStatus.reasonCode }; }
        await c.rollback();
        return null;
      }
      if (await hasProviderHold(c, integration.profile_id, integration.account_id)) { await c.commit(); return null; }
      const [[inFlight]] = await selectQuery(c, "SELECT id FROM slots WHERE automation_session_id=? AND (status IN ('generating','publishing') OR (status='ready' AND claimed_at>=DATE_SUB(?,INTERVAL 10 MINUTE))) LIMIT 1 FOR UPDATE", [sessionId, now]);
      if (inFlight) { await c.commit(); return null; }
      const [rows] = await selectQuery(c, "SELECT id,scheduled_at,status,request_payload,idempotency_key,caption,pillar,fact_bearing,fact_ids,fact_versions,content_safety_hash,cta_url,content_category_id,content_style_id,content_strategy_json,automation_session_id,tebar_profile_id,tebar_account_id,tebar_config_version,model_config_version,openrouter_model,openrouter_reviewer_model,business_knowledge_snapshot_json,business_knowledge_snapshot_version,generation_settings_snapshot_json,reviewed,review_metadata_json FROM slots WHERE automation_session_id=? AND ((status='pending' AND scheduled_at<=?) OR (status='ready' AND scheduled_at<=? AND (claimed_at IS NULL OR claimed_at<DATE_SUB(?,INTERVAL 10 MINUTE)))) ORDER BY scheduled_at LIMIT 1 FOR UPDATE", [sessionId, now, now, now]);
      if (!rows.length) { await c.commit(); return null; }
      const slot = rows[0];
      let strategySnapshot = json(slot.content_strategy_json, null);
      if (slot.status === 'ready' && (!strategySnapshot?.category?.id || !strategySnapshot?.style?.id)) {
        await c.execute("UPDATE slots SET status='canceled',error_code='content_strategy_snapshot_missing',completed_at=UTC_TIMESTAMP(3) WHERE id=? AND status='ready'", [slot.id]);
        await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'slot_not_published',?)", [slot.id, JSON.stringify({ code: 'content_strategy_snapshot_missing' })]);
        await c.commit();
        return { blocked: 'CONTENT_STRATEGY_SNAPSHOT_MISSING' };
      }
      if (!slot.tebar_profile_id || !slot.tebar_account_id || slot.tebar_profile_id !== integration.profile_id || slot.tebar_account_id !== integration.account_id) {
        await c.execute("UPDATE slots SET status='canceled',error_code='target_snapshot_missing',completed_at=UTC_TIMESTAMP(3) WHERE id=? AND status IN ('pending','ready')", [slot.id]);
        await c.commit();
        return null;
      }
      const [[last]] = await selectQuery(c, "SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId, slot.id]);
      const cadenceMs = validated.settings.schedule.intervalMinutes * 60_000;
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < cadenceMs) {
        // Keep this slot due until the publication-time cooldown elapses.
        await c.commit();
        return null;
      }
      const activationFirstPostAt = settings.activationFirstPostAt ? new Date(settings.activationFirstPostAt).getTime() : NaN;
      if (Number.isFinite(activationFirstPostAt) && activationFirstPostAt === new Date(slot.scheduled_at).getTime()) {
        delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(settings)]);
      }
      if (slot.status === 'pending') {
        const [categories] = await selectQuery(c, 'SELECT id,slug,name,guidance,active,archived_at FROM content_categories WHERE active=TRUE AND archived_at IS NULL ORDER BY id FOR UPDATE', [], 'query');
        const [styles] = await selectQuery(c, 'SELECT id,slug,name,instructions,active,archived_at FROM content_styles WHERE active=TRUE AND archived_at IS NULL ORDER BY id FOR UPDATE', [], 'query');
        const eligible = categories.length > 1 && strategyStatus.latestCategoryId
          ? categories.filter((entry) => String(entry.id) !== strategyStatus.latestCategoryId) : categories;
        const selectedCategory = selectUniform(eligible);
        const selectedStyle = selectUniform(styles);
        if (!selectedCategory || !selectedStyle) { await c.commit(); return { blocked: categories.length ? 'CONTENT_STYLES_EMPTY' : 'CONTENT_CATEGORIES_EMPTY' }; }
        strategySnapshot = {
          category: { id: String(selectedCategory.id), slug: selectedCategory.slug, name: selectedCategory.name, guidance: selectedCategory.guidance },
          style: { id: String(selectedStyle.id), slug: selectedStyle.slug, name: selectedStyle.name, instructions: selectedStyle.instructions },
        };
        await c.execute('INSERT INTO generation_slot_claims (slot_id,claimed_at) VALUES (?,?)', [slot.id, now]);
        await c.execute("UPDATE slots SET status='generating',claimed_at=?,cta_url=?,openrouter_model=?,openrouter_reviewer_model=?,model_config_version=?,content_category_id=?,content_style_id=?,content_strategy_json=?,business_knowledge_snapshot_json=?,business_knowledge_snapshot_version=?,generation_settings_snapshot_json=? WHERE id=? AND status='pending'", [now, validated.settings.businessKnowledge.ctaUrl, integration.model, integration.reviewer_model, integration.version, selectedCategory.id, selectedStyle.id, JSON.stringify(strategySnapshot), JSON.stringify(validated.settings.businessKnowledge), Number(state.business_knowledge_version || 1), JSON.stringify(validated.settings), slot.id]);
      }
      else await c.execute("UPDATE slots SET claimed_at=? WHERE id=? AND status='ready'", [now, slot.id]);
      await c.commit();
      const generationSettings = slot.status === 'pending' ? validated.settings : json(slot.generation_settings_snapshot_json, validated.settings);
      const knowledgeSnapshot = slot.status === 'pending' ? validated.settings.businessKnowledge : json(slot.business_knowledge_snapshot_json, generationSettings.businessKnowledge || validated.settings.businessKnowledge);
      return { id: slot.id, automationSessionId: slot.automation_session_id, scheduledAt: slot.scheduled_at, status: slot.status,
        requestPayload: json(slot.request_payload), idempotencyKey: slot.idempotency_key, caption: slot.caption, pillar: slot.pillar,
        factBearing: Boolean(slot.fact_bearing), factIds: json(slot.fact_ids, []), factVersions: json(slot.fact_versions, []),
        contentSafetyHash: slot.content_safety_hash, contentStrategy: strategySnapshot, categoryId: strategySnapshot.category.id,
        styleId: strategySnapshot.style.id, ctaUrl: slot.status === 'pending' ? validated.settings.businessKnowledge.ctaUrl : slot.cta_url,
        profileId: slot.tebar_profile_id, accountId: slot.tebar_account_id, configVersion: slot.tebar_config_version,
        model: slot.status === 'pending' ? integration.model : slot.openrouter_model,
        reviewerModel: slot.status === 'pending' ? integration.reviewer_model : slot.openrouter_reviewer_model,
        modelVersion: slot.status === 'pending' ? integration.version : slot.model_config_version,
        businessKnowledge: knowledgeSnapshot,
        businessKnowledgeVersion: slot.status === 'pending' ? Number(state.business_knowledge_version || 1) : slot.business_knowledge_snapshot_version,
        generationSettings, reviewed: Boolean(slot.reviewed), reviewMetadata: json(slot.review_metadata_json, null) };
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  /** @param {{now?: Date, timezone?: string, schedule?: Record<string, unknown>}} [options] */
  async function ensureNextDueSlot({now=new Date(),timezone='Asia/Jakarta',schedule}={}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[row]]=await selectQuery(c, 'SELECT automation_enabled,settings_json,business_knowledge_json,business_knowledge_approved FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[integration]]=await selectQuery(c, 'SELECT version,status,profile_id,account_id,model,reviewer_model FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
      const settings=json(row?.settings_json);const knowledge=json(row?.business_knowledge_json,{});
      const sessionId=settings.automationSessionId;
      const savedSchedule=settings.schedule||schedule||{};
      const checked=validateNdiSettings({schedule:savedSchedule,hashtags:settings.hashtags||[],businessKnowledge:knowledge});
      if(!row?.automation_enabled||row.business_knowledge_approved!==1&&row.business_knowledge_approved!==true||!sessionId||settings.onboardingComplete!==true||!settings.targetAccountId||!checked.valid){await c.commit();return {slot:null,created:false,skippedCount:0};}
      if(!hasDistinctModels(integration?.model,integration?.reviewer_model)){await c.commit();return {slot:null,created:false,skippedCount:0,blocked:'REVIEWER_MODEL_REQUIRED'};}
      if(integration?.status!=='ACTIVE'||settings.profileId!==integration.profile_id||settings.targetAccountId!==integration.account_id){await c.commit();return {slot:null,created:false,skippedCount:0};}
      if(await hasProviderHold(c,integration.profile_id,integration.account_id)){await c.commit();return {slot:null,created:false,skippedCount:0,held:true};}
      const scheduleChanged=JSON.stringify(settings.schedule||{})!==JSON.stringify(checked.settings.schedule);
      settings.schedule=checked.settings.schedule;
      if(scheduleChanged)await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      const zone=savedSchedule.timezone||timezone;
      const intervalMinutes=checked.settings.schedule.intervalMinutes;
      const addInterval=(value)=>{
        const result=value.plus({minutes:intervalMinutes});
        if(!result.isValid)throw Object.assign(new Error('INVALID_SCHEDULE_TIMESTAMP'),{code:'invalid_schedule_timestamp'});
        return result;
      };
      let activationFirstPostAt=typeof settings.activationFirstPostAt==='string'?DateTime.fromISO(settings.activationFirstPostAt,{zone:'utc'}):null;
      const current=DateTime.fromJSDate(now instanceof Date?now:new Date(now),{zone:'utc'});
      if(!current.isValid){await c.rollback();return {slot:null,created:false,skippedCount:0};}
      const [staleGenerations]=await selectQuery(c, "SELECT id FROM slots WHERE automation_session_id=? AND status='generating' AND claimed_at < DATE_SUB(?, INTERVAL 10 MINUTE) FOR UPDATE",[sessionId,current.toJSDate()]);
      for(const stale of staleGenerations){
        await c.execute("UPDATE generation_attempts SET state='unknown',failure_codes=JSON_ARRAY_APPEND(failure_codes,'$','WORKER_INTERRUPTED'),completed_at=COALESCE(completed_at,?) WHERE slot_id=? AND state IN ('reserved','generating','validating')",[current.toJSDate(),stale.id]);
        await c.execute("UPDATE slots SET status='failed',error_code='stale_generation',completed_at=? WHERE id=? AND automation_session_id=? AND status='generating'",[current.toJSDate(),stale.id,sessionId]);
        await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'ai_generation_failed',?)",[stale.id,JSON.stringify({code:'generation_failed',reason:'stale_generation',attempts:0})]);
      }
      const failedSlotDetails=staleGenerations.map((slot)=>({id:slot.id,diagnosticCode:'stale_generation'}));
      const failedSlotIds=failedSlotDetails.map((slot)=>slot.id);
      const [[lastPost]]=await selectQuery(c, "SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",[sessionId]);
      let skippedCount=0;
      const [[pendingSlot]]=await selectQuery(c, "SELECT id,scheduled_at,status,automation_session_id FROM slots WHERE automation_session_id=? AND status='pending' ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[sessionId]);
      if(pendingSlot){
        let pendingAt=DateTime.fromJSDate(new Date(pendingSlot.scheduled_at),{zone:'utc'});
        const isActivationFirstSlot=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===pendingAt.toMillis();
        if(lastPost?.last_post_at){
          const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
          if(lastAt.isValid){
            const earliest=addInterval(lastAt);
            if(earliest>pendingAt){
              pendingAt=earliest;
              for(let i=0;i<100;i++){
                const scheduledAt=pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
                const [[conflict]]=await selectQuery(c, 'SELECT id FROM slots WHERE automation_session_id=? AND scheduled_at=? AND id<>? LIMIT 1 FOR UPDATE',[sessionId,scheduledAt,pendingSlot.id]);
                if(!conflict)break;
                pendingAt=addInterval(pendingAt);
                if(i===99)throw Object.assign(new Error('SCHEDULE_SLOT_CONFLICT'),{code:'schedule_slot_conflict'});
              }
              await c.execute('UPDATE slots SET scheduled_at=? WHERE id=? AND automation_session_id=?',[pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS'),pendingSlot.id,sessionId]);
            }
          }
        }
        if(!settings.nextSlotAt){settings.nextSlotAt=addInterval(pendingAt).toUTC().toISO();await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);}
        if(pendingAt>current){
          await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};
        }
        const active=isInActiveWindow(pendingAt.toJSDate(),{...checked.settings.schedule,timezone:zone});
        if(isActivationFirstSlot||(active&&isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone})&&current.toMillis()-pendingAt.toMillis()<=15*60*1000)){await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount:0,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};}
        await c.execute("UPDATE slots SET status='skipped',error_code=?,completed_at=? WHERE id=? AND automation_session_id=?",[active?'missed_slot':'outside_active_window',current.toJSDate(),pendingSlot.id,sessionId]);skippedCount++;
        if(isActivationFirstSlot){delete settings.activationFirstPostAt;activationFirstPostAt=null;await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);}
      }
      let due=settings.nextSlotAt?DateTime.fromISO(settings.nextSlotAt,{zone:'utc'}):addInterval(current);
      if(!due.isValid)due=addInterval(current);
      let isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
      if(lastPost?.last_post_at){
        const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
        if(lastAt.isValid){const earliest=addInterval(lastAt);if(earliest>due){due=earliest;isActivationFirstDue=false;}}
      }
      for(let i=0;i<100;i++){
        isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
        const scheduledAt=due.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
        const active=isInActiveWindow(due.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const lateBy=current.toMillis()-due.toMillis();
        const stale=lateBy>15*60*1000;
        const activeNow=isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const status=isActivationFirstDue||active&&(due>current||activeNow)&&!stale?'pending':'skipped';
        const [insert]=await mutationQuery(c, 'INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status,error_code,completed_at,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,?,?,?,?,?,?)',[randomUUID(),scheduledAt,sessionId,status,status==='skipped'?(active?'missed_slot':'outside_active_window'):null,status==='skipped'?current.toJSDate():null,integration.profile_id,integration.account_id,integration.version]);
        skippedCount+=status==='skipped'&&insert.affectedRows===1?1:0;
        const [[existing]]=await selectQuery(c, 'SELECT id,status,scheduled_at FROM slots WHERE automation_session_id=? AND scheduled_at=?',[sessionId,scheduledAt]);
        due=addInterval(due);
        settings.nextSlotAt=due.toUTC().toISO();
        if(isActivationFirstDue&&status!=='pending')delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
        if(status==='pending'){await c.commit();return {slot:{id:existing.id,automationSessionId:sessionId,scheduledAt:existing.scheduled_at,status:existing.status},created:insert.affectedRows===1,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};}
      }
      if(settings.nextSlotAt) await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      await c.commit();
      return {slot:null,created:false,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};
    } catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function savePreparedSlot(id,{requestPayload,idempotencyKey,caption,pillar,factBearing=false,factIds=[],factVersions=[],contentSafetyHash=null,reviewed=false,reviewMetadata=null}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]]=await selectQuery(c, 'SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const sessionId=json(state?.settings_json).automationSessionId;
      const [[slot]]=await selectQuery(c, 'SELECT automation_session_id,status,content_category_id,content_style_id,content_strategy_json FROM slots WHERE id=? FOR UPDATE',[id]);
      const strategy = json(slot?.content_strategy_json, null);
      if(!state?.automation_enabled||!sessionId||slot?.automation_session_id!==sessionId||slot?.status!=='generating'
        || !slot.content_category_id || !slot.content_style_id || !strategy?.category?.id || !strategy?.style?.id) { await c.rollback(); return false; }
      const [updated]=await mutationQuery(c, "UPDATE slots SET status='ready',request_payload=?,idempotency_key=?,caption=?,pillar=?,fact_bearing=?,fact_ids=?,fact_versions=?,content_safety_hash=?,reviewed=?,review_metadata_json=? WHERE id=? AND automation_session_id=? AND status='generating'",[JSON.stringify(requestPayload),idempotencyKey,caption,pillar,Boolean(factBearing),JSON.stringify(factIds),JSON.stringify(factVersions),contentSafetyHash,Boolean(reviewed),reviewed ? JSON.stringify(reviewMetadata || {}) : null,id,sessionId]);
      await c.commit();
      return updated.affectedRows===1;
    } catch(error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function saveReviewAttempts(slotId, attempts = []) {
    if (!Array.isArray(attempts) || attempts.length > 8) throw Object.assign(new Error('INVALID_REVIEW_ATTEMPTS'), { code: 'INVALID_REVIEW_ATTEMPTS' });
    if (!attempts.length) return;
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[slot]] = await selectQuery(c, "SELECT status FROM slots WHERE id=? FOR UPDATE", [slotId]);
      if (!slot || slot.status !== 'generating') throw Object.assign(new Error('REVIEW_SLOT_NOT_GENERATING'), { code: 'REVIEW_SLOT_NOT_GENERATING' });
      for (const [index, attempt] of attempts.entries()) {
        const decision = ['PASS','REVISE','REJECT','ERROR'].includes(attempt?.decision) ? attempt.decision : 'ERROR';
        const rationaleCode = typeof attempt?.rationaleCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(attempt.rationaleCode) ? attempt.rationaleCode : null;
        const draft = typeof attempt?.draft === 'string' ? attempt.draft.normalize('NFKC').slice(0, 5000)
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email disamarkan]')
          .replace(/\+?\d[\d ().-]{7,}\d/gu, '[nomor disamarkan]')
          .replace(/\b(?:sk-or-v1-|sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/giu, '[credential disamarkan]') : null;
        const violations = Array.isArray(attempt?.violations) ? attempt.violations.slice(0, 30).flatMap((item) => {
          if (!/^[A-Z0-9_]{1,64}$/.test(String(item?.code || '')) || !/^[a-z.]{1,80}$/.test(String(item?.path || ''))
            || !['repairable_content','nonrepairable_configuration_system'].includes(item?.repairability)) return [];
          return [{ code: item.code, path: item.path, repairability: item.repairability }];
        }) : [];
        await c.execute(`INSERT INTO slot_content_review_attempts
          (slot_id,sequence_no,phase,technical_retry,decision,rationale_code,sanitized_draft,violations_json)
          VALUES (?,?,'reviewer',?,?,?,?,?) ON DUPLICATE KEY UPDATE technical_retry=VALUES(technical_retry),decision=VALUES(decision),
          rationale_code=VALUES(rationale_code),sanitized_draft=VALUES(sanitized_draft),violations_json=VALUES(violations_json)`,
        [slotId, index + 1, Boolean(attempt?.technicalRetry), decision, rationaleCode, draft, JSON.stringify(violations)]);
      }
      await c.commit();
    } catch (error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function startPublishing(id, { now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[settings]] = await selectQuery(c, 'SELECT automation_enabled,settings_json,business_knowledge_json,business_knowledge_approved FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[integration]] = await selectQuery(c, 'SELECT status,profile_id,account_id FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
      const sessionId=json(settings?.settings_json).automationSessionId;
      const [[slot]] = await selectQuery(c, 'SELECT scheduled_at,status,automation_session_id,fact_bearing,fact_ids,fact_versions,content_safety_hash,cta_url,content_category_id,content_style_id,content_strategy_json,tebar_profile_id,tebar_account_id,request_payload,business_knowledge_snapshot_json,generation_settings_snapshot_json FROM slots WHERE id=? FOR UPDATE', [id]);
      const payload = json(slot?.request_payload);
      const strategy = json(slot?.content_strategy_json, null);
      if (!slot || slot.status !== 'ready' || !slot.content_category_id || !slot.content_style_id || !strategy?.category?.id || !strategy?.style?.id
        || !settings?.automation_enabled || settings.business_knowledge_approved!==1&&settings.business_knowledge_approved!==true || !sessionId || slot.automation_session_id!==sessionId
        || integration?.status !== 'ACTIVE' || !slot.tebar_profile_id || !slot.tebar_account_id
        || slot.tebar_profile_id !== integration.profile_id || slot.tebar_account_id !== integration.account_id
        || payload?.targets?.length !== 1 || payload.targets[0]?.account_id !== slot.tebar_account_id) { await c.rollback(); return false; }
      if (await hasProviderHold(c, integration.profile_id, integration.account_id)) {
        await c.execute("UPDATE slots SET claimed_at=NULL WHERE id=? AND status='ready'", [id]);
        await c.commit(); return 'provider_hold';
      }
      const [[otherInFlight]] = await selectQuery(c, "SELECT id FROM slots WHERE automation_session_id=? AND id<>? AND (status IN ('generating','publishing') OR (status='ready' AND claimed_at>=DATE_SUB(?,INTERVAL 10 MINUTE))) LIMIT 1 FOR UPDATE", [sessionId, id, now]);
      if (otherInFlight) {
        await c.execute("UPDATE slots SET claimed_at=NULL WHERE id=? AND status='ready'", [id]);
        await c.commit();
        return 'in_flight';
      }
      const currentConfig = json(settings.settings_json);
      const slotConfig = json(slot.generation_settings_snapshot_json, {
        schedule: currentConfig.schedule || {}, hashtags: currentConfig.hashtags || [],
        businessKnowledge: json(slot.business_knowledge_snapshot_json, json(settings.business_knowledge_json, {})),
      });
      const ndiSettings = validateNdiSettings({ schedule: slotConfig.schedule || {}, hashtags: slotConfig.hashtags || [],
        businessKnowledge: slotConfig.businessKnowledge || json(slot.business_knowledge_snapshot_json, {}) });
      const currentHash = ndiSettings.valid ? contentSafetyHash(ndiSettings.settings) : null;
      const captionCheck = validateNdiCaption(payload?.content, {
        ctaUrl: slot.cta_url,
        hashtags: ndiSettings.settings?.hashtags || [],
        forbiddenClaims: ndiSettings.settings?.businessKnowledge?.forbiddenClaims || [],
      });
      if (!slot.content_safety_hash || !currentHash || slot.content_safety_hash !== currentHash || !captionCheck.valid) {
        await c.rollback(); return 'stale_facts';
      }
      const ids = json(slot.fact_ids, []);
      const versions = json(slot.fact_versions, []);
      if (!Array.isArray(ids) || !Array.isArray(versions)
        || slot.fact_bearing || ids.length || versions.length) {
        await c.rollback(); return 'stale_facts';
      }
      const [[last]] = await selectQuery(c, "SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId,id]);
      const config = currentConfig;
      const knowledge = json(settings.business_knowledge_json, {});
      const checkedSettings = validateNdiSettings({ schedule: config.schedule || {}, hashtags: config.hashtags || [], businessKnowledge: knowledge });
      if (!checkedSettings.valid) { await c.rollback(); return 'stale_facts'; }
      const cadenceMs = checkedSettings.settings.schedule.intervalMinutes * 60_000;
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < cadenceMs) {
        await c.execute("UPDATE slots SET claimed_at=NULL WHERE id=? AND status='ready'", [id]);
        await c.commit();
        return 'minimum_cadence';
      }
      await c.execute("UPDATE slots SET status='publishing',publish_started_at=? WHERE id=? AND automation_session_id=? AND status='ready'", [now, id,sessionId]);
      await c.commit();
      return true;
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function withPublicationFence(id, publish) {
    if (typeof publish !== 'function') throw new TypeError('publish callback is required');
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[settings]] = await selectQuery(c, 'SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const configured = json(settings?.settings_json);
      const sessionId = configured.automationSessionId;
      const [[integration]] = await selectQuery(c, 'SELECT status,profile_id,account_id FROM integration_config WHERE id=1 FOR UPDATE', [], 'query');
      const [[slot]] = await selectQuery(c, 'SELECT status,provider_post_id,automation_session_id,tebar_profile_id,tebar_account_id,request_payload FROM slots WHERE id=? FOR UPDATE', [id]);
      const payload = json(slot?.request_payload);
      if (!settings?.automation_enabled || !sessionId || slot?.automation_session_id !== sessionId
        || configured.profileId !== integration?.profile_id || configured.targetAccountId !== integration?.account_id
        || integration?.status !== 'ACTIVE' || slot?.tebar_profile_id !== integration.profile_id || slot?.tebar_account_id !== integration.account_id
        || payload?.targets?.length !== 1 || payload.targets[0]?.account_id !== integration.account_id
        || slot?.status !== 'publishing' || slot.provider_post_id !== null) {
        await c.rollback();
        return false;
      }
      /** @param {PublicationOutcomePatch} patch @param {{providerHold?: ProviderHold}} [options] */
      const recordOutcome = async (patch, { providerHold } = {}) => {
        if (!['publishing', 'unknown', 'published', 'failed', 'partial', 'canceled'].includes(patch?.status)) {
          throw new TypeError('publication outcome status is invalid');
        }
        const allowed = { status: 'status', providerPostId: 'provider_post_id', providerStatus: 'provider_status', errorCode: 'error_code', completedAt: 'completed_at', providerPublishedAt: 'provider_published_at' };
        const keys = Object.keys(patch || {}).filter((key) => allowed[key] && !(key === 'providerPublishedAt' && patch[key] == null));
        if (!keys.length) throw new TypeError('publication outcome is required');
        const values = [...keys.map((key) => key === 'completedAt' ? normalizeCompletedAt(patch[key]) : key === 'providerPublishedAt' ? normalizeProviderPublishedAt(patch[key]) : patch[key]), id];
        await c.execute(
          `UPDATE slots SET ${keys.map((key) => `${allowed[key]}=?`).join(',')} WHERE id=? AND status='publishing' AND provider_post_id IS NULL`,
          values,
        );
        if (patch.status === 'unknown' && slot.status !== 'unknown') {
          await lockUnknownAlerts(c);
          await recordUnknownTransition(c, id);
        }
        if (['published', 'failed', 'partial', 'canceled'].includes(patch.status)) await suppressPendingNotices(c, id, patch.status);
        if (providerHold) {
          const scope = providerHoldScope(providerHold);
          const allowed = ['unauthorized', 'permission_missing', 'account_expired', 'account_disconnected', 'account_not_found', 'profile_not_found'];
          if (scope.provider !== 'tebar' || !allowed.includes(providerHold.reasonCode)) throw publicationError('INVALID_REQUEST', 400);
          await c.execute('INSERT INTO automation_provider_holds (provider,scope_key,profile_id,account_id,reason_code,slot_id) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE reason_code=VALUES(reason_code),slot_id=VALUES(slot_id),created_at=IF(active=FALSE,UTC_TIMESTAMP(3),created_at),active=TRUE,cleared_at=NULL,cleared_by=NULL', [scope.provider, scope.scopeKey, scope.profileId, scope.accountId, providerHold.reasonCode, providerHold.slotId || null]);
          await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'provider_hold_created',?)", [providerHold.slotId || null, JSON.stringify({ provider: scope.provider, profileId: scope.profileId, accountId: scope.accountId, reasonCode: providerHold.reasonCode })]);
        }
        return true;
      };
      recordOutcome.supportsProviderHolds = true;
      const result = await publish(recordOutcome);
      await c.commit();
      return result;
    } catch (error) {
      await c.rollback().catch(() => {});
      throw error;
    } finally { c.release(); }
  }
  async function isAutomationSessionActive(sessionId) {
    if(!sessionId)return false;
    const [[state]]=await selectQuery(pool, 'SELECT automation_enabled,settings_json FROM settings WHERE id=1');
    return Boolean(state?.automation_enabled)&&json(state?.settings_json).automationSessionId===sessionId;
  }
  /** @param {{now?: Date, staleAfterMs?: number, slotIds?: string[]}} [options] */
  async function recoverStalePublishing({ now = new Date(), staleAfterMs = STALE_PUBLISHING_AFTER_MS, slotIds } = {}) {
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(current.getTime())) throw Object.assign(new Error('INVALID_RECOVERY_TIME'), { code: 'INVALID_RECOVERY_TIME' });
    const age = Number.isSafeInteger(staleAfterMs) ? Math.max(STALE_PUBLISHING_AFTER_MS, staleAfterMs) : STALE_PUBLISHING_AFTER_MS;
    const cutoff = new Date(current.getTime() - age);
    const selectedIds = Array.isArray(slotIds) ? [...new Set(slotIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128))] : null;
    if (selectedIds?.length === 0) return [];
    const selectedFilter = selectedIds ? ` AND id IN (${selectedIds.map(() => '?').join(',')})` : '';
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await selectQuery(connection, `SELECT id FROM slots
        WHERE status='publishing' AND provider_post_id IS NULL AND publish_started_at IS NOT NULL AND publish_started_at<=?${selectedFilter}
        ORDER BY publish_started_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [cutoff, ...(selectedIds || [])]);
      const recovered = [];
      if (rows.length) await lockUnknownAlerts(connection);
      for (const row of rows) {
        const [updated] = await mutationQuery(connection, `UPDATE slots
          SET status='unknown',provider_status='unknown',error_code='unknown_outcome',completed_at=NULL
          WHERE id=? AND status='publishing' AND provider_post_id IS NULL AND publish_started_at<=?`, [row.id, cutoff]);
        if (updated.affectedRows !== 1) continue;
        await recordUnknownTransition(connection, row.id);
        const details = { code: 'unknown_outcome', reason: 'worker_interrupted' };
        await connection.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'publication_worker_interrupted',?)", [row.id, JSON.stringify(details)]);
        recovered.push(row.id);
      }
      await connection.commit();
      return recovered;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  async function suppressPendingNotices(connection,id,status) {
    if(!['published','failed','partial','canceled','admin_closed_unknown'].includes(status))return;
    const keys=['unknown_outcome',...(status==='published'?['provider_error','generation_failed','content_validation_failed']:[])].map(code=>createHash('sha256').update(`${code}:slot:${id}`).digest('hex'));
    for(const key of keys) await connection.execute("UPDATE notification_outbox SET status='failed',last_error_code='superseded' WHERE dedupe_key=? AND status='pending'",[key]);
  }
  async function lockUnknownAlerts(connection) {
    await selectQuery(connection, 'SELECT id FROM dual_ai_unknown_alert_lock WHERE id=1 FOR UPDATE', [], 'query');
  }
  async function recordUnknownTransition(connection, id) {
    await connection.execute("UPDATE slots SET unknown_occurrence_count=unknown_occurrence_count+1 WHERE id=? AND status='unknown'", [id]);
    const [[slot]] = await selectQuery(connection, 'SELECT unknown_occurrence_count,scheduled_at,publish_started_at FROM slots WHERE id=?', [id]);
    if (!slot) return;
    const occurrence = Number(slot.unknown_occurrence_count);
    const [eventResult] = await connection.execute('INSERT INTO publication_unknown_events (slot_id,occurrence_no,occurred_at) VALUES (?,?,UTC_TIMESTAMP(3))', [id, occurrence]);
    const eventId = Number(eventResult.insertId);
    const slotKey = createHash('sha256').update(`unknown-slot:${id}:${occurrence}`).digest('hex');
    const occurredAt = slot.publish_started_at || slot.scheduled_at;
    const occurredAtUtc = occurredAt instanceof Date ? occurredAt.toISOString()
      : typeof occurredAt === 'string' ? `${occurredAt.replace(' ', 'T')}Z` : 'tidak tersedia';
    const slotNotice = `BOT NDI — STATUS PUBLIKASI BELUM PASTI\nSlot ID: ${id}\nWaktu: ${occurredAtUtc} (UTC)\nStatus belum terverifikasi. Sistem tidak akan mengirim ulang slot ini. Dashboard: https://botndi.sequein.my.id → Integrasi → Riwayat & Catatan.`;
    await connection.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)', [slotKey, slotNotice]);
    const [[rolling]] = await selectQuery(connection, 'SELECT COUNT(*) AS count FROM publication_unknown_events WHERE occurred_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR)', []);
    if (Number(rolling?.count || 0) < 3) return;
    const [[recentAlert]] = await selectQuery(connection, 'SELECT id FROM publication_unknown_threshold_alerts WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 24 HOUR) LIMIT 1 FOR UPDATE', []);
    if (recentAlert) return;
    const thresholdKey = createHash('sha256').update(`unknown-threshold:${eventId}`).digest('hex');
    const [alertResult] = await connection.execute('INSERT IGNORE INTO publication_unknown_threshold_alerts (threshold_event_id,dedupe_key) VALUES (?,?)', [eventId, thresholdKey]);
    if (alertResult.affectedRows !== 1) return;
    const thresholdNotice = 'BOT NDI — PERINGATAN PRIORITAS\nTiga atau lebih kejadian slot publikasi belum pasti tercatat dalam 24 jam terakhir (UTC). Otomasi tetap mengikuti jadwal; slot yang belum pasti tidak akan dikirim ulang. Dashboard: https://botndi.sequein.my.id → Integrasi → Riwayat & Catatan.';
    await connection.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)', [thresholdKey, thresholdNotice]);
  }
  async function updateSlot(id,patch) {
    if (patch.status === 'admin_closed_unknown') throw publicationError('PUBLICATION_RESOLUTION_REQUIRED');
    const allowed={status:'status',providerPostId:'provider_post_id',providerStatus:'provider_status',errorCode:'error_code',cancellationStatus:'cancellation_status',completedAt:'completed_at',providerPublishedAt:'provider_published_at'};
    const keys=Object.keys(patch).filter(k=>allowed[k] && !(k==='providerPublishedAt' && patch[k] == null));if(!keys.length)return;
    const sql=keys.map(k=>`${allowed[k]}=?`).join(',');
    const values=[...keys.map(k=>k==='completedAt'?normalizeCompletedAt(patch[k]):k==='providerPublishedAt'?normalizeProviderPublishedAt(patch[k]):patch[k]),id];
    const guarded=typeof patch.status==='string';
    const conflictGuard = guarded && patch.status !== 'published'
      ? " AND NOT (status='unknown' AND COALESCE(error_code,'')='provider_status_conflict')" : '';
    const where=guarded?` WHERE id=? AND (status NOT IN ('published','failed','partial','canceled','skipped','admin_closed_unknown') OR status=?)${conflictGuard}`:" WHERE id=? AND status<>'admin_closed_unknown'";
    if(guarded)values.push(patch.status);
    if (patch.status === 'unknown') {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        await selectQuery(c, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
        const [[current]] = await selectQuery(c, 'SELECT status FROM slots WHERE id=? FOR UPDATE', [id]);
        const [updated] = await mutationQuery(c, `UPDATE slots SET ${sql}${where}`, values);
        if (updated.affectedRows && current?.status !== 'unknown') {
          await lockUnknownAlerts(c);
          await recordUnknownTransition(c, id);
        }
        await c.commit();
        return updated.affectedRows > 0;
      } catch (error) { await c.rollback(); throw error; }
      finally { c.release(); }
    }
    if(!['published','failed','partial','canceled'].includes(patch.status)){const [updated]=await mutationQuery(pool, `UPDATE slots SET ${sql}${where}`,values);return updated.affectedRows>0;}
    const c=await pool.getConnection();try{
      await c.beginTransaction();
      await selectQuery(c, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      if (patch.providerPublishedAt != null) {
        const [[current]] = await selectQuery(c, 'SELECT status,provider_published_at FROM slots WHERE id=? FOR UPDATE', [id]);
        const incoming = normalizeProviderPublishedAt(patch.providerPublishedAt);
        const currentValue = current?.provider_published_at;
        const currentTime = currentValue instanceof Date ? currentValue.getTime()
          : typeof currentValue === 'string' ? Date.parse(`${currentValue.replace(' ', 'T')}Z`) : NaN;
        const incomingTime = Date.parse(`${incoming.replace(' ', 'T')}Z`);
        if (Number.isFinite(currentTime) && currentTime !== incomingTime) {
          await c.execute("UPDATE slots SET status='unknown',provider_status='unknown',error_code='provider_status_conflict',completed_at=NULL WHERE id=? AND status NOT IN ('admin_closed_unknown')", [id]);
          if (current?.status !== 'unknown') {
            await lockUnknownAlerts(c);
            await recordUnknownTransition(c, id);
          }
          await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'provider_status_conflict',?)", [id, JSON.stringify({ code: 'provider_timestamp_conflict' })]);
          await c.commit();
          return false;
        }
      }
      const [updated]=await mutationQuery(c, `UPDATE slots SET ${sql}${where}`,values);
      if(updated.affectedRows) await suppressPendingNotices(c,id,patch.status);
      else if(patch.status==='published') {
        // A publication conflicting with an earlier terminal result is not safe
        // to discard: require another provider reconciliation before reporting it.
        const [[current]] = await selectQuery(c, 'SELECT status FROM slots WHERE id=? FOR UPDATE', [id]);
        const [conflict] = await mutationQuery(c, "UPDATE slots SET status='unknown',provider_status='unknown',error_code='provider_status_conflict',completed_at=NULL WHERE id=? AND status IN ('failed','partial','canceled','skipped')",[id]);
        if (conflict.affectedRows && current?.status !== 'unknown') {
          await lockUnknownAlerts(c);
          await recordUnknownTransition(c, id);
        }
      }
      await c.commit();
      return updated.affectedRows>0;
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function getUncertainSlots() { const [rows]=await selectQuery(pool, "SELECT id,automation_session_id,provider_post_id,request_payload,idempotency_key,status,tebar_profile_id,tebar_account_id FROM slots WHERE status IN ('unknown','publishing') ORDER BY scheduled_at");return rows.map(r=>({...r,id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,profileId:r.tebar_profile_id,accountId:r.tebar_account_id})); }
  /** @param {{profileId?: string, accountId?: string}} [options] */
  async function listUnsettledSlots({ profileId, accountId } = {}) {
    const scoped = typeof profileId === 'string' && profileId.length > 0 && typeof accountId === 'string' && accountId.length > 0;
    const targetScope = scoped ? ` AND (
      tebar_profile_id IS NULL OR tebar_account_id IS NULL
      OR (tebar_profile_id=? AND tebar_account_id=?)
      OR (request_payload IS NOT NULL AND (
        COALESCE(JSON_LENGTH(JSON_EXTRACT(request_payload,'$.targets')),0)<>1
        OR JSON_UNQUOTE(JSON_EXTRACT(request_payload,'$.targets[0].account_id')) IS NULL
        OR JSON_UNQUOTE(JSON_EXTRACT(request_payload,'$.targets[0].account_id'))<>tebar_account_id
      ))
    )` : '';
    const [rows]=await selectQuery(pool, `SELECT id,automation_session_id,provider_post_id,provider_status,request_payload,idempotency_key,status,caption,pillar,error_code,publish_started_at,scheduled_at,completed_at,tebar_profile_id,tebar_account_id,unknown_occurrence_count FROM slots WHERE (status IN ('unknown','publishing') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')) )${targetScope} ORDER BY scheduled_at`, scoped ? [profileId,accountId] : []);
    return rows.map(r=>({id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,providerStatus:r.provider_status,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,status:r.status,caption:r.caption,pillar:r.pillar,errorCode:r.error_code,publishStartedAt:r.publish_started_at,scheduledAt:r.scheduled_at,completedAt:r.completed_at,profileId:r.tebar_profile_id,accountId:r.tebar_account_id,unknownOccurrenceCount:Number(r.unknown_occurrence_count||0)}));
  }
  /** @param {string} providerPostId @param {{status: string, errorCode?: string | null}} options */
  async function recordCancellation(providerPostId,{status,errorCode}) {
    const c=await pool.getConnection();let updated;
    try {
      await c.beginTransaction();
      const where="provider_post_id=? AND status NOT IN ('published','failed','partial','skipped','admin_closed_unknown') AND NOT (status='unknown' AND COALESCE(error_code,'')='provider_status_conflict')";
      const [slots]=await selectQuery(c, `SELECT id FROM slots WHERE ${where} FOR UPDATE`,[providerPostId]);
      [updated]=await mutationQuery(c, `UPDATE slots SET cancellation_status=?,error_code=COALESCE(?,error_code),status=IF(?='canceled','canceled',status),provider_status=IF(?='canceled','canceled',provider_status),completed_at=IF(?='canceled',UTC_TIMESTAMP(3),completed_at) WHERE ${where}`,[status,errorCode??null,status,status,status,providerPostId]);
      if(status==='canceled') for(const slot of slots) await suppressPendingNotices(c,slot.id,status);
      await c.commit();
    } catch(e) { await c.rollback();throw e; } finally { c.release(); }
    await appendActivity({event:'post_cancellation',details:{status:updated.affectedRows?status:'unresolved',errorCode:errorCode||null}});return updated.affectedRows>0;
  }
  function publicationError(code, status = 409) { return Object.assign(new Error(code), { code, status }); }
  function publicationInput(input, action) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const bounded = (value, max) => typeof value === 'string' && value.trim().length >= 10 && value.trim().length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
    if (!input || !uuid.test(input.slotId) || !uuid.test(input.requestId) || !Number.isSafeInteger(Number(input.actorId)) || Number(input.actorId) < 1
      || !bounded(input.reason, 1000) || !bounded(input.evidenceSummary, 2000) || !['close_unverified', 'link_provider_post'].includes(action)
      || (action === 'link_provider_post' && (typeof input.providerPostId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.providerPostId)))) throw publicationError('INVALID_REQUEST', 400);
    const value = { ...input, slotId: input.slotId.toLowerCase(), requestId: input.requestId.toLowerCase(), actorId: Number(input.actorId), action,
      reason: input.reason.trim(), evidenceSummary: input.evidenceSummary.trim(), providerPostId: action === 'link_provider_post' ? input.providerPostId : null };
    value.requestHash = createHash('sha256').update(JSON.stringify([value.slotId, value.action, value.actorId, value.reason, value.evidenceSummary, value.providerPostId])).digest('hex');
    return value;
  }
  function publicationEvent(row, replayed = false) {
    return { requestId: row.request_id, slotId: row.slot_id, action: row.action, actorId: Number(row.actor_id), actorEmail: row.actor_email,
      previousStatus: row.previous_status, newStatus: row.new_status, reason: row.reason, evidenceSummary: row.evidence_summary,
      profileId: row.profile_id, accountId: row.account_id, providerPostId: row.provider_post_id, createdAt: row.created_at, replayed };
  }
  async function getPublicationResolutionByRequest(input) {
    const value = publicationInput(input, input.action);
    const [[row]] = await selectQuery(pool, 'SELECT * FROM publication_resolution_events WHERE request_id=?', [value.requestId]);
    if (!row) return null;
    if (row.request_hash !== value.requestHash) throw publicationError('PUBLICATION_REQUEST_CONFLICT');
    return publicationEvent(row, true);
  }
  async function getPublicationSlot(id) {
    const [[row]] = await selectQuery(pool, 'SELECT id,caption,scheduled_at,publish_started_at,status,provider_status,provider_post_id,error_code,completed_at,request_payload,tebar_profile_id,tebar_account_id FROM slots WHERE id=?', [id]);
    if (!row) return null;
    const payload = json(row.request_payload);
    const resolutionTargetValid = /^[A-Za-z0-9_-]{1,128}$/.test(row.tebar_profile_id || '')
      && /^[A-Za-z0-9_-]{1,128}$/.test(row.tebar_account_id || '')
      && payload?.targets?.length === 1 && payload.targets[0]?.account_id === row.tebar_account_id;
    return { id: row.id, caption: row.caption, scheduledAt: row.scheduled_at, publishStartedAt: row.publish_started_at, status: row.status,
      providerStatus: row.provider_status, providerPostId: row.provider_post_id, errorCode: row.error_code, completedAt: row.completed_at,
      profileId: row.tebar_profile_id, accountId: row.tebar_account_id, resolutionTargetValid };
  }
  async function listPublicationBlockers() {
    const slots = await listUnsettledSlots();
    return slots.map(({ requestPayload, idempotencyKey, ...slot }) => {
      const targetValid = /^[A-Za-z0-9_-]{1,128}$/.test(slot.profileId || '') && /^[A-Za-z0-9_-]{1,128}$/.test(slot.accountId || '')
        && requestPayload?.targets?.length === 1 && requestPayload.targets[0]?.account_id === slot.accountId;
      const resolutionEligible = slot.status === 'unknown' && slot.providerPostId === null;
      const linkEligible = resolutionEligible && targetValid;
      const resolutionBlockedReason = resolutionEligible ? null : slot.status !== 'unknown' ? 'PUBLICATION_NOT_UNKNOWN' : slot.providerPostId !== null ? 'PROVIDER_POST_ALREADY_LINKED' : 'PUBLICATION_TARGET_MISMATCH';
      return { ...slot, resolutionEligible, linkEligible, resolutionTargetValid: targetValid, resolutionBlockedReason };
    });
  }
  async function listClosedUnknownSlots(slotId) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (slotId !== undefined && (typeof slotId !== 'string' || !uuid.test(slotId))) throw publicationError('INVALID_REQUEST', 400);
    const byId = slotId !== undefined;
    const [rows] = await selectQuery(pool, `SELECT id,caption,scheduled_at,publish_started_at,status,provider_status,provider_post_id,error_code,completed_at,request_payload,tebar_profile_id,tebar_account_id FROM slots WHERE status='admin_closed_unknown' AND provider_post_id IS NULL${byId ? ' AND id=?' : ''} ORDER BY completed_at DESC LIMIT 100`, byId ? [slotId.toLowerCase()] : []);
    return rows.map(row => {
      const payload = json(row.request_payload);
      const targetValid = /^[A-Za-z0-9_-]{1,128}$/.test(row.tebar_profile_id || '')
        && /^[A-Za-z0-9_-]{1,128}$/.test(row.tebar_account_id || '')
        && payload?.targets?.length === 1 && payload.targets[0]?.account_id === row.tebar_account_id;
      return { id: row.id, caption: row.caption, scheduledAt: row.scheduled_at, publishStartedAt: row.publish_started_at,
        status: row.status, providerStatus: row.provider_status, providerPostId: row.provider_post_id, errorCode: row.error_code,
        completedAt: row.completed_at, profileId: row.tebar_profile_id, accountId: row.tebar_account_id,
        lateLinkEligible: targetValid, lateLinkBlockedReason: targetValid ? null : 'PUBLICATION_TARGET_MISMATCH' };
    });
  }
  async function listPublicationResolutionEvents() {
    const [rows] = await selectQuery(pool, 'SELECT * FROM publication_resolution_events ORDER BY id DESC LIMIT 100');
    return rows.map(row => publicationEvent(row));
  }
  async function resolvePublication(input, action) {
    const value = publicationInput(input, action);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      // Use the same first lock as claiming and account switching. This also
      // serializes different admin requests that attempt to link the same ID.
      await selectQuery(c, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [[actor]] = await selectQuery(c, 'SELECT id,email,active FROM admins WHERE id=? FOR UPDATE', [value.actorId]);
      if (!actor?.active) throw publicationError('AUTH_REQUIRED', 401);
      const [[previous]] = await selectQuery(c, 'SELECT * FROM publication_resolution_events WHERE request_id=? FOR UPDATE', [value.requestId]);
      if (previous) {
        if (previous.request_hash !== value.requestHash) throw publicationError('PUBLICATION_REQUEST_CONFLICT');
        await c.commit(); return publicationEvent(previous, true);
      }
      const [[slot]] = await selectQuery(c, 'SELECT * FROM slots WHERE id=? FOR UPDATE', [value.slotId]);
      if (!slot) throw publicationError('PUBLICATION_NOT_FOUND', 404);
      const linkFromClosed = action === 'link_provider_post' && slot.status === 'admin_closed_unknown';
      if ((!linkFromClosed && slot.status !== 'unknown') || slot.provider_post_id !== null) throw publicationError('PUBLICATION_STATE_CONFLICT');
      const payload = json(slot.request_payload);
      const targetValid = /^[A-Za-z0-9_-]{1,128}$/.test(slot.tebar_profile_id || '') && /^[A-Za-z0-9_-]{1,128}$/.test(slot.tebar_account_id || '')
        && payload?.targets?.length === 1 && payload.targets[0]?.account_id === slot.tebar_account_id;
      if (action === 'link_provider_post' && !targetValid) throw publicationError('PUBLICATION_TARGET_MISMATCH');
      if (action === 'link_provider_post') {
        if (slot.tebar_profile_id !== value.profileId || slot.tebar_account_id !== value.accountId) throw publicationError('PUBLICATION_TARGET_MISMATCH');
        const [[linked]] = await selectQuery(c, 'SELECT id FROM slots WHERE provider_post_id=? AND id<>? LIMIT 1 FOR UPDATE', [value.providerPostId, value.slotId]);
        if (linked) throw publicationError('PROVIDER_POST_ALREADY_LINKED');
        const [linkedUpdate] = await mutationQuery(c, linkFromClosed
          ? "UPDATE slots SET provider_post_id=?,status='unknown',provider_status='unknown',completed_at=NULL WHERE id=? AND status='admin_closed_unknown' AND provider_post_id IS NULL"
          : "UPDATE slots SET provider_post_id=? WHERE id=? AND status='unknown' AND provider_post_id IS NULL", [value.providerPostId, value.slotId]);
        if (linkedUpdate.affectedRows !== 1) throw publicationError('PUBLICATION_STATE_CONFLICT');
      } else {
        await c.execute("UPDATE slots SET status='admin_closed_unknown',provider_status='unknown',completed_at=UTC_TIMESTAMP(3) WHERE id=? AND status='unknown' AND provider_post_id IS NULL", [value.slotId]);
        await suppressPendingNotices(c, value.slotId, 'admin_closed_unknown');
      }
      const newStatus = action === 'close_unverified' ? 'admin_closed_unknown' : 'unknown';
      await c.execute('INSERT INTO publication_resolution_events (request_id,request_hash,slot_id,action,actor_id,actor_email,previous_status,new_status,reason,evidence_summary,profile_id,account_id,provider_post_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [value.requestId, value.requestHash, value.slotId, action, value.actorId, actor.email, slot.status, newStatus, value.reason, value.evidenceSummary, slot.tebar_profile_id, slot.tebar_account_id, value.providerPostId]);
      const details = { slotId: value.slotId, requestId: value.requestId, previousStatus: slot.status, newStatus, profileId: slot.tebar_profile_id, accountId: slot.tebar_account_id, providerPostId: value.providerPostId };
      await audit(c, value.actorId, `publication.${action}`, details);
      await c.execute('INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,?,?)', [value.slotId, `publication_${action}`, JSON.stringify(details)]);
      const message = action === 'close_unverified'
        ? `BOT NDI — SLOT DITUTUP OLEH ADMIN\n\nHasil publikasi belum terverifikasi. Postingan dapat muncul terlambat. Slot tidak akan dikirim ulang. Otomasi mengikuti status dan jadwal yang berlaku.\n\nSlot ID: ${value.slotId}`
        : `BOT NDI — ID POST DIKAITKAN\n\nPost Threads pada akun asal telah diverifikasi. Slot menunggu rekonsiliasi normal.\n\nSlot ID: ${value.slotId}`;
      const noticeKey = createHash('sha256').update(`publication-resolution:${value.requestId}`).digest('hex');
      await c.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)', [noticeKey, message]);
      const [[event]] = await selectQuery(c, 'SELECT * FROM publication_resolution_events WHERE request_id=?', [value.requestId]);
      await c.commit(); return publicationEvent(event);
    } catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async function closeUnknownPublication(input) { return resolvePublication(input, 'close_unverified'); }
  async function linkVerifiedProviderPost(input) { return resolvePublication(input, 'link_provider_post'); }
  function providerHoldScope({ provider, profileId, accountId }) {
    if (!['openrouter', 'tebar'].includes(provider) || (provider === 'tebar' && (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId || '')))) throw publicationError('INVALID_REQUEST', 400);
    const profile = provider === 'tebar' ? profileId : null;
    const account = provider === 'tebar' ? accountId : null;
    return { provider, profileId: profile, accountId: account, scopeKey: createHash('sha256').update(JSON.stringify([provider, profile, account])).digest('hex') };
  }
  async function hasProviderHold(connection, profileId, accountId) {
    const [[hold]] = await selectQuery(connection, "SELECT provider FROM automation_provider_holds WHERE active=TRUE AND (provider='openrouter' OR (provider='tebar' AND profile_id=? AND account_id=?)) LIMIT 1 FOR UPDATE", [profileId || null, accountId || null]);
    return Boolean(hold);
  }
  async function recordProviderHold(input) {
    const scope = providerHoldScope(input);
    const allowed = scope.provider === 'openrouter' ? ['ai_unauthorized', 'unauthorized', 'ai_not_configured'] : ['unauthorized', 'permission_missing', 'account_expired', 'account_disconnected', 'account_not_found', 'profile_not_found', 'not_configured'];
    if (!allowed.includes(input.reasonCode)) throw publicationError('INVALID_REQUEST', 400);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await selectQuery(c, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      await c.execute('INSERT INTO automation_provider_holds (provider,scope_key,profile_id,account_id,reason_code,slot_id) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE reason_code=VALUES(reason_code),slot_id=VALUES(slot_id),created_at=IF(active=FALSE,UTC_TIMESTAMP(3),created_at),active=TRUE,cleared_at=NULL,cleared_by=NULL', [scope.provider, scope.scopeKey, scope.profileId, scope.accountId, input.reasonCode, input.slotId || null]);
      await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'provider_hold_created',?)", [input.slotId || null, JSON.stringify({ provider: scope.provider, profileId: scope.profileId, accountId: scope.accountId, reasonCode: input.reasonCode })]);
      await c.commit();
      return { provider: scope.provider, scope: scope.provider === 'openrouter' ? 'global' : 'account', profileId: scope.profileId, accountId: scope.accountId, reasonCode: input.reasonCode };
    } catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
  }
  /** @param {{profileId?: string, accountId?: string}} [options] */
  async function listActiveProviderHolds({ profileId, accountId } = {}) {
    const scoped = profileId !== undefined || accountId !== undefined;
    const [rows] = await selectQuery(pool, `SELECT provider,profile_id,account_id,reason_code,slot_id,created_at FROM automation_provider_holds WHERE active=TRUE${scoped ? " AND (provider='openrouter' OR (profile_id=? AND account_id=?))" : ''} ORDER BY created_at`, scoped ? [profileId || null, accountId || null] : []);
    return rows.map(row => ({ provider: row.provider, scope: row.provider === 'openrouter' ? 'global' : 'account', profileId: row.profile_id, accountId: row.account_id, reasonCode: row.reason_code, slotId: row.slot_id, createdAt: row.created_at }));
  }
  async function clearProviderHold(input) {
    const scope = providerHoldScope(input);
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      await selectQuery(c, 'SELECT id FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const [updated] = await mutationQuery(c, 'UPDATE automation_provider_holds SET active=FALSE,cleared_at=UTC_TIMESTAMP(3),cleared_by=? WHERE provider=? AND scope_key=? AND active=TRUE', [input.actorId || null, scope.provider, scope.scopeKey]);
      if (updated.affectedRows) await audit(c, input.actorId, 'publication.provider_hold_cleared', { provider: scope.provider, profileId: scope.profileId, accountId: scope.accountId });
      await c.commit(); return { changed: updated.affectedRows > 0 };
    } catch (error) { await c.rollback().catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async function getDailySummaryCounts(date,timezone) {
    const start=DateTime.fromISO(`${date}T00:00:00`,{zone:timezone});
    if(!start.isValid) throw new Error('INVALID_SUMMARY_DATE');
    const from=start.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');const to=start.plus({days:1}).toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
    const [rows]=await selectQuery(pool, "SELECT id,status,pillar,error_code FROM slots WHERE COALESCE(completed_at,scheduled_at)>=? AND COALESCE(completed_at,scheduled_at)<?",[from,to]);
    const result={published:0,failed:0,unknown:0,adminClosedUnknown:0,skipped:0,categories:{},failures:{},affectedSlotIds:[]};
    for(const row of rows){
      if(row.status==='published'){result.published++;if(row.pillar)result.categories[row.pillar]=(result.categories[row.pillar]||0)+1;}
      else if(['failed','partial'].includes(row.status)){result.failed++;const code=row.error_code||'provider_error';result.failures[code]=(result.failures[code]||0)+1;result.affectedSlotIds.push(row.id);}
      else if(['unknown','publishing'].includes(row.status)){result.unknown++;result.affectedSlotIds.push(row.id);}
      else if(row.status==='admin_closed_unknown'){result.adminClosedUnknown++;result.affectedSlotIds.push(row.id);}
      else if(row.status==='skipped')result.skipped++;
    }
    result.failures=Object.entries(result.failures).map(([code,count])=>({code,count}));
    return result;
  }
  async function reserveDailySummary(date,timezone) { const [insert]=await mutationQuery(pool, "INSERT IGNORE INTO daily_summaries (local_date,timezone,status,created_at) VALUES (?,?,'sending',UTC_TIMESTAMP(3))",[date,timezone]);if(insert.affectedRows===1)return true;const [claim]=await mutationQuery(pool, "UPDATE daily_summaries SET status='sending',created_at=UTC_TIMESTAMP(3) WHERE local_date=? AND timezone=? AND (status='failed' OR (status='sending' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)))",[date,timezone]);return claim.affectedRows===1; }
  async function completeDailySummary(date,timezone,status='sent') { await pool.execute('UPDATE daily_summaries SET status=?,sent_at=IF(?=\'sent\',UTC_TIMESTAMP(3),sent_at) WHERE local_date=? AND timezone=?',[status,status,date,timezone]); }
  async function recordWebhookEvent(eventId,payloadHash) { try{await pool.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]);return true;}catch(e){if(e.code==='ER_DUP_ENTRY')return false;throw e;} }
  /** @param {{eventId: string, payloadHash: string, type: string, profileId: string, data: Record<string, unknown>, accountId?: string, notificationCode?: string | null}} event */
  async function applyWebhookEvent({eventId,payloadHash,type,profileId,data,accountId,notificationCode}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      try { await c.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]); }
      catch(e) { if(e.code==='ER_DUP_ENTRY'){await c.rollback();return false;} throw e; }
      const [[settingsRow]]=await selectQuery(c, 'SELECT settings_json,business_knowledge_json,automation_enabled FROM settings WHERE id=1 FOR UPDATE', [], 'query');
      const configured=json(settingsRow?.settings_json);
      const knowledge=json(settingsRow?.business_knowledge_json,{});
      const eventType=String(type||'');
      const target = data.target && typeof data.target === 'object' && !Array.isArray(data.target)
        ? /** @type {Record<string, unknown>} */ (data.target) : {};
      const account = data.account && typeof data.account === 'object' && !Array.isArray(data.account)
        ? /** @type {Record<string, unknown>} */ (data.account) : {};
      const accountValue = data.account_id || target.account_id || account.id;
      const dataAccount = typeof accountValue === 'string' ? accountValue : null;
      const postId=data.post_id||data.id;
      const [[eventSlot]]=typeof postId==='string'&&eventType.startsWith('post.')
        ? await selectQuery(c, 'SELECT id,automation_session_id,status,provider_status,provider_published_at,tebar_profile_id,tebar_account_id FROM slots WHERE provider_post_id=? LIMIT 1 FOR UPDATE',[postId]) : [[]];
      const postMatches=Boolean(eventSlot?.tebar_profile_id && eventSlot?.tebar_account_id
        && eventSlot.tebar_profile_id===profileId && eventSlot.tebar_account_id===dataAccount);
      const expectedAccount=eventSlot?.tebar_account_id;
      const webhookPublishedAt=(()=>{
        const targetMatches= target.account_id===expectedAccount
          && (!target.platform||String(target.platform).toLowerCase()==='threads');
        const value=data.published_at||(targetMatches?target.published_at:null);
        if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;
        try { return new Date(`${normalizeProviderPublishedAt(value).replace(' ', 'T')}Z`); }
        catch { return null; }
      })();
      let activeSessionCanceledPost=false;
      let staleTerminalCancellation=false;
      if(typeof postId === 'string' && postMatches && eventSlot.status !== 'admin_closed_unknown') {
        const status=String(data.status||eventType.split('.').at(-1)).toLowerCase();
        const mapped={published:'published',failed:'failed',partial:'partial',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};
        const providerStatus=mapped[status]||'unknown';
        const slot=eventSlot;
        const terminalStatuses=['published','failed','partial','canceled','skipped'];
        const slotIsTerminal=terminalStatuses.includes(slot?.status);
        const conflictingPublication=slotIsTerminal&&slot.status!=='published'&&providerStatus==='published';
        const currentProviderValue = slot?.provider_published_at;
        const currentProviderTime = currentProviderValue instanceof Date ? currentProviderValue.getTime()
          : typeof currentProviderValue === 'string' ? Date.parse(`${currentProviderValue.replace(' ', 'T')}Z`) : NaN;
        const conflictingProviderTime = providerStatus === 'published' && webhookPublishedAt
          && Number.isFinite(currentProviderTime) && currentProviderTime !== webhookPublishedAt.getTime();
        const delayedNonterminal=slotIsTerminal&&(!['published','failed','partial','canceled'].includes(providerStatus) || (slot.provider_status && providerStatus!==slot.provider_status));
        staleTerminalCancellation=slotIsTerminal&&providerStatus==='canceled';
        if(conflictingPublication || conflictingProviderTime) {
          await c.execute("UPDATE slots SET status='unknown',provider_status='unknown',error_code='provider_status_conflict',completed_at=NULL WHERE id=?",[slot.id]);
          if (slot.status !== 'unknown') {
            await lockUnknownAlerts(c);
            await recordUnknownTransition(c, slot.id);
          }
          await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'provider_status_conflict',?)",[slot.id,JSON.stringify({code:conflictingProviderTime?'provider_timestamp_conflict':'unknown_outcome'})]);
        } else if(!delayedNonterminal&&!staleTerminalCancellation) {
          const activeSession=Boolean(settingsRow?.automation_enabled)&&slot?.automation_session_id===configured.automationSessionId;
          activeSessionCanceledPost=providerStatus==='canceled'&&activeSession;
          const slotStatus=activeSessionCanceledPost?'failed':providerStatus;
          const final=['published','failed','partial','canceled'].includes(slotStatus);
          const completedAt=providerStatus==='published'?webhookPublishedAt:null;
          await c.execute('UPDATE slots SET provider_status=?,status=?,error_code=IF(?,\'provider_error\',error_code),completed_at=IF(?,COALESCE(?,UTC_TIMESTAMP(3)),completed_at),provider_published_at=IF(? IS NOT NULL,COALESCE(provider_published_at,?),provider_published_at) WHERE provider_post_id=?',[providerStatus,slotStatus,activeSessionCanceledPost,final,completedAt,providerStatus==='published'?webhookPublishedAt:null,providerStatus==='published'?webhookPublishedAt:null,postId]);
          if (slotStatus === 'unknown' && slot.status !== 'unknown') {
            await lockUnknownAlerts(c);
            await recordUnknownTransition(c, slot.id);
          }
          if(slot && final) await suppressPendingNotices(c,slot.id,slotStatus);
        }
      }
      if(notificationCode&&(eventType.startsWith('post.') ? postMatches : profileId===configured.profileId&&dataAccount===configured.targetAccountId)) {
        let dedupeId=`tebar:${eventId}`;
        let message=`Bot NDI: otomasi ${notificationCode}. Periksa status akun dan log dasbor.`;
        if(notificationCode==='provider_error'&&String(data.status||eventType.split('.').at(-1)).toLowerCase()==='canceled'&&(!activeSessionCanceledPost||staleTerminalCancellation)) message=null;
        if(eventType.startsWith('post.') && typeof postId === 'string') {
          const [[slot]]=await selectQuery(c, 'SELECT id,status,caption,pillar,scheduled_at,completed_at,error_code FROM slots WHERE provider_post_id=? LIMIT 1',[postId]);
          const expectedStatus=notificationCode==='post_published'?'published':'failed';
          if(slot && (slot.status===expectedStatus || (expectedStatus==='failed' && slot.status==='partial')) && message) {
            dedupeId=`${notificationCode}:slot:${slot.id}`;
            message=formatSlotNotice({status:expectedStatus,slotId:slot.id,brand:knowledge.companyName || 'Nusa Data Indonesia',
              time:slot.completed_at||slot.scheduled_at,timezone:configured.schedule?.timezone,pillar:slot.pillar,caption:slot.caption,
              reason:slot.error_code||'provider_error',nextAt:settingsRow?.automation_enabled?configured.nextSlotAt:null});
          } else message=null;
        }
        if(message) {
          const dedupeKey=createHash('sha256').update(dedupeId).digest('hex');
          await c.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)',[dedupeKey,message]);
        }
      }
      await c.commit();
      return true;
    } catch(e) { await c.rollback();throw e; }
    finally { c.release(); }
  }
  async function enqueueNotification({dedupeKey,message}) {
    if(!/^[a-f0-9]{64}$/.test(dedupeKey)||typeof message!=='string'||!message.trim()||message.length>4096)throw Object.assign(new Error('INVALID_NOTIFICATION'),{code:'INVALID_NOTIFICATION'});
    const [result]=await mutationQuery(pool, 'INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)',[dedupeKey,message]);
    return result.affectedRows===1;
  }
  async function getNotificationStatus(dedupeKey) { const [rows]=await selectQuery(pool, 'SELECT status FROM notification_outbox WHERE dedupe_key=?',[dedupeKey]);return rows[0]?.status||null; }
  async function claimNotifications(limit=25) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute("UPDATE notification_outbox SET status='failed',claimed_at=NULL,last_error_code='retry_limit' WHERE status='sending' AND attempts>=8 AND claimed_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)");
      const [rows]=await selectQuery(c, "SELECT id,message,attempts FROM notification_outbox WHERE attempts<8 AND ((status='pending' AND available_at<=UTC_TIMESTAMP(3)) OR (status='sending' AND claimed_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",[Math.max(1,Math.min(100,Number(limit)||25))]);
      for(const row of rows)await c.execute("UPDATE notification_outbox SET status='sending',attempts=attempts+1,claimed_at=UTC_TIMESTAMP(3) WHERE id=?",[row.id]);
      await c.commit();
      return rows.map(row=>({id:row.id,message:row.message,attempts:Number(row.attempts)+1}));
    } catch(e) { await c.rollback();throw e; }
    finally { c.release(); }
  }
  async function markNotificationSent(id) { await pool.execute("UPDATE notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(3),claimed_at=NULL,last_error_code=NULL WHERE id=? AND status='sending'",[id]); }
  async function retryNotification(id,errorCode) { await pool.execute("UPDATE notification_outbox SET status=IF(attempts>=8,'failed','pending'),available_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL LEAST(3600,15*POW(2,GREATEST(attempts-1,0))) SECOND),claimed_at=NULL,last_error_code=? WHERE id=? AND status='sending'",[String(errorCode).slice(0,64),id]); }
  async function claimDailySummary({localDate,timezone}) { return reserveDailySummary(localDate,timezone); }
  async function getDailySummary({localDate,timezone}) { return getDailySummaryCounts(localDate,timezone); }
  async function finishDailySummary({localDate,timezone,status}) { return completeDailySummary(localDate,timezone,status); }
  async function updateSlotFromProvider(providerPostId,status,details={}) { const [rows]=await selectQuery(pool, 'SELECT id FROM slots WHERE provider_post_id=? LIMIT 1',[providerPostId]);if(!rows.length)return false;const map={published:'published',partial:'partial',failed:'failed',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};await updateSlot(rows[0].id,{providerStatus:status,...(map[status]?{status:map[status]}:{}),...(map[status]&&['published','partial','failed','canceled'].includes(map[status])?{completedAt:new Date()}: {}),...(status==='published'&&(details.providerPublishedAt||details.publishedAt)?{providerPublishedAt:details.providerPublishedAt||details.publishedAt}:{})});return true; }
  return { listPublicationBlockers,listClosedUnknownSlots,getPublicationSlot,getPublicationResolutionByRequest,listPublicationResolutionEvents,closeUnknownPublication,linkVerifiedProviderPost,recordProviderHold,listActiveProviderHolds,clearProviderHold,healthCheck,getSettings,getRuntimeState,getContentStrategyState,getWebsiteSyncState,startWebsiteSyncRun,completeWebsiteSyncRun,failWebsiteSyncRun,reviewWebsiteKnowledgeProposal,saveContentStrategyRecord,setContentStrategyRecordActive,archiveContentStrategyRecord,setContentStrategyEnabled,saveCategoryProposalSettings,claimCategoryProposalRun,finishCategoryProposalRun,reviewCategoryProposal,saveSettings,saveKnowledge,listFacts,saveFact,getAdminByEmail,getLoginAttemptCounts,reserveLoginAttempt,releaseLoginReservation,listAdmins,createAdmin,updateAdmin,createSession,getSession,deleteSession,deleteAdminSessions,listSlots,listActivity,listAudit,appendActivity,setAutomationEnabled,setProviderTarget,ensureDueSlot,ensureNextDueSlot,claimDueSlot,savePreparedSlot,saveReviewAttempts,startPublishing,withPublicationFence,isAutomationSessionActive,recoverStalePublishing,updateSlot,getUncertainSlots,listUnsettledSlots,recordCancellation,getDailySummaryCounts,reserveDailySummary,completeDailySummary,claimDailySummary,getDailySummary,finishDailySummary,recordWebhookEvent,applyWebhookEvent,updateSlotFromProvider,enqueueNotification,getNotificationStatus,claimNotifications,markNotificationSent,retryNotification };
}

module.exports={createRepository};
