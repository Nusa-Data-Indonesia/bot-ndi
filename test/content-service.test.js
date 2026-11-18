'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');
const { generatePost } = require('../src/content-service');

const ctaUrl = 'https://public.example.test/ndi?source=threads';
const now = '2026-11-05T04:00:00Z';
const businessKnowledge = { ...DEFAULT_NDI_KNOWLEDGE, ctaUrl };
const settings = {
  schedule: { intervalMinutes: 180, timezone: 'Asia/Jakarta' },
  hashtags: ['#NusaDataIndonesia', '#TeknologiData'],
  businessKnowledge,
};
const base = {
  now,
  settings,
  businessKnowledgeApproved: true,
  facts: [
    { id: 'legacy-topup', pillar: 'topup', game: 'Mobile Legends', price: 'RAHASIA-HARGA-LEGACY', denomination: 'RAHASIA-ITEM-LEGACY' },
    { id: 'legacy-account', pillar: 'account', game: 'RAHASIA-GAME-LEGACY', attributes: ['RAHASIA-ATTR-LEGACY'] },
  ],
  history: [
    { status: 'published', pillar: 'topup', caption: 'RAHASIA-CAPTION-MERZZ: Mobile Legends top-up', completedAt: now },
    { status: 'published', pillar: 'ndi', caption: 'Informasi data membantu organisasi melihat konteks. Mari diskusikan kebutuhan teknologi Anda.', completedAt: now },
  ],
};
const caption = 'Informasi yang tertata membantu tim memahami pola yang relevan. Mari diskusikan kebutuhan data dan solusi teknologi untuk organisasi Anda.';

function mockGeneration(text = caption, audit = { valid: true, factIds: [] }) {
  const requests = [];
  return {
    requests,
    generate: async (request) => {
      requests.push(request);
      return request.system.includes('auditor fakta independen') ? JSON.stringify(audit) : text;
    },
  };
}

test('requires explicit review of NDI business knowledge before using the model', async () => {
  const mock = mockGeneration();
  const result = await generatePost({ ...base, businessKnowledgeApproved: false }, mock);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'BUSINESS_KNOWLEDGE_REVIEW_REQUIRED');
  assert.equal(result.attempts, 0);
  assert.equal(mock.requests.length, 0);
});

test('generates an NDI caption, appends required hashtags and puts the exact configured CTA last', async () => {
  const mock = mockGeneration();
  const result = await generatePost(base, mock);
  assert.equal(result.status, 'ready');
  assert.equal(result.text, `${caption}\n#NusaDataIndonesia #TeknologiData\n${ctaUrl}`);
  assert.equal(result.pillar, 'ndi');
  assert.equal(result.factBearing, false);
  assert.deepEqual(result.factIds, []);
  assert.equal(mock.requests.length, 2);
  assert.match(mock.requests[0].system, /Nusa Data Indonesia/);
  assert.match(mock.requests[0].system, /Jangan mengarang nama klien, testimoni, hasil terukur/);
  assert.match(mock.requests[0].system, /ilustrasi hipotetis harus diawali kata “Ilustrasi:”/);
  assert.match(mock.requests[1].system, /Tolak klaim klien, testimoni, hasil/);
  assert.match(mock.requests[0].user, /Pengembangan perangkat lunak kustom/);
  assert.match(mock.requests[0].user, /MVP pilot undangan/);
  assert.match(mock.requests[0].user, /Mari diskusikan kebutuhan teknologi Anda/);
  assert.match(mock.requests[0].user, /maxCaptionCharacters/);
  assert.doesNotMatch(mock.requests[0].user, /RAHASIA-|Kedai\s*Merzz|Mobile Legends|top-up/iu);
  assert.doesNotMatch(mock.requests[1].user, /RAHASIA-|approvedLearningMemory/iu);
});

test('does not retrieve learning rules or snapshot legacy fact context for NDI generation', async () => {
  let retrievalCalls = 0;
  let snapshotCalls = 0;
  const mock = mockGeneration();
  const result = await generatePost(base, {
    ...mock,
    learningFlags: { activationEnabled: true, retrievalEnabled: true, promptIntegrationEnabled: true },
    learningStore: { retrieveActiveRules: async () => { retrievalCalls++; throw new Error('must not retrieve legacy rules'); } },
    attributionStore: { recordGenerationSnapshot: async () => { snapshotCalls++; } },
  });
  assert.equal(result.status, 'ready');
  assert.equal(retrievalCalls, 0);
  assert.equal(snapshotCalls, 0);
});

test('accepts an arbitrary safe HTTPS CTA without a host allowlist', async () => {
  const customCta = 'https://unrelated.example:8443/contact/ndi?from=Threads';
  const mock = mockGeneration();
  const result = await generatePost({ ...base, settings: { ...settings, businessKnowledge: { ...businessKnowledge, ctaUrl: customCta } } }, mock);
  assert.equal(result.status, 'ready');
  assert.equal(result.text.split('\n').at(-1), customCta);
});

test('rejects unsafe or malformed CTA values before making an AI request', async () => {
  for (const value of [
    'http://example.test/contact',
    'javascript:alert(1)',
    'https://user:secret@example.test/contact',
    'https://example.test/with space',
    'https://example.test/%0d%0aInjected',
  ]) {
    const mock = mockGeneration();
    const result = await generatePost({ ...base, settings: { ...settings, businessKnowledge: { ...businessKnowledge, ctaUrl: value } } }, mock);
    assert.equal(result.status, 'skipped', value);
    assert.equal(result.reason, 'INVALID_SETTINGS', value);
    assert.equal(mock.requests.length, 0, value);
  }
});

test('ignores old history and facts when constructing the NDI prompt', async () => {
  const mock = mockGeneration();
  const result = await generatePost(base, mock);
  const prompt = JSON.parse(mock.requests[0].user);
  assert.equal(result.status, 'ready');
  assert.deepEqual(prompt.recentCaptions, [base.history[1].caption]);
  assert.equal(Object.hasOwn(prompt, 'facts'), true);
  assert.ok(prompt.facts.every((fact) => fact.id.startsWith('service-') || fact.id.startsWith('product-') || fact.id.startsWith('claim-')));
  assert.doesNotMatch(JSON.stringify(prompt), /RAHASIA-|Kedai\s*Merzz|Mobile Legends|top-up/iu);
});

test('fails closed on game, top-up, unsupported numeric, private and unrelated URL content', async () => {
  const rejected = [
    'Kami menjual game top-up. Mari diskusikan teknologi data untuk organisasi Anda.',
    'Kami memiliki 20 klien. Mari diskusikan layanan data untuk bisnis Anda.',
    'Hubungi pelanggan@example.test. Mari diskusikan layanan data untuk tim Anda.',
    'Kunjungi https://evil.example.test sekarang. Mari diskusikan layanan data untuk tim Anda.',
    'Kami berpengalaman dalam data dan teknologi.',
  ];
  for (const text of rejected) {
    const mock = mockGeneration(text);
    const result = await generatePost(base, mock);
    assert.equal(result.status, 'skipped', text);
    assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED', text);
    assert.equal(result.text, undefined, text);
  }
});

test('requires hypothetical business scenarios to start with the illustration label', async () => {
  const unlabelled = 'Bayangkan sebuah perusahaan yang kesulitan memahami datanya. Mari diskusikan kebutuhan sistem dan teknologi untuk organisasi Anda.';
  const rejected = await generatePost(base, mockGeneration(unlabelled));
  assert.equal(rejected.status, 'skipped');
  assert.ok(rejected.errors.includes('UNLABELED_HYPOTHETICAL_SCENARIO'));

  const labelled = `Ilustrasi: ${unlabelled}`;
  const accepted = await generatePost(base, mockGeneration(labelled));
  assert.equal(accepted.status, 'ready');
  assert.match(accepted.text, /^Ilustrasi:/u);
});

test('rejects content without an invitation tied to NDI services or business needs', async () => {
  for (const text of [
    'Informasi yang tertata membantu tim memahami pola data dan teknologi.',
    'Mari berbagi cerita tentang akhir pekan bersama teman.',
  ]) {
    const result = await generatePost(base, mockGeneration(text));
    assert.equal(result.status, 'skipped', text);
    assert.ok(result.errors.includes('MISSING_CONTEXTUAL_INVITATION'), text);
  }
});

test('semantic audit rejection prevents content from becoming ready', async () => {
  const result = await generatePost(base, mockGeneration(caption, { valid: false, factIds: [] }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED');
  assert.equal(result.text, undefined);
});

test('malformed or ambiguous semantic audit is recorded as unknown and fails closed', async () => {
  for (const audit of ['not-json', '{"valid":true}', '{"valid":true,"factIds":["invented"]}']) {
    let call = 0;
    const result = await generatePost(base, { generate: async (request) => {
      if (!request.system.includes('auditor fakta independen')) return caption;
      call++;
      return audit;
    } });
    assert.equal(result.status, 'skipped', audit);
    assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED', audit);
    assert.equal(result.text, undefined, audit);
    assert.ok(call > 0, audit);
  }
});

test('a failed first content attempt can retry without truncating and retains correction context', async () => {
  const requests = [];
  let generationCalls = 0;
  const result = await generatePost(base, { generate: async (request) => {
    requests.push(request);
    if (request.system.includes('auditor fakta independen')) return JSON.stringify({ valid: true, factIds: [] });
    generationCalls++;
    return generationCalls === 1 ? 'A'.repeat(501) : caption;
  } });
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2);
  assert.ok([...result.text].length <= 500);
  assert.ok(JSON.parse(requests.at(-2).user).correction.includes('CAPTION_TOO_LONG'));
  assert.equal(requests.at(-2).maxTokens, requests[0].maxTokens);
});

test('capture and outcome hooks cannot block validation or reveal generated private data', async () => {
  const findings = [];
  const outcomes = [];
  let generationCalls = 0;
  const result = await Promise.race([
    generatePost({ ...base, slot: { id: 'slot-capture', model: 'test/model', configVersion: '1' } }, {
      generate: async (request) => {
        if (request.system.includes('auditor fakta independen')) return JSON.stringify({ valid: true, factIds: [] });
        return ++generationCalls === 1 ? 'Kami memiliki 20 klien. Mari diskusikan layanan data untuk tim Anda.' : caption;
      },
      captureFailure: (event) => { findings.push(event); return new Promise(() => {}); },
      recordOutcome: (event) => { outcomes.push(event); throw new Error('optional observation unavailable'); },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('optional hook blocked generation')), 250)),
  ]);
  assert.equal(result.status, 'ready');
  assert.ok(findings.some((finding) => finding.findingId === 'UNSUPPORTED_NUMERIC_CLAIM'));
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes('20 klien')));
  assert.deepEqual(outcomes.map((item) => item.outcome), ['CONTEXTUAL_FAILED', 'PASSED']);
});

test('attempt reservations, transitions and retry ordinals remain durable for NDI', async () => {
  const records = [];
  let id = 0;
  const result = await generatePost({ ...base, slot: { id: 'slot-attempts', model: 'test/model', configVersion: '4' } }, {
    generate: async (request) => request.system.includes('auditor fakta independen')
      ? JSON.stringify({ valid: true, factIds: [] })
      : (++id === 1 ? 'Kami memiliki 20 klien. Mari diskusikan layanan data untuk tim Anda.' : caption),
    attemptLifecycle: {
      reserve: async (reservation) => { records.push({ type: 'reserve', ...reservation }); return { attempt_id: `attempt-${records.length}`, state: 'reserved' }; },
      transition: async (attemptId, state, details = {}) => { records.push({ type: 'transition', attemptId, state, ...details }); },
    },
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(records.filter((item) => item.type === 'reserve').map((item) => item.operationId), ['slot-attempts:gen:1', 'slot-attempts:gen:2']);
  assert.deepEqual(records.filter((item) => item.type === 'transition').map((item) => item.state), [
    'generating', 'validating', 'contextual_failed', 'generating', 'validating', 'validating', 'passed',
  ]);
});

test('provider failures are normalized without exposing provider details', async () => {
  const result = await generatePost(base, { generate: async () => {
    throw Object.assign(new Error('private-provider-body'), { provider: 'openrouter', code: 'network_error', transportCode: 'ETIMEDOUT', status: null, timedOut: true });
  } });
  assert.equal(result.status, 'skipped');
  assert.equal(result.diagnosticCode, 'ai_network_error');
  assert.deepEqual(result.providerFailure, { provider: 'openrouter', code: 'network_error', httpStatus: null, transportCode: 'ETIMEDOUT', timedOut: true });
  assert.doesNotMatch(JSON.stringify(result), /private-provider-body/);
});
