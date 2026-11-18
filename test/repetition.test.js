'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNdiCaption } = require('../src/content-validation');

const CTA = 'https://nusadataindonesia.com';
const HASHTAGS = ['#NusaDataIndonesia'];
const body = (text) => `${text}\n#NusaDataIndonesia\n${CTA}`;
const errors = (text, prior) => validateNdiCaption(body(text), {
  ctaUrl: CTA,
  hashtags: HASHTAGS,
  recentCaptions: [body(prior)],
}).errors;

test('removes the required CTA and hashtags symmetrically before comparing NDI captions', () => {
  const prior = 'Tim dapat menata informasi agar keputusan bisnis lebih jelas.';
  const current = 'Tim dapat menata informasi agar keputusan bisnis lebih jelas.';
  assert.ok(errors(current, prior).includes('REPETITIVE_CAPTION'));
});

test('short identical NDI captions are rejected and distinct captions are accepted', () => {
  assert.ok(errors('Mari diskusikan kebutuhan data tim Anda.', 'Mari diskusikan kebutuhan data tim Anda.').includes('REPETITIVE_CAPTION'));
  assert.ok(!errors('Yuk pelajari integrasi API untuk organisasi.', 'Mari diskusikan kebutuhan data tim Anda.').includes('REPETITIVE_CAPTION'));
});

test('opposite intent and different negation are not treated as lexical duplication', () => {
  const first = 'Tim dapat memakai data untuk memahami kebutuhan bisnis dan menyusun sistem yang lebih sesuai.';
  const different = 'Tim tidak memakai data untuk memahami kebutuhan bisnis dan menyusun sistem yang lebih sesuai.';
  assert.ok(!errors(different, first).includes('REPETITIVE_CAPTION'));
});

test('long near-identical captions are flagged when the sequence is substantially the same', () => {
  const first = 'Setiap organisasi memiliki kebutuhan data yang berbeda saat menyusun sistem digital untuk mendukung keputusan tim.';
  const second = 'Setiap organisasi memiliki kebutuhan data berbeda saat menyusun sistem digital untuk mendukung keputusan tim.';
  assert.ok(errors(second, first).includes('REPETITIVE_CAPTION'));
});

test('a repeated caption cannot bypass link or hashtag validation', () => {
  const result = validateNdiCaption(`Mari diskusikan kebutuhan data untuk organisasi Anda.\n#NusaDataIndonesia #Unknown\nhttps://evil.example.test\n${CTA}`, {
    ctaUrl: CTA,
    hashtags: HASHTAGS,
    recentCaptions: [body('Mari diskusikan kebutuhan data untuk organisasi Anda.')],
  });
  assert.ok(result.errors.includes('UNAPPROVED_LINK'));
  assert.ok(result.errors.includes('UNAPPROVED_HASHTAG'));
  assert.ok(result.errors.includes('REPETITIVE_CAPTION'));
});
