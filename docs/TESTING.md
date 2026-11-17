# Pengujian Bot NDI

## Pemeriksaan lokal

Gunakan Node.js 22.13 atau lebih baru untuk pemeriksaan pengembangan. Instal dependency lalu jalankan lint, full JavaScript typecheck, pemeriksaan sintaks, dan unit/HTTP tests:

```sh
npm ci
npm run lint
npm run typecheck
npm run check
npm test
```

`npm run typecheck` memeriksa seluruh `src/**/*.js` dengan opsi TypeScript yang dicatat di `tsconfig.typecheck.json`. Tanpa konfigurasi MySQL test, tes database akan dilewati. Tes provider memakai mock dan tidak boleh mempublikasikan ke Threads atau mengirim pesan ke grup Telegram operasional.

## Tes integrasi MySQL lokal

`compose.test.yaml` menjalankan hanya service MySQL test, tidak menjalankan aplikasi atau membuat koneksi ke network produksi. Service memakai database `bot_ndi_test`, volume `bot-ndi_test_mysql_data`, serta port loopback `127.0.0.1:3307` (ubah port dengan `TEST_DB_HOST_PORT` jika port itu sedang dipakai).

Jalankan MySQL disposable dan arahkan tes destructive hanya ke database test tersebut:

```sh
export TEST_DB_HOST_PORT="${TEST_DB_HOST_PORT:-3307}"
docker compose --project-name bot-ndi-test --file compose.test.yaml up -d --wait

export NODE_ENV=test
export ALLOW_DESTRUCTIVE_DB_TESTS=true
export DB_HOST=127.0.0.1
export DB_PORT="$TEST_DB_HOST_PORT"
export DB_NAME=bot_ndi_test
export DB_USER=bot_ndi_test
export DB_PASSWORD=test-password-only
export DB_ROOT_PASSWORD=root-test-password-only

npm test
npm run test:integration
```

Nilai password tersebut hanya untuk test disposable. Jangan mengisi environment produksi atau memakai database/volume `bot_ndi`. Saat selesai, hentikan container tanpa menghapus volume:

```sh
docker compose --project-name bot-ndi-test --file compose.test.yaml down
```

Volume test mempertahankan data antar-run. Jika memang perlu membuang database test untuk mengulang dari keadaan kosong, pastikan container test sudah dihentikan, periksa nama volume, lalu hapus hanya volume tersebut:

```sh
docker volume inspect bot-ndi_test_mysql_data
docker volume rm bot-ndi_test_mysql_data
```

Jangan jalankan `down -v` atau menghapus volume pada project lain.

CI menjalankan test pada GitHub-hosted runner dengan MySQL service disposable yang baru untuk setiap job. CI juga menguji migrasi upgrade/concurrency pada schema terisolasi. Jangan menjalankan tes destructive terhadap MySQL produksi atau volume Compose persisten.

## Cakupan

- Policy dan konfigurasi: timezone, jadwal, guardrails, validasi input, defaults nonaktif, dan kredensial yang tidak ditampilkan.
- Auth dan HTTP: password hashing, login throttling, session, CSRF, same-origin, safe errors, health checks, dan dashboard.
- Dispatcher dan provider: slot/idempotency, retry, pause/cancel, rekonsiliasi outcome yang tidak diketahui, serta adapter mock Tebar/OpenRouter/Telegram.
- Database: migrasi, state durable, klaim serentak, notifikasi, webhook deduplication, dan pemulihan setelah koneksi/pool restart.
- Deployment: manual-only workflow, local image build, runner guardrails, health checks, persistent-volume safety, rollback SHA, dan redeploy dengan commit SHA yang sama.

Tes mock tidak memverifikasi permission provider, gateway, Cloudflare Tunnel, proxy headers, deployment LXC, atau domain publik. Jalankan validasi provider dan ingress hanya pada environment yang memang disiapkan operator; jangan mengirim post atau notifikasi operasional sebagai bagian dari tes otomatis.

Lihat [Docker](DOCKER.md) untuk Compose lokal dan [Panduan Deployment](DEPLOYMENT.md) untuk pemeriksaan LXC/ingress.
