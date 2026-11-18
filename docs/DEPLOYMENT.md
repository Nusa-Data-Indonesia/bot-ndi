# Panduan Deployment Bot NDI

Panduan ini mencakup instalasi dan operasi Bot NDI pada satu LXC Proxmox. Untuk instalasi yang sudah berjalan, langsung ke [Update aplikasi](#7-update-aplikasi).

## Target dan status verifikasi

Spesifikasi target yang diberikan:

| Bagian | Nilai target |
|---|---|
| Proxmox node / hostname LXC | `mamay` / `ndi-bot` |
| OS dan mode | Debian 13, LXC unprivileged |
| CPU / RAM / swap / disk | 4 vCPU / 8192 MB / 512 MB / 30 GB |
| Fitur LXC | `nesting=1`, `keyctl=1` |
| Firewall LXC | Nonaktif sesuai spesifikasi yang diberikan |
| Aplikasi / DB / runner | Satu LXC yang sama |
| Gateway yang sudah ada | LXC `10080`, Traefik dan Cloudflare Tunnel |
| Repository / domain | `Nusa-Data-Indonesia/bot-ndi` / `https://botndi.sequein.my.id` |

Operator melaporkan deployment awal sudah berjalan dengan IP aplikasi `192.168.0.30`, `TRUST_PROXY=192.168.0.80`, runner `ndi-bot-runner`, dan project Compose `bot-ndi`. Operator juga sudah memverifikasi MySQL, login admin, serta endpoint readiness publik. Saat membangun ulang LXC atau mengubah route, cocokkan alamat dengan konfigurasi Proxmox dan interface aktual. Script memeriksa `HOST_IP` dari environment lokal pada setiap deployment.

## 1. Verifikasi LXC dan alamat IP

Di node Proxmox `mamay`, cari ID berdasarkan hostname dan baca konfigurasi aktual. Perintah ini hanya membaca konfigurasi:

```bash
pct list | grep -F ndi-bot
read -r -p 'ID LXC ndi-bot dari output pct list: ' LXC_ID
pct config "$LXC_ID" | grep -E '^(hostname|arch|cores|memory|swap|rootfs|net[0-9]+|unprivileged|features):'
pct exec "$LXC_ID" -- ip -4 -brief address show scope global
```

Di dalam LXC, cocokkan alamat dan route:

```sh
hostnamectl --static
ip -4 -brief address show scope global
ip route
nproc
free -m
df -h /
```

Pastikan hostname, OS Debian 13, resource, mode unprivileged, `nesting=1`, `keyctl=1`, dan alamat interface sesuai rencana. Jika `netX` menggunakan DHCP, pastikan lease atau reservasi aktual stabil sebelum route gateway diarahkan. Catat alamat IPv4 LXC yang benar. Jangan menyalin IP dari contoh atau tangkapan layar.

## 2. Instal Docker Engine pada Debian 13

Di LXC, konfirmasi OS dan arsitektur sebelum mengatur repository paket. Prosedur ini memakai repository APT resmi Docker; jangan gunakan convenience script untuk instalasi produksi.

```sh
set -eu
. /etc/os-release
printf '%s %s (%s)\n' "$PRETTY_NAME" "$VERSION_CODENAME" "$(dpkg --print-architecture)"
test "$ID" = debian
test "$VERSION_CODENAME" = trixie

sudo apt update
sudo apt install -y ca-certificates curl git gzip iproute2 nano tar
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Tambahkan sumber APT untuk codename yang baru diverifikasi:

```sh
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo systemctl is-active docker
sudo docker version
sudo docker compose version
```

Selesaikan langkah ini bila Docker daemon aktif dan `docker compose version` berhasil. Bila daemon gagal berjalan di LXC, simpan pesan error dan hentikan; jangan ubah fitur atau konfigurasi Proxmox tanpa persetujuan eksplisit. Instalasi paket dan pembaruan Docker di masa depan dilakukan operator secara terjadwal.

Docker daemon tetap berjalan sebagai root. Runner akan diberi akses ke Docker socket melalui grup `docker`; akses itu setara hak root pada Docker host, meskipun proses runner sendiri memakai user Linux non-root.

## 3. Buat user runner dan siapkan direktori aplikasi

Gunakan `/opt/bot-ndi` untuk konfigurasi/release aplikasi. Direktori checkout sementara runner harus tetap di home runner, misalnya `/home/bot-ndi-runner/actions-runner/_work`; jangan jadikan `/opt/bot-ndi` sebagai workspace runner.

```sh
sudo adduser --disabled-password --gecos '' bot-ndi-runner
sudo usermod -aG docker bot-ndi-runner
sudo install -d -o bot-ndi-runner -g bot-ndi-runner -m 0750 /opt/bot-ndi
sudo install -d -o bot-ndi-runner -g bot-ndi-runner -m 0750 /opt/bot-ndi/source /opt/bot-ndi/releases /opt/bot-ndi/state
sudo install -d -o bot-ndi-runner -g bot-ndi-runner -m 0700 /opt/bot-ndi/backups
```

Salin template tanpa rahasia dari checkout Bot NDI yang sudah ada pada workstation ke LXC melalui SSH. Ini tidak memerlukan credential GitHub baru pada LXC:

```bash
read -r -p 'User SSH LXC: ' LXC_SSH_USER
read -r -p 'IPv4 LXC yang sudah diverifikasi: ' BOT_NDI_IP
scp .env.example "${LXC_SSH_USER}@${BOT_NDI_IP}:/tmp/bot-ndi.env.example"
```

Di LXC, jangan menimpa file environment yang sudah ada. Jika file tersebut sudah ada, hentikan dan periksa asal serta kepemilikannya sebelum melanjutkan:

```sh
sudo sh -c 'test ! -e /opt/bot-ndi/.env && test ! -L /opt/bot-ndi/.env' || {
  echo '/opt/bot-ndi/.env sudah ada; hentikan tanpa menimpanya.' >&2
  exit 1
}
sudo install -o bot-ndi-runner -g bot-ndi-runner -m 0600 \
  /tmp/bot-ndi.env.example /opt/bot-ndi/.env
sudo -u bot-ndi-runner nano /opt/bot-ndi/.env
```

Isi dengan credential baru, hanya di LXC:

- `HOST_IP`: alamat IPv4 LXC yang diverifikasi pada langkah 1. Port aplikasi hanya dipetakan ke alamat ini.
- `BASE_URL=https://botndi.sequein.my.id`.
- **Website Resmi / CTA URL** dikelola admin di dashboard dan tersimpan di database; default-nya `https://nusadataindonesia.com`. Nilai CTA boleh berupa URL HTTPS valid pada hostname mana pun. CTA tidak memicu request server; domain dashboard tetap berbeda dari URL pemasaran.
- `TRUST_PROXY`: setelah memeriksa route gateway, isi alamat IP aktual Traefik yang menjadi peer koneksi ke aplikasi. Untuk sementara gunakan `false` jika alamat sumber belum diverifikasi; jangan gunakan `true` atau rentang umum.
- `DB_NAME=bot_ndi` dan `DB_USER=bot_ndi_app`; buat nilai baru dan unik untuk `DB_PASSWORD` serta `DB_ROOT_PASSWORD`.
- Biarkan `EXTERNAL_INTEGRATIONS_ENABLED=false`, `SCHEDULER_ENABLED=false`, dan semua `LEARNING_*_ENABLED=false` selama initial deployment.
- Kredensial `TEBAR_*`, `OPENROUTER_API_KEY`, dan `TELEGRAM_*` khusus NDI boleh tetap terisi. Jika `.env` yang sudah ada belum memiliki `EXTERNAL_INTEGRATIONS_ENABLED`, runtime menganggapnya `false`; workflow tidak mengedit `.env` produksi. Sakelar eksternal yang mati mencegah request provider, AI generation, Threads publishing, webhook processing, dan pengiriman notifikasi.

Buat password dengan password manager atau generator lokal tepercaya, lalu masukkan melalui editor. Jangan menaruh credential dalam GitHub Actions secret, argumen shell, issue, chat, atau log. File environment harus terbaca runner deployment dan tidak oleh user lain:

```sh
sudo chown bot-ndi-runner:bot-ndi-runner /opt/bot-ndi/.env
sudo chmod 600 /opt/bot-ndi/.env
stat -c '%a %U:%G %n' /opt/bot-ndi/.env
```

Selesaikan langkah ini bila output menunjukkan mode `600`, owner `bot-ndi-runner:bot-ndi-runner`, dan tidak ada nilai credential kosong. Jangan memakai atau menyalin environment, volume, network, ataupun credential dari aplikasi lain.

Setelah deployment pertama berhasil dan pemilik NDI menyetujui validasi integrasi, operator dapat mengganti `EXTERNAL_INTEGRATIONS_ENABLED=true` lalu membuat ulang service app. Validasi account/model dan panggilan provider baru tersedia sesudah perubahan ini. Untuk mengizinkan scheduler, operator juga harus menyetel `SCHEDULER_ENABLED=true`; publikasi Threads tetap memerlukan konfigurasi lengkap dan aksi eksplisit admin pada kontrol aktivasi automation.

## 4. Pasang runner khusus repository

Daftarkan runner di repository [Nusa-Data-Indonesia/bot-ndi](https://github.com/Nusa-Data-Indonesia/bot-ndi), bukan pada akun/organisasi bersama jika repository-scoped runner tersedia. Ambil versi, checksum, dan instruksi unduh terbaru dari **Settings → Actions → Runners → New self-hosted runner → Linux → x64**. Registration token berlaku sementara; jangan simpan atau bagikan.

Gunakan user dedicated yang dibuat pada langkah 3. Runner berjalan sebagai user Linux tersebut dan memerlukan akses ke Docker socket:

```sh
sudo install -d -o bot-ndi-runner -g bot-ndi-runner -m 0750 /home/bot-ndi-runner/actions-runner
```

> **Peringatan hak Docker:** anggota grup `docker` dapat memasang filesystem host ke container dan menjalankan operasi setara root. Batasi akun yang dapat mengubah workflow deployment, menyetujui GitHub Environment, serta memicu deployment. Jangan pernah menjalankan kode pull request pada runner ini.

Masuk sebagai `bot-ndi-runner`, unduh archive runner dan verifikasi checksum sesuai instruksi GitHub saat itu. Ekstrak ke `/home/bot-ndi-runner/actions-runner`, lalu buka shell sebagai user tersebut:

```sh
sudo -iu bot-ndi-runner
```

Di shell user runner, jalankan instruksi unduh/konfigurasi dari halaman GitHub. Token berlaku sekitar satu jam; input tanpa echo dan hapus dari environment segera sesudah registrasi:

```bash
cd /home/bot-ndi-runner/actions-runner
read -r -s -p 'Temporary runner registration token: ' RUNNER_TOKEN
printf '\n'
./config.sh --url https://github.com/Nusa-Data-Indonesia/bot-ndi \
  --token "$RUNNER_TOKEN" \
  --name ndi-bot-runner --labels bot-ndi --unattended
unset RUNNER_TOKEN
exit
```

GitHub menambahkan label `self-hosted`, `linux`, dan `x64`; label tambahan yang dibutuhkan workflow adalah `bot-ndi`. Periksa runner tampil **Idle** pada pengaturan repository dan memiliki keempat label tersebut.

Pasang service `systemd` menggunakan user dedicated, lalu verifikasi status:

```sh
cd /home/bot-ndi-runner/actions-runner
sudo ./svc.sh install bot-ndi-runner
sudo ./svc.sh start
sudo ./svc.sh status
```

Service harus berjalan sebagai `bot-ndi-runner`, bukan root. Jika user baru ditambahkan ke grup `docker` setelah service dibuat, restart service agar grup baru berlaku. Pastikan Docker dapat diakses user runner dan runner kembali **Idle** di GitHub. Jangan gunakan runner atau credentials milik BotMerzz.

### Atur akses workflow runner

Di GitHub repository:

1. Pastikan runner terdaftar pada repository Bot NDI dan workflow deployment hanya meminta label `self-hosted`, `linux`, `x64`, `bot-ndi`.
2. Buat GitHub Environment bernama `production`, batasi deployment branch ke `main`, aktifkan required reviewer dan pencegahan self-review bila didukung paket repository.
3. Jika paket/visibilitas repository tidak mendukung required reviewer atau branch restriction, jangan masukkan secrets produksi dan jangan gunakan runner untuk deployment sampai kontrol yang setara tersedia.
4. Lindungi branch `main` dengan review PR dan status CI wajib. Minta review pemilik untuk workflow, skrip verifikasi/deployment, migrasi, Dockerfile, Compose, serta konfigurasi environment. Batasi siapa yang dapat memicu `workflow_dispatch`.
5. Pastikan CI memakai GitHub-hosted runner; CI untuk pull request tidak pernah memiliki akses ke Docker socket LXC.

Periksa siapa yang dapat menjalankan workflow lain pada runner produksi. Label `bot-ndi` memilih runner, sedangkan pembatasan akses harus diterapkan di GitHub. Jika organisasi menyediakan runner group dengan **Selected workflows**, batasi grup ke repository ini dan ke `Nusa-Data-Indonesia/bot-ndi/.github/workflows/deploy-homelab.yml@refs/heads/main`. Pada runner tingkat repository, tinjau akses penulis workflow dan kebijakan persetujuan workflow dari fork sebelum mengizinkan kontribusi yang tidak tepercaya. [Panduan akses runner GitHub](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access)

Pastikan runner online dan Environment `production` membatasi branch ke `main`. Jika Environment mensyaratkan reviewer, job otomatis juga menunggu persetujuan. Pemicu otomatis menghapus kebutuhan menekan **Run workflow** setiap kali PR digabung.

## 5. Fresh MySQL dan deployment pertama

MySQL memakai database baru `bot_ndi`, user aplikasi `bot_ndi_app`, dan volume khusus `bot-ndi_mysql_data`. Service database tidak memetakan port 3306 ke host/LAN; hanya service `app` yang terhubung ke network internal database. Saat volume baru kosong, image MySQL menginisialisasi database dan user dari environment lokal. Nilai inisialisasi itu tidak merotasi credential pada volume yang sudah berisi data.

Untuk instalasi baru, gunakan deployment manual berikut. Update otomatis membutuhkan release aktif yang sudah lulus pemeriksaan kesehatan.

1. Pastikan runner dan Environment `production` siap, `.env` mode `600`, `HOST_IP` aktual, dan dua password database baru terisi.
2. Pastikan commit `main` yang akan dideploy telah lulus CI. Periksa perubahan workflow dan script telah direview.
3. Di tab **Actions**, jalankan workflow deployment dengan **Run workflow** dan pilih branch `main`. Tunggu persetujuan Environment jika diminta.
4. Workflow memeriksa konfigurasi, checkout source pada workspace runner, membangun `bot-ndi:<commit-sha>-<run-id>-<run-attempt>` secara lokal, menjalankan pre-deployment checks dan migrasi, lalu memperbarui Compose dan menunggu health check. Label image tetap mencatat full commit SHA.
5. Pastikan summary mencatat SHA yang dipilih, service app berstatus healthy, dan log tidak memuat credential. Workflow tidak menampilkan isi `.env`.

Image aplikasi tidak dipush atau dipull dari GHCR/registry eksternal. Dockerfile tetap membutuhkan base image Node.js dan Compose mendefinisikan image MySQL 8.4; pastikan base image upstream tersebut dapat diperoleh atau sudah tersedia secara lokal sebelum deployment. Ini bukan image Bot NDI yang dipublikasikan. Tidak ada `docker login` untuk registry dalam prosedur deployment.

Inisialisasi dan migrasi pertama tidak mengimpor data aplikasi lain. Jika volume `bot-ndi_mysql_data` sudah ada sebelum bootstrap pertama dan belum memiliki marker state Bot NDI, script deployment harus berhenti tanpa menghapus, memakai, atau menggantinya. Jangan menghapus volume untuk melewati pemeriksaan; investigasi kepemilikan data terlebih dahulu.

Setelah aplikasi sehat, buat akun administrator pertama:

```sh
docker compose \
  --project-directory /opt/bot-ndi \
  --env-file /opt/bot-ndi/.env \
  --env-file /opt/bot-ndi/active/release.env \
  --project-name bot-ndi \
  --file /opt/bot-ndi/active/compose.yaml \
  exec -it app npm run admin:create
```

Masukkan email administrator NDI dan password unik yang panjang; password disembunyikan saat diketik. Tidak ada default admin. Login pertama kali melalui URL HTTPS setelah ingress disiapkan. Jangan menjalankan command ini sebagai bagian integration test.

## 6. Cloudflare Tunnel, Traefik, dan domain publik

Gunakan gateway LXC `10080` serta Cloudflare Tunnel dan Traefik yang sudah ada. Prosedur ini hanya mendokumentasikan perubahan yang harus diterapkan operator pada gateway; repository tidak mengubah file gateway dan tidak membuat tunnel baru.

1. Ambil IP Bot NDI dari hasil verifikasi langkah 1 dan alamat/entry point Traefik dari konfigurasi aktual LXC 10080. Jangan memakai alamat IP contoh.
2. Pada konfigurasi Public Hostname/ingress **tunnel yang sudah ada**, pastikan `botndi.sequein.my.id` diarahkan ke Traefik di gateway. Gunakan nama service, port, dan skema origin yang sudah digunakan konfigurasi gateway; jangan membuat tunnel baru.
3. Tambahkan router Traefik dengan aturan host `botndi.sequein.my.id` dan backend `http://<IP-LXC-BOT-NDI-TERVERIFIKASI>:3000`. Pertahankan entry point dan pola TLS gateway yang sudah berlaku.
4. Tambahkan HTTP health check internal ke `/health/ready`. Health check harus menerima HTTP 200 sebelum trafik publik diarahkan.
5. Pastikan Traefik meneruskan `Host`, `X-Forwarded-For`, dan `X-Forwarded-Proto` dari jalur HTTPS dengan benar. Batasi forwarded header trust pada sumber yang diketahui; jangan percaya nilai header dari jaringan umum.
6. Isi `TRUST_PROXY` pada `.env` dengan IP sumber Traefik yang terlihat oleh Bot NDI setelah diverifikasi. Aplikasi tidak boleh mempercayai seluruh proxy (`true`) tanpa kontrol jaringan yang sesuai.
7. Pertahankan `BASE_URL=https://botndi.sequein.my.id`. Di production, aplikasi mengirim session cookie `HttpOnly`, `SameSite=Strict`, dan `Secure`; TLS publik harus tetap aktif di Cloudflare/ingress.
8. Dashboard memakai autentikasi admin aplikasi. Buat password admin kuat dan berikan akun hanya kepada operator yang berwenang. Jangan menganggap hostname publik atau Cloudflare tunnel sebagai pengganti autentikasi dashboard.
9. Sebelum aktivasi, review pengetahuan bisnis NDI dan klaim yang disetujui pada dashboard, periksa URL CTA, serta pastikan tidak ada slot lama yang masih membutuhkan rekonsiliasi. Migrasi 021 meminta persetujuan ulang atas knowledge bisnis; jangan mengaktifkan scheduler atau integrasi sebagai bagian dari migrasi.

Jangan mempublikasikan MySQL melalui Traefik, Cloudflare Tunnel, atau port host. Jangan mengubah route aplikasi gateway lain.

Setelah operator menerapkan route dan tunnel, uji dari LXC Bot NDI:

```sh
read -r -p 'IP LXC Bot NDI yang diverifikasi: ' BOT_NDI_IP
curl -fsS "http://${BOT_NDI_IP}:3000/health/ready"
```

Lalu uji reachability dari gateway LXC 10080 dan dari client luar:

```sh
read -r -p 'IP LXC Bot NDI yang diverifikasi: ' BOT_NDI_IP
curl -fsS "http://${BOT_NDI_IP}:3000/health/ready"
curl -fsS https://botndi.sequein.my.id/health/ready
```

Hasil siap adalah status HTTP sukses dengan body ringkas `{"status":"ready"}`. Uji ini hanya GET health endpoint dan tidak mengirim pesan atau post. Verifikasi juga login admin melalui HTTPS serta cookie session memiliki atribut `Secure`; jangan menyalin nilai cookie ke log.

## 7. Update aplikasi

### Setelah merge ke `main`

1. Push hasil merge menjalankan **CI**. Saat CI selesai, event `workflow_run` diterima oleh **Deploy Bot NDI**. Hanya push yang sukses pada `main` di `Nusa-Data-Indonesia/bot-ndi` yang memenuhi syarat deployment.
2. Job pada runner GitHub mencocokkan run dan workflow CI dengan GitHub API. Pemeriksaan meliputi repository asal, event, branch, hasil, path `.github/workflows/ci.yml`, dan SHA lengkap. SHA release diambil dari run CI terverifikasi dan harus sama dengan HEAD `main` saat itu. CI pull request, fork, gagal, dibatalkan, atau dilewati tidak diteruskan ke LXC.
3. GitHub menerapkan aturan Environment `production`. Runner LXC melakukan checkout SHA yang lolos pemeriksaan. Build menggunakan source Git tersebut dan Docker Engine lokal, tanpa artifact PR atau image aplikasi dari registry. Deployment otomatis dan manual memakai grup concurrency `bot-ndi-production` yang sama.
4. Script memeriksa kembali HEAD `main` selama update otomatis. Jika commit baru masuk saat job menunggu atau saat build, pantau CI milik commit terbaru. Setelah promosi berhasil, cocokkan SHA di ringkasan Actions dengan release aktif dan periksa `/health/ready`.

Deploy membaca pengaturan scheduler dan integrasi dari `/opt/bot-ndi/.env`. Jangan menampilkan isi file itu atau konfigurasi Compose yang memuat nilai kredensial di log.

### Jika migrasi berubah atau perlu deploy manual

Sebelum menghentikan aplikasi atau menjalankan migrasi, mode otomatis membandingkan kandidat dengan baseline schema terakhir yang tercatat di `/opt/bot-ndi/state/database-schema-baseline`. Pada rollout pertama guard ini, baseline awal berasal dari release aktif yang health-verified. Perubahan pada `migrations/`, `src/migrate.js`, `src/cli.js`, `src/db.js`, `src/config.js`, `package.json`, `package-lock.json`, `Dockerfile`, `compose.yaml`, `.dockerignore`, `Dockerfile.dockerignore`, atau `.gitattributes` memerlukan deployment manual. Berkas tersebut menentukan SQL, koneksi database, entrypoint, dependensi, dan file yang masuk ke image.

Sebelum migrasi berjalan, script mencatat SHA kandidat pada `/opt/bot-ndi/state/database-migration-in-progress`. Jika perintah migrasi berhasil, baseline schema dan marker tracking disimpan segera setelahnya, terpisah dari health check aplikasi dan promosi pointer. Jika migrasi gagal atau status penyimpanan tidak dapat dipastikan, marker in-progress tetap ada dan auto-deployment berhenti sampai operator merekonsiliasi schema. Setelah tracking digunakan, baseline yang hilang juga memerlukan rekonsiliasi operator; instalasi lama tanpa marker tracking boleh menginisialisasi baseline pertama dari release aktif yang health-verified. Manual rollback aplikasi tidak mengubah baseline atau menghapus marker migrasi yang belum selesai.

Untuk perubahan migrasi, tinjau dampak pada data dan kompatibilitas image sebelumnya, termasuk jika DDL hanya berhasil sebagian. Uji upgrade pada MySQL disposable dan siapkan backup yang dapat dipulihkan sesuai [prosedur backup operator](#9-backup-dan-restore-database). Setelah hasil review dan rencana pemulihan disetujui, jalankan **Actions → Deploy Bot NDI → Run workflow** dari `main` dengan `rollback_sha` kosong. Jalur manual juga memverifikasi CI push yang sukses untuk HEAD terbaru. Gunakan cara ini pula jika perlu membangun ulang commit aktif. Jika riwayat/baseline Git tidak dapat diverifikasi, hentikan auto-deployment dan lakukan rekonsiliasi operator.

## 8. Health check, log, dan rollback

Workflow menunggu MySQL healthy, menjalankan migrasi, memulai aplikasi, dan memeriksa `/health/ready`. Compose juga memeriksa readiness lokal aplikasi. Script menyimpan release pada `/opt/bot-ndi/releases/<full-sha>-<run-id>-<run-attempt>` dan `active` menunjuk ke release yang lulus health check. Metadata release dan health verification mengikat commit SHA, release ID, dan image lokal `bot-ndi:<release-id>` agar redeploy SHA yang sama tidak menimpa image terverifikasi.

Untuk pemeriksaan operator, gunakan release aktif dan file release yang sama:

```sh
docker compose \
  --project-directory /opt/bot-ndi \
  --env-file /opt/bot-ndi/.env \
  --env-file /opt/bot-ndi/active/release.env \
  --project-name bot-ndi \
  --file /opt/bot-ndi/active/compose.yaml ps
```

Jika migrasi gagal, deployment berhenti. Jika aplikasi sudah dihentikan atau kandidat gagal dalam pemeriksaan kesehatan, script mencoba menjalankan kembali image terverifikasi sebelumnya. Periksa hasil recovery dan `/health/ready`. Rollback hanya memulihkan aplikasi. DDL MySQL yang sudah diterapkan dapat tetap tersimpan meskipun migrasi gagal. Jika schema sudah berubah, periksa riwayat migrasi dan kompatibilitas image lama sebelum mencoba lagi. Pemulihan database menggunakan backup yang dikelola operator.

Jika release baru sudah berhasil dipromosikan tetapi kemudian perlu dikembalikan, `previous-release` berisi release ID unik. Baca commit SHA pada metadata release tersebut, lalu gunakan SHA itu untuk input `rollback_sha` pada `workflow_dispatch`:

```sh
PREVIOUS_RELEASE_ID="$(cat /opt/bot-ndi/previous-release)"
jq -r .commit "/opt/bot-ndi/releases/$PREVIOUS_RELEASE_ID/metadata.json"
```

Pilih branch `main`, masukkan SHA 40 karakter tersebut pada `rollback_sha`, dan ikuti aturan Environment `production`. Preflight memverifikasi CI push untuk HEAD `main` yang menjalankan prosedur rollback. Di LXC, script mencocokkan SHA target dengan metadata release sebelumnya, memeriksa health marker dan label image lokal `bot-ndi:<release-id>`, lalu memakai kembali image tersebut. Langkah ini membedakan dua build dari commit yang sama. Sebelum menghentikan aplikasi, rollback memeriksa health container MySQL aktif memakai konfigurasi release aktif dan tidak menjalankan `compose up db` dari konfigurasi release lama. Rollback hanya mempromosikan aplikasi setelah health check lulus dan tidak mengubah schema database. SHA `main` yang mengendalikan rollback disimpan pada `/opt/bot-ndi/state/automatic-deployment-hold`; auto-deployment untuk SHA tersebut diblokir agar tidak langsung membatalkan rollback. Operator dapat redeploy melalui `workflow_dispatch` atau menunggu commit `main` baru. Jika release atau image tidak tersedia, periksa penyebabnya sebelum mencoba lagi.

Jangan mengubah symlink `active` atau menjalankan migrasi downgrade secara manual. Jangan menghapus image sebelumnya sampai release baru healthy dan operator memutuskan retensi dengan melihat backup serta metadata migrasi. Database selalu berada di volume persistent yang sama selama update aplikasi.

## 9. Backup dan restore database

Backup Docker volume bukan pengganti logical backup. Simpan backup di lokasi yang dilindungi dan enkripsi salinan off-host. Jangan memasukkan `.env` atau password ke artifact CI.

Buat direktori backup yang hanya dapat diakses user runner jika belum ada:

```sh
sudo install -d -o bot-ndi-runner -g bot-ndi-runner -m 0700 /opt/bot-ndi/backups
```

Sebagai root/operator pada LXC, buat backup konsisten ke file baru. Dump mencatat database tujuan dan perintah drop/create schema agar restore penuh tidak mencampur tabel dari versi berbeda. Password tetap di environment container, bukan pada argumen CLI atau output:

```bash
set -euo pipefail
umask 077
BACKUP="/opt/bot-ndi/backups/bot-ndi-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
dc() {
  docker compose \
    --project-directory /opt/bot-ndi \
    --env-file /opt/bot-ndi/.env \
    --env-file /opt/bot-ndi/active/release.env \
    --project-name bot-ndi \
    --file /opt/bot-ndi/active/compose.yaml "$@"
}
dc exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --single-transaction --routines --triggers --hex-blob --add-drop-database --user=root --databases "$MYSQL_DATABASE"' \
  | gzip -c > "$BACKUP"
chmod 600 "$BACKUP"
gzip -t "$BACKUP"
sha256sum "$BACKUP"
```

Catat SHA release aktif dan salin backup terenkripsi ke media off-host. Uji restore dalam container disposable dengan `/var/lib/mysql` di tmpfs; jangan membuat atau menghapus Docker volume untuk pengujian:

```sh
docker run --pull=never -d --name bot-ndi-restore-test \
  -e MYSQL_ROOT_PASSWORD=restore-only-password \
  -e MYSQL_DATABASE=bot_ndi \
  -e MYSQL_USER=bot_ndi_app \
  -e MYSQL_PASSWORD=restore-only-password \
  --tmpfs /var/lib/mysql:rw,noexec,nosuid,size=2g mysql:8.4

for attempt in $(seq 1 30); do
  docker exec -e MYSQL_PWD=restore-only-password bot-ndi-restore-test \
    mysqladmin ping -h 127.0.0.1 -uroot --silent && break
  sleep 2
done
docker exec -e MYSQL_PWD=restore-only-password bot-ndi-restore-test \
  mysqladmin ping -h 127.0.0.1 -uroot --silent
gzip -dc "$BACKUP" | docker exec -i -e MYSQL_PWD=restore-only-password \
  bot-ndi-restore-test mysql --user=root
docker exec -e MYSQL_PWD=restore-only-password bot-ndi-restore-test \
  mysql --user=root -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='bot_ndi'"
```

Hasil akhir harus menampilkan jumlah tabel lebih dari nol. Jika import atau pemeriksaan gagal, pertahankan container test untuk investigasi. Setelah hasil valid, hentikan container; filesystem database test berada di tmpfs dan akan ikut hilang bersama container:

```sh
docker rm -f bot-ndi-restore-test
```

Untuk pemulihan produksi, lakukan hanya dengan persetujuan operator dan setelah restore disposable berhasil: hentikan app agar tidak menulis, simpan backup keselamatan terbaru, verifikasi checksum serta SHA/migration history backup yang dipilih, lalu restore dump ke database tujuan melalui MySQL. Dump berisi `DROP DATABASE`/`CREATE DATABASE`; restore tersebut mengganti isi schema `bot_ndi`, meskipun volume Docker tidak dihapus. Setelah import sukses, jalankan migrasi dari release yang kompatibel, mulai app kembali, dan pastikan `/health/ready` sehat. Pertahankan volume serta image lama sampai pemeriksaan selesai. Jangan melakukan restore in-place bila backup, commit, atau migration history belum dipastikan.

Contoh restore produksi setelah operator menyetujui tindakan dan memilih dump yang sudah diuji:

```bash
set -euo pipefail
read -r -p 'Path backup yang sudah disetujui untuk dipulihkan: ' BACKUP
test -s "$BACKUP"
read -r -p 'SHA-256 yang tercatat saat backup dibuat: ' EXPECTED_SHA256
printf '%s  %s\n' "$EXPECTED_SHA256" "$BACKUP" | sha256sum --check -
dc() {
  docker compose \
    --project-directory /opt/bot-ndi \
    --env-file /opt/bot-ndi/.env \
    --env-file /opt/bot-ndi/active/release.env \
    --project-name bot-ndi \
    --file /opt/bot-ndi/active/compose.yaml "$@"
}
dc stop app
gzip -t "$BACKUP"
gzip -dc "$BACKUP" | dc exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root'
dc run --rm --no-deps app npm run migrate
dc up -d app
read -r -p 'HOST_IP Bot NDI yang diverifikasi: ' BOT_NDI_IP
curl -fsS "http://${BOT_NDI_IP}:3000/health/ready"
```

Pulihkan `.env` dari salinan terenkripsi secara terpisah sebelum perintah Compose. Pastikan hak database user `bot_ndi_app` masih cocok setelah schema dibuat ulang. Gunakan database dan image versi yang sesuai dengan migration history pada backup. Jangan restore database BotMerzz atau menyalin kredensial dari layanan lain.

## 10. Pembersihan disk yang aman

LXC memiliki disk target 30 GB; pantau ruang sebelum update karena build menyimpan image SHA lama untuk rollback.

```sh
df -h /
docker system df
docker image ls 'bot-ndi'
readlink -f /opt/bot-ndi/active
cat /opt/bot-ndi/previous-release 2>/dev/null || true
```

Pertahankan image release aktif dan minimal image release sebelumnya yang sehat. Setelah memastikan keduanya tersedia dan backup terbaru valid, bersihkan build cache yang berumur lebih dari tujuh hari secara interaktif:

```sh
docker builder prune --filter 'until=168h'
```

Untuk menghapus image lama secara manual, cocokkan setiap release ID dengan `active`, file `previous-release`, metadata commit/image, dan health marker, lalu hapus hanya tag yang secara eksplisit telah disetujui untuk di-retain/dihapus. Jangan memakai `docker system prune -a`, `docker volume prune`, `docker volume rm`, `docker compose down -v`, atau menghapus `/var/lib/docker`; tindakan tersebut dapat menghilangkan database atau satu-satunya image rollback.

## Troubleshooting

| Gejala | Pemeriksaan aman pertama |
|---|---|
| Runner offline | Periksa `sudo /home/bot-ndi-runner/actions-runner/svc.sh status`, akses Docker, konektivitas keluar, dan label repository `bot-ndi`. Jangan mendaftarkan ulang runner aktif. |
| Deployment ditolak sebelum build | Pastikan ref workflow `main`, Environment disetujui, checkout SHA valid, `.env` mode `600`, `HOST_IP` terverifikasi, database identitas tepat, dan tidak ada `DOCKER_HOST` remote. Jangan tampilkan `.env`. |
| Docker tidak berjalan di LXC | Periksa `sudo systemctl status docker` dan log service; bandingkan fitur LXC aktual. Jangan mengubah konfigurasi Proxmox tanpa approval. |
| Build gagal | Periksa ruang disk dengan `df -h` dan build log. Image kandidat tidak boleh menggantikan image aktif sebelum sehat. Hindari cache/image cleanup saat investigasi. |
| Database belum healthy | Gunakan `docker compose ... logs --tail=100 db` dengan file active release. Verifikasi dua password baru dan log aman; jangan hapus volume. |
| Migrasi gagal | Simpan full SHA dan migration status, pertahankan runner serta DB berhenti dari perubahan lebih lanjut. Jangan downgrade schema otomatis. |
| App readiness gagal | Periksa `docker compose ... logs --tail=100 app`, status DB, dan image SHA. Pastikan rollback ke release sehat berhasil sebelum mengubah route. |
| Route gateway gagal | Dari LXC 10080 cek IP Bot NDI yang telah diverifikasi pada port 3000, lalu periksa host rule dan health check Traefik untuk hostname Bot NDI saja. Jangan mengubah tunnel atau route aplikasi lain. |
| Domain gagal | Cek route tunnel yang sudah ada, TLS origin policy, DNS/public hostname `botndi.sequein.my.id`, forwarded headers, `BASE_URL`, dan `TRUST_PROXY`. Jangan menambah tunnel baru. |
| Login atau session gagal | Gunakan origin HTTPS kanonis, periksa atribut cookie tanpa menyalin nilainya, dan pastikan jalur proxy meneruskan Host serta HTTPS dengan benar. Pastikan jam LXC akurat. |
| Disk penuh | Periksa `df -h` dan `docker system df`; simpan image SHA aktif/sebelumnya dan volume. Bersihkan cache build tua secara terarah setelah backup valid. |

## Checklist sebelum menandai siap

- [ ] Konfigurasi LXC aktual dan IP diverifikasi operator.
- [ ] Docker Engine/Compose aktif dan dapat digunakan user runner.
- [ ] Runner khusus repository Bot NDI online, non-root, `systemd`, label lengkap, dan bukan runner aplikasi lain.
- [ ] GitHub Environment `production`, perlindungan branch, reviewer, dan hak workflow diverifikasi.
- [ ] `.env` baru berada di `/opt/bot-ndi/.env`, mode `600`, dan tidak mengandung kredensial aplikasi lain.
- [ ] Database baru memakai `bot_ndi`, `bot_ndi_app`, volume `bot-ndi_mysql_data`; port 3306 tidak dipublikasikan.
- [ ] Deployment manual `workflow_dispatch` dari `main` lulus health check dan rollback teruji sesuai kebijakan operator.
- [ ] Setelah merge yang disetujui, CI push pada HEAD `main` memicu deployment otomatis dan SHA release sehat sesuai ringkasan Actions.
- [ ] Traefik/Tunnel existing mengarahkan domain ke IP internal yang benar dan public health check sukses.
- [ ] Admin baru dapat login melalui HTTPS; scheduler, Threads, Telegram, dan AI tetap mati sampai aktivasi terpisah.
- [ ] Bahasa konten, brand/fakta, klaim, dan CTA telah ditinjau khusus untuk NDI sebelum publikasi diaktifkan.
- [ ] Backup dienkripsi di luar LXC dan restore pernah diuji pada target disposable.

Pemeriksaan runner, LXC, route, IP, domain, deployment produksi, dan backup tidak dilakukan oleh perubahan repository. Checklist hanya selesai setelah operator memperoleh bukti dari infrastruktur sebenarnya.

## Referensi resmi

- [Instal Docker Engine pada Debian](https://docs.docker.com/engine/install/debian/)
- [Tambahkan self-hosted runner](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [Konfigurasikan runner sebagai service](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)
- [Keamanan penggunaan self-hosted runner](https://docs.github.com/en/actions/reference/security/secure-use)
- [Deployment environments di GitHub Actions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
