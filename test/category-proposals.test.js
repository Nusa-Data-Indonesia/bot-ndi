'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCategoryProposalRunner, parseCategoryProposals } = require('../src/category-proposals');

test('proposal parser accepts only bounded, valid category suggestions and removes duplicates', () => {
  const parsed = parseCategoryProposals(JSON.stringify({ proposals: [
    { name: 'Kebiasaan Data', guidance: 'Bahas pertanyaan umum tentang kebiasaan mengelola informasi.' },
    { name: 'Kebiasaan Data', guidance: 'Duplikat yang tidak dipertahankan.' },
    { name: '   ', guidance: 'Tidak valid.' },
    ...Array.from({ length: 5 }, (_, index) => ({ name: `Kategori ${index}`, guidance: 'Panduan umum.' })),
  ] }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Kebiasaan Data');
});

test('proposal parser rejects invalid JSON, malformed response, and empty result', () => {
  for (const value of ['{bad', JSON.stringify({ category: 'x' }), JSON.stringify({ proposals: [] })]) {
    assert.throws(() => parseCategoryProposals(value), (error) => ['proposal_invalid_response', 'proposal_empty'].includes(error.code));
  }
});

test('disabled or not-due proposal jobs do not call OpenRouter', async () => {
  let calls = 0;
  const run = createCategoryProposalRunner({ repository: {
    claimCategoryProposalRun: async () => null,
    finishCategoryProposalRun: async () => assert.fail('nothing should be persisted'),
  }, generate: async () => { calls++; return ''; } });
  assert.deepEqual(await run(), { skipped: 'not_due' });
  assert.equal(calls, 0);
});

test('proposal job makes one bounded AI call and only records pending suggestions', async () => {
  const calls = [];
  const finished = [];
  const run = createCategoryProposalRunner({
    repository: {
      claimCategoryProposalRun: async () => ({ token: 'lease', model: 'configured-model', categories: [], knowledge: { positioning: 'Data', services: ['Sistem informasi'] } }),
      finishCategoryProposalRun: async (input) => { finished.push(input); return true; },
    },
    generate: async (request, model) => {
      calls.push({ request, model });
      return JSON.stringify({ proposals: [{ name: 'Diskusi Data', guidance: 'Ajukan pertanyaan umum tentang penggunaan informasi.' }] });
    },
    clock: () => new Date('2026-11-18T00:00:00.000Z'),
  });
  assert.deepEqual(await run(), { created: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'configured-model');
  assert.equal(calls[0].request.maxTokens, 400);
  assert.equal(calls[0].request.temperature, 0);
  assert.deepEqual(finished[0].proposals.map((item) => item.name), ['Diskusi Data']);
  assert.equal(finished[0].token, 'lease');
});

test('proposal failure is recorded once and does not escape into the publishing scheduler', async () => {
  const finished = [];
  const errors = [];
  const run = createCategoryProposalRunner({
    repository: {
      claimCategoryProposalRun: async () => ({ token: 'lease', model: 'configured-model', categories: [], knowledge: {} }),
      finishCategoryProposalRun: async (input) => { finished.push(input); return true; },
    },
    generate: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'network_error' }); },
    logger: { error: (event, details) => errors.push({ event, details }) },
  });
  assert.deepEqual(await run(), { failed: 'network_error' });
  assert.equal(finished.length, 1);
  assert.equal(finished[0].errorCode, 'network_error');
  assert.ok(errors.some((entry) => entry.event === 'category_proposal.failed'));
});
