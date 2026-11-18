'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('active dashboard offers NDI knowledge and a single editable Website Resmi / CTA URL', () => {
  for (const field of ['companyName', 'positioning', 'description', 'vision', 'mission', 'services', 'contentGuidance', 'ctaUrl']) {
    assert.match(html, new RegExp(`name="${field}"`), `missing NDI field ${field}`);
  }
  assert.match(html, /Website Resmi \/ CTA URL/);
  assert.match(html, /https:\/\/nusadataindonesia\.com/);
  assert.doesNotMatch(html, /Tautan top-up berpelacak|Game top-up yang disetujui|name="(?:gameWhitelist|priceMode|trackedTopup|trackedAccount)"/i);
});

test('legacy template and learning controls and calls are absent from the active dashboard', () => {
  assert.doesNotMatch(html, /data-tab="(?:templates|learning)"|id="tab-(?:templates|learning)"/);
  assert.doesNotMatch(app, /\/api\/(?:templates|learning)(?:\/|['"`])/);
});
