(() => {
  'use strict';
  function parseRetryAfterSeconds(payloadValue, headerValue) {
    for (const value of [payloadValue, headerValue]) {
      const seconds = typeof value === 'number' ? value
        : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value)
          : NaN;
      if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
    }
    return null;
  }
  function formatLoginWait(retryAfterSeconds) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      return 'Terlalu banyak percobaan masuk. Tunggu beberapa saat lalu coba lagi.';
    }
    const hours = Math.floor(retryAfterSeconds / 3600);
    const minutes = Math.floor((retryAfterSeconds % 3600) / 60);
    const seconds = retryAfterSeconds % 60;
    const duration = [];
    if (hours) duration.push(hours + ' jam');
    if (minutes) duration.push(minutes + ' menit');
    if (seconds || !duration.length) duration.push(seconds + ' detik');
    return 'Terlalu banyak percobaan masuk. Coba lagi dalam ' + duration.join(' ') + '.';
  }
  function searchOpenRouterModels(models, query, limit = 50) {
    const term = String(query || '').trim().toLocaleLowerCase();
    if (!Array.isArray(models)) return [];
    const matches = models.filter((model) => [model?.name, model?.provider, model?.id]
      .some((value) => String(value || '').toLocaleLowerCase().includes(term)));
    return matches.slice(0, Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50)));
  }
  function modelValidationStatusFromError(error) {
    if (error?.code === 'MODEL_NOT_FOUND') return 'NOT_FOUND';
    if (['INVALID_MODEL', 'MODEL_INCOMPATIBLE'].includes(error?.code)) return 'INCOMPATIBLE';
    return 'UNVERIFIED';
  }
  async function withPending(control, action, progressText, form = control?.closest?.('form')) {
    if (!control || control.disabled || control.dataset.pending === 'true' || form?.dataset.pending === 'true') return false;
    const originalText = control.textContent;
    const originalDisabled = control.disabled;
    const originalBusy = form?.getAttribute('aria-busy');
    const formControls = form ? [...form.elements].map((field) => [field, field.disabled]) : [];
    control.dataset.pending = 'true';
    if (form) {
      form.dataset.pending = 'true';
      form.setAttribute('aria-busy', 'true');
      formControls.forEach(([field]) => { field.disabled = true; });
    }
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    if (progressText) control.textContent = progressText;
    try {
      return await action();
    } finally {
      delete control.dataset.pending;
      control.disabled = originalDisabled;
      control.textContent = originalText;
      control.removeAttribute('aria-busy');
      if (control.id === 'integration-check-active') control.disabled = !state.integrations?.configuration?.profileId || !state.integrations?.configuration?.accountId;
      if (form) {
        formControls.forEach(([field, disabled]) => { field.disabled = disabled; });
        delete form.dataset.pending;
        if (originalBusy === null) form.removeAttribute('aria-busy');
        else form.setAttribute('aria-busy', originalBusy);
        if (['integration-account-form', 'integration-model-form', 'reviewer-model-form'].includes(form.id)) syncIntegrationControls();
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { withPending, parseRetryAfterSeconds, formatLoginWait, searchOpenRouterModels, modelValidationStatusFromError };
    return;
  }
  if (typeof document === 'undefined') return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: '', data: null, integrations: null, integrationVerification: null, modelCatalog: null, modelCatalogRequest: 0, modelSelection: null, modelValidation: null, modelDraftDirty: false, reviewerModelValidation: null, reviewerModelDraftDirty: false, modelOptionMatches: [], modelActiveOption: -1, dashboardLoad: 0, onboardingComplete: null, onboardingExpanded: false };
  const escapeText = (value) => String(value ?? '');
  const toastTimers = new WeakMap();
  const toastHistory = new Map();
  function notify(type, message) {
    const text = String(message || '').trim();
    const region = $('#toast-region');
    if (!text || !region) return;
    const key = `${type}:${text}`;
    const now = Date.now();
    if (now - (toastHistory.get(key) || 0) < 1800) return;
    toastHistory.set(key, now);
    for (const [oldKey, time] of toastHistory) if (now - time > 5000) toastHistory.delete(oldKey);
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');
    const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ({ success: '✓', error: '!', warning: '⚠', info: 'i' })[type] || 'i';
    const content = document.createElement('span'); content.className = 'toast-message'; content.textContent = text;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Tutup notifikasi'); close.textContent = '×';
    close.addEventListener('click', () => { clearTimeout(toastTimers.get(toast)); toast.remove(); });
    toast.append(icon, content, close); region.append(toast);
    const timer = type === 'error' || type === 'warning' ? 10000 : 5000;
    toastTimers.set(toast, setTimeout(() => toast.remove(), timer));
  }
  const show = (selector, text) => {
    const el = $(selector); el.textContent = text; el.hidden = false;
    if (selector === '#global-success') notify('success', text);
    else if (selector === '#global-error' || selector === '#login-error') {
      const partialSuccess = /ringkasan dashboard belum dapat diperbarui/i.test(text);
      notify(partialSuccess ? 'info' : /konflik|validasi|belum selesai|belum lengkap|periksa/i.test(text) ? 'warning' : 'error', partialSuccess ? `Perubahan berhasil disimpan, tetapi ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
    }
    else if (selector === '#integration-account-error' || selector === '#integration-model-error' || selector === '#reviewer-model-error') notify('error', text);
  };
  function confirmAction(message) {
    const confirmed = window.confirm(message);
    if (!confirmed) notify('info', 'Tindakan dibatalkan. Tidak ada perubahan yang disimpan.');
    return confirmed;
  }
  async function refreshAfterMutation(loader) {
    try { await loader(); }
    catch { notify('info', 'Perubahan berhasil disimpan, tetapi tampilan belum dapat diperbarui. Muat ulang dashboard.'); }
  }
  const hide = (selector) => { $(selector).hidden = true; };
  const errors = {
    INVALID_EMAIL: 'Format email tidak valid.', INVALID_PASSWORD: 'Kata sandi harus terdiri dari 12 sampai 256 karakter.',
    ADMIN_EXISTS: 'Email tersebut sudah digunakan oleh akun admin lain.', LAST_ADMIN: 'Admin aktif terakhir tidak dapat dinonaktifkan.',
    CANNOT_DEACTIVATE_SELF: 'Anda tidak dapat menonaktifkan akun yang sedang digunakan.', ADMIN_NOT_FOUND: 'Akun admin tidak ditemukan.',
    INVALID_ADMIN: 'Data akun admin tidak valid.', EMPTY_ADMIN_UPDATE: 'Tidak ada perubahan untuk disimpan.',
    INVALID_SETTINGS: 'Ada data pengaturan yang perlu diperiksa. Lihat pesan pada field yang ditandai.',
    INVALID_KNOWLEDGE: 'Periksa layanan, panduan, klaim, serta Website Resmi / CTA URL.',
    LEGACY_FACTS_ARCHIVED: 'Fakta bisnis lama disimpan sebagai riwayat dan tidak digunakan untuk konten NDI.',
    INVALID_ADMIN_STATUS: 'Status akun admin tidak valid.',
    INVALID_CREDENTIALS: 'Email atau kata sandi tidak cocok.',
    LOGIN_RATE_LIMITED: 'Terlalu banyak percobaan masuk. Tunggu beberapa saat lalu coba lagi.',
    ORIGIN_REJECTED: 'Permintaan ditolak karena asal halaman tidak cocok. Muat ulang dashboard lalu coba lagi.',
    RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
    SCHEDULER_DISABLED: 'Scheduler belum aktif di server. Minta administrator menyalakan scheduler sebelum mengaktifkan otomasi.',
    AUTOMATION_PROVIDER_HOLD: 'Otomasi tertahan karena akses provider. Buka Integrasi untuk melihat penyebab dan cara pemulihan.',
    ONBOARDING_INCOMPLETE: 'Tinjau pengetahuan bisnis NDI, koneksi Threads, dan penyedia AI sebelum mengaktifkan otomasi.',
    CONTENT_STRATEGY_NOT_READY: 'Periksa dan setujui kategori serta gaya konten sebelum mengaktifkan otomasi.',
    CONTENT_STRATEGY_REVIEW_REQUIRED: 'Tinjau kategori dan gaya lalu aktifkan strategi sebelum mengaktifkan otomasi.',
    CONTENT_CATEGORIES_EMPTY: 'Aktifkan atau buat minimal satu kategori konten.', CONTENT_STYLES_EMPTY: 'Aktifkan atau buat minimal satu gaya konten.',
    CONTENT_CATEGORY_ORDER_UNCERTAIN: 'Urutan publikasi provider belum pasti. Tinjau status slot published sebelum melanjutkan.',
    CONTENT_STRATEGY_SNAPSHOT_MISSING: 'Slot tidak memiliki snapshot strategi yang aman; slot diblokir dari publikasi.',
    AUTOMATION_MUST_BE_PAUSED: 'Jeda otomasi sebelum mengaktifkan atau menonaktifkan strategi konten.',
    INVALID_CONTENT_STRATEGY: 'Periksa nama dan panduan kategori atau gaya.', CONTENT_STRATEGY_DUPLICATE: 'Nama atau slug kategori/gaya sudah digunakan.',
    CONTENT_STRATEGY_NOT_FOUND: 'Kategori atau gaya tidak ditemukan atau sudah diarsipkan.',
    INVALID_PROPOSAL_SETTINGS: 'Interval usulan harus antara 30 dan 365 hari.', CATEGORY_PROPOSAL_ALREADY_REVIEWED: 'Usulan sudah ditinjau.',
    BUSINESS_KNOWLEDGE_REVIEW_REQUIRED: 'Simpan dan setujui pengetahuan bisnis NDI sebelum mengaktifkan otomasi.',
    WEBSITE_SYNC_UNAVAILABLE: 'Sinkronisasi website belum tersedia di server.',
    WEBSITE_SYNC_DNS_FAILED: 'Domain resmi belum dapat diperiksa. Periksa koneksi server lalu coba lagi.',
    WEBSITE_SYNC_UNSAFE_DNS: 'Alamat website resmi tidak lolos pemeriksaan keamanan. Sinkronisasi dihentikan.',
    WEBSITE_SYNC_TIMEOUT: 'Website resmi tidak merespons dalam batas waktu. Tidak ada pengetahuan yang diubah.',
    WEBSITE_SYNC_FETCH_FAILED: 'Halaman resmi belum dapat diambil. Periksa kembali nanti.',
    WEBSITE_SYNC_REDIRECT_REJECTED: 'Website mengalihkan permintaan. Pengalihan ditolak demi keamanan.',
    WEBSITE_SYNC_CONTENT_TYPE_REJECTED: 'Website tidak mengembalikan halaman HTML yang diharapkan.',
    WEBSITE_SYNC_RESPONSE_TOO_LARGE: 'Halaman website melebihi batas ukuran aman.',
    WEBSITE_SYNC_PARSE_FAILED: 'Halaman website tidak dapat dibaca dengan aman.',
    WEBSITE_SYNC_SERVICE_LIST_NOT_FOUND: 'Daftar layanan terstruktur tidak ditemukan. Pengetahuan tetap tidak berubah.',
    WEBSITE_SYNC_CONFLICT: 'Pengetahuan berubah setelah usulan dibuat. Periksa ulang fakta dan minta sinkronisasi baru.',
    AUTH_REQUIRED: 'Sesi login berakhir. Silakan masuk kembali.', CSRF_REJECTED: 'Sesi keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.',
    CONFIG_CONFLICT: 'Konfigurasi sudah berubah. Muat ulang konfigurasi dan periksa lagi; isian Anda tetap tersimpan di form.',
    INVALID_ACCOUNT: 'Profile ID atau Account ID tidak valid. Periksa kedua isian.',
    INVALID_MODEL: 'Model ID tidak valid. Periksa kembali format dan nama model.',
    MODEL_INCOMPATIBLE: 'Model tidak mendukung kebutuhan teks atau parameter aplikasi.',
    MODEL_IDS_MUST_DIFFER: 'Model Generator dan Reviewer harus berbeda.',
    REVIEWER_MODEL_REQUIRED: 'Pilih dan verifikasi model Reviewer yang berbeda dari Generator sebelum otomasi dijalankan.',
    MODEL_METADATA_UNVERIFIED: 'Metadata model belum cukup untuk memastikan kompatibilitas. Model aktif tidak berubah.',
    PROVIDER_UNAVAILABLE: 'Penyedia belum dapat dihubungi. Coba lagi setelah koneksi pulih.',
    SWITCH_BLOCKED: 'Pergantian tertahan karena status posting lama belum pasti. Periksa dan lanjutkan rekonsiliasi.',
    ACCOUNT_NOT_AVAILABLE: 'Akun tidak tersedia pada profile ini, bukan Threads, tidak aktif, atau sedang ditangguhkan.',
    TEBAR_NOT_CONFIGURED: 'Koneksi Tebar belum dikonfigurasi di server.', TEBAR_UNAUTHORIZED: 'Kunci Tebar tidak memiliki akses ke profile ini.',
    TEBAR_UNAVAILABLE: 'Tebar belum dapat dihubungi. Coba lagi nanti.', TEBAR_RATE_LIMITED: 'Tebar membatasi permintaan. Tunggu sebentar lalu coba lagi.',
    MODEL_NOT_FOUND: 'Model tidak ditemukan di OpenRouter.', OPENROUTER_NOT_CONFIGURED: 'Koneksi OpenRouter belum dikonfigurasi di server.',
    OPENROUTER_UNAUTHORIZED: 'Koneksi OpenRouter tidak memiliki izin untuk memeriksa model.', OPENROUTER_UNAVAILABLE: 'OpenRouter belum dapat dihubungi. Coba lagi nanti.',
    OPENROUTER_RATE_LIMITED: 'OpenRouter membatasi permintaan. Tunggu sebentar lalu coba lagi.',
    CONFIG_SWITCH_IN_PROGRESS: 'Pergantian akun masih berlangsung. Selesaikan pemeriksaan terlebih dahulu.',
    CONFIG_VERSION_NOT_RESTORABLE: 'Versi ini tidak dapat dipulihkan karena informasinya belum lengkap.',
    CONFIG_UNAVAILABLE: 'Konfigurasi belum dapat dibaca. Coba lagi atau hubungi administrator server.',
    CONFIG_NOT_LOADED: 'Muat ulang konfigurasi sebelum melanjutkan.',
    PUBLICATION_NOT_FOUND: 'Slot tidak ditemukan. Muat ulang konfigurasi untuk melihat daftar terbaru.',
    PUBLICATION_STATE_CONFLICT: 'Status slot sudah berubah. Muat ulang konfigurasi dan periksa kembali.',
    PUBLICATION_REQUEST_CONFLICT: 'ID permintaan sudah dipakai dengan data berbeda. Batalkan dialog dan periksa kembali slot.',
    PUBLICATION_TARGET_MISMATCH: 'Tebar tidak mengonfirmasi post yang terbit di akun Threads asal. Periksa kembali ID post dan akun.',
    PROVIDER_POST_ALREADY_LINKED: 'ID post Tebar sudah terkait dengan slot lain. Periksa riwayat sebelum melanjutkan.',
    PUBLICATION_VERIFICATION_UNAVAILABLE: 'Verifikasi post Tebar belum tersedia. Periksa koneksi provider lalu coba lagi.',
    PUBLICATION_RECONCILIATION_UNAVAILABLE: 'Pemeriksaan status Tebar belum berhasil. ID post tetap tersimpan; coba lagi nanti.',
  };
  const fieldLabels = {
    services: 'layanan yang disetujui', contentGuidance: 'panduan konten', ctaUrl: 'Website Resmi / CTA URL',
    approvedClaims: 'klaim yang disetujui', forbiddenClaims: 'klaim yang dilarang', hashtags: 'hashtag',
    'schedule.hours': 'jam interval posting', 'schedule.minutes': 'menit interval posting', 'schedule.intervalMinutes': 'interval posting', 'schedule.intervalHours': 'interval posting', 'schedule.timezone': 'zona waktu',
    email: 'email', password: 'kata sandi', profileId: 'Profile ID', accountId: 'Account ID', model: 'model ID', modelSearch: 'model AI',
  };
  const fieldNames = { 'schedule.hours': 'hours', 'schedule.minutes': 'minutes', 'schedule.intervalMinutes': 'minutes', 'schedule.intervalHours': 'hours', 'schedule.timezone': 'timezone' };
  const errorText = (error) => {
    const code = error?.code || error?.message;
    if (code === 'LOGIN_RATE_LIMITED') return formatLoginWait(error.retryAfterSeconds);
    if (errors[code]) return errors[code];
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return 'Permintaan belum berhasil. Periksa kembali data atau coba lagi.';
    return code || 'Permintaan gagal. Silakan coba lagi.';
  };
  function clearFieldError(control) {
    const errorId = control?.dataset?.errorId;
    if (!errorId) return;
    document.getElementById(errorId)?.remove();
    control.removeAttribute('aria-invalid');
    const describedBy = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
    if (describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
    delete control.dataset.errorId;
  }
  function clearFormErrors(form) { [...form.elements].forEach(clearFieldError); }
  function showFormError(form, error, notice = '#global-error') {
    clearFormErrors(form);
    const fields = { ...(error?.fields || {}) };
    const codeField = {
      INVALID_EMAIL: 'email', INVALID_PASSWORD: 'password', ADMIN_EXISTS: 'email',
    }[error?.code];
    if (!Object.keys(fields).length && codeField) fields[codeField] = error.code;
    let firstInvalid = null;
    for (const path of Object.keys(fields)) {
      const name = fieldNames[path] || path;
      const control = form.elements.namedItem(name);
      if (!control || typeof control.setAttribute !== 'function') continue;
      const label = control.labels?.[0] || control.closest('label');
      if (!label) continue;
      const fieldContainer = control.closest('.login-field') || label;
      const errorId = `${form.id || 'form'}-${name}-error`;
      const note = document.createElement('span');
      note.className = 'field-error';
      note.id = errorId;
      note.setAttribute('role', 'alert');
      note.textContent = `Periksa kembali ${fieldLabels[path] || name}.`;
      fieldContainer.append(note);
      control.dataset.errorId = errorId;
      control.setAttribute('aria-invalid', 'true');
      const hint = label.querySelector('.field-hint');
      if (hint && !hint.id) hint.id = `${form.id || 'form'}-${name}-hint`;
      const describedBy = [...new Set([control.getAttribute('aria-describedby'), hint?.id, errorId].filter(Boolean))].join(' ');
      control.setAttribute('aria-describedby', describedBy);
      firstInvalid ||= control;
    }
    show(notice, errorText(error));
    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      firstInvalid.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }
  const onboardingLabels = {
    contentStrategy: 'Strategi konten NDI disetujui',
    knowledge: 'Pengetahuan bisnis NDI dan Website Resmi / CTA URL',
    thread: 'Akun Threads testing',
    ai: 'Penyedia AI',
  };
  const onboardingTargets = {
    knowledge: { tab: 'content', field: 'ctaUrl' },
    thread: { tab: 'integrations', field: 'profileId' },
    ai: { tab: 'ai', field: 'model' },
  };
  const statusLabels = {
    pending: 'Menunggu', generating: 'Membuat konten', ready: 'Siap diterbitkan',
    publishing: 'Sedang diterbitkan', published: 'Berhasil diterbitkan',
    failed: 'Gagal', skipped: 'Dilewati', canceled: 'Dibatalkan',
    partial: 'Sebagian berhasil', unknown: 'Belum diketahui', scheduled: 'Terjadwal',
    admin_closed_unknown: 'Ditutup admin tanpa verifikasi',
  };
  const activityLabels = {
    post_published: 'Posting berhasil diterbitkan', publish_accepted: 'Posting diterima penyedia',
    publish_failed: 'Penerbitan gagal', publish_outcome_unknown: 'Status penerbitan belum diketahui',
    ai_generation_failed: 'Pembuatan konten AI gagal', automation_paused: 'Otomasi dijeda',
    slot_skipped: 'Jadwal posting dilewati', post_cancellation: 'Pembatalan posting',
    'publication.close_unverified': 'Slot ditutup admin tanpa verifikasi',
    'publication.link_provider_post': 'ID post Tebar dikaitkan oleh admin',
    publication_close_unverified: 'Slot ditutup admin tanpa verifikasi',
    publication_link_provider_post: 'ID post Tebar dikaitkan oleh admin',
    provider_hold_created: 'Akses provider perlu diperiksa',
    'ndi_website_sync.requested': 'Admin meminta sinkronisasi Website NDI',
    'ndi_website_sync.completed': 'Sinkronisasi Website NDI selesai; usulan menunggu tinjauan',
    'ndi_website_sync.failed': 'Sinkronisasi Website NDI gagal',
    'ndi_website_sync.proposal.approved': 'Usulan website disetujui ke pengetahuan bisnis',
    'ndi_website_sync.proposal.rejected': 'Usulan website ditolak oleh admin',
    'ndi_website_sync.proposal.conflict': 'Usulan website menjadi konflik versi',
  };
  function addPasswordToggle(input) {
    if (!input?.parentNode || input.dataset.visibilityToggle === 'ready') return;
    const wrapper = document.createElement('span'); wrapper.className = 'password-field';
    input.parentNode.insertBefore(wrapper, input); wrapper.append(input); input.dataset.visibilityToggle = 'ready';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'password-toggle';
    button.setAttribute('aria-label', 'Tampilkan kata sandi'); button.setAttribute('aria-pressed', 'false');
    const eye = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const eyeOff = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A11.5 11.5 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a11 11 0 0 0 4-.7"></path></svg>';
    button.innerHTML = eye;
    button.addEventListener('click', () => {
      const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
      button.setAttribute('aria-pressed', String(visible)); button.innerHTML = visible ? eyeOff : eye; input.focus();
    });
    wrapper.append(button);
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (options.method && !['GET', 'HEAD'].includes(options.method)) headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Permintaan gagal (${response.status})`);
      error.code = payload.error;
      error.fields = payload.fields || {};
      error.status = response.status;
      error.conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
      error.retryAfterSeconds = parseRetryAfterSeconds(payload.retryAfterSeconds, response.headers?.get?.('Retry-After'));
      throw error;
    }
    return payload;
  }

  function clearLoginFeedback() {
    const message = $('#login-error').textContent;
    hide('#login-error');
    if (!message) return;
    $$('#toast-region .toast').forEach((toast) => {
      if (toast.querySelector('.toast-message')?.textContent !== message) return;
      clearTimeout(toastTimers.get(toast));
      toast.remove();
    });
  }

  function setAuthenticated(authenticated) {
    clearLoginFeedback();
    $('#login-view').hidden = authenticated;
    $('#app-view').hidden = !authenticated;
    const focusTarget = authenticated ? $('#dashboard-title') : $('#login-email');
    focusTarget?.focus({ preventScroll: true });
  }

  function value(form, name) { return new FormData(form).get(name) || ''; }
  function lines(text) { return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean); }

  function setFormValues(form, values) {
    for (const [key, val] of Object.entries(values)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field instanceof RadioNodeList || (field.length && field[0]?.type === 'checkbox')) {
        const chosen = Array.isArray(val) ? val.map(String) : [];
        [...field].forEach((input) => { input.checked = chosen.includes(input.value); });
      } else if (field.type === 'checkbox') field.checked = val === true;
      else if (Array.isArray(val)) field.value = val.join('\n');
      else field.value = val ?? '';
    }
  }

  function updateScheduleIntervalSummary() {
    const form = $('#schedule-form');
    const summary = $('#schedule-interval-summary');
    if (!form || !summary) return;
    const rawHours = value(form, 'hours').trim();
    const rawMinutes = value(form, 'minutes').trim();
    if (!/^\d+$/u.test(rawHours) || !/^\d+$/u.test(rawMinutes)) {
      summary.textContent = 'Masukkan jam dan menit sebagai bilangan bulat non-negatif.';
      return;
    }
    const hours = Number(rawHours); const minutes = Number(rawMinutes); const total = hours * 60 + minutes;
    if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || minutes > 59 || !Number.isSafeInteger(total) || total < 1) {
      summary.textContent = 'Interval minimal 1 menit; nilai menit harus antara 0 dan 59.';
      return;
    }
    const parts = [];
    if (hours) parts.push(`${hours} jam`);
    if (minutes) parts.push(`${minutes} menit`);
    summary.textContent = `Interval yang akan disimpan: ${parts.join(' ')}.`;
  }

  function readSettings() {
    const settings = state.data?.settings || {};
    const schedule = settings.schedule || {};
    const knowledge = state.data?.businessKnowledge || settings.businessKnowledge || {};
    setFormValues($('#content-form'), {
      companyName: knowledge.companyName, positioning: knowledge.positioning, description: knowledge.description,
      vision: knowledge.vision, mission: knowledge.mission, primaryAudience: knowledge.primaryAudience,
      secondaryAudience: knowledge.secondaryAudience, ticketing: knowledge.ticketing,
      services: (knowledge.services || []).join('\n'), contentGuidance: knowledge.contentGuidance,
      ctaUrl: knowledge.ctaUrl,
      forbiddenClaims: (knowledge.forbiddenClaims || []).join('\n'),
      approvedClaims: (knowledge.approvedClaims || []).join('\n'),
      hashtags: (settings.hashtags || []).join('\n'),
    });
    const legacyHours = typeof schedule.intervalHours === 'string' && /^\d+$/u.test(schedule.intervalHours)
      ? Number(schedule.intervalHours) : schedule.intervalHours;
    const savedIntervalMinutes = Number.isSafeInteger(schedule.intervalMinutes) && schedule.intervalMinutes > 0
      ? schedule.intervalMinutes
      : Number.isSafeInteger(legacyHours) && legacyHours >= 1 && Number.isSafeInteger(legacyHours * 60) ? legacyHours * 60 : 60;
    setFormValues($('#schedule-form'), { hours: Math.floor(savedIntervalMinutes / 60), minutes: savedIntervalMinutes % 60 });
    updateScheduleIntervalSummary();
    renderNdiKnowledge(knowledge);
  }

  function renderNdiKnowledge(knowledge = {}) {
    const services = Array.isArray(knowledge.services) ? knowledge.services : [];
    const list = $('#ndi-service-list');
    list.replaceChildren(...(services.length ? services.map((service) => {
      const item = document.createElement('li'); item.textContent = service; return item;
    }) : [Object.assign(document.createElement('li'), { textContent: 'Belum ada layanan yang disimpan.' })]));
    $('#ndi-ticketing-summary').textContent = knowledge.ticketing || 'Status produk belum tersedia.';
    const link = $('#ndi-cta-link');
    const cta = typeof knowledge.ctaUrl === 'string' ? knowledge.ctaUrl : 'https://nusadataindonesia.com';
    link.textContent = cta; link.href = cta;
  }

  function renderStrategyRecords(container, records, kind) {
    container.replaceChildren();
    if (!Array.isArray(records) || !records.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada item.'; container.append(empty); return;
    }
    for (const record of records) {
      const archived = Boolean(record.archivedAt);
      const form = document.createElement('form'); form.className = 'panel form-grid strategy-record';
      form.dataset.kind = kind; form.dataset.id = record.id;
      const heading = document.createElement('div'); heading.className = 'panel-heading full';
      const headingText = document.createElement('div');
      const title = document.createElement('h3'); title.textContent = record.name;
      const status = document.createElement('p'); status.className = 'muted';
      status.textContent = archived ? 'Diarsipkan' : record.active ? 'Aktif' : 'Nonaktif';
      headingText.append(title, status); heading.append(headingText);
      const nameLabel = document.createElement('label'); nameLabel.textContent = kind === 'category' ? 'Nama kategori' : 'Nama gaya';
      const name = document.createElement('input'); name.name = 'name'; name.maxLength = 120; name.required = true; name.value = record.name; name.disabled = archived; nameLabel.append(name);
      const detailLabel = document.createElement('label'); detailLabel.className = 'full'; detailLabel.textContent = kind === 'category' ? 'Panduan kategori' : 'Instruksi gaya';
      const detail = document.createElement('textarea'); detail.name = kind === 'category' ? 'guidance' : 'instructions'; detail.rows = 3; detail.maxLength = 3000; detail.required = true; detail.value = kind === 'category' ? record.guidance : record.instructions; detail.disabled = archived; detailLabel.append(detail);
      const footer = document.createElement('div'); footer.className = 'form-footer full';
      const activeLabel = document.createElement('label'); activeLabel.className = 'check-row';
      const active = document.createElement('input'); active.type = 'checkbox'; active.name = 'active'; active.checked = record.active; active.disabled = archived;
      const activeText = document.createElement('span'); activeText.textContent = 'Aktif untuk pemilihan'; activeLabel.append(active, activeText);
      const actions = document.createElement('div'); actions.className = 'form-actions';
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; save.textContent = 'Simpan'; save.disabled = archived;
      const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'button quiet'; archive.dataset.action = 'archive'; archive.textContent = 'Arsipkan'; archive.hidden = archived;
      actions.append(save, archive); footer.append(activeLabel, actions); form.append(heading, nameLabel, detailLabel, footer); container.append(form);
    }
  }

  function renderCategoryProposals(proposals = []) {
    const container = $('#category-proposals'); container.replaceChildren();
    const pending = Array.isArray(proposals) ? proposals.filter((proposal) => proposal.status === 'pending') : [];
    if (!pending.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Tidak ada usulan yang menunggu tinjauan.'; container.append(empty); return; }
    for (const proposal of pending) {
      const card = document.createElement('article'); card.className = 'panel stack';
      const title = document.createElement('h4'); title.textContent = proposal.name;
      const detail = document.createElement('p'); detail.className = 'muted'; detail.textContent = proposal.guidance;
      const actions = document.createElement('div'); actions.className = 'form-actions';
      for (const [decision, label, className] of [['approve', 'Setujui kategori', 'button primary'], ['reject', 'Tolak usulan', 'button quiet']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = className; button.dataset.action = `proposal-${decision}`; button.dataset.id = proposal.id; button.textContent = label; actions.append(button);
      }
      card.append(title, detail, actions); container.append(card);
    }
  }

  function renderContentStrategy(strategy = {}) {
    state.contentStrategy = strategy;
    const readiness = strategy.readiness || {};
    const notice = $('#strategy-readiness');
    notice.className = `notice ${readiness.ready ? 'success' : 'warning'}`;
    notice.textContent = readiness.ready
      ? `Strategi aktif. ${readiness.categoryCount} kategori dan ${readiness.styleCount} gaya tersedia. Penerbitan otomatis tetap memerlukan aktivasi terpisah.`
      : readiness.message || 'Strategi belum siap. Tinjau kategori, gaya, dan urutan publikasi.';
    $('#strategy-enable').hidden = readiness.approved === true;
    $('#strategy-disable').hidden = readiness.approved !== true;
    $('#strategy-enable').disabled = Number(readiness.categoryCount || 0) < 1 || Number(readiness.styleCount || 0) < 1 || readiness.orderUncertain === true;
    renderStrategyRecords($('#strategy-categories'), strategy.categories || [], 'category');
    renderStrategyRecords($('#strategy-styles'), strategy.styles || [], 'style');
    renderCategoryProposals(strategy.proposals || []);
    const proposalSettings = strategy.proposalSettings || {};
    const proposalForm = $('#proposal-settings-form');
    proposalForm.elements.namedItem('enabled').checked = proposalSettings.enabled === true;
    proposalForm.elements.namedItem('intervalDays').value = String(proposalSettings.intervalDays || 30);
    const nextRun = proposalSettings.nextRunAt ? new Date(proposalSettings.nextRunAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : null;
    $('#proposal-schedule-status').textContent = proposalSettings.enabled
      ? `Job aktif dengan interval ${proposalSettings.intervalDays} hari. Run berikutnya: ${nextRun || 'belum dijadwalkan'}. Satu panggilan AI maksimal 400 token.`
      : 'Job nonaktif. Saat diaktifkan, proposal pertama dijadwalkan setelah interval; tidak ada panggilan langsung.';
  }

  function activateTab(name) {
    const button = $('.tab[data-tab="' + name + '"]');
    if (!button) return;
    $$('.tab').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    $$('.tab-panel').forEach((panel) => {
      const active = panel.id === 'tab-' + name;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    button.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  const sidebar = $('#dashboard-sidebar');
  const sidebarToggle = $('#sidebar-toggle');
  const sidebarBackdrop = $('#sidebar-backdrop');
  const sidebarClose = $('#sidebar-close');
  const sidebarViewport = window.matchMedia('(max-width: 899px)');
  function setSidebarOpen(open, { restoreFocus = true, focusPanel = false } = {}) {
    if (!sidebarViewport.matches) return;
    sidebar.classList.toggle('is-open', open);
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    sidebar.setAttribute('role', open ? 'dialog' : 'complementary');
    if (open) sidebar.setAttribute('aria-modal', 'true'); else sidebar.removeAttribute('aria-modal');
    sidebarToggle.setAttribute('aria-expanded', String(open));
    sidebarBackdrop.hidden = !open;
    document.body.classList.toggle('nav-open', open);
    if (open) $('.tab[aria-selected="true"]', sidebar).focus();
    else if (focusPanel) $('#tab-' + $('.tab[aria-selected="true"]', sidebar).dataset.tab).focus();
    else if (restoreFocus) sidebarToggle.focus();
  }
  function syncSidebarViewport() {
    if (sidebarViewport.matches) {
      const focusWasInSidebar = sidebar.contains(document.activeElement);
      setSidebarOpen(false, { restoreFocus: false });
      if (focusWasInSidebar) sidebarToggle.focus();
    }
    else {
      const focusWasOnMobileControl = document.activeElement === sidebarToggle
        || document.activeElement === sidebarClose || document.activeElement === sidebarBackdrop;
      sidebar.classList.remove('is-open'); sidebar.inert = false;
      sidebar.setAttribute('aria-hidden', 'false'); sidebar.setAttribute('role', 'complementary');
      sidebar.removeAttribute('aria-modal'); sidebarToggle.setAttribute('aria-expanded', 'false');
      sidebarBackdrop.hidden = true; document.body.classList.remove('nav-open');
      if (focusWasOnMobileControl) $('.tab[aria-selected="true"]', sidebar).focus();
    }
  }
  function loadTabData(name) {
    if (name === 'admins') loadAdmins().catch((error) => show('#global-error', errorText(error)));
    if (name === 'integrations' || name === 'ai') loadIntegrations().catch((error) => show('#global-error', integrationError(error)));
    if (name === 'strategy') api('/api/content-strategy').then(renderContentStrategy).catch((error) => show('#global-error', errorText(error)));
    if (name === 'content') loadWebsiteSync().catch((error) => show('#global-error', errorText(error)));
  }
  syncSidebarViewport();
  sidebarViewport.addEventListener?.('change', syncSidebarViewport);
  sidebarToggle.addEventListener('click', () => setSidebarOpen(true));
  sidebarClose.addEventListener('click', () => setSidebarOpen(false));
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (!sidebarViewport.matches || !sidebar.classList.contains('is-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); return; }
    if (event.key !== 'Tab') return;
    const focusable = $$('button:not([disabled]):not([hidden]):not([tabindex="-1"])', sidebar);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  function setOnboardingLoadState(status) {
    const loading = $('#onboarding-loading');
    const error = $('#onboarding-error');
    const summary = $('#onboarding-summary');
    const incomplete = $('#onboarding-incomplete');
    const details = $('#onboarding-details');
    loading.hidden = status !== 'loading';
    error.hidden = status !== 'error';
    summary.hidden = true;
    incomplete.hidden = true;
    details.hidden = true;
    const badge = $('#onboarding-count');
    badge.textContent = status === 'loading' ? 'Memuat status' : 'Status tidak tersedia';
    badge.className = 'pill neutral';
  }

  function renderOnboarding(items) {
    if (!Array.isArray(items) || items.length === 0 || items.some((item) => !item || typeof item.required !== 'boolean' || typeof item.complete !== 'boolean')) {
      setOnboardingLoadState('error');
      return;
    }
    const list = $('#onboarding-list');
    const required = items.filter((item) => item.required);
    const completeRequired = required.filter((item) => item.complete).length;
    const missing = required.length - completeRequired;
    const complete = required.length > 0 && missing === 0;
    const sortedItems = [...items].sort((a, b) => {
      const rank = (item) => item.required ? item.complete ? 1 : 0 : item.complete ? 3 : 2;
      return rank(a) - rank(b);
    });
    list.replaceChildren(...sortedItems.map((item) => {
      const li = document.createElement('li');
      if (!item.complete) li.classList.add('incomplete');
      if (item.required === false) li.classList.add('optional');
      else li.classList.add('required');
      const heading = document.createElement('div');
      heading.className = 'onboarding-item-heading';
      const icon = document.createElement('span');
      icon.className = `onboarding-item-icon ${item.complete ? 'complete' : 'incomplete'}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.complete ? '✓' : '!';
      const text = document.createElement('span');
      text.className = 'onboarding-label';
      text.textContent = onboardingLabels[item.key] || item.label || item.key || 'Persiapan awal';
      heading.append(icon, text);
      const footer = document.createElement('div');
      footer.className = 'onboarding-item-footer';
      const status = document.createElement('span');
      status.className = `onboarding-item-status ${item.complete ? 'complete' : 'incomplete'}`;
      status.textContent = `${item.required ? 'Wajib' : 'Opsional'} · ${item.complete ? 'Selesai' : item.required ? 'Belum selesai' : 'Perlu diisi'}`;
      footer.append(status);
      const target = onboardingTargets[item.key];
      if (!item.complete && target) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'onboarding-action';
        action.dataset.onboardingTarget = item.key;
        action.textContent = target.field ? 'Buka pengaturan' : 'Lihat status';
        action.addEventListener('click', () => {
          activateTab(target.tab);
          loadTabData(target.tab);
          const form = target.field ? $('#tab-' + target.tab + ' form') : null;
          const focusTarget = target.field ? form?.elements.namedItem(target.field) : document.getElementById(target.element);
          focusTarget?.focus({ preventScroll: true });
          focusTarget?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        });
        footer.append(action);
      }
      li.append(heading, footer);
      return li;
    }));
    const loading = $('#onboarding-loading'); loading.hidden = true;
    const error = $('#onboarding-error'); error.hidden = true;
    const summary = $('#onboarding-summary'); summary.hidden = !complete;
    const incomplete = $('#onboarding-incomplete'); incomplete.hidden = complete;
    const details = $('#onboarding-details');
    const badge = $('#onboarding-count');
    badge.textContent = complete ? 'Wajib lengkap' : `${missing} wajib tersisa`;
    badge.className = `pill ${complete ? 'good' : 'warning'}`;
    $('#onboarding-progress').textContent = `${completeRequired} dari ${required.length} konfigurasi wajib selesai.`;
    if (complete && state.onboardingComplete !== true) state.onboardingExpanded = false;
    if (!complete) state.onboardingExpanded = false;
    if (state.onboardingComplete !== complete) {
      $('#onboarding-announcement').textContent = complete
        ? `Konfigurasi wajib lengkap: ${completeRequired} dari ${required.length} item selesai.`
        : state.onboardingComplete === true
          ? 'Onboarding kembali belum lengkap. Periksa item wajib yang perlu diperbaiki.'
          : `Onboarding belum lengkap. ${missing} dari ${required.length} item wajib masih perlu disiapkan.`;
    }
    state.onboardingComplete = complete;
    details.hidden = complete && !state.onboardingExpanded;
    const toggle = $('#onboarding-details-toggle');
    toggle.hidden = !complete;
    toggle.setAttribute('aria-expanded', String(complete && state.onboardingExpanded));
    toggle.textContent = state.onboardingExpanded ? 'Sembunyikan detail' : 'Lihat detail';
  }

  function renderPosts(posts = []) {
    const body = $('#posts-table');
    const rows = posts.map((post) => {
      const tr = document.createElement('tr');
      const time = document.createElement('td'); time.textContent = post.scheduledAt || post.createdAt ? new Date(post.scheduledAt || post.createdAt).toLocaleString('id-ID') : '—';
      const pillar = document.createElement('td');
      pillar.textContent = post.contentStrategy?.category?.name
        ? `${post.contentStrategy.category.name}${post.contentStrategy.style?.name ? ` · ${post.contentStrategy.style.name}` : ''}`
        : post.pillar === 'ndi' ? 'Konten NDI' : post.pillar ? 'Riwayat lama' : '—';
      const statusCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status-label ${post.status || ''}`; badge.textContent = statusLabels[post.status] || 'Belum diketahui'; statusCell.append(badge);
      if (post.reviewed === true) { const reviewed = document.createElement('span'); reviewed.className = 'status-label reviewed'; reviewed.textContent = 'Reviewed'; reviewed.setAttribute('aria-label', 'Caption berhasil diperbaiki oleh AI Reviewer'); statusCell.append(document.createTextNode(' '), reviewed); }
      const caption = document.createElement('td'); caption.textContent = post.caption || post.errorCode || '—';
      tr.append(time, pillar, statusCell, caption); return tr;
    });
    if (!rows.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'Belum ada riwayat posting.'; row.append(cell); rows.push(row); }
    body.replaceChildren(...rows);
  }

  function renderActivity(events = []) {
    const target = $('#activity-list');
    const rows = events.map((event) => {
      const row = document.createElement('div'); row.className = 'activity-item';
      const time = document.createElement('time'); time.textContent = event.createdAt ? new Date(event.createdAt).toLocaleString('id-ID') : '—';
      const title = document.createElement('strong'); title.textContent = activityLabels[event.event || event.action] || 'Aktivitas sistem';
      const details = document.createElement('span'); details.textContent = escapeText(event.message || event.code || event.status || event.errorCode || '');
      row.append(time, title, details); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada aktivitas.'; rows.push(empty); }
    target.replaceChildren(...rows);
  }

  async function loadAdmins() {
    const target = $('#admin-list');
    target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Memuat daftar admin…' }));
    const { admins = [] } = await api('/api/admins');
    if (!admins.length) { target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Belum ada akun admin.' })); return; }
    const activeAdminCount = admins.filter((admin) => admin.active).length;
    target.replaceChildren(...admins.map((admin) => {
      const form = document.createElement('form'); form.className = 'panel form-grid admin-row'; form.dataset.adminId = String(admin.id);
      const heading = document.createElement('div'); heading.className = 'panel-heading full';
      const title = document.createElement('div'); const email = document.createElement('h2'); email.textContent = admin.email;
      const status = document.createElement('p'); status.className = 'muted'; status.id = `admin-status-${admin.id}`;
      status.textContent = admin.active && activeAdminCount === 1 ? 'Admin aktif terakhir tidak dapat dinonaktifkan.' : admin.active ? 'Aktif' : 'Dinonaktifkan';
      title.append(email, status); heading.append(title);
      const emailLabel = document.createElement('label'); emailLabel.textContent = 'Email admin';
      const emailInput = document.createElement('input'); emailInput.name = 'email'; emailInput.type = 'email'; emailInput.required = true; emailInput.maxLength = 254; emailInput.value = admin.email; emailLabel.append(emailInput);
      form.dataset.originalEmail = admin.email;
      const passwordLabel = document.createElement('label'); passwordLabel.textContent = 'Kata sandi baru (opsional)';
      const passwordInput = document.createElement('input'); passwordInput.name = 'password'; passwordInput.type = 'password'; passwordInput.autocomplete = 'new-password'; passwordInput.minLength = 12; passwordInput.maxLength = 256; passwordLabel.append(passwordInput); addPasswordToggle(passwordInput);
      const footer = document.createElement('div'); footer.className = 'form-footer full';
      const save = document.createElement('button'); save.className = 'button primary'; save.type = 'submit'; save.textContent = 'Simpan perubahan';
      const toggle = document.createElement('button'); toggle.className = `button ${admin.active ? 'danger' : 'quiet'}`; toggle.type = 'button'; toggle.dataset.active = String(admin.active); toggle.textContent = admin.active ? 'Nonaktifkan' : 'Aktifkan kembali';
      toggle.disabled = admin.active && activeAdminCount === 1;
      toggle.setAttribute('aria-describedby', status.id);
      footer.append(save, toggle); form.append(heading, emailLabel, passwordLabel, footer);
      return form;
    }));
  }

  function render(data) {
    state.data = data;
    const automation = data.automation || {};
    const contentStrategyReady = automation.contentStrategyReady === true;
    const blockedForReadiness = automation.enabled && (automation.onboardingComplete !== true || !contentStrategyReady);
    $('#automation-label').textContent = blockedForReadiness ? 'Penerbitan diblokir' : automation.enabled ? 'Otomasi aktif' : 'Otomasi nonaktif';
    $('#automation-reason').textContent = !contentStrategyReady
      ? (automation.contentStrategyReason || 'Periksa dan aktifkan strategi konten NDI sebelum mengaktifkan otomasi.')
      : blockedForReadiness
        ? 'Tinjau pengetahuan NDI, jeda otomasi, lalu aktifkan kembali secara manual setelah siap.'
        : automation.enabled ? 'Tugas berjalan sesuai jadwal.' : 'Tinjau pengetahuan NDI, hubungkan akun Threads testing di Tebar, dan konfigurasi penyedia AI.';
    const dot = $('#automation-state'); dot.className = `state-dot ${blockedForReadiness ? 'paused' : automation.enabled ? 'on' : 'off'}`;
    const control = $('#automation-button'); control.textContent = automation.enabled ? 'Jeda otomasi' : 'Aktifkan otomasi'; control.className = `button ${automation.enabled ? 'danger' : 'primary'}`;
    const provider = data.provider || {};
    $('#provider-status').textContent = provider.connected ? (provider.status || 'Terhubung') : 'Belum terhubung';
    $('#provider-account').textContent = provider.username ? `@${provider.username}` : 'Hubungkan melalui Tebar';
    $('#metric-success').textContent = String(data.metrics?.success30d ?? 0);
    $('#metric-clicks').textContent = data.metrics?.clicks?.available ? String(data.metrics.clicks.value) : 'Belum tersedia';
    $('#metric-failed').textContent = String(data.metrics?.attention ?? 0);
    $('#metric-services').textContent = String(data.metrics?.services ?? data.businessKnowledge?.services?.length ?? 0);
    renderOnboarding(data.onboarding); renderPosts(data.posts || []); renderActivity(data.activity || []); readSettings();
    renderContentStrategy(data.contentStrategy || {});
  }

  async function refresh() {
    const request = state.dashboardLoad = (state.dashboardLoad || 0) + 1;
    setOnboardingLoadState('loading');
    try {
      const data = await api('/api/dashboard');
      if (request !== state.dashboardLoad) return false;
      render(data);
      hide('#global-error');
      return true;
    } catch (error) {
      if (request === state.dashboardLoad) setOnboardingLoadState('error');
      throw error;
    }
  }

  function integrationVersion() {
    const version = state.integrations?.configuration?.version;
    if (version === undefined || version === null) { const error = new Error('CONFIG_NOT_LOADED'); error.code = 'CONFIG_NOT_LOADED'; throw error; }
    return version;
  }
  function integrationError(error) {
    if (error?.code === 'CONFIG_NOT_LOADED') return 'Muat ulang konfigurasi sebelum melanjutkan.';
    return errorText(error);
  }
  const publicationActions = {
    'close-unverified': {
      title: 'Tutup sebagai tidak terverifikasi — tidak ditemukan',
      guidance: 'Postingan masih mungkin muncul terlambat. Tutup slot hanya setelah riwayat Tebar dan Threads pada akun asal diperiksa. Bot NDI akan melewati slot ini tanpa mengirim ulang.',
      confirmation: 'Saya telah memeriksa akun asal dan memahami bahwa postingan masih mungkin muncul terlambat.',
      submit: 'Tutup tanpa verifikasi',
      success: 'Slot ditutup tanpa verifikasi. Jika pergantian akun masih menunggu, periksa slot lain lalu pilih Lanjutkan pemeriksaan.',
    },
    'link-provider-post': {
      title: 'Kaitkan ID post Tebar',
      guidance: 'Cocokkan caption dan waktu publikasi terlebih dahulu. Server akan meminta Tebar mengonfirmasi bahwa ID ini sudah terbit pada profile dan akun Threads asal.',
      confirmation: 'Saya telah mencocokkan ID post dengan caption, waktu, dan akun asal slot ini.',
      submit: 'Verifikasi dan kaitkan ID',
      success: 'ID post Tebar dikaitkan. Periksa status slot dan lanjutkan pergantian akun jika semua slot sudah selesai.',
    },
  };

  function publicationNode(tag, content, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function publicationDate(value) {
    const time = value && new Date(value);
    return time && Number.isFinite(time.getTime())
      ? time.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', timeZoneName: 'short' })
      : 'Tidak tersedia';
  }

  function renderWebsiteSync(data = {}) {
    const status = $('#website-sync-status');
    const proposalsTarget = $('#website-sync-proposals');
    const runsTarget = $('#website-sync-runs');
    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    const runs = Array.isArray(data.runs) ? data.runs : [];
    const pending = proposals.filter((proposal) => proposal.status === 'pending').length;
    status.className = pending ? 'notice warning' : 'notice info';
    status.textContent = `Versi pengetahuan ${Number(data.knowledgeVersion) || 1}. ${pending ? `${pending} perubahan menunggu keputusan per item.` : 'Tidak ada perubahan yang menunggu keputusan.'} Sinkronisasi hanya berjalan saat tombol ditekan.`;
    proposalsTarget.replaceChildren(...proposals.map((proposal) => {
      const card = publicationNode('article', undefined, 'integration-history-item stack');
      const operation = ({ add: 'Usulan penambahan layanan', edit: 'Usulan perubahan layanan', remove: 'Usulan penghapusan layanan' })[proposal.operation] || 'Usulan layanan';
      const stateLabel = ({ pending: 'Menunggu tinjauan', approved: 'Disetujui', rejected: 'Ditolak', conflict: 'Konflik versi' })[proposal.status] || 'Status tidak diketahui';
      card.append(publicationNode('h3', operation), publicationNode('strong', proposal.targetValue || 'Nilai usulan tidak tersedia'));
      if (proposal.baseValue) card.append(publicationNode('p', `Nilai saat ini: ${proposal.baseValue}`, 'publication-text'));
      card.append(publicationNode('p', `${stateLabel} · versi pengetahuan ${Number(proposal.knowledgeVersion) || 1}${proposal.conflictCode ? ` · ${proposal.conflictCode}` : ''}`));
      const link = document.createElement('a'); link.href = 'https://nusadataindonesia.com/'; link.textContent = 'Sumber resmi: nusadataindonesia.com'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      card.append(link, publicationNode('p', `${proposal.sourceTitle || 'Website Resmi NDI'} · ${publicationDate(proposal.fetchedAt)}`, 'muted'));
      if (proposal.status === 'pending') {
        const actions = publicationNode('div', undefined, 'form-actions');
        for (const [decision, label, className] of [['approve', 'Setujui perubahan ini', 'button primary'], ['reject', 'Tolak perubahan ini', 'button quiet']]) {
          const button = publicationNode('button', label, className);
          button.type = 'button'; button.dataset.websiteProposalId = proposal.id; button.dataset.decision = decision;
          actions.append(button);
        }
        card.append(actions);
      }
      return card;
    }));
    if (!proposals.length) proposalsTarget.replaceChildren(publicationNode('p', 'Belum ada usulan sinkronisasi. Tekan tombol untuk mengambil halaman resmi dan membandingkan daftar layanan.', 'muted'));
    runsTarget.replaceChildren(...runs.map((run) => {
      const entry = publicationNode('article', undefined, 'integration-history-item');
      const result = run.status === 'completed' ? `${Number(run.proposalCount) || 0} usulan dibuat` : run.status === 'failed' ? `Gagal (${run.errorCode || 'WEBSITE_SYNC_FAILED'})` : 'Sedang diproses';
      entry.append(publicationNode('strong', `${publicationDate(run.createdAt)} · ${result}`), publicationNode('p', `Sumber tetap: nusadataindonesia.com · versi ${Number(run.knowledgeVersion) || 1}`, 'muted'));
      return entry;
    }));
    if (!runs.length) runsTarget.replaceChildren(publicationNode('p', 'Belum ada riwayat permintaan.', 'muted'));
  }

  async function loadWebsiteSync() {
    const target = $('#website-sync-proposals');
    target.replaceChildren(publicationNode('p', 'Memuat usulan sinkronisasi…', 'muted'));
    const data = await api('/api/website-sync');
    renderWebsiteSync(data);
    return data;
  }

  function renderProviderHolds(holds = [], configuration = {}) {
    const renderHolds = (selector, entries) => {
      const target = $(selector);
      target.replaceChildren(...entries.map(({ provider, profileId, accountId, reasonCode }) => {
        if (provider === 'openrouter') return publicationNode('p', `OpenRouter ditahan untuk seluruh akun (${reasonCode}). Perbaiki akses OpenRouter, lalu pilih Verifikasi Model dan Muat ulang model di tab AI.`);
        const active = profileId === configuration.profileId && accountId === configuration.accountId;
        const recovery = active ? 'Perbaiki akses akun lalu pilih Periksa akun aktif.' : 'Verifikasi pasangan ini sebelum menggunakannya kembali.';
        return publicationNode('p', `Tebar ditahan untuk profile ${profileId}, akun ${accountId} (${reasonCode}). ${recovery}`);
      }));
      target.hidden = entries.length === 0;
    };
    const relevant = Array.isArray(holds) ? holds.filter((hold) => ['openrouter', 'tebar'].includes(hold?.provider)) : [];
    renderHolds('#integration-provider-holds', relevant);
    renderHolds('#ai-provider-holds', relevant.filter((hold) => hold.provider === 'openrouter'));
  }

  function openPublicationResolution(slot, action, lateLink = false) {
    const form = $('#publication-resolution-form');
    const link = action === 'link-provider-post';
    const copy = lateLink ? {
      title: 'Kaitkan publikasi yang muncul terlambat',
      guidance: 'Slot ini sudah ditutup. Jika post kemudian ditemukan di Tebar, masukkan ID post dan pastikan post sudah terbit pada akun Threads asal. Server hanya melakukan pemeriksaan GET; tindakan ini tidak menerbitkan ulang post.',
      confirmation: 'Saya telah mencocokkan ID post, caption, waktu, dan akun Threads asal serta memahami post tidak akan dikirim ulang.',
      submit: 'Verifikasi tanpa mengirim ulang',
    } : publicationActions[action];
    form.reset();
    state.publicationResolution = { slotId: slot.id, action, lateLink };
    $('#publication-resolution-title').textContent = copy.title;
    $('#publication-resolution-target').textContent = `Slot ${slot.id} · Profile ${slot.profileId || '—'} · Akun ${slot.accountId || '—'}`;
    $('#publication-resolution-guidance').textContent = copy.guidance;
    $('#publication-resolution-confirm-label').textContent = copy.confirmation;
    $('#publication-resolution-submit').textContent = copy.submit;
    $('#publication-resolution-error').hidden = true;
    $('#publication-resolution-result').hidden = true;
    $('#publication-provider-post-field').hidden = !link;
    form.elements.providerPostId.required = link;
    $('#publication-resolution-dialog').showModal();
  }

  function renderPublicationCard(slot, lateLink = false) {
    const card = publicationNode('article', undefined, 'integration-history-item publication-card stack');
    const title = publicationNode('h3', `Slot ${slot.id}`);
    const fields = publicationNode('dl', undefined, 'integration-summary');
    for (const [label, value] of [
      ['Profile asal', slot.profileId], ['Akun Threads asal', slot.accountId],
      ['Waktu percobaan', publicationDate(slot.publishStartedAt)], ['Waktu terjadwal', publicationDate(slot.scheduledAt)],
      ['Status slot', statusLabels[slot.status] || slot.status], ['Status Tebar', slot.providerStatus],
      ['Kode error', slot.errorCode], ['ID post Tebar', slot.providerPostId],
      ...(slot.status === 'unknown' ? [['Kejadian status belum pasti', slot.unknownOccurrenceCount ?? '—']] : []),
    ]) {
      const field = publicationNode('div');
      field.append(publicationNode('dt', label), publicationNode('dd', value === 0 ? '0' : value || '—'));
      fields.append(field);
    }
    card.append(title, fields, publicationNode('p', slot.caption || 'Caption tidak tersedia.', 'publication-text'));
    if (lateLink) {
      if (slot.lateLinkEligible !== true || !slot.profileId || !slot.accountId) {
        card.append(publicationNode('p', 'Target asal belum lengkap atau tidak cocok dengan riwayat slot. Periksa catatan publikasi dan pasangan akun asal di server.', 'muted'));
        return card;
      }
      const actions = publicationNode('div', undefined, 'form-actions');
      const button = publicationNode('button', 'Kaitkan ID post tanpa mengirim ulang', 'button quiet');
      button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => openPublicationResolution(slot, 'link-provider-post', true));
      actions.append(button);
      card.append(publicationNode('p', 'Slot ini sudah ditutup tanpa verifikasi. Post yang ditemukan kemudian dapat ditautkan setelah pemeriksaan.', 'muted'), actions);
    } else if (slot.status === 'unknown' && slot.providerPostId == null) {
      if (slot.resolutionEligible === false) {
        card.append(publicationNode('p', 'Slot ini belum memenuhi syarat untuk keputusan admin. Periksa status dan catatan publikasi di server.', 'muted'));
        return card;
      }
      const targetValid = slot.resolutionTargetValid !== false && Boolean(slot.profileId && slot.accountId);
      const actions = publicationNode('div', undefined, 'form-actions');
      const availableActions = targetValid ? Object.keys(publicationActions) : ['close-unverified'];
      for (const action of availableActions) {
        const button = publicationNode('button', publicationActions[action].title, 'button quiet');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.addEventListener('click', () => openPublicationResolution(slot, action));
        actions.append(button);
      }
      if (!targetValid) card.append(publicationNode('p', 'Target asal belum lengkap atau tidak cocok dengan riwayat slot. Slot hanya dapat ditutup sebagai tidak terverifikasi setelah pemeriksaan dan pencatatan bukti; ID post tidak dapat dikaitkan.', 'muted'));
      card.append(actions);
    } else if (slot.status === 'unknown' && typeof slot.providerPostId === 'string' && slot.providerPostId) {
      const actions = publicationNode('div', undefined, 'form-actions');
      const button = publicationNode('button', 'Periksa ulang status Tebar', 'button quiet');
      button.type = 'button';
      button.addEventListener('click', () => reconcilePublicationSlot(slot, button));
      actions.append(button);
      card.append(publicationNode('p', `ID post sudah terkait. Pemeriksaan GET tetap memakai profile ${slot.profileId || '—'} dan akun Threads asal ${slot.accountId || '—'}. Jika status belum diketahui, pemeriksaan dapat dicoba lagi.`, 'muted'), actions);
    } else {
      card.append(publicationNode('p', 'Slot ini menunggu rekonsiliasi status dari Tebar. Periksa post pada akun asal sebelum melanjutkan.', 'muted'));
    }
    return card;
  }

  async function reconcilePublicationSlot(slot, button) {
    return withPending(button, async () => {
      const notice = $('#publication-resolution-result');
      notice.hidden = true;
      try {
        const { reconciliation } = await api(`/api/publication-resolution/${encodeURIComponent(slot.id)}/reconcile`, { method: 'POST' });
        const refreshed = await loadPublicationResolution(state.integrationLoad, state.closedSlotSearchId || '');
        const scope = `profile ${slot.profileId || '—'} dan akun Threads asal ${slot.accountId || '—'}`;
        notice.textContent = reconciliation?.pending === true || reconciliation?.status === 'unknown'
          ? `Tebar belum memastikan status pada ${scope}. ID post tetap terkait; coba pemeriksaan GET lagi nanti.`
          : `Pemeriksaan GET selesai pada ${scope}. Status slot: ${reconciliation?.status || 'diperbarui'}.`;
        if (!refreshed) notice.textContent += ' Daftar slot belum dapat diperbarui.';
        notice.hidden = false;
      } catch (error) {
        notice.textContent = `Pemeriksaan status belum berhasil pada profile ${slot.profileId || '—'} dan akun Threads asal ${slot.accountId || '—'}. ID post tetap terkait; coba lagi nanti. ${errorText(error)}`;
        notice.hidden = false;
      }
    }, 'Memeriksa…');
  }

  function renderPublicationResolution({ slots = [], closedSlots = [], events = [] } = {}, closedSlotId = '') {
    const cards = slots.map((slot) => renderPublicationCard(slot));
    const closedCards = closedSlots.map((slot) => renderPublicationCard(slot, true));
    $('#publication-blockers').replaceChildren(...cards);
    $('#publication-blocker-count').textContent = cards.length
      ? `${cards.length} slot perlu diperiksa.`
      : 'Tidak ada slot yang masih menghambat rekonsiliasi publikasi.';
    $('#publication-closed-blockers').replaceChildren(...closedCards);
    $('#publication-closed-blocker-count').textContent = closedSlotId
      ? closedCards.length ? `Slot ID ${closedSlotId} ditemukan. Publikasi terlambat dapat dikaitkan setelah verifikasi.` : `Slot ID ${closedSlotId} tidak ditemukan sebagai publikasi tertutup yang masih dapat ditindaklanjuti.`
      : closedCards.length ? `${closedCards.length} slot terbaru telah ditutup; publikasi yang ditemukan kemudian dapat dikaitkan setelah verifikasi.` : 'Tidak ada publikasi terlambat dari slot yang ditutup dalam 100 slot terbaru.';
    $('#publication-resolution-audit').hidden = events.length === 0;
    $('#publication-resolution-history').replaceChildren(...events.map((event) => {
      const row = publicationNode('article', undefined, 'integration-history-item publication-card stack');
      const actor = event.actorEmail || event.actorId || '—';
      const action = event.action === 'link_provider_post' ? 'Pengaitan ID post Tebar' : 'Penutupan tanpa verifikasi';
      row.append(
        publicationNode('h3', action),
        publicationNode('strong', `Slot ${event.slotId} · ${statusLabels[event.previousStatus] || event.previousStatus} → ${statusLabels[event.newStatus] || event.newStatus}`),
        publicationNode('p', `${publicationDate(event.createdAt)} · Admin ${actor}`),
        publicationNode('p', `Alasan: ${event.reason}`, 'publication-text'),
        publicationNode('p', `Bukti: ${event.evidenceSummary}`, 'publication-text'),
      );
      if (event.providerPostId) row.append(publicationNode('p', `ID post Tebar: ${event.providerPostId}`));
      return row;
    }));
  }

  async function loadPublicationResolution(integrationLoad, closedSlotId = '') {
    state.publicationLoadRequest = (state.publicationLoadRequest || 0) + 1;
    const request = state.publicationLoadRequest;
    try {
      const path = closedSlotId
        ? `/api/publication-resolution/slots?slotId=${encodeURIComponent(closedSlotId)}`
        : '/api/publication-resolution/slots';
      const data = await api(path);
      if (request !== state.publicationLoadRequest || integrationLoad !== state.integrationLoad) return false;
      if (!Array.isArray(data.slots) || !Array.isArray(data.closedSlots) || !Array.isArray(data.events)) throw new Error('Invalid publication resolution response');
      renderPublicationResolution(data, closedSlotId);
      return true;
    } catch {
      if (request !== state.publicationLoadRequest || integrationLoad !== state.integrationLoad) return false;
      renderPublicationResolution();
      $('#publication-blocker-count').textContent = 'Daftar slot belum dapat dibaca. Pilih Muat ulang konfigurasi untuk mencoba kembali.';
      if (closedSlotId) $('#publication-closed-blocker-count').textContent = `Pencarian Slot ID ${closedSlotId} belum dapat dimuat.`;
      return false;
    }
  }

  $('#publication-closed-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const slotId = form.elements.slotId.value.trim();
    const error = $('#publication-closed-search-error');
    error.hidden = true;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slotId)) {
      error.textContent = 'Masukkan Slot ID lengkap dalam format UUID.';
      error.hidden = false;
      return;
    }
    state.closedSlotSearchId = slotId.toLowerCase();
    return withPending(event.submitter || $('button[type="submit"]', form), async () => {
      if (!await loadPublicationResolution(state.integrationLoad, state.closedSlotSearchId)) {
        error.textContent = 'Pencarian Slot ID belum berhasil. Coba lagi.';
        error.hidden = false;
      }
    }, 'Mencari…', form);
  });
  $('#publication-closed-search-reset').addEventListener('click', () => {
    state.closedSlotSearchId = '';
    $('#publication-closed-search-form').elements.slotId.value = '';
    $('#publication-closed-search-error').hidden = true;
    return loadPublicationResolution(state.integrationLoad);
  });

  $('#publication-resolution-cancel').addEventListener('click', () => $('#publication-resolution-dialog').close());
  $('#publication-resolution-dialog').addEventListener('cancel', (event) => {
    if ($('#publication-resolution-form').dataset.pending === 'true') event.preventDefault();
  });
  $('#publication-resolution-dialog').addEventListener('close', (event) => {
    if (!event.currentTarget.open) state.publicationResolution = null;
  });
  $('#publication-resolution-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const operation = state.publicationResolution;
    if (!operation) return;
    const form = event.currentTarget;
    const errorNotice = $('#publication-resolution-error');
    errorNotice.hidden = true;
    const reason = form.elements.reason.value.trim();
    const evidenceSummary = form.elements.evidenceSummary.value.trim();
    const providerPostId = form.elements.providerPostId.value.trim();
    const link = operation.action === 'link-provider-post';
    if (!form.elements.confirmed.checked || reason.length < 10 || reason.length > 1000
      || evidenceSummary.length < 10 || evidenceSummary.length > 2000
      || (link && !/^[A-Za-z0-9_-]{1,128}$/.test(providerPostId))) {
      errorNotice.textContent = 'Isi alasan dan ringkasan bukti, periksa ID post jika diperlukan, lalu centang konfirmasi.';
      errorNotice.hidden = false;
      return;
    }
    const body = { reason, evidenceSummary, ...(link ? { providerPostId, confirmOriginalTarget: true } : { confirmDelayedPublication: true }) };
    const fingerprint = JSON.stringify(body);
    return withPending($('#publication-resolution-submit'), async () => {
      if (typeof crypto.randomUUID !== 'function') {
        errorNotice.textContent = 'Buka dashboard melalui HTTPS untuk menyimpan keputusan.';
        errorNotice.hidden = false;
        return;
      }
      if (fingerprint !== operation.fingerprint) {
        operation.fingerprint = fingerprint;
        operation.requestId = crypto.randomUUID();
      }
      try {
        const slotId = encodeURIComponent(operation.slotId);
        const payload = JSON.stringify({ requestId: operation.requestId, ...body });
        const { resolution } = link
          ? await api(`/api/publication-resolution/${slotId}/link-provider-post`, { method: 'POST', body: payload })
          : await api(`/api/publication-resolution/${slotId}/close-unverified`, { method: 'POST', body: payload });
        if (resolution?.requestId !== operation.requestId || resolution.slotId !== operation.slotId) {
          throw new Error('Missing publication resolution receipt');
        }
      } catch (error) {
        if (state.publicationResolution !== operation) return;
        const uncertain = !error?.status || (error.status >= 500 && error.code !== 'PUBLICATION_VERIFICATION_UNAVAILABLE');
        let message = errorText(error);
        if (uncertain) message = 'Hasil penyimpanan belum dapat dipastikan. Coba lagi dengan isian yang sama untuk memeriksa permintaan ini.';
        else if (!link && error.code === 'PUBLICATION_TARGET_MISMATCH') message = 'Target asal berubah atau belum lengkap. Periksa catatan slot sebelum menutupnya.';
        errorNotice.textContent = message;
        errorNotice.hidden = false;
        return;
      }
      if (state.publicationResolution !== operation) return;
      state.publicationResolution = null;
      $('#publication-resolution-dialog').close();
      form.reset();
      $('#publication-blockers-title').focus();
      const session = state.csrf;
      const updated = await loadIntegrations({ verification: state.integrationVerification }).catch(() => false);
      const dashboard = updated && await refresh().catch(() => false);
      if (session !== state.csrf) return;
      const result = $('#publication-resolution-result');
      const success = operation.lateLink
        ? 'Publikasi terlambat dikaitkan tanpa mengirim ulang. Rekonsiliasi status dilanjutkan melalui pemeriksaan GET.'
        : publicationActions[operation.action].success;
      result.textContent = success
        + (updated && dashboard ? '' : ' Tampilan terkini belum lengkap. Muat ulang konfigurasi.');
      result.hidden = false;
    }, 'Memeriksa…', form);
  });

  function modelReasonText(reason) {
    return ({
      TEXT_MODALITY_UNSUPPORTED: 'Model tidak menerima dan menghasilkan teks.',
      COMPLETION_LIMIT_UNSUPPORTED: 'Model tidak mendukung batas token keluaran yang digunakan Bot NDI.',
      TEMPERATURE_UNSUPPORTED: 'Model tidak mendukung pengaturan temperature Bot NDI.',
      TOP_P_UNSUPPORTED: 'Model tidak mendukung pengaturan top-p Bot NDI.',
      METADATA_INCOMPLETE: 'Metadata OpenRouter belum cukup untuk memeriksa kompatibilitas.',
      MANUAL_ID: 'ID manual perlu diverifikasi langsung melalui OpenRouter.',
    })[reason] || '';
  }
  function modelStatusText(status) {
    return ({ AVAILABLE: 'Tersedia · kompatibel berdasarkan metadata', INCOMPATIBLE: 'Tidak kompatibel', NOT_FOUND: 'Tidak ditemukan', UNVERIFIED: 'Belum dapat diverifikasi' })[status] || 'Belum diverifikasi';
  }
  function closeModelOptions() {
    $('#integration-model-options').hidden = true;
    $('#integration-model-search').setAttribute('aria-expanded', 'false');
    $('#integration-model-search').removeAttribute('aria-activedescendant');
    state.modelActiveOption = -1;
  }
  function renderModelOptions(query) {
    const input = $('#integration-model-search');
    const list = $('#integration-model-options');
    const empty = $('#integration-model-empty');
    list.replaceChildren();
    const matches = searchOpenRouterModels(state.modelCatalog, query, 50);
    state.modelOptionMatches = matches;
    state.modelActiveOption = -1;
    if (!state.modelCatalog) {
      list.hidden = true; empty.hidden = true; input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant'); return;
    }
    if (!matches.length) {
      list.hidden = true; empty.hidden = false;
      empty.textContent = query ? 'Tidak ada model yang cocok. Coba nama, provider, atau Model ID lain.' : 'Katalog OpenRouter belum berisi model.';
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); return;
    }
    empty.hidden = true; list.hidden = false; input.setAttribute('aria-expanded', 'true');
    matches.forEach((model, index) => {
      const option = document.createElement('div');
      option.id = `integration-model-option-${index}`; option.className = 'model-option';
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(model.id === state.modelSelection?.id));
      option.dataset.modelIndex = String(index);
      const heading = document.createElement('span'); heading.className = 'model-option-heading';
      const name = document.createElement('strong'); name.textContent = model.name || model.id;
      const status = document.createElement('span'); status.className = `model-status model-status-${String(model.status || 'UNVERIFIED').toLowerCase()}`;
      status.textContent = modelStatusText(model.status);
      const id = document.createElement('span'); id.className = 'model-option-id'; id.textContent = model.id;
      const provider = document.createElement('span'); provider.className = 'model-option-provider'; provider.textContent = `Provider / namespace: ${model.provider || model.id.split('/')[0]}`;
      heading.append(name, status); option.append(heading, id, provider);
      const reason = modelReasonText(model.reason);
      if (reason) { const detail = document.createElement('span'); detail.className = 'model-option-reason'; detail.textContent = reason; option.append(detail); }
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => setModelSelection(model));
      list.append(option);
    });
  }
  function setActiveModelOption(index) {
    const matches = state.modelOptionMatches || [];
    if (!matches.length) return;
    state.modelActiveOption = Math.max(0, Math.min(index, matches.length - 1));
    const activeId = `integration-model-option-${state.modelActiveOption}`;
    $('#integration-model-search').setAttribute('aria-activedescendant', activeId);
    $$('.model-option', $('#integration-model-options')).forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === state.modelActiveOption));
  }
  function renderModelValidation(status, message, kind = 'info') {
    const feedback = $('#integration-model-validation');
    feedback.className = `notice ${kind} full`;
    feedback.textContent = `${status ? `${status} · ` : ''}${message}`;
    feedback.dataset.validationStatus = status || 'UNVERIFIED';
  }
  function updateOpenRouterActions() {
    const form = $('#integration-model-form');
    if (!form) return;
    const model = form.elements.model.value;
    const pending = form.dataset.pending === 'true';
    const loaded = Boolean(state.integrations);
    $('#integration-model-verify').disabled = !loaded || !model || pending;
    const validation = state.modelValidation;
    const current = state.integrations?.configuration || {};
    $('#integration-model-form button[type="submit"]').disabled = !loaded || pending || !model
      || validation?.model !== model || validation?.version !== current.version || validation?.status !== 'AVAILABLE'
      || model === current.model || model === current.reviewerModel;
    updateReviewerModelActions();
  }
  function renderReviewerModelOptions() {
    const select = $('#reviewer-model-select');
    if (!select) return;
    const current = state.integrations?.configuration || {};
    const desired = state.reviewerModelDraftDirty ? select.value : current.reviewerModel || '';
    const models = new Map((state.modelCatalog || []).filter((model) => typeof model?.id === 'string')
      .map((model) => [model.id, model]));
    if (current.reviewerModel && !models.has(current.reviewerModel)) {
      models.set(current.reviewerModel, { id: current.reviewerModel, name: current.reviewerModel, status: 'UNVERIFIED' });
    }
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Pilih model Reviewer'; select.append(placeholder);
    for (const model of models.values()) {
      const option = document.createElement('option'); option.value = model.id;
      option.textContent = `${model.name || model.id} · ${model.id}${model.status ? ` · ${model.status}` : ''}`;
      option.disabled = model.id === current.model;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === desired)) select.value = desired;
    updateReviewerModelActions();
  }
  function renderReviewerModelValidation(status, message, kind = 'info') {
    const feedback = $('#reviewer-model-validation');
    feedback.className = `notice ${kind} full`;
    feedback.textContent = `${status ? `${status} · ` : ''}${message}`;
    feedback.dataset.validationStatus = status || 'UNVERIFIED';
  }
  function updateReviewerModelActions() {
    const form = $('#reviewer-model-form');
    if (!form) return;
    const current = state.integrations?.configuration || {};
    const model = form.elements.model.value;
    const pending = form.dataset.pending === 'true';
    const validation = state.reviewerModelValidation;
    $('#reviewer-model-verify').disabled = !state.integrations || pending || !model || model === current.model;
    $('button[type="submit"]', form).disabled = !state.integrations || pending || !model || model === current.model
      || model === current.reviewerModel || validation?.model !== model || validation?.version !== current.version
      || validation?.status !== 'AVAILABLE';
  }
  function setModelSelection(model) {
    const selected = { id: model.id, name: model.name || model.id, provider: model.provider || model.id.split('/')[0], status: model.status || 'UNVERIFIED', reason: model.reason || null };
    state.modelSelection = selected; state.modelDraftDirty = true; state.modelValidation = null;
    $('#integration-model-id').value = selected.id;
    $('#integration-model-search').value = selected.name;
    $('#integration-model-manual').value = '';
    $('#integration-model-selection').textContent = `Dipilih: ${selected.name} · ${selected.id} · Provider / namespace ${selected.provider}.`;
    const reason = modelReasonText(selected.reason);
    renderModelValidation(selected.status, reason || 'Verifikasi ulang melalui backend sebelum model dapat diaktifkan.', selected.status === 'INCOMPATIBLE' ? 'warning' : 'info');
    closeModelOptions(); updateOpenRouterActions();
  }
  function clearModelSelection() {
    state.modelSelection = null; state.modelValidation = null; state.modelDraftDirty = true;
    $('#integration-model-id').value = '';
    $('#integration-model-selection').textContent = 'Belum ada model dipilih. Pilih hasil katalog atau gunakan opsi manual.';
    renderModelValidation('UNVERIFIED', 'Pilih model, lalu verifikasi sebelum menyimpan.');
    updateOpenRouterActions();
  }
  function updateModelVerificationFailure(error) {
    const status = modelValidationStatusFromError(error);
    state.modelValidation = null;
    const message = status === 'NOT_FOUND' ? 'Model tidak ditemukan di OpenRouter. Operasi verifikasi ini tidak mengubah konfigurasi aktif.'
      : status === 'INCOMPATIBLE' ? 'Model tersedia, tetapi tidak mendukung kebutuhan AI Content Generator dan Semantic Auditor.'
        : 'Status model belum dapat diverifikasi. Operasi verifikasi ini tidak mengubah konfigurasi aktif.';
    renderModelValidation(status, message, status === 'UNVERIFIED' ? 'warning' : 'error');
    updateOpenRouterActions();
  }
  async function handleModelSaveFailure(form, error) {
    state.modelValidation = null;
    if (error?.code === 'CONFIG_CONFLICT') {
      try { await loadIntegrations(); } catch { /* Keep the draft and report the version conflict. */ }
      renderModelValidation('UNVERIFIED', 'Konfigurasi berubah. Muat ulang dan verifikasi model kembali sebelum menyimpan.', 'warning');
      showFormError(form, error, '#integration-model-error');
      return;
    }
    const validationCodes = ['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'];
    const providerValidationCodes = ['MODEL_METADATA_UNVERIFIED', 'OPENROUTER_NOT_CONFIGURED', 'OPENROUTER_RATE_LIMITED', 'OPENROUTER_UNAUTHORIZED', 'OPENROUTER_UNAVAILABLE'];
    if ((Number.isInteger(error?.status) && error.status < 500) || providerValidationCodes.includes(error?.code)) {
      updateModelVerificationFailure(error);
      if (validationCodes.includes(error?.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
      return;
    }
    let activeModel;
    try {
      const refreshed = await loadIntegrations();
      if (refreshed) activeModel = state.integrations?.configuration?.model || 'belum ada model aktif';
    } catch { /* A failed read leaves the mutation outcome unknown. */ }
    const message = activeModel
      ? `Respons penyimpanan tidak dapat dipastikan. Server saat ini menunjukkan model aktif ${activeModel}. Periksa riwayat konfigurasi sebelum mencoba lagi.`
      : 'Respons penyimpanan tidak dapat dipastikan dan status model aktif belum dapat dimuat. Muat ulang konfigurasi sebelum mencoba lagi.';
    renderModelValidation('UNVERIFIED', message, 'warning');
    const notice = $('#integration-model-error'); notice.textContent = message; notice.hidden = false;
    notify('warning', message);
    updateOpenRouterActions();
  }
  function showIntegrationOutcome(configuration, successMessage) {
    hide('#global-error'); hide('#global-success');
    const status = String(configuration?.status || '').toUpperCase();
    if (status === 'BLOCKED_RECONCILIATION' || status === 'SWITCHING') {
      show('#global-error', 'Pergantian akun belum selesai. Periksa status post lama dan lanjutkan rekonsiliasi.');
    } else if (status === 'NOT_CONFIGURED') {
      show('#global-error', 'Pengaturan tersimpan, tetapi konfigurasi integrasi belum lengkap. Lengkapi akun dan model sebelum mengaktifkan otomasi.');
    } else if (status === 'ACTIVE') show('#global-success', successMessage);
    else show('#global-error', 'Status konfigurasi belum dapat dipastikan. Muat ulang dan periksa sebelum melanjutkan.');
  }
  async function finishIntegrationMutation(configuration, successMessage, updateDashboard = false) {
    try { if (!await loadIntegrations()) return; }
    catch {
      show('#global-error', 'Permintaan perubahan diterima, tetapi status terkini belum tersedia. Muat ulang konfigurasi sebelum melanjutkan.');
      return;
    }
    const dashboardError = updateDashboard && await refresh().catch(() => true);
    showIntegrationOutcome(state.integrations?.configuration || configuration, successMessage);
    if (dashboardError) {
      const error = $('#global-error');
      show('#global-error', `${error.hidden ? '' : error.textContent + ' '}Ringkasan dashboard belum dapat diperbarui.`);
    }
  }
  function renderIntegrationHistory(history = [], component = 'account') {
    const container = $(`#integration-${component}-history`);
    container.replaceChildren();
    const relevant = history.filter((item) => {
      const action = String(item.action || '');
      return action === 'bootstrap' || action.startsWith(`${component}_`) || (component === 'account' && action.startsWith('switch_'));
    });
    if (!relevant.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada riwayat konfigurasi.'; container.append(empty); return;
    }
    relevant.forEach((item) => {
      const row = document.createElement('article'); row.className = 'integration-history-item';
      const title = document.createElement('strong'); title.textContent = `Versi ${item.version ?? '—'} · ${item.action || 'Perubahan'}`;
      const details = document.createElement('p');
      const date = item.createdAt ? new Date(item.createdAt) : null;
      const dateText = date && Number.isFinite(date.getTime()) ? date.toLocaleString('id-ID') : 'Waktu tidak tersedia';
      const actor = item.actorEmail || item.actorId || 'sistem';
      details.textContent = component === 'account'
        ? `${dateText} · Admin ${actor} · ${item.status || '—'} · Profile ${item.profileId || '—'} · Akun ${item.accountId || '—'}`
        : component === 'reviewer_model'
          ? `${dateText} · Admin ${actor} · ${item.status || '—'} · Model Reviewer ${item.reviewerModel || '—'}`
          : `${dateText} · Admin ${actor} · ${item.status || '—'} · Model Generator ${item.model || '—'}`;
      const actions = document.createElement('div'); actions.className = 'form-actions';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet';
      button.textContent = component === 'account' ? 'Pulihkan akun' : component === 'reviewer_model' ? 'Pulihkan Reviewer' : 'Pulihkan Generator';
      const restorable = ['ACTIVE', 'NOT_CONFIGURED'].includes(item.status);
      const currentConfig = state.integrations?.configuration || {};
      const modelToRestore = component === 'reviewer_model' ? item.reviewerModel : item.model;
      button.disabled = !restorable || (component === 'account' ? !item.profileId || !item.accountId
        : !modelToRestore || modelToRestore === (component === 'reviewer_model' ? currentConfig.model : currentConfig.reviewerModel));
      if (!restorable) button.title = 'Versi yang masih menunggu rekonsiliasi tidak dapat dipulihkan.';
      button.addEventListener('click', async () => {
          hide('#global-error'); hide('#global-success');
          try {
            await withPending(button, async () => {
              const expectedVersion = integrationVersion();
              const current = state.integrations?.configuration || {};
              let summary;
              if (component === 'account') {
                const checked = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify({ profileId: item.profileId, accountId: item.accountId }) });
                const accountName = checked.account?.username ? `@${checked.account.username} (${item.accountId})` : item.accountId;
                summary = `Pulihkan akun ke ${accountName}? Model tetap ${current.model || 'belum dikonfigurasi'}. Otomasi akan dijeda dan post lama diperiksa.`;
              } else if (component === 'reviewer_model') {
                await api('/api/integrations/validate-reviewer-model', { method: 'POST', body: JSON.stringify({ model: item.reviewerModel }) });
                summary = `Pulihkan model Reviewer ke ${item.reviewerModel}? Model Generator tetap ${current.model || 'belum dikonfigurasi'}.`;
              } else {
                await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model: item.model }) });
                summary = `Pulihkan model Generator ke ${item.model}? Model Reviewer tetap ${current.reviewerModel || 'belum dikonfigurasi'}.`;
              }
              if (!confirmAction(`${summary} Versi referensi: ${item.version}.`)) return;
              const result = await api('/api/integrations/rollback', { method: 'POST', body: JSON.stringify({ version: item.version, expectedVersion, confirmed: true, component }) });
              await finishIntegrationMutation(result.configuration, component === 'account' ? 'Akun berhasil dipulihkan. Aktifkan otomasi kembali secara manual.' : component === 'reviewer_model' ? 'Model Reviewer berhasil dipulihkan.' : 'Model Generator berhasil dipulihkan.', true);
            }, 'Memeriksa…');
          } catch (error) { show('#global-error', integrationError(error)); }
      });
      actions.append(button);
      row.append(title, details, actions); container.append(row);
    });
  }
  function syncIntegrationControls() {
    const accountForm = $('#integration-account-form');
    $('button[type="submit"]', accountForm).disabled = !state.integrations || accountForm.dataset.pending === 'true';
    updateOpenRouterActions();
    updateReviewerModelActions();
  }
  async function loadIntegrations({ verification = null } = {}) {
    const request = state.integrationLoad = (state.integrationLoad || 0) + 1;
    const publications = loadPublicationResolution(request, state.closedSlotSearchId || '');
    state.integrations = null;
    state.integrationVerification = null;
    syncIntegrationControls();
    renderProviderHolds();
    hide('#integration-account-preview');
    for (const selector of ['#integration-active-profile', '#integration-active-account', '#integration-provider-status', '#integration-switch-status', '#ai-active-model', '#ai-active-reviewer-model']) $(selector).textContent = 'Tidak tersedia';
    $('#integration-check-active').disabled = true;
    $('#integration-reconcile').hidden = true;
    $('#integration-notice').textContent = 'Memuat konfigurasi terkini. Isian perubahan tetap disimpan.';
    $('#ai-notice').textContent = 'Memuat model aktif dari konfigurasi server.';
    renderIntegrationHistory([], 'account');
    renderIntegrationHistory([], 'model');
    renderIntegrationHistory([], 'reviewer_model');
    let result;
    try {
      result = await api('/api/integrations');
    } catch (error) {
      if (request !== state.integrationLoad) return false;
      $('#integration-notice').textContent = 'Konfigurasi tidak tersedia. Muat ulang sebelum menyimpan perubahan.';
      $('#ai-notice').textContent = 'Model aktif belum dapat dimuat. Coba muat ulang sebelum menyimpan perubahan.';
      throw error;
    }
    if (request !== state.integrationLoad) return false;
    const configuration = result.configuration || {};
    state.integrations = result;
    renderProviderHolds(result.providerHolds, configuration);
    if (state.modelValidation && state.modelValidation.version !== configuration.version) {
      state.modelValidation = null;
      renderModelValidation('UNVERIFIED', 'Konfigurasi berubah. Verifikasi model kembali sebelum menyimpan.');
    }
    if (state.reviewerModelValidation && state.reviewerModelValidation.version !== configuration.version) {
      state.reviewerModelValidation = null;
      renderReviewerModelValidation('UNVERIFIED', 'Konfigurasi berubah. Verifikasi model Reviewer kembali sebelum menyimpan.');
    }
    syncIntegrationControls();
    state.integrationVerification = verification;
    $('#integration-active-profile').textContent = configuration.profileId || 'Belum dikonfigurasi';
    const verifiedAccount = verification?.profileId === configuration.profileId && verification?.accountId === configuration.accountId ? verification.account : null;
    $('#integration-active-account').textContent = `${configuration.accountId || 'Belum dikonfigurasi'}${verifiedAccount?.username ? ` · @${verifiedAccount.username}` : ''}`;
    $('#integration-provider-status').textContent = verifiedAccount ? `Terverifikasi · ${verifiedAccount.platform || 'Threads'} · ${verifiedAccount.status || 'status tidak diketahui'}` : 'Belum diverifikasi pada halaman ini';
    $('#integration-check-active').disabled = !configuration.profileId || !configuration.accountId;
    $('#ai-active-model').textContent = configuration.model || 'Belum dikonfigurasi';
    $('#ai-notice').textContent = configuration.model ? 'Model aktif dibaca dari konfigurasi server.' : 'Belum ada model yang dikonfigurasi.';
    $('#ai-active-model-status').textContent = configuration.model
      ? 'Tersimpan aktif di MySQL. Ketersediaan provider tidak diuji saat halaman dimuat.'
      : 'Belum ada model aktif.';
    $('#ai-active-reviewer-model').textContent = configuration.reviewerModel || 'Belum dikonfigurasi';
    $('#ai-active-reviewer-model-status').textContent = configuration.reviewerModel
      ? 'Tersimpan aktif di MySQL. Ketersediaan provider tidak diuji saat halaman dimuat.'
      : 'Reviewer wajib diisi sebelum otomasi dapat berjalan.';
    const modelsReady = configuration.modelsReady === true && configuration.model !== configuration.reviewerModel;
    $('#ai-dual-model-status').className = `notice ${modelsReady ? 'success' : 'warning'}`;
    $('#ai-dual-model-status').textContent = modelsReady
      ? 'Generator dan Reviewer menggunakan model OpenRouter yang berbeda.'
      : 'Dual AI belum siap. Pilih dan verifikasi model Reviewer yang berbeda dari Generator.';
    const status = String(configuration.status || 'NOT_CONFIGURED').toUpperCase();
    const labels = { ACTIVE: 'Aktif', PAUSED: 'Dijeda', SWITCHING: 'Pergantian berlangsung', BLOCKED_RECONCILIATION: 'Tertahan: post lama perlu diperiksa', NOT_CONFIGURED: 'Belum dikonfigurasi' };
    $('#integration-switch-status').textContent = labels[status] || status;
    const pending = configuration.pendingProfileId || configuration.pendingAccountId;
    $('#integration-notice').textContent = pending ? `Pergantian menunggu pemeriksaan: profile ${configuration.pendingProfileId || '—'}, akun ${configuration.pendingAccountId || '—'}. Otomasi tetap dijeda.` : 'Perubahan akun dapat menjeda otomasi. Periksa status sebelum mengaktifkannya kembali.';
    $('#integration-reconcile').hidden = !['SWITCHING', 'BLOCKED_RECONCILIATION'].includes(status);
    const accountForm = $('#integration-account-form');
    const oldAccount = accountForm.dataset.baseline && JSON.parse(accountForm.dataset.baseline);
    if ((!oldAccount && !accountForm.elements.profileId.value && !accountForm.elements.accountId.value) || (oldAccount && accountForm.elements.profileId.value === oldAccount.profileId && accountForm.elements.accountId.value === oldAccount.accountId)) {
      accountForm.elements.profileId.value = configuration.profileId || '';
      accountForm.elements.accountId.value = configuration.accountId || '';
    }
    accountForm.dataset.baseline = JSON.stringify({ profileId: configuration.profileId || '', accountId: configuration.accountId || '' });
    const modelForm = $('#integration-model-form');
    const activeModel = configuration.model || '';
    if (!state.modelDraftDirty) {
      state.modelValidation = null;
      state.modelSelection = activeModel ? { id: activeModel, name: activeModel, provider: activeModel.split('/')[0], status: 'UNVERIFIED', reason: null } : null;
      modelForm.elements.model.value = activeModel;
      $('#integration-model-search').value = activeModel;
      $('#integration-model-selection').textContent = activeModel
        ? `Model aktif ${activeModel} dipilih sebagai draft. Verifikasi kembali sebelum mengaktifkannya.`
        : 'Pilih model dari katalog, lalu verifikasi sebelum menyimpan.';
      renderModelValidation('UNVERIFIED', activeModel ? 'Verifikasi ulang model aktif jika ingin menyimpannya sebagai perubahan.' : 'Pilih model, lalu verifikasi sebelum menyimpan.');
    }
    modelForm.dataset.baseline = activeModel;
    const reviewerForm = $('#reviewer-model-form');
    renderReviewerModelOptions();
    if (!state.reviewerModelDraftDirty) {
      state.reviewerModelValidation = null;
      reviewerForm.elements.model.value = configuration.reviewerModel || '';
      renderReviewerModelValidation('UNVERIFIED', configuration.reviewerModel
        ? 'Model Reviewer tersimpan aktif di MySQL; verifikasi model baru sebelum menyimpan.'
        : 'Pilih model Reviewer, verifikasi, lalu simpan sebelum mengaktifkan otomasi.');
    }
    reviewerForm.dataset.baseline = configuration.reviewerModel || '';
    updateOpenRouterActions();
    const history = Array.isArray(result.history) ? result.history : [];
    renderIntegrationHistory(history, 'account');
    renderIntegrationHistory(history, 'model');
    renderIntegrationHistory(history, 'reviewer_model');
    await publications;
    return request === state.integrationLoad;
  }

  $('#integration-account-form').addEventListener('input', () => hide('#integration-account-preview'));
  $('#integration-account-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; hide('#global-error'); hide('#global-success'); hide('#integration-account-error'); hide('#integration-account-preview'); clearFormErrors(form);
    const payload = { profileId: value(form, 'profileId').trim(), accountId: value(form, 'accountId').trim() };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const version = integrationVersion();
        const checked = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify(payload) });
        const account = checked.account || {};
        const identity = account.username ? `@${account.username}` : account.id || payload.accountId;
        show('#integration-account-preview', `Akun terverifikasi: ${identity} · Profile ${account.profileId || payload.profileId} · Platform ${account.platform || 'Threads'} · Status ${account.status || 'tidak diketahui'}.`);
        if (!confirmAction(`Ganti tujuan posting ke ${identity} (Account ID ${payload.accountId}) di profile ${payload.profileId}? Otomasi akan dijeda dan post lama diperiksa.`)) return;
        const result = await api('/api/integrations/account', { method: 'PUT', body: JSON.stringify({ ...payload, expectedVersion: version, confirmed: true }) });
        if (result.configuration?.status === 'ACTIVE') form.dataset.baseline = JSON.stringify(payload);
        await finishIntegrationMutation(result.configuration, 'Akun berhasil diganti. Otomasi tetap nonaktif sampai diaktifkan kembali.', true);
      }, 'Memeriksa…', form);
    } catch (error) {
      if (['INVALID_ACCOUNT', 'ACCOUNT_NOT_AVAILABLE'].includes(error.code)) error.fields = { profileId: error.code, accountId: error.code };
      showFormError(form, error, '#integration-account-error');
    }
  });
  $('#integration-model-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; hide('#global-error'); hide('#global-success'); hide('#integration-model-error'); clearFormErrors(form);
    const model = form.elements.model.value.trim();
    const currentVersion = state.integrations?.configuration?.version;
    if (!model || state.modelValidation?.model !== model || state.modelValidation?.version !== currentVersion) {
      renderModelValidation('UNVERIFIED', 'Verifikasi model kembali sebelum menyimpan perubahan.', 'warning');
      updateOpenRouterActions(); return;
    }
    let activationAttempted = false;
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const expectedVersion = integrationVersion();
        const checked = await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model }) });
        const identity = checked.model?.name || checked.model?.id || model;
        state.modelValidation = { model, version: expectedVersion, status: 'AVAILABLE' };
        renderModelValidation('AVAILABLE', 'Model kembali ditemukan dan kompatibel berdasarkan metadata. Keberhasilan generasi berikutnya tetap bergantung pada provider.', 'success');
        if (!confirmAction(`Gunakan model ${identity} (${model}) untuk generasi berikutnya?`)) return;
        activationAttempted = true;
        const result = await api('/api/integrations/model', { method: 'PUT', body: JSON.stringify({ model, expectedVersion }) });
        form.dataset.baseline = model; state.modelDraftDirty = false; state.modelValidation = null;
        await finishIntegrationMutation(result.configuration, 'Model AI berhasil diperbarui untuk generasi berikutnya.', true);
      }, 'Memeriksa…', form);
    } catch (error) {
      if (activationAttempted) { await handleModelSaveFailure(form, error); return; }
      updateModelVerificationFailure(error);
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'].includes(error.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
    }
  });
  $('#integration-model-verify').addEventListener('click', async (event) => {
    const form = $('#integration-model-form'); const model = form.elements.model.value.trim();
    if (!model) { renderModelValidation('UNVERIFIED', 'Pilih model dari katalog atau masukkan ID manual terlebih dahulu.', 'warning'); return; }
    hide('#integration-model-error');
    try {
      await withPending(event.currentTarget, async () => {
        const version = integrationVersion();
        renderModelValidation('UNVERIFIED', 'Memeriksa metadata model melalui backend…');
        const result = await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model }) });
        state.modelSelection = { id: result.model?.id || model, name: result.model?.name || model, provider: result.model?.provider || model.split('/')[0], status: 'AVAILABLE', reason: null };
        state.modelValidation = { model, version, status: 'AVAILABLE' };
        renderModelValidation('AVAILABLE', 'Model tersedia dan kompatibel berdasarkan metadata OpenRouter. Ini bukan jaminan setiap request generasi akan berhasil.', 'success');
        notify('success', 'Metadata model tersedia dan kompatibel. Ketersediaan request generasi berikutnya tetap bergantung pada provider.');
      }, 'Memverifikasi…', form);
    } catch (error) {
      updateModelVerificationFailure(error);
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'].includes(error.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
    }
  });
  $('#reviewer-model-select').addEventListener('change', (event) => {
    state.reviewerModelDraftDirty = true;
    state.reviewerModelValidation = null;
    const model = event.currentTarget.value;
    renderReviewerModelValidation('UNVERIFIED', model
      ? 'Verifikasi model Reviewer ini sebelum menyimpan. Model harus berbeda dari Generator.'
      : 'Pilih model Reviewer sebelum verifikasi.');
    updateReviewerModelActions();
  });
  $('#reviewer-model-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    hide('#global-error'); hide('#global-success'); hide('#reviewer-model-error'); clearFormErrors(form);
    const model = form.elements.model.value.trim();
    const current = state.integrations?.configuration || {};
    const expectedVersion = current.version;
    if (!model || model === current.model || state.reviewerModelValidation?.model !== model
      || state.reviewerModelValidation?.version !== expectedVersion || state.reviewerModelValidation?.status !== 'AVAILABLE') {
      renderReviewerModelValidation('UNVERIFIED', 'Pilih model yang berbeda dari Generator dan verifikasi ulang sebelum menyimpan.', 'warning');
      updateReviewerModelActions(); return;
    }
    let activationAttempted = false;
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const checked = await api('/api/integrations/validate-reviewer-model', { method: 'POST', body: JSON.stringify({ model }) });
        const identity = checked.model?.name || checked.model?.id || model;
        if (!confirmAction(`Gunakan ${identity} (${model}) sebagai Reviewer? Reviewer hanya dipanggil ketika validasi konten menemukan kegagalan yang dapat diperbaiki.`)) return;
        activationAttempted = true;
        const result = await api('/api/integrations/reviewer-model', { method: 'PUT', body: JSON.stringify({ model, expectedVersion }) });
        state.reviewerModelDraftDirty = false; state.reviewerModelValidation = null;
        await finishIntegrationMutation(result.configuration, 'Model Reviewer berhasil diperbarui.');
      }, 'Memeriksa…', form);
    } catch (error) {
      if (activationAttempted) {
        await loadIntegrations().catch(() => {});
      }
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE', 'MODEL_IDS_MUST_DIFFER'].includes(error.code)) {
        renderReviewerModelValidation(modelValidationStatusFromError(error), errorText(error), 'warning');
      }
      showFormError(form, error, '#reviewer-model-error');
    }
  });
  $('#reviewer-model-verify').addEventListener('click', async (event) => {
    const form = $('#reviewer-model-form'); const model = form.elements.model.value.trim();
    const current = state.integrations?.configuration || {};
    if (!model) { renderReviewerModelValidation('UNVERIFIED', 'Pilih model Reviewer dari katalog terlebih dahulu.', 'warning'); return; }
    if (model === current.model) {
      renderReviewerModelValidation('INCOMPATIBLE', 'Model Reviewer harus berbeda dari model Generator.', 'warning');
      return;
    }
    hide('#reviewer-model-error');
    try {
      await withPending(event.currentTarget, async () => {
        const version = integrationVersion();
        renderReviewerModelValidation('UNVERIFIED', 'Memeriksa metadata model melalui backend…');
        const result = await api('/api/integrations/validate-reviewer-model', { method: 'POST', body: JSON.stringify({ model }) });
        state.reviewerModelValidation = { model, version, status: 'AVAILABLE' };
        renderReviewerModelValidation('AVAILABLE', `Model ${result.model?.name || model} kompatibel berdasarkan metadata OpenRouter.`, 'success');
        notify('success', 'Model Reviewer tersedia dan berbeda dari Generator. Ini belum menguji request generasi.');
      }, 'Memverifikasi…', form);
    } catch (error) {
      state.reviewerModelValidation = null;
      renderReviewerModelValidation(modelValidationStatusFromError(error), errorText(error), 'warning');
      showFormError(form, error, '#reviewer-model-error');
    }
  });
  $('#integration-model-catalog').addEventListener('click', async (event) => {
    try {
      await withPending(event.currentTarget, async () => {
        const request = state.modelCatalogRequest = (state.modelCatalogRequest || 0) + 1;
        state.modelCatalog = null;
        $('#integration-model-catalog-status').textContent = 'Memuat katalog model dari OpenRouter…';
        $('#integration-model-empty').hidden = true;
        const result = await api('/api/integrations/models');
        if (request !== state.modelCatalogRequest) return;
        state.modelCatalog = Array.isArray(result.models) ? result.models.filter((model) => typeof model?.id === 'string') : [];
        const available = state.modelCatalog.filter((model) => model.status === 'AVAILABLE').length;
        $('#integration-model-catalog-status').textContent = state.modelCatalog.length
          ? `Katalog dimuat: ${state.modelCatalog.length} model. ${available} kompatibel berdasarkan metadata; status bukan jaminan request generasi.`
          : 'Katalog OpenRouter tidak berisi model. Coba muat ulang nanti.';
        renderModelOptions($('#integration-model-search').value);
        renderReviewerModelOptions();
      }, 'Memuat…', null);
    } catch (error) {
      state.modelCatalog = null; closeModelOptions();
      $('#integration-model-catalog-status').textContent = 'UNVERIFIED · katalog tidak dapat dimuat. Coba muat ulang; model manual tetap harus diverifikasi.';
      show('#integration-model-error', integrationError(error));
    }
  });
  $('#integration-model-search').addEventListener('focus', (event) => {
    if (!state.modelCatalog) return;
    const selected = state.modelSelection?.name === event.currentTarget.value;
    renderModelOptions(selected ? '' : event.currentTarget.value);
  });
  $('#integration-model-search').addEventListener('input', (event) => {
    clearModelSelection(); renderModelOptions(event.currentTarget.value);
  });
  $('#integration-model-search').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const wasHidden = $('#integration-model-options').hidden;
      if (wasHidden) renderModelOptions(event.currentTarget.value);
      if (state.modelOptionMatches.length) setActiveModelOption(state.modelActiveOption < 0 ? 0 : state.modelActiveOption + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const wasHidden = $('#integration-model-options').hidden;
      if (wasHidden) renderModelOptions(event.currentTarget.value);
      if (state.modelOptionMatches.length) setActiveModelOption(state.modelActiveOption < 0 ? state.modelOptionMatches.length - 1 : state.modelActiveOption - 1);
    } else if (event.key === 'Enter' && !$('#integration-model-options').hidden && state.modelActiveOption >= 0) {
      event.preventDefault(); setModelSelection(state.modelOptionMatches[state.modelActiveOption]);
    } else if (event.key === 'Escape') closeModelOptions();
    else if (event.key === 'Tab') closeModelOptions();
  });
  $('#integration-model-use-manual').addEventListener('click', () => {
    const model = $('#integration-model-manual').value.trim();
    hide('#integration-model-error');
    if (!model) { renderModelValidation('UNVERIFIED', 'Masukkan Model ID tanpa perubahan otomatis, lalu pilih Gunakan ID.', 'warning'); $('#integration-model-manual').focus(); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,98}$/.test(model)) {
      const error = Object.assign(new Error('INVALID_MODEL'), { code: 'INVALID_MODEL' });
      renderModelValidation('INCOMPATIBLE', 'Format Model ID tidak valid. Gunakan namespace/model-id yang persis dari OpenRouter.', 'error');
      error.fields = { modelSearch: 'INVALID_MODEL' };
      showFormError($('#integration-model-form'), error, '#integration-model-error'); return;
    }
    setModelSelection({ id: model, name: model, provider: model.split('/')[0], status: 'UNVERIFIED', reason: 'MANUAL_ID' });
  });
  $('#integration-refresh').addEventListener('click', (event) => withPending(event.currentTarget, () => loadIntegrations(), 'Memuat…').catch((error) => show('#global-error', integrationError(error))));
  $('#ai-refresh').addEventListener('click', (event) => withPending(event.currentTarget, () => loadIntegrations(), 'Memuat…').catch((error) => show('#global-error', integrationError(error))));
  $('#integration-check-active').addEventListener('click', async (event) => {
    const checkLoad = state.integrationLoad;
    try {
      await withPending(event.currentTarget, async () => {
        const { profileId, accountId } = state.integrations?.configuration || {};
        if (!profileId || !accountId) { const error = new Error('CONFIG_NOT_LOADED'); error.code = 'CONFIG_NOT_LOADED'; throw error; }
        state.integrationVerification = null;
        $('#integration-active-account').textContent = accountId;
        $('#integration-provider-status').textContent = 'Memeriksa akun…';
        const result = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify({ profileId, accountId }) });
        if (checkLoad !== state.integrationLoad) return;
        await loadIntegrations({ verification: { profileId, accountId, account: result.account || {} } });
      }, 'Memeriksa…');
    } catch (error) { if (checkLoad !== state.integrationLoad) return; state.integrationVerification = null; $('#integration-provider-status').textContent = 'Pemeriksaan gagal'; show('#global-error', integrationError(error)); }
  });
  $('#integration-reconcile').addEventListener('click', async (event) => {
    hide('#global-error'); hide('#global-success');
    try {
      await withPending(event.currentTarget, async () => {
        const result = await api('/api/integrations/reconcile', { method: 'POST', body: JSON.stringify({ expectedVersion: integrationVersion() }) });
        await finishIntegrationMutation(result.configuration, 'Pergantian akun selesai. Otomasi tetap nonaktif sampai diaktifkan kembali.', true);
      }, 'Memeriksa…');
    } catch (error) { show('#global-error', integrationError(error)); }
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearFormErrors(form); hide('#login-error');
    const button = event.submitter || $('button[type="submit"]', form);
    const loginPayload = { email: value(form, 'email'), password: value(form, 'password') };
    try {
      await withPending(button, async () => {
        const result = await api('/api/session/login', { method: 'POST', body: JSON.stringify(loginPayload) });
        state.csrf = result.csrfToken || '';
        setAuthenticated(true);
        try { await refresh(); }
        catch (error) { show('#global-error', errorText(error)); }
      }, 'Memeriksa…', form);
    } catch (error) { showFormError(form, error, '#login-error'); }
  });

  $('#logout-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    await withPending(button, async () => {
      let logoutError = null;
      try { await api('/api/session/logout', { method: 'POST', body: '{}' }); }
      catch (error) { logoutError = error; }
      finally {
        state.publicationResolution = null;
        $('#publication-resolution-dialog').close();
        $('#publication-resolution-form').reset();
        hide('#publication-resolution-result');
        renderPublicationResolution();
        $('#publication-blocker-count').textContent = 'Muat konfigurasi untuk melihat slot yang perlu diperiksa.';
        renderProviderHolds();
        state.csrf = ''; state.integrations = null; state.integrationVerification = null; state.reviewerModelValidation = null; state.reviewerModelDraftDirty = false; state.integrationLoad = (state.integrationLoad || 0) + 1; state.dashboardLoad += 1; state.data = null; state.onboardingComplete = null; state.onboardingExpanded = false; syncIntegrationControls(); $('#integration-check-active').disabled = true; $('#integration-reconcile').hidden = true; for (const selector of ['#integration-active-profile', '#integration-active-account', '#integration-provider-status', '#integration-switch-status', '#ai-active-model', '#ai-active-reviewer-model']) $(selector).textContent = 'Tidak tersedia'; renderIntegrationHistory([], 'account'); renderIntegrationHistory([], 'model'); renderIntegrationHistory([], 'reviewer_model'); hide('#integration-account-preview'); $('#integration-account-form').reset(); $('#integration-model-form').reset(); $('#reviewer-model-form').reset(); delete $('#integration-account-form').dataset.baseline; delete $('#integration-model-form').dataset.baseline; delete $('#reviewer-model-form').dataset.baseline; setAuthenticated(false);
      }
      if (logoutError) show('#login-error', 'Sesi dashboard ditutup. Server belum mengonfirmasi proses keluar; masuk kembali untuk memperbarui sesi. ' + errorText(logoutError));
    }, 'Keluar…');
  });

  $('#admin-create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    clearFormErrors(form);
    const adminPayload = { email: value(form, 'email'), password: value(form, 'password') };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        await api('/api/admins', { method: 'POST', body: JSON.stringify(adminPayload) });
        form.reset(); show('#global-success', 'Akun admin berhasil ditambahkan.'); await refreshAfterMutation(loadAdmins);
      }, 'Menambahkan…', form);
    } catch (error) { showFormError(form, error); }
  });
  $('#admin-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-admin-id]'); if (!form) return;
    event.preventDefault();
    const changes = {}; const email = value(form, 'email'); if (email !== form.dataset.originalEmail) changes.email = email; const password = value(form, 'password'); if (password) changes.password = password;
    if (!Object.keys(changes).length) { show('#global-success', 'Tidak ada perubahan untuk disimpan.'); return; }
    clearFormErrors(form);
    const button = event.submitter || $('button[type="submit"]', form);
    try {
      await withPending(button, async () => {
        const result = await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify(changes) });
        if (result.sessionRevoked) { state.csrf = ''; setAuthenticated(false); show('#login-error', 'Akun diperbarui. Masuk kembali dengan email atau kata sandi baru.'); return; }
        show('#global-success', 'Perubahan akun admin berhasil disimpan.'); await refreshAfterMutation(loadAdmins);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });
  $('#admin-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-active]'); if (!button) return;
    const form = button.closest('form[data-admin-id]'); const active = button.dataset.active !== 'true';
    if (!active && !confirmAction('Nonaktifkan akun ini? Semua sesi login akun akan dihentikan.')) return;
    await withPending(button, async () => {
      try { await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify({ active }) }); show('#global-success', active ? 'Akun admin diaktifkan kembali.' : 'Akun admin dinonaktifkan.'); await refreshAfterMutation(loadAdmins); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Memproses…', form);
  });
  $('#admins-refresh-button').addEventListener('click', () => loadAdmins().catch((error) => show('#global-error', errorText(error))));

  $('#content-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; clearFormErrors(form);
    const knowledge = {
      companyName: value(form, 'companyName'), positioning: value(form, 'positioning'), description: value(form, 'description'),
      vision: value(form, 'vision'), mission: value(form, 'mission'), primaryAudience: value(form, 'primaryAudience'),
      secondaryAudience: value(form, 'secondaryAudience'), ticketing: value(form, 'ticketing'),
      services: lines(value(form, 'services')), contentGuidance: value(form, 'contentGuidance'),
      approvedClaims: lines(value(form, 'approvedClaims')), forbiddenClaims: lines(value(form, 'forbiddenClaims')),
      ctaUrl: value(form, 'ctaUrl').trim(),
    };
    const settings = { schedule: state.data.settings?.schedule || {}, hashtags: lines(value(form, 'hashtags')) };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        await api('/api/knowledge', { method: 'PUT', body: JSON.stringify(knowledge) });
        await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
        show('#global-success', 'Pengetahuan bisnis NDI disimpan dan disetujui untuk digunakan generator konten.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });

  $('#website-sync-button').addEventListener('click', async (event) => {
    await withPending(event.currentTarget, async () => {
      try {
        const result = await api('/api/website-sync', { method: 'POST', body: '{}' });
        notify('success', `${Number(result.proposalCount) || 0} usulan perubahan website siap ditinjau.`);
        await loadWebsiteSync();
      } catch (error) { show('#global-error', errorText(error)); }
    }, 'Memeriksa website…');
  });
  $('#website-sync-proposals').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-website-proposal-id]'); if (!button) return;
    const decision = button.dataset.decision;
    if (decision === 'approve' && !confirmAction('Setujui hanya perubahan layanan ini ke pengetahuan bisnis aktif?')) return;
    await withPending(button, async () => {
      try {
        const result = await api(`/api/website-sync/proposals/${encodeURIComponent(button.dataset.websiteProposalId)}/${decision}`, { method: 'POST', body: '{}' });
        if (result.status === 'conflict') show('#global-error', 'Usulan berubah menjadi konflik karena pengetahuan terbaru berbeda. Periksa kembali fakta sebelum menyinkronkan ulang.');
        else notify('success', decision === 'approve' ? 'Perubahan layanan ini disetujui.' : 'Perubahan layanan ini ditolak.');
        await loadWebsiteSync(); await refreshAfterMutation(refresh);
      } catch (error) { show('#global-error', errorText(error)); await loadWebsiteSync().catch(() => {}); }
    }, 'Menyimpan keputusan…');
  });

  async function saveStrategyForm(form, kind, id = null) {
    const fields = kind === 'category' ? ['name', 'guidance'] : ['name', 'instructions'];
    const body = Object.fromEntries(fields.map((name) => [name, value(form, name).trim()]));
    if (id !== null) body.active = Boolean(form.elements.namedItem('active')?.checked);
    const path = kind === 'category' ? 'categories' : 'styles';
    await api(`/api/content-strategy/${path}${id === null ? '' : `/${encodeURIComponent(id)}`}`, {
      method: id === null ? 'POST' : 'PUT', body: JSON.stringify(body),
    });
  }
  for (const [selector, kind] of [['#category-create-form', 'category'], ['#style-create-form', 'style']]) {
    $(selector).addEventListener('submit', async (event) => {
      event.preventDefault(); const form = event.currentTarget;
      await withPending(event.submitter, async () => {
        try { await saveStrategyForm(form, kind); form.reset(); show('#global-success', kind === 'category' ? 'Kategori konten ditambahkan.' : 'Gaya bahasa ditambahkan.'); await refreshAfterMutation(refresh); }
        catch (error) { show('#global-error', errorText(error)); }
      }, 'Menyimpan…', form);
    });
  }
  for (const [selector, kind] of [['#strategy-categories', 'category'], ['#strategy-styles', 'style']]) {
    const container = $(selector);
    container.addEventListener('submit', async (event) => {
      const form = event.target.closest('form.strategy-record'); if (!form) return;
      event.preventDefault();
      await withPending(event.submitter, async () => {
        try { await saveStrategyForm(form, kind, form.dataset.id); show('#global-success', kind === 'category' ? 'Kategori diperbarui.' : 'Gaya diperbarui.'); await refreshAfterMutation(refresh); }
        catch (error) { show('#global-error', errorText(error)); }
      }, 'Menyimpan…', form);
    });
    container.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action="archive"]'); if (!button) return;
      const form = button.closest('form.strategy-record');
      if (!confirmAction(`Arsipkan ${kind === 'category' ? 'kategori' : 'gaya'} ini? Histori dan slot yang sudah terikat tetap dipertahankan.`)) return;
      await withPending(button, async () => {
        try { await api(`/api/content-strategy/${kind === 'category' ? 'categories' : 'styles'}/${encodeURIComponent(form.dataset.id)}/archive`, { method: 'POST', body: '{}' }); show('#global-success', 'Item strategi diarsipkan.'); await refreshAfterMutation(refresh); }
        catch (error) { show('#global-error', errorText(error)); }
      }, 'Mengarsipkan…', form);
    });
  }
  $('#strategy-enable').addEventListener('click', async (event) => {
    if (!confirmAction('Aktifkan strategi konten setelah memeriksa kategori dan gaya? Otomasi harus dijeda. Tindakan ini tidak mengaktifkan scheduler atau menerbitkan konten.')) return;
    await withPending(event.currentTarget, async () => {
      try { await api('/api/content-strategy/enable', { method: 'POST', body: '{}' }); show('#global-success', 'Strategi konten diaktifkan. Otomasi tetap memerlukan aktivasi terpisah.'); await refreshAfterMutation(refresh); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Mengaktifkan…');
  });
  $('#strategy-disable').addEventListener('click', async (event) => {
    if (!confirmAction('Nonaktifkan strategi konten? Otomasi harus dijeda terlebih dahulu.')) return;
    await withPending(event.currentTarget, async () => {
      try { await api('/api/content-strategy/disable', { method: 'POST', body: '{}' }); show('#global-success', 'Strategi konten dinonaktifkan.'); await refreshAfterMutation(refresh); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Menonaktifkan…');
  });
  $('#proposal-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const enabled = form.elements.namedItem('enabled').checked;
    if (enabled && !confirmAction('Aktifkan job terpisah yang menggunakan maksimal satu panggilan OpenRouter hingga 400 token per interval? Usulan tetap menunggu persetujuan admin dan tidak menerbitkan konten.')) return;
    const intervalDays = Number(form.elements.namedItem('intervalDays').value);
    await withPending(event.submitter, async () => {
      try { await api('/api/content-strategy/proposals/config', { method: 'PUT', body: JSON.stringify({ enabled, intervalDays }) }); show('#global-success', enabled ? 'Job usulan kategori dijadwalkan setelah interval.' : 'Job usulan kategori dinonaktifkan.'); await refreshAfterMutation(refresh); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Menyimpan…', form);
  });
  $('#category-proposals').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action^="proposal-"]'); if (!button) return;
    const decision = button.dataset.action.slice('proposal-'.length);
    if (decision === 'approve' && !confirmAction('Setujui usulan ini sebagai kategori aktif? Perubahan ini tidak mengubah pengetahuan bisnis.')) return;
    await withPending(button, async () => {
      try { await api(`/api/content-strategy/proposals/${encodeURIComponent(button.dataset.id)}/${decision}`, { method: 'POST', body: '{}' }); show('#global-success', decision === 'approve' ? 'Usulan disetujui dan dibuat sebagai kategori.' : 'Usulan ditolak.'); await refreshAfterMutation(refresh); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Memproses…');
  });

  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; clearFormErrors(form); const settings = state.data.settings || {};
    const rawHours = value(form, 'hours').trim(); const rawMinutes = value(form, 'minutes').trim();
    const currentSchedule = { ...(settings.schedule || {}) };
    delete currentSchedule.intervalMinutes; delete currentSchedule.intervalHours; delete currentSchedule.hours; delete currentSchedule.minutes;
    settings.schedule = { ...currentSchedule, hours: rawHours === '' ? null : Number(rawHours), minutes: rawMinutes === '' ? null : Number(rawMinutes) };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
        show('#global-success', 'Jadwal berhasil disimpan.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });
  ['hours', 'minutes'].forEach((name) => $('#schedule-form').elements.namedItem(name).addEventListener('input', updateScheduleIntervalSummary));

  $('#automation-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const enabled = state.data?.automation?.enabled === true;
    if (!enabled && !confirmAction('Aktifkan penerbitan otomatis untuk workspace yang sedang terhubung? Sistem akan langsung memproses utas pertama, lalu menerbitkan berdasarkan interval yang tersimpan.')) return;
    await withPending(button, async () => {
      try {
        if (enabled) {
          const result = await api('/api/automation/pause', { method: 'POST', body: '{}' });
          show('#global-success', result.message || 'Otomasi dijeda.');
        } else {
          const result = await api('/api/automation/enable', { method: 'POST', body: '{}' });
          const firstPostAt = result.firstPostAt ? new Date(result.firstPostAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : null;
          show('#global-success', result.immediate
            ? 'Otomasi aktif. Utas pertama sedang diproses.'
            : `Otomasi aktif. Posting pertama dijadwalkan pada ${firstPostAt || 'setelah jeda minimum satu jam'}.`);
        }
        await refreshAfterMutation(refresh);
      } catch (error) { show('#global-error', errorText(error)); }
    }, 'Memproses…');
  });

  $('#refresh-button').addEventListener('click', () => refresh().catch((error) => show('#global-error', errorText(error))));
  $$('.sidebar-nav .tab').forEach((button) => button.addEventListener('click', () => {
    activateTab(button.dataset.tab);
    if (sidebarViewport.matches && sidebar.classList.contains('is-open')) setSidebarOpen(false, { restoreFocus: false, focusPanel: true });
    loadTabData(button.dataset.tab);
  }));
  $('#onboarding-details-toggle').addEventListener('click', (event) => {
    state.onboardingExpanded = !state.onboardingExpanded;
    $('#onboarding-details').hidden = !state.onboardingExpanded;
    event.currentTarget.setAttribute('aria-expanded', String(state.onboardingExpanded));
    event.currentTarget.textContent = state.onboardingExpanded ? 'Sembunyikan detail' : 'Lihat detail';
  });
  $('#onboarding-settings').addEventListener('click', () => {
    activateTab('content');
    loadTabData('content');
    const setting = $('#content-form').elements.namedItem('ctaUrl');
    setting?.focus({ preventScroll: true });
    setting?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  });
  $('#onboarding-retry').addEventListener('click', (event) => {
    const pending = withPending(event.currentTarget, refresh, 'Memuat…').catch(() => false);
    $('#onboarding-loading').focus({ preventScroll: true });
    return pending;
  });
  $('.sidebar-nav').addEventListener('keydown', (event) => {
    const tabs = $$('.sidebar-nav .tab:not([hidden]):not([disabled])');
    const currentIndex = tabs.indexOf(event.target.closest('.tab'));
    if (currentIndex < 0) return;
    const nextIndex = event.key === 'ArrowDown' ? (currentIndex + 1) % tabs.length
      : event.key === 'ArrowUp' ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    activateTab(next.dataset.tab);
    next.focus();
    loadTabData(next.dataset.tab);
  });
  document.addEventListener('input', (event) => {
    if (event.target?.closest('form')) clearFieldError(event.target);
  });

  $$('input[type="password"]').forEach(addPasswordToggle);
  api('/api/session').then((data) => {
    if (!data.authenticated) { setAuthenticated(false); return; }
    state.csrf = data.csrfToken || ''; setAuthenticated(true); return refresh();
  }).catch(() => setAuthenticated(false));
})();
