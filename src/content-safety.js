'use strict';

const { createHash } = require('node:crypto');
const { validateNdiSettings } = require('./ndi-settings');

// Snapshot the normalized policy and creative inputs that can influence a caption.
/** @param {unknown} settings */
function contentSafetyHash(settings) {
  const checked = validateNdiSettings(settings);
  if (!checked.valid) return null;
  const contentSettings = { ...checked.settings };
  delete contentSettings.schedule;
  contentSettings.businessKnowledge = { ...contentSettings.businessKnowledge };
  delete contentSettings.businessKnowledge.ctaUrl;
  return createHash('sha256').update(JSON.stringify(contentSettings)).digest('hex');
}

module.exports = { contentSafetyHash };
