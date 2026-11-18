'use strict';

const { validateScheduleSettings, normalizeHashtags } = require('./policy');
const { DEFAULT_NDI_KNOWLEDGE, validateBusinessKnowledge } = require('./business-knowledge');

/** @param {unknown} [input] */
function validateNdiSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: { settings: 'Gunakan objek pengaturan NDI.' } };
  }
  const settingsInput = /** @type {Record<string, unknown>} */ (input);
  const schedule = validateScheduleSettings({ schedule: settingsInput.schedule || {} });
  /** @type {Record<string, string>} */
  const errors = { ...(schedule.valid ? {} : schedule.errors) };
  const hashtags = normalizeHashtags(settingsInput.hashtags ?? []);
  if (!hashtags) errors.hashtags = 'Gunakan maksimal 30 hashtag berisi huruf, angka, atau garis bawah.';
  const business = validateBusinessKnowledge(settingsInput.businessKnowledge ?? DEFAULT_NDI_KNOWLEDGE);
  if (!business.valid) Object.assign(errors, business.errors);
  if (Object.keys(errors).length) return { valid: false, errors };
  return {
    valid: true,
    errors: {},
    settings: {
      schedule: schedule.settings.schedule,
      hashtags,
      businessKnowledge: business.knowledge,
    },
  };
}

module.exports = { validateNdiSettings };
