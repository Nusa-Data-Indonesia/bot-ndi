'use strict';

const { validateNdiSettings } = require('../../ndi-settings');

function registerAutomationRoutes(app, { repository, services, authenticated, mutation }) {
  app.post('/api/automation/enable', authenticated, mutation, async (req, res, next) => {
    try {
      if (services.externalIntegrationsEnabled !== true) {
        return res.status(503).json({ error: 'EXTERNAL_INTEGRATIONS_DISABLED' });
      }
      if (services.schedulerStatus?.().enabled !== true || typeof services.triggerScheduler !== 'function') {
        return res.status(503).json({ error: 'SCHEDULER_DISABLED' });
      }
      const state = await repository.getRuntimeState();
      if (state.contentStrategyReady !== true) {
        return res.status(409).json({ error: state.contentStrategyReasonCode || 'CONTENT_STRATEGY_NOT_READY' });
      }
      const settings = validateNdiSettings(state.settings || {});
      const provider = services.getProviderStatus ? await services.getProviderStatus() : { connected: false };
      const complete = settings.valid && state.businessKnowledgeApproved === true
        && Boolean(settings.settings.businessKnowledge.companyName && settings.settings.businessKnowledge.ctaUrl)
        && provider.connected === true && services.aiConfigured === true;
      if (!complete) return res.status(409).json({ error: 'ONBOARDING_INCOMPLETE' });
      const activation = await repository.setAutomationEnabled(true, req.admin.id);
      if (activation.changed) {
        try {
          Promise.resolve(services.triggerScheduler()).catch((error) => {
            const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : 'scheduler_trigger_failed';
            services.logger?.error?.('scheduler.trigger_failed', { code });
          });
        } catch (error) {
          const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code) ? error.code : 'scheduler_trigger_failed';
          services.logger?.error?.('scheduler.trigger_failed', { code });
        }
      }
      return res.json({ enabled: true, firstPostAt: activation.firstPostAt, immediate: activation.immediate });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/automation/pause', authenticated, mutation, async (req, res, next) => {
    try {
      const result = services.pauseAutomation
        ? await services.pauseAutomation({ adminId: req.admin.id })
        : (await repository.setAutomationEnabled(false, req.admin.id), { outcomes: [] });
      const outcomes = result?.outcomes || [];
      const canceled = outcomes.filter((entry) => entry.status === 'canceled').length;
      const attention = outcomes.filter((entry) => entry.status !== 'canceled').length;
      return res.json({
        enabled: false,
        outcomes,
        message: `Automasi dijeda. Pembatalan berhasil: ${canceled}; perlu ditinjau: ${attention}.`,
      });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerAutomationRoutes };
