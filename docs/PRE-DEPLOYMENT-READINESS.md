# Laporan Pre-Deployment Readiness — Bot NDI

Tanggal audit: 18 November 2026 (Asia/Jakarta)

> **Snapshot historis, bukan status terkini.** Laporan ini mencatat keadaan sebelum migrasi konten NDI Fase A dan migration 021. Jumlah migrasi/pengujian, konfigurasi CTA, serta pernyataan deployment manual-only di bawah tidak berlaku sebagai bukti untuk branch Fase A. `origin/main` sekarang memiliki deploy otomatis setelah CI push ke `main` sukses, dengan guard yang menahan perubahan migration/startup surface. Gunakan [audit codebase Fase A](ndi-codebase-audit.md), [checkpoint](ndi-progress-checkpoint.md), dan [rencana implementasi](ndi-implementation-plan.md) untuk status terkini.

Keputusan: **NO-GO untuk initial deployment sampai operator menyiapkan dan memverifikasi infrastruktur LXC, runner, dan ingress.** Perbaikan serta verifikasi lokal yang dapat dilakukan sudah selesai. Tidak ada Git push, deployment Proxmox, perubahan Cloudflare, atau aktivasi Threads.

## Ringkasan status

| Area | Status | Bukti |
|---|---|---|
| Git workspace | **PASS** | Repository baru valid pada branch `main`, remote `origin` mengarah ke repository Bot NDI, dan satu initial commit lokal dibuat tanpa riwayat BotMerzz. Tidak ada push. |
| TypeScript seluruh source | **PASS** | `npm run typecheck` mencakup semua `src/**/*.js`; hasil 0 diagnostic. `skipLibCheck` dihapus. Tidak ada suppression TypeScript. |
| Fresh MySQL | **PASS** | MySQL 8.4.13 disposable yang kosong; 20 migrasi diterapkan, run kedua menerapkan 0; bootstrap, admin CLI, login, health, persistensi, dan restart diuji. |
| Isolation audit | **PASS** | Konfigurasi, workflow, source, image, database, dan volume aktif memakai identitas Bot NDI. Referensi lama yang dipertahankan diberi tanda historis atau berupa assertion negatif di test. |
| Kesiapan konfigurasi lokal | **PASS** | Compose, image build lokal, workflow deployment manual, pemeriksaan deployment, health check, volume, dan rollback divalidasi. |
| LXC Proxmox aktual | **BLOCKED** | IP dan status LXC Debian 13 belum tersedia untuk diverifikasi dari workspace ini. |
| Self-hosted runner aktual | **BLOCKED** | Instalasi runner khusus repo, user non-root, service systemd, label, dan GitHub Environment protection belum diverifikasi. |
| DNS, gateway, Traefik, Cloudflare Tunnel | **BLOCKED** | Routing domain dari gateway LXC 10080 ke IP/port LXC Bot NDI belum dapat diperiksa. Tidak ada perubahan ingress. |
| Deployment awal | **SKIPPED** | Tidak dijalankan sesuai instruksi. Workflow GitHub juga tidak dipicu. |

## Perubahan yang diselesaikan

- Memulihkan Git dengan fresh initialization pada branch `main`, memasang remote Bot NDI, membuat initial commit lokal, dan menjaga semua file aplikasi tetap utuh. Tidak ada riwayat lama yang diimpor.
- Memeriksa seluruh JavaScript di `src/` dengan TypeScript `allowJs` dan `checkJs`; memperbaiki bentuk data hasil MySQL, opsi dependency, signature fungsi, nullability, narrowing, dan tipe Express.
- Memasang `@types/express`, menghapus cakupan typecheck tujuh file, dan mengubah gate CI agar memeriksa seluruh `src/**/*.js`.
- Menambahkan `APPROVED_CTA_HOSTS` yang kosong secara default. URL CTA non-kosong hanya diterima jika host HTTPS disetujui operator. Domain aplikasi tidak diasumsikan sebagai domain marketing.
- Menghapus default pasar Malaysia yang masih aktif: zona waktu menjadi `Asia/Jakarta`, copy dan prompt memakai Bahasa Indonesia, dan harga memakai `IDR`/`Rp`. Getter settings juga mengisi timezone Indonesia hanya saat nilai belum tersimpan, sambil mempertahankan timezone eksplisit. Harga tetap berasal dari fakta produk yang disetujui; tidak ada konversi mata uang.
- Memperbaiki listener koneksi `mysql2/promise` agar memakai API promise pada koneksi MySQL mentah yang benar; uji migrasi awal menemukan warning runtime yang tidak ditangkap typecheck.
- Mengganti label dan teks UI aktif yang masih menyebut produk lama, mengganti fixture test ke host/domain contoh, mengganti nama variabel sesi migrasi SQL, serta menandai audit lama sebagai historis.
- Memastikan deployment membangun image lokal dengan tag release berbasis SHA dan workflow hanya dapat dimulai dengan `workflow_dispatch` setelah CI main yang sukses.

## Pemulihan Git

Sebelum perbaikan, `.git` hanya berisi `.DS_Store`; tidak ada `HEAD`, `config`, refs, atau object database. `git rev-parse`, `git status`, branch/worktree inspection, dan log gagal karena direktori tersebut bukan metadata Git yang valid. Tidak ada parent repository yang membungkus workspace ini. Penyebab yang dapat dibuktikan adalah direktori `.git` sisa/placeholder, bukan riwayat repository yang rusak.

Setelah isi `.git` diperiksa, Git diinisialisasi baru pada branch `main`. `origin` disetel ke `https://github.com/Nusa-Data-Indonesia/bot-ndi.git`; seluruh perubahan lokal tetap di workspace dan tidak ada riwayat BotMerzz yang disalin. Pemeriksaan remote sebelum initial commit tidak menemukan branch refs yang terlihat. Satu initial commit lokal dibuat setelah pemeriksaan file dan secret; tidak ada push.

## Analisis dan hasil TypeScript

Angka **187** adalah jumlah agregat dari snapshot sebelumnya. Raw diagnostic/per-file output dari snapshot itu tidak tersimpan, sehingga distribusi jumlah persis per kategori tidak bisa direkonstruksi dengan jujur. Snapshot yang diukur pada awal remediasi ini setelah sebagian perubahan sebelumnya menunjukkan 124 diagnostic; salah satu lane mencatat 68 pada file dispatcher/repository/Tebar dan lane lain mencatat 51 pada snapshot scoped setelah perubahan awal. Snapshot itu tidak cukup untuk membuat pembagian 187 yang presisi. Kategori dan penanganannya:

| Kategori | Pola yang teramati | Penanganan |
|---|---|---|
| Type mismatch | Properti pada nilai yang terinferensi sebagai `{}`/`object`, aritmetika tanggal/angka, serta perbedaan bentuk hasil API | Menambahkan JSDoc pada batas dependency dan tipe nilai; mempersempit union sebelum operasi. |
| Missing type declarations | Tipe Express belum tersedia pada setup awal; tidak ada unresolved module (`TS2307`) yang tercatat pada snapshot awal | Menambahkan `@types/express`; deklarasi library juga diperiksa karena `skipLibCheck` tidak lagi aktif. |
| Nullability | Nilai callback/outcome yang dapat kosong dan error dengan bentuk tidak pasti | Menangani nilai nullable secara eksplisit serta mempersempit error ke bentuk yang aman. |
| Incorrect imports | Tidak ada diagnostic resolusi import (`TS2307`) yang tercatat pada output awal | Tidak ditemukan import source yang salah; dependency tipe Express dilengkapi. |
| Invalid function signatures | Opsi/destructuring yang tidak cocok, argumen wajib yang hilang, dan interface provider/repository berbeda | Menyelaraskan signature/JSDoc dan menambahkan adapter tipe pada batas provider/repository tanpa mengubah payload atau SQL. |
| Database-related types | Union `QueryResult` mysql2, hasil SELECT dibanding mutation, dan asumsi query callback/promise | Menambahkan adapter row/mutation yang mempertahankan `.query()` versus `.execute()`. Uji MySQL juga menemukan serta memicu perbaikan listener timezone yang salah memakai `.catch()` pada event koneksi callback. |
| Legacy technical debt | Opsi dan record dinamis tanpa bentuk tipe yang jelas, terutama pada dependency injection dan hasil repository | Memberi bentuk tipe pada opsi, record, dan hasil lintas modul; tanpa `@ts-ignore`, `@ts-nocheck`, atau perubahan business logic yang disengaja. |

Gate sekarang memakai seluruh `src/**/*.js` dengan opsi typecheck proyek yang sudah ada dan menghasilkan **0 diagnostic**. `strict: false` tidak diubah dari konfigurasi sebelum tugas ini; typecheck diperluas dan diperkuat dengan memeriksa deklarasi library. Migrasi terpisah ke `strict: true` masih menjadi technical debt, bukan bagian dari baseline 187 yang dilaporkan.

## Fresh database integration

Pengujian memakai MySQL 8.4.13 disposable pada port loopback dengan volume baru bernama khusus test. Tidak membaca `.env`, tidak menggunakan kredensial/volume BotMerzz, dan tidak menghubungi Threads, Tebar, Telegram, atau OpenRouter. Sesudah verifikasi, container dan volume disposable sudah dihapus; pemeriksaan akhir memastikan keduanya tidak tersisa.

| Pemeriksaan | Status | Hasil |
|---|---|---|
| Database kosong dan init | **PASS** | Schema test baru tidak memiliki tabel aplikasi sebelum migrasi; migrasi membuat 35 tabel termasuk `schema_migrations`. |
| Migrasi | **PASS** | Run pertama menerapkan 20 file migrasi. |
| Idempotency migrasi | **PASS** | Run kedua menerapkan 0 migrasi. |
| Default settings fresh | **PASS** | Getter repository pada database baru mengembalikan `Asia/Jakarta`; automation nonaktif dan belum ada admin sebelum bootstrap. |
| Upgrade/recovery migrasi | **PASS** | Migration 018, learning upgrade dari 011, publication migration upgrade, publication fence, legacy publication closure, dan learning-shadow/database restart recovery: masing-masing 1/1. |
| Admin bootstrap | **PASS** | `admin:create` membuat satu admin test pada schema baru; automation tetap nonaktif dan integration config berstatus `NOT_CONFIGURED`. |
| Authentication | **PASS** | Login HTTP menghasilkan 200; session endpoint mengembalikan authenticated untuk admin test. Login kembali juga lolos setelah restart MySQL. |
| Persistence | **PASS** | Admin test dan 20 migration records tetap ada setelah container MySQL direstart memakai volume test yang sama. |
| Application connectivity | **PASS** | Aplikasi Node berjalan lokal dengan scheduler dan provider integrations nonaktif; `/health/ready` mengembalikan 200. |
| Database health check | **PASS** | Health check container MySQL berstatus `healthy`; koneksi pool aplikasi menggunakan timezone sesi `+00:00`. |
| Browser integration | **PASS** | Browser test pada MySQL terisolasi dan Chromium lokal: 8/8 lulus. |

## Isolation audit

Pemeriksaan pada source, `public/`, workflow, Compose, Dockerfile, migration, script deployment, environment example, E2E, dan dokumen operasional aktif tidak menemukan dependency operasional ke BotMerzz/KedaiMerzz, hostname lama, volume/database lama, IP deployment lama, GHCR, atau `docker login/pull`. Dokumen arsitektur aktif memakai timezone `Asia/Jakarta`; default timezone/language/currency yang diwarisi dari pasar Malaysia sudah diganti dengan default Indonesia. Kata Melayu yang tersisa hanya ada pada pola deteksi multilingual untuk instruksi tidak aman dan parser kompatibilitas format produk; keduanya bukan konfigurasi atau akun operasional. Guardrail test tetap memuat nama lama hanya untuk memastikan konfigurasi baru menolaknya. Dokumen lama `REQUIREMENTS`, audit input/UI, dan remediation diberi penanda historis dan instruksi agar tidak dipakai sebagai konfigurasi aktif. Berkas evidence/inventaris lokal yang privat diabaikan Git dan tidak dihapus.

`compose.yaml` memakai project/network/volume Bot NDI; database tidak mempublikasikan port host. Scheduler dan seluruh integrasi provider nonaktif bila tidak dikonfigurasi. CTA allowlist kosong sampai operator menyetujui host terpisah. `.env` lokal tidak dibaca dan dikecualikan oleh `.gitignore`/`.dockerignore`.

## Hasil pengujian keseluruhan

| Jenis pengujian | Status | Hasil |
|---|---|---|
| Unit dan regression (`npm test`, dengan MySQL disposable) | **PASS** | 516 test: 510 lulus, 0 gagal, 6 dilewati oleh gate schema/runner khusus. Keenam skenario dilewati dijalankan terpisah pada schema/container disposable dan masing-masing lulus 1/1. |
| Integration (`npm run test:integration`) | **PASS** | 93/93 test integrasi server/dispatcher/webhook/database, lalu konfigurasi MySQL 1/1. |
| Database tests | **PASS** | Fresh init, migration, idempotency, upgrade/recovery, bootstrap, auth, persistence, application health, DB health, dan restart di atas lulus. |
| Typecheck | **PASS** | `npm run typecheck`; semua source `src/**/*.js`, 0 diagnostic. |
| Lint | **PASS** | `npm run lint`. |
| Syntax | **PASS** | `npm run check`; seluruh JavaScript lulus pemeriksaan sintaks. |
| Build | **PASS** | Docker runtime image berhasil dibangun lokal sebagai `bot-ndi:ci`; tidak dipush atau dijalankan sebagai deployment. Audit dependency pada build menemukan 0 vulnerability. |
| Docker Compose | **PASS** | `compose.yaml` produksi dan `compose.test.yaml` berhasil divalidasi dengan `docker compose config --quiet`. |
| GitHub Actions | **PASS** | Kedua workflow berhasil diparse sebagai YAML; assertion workflow memverifikasi CI dan deployment manual-only. Workflow tidak dijalankan di GitHub. |
| Deployment regression | **PASS** | 18/18 test `deploy-homelab` dan workflow deployment lulus, termasuk refusal untuk IP yang tidak terpasang, migration failure, rollback, dan volume. |
| Security/dependency audit | **PASS** | `npm audit --audit-level=high`: 0 vulnerability. Pemindaian staged files tidak menemukan kredensial aktif; pola key yang cocok hanya ada pada fixture test/model ID sintetis. `.env` dan evidence lokal tidak masuk Git. |
| Initial deployment/ingress | **SKIPPED** | Tidak dijalankan sesuai instruksi; tidak ada aksi Proxmox, GitHub runner, Cloudflare, DNS, atau Threads. |

## Risiko dan blocker tersisa

- LXC `ndi-bot`, IP final, Docker Engine/Compose pada Debian 13, dan kapasitas/fitur LXC aktual belum dapat diverifikasi dari workspace lokal.
- Dedicated repository-scoped GitHub Actions runner belum dibuktikan terpasang sebagai user non-root/systemd dengan label `bot-ndi`. Akses Docker socket setara hak root pada host, sehingga workflow deploy dan siapa yang dapat menjalankannya harus dibatasi.
- Environment protection `production`, DNS `botndi.sequein.my.id`, gateway LXC 10080, Traefik, Cloudflare Tunnel, forwarded headers, TLS, dan trusted proxy belum dapat diuji dari luar.
- `.env` produksi, password MySQL baru, `HOST_IP`, trusted proxy IP/range, CTA host yang disetujui, akun provider, dan first-admin produksi belum disiapkan. Scheduler/provider integrations harus tetap nonaktif sampai akun NDI diverifikasi.
- Facts API saat ini menggunakan IDR/Rp dan belum menyediakan input currency lain. Jika NDI memerlukan mata uang selain Rupiah, tambahkan dukungan eksplisit sebelum memasukkan fakta harga tersebut.
- `strict: false` tetap mengikuti konfigurasi lama; seluruh source kini diperiksa dan tidak memiliki diagnostic pada gate tersebut, tetapi migrasi terpisah ke `strict: true` masih diperlukan untuk menutup backlog implicit-any yang lebih luas.
- Domain, runner, dan workflow GitHub sebenarnya belum diverifikasi; validasi workflow lokal tidak membuktikan bahwa GitHub Environment atau runner sudah tersedia.

## Konfigurasi yang harus disiapkan operator

1. Siapkan LXC khusus pada Debian 13 sesuai rencana; verifikasi IP aktual dari konfigurasi Proxmox dan OS di dalam LXC.
2. Pasang Docker Engine dan Compose di LXC; pastikan `docker context` memakai Unix socket lokal. Jangan gunakan host/volume Docker lain.
3. Buat user Linux khusus `bot-ndi-runner` non-root, pasang runner khusus repository Bot NDI sebagai systemd service, beri label `self-hosted`, `linux`, `x64`, `bot-ndi`, dan batasi workflow yang dipercaya. Pisahkan workspace runner dari `/opt/bot-ndi`.
4. Aktifkan GitHub Environment `production` dengan perlindungan/manual approval, pembatasan branch `main`, akses secret minimum, dan hanya trigger `workflow_dispatch` untuk deployment awal.
5. Pastikan `/opt/bot-ndi/.env` di LXC memiliki mode `0600`. Isi `HOST_IP` hanya dengan IP terverifikasi, base URL domain Bot NDI, password DB baru, dan trusted proxy yang cocok dengan gateway. Jangan salin `.env` atau credential dari sistem lama.
6. Pertahankan DB `bot_ndi`, user `bot_ndi_app`, dan volume `bot-ndi_mysql_data` khusus Bot NDI. Initial deployment mewajibkan scheduler/Learning nonaktif dan eksternal default nonaktif; kredensial NDI boleh tetap terisi. Aktifkan `EXTERNAL_INTEGRATIONS_ENABLED=true` setelah deployment berhasil dan pemilik NDI menyetujuinya. Publishing tetap memerlukan scheduler dan aktivasi automation eksplisit.
7. Minta operator ingress mengarahkan `botndi.sequein.my.id` melalui Cloudflare Tunnel dan Traefik di gateway LXC 10080 ke IP/port LXC yang sudah diverifikasi. Uji HTTPS, forwarded headers, cookie/session, `/health/ready`, dan dashboard terlindungi sebelum mengaktifkan publishing.
8. Setelah CI berjalan pada commit di `main`, lakukan initial release melalui `workflow_dispatch`, lalu verifikasi log deployment, health, revision aktif, domain publik, database backup, dan rollback sebelum mempertimbangkan auto-deploy.

## Keputusan akhir

**NO-GO untuk deployment sekarang.** Kode, Git lokal, database disposable, Compose, build, CI/deployment guardrail, dan regression tests lolos verifikasi lokal. Deployment baru boleh dimulai setelah operator menyelesaikan serta membuktikan konfigurasi LXC, runner, GitHub Environment, `.env` produksi, dan ingress/domain. Tidak ada tindakan eksternal yang dilakukan dalam audit ini.
