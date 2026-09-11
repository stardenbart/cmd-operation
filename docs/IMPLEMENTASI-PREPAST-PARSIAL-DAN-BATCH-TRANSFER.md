# Dokumentasi Implementasi — Prepast Parsial dan Mode Pengisian Transfer

| | |
|---|---|
| **Produk** | FM Receiving — CMD 1 Operation |
| **Tanggal implementasi** | 10 September 2026 |
| **Status** | Selesai di workspace lokal, terverifikasi, belum di-deploy ke server produksi |
| **Cakupan** | Prepast parsial termasuk silo tujuan dan volume opsional, Dashboard Perlu dilengkapi, pelengkapan bertahap, dan mode pengisian Transfer multi-baris |
| **Migrasi database** | `020_sync_prepast_completeness.sql` sampai `023_exclude_prepast_volume_null_dari_stok.sql` |

---

## 1. Ringkasan

Implementasi ini mencakup dua perubahan operasional:

1. Record Prepast dapat disimpan ketika `Silo Tujuan`, `Volume`, `Prepast Finish`, `Flowrate`, `Temp After Heater`, atau `Temp Output` belum tersedia. Nilai yang sudah dimasukkan tetap disimpan, sedangkan field yang kosong ditagih melalui Dashboard **Perlu dilengkapi**.
2. Form Transfer mempunyai dua cara pengisian batch: satu batch bersama untuk beberapa transfer tambahan atau batch yang diisi manual pada setiap baris.

Perubahan tetap mempertahankan transaksi database, penguncian baris, alokasi FIFO, aturan batch berdasarkan tank, audit trail, dan pemeriksaan hak akses yang sudah ada.

---

## 2. Prepast Parsial

### 2.1 Aturan Kelengkapan

`Prepast Start` tetap wajib. Enam field berikut boleh bernilai `NULL` secara independen ketika record pertama kali disimpan; `Silo Tujuan` dan `Volume` juga boleh sama-sama kosong:

| Field API | Kolom database | Label tampilan |
|---|---|---|
| `pecahan[].siloId` | `silo_tujuan_id` | Silo Tujuan |
| `pecahan[].volumeLtr` | `vol_prepast_ltr` dan `qty_remaining_ltr` | Volume |
| `prepastFinish` | `prepast_finish` | Waktu Selesai |
| `flowrate` | `flowrate_pst` | Flowrate |
| `tempAfterHeater` | `temp_after_heater` | Temp After Heater |
| `tempOutput` | `temp_output_prd` | Temp Output |

Ketentuannya:

- Bila minimal satu dari enam field tersebut kosong, `is_gantung = TRUE`.
- Nilai yang sudah diisi tetap disimpan; sistem tidak mengubahnya menjadi `NULL` hanya karena field lain belum tersedia.
- Angka `0` dianggap sebagai nilai yang sudah diisi. Hanya `NULL`, `undefined`, atau string kosong yang dianggap belum lengkap.
- Record gantung tampil di Dashboard **Perlu dilengkapi** beserta nama field yang masih kosong.
- Record gantung tidak masuk antrean approval.
- Setelah seluruh field terisi, `is_gantung = FALSE`, record keluar dari Dashboard, dan masuk antrean approval.

Sumber aturan terpusat berada pada:

```text
server/src/services/prepastGantung.js
```

### 2.2 Penyimpanan Awal

Endpoint:

```http
POST /api/v1/prepast
```

Contoh request parsial:

```json
{
  "receivingId": 101,
  "pecahan": [
    {}
  ],
  "prepastStart": "2026-09-09T07:00:00+07:00",
  "prepastFinish": "2026-09-09T08:00:00+07:00",
  "tempAfterHeater": 86
}
```

Pada contoh tersebut:

- `silo_tujuan_id`, `vol_prepast_ltr`, `qty_remaining_ltr`, `flowrate`, dan `temp_output_prd` disimpan sebagai `NULL`.
- Buffer belum dikurangi dan kapasitas silo belum dihitung selama volume masih kosong.
- `prepastFinish` dan `tempAfterHeater` tetap disimpan.
- Response mengembalikan `gantung: true` dan daftar `fieldKosong`.
- Dashboard menampilkan `Silo Tujuan`, `Volume`, `Flowrate`, dan `Temp Output` sebagai data yang perlu dilengkapi.

### 2.3 Pelengkapan Bertahap

Endpoint konteks:

```http
GET /api/v1/prepast/:id/complete-context
```

Endpoint penyimpanan:

```http
POST /api/v1/prepast/:id/complete
```

Pelengkapan bersifat parsial. Field yang tidak dikirim mempertahankan nilai lama.

Contoh pelengkapan pertama:

```json
{
  "siloId": 2,
  "volumeLtr": 1000,
  "flowrate": 5.2
}
```

Record masih menggantung apabila `tempOutput` belum tersedia.

Contoh pelengkapan berikutnya:

```json
{
  "tempOutput": 7
}
```

Setelah seluruh field terisi, response mengembalikan:

```json
{
  "data": {
    "isGantung": false,
    "fieldKosong": []
  }
}
```

Setiap pelengkapan dicatat pada audit log dengan action `COMPLETE_DRAFT` beserta nilai sebelum dan sesudah perubahan.

### 2.4 Hak Akses

| Aktor | Hak melengkapi |
|---|---|
| Operator pemilik record | Diizinkan untuk status `Pending Approval` atau `Rejected` |
| Operator lain | Ditolak |
| SPV | Diizinkan untuk record Operator mana pun yang masih dapat dilengkapi |
| Admin/Viewer tanpa hak transaksi | Ditolak oleh middleware wewenang |

Record Prepast gantung wajib menggunakan tindakan **Lengkapi**. Jalur koreksi umum menolak record tersebut agar aturan pelengkapan tidak dapat dilewati.

### 2.5 Waktu, OPRP, dan Kontinuitas

- Rollover tengah malam tetap membutuhkan konfirmasi ketika waktu selesai lebih awal daripada waktu mulai.
- `Temp After Heater` di bawah ambang OPRP 81 °C tetap membutuhkan konfirmasi operator.
- Pelengkapan hasil ukur tidak divalidasi ulang terhadap record Prepast terbaru apabila waktu mulai tidak berubah.
- Dengan demikian, record lama tetap dapat dilengkapi setelah record Prepast yang lebih baru dibuat.
- Relasi kontinuitas lama dipertahankan selama waktu mulai atau pilihan kontinuitas tidak diubah.

### 2.6 FIFO dan Standing Time

- Record tanpa `prepast_finish` tidak masuk antrean FIFO karena belum mempunyai kunci urutan waktu.
- Record tanpa silo tujuan belum dihitung sebagai stok silo dan tidak dapat dipakai Transfer.
- Record tanpa volume belum mengurangi stok buffer dan belum dihitung sebagai stok silo.
- Ketika volume dilengkapi, sisa batch receiving dan kapasitas silo diperiksa kembali di dalam transaksi sebelum stok dipindahkan.
- Saat silo tujuan dilengkapi, kapasitas terbarunya diperiksa di dalam transaksi sebelum volume masuk ke silo tersebut.
- Record yang sudah mempunyai `prepast_finish` tetap dapat mewakili stok fisik dalam FIFO walaupun hasil ukur lain masih belum lengkap.
- `standing_time_anchor` dapat ditetapkan ketika `prepast_finish` tersedia; tidak perlu menunggu flowrate dan suhu lengkap.
- Record gantung tetap tidak masuk antrean approval sampai seluruh data proses lengkap.

### 2.7 Migrasi Database

Migrasi:

```text
db/migrations/020_sync_prepast_completeness.sql
db/migrations/021_prepast_silo_tujuan_opsional.sql
db/migrations/022_prepast_volume_opsional.sql
db/migrations/023_exclude_prepast_volume_null_dari_stok.sql
```

Migrasi melakukan tiga hal:

1. Menyinkronkan `is_gantung` seluruh record `PREPAST` berdasarkan kelengkapan silo tujuan, waktu mulai, dan empat field proses.
2. Membentuk ulang `v_fifo_queue` agar record tanpa waktu selesai tidak ikut FIFO.
3. Membentuk ulang `v_approval_queue` agar hanya Prepast dengan `is_gantung = FALSE` yang masuk antrean approval.
4. Mengubah `prepast_record.silo_tujuan_id` menjadi nullable dan menyinkronkan status gantung agar mencakup silo tujuan.
5. Mengubah `vol_prepast_ltr` dan `qty_remaining_ltr` menjadi nullable serta menambahkan constraint yang menjaga keduanya konsisten.
6. Mengecualikan record dengan volume `NULL` dari volume dan jumlah batch aktif pada view stok silo.

Migrasi tidak menghapus atau mengosongkan nilai proses yang sudah ada.

---

## 3. Mode Pengisian Transfer

### 3.1 Pilihan pada Form

Form Transfer menampilkan select **Cara pengisian transfer** dengan dua pilihan:

| Mode | Nilai API | Perilaku |
|---|---|---|
| Batch sama untuk transfer tambahan | `SAMA` | Waktu, prefix, dan nomor batch diisi sekali pada komponen **Transfer keluar silo**; nilainya dipakai bersama oleh seluruh transfer ke tank beraturan `PILIH` |
| Isi manual setiap transfer | `MANUAL` | Waktu, prefix, dan nomor batch diisi secara terpisah di setiap komponen **Transfer** |

Dalam kedua mode, field berikut tetap diisi manual pada setiap baris:

- Silo asal
- Jenis transfer
- Volume transfer
- Tank tujuan atau silo tujuan

Pada mode `MANUAL`, **Waktu transfer** tidak ditampilkan di komponen **Transfer keluar silo**. Field tersebut tampil dan wajib diisi di setiap kartu **Transfer 1**, **Transfer 2**, dan seterusnya. Pada mode `SAMA`, waktu tetap berada di komponen atas dan berlaku untuk semua baris.

Pergantian mode tidak menghapus state batch mode lainnya. Setelah submit berhasil, form dan batch bersama dikosongkan kembali.

### 3.2 Aturan Berdasarkan Tank

Mode input tidak boleh menimpa aturan batch milik tank:

| Jenis tujuan | `aturan_batch` | Batch tersimpan |
|---|---|---|
| MT produksi biasa | `PILIH` | Mengikuti Batch Sama atau Manual |
| CMD 2 | `TETAP_CMD2` | Selalu `CMD2` |
| Pengosongan silo | `TANPA_BATCH` | `NULL` |
| Pindah silo | Tidak memakai aturan tank | Otomatis `TF TO <silo tujuan>` |

Format batch kanonik tetap `<PREFIKS><nomor>`, misalnya `HRC7`, `FC2`, atau `INK13`.

### 3.3 Request Batch Sama

Endpoint:

```http
POST /api/v1/transfer/batch
```

Contoh request:

```json
{
  "trfTime": "2026-09-09T12:00:00+07:00",
  "modeBatch": "SAMA",
  "batchBersama": {
    "batchPrefix": "HRC",
    "batchNomor": 7
  },
  "baris": [
    {
      "siloAsalId": 2,
      "jenis": "PEMAKAIAN PRODUKSI",
      "volumeLtr": 400,
      "tankId": 1
    },
    {
      "siloAsalId": 3,
      "jenis": "PEMAKAIAN PRODUKSI",
      "volumeLtr": 300,
      "tankId": 2
    }
  ]
}
```

Kedua transfer akan menyimpan batch `HRC7`.

Server menggunakan `batchBersama` sebagai satu-satunya sumber batch bagi seluruh tank `PILIH`. Nilai batch berbeda yang disisipkan pada salah satu baris tidak digunakan.

### 3.4 Request Manual

```json
{
  "modeBatch": "MANUAL",
  "baris": [
    {
      "trfTime": "2026-09-09T12:00:00+07:00",
      "siloAsalId": 2,
      "jenis": "PEMAKAIAN PRODUKSI",
      "volumeLtr": 400,
      "tankId": 1,
      "batchPrefix": "HRC",
      "batchNomor": 7
    },
    {
      "trfTime": "2026-09-09T13:15:00+07:00",
      "siloAsalId": 3,
      "jenis": "PEMAKAIAN PRODUKSI",
      "volumeLtr": 300,
      "tankId": 2,
      "batchPrefix": "FC",
      "batchNomor": 2
    }
  ]
}
```

Transfer pertama menyimpan waktu 12:00 dan batch `HRC7`, sedangkan transfer kedua menyimpan waktu 13:15 dan batch `FC2`.

> Catatan kompatibilitas: payload lama yang tidak mengirim `modeBatch` tetap dapat memakai satu `trfTime` di tingkat request. Server menggunakan batch `MANUAL` per baris untuk bentuk lama tersebut.

### 3.5 Transaksi dan FIFO

- Seluruh baris tetap disimpan dalam satu transaksi database.
- Alokasi FIFO tetap dihitung ulang di dalam transaksi menggunakan baris yang dikunci.
- Bila salah satu baris tidak valid, seluruh transfer dibatalkan.
- Dalam mode `MANUAL`, waktu wajib diisi pada setiap transfer. Untuk transfer berurutan dari silo asal yang sama, waktu baris berikutnya tidak boleh lebih awal.
- Contoh: baris CMD2 berhasil diproses lebih dahulu, tetapi baris tank `PILIH` tidak mempunyai batch bersama. Request tetap gagal seluruhnya dan volume silo dikembalikan oleh rollback transaksi.
- Perubahan mode batch tidak mengubah struktur `transfer`, `transfer_allocation`, atau algoritma FIFO.


Fitur Transfer ini tidak membutuhkan migrasi database karena nilai batch akhir sudah tersimpan pada kolom `transfer.batch`.

---

## 4. File Implementasi Utama

### Prepast

```text
client/src/components/DialogLengkapiPrepast.jsx
client/src/pages/Dashboard.jsx
client/src/pages/DataList.jsx
client/src/pages/Prepast.jsx
server/src/middleware/validasi.js
server/src/routes/prepast.js
server/src/services/dataList.js
server/src/services/kontinuitasPrepast.js
server/src/services/koreksi.js
server/src/services/prepast.js
server/src/services/prepastGantung.js
db/migrations/020_sync_prepast_completeness.sql
db/migrations/021_prepast_silo_tujuan_opsional.sql
db/migrations/022_prepast_volume_opsional.sql
db/migrations/023_exclude_prepast_volume_null_dari_stok.sql
server/test/prepastPartial.test.js
server/test/prepastGantung.test.js
server/test/wewenang.test.js
```

### Transfer

```text
client/src/pages/Transfer.jsx
server/src/routes/transfer.js
server/src/services/transfer.js
server/test/transferMulti.test.js
docs/PRD-Migrasi-FM-Receiving.md
```

---

## 5. Verifikasi yang Telah Dilakukan

| Pemeriksaan | Hasil |
|---|---|
| Unit/regression test server | 113 lulus, 0 gagal |
| Integrasi Prepast parsial termasuk silo opsional | 6 lulus, 0 gagal |
| Regresi wewenang dan Dashboard | 25 lulus, 0 gagal |
| Regresi volume multi-silo | 9 lulus, 0 gagal |
| Integrasi mode pengisian Transfer | 8 lulus, 0 gagal |
| Build production frontend | Berhasil, 124 modul ditransformasi |
| Status migrasi | Migrasi `021` berhasil diterapkan pada database test dan development; belum diterapkan ke produksi |
| Health API/frontend | Tidak dijalankan karena proses development sedang dihentikan |
| Pemeriksaan whitespace diff | Bersih |

Catatan verifikasi:

- Build menghasilkan peringatan ukuran bundle JavaScript di atas 500 kB. Peringatan tidak menggagalkan build dan tidak disebabkan khusus oleh fitur ini.
- Lint belum dapat dijalankan karena binary `eslint` belum tersedia pada `node_modules`, walaupun tercantum pada `devDependencies`.

---

## 6. Skenario Uji Manual

### 6.1 Prepast

1. Buat Prepast dengan volume, Waktu Mulai, dan Temp After Heater saja; biarkan Silo Tujuan kosong.
2. Pastikan record tersimpan dan Dashboard menampilkan Silo Tujuan, Waktu Selesai, Flowrate, serta Temp Output sebagai field kosong.
3. Buka Data, cari kode record, lalu tekan **Lengkapi**.
4. Isi Waktu Selesai saja dan simpan.
5. Pastikan record masih tampil sebagai gantung dan nilai awal tidak hilang.
6. Isi Silo Tujuan, Flowrate, dan Temp Output.
7. Pastikan record keluar dari **Perlu dilengkapi** dan muncul pada antrean approval.
8. Masuk sebagai Operator lain dan pastikan pelengkapan ditolak.
9. Masuk sebagai SPV dan pastikan record milik Operator dapat dilengkapi.

### 6.2 Transfer — Batch Sama

1. Pilih **Batch sama untuk transfer tambahan**.
2. Pilih silo asal pertama agar daftar prefiks dimuat.
3. Isi batch bersama, misalnya `HRC` dan `7`.
4. Buat dua baris menuju MT yang aturan batch-nya `PILIH`.
5. Pastikan setiap baris menampilkan `HRC7` sebagai batch bersama.
6. Simpan dan pastikan kedua record Transfer mempunyai batch `HRC7`.
7. Tambahkan satu baris CMD2 dan pastikan batch akhirnya tetap `CMD2`.
8. Tambahkan satu baris Pengosongan Silo dan pastikan batch akhirnya kosong/`NULL`.

### 6.3 Transfer — Manual

1. Pilih **Isi manual setiap transfer**.
2. Pastikan field **Waktu transfer** tidak ada di komponen **Transfer keluar silo**, tetapi tersedia pada setiap kartu **Transfer**.
3. Tambahkan dua baris Transfer dan isi waktu yang berbeda.
4. Isi batch pertama `HRC7` dan batch kedua `FC2`.
5. Pastikan form dapat disimpan dan masing-masing record mempertahankan waktu serta batch berbeda.

---

## 7. Penerapan ke Server

Perubahan saat ini belum di-deploy. Urutan penerapan yang disarankan:

```bash
npm ci
npm run db:migrate
npm run build
```

Setelah itu restart proses API dan frontend menggunakan process manager yang memang dipakai oleh server.

Verifikasi migrasi:

```bash
npm run db:migrate --workspace=server -- --status
```

Verifikasi API, sesuaikan port dengan `.env` server:

```bash
curl -fsS http://127.0.0.1:3001/health
```

Seed tidak diperlukan untuk dua fitur ini. Jangan menjalankan `db:reset` pada server karena perintah tersebut menghapus dan membangun ulang database.

Sebelum migrasi produksi, tetap lakukan backup database dan pastikan tidak ada proses deployment lain yang berjalan bersamaan.

---

## 8. Status Akhir

- Implementasi dan pengujian lokal selesai.
- Migrasi `021` sudah diterapkan ke database development, tetapi belum ke produksi.
- Tidak ada commit atau deployment produksi yang dilakukan sebagai bagian dari pekerjaan ini.
- Worktree masih berisi perubahan implementasi yang perlu direview dan di-commit sesuai prosedur proyek.
