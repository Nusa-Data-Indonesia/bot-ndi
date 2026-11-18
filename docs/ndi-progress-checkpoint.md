# Checkpoint Pekerjaan Bot NDI

Diperbarui: 2026-11-18
Branch kerja: `codex/ndi-phase-a`, berbasis `origin/main` (`a9858d2`)
Cakupan: implementasi Fase A saja; Fase B/C tetap pekerjaan berikutnya.

## Status

Implementasi Fase A dikomit sebagai `ddcbfb0`, dokumentasi awal sebagai `505cebf`, dan perbaikan CI sebagai `37d92b3`; PR #3 terbuka dari `codex/ndi-phase-a` ke `main`. GitHub run `44272321299` awal gagal pada database integration (92/93). Penyebabnya: replay migration 006 menambah interval legacy di atas interval kanonik dan test database meninggalkan knowledge/CTA yang telah diubah. Perbaikan migration/test lolos urutan CI lokal pada MySQL disposable; GitHub rerun `44277306178` untuk commit `37d92b3` berstatus PASS (`Lint, test, and build`). Tidak ada merge, deployment, migrasi production, aktivasi scheduler, atau posting Threads.

## Requirement dan audit

- SSOT `docs/BOT-NDI-MASTER-CODEX-PROMPT.md` dibaca lengkap, 377 baris, dalam rentang tidak tumpang-tindih. Pembacaan ulang akhir dilakukan sebelum penyelesaian.
- Requirements Traceability Matrix memuat R-001–R-073 dan T-01–T-30. Hasil terakhir: 46 DONE, R-045/R-053 IN_PROGRESS karena binding kategori/gaya adalah dependency Fase B; R-055/R-068 BLOCKED hanya untuk pemeriksaan state/rollback produksi yang tidak boleh dilakukan tanpa operator. Sisa 23 TODO adalah Fase B/C.
- Audit arsitektur/runtime, data, dashboard/API, knowledge/prompt, scheduler/providers/retry/unknown, auth/session/audit, migrations, Compose/CI/deploy/rollback dicatat di `docs/ndi-codebase-audit.md`.
- Rencana Fase A/B/C dan risiko kompatibilitas tersedia di `docs/ndi-implementation-plan.md`.
- `origin/main` memiliki deployment otomatis setelah CI push ke `main` sukses. Guard deploy menahan perubahan migration/startup surface dari jalur otomatis; migrasi 021 perlu jalur manual setelah review/persetujuan operator.

## Implementasi Fase A

- Migrasi identitas dan aturan aktif ke Nusa Data Indonesia; knowledge bisnis NDI sekarang tersimpan di DB, harus ditinjau dan disetujui admin sebelum automation bisa diaktifkan.
- Hilangkan UI/API/prompt aktif yang khusus Kedai Merzz/game/top-up/harga/stok. Historical schema/data dipertahankan; `service_facts` tetap utuh termasuk active state dan tidak dibaca ke konteks generation NDI.
- Tambah migrasi additive/restartable 021 untuk knowledge baru, snapshot CTA, dan salinan arsip konfigurasi lama. Tidak ada DROP/DELETE/TRUNCATE; admin, audit, session, integrasi, kredensial, automation flag, jadwal, fakta, template, dan slot historis dipertahankan.
- CTA memakai URL HTTPS yang divalidasi tanpa allowlist host atau fetch; CTA di-snapshot per slot, diuji lagi pada payload final sebelum Tebar.
- Prompt/validator menolak kontaminasi lama, klaim yang tidak didukung, dan skenario hipotetis tanpa label `Ilustrasi:`.
- Karena mesin kategori/gaya Fase B belum ada, UI menampilkan sebab blocker dan API/dispatcher fail closed sebelum claim/publish. Jalur pemeriksaan dan rekonsiliasi slot `unknown` tetap berjalan.
- Jalur auth/CSRF/session/audit, provider adapter, scheduler, retry, idempotency dan unknown dipertahankan.
- Perbaiki replay migration 006 supaya tidak menambahkan cadence `intervalHours` ketika database sudah memakai interval kanonik; test DB kini mengatur fixture knowledge/CTA terisolasi dan memulihkan state awal.

## Verifikasi lokal

- `npm test` dengan DB disposable: PASS — 480 lulus, 0 gagal, 7 dilewati (487 total).
- Urutan persis yang sebelumnya gagal di CI (`npm test`, lalu `npm run test:integration` pada schema sama): PASS; suite kedua 93/93.
- Migration 018, learning upgrade 011→021, publication migration 020, publication fence/legacy closure, dan NDI migration 021: PASS, masing-masing 1/1.
- Publication resolution MySQL: PASS — 10/10.
- Browser E2E `npm run test:ndi:browser`: PASS — 3/3, Chromium lokal + DB disposable, termasuk login, readiness, accessibility WCAG 2.2 AA, dan UI unknown.
- Lint, typecheck, JavaScript syntax, shell syntax, `git diff --check`, Compose config dengan HOST_IP test-only, Docker runtime build: PASS.
- `npm audit --audit-level=high`: PASS, 0 vulnerabilities.
- GitHub CI run `44277306178` pada commit `37d92b3`: PASS (`Lint, test, and build`); run sebelumnya `44272321299` gagal dan sudah diperbaiki. `actionlint` tidak tersedia lokal.

## Batas, risiko, dan tindak lanjut

- Nilai konfigurasi dan slot aktual database produksi tidak dibaca. R-055 tetap BLOCKED untuk validasi konfigurasi produksi sebelum migration/deployment.
- Rollback binary bukan rollback data/schema; R-068 tetap BLOCKED untuk deployment sampai operator meninjau dan menyetujui prosedur restore yang diuji. Migration disposable pass tidak membuktikan rollback produksi.
- R-045/R-053 menjelaskan bahwa pipeline dasar, CTA snapshot, idempotency, dan unknown fence Fase A lulus, sedangkan pemilihan kategori/gaya per slot ditahan sampai Fase B. Gate menahan aktivasi/publish dengan alasan yang terlihat.
- Semua DB test memakai container disposable tanpa mount, MySQL datanya di tmpfs; provider eksternal nonaktif. Tidak menyentuh DB production, Docker volume project, BotMerzz terpisah, deployment atau scheduler production.
- Perubahan pengguna pada `.env.example` untuk `OPENROUTER_GENERATOR_TEMPERATURE=1` dan `OPENROUTER_GENERATOR_TOP_P=1` tetap tidak di-stage. File SSOT untracked adalah input milik pengguna dan tidak boleh dimasukkan ke commit.
- Tool delegasi tidak menyediakan model GPT-6 Luna maupun konfigurasi effort max; tidak ada subagent digunakan dan tidak diklaim telah menggunakan Luna Max.

## Berikutnya

1. Tinjau diff PR #3 dan rencana migrasi/rollback bersama operator sebelum ada keputusan deployment.
2. Pertahankan NO-GO untuk merge/deployment sampai persetujuan eksplisit dan review database produksi serta prosedur migrasi/rollback tersedia.
3. Fase B/C tetap pekerjaan berikutnya; jangan mengaktifkan scheduler atau posting Threads.
