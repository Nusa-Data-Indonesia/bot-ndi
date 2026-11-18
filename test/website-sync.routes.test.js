'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');

function request(server, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ host: '127.0.0.1', port: address.port, path, method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function close(server) {
  return new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
}

test('manual website sync and per-item review require an authenticated CSRF-protected admin action', async (t) => {
  let syncCalls = 0;
  const reviewCalls = [];
  const repository = {
    getWebsiteSyncState: async () => ({ knowledgeVersion: 3, runs: [], proposals: [] }),
    reviewWebsiteKnowledgeProposal: async (...args) => { reviewCalls.push(args); return { status: 'conflict', code: 'KNOWLEDGE_VERSION_CHANGED' }; },
  };
  const auth = { authenticate: async (token) => token === 'session-token'
    ? { admin: { id: 7 }, csrfToken: 'csrf-token-123456789012345678901234567890123456' } : null };
  const config = { nodeEnv: 'test', baseUrl: 'http://127.0.0.1', tebar: {} };
  const app = createServer({ config, repository, auth, services: {
    synchronizeNdiWebsite: async (input) => { syncCalls++; return { proposalCount: 1, actor: input.adminId }; },
  } });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => close(server));
  config.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = 'bot_ndi_admin=session-token';
  const authHeaders = { cookie };
  const mutationHeaders = { ...authHeaders, origin: config.baseUrl, 'x-csrf-token': 'csrf-token-123456789012345678901234567890123456' };

  assert.equal((await request(server, '/api/website-sync')).status, 401);
  assert.equal((await request(server, '/api/website-sync', { headers: authHeaders })).status, 200);
  assert.equal((await request(server, '/api/website-sync', { method: 'POST', headers: { ...authHeaders, origin: config.baseUrl }, body: '{}' })).status, 403);
  assert.equal(syncCalls, 0, 'missing CSRF must not trigger network retrieval');
  const started = await request(server, '/api/website-sync', {
    method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ url: 'https://attacker.example.test/redirect', ctaUrl: 'https://other.example.test' }),
  });
  assert.equal(started.status, 200, started.body);
  assert.deepEqual(JSON.parse(started.body), { proposalCount: 1, actor: 7 });
  assert.equal(syncCalls, 1, 'one explicit admin request starts exactly one sync operation');

  const stale = await request(server, '/api/website-sync/proposals/42/approve', { method: 'POST', headers: mutationHeaders, body: '{}' });
  assert.equal(stale.status, 409);
  assert.deepEqual(JSON.parse(stale.body), { error: 'WEBSITE_SYNC_CONFLICT', conflictCode: 'KNOWLEDGE_VERSION_CHANGED' });
  assert.deepEqual(reviewCalls, [['42', 'approve', 7]]);
  assert.equal(syncCalls, 1, 'review actions never start another fetch');
});
