# Checkpoint Pekerjaan Bot NDI

Diperbarui: 2026-11-18
Branch implementasi: `codex/ndi-phase-b`, bertumpu di atas baseline Phase A.
PR Phase A: #3 terbuka, belum merge.
PR Phase B: #4 terbuka, target `codex/ndi-phase-a`.
PR Phase C: #5 terbuka, target `codex/ndi-phase-b`.
GitHub CI: final head B/C tidak memiliki checks karena workflow hanya memicu pull_request/push ke `main`. Runs percobaan `44310912797`/`44310952126` dijalankan dari temporary CI trigger dan gagal hanya pada assertion yang mensyaratkan filter `push: [main]`; trigger sementara dikembalikan mengikuti gate persetujuan SSOT. T-30 BLOCKED sampai branch CI dapat dijalankan dengan persetujuan.

## Otorisasi dan batas keselamatan

- Instruksi task mengizinkan penyelesaian Fase B dan C dengan PR terpisah. Branch ini berisi implementasi B saja. Tidak ada merge, deployment, aktivasi scheduler, atau posting Threads nyata.
- Tidak ada akses ke database produksi, `.env`, kredensial produksi, volume Docker, aplikasi/infrastruktur BotMerzz terpisah, atau provider untuk publikasi. Uji DB memakai MySQL disposable; integrasi eksternal memakai mock/fake.
- Worktree Phase A pengguna tetap tidak disentuh, termasuk perubahan `.env.example` dan dokumen SSOT untracked.
- Instruksi meminta subagent GPT-6 Luna effort max. Model Luna tidak tersedia di opsi delegation tool; tidak ada subagent yang digunakan atau diklaim memakai Luna Max.

## Requirement, audit, dan tracker

- SSOT `docs/BOT-NDI-MASTER-CODEX-PROMPT.md` berisi 377 baris. Pembacaan lengkap dan self-audit dilacak berdasarkan rentang 1–130, 131–260, dan 261–377.
- `docs/ndi-requirements-traceability.md` memetakan seluruh R-001–R-073 dan T-01–T-30; `docs/BOT-NDI-IMPLEMENTATION-TRACKER.md` memuat seluruh 73 Requirement ID dan bukti status branch B.
- Audit runtime, generator, config/knowledge, API/dashboard, scheduler/providers/retry/unknown, auth/session/audit, migrasi, Compose, CI/deployment/rollback tersedia di `docs/ndi-codebase-audit.md`.
- PR #3 Phase A adalah baseline; GitHub Actions run `44277798887` lulus. Hasil itu bukan bukti CI Phase B/C.
- R-055 tetap BLOCKED untuk pemeriksaan nilai database produksi efektif; R-068 BLOCKED untuk persetujuan operator atas backup/restore dan rollback schema produksi. Produksi tidak diakses.

## Phase A

Migrasi identitas dan knowledge Kedai Merzz/top-up ke NDI, CTA URL snapshot, prompt/validator NDI, preservasi data historis, dan readiness fail-closed tersedia di PR #3. PR #3 belum merge; merge ke `main` dapat memicu auto-deployment.

## Phase B — implementasi source selesai, verifikasi branch dilakukan sebelum PR

- Migration additive 022 menambah kategori/gaya, proposal, status persetujuan strategi, snapshot slot, dan waktu publikasi provider. Seed 8 kategori serta 7 gaya idempotent menggunakan `INSERT IGNORE`.
- CRUD/status/archive dan audit admin; pemilihan kategori/gaya uniform dan independen; provider-confirmed category rotation; snapshots persisten per slot.
- Timestamp Tebar hilang atau seri membuat status uncertain dan memblokir publish; tidak ada fallback ke waktu observasi lokal.
- AI category proposals terpisah, perlu persetujuan admin, interval 30–365 hari, default OFF, scheduler terpisah, maksimal 400 token per run, error terisolasi.
- Strategi konten tetap OFF setelah migration; flag automation/scheduler tidak diubah. Retry, unknown/provider fencing tetap berlaku.

## Phase C — belum dikerjakan

R-057–R-063 dan T-23–T-28 tetap TODO/not yet implemented pada branch ini. Website sync, migration 023, endpoint, service, proposal UI, dan test C-only tidak ada di diff Phase B.

## Verifikasi

- `npm test`: **475 total, 450 PASS, 0 FAIL, 25 SKIP**.
- `npm run test:integration`: **94/94 PASS**; MySQL configuration **1/1 PASS**.
- Migration 021–022 disposable MySQL **1/1 PASS**; publication-resolution MySQL **10/10 PASS**.
- Browser E2E **3/3 PASS** pada Chromium lokal dan MySQL disposable; scheduler/provider integrations tetap OFF.
- `npm run lint`, `npm run typecheck`, `npm run check`, Compose validation, dan Docker build **PASS**.
- GitHub Actions runs `44310912797` (B: 492 pass/1 fail/7 skipped) dan `44310952126` (C: 502 pass/1 fail/7 skipped) gagal pada assertion workflow `test/workflow-deployment.test.js`; trigger sementara penyebab run sudah dikembalikan. Final heads tidak mendapat CI run karena filter workflow hanya mencakup `main`. `actionlint` tidak tersedia; T-30 **BLOCKED**.

## Berikutnya

1. Review PR bertingkat #4 (B) dan #5 (C); jangan merge.
2. T-30 memerlukan persetujuan eksplisit sebelum workflow CI diubah agar memicu push branch B/C.
3. R-055 dan R-068 tetap memerlukan pemeriksaan operator produksi; tidak ada akses atau migration produksi.
