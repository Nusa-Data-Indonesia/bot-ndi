# Audit Codebase Bot NDI

Tanggal: 2026-11-18
Branch kerja: `codex/ndi-phase-b` berisi Fase B; Fase C dipisahkan sebagai branch bertingkat. Baseline: PR #3 / `codex/ndi-phase-a` (`153da83`).
SSOT: `docs/BOT-NDI-MASTER-CODEX-PROMPT.md`, 377 baris; seluruh baris dibaca ulang dalam rentang berurutan 1–130, 131–260, dan 261–377.

## Cakupan dan batas bukti

`docs/PRE-DEPLOYMENT-READINESS.md` adalah snapshot historis sebelum Fase A (migration 021), bukan bukti kesiapan branch ini. Dokumen itu kini diberi penanda dan tautan ke laporan ini. Dokumen remediation dan audit UI/security lama juga tetap dipertahankan sebagai histori; banner-nya mengarah ke kebijakan NDI aktif.

Audit menelusuri alur startup, konfigurasi efektif, generator, database/repository, dashboard/API, dispatcher/scheduler, OpenRouter, Tebar, Telegram, retry/unknown, autentikasi/CSRF/audit, migrasi, Compose, CI, deployment, dan dokumen operasional. Pencarian case-insensitive mencakup variasi `Kedai Merzz`, `BotMerzz`, top-up, game, harga/stok/SKU, `gameWhitelist`, `priceMode`, `trackedLinks`, fakta layanan, template, dan learning; hasil legacy diklasifikasikan di bawah sebagai aktif, guardrail penolak, kompatibilitas, histori, atau dihapus dari jalur aktif.

Tidak ada koneksi ke database, `.env`, LXC, provider, scheduler produksi, GitHub Actions produksi, atau aplikasi/infrastruktur BotMerzz terpisah. Isi aktual database, `automation_enabled`, konfigurasi akun, serta slot produksi `ready/publishing/unknown` tetap tidak diketahui. Bukti migrasi berasal dari MySQL 8.4 disposable tanpa volume, bukan salinan data produksi.

`origin/main` yang diaudit menjalankan workflow deploy otomatis setelah CI push ke `main` sukses, serta workflow manual untuk operasi terkontrol/rollback. Script deployment memblokir jalur otomatis bila migration atau startup-execution surface berubah dan mengarahkan perubahan tersebut ke jalur manual yang memerlukan review operator. Fase A menambahkan migrasi 021 dan Fase B/C menambahkan 022/023, sehingga setiap branch mengubah schema. Jalur auto-deploy menahan perubahan migration/startup surface; merge tetap NO-GO tanpa persetujuan operator dan prosedur deployment/rollback yang ditinjau.

## Arsitektur dan alur runtime

1. `src/cli.js` memuat konfigurasi lingkungan, migrasi bernomor, repository, layanan akun/model, provider, dispatcher, dan scheduler. Env scheduler dan integrasi memerlukan aktivasi eksplisit; kredensial saja tidak mengaktifkannya.
2. `src/configuration.js` memakai `integration_config` serta histori versi untuk pasangan akun Tebar dan model OpenRouter. Setelah bootstrap, baris database yang diinisialisasi menjadi sumber konfigurasi runtime; secrets tetap di environment.
3. `src/repository.js` membaca interval/hashtag/target/sesi dari `settings.settings_json`, serta facts NDI dari `settings.business_knowledge_json` dan `business_knowledge_approved`. Knowledge migrasi belum disetujui sampai admin menyimpan/meninjau ulang. `service_facts` tidak dipakai sebagai fakta generation.
4. Claim slot terjadi di dalam transaksi database. CTA, category/style IDs, dan snapshot kontennya terikat pada slot saat claim; slot yang sudah disiapkan mempertahankan URL, strategi, payload, dan idempotency key saat retry/restart.
5. `src/content-context.js` hanya membentuk konteks pillar `ndi`, memakai layanan dan batas klaim dari knowledge database, serta mengecualikan fakta/caption histori non-NDI. Kategori dan style dari slot memberi arahan kreatif saja, bukan fakta. `src/content-service.js` membuat prompt Bahasa Indonesia, menambahkan hashtag dan CTA, menjalankan deterministic validation serta audit semantik kedua, dan memakai retry generation yang sudah ada.
6. `src/dispatcher.js` memeriksa payload final terhadap CTA snapshot dan validasi NDI sebelum menyimpan/mengirim ke Tebar. Payload/idempotency key disimpan sebelum request. Timeout tetap `unknown`; slot unsettled menghalangi kiriman berikutnya sampai rekonsiliasi.
7. Tebar webhook/status dan resolusi manual memperbarui slot melalui transaksi/audit; notifikasi Telegram menggunakan bahasa NDI. Provider test memakai mock.
8. Migration 022 menambah 8 default category dan 7 style secara idempotent. `src/content-strategy.js` memilih category/style uniform dan independen. Repository mengikat JSON/IDs ke slot secara transaksional dan mengurutkan rotation hanya dari target Threads `published_at` provider-confirmed. Data kosong, timestamp hilang, atau timestamp seri menahan publish.
9. Proposal kategori AI memakai worker/scheduler terpisah dari publishing, default OFF, interval 30–365 hari, dan satu request maksimal 400 token. Kegagalan dicatat tanpa masuk ke siklus dispatch; kategori tetap pending sampai keputusan admin.
10. Manual website sync diekspos sebagai GET status dan POST eksplisit admin pada `/api/website-sync`; website tidak memiliki crawler/job otomatis. Origin dikunci ke `https://nusadataindonesia.com/`. Fetch DNS IPv4 publik dipin ke HTTPS, redirects ditolak, timeout/body/content-type dibatasi, dan parser hanya menyimpan usulan layanan sebagai teks tidak tepercaya.
11. Website changes disimpan per-item dengan source title/URL, fetch time, knowledge version, nilai dasar/target dan audit. Approval membandingkan versi; konflik tidak menulis fakta baru. Failed fetch/parse mencatat kegagalan tanpa perubahan knowledge aktif.

## Inventaris legacy dan tindakan Fase A

| Area / jejak pencarian | Perilaku setelah perubahan | Keputusan | Bukti utama |
|---|---|---|---|
| Brand, voice, audience, arah konten, guardrail toko di settings/prompt | Knowledge NDI tervalidasi dan DB-backed; fakta identitas/Ticketing tetap mengikuti sumber owner; layanan, klaim yang disetujui/dilarang, panduan, hashtag, dan CTA dikelola admin | **Ganti** | `src/business-knowledge.js`, `src/ndi-settings.js`, `src/repository.js`, `/api/knowledge`, UI Konten |
| `gameWhitelist`, `priceMode`, `trackedLinks.topup/account`, kata kunci/angka game, prompt harga/stok | Field lama dikeluarkan dari settings runtime dan UI; validator NDI menolak game/top-up, link selain CTA, informasi pribadi, klaim angka/harga, hashtag asing, dan CTA yang salah | **Ganti/hapus dari jalur aktif** | `migrations/021_ndi_business_knowledge.sql`, `src/content-context.js`, `src/content-validation.js`, `src/policy.js`, `public/index.html`, `public/app.js` |
| `APPROVED_CTA_HOSTS` dan wiring Compose/deploy | Tidak menjadi kebijakan CTA; URL harus HTTPS aman tetapi host bebas; aplikasi tidak mengambil URL | **Hapus** | `src/business-knowledge.js`, `src/config.js`, `compose.yaml`, `scripts/deploy-homelab.sh`, `docs/DEPLOYMENT.md` |
| `service_facts` top-up/akun | Migrasi mempertahankan baris dan nilai `active` tanpa perubahan; runtime NDI selalu menerima `facts: []` sehingga fakta tersebut tidak masuk prompt | **Pertahankan termasuk state; keluarkan dari runtime NDI** | `src/repository.js`, `src/content-context.js`, tes migration upgrade |
| Tabel/kolom `templates` dan template `brand/topup/account` | Schema dan baris tetap ada untuk riwayat/rollback; route template, helper repository CRUD, panel, dan aksi aktif dihapus | **Pertahankan schema/data historis, hapus API/UI aktif** | `migrations/004_templates.sql` tidak diubah; `src/http/routes/templates.js` dihapus; `src/server.js`, `src/repository.js`, UI |
| Learning rules/candidates dan scope historis | Route/panel aktif dihapus; retrieval/injection Learning tidak dijalankan untuk pillar `ndi`; tabel dan migration learning tetap ada. Capture/retention legacy masih dikonfigurasi untuk kompatibilitas dan bukan sumber prompt NDI | **Pertahankan histori/kompatibilitas, tutup jalur aktif** | `src/server.js`, `src/content-service.js`, `src/learning.js`, `src/config.js`, migration historis |
| Slot, caption, pillar historis, webhook, audit, session, integration history, release state | Tidak ditulis ulang/dihapus oleh 021; histori lama tetap berisi istilah yang benar pada saat dibuat; slot legacy tanpa hash/CTA NDI gagal pada validasi baru | **Pertahankan** | `migrations/021_ndi_business_knowledge.sql`, `src/repository.js`, `src/dispatcher.js`, migration MySQL test |
| Telegram dan error/empty-state | Pesan baru memakai Nusa Data Indonesia; slot lama tetap menampilkan caption/provider evidence yang tersimpan | **Ganti copy baru; pertahankan histori** | `src/telegram-format.js`, UI, `test/telegram-format.test.js` |
| Migration, Docker Compose, CI, deploy dan rollback | Compose topology/volume/provider deployment tidak diganti; CI ditambah schema dan tes migration 021; tidak ada registry/host layanan wajib baru | **Pertahankan; tambah quality gate** | `.github/workflows/ci.yml`, `compose.yaml`, `scripts/deploy-homelab.sh`, `Dockerfile` |
| Dokumen lama seperti audit bisnis historis dan migration 001–020 | Istilah legacy dipertahankan bila merupakan bukti sejarah atau schema kompatibilitas; dokumen operasi aktif diperbarui | **Historical only** | `docs/REQUIREMENTS.md`, audit lama, migration 001–020; README/Architecture/Operations/Deployment/Testing diperbarui |

Pencarian case-insensitive pasca-perubahan masih menemukan istilah game/top-up pada prompt sebagai larangan, regex validator yang menolak kontaminasi, arsip migration/test berisi fixture legacy, skema/migrasi lama, modul learning yang dipertahankan, dan dokumen audit historis. Hasil tersebut bukan label aktif UI atau konteks generation. UI aktif tidak menyediakan kontrol game, harga/stok, template lama, atau learning; tes route/UI dan prompt memeriksa batas tersebut.

## Pemetaan konfigurasi/data lama

| Field/data | Runtime baru | Retensi dan risiko |
|---|---|---|
| `settings_json.brand/guardrails/gameWhitelist/priceMode/trackedLinks` | Tidak digunakan; field tersebut dihapus dari settings aktif | Salinan lengkap dipertahankan pada `legacy_business_settings_json`; `settings_json.schedule`, identitas akun, sesi dan riwayat interval dipertahankan; hashtag lama direset agar tidak ikut konten NDI |
| `knowledge_json` lama | Tidak digunakan | Salinan lengkap masuk `legacy_business_knowledge_json`; kolom lama dikosongkan |
| `business_knowledge_json` baru | Identitas NDI, deskripsi, visi/misi, layanan, status Ticketing, batas klaim, panduan, dan CTA | Diinisialisasi dengan fakta owner, `business_knowledge_approved=FALSE`; admin harus review sebelum automation bisa diaktifkan |
| CTA slot | `slots.cta_url` berisi URL ketika slot diklaim untuk generation | Edit CTA berikutnya hanya untuk slot baru; slot lama tidak dimutasi. Legacy ready slot tanpa bukti NDI tidak lolos validasi final |
| `service_facts`, `templates`, learning tables | Tidak dipakai sebagai sumber generation NDI; tidak ada route UI baru | Data/tabel disimpan untuk audit/rollback; tidak ada `DROP`, `DELETE`, `TRUNCATE`, atau reset tabel |
| `automation_enabled`, automation session, account/model config, credentials, status slot | Tidak ditulis oleh migration 021 | Migration test memeriksa flag ON, sesi, integration version/credential placeholder, dan status slot tidak berubah; kondisi produksi tetap perlu operator verifikasi |

## Keamanan, integrasi, retry, unknown, dan rollback

- API knowledge/settings berada di middleware autentikasi, same-origin, CSRF, validasi input, dan audit admin yang sudah ada. Endpoint tulis fakta lama mengembalikan `410 LEGACY_FACTS_ARCHIVED`; route template/learning lama tidak didaftarkan.
- CTA menerima HTTPS valid ke hostname mana pun, menolak credentials/control characters/encoding berbahaya, dan tidak di-fetch. Domain dashboard tetap terpisah dari CTA. Website sync hanya berjalan pada POST admin terautentikasi di origin resmi tetap; hasilnya usulan per-item dan tidak mengubah knowledge sebelum review. Resolver mengharuskan semua jawaban DNS IPv4 lolos allow policy lalu mem-pin satu alamat, memverifikasi hostname TLS, dan menolak redirect. Daftar blokir konservatif juga menolak sebagian ruang `192.0.0.0/24` yang memiliki pengecualian reachable; akibatnya beberapa origin publik dapat ditolak (false negative), tetapi tidak dibuka ke alamat private.
- `TRUST_PROXY`, cookie session, login throttle, admin audit, Tebar webhook HMAC/deduplikasi, OpenRouter, Tebar, Telegram, idempotency, cadence, retry, dan manual unknown reconciliation tidak diganti.
- Migrations 021–023 additive/restartable pada MySQL 8.4: 021 menambah knowledge/arsip/CTA snapshot, 022 strategy/proposal/style snapshots/provider timestamps, dan 023 website-sync run/proposal versioning; tidak ada DROP/DELETE/TRUNCATE. MySQL DDL dapat implicit commit. Disposable test menerapkan legacy 001–020, menanam fixtures sanitized, upgrade ke 023, rerun migration, lalu memeriksa data, state dan review gates. Facts/slots/settings/sessions/integration config/audit tetap dipertahankan.
- Rollback image bukan rollback data. Versi lama tidak memahami kolom knowledge baru; versi baru mengarsipkan dan menghapus key lama dari settings aktif serta mengosongkan `knowledge_json`, sementara fakta legacy tetap utuh. Restore nilai aktif lama dari kolom arsip memerlukan prosedur operator yang diuji. Karena itu kompatibilitas semantik rollback belum dibuktikan hanya dari adanya kolom additive. Perlakukan ini sebagai risiko review operator; jangan merge/deploy sampai strategi rollback/slot produksi disetujui.
- State database produksi, slot `publishing/unknown`, dan apakah ada scheduler aktif tidak dapat dipastikan dari repository. Deployment harus meninjau state efektif dan menjadwalkan approval ulang knowledge; migration tidak mengubah `automation_enabled` dan posting tertahan oleh knowledge yang belum disetujui.

## Bukti pengujian saat audit akhir

| Pemeriksaan | Hasil lokal |
|---|---|
| Full unit/integration suite | PASS: `npm test` 485 total, 460 pass, 0 fail, 25 skip |
| Deployment shell suite | PASS: 30/30 pada sandbox tanpa network; semua filesystem output dibatasi ke scratch |
| `npm run test:integration` | PASS: 94/94 pada MySQL disposable; MySQL configuration check terpisah PASS 1/1 |
| Migrations 021–023 | PASS: `test/ndi-migration.mysql.integration.test.js` 1/1 on disposable MySQL; upgrade/rerun, legacy state, strategy gate, website proposal/version/audit/conflict |
| Publication resolution MySQL | PASS: 10/10; restart, concurrency, audit, account-switch blockers, no blind replay |
| Lint/typecheck/check/Compose | PASS: `npm run lint`, `npm run typecheck`, `npm run check`, Compose config dengan env test-only |
| Browser E2E NDI | PASS: 4/4 dengan Chromium lokal dan MySQL disposable pada loopback; scheduler/provider integrations OFF |
| Docker image build | PASS: production Dockerfile built as local verification tag `bot-ndi-phase-c-verify` |
| Compose / GitHub CI | Compose config PASS dengan env test-only. Pengguna menyetujui push trigger `main` dan branch B/C; pull-request filter tetap `main`, deployment tetap hanya menerima CI sukses di `main`. PR #4 run `44317203508` dan PR #5 run `44318008837` PASS pada source commit yang tercatat di checkpoint. Runner memberi satu peringatan Node 20 dan satu notice migrasi `ubuntu-latest`, keduanya non-blocking. `actionlint` tidak tersedia. |

Semua DB tests menggunakan database disposable dan tidak memakai volume produksi. Tidak ada provider nyata, Threads post, scheduler produksi, atau database produksi yang disentuh. Isi production DB dan rollback tetap tidak diketahui. CI pada source revisions lulus; merge/deployment tetap NO-GO sampai review operator R-055/R-068 dan persetujuan merge terpisah tersedia.
