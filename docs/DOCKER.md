# Docker dan Docker Compose

Compose digunakan untuk pengembangan lokal dan deployment Bot NDI. Project name tetap `bot-ndi` agar jaringan serta volume yang persisten memiliki identitas terpisah.

## Layanan dan penyimpanan

| Service | Tugas | Akses dan persistensi |
|---|---|---|
| `app` | Dashboard, API, migrasi saat startup, dan scheduler yang opsional | Port container 3000 dipetakan ke `HOST_IP:HOST_PORT`; memiliki health check HTTP ke `/health/ready` |
| `db` | MySQL 8.4 | Tidak memiliki port host; hanya terhubung ke network internal `bot-ndi_database` |

Data MySQL berada pada named volume `bot-ndi_mysql_data`. Service `app` juga terhubung ke network egress untuk panggilan provider setelah integrasi dikonfigurasi. File `.env` berada di luar Git dan tidak dipasang ke image atau container sebagai bind mount. Compose memberi restart policy `unless-stopped` serta batas CPU dan memori pada service.

Nama project, volume, dan network merupakan bagian dari identitas data. Mengubah nama volume dapat membuat Docker menginisialisasi database baru dan aplikasi tampak kehilangan data. Cadangkan MySQL sebelum perubahan definisi Compose.

## Jalankan untuk pengembangan lokal

Gunakan Node.js 22.13 atau lebih baru untuk menjalankan semua pemeriksaan pengembangan, termasuk ESLint 10. Jangan menyalin file environment produksi ke workstation. Buat file lokal baru dengan kredensial sekali pakai, lalu gunakan loopback agar dashboard tidak terbuka ke LAN:

```sh
test ! -e .env || { echo '.env sudah ada; jangan menimpanya.' >&2; exit 1; }
cp .env.example .env
```

Edit `.env` dan isi `DB_PASSWORD` serta `DB_ROOT_PASSWORD` dengan nilai lokal baru. Atur:

```dotenv
NODE_ENV=development
HOST_IP=127.0.0.1
HOST_PORT=3000
BASE_URL=http://localhost:3000
TRUST_PROXY=false
SCHEDULER_ENABLED=false
```

Biarkan Tebar, OpenRouter, dan Telegram credentials kosong. Pastikan semua `LEARNING_*_ENABLED=false`. Jalankan:

```sh
npm ci
docker compose up --build -d --wait
docker compose ps
curl -fsS http://localhost:3000/health/ready
```

Image aplikasi `bot-ndi:local` dibangun dari source checkout. MySQL perlu image MySQL 8.4 tersedia pada Docker Engine. Setelah health check database siap, aplikasi menerapkan migrasi berurutan sebelum melayani request. Buat administrator lokal pertama dengan `docker compose exec -it app npm run admin:create`.

Hentikan layanan lokal tanpa menghapus database:

```sh
docker compose stop
```

## Periksa konfigurasi Compose

Isi wajib yang kosong pada `.env.example` dapat diganti dengan nilai sintetis saat validasi. Perintah ini tidak mencetak hasil konfigurasi yang berisi environment:

```sh
DB_PASSWORD=compose-check \
DB_ROOT_PASSWORD=compose-check \
HOST_IP=127.0.0.1 \
docker compose --env-file .env.example config --quiet
```

Di LXC produksi, `HOST_IP` harus berisi alamat LXC yang diverifikasi. Jangan mengisi IP perkiraan atau IP dari tangkapan layar.

## Tes

`npm test` menjalankan unit dan tes HTTP. Tes provider menggunakan mock dan tidak mengirim Telegram atau post Threads. Tes database destructive memerlukan server MySQL disposable, host loopback, dan opt-in `ALLOW_DESTRUCTIVE_DB_TESTS=true`; CI menyiapkan service disposable pada GitHub-hosted runner. Lihat [Panduan Pengujian](TESTING.md) untuk langkah tes lokal dan MySQL disposable.

Jangan menunjuk tes integrasi ke hostname produksi, database `bot_ndi`, atau volume `bot-ndi_mysql_data`. Jangan menghubungkan service tes ke network produksi.

## Deployment produksi

Workflow deployment membangun image aplikasi lokal dengan tag unik yang memuat commit SHA penuh, GitHub run ID, dan attempt; label image tetap menyimpan SHA commit. Project Compose bernama `bot-ndi`. Tidak ada `docker login`, push, atau pull image aplikasi dari registry. Lihat [Panduan Deployment](DEPLOYMENT.md) untuk cara menjalankan deployment manual, health check, rollback, backup, dan pemulihan.

Selama update rutin, pertahankan volume `bot-ndi_mysql_data` dan image release terakhir yang sehat. Deployment memakai `up` untuk service yang diperlukan; database tidak diekspos ke host/LAN. Jangan menjalankan `docker compose down -v`, `docker volume rm`, atau `docker volume prune` sebagai bagian dari deployment maupun perawatan rutin.
