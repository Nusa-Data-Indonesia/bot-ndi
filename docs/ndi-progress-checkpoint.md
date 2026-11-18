# Checkpoint Pekerjaan Bot NDI

Diperbarui: 2026-11-18
Branch implementasi: `codex/ndi-phase-b` untuk Fase B, kemudian `codex/ndi-phase-c` bertumpuk di atasnya.
PR Phase A: #3 terbuka, belum merge.
PR Phase B: #4 terbuka, base `codex/ndi-phase-a`; CI berjalan setelah PR dibuat.
Phase C: source dan pengujian selesai pada working tree branch `codex/ndi-phase-c`; PR bertarget `codex/ndi-phase-b` dibuat setelah commit/push final.

## Otorisasi dan batas keselamatan

- Attachment task mengizinkan penyelesaian Fase B dan C, dengan PR terpisah. Tidak ada merge, deployment, aktivasi scheduler, atau posting Threads nyata.
- Tidak ada akses ke database produksi, `.env`, kredensial produksi, volume Docker, aplikasi/infrastruktur BotMerzz terpisah, atau provider untuk publikasi. Uji DB menggunakan MySQL disposable; integrasi eksternal memakai mock/fake.
- Worktree Phase A pengguna tetap tidak disentuh, termasuk perubahan `.env.example` dan dokumen SSOT untracked.
- Instruksi meminta subagent GPT-6 Luna effort max. Model Luna tidak tersedia di opsi delegation tool; tidak ada subagent yang digunakan atau diklaim memakai Luna Max.

## Requirement, audit, dan tracker

- SSOT `docs/BOT-NDI-MASTER-CODEX-PROMPT.md` telah dibaca penuh berulang dalam rentang berurutan tanpa tumpang tindih; pembacaan self-audit terakhir dilakukan sebelum finalisasi.
- `docs/ndi-requirements-traceability.md` memetakan R-001–R-073 dan T-01–T-30. `docs/BOT-NDI-IMPLEMENTATION-TRACKER.md` memuat seluruh 73 ID dan bukti source/test.
- Audit runtime, generator, config/knowledge, API/dashboard, scheduler/providers/retry/unknown, auth/session/audit, migrasi, Compose, CI/deployment/rollback ada di `docs/ndi-codebase-audit.md`.
- PR #3 Phase A adalah baseline; GitHub Actions run `44277798887` lulus. Bukti tersebut bukan hasil CI untuk commit Phase B/C.
- R-055 tetap BLOCKED untuk pemeriksaan nilai database produksi efektif; R-068 tetap BLOCKED untuk persetujuan operator atas backup/restore dan rollback schema produksi. Produksi tidak diakses.

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

- `npm test`: **485 total, 460 pass, 0 fail, 25 skipped**; DB-backed tests are reported separately.
- `test/deploy-homelab.test.js`: **30 pass, 0 fail**, berjalan terpisah dalam sandbox tanpa network.
- `npm run test:integration`: **94 pass, 0 fail, 0 skipped**; MySQL configuration check terpisah **1 pass**.
- Migration 021–023 di MySQL 8.4 disposable: **1/1 PASS**, termasuk upgrade/rerun, legacy retention, strategy gate, website proposal/version/audit/conflict, dan failure preservation.
- Publication resolution MySQL: **10/10 pass**. `npm run lint`, `npm run typecheck`, `npm run check`, dan Compose config validation **PASS**.
- Browser E2E **4/4 PASS** dengan Chromium lokal dan MySQL disposable yang hanya bind ke loopback; scheduler/integrasi nonaktif, website API di-intercept, tanpa provider atau real-site fetch.
- Docker build dan Compose validation **PASS**. `actionlint` tidak tersedia. GitHub CI Phase B/C belum berjalan sebelum PR dibuat.

## Next steps

1. Finalkan commit khusus Phase C dan push `codex/ndi-phase-c` di atas branch Phase B.
2. Buat PR Phase C bertarget `codex/ndi-phase-b`; jangan merge.
3. Periksa CI aktual PR #4 dan PR Phase C setelah kedua workflow berjalan; T-30 tetap BLOCKED sampai hasilnya tersedia.
4. Baca ulang SSOT, audit requirement awal/tengah/akhir dan cross-phase invariants, lalu perbarui status PR/CI dan GO-NO-GO berdasarkan bukti.
