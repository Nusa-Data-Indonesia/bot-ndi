# Rencana dan Hasil Implementasi Bot NDI

Rencana ini mengikuti `docs/BOT-NDI-MASTER-CODEX-PROMPT.md`. Branch kerja `codex/ndi-phase-a` dibatasi pada Fase A. Fase B dan C tetap pekerjaan fase berikutnya dan memerlukan review Fase A serta persetujuan operator terpisah.

## Fase A — Identitas bisnis dan pembersihan logika

### Hasil implementasi

- Knowledge NDI disimpan dalam kolom database `business_knowledge_json`, berstatus belum disetujui sampai admin meninjau dan menyimpan; sumber mencakup identitas, positioning, visi/misi, layanan, audience, status NDI Ticketing, panduan konten, klaim yang disetujui/dilarang, dan CTA.
- Dashboard mengedit satu **Website Resmi / CTA URL**. Default `https://nusadataindonesia.com`; menerima URL HTTPS valid tanpa allowlist hostname dan tidak memulai HTTP request. Dashboard dan CTA tetap terpisah.
- Slot menyimpan CTA ketika klaim generation dalam transaksi. Retry/replay memakai snapshot; caption akhir wajib memiliki ajakan NDI dan URL persis sebagai baris terakhir, lolos validasi NDI dan batas 500 karakter sebelum Tebar.
- Prompt, audit semantik, context, validator, hashtag, notifikasi, onboarding, error/empty states, dan UI aktif diubah ke NDI. Data facts historis tidak masuk prompt. Validator masih heuristik; audit model independen menambah pemeriksaan, bukan jaminan kebenaran penuh.
- Skenario dengan penanda hipotetis harus diawali `Ilustrasi:`; validator deterministik menolak penanda hipotetis tanpa awalan itu. Sampai mesin kategori/gaya Fase B tersedia, dashboard menunjukkan blocker dan API aktivasi/dispatcher fail closed sebelum slot baru diklaim; rekonsiliasi `unknown` tetap berjalan.
- Field game/top-up/harga/stok/link lama tidak dipakai oleh generation/publish baru. Baris dan state `service_facts` dipertahankan utuh tetapi tidak dibaca oleh runtime NDI; template/learning schema dipertahankan sebagai histori, sedangkan route/panel dan template CRUD lama dihapus dari aplikasi ini.
- Retry generation yang ada, idempotency, scheduler controls/cadence, auth/session/CSRF/audit, Tebar/OpenRouter/Telegram, monitoring, status `unknown`, dan manual reconciliation dipertahankan. CI mendapat test migration 021 terisolasi.

### Dampak file utama

| Perubahan | File/area |
|---|---|
| Model bisnis, validasi setting/CTA | `src/business-knowledge.js` (baru), `src/ndi-settings.js` (baru), `src/policy.js`, `src/config.js` |
| Validasi ilustrasi dan readiness lintas fase | `src/content-validation.js`, `src/content-strategy-readiness.js` (baru), `src/http/routes/automation.js`, `src/http/routes/dashboard.js`, `src/dispatcher.js`, `public/app.js` |
| Prompt/context/validasi/publish guard | `src/content-context.js`, `src/content-service.js`, `src/content-safety.js`, `src/content-validation.js`, `src/dispatcher.js`, `src/telegram-format.js` |
| Penyimpanan, approval, snapshot, route | `src/repository.js`, `src/http/routes/dashboard.js`, `src/http/routes/automation.js`, `src/server.js`; route template/learning lama dihapus |
| UI | `public/index.html`, `public/app.js`; layout dashboard dipertahankan |
| Database/CI | `migrations/021_ndi_business_knowledge.sql` (baru), `.github/workflows/ci.yml`, `.env.example`, `compose.yaml`, `scripts/deploy-homelab.sh` |
| Tes | content/config/policy/dispatcher/publication-fence/server/route/UI dan fixtures DB; `test/ndi-migration.mysql.integration.test.js` (baru) |
| Browser E2E | `e2e/ndi.browser.e2e.js`, pengganti tes browser Learning Center yang tidak lagi menjadi UI aktif |
| Dokumentasi | `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/DEPLOYMENT.md`, `docs/DYNAMIC-CONFIGURATION.md`, `docs/TESTING.md`, audit/RTM/checkpoint ini |

### Perubahan data dan kompatibilitas

- Migration 021 menambahkan kolom knowledge NDI/approval/archive dan snapshot CTA secara kondisional; tidak menghapus kolom/tabel, baris service facts, template, audit, session, release, atau slot.
- Migration menyalin seluruh `settings_json` dan `knowledge_json` lama ke kolom arsip, mengeluarkan key bisnis lama dari konfigurasi runtime, mengosongkan knowledge lama, menginisialisasi knowledge NDI tanpa approval, mereset hashtag/onboarding untuk review ulang, dan membiarkan tabel serta state `service_facts` tetap utuh. `automation_enabled`, sesi, target/integration config, credentials, jadwal dan status slot tidak direset.
- Slot legacy `ready` tanpa CTA/safety snapshot NDI tidak bisa melewati final guard; `publishing`/`unknown` dipertahankan untuk rekonsiliasi. Sampai category/style engine Fase B tersedia, readiness gate Fase A menahan aktivasi dan dispatch secara eksplisit, tanpa mengubah flag scheduler/automation tersimpan. Tes memeriksa data dan status pada MySQL 8.4 disposable.
- DDL MySQL dapat commit implisit. Rollback binary bukan rollback schema atau business JSON; release lama mungkin tidak memahami knowledge NDI dan API aktif yang dihapus. Karena itu strategy compatibility rollback masih memerlukan review operasional sebelum merge/deploy. Jangan mengandalkan database produksi yang belum diperiksa.

### Verifikasi dan gate A

- `npm test`: **PASS**, 415 pass, 0 fail, 25 skipped (database tests run separately on disposable schemas), total 440.
- `npm run test:integration` pada MySQL 8.4 disposable: **PASS**, 93 pass, 0 fail, 0 skip.
- Migration tests: **PASS** — upgrade 001–020→021, migration 018 recovery, learning upgrade 011→021, publication migration 020, publication fence, dan legacy publication resolution; masing-masing satu skenario database.
- Publication resolution MySQL: **PASS**, 10/10 (restart, concurrency, audit, account-switch blockers, no blind replay).
- Browser E2E `npm run test:ndi:browser`: **PASS**, 3/3 pada Chromium lokal dan schema disposable; login, readiness gate, WCAG 2.2 AA, dan unknown recovery UI.
- `npm run lint`, `npm run typecheck`, `npm run check`, `bash -n scripts/deploy-homelab.sh`, `git diff --check`: **PASS**.
- `npm audit --audit-level=high`: **PASS**, 0 vulnerabilities. Compose validation dan Docker runtime build lokal: **PASS**.
- Tidak ada provider nyata, publikasi Threads, aktivasi scheduler, atau database produksi dalam pengujian. GitHub CI belum berjalan; actionlint tidak tersedia.
- **GO untuk review PR** setelah final diff/SSOT review. **NO-GO merge/migration/deployment**: state DB/slot produksi belum diperiksa, rollback image/config memerlukan review dan prosedur operator, dan engine strategi kategori/gaya Fase B belum tersedia. Readiness gate menjaga automation tetap tertahan.

## Fase B — Mesin strategi konten (PR berikutnya, belum diimplementasikan)

- Seed delapan kategori dan tujuh style template secara idempotent; CRUD admin dengan status/archive dan histori/audit.
- Pemilihan kategori/style uniform dan independen; rotasi hanya memakai kategori provider-confirmed; satu kategori aktif boleh berulang, nol kategori/style fail-closed. Binding pilihan ke logical slot menjaga restart/retry/concurrency.
- Proposal kategori AI terpisah dari kategori aktif; approval/reject/audit admin dan job configurable dengan default OFF, tanpa mengubah scheduler posting.
- Verifikasi provider publication ordering Tebar, termasuk delayed/out-of-order webhook. Jika urutan otoritatif tidak tersedia, dokumentasikan fallback konservatif yang diuji sebelum posting diaktifkan.
- Test gate: T-09–T-22; tidak dimulai sebelum operator review Fase A.

## Fase C — Sync knowledge manual dari website (PR berikutnya, belum diimplementasikan)

- Sinkronisasi hanya dimulai tombol admin terautentikasi ke origin resmi NDI, terpisah dari CTA bebas.
- Fetch bounded dan aman, per-item diff/provenance/version, approval atau rejection independen, audit, dan konflik terhadap fakta manual lebih baru.
- Proteksi SSRF/private redirect/DNS rebinding/size/HTML/prompt injection; tidak ada cron, autonomous crawler, atau auto-approval.
- Test gate: T-23–T-28; tidak dimulai sebelum Fase B direview.

## Deployment, rollback, dan kriteria GO/NO-GO

1. Gunakan satu PR reviewable untuk Fase A menuju `main`; jangan menggabungkan fase. PR bukan izin merge.
2. Sebelum merge, cek hasil GitHub CI dan pastikan prosedur auto-deploy yang sebenarnya dipakai operator. Merge diperlakukan sebagai tindakan produksi sesuai SSOT walaupun workflow pada branch dasar menampilkan trigger manual.
3. Sebelum deployment, operator harus meninjau database state efektif dan slot `ready/publishing/unknown`; knowledge migration belum disetujui dan automation tidak dapat diaktifkan sampai admin meninjau NDI knowledge.
4. Buat backup MySQL manual sesuai prosedur operator; Codex tidak membuat backup terjadwal, menjalankan migration produksi, mengubah volume, atau memulihkan produksi.
5. Review rollback dengan database pada schema setelah 021; gambar lama tidak otomatis membaca schema/arsip baru, dan config lama telah dikeluarkan dari runtime JSON aktif. Jangan rollback app image tanpa prosedur yang diuji.
6. **GO untuk review PR lokal:** source/tests/docs Fase A siap ditinjau, CI GitHub masih menunggu. **NO-GO merge/deploy:** GitHub CI dan production state/rollback masih memerlukan operator review. Tidak ada real post, scheduler activation, merge, atau deploy.
