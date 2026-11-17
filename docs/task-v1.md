# INFRASTRUCTURE & CI/CD OVERRIDE — BOT NDI

## Konteks dan keputusan final

Perbarui implementasi dan rencana deployment Bot NDI berdasarkan keputusan infrastruktur berikut.

Proyek ini akan dijalankan pada satu LXC Proxmox khusus. GitHub Actions self-hosted runner, Docker Engine, aplikasi Node.js, dan database MySQL berada dalam LXC yang sama.

Saya tidak ingin menggunakan GitHub Container Registry (GHCR) atau container registry lainnya.

Docker image harus dibangun langsung pada LXC menggunakan source code dari repository GitHub Bot NDI.

Repository:

https://github.com/Nusa-Data-Indonesia/bot-ndi.git

Domain produksi:

https://botndi.sequein.my.id

## 1. Infrastruktur Proxmox

Target deployment:

- Proxmox node: `mamay`
- LXC hostname: `ndi-bot`
- Operating system: Debian 13
- CPU: 4 vCPU
- RAM: 8192 MB
- Swap: 512 MB
- Disk: 30 GB
- Container mode: Unprivileged
- Features: `nesting=1`, `keyctl=1`
- LXC firewall: Disabled sesuai konfigurasi aktual
- Docker Engine dan Docker Compose berjalan di dalam LXC

Alamat IP LXC harus diverifikasi melalui konfigurasi aktual sebelum digunakan. Jangan menganggap alamat IP pada screenshot sebagai konfigurasi final.

Jangan mengubah konfigurasi firewall, keyctl, atau Proxmox host tanpa permintaan eksplisit.

## 2. Deployment Tanpa Container Registry

Hapus seluruh ketergantungan aktif terhadap:

- GitHub Container Registry.
- GHCR authentication.
- `docker login` untuk GHCR.
- `docker pull` image aplikasi dari registry.
- GitHub Packages publishing.
- Image tagging dan publishing ke registry eksternal.

Gunakan mekanisme deployment:

1. GitHub Actions menjalankan CI.
2. Setelah perubahan masuk ke branch `main`, workflow deployment yang telah diaktifkan dapat berjalan sesuai kebijakan deployment.
3. Dedicated self-hosted runner Bot NDI menerima job.
4. Runner melakukan checkout source code ke workspace sementara.
5. Runner melakukan validasi konfigurasi deployment.
6. Runner membangun Docker image aplikasi secara lokal.
7. Runner menjalankan pre-deployment checks.
8. Runner menyiapkan database dan migration.
9. Runner memperbarui container aplikasi menggunakan Docker Compose.
10. Runner menjalankan health checks.
11. Jika terjadi kegagalan, lakukan rollback menggunakan image lokal sebelumnya jika masih tersedia dan terverifikasi.

Gunakan image tag berbasis commit SHA agar versi deployment dapat dilacak.

Jangan menggunakan tag `latest` sebagai satu-satunya referensi rollback.

Pastikan image sebelumnya tidak dihapus sebelum deployment baru dinyatakan sehat.

Jangan gunakan `docker compose down -v` pada proses deployment.

## 3. GitHub Actions Self-hosted Runner

Runner harus dipasang langsung pada LXC Bot NDI.

Gunakan runner khusus repository Bot NDI.

Label yang direkomendasikan:

- `self-hosted`
- `linux`
- `x64`
- `bot-ndi`

Ketentuan runner:

1. Gunakan dedicated Linux user untuk runner.
2. Jangan menjalankan runner sebagai root.
3. Konfigurasikan runner sebagai systemd service.
4. Pastikan runner hanya menerima workflow yang memang diizinkan.
5. Gunakan repository-scoped runner jika tersedia.
6. Jangan menggunakan runner BotMerzz.
7. Jangan menggunakan credentials runner BotMerzz.
8. Jangan membagikan workspace runner dengan direktori aplikasi produksi.
9. Hindari menjalankan kode dari pull request yang tidak tepercaya pada runner produksi.
10. Batasi akses runner terhadap file environment dan secrets produksi.

Jika deployment membutuhkan Docker socket, dokumentasikan bahwa akses tersebut memberikan hak setara root pada Docker host. Terapkan pembatasan pada siapa yang dapat mengubah workflow deployment dan siapa yang dapat memicunya.

## 4. GitHub Actions Workflow

Siapkan dua workflow terpisah.

### CI Workflow

Trigger:

- Pull request menuju `main`.
- Push ke `main`.

Tugas:

- Install dependencies.
- Lint.
- Typecheck.
- Unit tests.
- Integration tests.
- Build validation.

Gunakan GitHub-hosted runner untuk CI yang menjalankan kode pull request, apabila memungkinkan.

Jangan memberikan akses Docker socket produksi kepada workflow CI untuk pull request.

### Deployment Workflow

Gunakan self-hosted runner khusus Bot NDI.

Untuk tahap awal, deployment hanya melalui:

`workflow_dispatch`

Setelah deployment pertama berhasil diverifikasi dan saya memberikan persetujuan, auto-deploy dari `main` dapat diaktifkan.

Tambahkan:

- GitHub Environment protection.
- Concurrency control.
- Minimum permissions.
- Pre-deployment checks.
- Health checks.
- Rollback handling.
- Deployment logs yang tidak membocorkan secrets.

Pastikan workflow deployment tidak menggunakan konfigurasi BotMerzz.

## 5. Docker Compose

Gunakan Docker Compose project name:

`bot-ndi`

Minimal services:

- `app`: aplikasi Bot NDI.
- `db`: database MySQL.

Pastikan:

1. MySQL tidak mengekspos port `3306` ke host atau LAN.
2. Database hanya dapat diakses melalui Docker network internal.
3. Credentials dibaca dari environment yang aman.
4. Persistent volume database tidak ikut terhapus saat update.
5. App memiliki health check.
6. Database memiliki health check.
7. App hanya menerima koneksi melalui port yang diperlukan.
8. Restart policy sesuai kebutuhan operasional.
9. Konfigurasi mendukung database initialization dari keadaan kosong.

Gunakan nama volume yang terisolasi dari BotMerzz.

Jangan menggunakan bind mount atau Docker volume milik BotMerzz.

## 6. Cloudflare Tunnel dan Traefik

Domain produksi:

`botndi.sequein.my.id`

Infrastruktur ingress yang sudah tersedia:

- LXC 10080 sebagai gateway.
- Traefik sebagai reverse proxy.
- Cloudflare Tunnel untuk akses publik.

Bot NDI harus menggunakan gateway tersebut tanpa membuat Cloudflare Tunnel baru.

Siapkan dokumentasi integrasi untuk:

1. Hostname `botndi.sequein.my.id`.
2. Cloudflare Tunnel public hostname atau konfigurasi ingress yang sesuai.
3. Routing Traefik ke alamat IP dan port internal Bot NDI.
4. HTTP health check.
5. Trusted proxy configuration.
6. Forwarded headers.
7. HTTPS dan session cookie configuration.
8. Authentication dan authorization dashboard.

Jangan mengubah konfigurasi gateway LXC 10080 secara otomatis.

Jangan mengasumsikan alamat IP Bot NDI sebelum diverifikasi.

Jangan mempublikasikan database melalui Cloudflare Tunnel atau Traefik.

## 7. Fresh Database & Credentials

Bot NDI harus menggunakan database MySQL baru dari kondisi kosong.

Gunakan identitas:

- Database: `bot_ndi`
- Database user: `bot_ndi_app`
- Database storage: dedicated Docker volume.

Jangan melakukan restore database BotMerzz.

Jangan menggunakan:

- Database credentials BotMerzz.
- Authentication secrets BotMerzz.
- Threads credentials BotMerzz.
- Telegram credentials BotMerzz.
- AI provider credentials BotMerzz.
- GitHub runner credentials BotMerzz.

Sediakan `.env.example` tanpa nilai secrets.

Pastikan migrasi database dapat berjalan otomatis dalam prosedur deployment yang terkendali.

## 8. Scheduler dan Integrasi Eksternal

Setelah fresh deployment:

- Scheduler harus nonaktif secara default.
- Threads publishing harus nonaktif secara default.
- Telegram notifications harus nonaktif sampai credentials baru dikonfigurasi.
- AI provider integration tidak boleh menggunakan credentials BotMerzz sebagai fallback.
- Tidak boleh ada posting Threads saat setup atau integration tests.

Aktivasi dilakukan setelah akun dan konfigurasi NDI diverifikasi.

## 9. Dokumentasi Operasional

Buat dokumentasi berbahasa Indonesia yang meliputi:

1. Instalasi Docker pada LXC Debian 13.
2. Instalasi GitHub Actions self-hosted runner.
3. Registrasi runner khusus repository Bot NDI.
4. Konfigurasi systemd runner.
5. Konfigurasi Docker Compose.
6. Pembuatan `.env` produksi.
7. Fresh MySQL initialization.
8. Initial deployment.
9. Konfigurasi Cloudflare Tunnel dan Traefik.
10. Pengujian domain publik.
11. Update aplikasi.
12. Rollback deployment.
13. Backup dan restore database.
14. Disk cleanup yang aman.
15. Troubleshooting.

Sediakan perintah yang dapat dijalankan secara bertahap.

Jangan membuat skrip yang menghapus persistent volume atau database secara otomatis.

## 10. Acceptance Criteria

Implementasi dianggap siap untuk initial deployment apabila:

- [ ] Tidak ada ketergantungan terhadap GHCR.
- [ ] Docker image dibangun lokal pada LXC.
- [ ] GitHub runner disiapkan untuk LXC Bot NDI.
- [ ] Runner dan aplikasi dapat berjalan dalam LXC yang sama.
- [ ] Database MySQL menggunakan volume independen.
- [ ] Aplikasi dapat dijalankan dari database kosong.
- [ ] Workflow CI dan deployment terpisah.
- [ ] Deployment awal menggunakan `workflow_dispatch`.
- [ ] Tidak ada credentials BotMerzz.
- [ ] Tidak ada resource produksi BotMerzz yang digunakan.
- [ ] Scheduler nonaktif secara default.
- [ ] Konfigurasi domain `botndi.sequein.my.id` terdokumentasi.
- [ ] Integrasi Traefik dan Cloudflare Tunnel dapat diverifikasi.
- [ ] Deployment mendukung health check dan rollback.
- [ ] Tidak ada secrets dalam Git repository.
- [ ] Pengujian lokal berhasil.

Jangan mengklaim bahwa runner, domain, atau deployment telah berhasil jika belum diverifikasi pada infrastruktur sebenarnya.

## Instruksi akhir

Implementasikan perubahan yang diperlukan pada codebase Bot NDI.

Perbarui GitHub Actions, Docker Compose, deployment scripts, environment configuration, dan dokumentasi agar menggunakan arsitektur single LXC tanpa container registry.

Seluruh perubahan harus tetap mempertahankan prinsip isolasi penuh dari BotMerzz.

Jangan melakukan push, deployment, atau perubahan langsung pada Proxmox dan Cloudflare tanpa persetujuan saya.

Laporkan perubahan yang sudah diimplementasikan, hasil pengujian, serta langkah konkret yang perlu saya lakukan untuk menyiapkan LXC Bot NDI.