# Operasional Bot NDI

Dokumen ini memuat pemeriksaan rutin setelah operator menyiapkan LXC dan deployment pertama. Urutan persiapan infrastruktur, route, dan pemulihan data lengkap ada di [Panduan Deployment](DEPLOYMENT.md).

## Periksa layanan

Pada LXC, jalankan pemeriksaan status release aktif:

```sh
docker compose \
  --project-directory /opt/bot-ndi \
  --env-file /opt/bot-ndi/.env \
  --env-file /opt/bot-ndi/active/release.env \
  --project-name bot-ndi \
  --file /opt/bot-ndi/active/compose.yaml ps
```

Di LXC, periksa endpoint pada alamat host yang sudah diverifikasi ke `HOST_IP`; dari client, periksa domain publik:

```bash
read -r -p 'HOST_IP Bot NDI yang diverifikasi: ' BOT_NDI_IP
curl -fsS "http://${BOT_NDI_IP}:3000/health/live"
curl -fsS "http://${BOT_NDI_IP}:3000/health/ready"
curl -fsS https://botndi.sequein.my.id/health/ready
```

`/health/live` memeriksa proses aplikasi. `/health/ready` memeriksa koneksi database dan kesiapan scheduler bila scheduler secara sengaja diaktifkan. Keduanya mengembalikan status minimal; endpoint publik tidak memuat data akun atau konfigurasi.

Gunakan log terbatas tanpa membaca `.env`:

```sh
docker compose \
  --project-directory /opt/bot-ndi \
  --env-file /opt/bot-ndi/.env \
  --env-file /opt/bot-ndi/active/release.env \
  --project-name bot-ndi \
  --file /opt/bot-ndi/active/compose.yaml logs --tail=100 app db
```

Pastikan database tidak memiliki port host dan volume yang dipakai adalah `bot-ndi_mysql_data`. MySQL hanya dapat diakses dari network Docker internal. Jangan menambahkan port 3306 untuk debugging.

## Scheduler dan integrasi eksternal

Setup awal menyimpan `EXTERNAL_INTEGRATIONS_ENABLED=false` dan `SCHEDULER_ENABLED=false`. Kredensial Tebar, OpenRouter, dan Telegram boleh sudah terisi khusus NDI; keberadaannya tidak mengirim request dan tidak mengaktifkan posting/notifikasi. Flag Learning lama tidak memasukkan rule game/top-up ke prompt NDI; UI dan endpoint Learning lama tidak didaftarkan pada server aktif. Tidak ada credential aplikasi lain sebagai fallback. Job usulan kategori AI terpisah dari scheduler posting, default OFF, dan tidak auto-approve.

Sebelum mengaktifkan scheduler atau Threads publishing, operator harus memverifikasi akun Tebar dan target Threads NDI, lalu meninjau identitas, layanan, status NDI Ticketing, klaim yang diizinkan, hashtag, zona waktu, kuota, biaya AI, dan izin notifikasi pada dashboard. Knowledge baru perlu disetujui admin. CTA default adalah `https://nusadataindonesia.com`; admin dapat mengatur URL HTTPS lain yang valid, dan aplikasi tidak mengunjungi URL tersebut. Domain dashboard `botndi.sequein.my.id` tetap terpisah dari URL pemasaran. Posting otomatis juga membutuhkan `SCHEDULER_ENABLED=true` dan aksi eksplisit admin untuk mengaktifkan automation.

Saat memperbarui database legacy, migrasi 021–024 mengarsipkan konfigurasi lama, menyiapkan knowledge NDI yang belum disetujui, strategi default yang belum diaktifkan, tabel proposal sync, dua model AI, snapshot Dual AI, dan pencatatan occurrence `unknown`. Data `service_facts`, slot, sesi, audit, nilai model/account aktif, credentials dan flag `automation_enabled` tidak direset. Runtime NDI tidak membaca facts lama. Slot `publishing`/`unknown` mempertahankan identitas asal dan tidak dikirim ulang; slot unknown tetap memerlukan rekonsiliasi manual, tetapi tidak menghentikan slot terjadwal berikutnya pada interval admin. Slot lama tanpa CTA/strategy snapshot yang sah tidak dapat dipublikasikan. Strategi harus di-review admin ketika automation dijeda. Website sync hanya berjalan dari tindakan manual admin, dan usulan tidak mengubah knowledge sebelum keputusan per-item. Jangan mengaktifkan scheduler atau menjalankan migration produksi sebelum operator meninjau state DB dan strategi rollback database/image.

Scheduler berjalan di dalam proses aplikasi hanya bila `SCHEDULER_ENABLED=true`. Bila automation nanti diaktifkan, periksa jadwal dan target terlebih dahulu; tick pertama dapat terjadi segera setelah proses berjalan. Slot terlewat tidak diproses ulang otomatis. Hasil provider yang belum pasti tidak pernah dikirim ulang, sedangkan slot berbeda berikutnya tetap mengikuti `settings.nextSlotAt` dan interval admin. Penguncian pause, account switch dan satu slot in-flight tetap berlaku. Setiap transisi baru ke `unknown` mengantrikan notifikasi; tiga kejadian dalam rolling 24 jam UTC mengantrikan satu alert tambahan yang ditahan selama 24 jam. Kegagalan Telegram hanya menunda pengiriman outbox.

Untuk pause darurat, gunakan kontrol emergency-pause pada dashboard untuk mencegah klaim slot baru. Jika proses scheduler juga harus dihentikan, ubah `SCHEDULER_ENABLED=false` di `/opt/bot-ndi/.env` dan jalankan deployment workflow dari commit `main` yang lulus CI serta disetujui agar app dibuat ulang dengan konfigurasi tersebut. Verifikasi readiness setelahnya. Pause ini menghentikan scheduler lokal; ia tidak membatalkan post terjadwal yang sudah dikirim ke provider. Periksa dan kelola item itu di akun provider yang tepat.

## Login, session, dan reverse proxy

Dashboard mensyaratkan akun administrator yang dibuat operator. Tidak ada default admin. Gunakan HTTPS publik dengan `BASE_URL=https://botndi.sequein.my.id`; cookie session production memiliki atribut `HttpOnly`, `SameSite=Strict`, dan `Secure`.

Jika login/session atau pembatasan request bermasalah, verifikasi:

- Host header yang diteruskan Traefik adalah `botndi.sequein.my.id`.
- Jalur HTTPS mempertahankan `X-Forwarded-Proto: https` dan forwarded headers hanya dipercaya dari proxy yang diketahui.
- `TRUST_PROXY` cocok dengan alamat sumber Traefik yang terverifikasi pada sisi Bot NDI.
- TLS publik masih aktif dan `BASE_URL` sama persis dengan origin HTTPS kanonis.
- Jam sistem LXC dan gateway tersinkronisasi.

Jangan mengubah `TRUST_PROXY` menjadi `true` untuk mengatasi masalah tanpa mengevaluasi jalur proxy dan jaringan. Jangan menonaktifkan Secure cookie pada production.

## Update dan rollback

Setelah merge yang disetujui, pantau **CI** untuk push ke `main`, lalu **Deploy Bot NDI** yang memverifikasi SHA dan menjalankan update otomatis. Merge dapat memicu produksi dan memerlukan persetujuan eksplisit; perubahan Phase B/C belum boleh dirilis sebelum CI dan review migrasi/rollback selesai. Jika commit tersebut sudah disusul commit baru, pantau CI milik HEAD terbaru. Jika Environment `production` meminta persetujuan, job menunggu reviewer. Ringkasan Actions mencatat SHA yang dideploy. Setelah pemeriksaan kesehatan lulus, `/opt/bot-ndi/active` menunjuk ke release `/opt/bot-ndi/releases/<sha>-<run-id>-<run-attempt>`.

Jika deployment otomatis berhenti karena perubahan migrasi, periksa kompatibilitas schema dengan image sebelumnya dan siapkan backup manual. Setelah review selesai, gunakan **Run workflow** dari `main` dengan `rollback_sha` kosong. `/opt/bot-ndi/state/database-migration-in-progress` menandakan migrasi gagal atau statusnya belum dapat dipastikan; auto-deployment tetap berhenti sampai operator merekonsiliasi schema lewat deployment manual. Migrasi yang berhasil mencatat baseline schema sebelum app health check, sehingga gagalnya promosi aplikasi tidak membuat baseline tertinggal. Jika `/opt/bot-ndi/state/database-schema-tracking` ada tetapi file baseline hilang, hentikan auto-deployment dan lakukan rekonsiliasi operator.

Untuk rollback aplikasi, masukkan SHA dari `metadata.json` pada direktori release yang disebut oleh `previous-release`. Setelah kegagalan, periksa hasil recovery dan endpoint readiness. Rollback memakai image lokal sebelumnya, memeriksa MySQL aktif tanpa menjalankan ulang service DB dari Compose lama, dan mempertahankan schema MySQL saat ini. SHA `main` yang mengendalikan rollback disimpan di `/opt/bot-ndi/state/automatic-deployment-hold`; auto-deployment untuk SHA tersebut tetap ditahan sampai operator melakukan redeploy manual atau `main` maju.

Lihat [Panduan Deployment — Update](DEPLOYMENT.md#7-update-aplikasi), [Health check dan rollback](DEPLOYMENT.md#8-health-check-log-dan-rollback), serta [Backup dan restore](DEPLOYMENT.md#9-backup-dan-restore-database).

## Backup, pemulihan, dan disk

Buat backup MySQL terenkripsi dengan prosedur [Panduan Deployment — Backup dan restore](DEPLOYMENT.md#9-backup-dan-restore-database). Docker volume bukan backup. Rehearse restore pada instance/volume disposable dan cocokkan SHA aplikasi serta migration history. Saat pemulihan produksi, pertahankan volume dan image aktif lama sampai hasil restore diverifikasi.

Pantau ruang dengan `df -h /` dan `docker system df`. Pertahankan image aktif dan sebelumnya yang sehat. Pembersihan build cache tua dapat dilakukan secara interaktif setelah backup valid; jangan gunakan perintah prune yang menghapus image atau volume tanpa daftar kandidat dan persetujuan operator.

## Troubleshooting singkat

| Gejala | Tindakan awal |
|---|---|
| `/health/ready` gagal | Periksa status `db`, health check MySQL, migration logs, lalu log app dengan batas `--tail`; jangan menghapus volume. |
| Dashboard publik tidak bisa dibuka | Bandingkan health dari LXC, LXC 10080, lalu domain; verifikasi IP aktual, host router Traefik, dan route tunnel yang sudah ada. |
| Login terus kembali ke halaman awal | Pastikan HTTPS, `BASE_URL`, forwarded Host/Proto, waktu sistem, dan cookie Secure. Jangan menyalin nilai cookie ke log. |
| Runner tidak mengambil job | Periksa systemd service, label `bot-ndi`, ref `main`, serta approval Environment. Jangan arahkan pull request ke runner produksi. |
| Kapasitas disk rendah | Periksa usage Docker dan pertahankan image SHA aktif/sebelumnya serta volume database. Ikuti langkah pembersihan terarah pada Panduan Deployment. |
| Provider tidak siap | Pastikan akun dan credentials NDI baru dikonfigurasi. Jangan mencari atau menyalin credentials dari aplikasi lain. |
