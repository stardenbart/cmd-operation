# PRD Update — Losses Management, Analitik Improvement, Role Viewer

| | |
|---|---|
| **Produk** | FM Receiving — Sistem Penerimaan, Prepasteurisasi, Transfer & Monitoring Fresh Milk |
| **Dokumen induk** | PRD-Migrasi-FM-Receiving.md (v2, 25 Ags 2026) |
| **Penyusun** | Abdullah Farauk |
| **Tanggal** | 3 September 2026 |
| **Status** | Draft — menunggu validasi logic buffer loss |
| **Referensi** | losses-flowcharts.html (3 flow + cascade validation) |

---

## 1. Ringkasan Perubahan

Dokumen ini menambahkan **6 requirement baru** (FR-32 s/d FR-37) dan **5 business rule** (BR-26 s/d BR-30) ke PRD induk. Perubahan diurutkan dari yang paling kecil dan mandiri ke yang paling kompleks, sehingga setiap fase dapat dirilis dan diuji secara inkremental.

| Fase | FR | Nama | Estimasi | Prasyarat |
|---|---|---|---|---|
| **5a — Polish UI** | FR-32 | Perbaikan Visual: Icon Master Data & Densitas Import | 2 hari | — |
| **5b — Analitik: Sesi** | FR-33 | Pemisahan Sesi Prepast ke Dropdown Analitik | 4 hari | — |
| **5c — Role Viewer** | FR-34 | Peran Viewer + Hak Akses Custom | 5 hari | — |
| **5d — Losses Setting** | FR-35 | Losses Management (Setting & Master) | 5 hari | — |
| **5e — Losses Report** | FR-36 | Losses Report & Grafik | 5 hari | FR-35 |
| **5f — Losses Engine** | FR-37 | Losses Calculation Engine | 8 hari | FR-35, L-1 (saldo berjalan) |
| **Total** | | | **~29 hari kerja** | |

Setiap fase memiliki test case yang ditulis SEBELUM implementasi (TDD). Daftar test ada di Bagian 8.

---

## 2. FR-32 — Perbaikan Visual: Icon Master Data & Densitas Import

**Kategori: Polish UI. Kompleksitas: Rendah.**

Dua perbaikan visual yang tidak mengubah fungsionalitas maupun data.

### FR-32.1 Ganti Icon Master Data

| ID | Requirement | Prioritas |
|---|---|---|
| FR-32.1.1 | Icon navigasi "Master Data" diganti dari bentuk saat ini (menyerupai matahari/gear) ke bentuk **document/data file** — ikon yang lazim merepresentasikan master data / database catalog. | P1 |
| FR-32.1.2 | Icon baru tetap menggunakan SVG path tunggal di `GARIS_IKON`, konsisten dengan 14 ikon lainnya. | P0 |
| FR-32.1.3 | Tidak ada perubahan pada `viewBox="0 0 24 24"` maupun class `nav__ikon`. | P0 |

**Catatan implementasi.** Path saat ini:

```
master: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.5-6-1.5 1.5m-9 9L6 18m12 0-1.5-1.5m-9-9L6 6'
```

Ini adalah ikon gear/settings. Diganti ke ikon document-stack/data-file, misalnya:

```
master: 'M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 0v5h5M8 13h8M8 17h5M8 9h3'
```

Atau varian lain yang merepresentasikan "file dengan baris data" — keputusan visual akhir saat implementasi.

### FR-32.2 Perbaikan Densitas Teks Halaman Import

| ID | Requirement | Prioritas |
|---|---|---|
| FR-32.2.1 | Halaman Import Data (`ImportData.jsx`): setelah impor selesai, bagian **ringkasan import** (`import-ringkasan`) diberi jarak vertikal yang lebih longgar antar baris label–nilai. | P1 |
| FR-32.2.2 | Tabel pratinjau berkas: kolom "Catatan" yang menampilkan daftar kolom hilang diberi `word-break` dan `max-width` agar tidak mendorong tabel melampaui viewport. | P1 |
| FR-32.2.3 | Baris status per berkas pada tabel pratinjau diberi `padding` vertikal minimal `0.5rem` agar tidak terasa mepet. | P1 |
| FR-32.2.4 | Ringkasan import ditampilkan dalam layout `grid` 2 kolom (label kiri, nilai kanan), bukan inline list, untuk konsistensi dengan stat-tile pattern di Dashboard dan Analitik. | P2 |

**File terdampak:** `client/src/pages/ImportData.jsx`, `client/src/styles/app.css`.

---

## 3. FR-33 — Pemisahan Sesi Prepast ke Dropdown Analitik

**Kategori: Analitik Improvement. Kompleksitas: Sedang.**

Saat ini panel "Audit Sesi Prepast" berada di dalam halaman Analitik sebagai `<details>` yang terlipat di bawah grafik frekuensi record. Ini menyebabkan dua masalah: (1) sesi sulit ditemukan karena tersembunyi di antara grafik, (2) data sesi sangat besar (220+ sesi) yang membebani scroll halaman bahkan saat terlipat.

### FR-33.1 Dropdown Analitik

| ID | Requirement | Prioritas |
|---|---|---|
| FR-33.1.1 | Halaman `/analitik` menampilkan **dropdown/selector** di atas filter untuk memilih mode tampilan. Opsi awal: **"Ringkasan & Tren"** (tampilan saat ini tanpa sesi) dan **"Sesi Prepast"** (tampilan baru). | P0 |
| FR-33.1.2 | Dropdown menggunakan komponen `<select>` atau button-group konsisten dengan pattern filter yang sudah ada (seperti preset waktu). | P0 |
| FR-33.1.3 | Mode yang sedang aktif dipertahankan sebagai query parameter `?mode=ringkasan` / `?mode=sesi` agar dapat di-bookmark dan di-share. | P1 |
| FR-33.1.4 | Mode baru di masa depan (misalnya "Losses Report", FR-36) dapat ditambahkan sebagai opsi dropdown tambahan tanpa mengubah struktur. | P0 |

### FR-33.2 Filter Sesi

| ID | Requirement | Prioritas |
|---|---|---|
| FR-33.2.1 | Mode "Sesi Prepast" menggunakan **filter yang sama** dengan mode Ringkasan: rentang waktu (preset + custom), filter silo (multi-select). | P0 |
| FR-33.2.2 | Mengubah mode TIDAK mereset filter — filter yang sudah diterapkan dipertahankan. | P0 |

### FR-33.3 Tampilan Sesi Prepast

Setiap sesi ditampilkan sebagai kartu/section terpisah, diurutkan kronologis (terbaru di atas). Konten per sesi:

| ID | Requirement | Prioritas |
|---|---|---|
| FR-33.3.1 | **Header sesi**: ID sesi · Nama SILO · Rentang waktu (start – finish) · Total volume (L) · Jumlah record. | P0 |
| FR-33.3.2 | **Dua tabel terpisah per silo** yang terlibat dalam sesi, dengan gap visual yang cukup (minimal `1.5rem`) antar tabel dan antar sesi: | P0 |

**Tabel IN (Masuk ke SILO):**

| Kolom | Sumber | Keterangan |
|---|---|---|
| **Jam** | `prepast_start` (WIB) | Waktu mulai prepast masuk ke silo |
| **Supplier** | `supplier.nama` via FIFO allocation | Supplier asal batch yang masuk |

**Tabel OUT (Keluar dari SILO):**

| Kolom | Sumber | Keterangan |
|---|---|---|
| **Volume** | `transfer.volume_liter` | Volume yang ditarik |
| **Standing Time** | Kalkulasi dari `prepast_end` ke `transfer_created_at` | Durasi FM di silo |
| **TS (%)** | `transfer.ts_persen` — dari form release QC | Nilai TS hasil lab |
| **Jam** | `transfer.created_at` (WIB) | Waktu transfer keluar |
| **Kemana?** | `tank_master.nama` | Tujuan: MT/CMD2/Pindah Silo |

| ID | Requirement | Prioritas |
|---|---|---|
| FR-33.3.3 | Judul NAMA SILO ditampilkan sebagai heading (`h3` atau `h4`) di atas kedua tabel, dengan background subtle (`accent-light`) agar mudah di-scan. | P0 |
| FR-33.3.4 | Tabel IN dan OUT **tidak digabung** menjadi satu tabel — keduanya terpisah secara visual karena jumlah baris dan konteks berbeda. | P0 |
| FR-33.3.5 | Gap antar baris record dalam sesi minimal `0.35rem` — tidak boleh terlalu rapat sehingga sulit dibaca. | P1 |
| FR-33.3.6 | Jika satu sesi melibatkan lebih dari satu SILO (switching), masing-masing SILO mendapat section sendiri di dalam kartu sesi yang sama. | P0 |
| FR-33.3.7 | Tampilan tabel mengikuti pattern `TabelGrafik` yang sudah ada di `grafik.jsx` — angka rata kanan, teks rata kiri, header sticky. | P1 |
| FR-33.3.8 | Sesi yang sedang kontinu (belum ada `prepast_end` final) ditandai lencana "Sedang Berjalan" dengan warna status `--status-warning`. | P1 |

### FR-33.4 Perubahan Server

| ID | Requirement | Prioritas |
|---|---|---|
| FR-33.4.1 | Endpoint `/api/v1/analitik` menerima parameter `mode` opsional. `mode=sesi` mengembalikan data sesi terstruktur per SILO alih-alih grafik agregat. Default tetap `ringkasan`. | P0 |
| FR-33.4.2 | Data sesi di-query dari `prepast_record` JOIN `transfer` JOIN `supplier` JOIN `tank_master`, dengan filter waktu dan silo yang sama. | P0 |
| FR-33.4.3 | Pengelompokan sesi menggunakan logika `kontinuitasPrepast.js` yang sudah ada — gap < 1 jam = sesi sama. | P0 |

**File terdampak:** `server/src/routes/analitik.js`, `server/src/services/analitik.js`, `client/src/pages/Analitik.jsx`.

---

## 4. FR-34 — Peran Viewer + Hak Akses Custom

**Kategori: Authorization. Kompleksitas: Sedang.**

### FR-34.1 Peran Baru: Viewer

| ID | Requirement | Prioritas |
|---|---|---|
| FR-34.1.1 | Ditambahkan peran **Viewer** di `PERAN` dan `MATRIKS` di `auth/permissions.js`. | P0 |
| FR-34.1.2 | Viewer secara default hanya berwenang atas `dashboard:lihat`. Ini memberikan akses ke: Dashboard, Analitik, Data (read-only), dan Panduan — sesuai `MENU` filtering yang sudah ada. | P0 |
| FR-34.1.3 | Viewer **tidak** memiliki akses default ke: transaksi (receiving/prepast/monitoring/transfer/pengembalian), approval, koreksi, void, stock opname, master data, export, import. | P0 |

Matriks lengkap peran Viewer:

| Aksi | Viewer |
|---|---|
| `transaksi:buat` | ✗ |
| `transaksi:sunting_pending` | ✗ |
| `transaksi:sunting_approved` | ✗ |
| `koreksi:ajukan` | ✗ |
| `koreksi:tinjau` | ✗ |
| `approval:putuskan` | ✗ |
| `approval:massal` | ✗ |
| `record:void` | ✗ |
| `record:void_sendiri` | ✗ |
| `stock_opname:kelola` | ✗ |
| `export:jalankan` | ✗ |
| `master:kelola` | ✗ |
| `dashboard:lihat` | ✓ |

### FR-34.2 Hak Akses Custom (Permission Override)

Untuk menangani kebutuhan di mana Viewer tertentu perlu mengakses fitur di luar perannya (misalnya: seorang manajer yang ingin melihat Export tetapi tidak perlu melakukan transaksi), disediakan mekanisme **hak akses custom per user**.

| ID | Requirement | Prioritas |
|---|---|---|
| FR-34.2.1 | Tabel `operator` ditambah kolom `custom_permissions` bertipe `JSON` (nullable, default `NULL`). Berisi array string aksi tambahan yang diberikan di luar matriks peran. | P0 |
| FR-34.2.2 | Fungsi `can(peran, aksi)` di `permissions.js` diubah menjadi `can(peran, aksi, customPermissions)` — mengembalikan `true` jika matriks mengizinkan ATAU aksi ada di `customPermissions`. | P0 |
| FR-34.2.3 | Custom permissions **hanya menambah**, tidak pernah mengurangi. Aksi yang sudah diizinkan oleh matriks peran tidak dapat dicabut melalui custom permissions. | P0 |
| FR-34.2.4 | Custom permissions disimpan di JWT claim `cp` (array string, hanya jika non-empty) agar tidak perlu query DB pada setiap request. | P0 |
| FR-34.2.5 | `aksiUntukPeran(peran)` → `aksiUntukUser(peran, customPermissions)` — mengembalikan gabungan aksi matriks + custom, dipakai klien untuk filter menu. | P0 |

### FR-34.3 UI Pengaturan Hak Akses

| ID | Requirement | Prioritas |
|---|---|---|
| FR-34.3.1 | Pada halaman Master Data > Manajemen User (`/admin/master/users`), form edit user menampilkan section **"Hak Akses Tambahan"** berupa daftar checkbox dari seluruh `AKSI` yang TIDAK dimiliki peran user tersebut. | P0 |
| FR-34.3.2 | Checkbox di-group berdasarkan kategori: Transaksi, Persetujuan, Pembatalan, Administratif. | P1 |
| FR-34.3.3 | Perubahan hak akses custom tercatat di `audit_log` dengan nilai sebelum & sesudah. | P0 |
| FR-34.3.4 | Hanya Admin yang dapat mengatur custom permissions (mengikuti `master:kelola`). | P0 |
| FR-34.3.5 | Saat peran user diubah (misalnya Viewer → Operator), custom permissions yang sudah dimiliki secara default oleh peran baru dibersihkan otomatis untuk menghindari redundansi. | P1 |
| FR-34.3.6 | Custom permissions yang aktif ditampilkan sebagai lencana di daftar user, agar Admin tahu siapa yang punya pengecualian. | P1 |

### FR-34.4 Perubahan Skema

```sql
ALTER TABLE operator
  ADD COLUMN custom_permissions JSON DEFAULT NULL
  COMMENT 'Array aksi tambahan di luar matriks peran, e.g. ["export:jalankan","stock_opname:kelola"]';
```

### FR-34.5 Dampak ke Alur Login

| ID | Requirement | Prioritas |
|---|---|---|
| FR-34.5.1 | Saat login, `auth/service.js` membaca `custom_permissions` dari tabel `operator` dan menyertakannya di JWT (`cp` claim). | P0 |
| FR-34.5.2 | Middleware `wajibWewenang(aksi)` membaca `req.user.cp` dan meneruskannya ke `can()`. | P0 |
| FR-34.5.3 | Endpoint `/api/v1/auth/me` mengembalikan `customPermissions` agar klien dapat menghitung menu yang tersedia. | P0 |
| FR-34.5.4 | Perubahan custom permissions berlaku pada sesi berikutnya (konsisten dengan FR-26.2.7). | P1 |

**File terdampak:** `server/src/auth/permissions.js`, `server/src/auth/service.js`, `server/src/auth/tokens.js`, `server/src/middleware/auth.js`, `server/src/services/masterData.js`, `server/src/routes/master.js`, `client/src/pages/Master.jsx`, `client/src/lib/auth.jsx`, `client/src/App.jsx`, `db/migrations/`.

---

## 5. FR-35 — Losses Management (Setting & Master)

**Kategori: Modul Baru. Kompleksitas: Sedang–Tinggi.**

Modul konfigurasi untuk 27 titik losses pada proses FM. Setiap titik memiliki volume tetap yang dicatat saat proses berjalan. Logic flow losses didokumentasikan di `ref/losses-flowcharts.html`.

### FR-35.1 Tabel Loss Point

```sql
CREATE TABLE loss_point (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kode            VARCHAR(10) NOT NULL UNIQUE COMMENT 'e.g. LP-01',
  nama            VARCHAR(120) NOT NULL COMMENT 'Nama titik loss',
  kategori        ENUM('receiving','prepast','switching','buffer','penarikan')
                  NOT NULL,
  volume_liter    DECIMAL(8,2) NOT NULL COMMENT 'Volume loss per satuan',
  satuan          ENUM('per_penarikan','per_transfer') NOT NULL
                  COMMENT 'Kapan loss terjadi',
  calculation_type ENUM('fixed_per_record','fixed_per_frequency_prepast','manual_input')
                  NOT NULL DEFAULT 'fixed_per_record'
                  COMMENT 'Cara menghitung frekuensi',
  aktif           BOOLEAN NOT NULL DEFAULT TRUE,
  catatan         TEXT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_kategori (kategori),
  INDEX idx_aktif (aktif)
) COMMENT='Master 27 titik losses FM';
```

### FR-35.2 Snapshot Versi (Historical Toggle)

| ID | Requirement | Prioritas |
|---|---|---|
| FR-35.2.1 | Tabel `loss_point_version` menyimpan snapshot konfigurasi loss point setiap kali terjadi perubahan (aktif/nonaktif, volume, satuan). | P0 |
| FR-35.2.2 | Setiap cutoff report mereferensi `loss_point_version_id` yang berlaku pada saat itu — bukan konfigurasi terkini — sehingga laporan historis tetap akurat meskipun konfigurasi berubah kemudian. | P0 |
| FR-35.2.3 | Perubahan konfigurasi tercatat di `audit_log`. | P0 |

```sql
CREATE TABLE loss_point_version (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  snapshot        JSON NOT NULL COMMENT 'Salinan seluruh loss_point yang aktif saat snapshot diambil',
  berlaku_sejak   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dibuat_oleh     INT UNSIGNED NOT NULL,
  catatan         VARCHAR(255) DEFAULT NULL,

  FOREIGN KEY (dibuat_oleh) REFERENCES operator(id)
) COMMENT='Versi historis konfigurasi loss point';
```

### FR-35.3 Seed Data (27 Loss Points)

| Kode | Nama | Kategori | Volume (L) | Satuan | Calculation Type |
|---|---|---|---|---|---|
| LP-01 | TF ke Tanki Timbang | receiving | 1.8 | per_penarikan | fixed_per_record |
| LP-02 | TF Tanki Timbang ke Silo 7 | receiving | 1.8 | per_penarikan | fixed_per_record |
| LP-03 | Dorongan Awal Silo 7 → Silo 1 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-04 | Dorongan Awal Silo 7 → Silo 2 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-05 | Dorongan Awal Silo 7 → Silo 3 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-06 | Dorongan Awal Silo 7 → Silo 6 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-07 | Dorongan Awal Silo 7 → Silo 25A | prepast | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-08 | Dorongan Awal Silo 7 → Silo 25B | prepast | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-09 | Dorongan Akhir Silo 1 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-10 | Dorongan Akhir Silo 2 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-11 | Dorongan Akhir Silo 3 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-12 | Dorongan Akhir Silo 6 | prepast | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-13 | Dorongan Akhir Silo 25A | prepast | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-14 | Dorongan Akhir Silo 25B | prepast | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-15 | Switching Silo 1 | switching | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-16 | Switching Silo 2 | switching | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-17 | Switching Silo 3 | switching | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-18 | Switching Silo 6 | switching | 4.5 | per_transfer | fixed_per_frequency_prepast |
| LP-19 | Switching Silo 25A | switching | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-20 | Switching Silo 25B | switching | 45.0 | per_transfer | fixed_per_frequency_prepast |
| LP-21 | Sisa tertahan Silo 7 (Buffer) | buffer | 25.4 | per_transfer | fixed_per_frequency_prepast |
| LP-22 | Penarikan dari Silo 25A | penarikan | 28.0 | per_penarikan | fixed_per_record |
| LP-23 | Penarikan dari Silo 25B | penarikan | 35.0 | per_penarikan | fixed_per_record |
| LP-24 | Penarikan dari Silo 1 | penarikan | 2.8 | per_penarikan | fixed_per_record |
| LP-25 | Penarikan dari Silo 2 | penarikan | 0.8 | per_penarikan | fixed_per_record |
| LP-26 | Penarikan dari Silo 3 | penarikan | 1.8 | per_penarikan | fixed_per_record |
| LP-27 | Penarikan dari Silo 6 | penarikan | 2.5 | per_penarikan | fixed_per_record |

**Catatan:** LP-01 (TF ke Tanki Timbang) di-seed sebagai `aktif = false` — berdasarkan keputusan bahwa loss point ini tidak perlu di-include.

### FR-35.4 Halaman Losses Management

| ID | Requirement | Prioritas |
|---|---|---|
| FR-35.4.1 | Halaman baru di bawah menu Master Data atau sebagai menu terpisah: `/losses` atau `/admin/master/losses`. Route disematkan di bawah dropdown Analitik sebagai opsi "Losses Setting". | P0 |
| FR-35.4.2 | Tampilan daftar loss point dikelompokkan per kategori (Receiving, Prepast, Switching, Buffer, Penarikan). Setiap kategori memiliki heading. | P0 |
| FR-35.4.3 | Setiap baris menampilkan: kode, nama, volume (L), satuan, calculation type, toggle aktif/nonaktif. | P0 |
| FR-35.4.4 | Toggle aktif/nonaktif menghasilkan konfirmasi dialog sebelum disimpan, karena berdampak pada kalkulasi losses berikutnya. | P0 |
| FR-35.4.5 | Volume dan satuan dapat disunting inline (double-click atau tombol edit). Perubahan memicu snapshot versi baru (`loss_point_version`). | P0 |
| FR-35.4.6 | Riwayat perubahan tiap loss point dapat dilihat (pattern sama dengan Master Data — tombol "Riwayat" per baris). | P1 |
| FR-35.4.7 | Akses dibatasi pada peran Admin (`master:kelola`). | P0 |

### FR-35.5 API Endpoints

| Method | Path | Aksi | Middleware |
|---|---|---|---|
| GET | `/api/v1/losses/points` | Daftar loss point + status aktif | `wajibLogin` |
| GET | `/api/v1/losses/points/:id` | Detail satu loss point + riwayat | `wajibLogin` |
| PATCH | `/api/v1/losses/points/:id` | Sunting volume/satuan/aktif | `wajibWewenang('master:kelola')` |
| POST | `/api/v1/losses/versions` | Buat snapshot versi (otomatis saat PATCH) | `wajibWewenang('master:kelola')` |
| GET | `/api/v1/losses/versions` | Daftar snapshot versi | `wajibLogin` |
| GET | `/api/v1/losses/versions/:id` | Detail snapshot | `wajibLogin` |

**File baru:** `server/src/services/losses.js`, `server/src/routes/losses.js`, `client/src/pages/LossesManagement.jsx`, `db/migrations/xxx_create_loss_tables.js`.

---

## 6. FR-36 — Losses Report & Grafik

**Kategori: Analitik — Modul Baru. Kompleksitas: Sedang–Tinggi. Prasyarat: FR-35.**

### FR-36.1 Posisi di Dropdown Analitik

| ID | Requirement | Prioritas |
|---|---|---|
| FR-36.1.1 | Dropdown analitik (FR-33.1.1) mendapat opsi ketiga: **"Losses Report"**. Urutannya: Ringkasan & Tren → Sesi Prepast → Losses Report. | P0 |
| FR-36.1.2 | Mode "Losses Report" menggunakan **filter yang sama** dengan mode lain: rentang waktu dan filter silo. | P0 |
| FR-36.1.3 | Ditambah filter opsional: **"Periode Agregasi"** — pilihan Daily, Weekly, Monthly, Yearly. Default: Daily. | P0 |
| FR-36.1.4 | Ditambah filter opsional: **"Kategori Loss"** — multi-select checkbox: Receiving, Prepast, Switching, Buffer, Penarikan. Default: semua. | P1 |

### FR-36.2 Tampilan Ringkasan Losses

| ID | Requirement | Prioritas |
|---|---|---|
| FR-36.2.1 | Baris ringkasan stat-tile: Total Losses (L) periode, Delta vs periode sebelumnya, Losses Rate (%), Jumlah titik aktif. | P0 |
| FR-36.2.2 | Formula Losses Rate: `Volume Losses / (Saldo awal setelah SO + Volume Receiving Total − Volume Aktual Fisik)`. Ditampilkan sebagai persentase. | P0 |
| FR-36.2.3 | Jika L-1 (saldo berjalan) belum tersedia, Losses Rate ditampilkan sebagai "—" dengan tooltip "Membutuhkan fitur Saldo Berjalan (L-1)". | P0 |

### FR-36.3 Grafik Perbandingan Losses

| ID | Grafik | Bentuk | Menjawab |
|---|---|---|---|
| FR-36.3.1 | **Tren losses per periode** | `Garis` multi-seri (per kategori) | "Bagaimana tren losses dari waktu ke waktu?" |
| FR-36.3.2 | **Losses per kategori** | `BatangBertumpuk` vertikal, satu bar per periode | "Kategori mana penyumbang losses terbesar?" |
| FR-36.3.3 | **Losses per SILO** | `Batang` horizontal, terurut | "SILO mana dengan losses tertinggi?" |
| FR-36.3.4 | **Breakdown losses harian** | `Heatmap` hari × kategori | "Hari apa losses menumpuk?" |
| FR-36.3.5 | **Frekuensi switching** | `Batang` vertikal per periode | "Seberapa sering terjadi switching?" |
| FR-36.3.6 | **Perbandingan periodik** | `Garis` overlay dua periode (periode berjalan vs sebelumnya) | "Apakah losses membaik?" |

| ID | Requirement | Prioritas |
|---|---|---|
| FR-36.3.7 | Seluruh grafik mengikuti aturan visual FR-27.5 (Okabe-Ito, entity-based coloring, no dual Y-axis). | P0 |
| FR-36.3.8 | Setiap grafik memiliki tampilan tabel setara (`TabelGrafik`), konsisten dengan FR-27.1.4. | P0 |
| FR-36.3.9 | Aggregasi per periode (daily/weekly/monthly/yearly) berlaku ke seluruh grafik serentak — mengubah satu filter memperbarui semuanya. | P0 |

### FR-36.4 API Endpoints

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/v1/analitik?mode=losses` | Data losses agregat per periode + breakdown |

Atau terpisah:

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/v1/losses/report` | Data losses agregat per filter |
| GET | `/api/v1/losses/report/excel` | Export losses report ke Excel |

**File baru/terdampak:** `server/src/services/lossesReport.js`, `server/src/routes/analitik.js` atau `routes/losses.js`, `client/src/pages/Analitik.jsx`, `client/src/components/grafik.jsx` (jika perlu chart baru).

---

## 7. FR-37 — Losses Calculation Engine

**Kategori: Business Logic. Kompleksitas: Tinggi. Prasyarat: FR-35, L-1 (saldo berjalan).**

Engine yang menghitung frekuensi dan total losses berdasarkan data transaksi aktual dan konfigurasi loss point. Dijalankan **on-demand saat cutoff report**, bukan real-time.

### FR-37.1 Tabel Hasil Kalkulasi

```sql
CREATE TABLE loss_calculation (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loss_point_id         INT UNSIGNED NOT NULL,
  loss_point_version_id INT UNSIGNED NOT NULL,
  periode_mulai         DATE NOT NULL,
  periode_selesai       DATE NOT NULL,
  frekuensi             INT UNSIGNED NOT NULL DEFAULT 0,
  volume_per_satuan     DECIMAL(8,2) NOT NULL,
  total_volume          DECIMAL(10,2) NOT NULL COMMENT 'frekuensi × volume_per_satuan',
  detail                JSON DEFAULT NULL COMMENT 'Rincian record yang berkontribusi',
  dihitung_pada         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dihitung_oleh         INT UNSIGNED NOT NULL,

  FOREIGN KEY (loss_point_id) REFERENCES loss_point(id),
  FOREIGN KEY (loss_point_version_id) REFERENCES loss_point_version(id),
  FOREIGN KEY (dihitung_oleh) REFERENCES operator(id),

  INDEX idx_periode (periode_mulai, periode_selesai),
  INDEX idx_loss_point (loss_point_id)
) COMMENT='Hasil kalkulasi losses per titik per periode';
```

### FR-37.2 Logika Kalkulasi per Calculation Type

#### `fixed_per_record`

| ID | Requirement | Prioritas |
|---|---|---|
| FR-37.2.1 | Frekuensi = jumlah record transaksi yang approved pada periode. Untuk kategori `receiving`: jumlah record penerimaan. Untuk `penarikan`: jumlah record transfer keluar per SILO asal. | P0 |
| FR-37.2.2 | Total volume = frekuensi × `loss_point.volume_liter`. | P0 |

#### `fixed_per_frequency_prepast`

Ini adalah tipe kalkulasi yang paling kompleks. Frekuensi ditentukan oleh algoritma sesi prepast (lihat `losses-flowcharts.html` Flow 2).

| ID | Requirement | Prioritas |
|---|---|---|
| FR-37.2.3 | **Dorongan Awal**: frekuensi = jumlah kali SILO target menjadi SILO aktif dalam sesi prepast (setiap kali sesi baru dimulai, atau switching ke SILO baru, atau resume setelah gap ≥ 1 jam). | P0 |
| FR-37.2.4 | **Dorongan Akhir**: frekuensi = jumlah kali SILO selesai dipakai (sebelum switching, sebelum gap, atau akhir sesi). Pada satu sesi kontinu, dorongan akhir = dorongan awal = jumlah SILO yang dipakai. | P0 |
| FR-37.2.5 | **Switching**: frekuensi = jumlah kali terjadi pergantian SILO. Switching terjadi hanya jika SILO berubah — resume ke SILO sama setelah gap BUKAN switching. | P0 |
| FR-37.2.6 | **Buffer Loss** (LP-21): frekuensi = jumlah kali gap ≥ 1 jam terjadi antar sesi prepast (FM diam di buffer > 1 jam = buang). **⚠ Catatan: logika ini perlu validasi follow-up dengan user/operator.** | P0 |
| FR-37.2.7 | **Toleransi kontinu**: gap antara `prepast_end` record sebelumnya dan `prepast_start` record baru < 1 jam → kontinu (prepast tetap looping/berputar). | P0 |

#### `manual_input`

| ID | Requirement | Prioritas |
|---|---|---|
| FR-37.2.8 | Disiapkan untuk v2. Pada MVP, tidak ada loss point yang menggunakan tipe ini. | P2 |

### FR-37.3 Service Layer

| ID | Requirement | Prioritas |
|---|---|---|
| FR-37.3.1 | `services/lossesEngine.js` — fungsi murni `hitungLosses(periode, lossPointConfig, transaksiData)` tanpa I/O, menerima data yang sudah di-query. Mengikuti pattern `allocateFifo()`. | P0 |
| FR-37.3.2 | Logika sesi prepast pada engine menggunakan `kontinuitasPrepast.js` yang sudah ada, diperluas untuk menghasilkan frekuensi dorongan, switching, dan buffer. | P0 |
| FR-37.3.3 | Kalkulasi dijalankan on-demand via endpoint atau tombol "Hitung Ulang" di halaman Losses Report. | P0 |
| FR-37.3.4 | Hasil kalkulasi disimpan ke `loss_calculation` dan di-snapshot sehingga kalkulasi berikutnya tidak menimpa yang sebelumnya tanpa jejak. | P0 |

### FR-37.4 Cascade Validation Rule

| ID | Requirement | Prioritas |
|---|---|---|
| FR-37.4.1 | Pada satu sesi kontinu (semua gap < 1 jam), untuk N SILO yang dipakai: dorongan awal = N, dorongan akhir = N, switching = N − 1, buffer = 0. | P0 |
| FR-37.4.2 | Pada sesi terputus (gap ≥ 1 jam): buffer loss = jumlah gap ≥ 1 jam, setiap gap menghasilkan dorongan akhir (SILO sebelumnya) + buffer loss + cek SILO sama/beda (switching hanya jika beda). | P0 |

**File baru:** `server/src/services/lossesEngine.js`, `server/src/services/lossesEngine.test.js`.

---

## 8. Strategi Pengujian (TDD)

Seluruh test ditulis SEBELUM implementasi. Urutan test mengikuti urutan fase.

### 8.1 FR-32 — Polish UI

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-40 | Icon "master" di `GARIS_IKON` menghasilkan SVG path yang valid dan bukan ikon gear/settings | Unit |
| T-41 | Halaman Import: ringkasan import memiliki row-gap ≥ 0.5rem dan layout grid 2 kolom | Visual (manual) |

### 8.2 FR-33 — Sesi Prepast

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-42 | `/analitik?mode=sesi` mengembalikan data sesi terstruktur per SILO | Integrasi |
| T-43 | Filter waktu dan silo diterapkan benar pada mode sesi | Integrasi |
| T-44 | Sesi ditampilkan dengan 2 tabel terpisah (IN dan OUT) per SILO | Integrasi |
| T-45 | Switching ke mode sesi tidak mereset filter yang sudah diterapkan | Unit (client) |

### 8.3 FR-34 — Role Viewer

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-46 | Peran Viewer hanya berwenang atas `dashboard:lihat` — seluruh aksi lain ditolak | Unit |
| T-47 | `can('Viewer', aksi, ['export:jalankan'])` mengembalikan `true` untuk `export:jalankan` | Unit |
| T-48 | Custom permissions di JWT diteruskan ke middleware otorisasi | Integrasi |
| T-49 | Endpoint yang dilindungi menolak Viewer tanpa custom permission, menerima Viewer dengan custom permission yang sesuai | Integrasi |
| T-50 | Admin dapat menambah dan menghapus custom permissions via `/admin/master/users` | Integrasi |
| T-51 | Perubahan peran membersihkan custom permissions yang redundan | Unit |

### 8.4 FR-35 — Losses Setting

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-52 | Seed menghasilkan 27 loss point dengan data yang benar | Integrasi |
| T-53 | Toggle aktif/nonaktif loss point menghasilkan snapshot versi baru | Integrasi |
| T-54 | Sunting volume loss point menghasilkan snapshot versi baru | Integrasi |
| T-55 | Riwayat perubahan loss point tercatat di `audit_log` | Integrasi |
| T-56 | Non-Admin ditolak saat mengakses PATCH `/losses/points/:id` | Integrasi |
| T-57 | LP-01 di-seed sebagai `aktif = false` | Unit |

### 8.5 FR-36 — Losses Report

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-58 | `/losses/report` mengembalikan data losses agregat per periode yang diminta | Integrasi |
| T-59 | Filter daily/weekly/monthly/yearly menghasilkan bucket yang benar | Unit |
| T-60 | Filter kategori hanya menyertakan loss point dari kategori yang dipilih | Unit |
| T-61 | Grafik mengikuti aturan visual FR-27.5 (entity-based coloring) | Visual (manual) |
| T-62 | Export Excel losses report menghasilkan file yang valid | Integrasi |

### 8.6 FR-37 — Losses Engine

| Test ID | Deskripsi | Jenis |
|---|---|---|
| T-63 | `hitungLosses()` — `fixed_per_record` menghasilkan frekuensi = jumlah record approved | Unit |
| T-64 | `hitungLosses()` — sesi kontinu 3 SILO: dorongan awal = 3, akhir = 3, switching = 2, buffer = 0 | Unit |
| T-65 | `hitungLosses()` — gap ≥ 1 jam menghasilkan buffer loss + dorongan akhir sebelum gap | Unit |
| T-66 | `hitungLosses()` — resume ke SILO sama setelah gap: switching = 0, dorongan awal = 1 | Unit |
| T-67 | `hitungLosses()` — resume ke SILO beda setelah gap: switching = 1, dorongan awal = 1 | Unit |
| T-68 | `hitungLosses()` — record pertama sesi: hanya dorongan awal, tidak ada dorongan akhir | Unit |
| T-69 | `hitungLosses()` — cascade A→B→C→A (kembali ke A): dorongan awal = 4, switching = 3 | Unit |
| T-70 | Hasil kalkulasi mereferensi `loss_point_version_id` yang berlaku, bukan konfigurasi terkini | Integrasi |
| T-71 | Bandingkan hasil engine dengan perhitungan manual 5 hari data historis | Integrasi (golden data) |

---

## 9. Business Rules Baru

| ID | Rule | Berlaku pada |
|---|---|---|
| BR-26 | Viewer hanya berhak melihat Dashboard, Analitik, Data (read-only), dan Panduan. Transaksi, approval, void, stock opname, master, export, dan import tidak tersedia kecuali diberi hak akses custom. | FR-34 |
| BR-27 | Custom permissions bersifat aditif — hanya menambah wewenang di luar matriks peran, tidak pernah mengurangi. | FR-34 |
| BR-28 | Perubahan konfigurasi loss point (aktif/nonaktif, volume, satuan) menghasilkan snapshot versi baru yang menjadi referensi laporan ke depan. Laporan historis tetap merujuk snapshot saat laporan dibuat. | FR-35 |
| BR-29 | Toleransi kontinu prepast: gap antara `prepast_end` dan `prepast_start` baru < 1 jam = kontinu (prepast tetap looping). Gap ≥ 1 jam = sesi terputus, memicu buffer loss. | FR-37 |
| BR-30 | Switching loss hanya terjadi saat SILO target berubah — resume ke SILO sama setelah gap BUKAN switching. | FR-37 |

---

## 10. Perubahan Navigasi

### 10.1 Menu Utama (MENU array di App.jsx)

Perubahan pada `MENU`:

| No | Perubahan | Detail |
|---|---|---|
| 1 | **Ganti ikon Master Data** | `ikon: 'master'` → path SVG baru (document/data-file) |
| 2 | **Dropdown Analitik** | Menu "Analitik" menjadi entry point ke dropdown dengan 3 mode: Ringkasan & Tren, Sesi Prepast, Losses Report |
| 3 | **Losses Setting** | Ditambah sebagai sub-item di bawah Master Data: `{ ke: '/master/losses', label: 'Losses Setting', ikon: 'master', aksi: 'master:kelola' }`. Atau sebagai opsi di dropdown Analitik — keputusan akhir saat implementasi. |

### 10.2 Peran Viewer di MENU

Viewer melihat menu yang difilter oleh `boleh(m.aksi)`:

| Menu | Aksi | Viewer (default) | Viewer + custom |
|---|---|---|---|
| Dashboard | `dashboard:lihat` | ✓ | ✓ |
| Analitik | `dashboard:lihat` | ✓ | ✓ |
| Data | `dashboard:lihat` | ✓ | ✓ |
| Panduan | `dashboard:lihat` | ✓ | ✓ |
| Export | `dashboard:lihat` | ✓ | ✓ |
| Approval | `dashboard:lihat` | ✓ | ✓ |
| Permintaan Koreksi | `dashboard:lihat` | ✓ | ✓ |
| Penerimaan–Pengembalian | `transaksi:buat` | ✗ | Jika diberi `transaksi:buat` |
| Stock Opname | `stock_opname:kelola` | ✗ | Jika diberi `stock_opname:kelola` |
| Master Data | `master:kelola` | ✗ | Jika diberi `master:kelola` |
| Import Data | `master:kelola` | ✗ | Jika diberi `master:kelola` |

**Catatan:** Menu Approval, Permintaan Koreksi, Export, dan Data menggunakan aksi `dashboard:lihat` sehingga Viewer secara default melihatnya. Namun **tindakan** di dalamnya (approve, void, export Excel) tetap dijaga oleh endpoint-level middleware. Viewer dapat melihat data tetapi tidak dapat melakukan tindakan.

---

## 11. Roadmap Tambahan

Fase 5a–5f ditambahkan setelah Fase 4 (go-live). Penomoran melanjutkan roadmap induk.

| Fase | Durasi | Isi | Milestone | Prasyarat |
|---|---|---|---|---|
| **5a — Polish UI** | 2 hari | FR-32: Icon master data, densitas import | Visual konsisten | — |
| **5b — Sesi Analitik** | 4 hari | FR-33: Dropdown analitik, tampilan sesi IN/OUT | Sesi terpisah dan terbaca | — |
| **5c — Role Viewer** | 5 hari | FR-34: Peran Viewer, custom permissions, UI setting | Role baru production-ready | — |
| **5d — Losses Setting** | 5 hari | FR-35: Tabel loss point, seed 27 data, halaman setting, snapshot versi | Konfigurasi losses siap | — |
| **5e — Losses Report** | 5 hari | FR-36: Halaman report, 6 grafik, filter periodik, export | Losses tervisualisasi | FR-35 |
| **5f — Losses Engine** | 8 hari | FR-37: Kalkulasi frekuensi & volume losses, golden-data test | Losses terhitung otomatis | FR-35, L-1 |
| **Total tambahan** | **~29 hari** | | | |

5a, 5b, 5c, dan 5d **dapat dikerjakan paralel** karena tidak saling bergantung. Jalur kritis: 5d → 5e → 5f.

---

## 12. Risiko Tambahan

| ID | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| R-10 | Logika buffer loss belum tervalidasi oleh operator lapangan | Sedang | Flowchart diberi remark "Perlu FU ke user". Implementasi FR-37 tidak dimulai sebelum validasi selesai. |
| R-11 | Custom permissions memperluas attack surface otorisasi | Sedang | Custom permissions bersifat aditif saja. Test T-49 memverifikasi penolakan tanpa permission. Review matriks setiap penambahan aksi baru. |
| R-12 | FR-37 bergantung pada L-1 (saldo berjalan) untuk Losses Rate | Rendah | Losses Rate ditampilkan "—" jika L-1 belum ada. Frekuensi dan volume tetap dihitung tanpa L-1. |
| R-13 | 27 loss point di-seed sebagai data tetap — jika pabrik berubah konfigurasi pipa, seed tidak cukup | Rendah | Halaman setting FR-35 memungkinkan Admin menambah/mengubah loss point. Snapshot versi menjaga integritas historis. |

---

## 13. Keputusan Terbuka

| ID | Keputusan | Status | Catatan |
|---|---|---|---|
| D-19 | Validasi logika buffer loss (LP-21) dengan operator lapangan — apakah FM > 1 jam di buffer = selalu dibuang? | **Terbuka** | Flowchart sudah diberi remark. Harus ditutup sebelum FR-37. |
| D-20 | Posisi menu Losses Setting: di bawah Master Data atau di dropdown Analitik? | **Terbuka** | Keduanya valid. Master Data lebih tepat secara fungsional (setting/configuration). Dropdown Analitik lebih mudah ditemukan user yang sedang melihat report. |
| D-21 | LP-01 (TF ke Tanki Timbang): konfirmasi tetap non-aktif? | **Tertutup** | Ya, sesuai keputusan sebelumnya. Di-seed `aktif = false`. |
