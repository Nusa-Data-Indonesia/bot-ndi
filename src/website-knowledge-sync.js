'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const { isIP } = require('node:net');

const OFFICIAL_URL = 'https://nusadataindonesia.com/';
const OFFICIAL_HOST = 'nusadataindonesia.com';
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_SERVICES = 50;
const MAX_SERVICE_LENGTH = 300;
const EXCLUDED_BLOCKS = /<(script|style|noscript|svg|iframe|object|template|form|textarea|select|button|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

/** @returns {Error & {code: string, status: number}} */
function failure(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}

function websiteSyncErrorCode(error) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function inIpv4Range(value, network, prefix) {
  const octets = value.split('.').map(Number);
  const base = network.split('.').map(Number);
  const ip = (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
  const net = (((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8) + base[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (net & mask);
}

function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const blocked = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return !blocked.some(([network, prefix]) => inIpv4Range(address, network, prefix));
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/&nbsp;/giu, ' ')
    .replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/giu, (_match, raw) => {
      const point = raw[0].toLowerCase() === 'x' ? Number.parseInt(raw.slice(1), 16) : Number.parseInt(raw, 10);
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '';
      return String.fromCodePoint(point);
    });
}

function cleanText(value, maxLength = MAX_SERVICE_LENGTH) {
  const text = decodeHtmlEntities(String(value || '').replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]*>/gu, ' '))
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > maxLength || /\b(?:ignore all (?:previous|prior) instructions|reveal (?:the )?(?:credentials|secrets)|system prompt)\b/iu.test(text)) return null;
  return text;
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseWebsiteServiceList(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > DEFAULT_MAX_BYTES) throw failure('WEBSITE_SYNC_PARSE_FAILED', 502);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html);
  const title = cleanText(titleMatch?.[1] || '', 200) || 'Website Resmi NDI';
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    const attributes = parseAttributes(script[1]);
    if (String(attributes.type || '').toLowerCase() !== 'application/ld+json') continue;
    let document;
    try { document = JSON.parse(script[2]); } catch { continue; }
    const stack = [{ value: document, depth: 0 }];
    let serviceList = null;
    while (stack.length) {
      const current = stack.pop();
      if (current.depth > 12 || !current.value || typeof current.value !== 'object') continue;
      if (Array.isArray(current.value)) {
        for (const value of current.value.slice(0, 100)) stack.push({ value, depth: current.depth + 1 });
        continue;
      }
      const type = Array.isArray(current.value['@type']) ? current.value['@type'].join(' ') : String(current.value['@type'] || '');
      const name = cleanText(current.value.name || '', 200);
      if (/\bitemlist\b/iu.test(type) && name && /\b(?:layanan|service|services|solusi|solutions)\b/iu.test(name)
        && Array.isArray(current.value.itemListElement)) {
        serviceList = current.value;
        break;
      }
      for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
        if (current.value[key] && typeof current.value[key] === 'object') stack.push({ value: current.value[key], depth: current.depth + 1 });
      }
    }
    if (serviceList) {
      const services = [];
      const edits = [];
      for (const entry of serviceList.itemListElement.slice(0, MAX_SERVICES)) {
        const item = entry?.item ?? entry;
        const value = cleanText(typeof item === 'string' ? item : item?.name || entry?.name || '');
        if (!value) continue;
        const replaces = item && typeof item === 'object' ? item['ndi:replaces'] || item.replaces : null;
        const baseValue = cleanText(replaces || '');
        if (baseValue && baseValue !== value) edits.push({ operation: 'edit', targetValue: value, baseValue });
        services.push(value);
      }
      const unique = [...new Map(services.map((value) => [value.toLocaleLowerCase('id'), value])).values()];
      if (unique.length) return { title, services: unique, edits, complete: true };
    }
  }
  const safeHtml = html.replace(/<!--[\s\S]*?-->/gu, '').replace(EXCLUDED_BLOCKS, ' ');
  const headings = [...safeHtml.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/giu)];
  for (let i = 0; i < headings.length; i++) {
    const heading = cleanText(headings[i][3], 200);
    if (!heading || !/\b(?:layanan|service|services|solusi|solutions)\b/iu.test(heading)) continue;
    const start = headings[i].index + headings[i][0].length;
    const next = headings.slice(i + 1).find((item) => Number(item[1]) <= Number(headings[i][1]));
    const end = next ? next.index : safeHtml.length;
    const section = safeHtml.slice(start, end);
    const listMatch = /<ul\b([^>]*)>([\s\S]*?)<\/ul\s*>/iu.exec(section);
    if (!listMatch) continue;
    const items = [];
    const edits = [];
    for (const item of listMatch[2].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/giu)) {
      const value = cleanText(item[2]);
      if (!value) continue;
      const attributes = parseAttributes(item[1]);
      const replaces = attributes['data-ndi-service-replaces'];
      if (replaces) {
        const baseValue = cleanText(replaces);
        if (baseValue && baseValue !== value) edits.push({ operation: 'edit', targetValue: value, baseValue });
      }
      items.push(value);
      if (items.length >= MAX_SERVICES) break;
    }
    const unique = [...new Map(items.map((value) => [value.toLocaleLowerCase('id'), value])).values()];
    return { title, services: unique, edits, complete: unique.length > 0 };
  }
  return { title, services: [], edits: [], complete: false };
}

function buildWebsiteServiceChanges(currentServices, websiteServices, { complete = false, edits = [] } = {}) {
  if (!Array.isArray(currentServices) || !Array.isArray(websiteServices) || !complete) return [];
  const current = currentServices.filter((value) => typeof value === 'string');
  const website = websiteServices.filter((value) => typeof value === 'string');
  const key = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('id');
  const currentByKey = new Map(current.map((value) => [key(value), value]));
  const websiteByKey = new Map(website.map((value) => [key(value), value]));
  const replacements = Array.isArray(edits) ? edits.filter((edit) => edit?.operation === 'edit'
    && typeof edit.baseValue === 'string' && typeof edit.targetValue === 'string'
    && currentByKey.has(key(edit.baseValue)) && websiteByKey.has(key(edit.targetValue))) : [];
  const consumedCurrent = new Set(replacements.map((edit) => key(edit.baseValue)));
  const consumedWebsite = new Set(replacements.map((edit) => key(edit.targetValue)));
  const changes = replacements.map((edit) => ({ operation: 'edit', targetValue: websiteByKey.get(key(edit.targetValue)), baseValue: currentByKey.get(key(edit.baseValue)) }));
  for (const [normalized, value] of websiteByKey) {
    if (!currentByKey.has(normalized) && !consumedWebsite.has(normalized)) changes.push({ operation: 'add', targetValue: value, baseValue: null });
  }
  for (const [normalized, value] of currentByKey) {
    if (!websiteByKey.has(normalized) && !consumedCurrent.has(normalized)) changes.push({ operation: 'remove', targetValue: value, baseValue: value });
  }
  return changes.sort((a, b) => a.operation.localeCompare(b.operation) || a.targetValue.localeCompare(b.targetValue, 'id'));
}

/** @param {{address: string, timeoutMs: number, maxBytes: number}} options */
function requestOfficialHtml({ address, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    };
    const request = https.request({
      protocol: 'https:', hostname: OFFICIAL_HOST, servername: OFFICIAL_HOST, port: 443, path: '/', method: 'GET', agent: false,
      headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'BotNDI-ManualKnowledgeSync/1.0', Connection: 'close' },
      lookup: (hostname, _options, callback) => {
        if (hostname !== OFFICIAL_HOST) return callback(failure('WEBSITE_SYNC_UNSAFE_DNS'), '', 0);
        return callback(null, address, 4);
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(failure('WEBSITE_SYNC_RESPONSE_TOO_LARGE'));
          request.destroy(failure('WEBSITE_SYNC_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, {
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', (error) => finish(websiteSyncErrorCode(error) ? error : failure('WEBSITE_SYNC_FETCH_FAILED')));
    });
    request.setTimeout(timeoutMs, () => request.destroy(failure('WEBSITE_SYNC_TIMEOUT')));
    request.on('error', (error) => finish(websiteSyncErrorCode(error)?.startsWith('WEBSITE_SYNC_') ? error : failure('WEBSITE_SYNC_FETCH_FAILED')));
    request.end();
  });
}

async function fetchOfficialWebsite({
  resolveHost = (host) => dns.lookup(host, { family: 4, all: true, verbatim: true }),
  requestImpl = requestOfficialHtml,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => new Date(),
} = {}) {
  const startedAt = Date.now();
  const bounded = (promise, remainingMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('WEBSITE_SYNC_TIMEOUT')), remainingMs);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  let addresses;
  try { addresses = await bounded(resolveHost(OFFICIAL_HOST), timeoutMs); }
  catch (error) { throw failure(error?.code === 'WEBSITE_SYNC_TIMEOUT' ? error.code : 'WEBSITE_SYNC_DNS_FAILED'); }
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some((item) => item?.family !== 4 || !isPublicIpv4(item.address))) throw failure('WEBSITE_SYNC_UNSAFE_DNS');
  let response;
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  try { response = await bounded(requestImpl({ address: addresses[0].address, timeoutMs: remainingMs, maxBytes }), remainingMs); }
  catch (error) { throw failure(error?.code?.startsWith('WEBSITE_SYNC_') ? error.code : 'WEBSITE_SYNC_FETCH_FAILED'); }
  const status = Number(response?.statusCode);
  if (status >= 300 && status < 400) throw failure('WEBSITE_SYNC_REDIRECT_REJECTED');
  if (status !== 200) throw failure('WEBSITE_SYNC_FETCH_FAILED');
  if (!/^text\/html(?:\s*;|$)/iu.test(String(response.headers?.['content-type'] || ''))) throw failure('WEBSITE_SYNC_CONTENT_TYPE_REJECTED');
  const html = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.body;
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > maxBytes) throw failure('WEBSITE_SYNC_RESPONSE_TOO_LARGE');
  const length = Number(response.headers?.['content-length']);
  if (Number.isFinite(length) && length > maxBytes) throw failure('WEBSITE_SYNC_RESPONSE_TOO_LARGE');
  const fetchedAt = clock();
  if (!(fetchedAt instanceof Date) || !Number.isFinite(fetchedAt.getTime())) throw failure('WEBSITE_SYNC_FETCH_FAILED');
  return { url: OFFICIAL_URL, fetchedAt, html };
}

/**
 * @param {{repository?: any, fetchWebsite?: () => Promise<{url: string, fetchedAt: Date, html: string}>,
 * logger?: {info?: (...args: any[]) => void, error?: (...args: any[]) => void}, clock?: () => Date}} [options]
 */
function createManualWebsiteSyncService({ repository, fetchWebsite = fetchOfficialWebsite, logger, clock = () => new Date() } = {}) {
  if (!repository || typeof repository.startWebsiteSyncRun !== 'function'
    || typeof repository.completeWebsiteSyncRun !== 'function' || typeof repository.failWebsiteSyncRun !== 'function'
    || typeof fetchWebsite !== 'function') throw new TypeError('repository and manual website sync dependencies are required');
  /** @param {{adminId?: number}} [input] */
  return async function synchronizeNdiWebsite({ adminId } = {}) {
    const run = await repository.startWebsiteSyncRun(adminId);
    try {
      const fetched = await fetchWebsite();
      const extracted = parseWebsiteServiceList(fetched.html);
      if (!extracted.complete) throw failure('WEBSITE_SYNC_SERVICE_LIST_NOT_FOUND');
      const proposals = buildWebsiteServiceChanges(run.knowledge?.services, extracted.services, extracted).map((item) => ({
        ...item,
        sourceUrl: fetched.url,
        sourceTitle: extracted.title,
        fetchedAt: fetched.fetchedAt,
        knowledgeVersion: run.knowledgeVersion,
      }));
      const result = await repository.completeWebsiteSyncRun({
        id: run.id, knowledgeVersion: run.knowledgeVersion, sourceUrl: fetched.url, sourceTitle: extracted.title,
        fetchedAt: fetched.fetchedAt, proposals, completedAt: clock(),
      });
      logger?.info?.('ndi_website_sync.completed', { runId: run.id, proposalCount: proposals.length });
      return result;
    } catch (error) {
      const errorCode = typeof error?.code === 'string' && /^WEBSITE_SYNC_[A-Z0-9_]{2,60}$/.test(error.code)
        ? error.code : 'WEBSITE_SYNC_FAILED';
      try { await repository.failWebsiteSyncRun({ id: run.id, errorCode, failedAt: clock() }); }
      catch { logger?.error?.('ndi_website_sync.record_failed', { runId: run.id }); }
      logger?.error?.('ndi_website_sync.failed', { runId: run.id, code: errorCode });
      throw failure(errorCode, error?.status || 502);
    }
  };
}

module.exports = {
  OFFICIAL_URL,
  OFFICIAL_HOST,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildWebsiteServiceChanges,
  createManualWebsiteSyncService,
  fetchOfficialWebsite,
  isPublicIpv4,
  parseWebsiteServiceList,
};
