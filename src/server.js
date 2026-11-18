'use strict';

/** @type {typeof import('express')} */
const express = require('express');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createIpRateLimiter } = require('./rate-limit');
const { createHttpMiddleware, COOKIE } = require('./http/middleware');
const { registerSessionAdminRoutes } = require('./http/routes/session-admin');
const { registerDashboardRoutes } = require('./http/routes/dashboard');
const { registerAutomationRoutes } = require('./http/routes/automation');
const { registerWebhookRoutes } = require('./http/routes/webhooks');
const { registerIntegrationRoutes } = require('./http/routes/integrations');
const { registerPublicationResolutionRoutes } = require('./http/routes/publication-resolution');
const { registerContentStrategyRoutes } = require('./http/routes/content-strategy');

const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PUBLIC_SERVER_ERRORS = new Set([
  'EXTERNAL_INTEGRATIONS_DISABLED',
  'PUBLICATION_VERIFICATION_UNAVAILABLE', 'PUBLICATION_RECONCILIATION_UNAVAILABLE', 'CONFIG_UNAVAILABLE', 'TEBAR_NOT_CONFIGURED', 'TEBAR_UNAUTHORIZED', 'TEBAR_RATE_LIMITED', 'TEBAR_UNAVAILABLE',
  'OPENROUTER_NOT_CONFIGURED', 'OPENROUTER_RATE_LIMITED', 'OPENROUTER_UNAUTHORIZED', 'OPENROUTER_UNAVAILABLE', 'MODEL_METADATA_UNVERIFIED',

]);

/**
 * @typedef {object} ServerServices
 * @property {{ info?: (event: string, metadata?: object) => void, error?: (event: string, metadata?: object) => void }} [logger]
 * @property {{ query: (sql: string) => Promise<unknown> }} [pool]
 * @property {boolean} [externalIntegrationsEnabled]
 * @property {() => { enabled: boolean }} [schedulerStatus]
 * @property {(code: string) => void | Promise<unknown>} [notify]
 * @typedef {import('express').Request & { correlationId?: string, admin?: { id: number } }} ServerRequest
 */

/**
 * @param {{
 *   config?: ReturnType<typeof import('./config').loadEnv>,
 *   repository?: ReturnType<typeof import('./repository').createRepository>,
 *   auth?: ReturnType<typeof import('./auth').createAuth>,
 *   services?: ServerServices
 * }} options
 */
function createServer({ config, repository, auth, services = {} } = {}) {
  if (!config || !repository || !auth) throw new TypeError('config, repository, and auth are required');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === true ? 1 : config.trustProxy);
  const webhookRateLimit = createIpRateLimiter({ limit: 120, windowMs: 60_000 });

  app.use((req, res, next) => {
    /** @type {ServerRequest} */
    const trackedRequest = /** @type {ServerRequest} */ (req);
    if (trackedRequest.path === '/webhooks/tebar' || trackedRequest.path === '/api/integrations' || trackedRequest.path.startsWith('/api/integrations/')) {
      const correlationId = randomUUID();
      trackedRequest.correlationId = correlationId;
      res.set('X-Correlation-ID', correlationId);
      res.once('finish', () => {
        try { services.logger?.info('integration.http', { correlationId, actorId: trackedRequest.admin?.id, method: trackedRequest.method, route: trackedRequest.route?.path || 'unknown', status: res.statusCode }); } catch { /* Logging must not interrupt requests. */ }
      });
    }
    next();
  });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (config.nodeEnv === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Tebar signs the raw request body, so this route must be registered before JSON parsing.
  registerWebhookRoutes(app, { config, repository, services, webhookRateLimit });
  app.use(express.json({ limit: '256kb', strict: true }));

  const middleware = createHttpMiddleware({ config, auth });
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      if (services.pool) await services.pool.query('SELECT 1');
      else if (repository.healthCheck) await repository.healthCheck();
      else await repository.getSettings();
      if (config.schedulerEnabled === true && services.schedulerStatus?.().enabled !== true) {
        return res.status(503).json({ status: 'not_ready' });
      }
      return res.json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'not_ready' });
    }
  });

  registerSessionAdminRoutes(app, { repository, auth, middleware });
  registerPublicationResolutionRoutes(app, { repository, services, authenticated: middleware.authenticated, mutation: middleware.mutation });
  registerIntegrationRoutes(app, { repository, services, authenticated: middleware.authenticated, mutation: middleware.mutation });
  registerContentStrategyRoutes(app, { repository, services, authenticated: middleware.authenticated, mutation: middleware.mutation });
  registerDashboardRoutes(app, {
    repository,
    services,
    authenticated: middleware.authenticated,
    mutation: middleware.mutation,
  });
  registerAutomationRoutes(app, {
    repository,
    services,
    authenticated: middleware.authenticated,
    mutation: middleware.mutation,
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: true, maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));
  app.get('*path', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(async (error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = Number.isInteger(error.status) ? error.status : 500;
    const code = status >= 500
      ? (PUBLIC_SERVER_ERRORS.has(error.code) ? error.code : 'INTERNAL_ERROR')
      : (typeof error.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code) ? error.code : 'INVALID_REQUEST');
    if (status === 429 && Number.isSafeInteger(error.retryAfterSeconds)
      && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 86_400) {
      res.set('Retry-After', String(error.retryAfterSeconds));
    }
    if (status >= 500 && services.logger?.error) services.logger.error('request.failed', { code });
    if (status >= 500 && services.externalIntegrationsEnabled === true && services.notify) {
      try { await services.notify('system_error'); } catch { /* The outbox preserves retryable notification failures. */ }
    }
    return res.status(status).json({ error: code });
  });
  return app;
}

module.exports = { createServer, COOKIE };
