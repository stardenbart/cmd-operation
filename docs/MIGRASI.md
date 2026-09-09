# Migrasi Data SharePoint ke MySQL

Panduan menyiapkan dan menjalankan migrasi Fase 4.

---

## 1. Yang perlu disiapkan

Export **lima SharePoint List** ke satu folder. Format `.xlsx` atau `.csv`,
keduanya diterima; `.xlsx` lebih disukai karena tipe kolomnya ikut terbawa dan
tidak perlu ditafsir ulang.

| List SharePoint | Nama berkas harus memuat | Menjadi tabel |
|---|---|---|
| FM_Receiving_Penerimaan | `FM_Receiving_Penerimaan` | `receiving` |
| FM_Prepast_Record | `FM_Prepast_Record` | `prepast_record` |
| FM_Receiving_Transfer | `FM_Receiving_Transfer` | `transfer` + `transfer_allocation` |
| FM_Receiving_Monitoring | `FM_Receiving_Monitoring` | `monitoring` |
| FM_Stock_Opname | `FM_Stock_Opname` | `stock_opname` |

Nama berkas boleh memuat tambahan seperti tanggal atau kata "export"; yang
dicari hanya potongan nama di kolom kedua. Kolom dikenali dari **baris kepala**,
bukan dari posisinya, jadi urutan kolom boleh berbeda.

> **List yang tidak berisi tetap harus diekspor**, walau hanya baris kepalanya.
> Berkas yang hilang berarti satu list tidak ikut dimigrasikan sama sekali, dan
> verifikasi V-2 memang menggagalkannya. Berkas kosong berarti listnya memang
> tidak berisi, dan itu sah.

### Kolom wajib

Export harus memuat kolom berikut. Bila salah satu tidak ada, migrasi berhenti
sebelum menyentuh basis data dan menyebutkan kolom mana yang kurang.

| List | Kolom wajib |
|---|---|
| Penerimaan | `Title`, `qty_kg`, `berat_jenis` |
| Prepast | `Title`, `vol_prepast_ltr` |
| Transfer | `Title`, `transfer_type`, `vol_ltr` |
| Monitoring | `Title` |
| Stock Opname | `periode`, `silo_number` |

### Master data lebih dahulu

Migrasi **tidak membuat** supplier, silo, tank, atau operator baru. Keempatnya
harus sudah ada di MySQL sebelum migrasi dijalankan, lewat seed atau lewat
halaman Master Data. Baris transaksi yang menunjuk master yang tidak ada
ditolak dan masuk laporan pengecualian, bukan dibuatkan master baru diam-diam —
master yang lahir dari salah ketik akan menetap selamanya di daftar pilihan.

---

## 2. Menjalankan

```bash
cd server

# Muat seluruh data, lalu verifikasi V-1..V-6
npm run migrasi -- --sumber "D:/export-sharepoint"

# Menyertakan volume acuan Power Apps untuk V-1
npm run migrasi -- --sumber "D:/export-sharepoint" --acuan ./volume-acuan.json

# Verifikasi ulang tanpa memuat apa pun
npm run migrasi:verifikasi
```

Bentuk `volume-acuan.json`, dicatat dari layar Power Apps saat pembekuan input:

```json
{ "SILO1": 1450, "SILO2": 650, "SILO3": 6000, "SILO6": 0, "SILO25A": 2000, "SILO25B": 9000 }
```

Keluarannya dua berkas di `db/backup/`:

- `laporan_pengecualian.csv` — satu baris per data yang tidak dapat dimuat
- `laporan_verifikasi.json` — hasil V-1..V-6, untuk dilampirkan saat persetujuan cutover (T-22)

Kode keluar `0` bila tidak ada kriteria yang GAGAL, `1` bila ada.

---

## 3. Sifat yang dijamin

### Idempoten (T-23)

Dijalankan berapa kali pun menghasilkan keadaan yang sama. Baris dikenali dari
`Title` SharePoint, bukan dari urutan pemuatan, dan ditulis dengan
`INSERT ... ON DUPLICATE KEY UPDATE`.

Ini bukan kemewahan: dry run wajib diulang **tiga kali** sebelum cutover (T-21),
dan migrasi yang hanya boleh dijalankan sekali tidak dapat memenuhi syarat itu.
Memperbaiki data di SharePoint lalu menjalankan ulang adalah alur kerja yang
diharapkan, bukan keadaan darurat.

### Tidak pernah menebak

Nilai yang tidak terbaca **menolak barisnya** dan masuk laporan. Tidak ada
nilai bawaan yang diam-diam menggantikan data yang hilang.

Alasannya bukan kehati-hatian umum. Yang dimigrasikan adalah catatan mutu:
menebak satu jam penerimaan berarti menerbitkan form GMP dengan jam yang tidak
pernah terjadi, dan setelah Power Apps dipensiunkan tidak akan ada lagi
pembandingnya. Baris yang ditolak masih dapat diperbaiki manusia; baris yang
ditebak tidak dapat ditemukan lagi.

Yang ditolak dan sebabnya:

| Sebab | Contoh |
|---|---|
| `nilai tidak terbaca` | `start_time` berisi "kemarin sore"; `qty_kg` berisi "n/a" |
| `relasi tidak ditemukan` | supplier "ZZZ999" tidak ada di master |
| `ditolak basis data` | melanggar kekangan, misalnya prepast tanpa supplier |
| `batch tidak terpetakan` | penulisan batch di luar BR-21; nilai mentahnya tetap dimuat |
| `alokasi yatim` | `supplier_fifo` menunjuk `id_prepast` yang tidak ada |

Satu baris yang gagal **tidak** menjatuhkan seluruh muatan. Tiap baris memakai
savepoint sendiri, sehingga laporannya lengkap dalam satu kali jalan; menemukan
masalah satu per satu berarti berhari-hari bolak-balik ke SharePoint.

---

## 4. Transformasi yang perlu diketahui

### `start_time` menyimpan waktu SELESAI

Kolom SharePoint bernama `start_time` dipetakan ke `receiving.finish_time`.
Itu bukan salah ketik. Buktinya dua lapis: flow export lama menulis `start_time`
ke kolom form "Waktu Penerimaan · Selesai", dan pada seluruh 20 berkas hasil
export kolom "Mulai" kosong sedangkan "Selesai" terisi.

### Format tanggal `mm/dd/yyyy` ditetapkan, bukan dideteksi

`06/08/2026` dibaca **8 Juni**, bukan 6 Agustus. Asumsi ini diambil dari flow
export lama yang membandingkan potongan waktu dengan string berformat
`MM/dd/yyyy`.

> **Ini asumsi yang paling mahal bila salah.** Membalikkannya menggeser tanggal
> pada 12 dari setiap 31 hari, dan geserannya tidak terlihat sebagai galat,
> hanya sebagai tanggal yang salah. **Periksa pada dry run pertama**: ambil lima
> baris yang tanggalnya diketahui dan bandingkan dengan form GMP yang sudah
> tercetak.

### Liter dihitung ulang, tidak disalin

`qty_ltr` dihitung ulang sebagai `FLOOR(qty_kg / berat_jenis)` (BR-03), tidak
diambil dari sumber. Nilai liter di SharePoint adalah hasil formula yang
pembulatannya pernah berbeda-beda; menghitungnya ulang membuat seluruh riwayat
mengikuti satu aturan yang sama.

### `supplier_fifo` menjadi `transfer_allocation`

Transformasi paling kritis di seluruh migrasi. Tanpanya, pertanyaan "susu yang
dikirim ke tank ini berasal dari supplier mana" kehilangan jawabannya untuk
seluruh riwayat — dan itu justru pertanyaan yang diajukan saat terjadi masalah
mutu.

JSON yang rusak **menolak transfernya**, tidak menjadi larik kosong: transfer
tanpa alokasi terbaca sebagai transfer yang tidak berasal dari batch mana pun.

### Batch dinormalkan, nilai asing tetap dimuat

Batch dinormalkan ke bentuk baku BR-21 (`1hrc` → `HRC1`). Yang tidak dikenali
tetap dimuat apa adanya dan masuk laporan: menolak barisnya akan membuang
transfer yang sah hanya karena penulisan batchnya tidak baku, sedangkan
mengubahnya diam-diam akan memutus penelusuran ke dokumen produksi.

---

### Angka yang terbaca sempurna tetapi salah

Aturan bentuk hanya dapat menolak yang tidak dapat dibaca. Ia tidak dapat
menolak yang terbaca dengan sempurna tetapi salah, dan justru itulah yang ada
di export sungguhan:

| Kolom | Tertulis | Terbaca | Seharusnya | Baris |
|---|---|---|---|---|
| `qty_kg` | `20.403` | 20,403 kg | 20403 kg | 6 |
| `vol_ltr` | `12.007` | 12,007 L | 12007 L | 4 |
| `berat_jenis` | `10.26` | 10,26 | 1,026 | 1 |
| `ph_check` | `670` | 670 | 6,70 | 14 |
| `temp_after_heater` | `853.00` | 853 C | 85,3 C | 4 |
| `nilai_ts` | `1279` | 1279 % | 12,79 % | 5 |

Titik pada `20.403` dan pada `1.027` adalah karakter yang sama pada kolom yang
bentuknya sama. Tidak ada aturan format yang dapat memisahkannya; yang dapat
memisahkannya hanya kenyataan fisik. Karena itu tiap kolom angka punya batas
masuk akal (`BATAS_MASUK_AKAL` di `parseNilai.js`), dan nilai di luar batas
DITOLAK ke laporan.

Ditolak, bukan dibagi seratus. Membaginya berarti menerbitkan catatan mutu
berisi angka yang tidak pernah diukur siapa pun, dan pada `temp_after_heater`
angka itulah yang menentukan apakah OPRP 81 C terpenuhi.

### Lapisan perbaikan

Nilai yang ditolak `parseNilai.js` diberi SATU kesempatan diperbaiki di
`perbaikan.js`, dengan tiga syarat yang mengikat semuanya:

1. **Tunggal.** Bila ada dua kemungkinan yang sama masuk akalnya, nilainya
   tetap ditolak. Perbaikan yang harus memilih di antara dua kandidat adalah
   tebakan yang menyamar.
2. **Turunan.** Batas kewajaran tiap kolom dihitung dari sebaran nilai bersih
   di export yang sama, bukan dari angka yang diketik di dalam kode.
3. **Tercatat.** Tiap perbaikan masuk laporan pengecualian berikut nilai
   asalnya, DAN menempel di kolom `remarks` barisnya. Laporan diarsipkan
   setelah cutover; yang membaca catatan mutu tiga tahun lagi hanya punya
   `remarks`.

Yang dapat diperbaiki:

| Kerusakan | Buktinya | Contoh |
|---|---|---|
| Titik pemisah ribuan pada kolom bilangan bulat | bentuk | `qty_kg "20.403"` -> 20403 |
| Titik desimal hilang | sebaran kolomnya sendiri | `ph_check "670"` -> 6,70 |
| Digit menit terpotong | menit bulat | `"16:5"` -> 16:50 |
| Jam hari kerja di atas 24 | pabrik bekerja melewati tengah malam | `"29:46"` -> 05:46 esok harinya |
| Jam tidak tercatat | tanggalnya dipertahankan | `"06/23/2026 :"` -> 00:00, ditandai |
| Nomor batch tanpa prefiks | prefiks hari itu, bila hanya satu | `"6"` pada 27 Juni -> `HRC6` |
| Sisa melebihi volume asalnya | `vol_prepast_ltr` lebih dapat dipercaya | sisa dijepit |

Yang TIDAK diperbaiki, dan alasannya: `nilai_ts "5131"` tidak menjadi masuk
akal dibagi berapa pun; `batch "5000"` adalah volume yang salah kolom, bukan
nomor batch; `853` akan ditolak juga seandainya batas kolomnya cukup longgar
untuk membuat 8,53 sama masuk akalnya.

### Kolom tidak wajib yang rusak dikosongkan, barisnya tidak dibuang

Satu `nilai_ts` yang tertulis 5131 tidak membatalkan penerimaan yang sungguh
terjadi. Membuang barisnya bukan sekadar kehilangan satu baris: prepast
anaknya ikut kehilangan induk, lalu alokasi FIFO-nya ikut yatim. Kolomnya
dikosongkan dan pengosongannya dicatat.

Kolom yang `NOT NULL` di skema WAJIB ditandai `wajib: true` di
`sumberKolom.js`. Tanpa itu, nilainya dikosongkan lalu ditolak basis data
dengan pesan yang tidak menyebut kolom mana yang bermasalah.

### Anak PINDAH SILO ditautkan ke transfer induknya

Saat susu dipindah antar silo, sistem lama membuat prepast BARU di silo tujuan.
Baris itu tidak punya batch penerimaan induk, dan memang tidak seharusnya
punya - induknya adalah transfernya.

Penghubungnya `transfer_ref`, dan bentuknya bukan kode transfer melainkan
pasangan nomor silo: `001-TO-008`. Nomor itu adalah `silo_number` versi
SharePoint, BUKAN `kode` silo di basis data - sumber memakai 001 untuk SILO25A
sedangkan basis data memakai 25A. Petanya disusun dari pasangan nomor dan nama
yang ada di sumber itu sendiri.

Satu pasangan silo dipakai berkali-kali sepanjang riwayat, jadi penautannya
memakai penciri kedua: volume, lalu waktu terdekat bila volumenya masih
menunjuk lebih dari satu transfer. Yang tertaut lewat waktu saja dicatat
sebagai perlu ditinjau.

### Akun universal "Operator"

Sistem lama punya satu akun bersama yang `nama_op`-nya tertulis harfiah
"Operator", dipakai 131 baris di bulan-bulan awal. Akunnya dibuat sebagai
operator berkode `0000` dan NONAKTIF: di sistem baru PIN adalah tanda tangan
elektronik milik satu orang (FR-1.1), jadi akun bersama tidak boleh dipakai
mencatat apa pun yang baru. Riwayat lama tetap terbaca; Admin dapat
mengaktifkannya lewat Master Data bila diputuskan lain.

### Kode ganda di dalam satu berkas

`ON DUPLICATE KEY UPDATE` membuat migrasi boleh diulang. Klausa yang sama, bila
dua baris di dalam SATU berkas memakai kode yang sama, membuat baris kedua
menimpa baris pertama tanpa galat apa pun. Pada export sungguhan hal itu
terjadi pada 21 baris.

Pasangan berkode sama ternyata BUKAN baris kembar: isinya berbeda silo,
berbeda volume, berbeda jam - dua kejadian nyata yang kebetulan mendapat nomor
acak yang sama. Keduanya dimuat, dan yang kedua diberi akhiran (`-2`).

Yang PERTAMA mempertahankan kode aslinya, bukan sebaliknya: alokasi FIFO
menunjuk prepast lewat kodenya, dan mengubah kode yang sudah ditunjuk akan
memutus penelusuran supplier.

### Melanjutkan tanpa satu list: `--tanpa`

```bash
node src/migrasi/jalankan.js --sumber ../reference/export-sharepoint --tanpa stockOpname
```

List yang disebut boleh tidak ada berkasnya. Datanya TIDAK ikut pindah dan
tabelnya kosong setelah migrasi. Pilihan ini harus disebut satu per satu, tidak
tersedia sebagai mode longgar, dan tercatat di laporan pengecualian maupun di
V-2 (berstatus PERLU REVIEW, bukan LULUS) supaya yang menyetujui cutover
melihatnya.


### Menjalankan ulang setelah aplikasi hidup

Migrasi tetap idempoten untuk DATA, tetapi TIDAK lagi menyentuh wewenang
operator. Sebelum cutover, master SharePoint yang benar; sesudahnya, yang benar
adalah Master Data di aplikasi. Admin yang menaikkan wewenang seseorang lewat
aplikasi akan melihat wewenang itu turun sendiri hanya karena migrasi
dijalankan lagi - dan penurunan itu tidak menimbulkan galat apa pun.

Yang diperbarui saat dijalankan ulang hanya `nama_lengkap`. Selisih `role` dan
`is_active` dilaporkan sebagai "wewenang berbeda, TIDAK diubah". PIN tidak
pernah tersentuh setelah barisnya ada.

### Jejak audit migrasi

Tiap kali migrasi dijalankan, satu entri `audit_log` ditulis dengan
`entity = 'MIGRASI'`, `action = 'MIGRATE'`, dan `after_json` berisi folder
sumber, list yang dilewati, jumlah termuat per tabel, jumlah baris sumber, dan
rekap pengecualian per sebab.

Laporan pengecualian disimpan sebagai berkas, dan berkas dapat tertinggal saat
basis datanya dipulihkan ke tempat lain. Yang dituntut 21 CFR Part 11 §11.10(e)
adalah jejak yang melekat pada datanya sendiri.

## 5. Verifikasi V-1 s/d V-6

| Kode | Memeriksa | Bila gagal |
|---|---|---|
| V-1 | Volume tiap silo sama dengan Power Apps | Memblokir cutover |
| V-2 | Jumlah baris cocok dengan sumber, dikurangi pengecualian | Memblokir |
| V-3 | Tiap prepast punya induk penerimaan, kecuali anak pindah silo | Memblokir |
| V-4 | Jumlah alokasi FIFO = volume transfer | Memblokir |
| V-5 | Tidak ada sisa negatif atau melebihi volume asalnya | Memblokir |
| V-6 | Silo berisi tanpa jangkar standing time | Perlu ditinjau, tidak memblokir |

**V-1 tanpa `--acuan` dilaporkan `TIDAK DAPAT DIPERIKSA`, bukan lulus.**
Sistem baru tidak punya cara mengetahui angka sistem lama, dan melaporkannya
lulus tanpa pembanding adalah kebohongan yang paling mudah dilakukan di seluruh
pipeline ini.

**V-5 adalah lapis kedua.** Kekangan basis data `ck_pst_remaining` sudah
mencegah keadaan itu; V-5 menjaga bila kelak data dimuat lewat jalur yang
melewatinya.

**V-6 sengaja tidak memblokir.** Jangkar standing time tidak dapat direkonstruksi
dari data historis — ia menandai kapan susu masuk ke silo yang sedang kosong,
dan riwayat SharePoint tidak menyimpan peristiwa itu. Silo yang terdaftar di
V-6 perlu ditetapkan jangkarnya secara sadar saat go-live, bukan ditebak.

---

## 6. Urutan menuju cutover

Mengikuti Bagian 11.4 PRD.

1. **H-7** Dry run ke staging, tinjau laporan pengecualian, perbaiki data di
   SharePoint, ulangi sampai pengecualiannya hanya yang memang diterima.
2. **H-1** Pembekuan input. Selesaikan record GANTUNG dan pending approval bila
   memungkinkan. **Catat volume tiap silo dari layar Power Apps** ke
   `volume-acuan.json` — setelah ini angka pembandingnya tidak dapat diambil lagi.
3. **H** Migrasi final di luar jam operasional, verifikasi ulang dengan `--acuan`,
   go-live.
4. **H+7** Power Apps dijadikan read-only sebagai rujukan, tidak dihapus.
5. **H+30** Power Apps dipensiunkan.

---

## 7. Yang TIDAK dimigrasikan

| Data | Alasan |
|---|---|
| PIN operator | Tidak pernah disimpan sebagai plaintext. Seluruh operator mendapat PIN baru lewat halaman Master Data saat go-live (FR-26.2.5) |
| Jejak audit Power Apps | Tidak ada; aplikasi lama tidak mencatatnya |
| `standing_time_anchor` | Tidak dapat direkonstruksi; lihat V-6 |
| `FM_Batch_Traceability` | Menunggu keputusan Bagian 4.3 PRD |
