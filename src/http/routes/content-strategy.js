'use strict';

/** @param {any} app @param {{repository: any, services?: any, authenticated: any, mutation: any}} dependencies */
function registerContentStrategyRoutes(app, { repository, services = {}, authenticated, mutation }) {
  app.get('/api/content-strategy', authenticated, async (_req, res, next) => {
    try { return res.json(await repository.getContentStrategyState()); }
    catch (error) { return next(error); }
  });

  for (const [path, kind] of [['categories', 'category'], ['styles', 'style']]) {
    app.post(`/api/content-strategy/${path}`, authenticated, mutation, async (req, res, next) => {
      try { return res.status(201).json(await repository.saveContentStrategyRecord(kind, null, req.body, req.admin.id)); }
      catch (error) { return next(error); }
    });
    app.put(`/api/content-strategy/${path}/:id`, authenticated, mutation, async (req, res, next) => {
      try { return res.json(await repository.saveContentStrategyRecord(kind, req.params.id, req.body, req.admin.id)); }
      catch (error) { return next(error); }
    });
    app.patch(`/api/content-strategy/${path}/:id/active`, authenticated, mutation, async (req, res, next) => {
      try { await repository.setContentStrategyRecordActive(kind, req.params.id, req.body?.active, req.admin.id); return res.json({ updated: true }); }
      catch (error) { return next(error); }
    });
    app.post(`/api/content-strategy/${path}/:id/archive`, authenticated, mutation, async (req, res, next) => {
      try { await repository.archiveContentStrategyRecord(kind, req.params.id, req.admin.id); return res.json({ archived: true }); }
      catch (error) { return next(error); }
    });
  }

  app.post('/api/content-strategy/enable', authenticated, mutation, async (req, res, next) => {
    try { return res.json(await repository.setContentStrategyEnabled(true, req.admin.id)); }
    catch (error) { return next(error); }
  });
  app.post('/api/content-strategy/disable', authenticated, mutation, async (req, res, next) => {
    try { return res.json(await repository.setContentStrategyEnabled(false, req.admin.id)); }
    catch (error) { return next(error); }
  });
  app.put('/api/content-strategy/proposals/config', authenticated, mutation, async (req, res, next) => {
    try {
      if (req.body?.enabled === true && services.categoryProposalJobAvailable !== true) {
        return res.status(503).json({ error: 'EXTERNAL_INTEGRATIONS_DISABLED' });
      }
      await repository.saveCategoryProposalSettings(req.body || {}, req.admin.id);
      await services.setCategoryProposalJobEnabled?.(req.body?.enabled === true);
      return res.json({ updated: true });
    } catch (error) { return next(error); }
  });
  app.post('/api/content-strategy/proposals/:id/:decision', authenticated, mutation, async (req, res, next) => {
    try {
      await repository.reviewCategoryProposal(req.params.id, req.params.decision, req.admin.id);
      return res.json({ reviewed: true, decision: req.params.decision });
    } catch (error) { return next(error); }
  });
}

module.exports = { registerContentStrategyRoutes };
