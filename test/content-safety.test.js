'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { contentSafetyHash } = require('../src/content-safety');
const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');

const settings = {
  schedule: { intervalMinutes: 15, timezone: 'Asia/Jakarta' },
  hashtags: ['#NusaDataIndonesia'],
  businessKnowledge: { ...DEFAULT_NDI_KNOWLEDGE, ctaUrl: 'https://ndi.example.test/contact' },
};

test('schedule and CTA edits do not invalidate a prepared content snapshot', () => {
  const original = contentSafetyHash(settings);
  assert.equal(contentSafetyHash({ ...settings, schedule: { intervalMinutes: 135, timezone: 'UTC' } }), original);
  assert.equal(contentSafetyHash({
    ...settings,
    businessKnowledge: { ...settings.businessKnowledge, ctaUrl: 'https://another.example.test/contact' },
  }), original);
});

test('business knowledge and hashtags invalidate a prepared content snapshot', () => {
  const original = contentSafetyHash(settings);
  assert.notEqual(contentSafetyHash({
    ...settings,
    businessKnowledge: { ...settings.businessKnowledge, services: ['Layanan yang berubah'] },
  }), original);
  assert.notEqual(contentSafetyHash({ ...settings, hashtags: ['#NDI'] }), original);
});
