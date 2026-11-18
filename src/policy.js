'use strict';

const { DateTime, IANAZone } = require('luxon');

const MAX_HASHTAGS = 30;
const MAX_HASHTAG_LENGTH = 100;
const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_])[#＃]+([\p{L}\p{N}_]+)/gu;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hashtagKey(value) {
  return value.normalize('NFKC').replace(/^#+/u, '').replace(/\s+/gu, '').toLowerCase();
}

function normalizeHashtags(input) {
  if (!Array.isArray(input) || input.length > MAX_HASHTAGS) return null;
  const normalized = [];
  const seen = new Set();
  for (const value of input) {
    if (typeof value !== 'string' || [...value].length > MAX_HASHTAG_LENGTH) return null;
    const trimmed = value.normalize('NFKC').trim();
    if (!trimmed) continue;
    const body = trimmed.replace(/^#+/u, '').replace(/\s+/gu, '');
    if (!body || [...body].length > MAX_HASHTAG_LENGTH || !/^[\p{L}\p{N}_]+$/u.test(body)) return null;
    const key = hashtagKey(body);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(`#${body}`);
  }
  return normalized;
}

function splitAroundText(text, excludedText) {
  const index = excludedText ? text.lastIndexOf(excludedText) : -1;
  if (index < 0) return { before: text, excluded: '', after: '', separated: false };
  return {
    before: text.slice(0, index),
    excluded: excludedText,
    after: text.slice(index + excludedText.length),
    separated: true,
  };
}

function joinAroundText(parts) {
  return parts.separated ? `${parts.before}${parts.excluded}${parts.after}` : parts.before;
}

function canonicalizeHashtags(text) {
  return text.replace(HASHTAG_PATTERN, (_match, body) => `#${body.normalize('NFKC')}`);
}

function appendHashtags(text, hashtags, excludedText = '') {
  const normalized = normalizeHashtags(hashtags);
  if (!normalized || !normalized.length) return text;
  const parts = splitAroundText(text, excludedText);
  parts.before = canonicalizeHashtags(parts.before);
  parts.after = canonicalizeHashtags(parts.after);
  const normalizedText = joinAroundText(parts);
  const presentMatches = [...parts.before.matchAll(HASHTAG_PATTERN), ...parts.after.matchAll(HASHTAG_PATTERN)];
  const present = new Set(presentMatches.map((match) => hashtagKey(match[1])));
  const missing = normalized.filter((tag) => !present.has(hashtagKey(tag)));
  return missing.length ? `${normalizedText}\n${missing.join(' ')}` : normalizedText;
}

function instant(value) {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' });
  return typeof value === 'string' ? DateTime.fromISO(value, { zone: 'utc' }) : DateTime.invalid('Invalid instant');
}

function intervalFitsDateTime(intervalMinutes) {
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) return false;
  const target = DateTime.utc().plus({ minutes: intervalMinutes });
  return target.isValid && Number.isFinite(target.toMillis());
}

/** @param {Record<string, unknown>} [schedule] */
function intervalMinutesFromSchedule(schedule = {}) {
  const intervalMinutes = schedule.intervalMinutes;
  if (typeof intervalMinutes === 'number' && Number.isSafeInteger(intervalMinutes) && intervalFitsDateTime(intervalMinutes)) return intervalMinutes;
  const legacyHours = schedule.intervalHours;
  const requestedHours = typeof legacyHours === 'string' && legacyHours.trim() ? Number(legacyHours) : legacyHours;
  if (typeof requestedHours === 'number' && Number.isSafeInteger(requestedHours) && requestedHours >= 1) {
    const minutes = requestedHours * 60;
    if (intervalFitsDateTime(minutes)) return minutes;
  }
  const hours = schedule.hours;
  const minutesPart = schedule.minutes;
  if (typeof hours === 'number' && Number.isSafeInteger(hours) && hours >= 0
    && typeof minutesPart === 'number' && Number.isSafeInteger(minutesPart) && minutesPart >= 0 && minutesPart <= 59) {
    const minutes = hours * 60 + minutesPart;
    if (intervalFitsDateTime(minutes)) return minutes;
  }
  return 60;
}

/** @param {Record<string, unknown>} [schedule] @returns {Record<string, unknown> & {intervalMinutes: number}} */
function normalizeScheduleInterval(schedule = {}) {
  const normalized = /** @type {Record<string, unknown> & {intervalMinutes: number}} */ ({
    ...schedule,
    intervalMinutes: intervalMinutesFromSchedule(schedule),
    timezone: schedule.timezone === undefined ? 'Asia/Jakarta' : schedule.timezone,
  });
  delete normalized.intervalHours;
  delete normalized.hours;
  delete normalized.minutes;
  return normalized;
}

/** @param {unknown} [input] */
function validateScheduleSettings(input = {}) {
  if (!isRecord(input)) return { valid: false, errors: { settings: 'Gunakan objek pengaturan.' } };
  if (input.schedule !== undefined && !isRecord(input.schedule)) return { valid: false, errors: { schedule: 'Gunakan objek jadwal.' } };
  const source = isRecord(input.schedule) ? input.schedule : {};
  const hasHours = Object.hasOwn(source, 'hours');
  const hasMinutes = Object.hasOwn(source, 'minutes');
  const hasLegacyHours = Object.hasOwn(source, 'intervalHours');
  const hasCanonicalMinutes = Object.hasOwn(source, 'intervalMinutes');
  const errors = {};
  let requestedIntervalMinutes = 60;
  if ([hasHours || hasMinutes, hasLegacyHours, hasCanonicalMinutes].filter(Boolean).length > 1) {
    errors['schedule.intervalMinutes'] = 'Gunakan satu format interval saja.';
  } else if (hasHours || hasMinutes) {
    if (!hasHours || !hasMinutes || typeof source.hours !== 'number' || !Number.isSafeInteger(source.hours) || source.hours < 0) {
      errors['schedule.hours'] = 'Masukkan jumlah jam berupa bilangan bulat non-negatif.';
    }
    if (!hasHours || !hasMinutes || typeof source.minutes !== 'number' || !Number.isSafeInteger(source.minutes) || source.minutes < 0 || source.minutes > 59) {
      errors['schedule.minutes'] = 'Masukkan menit berupa bilangan bulat antara 0 dan 59.';
    }
    if (!errors['schedule.hours'] && !errors['schedule.minutes']) requestedIntervalMinutes = Number(source.hours) * 60 + Number(source.minutes);
  } else if (hasCanonicalMinutes) {
    if (typeof source.intervalMinutes !== 'number' || !Number.isSafeInteger(source.intervalMinutes)) errors['schedule.intervalMinutes'] = 'Masukkan interval dalam bilangan bulat.';
    else requestedIntervalMinutes = source.intervalMinutes;
  } else if (hasLegacyHours) {
    const legacyHours = typeof source.intervalHours === 'string' && source.intervalHours.trim()
      ? Number(source.intervalHours) : source.intervalHours;
    if (typeof legacyHours !== 'number' || !Number.isSafeInteger(legacyHours) || legacyHours < 1) errors['schedule.intervalHours'] = 'Interval lama harus berupa jumlah jam bulat minimal 1.';
    else requestedIntervalMinutes = legacyHours * 60;
  }
  const timezone = source.timezone === undefined ? 'Asia/Jakarta' : source.timezone;
  if (!Number.isSafeInteger(requestedIntervalMinutes) || requestedIntervalMinutes < 1 || !intervalFitsDateTime(requestedIntervalMinutes)) {
    errors['schedule.intervalMinutes'] = 'Jarak antar posting minimal 1 menit dan harus dapat dijadwalkan.';
  }
  if (typeof timezone !== 'string' || !IANAZone.isValidZone(timezone)) errors['schedule.timezone'] = 'Gunakan zona waktu IANA yang valid.';
  if (Object.keys(errors).length) return { valid: false, errors };
  return { valid: true, errors: {}, settings: { schedule: { intervalMinutes: requestedIntervalMinutes, timezone } } };
}

function isInActiveWindow(value, schedule) {
  const checked = validateScheduleSettings({ schedule });
  return checked.valid && instant(value).isValid;
}

module.exports = {
  appendHashtags,
  intervalMinutesFromSchedule,
  isInActiveWindow,
  normalizeHashtags,
  normalizeScheduleInterval,
  validateScheduleSettings,
};
