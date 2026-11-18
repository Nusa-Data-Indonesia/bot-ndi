# Bot NDI

Bot NDI adalah aplikasi Node.js untuk dashboard, pengelolaan integrasi, dan otomasi konten Threads. Database MySQL menyimpan akun administrator, konfigurasi, jadwal, dan riwayat. Migrasi dijalankan oleh aplikasi sebelum server mulai.

## Jalankan lokal

Runtime aplikasi mendukung Node.js 20.6 atau lebih baru. Gunakan Node.js 22.13 atau lebih baru untuk pengembangan penuh dan lint ESLint 10. Salin `.env.example` menjadi `.env`, isi kredensial MySQL khusus lokal, dan gunakan `HOST_IP=127.0.0.1` serta `BASE_URL=http://localhost:3000`.

```sh
test ! -e .env || { echo '.env sudah ada; pertahankan dan periksa secara lokal sebelum melanjutkan.' >&2; exit 1; }
cp .env.example .env
npm ci
docker compose up --build -d --wait
curl -fsS http://localhost:3000/health/ready
```

Buat administrator pertama secara interaktif setelah aplikasi siap:

```sh
docker compose exec -it app npm run admin:create
```

Perintah meminta email dan password; input password disembunyikan. Tidak ada akun atau kredensial administrator bawaan.

## CI dan deployment

Pull request menuju `main` dan push ke `main` menjalankan CI pada GitHub-hosted runner. CI menjalankan ESLint, pemeriksaan tipe JavaScript seluruh `src/**/*.js` memakai TypeScript `allowJs`/`checkJs`, pemeriksaan sintaks, tes, tes database yang terisolasi, dan validasi build.

Setelah PR digabung ke `main`, workflow **Deploy Bot NDI** berjalan otomatis bila CI untuk push tersebut sukses dan commit itu masih HEAD `main`. GitHub memverifikasi run CI sebelum mengirim job ke runner produksi. CI pull request dan fork hanya untuk pengujian.

Runner `ndi-bot-runner` membangun image dari SHA terverifikasi pada LXC `ndi-bot`. Tag `<commit-SHA>-<run-id>-<attempt>` membedakan setiap build lokal. Deployment dan rollback manual tetap tersedia lewat **Actions → Deploy Bot NDI → Run workflow** dari `main`. Perubahan migrasi memerlukan review operator dan deployment manual. Aturan Environment `production` berlaku untuk kedua mode.

Lihat [Panduan Deployment](docs/DEPLOYMENT.md) untuk persiapan LXC, runner, database baru, routing ingress, update, rollback, serta backup dan pemulihan. Periksa [Docker](docs/DOCKER.md) untuk Compose dan pengembangan lokal, dan [Operasional](docs/OPERATIONS.md) untuk pemeriksaan layanan sehari-hari.

Operator telah memverifikasi deployment awal, MySQL, login admin, dan endpoint readiness publik. Gunakan panduan instalasi ketika menyiapkan LXC baru atau melakukan pemulihan.

## Pengembangan dan tes

```sh
npm ci
npm run lint
npm run typecheck
npm run check
npm test
```

Tes integrasi MySQL memakai server disposable dengan `ALLOW_DESTRUCTIVE_DB_TESTS=true` dan alamat loopback. Jangan jalankan tes destruktif terhadap database produksi atau volume Compose persisten. Tes provider menggunakan mock; setup dan tes tidak boleh mengirim notifikasi Telegram atau mempublikasikan post Threads.

Perintah aplikasi lain:

- `npm start` menjalankan server dashboard.
- `npm run migrate` menerapkan migrasi MySQL yang belum dijalankan.
- `npm run admin:create` membuat administrator pertama secara interaktif.
- `npm run dispatch` memproses satu slot yang sudah jatuh tempo; gunakan hanya setelah meninjau konfigurasi dan target.

Scheduler, Threads publishing, Telegram, dan integrasi AI tetap nonaktif sampai kredensial baru dan akun NDI diverifikasi serta aktivasi dilakukan secara terpisah.
