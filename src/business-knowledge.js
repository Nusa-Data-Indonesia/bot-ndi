'use strict';

const { isIP } = require('node:net');

const DEFAULT_CTA_URL = 'https://nusadataindonesia.com';

const DEFAULT_NDI_KNOWLEDGE = Object.freeze({
  companyName: 'Nusa Data Indonesia',
  positioning: 'A data technology company. Built around useful decisions.',
  description: 'Nusa Data Indonesia berfokus pada pengembangan teknologi data dan produk perangkat lunak sendiri. Kami berangkat dari informasi yang dimiliki orang dan organisasi untuk membantu mereka mengambil keputusan yang dibutuhkan. NDI Ticketing merupakan salah satu penerapan dari fokus yang lebih luas ini.',
  vision: 'Membantu orang dan organisasi mengubah informasi menjadi pemahaman dan keputusan yang lebih baik.',
  mission: 'Mengembangkan teknologi data dan produk perangkat lunak dengan memahami masalah nyata, menata informasi sesuai konteks, dan mengevaluasi seberapa baik hasilnya mendukung penggunanya.',
  primaryAudience: 'Pendiri startup, perusahaan, dan organisasi (B2B).',
  secondaryAudience: 'UMKM, pelajar, mahasiswa, pengembang, dan komunitas teknologi.',
  services: [
    'Pengembangan perangkat lunak kustom',
    'Sistem informasi',
    'Analitik data',
    'Dashboard',
    'Pengembangan dan integrasi API',
    'Konsultasi teknologi',
    'Sistem dan solusi sesuai kebutuhan klien',
  ],
  ticketing: 'NDI Ticketing adalah produk dalam pengembangan yang ditampilkan sebagai portofolio pengembangan, dengan MVP pilot undangan untuk triase dukungan pelanggan. Produk ini bukan SaaS tiket acara yang tersedia untuk pembelian umum.',
  contentGuidance: 'Utamakan kesadaran merek dan percakapan prospek yang relevan. Tulis dalam Bahasa Indonesia dengan nada berguna, autentik, dan membangun kepercayaan. Jelaskan layanan, masalah yang dapat dibantu, dan potensi nilai tanpa menyatakan hasil yang belum terbukti.',
  approvedClaims: [],
  forbiddenClaims: [
    'kami telah membantu banyak klien', 'dipercaya oleh banyak klien', 'hasil terukur dari klien',
    'berpengalaman selama bertahun-tahun', 'bersertifikat resmi', 'jaminan hasil', 'studi kasus klien',
    'harga resmi NDI Ticketing', 'refund NDI Ticketing', 'NDI Ticketing tersedia untuk umum',
    'NDI Ticketing untuk tiket acara', 'SaaS tiket acara',
  ],
  ctaUrl: DEFAULT_CTA_URL,
});

const MAX_TEXT = 7000;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function normalizeCtaUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()
    || CONTROL.test(value) || /[\\<>"'\s]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c|25)/iu.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (hostname.length > 253 || (isIP(hostname) === 0
      && (!hostname.includes('.') || hostname.split('.').some((label) => !label || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label))))) return null;
    return value;
  } catch {
    return null;
  }
}

function cleanList(value, field, errors, { maxItems = 100, maxLength = 500 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems
    || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > maxLength || CONTROL.test(item))) {
    errors[field] = `Gunakan daftar teks dengan maksimal ${maxItems} item.`;
    return [];
  }
  const seen = new Set();
  return value.map((item) => item.normalize('NFKC').trim()).filter((item) => {
    const key = item.toLocaleLowerCase('id');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateBusinessKnowledge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: { knowledge: 'Gunakan objek pengetahuan NDI.' } };
  }
  const errors = {};
  const fixedFields = ['companyName', 'positioning', 'description', 'vision', 'mission', 'primaryAudience', 'secondaryAudience', 'ticketing'];
  for (const field of fixedFields) {
    if (input[field] !== undefined && input[field] !== DEFAULT_NDI_KNOWLEDGE[field]) {
      errors[field] = 'Nilai identitas dan batas produk mengikuti fakta resmi Nusa Data Indonesia.';
    }
  }
  const services = cleanList(input.services ?? DEFAULT_NDI_KNOWLEDGE.services, 'services', errors, { maxItems: 30, maxLength: 300 });
  if (!services.length) errors.services = 'Simpan sedikitnya satu layanan yang telah disetujui.';
  const approvedClaims = cleanList(input.approvedClaims ?? [], 'approvedClaims', errors, { maxItems: 100, maxLength: 500 });
  const forbiddenClaims = cleanList(input.forbiddenClaims ?? DEFAULT_NDI_KNOWLEDGE.forbiddenClaims, 'forbiddenClaims', errors, { maxItems: 100, maxLength: 500 });
  const guidance = input.contentGuidance ?? DEFAULT_NDI_KNOWLEDGE.contentGuidance;
  if (typeof guidance !== 'string' || guidance.length > MAX_TEXT || CONTROL.test(guidance)) errors.contentGuidance = `Gunakan panduan teks maksimal ${MAX_TEXT} karakter.`;
  const ctaUrl = normalizeCtaUrl(input.ctaUrl ?? DEFAULT_CTA_URL);
  if (!ctaUrl) errors.ctaUrl = 'Masukkan URL HTTPS yang valid tanpa kredensial, spasi, atau karakter berbahaya.';
  if (Object.keys(errors).length) return { valid: false, errors };
  return {
    valid: true,
    errors: {},
    knowledge: {
      ...DEFAULT_NDI_KNOWLEDGE,
      services,
      approvedClaims,
      forbiddenClaims,
      contentGuidance: guidance.trim(),
      ctaUrl,
    },
  };
}

module.exports = { DEFAULT_CTA_URL, DEFAULT_NDI_KNOWLEDGE, normalizeCtaUrl, validateBusinessKnowledge };
