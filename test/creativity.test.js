'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContentContext } = require('../src/content-context');
const { validateSettings } = require('../src/policy');
const { generatePost } = require('../src/content-service');

const settings = validateSettings({ brand: { name: 'Toko Contoh', voice: 'mesra', contentDirection: 'Utamakan suara komunitas' }, gameWhitelist: ['Mobile Legends'], hashtags: ['#Game'], trackedLinks: { topup: 'https://shop.example.test/t', account: 'https://shop.example.test/a' } }, { allowedCtaHosts: ['shop.example.test'] }).settings;
const published = (caption, index = 0) => ({ status: 'published', pillar: 'topup', caption, completedAt: `2026-11-05T0${index}:00:00Z` });

test('creative theme suggestions rotate from published history without changing business pillar', () => {
  const context = { now: '2026-11-05T05:00:00Z', facts: [], history: [] };
  const first = buildContentContext(context, settings);
  const second = buildContentContext({ ...context, history: [published('Periksa panduan sebelum memilih.')] }, settings);
  assert.equal(first.pillar, 'topup');
  assert.equal(second.pillar, 'account');
  assert.notEqual(first.creativeDirection.suggestedTheme, second.creativeDirection.suggestedTheme);
  assert.notEqual(second.creativeDirection.suggestedTheme, 'edukasi');
});

test('failed history and unrelated tags do not bias suggestions', () => {
  const base = { now: '2026-11-05T05:00:00Z', facts: [], history: [published('Seronok main bersama kawan! #kedai https://example.test/kedai')] };
  const same = { ...base, history: [...base.history, { status: 'failed', pillar: 'account', caption: 'Periksa tips sebelum transaksi.' }] };
  assert.deepEqual(buildContentContext(base, settings).creativeDirection, buildContentContext(same, settings).creativeDirection);
});

test('Indonesian heuristic vocabulary maps to the same creative theme categories', () => {
  const captions = [
    ['edukasi', 'Panduan belajar sebelum bermain.'],
    ['diskusi komunitas', 'Berbagi pendapat dalam komunitas.'],
    ['pengamatan gamer', 'Kebiasaan pemain biasanya berubah.'],
    ['situasi gaming relatable', 'Pernah mengalami situasi ini?'],
    ['kesadaran merek', 'Merek toko menyediakan layanan.'],
    ['membangun kepercayaan', 'Transparan dalam transaksi dan keamanan.'],
  ];
  for (const [theme, caption] of captions) {
    const others = captions.filter(([otherTheme]) => otherTheme !== theme)
      .map(([otherTheme, otherCaption], index) => published(otherCaption, index));
    const baseline = buildContentContext({ now: '2026-11-05T05:00:00Z', facts: [], history: others }, settings);
    assert.equal(baseline.creativeDirection.suggestedTheme, theme);
    const withThemeMatches = buildContentContext({
      now: '2026-11-05T05:00:00Z', facts: [],
      history: [...others, published(caption, 5), published(caption, 6)],
    }, settings);
    assert.notEqual(withThemeMatches.creativeDirection.suggestedTheme, theme);
  }
});

test('each Indonesian creative theme retains its canonical learning topic ID', async () => {
  const cases = [
    ['edukasi', 'education', 'Panduan belajar sebelum bermain.'],
    ['diskusi komunitas', 'community', 'Berbagi pendapat dalam komunitas.'],
    ['pengamatan gamer', 'gamer_observation', 'Kebiasaan pemain biasanya berubah.'],
    ['situasi gaming relatable', 'relatable_situation', 'Pernah mengalami situasi ini?'],
    ['kesadaran merek', 'brand_awareness', 'Merek toko menyediakan layanan.'],
    ['membangun kepercayaan', 'trust', 'Transparan dalam transaksi dan keamanan.'],
  ];
  for (const [theme, topicId] of cases) {
    const history = cases.filter(([otherTheme]) => otherTheme !== theme)
      .map(([, , caption], index) => published(caption, index));
    let retrievedTopic;
    const result = await generatePost({ now: '2026-11-05T05:00:00Z', facts: [], history, settings }, {
      allowedCtaHosts: ['shop.example.test'],
      learningFlags: { activationEnabled: true, retrievalEnabled: true, promptIntegrationEnabled: true },
      learningStore: { retrieveActiveRules: async ({ contentTopic }) => {
        retrievedTopic = contentTopic;
        return { rules: [], omissions: [], context: {} };
      } },
      generate: async (request) => request.system.includes('auditor bebas')
        ? JSON.stringify({ valid: true, factIds: [] })
        : 'Pemain menikmati permainan bersama teman.',
    });
    assert.equal(result.status, 'ready');
    assert.equal(retrievedTopic, topicId);
  }
});

test('tie-breaking continues to change when published history reaches its 1000-slot limit', () => {
  const history = Array.from({ length: 1000 }, (_, i) => ({
    id: `slot-${i}`, status: 'published', pillar: 'topup', caption: 'Permainan menarik.',
    completedAt: new Date(Date.UTC(2026, 10, 1) + i * 3600000).toISOString(),
  }));
  const first = { now: '2026-12-30T00:00:00Z', facts: [], history };
  const second = { ...first, history: [...history.slice(1), {
    id: 'slot-1000', status: 'published', pillar: 'topup', caption: 'Permainan menarik.',
    completedAt: new Date(Date.UTC(2026, 10, 1) + 1000 * 3600000).toISOString(),
  }] };
  assert.equal(second.history.length, 1000);
  assert.notEqual(buildContentContext(first, settings).creativeDirection.suggestedTheme,
    buildContentContext(second, settings).creativeDirection.suggestedTheme);
});

test('generation receives flexible creative advice while auditor receives only factual context', async () => {
  const calls = [];
  const result = await generatePost({ now: '2026-11-05T05:00:00Z', facts: [], history: [], settings }, { allowedCtaHosts: ['shop.example.test'], generatorSampling: { temperature: 0.7, topP: 0.9 }, generate: async (input) => {
    calls.push(input);
    return calls.length === 1 ? 'Setiap pemain mempunyai cara tersendiri menikmati permainan.' : JSON.stringify({ valid: true, factIds: [] });
  } });
  assert.equal(result.status, 'ready');
  assert.ok(JSON.parse(calls[0].user).creativeDirection.suggestedTheme);
  assert.match(calls[0].system, /Utamakan arahan konten administrator/);
  assert.equal(JSON.parse(calls[0].user).brand.contentDirection, 'Utamakan suara komunitas');
  assert.equal(Object.hasOwn(JSON.parse(calls[1].user), 'creativeDirection'), false);
  assert.equal(calls[0].temperature, 0.7);
  assert.equal(calls[0].topP, 0.9);
  assert.equal(Object.hasOwn(calls[1], 'temperature'), false);
  assert.equal(Object.hasOwn(calls[1], 'topP'), false);
});
