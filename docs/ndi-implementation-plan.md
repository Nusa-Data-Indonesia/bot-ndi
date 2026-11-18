# Rencana dan Hasil Implementasi Bot NDI

Dokumen ini mengikuti `docs/BOT-NDI-MASTER-CODEX-PROMPT.md`. Fase A berada di PR #3, Fase B dikerjakan pada branch ini, dan Fase C ditunda ke branch berikutnya yang bertumpu di atas B. Tidak ada merge atau deployment dalam pekerjaan ini.

## Fase A — Identitas bisnis dan pembersihan logika

### Hasil baseline

- Knowledge NDI disimpan di MySQL dan perlu disetujui admin. Prompt, context, validator, notifikasi, dan UI memakai identitas Nusa Data Indonesia; konten historis dan data game/top-up tidak masuk generation aktif.
- Field **Website Resmi / CTA URL** menerima URL HTTPS valid. CTA disimpan per slot saat claim; payload final dan retry memakai snapshot yang sama.
- Migrasi 021 additive mengarsipkan data legacy dan mempertahankan slot, session, integrasi, audit, facts, serta status automation. Unknown tidak di-replay otomatis; slot lama tanpa bukti NDI gagal tertutup.
- PR #3 masih terbuka dan belum merge.

## Fase B — Mesin strategi konten

### Implementasi

- Migration 022 membuat schema kategori, style, proposal, konfigurasi strategi dan waktu publish provider. Delapan kategori dan tujuh gaya default dimasukkan idempotent tanpa menimpa perubahan admin.
- CRUD, status aktif/nonaktif, archive, histori, dan audit menggunakan route admin. Strategi harus di-review dan diaktifkan eksplisit saat automation dijeda. Migration tidak mengaktifkan strategi, automation, atau scheduler.
- Selector kategori dan style uniform serta independen. Kategori provider-confirmed terakhir dikecualikan jika ada pilihan lain. State hanya maju setelah Tebar mengonfirmasi target Threads `published` dengan timestamp valid; timestamp hilang/seri memblokir generation secara fail-closed. Tidak menggunakan waktu lokal sebagai pengganti bukti provider.
- Kategori/style dan instruksi kreatifnya disnapshot per logical slot dalam transaksi. Retry/restart mempertahankan snapshot. Guardrail fakta tetap berasal dari knowledge NDI yang disetujui; kategori/gaya tidak dapat menambah klaim bisnis.
- Proposal kategori AI disimpan terpisah; admin menyetujui/menolak secara eksplisit. Job terpisah dari scheduler publishing, default OFF, interval 30–365 hari, tidak berjalan segera saat start, satu panggilan maksimum 400 token per run, dan error terisolasi.

### File utama

`migrations/022_content_strategy.sql`, `src/content-strategy.js`, `src/category-proposals.js`, `src/repository.js`, `src/dispatcher.js`, `src/content-context.js`, `src/content-service.js`, `src/http/routes/content-strategy.js`, `public/app.js`, `public/index.html`, serta unit/DB tests terkait.

## Fase C — Sinkronisasi knowledge manual dari Website Resmi (belum dikerjakan)

Fase C berikutnya akan menambahkan sync admin-manual dari origin resmi tetap, fetch SSRF-safe yang bounded, proposal perubahan per item dengan provenance/version/audit, keputusan admin eksplisit, perlindungan konflik terhadap perubahan knowledge yang lebih baru, dan test failure-preservation. Perubahan ini tidak ada pada branch B.

Requirement R-057–R-063 dan T-23–T-28 tetap TODO/not yet implemented pada traceability branch B.

## Verifikasi branch B

`npm test`: 475 total, 450 passed, 0 failed, 25 skipped. `npm run test:integration`: 94/94, MySQL configuration 1/1; migration 021–022: 1/1 dan publication-resolution MySQL: 10/10 pada database disposable. Browser E2E: 3/3. Lint, typecheck, syntax check, Compose validation, dan Docker build PASS. GitHub CI menunggu PR; `actionlint` tidak tersedia.

- Tidak menjalankan provider nyata, posting Threads, scheduler produksi, migrasi produksi, merge, deployment, atau menghapus volume Docker.
- R-055 dan R-068 tetap BLOCKED untuk review nilai database produksi dan prosedur backup/restore/rollback oleh operator.
- Tebar harus mengembalikan `published_at` yang valid agar rotasi kategori berlanjut; jika timestamp tidak tersedia atau ambigu, aplikasi fail closed. Kemampuan ini belum diverifikasi pada akun NDI nyata.

## Migrasi, kompatibilitas, dan rollout

Migration 022 hanya menambah tabel/kolom/indeks dan default; tidak ada `DROP`, `DELETE`, `TRUNCATE`, reset database, atau perubahan named volume. Migration integration test menggunakan schema disposable dan memeriksa upgrade/rerun. DDL MySQL dapat commit implisit. Rollback binary tidak membatalkan DDL atau data strategi; image lama mungkin tidak mengenali struktur baru. R-068 tetap BLOCKED sampai operator meninjau backup/restore dan prosedur rollback yang sesuai schema. R-055 menunggu pemeriksaan nilai DB efektif produksi. Tidak ada koneksi produksi.

## GO / NO-GO

- **GO untuk review PR Phase B** setelah branch diuji dan PR dibuat ke branch A.
- **NO-GO merge/deployment** sampai CI B berjalan dan gate operator R-055/R-068 ditinjau. Merge ke `main` dapat memicu auto-deployment dan dilarang tanpa persetujuan eksplisit.
