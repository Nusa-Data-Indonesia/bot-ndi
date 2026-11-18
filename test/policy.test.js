'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendHashtags,
  isInActiveWindow,
  normalizeHashtags,
  normalizeScheduleInterval,
  validateScheduleSettings,
} = require('../src/policy');

test('schedule policy normalizes minute and legacy hour intervals without product settings', () => {
  assert.deepEqual(validateScheduleSettings({}).settings.schedule, { intervalMinutes: 60, timezone: 'Asia/Jakarta' });
  assert.equal(validateScheduleSettings({ schedule: { intervalHours: '2' } }).settings.schedule.intervalMinutes, 120);
  assert.equal(validateScheduleSettings({ schedule: { intervalMinutes: 135 } }).settings.schedule.intervalMinutes, 135);
  assert.equal(validateScheduleSettings({ schedule: { hours: 0, minutes: 1 } }).settings.schedule.intervalMinutes, 1);
  assert.equal(validateScheduleSettings({ schedule: { intervalMinutes: 0 } }).valid, false);
  assert.equal(validateScheduleSettings({ schedule: { intervalMinutes: 1, intervalHours: 1 } }).valid, false);
  assert.equal(validateScheduleSettings({ schedule: { timezone: 'Mars/Olympus' } }).valid, false);
  assert.deepEqual(normalizeScheduleInterval({ intervalHours: 3, timezone: 'UTC' }), { intervalMinutes: 180, timezone: 'UTC' });
});

test('legacy active-window fields do not restrict continuous scheduling', () => {
  const schedule = { intervalMinutes: 60, timezone: 'Asia/Jakarta', activeDays: [], activeStart: '09:00', activeEnd: '10:00' };
  assert.equal(isInActiveWindow('2026-11-05T01:00:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-05T13:59:00Z', schedule), true);
  assert.equal(isInActiveWindow('2026-11-05T14:00:00Z', schedule), true);
  assert.equal(isInActiveWindow('invalid', schedule), false);
});

test('hashtags are normalized, bounded, deduplicated, and appended before a saved CTA', () => {
  assert.deepEqual(normalizeHashtags([' #Nusa Data ', '##nusadata', '#TeknologiData']), ['#NusaData', '#TeknologiData']);
  assert.equal(normalizeHashtags(Array(31).fill('#tag')), null);
  assert.equal(normalizeHashtags(['#bad/tag']), null);
  const cta = 'https://nusadataindonesia.com';
  const body = appendHashtags('Mari diskusikan solusi data untuk tim Anda.', ['#NusaData']);
  assert.equal(`${body}\n${cta}`, `Mari diskusikan solusi data untuk tim Anda.\n#NusaData\n${cta}`);
});

test('legacy product validation functions are not part of the NDI policy module', () => {
  const policy = require('../src/policy');
  for (const legacy of ['composeApprovedContent', 'isFactFresh', 'isApprovedCtaUrl', 'validateCaption']) {
    assert.equal(Object.hasOwn(policy, legacy), false, `${legacy} must not remain a runtime policy`);
  }
});
