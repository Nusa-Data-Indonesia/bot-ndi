# Pengujian Bot NDI

## Pemeriksaan lokal

Gunakan Node.js 22.13 atau lebih baru untuk pemeriksaan pengembangan. Instal dependency lalu jalankan lint, full JavaScript typecheck, pemeriksaan sintaks, dan tes:

```sh
npm ci
npm run lint
npm run typecheck
npm run check
npm test
```

`npm run typecheck` memeriksa seluruh `src/**/*.js` dengan opsi TypeScript di `tsconfig.typecheck.json`. Tanpa konfigurasi MySQL test, tes database dilewati. Tes provider menggunakan mock/fake dan tidak mempublikasikan ke Threads atau mengirim pesan Telegram.

## Tes MySQL disposable

`compose.test.yaml` menjalankan MySQL test pada loopback. Gunakan project/schema khusus test, jangan gunakan database atau volume `bot-ndi` produksi, dan jangan menghapus Docker volume. Untuk tes migrasi, gunakan container MySQL disposable yang tidak memasang volume produksi; gunakan schema `bot_ndi_test_ndi_upgrade` hanya pada instance itu.

```sh
export TEST_DB_HOST_PORT="${TEST_DB_HOST_PORT:-3307}"
docker compose --project-name bot-ndi-test --file compose.test.yaml up -d --wait
export NODE_ENV=test ALLOW_DESTRUCTIVE_DB_TESTS=true
export DB_HOST=127.0.0.1 DB_PORT="$TEST_DB_HOST_PORT"
export DB_NAME=bot_ndi_test DB_USER=bot_ndi_test DB_PASSWORD=test-password-only
npm run test:integration
```

Untuk tes upgrade 021–023, set `DB_NAME=bot_ndi_test_ndi_upgrade` lalu jalankan:

```sh
node --test test/ndi-migration.mysql.integration.test.js
```

Tes destructive hanya boleh diarahkan ke schema test disposable. Saat selesai, hentikan service tanpa `-v`; data test boleh dibiarkan pada volume test. Jangan menjalankan perintah Docker volume remove, `down -v`, atau operasi reset terhadap volume.

CI menjalankan schema MySQL disposable terisolasi per job. Tes upgrade menanam data legacy tersanitasi, menerapkan migrasi 021–023, memeriksa state/approval/proposal/conflict, dan menjalankan ulang migrasi. Tidak menggunakan provider eksternal atau DB produksi.

## Browser E2E NDI

`npm run test:ndi:browser` menjalankan Chromium headless terhadap server lokal dan schema `bot_ndi_browser_test` di MySQL loopback. Scheduler dan external integrations tetap `false`; tidak ada provider call. Jalankan hanya terhadap DB disposable yang terpisah dari `bot_ndi_test`.

Pada branch B/C, tes browser **PASS 4/4** dengan MySQL disposable pada loopback dan Chromium lokal. Website API diuji lewat response intercept; scheduler dan external integrations nonaktif, tanpa real-site fetch atau provider call.

## Cakupan

- Policy/konfigurasi: timezone, cadence, CTA URL, NDI guardrails, safe defaults, dan redaksi kredensial.
- Auth/HTTP: password hashing, throttling, session, CSRF, same-origin, health, dashboard, category/style routes, dan website-sync routes.
- Strategi konten: 8 kategori, 7 gaya, CRUD/archive/audit, uniform independent selection, provider-confirmed rotation, durable slot snapshot, empty-state fail-closed, AI proposal gate/default OFF/failure isolation.
- Website knowledge: manual-only trigger, fixed origin, DNS/pinning/redirect/size/HTML bounds, per-item provenance/version/review, failure preservation, and stale-version conflicts.
- Dispatcher/provider: slot/idempotency, retry, pause/cancel, unknown reconciliation, mocked Tebar/OpenRouter/Telegram, dan tidak blind replay.
- Database: migration upgrade/rerun, state retention, concurrent claims, publication timestamp ordering, audit, dan conflict handling.
- Deployment checks: workflow/source contract, shell syntax, Compose validation, dan release compatibility. Docker image build terakhir BLOCKED karena base `node:22-bookworm-slim` tidak tersedia lokal dan build sengaja tidak menarik image.

## Hasil verifikasi branch Phase B/C

- `npm test`: 485 total, 460 passed, 0 failed, 25 skipped; MySQL-backed tests are run separately.
- `test/deploy-homelab.test.js`: 30 passed, 0 failed.
- `npm run test:integration`: 94 passed, 0 failed, 0 skipped; MySQL configuration check terpisah: 1 passed.
- `test/ndi-migration.mysql.integration.test.js`: 1 passed pada MySQL disposable; publication-resolution MySQL: 10/10 passed.
- `npm run lint`, `npm run typecheck`, `npm run check`, Compose config validation, dan Docker build: PASS.
- Browser E2E: 4/4 PASS. Phase B/C GitHub CI belum berjalan sebelum PR dibuat; `actionlint` tidak terpasang.

Tes mock tidak memverifikasi permission provider, Cloudflare Tunnel, proxy headers, deployment LXC, atau domain publik. Tidak menjalankan posting nyata, mengaktifkan scheduler, atau menghapus volume Docker.

Lihat [Docker](DOCKER.md) untuk Compose lokal dan [Panduan Deployment](DEPLOYMENT.md) untuk pemeriksaan LXC/ingress.
