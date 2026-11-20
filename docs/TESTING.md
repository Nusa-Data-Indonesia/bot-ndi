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

`npm run typecheck` memeriksa seluruh `src/**/*.js` dengan opsi TypeScript di `tsconfig.typecheck.json`. `npm test`, `npm run test:integration`, dan `npm run test:ndi:browser` memasang `test/deny-external-network.cjs` melalui `NODE_OPTIONS`, sehingga request Node hanya dapat menuju loopback; Browser E2E juga memblokir host non-loopback. Kredensial provider nyata tidak dibutuhkan. Tanpa konfigurasi MySQL test yang diizinkan, tes database dilewati. Tes provider menggunakan mock/fake dan tidak mempublikasikan ke Threads atau mengirim pesan Telegram.

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
NODE_OPTIONS=--require=./test/deny-external-network.cjs node --test test/ndi-migration.mysql.integration.test.js
```

Tes destructive hanya boleh diarahkan ke schema test disposable. Saat selesai, hentikan service tanpa `-v`; data test boleh dibiarkan pada volume test. Jangan menjalankan perintah Docker volume remove, `down -v`, atau operasi reset terhadap volume.

CI menjalankan schema MySQL disposable terisolasi per job. Tes upgrade menanam data legacy tersanitasi, menerapkan migrasi 021–024, memeriksa state/approval/proposal/conflict dan rerun, serta menguji restartable occurrence state. Jalur Node test CI menggunakan network guard yang sama. Tidak menggunakan provider eksternal atau DB produksi.

## Browser E2E NDI

`npm run test:ndi:browser` menjalankan Chromium headless terhadap server lokal dan schema `bot_ndi_browser_test` di MySQL loopback. Scheduler dan external integrations tetap `false`; network routing browser menolak host di luar loopback. Jalankan hanya terhadap DB disposable yang terpisah dari `bot_ndi_test`.

Pada branch Dual AI, tes browser **PASS 4/4** dengan MySQL disposable pada loopback dan Chromium lokal. Website API diuji lewat response intercept; scheduler dan external integrations nonaktif, tanpa real-site fetch atau provider call.

## Cakupan

- Policy/konfigurasi: timezone, cadence, CTA URL, NDI guardrails, safe defaults, dan redaksi kredensial.
- Auth/HTTP: password hashing, throttling, session, CSRF, same-origin, health, dashboard, category/style routes, dan website-sync routes.
- Strategi konten: 8 kategori, 7 gaya, CRUD/archive/audit, uniform independent selection, provider-confirmed rotation, durable slot snapshot, empty-state fail-closed, AI proposal gate/default OFF/failure isolation.
- Website knowledge: manual-only trigger, fixed origin, DNS/pinning/redirect/size/HTML bounds, per-item provenance/version/review, failure preservation, and stale-version conflicts.
- Dispatcher/provider: slot/idempotency, retry, pause/cancel, unknown reconciliation, mocked Tebar/OpenRouter/Telegram, dan tidak blind replay.
- Dual AI: separate model configuration, conditional review after repairable validation failures, strict review parsing, bounded retries, deterministic revalidation, review markers, unknown continuation and occurrence notifications.
- Test isolation: a loopback fixture proves local requests work while provider destinations are rejected before network I/O.
- Database: migration upgrade/rerun, state retention, concurrent claims, publication timestamp ordering, audit, dan conflict handling.
- Deployment checks: workflow/source contract, shell syntax, Compose validation, dan release compatibility. Docker image build lokal **BLOCKED** karena daemon tidak tersedia; hosted pull-request CI belum dijalankan.

## Hasil verifikasi branch Dual AI

- `npm test`: 532 total, 525 passed, 0 failed, 7 skipped; database-specific migration suites were run separately.
- `npm run test:integration`: 97 passed, 0 failed/skipped; MySQL configuration check terpisah: 1 passed.
- `npm run test:ndi:browser`: 4 passed, 0 failed/skipped.
- Migration 018, Learning upgrade, publication migration 020, publication fence, legacy publication resolution, dan NDI migration 021–024: masing-masing 1 passed.
- Focused Dual AI content/dispatcher tests: 76 passed; Dual AI MySQL integration: 1 passed.
- `npm run lint`, `npm run typecheck`, `npm run check`, `npm audit --audit-level=high`, Compose config, workflow YAML parse, dan deploy shell syntax: PASS; audit menemukan 0 vulnerability.
- `docker build --target runtime --tag bot-ndi:ci .`: BLOCKED karena Docker daemon socket lokal tidak tersedia. Hosted CI pull request belum dijalankan. `actionlint` tidak terpasang.

Tes mock tidak memverifikasi permission provider, Cloudflare Tunnel, proxy headers, deployment LXC, atau domain publik. Tidak menjalankan posting nyata, mengaktifkan scheduler, atau menghapus volume Docker.

Lihat [Docker](DOCKER.md) untuk Compose lokal dan [Panduan Deployment](DEPLOYMENT.md) untuk pemeriksaan LXC/ingress.
