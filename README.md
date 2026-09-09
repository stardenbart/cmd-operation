# CMD 1 Operation

Sistem Penerimaan, Prepasteurisasi, Transfer & Monitoring Susu Segar
PT Cisarua Mountain Dairy Tbk — CMD1 Plant Sentul 1

Menggantikan Power Apps Canvas App. Spesifikasi lengkap: [`docs/PRD-Migrasi-FM-Receiving.md`](docs/PRD-Migrasi-FM-Receiving.md).

Panduan lengkap untuk developer baru, termasuk alur pull-develop-push, tersedia di
[`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Stack

React 18 (Vite) · Node.js/Express · MySQL 8 · Docker Compose
Deployment: **server on-prem di pabrik** — tidak ada ketergantungan internet pada jalur kritis.

## Menjalankan (pengembangan)

```bash
# 1. Konfigurasi
cp .env.example .env      # lalu isi DB_PASSWORD, MYSQL_ROOT_PASSWORD, JWT_SECRET

# 2. Dependensi
npm install

# 3. Basis data
docker compose up -d mysql
npm run db:migrate
npm run db:seed

# 4. Jalankan
npm run dev:server        # http://localhost:3001
npm run dev:client        # http://localhost:5173
```

Verifikasi: buka http://localhost:5173 — panel Status Sistem harus menampilkan
server dan basis data terhubung.

### Catatan port

Mesin pengembang ini sudah menjalankan MySQL lain di **3306** dan aplikasi Node
lain di **3000**, sehingga proyek memakai port berbeda. Seluruhnya dapat
diubah lewat `.env` — di server on-prem, nilai bawaan boleh dipakai kembali.

| Layanan | Port | Env |
|---|---|---|
| API | 3001 | `PORT` |
| MySQL (host) | 3307 | `DB_HOST_PORT` · `DB_PORT` |
| Vite (dev) | 5173 | — |

Di dalam jaringan Docker, MySQL tetap 3306 — hanya pemetaan ke host yang berubah.

## Perintah

| Perintah | Keterangan |
|---|---|
| `npm test` | Uji server beserta laporan cakupan |
| `npm run test:watch` | Uji berkelanjutan |
| `npm run db:migrate` | Jalankan migrasi yang belum dijalankan |
| `npm run db:migrate -- --status` | Lihat status migrasi |
| `npm run db:reset` | **Hapus** basis data lalu bangun ulang |
| `npm run db:seed` | Isi master data |
| `npm run build` | Build klien untuk produksi |
| `npm run docker:up` | Nyalakan seluruh stack |

## Struktur

```
docs/         PRD & dokumentasi
reference/    YAML Power Apps + 20 file export (data uji emas)
db/           migrations · seeds
server/       Express API
  src/services/   ← business rule ada di sini, bukan di route
client/       React
deploy/       nginx.conf, sertifikat
```

## Aturan yang tidak boleh dilanggar

Tiga hal ini adalah alasan utama migrasi. Melanggarnya berarti mengulang
masalah yang sedang ditinggalkan.

**1. Setiap perubahan volume berjalan dalam satu transaksi.**
Gunakan `withTransaction()`. Power Apps melakukan 1 insert + N update berurutan,
sehingga gagal di tengah meninggalkan stok yang salah permanen (M-1).

**2. Alokasi FIFO mengunci barisnya lebih dulu.**
`SELECT ... FOR UPDATE` sebelum memanggil `allocateFifo()`. Tanpa itu, dua
operator yang menyubmit transfer dari silo yang sama tidak saling melihat (M-5).

**3. Wewenang diperiksa di endpoint, bukan di UI.**
Menyembunyikan tombol bukan otorisasi. Power Apps hanya memakai properti
`Visible`, sehingga siapa pun yang dapat memanggil operasi tulis dapat
menyetujui atau mem-void record (B-22).

Selain itu: seluruh `DATETIME` disimpan **UTC**; `audit_log` bersifat
**append-only** dan tidak pernah dihapus; volume silo **tidak pernah disimpan**
— selalu dibaca dari `v_silo_volume` (BR-01).

## Pengujian

Prioritas mengikuti akibat kegagalan (PRD 18.1). Lapis kritis —
`allocateFifo()`, reversal, cascade void, standing time — wajib 90% cakupan.

Invarian yang diperiksa setelah setiap operasi tulis:

```
Σ volume seluruh sistem sebelum operasi  ==  Σ sesudah operasi
```

Liter tidak boleh tercipta maupun lenyap.

`reference/export-samples/` berisi 20 hari data produksi nyata beserta form
yang sudah ditandatangani — dipakai sebagai **data uji emas** untuk uji replay
(PRD 18.2).

## Catatan OneDrive

Folder ini berada di dalam OneDrive. `node_modules` berisi puluhan ribu berkas
kecil yang membuat OneDrive tersinkronisasi terus-menerus dan sesekali mengunci
berkas saat `npm install`.

Kecualikan dari sinkronisasi:
**OneDrive → Settings → Account → Choose folders** → hapus centang `node_modules`.

Atau pindahkan repo ke luar OneDrive dan cukup simpan `docs/` di sana.

## Keamanan repository

Jangan commit `.env`, dump/backup database, data produksi di `reference/` atau
`ref/`, log, build, maupun paket release. Pola tersebut sudah tercantum di
`.gitignore`. Bagikan data sensitif dan secret melalui kanal internal yang
disetujui perusahaan, bukan melalui GitHub.

## Status

Fase 0 — fondasi. Rincian tugas per fase: PRD Lampiran E.
