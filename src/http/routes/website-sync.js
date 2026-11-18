'use strict';

/** @param {any} app @param {{repository: any, services?: any, authenticated: any, mutation: any}} dependencies */
function registerWebsiteSyncRoutes(app, { repository, services = {}, authenticated, mutation }) {
  app.get('/api/website-sync', authenticated, async (_req, res, next) => {
    try { return res.json(await repository.getWebsiteSyncState()); }
    catch (error) { return next(error); }
  });

  app.post('/api/website-sync', authenticated, mutation, async (req, res, next) => {
    if (typeof services.synchronizeNdiWebsite !== 'function') {
      return res.status(503).json({ error: 'WEBSITE_SYNC_UNAVAILABLE' });
    }
    try { return res.json(await services.synchronizeNdiWebsite({ adminId: req.admin.id })); }
    catch (error) { return next(error); }
  });

  app.post('/api/website-sync/proposals/:id/:decision', authenticated, mutation, async (req, res, next) => {
    try {
      const result = await repository.reviewWebsiteKnowledgeProposal(req.params.id, req.params.decision, req.admin.id);
      if (result.status === 'conflict') {
        return res.status(409).json({ error: 'WEBSITE_SYNC_CONFLICT', conflictCode: result.code });
      }
      return res.json(result);
    } catch (error) { return next(error); }
  });
}

module.exports = { registerWebsiteSyncRoutes };
