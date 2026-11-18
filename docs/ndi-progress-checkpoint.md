# Checkpoint Pekerjaan Bot NDI

Diperbarui: 2026-11-18
Branch kandidat: `codex/ndi-abc-integration`, dibuat dari `origin/main` `a9858d2fc7c1006e6548841055426070d6f84b4b`; merge commit memuat PR #3/#4/#5 lengkap satu kali. PR integrasi [#6](https://github.com/Nusa-Data-Indonesia/bot-ndi/pull/6) menuju `main` terbuka. PR #3/#4/#5 tetap terbuka dan tidak diubah. GitHub Actions run `44333658497` lulus pada candidate commit `bab30a40b22e46d11fa7657cd3d07855ad12a785`.

## Otorisasi dan batas keselamatan

- Task mengizinkan satu PR integrasi Phase A+B+C. Tidak ada merge, deployment, aktivasi scheduler, atau posting Threads nyata.
- Tidak ada koneksi langsung ke database produksi, `.env`, kredensial, volume Docker, aplikasi/infrastruktur BotMerzz terpisah, atau provider untuk publikasi. Uji DB menggunakan MySQL disposable; integrasi eksternal memakai mock/fake.
- Worktree Phase A pengguna tetap tidak disentuh, termasuk perubahan `.env.example` dan dokumen SSOT untracked.
- Instruksi meminta subagent GPT-6 Luna effort max. Model Luna tidak tersedia di opsi delegation tool; tidak ada subagent yang digunakan atau diklaim memakai Luna Max.

## Requirement, audit, dan tracker

- SSOT `docs/BOT-NDI-MASTER-CODEX-PROMPT.md` telah dibaca penuh berulang dalam rentang berurutan tanpa tumpang tindih; pembacaan self-audit terakhir dilakukan sebelum finalisasi.
- `docs/ndi-requirements-traceability.md` memetakan R-001–R-073 dan T-01–T-30. `docs/BOT-NDI-IMPLEMENTATION-TRACKER.md` memuat seluruh 73 ID dan bukti source/test.
- Audit runtime, generator, config/knowledge, API/dashboard, scheduler/providers/retry/unknown, auth/session/audit, migrasi, Compose, CI/deployment/rollback ada di `docs/ndi-codebase-audit.md`.
- Operator melaporkan pada 2026-11-18: `integration_config` ACTIVE; Tebar Profile ID/Account ID dan OpenRouter Model SET; pending configuration changes NO; config/history version 1; scheduler/integrasi eksternal OFF; Learning flags yang diperiksa false. Evidence ini dipetakan ke R-055 dan tidak diverifikasi lewat query produksi.
- Untuk R-068, operator menerima risiko melewati backup/restore karena aplikasi belum digunakan secara operasional. Backup/restore test **NOT_EXECUTED**, bukan PASS. Migration 021–023 diuji pada MySQL disposable; migration produksi tidak dijalankan.

## Phase A

- Migrasi identitas dan knowledge Kedai Merzz/top-up ke NDI, CTA URL snapshot, prompt/validator NDI, preservasi data historis, dan readiness fail-closed tersedia di PR #3.
- PR #3 belum merge. Karena merge ke `main` dapat memicu auto-deployment, merge tetap dilarang tanpa persetujuan eksplisit.

## Phase B — implementasi selesai

- Migration additive 022 menambah kategori/gaya, proposal, status persetujuan strategi, snapshot slot, dan waktu publikasi provider. Seed 8 kategori serta 7 gaya menggunakan `INSERT IGNORE`, sehingga nilai admin yang telah ada tidak ditimpa.
- CRUD/status/archive dan audit admin; pemilihan kategori/gaya uniform dan independen; kategori provider-confirmed terakhir dirotasi; pilihan terikat ke slot secara transaksional.
- Hanya waktu `published_at` dari target Tebar yang terkonfirmasi dipakai untuk mengurutkan. Timestamp hilang atau seri membuat status uncertain dan memblokir publish. Tidak ada fallback ke waktu observasi lokal.
- AI category proposal terpisah, eksplisit disetujui/ditolak admin, interval 30–365 hari, default OFF, scheduler terpisah dari posting, satu request maksimal 400 token per run, dan error terisolasi.
- Strategi konten tetap OFF setelah migrasi; tidak mengubah flag automation atau scheduler. Dashboard ditambah tab tanpa redesign besar. Unknown/retry/provider fencing tetap berlaku.

## Phase C — implementasi selesai

- Sinkronisasi website hanya berjalan setelah POST admin terautentikasi/CSRF ke origin tetap `https://nusadataindonesia.com/`, tidak terikat ke CTA. Tidak ada crawler atau scheduler sync.
- Fetch HTTPS dibatasi waktu dan ukuran, melakukan validasi/pinning DNS publik, menolak redirect dan jawaban DNS tidak aman, lalu mengekstrak teks sebagai data tidak tepercaya.
- Perubahan layanan menjadi proposal per-item dengan nilai sebelumnya/target, source/version, audit, keputusan admin individual, dan konflik versi untuk melindungi perubahan manual yang lebih baru. Gagal fetch/parse tidak mengubah knowledge aktif atau posting.

## Verifikasi aktual

- `npm test`: **510 total, 504 PASS, 0 FAIL, 6 SKIPPED**. Enam migration DB test yang diskip karena memakai schema tersendiri dijalankan terpisah dan seluruhnya PASS.
- `npm run test:integration`: **94/94 PASS**; MySQL configuration check terpisah **1/1 PASS**. Uji restart database shadow yang bergantung pada restart Docker juga PASS pada MySQL disposable dengan penyimpanan persisten di writable layer container.
- MySQL 8.4 disposable migration tests: migration 018 recovery, Learning upgrade, publication migration 020, publication fence, legacy publication closure, serta migration NDI 021–023 semuanya **1/1 PASS**. Publication resolution regression tests di suite utama juga PASS.
- Browser E2E **4/4 PASS** dengan Chromium lokal dan MySQL disposable loopback; scheduler/integrasi nonaktif, website API di-intercept, tanpa provider atau real-site fetch.
- `npm run lint`, `npm run typecheck`, `npm run check`, `npm audit --audit-level=high` (0 vulnerabilities), `bash -n scripts/deploy-homelab.sh`, Compose config validation, dan Docker runtime build **PASS**.
- `actionlint v1.7.12` **PASS** dengan pengecualian terarah untuk custom runner label `bot-ndi` dan `concurrency.queue` yang didukung GitHub tetapi belum dikenali schema actionlint. Workflow regression tests juga lulus di `npm test`. GitHub CI PR #6 run `44333658497` **PASS** pada commit kandidat yang tercatat di atas.
- Dua percobaan uji awal gagal karena harness: `tmpfs` menghapus database saat restart, dan beberapa test migration berbagi schema saat dijalankan paralel. Rerun dengan storage disposable persisten dan urutan serial lulus; tidak ada kegagalan final pada source candidate.

### Klasifikasi hasil

- **PASS:** semua quality gates lokal di atas; 73 requirement terpetakan; test matrix lokal T-01–T-30 diperiksa terhadap source/tests.
- **FAIL:** tidak ada test/runtime failure pada rerun final. `git diff --check origin/main...HEAD` hanya menandai trailing spaces hard-break Markdown pada SSOT yang sudah ada dalam riwayat phase branch; file SSOT identik dengan salinan lokal dan tidak diubah. Diff dokumentasi yang ditambahkan pada kandidat lulus `git diff --check HEAD~1 HEAD`. Kegagalan harness awal dijelaskan di atas dan tidak dihitung sebagai pass.
- **SKIPPED:** 6 test migration DB pada `npm test` karena membutuhkan schema disposable khusus; masing-masing lulus saat dijalankan terpisah.
- **NOT_EXECUTED:** backup/restore (operator risk acceptance), provider connectivity, jalur publikasi nyata/Threads, migrasi produksi, dan deployment.

## Next steps

1. Operator review PR #6 integrasi A+B+C; PR #3/#4/#5 tetap terbuka sampai cakupan PR integrasi disetujui.
2. Jangan merge/deploy tanpa persetujuan eksplisit; merge ke `main` dapat memicu auto-deployment.
3. Jangan mengklaim provider connectivity atau backup/restore telah diuji; operator risk acceptance R-068 dan evidence R-055 tercatat di atas.
