# Rencana dan Hasil Implementasi Bot NDI

Dokumen ini mengikuti `docs/BOT-NDI-MASTER-CODEX-PROMPT.md`. Fase A berada di PR #3. Fase B dan C dipecah menjadi PR bertingkat: B menarget branch A; C menarget branch B. Tidak ada merge atau deployment dalam pekerjaan ini.

## Fase A — Identitas bisnis dan pembersihan logika

### Hasil

- Knowledge NDI tersimpan di MySQL dan harus disetujui admin. Prompt, context, validator, notifikasi dan UI menggunakan identitas Nusa Data Indonesia; konten historis dan data game/top-up tidak masuk generation aktif.
- Satu field **Website Resmi / CTA URL** menerima URL HTTPS valid, terpisah dari origin dashboard dan website sync. CTA disimpan per-slot saat claim; payload final dan retry memakai snapshot yang sama.
- Migrasi 021 additive mengarsipkan data legacy sebelum membersihkan konfigurasi aktif, menjaga slot, session, integrasi, audit, facts dan status automation. Unknown tidak di-replay otomatis; slot lama yang tidak memiliki bukti NDI gagal tertutup.
- PR #3 masih terbuka dan belum merge.

## Fase B — Mesin strategi konten

### Implementasi

- Migration 022 membuat schema kategori, style, proposal, konfigurasi strategi dan waktu publish provider. Delapan kategori dan tujuh gaya default dimasukkan idempotent tanpa menimpa perubahan admin.
- CRUD, status aktif/nonaktif, archive, histori, dan audit menggunakan route admin. Strategi harus di-review dan diaktifkan eksplisit saat automation dijeda. Migration tidak mengaktifkan strategi, automation, atau scheduler.
- Selector kategori dan style uniform serta independen. Kategori provider-confirmed terakhir dikecualikan bila ada pilihan lain. State hanya maju setelah Tebar mengonfirmasi target Threads `published` dengan timestamp valid; timestamp hilang/seri memblokir generasi dengan alasan uncertain. Tidak menggunakan waktu lokal sebagai pengganti bukti provider.
- Kategori/style dan instruksi kreatifnya disnapshot per logical slot dalam transaksi. Retry/restart mempertahankan snapshot. Guardrail fakta tetap berasal dari knowledge NDI yang disetujui; kategori/gaya tidak dapat menambah klaim bisnis.
- Proposal kategori AI disimpan terpisah; admin menyetujui/menolak secara eksplisit. Job terpisah dari scheduler publishing, default OFF, interval 30–365 hari, tidak berjalan segera saat start, satu panggilan maksimum 400 token per run, error terisolasi.

### File utama

`migrations/022_content_strategy.sql`, `src/content-strategy.js`, `src/category-proposals.js`, `src/repository.js`, `src/dispatcher.js`, `src/content-context.js`, `src/content-service.js`, `src/http/routes/content-strategy.js`, `public/app.js`, `public/index.html`, serta unit/DB tests terkait.

## Fase C — Sync knowledge manual dari website

### Implementasi

- Migration 023 menambah run/proposal dengan versioning dan provenance. Sync hanya dimulai lewat tombol/API POST admin yang melewati session, same-origin, CSRF dan audit; tidak ada timer/crawler.
- Fetch dibatasi ke origin tetap `https://nusadataindonesia.com/`, terpisah dari CTA URL. Klien memeriksa DNS publik, mem-pin alamat yang telah lolos, memverifikasi TLS/hostname, menolak redirect, dan membatasi timeout, ukuran, jenis konten, serta parsing HTML. Konten web disimpan sebagai input tidak tepercaya dan tidak dikirim ke AI generation.
- Diff dibuat per layanan. Add/edit/remove menjadi proposal independen dengan versi knowledge saat fetch. Admin menyetujui/menolak per-item. Approval menggunakan pemeriksaan versi; perubahan manual lebih baru menghasilkan conflict dan tidak ditimpa. Fetch/parse failure tidak memodifikasi knowledge aktif atau posting.

### File utama

`migrations/023_manual_website_knowledge_sync.sql`, `src/website-knowledge-sync.js`, `src/repository.js`, `src/http/routes/website-sync.js`, `src/server.js`, `src/cli.js`, dashboard `public/app.js`/`public/index.html`, serta unit/route/MySQL tests terkait.

## Verifikasi

- `npm test`: 485 total, 460 pass, 0 fail, 25 skipped; DB-backed tests are listed separately.
- Deployment shell tests pass within `npm test`. MySQL 8.4 migration 021–023: 1/1 pass; publication-resolution MySQL: 10/10 pass. `npm run test:integration`: 94 pass; MySQL config check: 1 pass.
- `npm run lint`, `npm run typecheck`, `npm run check`, Compose config validation: PASS.
- Browser E2E: **PASS 4/4** on local Chromium and disposable MySQL; integrations and scheduler disabled.
- Docker build dan Compose validation: **PASS**. `actionlint` tidak tersedia. GitHub CI B/C menunggu PR dan belum ada hasil.
- Tidak menjalankan provider nyata, posting Threads, scheduler, atau migrasi pada produksi. Detail per-test ada di `docs/ndi-requirements-traceability.md`.

## Migrasi, kompatibilitas, dan rollout

Migrations 022/023 hanya menambah tabel/kolom/indeks dan nilai default; tidak ada `DROP`, `DELETE`, `TRUNCATE`, reset database, atau perubahan named volume. Migration integration test menjalankan upgrade dan rerun pada schema disposable. DDL MySQL dapat commit implisit. Rollback binary tidak mengembalikan DDL, knowledge, strategi, proposal, atau audit; image lama mungkin tidak mengenali struktur baru. Karena itu R-068 masih **BLOCKED** sampai operator meninjau backup/restore dan prosedur rollback yang sesuai schema akhir. R-055 juga menunggu pemeriksaan nilai DB efektif produksi. Tidak ada koneksi produksi.

Fase B membutuhkan PR Phase A lebih dahulu; Fase C bergantung pada struktur dan guardrail B. Tebar harus mengembalikan `published_at` yang sah agar rotasi kategori berlanjut; jika provider tidak menyediakannya, aplikasi berhenti fail-closed. Belum ada verifikasi langsung terhadap capability provider di akun NDI.

## GO / NO-GO

- **GO untuk review PR bertingkat:** source B/C, regression tests dan docs tersedia. Status pembukaan PR dilaporkan setelah GitHub API mengonfirmasi.
- **NO-GO merge/deployment saat ini:** CI Phase B/C belum berjalan dan review state produksi/rollback masih BLOCKED. Merge ke `main` berpotensi auto-deploy dan dilarang tanpa persetujuan eksplisit.
