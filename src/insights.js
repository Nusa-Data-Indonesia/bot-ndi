'use strict';

const { DateTime } = require('luxon');

/** @typedef {ReturnType<typeof import('./providers/tebar').createTebarClient>} TebarClient */

function extractClickMetric(response) {
  const metric = response?.data?.metrics?.clicks ?? response?.metrics?.clicks;
  const value = typeof metric === 'number' ? metric : metric && typeof metric === 'object'
    ? metric.total ?? metric.value : null;
  if (!Number.isSafeInteger(value) || value < 0) {
    return { available: false, value: null, reason: response?.missing_permission ? 'permission_missing' : 'no_data' };
  }
  return { available: true, value, reason: null };
}

/** @param {{publisher?: TebarClient, accountId?: string, timezone?: string, now?: Date | string | number}} [options] */
async function getClickMetric({ publisher, accountId, timezone = 'Asia/Jakarta', now = new Date() } = {}) {
  if (!publisher || typeof accountId !== 'string' || !accountId) return extractClickMetric(null);
  const current = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: 'utc' }).setZone(timezone);
  if (!current.isValid) return extractClickMetric(null);
  const from = current.minus({ days: 29 }).toISODate();
  const to = current.toISODate();
  if (!from || !to) return extractClickMetric(null);
  const response = await publisher.getInsights(accountId, {
    metrics: ['clicks'],
    from,
    to,
    tz: timezone,
  });
  return extractClickMetric(response);
}

module.exports = { extractClickMetric, getClickMetric };
