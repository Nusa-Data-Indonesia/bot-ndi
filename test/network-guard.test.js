'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

test('test network guard blocks provider destinations while permitting local fixtures', async (t) => {
  await assert.rejects(fetch('https://openrouter.ai/api/v1/chat/completions'), (error) => error.code === 'EXTERNAL_NETWORK_BLOCKED');
  assert.equal(net.connect.name, 'guardedNetConnect');
  assert.throws(() => net.connect(443, '203.0.113.1'), (error) => error.code === 'EXTERNAL_NETWORK_BLOCKED');

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('local fixture');
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/fixture`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'local fixture');
});
