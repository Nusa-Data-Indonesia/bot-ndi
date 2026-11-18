'use strict';

const { validateNdiSettings } = require('../../ndi-settings');
const { validateBusinessKnowledge } = require('../../business-knowledge');

function registerDashboardRoutes(app, { repository, services, authenticated, mutation }) {
  app.get('/api/dashboard', authenticated, async (_req, res, next) => {
    try {
      const [state, posts, activity, audit, contentStrategy] = await Promise.all([
        repository.getRuntimeState(),
        repository.listSlots(100),
        repository.listActivity(100),
        repository.listAudit(100),
        repository.getContentStrategyState ? repository.getContentStrategyState() : null,
      ]);
      const [provider, clicks] = await Promise.all([
        services.getProviderStatus
          ? Promise.resolve().then(() => services.getProviderStatus()).catch(() => ({ connected: false, status: 'provider_unavailable' }))
          : { connected: false, status: 'not_configured' },
        services.getClickMetric
          ? Promise.resolve().then(() => services.getClickMetric(state)).catch(() => ({ available: false, value: null, reason: 'provider_unavailable' }))
          : { available: false, value: null, reason: 'not_configured' },
      ]);
      const checked = validateNdiSettings(state.settings || {});
      const knowledgeReady = checked.valid && state.businessKnowledgeApproved === true;
      const items = [
        { key: 'contentStrategy', label: 'Strategi konten NDI disetujui', required: true, complete: state.contentStrategyReady === true },
        { key: 'knowledge', label: 'Pengetahuan bisnis NDI dan Website Resmi / CTA URL', required: true, complete: knowledgeReady },
        { key: 'thread', label: 'Akun uji Threads aktif di Tebar', required: true, complete: provider.connected === true },
        { key: 'ai', label: 'Penyedia AI dikonfigurasi', required: true, complete: services.aiConfigured === true },
      ];
      const metrics = {
        success30d: posts.filter((post) => post.status === 'published'
          && new Date(post.completedAt || post.createdAt) > new Date(Date.now() - 30 * 86400000)).length,
        attention: posts.filter((post) => ['failed', 'unknown'].includes(post.status)).length,
        services: Array.isArray(state.businessKnowledge?.services) ? state.businessKnowledge.services.length : 0,
        clicks,
      };
      const recentActivity = [...activity, ...audit]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, 100);
      return res.json({
        settings: state.settings || {},
        businessKnowledge: state.businessKnowledge || null,
        businessKnowledgeApproved: state.businessKnowledgeApproved === true,
        businessKnowledgeVersion: Number(state.businessKnowledgeVersion || 1),
        contentStrategy,
        posts,
        activity: recentActivity,
        provider,
        automation: {
          enabled: state.automationEnabled === true,
          onboardingComplete: state.onboardingComplete === true,
          contentStrategyReady: state.contentStrategyReady === true,
          contentStrategyReason: state.contentStrategyReason || null,
          contentStrategyReasonCode: state.contentStrategyReasonCode || null,
        },
        onboarding: items,
        metrics,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/settings', authenticated, mutation, async (req, res, next) => {
    const checked = validateNdiSettings(req.body);
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_SETTINGS', fields: checked.errors });
    try {
      return res.json(await repository.saveSettings(checked.settings, req.admin.id));
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/knowledge', authenticated, mutation, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > 10000) {
      return res.status(400).json({ error: 'INVALID_KNOWLEDGE' });
    }
    const checked = validateBusinessKnowledge(req.body);
    if (!checked.valid) return res.status(400).json({ error: 'INVALID_KNOWLEDGE', fields: checked.errors });
    try {
      return res.json(await repository.saveKnowledge(checked.knowledge, req.admin.id));
    } catch (error) {
      return next(error);
    }
  });

  // Historical product facts remain in the database for auditability but are
  // no longer accepted as active source knowledge for NDI generation.
  app.put('/api/facts/:service', authenticated, mutation, (_req, res) =>
    res.status(410).json({ error: 'LEGACY_FACTS_ARCHIVED', message: 'Fakta produk lama disimpan sebagai riwayat dan tidak lagi dapat digunakan untuk konten NDI.' }));
}

module.exports = { registerDashboardRoutes };
