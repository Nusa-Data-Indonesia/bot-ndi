'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');
const { generatePost } = require('../src/content-service');
const { validateNdiCaption } = require('../src/content-validation');

const ctaUrl = 'https://public.example.test/ndi';
const validCaption = 'Informasi yang tertata membantu tim memahami pola yang relevan. Mari diskusikan kebutuhan data dan solusi teknologi untuk organisasi Anda.';
const completeValidCaption = `${validCaption}\n#NusaDataIndonesia\n${ctaUrl}`;
const invalidCaption = 'Kami memiliki 23 klien. Mari diskusikan kebutuhan data dan solusi teknologi untuk organisasi Anda.';
const category = { id: 'category-1', slug: 'edukasi-data-teknologi', name: 'Edukasi Data & Teknologi', guidance: 'Edukasi data.' };
const style = { id: 'style-1', slug: 'korporat-profesional', name: 'Korporat profesional', instructions: 'Ringkas dan profesional.' };
const settings = {
  schedule: { intervalMinutes: 60, timezone: 'Asia/Jakarta' },
  hashtags: ['#NusaDataIndonesia'],
  businessKnowledge: { ...DEFAULT_NDI_KNOWLEDGE, ctaUrl },
};
const context = {
  settings,
  businessKnowledgeApproved: true,
  businessKnowledgeVersion: 3,
  slot: { id: 'slot-dual-ai', model: 'generator/model', reviewerModel: 'reviewer/model', modelVersion: 9,
    contentStrategy: { category, style } },
  history: [],
  facts: [],
};

function mockProviders({ draft = validCaption, reviewerResponses = [] } = {}) {
  const calls = { generatorDrafts: 0, semanticAudits: 0, reviewer: [] };
  let nextReview = 0;
  return {
    calls,
    generate: async (request) => {
      if (request.system.includes('auditor fakta independen')) {
        calls.semanticAudits++;
        return JSON.stringify({ valid: true, factIds: [] });
      }
      calls.generatorDrafts++;
      return draft;
    },
    review: async (request) => {
      calls.reviewer.push(request);
      const response = reviewerResponses[nextReview++];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test('deterministic violations expose stable code, path, repairability and safe description', () => {
  const result = validateNdiCaption(`${invalidCaption}\n#NusaDataIndonesia\n${ctaUrl}`, {
    ctaUrl,
    hashtags: ['#NusaDataIndonesia'],
    forbiddenClaims: [],
  });

  assert.equal(result.valid, false);
  assert.ok(result.violations.some((violation) => violation.code === 'UNSUPPORTED_NUMERIC_CLAIM'
    && violation.path === 'caption.body' && violation.repairability === 'repairable_content'
    && typeof violation.description === 'string' && violation.description.length > 0));
  assert.doesNotMatch(JSON.stringify(result.violations), /23 klien|public\.example/i);
});

test('valid Generator draft skips the conditional Reviewer and retains the existing semantic audit', async () => {
  const providers = mockProviders();
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'ready');
  assert.equal(providers.calls.generatorDrafts, 1);
  assert.equal(providers.calls.semanticAudits, 1);
  assert.equal(providers.calls.reviewer.length, 0);
  assert.equal(result.reviewed, false);
});

test('repairable validation failures send the complete violation set to Reviewer and revalidate its revision', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: [JSON.stringify({
    decision: 'REVISE',
    revised_content: completeValidCaption,
    rationale_code: 'REMOVED_UNSUPPORTED_CLAIM',
  })] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'ready');
  assert.equal(result.reviewed, true);
  assert.equal(providers.calls.generatorDrafts, 1);
  assert.equal(providers.calls.reviewer.length, 1);
  assert.equal(providers.calls.semanticAudits, 1);
  const reviewInput = JSON.parse(providers.calls.reviewer[0].user);
  assert.equal(reviewInput.draft, `${invalidCaption}\n#NusaDataIndonesia\n${ctaUrl}`);
  assert.ok(reviewInput.violations.some((violation) => violation.code === 'UNSUPPORTED_NUMERIC_CLAIM'));
  assert.deepEqual(reviewInput.category, category);
  assert.deepEqual(reviewInput.style, style);
  assert.equal(reviewInput.businessKnowledge.companyName, DEFAULT_NDI_KNOWLEDGE.companyName);
});

test('two invalid substantive Reviewer revisions exhaust the slot without publishing-ready content', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: [
    JSON.stringify({ decision: 'REVISE', revised_content: invalidCaption, rationale_code: 'REVISE_AGAIN' }),
    JSON.stringify({ decision: 'PASS', revised_content: invalidCaption, rationale_code: 'STILL_INVALID' }),
  ] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED');
  assert.equal(result.reviewed, false);
  assert.equal(providers.calls.generatorDrafts, 1);
  assert.equal(providers.calls.reviewer.length, 2);
  assert.equal(providers.calls.semanticAudits, 0);
});

test('Reviewer PASS cannot bypass deterministic revalidation of its invalid revision', async () => {
  const invalidPass = JSON.stringify({ decision: 'PASS', revised_content: invalidCaption, rationale_code: 'UNSUPPORTED_CLAIM_REMAINS' });
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: [invalidPass, invalidPass] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reviewed, false);
  assert.equal(providers.calls.reviewer.length, 2);
  assert.ok(result.reviewAttempts.some((attempt) => attempt.decision === 'PASS'
    && attempt.violations.length > 0));
  assert.equal(providers.calls.semanticAudits, 0);
});

test('Reviewer exception receives one bounded technical retry and fails closed', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: [
    new Error('secret provider response'), new Error('secret provider response'),
  ] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reviewed, false);
  assert.equal(providers.calls.reviewer.length, 2);
  assert.equal(result.reviewAttempts.length, 2);
  assert.equal(result.reviewAttempts.at(-1).decision, 'ERROR');
  assert.doesNotMatch(JSON.stringify(result), /secret provider response/);
});

test('Reviewer receives multiple deterministic failures in one batch and fixes them without rewriting', async () => {
  const providers = mockProviders({ draft: `${'A'.repeat(510)} https://unapproved.example.test`, reviewerResponses: [JSON.stringify({
    decision: 'REVISE', revised_content: completeValidCaption, rationale_code: 'REPAIRED_VALIDATION_ERRORS',
  })] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'ready');
  const codes = JSON.parse(providers.calls.reviewer[0].user).violations.map((violation) => violation.code);
  for (const code of ['CAPTION_TOO_LONG', 'UNAPPROVED_LINK', 'DUPLICATE_LINK', 'MISSING_CONTEXTUAL_INVITATION']) {
    assert.ok(codes.includes(code), code);
  }
  assert.equal(result.text, completeValidCaption);
});

test('malformed Reviewer output gets one technical retry before a passing revision', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: ['not-json', JSON.stringify({
    decision: 'PASS', revised_content: completeValidCaption, rationale_code: 'REMOVED_UNSUPPORTED_CLAIM',
  })] });
  const result = await generatePost(context, providers);
  assert.equal(result.status, 'ready');
  assert.equal(result.reviewed, true);
  assert.equal(providers.calls.reviewer.length, 2);
  assert.equal(result.reviewMetadata.revisionCount, 1);
});

test('malformed Reviewer output fails closed after one technical retry', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: ['not-json', 'still-not-json'] });
  const result = await generatePost(context, providers);

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'CONTENT_VALIDATION_FAILED');
  assert.equal(result.reviewed, false);
  assert.equal(providers.calls.reviewer.length, 2);
  assert.equal(result.reviewAttempts.length, 2);
});

test('explicit Reviewer rejection fails closed without another revision', async () => {
  const providers = mockProviders({ draft: invalidCaption, reviewerResponses: [JSON.stringify({ decision: 'REJECT', rationale_code: 'UNSAFE_TO_REPAIR' })] });
  const result = await generatePost(context, providers);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reviewed, false);
  assert.equal(providers.calls.reviewer.length, 1);
  assert.equal(result.reviewAttempts[0].decision, 'REJECT');
});

test('nonrepairable configuration violations never invoke Reviewer', async () => {
  const providers = mockProviders();
  const result = await generatePost({ ...context, settings: { ...settings,
    businessKnowledge: { ...settings.businessKnowledge, ctaUrl: 'http://unsafe.example.test' } } }, providers);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'INVALID_SETTINGS');
  assert.equal(providers.calls.generatorDrafts, 0);
  assert.equal(providers.calls.reviewer.length, 0);
});
