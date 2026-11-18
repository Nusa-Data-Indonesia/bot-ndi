'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CATEGORIES, DEFAULT_STYLES, chooseContentStrategy, contentStrategyReadiness, selectUniform,
} = require('../src/content-strategy');

test('provides the eight SSOT categories and seven editable styles as deterministic idempotent seed inputs', () => {
  assert.deepEqual(DEFAULT_CATEGORIES.map((item) => item.name), [
    'Edukasi Data & Teknologi', 'Solusi Masalah Bisnis', 'Pengenalan NDI', 'Produk NDI',
    'Insight Startup', 'Studi Kasus Hipotetis', 'Soft-selling', 'Engagement',
  ]);
  assert.deepEqual(DEFAULT_STYLES.map((item) => item.name), [
    'Korporat profesional', 'Edukatif sederhana', 'Teknis informatif', 'Storytelling masalah bisnis',
    'Soft-selling konsultatif', 'Conversational', 'Problem solving',
  ]);
  assert.ok(DEFAULT_CATEGORIES.every((item) => item.slug && item.guidance));
  assert.ok(DEFAULT_STYLES.every((item) => item.slug && item.instructions));
});

test('uniform selector covers every eligible item without weighted assumptions', () => {
  const items = ['a', 'b', 'c', 'd'];
  const counts = new Map(items.map((item) => [item, 0]));
  let cursor = 0;
  for (let i = 0; i < 4000; i++) {
    const picked = selectUniform(items, (length) => cursor++ % length);
    counts.set(picked, counts.get(picked) + 1);
  }
  assert.deepEqual([...counts.values()], [1000, 1000, 1000, 1000]);
  assert.equal(selectUniform([], () => 0), null);
});

test('category and style are selected independently and the provider-latest category is excluded', () => {
  const categories = ['A', 'B', 'C'].map((id) => ({ id, active: true }));
  const styles = ['S1', 'S2', 'S3'].map((id) => ({ id, active: true }));
  const indexes = [1, 2];
  const chosen = chooseContentStrategy({
    categories,
    styles,
    publishedSlots: [
      { status: 'published', categoryId: 'A', providerPublishedAt: '2026-11-18T10:00:00.000Z' },
      { status: 'published', categoryId: 'C', providerPublishedAt: '2026-11-18T09:00:00.000Z' },
    ],
    chooseIndex: (length) => indexes.shift() % length,
  });
  assert.equal(chosen.ready, true);
  assert.equal(chosen.category.id, 'C');
  assert.equal(chosen.style.id, 'S3');
});

test('allows a single active category to repeat and ignores non-published states for rotation', () => {
  const chosen = chooseContentStrategy({
    categories: [{ id: 'A', active: true }], styles: [{ id: 'S', active: true }],
    publishedSlots: [
      { status: 'unknown', categoryId: 'A' }, { status: 'failed', categoryId: 'A' },
      { status: 'pending', categoryId: 'A' }, { status: 'draft', categoryId: 'A' },
    ],
    chooseIndex: () => 0,
  });
  assert.equal(chosen.ready, true);
  assert.equal(chosen.category.id, 'A');
});

test('blocks rotation when provider order is absent, invalid, or tied across categories', () => {
  const categories = [{ id: 'A', active: true }, { id: 'B', active: true }];
  const styles = [{ id: 'S', active: true }];
  for (const publishedSlots of [
    [{ status: 'published', categoryId: 'A', providerPublishedAt: null }],
    [{ status: 'published', categoryId: 'A', providerPublishedAt: 'not-a-time' }],
    [
      { status: 'published', categoryId: 'A', providerPublishedAt: '2026-11-18T10:00:00.000Z' },
      { status: 'published', categoryId: 'B', providerPublishedAt: '2026-11-18T10:00:00.000Z' },
    ],
  ]) {
    assert.deepEqual(chooseContentStrategy({ categories, styles, publishedSlots }).reasonCode, 'CONTENT_CATEGORY_ORDER_UNCERTAIN');
  }
});

test('excludes inactive and archived records and fails closed for empty category/style sets or unapproved strategy', () => {
  assert.equal(chooseContentStrategy({ categories: [], styles: [{ id: 'S', active: true }] }).reasonCode, 'CONTENT_CATEGORIES_EMPTY');
  assert.equal(chooseContentStrategy({ categories: [{ id: 'A', active: true }], styles: [] }).reasonCode, 'CONTENT_STYLES_EMPTY');
  assert.equal(chooseContentStrategy({
    categories: [{ id: 'A', active: false }, { id: 'B', active: true, archivedAt: '2026-01-01' }],
    styles: [{ id: 'S', active: true }],
  }).reasonCode, 'CONTENT_CATEGORIES_EMPTY');
  assert.equal(contentStrategyReadiness({ categoryCount: 8, styleCount: 7, approved: false }).reasonCode, 'CONTENT_STRATEGY_REVIEW_REQUIRED');
});
