'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContentContext } = require('../src/content-context');
const { validateFullCaption } = require('../src/content-validation');
const { validateSettings } = require('../src/policy');

test('approved product price has explicit IDR currency in model context', () => {
  const settings = validateSettings({ priceMode: 'ON', gameWhitelist: ['Mobile Legends'], guardrails: { approved: true } }).settings;
  const now = '2026-11-08T00:00:00.000Z';
  const source = buildContentContext({ now, history: [], facts: [{ id: 'topup', pillar: 'topup', game: 'Mobile Legends', active: true, updatedAt: now, price: '30' }] }, settings);
  assert.equal(source.facts[0].price, '30');
  assert.equal(source.facts[0].currency, 'IDR');
});

test('price mentions require IDR or Rp and must use a permitted amount', () => {
  const context = { facts: [{ price: '30', currency: 'IDR' }], gameWhitelist: [], recentCaptions: [] };
  assert.equal(validateFullCaption('Harga Rp30 untuk pilihan ini.', context).valid, true);
  assert.equal(validateFullCaption('Harga 30 IDR untuk pilihan ini.', context).valid, true);
  assert.ok(validateFullCaption('Harga 30 untuk pilihan ini.', context).errors.includes('PRICE_MISSING_CURRENCY'));
  assert.ok(validateFullCaption('Harga 30 MYR untuk pilihan ini.', context).errors.includes('PRICE_MISSING_CURRENCY'));
  assert.ok(validateFullCaption('Harga Rp99 untuk pilihan ini.', context).errors.includes('UNAPPROVED_NUMBER'));
  assert.ok(validateFullCaption('Harga $30 untuk pilihan ini.', context).errors.includes('UNAPPROVED_CURRENCY'));
});
