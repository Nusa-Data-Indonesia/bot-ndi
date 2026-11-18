'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_NDI_KNOWLEDGE } = require('../src/business-knowledge');
const { buildContentContext } = require('../src/content-context');
const { validateNdiSettings } = require('../src/ndi-settings');

const settings = validateNdiSettings({ businessKnowledge: DEFAULT_NDI_KNOWLEDGE, hashtags: ['#NusaDataIndonesia'] }).settings;

test('content context always uses NDI pillar and does not select legacy creative topics', () => {
  const source = buildContentContext({
    now: '2026-11-05T05:00:00Z',
    facts: [{ id: 'topup', pillar: 'topup', game: 'Mobile Legends', price: '30' }],
    history: [
      { status: 'published', pillar: 'topup', caption: 'RAHASIA-TOPUP-TERBARU', completedAt: '2026-11-05T04:00:00Z' },
      { status: 'failed', pillar: 'ndi', caption: 'RAHASIA-POST-GAGAL', completedAt: '2026-11-05T03:00:00Z' },
      { status: 'published', pillar: 'ndi', caption: 'Tim membutuhkan konteks data yang jelas.', completedAt: '2026-11-05T02:00:00Z' },
    ],
  }, settings);
  assert.equal(source.pillar, 'ndi');
  assert.equal(Object.hasOwn(source, 'creativeDirection'), false);
  assert.deepEqual(source.recentCaptions, ['Tim membutuhkan konteks data yang jelas.']);
  assert.doesNotMatch(JSON.stringify(source), /RAHASIA-|Mobile Legends|top-up/iu);
});

test('only the five most recent published NDI captions influence anti-repetition checks', () => {
  const history = Array.from({ length: 8 }, (_, index) => ({
    status: 'published', pillar: 'ndi', caption: `Caption data ${index}`,
    completedAt: new Date(Date.UTC(2026, 10, 5) + index * 60_000).toISOString(),
  }));
  history.push({ status: 'draft', pillar: 'ndi', caption: 'DRAF-RAHASIA', completedAt: '2026-11-06T00:00:00Z' });
  const source = buildContentContext({ history }, settings);
  assert.deepEqual(source.recentCaptions, ['Caption data 7', 'Caption data 6', 'Caption data 5', 'Caption data 4', 'Caption data 3']);
  assert.doesNotMatch(JSON.stringify(source), /DRAF-RAHASIA/);
});
