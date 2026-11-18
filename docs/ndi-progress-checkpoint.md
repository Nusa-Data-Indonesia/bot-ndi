# Checkpoint Pekerjaan Bot NDI

Diperbarui: 2026-11-18
Branch kerja: `codex/ndi-phase-a`, berbasis `origin/main` (`f94ad20`)
Cakupan: implementasi Fase A saja; Fase B/C tetap pekerjaan berikutnya.

## Status

Implementasi Fase A siap untuk review source lokal dengan batas yang dijelaskan di traceability matrix. Belum ada commit, push, atau Pull Request. Tidak ada merge, deployment, migrasi production, aktivasi scheduler, atau posting Threads.

## Requirement dan audit

- SSOT `docs/BOT-NDI-MASTER-CODEX-PROMPT.md` dibaca lengkap, 377 baris, dalam rentang tidak tumpang-tindih. Pembacaan ulang akhir dilakukan sebelum penyelesaian.
- Requirements Traceability Matrix memuat R-001–R-073 dan T-01–T-30. Hasil terakhir: 46 DONE, R-045/R-053 IN_PROGRESS karena binding kategori/gaya adalah dependency Fase B; R-055/R-068 BLOCKED hanya untuk pemeriksaan state/rollback produksi yang tidak boleh dilakukan tanpa operator. Sisa 23 TODO adalah Fase B/C.
- Audit arsitektur/runtime, data, dashboard/API, knowledge/prompt, scheduler/providers/retry/unknown, auth/session/audit, migrations, Compose/CI/deploy/rollback dicatat di `docs/ndi-codebase-audit.md`.
- Rencana Fase A/B/C dan risiko kompatibilitas tersedia di `docs/ndi-implementation-plan.md`.

## Implementasi Fase A

- Migrasi identitas dan aturan aktif ke Nusa Data Indonesia; knowledge bisnis NDI sekarang tersimpan di DB, harus ditinjau dan disetujui admin sebelum automation bisa diaktifkan.
- Hilangkan UI/API/prompt aktif yang khusus Kedai Merzz/game/top-up/harga/stok. Historical schema/data dipertahankan; `service_facts` tetap utuh termasuk active state dan tidak dibaca ke konteks generation NDI.
- Tambah migrasi additive/restartable 021 untuk knowledge baru, snapshot CTA, dan salinan arsip konfigurasi lama. Tidak ada DROP/DELETE/TRUNCATE; admin, audit, session, integrasi, kredensial, automation flag, jadwal, fakta, template, dan slot historis dipertahankan.
- CTA memakai URL HTTPS yang divalidasi tanpa allowlist host atau fetch; CTA di-snapshot per slot, diuji lagi pada payload final sebelum Tebar.
- Prompt/validator menolak kontaminasi lama, klaim yang tidak didukung, dan skenario hipotetis tanpa label `Ilustrasi:`.
- Karena mesin kategori/gaya Fase B belum ada, UI menampilkan sebab blocker dan API/dispatcher fail closed sebelum claim/publish. Jalur pemeriksaan dan rekonsiliasi slot `unknown` tetap berjalan.
- Jalur auth/CSRF/session/audit, provider adapter, scheduler, retry, idempotency dan unknown dipertahankan.

## Verifikasi lokal

- `npm test`: PASS — 415 lulus, 0 gagal, 25 dilewati karena butuh schema DB disposable (440 total).
- `npm run test:integration`: PASS — 93 lulus pada MySQL 8.4 disposable.
- Migrasi 021, migration 018, learning upgrade 011→021, publication migration 020, publication fence, dan legacy publication resolution: PASS, masing-masing satu test database.
- Publication resolution MySQL: PASS — 10/10.
- Browser E2E `npm run test:ndi:browser`: PASS — 3/3, Chromium lokal + DB disposable, termasuk login, readiness, accessibility WCAG 2.2 AA, dan UI unknown.
- Lint, typecheck, JavaScript syntax, shell syntax, `git diff --check`, Compose config, Docker runtime build: PASS.
- `npm audit --audit-level=high`: PASS, 0 vulnerabilities.
- CI GitHub belum berjalan; actionlint tidak tersedia lokal.

## Batas, risiko, dan tindak lanjut

- Nilai konfigurasi dan slot aktual database produksi tidak dibaca. R-055 tetap BLOCKED untuk validasi konfigurasi produksi sebelum migration/deployment.
- Rollback binary bukan rollback data/schema; R-068 tetap BLOCKED untuk deployment sampai operator meninjau dan menyetujui prosedur restore yang diuji. Migration disposable pass tidak membuktikan rollback produksi.
- R-045/R-053 menjelaskan bahwa pipeline dasar, CTA snapshot, idempotency, dan unknown fence Fase A lulus, sedangkan pemilihan kategori/gaya per slot ditahan sampai Fase B. Gate menahan aktivasi/publish dengan alasan yang terlihat.
- Semua DB test memakai container disposable tanpa mount, MySQL datanya di tmpfs; provider eksternal nonaktif. Tidak menyentuh DB production, Docker volume project, BotMerzz terpisah, deployment atau scheduler production.
- Perubahan pengguna pada `.env.example` untuk `OPENROUTER_GENERATOR_TEMPERATURE=1` dan `OPENROUTER_GENERATOR_TOP_P=1` dipertahankan sebagai perubahan lokal terpisah. Hanya penghapusan contoh CTA allowlist yang relevan untuk commit. File SSOT untracked adalah input milik pengguna dan tidak boleh dimasukkan ke commit.
- Tool delegasi tidak menyediakan model GPT-6 Luna maupun konfigurasi effort max; tidak ada subagent digunakan dan tidak diklaim telah menggunakan Luna Max.

## Berikutnya

1. Baca ulang SSOT penuh dan audit requirement awal/tengah/akhir sebelum final.
2. Cocokkan 73 requirement dan test matrix terhadap perubahan aktual, periksa source/UI legacy aktif dan `git diff --check`.
3. Hentikan container DB test ephemeral setelah seluruh run.
4. Stage hanya perubahan Fase A, pertahankan dua nilai temperature user di luar stage, commit di branch ini, push, dan buat PR ke `main` jika akses tersedia. Jangan merge.
5. Catat status PR, CI, risiko produksi, dan NO-GO deployment di laporan akhir.
