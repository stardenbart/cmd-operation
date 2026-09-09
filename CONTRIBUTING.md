# Panduan Developer CMD 1 Operation

Dokumen ini adalah titik awal onboarding dan workflow kontribusi sehari-hari.

## Ringkasan sistem

CMD 1 Operation adalah aplikasi operasional penerimaan, prepasteurisasi,
transfer, stok opname, monitoring, analitik, koreksi, approval, dan pelacakan
susu segar di CMD1 Plant Sentul 1. Aplikasi menggantikan Power Apps dan dirancang
tetap berjalan pada server on-premise.

## Tech stack

| Area | Teknologi |
|---|---|
| Frontend | React 18, React Router 7, TanStack Query 5, React Hook Form, Zod, Vite 6 |
| Backend | Node.js 20+, Express 4, ESM, Zod, Pino |
| Database | MySQL 8.4, migrasi SQL berurutan, `mysql2` |
| Auth & security | JWT access/refresh token, Argon2, Helmet, CORS, rate limiting |
| File/export | ExcelJS, JSZip |
| Test | Node.js built-in test runner, unit dan integration test |
| Runtime/deploy | Docker Compose, Nginx, server on-premise; konfigurasi Vercel tersedia |

Repository memakai npm workspaces: `client` dan `server`. Business rule berada
di `server/src/services`; route sebaiknya hanya menangani HTTP, autentikasi,
validasi, dan delegasi ke service.

## Struktur penting

```text
client/             React SPA dan PWA
server/src/         API, auth, middleware, migrasi data, dan service bisnis
server/test/        Integration test
db/migrations/      Perubahan skema berurutan; jangan ubah migrasi yang sudah rilis
db/seeds/           Data awal/master non-rahasia
db/templates/       Template dokumen operasional
docs/               PRD dan dokumentasi domain
deploy/             Konfigurasi dan script deployment
api/                Entry point deployment serverless
```

Folder/file lokal yang diabaikan Git antara lain `.env*`, `reference/`, `ref/`,
dump/backup database, `output/`, log, build, dan artefak browser. Jangan paksa
menambah file tersebut karena dapat mengandung secret atau data produksi.

## Persiapan pertama kali

Prasyarat: Git, Node.js 20 atau lebih baru, npm, serta Docker Desktop/Engine
dengan Compose. Pastikan Anda sudah diberi akses ke repository dan konfigurasi
lokal melalui kanal internal.

```bash
git clone https://github.com/stardenbart/cmd-operation.git
cd cmd-operation
npm install
cp .env.example .env
```

Pada PowerShell, gunakan `Copy-Item .env.example .env`. Isi minimal
`DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`, dan `JWT_SECRET` dengan nilai lokal yang
kuat. Jangan memakai secret production di mesin development.

Siapkan database dan jalankan aplikasi:

```bash
docker compose up -d mysql
npm run db:migrate
npm run db:seed
npm run dev:server
```

Di terminal lain jalankan `npm run dev:client`. Frontend tersedia di
`http://localhost:5173`, API di `http://localhost:3001`, dan MySQL host secara
default di port `3307`.

## Workflow pull - develop - push

Jangan mengembangkan langsung pada `main`. Awali pekerjaan dari `main` terbaru:

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/deskripsi-singkat
```

Gunakan prefix branch `feat/`, `fix/`, `docs/`, `refactor/`, atau `chore/`.
Selama develop, buat perubahan kecil dan terarah. Periksa sebelum commit:

```bash
git status
git diff
npm test
npm run build
```

Untuk perubahan database/API, jalankan juga integration test dengan database
test yang terisolasi: `npm run test:integrasi --workspace=server`.

Commit menggunakan pesan imperatif/Conventional Commits:

```bash
git add path/file-yang-diubah
git diff --cached
git commit -m "feat: tambah validasi transfer silo"
```

Sebelum push, sinkronkan kembali perubahan tim:

```bash
git fetch origin
git rebase origin/main
git push -u origin feat/deskripsi-singkat
```

Buat Pull Request ke `main`. Jelaskan masalah, solusi, dampak database/API/UI,
cara pengujian, screenshot bila UI berubah, dan rollback bila relevan. Gunakan
squash merge jika tim tidak menentukan strategi lain. Jika branch yang sudah
di-push kemudian di-rebase, gunakan `git push --force-with-lease`, bukan
`--force`. Jangan pernah force-push ke `main`.

## Quality gate

- `npm test` dan `npm run build` lulus.
- Integration test lulus untuk perubahan database atau endpoint.
- Tidak ada secret, data produksi, dump, log, atau artefak build dalam diff.
- Migrasi baru forward-only, bernomor lanjutan, dan aman dijalankan.
- Perubahan volume tetap transaksional dan menjaga konservasi volume.
- Otorisasi diperiksa di backend, bukan hanya melalui visibilitas UI.
- Timestamp disimpan dalam UTC dan ditampilkan dalam `Asia/Jakarta`.
- Audit log tetap append-only.

## Aturan domain kritis

1. Perubahan volume wajib berada dalam satu transaksi database.
2. Alokasi FIFO wajib mengunci baris dengan `SELECT ... FOR UPDATE`.
3. Volume silo dibaca dari view `v_silo_volume`, bukan disimpan sebagai duplikat.
4. Endpoint tulis wajib melakukan autentikasi, pemeriksaan permission, dan validasi.
5. Total volume sebelum dan sesudah perpindahan harus tetap sama.

Baca `README.md` dan PRD di `docs/` sebelum mengubah business rule.

## Perintah sehari-hari

| Perintah | Fungsi |
|---|---|
| `npm run dev:server` | Jalankan API dengan watch mode |
| `npm run dev:client` | Jalankan Vite dev server |
| `npm test` | Unit test server dan coverage |
| `npm run test:integrasi --workspace=server` | Integration test serial |
| `npm run build` | Build frontend production |
| `npm run db:migrate` | Terapkan migrasi yang belum berjalan |
| `npm run db:migrate -- --status` | Periksa status migrasi |
| `npm run db:seed` | Isi data awal |
| `npm run docker:up` / `npm run docker:down` | Kelola stack Docker |

`npm run db:reset` menghapus dan membangun ulang database. Jalankan hanya pada
database development/test milik sendiri setelah memeriksa target koneksi.

## Troubleshooting singkat

- API gagal start: pastikan `DB_PASSWORD` dan `JWT_SECRET` terisi serta MySQL
  sehat melalui `docker compose ps`.
- Port bentrok: ubah `PORT`, `DB_PORT`, atau `DB_HOST_PORT` di `.env`.
- Skema belum berubah: cek `npm run db:migrate -- --status`, lalu migrasikan.
- Install bermasalah di OneDrive: pindahkan clone ke folder non-OneDrive.
- Konflik migrasi: jangan edit migrasi yang sudah dibagikan; buat migrasi baru
  dengan nomor berikutnya setelah menyinkronkan `main`.

Untuk keputusan domain yang belum terdokumentasi, konfirmasi dengan product
owner/operation owner, lalu catat keputusan tersebut di PR atau `docs/`.
