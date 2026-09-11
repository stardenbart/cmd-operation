# Dokumentasi Implementasi — Berat Jenis dan Total Solid Receiving Opsional

| | |
|---|---|
| **Produk** | FM Receiving — CMD 1 Operation |
| **Tanggal implementasi** | 10 September 2026 |
| **Status** | Selesai di workspace lokal, terverifikasi, belum di-deploy ke server produksi |
| **Cakupan** | Berat Jenis dan Total Solid Receiving opsional, Dashboard Perlu dilengkapi, pelengkapan bertahap, propagasi Total Solid ke Prepast turunan, Prepast dari Receiving bervolume belum diketahui |
| **Migrasi database** | `024_receiving_bj_ts_opsional.sql`, `025_prepast_dari_receiving_bj_kosong.sql` |

---

## 1. Ringkasan

Receiving dapat disimpan ketika `Berat Jenis` dan/atau `Nilai Total Solid` belum tersedia — keduanya boleh kosong secara independen maupun bersamaan. `Supplier`, `Quantity kg`, dan `Finish time` tetap wajib. Field yang kosong ditagih lewat Dashboard **Perlu dilengkapi**, sama seperti pola yang sudah berjalan untuk Prepast.

Karena volume liter (`qty_ltr`) dihitung dari `qty_kg / berat_jenis`, Receiving tanpa Berat Jenis belum dapat dihitung volumenya dan karena itu belum masuk stok buffer. Total Solid tidak memengaruhi volume — Receiving dengan Berat Jenis terisi tapi Total Solid kosong tetap masuk stok buffer dan dapat diprepast, hanya saja tetap berstatus gantung sampai Total Solid dilengkapi.

Perubahan tetap mempertahankan transaksi database, penguncian baris, audit trail, dan pemeriksaan hak akses yang sudah ada.

---

## 2. Aturan Kelengkapan

`Supplier`, `Quantity kg`, dan `Finish time` tetap wajib. Dua field berikut boleh bernilai `NULL` secara independen ketika record pertama kali disimpan:

| Field API | Kolom database | Label tampilan |
|---|---|---|
| `beratJenis` | `berat_jenis`, ikut menentukan `qty_ltr` dan `qty_remaining_ltr` | Berat Jenis |
| `nilaiTs` | `nilai_ts` | Total Solid |

Ketentuannya:

- Bila salah satu atau kedua field tersebut kosong, `is_gantung = TRUE`.
- Angka `0` dianggap sebagai nilai yang sudah diisi. Hanya `NULL`, `undefined`, atau string kosong yang dianggap belum lengkap.
- Record gantung tampil di Dashboard **Perlu dilengkapi** beserta nama field yang masih kosong.
- Record gantung tidak masuk antrean approval (BR-23).
- Setelah kedua field terisi, `is_gantung = FALSE`, record keluar dari Dashboard, dan masuk antrean approval.

Sumber aturan terpusat berada pada:

```text
server/src/services/receivingGantung.js
```

---

## 3. Penyimpanan Awal

Endpoint:

```http
POST /api/v1/receiving
```

Contoh request tanpa Berat Jenis maupun Total Solid:

```json
{
  "supplierId": 5,
  "qtyKg": 1000,
  "finishTime": "2026-09-10T06:00:00+07:00"
}
```

Pada contoh tersebut:

- `berat_jenis`, `qty_ltr`, dan `qty_remaining_ltr` disimpan sebagai `NULL`.
- Volume belum dapat dihitung sehingga belum masuk stok buffer.
- Response mengembalikan `is_gantung: true`; klien menentukan field kosong dari `berat_jenis`/`nilai_ts` yang `NULL`.

Contoh request dengan Berat Jenis terisi, Total Solid menyusul:

```json
{
  "supplierId": 5,
  "qtyKg": 2050,
  "beratJenis": 1.025,
  "finishTime": "2026-09-10T06:00:00+07:00"
}
```

Di sini `qty_ltr = FLOOR(2050 / 1.025) = 2000` langsung dihitung dan masuk stok buffer, tetapi record tetap `is_gantung = TRUE` sampai Total Solid tersedia.

---

## 4. Pelengkapan Bertahap

Endpoint konteks:

```http
GET /api/v1/receiving/:id/complete-context
```

Endpoint penyimpanan:

```http
POST /api/v1/receiving/:id/complete
```

Pelengkapan bersifat parsial — field yang tidak dikirim mempertahankan nilai lama, dan minimal satu field wajib disertakan.

Contoh melengkapi Berat Jenis saja:

```json
{ "beratJenis": 1.025 }
```

Ini memicu penghitungan `qty_ltr` dan `qty_remaining_ltr`, lalu memasukkan volume ke stok buffer **tepat satu kali**. Record masih menggantung apabila Total Solid belum tersedia.

Bila Receiving ini sudah mempunyai Prepast turunan yang dibuat SELAMA Berat Jenis masih kosong (lihat §6.1), pelengkapan ini tetap diizinkan — turunan tersebut pasti masih berupa draft tanpa volume, jadi sisa yang baru diketahui (`qty_ltr` penuh) belum diambil siapa pun.

Contoh melengkapi Total Solid:

```json
{ "nilaiTs": 12.4 }
```

Melengkapi Total Solid meneruskan nilainya ke seluruh Prepast turunan (`prepast_record.receiving_id`) yang `nilai_ts`-nya masih `NULL`, tanpa menimpa turunan yang sudah punya nilai sendiri.

Setelah kedua field terisi, response mengembalikan:

```json
{
  "data": {
    "isGantung": false,
    "fieldKosong": []
  }
}
```

**Nilai yang sudah tersimpan tidak dapat ditimpa lewat jalur ini** — mengirim `beratJenis` atau `nilaiTs` dengan nilai berbeda dari yang sudah tercatat ditolak (`BERAT_JENIS_ALREADY_SET` / `TOTAL_SOLID_ALREADY_SET`). Perubahan atas nilai yang sudah ada harus lewat koreksi.

Berat Jenis juga tidak dapat dilengkapi apabila Receiving sudah mempunyai Prepast turunan dengan **volume yang sudah terisi** (BR-15). Turunan yang masih berupa draft tanpa volume — kasus normal ketika Prepast dibuat dari Receiving yang Berat Jenis-nya masih kosong, lihat §6.1 — tidak menghalangi pelengkapan ini.

Setiap pelengkapan dicatat pada audit log dengan action `COMPLETE_DRAFT` beserta nilai sebelum dan sesudah perubahan.

---

## 5. Hak Akses

| Aktor | Hak melengkapi |
|---|---|
| Operator pemilik record | Diizinkan untuk status `Pending Approval` atau `Rejected` |
| Operator lain | Ditolak |
| SPV | Diizinkan untuk record Operator mana pun yang masih dapat dilengkapi |
| Admin/Viewer tanpa hak transaksi | Ditolak oleh middleware wewenang |

Record Receiving gantung wajib menggunakan tindakan **Lengkapi** (`DialogLengkapiReceiving`). Jalur koreksi umum menolak record tersebut agar aturan pelengkapan tidak dapat dilewati.

---

## 6. Stok dan Proses Berikutnya

- Receiving dengan Berat Jenis terisi tapi Total Solid kosong tetap punya volume fisik dan dapat diprepast; Prepast turunannya mewarisi `nilai_ts = NULL` sampai Total Solid induk dilengkapi.
- `v_silo_volume` mengecualikan `qty_remaining_ltr IS NULL` secara alami lewat klausa `qty_remaining_ltr > 0` (migrasi `023`), sehingga Receiving gantung tanpa Berat Jenis tidak pernah terhitung sebagai stok buffer.
- `v_approval_queue` mengecualikan Receiving dengan `is_gantung = TRUE`.

### 6.1 Prepast dari Receiving Bervolume Belum Diketahui

Operasional tidak dapat menunggu hasil lab hanya untuk memindahkan susu secara fisik dari buffer ke silo. Karena itu Receiving tanpa Berat Jenis **tetap dapat diprepast**, bukan diblokir sampai lab selesai:

- Receiving tanpa Berat Jenis tetap tampil di antrean buffer Prepast (`v_buffer_queue`, migrasi `025`), ditandai "Volume belum diketahui" di UI.
- Operator dapat membuat Prepast draft dari batch tersebut: Silo Tujuan boleh dipilih sekarang, tetapi **Volume wajib dikosongkan** — mengisi Volume pada kondisi ini ditolak dengan kode `BERAT_JENIS_BELUM_DIISI` (`server/src/services/pecahanSilo.js`). Ini murni pertahanan integritas stok: tanpa Berat Jenis, tidak ada angka sisa batch untuk memvalidasi maupun mengurangkan volume Prepast terhadapnya.
- Selama itu, Receiving induk **tidak disentuh sama sekali** — tidak dikurangi, tidak ditutup, tetap `is_gantung = TRUE` apa adanya (`server/src/services/prepast.js` melewati blok pengurangan stok sepenuhnya saat `qty_remaining_ltr` induk `NULL`).
- Guard BR-15 di `receiving.lengkapiDraft()` disesuaikan agar **hanya** memblokir pelengkapan Berat Jenis bila ada Prepast turunan yang volumenya **sudah terisi** — turunan draft tanpa volume tidak menghalangi, karena itu justru alur yang normal di sini.
- Setelah Berat Jenis Receiving dilengkapi, `qty_remaining_ltr` terisi penuh (belum ada turunan yang mengambil apa pun), dan Volume Prepast turunannya baru dapat dilengkapi lewat "Lengkapi" — dengan sisa batch yang kini sudah diketahui, tervalidasi seperti biasa.
- Mencoba melengkapi Volume Prepast **sebelum** Berat Jenis Receiving diisi ditolak dengan kode `RECEIVING_BJ_BELUM_DIISI`. `prepast.konteksPelengkapan()` mengembalikan flag `bjIndukBelumDiisi` supaya dialog "Lengkapi Prepast" dapat menonaktifkan field Volume proaktif, bukan menunggu ditolak server.

---

## 7. Migrasi Database

Migrasi:

```text
db/migrations/024_receiving_bj_ts_opsional.sql
db/migrations/025_prepast_dari_receiving_bj_kosong.sql
```

Migrasi `024` melakukan:

1. Mengubah `receiving.berat_jenis`, `qty_ltr`, dan `qty_remaining_ltr` menjadi nullable.
2. Menambahkan kolom `receiving.is_gantung` beserta indeksnya.
3. Mengganti constraint `ck_rcv_remaining` dan `ck_rcv_positif` agar konsisten: Berat Jenis kosong diperbolehkan, tapi bila terisi harus `> 0`; `qty_ltr` dan `qty_remaining_ltr` harus sama-sama `NULL` atau sama-sama terisi.
4. Menyinkronkan `is_gantung` seluruh Receiving yang sudah ada berdasarkan kekosongan `berat_jenis` atau `nilai_ts`.
5. Membentuk ulang `v_approval_queue` agar hanya Receiving dengan `is_gantung = FALSE` yang masuk antrean approval.

Migrasi `025` membentuk ulang `v_buffer_queue` agar Receiving dengan `qty_remaining_ltr IS NULL` (Berat Jenis belum diisi) tetap tampil di antrean buffer Prepast — sebelumnya tersaring habis oleh `qty_remaining_ltr > 0`.

Migrasi tidak menghapus atau mengosongkan nilai yang sudah ada.

---

## 8. File Implementasi Utama

### Backend
- `server/src/services/receivingGantung.js` — aturan kelengkapan.
- `server/src/services/receiving.js` — `buat()`, `konteksPelengkapan()`, `lengkapiDraft()` (termasuk guard BR-15 yang diperbarui).
- `server/src/routes/receiving.js` — endpoint `complete-context` dan `complete`, skema Zod.
- `server/src/services/dataList.js` — baris Data List, detail, dan agregator `gantung()` untuk Dashboard.
- `server/src/services/approval.js` — pesan galat BR-23 digeneralisasi lintas modul.
- `server/src/services/pecahanSilo.js` — `validasiPecahan()` menangani `sisaBatchLtr === null` (belum diketahui).
- `server/src/services/prepast.js` — `buat()`, `lengkapiDraft()`, `konteksPelengkapan()` menangani Receiving induk tanpa Berat Jenis.
- `db/migrations/024_receiving_bj_ts_opsional.sql`, `db/migrations/025_prepast_dari_receiving_bj_kosong.sql`.

### Frontend
- `client/src/pages/Receiving.jsx` — Berat Jenis dan Total Solid tidak lagi wajib, pratinjau volume, pesan sukses kondisional.
- `client/src/components/DialogLengkapiReceiving.jsx` — dialog pelengkapan bertahap.
- `client/src/pages/DataList.jsx` — percabangan dialog Lengkapi per modul, filter "Hanya draft yang belum lengkap" untuk Receiving.
- `client/src/pages/Prepast.jsx` — antrean buffer menampilkan "Volume belum diketahui", Volume per baris silo dinonaktifkan saat sisa batch belum diketahui.
- `client/src/components/DialogLengkapiPrepast.jsx` — field Volume dinonaktifkan selama `bjIndukBelumDiisi`.

### Test
- `server/test/receivingGantung.test.js`
- `server/test/receivingPartial.test.js`
- `server/test/pecahanSilo.test.js` — kasus `sisaBatchLtr === null`.
- `server/test/prepastDariReceivingBjKosong.test.js` — alur penuh Prepast dari Receiving tanpa Berat Jenis.

---

## 9. Verifikasi yang Telah Dilakukan

- `npm test` (unit, `server/src/**/*.test.js`) — 113 pass, 0 fail.
- `npm run test:integrasi -- server/test/receivingGantung.test.js server/test/receivingPartial.test.js` — seluruh skenario penyimpanan tanpa Berat Jenis/Total Solid, pelengkapan bertahap, penjagaan nilai yang sudah tersimpan, propagasi Total Solid ke Prepast turunan, penagihan Dashboard, dan penolakan approval atas record gantung — lulus.
- `node --test test/pecahanSilo.test.js test/prepastDariReceivingBjKosong.test.js` — 40/40 pass: Receiving tanpa BJ muncul di antrean buffer, Receiving yang sungguh habis tetap tersaring, Prepast draft dibuat tanpa menyentuh Receiving induk, volume langsung ditolak (`BERAT_JENIS_BELUM_DIISI`), Berat Jenis tetap dapat dilengkapi walau sudah ada turunan draft, pelengkapan volume sebelum BJ ditolak (`RECEIVING_BJ_BELUM_DIISI`), dan alur penuh sampai sisa Receiving berkurang benar.
- Regresi penuh (`npm run test:integrasi`, seluruh berkas) dijalankan ulang setelah perubahan `pecahanSilo.js` dan `prepast.js` karena `validasiPecahan()` dipakai di seluruh jalur Prepast utama.
