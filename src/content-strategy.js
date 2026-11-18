'use strict';

const { randomInt } = require('node:crypto');

const DEFAULT_CATEGORIES = Object.freeze([
  { slug: 'edukasi-data-teknologi', name: 'Edukasi Data & Teknologi', guidance: 'Jelaskan satu konsep data atau teknologi dengan bahasa Indonesia yang mudah dipahami dan contoh umum yang tidak mengaku sebagai pengalaman klien.' },
  { slug: 'solusi-masalah-bisnis', name: 'Solusi Masalah Bisnis', guidance: 'Angkat masalah proses atau informasi yang umum. Jelaskan pendekatan yang mungkin membantu tanpa menjanjikan hasil atau mengarang kasus nyata.' },
  { slug: 'pengenalan-ndi', name: 'Pengenalan NDI', guidance: 'Perkenalkan cara pandang, tujuan, atau layanan Nusa Data Indonesia hanya berdasarkan knowledge bisnis yang disetujui.' },
  { slug: 'produk-ndi', name: 'Produk NDI', guidance: 'Bahas produk NDI berdasarkan status yang tercatat. NDI Ticketing hanya produk dalam pengembangan dan pilot undangan untuk triase dukungan pelanggan.' },
  { slug: 'insight-startup', name: 'Insight Startup', guidance: 'Bagikan pertanyaan atau praktik umum yang relevan bagi startup tanpa mengklaim hasil atau pengalaman khusus NDI.' },
  { slug: 'studi-kasus-hipotetis', name: 'Studi Kasus Hipotetis', guidance: 'Jika memakai skenario rekaan, mulai caption dengan kata Ilustrasi: dan jangan menyiratkan bahwa itu klien atau proyek nyata.' },
  { slug: 'soft-selling', name: 'Soft-selling', guidance: 'Hubungkan tantangan umum dengan layanan NDI secara konsultatif, relevan, dan tanpa tekanan atau klaim yang tidak disetujui.' },
  { slug: 'engagement', name: 'Engagement', guidance: 'Ajukan pertanyaan terbuka yang relevan untuk mengundang percakapan profesional; jangan meminta data sensitif.' },
]);

const DEFAULT_STYLES = Object.freeze([
  { slug: 'korporat-profesional', name: 'Korporat profesional', instructions: 'Gunakan bahasa profesional, jelas, ringkas, dan terpercaya. Hindari jargon yang tidak dijelaskan.' },
  { slug: 'edukatif-sederhana', name: 'Edukatif sederhana', instructions: 'Jelaskan ide secara bertahap dengan kata umum dan satu gagasan utama. Jangan menyederhanakan hingga mengubah fakta.' },
  { slug: 'teknis-informatif', name: 'Teknis informatif', instructions: 'Sampaikan detail teknis seperlunya dengan istilah yang tepat dan konteks ringkas. Jangan menambah spesifikasi yang tidak tersedia.' },
  { slug: 'storytelling-masalah-bisnis', name: 'Storytelling masalah bisnis', instructions: 'Mulai dari situasi umum, uraikan masalah, lalu tawarkan sudut pandang. Skenario rekaan wajib diawali Ilustrasi:.' },
  { slug: 'soft-selling-konsultatif', name: 'Soft-selling konsultatif', instructions: 'Gunakan nada membantu dan ajakan berdiskusi yang wajar. Jangan menjanjikan hasil atau memberi kesan penjualan agresif.' },
  { slug: 'conversational', name: 'Conversational', instructions: 'Gunakan Bahasa Indonesia yang hangat dan alami, tetap profesional, dan akhiri dengan undangan percakapan yang relevan.' },
  { slug: 'problem-solving', name: 'Problem solving', instructions: 'Susun masalah, satu pendekatan yang mungkin, dan pertanyaan tindak lanjut. Tandai kemungkinan sebagai kemungkinan, bukan hasil terbukti.' },
]);

function selectUniform(items, chooseIndex = randomInt) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const index = chooseIndex(items.length);
  if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) throw new RangeError('random index out of range');
  return items[index];
}

function latestProviderConfirmedCategory(publishedSlots = []) {
  const categorized = publishedSlots.filter((slot) => slot?.status === 'published'
    && slot.categoryId !== null && slot.categoryId !== undefined);
  if (categorized.some((slot) => {
    const timestamp = Date.parse(slot.providerPublishedAt);
    return typeof slot.providerPublishedAt !== 'string' || !Number.isFinite(timestamp);
  })) return { uncertain: true, categoryId: null };
  if (categorized.length === 0) return { uncertain: false, categoryId: null };
  const latestTime = Math.max(...categorized.map((slot) => Date.parse(slot.providerPublishedAt)));
  const latest = new Set(categorized.filter((slot) => Date.parse(slot.providerPublishedAt) === latestTime)
    .map((slot) => String(slot.categoryId)));
  if (latest.size !== 1) return { uncertain: true, categoryId: null };
  return { uncertain: false, categoryId: [...latest][0] };
}

function chooseContentStrategy({ categories = [], styles = [], publishedSlots = [], chooseIndex = randomInt } = {}) {
  const activeCategories = categories.filter((entry) => entry.active && !entry.archivedAt);
  const activeStyles = styles.filter((entry) => entry.active && !entry.archivedAt);
  if (activeCategories.length === 0) return { ready: false, reasonCode: 'CONTENT_CATEGORIES_EMPTY' };
  if (activeStyles.length === 0) return { ready: false, reasonCode: 'CONTENT_STYLES_EMPTY' };
  const order = latestProviderConfirmedCategory(publishedSlots);
  if (order.uncertain) return { ready: false, reasonCode: 'CONTENT_CATEGORY_ORDER_UNCERTAIN' };
  const eligible = activeCategories.length > 1 && order.categoryId
    ? activeCategories.filter((entry) => String(entry.id) !== order.categoryId)
    : activeCategories;
  if (eligible.length === 0) return { ready: false, reasonCode: 'CONTENT_CATEGORIES_EMPTY' };
  return {
    ready: true,
    category: selectUniform(eligible, chooseIndex),
    style: selectUniform(activeStyles, chooseIndex),
  };
}

function contentStrategyReadiness({ categoryCount = 0, styleCount = 0, approved = false, orderUncertain = false } = {}) {
  if (categoryCount < 1) return { ready: false, reasonCode: 'CONTENT_CATEGORIES_EMPTY', message: 'Aktifkan minimal satu kategori konten.' };
  if (styleCount < 1) return { ready: false, reasonCode: 'CONTENT_STYLES_EMPTY', message: 'Aktifkan minimal satu gaya konten.' };
  if (orderUncertain) return { ready: false, reasonCode: 'CONTENT_CATEGORY_ORDER_UNCERTAIN', message: 'Urutan publikasi provider belum dapat dipastikan. Tinjau slot published dengan timestamp provider.' };
  if (!approved) return { ready: false, reasonCode: 'CONTENT_STRATEGY_REVIEW_REQUIRED', message: 'Tinjau dan aktifkan strategi konten setelah kategori dan gaya diperiksa.' };
  return { ready: true, reasonCode: null, message: null };
}

function validateStrategyInput(value, { kind }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['object'] };
  const errors = [];
  const name = typeof value.name === 'string' ? value.name.normalize('NFKC').trim() : '';
  const detailKey = kind === 'category' ? 'guidance' : 'instructions';
  const detail = typeof value[detailKey] === 'string' ? value[detailKey].normalize('NFKC').trim() : '';
  if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) errors.push('name');
  if (!detail || [...detail].length > 3000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(detail)) errors.push(detailKey);
  if (value.active !== undefined && typeof value.active !== 'boolean') errors.push('active');
  return errors.length ? { valid: false, errors } : { valid: true, record: { name, [detailKey]: detail, active: value.active !== false } };
}

module.exports = {
  DEFAULT_CATEGORIES,
  DEFAULT_STYLES,
  chooseContentStrategy,
  contentStrategyReadiness,
  latestProviderConfirmedCategory,
  selectUniform,
  validateStrategyInput,
};
