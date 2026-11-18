'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');
const { buildContentContext } = require('../src/content-context');
const { validateNdiCaption } = require('../src/content-validation');
const { validateNdiSettings } = require('../src/ndi-settings');

const ctaUrl = 'https://ndi.example.test/contact';
const checked = validateNdiSettings({
  hashtags: ['#NusaDataIndonesia'],
  businessKnowledge: { ...DEFAULT_NDI_KNOWLEDGE, ctaUrl },
});
const settings = checked.settings;

test('NDI prompt context contains approved business services and excludes legacy product pricing', () => {
  const now = '2026-11-08T00:00:00.000Z';
  const source = buildContentContext({
    now,
    history: [{ status: 'published', pillar: 'topup', caption: 'RAHASIA-RIWAYAT-LEGACY', completedAt: now }],
    facts: [{ id: 'legacy-topup', pillar: 'topup', game: 'Mobile Legends', price: 'RAHASIA-HARGA-LEGACY', active: true, updatedAt: now }],
  }, settings);
  assert.equal(source.pillar, 'ndi');
  assert.equal(source.ctaUrl, ctaUrl);
  assert.ok(source.facts.some((fact) => fact.kind === 'service' && fact.name === 'Analitik data'));
  assert.ok(source.facts.some((fact) => fact.kind === 'product' && fact.name === 'NDI Ticketing'));
  assert.doesNotMatch(JSON.stringify(source), /RAHASIA-|Mobile Legends|top-up/iu);
  assert.deepEqual(source.recentCaptions, []);
});

test('NDI deterministic validation rejects unsupported amounts and names while allowing service content without price rules', () => {
  const caption = 'Analitik data dapat membantu organisasi memahami informasi. Mari diskusikan solusi teknologi untuk tim Anda.';
  const suffix = `\n#NusaDataIndonesia\n${ctaUrl}`;
  assert.equal(validateNdiCaption(`${caption}${suffix}`, {
    ctaUrl, hashtags: settings.hashtags, forbiddenClaims: settings.businessKnowledge.forbiddenClaims,
  }).valid, true);
  for (const body of [
    'Kami memiliki 20 klien. Mari diskusikan layanan data untuk organisasi Anda.',
    'Pemain game top-up Mobile Legends. Mari diskusikan layanan data untuk bisnis Anda.',
  ]) {
    const result = validateNdiCaption(`${body}${suffix}`, {
      ctaUrl, hashtags: settings.hashtags, forbiddenClaims: settings.businessKnowledge.forbiddenClaims,
    });
    assert.equal(result.valid, false, body);
    assert.ok(result.errors.some((code) => ['UNSUPPORTED_NUMERIC_CLAIM', 'LEGACY_BUSINESS_CONTENT'].includes(code)));
  }
});
