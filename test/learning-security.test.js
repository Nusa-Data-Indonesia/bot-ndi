'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

test('archived learning endpoints cannot access persisted content from the active NDI server', async () => {
  const app = createServer({ config: { nodeEnv: 'test', baseUrl: 'http://localhost', tebar: {} }, repository: {}, auth: {} });
  const paths = app.router.stack.flatMap((layer) => layer.route && typeof layer.route.path === 'string' ? [layer.route.path] : []);
  assert.equal(paths.some((path) => path.startsWith('/api/learning')), false);
  assert.equal(paths.some((path) => path.startsWith('/api/templates')), false);
});
