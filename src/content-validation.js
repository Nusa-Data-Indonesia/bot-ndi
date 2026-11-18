'use strict';

const { normalizeHashtags } = require('./policy');

const TAG = /(?<![\p{L}\p{N}_])[#＃]+([\p{L}\p{N}_]+)/gu;
const URL = /(?:https?:\/\/|www\.)[^\s<>]+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}(?:\/[^\s<>]*)?/giu;
const LEGACY_NDI_CONTAMINATION = /\b(?:kedai\s*merzz|merzz|botmerzz|top[\s-]?up|mobile\s+legends?|mlbb|free\s*fire|pubg(?:\s+mobile)?|diamonds?|game(?:s|r|rs|ing)?|gaming|permainan|akun\s+game|roblox|valorant|genshin(?:\s+impact)?|dota(?:\s+2)?|honor\s+of\s+kings?)\b/iu;
const INVITATION = /\b(?:mari|yuk|silakan|hubungi|diskusikan|bicarakan|ceritakan|kenali|jelajahi|eksplorasi|pertimbangkan|konsultasikan|pelajari|berbincang)\b/iu;
const BUSINESS_CONTEXT = /\b(?:kebutuhan|solusi|layanan|sistem|data|teknologi|dashboard|api|integrasi|perangkat lunak|bisnis|tim|organisasi)\b/iu;
const HYPOTHETICAL_SCENARIO = /\b(?:misalkan|misalnya sebuah (?:tim|perusahaan|organisasi)|andaikan|bayangkan|hipotetis|fiktif|skenario simulasi|hypothetical|fictional company|suppose|imagine)\b/iu;

function words(text) {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(URL, ' ').replace(TAG, ' ').toLocaleLowerCase('id').match(/[\p{L}\p{N}]+/gu) || [];
}

function repetitive(text, recentCaptions) {
  const current = words(text);
  if (!current.length) return false;
  return recentCaptions.some((caption) => {
    if (typeof caption !== 'string') return false;
    const prior = words(caption);
    if (current.join(' ') === prior.join(' ')) return true;
    const negative = new Set(['tidak', 'tak', 'bukan', 'jangan', 'never', 'not']);
    if (current.some((word) => negative.has(word)) !== prior.some((word) => negative.has(word))) return false;
    const a = new Set(current);
    const b = new Set(prior);
    if (a.size < 8 || b.size < 8) return false;
    const common = [...a].filter((word) => b.has(word)).length;
    if (common / (a.size + b.size - common) < 0.8) return false;
    const pairs = (items) => new Set(items.slice(1).map((word, index) => `${items[index]}\u0000${word}`));
    const currentPairs = pairs(current);
    const priorPairs = pairs(prior);
    const commonPairs = [...currentPairs].filter((pair) => priorPairs.has(pair)).length;
    return commonPairs / Math.max(currentPairs.size, priorPairs.size) >= 0.65;
  });
}

// Deterministic checks complement the independent semantic review; they do not
// establish that every claim in natural language is supported.
function validateNdiCaption(text, context = {}) {
  if (typeof text !== 'string' || !text.trim()) return { valid: false, errors: ['EMPTY_CAPTION'] };
  const errors = [];
  if ([...text].length > 500) errors.push('CAPTION_TOO_LONG');
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const lower = normalized.toLocaleLowerCase('id');
  const ctaUrl = context.ctaUrl;
  if (typeof ctaUrl !== 'string' || !ctaUrl) errors.push('INVALID_CONFIGURED_CTA');
  const lines = normalized.trimEnd().split(/\r?\n/u);
  if (lines.at(-1) !== ctaUrl) errors.push('CTA_URL_NOT_FINAL');
  let urlCount = 0;
  for (const match of normalized.matchAll(URL)) {
    const candidate = match[0].replace(/[.,!?;:)]+$/u, '');
    urlCount++;
    if (candidate !== ctaUrl) errors.push('UNAPPROVED_LINK');
  }
  if (urlCount !== 1) errors.push(urlCount ? 'DUPLICATE_LINK' : 'MISSING_REQUIRED_LINK');
  const body = lines.slice(0, -1).join('\n');
  const bodyWithoutTags = body.replace(TAG, ' ').trim();
  if (!INVITATION.test(bodyWithoutTags) || !BUSINESS_CONTEXT.test(bodyWithoutTags)) errors.push('MISSING_CONTEXTUAL_INVITATION');
  if (HYPOTHETICAL_SCENARIO.test(bodyWithoutTags) && !/^Ilustrasi:\s/iu.test(bodyWithoutTags)) errors.push('UNLABELED_HYPOTHETICAL_SCENARIO');
  if (LEGACY_NDI_CONTAMINATION.test(body)) errors.push('LEGACY_BUSINESS_CONTENT');
  for (const claim of context.forbiddenClaims || []) {
    if (typeof claim === 'string' && claim.trim() && lower.includes(claim.normalize('NFKC').toLocaleLowerCase('id'))) errors.push('FORBIDDEN_CLAIM');
  }
  if (/\d|[$€£¥]\s*\d|\b(?:rp|idr|usd|eur|dollar|rupiah)\s*\d|\b(?:satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|seratus|seribu|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:klien|pelanggan|pengguna|transaksi|tahun|bulan|minggu|hari|persen)\b/iu.test(body)) errors.push('UNSUPPORTED_NUMERIC_CLAIM');
  if (/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(body) || /(?:\+?\d[\d ()-]{7,}\d)/u.test(body)) errors.push('POSSIBLE_PERSONAL_INFORMATION');
  const hashtags = normalizeHashtags(context.hashtags ?? []);
  if (!hashtags) errors.push('INVALID_HASHTAGS');
  const allowed = new Set((hashtags || []).map((tag) => tag.slice(1).toLocaleLowerCase('id')));
  const seen = new Set();
  for (const match of body.matchAll(TAG)) {
    const key = match[1].normalize('NFKC').toLocaleLowerCase('id');
    if (!allowed.has(key)) errors.push('UNAPPROVED_HASHTAG');
    if (seen.has(key)) errors.push('DUPLICATE_HASHTAG');
    seen.add(key);
  }
  if ([...allowed].some((tag) => !seen.has(tag))) errors.push('MISSING_REQUIRED_HASHTAGS');
  if (repetitive(bodyWithoutTags, Array.isArray(context.recentCaptions) ? context.recentCaptions : [])) errors.push('REPETITIVE_CAPTION');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

module.exports = { validateNdiCaption };
